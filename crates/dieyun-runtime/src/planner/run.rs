use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use serde_json::{json, Value};

use dieyun_base::error::CoreError;

use super::best_of_n::BestOfNState;
use super::workers::{build_retry_jobs, build_worker_loop_start};
use super::trace::{phase_name, push_trace};
use super::plan_parse::{
    build_fallback_plan, parse_completed_outputs, parse_review_content,
    plan_to_json,
};
use super::prompts::build_planner_user_text;
use super::types::{
    Plan, PlannerContinueInput, PlannerStartParams, PlannerTraceEntry, ReviewResult,
    WorkerJobOut, WorkerResultInput,
};

pub(super) fn planner_max_tool_calls(params: &PlannerStartParams) -> u32 {
    params.max_tool_calls.filter(|&n| n > 0).unwrap_or(0)
}

/// worker / explore 子循环的轮次预算：**只认宿主传的值**。
///
/// 0 = 宿主没给（`PlannerStartParams.max_rounds` 缺省），Node 侧会把 0 当成「用
/// `agentMaxRounds`」—— 也就是说这个数字的唯一来源是 `model-settings`，Rust 不再自带字面量。
pub(super) fn planner_max_rounds(params: &PlannerStartParams) -> u32 {
    params.max_rounds.filter(|&n| n > 0).unwrap_or(0)
}

/// planner 的锁：**毒化也恢复**，不要把一次 panic 变成「planner 永久不可用」。
///
/// 为什么这条特别要紧：`AppState` 只在启动时建一次 planner（`rpc/mod.rs`），
/// `core.configure` 也只换 config / index / graph / memory —— 从不重建 planner。
/// 于是 `lock().unwrap()` 一 panic，之后**每一次** planner 调用都在这里再 panic，
/// 用户唯一的出路是重启 core。`sqlite.rs` 早就改成了同一口径（`unwrap_or_else` + 理由），
/// planner 这里一直没跟上。
pub(super) fn lock_runs(
    runs: &Mutex<HashMap<String, PlannerRunState>>,
) -> std::sync::MutexGuard<'_, HashMap<String, PlannerRunState>> {
    runs.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum InternalPhase {
    NeedPlanLlm,
    NeedExploreLoop,
    NeedWorkers,
    NeedBestOfNAttempt,
    NeedBestOfNPickLlm,
    NeedReviewLlm,
    NeedRetryWorkers,
    NeedSynthesizeLlm,
    Done,
    Cancelled,
}

#[derive(Debug, Clone)]
pub(super) struct PlannerRunState {
    pub(super) run_id: String,
    pub(super) params: PlannerStartParams,
    pub(super) phase: InternalPhase,
    pub(super) user_prompt: String,
    pub(super) plan_repair_attempt: u32,
    pub(super) last_plan_raw: String,
    pub(super) plan: Option<Plan>,
    pub(super) explore_notes: String,
    pub(super) explore_skipped: bool,
    pub(super) results: Vec<WorkerResultInput>,
    pub(super) review: Option<ReviewResult>,
    pub(super) worker_retries: u32,
    pub(super) pending_worker_jobs: Vec<WorkerJobOut>,
    pub(super) standard_worker_jobs: Vec<WorkerJobOut>,
    pub(super) bn_worker_jobs: Vec<WorkerJobOut>,
    pub(super) best_of_n_state: Option<BestOfNState>,
    pub(super) is_retry_batch: bool,
    pub(super) trace: Vec<PlannerTraceEntry>,
    pub(super) final_content: Option<String>,
    pub(super) hit_round_limit: bool,
    /// 计划被宿主上限改写时的一句人话（`None` = 模型要什么给了什么）。
    /// 与 `hit_round_limit` 并列上报：两者都是「交给你的计划不是它原本的样子」。
    pub(super) plan_truncation: Option<String>,
    pub(super) cancelled: bool,
    pub(super) resume_completed_ids: HashSet<String>,
    /// 汇总轮空正文的重试次数（只允许再一次）：上游只回思考/空响应时，重问一次比交付占位诚实。
    pub(super) synth_retry: u32,
    /// 本批执行器各自的 worktree 变更（验收请求体的**唯一来源**，`trace.rs` 从这里取）。
    pub(super) worktree_ctx: Option<Value>,
}

#[derive(Default)]
pub struct PlannerRunManager {
    pub(super) runs: Mutex<HashMap<String, PlannerRunState>>,
    pub(super) next_id: AtomicU64,
}

impl PlannerRunManager {
    pub fn ping(&self) -> Value {
        json!({
            "ok": true,
            "engine": "rust",
            "orchestrator": "rust"
        })
    }

    pub fn start(&self, params: PlannerStartParams) -> Result<Value, CoreError> {
        let n = self.next_id.fetch_add(1, Ordering::Relaxed);
        let run_id = format!("pl-{n}-{}", now_ms());
        let user_prompt = build_planner_user_text(
            &params.user_text,
            params.has_images,
            &params.chat_history_block,
        );
        let mut resume_completed_ids = HashSet::new();
        let mut restored_results = Vec::new();
        let mut plan = None;
        // 计划被宿主上限改写时的一句人话（进 done payload 的 	runcated）。
        let mut plan_truncation: Option<String> = None;
        let mut plan_warnings: Vec<String> = Vec::new();
        let mut explore_skipped = false;
        let mut explore_notes = String::new();
        if let Some(cp) = &params.resume_checkpoint {
            if let Some(data) = cp.get("data").or_else(|| Some(cp)) {
                if let Some(p) = data.get("plan") {
                    // 检查点解析失败**必须报出来**：旧实现 `if let Ok(...)` 把它和「没有检查点」
                    // 混为一谈 —— 计划丢了、`completedOutputs` 也一起丢，于是把已经做完的子任务
                    // 从头再跑一遍（还重写一遍 worktree），界面上看不出任何异常。
                    let parsed = serde_json::from_value::<Plan>(p.clone()).map_err(|e| {
                        CoreError::rpc(
                            "INVALID_PARAMS",
                            format!(
                                "恢复检查点失败：plan 无法解析（{e}）。\
                                 不会静默重跑已完成的工作 —— 请丢弃该检查点后重新规划。"
                            ),
                        )
                    })?;
                    let finalized = finalize_plan(parsed, params.best_of_n);
                    plan_truncation = finalized.truncation;
                    plan_warnings = finalized.warnings;
                    plan = Some(finalized.plan);
                    explore_skipped = true;
                    let (ids, outputs) = parse_completed_outputs(
                        data.get("completedOutputs")
                            .or_else(|| data.get("completed_outputs")),
                    );
                    resume_completed_ids = ids;
                    restored_results = outputs;
                }
                if let Some(notes) = data
                    .get("exploreNotes")
                    .or_else(|| data.get("explore_notes"))
                    .and_then(|v| v.as_str())
                {
                    explore_notes = notes.to_string();
                }
            }
        }
        // 勘察排在拆解**之前**（有只读工具时）：计划必须基于事实 ——
        // 「这件事其实已经做完了」「这个前提不成立」只能从勘察里知道，先拆解就会派出
        // 无事可做的执行器（2026-11-19 实测：A1「恢复 stash」在前序轮次早已完成，仍被派出去跑 12 轮）。
        let explore_first = plan.is_none() && params.has_explore_tools;
        let phase = if plan.is_some() {
            InternalPhase::NeedWorkers
        } else if explore_first {
            InternalPhase::NeedExploreLoop
        } else {
            InternalPhase::NeedPlanLlm
        };
        let trace = vec![PlannerTraceEntry {
            round: 1,
            phase: if plan.is_some() {
                "从检查点恢复".into()
            } else if explore_first {
                "Explore · 只读勘察".into()
            } else {
                "规划师 · 任务拆解".into()
            },
            thought: if plan.is_some() {
                format!(
                    "跳过已完成规划，恢复 {} 个已完成子任务",
                    resume_completed_ids.len()
                )
            } else if explore_first {
                "先做只读勘察：确认现状与前提，再据此拆解子任务…".into()
            } else if params.has_images {
                "正在结合原图拆解子任务…".into()
            } else {
                "正在拆解子任务…".into()
            },
            tools: vec![],
        }];
        let mut run = PlannerRunState {
            run_id: run_id.clone(),
            params,
            phase,
            user_prompt,
            plan_repair_attempt: 0,
            last_plan_raw: String::new(),
            plan,
            explore_notes,
            explore_skipped,
            results: restored_results,
            review: None,
            worker_retries: 0,
            pending_worker_jobs: vec![],
            standard_worker_jobs: vec![],
            bn_worker_jobs: vec![],
            best_of_n_state: None,
            is_retry_batch: false,
            trace,
            final_content: None,
            hit_round_limit: false,
            plan_truncation: plan_truncation.clone(),
                cancelled: false,
            resume_completed_ids,
            synth_retry: 0,
            worktree_ctx: None,
        };
        // 归一改写了模型原意（执行器名认不出 → 折叠到 A）必须当场说出来：
        // 静默折叠会悄悄把多路计划变成单 worktree 串行，事后只能靠猜。
        for w in plan_warnings.drain(..) {
            push_trace(&mut run, "规划师 · 计划归一", w);
        }
        if run.phase == InternalPhase::NeedWorkers {
            if run.plan.is_some() {
                let plan_clone = run.plan.clone().unwrap();
                Self::update_plan_trace_on(&mut run, &plan_clone);
            }
            self.prepare_worker_jobs(&mut run, false)?;
        }
        lock_runs(&self.runs).insert(run_id.clone(), run);
        self.emit_phase(&run_id)
    }

    pub fn worker_loop_body(
        &self,
        run_id: &str,
        worker: &str,
        task_id: &str,
        subagent_id: &str,
        worktree_path: Option<&str>,
        role_messages: &str,
        prior_summary: &str,
    ) -> Result<Value, CoreError> {
        let runs = lock_runs(&self.runs);
        let run = runs
            .get(run_id)
            .ok_or_else(|| CoreError::rpc("NOT_FOUND", format!("planner run 不存在: {run_id}")))?;
        let job = if let Some(bn) = &run.best_of_n_state {
            &bn.job
        } else {
            run.pending_worker_jobs
                .iter()
                .find(|j| j.worker == worker)
                .ok_or_else(|| CoreError::rpc("NOT_FOUND", format!("worker {worker} 不在队列")))?
        };
        let task = job
            .tasks
            .iter()
            .find(|t| t.id == task_id)
            .ok_or_else(|| CoreError::rpc("NOT_FOUND", format!("task {task_id} 不存在")))?;
        Ok(build_worker_loop_start(
            run,
            job,
            task,
            subagent_id,
            worktree_path,
            role_messages,
            prior_summary,
        ))
    }

    pub fn continue_run(
        &self,
        run_id: &str,
        input: PlannerContinueInput,
    ) -> Result<Value, CoreError> {
        let mut runs = lock_runs(&self.runs);
        if !runs.contains_key(run_id) {
            return Err(CoreError::rpc(
                "NOT_FOUND",
                format!("planner run 不存在: {run_id}"),
            ));
        }
        // 已取消的 run 在**第一次被观察到**时摘掉（与 agent 侧 `take_if_cancelled` 同口径）：
        // 不摘就等于长驻进程里永远留着一份 worker 全文输出 + trace + plan。
        if runs.get(run_id).map(|r| r.cancelled).unwrap_or(false) {
            runs.remove(run_id);
            return Err(CoreError::rpc("CANCELLED", "planner run 已取消"));
        }
        let (out, finished) = {
            let run = runs
                .get_mut(run_id)
                .ok_or_else(|| CoreError::rpc("NOT_FOUND", format!("planner run 不存在: {run_id}")))?;
            let out = match input.step.as_str() {
                "plan_llm" => self.handle_plan_llm(run, input.content.unwrap_or_default()),
                "explore_loop" => self.handle_explore_loop(run, input),
                "worker_batch" => self.handle_worker_batch(run, input),
                "best_of_n_attempt" => self.handle_best_of_n_attempt(run, input),
                "best_of_n_pick_llm" => self.handle_best_of_n_pick_llm(
                    run,
                    input.content.unwrap_or_default(),
                    input.worktree_ctx,
                ),
                "review_llm" => self.handle_review_llm(run, input.content.unwrap_or_default()),
                "synthesize_llm" => self.handle_synthesize_llm(run, input.content.unwrap_or_default()),
                _ => Err(CoreError::rpc(
                    "INVALID_PARAMS",
                    format!("未知 step: {}", input.step),
                )),
            }?;
            (out, matches!(run.phase, InternalPhase::Done | InternalPhase::Cancelled))
        };
        // 收尾即摘句柄：`AppState` 只建一次 planner（本文件顶部注释），运行期没有任何回收点，
        // 一条 run 的 results（worker 全文输出）/ trace / plan 会一直驻留到 core 重启。
        if finished {
            runs.remove(run_id);
        }
        Ok(out)
    }

    pub fn state(&self, run_id: &str) -> Result<Value, CoreError> {
        let runs = lock_runs(&self.runs);
        let run = runs
            .get(run_id)
            .ok_or_else(|| CoreError::rpc("NOT_FOUND", format!("planner run 不存在: {run_id}")))?;
        Ok(json!({
            "runId": run.run_id,
            "phase": phase_name(run.phase),
            "cancelled": run.cancelled,
            // 「是不是撞了轮次预算」是这次 run 的事实，别让调用方靠 trace 文本猜。
            "hitRoundLimit": run.hit_round_limit,
            "trace": run.trace,
            "plan": run.plan.as_ref().map(plan_to_json),
            "results": serde_json::to_value(&run.results).unwrap_or(json!([])),
        }))
    }

    pub fn cancel(&self, run_id: &str) -> Result<Value, CoreError> {
        let mut runs = lock_runs(&self.runs);
        let run = runs
            .get_mut(run_id)
            .ok_or_else(|| CoreError::rpc("NOT_FOUND", format!("planner run 不存在: {run_id}")))?;
        run.cancelled = true;
        run.phase = InternalPhase::Cancelled;
        Ok(json!({ "ok": true, "runId": run_id }))
    }

    fn handle_plan_llm(
        &self,
        run: &mut PlannerRunState,
        content: String,
    ) -> Result<Value, CoreError> {
        if run.plan.is_some() && run.explore_skipped {
            return self.advance_after_plan(run);
        }
        run.last_plan_raw = content.clone();
        let (parsed, parse_notes) =
            super::plan_parse::try_parse_plan_from_content_notes(&content, &run.user_prompt);
        if parsed.is_none() && run.plan_repair_attempt < 2 {
            run.plan_repair_attempt += 1;
            run.phase = InternalPhase::NeedPlanLlm;
            return self.build_response(run);
        }
        // 归一改写了模型原意（执行器名认不出 → 折叠到 A）必须留痕，不能等到事后猜。
        for note in parse_notes.iter() {
            push_trace(run, "规划师 · 计划归一", note.clone());
        }
        let plan = parsed.unwrap_or_else(|| build_fallback_plan(&run.user_prompt));
        let finalized = finalize_plan(plan, run.params.best_of_n);
        run.plan_truncation = finalized.truncation.clone();
        for w in finalized.warnings.iter() {
            push_trace(run, "规划师 · 计划归一", w.clone());
        }
        run.plan = Some(finalized.plan);
        self.update_plan_trace(run);
        self.advance_after_plan(run)
    }

    fn advance_after_plan(&self, run: &mut PlannerRunState) -> Result<Value, CoreError> {
        // 只读勘察（如果有）已经跑在拆解**之前**，走到这里只剩调度：计划已经是基于事实的。
        run.explore_skipped = true;
        run.phase = InternalPhase::NeedWorkers;
        self.prepare_worker_jobs(run, false)?;
        self.build_response(run)
    }

    fn handle_explore_loop(
        &self,
        run: &mut PlannerRunState,
        input: PlannerContinueInput,
    ) -> Result<Value, CoreError> {
        if input.hit_round_limit {
            // explore 只是**只读勘察**：它被截断不等于整轮预算耗尽 —— 下面紧接着就调度执行器，
            // 计划仍然会被完整执行。所以这里**不**置 `run.hit_round_limit`：
            // 以前置了之后，worker 全成功、验收通过、汇总正文也生成的一轮，仍会被宿主当成
            // 「本段额度用尽、停车等继续」（2026-11-19 真事：完成的任务被报额度用完）。
            // 截断这一事实只进 trace（下面那段 thought 说明）。
            run.explore_notes = input
                .partial_content
                .or(input.content)
                .unwrap_or_else(|| "Explore reached the round limit before producing a final summary; continue with worker execution using the available plan.".into());
                if let Some(last) = run.trace.last_mut() {
                if last.phase.contains("Explore") {
                    last.thought = format!(
                        "{}\n\n（Explore 轮次已达上限，继续调度执行器。）",
                        run.explore_notes.chars().take(1000).collect::<String>()
                    );
                }
            }
            run.explore_skipped = true;
            run.phase = InternalPhase::NeedPlanLlm;
            push_trace(run, "规划师 · 任务拆解", "基于勘察结论拆解子任务…");
            return self.build_response(run);
        }
        run.explore_notes = input.content.unwrap_or_default();
        if let Some(last) = run.trace.last_mut() {
            if last.phase.contains("Explore") {
                last.thought = run.explore_notes.chars().take(1200).collect();
            }
        }
        // 勘察只是**输入**：拆解仍然由规划师做，区别是它这次能看到事实。
        run.explore_skipped = true;
        run.phase = InternalPhase::NeedPlanLlm;
        push_trace(run, "规划师 · 任务拆解", "基于勘察结论拆解子任务…");
        self.build_response(run)
    }

    pub(super) fn begin_best_of_n_or_review(
        &self,
        run: &mut PlannerRunState,
        worktree_ctx: Option<Value>,
    ) -> Result<Value, CoreError> {
        if let Some(job) = run.bn_worker_jobs.first().cloned() {
            run.bn_worker_jobs.remove(0);
            self.start_best_of_n_job(run, job)?;
            return self.build_response(run);
        }
        // 验收请求体**只有一个生产点**（`trace.rs` 的 NeedReviewLlm），它从这里取 worktree 变更。
        // 以前这里另拼一份、`trace.rs` 也拼一份（那份把 worktreeChanges 传成 `{}`）——
        // 两条路径谁赢取决于调用顺序，验收「声称改了却零 diff」的规则随时可能静默失效。
        run.worktree_ctx = worktree_ctx;
        run.phase = InternalPhase::NeedReviewLlm;
        push_trace(run, "规划师 · 验收", "正在验收执行结果…");
        self.build_response(run)
    }

    fn handle_review_llm(
        &self,
        run: &mut PlannerRunState,
        content: String,
    ) -> Result<Value, CoreError> {
        let review = parse_review_content(&content);
        if let Some(last) = run.trace.last_mut() {
            last.thought = if review.notes.is_empty() {
                if review.accepted {
                    "验收通过".into()
                } else {
                    "需重试".into()
                }
            } else {
                review.notes.clone()
            };
        }
        run.review = Some(review.clone());
        if review.accepted {
            run.phase = InternalPhase::NeedSynthesizeLlm;
            push_trace(run, "汇总", "验收通过，正在生成最终答复…");
            return self.build_response(run);
        }
        if review.retry.is_empty() {
            // 验收判「未通过」却没点名要重跑谁 —— **不许**当成通过静默过去：
            // 以前它与「通过」走同一条路，汇总提示词里也看不到验收结论，于是坏产出
            // 被总结成「已完成」（2026-11-19 实测）。现在事实进 trace，并由汇总提示词
            // 强制如实交代未通过项（`build_synthesize_llm_body` 的 review 段）。
            run.phase = InternalPhase::NeedSynthesizeLlm;
            push_trace(
                run,
                "汇总",
                "验收未通过且未点名重试项：按现有产出汇总（最终答复里须如实交代未完成部分）",
            );
            return self.build_response(run);
        }
        if run.worker_retries >= run.params.max_worker_retries.max(1) {
            run.phase = InternalPhase::NeedSynthesizeLlm;
            push_trace(run, "汇总", "重试次数已达上限，仍生成最终答复…");
            return self.build_response(run);
        }
        // 轮次/工具预算已经耗尽的这一轮**不许再派重试批**：`workers.rs` 撞上限时明确写着
        // 「不再派新活」，这里再起一整批（新 worktree + 新循环预算）与之自相矛盾，
        // 用户看到的就是「说预算用完，却又跑了一遍」。重试理由留在 trace 里，汇总说实话。
        if run.hit_round_limit {
            run.phase = InternalPhase::NeedSynthesizeLlm;
            push_trace(
                run,
                "汇总",
                format!(
                    "轮次预算已耗尽：{} 路未通过验收，不再重试，按现有产出汇总",
                    review.retry.len()
                ),
            );
            return self.build_response(run);
        }
        run.worker_retries += 1;
        run.is_retry_batch = true;
        let (retry_jobs, unmatched) = build_retry_jobs(run, &review);
        if !unmatched.is_empty() {
            // 不允许「评审说要重试、实际一条没派」静默过去：把对不上的条目写进 trace。
            push_trace(
                run,
                "重试 · 跳过",
                format!("评审点名的子任务与计划对不上，已忽略：{}", unmatched.join("、")),
            );
        }
        self.set_worker_queues(run, retry_jobs, true)?;
        if run.pending_worker_jobs.is_empty()
            && run.bn_worker_jobs.is_empty()
            && run.best_of_n_state.is_none()
        {
            run.phase = InternalPhase::NeedSynthesizeLlm;
            return self.build_response(run);
        }
        if run.phase == InternalPhase::NeedBestOfNAttempt {
            push_trace(
                run,
                format!(
                    "重试 · Best-of-{} · 执行器 {}",
                    run.best_of_n_state.as_ref().map(|b| b.total).unwrap_or(0),
                    run.best_of_n_state
                        .as_ref()
                        .map(|b| b.job.worker.as_str())
                        .unwrap_or("")
                ),
                run.best_of_n_state
                    .as_ref()
                    .and_then(|b| b.job.retry_reason.clone())
                    .unwrap_or_else(|| "重新执行".into()),
            );
            return self.build_response(run);
        }
        run.phase = InternalPhase::NeedRetryWorkers;
        let jobs: Vec<(String, String)> = run
            .pending_worker_jobs
            .iter()
            .chain(run.bn_worker_jobs.iter())
            .map(|j| {
                (
                    j.worker.clone(),
                    j.retry_reason.clone().unwrap_or_else(|| "重新执行".into()),
                )
            })
            .collect();
        for (worker, reason) in jobs {
            push_trace(run, format!("重试 · 执行器 {worker}"), reason);
        }
        self.build_response(run)
    }

    fn handle_synthesize_llm(
        &self,
        run: &mut PlannerRunState,
        content: String,
    ) -> Result<Value, CoreError> {
        let is_empty = content.trim().is_empty();
        if is_empty && run.synth_retry < 1 {
            // 汇总轮是**本轮唯一能把结果交给用户的地方**：空正文不能当「已完成」。
            // 上游只回思考/空响应时先重问一次（只一次：再空就不是措辞问题，是通道问题）。
            run.synth_retry += 1;
            push_trace(
                run,
                "汇总",
                "汇总正文为空（上游只回了思考或空响应），再要一次最终答复…",
            );
            run.phase = InternalPhase::NeedSynthesizeLlm;
            return self.build_response(run);
        }
        // 空正文 ⇒ `final_content` 留 None：让宿主按交付四态处理（思考回退/占位），
        // 而不是把空串当成「已完成」往下传（以前下游只好自己造 `(空响应)` 占位）。
        run.final_content = if is_empty {
            None
        } else {
            Some(content)
        };
        if let Some(last) = run.trace.last_mut() {
            last.thought = if is_empty {
                "汇总未成文：上游两轮都没给出正文".into()
            } else {
                "已完成".into()
            };
        }
        run.phase = InternalPhase::Done;
        self.build_response(run)
    }

}

/// 计划的最终形态 + **被宿主上限改写过的地方**（`None` 表示模型要什么给了什么）。
///
/// 为什么要单独返回一句：`best_of_n` 被压下去是**静默的能力缩水** —— 模型在计划里写了 3 路，
/// 宿主设置关掉就只跑 1 路。以前这件事只体现在返回的 plan 里（模型看不到、用户也看不到），
/// 于是「为什么这条任务没有交叉验证」永远查不出来。
struct FinalizedPlan {
    plan: Plan,
    truncation: Option<String>,
    /// 归一过程中**改掉了模型原意**的地方（目前是「执行器名认不出、已折叠到 A」）。
    /// 这些必须写进 trace：静默折叠会让多路计划变成单路串行，谁也看不出为什么变慢了。
    warnings: Vec<String>,
}

fn finalize_plan(mut plan: Plan, cfg_best_of_n: u32) -> FinalizedPlan {
    let mut warnings: Vec<String> = Vec::new();
    for st in &mut plan.subtasks {
        let raw_worker = st.worker.trim().to_string();
        let (worker, defaulted) = super::plan_parse::normalize_worker_id_checked(&st.worker);
        if defaulted {
            let note = format!(
                "子任务 {} 的执行器名「{}」无法识别，已归到执行器 {worker}（多路计划可能因此变成单路串行）",
                st.id, raw_worker
            );
            if !warnings.contains(&note) {
                warnings.push(note);
            }
        }
        st.worker = worker;
        st.agent_type = super::plan_parse::normalize_agent_type(&st.agent_type);
        if st.expected_output.is_empty() {
            st.expected_output = st.instruction.clone();
        }
        if st.title.is_empty() {
            st.title = st.instruction.chars().take(48).collect();
        }
    }
    // 子任务 id 必须唯一：账本按 id 收敛结果（`HashMap<id, result>`），重复 id 会让**已完成**的
    // 那条被补一条「worker 未返回结果」，验收永久判失败并重试；断点恢复也按 id 跳过
    // （一条完成会把同 id 的另一条一起跳过）。模型偶尔会给出重复 id，这里按出场顺序重编号。
    {
        let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
        let mut seq: std::collections::HashMap<String, u32> = std::collections::HashMap::new();
        for st in &mut plan.subtasks {
            if st.id.trim().is_empty() || seen.contains(&st.id) {
                let n = seq.entry(st.worker.clone()).or_insert(0);
                loop {
                    *n += 1;
                    let candidate = format!("{}{}", st.worker, n);
                    if !seen.contains(&candidate) {
                        st.id = candidate;
                        break;
                    }
                }
            }
            seen.insert(st.id.clone());
        }
    }
    // best-of-N 路数的唯一来源是宿主 `agent-limits.plannerBestOfN`，且它是**上限**：
    // 模型在计划里写多少都不能超过它，也写不出「关掉也照开」。旧实现用 `max(cfg, model)`，
    // 于是设置里关掉（cfg=0）时模型一句话就能开 3 路 —— 成本 ×3，且没有任何一层能拦。
    // Node 侧同口径见 `rust-planner-runner.js#clampPlanContentBestOfN`。
    let cap = cfg_best_of_n.min(3);
    let requested = plan.best_of_n;
    plan.best_of_n = plan.best_of_n.min(cap);
    if plan.best_of_n < 2 {
        plan.best_of_n = 0;
    }
    let truncation = if plan.best_of_n < requested {
        Some(format!(
            "计划要求 {requested} 路并行（best-of-N），宿主上限只允许 {} 路 —— 这条任务没有做过交叉验证。",
            plan.best_of_n
        ))
    } else {
        None
    };
    FinalizedPlan {
        plan,
        truncation,
        warnings,
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
#[path = "run_tests.rs"]
mod tests;



impl Default for PlannerContinueInput {
    fn default() -> Self {
        Self {
            step: String::new(),
            content: None,
            worker_results: vec![],
            hit_round_limit: false,
            partial_content: None,
                worktree_ctx: None,
        }
    }
}

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
    plan_to_json, try_parse_plan_from_content,
};
use super::prompts::{
    build_planner_user_text, build_review_llm_body,
};
use super::types::{
    Plan, PlannerContinueInput, PlannerStartParams, PlannerTraceEntry, ReviewResult,
    WorkerJobOut, WorkerResultInput,
};

pub(super) fn planner_max_tool_calls(params: &PlannerStartParams) -> u32 {
    params.max_tool_calls.filter(|&n| n > 0).unwrap_or(0)
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
        let phase = if plan.is_some() {
            InternalPhase::NeedWorkers
        } else {
            InternalPhase::NeedPlanLlm
        };
        let trace = vec![PlannerTraceEntry {
            round: 1,
            phase: if plan.is_some() {
                "从检查点恢复".into()
            } else {
                "规划师 · 任务拆解".into()
            },
            thought: if plan.is_some() {
                format!(
                    "跳过已完成规划，恢复 {} 个已完成子任务",
                    resume_completed_ids.len()
                )
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
        };
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
        let run = runs
            .get_mut(run_id)
            .ok_or_else(|| CoreError::rpc("NOT_FOUND", format!("planner run 不存在: {run_id}")))?;
        if run.cancelled {
            return Err(CoreError::rpc("CANCELLED", "planner run 已取消"));
        }
        match input.step.as_str() {
            "plan_llm" => self.handle_plan_llm(run, input.content.unwrap_or_default()),
            "explore_loop" => self.handle_explore_loop(run, input),
            "worker_batch" => self.handle_worker_batch(run, input),
            "best_of_n_attempt" => self.handle_best_of_n_attempt(run, input),
            "best_of_n_pick_llm" => {
                self.handle_best_of_n_pick_llm(run, input.content.unwrap_or_default())
            }
            "review_llm" => self.handle_review_llm(run, input.content.unwrap_or_default()),
            "synthesize_llm" => self.handle_synthesize_llm(run, input.content.unwrap_or_default()),
            _ => Err(CoreError::rpc(
                "INVALID_PARAMS",
                format!("未知 step: {}", input.step),
            )),
        }
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
        let plan = try_parse_plan_from_content(&content, &run.user_prompt);
        if plan.is_none() && run.plan_repair_attempt < 2 {
            run.plan_repair_attempt += 1;
            run.phase = InternalPhase::NeedPlanLlm;
            return self.build_response(run);
        }
        let plan = plan.unwrap_or_else(|| build_fallback_plan(&run.user_prompt));
        let finalized = finalize_plan(plan, run.params.best_of_n);
        run.plan_truncation = finalized.truncation.clone();
        run.plan = Some(finalized.plan);
        self.update_plan_trace(run);
        self.advance_after_plan(run)
    }

    fn advance_after_plan(&self, run: &mut PlannerRunState) -> Result<Value, CoreError> {
        if run.explore_skipped {
            run.phase = InternalPhase::NeedWorkers;
            self.prepare_worker_jobs(run, false)?;
            return self.build_response(run);
        }
        if run.params.has_explore_tools {
            run.phase = InternalPhase::NeedExploreLoop;
            push_trace(run, "Explore · 只读勘察", "扫描代码库（只读子 Agent）…");
        } else {
            run.explore_skipped = true;
            run.phase = InternalPhase::NeedWorkers;
            self.prepare_worker_jobs(run, false)?;
        }
        self.build_response(run)
    }

    fn handle_explore_loop(
        &self,
        run: &mut PlannerRunState,
        input: PlannerContinueInput,
    ) -> Result<Value, CoreError> {
        if input.hit_round_limit {
            run.hit_round_limit = true;
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
            run.phase = InternalPhase::NeedWorkers;
            self.prepare_worker_jobs(run, false)?;
            return self.build_response(run);
        }
        run.explore_notes = input.content.unwrap_or_default();
        if let Some(last) = run.trace.last_mut() {
            if last.phase.contains("Explore") {
                last.thought = run.explore_notes.chars().take(1200).collect();
            }
        }
        run.phase = InternalPhase::NeedWorkers;
        self.prepare_worker_jobs(run, false)?;
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
        run.phase = InternalPhase::NeedReviewLlm;
        push_trace(run, "规划师 · 验收", "正在验收执行结果…");
        let mut resp = self.build_response(run)?;
        if let Some(obj) = resp.as_object_mut() {
            if let Some(wt) = worktree_ctx {
                if let Some(plan) = &run.plan {
                    let results_json: Vec<Value> = run
                        .results
                        .iter()
                        .map(|r| {
                            json!({
                                "id": r.id,
                                "worker": r.worker,
                                "ok": r.error.is_none(),
                                "output": r.output.as_deref().or(r.error.as_deref()).unwrap_or("").chars().take(4000).collect::<String>()
                            })
                        })
                        .collect();
                    obj.insert(
                        "llmBody".into(),
                        build_review_llm_body(
                            &run.params.model,
                            &run.params.sys_content,
                            plan,
                            &results_json,
                            &wt,
                        ),
                    );
                }
            }
        }
        Ok(resp)
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
        if review.accepted || review.retry.is_empty() {
            run.phase = InternalPhase::NeedSynthesizeLlm;
            push_trace(run, "汇总", "正在生成最终答复…");
            return self.build_response(run);
        }
        if run.worker_retries >= run.params.max_worker_retries.max(1) {
            run.phase = InternalPhase::NeedSynthesizeLlm;
            push_trace(run, "汇总", "重试次数已达上限，仍生成最终答复…");
            return self.build_response(run);
        }
        run.worker_retries += 1;
        run.is_retry_batch = true;
        let retry_jobs = build_retry_jobs(run, &review);
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
        run.final_content = Some(content);
        if let Some(last) = run.trace.last_mut() {
            last.thought = "已完成".into();
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
}

fn finalize_plan(mut plan: Plan, cfg_best_of_n: u32) -> FinalizedPlan {
    for st in &mut plan.subtasks {
        st.worker = super::plan_parse::normalize_worker_id(&st.worker);
        st.agent_type = super::plan_parse::normalize_agent_type(&st.agent_type);
        if st.expected_output.is_empty() {
            st.expected_output = st.instruction.clone();
        }
        if st.title.is_empty() {
            st.title = st.instruction.chars().take(48).collect();
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
    FinalizedPlan { plan, truncation }
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

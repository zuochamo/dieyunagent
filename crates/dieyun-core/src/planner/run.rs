use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use serde_json::{json, Value};

use crate::error::CoreError;

use super::plan_parse::{
    build_fallback_plan, collect_workers_from_plan, parse_completed_outputs, parse_review_content,
    plan_to_json, try_parse_plan_from_content, worker_job_needs_best_of_n,
};
use super::prompts::{
    build_best_of_n_pick_llm_body, build_explore_loop_messages, build_plan_llm_body,
    build_planner_user_text, build_review_llm_body, build_synthesize_llm_body,
    build_worker_task_system, format_trace_digest, parse_best_of_n_winner,
};
use super::types::{
    Plan, PlannerContinueInput, PlannerStartParams, PlannerTraceEntry, ReviewResult, Subtask,
    WorkerJobOut, WorkerResultInput,
};

fn planner_max_tool_calls(params: &PlannerStartParams) -> u32 {
    params.max_tool_calls.filter(|&n| n > 0).unwrap_or(0)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum InternalPhase {
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
struct BestOfNAttemptRecord {
    attempt_index: u32,
    results: Vec<WorkerResultInput>,
    summary: String,
}

#[derive(Debug, Clone)]
struct BestOfNState {
    job: WorkerJobOut,
    total: u32,
    attempt_index: u32,
    collected: Vec<BestOfNAttemptRecord>,
}

struct PlannerRunState {
    run_id: String,
    params: PlannerStartParams,
    phase: InternalPhase,
    user_prompt: String,
    plan_repair_attempt: u32,
    last_plan_raw: String,
    plan: Option<Plan>,
    explore_notes: String,
    explore_skipped: bool,
    results: Vec<WorkerResultInput>,
    review: Option<ReviewResult>,
    worker_retries: u32,
    pending_worker_jobs: Vec<WorkerJobOut>,
    standard_worker_jobs: Vec<WorkerJobOut>,
    bn_worker_jobs: Vec<WorkerJobOut>,
    best_of_n_state: Option<BestOfNState>,
    is_retry_batch: bool,
    trace: Vec<PlannerTraceEntry>,
    final_content: Option<String>,
    hit_round_limit: bool,
    partial_body: Option<Value>,
    cancelled: bool,
    resume_completed_ids: HashSet<String>,
}

#[derive(Default)]
pub struct PlannerRunManager {
    runs: Mutex<HashMap<String, PlannerRunState>>,
    next_id: AtomicU64,
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
        let mut explore_skipped = false;
        let mut explore_notes = String::new();
        if let Some(cp) = &params.resume_checkpoint {
            if let Some(data) = cp.get("data").or_else(|| Some(cp)) {
                if let Some(p) = data.get("plan") {
                    if let Ok(parsed) = serde_json::from_value::<Plan>(p.clone()) {
                        plan = Some(finalize_plan(parsed, params.best_of_n));
                        explore_skipped = true;
                        let (ids, outputs) = parse_completed_outputs(
                            data.get("completedOutputs")
                                .or_else(|| data.get("completed_outputs")),
                        );
                        resume_completed_ids = ids;
                        restored_results = outputs;
                    }
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
            partial_body: None,
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
        self.runs.lock().unwrap().insert(run_id.clone(), run);
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
        let runs = self.runs.lock().unwrap();
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
        let mut runs = self.runs.lock().unwrap();
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
            "arbitration" => self.handle_arbitration(
                run,
                input.arbitration_action.unwrap_or_else(|| "fail".into()),
            ),
            _ => Err(CoreError::rpc(
                "INVALID_PARAMS",
                format!("未知 step: {}", input.step),
            )),
        }
    }

    pub fn state(&self, run_id: &str) -> Result<Value, CoreError> {
        let runs = self.runs.lock().unwrap();
        let run = runs
            .get(run_id)
            .ok_or_else(|| CoreError::rpc("NOT_FOUND", format!("planner run 不存在: {run_id}")))?;
        Ok(json!({
            "runId": run.run_id,
            "phase": phase_name(run.phase),
            "cancelled": run.cancelled,
            "trace": run.trace,
            "plan": run.plan.as_ref().map(plan_to_json),
            "results": serde_json::to_value(&run.results).unwrap_or(json!([])),
        }))
    }

    pub fn cancel(&self, run_id: &str) -> Result<Value, CoreError> {
        let mut runs = self.runs.lock().unwrap();
        let run = runs
            .get_mut(run_id)
            .ok_or_else(|| CoreError::rpc("NOT_FOUND", format!("planner run 不存在: {run_id}")))?;
        run.cancelled = true;
        run.phase = InternalPhase::Cancelled;
        Ok(json!({ "ok": true, "runId": run_id }))
    }

    fn emit_phase(&self, run_id: &str) -> Result<Value, CoreError> {
        let runs = self.runs.lock().unwrap();
        let run = runs
            .get(run_id)
            .ok_or_else(|| CoreError::rpc("NOT_FOUND", format!("planner run 不存在: {run_id}")))?;
        self.build_response(run)
    }

    fn build_response(&self, run: &PlannerRunState) -> Result<Value, CoreError> {
        let phase = phase_name(run.phase);
        let mut out = json!({
            "phase": phase,
            "runId": run.run_id,
            "trace": run.trace,
        });
        if let Some(obj) = out.as_object_mut() {
            if let Some(plan) = &run.plan {
                obj.insert("plan".into(), plan_to_json(plan));
            }
            match run.phase {
                InternalPhase::NeedPlanLlm => {
                    obj.insert(
                        "llmBody".into(),
                        build_plan_llm_body(
                            &run.params.model,
                            &run.params.sys_content,
                            &run.user_prompt,
                            run.plan_repair_attempt,
                            &run.last_plan_raw,
                        ),
                    );
                    obj.insert("repairAttempt".into(), json!(run.plan_repair_attempt));
                }
                InternalPhase::NeedExploreLoop => {
                    if run.explore_skipped || !run.params.has_explore_tools {
                        // Should not happen if logic correct; Node may skip calling loop
                        obj.insert("skipExplore".into(), json!(true));
                    } else if let Some(plan) = &run.plan {
                        let (system, user) = build_explore_loop_messages(
                            &run.params.sys_content,
                            plan,
                            &run.params.user_text,
                            &run.params.chat_history_block,
                        );
                        obj.insert(
                            "loopStart".into(),
                            json!({
                                "model": run.params.model,
                                "messages": [
                                    { "role": "system", "content": system },
                                    { "role": "user", "content": user }
                                ],
                                "temperature": 0.2,
                                "maxRounds": 24,
                                "maxToolCalls": planner_max_tool_calls(&run.params),
                                "agentType": "explore"
                            }),
                        );
                        obj.insert("tracePhase".into(), json!("Explore · 只读勘察"));
                    }
                }
                InternalPhase::NeedWorkers | InternalPhase::NeedRetryWorkers => {
                    obj.insert(
                        "workerJobs".into(),
                        serde_json::to_value(&run.pending_worker_jobs).unwrap_or(json!([])),
                    );
                    obj.insert("isRetry".into(), json!(run.is_retry_batch));
                }
                InternalPhase::NeedBestOfNAttempt => {
                    if let Some(bn) = &run.best_of_n_state {
                        obj.insert(
                            "workerJob".into(),
                            serde_json::to_value(&bn.job).unwrap_or(json!({})),
                        );
                        obj.insert("attemptIndex".into(), json!(bn.attempt_index));
                        obj.insert("totalAttempts".into(), json!(bn.total));
                        obj.insert(
                            "worktreeRole".into(),
                            json!(format!("{}-bn{}", bn.job.worker, bn.attempt_index)),
                        );
                        obj.insert("isRetry".into(), json!(bn.job.is_retry));
                    }
                    obj.insert(
                        "tracePhase".into(),
                        json!(format!(
                            "Best-of-{} · 执行器 {}",
                            run.best_of_n_state.as_ref().map(|b| b.total).unwrap_or(0),
                            run.best_of_n_state
                                .as_ref()
                                .map(|b| b.job.worker.as_str())
                                .unwrap_or("")
                        )),
                    );
                }
                InternalPhase::NeedBestOfNPickLlm => {
                    if let (Some(bn), Some(plan)) = (&run.best_of_n_state, &run.plan) {
                        let attempts: Vec<(u32, String)> = bn
                            .collected
                            .iter()
                            .map(|a| (a.attempt_index, a.summary.clone()))
                            .collect();
                        obj.insert(
                            "llmBody".into(),
                            build_best_of_n_pick_llm_body(
                                &run.params.model,
                                &plan.plan_summary,
                                &attempts,
                            ),
                        );
                        obj.insert(
                            "tracePhase".into(),
                            json!(format!(
                                "Best-of-{} · 选优 · 执行器 {}",
                                bn.total, bn.job.worker
                            )),
                        );
                    }
                }
                InternalPhase::NeedReviewLlm => {
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
                                &json!({}),
                            ),
                        );
                    }
                    obj.insert("tracePhase".into(), json!("规划师 · 验收"));
                }
                InternalPhase::NeedSynthesizeLlm => {
                    if let Some(plan) = &run.plan {
                        let results_json: Vec<Value> = run
                            .results
                            .iter()
                            .map(|r| {
                                json!({
                                    "id": r.id,
                                    "worker": r.worker,
                                    "output": r.output,
                                    "error": r.error
                                })
                            })
                            .collect();
                        let digest = format_trace_digest(&run.trace);
                        obj.insert(
                            "llmBody".into(),
                            build_synthesize_llm_body(
                                run.params
                                    .vision_model
                                    .as_deref()
                                    .unwrap_or(&run.params.model),
                                &run.params.sys_content,
                                plan,
                                &results_json,
                                &run.params.user_text,
                                &run.params.chat_history_block,
                                &digest,
                                run.params.temperature,
                                run.params.max_output_tokens,
                            ),
                        );
                    }
                    obj.insert("tracePhase".into(), json!("汇总"));
                }
                InternalPhase::Done => {
                    obj.insert("content".into(), json!(run.final_content));
                    obj.insert("hitRoundLimit".into(), json!(run.hit_round_limit));
                    obj.insert(
                        "results".into(),
                        serde_json::to_value(&run.results).unwrap(),
                    );
                    if let Some(review) = &run.review {
                        obj.insert(
                            "review".into(),
                            json!({
                                "accepted": review.accepted,
                                "retry": review.retry,
                                "notes": review.notes
                            }),
                        );
                    }
                    obj.insert("deferWorktreeCleanup".into(), json!(true));
                }
                InternalPhase::Cancelled => {}
            }
        }
        Ok(out)
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
        let mut plan = plan.unwrap_or_else(|| build_fallback_plan(&run.user_prompt));
        plan = finalize_plan(plan, run.params.best_of_n);
        run.plan = Some(plan);
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
            run.partial_body = input.partial_body;
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

    fn handle_worker_batch(
        &self,
        run: &mut PlannerRunState,
        input: PlannerContinueInput,
    ) -> Result<Value, CoreError> {
        if input.hit_round_limit {
            run.hit_round_limit = true;
            run.final_content = input.partial_content;
            run.partial_body = input.partial_body;
            run.phase = InternalPhase::Done;
            return self.build_response(run);
        }
        if run.is_retry_batch {
            let retry_ids: HashSet<String> = run
                .pending_worker_jobs
                .iter()
                .flat_map(|j| j.tasks.iter().map(|t| t.id.clone()))
                .collect();
            run.results.retain(|r| !retry_ids.contains(&r.id));
        }
        run.results.extend(input.worker_results);
        run.pending_worker_jobs.clear();
        run.standard_worker_jobs.clear();
        self.begin_best_of_n_or_review(run, input.worktree_ctx)
    }

    fn handle_best_of_n_attempt(
        &self,
        run: &mut PlannerRunState,
        input: PlannerContinueInput,
    ) -> Result<Value, CoreError> {
        if input.hit_round_limit {
            run.hit_round_limit = true;
            run.final_content = input.partial_content;
            run.partial_body = input.partial_body;
            run.phase = InternalPhase::Done;
            return self.build_response(run);
        }
        let trace_note = {
            let Some(bn) = run.best_of_n_state.as_mut() else {
                return Err(CoreError::rpc("INVALID_STATE", "best_of_n 状态缺失"));
            };
            let summary = summarize_worker_results(&input.worker_results);
            bn.collected.push(BestOfNAttemptRecord {
                attempt_index: bn.attempt_index,
                results: input.worker_results,
                summary,
            });
            if bn.attempt_index < bn.total {
                bn.attempt_index += 1;
                run.phase = InternalPhase::NeedBestOfNAttempt;
                Some((
                    format!("Best-of-{} · 执行器 {}", bn.total, bn.job.worker),
                    format!("方案 {}/{}", bn.attempt_index, bn.total),
                ))
            } else {
                run.phase = InternalPhase::NeedBestOfNPickLlm;
                Some((
                    format!("Best-of-{} · 选优 · 执行器 {}", bn.total, bn.job.worker),
                    "正在评审各方案…".to_string(),
                ))
            }
        };
        if let Some((phase, thought)) = trace_note {
            push_trace(run, phase, thought);
        }
        self.build_response(run)
    }

    fn handle_best_of_n_pick_llm(
        &self,
        run: &mut PlannerRunState,
        content: String,
    ) -> Result<Value, CoreError> {
        let Some(bn) = run.best_of_n_state.take() else {
            return Err(CoreError::rpc("INVALID_STATE", "best_of_n 状态缺失"));
        };
        let winner_idx = parse_best_of_n_winner(&content, bn.collected.len());
        let winner = bn
            .collected
            .get(winner_idx)
            .or_else(|| bn.collected.first())
            .ok_or_else(|| CoreError::rpc("INVALID_STATE", "best_of_n 无有效方案"))?;
        if run.is_retry_batch {
            let retry_ids: HashSet<String> = bn.job.tasks.iter().map(|t| t.id.clone()).collect();
            run.results.retain(|r| !retry_ids.contains(&r.id));
        }
        run.results.extend(winner.results.clone());
        if let Some(last) = run.trace.last_mut() {
            last.thought = format!("已选方案 {} / {}", winner.attempt_index, bn.total);
        }
        run.pending_worker_jobs.clear();
        self.begin_best_of_n_or_review(run, None)
    }

    fn begin_best_of_n_or_review(
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

    fn start_best_of_n_job(
        &self,
        run: &mut PlannerRunState,
        job: WorkerJobOut,
    ) -> Result<(), CoreError> {
        let total = job.best_of_n_total.max(2).min(3);
        let worker = job.worker.clone();
        run.pending_worker_jobs = vec![job.clone()];
        run.best_of_n_state = Some(BestOfNState {
            job,
            total,
            attempt_index: 1,
            collected: vec![],
        });
        run.phase = InternalPhase::NeedBestOfNAttempt;
        push_trace(
            run,
            format!("Best-of-{total} · 执行器 {worker}"),
            format!("方案 1/{total}"),
        );
        Ok(())
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

    fn handle_arbitration(
        &self,
        run: &mut PlannerRunState,
        action: String,
    ) -> Result<Value, CoreError> {
        if action == "retry" {
            run.phase = InternalPhase::NeedRetryWorkers;
            self.build_response(run)
        } else {
            run.phase = InternalPhase::NeedSynthesizeLlm;
            push_trace(run, "汇总", "仲裁后生成最终答复…");
            self.build_response(run)
        }
    }

    fn prepare_worker_jobs(
        &self,
        run: &mut PlannerRunState,
        is_retry: bool,
    ) -> Result<(), CoreError> {
        let plan = run
            .plan
            .as_ref()
            .ok_or_else(|| CoreError::rpc("INVALID_STATE", "plan 缺失"))?
            .clone();
        let subtasks: Vec<Subtask> = plan
            .subtasks
            .iter()
            .filter(|st| !run.resume_completed_ids.contains(&st.id))
            .cloned()
            .collect();
        if subtasks.is_empty() && !run.resume_completed_ids.is_empty() {
            run.phase = InternalPhase::NeedReviewLlm;
            push_trace(run, "规划师 · 跳过 Worker", "所有子任务已在检查点中完成");
            return Ok(());
        }
        let workers = collect_workers_from_plan(&subtasks);
        if !workers.is_empty() {
            let bn_note = if plan.best_of_n > 1 {
                format!(" · Best-of-{}（build 子任务）", plan.best_of_n)
            } else {
                String::new()
            };
            let note = if workers.len() > 1 {
                format!(
                    "调度 · {} 路并行子 Agent（worktree）{bn_note}",
                    workers.len()
                )
            } else {
                format!("调度 · 子 Agent（worktree）{bn_note}")
            };
            push_trace(
                run,
                note,
                workers
                    .iter()
                    .map(|w| format!("执行器 {w}"))
                    .collect::<Vec<_>>()
                    .join(" · "),
            );
        }
        let all_jobs: Vec<WorkerJobOut> = workers
            .into_iter()
            .map(|worker| {
                let tasks: Vec<Subtask> = subtasks
                    .iter()
                    .filter(|t| t.worker == worker)
                    .cloned()
                    .collect();
                let mut job = WorkerJobOut {
                    worker: worker.clone(),
                    tasks,
                    is_retry,
                    retry_reason: None,
                    use_best_of_n: false,
                    best_of_n_total: 0,
                };
                if worker_job_needs_best_of_n(&plan, &job) {
                    job.use_best_of_n = true;
                    job.best_of_n_total = plan.best_of_n;
                }
                job
            })
            .filter(|j| !j.tasks.is_empty())
            .collect();
        self.set_worker_queues(run, all_jobs, is_retry)
    }

    fn set_worker_queues(
        &self,
        run: &mut PlannerRunState,
        all_jobs: Vec<WorkerJobOut>,
        is_retry: bool,
    ) -> Result<(), CoreError> {
        run.standard_worker_jobs = all_jobs
            .iter()
            .filter(|j| !j.use_best_of_n)
            .cloned()
            .collect();
        run.bn_worker_jobs = all_jobs
            .iter()
            .filter(|j| j.use_best_of_n)
            .cloned()
            .collect();
        run.pending_worker_jobs = run.standard_worker_jobs.clone();
        run.best_of_n_state = None;
        run.is_retry_batch = is_retry;
        if run.pending_worker_jobs.is_empty() && !run.bn_worker_jobs.is_empty() {
            let job = run.bn_worker_jobs.remove(0);
            self.start_best_of_n_job(run, job)?;
        }
        Ok(())
    }

    fn update_plan_trace(&self, run: &mut PlannerRunState) {
        if let Some(plan) = run.plan.clone() {
            Self::update_plan_trace_on(run, &plan);
        }
    }

    fn update_plan_trace_on(run: &mut PlannerRunState, plan: &Plan) {
        let plan_lines = plan
            .subtasks
            .iter()
            .map(|s| format!("· [{}] {} {}", s.worker, s.id, s.title))
            .collect::<Vec<_>>()
            .join("\n");
        let todo_lines = if plan.todos.is_empty() {
            String::new()
        } else {
            format!(
                "TODO\n{}\n\n",
                plan.todos
                    .iter()
                    .enumerate()
                    .map(|(i, t)| format!("[ ] {}. {t}", i + 1))
                    .collect::<Vec<_>>()
                    .join("\n")
            )
        };
        let fallback_note = if plan.fallback {
            "\n\n（规划 JSON 解析失败，已降级为单任务执行）"
        } else {
            ""
        };
        if let Some(last) = run.trace.first_mut() {
            last.thought = format!(
                "{}{plan_lines}{fallback_note}",
                format!("{}\n\n{todo_lines}", plan.plan_summary)
            );
        }
    }
}

fn build_worker_loop_start(
    run: &PlannerRunState,
    job: &WorkerJobOut,
    task: &Subtask,
    subagent_id: &str,
    worktree_path: Option<&str>,
    role_messages: &str,
    prior_summary: &str,
) -> Value {
    let plan_summary = run
        .plan
        .as_ref()
        .map(|p| p.plan_summary.as_str())
        .unwrap_or("");
    let system = build_worker_task_system(
        &run.params.sys_content,
        &job.worker,
        task,
        plan_summary,
        subagent_id,
        worktree_path,
        role_messages,
        prior_summary,
        &run.explore_notes,
    );
    let user = format!(
        "【用户原始需求】\n{}\n\n请完成当前子任务（详见系统提示）。",
        run.params.user_text
    );
    json!({
        "model": run.params.model,
        "messages": [
            { "role": "system", "content": system },
            { "role": "user", "content": user }
        ],
        "temperature": run.params.temperature,
        "maxRounds": 96,
        "maxToolCalls": planner_max_tool_calls(&run.params),
        "agentType": task.agent_type,
        "worker": job.worker,
        "subtaskId": task.id,
        "subagentId": subagent_id,
    })
}

fn build_retry_jobs(run: &PlannerRunState, review: &ReviewResult) -> Vec<WorkerJobOut> {
    let plan = match &run.plan {
        Some(p) => p,
        None => return vec![],
    };
    let mut jobs = Vec::new();
    for item in &review.retry {
        let worker = item.get("worker").and_then(|v| v.as_str()).unwrap_or("A");
        let reason = item
            .get("reason")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        let ids: HashSet<String> = item
            .get("subtaskIds")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|x| x.as_str().map(String::from))
                    .collect()
            })
            .unwrap_or_default();
        let tasks: Vec<Subtask> = plan
            .subtasks
            .iter()
            .filter(|t| t.worker == worker && (ids.is_empty() || ids.contains(&t.id)))
            .cloned()
            .collect();
        if tasks.is_empty() {
            continue;
        }
        let mut job = WorkerJobOut {
            worker: worker.to_string(),
            tasks,
            is_retry: true,
            retry_reason: reason,
            use_best_of_n: false,
            best_of_n_total: 0,
        };
        if worker_job_needs_best_of_n(plan, &job) {
            job.use_best_of_n = true;
            job.best_of_n_total = plan.best_of_n;
        }
        jobs.push(job);
    }
    jobs
}

fn summarize_worker_results(results: &[WorkerResultInput]) -> String {
    results
        .iter()
        .map(|r| {
            format!(
                "[{}] {}",
                r.id,
                r.output.as_deref().or(r.error.as_deref()).unwrap_or("(无)")
            )
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn finalize_plan(mut plan: Plan, cfg_best_of_n: u32) -> Plan {
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
    plan.best_of_n = plan.best_of_n.max(cfg_best_of_n.min(3)).min(3);
    if plan.best_of_n <= 1 {
        plan.best_of_n = 0;
    }
    plan
}

fn push_trace(run: &mut PlannerRunState, phase: impl Into<String>, thought: impl Into<String>) {
    run.trace.push(PlannerTraceEntry {
        round: run.trace.len() as u32 + 1,
        phase: phase.into(),
        thought: thought.into(),
        tools: vec![],
    });
}

fn phase_name(p: InternalPhase) -> &'static str {
    match p {
        InternalPhase::NeedPlanLlm => "need_plan_llm",
        InternalPhase::NeedExploreLoop => "need_explore_loop",
        InternalPhase::NeedWorkers => "need_workers",
        InternalPhase::NeedBestOfNAttempt => "need_best_of_n_attempt",
        InternalPhase::NeedBestOfNPickLlm => "need_best_of_n_pick_llm",
        InternalPhase::NeedReviewLlm => "need_review_llm",
        InternalPhase::NeedRetryWorkers => "need_retry_workers",
        InternalPhase::NeedSynthesizeLlm => "need_synthesize_llm",
        InternalPhase::Done => "done",
        InternalPhase::Cancelled => "cancelled",
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_params() -> PlannerStartParams {
        PlannerStartParams {
            model: "test-model".into(),
            sys_content: "sys".into(),
            user_text: "fix the bug".into(),
            chat_history_block: String::new(),
            has_images: false,
            has_explore_tools: false,
            max_worker_retries: 1,
            best_of_n: 0,
            max_output_tokens: 8192,
            temperature: 0.7,
            resume_checkpoint: None,
            vision_model: None,
            max_tool_calls: None,
        }
    }

    #[test]
    fn start_needs_plan_llm() {
        let mgr = PlannerRunManager::default();
        let r = mgr.start(sample_params()).unwrap();
        assert_eq!(r["phase"], "need_plan_llm");
        assert!(r.get("llmBody").is_some());
    }

    #[test]
    fn plan_to_workers_flow() {
        let mgr = PlannerRunManager::default();
        let start = mgr.start(sample_params()).unwrap();
        let run_id = start["runId"].as_str().unwrap();
        let plan_json = r#"{"planSummary":"s","subtasks":[{"id":"A1","worker":"A","title":"t","instruction":"do","expectedOutput":"done"}]}"#;
        let r = mgr
            .continue_run(
                run_id,
                PlannerContinueInput {
                    step: "plan_llm".into(),
                    content: Some(plan_json.into()),
                    ..Default::default()
                },
            )
            .unwrap();
        assert_eq!(r["phase"], "need_workers");
        assert!(r.get("workerJobs").is_some());
    }

    #[test]
    fn two_workers_split_into_parallel_jobs() {
        let mgr = PlannerRunManager::default();
        let start = mgr.start(sample_params()).unwrap();
        let run_id = start["runId"].as_str().unwrap();
        let plan_json = r#"{"planSummary":"s","subtasks":[{"id":"A1","worker":"A","title":"t1","instruction":"do1","expectedOutput":"done1"},{"id":"B1","worker":"B","title":"t2","instruction":"do2","expectedOutput":"done2"}]}"#;
        let r = mgr
            .continue_run(
                run_id,
                PlannerContinueInput {
                    step: "plan_llm".into(),
                    content: Some(plan_json.into()),
                    ..Default::default()
                },
            )
            .unwrap();
        assert_eq!(r["phase"], "need_workers");
        let jobs = r["workerJobs"].as_array().unwrap();
        assert_eq!(jobs.len(), 2);
        let mut workers: Vec<&str> = jobs
            .iter()
            .map(|j| j["worker"].as_str().unwrap())
            .collect();
        workers.sort();
        assert_eq!(workers, vec!["A", "B"]);
    }

    #[test]
    fn finalize_plan_clamps_best_of_n_to_three() {
        let plan = Plan {
            plan_summary: "s".into(),
            todos: vec![],
            subtasks: vec![Subtask {
                id: "A1".into(),
                worker: "A".into(),
                title: "t".into(),
                instruction: "do".into(),
                expected_output: String::new(),
                agent_type: "build".into(),
            }],
            best_of_n: 99,
            fallback: false,
        };
        let out = finalize_plan(plan, 99);
        assert_eq!(out.best_of_n, 3);
        assert_eq!(out.subtasks[0].expected_output, "do");
    }

    #[test]
    fn resume_skips_completed_and_keeps_results() {
        let mgr = PlannerRunManager::default();
        let cp = json!({
            "plan": {
                "planSummary": "resume test",
                "todos": ["a", "b"],
                "subtasks": [
                    { "id": "A1", "worker": "A", "title": "t1", "instruction": "i1", "expectedOutput": "o1", "agentType": "build" },
                    { "id": "B1", "worker": "B", "title": "t2", "instruction": "i2", "expectedOutput": "o2", "agentType": "shell" }
                ],
                "bestOfN": 0,
                "fallback": false
            },
            "completedOutputs": [
                { "id": "A1", "worker": "A", "output": "already done" }
            ]
        });
        let start = mgr
            .start(PlannerStartParams {
                model: "test".into(),
                sys_content: "sys".into(),
                user_text: "resume".into(),
                resume_checkpoint: Some(cp),
                ..sample_params()
            })
            .unwrap();
        assert_eq!(start["phase"], "need_workers");
        let jobs = start["workerJobs"].as_array().unwrap();
        assert_eq!(jobs.len(), 1);
        assert_eq!(jobs[0]["worker"], "B");
        let run_id = start["runId"].as_str().unwrap();
        let r = mgr
            .continue_run(
                run_id,
                PlannerContinueInput {
                    step: "worker_batch".into(),
                    worker_results: vec![WorkerResultInput {
                        id: "B1".into(),
                        worker: "B".into(),
                        subagent_id: None,
                        output: Some("b done".into()),
                        error: None,
                    }],
                    ..Default::default()
                },
            )
            .unwrap();
        assert_eq!(r["phase"], "need_review_llm");
        let state = mgr.state(run_id).unwrap();
        let results = state.get("results").and_then(|v| v.as_array()).unwrap();
        assert_eq!(results.len(), 2);
    }

    #[test]
    fn best_of_n_flow() {
        let mgr = PlannerRunManager::default();
        let mut params = sample_params();
        params.best_of_n = 3;
        let start = mgr.start(params).unwrap();
        let run_id = start["runId"].as_str().unwrap();
        let plan_json = r#"{"planSummary":"build task","bestOfN":3,"subtasks":[{"id":"A1","worker":"A","agentType":"build","title":"t","instruction":"do","expectedOutput":"done"}]}"#;
        let r = mgr
            .continue_run(
                run_id,
                PlannerContinueInput {
                    step: "plan_llm".into(),
                    content: Some(plan_json.into()),
                    ..Default::default()
                },
            )
            .unwrap();
        assert_eq!(r["phase"], "need_best_of_n_attempt");
        assert_eq!(r["attemptIndex"], 1);
        assert_eq!(r["totalAttempts"], 3);

        let mut r = mgr
            .continue_run(
                run_id,
                PlannerContinueInput {
                    step: "best_of_n_attempt".into(),
                    worker_results: vec![WorkerResultInput {
                        id: "A1".into(),
                        worker: "A".into(),
                        subagent_id: None,
                        output: Some("attempt1".into()),
                        error: None,
                    }],
                    ..Default::default()
                },
            )
            .unwrap();
        assert_eq!(r["phase"], "need_best_of_n_attempt");
        assert_eq!(r["attemptIndex"], 2);

        r = mgr
            .continue_run(
                run_id,
                PlannerContinueInput {
                    step: "best_of_n_attempt".into(),
                    worker_results: vec![WorkerResultInput {
                        id: "A1".into(),
                        worker: "A".into(),
                        subagent_id: None,
                        output: Some("attempt2".into()),
                        error: None,
                    }],
                    ..Default::default()
                },
            )
            .unwrap();
        assert_eq!(r["phase"], "need_best_of_n_attempt");
        assert_eq!(r["attemptIndex"], 3);

        r = mgr
            .continue_run(
                run_id,
                PlannerContinueInput {
                    step: "best_of_n_attempt".into(),
                    worker_results: vec![WorkerResultInput {
                        id: "A1".into(),
                        worker: "A".into(),
                        subagent_id: None,
                        output: Some("attempt3".into()),
                        error: None,
                    }],
                    ..Default::default()
                },
            )
            .unwrap();
        assert_eq!(r["phase"], "need_best_of_n_pick_llm");
        assert!(r.get("llmBody").is_some());

        r = mgr
            .continue_run(
                run_id,
                PlannerContinueInput {
                    step: "best_of_n_pick_llm".into(),
                    content: Some(r#"{"winnerIndex":2}"#.into()),
                    ..Default::default()
                },
            )
            .unwrap();
        assert_eq!(r["phase"], "need_review_llm");
    }
}

impl Default for PlannerContinueInput {
    fn default() -> Self {
        Self {
            step: String::new(),
            content: None,
            worker_results: vec![],
            hit_round_limit: false,
            partial_content: None,
            partial_body: None,
            worktree_ctx: None,
            arbitration_action: None,
        }
    }
}

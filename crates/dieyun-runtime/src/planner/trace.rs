//! planner 的**对外形状**：把内部状态机序列化成响应 / 事件，以及 trace 的写入口。
//!
//! 拆出来的理由（纯移动）：`run.rs` 一个 impl 同时管状态机与序列化，1200+ 行里
//! 有 200 行只是「内部状态 → JSON」。改一个 phase 字段要在两侧翻。
//!
//! 依赖方向：本文件只读 `PlannerRunState`，不推进状态；状态机仍在 `run.rs`。

use serde_json::{json, Value};

use dieyun_base::error::CoreError;

use super::plan_parse::plan_to_json;
use super::prompts::{
    build_best_of_n_pick_llm_body, build_explore_loop_messages, build_plan_llm_body,
    build_review_llm_body, build_synthesize_llm_body, format_trace_digest,
};
use super::run::{lock_runs, planner_max_tool_calls, InternalPhase, PlannerRunManager, PlannerRunState};
use super::types::{Plan, PlannerTraceEntry};

impl PlannerRunManager {
    pub(super) fn build_response(&self, run: &PlannerRunState) -> Result<Value, CoreError> {
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
                                &run.params.model,
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
                    // 「交给你的计划不是它原本的样子」要说出来：模型据此知道这次没有交叉验证。
                    if let Some(note) = &run.plan_truncation {
                        obj.insert("truncated".into(), json!(true));
                        obj.insert("truncatedNote".into(), json!(note));
                    }
                    obj.insert(
                        "results".into(),
                        serde_json::to_value(&run.results)?,
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

    pub(super) fn emit_phase(&self, run_id: &str) -> Result<Value, CoreError> {
        let runs = lock_runs(&self.runs);
        let run = runs
            .get(run_id)
            .ok_or_else(|| CoreError::rpc("NOT_FOUND", format!("planner run 不存在: {run_id}")))?;
        self.build_response(run)
    }

    pub(super) fn update_plan_trace(&self, run: &mut PlannerRunState) {
        if let Some(plan) = run.plan.clone() {
            Self::update_plan_trace_on(run, &plan);
        }
    }

    pub(super) fn update_plan_trace_on(run: &mut PlannerRunState, plan: &Plan) {
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

pub(super) fn push_trace(run: &mut PlannerRunState, phase: impl Into<String>, thought: impl Into<String>) {
    run.trace.push(PlannerTraceEntry {
        round: run.trace.len() as u32 + 1,
        phase: phase.into(),
        thought: thought.into(),
        tools: vec![],
    });
}

pub(super) fn phase_name(p: InternalPhase) -> &'static str {
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


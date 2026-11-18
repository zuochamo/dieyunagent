//! best-of-N 子机：同一条子任务跑 N 路，再让模型挑一路。
//!
//! 拆出来的理由（纯移动）：它是**独立的一段状态机**（`bn_worker_jobs` 队列 +
//! `BestOfNState.attempt_index` + 选优 LLM），却与主状态机挤在同一个 impl 里；
//! 撞轮次 / 验收 / 选优三条路径共享同一份状态，改一处要在 1200 行里翻。
//!
//! 依赖方向：本文件只经 `handle_best_of_n_attempt` / `start_best_of_n_job` 推进
//! （由 `run.rs` 的 phase 分派调用），不反向调用主状态机。

use std::collections::HashSet;

use serde_json::Value;

use dieyun_base::error::CoreError;

use super::prompts::parse_best_of_n_winner;
use super::run::{InternalPhase, PlannerRunManager, PlannerRunState};
use super::trace::push_trace;
use super::types::{PlannerContinueInput, WorkerJobOut, WorkerResultInput};

impl PlannerRunManager {
    pub(super) fn handle_best_of_n_attempt(
        &self,
        run: &mut PlannerRunState,
        mut input: PlannerContinueInput,
    ) -> Result<Value, CoreError> {
        if input.hit_round_limit {
            run.hit_round_limit = true;
            // 撞上限的那一路结果也别丢：能收就收进 collected，选优时还能用上。
            let results = std::mem::take(&mut input.worker_results);
            if let Some(bn) = run.best_of_n_state.as_mut() {
                if !results.is_empty() {
                    let summary = summarize_worker_results(&results);
                    bn.collected.push(BestOfNAttemptRecord {
                        attempt_index: bn.attempt_index,
                        results,
                        summary,
                    });
                }
            }
            let have_attempts = run
                .best_of_n_state
                .as_ref()
                .map(|bn| !bn.collected.is_empty())
                .unwrap_or(false);
            if have_attempts {
                run.phase = InternalPhase::NeedBestOfNPickLlm;
                push_trace(
                    run,
                    "Best-of-N · 选优",
                    "轮次预算已耗尽：用已收到的方案做选优",
                );
                return self.build_response(run);
            }
            run.final_content = input.partial_content;
            run.phase = InternalPhase::Done;
            push_trace(
                run,
                "规划师 · 收尾",
                "轮次预算已耗尽且没有可用方案：以半成品收尾",
            );
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

    pub(super) fn handle_best_of_n_pick_llm(
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

    pub(super) fn start_best_of_n_job(
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

}

pub(super) fn summarize_worker_results(results: &[WorkerResultInput]) -> String {
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

#[derive(Debug, Clone)]
pub(super) struct BestOfNAttemptRecord {
    pub(super) attempt_index: u32,
    pub(super) results: Vec<WorkerResultInput>,
    pub(super) summary: String,
}

#[derive(Debug, Clone)]
pub(super) struct BestOfNState {
    pub(super) job: WorkerJobOut,
    pub(super) total: u32,
    pub(super) attempt_index: u32,
    pub(super) collected: Vec<BestOfNAttemptRecord>,
}


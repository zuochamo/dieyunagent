//! worker 批：把计划拆成可并发的派活批次、维护三条队列、生成重试批。
//!
//! 拆出来的理由（纯移动）：`run.rs` 里它和「状态机推进」混在一起 —— 三套队列
//! （`pending` / `standard` / `bn`）的边界只能靠读代码才知道，撞轮次收口时最容易改漏。
//!
//! 依赖方向：本文件只经 `handle_worker_batch` 推进（由 `run.rs` 的 phase 分派调用）。

use std::collections::{HashMap, HashSet};

use serde_json::{json, Value};

use dieyun_base::error::CoreError;

use super::plan_parse::{collect_workers_from_plan, worker_job_needs_best_of_n};
use super::prompts::build_worker_task_system;
use super::run::{planner_max_tool_calls, InternalPhase, PlannerRunManager, PlannerRunState};
use super::trace::push_trace;
use super::types::{PlannerContinueInput, ReviewResult, Subtask, WorkerJobOut, WorkerResultInput};

impl PlannerRunManager {
    pub(super) fn handle_worker_batch(
        &self,
        run: &mut PlannerRunState,
        input: PlannerContinueInput,
    ) -> Result<Value, CoreError> {
        // 宿主可能少回（某个 worker 崩了 / 结果被裁剪）也可能多回：少回的那条**补一条
        // error 结果**，不许丢 —— 丢掉会让验收根本看不到这个子任务，于是可能判「都做完了」
        // 并合成一个假的完成；多回的直接忽略并留一条 trace。
        let expected: Vec<String> = run
            .pending_worker_jobs
            .iter()
            .flat_map(|j| j.tasks.iter().map(|t| t.id.clone()))
            .collect();
        let mut returned: HashMap<String, WorkerResultInput> = input
            .worker_results
            .into_iter()
            .map(|r| (r.id.clone(), r))
            .collect();
        let mut merged: Vec<WorkerResultInput> = Vec::with_capacity(expected.len());
        for id in &expected {
            match returned.remove(id) {
                Some(result) => merged.push(result),
                None => merged.push(WorkerResultInput {
                    id: id.clone(),
                    worker: String::new(),
                    subagent_id: None,
                    output: None,
                    error: Some("worker 未返回结果（宿主漏回或该子任务未执行）".into()),
                }),
            }
        }
        if !returned.is_empty() {
            push_trace(
                run,
                "规划师 · 执行",
                format!("宿主回了 {} 条不属于本批的结果，已忽略", returned.len()),
            );
        }
        let round_limit = input.hit_round_limit;
        if round_limit {
            // 撞轮次上限 ≠ 这批结果不存在：宿主把已经跑完的结果一起送回来了。
            // 旧实现整批丢弃、跳过验收、拿某一路半成品当最终答复（用户看到的是
            // 「又从头跑了一遍」或「只做了一部分却说完成」）。
            run.hit_round_limit = true;
            push_trace(
                run,
                "规划师 · 验收",
                "轮次预算已耗尽：不再派新活，用已返回的结果做一次简化验收",
            );
        }
        if run.is_retry_batch {
            let retry_ids: HashSet<String> = run
                .pending_worker_jobs
                .iter()
                .flat_map(|j| j.tasks.iter().map(|t| t.id.clone()))
                .collect();
            run.results.retain(|r| !retry_ids.contains(&r.id));
        }
        run.results.extend(merged);
        run.pending_worker_jobs.clear();
        run.standard_worker_jobs.clear();
        if round_limit {
            // 撞上限就不再开新方案（那要再来一轮 worker），直接进验收。
            run.bn_worker_jobs.clear();
        }
        self.begin_best_of_n_or_review(run, input.worktree_ctx)
    }

    pub(super) fn prepare_worker_jobs(
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

    pub(super) fn set_worker_queues(
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

}

pub(super) fn build_worker_loop_start(
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

pub(super) fn build_retry_jobs(run: &PlannerRunState, review: &ReviewResult) -> Vec<WorkerJobOut> {
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


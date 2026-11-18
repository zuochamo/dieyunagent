//! 这个模块的测试。实现留在同级文件里。
//! 拆开的理由：几百行用例与实现同居时，改一个方法要在整片用例之间翻，diff 也不可读。

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
    let out = finalize_plan(plan, 99).plan;
    assert_eq!(out.best_of_n, 3);
    assert_eq!(out.subtasks[0].expected_output, "do");
}

/// `agent-limits.plannerBestOfN` 是**上限**：模型写多少都不能超过它，关掉就是关掉。
///
/// 旧实现 `max(cfg, model)` 让「关掉 best-of-N」变成一句模型话术就能推翻的设置。
/// 回归（A18）：检查点里的 `plan` 解析不了时必须**报错**，不许静默重跑。
///
/// 旧实现 `if let Ok(parsed) = …` 把「解析失败」和「没有检查点」混成一条路：计划丢了、
/// `completedOutputs` 也一起丢，于是已经做完的子任务从头再跑一遍（还重写 worktree），
/// 界面上看不出任何异常。
#[test]
fn unparsable_checkpoint_fails_loudly_instead_of_rerunning() {
    let mgr = PlannerRunManager::default();
    let cp = json!({
        "plan": { "planSummary": "坏掉的检查点", "subtasks": "不是数组" },
        "completedOutputs": [{ "id": "A1", "worker": "A", "output": "already done" }]
    });
    let err = mgr
        .start(PlannerStartParams {
            model: "test".into(),
            sys_content: "sys".into(),
            user_text: "resume".into(),
            resume_checkpoint: Some(cp),
            ..sample_params()
        })
        .expect_err("计划不可解析时不许当成「没有检查点」继续");
    match err {
        CoreError::Rpc { code, message } => {
            assert_eq!(code, "INVALID_PARAMS");
            assert!(message.contains("检查点"), "{message}");
        }
        other => panic!("应回 INVALID_PARAMS，实际 {other:?}"),
    }
}

#[test]
fn finalize_plan_never_raises_best_of_n_above_the_host_cap() {
    let plan_with = |n: u32| Plan {
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
        best_of_n: n,
        fallback: false,
    };
    assert_eq!(finalize_plan(plan_with(3), 0).plan.best_of_n, 0, "关掉时不得开");
    assert_eq!(finalize_plan(plan_with(3), 2).plan.best_of_n, 2, "上限 2 就是 2");
    assert_eq!(finalize_plan(plan_with(0), 3).plan.best_of_n, 0, "模型没要求就不开");
    assert_eq!(finalize_plan(plan_with(5), 99).plan.best_of_n, 3, "硬上限 3");
}

/// 回归（P5 R3）：计划被宿主上限压下去时，`finalize_plan` 必须给一句人话（进 done 的 `truncated`）。
///
/// 压低是**静默的能力缩水**：模型写了 3 路并行，宿主设置关掉就只跑 1 路；不看这一句，
/// 「为什么这条任务没有交叉验证」永远查不出来。
#[test]
fn finalize_plan_reports_when_best_of_n_was_cut() {
    let plan_with = |n: u32| Plan {
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
        best_of_n: n,
        fallback: false,
    };

    let cut = finalize_plan(plan_with(3), 0);
    assert_eq!(cut.plan.best_of_n, 0);
    let note = cut.truncation.expect("压低了就必须有一句说明");
    assert!(note.contains("3 路"), "说明里要带原始要求：{note}");

    // 没压低就不该有这句话（否则宿主的「truncated」永远为真，等于没说）
    assert!(finalize_plan(plan_with(2), 3).truncation.is_none());
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
/// 模型输出里带「小写化会改变字节长度」的字符（`İ` 2→3 字节）时不许 panic：
/// 旧实现拿 `to_lowercase()` 的偏移去切原文，撞上非字符边界直接 panic。
#[test]
fn json_fence_extraction_survives_unicode_case_folding() {
    let raw = "İİ```json{\"planSummary\":\"s\",\"subtasks\":[]}```";
    let v = crate::planner::plan_parse::extract_json_block(raw).expect("应当抽出 JSON");
    assert_eq!(v["planSummary"], "s");
}
/// 撞轮次上限也要把**已经跑完的结果**收下并照常验收。
///
/// 旧实现整批丢弃、跳过验收、拿某一路半成品当最终答复 —— 用户看到的是
/// 「又从头跑了一遍」或「只做了一部分却说完成」。
#[test]
fn round_limit_batch_keeps_results_and_goes_to_review() {
    let mgr = PlannerRunManager::default();
    let start = mgr.start(sample_params()).unwrap();
    let run_id = start["runId"].as_str().unwrap().to_string();
    let plan_json = r#"{"planSummary":"s","subtasks":[{"id":"A1","worker":"A","title":"t","instruction":"do","expectedOutput":"done"}]}"#;
    mgr.continue_run(
        &run_id,
        PlannerContinueInput {
            step: "plan_llm".into(),
            content: Some(plan_json.into()),
            ..Default::default()
        },
    )
    .unwrap();
    let r = mgr
        .continue_run(
            &run_id,
            PlannerContinueInput {
                step: "worker_batch".into(),
                worker_results: vec![WorkerResultInput {
                    id: "A1".into(),
                    worker: "A".into(),
                    subagent_id: None,
                    output: Some("done".into()),
                    error: None,
                }],
                hit_round_limit: true,
                partial_content: Some("半成品".into()),
                ..Default::default()
            },
        )
        .unwrap();
    assert_eq!(
        r["phase"], "need_review_llm",
        "撞上限也要走验收，不许直接 Done：{r}"
    );
    let state = mgr.state(&run_id).unwrap();
    assert_eq!(
        state["results"].as_array().map(|a| a.len()),
        Some(1),
        "已经跑完的结果不许丢"
    );
    assert_eq!(state["hitRoundLimit"], true);
}
/// 宿主漏回一条 worker 结果：补一条 error 结果，验收必须看得见这个子任务。
#[test]
fn missing_worker_result_becomes_an_explicit_error() {
    let mgr = PlannerRunManager::default();
    let start = mgr.start(sample_params()).unwrap();
    let run_id = start["runId"].as_str().unwrap().to_string();
    let plan_json = r#"{"planSummary":"s","subtasks":[{"id":"A1","worker":"A","title":"t1","instruction":"do1","expectedOutput":"d1"},{"id":"B1","worker":"B","title":"t2","instruction":"do2","expectedOutput":"d2"}]}"#;
    mgr.continue_run(
        &run_id,
        PlannerContinueInput {
            step: "plan_llm".into(),
            content: Some(plan_json.into()),
            ..Default::default()
        },
    )
    .unwrap();
    mgr.continue_run(
        &run_id,
        PlannerContinueInput {
            step: "worker_batch".into(),
            // 只回 A1，B1 漏了
            worker_results: vec![WorkerResultInput {
                id: "A1".into(),
                worker: "A".into(),
                subagent_id: None,
                output: Some("done".into()),
                error: None,
            }],
            ..Default::default()
        },
    )
    .unwrap();
    let state = mgr.state(&run_id).unwrap();
    let results = state["results"].as_array().unwrap();
    assert_eq!(results.len(), 2, "漏回的那条要补出来");
    let b = results
        .iter()
        .find(|r| r["id"] == "B1")
        .expect("B1 必须在结果里");
    assert!(
        b["error"].as_str().unwrap_or("").contains("未返回结果"),
        "{b}"
    );
}
/// 一次 panic 不该让 planner 永久不可用：锁被毒化之后仍要能继续用
/// （`AppState` 只建一次 planner，`core.configure` 不重建它）。
#[test]
fn poisoned_lock_does_not_brick_the_planner() {
    let mgr = PlannerRunManager::default();
    let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let _guard = mgr.runs.lock().unwrap();
        panic!("模拟持锁 panic");
    }));
    assert!(mgr.runs.is_poisoned(), "前提：锁已毒化");
    assert!(mgr.start(sample_params()).is_ok(), "毒化后仍要能开工");
}

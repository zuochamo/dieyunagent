//! 这个模块的测试。实现留在同级文件里。
//! 拆开的理由：几百行用例与实现同居时，改一个方法要在整片用例之间翻，diff 也不可读。

use super::*;

use crate::planner::types::{Plan, Subtask, WorkerResultInput};

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
        max_rounds: None,
    }
}

/// 回归（2026-11-19）：worker / explore 子循环的轮次预算**只认宿主传入值**。
///
/// 以前 `workers.rs` 烤着 `"maxRounds": 96`、`trace.rs` 烤着 `24`，于是宿主把
/// `agentMaxRounds` 调到 500 对 plan 完全无效 —— 执行器仍在第 96 轮被拦腰截断，
/// 撞上限那一轮没有结论，整批只能重做（`agent-limits.js` 的注释早就写着
/// 「跨语言各留一份默认值，改一边就静默分叉」）。
#[test]
fn worker_round_budget_comes_from_host() {
    let mgr = PlannerRunManager::default();
    let mut params = sample_params();
    params.max_rounds = Some(777);
    let start = mgr.start(params).unwrap();
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
    let loop_start = mgr
        .worker_loop_body(&run_id, "A", "A1", "sa-worker-1", None, "", "")
        .unwrap();
    assert_eq!(loop_start["maxRounds"], 777, "worker 轮次预算必须来自宿主");
    // 没给轮次预算时不许回退成字面量：0 让 Node 用同一份 `agentMaxRounds`
    let mut bare = sample_params();
    bare.max_rounds = None;
    assert_eq!(super::planner_max_rounds(&bare), 0);
    assert_eq!(super::planner_max_rounds(&sample_params()), 0);
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
/// 回归（2026-11-19）：explore（只读勘察）被截断**不能**把整轮标成 `hit_round_limit`；
/// 勘察排在**拆解之前**，所以截断的勘察结论仍然作为拆解的输入往下走。
///
/// explore 撞上限后继续「拆解 → 调度执行器」，计划仍会被完整执行；以前把标志置到 run 级，
/// 于是 worker 全成功、汇总也出了正文的一轮仍被宿主判成「额度用尽」，界面显示「本段预算用完」。
#[test]
fn explore_truncation_does_not_mark_the_whole_run_as_limited() {
    let mgr = PlannerRunManager::default();
    let mut params = sample_params();
    params.has_explore_tools = true; // 走真实的「勘察 → 拆解 → 执行器」链路
    let start = mgr.start(params).unwrap();
    assert_eq!(
        start["phase"], "need_explore_loop",
        "有只读工具时先勘察、再拆解：{start}"
    );
    let run_id = start["runId"].as_str().unwrap().to_string();
    let after_explore = mgr
        .continue_run(
            &run_id,
            PlannerContinueInput {
                step: "explore_loop".into(),
                content: Some(String::new()),
                hit_round_limit: true,
                partial_content: Some("勘察到一半".into()),
                ..Default::default()
            },
        )
        .unwrap();
    assert_eq!(
        after_explore["phase"], "need_plan_llm",
        "勘察只是拆解的输入，截断也要接着拆解：{after_explore}"
    );
    let plan_json = r#"{"planSummary":"s","subtasks":[{"id":"A1","worker":"A","title":"t","instruction":"do","expectedOutput":"done"}]}"#;
    let r = mgr
        .continue_run(
            &run_id,
            PlannerContinueInput {
                step: "plan_llm".into(),
                content: Some(plan_json.into()),
                ..Default::default()
            },
        )
        .unwrap();
    assert_eq!(r["phase"], "need_workers", "勘察被截断也要继续调度执行器");
    let state = mgr.state(&run_id).unwrap();
    assert_eq!(
        state["hitRoundLimit"],
        false,
        "勘察被截断不是整轮预算耗尽：{state}"
    );
}
/// 回归（2026-11-21）：勘察结论与计划摘要各占一张卡。
///
/// 勘察前移到拆解之前以后，trace[0] 是「Explore · 只读勘察」卡，勘察结论就写在它的 thought 里；
/// `update_plan_trace` 原来写 `first_mut()`，于是计划摘要把勘察结论整段覆盖、卡片标题与内容错位。
#[test]
fn explore_notes_survive_the_plan_summary_card() {
    let mgr = PlannerRunManager::default();
    let mut params = sample_params();
    params.has_explore_tools = true;
    let start = mgr.start(params).unwrap();
    let run_id = start["runId"].as_str().unwrap().to_string();
    mgr.continue_run(
        &run_id,
        PlannerContinueInput {
            step: "explore_loop".into(),
            content: Some("勘察结论：入口在 src/main-entry.js".into()),
            ..Default::default()
        },
    )
    .unwrap();
    let plan_json = r#"{"planSummary":"把入口拆开","subtasks":[{"id":"A1","worker":"A","title":"t","instruction":"do","expectedOutput":"done"}]}"#;
    mgr.continue_run(
        &run_id,
        PlannerContinueInput {
            step: "plan_llm".into(),
            content: Some(plan_json.into()),
            ..Default::default()
        },
    )
    .unwrap();
    let state = mgr.state(&run_id).unwrap();
    let trace = state["trace"].as_array().unwrap();
    let explore = trace
        .iter()
        .find(|e| e["phase"].as_str().unwrap_or("").contains("Explore"))
        .expect("勘察卡要留着");
    let explore_thought = explore["thought"].as_str().unwrap_or("");
    assert!(
        explore_thought.contains("入口在 src/main-entry.js"),
        "勘察结论不能被计划摘要覆盖：{explore_thought}"
    );
    let plan_card = trace
        .iter()
        .find(|e| e["phase"].as_str().unwrap_or("").contains("任务拆解"))
        .expect("计划卡要在");
    let plan_thought = plan_card["thought"].as_str().unwrap_or("");
    assert!(
        plan_thought.contains("把入口拆开"),
        "计划摘要在计划卡上：{plan_thought}"
    );
    assert!(
        !plan_thought.contains("入口在 src/main-entry.js"),
        "两张卡各说各的：{plan_thought}"
    );
}

/// 回归（2026-11-19 P1）：收尾即摘句柄。
///
/// `AppState` 只建一次 planner，运行期没有别的回收点 —— 一条 run 的 results（worker 全文输出）、
/// trace、plan 会一直驻留到 core 重启。Done / Cancelled 之后再查应该是 NOT_FOUND。
#[test]
fn planner_run_is_released_once_finished() {
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
    mgr.continue_run(
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
            ..Default::default()
        },
    )
    .unwrap();
    mgr.continue_run(
        &run_id,
        PlannerContinueInput {
            step: "review_llm".into(),
            content: Some(r#"{"accepted":true,"retry":[],"notes":"ok"}"#.into()),
            ..Default::default()
        },
    )
    .unwrap();
    let done = mgr
        .continue_run(
            &run_id,
            PlannerContinueInput {
                step: "synthesize_llm".into(),
                content: Some("最终答复".into()),
                ..Default::default()
            },
        )
        .unwrap();
    assert_eq!(done["phase"], "done");
    let err = mgr.state(&run_id).expect_err("收尾后必须已摘句柄");
    assert!(
        matches!(err, CoreError::Rpc { code, .. } if code == "NOT_FOUND"),
        "收尾后 state 应为 NOT_FOUND，实际 {err:?}"
    );
}

/// 回归（2026-11-19 P1）：撞上限的那一轮**不许再派重试批**。
///
/// `workers.rs` 撞上限时明确写「不再派新活」，验收却还能 `set_worker_queues(retry_jobs)` ——
/// 预算耗尽后又起一整批子循环，用户看到「说用完却又跑一遍」。
#[test]
fn round_limited_batch_does_not_dispatch_retry() {
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
    mgr.continue_run(
        &run_id,
        PlannerContinueInput {
            step: "worker_batch".into(),
            worker_results: vec![WorkerResultInput {
                id: "A1".into(),
                worker: "A".into(),
                subagent_id: None,
                output: Some("半成品".into()),
                error: None,
            }],
            hit_round_limit: true,
            ..Default::default()
        },
    )
    .unwrap();
    let r = mgr
        .continue_run(
            &run_id,
            PlannerContinueInput {
                step: "review_llm".into(),
                content: Some(
                    r#"{"accepted":false,"retry":[{"worker":"A","subtaskIds":["A1"],"reason":"没做完"}]}"#
                        .into(),
                ),
                ..Default::default()
            },
        )
        .unwrap();
    assert_eq!(
        r["phase"], "need_synthesize_llm",
        "预算已耗尽时不许再派重试批：{r}"
    );
}

/// 回归（2026-11-19 P1）：验收点名的执行器名要**归一**后再匹配计划。
///
/// 评审 LLM 常写小写 `"a"`；老实现直接 `t.worker == worker` 一条都匹配不上 →
/// 整批变空 → trace 说「需重试」实际一条没派，直接汇总交付。
#[test]
fn retry_worker_name_is_normalized() {
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
    mgr.continue_run(
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
            ..Default::default()
        },
    )
    .unwrap();
    let r = mgr
        .continue_run(
            &run_id,
            PlannerContinueInput {
                step: "review_llm".into(),
                content: Some(
                    r#"{"accepted":false,"retry":[{"worker":"a","subtaskIds":["A1"],"reason":"重跑"}]}"#
                        .into(),
                ),
                ..Default::default()
            },
        )
        .unwrap();
    assert_eq!(r["phase"], "need_retry_workers", "小写执行器名要能匹配计划");
    let jobs = r["workerJobs"].as_array().cloned().unwrap_or_default();
    assert!(!jobs.is_empty(), "必须真的派出一批重试：{r}");
}

/// 回归（2026-11-19 P1）：计划里重复的子任务 id 要重编号（账本按 id 收敛结果）。
#[test]
fn duplicate_subtask_ids_are_renumbered() {
    let mgr = PlannerRunManager::default();
    let start = mgr.start(sample_params()).unwrap();
    let run_id = start["runId"].as_str().unwrap().to_string();
    let plan_json = r#"{"planSummary":"s","subtasks":[
        {"id":"A1","worker":"A","title":"t1","instruction":"do1","expectedOutput":"d1"},
        {"id":"A1","worker":"A","title":"t2","instruction":"do2","expectedOutput":"d2"}
    ]}"#;
    let r = mgr
        .continue_run(
            &run_id,
            PlannerContinueInput {
                step: "plan_llm".into(),
                content: Some(plan_json.into()),
                ..Default::default()
            },
        )
        .unwrap();
    let subtasks = r["plan"]["subtasks"].as_array().cloned().unwrap_or_default();
    assert_eq!(subtasks.len(), 2, "两条子任务都要留下：{r}");
    let id0 = subtasks[0]["id"].as_str().unwrap_or("");
    let id1 = subtasks[1]["id"].as_str().unwrap_or("");
    assert_ne!(id0, id1, "重复 id 必须重编号（{id0} / {id1}）");
}

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

/// 回归（2026-11-19 连中四例）：汇总轮的 system prompt **不许**拼 agent 的执行者人格
/// （`sys_content`）。
///
/// 那是「你有这些工具、按这些格式调用」的人格，而汇总请求里没有 `tools` 字段 —— 模型于是把
/// 工具调用当正文吐出来（`<｜｜DSML｜｜ calls>…invoke name="host_exec"…`），交付层从标记处删到
/// 全文末尾 ⇒ 整段归零 ⇒ 账本只剩「（模型未生成文字答复。）」，用户看到「活干完了但任务断了」。
#[test]
fn synthesize_system_prompt_is_not_the_agent_persona() {
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
    mgr.continue_run(
        &run_id,
        PlannerContinueInput {
            step: "worker_batch".into(),
            worker_results: vec![WorkerResultInput {
                id: "A1".into(),
                worker: "A".into(),
                subagent_id: None,
                output: Some("改完了".into()),
                error: None,
            }],
            ..Default::default()
        },
    )
    .unwrap();
    let r = mgr
        .continue_run(
            &run_id,
            PlannerContinueInput {
                step: "review_llm".into(),
                content: Some(r#"{"accepted":true,"retry":[],"notes":"通过"}"#.into()),
                ..Default::default()
            },
        )
        .unwrap();
    assert_eq!(r["phase"], "need_synthesize_llm", "{r}");
    let sys = r["llmBody"]["messages"][0]["content"]
        .as_str()
        .unwrap_or("");
    assert!(
        !sys.contains("sys"),
        "汇总 system 不许拼 sys_content（执行者人格会诱发工具调用当正文）：{sys}"
    );
    assert!(
        sys.contains("没有工具"),
        "必须明确告诉模型它没有工具、不许输出工具调用标记：{sys}"
    );
    assert!(
        r["llmBody"].get("tools").is_none(),
        "汇总请求本来就带不了工具，人格却按「能调工具」写，就是这次事故的成因"
    );
    let user_body = r["llmBody"]["messages"][1]["content"].as_str().unwrap_or("");
    assert!(
        user_body.contains("【子任务结果】"),
        "子任务产出仍然必须进汇总输入：{user_body}"
    );
    assert!(
        user_body.contains("改完了"),
        "子任务正文必须进汇总输入：{user_body}"
    );
}

/// 回归（2026-11-19）：验收判「未通过」但没点名重试项时，事实必须进 trace、也必须进汇总提示词。
///
/// 以前 `accepted=false + retry=[]` 与「通过」走同一条路（直接汇总），汇总提示词里又没有
/// 验收结论 —— 于是坏产出被总结成「已完成」，用户完全看不出来。
#[test]
fn rejected_without_retry_keeps_the_fact_and_reaches_synthesizer() {
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
    mgr.continue_run(
        &run_id,
        PlannerContinueInput {
            step: "worker_batch".into(),
            worker_results: vec![WorkerResultInput {
                id: "A1".into(),
                worker: "A".into(),
                subagent_id: None,
                output: Some("做了一半".into()),
                error: None,
            }],
            ..Default::default()
        },
    )
    .unwrap();
    let r = mgr
        .continue_run(
            &run_id,
            PlannerContinueInput {
                step: "review_llm".into(),
                content: Some(r#"{"accepted":false,"retry":[],"notes":"npm test 未通过"}"#.into()),
                ..Default::default()
            },
        )
        .unwrap();
    assert_eq!(r["phase"], "need_synthesize_llm", "{r}");
    let trace = r["trace"].as_array().unwrap();
    let last = trace.last().unwrap();
    assert_eq!(last["phase"], "汇总");
    assert!(
        last["thought"].as_str().unwrap_or("").contains("验收未通过"),
        "trace 必须留下「未通过」的事实：{last}"
    );
    let body = r["llmBody"]["messages"][1]["content"].as_str().unwrap_or("");
    assert!(body.contains("【验收结论】未通过"), "汇总提示词要带验收结论：{body}");
    assert!(body.contains("npm test 未通过"), "验收说明要进汇总：{body}");
}

/// 回归（2026-11-19）：汇总轮正文为空 ⇒ 先重问一次，再空就如实标「未成文」，不当成功。
#[test]
fn empty_synthesize_is_retried_once_then_marked_unwritten() {
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
    mgr.continue_run(
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
            ..Default::default()
        },
    )
    .unwrap();
    mgr.continue_run(
        &run_id,
        PlannerContinueInput {
            step: "review_llm".into(),
            content: Some(r#"{"accepted":true,"retry":[],"notes":""}"#.into()),
            ..Default::default()
        },
    )
    .unwrap();
    let retry = mgr
        .continue_run(
            &run_id,
            PlannerContinueInput {
                step: "synthesize_llm".into(),
                content: Some("   \n ".into()),
                ..Default::default()
            },
        )
        .unwrap();
    assert_eq!(
        retry["phase"], "need_synthesize_llm",
        "空正文先重问一次：{retry}"
    );
    let done = mgr
        .continue_run(
            &run_id,
            PlannerContinueInput {
                step: "synthesize_llm".into(),
                content: Some(String::new()),
                ..Default::default()
            },
        )
        .unwrap();
    assert_eq!(done["phase"], "done");
    assert!(
        done["content"].is_null(),
        "第二轮仍空 ⇒ final_content 留 None，交给交付四态处理：{done}"
    );
    let trace = done["trace"].as_array().unwrap();
    assert!(
        trace
            .last()
            .and_then(|e| e["thought"].as_str())
            .unwrap_or("")
            .contains("未成文"),
        "trace 要如实写「汇总未成文」：{done}"
    );
}

/// 回归（2026-11-19）：执行器名认不出时必须**说出来**。
///
/// 以前 `normalize_worker_id` 一律兜底成 `"A"` 且不上报 —— `workers.rs` 按 worker 分组，
/// 于是「执行器B / 前端」这类名字会把多路计划静默折叠成单 worktree 串行队列。
#[test]
fn unknown_worker_name_is_surfaced_in_trace() {
    let mgr = PlannerRunManager::default();
    let start = mgr.start(sample_params()).unwrap();
    let run_id = start["runId"].as_str().unwrap().to_string();
    let plan_json = r#"{"planSummary":"s","subtasks":[
        {"id":"A1","worker":"前端","title":"t","instruction":"do","expectedOutput":"done"},
        {"id":"B1","worker":"B","title":"t2","instruction":"do2","expectedOutput":"done2"}]}"#;
    let r = mgr
        .continue_run(
            &run_id,
            PlannerContinueInput {
                step: "plan_llm".into(),
                content: Some(plan_json.into()),
                ..Default::default()
            },
        )
        .unwrap();
    let trace = r["trace"].as_array().unwrap();
    let hit = trace.iter().any(|e| {
        e["phase"] == "规划师 · 计划归一"
            && e["thought"].as_str().unwrap_or("").contains("前端")
    });
    assert!(hit, "认不出的执行器名要进 trace：{r}");
    // 兜底只影响那一条：B 不能被一起吞进 A
    let workers: Vec<String> = r["plan"]["subtasks"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| s["worker"].as_str().unwrap_or("").to_string())
        .collect();
    assert!(workers.contains(&"A".to_string()), "{workers:?}");
    assert!(workers.contains(&"B".to_string()), "{workers:?}");
}

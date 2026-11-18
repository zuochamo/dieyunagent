//! 这个模块的测试。实现留在同级文件里。
//! 拆开的理由：几百行用例与实现同居时，改一个方法要在整片用例之间翻，diff 也不可读。

use super::*;

/// 回归（§10.8 第 3 条）：`agent.run.tools` 的**条数与归属**必须和账本一致。
///
/// 旧行为：漏回一条时账本给那条 tool_call 补一句「工具 X 未返回结果」并以**成功**
/// 继续，模型据此以为工具真的跑过了 —— 而日志里只有一条可疑记录。
#[tokio::test]
async fn agent_run_tools_requires_one_result_per_delegate() {
    let dir = tempfile::tempdir().unwrap();
    let cfg = AppConfig {
        data_dir: dir.path().to_path_buf(),
        ..AppConfig::default()
    };
    let state = AppState::new(cfg.clone());
    let (agent, index) = {
        let inner = state.inner.read().await;
        (inner.agent.clone(), inner.index.clone())
    };
    let start = agent
        .start(crate::agent::StartParams {
            model: "m".into(),
            messages: vec![json!({"role": "user", "content": "hi"})],
            tools: vec![],
            workspace_root: None,
            max_tool_calls: 5,
            max_rounds: 5,
            token_budget: 0,
            trigger_ratio: 0.0,
            run_id: None,
        })
        .unwrap();
    let run_id = start.run_id.clone();
    let next = agent
        .continue_llm(
            &cfg,
            &index,
            &run_id,
            crate::agent::LlmResponseInput {
                content: Some("calling".into()),
                tool_calls: vec![crate::agent::ToolCallInput {
                    id: "tc1".into(),
                    name: "fs_read_file".into(),
                    arguments: json!({"filePath": "a.txt"}),
                }],
                ..Default::default()
            },
        )
        .unwrap();
    assert_eq!(next.phase, "need_delegate");
    assert_eq!(
        agent.pending_delegate_ids(&run_id).unwrap(),
        vec!["tc1".to_string()]
    );

    // ① 归属对不上：回了账本不认识的结果
    let err = state
        .dispatch(
            "agent.run.tools",
            json!({ "runId": run_id, "results": [{ "id": "nope", "result": {} }] }),
        )
        .await
        .unwrap_err();
    assert_eq!(err.code(), "INVALID_PARAMS");
    assert!(err.to_string().contains("多 1 条"), "{err}");
    assert!(err.to_string().contains("缺 1 条"), "{err}");
    // 拒绝不许动账本：这批 delegate 仍然欠着，宿主可以改正后重发。
    assert_eq!(
        agent.pending_delegate_ids(&run_id).unwrap(),
        vec!["tc1".to_string()]
    );

    // ② 条数对得上：越过闸门（本用例没配 LLM 端点，预期在发请求处失败）
    let err = state
        .dispatch(
            "agent.run.tools",
            json!({ "runId": run_id, "results": [{ "id": "tc1", "result": { "ok": true } }] }),
        )
        .await
        .unwrap_err();
    assert!(
        err.to_string().contains("url") || err.code() == "LLM_CONFIG",
        "条数对得上就该往后走（本用例没配 LLM 端点）: {err}"
    );
}

/// 回归（P8）：`results: []` 与字段缺失同罪 —— 放行就会让整批工具被记成
/// 「未返回结果」并以**成功**继续，模型以为工具真的跑过了。
#[tokio::test]
async fn agent_run_tools_rejects_empty_results() {
    let dir = tempfile::tempdir().unwrap();
    let cfg = AppConfig {
        data_dir: dir.path().to_path_buf(),
        ..AppConfig::default()
    };
    let state = AppState::new(cfg);
    let err = state
        .dispatch("agent.run.tools", json!({ "runId": "run-x", "results": [] }))
        .await
        .unwrap_err();
    match err {
        CoreError::Rpc { code, message } => {
            assert_eq!(code, "INVALID_PARAMS");
            assert!(message.contains("results"), "{message}");
        }
        other => panic!("应回 INVALID_PARAMS，实际 {other:?}"),
    }
}

/// 回归（P4）：`core.configure` 失败时**不许改动现有配置**。
///
/// `apply_configure` 是逐字段改的（它先写 data_dir / 工作区，再去建目录）。旧实现在写锁里
/// 直接改 `guard.config`：create_dir_all 一失败，前半段已经生效 —— core 停在「配置指向新库、
/// MemoryStore 还在旧库」的半应用状态，返回值却只有一条错误，宿主不知道生效了一半。
#[tokio::test]
async fn configure_failure_leaves_the_live_config_untouched() {
    let dir = tempfile::tempdir().unwrap();
    let cfg = AppConfig {
        data_dir: dir.path().to_path_buf(),
        ..AppConfig::default()
    };
    let state = AppState::new(cfg);
    let before = state.inner.read().await.config.data_dir.clone();

    // 把「数据目录」指向一个**已存在的文件**：create_dir_all 必失败。
    let not_a_dir = dir.path().join("this-is-a-file");
    std::fs::write(&not_a_dir, b"x").unwrap();
    let err = state
        .dispatch(
            "core.configure",
            json!({ "data_dir": not_a_dir.to_string_lossy() }),
        )
        .await
        .unwrap_err();
    assert!(format!("{err}").len() > 0);

    let after = state.inner.read().await.config.data_dir.clone();
    assert_eq!(after, before, "失败不许把 data_dir 改成那个路径");
}

/// 回归（P4）：`agent.run.tools` 缺 `results` 时必须报 `INVALID_PARAMS`。
///
/// 旧实现静默当空数组 —— 整批工具被记成「未返回结果」、这一轮却以成功继续。
#[tokio::test]
async fn agent_run_tools_requires_results() {
    let dir = tempfile::tempdir().unwrap();
    let cfg = AppConfig {
        data_dir: dir.path().to_path_buf(),
        ..AppConfig::default()
    };
    let state = AppState::new(cfg);
    let err = state
        .dispatch("agent.run.tools", json!({ "runId": "run-x" }))
        .await
        .unwrap_err();
    match err {
        CoreError::Rpc { code, message } => {
            assert_eq!(code, "INVALID_PARAMS");
            assert!(message.contains("results"), "{message}");
        }
        other => panic!("应回 INVALID_PARAMS，实际 {other:?}"),
    }
}

/// 回归（P4）：async handler 里 panic，必须变成一条 `RPC_PANIC` 错误帧。
///
/// 不兜的话：`stdio.rs` 那条请求 future 再也不会产出值，宿主既拿不到 ok 也拿不到 error，
/// 只能干等到自己的 120s 超时，日志里看不出是 core 内部炸了。
#[tokio::test]
async fn panic_in_an_async_handler_becomes_an_error_frame() {
    let err = guard_panic(
        async {
            panic!("boom: handler 内部炸了");
            #[allow(unreachable_code)]
            Ok::<serde_json::Value, CoreError>(serde_json::Value::Null)
        },
        "demo.method",
    )
    .await
    .unwrap_err();
    match err {
        CoreError::Rpc { code, message } => {
            assert_eq!(code, "RPC_PANIC");
            assert!(message.contains("demo.method"), "{message}");
            assert!(message.contains("boom"), "{message}");
        }
        other => panic!("应回 RPC_PANIC，实际 {other:?}"),
    }
}

/// 正常返回不受影响（兜底不是「所有错误都改写」）。
#[tokio::test]
async fn guard_panic_passes_through_ok_and_err() {
    assert_eq!(guard_panic(async { Ok::<u8, CoreError>(7) }, "x").await.unwrap(), 7);
    let err = guard_panic(
        async { Err::<u8, CoreError>(CoreError::rpc("INVALID_PARAMS", "缺参")) },
        "x",
    )
    .await
    .unwrap_err();
    assert!(matches!(err, CoreError::Rpc { code: "INVALID_PARAMS", .. }));
}

/// 预算与路由的唯一来源是 `registry.rs` 的方法表 —— 这里只留一条「表里没有就不设预算」。
#[test]
fn budget_comes_from_the_registry_table() {
    assert_eq!(
        registry::find("core.ping").and_then(|s| s.budget.ms()),
        Some(registry::FAST_METHOD_BUDGET_MS)
    );
    assert_eq!(registry::find("codebase.index").and_then(|s| s.budget.ms()), None);
    assert!(registry::find("memory.status").is_none(), "memory.status 从来没实现过");
}

/// **可达性** parity：表里每一个方法都必须真的走到实现，一个也不许回 `UNKNOWN_METHOD`。
///
/// 静态 parity（表 ↔ 源码）只能证明「名字对得上」；这条是端到端那条 —— 它抓到的是
/// 「表里写了 handler，但路由分支没接上」这类只在运行期才现形的问题。
/// 参数一律传 `{}`：缺参导致的 `INVALID_PARAMS` 属正常，只有「未知方法 / 没接实现」才算失败。
#[tokio::test]
async fn every_registered_method_reaches_an_implementation() {
    let dir = tempfile::tempdir().unwrap();
    let cfg = AppConfig {
        data_dir: dir.path().to_path_buf(),
        ..AppConfig::default()
    };
    let state = AppState::new(cfg);
    for spec in registry::METHODS {
        let err = match state.dispatch(spec.name, json!({})).await {
            Ok(_) => continue,
            Err(err) => format!("{err}"),
        };
        assert!(
            !err.contains("未知 RPC") && !err.contains("没有实现"),
            "{} 在表里，却走不到实现：{err}",
            spec.name
        );
    }
}

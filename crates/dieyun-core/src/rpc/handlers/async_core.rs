//! 核心 async RPC：core / rpc / agent 驱动 / planner / llm / embedding
//!
//! 由 `AppState::dispatch` 的臂体机械搬来：`state.*` → `state.*`，其余逐字未改。
//! 这些方法都要 `.await`（LLM / embedding / 索引任务 / 事件推送 / 宿主反向调用），
//! 所以签名是 `fn(&'a AppState, &'a Value) -> BoxFuture<'a>`。
//!
//! 装配与事件通道相关的部分（`core.configure` / `core.host_probe`）也在这里。

use serde_json::{json, Value};

use std::sync::Arc;

use crate::memory;
use crate::rpc::{drive_llm_config, drive_spec, finish_drive, same_path};

use crate::config::{ConfigureParams, VERSION};
use crate::graph::GraphService;
use crate::index::IndexService;
use crate::error::CoreError;
use crate::rpc::registry::BoxFuture;
use crate::rpc::AppState;
/// `core.ping`
pub(crate) fn core_ping<'a>(_state: &'a AppState, _params: &'a Value) -> BoxFuture<'a> {
    Box::pin(async move {
Ok(serde_json::json!({
        "ok": true,
        "version": VERSION,
        "engine": "rust"
    }))
    })
}

/// `rpc.cancel`
pub(crate) fn rpc_cancel<'a>(state: &'a AppState, params: &'a Value) -> BoxFuture<'a> {
    Box::pin(async move {
        let run_id = params.get("runId").and_then(|v| v.as_str()).unwrap_or("");
        let ids = params
            .get("ids")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|x| x.as_u64().or_else(|| x.as_i64().map(|n| n as u64)))
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let mut agent_ok = false;
        let mut planner_ok = false;
        if !run_id.is_empty() {
            let guard = state.inner.read().await;
            // 真话：`cancel` 返回「是否真的找到并取消了」。旧实现它恒返回 Ok(())，
            // 于是这里恒 true —— 传错 runId、run 已结束、core 刚重启，全都报「已取消」。
            agent_ok = guard.agent.cancel(run_id)?;
            planner_ok = guard.planner.cancel(run_id).is_ok();
        }
        Ok(serde_json::json!({
            "ok": true,
            "runId": if run_id.is_empty() { serde_json::Value::Null } else { serde_json::Value::String(run_id.to_string()) },
            "ids": ids,
            "agentCancelled": agent_ok,
            "plannerCancelled": planner_ok
        }))
    })
}

/// `agent.ping`
pub(crate) fn agent_ping<'a>(_state: &'a AppState, _params: &'a Value) -> BoxFuture<'a> {
    Box::pin(async move {
Ok(serde_json::json!({
        "ok": true,
        "engine": "rust",
        "delegateOnly": true
    }))
    })
}

/// `planner.ping`
pub(crate) fn planner_ping<'a>(state: &'a AppState, _params: &'a Value) -> BoxFuture<'a> {
    Box::pin(async move {
        let guard = state.inner.read().await;
        Ok(guard.planner.ping())
    })
}

/// `planner.run.start`
pub(crate) fn planner_run_start<'a>(state: &'a AppState, params: &'a Value) -> BoxFuture<'a> {
    Box::pin(async move {
        let p: crate::planner::PlannerStartParams = serde_json::from_value(params.clone())
            .map_err(|e| CoreError::rpc("INVALID_PARAMS", e.to_string()))?;
        let guard = state.inner.read().await;
        let r = guard.planner.start(p)?;
        Ok(r)
    })
}

/// `planner.run.continue`
pub(crate) fn planner_run_continue<'a>(state: &'a AppState, params: &'a Value) -> BoxFuture<'a> {
    Box::pin(async move {
        let run_id = params
            .get("runId")
            .and_then(|v| v.as_str())
            .ok_or_else(|| CoreError::rpc("INVALID_PARAMS", "runId 必填"))?;
        let mut input_val = params.clone();
        if let Some(obj) = input_val.as_object_mut() {
            obj.remove("runId");
        }
        let input: crate::planner::PlannerContinueInput = serde_json::from_value(input_val)
            .map_err(|e| CoreError::rpc("INVALID_PARAMS", e.to_string()))?;
        let guard = state.inner.read().await;
        let r = guard.planner.continue_run(run_id, input)?;
        Ok(r)
    })
}

/// `planner.run.worker_loop`
pub(crate) fn planner_run_worker_loop<'a>(state: &'a AppState, params: &'a Value) -> BoxFuture<'a> {
    Box::pin(async move {
        let run_id = params
            .get("runId")
            .and_then(|v| v.as_str())
            .ok_or_else(|| CoreError::rpc("INVALID_PARAMS", "runId 必填"))?;
        let worker = params
            .get("worker")
            .and_then(|v| v.as_str())
            .ok_or_else(|| CoreError::rpc("INVALID_PARAMS", "worker 必填"))?;
        let task_id = params
            .get("taskId")
            .and_then(|v| v.as_str())
            .ok_or_else(|| CoreError::rpc("INVALID_PARAMS", "taskId 必填"))?;
        let subagent_id = params
            .get("subagentId")
            .and_then(|v| v.as_str())
            .unwrap_or("exec");
        let worktree_path = params.get("worktreePath").and_then(|v| v.as_str());
        let role_messages = params
            .get("roleMessages")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        let prior_summary = params
            .get("priorSummary")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        let guard = state.inner.read().await;
        let r = guard.planner.worker_loop_body(
            run_id,
            worker,
            task_id,
            subagent_id,
            worktree_path,
            role_messages,
            prior_summary,
        )?;
        Ok(r)
    })
}

/// `planner.run.cancel`
pub(crate) fn planner_run_cancel<'a>(state: &'a AppState, params: &'a Value) -> BoxFuture<'a> {
    Box::pin(async move {
        let run_id = params
            .get("runId")
            .and_then(|v| v.as_str())
            .ok_or_else(|| CoreError::rpc("INVALID_PARAMS", "runId 必填"))?;
        let guard = state.inner.read().await;
        let r = guard.planner.cancel(run_id)?;
        Ok(r)
    })
}

/// `core.configure`
pub(crate) fn core_configure<'a>(state: &'a AppState, params: &'a Value) -> BoxFuture<'a> {
    Box::pin(async move {
        let p: ConfigureParams = serde_json::from_value(params.clone())
            .map_err(|e| CoreError::rpc("INVALID_PARAMS", e.to_string()))?;
        // 不要在写锁上重开记忆库：写锁等待会把 status 等读请求全部堵住（tokio RwLock
        // writer-prefer），表现为「1 个 txt 也索引超时」。
        let reopen_cfg = {
            let mut guard = state.inner.write().await;
            let old_mem_path = guard.memory.db_path().to_path_buf();
            guard.config.apply_configure(&p).map_err(CoreError::Other)?;
            let new_mem_path = guard.config.memory_db_path();
            // 库文件没换就沿用原句柄：连接、页缓存、建表结果都不必重来。
            let new_db_path = guard.config.codebase_db_path();
            let codebase_db = if same_path(guard.codebase_db.path(), &new_db_path) {
                Arc::clone(&guard.codebase_db)
            } else {
                crate::codebase_db::handle(new_db_path)
            };
            guard.codebase_db = Arc::clone(&codebase_db);
            guard.index =
                IndexService::from_config(&guard.config, Arc::clone(&codebase_db));
            guard.graph = GraphService::new(codebase_db);
            if same_path(&old_mem_path, &new_mem_path) {
                let embedding = guard.config.embedding.clone();
                guard.memory.set_embedding(embedding);
                None
            } else {
                Some(guard.config.clone())
            }
        };
        if let Some(cfg) = reopen_cfg {
            let store = tokio::task::spawn_blocking(move || {
                memory::MemoryStore::from_config(&cfg)
            })
            .await
            .map_err(|e| CoreError::rpc("MEMORY_REOPEN_JOIN", e.to_string()))??;
            let mut guard = state.inner.write().await;
            guard.memory = store;
        }
        Ok(serde_json::json!({ "ok": true }))
    })
}

/// `embedding.query`
pub(crate) fn embedding_query<'a>(state: &'a AppState, params: &'a Value) -> BoxFuture<'a> {
    Box::pin(async move {
        let texts: Vec<String> = params
            .get("texts")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|x| x.as_str().map(str::to_string))
                    .collect()
            })
            .unwrap_or_default();
        if texts.is_empty() {
            return Ok(json!({ "vectors": [] }));
        }
        let cfg = state.snapshot().await.config.embedding;
        let vectors = crate::embedding::embed_texts(&cfg, &texts).await?;
        Ok(json!({ "vectors": vectors }))
    })
}

/// `agent.run.start`
pub(crate) fn agent_run_start<'a>(state: &'a AppState, params: &'a Value) -> BoxFuture<'a> {
    Box::pin(async move {
        let start: crate::agent::StartParams = serde_json::from_value(params.clone())
            .map_err(|e| CoreError::rpc("INVALID_PARAMS", e.to_string()))?;
        let spec = drive_spec(&params)?;
        let llm_cfg = drive_llm_config(&params, state).await?;
        let (cfg, index, agent) = {
            let inner = state.inner.read().await;
            (inner.config.clone(), inner.index.clone(), Arc::clone(&inner.agent))
        };
        let first = agent.start(start)?;
        let run_id = first.run_id.clone();
        // 增量必须在这里推给宿主：`llm::emit_delta` 只在 `agent.llm.chat` 里被调过，
        // 驱动器要自己接这条线，否则流式正文/思考到不了 UI（只有 done 的正文）。
        // `round` 暂传 None：宿主侧按「round 为空就用本地轮次计数」兜住。
        let emit = |d: &crate::agent::llm::Delta| {
            crate::rpc::events::emit_delta(
                &run_id,
                None,
                d.content.as_deref(),
                d.reasoning.as_deref(),
            );
        };
        finish_drive(
            crate::agent::driver::drive(
                &agent,
                &cfg,
                &index,
                &run_id,
                first,
                &spec,
                &llm_cfg,
                &emit,
            )
            .await,
        )
    })
}

/// `agent.run.tools`
pub(crate) fn agent_run_tools<'a>(state: &'a AppState, params: &'a Value) -> BoxFuture<'a> {
    Box::pin(async move {
        let run_id = params
            .get("runId")
            .and_then(|v| v.as_str())
            .ok_or_else(|| CoreError::rpc("INVALID_PARAMS", "runId 必填"))?
            .to_string();
        let results: Vec<crate::agent::ToolResultInput> = params
            .get("results")
            .cloned()
            .map(serde_json::from_value)
            .transpose()
            .map_err(|e| CoreError::rpc("INVALID_PARAMS", e.to_string()))?
            .unwrap_or_default();
        let spec = drive_spec(&params)?;
        let llm_cfg = drive_llm_config(&params, state).await?;
        let (cfg, index, agent) = {
            let inner = state.inner.read().await;
            (inner.config.clone(), inner.index.clone(), Arc::clone(&inner.agent))
        };
        let emit = |d: &crate::agent::llm::Delta| {
            crate::rpc::events::emit_delta(
                &run_id,
                None,
                d.content.as_deref(),
                d.reasoning.as_deref(),
            );
        };
        finish_drive(
            crate::agent::driver::drive_with_results(
                &agent,
                &cfg,
                &index,
                &run_id,
                results,
                &spec,
                &llm_cfg,
                &emit,
            )
            .await,
        )
    })
}

/// `agent.run.cancel`
pub(crate) fn agent_run_cancel<'a>(state: &'a AppState, params: &'a Value) -> BoxFuture<'a> {
    Box::pin(async move {
        let run_id = params
            .get("runId")
            .and_then(|v| v.as_str())
            .ok_or_else(|| CoreError::rpc("INVALID_PARAMS", "runId 必填"))?;
        let agent = Arc::clone(&state.inner.read().await.agent);
        // `cancelled` 是账本事实：run 不存在 / 已收尾时是 false，不再假装成功。
        let cancelled = agent.cancel(run_id)?;
        Ok(json!({ "ok": true, "cancelled": cancelled }))
    })
}

/// `llm.complete`
pub(crate) fn llm_complete<'a>(state: &'a AppState, params: &'a Value) -> BoxFuture<'a> {
    Box::pin(async move {
        let url = params
            .get("url")
            .and_then(|v| v.as_str())
            .ok_or_else(|| CoreError::rpc("INVALID_PARAMS", "url 必填"))?
            .to_string();
        let body = params
            .get("body")
            .cloned()
            .ok_or_else(|| CoreError::rpc("INVALID_PARAMS", "body 必填"))?;
        let stream = params.get("stream").and_then(|v| v.as_bool()).unwrap_or(false);
        let include_raw = params
            .get("includeRaw")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        let run_id = params
            .get("runId")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let llm_cfg = drive_llm_config(&params, state).await?;
        let outcome = crate::agent::llm::chat_completion(
            &llm_cfg,
            &url,
            &llm_cfg.headers.clone(),
            body,
            stream,
            include_raw,
            |d| {
                if !run_id.is_empty() {
                    crate::rpc::events::emit_delta(
                        &run_id,
                        None,
                        d.content.as_deref(),
                        d.reasoning.as_deref(),
                    );
                }
            },
        )
        .await?;
        let tool_calls: Vec<Value> = outcome
            .tool_calls
            .iter()
            .map(|call| {
                json!({ "id": call.id, "name": call.name, "arguments": call.arguments })
            })
            .collect();
        Ok(json!({
            "content": outcome.content,
            "reasoning": outcome.reasoning,
            "toolCalls": tool_calls,
            "finishReason": outcome.finish_reason,
            "usage": outcome.usage,
            "model": outcome.model,
            "raw": if include_raw { outcome.raw } else { None },
        }))
    })
}

/// `core.host_probe`
pub(crate) fn core_host_probe<'a>(_state: &'a AppState, params: &'a Value) -> BoxFuture<'a> {
    Box::pin(async move {
        let echo = params.get("echo").cloned().unwrap_or(serde_json::Value::Null);
        let reply = crate::rpc::calls::call_host("core.echo", echo).await?;
        Ok(serde_json::json!({
            "ok": true,
            "reply": reply,
            "pending": crate::rpc::calls::pending_count(),
        }))
    })
}

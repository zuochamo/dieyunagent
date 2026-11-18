//! 数据面 async RPC：向量召回 / 长记忆写入 / 索引与图谱后台任务
//!
//! 由 `AppState::dispatch` 的臂体机械搬来：`state.*` → `state.*`，其余逐字未改。
//! 这些方法都要 `.await`（LLM / embedding / 索引任务 / 事件推送 / 宿主反向调用），
//! 所以签名是 `fn(&'a AppState, &'a Value) -> BoxFuture<'a>`。
//!
//! 它们要等 embedding 或后台任务起停，因此必须留在 async 世界。

use serde_json::Value;

use dieyun_base::blocking::run_blocking;
use dieyun_memory::memory;
use crate::rpc::graph_scope_from_params;

use dieyun_base::error::CoreError;
use crate::rpc::registry::BoxFuture;
use crate::rpc::AppState;
/// `memory.long_recall`
pub(crate) fn memory_long_recall<'a>(state: &'a AppState, params: &'a Value) -> BoxFuture<'a> {
    Box::pin(async move {
                let query = params.get("query").and_then(|v| v.as_str()).unwrap_or("").to_string();
        let scope = params.get("scope").and_then(|v| v.as_str()).map(|s| s.to_string());
        let limit = params
            .get("limit")
            .and_then(|v| v.as_i64())
            .unwrap_or(12)
            .clamp(1, 50);
        let memory = state.snapshot().await.memory;
        memory
            .recall_long_memories(&query, scope.as_deref(), limit)
            .await
    })
}

/// `memory.long_add`
pub(crate) fn memory_long_add<'a>(state: &'a AppState, params: &'a Value) -> BoxFuture<'a> {
    Box::pin(async move {
        let content = params
            .get("content")
            .and_then(|v| v.as_str())
            .ok_or_else(|| CoreError::rpc("INVALID_PARAMS", "content 必填"))?;
        let source = params
            .get("source")
            .and_then(|v| v.as_str())
            .unwrap_or("user");
        let kind = params.get("kind").and_then(|v| v.as_str());
        let scope = params.get("scope").and_then(|v| v.as_str());
        let importance = params.get("importance").and_then(|v| v.as_i64());
        let expires_at = params.get("expiresAt").and_then(|v| v.as_i64());
        let metadata = params.get("metadata").cloned();
        // 会话溯源：归纳器/工具写入时带上 sessionId，之后才能回答
        // 「这个会话沉淀了什么 / 把这个会话记的都忘掉」。
        let session_id = params.get("sessionId").and_then(|v| v.as_str());
        let memory = state.snapshot().await.memory;
        // 写入唯一政策点：低价值闸 + 近重复抑制 + 写入即索引（一次 embedding）
        memory
            .add_long_memory_deduped(
                content,
                source,
                kind,
                scope,
                importance,
                expires_at,
                metadata.as_ref(),
                session_id,
            )
            .await
    })
}

/// `memory.long_add_many`
pub(crate) fn memory_long_add_many<'a>(state: &'a AppState, params: &'a Value) -> BoxFuture<'a> {
    Box::pin(async move {
        let items: Vec<memory::LongMemoryInput> = params
            .get("items")
            .cloned()
            .map(serde_json::from_value)
            .transpose()
            .map_err(|e| CoreError::rpc("INVALID_PARAMS", format!("items 非法: {e}")))?
            .unwrap_or_default();
        if items.is_empty() {
            return Ok(serde_json::json!({ "ok": true, "results": [] }));
        }
        let source = params
            .get("source")
            .and_then(|v| v.as_str())
            .unwrap_or("user");
        let scope = params.get("scope").and_then(|v| v.as_str());
        let session_id = params.get("sessionId").and_then(|v| v.as_str());
        let memory = state.snapshot().await.memory;
        memory
            .add_long_memories_deduped(&items, source, scope, session_id)
            .await
    })
}

/// `memory.long_reindex`
pub(crate) fn memory_long_reindex<'a>(state: &'a AppState, params: &'a Value) -> BoxFuture<'a> {
    Box::pin(async move {
        let limit = params
            .get("limit")
            .and_then(|v| v.as_i64())
            .unwrap_or(500)
            .clamp(1, 2000);
        let memory = state.snapshot().await.memory;
        memory.reindex_long_memories(limit).await
    })
}

/// `codebase.index`
pub(crate) fn codebase_index<'a>(state: &'a AppState, params: &'a Value) -> BoxFuture<'a> {
    Box::pin(async move {
        let workspace_root = params
            .get("workspaceRoot")
            .and_then(|v| v.as_str())
            .ok_or_else(|| CoreError::rpc("INVALID_PARAMS", "workspaceRoot 必填"))?
            .to_string();
        let force = params
            .get("force")
            .and_then(|v| v.as_bool())
            .unwrap_or(true);
        let vectors = params
            .get("vectors")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        let index = state.snapshot().await.index;
        if vectors && !index.vectors_available() {
            return Err(CoreError::rpc(
                "EMBEDDING_NOT_CONFIGURED",
                "未配置 Embedding 端点（模型 / base_url），无法生成向量；可先只建片段，或在设置里配好 embedding 后重试",
            ));
        }
        let r = index.index_workspace(&workspace_root, force, vectors).await?;
        Ok(serde_json::to_value(r)?)
    })
}

/// `codebase.search`
pub(crate) fn codebase_search<'a>(state: &'a AppState, params: &'a Value) -> BoxFuture<'a> {
    Box::pin(async move {
        let workspace_root = params
            .get("workspaceRoot")
            .and_then(|v| v.as_str())
            .ok_or_else(|| CoreError::rpc("INVALID_PARAMS", "workspaceRoot 必填"))?
            .to_string();
        let query = params
            .get("query")
            .and_then(|v| v.as_str())
            .ok_or_else(|| CoreError::rpc("INVALID_QUERY", "query 必填"))?;
        let limit = params
            .get("limit")
            .and_then(|v| v.as_u64())
            .map(|n| n as u32);
        let index = state.snapshot().await.index;
        // status 是同步 SQLite 聚合：走阻塞池，别压在 async worker 上
        let st = {
            let index = index.clone();
            let workspace_root = workspace_root.clone();
            run_blocking(move || index.status(&workspace_root)).await?
        };
        if !st.indexed || st.chunk_count == 0 {
            if st.indexing {
                return Err(CoreError::rpc(
                    "INDEXING_IN_PROGRESS",
                    "代码库索引构建中，请等待完成后再搜索",
                ));
            }
            // search 内不再同步建库（建库要跑 embedding）：交给面板 / prep 的 index.start
            return Err(CoreError::rpc(
                "INDEX_REQUIRED",
                "代码库尚未索引，请稍后再试或使用 grep/读文件",
            ));
        }
        let r = index.search(&workspace_root, query, limit).await?;
        Ok(serde_json::to_value(r)?)
    })
}

/// `graph.index`
pub(crate) fn graph_index<'a>(state: &'a AppState, params: &'a Value) -> BoxFuture<'a> {
    Box::pin(async move {
        let workspace_root = params
            .get("workspaceRoot")
            .and_then(|v| v.as_str())
            .ok_or_else(|| CoreError::rpc("INVALID_PARAMS", "workspaceRoot 必填"))?
            .to_string();
        let force = params
            .get("force")
            .and_then(|v| v.as_bool())
            .unwrap_or(true);
        let graph = state.snapshot().await.graph;
        let scope = graph_scope_from_params(params);
        {
            let graph = graph.clone();
            let workspace_root = workspace_root.clone();
            run_blocking(move || graph.index_workspace(&workspace_root, force, scope)).await?
        };
        let st = {
            let graph = graph.clone();
            let workspace_root = workspace_root.clone();
            run_blocking(move || graph.status(&workspace_root)).await?
        };
        Ok(serde_json::to_value(st)?)
    })
}

//! graph 域的阻塞型 RPC：每个方法一个函数（参数校验与返回形状都在这里）。
//!
//! 由 `ServiceSnapshot::dispatch` 的臂体机械搬来：`snap.*` → `snap.*`，其余逐字未改。
//! 迁移纪律见 `rpc/registry.rs` 顶部注释；parity 测试会拦「双份实现」与「搬完忘删臂」。

use serde_json::Value;

use crate::error::CoreError;
use crate::rpc::graph_scope_from_params;
use crate::rpc::ServiceSnapshot;

/// `graph.status`
pub(crate) fn status(snap: &ServiceSnapshot, params: &Value) -> Result<Value, CoreError> {
        let workspace_root = params
            .get("workspaceRoot")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        let r = snap.graph.status(workspace_root)?;
        Ok(serde_json::to_value(r)?)
    }

/// `graph.index.start`
pub(crate) fn index_start(snap: &ServiceSnapshot, params: &Value) -> Result<Value, CoreError> {
        let workspace_root = params
            .get("workspaceRoot")
            .and_then(|v| v.as_str())
            .ok_or_else(|| CoreError::rpc("INVALID_PARAMS", "workspaceRoot 必填"))?;
        let force = params
            .get("force")
            .and_then(|v| v.as_bool())
            .unwrap_or(true);
        let skip_if_ready = params
            .get("skipIfReady")
            .and_then(|v| v.as_bool())
            .unwrap_or(true);
        // 调用图按需（R5）：只有 callers/callees/impact 才需要它
        let scope = graph_scope_from_params(&params);
        let r = snap
            .graph
            .start_index_workspace(workspace_root, force, skip_if_ready, scope)?;
        Ok(serde_json::to_value(r)?)
    }

/// `graph.module_deps`
pub(crate) fn module_deps(snap: &ServiceSnapshot, params: &Value) -> Result<Value, CoreError> {
        let workspace_root = params
            .get("workspaceRoot")
            .and_then(|v| v.as_str())
            .ok_or_else(|| CoreError::rpc("INVALID_PARAMS", "workspaceRoot 必填"))?;
        let path = params.get("path").and_then(|v| v.as_str());
        let depth = params
            .get("depth")
            .and_then(|v| v.as_u64())
            .map(|n| n as u32);
        let r = snap.graph.module_deps(workspace_root, path, depth)?;
        Ok(serde_json::to_value(r)?)
    }

/// `graph.repo_map`
pub(crate) fn repo_map(snap: &ServiceSnapshot, params: &Value) -> Result<Value, CoreError> {
        let workspace_root = params
            .get("workspaceRoot")
            .and_then(|v| v.as_str())
            .ok_or_else(|| CoreError::rpc("INVALID_PARAMS", "workspaceRoot 必填"))?;
        let limit = params
            .get("limit")
            .and_then(|v| v.as_u64())
            .map(|n| n as u32);
        let r = snap.graph.repo_map(workspace_root, limit)?;
        Ok(serde_json::to_value(r)?)
    }

/// `graph.symbol_search`
pub(crate) fn symbol_search(snap: &ServiceSnapshot, params: &Value) -> Result<Value, CoreError> {
        let workspace_root = params
            .get("workspaceRoot")
            .and_then(|v| v.as_str())
            .ok_or_else(|| CoreError::rpc("INVALID_PARAMS", "workspaceRoot 必填"))?;
        let query = params
            .get("query")
            .and_then(|v| v.as_str())
            .ok_or_else(|| CoreError::rpc("INVALID_QUERY", "query 必填"))?;
        let kind = params.get("kind").and_then(|v| v.as_str());
        let limit = params
            .get("limit")
            .and_then(|v| v.as_u64())
            .map(|n| n as u32);
        let r = snap
            .graph
            .symbol_search(workspace_root, query, kind, limit)?;
        Ok(serde_json::to_value(r)?)
    }

/// `graph.callers`
pub(crate) fn callers(snap: &ServiceSnapshot, params: &Value) -> Result<Value, CoreError> {
        let workspace_root = params
            .get("workspaceRoot")
            .and_then(|v| v.as_str())
            .ok_or_else(|| CoreError::rpc("INVALID_PARAMS", "workspaceRoot 必填"))?;
        let symbol_id = params.get("symbolId").and_then(|v| v.as_i64());
        let path = params.get("path").and_then(|v| v.as_str());
        let name = params.get("name").and_then(|v| v.as_str());
        let r = snap.graph.callers(workspace_root, symbol_id, path, name)?;
        Ok(serde_json::to_value(r)?)
    }

/// `graph.callees`
pub(crate) fn callees(snap: &ServiceSnapshot, params: &Value) -> Result<Value, CoreError> {
        let workspace_root = params
            .get("workspaceRoot")
            .and_then(|v| v.as_str())
            .ok_or_else(|| CoreError::rpc("INVALID_PARAMS", "workspaceRoot 必填"))?;
        let symbol_id = params.get("symbolId").and_then(|v| v.as_i64());
        let path = params.get("path").and_then(|v| v.as_str());
        let name = params.get("name").and_then(|v| v.as_str());
        let r = snap.graph.callees(workspace_root, symbol_id, path, name)?;
        Ok(serde_json::to_value(r)?)
    }

/// `graph.impact`
pub(crate) fn impact(snap: &ServiceSnapshot, params: &Value) -> Result<Value, CoreError> {
        let workspace_root = params
            .get("workspaceRoot")
            .and_then(|v| v.as_str())
            .ok_or_else(|| CoreError::rpc("INVALID_PARAMS", "workspaceRoot 必填"))?;
        let path = params
            .get("path")
            .and_then(|v| v.as_str())
            .ok_or_else(|| CoreError::rpc("INVALID_PARAMS", "path 必填"))?;
        let depth = params
            .get("depth")
            .and_then(|v| v.as_u64())
            .map(|n| n as u32);
        let r = snap.graph.impact(workspace_root, path, depth)?;
        Ok(serde_json::to_value(r)?)
    }

/// `graph.ingest_lsp_callers`
pub(crate) fn ingest_lsp_callers(snap: &ServiceSnapshot, params: &Value) -> Result<Value, CoreError> {
        let workspace_root = params
            .get("workspaceRoot")
            .and_then(|v| v.as_str())
            .ok_or_else(|| CoreError::rpc("INVALID_PARAMS", "workspaceRoot 必填"))?;
        let callee_symbol_id = params
            .get("calleeSymbolId")
            .and_then(|v| v.as_i64())
            .ok_or_else(|| CoreError::rpc("INVALID_PARAMS", "calleeSymbolId 必填"))?;
        let callee_name = params
            .get("calleeName")
            .and_then(|v| v.as_str())
            .ok_or_else(|| CoreError::rpc("INVALID_PARAMS", "calleeName 必填"))?;
        let sites: Vec<crate::graph::LspCallSiteIn> =
            serde_json::from_value(params.get("sites").cloned().unwrap_or_default())
                .map_err(|e| CoreError::rpc("INVALID_PARAMS", e.to_string()))?;
        let r = snap.graph.ingest_lsp_callers(
            workspace_root,
            callee_symbol_id,
            callee_name,
            sites,
        )?;
        Ok(serde_json::to_value(r)?)
    }
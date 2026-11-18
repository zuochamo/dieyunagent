//! codebase 域的阻塞型 RPC：每个方法一个函数（参数校验与返回形状都在这里）。
//!
//! `index_start` 由 `ServiceSnapshot::dispatch` 的臂体机械搬来（`self.*` → `snap.*`）；
//! `status` 是更早搬来的那只。迁移纪律见 `rpc/registry.rs` 顶部注释。
//!
//! 注：`codebase.index`（同步建库一轮）与 `codebase.search` 需要 `.await`（embedding /
//! 长任务），留在 async 链；`index.start` 只是**起一个后台线程**并立刻返回状态，所以在这里。

use serde_json::Value;

use dieyun_base::error::CoreError;
use crate::rpc::ServiceSnapshot;

/// `codebase.index.start`：起一轮后台建库（立即返回当前状态）。
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
    // 向量是显式 opt-in：不传就只建 chunk（子串检索可用）
    let vectors = params
        .get("vectors")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    // 要求向量却没配 embedding 端点时必须报错：静默退化会让用户以为建好了
    if vectors && !snap.index.vectors_available() {
        return Err(CoreError::rpc(
            "EMBEDDING_NOT_CONFIGURED",
            "未配置 Embedding 端点（模型 / base_url），无法生成向量；可先只建片段，或在设置里配好 embedding 后重试",
        ));
    }
    let r = snap
        .index
        .start_index_workspace(workspace_root, force, skip_if_ready, vectors)?;
    Ok(serde_json::to_value(r)?)
}

/// `codebase.status`：索引状态 + 脏状态修复（修复协议在 `IndexService::status` 里）。
pub(crate) fn status(snap: &ServiceSnapshot, params: &Value) -> Result<Value, CoreError> {
    let workspace_root = params
        .get("workspaceRoot")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let r = snap.index.status(workspace_root)?;
    Ok(serde_json::to_value(r)?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// 没建过库的工作区：状态必须是「未索引」而不是报错 —— 面板与检索都靠这条判定。
    #[test]
    fn status_of_unindexed_workspace_is_not_an_error() {
        let dir = tempfile::tempdir().unwrap();
        let snap = crate::rpc::tests_support::snapshot(dir.path());
        let out = status(&snap, &json!({ "workspaceRoot": dir.path().to_string_lossy() })).unwrap();
        assert_eq!(out.get("indexed").and_then(|v| v.as_bool()), Some(false));
    }

    /// 要求向量但没配 embedding 时必须**报错**（静默退化会让用户以为建好了）。
    #[test]
    fn index_start_without_embedding_endpoint_fails_loudly() {
        let dir = tempfile::tempdir().unwrap();
        let snap = crate::rpc::tests_support::snapshot(dir.path());
        let err = index_start(
            &snap,
            &json!({ "workspaceRoot": dir.path().to_string_lossy(), "vectors": true }),
        )
        .unwrap_err();
        assert!(format!("{err}").contains("Embedding"));
    }
}

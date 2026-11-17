//! 与具体业务无关的阻塞方法：压缩估算 / 折叠、向量后端状态。

use serde_json::{json, Value};

use crate::compaction;
use crate::error::CoreError;
use crate::rpc::ServiceSnapshot;

/// `compaction.estimate`：只回答「这段 messages 值多少 token」（UI 上下文圆环）。
pub(crate) fn estimate(_snap: &ServiceSnapshot, params: &Value) -> Result<Value, CoreError> {
    Ok(compaction::estimate(params))
}

/// `compaction.fold`：确定性的就地折叠（无网络、无超时，所以落在阻塞池）。
///
/// 旧的 `compaction.maybe_compact` 因为要发一次 LLM 摘要请求，只能放在 async 分支并独占
/// 一条 90s 的宿主超时 —— 折叠改成纯 CPU 之后这些都删掉了。
pub(crate) fn fold(_snap: &ServiceSnapshot, params: &Value) -> Result<Value, CoreError> {
    let p: compaction::FoldParams = serde_json::from_value(params.clone())
        .map_err(|e| CoreError::rpc("INVALID_PARAMS", e.to_string()))?;
    Ok(serde_json::to_value(compaction::fold(p))?)
}

/// `embedding.status`：向量后端的唯一出口（设置页据此说清「为什么走不了本地」）。
pub(crate) fn embedding_status(snap: &ServiceSnapshot, _params: &Value) -> Result<Value, CoreError> {
    let e = &snap.config.embedding;
    let provider = e.plan();
    let (local_ok, local_reason) = e.local_status();
    Ok(json!({
        "provider": provider.label(),
        "signature": e.signature(),
        "dimensions": e.effective_dimensions(),
        "localCompiled": e.local_compiled(),
        "localReady": local_ok,
        "localReason": local_reason,
        "remoteConfigured": e.remote_configured(),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `embedding.status` 报的维度必须与「实际生效维度」同源（本地 768 / 远端配置），
    /// 否则设置页与检索侧会各说一套（历史上正是两条口径）。
    #[test]
    fn embedding_status_reports_effective_dimensions() {
        let dir = tempfile::tempdir().unwrap();
        let snap = crate::rpc::tests_support::snapshot(dir.path());
        let out = embedding_status(&snap, &json!({})).expect("status");
        assert_eq!(
            out.get("dimensions").and_then(|v| v.as_u64()),
            Some(snap.config.embedding.effective_dimensions() as u64)
        );
    }
}

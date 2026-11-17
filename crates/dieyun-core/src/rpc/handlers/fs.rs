//! 文件系统类阻塞方法。参数校验（必填 / 形状）留在 handler 里 —— 它是这条 RPC 的契约。

use serde_json::Value;

use crate::error::CoreError;
use crate::fs_ops;
use crate::rpc::ServiceSnapshot;

/// `fs.read_file`：按 offset / maxBytes 读一段。
///
/// 分块读的**切点对齐**（不能把 UTF-8 字符切成两半）在 [`crate::fs_ops::read_file`] 里，
/// 由它自己的测试兜住。
pub(crate) fn read_file(snap: &ServiceSnapshot, params: &Value) -> Result<Value, CoreError> {
    let file_path = params
        .get("filePath")
        .and_then(|v| v.as_str())
        .ok_or_else(|| CoreError::rpc("INVALID_PARAMS", "filePath 必填"))?;
    let encoding = params.get("encoding").and_then(|v| v.as_str());
    let offset = params.get("offset").and_then(|v| v.as_u64());
    let max_bytes = params.get("maxBytes").and_then(|v| v.as_u64());
    let r = fs_ops::read_file(&snap.config, file_path, encoding, offset, max_bytes)?;
    Ok(serde_json::to_value(r)?)
}

/// `fs.list_dir`：列一层目录（白名单在上游 path-policy，这里只做 IO）。
pub(crate) fn list_dir(snap: &ServiceSnapshot, params: &Value) -> Result<Value, CoreError> {
    let dir_path = params
        .get("dirPath")
        .and_then(|v| v.as_str())
        .ok_or_else(|| CoreError::rpc("INVALID_PARAMS", "dirPath 必填"))?;
    let r = fs_ops::list_dir(&snap.config, dir_path)?;
    Ok(serde_json::to_value(r)?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn snapshot() -> (tempfile::TempDir, crate::rpc::ServiceSnapshot) {
        let dir = tempfile::tempdir().unwrap();
        let snap = crate::rpc::tests_support::snapshot(dir.path());
        (dir, snap)
    }

    #[test]
    fn read_file_requires_file_path() {
        let (_dir, snap) = snapshot();
        let err = read_file(&snap, &json!({})).unwrap_err();
        assert!(format!("{err}").contains("filePath"));
    }

    #[test]
    fn read_file_reads_within_limits() {
        let (dir, snap) = snapshot();
        let p = dir.path().join("a.txt");
        std::fs::write(&p, "hello").unwrap();
        let out = read_file(&snap, &json!({ "filePath": p.to_string_lossy() })).unwrap();
        assert_eq!(out.get("data").and_then(|v| v.as_str()), Some("hello"));
    }

    #[test]
    fn list_dir_requires_dir_path() {
        let (_dir, snap) = snapshot();
        let err = list_dir(&snap, &json!({})).unwrap_err();
        assert!(format!("{err}").contains("dirPath"));
    }
}

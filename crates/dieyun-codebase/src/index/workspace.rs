use std::path::{Path, PathBuf};

use dieyun_base::config::{hash_workspace_root, normalize_path, workspace_key_hash};
use dieyun_base::error::CoreError;

#[derive(Debug, Clone)]
pub struct WorkspaceRef {
    pub key: String,
    pub root_hash: String,
    pub is_remote: bool,
    pub local_path: Option<PathBuf>,
}

pub fn is_remote_workspace_key(key: &str) -> bool {
    key.trim().starts_with("ssh://")
}

pub fn normalize_remote_workspace_key(raw: &str) -> String {
    raw.trim().trim_end_matches('/').to_string()
}

pub fn resolve_workspace(workspace_root: &str) -> Result<WorkspaceRef, CoreError> {
    let raw = workspace_root.trim();
    if raw.is_empty() {
        return Err(CoreError::rpc("INVALID_WORKSPACE", "workspaceRoot 必填"));
    }
    if is_remote_workspace_key(raw) {
        let key = normalize_remote_workspace_key(raw);
        let root_hash = workspace_key_hash(&key);
        return Ok(WorkspaceRef {
            key,
            root_hash,
            is_remote: true,
            local_path: None,
        });
    }
    let path = normalize_path(Path::new(raw))
        .map_err(|e| CoreError::rpc("INVALID_WORKSPACE", e.to_string()))?;
    let key = path.to_string_lossy().into_owned();
    Ok(WorkspaceRef {
        root_hash: hash_workspace_root(&path),
        key,
        is_remote: false,
        local_path: Some(path),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 工作区键的派生必须**逐字节**钉死：`sha256(输入)` 前 8 字节 → 16 个 hex。
    ///
    /// 以前这里只断言 `hash.len() == 16`：把实现换成 sha1 前 16 位、或先 `to_lowercase()`
    /// 再 hash、或 `take(8)` 改成取 8 个 hex 字符，用例全绿 —— 而索引键与记忆键会静默错位
    /// （查不到东西，不报错）。所以这里比对字面量。
    #[test]
    fn remote_key_hash_matches_the_shared_derivation() {
        let key = "ssh://dev@192.168.1.10/home/dev/project";
        assert_eq!(workspace_key_hash(key), "34968fa466f9bda5");
        assert_eq!(
            normalize_remote_workspace_key("ssh://a@b/c/"),
            "ssh://a@b/c"
        );
    }
}

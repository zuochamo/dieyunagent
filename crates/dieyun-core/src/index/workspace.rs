use std::path::{Path, PathBuf};

use crate::config::{hash_workspace_root, normalize_path};
use crate::error::CoreError;

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

pub fn hash_workspace_key_str(key: &str) -> String {
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(key.as_bytes());
    hex16(&digest)
}

fn hex16(bytes: &[u8]) -> String {
    bytes.iter().take(8).map(|b| format!("{b:02x}")).collect()
}

pub fn resolve_workspace(workspace_root: &str) -> Result<WorkspaceRef, CoreError> {
    let raw = workspace_root.trim();
    if raw.is_empty() {
        return Err(CoreError::rpc("INVALID_WORKSPACE", "workspaceRoot 必填"));
    }
    if is_remote_workspace_key(raw) {
        let key = normalize_remote_workspace_key(raw);
        let root_hash = hash_workspace_key_str(&key);
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

    #[test]
    fn remote_key_hash_matches_js_shape() {
        let key = "ssh://dev@192.168.1.10/home/dev/project";
        let hash = hash_workspace_key_str(key);
        assert_eq!(hash.len(), 16);
        assert_eq!(
            normalize_remote_workspace_key("ssh://a@b/c/"),
            "ssh://a@b/c"
        );
    }
}

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

pub const VERSION: &str = env!("CARGO_PKG_VERSION");
pub const DEFAULT_READ_MAX_BYTES: u64 = 2 * 1024 * 1024;
pub const ABSOLUTE_READ_MAX_BYTES: u64 = 16 * 1024 * 1024;
pub const INDEX_FILE_MAX_BYTES: u64 = 2 * 1024 * 1024;

#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LlmConfig {
    #[serde(default)]
    pub base_url: String,
    #[serde(default)]
    pub api_key: String,
    #[serde(default)]
    pub text_model: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ConfigureParams {
    #[serde(default)]
    pub data_dir: Option<String>,
    #[serde(default)]
    pub workspace_roots: Vec<String>,
    #[serde(default)]
    pub embedding: crate::embedding::EmbeddingConfig,
    #[serde(default)]
    pub llm: LlmConfig,
    #[serde(default)]
    pub models_dirs: Vec<String>,
    /// 覆盖默认的 codebase-index.sqlite 路径（远程工作区可用 `<project>/.dieyun/index.sqlite`）
    #[serde(default)]
    pub index_db_path: Option<String>,
}

#[derive(Debug, Clone)]
pub struct AppConfig {
    pub data_dir: PathBuf,
    pub workspace_roots: Vec<PathBuf>,
    pub embedding: crate::embedding::EmbeddingConfig,
    pub llm: LlmConfig,
    pub models_dirs: Vec<PathBuf>,
    pub index_db_path: Option<PathBuf>,
}

impl Default for AppConfig {
    fn default() -> Self {
        let data_dir = std::env::var("DIEYUN_DATA_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|_| default_data_dir());
        Self {
            data_dir,
            workspace_roots: Vec::new(),
            embedding: crate::embedding::EmbeddingConfig::default(),
            llm: LlmConfig::default(),
            models_dirs: default_models_dirs(),
            index_db_path: None,
        }
    }
}

fn default_data_dir() -> PathBuf {
    dirs_fallback()
}

fn dirs_fallback() -> PathBuf {
    if let Ok(appdata) = std::env::var("APPDATA") {
        return PathBuf::from(appdata).join("dieyunagent");
    }
    if let Ok(home) = std::env::var("HOME") {
        return PathBuf::from(home).join(".dieyunagent");
    }
    std::env::temp_dir().join("dieyunagent")
}

fn default_models_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Ok(dir) = std::env::var("DIEYUN_MODELS_DIR") {
        dirs.push(PathBuf::from(dir));
    }
    dirs
}

impl AppConfig {
    pub fn memory_db_path(&self) -> PathBuf {
        self.data_dir.join("diecloud-memory.sqlite")
    }

    pub fn codebase_db_path(&self) -> PathBuf {
        self.index_db_path
            .clone()
            .unwrap_or_else(|| self.data_dir.join("codebase-index.sqlite"))
    }

    pub fn apply_configure(&mut self, params: &ConfigureParams) -> anyhow::Result<()> {
        if let Some(dir) = &params.data_dir {
            self.data_dir = PathBuf::from(dir);
        }
        if !params.workspace_roots.is_empty() {
            self.workspace_roots = params
                .workspace_roots
                .iter()
                .map(|p| normalize_path(Path::new(p)))
                .collect::<anyhow::Result<Vec<_>>>()?;
        }
        self.embedding = params.embedding.clone();
        self.llm = params.llm.clone();
        if !params.models_dirs.is_empty() {
            self.models_dirs = params.models_dirs.iter().map(PathBuf::from).collect();
        }
        if let Some(p) = &params.index_db_path {
            self.index_db_path = Some(PathBuf::from(p));
        }
        std::fs::create_dir_all(&self.data_dir)?;
        if let Some(parent) = self.codebase_db_path().parent() {
            std::fs::create_dir_all(parent)?;
        }
        Ok(())
    }

    pub fn assert_allowed_path(&self, input: &Path) -> Result<PathBuf, crate::error::CoreError> {
        let resolved = normalize_path(input)?;
        if self.workspace_roots.is_empty() {
            return Ok(resolved);
        }
        for root in &self.workspace_roots {
            if path_within_root(&resolved, root) {
                return Ok(resolved);
            }
        }
        Err(crate::error::CoreError::rpc(
            "PATH_NOT_ALLOWED",
            format!("路径不在允许的工作区内: {}", input.display()),
        ))
    }
}

pub fn normalize_path(path: &Path) -> anyhow::Result<PathBuf> {
    let abs = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()?.join(path)
    };
    std::fs::canonicalize(&abs).map_err(|e| anyhow::anyhow!("无法解析路径 {}: {e}", abs.display()))
}

pub fn path_within_root(path: &Path, root: &Path) -> bool {
    path.starts_with(root)
}

pub fn hash_workspace_root(workspace_root: &Path) -> String {
    use sha2::{Digest, Sha256};
    let resolved = workspace_root.to_string_lossy();
    let digest = Sha256::digest(resolved.as_bytes());
    hex16(&digest)
}

fn hex16(bytes: &[u8]) -> String {
    bytes.iter().take(8).map(|b| format!("{b:02x}")).collect()
}

pub fn normalize_read_params(offset: Option<u64>, max_bytes: Option<u64>) -> (u64, u64) {
    let offset = offset.unwrap_or(0);
    let mut max = max_bytes.unwrap_or(DEFAULT_READ_MAX_BYTES);
    if max == 0 {
        max = DEFAULT_READ_MAX_BYTES;
    }
    max = max.min(ABSOLUTE_READ_MAX_BYTES).max(1);
    (offset, max)
}

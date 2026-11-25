use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

pub const VERSION: &str = env!("CARGO_PKG_VERSION");

/// 读上限三件套的唯一来源是 `src/agent/agent-shared.json`（Node 侧 `fs-read-limits.js` 读同一份）。
/// 以前这里是三个手抄的 const，注释写着「与 Node 同值」—— 那种注释一旦漏改就是静默漂移。
pub fn default_read_max_bytes() -> u64 {
    crate::shared::shared().read_limits.default_max_bytes
}

pub fn absolute_read_max_bytes() -> u64 {
    crate::shared::shared().read_limits.absolute_max_bytes
}

pub fn index_file_max_bytes() -> u64 {
    crate::shared::shared().read_limits.index_file_max_bytes
}

#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LlmConfig {
    #[serde(default)]
    pub base_url: String,
    #[serde(default)]
    pub api_key: String,
    #[serde(default)]
    pub text_model: String,
    /// 出站请求头，由 Node 侧 `src/agent/llm-request.js` 统一装配后传入
    /// （已含 Authorization 与供应商自定义头，占位符也已在那边渲染完毕）。
    ///
    /// 为什么不在这里自己拼：请求头构造必须是单一来源。否则会出现
    /// 「主链路带了自定义头、压缩却没带」，表现为「对话正常、压缩一跑就 400」，
    /// 而这类不一致极难定位。`api_key` 仅在 headers 里没有鉴权头时兜底。
    #[serde(default)]
    pub headers: std::collections::HashMap<String, String>,
    /// `api_key` 的注入方式：bearer（默认）/ x-api-key / none。仅兜底路径使用。
    #[serde(default)]
    pub auth_mode: String,
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

/// 把 Node 侧装配好的请求头应用到 reqwest 请求上（Compaction 与 Embedding 共用）。
///
/// 单一来源原则：请求头在 Node 的 `src/agent/llm-request.js` 里装配完成，
/// Rust 只是执行者，不重新推导鉴权逻辑。
///
/// 语义（逐条都有原因，勿简化）：
///   - `Content-Type` 一律跳过：reqwest 的 `.json()` 会自己设置，
///     重复设置会产生两个同名头，部分网关会因此直接 400。
///   - 逐个应用其余头（含供应商自定义头与 User-Agent）。
///   - 鉴权：**headers 里已有 `Authorization` / `x-api-key` 就不再兜底**，
///     否则按 `auth_mode` 用 `api_key` 拼 Bearer（兼容尚未传 headers 的旧调用方）；
///     `auth_mode == "none"`（端点无需鉴权）时不拼，避免用户显式声明被覆盖。
pub fn apply_llm_headers(
    req: reqwest::RequestBuilder,
    headers: &std::collections::HashMap<String, String>,
    api_key: &str,
    auth_mode: &str,
) -> reqwest::RequestBuilder {
    let mut out = req;
    let mut has_auth_header = false;
    for (name, value) in headers {
        if name.is_empty() || value.is_empty() || name.eq_ignore_ascii_case("content-type") {
            continue;
        }
        let lower = name.to_ascii_lowercase();
        if lower == "authorization" || lower == "x-api-key" {
            has_auth_header = true;
        }
        out = out.header(name.as_str(), value.as_str());
    }
    let key = api_key.trim();
    if !has_auth_header && !key.is_empty() && auth_mode != "none" {
        out = out.header("Authorization", format!("Bearer {key}"));
    }
    out
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

/// 工作区键（索引库 / 记忆 scope / 向量缓存都按它分区）的**唯一派生规则**：
/// `sha256(输入)` 取前 8 字节，写成 16 个 hex 字符。
///
/// 输入是「工作区标识字符串」：本地是规范化后的绝对路径（见 [`hash_workspace_root`]），
/// 远端是 `ssh://user@host/path` 这种键（宿主与 Node 侧算的是同一个形状）。
///
/// 以前 `index::workspace` 里还有第二份实现（`hash_workspace_key_str` + 自己的 `hex16`），
/// 两份靠「看起来一样」对齐 —— 一旦一边改了截断长度或加了 salt，索引键与记忆键就会
/// **静默错位**（查不到东西，不报错）。现在只有这一处。
pub fn workspace_key_hash(input: &str) -> String {
    use sha2::{Digest, Sha256};
    hex16(&Sha256::digest(input.as_bytes()))
}

pub fn hash_workspace_root(workspace_root: &Path) -> String {
    workspace_key_hash(&workspace_root.to_string_lossy())
}

fn hex16(bytes: &[u8]) -> String {
    bytes.iter().take(8).map(|b| format!("{b:02x}")).collect()
}

pub fn normalize_read_params(offset: Option<u64>, max_bytes: Option<u64>) -> (u64, u64) {
    let offset = offset.unwrap_or(0);
    let default_max = default_read_max_bytes();
    let mut max = max_bytes.unwrap_or(default_max);
    if max == 0 {
        max = default_max;
    }
    max = max.min(absolute_read_max_bytes()).max(1);
    (offset, max)
}

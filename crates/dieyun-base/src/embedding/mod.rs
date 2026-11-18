//! 向量后端：**进程内本地推理优先，远端端点可选**。
//!
//! 一个入口（[`EmbeddingConfig::plan`]）决定这一批文本走哪条路，其余函数只执行：
//!
//! - `provider = "auto"`（默认）：本地模型与 onnxruntime 都在 → 本地；否则退回远端端点。
//! - `provider = "local"`：只走本地；不可用就**报错**（显式选择不该被静默换成远端，
//!   那会让「我明明配了本地」变成难查的怪现象）。
//! - `provider = "remote"`：只走远端（服务器 / 想让多台机器共享同一向量空间时用）。
//!
//! # 删掉的那些层
//!
//! 远端独占时代为「端点一慢就整轮饿死」加过三层补偿：全进程并发闸门、给交互查询保留
//! 名额的批量闸门、以及 `INTERACTIVE_EMBED_BUDGET_MS` + `EMBEDDING_TOO_SLOW` 的
//! 「预判太慢就不发」。本地推理是毫秒级、无网络，这三层的根因消失，于是整体删除：
//! 现在只剩一个 [`BATCH_FANOUT`]（远端批量扇出窗口，纯粹是别把端点打爆）与远端请求超时
//! （那是传输层必需，不是补偿）。
//!
//! 相似度下限 [`MIN_SIMILARITY`] 与批规划仍是单一来源，别在调用点各写一份。

mod local;
mod remote;

use std::path::PathBuf;

use crate::error::CoreError;

/// 一批能塞进一次远端 `/embeddings` 请求的上限。**两种口径都得管**：条数（OpenAI 兼容
/// 端点普遍允许 2048 条）与总字符（多数本地部署按总量卡，先撞的通常是这个）。
pub const EMBED_BATCH_MAX_INPUTS: usize = 32;
const EMBED_BATCH_MAX_CHARS: usize = 24_000;
const EMBED_TEXT_MAX_CHARS: usize = 6000;

/// 远端批量路径同时在飞的请求数（扇出窗口）。
///
/// 不再是「全进程公平闸门」：本地推理没有共享名额可言，远端也不需要排队语义 ——
/// 这里只回答一个问题：「一次建库最多同时打几个请求出去」。取 4 是保守值。
pub const BATCH_FANOUT: usize = 4;

/// 向量后端解析结果（唯一来源：`EmbeddingConfig::plan`）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Provider {
    Local {
        model_dir: PathBuf,
        dylib: Option<PathBuf>,
    },
    Remote,
    /// 不可用 + 人话原因（进 `embedding.status`，别让调用方猜）。
    Disabled(String),
}

impl Provider {
    pub fn label(&self) -> &'static str {
        match self {
            Provider::Local { .. } => "local",
            Provider::Remote => "remote",
            Provider::Disabled(_) => "none",
        }
    }
}

/// 向量后端配置。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EmbeddingConfig {
    #[serde(default)]
    pub disabled: bool,
    /// `auto`（默认）/ `local` / `remote`。未知取值按 `auto` 处理（不阻断）。
    #[serde(default)]
    pub provider: String,
    #[serde(default)]
    pub base_url: String,
    #[serde(default)]
    pub api_key: String,
    #[serde(default)]
    pub model: String,
    #[serde(default = "default_dimensions")]
    pub dimensions: u32,
    /// 出站请求头，由 Node 侧 `src/agent/llm-request.js` 统一装配（语义同 LlmConfig::headers）
    #[serde(default)]
    pub headers: std::collections::HashMap<String, String>,
    /// `api_key` 注入方式：bearer（默认）/ x-api-key / none（语义同 LlmConfig::auth_mode）
    #[serde(default)]
    pub auth_mode: String,
    /// 本地模型目录（宿主按需下载到的位置）。解析与下载都由 Node 侧负责 ——
    /// 它才知道模型放在哪、下没下完；这里只校验与使用。
    #[serde(default)]
    pub local_model_dir: Option<String>,
    /// onnxruntime 动态库路径；缺省时交给 `ort` 按平台默认名加载。
    #[serde(default)]
    pub local_runtime_lib: Option<String>,
}

impl Default for EmbeddingConfig {
    fn default() -> Self {
        Self {
            disabled: false,
            provider: String::new(),
            base_url: String::new(),
            api_key: String::new(),
            model: String::new(),
            dimensions: default_dimensions(),
            headers: Default::default(),
            auth_mode: String::new(),
            local_model_dir: None,
            local_runtime_lib: None,
        }
    }
}

fn default_dimensions() -> u32 {
    1024
}

impl EmbeddingConfig {
    /// 这个后端会不会真的产出向量（`plan()` 的布尔投影）。调用点用它做「有没有向量
    /// 通道」的粗判；判**走哪条**仍然只能用 [`plan`](Self::plan)。
    pub fn enabled(&self) -> bool {
        !matches!(self.plan(), Provider::Disabled(_))
    }

    /// 远端端点是否配置齐全（本地模式不需要这些）。
    pub fn remote_configured(&self) -> bool {
        !self.model.trim().is_empty() && !self.base_url.trim().is_empty()
    }

    fn provider_kind(&self) -> &str {
        let p = self.provider.trim().to_ascii_lowercase();
        match p.as_str() {
            "local" | "remote" => if p == "local" { "local" } else { "remote" },
            _ => "auto",
        }
    }

    /// 本地推理的可用性结论（模型目录 + dylib + 编译期 feature）。
    pub fn local_availability(&self) -> local::Availability {
        let dylib = self
            .local_runtime_lib
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(PathBuf::from);
        let model_dir = self
            .local_model_dir
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(PathBuf::from);
        local::probe(dylib.as_deref(), model_dir.as_deref())
    }

    /// 这份 core 有没有编入本地推理（诊断用：设置页要能说清「为什么走不了本地」）。
    pub fn local_compiled(&self) -> bool {
        local::compiled()
    }

    /// `(可否本地, 原因)`：原因在可用时为空串。给 `embedding.status` 用。
    pub fn local_status(&self) -> (bool, String) {
        match self.local_availability() {
            local::Availability::Ready { .. } => (true, String::new()),
            local::Availability::Unavailable(reason) => (false, reason),
        }
    }

    /// 这一批文本走哪条路。**唯一判定点**：不要在调用点再判一次。
    pub fn plan(&self) -> Provider {
        if self.disabled {
            return Provider::Disabled("向量后端已关闭".to_string());
        }
        match self.provider_kind() {
            "remote" => {
                if self.remote_configured() {
                    Provider::Remote
                } else {
                    Provider::Disabled("未配置远端 Embedding 端点（模型 / baseUrl）".to_string())
                }
            }
            "local" => match self.local_availability() {
                local::Availability::Ready { model_dir } => Provider::Local {
                    model_dir,
                    dylib: self.dylib_path(),
                },
                local::Availability::Unavailable(reason) => Provider::Disabled(format!(
                    "已选择本地推理但不可用：{reason}"
                )),
            },
            _ => match self.local_availability() {
                local::Availability::Ready { model_dir } => Provider::Local {
                    model_dir,
                    dylib: self.dylib_path(),
                },
                local::Availability::Unavailable(_) => {
                    if self.remote_configured() {
                        Provider::Remote
                    } else {
                        Provider::Disabled(
                            "本地模型不可用，且未配置远端 Embedding 端点".to_string(),
                        )
                    }
                }
            },
        }
    }

    fn dylib_path(&self) -> Option<PathBuf> {
        self.local_runtime_lib
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(PathBuf::from)
    }

    /// 「这套后端」的身份：写进索引元数据（签名）与向量缓存键。
    ///
    /// 本地与远端必须是**不同**口径：同一个 768 维、同一个模型名，池化方式/端点不同就会
    /// 得到不同向量空间，混用不会报错、只会让相似度悄悄变差。
    pub fn signature(&self) -> String {
        match self.plan() {
            Provider::Local { .. } => format!(
                "{}@{}|cls",
                local::LOCAL_MODEL_ID,
                local::LOCAL_DIMENSIONS
            ),
            Provider::Remote => {
                if !self.remote_configured() {
                    return String::new();
                }
                format!("{}@{}", self.model.trim(), self.dimensions)
            }
            Provider::Disabled(_) => String::new(),
        }
    }

    /// 向量**复用缓存**的键前缀（见 `index/vector_cache.rs`）：比签名多带端点，
    /// 因为两个不同提供商完全可能都叫 `bge-m3`、都是 1024 维。
    pub fn cache_key(&self) -> String {
        let sig = self.signature();
        if sig.is_empty() {
            return String::new();
        }
        if matches!(self.plan(), Provider::Local { .. }) {
            return sig;
        }
        format!("{sig}|{}", self.base_url.trim())
    }

    /// 实际生效的维度：本地模型固定，远端取配置。
    pub fn effective_dimensions(&self) -> u32 {
        match self.plan() {
            Provider::Local { .. } => local::LOCAL_DIMENSIONS,
            _ => self.dimensions,
        }
    }
}

pub fn vector_to_blob(values: &[f32]) -> Vec<u8> {
    values.iter().flat_map(|v| v.to_le_bytes()).collect()
}

pub fn blob_to_vector(blob: &[u8], dims: usize) -> Option<Vec<f32>> {
    if dims == 0 || blob.len() != dims * 4 {
        return None;
    }
    let mut out = Vec::with_capacity(dims);
    for chunk in blob.chunks_exact(4) {
        out.push(f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]));
    }
    Some(out)
}

pub fn cosine_similarity(a: &[f32], b: &[f32]) -> f64 {
    if a.len() != b.len() || a.is_empty() {
        return 0.0;
    }
    let mut dot = 0.0f64;
    let mut na = 0.0f64;
    let mut nb = 0.0f64;
    for i in 0..a.len() {
        let x = a[i] as f64;
        let y = b[i] as f64;
        dot += x * y;
        na += x * x;
        nb += y * y;
    }
    let denom = na.sqrt() * nb.sqrt();
    if denom <= 1e-8 {
        0.0
    } else {
        dot / denom
    }
}

/// 向量召回的相似度下限：余弦相似度低于它（含等于）的命中直接丢弃。
///
/// **唯一来源**：代码索引的向量池扫描（`index/vector_pool.rs`）与长记忆的语义召回
/// （`memory/mod.rs`）都用这一个数。
pub const MIN_SIMILARITY: f64 = 0.05;

/// 「这条相似度过不过下限」的**唯一判定**。
///
/// 必须写成 `!(sim > MIN)` 而不是 `sim <= MIN`：上游回了 NaN 时后者恒为 false，
/// 于是 NaN 命中会**通过阈值**并占住融合名次，把真命中挤掉（而且不报错）。
pub fn passes_min_similarity(sim: f64) -> bool {
    sim.is_finite() && sim > MIN_SIMILARITY
}

/// 把文本变成向量（后端由 [`EmbeddingConfig::plan`] 决定）。
pub async fn embed_texts(
    cfg: &EmbeddingConfig,
    inputs: &[String],
) -> Result<Vec<Vec<f32>>, CoreError> {
    if inputs.is_empty() {
        return Ok(Vec::new());
    }
    let prepared: Vec<String> = inputs.iter().map(|text| truncate_embed_text(text)).collect();
    match cfg.plan() {
        Provider::Local { model_dir, dylib } => {
            // ONNX 推理会钉住线程：搬阻塞池，别压在 async worker 上。
            tokio::task::spawn_blocking(move || local::embed(&model_dir, dylib.as_deref(), &prepared))
                .await
                .map_err(|e| CoreError::rpc("EMBEDDING_LOCAL_JOIN", e.to_string()))?
        }
        Provider::Remote => {
            remote::embed_remote(cfg, &prepared, remote::EMBED_REQUEST_TIMEOUT_MS).await
        }
        Provider::Disabled(reason) => Err(CoreError::rpc("EMBEDDING_DISABLED", reason)),
    }
}

/// 交互查询用的单条向量（`embedding.query` / 记忆语义召回的唯一入口）。
///
/// 与 [`embed_texts`] 的区别只有两点，但两点都重要：
/// 1. **短超时**（[`remote::EMBED_QUERY_TIMEOUT_MS`]）：召回是每轮都要走的读路径，
///    端点挂住时不能把整轮对话卡满 120s；
/// 2. 超时是这里**唯一**被消化的地方：命中 `EMBEDDING_TIMEOUT` 就记一行 `[rpc-degraded]`，
///    然后照常返回 Err —— 调用方按「语义通道不可用、用关键词兜底」处理。
pub async fn embed_query(
    cfg: &EmbeddingConfig,
    texts: &[String],
) -> Result<Vec<Vec<f32>>, CoreError> {
    if texts.is_empty() {
        return Ok(Vec::new());
    }
    let prepared: Vec<String> = texts.iter().map(|text| truncate_embed_text(text)).collect();
    let vectors = match cfg.plan() {
        Provider::Local { model_dir, dylib } => {
            tokio::task::spawn_blocking(move || local::embed(&model_dir, dylib.as_deref(), &prepared))
                .await
                .map_err(|e| CoreError::rpc("EMBEDDING_LOCAL_JOIN", e.to_string()))??
        }
        Provider::Remote => {
            remote::embed_remote(cfg, &prepared, remote::EMBED_QUERY_TIMEOUT_MS)
                .await
                .inspect_err(|err| {
                    if err.code() == remote::EMBEDDING_TIMEOUT_CODE {
                        crate::obs::degraded(
                            "embedding.query",
                            &format!(
                                "timeout={}ms（语义通道跳过，关键词/FTS 接管）",
                                remote::EMBED_QUERY_TIMEOUT_MS
                            ),
                        );
                    }
                })?
        }
        Provider::Disabled(reason) => return Err(CoreError::rpc("EMBEDDING_DISABLED", reason)),
    };
    Ok(vectors)
}

pub async fn embed_batches(
    cfg: &EmbeddingConfig,
    pending: &[(i64, String)],
) -> Result<Vec<(i64, Vec<f32>)>, CoreError> {
    let batches = plan_embed_batches(pending);
    if batches.is_empty() {
        return Ok(Vec::new());
    }
    // 扇出窗口：本地路径下每个 batch 走同一个 session 池（池自己排队），
    // 远端路径下别把端点一次打爆。窗口是唯一口径，不再有第二层信号量。
    let mut queued = batches.into_iter();
    let mut set = tokio::task::JoinSet::new();
    for _ in 0..BATCH_FANOUT {
        match queued.next() {
            Some(batch) => spawn_embed_batch(&mut set, cfg, batch),
            None => break,
        }
    }
    let mut out = Vec::with_capacity(pending.len());
    while let Some(joined) = set.join_next().await {
        let rows = joined.map_err(|e| CoreError::rpc("EMBEDDING_JOIN", e.to_string()))??;
        out.extend(rows);
        if let Some(batch) = queued.next() {
            spawn_embed_batch(&mut set, cfg, batch);
        }
    }
    Ok(out)
}

fn spawn_embed_batch(
    set: &mut tokio::task::JoinSet<Result<Vec<(i64, Vec<f32>)>, CoreError>>,
    cfg: &EmbeddingConfig,
    batch: Vec<(i64, String)>,
) {
    let cfg = cfg.clone();
    set.spawn(async move { embed_batch(&cfg, batch).await });
}

async fn embed_batch(
    cfg: &EmbeddingConfig,
    batch: Vec<(i64, String)>,
) -> Result<Vec<(i64, Vec<f32>)>, CoreError> {
    let texts: Vec<String> = batch
        .iter()
        .map(|(_, text)| truncate_embed_text(text))
        .collect();
    // 条数已在 `remote::parse_embedding_vectors` 校验过（唯一位置）；本地后端自己保证。
    let vectors = embed_texts(cfg, &texts).await?;
    Ok(batch
        .into_iter()
        .map(|(id, _)| id)
        .zip(vectors)
        .collect())
}

/// 批次规划的**单一来源**（纯函数，好测）：按字符预算 + 条数上限把待算文本切批。
fn plan_embed_batches(pending: &[(i64, String)]) -> Vec<Vec<(i64, String)>> {
    let mut batches: Vec<Vec<(i64, String)>> = Vec::new();
    let mut cur: Vec<(i64, String)> = Vec::new();
    let mut cur_chars = 0usize;
    for (id, text) in pending {
        let chars = text.chars().count().min(EMBED_TEXT_MAX_CHARS);
        let full = cur.len() >= EMBED_BATCH_MAX_INPUTS || cur_chars + chars > EMBED_BATCH_MAX_CHARS;
        if !cur.is_empty() && full {
            batches.push(std::mem::take(&mut cur));
            cur_chars = 0;
        }
        cur_chars += chars;
        cur.push((*id, text.clone()));
    }
    if !cur.is_empty() {
        batches.push(cur);
    }
    batches
}

/// 实际送给模型的文本（超长 chunk 按字符截断）。
///
/// **向量缓存的键必须用它**（见 `index/vector_cache.rs`）：决定一条向量的是「送进模型的
/// 文本」，不是原始 chunk 正文。
pub fn embedding_input(text: &str) -> String {
    truncate_embed_text(text)
}

fn truncate_embed_text(text: &str) -> String {
    if text.chars().count() <= EMBED_TEXT_MAX_CHARS {
        return text.to_string();
    }
    match text.char_indices().nth(EMBED_TEXT_MAX_CHARS) {
        Some((idx, _)) => text[..idx].to_string(),
        None => text.to_string(),
    }
}

#[cfg(test)]
mod tests {

    /// NaN 不许过阈值：`sim <= MIN` 对 NaN 恒为 false，会把 NaN 命中放进结果里，
    /// 占住融合名次并把真命中挤掉（而且不报错）。
    #[test]
    fn nan_never_passes_the_similarity_floor() {
        assert!(!passes_min_similarity(f64::NAN));
        assert!(!passes_min_similarity(f64::INFINITY));
        assert!(!passes_min_similarity(MIN_SIMILARITY));
        assert!(passes_min_similarity(MIN_SIMILARITY + 0.01));
    }
    use super::*;

    fn pending(count: usize, chars: usize) -> Vec<(i64, String)> {
        (0..count)
            .map(|i| (i as i64, "x".repeat(chars)))
            .collect()
    }

    fn remote_cfg() -> EmbeddingConfig {
        EmbeddingConfig {
            provider: "remote".to_string(),
            base_url: "https://example/v1".to_string(),
            model: "bge-m3".to_string(),
            dimensions: 1024,
            ..Default::default()
        }
    }

    #[test]
    fn plan_keeps_every_chunk_exactly_once_and_in_order() {
        let items = pending(100, 50);
        let flat: Vec<i64> = plan_embed_batches(&items)
            .iter()
            .flat_map(|b| b.iter().map(|(id, _)| *id))
            .collect();
        assert_eq!(flat, (0..100).collect::<Vec<i64>>());
    }

    #[test]
    fn plan_batches_by_input_count_cap() {
        let batches = plan_embed_batches(&pending(50, 10));
        assert_eq!(batches.len(), 2);
        assert_eq!(batches[0].len(), EMBED_BATCH_MAX_INPUTS);
        assert_eq!(batches[1].len(), 50 - EMBED_BATCH_MAX_INPUTS);
    }

    #[test]
    fn plan_batches_by_char_budget() {
        let batches = plan_embed_batches(&pending(25, 2000));
        let per_batch = EMBED_BATCH_MAX_CHARS / 2000;
        assert_eq!(batches.len(), 25_usize.div_ceil(per_batch));
    }

    #[test]
    fn plan_counts_truncated_length_not_raw_length() {
        let batches = plan_embed_batches(&pending(9, 100_000));
        assert_eq!(batches[0].len(), EMBED_BATCH_MAX_CHARS / EMBED_TEXT_MAX_CHARS);
        assert_eq!(batches.iter().map(|b| b.len()).sum::<usize>(), 9);
    }

    #[test]
    fn plan_never_returns_empty_batch_for_single_oversized_input() {
        let batches = plan_embed_batches(&[(1, "y".repeat(500_000))]);
        assert_eq!(batches.len(), 1);
        assert_eq!(batches[0][0].0, 1);
    }

    #[test]
    fn plan_of_nothing_is_no_batches() {
        assert!(plan_embed_batches(&[]).is_empty());
    }

    #[test]
    fn truncation_is_char_based_not_byte_based() {
        let text = "汉".repeat(EMBED_TEXT_MAX_CHARS + 1);
        assert_eq!(
            truncate_embed_text(&text).chars().count(),
            EMBED_TEXT_MAX_CHARS
        );
    }

    /// 远端配置齐全时 auto 走远端；没配端点且本地不可用 → Disabled，而不是静默产出 0 向量。
    #[test]
    fn plan_prefers_remote_when_local_unavailable() {
        let mut cfg = remote_cfg();
        cfg.provider = "auto".to_string();
        assert_eq!(cfg.plan(), Provider::Remote);
        assert_eq!(cfg.signature(), "bge-m3@1024");

        let bare = EmbeddingConfig {
            provider: "auto".to_string(),
            ..Default::default()
        };
        let Provider::Disabled(reason) = bare.plan() else {
            panic!("两种后端都不可用时应 Disabled");
        };
        assert!(reason.contains("远端"), "原因要说清缺什么: {reason}");
    }

    /// 显式选本地但本地不可用 → 报错，**不**偷偷换成远端（换了两边向量空间就不一致了）。
    #[test]
    fn explicit_local_never_falls_back_to_remote() {
        let mut cfg = remote_cfg();
        cfg.provider = "local".to_string();
        let Provider::Disabled(reason) = cfg.plan() else {
            panic!("显式本地不可用时必须 Disabled");
        };
        assert!(reason.contains("本地"), "{reason}");
        assert_eq!(cfg.signature(), "", "不可用时签名必须为空（别让库以为已建好）");
    }

    #[test]
    fn disabled_switch_wins_over_everything() {
        let mut cfg = remote_cfg();
        cfg.disabled = true;
        assert!(matches!(cfg.plan(), Provider::Disabled(_)));
        assert_eq!(cfg.signature(), "");
        assert_eq!(cfg.cache_key(), "");
    }

    /// 缓存键要带端点：两个提供商都可能叫 bge-m3、都是 1024 维。
    #[test]
    fn cache_key_separates_endpoints() {
        let a = remote_cfg();
        let mut b = remote_cfg();
        b.base_url = "https://other/v1".to_string();
        assert_ne!(a.cache_key(), b.cache_key());
        assert_eq!(a.cache_key(), "bge-m3@1024|https://example/v1");
    }

    #[test]
    fn unknown_provider_value_is_treated_as_auto() {
        let mut cfg = remote_cfg();
        cfg.provider = "whatever".to_string();
        assert_eq!(cfg.plan(), Provider::Remote);
    }
}

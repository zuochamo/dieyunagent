mod remote;

use std::sync::OnceLock;

use tokio::sync::Semaphore;

use crate::error::CoreError;

/// 一批能塞进一次 `/embeddings` 请求的上限。**两种口径都得管**：条数（OpenAI 兼容端点普遍
/// 允许 2048 条）与总字符/token（多数本地部署按总量卡，先撞的通常是这个）。
/// 字符预算是硬约束；条数上限只防「超短 chunk 拼成巨长请求」。
const EMBED_BATCH_MAX_INPUTS: usize = 32;
const EMBED_BATCH_MAX_CHARS: usize = 24_000;
const EMBED_TEXT_MAX_CHARS: usize = 6000;

/// 同时在飞的 `/embeddings` 请求数上限 —— **全进程唯一**的并发口径。
///
/// 原来是 `Mutex<()>`：所有 embedding 请求串行，7178 片段的冷启动 = 899 次串行往返。
/// 改成闸门后仍然是「进程级单一来源」（多个索引库同时建也只共享这 N 个名额），
/// 但单次建库能用满它。**保守取 4**：端点普遍按 RPM/TPM 限流，而这里没有 429 退避层
/// （那是加速掩盖问题；真被限流时应当报 `EMBEDDING_API`，见 docs/VECTOR-SEARCH.md）。
pub const EMBED_CONCURRENCY: usize = 4;

static EMBED_INFLIGHT: OnceLock<Semaphore> = OnceLock::new();

fn embed_inflight() -> &'static Semaphore {
    EMBED_INFLIGHT.get_or_init(|| Semaphore::new(EMBED_CONCURRENCY))
}

/// 向量后端配置。**只支持远程 OpenAI 兼容 /embeddings 端点**：
/// 进程内 ONNX 推理（内置 bge-base-zh-v1.5）已删除，索引在未配置端点时退化为纯关键词检索。
#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EmbeddingConfig {
    #[serde(default)]
    pub disabled: bool,
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
}

fn default_dimensions() -> u32 {
    1024
}

impl EmbeddingConfig {
    pub fn enabled(&self) -> bool {
        !self.disabled && !self.model.trim().is_empty() && !self.base_url.trim().is_empty()
    }

    pub fn signature(&self) -> String {
        if !self.enabled() {
            return String::new();
        }
        format!("{}@{}", self.model.trim(), self.dimensions)
    }

    /// 向量**复用缓存**的键前缀（见 `index/vector_cache.rs`）。
    ///
    /// 比 [`signature`](Self::signature) 多带一个端点：签名是**库里**元数据的口径
    /// （只保证「同一模型同一维度」），而缓存是跨项目全局共享的——两个不同提供商完全可能
    /// 都叫 `bge-m3`、都是 1024 维，喂错向量不会报错，只会让检索悄悄变差。
    /// 索引元数据仍用签名（改口径会让存量库集体判「过期」并重算），只有缓存键带端点。
    pub fn cache_key(&self) -> String {
        let sig = self.signature();
        if sig.is_empty() {
            return String::new();
        }
        format!("{sig}|{}", self.base_url.trim())
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

pub async fn embed_texts(cfg: &EmbeddingConfig, inputs: &[String]) -> Result<Vec<Vec<f32>>, CoreError> {
    if !cfg.enabled() {
        return Err(CoreError::rpc(
            "EMBEDDING_DISABLED",
            "未配置 Embedding 模型",
        ));
    }
    if inputs.is_empty() {
        return Ok(Vec::new());
    }
    let prepared: Vec<String> = inputs
        .iter()
        .map(|text| truncate_embed_text(text))
        .collect();
    // 只把「真的在飞的那一次 HTTP」算进闸门：准备文本不占名额
    let _permit = embed_inflight()
        .acquire()
        .await
        .map_err(|_| CoreError::rpc("EMBEDDING_HTTP", "embedding 并发闸门已关闭"))?;
    remote::embed_remote(cfg, &prepared).await
}

pub async fn embed_batches(
    cfg: &EmbeddingConfig,
    pending: &[(i64, String)],
) -> Result<Vec<(i64, Vec<f32>)>, CoreError> {
    let batches = plan_embed_batches(pending);
    if batches.is_empty() {
        return Ok(Vec::new());
    }
    // 并发跑批：真正的并发上限是 `embed_inflight` 闸门（全进程），这里只负责把批摊开。
    // 摊开的窗口是闸门的 2 倍：既喂得满 4 个名额，又不会给十万片段的仓一次 clone 出上千个任务。
    // 顺序无所谓 —— 调用方按 chunk id 回填（`store_embedded_vectors` 用 `hash_by_id` 索引）。
    let window = EMBED_CONCURRENCY * 2;
    let mut queued = batches.into_iter();
    let mut set = tokio::task::JoinSet::new();
    for _ in 0..window {
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
    let vectors = embed_texts(cfg, &texts).await?;
    if vectors.len() != batch.len() {
        return Err(CoreError::rpc(
            "EMBEDDING_PARSE",
            format!("期望 {} 条向量，收到 {}", batch.len(), vectors.len()),
        ));
    }
    Ok(batch
        .into_iter()
        .map(|(id, _)| id)
        .zip(vectors)
        .collect())
}

/// 批次规划的**单一来源**（纯函数，好测）：按字符预算 + 条数上限把待算文本切批。
///
/// 字符按「真正发出去的文本」计（先按 `EMBED_TEXT_MAX_CHARS` 截断），否则一个 40k 字符的
/// chunk 会让预算失真。永远至少放一条：单条超预算也自成一批，不会切不动。
fn plan_embed_batches(pending: &[(i64, String)]) -> Vec<Vec<(i64, String)>> {
    let mut batches: Vec<Vec<(i64, String)>> = Vec::new();
    let mut cur: Vec<(i64, String)> = Vec::new();
    let mut cur_chars = 0usize;
    for (id, text) in pending {
        let chars = text.chars().count().min(EMBED_TEXT_MAX_CHARS);
        let full = cur.len() >= EMBED_BATCH_MAX_INPUTS
            || cur_chars + chars > EMBED_BATCH_MAX_CHARS;
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

/// 实际发给端点的文本（超长 chunk 按字符截断）。
///
/// **向量缓存的键必须用它**（见 `index/vector_cache.rs`）：决定一条向量的是「送进模型的
/// 文本」，不是原始 chunk 正文。用正文做键的话，两个只在截断点之后不同的 chunk 会各算一次、
/// 拿到完全相同的向量——纯浪费。
pub(crate) fn embedding_input(text: &str) -> String {
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
    use super::*;

    fn pending(count: usize, chars: usize) -> Vec<(i64, String)> {
        (0..count)
            .map(|i| {
                let body = "x".repeat(chars);
                (i as i64, body)
            })
            .collect()
    }

    #[test]
    fn plan_keeps_every_chunk_exactly_once_and_in_order() {
        let items = pending(100, 50);
        let batches = plan_embed_batches(&items);
        let flat: Vec<i64> = batches
            .iter()
            .flat_map(|b| b.iter().map(|(id, _)| *id))
            .collect();
        assert_eq!(flat, (0..100).collect::<Vec<i64>>());
    }

    #[test]
    fn plan_batches_by_input_count_cap() {
        // 条数上限生效：50 条字符很小的文本 → 每批 32 条
        let batches = plan_embed_batches(&pending(50, 10));
        assert_eq!(batches.len(), 2);
        assert_eq!(batches[0].len(), EMBED_BATCH_MAX_INPUTS);
        assert_eq!(batches[1].len(), 50 - EMBED_BATCH_MAX_INPUTS);
        // 条款都相同：不该出现空批
        assert!(batches.iter().all(|b| !b.is_empty()));
    }

    #[test]
    fn plan_batches_by_char_budget() {
        // 2000 字符一条 → 字符预算（24000）先撞：每批 12 条
        let batches = plan_embed_batches(&pending(25, 2000));
        let per_batch = EMBED_BATCH_MAX_CHARS / 2000;
        assert_eq!(batches.len(), 25_usize.div_ceil(per_batch));
        assert!(batches[..batches.len() - 1]
            .iter()
            .all(|b| b.len() == per_batch && b.len() < EMBED_BATCH_MAX_INPUTS));
    }

    #[test]
    fn plan_counts_truncated_length_not_raw_length() {
        // 100k 字符的 chunk 实际只发 6000：按 6000 计入预算，于是每批 4 条（24000/6000）
        let batches = plan_embed_batches(&pending(9, 100_000));
        assert_eq!(batches[0].len(), EMBED_BATCH_MAX_CHARS / EMBED_TEXT_MAX_CHARS);
        let flat = batches.iter().map(|b| b.len()).sum::<usize>();
        assert_eq!(flat, 9);
    }

    #[test]
    fn plan_never_returns_empty_batch_for_single_oversized_input() {
        let batches = plan_embed_batches(&[(1, "y".repeat(500_000))]);
        assert_eq!(batches.len(), 1);
        assert_eq!(batches[0].len(), 1);
        assert_eq!(batches[0][0].0, 1);
    }

    #[test]
    fn plan_of_nothing_is_no_batches() {
        assert!(plan_embed_batches(&[]).is_empty());
    }

    #[test]
    fn truncation_is_char_based_not_byte_based() {
        // 中文 3 字节/字：6001 个汉字必须截到 6000 个字符且不 panic
        let text = "汉".repeat(EMBED_TEXT_MAX_CHARS + 1);
        let cut = truncate_embed_text(&text);
        assert_eq!(cut.chars().count(), EMBED_TEXT_MAX_CHARS);
    }
}

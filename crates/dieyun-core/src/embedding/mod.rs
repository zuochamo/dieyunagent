mod remote;

use std::sync::{Mutex, OnceLock};
use std::time::Instant;

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
///
/// **批量路径另有一道少 1 个名额的小闸门**（见 `embed_batch_inflight`）：交互式单条查询
/// （`memory.long_recall` 的查询向量）不能被后台建库饿死。
pub const EMBED_CONCURRENCY: usize = 4;

static EMBED_INFLIGHT: OnceLock<Semaphore> = OnceLock::new();

fn embed_inflight() -> &'static Semaphore {
    EMBED_INFLIGHT.get_or_init(|| Semaphore::new(EMBED_CONCURRENCY))
}

/// 批量路径的并发名额（比全进程闸门少 1）。
///
/// 为什么需要它：闸门是 FIFO 公平的，而建库一次会往里面排几百个批次请求 ——
/// 用户的 `memory.long_recall` 只能排在它们后面。实测（2026-11-02 13:43–15:19，
/// `E:\dieyunagent` 反复增量建库期间）core 侧单次 recall 耗时 131s~438s，
/// 宿主侧 120s 超时 10 次。留出一个常驻名额后，交互查询最多排在 3 个批次请求之后，
/// 等待从「几分钟」降到「几个请求的时间」。
///
/// 口径仍是本文件：总量上限没变（还是 `EMBED_CONCURRENCY` 个真正在飞的 HTTP），
/// 只是把「谁能占满」改成「批量不许占满」。
static EMBED_BATCH_INFLIGHT: OnceLock<Semaphore> = OnceLock::new();

fn embed_batch_inflight() -> &'static Semaphore {
    EMBED_BATCH_INFLIGHT.get_or_init(|| Semaphore::new(EMBED_CONCURRENCY.saturating_sub(1).max(1)))
}

/// 交互式查询（每轮系统提示的记忆召回、`codebase.search` 的查询向量）能接受的
/// **一次 embedding 往返**上限。数字与 Node 侧 `src/agent/agent-limits.js`
/// (`interactiveEmbedBudgetMs`，prep 的召回预算同量级) 成对，跨语言没法共享常量，
/// 同 `rpc::SLOW_RPC_LOG_MS` 的先例 —— 改一处必须改另一处。
///
/// 为什么需要这个数：端点一慢（自建 4B 模型实测 **34–44s/请求，且服务端完全串行**），
/// 「每轮召回打一个注定被放弃的请求」就不只是白等 —— 调用方 after 10s 放弃等待，
/// 但那次 HTTP 仍在端点队列里排队，下一轮再排一条，队列永不排空，最后**所有**交互查询
/// 一起饿死（现场：`codebase.search 超时` 把整轮发送打挂）。
///
/// 所以交互查询要在**发请求之前**判断值不值得发，而不是靠调用方的 withTimeout 掐等待者。
pub const INTERACTIVE_EMBED_BUDGET_MS: u64 = 10_000;

/// 最近一次成功往返的 `(端点+模型键, 毫秒, 记录时刻)`：交互闸门据此判断「现在还值得发吗」。
///
/// 记什么：**成功**（端点是快的）与**超时**（端点是慢的，有证据）。别的失败（连接被拒 / 401 /
/// 解析失败）不记 —— 一次快速失败既不能证明端点变快了，也不能证明它变慢了。
///
/// 为什么要记超时：以前只记成功，于是「端点 TCP 通但永不返回」这种情况永远关不上闸门 ——
/// 每轮召回都重新发一次、等满客户端超时（真机现场：`memory.long_recall` 连续两次
/// 120008ms 超时，整轮 prep 被打挂）。
///
/// 关闸有时间上限（[`EMBED_GATE_TTL_MS`]）：测量过期就允许再探一次，否则端点恢复后
/// 语义通道会一直关到进程重启。
static LAST_ROUNDTRIP: Mutex<Option<(String, u64, Instant)>> = Mutex::new(None);

/// 关闸测量的有效期：过期后允许一次探测（探成功就重新开闸）。
const EMBED_GATE_TTL_MS: u64 = 5 * 60 * 1000;

fn record_roundtrip(cfg: &EmbeddingConfig, ms: u64) {
    let key = cfg.cache_key();
    if let Ok(mut guard) = LAST_ROUNDTRIP.lock() {
        *guard = Some((key, ms, Instant::now()));
    }
    if ms > INTERACTIVE_EMBED_BUDGET_MS {
        // 一行一次（每次真跑满了才会打），足够回答「为什么这几轮召回没走语义通道」
        eprintln!(
            "[embed] 端点往返 {ms}ms > 交互预算 {budget}ms：交互查询自本轮起跳过语义通道，后台写入照旧",
            budget = INTERACTIVE_EMBED_BUDGET_MS
        );
    }
}

/// 端点已知比交互预算慢时返回实测值。换了端点/模型（`cache_key` 变了）或测量过期就重新量。
fn slow_roundtrip_ms(cfg: &EmbeddingConfig) -> Option<u64> {
    let guard = LAST_ROUNDTRIP.lock().ok()?;
    let (key, ms, at) = guard.as_ref()?;
    if *key != cfg.cache_key() || *ms <= INTERACTIVE_EMBED_BUDGET_MS {
        return None;
    }
    if at.elapsed().as_millis() as u64 >= EMBED_GATE_TTL_MS {
        return None;
    }
    Some(*ms)
}

/// 这个错误码表示「端点太慢，本次**没有发**请求」——调用方应当走既有的关键词 / 子串通道。
const EMBEDDING_TOO_SLOW: &str = "EMBEDDING_TOO_SLOW";

pub fn is_too_slow(err: &CoreError) -> bool {
    // 端点没在预算内回话（超时）与「预判太慢直接不发」对调用方是同一件事：
    // 语义通道这次拿不到，关键词/子串照常可用。
    matches!(err, CoreError::Rpc { code, .. } if *code == EMBEDDING_TOO_SLOW || *code == remote::EMBEDDING_TIMEOUT_CODE)
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

/// 向量召回的相似度下限：余弦相似度低于它（含等于）的命中直接丢弃。
///
/// **唯一来源**：代码索引的向量池扫描（`index/vector_pool.rs`）与长记忆的语义召回
/// （`memory/mod.rs`）都用这一个数。此前两处各写一份 `0.05`，改一处漏一处就会出现
/// 「代码索引收紧了、记忆召回还放得很松」，而且从现象上只能看出「召回变多变少」。
pub const MIN_SIMILARITY: f64 = 0.05;

pub async fn embed_texts(cfg: &EmbeddingConfig, inputs: &[String]) -> Result<Vec<Vec<f32>>, CoreError> {
    embed_texts_with_timeout(cfg, inputs, remote::EMBED_REQUEST_TIMEOUT_MS).await
}

/// 一次真正的远端往返（唯一实现）。`timeout_ms` 由调用方决定：
/// 后台路径用 [`remote::EMBED_REQUEST_TIMEOUT_MS`]（等得起），交互路径用
/// [`INTERACTIVE_EMBED_BUDGET_MS`]（预算是硬上限，不是只用来「预判要不要发」）。
async fn embed_texts_with_timeout(
    cfg: &EmbeddingConfig,
    inputs: &[String],
    timeout_ms: u64,
) -> Result<Vec<Vec<f32>>, CoreError> {
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
    let started = Instant::now();
    let out = remote::embed_remote(cfg, &prepared, timeout_ms).await;
    // 成功与超时都算「量到了端点有多快」：超时是端点慢的**证据**，不记就会每轮重发、每次等满超时。
    let worth_recording =
        counts_as_query_latency(prepared.len()) && (out.is_ok() || matches!(&out, Err(e) if remote::is_timeout_error(e)));
    if worth_recording {
        record_roundtrip(cfg, started.elapsed().as_millis() as u64);
    }
    out
}

/// 这次往返能不能当「查询延迟」用：**只有单条请求**够格。
///
/// 批量请求（建库、归纳补齐向量）一次塞几十条，耗时天然长几倍。拿批量耗时判
/// 「交互查询值不值得发」，会让一次后台建库把健康端点误判成慢端点，白白关掉语义召回。
fn counts_as_query_latency(inputs: usize) -> bool {
    inputs == 1
}

/// 交互式查询专用入口：端点最近一次往返已超过 [`INTERACTIVE_EMBED_BUDGET_MS`] 时
/// **不发请求**，直接回 [`EMBEDDING_TOO_SLOW`]（`is_too_slow` 判定），
/// 让调用方走它本来就有的关键词 / 子串通道。
///
/// 后台路径（建库、归纳写入、手工重建向量）继续用 [`embed_texts`] —— 它们等得起，
/// 而且它们的向量是「以后每轮召回/检索都要用」的资产，不能被这个闸门挡掉。
pub async fn embed_texts_interactive(
    cfg: &EmbeddingConfig,
    inputs: &[String],
) -> Result<Vec<Vec<f32>>, CoreError> {
    if let Some(ms) = slow_roundtrip_ms(cfg) {
        return Err(CoreError::rpc(
            EMBEDDING_TOO_SLOW,
            format!(
                "embedding 端点最近一次往返 {ms}ms，超过交互预算 {budget}ms：本次跳过语义通道（关键词/子串照常可用）",
                budget = INTERACTIVE_EMBED_BUDGET_MS
            ),
        ));
    }
    embed_texts_with_timeout(cfg, inputs, INTERACTIVE_EMBED_BUDGET_MS).await
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
    // 批量席位先占、再进全进程闸门：这样建库永远占不满全部名额，
    // 交互式单条查询（memory.long_recall 的查询向量）不会被几百个批次请求堵在后面。
    let _batch_permit = embed_batch_inflight()
        .acquire()
        .await
        .map_err(|_| CoreError::rpc("EMBEDDING_HTTP", "embedding 批量闸门已关闭"))?;
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

    /// 批量席位必须比全进程闸门少 1：少掉的那个是留给交互式单条查询（memory.long_recall）
    /// 的常驻名额，否则建库期间查询向量会排在几百个批次请求后面（实测 131s~438s）。
    #[test]
    fn batch_gate_reserves_one_slot_for_interactive_queries() {
        assert!(EMBED_CONCURRENCY > 1);
        assert_eq!(
            embed_batch_inflight().available_permits(),
            EMBED_CONCURRENCY - 1
        );
        assert_eq!(embed_inflight().available_permits(), EMBED_CONCURRENCY);
    }

    fn cfg_of(base_url: &str, model: &str) -> EmbeddingConfig {
        EmbeddingConfig {
            base_url: base_url.to_string(),
            model: model.to_string(),
            ..Default::default()
        }
    }

    /// 闸门状态是进程级静态量：断言它的用例必须串行，否则彼此把对方的测量覆盖掉。
    /// （曾经并行跑时 `interactive_gate_*` 偶发拿到 None，是这个原因，不是逻辑错。）
    static GATE_TEST_LOCK: Mutex<()> = Mutex::new(());

    /// 交互闸门的三条不变量：没量过要放行（第一条必须有机会量出速度）、
    /// 恰好等于预算不算慢（预算是「能接受」的上限）、换了端点必须重新量。
    #[test]
    fn interactive_gate_opens_until_measured_and_trips_above_budget() {
        let _guard = GATE_TEST_LOCK.lock();
        let a = cfg_of("http://gate-test-a.local/v1", "gate-model");
        assert_eq!(slow_roundtrip_ms(&a), None, "没量过 → 允许");
        record_roundtrip(&a, INTERACTIVE_EMBED_BUDGET_MS);
        assert_eq!(slow_roundtrip_ms(&a), None, "等于预算不算慢");
        record_roundtrip(&a, INTERACTIVE_EMBED_BUDGET_MS + 1);
        assert_eq!(
            slow_roundtrip_ms(&a),
            Some(INTERACTIVE_EMBED_BUDGET_MS + 1),
            "超过预算 → 交互查询不再发请求"
        );
        let b = cfg_of("http://gate-test-b.local/v1", "gate-model");
        assert_eq!(slow_roundtrip_ms(&b), None, "换端点要重新量，不能被连坐");
    }

    /// 关闸不能是永久的：测量过期要能再探一次，否则端点恢复后语义通道一直关到进程重启
    /// （现场：端点挂死 → 关闸 → 用户把服务修好，召回却再也不走语义）。
    #[test]
    fn gate_reopens_after_ttl() {
        let _guard = GATE_TEST_LOCK.lock();
        let a = cfg_of("http://gate-ttl.local/v1", "ttl-model");
        record_roundtrip(&a, INTERACTIVE_EMBED_BUDGET_MS + 1);
        assert!(slow_roundtrip_ms(&a).is_some(), "刚测到慢 → 关闸");
        if let Ok(mut guard) = LAST_ROUNDTRIP.lock() {
            let key = a.cache_key();
            *guard = Some((
                key,
                INTERACTIVE_EMBED_BUDGET_MS + 1,
                Instant::now() - std::time::Duration::from_millis(EMBED_GATE_TTL_MS + 1),
            ));
        }
        assert_eq!(slow_roundtrip_ms(&a), None, "测量过期 → 允许再探一次");
    }

    #[test]
    fn too_slow_predicate_only_matches_the_gate_code() {
        assert!(is_too_slow(&CoreError::rpc(
            EMBEDDING_TOO_SLOW,
            "x".to_string()
        )));
        // 端点没在预算内回话 = 语义通道这次拿不到，和「预判太慢不发」对调用方是同一件事
        assert!(is_too_slow(&CoreError::rpc(
            remote::EMBEDDING_TIMEOUT_CODE,
            "x".to_string()
        )));
        // 端点报了错（401/解析失败）不算「太慢」：不能据此关闸，也不能静默降级
        assert!(!is_too_slow(&CoreError::rpc(
            "EMBEDDING_API",
            "x".to_string()
        )));
        assert!(!is_too_slow(&CoreError::rpc(
            "EMBEDDING_HTTP",
            "x".to_string()
        )));
    }

    /// 只有单条请求的往返能当「查询延迟」：批量耗时天然长几倍，拿它判慢会把
    /// 健康端点误伤（一次后台建库就能把语义召回关掉）。
    #[test]
    fn only_single_input_roundtrips_count_as_query_latency() {
        assert!(counts_as_query_latency(1));
        assert!(!counts_as_query_latency(0));
        assert!(!counts_as_query_latency(2));
        assert!(!counts_as_query_latency(EMBED_BATCH_MAX_INPUTS));
    }
}

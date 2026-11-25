use serde::Deserialize;
use serde_json::Value;

use crate::error::CoreError;

use super::EmbeddingConfig;

fn resolve_embeddings_url(base_url: &str) -> String {
    let raw = base_url.trim().trim_end_matches('/');
    if raw.is_empty() {
        return String::new();
    }
    let lower = raw.to_ascii_lowercase();
    if lower.ends_with("/embeddings") || lower.ends_with("/embed") {
        return raw.to_string();
    }
    if lower.ends_with("/v1") {
        return format!("{raw}/embeddings");
    }
    format!("{raw}/v1/embeddings")
}

fn is_direct_embed_url(base_url: &str) -> bool {
    base_url
        .trim()
        .trim_end_matches('/')
        .to_ascii_lowercase()
        .ends_with("/embed")
}

/// **批量/后台** embedding 请求的墙钟上限（建库 / 批量归纳写入 / 手工重建向量都等得起）。
///
/// 交互查询**不**用这个数（用 [`EMBED_QUERY_TIMEOUT_MS`]）：两者共用一个 120s 时，
/// 「端点挂住」会直接表现为「每轮对话先卡两分钟」，而且卡完还拿不到东西。
pub const EMBED_REQUEST_TIMEOUT_MS: u64 = 120_000;

/// 交互查询（`embedding.query` / 记忆语义召回）的墙钟上限。
///
/// 10s：一次召回超过它的意义已经低于「先用关键词/FTS 通道回答」，而它与 `rpc` 的
/// Fast 预算同量级 —— 让查询侧先于宿主超时自己失败、并留下可读的原因。
pub const EMBED_QUERY_TIMEOUT_MS: u64 = 10_000;

/// `reqwest` 的「超时」单独一个码：调用方据此判定「端点没回」而不是「端点报错」。
///
/// 消费方是 [`crate::embedding::embed_query`]：命中它就连同超时值记一行 `[rpc-degraded]`，
/// 语义通道跳过、关键词/FTS 接管 —— 以前这个码没有任何读者（等于「有码无义」）。
pub const EMBEDDING_TIMEOUT_CODE: &str = "EMBEDDING_TIMEOUT";

pub async fn embed_remote(
    cfg: &EmbeddingConfig,
    inputs: &[String],
    timeout_ms: u64,
) -> Result<Vec<Vec<f32>>, CoreError> {
    if inputs.is_empty() {
        return Ok(Vec::new());
    }

    let url = resolve_embeddings_url(&cfg.base_url);
    let direct = is_direct_embed_url(&cfg.base_url);
    let body = if direct {
        serde_json::json!({
            "texts": inputs,
            "model": cfg.model,
            "dimensions": cfg.dimensions
        })
    } else if inputs.len() == 1 {
        serde_json::json!({
            "model": cfg.model,
            "input": inputs[0],
            "dimensions": cfg.dimensions
        })
    } else {
        serde_json::json!({
            "model": cfg.model,
            "input": inputs,
            "dimensions": cfg.dimensions
        })
    };

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_millis(timeout_ms.max(1)))
        .build()
        .map_err(|e| CoreError::rpc("EMBEDDING_HTTP", e.to_string()))?;

    // 请求头单一来源：Node 侧 llm-request.js 装配后经 EmbeddingConfig.headers 传入
    let mut req = client.post(&url);
    req = crate::config::apply_llm_headers(req, &cfg.headers, &cfg.api_key, &cfg.auth_mode);

    let resp = req.json(&body).send().await.map_err(|e| {
        if e.is_timeout() {
            CoreError::rpc(
                EMBEDDING_TIMEOUT_CODE,
                format!("端点 {timeout_ms}ms 内没有响应：{e}"),
            )
        } else {
            CoreError::rpc("EMBEDDING_HTTP", e.to_string())
        }
    })?;

    let status = resp.status();
    let raw = resp.text().await.map_err(|e| {
        if e.is_timeout() {
            CoreError::rpc(
                EMBEDDING_TIMEOUT_CODE,
                format!("端点 {timeout_ms}ms 内没有返回完响应体：{e}"),
            )
        } else {
            CoreError::rpc("EMBEDDING_HTTP", e.to_string())
        }
    })?;

    // 错误体可能是任意 UTF-8（反代的 502 页面、中文报错）：按**字符**截断。
    // 按字节切会在多字节字符中间切断，直接 panic（`&raw[..200]` 曾如此）。
    let body_preview: String = raw.chars().take(200).collect();

    let json: Value = serde_json::from_str(&raw).map_err(|e| {
        CoreError::rpc("EMBEDDING_PARSE", format!("{e}; body={body_preview}"))
    })?;

    if !status.is_success() || json.get("error").is_some() {
        let msg = json
            .pointer("/error/message")
            .and_then(|v| v.as_str())
            .or_else(|| json.get("message").and_then(|v| v.as_str()))
            .unwrap_or(&body_preview);
        return Err(CoreError::rpc("EMBEDDING_API", msg.to_string()));
    }

    // 条数校验收到**唯一解析点**：`data` 的行数必须等于请求条数，
    // 少一条就说明回包被截断/被中转合并 —— 那样按位置对上去会把向量贴到错的文本上。
    let vectors = parse_embedding_vectors(&json, Some(inputs.len()))?;
    // 校验「实际生效维度」而不是配置字段：判定用 `effective_dimensions()`，与落库
    // （向量长度）/ 索引元数据（签名）同一口径。这里的 provider 只可能是远端，两者数值
    // 相同，但**口径**必须只有一处 —— 将来远端也允许回落本地时，这一行不用再改一遍。
    let expected = cfg.effective_dimensions() as usize;
    if expected > 0 {
        for vec in &vectors {
            if vec.len() != expected {
                return Err(CoreError::rpc(
                    "EMBEDDING_DIMENSIONS",
                    format!("Embedding dimensions mismatch: expected {expected}, got {}", vec.len()),
                ));
            }
        }
    }
    Ok(vectors)
}

#[derive(Deserialize)]
struct EmbedRow {
    embedding: Option<Vec<f64>>,
    index: Option<u32>,
}

/// 解析回包里的向量，`expected` 是请求条数（`None` = 调用方不关心）。
///
/// **这是条数校验的唯一位置**：少一条多一条都在这里报 `EMBEDDING_PARSE`，
/// 不靠调用点各查一次（远端回包被截断时按位置贴向量会把语义写错，而且不报错）。
fn parse_embedding_vectors(
    json: &Value,
    expected: Option<usize>,
) -> Result<Vec<Vec<f32>>, CoreError> {
    let out = parse_embedding_vectors_inner(json)?;
    if let Some(want) = expected {
        if out.len() != want {
            return Err(CoreError::rpc(
                "EMBEDDING_PARSE",
                format!("期望 {want} 条向量，收到 {}", out.len()),
            ));
        }
    }
    Ok(out)
}

fn parse_embedding_vectors_inner(json: &Value) -> Result<Vec<Vec<f32>>, CoreError> {
    if let Some(rows) = json.get("data").and_then(|v| v.as_array()) {
        let mut parsed: Vec<(u32, Vec<f32>)> = Vec::new();
        for (pos, row) in rows.iter().enumerate() {
            let item: EmbedRow = serde_json::from_value(row.clone())
                .map_err(|e| CoreError::rpc("EMBEDDING_PARSE", e.to_string()))?;
            if let Some(vec) = item.embedding {
                // 缺 `index` 时用**该行在 data 里的位置**兜底（不是「已解析条数」）：
                // 后者在有行被跳过时会写出错误下标、与真实 index 撞号。
                parsed.push((item.index.unwrap_or(pos as u32), to_f32_vec(vec)?));
            }
        }
        parsed.sort_by_key(|(idx, _)| *idx);
        return Ok(parsed.into_iter().map(|(_, v)| v).collect());
    }

    if let Some(rows) = json.get("embeddings").and_then(|v| v.as_array()) {
        let mut out = Vec::new();
        for row in rows {
            if let Some(vec) = row.as_array() {
                out.push(to_f32_vec(
                    vec.iter().filter_map(|v| v.as_f64()).collect::<Vec<_>>(),
                )?);
            }
        }
        if !out.is_empty() {
            return Ok(out);
        }
    }

    if let Some(vec) = json.get("embedding").and_then(|v| v.as_array()) {
        return Ok(vec![to_f32_vec(
            vec.iter().filter_map(|v| v.as_f64()).collect(),
        )?]);
    }

    if let Some(vec) = json.get("vector").and_then(|v| v.as_array()) {
        return Ok(vec![to_f32_vec(
            vec.iter().filter_map(|v| v.as_f64()).collect(),
        )?]);
    }

    Err(CoreError::rpc("EMBEDDING_PARSE", "Embedding 向量为空"))
}

fn to_f32_vec(values: Vec<f64>) -> Result<Vec<f32>, CoreError> {
    if values.is_empty() {
        return Err(CoreError::rpc("EMBEDDING_PARSE", "Embedding 向量为空"));
    }
    Ok(values.into_iter().map(|v| v as f32).collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// 全带 `index` 且乱序 → 按 index 排回去（否则向量会贴到别的文本上）。
    #[test]
    fn out_of_order_index_is_sorted_back() {
        let body = json!({"data": [
            {"index": 1, "embedding": [2.0]},
            {"index": 0, "embedding": [1.0]}
        ]});
        let vectors = parse_embedding_vectors(&body, Some(2)).unwrap();
        assert_eq!(vectors, vec![vec![1.0f32], vec![2.0f32]]);
    }

    /// 部分行缺 `index`：一条都不许丢（旧的「已解析条数」兜底在有行被跳过时会撞号）。
    #[test]
    fn rows_without_index_are_not_dropped() {
        let body = json!({"data": [
            {"embedding": [1.0]},
            {"embedding": [2.0]},
            {"index": 5, "embedding": [3.0]}
        ]});
        let vectors = parse_embedding_vectors(&body, Some(3)).unwrap();
        assert_eq!(vectors.len(), 3);
        assert_eq!(vectors[2], vec![3.0f32], "显式 index 最大的一条排最后");
    }

    /// 条数不符必须报错：少一条时按位置对上去会把语义写错，而且不报错。
    #[test]
    fn count_mismatch_is_rejected() {
        let body = json!({"data": [{"index": 0, "embedding": [1.0]}]});
        let err = parse_embedding_vectors(&body, Some(3)).unwrap_err();
        assert_eq!(err.code(), "EMBEDDING_PARSE");
        assert!(err.to_string().contains("期望 3 条"), "{err}");
    }

    /// 查询超时必须显著短于批量超时：否则端点挂住时每轮召回先卡两分钟。
    ///
    /// 「不能超过宿主 status 超时」那一半读的是**共享常量**
    /// （`src/agent/agent-shared.json#rpc.hostStatusTimeoutMs`，Node 侧同一份）：
    /// 以前这里手抄 `15_000`，宿主把它调小时这条断言仍绿 —— 等于没有闸门。
    #[test]
    fn query_timeout_is_much_shorter_than_batch_timeout() {
        const _: () = assert!(EMBED_QUERY_TIMEOUT_MS < EMBED_REQUEST_TIMEOUT_MS);
        let host_min_ms = crate::shared::shared().rpc.host_status_timeout_ms;
        assert!(
            EMBED_QUERY_TIMEOUT_MS <= host_min_ms,
            "查询超时 {EMBED_QUERY_TIMEOUT_MS}ms 要落在「宿主先超时」的同量级（{host_min_ms}ms）"
        );
    }
}

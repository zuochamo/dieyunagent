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

/// 后台 embedding 请求的墙钟上限（建库 / 归纳写入 / 手工重建向量都等得起）。
///
/// **交互式与后台用同一个数**：`INTERACTIVE_EMBED_BUDGET_MS` + `EMBEDDING_TOO_SLOW` 那套
/// 「预判太慢就不发」的三层补偿已经整体删除（见 `embedding/mod.rs` 顶部），留下的是
/// 传输层必需的超时本身。端点挂死时每轮召回要等满这个数 —— 这是已知代价，不再另设闸门。
pub const EMBED_REQUEST_TIMEOUT_MS: u64 = 120_000;

/// `reqwest` 的「超时」单独一个码：调用方据此判定「端点没回」而不是「端点报错」，
/// 交互闸门也只在超时（有证据证明它慢）时关闸，401 / 解析失败不关。
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

    let vectors = parse_embedding_vectors(&json)?;
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

fn parse_embedding_vectors(json: &Value) -> Result<Vec<Vec<f32>>, CoreError> {
    if let Some(rows) = json.get("data").and_then(|v| v.as_array()) {
        let mut parsed: Vec<(u32, Vec<f32>)> = Vec::new();
        for row in rows {
            let item: EmbedRow = serde_json::from_value(row.clone())
                .map_err(|e| CoreError::rpc("EMBEDDING_PARSE", e.to_string()))?;
            if let Some(vec) = item.embedding {
                parsed.push((item.index.unwrap_or(parsed.len() as u32), to_f32_vec(vec)?));
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

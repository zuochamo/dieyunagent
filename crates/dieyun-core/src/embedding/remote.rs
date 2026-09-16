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

pub async fn embed_remote(
    cfg: &EmbeddingConfig,
    inputs: &[String],
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
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .map_err(|e| CoreError::rpc("EMBEDDING_HTTP", e.to_string()))?;

    let mut req = client.post(&url).header("Content-Type", "application/json");
    if !cfg.api_key.trim().is_empty() {
        req = req.header("Authorization", format!("Bearer {}", cfg.api_key.trim()));
    }

    let resp = req
        .json(&body)
        .send()
        .await
        .map_err(|e| CoreError::rpc("EMBEDDING_HTTP", e.to_string()))?;

    let status = resp.status();
    let raw = resp
        .text()
        .await
        .map_err(|e| CoreError::rpc("EMBEDDING_HTTP", e.to_string()))?;

    let json: Value = serde_json::from_str(&raw).map_err(|e| {
        CoreError::rpc(
            "EMBEDDING_PARSE",
            format!("{e}; body={}", &raw[..raw.len().min(200)]),
        )
    })?;

    if !status.is_success() || json.get("error").is_some() {
        let msg = json
            .pointer("/error/message")
            .and_then(|v| v.as_str())
            .or_else(|| json.get("message").and_then(|v| v.as_str()))
            .unwrap_or(&raw);
        return Err(CoreError::rpc("EMBEDDING_API", msg.to_string()));
    }

    let vectors = parse_embedding_vectors(&json)?;
    let expected = cfg.dimensions as usize;
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

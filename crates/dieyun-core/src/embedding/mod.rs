mod ann;
mod builtin;
mod remote;

pub use ann::{
    exact_scan_threshold, query_seed, sample_modulus_for, vector_bytes,
    VECTOR_ANN_SAMPLE_MAX_BYTES, VECTOR_EXACT_MAX_BYTES,
};

use std::path::PathBuf;
use std::sync::OnceLock;

use tokio::sync::Mutex;

pub use builtin::{
    resolve_builtin_model_dir, BUILTIN_DIMENSIONS, BUILTIN_EMBEDDING_ID, BUILTIN_MODEL_NAME,
};

use crate::error::CoreError;

pub const EMBED_BATCH_SIZE: usize = 8;
const EMBED_TEXT_MAX_CHARS: usize = 6000;

static EMBED_SERIAL: OnceLock<Mutex<()>> = OnceLock::new();

fn embed_serial() -> &'static Mutex<()> {
    EMBED_SERIAL.get_or_init(|| Mutex::new(()))
}

#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EmbeddingConfig {
    #[serde(default)]
    pub disabled: bool,
    #[serde(default)]
    pub builtin: bool,
    #[serde(default)]
    pub base_url: String,
    #[serde(default)]
    pub api_key: String,
    #[serde(default)]
    pub model: String,
    #[serde(default = "default_dimensions")]
    pub dimensions: u32,
}

fn default_dimensions() -> u32 {
    1024
}

impl EmbeddingConfig {
    pub fn enabled(&self, models_dirs: &[PathBuf]) -> bool {
        if self.disabled {
            return false;
        }
        if self.builtin {
            if !cfg!(feature = "builtin-ort") {
                return false;
            }
            return resolve_builtin_model_dir(models_dirs).is_some();
        }
        !self.model.trim().is_empty() && !self.base_url.trim().is_empty()
    }

    pub fn signature(&self, models_dirs: &[PathBuf]) -> String {
        if self.disabled {
            return String::new();
        }
        if self.builtin {
            if resolve_builtin_model_dir(models_dirs).is_none() {
                return String::new();
            }
            return format!("{BUILTIN_EMBEDDING_ID}@{BUILTIN_DIMENSIONS}");
        }
        if self.model.trim().is_empty() || self.base_url.trim().is_empty() {
            return String::new();
        }
        format!("{}@{}", self.model.trim(), self.dimensions)
    }

    pub fn effective_dimensions(&self, models_dirs: &[PathBuf]) -> u32 {
        if self.builtin && resolve_builtin_model_dir(models_dirs).is_some() {
            BUILTIN_DIMENSIONS
        } else {
            self.dimensions
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

pub async fn embed_texts(
    cfg: &EmbeddingConfig,
    models_dirs: &[PathBuf],
    inputs: &[String],
) -> Result<Vec<Vec<f32>>, CoreError> {
    if !cfg.enabled(models_dirs) {
        return Err(CoreError::rpc(
            "EMBEDDING_DISABLED",
            "未配置 Embedding 模型",
        ));
    }
    if inputs.is_empty() {
        return Ok(Vec::new());
    }
    let _slot = embed_serial().lock().await;
    embed_texts_nowait(cfg, models_dirs, inputs).await
}

async fn embed_texts_nowait(
    cfg: &EmbeddingConfig,
    models_dirs: &[PathBuf],
    inputs: &[String],
) -> Result<Vec<Vec<f32>>, CoreError> {
    let prepared: Vec<String> = inputs
        .iter()
        .map(|text| truncate_embed_text(text))
        .collect();
    if cfg.builtin {
        let dirs = models_dirs.to_vec();
        return tokio::task::spawn_blocking(move || builtin::embed_builtin(&dirs, &prepared))
            .await
            .map_err(|e| CoreError::rpc("EMBEDDING_BUILTIN", e.to_string()))?;
    }
    remote::embed_remote(cfg, &prepared).await
}

pub async fn embed_batches(
    cfg: &EmbeddingConfig,
    models_dirs: &[PathBuf],
    pending: &[(i64, String)],
) -> Result<Vec<(i64, Vec<f32>)>, CoreError> {
    let mut out = Vec::with_capacity(pending.len());
    for batch in pending.chunks(EMBED_BATCH_SIZE) {
        let texts: Vec<String> = batch
            .iter()
            .map(|(_, text)| truncate_embed_text(text))
            .collect();
        let vectors = embed_texts(cfg, models_dirs, &texts).await?;
        if vectors.len() != batch.len() {
            return Err(CoreError::rpc(
                "EMBEDDING_PARSE",
                format!("期望 {} 条向量，收到 {}", batch.len(), vectors.len()),
            ));
        }
        for (i, vec) in vectors.into_iter().enumerate() {
            out.push((batch[i].0, vec));
        }
    }
    Ok(out)
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

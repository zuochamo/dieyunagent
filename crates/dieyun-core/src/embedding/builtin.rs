use std::path::{Path, PathBuf};
#[cfg(feature = "builtin-ort")]
use std::sync::{Arc, Mutex, OnceLock};

use crate::error::CoreError;

pub const BUILTIN_EMBEDDING_ID: &str = "builtin:bge-base-zh-v1.5";
pub const BUILTIN_MODEL_NAME: &str = "bge-base-zh-v1.5";
pub const BUILTIN_DIMENSIONS: u32 = 768;

pub fn resolve_builtin_model_dir(models_dirs: &[PathBuf]) -> Option<PathBuf> {
    for base in models_dirs {
        let candidates = [base.join(BUILTIN_MODEL_NAME), base.clone()];
        for dir in candidates {
            if onnx_path(&dir).is_some() && dir.join("tokenizer.json").is_file() {
                return Some(dir);
            }
        }
    }
    None
}

fn onnx_path(model_dir: &Path) -> Option<PathBuf> {
    let quantized = model_dir.join("onnx").join("model_quantized.onnx");
    if quantized.is_file() {
        return Some(quantized);
    }
    let plain = model_dir.join("onnx").join("model.onnx");
    if plain.is_file() {
        return Some(plain);
    }
    None
}

#[cfg(not(feature = "builtin-ort"))]
pub fn embed_builtin(
    _models_dirs: &[PathBuf],
    _inputs: &[String],
) -> Result<Vec<Vec<f32>>, CoreError> {
    Err(CoreError::rpc(
        "BUILTIN_ONNX",
        "此 dieyun-core 未编入内置 ONNX，请改用远程 Embedding 或在本机 sidecar 上启用 builtin-ort",
    ))
}

#[cfg(feature = "builtin-ort")]
mod ort_backend {
    use super::*;
    use ndarray::{Array2, Array3, Axis};
    use ort::session::Session;
    use ort::value::TensorRef;
    use tokenizers::Tokenizer;

    const MAX_TOKENS: usize = 512;

    static BUILTIN_CACHE: OnceLock<Mutex<Option<(PathBuf, Arc<BuiltinEmbedder>)>>> = OnceLock::new();

struct BuiltinEmbedder {
    session: Mutex<Session>,
    tokenizer: Tokenizer,
}

impl BuiltinEmbedder {
    fn load(model_dir: &Path) -> Result<Self, CoreError> {
        let onnx = onnx_path(model_dir).ok_or_else(|| {
            CoreError::rpc(
                "BUILTIN_MODEL_MISSING",
                format!("内置向量模型文件缺失：{BUILTIN_MODEL_NAME}"),
            )
        })?;
        let tokenizer_path = model_dir.join("tokenizer.json");
        let tokenizer = Tokenizer::from_file(&tokenizer_path).map_err(|e| {
            CoreError::rpc("BUILTIN_TOKENIZER", format!("加载 tokenizer 失败: {e}"))
        })?;
        let mut builder =
            Session::builder().map_err(|e| CoreError::rpc("BUILTIN_ONNX", e.to_string()))?;
        let session = builder
            .commit_from_file(&onnx)
            .map_err(|e| CoreError::rpc("BUILTIN_ONNX", e.to_string()))?;
        Ok(Self {
            session: Mutex::new(session),
            tokenizer,
        })
    }

    fn embed(&self, texts: &[String]) -> Result<Vec<Vec<f32>>, CoreError> {
        if texts.is_empty() {
            return Ok(Vec::new());
        }
        let encodings = self
            .tokenizer
            .encode_batch(texts.iter().map(|s| s.as_str()).collect::<Vec<_>>(), true)
            .map_err(|e| CoreError::rpc("BUILTIN_TOKENIZE", e.to_string()))?;

        let batch = encodings.len();
        let max_len = encodings
            .iter()
            .map(|enc| enc.get_ids().len())
            .max()
            .unwrap_or(0)
            .min(MAX_TOKENS);
        if max_len == 0 {
            return Err(CoreError::rpc("BUILTIN_TOKENIZE", "输入为空"));
        }

        let mut input_ids = vec![0i64; batch * max_len];
        let mut attention_mask = vec![0i64; batch * max_len];
        let token_type_ids = vec![0i64; batch * max_len];
        for (row, enc) in encodings.iter().enumerate() {
            let ids = enc.get_ids();
            let len = ids.len().min(max_len);
            for col in 0..len {
                let idx = row * max_len + col;
                input_ids[idx] = ids[col] as i64;
                attention_mask[idx] = 1;
            }
        }

        let ids_array = Array2::from_shape_vec((batch, max_len), input_ids)
            .map_err(|e| CoreError::rpc("BUILTIN_ONNX", e.to_string()))?;
        let mask_array = Array2::from_shape_vec((batch, max_len), attention_mask)
            .map_err(|e| CoreError::rpc("BUILTIN_ONNX", e.to_string()))?;
        let type_array = Array2::from_shape_vec((batch, max_len), token_type_ids)
            .map_err(|e| CoreError::rpc("BUILTIN_ONNX", e.to_string()))?;

        let mut session = self
            .session
            .lock()
            .map_err(|_| CoreError::rpc("BUILTIN_ONNX", "session lock poisoned"))?;

        let outputs = session
            .run(ort::inputs![
                "input_ids" => TensorRef::from_array_view(ids_array.view())
                    .map_err(|e| CoreError::rpc("BUILTIN_ONNX", e.to_string()))?,
                "attention_mask" => TensorRef::from_array_view(mask_array.view())
                    .map_err(|e| CoreError::rpc("BUILTIN_ONNX", e.to_string()))?,
                "token_type_ids" => TensorRef::from_array_view(type_array.view())
                    .map_err(|e| CoreError::rpc("BUILTIN_ONNX", e.to_string()))?,
            ])
            .map_err(|e| CoreError::rpc("BUILTIN_ONNX", e.to_string()))?;

        let hidden = extract_hidden_state(&outputs)?;
        let pooled = mean_pool(&hidden, &mask_array);
        Ok(l2_normalize_rows(pooled))
    }
}

fn extract_hidden_state(
    outputs: &ort::session::SessionOutputs<'_>,
) -> Result<Array3<f32>, CoreError> {
    if let Some(value) = outputs.get("last_hidden_state") {
        return tensor_to_array3(value.view());
    }
    if let Some((_, value)) = outputs.iter().next() {
        return tensor_to_array3(value.view());
    }
    Err(CoreError::rpc("BUILTIN_ONNX", "模型未返回 hidden state"))
}

fn tensor_to_array3(value: ort::value::ValueRef<'_>) -> Result<Array3<f32>, CoreError> {
    let (shape, data) = value
        .try_extract_tensor::<f32>()
        .map_err(|e| CoreError::rpc("BUILTIN_ONNX", e.to_string()))?;
    if shape.len() != 3 {
        return Err(CoreError::rpc(
            "BUILTIN_ONNX",
            format!("期望 3 维输出，收到 {} 维", shape.len()),
        ));
    }
    let batch = shape[0] as usize;
    let seq = shape[1] as usize;
    let dim = shape[2] as usize;
    Array3::from_shape_vec((batch, seq, dim), data.to_vec())
        .map_err(|e| CoreError::rpc("BUILTIN_ONNX", e.to_string()))
}

fn mean_pool(hidden: &Array3<f32>, attention_mask: &Array2<i64>) -> Array2<f32> {
    let batch = hidden.shape()[0];
    let seq = hidden.shape()[1];
    let dim = hidden.shape()[2];
    let mut out = Array2::<f32>::zeros((batch, dim));
    for b in 0..batch {
        let mut count = 0.0f32;
        for s in 0..seq {
            if attention_mask[[b, s]] == 0 {
                continue;
            }
            count += 1.0;
            for d in 0..dim {
                out[[b, d]] += hidden[[b, s, d]];
            }
        }
        if count > 0.0 {
            out.row_mut(b).mapv_inplace(|v| v / count);
        }
    }
    out
}

fn l2_normalize_rows(matrix: Array2<f32>) -> Vec<Vec<f32>> {
    matrix
        .axis_iter(Axis(0))
        .map(|row| {
            let mut vec = row.to_vec();
            let mut norm = 0.0f32;
            for v in &vec {
                norm += v * v;
            }
            norm = norm.sqrt();
            if norm > 1e-8 {
                for v in &mut vec {
                    *v /= norm;
                }
            }
            vec
        })
        .collect()
}

fn get_embedder(model_dir: &Path) -> Result<Arc<BuiltinEmbedder>, CoreError> {
    let cache = BUILTIN_CACHE.get_or_init(|| Mutex::new(None));
    let mut guard = cache
        .lock()
        .map_err(|_| CoreError::rpc("BUILTIN_ONNX", "cache lock poisoned"))?;
    if guard
        .as_ref()
        .map(|(path, _)| path == model_dir)
        .unwrap_or(false)
    {
        return Ok(guard.as_ref().unwrap().1.clone());
    }
    let embedder = Arc::new(BuiltinEmbedder::load(model_dir)?);
    *guard = Some((model_dir.to_path_buf(), embedder.clone()));
    Ok(embedder)
}

    pub fn embed_builtin(
        models_dirs: &[PathBuf],
        inputs: &[String],
    ) -> Result<Vec<Vec<f32>>, CoreError> {
        let model_dir = resolve_builtin_model_dir(models_dirs).ok_or_else(|| {
            CoreError::rpc(
                "BUILTIN_MODEL_MISSING",
                format!("内置向量模型文件缺失：{BUILTIN_MODEL_NAME}"),
            )
        })?;
        let embedder = get_embedder(&model_dir)?;
        let mut out = Vec::with_capacity(inputs.len());
        for chunk in inputs.chunks(crate::embedding::EMBED_BATCH_SIZE) {
            let mut batch = embedder.embed(chunk)?;
            out.append(&mut batch);
        }
        Ok(out)
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        fn repo_models_dir() -> PathBuf {
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("..")
                .join("..")
                .join("models")
        }

        #[test]
        fn builtin_model_dir_exists_in_repo() {
            let dir = repo_models_dir();
            if resolve_builtin_model_dir(&[dir.clone()]).is_none() {
                eprintln!("skip: builtin model not present under {dir:?}");
                return;
            }
            let embedder = BuiltinEmbedder::load(&dir.join(BUILTIN_MODEL_NAME)).expect("load");
            let vecs = embedder
                .embed(&["hello world".to_string(), "向量检索测试".to_string()])
                .expect("embed");
            assert_eq!(vecs.len(), 2);
            assert_eq!(vecs[0].len(), BUILTIN_DIMENSIONS as usize);
            assert!(vecs[0].iter().any(|v| v.abs() > 1e-6));
        }
    }
}

#[cfg(feature = "builtin-ort")]
pub use ort_backend::embed_builtin;

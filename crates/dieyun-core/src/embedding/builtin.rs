use std::path::{Path, PathBuf};
#[cfg(feature = "builtin-ort")]
use std::sync::{Arc, Condvar, Mutex, OnceLock};

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

/// 进程内最多同时持有几个 ONNX Session。
///
/// 为什么不是一个：`Session::run` 要 `&mut self`，单 session + 单 Mutex 等于把所有
/// 向量化请求串成一条线 —— 建库时「多文件并行取向量」是假的，批与批之间还要重新抢锁。
/// 为什么不无限：ORT 每个 session 自带线程池，session 越多总线程越多，超过核数
/// 只会互相抢占。所以池容量按核数摊开，每个 session 的 intra-op 线程数同比例缩小。
const MAX_SESSIONS: usize = 4;

struct SessionPool {
    onnx: PathBuf,
    /// 池容量（`min(核数, MAX_SESSIONS)`）。
    cap: usize,
    /// 每个 session 的 intra-op 线程数（核数 / cap，至少 1）。
    intra_threads: usize,
    state: Mutex<PoolState>,
    released: Condvar,
}

#[derive(Default)]
struct PoolState {
    idle: Vec<Session>,
    /// 已加载的 session 数（含正在外面跑的）。
    live: usize,
}

impl SessionPool {
    fn new(onnx: PathBuf) -> Self {
        let cores = std::thread::available_parallelism()
            .map(|n| n.get())
            .unwrap_or(1)
            .max(1);
        let cap = cores.min(MAX_SESSIONS).max(1);
        Self {
            onnx,
            cap,
            intra_threads: (cores / cap).max(1),
            state: Mutex::new(PoolState::default()),
            released: Condvar::new(),
        }
    }

    /// 借一个 session 跑一批，跑完放回。
    fn run<T>(&self, f: impl FnOnce(&mut Session) -> Result<T, CoreError>) -> Result<T, CoreError> {
        let mut session = self.acquire()?;
        match f(&mut session) {
            Ok(value) => {
                self.release(session);
                Ok(value)
            }
            Err(err) => {
                // 不放回：出错可能是 session 级故障，放回池里等于让它复发
                // （与读池 `ReadConn::discard` 同一条原则）。
                self.drop_live();
                Err(err)
            }
        }
    }

    fn acquire(&self) -> Result<Session, CoreError> {
        let mut state = self.state.lock().map_err(poisoned)?;
        loop {
            if let Some(session) = state.idle.pop() {
                return Ok(session);
            }
            if state.live < self.cap {
                state.live += 1;
                // 建 session 要读模型文件，别持着锁做
                drop(state);
                return match create_session(&self.onnx, self.intra_threads) {
                    Ok(session) => Ok(session),
                    Err(err) => {
                        self.drop_live();
                        Err(err)
                    }
                };
            }
            // 到上限：等别人跑完放回，而不是再多开一个（与读池同一条原则）
            state = self.released.wait(state).map_err(poisoned)?;
        }
    }

    fn release(&self, session: Session) {
        if let Ok(mut state) = self.state.lock() {
            state.idle.push(session);
            self.released.notify_one();
        }
    }

    fn drop_live(&self) {
        if let Ok(mut state) = self.state.lock() {
            state.live = state.live.saturating_sub(1);
            self.released.notify_one();
        }
    }
}

fn poisoned<T>(_: T) -> CoreError {
    CoreError::rpc("BUILTIN_ONNX", "session pool lock poisoned")
}

fn create_session(onnx: &Path, intra_threads: usize) -> Result<Session, CoreError> {
    let builder = Session::builder().map_err(|e| CoreError::rpc("BUILTIN_ONNX", e.to_string()))?;
    let mut builder = builder
        .with_intra_threads(intra_threads)
        .map_err(|e| CoreError::rpc("BUILTIN_ONNX", e.to_string()))?;
    builder
        .commit_from_file(onnx)
        .map_err(|e| CoreError::rpc("BUILTIN_ONNX", e.to_string()))
}

struct BuiltinEmbedder {
    pool: SessionPool,
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
        // 预热一个 session 就够：模型加载是秒级成本，别在启动路径上建满池。
        // 其余 session 在首次并发向量化时按需创建。
        let pool = SessionPool::new(onnx);
        let first = create_session(&pool.onnx, pool.intra_threads)?;
        {
            let mut state = pool.state.lock().map_err(poisoned)?;
            state.live = 1;
        }
        pool.release(first);
        Ok(Self { pool, tokenizer })
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

        let pooled = self.pool.run(|session| {
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
            Ok(mean_pool(&hidden, &mask_array))
        })?;
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

        /// session 池的核心承诺：并发向量化与串行结果一致，超过池容量时排队而不是报错。
        #[test]
        fn concurrent_embedding_matches_sequential() {
            let dir = repo_models_dir();
            let Some(model_dir) = resolve_builtin_model_dir(&[dir]) else {
                eprintln!("skip: builtin model not present");
                return;
            };
            let embedder = Arc::new(BuiltinEmbedder::load(&model_dir).expect("load"));
            let text = "并发向量化一致性".to_string();
            let baseline = embedder.embed(&[text.clone()]).expect("baseline");

            // 线程数刻意大于池容量：让「池满排队」这条路径真的被走到。
            let threads = MAX_SESSIONS + 3;
            std::thread::scope(|scope| {
                let handles: Vec<_> = (0..threads)
                    .map(|_| {
                        let embedder = Arc::clone(&embedder);
                        let text = text.clone();
                        scope.spawn(move || embedder.embed(&[text]).expect("embed"))
                    })
                    .collect();
                for handle in handles {
                    let got = handle.join().expect("thread");
                    assert_eq!(got.len(), 1);
                    let max_diff = got[0]
                        .iter()
                        .zip(&baseline[0])
                        .map(|(a, b)| (a - b).abs())
                        .fold(0.0f32, f32::max);
                    assert!(max_diff < 1e-4, "并发结果应与串行一致，最大偏差 {max_diff}");
                }
            });
        }
    }
}

#[cfg(feature = "builtin-ort")]
pub use ort_backend::embed_builtin;

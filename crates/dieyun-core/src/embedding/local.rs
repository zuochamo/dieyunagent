//! 进程内向量推理（可选后端）：bge-base-zh-v1.5，768 维。
//!
//! # 为什么是「可选 + 运行时解析」
//!
//! 2026-08-27 的 `6386411`「slim Windows installer and make BGE an optional download」
//! 删掉了进程内 ONNX 推理，理由是**安装包体积**（模型 103MB + onnxruntime dylib）。
//! 本次恢复它时不能把那个代价重新引回来，因此两条硬约束：
//!
//! 1. `ort` 用 `load-dynamic`：构建期不下载 onnxruntime，也**不往产物目录拷 dylib**；
//! 2. 模型与 dylib 都由宿主在运行时提供（可选下载 / 手动放置），找不到就**退回远端端点**。
//!
//! 于是 `cargo build` 的产物不依赖本地推理能力的平台包。远端 Linux core 打包时用
//! `--no-default-features` 关掉 `local-embed`，glibc 下限与产物形态都不受影响。
//!
//! # 为什么池化用 CLS 而不是 mean
//!
//! BGE 系列（含 bge-base-zh-v1.5）的官方口径是 CLS + L2 归一化；被删掉的那版实现用的是
//! mean pooling。同一个模型换池化方式，向量空间就不一样了——混用会让相似度**静默变差**
//! （不报错）。所以这里跟模型口径走，并在 [`LocalProvider::signature`] 里带上 `cls`，
//! 让「库里已有向量 = 别的口径」这件事能被签名比对发现，而不是靠人记。

use std::path::{Path, PathBuf};
#[cfg(feature = "local-embed")]
use std::sync::{Arc, Condvar, Mutex, OnceLock};

use crate::error::CoreError;

/// 内置模型标识与维度：签名 / 缓存键都要用它，别在别处再写一份字面量。
pub const LOCAL_MODEL_NAME: &str = "bge-base-zh-v1.5";
pub const LOCAL_MODEL_ID: &str = "bge-base-zh-v1.5";
pub const LOCAL_DIMENSIONS: u32 = 768;


/// 本地推理的可用性结论（唯一来源）。调用方据此决定「用本地」还是「退回远端」。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Availability {
    /// 可用：模型目录已解析，且 dylib 加载成功。
    Ready { model_dir: PathBuf },
    /// 不可用 + 人话原因（写进 status / 日志，不要去猜）。
    Unavailable(String),
}

/// 编译期是否带上了本地推理。
///
/// 只给诊断用（`embedding.status` 会说清「这份 core 能不能跑本地」）。
pub fn compiled() -> bool {
    cfg!(feature = "local-embed")
}

/// 平台默认的 onnxruntime 文件名（候选扫描与提示文案共用一份）。
pub fn runtime_lib_name() -> &'static str {
    if cfg!(windows) {
        "onnxruntime.dll"
    } else if cfg!(target_os = "macos") {
        "libonnxruntime.dylib"
    } else {
        "libonnxruntime.so"
    }
}

#[cfg(not(feature = "local-embed"))]
pub mod imp {
    use super::*;
    pub fn probe(_dylib: Option<&Path>, _model_dir: Option<&Path>) -> Availability {
        Availability::Unavailable(format!(
            "此 dieyun-core 未编入本地推理（feature `local-embed` 关闭）：没有 {} 运行时，本地模型 {} 不可用",
            runtime_lib_name(),
            LOCAL_MODEL_NAME
        ))
    }
    pub fn embed(
        _model_dir: &Path,
        _dylib: Option<&Path>,
        _inputs: &[String],
    ) -> Result<Vec<Vec<f32>>, CoreError> {
        Err(CoreError::rpc(
            "EMBEDDING_LOCAL_UNAVAILABLE",
            "未编入本地推理",
        ))
    }
}

#[cfg(feature = "local-embed")]
pub mod imp {
    use super::*;
    use ndarray::{Array2, Array3};

    /// 单条文本最多进多少 token（bge 上限 512）。
    const MAX_TOKENS: usize = 512;

    /// 进程内最多同时持有几个 ONNX Session（Session::run 要 &mut self，单 session 会串成一条线；
    /// 但不无限：ORT 每个 session 自带线程池，超过核数只会互相抢占）。
    const MAX_SESSIONS: usize = 4;
    use ort::session::Session;
    use ort::value::TensorRef;
    use tokenizers::Tokenizer;

    pub fn probe(dylib: Option<&Path>, model_dir: Option<&Path>) -> Availability {
        let Some(dir) = model_dir else {
            return Availability::Unavailable(format!(
                "本地模型目录未解析到（期望 {LOCAL_MODEL_NAME}，含 onnx/*.onnx 与 tokenizer.json）"
            ));
        };
        if onnx_path(dir).is_none() {
            return Availability::Unavailable(format!("{} 下没有 onnx 模型文件", dir.display()));
        }
        if !dir.join("tokenizer.json").is_file() {
            return Availability::Unavailable(format!("{} 下没有 tokenizer.json", dir.display()));
        }
        if let Err(err) = ensure_runtime(dylib) {
            return Availability::Unavailable(format!("onnxruntime 动态库不可用：{err}"));
        }
        Availability::Ready {
            model_dir: dir.to_path_buf(),
        }
    }

    /// 加载 onnxruntime 动态库（幂等）。
    ///
    /// 顺序：显式路径（宿主下载到 userData 的那份）→ 自己扫到的候选文件。
    /// **不做「交给系统加载器去猜」**：缺库时 `ort` 的加载路径会走系统 DLL 搜索
    /// （Windows 上表现为弹缺库对话框），无界面/无人值守环境直接卡死 —— 实测过一次
    /// 整跑测试挂 30 分钟、CPU 为 0。宁可返回一句「运行时未提供」。
    ///
    /// **只缓存成功**：core 是长驻进程，而模型与 dylib 是宿主按需下载的（安装包刻意不打包）。
    /// 把失败也固化进进程级缓存，等于让「补装完之后仍然报不可用」成为终态 —— 用户只能重启
    /// core，而设置页只会显示「onnxruntime 动态库不可用」。失败一律不缓存，下次探测重试。
    pub(super) fn ensure_runtime(dylib: Option<&Path>) -> Result<(), String> {
        static LOADED: OnceLock<()> = OnceLock::new();
        ensure_runtime_cached(&LOADED, dylib, init_from)
    }

    /// 「只缓存成功」这条语义的唯一实现。
    ///
    /// `cache` / `load` 只是测试缝（用例必须能证伪「失败被固化」，又不能真去 dlopen
    /// 一个假文件 —— 那会挂住整个测试进程）；运行时永远走上面那份。
    pub(super) fn ensure_runtime_cached(
        cache: &OnceLock<()>,
        dylib: Option<&Path>,
        load: impl Fn(&Path) -> Result<(), String>,
    ) -> Result<(), String> {
        if cache.get().is_some() {
            return Ok(());
        }
        let dylib = dylib.map(Path::to_path_buf);
        match dylib {
            Some(path) if path.is_file() => load(&path)?,
            Some(path) => return Err(format!("指定的 onnxruntime 不存在：{}", path.display())),
            None => match scan_for_runtime() {
                Some(path) => load(&path)?,
                None => {
                    return Err(format!(
                        "未找到 onnxruntime 动态库（{}）：请设置 DIEYUN_ORT_LIB，或放到 <userData>/models/onnxruntime/",
                        super::runtime_lib_name()
                    ));
                }
            },
        }
        let _ = cache.set(());
        Ok(())
    }

    fn init_from(path: &Path) -> Result<(), String> {
        ort::init_from(path)
            .map_err(|e| e.to_string())
            .map(|builder| {
                builder.commit();
            })
    }

    /// 候选位置：`ORT_DYLIB_PATH` → 可执行文件同目录 → 当前目录。
    ///
    /// **刻意不扫 PATH**：PATH 里常有已断开的网络盘，`is_file()` 会在每个条目上卡住
    /// （实测整跑测试挂死、CPU 为 0）。宿主知道自己把库放哪了（`DIEYUN_ORT_LIB`），
    /// 打包产物把它放二进制旁边；这两种情况覆盖了全部真实部署。
    fn scan_for_runtime() -> Option<PathBuf> {
        let name = super::runtime_lib_name();
        let mut candidates: Vec<PathBuf> = Vec::new();
        if let Ok(explicit) = std::env::var("ORT_DYLIB_PATH") {
            if !explicit.trim().is_empty() {
                candidates.push(PathBuf::from(explicit));
            }
        }
        if let Ok(exe) = std::env::current_exe() {
            if let Some(dir) = exe.parent() {
                candidates.push(dir.join(name));
            }
        }
        if let Ok(cwd) = std::env::current_dir() {
            candidates.push(cwd.join(name));
        }
        candidates.into_iter().find(|p| p.is_file())
    }

    pub(super) fn onnx_path(model_dir: &Path) -> Option<PathBuf> {
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

    struct SessionPool {
        onnx: PathBuf,
        cap: usize,
        intra_threads: usize,
        state: Mutex<PoolState>,
        released: Condvar,
    }

    #[derive(Default)]
    struct PoolState {
        idle: Vec<Session>,
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

        fn run<T>(&self, f: impl FnOnce(&mut Session) -> Result<T, CoreError>) -> Result<T, CoreError> {
            let mut session = self.acquire()?;
            match f(&mut session) {
                Ok(value) => {
                    self.release(session);
                    Ok(value)
                }
                Err(err) => {
                    // 出错可能是 session 级故障，放回池里等于让它复发
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
                    drop(state);
                    return match create_session(&self.onnx, self.intra_threads) {
                        Ok(session) => Ok(session),
                        Err(err) => {
                            self.drop_live();
                            Err(err)
                        }
                    };
                }
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
        CoreError::rpc("EMBEDDING_LOCAL", "session pool lock poisoned")
    }

    fn create_session(onnx: &Path, intra_threads: usize) -> Result<Session, CoreError> {
        let builder = Session::builder().map_err(local_err)?;
        let mut builder = builder.with_intra_threads(intra_threads).map_err(local_err)?;
        builder.commit_from_file(onnx).map_err(local_err)
    }

    fn local_err(e: impl std::fmt::Display) -> CoreError {
        CoreError::rpc("EMBEDDING_LOCAL", e.to_string())
    }

    struct LocalEmbedder {
        pool: SessionPool,
        tokenizer: Tokenizer,
    }

    impl LocalEmbedder {
        fn load(model_dir: &Path, dylib: Option<&Path>) -> Result<Self, CoreError> {
            ensure_runtime(dylib).map_err(|e| CoreError::rpc("EMBEDDING_LOCAL", e))?;
            let onnx = onnx_path(model_dir).ok_or_else(|| {
                CoreError::rpc(
                    "EMBEDDING_LOCAL_MODEL_MISSING",
                    format!("本地向量模型缺失：{LOCAL_MODEL_NAME}"),
                )
            })?;
            let tokenizer = Tokenizer::from_file(model_dir.join("tokenizer.json"))
                .map_err(|e| CoreError::rpc("EMBEDDING_LOCAL_TOKENIZER", e.to_string()))?;
            let pool = SessionPool::new(onnx);
            // 预热一个 session 就够：模型加载是秒级成本，别在首次调用上建满池。
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
                .encode_batch(texts.iter().map(String::as_str).collect::<Vec<_>>(), true)
                .map_err(|e| CoreError::rpc("EMBEDDING_LOCAL_TOKENIZE", e.to_string()))?;
            let batch = encodings.len();
            // **固定形状**：每条都补到 512。不按批内最长补，是因为量化模型的 attention 对
            // 掩码位仍有微小数值泄漏 —— 批内最长一变，同一段文本的向量就会变（实测余弦
            // ≈0.998，绝对值差到 1e-2）。向量缓存按内容哈希键、索引与查询分两批计算，形状
            // 不一致就会让「同一段文本两个向量」，这不是噪声，是口径不唯一。
            // 代价：短文本也要跑满 512（量化 base 模型单条几十毫秒），换来确定性。
            let max_len = MAX_TOKENS;
            if encodings.iter().all(|enc| enc.get_ids().is_empty()) {
                return Err(CoreError::rpc("EMBEDDING_LOCAL_TOKENIZE", "输入为空"));
            }

            let mut input_ids = vec![0i64; batch * max_len];
            let mut attention_mask = vec![0i64; batch * max_len];
            for (row, enc) in encodings.iter().enumerate() {
                let ids = enc.get_ids();
                let len = ids.len().min(max_len);
                for col in 0..len {
                    let idx = row * max_len + col;
                    input_ids[idx] = ids[col] as i64;
                    attention_mask[idx] = 1;
                }
            }
            let ids_array = Array2::from_shape_vec((batch, max_len), input_ids).map_err(local_err)?;
            let mask_array =
                Array2::from_shape_vec((batch, max_len), attention_mask).map_err(local_err)?;
            // bge-base-zh 的 ONNX 图里 `token_type_embeddings` 是**必需输入**（全 0 即可）：
            // 少喂这一路会被 ORT 判成 `Missing Input: token_type_ids` 直接失败。
            let type_array =
                Array2::<i64>::zeros((batch, max_len));

            let pooled = self.pool.run(|session| {
                let outputs = session
                    .run(ort::inputs![
                        "input_ids" => TensorRef::from_array_view(ids_array.view()).map_err(local_err)?,
                        "attention_mask" => TensorRef::from_array_view(mask_array.view()).map_err(local_err)?,
                        "token_type_ids" => TensorRef::from_array_view(type_array.view()).map_err(local_err)?,
                    ])
                    .map_err(local_err)?;
                let hidden = extract_hidden_state(&outputs)?;
                Ok(cls_pool(&hidden))
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
        Err(CoreError::rpc("EMBEDDING_LOCAL", "模型未返回 hidden state"))
    }

    fn tensor_to_array3(value: ort::value::ValueRef<'_>) -> Result<Array3<f32>, CoreError> {
        let (shape, data) = value.try_extract_tensor::<f32>().map_err(local_err)?;
        if shape.len() != 3 {
            return Err(CoreError::rpc(
                "EMBEDDING_LOCAL",
                format!("期望 3 维输出，收到 {} 维", shape.len()),
            ));
        }
        let batch = shape[0] as usize;
        let seq = shape[1] as usize;
        let dim = shape[2] as usize;
        Array3::from_shape_vec((batch, seq, dim), data.to_vec()).map_err(local_err)
    }

    /// CLS 池化：取第 0 个 token 的隐状态（BGE 官方口径）。
    fn cls_pool(hidden: &Array3<f32>) -> Array2<f32> {
        let batch = hidden.shape()[0];
        let dim = hidden.shape()[2];
        let mut out = Array2::<f32>::zeros((batch, dim));
        for b in 0..batch {
            for d in 0..dim {
                out[[b, d]] = hidden[[b, 0, d]];
            }
        }
        out
    }

    fn l2_normalize_rows(matrix: Array2<f32>) -> Vec<Vec<f32>> {
        let mut rows = Vec::with_capacity(matrix.nrows());
        for row in matrix.rows() {
            let mut vec = row.to_vec();
            let norm = vec.iter().map(|v| v * v).sum::<f32>().sqrt();
            if norm > 1e-8 {
                for v in &mut vec {
                    *v /= norm;
                }
            }
            rows.push(vec);
        }
        rows
    }

    /// 进程级唯一实例（模型目录 + dylib 路径变了就重载）。
    static CACHE: OnceLock<Mutex<Option<(PathBuf, Arc<LocalEmbedder>)>>> = OnceLock::new();

    fn embedder(
        model_dir: &Path,
        dylib: Option<&Path>,
    ) -> Result<Arc<LocalEmbedder>, CoreError> {
        let cache = CACHE.get_or_init(|| Mutex::new(None));
        let mut guard = cache
            .lock()
            .map_err(|_| CoreError::rpc("EMBEDDING_LOCAL", "cache lock poisoned"))?;
        if let Some((path, embedder)) = guard.as_ref() {
            if path == model_dir {
                return Ok(Arc::clone(embedder));
            }
        }
        let embedder = Arc::new(LocalEmbedder::load(model_dir, dylib)?);
        *guard = Some((model_dir.to_path_buf(), Arc::clone(&embedder)));
        Ok(embedder)
    }

    pub fn embed(
        model_dir: &Path,
        dylib: Option<&Path>,
        inputs: &[String],
    ) -> Result<Vec<Vec<f32>>, CoreError> {
        let embedder = embedder(model_dir, dylib)?;
        let mut out = Vec::with_capacity(inputs.len());
        for chunk in inputs.chunks(super::super::EMBED_BATCH_MAX_INPUTS) {
            out.extend(embedder.embed(chunk)?);
        }
        Ok(out)
    }
}

/// 对外统一入口：把「要不要用本地」的判断留在 `mod.rs`（provider 解析的单一来源），
/// 这里只负责「本地可用就用本地」这一件事。
pub fn embed(
    model_dir: &Path,
    dylib: Option<&Path>,
    inputs: &[String],
) -> Result<Vec<Vec<f32>>, CoreError> {
    imp::embed(model_dir, dylib, inputs)
}

pub fn probe(dylib: Option<&Path>, model_dir: Option<&Path>) -> Availability {
    imp::probe(dylib, model_dir)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dimensions_follow_the_model_not_the_config() {
        // 配置里的 dimensions 是远端端点的口径；本地模型固定 768，签名要如实反映
        assert_eq!(LOCAL_DIMENSIONS, 768);
        assert_eq!(LOCAL_MODEL_ID, "bge-base-zh-v1.5");
    }

    /// 缺模型目录时必须给出**可读原因**而不是 panic 或静默 false：
    /// 这条结论会进 `embedding.status`，用户据此知道「该下载什么」。
    #[test]
    fn probe_without_model_dir_explains_why() {
        let Availability::Unavailable(reason) = probe(None, None) else {
            panic!("没有模型目录时不应 Ready");
        };
        assert!(reason.contains(LOCAL_MODEL_NAME), "原因里要带模型名: {reason}");
    }

    /// 「运行时不可用」不得被进程级缓存固化，而成功必须只加载一次。
    ///
    /// core 是长驻进程，模型与 dylib 是宿主按需下载的：把失败固化进缓存，用户补装完之后
    /// 仍然只有「onnxruntime 动态库不可用」，必须重启整个 core 才能恢复。
    /// 用例用注入的 loader（不真的 dlopen 假文件 —— 那会挂住测试进程）。
    #[test]
    fn runtime_failure_is_not_cached_but_success_is() {
        use std::cell::Cell;
        let dir = tempfile::tempdir().unwrap();
        let fake = dir.path().join(super::runtime_lib_name());
        std::fs::write(&fake, b"placeholder").unwrap();

        let cache: OnceLock<()> = OnceLock::new();
        let attempts = Cell::new(0);
        let failing = |_: &Path| {
            attempts.set(attempts.get() + 1);
            Err("加载失败".to_string())
        };
        assert!(imp::ensure_runtime_cached(&cache, Some(&fake), failing).is_err());
        assert!(
            imp::ensure_runtime_cached(&cache, Some(&fake), failing).is_err(),
            "失败不得变成终态"
        );
        assert_eq!(attempts.get(), 2, "每次探测都要重新尝试");

        let ok = |_: &Path| Ok(());
        assert!(imp::ensure_runtime_cached(&cache, Some(&fake), ok).is_ok());
        // 成功之后短路：不再 dlopen 第二次（那条路径没有幂等保证）
        let must_not_run = |_: &Path| -> Result<(), String> {
            panic!("成功之后不该再次加载");
        };
        assert!(imp::ensure_runtime_cached(&cache, Some(&fake), must_not_run).is_ok());
    }

    #[test]
    fn compiled_flag_matches_feature() {
        assert_eq!(compiled(), cfg!(feature = "local-embed"));
    }

    /// 真跑一次推理来证明「本地通道能用」——编译通过只能证明清单接对了。
    ///
    /// 模型或 onnxruntime 缺失时**跳过**（打印原因），所以默认 `cargo test` 不依赖它们；
    /// 有条件的环境（`DIEYUN_MODELS_DIR` + `DIEYUN_ORT_LIB`）会真的跑一次。
    #[test]
    fn embeds_text_when_runtime_and_model_present() {
        let root = std::env::var("DIEYUN_MODELS_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|_| {
                PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                    .join("..")
                    .join("..")
                    .join("models")
            });
        let model_dir = root.join(LOCAL_MODEL_NAME);
        let dylib = std::env::var("DIEYUN_ORT_LIB").ok().map(PathBuf::from);
        if let Availability::Unavailable(reason) = probe(dylib.as_deref(), Some(&model_dir)) {
            eprintln!("skip local embed test: {reason}");
            return;
        }

        let query = "向量检索测试".to_string();
        let near = "向量搜索的测试".to_string();
        let far = "蛋糕配方：低筋面粉 200 克".to_string();
        let out = embed(
            &model_dir,
            dylib.as_deref(),
            &[query.clone(), near, far],
        )
        .expect("local embed");
        assert_eq!(out.len(), 3);
        assert_eq!(out[0].len(), LOCAL_DIMENSIONS as usize);

        let norm: f32 = out[0].iter().map(|v| v * v).sum::<f32>().sqrt();
        assert!(
            (norm - 1.0).abs() < 1e-3,
            "L2 归一化后模长应为 1，实际 {norm}"
        );

        // 同一批次形状重跑：必须逐位一致（同形状 → 同 kernel，纯确定性检验）
        let repeat = embed(
            &model_dir,
            dylib.as_deref(),
            &[query.clone(), "向量搜索的测试".to_string(), "蛋糕配方：低筋面粉 200 克".to_string()],
        )
        .expect("embed repeat");
        assert_eq!(repeat[0], out[0], "同批次形状重跑必须逐位一致");

        // 换批次形状（批量 3 → 单条）：**只承诺近似**。量化 kernel 的累加顺序随 batch 规模
        // 变化，实测同一段文本的余弦会掉到 ~0.98 —— 所以索引（批量）与查询（单条）之间
        // 一定存在这个量级的差异，任何「逐位相等」的假设都是错的；向量缓存存「算出来的
        // 那一个」，不跨形状比对，故不受影响。
        let alone = embed(&model_dir, dylib.as_deref(), &[query.clone()]).expect("embed alone");
        let dot = |a: &[f32], b: &[f32]| a.iter().zip(b).map(|(x, y)| x * y).sum::<f32>();
        let cross_shape = dot(&alone[0], &out[0]);
        assert!(
            cross_shape > 0.95,
            "换批次形状后应仍高度相近，实际余弦 {cross_shape:.4}"
        );

        // 语义：相近句的余弦必须高于无关句
        let sim_near = dot(&out[0], &out[1]);
        let sim_far = dot(&out[0], &out[2]);
        assert!(
            sim_near > sim_far + 0.05,
            "近义句应更近：near={sim_near:.3} far={sim_far:.3}"
        );
    }
}

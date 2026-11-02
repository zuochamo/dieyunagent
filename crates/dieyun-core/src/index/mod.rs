mod remote;
mod schema;
mod search;
pub(crate) mod vector_cache;
pub(crate) mod vector_pool;
mod walker;
mod workspace;

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use rusqlite::{params, Connection};
use serde::Serialize;

use crate::config::{AppConfig, INDEX_FILE_MAX_BYTES};
use crate::error::CoreError;
use crate::sqlite::SqliteHandle;
use vector_pool::{PoolCache, VectorPool};

use crate::embedding::{self, EmbeddingConfig};

pub use remote::RemoteFileInput;
pub use schema::{ensure_schema, init_schema, SCHEMA_VERSION};
pub use search::SearchResult;
pub use walker::collect_text_files;
pub use workspace::{resolve_workspace, WorkspaceRef};

pub(crate) const CHUNK_LINES: usize = 55;
pub(crate) const CHUNK_OVERLAP: usize = 10;
const MAX_FILES: usize = 16_000;
pub(crate) const CHUNK_CONTENT_MAX_CHARS: usize = 12000;

#[derive(Debug, Clone, Default)]
pub(crate) struct ProgressSnapshot {
    pub phase: String,
    pub files_done: i64,
    pub files_total: i64,
    pub chunk_count: i64,
    pub vector_count: i64,
    pub last_error: Option<String>,
}

/// 纳秒时间戳下限（1e12）：低于此值的存量记录是旧的「秒级」mtime。
/// 秒级精度会让同一秒内的两次保存被判为「未变化」，是增量索引漏更新的根因。
pub(crate) const MTIME_NS_FLOOR: i64 = 1_000_000_000_000;

/// 文件 mtime 纳秒时间戳（本地增量索引的判据）。
pub(crate) fn file_mtime_stamp(meta: &std::fs::Metadata) -> i64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_nanos().min(i64::MAX as u128) as i64)
        .unwrap_or(0)
}

/// 仅当存量记录已是纳秒精度且完全相等时才算未变化；
/// 旧的秒级记录一律视为已变化，从而重建一次并升级到纳秒精度。
pub(crate) fn mtime_unchanged(stored: i64, current: i64) -> bool {
    stored >= MTIME_NS_FLOOR && stored == current
}

pub(crate) fn truncate_chars(text: &str, max_chars: usize) -> &str {
    if text.chars().count() <= max_chars {
        return text;
    }
    match text.char_indices().nth(max_chars) {
        Some((idx, _)) => &text[..idx],
        None => text,
    }
}

#[derive(Clone)]
pub struct IndexService {
    /// codebase.db 句柄：与 `GraphService` 共享同一条常驻连接（同库，故同连接）。
    db: Arc<SqliteHandle>,
    embedding: EmbeddingConfig,
    indexing: Arc<Mutex<HashSet<String>>>,
    progress: Arc<Mutex<HashMap<String, ProgressSnapshot>>>,
    remote_ingest: remote::RemoteIngestHandle,
    /// root_hash -> 常驻内存 chunk 向量池
    vector_pools: PoolCache,
    /// 跨 worktree 的向量复用缓存（`<data_dir>/vector-cache.sqlite`）。
    /// 为 None 时退化为「每次都真算」——缓存是优化，不是正确性的一部分。
    vector_cache_path: Option<PathBuf>,
    vector_cache: Arc<Mutex<Option<vector_cache::VectorCache>>>,
}

impl IndexService {
    pub fn new(db: Arc<SqliteHandle>, embedding: EmbeddingConfig) -> Self {
        Self {
            db,
            embedding,
            indexing: Arc::new(Mutex::new(HashSet::new())),
            progress: Arc::new(Mutex::new(HashMap::new())),
            remote_ingest: remote::RemoteIngestHandle::default(),
            vector_pools: PoolCache::new(),
            vector_cache_path: None,
            vector_cache: Arc::new(Mutex::new(None)),
        }
    }

    /// 打开「按内容哈希复用向量」的跨 worktree 缓存。
    ///
    /// 建库最贵的一环是 embedding；SSH 会话的索引库是每会话一份，没有复用时
    /// 每开一个会话就要把整仓重算一遍（见 `index/vector_cache.rs` 顶部说明）。
    pub fn with_vector_cache(mut self, path: Option<PathBuf>) -> Self {
        self.vector_cache_path = path;
        self
    }

    /// 在缓存上做一次短操作：拿不到缓存（未配置 / 打开失败 / 加锁失败）就返回 None，
    /// 调用方按「全部未命中」处理。**不要**在这类闭包里 `await`：锁不能跨 await 持有。
    fn vector_cache_op<T>(&self, f: impl FnOnce(&vector_cache::VectorCache) -> Result<T, CoreError>) -> Option<T> {
        let path = self.vector_cache_path.clone()?;
        let mut guard = self.vector_cache.lock().ok()?;
        if guard.is_none() {
            *guard = vector_cache::VectorCache::open(&path).ok();
        }
        let cache = guard.as_ref()?;
        f(cache).ok()
    }

    /// ① 向量复用的前半段（**同步**）：查跨 worktree 内容哈希缓存，命中项直接写进
    /// `chunk_vectors`。返回 `(未命中列表, 复用条数)`。
    ///
    /// 本机建库（[`Self::run_index`]）与远端摄取（`remote::index_remote_finish_inner`）都走这里：
    /// 「查缓存 → 补算 → 写库 → 回填缓存」只能有一份实现，否则复用在其中一条路径上悄悄失效
    /// （本仓反复踩过的坑）。分两段而不是合成一个 async fn，是因为 `&Connection` 不是 `Send`：
    /// 只要它跨过 `await`，整个 RPC handler 的 future 就再也 `Send` 不了。
    fn apply_cached_vectors(
        &self,
        conn: &Connection,
        pending: Vec<(i64, String)>,
    ) -> Result<(Vec<(i64, String, String)>, i64), CoreError> {
        // (chunk_id, 正文, 内容哈希)。哈希对象是**实际送进模型的文本**（`embedding_input`：
        // 超长 chunk 会被截断），不是原始正文——否则只在截断点之后不同的两个 chunk 会各算
        // 一次、拿到完全一样的向量。
        let pending: Vec<(i64, String, String)> = pending
            .into_iter()
            .map(|(id, text)| {
                let hash = vector_cache::content_hash(&embedding::embedding_input(&text));
                (id, text, hash)
            })
            .collect();
        if pending.is_empty() {
            return Ok((pending, 0));
        }
        let hashes: Vec<String> = pending.iter().map(|(_, _, h)| h.clone()).collect();
        // 同一段代码在别的 worktree / 上一个会话里算过的向量直接拿来用。这就是
        // 「每会话一份索引库（乙案）+ 向量」付得起的原因：换会话不换代码，第二次起
        // 整仓几乎全部命中，只剩改动的那几个 chunk 要真算。
        let cache_key = self.embedding.cache_key();
        let hits = self
            .vector_cache_op(|cache| {
                cache.get_many(&cache_key, &hashes, self.embedding.dimensions as usize)
            })
            .filter(|h| !h.is_empty());
        let Some(hits) = hits else {
            return Ok((pending, 0));
        };
        let mut reused = 0i64;
        let mut misses = Vec::with_capacity(pending.len());
        for (chunk_id, text, hash) in pending {
            match hits.get(&hash) {
                Some(vec) => {
                    write_chunk_vector(conn, chunk_id, vec)?;
                    reused += 1;
                }
                None => misses.push((chunk_id, text, hash)),
            }
        }
        Ok((misses, reused))
    }

    /// ② 向量复用的后半段（**同步**，在 `embed_batches` 之后调用）：把算出来的向量写库并
    /// 回填缓存（超上限时裁最老的）。`on_progress` 收到「本轮已写入的向量条数」（含复用）。
    fn store_embedded_vectors(
        &self,
        conn: &Connection,
        rows: Vec<(i64, Vec<f32>)>,
        hash_by_id: &HashMap<i64, String>,
        reused: i64,
        mut on_progress: impl FnMut(i64),
    ) -> Result<i64, CoreError> {
        let mut embedded = 0i64;
        let mut fresh: Vec<(String, Vec<f32>)> = Vec::with_capacity(rows.len());
        for (chunk_id, vec) in rows {
            if let Some(hash) = hash_by_id.get(&chunk_id) {
                fresh.push((hash.clone(), vec.clone()));
            }
            write_chunk_vector(conn, chunk_id, &vec)?;
            embedded += 1;
            if embedded == 1 || embedded % 32 == 0 {
                on_progress(reused + embedded);
            }
        }
        // 回填缓存。**失败一律吞掉**：缓存不可用只该让下次慢一点，不该让一次建库失败。
        let now_ts = now_secs();
        let cache_key = self.embedding.cache_key();
        self.vector_cache_op(|cache| {
            let written = cache.put_many(&cache_key, &fresh, now_ts)?;
            if written > 0 {
                cache.prune(vector_cache::DEFAULT_MAX_ROWS)?;
            }
            Ok(())
        });
        Ok(embedded)
    }

    /// 取工作区的向量池：命中则刷新 LRU，否则从 SQLite 全量载入。
    /// 池只是加速层，加载失败时返回 None，调用方回退到 SQL 路径。
    fn vector_pool_for(&self, conn: &Connection, root_hash: &str) -> Option<Arc<VectorPool>> {
        if let Some(pool) = self.vector_pools.get(root_hash) {
            return Some(pool);
        }
        let pool = Arc::new(VectorPool::load(conn, root_hash).ok().flatten()?);
        self.vector_pools.insert(root_hash, Arc::clone(&pool));
        Some(pool)
    }

    /// 索引写入完成后重建池（仅当该工作区已加载过），保证检索读到最新向量。
    /// 重建发生在索引路径上，检索路径始终是纯内存扫描。
    fn refresh_pool(&self, conn: &Connection, root_hash: &str) {
        if !self.vector_pools.contains(root_hash) {
            return;
        }
        match VectorPool::load(conn, root_hash) {
            Ok(Some(p)) => self.vector_pools.insert(root_hash, Arc::new(p)),
            // 向量被清空或读取异常：丢弃池，让下次检索按需重建
            _ => self.vector_pools.remove(root_hash),
        }
    }

    pub(crate) fn set_progress(
        &self,
        root_hash: &str,
        phase: &str,
        files_done: i64,
        files_total: i64,
        chunk_count: i64,
        vector_count: i64,
    ) {
        if let Ok(mut guard) = self.progress.lock() {
            let entry = guard.entry(root_hash.to_string()).or_default();
            entry.phase = phase.to_string();
            entry.files_done = files_done;
            entry.files_total = files_total;
            entry.chunk_count = chunk_count;
            entry.vector_count = vector_count;
            entry.last_error = None;
        }
    }

    pub(crate) fn set_progress_error(&self, root_hash: &str, err: &str) {
        if let Ok(mut guard) = self.progress.lock() {
            let entry = guard.entry(root_hash.to_string()).or_default();
            entry.phase = "error".into();
            entry.last_error = Some(err.to_string());
        }
    }

    pub(crate) fn clear_progress(&self, root_hash: &str) {
        if let Ok(mut guard) = self.progress.lock() {
            guard.remove(root_hash);
        }
    }

    fn progress_for(&self, root_hash: &str) -> Option<ProgressSnapshot> {
        self.progress
            .lock()
            .ok()
            .and_then(|g| g.get(root_hash).cloned())
    }

    pub fn from_config(config: &AppConfig, db: Arc<SqliteHandle>) -> Self {
        // 向量复用缓存落在 data_dir（不写进项目：它是纯派生缓存，每个 worktree 一份毫无意义）
        Self::new(db, config.embedding.clone()).with_vector_cache(Some(
            config.data_dir.join(vector_cache::CACHE_FILE_NAME),
        ))
    }

    /// embedding 端点是否可用（`model` 与 `base_url` 都配了且没被禁用）。
    ///
    /// 调用方要求 `vectors=true` 时先问这个：配置缺失时建库会**静默**退化成只建 chunk，
    /// 用户看着进度条走完、向量还是 0，不知道是没配端点。校验放在 RPC 入口，报错才可解释。
    pub fn vectors_available(&self) -> bool {
        self.embedding.enabled()
    }

    /// 独立连接：用于跨 `.await` 或分钟级长任务，避免长时间占用常驻锁。
    fn open_dedicated(&self) -> Result<Connection, CoreError> {
        self.db.open_dedicated()
    }

    /// 读侧连接（池化、受并发上限约束）：扫描型查询只借一次，不占常驻锁。
    fn read_conn(&self) -> Result<crate::sqlite::ReadConn<'_>, CoreError> {
        self.db.read_conn()
    }

    pub fn status(&self, workspace_root: &str) -> Result<StatusResult, CoreError> {
        let ws = resolve_workspace(workspace_root)?;
        self.status_impl(&ws)
    }

    /// 状态读取的唯一入口：走**读池**纯读，维修动作挪到独立连接。
    ///
    /// 读路径里不许写的原因：常驻连接是 index / graph 共用的唯一写入连接，
    /// 一次等锁就是 `BUSY_TIMEOUT_SECS`（15s）起步，`codebase.status` 这类必须秒回的
    /// 请求挂住之后，上层只能看到「Gateway RPC 超时: codebase.status (45s)」。
    /// 详见 `docs/SQLITE-ACCESS.md`。
    fn status_impl(&self, ws: &WorkspaceRef) -> Result<StatusResult, CoreError> {
        let (st, repair) = self.db.read(|conn| self.status_with_conn(conn, ws))?;
        if let Some(repair) = repair {
            self.apply_status_repair(ws, &repair);
        }
        Ok(st)
    }

    /// 修掉崩溃 / 半初始化留下的脏状态（`indexing = 1` 却没人真在跑、元数据残缺）。
    ///
    /// best-effort：独立连接 + `busy_timeout(0)`，抢不到写锁就放弃，等下一次 status
    /// 再修。返回给调用方的数值已经算好了，与这次是否落盘无关 —— 维修绝不能拖慢读。
    fn apply_status_repair(&self, ws: &WorkspaceRef, repair: &StatusRepair) {
        let Ok(conn) = self.open_dedicated() else {
            return;
        };
        let _ = conn.busy_timeout(std::time::Duration::ZERO);
        let _ = conn.execute(
            "UPDATE workspaces SET indexing = 0, file_count = ?2, chunk_count = ?3,
             indexed_at = CASE WHEN indexed_at = 0 THEN ?4 ELSE indexed_at END
             WHERE root_hash = ?1",
            params![
                ws.root_hash,
                repair.file_count,
                repair.chunk_count,
                repair.indexed_at
            ],
        );
    }

    /// `status` 的实现本体：连接由调用方提供。
    ///
    /// **纯读**：只读不写，脏状态以 [`StatusRepair`] 的形式交回调用方用独立连接补写
    /// （见 [`status_impl`](Self::status_impl)）。凡「已经拿着连接」的地方都走这个入口，
    /// 在其中再调 `self.status` 会直接自锁。
    fn status_with_conn(
        &self,
        conn: &Connection,
        ws: &WorkspaceRef,
    ) -> Result<(StatusResult, Option<StatusRepair>), CoreError> {
        let live_indexing = self
            .indexing
            .lock()
            .map(|g| g.contains(&ws.root_hash))
            .unwrap_or(false);

        // 向量元信息：模型 / 维度取**库里实际写入**的值（下面 row 里读），
        // 当前配置的签名只用来回答「库里的向量是不是当前这个模型产的」。
        let current_signature = self.embedding.signature();
        let embedding_enabled = self.embedding.enabled();

        let row: Option<(i64, i64, i64, i64, i64, Option<String>, i64, i64, i64)> = conn
            .query_row(
                "SELECT file_count, chunk_count, vector_count, indexed_at, indexing,
                        embedding_model, embedding_dims, vectors_reused, vectors_embedded
                 FROM workspaces WHERE root_hash = ?1",
                params![ws.root_hash],
                |r| {
                    Ok((
                        r.get(0)?,
                        r.get(1)?,
                        r.get(2)?,
                        r.get(3)?,
                        r.get(4)?,
                        r.get(5)?,
                        r.get(6)?,
                        r.get(7)?,
                        r.get(8)?,
                    ))
                },
            )
            .ok();

        Ok(match row {
            None => {
                let mut st = StatusResult {
                    ok: true,
                    indexed: false,
                    file_count: 0,
                    chunk_count: 0,
                    vector_count: 0,
                    indexed_at: 0,
                    indexing: live_indexing,
                    embedding_model: None,
                    embedding_dims: 0,
                    embedding_enabled,
                    embedding_stale: false,
                    vectors_reused: 0,
                    vectors_embedded: 0,
                    phase: None,
                    files_done: None,
                    files_total: None,
                    last_error: None,
                };
                self.apply_live_progress(&ws.root_hash, &mut st);
                (st, None)
            }
            Some((fc, cc, vc, ia, db_indexing, em, ed, reused, embedded)) => {
                // 仅当旗标或元数据明显残缺时再 COUNT，避免每次 status 扫表
                let mut db_flag = db_indexing;
                let mut file_count = fc;
                let mut chunk_count = cc;
                let mut indexed_at = ia;
                let mut repair = None;
                if !live_indexing {
                    let need_clear_flag = db_flag != 0;
                    // 崩溃可能落在「清空 chunks」和「写回 counts」之间：库里已经空了，
                    // 元数据还是上一轮的满值。不查一下就会一直报「已索引 N 段」，而
                    // search 因 chunk_count != 0 绕过 needsIndex 门槛，静默返回 0 条。
                    // 探针用 EXISTS（走 root_hash 索引，微秒级），不是 COUNT(*)。
                    let has_rows: i64 = conn
                        .query_row(
                            "SELECT EXISTS(SELECT 1 FROM chunks WHERE root_hash = ?1)",
                            params![ws.root_hash],
                            |r| r.get(0),
                        )
                        // 查询失败按「有数据」保守处理，别把好索引误判成空
                        .unwrap_or(1);
                    let meta_looks_broken = indexed_at == 0
                        || (chunk_count == 0 && file_count == 0)
                        || (chunk_count > 0 && has_rows == 0);
                    if need_clear_flag || meta_looks_broken {
                        let real_chunks: i64 = conn
                            .query_row(
                                "SELECT COUNT(*) FROM chunks WHERE root_hash = ?1",
                                params![ws.root_hash],
                                |r| r.get(0),
                            )
                            .unwrap_or(0);
                        if real_chunks > 0 && (chunk_count == 0 || file_count == 0 || indexed_at == 0)
                        {
                            chunk_count = real_chunks;
                            if file_count == 0 {
                                file_count = conn
                                    .query_row(
                                        "SELECT COUNT(DISTINCT rel_path) FROM chunks WHERE root_hash = ?1",
                                        params![ws.root_hash],
                                        |r| r.get(0),
                                    )
                                    .unwrap_or(0);
                            }
                            if indexed_at == 0 {
                                indexed_at = std::time::SystemTime::now()
                                    .duration_since(std::time::UNIX_EPOCH)
                                    .map(|d| d.as_secs() as i64)
                                    .unwrap_or(0);
                            }
                        } else if real_chunks == 0 && chunk_count > 0 {
                            // 内容真的没了：如实归零（indexed_at=0 → indexed=false，上层会提示重建）
                            chunk_count = 0;
                            file_count = 0;
                            indexed_at = 0;
                        }
                        // 读路径不写库：只把「欠一次修」交回调用方
                        repair = Some(StatusRepair {
                            file_count,
                            chunk_count,
                            indexed_at,
                        });
                        db_flag = 0;
                    }
                }
                let embedding_stale = vc > 0
                    && !current_signature.is_empty()
                    && em.as_deref().unwrap_or("") != current_signature;
                let mut st = StatusResult {
                    ok: true,
                    indexed: indexed_at > 0,
                    file_count,
                    chunk_count,
                    vector_count: vc,
                    indexed_at,
                    indexing: live_indexing || db_flag != 0,
                    embedding_model: em,
                    embedding_dims: ed,
                    embedding_enabled,
                    embedding_stale,
                    vectors_reused: reused,
                    vectors_embedded: embedded,
                    phase: None,
                    files_done: None,
                    files_total: None,
                    last_error: None,
                };
                self.apply_live_progress(&ws.root_hash, &mut st);
                (st, repair)
            }
        })
    }

    fn apply_live_progress(&self, root_hash: &str, st: &mut StatusResult) {
        if let Ok(jobs) = self.remote_ingest.jobs.lock() {
            if let Some(job) = jobs.get(root_hash) {
                st.indexing = true;
                st.phase = Some(if job.pending_embed.is_empty() {
                    "chunking".into()
                } else {
                    "embedding".into()
                });
                st.files_done = Some(job.file_count);
                st.chunk_count = job.chunk_count.max(st.chunk_count);
            }
        }
        if let Some(p) = self.progress_for(root_hash) {
            if !p.phase.is_empty() {
                st.phase = Some(p.phase.clone());
            }
            if p.files_total > 0 || p.files_done > 0 {
                st.files_done = Some(p.files_done);
                st.files_total = Some(p.files_total);
            }
            if p.chunk_count > st.chunk_count {
                st.chunk_count = p.chunk_count;
            }
            if p.vector_count > st.vector_count {
                st.vector_count = p.vector_count;
            }
            if let Some(err) = p.last_error {
                st.last_error = Some(err);
            }
        }
    }

    /// 后台启动本地索引（立即返回，便于轮询 status 进度）
    /// - `force`: 全量清空再建
    /// - `skip_if_ready`: true 时若已就绪则跳过（prep 门闩）；false 时即使已索引也启动 mtime 增量（保存后刷新）
    /// - `vectors`: 是否同时生成向量。**显式 opt-in**（默认 false）：向量是这套索引里
    ///   最贵的一环（embedding 调用 + 343 MB 库体），而实测调用率极低（见
    ///   docs/INDEX-VALUE-REVIEW.md §3）。只有调用方明确要语义检索时才建。
    pub fn start_index_workspace(
        &self,
        workspace_root: &str,
        force: bool,
        skip_if_ready: bool,
        vectors: bool,
    ) -> Result<StartIndexResult, CoreError> {
        let ws = resolve_workspace(workspace_root)?;
        if ws.is_remote {
            return Err(CoreError::rpc(
                "REMOTE_INDEX_REQUIRED",
                "远程工作空间请使用 codebase.index_remote 或在远端本地路径上建索引",
            ));
        }
        let root = ws
            .local_path
            .as_ref()
            .ok_or_else(|| CoreError::rpc("INVALID_WORKSPACE", "无法解析本地工作区"))?
            .clone();
        let root_hash = ws.root_hash.clone();
        let workspace_key = workspace_root.to_string();

        // 注意：切勿在持有 self.indexing 锁时调用 self.status()，
        // status() 会再次加同一把非重入锁 → 死锁。故先把“是否已在跑”读出来即释放锁。
        let already_running = {
            let guard = self
                .indexing
                .lock()
                .map_err(|_| CoreError::rpc("INDEX_BUSY", "索引锁不可用"))?;
            guard.contains(&root_hash)
        };
        if already_running {
            let st = self.status(workspace_root)?;
            return Ok(StartIndexResult {
                started: false,
                already_running: true,
                status: st,
            });
        }
        if !force && skip_if_ready {
            let st = self.status(workspace_root)?;
            // prep / send 门闩：已建库即可跳过（含空仓）；embedding 过期交给后台增量，勿堵住发消息
            if st.indexed {
                return Ok(StartIndexResult {
                    started: false,
                    already_running: false,
                    status: st,
                });
            }
        }
        {
            let mut guard = self
                .indexing
                .lock()
                .map_err(|_| CoreError::rpc("INDEX_BUSY", "索引锁不可用"))?;
            // 复核竞态：上面查 status 期间可能有其它线程已启动
            if guard.contains(&root_hash) {
                drop(guard);
                let st = self.status(workspace_root)?;
                return Ok(StartIndexResult {
                    started: false,
                    already_running: true,
                    status: st,
                });
            }
            guard.insert(root_hash.clone());
        }

        self.set_progress(&root_hash, "walking", 0, 0, 0, 0);

        let svc = self.clone();
        let hash = root_hash.clone();
        // 独立线程 + 自有 runtime：stdio 可在建库时继续处理 codebase.status
        std::thread::Builder::new()
            .name("dieyun-codebase-index".into())
            .spawn(move || {
                let finish = |svc: &IndexService, hash: &str, result: Result<(), CoreError>| {
                    if let Ok(mut guard) = svc.indexing.lock() {
                        guard.remove(hash);
                    }
                    match result {
                        Ok(_) => svc.clear_progress(hash),
                        Err(e) => {
                            svc.set_progress_error(hash, &e.to_string());
                            if let Ok(conn) = svc.open_dedicated() {
                                let _ = conn.execute(
                                    "UPDATE workspaces SET indexing = 0 WHERE root_hash = ?1",
                                    params![hash],
                                );
                            }
                        }
                    }
                };
                let rt = match tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                {
                    Ok(rt) => rt,
                    Err(e) => {
                        finish(
                            &svc,
                            &hash,
                            Err(CoreError::rpc("INDEX_FAILED", format!("index runtime: {e}"))),
                        );
                        return;
                    }
                };
                let result = rt.block_on(svc.run_index(&root, &hash, force, vectors));
                finish(&svc, &hash, result);
                let _ = workspace_key;
            })
            .map_err(|e| CoreError::rpc("INDEX_FAILED", format!("无法启动索引线程: {e}")))?;

        // 避免在写库线程刚启动时同步 status 可能长时间阻塞；返回进行中快照
        Ok(StartIndexResult {
            started: true,
            already_running: false,
            status: StatusResult {
                ok: true,
                indexed: false,
                file_count: 0,
                chunk_count: 0,
                vector_count: 0,
                indexed_at: 0,
                indexing: true,
                embedding_model: None,
                embedding_dims: 0,
                embedding_enabled: self.embedding.enabled(),
                embedding_stale: false,
                vectors_reused: 0,
                vectors_embedded: 0,
                phase: Some("walking".into()),
                files_done: Some(0),
                files_total: None,
                last_error: None,
            },
        })
    }

    pub async fn index_workspace(
        &self,
        workspace_root: &str,
        force: bool,
        vectors: bool,
    ) -> Result<StatusResult, CoreError> {
        let ws = resolve_workspace(workspace_root)?;
        if ws.is_remote {
            return Err(CoreError::rpc(
                "REMOTE_INDEX_REQUIRED",
                "远程工作空间请使用 codebase.index_remote",
            ));
        }
        let root = ws
            .local_path
            .as_ref()
            .ok_or_else(|| CoreError::rpc("INVALID_WORKSPACE", "无法解析本地工作区"))?;
        let root_hash = ws.root_hash.clone();
        {
            let mut guard = self
                .indexing
                .lock()
                .map_err(|_| CoreError::rpc("INDEX_BUSY", "索引锁不可用"))?;
            if guard.contains(&root_hash) {
                // 先放锁再查状态：status() 会再加同一把非重入锁，持锁调用即死锁。
                // 与 start_index_workspace 的写法对齐（那里早就踩过这个坑）。
                drop(guard);
                return self.status(workspace_root);
            }
            // sync index：始终跑一遍（force=false 时按 mtime 增量），供保存后后台刷新
            guard.insert(root_hash.clone());
        }

        self.set_progress(&root_hash, "walking", 0, 0, 0, 0);
        let result = self.run_index(root, &root_hash, force, vectors).await;
        if let Ok(mut guard) = self.indexing.lock() {
            guard.remove(&root_hash);
        }
        match &result {
            Ok(_) => self.clear_progress(&root_hash),
            Err(e) => self.set_progress_error(&root_hash, &e.to_string()),
        }
        result?;
        self.status(workspace_root)
    }

    pub async fn index_remote(
        &self,
        workspace_root: &str,
        files: Vec<RemoteFileInput>,
        force: bool,
        vectors: bool,
    ) -> Result<StatusResult, CoreError> {
        let ws = resolve_workspace(workspace_root)?;
        if !ws.is_remote {
            return Err(CoreError::rpc(
                "LOCAL_INDEX_REQUIRED",
                "本地工作空间请使用 codebase.index",
            ));
        }
        self.index_remote_begin(&ws, force, vectors).await?;
        if !force {
            let st = self.status(workspace_root)?;
            let sig = self.embedding.signature();
            let embedding_stale = st.chunk_count > 0
                && !sig.is_empty()
                && st.embedding_model.as_deref().unwrap_or("") != sig;
            if st.indexed && !embedding_stale {
                return Ok(st);
            }
        }
        const BATCH: usize = 30;
        for batch in files.chunks(BATCH) {
            self.index_remote_push(&ws, batch)?;
        }
        self.index_remote_finish(&ws).await
    }

    /// 全量 / 增量建库。统计值直接写进 `workspaces` 与进度快照，调用方只看成败。
    async fn run_index(
        &self,
        root: &Path,
        root_hash: &str,
        force: bool,
        vectors: bool,
    ) -> Result<(), CoreError> {
        // 跨 await + 分钟级任务：既拿不住 MutexGuard，也不该占着常驻锁。
        let conn = self.open_dedicated()?;
        conn.execute(
            "INSERT INTO workspaces (root_hash, root_path, indexing) VALUES (?1, ?2, 1)
             ON CONFLICT(root_hash) DO UPDATE SET indexing = 1, root_path = excluded.root_path",
            params![root_hash, root.to_string_lossy()],
        )
        .map_err(|e| CoreError::rpc("INDEX_FAILED", e.to_string()))?;

        if force {
            delete_all_chunks(&conn, root_hash)?;
        }

        self.set_progress(root_hash, "walking", 0, 0, 0, 0);
        let files = walker::collect_text_files(root, MAX_FILES);
        let files_total = files.len() as i64;
        self.set_progress(root_hash, "chunking", 0, files_total, 0, 0);

        let stored_mtimes = if force {
            HashMap::new()
        } else {
            load_chunk_mtimes(&conn, root_hash)?
        };
        let rel_set: HashSet<String> = files
            .iter()
            .map(|f| f.rel.replace('\\', "/"))
            .collect();
        if !force {
            purge_stale_chunk_paths(&conn, root_hash, &rel_set)?;
        }

        // 向量是**显式 opt-in**：调用方要（`vectors=true`）且 embedding 配置可用才建。
        // 没有向量时 `chunks` 仍可检索（子串通道），索引照样能用。
        let use_vectors = vectors && self.embedding.enabled();
        let embed_sig = self.embedding.signature();
        // 库里已有的向量签名：本次**不要**向量时要沿用它（见下方 opt-in 语义说明），
        // 不能因为"这次不写向量"就把元数据抹掉。
        let (prev_embed_model, prev_embed_dims): (Option<String>, i64) = conn
            .query_row(
                "SELECT embedding_model, embedding_dims FROM workspaces WHERE root_hash = ?1",
                params![root_hash],
                |r| {
                    Ok((
                        r.get::<_, Option<String>>(0)?,
                        r.get::<_, Option<i64>>(1)?.unwrap_or(0),
                    ))
                },
            )
            .unwrap_or((None, 0));
        let model_changed = use_vectors
            && !embed_sig.is_empty()
            && prev_embed_model.as_deref().unwrap_or("") != embed_sig;

        let mut file_count = 0i64;
        let mut pending_embed: Vec<(i64, String)> = Vec::new();

        {
            let tx = conn
                .unchecked_transaction()
                .map_err(|e| CoreError::rpc("INDEX_FAILED", e.to_string()))?;

            for file in &files {
                let meta = match std::fs::metadata(&file.abs) {
                    Ok(m) => m,
                    Err(_) => continue,
                };
                if !meta.is_file() || meta.len() > INDEX_FILE_MAX_BYTES {
                    continue;
                }
                let rel = file.rel.replace('\\', "/");
                let mtime = file_mtime_stamp(&meta);

                if !force {
                    if let Some(prev) = stored_mtimes.get(&rel).copied() {
                        if mtime_unchanged(prev, mtime) {
                            file_count += 1;
                            if file_count == 1 || file_count % 8 == 0 || file_count == files_total {
                                let cc = count_chunks(&tx, root_hash)?;
                                self.set_progress(
                                    root_hash,
                                    "chunking",
                                    file_count,
                                    files_total,
                                    cc,
                                    0,
                                );
                            }
                            continue;
                        }
                    }
                }

                // 先读成功再删旧 chunk，避免读失败把已有索引抠掉
                let text = match std::fs::read_to_string(&file.abs) {
                    Ok(t) => t,
                    Err(_) => continue,
                };
                if text.contains('\0') {
                    continue;
                }

                if !force {
                    delete_chunks_for_path(&tx, root_hash, &rel)?;
                }

                file_count += 1;
                for (start_line, end_line, slice) in
                    crate::treesitter::iter_chunk_slices(&rel, &text)
                {
                    let Some((id, content)) =
                        insert_chunk(&tx, root_hash, &rel, start_line, end_line, &slice, mtime)?
                    else {
                        continue;
                    };
                    if use_vectors {
                        pending_embed.push((id, content));
                    }
                }

                if file_count == 1 || file_count % 8 == 0 || file_count == files_total {
                    let cc = count_chunks(&tx, root_hash)?;
                    self.set_progress(
                        root_hash,
                        "chunking",
                        file_count,
                        files_total,
                        cc,
                        0,
                    );
                }
            }

            tx.commit()
                .map_err(|e| CoreError::rpc("INDEX_FAILED", e.to_string()))?;
        }

        // 以库里的真实条数为准（增量时大部分文件被跳过，逐块累加没有意义）
        let chunk_count = count_chunks(&conn, root_hash)?;

        // 本次不要向量（`vectors=false`：面板「重建片段」、增量建库、prep 首次建库…）
        // **不删**已有向量。「这次不写向量」≠「用户不要向量了」——按后者实现时，一次
        // 重建或一次保存就会把整库向量清空，语义检索无声失效（面板显示 0，用户以为没用）。
        // 需要清空的只有两种情况：`force` 全量重建（chunk id 全换，`delete_all_chunks`
        // 已清）与签名变更（维度不兼容，必须重建）。
        if model_changed {
            conn.execute(
                "DELETE FROM chunk_vectors WHERE chunk_id IN (SELECT id FROM chunks WHERE root_hash = ?1)",
                params![root_hash],
            )
            .ok();
            pending_embed = load_all_chunk_texts(&conn, root_hash)?;
        } else if use_vectors {
            // 补齐缺向量的 chunk（例如上次 embedding 中断，或增量改过文件但那次没带向量）。
            // 只在本次真要写向量时算：这条是 chunks ⨝ chunk_vectors 的反连接，`vectors=false`
            // 的增量（每次保存都可能跑）没必要为一次用不上的结果扫全表。
            let missing = load_chunks_missing_vectors(&conn, root_hash)?;
            if !missing.is_empty() {
                let mut seen: HashSet<i64> = pending_embed.iter().map(|(id, _)| *id).collect();
                for row in missing {
                    if seen.insert(row.0) {
                        pending_embed.push(row);
                    }
                }
            }
        }

        // 只有本次确实产生了新向量（或模型变更）时才重建内存池；否则保留现有池，避免
        // "保存一下就把整库向量重读一遍"。`!use_vectors` 也要刷：增量重建会按文件删掉
        // 旧 chunk（连同其向量），池里那些 chunk id 已作废，不刷会留下查不到行的僵尸条目。
        let vectors_changed = !use_vectors || model_changed || !pending_embed.is_empty();

        // 本轮「复用缓存命中」与「真的调了 embedding」的条数，写进 workspaces 供面板/诊断读。
        let mut vectors_reused = 0i64;
        let mut vectors_embedded = 0i64;
        if use_vectors && !pending_embed.is_empty() {
            self.set_progress(
                root_hash,
                "embedding",
                file_count,
                files_total,
                chunk_count,
                0,
            );
            // ① 缓存命中直接落库（不碰网络）② 未命中的才真的调端点 ③ 新算的回填缓存
            let (misses, reused) = self.apply_cached_vectors(&conn, pending_embed)?;
            vectors_reused = reused;
            if reused > 0 {
                self.set_progress(
                    root_hash,
                    "embedding",
                    file_count,
                    files_total,
                    chunk_count,
                    reused,
                );
            }
            if !misses.is_empty() {
                let inputs: Vec<(i64, String)> = misses
                    .iter()
                    .map(|(id, text, _)| (*id, text.clone()))
                    .collect();
                let hash_by_id: HashMap<i64, String> = misses
                    .iter()
                    .map(|(id, _, h)| (*id, h.clone()))
                    .collect();
                let rows = embedding::embed_batches(&self.embedding, &inputs).await?;
                vectors_embedded = self.store_embedded_vectors(
                    &conn,
                    rows,
                    &hash_by_id,
                    reused,
                    |written| {
                        self.set_progress(
                            root_hash,
                            "embedding",
                            file_count,
                            files_total,
                            chunk_count,
                            written,
                        );
                    },
                )?;
            }
        }
        let vector_count = count_vectors(&conn, root_hash)?;

        self.set_progress(
            root_hash,
            "finishing",
            file_count,
            files_total,
            chunk_count,
            vector_count,
        );

        let now = now_secs();

        // 元数据必须描述"库里真实存在的向量"：本次没建向量、但之前建的还在，就沿用旧
        // 签名；否则会出现 vectorCount>0 而 embedding_model=NULL，检索侧 `can_vector`
        // 判 false，整条向量通道静默消失。
        let (embedding_model, embed_dims) = if vector_count == 0 {
            (None, 0i64)
        } else if use_vectors {
            (Some(embed_sig), self.embedding.dimensions as i64)
        } else {
            (prev_embed_model.clone(), prev_embed_dims)
        };

        conn.execute(
            "INSERT INTO workspaces (root_hash, root_path, file_count, chunk_count, vector_count,
             indexed_at, indexing, embedding_model, embedding_dims, vectors_reused, vectors_embedded)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, ?7, ?8, ?9, ?10)
             ON CONFLICT(root_hash) DO UPDATE SET
               root_path = excluded.root_path,
               file_count = excluded.file_count,
               chunk_count = excluded.chunk_count,
               vector_count = excluded.vector_count,
               indexed_at = excluded.indexed_at,
               indexing = 0,
               embedding_model = excluded.embedding_model,
               embedding_dims = excluded.embedding_dims,
               vectors_reused = excluded.vectors_reused,
               vectors_embedded = excluded.vectors_embedded",
            params![
                root_hash,
                root.to_string_lossy(),
                file_count,
                chunk_count,
                vector_count,
                now,
                embedding_model,
                embed_dims,
                vectors_reused,
                vectors_embedded
            ],
        )
        .map_err(|e| CoreError::rpc("INDEX_FAILED", e.to_string()))?;

        // 向量有变化时重建池（池未加载时 refresh_pool 会直接返回）
        if vectors_changed {
            self.refresh_pool(&conn, root_hash);
        }

        Ok(())
    }

    pub async fn search(
        &self,
        workspace_root: &str,
        query: &str,
        limit: Option<u32>,
    ) -> Result<SearchResult, CoreError> {
        let ws = resolve_workspace(workspace_root)?;
        // 分两段用连接：中间要 await embedding，而常驻锁的 MutexGuard 拿不过 await。
        // `st` 在两段之间沿用同一份快照，与改造前「先取状态、再检索」的取值时机一致。
        let st = self.status_impl(&ws)?;

        let mut query_vector = None;
        let can_vector = self.embedding.enabled()
            && st.vector_count > 0
            && self.embedding.signature()
                == st.embedding_model.as_deref().unwrap_or("");
        if can_vector {
            let q = query.trim();
            if !q.is_empty() {
                let vectors =
                    embedding::embed_texts(&self.embedding, &[q.to_string()])
                        .await?;
                if let Some(vec) = vectors.into_iter().next() {
                    query_vector = Some(vec);
                }
            }
        }

        // 检索本体可能很慢（FTS + 向量全扫 + 池加载）：借一条**读池**连接，
        // 既不占常驻锁，也不无限开连接（并发检索超过池上限时排队）。
        let conn = self.read_conn()?;
        // 向量通道**只**走常驻内存池（全量精确余弦）。池装载失败时不退化成抽样近似——
        // 抽样会让同一查询在池暖/冷时给出不同答案，且召回率无处可测（见 search.rs 里的融合说明）。
        let pool = if query_vector.is_some() {
            self.vector_pool_for(&conn, &ws.root_hash)
        } else {
            None
        };
        search::search(
            &conn,
            &ws.root_hash,
            query,
            limit,
            query_vector.as_deref(),
            pool.as_deref(),
        )
    }
}

/// status 读路径发现的脏状态：读路径只发现不写库，由调用方用独立连接补写
/// （见 [`IndexService::status_impl`]）。
struct StatusRepair {
    file_count: i64,
    chunk_count: i64,
    indexed_at: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusResult {
    pub ok: bool,
    pub indexed: bool,
    pub file_count: i64,
    pub chunk_count: i64,
    pub vector_count: i64,
    pub indexed_at: i64,
    pub indexing: bool,
    pub embedding_model: Option<String>,
    pub embedding_dims: i64,
    /// 当前配置是否启用了向量（`embedding_enabled` + 库里实际签名 = 面板要展示的两件事）
    pub embedding_enabled: bool,
    /// 库里已有向量、但签名与**当前设置**不一致 ⇒ 语义检索会静默退化成名称匹配，建议重建
    pub embedding_stale: bool,
    /// 上一次建库中「按内容哈希复用」的向量条数（跨 worktree，见 `index/vector_cache.rs`）
    pub vectors_reused: i64,
    /// 上一次建库中真正调用 embedding 端点的条数
    pub vectors_embedded: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub phase: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub files_done: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub files_total: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartIndexResult {
    pub started: bool,
    pub already_running: bool,
    #[serde(flatten)]
    pub status: StatusResult,
}

/// chunk 写入的唯一入口（本机索引与远程摄取共用）。
///
/// 只写 `chunks` 一行：v4 起没有全文倒排表（`search.rs` 走子串扫描），`chunks` 是正文
/// 唯一来源；`chunk_vectors` 由调用方在拿到返回正文后单独写。
/// 空白片段不落库，返回 `None` 让调用方跳过；返回的正文与入库内容一致，可直接拿去算向量。
fn insert_chunk(
    conn: &Connection,
    root_hash: &str,
    rel_path: &str,
    start_line: i64,
    end_line: i64,
    slice: &str,
    mtime: i64,
) -> Result<Option<(i64, String)>, CoreError> {
    if slice.trim().is_empty() {
        return Ok(None);
    }
    let content = truncate_chars(slice, CHUNK_CONTENT_MAX_CHARS);
    conn.execute(
        "INSERT INTO chunks (root_hash, rel_path, start_line, end_line, content, mtime)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![root_hash, rel_path, start_line, end_line, content, mtime],
    )
    .map_err(|e| CoreError::rpc("INDEX_FAILED", e.to_string()))?;
    Ok(Some((conn.last_insert_rowid(), content.to_string())))
}

/// `chunk_vectors` 写入的唯一入口：缓存命中与真算命中走同一条 SQL，
/// 免得两条路径的 upsert 语义（dims 覆盖）出现偏差。
fn write_chunk_vector(conn: &Connection, chunk_id: i64, vec: &[f32]) -> Result<(), CoreError> {
    conn.execute(
        "INSERT INTO chunk_vectors (chunk_id, dims, vector) VALUES (?1, ?2, ?3)
         ON CONFLICT(chunk_id) DO UPDATE SET dims = excluded.dims, vector = excluded.vector",
        params![chunk_id, vec.len() as i64, embedding::vector_to_blob(vec)],
    )
    .map_err(|e| CoreError::rpc("INDEX_FAILED", e.to_string()))?;
    Ok(())
}

/// 当前 Unix 秒（时间戳的唯一来源）。
fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn delete_all_chunks(conn: &Connection, root_hash: &str) -> Result<(), CoreError> {
    conn.execute(
        "DELETE FROM chunk_vectors WHERE chunk_id IN (SELECT id FROM chunks WHERE root_hash = ?1)",
        params![root_hash],
    )
    .ok();
    conn.execute("DELETE FROM chunks WHERE root_hash = ?1", params![root_hash])
        .map_err(|e| CoreError::rpc("INDEX_FAILED", e.to_string()))?;
    Ok(())
}

fn delete_chunks_for_path(conn: &Connection, root_hash: &str, rel: &str) -> Result<(), CoreError> {
    conn.execute(
        "DELETE FROM chunk_vectors
         WHERE chunk_id IN (SELECT id FROM chunks WHERE root_hash = ?1 AND rel_path = ?2)",
        params![root_hash, rel],
    )
    .ok();
    conn.execute(
        "DELETE FROM chunks WHERE root_hash = ?1 AND rel_path = ?2",
        params![root_hash, rel],
    )
    .map_err(|e| CoreError::rpc("INDEX_FAILED", e.to_string()))?;
    Ok(())
}

fn load_chunk_mtimes(conn: &Connection, root_hash: &str) -> Result<HashMap<String, i64>, CoreError> {
    let mut stmt = conn
        .prepare("SELECT rel_path, MAX(mtime) FROM chunks WHERE root_hash = ?1 GROUP BY rel_path")
        .map_err(|e| CoreError::rpc("INDEX_FAILED", e.to_string()))?;
    let rows = stmt
        .query_map(params![root_hash], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))
        .map_err(|e| CoreError::rpc("INDEX_FAILED", e.to_string()))?;
    let mut map = HashMap::new();
    for row in rows {
        let (rel, mtime) = row.map_err(|e| CoreError::rpc("INDEX_FAILED", e.to_string()))?;
        map.insert(rel, mtime);
    }
    Ok(map)
}

fn purge_stale_chunk_paths(
    conn: &Connection,
    root_hash: &str,
    keep: &HashSet<String>,
) -> Result<(), CoreError> {
    let stored: Vec<String> = {
        let mut stmt = conn
            .prepare("SELECT DISTINCT rel_path FROM chunks WHERE root_hash = ?1")
            .map_err(|e| CoreError::rpc("INDEX_FAILED", e.to_string()))?;
        let rows = stmt
            .query_map(params![root_hash], |r| r.get(0))
            .map_err(|e| CoreError::rpc("INDEX_FAILED", e.to_string()))?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row.map_err(|e| CoreError::rpc("INDEX_FAILED", e.to_string()))?);
        }
        out
    };
    for rel in stored {
        if !keep.contains(&rel) {
            delete_chunks_for_path(conn, root_hash, &rel)?;
        }
    }
    Ok(())
}

fn count_chunks(conn: &Connection, root_hash: &str) -> Result<i64, CoreError> {
    conn.query_row(
        "SELECT COUNT(*) FROM chunks WHERE root_hash = ?1",
        params![root_hash],
        |r| r.get(0),
    )
    .map_err(|e| CoreError::rpc("INDEX_FAILED", e.to_string()))
}

fn count_vectors(conn: &Connection, root_hash: &str) -> Result<i64, CoreError> {
    conn.query_row(
        "SELECT COUNT(*) FROM chunk_vectors WHERE chunk_id IN (SELECT id FROM chunks WHERE root_hash = ?1)",
        params![root_hash],
        |r| r.get(0),
    )
    .map_err(|e| CoreError::rpc("INDEX_FAILED", e.to_string()))
}

fn load_all_chunk_texts(conn: &Connection, root_hash: &str) -> Result<Vec<(i64, String)>, CoreError> {
    let mut stmt = conn
        .prepare("SELECT id, content FROM chunks WHERE root_hash = ?1")
        .map_err(|e| CoreError::rpc("INDEX_FAILED", e.to_string()))?;
    let rows = stmt
        .query_map(params![root_hash], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))
        .map_err(|e| CoreError::rpc("INDEX_FAILED", e.to_string()))?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row.map_err(|e| CoreError::rpc("INDEX_FAILED", e.to_string()))?);
    }
    Ok(out)
}

fn load_chunks_missing_vectors(
    conn: &Connection,
    root_hash: &str,
) -> Result<Vec<(i64, String)>, CoreError> {
    let mut stmt = conn
        .prepare(
            "SELECT c.id, c.content FROM chunks c
             LEFT JOIN chunk_vectors v ON v.chunk_id = c.id
             WHERE c.root_hash = ?1 AND v.chunk_id IS NULL",
        )
        .map_err(|e| CoreError::rpc("INDEX_FAILED", e.to_string()))?;
    let rows = stmt
        .query_map(params![root_hash], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))
        .map_err(|e| CoreError::rpc("INDEX_FAILED", e.to_string()))?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row.map_err(|e| CoreError::rpc("INDEX_FAILED", e.to_string()))?);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::embedding::EmbeddingConfig;
    use tempfile::tempdir;

    #[test]
    fn mtime_uses_nanosecond_precision() {
        // 纳秒值：完全相等才算未变化
        assert!(mtime_unchanged(
            1_700_000_000_123_456_789,
            1_700_000_000_123_456_789
        ));
        // 同一秒内不同的纳秒：必须判为已变化（秒级精度会漏掉这种保存）
        assert!(!mtime_unchanged(
            1_700_000_000_123_456_789,
            1_700_000_000_123_456_790
        ));
        // 存量秒级记录：一律视为已变化，强制重建一次升级精度
        assert!(!mtime_unchanged(1_700_000_000, 1_700_000_000_123_456_789));
        assert!(!mtime_unchanged(1_700_000_000, 1_700_000_000));
    }

    #[tokio::test]
    async fn index_and_search_smoke() {
        let dir = tempdir().unwrap();
        std::fs::write(
            dir.path().join("hello.rs"),
            "fn main() {\n    println!(\"hello world\");\n}\n",
        )
        .unwrap();
        let db = dir.path().join("idx.sqlite");
        let svc = IndexService::new(
            crate::codebase_db::handle(db),
            EmbeddingConfig::default(),
        );
        let root = dir.path().to_string_lossy();
        let st = svc.index_workspace(&root, true, false).await.unwrap();
        assert!(st.indexed);
        assert!(st.chunk_count > 0);
        let sr = svc.search(&root, "hello", Some(5)).await.unwrap();
        assert!(!sr.results.is_empty());
    }

    #[tokio::test]
    async fn remote_index_from_files_smoke() {
        use crate::index::RemoteFileInput;

        let dir = tempdir().unwrap();
        let db = dir.path().join("idx.sqlite");
        let svc = IndexService::new(
            crate::codebase_db::handle(db),
            EmbeddingConfig::default(),
        );
        let key = "ssh://dev@192.168.1.10/home/dev/project";
        let files = vec![RemoteFileInput {
            rel_path: "hello.rs".into(),
            content: "fn main() {\n    println!(\"remote hello\");\n}\n".into(),
            mtime: 1,
        }];
        let st = svc.index_remote(key, files, true, false).await.unwrap();
        assert!(st.indexed);
        assert!(st.chunk_count > 0);
        let sr = svc.search(key, "remote hello", Some(5)).await.unwrap();
        assert!(!sr.results.is_empty());
    }

    /// 缓存命中时**一次 embedding 请求都不发**：第 ① 步只建 chunk，第 ② 步把每个 chunk 的
    /// 向量按 `run_index` 的算键方式预置进缓存，第 ③ 步带向量重建 —— 端点地址是必然连不上的
    /// `127.0.0.1:9`，所以只要复用逻辑失效（哪怕只漏一个 chunk），这个用例就会失败而不是静默变慢。
    ///
    /// 这就是 batch 6 的验收点：乙案（每会话一份索引库）+ 向量 不再是「每个新会话重算整仓」。
    #[tokio::test]
    async fn vectors_reuse_from_content_hash_cache_without_calling_endpoint() {
        let dir = tempdir().unwrap();
        std::fs::write(dir.path().join("a.rs"), "fn alpha() { let x = 1; }\n").unwrap();
        std::fs::write(dir.path().join("b.rs"), "fn beta() { let y = 2; }\n").unwrap();
        let db = dir.path().join("idx.sqlite");
        let root = dir.path().to_string_lossy().to_string();

        // 「已启用」但端点不可达：任何真实请求都会失败。
        let mut cfg = EmbeddingConfig::default();
        cfg.model = "test-embed".into();
        cfg.base_url = "http://127.0.0.1:9".into();
        cfg.dimensions = 3;
        assert!(cfg.enabled());

        // ① 只建 chunk（不带向量），拿到这一版 chunk 正文
        let svc = IndexService::new(crate::codebase_db::handle(db.clone()), cfg.clone());
        let st1 = svc.index_workspace(&root, true, false).await.unwrap();
        assert!(st1.chunk_count > 0);

        // ② 按 run_index 的方式算键，把向量预置进跨 worktree 缓存。
        //    键是 `cache_key()`（签名 + 端点），不是 `signature()`：缓存全局共享，
        //    两个提供商可能都叫同名的同名模型，端点必须进键。
        assert_ne!(cfg.cache_key(), cfg.signature());
        let cache_path = dir.path().join(vector_cache::CACHE_FILE_NAME);
        let seeded = {
            let cache = vector_cache::VectorCache::open(&cache_path).unwrap();
            let conn = Connection::open(&db).unwrap();
            let mut stmt = conn.prepare("SELECT content FROM chunks").unwrap();
            let texts: Vec<String> = stmt
                .query_map([], |r| r.get::<_, String>(0))
                .unwrap()
                .map(|r| r.unwrap())
                .collect();
            let rows: Vec<(String, Vec<f32>)> = texts
                .iter()
                .map(|t| {
                    (
                        vector_cache::content_hash(&embedding::embedding_input(t)),
                        vec![0.5f32, 0.25, 0.125],
                    )
                })
                .collect();
            cache.put_many(&cfg.cache_key(), &rows, 1).unwrap()
        };
        assert_eq!(seeded as i64, st1.chunk_count);

        // ③ 带向量重建：全部命中 ⇒ vectors_embedded 必须是 0
        let svc2 = IndexService::new(crate::codebase_db::handle(db.clone()), cfg.clone())
            .with_vector_cache(Some(cache_path));
        let st2 = svc2.index_workspace(&root, true, true).await.unwrap();
        assert_eq!(st2.vectors_embedded, 0, "全命中缓存时不该真的调 embedding");
        assert_eq!(
            st2.vectors_reused, st2.chunk_count,
            "每个 chunk 都该复用缓存里的向量"
        );
        assert_eq!(st2.vector_count, st2.chunk_count);
    }

    #[tokio::test]
    async fn index_incremental_skips_unchanged_and_updates_changed() {
        let dir = tempdir().unwrap();
        let a = dir.path().join("a.rs");
        let b = dir.path().join("b.rs");
        std::fs::write(&a, "fn a() { /* keep */ }\n").unwrap();
        std::fs::write(&b, "fn b() { /* old */ }\n").unwrap();
        let db = dir.path().join("idx.sqlite");
        let svc = IndexService::new(
            crate::codebase_db::handle(db),
            EmbeddingConfig::default(),
        );
        let root = dir.path().to_string_lossy();
        let st1 = svc.index_workspace(&root, true, false).await.unwrap();
        assert!(st1.indexed);
        assert!(st1.chunk_count >= 2);
        let c1 = st1.chunk_count;

        // 不变 → 增量后 chunk 数不变
        let st2 = svc.index_workspace(&root, false, false).await.unwrap();
        assert!(st2.indexed);
        assert_eq!(st2.chunk_count, c1);

        // 改一个文件 → 仍可搜到新内容
        std::thread::sleep(std::time::Duration::from_millis(1100));
        std::fs::write(&b, "fn b() { /* unique_token_xyz */ }\n").unwrap();
        let st3 = svc.index_workspace(&root, false, false).await.unwrap();
        assert!(st3.indexed);
        let sr = svc.search(&root, "unique_token_xyz", Some(5)).await.unwrap();
        assert!(!sr.results.is_empty());
    }

    /// 回归：`vectors=false` 只该表示「这次不建向量」，**不能**把已有向量删掉。
    ///
    /// 旧实现把两者混为一谈（`if !use_vectors { DELETE FROM chunk_vectors ... }`），于是
    /// 面板「重建片段」、增量建库、prep 首次建库任意一次都会清空整库向量 —— 用户花几分钟
    /// 建好的向量一次保存就没，面板回到「0（子串检索）」，自然得出「向量没用」的结论。
    #[tokio::test]
    async fn rebuild_without_vectors_keeps_existing_vectors() {
        let dir = tempdir().unwrap();
        std::fs::write(dir.path().join("a.rs"), "fn a() { /* keep */ }\n").unwrap();
        let db = dir.path().join("idx.sqlite");
        let handle = crate::codebase_db::handle(db);
        let svc = IndexService::new(Arc::clone(&handle), EmbeddingConfig::default());
        let root = dir.path().to_string_lossy().to_string();
        let ws = resolve_workspace(&root).unwrap();

        let st = svc.index_workspace(&root, true, false).await.unwrap();
        assert!(st.chunk_count > 0);

        // 造出「库里已有向量」的状态（不依赖真实 embedding 端点）
        const SIG: &str = "test-embed@3";
        let seeded = handle
            .with_conn(|conn| {
                let ids: Vec<i64> = conn
                    .prepare("SELECT id FROM chunks WHERE root_hash = ?1")
                    .map_err(|e| CoreError::rpc("TEST_SEED", e.to_string()))?
                    .query_map(params![ws.root_hash], |r| r.get(0))
                    .map_err(|e| CoreError::rpc("TEST_SEED", e.to_string()))?
                    .collect::<Result<Vec<_>, _>>()
                    .map_err(|e| CoreError::rpc("TEST_SEED", e.to_string()))?;
                for id in &ids {
                    let blob = crate::embedding::vector_to_blob(&[1.0f32, 0.0, 0.0]);
                    conn.execute(
                        "INSERT INTO chunk_vectors (chunk_id, dims, vector) VALUES (?1, 3, ?2)",
                        params![id, blob],
                    )
                    .map_err(|e| CoreError::rpc("TEST_SEED", e.to_string()))?;
                }
                conn.execute(
                    "UPDATE workspaces SET vector_count = ?2, embedding_model = ?3,
                                           embedding_dims = 3
                     WHERE root_hash = ?1",
                    params![ws.root_hash, ids.len() as i64, SIG],
                )
                .map_err(|e| CoreError::rpc("TEST_SEED", e.to_string()))?;
                Ok(ids.len() as i64)
            })
            .expect("seed vectors");
        assert!(seeded > 0);

        // 增量建库、这次不要向量
        let st2 = svc.index_workspace(&root, false, false).await.unwrap();
        assert_eq!(
            st2.vector_count, seeded,
            "vectors=false 不得清空已有向量（否则语义检索会无声消失）"
        );
        assert_eq!(
            st2.embedding_model.as_deref(),
            Some(SIG),
            "签名元数据必须沿用到库里真实存在的向量，不能抹成 NULL"
        );
        assert_eq!(st2.embedding_dims, 3, "维度不能被抹成 0");
    }

    /// RPC 入口用 `vectors_available()` 决定「要求向量但端点没配」要不要报
    /// `EMBEDDING_NOT_CONFIGURED`。判据必须与 `EmbeddingConfig::enabled` 完全一致：
    /// 只有「没被禁用 + model + base_url 都非空」才算可用，缺一项就不该假装配好了。
    #[test]
    fn vectors_available_follows_embedding_config() {
        let dir = tempdir().unwrap();
        let off = IndexService::new(
            crate::codebase_db::handle(dir.path().join("a.sqlite")),
            EmbeddingConfig::default(),
        );
        assert!(!off.vectors_available(), "默认配置（空 model/base_url）不可用");

        let mut only_model = EmbeddingConfig::default();
        only_model.model = "text-embedding-3-small".into();
        let half = IndexService::new(
            crate::codebase_db::handle(dir.path().join("b.sqlite")),
            only_model,
        );
        assert!(!half.vectors_available(), "只有 model、没有 base_url 仍不可用");

        let mut disabled = EmbeddingConfig::default();
        disabled.model = "text-embedding-3-small".into();
        disabled.base_url = "https://api.example.com/v1".into();
        disabled.disabled = true;
        let off2 = IndexService::new(
            crate::codebase_db::handle(dir.path().join("c.sqlite")),
            disabled,
        );
        assert!(!off2.vectors_available(), "显式禁用时不可用");

        let mut on = EmbeddingConfig::default();
        on.model = "text-embedding-3-small".into();
        on.base_url = "https://api.example.com/v1".into();
        let svc = IndexService::new(crate::codebase_db::handle(dir.path().join("d.sqlite")), on);
        assert!(svc.vectors_available());
    }

    /// status 是**纯读**：哪怕库里有崩溃残留（`indexing=1`、元数据残缺）且另一个连接
    /// 正占着写事务，也必须秒回 —— 否则面板轮询会一路撞到 45s 超时。
    #[test]
    fn status_is_pure_read_and_never_waits_on_writer() {
        let dir = tempdir().unwrap();
        let db = dir.path().join("idx.sqlite");
        let handle = crate::codebase_db::handle(db);
        let svc = IndexService::new(
            Arc::clone(&handle),
            EmbeddingConfig::default(),
        );
        let root = dir.path().to_string_lossy().to_string();
        let ws = resolve_workspace(&root).unwrap();

        // 造脏状态：indexing=1、元数据全 0，但 chunks 里其实有 2 条
        handle
            .with_conn(|conn| {
                conn.execute(
                    "INSERT INTO workspaces (root_hash, root_path, indexing) VALUES (?1, ?2, 1)",
                    params![ws.root_hash, &root],
                )
                .map_err(|e| CoreError::rpc("TEST_SEED", e.to_string()))?;
                for _ in 0..2 {
                    conn.execute(
                        "INSERT INTO chunks (root_hash, rel_path, start_line, end_line, content, mtime)
                         VALUES (?1, 'a.rs', 1, 2, 'x', 0)",
                        params![ws.root_hash],
                    )
                    .map_err(|e| CoreError::rpc("TEST_SEED", e.to_string()))?;
                }
                Ok(())
            })
            .expect("seed stale workspace");

        let writer = handle.open_dedicated().expect("open writer");
        writer
            .execute_batch(
                "BEGIN IMMEDIATE;
                 INSERT INTO chunks (root_hash, rel_path, start_line, end_line, content, mtime)
                 VALUES ('other', 'b.rs', 1, 2, 'y', 0);",
            )
            .expect("hold write transaction");

        let started = std::time::Instant::now();
        let st = svc.status(&root).expect("status");
        let elapsed = started.elapsed();

        writer.execute_batch("ROLLBACK").expect("rollback");
        drop(writer);

        assert!(!st.indexing, "没人在跑索引时不应报 indexing");
        assert_eq!(st.chunk_count, 2, "读路径应就地算出真实 chunk 数");
        assert!(st.indexed, "indexed_at 应被补上");
        assert!(
            elapsed < std::time::Duration::from_secs(1),
            "status 等了 {elapsed:?}：读路径又被写锁堵住了"
        );
    }

    /// force 重建期间崩溃（chunks 已清空、counts 还没写回）不能伪装成「已索引」：
    /// 否则 status 说「已索引 N 段」、search 又绕过 needsIndex 门槛，静默返回 0 条。
    #[tokio::test]
    async fn status_zeroes_counts_when_chunks_were_cleared_but_metadata_is_stale() {
        let dir = tempdir().unwrap();
        let db = dir.path().join("idx.sqlite");
        let handle = crate::codebase_db::handle(db);
        let svc = IndexService::new(
            Arc::clone(&handle),
            EmbeddingConfig::default(),
        );
        let root = dir.path().to_string_lossy().to_string();
        let ws = resolve_workspace(&root).unwrap();

        // 元数据是上一轮的满值，chunks 表却已经空（重建半途崩）
        handle
            .with_conn(|conn| {
                conn.execute(
                    "INSERT INTO workspaces (root_hash, root_path, indexing, chunk_count, file_count,
                                             indexed_at)
                     VALUES (?1, ?2, 0, 42, 7, 1700000000)",
                    params![ws.root_hash, &root],
                )
                .map_err(|e| CoreError::rpc("TEST_SEED", e.to_string()))?;
                Ok(())
            })
            .expect("seed stale counts");

        let st = svc.status(&root).expect("status");
        assert_eq!(st.chunk_count, 0, "库里没内容就不能报旧 chunk 数");
        assert_eq!(st.file_count, 0);
        assert!(!st.indexed, "内容没了应判为需要重建");
        let sr = svc.search(&root, "anything", Some(5)).await.unwrap();
        assert_eq!(sr.needs_index, Some(true), "search 应提示需要重建索引");
    }

    /// 面板展示的三件事：库里的向量模型、维度、以及「是否与当前设置一致」。
    ///
    /// 前两者必须取**库里实际写入**的值（而不是当前设置），一致性才用当前设置比对。
    #[test]
    fn status_reports_vector_model_dims_and_staleness() {
        let dir = tempdir().unwrap();
        let db = dir.path().join("idx.sqlite");
        let handle = crate::codebase_db::handle(db);
        let mut cfg = EmbeddingConfig::default();
        cfg.model = "test-model".into();
        cfg.base_url = "http://127.0.0.1:1".into();
        cfg.dimensions = 768;
        let svc = IndexService::new(Arc::clone(&handle), cfg);
        let root = dir.path().to_string_lossy().to_string();
        let ws = resolve_workspace(&root).unwrap();

        handle
            .with_conn(|conn| {
                conn.execute(
                    "INSERT INTO workspaces (root_hash, root_path, indexing, embedding_model,
                                             embedding_dims, vector_count, chunk_count, file_count, indexed_at)
                     VALUES (?1, ?2, 0, 'builtin:bge-base-zh-v1.5@768', 768, 10, 10, 3, 1700000000)",
                    params![ws.root_hash, &root],
                )
                .map_err(|e| CoreError::rpc("TEST_SEED", e.to_string()))?;
                Ok(())
            })
            .expect("seed workspace");

        let st = svc.status(&root).expect("status");
        assert_eq!(
            st.embedding_model.as_deref(),
            Some("builtin:bge-base-zh-v1.5@768"),
            "模型取库里实际写入的签名"
        );
        assert_eq!(st.embedding_dims, 768, "维度取库里实际写入的值");
        assert!(st.embedding_enabled);
        assert!(st.embedding_stale, "库里是别的模型，应判为与当前设置不一致");

        // 换成与当前设置一致的签名：不再报警
        handle
            .with_conn(|conn| {
                conn.execute(
                    "UPDATE workspaces SET embedding_model = 'test-model@768' WHERE root_hash = ?1",
                    params![ws.root_hash],
                )
                .map_err(|e| CoreError::rpc("TEST_SEED", e.to_string()))?;
                Ok(())
            })
            .expect("update model");
        let st2 = svc.status(&root).expect("status");
        assert!(!st2.embedding_stale, "一致时不应提示重建");
    }

    #[test]
    fn start_index_returns_immediately() {
        let dir = tempdir().unwrap();
        std::fs::write(dir.path().join("a.js"), "console.log('a');\n").unwrap();
        let db = dir.path().join("idx.sqlite");
        let svc = IndexService::new(
            crate::codebase_db::handle(db),
            EmbeddingConfig::default(),
        );
        let root = dir.path().to_string_lossy().to_string();
        let started = svc.start_index_workspace(&root, true, true, false).unwrap();
        assert!(started.started);
        assert!(started.status.indexing);
        assert_eq!(started.status.phase.as_deref(), Some("walking"));
        // 给后台线程一点时间；不强制 join，避免阻塞 CI
        std::thread::sleep(std::time::Duration::from_millis(300));
        let again = svc.start_index_workspace(&root, true, true, false).unwrap();
        // 要么仍在跑要么已完成
        assert!(again.already_running || again.status.indexed || again.started || !again.status.indexing);
    }
}

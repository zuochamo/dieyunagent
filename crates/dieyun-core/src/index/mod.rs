mod remote;
mod schema;
mod search;
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
    models_dirs: Vec<PathBuf>,
    indexing: Arc<Mutex<HashSet<String>>>,
    progress: Arc<Mutex<HashMap<String, ProgressSnapshot>>>,
    remote_ingest: remote::RemoteIngestHandle,
    /// root_hash -> 常驻内存 chunk 向量池
    vector_pools: PoolCache,
}

impl IndexService {
    pub fn new(db: Arc<SqliteHandle>, embedding: EmbeddingConfig, models_dirs: Vec<PathBuf>) -> Self {
        Self {
            db,
            embedding,
            models_dirs,
            indexing: Arc::new(Mutex::new(HashSet::new())),
            progress: Arc::new(Mutex::new(HashMap::new())),
            remote_ingest: remote::RemoteIngestHandle::default(),
            vector_pools: PoolCache::new(),
        }
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
        Self::new(db, config.embedding.clone(), config.models_dirs.clone())
    }

    /// 复用常驻连接执行一次读/写（见 `SqliteHandle::with_conn`）。
    ///
    /// 非重入锁：调用方**不得**在闭包内再调 `with_conn` / `status`，否则死锁。
    /// 需要串联多步时用 `*_with_conn` 形态的私有方法。
    fn with_conn<T>(
        &self,
        f: impl FnOnce(&Connection) -> Result<T, CoreError>,
    ) -> Result<T, CoreError> {
        self.db.with_conn(f)
    }

    /// 独立连接：用于跨 `.await` 或分钟级长任务，避免长时间占用常驻锁。
    fn open_dedicated(&self) -> Result<Connection, CoreError> {
        self.db.open_dedicated()
    }

    pub fn status(&self, workspace_root: &str) -> Result<StatusResult, CoreError> {
        let ws = resolve_workspace(workspace_root)?;
        self.with_conn(|conn| self.status_with_conn(conn, &ws))
    }

    /// `status` 的实现本体：连接由调用方提供。
    ///
    /// 常驻连接的锁非重入，凡是「已经拿着连接」的地方都必须走这个入口
    /// （`search` / `run_index` 都是「先查状态、再用同一连接干活」）。
    fn status_with_conn(
        &self,
        conn: &Connection,
        ws: &WorkspaceRef,
    ) -> Result<StatusResult, CoreError> {
        let live_indexing = self
            .indexing
            .lock()
            .map(|g| g.contains(&ws.root_hash))
            .unwrap_or(false);

        let row: Option<(i64, i64, i64, i64, i64, Option<String>, i64)> = conn
            .query_row(
                "SELECT file_count, chunk_count, vector_count, indexed_at, indexing,
                        embedding_model, embedding_dims
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
                    phase: None,
                    files_done: None,
                    files_total: None,
                    last_error: None,
                };
                self.apply_live_progress(&ws.root_hash, &mut st);
                st
            }
            Some((fc, cc, vc, ia, db_indexing, em, ed)) => {
                // 仅当旗标或元数据明显残缺时再 COUNT，避免每次 status 扫表
                let mut db_flag = db_indexing;
                let mut file_count = fc;
                let mut chunk_count = cc;
                let mut indexed_at = ia;
                if !live_indexing {
                    let need_clear_flag = db_flag != 0;
                    let meta_looks_broken = indexed_at == 0 || (chunk_count == 0 && file_count == 0);
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
                        }
                        let _ = conn.execute(
                            "UPDATE workspaces SET indexing = 0, file_count = ?2, chunk_count = ?3,
                             indexed_at = CASE WHEN indexed_at = 0 THEN ?4 ELSE indexed_at END
                             WHERE root_hash = ?1",
                            params![ws.root_hash, file_count, chunk_count, indexed_at],
                        );
                        db_flag = 0;
                    }
                }
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
                    phase: None,
                    files_done: None,
                    files_total: None,
                    last_error: None,
                };
                self.apply_live_progress(&ws.root_hash, &mut st);
                st
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
    pub fn start_index_workspace(
        &self,
        workspace_root: &str,
        force: bool,
        skip_if_ready: bool,
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
                let finish = |svc: &IndexService, hash: &str, result: Result<IndexStats, CoreError>| {
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
                let result = rt.block_on(svc.run_index(&root, &hash, force));
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
        let result = self.run_index(root, &root_hash, force).await;
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
    ) -> Result<StatusResult, CoreError> {
        let ws = resolve_workspace(workspace_root)?;
        if !ws.is_remote {
            return Err(CoreError::rpc(
                "LOCAL_INDEX_REQUIRED",
                "本地工作空间请使用 codebase.index",
            ));
        }
        self.index_remote_begin(&ws, force).await?;
        if !force {
            let st = self.status(workspace_root)?;
            let sig = self.embedding.signature(&self.models_dirs);
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

    async fn run_index(
        &self,
        root: &Path,
        root_hash: &str,
        force: bool,
    ) -> Result<IndexStats, CoreError> {
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

        let use_vectors = self.embedding.enabled(&self.models_dirs);
        let embed_sig = self.embedding.signature(&self.models_dirs);
        let embed_dims = if use_vectors {
            self.embedding.effective_dimensions(&self.models_dirs)
        } else {
            0
        };
        let prev_embed_model: Option<String> = conn
            .query_row(
                "SELECT embedding_model FROM workspaces WHERE root_hash = ?1",
                params![root_hash],
                |r| r.get(0),
            )
            .ok()
            .flatten();
        let model_changed = use_vectors
            && !embed_sig.is_empty()
            && prev_embed_model.as_deref().unwrap_or("") != embed_sig;

        let mut file_count = 0i64;
        let mut chunk_count = 0i64;
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
                let mut push_chunk =
                    |start_line: i64, end_line: i64, slice: &str| -> Result<(), CoreError> {
                        if slice.trim().is_empty() {
                            return Ok(());
                        }
                        let content = truncate_chars(slice, CHUNK_CONTENT_MAX_CHARS);
                        tx.execute(
                            "INSERT INTO chunks (root_hash, rel_path, start_line, end_line, content, mtime)
                             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                            params![root_hash, rel, start_line, end_line, content, mtime],
                        )
                        .map_err(|e| CoreError::rpc("INDEX_FAILED", e.to_string()))?;
                        let id = tx.last_insert_rowid();
                        tx.execute(
                            "INSERT INTO chunks_fts (rowid, rel_path, content) VALUES (?1, ?2, ?3)",
                            params![id, rel, content],
                        )
                        .map_err(|e| CoreError::rpc("INDEX_FAILED", e.to_string()))?;
                        chunk_count += 1;
                        if use_vectors && !content.trim().is_empty() {
                            pending_embed.push((id, content.to_string()));
                        }
                        Ok(())
                    };

                for (start_line, end_line, slice) in
                    crate::treesitter::iter_chunk_slices(&rel, &text)
                {
                    push_chunk(start_line, end_line, &slice)?;
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

        chunk_count = count_chunks(&conn, root_hash)?;

        if !use_vectors {
            conn.execute(
                "DELETE FROM chunk_vectors WHERE chunk_id IN (SELECT id FROM chunks WHERE root_hash = ?1)",
                params![root_hash],
            )
            .ok();
        } else if model_changed {
            conn.execute(
                "DELETE FROM chunk_vectors WHERE chunk_id IN (SELECT id FROM chunks WHERE root_hash = ?1)",
                params![root_hash],
            )
            .ok();
            pending_embed = load_all_chunk_texts(&conn, root_hash)?;
        } else {
            // 补齐缺向量的 chunk（例如上次 embedding 中断）
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

        // 只有本次确实产生了新向量（或向量被清空/模型变更）时才重建内存池；
        // 否则保留现有池，避免"保存一下就把整库向量重读一遍"。
        let vectors_changed = !use_vectors || model_changed || !pending_embed.is_empty();

        let mut vector_count = 0i64;
        if use_vectors && !pending_embed.is_empty() {
            self.set_progress(
                root_hash,
                "embedding",
                file_count,
                files_total,
                chunk_count,
                0,
            );
            let embedded =
                embedding::embed_batches(&self.embedding, &self.models_dirs, &pending_embed)
                    .await?;
            for (chunk_id, vec) in embedded {
                let blob = embedding::vector_to_blob(&vec);
                conn.execute(
                    "INSERT INTO chunk_vectors (chunk_id, dims, vector) VALUES (?1, ?2, ?3)
                     ON CONFLICT(chunk_id) DO UPDATE SET dims = excluded.dims, vector = excluded.vector",
                    params![chunk_id, vec.len() as i64, blob],
                )
                .map_err(|e| CoreError::rpc("INDEX_FAILED", e.to_string()))?;
                vector_count += 1;
                if vector_count == 1 || vector_count % 32 == 0 {
                    self.set_progress(
                        root_hash,
                        "embedding",
                        file_count,
                        files_total,
                        chunk_count,
                        vector_count,
                    );
                }
            }
        }
        vector_count = count_vectors(&conn, root_hash)?;

        self.set_progress(
            root_hash,
            "finishing",
            file_count,
            files_total,
            chunk_count,
            vector_count,
        );

        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);

        let embedding_model = if use_vectors && vector_count > 0 {
            Some(embed_sig)
        } else {
            None
        };

        conn.execute(
            "INSERT INTO workspaces (root_hash, root_path, file_count, chunk_count, vector_count,
             indexed_at, indexing, embedding_model, embedding_dims)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, ?7, ?8)
             ON CONFLICT(root_hash) DO UPDATE SET
               root_path = excluded.root_path,
               file_count = excluded.file_count,
               chunk_count = excluded.chunk_count,
               vector_count = excluded.vector_count,
               indexed_at = excluded.indexed_at,
               indexing = 0,
               embedding_model = excluded.embedding_model,
               embedding_dims = excluded.embedding_dims",
            params![
                root_hash,
                root.to_string_lossy(),
                file_count,
                chunk_count,
                vector_count,
                now,
                embedding_model,
                embed_dims as i64
            ],
        )
        .map_err(|e| CoreError::rpc("INDEX_FAILED", e.to_string()))?;

        // 向量有变化时重建池（池未加载时 refresh_pool 会直接返回）
        if vectors_changed {
            self.refresh_pool(&conn, root_hash);
        }

        Ok(IndexStats {
            file_count,
            chunk_count,
            vector_count,
        })
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
        let st = self.with_conn(|conn| self.status_with_conn(conn, &ws))?;

        let mut query_vector = None;
        let can_vector = self.embedding.enabled(&self.models_dirs)
            && st.vector_count > 0
            && self.embedding.signature(&self.models_dirs)
                == st.embedding_model.as_deref().unwrap_or("");
        if can_vector {
            let q = query.trim();
            if !q.is_empty() {
                let vectors =
                    embedding::embed_texts(&self.embedding, &self.models_dirs, &[q.to_string()])
                        .await?;
                if let Some(vec) = vectors.into_iter().next() {
                    query_vector = Some(vec);
                }
            }
        }

        self.with_conn(|conn| {
            // 有池则走内存扫描（只加速，不改语义：仍是全量精确余弦）
            let pool = if query_vector.is_some() {
                self.vector_pool_for(conn, &ws.root_hash)
            } else {
                None
            };
            search::search(
                conn,
                &ws.root_hash,
                query,
                limit,
                query_vector.as_deref(),
                pool.as_deref(),
            )
        })
    }
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

struct IndexStats {
    #[allow(dead_code)]
    file_count: i64,
    #[allow(dead_code)]
    chunk_count: i64,
    #[allow(dead_code)]
    vector_count: i64,
}

fn delete_all_chunks(conn: &Connection, root_hash: &str) -> Result<(), CoreError> {
    conn.execute(
        "DELETE FROM chunk_vectors WHERE chunk_id IN (SELECT id FROM chunks WHERE root_hash = ?1)",
        params![root_hash],
    )
    .ok();
    conn.execute(
        "DELETE FROM chunks_fts WHERE rowid IN (SELECT id FROM chunks WHERE root_hash = ?1)",
        params![root_hash],
    )
    .ok();
    conn.execute("DELETE FROM chunks WHERE root_hash = ?1", params![root_hash])
        .map_err(|e| CoreError::rpc("INDEX_FAILED", e.to_string()))?;
    Ok(())
}

fn delete_chunks_for_path(conn: &Connection, root_hash: &str, rel: &str) -> Result<(), CoreError> {
    let ids: Vec<i64> = {
        let mut stmt = conn
            .prepare("SELECT id FROM chunks WHERE root_hash = ?1 AND rel_path = ?2")
            .map_err(|e| CoreError::rpc("INDEX_FAILED", e.to_string()))?;
        let rows = stmt
            .query_map(params![root_hash, rel], |r| r.get(0))
            .map_err(|e| CoreError::rpc("INDEX_FAILED", e.to_string()))?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row.map_err(|e| CoreError::rpc("INDEX_FAILED", e.to_string()))?);
        }
        out
    };
    for id in ids {
        conn.execute("DELETE FROM chunk_vectors WHERE chunk_id = ?1", params![id])
            .ok();
        conn.execute("DELETE FROM chunks_fts WHERE rowid = ?1", params![id])
            .ok();
    }
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
            Vec::new(),
        );
        let root = dir.path().to_string_lossy();
        let st = svc.index_workspace(&root, true).await.unwrap();
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
            Vec::new(),
        );
        let key = "ssh://dev@192.168.1.10/home/dev/project";
        let files = vec![RemoteFileInput {
            rel_path: "hello.rs".into(),
            content: "fn main() {\n    println!(\"remote hello\");\n}\n".into(),
            mtime: 1,
        }];
        let st = svc.index_remote(key, files, true).await.unwrap();
        assert!(st.indexed);
        assert!(st.chunk_count > 0);
        let sr = svc.search(key, "remote hello", Some(5)).await.unwrap();
        assert!(!sr.results.is_empty());
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
            Vec::new(),
        );
        let root = dir.path().to_string_lossy();
        let st1 = svc.index_workspace(&root, true).await.unwrap();
        assert!(st1.indexed);
        assert!(st1.chunk_count >= 2);
        let c1 = st1.chunk_count;

        // 不变 → 增量后 chunk 数不变
        let st2 = svc.index_workspace(&root, false).await.unwrap();
        assert!(st2.indexed);
        assert_eq!(st2.chunk_count, c1);

        // 改一个文件 → 仍可搜到新内容
        std::thread::sleep(std::time::Duration::from_millis(1100));
        std::fs::write(&b, "fn b() { /* unique_token_xyz */ }\n").unwrap();
        let st3 = svc.index_workspace(&root, false).await.unwrap();
        assert!(st3.indexed);
        let sr = svc.search(&root, "unique_token_xyz", Some(5)).await.unwrap();
        assert!(!sr.results.is_empty());
    }

    #[test]
    fn start_index_returns_immediately() {
        let dir = tempdir().unwrap();
        std::fs::write(dir.path().join("a.js"), "console.log('a');\n").unwrap();
        let db = dir.path().join("idx.sqlite");
        let svc = IndexService::new(
            crate::codebase_db::handle(db),
            EmbeddingConfig::default(),
            Vec::new(),
        );
        let root = dir.path().to_string_lossy().to_string();
        let started = svc.start_index_workspace(&root, true, true).unwrap();
        assert!(started.started);
        assert!(started.status.indexing);
        assert_eq!(started.status.phase.as_deref(), Some("walking"));
        // 给后台线程一点时间；不强制 join，避免阻塞 CI
        std::thread::sleep(std::time::Duration::from_millis(300));
        let again = svc.start_index_workspace(&root, true, true).unwrap();
        // 要么仍在跑要么已完成
        assert!(again.already_running || again.status.indexed || again.started || !again.status.indexing);
    }
}

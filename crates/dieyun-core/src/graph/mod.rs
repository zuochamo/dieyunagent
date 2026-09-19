mod build;
mod embed;
mod extract;
mod lsp_ingest;
mod query;
mod schema;
pub(crate) mod types;

pub use schema::ensure_schema;
pub use types::{IngestLspResult, LspCallSiteIn};

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use rusqlite::{params, Connection};

use crate::config::AppConfig;
use crate::embedding::{self, EmbeddingConfig};
use crate::error::CoreError;
use crate::graph::build::{run_build_with_progress, run_remote_build};
use crate::graph::embed::run_embed_symbols;
use crate::graph::lsp_ingest::ingest_lsp_callers;
use crate::graph::query::{
    callees, callers, impact, module_deps, repo_map, symbol_search, symbol_semantic_search,
};
use crate::graph::types::{
    CallGraphResult, GraphStartIndexResult, GraphStatusResult, ImpactResult, ModuleDepsResult,
    RepoMapResult, SymbolSearchResult,
};
use crate::index::vector_pool::{PoolCache, VectorPool};
use crate::index::{resolve_workspace, RemoteFileInput, WorkspaceRef};
use crate::sqlite::SqliteHandle;

#[derive(Debug, Clone, Default)]
struct GraphProgressSnapshot {
    phase: String,
    files_done: i64,
    files_total: i64,
    edge_count: i64,
    symbol_count: i64,
    call_count: i64,
    last_error: Option<String>,
}

#[derive(Clone)]
pub struct GraphService {
    /// codebase.db 句柄：与 `IndexService` 共享同一条常驻连接（同库，故同连接）。
    db: Arc<SqliteHandle>,
    embedding: EmbeddingConfig,
    models_dirs: Vec<PathBuf>,
    building: Arc<Mutex<HashSet<String>>>,
    embedding_symbols: Arc<Mutex<HashSet<String>>>,
    remote_files: Arc<Mutex<HashMap<String, Vec<RemoteFileInput>>>>,
    progress: Arc<Mutex<HashMap<String, GraphProgressSnapshot>>>,
    /// root_hash -> 常驻内存符号向量池
    symbol_pools: PoolCache,
}

impl GraphService {
    pub fn new(db: Arc<SqliteHandle>, embedding: EmbeddingConfig, models_dirs: Vec<PathBuf>) -> Self {
        Self {
            db,
            embedding,
            models_dirs,
            building: Arc::new(Mutex::new(HashSet::new())),
            embedding_symbols: Arc::new(Mutex::new(HashSet::new())),
            remote_files: Arc::new(Mutex::new(HashMap::new())),
            progress: Arc::new(Mutex::new(HashMap::new())),
            symbol_pools: PoolCache::new(),
        }
    }

    /// 取工作区的符号向量池：命中刷新 LRU，否则从 SQLite 全量载入。
    /// 池只是加速层，加载失败返回 None，调用方回退到 SQL 路径。
    fn symbol_pool_for(&self, conn: &Connection, root_hash: &str) -> Option<Arc<VectorPool>> {
        if let Some(pool) = self.symbol_pools.get(root_hash) {
            return Some(pool);
        }
        let pool = Arc::new(VectorPool::load_symbols(conn, root_hash).ok().flatten()?);
        self.symbol_pools.insert(root_hash, Arc::clone(&pool));
        Some(pool)
    }

    /// 符号向量写回后重建池（仅当该工作区已加载过）。
    fn refresh_symbol_pool(&self, conn: &Connection, root_hash: &str) {
        if !self.symbol_pools.contains(root_hash) {
            return;
        }
        match VectorPool::load_symbols(conn, root_hash) {
            Ok(Some(p)) => self.symbol_pools.insert(root_hash, Arc::new(p)),
            _ => self.symbol_pools.remove(root_hash),
        }
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

    pub fn embedding_enabled(&self) -> bool {
        self.embedding.enabled(&self.models_dirs)
    }

    pub fn embedding_signature(&self) -> String {
        self.embedding.signature(&self.models_dirs)
    }


    fn set_progress(
        &self,
        root_hash: &str,
        phase: &str,
        files_done: i64,
        files_total: i64,
        edge_count: i64,
        symbol_count: i64,
        call_count: i64,
    ) {
        if let Ok(mut guard) = self.progress.lock() {
            let entry = guard.entry(root_hash.to_string()).or_default();
            entry.phase = phase.to_string();
            entry.files_done = files_done;
            entry.files_total = files_total;
            entry.edge_count = edge_count;
            entry.symbol_count = symbol_count;
            entry.call_count = call_count;
            entry.last_error = None;
        }
    }

    fn set_progress_error(&self, root_hash: &str, err: &str) {
        if let Ok(mut guard) = self.progress.lock() {
            let entry = guard.entry(root_hash.to_string()).or_default();
            entry.phase = "error".into();
            entry.last_error = Some(err.to_string());
        }
    }

    fn clear_progress(&self, root_hash: &str) {
        if let Ok(mut guard) = self.progress.lock() {
            guard.remove(root_hash);
        }
    }

    fn apply_live_progress(&self, root_hash: &str, st: &mut GraphStatusResult) {
        if let Ok(guard) = self.progress.lock() {
            if let Some(p) = guard.get(root_hash) {
                if !p.phase.is_empty() {
                    st.phase = Some(p.phase.clone());
                }
                if p.files_total > 0 || p.files_done > 0 {
                    st.files_done = Some(p.files_done);
                    st.files_total = Some(p.files_total);
                }
                if p.edge_count > st.edge_count {
                    st.edge_count = p.edge_count;
                }
                if p.symbol_count > st.symbol_count {
                    st.symbol_count = p.symbol_count;
                }
                if p.call_count > st.call_count {
                    st.call_count = p.call_count;
                }
                if let Some(err) = p.last_error.clone() {
                    st.last_error = Some(err);
                }
            }
        }
    }

    pub fn status(&self, workspace_root: &str) -> Result<GraphStatusResult, CoreError> {
        let ws = resolve_workspace(workspace_root)?;
        self.with_conn(|conn| self.status_with_conn(conn, &ws))
    }

    /// `status` 的实现本体：连接由调用方提供。
    ///
    /// 常驻连接的锁非重入，凡是「已经拿着连接」的地方都必须走这个入口 ——
    /// `module_deps` / `repo_map` / `symbol_search` / `callers` / `callees` / `impact`
    /// 都是「先查状态、再用同一连接查数据」。在这里再调一次 `self.status` 会直接自锁。
    fn status_with_conn(
        &self,
        conn: &Connection,
        ws: &WorkspaceRef,
    ) -> Result<GraphStatusResult, CoreError> {
        let live_indexing = self
            .building
            .lock()
            .map(|g| g.contains(&ws.root_hash))
            .unwrap_or(false);

        let row: Option<(i64, i64, i64, i64, i64, i64, i64, Option<String>)> = conn
            .query_row(
                "SELECT file_count, edge_count, symbol_count, call_count, symbol_vector_count,
                        indexed_at, indexing, symbol_embedding_model
                 FROM graph_workspaces WHERE root_hash = ?1",
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
                    ))
                },
            )
            .ok();

        Ok(match row {
            None => {
                let mut st = GraphStatusResult {
                    ok: true,
                    indexed: false,
                    file_count: 0,
                    edge_count: 0,
                    symbol_count: 0,
                    call_count: 0,
                    symbol_vector_count: 0,
                    symbol_embedding_model: None,
                    indexed_at: 0,
                    indexing: live_indexing,
                    phase: None,
                    files_done: None,
                    files_total: None,
                    last_error: None,
                };
                self.apply_live_progress(&ws.root_hash, &mut st);
                st
            }
            Some((fc, ec, sc, cc, svc, ia, db_indexing, sem)) => {
                let mut db_flag = db_indexing;
                if !live_indexing && db_flag != 0 {
                    let _ = conn.execute(
                        "UPDATE graph_workspaces SET indexing = 0 WHERE root_hash = ?1",
                        params![ws.root_hash],
                    );
                    db_flag = 0;
                }
                let mut st = GraphStatusResult {
                    ok: true,
                    // indexed = 结构建库已落盘（含无可解析符号的空仓）
                    indexed: ia > 0,
                    file_count: fc,
                    edge_count: ec,
                    symbol_count: sc,
                    call_count: cc,
                    symbol_vector_count: svc,
                    symbol_embedding_model: sem,
                    indexed_at: ia,
                    indexing: live_indexing || db_flag != 0,
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

    /// 后台启动结构索引（立即返回）
    /// `skip_if_ready`: true 时已索引则跳过；false 时启动 mtime 增量刷新
    pub fn start_index_workspace(
        &self,
        workspace_root: &str,
        force: bool,
        skip_if_ready: bool,
    ) -> Result<GraphStartIndexResult, CoreError> {
        let ws = resolve_workspace(workspace_root)?;
        if ws.is_remote {
            return Err(CoreError::rpc(
                "REMOTE_GRAPH_UNSUPPORTED",
                "远程工作区请使用远端本地路径上的 graph.index.start",
            ));
        }
        let root = ws
            .local_path
            .as_ref()
            .ok_or_else(|| CoreError::rpc("INVALID_WORKSPACE", "无法解析本地工作区"))?
            .clone();
        let root_hash = ws.root_hash.clone();

        // 注意：切勿在持有 self.building 锁时调用 self.status()，
        // status() 会再次加同一把非重入锁 → 死锁。故先把“是否已在跑”读出来即释放锁。
        let already_running = {
            let guard = self
                .building
                .lock()
                .map_err(|_| CoreError::rpc("GRAPH_BUSY", "结构索引锁不可用"))?;
            guard.contains(&root_hash)
        };
        if already_running {
            let st = self.status(workspace_root)?;
            return Ok(GraphStartIndexResult {
                started: false,
                already_running: true,
                status: st,
            });
        }
        if !force && skip_if_ready {
            let st = self.status(workspace_root)?;
            if st.indexed {
                return Ok(GraphStartIndexResult {
                    started: false,
                    already_running: false,
                    status: st,
                });
            }
        }
        {
            let mut guard = self
                .building
                .lock()
                .map_err(|_| CoreError::rpc("GRAPH_BUSY", "结构索引锁不可用"))?;
            // 复核竞态：上面查 status 期间可能有其它线程已启动
            if guard.contains(&root_hash) {
                drop(guard);
                let st = self.status(workspace_root)?;
                return Ok(GraphStartIndexResult {
                    started: false,
                    already_running: true,
                    status: st,
                });
            }
            guard.insert(root_hash.clone());
        }

        self.set_progress(&root_hash, "walking", 0, 0, 0, 0, 0);
        let svc = self.clone();
        let hash = root_hash.clone();
        std::thread::Builder::new()
            .name("dieyun-graph-index".into())
            .spawn(move || {
                let finish = |svc: &GraphService, hash: &str, result: Result<(), CoreError>| {
                    if let Ok(mut guard) = svc.building.lock() {
                        guard.remove(hash);
                    }
                    match result {
                        Ok(()) => svc.clear_progress(hash),
                        Err(e) => {
                            svc.set_progress_error(hash, &e.to_string());
                            if let Ok(conn) = svc.open_dedicated() {
                                let _ = conn.execute(
                                    "UPDATE graph_workspaces SET indexing = 0 WHERE root_hash = ?1",
                                    params![hash],
                                );
                            }
                        }
                    }
                };
                let conn = match svc.open_dedicated() {
                    Ok(c) => c,
                    Err(e) => {
                        finish(&svc, &hash, Err(e));
                        return;
                    }
                };
                let progress_svc = svc.clone();
                let progress_hash = hash.clone();
                let result = run_build_with_progress(
                    &conn,
                    &root,
                    &hash,
                    force,
                    Some(&|phase, done, total, edges, symbols, calls| {
                        progress_svc.set_progress(
                            &progress_hash,
                            phase,
                            done,
                            total,
                            edges,
                            symbols,
                            calls,
                        );
                    }),
                )
                .map(|_| ());
                finish(&svc, &hash, result);
            })
            .map_err(|e| CoreError::rpc("GRAPH_INDEX_FAILED", format!("无法启动结构索引线程: {e}")))?;

        Ok(GraphStartIndexResult {
            started: true,
            already_running: false,
            status: GraphStatusResult {
                ok: true,
                indexed: false,
                file_count: 0,
                edge_count: 0,
                symbol_count: 0,
                call_count: 0,
                symbol_vector_count: 0,
                symbol_embedding_model: None,
                indexed_at: 0,
                indexing: true,
                phase: Some("walking".into()),
                files_done: Some(0),
                files_total: None,
                last_error: None,
            },
        })
    }

    pub fn index_workspace(
        &self,
        workspace_root: &str,
        force: bool,
    ) -> Result<GraphStatusResult, CoreError> {
        let ws = resolve_workspace(workspace_root)?;
        if ws.is_remote {
            return Err(CoreError::rpc(
                "REMOTE_GRAPH_UNSUPPORTED",
                "远程工作区结构索引暂仅支持本地工作区",
            ));
        }
        let root = ws
            .local_path
            .as_ref()
            .ok_or_else(|| CoreError::rpc("INVALID_WORKSPACE", "无法解析本地工作区"))?;
        let root_hash = ws.root_hash.clone();

        {
            let mut guard = self
                .building
                .lock()
                .map_err(|_| CoreError::rpc("GRAPH_BUSY", "结构索引锁不可用"))?;
            if guard.contains(&root_hash) {
                drop(guard);
                return self.status(workspace_root);
            }
            guard.insert(root_hash.clone());
        }

        self.set_progress(&root_hash, "walking", 0, 0, 0, 0, 0);
        // 长任务：占着常驻锁几分钟会把所有读请求堵死，必须开独立连接。
        let conn = self.open_dedicated()?;
        let progress_svc = self.clone();
        let progress_hash = root_hash.clone();
        let result = run_build_with_progress(
            &conn,
            root,
            &root_hash,
            force,
            Some(&|phase, done, total, edges, symbols, calls| {
                progress_svc.set_progress(
                    &progress_hash,
                    phase,
                    done,
                    total,
                    edges,
                    symbols,
                    calls,
                );
            }),
        );
        if let Ok(mut guard) = self.building.lock() {
            guard.remove(&root_hash);
        }
        match &result {
            Ok(_) => self.clear_progress(&root_hash),
            Err(e) => self.set_progress_error(&root_hash, &e.to_string()),
        }
        result?;
        self.status(workspace_root)
    }

    pub fn index_remote(
        &self,
        workspace_root: &str,
        files: Vec<RemoteFileInput>,
        force: bool,
    ) -> Result<GraphStatusResult, CoreError> {
        let ws = resolve_workspace(workspace_root)?;
        if !ws.is_remote {
            return self.index_workspace(workspace_root, force);
        }
        let root_hash = ws.root_hash.clone();

        {
            let mut guard = self
                .building
                .lock()
                .map_err(|_| CoreError::rpc("GRAPH_BUSY", "结构索引锁不可用"))?;
            if guard.contains(&root_hash) {
                drop(guard);
                return self.status(workspace_root);
            }
            guard.insert(root_hash.clone());
        }

        let conn = self.open_dedicated()?;
        let result = run_remote_build(&conn, &ws.key, &root_hash, &files, force);
        if let Ok(mut guard) = self.building.lock() {
            guard.remove(&root_hash);
        }
        result?;
        self.status(workspace_root)
    }

    pub fn index_remote_begin(&self, workspace_root: &str) -> Result<GraphStatusResult, CoreError> {
        let ws = resolve_workspace(workspace_root)?;
        if !ws.is_remote {
            return self.status(workspace_root);
        }
        self.remote_files
            .lock()
            .map_err(|_| CoreError::rpc("GRAPH_BUSY", "远程结构索引状态锁不可用"))?
            .insert(ws.root_hash.clone(), Vec::new());
        self.status(workspace_root)
    }

    pub fn index_remote_push(
        &self,
        workspace_root: &str,
        files: &[RemoteFileInput],
    ) -> Result<usize, CoreError> {
        let ws = resolve_workspace(workspace_root)?;
        if !ws.is_remote {
            return Ok(0);
        }
        let mut jobs = self
            .remote_files
            .lock()
            .map_err(|_| CoreError::rpc("GRAPH_BUSY", "远程结构索引状态锁不可用"))?;
        let slot = jobs
            .get_mut(&ws.root_hash)
            .ok_or_else(|| CoreError::rpc("REMOTE_GRAPH_STATE", "远程结构索引未 begin"))?;
        slot.extend(files.iter().cloned());
        Ok(files.len())
    }

    pub fn index_remote_finish(
        &self,
        workspace_root: &str,
        force: bool,
    ) -> Result<GraphStatusResult, CoreError> {
        let ws = resolve_workspace(workspace_root)?;
        if !ws.is_remote {
            return self.status(workspace_root);
        }
        let files = self
            .remote_files
            .lock()
            .map_err(|_| CoreError::rpc("GRAPH_BUSY", "远程结构索引状态锁不可用"))?
            .remove(&ws.root_hash)
            .unwrap_or_default();
        self.index_remote(workspace_root, files, force)
    }

    pub fn module_deps(
        &self,
        workspace_root: &str,
        path: Option<&str>,
        depth: Option<u32>,
    ) -> Result<ModuleDepsResult, CoreError> {
        let ws = resolve_workspace(workspace_root)?;
        self.with_conn(|conn| {
            let st = self.status_with_conn(conn, &ws)?;
            module_deps(conn, &ws.root_hash, path, depth.unwrap_or(1), st.indexed)
        })
    }

    pub fn repo_map(
        &self,
        workspace_root: &str,
        limit: Option<u32>,
    ) -> Result<RepoMapResult, CoreError> {
        let ws = resolve_workspace(workspace_root)?;
        self.with_conn(|conn| {
            let st = self.status_with_conn(conn, &ws)?;
            repo_map(conn, &ws.root_hash, limit.unwrap_or(32), st.indexed)
        })
    }

    pub fn symbol_search(
        &self,
        workspace_root: &str,
        query: &str,
        kind: Option<&str>,
        limit: Option<u32>,
    ) -> Result<SymbolSearchResult, CoreError> {
        let ws = resolve_workspace(workspace_root)?;
        self.with_conn(|conn| {
            let st = self.status_with_conn(conn, &ws)?;
            symbol_search(
                conn,
                &ws.root_hash,
                query,
                kind,
                limit.unwrap_or(20),
                st.indexed,
            )
        })
    }

    pub async fn embed_symbols(
        &self,
        workspace_root: &str,
        force: bool,
    ) -> Result<GraphStatusResult, CoreError> {
        let ws = resolve_workspace(workspace_root)?;
        let root_hash = ws.root_hash.clone();
        {
            let mut guard = self
                .embedding_symbols
                .lock()
                .map_err(|_| CoreError::rpc("GRAPH_BUSY", "符号向量构建锁不可用"))?;
            if guard.contains(&root_hash) {
                drop(guard);
                return self.status(workspace_root);
            }
            guard.insert(root_hash.clone());
        }

        // 跨 await + 分钟级任务：既拿不住 MutexGuard，也不该占着常驻锁。
        let conn = self.open_dedicated()?;
        let result =
            run_embed_symbols(&conn, &self.embedding, &self.models_dirs, &root_hash, force).await;

        if let Ok(mut guard) = self.embedding_symbols.lock() {
            guard.remove(&root_hash);
        }
        result?;
        // 符号向量已写回 DB：若池已加载则就地重建，避免检索读到旧向量
        self.refresh_symbol_pool(&conn, &root_hash);
        self.status(workspace_root)
    }

    pub async fn symbol_semantic_search(
        &self,
        workspace_root: &str,
        query: &str,
        kind: Option<&str>,
        limit: Option<u32>,
    ) -> Result<SymbolSearchResult, CoreError> {
        let ws = resolve_workspace(workspace_root)?;
        // 分两段用连接：中间要 await embedding，而常驻锁的 MutexGuard 拿不过 await。
        // `st` 在两段之间沿用同一份快照，与改造前「先取状态、再检索」的取值时机一致。
        let st = self.with_conn(|conn| self.status_with_conn(conn, &ws))?;

        let mut query_vector = None;
        let can_vector = self.embedding.enabled(&self.models_dirs)
            && st.symbol_vector_count > 0
            && self.embedding.signature(&self.models_dirs)
                == st.symbol_embedding_model.as_deref().unwrap_or("");
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
                self.symbol_pool_for(conn, &ws.root_hash)
            } else {
                None
            };

            symbol_semantic_search(
                conn,
                &ws.root_hash,
                query,
                kind,
                limit.unwrap_or(20),
                st.indexed,
                st.symbol_vector_count,
                query_vector.as_deref(),
                pool.as_deref(),
            )
        })
    }

    pub fn callers(
        &self,
        workspace_root: &str,
        symbol_id: Option<i64>,
        path: Option<&str>,
        name: Option<&str>,
    ) -> Result<CallGraphResult, CoreError> {
        let ws = resolve_workspace(workspace_root)?;
        self.with_conn(|conn| {
            let st = self.status_with_conn(conn, &ws)?;
            callers(conn, &ws.root_hash, symbol_id, path, name, st.indexed)
        })
    }

    pub fn callees(
        &self,
        workspace_root: &str,
        symbol_id: Option<i64>,
        path: Option<&str>,
        name: Option<&str>,
    ) -> Result<CallGraphResult, CoreError> {
        let ws = resolve_workspace(workspace_root)?;
        self.with_conn(|conn| {
            let st = self.status_with_conn(conn, &ws)?;
            callees(conn, &ws.root_hash, symbol_id, path, name, st.indexed)
        })
    }

    pub fn impact(
        &self,
        workspace_root: &str,
        path: &str,
        depth: Option<u32>,
    ) -> Result<ImpactResult, CoreError> {
        let ws = resolve_workspace(workspace_root)?;
        self.with_conn(|conn| {
            let st = self.status_with_conn(conn, &ws)?;
            impact(conn, &ws.root_hash, path, depth.unwrap_or(4), st.indexed)
        })
    }

    pub fn ingest_lsp_callers(
        &self,
        workspace_root: &str,
        callee_symbol_id: i64,
        callee_name: &str,
        sites: Vec<LspCallSiteIn>,
    ) -> Result<IngestLspResult, CoreError> {
        let ws = resolve_workspace(workspace_root)?;
        self.with_conn(|conn| {
            ingest_lsp_callers(conn, &ws.root_hash, callee_symbol_id, callee_name, &sites)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::embedding::EmbeddingConfig;
    use crate::graph::extract::files::is_graph_path;
    use crate::graph::extract::go::is_go_path;
    use crate::graph::extract::js_ts::is_js_ts_path;
    use crate::graph::extract::python::is_python_path;
    use crate::graph::extract::rust_lang::is_rust_path;
    use std::fs;

    fn test_graph(db: std::path::PathBuf) -> GraphService {
        GraphService::new(
            crate::codebase_db::handle(db),
            EmbeddingConfig::default(),
            Vec::new(),
        )
    }

    #[test]
    fn indexes_dieyunagent_main_entry_imports() {
        let repo = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
        if !repo.join("src/main-entry.js").is_file() {
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let svc = test_graph(dir.path().join("graph-test.db"));
        let root = repo.canonicalize().unwrap();
        let st = svc
            .index_workspace(&root.to_string_lossy(), true)
            .expect("index");
        assert!(st.edge_count > 0, "expected import edges");
        assert!(st.symbol_count > 0, "expected symbols");
        assert!(st.call_count > 0, "expected calls");

        let deps = svc
            .module_deps(&root.to_string_lossy(), Some("src/main-entry.js"), Some(1))
            .expect("deps");
        let has_core_bridge = deps.dependencies.iter().any(|e| {
            e.spec.contains("core-bridge") || e.to.as_deref() == Some("src/core-bridge.js")
        });
        assert!(has_core_bridge, "main-entry should import core-bridge");

        let hits = svc
            .symbol_search(
                &root.to_string_lossy(),
                "repairMcpEnvironment",
                None,
                Some(5),
            )
            .expect("search");
        assert!(
            hits.results
                .iter()
                .any(|s| s.name == "repairMcpEnvironment"),
            "should find repairMcpEnvironment symbol"
        );
    }

    #[test]
    fn skips_non_graph_files_in_build_list() {
        assert!(is_js_ts_path("a.ts"));
        assert!(is_python_path("a.py"));
        assert!(is_go_path("main.go"));
        assert!(is_rust_path("lib.rs"));
        assert!(!is_graph_path("a.java"));
    }

    #[test]
    fn indexes_remote_graph_from_files() {
        let dir = tempfile::tempdir().unwrap();
        let svc = test_graph(dir.path().join("graph-remote-test.db"));
        let key = "ssh://dev@192.168.1.10/home/dev/project";
        let st = svc
            .index_remote(
                key,
                vec![
                    RemoteFileInput {
                        rel_path: "src/a.js".into(),
                        content:
                            "import { b } from './b.js';\nexport function a() { return b(); }\n"
                                .into(),
                        mtime: 1,
                    },
                    RemoteFileInput {
                        rel_path: "src/b.js".into(),
                        content: "export function b() { return 1; }\n".into(),
                        mtime: 1,
                    },
                ],
                true,
            )
            .unwrap();
        assert!(st.indexed);
        assert!(st.symbol_count >= 2);

        let hits = svc.symbol_search(key, "b", None, Some(5)).unwrap();
        assert!(hits.results.iter().any(|s| s.name == "b"));
        let callers = svc.callers(key, None, Some("src/b.js"), Some("b")).unwrap();
        assert!(callers.sites.iter().any(|s| s.caller_path == "src/a.js"));
    }

    #[test]
    fn temp_go_graph_roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir_all(dir.path().join("helper")).unwrap();
        fs::write(
            dir.path().join("main.go"),
            "package main\nimport \"./helper\"\nfunc main() { helper.Run() }\n",
        )
        .unwrap();
        fs::write(
            dir.path().join("helper").join("helper.go"),
            "package helper\nfunc Run() {}\n",
        )
        .unwrap();

        let svc = test_graph(dir.path().join("g.db"));
        let root = dir.path().canonicalize().unwrap();
        let st = svc.index_workspace(&root.to_string_lossy(), true).unwrap();
        assert_eq!(st.file_count, 2);
        assert!(st.edge_count >= 1);
        assert!(st.symbol_count >= 2);
    }

    #[test]
    fn temp_rust_graph_roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir_all(dir.path().join("pkg")).unwrap();
        fs::write(
            dir.path().join("pkg").join("mod.rs"),
            "mod util;\npub fn entry() { util::work(); }\n",
        )
        .unwrap();
        fs::write(dir.path().join("pkg").join("util.rs"), "pub fn work() {}\n").unwrap();
        fs::write(dir.path().join("lib.rs"), "mod pkg;\n").unwrap();

        let svc = test_graph(dir.path().join("g.db"));
        let root = dir.path().canonicalize().unwrap();
        let st = svc.index_workspace(&root.to_string_lossy(), true).unwrap();
        assert!(st.file_count >= 3);
        assert!(st.symbol_count >= 2);
        assert!(st.edge_count >= 1);

        let deps = svc
            .module_deps(&root.to_string_lossy(), Some("pkg/mod.rs"), Some(1))
            .unwrap();
        assert!(
            deps.dependencies
                .iter()
                .any(|e| e.to.as_deref() == Some("pkg/util.rs")),
            "pkg/mod should depend on util"
        );
    }

    #[test]
    fn indexes_dieyun_core_graph_module() {
        let core = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        if !core.join("src/graph/mod.rs").is_file() {
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let svc = test_graph(dir.path().join("g.db"));
        let root = core.canonicalize().unwrap();
        let st = svc
            .index_workspace(&root.to_string_lossy(), true)
            .expect("index");
        assert!(st.file_count > 10, "expected rust graph files");
        assert!(st.symbol_count > 50, "expected rust symbols");

        let deps = svc
            .module_deps(&root.to_string_lossy(), Some("src/graph/mod.rs"), Some(1))
            .expect("deps");
        assert!(
            deps.dependencies.iter().any(|e| {
                e.to.as_deref() == Some("src/graph/build.rs")
                    || e.to.as_deref() == Some("src/graph/query.rs")
                    || e.spec.contains("build")
            }),
            "graph/mod.rs should reference build or query"
        );
    }

    #[test]
    fn temp_python_graph_roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir_all(dir.path().join("pkg")).unwrap();
        fs::write(
            dir.path().join("pkg").join("main.py"),
            "from .helper import work\n\ndef main():\n    work()\n",
        )
        .unwrap();
        fs::write(
            dir.path().join("pkg").join("helper.py"),
            "def work():\n    pass\n",
        )
        .unwrap();

        let svc = test_graph(dir.path().join("g.db"));
        let root = dir.path().canonicalize().unwrap();
        let st = svc.index_workspace(&root.to_string_lossy(), true).unwrap();
        assert_eq!(st.file_count, 2);
        assert!(st.edge_count >= 1);
        assert!(st.symbol_count >= 2);

        let deps = svc
            .module_deps(&root.to_string_lossy(), Some("pkg/main.py"), Some(1))
            .unwrap();
        assert!(
            deps.dependencies
                .iter()
                .any(|e| e.to.as_deref() == Some("pkg/helper.py")),
            "main should import helper"
        );

        let callers = svc
            .callers(
                &root.to_string_lossy(),
                None,
                Some("pkg/helper.py"),
                Some("work"),
            )
            .unwrap();
        assert!(!callers.sites.is_empty());
    }

    #[test]
    fn temp_workspace_graph_roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(
            dir.path().join("a.js"),
            "const b = require('./b');\nfunction caller() { b.helper(); }\n",
        )
        .unwrap();
        fs::write(
            dir.path().join("b.js"),
            "function helper() {}\nmodule.exports = { helper };\n",
        )
        .unwrap();

        let svc = test_graph(dir.path().join("g.db"));
        let root = dir.path().canonicalize().unwrap();
        let st = svc.index_workspace(&root.to_string_lossy(), true).unwrap();
        assert_eq!(st.file_count, 2);
        assert!(st.edge_count >= 1);
        assert!(st.symbol_count >= 2);
        assert!(st.call_count >= 1);

        let deps = svc
            .module_deps(&root.to_string_lossy(), Some("a.js"), Some(1))
            .unwrap();
        assert_eq!(deps.dependencies.len(), 1);
        assert_eq!(deps.dependencies[0].to.as_deref(), Some("b.js"));

        let callees = svc
            .callees(&root.to_string_lossy(), None, Some("a.js"), Some("caller"))
            .unwrap();
        assert!(!callees.sites.is_empty());

        let callers = svc
            .callers(&root.to_string_lossy(), None, Some("b.js"), Some("helper"))
            .unwrap();
        assert!(!callers.sites.is_empty());

        let map = svc.repo_map(&root.to_string_lossy(), Some(16)).unwrap();
        assert!(map.ok && map.indexed);
        assert!(map.markdown.contains("仓库结构图"));
        assert!(!map.hub_files.is_empty() || !map.hub_symbols.is_empty());
        assert!(!map.edges.is_empty());

        let impact = svc
            .impact(&root.to_string_lossy(), "b.js", Some(2))
            .unwrap();
        assert!(impact.affected_files.contains(&"a.js".to_string()));
    }

    #[test]
    fn incremental_skips_unchanged_file() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("a.js"), "function foo() {}\n").unwrap();
        let svc = test_graph(dir.path().join("g.db"));
        let root = dir.path().canonicalize().unwrap();
        let root_s = root.to_string_lossy().to_string();
        let st1 = svc.index_workspace(&root_s, true).unwrap();
        let st2 = svc.index_workspace(&root_s, false).unwrap();
        assert_eq!(st1.symbol_count, st2.symbol_count);
    }
}

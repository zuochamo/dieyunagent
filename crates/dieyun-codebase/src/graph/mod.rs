mod queries;
mod status;
mod build;
mod incremental;
mod cleanup;
pub use build::GraphScope;
pub(crate) mod extract;
mod lsp_ingest;
mod query;
mod schema;
pub(crate) mod types;

pub use schema::ensure_schema;
pub use types::{IngestLspResult, LspCallSiteIn};

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

use rusqlite::{params, Connection};

use dieyun_base::error::CoreError;
use crate::graph::build::run_build_with_progress;
use crate::graph::types::{
    CallGraphResult, GraphStartIndexResult, GraphStatusResult, ImpactResult, ModuleDepsResult,
    RepoMapResult, SymbolSearchResult,
};
use crate::index::{resolve_workspace, WorkspaceRef};
use dieyun_base::sqlite::SqliteHandle;
use status::{repair_stale_indexing_flag, GraphProgressSnapshot};

#[derive(Clone)]
pub struct GraphService {
    /// codebase.db 句柄：与 `IndexService` 共享同一条常驻连接（同库，故同连接）。
    db: Arc<SqliteHandle>,
    building: Arc<Mutex<HashSet<String>>>,
    progress: Arc<Mutex<HashMap<String, GraphProgressSnapshot>>>,
}

impl GraphService {
    pub fn new(db: Arc<SqliteHandle>) -> Self {
        Self {
            db,
            building: Arc::new(Mutex::new(HashSet::new())),
            progress: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// 复用常驻连接执行一次**秒回级**短操作（见 `SqliteHandle::with_conn`）。
    ///
    /// 非重入锁：调用方**不得**在闭包内再调 `with_conn` / `status`，否则死锁。
    /// 数据查询不算短操作 —— 一律走 [`read_dedicated`](Self::read_dedicated)。
    fn with_conn<T>(
        &self,
        f: impl FnOnce(&Connection) -> Result<T, CoreError>,
    ) -> Result<T, CoreError> {
        self.db.with_conn(f)
    }

    /// 独立连接：用于跨 `.await`、分钟级长任务，以及**所有数据查询**。
    fn open_dedicated(&self) -> Result<Connection, CoreError> {
        self.db.open_dedicated()
    }

    /// 读侧取数的唯一姿势：**状态快照走读池**（纯读、必须秒回），
    /// **数据查询也走读池**（仓库地图 / 符号检索 / 调用链都可能扫全表）。
    ///
    /// 拆开的原因见 `docs/SQLITE-ACCESS.md`：常驻连接是
    /// index / graph 共用的唯一写入连接，只要有一条慢读占着它，期间所有
    /// `codebase.status` / `graph.status` 都会排队到宿主 15s 预算（`src/core-rpc-timeouts.js`）。
    fn read_dedicated<T>(
        &self,
        ws: &WorkspaceRef,
        f: impl FnOnce(&Connection, bool) -> Result<T, CoreError>,
    ) -> Result<T, CoreError> {
        let (st, stale_flag) = self.status_snapshot(ws)?;
        if stale_flag {
            // 维修不在读路径上做：独立连接 + `busy_timeout(0)`，抢不到写锁就下次再来。
            if let Ok(conn) = self.open_dedicated() {
                repair_stale_indexing_flag(&conn, &ws.root_hash);
            }
        }
        self.db.read(|conn| f(conn, st.indexed))
    }

    /// 后台启动结构索引（立即返回）
    /// `skip_if_ready`: true 时已索引则跳过；false 时启动 mtime 增量刷新
    /// `scope`: `Structural` 只建符号/import/mtime；`WithCalls` 额外抽调用关系（R5）
    pub fn start_index_workspace(
        &self,
        workspace_root: &str,
        force: bool,
        skip_if_ready: bool,
        scope: GraphScope,
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
                    scope,
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
                calls_built: false,
                files_truncated: false,
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
        scope: GraphScope,
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
            scope,
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

}

/// 清掉某工作区的**全部**图谱行（含 `graph_workspaces` 那行本身）。
///
/// 给「根目录已消失的工作区」清理用（`IndexService::prune_missing_workspaces`）：
/// chunks 与图谱必须一起清，只清一半就会让 `graph_*` 查询拿到没有 chunk 支撑的符号。
pub(crate) fn clear_workspace_rows(conn: &Connection, root_hash: &str) -> Result<(), CoreError> {
    cleanup::clear_workspace_graph(conn, root_hash)?;
    conn.execute(
        "DELETE FROM graph_workspaces WHERE root_hash = ?1",
        params![root_hash],
    )
    .map_err(|e| CoreError::rpc("GRAPH_QUERY_FAILED", e.to_string()))?;
    Ok(())
}

#[cfg(test)]
#[path = "tests.rs"]
mod tests;

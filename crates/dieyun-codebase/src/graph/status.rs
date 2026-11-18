//! 图谱状态（只读）与进度快照。
//!
//! 从 `graph/mod.rs` 机械搬来（纯移动）。状态是**纯读**：它不在写连接上排队，
//! 面板每秒轮询一次，任何一次阻塞都会显示成「建图卡住」。


use rusqlite::{params, Connection};

use crate::index::WorkspaceRef;
use super::{GraphService, GraphStatusResult};
use crate::index::resolve_workspace;
use dieyun_base::error::CoreError;

impl GraphService {

    /// 状态快照：读池上纯读；第二个返回值表示「库里有脏旗标需要修」。
    pub(crate) fn status_snapshot(&self, ws: &WorkspaceRef) -> Result<(GraphStatusResult, bool), CoreError> {
        self.db.read(|conn| self.status_with_conn(conn, ws))
    }


    pub(crate) fn set_progress(
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


    pub(crate) fn apply_live_progress(&self, root_hash: &str, st: &mut GraphStatusResult) {
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
        let (st, stale_flag) = self.status_snapshot(&ws)?;
        if stale_flag {
            // 修复不在读路径上做：独立连接 + `busy_timeout(0)`，抢不到写锁就下次再修
            if let Ok(conn) = self.open_dedicated() {
                repair_stale_indexing_flag(&conn, &ws.root_hash);
            }
        }
        Ok(st)
    }


    /// `status` 的实现本体：连接由调用方提供。
    ///
    /// **纯读**：库里的脏旗标（`indexing = 1` 却没人真在跑，通常是崩溃残留）只发现、
    /// 不在这里写，第二个返回值交给调用方用独立连接补写（见
    /// [`read_conn`](Self::read_conn) / [`status`](Self::status)）。
    pub(crate) fn status_with_conn(
        &self,
        conn: &Connection,
        ws: &WorkspaceRef,
    ) -> Result<(GraphStatusResult, bool), CoreError> {
        let live_indexing = self
            .building
            .lock()
            .map(|g| g.contains(&ws.root_hash))
            .unwrap_or(false);

        let row: Option<(i64, i64, i64, i64, i64, i64, i64, i64)> = conn
            .query_row(
                "SELECT file_count, edge_count, symbol_count, call_count, indexed_at, indexing,
                        calls_built, files_truncated
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
                    calls_built: false,
                    files_truncated: false,
                    indexed_at: 0,
                    indexing: live_indexing,
                    phase: None,
                    files_done: None,
                    files_total: None,
                    last_error: None,
                };
                self.apply_live_progress(&ws.root_hash, &mut st);
                (st, false)
            }
            Some((fc, ec, sc, cc, ia, db_indexing, calls_built, files_truncated)) => {
                let mut db_flag = db_indexing;
                let stale_flag = !live_indexing && db_flag != 0;
                if stale_flag {
                    // 读路径不写库：交给调用方用独立连接补（见 status / read_conn）
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
                    calls_built: calls_built != 0,
                    files_truncated: files_truncated != 0,
                    indexed_at: ia,
                    indexing: live_indexing || db_flag != 0,
                    phase: None,
                    files_done: None,
                    files_total: None,
                    last_error: None,
                };
                self.apply_live_progress(&ws.root_hash, &mut st);
                (st, stale_flag)
            }
        })
    }


}

#[derive(Debug, Clone, Default)]
pub(crate) struct GraphProgressSnapshot {
    phase: String,
    files_done: i64,
    files_total: i64,
    edge_count: i64,
    symbol_count: i64,
    call_count: i64,
    last_error: Option<String>,
}


/// 修掉崩溃 / 异常退出残留的 `graph_workspaces.indexing = 1`。
///
/// best-effort：`busy_timeout(0)`，抢不到写锁就放弃（下次读再修）。
/// 维修绝不能把读请求拖进等锁 —— 那正是 `codebase.status` 45s 超时的来源。
pub(crate) fn repair_stale_indexing_flag(conn: &Connection, root_hash: &str) {
    let _ = conn.busy_timeout(std::time::Duration::ZERO);
    let _ = conn.execute(
        "UPDATE graph_workspaces SET indexing = 0 WHERE root_hash = ?1",
        params![root_hash],
    );
}


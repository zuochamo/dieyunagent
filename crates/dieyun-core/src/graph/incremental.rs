//! 增量判定：这一轮该按哪个**建库范围**干活、要不要把未变文件也重解析一遍。
//!
//! 这份判断以前在本地建库和远端摄取里各写一遍（`scope.with_calls() && call_count == 0`
//! 这种代理判据），两处漂移过一次：远端那份在边的数量被清空时会误判成「没建过」。
//! 现在只有一处：范围是**黏性**的（`graph_workspaces.calls_built`），建过调用图的
//! 工作区，增量也按 WithCalls 维护它。

use rusqlite::{params, Connection};

use super::GraphScope;
use crate::error::CoreError;

/// 一轮建库的最终范围 + 是否需要把未变文件也重解析。
pub(crate) struct BuildPlan {
    pub(crate) scope: GraphScope,
    /// 「结构态 → 调用态」的升级轮：mtime 没变也要重解析，否则历史文件永远没有调用边。
    pub(crate) reparse_unchanged: bool,
}

/// 解析本轮建库计划。
///
/// - `force` 全量重建：`clear_workspace_graph` 已清空，按调用方这次要的范围重建；
/// - 否则：建过调用图（`calls_built = 1`）就继续按 WithCalls 维护 —— 不这样做，一次普通
///   保存触发的结构态增量会把该文件的出边删掉却不重建，编辑过的文件从此永久丢边。
pub(crate) fn plan(
    conn: &Connection,
    root_hash: &str,
    force: bool,
    requested: GraphScope,
) -> Result<BuildPlan, CoreError> {
    let built_before = calls_built(conn, root_hash)?;
    let scope = if force {
        requested
    } else if built_before {
        GraphScope::WithCalls
    } else {
        requested
    };
    Ok(BuildPlan {
        scope,
        reparse_unchanged: !force && scope.with_calls() && !built_before,
    })
}

/// 这个工作区建过调用图没有（`calls_built`，黏性）。
pub(crate) fn calls_built(conn: &Connection, root_hash: &str) -> Result<bool, CoreError> {
    let flag: Option<i64> = conn
        .query_row(
            "SELECT calls_built FROM graph_workspaces WHERE root_hash = ?1",
            params![root_hash],
            |r| r.get(0),
        )
        .ok();
    Ok(flag.unwrap_or(0) != 0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn conn_with(calls_built: i64) -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        super::super::schema::ensure_schema(&conn).unwrap();
        conn.execute(
            "INSERT INTO graph_workspaces (root_hash, root_path, calls_built) VALUES ('rh', '/w', ?1)",
            params![calls_built],
        )
        .unwrap();
        conn
    }

    /// 黏性：建过调用图的工作区，结构态增量也要按 WithCalls 维护（A8 的根因）。
    #[test]
    fn sticky_scope_keeps_calls_built_workspaces_on_with_calls() {
        let conn = conn_with(1);
        let p = plan(&conn, "rh", false, GraphScope::Structural).unwrap();
        assert!(p.scope.with_calls(), "建过调用图 → 增量也维护调用边");
        assert!(!p.reparse_unchanged, "已经建过就不必重解析未变文件");
    }

    /// 升级轮：从结构态升到调用态时，未变文件必须重解析（补历史文件）。
    #[test]
    fn scope_upgrade_reparses_unchanged_files_once() {
        let conn = conn_with(0);
        let p = plan(&conn, "rh", false, GraphScope::WithCalls).unwrap();
        assert!(p.scope.with_calls());
        assert!(p.reparse_unchanged, "结构态 → 调用态要回填未变文件");
    }

    /// force 全量重建按调用方这次要的范围来（清空后重建，不吃黏性）。
    #[test]
    fn force_rebuild_follows_the_requested_scope() {
        let conn = conn_with(1);
        let p = plan(&conn, "rh", true, GraphScope::Structural).unwrap();
        assert!(!p.scope.with_calls(), "force 结构重建就是结构重建");
        assert!(!p.reparse_unchanged);
    }
}

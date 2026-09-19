//! codebase.db 的唯一入口。
//!
//! 索引分块表（`index`）和结构图谱表（`graph`）一直落在同一个文件上
//! （都取 `config.codebase_db_path()`），却各自开各自的连接，而且两边都抄了一份
//! 「user_version + 表是否存在」的建表判断——graph 甚至替 index 建表，只因为
//! 它可能先被打开。同一份东西有两份实现，就会漂移。
//!
//! 磁盘上只有一个文件，进程里就只该有一条连接、一份建表。两者在这里汇合。

use std::path::PathBuf;
use std::sync::Arc;

use rusqlite::Connection;

use crate::error::CoreError;
use crate::sqlite::SqliteHandle;

/// codebase.db 的句柄：索引与图谱共用同一份。
///
/// 返回 `Arc` 是因为两个服务要共享**同一条连接**，而不是各开一条指向同一文件的连接。
pub fn handle(db_path: PathBuf) -> Arc<SqliteHandle> {
    Arc::new(SqliteHandle::new(db_path, ensure_schema))
}

/// 这个库文件里所有表的总入口。
fn ensure_schema(conn: &Connection) -> Result<(), CoreError> {
    crate::index::ensure_schema(conn)?;
    crate::graph::ensure_schema(conn)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn has_table(conn: &Connection, name: &str) -> bool {
        conn.query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?1",
            [name],
            |r| r.get::<_, i64>(0),
        )
        .map(|n| n > 0)
        .unwrap_or(false)
    }

    #[test]
    fn ensure_schema_creates_tables_of_both_sides() {
        let conn = Connection::open_in_memory().expect("open in-memory");
        ensure_schema(&conn).expect("ensure_schema");

        assert!(has_table(&conn, "chunks"), "索引侧表应建好");
        assert!(has_table(&conn, "graph_workspaces"), "图谱侧表应建好");
    }

    #[test]
    fn ensure_schema_is_idempotent() {
        let conn = Connection::open_in_memory().expect("open in-memory");
        ensure_schema(&conn).expect("首次");
        ensure_schema(&conn).expect("再次不应重复建表，也不应报错");
    }
}

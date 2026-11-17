use rusqlite::{Connection, OptionalExtension};

use crate::error::CoreError;

/// 确保结构图谱表就绪。
///
/// **只在库文件首次被用到时跑一次**（由 `SqliteHandle` 保证）。
/// 索引表的建表不在这里：同库同连接，那份由 [`crate::index::ensure_schema`] 负责，
/// 两者在 [`crate::codebase_db`] 里汇合。此前 graph 的 `open()` 里抄了一份 index 的
/// 建表逻辑（谁先打开谁负责建），是同一份东西的第二份实现。
pub fn ensure_schema(conn: &Connection) -> Result<(), CoreError> {
    let has_graph = conn
        .query_row(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='graph_workspaces' LIMIT 1",
            [],
            |r| r.get::<_, i32>(0),
        )
        .optional()
        .map_err(|e| CoreError::rpc("DB_SCHEMA_FAILED", e.to_string()))?
        .is_some();
    if has_graph {
        // 老库才需要清残留；新库在 init_graph_schema 里压根不会建那张表
        drop_legacy_symbol_vectors(conn)
            .map_err(|e| CoreError::rpc("DB_SCHEMA_FAILED", e.to_string()))?;
        return Ok(());
    }
    init_graph_schema(conn).map_err(|e| CoreError::rpc("DB_SCHEMA_FAILED", e.to_string()))
}

pub fn init_graph_schema(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS graph_workspaces (
            root_hash TEXT PRIMARY KEY,
            root_path TEXT NOT NULL,
            file_count INTEGER DEFAULT 0,
            edge_count INTEGER DEFAULT 0,
            symbol_count INTEGER DEFAULT 0,
            call_count INTEGER DEFAULT 0,
            -- 这个工作区**建过调用图没有**（建库范围）。黏性：一旦为 1，之后的增量也按
            -- WithCalls 维护它 —— 否则一次保存的增量（结构态）会把该文件的出边删掉却不重建。
            calls_built INTEGER NOT NULL DEFAULT 0,
            indexed_at INTEGER DEFAULT 0,
            indexing INTEGER DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS graph_imports (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            root_hash TEXT NOT NULL,
            from_path TEXT NOT NULL,
            to_path TEXT,
            spec TEXT NOT NULL,
            line INTEGER NOT NULL,
            external INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS graph_file_mtime (
            root_hash TEXT NOT NULL,
            rel_path TEXT NOT NULL,
            mtime INTEGER NOT NULL,
            PRIMARY KEY (root_hash, rel_path)
        );
        CREATE TABLE IF NOT EXISTS graph_symbols (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            root_hash TEXT NOT NULL,
            rel_path TEXT NOT NULL,
            kind TEXT NOT NULL,
            name TEXT NOT NULL,
            qualified_name TEXT NOT NULL,
            start_line INTEGER NOT NULL,
            end_line INTEGER NOT NULL,
            mtime INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS graph_calls (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            root_hash TEXT NOT NULL,
            caller_symbol_id INTEGER NOT NULL,
            caller_path TEXT NOT NULL,
            callee_name TEXT NOT NULL,
            callee_symbol_id INTEGER,
            line INTEGER NOT NULL,
            confidence REAL NOT NULL DEFAULT 0.8,
            FOREIGN KEY(caller_symbol_id) REFERENCES graph_symbols(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_graph_imports_root ON graph_imports(root_hash);
        CREATE INDEX IF NOT EXISTS idx_graph_imports_from ON graph_imports(root_hash, from_path);
        CREATE INDEX IF NOT EXISTS idx_graph_imports_to ON graph_imports(root_hash, to_path);
        CREATE INDEX IF NOT EXISTS idx_graph_symbols_root ON graph_symbols(root_hash);
        CREATE INDEX IF NOT EXISTS idx_graph_symbols_name ON graph_symbols(root_hash, name);
        CREATE INDEX IF NOT EXISTS idx_graph_symbols_path ON graph_symbols(root_hash, rel_path);
        CREATE INDEX IF NOT EXISTS idx_graph_calls_root ON graph_calls(root_hash);
        CREATE INDEX IF NOT EXISTS idx_graph_calls_caller ON graph_calls(caller_symbol_id);
        CREATE INDEX IF NOT EXISTS idx_graph_calls_callee ON graph_calls(root_hash, callee_name);
        ",
    )?;
    ensure_column(
        conn,
        "graph_workspaces",
        "symbol_count",
        "INTEGER DEFAULT 0",
    )?;
    ensure_column(conn, "graph_workspaces", "call_count", "INTEGER DEFAULT 0")?;
    // 建库范围（是否建过调用边）。旧库补列时默认 0 —— `query.rs` 的可见性判定会把
    // 「calls_built = 0 但 call_count > 0」（老库已建过边）也算成「建过」，避免升级后
    // 模型突然被告知「调用图未建」。
    ensure_column(
        conn,
        "graph_workspaces",
        "calls_built",
        "INTEGER NOT NULL DEFAULT 0",
    )?;
    Ok(())
}

/// 收掉已删除能力的残留状态：`graph_symbol_vectors` 表连同向量 BLOB、以及
/// `graph_workspaces` 上的两列。
///
/// 在 [`ensure_schema`] 里**无条件**跑（新建的库是空操作）：只放在 `init_graph_schema`
/// 里没用 —— 那个函数在 `graph_workspaces` 已存在时直接返回，老库永远走不到。
fn drop_legacy_symbol_vectors(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch("DROP TABLE IF EXISTS graph_symbol_vectors;")?;
    drop_column_if_exists(conn, "graph_workspaces", "symbol_vector_count")?;
    drop_column_if_exists(conn, "graph_workspaces", "symbol_embedding_model")?;
    Ok(())
}

fn drop_column_if_exists(conn: &Connection, table: &str, column: &str) -> rusqlite::Result<()> {
    let sql = format!("ALTER TABLE {table} DROP COLUMN {column}");
    match conn.execute(&sql, []) {
        Ok(_) => Ok(()),
        Err(e) => {
            let msg = e.to_string();
            if msg.contains("no such column") {
                Ok(())
            } else {
                Err(e)
            }
        }
    }
}

fn ensure_column(
    conn: &Connection,
    table: &str,
    column: &str,
    definition: &str,
) -> rusqlite::Result<()> {
    let sql = format!("ALTER TABLE {table} ADD COLUMN {column} {definition}");
    match conn.execute(&sql, []) {
        Ok(_) => Ok(()),
        Err(e) => {
            let msg = e.to_string();
            if msg.contains("duplicate column name") {
                Ok(())
            } else {
                Err(e)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 老库迁移：符号向量表与两列在打开时被收掉，且不损伤其它结构图谱数据。
    #[test]
    fn ensure_schema_drops_legacy_symbol_vector_state() {
        let conn = Connection::open_in_memory().unwrap();
        init_graph_schema(&conn).unwrap();
        // 造出老库形状：表 + 两列 + 一行真实数据
        conn.execute_batch(
            "CREATE TABLE graph_symbol_vectors (
                 symbol_id INTEGER PRIMARY KEY, dims INTEGER NOT NULL,
                 vector BLOB NOT NULL, symbol_mtime INTEGER NOT NULL);
             ALTER TABLE graph_workspaces ADD COLUMN symbol_vector_count INTEGER DEFAULT 0;
             ALTER TABLE graph_workspaces ADD COLUMN symbol_embedding_model TEXT;
             INSERT INTO graph_workspaces (root_hash, root_path, file_count, symbol_count)
                 VALUES ('rh', '/tmp', 7, 42);",
        )
        .unwrap();

        ensure_schema(&conn).expect("migrate");

        let table: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='graph_symbol_vectors'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(table, 0, "死表应被删掉");
        let cols: Vec<String> = conn
            .prepare("PRAGMA table_info(graph_workspaces)")
            .unwrap()
            .query_map([], |r| r.get::<_, String>(1))
            .unwrap()
            .filter_map(|r| r.ok())
            .collect();
        assert!(!cols.iter().any(|c| c == "symbol_vector_count"));
        assert!(!cols.iter().any(|c| c == "symbol_embedding_model"));
        // 原有数据不受影响
        let (files, symbols): (i64, i64) = conn
            .query_row(
                "SELECT file_count, symbol_count FROM graph_workspaces WHERE root_hash = 'rh'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!((files, symbols), (7, 42));
        // 再跑一次：幂等
        ensure_schema(&conn).expect("idempotent");
    }
}

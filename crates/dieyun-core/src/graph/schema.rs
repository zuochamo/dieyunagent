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
        CREATE TABLE IF NOT EXISTS graph_symbol_vectors (
            symbol_id INTEGER PRIMARY KEY,
            dims INTEGER NOT NULL,
            vector BLOB NOT NULL,
            symbol_mtime INTEGER NOT NULL,
            FOREIGN KEY(symbol_id) REFERENCES graph_symbols(id) ON DELETE CASCADE
        );
        ",
    )?;
    ensure_column(
        conn,
        "graph_workspaces",
        "symbol_count",
        "INTEGER DEFAULT 0",
    )?;
    ensure_column(conn, "graph_workspaces", "call_count", "INTEGER DEFAULT 0")?;
    ensure_column(
        conn,
        "graph_workspaces",
        "symbol_vector_count",
        "INTEGER DEFAULT 0",
    )?;
    ensure_column(conn, "graph_workspaces", "symbol_embedding_model", "TEXT")?;
    Ok(())
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

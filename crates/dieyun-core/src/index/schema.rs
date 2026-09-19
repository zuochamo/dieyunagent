use rusqlite::Connection;

use crate::error::CoreError;

/// 递增时触发一次 [`ensure_schema`] 重跑
pub const SCHEMA_VERSION: i32 = 1;

/// 确保索引表就绪。
///
/// **只在库文件首次被用到时跑一次**（由 `SqliteHandle` 保证）：CREATE + FTS 建表
/// 在外置盘上可拖到数十秒，每次查询都跑一遍就是灾难。
pub fn ensure_schema(conn: &Connection) -> Result<(), CoreError> {
    let ver: i32 = conn
        .pragma_query_value(None, "user_version", |r| r.get(0))
        .unwrap_or(0);
    if ver >= SCHEMA_VERSION {
        return Ok(());
    }
    let has_chunks = conn
        .query_row(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='chunks' LIMIT 1",
            [],
            |r| r.get::<_, i32>(0),
        )
        .ok()
        .is_some();
    if has_chunks {
        // 已有表：只钉版本，勿再跑 CREATE/FTS（外置盘上很慢）
        let _ = conn.pragma_update(None, "user_version", SCHEMA_VERSION);
        return Ok(());
    }
    init_schema(conn).map_err(|e| CoreError::rpc("DB_SCHEMA_FAILED", e.to_string()))
}

pub fn init_schema(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS workspaces (
            root_hash TEXT PRIMARY KEY,
            root_path TEXT NOT NULL,
            file_count INTEGER DEFAULT 0,
            chunk_count INTEGER DEFAULT 0,
            vector_count INTEGER DEFAULT 0,
            indexed_at INTEGER DEFAULT 0,
            indexing INTEGER DEFAULT 0,
            embedding_model TEXT,
            embedding_dims INTEGER DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS chunks (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            root_hash TEXT NOT NULL,
            rel_path TEXT NOT NULL,
            start_line INTEGER NOT NULL,
            end_line INTEGER NOT NULL,
            content TEXT NOT NULL,
            mtime INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_chunks_root ON chunks(root_hash);
        CREATE TABLE IF NOT EXISTS chunk_vectors (
            chunk_id INTEGER PRIMARY KEY,
            dims INTEGER NOT NULL,
            vector BLOB NOT NULL,
            FOREIGN KEY(chunk_id) REFERENCES chunks(id) ON DELETE CASCADE
        );
        CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
            rel_path,
            content,
            tokenize='unicode61'
        );
        ",
    )?;
    conn.pragma_update(None, "user_version", SCHEMA_VERSION)?;
    Ok(())
}

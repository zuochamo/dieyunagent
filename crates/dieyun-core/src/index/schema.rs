use rusqlite::Connection;

/// 递增时在 open() 中重新跑 init_schema
pub const SCHEMA_VERSION: i32 = 1;

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

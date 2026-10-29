use rusqlite::Connection;

use crate::error::CoreError;

/// 递增时触发一次 [`ensure_schema`] 迁移。
///
/// 历史：
/// - v2：`chunks_fts` 由「独立内容表 + 调用点手写同步」改为 external content（`content='chunks'`）+ 触发器同步。
/// - v3：`chunks_fts` 分词器由 `unicode61` 改为 `trigram`。
/// - v4：**删除 `chunks_fts` 整张表**（含三个触发器）。trigram 倒排占库体 40%
///   （本机实测 425.6 MB / 1056 MB），而它提供的「按词排名」与既有 `grep` 工具重叠、
///   且永远落后一轮增量。词法召回改由 `search.rs` 的**子串扫描**承担（见那里注释）。
///   记忆侧的 `long_memories_fts` 不受影响（数据量级完全不同）。
pub const SCHEMA_VERSION: i32 = 4;

/// 确保索引表就绪。
///
/// **只在库文件首次被用到时跑一次**（由 `SqliteHandle` 保证）：CREATE + FTS 建表
/// 在外置盘上可拖到数十秒，每次查询都跑一遍就是灾难。
///
/// 既有库只跑 [`migrate`] 里差的那几步，不重跑全量 CREATE。
pub fn ensure_schema(conn: &Connection) -> Result<(), CoreError> {
    let ver: i32 = conn
        .pragma_query_value(None, "user_version", |r| r.get(0))
        .unwrap_or(0);
    if ver >= SCHEMA_VERSION {
        return Ok(());
    }
    if table_exists(conn, "chunks")? {
        migrate(conn, ver)
    } else {
        init_schema(conn)
    }
    .map_err(|e| CoreError::rpc("DB_SCHEMA_FAILED", e.to_string()))
}

fn table_exists(conn: &Connection, name: &str) -> Result<bool, CoreError> {
    match conn.query_row(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1 LIMIT 1",
        [name],
        |r| r.get::<_, i32>(0),
    ) {
        Ok(_) => Ok(true),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(false),
        Err(e) => Err(CoreError::rpc("DB_SCHEMA_FAILED", e.to_string())),
    }
}

/// 从旧版本补齐到 [`SCHEMA_VERSION`]。
///
/// 每一步都幂等（`IF EXISTS` / 重建），失败就整体回滚、`user_version` 不动，
/// 下次开库重试 —— 索引是可重建缓存，最坏情况是这批数据重建一次。
///
/// 每一步自己把 `user_version` 落到该步的版本号：加新版本时**必须同时**加一步
/// 并在那一步里 `pragma_update`，否则版本号不动、迁移每次开库重跑。
fn migrate(conn: &Connection, from: i32) -> rusqlite::Result<()> {
    if from < 4 {
        // v1/v2/v3 → v4：删掉 `chunks_fts` 及其三个触发器。
        //
        // 为什么不是「换个分词器」：trigram 已经是 FTS5 在中文上的最优解（3 字滑窗），
        // 再换只会更差；而它换来的能力（按词排名）与 `grep` 工具重叠，且索引滞后一轮增量。
        // 库体上它占了 40%，是整套代码索引里最大的一块，收益却最薄 —— 见
        // `docs/INDEX-VALUE-REVIEW.md` §R2。
        //
        // 词法召回不消失：`search.rs` 用子串扫描覆盖（路径 + 正文），不依赖任何倒排索引。
        // 这一步只删表、不动 `chunks`（正文唯一来源始终是它）。
        drop_fts(conn, 4)?;
    }
    Ok(())
}

/// 丢弃 `chunks_fts` 与三个同步触发器（v4 起不再存在）。
fn drop_fts(conn: &Connection, to_version: i32) -> rusqlite::Result<()> {
    let tx = conn.unchecked_transaction()?;
    tx.execute_batch(
        "
        DROP TRIGGER IF EXISTS chunks_fts_ai;
        DROP TRIGGER IF EXISTS chunks_fts_ad;
        DROP TRIGGER IF EXISTS chunks_fts_au;
        DROP TABLE IF EXISTS chunks_fts;
        ",
    )?;
    tx.pragma_update(None, "user_version", to_version)?;
    tx.commit()
}

/// 索引表本体。
///
/// v4 起没有全文倒排表：词法召回走 `search.rs` 的子串扫描（`LIKE`），
/// 因此任何写入路径（本机索引 / 远端摄取 / 清理）都只需写 `chunks`。
const BASE_TABLES: &str = "
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
";

/// 全文倒排索引：v4 起已删除。
///
/// 保留这个常量只为了让 v1–v3 的旧库能被 [`migrate`] 识别并清理？—— 不需要：
/// 迁移直接 `DROP ... IF EXISTS`。所以这里不再有建表 SQL，留这段注释说明「为什么没有」即可，
/// 免得后来者以为漏了触发器同步（旧库的触发器会被 `drop_fts` 一并删掉）。
pub fn init_schema(conn: &Connection) -> rusqlite::Result<()> {
    let tx = conn.unchecked_transaction()?;
    tx.execute_batch(BASE_TABLES)?;
    tx.pragma_update(None, "user_version", SCHEMA_VERSION)?;
    tx.commit()
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::params;

    fn table_exists_pub(conn: &Connection, name: &str) -> bool {
        table_exists(conn, name).unwrap()
    }

    fn insert_chunk(conn: &Connection, rel: &str, content: &str) -> i64 {
        conn.execute(
            "INSERT INTO chunks (root_hash, rel_path, start_line, end_line, content, mtime)
             VALUES ('rh', ?1, 1, 1, ?2, 0)",
            params![rel, content],
        )
        .unwrap();
        conn.last_insert_rowid()
    }

    /// v4 起没有任何全文倒排表：新建库不该有 `chunks_fts`，写 `chunks` 也不该有触发器。
    #[test]
    fn v4_creates_no_fts_table() {
        let conn = Connection::open_in_memory().unwrap();
        init_schema(&conn).unwrap();

        assert!(!table_exists_pub(&conn, "chunks_fts"), "v4 不建 FTS 表");
        let triggers: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='trigger' AND name LIKE 'chunks_fts%'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(triggers, 0, "v4 不留 FTS 同步触发器");

        // 正文写入不依赖任何倒排结构
        insert_chunk(&conn, "a.rs", "fn parse_config() {}");
        let n: i64 = conn
            .query_row("SELECT COUNT(*) FROM chunks", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 1);
    }

    /// 旧库（v1/v2/v3，无论分词器与 content 模式）升级后 `chunks_fts` 必须消失，
    /// 但 `chunks` 正文一行都不能丢 —— 索引是派生物，正文才是唯一来源。
    #[test]
    fn migrates_any_old_version_by_dropping_fts() {
        for (ver, fts_sql) in [
            (
                1_i32,
                "CREATE VIRTUAL TABLE chunks_fts USING fts5(rel_path, content, tokenize='unicode61');
                 INSERT INTO chunks_fts (rowid, rel_path, content)
                     SELECT id, rel_path, content FROM chunks;",
            ),
            (
                2_i32,
                "CREATE VIRTUAL TABLE chunks_fts USING fts5(
                     rel_path, content, content='chunks', content_rowid='id', tokenize='unicode61');
                 INSERT INTO chunks_fts(chunks_fts) VALUES('rebuild');",
            ),
            (
                3_i32,
                "CREATE VIRTUAL TABLE chunks_fts USING fts5(
                     rel_path, content, content='chunks', content_rowid='id', tokenize='trigram');
                 INSERT INTO chunks_fts(chunks_fts) VALUES('rebuild');
                 CREATE TRIGGER chunks_fts_ai AFTER INSERT ON chunks BEGIN
                     INSERT INTO chunks_fts(rowid, rel_path, content)
                     VALUES (new.id, new.rel_path, new.content);
                 END;",
            ),
        ] {
            let conn = Connection::open_in_memory().unwrap();
            conn.execute_batch(BASE_TABLES).unwrap();
            conn.execute_batch(
                "INSERT INTO chunks (root_hash, rel_path, start_line, end_line, content, mtime)
                     VALUES ('rh', 'a.rs', 1, 2, '// 代码库索引的增量更新逻辑', 0);",
            )
            .unwrap();
            conn.execute_batch(fts_sql).unwrap();
            conn.pragma_update(None, "user_version", ver).unwrap();
            assert!(table_exists_pub(&conn, "chunks_fts"), "前置：v{ver} 有 FTS 表");

            ensure_schema(&conn).unwrap();

            assert!(!table_exists_pub(&conn, "chunks_fts"), "v{ver} → v4 必须删掉 FTS 表");
            let triggers: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE type='trigger' AND name LIKE 'chunks_fts%'",
                    [],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(triggers, 0, "v{ver} → v4 必须删掉触发器");
            let n: i64 = conn
                .query_row("SELECT COUNT(*) FROM chunks", [], |r| r.get(0))
                .unwrap();
            assert_eq!(n, 1, "v{ver} → v4 不得丢正文");
            let content: String = conn
                .query_row("SELECT content FROM chunks LIMIT 1", [], |r| r.get(0))
                .unwrap();
            assert!(content.contains("代码库索引"));
            let cur: i32 = conn
                .pragma_query_value(None, "user_version", |r| r.get(0))
                .unwrap();
            assert_eq!(cur, SCHEMA_VERSION);
        }
    }
}

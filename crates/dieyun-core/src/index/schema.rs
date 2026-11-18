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
/// - v5：`workspaces` 增加 `vectors_reused` / `vectors_embedded`（上一次建库里
///   「复用内容哈希缓存」与「真算」的条数）。这是**只加列**的纯增量迁移，不重建任何表：
///   加这两列是为了让「向量复用到底生效没有」可观测，否则打开语义检索后只能靠猜。
/// - v6：`workspaces` 增加 `files_skipped` / `files_truncated`（上一次建库「没进索引的文件数」与
///   「是否被 16k 扫描上限截断」）。同样只加列、不重建：不报这两个数，用户只会看到
///   「我明明有这个文件，搜不到」。
pub const SCHEMA_VERSION: i32 = 6;

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
    // 「这个库初始化过没有」看两张表里的任意一张：初始化中途崩溃可能只留下 `workspaces`
    // （先建的那张），只看 `chunks` 会把这种半初始化库当成新库 → `CREATE IF NOT EXISTS`
    // 不会补 `workspaces` 上缺的列，迁移就此被跳过。
    if table_exists(conn, "chunks")? || table_exists(conn, "workspaces")? {
        migrate(conn, ver)
    } else {
        init_schema(conn)
    }
    .map_err(|e| CoreError::rpc("DB_SCHEMA_FAILED", e.to_string()))
}

/// 「这张表在这个库里存在吗」的唯一定义：索引侧多处要判「结构索引建了没」（两个索引共用一个库），
/// 各自写一份 `sqlite_master` 查询迟早会漏掉其中一处。
pub(super) fn table_exists(conn: &Connection, name: &str) -> Result<bool, CoreError> {
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
    if from < 5 {
        // v4 → v5：记录上一次建库的向量来源（复用缓存 / 真算），见 SCHEMA_VERSION 注释。
        add_vector_stats_columns(conn, 5)?;
    }
    // **顺序即语义**：每一步自己把 `user_version` 写成本步的版本号，所以必须按升序执行 ——
    // 把 v6 放在 v5 前面会让 v5 那步把版本号写回 5（当时就是这样，两个迁移用例立刻红）。
    if from < 6 {
        // v5 → v6：只加两列（幂等，重复执行吞 duplicate column）。
        crate::db_schema::ensure_column(conn, "workspaces", "files_skipped", "INTEGER DEFAULT 0")
            .map_err(|e| rusqlite::Error::ToSqlConversionFailure(Box::new(e)))?;
        crate::db_schema::ensure_column(conn, "workspaces", "files_truncated", "INTEGER DEFAULT 0")
            .map_err(|e| rusqlite::Error::ToSqlConversionFailure(Box::new(e)))?;
        conn.pragma_update(None, "user_version", 6)?;
    }
    Ok(())
}

/// 给 `workspaces` 补两列（幂等：列已存在就跳过）。
///
/// 用 `PRAGMA table_info` 判断而不是无脑 `ALTER TABLE`：SQLite 没有
/// `ADD COLUMN IF NOT EXISTS`，重复执行会报 duplicate column 并把整次迁移打回。
fn add_vector_stats_columns(conn: &Connection, to_version: i32) -> rusqlite::Result<()> {
    let mut have_reused = false;
    let mut have_embedded = false;
    {
        let mut stmt = conn.prepare("PRAGMA table_info(workspaces)")?;
        let mut rows = stmt.query([])?;
        while let Some(row) = rows.next()? {
            match row.get::<_, String>(1)?.as_str() {
                "vectors_reused" => have_reused = true,
                "vectors_embedded" => have_embedded = true,
                _ => {}
            }
        }
    }
    let tx = conn.unchecked_transaction()?;
    if !have_reused {
        tx.execute(
            "ALTER TABLE workspaces ADD COLUMN vectors_reused INTEGER DEFAULT 0",
            [],
        )?;
    }
    if !have_embedded {
        tx.execute(
            "ALTER TABLE workspaces ADD COLUMN vectors_embedded INTEGER DEFAULT 0",
            [],
        )?;
    }
    tx.pragma_update(None, "user_version", to_version)?;
    tx.commit()
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
        embedding_dims INTEGER DEFAULT 0,
        -- 上一次建库的向量来源分布（面板/诊断用）：复用跨 worktree 内容哈希缓存 vs 真算
        vectors_reused INTEGER DEFAULT 0,
        vectors_embedded INTEGER DEFAULT 0,
        -- 上一次建库「没能进索引」的文件数（超过单文件上限 / 二进制 / 读不出来）与
        -- 「被 16k 扫描上限截断」标记：不说出来，用户只会看到「我明明有这个文件却搜不到」。
        files_skipped INTEGER DEFAULT 0,
        files_truncated INTEGER DEFAULT 0
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
        vector BLOB NOT NULL
    );
";
// 这里**不声明** `FOREIGN KEY(chunk_id) REFERENCES chunks(id) ON DELETE CASCADE`：
// 索引库的库连接由 `SqliteHandle` 打开，`TuneOptions::foreign_keys` 默认 false
// （`sqlite.rs`）—— 声明了也不生效，只会让人以为「删 chunk 会自动删向量」。
// 级联在这儿是一份手写实现：`delete_chunks_for_path` / `delete_all_chunks`
// （见 `index/build.rs` 的写库原语），删 chunk 时同步删 `chunk_vectors`。

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

    /// 回归（P3）：索引库的建表语句里**不许**再出现外键声明（这个库不开 `foreign_keys`）。
    ///
    /// 级联的唯一实现是 `index/build.rs` 的写库原语（删 chunk 时同步删 `chunk_vectors`）。
    #[test]
    fn schema_declares_no_unenforced_foreign_keys() {
        let conn = Connection::open_in_memory().unwrap();
        init_schema(&conn).unwrap();
        let mut stmt = conn
            .prepare("SELECT name, sql FROM sqlite_master WHERE type='table' AND sql IS NOT NULL")
            .unwrap();
        let rows: Vec<(String, String)> = stmt
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap()
            .map(|r| r.unwrap())
            .collect();
        assert!(!rows.is_empty());
        for (name, sql) in rows {
            assert!(
                !sql.to_uppercase().contains("FOREIGN KEY"),
                "{name} 仍在声明外键，但这个库不开 foreign_keys —— 级联请写进 build.rs 的原语"
            );
        }
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

    /// v4 → v5：补两列统计，**不动任何已有数据**（厂里的 daemon 都是 v4 库）。
    #[test]
    fn migrates_v4_db_by_adding_vector_stat_columns() {
        let conn = Connection::open_in_memory().unwrap();
        // 造一个 v4 的库：没有 vectors_reused / vectors_embedded 两列
        conn.execute_batch(
            "CREATE TABLE workspaces (
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
             INSERT INTO workspaces (root_hash, root_path, file_count, chunk_count,
                                     vector_count, indexed_at, embedding_model, embedding_dims)
                 VALUES ('rh', '/repo', 7, 42, 42, 1700000000, 'bge@768', 768);
             CREATE TABLE chunks (
                 id INTEGER PRIMARY KEY AUTOINCREMENT,
                 root_hash TEXT NOT NULL,
                 rel_path TEXT NOT NULL,
                 start_line INTEGER NOT NULL,
                 end_line INTEGER NOT NULL,
                 content TEXT NOT NULL,
                 mtime INTEGER NOT NULL
             );",
        )
        .unwrap();
        conn.pragma_update(None, "user_version", 4).unwrap();

        ensure_schema(&conn).unwrap();

        let row: (i64, i64, i64, Option<String>, i64, i64, i64) = conn
            .query_row(
                "SELECT file_count, chunk_count, vector_count, embedding_model, embedding_dims,
                        vectors_reused, vectors_embedded
                 FROM workspaces WHERE root_hash = 'rh'",
                [],
                |r| {
                    Ok((
                        r.get(0)?,
                        r.get(1)?,
                        r.get(2)?,
                        r.get(3)?,
                        r.get(4)?,
                        r.get(5)?,
                        r.get(6)?,
                    ))
                },
            )
            .unwrap();
        assert_eq!(row, (7, 42, 42, Some("bge@768".into()), 768, 0, 0),
            "迁移只加列：存量计数与签名必须原样保留，新列默认 0");
        let cur: i32 = conn
            .pragma_query_value(None, "user_version", |r| r.get(0))
            .unwrap();
        assert_eq!(cur, SCHEMA_VERSION);

        // 幂等：再跑一遍不报 duplicate column
        ensure_schema(&conn).unwrap();
    }
}

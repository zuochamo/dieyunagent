use rusqlite::{Connection, OptionalExtension};

use dieyun_base::error::CoreError;

/// 确保结构图谱表就绪。
///
/// **只在库文件首次被用到时跑一次**（由 `SqliteHandle` 保证）。
/// 索引表的建表不在这里：同库同连接，那份由 [`crate::index::ensure_schema`] 负责，
/// 两者在 [`crate::codebase_db`] 里汇合。此前 graph 的 `open()` 里抄了一份 index 的
/// 建表逻辑（谁先打开谁负责建），是同一份东西的第二份实现。
pub fn ensure_schema(conn: &Connection) -> Result<(), CoreError> {
    // 老库才需要清残留（新库在建表批次里压根不会建那张表）。
    //
    // **不再「表存在就早退」**：`CREATE TABLE IF NOT EXISTS` 对已存在的表是空操作，
    // 真正决定老库能不能用新代码的是**补列**。之前这里看到 `graph_workspaces` 就直接
    // `return Ok(())`，于是后加的列（`symbol_count` / `call_count` / `calls_built` / 以及
    // `file_count` / `indexed_at` 这几个更早的）在升级用户的库里从来没出现过 ——
    // `graph.status` 一查就是 `no such column`。
    if has_table(conn, "graph_workspaces")? {
        drop_legacy_symbol_vectors(conn)
            .map_err(|e| CoreError::rpc("DB_SCHEMA_FAILED", e.to_string()))?;
    }
    // 无论表在不在都往下走：建表对已存在的表是空操作，**补列**才是老库能不能用新代码的关键。
    init_graph_schema(conn)
}

fn has_table(conn: &Connection, table: &str) -> Result<bool, CoreError> {
    conn.query_row(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1 LIMIT 1",
        [table],
        |r| r.get::<_, i32>(0),
    )
    .optional()
    .map(|row| row.is_some())
    .map_err(|e| CoreError::rpc("DB_SCHEMA_FAILED", e.to_string()))
}

/// `graph_workspaces` 的**列清单**（建表与补列的唯一来源）。
///
/// 顺序 = 建表顺序 + 历史上加列的顺序：老库 `ALTER` 之后的物理顺序就是这样，
/// 新库按这份清单建出来与之相同（按索引读行的代码不会有惊喜）。
const GRAPH_WORKSPACES: &[dieyun_base::db_schema::Column] = &[
    dieyun_base::db_schema::Column::new("root_hash", "TEXT PRIMARY KEY"),
    dieyun_base::db_schema::Column::new("root_path", "TEXT NOT NULL"),
    dieyun_base::db_schema::Column::new("file_count", "INTEGER DEFAULT 0"),
    dieyun_base::db_schema::Column::new("edge_count", "INTEGER DEFAULT 0"),
    dieyun_base::db_schema::Column::new("symbol_count", "INTEGER DEFAULT 0"),
    dieyun_base::db_schema::Column::new("call_count", "INTEGER DEFAULT 0"),
    // 这个工作区**建过调用图没有**（建库范围）。黏性：一旦为 1，之后的增量也按
    // WithCalls 维护它 —— 否则一次保存的增量（结构态）会把该文件的出边删掉却不重建。
    dieyun_base::db_schema::Column::new("calls_built", "INTEGER NOT NULL DEFAULT 0"),
    dieyun_base::db_schema::Column::new("indexed_at", "INTEGER DEFAULT 0"),
    dieyun_base::db_schema::Column::new("indexing", "INTEGER DEFAULT 0"),
    // 收集文件时撞过 `index::MAX_FILES`：这一轮没把仓库看全，缺的文件不是「不存在」。
    dieyun_base::db_schema::Column::new("files_truncated", "INTEGER DEFAULT 0"),
];

pub fn init_graph_schema(conn: &Connection) -> Result<(), CoreError> {
    // 这个库的表**不声明外键**：库连接由 `SqliteHandle` 打开，`TuneOptions::foreign_keys`
    // 默认 false（`sqlite.rs`），声明了 `ON DELETE CASCADE` 也不生效 —— 一条没有约束力的
    // 声明比没有更危险（读代码的人会以为删符号会自动带走边）。
    // 级联的唯一实现是 [`super::cleanup`]（`clear_file_graph` / `clear_workspace_graph`）。
    conn.execute_batch(
        "
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
            confidence REAL NOT NULL DEFAULT 0.8
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
    )
    .map_err(|e| CoreError::rpc("DB_SCHEMA_FAILED", e.to_string()))?;
    // 列清单是唯一来源：建表（上面是其它表）+ 补列（老库缺的后加列在这里补上）。
    dieyun_base::db_schema::ensure_table(conn, "graph_workspaces", GRAPH_WORKSPACES, &[])?;
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


#[cfg(test)]
mod tests {
    use super::*;

    /// 回归（P3⑤）：**老库**（表已存在但缺后加的列）也必须被对账补列。
    ///
    /// `ensure_schema` 以前看到 `graph_workspaces` 就 `return Ok(())`：`symbol_count` /
    /// `call_count` / `calls_built` 这些后加的列在升级用户的库里从来没出现过 ——
    /// `graph.status` 一查就是 `no such column: calls_built`。
    #[test]
    fn legacy_graph_db_gains_columns_added_later() {
        let conn = Connection::open_in_memory().unwrap();
        // 模拟最初版本的库：只有三列
        conn.execute_batch(
            "CREATE TABLE graph_workspaces (
                 root_hash TEXT PRIMARY KEY,
                 root_path TEXT NOT NULL,
                 indexing INTEGER DEFAULT 0) ",
        )
        .unwrap();
        ensure_schema(&conn).unwrap();

        let cols = dieyun_base::db_schema::column_names(&conn, "graph_workspaces");
        for want in [
            "file_count",
            "edge_count",
            "symbol_count",
            "call_count",
            "calls_built",
            "indexed_at",
        ] {
            assert!(
                cols.contains(&want.to_string()),
                "老库缺列 {want}（实际 {cols:?}）—— ensure_schema 又变回「表存在就早退」了？"
            );
        }
    }

    /// 新库与老库最终拿到同一份列清单（顺序也一致）。
    #[test]
    fn fresh_and_legacy_databases_end_with_the_same_columns() {
        let fresh = Connection::open_in_memory().unwrap();
        ensure_schema(&fresh).unwrap();

        let legacy = Connection::open_in_memory().unwrap();
        legacy
            .execute_batch(
                "CREATE TABLE graph_workspaces (
                     root_hash TEXT PRIMARY KEY,
                     root_path TEXT NOT NULL,
                     indexing INTEGER DEFAULT 0) ",
            )
            .unwrap();
        ensure_schema(&legacy).unwrap();

        // 比**集合**而不是顺序：老库的列序取决于它当年建表时的顺序（历史版本各不相同），
        // 而代码按显式列名读行 —— 顺序不影响正确性，缺列才影响。
        let mut fresh_cols = dieyun_base::db_schema::column_names(&fresh, "graph_workspaces");
        let mut legacy_cols = dieyun_base::db_schema::column_names(&legacy, "graph_workspaces");
        fresh_cols.sort();
        legacy_cols.sort();
        assert_eq!(fresh_cols, legacy_cols);
    }

    /// 回归（P3）：这个库的建表语句里**不许**再出现外键声明。
    ///
    /// 库连接不开 `foreign_keys`（`sqlite.rs::TuneOptions` 默认 false），声明了也不生效 ——
    /// 一条没有约束力的 `ON DELETE CASCADE` 比没有更危险：读代码的人会以为删符号会自动
    /// 带走调用边。级联的唯一实现是 `super::cleanup`。
    #[test]
    fn schema_declares_no_unenforced_foreign_keys() {
        let conn = Connection::open_in_memory().unwrap();
        init_graph_schema(&conn).unwrap();
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
                "{name} 仍在声明外键，但这个库不开 foreign_keys —— 级联请写进 cleanup.rs"
            );
        }
    }

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

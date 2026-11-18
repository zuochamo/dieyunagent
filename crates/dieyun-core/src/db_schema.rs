//! 声明式表结构：**一份列清单**同时产出「建表」与「补列」。
//!
//! 为什么需要它：同一个表结构写在两处 —— `CREATE TABLE` 一份、后续加列的
//! `ALTER TABLE ADD COLUMN` 一份。两处漂移过一次就很难发现：新库（走 CREATE）有列、
//! 老库（走 ALTER）也补上了，看起来都对；漏写 ALTER 时只有**老库**坏，而开发机上的库
//! 多半是新的。典型受害者是本仓的 `graph_workspaces`：`symbol_count` / `call_count` /
//! `calls_built` 都是后加的列，而 `graph::ensure_schema` 看到表已存在就**直接返回**，
//! 于是老库这些列从来没补上，`graph.status` 一查就是 `no such column`。
//!
//! 规则：
//! - **一张表一份列清单**：`Column { name, decl }`，`decl` 在建表与 `ADD COLUMN` 里**同一份文本**；
//! - 表级约束（外键、复合主键）走 `constraints`，只进建表、不参与补列；
//! - 列顺序 = 「建表时的顺序」+「历史上加列的顺序」，与老库 `ALTER` 之后的物理顺序一致，
//!   这样新库与老库的列序相同（按索引读行的代码不会有惊喜）；
//! - 补列只吞「列已存在」，其余上抛（P4 建立的语义，别在这里放宽）。

use rusqlite::Connection;

use crate::error::CoreError;

/// 一列的定义。`decl` 同时用于 `CREATE TABLE` 与 `ALTER TABLE … ADD COLUMN`。
pub(crate) struct Column {
    pub name: &'static str,
    /// 例如 `TEXT NOT NULL`、`INTEGER DEFAULT 0`。
    /// 注意 SQLite 的限制：`ADD COLUMN` 不能加 `PRIMARY KEY` / `UNIQUE`，
    /// 且 `NOT NULL` 必须带默认值 —— 这类列只可能出现在建表语句里（老库必然已有）。
    pub decl: &'static str,
}

impl Column {
    pub(crate) const fn new(name: &'static str, decl: &'static str) -> Self {
        Self { name, decl }
    }
}

/// 按列清单确保表存在且列齐全。
///
/// - 表不存在 → 用这份清单建表（列清单是唯一来源）；
/// - 表已存在 → 逐列对账，缺的补上（**不再「表存在就早退」**）。
pub(crate) fn ensure_table(
    conn: &Connection,
    table: &str,
    columns: &[Column],
    constraints: &[&str],
) -> Result<(), CoreError> {
    let mut ddl = format!("CREATE TABLE IF NOT EXISTS {table} (");
    for (i, col) in columns.iter().enumerate() {
        if i > 0 {
            ddl.push_str(", ");
        }
        ddl.push_str(col.name);
        ddl.push(' ');
        ddl.push_str(col.decl);
    }
    for extra in constraints {
        ddl.push_str(", ");
        ddl.push_str(extra);
    }
    ddl.push(')');
    conn.execute_batch(&ddl)
        .map_err(|e| CoreError::rpc("DB_SCHEMA_FAILED", format!("建表 {table} 失败：{e}")))?;
    for col in columns {
        ensure_column(conn, table, col.name, col.decl)?;
    }
    Ok(())
}

/// 补一列，**只吞「列已存在」**（重复执行迁移的正常路径）。
///
/// 其它失败（只读库 / 磁盘满 / BUSY / 该列被索引引用）必须上抛：否则迁移真失败时
/// `init_schema` 仍返回 Ok，错误被推迟到后续某次业务写入才以 `no such column` 出现。
pub(crate) fn ensure_column(
    conn: &Connection,
    table: &str,
    column: &str,
    decl: &str,
) -> Result<(), CoreError> {
    let sql = format!("ALTER TABLE {table} ADD COLUMN {column} {decl}");
    match conn.execute(&sql, []) {
        Ok(_) => Ok(()),
        Err(e) if e.to_string().contains("duplicate column name") => Ok(()),
        Err(e) => Err(CoreError::rpc(
            "DB_SCHEMA_FAILED",
            format!("补列 {table}.{column} 失败：{e}"),
        )),
    }
}

/// 表里现有列名（测试与诊断用）。
#[cfg(test)]
pub(crate) fn column_names(conn: &Connection, table: &str) -> Vec<String> {
    let mut stmt = conn
        .prepare(&format!("PRAGMA table_info({table})"))
        .expect("PRAGMA table_info");
    stmt.query_map([], |r| r.get::<_, String>(1))
        .expect("query_map")
        .filter_map(Result::ok)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    const COLS: &[Column] = &[
        Column::new("id", "INTEGER PRIMARY KEY AUTOINCREMENT"),
        Column::new("name", "TEXT NOT NULL"),
    ];

    /// 新库与老库最终列集一致：老库缺的列会被补上，且顺序与新建一致。
    #[test]
    fn existing_table_gains_missing_columns_in_declared_order() {
        let conn = Connection::open_in_memory().unwrap();
        // 模拟老库：只有 id（后加的 name 还没补）
        conn.execute_batch("CREATE TABLE t (id INTEGER PRIMARY KEY AUTOINCREMENT)")
            .unwrap();
        ensure_table(&conn, "t", COLS, &[]).unwrap();
        assert_eq!(column_names(&conn, "t"), vec!["id".to_string(), "name".to_string()]);

        // 全新库走同一条路，列集相同
        let fresh = Connection::open_in_memory().unwrap();
        ensure_table(&fresh, "t", COLS, &[]).unwrap();
        assert_eq!(column_names(&fresh, "t"), column_names(&conn, "t"));
    }

    /// **表已存在 ≠ 结构已就绪**：这一条正是 `graph::ensure_schema` 早退的根因。
    #[test]
    fn existing_table_is_still_reconciled() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE t (id INTEGER PRIMARY KEY AUTOINCREMENT)")
            .unwrap();
        // 第一次：补上 name
        ensure_table(&conn, "t", COLS, &[]).unwrap();
        // 第二次：幂等，不报错
        ensure_table(&conn, "t", COLS, &[]).unwrap();
        assert!(column_names(&conn, "t").contains(&"name".to_string()));
    }

    /// 表级约束只进建表，不参与补列。
    #[test]
    fn constraints_apply_only_to_create() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE parent (id INTEGER PRIMARY KEY)")
            .unwrap();
        ensure_table(
            &conn,
            "child",
            &[
                Column::new("id", "INTEGER PRIMARY KEY"),
                Column::new("parent_id", "INTEGER NOT NULL"),
            ],
            &["FOREIGN KEY (parent_id) REFERENCES parent(id)"],
        )
        .unwrap();
        let ddl: String = conn
            .query_row(
                "SELECT sql FROM sqlite_master WHERE type='table' AND name='child'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert!(ddl.contains("FOREIGN KEY"), "{ddl}");
    }
}

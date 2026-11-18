//! 这个模块的测试。实现留在同级文件里。
//! 拆开的理由：几百行用例与实现同居时，改一个方法要在整片用例之间翻，diff 也不可读。

use super::*;

use dieyun_base::sqlite::SqliteHandle;
use rusqlite::Connection;
use std::path::PathBuf;

fn db_failed(e: rusqlite::Error) -> CoreError {
    CoreError::rpc("TEST_DB", e.to_string())
}

fn temp_db_path(tag: &str) -> PathBuf {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    std::env::temp_dir().join(format!(
        "dieyun-memory-schema-{tag}-{}-{nanos}.sqlite",
        std::process::id()
    ))
}

/// 探针的 UPDATE 只命中行才会被触发器拦下 —— 空表探针必然「成功」。
fn seed_long_memory(conn: &Connection) {
    conn.execute(
        "INSERT INTO long_memories (content, source, created_at) VALUES ('x', 'test', 1)",
        [],
    )
    .expect("seed long_memories");
}

/// 模拟「FTS 影子表损坏」：任何命中行的 long_memories 写入都报错。
/// 真实故障是 FTS 触发器抛 `database disk image is malformed`，形状相同：语句报错。
fn break_long_memory_writes(conn: &Connection) {
    conn.execute_batch(
        "CREATE TRIGGER break_lm_write BEFORE UPDATE ON long_memories
         BEGIN SELECT RAISE(ABORT, 'fts shadow table is malformed'); END;",
    )
    .expect("inject failing trigger");
}

/// 探针失败绝不能让常驻写连接停在事务里。
///
/// 曾经的手写 `execute_batch("SAVEPOINT …; ROLLBACK TO …; RELEASE …")` 会在中间语句
/// 报错时跳过自己的 ROLLBACK/RELEASE：连接从此停在事务里，此后**所有**写入都进同一个
/// 永不提交的事务（WAL 里一天 7611 帧、0 个 commit 标记），进程一退全部丢失。
#[test]
fn broken_fts_must_not_leave_write_conn_in_open_transaction() {
    let conn = Connection::open_in_memory().expect("memory db");
    init_schema(&conn).expect("schema");
    seed_long_memory(&conn);
    break_long_memory_writes(&conn);

    init_schema(&conn).expect("探针失败不是致命错误，建表仍应成功");

    assert!(
        conn.is_autocommit(),
        "探针失败后连接必须回到 autocommit，否则之后的每条写入都会被永远吞掉"
    );
}

/// 真实首装路径：老库有数据、还没有 FTS 索引时第一次启动。
///
/// 钉住两件事：判定只能靠探针（`COUNT(*) FROM long_memories_fts` 对 external content 表
/// 读的就是源表，行数守卫永远相等）；修好之后重建必须**提交**。
#[test]
fn legacy_db_gets_fts_index_built_on_first_open() {
    let path = temp_db_path("legacy-fts");
    {
        let conn = Connection::open(&path).expect("file db");
        init_schema(&conn).expect("schema");
        conn.execute(
            "INSERT INTO long_memories (content, source, created_at) VALUES ('老库里的记忆', 'legacy', 1)",
            [],
        )
        .expect("seed");
        // 退回「有数据、无索引」的老库状态
        conn.execute_batch(
            "DROP TRIGGER IF EXISTS long_memories_fts_ai;
             DROP TRIGGER IF EXISTS long_memories_fts_au;
             DROP TRIGGER IF EXISTS long_memories_fts_ad;
             DROP TABLE long_memories_fts;",
        )
        .expect("drop fts");
    }

    // 首次用新代码打开：建表把 FTS 建出来（空索引），探针必须发现并重建
    let handle = SqliteHandle::new_with_foreign_keys(path.clone(), init_schema);
    handle
        .with_conn(|conn| {
            conn.execute("UPDATE long_memories SET status = 'archived' WHERE id = 1", [])
                .map_err(db_failed)?;
            Ok(())
        })
        .expect("索引重建后，走 delete 路径的 UPDATE 不应再失败");

    // 而且这次重建必须真的提交，不是躲在某个未提交事务里
    let fresh = Connection::open(&path).expect("fresh conn");
    let status: String = fresh
        .query_row("SELECT status FROM long_memories WHERE id = 1", [], |r| r.get(0))
        .expect("read back");
    assert_eq!(status, "archived");
    let docsize: i64 = fresh
        .query_row("SELECT COUNT(*) FROM long_memories_fts_docsize", [], |r| r.get(0))
        .expect("docsize");
    assert_eq!(docsize, 1, "重建后的索引必须已提交（docsize 有行）");
    drop(fresh);
    let _ = std::fs::remove_file(&path);
}

/// 承接上一例：探针失败之后，写入必须真的落地（另一个连接看得见）。
#[test]
fn memory_writes_still_commit_after_broken_fts_probe() {
    let path = temp_db_path("fts-probe-commit");
    {
        let conn = Connection::open(&path).expect("file db");
        init_schema(&conn).expect("schema");
        seed_long_memory(&conn);
        break_long_memory_writes(&conn);
    }

    let handle = SqliteHandle::new_with_foreign_keys(path.clone(), init_schema);
    // 首次 with_conn 会跑建表 → 探针失败 → 随后这条写入必须提交
    handle
        .with_conn(|conn| {
            conn.execute(
                "INSERT INTO sessions (id, updated_at, title) VALUES ('s1', 1, 't')",
                [],
            )
            .map_err(db_failed)?;
            Ok(())
        })
        .expect("write via resident conn");

    let dedicated = handle.open_dedicated().expect("dedicated");
    let n: i64 = dedicated
        .query_row("SELECT COUNT(*) FROM sessions", [], |r| r.get(0))
        .map_err(db_failed)
        .expect("count sessions");
    assert_eq!(
        n, 1,
        "探针失败不得让后续写入卡在未提交事务里（独立连接必须看得见这条写入）"
    );
    drop(dedicated);
    let _ = std::fs::remove_file(&path);
}

//! 这个模块的测试。实现留在同级文件里。
//! 拆开的理由：几百行用例与实现同居时，改一个方法要在整片用例之间翻，diff 也不可读。

use super::*;

use std::sync::atomic::{AtomicUsize, Ordering};


#[test]
fn tune_sets_expected_pragmas() {
    let conn = Connection::open_in_memory().expect("open in-memory db");
    tune(&conn).expect("tune should succeed");

    // 0=OFF 1=NORMAL 2=FULL；pragma 返回整数而非字符串
    let sync_mode: i64 = conn
        .pragma_query_value(None, "synchronous", |r| r.get(0))
        .expect("read synchronous");
    assert_eq!(sync_mode, 1, "synchronous 应为 NORMAL");

    let autockpt: i64 = conn
        .pragma_query_value(None, "wal_autocheckpoint", |r| r.get(0))
        .expect("read wal_autocheckpoint");
    assert_eq!(autockpt, WAL_AUTOCHECKPOINT_PAGES);

    let cache: i64 = conn
        .pragma_query_value(None, "cache_size", |r| r.get(0))
        .expect("read cache_size");
    assert_eq!(cache, CACHE_SIZE_KIB);
}

#[test]
fn tune_enables_incremental_auto_vacuum_on_new_db() {
    let dir = std::env::temp_dir().join(format!(
        "dieyun-sqlite-av-test-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    ));
    let db = dir.join("empty.db");
    let conn = open_tuned(&db).expect("open_tuned");
    let mode: i64 = conn
        .pragma_query_value(None, "auto_vacuum", |r| r.get(0))
        .expect("read auto_vacuum");
    assert_eq!(mode, 2, "空库上设置 auto_vacuum 应立即生效为 INCREMENTAL");
    drop(conn);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn open_tuned_reopens_legacy_db_and_vacuum_finishes_conversion() {
    let dir = std::env::temp_dir().join(format!(
        "dieyun-sqlite-legacy-test-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    ));
    let db = dir.join("legacy.db");
    {
        let conn = open_tuned(&db).expect("open new db");
        conn.execute_batch("CREATE TABLE t (a INTEGER); INSERT INTO t VALUES (1);")
            .expect("seed");
    }
    // 非空库 + 已是 WAL：auto_vacuum 不会再被接受，但绝不能因此打不开库。
    let conn = open_tuned(&db).expect("reopen legacy db");
    let n: i64 = conn
        .query_row("SELECT COUNT(*) FROM t", [], |r| r.get(0))
        .expect("read");
    assert_eq!(n, 1);
    // 转换路径：老库要一次 VACUUM 才落定 INCREMENTAL（周期修剪走的就是这一步）。
    conn.execute_batch("VACUUM;").expect("vacuum");
    let mode: i64 = conn
        .pragma_query_value(None, "auto_vacuum", |r| r.get(0))
        .expect("read auto_vacuum");
    assert_eq!(mode, 2, "VACUUM 后应完成 INCREMENTAL 转换");
    drop(conn);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn tune_leaves_foreign_keys_untouched() {
    let conn = Connection::open_in_memory().expect("open in-memory db");
    let before: i64 = conn
        .pragma_query_value(None, "foreign_keys", |r| r.get(0))
        .expect("read foreign_keys");

    tune(&conn).expect("tune should succeed");

    let after: i64 = conn
        .pragma_query_value(None, "foreign_keys", |r| r.get(0))
        .expect("read foreign_keys");
    assert_eq!(after, before, "tune 不应改变 foreign_keys");
}

#[test]
fn open_tuned_creates_parent_dirs() {
    let dir = std::env::temp_dir().join(format!(
        "dieyun-sqlite-test-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    ));
    let db = dir.join("nested").join("codebase.db");
    let conn = open_tuned(&db).expect("open_tuned 应自动建目录");
    conn.execute("CREATE TABLE t (a INTEGER)", [])
        .expect("write");
    drop(conn);
    let _ = std::fs::remove_dir_all(&dir);
}

// ---- SqliteHandle：连接生命周期 ----

fn temp_db(tag: &str) -> PathBuf {
    std::env::temp_dir()
        .join(format!(
            "dieyun-sqlite-handle-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ))
        .join("codebase.db")
}

fn cleanup(db: &Path) {
    if let Some(parent) = db.parent() {
        let _ = std::fs::remove_dir_all(parent);
    }
}

fn db_failed(e: rusqlite::Error) -> CoreError {
    CoreError::rpc("DB_FAILED", e.to_string())
}

static INITS: AtomicUsize = AtomicUsize::new(0);

fn init_counting(conn: &Connection) -> Result<(), CoreError> {
    INITS.fetch_add(1, Ordering::SeqCst);
    create_table_t(conn)
}

// 计数器是进程级 static，而 cargo 并行跑测试：独立连接的用例必须用自己的那份，
// 否则两个用例互相清零，断言变成随机的。
static DEDICATED_INITS: AtomicUsize = AtomicUsize::new(0);

fn init_counting_dedicated(conn: &Connection) -> Result<(), CoreError> {
    DEDICATED_INITS.fetch_add(1, Ordering::SeqCst);
    create_table_t(conn)
}

fn create_table_t(conn: &Connection) -> Result<(), CoreError> {
    conn.execute_batch("CREATE TABLE IF NOT EXISTS t (a INTEGER);")
        .map_err(|e| CoreError::rpc("DB_SCHEMA_FAILED", e.to_string()))
}

#[test]
fn handle_inits_once_and_reuses_connection() {
    INITS.store(0, Ordering::SeqCst);
    let db = temp_db("once");
    let handle = SqliteHandle::new(db.clone(), init_counting);

    for i in 0..5 {
        handle
            .with_conn(|conn| {
                conn.execute("INSERT INTO t (a) VALUES (?1)", [i])
                    .map_err(db_failed)
            })
            .expect("write");
    }

    assert_eq!(INITS.load(Ordering::SeqCst), 1, "建表只应发生一次");
    let rows: i64 = handle
        .with_conn(|conn| {
            conn.query_row("SELECT COUNT(*) FROM t", [], |r| r.get(0))
                .map_err(db_failed)
        })
        .expect("count");
    assert_eq!(rows, 5, "五次写入都落在同一条常驻连接上");
    assert_eq!(handle.path(), db.as_path());
    cleanup(&db);
}

/// 读路径上的「非必要写」不许排队：写连接被占着时立刻返回 `None`。
///
/// 这条钉住的是 `memory::MemoryStore::bump_memory_usage` 的语义（`access_count` 提示信号），
/// 一旦有人把它改回 `with_conn`，召回就会重新排在聊天落库后面
/// （实测 p50 1ms → 135ms，见 `docs/SQLITE-ACCESS.md`）。
#[test]
fn try_with_conn_skips_instead_of_waiting_when_write_conn_is_busy() {
    let db = temp_db("try-conn");
    // 用不带进程级计数器的 init：并行跑测试时另一个用例正盯着 INITS 那个 static
    let handle = std::sync::Arc::new(SqliteHandle::new(db.clone(), create_table_t));
    handle.with_conn(|_| Ok(())).expect("warm up");

    let (tx, rx) = std::sync::mpsc::channel();
    let holder = std::sync::Arc::clone(&handle);
    let worker = std::thread::spawn(move || {
        holder
            .with_conn(|_| {
                tx.send(()).expect("signal");
                std::thread::sleep(Duration::from_millis(400));
                Ok(())
            })
            .expect("hold write conn");
    });
    rx.recv().expect("写连接已被占用");

    let started = std::time::Instant::now();
    let skipped = handle.try_with_conn(|_| Ok(7)).expect("try_with_conn");
    assert!(skipped.is_none(), "写连接繁忙时应跳过，而不是排队");
    assert!(
        started.elapsed() < Duration::from_millis(200),
        "try_with_conn 不许等待写连接（实测 {:?}）",
        started.elapsed()
    );

    worker.join().expect("holder thread");
    // 空闲时它照样要能写进去
    assert_eq!(
        handle.try_with_conn(|_| Ok(7)).expect("try_with_conn idle"),
        Some(7)
    );
    cleanup(&db);
}

static FLAKY: AtomicUsize = AtomicUsize::new(0);

fn init_fails_first_time(conn: &Connection) -> Result<(), CoreError> {
    if FLAKY.fetch_add(1, Ordering::SeqCst) == 0 {
        return Err(CoreError::rpc("DB_SCHEMA_FAILED", "首次建表故意失败"));
    }
    conn.execute_batch("CREATE TABLE IF NOT EXISTS t (a INTEGER);")
        .map_err(|e| CoreError::rpc("DB_SCHEMA_FAILED", e.to_string()))
}

#[test]
fn handle_does_not_cache_half_initialized_connection() {
    FLAKY.store(0, Ordering::SeqCst);
    let db = temp_db("flaky");
    let handle = SqliteHandle::new(db.clone(), init_fails_first_time);

    assert!(
        handle.with_conn(|_| Ok(())).is_err(),
        "首次应把建表失败暴露给调用方"
    );
    // 失败没被缓存：下一次重新开连接、重跑建表，而不是永远少一张表。
    handle
        .with_conn(|conn| conn.execute("INSERT INTO t (a) VALUES (1)", []).map_err(db_failed))
        .expect("第二次应重试成功");
    assert_eq!(FLAKY.load(Ordering::SeqCst), 2, "失败不应阻止重试");
    cleanup(&db);
}

#[test]
fn handle_dedicated_connection_reuses_schema_but_not_lock() {        DEDICATED_INITS.store(0, Ordering::SeqCst);
    let db = temp_db("dedicated");
    let handle = SqliteHandle::new(db.clone(), init_counting_dedicated);

    let dedicated = handle.open_dedicated().expect("open dedicated");
    assert_eq!(
        DEDICATED_INITS.load(Ordering::SeqCst),
        1,
        "独立连接不得再跑一遍建表"
    );

    dedicated
        .execute("INSERT INTO t (a) VALUES (7)", [])
        .expect("write via dedicated");
    let n: i64 = handle
        .with_conn(|conn| {
            conn.query_row("SELECT COUNT(*) FROM t", [], |r| r.get(0))
                .map_err(db_failed)
        })
        .expect("read via resident");
    assert_eq!(n, 1, "独立连接的已提交写入对常驻连接可见");
    cleanup(&db);
}

/// 建表钩子把连接留在事务里（历史事故的真实形状）：后续写入必须照样提交。
fn init_leaving_transaction(conn: &Connection) -> Result<(), CoreError> {
    create_table_t(conn)?;
    // 模拟 `execute_batch("BEGIN; …")` 里那句语句报错后没人回滚的残留
    conn.execute_batch("BEGIN; INSERT INTO t (a) VALUES (99);")
        .map_err(|e| CoreError::rpc("DB_SCHEMA_FAILED", e.to_string()))
}

/// 漏事务必须在这里被拦住：它是静默的，代价是整个进程的数据。
#[test]
fn with_conn_rolls_back_transaction_leaked_by_schema_init() {
    let db = temp_db("leaked-txn");
    let handle = SqliteHandle::new(db.clone(), init_leaving_transaction);

    handle
        .with_conn(|conn| conn.execute("INSERT INTO t (a) VALUES (1)", []).map_err(db_failed))
        .expect("write after leaked transaction");

    // 用一条全新连接看「已提交」状态：常驻连接自己会看见脏数据，不能作证。
    let fresh = Connection::open(&db).expect("fresh conn");
    let rows: Vec<i64> = fresh
        .prepare("SELECT a FROM t ORDER BY a")
        .expect("prepare")
        .query_map([], |r| r.get(0))
        .expect("query")
        .collect::<Result<_, _>>()
        .expect("collect");
    assert_eq!(
        rows,
        vec![1],
        "残留事务应被回滚（99 消失），本轮写入必须真的提交"
    );
    drop(fresh);
    cleanup(&db);
}

/// 读侧不许被写事务拖住：WAL 下常驻连接照常读到写事务开始前的快照。
///
/// 这是 `codebase.status` 的 15s 宿主预算的底线保障 —— status 走的正是常驻连接，
/// 一旦它在等写锁，表现就是面板「读取失败」。
#[test]
fn resident_read_is_not_blocked_by_open_write_transaction() {
    let db = temp_db("wal-read");
    let handle = SqliteHandle::new(db.clone(), create_table_t);
    handle
        .with_conn(|conn| conn.execute("INSERT INTO t (a) VALUES (1)", []).map_err(db_failed))
        .expect("seed");

    let writer = handle.open_dedicated().expect("open writer");
    writer
        .execute_batch("BEGIN IMMEDIATE; INSERT INTO t (a) VALUES (2);")
        .expect("hold write transaction");

    let started = std::time::Instant::now();
    let n: i64 = handle
        .with_conn(|conn| {
            conn.query_row("SELECT COUNT(*) FROM t", [], |r| r.get(0))
                .map_err(db_failed)
        })
        .expect("read via resident");
    let elapsed = started.elapsed();

    writer.execute_batch("ROLLBACK").expect("rollback");
    drop(writer);
    cleanup(&db);

    assert_eq!(n, 1, "读到的是写事务开始前的快照");
    assert!(
        elapsed < std::time::Duration::from_secs(1),
        "常驻读等了 {elapsed:?}：写事务把读路径堵住了"
    );
}

/// 开独立连接同样不许被写事务拖住。
///
/// `tune` 里那条 `auto_vacuum` 曾无条件执行，而它即便值不变也要拿写锁：
/// 长任务（结构索引 / 向量构建）开着写事务时，**每一条**新连接都要等满
/// `BUSY_TIMEOUT_SECS`（实测 16s）。这里用「老库」（auto_vacuum 仍为 0）
/// 覆盖「需要尝试设置」的那条路径。
#[test]
fn opening_dedicated_connection_does_not_wait_on_open_write_transaction() {
    let db = temp_db("slow-tune");
    {
        std::fs::create_dir_all(db.parent().expect("temp dir")).expect("mkdir");
        let legacy = Connection::open(&db).expect("raw open");
        legacy
            .execute_batch("CREATE TABLE t (a INTEGER); INSERT INTO t (a) VALUES (1);")
            .expect("seed legacy db");
    }
    let handle = SqliteHandle::new(db.clone(), create_table_t);
    let writer = handle.open_dedicated().expect("open writer");
    writer
        .execute_batch("BEGIN IMMEDIATE;")
        .expect("hold write transaction");

    let started = std::time::Instant::now();
    let reader = handle.open_dedicated().expect("open dedicated");
    let elapsed = started.elapsed();

    drop(reader);
    writer.execute_batch("ROLLBACK").expect("rollback");
    drop(writer);
    cleanup(&db);

    assert!(
        elapsed < std::time::Duration::from_secs(1),
        "开独立连接等了 {elapsed:?}：tune 又在写库"
    );
}

// ---- 读侧连接池 ----

/// 池化读必须**完全绕开常驻锁**：常驻连接被长任务（写事务 + 持锁）占住时，
/// `read` 也要立刻返回，而不是排队到 `BUSY_TIMEOUT_SECS`。
#[test]
fn read_does_not_wait_on_resident_lock_holder() {
    let db = temp_db("read-pool-nonblocking");
    let handle = std::sync::Arc::new(SqliteHandle::new(db.clone(), create_table_t));
    handle
        .with_conn(|conn| conn.execute("INSERT INTO t (a) VALUES (1)", []).map_err(db_failed))
        .expect("seed");

    // 常驻锁被占住 400ms（模拟一条长写事务）
    let held = handle.clone();
    let holder = std::thread::spawn(move || {
        held.with_conn(|conn| {
            conn.execute_batch("BEGIN IMMEDIATE;").map_err(db_failed)?;
            std::thread::sleep(std::time::Duration::from_millis(400));
            conn.execute_batch("ROLLBACK").map_err(db_failed)
        })
        .expect("hold resident lock");
    });
    std::thread::sleep(std::time::Duration::from_millis(80));

    let started = std::time::Instant::now();
    let n: i64 = handle
        .read(|conn| conn.query_row("SELECT COUNT(*) FROM t", [], |r| r.get(0)).map_err(db_failed))
        .expect("pooled read");
    let elapsed = started.elapsed();

    holder.join().expect("holder thread");
    cleanup(&db);

    assert_eq!(n, 1);
    assert!(
        elapsed < std::time::Duration::from_millis(300),
        "池化读等了 {elapsed:?}：读路径又回到常驻锁上了"
    );
}

/// 并发读的硬上限：池满时后来者**排队**，不会悄悄再开连接。
#[test]
fn read_pool_caps_concurrent_readers() {
    let db = temp_db("read-pool-cap");
    let handle = std::sync::Arc::new(SqliteHandle::new(db.clone(), create_table_t));
    handle
        .with_conn(|conn| conn.execute("INSERT INTO t (a) VALUES (1)", []).map_err(db_failed))
        .expect("seed");

    let live = std::sync::Arc::new(AtomicUsize::new(0));
    let peak = std::sync::Arc::new(AtomicUsize::new(0));
    let mut threads: Vec<std::thread::JoinHandle<i64>> = Vec::new();
    for _ in 0..(READ_POOL_CAP * 2) {
        let handle = handle.clone();
        let live = live.clone();
        let peak = peak.clone();
        threads.push(std::thread::spawn(move || {
            handle
                .read(|conn| {
                    let now = live.fetch_add(1, Ordering::SeqCst) + 1;
                    peak.fetch_max(now, Ordering::SeqCst);
                    std::thread::sleep(std::time::Duration::from_millis(120));
                    live.fetch_sub(1, Ordering::SeqCst);
                    conn.query_row("SELECT COUNT(*) FROM t", [], |r| r.get(0))
                        .map_err(db_failed)
                })
                .expect("pooled read")
        }));
    }
    for t in threads {
        assert_eq!(t.join().expect("thread"), 1);
    }
    let pooled = handle.lock_read_pool().open;
    cleanup(&db);

    assert!(
        peak.load(Ordering::SeqCst) <= READ_POOL_CAP,
        "并发读峰值 {} 超过池上限 {READ_POOL_CAP}",
        peak.load(Ordering::SeqCst)
    );
    assert!(
        pooled <= READ_POOL_CAP,
        "池里开出了 {pooled} 条连接，超过上限 {READ_POOL_CAP}"
    );
}

/// 出错的读连接不放回池子（否则一次磁盘级故障会跟着池子反复复发）。
#[test]
fn read_discards_connection_after_error() {
    let db = temp_db("read-pool-discard");
    let handle = SqliteHandle::new(db.clone(), create_table_t);
    handle
        .read(|conn| {
            conn.query_row("SELECT * FROM no_such_table", [], |r| r.get::<_, i64>(0))
                .map_err(db_failed)
        })
        .expect_err("坏 SQL 应报错");
    assert_eq!(handle.lock_read_pool().open, 0, "坏连接不应留在池里");

    // 池子仍可正常服务下一条读
    let n: i64 = handle
        .read(|conn| conn.query_row("SELECT COUNT(*) FROM t", [], |r| r.get(0)).map_err(db_failed))
        .expect("read after discard");
    assert_eq!(n, 0);
    cleanup(&db);
}

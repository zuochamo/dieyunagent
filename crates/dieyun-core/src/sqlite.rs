//! SQLite 连接的唯一入口。
//!
//! 原先 `memory` / `index` / `graph` 各自手写了「create_dir_all + Connection::open +
//! busy_timeout + journal_mode=WAL」这套几乎相同的前缀，而且三份都缺同样的关键 PRAGMA：
//! 没有 `synchronous`，于是每次 commit 都强制 fsync；没有 `wal_autocheckpoint`，
//! 于是 checkpoint 只发生在连接关闭时——而这些连接是每次调用现场开、用完就关的，
//! 等于每个工具轮次都要做一次 checkpoint 并删掉 WAL 文件。
//!
//! 调优选项只能有一份实现：分散在多处必然再次漂移。
//!
//! 同理，「谁在什么时候开连接、活多久、在哪建表」也只能有一份实现，见 [`SqliteHandle`]。
//! 只统一 PRAGMA 是不够的：调用方照样每次查询现场 `open_tuned` + 建表检查 + 用完 drop。

use rusqlite::Connection;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use crate::error::CoreError;

/// WAL 自动 checkpoint 阈值（页，1 页 = 4KB）。
/// SQLite 默认 1000，但默认值在这里靠不住：连接短命，不显式钉住就会在
/// 两次 checkpoint 之间让 WAL 持续膨胀。
const WAL_AUTOCHECKPOINT_PAGES: i64 = 512;

/// 单连接页缓存（负值表示 KiB）。给 8MB：既不失控，也不至于每次查询都回读磁盘。
const CACHE_SIZE_KIB: i64 = -8192;

const BUSY_TIMEOUT_SECS: u64 = 15;

/// 打开并统一调优。
pub fn open_tuned(db_path: &Path) -> Result<Connection, CoreError> {
    if let Some(parent) = db_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| CoreError::rpc("DB_OPEN_FAILED", e.to_string()))?;
    }
    let conn =
        Connection::open(db_path).map_err(|e| CoreError::rpc("DB_OPEN_FAILED", e.to_string()))?;
    tune(&conn)?;
    Ok(conn)
}

/// 对已有连接施加统一调优（内存库场景也可复用）。
///
/// 注意这里**不**开启 `foreign_keys`：memory 库原本就开着，而 index / graph 原本没开。
/// 顺手统一打开会让原本静默通过的 INSERT 开始报错，属于无收益的行为变更。
/// 需要外键约束的调用方自行显式打开。
pub fn tune(conn: &Connection) -> Result<(), CoreError> {
    let map = |e: rusqlite::Error| CoreError::rpc("DB_OPEN_FAILED", e.to_string());
    conn.busy_timeout(Duration::from_secs(BUSY_TIMEOUT_SECS))
        .map_err(map)?;
    // 空闲页增量回收：与 FULL 不同，它不搬家已有页，只在删除后归还尾部空闲页。
    //
    // 必须赶在任何写操作之前设置 —— 一旦库写过页（包括下面切 WAL），
    // SQLite 就认为它不是空库，设置会被静默忽略。已有内容的库仍需一次 VACUUM
    // 才能完成转换，memory 的周期修剪会在空闲页占比高时顺手做掉。
    // 设置失败不算致命：老库按原样继续用，不能因为回收设置打不开。
    let _ = conn.pragma_update(None, "auto_vacuum", "INCREMENTAL");
    conn.pragma_update(None, "journal_mode", "WAL")
        .map_err(map)?;
    // WAL + NORMAL 是官方推荐组合：崩溃不会损坏库，最多丢最后几个已提交事务，
    // 换来的是 commit 不再强制 fsync。对索引 / 图 / 记忆这类可重建数据完全够用。
    conn.pragma_update(None, "synchronous", "NORMAL")
        .map_err(map)?;
    conn.pragma_update(None, "wal_autocheckpoint", WAL_AUTOCHECKPOINT_PAGES)
        .map_err(map)?;
    conn.pragma_update(None, "cache_size", CACHE_SIZE_KIB)
        .map_err(map)?;
    Ok(())
}

/// 建表 / 升级钩子：每个库文件只在**首次用到**时跑一次。
pub type SchemaInit = fn(&Connection) -> Result<(), CoreError>;

/// 一个库文件 → 一条常驻连接。
///
/// 连接生命周期归口到这里，调用方不再「每次查询现场开、用完就关」。
/// 常驻连接消掉三笔重复成本：每个轮次的 WAL checkpoint、每次重读的页缓存，
/// 以及每次调用都要重跑一遍的建表检查（外置盘上很慢）。
///
/// 惰性初始化是刻意的：`new` 不做磁盘 IO，于是它能保持不可失败，
/// 调用方（配置热更新路径）不会因为库一时打不开而被打死；
/// 失败照旧在「首次真正用到」时以 RPC 错误暴露，时序与改造前一致。
pub struct SqliteHandle {
    path: PathBuf,
    conn: Mutex<Option<Connection>>,
    init: SchemaInit,
}

impl SqliteHandle {
    pub fn new(path: PathBuf, init: SchemaInit) -> Self {
        Self {
            path,
            conn: Mutex::new(None),
            init,
        }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// 在常驻连接上执行一段逻辑；首次调用时开连接并按 `init` 建表。
    ///
    /// 锁**非重入**：`f` 内部不得再调 `with_conn`，否则自锁。需要复用连接的内部方法
    /// 请显式接收 `&Connection`（`*_with_conn` 命名）。这也约束了 `f` 应当是短操作——
    /// 长任务用 [`open_dedicated`](Self::open_dedicated)。
    pub fn with_conn<T>(
        &self,
        f: impl FnOnce(&Connection) -> Result<T, CoreError>,
    ) -> Result<T, CoreError> {
        // 中毒不致命：panic 穿过 `Transaction` 时 drop 已经回滚，连接本身仍然可用。
        // 反过来，让一次 panic 永久毒化这个库、此后所有 RPC 一律报错，代价更大。
        let mut guard = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        if guard.is_none() {
            let conn = open_tuned(&self.path)?;
            (self.init)(&conn)?;
            // 建表成功才落地：半初始化的连接一旦被缓存，这个进程就永远少一张表。
            *guard = Some(conn);
        }
        f(guard.as_ref().expect("connection initialized above"))
    }

    /// 开一条**独立**连接，不占用常驻锁（建表仍由常驻连接一次性完成）。
    ///
    /// 两类调用方必须用它：
    /// 1. 长任务（结构索引 / 向量构建）——占着常驻锁几分钟会把所有读请求堵死；
    /// 2. 跨 `.await` 的逻辑——`MutexGuard` 不是 `Send`，本来就拿不过 await。
    pub fn open_dedicated(&self) -> Result<Connection, CoreError> {
        self.with_conn(|_| Ok(()))?;
        open_tuned(&self.path)
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};

    use super::*;

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
    fn handle_dedicated_connection_reuses_schema_but_not_lock() {
        DEDICATED_INITS.store(0, Ordering::SeqCst);
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
}

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
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Condvar, Mutex};
use std::time::Duration;

use crate::error::CoreError;

/// WAL 自动 checkpoint 阈值（页，1 页 = 4KB）。
/// SQLite 默认 1000，但默认值在这里靠不住：连接短命，不显式钉住就会在
/// 两次 checkpoint 之间让 WAL 持续膨胀。
const WAL_AUTOCHECKPOINT_PAGES: i64 = 512;

/// 单连接页缓存（负值表示 KiB）。给 8MB：既不失控，也不至于每次查询都回读磁盘。
const CACHE_SIZE_KIB: i64 = -8192;

const BUSY_TIMEOUT_SECS: u64 = 15;

/// 读侧连接池容量（并发读的硬上限）。
///
/// 池子存在的理由：读侧每一次都现开连接，等于每次都要重热页缓存、重跑一遍
/// `tune` 的 PRAGMA（其中 `journal_mode` 还要探一次写锁）；而并发上限的意义在于
/// 「同一块磁盘上别让 N 个全表扫描互抢 IO」—— 真正的并行度由 CPU 与阻塞线程池
/// 决定，池子开大只会放大抖动。超限的读在这里排队，**不会**无脑再开连接。
pub const READ_POOL_CAP: usize = 4;

/// 打开并统一调优。
pub fn open_tuned(db_path: &Path) -> Result<Connection, CoreError> {
    open_tuned_with(db_path, TuneOptions::default())
}

/// 每个库文件**自己**决定的调优开关（不是全局配置）。
///
/// 目前只有一个：`foreign_keys`。memory 库依赖 `ON DELETE CASCADE` 清子表
/// （traces / plans / steps / vectors），而 index / graph 原本没开、历史数据里还有孤儿行，
/// 统一打开会让原本静默通过的 INSERT 开始报错 —— 所以它按库声明，并且
/// **写入连接与池化读连接必须用同一份**，否则同一条语句在不同连接上语义不同。
#[derive(Clone, Copy, Debug, Default)]
pub struct TuneOptions {
    pub foreign_keys: bool,
}

/// 打开并统一调优（按库的 `opts`）。
pub fn open_tuned_with(db_path: &Path, opts: TuneOptions) -> Result<Connection, CoreError> {
    if let Some(parent) = db_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| CoreError::rpc("DB_OPEN_FAILED", e.to_string()))?;
    }
    let conn =
        Connection::open(db_path).map_err(|e| CoreError::rpc("DB_OPEN_FAILED", e.to_string()))?;
    tune_with(&conn, opts)?;
    Ok(conn)
}

/// 对已有连接施加统一调优（内存库场景也可复用）。
///
/// 注意这里**默认不开** `foreign_keys`：memory 库原本就开着，而 index / graph 原本没开。
/// 顺手统一打开会让原本静默通过的 INSERT 开始报错，属于无收益的行为变更。
/// 需要外键约束的库用 [`TuneOptions::foreign_keys`] 显式声明。
pub fn tune(conn: &Connection) -> Result<(), CoreError> {
    tune_with(conn, TuneOptions::default())
}

fn tune_with(conn: &Connection, opts: TuneOptions) -> Result<(), CoreError> {
    let map = |e: rusqlite::Error| CoreError::rpc("DB_OPEN_FAILED", e.to_string());
    if opts.foreign_keys {
        conn.pragma_update(None, "foreign_keys", "ON")
            .map_err(map)?;
    }
    conn.busy_timeout(Duration::from_secs(BUSY_TIMEOUT_SECS))
        .map_err(map)?;
    // 空闲页增量回收：与 FULL 不同，它不搬家已有页，只在删除后归还尾部空闲页。
    //
    // 必须赶在任何写操作之前设置 —— 一旦库写过页（包括下面切 WAL），
    // SQLite 就认为它不是空库，设置会被静默忽略。已有内容的库仍需一次 VACUUM
    // 才能完成转换，memory 的周期修剪会在空闲页占比高时顺手做掉。
    //
    // 两个约束决定了这条 pragma 只能在「还没设成 INCREMENTAL」时、且**不带超时**地试一次：
    // 1. 即便目标值与当前值相同，它也要拿写锁 —— 每次开连接都白等一次（实测并发写入时
    //    会阻塞到 busy_timeout 满，长任务开着写事务时等于每条新连接卡 15s）；
    // 2. 它本来就是 best-effort（失败不算致命），所以抢不到就放弃，下次开连接再试。
    let auto_vacuum: i64 = conn
        .query_row("PRAGMA auto_vacuum", [], |r| r.get(0))
        .unwrap_or(0);
    if auto_vacuum != 2 {
        let _ = conn.busy_timeout(Duration::ZERO);
        let _ = conn.pragma_update(None, "auto_vacuum", "INCREMENTAL");
        conn.busy_timeout(Duration::from_secs(BUSY_TIMEOUT_SECS))
            .map_err(map)?;
    }
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

/// 读侧连接池的池内状态（受 [`SqliteHandle::readers`] 保护）。
struct ReadPool {
    idle: Vec<Connection>,
    /// 已开出的连接数（idle + 借用中）。等于池上限时，新读者排队。
    open: usize,
}

/// 池化读连接：`Deref` 到 `Connection`，Drop 时自动归还。
///
/// 用 `Deref` 而不是把连接 move 给调用方，是为了让「借出」与「归还」永远成对：
/// 调用方拿不到独占所有权，也就无法忘记归还或把它存进生命周期更长的结构里。
pub struct ReadConn<'a> {
    handle: &'a SqliteHandle,
    conn: Option<Connection>,
}

impl ReadConn<'_> {
    pub fn conn(&self) -> &Connection {
        self.conn.as_ref().expect("read connection already released")
    }

    /// 丢弃这条连接：查询暴露出连接级故障时不再放回池子，避免坏连接被反复复用。
    fn discard(&mut self) {
        self.conn = None;
    }
}

impl std::ops::Deref for ReadConn<'_> {
    type Target = Connection;

    fn deref(&self) -> &Connection {
        self.conn()
    }
}

impl Drop for ReadConn<'_> {
    fn drop(&mut self) {
        self.handle.release_reader(self.conn.take());
    }
}

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
    readers: Mutex<ReadPool>,
    readers_free: Condvar,
    /// 建表是否已由常驻连接完成。
    ///
    /// 有这个原子位，读侧才能**完全绕开常驻锁**：否则每次读都要先
    /// `with_conn` 探一下「初始化没有」，碰上长任务正持锁时白等 15s。
    initialized: AtomicBool,
    /// 该库文件的调优开关：写入连接与池化读连接共用同一份（见 [`TuneOptions`]）。
    opts: TuneOptions,
    init: SchemaInit,
}

impl SqliteHandle {
    pub fn new(path: PathBuf, init: SchemaInit) -> Self {
        Self::new_with_opts(path, init, TuneOptions::default())
    }

    /// 需要外键约束的库（memory）用这个：`ON DELETE CASCADE` 是它的清子表机制。
    pub fn new_with_foreign_keys(path: PathBuf, init: SchemaInit) -> Self {
        Self::new_with_opts(
            path,
            init,
            TuneOptions {
                foreign_keys: true,
            },
        )
    }

    fn new_with_opts(path: PathBuf, init: SchemaInit, opts: TuneOptions) -> Self {
        Self {
            path,
            conn: Mutex::new(None),
            readers: Mutex::new(ReadPool {
                idle: Vec::new(),
                open: 0,
            }),
            readers_free: Condvar::new(),
            initialized: AtomicBool::new(false),
            opts,
            init,
        }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// 在常驻连接上执行一段**秒回级**逻辑；首次调用时开连接并按 `init` 建表。
    ///
    /// 常驻连接是该库文件的**那一条**共享连接（每个库文件一条），所有调用方共用一把
    /// 非重入锁，因此：
    /// - `f` 只能是短操作（status 类纯读、小写入，毫秒级）。
    /// - **数据查询不算短操作**：仓库地图 / 符号检索 / 代码检索这类可能扫全表的读，
    ///   以及任何分钟级任务，一律走 [`open_dedicated`](Self::open_dedicated)。否则一条慢
    ///   读就能把所有 status 请求堵到客户端超时（详见
    ///   `docs/SQLITE-ACCESS.md`）。
    /// - `f` 内不得再调 `with_conn`，否则自锁。需要复用连接的内部方法显式接收
    ///   `&Connection`（`*_with_conn` 命名）。
    pub fn with_conn<T>(
        &self,
        f: impl FnOnce(&Connection) -> Result<T, CoreError>,
    ) -> Result<T, CoreError> {
        // 中毒不致命：panic 穿过 `Transaction` 时 drop 已经回滚，连接本身仍然可用。
        // 反过来，让一次 panic 永久毒化这个库、此后所有 RPC 一律报错，代价更大。
        let mut guard = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        let conn = self.prepare_locked(&mut guard)?;
        f(conn)
    }

    /// 拿不到写连接就**放弃**的写入版本（返回 `Ok(None)`）。
    ///
    /// 只给「读路径顺手做的非必要写」用，典型是召回时的 `access_count` 自增：那是
    /// 排序与修剪的提示信号，丢一次无害；而召回是每轮系统提示都要等的读，为了一个
    /// 计数器去排在「聊天落库」后面，就会把整轮拖慢（实测：写入压满时 p95 从 12ms
    /// 变成 219ms，差额全在这把锁上）。正经写入一律用 [`with_conn`](Self::with_conn)，
    /// 那里该等就得等。
    pub fn try_with_conn<T>(
        &self,
        f: impl FnOnce(&Connection) -> Result<T, CoreError>,
    ) -> Result<Option<T>, CoreError> {
        // 抢不到锁 → None（调用方跳过这笔写）。锁被毒化时按「数据仍然可用」继续，
        // 与 with_conn 同规则：一次 panic 不该让 usage 计数这类反馈永久停在旧值上。
        let mut guard = match self.conn.try_lock() {
            Ok(g) => g,
            Err(std::sync::TryLockError::WouldBlock) => return Ok(None),
            Err(std::sync::TryLockError::Poisoned(e)) => e.into_inner(),
        };
        let conn = self.prepare_locked(&mut guard)?;
        Ok(Some(f(conn)?))
    }

    /// [`with_conn`](Self::with_conn) 与 [`try_with_conn`](Self::try_with_conn)
    /// 共用的不变量：连接就绪 → 标记已初始化 → 必须在 autocommit。
    ///
    /// 分成helper而不是各抄一遍：这两条不变量都是「抄漏了会静默毁数据」的类型
    /// （半初始化连接缓存、带未提交事务的常驻连接）。
    fn prepare_locked<'a>(
        &self,
        guard: &'a mut Option<Connection>,
    ) -> Result<&'a Connection, CoreError> {
        if guard.is_none() {
            let conn = open_tuned_with(&self.path, self.opts)?;
            (self.init)(&conn)?;
            // 建表成功才落地：半初始化的连接一旦被缓存，这个进程就永远少一张表。
            *guard = Some(conn);
        }
        // 建表已完成 —— 读侧从此不必再碰这把锁（`initialized` 见字段注释）。
        self.initialized.store(true, Ordering::Release);
        let conn = guard.as_ref().expect("connection initialized above");
        // 不变量：常驻写连接必须处于 autocommit。
        //
        // 带着未提交事务进来，只可能是前面某条语句在事务里报错后没人回滚 —— SQLite 不会
        // 替你回滚语句级错误，`execute_batch("BEGIN…; 失败; ROLLBACK")` 这类写法会把 ROLLBACK
        // 自己跳过（真实事故：memory 的 FTS 探针，见 `memory/schema.rs`）。后果不是「慢一点」，
        // 而是此后每条写入都进那个永不提交的事务，进程一退全部丢失，且全程没有任何报错。
        // 这里报告并回滚：宁可丢掉那笔来路不明的未提交写入，也不能让它吞掉整个进程的数据。
        if !conn.is_autocommit() {
            eprintln!(
                "[dieyun:db] 常驻写连接带着未提交事务进入 with_conn（{}），已回滚",
                self.path.display()
            );
            let _ = conn.execute_batch("ROLLBACK");
        }
        Ok(conn)
    }

    /// 读侧取数：从**池子**里借一条连接，用完归还。
    ///
    /// 与 [`with_conn`](Self::with_conn) 的分工：`with_conn` 是那条**唯一的**写入
    /// 连接（串行、短事务）；这里给只读查询用，不与常驻锁互斥，于是仓库地图 /
    /// 符号检索 / 代码检索这类扫描型读永远堵不住 `*.status`。
    /// 与 [`open_dedicated`](Self::open_dedicated) 的分工：那边是长任务（分钟级），
    /// 占着连接直到任务结束；这里的借用应该只有一次查询的时间，并且**受池上限约束**。
    pub fn read<T>(
        &self,
        f: impl FnOnce(&Connection) -> Result<T, CoreError>,
    ) -> Result<T, CoreError> {
        let mut conn = self.read_conn()?;
        let out = f(&conn);
        if out.is_err() {
            conn.discard();
        }
        out
    }

    /// 借一条池化读连接（需要跨多步语句时用）。
    ///
    /// 池空且未达上限就新开一条；已达上限则在 Condvar 上排队 —— 排队而不是
    /// 「再开一条」，否则并发子 Agent 数就是连接数。
    pub fn read_conn(&self) -> Result<ReadConn<'_>, CoreError> {
        self.ensure_initialized()?;
        let mut pool = self.lock_read_pool();
        loop {
            if let Some(conn) = pool.idle.pop() {
                return Ok(ReadConn {
                    handle: self,
                    conn: Some(conn),
                });
            }
            if pool.open < READ_POOL_CAP {
                // 先在锁内占住名额再放锁去开连接，避免并发下超发。
                pool.open += 1;
                drop(pool);
                return match open_tuned_with(&self.path, self.opts) {
                    Ok(conn) => Ok(ReadConn {
                        handle: self,
                        conn: Some(conn),
                    }),
                    Err(e) => {
                        self.release_reader(None);
                        Err(e)
                    }
                };
            }
            pool = self
                .readers_free
                .wait(pool)
                .unwrap_or_else(|e| e.into_inner());
        }
    }

    /// 建表只在常驻连接上做一次；`initialized` 已置位时**不碰常驻锁**。
    fn ensure_initialized(&self) -> Result<(), CoreError> {
        if self.initialized.load(Ordering::Acquire) {
            return Ok(());
        }
        self.with_conn(|_| Ok(()))?;
        Ok(())
    }

    fn lock_read_pool(&self) -> std::sync::MutexGuard<'_, ReadPool> {
        self.readers.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// 归还连接：`None` 表示这条连接已被丢弃（占位名额要还回去）。
    fn release_reader(&self, conn: Option<Connection>) {
        let mut pool = self.lock_read_pool();
        match conn {
            Some(conn) => pool.idle.push(conn),
            None => pool.open = pool.open.saturating_sub(1),
        }
        drop(pool);
        self.readers_free.notify_one();
    }

    /// 开一条**独立**连接，不占用常驻锁（建表仍由常驻连接一次性完成）。
    ///
    /// 三类调用方必须用它：
    /// 1. 长任务（结构索引 / 向量构建）——占着常驻锁几分钟会把所有读请求堵死；
    /// 2. 读侧数据查询（仓库地图 / 符号检索 / 代码检索）——可能全表扫描，同样会堵；
    /// 3. 跨 `.await` 的逻辑——`MutexGuard` 不是 `Send`，本来就拿不过 await。
    pub fn open_dedicated(&self) -> Result<Connection, CoreError> {
        self.with_conn(|_| Ok(()))?;
        open_tuned_with(&self.path, self.opts)
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
}

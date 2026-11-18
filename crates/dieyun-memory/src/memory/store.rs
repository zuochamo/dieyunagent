// 依赖与 mod.rs 同源：域文件里直接用，不再各自拼一套 use。
use super::*;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use rusqlite::Connection;
use serde_json::{json, Value};

use dieyun_base::config::AppConfig;
use dieyun_base::embedding::EmbeddingConfig;
use dieyun_base::error::CoreError;
use dieyun_base::sqlite::SqliteHandle;

// 连接与生命周期（开库 / 连接池 / 读连接 / embedding 配置 / 剪枝策略）。
// 这里没有业务 SQL：谁能读写哪张表由 `session` / `longmem` / `recall` / `archive` 说了算。

/// agent 历史（`agent_runs` / `agent_traces`）的修剪策略。
///
/// 集中成一处，既避免阈值散进 SQL，也让测试能用不同窗口驱动真实逻辑。
pub(crate) struct PrunePolicy {
    /// `agent_traces` 总行数超过它才开始裁剪（小库不值得全表扫）。
    pub(crate) traces_trigger: i64,
    /// 单条 run 保留的 trace 行数。
    pub(crate) traces_per_run: i64,
    /// 已完成 run 保留的条数（按 updated_at 倒序）。
    pub(crate) runs_keep_recent: i64,
    /// 已完成 run 的最长保留时长（毫秒）。
    pub(crate) run_max_age_ms: i64,
    /// 空闲页占全库页数达到这个百分比才回收磁盘。
    pub(crate) freelist_percent: i64,
}

impl Default for PrunePolicy {
    fn default() -> Self {
        Self {
            traces_trigger: 4_000,
            // 唯一读者 `agent.trace_get` 只取 `ORDER BY id DESC LIMIT 1`，
            // 更早的 checkpoint 行没有任何用途，纯写放大残留。
            traces_per_run: 4,
            runs_keep_recent: 500,
            run_max_age_ms: 30 * 24 * 60 * 60 * 1000,
            freelist_percent: 25,
        }
    }
}

impl MemoryStore {
    pub fn open(db_path: PathBuf, embedding: EmbeddingConfig) -> Result<Self, CoreError> {
        // 调优 / 建表 / 外键全部归口 `SqliteHandle`：memory 库需要 `foreign_keys = ON`
        // （`ON DELETE CASCADE` 是它清子表的方式），index / graph 则刻意不开，
        // 所以这是**按库声明**的开关，写入连接与池化读连接共用同一份。
        //
        // 惰性初始化：库一时打不开不会打死配置热更新路径，首次真正用到时以 RPC 错误暴露。
        let db = std::sync::Arc::new(SqliteHandle::new_with_foreign_keys(
            db_path.clone(),
            schema::init_schema,
        ));
        let store = Self {
            db_path: db_path.clone(),
            embedding: std::sync::Arc::new(Mutex::new(embedding)),
            db,
        };
        // 后台周期修剪，勿阻塞 serve-stdio 启动（4GB 库同步 DELETE / VACUUM 可卡数十秒）
        //
        // 测试进程里不起这条线程：它会立刻跑一次账本自愈，与「显式调用 reconcile」的测试
        // 抢同一批行（自愈是幂等的，但断言计数就不可重复了）。自愈逻辑由测试直接调用覆盖。
        if !cfg!(test) {
            Self::spawn_prune_loop(db_path, store.clone());
        }
        Ok(store)
    }

    pub fn from_config(config: &AppConfig) -> Result<Self, CoreError> {
        Self::open(config.memory_db_path(), config.embedding.clone())
    }

    pub fn db_path(&self) -> &Path {
        &self.db_path
    }

    pub fn ping(&self) -> Value {
        let embedding = self.embedding();
        json!({
            "ok": true,
            "engine": "rust",
            "dbPath": self.db_path.to_string_lossy(),
            "embeddingEnabled": embedding.enabled(),
        })
    }

    /// Update embedding settings without reopening the (possibly huge) SQLite file.
    ///
    /// 锁毒化时照样写进去：把「锁被毒化」表达成「用户没配向量」会让语义召回与向量通道
    /// **静默消失**（provider 变成 auto / base_url 空），比锁本身难查得多。
    pub fn set_embedding(&self, embedding: EmbeddingConfig) {
        match self.embedding.lock() {
            Ok(mut g) => *g = embedding,
            Err(poisoned) => *poisoned.into_inner() = embedding,
        }
    }

    pub(crate) fn embedding(&self) -> EmbeddingConfig {
        match self.embedding.lock() {
            Ok(g) => g.clone(),
            Err(poisoned) => poisoned.into_inner().clone(),
        }
    }

    /// 写入连接（**唯一**一条，串行短事务）。见 `docs/SQLITE-ACCESS.md`。
    pub(crate) fn with_conn<T, F>(&self, f: F) -> Result<T, CoreError>
    where
        F: FnOnce(&Connection) -> Result<T, CoreError>,
    {
        self.db.with_conn(f)
    }

    /// 只读查询：池化连接、不占写入连接（聊天落库很频繁，读路径不该排队等它）。
    pub(crate) fn read<T, F>(&self, f: F) -> Result<T, CoreError>
    where
        F: FnOnce(&Connection) -> Result<T, CoreError>,
    {
        self.db.read(f)
    }

    /// 只给测试用（cfg(test) 之前漏了，于是 lib 构建每次都报 never used）。
    #[cfg(test)]
    pub(crate) fn test_conn(&self) -> dieyun_base::sqlite::ReadConn<'_> {
        self.db.read_conn().expect("open test connection")
    }
}

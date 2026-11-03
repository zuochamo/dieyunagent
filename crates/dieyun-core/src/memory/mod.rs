mod agent;
mod misc;
mod projects;
mod schema;
mod snapshot;

pub use snapshot::RequestSnapshotInput;

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::config::AppConfig;
use crate::embedding::{self, EmbeddingConfig};
use crate::error::CoreError;
use crate::sqlite::SqliteHandle;

const MEMORY_EMBED_TEXT_MAX: usize = 6000;
const GLOBAL_MEMORY_SCOPE: &str = "global";

/// 后台修剪周期。原实现只在 `MemoryStore::open()` 跑一次 —— 长驻进程的
/// `agent_runs` / `agent_traces` 等于没有上限，可以涨到任意大小。
const PRUNE_INTERVAL: Duration = Duration::from_secs(30 * 60);
/// 启动后先等一会儿再修剪，避开 serve-stdio 启动与首批 RPC 的锁竞争。
const PRUNE_STARTUP_DELAY: Duration = Duration::from_secs(60);

/// agent 历史（`agent_runs` / `agent_traces`）的修剪策略。
///
/// 集中成一处，既避免阈值散进 SQL，也让测试能用不同窗口驱动真实逻辑。
struct PrunePolicy {
    /// `agent_traces` 总行数超过它才开始裁剪（小库不值得全表扫）。
    traces_trigger: i64,
    /// 单条 run 保留的 trace 行数。
    traces_per_run: i64,
    /// 已完成 run 保留的条数（按 updated_at 倒序）。
    runs_keep_recent: i64,
    /// 已完成 run 的最长保留时长（毫秒）。
    run_max_age_ms: i64,
    /// 空闲页占全库页数达到这个百分比才回收磁盘。
    freelist_percent: i64,
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

fn is_global_memory_scope(scope: &str) -> bool {
    scope.trim().eq_ignore_ascii_case(GLOBAL_MEMORY_SCOPE)
}

/// SQL filter for long_memories.scope — `global` must not match project:* rows.
fn long_memory_scope_filter(scope_col: &str, scope: &str, bind_index: i32) -> String {
    if is_global_memory_scope(scope) {
        format!(
            "(COALESCE(NULLIF({scope_col}, ''), '{GLOBAL_MEMORY_SCOPE}') = '{GLOBAL_MEMORY_SCOPE}')"
        )
    } else {
        format!("{scope_col} = ?{bind_index}")
    }
}

type LongMemKeywordRow = (
    i64,
    String,
    Option<String>,
    Option<String>,
    Option<String>,
    i64,
    String,
    i64,
);

fn map_long_mem_keyword_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<LongMemKeywordRow> {
    Ok((
        row.get(0)?,
        row.get(1)?,
        row.get(2)?,
        row.get(3)?,
        row.get(4)?,
        row.get(5)?,
        row.get(6)?,
        row.get(7)?,
    ))
}

type LongMemSemanticRow = (
    i64,
    String,
    Option<String>,
    i64,
    Option<String>,
    Option<String>,
    i64,
    String,
    Vec<u8>,
    i64,
);

fn map_long_mem_semantic_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<LongMemSemanticRow> {
    Ok((
        row.get(0)?,
        row.get(1)?,
        row.get(2)?,
        row.get(3)?,
        row.get(4)?,
        row.get(5)?,
        row.get(6)?,
        row.get(7)?,
        row.get(8)?,
        row.get(9)?,
    ))
}

/// 近重复判定的余弦阈值：同一 scope 内相似度 ≥ 该值的写入视为「同一件事的另一种说法」。
/// 取 0.92 而不是 0.8：记忆粒度本来就抽象，0.8 会把「偏好中文」和「偏好简短」并成一条。
const NEAR_DUP_COSINE: f64 = 0.92;

/// 自动归纳（source 含 consolidation）条目的 importance 下限，低于此值不落库。
/// 依据是库里的真实分布：importance ≤ 2 的条目既进不了每轮 8+5 的注入预算，
/// 又会在语义召回里占位 —— 那就别写进来。
const CONSOLIDATION_MIN_IMPORTANCE: i64 = 3;

/// 悬空归纳作业的判定阈值：`pending` 且开始时间早于 now - 该值 → 判 failed。
/// 真实归纳是秒到分钟级，超过 30 分钟还 pending 只可能是进程已经退出。
const STALE_CONSOLIDATION_JOB_MS: i64 = 30 * 60 * 1000;

#[derive(Clone)]
pub struct MemoryStore {
    db_path: PathBuf,
    embedding: std::sync::Arc<Mutex<EmbeddingConfig>>,
    /// 库生命周期归口到 `SqliteHandle`（写入连接 + 池化读连接 + 长任务连接），
    /// 记忆侧不再自己持有裸 `Connection` 和一把私锁。
    db: std::sync::Arc<SqliteHandle>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionRow {
    pub id: String,
    pub updated_at: i64,
    pub title: Option<String>,
    /// 标题来源（`heuristic` / `ai` / `user`）。AI 标题的「只生成一次」判据在这里，
    /// 见 [`MemoryStore::set_session_title`]。
    pub title_source: Option<String>,
    pub preview: Option<String>,
    pub archived: bool,
    pub workspace_path: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageRow {
    pub id: i64,
    pub session_id: String,
    pub role: String,
    pub content: String,
    /// 该轮真思考（与 `content` 分列）。历史重建默认不读它。
    pub reasoning: Option<String>,
    pub created_at: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppendMessageResult {
    pub local_msg_id: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompactionArchiveInput {
    pub session_id: Option<String>,
    pub workspace_path: Option<String>,
    pub tokens_before: Option<i64>,
    pub tokens_after: Option<i64>,
    pub summary: Option<Value>,
    pub folded_transcript: Option<String>,
    pub folded_text: Option<String>,
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

    /// 周期修剪线程：同一 `db_path` 只起一条，随进程退出而结束。
    fn spawn_prune_loop(db_path: PathBuf, store: Self) {
        static STARTED: OnceLock<Mutex<HashSet<PathBuf>>> = OnceLock::new();
        let started = STARTED.get_or_init(|| Mutex::new(HashSet::new()));
        match started.lock() {
            Ok(mut guard) => {
                if !guard.insert(db_path.clone()) {
                    return;
                }
            }
            Err(_) => return,
        }
        let _ = std::thread::Builder::new()
            .name("dieyun-memory-prune".into())
            .spawn(move || {
                // 启动自愈：孤儿项目 scope / 悬空归纳作业。放在这条后台线程里是因为
                // 主 open() 走惰性初始化（库打不开不该打死启动），而自愈只是一次幂等 UPDATE。
                // 失败要留一句日志：库损坏时自愈会静默不生效，而「数据一直脏」是最难查的那种故障。
                if let Err(e) = store.reconcile_memory_ledger(now_ms()) {
                    eprintln!("[dieyun:memory] 账本自愈失败（下次启动重试）: {e}");
                }
                std::thread::sleep(PRUNE_STARTUP_DELAY);
                loop {
                    // 每轮独立开关连接：不长期持有库文件（Windows 下会挡住备份 / 删除），
                    // 且主连接常驻，关闭这条连接不会触发 WAL checkpoint 抖动。
                    if let Ok(conn) = crate::sqlite::open_tuned(&db_path) {
                        // open_tuned 有意不开 foreign_keys，而这里依赖 CASCADE 清子表，
                        // 必须显式打开，否则删 run 会留下孤儿 traces / plans / steps。
                        if conn.pragma_update(None, "foreign_keys", "ON").is_ok() {
                            let _ = Self::prune_agent_history(&conn, &PrunePolicy::default());
                        }
                        // 顺手洗掉历史脏数据（meta 里的 base64）。洗完这个扫描恒为 0 行。
                        let _ = Self::purge_oversized_message_meta(&conn);
                    }
                    std::thread::sleep(PRUNE_INTERVAL);
                }
            });
    }

    /// 一次性洗掉历史消息 meta 里的字节（早期版本把暂存附件的 base64 落库了）。
    ///
    /// 只碰「长度明显超过任何正常消息」的行：正常库里这个查询恒为 0 行，可以跟着
    /// 修剪线程每轮便宜地跑；没有 meta 前缀的超长正文（如长回答）原样保留。
    fn purge_oversized_message_meta(conn: &Connection) -> Result<usize, CoreError> {
        let mut stmt = conn.prepare("SELECT id, content FROM messages WHERE length(content) > ?1")?;
        let rows = stmt
            .query_map(params![MESSAGE_META_STRING_MAX as i64], |row| {
                Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        let mut fixed = 0usize;
        for (id, content) in rows {
            let Some(cleaned) = sanitize_persisted_message(&content) else {
                continue;
            };
            conn.execute(
                "UPDATE messages SET content = ?1 WHERE id = ?2",
                params![cleaned, id],
            )?;
            fixed += 1;
        }
        Ok(fixed)
    }

    /// 以 `agent_runs` 为根修剪历史：`agent_traces` / `agent_plans` / `agent_steps`
    /// 都挂着 `ON DELETE CASCADE`，只删 trace 是修不掉的 ——
    /// 最肥的 `agent_runs.state_snapshot`（每 2.5s 一份同源全量快照）从不被触碰。
    ///
    /// 三件事：裁 trace → 裁 run（级联）→ 回收空闲页。有删除才回收。
    fn prune_agent_history(conn: &Connection, policy: &PrunePolicy) -> Result<(), CoreError> {
        let traces_deleted = Self::prune_surplus_agent_traces(conn, policy)?;
        let runs_deleted = Self::prune_finished_agent_runs(conn, policy)?;
        if traces_deleted + runs_deleted > 0 {
            Self::reclaim_free_pages(conn, policy)?;
        }
        Ok(())
    }

    /// 单条 run 的 trace 只保留最新若干行（超阈值才动手）。
    fn prune_surplus_agent_traces(
        conn: &Connection,
        policy: &PrunePolicy,
    ) -> Result<usize, CoreError> {
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM agent_traces", [], |r| r.get(0))
            .unwrap_or(0);
        if count < policy.traces_trigger {
            return Ok(0);
        }
        // SQLite 3.25+ window functions
        let deleted = conn
            .execute(
                r#"
                DELETE FROM agent_traces
                WHERE id NOT IN (
                  SELECT id FROM (
                    SELECT id,
                           ROW_NUMBER() OVER (PARTITION BY run_id ORDER BY id DESC) AS rn
                    FROM agent_traces
                  )
                  WHERE rn <= ?1
                )
                "#,
                params![policy.traces_per_run],
            )
            .map_err(|e| CoreError::rpc("DB_PRUNE_FAILED", e.to_string()))?;
        Ok(deleted)
    }

    /// 已完成 run 的保留窗口：最近 `runs_keep_recent` 条 + 最长 `run_max_age_ms`。
    ///
    /// 只删终态：`running`（进行中）与 `planned`（planner 写入的中间态）都不动。
    fn prune_finished_agent_runs(
        conn: &Connection,
        policy: &PrunePolicy,
    ) -> Result<usize, CoreError> {
        let cutoff = now_ms() - policy.run_max_age_ms;
        let deleted = conn
            .execute(
                r#"
                DELETE FROM agent_runs
                WHERE status IN ('completed', 'stopped', 'failed')
                  AND (
                    updated_at < ?1
                    OR id IN (
                      SELECT id FROM agent_runs
                      WHERE status IN ('completed', 'stopped', 'failed')
                      ORDER BY updated_at DESC
                      LIMIT -1 OFFSET ?2
                    )
                  )
                "#,
                params![cutoff, policy.runs_keep_recent],
            )
            .map_err(|e| CoreError::rpc("DB_PRUNE_FAILED", e.to_string()))?;
        Ok(deleted)
    }

    /// DELETE 只把页标记为空闲，文件不会缩回；空闲页占比够高时真正回收。
    ///
    /// `auto_vacuum=INCREMENTAL` 的库走增量回收（便宜）；否则用 `VACUUM` 一次性重建，
    /// 顺带把库转换成增量模式。VACUUM 需要独占锁，失败就等下一轮，不影响调用方。
    fn reclaim_free_pages(conn: &Connection, policy: &PrunePolicy) -> Result<(), CoreError> {
        let free_pages: i64 = conn
            .query_row("PRAGMA freelist_count", [], |r| r.get(0))
            .unwrap_or(0);
        let total_pages: i64 = conn
            .query_row("PRAGMA page_count", [], |r| r.get(0))
            .unwrap_or(0);
        if free_pages <= 0 || total_pages <= 0 {
            return Ok(());
        }
        if free_pages.saturating_mul(100) < total_pages.saturating_mul(policy.freelist_percent) {
            return Ok(());
        }
        let auto_vacuum: i64 = conn
            .query_row("PRAGMA auto_vacuum", [], |r| r.get(0))
            .unwrap_or(0);
        if auto_vacuum == 2 {
            conn.execute_batch("PRAGMA incremental_vacuum;")
        } else {
            // 非空库的 auto_vacuum 改动要等 VACUUM 才落定，所以两条一起做；
            // 设置语句单独执行，失败也不能挡住后面的 VACUUM。
            let _ = conn.pragma_update(None, "auto_vacuum", "INCREMENTAL");
            conn.execute_batch("VACUUM;")
        }
        .map_err(|e| CoreError::rpc("DB_VACUUM_FAILED", e.to_string()))
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
    pub fn set_embedding(&self, embedding: EmbeddingConfig) {
        if let Ok(mut g) = self.embedding.lock() {
            *g = embedding;
        }
    }

    fn embedding(&self) -> EmbeddingConfig {
        self.embedding
            .lock()
            .map(|g| g.clone())
            .unwrap_or_default()
    }

    /// 写入连接（**唯一**一条，串行短事务）。见 `docs/SQLITE-ACCESS.md`。
    fn with_conn<T, F>(&self, f: F) -> Result<T, CoreError>
    where
        F: FnOnce(&Connection) -> Result<T, CoreError>,
    {
        self.db.with_conn(f)
    }

    /// 只读查询：池化连接、不占写入连接（聊天落库很频繁，读路径不该排队等它）。
    fn read<T, F>(&self, f: F) -> Result<T, CoreError>
    where
        F: FnOnce(&Connection) -> Result<T, CoreError>,
    {
        self.db.read(f)
    }

    /// 测试用连接：独立池化连接（`Deref` 到 `Connection`）。
    ///
    /// 测试里既要造「老库」形态又要断言，用独立连接比去争写入连接更稳：
    /// 不参与业务锁，断言前也不会把别的写操作挡住。
    #[cfg(test)]
    fn test_conn(&self) -> crate::sqlite::ReadConn<'_> {
        self.db.read_conn().expect("open test connection")
    }

    pub fn touch_session(&self, session_id: &str, title: Option<&str>) -> Result<(), CoreError> {
        let now = now_ms();
        self.with_conn(|conn| {
            if let Some(t) = title.map(str::trim).filter(|s| !s.is_empty()) {
                if t == "对话" || t == "新对话" {
                    conn.execute(
                        "INSERT INTO sessions (id, updated_at) VALUES (?1, ?2)
                         ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at",
                        params![session_id, now],
                    )?;
                } else {
                    let sanitized = title_from_user_content(t)
                        .unwrap_or_else(|| t.chars().take(80).collect::<String>());
                    conn.execute(
                        "INSERT INTO sessions (id, updated_at, title, title_source) VALUES (?1, ?2, ?3, ?4)
                         ON CONFLICT(id) DO UPDATE SET
                           updated_at = excluded.updated_at,
                           title_source = CASE
                             WHEN sessions.title IS NULL
                               OR sessions.title = '对话'
                               OR sessions.title = '新对话'
                               OR sessions.title LIKE '【叠云meta】%'
                               OR (sessions.title LIKE '{%' AND sessions.title LIKE '%inputText%')
                             THEN excluded.title_source
                             ELSE sessions.title_source
                           END,
                           title = CASE
                             WHEN sessions.title IS NULL
                               OR sessions.title = '对话'
                               OR sessions.title = '新对话'
                               OR sessions.title LIKE '【叠云meta】%'
                               OR (sessions.title LIKE '{%' AND sessions.title LIKE '%inputText%')
                             THEN excluded.title
                             ELSE sessions.title
                           END",
                        params![session_id, now, sanitized, TITLE_SOURCE_HEURISTIC],
                    )?;
                }
            } else {
                conn.execute(
                    "INSERT INTO sessions (id, updated_at) VALUES (?1, ?2)
                     ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at",
                    params![session_id, now],
                )?;
            }
            Ok(())
        })
    }

    /// 显式覆盖会话标题（AI 总结 / 用户改名），**无条件**生效。
    ///
    /// 与 [`Self::touch_session`] 的分工：touch 是「必要时补一个启发式标题」，
    /// 只在占位 / meta 脏值时落笔；这里写的是「有明确作者的标题」，必须盖得住启发式值。
    /// `updated_at` 刻意不动：改标题不是新活动，不该把会话顶到历史列表最前面。
    pub fn set_session_title(
        &self,
        session_id: &str,
        title: &str,
        source: &str,
    ) -> Result<Value, CoreError> {
        let sid = session_id.trim();
        if sid.is_empty() {
            return Err(CoreError::rpc("INVALID_PARAMS", "sessionId 必填"));
        }
        let source = normalize_title_source(source)?;
        // 与启发式标题同一套整形（首行 / 折叠空白 / 48 字上限）：标题是列表里的单行文本，
        // 模型偶尔会回「标题 + 解释」，多行内容会把列表撑坏。
        let title =
            first_line_title(title).ok_or_else(|| CoreError::rpc("INVALID_PARAMS", "title 必填"))?;
        let changed = self.with_conn(|conn| {
            let n = conn.execute(
                "UPDATE sessions SET title = ?1, title_source = ?2 WHERE id = ?3",
                params![title, source, sid],
            )?;
            Ok(n)
        })?;
        Ok(json!({ "ok": true, "updated": changed }))
    }

    pub fn list_sessions(&self, limit: i64, archived: bool) -> Result<Vec<SessionRow>, CoreError> {        self.with_conn(|conn| {
            let mut stmt = conn.prepare(
                "SELECT s.id, s.updated_at, s.title, s.title_source,
                        COALESCE(s.archived, 0) AS archived, s.workspace_path,
                        (SELECT m.content FROM messages m
                         WHERE m.session_id = s.id AND m.role = 'user'
                         ORDER BY m.id ASC LIMIT 1) AS preview
                 FROM sessions s
                 WHERE EXISTS (SELECT 1 FROM messages m WHERE m.session_id = s.id)
                   AND COALESCE(s.archived, 0) = ?1
                 ORDER BY s.updated_at DESC
                 LIMIT ?2",
            )?;
            let mut rows: Vec<SessionRow> = stmt
                .query_map(params![if archived { 1 } else { 0 }, limit], |row| {
                    Ok(SessionRow {
                        id: row.get(0)?,
                        updated_at: row.get(1)?,
                        title: row.get(2)?,
                        title_source: row.get(3)?,
                        archived: row.get::<_, i64>(4)? != 0,
                        workspace_path: row.get(5)?,
                        preview: row.get(6)?,
                    })
                })?
                .collect::<Result<Vec<_>, _>>()?;

            for row in &mut rows {
                if let Some(raw) = row.preview.take() {
                    let plain = strip_message_meta(&raw);
                    row.preview = Some(plain.to_string());
                    if title_needs_repair(row.title.as_deref()) {
                        if let Some(t) = title_from_user_content(plain) {
                            let _ = conn.execute(
                                "UPDATE sessions SET title = ?1, title_source = ?2 WHERE id = ?3",
                                params![t, TITLE_SOURCE_HEURISTIC, row.id],
                            );
                            row.title = Some(t);
                            row.title_source = Some(TITLE_SOURCE_HEURISTIC.to_string());
                        } else {
                            row.title = None;
                        }
                    }
                } else if title_needs_repair(row.title.as_deref()) {
                    row.title = None;
                }
            }
            Ok(rows)
        })
    }

    pub fn get_session(&self, session_id: &str) -> Result<Option<SessionRow>, CoreError> {
        self.with_conn(|conn| {
            Ok(conn
                .query_row(
                    "SELECT id, updated_at, title, title_source, COALESCE(archived,0), workspace_path
                     FROM sessions WHERE id = ?1",
                    params![session_id],
                    |row| {
                        Ok(SessionRow {
                            id: row.get(0)?,
                            updated_at: row.get(1)?,
                            title: row.get(2)?,
                            title_source: row.get(3)?,
                            archived: row.get::<_, i64>(4)? != 0,
                            workspace_path: row.get(5)?,
                            preview: None,
                        })
                    },
                )
                .optional()?)
        })
    }

    // —— 会话交接（session_handoffs）：按 session_id 精确读写，不参与语义召回 ——

    pub fn handoff_save(
        &self,
        session_id: &str,
        title: &str,
        payload: &str,
    ) -> Result<(), CoreError> {
        let title = title.trim();
        let payload = payload.trim();
        if payload.is_empty() {
            return Err(CoreError::rpc("INVALID_PARAMS", "payload 不能为空"));
        }
        let now = now_ms();
        self.with_conn(|conn| {
            conn.execute(
                "INSERT INTO session_handoffs (session_id, title, payload, created_at)
                 VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT(session_id) DO UPDATE SET
                   title = excluded.title, payload = excluded.payload, created_at = excluded.created_at",
                params![session_id, title, payload, now],
            )?;
            Ok(())
        })
    }

    /// 交接带着来源会话的工作区一起返回：跨项目「继续上次」时，新会话必须挂到
    /// 交接**讲的**那个工作区，而不是用户当前视图的工作区。
    pub fn handoff_get(&self, session_id: &str) -> Result<Option<Value>, CoreError> {
        self.with_conn(|conn| {
            Ok(conn
                .query_row(
                    "SELECT h.session_id, h.title, h.payload, h.created_at, s.workspace_path
                     FROM session_handoffs h
                     LEFT JOIN sessions s ON s.id = h.session_id
                     WHERE h.session_id = ?1",
                    params![session_id],
                    |row| {
                        Ok(json!({
                            "sessionId": row.get::<_, String>(0)?,
                            "title": row.get::<_, String>(1)?,
                            "payload": row.get::<_, String>(2)?,
                            "createdAt": row.get::<_, i64>(3)?,
                            "workspacePath": row.get::<_, Option<String>>(4)?,
                        }))
                    },
                )
                .optional()?)
        })
    }

    /// 最近一份交接（排除指定会话，通常是当前会话）。
    /// 「继续上次」的取回入口：按 created_at 全序取最新，不做语义匹配。
    pub fn handoff_latest(
        &self,
        exclude_session_id: Option<&str>,
    ) -> Result<Option<Value>, CoreError> {
        self.with_conn(|conn| {
            let mut stmt = conn.prepare(
                "SELECT h.session_id, h.title, h.payload, h.created_at, s.workspace_path
                 FROM session_handoffs h
                 LEFT JOIN sessions s ON s.id = h.session_id
                 WHERE (?1 IS NULL OR h.session_id != ?1)
                 ORDER BY h.created_at DESC LIMIT 1",
            )?;
            let mut rows = stmt.query(params![exclude_session_id])?;
            if let Some(row) = rows.next()? {
                return Ok(Some(json!({
                    "sessionId": row.get::<_, String>(0)?,
                    "title": row.get::<_, String>(1)?,
                    "payload": row.get::<_, String>(2)?,
                    "createdAt": row.get::<_, i64>(3)?,
                    "workspacePath": row.get::<_, Option<String>>(4)?,
                })));
            }
            Ok(None)
        })
    }

    pub fn create_session(
        &self,
        title: Option<&str>,
        workspace_path: Option<&str>,
    ) -> Result<SessionRow, CoreError> {
        let id = format!("s-{}-{}", now_ms(), rand_suffix());
        let now = now_ms();
        self.with_conn(|conn| {
            conn.execute(
                "INSERT INTO sessions (id, updated_at, title, workspace_path) VALUES (?1, ?2, ?3, ?4)",
                params![id, now, title, workspace_path],
            )?;
            Ok(SessionRow {
                id,
                updated_at: now,
                title: title.map(str::to_string),
                title_source: None,
                archived: false,
                workspace_path: workspace_path.map(str::to_string),
                preview: None,
            })
        })
    }

    pub fn append_message(
        &self,
        session_id: &str,
        role: &str,
        content: &str,
        reasoning: Option<&str>,
    ) -> Result<AppendMessageResult, CoreError> {
        // 唯一写库口：meta 里的字节（base64 / data URL）在这里被挡掉，
        // 不依赖各调用点自觉。
        let content = sanitize_persisted_message(content).unwrap_or_else(|| content.to_string());
        // 真思考与 content 分列：空值统一落 NULL，避免「空串」与「无」两种表示。
        let reasoning = reasoning
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string);
        let now = now_ms();
        self.with_conn(|conn| {
            // 会话行是唯一真相：不先问一句就写，外键只会吐
            // `FOREIGN KEY constraint failed`（界面上就是一句「发送失败」+ 一串英文），
            // 调用方既不知道该重开对话还是参数写错了。这里给稳定错误码。
            let session_exists = conn
                .query_row(
                    "SELECT 1 FROM sessions WHERE id = ?1",
                    params![session_id],
                    |row| row.get::<_, i64>(0),
                )
                .optional()?
                .is_some();
            if !session_exists {
                return Err(CoreError::rpc(
                    "SESSION_NOT_FOUND",
                    format!("会话 {session_id} 不存在（可能已被删除或清理）"),
                ));
            }
            conn.execute(
                "INSERT INTO messages (session_id, role, content, reasoning, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
                params![session_id, role, &content, &reasoning, now],
            )?;
            let id = conn.last_insert_rowid();
            conn.execute(
                "UPDATE sessions SET updated_at = ?1 WHERE id = ?2",
                params![now, session_id],
            )?;
            if role == "user" {
                maybe_set_title_from_user_message(conn, session_id, &content)?;
            }
            Ok(AppendMessageResult { local_msg_id: id })
        })
    }

    pub fn recent_messages(
        &self,
        session_id: &str,
        limit: i64,
    ) -> Result<Vec<MessageRow>, CoreError> {
        self.with_conn(|conn| {
            let mut stmt = conn.prepare(
                "SELECT id, session_id, role, content, reasoning, created_at
                 FROM messages WHERE session_id = ?1
                 ORDER BY created_at DESC LIMIT ?2",
            )?;
            let mut rows: Vec<MessageRow> = stmt
                .query_map(params![session_id, limit], |row| {
                    Ok(MessageRow {
                        id: row.get(0)?,
                        session_id: row.get(1)?,
                        role: row.get(2)?,
                        content: row.get(3)?,
                        reasoning: row.get(4)?,
                        created_at: row.get(5)?,
                    })
                })?
                .collect::<Result<Vec<_>, _>>()?;
            rows.reverse();
            Ok(rows)
        })
    }

    pub fn messages_older_than(
        &self,
        session_id: &str,
        before_id: i64,
        limit: i64,
    ) -> Result<Vec<MessageRow>, CoreError> {
        let lim = limit.clamp(1, 500);
        self.with_conn(|conn| {
            let mut stmt = conn.prepare(
                "SELECT id, session_id, role, content, reasoning, created_at
                 FROM messages WHERE session_id = ?1 AND id < ?2
                 ORDER BY id DESC LIMIT ?3",
            )?;
            let mut rows: Vec<MessageRow> = stmt
                .query_map(params![session_id, before_id, lim], |row| {
                    Ok(MessageRow {
                        id: row.get(0)?,
                        session_id: row.get(1)?,
                        role: row.get(2)?,
                        content: row.get(3)?,
                        reasoning: row.get(4)?,
                        created_at: row.get(5)?,
                    })
                })?
                .collect::<Result<Vec<_>, _>>()?;
            rows.reverse();
            Ok(rows)
        })
    }

    pub fn set_session_archived(
        &self,
        session_id: &str,
        archived: bool,
    ) -> Result<Value, CoreError> {
        self.with_conn(|conn| {
            conn.execute(
                "UPDATE sessions SET archived = ?1 WHERE id = ?2",
                params![if archived { 1 } else { 0 }, session_id],
            )?;
            Ok(json!({ "ok": true }))
        })
    }

    pub fn set_session_workspace(
        &self,
        session_id: &str,
        workspace_path: Option<&str>,
    ) -> Result<Value, CoreError> {
        self.touch_session(session_id, None)?;
        let p = workspace_path
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string);
        self.with_conn(|conn| {
            conn.execute(
                "UPDATE sessions SET workspace_path = ?1 WHERE id = ?2",
                params![p, session_id],
            )?;
            Ok(json!({ "ok": true, "workspacePath": p }))
        })
    }

    pub fn clear_session(&self, session_id: &str) -> Result<Value, CoreError> {
        self.with_conn(|conn| {
            conn.execute(
                "DELETE FROM agent_traces WHERE session_id = ?1",
                params![session_id],
            )?;
            conn.execute(
                "DELETE FROM agent_runs WHERE session_id = ?1",
                params![session_id],
            )?;
            conn.execute(
                "DELETE FROM messages WHERE session_id = ?1",
                params![session_id],
            )?;
            conn.execute("DELETE FROM sessions WHERE id = ?1", params![session_id])?;
            Ok(json!({ "ok": true }))
        })
    }

    pub fn add_long_memory(
        &self,
        content: &str,
        source: &str,
        kind: Option<&str>,
        scope: Option<&str>,
        importance: Option<i64>,
        expires_at: Option<i64>,
        metadata: Option<&Value>,
        session_id: Option<&str>,
    ) -> Result<Value, CoreError> {
        let normalized = content.trim();
        if normalized.is_empty() {
            return Err(CoreError::rpc("INVALID_CONTENT", "content 必填"));
        }
        let now = now_ms();
        let kind = detect_memory_kind(normalized, kind);
        let scope = scope
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or("global")
            .chars()
            .take(120)
            .collect::<String>();
        let importance = normalize_importance(importance);
        let session_id = session_id
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(|s| s.chars().take(64).collect::<String>());
        let metadata_json = metadata.map(|m| {
            if m.is_string() {
                m.as_str().unwrap_or("").to_string()
            } else {
                m.to_string()
            }
        });
        self.with_conn(|conn| {
            if let Ok(existing) = conn.query_row(
                "SELECT id FROM long_memories WHERE content = ?1 AND status != 'deleted' LIMIT 1",
                params![normalized],
                |row| row.get::<_, i64>(0),
            ) {
                conn.execute(
                    "UPDATE long_memories
                     SET updated_at = ?1, source = COALESCE(source, ?2),
                         status = CASE WHEN status = 'archived' THEN 'active' ELSE status END,
                         session_id = COALESCE(session_id, ?4)
                     WHERE id = ?3",
                    params![now, source, existing, session_id],
                )?;
                return Ok(json!({ "localMemoryId": existing, "duplicate": true }));
            }
            conn.execute(
                "INSERT INTO long_memories
                  (content, source, scope, kind, importance, status, created_at, updated_at, expires_at, metadata_json, session_id)
                 VALUES (?1, ?2, ?3, ?4, ?5, 'active', ?6, ?6, ?7, ?8, ?9)",
                params![
                    normalized,
                    source,
                    scope,
                    kind,
                    importance,
                    now,
                    expires_at.filter(|v| *v > 0),
                    metadata_json,
                    session_id
                ],
            )?;
            Ok(json!({ "localMemoryId": conn.last_insert_rowid() }))
        })
    }

    /// 会话维度：这个会话沉淀了哪些记忆（只读，走读池）。
    ///
    /// 存在的理由只有一个：归纳器把记忆写成项目级/用户级之后，「哪条是这次对话产生的」
    /// 在库里没有任何痕迹 —— 用户问「这个会话是不是乱记了什么 / 把它记的忘掉」时,
    /// 只能全表翻 + 猜时间。写入点就在 add_long_memory，一列即可回答。
    pub fn long_memories_by_session(
        &self,
        session_id: &str,
        limit: i64,
    ) -> Result<Vec<Value>, CoreError> {
        let sid = session_id.trim();
        if sid.is_empty() {
            return Ok(Vec::new());
        }
        let lim = limit.clamp(1, 200);
        let now = now_ms();
        self.read(|conn| {
            let mut stmt = conn.prepare(
                "SELECT id, content, source, scope, kind, importance, status, created_at, updated_at, last_used_at, access_count
                 FROM long_memories
                 WHERE session_id = ?1
                   AND status IN ('active', 'stale')
                   AND (expires_at IS NULL OR expires_at <= 0 OR expires_at > ?2)
                 ORDER BY id DESC
                 LIMIT ?3",
            )?;
            let mapped = stmt.query_map(params![sid, now, lim], map_long_memory_row)?;
            mapped.collect::<Result<Vec<_>, _>>().map_err(CoreError::from)
        })
    }

    /// 会话维度：把这个会话沉淀的记忆整体**软归档**（可恢复，不物理删除）。
    ///
    /// 与「删掉记忆」分开：状态位是既有生命周期（active/stale/archived）的一部分，
    /// 不新增删除路径，也不需要询问模型；恢复走 memory.long_status_set。
    pub fn archive_long_memories_by_session(&self, session_id: &str) -> Result<i64, CoreError> {
        let sid = session_id.trim();
        if sid.is_empty() {
            return Ok(0);
        }
        let now = now_ms();
        self.with_conn(|conn| {
            let n = conn.execute(
                "UPDATE long_memories
                 SET status = 'archived', updated_at = ?1
                 WHERE session_id = ?2 AND status != 'archived'",
                params![now, sid],
            )?;
            Ok(n as i64)
        })
    }

    /// 写入策略层（**唯一**政策点）：低价值闸 + 近重复抑制 + 写入即索引。
    ///
    /// 为什么政策放在这里而不在 Node：memory.long_add 是全部写入方（归纳器、记忆工具、
    /// 手动）的共同终点，也是唯一能在**插入前**看到 embedding 的地方。
    ///
    /// - 低价值闸：source 带 consolidation（自动归纳）且 importance 低于阈值则不落库。
    ///   数据事实：注入预算每轮只给 8+5 条，importance ≤ 2 的近 400 条既进不去又挤占召回。
    /// - 近重复抑制：同 scope 内余弦 ≥ 阈值视为「同一件事的另一种说法」，只更新既有行
    ///   （importance 取大、updated_at 刷新、来源会话 COALESCE 补齐），不再新增一行。
    ///   复用既有 embedding 与语义检索，不另造一套文本相似度。
    pub async fn add_long_memory_deduped(
        &self,
        content: &str,
        source: &str,
        kind: Option<&str>,
        scope: Option<&str>,
        importance: Option<i64>,
        expires_at: Option<i64>,
        metadata: Option<&Value>,
        session_id: Option<&str>,
    ) -> Result<Value, CoreError> {
        let normalized = content.trim();
        if normalized.is_empty() {
            return Err(CoreError::rpc("INVALID_CONTENT", "content 必填"));
        }
        let imp = normalize_importance(importance);
        if source.contains("consolidation") && imp < CONSOLIDATION_MIN_IMPORTANCE {
            return Ok(json!({
                "ok": true,
                "skipped": "low_importance",
                "importance": imp,
                "vector": json!({ "ok": true, "indexed": false, "reason": "skipped" }),
            }));
        }
        let scope_value = scope
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or("global")
            .chars()
            .take(120)
            .collect::<String>();
        let (vector, duplicate) = self.embed_for_write(normalized, &scope_value).await?;
        if let Some((dup_id, similarity)) = duplicate {
            let now = now_ms();
            self.with_conn(|conn| {
                conn.execute(
                    "UPDATE long_memories
                     SET updated_at = ?1,
                         importance = MAX(COALESCE(importance, 3), ?2),
                         session_id = COALESCE(session_id, ?4)
                     WHERE id = ?3",
                    params![now, imp, dup_id, session_id],
                )?;
                Ok(())
            })?;
            return Ok(json!({
                "ok": true,
                "localMemoryId": dup_id,
                "duplicate": "near",
                "similarity": round_score(similarity),
                "vector": json!({ "ok": true, "indexed": false, "reason": "duplicate" }),
            }));
        }
        let ins = self.add_long_memory(
            normalized,
            source,
            kind,
            scope,
            importance,
            expires_at,
            metadata,
            session_id,
        )?;
        let memory_id = ins
            .get("localMemoryId")
            .and_then(|v| v.as_i64())
            .unwrap_or(0);
        let vector_res = self.store_long_memory_vector(memory_id, &vector)?;
        Ok(json!({
            "ok": true,
            "localMemoryId": memory_id,
            "duplicate": ins.get("duplicate").cloned().unwrap_or(Value::Bool(false)),
            "vector": vector_res,
        }))
    }

    /// 写入前的 embedding + 近重复查询（一次向量往返，供插入与「写入即索引」共用）。
    async fn embed_for_write(
        &self,
        content: &str,
        scope: &str,
    ) -> Result<(Vec<f32>, Option<(i64, f64)>), CoreError> {
        let embedding = self.embedding();
        if !embedding.enabled() {
            // 没有向量能力就不判定近重复（不另造文本相似度第二套）
            return Ok((Vec::new(), None));
        }
        let text = content
            .chars()
            .take(MEMORY_EMBED_TEXT_MAX)
            .collect::<String>();
        let vector = embedding::embed_texts(&embedding, &[text])
            .await?
            .into_iter()
            .next()
            .unwrap_or_default();
        if vector.is_empty() {
            return Ok((Vec::new(), None));
        }
        let hits = self.semantic_search_long(scope, &vector, 1)?;
        let dup = hits.first().and_then(|hit| {
            let id = hit.get("id").and_then(|v| v.as_i64())?;
            let score = hit.get("score").and_then(|v| v.as_f64())?;
            if score >= NEAR_DUP_COSINE {
                Some((id, score))
            } else {
                None
            }
        });
        Ok((vector, dup))
    }

    pub fn recent_long_memories(
        &self,
        limit: i64,
        scope: Option<&str>,
    ) -> Result<Vec<Value>, CoreError> {
        let now = now_ms();
        // 读池：召回是每轮系统提示的读路径，绝不能排在「聊天落库」的写入连接后面
        // （`memory.long_recall` 两次 120s 超时就是在写入连接上排队，见 docs/SQLITE-ACCESS.md）
        self.read(|conn| {
            let rows = if let Some(sc) = scope.filter(|s| !s.is_empty()) {
                if is_global_memory_scope(sc) {
                    let sql = format!(
                        "SELECT id, content, source, scope, kind, importance, status, created_at, updated_at, last_used_at, access_count
                         FROM long_memories
                         WHERE {}
                           AND status IN ('active', 'stale')
                           AND (expires_at IS NULL OR expires_at <= 0 OR expires_at > ?1)
                         ORDER BY updated_at DESC, id DESC
                         LIMIT ?2",
                        long_memory_scope_filter("scope", sc, 1)
                    );
                    let mut stmt = conn.prepare(&sql)?;
                    let mapped = stmt.query_map(params![now, limit], map_long_memory_row)?;
                    mapped.collect::<Result<Vec<_>, _>>()?
                } else {
                    let mut stmt = conn.prepare(
                        "SELECT id, content, source, scope, kind, importance, status, created_at, updated_at, last_used_at, access_count
                         FROM long_memories
                         WHERE scope = ?1
                           AND status IN ('active', 'stale')
                           AND (expires_at IS NULL OR expires_at <= 0 OR expires_at > ?2)
                         ORDER BY updated_at DESC, id DESC
                         LIMIT ?3",
                    )?;
                    let mapped = stmt.query_map(params![sc, now, limit], map_long_memory_row)?;
                    mapped.collect::<Result<Vec<_>, _>>()?
                }
            } else {
                let sql = format!(
                    "SELECT id, content, source, scope, kind, importance, status, created_at, updated_at, last_used_at, access_count
                     FROM long_memories
                     WHERE {}
                       AND status IN ('active', 'stale')
                       AND (expires_at IS NULL OR expires_at <= 0 OR expires_at > ?1)
                     ORDER BY updated_at DESC, id DESC
                     LIMIT ?2",
                    long_memory_scope_filter("scope", GLOBAL_MEMORY_SCOPE, 1)
                );
                let mut stmt = conn.prepare(&sql)?;
                let mapped = stmt.query_map(params![now, limit], map_long_memory_row)?;
                mapped.collect::<Result<Vec<_>, _>>()?
            };
            Ok(rows)
        })
    }

    pub fn long_memory_vector_status(&self) -> Result<Value, CoreError> {
        let embedding = self.embedding();
        let sig = embedding.signature();
        self.with_conn(|conn| {
            let total: i64 = conn.query_row(
                "SELECT COUNT(*) FROM long_memories WHERE status IN ('active', 'stale')",
                [],
                |row| row.get(0),
            )?;
            let vector_count: i64 = if sig.is_empty() {
                0
            } else {
                conn.query_row(
                    "SELECT COUNT(*)
                     FROM long_memory_vectors v
                     JOIN long_memories m ON m.id = v.memory_id
                     WHERE m.status IN ('active', 'stale') AND v.model = ?1",
                    params![sig],
                    |row| row.get(0),
                )?
            };
            Ok(json!({
                "ok": true,
                "total": total,
                "vectorCount": vector_count,
                "embeddingModel": if sig.is_empty() { Value::Null } else { json!(sig) },
            }))
        })
    }

    pub async fn index_long_memory(&self, memory_id: i64) -> Result<Value, CoreError> {
        let row = self.with_conn(|conn| {
            Ok(conn
                .query_row(
                    "SELECT content FROM long_memories WHERE id = ?1 AND status != 'deleted'",
                    params![memory_id],
                    |row| row.get::<_, String>(0),
                )
                .optional()?)
        })?;
        let Some(content) = row.filter(|c| !c.trim().is_empty()) else {
            return Ok(json!({ "ok": false, "indexed": false, "reason": "not_found" }));
        };
        let embedding = self.embedding();
        if !embedding.enabled() {
            return Ok(json!({ "ok": false, "indexed": false, "reason": "embedding_disabled" }));
        }
        let text = content
            .chars()
            .take(MEMORY_EMBED_TEXT_MAX)
            .collect::<String>();
        let vectors = embedding::embed_texts(&embedding, &[text]).await?;
        let vector = vectors.into_iter().next().unwrap_or_default();
        if vector.is_empty() {
            return Ok(json!({ "ok": false, "indexed": false, "reason": "embedding_failed" }));
        }
        self.store_long_memory_vector(memory_id, &vector)
    }

    /// 向量落库（**唯一**实现）：index_long_memory 与「写入即索引」共用。
    ///
    /// 抽出来的理由只有一个：抑制近重复时必须先算一次 embedding，
    /// 算完不该为了入库再算第二次（远程 embedding 一次往返就是几百毫秒）。
    fn store_long_memory_vector(&self, memory_id: i64, vector: &[f32]) -> Result<Value, CoreError> {
        if vector.is_empty() {
            return Ok(json!({ "ok": false, "indexed": false, "reason": "embedding_failed" }));
        }
        let embedding = self.embedding();
        let sig = embedding.signature();
        let dims = embedding.dimensions;
        let blob = embedding::vector_to_blob(vector);
        let now = now_ms();
        self.with_conn(|conn| {
            conn.execute(
                "INSERT INTO long_memory_vectors (memory_id, model, dimensions, vector, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5)
                 ON CONFLICT(memory_id) DO UPDATE SET
                   model = excluded.model,
                   dimensions = excluded.dimensions,
                   vector = excluded.vector,
                   updated_at = excluded.updated_at",
                params![memory_id, sig, dims, blob, now],
            )?;
            Ok(json!({
                "ok": true,
                "indexed": true,
                "memoryId": memory_id,
                "embeddingModel": sig,
            }))
        })
    }

    pub async fn reindex_long_memories(&self, limit: i64) -> Result<Value, CoreError> {
        let embedding = self.embedding();
        if !embedding.enabled() {
            return Ok(json!({ "ok": false, "indexed": 0, "reason": "embedding_disabled" }));
        }
        let sig = embedding.signature();
        let dims = embedding.dimensions;
        let now = now_ms();
        let rows = self.with_conn(|conn| -> Result<Vec<(i64, String)>, CoreError> {
            let mut stmt = conn.prepare(
                "SELECT m.id, m.content
                 FROM long_memories m
                 LEFT JOIN long_memory_vectors v ON v.memory_id = m.id AND v.model = ?1
                 WHERE m.status IN ('active', 'stale')
                   AND (m.expires_at IS NULL OR m.expires_at <= 0 OR m.expires_at > ?2)
                   AND v.memory_id IS NULL
                 ORDER BY m.id ASC
                 LIMIT ?3",
            )?;
            let mapped = stmt.query_map(params![sig, now, limit], |row| {
                Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
            })?;
            mapped
                .collect::<Result<Vec<_>, _>>()
                .map_err(CoreError::from)
        })?;
        let mut indexed = 0i64;
        // 一批一个请求：原来每条记忆单独发一次 embedding HTTP（100 条 = 100 次串行往返）。
        // 分批与并发上限都在 embedding::embed_batches 里（进程级闸门单一来源）。
        let pending: Vec<(i64, String)> = rows
            .into_iter()
            .map(|(id, content)| {
                let text = content
                    .chars()
                    .take(MEMORY_EMBED_TEXT_MAX)
                    .collect::<String>();
                (id, text)
            })
            .collect();
        for (id, vector) in embedding::embed_batches(&embedding, &pending).await? {
            if vector.is_empty() {
                continue;
            }
            let blob = embedding::vector_to_blob(&vector);
            self.with_conn(|conn| {
                conn.execute(
                    "INSERT INTO long_memory_vectors (memory_id, model, dimensions, vector, updated_at)
                     VALUES (?1, ?2, ?3, ?4, ?5)
                     ON CONFLICT(memory_id) DO UPDATE SET
                       model = excluded.model,
                       dimensions = excluded.dimensions,
                       vector = excluded.vector,
                       updated_at = excluded.updated_at",
                    params![id, sig, dims, blob, now],
                )?;
                Ok(())
            })?;
            indexed += 1;
        }
        let batch_len = indexed;
        Ok(json!({
            "ok": true,
            "indexed": indexed,
            "remainingPossible": batch_len >= limit,
            "embeddingModel": sig,
        }))
    }

    pub fn update_long_memory_status(
        &self,
        memory_id: i64,
        status: &str,
    ) -> Result<Value, CoreError> {
        let normalized = normalize_memory_status(status);
        let now = now_ms();
        self.with_conn(|conn| {
            conn.execute(
                "UPDATE long_memories SET status = ?1, updated_at = ?2 WHERE id = ?3",
                params![normalized, now, memory_id],
            )?;
            if normalized == "deleted" {
                conn.execute(
                    "DELETE FROM long_memory_vectors WHERE memory_id = ?1",
                    params![memory_id],
                )?;
            }
            Ok(json!({ "ok": true, "status": normalized }))
        })
    }

    pub fn keyword_search_long_memories(
        &self,
        query: &str,
        limit: i64,
    ) -> Result<Value, CoreError> {
        let q = query.trim();
        if q.is_empty() {
            return Ok(json!({ "ok": true, "mode": "keyword", "results": [] }));
        }
        let hits = self.fts_search_long(None, q, limit)?;
        let total = hits.len();
        let results: Vec<Value> = hits
            .into_iter()
            .map(|(score, row)| {
                let (id, content, source, scope, kind, importance, status, created_at) = row;
                json!({
                    "id": id,
                    "content": content,
                    "source": source,
                    "scope": scope,
                    "kind": kind,
                    "importance": importance,
                    "status": status,
                    "created_at": created_at,
                    "score": round_score(score),
                })
            })
            .collect();
        Ok(json!({
            "ok": true,
            "mode": "keyword",
            "results": results,
            "totalCandidates": total,
        }))
    }

    pub fn save_compaction_archive(
        &self,
        input: CompactionArchiveInput,
    ) -> Result<Value, CoreError> {
        let now = now_ms();
        let summary_text = input
            .summary
            .as_ref()
            .and_then(|s| s.get("summary"))
            .and_then(|v| v.as_str())
            .map(|s| s.chars().take(4000).collect::<String>())
            .or_else(|| {
                input
                    .summary
                    .as_ref()
                    .and_then(|s| s.as_str())
                    .map(|s| s.chars().take(4000).collect())
            });
        let summary_json = input
            .summary
            .as_ref()
            .filter(|s| s.is_object())
            .map(|s| s.to_string());
        let folded = input
            .folded_transcript
            .or(input.folded_text)
            .map(|s| s.chars().take(200_000).collect::<String>());
        self.with_conn(|conn| {
            conn.execute(
                "INSERT INTO compaction_archives
                  (session_id, workspace_path, tokens_before, tokens_after, summary_text, summary_json, folded_text, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                params![
                    input.session_id,
                    input.workspace_path,
                    input.tokens_before.unwrap_or(0),
                    input.tokens_after.unwrap_or(0),
                    summary_text,
                    summary_json,
                    folded,
                    now
                ],
            )?;
            Ok(json!({ "ok": true, "id": conn.last_insert_rowid(), "createdAt": now }))
        })
    }

    pub fn recent_compaction_archives(
        &self,
        session_id: &str,
        limit: i64,
    ) -> Result<Vec<Value>, CoreError> {
        self.with_conn(|conn| {
            let mut stmt = conn.prepare(
                "SELECT id, session_id, workspace_path, tokens_before, tokens_after, summary_text,
                        CASE WHEN folded_text IS NOT NULL AND length(folded_text) > 0 THEN 1 ELSE 0 END,
                        created_at
                 FROM compaction_archives WHERE session_id = ?1 ORDER BY created_at DESC LIMIT ?2",
            )?;
            let rows = stmt
                .query_map(params![session_id, limit], |row| {
                    Ok(json!({
                        "id": row.get::<_, i64>(0)?,
                        "session_id": row.get::<_, Option<String>>(1)?,
                        "workspace_path": row.get::<_, Option<String>>(2)?,
                        "tokens_before": row.get::<_, i64>(3)?,
                        "tokens_after": row.get::<_, i64>(4)?,
                        "summary_text": row.get::<_, Option<String>>(5)?,
                        "has_folded_text": row.get::<_, i64>(6)? != 0,
                        "created_at": row.get::<_, i64>(7)?,
                    }))
                })?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(rows)
        })
    }

    /// 会话正文的跨会话检索（工具 `session_recall` 的单一后端）。
    ///
    /// 索引是 `messages_fts`（trigram，见 `schema.rs`），查询串由 `crate::fts` 生成 ——
    /// 与长期记忆检索同一条词法链路，不另写分词。中文双字词（`索引`）没有可命中的
    /// trigram，自动退 `LIKE` 子串扫描（`messages` 行数由会话量决定，扫描有界）。
    ///
    /// workspace / session 过滤在 Rust 里做：`projects::project_path_key` 是路径身份的
    /// **唯一**归一化实现，再在 SQL 里写一份 `LOWER(REPLACE(...))` 就是第二套口径；
    /// 而 FTS 命中集通常很小，多取几倍候选再过滤，比维护两套归一化便宜。
    pub fn search_messages(
        &self,
        query: &str,
        workspace_path: Option<&str>,
        session_id: Option<&str>,
        limit: i64,
        snippet_chars: i64,
    ) -> Result<Value, CoreError> {
        let q = query.trim();
        if q.is_empty() {
            return Ok(json!({ "ok": true, "mode": "none", "results": [] }));
        }
        let lim = limit.clamp(1, 100);
        let snippet_chars = snippet_chars.clamp(60, 2000) as usize;
        // 过滤发生在取回之后，所以先放大候选；上限防止一次 LIKE 扫描把整库拉进内存。
        let candidate = (lim * 4).min(400);
        let use_fts = crate::fts::has_indexable_term(q);
        let (sql, first_param) = if use_fts {
            let Some(match_q) = crate::fts::match_query(q) else {
                return Ok(json!({ "ok": true, "mode": "none", "results": [] }));
            };
            (
                "SELECT m.id, m.session_id, m.role, m.content, m.created_at, s.title, s.workspace_path,
                        bm25(messages_fts) AS rank
                 FROM messages_fts
                 JOIN messages m ON m.id = messages_fts.rowid
                 LEFT JOIN sessions s ON s.id = m.session_id
                 WHERE messages_fts MATCH ?1
                 ORDER BY rank
                 LIMIT ?2"
                    .to_string(),
                match_q,
            )
        } else {
            (
                "SELECT m.id, m.session_id, m.role, m.content, m.created_at, s.title, s.workspace_path,
                        -1.0 AS rank
                 FROM messages m
                 LEFT JOIN sessions s ON s.id = m.session_id
                 WHERE m.content LIKE ?1 ESCAPE '\\'
                 ORDER BY m.id DESC
                 LIMIT ?2"
                    .to_string(),
                like_pattern(q),
            )
        };

        let want_ws = workspace_path
            .map(projects::project_path_key)
            .filter(|s| !s.is_empty());
        let want_sid = session_id.map(str::trim).filter(|s| !s.is_empty()).map(str::to_string);

        let rows = self.read(|conn| {
            let mut stmt = conn.prepare(&sql)?;
            let rows = stmt
                .query_map(params![first_param, candidate], |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, i64>(4)?,
                        row.get::<_, Option<String>>(5)?,
                        row.get::<_, Option<String>>(6)?,
                        row.get::<_, f64>(7)?,
                    ))
                })?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(rows)
        })?;

        let mut results = Vec::new();
        for (id, sid, role, content, created_at, title, ws, rank) in rows {
            if let Some(want) = &want_sid {
                if &sid != want {
                    continue;
                }
            }
            if let Some(want) = &want_ws {
                let row_key = ws.as_deref().map(projects::project_path_key);
                if row_key.as_deref() != Some(want.as_str()) {
                    continue;
                }
            }
            results.push(json!({
                "id": id,
                "sessionId": sid,
                "title": title,
                "role": role,
                "snippet": snippet_around(&content, q, snippet_chars),
                "createdAt": created_at,
                "workspacePath": ws,
                "score": if use_fts { round_score(-rank) } else { 0.0 },
            }));
            if results.len() >= lim as usize {
                break;
            }
        }
        Ok(json!({
            "ok": true,
            "mode": if use_fts { "fts" } else { "like" },
            "results": results,
        }))
    }

    /// 压缩归档里被折叠的原文（`compaction_archives.folded_text`）的检索。
    ///
    /// 这段正文是**压缩掉的历史原文**：它已经不在活跃对话里，也不再参与下一轮投影，
    /// 但它是「当时到底聊了什么」的最后一份材料，所以给它一个读的出口，
    /// 而不是让它只躺在库里。
    ///
    /// 不建 FTS 索引：每会话每轮压缩至多一行，行数由压缩轮次封顶，在 Rust 里做子串匹配
    /// 足够；另建一份 trigram 影子表只会多一处要维护的一致性（与 `long_memories` 不同，
    /// 那里是几百上千行、且要参与每轮召回）。
    pub fn search_compaction_folded(
        &self,
        query: &str,
        workspace_path: Option<&str>,
        session_id: Option<&str>,
        limit: i64,
        snippet_chars: i64,
    ) -> Result<Value, CoreError> {
        let lim = limit.clamp(1, 50);
        let snippet_chars = snippet_chars.clamp(60, 4000) as usize;
        let needle = query.trim().to_lowercase();
        let want_ws = workspace_path
            .map(projects::project_path_key)
            .filter(|s| !s.is_empty());
        let want_sid = session_id.map(str::trim).filter(|s| !s.is_empty()).map(str::to_string);

        let rows = self.read(|conn| {
            let mut stmt = conn.prepare(
                "SELECT id, session_id, workspace_path, folded_text, created_at
                 FROM compaction_archives
                 WHERE folded_text IS NOT NULL AND length(folded_text) > 0
                 ORDER BY created_at DESC
                 LIMIT ?1",
            )?;
            let rows = stmt
                .query_map(params![(lim * 8).min(400)], |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, Option<String>>(1)?,
                        row.get::<_, Option<String>>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, i64>(4)?,
                    ))
                })?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(rows)
        })?;

        let mut results = Vec::new();
        for (id, sid, ws, folded, created_at) in rows {
            if let Some(want) = &want_sid {
                if sid.as_deref() != Some(want.as_str()) {
                    continue;
                }
            }
            if let Some(want) = &want_ws {
                let row_key = ws.as_deref().map(projects::project_path_key);
                if row_key.as_deref() != Some(want.as_str()) {
                    continue;
                }
            }
            // 空 query = 「这条会话压缩过什么」：只列清单，不带正文。
            let matched = needle.is_empty() || folded.to_lowercase().contains(&needle);
            if !matched {
                continue;
            }
            results.push(json!({
                "id": id,
                "sessionId": sid,
                "workspacePath": ws,
                "snippet": if needle.is_empty() {
                    String::new()
                } else {
                    snippet_around(&folded, query.trim(), snippet_chars)
                },
                "chars": folded.chars().count(),
                "createdAt": created_at,
            }));
            if results.len() >= lim as usize {
                break;
            }
        }
        Ok(json!({
            "ok": true,
            "mode": if needle.is_empty() { "recent" } else { "substring" },
            "results": results,
        }))
    }

    pub async fn recall_long_memories(
        &self,
        query: &str,
        scope: Option<&str>,
        limit: i64,
    ) -> Result<Value, CoreError> {
        let q = query.trim();
        let scope_opt = scope.map(str::trim).filter(|s| !s.is_empty());
        let scope_str = scope_opt.unwrap_or(GLOBAL_MEMORY_SCOPE);
        // 空 scope（尤其新工作区）跳过 embedding，避免堵住 dieyun-core 单线程 RPC。
        if self.count_active_long_memories(scope_str)? == 0 {
            return Ok(json!({ "ok": true, "mode": "none", "results": [] }));
        }
        if q.is_empty() {
            let mut recent = self.recent_long_memories(limit, Some(scope_str))?;
            recent.reverse();
            let results: Vec<Value> = recent
                .into_iter()
                .map(|mut row| {
                    if let Some(obj) = row.as_object_mut() {
                        obj.insert("score".into(), json!(0));
                    }
                    row
                })
                .collect();
            self.bump_memory_usage(&results)?;
            return Ok(json!({ "ok": true, "mode": "recent", "results": results }));
        }
        if self.embedding().enabled() {
            let embedding = self.embedding();
            let vectors = embedding::embed_texts(&embedding, &[q.to_string()]).await?;
            let query_vec = vectors.into_iter().next().unwrap_or_default();
            if !query_vec.is_empty() {
                let semantic = self.semantic_search_long(scope_str, &query_vec, limit)?;
                if !semantic.is_empty() {
                    self.bump_memory_usage(&semantic)?;
                    return Ok(json!({
                        "ok": true,
                        "mode": "semantic",
                        "results": semantic,
                        "vectorSearch": true,
                    }));
                }
            }
        }
        let keyword = self.keyword_search_long(scope_str, q, limit)?;
        if !keyword.is_empty() {
            self.bump_memory_usage(&keyword)?;
            return Ok(json!({
                "ok": true,
                "mode": "keyword",
                "results": keyword,
            }));
        }
        Ok(json!({ "ok": true, "mode": "none", "results": [] }))
    }

    /// 召回即「用了一次」：`last_used_at` / `access_count` 的唯一写入点。
    ///
    /// 这两列此前只有读者没有写者，于是 `decay_long_memories` 里的
    /// `COALESCE(access_count, 0) = 0` 恒成立 ——「用过的记忆越用越牢」这条反馈闭环
    /// 实际不存在。召回成功后统一 bump，衰减只会碰真的没人再用的条目。
    fn bump_memory_usage(&self, rows: &[Value]) -> Result<(), CoreError> {
        let now = now_ms();
        let ids: Vec<i64> = rows
            .iter()
            .filter_map(|r| r.get("id").and_then(|v| v.as_i64()))
            .filter(|id| *id > 0)
            .collect();
        if ids.is_empty() {
            return Ok(());
        }
        // 「用了哪条记忆」是排序/修剪的提示信号，不是召回结果的一部分：
        // 拿不到写连接就跳过这一次，绝不为此让每轮的召回排在聊天落库后面
        // （实测差额见 `SqliteHandle::try_with_conn` 的注释）。
        let _ = self.db.try_with_conn(|conn| {
            let mut stmt = conn.prepare(
                "UPDATE long_memories
                 SET last_used_at = ?1, access_count = COALESCE(access_count, 0) + 1
                 WHERE id = ?2",
            )?;
            for id in &ids {
                stmt.execute(params![now, id])?;
            }
            Ok(())
        })?;
        Ok(())
    }

    fn count_active_long_memories(&self, scope: &str) -> Result<i64, CoreError> {
        let scope_filter = scope.trim();
        let sql = format!(
            "SELECT COUNT(*) FROM long_memories
             WHERE status IN ('active', 'stale')
               AND (expires_at IS NULL OR expires_at <= 0 OR expires_at > ?1)
               AND {}",
            long_memory_scope_filter("scope", scope_filter, 2)
        );
        // 只读计数，走读池：它和召回同一条路径，写在「写入连接」上会跟着排队
        self.read(|conn| {
            let now = now_ms();
            let n: i64 = if is_global_memory_scope(scope_filter) {
                conn.query_row(&sql, params![now], |r| r.get(0))?
            } else {
                conn.query_row(&sql, params![now, scope_filter], |r| r.get(0))?
            };
            Ok(n)
        })
    }

    /// 长记忆词法检索本体（**唯一**实现；scope 过滤与 JSON 组装由调用方各自负责）。
    ///
    /// 主路径是 FTS5 + `bm25`；排序口径与 `index/search.rs` 一致：**只用名次，不用分数
    /// 绝对值** —— bm25 的量纲随语料统计漂移、跨查询不可比。bm25 决定候选顺序，
    /// 重要度 / 新鲜度 / stale 惩罚只做同一查询内的微调（权重刻意小于一个名次位）。
    ///
    /// `scope == None` 表示不限 scope（记忆界面跨 scope 检索）。
    ///
    /// 分词器边界：`long_memories_fts` 用的是 trigram，只能索引 **≥3 字符** 的片段。
    /// 中文双字词（`索引` / `记忆`）因此没有可命中的 trigram，`MATCH` 必然空结果 ——
    /// 这类查询退回 `LIKE` 子串扫描（`long_memories` 行数由修剪策略封顶，扫描是有界的），
    /// 相关度记常量，排序由重要度 / 新鲜度决定。
    fn fts_search_long(
        &self,
        scope: Option<&str>,
        query: &str,
        limit: i64,
    ) -> Result<Vec<(f64, LongMemKeywordRow)>, CoreError> {
        let lim = limit.clamp(1, 50);
        let now = now_ms();
        if query.trim().is_empty() {
            return Ok(Vec::new());
        }
        let scope_trimmed = scope.map(str::trim);
        let (scope_sql, binds_scope) = match scope_trimmed {
            None => (String::new(), false),
            Some(s) => (
                format!("AND {}", long_memory_scope_filter("m.scope", s, 4)),
                !is_global_memory_scope(s),
            ),
        };
        let (sql, first_param) = if crate::fts::has_indexable_term(query) {
            let Some(match_q) = crate::fts::match_query(query) else {
                return Ok(Vec::new());
            };
            (
                format!(
                    "SELECT m.id, m.content, m.source, m.scope, m.kind, m.importance, m.status, m.created_at,
                            bm25(long_memories_fts) AS rank
                     FROM long_memories_fts
                     JOIN long_memories m ON m.id = long_memories_fts.rowid
                     WHERE long_memories_fts MATCH ?1
                       AND m.status IN ('active', 'stale')
                       AND (m.expires_at IS NULL OR m.expires_at <= 0 OR m.expires_at > ?2)
                       {scope_sql}
                     ORDER BY rank
                     LIMIT ?3"
                ),
                match_q,
            )
        } else {
            let pattern = like_pattern(query);
            (
                format!(
                    "SELECT m.id, m.content, m.source, m.scope, m.kind, m.importance, m.status, m.created_at,
                            -1.0 AS rank
                     FROM long_memories m
                     WHERE m.content LIKE ?1 ESCAPE '\\'
                       AND m.status IN ('active', 'stale')
                       AND (m.expires_at IS NULL OR m.expires_at <= 0 OR m.expires_at > ?2)
                       {scope_sql}
                     ORDER BY m.importance DESC, m.id DESC
                     LIMIT ?3"
                ),
                pattern,
            )
        };
        let mut args = vec![
            rusqlite::types::Value::Text(first_param),
            rusqlite::types::Value::Integer(now),
            rusqlite::types::Value::Integer(lim),
        ];
        if binds_scope {
            if let Some(s) = scope_trimmed {
                args.push(rusqlite::types::Value::Text(s.to_string()));
            }
        }
        // 读池：词法检索不该排在「聊天落库」的写连接后面。
        self.read(|conn| {
            let mut stmt = conn.prepare(&sql)?;
            let map = |row: &rusqlite::Row<'_>| -> rusqlite::Result<(LongMemKeywordRow, f64)> {
                Ok((map_long_mem_keyword_row(row)?, row.get(8)?))
            };
            let rows: Vec<(LongMemKeywordRow, f64)> = stmt
                .query_map(rusqlite::params_from_iter(args), map)?
                .collect::<Result<Vec<_>, _>>()?;
            let mut scored: Vec<(f64, LongMemKeywordRow)> = rows
                .into_iter()
                .map(|(row, rank)| {
                    let importance = row.5;
                    let status = row.6.as_str();
                    let created_at = row.7;
                    let relevance = -rank; // bm25 越相关越「负」，取反得到正相关度
                    let status_penalty = if status == "stale" { -0.15 } else { 0.0 };
                    let score = relevance
                        + (importance as f64) * 0.035
                        + freshness_score(now, created_at) * 0.08
                        + status_penalty;
                    (score, row)
                })
                .collect();
            scored.sort_by(|a, b| {
                b.0.partial_cmp(&a.0)
                    .unwrap_or(std::cmp::Ordering::Equal)
                    .then(b.1 .0.cmp(&a.1 .0))
            });
            Ok(scored)
        })
    }

    fn keyword_search_long(
        &self,
        scope: &str,
        query: &str,
        limit: i64,
    ) -> Result<Vec<Value>, CoreError> {
        let q = query.trim();
        if q.is_empty() {
            return Ok(Vec::new());
        }
        Ok(self
            .fts_search_long(Some(scope), q, limit)?
            .into_iter()
            .map(|(score, row)| {
                let (id, content, source, scope, kind, importance, status, created_at) = row;
                json!({
                    "id": id,
                    "content": content,
                    "source": source,
                    "createdAt": created_at,
                    "scope": scope,
                    "kind": kind,
                    "importance": importance,
                    "status": status,
                    "score": round_score(score),
                    "vectorSearch": false,
                })
            })
            .collect())
    }

    fn semantic_search_long(
        &self,
        scope: &str,
        query_vec: &[f32],
        limit: i64,
    ) -> Result<Vec<Value>, CoreError> {
        let embedding = self.embedding();
        let sig = embedding.signature();
        if sig.is_empty() {
            return Ok(Vec::new());
        }
        let sql = format!(
            "SELECT m.id, m.content, m.source, m.created_at, m.scope, m.kind, m.importance, m.status, v.vector, v.dimensions
             FROM long_memories m
             JOIN long_memory_vectors v ON v.memory_id = m.id
             WHERE m.status = 'active' AND {} AND v.model = ?1",
            long_memory_scope_filter("m.scope", scope, 2)
        );
        // 语义召回是纯读（全量余弦在 Rust 侧算），同样走读池
        self.read(|conn| {
            let mut scored: Vec<(f64, Value)> = Vec::new();
            let mut stmt = conn.prepare(&sql)?;
            let rows: Vec<LongMemSemanticRow> = if is_global_memory_scope(scope) {
                stmt.query_map(params![sig], map_long_mem_semantic_row)?
                    .collect::<Result<Vec<_>, _>>()?
            } else {
                stmt.query_map(params![scope, sig], map_long_mem_semantic_row)?
                    .collect::<Result<Vec<_>, _>>()?
            };
            for (id, content, source, created_at, scope, kind, importance, status, blob, dims) in rows {
                let Some(vec) = embedding::blob_to_vector(&blob, dims as usize) else {
                    continue;
                };
                let score = embedding::cosine_similarity(query_vec, &vec);
                // 与代码索引的向量池共用同一个下限（`embedding::MIN_SIMILARITY`），不各写一份
                if score <= embedding::MIN_SIMILARITY {
                    continue;
                }
                scored.push((
                    score,
                    json!({
                        "id": id,
                        "content": content,
                        "source": source,
                        "createdAt": created_at,
                        "scope": scope,
                        "kind": kind,
                        "importance": importance,
                        "status": status,
                        "score": score,
                        "vectorSearch": true,
                    }),
                ));
            }
            scored.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
            Ok(scored
                .into_iter()
                .take(limit as usize)
                .map(|(_, v)| v)
                .collect())
        })
    }
}

fn map_long_memory_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Value> {
    Ok(json!({
        "id": row.get::<_, i64>(0)?,
        "content": row.get::<_, String>(1)?,
        "source": row.get::<_, Option<String>>(2)?,
        "scope": row.get::<_, Option<String>>(3)?,
        "kind": row.get::<_, Option<String>>(4)?,
        "importance": row.get::<_, i64>(5)?,
        "status": row.get::<_, String>(6)?,
        "created_at": row.get::<_, i64>(7)?,
        "updated_at": row.get::<_, Option<i64>>(8)?,
        "last_used_at": row.get::<_, Option<i64>>(9)?,
        "access_count": row.get::<_, Option<i64>>(10)?,
    }))
}

fn detect_memory_kind(content: &str, requested: Option<&str>) -> String {
    if let Some(raw) = requested.map(str::trim).filter(|s| !s.is_empty()) {
        let lower = raw.to_lowercase();
        if ["normal", "private", "secret"].contains(&lower.as_str()) {
            return lower;
        }
    }
    if looks_secret(content) {
        return "secret".into();
    }
    if looks_private(content) {
        return "private".into();
    }
    "normal".into()
}

fn looks_secret(text: &str) -> bool {
    let lower = text.to_lowercase();
    lower.contains("api_key")
        || lower.contains("apikey")
        || lower.contains("password")
        || lower.contains("secret")
        || lower.contains("密码")
        || lower.contains("密钥")
        || (lower.contains("sk-") && lower.len() > 15)
}

fn looks_private(text: &str) -> bool {
    let lower = text.to_lowercase();
    lower.contains("手机号")
        || lower.contains("身份证")
        || lower.contains("邮箱")
        || lower.contains("database")
        || lower.contains("数据库")
        || lower.contains("host")
        || lower.contains("内网")
}

fn normalize_memory_status(status: &str) -> String {
    let s = status.trim().to_lowercase();
    if ["active", "stale", "archived", "deleted"].contains(&s.as_str()) {
        s
    } else {
        "active".into()
    }
}

fn normalize_importance(value: Option<i64>) -> i64 {
    value.unwrap_or(3).clamp(1, 5)
}

fn maybe_set_title_from_user_message(
    conn: &Connection,
    session_id: &str,
    content: &str,
) -> Result<(), CoreError> {
    let existing: Option<String> = conn
        .query_row(
            "SELECT title FROM sessions WHERE id = ?1",
            params![session_id],
            |row| row.get::<_, Option<String>>(0),
        )
        .optional()?
        .flatten();
    if let Some(title) = existing {
        let t = title.trim();
        if !t.is_empty()
            && t != "新对话"
            && t != "对话"
            && !t.starts_with("[计划]")
            && !title_needs_repair(Some(t))
        {
            return Ok(());
        }
    }
    let plain = strip_message_meta(content);
    if let Some(t) = title_from_user_content(plain) {
        conn.execute(
            "UPDATE sessions SET title = ?1, title_source = ?2 WHERE id = ?3",
            params![t, TITLE_SOURCE_HEURISTIC, session_id],
        )?;
    }
    Ok(())
}

/// 标题来源：`sessions.title_source` 的取值域。
///
/// - `heuristic`：首条用户消息切片（`title_from_user_content`），随时可被更好的标题替换；
/// - `ai`：模型总结出来的标题，每会话只生成一次（Node 侧据此决定是否再调模型）；
/// - `user`：用户手动改名，任何自动流程都不得覆盖。
pub(crate) const TITLE_SOURCE_HEURISTIC: &str = "heuristic";
pub(crate) const TITLE_SOURCE_AI: &str = "ai";
pub(crate) const TITLE_SOURCE_USER: &str = "user";

/// 标题来源只能由服务端枚举决定：写进来的是 SQL 列值，不能是任意字符串。
fn normalize_title_source(source: &str) -> Result<&'static str, CoreError> {
    match source.trim() {
        TITLE_SOURCE_AI => Ok(TITLE_SOURCE_AI),
        TITLE_SOURCE_USER => Ok(TITLE_SOURCE_USER),
        TITLE_SOURCE_HEURISTIC => Ok(TITLE_SOURCE_HEURISTIC),
        other => Err(CoreError::rpc(
            "INVALID_PARAMS",
            format!("未知的标题来源: {other}"),
        )),
    }
}

fn title_needs_repair(title: Option<&str>) -> bool {    match title.map(str::trim).filter(|s| !s.is_empty()) {
        None => true,
        Some("对话") | Some("新对话") => true,
        Some(t) if t.starts_with("【叠云meta】") => true,
        Some(t) if t.starts_with('{') && t.contains("inputText") => true,
        Some(_) => false,
    }
}

/// 落库消息的 meta 前缀：`【叠云meta】{json}\n<正文>`。
/// 与 JS `session-context.MESSAGE_META_PREFIX` 同口径（那里是唯一打包口）。
pub(crate) const MESSAGE_META_PREFIX: &str = "【叠云meta】";

/// 落库 meta 里单个字符串字段的长度上限，与 JS `session-context.META_STRING_MAX` 同口径。
///
/// 远高于任何合法元数据（路径 / 模型名 / 输入文本），远低于任何以字节形式混进来的
/// 内容 —— 一张 1MB 图片的 base64 就有约 145 万字符。
pub(crate) const MESSAGE_META_STRING_MAX: usize = 100_000;

/// 会话结束即失效的临时 URL：object URL 与 data URL 落库后都没有读者。
fn is_ephemeral_meta_string(s: &str) -> bool {
    let t = s.trim_start();
    t.starts_with("data:") || t.starts_with("blob:")
}

/// 递归清洗 meta 值：丢弃「字节形态」的字符串（超长 / data: / blob:）。
///
/// `messages.content` 的 meta 只该存引用与元数据。base64 之类的东西没有读者
/// （回传与渲染都只认路径），却让单行涨到 MB 级、每次开会话都要经 Gateway RPC
/// 搬进 Renderer 再 JSON.parse。
fn sanitize_meta_value(value: Value) -> Option<Value> {
    match value {
        Value::String(s) => {
            if s.len() > MESSAGE_META_STRING_MAX || is_ephemeral_meta_string(&s) {
                None
            } else {
                Some(Value::String(s))
            }
        }
        Value::Array(items) => Some(Value::Array(
            items.into_iter().filter_map(sanitize_meta_value).collect(),
        )),
        Value::Object(map) => Some(Value::Object(
            map.into_iter()
                .filter_map(|(k, v)| sanitize_meta_value(v).map(|v| (k, v)))
                .collect(),
        )),
        other => Some(other),
    }
}

/// 清洗一条待落库的消息内容；无需改动时返回 `None`。
///
/// 这是「meta 里不得出现字节」不变量的唯一咽喉：`append_message` 落库前必经这里，
/// 将来任何新调用点写错也进不了库。
pub(crate) fn sanitize_persisted_message(content: &str) -> Option<String> {
    let rest = content.strip_prefix(MESSAGE_META_PREFIX)?;
    let idx = rest.find('\n')?;
    let (meta_raw, body) = rest.split_at(idx);
    let meta: Value = serde_json::from_str(meta_raw).ok()?;
    let cleaned = sanitize_meta_value(meta)?;
    let cleaned_raw = serde_json::to_string(&cleaned).ok()?;
    if cleaned_raw == meta_raw {
        return None;
    }
    Some(format!("{MESSAGE_META_PREFIX}{cleaned_raw}{body}"))
}

pub(crate) fn strip_message_meta(content: &str) -> &str {
    let s = content.trim();
    if let Some(rest) = s.strip_prefix(MESSAGE_META_PREFIX) {
        if let Some(idx) = rest.find('\n') {
            return rest[idx + 1..].trim();
        }
        return rest.trim();
    }
    s
}

pub(crate) fn title_from_user_content(content: &str) -> Option<String> {
    let text = strip_message_meta(content);
    if text.is_empty() {
        return None;
    }
    for line in text.lines().map(str::trim).filter(|l| !l.is_empty()) {
        if line.starts_with("[计划 ·") && line.ends_with(']') {
            continue;
        }
        if line.contains('·') && line.contains("定时触发") {
            continue;
        }
        if let Some(t) = first_line_title(line) {
            return Some(t);
        }
    }
    first_line_title(text)
}

pub(crate) fn first_line_title(content: &str) -> Option<String> {
    let text = content.trim();
    if text.is_empty() {
        return None;
    }
    let first = text
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .unwrap_or(text);
    let normalized: String = first.split_whitespace().collect::<Vec<_>>().join(" ");
    let t = normalized.chars().take(48).collect::<String>();
    if t.is_empty() {
        None
    } else {
        Some(t)
    }
}

pub(crate) fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// 新鲜度（0..1，180 天线性衰减）：检索打分的**稳定**信号之一，与语料统计无关。
fn freshness_score(now: i64, created_at: i64) -> f64 {
    let age_ms = (now - created_at).max(0) as f64;
    let max_age = 180.0 * 24.0 * 60.0 * 60.0 * 1000.0;
    (1.0 - (age_ms / max_age).min(1.0)).max(0.0)
}

/// 围绕命中处截取摘录：模型要看到的是「哪一句」，不是整段历史。
///
/// 命中点前留四分之一上下文，其余给后半段；找不到命中片段时退回头部截断
/// （词法切分可能已经把查询改写成了子串，那不算错误）。
fn snippet_around(content: &str, query: &str, max_chars: usize) -> String {
    let total = content.chars().count();
    if total <= max_chars {
        return content.to_string();
    }
    let hit = crate::fts::first_hit_index(content, query).unwrap_or(0);
    let lead = max_chars / 4;
    let mut start = hit.saturating_sub(lead);
    let mut end = start + max_chars;
    if end > total {
        end = total;
        start = end.saturating_sub(max_chars);
    }
    let mut out: String = content.chars().skip(start).take(end - start).collect();
    if start > 0 {
        out.insert(0, '…');
    }
    if end < total {
        out.push('…');
    }
    out
}

/// `LIKE` 子串扫描的匹配模式：`%片段%`，转义用户输入里的 `%` / `_` / `\`。
fn like_pattern(query: &str) -> String {
    let mut out = String::with_capacity(query.len() + 2);
    out.push('%');
    for ch in query.trim().chars() {
        if matches!(ch, '%' | '_' | '\\') {
            out.push('\\');
        }
        out.push(ch);
    }
    out.push('%');
    out
}

/// 对外暴露的分数保留 3 位小数（展示 / 断言用，不参与排序）。
fn round_score(score: f64) -> f64 {
    (score * 1000.0).round() / 1000.0
}

fn rand_suffix() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let n = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.subsec_nanos())
        .unwrap_or(0);
    format!("{:x}", n)
}
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn title_from_packed_user_message() {
        let packed = "【叠云meta】{\"inputText\":\"写一个俄罗斯方块\"}\n写一个俄罗斯方块";
        assert_eq!(
            title_from_user_content(packed).as_deref(),
            Some("写一个俄罗斯方块")
        );
        assert!(title_needs_repair(Some("【叠云meta】{\"inputText\":\"x\"")));
    }

    /// 落库 meta 只该存引用：base64 / data URL 进不了库（append_message 是唯一写库口）。
    #[test]
    fn sanitize_persisted_message_strips_meta_bytes() {
        let huge = "A".repeat(MESSAGE_META_STRING_MAX + 1);
        let packed = format!(
            "【叠云meta】{{\"inputText\":\"看图\",\"attachments\":[{{\"path\":\"/tmp/a.png\",\"_pasteBase64\":\"{huge}\",\"previewUrl\":\"blob:http://x/1\"}}]}}\n看图"
        );
        let cleaned = sanitize_persisted_message(&packed).expect("脏 meta 应当被清洗");
        assert!(!cleaned.contains(&huge), "base64 必须被丢弃");
        assert!(!cleaned.contains("blob:"), "临时 URL 必须被丢弃");
        assert!(cleaned.contains("\"path\":\"/tmp/a.png\""), "附件引用保留");
        assert!(cleaned.ends_with("\n看图"), "正文不受影响");

        // 干净的 meta 与没有 meta 的正文都不该被改写。
        assert!(sanitize_persisted_message("【叠云meta】{\"inputText\":\"x\"}\nx").is_none());
        assert!(sanitize_persisted_message("裸正文").is_none());
    }

    /// 历史脏数据由修剪线程顺手洗掉，且不碰没有 meta 的超长正文。
    #[test]
    fn purge_oversized_message_meta_repairs_legacy_rows() {
        let conn = Connection::open_in_memory().expect("memory db");
        schema::init_schema(&conn).expect("schema");
        conn.execute(
            "INSERT INTO sessions (id, updated_at, title) VALUES ('s1', 1, 't')",
            [],
        )
        .expect("session");
        let huge = "A".repeat(MESSAGE_META_STRING_MAX + 1);
        let dirty = format!(
            "【叠云meta】{{\"inputText\":\"看图\",\"attachments\":[{{\"path\":\"/tmp/a.png\",\"_pasteBase64\":\"{huge}\"}}]}}\n看图"
        );
        let long_body = format!(
            "【叠云meta】{{\"inputText\":\"x\"}}\n{}",
            "长".repeat(MESSAGE_META_STRING_MAX + 10)
        );
        for content in [dirty.as_str(), long_body.as_str()] {
            conn.execute(
                "INSERT INTO messages (session_id, role, content, created_at) VALUES ('s1', 'assistant', ?1, 1)",
                params![content],
            )
            .expect("legacy row");
        }
        assert_eq!(
            MemoryStore::purge_oversized_message_meta(&conn).expect("purge"),
            1,
            "只洗 meta 里有字节的那条"
        );
        let washed: String = conn
            .query_row("SELECT content FROM messages ORDER BY id LIMIT 1", [], |row| {
                row.get(0)
            })
            .expect("row");
        assert!(!washed.contains(&huge) && washed.ends_with("\n看图"));
        let untouched: String = conn
            .query_row(
                "SELECT content FROM messages ORDER BY id DESC LIMIT 1",
                [],
                |row| row.get(0),
            )
            .expect("row");
        assert_eq!(untouched, long_body, "无 meta 大正文原样保留");
    }

    /// 显式标题（AI 总结）必须盖得住启发式标题，并把来源记成 `ai` ——
    /// Node 侧靠这一列判断「这个会话已经有过模型标题，别再调一次模型」。
    #[test]
    fn set_session_title_overrides_heuristic_and_records_source() {
        let db = std::env::temp_dir().join(format!("dieyun-title-test-{}.sqlite", now_ms()));
        let _ = std::fs::remove_file(&db);
        let store = MemoryStore::open(db.clone(), EmbeddingConfig::default()).unwrap();
        let session = store.create_session(None, None).unwrap();
        store
            .append_message(&session.id, "user", "帮我修一下这个 bug", None)
            .unwrap();

        // 启发式标题先落库（首条用户消息切片）
        let row = store.get_session(&session.id).unwrap().unwrap();
        assert_eq!(row.title.as_deref(), Some("帮我修一下这个 bug"));
        assert_eq!(row.title_source.as_deref(), Some(TITLE_SOURCE_HEURISTIC));

        // 模型标题无条件覆盖
        let out = store
            .set_session_title(&session.id, "  修复登录崩溃\n多余的第二行  ", TITLE_SOURCE_AI)
            .unwrap();
        assert_eq!(out["updated"].as_i64(), Some(1));
        let row = store.get_session(&session.id).unwrap().unwrap();
        assert_eq!(row.title.as_deref(), Some("修复登录崩溃"), "只留首行并折叠空白");
        assert_eq!(row.title_source.as_deref(), Some(TITLE_SOURCE_AI));

        // 已有 ai 标题后，后续用户轮次的启发式写入不得覆盖它
        store
            .append_message(&session.id, "user", "再改一处", None)
            .unwrap();
        let row = store.get_session(&session.id).unwrap().unwrap();
        assert_eq!(row.title.as_deref(), Some("修复登录崩溃"));

        // 空标题 / 未知来源都拒绝，且不弄脏现有标题
        assert!(store.set_session_title(&session.id, "   ", TITLE_SOURCE_AI).is_err());
        assert!(store
            .set_session_title(&session.id, "x", "robot")
            .is_err());
        assert!(store.set_session_title("", "x", TITLE_SOURCE_AI).is_err());
        let row = store.get_session(&session.id).unwrap().unwrap();
        assert_eq!(row.title.as_deref(), Some("修复登录崩溃"));

        let _ = std::fs::remove_file(&db);
    }

    /// 往不存在的会话写消息要给稳定错误码，而不是把 SQLite 的外键串抛给界面
    /// （peer 会话链接过期时，用户看到的就是「发送失败 · FOREIGN KEY constraint failed」）。
    #[test]
    fn append_message_reports_missing_session() {
        let db = std::env::temp_dir().join(format!("dieyun-append-missing-{}.sqlite", now_ms()));
        let _ = std::fs::remove_file(&db);
        let store = MemoryStore::open(db.clone(), EmbeddingConfig::default()).unwrap();
        let session = store.create_session(None, None).unwrap();
        store
            .append_message(&session.id, "user", "在的会话", None)
            .unwrap();

        let err = store
            .append_message("s-does-not-exist", "user", "写不进去", None)
            .unwrap_err();
        match err {
            CoreError::Rpc { code, .. } => assert_eq!(code, "SESSION_NOT_FOUND"),
            other => panic!("应给出 SESSION_NOT_FOUND，实际: {other:?}"),
        }

        let _ = std::fs::remove_file(&db);
    }

    #[test]
    fn handoff_roundtrip_and_latest() {        let db = std::env::temp_dir().join(format!("dieyun-handoff-test-{}.sqlite", now_ms()));
        let _ = std::fs::remove_file(&db);
        let store = MemoryStore::open(db.clone(), EmbeddingConfig::default()).unwrap();
        let a = store.create_session(Some("会话A"), None).unwrap();
        let b = store
            .create_session(Some("会话B"), Some("ssh://dieyunx@192.168.31.62/srv/repo"))
            .unwrap();

        // 空载荷拒绝
        assert!(store.handoff_save(&a.id, "t", "   ").is_err());

        store.handoff_save(&a.id, "会话A", "目标：做X\n未完成：Y").unwrap();
        std::thread::sleep(std::time::Duration::from_millis(5));
        store.handoff_save(&b.id, "会话B", "目标：做P").unwrap();

        // 精确取回
        let got = store.handoff_get(&a.id).unwrap().expect("a 的交接");
        assert_eq!(got["payload"].as_str().unwrap(), "目标：做X\n未完成：Y");
        assert_eq!(got["title"].as_str().unwrap(), "会话A");

        // latest：排除当前会话后取最新
        let latest = store.handoff_latest(Some(&b.id)).unwrap().expect("应取到 A");
        assert_eq!(latest["sessionId"].as_str().unwrap(), a.id);
        let latest_all = store.handoff_latest(None).unwrap().expect("应取到 B");
        assert_eq!(latest_all["sessionId"].as_str().unwrap(), b.id);
        // 交接带着来源会话的工作区：跨项目「继续上次」靠它挂到正确的仓库
        assert_eq!(
            latest_all["workspacePath"].as_str().unwrap(),
            "ssh://dieyunx@192.168.31.62/srv/repo"
        );
        assert!(got["workspacePath"].is_null());

        // 同会话重生成 → 覆盖（每会话最多一份）
        store.handoff_save(&a.id, "会话A", "更新后的交接").unwrap();
        let got2 = store.handoff_get(&a.id).unwrap().unwrap();
        assert_eq!(got2["payload"].as_str().unwrap(), "更新后的交接");

        let _ = std::fs::remove_file(&db);
    }

    #[test]
    fn memory_roundtrip() {
        let db = std::env::temp_dir().join(format!("dieyun-mem-test-{}.sqlite", now_ms()));
        let _ = std::fs::remove_file(&db);
        let store = MemoryStore::open(db.clone(), EmbeddingConfig::default()).unwrap();
        let session = store.create_session(Some("测试"), None).unwrap();
        store
            .append_message(&session.id, "user", "你好，Rust memory", None)
            .unwrap();
        store
            .append_message(
                &session.id,
                "assistant",
                "答复正文",
                Some("  这是该轮真思考  "),
            )
            .unwrap();
        // 空串与空白按「无」处理，统一落 NULL。
        store
            .append_message(&session.id, "assistant", "无思考轮", Some("   "))
            .unwrap();
        let msgs = store.recent_messages(&session.id, 10).unwrap();
        assert_eq!(msgs.len(), 3);
        assert_eq!(msgs[0].role, "user");
        assert_eq!(msgs[0].reasoning, None);
        assert_eq!(msgs[1].reasoning.as_deref(), Some("这是该轮真思考"));
        assert_eq!(msgs[2].reasoning, None);
        let _ = std::fs::remove_file(db);
    }

    #[test]
    fn recall_bumps_usage_counters() {
        // `access_count` / `last_used_at` 此前只有读者没有写者，衰减里的
        // `COALESCE(access_count, 0) = 0` 于是恒成立。这里锁住唯一写入口的行为。
        let db = std::env::temp_dir().join(format!("dieyun-mem-usage-{}.sqlite", now_ms()));
        let _ = std::fs::remove_file(&db);
        let store = MemoryStore::open(db.clone(), EmbeddingConfig::default()).unwrap();
        store
            .add_long_memory(
                "用户偏好中文回复并给出简短结论",
                "user",
                None,
                Some("global"),
                Some(3),
                None,
                None,
                None,
            )
            .unwrap();
        let before = store.recent_long_memories(5, Some("global")).unwrap();
        assert_eq!(before.len(), 1);
        assert_eq!(before[0]["access_count"].as_i64().unwrap_or(0), 0);
        assert!(before[0]["last_used_at"].is_null());
        // 召回结果就是这些行：bump 一下等价于「这条被用过」
        store.bump_memory_usage(&before).unwrap();
        store.bump_memory_usage(&before).unwrap();
        let after = store.recent_long_memories(5, Some("global")).unwrap();
        assert_eq!(after[0]["access_count"].as_i64().unwrap(), 2);
        assert!(after[0]["last_used_at"].as_i64().unwrap() > 0);
        // 空白输入不该触发任何写入
        store.bump_memory_usage(&[]).unwrap();
        let _ = std::fs::remove_file(db);
    }

    #[test]
    fn session_memories_are_traceable_and_forgettable() {
        // 归纳器写的记忆是项目级/用户级的，库里原本没有任何「哪个会话写的」的痕迹：
        // 这里锁住唯一写入口（session_id）与两个会话维度查询/归档的行为。
        let db = std::env::temp_dir().join(format!("dieyun-mem-session-{}.sqlite", now_ms()));
        let _ = std::fs::remove_file(&db);
        let store = MemoryStore::open(db.clone(), EmbeddingConfig::default()).unwrap();
        store
            .add_long_memory(
                "本次会话决定用 JWT 而不是 session cookie",
                "auto_consolidation",
                None,
                Some("project:/ws/a"),
                Some(3),
                None,
                None,
                Some("sess-a"),
            )
            .unwrap();
        store
            .add_long_memory(
                "另一个会话的独立结论",
                "auto_consolidation",
                None,
                Some("project:/ws/a"),
                Some(3),
                None,
                None,
                Some("sess-b"),
            )
            .unwrap();
        // 无 session 的历史写入口径必须仍然可用（NULL 不算任何会话）
        store
            .add_long_memory("旧记忆没有会话来源", "user", None, Some("global"), Some(3), None, None, None)
            .unwrap();

        let a = store.long_memories_by_session("sess-a", 20).unwrap();
        assert_eq!(a.len(), 1);
        assert!(a[0]["content"].as_str().unwrap().contains("JWT"));
        assert_eq!(store.long_memories_by_session("sess-b", 20).unwrap().len(), 1);
        assert!(store.long_memories_by_session("  ", 20).unwrap().is_empty());

        // 软归档：只影响该会话的条目，可恢复
        assert_eq!(store.archive_long_memories_by_session("sess-a").unwrap(), 1);
        assert!(store.long_memories_by_session("sess-a", 20).unwrap().is_empty());
        assert_eq!(store.long_memories_by_session("sess-b", 20).unwrap().len(), 1);
        assert_eq!(store.archive_long_memories_by_session("sess-a").unwrap(), 0);
        assert!(store.recent_long_memories(10, Some("global")).unwrap().len() >= 1);

        // 同内容再次写入会复活既有行，并把来源会话补上（COALESCE 不覆盖旧来源）
        store
            .add_long_memory(
                "另一个会话的独立结论",
                "auto_consolidation",
                None,
                Some("project:/ws/a"),
                Some(3),
                None,
                None,
                Some("sess-c"),
            )
            .unwrap();
        assert_eq!(store.long_memories_by_session("sess-c", 20).unwrap().len(), 0);
        assert_eq!(store.long_memories_by_session("sess-b", 20).unwrap().len(), 1);
        let _ = std::fs::remove_file(db);
    }

    #[tokio::test]
    async fn write_policy_gates_low_value_and_exact_duplicates() {
        // 写入策略（唯一政策点）：自动归纳的低价值条目不落库；显式写入不受此闸；
        // 完全相同的正文仍然只留一行（近重复判定需要 embedding，测试环境无向量能力，走 none 分支）。
        let db = std::env::temp_dir().join(format!("dieyun-mem-policy-{}.sqlite", now_ms()));
        let _ = std::fs::remove_file(&db);
        let store = MemoryStore::open(db.clone(), EmbeddingConfig::default()).unwrap();

        let skipped = store
            .add_long_memory_deduped(
                "顺手打开了个网页",
                "auto_consolidation",
                None,
                Some("global"),
                Some(2),
                None,
                None,
                Some("sess-1"),
            )
            .await
            .unwrap();
        assert_eq!(skipped.get("skipped").and_then(|v| v.as_str()), Some("low_importance"));
        assert_eq!(store.recent_long_memories(10, Some("global")).unwrap().len(), 0);

        // 显式写入（非 consolidation）即使 importance=1 也要落库：用户说过的就是事实
        let kept = store
            .add_long_memory_deduped(
                "我的猫叫咪咪",
                "user",
                None,
                Some("global"),
                Some(1),
                None,
                None,
                Some("sess-1"),
            )
            .await
            .unwrap();
        assert_eq!(kept.get("skipped"), None);
        assert!(kept.get("localMemoryId").and_then(|v| v.as_i64()).unwrap_or(0) > 0);
        assert_eq!(store.recent_long_memories(10, Some("global")).unwrap().len(), 1);

        // 归纳器写 importance=3 通过闸门
        let ok = store
            .add_long_memory_deduped(
                "camera 模块导出统一走 runtime 配置",
                "auto_consolidation",
                None,
                Some("global"),
                Some(3),
                None,
                None,
                Some("sess-2"),
            )
            .await
            .unwrap();
        assert_eq!(ok.get("skipped"), None);
        assert_eq!(store.recent_long_memories(10, Some("global")).unwrap().len(), 2);

        // 正文完全相同 → 复用既有行，不再新增
        let dup = store
            .add_long_memory_deduped(
                "camera 模块导出统一走 runtime 配置",
                "auto_consolidation",
                None,
                Some("global"),
                Some(3),
                None,
                None,
                Some("sess-3"),
            )
            .await
            .unwrap();
        assert_eq!(dup.get("duplicate"), Some(&Value::Bool(true)));
        assert_eq!(store.recent_long_memories(10, Some("global")).unwrap().len(), 2);
        let _ = std::fs::remove_file(db);
    }

    #[test]
    fn reconcile_rekeys_legacy_path_scopes_to_project_ids() {
        // 老库的 scope 是路径字符串。projects 表登记了根路径后，能正向复算出这些历史 key，
        // 于是整批重挂到 project:<id>（而不是把可认领的行当孤儿埋掉）。
        let db = std::env::temp_dir().join(format!("dieyun-mem-rescope-{}.sqlite", now_ms()));
        let _ = std::fs::remove_file(&db);
        let store = MemoryStore::open(db.clone(), EmbeddingConfig::default()).unwrap();

        let root = "E:\\repo\\legacyproj";
        let proj = store.resolve_project(root, None).unwrap();
        let id = proj.get("projectId").and_then(|v| v.as_i64()).unwrap();
        let legacy = super::projects::legacy_scope_key(root);
        assert!(legacy.starts_with("project:E:\\repo"), "短路径用原路径形态");

        for (content, scope) in [
            ("老行 1", legacy.as_str()),
            ("老行 2", legacy.as_str()),
            ("认领不了的行", "project:E:\\gone\\nowhere"),
        ] {
            store
                .test_conn()
                .execute(
                    "INSERT INTO long_memories (content, source, scope, kind, importance, status, created_at)
                     VALUES (?1, 'auto_consolidation', ?2, 'normal', 3, 'active', ?3)",
                    params![content, scope, now_ms()],
                )
                .unwrap();
        }

        let res = store.reconcile_memory_ledger(now_ms()).unwrap();
        assert_eq!(res.get("rescopedMemories").and_then(|v| v.as_i64()), Some(2));

        let rescoped: i64 = store
            .test_conn()
            .query_row(
                "SELECT COUNT(*) FROM long_memories WHERE scope = ?1",
                params![format!("project:{id}")],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(rescoped, 2, "两条老行都挂到了 project:<id>");
        let untouched: i64 = store
            .test_conn()
            .query_row(
                "SELECT COUNT(*) FROM long_memories WHERE scope = 'project:E:\\gone\\nowhere' AND status = 'active'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(untouched, 1, "认领不了的行不动它（不猜、不删）");

        // 幂等：再跑一次不再改
        let again = store.reconcile_memory_ledger(now_ms()).unwrap();
        assert_eq!(again.get("rescopedMemories").and_then(|v| v.as_i64()), Some(0));

        let _ = std::fs::remove_file(db);
    }

    #[test]
    fn reconcile_heals_orphan_scope_and_dangling_jobs() {
        // 两条都是「进程没跑完」留下的脏数据：孤儿 scope='project' 永远召回不到，
        // 悬空 pending 作业让账本永远显示「还在跑」。自愈必须幂等且不动新鲜作业。
        let db = std::env::temp_dir().join(format!("dieyun-mem-reconcile-{}.sqlite", now_ms()));
        let _ = std::fs::remove_file(&db);
        let store = MemoryStore::open(db.clone(), EmbeddingConfig::default()).unwrap();

        // 旧版本按路径算 scope 失败留下的字面量 project
        store
            .test_conn()
            .execute(
                "INSERT INTO long_memories (content, source, scope, kind, importance, status, created_at)
                 VALUES ('孤儿项目记忆', 'auto_consolidation', 'project', 'normal', 3, 'active', ?1)",
                params![now_ms()],
            )
            .unwrap();
        let stale = store.create_consolidation_job(Some("global"), Some("task"), None).unwrap();
        let stale_id = stale.get("jobId").and_then(|v| v.as_i64()).unwrap();
        let fresh = store.create_consolidation_job(Some("global"), Some("task"), None).unwrap();
        let fresh_id = fresh.get("jobId").and_then(|v| v.as_i64()).unwrap();
        store
            .test_conn()
            .execute(
                "UPDATE memory_consolidation_jobs SET started_at = ?1 WHERE id = ?2",
                params![now_ms() - 60 * 60 * 1000, stale_id],
            )
            .unwrap();

        let res = store.reconcile_memory_ledger(now_ms()).unwrap();
        assert_eq!(res.get("orphanScopes").and_then(|v| v.as_i64()), Some(1));
        assert_eq!(res.get("staleJobs").and_then(|v| v.as_i64()), Some(1));

        let orphan_status: String = store
            .test_conn()
            .query_row(
                "SELECT status FROM long_memories WHERE scope = 'project'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(orphan_status, "archived");
        let stale_status: String = store
            .test_conn()
            .query_row(
                "SELECT status FROM memory_consolidation_jobs WHERE id = ?1",
                params![stale_id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(stale_status, "failed");
        let fresh_status: String = store
            .test_conn()
            .query_row(
                "SELECT status FROM memory_consolidation_jobs WHERE id = ?1",
                params![fresh_id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(fresh_status, "pending", "新鲜作业不能被自愈判死");

        // 幂等：再跑一次什么都不改
        let again = store.reconcile_memory_ledger(now_ms()).unwrap();
        assert_eq!(again.get("orphanScopes").and_then(|v| v.as_i64()), Some(0));
        assert_eq!(again.get("staleJobs").and_then(|v| v.as_i64()), Some(0));
        let _ = std::fs::remove_file(db);
    }

    #[test]
    fn project_identity_survives_rename_case_and_worktree_paths() {
        // 老实现把路径编进 scope：改目录名 / 大小写差异 / 换盘符都会变成「另一个项目」，
        // 之前沉淀的记忆静默失联。而且同一个 git remote 的新路径应该自动成为别名。
        let db = std::env::temp_dir().join(format!("dieyun-mem-projects-{}.sqlite", now_ms()));
        let _ = std::fs::remove_file(&db);
        let store = MemoryStore::open(db.clone(), EmbeddingConfig::default()).unwrap();

        let a = store
            .resolve_project(
                "E:\\repo\\dieyunagent",
                Some("github.com/acme/dieyunagent"),
            )
            .unwrap();
        let id = a.get("projectId").and_then(|v| v.as_i64()).unwrap();
        assert_eq!(a.get("scope").and_then(|v| v.as_str()), Some(format!("project:{id}").as_str()));
        assert_eq!(a.get("aliased").and_then(|v| v.as_bool()), Some(false));

        // 大小写 / 斜杠 / 尾分隔符差异 → 同一个 project（不新建）
        for same in ["e:/repo/dieyunagent/", "E:\\repo\\DIEYUNAGENT", "e:\\repo\\dieyunagent"] {
            let r = store
                .resolve_project(same, Some("github.com/acme/dieyunagent"))
                .unwrap();
            assert_eq!(
                r.get("projectId").and_then(|v| v.as_i64()),
                Some(id),
                "同一路径的不同写法必须解析到同一个 project：{same}"
            );
        }

        // 仓库搬家（换盘符）：git origin 相同 → 自动挂成别名，记忆跟着走
        let moved = store
            .resolve_project("D:\\work\\dieyunagent", Some("github.com/acme/dieyunagent"))
            .unwrap();
        assert_eq!(moved.get("projectId").and_then(|v| v.as_i64()), Some(id));
        assert_eq!(moved.get("aliased").and_then(|v| v.as_bool()), Some(true));

        // 没有 remote 的本地仓库：手动挂别名（`memory.project_alias_add`）
        let local = store.resolve_project("E:\\scratch\\app", None).unwrap();
        let local_id = local.get("projectId").and_then(|v| v.as_i64()).unwrap();
        assert_ne!(local_id, id, "无 remote 的不同路径是不同项目");
        store.add_project_alias(local_id, "E:\\scratch\\app-old").unwrap();
        let aliased = store.resolve_project("E:\\scratch\\app-old", None).unwrap();
        assert_eq!(aliased.get("projectId").and_then(|v| v.as_i64()), Some(local_id));

        // 清单：路径别名条数如实反映
        let list = store.list_projects(10).unwrap();
        let rows = list.get("results").and_then(|v| v.as_array()).unwrap();
        assert_eq!(rows.len(), 2);
        let first = rows
            .iter()
            .find(|r| r.get("projectId").and_then(|v| v.as_i64()) == Some(id))
            .expect("第一个项目应在清单里");
        assert_eq!(first.get("pathCount").and_then(|v| v.as_i64()), Some(2));

        let _ = std::fs::remove_file(db);
    }

    #[test]
    fn prunes_finished_runs_and_cascades_children() {
        let db = std::env::temp_dir().join(format!("dieyun-prune-runs-{}.sqlite", now_ms()));
        let _ = std::fs::remove_file(&db);
        let store = MemoryStore::open(db.clone(), EmbeddingConfig::default()).unwrap();
        let session = store.create_session(Some("修剪"), None).unwrap();

        for i in 0..3 {
            let run_id = format!("run-done-{i}");
            store
                .upsert_agent_run(&json!({
                    "id": run_id,
                    "sessionId": session.id,
                    "status": "completed",
                }))
                .unwrap();
            store
                .save_agent_trace(&json!({
                    "runId": run_id,
                    "sessionId": session.id,
                    "status": "completed",
                    "trace": [{ "type": "text", "content": "x" }],
                }))
                .unwrap();
        }
        // 非终态的 run 必须原样保留：running 进行中，planned 是 planner 中间态。
        for run_id in ["run-live", "run-planned"] {
            let status = if run_id == "run-live" {
                "running"
            } else {
                "planned"
            };
            store
                .upsert_agent_run(&json!({
                    "id": run_id,
                    "sessionId": session.id,
                    "status": status,
                }))
                .unwrap();
        }

        let policy = PrunePolicy {
            runs_keep_recent: 1,
            // 关掉时间窗口，只验证「保留最近 N 条」这条路径
            run_max_age_ms: i64::MAX / 2,
            ..PrunePolicy::default()
        };
        let guard = store.test_conn();
        let deleted = MemoryStore::prune_finished_agent_runs(&guard, &policy).unwrap();
        assert_eq!(deleted, 2, "应删掉 2 个超出保留窗口的终态 run");
        let runs: i64 = guard
            .query_row("SELECT COUNT(*) FROM agent_runs", [], |r| r.get(0))
            .unwrap();
        assert_eq!(runs, 3, "保留 1 个终态 + running + planned");
        let traces: i64 = guard
            .query_row("SELECT COUNT(*) FROM agent_traces", [], |r| r.get(0))
            .unwrap();
        assert_eq!(traces, 1, "agent_traces 应随 run 级联删除");
        drop(guard);
        let _ = std::fs::remove_file(db);
    }

    #[test]
    fn prunes_surplus_traces_per_run() {
        let db = std::env::temp_dir().join(format!("dieyun-prune-traces-{}.sqlite", now_ms()));
        let _ = std::fs::remove_file(&db);
        let store = MemoryStore::open(db.clone(), EmbeddingConfig::default()).unwrap();
        let session = store.create_session(Some("修剪"), None).unwrap();
        store
            .upsert_agent_run(&json!({
                "id": "run-1",
                "sessionId": session.id,
                "status": "running",
            }))
            .unwrap();
        // 新写入已是原地覆盖，这里直接造出「老库」形态（同一 run 堆多份 checkpoint）
        // 来验证裁剪逻辑本身。
        {
            let guard = store.test_conn();
            for i in 0..5 {
                guard
                    .execute(
                        "INSERT INTO agent_traces
                           (run_id, session_id, message_id, phase, trace_json, created_at)
                         VALUES ('run-1', ?1, NULL, 'assistant', ?2, ?3)",
                        params![
                            session.id,
                            json!([{ "type": "text", "content": i.to_string() }]).to_string(),
                            now_ms()
                        ],
                    )
                    .unwrap();
            }
        }

        let policy = PrunePolicy {
            traces_trigger: 1,
            traces_per_run: 2,
            ..PrunePolicy::default()
        };
        let guard = store.test_conn();
        let deleted = MemoryStore::prune_surplus_agent_traces(&guard, &policy).unwrap();
        assert_eq!(deleted, 3, "5 条只留 2 条");
        drop(guard);

        let remaining: i64 = {
            let guard = store.test_conn();
            guard
                .query_row("SELECT COUNT(*) FROM agent_traces", [], |r| r.get(0))
                .unwrap()
        };
        assert_eq!(remaining, 2);
        // 唯一读取路径（runId + LIMIT 1）拿到的必须仍是最新那次 checkpoint。
        let row = store
            .get_agent_trace(&json!({ "runId": "run-1" }))
            .unwrap()
            .unwrap();
        let content = row
            .get("trace")
            .and_then(|v| v.as_array())
            .and_then(|a| a.first())
            .and_then(|v| v.get("content"))
            .and_then(|v| v.as_str());
        assert_eq!(content, Some("4"));
        let _ = std::fs::remove_file(db);
    }

    #[test]
    fn merges_incremental_trace_checkpoints() {
        let db = std::env::temp_dir().join(format!("dieyun-trace-delta-{}.sqlite", now_ms()));
        let _ = std::fs::remove_file(&db);
        let store = MemoryStore::open(db.clone(), EmbeddingConfig::default()).unwrap();
        let session = store.create_session(Some("增量"), None).unwrap();

        // 首帧是全量：客户端游标为空，traceFrom 缺省为 0。
        store
            .save_agent_trace(&json!({
                "runId": "run-delta",
                "sessionId": session.id,
                "status": "running",
                "trace": [
                    { "type": "round", "thought": "A" },
                    { "type": "round", "thought": "B" }
                ],
            }))
            .unwrap();

        // 增量帧：客户端只重发「会变的尾部」+ 新增条目，从第 1 条起拼。
        let res = store
            .save_agent_trace(&json!({
                "runId": "run-delta",
                "sessionId": session.id,
                "status": "running",
                "traceFrom": 1,
                "trace": [
                    { "type": "round", "thought": "B2" },
                    { "type": "round", "thought": "C" }
                ],
            }))
            .unwrap();
        assert!(res.get("stale").is_none(), "游标合法时不该回 stale");
        let row = store
            .get_agent_trace(&json!({ "runId": "run-delta" }))
            .unwrap()
            .unwrap();
        let thoughts = |row: &Value| -> Vec<String> {
            row.get("trace")
                .and_then(|v| v.as_array())
                .map(|rows| {
                    rows.iter()
                        .filter_map(|r| r.get("thought").and_then(|v| v.as_str()))
                        .map(str::to_string)
                        .collect()
                })
                .unwrap_or_default()
        };
        assert_eq!(
            thoughts(&row),
            vec!["A", "B2", "C"],
            "前缀按 traceFrom 保留 + 尾部覆盖 + 新增追加"
        );
        // §3.7 D4：`traceText`（思考拼成的纯文本）已整体废除 —— 跨边界可回读的只有结构化 trace，
        // 出参里不得再出现该字段。
        assert!(
            row.get("traceText").is_none(),
            "get_agent_trace 不再出 traceText"
        );

        // 旧客户端仍可能带 traceText：必须被忽略，且不影响 trace 增量语义。
        store
            .save_agent_trace(&json!({
                "runId": "run-delta",
                "sessionId": session.id,
                "status": "running",
                "traceText": "A / B2 / C2",
                "trace": [
                    { "type": "round", "thought": "A" },
                    { "type": "round", "thought": "B2" },
                    { "type": "round", "thought": "C2" }
                ],
            }))
            .unwrap();
        store
            .save_agent_trace(&json!({
                "runId": "run-delta",
                "sessionId": session.id,
                "status": "running",
                "traceFrom": 2,
                "trace": [{ "type": "round", "thought": "C3" }],
            }))
            .unwrap();
        let row = store
            .get_agent_trace(&json!({ "runId": "run-delta" }))
            .unwrap()
            .unwrap();
        assert_eq!(thoughts(&row), vec!["A", "B2", "C3"]);
        assert!(
            row.get("traceText").is_none(),
            "legacy traceText 入参被忽略，出参不带该字段"
        );

        // 游标过期（traceFrom 超出已存条数）必须拒写并回 stale，绝不能落成半截快照。
        let res = store
            .save_agent_trace(&json!({
                "runId": "run-delta",
                "sessionId": session.id,
                "status": "running",
                "traceFrom": 99,
                "trace": [{ "type": "round", "thought": "X" }],
            }))
            .unwrap();
        assert_eq!(res.get("stale").and_then(|v| v.as_bool()), Some(true));
        let row = store
            .get_agent_trace(&json!({ "runId": "run-delta" }))
            .unwrap()
            .unwrap();
        assert_eq!(thoughts(&row), vec!["A", "B2", "C3"], "stale 时不改已存快照");
        let _ = std::fs::remove_file(db);
    }

    // ---- 长记忆词法检索（FTS5 + bm25，取代手写 CJK 打分）----

    fn seed_memory(store: &MemoryStore, content: &str, source: &str, age_days: i64) {
        let created = now_ms() - age_days * 24 * 60 * 60 * 1000;
        store
            .test_conn()
            .execute(
                "INSERT INTO long_memories
                   (content, source, scope, kind, importance, status, created_at, updated_at)
                 VALUES (?1, ?2, 'global', 'normal', 3, 'active', ?3, ?3)",
                params![content, source, created],
            )
            .expect("seed long memory");
    }

    /// 中文子串与标识符子串都要召回：trigram 分词器的语义就是子串命中。
    #[test]
    fn fts_search_hits_cjk_and_identifier_substrings() {
        let db = std::env::temp_dir().join(format!("dieyun-fts-hit-{}.sqlite", now_ms()));
        let _ = std::fs::remove_file(&db);
        let store = MemoryStore::open(db.clone(), EmbeddingConfig::default()).unwrap();
        seed_memory(&store, "代码库索引的增量更新逻辑走 root_hash 比对", "codebase", 1);
        seed_memory(&store, "fn parseConfig(path: &str) 读取配置", "src/config.rs", 1);
        seed_memory(&store, "用户偏好：回答用中文，少用列表", "chat", 1);

        let cjk = store.keyword_search_long_memories("索引", 5).unwrap();
        let cjk_contents = json_strings(&cjk, "results", "content");
        assert_eq!(cjk_contents.len(), 1, "中文子串应精确命中一条：{cjk}");
        assert!(cjk_contents[0].contains("增量更新"));

        // trigram 让「标识符中间一段」也能召回（unicode61 分词器做不到）
        let ident = store.keyword_search_long_memories("onfig", 5).unwrap();
        assert_eq!(
            json_strings(&ident, "results", "content"),
            vec!["fn parseConfig(path: &str) 读取配置".to_string()],
            "标识符子串应命中：{ident}"
        );

        assert!(
            store
                .keyword_search_long_memories("不存在的词", 5)
                .unwrap()
                .get("results")
                .and_then(|v| v.as_array())
                .map(|a| a.is_empty())
                .unwrap_or(false),
            "无命中应返回空数组"
        );
        let _ = std::fs::remove_file(db);
    }

    /// 旧实现 `ORDER BY id DESC LIMIT 1000` 只能看到最近 1000 行；FTS 没有这个窗口。
    #[test]
    fn fts_search_sees_memories_beyond_the_old_1000_row_window() {
        let db = std::env::temp_dir().join(format!("dieyun-fts-window-{}.sqlite", now_ms()));
        let _ = std::fs::remove_file(&db);
        let store = MemoryStore::open(db.clone(), EmbeddingConfig::default()).unwrap();
        // 最老的一条是唯一命中项，后面再压 1200 条噪声
        seed_memory(&store, "早期决定：向量检索先用精确余弦，不接 ANN", "design", 30);
        {
            let conn = store.test_conn();
            conn.execute_batch("BEGIN;").unwrap();
            for i in 0..1200 {
                conn.execute(
                    "INSERT INTO long_memories
                       (content, source, scope, kind, importance, status, created_at, updated_at)
                     VALUES (?1, 'noise', 'global', 'normal', 3, 'active', ?2, ?2)",
                    params![format!("噪声记录 {i}"), now_ms()],
                )
                .unwrap();
            }
            conn.execute_batch("COMMIT;").unwrap();
        }

        let hits = store.keyword_search_long_memories("ANN", 5).unwrap();
        assert_eq!(
            json_strings(&hits, "results", "content"),
            vec!["早期决定：向量检索先用精确余弦，不接 ANN".to_string()],
            "窗口外的那条必须能检索到：{hits}"
        );
        let _ = std::fs::remove_file(db);
    }

    /// 触发器保证增删改与索引一致（外部内容表不复制正文，靠触发器同步）。
    #[test]
    fn fts_index_follows_update_and_delete() {
        let db = std::env::temp_dir().join(format!("dieyun-fts-sync-{}.sqlite", now_ms()));
        let _ = std::fs::remove_file(&db);
        let store = MemoryStore::open(db.clone(), EmbeddingConfig::default()).unwrap();
        seed_memory(&store, "旧内容：使用 SQLite 全文索引", "note", 2);
        let id = store
            .keyword_search_long_memories("全文索引", 5)
            .unwrap()
            .get("results")
            .and_then(|v| v.as_array())
            .and_then(|a| a.first())
            .and_then(|v| v.get("id"))
            .and_then(|v| v.as_i64())
            .expect("先能检索到");

        store
            .test_conn()
            .execute(
                "UPDATE long_memories SET content = ?1 WHERE id = ?2",
                params!["新内容：改用 bm25 排序", id],
            )
            .unwrap();
        let after_update = json_strings(
            &store.keyword_search_long_memories("bm25", 5).unwrap(),
            "results",
            "content",
        );
        assert_eq!(after_update, vec!["新内容：改用 bm25 排序".to_string()]);
        assert!(
            json_strings(
                &store.keyword_search_long_memories("全文索引", 5).unwrap(),
                "results",
                "content"
            )
            .is_empty(),
            "改前的内容不该再被召回"
        );

        store
            .test_conn()
            .execute("DELETE FROM long_memories WHERE id = ?1", params![id])
            .unwrap();
        assert!(
            json_strings(
                &store.keyword_search_long_memories("bm25", 5).unwrap(),
                "results",
                "content"
            )
            .is_empty(),
            "删掉的记忆不该再被召回"
        );
        let _ = std::fs::remove_file(db);
    }

    /// 跨会话检索：默认按 workspace 圈定，且「中文双字词」走 LIKE 分支也要能命中。
    #[test]
    fn messages_search_matches_across_sessions_within_workspace() {
        let db = std::env::temp_dir().join(format!("dieyun-msg-search-{}.sqlite", now_ms()));
        let _ = std::fs::remove_file(&db);
        let store = MemoryStore::open(db.clone(), EmbeddingConfig::default()).unwrap();
        let a = store
            .create_session(Some("登录问题"), Some("E:/ws/alpha"))
            .unwrap();
        let b = store
            .create_session(Some("报表问题"), Some("E:/ws/beta"))
            .unwrap();
        store
            .append_message(
                &a.id,
                "user",
                "登录接口偶发 500，日志里是 pool timeout",
                None,
            )
            .unwrap();
        store
            .append_message(
                &a.id,
                "assistant",
                "连接池上限只有 5，调大到 20 后压力测试通过",
                None,
            )
            .unwrap();
        store
            .append_message(&b.id, "user", "导出报表总是乱码", None)
            .unwrap();

        // trigram 分支：标识符 / 长词
        let hit = store.search_messages("timeout", None, None, 10, 200).unwrap();
        assert_eq!(hit.get("mode").and_then(|v| v.as_str()), Some("fts"), "{hit}");
        assert_eq!(json_strings(&hit, "results", "sessionId"), vec![a.id.clone()]);

        // 中文双字词没有可命中的 trigram → 退 LIKE，结果不能因此丢
        let cjk = store.search_messages("登录", None, None, 10, 200).unwrap();
        assert_eq!(cjk.get("mode").and_then(|v| v.as_str()), Some("like"), "{cjk}");
        assert_eq!(
            json_strings(&cjk, "results", "sessionId"),
            vec![a.id.clone()],
            "{cjk}"
        );

        // workspace 圈定：beta 里查不到 alpha 的内容
        let beta = store
            .search_messages("timeout", Some("E:/ws/beta"), None, 10, 200)
            .unwrap();
        assert!(json_strings(&beta, "results", "sessionId").is_empty(), "{beta}");
        // 大小写 / 反斜杠 / 尾斜杠归一后仍算同一个 workspace（path_key 单一来源）
        let alpha = store
            .search_messages("timeout", Some("e:\\ws\\alpha\\"), None, 10, 200)
            .unwrap();
        assert_eq!(
            json_strings(&alpha, "results", "sessionId"),
            vec![a.id.clone()],
            "{alpha}"
        );
        let _ = std::fs::remove_file(&db);
    }

    /// 影子表要跟着账本走：改 / 删消息后检索必须同步 —— 这是触发器存在的唯一理由。
    #[test]
    fn messages_fts_index_follows_update_and_delete() {
        let db = std::env::temp_dir().join(format!("dieyun-msg-fts-{}.sqlite", now_ms()));
        let _ = std::fs::remove_file(&db);
        let store = MemoryStore::open(db.clone(), EmbeddingConfig::default()).unwrap();
        let s = store.create_session(Some("t"), Some("E:/ws/a")).unwrap();
        store
            .append_message(&s.id, "user", "第一条：索引可以搜到 alpha", None)
            .unwrap();
        assert_eq!(
            json_strings(
                &store.search_messages("alpha", None, None, 10, 200).unwrap(),
                "results",
                "sessionId"
            ),
            vec![s.id.clone()]
        );

        store
            .test_conn()
            .execute(
                "UPDATE messages SET content = '第一条：索引可以搜到 beta' WHERE session_id = ?1",
                params![s.id],
            )
            .expect("update");
        assert!(
            json_strings(
                &store.search_messages("alpha", None, None, 10, 200).unwrap(),
                "results",
                "sessionId"
            )
            .is_empty(),
            "旧正文的 trigram 必须随 UPDATE 触发器消失"
        );
        assert_eq!(
            json_strings(
                &store.search_messages("beta", None, None, 10, 200).unwrap(),
                "results",
                "sessionId"
            ),
            vec![s.id.clone()]
        );

        store
            .test_conn()
            .execute("DELETE FROM messages WHERE session_id = ?1", params![s.id])
            .expect("delete");
        assert!(json_strings(
            &store.search_messages("beta", None, None, 10, 200).unwrap(),
            "results",
            "sessionId"
        )
        .is_empty());
        let _ = std::fs::remove_file(&db);
    }

    /// 压缩归档的 `folded_text` 要有读的出口：它是被压缩掉的历史原文的最后一份材料。
    #[test]
    fn compaction_folded_search_reads_folded_text() {
        let db = std::env::temp_dir().join(format!("dieyun-folded-{}.sqlite", now_ms()));
        let _ = std::fs::remove_file(&db);
        let store = MemoryStore::open(db.clone(), EmbeddingConfig::default()).unwrap();
        let s = store
            .create_session(Some("长任务"), Some("E:/ws/a"))
            .unwrap();
        store
            .test_conn()
            .execute(
                "INSERT INTO compaction_archives
                 (session_id, workspace_path, tokens_before, tokens_after, summary_text, folded_text, created_at)
                 VALUES (?1, 'E:/ws/a', 9000, 1200, '摘要', '折叠掉的原文：pgbouncer 的 pool_mode 要设 transaction', 1)",
                params![s.id],
            )
            .expect("seed archive");

        let hit = store
            .search_compaction_folded("pgbouncer", Some("E:/ws/a"), None, 10, 400)
            .unwrap();
        let snippets = json_strings(&hit, "results", "snippet");
        assert_eq!(snippets.len(), 1, "{hit}");
        assert!(snippets[0].contains("pool_mode"), "{hit}");

        // 空 query = 「这条会话压缩过什么」（只列清单，不带正文）
        let listed = store
            .search_compaction_folded("", None, Some(&s.id), 10, 400)
            .unwrap();
        assert_eq!(listed.get("mode").and_then(|v| v.as_str()), Some("recent"));
        assert_eq!(
            json_strings(&listed, "results", "sessionId"),
            vec![s.id.clone()]
        );
        // 别的 workspace 看不到
        assert!(json_strings(
            &store
                .search_compaction_folded("pgbouncer", Some("E:/ws/beta"), None, 10, 400)
                .unwrap(),
            "results",
            "snippet"
        )
        .is_empty());
        let _ = std::fs::remove_file(&db);
    }

    fn json_strings(v: &Value, list_key: &str, field: &str) -> Vec<String> {
        v.get(list_key)
            .and_then(|x| x.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|r| r.get(field).and_then(|f| f.as_str()).map(str::to_string))
                    .collect()
            })
            .unwrap_or_default()
    }
}


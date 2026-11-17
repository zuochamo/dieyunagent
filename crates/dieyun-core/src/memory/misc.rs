use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};

use crate::error::CoreError;
use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

use super::*;

impl MemoryStore {
    pub fn delete_turn_messages(
        &self,
        session_id: &str,
        message_ids: &[i64],
        remove_count: Option<i64>,
    ) -> Result<Value, CoreError> {
        let sid = session_id.trim();
        if sid.is_empty() {
            return Ok(
                json!({ "ok": false, "error": "sessionId 必填", "deleted": 0, "messageId": [] }),
            );
        }
        let mut ids: Vec<i64> = message_ids.iter().copied().filter(|id| *id > 0).collect();
        ids.sort_unstable();
        ids.dedup();

        if ids.is_empty() {
            if let Some(n) = remove_count.filter(|n| *n > 0) {
                ids = self.with_conn(|conn| {
                    let mut stmt = conn.prepare(
                        "SELECT id FROM messages WHERE session_id = ?1 ORDER BY id DESC LIMIT ?2",
                    )?;
                    let rows = stmt.query_map(params![sid, n], |row| row.get::<_, i64>(0))?;
                    rows.collect::<Result<Vec<_>, _>>().map_err(CoreError::from)
                })?;
            }
        }

        if ids.is_empty() {
            return Ok(json!({ "ok": true, "deleted": 0, "messageId": [] }));
        }

        let deleted = self.with_conn(|conn| -> Result<i64, CoreError> {
            let mut deleted = 0i64;
            for mid in &ids {
                let exists: Option<i64> = conn
                    .query_row(
                        "SELECT id FROM messages WHERE id = ?1 AND session_id = ?2",
                        params![mid, sid],
                        |row| row.get(0),
                    )
                    .optional()?;
                if exists.is_none() {
                    continue;
                }
                conn.execute("DELETE FROM agent_traces WHERE message_id = ?1", params![mid])?;
                conn.execute(
                    "DELETE FROM agent_runs WHERE session_id = ?1 AND (user_message_id = ?2 OR assistant_message_id = ?2)",
                    params![sid, mid],
                )?;
                let changes = conn.execute(
                    "DELETE FROM messages WHERE id = ?1 AND session_id = ?2",
                    params![mid, sid],
                )?;
                if changes > 0 {
                    deleted += 1;
                }
            }
            if deleted > 0 {
                let now = now_ms();
                conn.execute(
                    "UPDATE sessions SET updated_at = ?1 WHERE id = ?2",
                    params![now, sid],
                )?;
                let preview: Option<String> = conn
                    .query_row(
                        "SELECT content FROM messages WHERE session_id = ?1 AND role = 'user' ORDER BY id ASC LIMIT 1",
                        params![sid],
                        |row| row.get(0),
                    )
                    .optional()?;
                if let Some(content) = preview {
                    // 撤回一轮后按新的首条用户消息重算**启发式**标题；
                    // 已有明确作者的标题（ai / user）保持不变 —— 撤回不是改标题的入口。
                    if let Some(title) = title_from_user_content(&content) {
                        conn.execute(
                            "UPDATE sessions SET title = ?1, title_source = ?2
                             WHERE id = ?3
                               AND (title_source IS NULL OR title_source = ?4)",
                            params![
                                title,
                                super::TITLE_SOURCE_HEURISTIC,
                                sid,
                                super::TITLE_SOURCE_HEURISTIC
                            ],
                        )?;
                    }
                }
            }
            Ok(deleted)
        })?;

        Ok(json!({ "ok": true, "deleted": deleted, "messageId": ids }))
    }

    /// 账本自愈（**唯一**实现，幂等）：孤儿项目 scope + 悬空归纳作业 + 僵尸运行行。
    ///
    /// 这三条都是「进程没跑完就没人结账」的遗留数据，不修就会一直骗人：
    ///
    /// 1. `scope = 'project'`（字面量）是旧版本按路径算 scope 失败时的产物：
    ///    召回永远算不出这个 scope，于是这些记忆既不能被注入也不会衰减（看着是 active，
    ///    实际是黑洞）。归档而不是删除：内容仍可恢复，`status` 也终于说实话。
    /// 2. `pending` 归纳作业：作业账本只由 Main 的归纳器结账，进程退出就没人管。
    ///    超过阈值的 pending 一律判 failed（不是「正在跑」，是「已经死了」）。
    ///    阈值取 30 分钟：真实归纳单次是秒到分钟级，超过阈值的 pending 不可能是活的。
    /// 3. `running` 运行行：`agent_runs.status` 由 Rust 循环在跑完时写终态，进程被 kill /
    ///    重启就永远停在 running。它会被 `get_latest_agent_state` 当成「这个会话上次还在跑」
    ///    带进上下文，而 `prune_finished_agent_runs` 只删**已结束**的行 —— 僵尸行只涨不消。
    ///    阈值取 2 分钟（循环每 2.5s 会刷新 `updated_at`，见 `STALE_AGENT_RUN_MS`）。
    ///    `summary` 直接覆盖而不是 `COALESCE`：没跑完的 run 只可能带着启动时写的占位
    ///    （「运行中」），把它留着等于让账本自己跟自己打架（status=stopped 却写运行中）。
    pub fn reconcile_memory_ledger(&self, now: i64) -> Result<Value, CoreError> {
        let stale_job_before = now - super::STALE_CONSOLIDATION_JOB_MS;
        let stale_run_before = now - super::STALE_AGENT_RUN_MS;
        // 先把能认领的历史 scope 重挂到 project:<id>，再清真正认领不了的孤儿
        // （顺序不能反：先归档就会把可认领的行一起埋掉）。
        let rewritten = self
            .migrate_legacy_project_scopes()
            .map(|v| v.get("rewritten").and_then(|n| n.as_i64()).unwrap_or(0))
            .unwrap_or(0);
        self.with_conn(|conn| {
            let orphan_scopes = conn.execute(
                "UPDATE long_memories
                 SET status = 'archived', updated_at = ?1
                 WHERE scope = 'project' AND status != 'archived'",
                params![now],
            )?;
            let stale_jobs = conn.execute(
                "UPDATE memory_consolidation_jobs
                 SET status = 'failed', finished_at = ?1,
                     error = COALESCE(error, '进程退出后未结账（启动自愈）')
                 WHERE status = 'pending' AND COALESCE(started_at, 0) < ?2",
                params![now, stale_job_before],
            )?;
            let stale_runs = conn.execute(
                "UPDATE agent_runs
                 SET status = 'stopped', updated_at = ?1,
                     summary = '进程重启/被杀时该运行未收尾（启动自愈判为停止）'
                 WHERE status = 'running' AND updated_at < ?2",
                params![now, stale_run_before],
            )?;
            Ok(json!({
                "ok": true,
                "orphanScopes": orphan_scopes,
                "staleJobs": stale_jobs,
                "staleRuns": stale_runs,
                "rescopedMemories": rewritten
            }))
        })
    }

    pub fn create_consolidation_job(
        &self,
        scope: Option<&str>,
        reason: Option<&str>,
        status: Option<&str>,
    ) -> Result<Value, CoreError> {
        let now = now_ms();
        self.with_conn(|conn| {
            conn.execute(
                "INSERT INTO memory_consolidation_jobs (scope, status, reason, started_at)
                 VALUES (?1, ?2, ?3, ?4)",
                params![
                    scope.unwrap_or("global"),
                    status.unwrap_or("pending"),
                    reason,
                    now
                ],
            )?;
            Ok(json!({ "jobId": conn.last_insert_rowid() }))
        })
    }

    pub fn finish_consolidation_job(
        &self,
        job_id: i64,
        status: &str,
        error: Option<&str>,
    ) -> Result<Value, CoreError> {
        let now = now_ms();
        self.with_conn(|conn| {
            conn.execute(
                "UPDATE memory_consolidation_jobs SET status = ?1, finished_at = ?2, error = ?3 WHERE id = ?4",
                params![status, now, error, job_id],
            )?;
            Ok(json!({ "ok": true }))
        })
    }

    pub fn decay_long_memories(
        &self,
        stale_days: i64,
        archive_days: i64,
    ) -> Result<Value, CoreError> {
        let now = now_ms();
        let stale_days = stale_days.max(7);
        let archive_days = archive_days.max(stale_days + 1);
        let stale_before = now - stale_days * 24 * 60 * 60 * 1000;
        let archive_before = now - archive_days * 24 * 60 * 60 * 1000;
        self.with_conn(|conn| {
            let expired = conn.execute(
                "UPDATE long_memories
                 SET status = 'archived', updated_at = ?1
                 WHERE status IN ('active', 'stale')
                   AND expires_at IS NOT NULL AND expires_at > 0 AND expires_at <= ?2",
                params![now, now],
            )?;
            let stale = conn.execute(
                "UPDATE long_memories
                 SET status = 'stale', updated_at = ?1
                 WHERE status = 'active'
                   AND kind != 'secret'
                   AND COALESCE(importance, 3) <= 2
                   AND COALESCE(access_count, 0) = 0
                   AND COALESCE(last_used_at, created_at) < ?2",
                params![now, stale_before],
            )?;
            let archived = conn.execute(
                "UPDATE long_memories
                 SET status = 'archived', updated_at = ?1
                 WHERE status = 'stale'
                   AND kind != 'secret'
                   AND COALESCE(importance, 3) <= 2
                   AND COALESCE(last_used_at, created_at) < ?2",
                params![now, archive_before],
            )?;
            Ok(json!({ "ok": true, "expired": expired, "stale": stale, "archived": archived }))
        })
    }

    pub fn list_sessions_with_messages(&self) -> Result<Vec<Value>, CoreError> {
        self.with_conn(|conn| {
            let mut stmt = conn.prepare(
                "SELECT DISTINCT s.id, s.updated_at, s.title, COALESCE(s.archived, 0)
                 FROM sessions s INNER JOIN messages m ON m.session_id = s.id",
            )?;
            let rows = stmt.query_map([], |row| {
                Ok(json!({
                    "id": row.get::<_, String>(0)?,
                    "updated_at": row.get::<_, i64>(1)?,
                    "title": row.get::<_, Option<String>>(2)?,
                    "archived": row.get::<_, i64>(3)? != 0,
                }))
            })?;
            rows.collect::<Result<Vec<_>, _>>().map_err(CoreError::from)
        })
    }

    pub fn list_messages_after_id(
        &self,
        after_id: i64,
        limit: i64,
    ) -> Result<Vec<Value>, CoreError> {
        let lim = limit.clamp(1, 2000);
        self.with_conn(|conn| {
            let mut stmt = conn.prepare(
                "SELECT id, session_id, role, content, reasoning, created_at FROM messages
                 WHERE id > ?1 ORDER BY id ASC LIMIT ?2",
            )?;
            let rows = stmt.query_map(params![after_id, lim], |row| {
                Ok(json!({
                    "id": row.get::<_, i64>(0)?,
                    "session_id": row.get::<_, String>(1)?,
                    "role": row.get::<_, String>(2)?,
                    "content": row.get::<_, String>(3)?,
                    "reasoning": row.get::<_, Option<String>>(4)?,
                    "created_at": row.get::<_, i64>(5)?,
                }))
            })?;
            rows.collect::<Result<Vec<_>, _>>().map_err(CoreError::from)
        })
    }

    pub fn list_long_memories_after_id(
        &self,
        after_id: i64,
        limit: i64,
    ) -> Result<Vec<Value>, CoreError> {
        let lim = limit.clamp(1, 500);
        self.with_conn(|conn| {
            let mut stmt = conn.prepare(
                "SELECT id, content, source, created_at FROM long_memories
                 WHERE id > ?1 ORDER BY id ASC LIMIT ?2",
            )?;
            let rows = stmt.query_map(params![after_id, lim], |row| {
                Ok(json!({
                    "id": row.get::<_, i64>(0)?,
                    "content": row.get::<_, String>(1)?,
                    "source": row.get::<_, Option<String>>(2)?,
                    "created_at": row.get::<_, i64>(3)?,
                }))
            })?;
            rows.collect::<Result<Vec<_>, _>>().map_err(CoreError::from)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::embedding::EmbeddingConfig;

    pub(crate) fn open_store(tag: &str) -> (MemoryStore, std::path::PathBuf) {
        let db = std::env::temp_dir().join(format!("dieyun-misc-{tag}-{}.sqlite", now_ms()));
        let _ = std::fs::remove_file(&db);
        let store = MemoryStore::open(db.clone(), EmbeddingConfig::default()).unwrap();
        (store, db)
    }

    pub(crate) fn status_of(store: &MemoryStore, id: i64) -> String {
        store
            .with_conn(|conn| {
                Ok(conn.query_row(
                    "SELECT status FROM long_memories WHERE id = ?1",
                    params![id],
                    |row| row.get::<_, String>(0),
                )?)
            })
            .unwrap()
    }

    /// 衰减的三条规则各管各的：过期归档 / 低价值久未用转 stale / 高价值与 secret 不动。
    ///
    /// 这条 SQL 会**改库状态**（active → stale → archived）却一直没有测试：
    /// 改错一个条件，表现是「记忆悄悄消失」，界面上看不出是谁干的。
    #[test]
    pub(crate) fn decay_applies_expired_stale_and_archive_rules_independently() {
        let (store, db) = open_store("decay");
        let now = now_ms();
        // 10 天：过了 stale 阈值（7 天）但没过 archive 阈值（14 天）；40 天：两个阈值都过了
        let ten_days = now - 10 * 24 * 60 * 60 * 1000;
        let long_ago = now - 40 * 24 * 60 * 60 * 1000;

        let expired = store
            .add_long_memory(
                "这条已经过期了",
                "test",
                Some("normal"),
                Some("global"),
                Some(5),
                Some(now - 1_000),
                None,
                None,
            )
            .unwrap();
        let low = store
            .add_long_memory("低价值且十几天没用过", "test", Some("normal"), Some("global"), Some(1), None, None, None)
            .unwrap();
        let low_old = store
            .add_long_memory("低价值且四十天没用过", "test", Some("normal"), Some("global"), Some(1), None, None, None)
            .unwrap();
        let high = store
            .add_long_memory("高价值事实", "test", Some("normal"), Some("global"), Some(5), None, None, None)
            .unwrap();
        let secret = store
            .add_long_memory("password=hunter2", "test", Some("normal"), Some("global"), Some(1), None, None, None)
            .unwrap();

        let low_id = low["localMemoryId"].as_i64().unwrap();
        let low_old_id = low_old["localMemoryId"].as_i64().unwrap();
        let high_id = high["localMemoryId"].as_i64().unwrap();
        let secret_id = secret["localMemoryId"].as_i64().unwrap();
        assert_eq!(
            store
                .with_conn(|conn| {
                    Ok(conn.query_row(
                        "SELECT kind FROM long_memories WHERE id = ?1",
                        params![secret_id],
                        |row| row.get::<_, String>(0),
                    )?)
                })
                .unwrap(),
            "secret",
            "凭据形状的正文会被判成 secret（衰减必须放过它）"
        );

        // 把三条做旧（secret 那条也要做旧，才能证明「不是因为它新」）
        store
            .with_conn(|conn| {
                conn.execute(
                    "UPDATE long_memories SET created_at = ?1, last_used_at = NULL, access_count = 0 WHERE id = ?2",
                    params![ten_days, low_id],
                )?;
                for id in [low_old_id, high_id, secret_id] {
                    conn.execute(
                        "UPDATE long_memories SET created_at = ?1, last_used_at = NULL, access_count = 0 WHERE id = ?2",
                        params![long_ago, id],
                    )?;
                }
                Ok(())
            })
            .unwrap();

        let out = store.decay_long_memories(7, 14).unwrap();
        assert_eq!(out["expired"].as_i64(), Some(1), "过期行直接归档");
        // 两条低价值都被 active→stale 这一步捞到；40 天那条接着在同一次调用里被归档，
        // 所以 stale 计数是 2、archived 计数是 1 —— 计数口径是「本步改了几行」，不是最终状态分布。
        assert_eq!(out["stale"].as_i64(), Some(2));
        assert_eq!(out["archived"].as_i64(), Some(1), "只有「四十天」那条一路归档");

        assert_eq!(status_of(&store, expired["localMemoryId"].as_i64().unwrap()), "archived");
        assert_eq!(status_of(&store, low_id), "stale", "阈值内只降级到 stale（仍可命中，打分扣分）");
        assert_eq!(
            status_of(&store, low_old_id),
            "archived",
            "同一次衰减里按时间跨度直达它该在的档位（stale → archived 不等下一轮）"
        );
        assert_eq!(status_of(&store, high_id), "active", "高价值永不衰减");
        assert_eq!(status_of(&store, secret_id), "active", "secret 不衰减（否则等于悄悄删掉凭据提醒）");

        let _ = std::fs::remove_file(&db);
    }

    /// 撤回一轮：消息 / trace / 运行行一起收，标题按剩下的首条用户消息重算。
    #[test]
    pub(crate) fn delete_turn_messages_cascades_and_retitles() {
        let (store, db) = open_store("delete-turn");
        let session = store.create_session(None, None).unwrap();
        store.append_message(&session.id, "user", "第一条用户消息", None).unwrap();
        store.append_message(&session.id, "assistant", "第一条回答", None).unwrap();
        store.append_message(&session.id, "user", "第二条用户消息", None).unwrap();
        assert_eq!(
            store.get_session(&session.id).unwrap().unwrap().title.as_deref(),
            Some("第一条用户消息")
        );

        // 按 id 删首条用户消息 → 标题跟着剩下的首条用户消息走
        let first_id = store.list_messages_after_id(0, 10).unwrap()[0]["id"].as_i64().unwrap();
        let out = store.delete_turn_messages(&session.id, &[first_id], None).unwrap();
        assert_eq!(out["deleted"].as_i64(), Some(1));
        assert_eq!(
            store.get_session(&session.id).unwrap().unwrap().title.as_deref(),
            Some("第二条用户消息"),
            "撤回后按新的首条用户消息重算启发式标题"
        );

        // 有明确作者的标题不许被撤回改写
        store
            .set_session_title(&session.id, "AI 总结的标题", super::super::TITLE_SOURCE_AI)
            .unwrap();
        let out = store.delete_turn_messages(&session.id, &[], Some(5)).unwrap();
        assert_eq!(out["deleted"].as_i64(), Some(2), "remove_count 删掉最后 N 条");
        assert_eq!(
            store.get_session(&session.id).unwrap().unwrap().title.as_deref(),
            Some("AI 总结的标题"),
            "撤回不是改标题的入口：ai 标题保持"
        );

        // 空 sessionId 不静默成功
        let bad = store.delete_turn_messages("  ", &[1], None).unwrap();
        assert_eq!(bad["ok"], json!(false));

        let _ = std::fs::remove_file(&db);
    }

    /// 增量读（请求快照 / 索引追赶都用它）：按 id 升序分页，limit 夹在 1..=2000。
    #[test]
    pub(crate) fn list_messages_after_id_pages_and_clamps_limit() {
        let (store, db) = open_store("list-msgs");
        let session = store.create_session(None, None).unwrap();
        for i in 0..3 {
            store
                .append_message(&session.id, "user", &format!("消息 {i}"), None)
                .unwrap();
        }
        let all = store.list_messages_after_id(0, 100).unwrap();
        assert_eq!(all.len(), 3);
        assert!(all[0]["id"].as_i64() < all[2]["id"].as_i64(), "按 id 升序");

        let page = store.list_messages_after_id(all[0]["id"].as_i64().unwrap(), 100).unwrap();
        assert_eq!(page.len(), 2, "after_id 是开区间");
        assert_eq!(store.list_messages_after_id(0, 0).unwrap().len(), 1, "limit 夹到至少 1");
        assert_eq!(store.list_messages_after_id(0, 99_999).unwrap().len(), 3);

        let _ = std::fs::remove_file(&db);
    }

    /// 长期记忆的增量读同上（索引追赶用）：limit 夹在 1..=500。
    #[test]
    pub(crate) fn list_long_memories_after_id_pages_and_clamps_limit() {
        let (store, db) = open_store("list-mem");
        let a = store
            .add_long_memory("第一条记忆", "test", Some("normal"), Some("global"), None, None, None, None)
            .unwrap();
        store
            .add_long_memory("第二条记忆", "test", Some("normal"), Some("global"), None, None, None, None)
            .unwrap();

        let all = store.list_long_memories_after_id(0, 100).unwrap();
        assert_eq!(all.len(), 2);
        assert_eq!(all[0]["content"].as_str(), Some("第一条记忆"));
        let rest = store
            .list_long_memories_after_id(a["localMemoryId"].as_i64().unwrap(), 100)
            .unwrap();
        assert_eq!(rest.len(), 1);
        assert_eq!(store.list_long_memories_after_id(0, 0).unwrap().len(), 1, "limit 夹到至少 1");

        let _ = std::fs::remove_file(&db);
    }
}

// 维护 / 自愈：从 `impl MemoryStore` 里搬来的剪枝任务（原来散在 mod.rs 的连接段）。

impl MemoryStore {
    /// 周期修剪线程：同一 `db_path` 只起一条，随进程退出而结束。
    pub(crate) fn spawn_prune_loop(db_path: PathBuf, store: Self) {
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
    pub(crate) fn purge_oversized_message_meta(conn: &Connection) -> Result<usize, CoreError> {
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
    pub(crate) fn prune_agent_history(conn: &Connection, policy: &PrunePolicy) -> Result<(), CoreError> {
        let traces_deleted = Self::prune_surplus_agent_traces(conn, policy)?;
        let runs_deleted = Self::prune_finished_agent_runs(conn, policy)?;
        if traces_deleted + runs_deleted > 0 {
            Self::reclaim_free_pages(conn, policy)?;
        }
        Ok(())
    }

    /// 单条 run 的 trace 只保留最新若干行（超阈值才动手）。
    pub(crate) fn prune_surplus_agent_traces(
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
    pub(crate) fn prune_finished_agent_runs(
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
    pub(crate) fn reclaim_free_pages(conn: &Connection, policy: &PrunePolicy) -> Result<(), CoreError> {
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
}

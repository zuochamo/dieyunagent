use rusqlite::{params, OptionalExtension};
use serde_json::{json, Value};

use crate::error::CoreError;

use super::MemoryStore;
use super::{now_ms, title_from_user_content};

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

    /// 账本自愈（**唯一**实现，幂等）：孤儿项目 scope + 悬空归纳作业。
    ///
    /// 这两条都是「进程没跑完就没人结账」的遗留数据，不修就会一直骗人：
    ///
    /// 1. `scope = 'project'`（字面量）是旧版本按路径算 scope 失败时的产物：
    ///    召回永远算不出这个 scope，于是这些记忆既不能被注入也不会衰减（看着是 active，
    ///    实际是黑洞）。归档而不是删除：内容仍可恢复，`status` 也终于说实话。
    /// 2. `pending` 归纳作业：作业账本只由 Main 的归纳器结账，进程退出就没人管。
    ///    超过阈值的 pending 一律判 failed（不是「正在跑」，是「已经死了」）。
    ///    阈值取 30 分钟：真实归纳单次是秒到分钟级，超过阈值的 pending 不可能是活的。
    pub fn reconcile_memory_ledger(&self, now: i64) -> Result<Value, CoreError> {
        let stale_job_before = now - super::STALE_CONSOLIDATION_JOB_MS;
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
            Ok(json!({
                "ok": true,
                "orphanScopes": orphan_scopes,
                "staleJobs": stale_jobs,
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

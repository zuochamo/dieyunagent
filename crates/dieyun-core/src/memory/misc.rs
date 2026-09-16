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
                    if let Some(title) = title_from_user_content(&content) {
                        conn.execute(
                            "UPDATE sessions SET title = ?1 WHERE id = ?2",
                            params![title, sid],
                        )?;
                    }
                }
            }
            Ok(deleted)
        })?;

        Ok(json!({ "ok": true, "deleted": deleted, "messageId": ids }))
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
                "SELECT id, session_id, role, content, created_at FROM messages
                 WHERE id > ?1 ORDER BY id ASC LIMIT ?2",
            )?;
            let rows = stmt.query_map(params![after_id, lim], |row| {
                Ok(json!({
                    "id": row.get::<_, i64>(0)?,
                    "session_id": row.get::<_, String>(1)?,
                    "role": row.get::<_, String>(2)?,
                    "content": row.get::<_, String>(3)?,
                    "created_at": row.get::<_, i64>(4)?,
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

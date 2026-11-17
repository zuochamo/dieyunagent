// 依赖与 mod.rs 同源：域文件里直接用，不再各自拼一套 use。
use super::*;

use rusqlite::{params, OptionalExtension};
use serde_json::{json, Value};

use crate::error::CoreError;

/**
 * 会话与消息账本（会话行 / 标题 / 工作空间 / 归档 / handoff / 消息追加与读取）。
 * 标题判据只有 `meta::title_needs_repair` 一处 —— 本文件不许再写第二套占位判断。
 */

/// 交接行的列清单：`handoff_get` / `handoff_latest` / `handoff_take` 三处共用，
/// 各自只拼自己的 `WHERE` / `ORDER BY`（列口径改一次就够）。
const HANDOFF_SELECT: &str = "SELECT h.session_id, h.title, h.payload, h.created_at, s.workspace_path
     FROM session_handoffs h
     LEFT JOIN sessions s ON s.id = h.session_id";

impl MemoryStore {
    pub fn touch_session(&self, session_id: &str, title: Option<&str>) -> Result<(), CoreError> {
        let now = now_ms();
        // 只补 updated_at（不碰标题）：占位标题、没给标题、以及「已有真标题」都走这一句。
        const TOUCH_ONLY: &str = "INSERT INTO sessions (id, updated_at) VALUES (?1, ?2)
             ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at";
        self.with_conn(|conn| {
            let incoming = title
                .map(str::trim)
                .filter(|s| !s.is_empty())
                // 占位标题等于「还没有标题」：不落笔，免得把历史列表刷成「对话」
                .filter(|t| !matches!(*t, "对话" | "新对话"));
            let Some(t) = incoming else {
                conn.execute(TOUCH_ONLY, params![session_id, now])?;
                return Ok(());
            };
            let sanitized = title_from_user_content(t)
                .unwrap_or_else(|| t.chars().take(80).collect::<String>());
            // 「该不该覆盖现有标题」**只有一个判据**：`title_needs_repair`。
            // 原先这里把同一套条件逐字写了两遍 SQL CASE（title 与 title_source 各一份），
            // 漏改一处就会出现「来源更新了、标题没更新」这种半截状态。
            let existing: Option<String> = conn
                .query_row(
                    "SELECT title FROM sessions WHERE id = ?1",
                    params![session_id],
                    |row| row.get::<_, Option<String>>(0),
                )
                .optional()?
                .flatten();
            if title_needs_repair(existing.as_deref()) {
                conn.execute(
                    "INSERT INTO sessions (id, updated_at, title, title_source) VALUES (?1, ?2, ?3, ?4)
                     ON CONFLICT(id) DO UPDATE SET
                       updated_at = excluded.updated_at,
                       title = excluded.title,
                       title_source = excluded.title_source",
                    params![session_id, now, sanitized, TITLE_SOURCE_HEURISTIC],
                )?;
            } else {
                conn.execute(TOUCH_ONLY, params![session_id, now])?;
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
                         ORDER BY m.id ASC LIMIT 1) AS preview,
                        (SELECT m.content FROM messages m
                         WHERE m.session_id = s.id AND m.role = 'user'
                           AND m.content LIKE '【叠云meta】%\"trigger\"%'
                         ORDER BY m.id ASC LIMIT 1) AS trigger_src
                 FROM sessions s
                 WHERE EXISTS (SELECT 1 FROM messages m WHERE m.session_id = s.id)
                   AND COALESCE(s.archived, 0) = ?1
                 ORDER BY s.updated_at DESC
                 LIMIT ?2",
            )?;
            let mut rows: Vec<SessionRow> = stmt
                .query_map(params![if archived { 1 } else { 0 }, limit], |row| {
                    // 预览与归因都要读**原文**（含 meta），strip 在下面统一做。
                    let preview: Option<String> = row.get(6)?;
                    let trigger_src: Option<String> = row.get(7)?;
                    let trigger_kind = trigger_src
                        .as_deref()
                        .and_then(message_meta_trigger_kind);
                    Ok(SessionRow {
                        id: row.get(0)?,
                        updated_at: row.get(1)?,
                        title: row.get(2)?,
                        title_source: row.get(3)?,
                        archived: row.get::<_, i64>(4)? != 0,
                        workspace_path: row.get(5)?,
                        preview,
                        trigger_kind,
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
                            trigger_kind: None,
                        })
                    },
                )
                .optional()?)
        })
    }

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
            let sql = format!("{HANDOFF_SELECT} WHERE h.session_id = ?1");
            Ok(conn
                .query_row(&sql, params![session_id], Self::handoff_value)
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
            let sql = format!(
                "{HANDOFF_SELECT} WHERE (?1 IS NULL OR h.session_id != ?1)
                 ORDER BY h.created_at DESC LIMIT 1"
            );
            let mut stmt = conn.prepare(&sql)?;
            let mut rows = stmt.query(params![exclude_session_id])?;
            let Some(row) = rows.next()? else {
                return Ok(None);
            };
            Ok(Some(Self::handoff_value(row)?))
        })
    }

    /// 「领走」一份交接：读出来并删掉，**同一条语句序列**里完成。
    ///
    /// 交接是**一次性资源**：语义是「下一条会话接着上一条」，接上了就该没了。
    /// 所以这里不做过期时间、不写「已读」标记、不加开关 —— 删掉就是唯一状态，
    /// 「+」菜单的判据永远是「`handoff_latest` 还取得到吗」，两处不会漂移。
    ///
    /// 返回 `None` = 这份交接已经不在了（另一个窗口先领走），调用方不许再建会话。
    /// 这条「领不到就别建」的语义就是防连点/多窗口重复建会话的**唯一闸门**。
    pub fn handoff_take(&self, session_id: &str) -> Result<Option<Value>, CoreError> {
        self.with_conn(|conn| {
            let sql = format!("{HANDOFF_SELECT} WHERE h.session_id = ?1");
            let row = conn
                .query_row(&sql, params![session_id], Self::handoff_value)
                .optional()?;
            if row.is_none() {
                return Ok(None);
            }
            conn.execute(
                "DELETE FROM session_handoffs WHERE session_id = ?1",
                params![session_id],
            )?;
            Ok(row)
        })
    }

    /// 三处读取（按 id / 最新 / 领走）共用的一份列清单与字段映射，别各写一遍。
    fn handoff_value(row: &rusqlite::Row<'_>) -> rusqlite::Result<Value> {
        Ok(json!({
            "sessionId": row.get::<_, String>(0)?,
            "title": row.get::<_, String>(1)?,
            "payload": row.get::<_, String>(2)?,
            "createdAt": row.get::<_, i64>(3)?,
            "workspacePath": row.get::<_, Option<String>>(4)?,
        }))
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
                trigger_kind: None,
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
            // 会话删了，它的交接就没了来源（工作区要 JOIN sessions 才拿得到）：
            // 留着只会让「+」菜单一直挂一份指向已消失会话的交接。
            conn.execute(
                "DELETE FROM session_handoffs WHERE session_id = ?1",
                params![session_id],
            )?;
            // 这两张表存的都是「这次会话的正文」，却既没有外键也不参与任何级联：
            // 不在这里删，它们会永久留在库里，而且 `memory.compaction_folded` 的检索
            // 不 JOIN sessions —— 已删会话的折叠原文仍会被当成既往对话交给模型。
            conn.execute(
                "DELETE FROM compaction_archives WHERE session_id = ?1",
                params![session_id],
            )?;
            conn.execute(
                "DELETE FROM request_snapshots WHERE session_id = ?1",
                params![session_id],
            )?;
            conn.execute("DELETE FROM sessions WHERE id = ?1", params![session_id])?;
            Ok(json!({ "ok": true }))
        })
    }
}

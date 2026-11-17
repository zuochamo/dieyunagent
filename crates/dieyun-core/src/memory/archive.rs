// 依赖与 mod.rs 同源：域文件里直接用，不再各自拼一套 use。
use super::*;

use rusqlite::params;
use serde_json::{json, Value};

use crate::error::CoreError;

/**
 * 压缩归档与历史检索：上下文折叠摘要的落库 / 回读，以及跨会话正文与折叠片的检索。
 */

impl MemoryStore {
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
}

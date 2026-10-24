//! 请求快照：把「每轮真正发给 LLM 的请求」留底，供事后回答
//! 「模型看到了什么 / 为什么历史变短了 / 这轮为什么没压缩」。
//!
//! 设计边界（勿扩张）：
//! - **旁路事实**，不是真相来源：真相仍是 `messages` 与 `compaction_archives`，
//!   所以本表可裁剪、可丢失，不参与 replay，也没有格式版本迁移链。
//! - **唯一写入点**是 Node 的 `rust-loop-runner`（body 定稿处），本模块只做落库与保留裁剪。
//! - 大字段（`system_text` / `tools_json`）允许为 NULL，语义是「与同会话上一条非 NULL 相同」；
//!   这个约定由写入方（`src/agent/request-snapshot.js`）维护，读侧只做加法。
//!
//! 字段语义与读法见 `docs/REQUEST-SNAPSHOT.md`。

use rusqlite::{params, Connection, OptionalExtension};
use serde::Deserialize;
use serde_json::{json, Value};

use super::{now_ms, MemoryStore};
use crate::error::CoreError;

/// 保留上限的**兜底**默认值。真实数字的唯一来源是 `src/agent/agent-limits.js`
/// （请求快照的保留策略属于账本参数，与 `charsPerToken` 同类，不进设置页）。
/// 这里的常量只负责「调用方没传」时不至于删光或无限增长。
const FALLBACK_KEEP_PER_SESSION: i64 = 40;
const FALLBACK_KEEP_COMPACTED: i64 = 200;
/// 单次查询返回上限，防 UI 误传大数字拖住 sidecar。
const MAX_RECENT_LIMIT: i64 = 200;

/// 写入参数。全部字段可选（除 session/messages），便于 Node 侧按需裁剪而不报错。
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct RequestSnapshotInput {
    pub session_id: String,
    pub run_id: Option<String>,
    pub round: Option<i64>,
    pub source: Option<String>,
    pub model: Option<String>,
    pub stream: Option<bool>,
    pub messages_json: String,
    pub messages_chars: Option<i64>,
    pub message_count: Option<i64>,
    pub messages_hash: Option<String>,
    pub truncated: Option<bool>,
    pub system_hash: Option<String>,
    pub system_chars: Option<i64>,
    pub system_text: Option<String>,
    pub tools_hash: Option<String>,
    pub tools_names: Option<String>,
    pub tools_json: Option<String>,
    pub est_tokens: Option<i64>,
    pub token_budget: Option<i64>,
    pub trigger_ratio: Option<f64>,
    pub compaction_round_count: Option<i64>,
    pub compacted: Option<bool>,
    pub tokens_before: Option<i64>,
    pub tokens_after: Option<i64>,
    pub compaction_archive_id: Option<i64>,
    pub reason: Option<String>,
    pub context_audit_json: Option<String>,
    /// 保留策略（数字由 Node 的 agent-limits 提供；缺省走本模块兜底常量）。
    pub keep_per_session: Option<i64>,
    pub keep_compacted: Option<i64>,
}

/// 落一行快照，并在同一连接内做保留裁剪。返回 `{ ok, id, pruned }`。
pub fn insert_request_snapshot(
    conn: &Connection,
    input: &RequestSnapshotInput,
) -> Result<Value, CoreError> {
    let session_id = input.session_id.trim();
    if session_id.is_empty() {
        return Err(CoreError::rpc("INVALID_PARAMS", "sessionId 必填"));
    }
    if input.messages_json.is_empty() {
        return Err(CoreError::rpc("INVALID_PARAMS", "messagesJson 必填"));
    }
    let now = now_ms();
    conn.execute(
        "INSERT INTO request_snapshots
          (session_id, run_id, round, source, created_at, model, stream,
           messages_json, messages_chars, message_count, messages_hash, truncated,
           system_hash, system_chars, system_text,
           tools_hash, tools_names, tools_json,
           est_tokens, token_budget, trigger_ratio, compaction_round_count,
           compacted, tokens_before, tokens_after, compaction_archive_id,
           reason, context_audit_json)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12,
                 ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22,
                 ?23, ?24, ?25, ?26, ?27, ?28)",
        params![
            session_id,
            input.run_id,
            input.round,
            input.source,
            now,
            input.model,
            input.stream.map(|b| if b { 1 } else { 0 }),
            input.messages_json,
            input.messages_chars,
            input.message_count,
            input.messages_hash,
            input.truncated.unwrap_or(false) as i64,
            input.system_hash,
            input.system_chars,
            input.system_text,
            input.tools_hash,
            input.tools_names,
            input.tools_json,
            input.est_tokens,
            input.token_budget,
            input.trigger_ratio,
            input.compaction_round_count,
            input.compacted.unwrap_or(false) as i64,
            input.tokens_before,
            input.tokens_after,
            input.compaction_archive_id,
            input.reason,
            input.context_audit_json,
        ],
    )?;
    let id = conn.last_insert_rowid();
    let pruned = prune_request_snapshots(
        conn,
        session_id,
        input.keep_per_session.unwrap_or(FALLBACK_KEEP_PER_SESSION),
        input.keep_compacted.unwrap_or(FALLBACK_KEEP_COMPACTED),
    )?;
    Ok(json!({ "ok": true, "id": id, "pruned": pruned, "createdAt": now }))
}

/// 保留裁剪：压缩过的行按 `keep_compacted` 单独保留（排查重点不能被最近 N 轮挤掉），
/// 其余按 `keep_per_session` 保留。两段都按 `id DESC` 取，避免依赖时间戳（同毫秒可重复）。
pub fn prune_request_snapshots(
    conn: &Connection,
    session_id: &str,
    keep_per_session: i64,
    keep_compacted: i64,
) -> Result<usize, CoreError> {
    // 至少要留 1 行：调用方传 0/负数（配置手改、口径错）时把整个会话删空，
    // 会让「刚写进去的那行为什么没了」变成一个无法解释的谜。
    let keep_per_session = keep_per_session.max(1);
    let keep_compacted = keep_compacted.max(0);
    let total: i64 = conn.query_row(
        "SELECT COUNT(*) FROM request_snapshots WHERE session_id = ?1",
        params![session_id],
        |row| row.get(0),
    )?;
    // 快路径：总行数没超过「最近 N 轮」窗口时，一定没有可删的（压缩行只会被额外保留）。
    if total <= keep_per_session {
        return Ok(0);
    }
    let removed = conn.execute(
        "DELETE FROM request_snapshots
          WHERE session_id = ?1
            AND id NOT IN (
              SELECT id FROM (
                SELECT id FROM request_snapshots
                 WHERE session_id = ?1 AND compacted = 1
                 ORDER BY id DESC LIMIT ?2
              )
              UNION
              SELECT id FROM (
                SELECT id FROM request_snapshots
                 WHERE session_id = ?1
                 ORDER BY id DESC LIMIT ?3
              )
            )",
        params![session_id, keep_compacted, keep_per_session],
    )?;
    Ok(removed)
}

/// 列表：**不含**大字段（`messages_json` / `system_text` / `tools_json`），
/// 只给信封级事实，避免 UI 一点开就拉整段 prompt。
pub fn recent_request_snapshots(
    conn: &Connection,
    session_id: &str,
    limit: i64,
) -> Result<Vec<Value>, CoreError> {
    let limit = limit.clamp(1, MAX_RECENT_LIMIT);
    let mut stmt = conn.prepare(
        "SELECT id, session_id, run_id, round, source, created_at, model, stream,
                messages_chars, message_count, messages_hash, truncated,
                system_hash, system_chars, tools_hash, tools_names,
                est_tokens, token_budget, trigger_ratio, compaction_round_count,
                compacted, tokens_before, tokens_after, compaction_archive_id,
                reason, context_audit_json
           FROM request_snapshots
          WHERE session_id = ?1
          ORDER BY id DESC
          LIMIT ?2",
    )?;
    let rows = stmt
        .query_map(params![session_id, limit], |row| {
            Ok(json!({
                "id": row.get::<_, i64>(0)?,
                "sessionId": row.get::<_, String>(1)?,
                "runId": row.get::<_, Option<String>>(2)?,
                "round": row.get::<_, Option<i64>>(3)?,
                "source": row.get::<_, Option<String>>(4)?,
                "createdAt": row.get::<_, i64>(5)?,
                "model": row.get::<_, Option<String>>(6)?,
                "stream": row.get::<_, Option<i64>>(7)?.map(|v| v != 0),
                "messagesChars": row.get::<_, Option<i64>>(8)?,
                "messageCount": row.get::<_, Option<i64>>(9)?,
                "messagesHash": row.get::<_, Option<String>>(10)?,
                "truncated": row.get::<_, Option<i64>>(11)?.map(|v| v != 0).unwrap_or(false),
                "systemHash": row.get::<_, Option<String>>(12)?,
                "systemChars": row.get::<_, Option<i64>>(13)?,
                "toolsHash": row.get::<_, Option<String>>(14)?,
                "toolsNames": row.get::<_, Option<String>>(15)?,
                "estTokens": row.get::<_, Option<i64>>(16)?,
                "tokenBudget": row.get::<_, Option<i64>>(17)?,
                "triggerRatio": row.get::<_, Option<f64>>(18)?,
                "compactionRoundCount": row.get::<_, Option<i64>>(19)?,
                "compacted": row.get::<_, Option<i64>>(20)?.map(|v| v != 0).unwrap_or(false),
                "tokensBefore": row.get::<_, Option<i64>>(21)?,
                "tokensAfter": row.get::<_, Option<i64>>(22)?,
                "compactionArchiveId": row.get::<_, Option<i64>>(23)?,
                "reason": row.get::<_, Option<String>>(24)?,
                "contextAudit": parse_json_column(row.get::<_, Option<String>>(25)?),
            }))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

/// 单行全文：排查入口，包含 `messages_json` 与去重后的大字段。
pub fn get_request_snapshot(conn: &Connection, id: i64) -> Result<Option<Value>, CoreError> {
    let row = conn
        .query_row(
            "SELECT id, session_id, run_id, round, source, created_at, model, stream,
                    messages_json, messages_chars, message_count, messages_hash, truncated,
                    system_hash, system_chars, system_text,
                    tools_hash, tools_names, tools_json,
                    est_tokens, token_budget, trigger_ratio, compaction_round_count,
                    compacted, tokens_before, tokens_after, compaction_archive_id,
                    reason, context_audit_json
               FROM request_snapshots WHERE id = ?1",
            params![id],
            |row| {
                Ok(json!({
                    "id": row.get::<_, i64>(0)?,
                    "sessionId": row.get::<_, String>(1)?,
                    "runId": row.get::<_, Option<String>>(2)?,
                    "round": row.get::<_, Option<i64>>(3)?,
                    "source": row.get::<_, Option<String>>(4)?,
                    "createdAt": row.get::<_, i64>(5)?,
                    "model": row.get::<_, Option<String>>(6)?,
                    "stream": row.get::<_, Option<i64>>(7)?.map(|v| v != 0),
                    "messagesJson": row.get::<_, Option<String>>(8)?,
                    "messagesChars": row.get::<_, Option<i64>>(9)?,
                    "messageCount": row.get::<_, Option<i64>>(10)?,
                    "messagesHash": row.get::<_, Option<String>>(11)?,
                    "truncated": row.get::<_, Option<i64>>(12)?.map(|v| v != 0).unwrap_or(false),
                    "systemHash": row.get::<_, Option<String>>(13)?,
                    "systemChars": row.get::<_, Option<i64>>(14)?,
                    "systemText": row.get::<_, Option<String>>(15)?,
                    "toolsHash": row.get::<_, Option<String>>(16)?,
                    "toolsNames": row.get::<_, Option<String>>(17)?,
                    "toolsJson": row.get::<_, Option<String>>(18)?,
                    "estTokens": row.get::<_, Option<i64>>(19)?,
                    "tokenBudget": row.get::<_, Option<i64>>(20)?,
                    "triggerRatio": row.get::<_, Option<f64>>(21)?,
                    "compactionRoundCount": row.get::<_, Option<i64>>(22)?,
                    "compacted": row.get::<_, Option<i64>>(23)?.map(|v| v != 0).unwrap_or(false),
                    "tokensBefore": row.get::<_, Option<i64>>(24)?,
                    "tokensAfter": row.get::<_, Option<i64>>(25)?,
                    "compactionArchiveId": row.get::<_, Option<i64>>(26)?,
                    "reason": row.get::<_, Option<String>>(27)?,
                    "contextAudit": parse_json_column(row.get::<_, Option<String>>(28)?),
                }))
            },
        )
        .optional()?;
    Ok(row)
}

fn parse_json_column(raw: Option<String>) -> Value {
    match raw {
        Some(s) if !s.trim().is_empty() => serde_json::from_str(&s).unwrap_or(Value::Null),
        _ => Value::Null,
    }
}

impl MemoryStore {
    pub fn save_request_snapshot(&self, input: RequestSnapshotInput) -> Result<Value, CoreError> {
        self.with_conn(|conn| insert_request_snapshot(conn, &input))
    }

    pub fn recent_request_snapshots(
        &self,
        session_id: &str,
        limit: i64,
    ) -> Result<Vec<Value>, CoreError> {
        self.with_conn(|conn| recent_request_snapshots(conn, session_id, limit))
    }

    pub fn request_snapshot_get(&self, id: i64) -> Result<Value, CoreError> {
        let row = self.with_conn(|conn| get_request_snapshot(conn, id))?;
        Ok(row.unwrap_or(Value::Null))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::memory::schema;

    fn conn() -> Connection {
        let conn = Connection::open_in_memory().expect("memory db");
        schema::init_schema(&conn).expect("schema");
        conn
    }

    fn input(session: &str, compacted: bool) -> RequestSnapshotInput {
        RequestSnapshotInput {
            session_id: session.to_string(),
            messages_json: "[]".to_string(),
            messages_chars: Some(2),
            message_count: Some(0),
            compacted: Some(compacted),
            ..Default::default()
        }
    }

    #[test]
    fn insert_and_read_back() {
        let conn = conn();
        let mut i = input("s1", true);
        i.model = Some("m".into());
        i.tokens_before = Some(900);
        i.context_audit_json = Some(r#"{"fold":{"foldedCount":3}}"#.to_string());
        let res = insert_request_snapshot(&conn, &i).expect("insert");
        let id = res.get("id").and_then(|v| v.as_i64()).expect("id");

        let row = get_request_snapshot(&conn, id).expect("get").expect("row");
        assert_eq!(row.get("model").and_then(|v| v.as_str()), Some("m"));
        assert_eq!(row.get("compacted").and_then(|v| v.as_bool()), Some(true));
        assert_eq!(
            row.get("contextAudit")
                .and_then(|v| v.get("fold"))
                .and_then(|v| v.get("foldedCount"))
                .and_then(|v| v.as_i64()),
            Some(3)
        );

        let list = recent_request_snapshots(&conn, "s1", 10).expect("list");
        assert_eq!(list.len(), 1);
        assert!(
            list[0].get("messagesJson").is_none(),
            "列表不得带大字段，否则 UI 一点开就拉整段 prompt"
        );
    }

    #[test]
    fn rejects_missing_identity() {
        let conn = conn();
        let bad = RequestSnapshotInput::default();
        assert!(insert_request_snapshot(&conn, &bad).is_err());
        let mut only_session = RequestSnapshotInput {
            session_id: "s".into(),
            ..Default::default()
        };
        only_session.messages_json = String::new();
        assert!(insert_request_snapshot(&conn, &only_session).is_err());
    }

    /// 压缩过的行按自己的上限保留：不能被「最近 N 轮」挤掉（排查重点）。
    #[test]
    fn prune_keeps_compacted_rows_beyond_recent_window() {
        let conn = conn();
        // 1 条压缩行在最老处，随后 10 条普通行。
        insert_request_snapshot(&conn, &input("s1", true)).expect("first");
        for _ in 0..10 {
            insert_request_snapshot(&conn, &input("s1", false)).expect("row");
        }
        let pruned = prune_request_snapshots(&conn, "s1", 3, 200).expect("prune");
        assert_eq!(pruned, 7, "11 条里留 3 条最近 + 1 条压缩 = 4");
        let left: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM request_snapshots WHERE session_id = 's1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(left, 4);
        let compacted_left: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM request_snapshots WHERE session_id = 's1' AND compacted = 1",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(compacted_left, 1, "最老的压缩行必须存活");
    }

    /// 裁剪只作用于本会话，别的会话一行都不能少。
    #[test]
    fn prune_is_scoped_to_session() {
        let conn = conn();
        for _ in 0..5 {
            insert_request_snapshot(&conn, &input("a", false)).expect("a");
        }
        for _ in 0..5 {
            insert_request_snapshot(&conn, &input("b", false)).expect("b");
        }
        prune_request_snapshots(&conn, "a", 1, 1).expect("prune");
        let b: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM request_snapshots WHERE session_id = 'b'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(b, 5);
    }
}

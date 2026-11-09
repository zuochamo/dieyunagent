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
/// 全库总行数兜底（真实数字是 `agent-limits.requestSnapshotMaxTotalRows`）：
/// 只有每会话窗口的话，库体积随会话数线性涨。
const FALLBACK_KEEP_TOTAL_ROWS: i64 = 1500;
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
    /// **全库**上限：`keep_per_session × 会话数` 会线性涨（现场 2026-11-09：
    /// 4818 行 / 157 个会话 / 1034 MB），所以还要一个跨会话的总闸。
    pub keep_total_rows: Option<i64>,
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
        input.keep_total_rows.unwrap_or(FALLBACK_KEEP_TOTAL_ROWS),
    )?;
    Ok(json!({ "ok": true, "id": id, "pruned": pruned, "createdAt": now }))
}

/// 保留裁剪：两层窗口，都在同一条写入连接、同一个事务里完成。
///
/// 1. **每会话**：压缩过的行按 `keep_compacted` 单独保留（排查重点不能被最近 N 轮挤掉），
///    其余按 `keep_per_session` 保留。两段都按 `id DESC` 取，避免依赖时间戳（同毫秒可重复）。
/// 2. **全库**：跨会话按最旧优先裁到 `keep_total_rows`。只有第 1 层的话，库体积随
///    「用过多少个会话」线性涨 —— 现场 157 个会话 × 40 行 ≈ 1034 MB，占了记忆库的 86%。
///
/// 第 2 层用「取第 N+1 新的 id，再按 id 范围删」：一次索引定位 + 一次范围删，
/// 代价与「删掉多少行」成正比，不必扫全表、也不必对 payload 求 SUM。
pub fn prune_request_snapshots(
    conn: &Connection,
    session_id: &str,
    keep_per_session: i64,
    keep_compacted: i64,
    keep_total_rows: i64,
) -> Result<usize, CoreError> {
    // 至少要留 1 行：调用方传 0/负数（配置手改、口径错）时把整个会话删空，
    // 会让「刚写进去的那行为什么没了」变成一个无法解释的谜。
    //
    // 全库上限是**硬天花板**：两个窗口不能互相矛盾（全库窗比会话窗还小的话，会话窗那 N 轮
    // 根本装不下），所以把会话/压缩两个窗口都夹到全库窗以内，而不是反过来抬全库窗 ——
    // 抬全库窗会让「调小全库上限」这个动作静默失效。
    let keep_total_rows = keep_total_rows.max(1);
    let keep_per_session = keep_per_session.max(1).min(keep_total_rows);
    let keep_compacted = keep_compacted.max(0).min(keep_total_rows);
    let total: i64 = conn.query_row(
        "SELECT COUNT(*) FROM request_snapshots WHERE session_id = ?1",
        params![session_id],
        |row| row.get(0),
    )?;
    let mut removed = 0usize;
    // 快路径：本会话行数没超过「最近 N 轮」窗口时，第 1 层一定没有可删的（压缩行只会被额外保留）。
    if total > keep_per_session {
        removed += conn.execute(
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
    }
    // 第 2 层：全库最旧优先。总行数没超上限时子查询返回 NULL，`id <= NULL` 不成立 ⇒ 一行不删。
    removed += conn.execute(
        "DELETE FROM request_snapshots
          WHERE id <= (
            SELECT id FROM request_snapshots ORDER BY id DESC LIMIT 1 OFFSET ?1
          )",
        params![keep_total_rows],
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

/// 「索引内容有没有真的进上下文」聚合 —— 与工具遥测互补的那一半。
///
/// 为什么必须由快照来回答：`codebase_search` / `graph` / `read_symbol` 的**主动调用**
/// 进工具遥测，而 prep 的**自动注入**（`repo_map` / `【相关代码】`）走 RPC、不进遥测。
/// 只用调用占比评估索引，会把「一直在注入所以不必调工具」读成「没人用」
/// （2026-11-03 实机：调用 0.6%，同期注入 833/1771 轮，见 docs/INDEX-VALUE-REVIEW.md §7.5）。
///
/// 口径只有一处：`context_audit_json.index`（`IndexInjectionAudit`，由
/// `src/agent/system-prompt-prep.js` 产生）。**没有这个字段的行**（本次改造前的历史行，
/// 以及不经 Renderer 拼装的频道轮次）与「明确没注入」分开计数：`rounds` 只数有审计事实的，
/// `total` 记窗口内全部 —— 否则旧数据会被读成「一直没注入」。
pub fn count_index_injections(conn: &Connection, since: Option<i64>) -> Result<Value, CoreError> {
    let mut stmt = conn.prepare(
        "SELECT created_at, context_audit_json FROM request_snapshots
          WHERE (?1 IS NULL OR created_at >= ?1)
          ORDER BY created_at",
    )?;
    let rows = stmt.query_map(params![since], |row| {
        Ok((
            row.get::<_, i64>(0)?,
            row.get::<_, Option<String>>(1)?,
        ))
    })?;

    let mut total: i64 = 0;
    let mut rounds: i64 = 0;
    let mut allowed: i64 = 0;
    let mut repo_map: i64 = 0;
    let mut code_auto: i64 = 0;
    let mut code_explicit: i64 = 0;
    let mut first: Option<i64> = None;
    let mut last: Option<i64> = None;

    for row in rows {
        let (created_at, audit) = row?;
        total += 1;
        first.get_or_insert(created_at);
        last = Some(created_at);
        let index = audit
            .as_deref()
            .and_then(|s| serde_json::from_str::<Value>(s).ok())
            .and_then(|v| v.get("index").cloned())
            .unwrap_or(Value::Null);
        if !index.is_object() {
            continue;
        }
        rounds += 1;
        if index.get("allow").and_then(|v| v.as_bool()) == Some(true) {
            allowed += 1;
        }
        if index.get("repoMap").and_then(|v| v.as_bool()) == Some(true) {
            repo_map += 1;
        }
        match index.get("code").and_then(|v| v.as_str()) {
            Some("explicit") => code_explicit += 1,
            Some("auto") => code_auto += 1,
            _ => {}
        }
    }

    Ok(json!({
        // 窗口内全部快照（含改造前没有索引审计的行）
        "total": total,
        // 有索引审计事实的轮次：注入比例的分母
        "rounds": rounds,
        "allowed": allowed,
        "repoMap": repo_map,
        "codeAuto": code_auto,
        "codeExplicit": code_explicit,
        "since": first,
        "until": last,
    }))
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

    pub fn count_index_injections(&self, since: Option<i64>) -> Result<Value, CoreError> {
        self.with_conn(|conn| count_index_injections(conn, since))
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
        let pruned = prune_request_snapshots(&conn, "s1", 3, 200, 1500).expect("prune");
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
        prune_request_snapshots(&conn, "a", 1, 1, 1500).expect("prune");
        let b: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM request_snapshots WHERE session_id = 'b'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(b, 5);
    }

    /// 全库上限：跨会话按最旧优先裁，刚写进来的那一行永远保留。
    ///
    /// 只有每会话窗口时，库体积 = 40 行 × 会话数（现场 157 个会话 ≈ 1034 MB），
    /// 这条闸门是唯一的跨会话上限。
    #[test]
    fn prune_global_cap_keeps_newest_rows_across_sessions() {
        let conn = conn();
        for i in 0..6 {
            insert_request_snapshot(&conn, &input(&format!("s{i}"), false)).expect("row");
        }
        // 每会话都远未超窗口（1 行），所以删掉的全是全库闸门裁的
        let pruned = prune_request_snapshots(&conn, "s5", 40, 200, 3).expect("prune");
        assert_eq!(pruned, 3, "6 条里只留最新 3 条");
        let left: Vec<String> = conn
            .prepare("SELECT session_id FROM request_snapshots ORDER BY id")
            .unwrap()
            .query_map([], |r| r.get::<_, String>(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(left, vec!["s3", "s4", "s5"], "留最新三条，最旧三条被裁");
    }

    /// 全库窗比会话窗还小时：全库窗是硬天花板，两个窗口一起收紧（而不是让全库上限静默失效）。
    #[test]
    fn prune_global_cap_below_session_window_tightens_both() {
        let conn = conn();
        for _ in 0..5 {
            insert_request_snapshot(&conn, &input("s1", false)).expect("row");
        }
        let pruned = prune_request_snapshots(&conn, "s1", 40, 200, 2).expect("prune");
        assert_eq!(pruned, 3, "全库窗 2 ⇒ 会话窗也收到 2，5 条里删 3");
        let left: i64 = conn
            .query_row("SELECT COUNT(*) FROM request_snapshots", [], |r| r.get(0))
            .unwrap();
        assert_eq!(left, 2);
    }

    fn audited(session: &str, code: Option<&str>, repo_map: bool) -> RequestSnapshotInput {        let mut i = input(session, false);
        i.context_audit_json = Some(
            json!({"index": {"allow": true, "code": code, "repoMap": repo_map}}).to_string(),
        );
        i
    }

    /// 注入比例的分母只能是「有索引审计事实的轮次」：改造前的历史行（只有 memory 审计、
    /// 或连审计都没有）如果算进去，会被读成「那些轮次明确没注入」。
    #[test]
    fn count_index_injections_counts_only_audited_rounds() {
        let conn = conn();
        let mut legacy = input("s1", false);
        legacy.context_audit_json = Some(r#"{"memory":{"project":{"mode":"file"}}}"#.to_string());
        insert_request_snapshot(&conn, &legacy).expect("legacy");
        insert_request_snapshot(&conn, &input("s1", false)).expect("bare");
        insert_request_snapshot(&conn, &audited("s1", None, true)).expect("repo only");
        insert_request_snapshot(&conn, &audited("s1", Some("auto"), false)).expect("auto code");
        insert_request_snapshot(&conn, &audited("s1", Some("explicit"), true)).expect("explicit");

        let s = count_index_injections(&conn, None).expect("count");
        assert_eq!(s["total"], json!(5), "窗口内全部快照");
        assert_eq!(s["rounds"], json!(3), "只数有索引审计事实的轮次");
        assert_eq!(s["allowed"], json!(3));
        assert_eq!(s["repoMap"], json!(2));
        assert_eq!(s["codeAuto"], json!(1));
        assert_eq!(s["codeExplicit"], json!(1));
        assert!(s["since"].as_i64().is_some());
        assert!(s["until"].as_i64().is_some());
    }

    #[test]
    fn count_index_injections_honours_since() {
        let conn = conn();
        insert_request_snapshot(&conn, &audited("s1", Some("auto"), false)).expect("a");
        let s = count_index_injections(&conn, Some(now_ms() + 1)).expect("count");
        assert_eq!(s["total"], json!(0));
        assert_eq!(s["rounds"], json!(0));
        assert!(s["since"].is_null(), "空窗口不给时间戳，UI 才不会画出一个假窗口");
        assert!(s["until"].is_null());
    }
}

//! 会话级目标对象（`session_goals`）：**只做 KV**。
//!
//! 语义（目标形状归一化、检查事实、`judgeGoalFinish` 核对、`decideContinuation` 续跑判定、
//! 事实块渲染）全在 Node 的 `src/plans/goal-run.js`。这里刻意不解析 JSON，
//! 也不做「完成/未完成」的任何判断 —— 一旦 Rust 也开始理解目标，
//! 同一个目标就有两份判定，迟早对不上。

use rusqlite::{params, OptionalExtension};
use serde_json::{json, Value};

use dieyun_base::error::CoreError;

use super::{now_ms, MemoryStore};

/// 目标 JSON 的字符上限。目标本身很小（objective + 少量 todos + 有界事实），
/// 设上限只为挡住「把整份日志塞进 goal」这种失控写入 —— 库是长期资产，不接垃圾。
const SESSION_GOAL_MAX_CHARS: usize = 64_000;

impl MemoryStore {
    /// 读会话目标（原始 JSON 字符串）。无目标返回 `None`。
    pub fn get_session_goal(&self, session_id: &str) -> Result<Option<String>, CoreError> {
        self.read(|conn| {
            let row = conn
                .query_row(
                    "SELECT goal_json FROM session_goals WHERE session_id = ?1",
                    params![session_id],
                    |r| r.get::<_, String>(0),
                )
                .optional()?;
            Ok(row)
        })
    }

    /// 写会话目标（整体覆盖）。`goal_json = None` 表示删除该会话的目标。
    ///
    /// last-write-wins：目标只有一个写入者（Node 的 `session-goal.js`），不需要版本号。
    pub fn put_session_goal(
        &self,
        session_id: &str,
        goal_json: Option<&str>,
    ) -> Result<Value, CoreError> {
        match goal_json {
            None => {
                self.with_conn(|conn| {
                    conn.execute(
                        "DELETE FROM session_goals WHERE session_id = ?1",
                        params![session_id],
                    )?;
                    Ok(json!({ "ok": true, "goal": Value::Null }))
                })
            }
            Some(raw) => {
                if raw.trim().is_empty() {
                    return Err(CoreError::rpc("INVALID_PARAMS", "goal 不能是空字符串（删除请传 null）"));
                }
                if raw.chars().count() > SESSION_GOAL_MAX_CHARS {
                    return Err(CoreError::rpc(
                        "GOAL_TOO_LARGE",
                        format!("目标超过 {SESSION_GOAL_MAX_CHARS} 字符上限"),
                    ));
                }
                let now = now_ms();
                self.with_conn(|conn| {
                    conn.execute(
                        "INSERT INTO session_goals (session_id, goal_json, updated_at)
                         VALUES (?1, ?2, ?3)
                         ON CONFLICT(session_id) DO UPDATE SET
                           goal_json = excluded.goal_json,
                           updated_at = excluded.updated_at",
                        params![session_id, raw, now],
                    )?;
                    Ok(json!({ "ok": true }))
                })
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use dieyun_base::embedding::EmbeddingConfig;

    fn temp_store(tag: &str) -> (MemoryStore, std::path::PathBuf) {
        let db = std::env::temp_dir().join(format!(
            "dieyun-session-goal-{tag}-{}-{}.sqlite",
            std::process::id(),
            now_ms()
        ));
        let _ = std::fs::remove_file(&db);
        let store = MemoryStore::open(db.clone(), EmbeddingConfig::default()).expect("open memory");
        (store, db)
    }

    #[test]
    fn goal_roundtrip_overwrite_and_delete() {
        let (store, db) = temp_store("roundtrip");
        let session = store.create_session(Some("goal"), None).expect("session");

        assert!(store.get_session_goal(&session.id).expect("get").is_none());

        store
            .put_session_goal(&session.id, Some(r#"{"objective":"v1"}"#))
            .expect("put");
        assert_eq!(
            store.get_session_goal(&session.id).expect("get").as_deref(),
            Some(r#"{"objective":"v1"}"#)
        );

        // 覆盖写：一个会话只有一条目标（PK），不追加行
        store
            .put_session_goal(&session.id, Some(r#"{"objective":"v2"}"#))
            .expect("overwrite");
        assert_eq!(
            store.get_session_goal(&session.id).expect("get").as_deref(),
            Some(r#"{"objective":"v2"}"#)
        );

        // null 即删除
        store.put_session_goal(&session.id, None).expect("delete");
        assert!(store.get_session_goal(&session.id).expect("get").is_none());

        let _ = std::fs::remove_file(db);
    }

    #[test]
    fn goal_rejects_empty_and_oversized_blob() {
        let (store, db) = temp_store("limits");
        let session = store.create_session(Some("goal"), None).expect("session");

        assert!(store.put_session_goal(&session.id, Some("  ")).is_err());
        let huge = "x".repeat(SESSION_GOAL_MAX_CHARS + 1);
        assert!(store.put_session_goal(&session.id, Some(&huge)).is_err());
        // 被拒的写入不能留下半条记录
        assert!(store.get_session_goal(&session.id).expect("get").is_none());

        let _ = std::fs::remove_file(db);
    }

    #[test]
    fn deleting_session_cascades_goal() {
        let (store, db) = temp_store("cascade");
        let session = store.create_session(Some("goal"), None).expect("session");
        store
            .put_session_goal(&session.id, Some(r#"{"objective":"x"}"#))
            .expect("put");

        store.clear_session(&session.id).expect("clear session");

        assert!(
            store.get_session_goal(&session.id).expect("get").is_none(),
            "删会话必须连带清掉目标（FK ON DELETE CASCADE）"
        );

        let _ = std::fs::remove_file(db);
    }
}

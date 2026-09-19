use rusqlite::{params, OptionalExtension};
use serde_json::{json, Value};

use crate::error::CoreError;

use super::MemoryStore;

impl MemoryStore {
    pub fn upsert_agent_run(&self, input: &Value) -> Result<Value, CoreError> {
        let id = input
            .get("id")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
            .to_string();
        if id.is_empty() {
            return Err(CoreError::rpc("INVALID_RUN_ID", "run id 必填"));
        }
        let session_id = input
            .get("sessionId")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
            .to_string();
        if session_id.is_empty() {
            return Err(CoreError::rpc("INVALID_SESSION_ID", "sessionId 必填"));
        }
        // 注意：不要在这里 touch_session 刷新 sessions.updated_at。
        // 运行中的任务每 ~2.5s 保存一次 trace checkpoint（agent.trace_save → upsert_agent_run），
        // 若每次都刷新 updated_at，多个并行任务的会话会在侧栏（ORDER BY updated_at DESC）里不停互换位置。
        // 会话排序只应由真实消息（memory.message_append）驱动。
        let user_message_id = optional_i64(input.get("userMessageId"));
        let assistant_message_id = optional_i64(input.get("assistantMessageId"));
        let summary = input
            .get("summary")
            .map(|v| v.as_str().unwrap_or("").to_string());
        let state_snapshot = json_to_opt_string(input.get("stateSnapshot"));
        let status = input
            .get("status")
            .and_then(|v| v.as_str())
            .unwrap_or("running")
            .to_string();
        let now = super::now_ms();
        self.with_conn(|conn| {
            conn.execute(
                "INSERT INTO agent_runs
                  (id, session_id, user_message_id, assistant_message_id, status, summary, state_snapshot, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)
                 ON CONFLICT(id) DO UPDATE SET
                  session_id = excluded.session_id,
                  user_message_id = COALESCE(excluded.user_message_id, agent_runs.user_message_id),
                  assistant_message_id = COALESCE(excluded.assistant_message_id, agent_runs.assistant_message_id),
                  status = CASE
                    WHEN agent_runs.status IN ('completed', 'stopped', 'failed') AND excluded.status = 'running'
                      THEN agent_runs.status
                    ELSE excluded.status
                  END,
                  summary = CASE
                    WHEN agent_runs.status IN ('completed', 'stopped', 'failed') AND excluded.status = 'running'
                      THEN agent_runs.summary
                    ELSE COALESCE(excluded.summary, agent_runs.summary)
                  END,
                  state_snapshot = CASE
                    WHEN agent_runs.status IN ('completed', 'stopped', 'failed') AND excluded.status = 'running'
                      THEN agent_runs.state_snapshot
                    ELSE COALESCE(excluded.state_snapshot, agent_runs.state_snapshot)
                  END,
                  updated_at = excluded.updated_at",
                params![
                    id,
                    session_id,
                    user_message_id,
                    assistant_message_id,
                    status,
                    summary,
                    state_snapshot,
                    now
                ],
            )?;
            Ok(json!({ "runId": id }))
        })
    }

    pub fn save_agent_trace(&self, input: &Value) -> Result<Value, CoreError> {
        let run_id = input
            .get("runId")
            .or_else(|| input.get("id"))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
            .to_string();
        if run_id.is_empty() {
            return Err(CoreError::rpc("INVALID_RUN_ID", "runId 必填"));
        }
        let session_id = input
            .get("sessionId")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
            .to_string();
        if session_id.is_empty() {
            return Err(CoreError::rpc("INVALID_SESSION_ID", "sessionId 必填"));
        }
        let status = input
            .get("status")
            .and_then(|v| v.as_str())
            .unwrap_or("completed");
        if status == "running" {
            let existing_status = self.with_conn(|conn| {
                conn.query_row(
                    "SELECT status FROM agent_runs WHERE id = ?1",
                    params![run_id.as_str()],
                    |row| row.get::<_, String>(0),
                )
                .optional()
                .map_err(CoreError::from)
            })?;
            if matches!(
                existing_status.as_deref(),
                Some("completed" | "stopped" | "failed")
            ) {
                return Ok(json!({ "skipped": true, "runId": run_id }));
            }
        }
        self.upsert_agent_run(&json!({
            "id": run_id,
            "sessionId": session_id,
            "userMessageId": input.get("userMessageId"),
            "assistantMessageId": input.get("messageId").or_else(|| input.get("assistantMessageId")),
            "status": status,
            "summary": input.get("summary"),
            "stateSnapshot": input.get("stateSnapshot"),
        }))?;
        let trace_json = match input.get("trace") {
            Some(v) if v.is_string() => v.as_str().unwrap_or("[]").to_string(),
            Some(v) => v.to_string(),
            None => "[]".into(),
        };
        let trace_text = input
            .get("traceText")
            .and_then(|v| v.as_str())
            .map(str::to_string);
        let message_id = optional_i64(
            input
                .get("messageId")
                .or_else(|| input.get("assistantMessageId")),
        );
        let phase = input
            .get("phase")
            .and_then(|v| v.as_str())
            .unwrap_or("assistant")
            .to_string();
        let now = super::now_ms();
        self.with_conn(|conn| {
            // 同一条 run 的 checkpoint 原地覆盖最新一行。
            //
            // 读取路径只有 `get_agent_trace`（`run_id` + `ORDER BY id DESC LIMIT 1`），
            // 历史行没有任何读者；而运行中的任务每 ~2.5s 就写一份**全量**快照，
            // 追加式写入等于让单次运行落盘几十 MB、且总量与时长成平方关系。
            let existing: Option<i64> = conn
                .query_row(
                    "SELECT id FROM agent_traces WHERE run_id = ?1 ORDER BY id DESC LIMIT 1",
                    params![run_id.as_str()],
                    |row| row.get(0),
                )
                .optional()?;
            let trace_id = match existing {
                Some(id) => {
                    conn.execute(
                        "UPDATE agent_traces
                            SET session_id = ?1, message_id = ?2, phase = ?3,
                                trace_json = ?4, trace_text = ?5, created_at = ?6
                          WHERE id = ?7",
                        params![session_id, message_id, phase, trace_json, trace_text, now, id],
                    )?;
                    id
                }
                None => {
                    conn.execute(
                        "INSERT INTO agent_traces
                          (run_id, session_id, message_id, phase, trace_json, trace_text, created_at)
                         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                        params![run_id, session_id, message_id, phase, trace_json, trace_text, now],
                    )?;
                    conn.last_insert_rowid()
                }
            };
            Ok(json!({
                "traceId": trace_id,
                "runId": run_id,
            }))
        })
    }

    pub fn upsert_agent_plan(&self, input: &Value) -> Result<Value, CoreError> {
        let run_id = input
            .get("runId")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
            .to_string();
        let session_id = input
            .get("sessionId")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
            .to_string();
        if run_id.is_empty() || session_id.is_empty() {
            return Err(CoreError::rpc(
                "INVALID_AGENT_PLAN",
                "runId 和 sessionId 必填",
            ));
        }
        let run_status = input
            .get("runStatus")
            .or_else(|| input.get("status"))
            .and_then(|v| v.as_str())
            .unwrap_or("planned");
        self.upsert_agent_run(&json!({
            "id": run_id,
            "sessionId": session_id,
            "status": run_status,
            "summary": input.get("summary"),
            "stateSnapshot": input.get("stateSnapshot"),
        }))?;
        let now = super::now_ms();
        let version = input
            .get("version")
            .and_then(|v| v.as_i64())
            .unwrap_or(1)
            .max(1);
        let plan_id = input
            .get("id")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| format!("{run_id}:plan:{version}"));
        let plan_json = match input.get("plan") {
            Some(v) if v.is_string() => v.as_str().unwrap_or("{}").to_string(),
            Some(v) => v.to_string(),
            None => "{}".into(),
        };
        let summary = input
            .get("summary")
            .and_then(|v| v.as_str())
            .map(str::to_string);
        let parent_plan_id = input
            .get("parentPlanId")
            .and_then(|v| v.as_str())
            .map(str::to_string);
        let status = input
            .get("status")
            .and_then(|v| v.as_str())
            .unwrap_or("planned")
            .to_string();
        self.with_conn(|conn| {
            conn.execute(
                "INSERT INTO agent_plans
                  (id, run_id, session_id, version, status, parent_plan_id, summary, plan_json, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)
                 ON CONFLICT(id) DO UPDATE SET
                  status = excluded.status,
                  summary = COALESCE(excluded.summary, agent_plans.summary),
                  plan_json = excluded.plan_json,
                  updated_at = excluded.updated_at",
                params![
                    plan_id,
                    run_id,
                    session_id,
                    version,
                    status,
                    parent_plan_id,
                    summary,
                    plan_json,
                    now
                ],
            )?;
            Ok(json!({ "planId": plan_id, "runId": run_id }))
        })
    }

    pub fn save_agent_steps(&self, input: &Value) -> Result<Value, CoreError> {
        let plan_id = input
            .get("planId")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
            .to_string();
        let run_id = input
            .get("runId")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
            .to_string();
        let session_id = input
            .get("sessionId")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
            .to_string();
        if plan_id.is_empty() || run_id.is_empty() || session_id.is_empty() {
            return Err(CoreError::rpc(
                "INVALID_AGENT_STEPS",
                "planId、runId 和 sessionId 必填",
            ));
        }
        let steps = input
            .get("steps")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();
        let default_status = input
            .get("status")
            .and_then(|v| v.as_str())
            .unwrap_or("pending");
        let now = super::now_ms();
        self.with_conn(|conn| {
            for (index, step) in steps.iter().enumerate() {
                let step_key = step
                    .get("id")
                    .or_else(|| step.get("stepKey"))
                    .or_else(|| step.get("taskId"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let step_key = if step_key.is_empty() {
                    (index + 1).to_string()
                } else {
                    step_key
                };
                let step_id = step
                    .get("dbId")
                    .and_then(|v| v.as_str())
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(str::to_string)
                    .unwrap_or_else(|| format!("{plan_id}:step:{step_key}"));
                let status = step
                    .get("status")
                    .and_then(|v| v.as_str())
                    .unwrap_or(default_status);
                let result_json = match step.get("result") {
                    None => None,
                    Some(v) if v.is_string() => Some(v.as_str().unwrap_or("").to_string()),
                    Some(v) => Some(v.to_string()),
                };
                let completed_at = if status == "completed" || status == "failed" {
                    Some(
                        step.get("completedAt")
                            .and_then(|v| v.as_i64())
                            .unwrap_or(now),
                    )
                } else {
                    None
                };
                conn.execute(
                    "INSERT INTO agent_steps
                      (id, plan_id, run_id, session_id, step_number, step_key, worker, agent_type, title, instruction, expected_output, status, result_json, created_at, updated_at, completed_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?14, ?15)
                     ON CONFLICT(id) DO UPDATE SET
                      step_number = excluded.step_number,
                      worker = excluded.worker,
                      agent_type = excluded.agent_type,
                      title = excluded.title,
                      instruction = excluded.instruction,
                      expected_output = excluded.expected_output,
                      status = excluded.status,
                      result_json = COALESCE(excluded.result_json, agent_steps.result_json),
                      updated_at = excluded.updated_at,
                      completed_at = COALESCE(excluded.completed_at, agent_steps.completed_at)",
                    params![
                        step_id,
                        plan_id,
                        run_id,
                        session_id,
                        step.get("stepNumber").and_then(|v| v.as_i64()).unwrap_or((index + 1) as i64),
                        step_key,
                        step.get("worker").and_then(|v| v.as_str()),
                        step.get("agentType")
                            .or_else(|| step.get("agent_type"))
                            .and_then(|v| v.as_str()),
                        step.get("title").and_then(|v| v.as_str()),
                        step.get("instruction").and_then(|v| v.as_str()),
                        step.get("expectedOutput")
                            .or_else(|| step.get("expected_output"))
                            .and_then(|v| v.as_str()),
                        status,
                        result_json,
                        now,
                        completed_at,
                    ],
                )?;
            }
            Ok(json!({ "ok": true, "count": steps.len() }))
        })
    }

    pub fn get_latest_agent_state(&self, session_id: &str) -> Result<Option<Value>, CoreError> {
        let sid = session_id.trim();
        if sid.is_empty() {
            return Ok(None);
        }
        self.with_conn(|conn| {
            let run = conn
                .query_row(
                    "SELECT id, session_id, status, summary, state_snapshot, updated_at
                     FROM agent_runs WHERE session_id = ?1 ORDER BY updated_at DESC LIMIT 1",
                    params![sid],
                    |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, String>(2)?,
                            row.get::<_, Option<String>>(3)?,
                            row.get::<_, Option<String>>(4)?,
                            row.get::<_, i64>(5)?,
                        ))
                    },
                )
                .optional()?;
            let Some((run_id, session_id, status, summary, state_snapshot, updated_at)) = run else {
                return Ok(None);
            };
            let plan_row = conn
                .query_row(
                    "SELECT id, version, status, summary, plan_json, updated_at
                     FROM agent_plans WHERE run_id = ?1 ORDER BY version DESC, updated_at DESC LIMIT 1",
                    params![run_id],
                    |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, i64>(1)?,
                            row.get::<_, String>(2)?,
                            row.get::<_, Option<String>>(3)?,
                            row.get::<_, String>(4)?,
                        ))
                    },
                )
                .optional()?;
            let plan_body = plan_row.as_ref().and_then(|(_, _, _, _, json)| {
                serde_json::from_str::<Value>(json).ok()
            });
            let steps = if let Some((plan_id, _, _, _, _)) = &plan_row {
                let mut stmt = conn.prepare(
                    "SELECT step_number, step_key, worker, agent_type, title, status
                     FROM agent_steps WHERE plan_id = ?1 ORDER BY step_number ASC LIMIT 50",
                )?;
                let mapped = stmt.query_map(params![plan_id], |row| {
                    Ok(json!({
                        "step_number": row.get::<_, i64>(0)?,
                        "step_key": row.get::<_, Option<String>>(1)?,
                        "worker": row.get::<_, Option<String>>(2)?,
                        "agent_type": row.get::<_, Option<String>>(3)?,
                        "title": row.get::<_, Option<String>>(4)?,
                        "status": row.get::<_, String>(5)?,
                    }))
                })?;
                mapped.collect::<Result<Vec<_>, _>>()?
            } else {
                Vec::new()
            };
            let parsed_snapshot = state_snapshot
                .as_deref()
                .and_then(|s| serde_json::from_str::<Value>(s).ok())
                .or_else(|| state_snapshot.map(Value::String));
            Ok(Some(json!({
                "runId": run_id,
                "sessionId": session_id,
                "status": status,
                "summary": summary.unwrap_or_default(),
                "stateSnapshot": parsed_snapshot,
                "updatedAt": updated_at,
                "plan": plan_row.map(|(id, version, status, summary, _)| json!({
                    "id": id,
                    "version": version,
                    "status": status,
                    "summary": summary.unwrap_or_default(),
                    "body": plan_body,
                })),
                "steps": steps,
            })))
        })
    }

    pub fn get_agent_trace(&self, input: &Value) -> Result<Option<Value>, CoreError> {
        let run_id = input.get("runId").and_then(|v| v.as_str()).unwrap_or("");
        let message_id = optional_i64(input.get("messageId"));
        self.with_conn(|conn| {
            let row = if !run_id.is_empty() {
                conn.query_row(
                    "SELECT id, run_id, session_id, message_id, phase, trace_json, trace_text, created_at
                     FROM agent_traces WHERE run_id = ?1 ORDER BY id DESC LIMIT 1",
                    params![run_id],
                    map_trace_row,
                )
                .optional()?
            } else if let Some(mid) = message_id {
                conn.query_row(
                    "SELECT id, run_id, session_id, message_id, phase, trace_json, trace_text, created_at
                     FROM agent_traces WHERE message_id = ?1 ORDER BY id DESC LIMIT 1",
                    params![mid],
                    map_trace_row,
                )
                .optional()?
            } else {
                None
            };
            Ok(row.map(|(id, run_id, session_id, message_id, phase, trace_json, trace_text, created_at)| {
                let trace = serde_json::from_str::<Value>(&trace_json)
                    .unwrap_or_else(|_| json!([]));
                json!({
                    "id": id,
                    "runId": run_id,
                    "sessionId": session_id,
                    "messageId": message_id,
                    "phase": phase,
                    "trace": trace,
                    "traceText": trace_text.unwrap_or_default(),
                    "createdAt": created_at,
                })
            }))
        })
    }
}

fn map_trace_row(
    row: &rusqlite::Row<'_>,
) -> rusqlite::Result<(
    i64,
    String,
    String,
    Option<i64>,
    Option<String>,
    String,
    Option<String>,
    i64,
)> {
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

fn optional_i64(v: Option<&Value>) -> Option<i64> {
    match v {
        None | Some(Value::Null) => None,
        Some(Value::Number(n)) => n.as_i64(),
        Some(Value::String(s)) if s.trim().is_empty() => None,
        Some(Value::String(s)) => s.parse().ok(),
        _ => None,
    }
}

fn json_to_opt_string(v: Option<&Value>) -> Option<String> {
    match v {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) => Some(s.clone()),
        Some(other) => Some(other.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::embedding::EmbeddingConfig;

    #[test]
    fn agent_run_and_trace_roundtrip() {
        let db = std::env::temp_dir().join(format!(
            "dieyun-agent-test-{}.sqlite",
            super::super::now_ms()
        ));
        let _ = std::fs::remove_file(&db);
        let store = MemoryStore::open(db.clone(), EmbeddingConfig::default(), vec![]).unwrap();
        let session = store.create_session(Some("agent"), None).unwrap();
        store
            .upsert_agent_run(&json!({
                "id": "run-1",
                "sessionId": session.id,
                "status": "running",
            }))
            .unwrap();
        store
            .save_agent_trace(&json!({
                "runId": "run-1",
                "sessionId": session.id,
                "trace": [{"type": "text", "content": "hello"}],
                "traceText": "hello",
            }))
            .unwrap();
        let trace = store
            .get_agent_trace(&json!({ "runId": "run-1" }))
            .unwrap()
            .unwrap();
        assert_eq!(trace.get("runId").and_then(|v| v.as_str()), Some("run-1"));
        let state = store.get_latest_agent_state(&session.id).unwrap().unwrap();
        assert_eq!(state.get("runId").and_then(|v| v.as_str()), Some("run-1"));
        let _ = std::fs::remove_file(db);
    }

    /// 运行中每 ~2.5s 一次 checkpoint 必须原地覆盖，
    /// 否则单条 run 会累积上百份同源全量快照。
    #[test]
    fn trace_checkpoints_overwrite_same_run() {
        let db = std::env::temp_dir().join(format!(
            "dieyun-agent-overwrite-{}.sqlite",
            super::super::now_ms()
        ));
        let _ = std::fs::remove_file(&db);
        let store = MemoryStore::open(db.clone(), EmbeddingConfig::default(), vec![]).unwrap();
        let session = store.create_session(Some("trace"), None).unwrap();
        store
            .upsert_agent_run(&json!({
                "id": "run-ow",
                "sessionId": session.id,
                "status": "running",
            }))
            .unwrap();
        for i in 0..3 {
            store
                .save_agent_trace(&json!({
                    "runId": "run-ow",
                    "sessionId": session.id,
                    "status": "running",
                    "trace": [{ "type": "text", "content": i.to_string() }],
                }))
                .unwrap();
        }
        let rows: i64 = {
            let guard = store.conn.lock().unwrap();
            guard
                .query_row(
                    "SELECT COUNT(*) FROM agent_traces WHERE run_id = 'run-ow'",
                    [],
                    |r| r.get(0),
                )
                .unwrap()
        };
        assert_eq!(rows, 1, "同一 run 的 checkpoint 不应堆成多行");
        let row = store
            .get_agent_trace(&json!({ "runId": "run-ow" }))
            .unwrap()
            .unwrap();
        let content = row
            .get("trace")
            .and_then(|v| v.as_array())
            .and_then(|a| a.first())
            .and_then(|v| v.get("content"))
            .and_then(|v| v.as_str());
        assert_eq!(content, Some("2"), "覆盖后应读到最新一次 checkpoint");
        let _ = std::fs::remove_file(db);
    }
}

mod agent;
mod keyword;
mod misc;
mod schema;

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::config::AppConfig;
use crate::embedding::{self, EmbeddingConfig};
use crate::error::CoreError;

const MEMORY_EMBED_TEXT_MAX: usize = 6000;
const GLOBAL_MEMORY_SCOPE: &str = "global";

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

#[derive(Clone)]
pub struct MemoryStore {
    db_path: PathBuf,
    embedding: std::sync::Arc<Mutex<EmbeddingConfig>>,
    models_dirs: std::sync::Arc<Mutex<Vec<PathBuf>>>,
    conn: std::sync::Arc<Mutex<Connection>>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionRow {
    pub id: String,
    pub updated_at: i64,
    pub title: Option<String>,
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
    pub fn open(
        db_path: PathBuf,
        embedding: EmbeddingConfig,
        models_dirs: Vec<PathBuf>,
    ) -> Result<Self, CoreError> {
        if let Some(parent) = db_path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| CoreError::rpc("DB_OPEN_FAILED", e.to_string()))?;
        }
        let conn = Connection::open(&db_path)
            .map_err(|e| CoreError::rpc("DB_OPEN_FAILED", e.to_string()))?;
        conn.pragma_update(None, "journal_mode", "WAL")
            .map_err(|e| CoreError::rpc("DB_OPEN_FAILED", e.to_string()))?;
        conn.pragma_update(None, "foreign_keys", "ON")
            .map_err(|e| CoreError::rpc("DB_OPEN_FAILED", e.to_string()))?;
        schema::init_schema(&conn)?;
        let store = Self {
            db_path: db_path.clone(),
            embedding: std::sync::Arc::new(Mutex::new(embedding)),
            models_dirs: std::sync::Arc::new(Mutex::new(models_dirs)),
            conn: std::sync::Arc::new(Mutex::new(conn)),
        };
        // 后台修剪，勿阻塞 serve-stdio 启动（4GB 库同步 DELETE 可卡数十秒）
        Self::spawn_prune_surplus_agent_traces(db_path);
        Ok(store)
    }

    fn spawn_prune_surplus_agent_traces(db_path: PathBuf) {
        std::thread::Builder::new()
            .name("dieyun-memory-prune".into())
            .spawn(move || {
                let Ok(conn) = Connection::open(&db_path) else {
                    return;
                };
                let _ = conn.busy_timeout(std::time::Duration::from_secs(30));
                let _ = Self::prune_surplus_agent_traces(&conn);
            })
            .ok();
    }

    /// Keep at most 2 newest traces per run; drop oldest extras when table is huge.
    fn prune_surplus_agent_traces(conn: &Connection) -> Result<(), CoreError> {
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM agent_traces", [], |r| r.get(0))
            .unwrap_or(0);
        if count < 4_000 {
            return Ok(());
        }
        // SQLite 3.25+ window functions
        conn.execute_batch(
            r#"
            DELETE FROM agent_traces
            WHERE id NOT IN (
              SELECT id FROM (
                SELECT id,
                       ROW_NUMBER() OVER (PARTITION BY run_id ORDER BY id DESC) AS rn
                FROM agent_traces
              )
              WHERE rn <= 2
            );
            "#,
        )
        .map_err(|e| CoreError::rpc("DB_PRUNE_FAILED", e.to_string()))?;
        Ok(())
    }

    pub fn from_config(config: &AppConfig) -> Result<Self, CoreError> {
        Self::open(
            config.memory_db_path(),
            config.embedding.clone(),
            config.models_dirs.clone(),
        )
    }

    pub fn db_path(&self) -> &Path {
        &self.db_path
    }

    pub fn ping(&self) -> Value {
        let (embedding, models_dirs) = self.embedding_pair();
        json!({
            "ok": true,
            "engine": "rust",
            "dbPath": self.db_path.to_string_lossy(),
            "embeddingEnabled": embedding.enabled(&models_dirs),
        })
    }

    /// Update embedding settings without reopening the (possibly huge) SQLite file.
    pub fn set_embedding(&self, embedding: EmbeddingConfig, models_dirs: Vec<PathBuf>) {
        if let Ok(mut g) = self.embedding.lock() {
            *g = embedding;
        }
        if let Ok(mut g) = self.models_dirs.lock() {
            *g = models_dirs;
        }
    }

    fn embedding_pair(&self) -> (EmbeddingConfig, Vec<PathBuf>) {
        let embedding = self
            .embedding
            .lock()
            .map(|g| g.clone())
            .unwrap_or_default();
        let models_dirs = self
            .models_dirs
            .lock()
            .map(|g| g.clone())
            .unwrap_or_default();
        (embedding, models_dirs)
    }

    fn with_conn<T, F>(&self, f: F) -> Result<T, CoreError>
    where
        F: FnOnce(&Connection) -> Result<T, CoreError>,
    {
        let guard = self
            .conn
            .lock()
            .map_err(|_| CoreError::rpc("DB_LOCK", "memory db lock poisoned"))?;
        f(&guard)
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
                        "INSERT INTO sessions (id, updated_at, title) VALUES (?1, ?2, ?3)
                         ON CONFLICT(id) DO UPDATE SET
                           updated_at = excluded.updated_at,
                           title = CASE
                             WHEN sessions.title IS NULL
                               OR sessions.title = '对话'
                               OR sessions.title = '新对话'
                               OR sessions.title LIKE '【叠云meta】%'
                               OR (sessions.title LIKE '{%' AND sessions.title LIKE '%inputText%')
                             THEN excluded.title
                             ELSE sessions.title
                           END",
                        params![session_id, now, sanitized],
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

    pub fn list_sessions(&self, limit: i64, archived: bool) -> Result<Vec<SessionRow>, CoreError> {
        self.with_conn(|conn| {
            let mut stmt = conn.prepare(
                "SELECT s.id, s.updated_at, s.title,
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
                        archived: row.get::<_, i64>(3)? != 0,
                        workspace_path: row.get(4)?,
                        preview: row.get(5)?,
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
                                "UPDATE sessions SET title = ?1 WHERE id = ?2",
                                params![t, row.id],
                            );
                            row.title = Some(t);
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
                    "SELECT id, updated_at, title, COALESCE(archived,0), workspace_path
                     FROM sessions WHERE id = ?1",
                    params![session_id],
                    |row| {
                        Ok(SessionRow {
                            id: row.get(0)?,
                            updated_at: row.get(1)?,
                            title: row.get(2)?,
                            archived: row.get::<_, i64>(3)? != 0,
                            workspace_path: row.get(4)?,
                            preview: None,
                        })
                    },
                )
                .optional()?)
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
    ) -> Result<AppendMessageResult, CoreError> {
        let now = now_ms();
        self.with_conn(|conn| {
            conn.execute(
                "INSERT INTO messages (session_id, role, content, created_at) VALUES (?1, ?2, ?3, ?4)",
                params![session_id, role, content, now],
            )?;
            let id = conn.last_insert_rowid();
            conn.execute(
                "UPDATE sessions SET updated_at = ?1 WHERE id = ?2",
                params![now, session_id],
            )?;
            if role == "user" {
                maybe_set_title_from_user_message(conn, session_id, content)?;
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
                "SELECT id, session_id, role, content, created_at
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
                        created_at: row.get(4)?,
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
                "SELECT id, session_id, role, content, created_at
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
                        created_at: row.get(4)?,
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
                         status = CASE WHEN status = 'archived' THEN 'active' ELSE status END
                     WHERE id = ?3",
                    params![now, source, existing],
                )?;
                return Ok(json!({ "localMemoryId": existing, "duplicate": true }));
            }
            conn.execute(
                "INSERT INTO long_memories
                  (content, source, scope, kind, importance, status, created_at, updated_at, expires_at, metadata_json)
                 VALUES (?1, ?2, ?3, ?4, ?5, 'active', ?6, ?6, ?7, ?8)",
                params![
                    normalized,
                    source,
                    scope,
                    kind,
                    importance,
                    now,
                    expires_at.filter(|v| *v > 0),
                    metadata_json
                ],
            )?;
            Ok(json!({ "localMemoryId": conn.last_insert_rowid() }))
        })
    }

    pub fn recent_long_memories(
        &self,
        limit: i64,
        scope: Option<&str>,
    ) -> Result<Vec<Value>, CoreError> {
        let now = now_ms();
        self.with_conn(|conn| {
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
        let (embedding, models_dirs) = self.embedding_pair();
        let sig = embedding.signature(&models_dirs);
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
        let (embedding, models_dirs) = self.embedding_pair();
        if !embedding.enabled(&models_dirs) {
            return Ok(json!({ "ok": false, "indexed": false, "reason": "embedding_disabled" }));
        }
        let text = content
            .chars()
            .take(MEMORY_EMBED_TEXT_MAX)
            .collect::<String>();
        let vectors = embedding::embed_texts(&embedding, &models_dirs, &[text]).await?;
        let vector = vectors.into_iter().next().unwrap_or_default();
        if vector.is_empty() {
            return Ok(json!({ "ok": false, "indexed": false, "reason": "embedding_failed" }));
        }
        let sig = embedding.signature(&models_dirs);
        let dims = embedding.effective_dimensions(&models_dirs);
        let blob = embedding::vector_to_blob(&vector);
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
        let (embedding, models_dirs) = self.embedding_pair();
        if !embedding.enabled(&models_dirs) {
            return Ok(json!({ "ok": false, "indexed": 0, "reason": "embedding_disabled" }));
        }
        let sig = embedding.signature(&models_dirs);
        let dims = embedding.effective_dimensions(&models_dirs);
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
        for (id, content) in rows {
            let text = content
                .chars()
                .take(MEMORY_EMBED_TEXT_MAX)
                .collect::<String>();
            let vectors =
                embedding::embed_texts(&embedding, &models_dirs, &[text]).await?;
            let vector = vectors.into_iter().next().unwrap_or_default();
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
        let lim = limit.clamp(1, 50);
        let q_lower = q.to_lowercase();
        let q_tokens = keyword::tokenize_memory(q);
        let now = now_ms();
        self.with_conn(|conn| {
            let mut stmt = conn.prepare(
                "SELECT id, content, source, scope, kind, importance, status, created_at
                 FROM long_memories
                 WHERE status IN ('active', 'stale')
                   AND (expires_at IS NULL OR expires_at <= 0 OR expires_at > ?1)
                 ORDER BY id DESC
                 LIMIT 1000",
            )?;
            let mut scored: Vec<(f64, i64, Value)> = Vec::new();
            for row in stmt.query_map(params![now], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, Option<String>>(4)?,
                    row.get::<_, i64>(5)?,
                    row.get::<_, String>(6)?,
                    row.get::<_, i64>(7)?,
                ))
            })? {
                let (id, content, source, scope, kind, importance, status, created_at) = row?;
                let score = keyword::keyword_score_row(
                    &q_tokens,
                    &q_lower,
                    &content,
                    source.as_deref(),
                    scope.as_deref(),
                    kind.as_deref(),
                    importance,
                    &status,
                    created_at,
                    now,
                );
                if score <= 0.05 {
                    continue;
                }
                let rounded = (score * 1000.0).round() / 1000.0;
                scored.push((
                    score,
                    id,
                    json!({
                        "id": id,
                        "content": content,
                        "source": source,
                        "scope": scope,
                        "kind": kind,
                        "importance": importance,
                        "status": status,
                        "created_at": created_at,
                        "score": rounded,
                    }),
                ));
            }
            scored.sort_by(|a, b| {
                b.0.partial_cmp(&a.0)
                    .unwrap_or(std::cmp::Ordering::Equal)
                    .then(b.1.cmp(&a.1))
            });
            let total = scored.len();
            let results: Vec<Value> = scored
                .into_iter()
                .take(lim as usize)
                .map(|(_, _, v)| v)
                .collect();
            Ok(json!({
                "ok": true,
                "mode": "keyword",
                "results": results,
                "totalCandidates": total,
            }))
        })
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
            return Ok(json!({ "ok": true, "mode": "recent", "results": results }));
        }
        if {
            let (embedding, models_dirs) = self.embedding_pair();
            embedding.enabled(&models_dirs)
        } {
            let (embedding, models_dirs) = self.embedding_pair();
            let vectors =
                embedding::embed_texts(&embedding, &models_dirs, &[q.to_string()])
                    .await?;
            let query_vec = vectors.into_iter().next().unwrap_or_default();
            if !query_vec.is_empty() {
                let semantic = self.semantic_search_long(scope_str, &query_vec, limit)?;
                if !semantic.is_empty() {
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
            return Ok(json!({
                "ok": true,
                "mode": "keyword",
                "results": keyword,
            }));
        }
        Ok(json!({ "ok": true, "mode": "none", "results": [] }))
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
        self.with_conn(|conn| {
            let now = now_ms();
            let n: i64 = if is_global_memory_scope(scope_filter) {
                conn.query_row(&sql, params![now], |r| r.get(0))?
            } else {
                conn.query_row(&sql, params![now, scope_filter], |r| r.get(0))?
            };
            Ok(n)
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
        let lim = limit.clamp(1, 50);
        let q_lower = q.to_lowercase();
        let q_tokens = keyword::tokenize_memory(q);
        let now = now_ms();
        let scope_filter = scope.trim();
        let sql = format!(
            "SELECT id, content, source, scope, kind, importance, status, created_at
             FROM long_memories
             WHERE status IN ('active', 'stale')
               AND (expires_at IS NULL OR expires_at <= 0 OR expires_at > ?1)
               AND {}
             ORDER BY id DESC
             LIMIT 1000",
            long_memory_scope_filter("scope", scope_filter, 2)
        );
        self.with_conn(|conn| {
            let mut scored: Vec<(f64, i64, Value)> = Vec::new();
            let mut stmt = conn.prepare(&sql)?;
            let rows: Vec<LongMemKeywordRow> = if is_global_memory_scope(scope_filter) {
                stmt.query_map(params![now], map_long_mem_keyword_row)?
                    .collect::<Result<Vec<_>, _>>()?
            } else {
                stmt.query_map(params![now, scope_filter], map_long_mem_keyword_row)?
                    .collect::<Result<Vec<_>, _>>()?
            };
            for (id, content, source, scope, kind, importance, status, created_at) in rows {
                let score = keyword::keyword_score_row(
                    &q_tokens,
                    &q_lower,
                    &content,
                    source.as_deref(),
                    scope.as_deref(),
                    kind.as_deref(),
                    importance,
                    &status,
                    created_at,
                    now,
                );
                if score <= 0.05 {
                    continue;
                }
                let rounded = (score * 1000.0).round() / 1000.0;
                scored.push((
                    score,
                    id,
                    json!({
                        "id": id,
                        "content": content,
                        "source": source,
                        "createdAt": created_at,
                        "scope": scope,
                        "kind": kind,
                        "importance": importance,
                        "status": status,
                        "score": rounded,
                        "vectorSearch": false,
                    }),
                ));
            }
            scored.sort_by(|a, b| {
                b.0.partial_cmp(&a.0)
                    .unwrap_or(std::cmp::Ordering::Equal)
                    .then(b.1.cmp(&a.1))
            });
            Ok(scored
                .into_iter()
                .take(lim as usize)
                .map(|(_, _, v)| v)
                .collect())
        })
    }

    fn semantic_search_long(
        &self,
        scope: &str,
        query_vec: &[f32],
        limit: i64,
    ) -> Result<Vec<Value>, CoreError> {
        let (embedding, models_dirs) = self.embedding_pair();
        let sig = embedding.signature(&models_dirs);
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
        self.with_conn(|conn| {
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
                if score <= 0.05 {
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
            "UPDATE sessions SET title = ?1 WHERE id = ?2",
            params![t, session_id],
        )?;
    }
    Ok(())
}

fn title_needs_repair(title: Option<&str>) -> bool {
    match title.map(str::trim).filter(|s| !s.is_empty()) {
        None => true,
        Some("对话") | Some("新对话") => true,
        Some(t) if t.starts_with("【叠云meta】") => true,
        Some(t) if t.starts_with('{') && t.contains("inputText") => true,
        Some(_) => false,
    }
}

pub(crate) fn strip_message_meta(content: &str) -> &str {
    let s = content.trim();
    if let Some(rest) = s.strip_prefix("【叠云meta】") {
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

    #[test]
    fn memory_roundtrip() {
        let db = std::env::temp_dir().join(format!("dieyun-mem-test-{}.sqlite", now_ms()));
        let _ = std::fs::remove_file(&db);
        let store = MemoryStore::open(db.clone(), EmbeddingConfig::default(), vec![]).unwrap();
        let session = store.create_session(Some("测试"), None).unwrap();
        store
            .append_message(&session.id, "user", "你好，Rust memory")
            .unwrap();
        let msgs = store.recent_messages(&session.id, 10).unwrap();
        assert_eq!(msgs.len(), 1);
        assert_eq!(msgs[0].role, "user");
        let _ = std::fs::remove_file(db);
    }
}

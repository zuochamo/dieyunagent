use rusqlite::Connection;

use crate::error::CoreError;

pub fn init_schema(conn: &Connection) -> Result<(), CoreError> {
    conn.execute_batch(
        r#"
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        updated_at INTEGER NOT NULL,
        title TEXT
      );
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(id)
      );
      CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, created_at);
      CREATE TABLE IF NOT EXISTS long_memories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        content TEXT NOT NULL,
        source TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS long_memory_vectors (
        memory_id INTEGER PRIMARY KEY,
        model TEXT NOT NULL,
        dimensions INTEGER NOT NULL,
        vector BLOB NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY(memory_id) REFERENCES long_memories(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS memory_consolidation_jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        scope TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        reason TEXT,
        started_at INTEGER,
        finished_at INTEGER,
        error TEXT
      );
      CREATE TABLE IF NOT EXISTS agent_runs (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        user_message_id INTEGER,
        assistant_message_id INTEGER,
        status TEXT NOT NULL DEFAULT 'running',
        summary TEXT,
        state_snapshot TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_agent_runs_session ON agent_runs(session_id, updated_at);
      -- 周期修剪按 updated_at 排序 + 按时间截断，没有它就要全表扫并排序
      CREATE INDEX IF NOT EXISTS idx_agent_runs_updated ON agent_runs(updated_at);
      CREATE TABLE IF NOT EXISTS agent_traces (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        message_id INTEGER,
        phase TEXT,
        trace_json TEXT NOT NULL,
        trace_text TEXT,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (run_id) REFERENCES agent_runs(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_agent_traces_run ON agent_traces(run_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_agent_traces_message ON agent_traces(message_id, created_at);
      CREATE TABLE IF NOT EXISTS agent_plans (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL DEFAULT 'planned',
        parent_plan_id TEXT,
        summary TEXT,
        plan_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (run_id) REFERENCES agent_runs(id) ON DELETE CASCADE,
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
        FOREIGN KEY (parent_plan_id) REFERENCES agent_plans(id) ON DELETE SET NULL
      );
      CREATE INDEX IF NOT EXISTS idx_agent_plans_run ON agent_plans(run_id, version);
      CREATE INDEX IF NOT EXISTS idx_agent_plans_session ON agent_plans(session_id, updated_at);
      CREATE TABLE IF NOT EXISTS agent_steps (
        id TEXT PRIMARY KEY,
        plan_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        step_number INTEGER NOT NULL,
        step_key TEXT,
        worker TEXT,
        agent_type TEXT,
        title TEXT,
        instruction TEXT,
        expected_output TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        result_json TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        completed_at INTEGER,
        FOREIGN KEY (plan_id) REFERENCES agent_plans(id) ON DELETE CASCADE,
        FOREIGN KEY (run_id) REFERENCES agent_runs(id) ON DELETE CASCADE,
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_agent_steps_plan ON agent_steps(plan_id, step_number);
      CREATE INDEX IF NOT EXISTS idx_agent_steps_run ON agent_steps(run_id, step_number);
      CREATE TABLE IF NOT EXISTS compaction_archives (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT,
        workspace_path TEXT,
        tokens_before INTEGER,
        tokens_after INTEGER,
        summary_text TEXT,
        summary_json TEXT,
        folded_text TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_compaction_archives_session
        ON compaction_archives(session_id, created_at);
    "#,
    )
    .map_err(|e| CoreError::rpc("DB_SCHEMA_FAILED", e.to_string()))?;

    let _ = conn.execute(
        "ALTER TABLE sessions ADD COLUMN archived INTEGER NOT NULL DEFAULT 0",
        [],
    );
    let _ = conn.execute("ALTER TABLE sessions ADD COLUMN workspace_path TEXT", []);
    let _ = conn.execute(
        "ALTER TABLE long_memories ADD COLUMN scope TEXT DEFAULT 'global'",
        [],
    );
    let _ = conn.execute(
        "ALTER TABLE long_memories ADD COLUMN kind TEXT DEFAULT 'normal'",
        [],
    );
    let _ = conn.execute(
        "ALTER TABLE long_memories ADD COLUMN importance INTEGER DEFAULT 3",
        [],
    );
    let _ = conn.execute(
        "ALTER TABLE long_memories ADD COLUMN status TEXT DEFAULT 'active'",
        [],
    );
    let _ = conn.execute(
        "ALTER TABLE long_memories ADD COLUMN updated_at INTEGER",
        [],
    );
    let _ = conn.execute(
        "ALTER TABLE long_memories ADD COLUMN last_used_at INTEGER",
        [],
    );
    let _ = conn.execute(
        "ALTER TABLE long_memories ADD COLUMN access_count INTEGER DEFAULT 0",
        [],
    );
    let _ = conn.execute(
        "ALTER TABLE long_memories ADD COLUMN expires_at INTEGER",
        [],
    );
    let _ = conn.execute(
        "ALTER TABLE long_memories ADD COLUMN metadata_json TEXT",
        [],
    );
    let _ = conn.execute(
        "ALTER TABLE compaction_archives ADD COLUMN folded_text TEXT",
        [],
    );

    conn.execute_batch(
        r#"
      CREATE INDEX IF NOT EXISTS idx_long_memories_status ON long_memories(status, id);
      CREATE INDEX IF NOT EXISTS idx_long_memories_kind ON long_memories(kind);
      CREATE INDEX IF NOT EXISTS idx_long_memories_last_used ON long_memories(last_used_at);
    "#,
    )
    .map_err(|e| CoreError::rpc("DB_SCHEMA_FAILED", e.to_string()))?;

    Ok(())
}

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
        -- 该轮真思考：与 content 分列，绝不混进正文。
        -- 默认不进历史重建（见 session-context.buildCompletionMessagesFromHistory），
        -- 只在该轮需要上行回传（reasoning_content）时按需取真值。
        reasoning TEXT,
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
      -- 会话交接：每个会话最多一份（重生成覆盖），供新会话「继续上次」精确取回。
      -- 与 long_memories 不同：不参与语义召回，只按 session_id 精确读写。
      CREATE TABLE IF NOT EXISTS session_handoffs (
        session_id TEXT PRIMARY KEY,
        title TEXT NOT NULL DEFAULT '',
        payload TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_session_handoffs_created ON session_handoffs(created_at);
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
      -- 请求快照：每轮真正发往 LLM 的请求信封（"模型看到了什么"的唯一留底）。
      -- 定位是**旁路事实**而非真相来源：可裁剪、可丢失、不参与 replay；
      -- 真相仍是 messages / compaction_archives。字段语义见 docs/REQUEST-SNAPSHOT.md。
      CREATE TABLE IF NOT EXISTS request_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        run_id TEXT,
        round INTEGER,
        source TEXT,
        created_at INTEGER NOT NULL,
        model TEXT,
        stream INTEGER,
        messages_json TEXT NOT NULL,
        messages_chars INTEGER,
        message_count INTEGER,
        messages_hash TEXT,
        truncated INTEGER NOT NULL DEFAULT 0,
        system_hash TEXT,
        system_chars INTEGER,
        system_text TEXT,
        tools_hash TEXT,
        tools_names TEXT,
        tools_json TEXT,
        est_tokens INTEGER,
        token_budget INTEGER,
        trigger_ratio REAL,
        compaction_round_count INTEGER,
        compacted INTEGER NOT NULL DEFAULT 0,
        tokens_before INTEGER,
        tokens_after INTEGER,
        compaction_archive_id INTEGER,
        reason TEXT,
        context_audit_json TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_reqsnap_session ON request_snapshots(session_id, id);
      CREATE INDEX IF NOT EXISTS idx_reqsnap_created ON request_snapshots(created_at);
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
    // 旧库补列：真思考与 content 分列存储（老数据为 NULL，回传时降级为占位）。
    let _ = conn.execute("ALTER TABLE messages ADD COLUMN reasoning TEXT", []);
    // 旧库删列：`trace_text` 是「思考拼成的纯文本」——两个生产者（Renderer / Main）、读者为零，
    // 已按思考通道隔离 §3.7 D4 整体废除。best-effort：SQLite < 3.35 时语法失败也无妨，
    // 那只是老库留一个空列，而读写两侧都已不再碰它。
    let _ = conn.execute("ALTER TABLE agent_traces DROP COLUMN trace_text", []);

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

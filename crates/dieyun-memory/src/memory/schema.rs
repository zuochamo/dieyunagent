use rusqlite::Connection;

use dieyun_base::error::CoreError;

/// `sessions` 的列清单（建表与补列的唯一来源；顺序 = 建表顺序 + 历史加列顺序）。
const SESSIONS_COLUMNS: &[dieyun_base::db_schema::Column] = &[
    dieyun_base::db_schema::Column::new("id", "TEXT PRIMARY KEY"),
    dieyun_base::db_schema::Column::new("updated_at", "INTEGER NOT NULL"),
    dieyun_base::db_schema::Column::new("title", "TEXT"),
    dieyun_base::db_schema::Column::new("archived", "INTEGER NOT NULL DEFAULT 0"),
    dieyun_base::db_schema::Column::new("workspace_path", "TEXT"),
    dieyun_base::db_schema::Column::new("title_source", "TEXT"),
];

/// `messages` 的列清单（建表与补列的唯一来源；顺序 = 建表顺序 + 历史加列顺序）。
const MESSAGES_COLUMNS: &[dieyun_base::db_schema::Column] = &[
    dieyun_base::db_schema::Column::new("id", "INTEGER PRIMARY KEY AUTOINCREMENT"),
    dieyun_base::db_schema::Column::new("session_id", "TEXT NOT NULL"),
    dieyun_base::db_schema::Column::new("role", "TEXT NOT NULL"),
    dieyun_base::db_schema::Column::new("content", "TEXT NOT NULL"),
    dieyun_base::db_schema::Column::new("reasoning", "TEXT"),
    dieyun_base::db_schema::Column::new("created_at", "INTEGER NOT NULL"),
];

/// `long_memories` 的列清单（建表与补列的唯一来源；顺序 = 建表顺序 + 历史加列顺序）。
const LONG_MEMORIES_COLUMNS: &[dieyun_base::db_schema::Column] = &[
    dieyun_base::db_schema::Column::new("id", "INTEGER PRIMARY KEY AUTOINCREMENT"),
    dieyun_base::db_schema::Column::new("content", "TEXT NOT NULL"),
    dieyun_base::db_schema::Column::new("source", "TEXT"),
    dieyun_base::db_schema::Column::new("created_at", "INTEGER NOT NULL"),
    dieyun_base::db_schema::Column::new("scope", "TEXT DEFAULT 'global'"),
    dieyun_base::db_schema::Column::new("kind", "TEXT DEFAULT 'normal'"),
    dieyun_base::db_schema::Column::new("importance", "INTEGER DEFAULT 3"),
    dieyun_base::db_schema::Column::new("status", "TEXT DEFAULT 'active'"),
    dieyun_base::db_schema::Column::new("updated_at", "INTEGER"),
    dieyun_base::db_schema::Column::new("last_used_at", "INTEGER"),
    dieyun_base::db_schema::Column::new("access_count", "INTEGER DEFAULT 0"),
    dieyun_base::db_schema::Column::new("expires_at", "INTEGER"),
    dieyun_base::db_schema::Column::new("metadata_json", "TEXT"),
    dieyun_base::db_schema::Column::new("session_id", "TEXT"),
];

/// `compaction_archives` 的列清单（建表与补列的唯一来源；顺序 = 建表顺序 + 历史加列顺序）。
const COMPACTION_ARCHIVES_COLUMNS: &[dieyun_base::db_schema::Column] = &[
    dieyun_base::db_schema::Column::new("id", "INTEGER PRIMARY KEY AUTOINCREMENT"),
    dieyun_base::db_schema::Column::new("session_id", "TEXT"),
    dieyun_base::db_schema::Column::new("workspace_path", "TEXT"),
    dieyun_base::db_schema::Column::new("tokens_before", "INTEGER"),
    dieyun_base::db_schema::Column::new("tokens_after", "INTEGER"),
    dieyun_base::db_schema::Column::new("summary_text", "TEXT"),
    dieyun_base::db_schema::Column::new("summary_json", "TEXT"),
    dieyun_base::db_schema::Column::new("folded_text", "TEXT"),
    dieyun_base::db_schema::Column::new("created_at", "INTEGER NOT NULL"),
];

pub fn init_schema(conn: &Connection) -> Result<(), CoreError> {
    conn.execute_batch(
        r#"
      CREATE TABLE IF NOT EXISTS long_memory_vectors (
        memory_id INTEGER PRIMARY KEY,
        model TEXT NOT NULL,
        dimensions INTEGER NOT NULL,
        vector BLOB NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY(memory_id) REFERENCES long_memories(id) ON DELETE CASCADE
      );
      -- 项目身份（scope = project:<id> 的唯一来源，见 memory/projects.rs）。
      -- 不再把路径编进 scope：改目录名、大小写差异、worktree 入口都应指向同一个项目。
      CREATE TABLE IF NOT EXISTS projects (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        root_path TEXT NOT NULL,
        -- git remote.origin.url：仓库搬家/换盘符时靠它把新路径挂成别名（Node 侧探测后传入）
        git_origin TEXT,
        created_at INTEGER NOT NULL,
        last_seen_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_projects_origin ON projects(git_origin);
      -- 见过的每个路径（别名）：path_key = 规范化后的小写路径，唯一
      CREATE TABLE IF NOT EXISTS project_paths (
        path_key TEXT PRIMARY KEY,
        project_id INTEGER NOT NULL,
        path TEXT NOT NULL,
        first_seen_at INTEGER NOT NULL,
        FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_project_paths_project ON project_paths(project_id);
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
      -- 会话级目标对象：一个会话最多一条（PK 即约束），删会话级联清除。
      -- goal_json 是**不透明 JSON**：Rust 只当 KV，语义（归一化 / 事实核对 / 续跑判定）
      -- 全在 Node 的 src/plans/goal-run.js —— 不允许在 Rust 再解析一份。
      -- 也不进 sessions_list 投影：目标只在开会话 / 起轮时按 sessionId 精确取。
      CREATE TABLE IF NOT EXISTS session_goals (
        session_id TEXT PRIMARY KEY,
        goal_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );
    "#,
    )
    .map_err(|e| CoreError::rpc("DB_SCHEMA_FAILED", e.to_string()))?;

    // 这四张表「建表 + 后加列」只有一份清单：老库补列走同一条 `ensure_table`,
    // 不再手写 `ALTER TABLE ADD COLUMN`（两处漂移时只有老库坏，开发机上永远看不出来）。
    dieyun_base::db_schema::ensure_table(
        conn,
        "sessions",
        SESSIONS_COLUMNS,
        &[],
    )?;
    dieyun_base::db_schema::ensure_table(
        conn,
        "messages",
        MESSAGES_COLUMNS,
        &["FOREIGN KEY (session_id) REFERENCES sessions(id)"],
    )?;
    dieyun_base::db_schema::ensure_table(
        conn,
        "long_memories",
        LONG_MEMORIES_COLUMNS,
        &[],
    )?;
    dieyun_base::db_schema::ensure_table(
        conn,
        "compaction_archives",
        COMPACTION_ARCHIVES_COLUMNS,
        &[],
    )?;

    // 会话标题的来源（heuristic = 首条用户消息切片，ai = 模型总结，user = 用户改名）。
    // 存在的理由只有一个：AI 标题**每会话只生成一次** —— 没有这一列就只能在
    // 「是不是首轮」「标题像不像模型写的」上猜，猜错的代价是每次开话题都重新调一次模型。
    // 写入溯源：这条记忆是哪个会话沉淀下来的。
    // 存在的理由只有一个 —— 「这个会话沉淀了什么 / 把这个会话写的都忘掉」必须可查，
    // metadata_json 里的 sessionId 是 JSON，做过滤要么 LIKE 猜串要么开 JSON1，
    // 两者都不如一个带索引的一等列。旧行为 NULL（不影响召回与注入）。
    // 旧库补列：真思考与 content 分列存储（老数据为 NULL，回传时降级为占位）。
    // 旧库删列：`trace_text` 是「思考拼成的纯文本」——两个生产者（Renderer / Main）、读者为零，
    // 已按思考通道隔离 §3.7 D4 整体废除。best-effort：SQLite < 3.35 时语法失败也无妨，
    // 那只是老库留一个空列，而读写两侧都已不再碰它。
    drop_column_if_exists(conn, "agent_traces", "trace_text")?;

    conn.execute_batch(
        r#"
      CREATE INDEX IF NOT EXISTS idx_long_memories_status ON long_memories(status, id);
      CREATE INDEX IF NOT EXISTS idx_long_memories_kind ON long_memories(kind);
      CREATE INDEX IF NOT EXISTS idx_long_memories_last_used ON long_memories(last_used_at);
      CREATE INDEX IF NOT EXISTS idx_long_memories_session ON long_memories(session_id, id);
      -- 这两张表改成声明式建表（`ensure_table`）了，索引必须等表建好之后再建：
      -- 放在第一批里会变成「先建索引后建表」→ `no such table: main.messages`。
      CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_compaction_archives_session
        ON compaction_archives(session_id, created_at);
    "#,
    )
    .map_err(|e| CoreError::rpc("DB_SCHEMA_FAILED", e.to_string()))?;

    // ---- 长记忆全文索引（FTS5 + trigram）----
    //
    // 取代原先「取 1000 行到 Rust 里做 CJK unigram/bigram 手写打分」的检索
    // （`memory/keyword.rs`，已删除）：那种实现既扫不全（`LIMIT 1000` 之外的记忆
    // 永远检索不到），又把分词规则抄成第二套。trigram 分词器对中文与标识符都是
    // 子串级召回（`索引` 命中「代码库索引」，`onfig` 命中 `parseConfig`），
    // 与 index 侧 `chunks_fts` 同一口径。
    //
    // 外部内容表 + 触发器：不复制正文，增删改由触发器保证一致。
    conn.execute_batch(
        r#"
      CREATE VIRTUAL TABLE IF NOT EXISTS long_memories_fts USING fts5(
        content, source, scope, kind,
        content='long_memories', content_rowid='id',
        tokenize='trigram'
      );
      CREATE TRIGGER IF NOT EXISTS long_memories_fts_ai AFTER INSERT ON long_memories BEGIN
        INSERT INTO long_memories_fts(rowid, content, source, scope, kind)
        VALUES (new.id, new.content, COALESCE(new.source, ''), COALESCE(new.scope, ''), COALESCE(new.kind, ''));
      END;
      CREATE TRIGGER IF NOT EXISTS long_memories_fts_ad AFTER DELETE ON long_memories BEGIN
        INSERT INTO long_memories_fts(long_memories_fts, rowid, content, source, scope, kind)
        VALUES ('delete', old.id, old.content, COALESCE(old.source, ''), COALESCE(old.scope, ''), COALESCE(old.kind, ''));
      END;
      CREATE TRIGGER IF NOT EXISTS long_memories_fts_au AFTER UPDATE ON long_memories BEGIN
        INSERT INTO long_memories_fts(long_memories_fts, rowid, content, source, scope, kind)
        VALUES ('delete', old.id, old.content, COALESCE(old.source, ''), COALESCE(old.scope, ''), COALESCE(old.kind, ''));
        INSERT INTO long_memories_fts(rowid, content, source, scope, kind)
        VALUES (new.id, new.content, COALESCE(new.source, ''), COALESCE(new.scope, ''), COALESCE(new.kind, ''));
      END;
    "#,
    )
    .map_err(|e| CoreError::rpc("DB_SCHEMA_FAILED", e.to_string()))?;

    // 会话正文的检索索引（`memory.messages_search` / 工具 `session_recall`）。
    //
    // 与 `long_memories_fts` 完全同构：external content + 三触发器 + trigram，
    // 只索引正文（role / 会话 / 工作区信息从 `messages`、`sessions` JOIN 得，
    // 复制进索引只会多一处要维护的一致性）。
    //
    // 为什么值得建：`messages` 是唯一存储了「人和模型实际说过什么」的地方，
    // 没有它，跨会话的「上次这事怎么聊的」只能靠模型翻 UI 或用户自己贴。
    conn.execute_batch(
        r#"
      CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
        content,
        content='messages', content_rowid='id',
        tokenize='trigram'
      );
      CREATE TRIGGER IF NOT EXISTS messages_fts_ai AFTER INSERT ON messages BEGIN
        INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
      END;
      CREATE TRIGGER IF NOT EXISTS messages_fts_ad AFTER DELETE ON messages BEGIN
        INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.id, old.content);
      END;
      CREATE TRIGGER IF NOT EXISTS messages_fts_au AFTER UPDATE ON messages BEGIN
        INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.id, old.content);
        INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
      END;
    "#,
    )
    .map_err(|e| CoreError::rpc("DB_SCHEMA_FAILED", e.to_string()))?;

    // 写入探针：唯一一处「索引到底建全了没有」的判定，也是唯一一处修复。
    // 两张 FTS 表共用同一份判定与修复实现（`ensure_fts_ready`），不再各写一套。
    //
    // 这里曾经有一条「`COUNT(*) FROM <fts>` 与源表不一致就 rebuild」的守卫，
    // 它是**死代码**：external content 表（`content='<源表>'`）的 count(*) 走的就是源表扫描，
    // 索引空着也是同一个数 —— 于是「老库首次建 FTS，索引空、源表 1694 行」这个真实场景
    // 永远触发不了 rebuild。删掉它，判定只留探针一份。
    //
    // 探针失败的含义（FTS5 只报一句笼统的 `database disk image is malformed`，别被它骗了）：
    // 触发器的 delete 路径找不到这篇 doc —— 最常见就是「索引根本没建」。此时 INSERT 仍然成功，
    // 读也正常，只有 UPDATE / DELETE 报错，所以表面症状是「写不进去」，而其它表照旧。
    ensure_fts_ready(conn, "long_memories", "long_memories_fts");
    ensure_fts_ready(conn, "messages", "messages_fts");

    Ok(())
}

/// 探查一张 FTS 源表的写入路径，坏了就 `rebuild` 一次再探。
///
/// 表名都是本模块里的字面量常量（SQLite 不支持标识符参数化），不来自外部输入。
fn ensure_fts_ready(conn: &Connection, source_table: &str, fts_table: &str) {
    if fts_write_probe(conn, source_table) {
        return;
    }
    let rebuild = format!("INSERT INTO {fts_table}({fts_table}) VALUES('rebuild')");
    let rebuilt = conn.execute(&rebuild, []).is_ok();
    if !rebuilt || !fts_write_probe(conn, source_table) {
        eprintln!(
            "[dieyun:memory] FTS 索引重建后写入仍失败：{source_table} 的写入路径可能已被其它损坏阻塞"
        );
    }
}

/// 「这张源表的写入路径还能不能写」的探针：能否写都要把连接留在 autocommit。
///
/// 用 rusqlite 的 [`rusqlite::Transaction`] 而不是手写
/// `SAVEPOINT …; UPDATE …; ROLLBACK TO …; RELEASE …` 批次：批次里中间那句报错时
/// **后面两句不会再执行**，连接就永久停在那个 SAVEPOINT 打开的事务里 —— 之后该库的
/// 每条写入都进这个永不提交的事务，进程一退全部丢失（历史事故：WAL 里 7611 帧、
/// 只有 10 个 commit 标记，09:49–10:12 的整段对话随重启蒸发）。
/// Transaction 的 Drop 一定会回滚，语句报错也逃不掉。
fn fts_write_probe(conn: &Connection, source_table: &str) -> bool {
    let tx = match conn.unchecked_transaction() {
        Ok(tx) => tx,
        Err(_) => return false,
    };
    // 同值 UPDATE：命中一行就必然走 AFTER UPDATE 触发器的 delete + insert 两条路径。
    let probe = format!(
        "UPDATE {source_table} SET content = content WHERE id = (SELECT MIN(id) FROM {source_table})"
    );
    let writable = tx.execute(&probe, []).is_ok();
    // 探针只回答「能不能写」：无论成败都回滚，不留数据变更，也不留事务。
    tx.rollback().is_ok() && writable
}

#[cfg(test)]
#[path = "schema_tests.rs"]
mod tests;



/// 删一列，只吞「本来就没有这一列」（重复执行迁移的正常路径）。
fn drop_column_if_exists(conn: &Connection, table: &str, column: &str) -> Result<(), CoreError> {
    let sql = format!("ALTER TABLE {table} DROP COLUMN {column}");
    match conn.execute(&sql, []) {
        Ok(_) => Ok(()),
        Err(e) if e.to_string().contains("no such column") => Ok(()),
        Err(e) => Err(CoreError::rpc(
            "DB_SCHEMA_FAILED",
            format!("删列 {table}.{column} 失败：{e}"),
        )),
    }
}

#[cfg(test)]
mod migration_swallow_tests {
    use super::drop_column_if_exists;
    use dieyun_base::db_schema::ensure_column;
    use rusqlite::Connection;

    /// 回归（P4）：补列失败必须上抛 —— **只有**「列已存在」可以吞。
    ///
    /// 旧实现整段 `let _ = conn.execute(..)`：迁移真失败时 `init_schema` 仍返回 Ok，
    /// 失败被推迟到后续某次业务写入才以 `no such column` 出现。
    #[test]
    fn ensure_column_propagates_real_failures() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute("CREATE TABLE t (a INTEGER)", []).unwrap();

        ensure_column(&conn, "t", "b", "INTEGER").unwrap();
        // 重复补同一列：重复执行迁移的正常路径，无害
        ensure_column(&conn, "t", "b", "INTEGER").unwrap();
        // 真失败（表都不存在）必须报出来
        let err = ensure_column(&conn, "no_such_table", "c", "INTEGER").unwrap_err();
        assert!(format!("{err}").contains("补列"), "{err}");
    }

    #[test]
    fn drop_column_swallows_only_the_missing_column_case() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute("CREATE TABLE t (a INTEGER, b INTEGER)", []).unwrap();

        drop_column_if_exists(&conn, "t", "b").unwrap();
        // 已经删过（重复执行迁移）：无害
        drop_column_if_exists(&conn, "t", "b").unwrap();
        // 表不存在是真失败
        let err = drop_column_if_exists(&conn, "no_such_table", "b").unwrap_err();
        assert!(format!("{err}").contains("删列"), "{err}");
    }
}

#[cfg(test)]
mod legacy_upgrade_tests {
    use super::*;

    const LEGACY_SQL: &str = "
        CREATE TABLE sessions (id TEXT PRIMARY KEY, updated_at INTEGER NOT NULL, title TEXT);
        CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL,
                               role TEXT NOT NULL, content TEXT NOT NULL, created_at INTEGER NOT NULL);
        CREATE TABLE long_memories (id INTEGER PRIMARY KEY AUTOINCREMENT, content TEXT NOT NULL,
                                    source TEXT, created_at INTEGER NOT NULL);
    ";

    /// 回归（P3⑤）：memory 的老库升级后必须拿到全部后加列。
    ///
    /// 建表与补列现在共用**一份列清单**（`db_schema::ensure_table`），所以「新库有、老库没有」
    /// 这种漂移不该再出现；这条用例钉住它。
    #[test]
    fn legacy_memory_db_gains_columns_declared_in_the_list() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(LEGACY_SQL).unwrap();

        init_schema(&conn).unwrap();

        let sessions = dieyun_base::db_schema::column_names(&conn, "sessions");
        for want in ["archived", "workspace_path", "title_source"] {
            assert!(sessions.contains(&want.to_string()), "sessions 缺 {want}: {sessions:?}");
        }
        let lms = dieyun_base::db_schema::column_names(&conn, "long_memories");
        for want in [
            "scope",
            "kind",
            "importance",
            "status",
            "updated_at",
            "last_used_at",
            "access_count",
            "expires_at",
            "metadata_json",
            "session_id",
        ] {
            assert!(lms.contains(&want.to_string()), "long_memories 缺 {want}: {lms:?}");
        }
        let msgs = dieyun_base::db_schema::column_names(&conn, "messages");
        assert!(msgs.contains(&"reasoning".to_string()), "messages 缺 reasoning: {msgs:?}");
    }

    /// 新库与老库的列**集合**一致（顺序取决于老库当年建表，不比）。
    #[test]
    fn fresh_and_legacy_memory_databases_end_with_the_same_columns() {
        let fresh = Connection::open_in_memory().unwrap();
        init_schema(&fresh).unwrap();

        let legacy = Connection::open_in_memory().unwrap();
        legacy.execute_batch(LEGACY_SQL).unwrap();
        init_schema(&legacy).unwrap();

        for table in ["sessions", "messages", "long_memories", "compaction_archives"] {
            let mut a = dieyun_base::db_schema::column_names(&fresh, table);
            let mut b = dieyun_base::db_schema::column_names(&legacy, table);
            a.sort();
            b.sort();
            assert_eq!(a, b, "{table} 的新库/老库列集合不一致");
        }
    }
}

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
    // 会话标题的来源（heuristic = 首条用户消息切片，ai = 模型总结，user = 用户改名）。
    // 存在的理由只有一个：AI 标题**每会话只生成一次** —— 没有这一列就只能在
    // 「是不是首轮」「标题像不像模型写的」上猜，猜错的代价是每次开话题都重新调一次模型。
    let _ = conn.execute("ALTER TABLE sessions ADD COLUMN title_source TEXT", []);
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
    // 写入溯源：这条记忆是哪个会话沉淀下来的。
    // 存在的理由只有一个 —— 「这个会话沉淀了什么 / 把这个会话写的都忘掉」必须可查，
    // metadata_json 里的 sessionId 是 JSON，做过滤要么 LIKE 猜串要么开 JSON1，
    // 两者都不如一个带索引的一等列。旧行为 NULL（不影响召回与注入）。
    let _ = conn.execute("ALTER TABLE long_memories ADD COLUMN session_id TEXT", []);
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
      CREATE INDEX IF NOT EXISTS idx_long_memories_session ON long_memories(session_id, id);
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

    // 写入探针：唯一一处「索引到底建全了没有」的判定，也是唯一一处修复。
    //
    // 这里曾经有一条「`COUNT(*) FROM long_memories_fts` 与源表不一致就 rebuild」的守卫，
    // 它是**死代码**：`long_memories_fts` 是 external content 表（`content='long_memories'`），
    // 它的 count(*) 走的就是源表扫描，索引空着也是同一个数 —— 于是「老库首次建 FTS，索引空、
    // 源表 1694 行」这个真实场景永远触发不了 rebuild。删掉它，判定只留探针一份。
    //
    // 探针失败的含义（FTS5 只报一句笼统的 `database disk image is malformed`，别被它骗了）：
    // 触发器的 delete 路径找不到这篇 doc —— 最常见就是「索引根本没建」。此时 INSERT 仍然成功，
    // 读也正常，只有 UPDATE / DELETE 报错，所以表面症状是「记忆写不进去」，而对话账本照旧。
    //
    // 用同值 UPDATE 当探针：它同时走 delete + insert 两条触发器路径，是这条链路上最脆的一步。
    if !long_memory_write_probe(conn) {
        let rebuilt = conn
            .execute(
                "INSERT INTO long_memories_fts(long_memories_fts) VALUES('rebuild')",
                [],
            )
            .is_ok();
        if !rebuilt || !long_memory_write_probe(conn) {
            eprintln!(
                "[dieyun:memory] FTS 索引重建后写入仍失败：long_memories 的写入路径可能已被其它损坏阻塞"
            );
        }
    }

    Ok(())
}

/// 「long_memories 这条写入路径还能不能写」的探针：能否写都要把连接留在 autocommit。
///
/// 用 rusqlite 的 [`rusqlite::Transaction`] 而不是手写
/// `SAVEPOINT …; UPDATE …; ROLLBACK TO …; RELEASE …` 批次：批次里中间那句报错时
/// **后面两句不会再执行**，连接就永久停在那个 SAVEPOINT 打开的事务里 —— 之后该库的
/// 每条写入都进这个永不提交的事务，进程一退全部丢失（历史事故：WAL 里 7611 帧、
/// 只有 10 个 commit 标记，09:49–10:12 的整段对话随重启蒸发）。
/// Transaction 的 Drop 一定会回滚，语句报错也逃不掉。
fn long_memory_write_probe(conn: &Connection) -> bool {
    let tx = match conn.unchecked_transaction() {
        Ok(tx) => tx,
        Err(_) => return false,
    };
    let writable = tx
        .execute(
            "UPDATE long_memories SET status = status WHERE id = (SELECT MIN(id) FROM long_memories)",
            [],
        )
        .is_ok();
    // 探针只回答「能不能写」：无论成败都回滚，不留数据变更，也不留事务。
    tx.rollback().is_ok() && writable
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sqlite::SqliteHandle;
    use rusqlite::Connection;
    use std::path::PathBuf;

    fn db_failed(e: rusqlite::Error) -> CoreError {
        CoreError::rpc("TEST_DB", e.to_string())
    }

    fn temp_db_path(tag: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        std::env::temp_dir().join(format!(
            "dieyun-memory-schema-{tag}-{}-{nanos}.sqlite",
            std::process::id()
        ))
    }

    /// 探针的 UPDATE 只命中行才会被触发器拦下 —— 空表探针必然「成功」。
    fn seed_long_memory(conn: &Connection) {
        conn.execute(
            "INSERT INTO long_memories (content, source, created_at) VALUES ('x', 'test', 1)",
            [],
        )
        .expect("seed long_memories");
    }

    /// 模拟「FTS 影子表损坏」：任何命中行的 long_memories 写入都报错。
    /// 真实故障是 FTS 触发器抛 `database disk image is malformed`，形状相同：语句报错。
    fn break_long_memory_writes(conn: &Connection) {
        conn.execute_batch(
            "CREATE TRIGGER break_lm_write BEFORE UPDATE ON long_memories
             BEGIN SELECT RAISE(ABORT, 'fts shadow table is malformed'); END;",
        )
        .expect("inject failing trigger");
    }

    /// 探针失败绝不能让常驻写连接停在事务里。
    ///
    /// 曾经的手写 `execute_batch("SAVEPOINT …; ROLLBACK TO …; RELEASE …")` 会在中间语句
    /// 报错时跳过自己的 ROLLBACK/RELEASE：连接从此停在事务里，此后**所有**写入都进同一个
    /// 永不提交的事务（WAL 里一天 7611 帧、0 个 commit 标记），进程一退全部丢失。
    #[test]
    fn broken_fts_must_not_leave_write_conn_in_open_transaction() {
        let conn = Connection::open_in_memory().expect("memory db");
        init_schema(&conn).expect("schema");
        seed_long_memory(&conn);
        break_long_memory_writes(&conn);

        init_schema(&conn).expect("探针失败不是致命错误，建表仍应成功");

        assert!(
            conn.is_autocommit(),
            "探针失败后连接必须回到 autocommit，否则之后的每条写入都会被永远吞掉"
        );
    }

    /// 真实首装路径：老库有数据、还没有 FTS 索引时第一次启动。
    ///
    /// 钉住两件事：判定只能靠探针（`COUNT(*) FROM long_memories_fts` 对 external content 表
    /// 读的就是源表，行数守卫永远相等）；修好之后重建必须**提交**。
    #[test]
    fn legacy_db_gets_fts_index_built_on_first_open() {
        let path = temp_db_path("legacy-fts");
        {
            let conn = Connection::open(&path).expect("file db");
            init_schema(&conn).expect("schema");
            conn.execute(
                "INSERT INTO long_memories (content, source, created_at) VALUES ('老库里的记忆', 'legacy', 1)",
                [],
            )
            .expect("seed");
            // 退回「有数据、无索引」的老库状态
            conn.execute_batch(
                "DROP TRIGGER IF EXISTS long_memories_fts_ai;
                 DROP TRIGGER IF EXISTS long_memories_fts_au;
                 DROP TRIGGER IF EXISTS long_memories_fts_ad;
                 DROP TABLE long_memories_fts;",
            )
            .expect("drop fts");
        }

        // 首次用新代码打开：建表把 FTS 建出来（空索引），探针必须发现并重建
        let handle = SqliteHandle::new_with_foreign_keys(path.clone(), init_schema);
        handle
            .with_conn(|conn| {
                conn.execute("UPDATE long_memories SET status = 'archived' WHERE id = 1", [])
                    .map_err(db_failed)?;
                Ok(())
            })
            .expect("索引重建后，走 delete 路径的 UPDATE 不应再失败");

        // 而且这次重建必须真的提交，不是躲在某个未提交事务里
        let fresh = Connection::open(&path).expect("fresh conn");
        let status: String = fresh
            .query_row("SELECT status FROM long_memories WHERE id = 1", [], |r| r.get(0))
            .expect("read back");
        assert_eq!(status, "archived");
        let docsize: i64 = fresh
            .query_row("SELECT COUNT(*) FROM long_memories_fts_docsize", [], |r| r.get(0))
            .expect("docsize");
        assert_eq!(docsize, 1, "重建后的索引必须已提交（docsize 有行）");
        drop(fresh);
        let _ = std::fs::remove_file(&path);
    }

    /// 承接上一例：探针失败之后，写入必须真的落地（另一个连接看得见）。
    #[test]
    fn memory_writes_still_commit_after_broken_fts_probe() {
        let path = temp_db_path("fts-probe-commit");
        {
            let conn = Connection::open(&path).expect("file db");
            init_schema(&conn).expect("schema");
            seed_long_memory(&conn);
            break_long_memory_writes(&conn);
        }

        let handle = SqliteHandle::new_with_foreign_keys(path.clone(), init_schema);
        // 首次 with_conn 会跑建表 → 探针失败 → 随后这条写入必须提交
        handle
            .with_conn(|conn| {
                conn.execute(
                    "INSERT INTO sessions (id, updated_at, title) VALUES ('s1', 1, 't')",
                    [],
                )
                .map_err(db_failed)?;
                Ok(())
            })
            .expect("write via resident conn");

        let dedicated = handle.open_dedicated().expect("dedicated");
        let n: i64 = dedicated
            .query_row("SELECT COUNT(*) FROM sessions", [], |r| r.get(0))
            .map_err(db_failed)
            .expect("count sessions");
        assert_eq!(
            n, 1,
            "探针失败不得让后续写入卡在未提交事务里（独立连接必须看得见这条写入）"
        );
        drop(dedicated);
        let _ = std::fs::remove_file(&path);
    }
}

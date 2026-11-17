# memory 审计

> **2026-11-17 P0 已修**：F1（向量维度按配置值落库 → 改为跟着向量走，用例 `stored_vector_dimensions_come_from_the_vector_not_the_config`）、F2（精确去重不带 scope → 带 scope，用例 `exact_dedupe_is_scoped`）、F6（删会话不清理归档/快照 → `clear_session` 补删两表，用例 `clear_session_purges_archives_and_snapshots`）。F3/F4/F5/F7–F10 仍开。

审计范围：`crates/dieyun-core/src/memory/{mod,schema,recall,longmem,snapshot,session,agent,misc,meta,archive,projects,goal,store}.rs`（约 7.0k 行，mod.rs 1488 行里约 1.3k 是测试）。
交叉求证：`src/agent/system-prompt-prep.js`、`src/agent/agent-limits.js`、`src/agent/request-snapshot.js`、`src/agent/main-turn-runner.js`、`src/agent/session-context.js`、`src/agent/embedding-config.js`、`src/workspace/target.js`。

## 度量

- 一个文件混了几种职责：
  - `misc.rs`：撤回消息 + 账本自愈三条规则 + 归纳作业账本 + 衰减 + 增量导出 + 后台修剪线程 + 历史脏数据清洗 + VACUUM，八种职责。
  - `session.rs`：会话 CRUD + 标题启发式 + handoff 生命周期 + 消息追加与分页。
  - `archive.rs`：归档写入 + 会话正文检索 + 折叠原文检索，三种粒度混在一起。
  - `recall.rs`：打分（bm25/余弦/新鲜度）+ 可见性 SQL 片段 + 会话维度统计。
  - `longmem.rs`：写入政策 + 精确去重 + 向量落库与重建 + 状态变更。
- 同一份知识两份实现：
  - 长记忆可见性：唯一来源 `recall.rs:47 long_mem_visible_sql` vs 语义分支手写 `recall.rs:615`。
  - 生效维度：唯一来源 `embedding/mod.rs:247 effective_dimensions()` vs `longmem.rs:509/538` 用 `embedding.dimensions`。
  - 长记忆行形状三份：`longmem.rs:28-42`（蛇形）、`recall.rs:318-329`（蛇形）、`recall.rs:584-596`（驼峰 + vectorSearch）。
  - 消息行形状两份：`mod.rs:94-104`（serde camelCase）vs `misc.rs:271-280`（手搓蛇形）→ Node 只能 `r.createdAt || r.created_at` 双键兜底（`main-turn-runner.js:267`）。
  - schema 两份：`schema.rs:148-178` CREATE 全列 vs `schema.rs:208-267` ALTER 补列，靠人工同步（`compaction_archives.folded_text` 已出现两处定义）。
  - 请求快照 NULL 语义：`snapshot.rs:8-9` 的文档与 `request-snapshot.js:163-167` 的现行规则相反。

## 发现

### F1 本地向量后端下 `long_memory_vectors.dimensions` 写配置维度（1024）而非实际（768）→ 语义召回与近重复抑制全静默失效
- 类型：live-bug｜严重度：high
- 位置：`longmem.rs:509`、`longmem.rs:538`；读侧 `recall.rs:631-634` + `embedding/mod.rs:260` 的 `blob.len() != dims*4`
- 触发：`provider=local`，或 `auto` 且本地模型 + dylib 就位（默认路径）。写坏维度后语义召回恒空、近重复恒 None，无日志。
- 修法：两处改 `embedding.effective_dimensions()`；`blob_to_vector` 失败不要静默 `continue`，在 `long_memory_vector_status` 里如实回报「多少行维度对不上」，否则 reindex 认为「已覆盖」永不修复。
- 确认：本地后端写一条记忆后 `SELECT dimensions, length(vector)/4` → 1024 / 768。

### F2 精确去重键没有 scope 维度：别的项目写过的同一句话被静默吞掉
- 类型：live-bug｜严重度：high
- 位置：`longmem.rs:200-214`（`WHERE content = ?1 AND status != 'deleted'`；命中后不写 scope/kind/importance/expires_at）
- 触发：两个 scope 出现同一正文（跨项目归纳常见）。写入方看到 `duplicate=true`，B 项目 `long_recall(scope=project:B)` 永远查不到。仓库测试 `mod.rs:665-679` 把这个行为当既有语义锁住了（断言 `len() == 0`）。
- 修法：去重键补 scope，或命中时一并更新 scope/kind/importance 并如实回报「已合并到另一 scope」。
- 确认：把该测试断言改成 1 即复现。

### F3 自愈把在跑的 run 判成 stopped 后单向锁死：running 写不回去，trace checkpoint 被丢弃
- 类型：latent-bug｜严重度：high
- 位置：`misc.rs:146-152`（`STALE_AGENT_RUN_MS = 2 分钟`）、`agent.rs:53-57`（CASE 吸收态）、`agent.rs:118-123`（trace 返回 `skipped:true`）
- 触发：headless 与桌面共用 userData（`mod.rs:36-38` 自陈该前提）；或单轮里一次工具/LLM 等待 > 2 分钟且期间无 2.5s checkpoint。之后 trace 冻结、`get_latest_agent_state` 把「已停止」喂给模型、30 天后连 trace 一起删。
- 修法：判死要带归属证据（pid / boot id / heartbeat），或允许 stopped 被同 session 的真实 running 覆盖回来。
- 确认：自愈造出 `run-stale` 后 `agent.run_upsert{running}` + `agent.trace_save` → status 仍 stopped、trace skipped。

### F4 关键词召回分数跨分支量纲不同，Node 却用单一绝对阈值 0.12 过滤
- 类型：live-bug｜严重度：medium
- 位置：`recall.rs:545-559`（FTS：`-rank` + importance×0.035 + freshness×0.08）vs `recall.rs:513-514`（LIKE：`-1.0 AS rank` 恒 1.0）；阈值 `system-prompt-prep.js:673-680`、`agent-limits.js:361-362`
- 触发：同一条 importance=3 的记忆，查询串含 ≥3 字符片段走 FTS（分数 ≈0.1x，可能低于 0.12 被砍），只有中文双字词时走 LIKE（恒 ≥1.0 必过）。「有没有被注入」由查询词长度决定。
- 修法：两侧只能留一份口径 —— Rust 归一化到可比的 0..1，或 Node 不设绝对阈值只按名次。
- 确认：`keyword_search_long_memories("索引")` 与 `("ANN")` 打印两份 score 对比。

### F5 语义召回手写可见性谓词，丢掉 `expires_at` 与 `stale`
- 类型：latent-bug｜严重度：medium
- 位置：`recall.rs:611-617` vs 唯一来源 `recall.rs:47-57`（文件头 37-39 自陈「原本手抄 10 处」）
- 触发：`status='stale'` 的行在有语义命中的查询里永不被注入（语义命中即 return，关键词通道轮不到）；`expires_at` 已过期但 decay 还没跑的行被照常注入。
- 修法：语义分支改用 `long_mem_visible_sql("m", <now 参数>)`；stale 只影响排序。
- 确认：`UPDATE long_memories SET status='stale'` 后语义召回断言不出现。

### F6 删会话不清理 `compaction_archives` / `request_snapshots`：孤儿行永久留库，且已删会话的折叠原文仍可被检索
- 类型：live-bug｜严重度：medium
- 位置：`session.rs:438-461`（只删 5 张表）、`archive.rs:230-237`（检索不 JOIN sessions）
- 触发：删会话后库只涨不消；`memory.compaction_folded {workspacePath}` 仍能把已删会话的折叠原文交给模型（`src/agent/main-tools/memory.js:50-54` 走这条路）。
- 修法：clear_session 补删两表（或加 FK CASCADE）；给 `compaction_archives` 一个保留上限（现在库里唯一无上限的正文表）；检索侧 JOIN sessions。
- 确认：写归档 → 删会话 → 检索仍返回 1 条。

### F7 `recent_messages` 按 `created_at` 排序（而非 id）：同毫秒写入的消息顺序被整体倒转
- 类型：latent-bug｜严重度：medium
- 位置：`session.rs:352-371`（`ORDER BY created_at DESC` + `rows.reverse()`），对照 `session.rs:385-386`（翻页用 `id`）
- 触发：同毫秒写入 ≥2 条（批量导入、折叠重写、循环连写、时钟回拨）。下游不重排（`session-context.js:979` 直接按数组顺序拼），模型对着错位对话继续答。
- 修法：改 `ORDER BY id DESC`（与翻页统一），created_at 只作展示。
- 确认：同毫秒插 A/B/C，断言返回 [A,B,C]。

### F8 schema 迁移 16 条 ALTER 全部 `let _ =` 吞错
- 类型：latent-bug｜严重度：medium
- 位置：`schema.rs:208-267`
- 触发：旧库升级时任一 ALTER 真失败（只读 / 磁盘满 / BUSY / 不支持 DROP COLUMN）→ `init_schema` 仍 Ok，`memory.ping` 仍 ok，直到业务 RPC 报 `no such column`。同文件建表/建索引的错误都正经映射了 `DB_SCHEMA_FAILED`，只有这 16 条没有。
- 修法：只吞「duplicate column」，其余上抛；中期把列清单收成声明式迁移表，CREATE 与 ALTER 都从它生成。
- 确认：`PRAGMA query_only=ON` 下调 `init_schema` 应返回 Err（现为 Ok）。

### F9 请求快照大字段 NULL 语义：Rust 模块文档与 Node 写入方相反
- 类型：structural-debt｜严重度：low
- 位置：`snapshot.rs:8-9` vs `request-snapshot.js:163-167`
- 后果：下次有人照文档写「NULL 就往前找」，会把上一轮（甚至别的 run）的 system prompt 当这一轮的。
- 修法：改掉那两行文档，写明「NULL = 没落库，用 *Chars 区分空/超限；读侧不得继承」。

### F10 同一行数据的 JSON 形状模块内两套（camelCase / snake_case），Node 被迫双键兜底
- 类型：structural-debt｜严重度：low
- 位置：`recall.rs:318-329` vs `recall.rs:584-596`；`misc.rs:271-280` vs `mod.rs:94-104`
- 后果：漂移已发生（`main-turn-runner.js:267` 的双键兜底）；按错键读只会得到 undefined，不报错。
- 修法：一个域只留一个投影函数 + 一层序列化，删掉手搓 `json!` 投影。

# 请求快照（Request Snapshot）实施方案

> 目标：让「这一轮模型到底看到了什么、为什么这么看」从**推断**变成**可查的事实**。
> 定位：这是"留证据"三条里最底层的一条（工位/上锁都靠它解释行为）。
> 状态：**已实施**（表/RPC/装配/接线/文档/测试均已落地；日常用法看 [`REQUEST-SNAPSHOT.md`](./REQUEST-SNAPSHOT.md)）
> 不改发送行为 · 不改 UI · 写失败不影响请求

---

## 0. 一句话方案

在 **Rust 侧加一张 `request_snapshots` 表**，在 **Node 循环真正发请求的那一刻**（`fetchLlmRound` 入口）落一份「信封快照」；把 Renderer 拼 prompt 时发生的折叠/裁剪、Main 触发的压缩，作为**审计事实**一起写进同一行。

不引入事件溯源、不做投影、不做迁移链——那三条是平台税，本方案明确不做。

### 目标

| 能力 | 验收问题 |
|---|---|
| 请求可回放 | 「第 3 轮到底发了哪些消息？」能一条 RPC 取回原文 |
| 派生可解释 | 「为什么历史只剩 24 条？」能答"folded 37 条 + 压缩 1 次" |
| 决策可追溯 | 「这轮为什么没压缩？」能看到当时的 `tokenBudget / triggerRatio / compactionRoundCount` |
| 跨入口一致 | 聊天、子 Agent、Planner worker、定时任务四条路径同一张表 |

### 非目标（明确划走）

- 不做全量事件日志 / surface replace / 投影缓存 / 格式版本迁移链
- 不做请求内容加密、不做 UI 浏览面板（第二阶段再说）
- 不记录 LLM 原始响应（已有 `llm-raw-tap` / `DIEYUN_LLM_RAW_LOG`，别做第二套）
- 不改 `agent_traces` 的语义（trace 记"想了想什么"，快照记"看到了什么"，两件事）

---

## 1. 现状事实（已核对代码）

| 事实 | 位置 |
|---|---|
| 发出去的 messages 是**每次现拼**的，无留底 | `src/renderer/renderer-agent-send.js:605` 调 `buildCompletionMessages(...)`，结果直接进 `payload` |
| 折叠只留下一个数字 | `src/agent/session-context.js:660` `folded = { role:'user', content:[FOLDED_HISTORY_HEADER, '此前 N 条已折叠…', body] }` —— 折了哪些条、原长多少，全丢 |
| 单条超限截断、整体丢最老消息，同样无记录 | `session-context.js:729 trimMessagesToCharBudget`（`:790` 起按 `requestMaxChars` 丢消息） |
| 循环里有个**内存**检查点，但不落库、只留最后一轮 | `src/agent/rust-loop-runner.js:635` `lastCheckpoint = { runId, model, messages, tools }`（只在 `loop_failed` 时上报 UI） |
| 压缩有归档表，但**没有和某一轮请求关联** | `crates/dieyun-core/src/memory/mod.rs:1066 save_compaction_archive`；三处重复调用：`main/ipc/agent-runtime.js:429`、`plans/plan-agent-runner.js:182`、`renderer/renderer-agent-compaction.js:103` |
| 压缩有遥测，但是**聚合流**不是审计 | `src/agent/compaction-telemetry.js`（`compaction-telemetry.jsonl`，统计页用） |
| 四条入口都汇聚到同一个 `runRustAgentLoop` | 聊天 `main/ipc/agent-runtime.js:389`；子 Agent `:324`；Planner `agent/rust-planner-runner.js:452`；定时 `plans/plan-agent-runner.js:155` |
| 唯一一次「body 定稿」在 `fetchLlmRound` | `rust-loop-runner.js:310`；调用点 `:648`（含 `withVision` 视觉注入） |
| `sessionId` 到循环只靠 `llm.sessionId` 捎带 | `agent-runtime.js:393`（`llm: apiCfg`）+ `:421`（压缩闭包） |

结论：**留底的时机只有一个**（body 定稿），**留底的位置只有一个**（`runRustAgentLoop` 内的 `fetchLlmRound`）。方案就落在这一个点上，四条入口自动全覆盖。

---

## 2. 设计决策（每条都写明"为什么不选另一个"）

### D1 用一张表，不用事件日志
快照是**旁路事实**，不是真相来源。真相仍是 `messages`/`compaction_archives`。
→ 所以它可以被裁剪、可以丢、可以重建语义上的"最近 N 轮"，不必 append-only。
→ 若做成事件日志，就必须同步解决 replay/迁移/投影三件事，直接滑向平台税。

### D2 写在 `fetchLlmRound`，不写在 `buildCompletionMessages`
`buildCompletionMessages` 在 Renderer，拼完还要过 `capAndSyncLoopMessages`（图片净化）、`withVision`（视觉注入）、`maybeCompactRound`（压缩改写）。
→ 只有 `fetchLlmRound` 拿到的 body 是**真发出去的那一份**。
→ 副产品：溢出重发时会自然产生第 2 行（内容不同、`reason` 不同），这正是要能看见的东西。

### D3 system prompt 与 tools 用 hash 去重，messages 全存
一轮请求里 system 通常 10–20KB、tools 20–40KB，而它们在会话内高度稳定。
→ 每行必存 `messages_json`（核心价值）；`system_text` / `tools_json` 只在 hash 变化时存，否则留 NULL + 记 hash。
→ 读侧规则：NULL 表示"与同会话上一条非 NULL 相同"。这是唯一需要读侧理解的约定，写入点强制维护。

### D4 保留策略代替压缩
不引第三方压缩依赖（`Cargo.toml` 现无 zstd/flate，避免为审计数据加依赖）。
→ 每个会话保留最近 `requestSnapshotKeepPerSession` 行；**压缩过的那几行单独按 `requestSnapshotKeepCompacted` 保留**（有压缩的轮次是排查重点，不能被挤掉）。
→ 单行 `messages_json` 超过 `requestSnapshotMaxMessagesChars` 时改存"信封 + 截断标记"（保留条数、总字符、hash、头尾各 2KB），**永不因一次超大请求把库撑爆**。

### D5 写失败绝不影响请求
`void writeSnapshot(...).catch(log once)`，不 await、不进 try/catch 主链路。
→ 审计是旁路；它的失败不能变成用户可见的失败。

### D6 折叠/裁剪的"账"从 Renderer 带走，不在 Main 重算
折叠发生在 Renderer（`renderer-agent-send.js`），Main 重算等于第二份实现。
→ `foldOlderCompletionMessages` / `trimMessagesToCharBudget` 增加**可选出参** `capOpts.audit`（纯函数仍是纯函数：只多写一个对象），Renderer 把它随 IPC 一起送过来，Main 原样落到 `context_audit_json`。

---

## 3. 数据模型

### 3.1 新表（`crates/dieyun-core/src/memory/schema.rs`，`init_schema` 末尾追加）

```sql
CREATE TABLE IF NOT EXISTS request_snapshots (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id            TEXT NOT NULL,
  run_id                TEXT,
  round                 INTEGER,          -- 本轮 LLM 轮次（rust-loop-runner 的 llmRound）
  source                TEXT,             -- chat | subagent | planner | plan
  created_at            INTEGER NOT NULL,

  -- 请求信封
  model                 TEXT,
  stream                INTEGER,
  messages_json         TEXT NOT NULL,    -- 真发出的 messages（或截断后的信封）
  messages_chars        INTEGER,
  message_count         INTEGER,
  messages_hash         TEXT,             -- sha256(规范化 JSON)，用于"和上一轮差在哪"
  truncated             INTEGER NOT NULL DEFAULT 0,

  -- 大字段去重（NULL = 与同会话上一非 NULL 行相同）
  system_hash           TEXT,
  system_chars          INTEGER,
  system_text           TEXT,
  tools_hash            TEXT,
  tools_names           TEXT,             -- JSON 数组，便于肉眼扫
  tools_json            TEXT,

  -- 预算决策
  est_tokens            INTEGER,
  token_budget          INTEGER,
  trigger_ratio         REAL,
  compaction_round_count INTEGER,
  compacted             INTEGER NOT NULL DEFAULT 0,
  tokens_before         INTEGER,
  tokens_after          INTEGER,
  compaction_archive_id INTEGER,

  reason                TEXT,             -- initial | overflow-retry | ...
  context_audit_json    TEXT              -- 见 §4
);
CREATE INDEX IF NOT EXISTS idx_reqsnap_session ON request_snapshots(session_id, id);
CREATE INDEX IF NOT EXISTS idx_reqsnap_created ON request_snapshots(created_at);
```

**迁移策略**：`CREATE TABLE IF NOT EXISTS` + 索引，纯增量。与现有 `ALTER TABLE` 补丁风格一致，老库无需回填（历史轮次本来就没留底，不假装有）。

### 3.2 保留裁剪（写入时同事务内执行）

```
删除条件（两段，先算 keep 集再删）：
  A. 该 session 内 compacted=1 的行，按 id DESC 取前 requestSnapshotKeepCompacted 条 —— 保留
  B. 其余行按 id DESC 取前 requestSnapshotKeepPerSession 条 —— 保留
  其余 DELETE
```

### 3.3 数字归属（`src/agent/agent-limits.js`，护栏单一来源）

| key | 默认 | 说明 |
|---|---|---|
| `requestSnapshotEnabled` | `true` | 总开关（用户可关） |
| `requestSnapshotKeepPerSession` | `40` | 每会话保留轮数 |
| `requestSnapshotKeepCompacted` | `200` | 发生过压缩的行额外保留 |
| `requestSnapshotMaxMessagesChars` | `400000` | 单行 messages 上限，超则存信封 |
| `requestSnapshotSystemMaxChars` | `64000` | system_text 落库上限 |
| `requestSnapshotToolsMaxChars` | `96000` | tools_json 落库上限 |

> 这六个数字**不进设置页**（与 `charsPerToken` 同类：是"账本折算/保留"参数，不是策略上限），只做单一来源。

---

## 4. 审计事实（`context_audit_json`）

由两端各自产出，Main 只做拼装，不重算：

**Renderer 侧（`session-context.js` 生产 → `renderer-agent-send.js` 透传）**

```jsonc
{
  "history": { "messages": 61, "chars": 84000 },
  "fold": {                 // foldOlderCompletionMessages 命中时
    "foldedCount": 37,
    "keptRecentTurns": 24,
    "foldedChars": 31000,
    "foldMaxChars": 12000,
    "cutRole": "assistant"  // cut 回退后的落点角色（现在是 tool 也会回退，记下来就能解释"为什么多留了几条"）
  },
  "trim": {                 // trimMessagesToCharBudget 命中时
    "perMessageTruncated": 3,
    "droppedMessages": 5,
    "lastUserTruncated": true
  },
  "turnRideChars": 9200,
  "sysStableChars": 15200,
  "taskTier": "standard",
  "longHorizon": false
}
```

**Main 侧（`rust-loop-runner.js` 已知）**：`compacted / tokensBefore / tokensAfter / compactionArchiveId / reason`。

不追求"逐条消息 id 对齐"——那需要把 DB 行 id 塞进消息体，会破坏"发给 LLM 的 body 就是库里那一份"的干净形状。第一版只回答"折了几条、丢了几个、压了多少"，这已经覆盖 90% 的真实提问。

---

## 5. RPC 面（3 个方法，全部只读 + 1 个写）

| 方法 | 参数 | 返回 |
|---|---|---|
| `memory.request_snapshot_append` | 见 §3.1 字段 | `{ ok, id }` |
| `memory.request_snapshot_recent` | `sessionId, limit=20` | 行数组（**不含** `messages_json` 大字段，带 `messagesChars/hash`） |
| `memory.request_snapshot_get` | `id` | 整行（含 `messages_json` / `system_text` / `tools_json`） |

实现落点（沿用现有模式，无新机制）：
1. `crates/dieyun-core/src/memory/mod.rs`：`save_request_snapshot` / `recent_request_snapshots` / `request_snapshot_get`（照 `save_compaction_archive` 的写法）
2. `crates/dieyun-core/src/rpc/mod.rs`：`match` 三分支（照 `"memory.compaction_archive"` 的写法）
3. `src/gateway/handlers/memory.js`：三个 `requireRustCore(...)` 转发（照 `:230` 那两行）
4. `docs/rpc-catalog.md|json`：`npm run generate:rpc-catalog`（`verify:rpc-catalog` 兜住）

> 写入口**只有一个**（`rust-loop-runner` 内部 `bridge.invoke`），不经 Gateway、不经 IPC——审计数据不走 UI 通道。
> 读入口走 Gateway，供将来的"为什么"面板与 CLI 用。

---

## 6. 改动清单

| # | 文件 | 类型 | 内容 |
|---|---|---|---|
| 1 | `crates/dieyun-core/src/memory/schema.rs` | 改 | 追加 `request_snapshots` 表 + 2 索引 |
| 2 | `crates/dieyun-core/src/memory/mod.rs` | 改 | 3 个方法（含保留裁剪、`messages_json` 超限转信封） |
| 3 | `crates/dieyun-core/src/rpc/mod.rs` | 改 | 3 个 `match` 分支 |
| 4 | `src/gateway/handlers/memory.js` | 改 | 3 条转发 |
| 5 | `src/agent/request-snapshot.js` | **新增** | 唯一装配点：`buildRequestSnapshot({body, model, sessionId, runId, round, source, compaction, contextAudit, limits})` → RPC payload；负责 hash、去重决策（进程内按 session 缓存上一份 hash）、超限转信封、`enabled` 判定 |
| 6 | `src/agent/rust-loop-runner.js` | 改 | `fetchLlmRound` 内落库（best-effort）；`maybeCompactRound` 把 `tokensBefore/After` + `archiveId` 记到 `compaction` 描述；`runRustAgentLoop` 新增 `opts.sessionId` / `opts.runSource` / `opts.contextAudit` |
| 7 | `src/main/ipc/agent-runtime.js` | 改 | 两处 `runRustAgentLoop({...})` 各加 `sessionId: payload.sessionId`、`runSource`、`contextAudit: payload.contextAudit`；压缩归档已有 id 回传（见 §9 后续） |
| 8 | `src/agent/rust-planner-runner.js` · `src/plans/plan-agent-runner.js` | 改 | 同上各加三个字段（`runSource: 'planner' / 'plan'`） |
| 9 | `src/agent/session-context.js` | 改 | `foldOlderCompletionMessages` / `trimMessagesToCharBudget` 填 `capOpts.audit`（可选出参，无 audit 时行为逐字节不变） |
| 10 | `src/renderer/renderer-agent-session.js` | 改 | `completionCapOpts()` 返回里挂 `audit: {}`；`buildCompletionMessages` 返回后把 audit 暴露给调用方（新增 `getLastCompletionAudit()`，不改现有返回值） |
| 11 | `src/renderer/renderer-agent-send.js` | 改 | `agentRunFrame.contextAudit = ...`，随 IPC payload 发下去 |
| 12 | `src/renderer/agent/agent-bundle-entry.js` · `renderer-agent-rust-loop.js` | 改 | 透传 `contextAudit`（仅加字段） |
| 13 | `src/agent/agent-limits.js` | 改 | 6 个新 key（§3.3） |
| 14 | `docs/REQUEST-SNAPSHOT.md` | **新增** | 字段语义、读法（怎么回答三个问题）、保留策略、开关 |
| 15 | `docs/CODEMAP.json` · `AGENTS.md` | 改 | 索引新增 `src/agent/request-snapshot.js`；"改什么去哪"表加一行 |
| 16 | `package.json` | 改 | `test:request-snapshot` 脚本 |
| 17 | `scripts/test-request-snapshot.cjs` | **新增** | 冒烟：起 sidecar → append 3 行（含 1 行 compacted）→ recent 校验不含大字段 → get 校验含 → 触发保留裁剪 → 校验 compacted 行存活 |
| 18 | `test/unit/request-snapshot.test.cjs` | **新增** | 纯函数：hash 稳定、超限转信封、audit 折叠事实、`enabled=false` 不产生 payload |
| 19 | `scripts/test-agent-smoke.cjs` | 改 | 注册新冒烟到矩阵 |

---

## 7. 体积与开销预算（先算账再写码）

| 项 | 估算 |
|---|---|
| 单行大小（`messages_json` 为主） | 20–120KB（长对话尾部轮次偏大） |
| 每会话稳态 | ≈ 40 × 80KB ≈ **3.2MB** |
| 100 会话 | ≈ **320MB** ⚠️ 需要 `requestSnapshotEnabled` 可关 + 保留可调 |
| 写入开销 | 一次 `INSERT` + 一次 `DELETE` 扫描（有索引），**< 5ms**，在 LLM 首包前完成，用户无感 |
| 读开销 | `recent` 不取大字段，< 1ms |

> 若实测超预算，第一步降级是 `requestSnapshotKeepPerSession: 40 → 15`（含压缩行仍保 200），不改结构。

---

## 8. 验证方案

1. **单测**（纯函数）：`npx vitest run test/unit/request-snapshot.test.cjs`
2. **冒烟**（含 sidecar）：`npm run test:request-snapshot`
3. **Rust**：`npm run cargo:test`（新增 mod 内的 `#[cfg(test)]`：保留裁剪、超限转信封、`system/tools` 去重标记）
4. **契约**：`npm run verify:rpc-catalog`
5. **回归**（必须全绿，证明"不改发送行为"）：`npm run test:rust-agent-loop-smoke` · `npm run test:session-context` · `npm run test:agent-run-events`
6. **人工验收**（三条问题）：跑一次真实会话 → 用 `memory.request_snapshot_recent` 看轮次 → 对超长会话跑一轮，`context_audit_json` 里应出现 `fold.foldedCount > 0` → 手动点"立即压缩"后再发一轮，应看到 `compacted:1` 且 `tokens_before/after` 有值、`compaction_archive_id` 对应得上 `compaction_archives.id`

---

## 9. 风险与回滚

| 风险 | 处理 |
|---|---|
| 快照把用户代码/密钥写进库 | 与 `messages` 同库同权限，不新增暴露面；提供 `requestSnapshotEnabled=false`；`docs/REQUEST-SNAPSHOT.md` 明确写"这是本地审计数据，等同对话记录" |
| 库体积膨胀 | 保留策略 + 单行上限 + 开关；`recent` 不返回大字段，避免 UI 误加载 |
| 写失败拖慢循环 | 不 await、不重试、只记一次日志 |
| `session-context` 改动破坏现有折叠 | audit 是**可选出参**，未传时走原分支；`test:session-context` 必须逐条通过 |
| 与 `agent_traces` 混淆 | 文档写死分工：trace = 过程，snapshot = 请求，archive = 压缩产物 |

**回滚**：表与 RPC 纯增量，`requestSnapshotEnabled=false` 即完全停写；代码回退不需要删表（空表无副作用）。

---

## 10. 后续（本方案不做，但已被它解锁）

1. **压缩归档单一写入点**：现在 `agent-runtime` / `plan-agent-runner` / `renderer-agent-compaction` 三处各写一次 `memory.compaction_archive`；等快照带 `compaction_archive_id` 落地后，可把这三次收敛到 `compaction-main.maybeCompactMessages` 一处，顺带删掉 Renderer 那次（Renderer 不该写库）。
2. **"为什么"面板**：`recent` + `get` 已经够渲染一个"本轮请求"抽屉；不需要新后端。
3. **折叠区间 id 化**：如果将来要"从折叠摘要里点回原文"，再给 fold 记录补 `[startMsgId, endMsgId]`（需要 Renderer 消息带 id，单独一刀）。
4. **审计事件统一**：把"压缩/提权/审批"三类决策都写成同构的 `*_audit` 行，是第二条（工位）与第三条（上锁）落地后的自然结果。

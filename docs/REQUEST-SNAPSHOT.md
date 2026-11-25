# 请求快照（Request Snapshot）

> 解决的问题：**「这一轮模型到底看到了什么、为什么历史变短了、这轮为什么没压缩」只能靠读代码猜。**
> 现在这些都有留底，可以一条 RPC 查回来。
>
> 相关：表结构 `crates/dieyun-memory/src/memory/schema.rs` · 装配 `src/agent/request-snapshot.js`

---

## 1. 它是什么，不是什么

| 是 | 不是 |
|---|---|
| 每轮**真正发往 LLM 的请求**的一行留底 | 不是对话账本（真相仍是 `messages`） |
| **旁路事实**：可裁剪、可丢失、不参与 replay | 不是事件溯源，没有格式版本迁移链 |
| 回答「模型看到了什么」的**唯一**来源 | 不是 LLM 原始响应（那是 `llm-raw-tap` / `DIEYUN_LLM_RAW_LOG`） |
| 折叠/压缩结论的**关联点** | 不是 trace（`agent_traces` 记"想了什么"，快照记"看到了什么"） |

三条记录的分工，别混：

```
agent_traces          过程：每轮的想法、工具调用、耗时
request_snapshots     请求：这一轮发出去的确切内容 + 预算决策 + 派生事实
compaction_archives   产物：压缩摘要本身（快照里用 compaction_archive_id 指向它）
```

---

## 2. 三个问题怎么答

### Q1「第 3 轮到底发了哪些消息？」

```js
// Gateway（Renderer / 脚本）
const rows = await gatewayCall('memory.request_snapshot_recent', { sessionId, limit: 20 });
const row  = rows.find(r => r.round === 3);
const full = await gatewayCall('memory.request_snapshot_get', { id: row.id });
JSON.parse(full.messagesJson)   // ← 就是当时发出去的 messages 数组
```

`recent` **不含**大字段（`messagesJson` / `systemText` / `toolsJson`），只有信封级事实（条数、字符数、hash、预算、压缩结论）。要看原文必须 `get`。

### Q2「为什么历史只剩 24 条？」

看 `contextAudit`：

```jsonc
{
  "historyMessages": 61,          // 进拼装的条数
  "fold": {                       // 折叠（保留最近 N 轮，更老的折成一段）
    "foldedCount": 37,            // 被折掉 37 条
    "keptRecentTurns": 24,        // 保留窗口
    "foldedChars": 31000,         // 折前 31000 字符
    "foldMaxChars": 12000,        // 折后上限（实际折成一段摘要）
    "cutRole": "assistant"        // 断点落点（回退到 tool 之前的角色）
  },
  "trim": {                       // 裁剪（按字符预算丢/截）
    "droppedByHistoryBudget": 5,  // 历史预算丢掉的条数
    "droppedByRequestCap": 2,     // 硬顶（llmRequestMaxChars）再丢的条数
    "perMessageTruncated": 3,     // 单条被截断的条数
    "messagesIn": 61,             // 不含 system
    "messagesOut": 24,            // 不含 system（口径与 messagesIn 一致）
    "systemMessages": 1,          // system 单独计，不混进上面两个数
    "requestMaxChars": 800000
  },
  "turnRideChars": 9200,
  "sysStableChars": 15200,
  "taskTier": "standard"
}
```

`fold` 与 `trim` 只在该轮真的发生时才出现。这些数**只由 Renderer 产生**（折叠/裁剪在 `session-context.js`），Main 不重算——重算就是第二份实现。

`messagesIn` / `messagesOut` 都**不含 system**（system 单独记在 `systemMessages`）：两者混口径时
`messagesOut` 恒比 `messagesIn` 多一条，和快照行的 `messageCount` 也对不上，
排查"到底丢了几条"会被这一条常数差带偏。

### Q2.1「这轮索引内容进上下文了吗？」

`contextAudit.index` —— prep 侧产出的**注入事实**，用来补上工具遥测看不见的那一半
（自动注入走 RPC，不进 `tool-telemetry.jsonl`）：

```jsonc
{
  "index": {
    "allow": true,        // 这轮是否放行碰索引（allowCodebase）
    "code": "auto",       // "auto" 自动检索 | "explicit" @Codebase | null 没注入
    "repoMap": true       // 【仓库结构图】是否进了上下文
  }
}
```

统计信息页的「注入 · 仓库结构图 / 注入 · 相关代码」两行就是对它的聚合
（RPC `memory.request_snapshot_index_audit`，口径见 `docs/INDEX-VALUE-REVIEW.md` §7.1.1）。
**没有 `index` 字段的行是本次改造前的历史行**，聚合时与「明确没注入」分开计数。

### Q3「这轮为什么没压缩 / 压了多少？」

看 `compacted` / `tokensBefore` / `tokensAfter` / `tokenBudget` / `triggerRatio` / `compactionRoundCount` / `compactionArchiveId`：

- `compacted: true` + `tokensBefore/After` → 这一轮**发送前**刚压过；`compactionArchiveId` 直接指向 `compaction_archives.id`（摘要原文在那）。
- `compacted: false` → 没压。但**每一行都带判定事实**（`estTokens` / `tokenBudget` / `triggerRatio` / `compactionRoundCount`）：
  `estTokens < tokenBudget × triggerRatio` 就是"没到阈值"，否则是"在冷却期"。只记 `compacted=true` 的话，
  "这轮为什么没压"事后仍然只能靠猜（列建了却永远 NULL 等于没建）。
- 这些数字**只由 `compaction-main.js` 算**（预算、触发比、冷却计数），快照只搬不改判；真触发判定在 Rust `compaction::maybe_compact`。
- `reason` 区分一轮里的多次发送：`initial` / `overflow-retry`（溢出强制压缩后重发）/ `image-repair`（丢掉被拒图片后重发）。**同一 `round` 出现两行是正常的**，说明这一轮发过两次。
- `(source, runId, round)` 唯一：同一 `runId` 的同一轮次不重复记；子 Agent 与主循环各有自己的 `runId`
  （共用一个父 `sessionId`），并发写也不会互相覆盖。

---

## 3. 字段语义

| 字段 | 含义 |
|---|---|
| `source` | `chat` / `subagent` / `planner` / `plan`（四个 loop 入口） |
| `round` | 本轮 LLM 轮次（`rust-loop-runner` 的 `llmRound`）；`(source, runId, round)` 唯一 |
| `messagesJson` | 真发出的 messages；`truncated=1` 时是**信封**（见下） |
| `messagesChars` | 字符数，口径是 **UTF-16 code unit**（与 JS `String.length` 一致；中文算 1、emoji 算 2） |
| `messagesHash` | 规范化 JSON 的 sha256，用来问「这轮和上轮差在哪」 |
| `systemHash` / `systemChars` | system prompt 的身份与体量（字符数同上是 UTF-16 code unit） |
| `systemText` | 正文**按内容寻址去重**：与 `systemHash` 同内容只存一份（`snapshot_blobs`），行里这列变 NULL。于是 NULL 有两种含义，靠 hash 区分：**hash 有 + blob 有 ⇒ 去重了**；**hash 有 + blob 无 ⇒ 没落库**（空，或超过 `requestSnapshotSystemMaxChars`，看 `systemChars`）。读侧 `get` 会自动拼回来，调用方看到的仍是全文 |
| `toolsHash` / `toolsNames` | 工具集身份 + 名字数组（肉眼扫够用） |
| `toolsJson` | 同上：正文进 `snapshot_blobs`，NULL 语义与 `systemText` 一致 |
| `estTokens` | 用 `token-estimate.js` 估的上下文用量（与 Rust `compaction/tokens.rs` 同口径） |
| `tokenBudget` / `triggerRatio` | **每行都写**：当时的输入预算与触发比（`estTokens vs tokenBudget × triggerRatio` 决定压不压） |
| `compactionRoundCount` | 当时的压缩冷却计数（0 = 这轮没被冷却挡住） |
| `truncated` | 单行 messages 超过 `requestSnapshotMaxMessagesChars` 时存信封 |
| `contextAuditJson` | 见 §2 Q2；**只对当前轮次有效**，`round > 0` 的行一律 NULL（首轮的裁剪事实不能冒充后续轮次） |

**信封（`truncated=1`）**：`{ truncated, chars, maxChars, hash, head, tail }` —— 头尾各 2KB 预览 + 原长 + hash。记不全也比把库撑爆强，且明写 `truncated` 不会假装完整。

---

## 4. 保留策略与体量

| key（`src/agent/agent-limits.js`） | 默认 | 说明 |
|---|---|---|
| `requestSnapshotEnabled` | `true` | 总开关；关掉即完全停写（代码无需回退） |
| `requestSnapshotKeepPerSession` | `40` | 每会话保留最近 40 轮 |
| `requestSnapshotKeepCompacted` | `200` | **压缩过的行**按此上限单独保留（排查重点，不被最近 N 轮挤掉） |
| `requestSnapshotMaxTotalRows` | `1500` | **全库**总行数上限，超过按最旧优先跨会话裁（跨会话按 `id` 取第 N+1 新的 id 再范围删，一次索引定位，不扫表） |
| `requestSnapshotMaxMessagesChars` | `400000` | 单行 messages 上限，超则存信封 |
| `requestSnapshotSystemMaxChars` | `64000` | system 全文落库上限 |
| `requestSnapshotToolsMaxChars` | `96000` | tools 全文落库上限 |

- 裁剪在**写入同一次调用里**完成（Rust `prune_request_snapshots`），没有后台任务。两层窗口：
  先按会话（`KeepPerSession` / `KeepCompacted`），再按全库（`MaxTotalRows`）。
- **为什么必须有全库那一层**：每会话窗口只是乘数里的一个因子，库体积 = 每会话行数 × 用过多少会话。
  2026-11-09 实测：`request_snapshots` 占 1034MB / 全库 1197MB（4818 行、157 个会话、≈220KB/行），
  全是只有每会话上限时的线性增长。
- 保留条数**必须是 ≥1 的整数**：`0` / 负数一律回落到默认值（JS 侧 `positiveIntOrUndefined`，
  Rust 侧 `keep_per_session.max(1)`）。传 0 会把该会话的行连同刚写的那行一起删光 ——
  "刚写进去就没了"是没法解释的现象，所以宁可夹住。全库窗口还会被抬到 ≥ 每会话窗口
  （否则"刚写完就把它自己的最近 N 轮裁掉"）。
- 体量：单行 20–120KB，历史上 system/tools **每行都存全文**。2026-11-19 改成**内容寻址去重**
  （`snapshot_blobs(hash → text)`，行里只留 hash）：现场实测 1500 行里 `tools_json` 88.6MB / 82 种内容、
  `system_text` 6.8MB / 65 种内容 —— 去重后正文只剩 **5.4MB**；库副本上跑同一套 SQL + `VACUUM`，
  文件从 **626.4MB → 461.7MB（−164.6MB / −26.3%）**。新写入即刻生效，历史行由修剪线程每拍搬 400 行
  （`backfill_snapshot_blobs`），读侧两种形状都认。
- 去重表跟着行一起收拾：`prune_request_snapshots` 删完行会清掉**孤立 blob**（没人引用的 hash），
  否则省下来的体积会以另一种形状还回去。
- 删行不等于缩文件：本库 `auto_vacuum = INCREMENTAL`（见 `crates/dieyun-base/src/sqlite.rs`），
  已释放的页要 `PRAGMA incremental_vacuum` 才真正归还。**存量清理**（2026-11-09 实测 1200.6MB →
  541.1MB，删 3318 行）就是「停应用 → 按上限删一次 → `incremental_vacuum` 循环到 freelist 为 0 →
  `wal_checkpoint(TRUNCATE)`」，日常由写入时的裁剪维持，不需要再手动跑。
- 与 `messages` 同库同权限：**敏感级等同对话记录**（system 里可能含注入的代码片段、AGENTS.md 内容）。不能接受就把开关关掉。

---

## 5. 唯一写入点 / 只读面

```
Renderer  ──buildCompletionMessages(audit)──►  contextAudit（折叠/裁剪事实）
                                                    │
Main      runRustAgentLoop ─► fetchRoundOnce ───────┼─► request-snapshot.js 装配
                                                    │        │
                                                    │        ▼
                                                    │   memory.request_snapshot_append（sidecar，必经且唯一）
                                                    ▼
                                              request_snapshots
                                                    │
Gateway   memory.request_snapshot_recent / _get ────┘（只读；UI / 脚本用）
```

**为什么只有这一个写入点**：`runRustAgentLoop` 的 `fetchRoundOnce` 是「body 定稿」的唯一位置——压缩、图片净化、视觉注入都已在它之前完成。四个入口（聊天 / 子 Agent / Planner / 定时）全部经过它，所以不存在"某条路径忘了留底"。

**写入失败不影响请求**：`request-snapshot.js` 内部 try/catch + 日志节流（同 run 每 60s 最多一条 `REQUEST_SNAPSHOT_SKIPPED`）。

---

## 6. 排查清单

| 现象 | 看什么 |
|---|---|
| 模型"忘了"前面说的事 | `contextAudit.fold.foldedCount` + `trim.droppedByHistoryBudget` |
| 上下文明明没满却压缩了 | 该轮 `compacted` + `tokensBefore/After`；再看 `compaction-telemetry.jsonl` 的失败原因码 |
| 明明该压缩却没压 | 该轮 `estTokens` / `tokenBudget` / `triggerRatio` / `compactionRoundCount`：没到阈值 vs 冷却期 |
| 同一轮出现两行快照 | 正常：`reason` 分别是 `initial` 与 `overflow-retry` / `image-repair` |
| 某轮 `systemText` 是 NULL | 先看 `systemHash` 有没有值：**有 ⇒ 去重了**（正文在 `snapshot_blobs`，`get` 会拼回全文）；hash 也为 NULL 才是**没落库**（`systemChars > 0` = 超了 `requestSnapshotSystemMaxChars`，否则是空 system） |
| 想知道工具集什么时候变的 | 按 `toolsHash` 分组，变化点就是变的那一轮 |
| 一条都没有 | `requestSnapshotEnabled` 是否被关；该 run 有没有 `sessionId`（匿名 run 不写） |

---

## 7. 快照 vs 真正发出去的那一份（投影前 / 后）

快照记的是 `round.prepare` 交回的那份**宿主副本**；出站投影（`crates/dieyun-runtime/src/agent/outbound.rs`）
在**之后**才跑。所以两者差固定的五项 —— 不是 bug，是「形状的唯作者在 Rust」这条约束的必然结果
（投影必须在宿主注入视觉/附件/裁剪之后，否则思考回传会有两个作者）。

| # | 差异 | 方向 | 说明 |
|---|---|---|---|
| 1 | `messages[].synthetic` | 快照有 → 上行没有 | 平台补的正文标记，**只在账本里**存在 |
| 2 | `messages[].reasoning` | 快照有 → 上行没有 | 账本内部字段（真思考与上游字段分列） |
| 3 | `messages[].reasoning_content` | 快照没有 → 上行有 | 由 2 抬上去；缺值补**零宽占位串**（见 `agent-shared.json`）；不需要回传时不编这个字段 |
| 4 | `tools: []` | 快照有 → 上行没有 | 空数组整键删（兼容网关会 400） |
| 5 | `stream` / `stream_options.include_usage` | 快照没有 → 上行有 | 传输字段 |
| — | `content` / `tool_calls` / `role` / `model` | **完全一致** | 「模型看到的内容」一个字节都没被改 |

**读法**：快照里的信息 **⊇** 模型看到的 —— 唯一的内容级差异是第 3 项（同值的键名替换 + 占位串），
其余是「多了两个账本标记」与「少了两个传输字段」。所以排障时**不需要还原**，按上表翻译即可。

**闸门**：这张表由 `outbound.rs` 的 `projection_touches_only_the_documented_fields` 钉住 ——
它枚举投影前后被改动的路径集合并断言恰好是上面这些；往投影里加任何新改写，那条用例立刻红。

---

## 8. 已知边界（刻意不做）

- **不做「与上一行相同就写 NULL」的游标式去重**（2026-11-18 删过一次，2026-11-19 换成内容寻址）。
  游标方案被否的三条理由仍然成立：①NULL 变成双重语义（"与上一行相同" vs "超上限没落库"），读侧必须回溯；
  ②游标是**每 run 一份**、表语义却是**会话级** —— 子 Agent 与主循环共用父 `sessionId` 并发写时，
  读侧会把别人的 system 当成自己的；③省的是磁盘，丢的是「这一行到底存了什么」的确定性。
  现在的做法不碰这三条：**按内容 hash 寻址**（`snapshot_blobs(hash → text)`），NULL + hash 存在 = 去重
  （确定性可查），NULL + hash 为空 = 没落库（语义没变）；无游标、无跨行推断、并发写天然安全。
- **不做逐条消息 id 对齐**：那要把 DB 行 id 塞进消息体，破坏"发出去的就是库里那一份"的形状。要"从摘要点回原文"再单独加一刀。
- **不做 UI 面板**：`recent` + `get` 已够渲染一个"本轮请求"抽屉，渲染层自己接。
- **不做加密 / 不做压缩算法**：与 `messages` 同库同权限；保留策略代替压缩依赖。
- **不做全量事件日志**：那是平台税（replay / 投影 / 迁移链），与"整机"定位不符。

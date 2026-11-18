# 记忆系统 vs DeepSeek Harness：抄了什么、明确不抄什么

> 对照对象：DSH `@deepseek-ai/dsh-*` 0.2.1-rc.5（`dsh-session` / `session-persistence-jsonl` /
> `session-query-sqlite` / `tool-session-query` / `session-reference` / `agent-instructions` / `compaction-basic`）。
> 本文只记**结论与理由**，机制细节见 [MEMORY.md](./MEMORY.md)。
>
> 写这篇的原因：两边的取舍在 2026-11 做过一轮，落地了一部分、明确否掉了一部分。
> 不写下来的后果是可预期的 —— 半年后有人再把 DSH 的递归探测、5 个检索工具、事件溯源搬回来，
> 理由是「人家那么做一定有道理」，而当时的反证（成本、单一来源、稳定性）已经没人记得。

---

## 1. 一句话差别

**DSH 是「全量事件日志 + 模型主动检索」，叠云是「LLM 归纳 + 自动注入」。**

- DSH 里根本没有 memory 插件（依赖表 0 个 `dsh-memory`）：它不蒸馏，每个会话是一份 append-only
  JSONL 事件日志（zstd + 校验和，含 tool 调用与推理），压缩只**隐藏**被取代的条目而不删日志，
  模型需要旧事时用 `session_search` 一族工具自己翻。
- 叠云没有「跨会话检索原始对话」的历史包袱，反过来靠单一写入者
  （`src/agent/knowledge-maintainer.js`）把对话蒸馏成长期记忆与项目记忆文件，每轮自动带进上下文。

一句话：**DSH 把成本放在模型侧（要不要查、查什么由模型决定），叠云把成本放在写入侧（归纳预算 + 闸门）。**

---

## 2. 逐项对照

| 维度 | DSH | 叠云（本文落地后） |
|---|---|---|
| 跨会话真相 | 每会话一份 JSONL 事件日志，记录「每个模型可见事实」 | SQLite `messages`（只存 user/assistant 正文，`reasoning` 分列）+ `messages_fts` 影子表 |
| 工具调用是否跨会话可见 | 是，全在日志里，`session_event_read` 可读回 | **否**，中间 tool 链不入库（`agent_runs` 台账留 trace，30 天/500 条后修剪） |
| 进入模型的路径 | ① `@[label](dsh-session:...)` 只读快照 ② 5 个只读工具（opt-in）③ 用户自己粘 | ① 自动注入（项目记忆 / 长期记忆 / 交接 / 压缩摘要）② 工具 `memory_recall`（蒸馏后的结论）③ 工具 `session_recall`（原始对话） |
| 谁决定「记住什么」 | 没人决定，全量留档 | 归纳器单点 LLM 抽取 + 写入侧闸门（低价值 / 近重复 / `kind` 过滤） |
| 检索方式 | FTS5 字面匹配（派生库） | 语义 → 关键词 → 最近三级降级（`long_memories`）+ FTS5 trigram（`messages_fts`） |
| 跨会话授权 | 目标与调用方 `cwd` **完全相等**，否则 `SESSION_QUERY_TOOL_UNAUTHORIZED` | 按 `sessions.workspace_path` 圈定，路径归一只有 `projects::project_path_key` 一份 |
| 不受信任处理 | 快照带固定警告 + `<` 转义 + 3 源上限 + spill 落文件 | 交接块 `<handoff>` 定界 + `<` 转义；`kind=secret/private` 永不自动注入、永不写进仓库文件 |
| 压缩 | 隐藏取代条目，不删日志，原文仍可检索 | 摘要落 `compaction_archives.summary_text`；**被折叠原文**落 `folded_text`（`folded=true` 可检索） |
| 长期记忆生命周期 | 无此概念 | active → stale(120d) → archived(240d)，召回即 bump 计数 |
| 指令 / 规范 | `$DSH_HOME/AGENTS.md` → `~/.agents/AGENTS.md` → 项目根到 cwd 每层 + `.local` overlay，共享 64 KiB | 两层：`<ws>/AGENTS.md`（宽泛）+ `<ws>/.dieyun/AGENTS.md`（具体），**各自独立预算**，同内容折叠 |
| 会话交接 | `fork()` 从精确前缀派生 + `is-seeded` 继承 | `session_handoffs`：判断（模型）+ 原文快照（确定性投影）+ `<handoff>` 定界 |

---

## 3. 已抄的（含落点）

| 能力 | 抄的是哪一点 | 落点 |
|---|---|---|
| 会话正文可检索 | 「原始对话应当能被检索」这个需求 | `messages_fts`（`memory/schema.rs`，与 `long_memories_fts` 同一套探针）+ `memory.messages_search` + 工具 `session_recall` |
| 压缩不丢原文 | 「折叠 ≠ 删除」 | `folded_text` 的读出口 `memory.compaction_folded`（字段早已写入，此前只进不出） |
| 交接的确定性投影 | 「事实由存储负责，模型只写判断」 | `session-handoff.js::buildSnapshot`（判断在前、原文在后） |
| 不受信任定界 | 旧会话内容用标签框住 + 转义 | `system-prompt-prep.js::fetchSessionHandoffBlock` |
| 指令分层 | 「宽泛 → 具体」，冲突以具体为准 | `fetchAgentsMdBlock` 两层链 |
| 内容相同的文件折叠 | 同一份内容不注入两遍 | 同上（`repoText !== dieyunText`） |

---

## 4. 明确不抄的（以及反证）

### 4.1 全量 tool 链入账本

- **为什么 tempting**：DSH 能回答「三个月前那次我们是怎么修的」的完整过程。
- **为什么不抄**：与 `messages` 只存正文的既有决定直接冲突；代价是账本体积、预览渲染、修剪策略三处跟着改。
  而 `request_snapshots` 已经存了每轮真正发出去的完整 `messages`（含 tool 链），保留 40 轮 ——
  「当时模型看到了什么」这个**排查**需求已被覆盖，它不是记忆入口，也不该扩保留策略。
- **反证条件**：如果出现「用户真的需要检索历史命令/文件操作」的真实诉求（不是猜测），
  正确做法是给 `request_snapshots` 加读出口，**而不是**把 tool 链搬进 `messages`。

### 4.2 DSH 的 5 个检索工具

- **为什么 tempting**：`session_search` / `session_event_search` / `session_trace` /
  `session_event_trace` / `session_event_read` 看着是一套完整能力。
- **为什么不抄**：它们是**事件溯源模型的必然产物** —— 有事件 id、有父子 trace 关系，
  所以要 5 个入口分别遍历。叠云没有事件流，仿形只会得到 4 个查不到东西的工具 +
  每轮常驻 5 份 schema（这个成本是每轮、每个请求都付）。已落地的 `session_recall` 一个够用。
- **反证条件**：真要复现「某次运行的事件链」，那属于 `agent_runs` / `agent_traces` 的读出口，
  与记忆无关，别混。

### 4.3 `cwd` 严格相等授权

- **为什么不抄**：叠云的会话本来就绑 `workspace_path`（`session-workspace-bind.js` 是唯一写点）。
  再造一套 `cwd` 相等判定 = 第二个真相源，且两者会在「会话切换瞬间」打架。
- **反证条件**：无。要收窄授权就改 `workspace_path` 的绑定，不新增判据。

### 4.4 AGENTS.md 的多级目录递归 + 增量发现

- **为什么 tempting**：DSH 会从项目根到 `cwd` 逐层加载，`read`/`write` 到更深目录后下一轮自动补上新文件。
- **为什么会**：需要每轮 `fs.list_dir` 探测（RPC 成本 + 要多维护一条列举链路），且候选目录随
  path hints 漂移 —— 结果是「同一份 prompt 每轮内容不一样」，把稳定注入换成了不确定注入。
  而叠云的 `selectSectionsByPath` 已经用 `paths="..."` 条件段覆盖了「按目录命中才注入」这件事。
- **反证条件**：出现「一个仓库里多个子项目各自维护约定、且需要物理隔离」的真实场景。届时先评估
  「单文件 + 条件段」为什么不够，再谈递归。

### 4.5 `$DSH_HOME/AGENTS.md`（用户全局层）

- **为什么不抄**：`~/.dieyun/dieyun.md` 已经是这一层（`dieyunMdMaxChars=6000`，`injectMode` 三档）。
  再加一份同义文件 = 同一件事的第二个来源，用户会问「我该改哪个」。
- **反证条件**：无。

---

## 5. 两边的真实强弱（写在这里，免得自我安慰）

| | DSH | 叠云 |
|---|---|---|
| 强 | 无损、可检索、可 `fork` 回放；压缩不丢原文 | 每轮自动带着走；写入侧有闸门；隐私分层（`kind`）；项目记忆是可 diff 的文件 |
| 弱 | 每轮零帮助，全靠模型想起来调工具，且工具 opt-in 常驻 schema | 有损、不可追：tool 原文不入库，压缩后细节只剩 `folded_text` 片段；用户级记忆没有列表 UI |

**结论：这不是「谁更好」，是「谁的成本放在哪」。** 叠云的问题从来不是「记不住」，而是
「记下来的东西看不见 / 想不起来」。所以补的方向永远是**加取用入口**，不是加存储。

---

## 6. 如果以后还要改这块，先过这三问

1. 这条信息**现在已经存在**吗？（`messages` / `folded_text` / `request_snapshots` / `long_memories` / `.dieyun/*.md`）
   存在 → 缺的是出口，别加存储。
2. 新的入口能不能**并进既有单一来源**？（`fts::match_query` / `ensure_fts_ready` /
   `project_path_key` / `system-prompt-prep` 注入点）
3. 新增的每轮常驻成本（工具 schema、注入块、RPC 往返）**换来的是不是每轮都要用的东西**？
   只在极少数轮用得上的能力，应该是工具，不是注入。

## 7. 相关测试

| 改动面 | 测试 |
|---|---|
| `crates/dieyun-memory/src/memory/`、`fts.rs` | `cargo test -p dieyun-core`（含 `messages_search_matches_across_sessions_within_workspace`、`messages_fts_index_follows_update_and_delete`、`compaction_folded_search_reads_folded_text`） |
| 记忆 RPC / 工具 | `npm run test:local-gateway-smoke`、`npm run verify:rpc-catalog` |
| 交接 | `npm run test:session-handoff`、`test/unit/session-handoff.test.cjs` |
| AGENTS.md 链 | `npm run test:system-prompt-prep`（含 `runAgentsChain`） |
| 注入装配整体 | `npm run test:agent` |

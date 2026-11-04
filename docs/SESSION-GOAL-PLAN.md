# 会话级目标对象（P2）落地方案

> 状态：**P2 全部已实施**（P2a 对象 / 工具 / 每轮注入 / 侧栏「目标」页 → P2b 续跑接线与停止·继续 → P2c 会话内目标条 / 检查事实按检查聚合 / 文档收尾）。前置：P0+P1（删 Explore、删 Composer 模式选择器）已落地。
> 目标口径：**事实驱动**，不是时间驱动，也不是「agent 监督 agent」。

## 0. 一句话

给每个会话一个**可判定的目标对象**（做到什么算完 + 拿什么事实证明），
让「一轮结束」的条件从「模型这轮没调工具」升级为
「模型这轮没调工具 **且** 目标已收尾或预算用尽」——
中间不需要用户点「继续」，也不许代码伪造用户消息。

## 1. 现状与缺口（为什么非做不可）

| 位置 | 现在的事实 |
|---|---|
| `src/renderer/renderer-agent-run.js:191` | 撞上轮次/工具段预算 → `{done:false, needContinue:true}`，注释写着「无人值守的连续推进归目标型计划」 |
| `src/plans/goal-run.js` | 目标语义已完备：`runGoalCheck`（跑命令取事实）、`judgeGoalFinish`（核对主张）、`decideContinuation`（续跑判定）、`renderEvidenceBlock`（事实块） |
| `src/main/mcp-plans-boot.js:371-461` | **只有「计划」能用它**：`beginAttempt` → 跑一轮 → `decideContinuation` → `scheduleNextAttempt(0)` 立刻下一轮 |
| 普通会话 | 没目标对象 → 轮次用尽只能问用户「要继续吗」；用户看到的就是「是不是 P2？然后是不是 P3？」 |

缺的不是「监督器」，是**被监督的对象**：会话没有 goal，判定函数就没有输入。

## 2. 数据模型：`session_goals` 一张表 + 两个 RPC

```sql
-- crates/dieyun-core/src/memory/schema.rs
CREATE TABLE IF NOT EXISTS session_goals (
  session_id TEXT PRIMARY KEY,
  goal_json  TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);
```

- 一个会话最多一条（PK 即约束）；**删会话自动清目标**（memory 库 `foreign_keys = ON`，与 `messages` 同一机制）。
- 不进 `sessions_list` / `sessions_with_messages` 的投影：列表查询保持轻，目标只在开会话 / 起轮时按 sessionId 精确取。
- 列是 **opaque JSON**：Rust 只当 KV，不解析语义 —— 归一化、核对、判定全在 Node 的 `goal-run.js`（AGENTS 原则 1/4：语义单一来源，不在 Rust 抄一份）。
- 不进 `plans.json`：那是调度器配置（rrule / onceAt / 交付会话），会话目标没有 cron、跟着会话生灭（见 §9 论证）。
- RPC（`crates/dieyun-core/src/rpc/mod.rs`）：
  - `memory.session_goal_get { sessionId } -> { goal: object|null }`
  - `memory.session_goal_put { sessionId, goal: object|null }`（`null` = 删除；last-write-wins）
- Node 侧唯一读写点：**`src/goals/session-goal.js`**（`load / save / patch / clear`，内部只用 `goal-run.js` 的 normalize）。

### goal 形状（与 `plan.goal` 同构，复用同一份 normalize）

```js
{
  objective: '实现 X 并让 npm test 通过',       // 一句话目标（人也能读）
  checks: [{ id, command, cwd }],               // 可机器验收的命令，可为空（= 未验证模式）
  todos: [{ text, done }],                      // 可选的推进清单（模型维护，UI 展示）
  evidence: [...],   // 事实（runGoalCheck 产出，复用 normalizeEvidence）
  claims:   [...],   // 模型主张留痕（复用 normalizeClaim）
  outcome: null | 'complete' | 'blocked',
  status:  'active' | 'paused' | 'stalled',
  attempt: 0, attemptStartedAt: null,           // 预算口径，复用 goalMaxAttempts / goalMaxWallMs
  startedAt, updatedAt
}
```

**收敛动作（必须做，否则形状有两个来源）**：把 `normalizeGoal / normalizeEvidence / normalizeClaim`
从 `src/plans/store.js` 迁到 `src/plans/goal-run.js` 并导出，`store.js` 改为 `require` —— 目标形状此后只有一处。

## 3. 工具面：+2，其余复用

| 工具 | 变化 |
|---|---|
| `goal_start`（**新增**） | 模型显式声明目标：`objective`、`checks[]`、`todos[]`。已有 active 目标 → 拒绝并回传现有目标（**单会话单目标**，防每轮重开）。 |
| `goal_update`（**新增**） | 整体替换 `todos`／修订 `objective`／追加 `checks`。一次调用即最新真相，不做逐项增删工具。 |
| `goal_check` | 复用。目标解析改为：`ctx.planId`（计划轮）→ plans store；否则 `ctx.sessionId` → 会话目标。 |
| `goal_finish` | 复用。同上解析，`judgeGoalFinish` 一字不改。 |

为什么是「模型显式声明」而不是代码猜：AGENTS 原则 3 禁意图关键词。
工具描述里写清触发条件（**需要多轮推进、且有一条能判定完成的可执行检查**），由模型判断，
代码只校验形状与「同时只有一个」。

**已定：模型可以在会话里自主 `goal_start`，不需要用户先声明「盯着做到 X」。**
依据：要不要开目标本身就是语义判断，让人先学一套咒语（或者让代码猜关键词）都不如交给模型；
贵的不是「开目标」，是「跑偏 12 轮」。所以成本控制放在三处，而不是加一道许可：
① 单会话单目标 + `goalMaxAttempts`/`goalMaxWallMs` 硬预算；② 侧栏「目标」页常显剩余项与轮次，随时可见；
③ 一次「停止」即 `status:paused`，此后不再自动续跑，直到人再点「继续」。

`goal_check` 跑命令仍走 `host.exec` → 与普通工具**同一套沙箱档位与 ask-once 审批**，不因为「这是验收命令」而放宽（一致性优先于便利）。

## 4. 每轮注入：Main 的 `turnHost` 是唯一位置

`src/agent/system-prompt-prep.js:1110-1120` 已在拼每轮注入块（handoff / repoMap / memory / compaction / skills）。
加一个 `fetchSessionGoalBlock(snap, invokeRpc, lim)`，写进同一个 `turnHost`：

```
【当前目标】<objective>（第 3/12 轮 · 预算剩 40 分钟）
- 未完成：A、B
- 最近事实：`npm test` → exit 1（未通过）；`npm run lint` → exit 0（通过）
> 目标未收尾就继续推进，不要停下来问用户下一步；要不要收尾由 goal_check 的事实说话。
```

三条边界（照抄 `goal-run.js` 的既有纪律）：

1. **只陈述事实，不写结论** —— 代码不输出「已完成/未完成」的判断，措辞由读到的模型与人负责。
2. 事实行复用 `renderEvidenceBlock` / `factLine`，不另写一份摘要（防两处漂移）。
3. 块长有上限（复用 `goalEvidenceTailChars`、事实条数上限），不随轮次无限增长。

无目标时该块不产出 —— 普通会话的 prompt 一个字节不变（回归零风险）。

## 5. 续跑接线：判定在 Main，机械执行在 Renderer

### 边界：一次 `agent:rust-loop-run` = 一个 turn

Renderer 的段循环（`renderer-agent-rust-loop.js:1077` 的 `while (true)`）实际只跑一遍就 `break`，
所以「一轮 turn 结束」= 一次 `agent:rust-loop-run` 的返回。这是唯一的判定时点。

### 判定（唯一来源，在 Main）

`agent:rust-loop-run` 的返回值增加一个字段（`src/main/ipc/agent-runtime.js:152` 的 handler 收尾处）：

```js
goal: { active: true, cont: true, stop: null, attempt: 3, max: 12 }   // 无目标时整个字段省略
```

内部就是现成的一行：`decideContinuation({ plan: sessionGoal, limits, now })`。
轮次计数不在这里：它在**一轮开始时**（`agent:rust-loop-run` 入口的 `advanceAttempt`），一次轮次只计一次；
判定只用现成的 `attempt` 与墙钟（`attemptStartedAt`，缺失时退化为 `startedAt`）。

### 执行（Renderer 只照做，不持有目标状态）

```js
// src/renderer/renderer-agent-run.js:191 —— 与既有 hitRoundLimit 合流，同一个语义：机械再来一轮
if (result?.hitRoundLimit || result?.goal?.cont) {
  return { done: false, needContinue: true, goalContinue: !!result?.goal?.cont, result };
}
```

消费点两处，形状完全一样（`renderer-agent-send.js:667`、`renderer-agent-resume.js:68`）：

```js
if (!run.done) {
  if (run.goalContinue) { await startGoalTurn(runSessionId); return; }  // 自动开下一轮
  pauseAgentForToolLimit(run, frame);                                   // 无目标时维持现状：显示「继续」行等用户点
  return;
}
```

`startGoalTurn` = 走**同一条发送装配**（`sendMessage` 的内部入口，带 `goalTurn:true`）：
不产生用户气泡、不写用户轮次、照常重算系统提示与历史、照常落 undo 点与请求快照。
唯一区别是没有用户文本 —— 驱动下一轮的是 system 里的目标事实块，**不是伪造的用户消息**（这正是 AGENTS 原则 5 禁止的那种东西）。

### 为什么是「新的一轮」而不是「段续」

现有「继续」按钮续的是**同一轮**（`pauseAgentForToolLimit` → `resumeAgentToolLoop`，靠 `continueFrom` 续段）。
目标推进必须开新轮，理由三条：

1. **目标块要刷新**：新轮才重算系统提示，模型才能看到「第 3/12 轮、还剩 A 和 B、最近 `npm test` exit 1」。
2. **边界要真实**：新轮自带 undo 点、压缩点、交付点、请求快照；段续会把整个目标塞进一个越来越长的 turn，压缩频繁介入、进度不可见。
3. **预算要可数**：`attempt` 的语义就是「轮」；段续会让它退化成「段」，`goalMaxAttempts` 失去意义。

Renderer 里**不出现** `attempt`、`maxAttempts`、`stop` 这些概念 —— 它只读一个布尔。预算、事实、判定全在 Main。

### 停止与插话

| 情形 | 行为 |
|---|---|
| 用户点「停止」 | 现有 abort 中断本轮；同时 `session-goal.patch {status:'paused'}`（否则下条消息又被自动续跑，属于「代码比人更坚持」） |
| 用户中途发新消息 | 就是普通一轮（人驱动的轮不计 `attempt`，墙钟照走）；目标照旧注入，模型自己决定继续还是 `goal_finish` |
| 用户换了个目标 | 模型调 `goal_start` → 覆盖旧目标（单目标约束天然成立） |
| `attempts` / 墙钟用尽 | `status:'stalled'`，停自动续跑，注入块明说「预算已尽，等你决定」；UI 出现「继续」= 重置预算（一次 `session_goal_put`） |
| `outcome=complete` | 停；目标留作历史，注入块转为「已收尾 + 事实摘要」 |

### 为什么不在别处续跑

- **不能在 Rust loop 里「继续」**：那是伪造用户轮次（AGENTS 原则 5 明令禁止），会把「一轮结束」的语义搞脏。
- **不能在 Main 另起一套 turn runner**：会话轮的装配（会话模型选择、Renderer 侧召回/折叠快照、请求快照审计）在
  「Renderer 上报快照 + Main 组装」这条链上；`channels/agent-turn.js`、`plans/plan-agent-runner.js` 是**降级装配**（无会话模型、无 Renderer 召回）。
  拿它跑用户会话 = 自动续跑的那几轮和用户手发的轮行为不一致。会话目标借用的是它们**已经证明可行的事实/判定**，不是它们的执行装配。
- **不能时间驱动**：定时器只知道「到点了」，不知道「目标推进到哪」；每轮结束立刻判一次事实，才是唯一的正确触发点。

## 6. UI：一条目标条 + 侧栏「目标」页

### 6.1 目标条（会话内，常驻一行）

- 位置：气泡区顶部常驻一行（`.agent-chat-column` 的第一个子元素，`#goal-bar`）：
  `◎ 目标… · 第 3/12 轮 · npm test → exit 1`，点击展开就地看全部事实。
  （不放进 `.chat-viewport`：那里是滚动容器 + absolute 的 `.chat-nav` 刻度，塞进去不是随内容滚走就是压住刻度。）
- 按钮只有两个：**停止**（跑动中）、**继续**（`stalled` / `paused` 时出现）。
- 不收尾就不出现「是不是要继续」这类请示气泡 —— 这是本方案要消灭的头号症状。

### 6.2 侧栏「目标」页（新页签，`data-side-tab="goal"`）

新的 `src/renderer/renderer-goal-panel.js`，与「变更 / 源码管理 / 索引」同构（rail 按钮 + `data-side-pane="goal"` 一块 DOM）：

```
┌ 目标 ──────────────────────────  第 3/12 轮 · 进行中 ┐
│ 实现 X 并让 npm test 通过                            │
│                                                      │
│ 进度 ▓▓▓▓▓▓░░░░  2/5                                │
│  ✅ 拆解模块与接口                                   │
│  ✅ 写实现                                           │
│  ⬜ 补测试          ← 当前轮在做                       │
│  ⬜ npm test 通过                                    │
│  ⬜ 清理临时脚本                                      │
│                                                      │
│ 验收事实                                             │
│  14:02 `npm test`            exit 1（未通过）         │
│  14:07 `npm run lint`        exit 0（通过）           │
│                                                      │
│ [停止]  [继续]（仅在 stalled/paused 时出现）            │
└──────────────────────────────────────────────────────┘
```

- **数据**：`gatewayCall('memory.session_goal_get', { sessionId })`；随 `AGENT_RUN_EVENT_TYPES.TRACE` 节流刷新（不新增推送通道、不新增事件类型）。
- **无目标时**：整页显示一行「本会话还没有目标 —— 需要多轮推进时，助手会自己建一个」（不隐藏页签，避免布局跳动）。
- **所有会话共用一页**，跟着 `currentSessionId` 切；切会话时重新拉取（与「变更」页同一套切换钩子）。
- 不做编辑：目标的增删改属于模型（`goal_start` / `goal_update`），人来这里是为了**看进度**与**停/继续**。
- 看板入口复用现有面板：`openSidePanel({ tab: 'goal' })`，`loadSavedSideTab()` 白名单加一个 `'goal'`。

## 7. 与「目标型计划」的关系

| | 目标型计划（已有） | 会话目标（本方案） |
|---|---|---|
| 触发源 | 调度器（cron / idle tick） | 人说话 → 模型 `goal_start` |
| 存储 | `plans.json`（含 rrule、交付会话） | `session_goals` 表（跟会话生灭） |
| 生命周期 | 跑到达成/预算尽后停用 | 会话在则在，删会话即清 |
| 判定/事实/工具 | `goal-run.js` + `goal_check`/`goal_finish` | **同一份**（目标解析多一个分支） |

两套触发、一套语义。会话目标**不进** `plans.json`，也不出现在「自动化」列表里（那里只放定时任务）。

两条入口的**目标形状完全同构**（`goal-run.normalizeGoal`）：`objective`（一句话说清什么算达成，两边都必填）+
`checks`（可执行命令）+ `cwd`。计划侧一度只落 `checks/cwd`，于是「自动化 → 目标」卡片里目标正文空着、
每轮交接班也没有「什么算达成」；现在 `plan_create` 的 `goal.objective` 与 `goal_start` 同一条契约。
`cwd` 只属于计划（会话目标用会话绑定的工作空间）。

## 8. 改动清单

| 文件 | 改动 |
|---|---|
| `crates/dieyun-core/src/memory/schema.rs` | 建 `session_goals` 表（+ 迁移注释） |
| `crates/dieyun-core/src/memory/mod.rs` | `get_session_goal` / `put_session_goal`；`memory.sessions_*` 删除路径依赖 CASCADE，无需额外代码 |
| `crates/dieyun-core/src/rpc/mod.rs` | `memory.session_goal_get` / `memory.session_goal_put` 分发 |
| `src/plans/goal-run.js` | 导出 `normalizeGoal / normalizeEvidence / normalizeClaim`（从 `store.js` 迁入）；新增 `renderSessionGoalBlock(goal, limits)` |
| `src/plans/store.js` | 改为 `require` 上述 normalize，删本地实现 |
| **`src/goals/session-goal.js`（新）** | `load / save / patch / clear`、单目标约束、`attempt` 自增、`status` 迁移 |
| `src/agent/tool-catalog.js` | `GOAL_START_TOOL`、`GOAL_UPDATE_TOOL`；`goal_check/goal_finish` 描述改为「会话目标或计划目标」 |
| `src/agent/tool-bridge-main.js` | 目标解析 `resolveGoalTarget(ctx)`；`goal_start`/`goal_update` 实现；`goal_check`/`goal_finish` 落到解析结果 |
| `src/agent/system-prompt-prep.js` | `fetchSessionGoalBlock` → `turnHost`（唯一注入点） |
| `src/main/ipc/agent-runtime.js` | `agent:rust-loop-run` 收尾附 `goal:{active,cont,stop,...}`；`agent:goal-set`（UI 继续/暂停） |
| `src/renderer/renderer-agent-run.js` | `:191` 与 `goal.cont` 合流 |
| `src/renderer/renderer-agent-send.js`、`renderer-agent-resume.js` | `:667` / `:68` 的 `if (!run.done)` 分支加 `goalContinue` 路径；新增 `startGoalTurn`（`sendMessage` 的 `goalTurn:true` 内部入口：无用户气泡、无用户轮次）；停止时 `agent:goal-set {status:'paused'}` |
| `src/renderer/renderer-chat-live-run.js` | 目标条跟着事件走的那一拍：`scheduleGoalUiRefresh()`（与子代理面板同处） |
| `src/renderer/index.html` | ① rail 按钮 `data-side-tab="goal"` + `data-side-pane="goal"` 一块 DOM（两侧必须成对，`check-renderer-index-panel.cjs` 会卡数量不一致）；② 目标条 `#goal-bar`（`.agent-chat-column` 第一个子元素） |
| **`src/renderer/renderer-goal-panel.js`（新）** | 目标的两个面（气泡上方目标条 + 侧栏「目标」页）：objective / 进度条 / 按检查聚合的验收命令 / todos / 事实列表 / 停止·继续；两个面共用一次取数与一个轮询 |
| `src/renderer/renderer-side-panel.js` | `loadSavedSideTab()` 白名单加 `'goal'`；切会话时触发该页刷新 |
| `src/renderer/styles.css` | 目标条 / 展开区 / 按检查聚合的验收命令样式 |
| `src/renderer/renderer-chat-render.js` | 切会话 / 重绘后重取一次（`finalizeChatRenderAfterMessages`），否则上一个会话的目标会挂在新会话上方 |
| `docs/rpc-catalog.md`、`docs/CODEMAP.json` | 新 RPC / 新模块（`verify:rpc-catalog` 会卡） |

## 9. 新增点逐条「为何删不掉」（AGENTS 原则 2）

| 新增 | 为什么不能并入既有单一来源 |
|---|---|
| `session_goals` 表 | 会话目标必须跟会话同生共死（删会话即清、不进 cron、不污染 `plans.json`）。塞进 plans store：孤儿目标会被 `_idleTick` 拉起来在后台烧 token，且会出现在「自动化」列表里。 |
| 2 个 RPC | Rust 只是 KV；不新增「目标判定」RPC，判定留在 `goal-run.js`（否则语义两份）。 |
| `goal_start` / `goal_update` | 目标必须由模型显式声明（禁关键词猜）。`plans_create` 语义是「建一条计划」（prompt/rrule/交付会话/二次解析），拿它当目标入口等于把调度概念塞进会话。 |
| 注入块 | 目标事实必须每轮出现且只出现一次；`turnHost` 就是那个唯一装配点，不存在其它候选。 |
| `goal` 返回字段 | 判定必须在单一来源（`goal-run.js`），Renderer 只消费一个布尔 —— 加字段，不加状态机。 |
| 无 | 不新增预算键（复用 `goalMaxAttempts`/`goalMaxWallMs`/`goalRetryBackoffMs`）、不新增事件类型、不新增面板、不新增开关。 |

## 10. 分三步落地（每步可独立验证 / 回滚）

**P2a：对象 + 工具 + 注入 + 面板（不自动续跑）——已实施**
1. 表 + RPC + `session-goal.js` + normalize 收敛
2. `goal_start` / `goal_update` + 目标解析
3. 注入块（只注入；`agent:rust-loop-run` 还不返回续跑字段）
4. 侧栏「目标」页（只读视图 + 清除；面板从 P2c 提前到这里，因为「看得见目标」是这步唯一的验证手段）
> 验证点：手动要模型「盯着做到 npm test 通过」，模型能声明目标、每轮看到事实、`goal_finish` 被事实核对。

落地后的实际形状（与上面设计的差异，均为减法）：
- 表：`session_goals(session_id PK, goal_json, updated_at)`，`ON DELETE CASCADE`（Rust 只当 KV，语义全在 Node）。
- RPC：`memory.session_goal_get` / `memory.session_goal_put`（`null` = 删除）。
- 归一化不是新写的：`normalizeGoal/normalizeEvidence/normalizeClaim/normalizeBudget/normalizeIso` 从 `plans/store.js` **搬进** `plans/goal-run.js`，计划目标与会话目标共用一份（`store.js` 反向 require）。
- 每轮注入：`system-prompt-prep.js#fetchSessionGoalBlock` → `goal-run.renderSessionGoalBlock`（措辞单一来源），排在 `turnHost` 最前。无目标时返回空串，普通会话 prompt 零变化。
- 轮次计数：`agent:rust-loop-run` 入口对「进行中」的目标 `advanceAttempt`（Renderer 一轮 = 目标一轮；子 Agent / 频道 / 计划不走这条 IPC，不会重复计数）。
- 工具面：`goal_start` / `goal_check` / `goal_finish` / `goal_update` **常驻**。曾按「本会话已有目标」条件暴露，但工具表在轮次开始时定死、轮内不再变 —— 同一轮里刚 `goal_start` 出来的目标会当场没有 `goal_check`/`goal_finish` 可用，等于「能开不能收」。没有目标时这四件工具回结构化错误（`NO_SESSION_GOAL`），比「工具不存在」更准确。
- 面板：`data-side-tab="goal"` + `renderer-goal-panel.js`；视图在 Main 成形（`session-goal.toPanelView`），Renderer 只画；可见时 2s 轮询、不可见即停（不新增事件类型）。
- 工具面的作用域：先在**桌面聊天**路径给齐（`renderer-tool-defs.js`）。频道 / headless 走各自的 Main 侧工具集，这一版没给 —— 它们的会话不经过 Renderer，也没有面板可看，先不给比给了看不见更诚实；P2b 收续跑时一并评估。
- 未做（留给 P2b）：`agent:rust-loop-run` 的 `goal:{active,cont,stop,attempt,max}` 返回字段、`startGoalTurn`、暂停/停止的状态迁移按钮。

**P2b：续跑接线 ——已实施**
4. `agent:rust-loop-run` 附 `goal`（并入 `decideContinuation`）
5. `renderer-agent-run.js` 合流 + 两处消费点 + `startGoalTurn`（无用户文本的一轮）
6. 停止/暂停/预算收敛（`status` 迁移）+ 面板加「停止/继续」
> 验证点：一个 3 步任务，零点击跑到底；预算尽时停下来并说明白；中途「停止」后下条消息不再自动续跑。

落地后的实际形状（同样按减法收敛过）：
- **判定**：`session-goal.judgeAfterTurn({invokeRpc,sessionId,limits})` → `{active,cont,stop,attempt,max}`；内部就是 `decideContinuation({plan,limits})`，无目标 / 已收尾 / 已暂停直接返回 `null`。`agent:rust-loop-run` 在 `readiness` 之后调它一次，把结果挂到 `result.goal`。判定失败一律返回 `null`（不续跑），不会因为目标子系统出问题就卡住交付。
- **轮次计数仍在轮次开始时**（P2a 的 `advanceAttempt`），不是判定时自增 —— 一次轮次只计一次，人发的轮与自动续跑的轮口径一致，也就不存在「判定时 +1 与开始时 +1」两份计数。代价是轮次写盘失败时次数会停在原地，所以判定里给墙钟加了退化起点：`attemptStartedAt` 缺失时用 `startedAt`，最坏也能在 `goalMaxWallMs` 到点时停下。
- **合流**：`renderer-agent-run.js` 里 `hitRoundLimit` 与 `goal.cont` 是两件事 —— 前者是「这一段额度用尽」（车停着等用户点继续），后者是「这一轮正常结束、目标还没完」。只有前者且没有目标在推时才返回 `needContinue`；有目标在推时本轮正文照常交付，再 `goalContinue:true` 交给消费点开下一轮。
- **执行**：`startGoalTurn` = 走同一条 `sendMessage` 装配 + `goalTurn:true`：不建用户气泡、不写用户消息、不落库、不动附件；请求尾补一条 `[系统] 目标尚未收尾…`（与段续 `SEGMENT_CONTINUE_USER_MSG` 同一机制，加进 `isSyntheticLoopUserContent` 白名单），于是【当前任务】仍是用户原本那句话。驱动下一轮的始终是 system 里的目标块。召回查询词用目标原文（面板视图同一份），不是空串。
- **谁来触发**：`sendMessage` 的 `finally`（本轮运行态、气泡、队列都释放之后）与 `renderer-agent-resume.js` 的续跑路径，各自 `kickGoalTurn` 一次；都只在**当前视图就是该会话**时真开轮，切走了就停（目标保持 active，回来发一句话继续推进）。与对端 agent 绑定的会话（会话即通道）也不自动开轮：那里每一轮都可能被投递给对方，代码自己决定再跑一轮 = 替人向对方连发消息。
- **停止 / 继续**：对话区那颗停止（`renderer-agent-abort.js`）在真的有运行时可停时顺带 `pause` 目标 —— 否则「用户按了停止，下一条消息结束又自动续跑」就是代码比人更坚持。面板的「继续」走 `agent:session-goal-panel {action:'resume'}`：`status→active`、`attempt→0`、墙钟重起算，**事实与清单全留**（它们是下一轮的判断依据）。
- **预算用尽**：判定给 `stop:'attempts' | 'budget'` 时把状态落成 `stalled`，注入块与面板都说「预算已尽，等你决定」，不再自动续跑。
- **留给 P2c 的两项**（目标条、事实分组）已在 P2c 做完，见下。**仍未做**：频道 / headless 会话的目标工具面 —— 它们不经过 Renderer，也没有面板可看。

**P2c：目标条 + 收尾 ——已实施**
7. 目标条（§6.1）
8. 面板打磨（事实分组、按检查聚合）
9. `docs/` 同步（`DESIGN.md` §4.5 + §15、`HARNESS-INVENTORY.md`、`CODEMAP.json`、`src/renderer/README.md`、本文件转「已实施」）
> 验证点：跑一个带检查的目标，气泡上方那行就能看出「第几轮 / 最近一条检查是什么结果」，不用开侧栏；展开能就地看到每条检查的最新结论与次数。

落地后的实际形状：
- **目标条**（`#goal-bar`，`index.html` + `renderer-goal-panel.js`）：一行 = `◎ 目标… · 第 3/12 轮 · npm test → exit 0`，收尾/暂停/预算尽时把状态词并进同一行；右侧只有「继续 / 停止」两颗，出现条件与面板同一判据（`goalCanContinue`）。点击展开就地渲染「每条检查的最新结论 + 次数 / 推进清单 / 最近事实流水」。
- **放哪儿**：`.agent-chat-column` 的第一个子元素（气泡区上方），**不是** `.chat-viewport` 里 —— 视口内是滚动容器加 absolute 的 `.chat-nav` 刻度，塞进去要么随内容滚走、要么压住刻度。
- **两个面一次取数**：`refreshGoalPanel()` 取一次视图，同时渲染面板与目标条；心跳只在「面板可见 **或** 目标条在显示」时跑（2s，本地 RPC）。没有目标的会话零成本。
- **轮内怎么跟上**：`scheduleGoalUiRefresh()`（400ms 节流）挂在 `dispatchAgentRunEvent` 里「子代理面板刷新」的同一拍 —— 目标由模型在轮内改，事件才是唯一知道的时机；目标条也要靠这一拍才知道「这个会话刚有了目标」。切会话/重绘由 `finalizeChatRenderAfterMessages` 重取一次。
- **面板打磨**：`toPanelView` 的 `checks` 从「命令清单」升级为**按检查聚合**（`runs` 次数 + 最新 `ok/exitCode/round`），判据复用 `goal-run.factsForCheck` / `latestFactFor`（与 `judgeGoalFinish` 同一套匹配规则，没有第二份）。三态而不是两态：声明了但从没跑过是 `⬜ 还没跑过`，画成失败会冤枉模型。
- **两处滚动容器不再每 2s 跳回顶部**：`writeGoalHtml()` 内容没变就不动 DOM。目标越推进、事实越多，这个毛病越明显。
- **没做的**：目标条的键盘跳转与「点事实跳到对应气泡」；频道 / headless 的目标工具面。

## 11. 测试

| 层 | 用例 |
|---|---|
| 纯函数 + 注入 + 工具端到端 | `test/unit/session-goal.test.cjs`：存取往返 / 单目标护栏 / 损坏 JSON 当无目标 / 轮次与事实保留 / 面板视图 / 注入块四种状态措辞（且无目标时零注入）/ 入参校验 / `goal_start→goal_check→goal_finish` 全链路（含「没通过就被打回」） |
| 续跑（P2b） | `test/unit/session-goal-continue.test.cjs`：无目标 / 已收尾 / 已暂停 → 不续；预算充足 → `cont=true` 且不改状态；轮次或墙钟用尽 → 不续且落 `stalled`（`outcome` 仍为空）；`resume` 重置轮次但保留事实与清单；已收尾的目标不给「继续」 |
| 目标条 / 面板渲染（P2c） | `test/unit/renderer-goal-bar.test.cjs`：无目标时收起 / 一行文案与状态词 / 按钮出现条件（跑动中停止、停下且未收尾继续、收尾后不给继续）/ 展开区的三态标记与聚合次数 / 取数失败不改写面板文案（`new Function` + DOM 桩，与 `renderer-tool-artifact-path.test.cjs` 同一手法） |
| Rust | `cargo test -p dieyun-core memory::goal`：`put/get` 往返、空/超大拒绝、覆盖写、`null` 即删除、删会话级联清理 |
| RPC | `npm run verify:rpc-catalog` + `npm run test:local-gateway-smoke` |
| Renderer | `npm run check:renderer`（含 rail/pane 成对与 DOM id 引用）、`npm run test:renderer` |
| 面板 | `npm run check:renderer` 的 `check-renderer-index-panel.cjs`：新页签两侧成对、页签不重名；`renderer-goal-panel.js` 的 DOM id 全部存在 |
| Agent | `npm test`（按 diff 选测）、`npm run test:agent` |
| 端到端 | `examples/agent-sandbox`：给一个「实现 X 且 `npm test` 通过」的目标，观察 ≥3 轮自动推进 + 收尾必须有 `exit 0` 事实；再跑一次故意让检查失败，确认不会自我宣布完成 |

## 12. 验收标准（对着最初的抱怨）

1. 一个明确的三步任务，**一次发话跑到底**，中途不出现「要不要继续 / 是不是下一步」。
2. 收尾必须有事实：没有 `exit 0` 的检查，`goal_finish(complete)` 被打回并把失败尾部回灌给模型。
3. 预算用尽 → 停下并说明「跑了 N 轮 / 最后一条检查 exit 1」，不包装成完成。
4. 用户任何时候能停，停了就不会自己再跑。
5. 没有目标时，普通会话的 prompt、事件、UI 与今天**完全一致**（零回归）。

## 13. 风险与对策

| 风险 | 对策 |
|---|---|
| token 消耗 | 复用 `goalMaxAttempts` / `goalMaxWallMs`；`stalled` 后必须有人动作才继续；目标条常显「第 N/M 轮」让成本可见 |
| 模型误声明目标（小事也开目标） | 工具描述写清触发条件；单目标约束；用户可以随时停；不求一次到位 —— 先用端到端用例校准描述 |
| 注入块膨胀 | 固定形状 + 事实条数/字符上限；只放最近事实与未完成项 |
| Renderer 多一个自动开轮入口 | 它只读 `goal.cont` 布尔并就照做；`attempt/预算/事实/判定` 一律不落 Renderer（注释 + 回归测试锁住边界） |
| 与 completion-readiness 重复提示 | readiness 保持「只提示、不挡交付、不续跑」；目标体系管「围绕目标的推进」，两者不互斥 |
| 会话目标与计划目标事实互串 | `resolveGoalTarget` 单一入口：`ctx.planId` 优先，其次 `ctx.sessionId`；两者都有时计划优先并留日志 |

# 目标型长任务（Goal Run）方案：跑到「真的完成」

> 状态：**已实施（P0）** —— 实施记录与「与草稿的差异」见 §10
> 目标场景：晚上交待一个复杂任务，需要连续工作数小时，会话/进程中途停下后要能自己接着干，直到**有证据地**真正完成。

---

## 0. 结论（TL;DR）

1. **不用新造「目标子系统」**。`src/plans/` 已经是本仓唯一一处「外部触发的独立 agent run + 落盘运行边界」，目标型长任务 = `plans` 的第三种触发器 `trigger: 'goal'`，加上「谁来判继续」和「崩溃后重新入队」两块。
2. **续跑决策权归调度器，不归模型**。模型只能干活和自述；「是否再来一轮」由 Main 里的 `PlansScheduler` 依据**落盘的验收证据**判定。
3. **完成必须有硬证据**：`goal.verify` 是用户给定的可执行验收命令（`npm test` / 构建 / 断言），走既有 `host.exec` 唯一入口。跑通才算完成；模型自称完成不算。
4. **崩溃恢复只改一处语义**：`recoverInterruptedRuns` 从「补写中断回执」升级为「补回执 + 重新入队一轮」（受 attempt / 退避 / 预算约束）。
5. **P0 不做**：跨进程守护（开机自启/计划任务）、独立 Reviewer 二次确认、纠偏阶梯。这些是 P1/P2，且必须在 P0 的落盘状态上长出来。

---

## 1. 问题：先把「会话会停」拆成三种

设计错的根源是把三件事混在一起谈。

| 层级 | 停的原因 | 谁能让它继续 | 本仓现状 |
|---|---|---|---|
| ① 轮次内停 | 模型不再发工具调用（自认完成 / 掉进死胡同） | 同进程的循环器 | `rust-loop-runner` 的 while + `repeatToolStreakLimit` / `runStallAbortMs` |
| ② 预算耗尽 | 轮次上限、token 预算、工具卡死、无进展熔断 | 循环器只能**停 + 交付报告** | `agent-limits.js` 已有数字；缺「停之后谁接手」 |
| ③ 会话/进程停 | 断网、API 超时、Electron 崩了/被关、电脑睡眠 | **只有进程之外的东西能拉起** | 有 `runState` 落盘 + 中断回执，但**只补回执、不重跑** |

夜间跑一整晚，③ 是主要矛盾。核心不是「让 agent 更努力」，而是**把「目标尚未完成」落盘成一个外部可读、外部可判的状态**。

---

## 2. 调研结论（决策依据）

四类主流做法，及其在本仓的适用性：

| 做法 | 代表实现 | 机制要点 | 本仓是否采用 |
|---|---|---|---|
| **A. Ralph 循环 / Stop-hook** | [Claude Code ralph-wiggum 插件](https://mintlify.wiki/anthropics/claude-code/plugins/bundled/ralph-wiggum) | 外部 `while` 反复喂同一 prompt，靠 Stop hook 拦退出，完成靠**约定字符串** | ❌ 完成判定太弱，且本仓明令禁止「假用户续跑」 |
| **B. 目标持久化 + 自动续跑** | [Codex CLI `/goal`](https://simonwillison.net/2026/apr/30/codex-goals/)、本仓所在这套 harness 的 `create_goal` + 自动续跑轮次 | goal 落盘；每轮结束**判定** 继续/阻塞/完成；预算耗尽 ≠ 完成，改为输出审计报告 | ✅ **主结构参照** |
| **C. 跨 context window 交接** | [Anthropic long-running harness](https://www.anthropic.com/research/effective-harnesses-for-long-running-agents) | initializer 写 `feature_list.json`（`passes` 字段）+ `progress.txt` + `init.sh` + git；后继 session 开局读文件、**一次只做一个 feature** | ✅ **验收面 + 开局交接**照抄 |
| **D. 持久化执行 / 外部监督者** | [Temporal×LangGraph durable execution](https://temporal.io/blog/temporal-langgraph-plugin-durable-execution)、[mortal orchestrator + filesystem resume](https://raw.githubusercontent.com/ai-cad-labs/ai-cad/refs/heads/main/docs/architecture-decision-records/0012-mortal-orchestrator-filesystem-resume.md)、[supervisor 纠偏阶梯](https://github.com/jwbron/egg/blob/aa1034caaa826896c6ab46a9339046383ebe1615/docs/architecture/orchestrator.md) | run 视为可重放 workflow；进程可死，重启后从落盘状态恢复；纠偏逐级加码 | ⚠️ 状态恢复采用；纠偏阶梯推迟到 P2 |

Anthropic 同一系列的后一篇（[harness 设计 / generator-evaluator](https://cloud.tencent.cn/developer/article/2647128)）给了两个反面教训，本方案直接吸收：

- **成本锚点**：三 agent harness 4 小时约 $124，单 agent 基线 1 小时 $3.53。→ 必须有 `budget`，不能裸跑一晚。
- **执行者 ≠ 评判者**：让生成者自我批判远难于校准一个独立评估者。→ 验收面必须是**可执行命令**，不是模型自评。
- **脚手架会过时**：模型变强后要主动拆脚手架。→ 新增机制仅限本方案明确列出的字段，不预埋扩展点。

### 2.1 四条硬原则（写进验收）

1. **单一真相在盘上**：目标、进度、待办、证据 → `plans.json`；不能只活在 `messages`（compaction 会嚼碎）。
2. **完成基于证据**：`goal.verify` 退出码为 0。不认「语气自信」。
3. **执行与评判分离**：验收由 Main 跑命令，不由模型声明。
4. **熔断先于续跑**：预算/无进展/重复动作/需人工审批 → 停 + 写审计报告；**预算耗尽永远是「未完成」**。

---

## 3. 本仓现状盘点

已具备（**全部复用，不重写**）：

| 能力 | 单一来源 |
|---|---|
| 外部触发的独立 agent run（带 todos / skills / 模型路由 / 投递会话） | `src/plans/plan-agent-runner.js`、`plan-tools.js` |
| 闲时触发 `trigger:'idle'`（无活跃 loop 且静默达标 → 跑一次，成功即停用） | `src/plans/scheduler.js#_idleTick` |
| 定时触发（rrule / onceAt） | `src/plans/rrule-next.js`、`scheduler.js#_arm` |
| 每轮触发写入计划专用会话的用户轮次 + assistant 轮次落库 | `src/plans/plan-run-turn.js` |
| 运行边界落盘 `beginRun/endRun/listRunning` | `src/plans/store.js` |
| 崩溃恢复（补写中断回执 + 收尾通知） | `src/main/mcp-plans-boot.js#recoverInterruptedRuns` |
| 收尾：结论落盘 / 托盘 / `onPlanRan` hook / `plans:ran` | `src/main/mcp-plans-boot.js#createFinishPlanRun` |
| 循环熔断数字（轮次 / 重复动作 / run 无进展 / 工具卡死） | `src/agent/agent-limits.js` + Rust `DEFAULT_MAX_ROUNDS` |
| 命令执行唯一入口（含沙箱三档） | `host.exec`（`src/gateway/handlers/host.js` + `sandbox-policy.js`），硬上限 `SHELL_TIMEOUT_MAX_MS = 600s` |

缺口（**P0 只补这三个**）：

1. **目标不是一等对象**：`plan` 有 `prompt` + `todos`，但没有「验收面 + 预算 + 第几轮 + 上次证据」，无法回答「到哪算完成」。
2. **没有续跑决策点**：一次 run 结束就结束，没人回答「未完成 → 再来一轮」。
3. **③ 层没兜住**：崩溃只补回执；`trigger:'idle'` 成功即 `enabled=false`，进程死 = 任务死。

---

## 4. 设计

### 4.1 数据：`plans.json` 新字段（唯一存储，不新增文件）

`normalizePlan()` 增加/保留：

```js
{
  trigger: 'goal',                  // 第三种触发器：目标型

  goal: {
    verify: string,                 // 用户给定的可执行验收命令（绝对唯一硬证据）
    cwd: string                     // 可选；缺省 = 计划 workspace
  },

  budget: {                         // 用户「选择」；上下限 clamp 见 agent-limits
    maxAttempts: number,            // 最多续跑轮数
    maxWallMs: number               // 墙钟预算（首次触发起算）
  },

  // —— 以下为运行态，只由 store 维护，UI 保存不得覆盖（同 runState 约定）——
  attempt: number,                  // 已完成轮数
  attemptStartedAt: string | null,  // 首轮开始时间（墙钟预算起点）
  nextRunAt: string | null,         // 下一轮最早可跑时间（退避）
  lastVerify: {                     // 最近一次验收证据
    ok: boolean,
    exitCode: number | null,
    at: string,
    tail: string,                   // 尾部证据，字符上限见 agent-limits
    note: string                    // 'timeout' | 'blocked-approval' | 'skipped' 等
  } | null,

  baseline: {                       // 开工基线：第一次触发时「尺子自检」的结果
    red: boolean,                   // 必须 true（活还没干，尺子就该是红的）
    exitCode: number | null,
    at: string,
    tail: string
  } | null
}
```

**为何不新增 `goals.json`**：`plans` 已经是「外部触发 + 落盘边界 + 投递 + 托盘 + hook」的单一来源，另开一套表等于把 `beginRun/endRun/recover/scheduler` 各复制一遍，属加法反模式。

**为何 `verify` 只存命令不存判定逻辑**：判定逻辑（跑什么、怎么裁剪证据、超时多久）必须在 Main 一处，避免「计划里写一段自然语言的验收标准」让模型自评（等于回到 Ralph 的弱完成判定）。

### 4.2 状态不是状态机

`AGENTS.md` 明令禁止 `agent_status` 状态机。本方案的状态**只有落盘边界**，与现有 `runState` 同构，不引入流转枚举：

| 事实 | 读法 |
|---|---|
| `runState != null` | 这一轮已经开始、还没收尾（可能就是崩溃点） |
| `nextRunAt` | 下一轮最早何时可跑（`null` = 无待续跑） |
| `lastVerify.ok` | 上一轮是否满足验收 |
| `baseline.red` | 尺子是否「能红」；`false` = 尺子坏，直接终止（§4.5.1） |
| `attempt` / `budget` | 还能不能续 |
| `enabled` | 用户是否还想要这个目标（**唯一的开关，归用户**） |

目标结束只有三种收尾，全部由 Main 写：`lastVerify.ok=true` → 停用；预算/轮次耗尽 → 停用 + 审计报告；用户 `plans:cancel` / 停用 → 立即停止。

### 4.3 续跑决策点：`PlansScheduler`，复用同一个 idle 轮询定时器

不新增第二个 `setInterval`。`scheduler.js` 现有 `idleTimer` 每次 tick 时，先处理目标型：

```
_goalTick():
  if running.size > 0 → return
  if isBusy()        → return            // 不抢用户正在跑的 loop
  plan = 第一个 enabled && trigger==='goal' && (nextRunAt == null || nextRunAt <= now)
  if !plan → return
  runPlan(plan)
```

- **不套用 `idleQuietMs`（5 分钟静默）**：目标型靠 `nextRunAt` 退避控制节奏，不是「等系统闲」。用户整夜不操作时 `isBusy()` 为 false，可连续推进。
- **`nextRunAt` 由谁写**：只由 `store.scheduleNextAttempt(id, delayMs)` 写；调用方仅两处——收尾判定（§4.5）与崩溃恢复（§4.6）。
- **不并发**：`running` 集合沿用，一个目标一轮，全局串行（与 `agentMaxRounds`/`isBusy` 的现有语义一致）。

### 4.4 每轮开局交接（对抗「开局失忆」和「提前宣布完成」）

只改 `buildPlanRunUserText`（`plan-run-turn.js`）一处，同一条文本同时是会话里的用户轮次和模型的「本次任务」输入：

```
[计划 · <name>] 2026-10-27 22:10 · 目标型第 3/12 轮（已跑 5h12m / 预算 8h）

<plan.prompt>

未完成 TODO：
1. …
2. …

上一轮验收未通过（exit 1，21:58）：
<lastVerify.tail，按 agent-limits 上限裁剪>

要求：本轮只推进一个未完成项；改动后必须留下可复跑的验证路径。
```

- **TODO 收敛**：`todos` 已在 `store` 里裁剪为最多 50 条；每轮只挑一项，对应 Anthropic「一次一个 feature」的经验。
- **证据只注入尾部裁剪段**：避免把整份测试日志灌进上下文（同完成验收的样本截断做法：`agent-limits.goalVerifyTailChars`）。
- **不把验收提示写进 assistant 正文**：`lastVerify` 落 `plans.json` + 终态事件 `meta`。理由是本仓已有事故记录——验收文案进正文会被模型当模板复述（见 `guardrails-shared.js#stripReadinessNote` 注释与「完成验收」剥离链）。

### 4.5 验收：Main 跑命令，证据落盘

在 `mcp-plans-boot.js` 的 run 收尾序列里插入一步（位置：`endPlanRunTurn` 之后、`finishPlanRun` 之前）：

```
result = await run(planCtx, plan)
await endPlanRunTurn(...)                      // 已有：assistant 轮次先落库
verify = await runGoalVerify(plan)             // 新增：Main 侧，走 host.exec
plansStore.updateVerify(plan.id, verify)       // 新增：落证据
decision = decideContinuation(plan, verify)    // 新增：纯函数
if (decision.continue) plansStore.scheduleNextAttempt(plan.id, decision.delayMs)
finishPlanRun(plan, {...result, verify})       // 已有：投递/托盘/hook（payload 带 verify 摘要）
```

**`runGoalVerify` 对技术栈零感知**：它只知道「跑一条命令 → 拿到退出码 → 裁剪输出」。不知道对面是 Node、Rust、UE 还是任何别的东西；也没有任何按工程类型 / 文件后缀 / 工程名分支的代码。所有「这条命令该怎么写」的知识都属于用户输入与文档（附录 B），不属于实现。

`runGoalVerify` 的三条硬约束：

1. **走 `host.exec` 唯一入口**，不新写 shell 执行器；超时用 `agent-limits.goalVerifyTimeoutMs`，且**必须 ≤ `SHELL_TIMEOUT_MAX_MS`（600s）**，否则合法验收命令会被误杀。
2. **必须过沙箱三档判定**（`sandbox-policy.js`）。**无人值守语义**：若该命令需要审批而无人可批 → 记为 `lastVerify.note='blocked-approval'`，**按「本轮阻塞」收尾并停止续跑**（不挂起、不无限重试）。这对应 Codex 的「阻塞停止条件」。
3. **证据裁剪**：只保留退出码 + 尾部 `goalVerifyTailChars` 字符进下一轮上下文；完整输出落计划专用会话的 trace / 日志，不进模型上下文。

`decideContinuation` 是纯函数（可单测），规则唯一：

| 条件 | 结果 |
|---|---|
| `verify.ok === true` | 完成 → `enabled=false`（复用「一次性成功即停用」语义） |
| `verify.note === 'blocked-approval'` | 阻塞 → 停续跑，写审计报告 |
| `attempt >= budget.maxAttempts` | 轮次耗尽 → 停续跑，写审计报告 |
| `now - attemptStartedAt >= budget.maxWallMs` | 预算耗尽 → 停续跑，写审计报告 |
| 其余 | 续跑，`delayMs = min(backoff * 2^(连续失败数-1), backoffMax)` |

**审计报告**：一条 assistant 轮次（走既有 `endPlanRunTurn` 路径），内容固定三段——已完成的 TODO、最后一条验收证据尾部、卡在哪/需要用户提供什么。**不允许**用「已完成」措辞收尾。

#### 4.5.1 基线检查：开工前先量一次，必须是红的

**动机**：尺子写弱（`echo ok`、一条永远能跑通的命令）是本方案最致命的失效模式——它会让第一轮就「验收通过」，一整晚的预算在 20 分钟内被判定为「完成」。这类错误在无人值守时**不可观测**，必须靠机制挡。

**做法**：第一次触发时（`attempt === 0` 且 `baseline == null`），在跑 agent 之前先执行一次 `goal.verify`：

```
if attempt === 0 && baseline == null:
    b = await runGoalVerify(plan)            // 同一入口、同一超时、同一沙箱
    store.setBaseline(plan.id, { red: !b.ok, exitCode, tail, at })
    if b.ok:                                 // 一上来就绿 = 尺子坏了
        store.updateVerify({ ok: true, note: 'baseline-green' })
        enabled = false
        写审计报告：「验收命令在尚未动工时就已经通过，无法区分做没做完；请换一条会失败的检查」
        return                               // 不进入任何 agent 轮次
    否则正常开跑
```

规则：

- **基线只做一次**：`baseline != null` 后不再重复，避免每轮多花一次命令执行成本（重型编译 / cook 类尺子尤其贵）。
- **基线绿 = 硬失败**，不是警告。理由同 §2.1 原则 1：没有可失败检查的目标不能无人值守。若用户确实想要「只记录不阻断」，那属于 P2 的显式开关，不进 P0。
- **基线本身 `blocked-approval` / 超时**：同样不开跑，按「阻塞」写审计报告（无人值守时先证明尺子能跑，再谈干活）。
- **基线证据要留下**：`baseline.tail` 写进审计报告与 UI，让用户能一眼看出「这条命令当时到底输出了什么」，便于事后修尺子。

### 4.6 崩溃恢复：唯一的语义变更

`recoverInterruptedRuns` 现在只补回执（`只补回执、不重跑`，注释已写明原因：重跑会让用户看到两次执行）。目标型计划本来就有「多轮执行」的语义，所以可以重入队：

```
for (plan, runState) of listRunning():
    endPlanRunTurn(中断回执)                  // 不变
    endRun(plan.id)                          // 不变
    finishPlanRun(plan, result)              // 不变
    if (plan.trigger === 'goal' && 预算未尽):
        decision = decideContinuation(plan, {ok:false, note:'interrupted'})
        plansStore.scheduleNextAttempt(plan.id, decision.delayMs)   // 新增：排下一轮（带退避）
        log.warn('目标型计划上次未收尾，已排下一轮')
```

**实施修正**：草稿里写的是 `scheduleNextAttempt(plan.id, 0)`（立刻重排），落地改为走同一套退避（`decision.delayMs`，第 1 轮失败后 60s 起、指数增长封顶）。理由：崩溃不是「无限重试」的理由 —— 若崩溃发生在启动初期（例如验收命令把机器打死），立刻重排会变成一夜之间的崩溃循环；退避 + `maxAttempts`/`maxWallMs` 双闸门才安全。用户要的「接着干」并不需要 0 延迟，60s 之后接着干完全够。

- **为什么不怕重复**：`beginPlanRunTurn` 每轮写一条新的用户轮次，`attempt` 递增，用户在会话里看到的是「第 3 轮开始/第 3 轮中断/第 4 轮开始」，是可理解的叙事，不是两条并列的相同执行。
- **防雪崩**：重入队同样受 `maxAttempts` / `maxWallMs` 约束；如果崩溃发生在同一 attempt 内反复，退避仍生效（`scheduleNextAttempt` 带 delay）。

### 4.7 熔断清单

复用（不改）：`repeatToolStreakLimit`、`runStallWarnMs` / `runStallAbortMs`、`toolStallMs` / `toolStallMsLong`、`agentMaxRounds`。

新增（**全进 `agent-limits.js`**，配置组 `goal-run`）：

| key | 默认 | 上限 | 说明 |
|---|---|---|---|
| `goalMaxAttempts` | 12 | 48 | `budget.maxAttempts` 的默认值与 clamp 上限 |
| `goalMaxWallMs` | 8h | 24h | `budget.maxWallMs` 的默认值与 clamp 上限 |
| `goalRetryBackoffMs` | 60s | — | 首次重试间隔 |
| `goalRetryBackoffMaxMs` | 15min | — | 退避上限 |
| `goalVerifyTimeoutMs` | 300s | 600s | 必须 ≤ `SHELL_TIMEOUT_MAX_MS` |
| `goalVerifyTailChars` | 4000 | — | 注入下一轮的证据尾部字符数 |

clamp 沿用 `clampAgentMaxRounds` 的既有模式（`plan` 上只存用户选择，越界在读取时收敛）。

### 4.8 分层归属

| 层 | 职责 |
|---|---|
| **Main**（`mcp-plans-boot.js`、`plans/*`） | 续跑决策、跑验收命令、崩溃重入队、审计报告 |
| **Gateway**（`host.exec` / `sandbox-policy`） | 执行验收命令 + 沙箱判定（唯一入口，不绕过） |
| **dieyun-core (Rust)** | 不改。目标轮次仍然是一次普通 `agent.loop` run |
| **Renderer**（`renderer-automation*.js`） | 只加「目标」分类页签 + 表单字段（验收命令、轮次、预算）+ 进度展示（第 N 轮 / 上次验收） |

---

## 5. 被否掉的方案（减法记录）

| 方案 | 为什么不用 |
|---|---|
| 新增 `src/goals/` 子系统 + `goals.json` | 与 `plans` 的触发/边界/投递/恢复 100% 重复；违反「单一来源」 |
| Ralph 式 Stop-hook 拦退出，无限重喂同一 prompt | 完成判定靠字符串；且本仓禁止「假用户续跑」——续跑必须是新的合法计划轮次 |
| 在 `rust-loop-runner` 里加「目标未达则不退出」 | 把「工头协议」堆进 Rust 循环，违反分层边界；且进程死了照样断 |
| 让模型自称「已完成/未完成」并自行续跑 | 违反「执行与评判分离」；Anthropic 实测这是第二大失败模式 |
| 复用 `trigger:'idle'` 加开关 | idle 语义是「跑一次即停用」，且要吃 5 分钟静默；目标型需要退避 + 多次执行，语义不同，硬塞会给 idle 加分支 |
| 直接把 Reviewer（`renderer-agent-reviewer.js`）当完成判定 | 在 Renderer 侧、依赖模型判断、会放水；P0 用可执行命令。Reviewer 下沉 Main 并作二次确认是 P1 |
| 内置守护进程 / 服务 | 超出应用合理边界；P2 用「开机自启 + 崩溃重启」解决，并在 UI 明示「app 必须运行」 |
| **给 UE5（或任何具体技术栈）做专用流程 / 专用判定代码** | 技术栈会变、会新增，分支会腐烂；且属「意图关键词硬编码 / 按类型路由」的反模式。**尺子一律是用户填的一条命令**，重工具链的特殊性全部退化为「B.3 的五个通用坑」，靠配置与文档解决，不进代码 |

---

## 6. 改动清单

| 文件 | 改动 | 为何删不掉 / 为何不能并入既有单一来源 |
|---|---|---|
| `src/plans/store.js` | `normalizePlan` 增 `trigger:'goal'` + `goal/budget/attempt/attemptStartedAt/nextRunAt/lastVerify/baseline`；新增 `updateVerify`、`setBaseline`、`scheduleNextAttempt`、`clearGoalRuntime` | `plans.json` 是唯一落盘边界，字段必须和 `runState` 同处维护，否则崩溃恢复读不到 |
| `src/plans/scheduler.js` | idle 轮询 tick 里加 `_goalTick` 分支（复用同一 interval） | 续跑决策必须在一处；`scheduler` 已是「谁在何时触发 run」的唯一来源 |
| `src/plans/plan-run-turn.js` | `buildPlanRunUserText` 增轮次/预算/上轮证据段 | 用户轮次与模型输入必须同一条文本（既有约定），分两处会漂移 |
| `src/plans/goal-run.js`（新，小） | `runGoalVerify`（走 `host.exec`，含沙箱/超时/裁剪）+ 纯函数 `decideContinuation` + 基线自检（§4.5.1） | 判定逻辑集中在 Main 且可单测；散进 `mcp-plans-boot` 会让收尾流程混入业务判定 |
| `src/main/mcp-plans-boot.js` | 收尾序列插 verify + decide + schedule；`recoverInterruptedRuns` 增重入队 | 运行边界与收尾的唯一装配点 |
| `src/agent/agent-limits.js` | 新配置组 `goal-run` 六个数字 | 数字单一来源，`AGENTS.md` 硬约束 |
| `src/plans/parser.js` | **不加解析逻辑**：仅在 payload 已带结构化字段（`goal.verify` 由表单提交）时原样透传 | 不做「验收：」这类文本关键词解析——那是 `AGENTS.md` 第 3 条禁止的意图关键词硬编码；命令只能来自结构化输入（UI 表单 / 显式字段），不能靠猜用户说了什么 |
| `src/renderer/renderer-automation*.js` | 新分类页签「目标」+ 表单（验收命令/轮次/预算）+ 「第 N 轮 / 上次验收」展示 | UI 只读落盘事实，不参与判定 |
| `test/unit/plans-goal.test.cjs`（新，并入既有 vitest） | `decideContinuation` 真值表、`scheduleNextAttempt` 退避、崩溃重入队、verify 超时/沙箱阻塞 | `src/plans/` 已有 `plans-scheduler` / `plans-idle-queue` / `plans-parser` / `plans-rrule-next` 四个套件，目标型用例并入同一目录同一 runner，**不新开 npm script** |
| `AGENTS.md` / `docs/rpc-catalog.md` | 文档索引加本文；`plans:*` payload 增字段说明 | 新增 RPC 载荷字段需同步文档（提交清单要求） |

---

## 7. 与 `AGENTS.md` 红线的一致性核对

| 红线 | 本方案 |
|---|---|
| 禁止 `agent_status` 状态机 | 只有落盘边界（`runState`/`nextRunAt`/`attempt`/`enabled`），无流转枚举（§4.2） |
| 禁止「假用户续跑」 | 续跑是 `beginPlanRunTurn` 写入的**新计划轮次**，不是在同一 run 内伪造用户消息 |
| 禁止按只读步数/同文件读取逼写入 | 未使用任何此类信号；续跑只看验收证据 |
| 数字上限只改 `agent-limits.js` | 六个新数字全部入该文件（§4.7） |
| **禁用意图关键词硬编码** | ① 尺子对技术栈**零感知**：没有 UE/Node/Rust 分支、没有按文件后缀或工程名推断；② 不解析用户文本里的「验收：」之类关键词，命令只从**结构化字段**来；③ 唯一的技术判断是「命令退出码是否为 0」，这是通用契约而非关键词 |
| 不在 Rust 循环里堆工头协议 | Rust 零改动（§4.8） |
| 不在 Renderer 写长期 Agent 状态机 | Renderer 只展示落盘事实 |
| 完成验收只提示、不自动续跑 | **这条要显式区分**：`AGENTS.md` 说的是「单轮内的完成验收提示不触发续跑」，本方案的续跑发生在**轮次之间**、由调度器依据可执行验收命令决定，二者不冲突；且验收文案仍只进 `lastVerify`/事件 meta，不进正文 |
| 减法优先 | 只加 1 个触发器枚举 + 1 个纯函数模块，其余全是既有路径的接线（§5 逐条记录被否方案） |

---

## 8. 验收标准（P0 完成的定义）

> 实施状态：§8.1 全部自动化通过（见 §10.3）；§8.2 是留给人的手工确认清单，其中 2/4/5/6/7 的机制已由 `mcp-plans-boot.test.cjs` 的闭环用例覆盖。

### 8.1 自动化

```bash
npm run test:unit              # 含新增 test/unit/plans-goal.test.cjs（vitest，夹具照 plans-idle-queue 的 tmp store）
npm run test:agent-limits      # 新配置组数字的 schema 校验
npm run test:agent             # agent smoke 全过（无副作用回归）
npm test                       # 按 diff 选测
```

`decideContinuation` 必须覆盖的真值表：`ok` / `blocked-approval` / `attempt 用尽` / `墙钟用尽` / `连续失败退避 1→2→4`（有上限）。另需覆盖基线自检：`baseline 绿 → 立刻终止且不开跑 agent`、`baseline 超时/阻塞 → 终止`、`尺子由红转绿 → 判定完成`、`baseline 只做一次（第二轮不再执行）`。调度侧照 `plans-scheduler.test.cjs` 用 `vi.useFakeTimers()` 推 `nextRunAt`。

### 8.2 手工场景（一晚）

1. 建一个目标型计划：`verify = npm test`，`maxAttempts=5`，`maxWallMs=2h`，`todos` 三项。
2. **尺子自检**：故意把 `verify` 写成 `echo ok`（永远绿）→ 计划必须在**跑 agent 之前**就终止，审计报告指出「这条命令在未动工时已经通过」（§4.5.1）；换成会红的命令后才允许开跑。
3. **正常收敛**：让它通过两轮修到 `npm test` 退出 0 → 计划 `enabled=false`、`lastVerify.ok=true`、会话最后一条是完成小结（非「预算耗尽」措辞）。
4. **提前宣布完成**：故意让模型宣称完成但测试仍红 → 必须继续第 2 轮，`attempt` 递增，`lastVerify.tail` 出现在第 2 轮开局文本里。
5. **进程被杀**：第 2 轮执行中 `End Task` → 重启 app → 第一条是中断回执，随后自动排第 3 轮（`attempt=3`），不是两条并列的「第 2 轮」。
6. **需要审批**：`verify` 命令触发沙箱审批 → `lastVerify.note='blocked-approval'`，计划停止续跑并给出需人工处理的说明（不挂起）。
7. **预算耗尽**：把 `maxWallMs` 设成 2 分钟 → 收尾写审计报告三段，`enabled=false`，`lastVerify.ok=false`。

### 8.3 明确不在 P0 验收范围

开机自启/崩溃守护、Reviewer 二次确认、纠偏阶梯（先 nudge 再重跑）、多目标并发、跨设备。

---

## 9. 风险与后续

| 风险 | 缓解 |
|---|---|
| **成本**：一晚 = 多轮 LLM 调用 | `maxWallMs` + `maxAttempts` 双预算；预算耗尽输出审计报告而不是继续烧 |
| **验证命令写得太弱**（如 `echo ok`） | 建计划时 UI 提示「必须是能失败的检查」；P1 由 Reviewer 复核验收面质量 |
| **`verify` 与 agent 改动互相干扰**（长跑测试占 CPU） | 走 `host.exec` 既有超时/进程句柄表；超时视为失败而非挂起 |
| **app 关掉就没有监督者** | **P0 明确不解决**，UI 需提示「目标续跑要求应用保持运行」；P2 用开机自启 + 崩溃重启（或 Windows 计划任务拉起）兜 ③ 层 |
| **模型在长轮次里漂移** | 每轮开头注入目标原文 + 上轮证据（goal recitation）；TODO 一次一项 |
| **UE5 类重工具链**：缓存目录落工作区外被沙箱拦、弹窗等人点、二进制资源冲突 | 这些是**通用类别**（§附录 B.3 五个坑），不是 UE 特例：改配置把产物目录收进工程、用无界面参数、夜间独占工作区。代码侧不做任何技术栈分支 |

**P1**：Reviewer 下沉 Main，作为 `verify` 通过后的二次确认（防「验证命令写弱了」）。
**P2**：纠偏阶梯（无进展 → 先重定向提示，再重启轮次）、跨进程守护、多目标排队。

---

## 10. 实施记录（P0 已落地）

### 10.1 改了哪些文件

| 文件 | 角色 |
|---|---|
| `src/agent/agent-limits.js` | 新增 `goal-run` 数字组：`goalMaxAttempts`(12/上限 48)、`goalMaxWallMs`(8h/上限 24h)、`goalRetryBackoffMs`(60s)、`goalRetryBackoffMaxMs`(15min)、`goalVerifyTimeoutMs`(5min，≤ host.exec 硬上限 600s)、`goalVerifyTailChars`(4000) |
| `src/plans/goal-run.js`（新） | 唯一判定来源：`runGoalVerify`（跑命令 → 退出码 + 证据尾巴）、`decideContinuation`（纯函数）、`buildGoalAuditReport`（停止措辞）、`resolveGoalBudget`（预算收敛 + clamp） |
| `src/plans/store.js` | `trigger:'goal'`、`goal/budget` 配置、`attempt/attemptStartedAt/nextRunAt/lastVerify/baseline` 运行态；`beginAttempt`、`setBaseline`、`updateVerify`、`scheduleNextAttempt`、`clearGoalRuntime`、`setEnabled` |
| `src/plans/scheduler.js` | `_dueGoal` / `_runGoal`，接在既有 idle 轮询里；目标型不进 `_arm`（不占 setTimeout），且不吃 `idleQuietMs` |
| `src/plans/plan-run-turn.js` | `buildGoalRoundBlock` + `buildPlanRunUserText(plan, at, limits)`：轮次/预算/上轮证据尾部注入 |
| `src/plans/parser.js` | 结构化 `goal.verify` 直接透传（**不解析自然语言**）；有验收命令时不需要 rrule/onceAt |
| `src/main/mcp-plans-boot.js` | 基线自检 → `beginAttempt` → agent 跑 → `runGoalVerify` → `updateVerify` → `decideContinuation` → 排下一轮/停用；`recoverInterruptedRuns` 对目标型重排一轮 |
| `src/main/ipc/plans.js` | 目标型「停用 → 重新启用」时 `clearGoalRuntime`（从零再来，不带旧账） |
| Renderer | `index.html` 新增「目标」页签（验收命令 / 最多轮次 / 时长预算 / 工作目录）、`renderer-automation*.js` 读写与卡片摘要、`renderer-skills-grid.js` 分类页签 |
| `test/unit/plans-goal.test.cjs`（新） | 28 个用例：判定真值表 / 预算 clamp / 验收执行与证据 / store 运行态 / 调度触发 / 交接班文本 |
| `test/unit/mcp-plans-boot.test.cjs`（+5） | 整条闭环：基线绿即停、红→续跑→绿即完成、沙箱阻塞即停、崩溃恢复重排 |

### 10.2 与草稿的四处差异（都是实施时才看清的）

1. **崩溃重排走退避，不是 0 延迟**（§4.6 已改）：避免「崩溃 → 立刻重排 → 再崩」的一夜循环；`maxAttempts` / `maxWallMs` 仍是硬闸门。
2. **目标型的 `lastRunOk` 按「验收是否通过」记**（`updateRunResult` 读 `result.verify.ok`）：对目标型来说「模型说完了但验收还是红的」不是成功，卡片上不能显示「上次成功」。
3. **多两个 store 方法**：`beginAttempt`（轮次 +1、只在首轮记墙钟起点）与 `setEnabled`（重新启用时清 `nextRunAt`，避免一启用就立刻触发）。草稿里把它们隐含在 boot 里，落地时发现必须落盘才对得上「崩溃后还知道已经是第几轮」。
4. **`agentLimits()` 收敛成一个快照函数**：原先 boot 里两处 `getAgentLimits(userData, '')`，目标型判定还要用第三次，统一成一个函数避免多次读盘后彼此不一致。

### 10.3 验证证据

- `npx vitest run test/unit` → **98 文件 / 986 用例全通过**。
  - `test/unit/plans-goal.test.cjs`（新，28 例）：判定真值表（通过 / 阻塞 / 无尺子 / 轮次尽 / 墙钟尽 / 退避 1→2→4 封顶）、预算 clamp、`runGoalVerify`（退出码、证据尾巴、超时后杀进程、沙箱拒绝→blocked）、store 运行态（表单保存不清旧账、`beginAttempt` 首轮记起点、`lastRunOk` 按验收记）、调度按 `nextRunAt` 触发且不吃静默阈值、交接班文本。
  - `test/unit/mcp-plans-boot.test.cjs`（+5 例）：**整条闭环**跑通 —— 基线就绿 → 不进 agent 轮次 + 停用 + 报告；基线红 → 跑一轮 → 验收仍红 → 60s 后重排；验收转绿 → 完成停用；沙箱拒绝 → 停用不重排；崩溃后恢复 → 排下一轮且不重跑同一轮。
  - 既有 `plans-scheduler` / `plans-idle-queue` / `plans-parser` / `plan-run-events` 全部保持通过（调度与解析的旧行为未被改动）。
- `npm run test:agent-limits` → ok；`npm run test:agent` → `[dieyun:test] OK`（含 `lint:agent`、`check:js`、`check:renderer`）。
- `npm test`（按 diff 选测）→ `[dieyun:test] OK`。
- 环境注记：本机若 shell 里带着 `ELECTRON_RUN_AS_NODE=1`（Electron 里起的 Node），`npm run test:lsp` 会因为它断言「npx 子进程不应继承该变量」而失败 —— 与本次改动无关，清掉该变量即通过。

### 10.4 手工验收（一晚场景怎么试）

1. 选一个现在**确实红的**检查当尺子（例：`npm run lint` / `cargo build` / 项目自带断言脚本），先在终端自己跑一次，确认它是红的。
2. 新建计划 → 「目标」页签：验收命令填那条、轮次 12、时长 480 分钟、提示词写目标 + 边界 + 策略。
3. 保存后观察：会话里应出现「目标型第 1/12 轮」+ 基线结论；之后每轮结束都有「上一轮验收未通过（exit N）」+ 输出尾巴。
4. 想验证「尺子无效」这条路：把验收命令临时改成 `echo ok`，保存并运行 —— 应立刻停下并给出「验收命令在尚未动工时就已经通过」的说明，**不进入任何 agent 轮次**。
5. 想验证崩溃恢复：跑到某一轮中途直接杀掉应用再启动 —— 应补一条中断回执，并在退避后自动排下一轮（轮次号继续，不重跑同一轮）。

### 10.5 取代关系：原「长程模式」已删除

原「设置 → 权限 → 长程 Agent 任务」开关（`longHorizon`）已整套移除（开关 / `LONG_HORIZON_*` 缩放 / 伪 user 消息续段 / 关闭回撤 / 页脚「· 长程」），缺口由既有单一来源承接：

- **要更多预算** → 设置页「编码参数 → 模型与段预算」的 `agentMaxRounds` / `agentToolCallLimit`（按 Context 档位保存，唯一来源）。
- **撞上段上限要继续** → 交互会话点「继续」（再给同样额度，`model-runtime-schema` 的提示文案即此契约）；**无人值守的连续推进 → 本文的目标型计划**（可执行验收、轮次/墙钟预算、退避、崩溃重入队）。
- **文件回撤** → 所有会话一律拍 turn 快照，不再有「长程就关回撤」的分支。

删除依据：该开关宣称的六项里，两项护栏（`exploreStreakLimit` / `sameFileReadLimit`）在全仓早已不存在，两项缩放从未接线（`applyLongHorizonGuardrails` 无运行时调用点）或恒等（`agentToolCallLimit` 全档已 600 = schema 上限），实际只剩「轮次 ×2 + 最多 20 段自动续跑 + 关回撤」；而自动续段靠注入伪造 `role:'user'` 消息延长预算，正是循环哲学禁止的形态，且与「预算耗尽 = 未完成 + 审计报告」冲突。

---

## 附录 A：用户侧「强 Goal」交待模板

夜里交给它之前，这句话至少要包含六要素（否则会变成无头苍蝇）：

```
目标：把 checkout 接口 p95 降到 120ms 以下
验收：npm run bench:checkout（p95 < 120ms 且 npm test 通过）
约束：不得删改现有测试断言；不改公共 API 签名
边界：只动 services/checkout 及其测试
策略：每轮记录改了什么 + 基准数值 + 下一个最有价值的实验
阻塞：若基准跑不起来或在边界内无有效路径，停止并报告已试路径、证据、需要什么
```

对应到本方案：`prompt` = 目标 + 约束 + 边界 + 策略；`goal.verify` = 验收；`budget` = 轮次/时长；`todos` = 分解后的子项。

---

## 附录 B：怎么给任意工程配一把「尺子」

> 本节是**使用说明**，不是实现说明。代码侧对工程类型**零感知**：没有 UE / Node / Rust 分支，没有「按文件后缀猜技术栈」，也没有对用户文本做关键词解析（见 §7「禁用意图关键词硬编码」一行）。UE5 只是 B.6 里的一个例子，与本仓代码没有任何耦合。

### B.1 合格的尺子必须满足三条

1. **可执行**：一条命令（可用 `&&` 串起来），全程不需要人参与。
2. **能失败**：在「活还没干」的状态下必须是红的。**这条由 §4.5.1 的基线自检强制验证**，用户不必自己保证。
3. **结果可判**：退出码，或产物（报表/日志/文件），能被机器读出「过 / 不过」。

最容易踩的两种不合格尺子：

| 不合格类型 | 例子 | 机制会怎么处理 |
|---|---|---|
| 永远绿 | `echo ok`、`exit 0`、只打印不判定的脚本 | 基线自检发现一上来就绿 → 直接终止 + 审计报告（§4.5.1） |
| 失败也返回 0 | 部分测试框架 / 引擎（如 UE 自动化测试）失败时进程仍退出 0 | **基线自检查不出来**（它跑基线时是红的），但会在「改完了还判过」时骗你 → 必须把尺子写成「跑完再查产物」，见 B.6 |

### B.2 通用三档（与工程类型无关）

| 档 | 是什么 | 何时跑 | 特点 |
|---|---|---|---|
| **快** | 编译 / 类型检查 / lint | **每一轮** | 秒级~分钟级，红绿分明，骗不了人 |
| **中** | 测试套件、断言、接口探活 | 每轮收尾，或隔轮 | 分钟级，能抓「编得过但行为错」 |
| **慢** | 打包 / cook / 端到端 | **只在最后一轮** | 十几分钟到数小时，最权威但别常跑 |

用法：三档用 `&&` 串成一条命令，快的在前。慢尺子如果每轮都跑，一晚上的预算就全给打包了。

### B.3 通用坑的五个类别（换任何工程都适用）

| 类别 | 怎么识别 | 通用处理 |
|---|---|---|
| **1. 产物写到工作区之外** | 跑一次尺子，看是否出现越界/审批提示 | 把缓存与输出目录**配置进工程内**；**不要**为了跑通把沙箱放宽到 `danger-full-access` |
| **2. 需要交互确认** | 命令中途停住等人输入 / 弹窗 | 用无界面参数；关掉会抢占产物的 IDE / 编辑器 |
| **3. 二进制产物**（`.uasset`、`.xlsx`、`.psd`、`.fbx`…） | 无法文本 diff、无法合并 | 夜间**独占工作区**（或走本仓 worktree）；不要让 subagent 并行跑同一工程 |
| **4. 首次构建成本远高于增量** | 第一次跑尺子特别久 | 开工前手工预热一次；`budget.maxWallMs` 按**增量**估 |
| **5. 崩溃残留污染证据** | 上一轮的崩溃报告/临时文件还在 | 尺子脚本先清理旧产物再判定 |

### B.4 例子：Node / 前端

```
npm run test:unit && npm run check:renderer
```

编译/类型检查档通常是 `npx tsc --noEmit` 或构建命令；慢档是 `npm run build`。这类工程的退出码基本可信，直接可用。

### B.5 例子：Rust / C++（常规）

```
cargo test --workspace
```

编译器退出码可信。慢档是 `cargo build --release` 或整包构建。注意类别 4：`cargo test` 首次要编全量，预热一次再算预算。

### B.6 例子：UE5（重工具链工程的代表）

> 命令路径按引擎安装位置替换；**必须先在命令行手工跑通一次**，不要让夜间任务去发现命令本身是错的。这些是**用户填写的表单值**，不是代码常量。

| 档 | 命令（模板） | 能抓住什么 |
|---|---|---|
| 快 | `"<UE>\Engine\Build\BatchFiles\Build.bat" <Project>Editor Win64 Development -Project="<abs>\<Proj>.uproject" -WaitMutex` | C++ 编译 / 链接 / 头文件与模块依赖断裂；退出码 0/非 0 直接可用 |
| 中 | `"<UE>\Engine\Binaries\Win64\UnrealEditor-Cmd.exe" "<abs>\<Proj>.uproject" -ExecCmds="Automation RunTests <Filter>; Quit" -unattended -nopause -nosplash -nullrhi -log -ReportExportPath="<dir>"` | 玩法逻辑、数据结构、系统级断言 |
| 慢 | `"<UE>\Engine\Build\BatchFiles\RunUAT.bat" BuildCookRun -project="<abs>\<Proj>.uproject" -noP4 -platform=Win64 -clientconfig=Development -cook -stage -pak -archive -archivedirectory="<dir>"` | 资源引用断裂、蓝图编译错误、打包缺件 —— 「真能出包」的唯一证据 |

**类别 3（失败也返回 0）的实例**：UE 自动化测试即使有用例失败，进程退出码经常仍是 0。所以中档尺子必须写成「跑完再查产物」：

```
... -ReportExportPath="<dir>" && node <你的工程>\scripts\check-report.js "<dir>"
```

`check-report.js` 校验「失败用例数为 0 且确实跑过用例」。**这个检查脚本属于用户工程，不进本仓**——本仓只需要「一条命令返回非 0 就算没过」这一条通用契约。

**映射到 B.3 的坑**：

- 类别 1：引擎 DDC 默认常在 `%LOCALAPPDATA%\UnrealEngine\Common\DerivedDataCache`（工作区外）→ 配置到工程内，别放宽档位；
- 类别 2：缺模块时编辑器会弹「是否重建」→ `UnrealEditor-Cmd.exe` + `-unattended -nopause -nosplash`，并保证先编译成功；夜间一律完整编译，不用 Live Coding / Hot Reload；
- 类别 3：`.uasset` / `.umap` 无法合并 → 独占工作区；
- 类别 4：Shader + 全量 C++ 编译可能吞掉大半预算 → 开工前预热；
- 类别 5：崩溃在 `Saved/Crashes` 留文件 → 尺子先清理。

**蓝图 / 可视化改动的现实边界**：节点图是二进制、无文本 diff，验证只能靠运行时行为。因此夜间任务尽量约束在 C++、数据表、配置文件上；必须动蓝图时，要求每轮写清「改了哪张、增删了哪些节点」，早上人工核。**蓝图任务只适合「有人早上验收的夜间批处理」**，这一条适用于所有可视化配置型工程（材质、关卡、Excel 驱动的配置表同理）。

### B.7 起点的通用写法

先填**快档**那一条，然后问自己一个问题：

> 现在还没动工，跑它是绿的吗？

- 红 → 好尺子，可以直接开跑（基线自检会记录这个红）。
- **绿 → 这条尺子测不出「今晚干了什么」**，需要补中档或慢档才有区分度。这正是 §4.5.1 基线自检要替你抓的东西，不用你手工判断。

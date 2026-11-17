# 子 Agent vs DeepSeek Harness：抄了什么、明确不抄什么

> 对照对象：DSH 桌面版内置包（`app.asar` 内 `@deepseek-ai/dsh-subagent` /
> `dsh-tool-subagent` / `dsh-tool-subagent-control` / `dsh-agent-team` / `dsh-agent`，
> 官方说明 `dsh/docs/subsystems/subagent.zh.md`）与叠云本仓
> `crates/dieyun-core/src/planner/` + `src/agent/subagent-runner.js` + `src/agent/rust-planner-runner.js`。
> 本文只记**结论与理由**；机制细节见 [AGENT-DEV.md](./AGENT-DEV.md) /
> [MULTI-AGENT-WORKTREE-ISOLATION-PLAN.md](./MULTI-AGENT-WORKTREE-ISOLATION-PLAN.md)。
>
> 写这篇的原因与 [MEMORY-VS-DSH.md](./MEMORY-VS-DSH.md) 相同：两边在 2026-11 做过一轮逐项对照，
> 落地了一部分、明确否掉了一部分。不写下来，半年后就会有人把 DSH 的独立子会话、steer/inbox、
> provider 注册表搬回来，理由是「人家那么做一定有道理」，而当时的反证已经没人记得。

---

## 1. 一句话差别

**DSH 把子 Agent 做成「一等公民的可派生会话」，叠云把多 Agent 做成「可恢复的阶段机 + 一个只读调研工具」。**

- DSH 没有编排器。`ctx.subagents` 只是注册表 + 生命周期准入，要不要派生、派生几个由**模型**在循环里
  自己调 `subagent` / `subagent_fork` 决定；每个子级是独立 Session + 独立 Agent loop，有自己的
  system prompt、工具 scope、inbox、KV 前缀与上下文预算，可以继续、可以 steer、可以中断。
- 叠云有编排器。写类并行由 Rust `PlannerRunManager` 的阶段机从一份 plan JSON 自动派生
  （`Plan → Explore → Workers →(BestOfN)→ Review → Retry/Synthesize → Done`），模型看不见也拨不动；
  模型唯一能自己派的，是**只读**研究子 Agent（深度恒 1，工具集就是 Explore 白名单）。

一句话：**DSH 让模型决定并行度（服务只保证准入），叠云让计划决定并行度（模型只做局部决策）。**

---

## 2. 逐项对照

| 维度 | DSH | 叠云 |
|---|---|---|
| 子 Agent 是什么 | 独立 Session + 独立 agent loop（`agents.create` / `resume`） | 同一次父运行里的另一次 `agent.run`（独立账本/独立流），无 session 概念 |
| 谁决定派生 | 模型按需调工具 | 写类 worker：Rust 阶段机按 plan 派生；只读调研：模型调 `subagent` |
| 上下文传递 | spawn = 空历史自包含 prompt；fork = 父日志到末个 `turn/end` 的一次性前缀快照 | 只传 `instruction / expectedOutput / planSummary / 探索笔记 / 本 worker 前序摘要`，不传完整对话 |
| 回传 | 「结算通知」一条 user-role 消息进父 inbox | 一次性结构化结果（摘要截断 `subagentSummaryMaxChars`） |
| 追 / 双向 | `send_message` steer、`list_agents`、`wait_agent`、`interrupt_agent`；continuable 会话可冷恢复 | `continueFrom` 在本轮内存 LRU 内续问；`subagent_status` 查「还能追问谁」；**无中途 steer** |
| 嵌套 | depth = 父+1，默认 `maxDepth:1`，可派孙级 | 深度恒 1，靠**工具白名单物理切断**（Explore 白名单不含 `subagent`） |
| 并发 | `maxActiveSubagents` 默认 8，按树根共享一个池，满即拒**不排队** | 调研：并发 3 / 每轮 8 / 48 轮 / 96 次工具；planner：并行 3 worker / 重试 1 / best-of-N 2–3 / 60 min |
| 模型选择 | 每子 agent 可选 provider/model/effort（能力位 + 设置页白名单） | 全部沿用本轮主模型；分层只有 Context 档位的温度/输出上限 |
| 写入隔离 | **无 worktree**；`agent-team` 的 `writeScopes` 只告警 | 每 worker 一个 git worktree + 写作用域重映射 + 读 copy-on-read + 越界 `WORKER_SCOPE_DENIED` |
| 收尾 / 验收 | 无「验收」概念，子级自己收尾，父自己判断 | 显式 REVIEW LLM → `{accepted, retry[], notes}` + best-of-N 择优 |
| 持久化 | 子 Session 独立落盘 + descriptor/catalog 事件 + projection + archive-admission | 断点文件 `agent-checkpoints/<runId>.json`（恢复后跳过已完成子任务）+ 隔离 trace 卡片 + 变更面板 |
| 可扩展后端 | provider 注册表：in-process spawn/fork、out-of-process（ACP / Codex / Claude Code） | 两条硬编码路径；worker 工具集来自 `planner-tool-filters.js` 白名单 |

---

## 3. 已抄的（含落点）

| 能力 | 抄的是哪一点 | 落点 |
|---|---|---|
| 子 Agent 账本对模型可见 | 「派出去的委托应当可被**查**，而不是靠记忆」 | 工具 `subagent_status`（schema 在 `catalog/session.js`，投影 `subagent-runner.js#status`，派发在 `main/ipc/agent-runtime.js` 与 `rust-planner-runner.js`） |
| 追问失败不要说「重派一遍」 | 「拿着可用 id 自救」 | `SUBAGENT_FOLLOWUP_NOT_FOUND` 文案里直接列出当前可续用的 id |
| 一段调研可以接着问 | 「同一上下文续问，而不是重跑」 | `continueFrom` + `subagentFollowupRetention`（早于本文已实现） |

**为什么没做成 DSH 那样的一整套控制面**：`subagent_status` 只是把 runner 里**已经存在**的
`issued / active / waiters / followups` 原样投影出去，零新增状态、零新增日志。它是「读账本」，
不是「新机制」——这一条界限必须守住，否则就会滑向下面 4.2 的方案。

---

## 4. 明确不抄的（以及反证）

### 4.1 子 Agent = 独立 Session，可持久续跑

- **DSH 的做法**：子级独立落盘、可被 `resume`、可在 UI 里导航。
- **反证**：叠云已经有「断点重跑阶段机」（`PlannerRunManager` + `agent-checkpoints`）承担同一件事
  ——「跑到一半停车后能接着跑」。再引入独立子会话，等于给同一需求做第二套落地，并且子会话
  transcript 一旦落盘，就要和 core「transcript 唯一写者」的边界重新谈判（见 AGENTS.md §4）。
- **什么情况下才该改判**：用户真的需要「点进某个子 Agent 的完整会话、逐轮翻它的思考」。
  目前 UI 只提供折叠卡片，条件不成立。

### 4.2 中途 steer（子 Agent 跑着的时候插话）

- **DSH 的做法**：子级有 inbox，`send_message` 在它的下一步注入。
- **反证**：叠云的父循环是 `await executeDelegateBatch(...)`，子 run 中途**没有任何收信点**；
  要支持 steer，就得在子 loop 的每次工具返回后插一个 inbox 检查点 —— 那是给「一次性的子 run」
  装上状态机，直接撞 AGENTS.md §5「禁止 `agent_status` 状态机」。而 `continueFrom` 已覆盖
  「跑完再追问」这个 80% 场景。
- **什么情况下才该改判**：出现「子 Agent 跑十几分钟且方向会跑偏、必须在途中纠正」的实测案例，
  且能证明重跑成本高于状态机成本。**先有实测，再谈机制。**

### 4.3 每个子 Agent 独立 provider / model / reasoning effort

- **反证**：叠云当前的模型选择在 `model-settings` 有唯一来源，再加一层「子 Agent 专用模型」就是
  第二处模型选择，必然漂移（用户换了主模型，子 Agent 还跑旧模型，且没人解释为什么）。
- **要做的前置条件**：先把「子 Agent 模型」并进 `model-settings` 的槽位（像 `speech` / `vision`
  那样的能力槽），由同一份设置解析；在那之前不做。

### 4.4 out-of-process provider 注册表（ACP / Codex / Claude Code 后端）

- **反证**：DSH 需要它是因为要接**别的 agent 产品**。叠云没有第二个后端要接，注册表在这里
  立刻从资产变负债：多一层能力位协商、多一处「不支持的能力要在 start 前拒绝」。
- **什么情况下才该改判**：真要接外部 agent 运行时时再加，且加法位置就是那一层适配器。

### 4.5 descriptor / catalog / projection 三件套

- **反证**：这三件套是为了「子会话是可被用户导航、可被跨进程恢复的对象」。叠云子 Agent 是**执行体**，
  UI 需要的是「一张卡片 + 变更面板」，`live-loop-trace.js#createSubagentNamer` 已经给了运行内唯一身份。

### 4.6 按树根共享的全局容量池

- **部分已抄**：叠云已经有 `subagentMaxConcurrent` / `subagentMaxPerRun` / `plannerMaxParallelWorkers`
  在各自执行器内自限流（`agent-limits.js` 单一来源）。不需要再叠一个「跨树根的全局池」——
  叠云没有「孙级」这回事（深度恒 1），池子的意义不存在。

---

## 5. 两边的真实强弱（写在这里，免得自我安慰）

**叠云强在**：写入隔离（worktree + 写作用域）、验收（REVIEW + best-of-N）、可恢复（断点跳过已完成）、
护栏数字单点收口。这些 DSH 都没有。

**叠云弱在**：子 Agent 之间没有任何中途通信（无 steer / 无 wait / 无 interrupt）；子 Agent 不可被用户
回访（只有卡片）；能力面比 DSH 窄（模型选择、后端可插拔）。

**不要用「我们更简单」来解释第 2 点**：它就是缺，只是权衡后不补。

---

## 6. 如果以后还要改这块，先过这三问

1. **这件事能不能用已有账本投影解决？**（`subagent_status` 就是这么来的：不新建状态，只把
   `followups` 读给模型看。）
2. **新增的分支/机制是不是在「绕过」失败而不是「消除」失败？** 典型反例：给子 Agent 加重试层、
   给 steer 加状态机、给并发加排队。
3. **是不是在给同一需求造第二套落地？**（子会话续跑 vs 断点重跑；子 Agent 模型 vs model-settings；
   全局容量池 vs 三个既有并发上限。）

---

## 7. 相关测试

| 改动 | 测试 |
|---|---|
| `src/agent/subagent-runner.js` | `npx vitest run test/unit/subagent-runner.test.cjs test/unit/subagent-followup.test.cjs` |
| `crates/dieyun-core/src/planner/` | `npm run test:rust-planner-smoke` + `cargo test -p dieyun-core --lib planner` |
| planner worker 批 / worktree 隔离 | `node scripts/test-planner-parallel.cjs`、`node scripts/test-planner-workers.cjs` |
| 护栏数字 / 设置页 schema | `npm run test:agent-limits` |
| 纯函数 / 工具表 | `npm run test:unit` + `npm run check:js` |

# 工具关卡（Tool Gate）

> 解决的问题：**一次工具调用要过哪些关、按什么顺序过、关卡挂在哪儿** 以前只能靠通读
> `ToolHarnessSession.execute` + `executeAgentTool` 两段代码拼出来；加一条检查就得改流程。
>
> 相关：[`HARNESS-INVENTORY.md`](./HARNESS-INVENTORY.md) §C12 · 实现在 `src/agent/tool-gate.js`

---

## 1. 一条流程，两个口

```
模型给出 tool_call（原始 name + args，可能是别名）
        │
        ▼  normalize（唯一一次，createToolCall）
   call = { rawName, name, args, harness, … }
        │
        ├─ before 关卡 ── 有结论即短路（call.block）──► 直接返回错误信封，**不调用工具**
        │     ① validate-args   参数契约（MISSING_ARG / BLOCKED / USE_FS_EDIT …）
        │     ② repeat-guard   连续相同调用止损（REPEAT_BLOCK）+ 放行才计指纹
        │
        ▼  调用（瞬时失败重试 / 退避；不属于关卡）
        │
        ├─ after 关卡（全部跑完，可改写 call.result）
        │     ③ telemetry       成功/失败都记一条（唯一遥测出口）
        │     ④ spill-output    大输出落盘，结果换成「预览 + outputFile」
        │     ⑤ absorb-mcp-vision      MCP 图片入视觉缓冲、base64 摘掉   ← 外层追加
        │     ⑥ record-browser-screenshot  截图暂存                      ← 外层追加
        │     ⑦ sanitize-result   出站净化（browser_screenshot 的 base64 不外发）← 外层追加
        │     ⑧ write-smell-hints 写入后给模型的「别踩坑」提示            ← 外层追加
        ▼
   返回给账本（成功结果 或 统一形状的错误信封）
```

①②③④ 在 `tool-gate.js` 的 `DEFAULT_TOOL_GATE_HOOKS` 里；⑤⑥⑦⑧ 由 `tool-bridge-main.js`
通过 `extraAfterHooks` 追加（只有它知道视觉能力与 ctx）。两批共用**同一个执行器**
（`runToolGateStage`），所以顺序只有一处定义：`[默认清单, ...extraAfterHooks]` 的声明顺序。

---

## 2. 三条不变量

1. **归一只有一次**：`createToolCall` 之后，整条链路只认 `call.name` / `call.args`，
   `rawName` 仅留档排查。别名（`write_file` / `edit` / `str_replace_editor` / `rg` / `graph_find_symbol` …）
   必须在关卡之前展开完毕，否则某一层会按别名判定而整体跳过。
2. **before 短路、after 全跑**：`before` 一有结论就返回（不再调用工具、不进入 after）；
   `after` 的关卡是观察/改写，不该互相短路。
3. **抛错先归一**：异常在进入 after 之前就被 `classifyFailure` 压成错误信封，
   所以 after 关卡只处理一种形状（成功结果 or 信封），不需要自己判 `instanceof Error`。

---

## 3. 加一条检查怎么做

在 `DEFAULT_TOOL_GATE_HOOKS` 里按"该在谁之前/之后"插入一项即可，**不要改 `runToolGateStage`**：

```js
const hookDenySensitivePath = {
  id: 'deny-sensitive-path',      // id 会出现在 listHookIds() 与测试断言里
  stage: 'before',                // 'before' = 能不能调用；'after' = 结果长什么样
  run(call) {
    if (!isSensitive(call.args.filePath)) return;
    call.block = wrapStructuredError({ retryable: false, errorCode: 'SENSITIVE_PATH', error: '…' });
  }
};
```

只有"需要单次调用上下文（视觉能力、UI 能力）"的关卡才用 `extraAfterHooks`，
并且必须在调用方那一处显式列出——因为那是本次调用的**能力事实**，不是全局策略。

**判定逻辑本身仍然放既有单一来源**：数字在 `agent-limits.js`，词表/分类在
`guardrails-shared.js`，参数契约在 `tool-validate.js`。关卡只负责"按顺序调用它们"。

---

## 4. 观测与排查

| 想知道 | 去哪看 |
|---|---|
| 关卡清单与顺序 | `require('src/agent/tool-gate').listHookIds()` → `['before:validate-args', 'before:repeat-guard', 'after:telemetry', 'after:spill-output']` |
| 某工具最近成功率 / 错误码 | `tool-telemetry.jsonl`（`recordToolTelemetry`，after 关卡里的 telemetry 是唯一出口） |
| 工具为什么被拦 | 返回信封里的 `errorCode`：`MISSING_ARG` / `BLOCKED` / `USE_FS_EDIT` / `REPEAT_BLOCK` … |
| 大输出去哪了 | 结果里的 `outputFile`（`tool-output-spill.js`；阈值唯一来源 `agent-limits.js:toolSpillCharThreshold`，且必须小于 `toolResultMaxJson`，否则那一段会被静默截断且无文件可回读） |
| 这一轮模型看到的「工具结果」原文 | `memory.request_snapshot_*`（见 [`REQUEST-SNAPSHOT.md`](./REQUEST-SNAPSHOT.md)） |
| 某工具卡在写类串行队列 | `main.log` 的 `MUTATE_QUEUE_STALL`（含 `tool` / `workspace` / `runningMs`；阈值 `agent-limits.toolStallMs`，到点强开闸、原调用不终止） |

**串行队列只放「写这个工作空间」的工具**：谁进队列由 `guardrails-shared.MUTATING_TOOL_NAMES` 决定。
`plan_run` / `plan_cancel` 刻意不在里面 —— 它们是调度器动作，不写工作空间；而 `plan_run` 一旦占着槽位
等整段嵌套运行，嵌套运行自己的 `fs_edit` / `fs_write_file` 又在等同一个槽位，就互锁
（2026-11-04：`MUTATE_QUEUE_STALL ... tool=plan_run runningMs=720009`，12 分钟后强开才跑完，
期间发起方对话轮一直「思考中…」）。「同一计划不能同时跑两轮」由 `PlansScheduler.running` 挡。

---

## 5. 本轮删掉的东西（避免复活）

| 删掉 | 原因 |
|---|---|
| `renderer/agent-guardrails.js` 的 `shouldBlockRepeatToolCall` / `recordToolCallFingerprint` / `repeatToolBlockMessage` | 全仓**零调用点**；工具执行只在 Main，重复止损由 `repeat-guard` 关卡执行。留着只会让人以为 Renderer 也会拦 |
| `replyClaimsFileWork`（恒返回 false）+ `missing_write_evidence` 分支 + `isLikelyFileModificationTask` | 关键词判定被仓规禁用后该分支永远不可达；证据只认 trace / changes 结构信号 |
| `executeAgentToolInner` 里的二次归一 | 两个入口（本地调用 / Main 反向委托）都先过 `executeAgentTool`，归一已在那里完成 |
| `executeAgentTool` 尾部的手写顺序（absorb → screenshot → sanitize → write-smell） | 改为 `extraAfterHooks` 声明，与默认关卡同一执行器 |

---

## 6. 测试

- `npm run test:tool-gate`：关卡顺序、短路、外层追加位置、结果改写、失败不落盘。
- `npm run test:tool-harness`：既有行为不变（校验/重复/重试/落盘/失败信封）。
- `npm run test:guardrails-sync`：Main 与 Renderer 的护栏常量和判定口径不分叉。

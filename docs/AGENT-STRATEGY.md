# Agent 策略分层：策略交模型 + 底线留代码

> **已落地（2026-09）**：发送前 `taskTier` 只走结构信号（无额外分级 LLM）、按分级跳过自动 codebase、流式中断保留 partial reasoning/content。Fast Path / JS agent loop / **意图词表与 regex fallback 均不采用**。
> **关联**：[DESIGN.md](./DESIGN.md) · [ARCHITECTURE.md](./ARCHITECTURE.md) §5 Agent 执行
> **背景**：简单 UI 小改类任务曾「只读探索多轮、护栏触发仍不写文件」。根因是启发式正则与硬编码护栏双轨漂移；`host_exec` 只读命令曾绕开探索计数（已修，见 `tool-guardrails.js`）。

---

## 1. 要解决什么问题

| 现象 | 根因 |
|------|------|
| 「去掉两行 HTML」仍 search/read 多轮 | 探索护栏触发；需模型遵守 write 指令或用户点继续 |
| 护栏提示「请 fs_write_file」后仍不写入 | 模型不遵守 prompt；曾可用只读 `host_exec` 重置探索计数 |
| 同类常量多处定义、默认值不一致 | `tool-guardrails.js` / `agent-guardrails.js` 双份 → **已收敛至 `guardrails-shared.js`**（2026-07 P3） |
| 改一个数字要动多处 | 无 `agent-limits` 单一配置源 |

**目标**：把 **「怎么做事」交给模型（策略）**，把 **「不能做什么 / 何时必须停」留在代码（底线）**。

---

## 2. 设计原则

### 2.1 三类硬编码（全项目 ~200+ 处命名常量）

| 类别 | 占比（粗估） | 处理方式 |
|------|-------------|----------|
| **必须留代码** | ~55% | 安全、成本、防死循环、资源上限 — **不可交给模型** |
| **Prompt + 代码双保险** | ~30% | 模型常违反；prompt 软约束 + code 硬拦 |
| **可主要交模型** | ~15% | 任务分级、建议关注文件 — **策略 JSON** |

### 2.2 分工一句话

```
发送前 inferTaskTierFromStructure（路径 / 选区 / 产物 / @Codebase；无额外 LLM）
System prompt         → 复述分级（软）
agent-limits + 护栏   → 数字上限与安全（硬）
```

### 2.3 明确不交给模型的项

- `exec-policy` 高危命令拦截
- `REPEAT_TOOL_STREAK_LIMIT`（防相同工具死循环）
- `agentToolCallLimit`、token /  spill 上限
- 探索达上限后 **禁止** 只读工具（含只读 `host_exec`）
- 「声称已完成」vs「实际留下证据」的 **完成验收**（`src/agent/completion-readiness.js`）
- explore / shell / build 阶段的 **工具白名单**（`planner-tool-filters.js`）

---

## 3. 目标架构

```mermaid
flowchart TD
  U[用户输入] --> T[inferTaskTierFromStructure\n路径/选区/@Codebase]
  T --> P[注入策略 prompt]
  P --> L[Agent loop · Rust only]
  L --> G[护栏 enforce\n相同工具+参数止损]
  G --> W{fs_edit / fs_write_file?}
  W -->|是| V[完成验收]
  W -->|否| C[有正文则交付]
```

### 3.1 与现有模块的关系

| 现有模块 | 改造后角色 |
|----------|------------|
| `tool-guardrails.js` | 硬底线：完全相同工具+参数止损；无只读探索/同文件重读硬拦 |
| `tool-gate.js` + `guardrails-shared.js` | 关卡清单与工具名归类**单一来源**；Renderer 不再留任何判定/常量 |
| `renderer-context-engine.js` `CTX_LIMITS` | 字符硬顶保留；**选哪些文件**可听 `suggestedFiles` |
| `agent-limits.js` | 护栏数字单一配置源（已实现） |

---

## 4. 核心数据结构

### 4.1 `taskTier` 分类结果

实现：`src/agent/task-tier.js`（Renderer 与 Main 共用）。`useFastPath` **恒为 false**（JS Fast loop 已删除）。

分类输入只用结构信号：**路径 / 编辑器选区 / 产物 / `@Codebase`**。禁止意图词表、regex fallback，以及发送前再打一枪分级 LLM。

### 4.2 `agent-limits` 配置

实现：`src/agent/agent-limits.js`。相关项：`repeatToolStreakLimit`、`taskTierEnabled`。无 `fallbackToRegex`。无 `exploreStreakLimit` / `sameFileReadLimit`。无分级 LLM 超时项。

### 4.3 taskTier 与检索

`trivial` + `readyToWrite`（或已有建议文件）时跳过 **自动** codebase 检索；用户消息含 `@Codebase` 仍检索。不再按分级硬拦只读工具。

完成验收的**判定与证据采集都在 Main**（`src/agent/completion-readiness.js`）：证据 = 循环账本 trace（工具名 + 结构化退出码/`ok:false`）+ Gateway `workspace.diagnostics`（只请求 error 级）+ `browser.console/network`（按本轮开始时刻切时间窗）；诊断 error / 验证失败 / 浏览器运行时错误会提示用户，不自动续跑。验证类按**命令的最后一次结果**判定：静态诊断干净不能抵消失败，「先通过后失败」也算失败。Renderer 只做 `applyReadinessNote` 渲染。LLM Reviewer **非默认**。**作用范围只有对话单轮**（`agent:run`）：计划模式与定时计划的产出走计划审阅 + worktree 应用，没有这道门。

流式：SSE 中断时把已收到的 `content`/`reasoning` 挂到 error.partial；重试/非流式回退时合并；重连耗尽且已有残片时，直接用残片走正常 `llm_response` 通道继续，而不是整轮空白失败（不再单独发「已恢复」事件）。

---

## 5. 实现阶段

### 已完成

- [x] `agent-limits` 单一来源；`tool-guardrails` 从 limits 读常量
- [x] `src/agent/task-tier.js` + 发送前注入 + system 策略块
- [x] `tool-harness` 重复工具止损（explore/reread 硬拦已删除）
- [x] 完成验收只提示、不自动续跑
- [x] 同模型 Reviewer 默认关闭；opt-in 须独立模型，payload 为 files+diff
- [x] 流式 partial 保留与合并
- [x] `test/unit/task-tier.test.cjs`（`npm run test:task-tier`）

### 未做（非本能力项）

- 遥测字段 `taskTier`

**总预估（历史）**：约 5–6 人天；P0 已落地。

---

## 6. 文件清单

| 路径 | 角色 |
|------|------|
| `src/agent/task-tier.js` | 分级解析 / 结构推断 / 跳过自动 codebase |
| `src/agent/agent-limits.js` | `taskTierEnabled` |
| `src/agent/tool-harness.js` | run 级指纹止损 |
| `src/llm-stream-utils.js` | `mergeMissingReasoning` / `attachPartialStreamError` |
| `src/agent/rust-loop-runner.js` | 流式残片合并（重连耗尽直接用残片续走 `llm_response`） |
| `src/renderer/renderer-agent-send.js` | 发送前分类 |
| `src/agent/completion-readiness.js` | 完成验收判定（证据在 Main） |
| `src/renderer/agent-guardrails.js` | 只渲染验收提示（`applyReadinessNote`） |
| `src/agent/turn-reviewer.js` + `turn-reviewer-run.js` | 可选 files+diff Reviewer |
| `test/unit/task-tier.test.cjs` | 分级与流式残片单测 |

---

## 7. 参考：现有相关代码

| 职责 | 路径 |
|------|------|
| 重复工具止损 | `src/agent/tool-guardrails.js`（跑它的是 `src/agent/tool-gate.js` 的 `repeat-guard` 关卡） |
| 工具执行拦截 | `src/agent/tool-harness.js` |
| 完成验收 | `src/agent/completion-readiness.js` → `evaluateTurnReadiness`（渲染：`src/renderer/agent-guardrails.js` → `applyReadinessNote`） |
| 可选 diff Reviewer | `src/agent/turn-reviewer-run.js`（默认关；判定在 `turn-reviewer.js`） |
| Shell 安全 | `src/gateway/exec-policy.js` |
| 工具能力白名单 | `src/agent/planner-tool-filters.js` |
| 上下文硬顶 | `src/renderer/renderer-context-engine.js` → `CTX_LIMITS` |
| 可配置工具调用上限 | `src/model-settings.js` → `agentToolCallLimit` |

---

## 8. 测试与回归用例

1. **结构 trivial**：消息含明确路径且短 → `taskTier: trivial`，可跳过自动 codebase
2. **host_exec 绕开**：连续只读 `sed -n` 计入 streak（见 `test-tool-harness.cjs`）
3. **分级**：只结构信号，发送不另打 LLM
4. **heavy**：不走已删除的 Fast loop
5. **完成验收**：判定在 Main（`test/unit/completion-readiness.test.cjs`）——退出码只认 `result.code`、断言只看最后一次、网关挂了只降级成少一条证据；失败只提示、不自动续跑；LLM Reviewer 非默认

---

## 9. 变更记录

| 日期 | 说明 |
|------|------|
| 2026-06-30 | 初稿：开放设计，源自「探索 8 步硬编码」评审与 tank 小改失败 case |
| 2026-09-02 | 落地 taskTier / 完成验收自动重试 / 流式残片；明确不做 regex 与 Fast Path |
| 2026-09-09 | 去掉发送前分级 LLM；`taskTier` 仅结构信号 + 检索门闩 |
| 2026-10-28 | **完成验收判定迁到 Main**（`src/agent/completion-readiness.js`）：证据取自循环账本 trace + Gateway 诊断/浏览器事实，退出码改读结构化 `result.code`；删除 Renderer 规则门、`verifyTargetCompletion` 空壳、`readinessRetry` 死分支与「诊断伪 trace 轮次」 |
| 2026-10-28 | **完成验收误判修整**：验证类按「命令的最后一次结果」判定（不再用「任意一次通过」抵消失败，静态诊断干净也不再抵消失败）；失败的工具认结果对象的 `ok:false`/`error`（`browser_expect` 断言失败此前完全漏判，因为它刻意不带 `error`）；写失败的文件不进诊断清单；浏览器证据按本轮开始时刻切 `sinceMs` 窗口（观察账本按会话累计、并无「每轮 reset」）；诊断只请求 `minSeverity:'error'`（防 warning 占满每文件上限）；两段采集并行 + 调用点兜底，采集预算收进 `agent-limits.readiness*`，删死键 `completionRepairAttempts` / `verifyDiagMaxChars` |

---

## 10. 开放问题

1. **用户可见性**：是否在 thinking trace 展示 `taskTier` / `reason`。

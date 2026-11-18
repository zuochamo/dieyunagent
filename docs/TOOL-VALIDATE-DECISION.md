# 工具校验：条件必填放哪（决策记录 · 2026-11-18）

> 背景：`docs/NODE-THINNING-PLAN.md` N2.1 的双跑还差 19 条差异，其中 6 条是「某个 action 下才必填」
> （`lsp` 三种 operation、`worktree` create/remove、`host_proc kill`）。这份记录回答**这些规则放在哪**，
> 以及顺带查出来的一个前提错误。
>
> 状态：**已裁决（选 A）**，分四步走；每一步都能单独验收、随时可停。

---

## 0. 先纠正一个前提（盘点结论有误）

之前记的「`schema-empty` 10 条 = schema 里根本没这些字段」**不准确**。实测：

```
getToolByName('goal_start')  // → null
require('./src/agent/catalog/plan').GOAL_START_TOOL.function.parameters
// → { type:'object', properties:{objective,checks,todos}, required:['objective'] }   ← 齐全！
```

`goal_*` 是**条件注入**的工具（会话有目标时才出现在工具表里），所以它们不在 `ALL_STATIC_TOOLS` 里；
而 `catalog/groups.js` 的 `BY_NAME`（`getToolByName` 的唯一来源）只从 `ALL_STATIC_TOOLS` 构建 ——
于是这些 schema **存在但解析不到**，生成器与盘点脚本把「解析不到」记成了「schema 为空」。

**只修解析**（不改任何 schema）的双跑结果：一致 43 → **45/62**，差异 19 → **17** —— 这条已经在 A0 里实测确认。

> 教训：盘点里的 `schema-empty` 这个名字本身带误导。它应该叫「生成器拿不到规则」，
> 原因可能是「schema 没写」也可能是「工具不在解析表里」——这两种要分开数。

## 1. 剩下的 17 条到底缺什么

| 成因 | 条数 | JSON Schema 能表达吗 | 涉及的规则 |
|---|---|---|---|
| 条件必填 | 6 | **能**（`allOf` + `if/then`） | `lsp`：workspaceSymbol→query；非 workspaceSymbol→filePath；定位类→line。`worktree`：create/preview/apply/cleanup→runId；remove→path。`host_proc`：kill→id 或 pid |
| 跨字段互斥/择一 | 6 | **能**（`anyOf` / `not` / 嵌套 `required`） | `goal_update`：objective/todos/checks 至少一个。`goal_check`：command 或 check_id。`read_symbol`：`filePath+name` / `filePath+line` / 仅 `name`。`plan_create`：`goal.objective`、`goal.checks` 必填，且 `goal` 与 `rrule/onceAt` 互斥 |
| 错误码口径 | 3 | — | 「缺字段」与「值非法」的归口不同（`MISSING_ARG` vs `INVALID_ARG`） |
| 解析不到（已定位） | 2 | — | 见 §0，修 `getToolByName` 覆盖即可 |

## 2. 三个方案

### A. catalog 成为完整契约（`if/then` + `anyOf`）· **选它**

| | |
|---|---|
| **消掉** | 条件 6 + 跨字段 6 = **12 条**（加上修解析的 2 条，只剩 3 条口径问题） |
| **成本（实测）** | 三个条件工具加 `allOf/if/then`：`lsp` 690→1094、`host_proc` 723→865、`worktree` 1308→1566，合计 **+804 字符 ≈ 230 tokens**；参照「全部静态工具 schema 合计 66263 字符 ≈ 18.9k tokens」→ **+1.2%** |
| **需要写的代码** | 一个共享条件求值器（`allOf` / `if` / `then` / `anyOf` / `not`，约 60 行），手写与生成两侧都用它 —— 它本来就是生成器的核心，不算新增机制 |
| **风险** | ① `if/then` 会下发到模型（我们把 `parameters` 原样发出）：弱模型可能被绕晕；② 部分网关会忽略不认识的 keyword（忽略是安全的 —— **我们不用 OpenAI `strict` 模式**，校验靠自己的校验器） |
| **为什么不选「在 outbound 里剥掉 allOf」** | 那等于「模型看到的」和「我们校验的」是两份；而 `lsp` 那句「workspaceSymbol 只要 query」对模型是有用信息（能少跑一轮）。230 tokens 买这个，划算 |

### B. 生成器里放「action → 必填」表

| | |
|---|---|
| **消掉** | 同样 12 条 |
| **代价** | schema 继续对模型沉默 → 模型还是会漏 `filePath`，白跑一轮才知道；且这张表就是**第二个真相**（正是 N1/N2 要消灭的东西） |
| **什么时候它才对** | 如果 A 的 `if/then` 实测让工具调用成功率下降，B 是退路（拿"模型看不到条件"换"payload 更简单"） |

### C. 删掉关卡里的条件校验，交给执行端

| | |
|---|---|
| **实测反对证据** | `host.proc_kill` 缺 id/pid → 一路到 `killProcessHandle` 才报「结束进程失败」（不说是缺参）；`lsp.query` 的 `filePath` 检查**只在 SSH 分支**（`lsp-workspace.js:166`），本机分支直接交给语言服务器 |
| **更糟的** | `worktree create` 这类有副作用：等到执行端才发现缺 runId，可能已经建了分支 |
| **结论** | 不选。它把「一行明确报错」换成「更晚、更模糊、可能有副作用」 |

## 3. 裁决与分步

**选 A**，四步，每步独立可验收：

| 步 | 做什么 | 消掉差异 | 风险 |
|---|---|---|---|
| ~~**A0**~~ **已完成 2026-11-18** | `catalog/groups.js` 新增 `CONDITIONAL_TOOLS`（现在就是 `goal_*` 四件套）与 `ALL_KNOWN_TOOLS = ALL_STATIC_TOOLS + CONDITIONAL_TOOLS`，`BY_NAME` 从全集构建；`ALL_STATIC_TOOLS` 未动（注入面不变），生成器/盘点改用全集。实测：可解析工具 80 → **84**，生成规则覆盖 75 → **79**，双跑 45/62、差异 17 | 2 条（实测 -2） | 已完成 |
| ~~**A1**~~ **已完成 2026-11-18** | `src/agent/schema-rules.js`（`allOf` / `if-then` / `anyOf` / `not` / `const` / `enum` / `type` 求值）；手写校验器三个分支改成 `evaluateRules(tool, toolParams(tool), args)`，生成的校验器也调**同一个**求值器；`lsp`（3 条）/ `host_proc`（1 条）/ `worktree`（2 条）补 `allOf`。实测：双跑 **51/62**、差异 **11**（`schema-conditional` 归零），求值器另有 8 条单测（`test/unit/schema-rules.test.cjs`） | 6 条（实测 -6） | 已完成 |
| ~~**A2**~~ **已完成 2026-11-18** | 求值器补三种能力（子 schema 级 `not`/`anyOf`、`then.not`、嵌套 `required`）；四处规则进 schema：`read_symbol` 三选一（`anyOf`）、`goal_update`/`goal_check` 择一（`anyOf`；`checkId` 是执行端**真的会读**的别名，所以**声明**进 schema 而不是删）、`plan_create` 的 `goal.objective`/`checks`/`prompt` + 与 `rrule`/`onceAt` 互斥。实测：双跑 **58/62**、差异 **4**（`schema-empty` 归零，只剩 4 条错误码口径） | 6 条（实测 -7） | 已完成 |
| ~~**A3**~~ **已完成 2026-11-18** | 统一错误码口径（规则见下）——改的是**码**不是判定；`agents_md_propose` / `fs_write_file` / `goal_finish` / `lsp` 四处不再共用一个 `MISSING_ARG`。实测：双跑 **62/62、差异 0**（`KNOWN_DIFFS` 清空） | 4 条（实测 -4） | 已完成 |

**A3 之后差异为 0** —— 手写校验器与生成的校验器在 62 条夹具上逐条一致，`MIN_AGREE = 62`。

### 接管（2026-11-18 已完成，分两步）

| 步 | 做法 | 结果 |
|---|---|---|
| 1 | `validateToolArgs` 最前面统一跑生成的机械校验（required / type / enum / range / 条件 / 跨字段），手写块**全部保留** | 全量测试零回退：`test:unit` 2236、`test:agent` 全绿、`test:tool-args` 62/62 |
| 2 | 删掉手写里**纯机械**的 18 个工具分支（`codebase_search` / `grep` / `glob` / `fs_list_dir` / `fs_read_file`+`host_print_image` / `fs_write_file` / `web_search` / `agents_md_propose` / `goal_*` 四件套 / `read_symbol` / `plan_create` / `lsp` / `worktree` / `host_proc`） | `tool-validate.js` **1128 → 787 行（-341，-30%）**；手写只剩语义分支 |

保留在手写里的 11 处语义判定（schema 表达不了，也不该由生成器管）：
`computer`（坐标/键名 + 策略）、`skill_delete`（绝对路径正则）、`ssh`（明文凭据一律拒绝）、
`host_exec`（`validateShellCommand`）、`apply_patch`（不支持时的引导）、`fs_edit`（`fsEditArgsPresent`）、
`web_fetch` / `host_open_url`（`isHttpUrl`）、`graph`（操作清单 + find_symbol 要 query）、
`mcp_manage` / `mcp_tool_schema`（MCP 参数跨字段 + 瘦身）。

**接管踩到的真问题**：机械校验一生效，`test-tool-gate.cjs` 里那批「心跳轮不许这些工具」的用例开始失败 ——
因为它们用的是**不存在的字段名**（`peer_send {message}` 而非 `text`、`plan_run {planId}` 而非 `id`），
以前靠「`validateToolArgs` 对这几个工具是 no-op」才走到 scope 检查。已改成 schema 合法入参 ——
那批用例本意是测「只读轮不许跨机/子 loop/计划」，不该被参数错误掩住。

**遗留待议**：`tool-gate.js` 里「参数校验」在「scope/权力」之前。对「这一轮根本不许用这个工具」的场景，
先报 `READ_ONLY_SCOPE` 比先报 `MISSING_ARG` 更准确 —— 是否调换两关顺序是独立决策（会动 AGENTS §6 的关卡顺序）。

### 错误码口径（A3 定的规则，改校验前先看）

| 情形 | 码 |
|---|---|
| 缺**路径类**字段（`filePath` / `dirPath` / `path` / `dir`） | `MISSING_PATH` |
| 缺**内容类**字段（`content` / `text` / `body` / `patch`） | `MISSING_CONTENT` |
| 缺其它必填字段 | `MISSING_ARG` |
| 有值但不合法（枚举越界 / 类型错 / 范围越界 / 互斥 / 跨字段组合不满足） | `INVALID_ARG` |

归口的唯一实现是 `src/agent/schema-rules.js#missingCodeFor`，手写与生成的校验器都用它 ——
所以「同一个字段在两条路径上给不同的码」这类漂移不会再出现。

> **A1 的一个副作用（顺手做对的）**：条件规则由 `schema-rules` 求值后，错误码按字段类归口 ——
> `worktree remove 缺 path` 从 `MISSING_ARG` 变成 `MISSING_PATH`（与 `fs_read_file` / `lsp filePath` 一致）。
> 两处既有断言（`test-tool-bridge-handlers`、`test-tool-harness`）随之更新 —— 这就是 A3 想收的口径，提前收了一小块。

## 4. 什么会推翻这个决定

1. **工具调用成功率下降**：A1 落地后看 tool harness 的失败样本，若出现"模型被 if/then 绕晕"（例如 `lsp` 一律先给 filePath 而不给 operation），退回 B；
2. **某网关 400**：若上游对 `allOf` 报参数非法，则在 `outbound.rs` 的 tools 投影里剥 `allOf`（那里本来就是唯一投影点），并接受"模型看不到条件"；
3. **prompt 预算吃紧**：实测 +230 tokens（1.2%）可忽略；若将来条件规则长到 >2k tokens，改为「description 里一句话 + schema 只给规则给校验器」。

## 5. 不在这份决策内

- `MCP` 工具的 `inputSchema` 走 `slimMcpInputSchema`（另一条通道，`if/then` 会被瘦身掉 —— 这是可接受的有损）；
- 生成的校验器**接管**这件事本身（替换 `tool-validate.js`）仍等 A3 之后；
- `errorCode` 的**用户可见文案**不在本决策内（只统一分类码）。

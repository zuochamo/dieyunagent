# `tool-validate.js` 盘点（N2.1 第一步）

> **AUTO-GENERATED** by `scripts/inventory-tool-validate.cjs`（`npm run inventory:tool-validate`）。
> 这是**盘点的口径与数字**，不是计划：口径写在脚本里，重跑即复现（不手写数字）。

## 规模

| 项 | 数字 |
|---|---|
| 文件总行数 | **818** |
| `switch` 分支（按工具名） | **11** 个，共 399 行 |
| 独立函数（语义校验 / 公共判定） | **13** 个，共 736 行 |
| 机械检查点（required / enum / type / range） | **29** 处（required 25 / enum 1 / type 3 / range 0） |
| 跨字段条件必填（某个 action 下才必填） | **3** 处 |
| 文件内上下限比较（`AGENT_LIMITS_DEFAULTS.*`，均在语义函数里） | **12** 处 |
| 含语义判定的分支 | **8** / 11 |

## 分类口径

| 类别 | 判据 | schema 能否表达 |
|---|---|---|
| 机械 · required | `!String(a.x \|\| '').trim()` / `a.x == null` | **能**（`required`） |
| 机械 · enum | `allowed.includes(...)` / 字面量数组 `.includes(action)` | **能**（`enum`，且 action 枚举已从 schema 取） |
| 机械 · type | `Array.isArray(a.x)` / `typeof a.x !== …` | **能**（`type`） |
| 机械 · range | `AGENT_LIMITS_DEFAULTS.x` 参与的比较 | **能**（`minimum` / `maximum`） |
| 跨字段 · conditional | 只在某个 `action` 下必填 | **不能**（要 `if/then` 或继续手写） |
| 语义 · 必须人写 | 正则形状、策略调用、坐标/补丁/凭据判定 | **不能**（跨字段 / 外部知识） |

## 按工具

| 工具 | 行数 | schema props / required / enum | 机械 | 条件必填 | 语义 | 判定 |
|---|---|---|---|---|---|---|
| `mcp_tool_schema` | 123 | 2 / 0 / 0 | 11 | 0 | 2 | 委托给语义函数 |
| `mcp_manage` | 86 | 15 / 1 / 3 | 12 | 1 | 2 | 需保留语义 |
| `ssh` | 68 | 16 / 1 / 3 | 3 | 2 | 0 | 条件必填需保留 |
| `graph` | 37 | 10 / 1 / 0 | 3 | 0 | 1 | 需保留语义 |
| `host_exec` | 26 | 7 / 1 / 0 | 0 | 0 | 3 | 委托给语义函数 |
| `fs_edit` | 22 | 5 / 1 / 0 | 0 | 0 | 1 | 需保留语义 |
| `skill_delete` | 21 | 1 / 1 / 0 | 0 | 0 | 1 | 需保留语义 |
| `host_open_url` | 11 | 1 / 1 / 0 | 0 | 0 | 1 | 需保留语义 |
| `computer` | 2 | 15 / 1 / 0 | 0 | 0 | 0 | 委托给语义函数 |
| `apply_patch` | 2 | 0 / 0 / 0 | 0 | 0 | 1 | 委托给语义函数 |
| `web_fetch` | 1 | 2 / 1 / 0 | 0 | 0 | 0 | 可全自动生成 |

## 独立函数（语义 / 公共判定，**不该被生成**）

| 函数 | 行数 | 机械检查 | 语义点 | 性质 |
|---|---|---|---|---|
| `validateToolArgs` | 407 | 29 | 11 | 语义判定（必须人写） |
| `validateComputerArgs` | 170 | 15 | 2 | 语义判定（必须人写） |
| `validateMcpInputArgs` | 47 | 0 | 2 | 语义判定（必须人写） |
| `validateComputerExtras` | 39 | 0 | 1 | 语义判定（必须人写） |
| `jsonSchemaTypeOk` | 13 | 0 | 0 | 待核实 |
| `toolActionEnum` | 11 | 0 | 0 | 待核实 |
| `computerArgError` | 9 | 0 | 0 | 待核实 |
| `applyPatchUnsupported` | 9 | 0 | 1 | 语义判定（必须人写） |
| `computerPointOk` | 8 | 0 | 1 | 语义判定（必须人写） |
| `isHttpUrl` | 8 | 0 | 1 | 语义判定（必须人写） |
| `mcpArgPresent` | 7 | 0 | 1 | 语义判定（必须人写） |
| `mcpRequiredKeys` | 5 | 0 | 0 | 待核实 |
| `looksLikeApplyPatchCommand` | 3 | 0 | 2 | 语义判定（必须人写） |

## 预计可删行数（N2.1 的收益上限，先说清假设）

- 「纯机械」分支 **2** 个、共 **69** 行：这些能被生成器整体替掉；
- 机械检查 29 处 × 约 4 行（if + return 对象）≈ **116** 行；
- 结论：**可删约 69–69 行**，落到 ~749–749 行。
  > 计划里「目标 < 500 行」只在**把条件必填也交给 schema（`if/then`）并且语义函数一起瘦身**时才成立；
  > 只做「机械部分生成」大概到 850–900 行。数字先摆在这里，别到时候拿目标当承诺。

## 下一步（按这些数字挑双跑样本）

- 「**可全自动生成**」的分支共 3 个（机械检查 3 处）——先在这批上做双跑夹具；
- 「含语义判定」的 8 个分支，生成器只出机械部分，语义块原样保留；
- 「条件必填」3 处：要么扩充 catalog schema（`if/then`），要么在生成器里显式列出 —— 二选一，别两边都写。


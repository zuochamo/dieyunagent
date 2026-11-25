# 让 Node 变薄 · 可排期清单（2026-11-17）

> **这份清单要解决的问题**：Node 侧 16.6 万行 JS 里，有一部分不是「平台适配」，而是
> **同一份知识的第二份实现**（Rust 里已经有一份，靠注释约定「务必逐字对齐」）。
> 那部分才是真正的技术债 —— 它会在某次单边修改后静默漂移。
>
> **明确不在范围**：把 Node 运行时取消掉。Electron 主进程本身就是 Node（`package.json:main = src/main.js`），
> headless 包还内置 node（`scripts/pack-headless.cjs`）；真要去掉 Node 得换外壳（Tauri/wry）+ 重写
> `src/gateway/` 宿主 + 重写 headless，那是产品/路线决策，不是技术债条目。
> 本清单只做一件事：**让 Node 只剩「平台适配 + 工具执行 + 前端资源」**。

## 0. 判据（一条改动属于哪一类，先回答三个问题）

1. **这份知识 Rust 那边是不是也有一份？** 有 → 属于「双写」，必须合成一份（切片 N1 / N2）。
2. **这段语义是不是「账本/策略」而不是「平台动作」？** 是 → 归 core（切片 N3）。
3. **它还有调用点吗？** 没有 → 删（切片 N4）。
   三个都答「否」→ **不动**，并在本文档第 5 节登记理由，防止下一个人再来搬。

## 1. 现状账（测量基线）

| 层 | 行数 | 归属判定 |
|---|---|---|
| `src/renderer/` 118 文件 | 55,956 | UI（跑在 Chromium，**与 Node 无关**） |
| `src/agent/` 100 文件 | 29,165 | 混合：提示/限额/关卡（宿主职责）+ 少量双写（token/compaction 策略）+ 历史残留 |
| `src/gateway/` 57 文件 | 16,568 | 工具执行 / 路径白名单 / 沙箱（宿主职责，**搬了更差**） |
| `src/browser/` 22 | 11,166 | Playwright 栈（生态硬绑定） |
| `src/main/` 33 | 8,018 | Electron IPC / 窗口 / 托盘（外壳职责） |
| `src/lsp/` 9 | 5,869 | spawn 语言服务器（宿主职责） |
| `src/ssh/` 19 | 5,404 | ssh2（生态硬绑定） |
| `src/mcp/` 12 | 3,541 | MCP SDK + stdio（生态硬绑定） |
| `src/peer/` 10 | 3,247 | 内网互通（已定在 Node，见 `docs/PEER-MESH-PLAN.md`） |
| 其它（mobile/git/alive/headless/plans/remote/channels/computer/...） | ≈ 12,600 | 各类平台适配 |
| **合计 JS** | **166,554** | |
| `crates/dieyun-core/` | 28,492 | 账本 / LLM / memory / index / planner / compaction（该在 Rust 的部分已经在了） |

**已完成基线（本轮 §1）**：Renderer 不再持 WebSocket，`renderer-gateway.js` 净 −125 行，并删掉一次进程内中转（详见 `docs/ARCHITECTURE-DEBT.md` §1）。

---

## 2. 切片 N1 · 同一份知识合成一份（契约与常量）

> 这一片**不改任何行为**，纯消除双写；每条都能用「生成闸门」永远锁住。

### N1.1 跨语言常量收敛到一份数据文件 · 规模 S（1–2 人日）

| | |
|---|---|
| **现状证据** | 6 处手抄 Rust 常量：`src/agent/agent-limits.js:216`（图片折算 token）、`:239`、`:428`（衰减/归档窗口与向量批量「与 Rust 默认一致」）；`src/agent/compaction-main.js:85`（`charsPerToken`「与 Rust `compaction/tokens.rs` 同值」）；`src/core-bridge.js:270` + `src/core-rpc-timeouts.js:36`（`SLOW_RPC_LOG_MS` 同值，注释自陈「跨语言没法共享常量」）；`src/agent/session-title.js:29`（`TITLE_SOURCE_AI` 同值）；`src/index/source-files.js:26` + `src/gateway/rg-search.js:7`（忽略目录与 `index/walker.rs` 对齐）；反向还有 `crates/dieyun-codebase/src/index/search.rs:23`（`slice(0,400)` 与 Node grep 对齐） |
| **动什么算完** | 一份机器可读数据（`src/agent/agent-shared.json`）：Node 侧 `require` 读、Rust 侧 `include_str!` + serde 读；上面每一处改成读它，并删掉「与 Rust 同值」的注释（不再需要）；`scripts/check-repo-contracts.cjs` 增一条闸门：数据文件里的每个键**两侧都有人读**（防只改一侧） |
| **风险** | 打包要带上这个文件：`electron-builder` 的 `build.files`、`scripts/pack-headless.cjs` 的纯 JS 闭包白名单都得列它（已有 `assets/` 机制可复用） |
| **验证** | `npm run check:repo-contracts`、`cargo test -p dieyun-core --lib`、`npx vitest run test/unit/token-estimate.test.cjs`、`npm run test:headless` |

### N1.2 把「跨语言一致性测试」范式化（已有现成做法，照抄） · 规模 S

| | |
|---|---|
| **现状证据** | 已经是好例子：`test/unit/token-estimate.test.cjs` 与 `crates/dieyun-base/src/compaction/tokens.rs` 的 `#[cfg(test)]` **共用同一份** `test/fixtures/token-estimate-cases.json`。而其它双写点没有这种锁 |
| **动什么算完** | 凡「两侧都要算/判」的函数都配一份 fixture，两侧测试读同一份。先补两个最痛的：① 忽略目录判定（`IGNORE_DIRS` 集合是否一致）；② 展示行截断口径（`slice(0,400)`）。fixture 放 `test/fixtures/`，命名 `<domain>-cases.json` |
| **验证** | `npx vitest run test/unit/`（JS 侧）+ `cargo test -p dieyun-core --lib`（Rust 侧）同 fixture 双跑 |

### N1.3 RPC 字段契约由生成器守（消灭「务必逐字对齐」注释） · 规模 M（2–3 人日）· **已完成（2026-11-18）**

| | |
|---|---|
| **现状证据** | `crates/dieyun-runtime/src/agent/loop_run.rs:1208`：「入口传的是 camelCase 字段 + snake_case 取值，**务必与 Node 端逐字对齐**」—— 契约靠注释。`docs/rpc-catalog.md` 已是自动生成（`npm run verify:rpc-catalog`） |
| **动什么算完** | `scripts/generate-rpc-catalog.cjs` 额外产出 `types/core-rpc.d.ts`（方法名 + 参数/返回字段）；调用方（`src/agent/rust-loop-runner.js`、`src/core-bridge.js`）加 `// @ts-check` 引用它；`npm run check:js`（`tsc --noEmit`）直接报字段漂移。删掉「逐字对齐」类注释 |
| **风险** | Rust 侧字段来源要么解析 serde struct、要么在 `rpc/mod.rs` 手维护一份 schema 段；选后者更省，但那就还得有个「schema 与实现一致」的测试（`cargo test` 里做） |
| **验证** | `npm run verify:rpc-catalog`、`npm run verify:core-contracts`、`npm run check:js`、`cargo test --workspace --lib` |
| **落地（2026-11-18）** | 选了「标记跟着类型走」这条路，避免两边各维护一份 schema：<br>① 跨语言契约的 `pub struct` / `pub enum` 上打 `/// @contract` 标记（`loop_run/mod.rs` 11 个 + `planner/types.rs` 8 个）；<br>② 新增 `scripts/generate-core-contracts.cjs` → `types/core-contracts.d.ts`（**19 个类型**）：解析 serde 的 `rename_all` / `rename` / `default` / `skip_serializing_if`，Rust 类型 → TS（`Option<T>`→`T \| null`、`Vec`→`[]`、`HashMap`→`Record`、嵌套契约类型→类型名、未知→`unknown /* Rust: … */`）；<br>③ 闸门两条：`verify:core-contracts`（生成物过期就红，进 CI）+ `check:js`（调用方按类型读字段）；<br>④ 调用方接上：`applyResolvedLoopSpec` 的入参/出参标 `Partial<StartParams>`、`pendingResults` 标 `ToolResultInput[]`、`contentChannel` 标 `ContentChannel`、`readLoopStartFields` 逐字段显式读（**只读不抛**：缺参的报错仍归 core，不留第二份校验）。<br>**变异验证**：把 d.ts 里 `maxToolCalls` 改名 → `check:js` 立刻 `TS2339`（指名 `rust-loop-runner.js` 的读点）；改完忘了重生成 → `verify:core-contracts` 报过期。<br>**顺手踩到的坑**：生成器用「往前 600 字符」取 header，会吃到上一个类型的 `rename_all`，把 `ContentChannel` 生成成 `'Answer' …`（真实协议是 `'answer' …`）；改成「只取紧贴声明的属性块」后正确。 |
| **还留着什么** | 只覆盖**契约类型**（`agent.run.*` / `planner.*` 的参数与回包）；86 个 RPC 的其余方法仍是「名字有闸门、字段无闸门」。加一个方法是：给它的 Rust 入参/回包结构体打 `@contract` → 重跑生成器 |

---

## 3. 切片 N2 · 机械校验从 schema 生成（一次最大的行数净减）

### N2.1 `tool-validate.js` 生成机械部分，只留语义部分 · 规模 M（3–4 人日）· **盘点已完成（2026-11-18）**

| | |
|---|---|
| **现状证据** | `src/agent/tool-validate.js` **1128 行**手写参数校验；schema 已在 `src/agent/catalog/*.js`（12 文件 2742 行，含 `params.js` 公共片段）。其中真正需要人写的是语义校验：`computerPointOk`（坐标）、`applyPatchUnsupported`、`validateMcpInputArgs` 的跨字段部分、`looksLikeApplyPatchCommand`；其余是 required/type/enum 的机械展开 |
| **动什么算完** | 新增 `scripts/generate-tool-validators.cjs` → `src/agent/tool-validate.generated.js`（从 catalog 抽 required/type/enum/范围）；`tool-validate.js` 只剩语义校验，目标 < 500 行；生成物进版本库 + `--check` 闸门（和 `rpc-catalog` 同一套做法） |
| **风险** | 校验口径变化会直接影响工具调用成功率：**先双跑对比**（同一批参数 fixture 上，旧校验与新校验结论必须一致）再切换；不一致的逐条判定「是旧代码漏了还是新代码过严」 |
| **验证** | `npm run test:tool-harness`、`npm run test:tool-bridge-handlers`、`npm run check:js`，加一份 `test/fixtures/tool-args-cases.json` 双跑记录 |
| **盘点（2026-11-18，可复跑）** | `npm run inventory:tool-validate` → `docs/TOOL-VALIDATE-INVENTORY.md`（AUTO-GENERATED，口径写在脚本里）。实测：**1129 行** = `switch` **29 个工具分支 719 行** + **13 个函数 1050 行**（其中 `validateToolArgs` 721 行含全部分支）；机械检查 **44 处**（required 35 / enum 3 / type 6）+ 上下限比较 **12 处**（全在 `validateComputerArgs` 这类语义函数里）；**条件必填 6 处**（某个 action 下才必填 —— JSON Schema 要 `if/then` 才表达得了）；分支判定：**21 个纯机械**（共 389 行）/ **8 个含语义**（`computer`、`mcp_manage`、`mcp_tool_schema`、`host_exec`、`fs_edit`、`web_fetch`+`host_open_url`、`graph`、`skill_delete`）。
| **对目标的校正** | 计划里「目标 < 500 行」只在**条件必填也交给 schema（`if/then`）且语义函数一起瘦身**时成立；只做「机械部分生成」预计落到 **约 740–950 行**（脚本里按「每条机械检查 ≈ 4 行 if+return」估，假设写在盘点文档里）。下一步先拿这 21 个纯机械分支做双跑夹具，别一上来动语义块
| **双跑夹具（2026-11-18）** | `test/fixtures/tool-args-cases.json`（**61 条**：拒绝 33 / 通过 28，覆盖 **18 个**纯机械分支）+ `test/unit/tool-args-parity.test.cjs`（`npm run test:tool-args`）。三条守卫：①覆盖度下限（≥40 条、每个声明工具 ≥2 条、用例工具必须在 `coverage` 里）；②每条 `ok` 与 `errorCode` 与当前实现一致；③拒绝时必须带 `errorCode` + 可读 `error`（模型据此重试）。`CODEMAP` 已把 `src/agent/tool-validate.js` / `src/agent/catalog/` 映射到它 —— 改校验或 schema 会随 `npm test` 跑。
| **生成器 + 双跑（2026-11-18）** | `npm run generate:tool-validators` → `src/agent/tool-validate.generated.js`（75 个工具有机械规则；`verify:tool-validators` 防过期）。**它还不生效** —— 手写仍是唯一实现。双跑报告 `docs/TOOL-VALIDATE-DUALRUN.md`（`npm run report:tool-validators`）：**一致 62/62、差异 0**（2026-11-18 八轮收敛：35/26 → 37/24 → 39/23 → 43/19 → 45/17（A0）→ 51/11（A1）→ 58/4（A2）→ **62/0（A3 统一错误码口径）**。手写与生成在 62 条夹具上逐条一致，`MIN_AGREE = 62`），全部归类并逐条写明理由（数据源 `scripts/lib/tool-validate-dualrun.cjs`，测试与报告共用）：`schema-empty` 10 / `schema-conditional` 6 / `alias` 4 / `errorCode-taxonomy` 2 / `schema-lacks-range` 2 / `schema-lacks-enum` 1 / `handwritten-missing-enum` 1。测试 `tool-args-dualrun` 五条守卫：无未声明差异、无过期声明（差异消失）、无**变形声明**（差异还在但两侧结论变了，例如补了 enum 后从 `gen=ok` 变成 `gen=INVALID_ARG`）、一致率不下滑（≥35）、分类必须在允许集合内。每条 `KNOWN_DIFFS` 都记了当时观测到的两侧结论（`pairs`），所以「改进」也会被要求同步改条目，不会被静默通过。
| **结论：替换前还差三件** | ①补 `goal_*` / `plan_create` / `host_proc` / `read_symbol` 的 schema（跨字段规则目前表达不了，10 条差异）；②6 处条件必填定归属（schema `if/then` vs 生成器显式表）；③~~别名四处定去留~~ **已完成（删别名，schema 成为唯一真相）**。~~④`lsp.operation` enum 与 `web_search` 上下限补进 schema~~ / ~~⑤`agents_md_propose.section` 手写漏了枚举校验~~ —— **两项已完成（2026-11-18）**，见下一行。
| **2026-11-18 追加两处单一来源** | ①`lsp.operation` 与 `web_search` 的上下限进 schema，手写改读 schema（`toolActionEnum(name, field)` / `numericBounds(name, field)`），硬编码 0-3 / 1-10 删除；②`agents_md_propose.section` 的白名单收敛成 `src/agents-md-sections.js`（**零依赖**）→ 执行侧 `agents-md.js`、schema `catalog/memory.js`、手写校验三处共用；手写从「只判非空」改成按 schema enum 校验 → 非法 section 现在在关卡就被拒（之前要跑到执行端才报）。踩到的坑：catalog 会被打进 **Renderer bundle**，直接 require `agents-md.js` 会拖入 fs/path/crypto，`build:renderer:dev` 直接失败 —— 所以常量抽成零依赖文件。
| **别名怎么处理的（2026-11-18）** | 四条全按「删」处理，依据是执行端本来就不读别名：`grep` 执行端只读 `pattern`（`query` 别名会让错载荷过闸再失败）、`glob` 只读 `pattern`、`fs_read_file` / `host_print_image` 只读 `filePath`（共用一段 `filePath 或 dirPath` 时传 dirPath 必然在执行端拿到 undefined —— 这是真缺陷）；`worktree.action` 反过来是 **schema 比实现严**：执行端本来就是 `String(a.action \|\| 'list')`，于是 schema 去掉 required 并标 `default: 'list'`。顺带删掉 Renderer 展示层对 `grep.args.query` 的回退（载荷不可能有它）。
| **决策（2026-11-18）** | 条件必填与跨字段规则**放进 catalog schema**（`allOf`/`if/then`/`anyOf`），不另建生成器表、也不把校验交给执行端 —— 取证与实测成本（+804 字符 ≈ 230 tokens，占工具 schema 的 1.2%）见 [`docs/TOOL-VALIDATE-DECISION.md`](TOOL-VALIDATE-DECISION.md)。同一次取证还**推翻了一个前提**：`goal_*` 的 schema 其实齐全，只是它们在 `ALL_STATIC_TOOLS` 之外、`getToolByName` 解析不到 —— 只修解析就把一致率推到 45/62。
| **接管已完成（2026-11-18）** | 生成物已在 `validateToolArgs` 最前面生效，手写里**纯机械的 18 个分支已删**：`tool-validate.js` **1128 → 787 行（-341）**，只剩 11 处语义判定（`computer`/`ssh`/`host_exec`/`apply_patch`/`fs_edit`/`web_fetch`/`host_open_url`/`graph`/`skill_delete`/`mcp_*`）。两步走：先「生成器先跑 + 手写全留」确认零回退（`test:unit` 2236 / `test:agent` 全绿），再删代码。
| **A3 已完成（2026-11-18）** | 错误码口径统一：缺字段按字段类归口（path→`MISSING_PATH`、content→`MISSING_CONTENT`、其余 `MISSING_ARG`），有值不合法一律 `INVALID_ARG`；归口唯一实现 `schema-rules.js#missingCodeFor`。双跑 58 → **62/62、差异 0**（`KNOWN_DIFFS` 清空）。**尚未接管** —— 把生成物接进 `tool-gate.js` 并删掉手写机械块是下一步。
| **A2 已完成（2026-11-18）** | 跨字段规则全部进 schema：`read_symbol` 三选一、`goal_update`/`goal_check` 择一（`anyOf`）、`plan_create` 的 `goal.objective/checks/prompt` + 与 `rrule/onceAt` 互斥（`if/then` + `not`）。求值器补了子 schema 级 `not`/`anyOf`、`then.not`、嵌套 `required`。双跑 51 → **58/62**，差异 11 → **4**（`schema-empty` 归零）。
| **A1 已完成（2026-11-18）** | 条件必填（「某 action 下才必填」）不再写在 `tool-validate.js` 的 if 里：`src/agent/schema-rules.js` 求值 schema 的 `allOf/if-then/anyOf`，手写与生成的校验器**共用同一个求值器**，`lsp` / `host_proc` / `worktree` 三处 schema 各补一条 `allOf`。双跑 45 → **51/62**，差异 17 → **11**（该类归零）。
| **A0 已完成（2026-11-18）** | `catalog/groups.js` 加 `CONDITIONAL_TOOLS` + `ALL_KNOWN_TOOLS`（`goal_*` 四件套能按名解析了；`ALL_STATIC_TOOLS` 不动 → 注入面不变），生成器/盘点改用全集：可解析工具 80 → 84、生成规则 75 → 79。顺带纠正盘点的分类名：`schema-empty` 混了两种成因（schema 没写 / 工具解析不到），现在分开数。
| **还差什么** | ①生成器本身已落地但**未接管**（替换要等剩下三类）；②夹具只覆盖机械分支的**代表性**入参，不是全排列（生成器落地后按同样口径扩充）；③6 处「条件必填」的归属未定（扩 `if/then` vs 生成器显式列出）|

---

## 4. 切片 N3 · 语义上收 core（Node 只传原始输入）

### N3.1 compaction 的预算与触发比：公式归 core · 规模 M

| | |
|---|---|
| **现状证据** | 策略在 Node：`src/agent/compaction-main.js` 的 `getEffectiveInputBudget` / `applyToolSchemaDeduction` / `getCompactionTriggerRatio`；而 core 只接两个算好的数（`crates/dieyun-runtime/src/agent/loop_run.rs:98,262,406` 的 `token_budget` / `trigger_ratio`），Rust 里另有 `loop_run.rs:958` 的 `0.8` 默认 |
| **动什么算完** | Node 改成只传原始事实：`contextWindow` / `maxOutputTokens` / `reserveTokens`；预算公式、地板（`MIN_INPUT_BUDGET_TOKENS`）、工具 schema 扣减、触发比全部在 core 里算；Rust 的 `0.8` 与 Node 的比值常量合成一处。Node 侧同名函数删除 |
| **风险** | `agent.run.*` 是私有契约，一次性升级、不做双协议；但要跑 `npm run test:rust-agent-loop-smoke` + `test:planner-*` 确认三处调用方（主循环 / planner worker / 频道）都走同一套 |
| **验证** | `npm run test:rust-agent-loop-smoke`、`npm run test:rust-planner-smoke`、`npx vitest run test/unit/compaction-telemetry.test.cjs` |

### N3.2 token 估算的用途收敛到 `compaction.estimate` · 规模 S

| | |
|---|---|
| **现状证据** | RPC `compaction.estimate` 已存在（`docs/rpc-catalog.md`，`rust` 提供）；Node 仍自带整套公式（`src/agent/token-estimate.js`），调用方：`src/agent/request-snapshot.js:25`、`src/llm-usage-stats.js:179`、渲染层 `src/renderer/agent/agent-bundle-entry.js:35` |
| **动什么算完** | 能接受一次 RPC 的用途改走 `compaction.estimate`（`request-snapshot` 就是典型）；只有两处保留 JS 实现并写清理由：**渲染层进度环**（不能同步等 RPC）与**无 usage 时的收尾估算**（core 不保证在场）。文件头明确「这是唯一保留的 JS 实现」，公式一致性由 N1.2 的 fixture 兜住 |
| **风险** | 不要把「估算」变成链路依赖：取不到就按现有语义降级（不给值 ≠ 阻塞） |
| **验证** | `npx vitest run test/unit/token-estimate.test.cjs`、`npm run test:request-snapshot` |

### N3.3 索引忽略口径 / 源文件判定 · 规模 M（**先核实再排期**）

| | |
|---|---|
| **现状证据** | `src/index/source-files.js:26`「非隐藏项与 Rust 完全一致，隐藏项只许多不许少」；`src/gateway/rg-search.js:7` 说忽略口径唯一来源是 `index/source-files.js`，与 `crates/dieyun-codebase/src/index/walker.rs` 的 `IGNORE_DIRS` 对齐 —— 即**一处声明、两处实现** |
| **核实步骤（30 分钟）** | ① `rg -n "IGNORE_DIRS" crates/dieyun-codebase/src/index/walker.rs src/index/source-files.js`；② 看 `fs.grep` 走的是 Node rg 还是 core 的 `codebase.grep`（`src/gateway/handlers/fs.js`）；③ 若 grep 在 Node 侧（本地 rg 子进程），那「口径归 Rust」就得连 grep 通道一起动 → 降级为「只做 N1.1 常量共享 + N1.2 fixture」，不做实现搬移 |
| **动什么算完** | 判定归 Rust 一个来源，Node 不再自带判定；**禁止**改成「按文件名关键词猜」 |
| **验证** | `npm run test:local-gateway-smoke`、`npx vitest run test/unit/ignore-rules-parity.test.cjs`（已存在，扩成跨语言 fixture） |

---

## 5. 切片 N4 · 删掉没有调用点的面

### N4.1 新增「渲染层零调用点导出」闸门 · 规模 S · **已完成（2026-11-21）**

| | |
|---|---|
| **现状证据** | `scripts/check-renderer-globals.py` 只查「重名」与「`window.X` 有没有声明」，**不查反向**：一个函数没有任何调用点也能一直绿。`renderer-agent-llm.js`（787 行）、`renderer-agent-loop.js`（351 行）历史上就是靠这种绿灯残留下来的 |
| **动什么算完** | 新脚本 `scripts/check-renderer-dead-exports.cjs`：对 `index.html` 加载的每个脚本的顶层声明做调用点计数（同文件 + 跨文件 + `window.X`），零调用点的列出来；接进 `npm run check:renderer`（先以「报告 + 白名单」形式，清完再转硬失败） |
| **风险** | 动态引用（拼字符串取函数名）会误报 → 白名单要写理由；宁可先报告不拦 |
| **验证** | `npm run check:renderer` |
| **落地记录（2026-11-21）** | 脚本已建（扫描 118 个 `index.html` 脚本；白名单 `scripts/renderer-dead-exports-allow.json`，当前 0 条），已接进 `check:renderer`，**直接以严格模式上线**（先清干净再拦）：同批删掉了 20 处零调用点声明（约 245 行）+ 3 处死 `window.X` 别名。正向对照已验（临时加一个死函数 → FAIL；删掉 → OK）。已知盲区写在脚本头部：`agent-bundle-entry.js` 打进 dist 的那批模块，导出经 `DieyunNamespaces.register({...})` 成对象，对象字面量里出现名字就算被引用，那里判不出死导出。 |

### N4.2 合并 `renderer-agent-api.js`（7 行） · 规模 S（10 分钟） · **已完成（2026-11-21）**

| | |
|---|---|
| **现状证据** | `src/renderer/renderer-agent-api.js` 全文只有一句 `window.cleanupSessionContinueState = cleanupSessionContinueState;`，函数定义在 `renderer-agent-continue.js`；文件名与内容已经对不上（这是 LV 遗留的「API 层」） |
| **动什么算完** | 这行搬进 `renderer-agent-continue.js` 尾部（与 `window.kickGoalTurn` 等同类写法放一起），删文件 + 删 `index.html` 里的 `<script>` |
| **验证** | `npm run check:renderer`、`grep -r cleanupSessionContinueState src/renderer` |
| **落地记录（2026-11-21）** | 文件已删（连 `index.html` 的 `<script>`、`src/renderer/README.md` 一行、`docs/CODEMAP.json` 两处）。那行**没有搬**——`cleanupSessionContinueState` 在 `renderer-agent-continue.js` 里是顶层函数声明（脚本拼接作用域下本来就是全局），`renderer-chat-state.js` 直接按裸名字调它，`window.X` 别名没有任何读者，搬过去只是把死代码换个位置。 |

### N4.3 复核重试层归属（只核不改） · 规模 S

| | |
|---|---|
| **现状证据** | `src/llm-reconnect-retry.js` 是退避唯一来源，`renderer-agent-llm.js:599` 明确「core 不在传输层重试，这里不再复制第二层退避」 |
| **动什么算完** | 确认全仓只有这一处退避实现，写进本文档第 6 节；**不再新增**传输层重试 |

---

## 6. 「判定留在 Node，别再搬」清单（防止下一轮误搬）

| 留在 Node 的东西 | 为什么 |
|---|---|
| `src/gateway/`（工具执行 / 路径白名单 / 沙箱档位） | 工具在宿主执行；搬进 Rust = 重写 16.5k 平台代码 + 把 Electron 能力（Playwright/koffi/ssh2）也搬一遍 |
| `browser/`、`ssh/`、`lsp/`、`mcp/`、`computer/`、`git/`、`channels/`、`peer/` | 生态硬绑定（`playwright-core` / `ssh2` / MCP SDK / koffi / WeCom 长连接） |
| `system-prompt-prep.js`（提示装配） | 需要 skills/MCP（Node）与 memory（core）两边的召回；装配点在宿主是设计选择 |
| `completion-readiness.js`（完成验收） | 证据来自宿主工具 / LSP / 浏览器，判定必须贴着证据 |
| `tool-gate.js`、`guardrails-shared.js`（工具关卡） | 关卡顺序 = 宿主执行流程；`docs/TOOL-GATE.md` 已定 |
| `agent-round-text.js`（交付四态） | AGENTS 原则 5 已定在 Node，Renderer 只展示 |
| `token-estimate.js` 的渲染层用途 | 进度环不能同步等 RPC（N3.2 已收敛其余用途） |
| `llm-reconnect-retry.js` | 退避唯一来源，不许再复制 |

---

## 7. 排期（4 批，每批独立可验收、随时可停）

| 批次 | 内容 | 目标 | 失败成本 |
|---|---|---|---|
| **批 1**（零行为变化） | N1.1 常量数据文件 → N1.2 两条 fixture → N4.2 → N4.1 闸门 | 6 处手抄契约归零；新增 1 条 dead-export 闸门 | 极低（都是机械改动，闸门反向保护） |
| **批 2** | N1.3 `types/core-rpc.d.ts` + 生成闸门 | 「字段靠注释对齐」这类债永久消失 | 低（只加类型检查） |
| **批 3** | N2.1 校验生成 + 双跑对比 | `tool-validate.js` 1128 → <500 行 | 中（先对比再切，可回滚） |
| **批 4** | N3.1 → N3.2 →（核实后）N3.3 | 预算/触发策略与 token 估算归 core | 中高（涉及 core 契约，一次性升级） |

**每批的统一验收闸门**：`npm test` + 该批涉及模块的 smoke + `npm run check:js`；
涉及 `crates/` 再加 `cargo test -p dieyun-core --lib`；涉及 gateway 加 `npm run test:local-gateway-smoke` + `npm run verify:rpc-catalog`。

**不以行数为 KPI**：行数净减是副产品（本清单首批预计 JS −2k~3k），真正的产出是「同一份知识只剩一份，且有闸门锁住」。

## 8. 维护规则

- 做完一条：把「现状证据 → 现在是什么样」，并更新行号（行号会漂）。
- 新发现的双写点：按 N1.1 的格式追加（证据 `文件:行` + 算完 + 验证），**没有证据的条目一律视为未核实**。
- 与 `docs/ARCHITECTURE-DEBT.md` 分工：那边记「哪里还旧」（按债务条目编号 §1–§9），这边记「怎么让 Node 变薄」（按切片编号 N1–N4）。

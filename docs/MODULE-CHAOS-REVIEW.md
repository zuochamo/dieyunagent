# 全仓混乱度审查：两个「极度混乱」模块与重构可行性

审查对象：`src/**`（670 个 js/cjs，约 23 万行）+ `crates/dieyun-core/src/**`（约 1.6 万行）。
方法：客观指标全量扫描（行数 / 函数数 / 最大嵌套 / fan-in / fan-out / 近一年 churn / 测试引用数）→ 5 个子域逐文件读码 + 交叉核对调用方 → 关键结论逐条回到 `file:line` 复核。

---

## 一、结论

**全仓真正「极度混乱」的只有两个模块**（其余是「大而不乱」或「乱但已被单一来源收住」）：

| # | 模块 | 一句话定性 |
|---|---|---|
| **A** | **工具层三件套**：`src/agent/tool-catalog.js` + `tool-bridge-main.js` + `tool-validate.js`（约 5700 行，82 个工具） | **同一件事写三份（schema / 校验 / 执行）且三份会静默分叉**；churn 全仓 agent 代码第一；结果清洗零测试 |
| **B** | **Renderer 的「agent 运行·账本·收尾」子域**（`renderer-agent-rust-loop.js`、`agent/trace-store.js`、`renderer-agent-complete.js`、`renderer-agent-reviewer.js`、`renderer-chat-history.js`，约 1.1 万行） | **越过架构线**：UI 层持有账本写者、第二套完成验收、收尾状态机；且**这一层没有任何行为测试** |

两者可行性判读完全相反，这本身就是最重要的结论：

- **A 可以真要动刀**（数据与执行分离、枚举收敛到单一来源）：先做的一步是 **1 天、0 语义改动、有测试兜住**。
- **B 不能整层重写**，只能「**1 刀结构 + 3 条规则 + 冻结清单**」；真正的回迁（验收判定、运行态、账本）是产品语义变更，必须先定语义再动代码。

---

## 二、体检口径与全仓相对排名

客观指标（`src` 与 `crates/dieyun-core/src`，排除 `dist` / `target`）：

| 模块 | 规模 | 结构 | 语义重复 | 越界 | 测试网 | churn（近一年） | 判定 |
|---|---|---|---|---|---|---|---|
| **工具层三件套** | 5691 行 / 82 工具 | 单函数 1036 行 switch，最大嵌套 9 | **高**：动作枚举 3 份、transport 3 份 | 中（视觉判据、embedding 配置、IPC 直发） | 清洗层 **0** 引用 | **5384 行 / 28 commits**（agent 代码第一） | 极度混乱 ✅ |
| **Renderer agent 子域** | ~1.1 万行（层共 57k） | 单函数 846 行；474 个 `window.X`；123 个 `<script>` | 高：7 份时间格式、2 套滚动跟随 | **高**：账本写者 / 验收判定 / LLM 提示词 / shell 拼接 | **0 行为测试** | `renderer-agent-*` 单文件 6-13 次 | 极度混乱 ✅ |
| Rust `memory/mod.rs` | 3949 行（35% 是测试） | `impl` 单块 1900 行 / 54 方法 | **高但跨语言**：可见行谓词手抄 11 处、标题判据 4 份 | 无 | 42 个测试（真库） | 4720 行 / 21 commits | 乱，但**可机械搬运** |
| Main 装配 + IPC | `main-entry` 1172 行 + 19 个 ipc 文件 / 185 handler | 58 字段 ctx；478 行 handler | 中：桌面/headless 双份装配（**实测 4 处已漂移**） | 中（IPC 层持状态、注册期起定时器） | **0 handler 测试** | —— | 乱，属「欠账」不属「失控」 |
| `src/browser/` | 3106 行 controller + 2187 行 pw | 8 个职责域、38 个隐式状态 | 高：33 个动作双实现、30 个错误码两张表 | 无（AGENTS 规定**已遵守且有测试**） | 只测纯函数 | 3557 行 / 9 commits | 结构性重复，规则未失控 |
| `src/renderer` 其余（chat-history / automation / alive / workspace-ssh） | 4 × 1300–1944 行 | 每文件 9-10 类关注点 | 高（见模块 B） | 中 | 0 | —— | 归入 B 一起处理 |

> 为什么把 `memory/mod.rs` 排除在「两个之内」：它的 3950 行**不是**熵的来源——单 `impl` 分块、同 crate 已有 `misc.rs`/`agent.rs`/`snapshot.rs` 三处先例、42 个真库测试；真问题是「同一语义在 Rust 与 Node 各写一份」。它适合当**第二个修复批次**，不适合当「最混乱」的代表。

---

## 三、模块 A：工具层三件套

### 3.1 混乱证据

| # | 现象 | 证据 |
|---|---|---|
| 1 | **一个动作枚举写三份**：`ssh` 的 8 个动作分别在 schema、校验、执行三处各列一遍 | `tool-catalog.js:2376`（enum）｜`tool-validate.js:446`（allowed 数组）｜`tool-bridge-main.js:617-741`（if 链）；`worktree` 同构（`:2439` / `:415` / `:752-804`） |
| 2 | **三份已经分叉，且分叉是静默的**：`mcp_manage.transport` 的 `http` **能过校验，却按 stdio 执行** | schema 只允许 `['stdio','streamable-http']`（`tool-catalog.js:1834`）；校验多收 `'remote' \| 'http'`（`tool-validate.js:21`）；执行端只认 `'remote' \| 'streamable-http'`（`mcp/manage.js:63`） |
| 3 | **执行分发是 1036 行 switch，全仓没有「工具名 → 执行体」注册表** | `tool-bridge-main.js:546-1581` `executeMainOnlyTool`，24 个 `case`；再接 `delegate-tool-gateway.js:92` 的第二个 switch（57 case / 686 行） |
| 4 | **catalog 名不副实**：除 schema 外还混了 5 类东西 | 82 个 schema（`:24-2499`）+ 模型文案（428 处 `description`，含行为禁令）+ 分组过滤（`:1122-1142`、`:2501-2542`）+ MCP 参数裁剪（`:1885-1952`）+ **弱模型启发式**（`:1867-1883`，判「≤8B / tiny\|nano」，与工具 schema 毫无关系） |
| 5 | **结果清洗零测试**：126 行按工具名硬编码 if 链，每条分支手列字段白名单 | `tool-bridge-main.js:150-275` `sanitizeToolResultForApi`；`scripts/` 全仓 **0** 处引用（虽在 `:1978` 导出「供测试」） |
| 6 | **同一份校验写两遍**：`use_workspace` / `worktree remove` / `goal_start` 在 validate 与 bridge 各拦一次，错误码不同 | `tool-validate.js:473` vs `tool-bridge-main.js:639`；`:432` vs `:771`；`:935` vs `session-goal.startGoal` |
| 7 | **归一化两份，其中一份是死代码** | `guardrails-shared.js:647` 已做别名归一，`tool-validate.js:379-383` 又自带一份 `GRAPH_LEGACY_OPS` |
| 8 | **文档与代码分叉** | `tool-gate.js:22` 声称 `sanitizeToolResultForApi` 在 `guardrails-shared`，实际在 `tool-bridge-main.js:150` |

同时要说清「没乱的部分」，否则重构会把干净的一起动：`tool-gate.js:462-469` 的关卡清单是**真单一来源**（`test-tool-gate.cjs` 72 条断言锁顺序与白名单）；`guardrails-shared.js` 的只读白名单/感知表干净；没有内联 ffmpeg、没有内联请求头、没有「慢就不发」判断。

### 3.2 重构可行性：**可行，且性价比最高**

| 步骤 | 内容 | 改动面 | 工作量 | 风险 |
|---|---|---|---|---|
| **A0 枚举收敛**（先做） | `ssh` / `worktree` 的 allowed 从 catalog enum 派生；`MCP_MANAGE_REMOTE_TRANSPORTS` 收到 `mcp/manage.js` 导出常量；删 `tool-validate.js:379-383` 的重复归一；修 `tool-gate.js:22` 过期注释 | 4 处小改 | 0.5 天 | **低**（顺带修掉 `transport='http'` 静默错分派） |
| **A1 数据拆分** | catalog 按域拆 11 个文件（`browser` 785 行/37 工具、`host` 237、`plan+goal` 322、`mcp` 92、`computer` 88、`peer` 88、`camera` 67、`ssh` 63、`worktree` 63 + `mcp/schema-slim.js` + `catalog-groups.js`），`tool-catalog.js` 退化为 barrel，**导出名一个不改** | 1 → ~11 文件，约 2600 行纯搬迁，9 个 require 点 | 1 天 | **低**：`test-tool-harness.cjs` 有 catalog 结构断言（`BY_NAME`/分组清单），漏搬立刻红 |
| **A2 执行体拆 handler 表** | 24 个 case 拆 `main-tools/*.js` + `name → handler` 注册表；视觉 339 行 → `agent/vision-pipeline.js`；`sanitizeToolResultForApi` 改**表驱动**（每工具一条 `{omit, keep}`）或由 handler 返回 `{payload, media}` 交统一 after 关卡 | 约 1600 行搬迁 + 130 行重写 + 8-10 个新文件；调用点只 4 处 | 3-5 天 | **中**：**前置条件是先补 8-10 个 handler 直测**（ssh/worktree/plan/goal/peer 约 500 行现在零直测） |

**搬错会静默改变行为的 4 个点**（写进 PR 检查清单）：

1. **after 关卡顺序**：`sanitize-result` 必须晚于 `record-browser-screenshot`（`tool-bridge-main.js:1852-1958`）——否则 base64 先被剥离，图永远进不了视觉通道，而模型只会「看不见」，不报错（`:1876-1878` 的注释就是上次事故复盘）。
2. **归一必须先于校验**：`tool-gate.js:164` 用的是归一后的 `call.args`；顺序颠倒则 `write_file`/`graph_callers` 别名绕过校验。
3. **ctx 两处映射**（`harnessCtx` `:1810` 与 `callContext` `tool-gate.js:122`）：漏传 `readOnly/senses/wakePower` = 心跳轮护栏静默失效。
4. **重试语义**：`ToolHarnessSession.execute:167-192` 在同一 `call` 上重试，after 只跑终态一次——别把 after 挂进 handler。

**结论**：值得做。**不做**「整体重写分发」——82 个工具里 37 个是 `browser_*`，执行体本就在 gateway，`delegate-tool-gateway.js` 是薄映射（平均 ~10 行/工具），结构不烂。真正的熵在「文案 + 三份枚举 + 无测的清洗/视觉」。

---

## 四、模块 B：Renderer 的 agent 运行 / 账本 / 收尾

### 4.1 混乱证据

**（1）越界：UI 层在写 Agent 账本与状态机**

| 现象 | 证据 |
|---|---|
| Renderer 是 **Agent 账本写者之一** | `renderer/agent/trace-store.js:49`（`agent.run_upsert`）、`:104`（`agent.trace_save`，status 由 Renderer 传）、`:185-263`（自研 2.5s 节流，注释自述曾把 `trace_save` 打到 45s 超时）、`:279/355/393/418`（interrupted/stopped/failed/recover 四种收尾态由 UI 决定） |
| Renderer 生成 Agent 状态快照并推导终态 | `renderer-agent-loop.js:86-128`（`buildAgentStateSnapshot` 造「暂停/失败/验证/完成」）、`renderer-agent-complete.js:258-264`（`blocked/awaiting_user/pending_apply/completed`） |
| **第二套完成验收**：自写 system prompt 调 LLM，结论并进交付闸门 | `renderer-agent-reviewer.js:235`（Reviewer system prompt）、`:159-190`；`renderer-agent-complete.js:225-235`（→ `status:'blocked'` + 托盘「任务未完成」）。与 `src/agent/completion-readiness.js` 构成双判定 |
| Renderer 直接起 LLM 请求并拼模型可见提示词 | `renderer-agents-md.js:480-495`（`fetchChatCompletion` + `role:'system'`） |
| Renderer 拼 shell 命令并执行 host 进程 | `renderer-dieyun-md.js:165-166`（`cmd /c start "" ${JSON.stringify(path)}` → `gatewayCall('host.exec')`） |
| SSH「连接意图 → 有效参数」在 UI 层解析 | `renderer-workspace-ssh.js:991-1018`（`authType` 由勾选状态就地决定），旁路 `src/ssh/connect-payload.js` |

对照 `AGENTS.md`：第 5 条「禁止 `agent_status` 状态机 / 伪造续跑」、第 4 条「勿在 Renderer 写长期 Agent 状态机」、「完成验收判定唯一来源 `completion-readiness.js`，Renderer 只渲染 note」——**三处越界都是明令禁止的形态**。

**（2）没有模块系统，靠全局名字互调**

- `src/renderer/index.html` **123 个 `<script>`** 顺序拼接；**474 处 `window.X = …`**；`core/namespaces.js` 的 `register()` 默认把每个导出镜像回 `window.*`，于是同一符号长期有两个入口，迁移停在半路。
- 跨文件状态：`sessionActiveRuns` 这一个 `Map`（`renderer-chat-state.js:202`）被 **121 处 / 20+ 文件**直接 `get/set/delete`（`agent-send`、`agent-complete`、`chat-live-run`、`automation`、`browser`、`trace-store` …）。
- 功能级互调环 78 对（`agent-send ↔ composer-queue`、`chat-render ↔ chat-scroll`、`chat-history ↔ chat-state ↔ chat-render`…）。

**（3）零行为测试**

`package.json`：`test:renderer` **就是** `check:renderer`（`check-renderer-globals.py` + `check-renderer-critical.py` + `check-renderer-index-panel.cjs`）——只保证「不重名 + `window.X = fn` 能找到声明」，**不保证任何行为**。57k 行 UI 代码，动作级测试 0。

**（4）同一件事多份实现（抽样）**

| 重复项 | 份数 | 位置 |
|---|---|---|
| 相对时间格式化 | 7 | `chat-history:1094`、`chat-bubbles:87`、`alive:163`、`goal-panel:61`、`scm-pane:502`、`worktrees-settings:40`、`artifacts-panel:95` |
| 滚动贴底/跟随（两套独立状态机） | 2 套 / 25 处 | `chat-scroll.js:14,284,383`（`chatUserScrollSeq`）vs `chat-render.js:14-100,152-218`（`chatBottomFollowRaf`/`dampedChatFollowStep`） |
| toast | 2 + 6 个 pane 私有 hint | `chat-bubbles:745` vs `composer-queue:65`；`automation:53`、`workspace-ssh:616`、`alive:133`… |
| 会话 id 归一文法 | 70 处内联 `String(currentSessionId \|\| '')` | 无 helper |
| 确认框 | 18 处裸 `window.confirm` | 0 封装（而 `showTextPrompt` 反而有单一实现） |

**（5）巨型函数**

`renderer-agent-rust-loop.js:338` `chatCompletionWithToolsViaRust` **846 行**（一轮 agent 运行的整段编排：payload 组装、重试分段、trace 映射、压缩前置、事件订阅）；
`renderer-chat-history.js:1482` `performSwitchSession` **183 行**（切换流水线 + 队列 + 代际 + 占位 + 淡入）；
`renderer-automation.js:484`、`renderer-alive.js:1443`（212 行）、`renderer-workspace-ssh.js:1302`（144 行）同类。

### 4.2 重构可行性：**整层重写不可行，「1 刀 + 3 规则」可行**

**不可行的做法（明确否掉）**：把 Renderer 改成正规模块系统 / 整层重写。57k 行 + 0 行为测试 + 全局命名空间，任何「顺手整理 `windowTray ? …`/顺序依赖」都会变成启动或切会话的静默故障。

**可做的低风险切片（纯重复、零语义，约 6-8 人日）**

1. 7 个时间格式化 + 4 个进度条 + 2 个 toast → `renderer-utils` 一族（1 人日）。
2. 两套滚动跟随合流到 `renderer-chat-scroll.js`（`chat-render` 只留「渲染后请求跟随」一次调用）（2 人日，需人工验证流式与朗读跟随）。
3. 70 处 `String(currentSessionId||'')` → 一个 `curSid()`（0.5 人日）。
4. `renderer-chat-history.js` 一刀切两半：`renderer-chat-list.js`（列表/分组/分页）+ `renderer-chat-switch.js`（切换流水线），`createNewSession` + handoff 另立（2 人日）。

> 注意：`check:renderer` 兜不住行为，所以上面每一条都是**人工回归预算**（发送 / 流式 / 切会话 / 朗读跟随 / SSH 连接 / 计划运行六条清单），不是「测试兜底」。

**3 条规则（能止住恶化，成本≈0）**

1. 新增逻辑一律进 `src/agent/` 经 bundle 注册，**禁止新增 `window.X` 顶层函数**。
2. 会话/运行态只许一个写者（`chat-live-run.js:261` 是雏形），其它模块只读。
3. 账本类 RPC（`agent.trace_save` / `agent.run_upsert` / `agent.plan_save`）只许出现在 `agent/trace-store.js`。

**高风险回迁（先定产品语义，再动代码，15-25 人日）**

| 项 | 为什么高风险 |
|---|---|
| 验收判定回迁 Main（删 `renderer-agent-reviewer.js` 的判定，只留 note） | Reviewer 当前影响交付状态与托盘文案 —— 删了就是**产品行为变更**，必须先回答「Reviewer 还叫不叫验收」 |
| `sessionActiveRuns` 收口成单一 store + 订阅 | 26 文件直改，漏一处表现为「气泡不转 / 进度不动」 |
| 账本写者收口（trace/run/中断修复回 Main） | 横跨 send / complete / resume / chat-live-run 四条链 |
| `chatCompletionWithToolsViaRust` 846 行拆解 | 任何错位都表现为「静默不续跑」 |

**最有收益的第一刀**：低风险第 1+2 条（滚动跟随 + 文案工具合流）。它们是纯重复、被 8 个以上文件依赖，改完立刻缩小「一处修、七处复发」的回归面。**不要先动 `chat-history`**——183 行的切换函数里埋着会话工作空间漂移的历史事故（`renderer-gateway.js:452-456` 注释即事故残留）。

---

## 五、次级候选：结论与最小收敛动作

| 模块 | 判定 | 最小收敛动作（都不改文件边界） |
|---|---|---|
| **Rust `memory/mod.rs`** | 乱，但可机械搬运（3-5 人日） | ①把 `status IN ('active','stale') AND (expires_at IS NULL OR …)` 收成 1 个 SQL fragment（现 **11 处**手抄：`mod.rs:1001,1267,1281,1294,1313,1324,1413,1912,1971,1987`、`misc.rs:213`）；②`title_needs_repair` 收成唯一判据（现 4 份，其中 `[计划]` 判据只在 `:2292`）；③注入阈值 `0.32/0.12` 从 `system-prompt-prep.js:665` 搬进 `agent-limits.js`；④给 `misc.rs` 补 4 个真库测试（该文件现 0 测试，却在改库状态） |
| **Main 装配 + IPC** | 欠账，非失控 | ①S1：`src/ipc/catalog.js` 导出通道常量 + `verify-ipc-contract` 比对 main↔preload（现 205 通道 / preload 238 字面量 / 176 逐字重复 / **0 校验**）；②S2：ctx 按域收窄，缺字段启动即 fail-fast（现 58 字段一个 ctx 转发给 10 个模块） |
| **`src/browser/`** | 结构性重复，规则未失控 | ①统一「失败语义」：`service.dispatch` 一处归一为 `{ok,errorCode,error,retryable}`（现在 controller 返回体、playwright **抛异常**，逼出 3 处特例）；②30 个错误码收进 `error-codes.js`；③超时默认值收一处（现 8000/15000/30000 四处硬编码）；④删死 API `hideForOverlay/restoreAfterOverlay`（零调用者，却是「Main 自己开面板」的遗留后门） |
| `src/mobile/public/app.js`（2103 行 / 162 函数） | 与主仓 Renderer 有同型问题（复制 UI 逻辑） | 不重写；只做「手机端不得自拼合成/选模型/权限判定」三条，共用 `model-settings.resolveTtsApiConfig` 这类已有单一来源 |

---

## 六、附带发现：桌面 / headless 双份装配已经漂移（实测 4 条）

`main-entry.js`（1172 行、63 个本仓 require）与 `headless/boot.js`（501 行）各自手工装配同一批对象（约 15 项），已经产生实测漂移：

1. **能力漏装**：headless 的工具桥没注入 `sshActions` / `worktreeActions` / `createUserSkill` / `plansCreateFromText`（`boot.js:204-220` 无，`main-entry.js:888-914` 有）→ 而 `ssh` 仍在共享 catalog（`tool-catalog.js:2365`）里，headless 永远返回 `SSH_UNAVAILABLE`。
2. **退出漏收**：桌面 `before-quit`（`main-entry.js:1102-1168`）**没有** `sharedMemory.dispose()`，headless 有（`boot.js:459-465`）→ 桌面退出不释放 PG 连接池。
3. **死通道（已删）**：`agent:arbitrate`（`ipc/agent-runtime.js:1042`）在 `preload.js` 里 0 处出口 → `window.diecloud.agentArbitrate` 永远 `undefined`；`docs/DESIGN.md:248` 也已写明「Renderer 侧不再有仲裁弹窗与 IPC 通道」。P0 已把 handler 与那段永远不成立的 Renderer 监听一并删掉。
4. **两条「一轮」的收尾语义不同**：`main-turn-runner.js`（频道 / headless / 定时计划 / 生命感共用）产出 `readiness` 但**没有** `judgeAfterTurn` / `goal.cont`（全仓只有 `agent-runtime.js:535` 有）；而 `AGENTS.md` 把「一轮结束 `judgeAfterTurn`」写成会话目标的单一事实。这需要先判定是**设计（会话目标只服务桌面）**还是**漏装**，再决定改哪一侧。

---

## 七、建议执行顺序

| 批次 | 内容 | 工作量 | 产出 |
|---|---|---|---|
| **P0（已落地，见 §九）** | 模块 A 的 A0 枚举收敛；删 browser 的两个死 API；修 `tool-gate.js:22` 假注释；补 `sharedMemory.dispose()` 进桌面退出；删死通道 `agent:arbitrate` 与无主的仲裁 UI | 已完成 | 消掉 3 处已生效的静默分叉（`transport='http'`、死通道、PG 连接泄漏）+ 1 处文档谎言 |
| **P1（部分落地，见 §十）** | 模块 A 的 A1 数据拆分（已完成）；模块 B 的「1 刀」中的**文案格式合流**（已完成）；3 条规则落文档（已完成）；**滚动跟随合流未做**（给出规格与验证清单） | 已完成 3/4 | churn 最高的文件拆成 12 个域文件；7+4 份文案格式实现合成 7 个规范函数 |
| **P1（1 周）** | 模块 A 的 A1 数据拆分；模块 B 的「1 刀」（滚动跟随 + 文案工具合流）+ 3 条规则落文档 | ~6 天 | 把 churn 最高的文件降冲突面；把「一处修七处复发」压掉 |
| **P2（2-3 周）** | 模块 A 的 A2（先补 handler 直测）；模块 B 的验收判定回迁（**先定产品语义**）；memory 的 4 条收口 | 10-15 天 | 工具层可加动作、可测；Renderer 少一套判定 |
| **P3（择机）** | Main 装配单一来源（`src/app/assemble.js`）+ IPC 通道单一来源；memory 按 6 module 机械搬运 | 8-13 天 | 两个入口不再各写一遍；`impl` 从 1900 行降到 6 个 ~400 行文件 |

**明确不建议做**（会被「减法优先」原则否掉）：

- 把 `browser` 的两个引擎合并成一个 —— CDP 覆盖不到跨域 iframe，Playwright 覆盖不到「用户看得见的窗口里点」，两条路径的存在是真实的，问题只在**实现重复与失败语义不同**。
- 为 Renderer 引入 require/打包化 —— 收益是「阅读」，代价是重排 123 个 `<script>` 的加载序，风险远大于收益；除非同时补行为测试。
- 给工具层新增「注册表 + 钩子框架」—— 现有 `tool-gate.js` 的关卡清单已经是单一来源，再叠一层就是加法反模式。
- 把 `agent-limits.js`（1762 行、fan-in 75）拆开 —— 高 fan-in 是**设计意图**（数字单一来源），拆开等于制造第二真值。

---

## 八、本次未覆盖

`mobile-app/android`、`src/lsp/`（`diagnostics-service.js` 2384 行，结构与 browser 同型）、`src/git/worktree-service.js`、`scripts/`（63 个 test + 打包链）、`crates/dieyun-core/src/index|graph`（`docs/INDEX-VALUE-REVIEW.md` 已单独立项）。

---

## 九、P0 已落地（2026-11-17）

| # | 改动 | 文件 | 语义变化 |
|---|---|---|---|
| 1 | ssh / worktree 的 `action` 白名单不再手抄，改为**从 catalog 的 schema enum 派生**（`toolActionEnum()`） | `tool-validate.js`、`tool-catalog.js`（注释标注它是唯一清单） | 无（清单与旧数组逐字相同）；今后加动作只改 schema + 执行分派 |
| 2 | MCP transport 收成一份：`MCP_TRANSPORT_KINDS`（规范取值）/ `MCP_REMOTE_TRANSPORTS`（入参别名）/ `isRemoteTransport()`，schema enum、校验、落库三处共用 | `mcp/manage.js`、`tool-validate.js`、`tool-catalog.js` | **修掉静默分叉**：`transport='http'` 以前过校验却按 stdio 落库，现在归一到 remote；`url: ''` 不再算「有 url」 |
| 3 | 删掉校验里的第二遍归一（legacy graph op 展开）——归一唯一入口是 `guardrails-shared.normalizeAgentToolName`，由 `tool-gate.js#createToolCall` 调用 | `tool-validate.js` | 无（唯一生产调用方是 gate，进关卡前已归一） |
| 4 | 修 `tool-gate.js` 里「`sanitizeToolResultForApi` 在 guardrails-shared」的过期注释，并写清它与 `record-browser-screenshot` 的先后契约 | `tool-gate.js` | 无（只改注释） |
| 5 | 删死 API `hideForOverlay` / `restoreAfterOverlay`（全仓零调用者的「Main 侧直接改原生视图边界」遗留通道） | `browser/controller.js`、`browser/service.js` | 无（零调用者）；原生视图边界仍只有 `syncBrowserBounds` + `setPanelState` 一条路 |
| 6 | 桌面 `before-quit` 补 `sharedMemory.dispose()`（与 headless 退出链对齐） | `main-entry.js` | **修掉连接泄漏**：退出不再把 PG 会话留给服务端 |
| 7 | 删死通道 `agent:arbitrate` + Renderer 里那段永远不成立的仲裁监听（preload 无出口、HTML 覆盖层根本不存在、`coordinator.arbitrate` 也不存在；`DESIGN.md:248` 早已写明「Renderer 侧不再有仲裁弹窗与 IPC 通道」） | `main/ipc/agent-runtime.js`、`renderer/agent/worktree-ui.js` | 无（该路径从未可达）；仓库与 DESIGN.md 重新一致 |

**回归**（全部通过）：`test:tool-harness`（新增 4 条断言锁住上面第 1、2 条）· `test:tool-gate` · `test:browser-smoke` · `test:mcp-store` · `test:guardrails-sync` · `check:renderer`（459 个 window 导出全部有声明）· `check:js` · `check:contracts` · `npm test`（按 diff 选测）· `test:agent`（全量 smoke）· `build:renderer:dev`（agent-bundle + bundle 重建成功）。

> 环境注记：本机若在 `ELECTRON_RUN_AS_NODE=1` 下跑 `test:lsp`，`childEnvForCommand('npx')` 的断言会红——那是跑测试的 shell 带了 Electron 变量，不是代码问题（清掉该变量即通过）。

---

## 十、P1 已落地 + 未做的那一半（2026-11-17）

### 10.1 模块 A：catalog 按域拆分（已完成）

`src/agent/tool-catalog.js`（2599 行）→ **barrel + 12 个域文件**，导出集合与顺序**一个字没改**（44 个导出键一致，78 个工具的装配顺序逐项核对过），所以 17 个 `require('./tool-catalog')` 调用点全部不用动：

| 文件 | 内容 | 行数 |
|---|---|---|
| `catalog/host.js` | `fs_*` / `host_exec` / `host_proc` / `web_*` | 297 |
| `catalog/browser.js` | 37 个浏览器工具 + 核心/进阶分组 | 811 |
| `catalog/code.js` | codebase / grep / glob / read_symbol / lsp / graph | 172 |
| `catalog/memory.js` | 记忆 / 会话回忆 / 技能增删 / AGENTS.md 提议 | 161 |
| `catalog/plan.js` | `plan_*` / `goal_*` | 308 |
| `catalog/mcp.js` | `mcp_tool_schema` / `mcp_manage` | 93 |
| `catalog/session.js` | `agent_clarify` / `session_*` / `subagent` | 150 |
| `catalog/computer.js` | `computer` / `camera_look` / `desktop_camera_look` | 142 |
| `catalog/peer.js` | `peer_*` | 90 |
| `catalog/remote.js` | `ssh` / `worktree` | 129 |
| `catalog/params.js` | 跨域共用的参数片段（`LOCAL_PATH_HINT` / frame / force / mode / annotate） | 36 |
| `catalog/groups.js` | **装配顺序** + `BY_NAME` + 三个档位白名单 | 69 |
| `../mcp/schema-slim.js`（迁出） | MCP 参数瘦身（`slimMcpInputSchema` / `compactMcpToolDef`） | 72 |
| `tool-model-capability.js`（迁出） | `isWeakToolCallerModel`（与 schema 无关） | 19 |

规矩已写进 barrel 顶部：**加一个工具只改一个域文件**；动作清单只写在 schema `enum`；装配顺序在 `groups.js`，改动按行为改动对待。

### 10.2 模块 B 的「1 刀」：文案格式合流（已完成）

`src/renderer/renderer-utils.js` 成为时间/字节/进度条文案的唯一来源，7 个规范函数：`fmtClock` / `fmtMonthDayClock` / `fmtRelShort` / `fmtRelAgo` / `fmtDateTime` / `fmtBar` / `fmtBytes`。

删掉的重复实现（**11 处 → 0**，输出口径逐一对照过、文本不变）：`formatHistoryTime`(`chat-history`) / `formatMsgFooterTime`(`chat-bubbles`) / `aliveFmtTime`+一处 `formatMsgFooterTime` 调用(`alive`) / `goalTimeText`(`goal-panel`) / `scmRelativeTime`(`scm-pane`) / `formatWorktreeTime`+`formatWorktreeBytes`(`worktrees-settings`) / `formatProductAge`(`artifacts-panel`) / `formatUpdateBytes`+`formatUpdateProgressBar`(`update`) / `formatDeployProgressBar`(`workspace-ssh`)。其中 `formatDeployProgressBar` 与 `formatUpdateProgressBar` 是**逐字符相同的两份实现**。

> **纠错两条**（审计时按名字计数导致的误报）：①`composer-queue` 的 `toast()` 一直是转发 `showAgentToast()` 的**薄封装**，不是第二份实现；②所谓「4 个进度条」里只有 2 个是真进度条，另两个（`formatPrepIndexProgress` / `formatCompactionProgressNote`）是句子构造器，不该合并。

测试侧：新增 `test/unit/lib/load-renderer-fmt.cjs`（把 renderer-utils 装进沙箱取出**真的**格式函数），三个受影响的渲染单测（`products-panel` / `renderer-goal-bar` / `renderer-history-peer-rows`）改为注入真实现，而不是在测试里另写一份。

### 10.3 3 条防回流规矩（已落 `src/renderer/README.md`）

1. 不准新增 `window.X` 顶层函数做新逻辑（新逻辑进 `src/agent/` 或收进已有单一来源文件）；
2. 会话/运行态（`sessionActiveRuns`）只许在 `chat-live-run.js` / `agent-send.js` 写入，其余只读；
3. 账本类 RPC（`agent.trace_save` / `agent.run_upsert` / `agent.plan_save`）只许出现在 `agent/trace-store.js`。

### 10.4 未做：两套滚动跟随合流（**刻意不做，理由与规格在此**）

实际读码后确认这**不是**「一份重复实现」，而是两台不同职责的状态机：

- `renderer-chat-scroll.js`：**用户意图**（`chatUserScrollSeq` / `markChatUserScrollIntent`）、贴底按钮、会话滚动位置存取、follow-settle（`startChatFollowSettle` / `nudgeChatFollowSettle`）、朗读「念到哪一句」的视野跟随（`followChatReadingRange`）。
- `renderer-chat-render.js`：**流式增长的跟随**（`requestChatBottomFollow` / `followChatStreamGrowth` / `dampedChatFollowStep` / `pinStreamingChatToBottom` / `ensureChatScrollAfterLayout`）+ 思考区布局过渡的钉底。

两者都写 `scrollTop`，合并等于重新设计一台「意图/阻尼/朗读/浮动条」统一状态机；而这一层**零行为测试**，验证只能靠手点（流式 + 无极阻尼 + 朗读跟随 + 上滑打断 + 浮条显隐）。在此条件下动手，风险远大于收益 —— 与 §3.2「不要先动 chat-history」同一条理由。

要做的话，最小安全路径（按顺序）：

1. **先补网**：用现有 `new Function` 沙箱手法给「跟随」写纯逻辑测试 —— 把「是否该跟随」抽成纯函数（输入：用户是否在底部 / 本次增长是否自己造成 / 朗读是否在跟 / 结算窗口是否进行中；输出：follow / hold / release），两个文件都调它。
2. **再合流**：`chat-render` 只保留「渲染后请求一次跟随」，其它状态位全部搬进 `chat-scroll`，`chatAutoFollow` 保持唯一跨帧意图位（README「动效」一节已写明它是唯一意图位）。
3. **验证清单**（必须人工过一遍）：流式长回答贴底 / 上滑后不再被拽回 / 无极阻尼开关切换 / 朗读逐句高亮时视野下移、用户一滚即让位 / 「上一问」浮条不闪 / 切会话位置恢复 / 更早历史分页后位置不跳。

### 10.5 回归

`test:unit`（219 文件 / 2139 用例）· `test:tool-harness` · `test:tool-gate` · `test:browser-smoke` · `test:peer-tools` · `test:llm-tool-call-fallback` · `test:mcp-store` · `test:guardrails-sync` · `check:renderer`（465 个 window 导出全部有声明）· `check:js` · `check:contracts` · `npm test` · `test:agent`（全量 smoke）· `build:renderer:dev`（agent-bundle + bundle 重建成功）。

---

## 十一、P2 落地（2026-11-17）：工具层「先补网，再拆执行体」

### 11.1 先补网：`scripts/test-tool-bridge-handlers.cjs`（新增，`npm run test:tool-bridge-handlers`）

覆盖了此前**零直测**的整片区域，24 个 Main 专属工具的执行体 + 出站净化 + 视觉判定：

| 域 | 断言的核心契约 |
|---|---|
| `ssh`（8 个动作） | `connect` 必须带 `remember/useSaved`（少了就永远用不上已存凭据）；首次连接的**指纹必须留在 error/suggestedFix 里**且 `retryable:false`；`acceptNewHostKey` 默认 false；`use_workspace` 缺 `remotePath` 时**不得进入执行体**；`port_forward` 的 `localPort:0`（自动分配）原样传 |
| `worktree`（8 个动作） | `apply_run` 默认 `forceConflict/allowOverwriteMainDirty=false`；`cleanup_run` 默认先存档、不删分支；`prune` 的 `keep` 必须来自参数（省略=0=全删已合并分支） |
| `goal_*` | 无会话 → `NO_SESSION`；计划目标轮里 `goal_start/goal_update` → `PLAN_GOAL_READONLY`；已有进行中目标 → `created:false` 并把现有目标回给模型；**声明了检查却无事实的完成申请必须被打回**且主张仍落库；`goal_check` 走 `host.exec` 并把事实写回目标 |
| `plan_*` | TODO 编号进 text；结构化排期直传（不喂 LLM 解析）；`plan_list` 报声明检查 / 最后一条事实 / 投递会话；无调度器时 `plan_run` 给 `PLANS_UNAVAILABLE`；`plan_cancel` 直传 id |
| 记忆 / `session_recall` | `scope=workspace` 圈定工作空间且不带 sessionId；消息与折叠摘要都标 `kind`；`memory_forget` 用 `archived`（可恢复）而不是删除 |
| `peer_*` | 未启用 → `PEER_UNAVAILABLE`；房间成员显示名字而非 id；租约冲突的持有者走 `diagnostics`（信封会收窄其它字段）；缺对端时把在线对端列给模型 |
| 摄像头 / MCP / 技能 | 摄像头**默认关时先给 `PERMISSION_DENIED`**（不泄露"有没有手机桥"）；本机摄像头的长边/超时来自 `agent-limits`、设备经 `senses` 传；没有 `webContents` 时不装凭据弹窗通道；`skill_create` 后必须通知技能目录变化 |
| 出站净化 / 视觉 | `computer`/`camera_look`/`desktop_camera_look`/`browser_screenshot` 剥 base64 且必须回 `base64Omitted`+`base64Length`；`computer` 只认 `applied === true`、行为字段全保留；`browser_snapshot` 6000 字符截断但**已落盘时不截断**；`isVisionImageReadRequest` 只认整文件 base64 读；预算内不重编码 |
| 注册表完整性 | 注册表必须正好是这 24 个名字，且每个都能在 catalog 里查到（`goal_*` 不在 `ALL_STATIC_TOOLS`，它们由 `renderer-tool-defs` 常驻下发、目标型计划另给一份） |

**顺手抓到并修掉的一个真 bug**：`tool-harness.classifyFailure` 只认 `ok===false && errorCode`，于是 handler 里写清楚的
`MCP_UNAVAILABLE` / `GATEWAY_UNAVAILABLE` / `PLANS_UNAVAILABLE` / `CAMERA_UNAVAILABLE`（都是 `{error, errorCode}` 形状）
全被消息启发式压成 `TOOL_ERROR`/`POLICY` —— 模型分不出「能力没开」和「调用出错」。已改成与抛错分支同一条规则：**有声明用声明**。

### 11.2 再拆执行体：`src/agent/main-tools/`（1036 行 switch → 注册表）

`executeMainOnlyTool` 的 24 个 `case` 拆成 8 个域文件 + 一张注册表，`tool-bridge-main.js` 从 1983 行降到 723 行：

| 文件 | 承接 | 行 |
|---|---|---|
| `main-tools/index.js` | 注册表（`name → handler`）+ 装配**唯一处** | 27 |
| `main-tools/goals.js` | `goal_*` + 移入的 `resolveGoalTarget` / `persistGoalFact` | 298 |
| `main-tools/remote.js` | `ssh` / `worktree` | 203 |
| `main-tools/memory.js` | `session_recall` / `memory_recall` / `memory_forget` | 199 |
| `main-tools/peer.js` | `peer_*` | 186 |
| `main-tools/plans.js` | `plan_*` | 142 |
| `main-tools/mcp.js` | `mcp_tool_schema`（含 `searchMcpToolSchemas`）/ `mcp_manage` | 127 |
| `main-tools/skills.js` | `skill_create` / `skill_delete` / `agents_md_propose` | 65 |
| `main-tools/camera.js` | `camera_look` / `desktop_camera_look` | 41 |

规矩写进注册表注释：**`null` 是协议**（未命中 → 继续走 Gateway 委托，不是失败）；依赖一律经 `shared` 传入、模块内不 `require`，所以可以被单测直接装进沙箱。

### 11.3 这一轮没做（原因）

| 项 | 为什么 |
|---|---|
| **验收判定回迁 Main**（删 `renderer-agent-reviewer.js` 的判定，只留 note 渲染） | **要先定产品语义**：Reviewer 当前的结论会进 `completionGatePassed`，进而决定气泡终态与托盘「任务未完成」。删掉它 = 行为变更，必须由人拍板「Reviewer 还叫不叫验收」；拍板后改动本身约 2-3 天（含把 `renderer-agent-complete.js` 的 4 处落库收口）。 |
| **memory 的 4 条收口**（Rust） | 与工具层无耦合，适合单独一批（1-2 天）：可见行谓词 11 处→1 处、`title_needs_repair` 4 份判据→1 份、注入阈值 `0.32/0.12` 搬进 `agent-limits.js`、给 `misc.rs` 补 4 个真库测试。愿意的话下一批就做这个。 |
| **滚动跟随合流** | 见 §10.4：先补纯函数测试网，再合流。 |

### 11.4 P2 回归

`test:tool-bridge-handlers`（新）· `test:tool-harness` · `test:tool-gate` · `test:fs-edit` · `test:delegate-batch` · `test:mobile-camera` · `test:desktop-camera` · `test:peer-tools` · `test:write-smell-hints` · `test:rust-loop-runner` · `test:unit`（219 文件 / 2139 用例）· `npm test` · `test:agent`（全量 smoke）· `check:js` · `check:contracts`。

> 两处「源码文本断言」的接线守卫（`test-mobile-camera` / `test-desktop-camera`）随着执行体搬家改了指向 —— 这类守卫本身就说明「case 在一个大文件里」是它们的唯一抓手，拆完反而更稳。

---

## 十二、记忆模块收口（2026-11-17，§五「最小收敛动作」已落地）

`crates/dieyun-core/src/memory/` 的四条**同一语义多份实现**全部收成一处；`impl MemoryStore` 的 1900 行单块**没有动**（那是可机械搬运的活，不属于本批）。

| # | 改动 | 位置 | 语义变化 |
|---|---|---|---|
| 1 | 「长记忆现在看得见吗」收成唯一 SQL 片段 `long_mem_visible_sql(alias, now_index)` + `long_mem_alive_sql(alias)`；`status` 允许值收成 `LONG_MEM_ALIVE_STATUSES` | `memory/mod.rs`（新增，替换 **10 处**手抄） | 无（逐处核对过 `?N` 序号与绑定顺序） |
| 2 | 「标题是不是占位/脏值」收成唯一判据 `title_needs_repair`；`touch_session` 里**两段逐字重复的 SQL CASE 删掉**，改为先读后判；`maybe_set_title_from_user_message` 的三条死条件（`!= 新对话` / `!= 对话` / `![计划]`）删掉 | `memory/mod.rs`（touch / maybe_set / 判据本体） | 无（真标题、`[计划]` 标题、`title_source` 都不会被多改；`cargo test` 覆盖） |
| 3 | 记忆**注入**阈值 `0.32 / 0.12` 从调用点搬进 `agent-limits.js`（`memoryInjectMinScoreSemantic/Keyword`，不进设置页 schema，与 `sharedMemoryMinScore*` 并列） | `agent-limits.js`、`system-prompt-prep.js` | 无（默认值相同；今后调阈值只改一处） |
| 4 | `isInjectableMemoryRow` 复用 `project-memory-file.isShareableKind`（secret / private 一条判据管「不进文件 + 不进注入」） | `system-prompt-prep.js` | 无 |
| 5 | 修掉假注释：`MESSAGE_META_STRING_MAX`(100_000) 与 JS `META_STRING_MAX`(20_000) **不是同口径**，写在注释里说清是刻意两级（打包侧拦写、Rust 末道兜底） | `memory/mod.rs` | 无（只改注释，不动值 —— 收紧到 20000 会误删别的写入方的合法长字段） |

**给这次收口补的测试网**（`misc.rs` 此前 0 测试，却在改库状态）：

| 测试 | 守住什么 |
|---|---|
| `title_repair_judgement_lives_in_one_place`（mod.rs） | 占位标题被覆盖 / 真标题与 `title_source` 不被覆盖 / `[计划] xx` 不被新消息改写 |
| `decay_applies_expired_stale_and_archive_rules_independently`（misc.rs） | 过期归档、低价值久未用转 `stale`、40 天那条同一次衰减里直达 `archived`、高价值与 `secret` 永不衰减；并锁死「计数口径是本步改了几行，不是最终状态分布」 |
| `delete_turn_messages_cascades_and_retitles`（misc.rs） | 按 id 删首条用户消息后标题重算、`remove_count` 删最后 N 条、`ai` 标题不被撤回改写、空 sessionId 不静默成功 |
| `list_messages_after_id_pages_and_clamps_limit` / `list_long_memories_after_id_…`（misc.rs） | id 升序分页、`after_id` 开区间、limit 夹取（2000 / 500） |

顺手记两条**别做**的边界（已写进代码注释）：`misc.rs` 的衰减 UPDATE 筛的是「已过期、该归档」，与「还看得见」正好相反，不能并进同一个 helper；`MESSAGE_META_STRING_MAX` 也不能跟 JS 对齐成 20000。

**回归**：`cargo test -p dieyun-core`（**215 passed**，含新增 5 个）· `test:agent-limits` · `test:system-prompt-prep` · `test:knowledge-maintainer` · `test:project-memory-file` · `test:session-context` · `test:unit`（219 文件 / 2139 用例）· `npm test` · `test:agent` · `check:js` · `check:contracts`。

---

## 十三、Reviewer 验收收口（2026-11-17，用户拍板：保留它作为验收的一环）

**决定**：Reviewer 不再被删掉，而是**并入完成验收这条判定链**，判定只在 Main 层一处。

### 13.1 本轮落地（已绿）

| # | 改动 | 文件 |
|---|---|---|
| 1 | 新增 Main 层 `turn-reviewer`：提示词（主判定 + 格式修复两段）、输入装配（`buildReviewerPayload`）、结论整形（`judgeReviewerOutcome` → 与 `evaluateTurnReadiness` 同形状的 `ok/note/reason`）、以及**唯一合并规则** `mergeReviewerIntoReadiness` | `src/agent/turn-reviewer.js`（新） |
| 2 | Renderer 侧删掉自己那份判定：`buildReviewerReadiness` / `resolveReviewerModelForRun` / `shouldRunReviewerValidation` / `buildReviewerBrowserEvidence` 全部消失，改调 agent 层（经 agent-bundle 的 `DieyunTurnReviewer` + compat 镜像） | `src/renderer/renderer-agent-reviewer.js` |
| 3 | 收尾流程不再自己比「谁优先」：`finalReadiness = mergeReviewerIntoReadiness(finalReadiness, reviewer)` —— Reviewer 不通过压过证据判定；原判已不通过时两条 note 都留下 | `src/renderer/renderer-agent-complete.js` |
| 4 | agent-bundle 注册 + CODEMAP / `src/renderer/README.md` / `docs/AGENT-DEV.md` 同步 | 多处 |

**测试**：新增 `test/unit/turn-reviewer.test.cjs`（11 条）锁住四件事 —— 半套配置=没配 / 没有 diff 不跑；payload 与 messages 形状（提示词漂移会直接改变验收结论）；`accepted=false` 的 note 三段（原因/缺失项/下一步）；合并规则三条分支（通过或跳过不动原判、Reviewer 否决压过证据且保留 `evidence`、两边都不通过则 `reasons` 两条都在）。

### 13.2 还没搬的一件事（下一批，需要你点头的只有一处设计）

Reviewer 的 **HTTP 调用**仍在 Renderer，因为它的模型配置（`reviewerEnabled / reviewerModel / reviewerBaseUrl / reviewerApiKey`）只存在 Renderer 的 localStorage 里，Main 手上只有 `model-settings.json` 的 default 档镜像。

要让这条请求也搬进 Main（此后 `renderer-agent-reviewer.js` 整个文件可删），两条路二选一：

1. **Renderer 上报快照**（推荐）：`agent:rust-loop-run` 的 payload 增加 `reviewer` 配置快照（4 个字段），Main 收尾时用它跑 Reviewer。与「Renderer 上报编辑器块/权限快照」同一模式，最小改动、不动设置存储位置。
2. **把 reviewer 配置镜像进 `model-settings.json`**：设置页写入时同时落盘，Main 直接读。好处是 headless / 频道轮也能用 Reviewer；代价是新增一处「设置双写」。

搬完之后的收益：`evaluateTurnReadiness` 直接吃 `reviewer` 输入，一次调用出终局结论，Renderer 侧只剩 `applyReadinessNote` 一行渲染。

**回归**：`test:unit`（**220 文件 / 2150 例**，含新增 11 条）· `npm test` · `test:agent` · `check:renderer`（465 导出全部有声明）· `check:js` · `check:contracts` · `build:renderer:dev`（agent-bundle 重建，含新模块）。

---

## 十四、Reviewer 请求搬进 Main（2026-11-17，用户拍板：配置镜像进 model-settings.json）

§13.2 里悬着的那件事做完了：**Reviewer 从「Renderer 的可选组件」变成「Main 收尾链的一环」**，配置走 `model-settings.json`，没有任何 IPC 侧新增字段。

### 14.1 落地

| # | 改动 | 文件 |
|---|---|---|
| 1 | `reviewerEnabled` / `reviewerModel` / `reviewerBaseUrl` / `reviewerApiKey` 进 `DEFAULTS` + `normalize()`（`reviewerEnabled` 必须 **严格 true** 才开；apiKey 与其它供应商 key 同一存放约定）。设置页保存时随整份 settings 镜像进 Main —— `normalize` 本来就保留未知键，现在把它们变成**显式契约** | `src/model-settings.js` |
| 2 | 新增 Main 侧执行器：`buildReviewerRequest`（端点/请求头只认 `llm-request`）+ `runTurnReviewer`（60s 超时、JSON 模式不支持自动退回、非 JSON 走一次格式修复、任何异常都退化成「跳过验收」） | `src/agent/turn-reviewer-run.js`（新） |
| 3 | `agent:rust-loop-run` 收尾：`evaluateTurnReadiness` 之后跑 Reviewer，`result.readiness = mergeReviewerIntoReadiness(...)` —— 一轮的终局结论**只在这一处定稿** | `src/main/ipc/agent-runtime.js` |
| 4 | Renderer 侧**整份删除**：`renderer-agent-reviewer.js` 消失（index.html 脚本数 117 → 116）、`agent-bundle` 不再打包 `turn-reviewer`（1645.8 → 1613.8 KB）、`renderer-agent-complete.js` 去掉调用块与 `finalReadiness` 覆写，只留 `if (readiness.ok === false) completionGatePassed = false` | `src/renderer/**`、`src/renderer/agent/agent-bundle-entry.js` |

**关键取舍**：Reviewer 的失败/超时/未配置一律 `{ok:true, skipped:true}` —— 验收仍是**提示**，不是交付闸门；但一旦它给出 `accepted:false`，就通过 `mergeReviewerIntoReadiness` 压过证据判定（这正是你要的「作为验收的一环」）。

**副作用（正面）**：Reviewer 现在在 headless / 频道 / 计划轮也能生效（以前依赖 Renderer 的 localStorage + 窗口打开）。

### 14.2 测试

| 文件 | 守住什么 |
|---|---|
| `test/unit/turn-reviewer.test.cjs`（11） | 纯函数侧：配置/触发条件、payload 与 messages 形状、结论整形、合并规则三条分支 |
| `test/unit/turn-reviewer-run.test.cjs`（10） | 执行侧：请求装配（端点结尾、Bearer 头、JSON 模式）、四类跳过（未启用/无 diff/无端点/出错）、JSON 模式不支持自动退回、非 JSON 一次修复、任何异常不抛出 |

**回归**：`test:unit`（**222 文件 / 2160 例**）· `npm test` · `test:agent` · `check:renderer`（465 导出全部有声明；脚本 116 个）· `check:js` · `check:contracts`（含「CODEMAP 引用的文件必须存在」—— 这次正是它抓到了删除后遗留的两处引用）· `build:renderer:dev`。

---

## 十五、`impl MemoryStore` 拆分（2026-11-17，§五遗留的机械搬运）

**做了什么**：把 `crates/dieyun-core/src/memory/mod.rs` 里那块 **1906 行 / 54 方法**的 `impl MemoryStore` 按职责拆成 6 个域文件；`mod.rs` 从 2940 行降到 1599 行（其中 1440 行是测试），域文件 114–642 行。

| 文件 | 行 | 承接 |
|---|---|---|
| `store.rs` | 114 | 开库 / 连接池 / `with_conn` / `read` / embedding 配置 / `PrunePolicy` |
| `session.rs` | 418 | 会话行（标题、工作空间、归档）/ handoff / 消息追加与读取 / 清会话 |
| `longmem.rs` | 592 | 长记忆写入侧（去重 / kind 与重要度归一 / 向量索引与重建） |
| `recall.rs` | 639 | 长记忆读侧（FTS / 关键词 / 语义召回 + 可见性谓词 + 打分分页） |
| `archive.rs` | 280 | 压缩归档 + 跨会话正文/折叠片检索 |
| `meta.rs` | 224 | `【叠云meta】` 打包清洗剥离 + 标题判据 |
| `misc.rs` | 642 | 维护（撤回 / 自愈 / 归纳作业 / 衰减）+ **移入的 6 个剪枝任务** |

**做法与纪律**：纯机械搬运 —— 一行 SQL、一个条件都没改；靠行区间切片 + `use super::*;`（等价于拆分前同模块可见性）+ `pub(crate) use <域>::*;` 重新导出（名字集合不变）。**唯一判据是 `cargo test -p dieyun-core`：215 passed（与拆分前一致）**。

**过程中踩的三个坑（都记在代码/脚本注释里）**：
1. **括号计数要跳过字符字面量**：`t.starts_with('{')` 这种 `'{'` 会让切片器的 `{}` 计数失衡，症状是「后面的函数全都找不到」（一眼看不出根因）。
2. **`#[derive(...)]` 行会丢**：按「文档注释向上扩」的方式取 item 区间时，`#[derive(Clone)]` 不在注释里 → `MemoryStore` 少了 `Clone`，`rpc` 侧 `self.memory.clone()` 直接编译失败。
3. **`cargo fix` 只按 lib 目标清 import**：它看不见 `#[cfg(test)]` 里的用法，会把测试要用的 `params` / `Connection` / `json` / `CoreError` 一并删掉 → 测试目标编译失败。补救是在 `mod tests` 里显式列出这几项（并注释清楚原因）。

**当前告警**：`dieyun-core` 6 条 warning（3 条为 test-only 助手在 lib 目标下「never used」的既有形态），没有新增功能性问题。

**回归**：`cargo test -p dieyun-core` **215 passed** · `npm test`（按 diff 选测）· 其余 JS 套件不受影响（纯 Rust 侧改动）。

---

## 十六、自查（三份独立审查 + 自测）修掉的 bug

提交后做了一轮针对性审查（工具层 commit / 渲染+记忆 commit / Reviewer commit，各一份独立报告），**修掉 11 处**，其中 4 处是「会出错但很安静」的那类：

| # | 问题 | 后果 | 修法 |
|---|---|---|---|
| 1 | `main-tools` 注册表用裸对象查表 | 模型发 `toString` / `constructor` / `__proto__` 会命中 `Object.prototype` 并被当 handler 执行（旧 switch 会回「未知工具」） | 注册表改 `Object.create(null)` |
| 2 | Reviewer 从账本取 diff 只认 `toolArgs` | Rust `TraceTool` 用 `args` → 改动文件恒为空 → **Reviewer 每轮都 skip**，且 reason 报成「用户没开」 | `reviewerToolPath` 兼认 `toolArgs`/`args`，diff 再兜 `result.diff` |
| 3 | `agent-runtime.js` 写了 `log.info` | 该文件无 `log` → 只在错误分支抛 `ReferenceError` → 被 catch 吞掉，验收失败零日志 | 改 `console.warn` 包一层 try |
| 4 | 语义召回 SQL 参数绑反（`?1`=模型签名、`?2`=scope，代码写成 `params![scope, sig]`） | 项目级记忆的**语义召回恒为空**（两个都是 TEXT，不报错）→ 只能靠关键词通道；`near_duplicate` 也找不到近重复 | 改 `params![sig, scope]` |
| 5 | `maybe_set_title_from_user_message` 删 `[计划]` 条件时判成「死条件」 | 实际不是：旧代码里该合取项为假 → 会**覆盖**计划抬头。删掉后计划会话永远顶着 `[计划] xxx` | 显式恢复「内部抬头要被洗掉」，并改正注释 |
| 6 | `renderer-agent-complete.js` 让**任何** readiness 不通过都翻交付闸门 | 与 `completion-readiness` 的定位（只提示、不挡交付）冲突：日常跑一个失败的验证命令就会把托盘翻成「任务未完成」 | 只在 `reason === 'reviewer_validation_failed'` 时翻 |
| 7 | Reviewer 的格式修复请求又开 `response_format` | 走到修复恰恰常因端点不认它 → 修复必失败、兜底形同虚设 | 修复请求改 `jsonMode:false`；退回请求补 null 判 |
| 8 | `fmtClock(meta.ts)` 丢了 `|| Date.now()` 回退 | 缺 ts / 非数值时页脚渲染成空（旧版显示「现在」） | 调用点补回退 |
| 9 | `renderer-alive.js` 又内联了一份 `toLocaleTimeString` | 同 commit 刚立的规矩自己被破，下次收口必漏 | 改 `fmtClock(Date.now())` |
| 10 | barrel 死导入 `SESSION_RECALL_TOOL`；`skills.js` 用 `deps.userDataPath` 而不用注入值 | 前者白加载；后者用 `{}` 构造 bridge 时 TypeError | 各改一行 |
| 11 | 文档 4 处仍指向已删除的 `renderer-agent-reviewer.js`（README / AGENT-DEV / AGENT-STRATEGY / HARNESS-INVENTORY + 一份 plan） | 「索引里有个不存在的文件」，后人按图索骥会撞空 | 改指 `agent/turn-reviewer*.js` |

**补了 2 条回归测试**（这两处 bug 之前都没有网）：账本形状的 trace 必须能推出改动文件；注册表不能被原型链键骗过。

### 已知但**没修**的（要么是你工作区里的改动，要么需要单独设计）

| 项 | 判断 |
|---|---|
| 心跳轮 `wakePower` 硬闸门（`tool-gate.js` 五类 `WAKE_*` 失败）、`computer`/`host_exec` 新增 `local`/`target` 参数与 13 处工具描述改写 | **是工作区既有改动**（alive 那批）随重构一起入库，不是本次重构引入；但提交说明里没交代，review 时容易被当成纯搬家放过 —— 已在此登记 |
| `wakeRoot` 缺省时以 `process.cwd()` 为可写根 | 同上（既有）：心跳轮 `workspacePath` 为空时允许写的根会落到程序目录，属静默放宽，建议单独修 |
| 语义召回通道没有过期判定（`m.status = 'active'`），词法通道有 | 既有不一致：已过期但未被衰减归档的记忆还能被语义注入。属「看得见吗」第二套集合，建议下一批收口 |
| `touch_session` 由单条 upsert 改为「先 SELECT 再分支写」 | 跨进程理论上有 TOCTOU（同进程有写连接互斥锁）；标题字段、影响极小，已在代码里注明 |
| Reviewer 从账本只能拿到**文件路径**，拿不到 diff 正文（`fs_edit` 的返回值里没有 diff） | 目前会让 Reviewer 在「改了哪些文件」这一层工作；要拿到 diff 需把会话改动账本从 Renderer 上报或在 Main 侧算 git diff —— 属独立设计 |

**回归**：`cargo test -p dieyun-core` 215 · `test:unit` 2160 · `npm test` · `test-tool-bridge-handlers` · `check:renderer` · `build:renderer:dev` 全绿。

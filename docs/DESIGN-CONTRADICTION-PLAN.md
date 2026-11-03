# 设计逻辑矛盾整改计划

> 来源：`issue` 之外的全仓审计（12 子域并行 + 逐条双边证据核对，共 21 条确认矛盾）。
> 目标：**每个事实只有一个来源**，用「删掉第二份实现」而不是「加同步/加开关」来修。
> 约束（AGENTS.md）：减法优先；数字上限只改 `src/agent/agent-limits.js`；工具关卡顺序只改 `src/agent/tool-gate.js`；不新增降级层/兜底层/开关。

## 0. 全景：21 条 → 5 类根因

> **进度**：批次 B 全部完成；批次 C 完成 4/7（C1、C3、C4、C5），C2/C6/C7 延后（各自缺一个产品/架构决定，见 §7）。批次 A/D/E 未开始。见 §7「执行记录」。

| 根因 | 条目 | 修法一句话 |
|---|---|---|
| R1 跨语言第二份数字/标记 | 1 摘要标记、2 轮次上限、21 看门狗阈值 | 内核不留默认值，必填由 Node 唯一填参口给 |
| R2 同一条规则两处各判一次 | 3 完成验收、7 shell 审批粒度、14 续跑词表 | 判定收敛到一处，另一侧只消费结论 |
| R3 写入/出口有旁路 | 5 工作空间绑定、12 远端读写、9 能力门控 | 全部改调既有单一实现/适配器 |
| R4 「多大/多少个」两套阈值或清单 | 8 工具名白名单、10 结果阈值、16 向量阈值、18 可写根、19 trace 副本、11 系统提示装配 | 从既有单一来源派生，删副本 |
| R5 文档/注释与代码相反 | 13 关卡清单、17 NULL 语义、15 TTL 文案、20 基线阻塞、4 secret 记忆丢失 | 有的只改文档，有的是代码缺行为 |

条目编号沿用本轮审计清单（1–21）。

---

## 1. 批次划分

| 批次 | 主题 | 条目 | 依赖 | 预估 | 提交粒度 |
|---|---|---|---|---|---|
| **A** | 内核与 Node 的"唯一数字/唯一标记" | 1、2、21 | 需 `pack:dieyun-core` | 1.5 天 | 1 PR（Rust+Node 必须同一提交） |
| **B** | 数据与安全正确性（纯 Main/JS） | 4、7、5 | 无 | 1.5 天 | 1–2 PR（5 与 7 分文件，可一起） |
| **C** | 单一来源回收（删副本） | 8、9、10、16、18、19、11 | C 前需先确认 3 个事实（见 §4） | 3 天 | 按子系统拆 3–4 PR |
| **D** | 契约/交互变更 | 3、20、14、15 | 3 依赖 C 的 19 | 2 天 | 3 单独 PR；20/14/15 合并 |
| **E** | 需先实测才能定 | 复现 3 条（§5） | 无 | 0.5 天 | 只提交复现脚本/结论，不盲改 |

批次顺序按"价值 ÷ 风险"：A 修的是**会算错**跨语言契约；B 修的是**会丢数据/越过审批**；C 只删副本（行为不变，好回滚）；D 才动契约；E 不承诺改动。

---

## 2. 逐批次执行清单

### 批次 A：内核里没有第二份数字

统一手法：**参数必填 + 缺参报错**，不做 `.max(1)` / `|| 96` 这类兜底。

- [ ] **A1 · #2 planner 轮次上限**
  - 权威侧：`settings.agentMaxRounds`（默认 500，`model-runtime-presets.js`）。
  - 改动：`crates/dieyun-core/src/planner/types.rs` `PlannerStartParams` 加必填 `max_rounds`；删 `planner/run.rs:342`（explore 24）与 `:1005`（worker 96）；`src/agent/rust-planner-runner.js:462-466` 改为走同一填参口（`loopSpec.maxRounds`），不再让 `spec.maxRounds` 覆盖 settings。explore 若确需更窄预算 → 在 `agent-limits.js` 加具名键（如 `plannerExploreMaxRounds`），**不在 Rust 写字面量**。
  - 验收：`npm run cargo:test`、`npm run pack:dieyun-core`、`npm run test:rust-planner-smoke`；新增断言「settings 设 15 轮时 worker 子循环收到 15」。
- [ ] **A2 · #1 压缩摘要标记**
  - 权威侧：`src/compaction-prompts.js:73` 的 `COMPACT_PREFIX`（文案唯一来源）。
  - 改动：Rust 不再比对文案 —— `CompactionPrompts` 增加由 Node 传入的 `digestMark`（或给 digest 消息加 `digest: true` 结构字段），`atoms.rs:85/153/160` 的 `contains(COMPACT_DIGEST_MARK)` 全部改为该判据，删 `COMPACT_DIGEST_MARK` 常量。
  - 验收：`cargo test -p dieyun-core`；新增单测「连续压缩两次后，reassemble 结果里摘要消息仍为 1 条」（现在没有这条断言，正是它让两边漂了）。
- [ ] **A3 · #21 看门狗阈值**
  - 改动：删 `src/agent/rust-loop-runner.js:601/603` 的 `5 * 60 * 1000` / `45 * 60 * 1000` 兜底，缺参直接抛错（调用点 `:681` 已必传 `stallLimits`）。
  - 验收：`npm run test:unit`（`run-stall-watchdog.test.cjs`）。
- [ ] **A4 · 横向防漂（并入既有 `scripts/check-repo-contracts.cjs`，不新建机制）**
  - 断言 1：`crates/dieyun-core/src/planner/run.rs` 里不出现 `"maxRounds":` 字面量。
  - 断言 2：`crates/dieyun-core/src/compaction/` 里不出现中文摘要文案字面量。

### 批次 B：数据与安全正确性

- [ ] **B1 · #4 secret/private 记忆被高 importance 抢道**
  - 改动：`src/agent/knowledge-maintainer.js:422` 删 `|| Number(item.importance) >= 4`，落点只由 `scope` 决定。
  - 补观测：`skipped` 计数进日志（现在被丢弃是静默的）。
  - 验收：`npm run test:knowledge-maintainer`、`npm run test:project-memory-file`；新增断言「`scope=global` + `kind=secret` + `importance=5` → 落库、不进文件」。
- [ ] **B2 · #7 shell 越界审批的目录粒度**
  - 改动：`src/gateway/handlers/host.js:59-62` 把 `decideShellCommand` 已算出的越界路径作为 `ctx.path` 传给 `sandbox.guard`，删掉"无路径 → 类别级 `-`"的隐含退化（`-` 只留给 network / os-control）。
  - 验收：`npm run test:sandbox-smoke`、`npm run test:sandbox-gateway`、`npm run test:sandbox-policy`；新增用例「批准写 `D:\a` 后再对 `D:\b` 执行同类 shell 写 → 必须再问」。
- [ ] **B3 · #5 会话工作空间绑定旁路**
  - 改动：三处改为调用 `bindSessionWorkspace()` —— `src/agent/service.js:257/264`、`src/session/session-worktree.js:194-200`、`src/main/ipc/workspace-remote.js:46-52`；Renderer 的 `src/renderer/renderer-composer.js:766` 改为走"用户切工作空间"的既有 IPC（Renderer 不直接写会话行）。
  - 验收：`npm run test:unit`（`session-workspace-binding`、`memory-session-workspace`、`renderer-session-workspace-tool`）、`npm run test:mobile`（外部提交入口）、`npm run test:agent`。

### 批次 C：单一来源回收（行为不变，删实现）

- [x] **C1 · #8 工具名白名单**：删 `src/llm-tool-call-fallback.js` 手抄的 `TOOL_PARAM_NAMES`（49 项，真实工具 77 项，缺 32），改由 `tool-catalog.ALL_STATIC_TOOLS` 派生（+3 个执行端仍认、但没进 schema 广告位的历史名）。验收：`test:llm-tool-call-fallback`（新增「目录里每个工具名都能被识别成工具调用」，并点名 `subagent/plan_create/memory_recall/session_set_workspace/peer_send/ssh/worktree` 这 7 个旧表缺的名字）、`test:guardrails-sync`、`test:unit`。
- [ ] **C2 · #9 能力门控（延后，见 §7「延后的三条」）**：`osControl` / `browserAutomation` / `webFetch` 并入 `guardrails-shared.PERMISSION_GATED_TOOLS`，Gateway 只留"服务是否就绪"。
- [x] **C3 · #10 结果阈值**：`tool-output-spill.js` 的 `8192` 移进 `agent-limits.js:toolSpillCharThreshold`（唯一来源），`session-context.js` 的 8 个 `14000/96000/…` 兜底字面量删除、缺键改为**抛错**。验收：`test:tool-harness`（新增「落盘阈值 < 截断上限」「不到阈值不落盘」「越过阈值才落盘」）、`test:session-context`。
- [x] **C4 · #16 向量阈值**：`memory/mod.rs` 的 `0.05` 改用 `embedding::MIN_SIMILARITY`（常量从 `index/vector_pool.rs` 上移到 `embedding/mod.rs`，两个子系统共用）。验收：`cargo test -p dieyun-core --lib -- memory vector`（47 项）、`npm run cargo:test`。
- [x] **C5 · #18 `%TEMP%` 可写根**：新增唯一组装点 `server.js:writableRootsForMode()`，`_collectWritableRoots()` 与 `sandboxContext()` 都从它取（含各自的档位语义），删掉两处重复拼接。验收：`test:sandbox-gateway`（新增「workspace-write 下 fs / shell 写临时目录都不问」「read-only 下临时目录也要问」，并已验证不修则第一条失败：`temp write must not ask in workspace-write, got 1 asks`）、`test:sandbox-policy`、`test:sandbox-smoke`、`test:local-gateway-smoke`。
- [ ] **C6 · #19 synthesis trace 副本（延后，见 §7「延后的三条」）**：删 `renderer-thinking-trace.js` 的 `SYNTHESIS_TRACE_PHASE` 与 `upsertSynthesisTraceRound`，渲染改吃事件里的 `ev.data.trace`。
- [ ] **C7 · #11 计划 system prompt（延后，见 §7「延后的三条」）**：删 `plans/plan-agent-runner.js` 手拼，复用 `system-prompt-prep-main` 的装配。

### 批次 D：契约/交互变更

- [ ] **D1 · #3 完成验收单一判定者（单独 PR）**
  - 方案 A（推荐）：Reviewer 挪进 `completion-readiness.js` 作为一个可选证据源；`renderer-agent-complete.js:226-237` 整段删除，`completionGatePassed` 由 `readiness.ok` 单一派生。
  - 方案 B：Reviewer 整体删除（默认就关，价值未证实）。
  - 验收：`npm run test:unit`（`completion-readiness`）、`npm run check:renderer`；补断言「Main 判 ok:false 时 status 与 readiness 一致」。
- [ ] **D2 · #20 目标型基线阻塞**：`src/main/mcp-plans-boot.js:393` 分支改为"基线不可用（blocked-approval / 超时）也停"，复用 `decideContinuation` 的 `blocked` / `no-verify` stop 值，不新增分支。验收：`test/unit/mcp-plans-boot.test.cjs` 新增"基线被拒 → 不开跑 + 停用"（现用例只覆盖"验收被拒"，见 `:460-486`）。
- [ ] **D3 · #14 续跑词表**：删 `renderer-agent-send.js:56-59` 与 `renderer-composer-queue.js:874` 的三词判断，改由 `hasAgentContinueCheckpoint(sessionId)` 单一入口决定。验收：`npm run check:renderer`。
- [ ] **D4 · #15 审批 TTL**：删 `GRANT_TTL_MS` 与两处过期判定，保 `clearSession` + 档位收紧清空；UI 文案与模块注释统一为一种表述。验收：`npm run test:sandbox-gateway`。

### 批次 E：先实测再决定（不承诺改动）

见 §5。产出是复现步骤 + 结论，再决定是否立条。

---

## 3. 每批次完成标准

1. 该批次条目在本文档打勾，并注明"删掉了哪一份实现"（不是"加了对齐逻辑"）。
2. `npm test`（按 diff 选测）通过；跨语言改动另跑 `npm run cargo:test` + 对应 rust smoke。
3. `AGENTS.md` 对应行与新事实一致（唯一来源清单不新增"两份"）。
4. 若出现"两处都能改、改哪边都行"的情况 —— 说明还没找到单一来源，回到减法重想。

## 4. 开工前必须确认的三个事实（各 10 分钟）

1. **#9 的缺键默认**：`permissions-store.js` 是否把 `browserAutomation` / `webFetch` / `osControl` 写进持久化默认值。若"缺键"实际不可达，C2 才安全；否则先补默认写入，再切默认语义（否则等于偷偷改用户权限）。
   - **结论（已查）**：`permissions-store.js:DEFAULTS` 显式含 `webFetch: true` / `browserAutomation: true` / `osControl: true` / `camera: false`，且 `normalizePermissions()` 每次都先铺 `...DEFAULTS` 再铺存储值，`loadPermissions()` 也走它 —— **缺键不可达**。所以 `perms.camera !== false`（缺键=开）与 `perms.osControl` 真值判定（缺键=关）的差异在实践中观察不到，C2 的安全前提成立。
2. **#19 事件是否已带 trace**：确认 rust-loop 路径的 `synthesis_start/done` 事件里 `trace` 字段非空；为空则 C6 需先补事件，不能直接删 Renderer 副本。
   - **结论（已查）**：`agent-synthesis.js:183` 起 `onPhase('synthesis_start'|'synthesis_done', { …, trace: upsertSynthesisTraceRound(...) })`，事件**确实带 trace**。但 Renderer 那份不只是复制常量，它还在 `displayedTrace` 上合并实时 UI 字段（`visibleContent`、`answerPhase`、`checkpoint`），直接改吃 `ev.data.trace` 会用 Main 的静态快照覆盖这些字段 —— 属"需要开应用肉眼验证"的改动，见 §7。
3. **#11 计划轮 prompt 体积**：接 prep 后计划轮 system prompt 会显著变大（AGENTS/记忆/MCP），要确认 `getEffectiveInputBudget` 下不会刚开场就触发压缩。
   - **结论（已查）**：现状 `plans/plan-agent-runner.js` 手拼的是「身份 + 计划角色 + 工作区 + dieyun 块 + dieyun.md(≤8000) + 技能块 + 本次任务(≤4000)」，**不含** AGENTS.md / 记忆召回 / MCP 目录 / 代码库召回。接 prep 会把这几块全带上，体积与行为都变 —— 见 §7。

## 5. 待实测的三条（结论出来再定）

| # | 疑点 | 复现方式 | 判据 |
|---|---|---|---|
| E1 | `renderer-thinking-trace.js:387` `if (content && !hitRoundLimit)` 是否吞掉 `reasoning-fallback` 正文 | 造一轮 `hitRoundLimit`（预算截断且只有思考） | 正文区是否出现带标签的思考引用 |
| E2 | 转写选型两套（`model-settings.resolveSpeechApiConfig` vs `renderer-model-capabilities.getSpeechApiConfigFromSettings`） | 只在供应商里配 `speech` 模态模型（不填 `speechWhisperModel`），桌面与手机各发一次语音 | 两端请求的 model / baseUrl 是否一致 |
| E3 | `renderer-agent-continue.js:8` 把续跑 payload 放在渲染内存 | 触发 continuation 后刷新窗口再点"继续" | 续跑点是否丢失 |

## 6. 不做（已排除，避免重复讨论）

- `agent-limits` 里不进 schema 的 `readiness*` 预算 —— 注释给了理由，成立。
- Rust 交付闸门 vs `agent-round-text` 四态 —— 两边口径一致。
- `tool-result-cap`(14000) / spill / 预览三层截断 —— 若 C3 合并为一个阈值则只剩"落盘 + 预览"两层，仍不算矛盾。

## 7. 执行记录

### 批次 B（已完成）

| 条目 | 改动 | 删掉的第二份实现 | 验证 |
|---|---|---|---|
| **B1 · #4** `secret/private` 被 `importance>=4` 抢进项目文件后丢弃 | `src/agent/knowledge-maintainer.js:421-427` 落点只由 `scope` 决定 | 删掉「importance 改写落点」这条隐式规则 | `node scripts/test-knowledge-maintainer.cjs`（19 项全过，含新增「scope=global 的 secret 落库、绝不进 memory.md」） |
| **B2 · #7** shell 越界审批退化成类别级 | `src/gateway/sandbox-policy.js` `decideShellCommand` 的两个 `ask` 分支补结构化 `path`；`src/gateway/handlers/host.js:59-67` 把它传给 `sandbox.guard` | 删掉「无 path → `scopeOf(undefined)='-'` 类别级」的隐含退化 | `node scripts/test-sandbox-gateway.cjs`（新增「7c 换个目录必须重新问」；**已验证不修则失败**：改回 `path:''` 时该用例报 `got 1 asks`）+ `test-sandbox-policy` / `test-sandbox-smoke` |
| **B3 · #5** 会话工作空间绑定三处旁路 | 不变式上移到唯一写入口：`src/gateway/handlers/memory.js` `memory.session_workspace_set` 写完会话行即 `ctx.setSessionWorkspaceContext`（依赖由 `src/gateway/server.js:_refreshHandlers` 注入）；`src/agent/session-workspace-bind.js` 收敛为「只调这一个 RPC」；`src/agent/service.js:256-266`、`src/session/session-worktree.js:193-201`、`src/main/ipc/workspace-remote.js:44-53` 全部改调 `bindSessionWorkspace` | 删掉「各调用方自己写内存 / 自己写库」的 5 份副本（含 `session-worktree.js` 手抄的两处写） | `npx vitest run`（`session-workspace-binding` 14、`session-worktree` 11、`memory-session-workspace` 10（新增 2 条不变量用例）、`channels-workspace-switch` 9 全过）；`node scripts/test-session-remote-transport.cjs`、`npm run test:mobile`、`channels-core/turn` 全过；`npm run check:js` 通过 |

**B3 的行为变化（有意为之）**：`bindSessionWorkspace` 先落库再更新上下文，Rust 落库失败时**不再**留下「只有内存」的半份绑定（旧实现是先写内存、库失败也算成功）。`session-worktree.test.cjs` 原先断言的「本模块直写内存」已改成断言「不直写内存，只走唯一入口」。

**测试基线提醒（与本次改动无关，属工作区里已有的未提交改动）**：`npm run test:unit` 现有 9 条失败，全部在 `test/unit/readiness-note-toggle.test.cjs` / `readiness-note-dedupe.test.cjs`。原因是工作区里 `src/renderer/agent-guardrails.js` 的未提交改动让 `applyReadinessNote` 依赖 `AgentRoundText.TURN_EMPTY_REPLY_TEXT`，而这两个用例的 vm 沙箱只注入了 `GuardrailsShared` / `getAgentLimits` / `tracePrefs`。修法是把 `AgentRoundText` 注进沙箱（属那条 WIP 的范围，本次未动）。

> 批次 C 收尾时复跑：`test/unit` 已 **172 文件 / 1684 用例全绿**（上述 9 条在同一工作区里被其 WIP 修掉了，与批次 B/C 改动无关）。

**工作区并行改动提醒（已收尾）**：工作区里另一条 WIP 把 `withTimeout` 抽成了新文件 `src/timeout.js`，`system-prompt-prep.js` / `tool-bridge-main.js` 已改 require 它。中途 `test/unit/remote-pack-requires.test.cjs` 报过 `missing: ["src/timeout.js"]`（正是该用例存在的意义 —— 2026-10-18 `spawn-args.js` 同一类事故形态）；**该 WIP 随后自己把 `'src/timeout.js'` 补进了 `src/remote/remote-pack-layout.js:REMOTE_GATEWAY_SOURCE_PATHS`（带注释）**，`npm run test:remote-pack` 现已通过。`src/json-file.js`（同批新增）只被 `deploy-config` / `mcp/catalog` / `skills/catalog` 使用，不在远端闭包里，无需入清单。
- 已执行的收尾：`npm run pack:remote-gateway` 重打 `build/remote-gateway-pack`（现含 `timeout.js`，mtime 09:05）。
- **仍红但与本仓代码无关**：`npm run verify:remote-pack` 检查的是 `dist/win-unpacked/resources/remote-gateway-pack`（上一次 electron-builder 产物，2026-11-02 14:24），它天然不含新文件 —— 只有下一次 `npm run build:nsis` 才会刷新（且需要 `npm run pack:dieyun-core:linux` 的 Linux 二进制）。
- **环境坑（不是回归）**：本会话父进程带 `ELECTRON_RUN_AS_NODE=1`，于是 `test:lsp` 里 `childEnvForCommand('npx').ELECTRON_RUN_AS_NODE == null` 这条断言必然失败。清掉该变量后 `test:lsp` 通过（已验证）。跑全量 smoke 时请先 `Remove-Item Env:ELECTRON_RUN_AS_NODE`。

### 批次 C（4/7 完成，3 条延后）

| 条目 | 改动 | 删掉的第二份实现 | 验证 |
|---|---|---|---|
| **C1 · #8** 工具名白名单 | `src/llm-tool-call-fallback.js` 的 `TOOL_PARAM_NAMES` 改为从 `tool-catalog.ALL_STATIC_TOOLS` 派生；`exec` 不用列（`TOOL_NAME_ALIASES` 已归一），只留 3 个"执行端仍认但没进 schema"的历史名 | 删掉手抄的 49 项 Set（缺 32 个真实工具） | `test:llm-tool-call-fallback`（新增「目录里每个工具名都能被解析成工具调用」+ 点名 7 个旧表缺失名）、`test:guardrails-sync`、`test:unit`、`browser-tool-gaps`。**证据**：`git show HEAD` 的旧表 49 项里，这 7 个名字全部 MISSING —— 旧代码确实解析不出 |
| **C3 · #10** 结果阈值 | 新增 `agent-limits.js:toolSpillCharThreshold: 8192`（含"必须小于 `toolResultMaxJson`"的不变式注释）并让 `tool-output-spill.js` 读它；`session-context.js` 的 8 个兜底字面量全删，`completionCapDefault()` 缺键改为抛错 | 删掉 `8192` 与 8 个重复字面量（`14000/96000/8000/24000/32000/800000/24/12000`） | `test:tool-harness`（新增阈值不变式 + 阈值两侧边界）、`test:session-context`、`test:agent-limits` |
| **C4 · #16** 向量阈值 | `MIN_SIMILARITY` 从 `index/vector_pool.rs` 上移到 `embedding/mod.rs`（`pub`），`vector_pool.rs` 改 `pub(crate) use`，`memory/mod.rs` 的 `0.05` 字面量改读它 | 删掉 `memory/mod.rs` 里的第二个 `0.05` | `cargo test -p dieyun-core --lib -- memory vector`（47 过）、`npm run cargo:test`（全绿） |
| **C5 · #18** `%TEMP%` 可写根 | 新增 `server.js:writableRootsForMode()` 作为**唯一组装点**：`_collectWritableRoots()`（`assertSandboxWritable` / `sandbox_state`）与 `sandboxContext()`（`decideFsWrite` / `decideShellCommand`）都从它取；临时目录只在 workspace-write 档是内部根（read-only 不再包含 —— `%TEMP%` 里的项目不该整片免问） | 删掉 `_collectWritableRoots()` 里两处 `systemTempDir()` 重复拼接 | `test:sandbox-gateway`（新增 2b「workspace-write 下 fs/shell 写临时目录都不问」、read-only「临时目录也要问」）、`test:sandbox-policy`、`test:sandbox-smoke`、`test:local-gateway-smoke`。**已验证不修则失败**：把 `sandboxContext().internalRoots` 换回 `_internalWriteRoots()` 时报 `temp write must not ask in workspace-write, got 1 asks` |

**行为变化（有意为之）**：read-only 档下写 `%TEMP%` 现在要问（此前 fs 通道放行、shell 通道弹窗 —— 两条链各说一套）。记账用的目录都在 `userDataPath`/`~/.dieyun/*` 这些内部根里，不依赖临时目录，所以不影响 Agent 记账。

### 延后的三条（各自缺一个决定，不是缺工时）

| 条目 | 为什么不能就这么删 | 需要定的那件事 |
|---|---|---|
| **C2 · #9 能力门控** | `guardrails-shared.PERMISSION_GATED_TOOLS` 是**按工具名**，`rpc.js` 的三个 `assert*` 是**按 RPC 方法**。同一能力被两个坐标轴各挡一次，合并前要选"强制点在哪一层"：工具层（模型侧，Renderer 直连 RPC 时无人把关）还是 RPC 层（当前的实际执行点）。§4 事实 1 已确认缺键不可达，所以"默认语义"不再是障碍，剩下的纯粹是坐标轴选择 | 强制点：只挡工具（简单，但 Renderer 直连 RPC 会成为旁路）／只挡 RPC（现状，但两套名单仍在）／一张 `能力 → {tools, rpcMethods}` 表同时喂两边（真单一来源，改动最大） |
| **C6 · #19 synthesis trace** | §4 事实 2 已确认事件带 `trace`，但 Renderer 那份还在 `displayedTrace` 上合并实时 UI 字段（`visibleContent`/`answerPhase`），删掉后要用 Main 的静态 trace 覆盖，属"必须开应用看"的改动 | 是否接受"汇总阶段不再显示流式正文预览"（`synthesis_delta` 现在直接进 `liveContent`）。若接受，改动只是删函数 + 换数据源；若不接受，则不存在重复实现，本条应从清单里划掉 |
| **C7 · #11 计划 prompt** | 手拼版**故意不含** AGENTS.md / 记忆 / MCP / 代码库召回（§4 事实 3）。接 prep 不是删重复，而是**改产品行为**：定时任务会开始读用户 AGENTS.md 与记忆，prompt 体积也上一个量级 | 产品决定：定时计划轮该不该看到 AGENTS.md / 记忆 / MCP？"该"→ 接 prep 并跑一轮 token 预算实测；"不该"→ 这不是矛盾，改注释说明差异即可 |

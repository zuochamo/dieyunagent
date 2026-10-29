# 「后台任务状态更新」对照：DSH 与本仓（叠云 Agent）

> 起因：用户截图里会话流中出现一条灰色通知条 `后台任务状态更新`，问「这是干嘛的，Qoder 也有」，
> 要求整理成一份对照。本文只做对照与取舍建议，不改代码。

## 0. 结论先行

| 问题 | 结论 |
|------|------|
| 图里那条是什么 | **不是**任务进度浮层，而是 DSH 的**回合触发归因节点**（`TurnTriggerNodeView`）：标明「本轮回复不是人发的，是一条后台任务（tool-jobs）的状态更新唤醒的」。 |
| 与 Qoder 的关系 | 同一诉求（后台任务可观测），形态不同：Qoder 是 IDE 侧边栏任务/终端列表，DSH 是会话内一条可展开的 notice，兼作「谁唤醒了这一轮」的审计记录。 |
| 本仓有没有等价物 | **没有等价节点**，但有等价的「触发来源」，且被塞进**用户消息正文前缀**里三套写法各不相同（计划 / 内网 Agent / goal 续跑）。 |
| 要不要照抄 | **不要照抄节点**。本仓没有 background job，抄过来没有数据来源。已做的是把计划/目标续跑的触发归因从「用户正文」搬到 user meta + 一条触发条渲染（减法，不是加层）。见 §6。 |

---

## 1. 图里那条的源码定位（DSH）

DSH 安装包 `D:\Program\dsh\resources\app.asar`，用 UTF-8 字节检索可定位到：

**i18n（zh-CN）**

```json
"message.trigger.job": "后台任务状态更新",
"message.trigger.explanation": "这条通知触发了本轮回复。",
```

**组件** `@deepseek-ai/dsh-client-ui-chat/TurnTriggerNodeView`：

```js
/** An independent, expandable notice explaining a non-human Turn trigger. */
const TRIGGER_ICONS = {
  request:   IconContextInjectionOutlineRegular,
  goal:      IconGoalOutlineRegular,
  agent:     IconPaperPlaneOutlineRegular,
  team:      IconAgentPresetOutlineRegular,
  subagent:  IconAgentPresetOutlineRegular,
  github:    IconBranchOutlineRegular,
  webhook:   IconGlobeOutlineRegular,
  schedule:  IconClockOutlineRegular,
  job:       IconQueueOutlineRegular,   // ← 截图里那个图标
  plugin:    IconCordisPluginOutlineRegular,
};
```

**归因映射** `turn-trigger.js#turnTriggerDetails(node)`：读 `node.source.kind` → 决定标题 key 与图标族。

| `source.kind` | 标题 | 图标 |
|---|---|---|
| `goal` | 继续执行目标 | goal |
| `agent-message` | 收到任务消息 | 纸飞机 |
| `team-message` | 收到团队消息 | agent preset |
| `subagent-settled` | 子任务状态更新 | agent preset |
| `webhook`（github provider） | 收到 GitHub 事件 / 收到外部事件 | 分支 / 地球 |
| `schedule` | 自动化任务 | 时钟 |
| **`tool-jobs`** | **后台任务状态更新** | **队列图标** |
| `cordis-host-runner` | 插件状态更新 | 插件 |
| 默认 | 收到执行请求 | 上下文注入 |

**结构与交互**（`.hSzSIW_*` 样式类）：

- 折叠态：`[图标] 标题 [时间] [chevron]` —— 就是截图那一行；
- 展开态：一句解释 `这条通知触发了本轮回复。` + `NoticeBody(content, source)` 原文（`white-space: pre-wrap`，`max-height: 240px`，可滚动）；
- 组件注释写得很明确：*"An independent, expandable notice explaining a non-human Turn trigger."* —— 它属于**回合级归因**，不是任务面板，也不显示进度百分比。

**由此纠正一个常见误解**：它不是「后台任务跑起来了」的推送，而是「这一轮是被后台任务的状态变化**唤醒**的」这一事实的落库展示。会话里出现它，说明你（或 IDE）此刻正在看一条**非人类触发**的轮次。

---

## 2. 两边的「后台工作」到底有什么

| 维度 | DSH | 本仓（dieyunagent） |
|---|---|---|
| 后台 job 本体 | 有：`run_in_background` 的 shell/命令任务 + `job_list` / `job_output` / `job_kill`，含完成态回收 | **无**。`grep 'run_in_background\|job_output\|job_kill'` 在 `src/` 零命中 |
| 会「自动跑一轮」的触发源 | goal / agent 消息 / team 消息 / subagent 收尾 / webhook / schedule / tool-jobs / 插件 | 定时计划（`src/plans/scheduler.js`）、目标续跑（`src/plans/goal-run.js`）、内网 Agent 来信（`src/peer/coordinator.js`）、planner 子 agent（`src/agent/rust-planner-runner.js`） |
| 触发归因的载体 | 独立 notice 节点，`source` 为结构化字段，落库可回放 | **混在用户消息正文里**（见 §3） |
| 运行态可见性 | 归因节点 + 消息列表里的 job 通知 | 历史列表小环 `后台运行中`（`renderer-chat-history.js:338`）、计划卡片 `.automation-tile.running` 边框（`styles.css:7022`）、live bubble 复用聊天渲染链（`plans/plan-run-events.js` 头注释） |
| 收尾通知 | 会话内节点即记录 | 托盘气泡：`showTrayBalloon`（`renderer-chat-bubbles.js:601`，Win10/11 操作中心 Toast，失败退化为 in-app toast） |
| 失败/中断可见性 | 同上节点 + 轮次正文 | 托盘 + 落库正文 `（计划已停止）/（本次运行被中断：…）/ 执行失败：…`（`plan-run-turn.js:137-149`） |

---

## 3. 本仓现有的「触发归因」三套写法（这是真正的差距点）

同一种语义（这一轮不是你发的），现在是三段**手写中文抬头**，各自维护措辞：

| 触发源 | 写在哪 | 原文 | 代码 |
|---|---|---|---|
| 定时计划 / 目标续跑 | 合成 user 轮的正文 | `` `[计划 · ${name}]\n${when} · 定时触发`（或 `目标续跑`）`` | `src/plans/plan-run-turn.js:86-92`（`buildPlanRunUserText`）→ `beginPlanRunTurn` 落 `memory.message_append` |
| 内网 Agent 来信 | 合成 user 轮的正文 | `【内网 Agent 来信 · 名称】` + `来源 peerId…跳数…` | `src/peer/coordinator.js:299-307`（`inboundText`）→ `appendInbound` |
| 计划投递（deliver） | 合成 user 轮 | 同计划前缀体系 | `src/plans/deliver.js:21` |
| planner 子 agent | trace 行字段（`isolated/worker/parallel`） | 气泡内工具行 | `src/agent/rust-planner-runner.js`、`plans/plan-run-events.js:16` 注释 |

由此产生三个具体问题（都成立，无需推测）：

1. **真假消息不可分辨**：`messages` 里 role 一律 `user`，回放/导出/手机端看历史时，用户看到的是「用户自己发了一条 `[计划 · xxx]`」。DSH 的做法是把 notice 从 user 轮里拆出来，`source.kind` 单独存。
2. **模型也会看到这条前缀**：模型必须靠猜「`[计划 · …]` 开头的是系统触发」。这属于 `AGENTS.md` 原则 3 想避免的「意图关键词」路径——虽然当前是固定结构而非词表，但归因语义只存在于字符串里，没有结构信号可用。
3. **三条措辞各自漂移**：计划前缀在 `plans/`，peer 抬头在 `peer/`，子 agent 在 trace 里；风格统一（`【】` vs `[…]` vs `·`）纯靠人工记忆，改一处不会影响另两处。

---

## 4. 两边逐项对照表

| 能力 | DSH | 本仓现状 | 差距判定 |
|---|---|---|---|
| 「本轮由谁触发」的结构化事实 | ✅ `source.kind` + 落库 | ❌ 只有正文文本前缀 | **真实差距** |
| 触发类型的图标与本地化标题 | ✅ 10 类，i18n | ❌ 无 | 视觉层，可后置 |
| 展开看触发内容原文 | ✅ `NoticeBody`，240px 可滚 | ⚠️ 正文本来就在消息里（信息不丢，只是混在用户轮里） | 非差距 |
| 后台命令 job 与 job 控制 | ✅ job registry + `job_output`/`job_list`/`job_kill` | ⚠️ 句柄体系已有（`host_exec` 的 `detached`/`waitMs` + `host_proc` list/output/kill，含 SSH 远端 `sshproc-N`），**缺「结束时告知」** | 已补「静默补报」，见 §8 |
| 运行中状态展示 | 节点 + 列表 | ✅ 历史小环 + 计划卡片 + live bubble | 已覆盖 |
| 收尾通知 | 节点常驻 | ✅ 托盘 Toast + in-app toast + 落库回执 | 已覆盖，只是不常驻 |
| 非人类触发轮的审计可回放 | ✅ 节点即记录 | ❌ 关掉托盘后会话里只剩一段像用户说话的文本 | 真实差距（同 §3-1） |

---

## 5. 建议（按减法优先）

### 方案 A（已实施，属减法）

**把已有的归因从「用户正文」搬到「结构化 meta + 一种渲染」**，不新增存储表、不新增通知通道、不新增状态机。
落地位置（见 §6 实施记录）：

1. `src/plans/plan-run-turn.js`：`buildPlanRunUserText` 旁边一并产出 `trigger = { kind: 'schedule' | 'goal', planId, planName }`；`beginPlanRunTurn` 落 `memory.message_append` 时带上（`meta.trigger`）。正文前缀保留（模型侧仍需要上下文说明），但**不再是唯一来源**。
2. `src/peer/coordinator.js`：`inboundText` 同样产出 `trigger = { kind: 'agent-message', peerId, hops }`。
3. `src/renderer/renderer-chat-render.js`：user 轮渲染前看 `meta.trigger`，命中则用 notice 样式（折叠一行：图标 + 标题 + 时间；展开显示正文），否则走普通用户气泡。
4. 标题文案集中一处（`renderer-chat-bubbles.js` 或新建极小的 `trigger-labels` 纯函数），避免第三套措辞。

为什么这是减法而不是加法：它**消除**「归因只能活在字符串里」这个错误职责，把三处手写抬头收敛成一个结构字段 + 一个渲染入口；新增的只有一个可选 meta 字段，且无独立存储、无独立事件通道。

### 明确不做（避免加层）

- ❌ 造一套 background job / `job_*` 工具：本仓已有 `host_exec` + `host_proc` 句柄体系，再包一层是重复实现。
- ❌ 新增第四种通知通道（在托盘、in-app toast、live bubble 之外再加常驻浮层）。
- ❌ 为「通知是否已读」引入状态机或开关。

### 前置判断

方案 A 的价值取决于一个真实痛点：**你会不会回看历史 / 手机端 / 交接时，被「用户自己发的 `[计划 · …]`」误导？** 若不会，按 `AGENTS.md` 原则 2，这项应记为「已知取舍」而非待办——现状信息不丢，只是载体不理想。

---

## 6. 实施记录（方案 A 已完成）

思路：**一个字都不改模型输入**，只给「系统自己开的那一轮」补一个结构化归因字段，Renderer 据此换渲染样式。

| 位置 | 改动 |
|---|---|
| `src/agent/session-context.js` | user meta 允许并瘦身 `trigger`（`kind` + `planId` + `planName` + `at`，字段白名单）；assistant meta 显式 `delete payload.trigger`（归因唯一来源是 user 行，与附件同理）。 |
| `src/plans/plan-run-turn.js` | 新增 `buildPlanRunTrigger(plan, at)`：`kind = goal ? 'goal' : 'schedule'`；新增 `planRunUserTurn()`：正文与归因**一次产出、一次打包**，`userText`（模型输入）保持原样返回。 |
| `src/plans/deliver.js` | 降级投递改用 `planRunUserTurn`，与运行边界同一份文案 + 同一份 meta。 |
| `src/renderer/renderer-chat-bubbles.js` | 新增 `appendTriggerNotice()`：折叠一行「图标 + 标题 + 时间 + 折叠箭头」，点开看该轮实际收到的正文；标题表 `TRIGGER_NOTICE_TITLES`（`schedule` → 定时任务触发，`goal` → 目标续跑触发，未登记回落「系统触发」）。 |
| `src/renderer/renderer-chat-render.js` | user 行渲染：`packedMeta.trigger` 命中 → 触发条，否则原样用户气泡；footer/撤回/复制沿用同一套。 |
| `src/renderer/styles.css` | `.msg-trigger*` 样式（直角、`--bg-elev` 底、`--text-dim` 字，展开正文 `pre-wrap` + `max-height: 240px`）。 |
| `scripts/test-session-context.cjs` | 新增断言：kind/planId/planName/at 落库、正文一字不改、未登记字段被丢弃、无 kind 不落库、assistant 不复制归因。 |

边界（有意为之）：

- **旧数据不动**：只有本次改动之后写入的计划轮次带 `trigger`；历史里已有的 `[计划 · …]` 仍是普通用户气泡（不回溯改库）。
- **移动端不动**：手机端本来就剥离 meta 前缀，展示与改动前一致。
- **不剥离正文抬头**：展开后看到的仍是 `[计划 · 名称] 时间 · 定时触发 + 提示词` 原文 —— 即模型当时读到的内容，归因由 meta 表达，不靠解析字符串。

验证：

| 项 | 结果 |
|---|---|
| `node scripts/test-session-context.cjs` | ok（含新增 trigger 断言） |
| `npx vitest run` | 126 文件 / 1270 用例全通过 |
| `npm run check:renderer` | 全局/关键符号检查通过 |
| `npm run test:agent-run-events` / `test:tool-gate` / `test:mobile` | ok |
| `npm run test:agent` | 中途停在 `test:lsp`：`npx child keeps default env` —— 本 shell 带 `ELECTRON_RUN_AS_NODE=1`，属环境既有问题，与本次改动无关（`src/lsp` 未改动） |

---

## 7. 若采纳：改动 → 测试

| 改动路径 | 测试 |
|---|---|
| `src/plans/plan-run-turn.js` | `npm run test:agent`（计划链路 smoke） |
| `src/peer/coordinator.js` | `npm run test:mobile` + peer 相关 smoke |
| `src/renderer/renderer-chat-render.js` | `npm run check:renderer` / `npm run test:renderer` |
| 新增 `meta.trigger` 字段 | 需同步 `docs/agent-run-events.md` 或 `docs/CODEMAP.json`（提交前清单） |

---

## 8. 后台任务「静默补报」（B 方案，已实施）

对齐 DSH 的 `completionDelivery: 'quiet'`：**任务结束时不开新轮**，只在用户下一次说话时，把「它已经结束了 + 输出尾部」打进那一轮的 turn context。

为什么是 quiet 而不是 wakeup：DSH 的 wakeup 本质是「塞一条 user 消息再 followup」，而 `AGENTS.md` 原则 5 明令禁止「假用户续跑」。quiet 不碰循环语义，也不需要唤醒预算 / 连环自唤醒防护。

| 位置 | 改动 |
|---|---|
| `src/gateway/host-control.js` | 句柄记录新增 `awaitReport`（只有「模型拿不到退出码」的进程才置位）/ `reportedAt`；`runShellDetached` 用 `awaitReport: true` 登记并带上 `child`（精确 exit / 退出码，拿不到时退化为 PID 判活）；`waitMs` 转后台那一刻置 `awaitReport`；新增 `takeSettledReports()`（取走即标记已投递）；抽出 `readRecordSnapshot()` 供读数与补报共用。 |
| `src/gateway/remote-processes.js` | 远端句柄同样标记 `awaitReport`；新增 `takeSettledRemoteReports()`（一批 `kill -0` 判活 + sftp 读日志尾部；判活失败按「还活着」处理，宁可晚一轮也不误报）。 |
| `src/gateway/handlers/host.js` | 新增 RPC `host.proc_settled`：一次性投递口，本地 / SSH 远端各走各的句柄表。 |
| `src/agent/system-prompt-prep.js` | 新增 `fetchSettledJobsBlock()`：本轮组 prompt 时取一次（4s 超时、失败不阻塞本轮），转成 `【后台任务已结束】` 文本块，**排在本轮上下文最前**。 |
| `src/gateway/rpc.js` | 注入 `takeSettledReports`；`docs/rpc-catalog.*` 已重新生成（186 方法）。 |
| `test/unit/settled-jobs-report.test.cjs` | 9 条：只报一次、前台命令不报、仍在跑不报、模型自己读过不报、跨会话不串台、文案含 exit/尾部/「不要再等」、条数上限。 |

语义边界（有意为之）：

- **只报后台**：`host_exec` 前台命令当轮就把 exit code 给了模型，再报一次是噪音；只有 `detached` 与 `waitMs` 转后台的才补报。
- **一次性**：`reportedAt` 在 Gateway 侧（唯一持有句柄表的地方），同一条不会刷第二次；模型自己 `host_proc action=output` 读过也算已投递。
- **退出码不编**：detached / 远端拿不到真实退出码时如实写「退出码未知」，只给输出尾部。
- **跨重启不报**：句柄表在内存，应用重启后旧任务直接消失（不尝试从磁盘恢复）。
- **手机端暂不覆盖**：手机链路不组 system prompt（无 turn context），这条补报目前只作用于桌面端。

验证：

| 项 | 结果 |
|---|---|
| `npx vitest run` | 127 文件 / 1279 用例全通过（含新增 9 条） |
| `npm run test:local-gateway-smoke` | ALL OK |
| `npm run check:js` / `check:renderer` | 通过 |
| `npm run verify:rpc-catalog` | catalog OK（186 方法） |

---

## 附：查证方法（可复现）

`app.asar` 是拼接归档，直接用 UTF-8 字节检索即可（无需解包）：

```powershell
$bytes=[System.IO.File]::ReadAllBytes('D:\Program\dsh\resources\app.asar')
$enc=[System.Text.Encoding]::GetEncoding(28591)
$hay=$enc.GetString($bytes)
$pat=$enc.GetString([System.Text.Encoding]::UTF8.GetBytes('后台任务状态更新'))
$i=$hay.IndexOf($pat)
[System.Text.Encoding]::UTF8.GetString($enc.GetBytes($hay.Substring($i-400,900)))
```

依次检索 `后台任务状态更新` → `message.trigger.explanation` → `TurnTriggerNodeView` → `turnTriggerDetails` 即可还原全部语义。

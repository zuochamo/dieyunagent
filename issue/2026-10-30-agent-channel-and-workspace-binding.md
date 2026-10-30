# Agent 频道标签与工作空间绑定模式（含企微转接器接入方案）

- 日期：2026-10-30
- 状态：**P2（工作空间绑定）已实施**（2026-10-30，见 §七）；P1（频道标签 / 不抢焦点）、P3（频道级模型路由）仍为提案
- 关联：`issues/2026-10-30-chat-answer-no-markdown-render.md`（同为客户端缺陷记录）
- 已有外挂资产：`工具/wecom-agent-bridge/`（企微→Agent 转接器 v1，已跑通，详见附录 A）

## 一、背景

叠云 Agent 目前有四种使用入口：桌面 UI、手机内网桥（17331，企微转接器即经此接入）、
定时计划（plans）、未来的主动推送。它们对工作空间、会话归属、模型路由的要求各不相同，
但现状是全部挤在「桌面 UI 当前状态」这一个隐式变量上。

实测场景：企业微信机器人（智能机器人 API 模式＋长连接）经转接器接入 Agent 后，
微信会话的运行工作空间完全由「桌面端当前打开的工作空间」决定，且存在缓存回退 bug
导致绑定好的空间被改写（见二）。

## 二、问题（均为 2026-10-30 实测，非推测）

### 问题 1：task.submit 不接受工作空间参数

`src__agent__service.js` L186-188：新建会话时 `memory.session_create` 的
`workspacePath` 硬编码为 `null`。手机桥的 task.submit 只接受 text / sessionId / title，
多余字段（如 workspacePath）被静默忽略。

### 问题 2：renderer 回退竞态，会话空间被桌面 UI 改写

任务启动链路：`task.submit` → `agent-service:submit-task` → renderer
`handleAgentServiceSubmitTask` → `openAgentServiceSession`（会把桌面当前会话切到该任务会话）
→ `resolveSendWorkspace` → `resolveSessionWorkspacePathSync`（bundle.js）。

解析回退顺序：
1. 本地缓存 `sessionWorkspacePathCache`
2. 缓存未命中 → 若该会话是当前会话（切换后必然是）→ 直接取
   `window.activeViewSessionWorkspacePath`（桌面 UI 当前显示的工作空间）
3. 第 2 步非空即跳过查库 —— 即使会话行里 workspacePath 正确也不会再看

实测（`.tmp/trace_flip.py`，2 秒轮询会话行）：

    poll#0  0.0s  workspacePath=F:\微信Agent对话   ← 建会话时正确
    poll#1  2.0s  workspacePath=F:\微信Agent对话
    poll#2  4.0s  workspacePath=F:\定时任务\指标汇总报告  ← 任务启动后被改写
    poll#3… 错误值保持到最后

且 Agent 实际也运行在错误空间（`.tmp/test_real_cwd.py`：Agent 自报绑定的
工作空间为桌面空间，系统提示/AGENTS.md 注入均为桌面空间内容）。

### 问题 3：外部任务抢占桌面会话焦点

提交外部任务会 `openAgentServiceSession`，把桌面用户的当前会话切走；反过来桌面切空间
也会把运行中的外部会话拽到新空间。

### 问题 4：无渠道维度，模型路由/配额无法隔离

微信渠道与桌面共用同一套模型路由。已知坑：内网端点只认 `deepseek-v4.1-flash`、
官方端点只认 `deepseek-flash`（详见 AGENTS.md gotchas），渠道隔离后可分别配置。

## 三、修改提案

### P1：频道标签（channel tag）

- `task.submit` 增加 `channel` 字段，取值：`desktop` / `external` / `plan` / `push`，
  缺省 `desktop`（兼容存量调用方）。
- 事件流（task.progress / task.completed）、会话行、记忆写入均携带该标签。
- **外部频道（external）任务不调用 `openAgentServiceSession`**，不切换桌面 UI 当前会话
  —— 直接解决问题 3。
- 定位参照：定时计划已是独立路径（`src__plans__plan-agent-runner.js` 直接调
  `runRustAgentLoop` 并显式传 `workspaceRoot: plan.workspace`，不经过 renderer），
  说明「不借桌面界面跑任务」在架构上已有先例。

### P2：工作空间「模式」+ 指定（本 issue 主诉求）

新增配置项（客户端设置页，或设置文件）：**外部渠道工作空间模式**，两个取值：

| 模式 | 行为 |
|------|------|
| `follow`（跟随桌面） | 维持现状：使用桌面当前工作空间。默认值，兼容现有用户 |
| `fixed`（指定固定） | 使用设置里显式指定的路径（如 `F:\微信Agent对话`） |

实现要点：

1. **主进程** `agent-service.js` submitTask：接受 `workspacePath` 参数，
   新建会话时传给 `session_create`（替代硬编码 null）。约 3 行。
   转接器侧 config 增加 `workspace_mode: follow|fixed` 与 `workspace_path`，
   按模式决定是否在 task.submit 报文中带 workspacePath。
2. **renderer** `resolveSessionWorkspacePathSync`：对 `channel=external` 且
   `fixed` 模式的会话，缓存未命中时**禁止回退 `activeViewSessionWorkspacePath`**，
   改为读库（会话行 workspacePath）。约 5 行 —— 这是堵住问题 2 竞态的关键，
   否则即使建会话时写对了，任务启动 2 秒内仍会被改写。
3. 模式为 `follow` 时行为完全不变，不引入回归面。

### P3（可选，后续）：频道级模型路由与配额

频道标签落地后，设置里可按渠道配置 modelRoute（微信固定绑内网端点的
`builtin:supplier-1782688848905:deepseek-v4.1-flash`），配额账目也按渠道分开。
不阻塞 P1/P2。

## 四、验收标准

1. 桌面停在任意工作空间 → 微信发消息（fixed 模式指向 `F:\微信Agent对话`）
   → 会话行 workspacePath 稳定为配置值（2 秒轮询 trace 不出现翻转）。
2. Agent 自报运行工作空间与配置值一致（cwd/AGENTS.md 注入核对）。
3. 微信任务运行期间，桌面当前会话与当前工作空间不被切换/改写。
4. `follow` 模式下行为与改动前完全一致（回归）。
5. 存量调用方（不传 channel / workspacePath）不受影响。

## 五、风险与回滚

- renderer 改点需重建 bundle（与 markdown 渲染 issue 同一流程，见
  `issues/mini-markdown-renderer.js` 的自测做法可参照）。
- 动 app.asar 前先备份；P1、P2 可分开实施，P2 单独上也足以解决空间漂移。
- 转接器侧改动（config 两个字段 + 报文一处）独立于客户端，可先行部署不生效、
  待客户端升级后自动启用。

## 六、非改码替代方案（不推荐，记录备查）

1. 桌面客户端常驻停留在固定工作空间不动 —— 桌面端被锁死，不可行。
2. 外挂双桥：转接器直连 17330 内核 RPC（handlers 更全）自建会话并绑定空间 ——
   但那是内部私有协议、随版本变化，且实测证明 renderer 仍会在任务启动时改写，
   治标不治本。
3. 维持现状（转接器会话跟随桌面空间）—— 语义不可预期，用户已明确不接受。

## 附录 A：现有转接器（工具/wecom-agent-bridge/，已交付 v1）

本 issue 所服务的实体组件，2026-10-30 已开发并实测跑通，**客户端零改动**即可用：

- `bridge.py`（约 500 行，仅依赖 websockets）：左侧企微长连接
  （wss://openws.work.weixin.qq.com，aibot_subscribe → 收 aibot_msg_callback →
  aibot_respond_msg 流式回），右侧本机 17331 手机内网桥（task.submit /
  task.progress.streamContent 节流刷新 / task.completed）。
- 关键机制：微信联系人 → Agent 会话映射落盘（state/sessions.json，重启不丢）；
  同会话串行（忙时直接回「上一条还在处理中」）；流式 2.2 秒一刷（企微限 30 条/分钟/会话）；
  900 秒超时 task.stop 兜底；SESSION_NOT_FOUND 自动清映射重建会话；
  兜底 try/except 保证任何异常都回 finish=True 收尾帧，微信端不再无限转圈；
  桌面端未运行时直接回复提示。
- `--check` / `--selftest` 两个自检模式；credentials.txt 存密钥（不入库）；
  run.bat 双击启动。
- 已实测：订阅成功、真实微信消息→Agent 执行→流式回企微、删会话后自动恢复。
- v1 未做：图片/语音附件、aibot_send_msg 主动推送（日报/巡检告警直推）、
  工作空间指定（即本 issue P2 所解）。
- 部署注意：企微同一 bot 仅允许一条长连接，多客户端会互踢；桌面端需常驻
  （17331 由 Electron 主进程托管）；本机 python 需用
  `C:\Users\admin\AppData\Local\Programs\Python\Python312\python.exe`
  （PATH 里的 python 指向 LibreOffice 自带 core，功能可用但日志中文乱码）。

## 七、实施记录（P2，2026-10-30）

### 根因（比 §二 问题 2 更精确）

问题 2 的真根因不在 `resolveSessionWorkspacePathSync` 的回退顺序，而在**视图路径没有归属会话**：

`performSwitchSession` 先把 `currentSessionId` 指向外部会话，再调
`resolveSessionWorkspacePathSync(该会话)`；此时 `window.activeViewSessionWorkspacePath` 还是
上一个（桌面）会话的路径，而旧实现只看 `sid === currentSessionId` 就把它当成「该会话的已知绑定」
（`knownWs`）传给 `applySessionWorkspace`。于是：跳过查库 → 缓存/主进程会话上下文/UI 标签全被写成
桌面路径 → `resolveSendWorkspace` 命中缓存 → `bindCurrentSessionWorkspace` 把它写回会话行。
即 §二 里 2 秒轮询看到的翻转。同一判定的影子副本还在
`renderer-gateway.js:resolveSessionWorkspacePathForRpc`。

### 改动

1. **`src/agent/service.js`（外部提交入口）**：`task.submit` 接受 `workspacePath`。
   - 新建会话时写进 `memory.session_create`（原为硬编码 `null`）；
   - 存量会话若声明值与行里的值不同 → `memory.session_workspace_set`（固定渠道要能纠正被拽偏的历史会话）；
   - 未声明（「跟随桌面」）→ 取**提交这一刻**桌面视图的工作空间，只给**尚未绑定**的会话钉上，不覆盖已有绑定。
2. **`src/renderer/renderer-composer.js`（视图对）**：`activeViewSessionWorkspacePath` 与
   `activeViewSessionWorkspaceSessionId` 由 `rememberActiveViewSessionWorkspace()` 成对写入；
   `resolveSessionWorkspacePathSync` 只在「视图确实属于这个会话」时才回退视图路径。
   `applySessionWorkspace` 的标签更新一律带上 `sessionId`。
3. **`src/renderer/renderer-skills-ui.js`**：`updateWorkspaceLabel`（标签的唯一写入点）改为经上面那个
   函数成对落值，`ws.sessionId` 可显式指定归属。
4. **`src/renderer/renderer-gateway.js`**：删掉 `resolveSessionWorkspacePathForRpc` 里那份
   「`sid === currentSessionId` 就用视图路径」的影子判定；索引面板的视图回退也按归属会话判定。
5. **`src/renderer/renderer-agent-loop.js`**：外部任务开跑前先按库里真值刷新该会话缓存
   （`resolveSessionWorkspacePath`），避免渲染端旧缓存把 Main 刚写的绑定顶回去。
6. **`test/unit/session-workspace-binding.test.cjs`**：钉住视图对语义、`applySessionWorkspace`
   查库行为、以及 `task.submit.workspacePath` 的四种情形（新建 / 纠正 / 跟随 / 不覆盖）。

### 转接器侧（客户端之外，未在本仓）

`config` 加 `workspace_mode: follow|fixed` 与 `workspace_path`：`fixed` 时在 `task.submit` 报文中带
`workspacePath`。客户端已就绪，转接器可先行部署（不带该字段 = `follow`，行为与改动前一致）。

### 仍然没做的（P1 / P3）

- **P1 频道标签 / 不抢桌面焦点**：外部任务仍经 Renderer 跑一轮（`sendMessage` 的
  `gateCurrentSession` 明确要求 `runSessionId === currentSessionId`），所以仍会切换桌面当前会话。
  要解决只能让外部频道走 Main 侧 headless 循环（`src/plans/plan-agent-runner.js` 是现成先例），
  但那条路的系统提示 / 上下文装配比 Renderer 侧薄，属于独立设计，未在本轮动。
- **P3 频道级模型路由 / 配额**：未做。

### 验收核对

1. ✅ 会话行 `workspacePath` 稳定为配置值（写回值 = 会话自己的绑定，不再出现桌面路径）。
2. ✅ `cwd` / `AGENTS.md` 注入取 `runWorkspaceRoot`（= 会话绑定），与配置值一致。
3. ❌ 桌面当前会话仍会被切到外部任务会话（P1 未做）。
4. ✅ `follow`：不传 `workspacePath` → 提交时刻的桌面工作空间；已绑定会话不受桌面切目录影响。
5. ✅ 存量调用方（只传 text/sessionId/title）签名兼容，行为不变。

## 八、后续：转接器内置（2026-10-30，已实施）

上面的 P1 原本要解决的是「外部任务别抢桌面焦点」，但那条路的根子在**为什么要经过 Renderer**：
外挂转接器只能通过手机内网桥 `task.submit` 驱动「桌面上正在看的会话」。把转接器内置进客户端后，
这个问题从链路层面消失，不需要再加 P1 的 `channel` 标签：

- **设置 →「频道」**（`src/renderer/renderer-channels.js`）：可添加多条企业微信频道，
  每条填 Bot ID + Secret（safeStorage 密文，不回显）、**指定工作空间**、可选欢迎语、可启停、
  可「测试连接」；Secret 只有 Main 能解。
- **转接器内置**（`src/channels/`，照 `工具/wecom-agent-bridge/bridge.py` 的协议逐帧移植）：
  `aibot_subscribe` / 25s `ping` / `aibot_msg_callback` / `aibot_respond_msg` 流式 / `aibot_send_msg` 主动推送；
  不再需要 Python 转接器，也不再经 17331。
- **频道任务在 Main 后台跑一轮**（`src/channels/agent-turn.js`）：自己的会话（`[企业微信] 名称`）、
  自己的工作空间绑定（`memory.session_create` + `session-workspace-bind`）、自己的模型解析；
  **完全不碰 `currentSessionId`**，桌面正在聊的那条会话与目录不受影响 → 验收标准 3 对新的频道路径成立。
- 一致性全部复用既有单一来源：系统提示 `prepSystemPrompt`（依赖装配 `system-prompt-prep-main.js`）、
  工具 `main-agent-tools.js`、压缩 `compaction-loop.js`、交付闸门 `agent-round-text`。
- 新增：图片（多模态 + 落盘副本）、文件（收件箱路径）、语音（用企微识别文本）、主动推送自检。

仍然保留的边界：外挂 `bridge.py` + `task.submit` 那条旧路还能用（跟进 `follow` 语义），
但不再推荐；P3（频道级模型路由）仍未做——频道的 `resolveTextApiConfig` 已支持 route，
设置页加一个下拉即可。

细节见 [`docs/CHANNEL-WECOM.md`](../docs/CHANNEL-WECOM.md)。


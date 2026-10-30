# 内置频道（企业微信智能机器人）

**已实施**（2026-10-30）。设置 →「频道」里添加一条企业微信机器人（Bot ID + Secret），
指定它的工作空间，即可在微信里直接跟本机 Agent 对话——**转接器内置在客户端内**，
不再需要外挂 `工具/wecom-agent-bridge/bridge.py` 或经手机内网桥（17331）。

## 为什么内置

外挂版（v1）的链路是「企微 → Python 转接器 → `ws://127.0.0.1:17331/ws` 手机桥 → Renderer」，
带来三个结构性问题：

1. **抢桌面焦点**：`task.submit` 的语义是「驱动桌面上正在看的会话」，跑之前要把 Renderer 切到目标
   会话——微信来一条消息就把用户的桌面对话切走。
2. **工作空间漂移**：会话工作空间由桌面视图决定，微信会话被「猜」成桌面当前目录，并把这个错路径
   写回会话行（issue/2026-10-30-agent-channel-and-workspace-binding.md 问题 2）。
3. **第二份 Agent 装配**：转接器只能通过桥触发 Renderer，能力上限受 Renderer 约束。

内置后这三个问题都不存在：频道任务在 **Main 里后台跑一轮**，有自己的会话、自己的工作空间、
自己的模型解析，完全不碰 `currentSessionId`。

## 分层

| 文件 | 职责 |
|------|------|
| `src/channels/store.js` | 频道配置与凭据（`<userData>/channels.json`，Secret 走 safeStorage 密文、文件 0600）；会话映射（企微联系人 → Agent 会话） |
| `src/channels/wecom-client.js` | 企微长连接：订阅、25s 心跳、3s 重连、帧编解码（`frames` 是协议唯一来源）、流式回写、主动推送、一次性连通性自检 `probeWecomCredentials` |
| `src/channels/runtime.js` | 调度：每条频道一条连接、同会话串行（忙即回「上一条还在处理」）、流式节流（企微限 30 条/分钟）、900s 超时中止、`SESSION_NOT_FOUND` 时重建映射 |
| `src/channels/agent-turn.js` | **在 Main 跑一轮**：会话解析与工作空间绑定、附件、system prompt、工具、Rust 循环、消息落库、记忆归纳 |
| `src/channels/workspace-switch.js` | 微信里「换项目」的唯一实现：候选校验 → `bindSessionWorkspace` → 记住这条会话的选择（工具 `session_set_workspace`） |
| `src/channels/boot.js` | 装配（照 `plans/boot` 的形状），窗口就绪后 `startEnabled()` |
| `src/main/ipc/channels.js` | IPC：增删改查、启停、测试连接、测试推送（选目录复用既有 `dialog:pick-folder`，不再另开通道） |
| `src/renderer/renderer-channels.js` | 设置页：列表 + 表单 + 状态（不接触 Secret 明文；API 走 `window.diecloud`） |

## 与桌面聊天的一致性

频道轮次不另造 Agent，全部复用既有单一来源：

- 系统提示 `prepSystemPrompt`，依赖装配 `src/agent/system-prompt-prep-main.js`
  （与 IPC `agent:prep-system-prompt` 同一份）→ AGENTS.md / 记忆 / 技能 / MCP / 代码库召回一致；
- 工具 `src/agent/main-agent-tools.js`（与定时计划同一份）；
- 压缩 `src/agent/compaction-loop.js`；
- 交付文本与「带标签思考引用不落库」闸门 `src/agent/agent-round-text.js`；
- 消息与历史 `memory.message_append` / `memory.messages_recent` + `session-context`。

唯一差异：**没有编辑器上下文**（无选区、无未保存文件、无诊断），snapshot 相应字段留空，
`includeEditor: false`。请求快照的来源标为 `channel`（`request-snapshot.js#SNAPSHOT_SOURCES`）。

频道会话写的是**同一份账本**，所以桌面的「历史对话」里能看到 `[企业微信] 名称`（落在频道指定的
工作空间分组下），点开可以读整条对话。为这件事只加了一条通知：新会话建成与轮末各广播一次
`channels:sessions-changed`（`main-entry.js:broadcastToRenderers`），Renderer 收到只刷列表
（`renderer-chat-history.js`，与 `agent:session-title` 同一做法），**不切换当前会话** ——
否则就退回到「外部消息抢桌面焦点」的老问题。

## 在微信里换项目（工作空间）

设置里的「默认工作空间」只是**新会话的起点**。真正在群里干活时经常要换项目，而外部频道没有
渲染器那个工作空间选择器，所以这件事做成了一条工具 `session_set_workspace`。

- **一个工具名，两种执行现场**：桌面上由渲染器执行（`renderer-workspace-ssh.js#applySessionWorkspaceFromTool`
  → `applyLocalWorkspacePath`，即工作空间选择器那条流程：改视图 + 绑会话 + 重载编辑器/终端；
  列在 `RENDERER_ONLY_TOOLS` 里，Main 收到只做反委托）；频道里由 Main 执行
  （`channels/workspace-switch.js`，列在 `CHANNEL_RUNTIME_TOOL_NAMES` 里）。
  两边各写自己那份「真相」：桌面归渲染器视图，频道归会话绑定 —— 单边改只会让 UI 与账本脱钩。
- 与 `session_new` 的分工：本工具**不动当前会话**（消息与历史留着），只换它绑定的目录；
  要一个干净起点、新开对话才用 `session_new`。
- 为什么不做「消息里认关键词」：用户说的是「切到代账那个项目」，认词表既脆又违反意图硬编码禁令；
  模型本来就看得见工具清单，让它显式调一次，参数与结果都留在 trace 里可查。
- **频道里的候选集由 Main 决定**：频道默认目录 + 本机已有会话的工作空间（就是桌面左侧那些项目文件夹），
  支持绝对路径、目录名精确、目录名唯一子串三种匹配；匹配到多个会要求指明，匹配不到就把候选列出来。
  **不接受任意绝对路径** —— 企微群聊里任何人都能给机器人发消息，不能让一句话把 Agent 指到系统目录。
  要聊一个从没在桌面打开过的项目，先在桌面打开一次（顺带有了索引与 AGENTS.md）。
- 生效方式：`bindSessionWorkspace`（会话行 + 进程内上下文，唯一写入点）→ 把选择记进
  `channels.json` 的该会话记录 → 下一轮开跑用它，`默认工作空间` 不再覆盖它；说「切回默认」
  （工具参数 `default`）清掉覆盖。
- 时间的诚实边界：**系统提示 / AGENTS.md / 索引是本轮装配的**，换目录只能从下一轮算数。
  频道里后续工具调用的工作空间立刻改用新目录（`agent-turn` 里那个变量就地更新），桌面则要等下一轮
  —— 工具返回里的 `note` 都把这件事说明白，模型据此收尾而不是继续在旧目录里干。
- 桌面侧：会话行的工作空间变了，广播 `channels:sessions-changed` 后历史列表把它挪到新项目分组下。

## 企微协议帧

| 方向 | 帧 | 说明 |
|------|----|------|
| → | `aibot_subscribe {bot_id, secret}` | 订阅；同一 bot 只允许一条长连接，新连接顶掉旧的 |
| → | `ping` | 应用层心跳 25s（不开 ws 自带 ping） |
| ← | `aibot_msg_callback` | 用户消息；`headers.req_id` 是回复凭据 |
| ← | `aibot_event_callback` | 事件（`enter_chat` → 发欢迎语，欢迎语为空则不发） |
| → | `aibot_respond_msg {msgtype:'stream', stream:{id,finish,content}}` | 同一 `stream.id` 反复发 = 打字机；`finish:true` 收尾 |
| → | `aibot_respond_welcome_msg` | 欢迎语 |
| → | `aibot_send_msg` | 主动推送（群 `chatid` / 单聊 `single:<userid>`） |

服务端 `errcode != 0` 一律记日志并在设置页显示，**不静默重试**。

## 附件与推送的边界

- **图片**：下载 → 当轮多模态 part（`image_url` data URL）→ 同时 `storeVisionImage` 落一份只读副本，
  账本里留 `[图片] <路径>`，后续轮可引用。
- **文件**：下载到 `<userData>/channels-inbox/<channelId>/`，账本里留 `[附件] <路径>`，Agent 用普通文件工具读。
  收件箱是**缓存**：只保留最近 7 天（`pruneInboxDir`），否则群里每天发文件会把磁盘吃到用户自己都不认识。
- **语音**：用企微给的识别文本（`body.voice.content`）当作用户输入。
- **出网**：附件 URL 来自回调体（群里人人可控），一律先过 `gateway/web/url-safety.js` 的 SSRF 校验，
  再**边收边计数**（`readBodyCapped`）——`content-length` 可以撒谎，不能把身子整块读进内存再判大小。
- **主动推送**：帧形状照长连接文档的 `aibot_send_msg`；返回值区分三种结局（见下节「回执」），
  设置页有「发一条测试推送」自检。

## 回执与失败：别报假的成功

长连接是「发出去就算」的，`ws.send` 成功不代表服务端受理。这几处都按「问到底」处理：

| 场景 | 结局 | 用户看到 |
|------|------|----------|
| 主动推送，服务端回 `errcode=0` | `{ ok:true, ack:'ok' }` | 已推送（服务端已受理） |
| 主动推送，服务端回 `errcode≠0` | `{ ok:false, ack:'rejected', errcode }` | 推送失败 + 服务端原文 |
| 主动推送，5s 内没有任何回执 | `{ ok:true, ack:'timeout' }` | 已发出，5s 内没等到回执（该机器人版本可能不回 ack） |
| 一轮处理失败，错误标记了 `userSafe` | 原文回微信 | `处理失败：<用户能自己修的原因>` |
| 一轮处理失败，内部错误（RPC / sqlite / 堆栈） | 只进日志 | `处理失败，详情见桌面端「设置 → 频道」日志。` |

群聊里任何人都看得见这条回复，所以「给用户看什么」是白名单式的：只有明确标了 `userError(...)`
的才原样发出去，其余一律通用文案。

## 定时器与连接自愈

- **心跳判活**：`ping` 每 25s 一次；**发了心跳但 100s（`HEARTBEAT_MS * 4`）内没有任何回帧**就判定半开连接，
  摘掉旧 socket 重连。只发不收的心跳等于没有心跳：网络静默失效（休眠唤醒、NAT 丢包）时 TCP 还是 OPEN，
  `ws.send` 一直「成功」，频道会静默失联到用户手动重启。
- **重连退避**：3s 起指数退避到 60s，收到任何帧就重置。固定 3s 硬撞在「连接被顶掉/对端不可用」时
  只会把服务端和自己一起拖进抖动。
- **状态不再卡死**：`errcode≠0` 只表示「上一条命令失败」，收到后续正常帧即回到 `online`（以前会永久红着）。
- **重投去重**：同一条 `aibot_msg_callback` 的 `req_id` 只放行一次（500 条有界窗口）。
  服务端重投（断线重发 / 跑得比重投窗口久）不能让同一句话把 Agent 跑第二遍 —— 工具副作用会翻倍。

## 停频道 / 改配置的边界

- **停 = 真的停**：`stopChannel` 先 `abort` 该频道所有在跑的轮次，再关连接。以前只关连接不中止，
  那一轮会在断掉的连接上继续跑满 900s（继续吃 token、继续写账本），而用户那头永远停在「已收到，正在处理…」。
- **改展示字段不断线**：只有「启停 / 换 botId / 换 Secret」才重连（`applyChannelState({ connectionChanged })`）。
  改个名字就断一次连接，会打断正在跑的一轮。
- **测试连接不顶线上连接**：服务端同一 bot 只允许一条长连接。频道在线且凭据没变时直接采信现有连接；
  必须真探测时先摘连接、测完恢复；频道正在处理消息时直接拒绝（否则会打断那一轮）。
- **配置文件坏了不清空**：`channels.json` 解析失败抛 `CHANNEL_STORE_CORRUPT` 并保留原文件。
  以前 catch 成空态，用户随便点一次保存就把整个文件覆盖成「只有这一条频道」，其余频道与会话映射全丢。

## 已知边界（不改的）

- **同一会话被两个入口同时驱动**：桌面开着某条 `[企业微信]` 会话并自己发消息，同时微信里也在聊。
  两边各跑各的循环（工具调用仍按工作空间串行）。账本是 append-only，最坏情况是消息交错，
  不会互相覆盖文件；真要一个人干就切到别处去。
- **群聊 = 谁的权限**：机器人用的是本机 Agent 的权限。只把机器人拉进你信任的群，
  否则等于把「能在你电脑上跑命令」的能力交给群里每个人。
- **频道级模型路由**：现在用默认文本模型。

## 安全

- Secret 只以 safeStorage 密文落盘，`channels.json` 按 0600 写；对外视图只给 `hasSecret` 布尔值，
  编辑时 Secret 不回显、留空即不修改。
- 频道工作空间是**会话绑定**（`sessions.workspace_path` + 进程内上下文两处都写，见
  `src/agent/session-workspace-bind.js`）：之后在桌面切工作空间不会把频道会话拽走。
- 微信里能切到的工作空间有硬边界：只限频道默认目录与本机已有会话的工作空间（见上一节），
  群聊里任何人都发消息，不能让一句话把 Agent 指到系统目录。

## 测试

```bash
npx vitest run test/unit/channels-core.test.cjs test/unit/channels-runtime.test.cjs \
  test/unit/channels-turn.test.cjs test/unit/channels-workspace-switch.test.cjs \
  test/unit/channels-wecom-client.test.cjs test/unit/channels-store-robustness.test.cjs
npm run test:unit        # 全量单测
npm test                 # 按 diff 的 smoke
npm run check:renderer   # 设置页脚本/全局
```

`channels-wecom-client.test.cjs` 用假 socket（`createSocket` 注入缝）钉住真机难复现的时序：
重投去重、半开连接判活、推送回执三态。`channels-store-robustness.test.cjs` 钉住
「配置文件坏了不清空」与「会话映射活跃时间刷新」。

端到端（需要真机器人）：设置 →「频道」→ 添加 Bot ID/Secret → 测试连接 → 保存 →
微信里给机器人发一句话 → 桌面会话列表里出现 `[企业微信] 名称` 的会话，且**桌面当前会话没有被切走**。
换项目：微信里说「切到 <某个桌面用过的项目>」→ 会话行的 `workspace_path` 变过去（桌面历史里这条会话
会挪到新项目分组下）；说「切回默认」再变回频道默认目录。

## 未做

- 频道级模型路由（现在用默认文本模型；`resolveTextApiConfig` 已支持 route，接一个字段即可）。
- 独立推送目标选择器（现在手填 chatid / `single:userid`；日志里能看到实际值）。
- 图片/文件的**回传**（只处理微信发来的附件；让 Agent 主动往微信发图未做）。
- 设置页不自动刷新连接状态（点「刷新」或触发一次操作才拉；`channels:sessions-changed` 只管会话列表）。

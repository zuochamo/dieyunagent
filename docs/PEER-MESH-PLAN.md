# 内网 Agent 互通（peer mesh）

> 状态：**已实施 P0 + P1 授权**（传输 + 自主互发 + 会话即通道 + presence + 建议式租约 + 按机器确认的信任清单）。
> 代码入口 `src/peer/`；工具 `peer_list` / `peer_send` / `peer_claim`；UI：标题栏「连接」图标 → 「Agent 互通」标签页。

## 1. 要解决的三件事

1. **同项目协同开发**：同一份仓库在两台（或多台）机器上同时被 agent 改，需要知道「谁在改什么」。
2. **agent 自主互相通信**：A 的 agent 可以直接问 B 的 agent 要事实、要结论，不必人来转述。
3. **通过会话给其他 agent 发消息**：打开一个会话，在里面打字就是发给那台 agent；对方的回复落回同一个会话。

## 2. 心智模型（先看这个）

- **一台机器 = 一个 peer**：稳定 `peerId`（`peer_<18hex>`），可改的显示名。**没有配对码**：谁能发给我由本机信任清单决定。
- **一句话 = 一封信封**：有发信人、跳数、可选的回复引用。没有共享状态，没有远端会话读取。
- **一个会话 = 一条到某个对端的通道**：会话绑定对端后，在里面打字 = 发消息给它，不消耗本机模型。
- **一封信最多触发一轮**：对方收到后可以自己跑一轮（可关），跑完把**最终正文**回传；回复不再自动触发下一轮以外的东西。
- **租约是建议，不是锁**：它让「我要改这个文件」变成看得见的事实；真正的隔离仍是 worktree + git。

## 3. 分层

| 层 | 文件 | 职责 |
|---|---|---|
| 线协议 | `src/peer/wire.js` | 帧类型、信封归一（长度/跳数裁剪、坏信封丢弃）、租约归一 |
| 落盘 | `src/peer/store.js` | 身份 / 信任清单 / 会话绑定 / 手工对端 / 开关，唯一写盘点 |
| 项目身份 | `src/peer/workspace-key.js` | 「同一个项目」判定：git remote（含 worktree 的 `commondir`）→ 仓库名 → 路径指纹 |
| 发现 | `src/peer/discovery.js` | UDP 广播宣告 + 过期清理；静态对端永不过期 |
| 服务端 | `src/peer/server.js` | WS `/peer`，握手换身份（未确认机器不给租约快照），收信 → 协调器，`/api/peer/info` |
| 客户端 | `src/peer/client.js` | 一请求一连接（hello → msg → ack → 可选等回复） |
| 协调器 | `src/peer/coordinator.js` | **全部语义**：落会话、自动跑一轮、跳数/预算门、回传、租约仲裁、事件 |
| IPC | `src/main/ipc/peer.js` | Renderer 命令入口（`peer:*`），不做判定 |
| 工具 | `src/agent/tool-catalog.js` + `tool-bridge-main.js` | 三个 `peer_*` 工具，形状转换而已 |
| UI | `src/renderer/renderer-peer.js` | 面板 + 会话发送路由 |
| 局域网地址 | `src/net/lan.js` | 网卡枚举/评分/子网广播地址（手机桥与 peer 共用） |

数字全部在 `src/agent/agent-limits.js` 的 `peer*` 一组；不要在别处写常量。

## 4. 协议

帧（JSON over WS text frame）：

| 帧 | 方向 | 说明 |
|---|---|---|
| `hello` | 连入方 → | `peerId / name / workspace / claims / port`（**不带共享密钥**） |
| `hello_ok` | → 连入方 | 对端身份 + `trusted`（对方是否已确认我）+ 当前租约（**只发给已确认的机器**：陌生人看不到我在改什么） |
| `hello_err` | → 连入方 | 握手层面拒收（畸形帧等；**授权拒收走 `ack` 的 `NOT_TRUSTED`**） |
| `msg` | 双向 | 信封；服务端收到后回 `ack` |
| `ack` | 双向 | `{id, ok, error, data}`；租约冲突在这里返回 `holders` |
| `ping/pong` | 双向 | 保活 |

信封类型：`message` / `reply` / `claim` / `claim_reply` / `release` / `presence`。

关键字段：`id`（去重）、`hops`（跳数，发出 +1，上限 `peerMaxHops`）、`inReplyTo`、`from.{peerId,name,sessionId}`、`text`（上限 `peerMaxMessageChars`）。

**防伪**：服务端一律用握手得到的身份覆盖 `env.from.peerId`，客户端传什么都不作数。

## 5. 发现

- UDP4 广播（`peerDiscoveryPort`，默认 17341），每 `peerDiscoveryIntervalMs` 宣告一次；`255.255.255.255` + 每个网段的广播地址。
- 收到 `announce` 时**单播回一条 `here`**：不依赖对方也能广播。
- 超过 `peerPresenceTtlMs` 未续期的条目发 `gone`。
- `static-peers.json` 用于跨网段/广播被挡的场合：手工填 `host:port`，永不过期。
- 握手学到的对端也会进列表（UDP 被防火墙挡住时仍有反向通路）。

## 6. 授权与安全边界

- **没有配对码**（P1 起取消）。谁能给我发消息由本机的**信任清单**决定：`<userData>/peer/trusted-peers.json`，按 `peerId` 记 `allow` / `deny`。
- 流程：陌生机器第一次来信 → 拦下这条（内存里最多攒 `PEER_PENDING_MAX`=5 条）+ 发 `trust-request` 事件 → 面板/弹窗问一次「允许 / 拒绝」。
  - 允许 → 写 `allow`，**并把攒下的那几条按顺序补投**；
  - 拒绝 → 写 `deny`，之后静默丢弃，不再打扰；
  - 撤销 → 删掉记录，回到「不认识」，下次来信重新问。
- 发送方视角：被拦时拿到 `NOT_TRUSTED`（不可重试），握手回执里 `trusted=false`，工具层直说「对方还没确认这台机器」。
- **按 `peerId` 而不是 IP 记**：DHCP 回收 IP 会让「同一个 IP 换了一台机器」变成免确认的旁路。重装 = 新 `peerId` = 重新确认，这是想要的语义。
- 未确认的机器**看不到租约快照**（`hello_ok.claims` 只发给已确认的机器）：我在改哪些文件不泄露给陌生人。
- 没有加密、没有签名、没有证书；**信任模型是「同一内网 + 你点过一次允许」**。不要在不可信网络里开。
- 收到信的 agent 与本地用户同等权限（它就是你自己的 agent 在跑）。所以：跳数与小时预算双重限流、来信带来源抬头、**默认不让来信触发跑一轮**（见 §8）。

## 7. 会话即通道

- `store.links` 记录 `sessionId → peerId`，一对多（同一个对端可以有多个会话）。
- 「发消息」按钮：`peer:open-session` → 复用/新建「与 <名字> 的对话」→ 绑定 → 切过去。
- 发送路由在 `renderer-agent-send.js` 的 `sendMessage` 最前面一行：命中 `routePeerSessionSend` 就直接发给对端（先 `memory.message_append` 落库，再由 Main 发出去，最后按会话重载），**不跑本机模型**。
- 排除外部触发（`agentServiceRequestId` / `source=peer|agent-service|plan`）：否则「对方来信 → 本机跑一轮 → 又把原话发回去」会两边弹皮球。

## 8. 自动跑一轮的门

一封来信要自动开跑，必须同时满足：

1. 设置里 `autoTurn` 打开（**默认关**：只投递到会话，用户自己点开看）；
2. 发送方已在本机信任清单里（`allow`）；
3. `hops < peerMaxHops`；
4. 该对端最近 1 小时内自动轮数 `< peerTurnBudgetPerHour`；
5. 信封 `id` 未见过（内存 LRU，防重放）。

不满足时**只投递不跑**：把抬头 + 正文 `memory.message_append` 进会话，跳过原因记在事件里（`auto_turn_off` / `hops_exhausted` / `budget_exhausted`）。
`task.completed.summary` 只有 400 字，所以正文由 `task.progress.streamContent` 累积（`noteTurnProgress`），回传时优先用它。

> 已知代价：走 `AgentService.submitTask`（与手机端同一条路径，保证单一来源）会让 UI 切到那个会话。
> P1 可加 `background` 标记让 Renderer 跳过 `openAgentServiceSession`。

## 9. 建议式租约

- `peer_claim(action=acquire|release|list, kind=file|task, key, note)`；TTL `peerClaimTtlMs`（15 分钟）。
- 索取时先查已知（握手 + 广播得到的）持有者，再向所有在线对端广播，等 `peerClaimWaitMs` 收集冲突。
- 冲突返回 `CLAIM_CONFLICT` + `holders`（谁、为什么）。**不阻止写入**：硬锁在跨机器上没法保证公平，且 worktree + git 才是真隔离。
- 契约：改完就 release；不要绕过租约闷头改。

## 10. 工具 / IPC / 事件

工具（schema 在 `tool-catalog.js`，执行在 `tool-bridge-main.js`）：

| 工具 | 用途 |
|---|---|
| `peer_list` | 谁在线、是否同项目、对方已声明什么租约（`refresh` 主动宣告一次） |
| `peer_send` | 给对端发一句话；`expectReply=true` 等它跑完一轮再返回答复 |
| `peer_claim` | acquire / release / list 租约 |

IPC（`src/main/ipc/peer.js`）：`peer:status/refresh/set-name/set-enabled/set-auto-turn/trust/untrust/trust-list/set-static-peers/send/send-session/open-session/link-session/unlink-session/claim`；推送 `peer:event`（`kind=inbound|inbound-stored|reply-stored|links-changed|peers-changed|claims-changed|trust-request|trust-changed`）。

## 11. 数字上限（`src/agent/agent-limits.js`）

`peerMaxHops` 4 · `peerTurnBudgetPerHour` 12 · `peerMaxMessageChars` 8000 · `peerMaxPeers` 64 ·
`peerSendTimeoutMs` 20s · `peerReplyTimeoutMs` 120s · `peerDiscoveryPort` 17341 ·
`peerDiscoveryIntervalMs`/`peerPresenceIntervalMs` 30s · `peerPresenceTtlMs` 90s ·
`peerPortBase` 17350（+`peerPortTryCount` 11） · `peerClaimTtlMs` 15min · `peerClaimWaitMs` 1.5s

## 12. 验收

自动（`npm run test:peer`）：

- `scripts/test-peer-store.cjs`：身份持久化、信任清单（allow/deny/撤销/持久化/非法输入）、会话绑定、手工对端清洗、开关默认值、项目 key（含 worktree `commondir`）。
- `scripts/test-peer-tools.cjs`：三个工具在工具层的形状（`PEER_UNAVAILABLE` / `MISSING_ARG`+`diagnostics.peers` / `PEER_NOT_FOUND` 不可重试 / 连不通可重试 / 租约 acquire-list-release）。
- `scripts/test-peer-mesh.cjs`：进程内两台实例回环互连 — 陌生来信被拦（`NOT_TRUSTED` + 待确认 + 不落会话不跑）、允许后补投、**默认不自动跑**、打开后跑一轮、**回合结束回传完整正文**、跳数用尽只投递、**小时预算用尽只投递**、presence + 同项目 + 信任状态、**会话发信 → 对端跑一轮 → 答复落回同一会话**、租约冲突/广播/释放、线协议归一、陌生机器拿不到租约快照、拒绝后静默、撤销后重新确认。

手工（两台真机，同一局域网）：

1. 两台都开「Agent 互通」：标题栏左上角图标条里的**「连接」**图标（两台设备连着那个）→ 切到「Agent 互通」标签页 → 勾「启用内网互通」。面板里的在线列表应互相出现（**不需要配对码**）。

> 手机连接与 Agent 互通共用一个「连接」图标、两个标签页（外壳在 `src/renderer/renderer-connect.js`；手机侧仍由 `renderer-mobile.js` 渲染，互通侧由 `renderer-peer.js` 渲染）。
2. A 点「发消息」→ 打开的会话里问一句具体的（例如「src/peer/wire.js 的信封归一在哪个函数」）；B 侧应**弹一次确认**，点「允许」后这条补投进会话。因为默认 `autoTurn` 关，B 只落会话不跑。
3. 在 B 勾上「收到消息自动跑一轮」：A 再发，B 自己跑一轮，回答回到 A 的会话。
4. 把 B 的信任清单里撤销 A：A 再发应重新弹确认。
5. 把 A 的 `peerMaxHops` 调到 1 之后连发多次：确认不再自动跑（防互相撩）。
6. A `peer_claim(acquire, file, src/peer/wire.js)`，B 再 acquire 同 key：B 应拿到冲突与持有者。

## 13. 已知限制 / 不做的事（减法记录）

| 不做 | 原因 |
|---|---|
| 中心节点 / 服务端中转 | 内网场景直连即可；多一个服务端就多一份要部署、要鉴权、要保活的东西 |
| 离线队列 / 重投 | 对端不可达就把错误如实给 agent（`PEER_UNREACHABLE`）；悄悄排队会让「它到底收到没有」变成不可知 |
| 读对端会话历史 | 等于绕过「消息即接口」：谁都能翻别人上下文，就无法判断哪句话是给自己的 |
| 硬文件锁 | 跨机器公平锁成本高、失败模式差（进程死了锁还在）；worktree + git 才是隔离 |
| 消息加密 | 信任模型是「同一内网 + 你点过一次允许」；引入加密等于引入密钥分发，收益与成本不匹配 |
| 意图关键词路由 | 发给谁只由「会话绑定 / 显式 peer 参数」决定，不做词表猜测 |
| 共享配对码 | P1 起删除：一次确认就能记住一台机器，比「两边手工对齐一个串」少一步且更准；**按 `peerId` 而非 IP 记**，DHCP 换 IP 不会变成免确认旁路 |
| 待确认来信落盘 | 只在本机运行期内攒着（最多 5 条）；进程退出就丢，对方重发即可 —— 不为此引入一张新表 |

P1 候补：`background` 自动轮（不抢 UI）、跨实例消息去重落盘（重启后仍防重放）、租约与 worktree 联动（拿到租约才允许创建 worktree）。

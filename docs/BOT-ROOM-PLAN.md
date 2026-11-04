# Bot 面板与房间（内网 Agent 协作）

> 状态：**第 1–4 步已实施**（侧栏 `bot` 页签 + 上下两层；「连接 → Agent 互通」退成设置；
> 房间对象落库 + 建 / 关 / 校验；房间时间线聚合 + 「发所有人」扇出；工作身份 `role` 随握手广播、只做展示）。
> 关联：`docs/PEER-MESH-PLAN.md`（内网互通协议与信任清单，已实施）、`src/peer/`。

## 1. 要解决的四件事（用户诉求）

1. 面板区有一个 bot 图标；
2. 右侧区域分两层：**上层 = 已允许内网通讯的其他 agent**，下层 = **沟通区域（agent 聊天室）**；
3. 发起任务的 agent 呼叫内网 agent、分配任务、结束聊天；
4. 通讯时每个 agent 有自己的**工作身份**。

## 2. 先认清：八成本来就有

| 诉求 | 既有实现 | 缺什么 |
|---|---|---|
| 可信 agent 列表 | `peer/store.js` 信任清单 + `discovery.js` UDP 发现 + presence + 同项目标记 + 租约 | 只是排版（上下两层） |
| 沟通区域 | `sessionId ↔ peerId` 绑定，每个对端一个「与 X 的对话」 | **多 agent 同屏（房间）** |
| 呼叫 / 派任务 | `peer_send`（`expectReply` 等对方跑完一轮）+ 自动跑一轮 + 跳数/小时预算 | **「任务」作为一等对象**（先不做，见 §6） |
| 工作身份 | 机器级 `peerId` + 显示名 + 文件租约 | **agent 级身份**（会话级人设/职责） |

所以这不是新模块，是 `src/peer/` 的展示层与语义增量。

## 3. 三个已定决策

**① 入口单一**：侧栏 `bot` 页签是唯一展示处（列表 + 房间）。
「连接 → Agent 互通」退成**设置页**（名称 / 启用 / 自动跑一轮 / 手工对端 / 信任清单管理），不再渲染列表与对话。
理由：同一份 peer 数据两处渲染必然漂移。

**② 房间靠扇出，不做中继**：房间 = 本地面板的一个**视图**，发消息仍逐条走 `peer:send`；
「发所有人」= 循环 N 次（受既有 `peerMaxHops` / 每小时回合预算 / `peerSendTimeoutMs` 约束）。
不新增线协议、不加房间服务、不加存储表。

**③ 房间 = 一次任务**：同一项目可并行多个房间；「结束」= `status: 'closed'`，
效果是**该房间的来信只投递、不再自动跑一轮**（新增 skip 原因 `room_closed`），
**不删会话、不删消息**。

## 4. 数据

```js
room = {
  roomId: 'r-<ts36>-<rand6>',
  title: '修发票模块',
  projectKey: '<workspace-key.js 的同项目判定结果>',
  members: ['peer_xxx', ...],   // 上限见 §5
  status: 'open' | 'closed',
  createdAt, closedAt           // closedAt = 0 表示还没结束
}
```

- 落盘：`<userData>/peer/rooms.json`（`src/peer/store.js` 是唯一写盘点，与信任清单/会话绑定并列）。
- 有界保留：`pruneRooms(peerRoomKeepMax)` 只在超出时丢**最老的已关闭**房间；打开中的永不丢。

**消息不写 `meta.roomId`**（原计划的这一步已废弃，原因如下）：
`memory.message_append` 只收 `{sessionId, role, content, reasoning}`，加 `meta` 要动
Gateway + Rust 表结构；而**房间时间线本来就能算出来** —— 每个成员各有一条
「与 X 的对话」会话（`links`），房间时间线 = 这些会话在 `[createdAt, closedAt)` 内的消息。
用时间窗聚合，零新字段、零表结构改动，与「links 是缓存、真相在 sessions 表」同一精神。

`roomId` 仍然会随信封传（`wire.js` 的 `roomId` 字段），但只做两件事：
**发送侧的成员/状态校验**，以及**接收侧认出「这是本机某个房间的消息」**（用于抬头与是否自动跑）。

## 4b. 语义与错误码（第 2 步实现，唯一来源 `src/peer/coordinator.js`）

| 动作 | 判定 | 失败码 |
|---|---|---|
| 建房间 | 至少 1 个成员；成员必须已在信任清单 `allow`；成员数 ≤ `peerRoomMaxMembers`；同时打开的房间 ≤ `peerRoomMaxActiveRooms` | `ROOM_NO_MEMBERS` / `PEER_NOT_FOUND` / `PEER_NOT_TRUSTED` / `ROOM_TOO_MANY_MEMBERS` / `ROOM_LIMIT` |
| 以房间名义发 | 房间存在、状态 `open`、目标是成员（直连 host+port 拿不到 peerId 也算不通过） | `ROOM_NOT_FOUND` / `ROOM_CLOSED` / `PEER_NOT_IN_ROOM` |
| **发所有人（扇出）** | 同上 + 逐台并发 `peer:send`，**不等对方跑完一轮**；部分成功就是部分成功（`delivered` / `failed` 逐台返回，不重试） | 同上；全失败时返回首台错误码 |
| **房间时间线** | 成员会话 × `[createdAt, closedAt]` 聚合，按时间正序，最多 400 条；会话被删只影响那条线 | — |
| 收到带 `roomId` 的来信 | **本机也有**这个房间、**且对方是成员**、且已结束时：只投递、不自动跑一轮（否则按普通来信处理，不猜、不补建、不给标签） | skip 原因 `room_closed` |
| 结束房间 | 幂等；只改状态与 `closedAt`，**不删会话、不删消息**（时间线仍可读） | `ROOM_NOT_FOUND` |

事件：`room-created` / `room-closed` / `room-sent`（Renderer 与 Main 共用同一份事件流）。
IPC：`peer:rooms` / `peer:room-create` / `peer:room-close` / `peer:room-send` / `peer:room-timeline`；
工具 `peer_send` 可选 `roomId`（给了 `roomId` 又不给 `peer` = 发房间所有人）；
`peer_list` 返回 `me`（本机身份）+ `rooms`（打开的房间，含 roomId）—— 模型靠它才知道房间 id。

## 5. 数字上限（进 `src/agent/agent-limits.js`，别处不写常量）

| 常量 | 值 | 为什么 |
|---|---|---|
| `peerRoomMaxMembers` | 8 | 扇出成本 ~N²，且超过 4 人对话人已经跟不动；`peerMaxPeers`(64) 是发现上限，不能当房间上限 |
| `peerRoomMaxActiveRooms` | 4 | 房间是任务，同时进行 4 个已经很满 |
| `peerRoomKeepMax` | 64 | 房间记录的有界保留（先丢最老的已关闭房间） |

复用既有：`peerMaxMessageChars` / `peerMaxHops` / `peerTurnBudgetPerHour` / `peerSendTimeoutMs`。

## 6. 明确不做（以及什么时候才改主意）

| 不做 | 反证条件（出现才重新评估） |
|---|---|
| 中继 / 房间服务器 / 跨网段广播 | 真实使用出现 ≥5 成员高频互发导致超时与预算打满，或 UDP 广播被防火墙拦、必须跨网段 |
| 任务表 + 状态机（超时重派、未完成判定） | 第 2–4 步用满两周后，仍靠口口相传的任务正文管不住，且能举出 3 个真实漏派/重复派案例 |
| 让所有成员收到消息后互相转发/自由群聊 | 不评估。这是 token 爆炸与"AI 互相客套"的来源；只投递 + 各自按自己预算跑 |
| 把扇出后的答复**汇总回发起者的会话** | 暂不做：答复进各自的「与 X 的对话」，房间时间线看得见，但发起方那一轮上下文里没有。等出现「因为看不到答复而重复询问」的真实案例再说 —— 那说明该做的是「等答复」，不是在 Renderer 拼一份汇总 |
| agent 身份参与授权 | 不评估。授权只认 `peerId` 的信任清单（见 §8 防伪） |
| 在 Renderer 判「谁能自动跑一轮」 | 不评估。语义唯一来源是 `src/peer/coordinator.js` |

## 7. 落地步骤

| 步 | 内容 | 状态 |
|---|---|---|
| 1 | 侧栏 `bot` 页签；上下两层骨架（上：可信列表；下：房间区）；互通页退成设置 | **已实施** |
| 2 | `room` 对象落 `store.js`；建 / 关 / 持久化 / 校验 + 面板最小交互（新建、成员勾选、结束）；信封带 `roomId` | **已实施** |
| 3 | 房间时间线聚合（成员会话 × 存活时间窗）+ 「发所有人」扇出 + 面板房间详情（点房间看对话、发所有人） | **已实施** |
| 4 | 工作身份（自称的角色）：跟 `name` 同源，随 hello / 发现广播出去；面板与来信抬头一律标「自称：X」 | **已实施** |

## 8. 安全边界（不可动摇的两条）

1. **身份不可自报**：服务端一律用**握手得到的身份**覆盖 `msg.from` 的 `peerId` / `name` / `role`
   （`src/peer/server.js`）—— 信封里硬写什么都不采信，已有裸 WS 帧测试盯着这件事。
   工作身份 `role` 只能是**展示用自我描述**，界面必须标成「自称：X」；
   授权、预算、租约一律只按 `peerId`。
2. **房间不放大权限**：收到房间消息的 agent 与本地用户同权限（它就是你自己那台机器上的 agent 在跑）。
   房间只影响「是否自动跑一轮」，不影响能干什么 —— 那仍由沙箱档位与信任边界决定。

## 9. 验收

- 第 1 步：`npm run check:renderer`、`npm run test:peer`；侧栏出现 bot 页签，上层列表与「连接 → Agent 互通」数据一致，下层是房间占位。
- 第 2–3 步（已过）：`npm run test:peer` —— `scripts/test-peer-store.cjs` 断言房间建 / 关 / 有界保留 / 脏条目跳过；
  `scripts/test-peer-mesh.cjs` 断言双实例 + 三实例：成员校验、并行上限、`ROOM_CLOSED`、接收侧 `room_closed` 只投递不跑、
  扇出到两台在线（离线那台记失败、不重试）、时间线只含房间存活期内的消息且按时间正序、结束后时间线仍可读。
- 第 4 步（已过）：`npm run test:peer` —— `test-peer-store.cjs` 断言身份持久化 / 空白折叠 / 32 字上限 / 可清空；
  `test-peer-mesh.cjs` 断言来信抬头带「自称：X」，以及**裸 WS 帧在信封里硬写假身份时被握手身份覆盖**
  （「财务总监」不许出现在正文里）。

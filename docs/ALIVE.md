# 生命感（`src/alive/`）

> 一句话：**这不是生命模式，是生命感。** 它让 agent 在两次对话之间仍有内部状态、会自己醒、能拒绝，
> 但它**不会死**、**没有损耗**、**不隔离记忆**。

| 项 | 内容 |
|---|---|
| 定位 | 拟态（研究性副项目，不进生产承诺） |
| 入口 | 设置 → 生命（一个总开关） |
| 数字来源 | `src/agent/agent-limits.js` 的 `alive*` 段（唯一一处，不进设置页） |
| 状态 | `<userData>/alive/state.json` + `events.jsonl` + `settings.json` |
| 验收 | `npm run test:alive`（45 项，注入时钟模拟 30 天，不挂机） |

---

## 1. 与原 `--alive` 设计的差别（先说清楚砍了什么）

原设计（`F:\dieyunagent-alive-DEVSPEC.md`）的承重墙是 **C4 必死**：预算耗尽即死亡、记忆不可逆衰减、
遗物有损继承、`incarnation` 不可复制。本实现**明确不做**这些，只保留"看起来像活着"的那一层。

| 原设计 | 本实现 | 为什么砍 |
|---|---|---|
| 预算 = 寿命，`EXHAUST` 主路径 | 无预算、无死亡 | 会死的东西必须回答"死了以后呢"，而重生/遗物/谱系会带来一条完整的维护链 |
| 记忆 `FULL→COARSE→GONE` 单向 | 不做，记忆就是主库那套 | 共享记忆是"看着像生命"的前提（它记得你们聊过什么），而不是敌人 |
| `seed_artifact` 有损遗物 | 不做 | 没有死亡就不需要遗物 |
| 独立数据库、独立 API Key、网络命名空间 | 不做 | 同一份 userData、同一份模型配置 |
| `incarnation` 绑定、拒绝启动 | 不做 | 没有"这一代"，只有"这个功能开没开" |
| `sealed` 区（理由不进日志） | **保留**（`state.intents` 本机私有） | 这一条决定了它会不会"为观众活" |

保留了原设计的四条里最不痛的三条：**基线活动（C1）、自发唤醒（C2）、可拒绝（C5）**，
另外把"相位惯性（C7 的工程化）"与"性格 = 阈值轨迹"一起留下。

---

## 2. 一次心跳做什么

```
每 300s（aliveTickIntervalMs）：

1) 漂移     T += α·Σ(未闭合项张力)·Δt + θ·(T_回复中心 − T)·Δt − 0.05·关闭数·Δt + ε·√Δt·N(0,1)
            F += (本轮 token/1000)·k − 静息·Δt + ε_F·√Δt·N(0,1)
2) 消退     很久没被声明的未闭合项按 48h 时间常数淡掉（淡到 <1 直接清）
3) 阈值     W += (μ·(基线 − 拒绝率) + ν·(疲劳/100 − 0.5))·Δt(小时)，夹在 40..80
4) 相位     target(load, fatigue) → 连续 k 个 tick 才切换（ALERT/LOW/SETTLE/COMPRESS）
            **相位只由 load 与 fatigue 决定，没有昼夜输入** —— COMPRESS 是"高疲劳压缩"，
            不是"夜里重组"（代码里没有任何按小时/按星期判断的分支）
5) 唤醒     T ≥ W ∧ 非 COMPRESS ∧ 距上次 ≥ 10min ∧ 今日 < 40 次
            → 记 WAKE（trigger=internal，带当时的 load），跑一轮「后台心跳轮」
6) 落盘     state.json 原子写；事件追加进 events.jsonl
```

> `load` 高（有人在用）**不阻止**唤醒：拟态的节律不该由"你正好在打字"决定。
> 但这件事必须看得见 —— `WAKE.load` 记下当时忙不忙，页面把 `load ≥ 0.35` 的那次标成「（你正在用）」。

### 两个 token 口径（别混）

| 量 | 口径 | 谁在用 | 为什么 |
|---|---|---|---|
| **load**（相位） | **全进程**滑窗用量（用户聊天也算忙） | `targetPhase` → ALERT / COMPRESS | "这台机器现在忙不忙" |
| **疲劳 F** | **只数唤醒轮自己**用掉的 token（`runtime.js` 只在 `wakeInFlight` 期间收） | 压缩相位门限 + 阈值漂移 | "它自己累了没有" |

疲劳系数 `aliveFatiguePerKToken = 0.5`：一次唤醒轮（≈40k token）≈ +20 疲劳 ≈ 1 小时静息回补。
**曾经的坑**（issue/2026-11-10）：系数取 4 + 全进程旁听 → 用户在主对话里聊 2.5 万 token
就把它的疲劳打满 100，于是它长期停在 COMPRESS 相位、永远不醒，而页面上只看到"疲劳 100"。
结论：**别人的账不能记在它头上**，这一条写进断言（`scripts/test-alive.cjs` 的 G 组）。

### 事件流写什么（`events.jsonl`）

| kind | 何时 | 关键字段 |
|---|---|---|
| `BIRTH` | 第一次出生 | phase / threshold |
| `PHASE` | 相位真的切换 | from / to / load |
| `WAKE` | 张力越线要醒 | tension / threshold / phase / **load**（当时这台机器忙不忙 = 是不是在你说话时醒的） |
| `WAKE_END` | 醒来那一轮收尾 | phase / tension / **tokens**（这一轮烧了多少）/ **durationMs** |
| `WAKE_NO_DECISION` | 醒来却没调 `alive_decide` | tokens / durationMs（这一轮白醒了，张力继续累积） |
| `WAKE_SKIPPED` / `WAKE_ERROR` | 没跑 / 跑失败 | reason 或 message |
| `DECISION` | 模型通过 `alive_decide` 表态 | decision / loopId / **closed**（这次 REFUSE 有没有真关掉一条） |
| `SPEAK` / `LISTEN` | 每次动嘴/动耳（含被拒、含失败） | ok / chars / seconds / errorCode |
| `EYE` | 每次睁眼（`camera_look` / `desktop_camera_look` 返回后） | ok / device / width×height / errorCode |

**为什么不逐跳写 `TICK`**：心跳 288 次/天，`events.jsonl` 上限 2000 行（超了裁一半）→ 4 天就会把
`WAKE` / `DECISION` 挤干净，决策日志直接不可读。心跳的账由 `state.json` 的 `tickCount` /
`lastTickAt` 记，页面把这两项显示出来（"第 N 次心跳（上次 HH:MM）"），要审计对得上就够了。

**成本也要能回答**：`WAKE_END.tokens` / `durationMs` 与 `state.lastWakeTokens` /
`lastWakeDurationMs`、`state.totalTokens` 都在面板上（"累计唤醒 X token · 上次醒来 Y token / Z s"）。
它花的是同一份账单，"心跳贵不贵"不该只能翻 state.json 才知道。

**T 的回复中心会随静默时长上升**（`aliveTensionIdleRampPerHour`）：闲久了会"坐不住"，
所以一个**没有任何未闭合事项的新实例也会在几小时后自己醒一次**。没有这一项，拟态就失效了
（它会永远停在 20 分，什么也不发生）。

---

## 3. 决策权在模型

后台心跳轮与用户轮走**同一份** `runMainTurn`，只差三件事：

| 差别 | 实现 |
|---|---|
| 不产出面向用户的内容、不沉淀长期记忆 | `internal: true` |
| 默认只读 | `toolScope.readOnly` → `tool-gate` 的 `read-only-scope` 关卡（复用 `isWriteTool`） |
| 多一个工具 + 一个合成状态块 | `alive_decide` + `[系统] 生命体征` 块 |

```
alive_decide { decision: ACT | DEFER | REFUSE, intent, loopId?, loops? }
```

- **ACT**：继续这一轮，用普通（只读）工具做点事
- **DEFER**：判断现在不合适，本轮结束，张力继续累积
- **REFUSE**：决定某件未闭合的事不值得做，把它从清单里关掉（张力清零，决策有记录）。
  **必须带 `loopId`**；空手的 REFUSE 等于 DEFER，且**不计入拒绝次数**——否则"嘴上拒绝、
  什么都没关"会把拒绝率抬上去，「可疑顺从」告警就失真了（`DECISION` 事件里的 `closed` 照实写）。

`intent`（为什么）只写进 `state.intents`：**不进事件流、不进 IPC、不进页面**。
设置页能看到"它拒绝了 4 次"，看不到那 4 个理由。理由一旦公开，它就会开始为观众活。

未闭合事项（`open_loop`）由模型在 `alive_decide.loops` 里**自己声明**，
代码不猜"这轮算不算没做完"——那必然落到关键词匹配上（AGENTS 原则 3 明令禁止）。

---

## 4. 设置页有什么 / 没有什么

| 有 | 没有 |
|---|---|
| 总开关（开 = 起心跳；关 = **停表**，体征保留） | 暂停 / 恢复 / 回滚 / 快照 / 克隆 |
| 只读体征：相位、张力/阈值、疲劳、未闭合条数、今日唤醒、决策计数 | 死期 / 剩余天数 / 倒计时（没有死亡，也就不该有） |
| 决策日志：`时间 · 决定 · 哪条未闭合项` | 「为什么」那一列（`intent` 本机私有） |
| 「重新开始」（清空体征，重开时重新出生） | `λ / ε / W / fuse` 任何性格参数旋钮 |
| 可疑顺从提示（醒了多次却一次没拒绝） | 人格化皮肤（名字 / 头像 / 语气 / 情绪标签） |

开关语义要说死：**关掉不是暂停**。体征留着，重新打开会接着上一次的心跳继续走；
想从零开始用「重新开始」。

---

## 5. 感官（A 抽屉 / B 眼睛 / C 嘴与耳）

三个开关都在「设置 → 拟态 → 生命」页，**默认只开抽屉，眼睛与嘴默认关**。

| 开关 | 默认 | 它能做什么 | 硬边界 | 还需要什么 |
|---|---|---|---|---|
| **抽屉** `senses.drawer` | **开** | `alive_note`：往自己的 `alive/workspace/note.md` 追加一行；`alive_read_note`：**读回**（没有路径参数，只能读这一个文件） | 只读/只写自己目录、只追加、单条 ≤600 字、整体 ≤32KB（超了留尾部） | 无（目录在**启用那一刻**建好） |
| **眼睛** `senses.eyes` | 关 | `camera_look` / `desktop_camera_look`：拍一张现实画面 | 不落盘；画面进视觉通道后即弃；**不留缩略图**（见下） | **还要在「设置 → 权限」把摄像头打开**（两道锁）；面板会显示"待授权" |
| **嘴与耳** `senses.voice` | 关 | `alive_speak`：说一句（≤300 字）；`alive_listen`：听 1–15 秒 | 音频**不落盘**（临时文件用完即删）；没有"一直听着"的形态 | 语音槽位配置 + `ffmpeg`/`ffplay` + 麦克风设备（页面下拉选，`DIEYUN_MIC_DEVICE` 只作高级覆盖） |
| **主动开口** `voiceSpontaneous` | 关 | 允许它在**没人说话时**出声 / 开麦 | 每日上限 `aliveVoiceMaxPerDay`、两次间隔 `aliveVoiceMinIntervalMs`；被拒也留 `SPEAK`/`LISTEN` 事件 | 勾了「嘴与耳」才有意义 |

### 设备选择与依赖自检（issue/2026-11-10 的 P0 体验项）

- **选择**：麦克风 / 摄像头都在页面上**枚举后点选**（`alive:devices` → `ffmpeg -list_devices`），
  存进 `alive/settings.json` 的 `micDevice` / `cameraDevice`；环境变量 `DIEYUN_MIC_DEVICE` /
  `DIEYUN_DESKTOP_CAMERA` 仍是**高级覆盖**（显式给了就以它为准）。
  心跳轮经 `toolScope.senses` 把选中的设备带到工具层（`tool-bridge-main` 的 `desktop_camera_look`），
  所以"页面选了 A、实际用了 B"不会发生。
- **自检**：`voice.describeVoiceCapability` 是**唯一**判定"嘴与耳能不能用"的地方
  （ffmpeg / ffplay / 转写配置 / 合成配置 / 麦克风），页面照它显示红字；
  眼睛的"两道锁"用 `capabilities.eyes`（面板开关 + `host-permissions.json` 的 `camera`/`desktopCamera`）。
  **不允许"勾着但不可用"而不说话**。
- **失败分类**：录音失败分 `DEVICE_BUSY`（被占用）/ `DEVICE_UNAVAILABLE`（找不到设备）/
  `NO_AUDIO`（没声音）/ 超时，各自一句话，不混成"没录到声音"。
- **录音当场可见**：`alive_listen` 开录前会推一条托盘/系统通知（"生命感正在听一段，最多 N 秒，
  转完立刻删音频"）—— 麦克风被占用 15 秒这件事不能只在事后的事件流里留痕。
  桌面端由 `main-entry` 注入 `notifyTray`；headless 没有就静默。

### 为什么不留缩略图

「每次睁眼保存一张可回看的缩略图」与**现实画面不落盘**直接冲突：留副本等于把摄像头变成一台
没人要求的录音笔（同一条理由见 `desktop-camera-source.js` 头注释与 `visionCameraText`）。
目前的做法是**只记事实**（`EYE` 事件：何时、哪颗摄像头、成功与否、尺寸），画面本身进视觉通道后即弃。
要回看就得显式破这条约束，那是另一次设计变更，不在本次范围。

实现位置：`src/alive/note.js`（抽屉）、`src/alive/voice.js`（说 / 听）。
两者都走 `preTool`（不是 host 工具，不进工具桥），感官关掉时**连工具都不注入**，省得它反复试。

「听」的链路：`ffmpeg` 录音 → 临时 wav → `speech-transcribe.js#transcribeWhisper` → 文字 → 删音频。
「说」的链路：`speech-synthesize.js#synthesizeSpeech` → 临时音频 → `ffplay` 播放 → 删文件。
缺件（没 ffmpeg / 没设备名 / 没语音配置 / 没 ffplay）一律返回明确错误码，**不假装听见、不假装说出**。

> 它不知道你在读抽屉。这一点是刻意的：一旦它知道有读者，写出来的东西就会变成汇报。

---

## 6. 隔离度审计（这一节回答"到底隔了什么"）

**结论：工具面是硬隔离（白名单），数据面是软件隔离（同库不同文件），进程/记忆/额度没有隔离。**
这不是缺陷声明，是取舍声明 —— 拟态要"看着像生命"，就必须共享记忆与人格。

| 维度 | 隔离度 | 事实 |
|---|---|---|
| **工具面** | ✅ **硬（白名单）** | 心跳轮只允许 `fs_read_file / fs_list_dir / grep / glob / read_symbol / codebase_search / graph / lsp / memory_recall / session_recall / plan_list`，加两个受感官开关约束的 `camera_look / desktop_camera_look`。清单外一律 `READ_ONLY_SCOPE` 拒绝 —— 包括 `host_exec`、`fs_write_file`、`web_fetch`、`peer_send`、`memory_forget`、`subagent`、`plan_run`、`goal_check`、`browser_*` |
| **感官工具** | ✅ 逐项授权 | `alive_decide / alive_note / alive_speak / alive_listen` 走 `preTool`（不是 host 工具，不进工具桥）；关掉的能力**连工具都不注入**，摄像头走 gate 的 `SENSE_DISABLED` |
| **写盘** | ✅ 只有一个文件 | 唯一写入点是 `alive_note` → `alive/workspace/note.md`（只追加、有上限、**模型不能指定路径**） |
| **出网** | ✅ 关（白名单的副产品） | 没有 `web_*` / `browser_*` / `peer_*`，它碰不到网络 |
| **副作用** | ✅ 关 | 不能写盘、不能执行命令、不能删记忆、不能起子任务、不能跑计划 |
| **数据文件** | 🟡 软（同库不同文件） | `<userData>/alive/{state,events,settings}.json` 与主库物理分开，但**同一份 userData**、同一个进程、同一个 Gateway |
| **记忆** | ❌ **共享** | 唤醒轮走同一份 `prepSystemPrompt`：会注入长期记忆、AGENTS.md、技能索引。它知道你们聊过什么 —— 这是拟态的前提 |
| **会话** | 🟡 半 | 用**专属会话**（标题「生命体征（后台心跳）」），不污染你的对话线；但那次会话仍写进主库，可被 `session_recall` 检索到 |
| **决策理由** | 🟡 明文私有 | `state.intents` 不进事件流 / IPC / 页面；**但落盘是明文**，用编辑器能打开。这是"不展示"而不是"加密" |
| **模型与额度** | ❌ 共享 | 同一份 model-settings、同一个 API key，真实账单合在一起 |
| **进程 / 并发** | ❌ 无 | 同一进程、同一 event loop；用户聊天时它也可能醒来跑一轮（两个 loop 并行，抢 token 与延迟） |

三条要记住的后果：

1. **只读 ≠ 看不见**：它能读工作空间里的文件（`workspacePath` 为空时落到 Gateway 当前工作空间）。
   "隔离"在这里的准确含义是**不能改**，不是**看不到**。要连看都隔开，得给它一个空工作目录 —— 那它会变哑。
2. **白名单只能收紧不能放宽**：往 `ALIVE_READ_ONLY_TOOL_NAMES`（`guardrails-shared.js`）加一个工具名，
   等于明确表态"心跳轮可以用它"。别为了让它"能干点事"顺手加 `fs_write_file`。
3. **`intent` 是本机明文**：如果哪天要真私有，得走 `DIEYUN_SECRET_KEY_FILE` 加密 —— 那是另一次设计变更。

---

## 7. 与主实例的边界

- 心跳轮用的是**一个专属会话**（标题固定「生命体征（后台心跳）」），不进你的对话；
- 它与你**共享记忆与模型配置**——这是拟态的前提，不是缺陷；
- 唤醒轮**默认只读**（见上一节白名单）；
- 它的判定全在 Main（`src/alive/runtime.js`），Renderer 只显示结果 —— 不在渲染层判生死、判续跑。
- **headless 目前没有装配生命感**（`src/headless/boot.js` 里没有 `bootAliveRuntime`）。
  `runtime.js` / `alive-boot.js` 是宿主无关的，复用同一份即可；但服务器上没人看着，让它每 5 分钟
  自己决定醒不醒，等于把一份无人监管的模型账单放进 systemd —— 要装配得先定"什么时段 / 什么负载
  下允许醒"，那是另一次设计变更。在那之前别在注释里假装它已经跑在两处。

---

## 8. 与原 spec 的其余偏离（都要记住原因）

| 项 | 偏离 | 原因 |
|---|---|---|
| 阈值公式 | 原写 `μ·(refuse_rate − 0.2)`，本实现是 `μ·(基线 − 拒绝率)` | 原 spec 的**公式与其解释方向相反**（解释是"长期不拒绝→阈值升高，更挑"）。按解释实现 |
| 漂移量纲 | 全部按**小时**归一 | 原设计按 tick 计：1 小时就能把 W 钉死在 80（评审 N2） |
| 存储 | JSON + 只追加日志，不是 SQLite | `build.files` 排除了 `better-sqlite3`，headless 只打纯 JS 闭包；为拟态引 native sqlite 要维护两套打包矩阵 |
| 验收 | 注入时钟模拟 30 天 | 原 spec 要求挂机 24h/7d；评审 M1 已改，模拟能进 CI |
| `phase_override` | 删掉 | 它与"外部只能影响相位"直接冲突（评审 B4） |

---

## 9. 负向清单（往回加这些 = 设计作废）

1. ❌ 给它暂停 / 恢复 / 快照 / 回滚
2. ❌ 给它预算、给它死期、给它 ETA
3. ❌ 让它对用户说话、给它名字、给它头像、给它情绪标签
4. ❌ 把 `intent` 展示到页面 / 日志 / 审计里
5. ❌ 在 Renderer 判生死、判唤醒、判续跑
6. ❌ 把 `λ / ε / W` 做成设置项（数字只有一个来源）
7. ❌ 用关键词判断"这轮算不算没做完"（未闭合项只能由模型声明）
8. ❌ 伪造一条用户消息去驱动心跳轮（一律走 `[系统]` 合成前缀）
9. ❌ 让心跳轮默认获得写入 / 执行能力（先改默认值就是另一次设计变更）
10. ❌ 把抽屉做成双向通道（给它答复、让它知道有人在读 → 它就开始表演）
11. ❌ 让麦克风变成"一直听着"（只允许离散步长的 `alive_listen`，且音频不落盘）
12. ❌ 把"睁眼看"的画面存成缩略图 / 任何副本（要回看得先改"现实画面不落盘"这条约束）
13. ❌ 逐跳写 `TICK` 事件（288 条/天会把 `WAKE` / `DECISION` 挤出事件文件；心跳的账在 `state.json`）
14. ❌ 把用户对话的 token 记进它的疲劳（那会把"它累了"变成"你在聊天"）
15. ❌ 在 Renderer 里判"感官能不能用"（`describeVoiceCapability` / `capabilities` 是唯一来源）
16. ❌ 把 REFUSE 当"这一轮不想动"用（那是 DEFER；空手 REFUSE 不算拒绝，别用它刷拒绝率）
17. ❌ 用 `load` 拦唤醒（"你正在打字所以它不许醒"——那就不拟态了；要拦先用事件把它记清楚）
18. ❌ 把相位说成昼夜节律（相位只有 load 与 fatigue 两个输入）

---

## 10. 验收（`npm run test:alive`）

| 组 | 断言 |
|---|---|
| A 漂移 | ε=0 且无未闭合项 → 24h 一动不动；ε>0 → 有可见漂移；闲久了会自己爬到阈值以上 |
| B 相位 | 没有 `setPhase`；连续 k 个 tick 才切换；条件断续则惯性计数清零 |
| C 张力 | 同文本续命 / 上限裁剪 / 自然消退 / 拒绝率滑动窗口 |
| D 阈值 | 单 tick 漂移很小（按小时归一）；从不拒绝→升高，经常拒绝→降低 |
| E 决策 | 非法值被拒；REFUSE 关掉对应项；**理由不进事件流**；体征块是合成消息且不含死期字样 |
| G 抽屉 | 只追加、带时间戳、单条 ≤600 字截断、整体 ≤32KB（超了留尾部）、空内容被拒 |
| H 嘴与耳 | 缺 ffmpeg / 缺设备名 / 缺语音配置 / 缺 ffplay 一律**明确报错**（`NO_FFMPEG`/`NO_MIC_DEVICE`/`NO_TTS_CONFIG`/`NO_FFPLAY`），不假装听见或说出 |
| I 感官 | 默认只开抽屉；眼睛与嘴默认关；摄像头在只读轮里还需 `senses.eyes`（`SENSE_DISABLED`） |
| G 疲劳口径 | 25k token 不再一步打满；**用户对话不推高疲劳**，只有唤醒轮的 token 才计 |
| G 唤醒回执 | `WAKE` 带 load；`WAKE_END` 带 tokens / durationMs 且进 `status.lastWakeTokens`；没调 `alive_decide` 记 `WAKE_NO_DECISION` |
| G 决策语义 | 空手 REFUSE 不计拒绝（只有真关掉一条未闭合项才算）；`intents` / `decisions` 保留条数与「可疑顺从」阈值都来自 agent-limits（且真的生效） |
| G 抽屉读写 | `alive_read_note` 没有路径参数（只能读自己那一个文件）；写进去的能读回来 |
| H 感官自检 | 缺件说得出来（红字文案非空）；齐件才 `ok`；设备名"设置 → 环境变量"优先级；`SPEAK`/`LISTEN` 许可三态；录音失败分类；发声记账与跨天重置 |
| F 运行 | 30 天模拟：至少一次 `trigger=internal` 唤醒、多种相位、有决策记录、事件文件有界 |
| 其它 | 状态文件原子写/坏文件留证；`onLlmUsage` 旁听不抢主槽；关掉再打开不丢体征；**启用即建 `alive/workspace`**；设置新增字段不冲掉感官开关 |

---

## 11. 已知限度（不粉饰）

- **它是拟态，不是生命**。没有损耗、不会死、记忆不会失去 → 它无法产生"真正的取舍"。
  原 spec §14 Q5 那句"值不值得做"在这里的答案是：**作为可观测的拟态值得，作为生命验证不值得**。
- **`ε` 与随机性不是"自发"**。它保证"没有输入时仍有差异"，但不构成"内部动机"。
- **信息差是设计出来的，不是长出来的**：`intent` 私有 + 记忆不外显，这一点能立住；
  但"它有你没有的经历"这件事本实现不提供 —— 它没有经历，只有状态与共享记忆。
- **未闭合项的质量取决于模型**。模型若从不声明，张力只由静默上升驱动，行为会显得单调。
- **开关是运维意图，不是生命体征**。关久了再打开，它不会"记得自己停过"（`dtH` 上限 24h，不会一次结算一周）。
- **心跳本身不花钱**：没越线的那一跳只做算术（漂移 / 相位 / 阈值），**不调模型**；
  只有真要醒时才跑一轮。所以"心跳很贵"通常是误读 —— 页面上 `totalTokens` 是**唤醒轮**的累计，
  而它曾经被误算成"每跳都跑一轮"（issue/2026-11-10 的附带观察，已纠正）。
- **页面读数是轮询来的**（页签可见时 5s 一次）：它不是实时仪表盘，只是"别让你看到五秒前的旧数"
  这件事的下限。真要实时，得让 Main 推事件，那是又一次设计变更。

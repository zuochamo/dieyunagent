# 生命感的「看得见」三件事（额度 / 曲线 / 外化入口）— **已实施**

> 补的是**可观测与成本护栏**，不是新能力。三条都不给模型新增工具、不改动张力/相位模型。
> 定位仍是 `docs/ALIVE.md` 的拟态：它不会死、没有损耗、不隔离记忆 —— 这里只是让"它花了多少、
> 有没有变、你不在时做了什么"这三件事**不用翻 state.json 也能回答**。

## 0. 一句话

| 缺口 | 现在的事实 | 补法 |
|---|---|---|
| ① 只有"醒几次"上限 | `aliveWakeMaxPerDay: 40` 防抖，但**一次醒轮能烧四万字**，日账单无上界 | `state.tokenToday` + `aliveDailyTokenBudget`，在 `waker` 里做一条机械门限 |
| ② 只有当前值 | 面板只有"现在"的张力/疲劳；`events.jsonl` 刻意不记每跳（会挤掉决策） | 新文件 `alive/history.jsonl`（append-only，按窗口裁剪），面板画 sparkline |
| ③ 只能进设置页翻 | 它醒过、说过、看过的事只在「设置 → 拟态 → 生命」的日志里 | 侧栏一个「生命」页签（与 `goal` / `bot` 同构）+ 一个无状态的动静徽标 |

---

## 1. 设计原则（为什么这三处"删不掉"）

按 AGENTS 原则 2（减法优先）逐条交代，写不出来就不该加：

1. **① 额度**：不能并进 `aliveWakeMaxPerDay`。次数上限与钱没有固定换算 —— 一次醒轮 8k，
   也可能 200k（全量系统提示 + 工具 + 回看历史）。用"次数"表达"钱"必然失真。
   也不能做成"退避表 / 动态降频"：那是拿节律换预算，且状态机会自己长出一套策略层。
   → **只加一个机械上限**：超了就不醒，理由写清楚。
2. **② 曲线**：不能并进 `events.jsonl` —— 心跳 288 条/天，2000 行上限四天就滚完，
   会把 `WAKE` / `DECISION` 挤掉（`docs/ALIVE.md` 已把"逐跳写 TICK"列为负向）。
   也不能进主库（`memory` / `request_snapshots`）：体征是拟态的私有状态，写进主库就变成
   可检索的账，且违背 store 刻意不用 SQLite 的取舍（打包矩阵）。
   → **独立文件、只追加、按时间窗口裁剪**，读侧降采样。
3. **③ 外化**：不能在 Renderer 里另写一份渲染 —— 设置页已有事件渲染，两份必然漂移
   （"桌面能看、侧栏空白"那类）。也不能给托盘加 tooltip 推送：与 `notifyTray` 抢同一条通道。
   → **同一份渲染函数 + 同一份 IPC 数据**，换的只是一个壳。

---

## 2. ① 每日 token 额度

### 数据（`src/alive/vitals.js` + `runtime.js`）

- `state.tokenToday`：今日累计（只数它自己唤醒轮用掉的 token）。
- `state.tokenDayKey`：**不新增** —— 直接复用 `rollDay()` 的 `dayKey`；`rollDay` 里加一行
  `state.tokenToday = 0`，与 `wakeCountToday` / `refuseToday` / `voiceCountToday` 同一处重置
  （跨天重置只有这一个地方）。
- 记账：`runWakeTurn` 的 `finally` 里 `state.tokenToday += wakeTokens` —— 与 `WAKE_END.tokens`
  **同一个数**（同源，不另算一遍）。

### 数字（`src/agent/agent-limits.js`，唯一来源）

```js
aliveDailyTokenBudget: 400000,  // ≈ 10 次唤醒轮；<=0 表示不限
```

为什么默认 40 万：一次唤醒轮 ≈ 40k（`aliveFatiguePerKToken` 就是按这个标定的）。
次数上限（40/天）显然远高于此 —— **额度会先触发，这是刻意的**：次数防抖、额度防烧钱。

### 判定（`src/alive/waker.js`，唯一门限处）

在现有四个机械条件之后加第五个：

```js
if (cfg.dailyTokenBudget > 0 && Number(state.tokenToday || 0) >= cfg.dailyTokenBudget) {
  return { wake: false, reason: 'token-day-cap' };
}
```

- **不拦用户轮**：额度只记它自己的账（与疲劳同口径）。
- **不中途掐断**：唤醒前检查；一轮跑过头的差额最多一次醒轮，不做"半路 abort"（那会把
  一次决定切两半，制造"它做了一半"的状态）。
- 与 `wakeCountToday` 一样**只写事实**：`WAKE_SKIPPED { reason: 'token-day-cap', tokenToday, budget }`。

### 观测（面板 / 事件）

- 设置页与侧栏页的概览行加：`今日唤醒 3/8 · 今日 token 128.4k/400k`。
- 额度用完时给一行解释：「今日额度已用完（400k），明天 0 点重置；要放宽就改
  `agent-limits.js` 的 `aliveDailyTokenBudget`」——不从设置页开放旋钮（数字仍只有一个来源）。

### 反证条件

若真机观测到**一轮就吃掉大半额度**：先修单轮成本（`maxRounds` / 回看历史长度），
不要调大额度 —— 调大等于承认"一次醒轮 200k 是正常量级"。

---

## 3. ② 体征历史（曲线）

### 存储（`src/alive/store.js`，唯一写者）

新文件 `<userData>/alive/history.jsonl`，**只追加**，每行一个采样：

```json
{"ts":1794292612000,"phase":"LOW","tension":21.4,"fatigue":12.0,"tokenToday":0,"wakeCountToday":0}
```

- 写入点：`tickOnce()` 末尾（每跳一条；心跳本身不调模型，写一行 ~90 字节，代价可忽略）。
- 裁剪：与 `events.jsonl` **同一套**裁剪实现（把现有 `trimEventsFile` 抽成
  `trimJsonl(file, maxLines)`，两个文件共用 —— 不新增第二套裁剪逻辑）。
  上限 `aliveHistoryMaxLines: 4000`（≈ 14 天的跳数，约 350KB）。
- 不做时间桶合并：那是"写侧去重"，要在 append-only 文件里改最后一行，得不偿失。
  降采样放在**读侧**（面板只要 ~240 个点）。

### 读取（`runtime.history({ windowMs, points })`）

- 读窗口内的行（默认 7 天），按 `points` 等距抽样（默认 240），返回
  `{ samples: [{ts, phase, tension, fatigue, tokenToday}], windowMs, total }`。
- 坏行跳过（与 `readEvents` 同款容错），不因为一行坏 JSON 让整页空掉。

### UI（设置页 + 侧栏页，同一份渲染）

- 手写内联 SVG（renderer 已有 `<svg>` 先例，不引图表库）：
  - 两条折线：张力（一条）、疲劳（一条），各自按 0–100 归一到同一坐标系。
  - 背景色带：按 `phase` 分段上色（四个相位四档灰/蓝/绿/琥珀），一眼看出"它什么时候在压缩"。
  - 悬浮/点击某点 → 顶部一行文字：`14:46 · 警觉 · 张力 21.4 · 疲劳 12.0`（不弹框）。
- 空数据时显示「还没有足够的样本（跑满一跳后才会有）」。

### 边界

- 曲线**不进模型上下文**：体征块（`renderStateBlock`）仍然只有当前值 —— 否则每轮 prompt 都变长。
- 曲线是**只读**：不提供"改窗口 / 读某个点做决策"的旋钮。

---

## 4. ③ 外化入口（它不在时做了什么）

### 壳（`src/renderer/index.html`）

侧栏加一个页签，与 `goal` / `bot` 完全同构：

```html
<button type="button" class="side-panel-rail-btn" data-side-tab="alive" title="生命" aria-label="生命">…</button>
<div class="side-panel-pane" data-side-pane="alive" hidden>…</div>
```

`check:renderer` 的 rail/pane 一致性检查会强制两边同时存在（漏一边直接红）。

### 内容（复用，不重写）

| 区块 | 数据来源 | 渲染 |
|---|---|---|
| 概览 | `alive:status`（已有） | 相位 / 张力·阈值 / 疲劳 / 今日唤醒 / 今日 token / 上次醒来成本 |
| 趋势 | `alive:history`（新增） | 与设置页**同一个** `renderAliveTrend()` |
| 最近事件 | `alive:decisions`（已有） | 与设置页**同一个** `renderAliveEventLines()`（把现在设置页里的行拼装抽成函数导出） |
| 抽屉只读预览 | `alive:note`（已有） | 与设置页同一个 `renderAliveNote()` |

即：`renderer-alive.js` 变成「渲染函数库 + 两个壳」—— 设置页那套 DOM id 不动，侧栏页复用函数。
**不复制**任何状态机或判定（该页仍然只读）。

### 徽标（无状态判据）

- 条件：**最近 60 分钟内有 `WAKE` / `DECISION` / `SPEAK` / `EYE` 事件** → rail 上显示一个小点。
- **不引入"已读"**：那需要持久化 `lastSeenTs` 并同步到设置页，是典型的状态机加法。
  "刚有动静"比"有 3 条未读"更诚实，也更便宜。

### IPC（两个新增，都很轻）

| 通道 | 返回 | 为什么不复用 `alive:status` |
|---|---|---|
| `alive:history {windowMs, points}` | `{ ok, samples, windowMs, total }` | status 是"现在"，曲线是"过去"，大小差一个量级 |
| `alive:badge` | `{ ok, enabled, running, phase, wakeCountToday, recent, lastKind, lastTs }` | 主界面常驻轮询，不能每 30s 读一次模型设置 / 权限文件（status 会读） |

`alive:badge` 只读 `state.json` + `events.jsonl` 尾部一行，不 spawn 任何东西。

### 刷新节奏

- 侧栏「生命」页可见时：5s（复用设置页那套 poll，页面不可见即停）。
- 主界面徽标：30s（体征漂移是 5 分钟尺度，30s 足够，别让渲染层空转）。
- headless 网页端**不映射**这两个 IPC：服务器没有装配生命感（见 `docs/ALIVE.md` §7）。

---

## 5. 实施顺序（四步，每步独立可测可提交）

| 步 | 内容 | 落点 | 验收 |
|---|---|---|---|
| 1 | 额度：`tokenToday` + `rollDay` 重置 + `waker` 门限 + 记账 + 事件字段 | `vitals` / `waker` / `runtime` / `agent-limits` | 超预算不醒（`token-day-cap`）、跨天清零、`WAKE_END.tokens` 与 `tokenToday` 同源 |
| 2 | 历史：`history.jsonl` + 共用裁剪 + `runtime.history()` + `alive:history` | `store` / `runtime` / `ipc/alive` / `preload` | 逐跳一条、窗口裁剪有界、读侧抽样 ≤ points、坏行跳过 |
| 3 | 面板：设置页「趋势」区块 + SVG sparkline + 相位色带 | `renderer-alive` / `index.html` / `styles.css` | `check:renderer`（DOM id / rail-pane 一致） |
| 4 | 外化：侧栏「生命」页签 + 徽标（`alive:badge`）+ 渲染函数共用 | `index.html` / `renderer-side-panel` / `renderer-alive` / `ipc` / `preload` | rail/pane 一致；设置页与侧栏事件格式**同一函数**产出 |

## 6. 验收（新增断言，挂在 `npm run test:alive` 与 `check:renderer`）

- 额度：`tokenToday` 达线 → `wake:false / reason:'token-day-cap'`；`<=0` = 不限；
  跨天 `rollDay` 归零；`tokenToday` 等于当日 `WAKE_END.tokens` 之和。
- 历史：`appendSample` 逐跳一条；超过 `aliveHistoryMaxLines` 裁一半；`history({points:240})`
  返回 ≤240 个点且 ts 递增；坏行不炸。
- 徽标：`recent` 只看 60 分钟窗口（给两条事件造边界：59 分钟前 true、61 分钟前 false）。
- 渲染：`check:renderer` 的 rail/pane 计数 + 新 DOM id 引用全部存在。

## 7. 负向清单（往回加这些 = 这次白做）

1. ❌ 用关键词判断"这件事值不值得说/要不要提醒用户"（路由只看事件类型与时间窗）。
2. ❌ 把额度做成"退避表 / 动态降频 / 分时段配额"—— 只允许一条机械上限。
3. ❌ 把曲线写成主库表 / 让模型能读到历史曲线（体征块只放当前值）。
4. ❌ 引入"未读计数"或 `lastSeenTs`（要"刚有动静"就够，别造状态机）。
5. ❌ 在侧栏页另写一份事件渲染 / 另算一次"今日唤醒"（同一份函数、同一份 IPC）。
6. ❌ 给额度开设置页旋钮（数字仍只有 `agent-limits` 一处）。

## 8. 风险与影响面

- 新增文件 1（`history.jsonl`）、新增 IPC 2（`alive:history` / `alive:badge`）、
  新增侧栏页签 1、新增 `agent-limits` 数字 2（`aliveDailyTokenBudget` / `aliveHistoryMaxLines`）。
- **不动 `STATE_VERSION`**：只给 state 加字段，读侧一律 `Number(x) || 0` 缺省；
  history 是独立文件，缺席即空曲线。没有迁移链。
- 主界面多一条 30s 轮询（一次 `state.json` 读 + 一行事件）—— 比现有 5s 的会话列表刷新轻。

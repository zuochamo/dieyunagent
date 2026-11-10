# 流畅度调查：偶发卡半秒，卡在哪

> 调查时间：2026-11-07 08:2x（本机正在运行该客户端）
> 取证材料：`%APPDATA%/dieyunagent/logs/main.log`（16247 行）、`undo-sessions/`、`diecloud-memory.sqlite`、`data/tool-telemetry.jsonl`
> 结论分三级：**[确定]** 有实测数字 / **[实测存在·归因待钉死]** 现象确定、成因还没钉到函数 / **[推断]** 静态阅读得出，需一次埋点验证

---

## 结论先行

「偶发卡半秒」不是一个问题，是本机三条互相独立的阻塞叠出来的观感。按「确定性 × 收益」排：

| # | 结论 | 证据强度 | 影响面 |
|---|------|----------|--------|
| 1 | **Main 主线程在同步序列化并落盘 250MB 级的 undo 快照**（`turn-undo-store.writeSessionSync`）。一次 0.4–0.9s，400ms 去抖 ⇒ agent 改文件的整段时间里主线程基本被占满 —— **已修复，见 §七（落盘 400–900ms → 14ms，单会话 305MB → 4.4MB）** | [确定] 文件账 + 本机实测 | 所有经主进程的 RPC/IPC：流式事件转发、窗口、工作区、产物、终端 |
| 2 | **Renderer 有 0.5–3.0s 的长任务**（56 条 freeze 落盘，90 个样本，中位数 1252ms），并伴随 DOM 3.3k→42.6k、渲染进程内存 181→897MB | [实测存在·归因待钉死] | 点哪都「钝一下」的直接感受 |
| 3 | **core 读池饥饿 + core 整体停顿**：38 条 `RPC_SLOW`，KV 级读（`session_goal_get`）排到 2.1–3.6s，`core.ping` 出现 7.7s | [确定] 日志 | 切会话 / 目标条 / 历史列表「点了没反应」 |
| 4 | 附带：`undo-sessions/` 17.0GB 无任何保留策略；渲染进程 11-04/11-05 被 kill 24 次 | [确定] | 磁盘、稳定性 |

一句话：**感觉上"偶发"，实际是"高频触发 + 每次几百毫秒"**——改文件期间几乎持续发生，所以你会觉得是随机卡顿。

---

## 一、[确定] Main 主线程同步写超大 undo 快照

### 1.1 现场数字

```
undo-sessions/ : 389 个 json，合计 17.0 GB，最大单文件 516 MB
  >100MB  50 个  10–100MB 106 个  1–10MB 84 个  <1MB 149 个
当前会话 s-1793967478912-366348f0.json : 246 MB（mtime 08:25，即刚刚在写）
```

拆开这个 246MB（`_tmp/undo-probe.cjs` 流式扫描 + `_tmp/undo-real-parse.cjs` 真解析）：

```json
{ "fileMB": 252.3, "turnRecords": 6, "batchEntries": 81, "fileEntries": 10858,
  "beforeTotalMB": 171.7,            // 68% 是「改前全文」
  "readFileSyncMs": 564, "parseMs": 319 }   // 单次「读 + 解析」= 883ms
```

写入侧同尺寸实测（`_tmp/undo-cost-bench.cjs`，115MB 合成 payload 线性外推到 246MB）：

```
JSON.stringify(246MB)  ≈ 170 ms
writeFileSync(246MB)   ≈ 226 ms      ← 再加 renameSync、Defender 实时扫描
合计 ≈ 0.4–0.9 s / 次（且每次都产生一个 ~250MB 的字符串，强制主进程 GC）
```

### 1.2 为什么会涨到 250MB

`src/undo/turn-undo-service.js`：

- `record.files[key].before` 存的是**整份文件文本**（上限 4MB/文件，`WORKTREE_SNAPSHOT_MAX_BYTES`）；
- 每个 checkpoint 又整份复制一遍：`record.batches.push({ files: cloneFilesMap(record.files) })`（`cloneFilesMap` 是真 `JSON.parse(JSON.stringify())` 深拷贝）；
- 单轮最多 32 个 batch（超了合并最老两个），栈保留 5 轮 ⇒ **6 个 record × 81 个 batch / 10858 个 file 条目** —— 同一份源码被存了上百份。

### 1.3 为什么"卡半秒"而不是一直卡

- 触发点：`captureWrite`（每次工具写文件，400ms 去抖）、`finalizeTurn` / `markWorktreeOnly` / `capturePlanApplyPaths`（`immediate`，同步写）。
- 写入全在主线程：`src/undo/turn-undo-store.js#writeSessionSync` = `fsSync.writeFileSync` + `fsSync.renameSync`；`src/gateway/server.js` 里 `createTurnUndoService` 建在 Electron 主进程 ⇒ 挡住同一进程里的**全部** Gateway RPC 分发与 IPC。
- 读同样同步：`loadSessionSync`（会话首次进入 undo 流程时）就是上面实测的 883ms + ~800MB RSS 的对象图。
- 本机工具统计：`fs_edit` 356 次 + `fs_write_file` 294 次，命中率足够高 ⇒ 每轮改文件都在反复交这笔税。

**这就是"偶发卡半秒"最直接的来源**：一轮里改了 N 个文件 → 每隔 400ms 一次 0.4–0.9s 的主线程独占。

---

## 二、[实测存在·归因待钉死] Renderer 长任务

`main.log` 里 `[dieyun:renderer] freeze` 共 56 条（11-05 17 / 11-06 13 / 11-07 2），其中长任务样本 90 个：

```
duration: min 502ms  median 1252ms  max 2968ms
domNodes: 3342 → 42559      renderer workingSetMB: 181 → 897
attribution: "self"/"unknown"（探针不带面包屑，归因无效）
```

即：**用户感觉的"半秒"，探针实测经常是 1–3 秒**，而且随会话变长而变长（20:16 那条 2169ms、domNodes 38534、messages 31）。

已经排除的（读了代码，不是嫌疑人）：流式正文走增量追加（`updateIncrementalTextContent`）+ 结构签名短路，不是"每帧整块重绘"；diff 有 4000 行 / 40 万乘积上限；`innerHTML` 集中在侧栏面板；渲染侧没有 `sendSync`，没有 `execSync`；rAF 都有合并。

优先级最高的三个嫌疑（都需要一次埋点确认，不要先动手改）：

1. **`collapseChatThinkingTraces()`（`renderer-thinking-trace.js:231`）**：每轮结束对 `#chat-list` 里**所有** `.msg-thinking-outer` / `.msg-thinking-round-details` 逐个 `open=false`。`enable-motion` 下每条 details 都带 `grid-template-rows` 过渡 ⇒ 一次性几百个过渡 + 全树样式重算。会话越长越贵，天然"偶发"（每轮一次）。
2. **聊天列表无虚拟化**：`CHAT_INITIAL_LOAD_LIMIT=32` + 上翻每次 100 条，全部留在 DOM；`content-visibility` 全仓 0 处。42k 节点下任何一次布局都是几万节点的活。
3. **Monaco / mermaid 首次挂载 + major GC**：`monaco.editor.create`、`mermaid.render` 都是主线程重活（单次 100ms–2s 量级）；897MB 的渲染进程内存也足以让 major GC 进入几百毫秒。

---

## 三、[确定] core 侧：读池饥饿与整体停顿

38 条 `RPC_SLOW`（阈值 2000ms）分布：

| 方法 | 次数 | 最大 |
|------|------|------|
| `codebase.search` | 11 | **42503ms**（11-04 23:04–23:10 建库期间连续 23–42s） |
| `memory.long_recall` | 8 | 7048ms |
| `memory.session_goal_get` | 9 | 2700ms |
| `memory.sessions_list` | 3 | 3593ms |
| `memory.request_snapshot_append` | 3 | 2181ms |
| `compaction.maybe_compact` | 2 | 3596ms |
| `agent.trace_save` | 1 | 2284ms |
| `core.ping` | 1 | **7679ms** |

两个自洽的读法：

- `session_goal_get` 是**一行 KV 读**（`crates/dieyun-core/src/memory/goal.rs`，走池化 `self.read`），却稳定排到 2.1–2.7s —— 只可能是 `READ_POOL_CAP = 4` 的池子被长扫描（向量召回 / FTS / 索引）占满（`docs/SQLITE-ACCESS.md` 已记载这个模型与「在途预算」）。11-06 一天 7 次，说明不是偶发。
- `core.ping` 7.7s ⇒ **整个 core 的事件循环被一段同步阻塞卡住**（ping 都排不上），与「长 CPU 任务必须走 `spawn_blocking`/`open_dedicated`」的既有约定不符。

库本身也偏胖：`diecloud-memory.sqlite` 1.02GB / 4784 消息（共 8.5M 字符）/ 526 traces（均 94KB、max 1.5MB）/ `long_memories` 1789 + 向量 1629 / `compaction_archives` 1766；另有 `codebase-index.sqlite` 105MB + 一份 95MB 的 `pre-vacuum` 残留。

---

## 四、整改建议（减法优先）

### P0 — 先把主线程上的 250MB 同步写拿掉（收益最大、根因明确）✅ 已实施，见 §七

1. **`persistSession` 不要整份同步写**：把落盘从主线程挪走（`fs/promises` 写 + 只写变化的那一份；或一个专门的写线程）。这是 IO 位置错误，不是"兜底"。
2. **`loadSessionSync` → async**：`sessionState()` 首次加载不再 `readFileSync` + `JSON.parse` 250MB。
3. **给 undo 记录加"内容预算"而不是只按条数**：现在只限 `MAX_BATCHES_PER_TURN=32` 和 `MAX_STACK=5`，**没有字节上限**。同一份源码被 copy 上百次是冗余事实源：`strategy === 'git'` 的轮次本可只留 git baseline + 指针，不必再存 `before` 全文。
4. **清理存量**：`undo-sessions/` 17.0GB、无保留策略。这是唯一一个"删了就立刻变快"的动作（注意保留当前会话那份，或直接删全部——undo 是会话内能力，重启后已无 UI 入口）。

### P1 — 把 renderer 的归因钉死，再改

5. 现有探针只记 **≥500ms** 且 `attribution` 恒为 `unknown` ⇒ 结构上看不见 100–400ms 的抖动，也说不清"卡在哪一步"。建议对 `renderer-freeze-watch.js` 做一次临时升级：阈值降到 **100ms**、分桶计数（而不是每条落盘）、并附上**操作面包屑**（最近几条渲染阶段：会话渲染 / trace 对账 / 折叠全部思考区 / markdown / mermaid / monaco / 面板切换）。按该文件头部既有的移除条件，定位完就删。
6. 拿到面包屑后再动刀，最可能的两个减法：`collapseChatThinkingTraces` 不做全列表遍历（只处理最近一轮 / 或干脆删掉"自动收回历史轮次"）；聊天列表加 `content-visibility: auto` 或只渲染最近 N 轮。

### P2 — core 侧

7. KV 类读（`session_goal_get` / `sessions_list`）不该排在向量扫描后面：要么给召回类长扫描单独 `open_dedicated`（既有通道，不新增机制），要么把这类小读从池里摘出来。按 `docs/SQLITE-ACCESS.md` 的三条通道归类，这是「选错通道」而不是「需要新层」。
8. `core.ping` 7.7s 那一次要单独查：找到那段同步阻塞，挪进 `spawn_blocking`。

### P3 — 顺带

9. 渲染进程 11-04/11-05 被 kill 24 次（`reason=killed`，exitCode `0xC000013A`）。这更像开发期反复重启，不是崩溃；但如果是你正常使用时让它消失，那是比卡顿更严重的问题，单独看。

---

## 五、可直接复跑的取证命令

```powershell
# 1) 冻结 / 长任务 / core 慢请求
$log = "$env:APPDATA\dieyunagent\logs\main.log"
Select-String $log -Encoding utf8 -Pattern '\[dieyun:renderer\] freeze' | Select-Object -Last 20
Select-String $log -Encoding utf8 -Pattern 'RPC_SLOW'

# 2) undo 快照账（体积分布 / 最近写入）
Get-ChildItem "$env:APPDATA\dieyunagent\undo-sessions" -File |
  Sort-Object Length -Descending | Select-Object -First 10 LastWriteTime,@{n='MB';e={[math]::Round($_.Length/1MB,1)}},Name

# 3) 单份 undo 的体积构成 + 真实读/解析成本（_tmp/ 已在 .gitignore）
node _tmp\undo-probe.cjs      "$env:APPDATA\dieyunagent\undo-sessions\<sid>.json"
node --max-old-space-size=6144 _tmp\undo-real-parse.cjs "$env:APPDATA\dieyunagent\undo-sessions\<sid>.json"
node _tmp\undo-cost-bench.cjs   # 本机 stringify / writeFileSync / read+parse 吞吐基线

# 4) 记忆库画像
node _tmp\memdb-probe.cjs "$env:APPDATA\dieyunagent\diecloud-memory.sqlite"
```

---

## 六、还没有证据的部分（别当结论用）

- renderer 那 90 个长任务**具体**落在哪个函数：没有面包屑，也没跑过 DevTools Performance。上面的三个嫌疑是静态阅读排序，不是结论。
- 主线程 0.4–0.9s 的推算基于同尺寸合成 payload 的线性外推；真实内容转义更多、且叠加 Defender 扫描，只会更慢，不会更快。要精确数字，需在主进程加一个 event-loop delay 采样（`perf_hooks.monitorEventLoopDelay`，节流落盘），跑一天即可，也能顺带证明"卡顿时刻主进程是否真的被占住"。

---

## 七、已实施：undo 快照（P0-1 ~ P0-3）

### 7.1 改了什么

| 文件 | 改动 |
|------|------|
| `src/undo/turn-undo-store.js` | 落盘格式改为**元数据 + 内容块**：`before` 按 sha256 前 16 字节去重后单独落 `undo-sessions/<sid>.blobs/<ref>`，元数据只留 32 hex 引用；写盘全走 `fs/promises` 且每会话串行；写完元数据顺手删掉没人引用的块（不再有孤儿）；删会话时连块目录一起删 |
| `src/undo/turn-undo-service.js` | `cloneFilesMap` 由 `JSON.parse(JSON.stringify())` 改**条目浅拷贝**（`before` 是不可变字符串，深拷贝只是白复制：实测一个会话 171.7MB 重复原文）；`persistSession` 去掉同步写；新增**内容预算** `UNDO_CONTENT_BUDGET_CHARS = 32M 字符` 与 `enforceContentBudget`；`planRollback` / `planRollbackBatch` 对「内容已丢弃」明确报错 |
| `src/renderer/renderer-chat-history.js` | `purgeSessionRecords` 补上 `clearSessionUndo(sid)` —— 删会话时连带删撤回快照（这是 17GB 死账的另一个来源） |
| `test/unit/turn-undo-store.test.cjs` | 新增 8 条单测：去重/元数据不含原文/读回一字不差/孤儿块回收/v1 兼容升级/预算只丢「真能省下」的内容/最新一轮受保护 |

### 7.2 为什么是这个改法（为什么不是「加大去抖」「改异步就行」）

- **只改异步没用**：`JSON.stringify(250MB)` 本身就是 ~170ms 的主线程 CPU，异步 IO 只是把 226ms 的写盘挪走。
- **只加去抖/降频没用**：那是拿功能换时间（checkpoint 变稀），下次会话更长时又顶回来。
- 真正的根因是**一份数据被存了上百遍**：每个 checkpoint 把整个跟踪集深拷贝一次，同一份源码在内存里 10858 份、在盘上一条 250MB 的单体 JSON。所以改法是让「内容」在内存和盘上都只存在一份，元数据退化成引用表。

### 7.3 实测前后（拿线上那份真实会话文件跑，`_tmp/undo-migrate-bench.cjs`）

```
原始单体文件            304.7 MB
老格式读取(读+parse)     1017 ms
→ 迁移首次写(写块+元数据)  508 ms     一次性
→ 稳态写(内容没变)          14 ms     ← 原来每次 400~900ms
元数据                    1.24 MB
内容块                    155 个 / 3.13 MB
磁盘合计                  4.37 MB     （69.7x）
新格式读取                 19 ms      ← 原来 1017ms
内容一致性                 逐字节相同（contentMatch: true）
```

### 7.4 语义变化与边界（都要知道）

- **内容预算**：单会话内容超 32M 字符时，按「最老回合 → 更新回合」淘汰；**最新一轮的 `record.files` 永不丢**（能整轮撤回的就是它）。被淘汰的 checkpoint/回合不会静默变成「恢复成删文件」，而是明确报「内容已按体积预算丢弃」。
- **只丢真能省下的**：内容若被更新的回合共用（内存里本来就是同一个字符串、盘上是同一个块），丢老回合一份省不下任何东西，直接跳过不丢。
- **崩溃窗口**：`immediate` 写从「同步落盘」变成「立刻异步落盘」，进程被强杀时最多丢最后一次 checkpoint（撤回能力是会话内功能，可接受）。
- **迁移时机**：老格式文件在会话被写入时自动升级成新格式，不会主动扫盘重写。

### 7.5 验证

```
npx vitest run          → 201 files / 1938 tests 全通过（含新增 8 条）
npm test                → unit + local-gateway-smoke ALL OK
npm run check:renderer  → OK（globals / critical / namespace 全过）
npx tsc -p tsconfig.check.json → 0 error
```

### 7.6 存量清理（已执行）

按「保留最近 30 天」清了一档：删掉 231 个 30 天前的会话快照，`undo-sessions/` **16.82GB → 4.35GB**（回收 12.5GB）。
剩下的 158 个文件里，还在用的会话会在下次写入时自动升级成新格式（单会话从数百 MB 降到 MB 级），不再打开的旧文件可以随时按同样方式再清。


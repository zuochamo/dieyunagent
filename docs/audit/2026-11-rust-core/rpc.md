# rpc 审计

> **2026-11-17 P0 已修**：F1 的前半（`agentCancelled` 恒真 → `cancel` 返回真实 bool，`agent.run.cancel` 也回报 `cancelled`；宿主两处死的 `agent.loop.cancel` 改走 `agent.run.cancel`）。仍未做：在途 600s 请求打断（归 P4）、`ids` 字段无用、其余 F2–F9。
> **2026-11-17 P1 已修**：F5 的两半 —— ①`memory.messages_clear` 别名已删（Rust 侧只留 `session_delete`，语义是删整个会话行）；②catalog 生成器改成认交替臂（`"a" | "b" =>` 里的第二个名字以前永远看不见），并加了「Node 调用但 catalog 无实现」的闸门（`npm run verify:rpc-catalog`），`agent.loop.cancel` 那类死调用现在会红。

审计范围（全部读完）：`crates/dieyun-core/src/rpc/mod.rs`、`calls.rs`、`events.rs`、`stdio.rs`；
交叉求证：`src/core-bridge.js`、`src/core-rpc-timeouts.js`、`src/gateway/rpc.js`、
`src/gateway/handlers/{memory,codebase}.js`、`src/renderer/renderer-gateway.js`、
`docs/LLM-RPC.md`、`docs/rpc-catalog.md`、`scripts/lib/extract-rpc-methods.cjs`、
`src/agent/llm-complete.js`、`src/agent/rust-loop-runner.js`、`src/main/ipc/agent-runtime.js`。

## 度量

- 行数：`mod.rs` 1483 / `calls.rs` 172 / `events.rs` 50 / `stdio.rs` 149，合计 **1854** 行；
  其中 `mod.rs` 的 `match` 分派臂 85 条（async 分支 27 条 + `ServiceSnapshot::dispatch` 阻塞分支 58 条），
  另有 1 条双名交替臂 `"memory.session_delete" | "memory.messages_clear"`（两个方法共用一份实现）；
  整个模块只有 **1 个测试**（`mod.rs:1471` `budget_covers_polling_methods_only`）。
- 一个文件混了几种职责（`mod.rs` 一个文件里同时是）：
  1. RPC 路由 + 参数解构（1450 行 `match`，85 条臂，每条臂自带一套 `unwrap_or` 默认值）；
  2. 入参校验策略（同一类错误两种写法：`ok_or_else(INVALID_PARAMS)` 与「返回体里 `ok:false`」）；
  3. 并发分层（哪个方法留在 async 分支、哪个进 `run_blocking`）——靠「加在哪张 `match` 里」表达；
  4. 超时策略（`FAST_METHOD_BUDGET_MS` / `request_budget_ms`）；
  5. 服务装配与热更新（`AppState::new`、`core.configure` 换库/换 embedding）；
  6. LLM 调用接线与事件/反向调用装配（`agent.run.start` / `agent.run.tools` / `llm.complete` / `core.host_probe`）；
  7. 协议帧结构（`RpcRequest` / `RpcResponse`）；
  8. 驱动器结果整形（`finish_drive` 把 `DriveStop` 翻成两种形状的响应）。
- 同一份知识有两份实现（列出）：
  - 「哪些方法只碰内存 / 哪些会阻塞线程」：`mod.rs:817-1374`（async `match`）与 `mod.rs:129-754`（`ServiceSnapshot::dispatch`），
    且 `mod.rs:1368` 注释自称「真正的『哪些方法阻塞』清单只有一处」——实际是两处、靠约定不靠机制；
  - 「方法名 → 超时/预算」：`mod.rs:51-59`（Rust 20s）、`src/core-rpc-timeouts.js:47-70`（Rust 侧 15s/120s/600s）、
    `src/renderer/renderer-gateway.js:124-155`（Gateway 侧 45s/120s…），三份数值互相打架；
  - 「慢请求阈值 2000ms」：`mod.rs:47` 与 `src/core-rpc-timeouts.js:40`（注释自陈「与 Rust 侧同值，改一个必须改另一个」）；
  - 「RPC 方法清单」：`mod.rs` 的 `match` 与 `docs/rpc-catalog.md`（生成器正则只认一半写法，见 F5）；
  - 「取消语义」：`rpc.cancel`（`mod.rs:829`）、`agent.run.cancel`（`mod.rs:1072`）、宿主 `abortPending`
    （`src/core-bridge.js:191-198`）、`agent.loop.cancel`（`src/main/ipc/agent-runtime.js:682/771`，Rust 侧已无此方法）；
  - 「`memory.messages_clear`」：Node `src/gateway/handlers/memory.js:277` 一条，Rust `mod.rs:336` 一条（且与 session_delete 合并）。

## 发现

### F1 `rpc.cancel` 是死信号：`agentCancelled` 恒为 true，宿主停止路径调的是已删除的 `agent.loop.cancel`

- 类型：live-bug
- 严重度：high
- 位置：`crates/dieyun-core/src/rpc/mod.rs:829-854`、`crates/dieyun-core/src/agent/loop_run.rs:475-484`、
  `src/main/ipc/agent-runtime.js:680-686`、`src/main/ipc/agent-runtime.js:769-775`、`src/core-bridge.js:191-198`
- 证据：

```rust
// rpc/mod.rs:840-853
let mut agent_ok = false;
let mut planner_ok = false;
if !run_id.is_empty() {
    let guard = self.inner.read().await;
    agent_ok = guard.agent.cancel(run_id).is_ok();
    planner_ok = guard.planner.cancel(run_id).is_ok();
}
Ok(serde_json::json!({
    "ok": true,
    "runId": ...,
    "ids": ids,
    "agentCancelled": agent_ok,
    "plannerCancelled": planner_ok
}))
```

```rust
// loop_run.rs:475-484 —— 找不到 run 也返回 Ok(())，所以上面 agent_ok 永远 true
pub fn cancel(&self, run_id: &str) -> Result<(), CoreError> {
    let mut runs = self.runs.lock()...;
    if let Some(state) = runs.get_mut(run_id) {
        state.cancelled = true;
    }
    Ok(())
}
```

```js
// src/main/ipc/agent-runtime.js:680-686（另一处 769-775 同形）
if (rid && live.coreBridge && live.coreBridge.isReady()) {
  try {
    await live.coreBridge.invoke('agent.loop.cancel', { runId: rid }, 10000);
  } catch {
    // ignore
  }
}
```

- 触发：用户点「停止」（走 `agent:stop` / 运行 finally）时 100% 触发。三个独立问题叠在一条路径上：
  1. `agent.loop.cancel` 在 Rust 侧**不存在**（`docs/LLM-RPC.md:62` 明写 `agent.loop.*` 已删除），
     落到 `mod.rs:1369` 的兜底分支返回 `UNKNOWN_METHOD`，又被 `catch {}` 吞掉——真正生效的只有
     `abortPending` 里那两条 fire-and-forget（`core-bridge.js:193-195`）；而 `abortPending` 一旦带了
     `opts.methods`（`methodSet` 非空，`core-bridge.js:196-198`），就只发 `rpc.cancel` 不带 `runId`，
     于是 `mod.rs:842` 的 `if !run_id.is_empty()` 直接跳过——**一个 run 也不会被取消**。
  2. `agentCancelled` 恒 true：run id 写错、run 已结束、core 刚重启，都回报「已取消」。
  3. `cancel` 只是置位，账本方法下一次进入时才检查（`loop_run.rs:464/517/715/799`），
     在途的 600s SSE 请求不会被打断——「停止」拦的是交付，不是请求。
  另外 `mod.rs:843` 用 `self.inner.read().await` 取锁：tokio `RwLock` 是 FIFO，一旦 `core.configure`
  的写锁在排队，取消请求会排在它后面（配置热更新期间的「停止」会延迟或丢）。
- 修法方向：删掉 `agent-runtime.js` 那两处 `agent.loop.cancel`（宿主已有一条生效路径，别留第二条）；
  `AgentLoopManager::cancel` 改为返回「是否真的找到并取消了 run」，`rpc.cancel` 直接透传该 bool；
  `rpc.cancel` 的 `ids` 字段要么删（宿主自己 settle，见 `mod.rs:828` 注释自陈），要么真处理。
- 怎么确认：`printf '{"id":1,"method":"rpc.cancel","params":{"runId":"nope"}}\n' | dieyun-core serve`
  → 返回 `"agentCancelled":true`（应 false）；`npm run test:core-event-channel` 回归反向通道时顺带断言取消。
- 置信度：high

### F2 一半的 async 臂直接同步跑 rusqlite：`memory.project_*` / `long_by_session` / `long_forget_session` 钉死 reactor 线程

- 类型：live-bug
- 严重度：high
- 位置：`crates/dieyun-core/src/rpc/mod.rs:1225-1269`（对照 `mod.rs:1364-1373` 的自述）、
  `crates/dieyun-core/src/sqlite.rs:38,231-240,322-352`
- 证据：

```rust
// mod.rs:1225-1233 / 1234-1238 / 1239-1250 / 1251-1260 / 1261-1269 全部在 AppState::dispatch 的 async 分支里
"memory.project_resolve" => {
    ...
    let memory = self.snapshot().await.memory;
    memory.resolve_project(path, git_origin)          // projects.rs:43  pub fn —— 同步 SQLite
}
"memory.project_list" => {
    ...
    memory.list_projects(limit)                        // projects.rs:172 pub fn —— 同步 SQLite
}
"memory.project_alias_add" => {
    ...
    memory.add_project_alias(project_id, path)         // projects.rs:137 pub fn —— 同步**写**
}
"memory.long_by_session" => {
    ...
    let rows = memory.long_memories_by_session(session_id, limit)?;   // recall.rs:181 pub fn —— 同步读
}
"memory.long_forget_session" => {
    ...
    let archived = memory.archive_long_memories_by_session(session_id)?; // longmem.rs:239 pub fn —— 同步**写**
}
```

```rust
// mod.rs:1364-1373 —— 同一文件里对「阻塞」的承诺
// 兜底：其余全部是同步分支（SQLite / 文件系统 / 纯 CPU）。
// 注意：真正的「哪些方法阻塞」清单只有一处，就是 `ServiceSnapshot::dispatch`。
_ => {
    let snap = self.snapshot().await;
    let method = method.to_string();
    run_blocking(move || snap.dispatch(&method, &params)).await
}
```

```rust
// sqlite.rs:38 / 231-240 / 347-350
pub const READ_POOL_CAP: usize = 4;
pub fn with_conn<T>(&self, f: ...) -> Result<T, CoreError> {
    let mut guard = self.conn.lock().unwrap_or_else(|e| e.into_inner());  // std::sync::Mutex，阻塞
    ...
}
pool = self.readers_free.wait(pool).unwrap_or_else(|e| e.into_inner());   // 读池排队，无超时
```

- 触发：这些方法**每次都**在 tokio worker 上执行同步 SQLite。出事前提是并发 + 竞争：
  1. 读池只有 4 条（`READ_POOL_CAP`），第 5 个读在 `Condvar.wait` 上无限期排队（`sqlite.rs:347`）——
     没有超时、没有让位，被钉住的就是 reactor worker；
  2. 写路径（`project_alias_add` / `long_forget_session`）要抢**唯一**那条写连接，`BUSY_TIMEOUT_SECS = 15`
     （`sqlite.rs:30`）：聊天落库 / 归纳器正在写时，一个 `memory.session_memories` 就能让一个 worker 卡 15s；
  3. planner 多 worker（`agent-limits.plannerMultiAgentEnabled`）并发跑时，worker 线程数用尽，
     连 `core.ping`（async 分支、只拼一个 json）都拿不到执行线程 → 宿主只能看到 `CORE_RPC_TIMEOUT`，
     与 core 的真实状态无关。
- 修法方向：把这 5 条臂整体挪进 `ServiceSnapshot::dispatch`（同样的 snapshot + `run_blocking`，
  零新增机制），async 分支只留真正 `.await` 的 `memory.long_recall` / `long_add` / `long_add_many` / `long_reindex`。
  并给「async 分支里不许出现同步 DB 调用」加一条可检查的约定（例如把 `MemoryStore` 的同步方法在 rpc 层
  只从 `ServiceSnapshot` 暴露）。
- 怎么确认：`cargo test -p dieyun-core --lib` 不覆盖并发；最小复现：起 core 后并发打
  4×`memory.project_list` + 1×`memory.long_add_many`（或任何长写），同时每秒一次 `core.ping`，
  观察 ping 的 p99 从毫秒掉到秒级；`npm run test:local-gateway-smoke` 可作为回归面。
- 置信度：high（代码事实），中（危害幅度取决于并发度）

### F3 「哪条方法算快」有三份实现，而 Rust 的 20s 预算永远晚于宿主的 15s —— 整条诊断通路是死代码

- 类型：structural-debt
- 严重度：high
- 位置：`crates/dieyun-core/src/rpc/mod.rs:31-59`、`src/core-rpc-timeouts.js:35,57-58`、
  `src/renderer/renderer-gateway.js:124-136`、`crates/dieyun-core/src/rpc/stdio.rs:121-133`、
  唯一测试 `crates/dieyun-core/src/rpc/mod.rs:1471-1476`
- 证据：

```rust
// mod.rs:40 / 51-59
pub const FAST_METHOD_BUDGET_MS: u64 = 20_000;
pub fn request_budget_ms(method: &str) -> Option<u64> {
    if method == "core.ping" || method == "rpc.cancel" { return Some(FAST_METHOD_BUDGET_MS); }
    if method.ends_with(".status") { return Some(FAST_METHOD_BUDGET_MS); }
    None
}
```

```js
// src/core-rpc-timeouts.js:35（core-bridge 的 ping 超时）/ 57-58
const pingTimeoutMs = Number(opts.pingTimeoutMs) > 0 ? Number(opts.pingTimeoutMs) : 15000;
// status 是纯读库，健康库上应毫秒级返回；15s 只会在真卡住时把调用拖成「假死」。
if (m === 'codebase.status' || m === 'graph.status') return 15000;
```

```js
// src/renderer/renderer-gateway.js:134-136 —— 同一批方法第三种口径
'codebase.status': 45000,
'graph.status': 45000,
```

```rust
// mod.rs:1472-1476 —— 唯一的测试还钉了一个不存在的方法（Rust 侧没有 memory.status 这条臂）
assert_eq!(request_budget_ms("memory.status"), Some(FAST_METHOD_BUDGET_MS));
```

- 触发：`request_budget_ms` 覆盖的三条方法，宿主侧的上限分别是 `core.ping` 15s、`*.status` 15s、
  `rpc.cancel` 从不等待（fire-and-forget）。于是 `stdio.rs:122-131` 的 `tokio::time::timeout(20s, …)`
  永远不可能先触发：宿主 15s 就放弃并重试了。`mod.rs:33-36` 声称的收益（「把 `RPC_TIMEOUT` 明确报回去，
  比让宿主客户端 45s 后才超时有用得多」）从来没有发生过，`[rpc-timeout]` 这类日志一行也不会出现；
  反过来，`method.ends_with(".status")` 是一个**按后缀**的白名单：今后任何叫 `xxx.status` 的长方法
  都会被静默套上 20s 掐断，而它不在任何文档里。
- 修法方向：减法优先 —— 删掉 `request_budget_ms` 与 `stdio.rs` 的 timeout 包装，只留 `[rpc-slow]` 耗时行
  （诊断价值在那一行，掐断没有任何价值，`mod.rs:38-39` 自己也承认「掐断 awaiter 也停不下底下已经跑起来的阻塞任务」）。
  若坚持保留，则把 `FAST_METHOD_BUDGET_MS` 压到小于宿主最小口径（15s），并把宿主的值从同一个来源推导。
- 怎么确认：`cargo test -p dieyun-core --lib rpc::tests::budget_covers_polling_methods_only`
  （正是钉住 20s 的那条测试）+ `grep -n "15000" src/core-rpc-timeouts.js`；或让 `codebase.status`
  排在长任务后，观察 main.log 只有宿主侧 `RPC_TIMEOUT … timeoutMs=15000`，没有 core 的「在途预算」错误。
- 置信度：high

### F4 `llm.complete` 被漏出超时表：660s 预算仍挂在已删除的 `agent.llm.chat` 上，真正在跑的这条只有 120s

- 类型：latent-bug
- 严重度：medium
- 位置：`src/core-rpc-timeouts.js:13-31,66-69`、`crates/dieyun-core/src/rpc/mod.rs:1085-1099,1405-1413`、
  `crates/dieyun-core/src/agent/llm.rs:26-27`、`src/agent/agent-synthesis.js:220`、`src/llm-stream-bridge.js:140`
- 证据：

```js
// src/core-rpc-timeouts.js:66-69
if (m === 'compaction.fold') return COMPACTION_FOLD_TIMEOUT_MS;
if (m === 'agent.llm.chat') return LLM_CHAT_TIMEOUT_MS;      // ← 方法已被删除（docs/LLM-RPC.md:62）
if (m === 'agent.run.start' || m === 'agent.run.tools') return AGENT_RUN_TIMEOUT_MS;
return DEFAULT_TIMEOUT_MS;                                    // ← llm.complete 落这里：120s
```

```rust
// llm.rs:26-27 —— core 自己给 llm.complete 的上限
pub const STREAM_TIMEOUT_SECS: u64 = 600;
pub const NON_STREAM_TIMEOUT_SECS: u64 = 300;
```

```rust
// mod.rs:1095（llm.complete）与 mod.rs:1407（agent.run.* 的 drive_spec）：同名参数，相反的默认值
let stream = params.get("stream").and_then(|v| v.as_bool()).unwrap_or(false);
...
stream: params.get("stream").and_then(|v| v.as_bool()).unwrap_or(true),
```

- 触发：任何一次超过 120s 的 `llm.complete`。现有调用方都不传 `timeoutMs`：
  `agent-synthesis.js:220`（`stream: true`，回合收尾汇总，长回答）+ `llm-stream-bridge.js:140`（Renderer 的
  流式对话）。到第 120 秒宿主 `reject(CORE_RPC_TIMEOUT)` 并丢掉结果，而 core 侧按 600s 还在流；
  已经推出去的 `agent.delta` 无法收口（交付文本丢失），Renderer 侧则表现为「说完一半突然失败」。
  非流式路径同理：core 允许 300s，宿主只等 120s。
- 修法方向：在 `resolveCoreRpcTimeoutMs` 里删掉 `agent.llm.chat`（幽灵）并加 `llm.complete`
  → `LLM_CHAT_TIMEOUT_MS`；顺手把 `stream` 的默认值在两处统一（`llm.complete` 缺省 false 会静默落到
  300s 口径，而调用方以为在流式）。
- 怎么确认：`node -e "console.log(require('./src/core-rpc-timeouts').resolveCoreRpcTimeoutMs('llm.complete'))"`
  → 现在打印 120000；改后应为 660000。端到端：让 synthesis 跑一次 >120s 的补全，观察
  `main.log` 的 `RPC_TIMEOUT llm.complete id=… timeoutMs=120000`。
- 置信度：high

### F5 catalog 生成器只认得一半写法：`memory.messages_clear` 在文档里是 gateway-only，实际 Rust 已实现（且被并进 session_delete）

- 类型：structural-debt
- 严重度：medium
- 位置：`scripts/lib/extract-rpc-methods.cjs:7`、`docs/rpc-catalog.md:214`、
  `crates/dieyun-core/src/rpc/mod.rs:336-342`、`crates/dieyun-core/src/memory/session.rs:438-461`、
  `src/gateway/handlers/memory.js:277-278`
- 证据：

```js
// scripts/lib/extract-rpc-methods.cjs:7 —— 只捕获行首的第一个名字，交替臂的第二个名字永远看不见
const RUST_METHOD_RE = /^\s+"([a-z][a-z0-9_.]+)"\s*(=>|\|)/gm;
```

```rust
// mod.rs:336-342 —— 一个分支同时实现「删会话」与「清空消息」
"memory.session_delete" | "memory.messages_clear" => {
    let session_id = ...;
    self.memory.clear_session(session_id)
}
```

```rust
// memory/session.rs:438-461 —— clear_session 删的是**会话行**，不只是消息
conn.execute("DELETE FROM agent_traces WHERE session_id = ?1", ...)?;
conn.execute("DELETE FROM agent_runs  WHERE session_id = ?1", ...)?;
conn.execute("DELETE FROM messages     WHERE session_id = ?1", ...)?;
conn.execute("DELETE FROM session_handoffs WHERE session_id = ?1", ...)?;
conn.execute("DELETE FROM sessions WHERE id = ?1", params![session_id])?;
```

```
// docs/rpc-catalog.md:214（生成物）
| `memory.messages_clear` | gateway | gateway/handlers/memory.js | — |
```

- 触发/后果：`npm run verify:rpc-catalog` 是「生成物与生成物比」，所以永远绿，这个缺口不会被 CI 抓到。
  1. 按 catalog 判断「这条 RPC 走哪层」的人（含审计、排障、Node 侧改动）会认为 `messages_clear`
     只有 Gateway 实现，看不到 Rust 里它已经存在；
  2. 而 Rust 里的语义是**删除整个会话行**（含 traces / runs / handoffs），名字却说「清空消息」：
     任何一天有人把这个 RPC 接上「清空当前对话」按钮，用户丢的是整个会话（含它的工作区绑定与交接），
     且返回 `{"ok":true}` 不给任何提示；
  3. 目前 `memory.messages_clear` 在 Node 侧只有 handler 定义（`memory.js:277`），**没有任何调用方** ——
     即一条已经与 `session_delete` 合并、又没人用的别名，还在分派表里占位。
- 修法方向：删掉 `"memory.messages_clear"` 这个别名（减法：无调用方、语义与 session_delete 无法区分）；
  同时把 `RUST_METHOD_RE` 改成能匹配 `| "name"` 交替臂（`/^\s+"([a-z][a-z0-9_.]+)"(?:\s*(?:\||,)\s*"[a-z][a-z0-9_.]+")*\s*=>/`
  再逐个捕获），并在 `--check` 里加一条「分派臂数量 == catalog rust 条目数量」的自检。
- 怎么确认：`node scripts/generate-rpc-catalog.cjs --check`（现在通过 = 缺口存在）；
  `grep -n 'memory.messages_clear' docs/rpc-catalog.md crates/dieyun-core/src/rpc/mod.rs`。
- 置信度：high

### F6 `agent.delta` 的 `round` 永远是 null：三处调用点硬写 `None`，参数形同虚设，正好落进账本注释禁止的「宿主自己数轮次」

- 类型：structural-debt（附 latent-bug 后果）
- 严重度：medium
- 位置：`crates/dieyun-core/src/rpc/events.rs:40-49`、`crates/dieyun-core/src/rpc/mod.rs:1006-1016,1050-1057,1113-1121`、
  `crates/dieyun-core/src/agent/loop_run.rs:486-496`、`src/agent/rust-loop-runner.js:595`、`docs/LLM-RPC.md:77,92`
- 证据：

```rust
// events.rs:40-49 —— 参数有 round，但三个调用点全部传 None
pub fn emit_delta(run_id: &str, round: Option<u64>, content: Option<&str>, reasoning: Option<&str>) {
    emit("agent.delta", json!({ "runId": run_id, "round": round, "content": content, "reasoning": reasoning }));
}
```

```rust
// mod.rs:1006-1016（1050-1057、1113-1121 同形）
// `round` 暂传 None：宿主侧按「round 为空就用本地轮次计数」兜住。
let emit = |d: &crate::agent::llm::Delta| {
    crate::rpc::events::emit_delta(&run_id, None, d.content.as_deref(), d.reasoning.as_deref());
};
```

```rust
// loop_run.rs:486-490 —— 被上面那句注释直接违反
/// 轮次是账本事实，宿主不能自己数（一个 run 会被 `agent.run.start` / `agent.run.tools` 分多次驱动，
/// 宿主侧的计数必然与账本分叉）。
pub fn round_of(&self, run_id: &str) -> Option<u32> { ... }
```

```js
// src/agent/rust-loop-runner.js:595 —— 宿主只能退回自己的计数
round: event.round != null ? Number(event.round) : llmRound,
```

```
docs/LLM-RPC.md:77  {"type":"event","event":{"type":"agent.delta","runId":"run-7","round":2,"content":"片段",...}}
```

- 触发/后果：文档承诺的 `round:2` 从未出现过，宿主永远走 `llmRound` 兜底。只要 core 在一轮里多走一步账本
  （上下文溢出强制折叠重发、上游拒图后 `drop_images` 重发、`max_rounds` 续轮），宿主计数与账本 round 就分叉：
  UI 的轮次标签、思考分段、以及 `prepareRequestMessages(messages, roundNo)` 的入参（`rust-loop-runner.js:621`）
  都会拿到错轮次，属于「静默错标」而不是报错。`round_of` 已经存在且 driver 每轮都在用（`driver.rs:114`
  `"round": manager.round_of(run_id)`），说明这个参数本来是能填的。
- 修法方向：一处改完 —— 驱动器的 emit 闭包改成 `manager.round_of(&run_id)`（map `u32→u64`）；
  若决定不做，就删掉 `emit_delta` 的 `round` 参数并同步把 `docs/LLM-RPC.md:77,92` 与宿主兜底逻辑一起删，
  别留「文档有、代码永远 null」的第三种状态。
- 怎么确认：`cargo test -p dieyun-core --lib agent::driver`（现有 round.prepare 用例可扩充为断言
  `agent.delta` 的 `round` 非空）；Node 侧 `npm run test:rust-agent-loop-smoke` 观察 `llm_delta.round`。
- 置信度：high

### F7 `core.configure` 半应用：config 已指向新库、`MemoryStore` 还是旧库，且没有回滚

- 类型：latent-bug
- 严重度：medium
- 位置：`crates/dieyun-core/src/rpc/mod.rs:933-971`
- 证据：

```rust
// mod.rs:938-971
let reopen_cfg = {
    let mut guard = self.inner.write().await;
    let old_mem_path = guard.memory.db_path().to_path_buf();
    guard.config.apply_configure(&p).map_err(CoreError::Other)?;   // ← 先把 config 改成新路径
    ...
    if same_path(&old_mem_path, &new_mem_path) {
        guard.memory.set_embedding(embedding);
        None
    } else {
        Some(guard.config.clone())                                  // ← 稍后在新 config 上重开
    }
};
if let Some(cfg) = reopen_cfg {
    let store = tokio::task::spawn_blocking(move || memory::MemoryStore::from_config(&cfg))
        .await
        .map_err(|e| CoreError::rpc("MEMORY_REOPEN_JOIN", e.to_string()))??;   // ← 失败即 return，config 不回滚
    let mut guard = self.inner.write().await;
    guard.memory = store;
}
```

- 触发：`core.configure` 换了 `data_dir`（或未来的 memory 路径覆盖）导致 memory 库文件变化，而新路径不可写 /
  目录不存在 / 旧文件被占（`spawn_blocking` 里 `MemoryStore::from_config` 失败，或 join 失败）。
  此时 RPC 返回错误，但 **`AppConfig` 已经是新路径**：随后 `memory.message_append` 继续写旧库，
  而 `memory.ping`（返回 `dbPath`，`store.rs:87-95`）、`embedding.status`、下次启动的路径解析都按新库回答。
  用户看到的是「记忆突然回到很早以前 / 全丢」，日志里只有一次 configure 失败。
  同一函数还有第二个窗口：释放写锁之后、`guard.memory = store` 之前（`mod.rs:962-969`），
  并发请求用旧 store 写一轮，这轮写入就落在那份即将被丢弃的连接对应的文件里。
- 修法方向：把「建新 store」放在拿写锁**之前**（已经如此），但把 config 的落地也挪到同一段：
  先在写锁外的 `spawn_blocking` 里用**候选 config** 建好 store，成功后再一次拿写锁同时替换
  `config` + `memory`（一次换，失败则整段不变）；不要先 apply 再补。
- 怎么确认：最小复现 —— 起 core 后 `core.configure` 把 `data_dir` 指到一个只读目录（Windows 下可用
  `%SystemRoot%\System32\config` 之类），RPC 报错后连打 `memory.ping`：`dbPath` 已是新路径而
  `memory.message_append` 仍成功（写到旧库）；`cargo test -p dieyun-core --lib memory` 覆盖 store 重开，但不覆盖这条半应用。
- 置信度：high（代码路径确定），中（触发需 configure 失败）

### F8 分派任务没有 panic 兜底、stdio 三处写失败被吞：一次 panic 换来宿主 120s 干等

- 类型：latent-bug
- 严重度：medium
- 位置：`crates/dieyun-core/src/rpc/stdio.rs:60-90,112-114`、`crates/dieyun-core/src/rpc/events.rs:28-37`、
  可触发 panic 的一例：`crates/dieyun-core/src/planner/run.rs:275-276`（`pub fn cancel` 里 `self.runs.lock().unwrap()`，
  经 `planner.run.cancel` / `rpc.cancel` 进入）
- 证据：

```rust
// stdio.rs:63-90 —— 每条请求一个裸 tokio 任务，没有 catch_unwind / 没有 id 级兜底
tokio::spawn(async move {
    ...
    let response = match serde_json::from_str::<RpcRequest>(&raw) {
        Ok(req) => handle_request(&state, req).await,
        Err(err) => RpcResponse::err(serde_json::Value::Null, ...),
    };
    if let Ok(out) = serde_json::to_string(&response) {
        let mut guard = stdout.lock().await;
        let _ = guard.write_all((out + "\n").as_bytes()).await;   // ← 写失败静默
        let _ = guard.flush().await;
    }
});
```

```rust
// events.rs:36 —— 事件通道关闭后 send 失败也被吞，调用方以为发出去了
let _ = tx.send(event);
```

```rust
// stdio.rs:112-114 —— worker 线程 panic 被 join 结果丢弃，进程正常退出 0
drop(tx);
let _ = worker.join();
Ok(())
```

- 触发：任何一条分派路径 panic（最现实的是 `planner` 里对 `std::sync::Mutex` 的 `.unwrap()`——
  `run.rs:277` 的 `cancel`、`emit_phase` 等都这样；一次 panic 后锁中毒，之后每次取消都 panic）。
  该请求的任务直接消失：**没有任何响应**（连 error 行都没有），宿主只能等满 120s `CORE_RPC_TIMEOUT`，
  且 core 侧唯一痕迹是一行没有方法名/请求 id 的 stderr panic。同理，`stdout` 写失败（宿主已死、
  pipe 断）时请求方与事件方都得不到通知，core 会继续安静地处理下去。
- 修法方向：在 spawn 的任务里包一层 `AssertUnwindSafe(fut).catch_unwind()`，把 panic 变成
  带方法名的 `INTERNAL`/`RPC_PANIC` 响应（`blocking.rs:18-20` 已经为阻塞池做过同样的取舍，这里缺一份）；
  `emit` / `write_all` 的失败改为能观察（至少 `eprintln` 一次并把 `enabled()` 置 false，让 `calls.rs:51`
  的 `HOST_UNAVAILABLE` 早退生效，而不是白等 30s）。
- 怎么确认：临时在 `ServiceSnapshot::dispatch` 里对某个方法 `panic!()`（**只在本地验证**），
  然后 `printf '{"id":1,"method":"memory.ping"}\n{"id":2,"method":"<该方法>"}\n' | dieyun-core serve`
  → id=2 永远没有响应；`cargo test -p dieyun-core --lib rpc` 目前覆盖不到。
- 置信度：medium

### F9 唯一一条把必填参数缺省成空串的臂：`memory.messages_delete_turn` 用 `ok:true` 包裹失败

- 类型：latent-bug
- 严重度：low
- 位置：`crates/dieyun-core/src/rpc/mod.rs:437-455`、`crates/dieyun-core/src/memory/misc.rs:18-23`
- 证据：

```rust
// mod.rs:437-455 —— 全模块唯一用 unwrap_or("") 处理必填 sessionId 的地方
"memory.messages_delete_turn" => {
    let session_id = params.get("sessionId").and_then(|v| v.as_str()).unwrap_or("");
    let ids: Vec<i64> = params.get("messageId").and_then(|v| v.as_array())...unwrap_or_default();
    let remove_count = params.get("removeCount").and_then(|v| v.as_i64());
    self.memory.delete_turn_messages(session_id, &ids, remove_count)
}
```

```rust
// memory/misc.rs:18-23 —— 缺参不是错误，是「成功但 ok:false」
let sid = session_id.trim();
if sid.is_empty() {
    return Ok(json!({ "ok": false, "error": "sessionId 必填", "deleted": 0, "messageId": [] }));
}
```

- 触发：宿主侧漏传 `sessionId`（或传了 `null`）时，RPC 层返回 `result` 而不是 `error`：调用方只要
  「没抛异常」就当删成功。其它 40 多条臂对必填参数一律 `ok_or_else(|| CoreError::rpc("INVALID_PARAMS", …))`，
  同一份「缺参怎么办」的知识在这里是另一套。现有两个 Node 调用方侥幸没事：`memory.js:270` 会补空串、
  `renderer-chat-bubbles.js:668` 会检查 `deleted === 0`——但这是两个互相独立的兜底，不是契约。
- 修法方向：改成与其它臂一致 —— `sessionId` 走 `ok_or_else(INVALID_PARAMS)`，`misc.rs` 里那段
  `Ok(json!({"ok": false, …}))` 删掉（错误只有一个出口）。
- 怎么确认：`printf '{"id":1,"method":"memory.messages_delete_turn","params":{"messageId":[1]}}\n' | dieyun-core serve`
  → 现在返回 `{"ok":false,…}` 且 `error` 为空；改后应是 `{"error":{"code":"INVALID_PARAMS"}}`。
- 置信度：high

---

## 未列入但已核实「不是缺陷」的点（避免后续重复怀疑）

- `core.configure` 里 `crate::codebase_db::handle(new_db_path)` 不会阻塞：`SqliteHandle` 连接是惰性的
  （`sqlite.rs:201-214`、`store.rs:59-63`），建表在首次使用时才发生。
- `ConfigureParams` 是 snake_case（`config.rs:32-45` 无 `rename_all`），与 `gateway/server.js:321-322` 的
  `data_dir` / `workspace_roots` 一致；`LlmConfig` 是 camelCase，与 `llm-complete.js` 的 `baseUrl` / `apiKey` 一致。
- `codebase.index.start` 的 `vectors: undefined`（Node 注释说「听持久意图」）没有丢：意图在
  `gateway/rpc.js:1752` 的 `resolveIndexVectorsIntent` 就解析完了，到 Rust 时已是布尔值。
- `memory.messages_search` / `compaction_folded` 的 `snippetChars` 在 Rust 内部还有一次
  `clamp(60, 2000)` / `clamp(60, 4000)`（`archive.rs:113,223`），不构成越界或切碎中文。
- `AppState::new` 里 `MemoryStore::from_config(...).unwrap_or_else(|e| panic!(...))`（`mod.rs:789-790`）
  看着是 panic 面，但 `MemoryStore::open` 全惰性、实际不可能返回 Err，属死代码——建议顺手改成
  `expect` 文案或干脆返回 `Result`，不值得单列一条发现。

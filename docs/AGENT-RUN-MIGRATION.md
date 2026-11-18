# `agent.run`：把轮次控制搬进 core（P1c-2 施工图）

> **状态**：**第 1 步（反向通道）已实施并真进程验证**；第 2–6 步未开始。前三项（LLM 客户端 / 事件通道 / 折叠与 transcript 单一写者）已完成。
> 本文是唯一入口：接手者照此施工，不需要重新调研。

## 0. 已完成的那一步：反向调用通道

| 位置 | 内容 |
|---|---|
| `crates/dieyun-runtime/src/rpc/calls.rs` | `call_host(method, params)` → oneshot 等答复；30s 超时；无宿主通道时报 `HOST_UNAVAILABLE`（不发没人回的行）；迟到答复丢弃 |
| `rpc/stdio.rs` | stdin 的 `type:"reply"` 在解析成请求前拦下；反向调用**以自己的行类型** `type:"call"` 发出（包进 `type:"event"` 会被当通知丢掉——踩过） |
| `rpc/mod.rs` | `core.host_probe`（诊断）：core 调宿主 `core.echo` 并断言答复回来 |
| `src/core-bridge.js` | `type:"call"` 分流 + `onCoreCall(method, handler)` + 答复写回 stdin |
| `scripts/test-core-event-channel.cjs` | 真进程一次性验三种行：事件 / 反向调用 / 答复 |

下一步从 §2.3 的 loop 开始；`round.prepare` 与 `tool.execute` 都走这个通道。

---

## 1. 现状与目标

| 能力 | 现在在哪 | 目标 |
|---|---|---|
| LLM 请求 + SSE | Rust（`agent/llm.rs`，RPC `agent.llm.chat`） | 不变，但**由 core 自己调**，不再经 RPC |
| 折叠 | Rust（`need_llm` 内部） | 不变 |
| transcript | Rust 独占（`drop_images` 是唯一宿主可请求的改写） | 不变 |
| **轮次控制** | **Node**：`rust-loop-runner.js` 的 `while (phase !== 'done')` | **Rust** |
| 工具执行 | Node（正确） | 不变，但调用方向反转 |

## 2. 协议

### 2.1 宿主 → core

```
agent.run.start { runId, model, messages, tools, maxRounds, maxToolCalls,
                  tokenBudget, triggerRatio, url, llm:{baseUrl,apiKey,headers,authMode},
                  stream } → { phase:"need_tools", runId, delegates:[{id,name,arguments}] }
                            | { phase:"done", runId, content, trace, messages, hitRoundLimit }
agent.run.tools { runId, results:[{id,result,error?}] } → 同上
agent.run.cancel { runId }
```

**`runId` 必须由宿主生成并传入**：core 在 `start` 内部就开始发 `agent.delta` 事件，而宿主要在**发请求之前**订阅并按 `runId` 过滤 —— 等 core 返回再拿 id 就晚了（第一轮的增量会丢）。这是设计里最容易踩的一脚。

### 2.2 core → 宿主（反向调用，新增）

stdout 上除了 `type:"event"`、响应之外，新增：

```json
{"type":"call","id":7,"method":"round.prepare","params":{"runId":"run-1","round":2,"messages":[...]}}
```

宿主在 stdin 回：

```json
{"type":"reply","id":7,"result":{"messages":[...],"visionInjected":1}}
```

分流规则（`src/core-bridge.js:onStdoutChunk`）**只有一条**：带 `type` 的行按 type 分流（`event` → 订阅者、`call` → 注册的 handler），其余按 `id` 匹配 pending 响应。

为什么需要它：`round.prepare` 是每轮都要 Node 做的事（浏览器截屏注入、附件图重注入、字符裁剪），Node 不可能在 `start` 里一次性做完。

### 2.3 core 内部循环

```
loop {
  fold_if_needed(state)                     // 已有
  call host "round.prepare" → messages       // 新增（视觉注入等）
  outcome = llm::chat_completion(...)        // 已有，增量走 events
  resp = ledger.continue_llm(outcome)        // 已有
  match resp.phase {
    "need_delegate" => return need_tools,
    "done"          => return done,
    _               => continue,
  }
}
```

`ledger` 就是现有的 `AgentLoopManager`：状态机逻辑一行都不用改，只是**驱动者**从 Node 换成 core。这正是这一步风险可控的原因。

## 3. 施工顺序（每步都可独立验证）

1. **反向通道**：`rpc/calls.rs`（`request(method, params) → oneshot`，stdin 上 `type:"reply"` 路由）+ `core-bridge` 的 `type:"call"` 分流 + `onCoreCall(method, handler)` 注册口。
2. **`agent.run.start/tools/cancel`**：Rust 的 async 驱动（新建 `agent/run.rs`），内部复用 ledger 与 `llm::chat_completion`；先只接 `tool.execute` 一个反向方法。
3. **Node 换驱动**：`rust-loop-runner.js` 的 `while` 只保留「工具执行 + 结果回填」；删 `fetchLlmRound` / `chatViaCore` / `need_llm` 分支（增量改由事件订阅转发 `llm_delta`，订阅点必须在 `start` 之前）。
4. **`round.prepare` 回调**：把 `withVision` / `capAndSyncLoopMessages` / `dropRejectedRoundImages` 收进一个 handler（这三件事都只改「本次请求的 messages 副本」，不改账本）。
5. **删旧 RPC**：`agent.llm.chat`、`agent.loop.start`、`agent.loop.continue`、`agent.loop.tool_results`。`agent.loop.fold` 保留（溢出兜底的对外触发），`agent.loop.drop_images` 保留（拒图重发），`agent.loop.cancel` 与 `agent.run.cancel` 合并。
6. **planner worker**：`rust-planner-runner.js` 复用同一 runner，`build_worker_loop_start` 同步切；`planner.run.worker_loop` 保持不动（它是 planner 自己的相位机）。

## 4. 验收

```bash
cargo test -p dieyun-core --lib                 # 新增：驱动循环在无工具时应一次跑完；有工具时应停在 need_tools
node scripts/test-core-event-channel.cjs        # 扩成「事件 + 反向 round.prepare 调用」双向用例
node scripts/test-rust-loop-runner.cjs          # 换契约：断言不再出现 agent.llm.chat / agent.loop.continue
npm run pack:dieyun-core && npm test            # 必须按这个顺序（smoke 用的是 build/ 里的二进制）
```

## 5. 负向清单

- **不要**让 core 猜 `runId`：宿主生成并在 `start` 里传入，否则第一轮增量必然丢。
- **不要**把工具执行搬进 core：工具是平台能力的宿主（Playwright / ssh2 / koffi），core 里没有也不该有。
- **不要**在 `round.prepare` 里让 handler 改账本：它只交出「本次请求用的 messages 副本」。
- **不要**为「core 不支持某平台能力」加能力开关表：需要平台能力的都留在 Node，通过反向调用请求。
- **不要**保留 `agent.loop.continue` 做兼容：两条驱动者同时存在，就是又要维护两份轮次语义。

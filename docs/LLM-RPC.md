# LLM 调用与 core→宿主事件通道

> **状态**：**已切换**（2026-11-17）。agent 循环（`rust-loop-runner.js`）的 LLM 调用与流式解析已全部走这里；Node 侧不再自己发 chat 请求。
> **代码**：`crates/dieyun-core/src/agent/llm.rs`（请求 + SSE 解析）、`src/rpc/events.rs`（事件出口）、`src/core-bridge.js:onCoreEvent`（宿主订阅）、`src/agent/rust-loop-runner.js:chatViaCore`（宿主适配）。

## 0. 还没搬的（P2 范围，别误以为已经统一）

agent 循环之外的**辅助任务**仍各自打端点：`agent-synthesis.js`、`session-title.js`、`turn-reviewer-run.js`、`rust-planner-runner.js`、`plans/runner.js`、`knowledge-maintainer.js`、`llm-stream-bridge.js`（Renderer 侧）。它们不参与 agent 循环，形状各异（有的要 JSON、有的要流式），搬之前得先统一「请求装配」——这正是 P2 的活。**新增代码不要往这堆里再加一份**。

---

## 1. 为什么搬进 Rust

一次对话的请求此前被切成三份：请求体在 Rust（`agent.loop.need_llm` 拼 `llm_body`）、HTTP 与 SSE 解析在 Node（`llm-stream-utils.js`）、请求头又在 Node（`llm-request.js`）。结果是「这轮到底发了什么」只能靠三处日志拼，而流式增量还要靠**正则刮 core 的 stderr**（`[compaction-llm] …`）才能显示。

现在：**谁发请求，谁解析流**。Node 只交出 `url + headers + body`。

## 2. RPC：`agent.llm.chat`

| 入参 | 说明 |
|---|---|
| `url` | **完整端点**。路径约定与鉴权口径的唯一来源仍在 `src/agent/llm-request.js`，Rust 不重推导 |
| `body` | 请求体，原样发出（`model` / `messages` / `tools` / `stream` …） |
| `stream` | 默认 `true`；`false` 走整包响应 |
| `llm` | 可选 `LlmConfig`（`baseUrl` / `apiKey` / `headers` / `authMode`）；缺省用 `core.configure` 里那份 |
| `runId` / `round` | 仅用于给增量事件打归属，不参与请求 |
| `includeRaw` | 调试抓包：把响应原文（≤4MB）一并回传，供 `DIEYUN_LLM_RAW_LOG` 落盘 |

## 2.1 宿主对 transcript 的权限：只剩「摘图」

整段覆盖 messages 的 `agent.loop.set_messages` **已删除**。上游拒图时宿主只能发一条窄请求：

```
agent.loop.drop_images { runId, indices?: number[] } → { dropped: number, messages: Value[] }
```

- 不带 `indices` = 摘掉账本里所有消息的图片；带 `indices` = 只摘这几条（越界忽略）。
- 返回的 `messages` **只是给宿主拼本次重发请求用的副本**；落库真相仍在 core。
- 摘图语义复用折叠里那套「图片换成可读标记」（`compaction::strip_images_only`），不另写一份。

至此 **Node 没有任何写 transcript 的路径**：能改对话的只有 core（折叠 / 账本推进 / 摘图）。

返回：`{ content, reasoning, finishReason, toolCalls:[{id,name,arguments}], usage, model, raw? }`

错误：`LLM_CONFIG`（端点空）、`LLM_HTTP`（传输层）、`LLM_API`（上游 4xx/5xx 或 `error` 包）、`LLM_PARSE`（响应不是 JSON）。

## 3. 事件通道：`type:"event"`

core 在 stdout 上除了「响应」还会写事件行：

```json
{"type":"event","event":{"type":"agent.delta","runId":"run-7","round":2,"content":"片段","reasoning":null}}
```

宿主侧规则（`core-bridge.js`）：
- 行里有 `type:"event"` → 交给 `onCoreEvent` 的订阅者，**不参与 pending 匹配**；
- 其余行按 `id` 匹配响应。

事件是**进程级**的（一个 core 服务一个宿主），订阅方必须按 `runId`（必要时 `round`）自行过滤。

当前事件类型：

| type | 字段 | 用途 |
|---|---|---|
| `agent.delta` | `runId, round, content?, reasoning?` | 流式增量；两个通道**分开**下发，绝不合并 |

## 4. 负向清单

- **不要**在 Node 侧再写一份 SSE 解析（`llm-stream-utils.js` 的流式分支在宿主切换后应删除）。
- **不要**把 core 的 stderr 人类日志当事件源（那是上一版的做法，已删）。
- **不要**在这一层加重试/退避：上游抖动是外部系统，重试只会把一次失败变成多次失败 + 更长等待。
- **不要**在 Rust 里拼端点路径或猜鉴权：`llm-request.js` 是唯一来源。
- **不要**让 `agent.delta` 承担「本轮结束」语义：结束/工具调用/错误仍由响应体表达。

## 5. 测试

```bash
cargo test -p dieyun-core --lib agent::llm          # 9 条：增量拼装 / 分片工具参数 / 双通道 / 整包 / 错误包 / 真 HTTP+SSE
cargo test -p dieyun-core --lib rpc::tests::agent_llm_chat   # 分发 → HTTP → SSE → 事件通道
```

真 HTTP 用例手写了一个最小 chunked 服务端，**故意把一条 JSON 切在两个 TCP 块之间**——块边界丢半行是这条链路最容易写错的地方。

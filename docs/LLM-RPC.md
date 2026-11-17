# LLM 调用与 core→宿主事件通道

> **状态**：**全部统一**（2026-11-17）。仓库里只有 core 一份 LLM 传输实现：
> 主循环（`agent.run.*`，core 自己调）、六个辅助任务（标题 / 回合汇总 / 评审 / 计划执行 /
> 记忆提炼 / planner 各相位）、以及 Renderer（经 Main 转发）都走同一条路。
>
> **代码**：`crates/dieyun-core/src/agent/llm.rs`（请求 + SSE 解析 + usage + 抓包）、
> `crates/dieyun-core/src/rpc/events.rs`（事件出口）、`crates/dieyun-core/src/rpc/calls.rs`（反向调用）、
> `src/agent/llm-complete.js`（宿主唯一调用入口）、`src/core-bridge.js:onCoreEvent`（宿主订阅）。

---

## 1. 为什么搬进 Rust

一次对话的请求此前被切成三份：请求体在 Rust（`agent.loop.need_llm` 拼 `llm_body`）、
HTTP 与 SSE 解析在 Node（`llm-stream-utils.js`）、请求头又在 Node（`llm-request.js`）。
结果是「这轮到底发了什么」只能靠三处日志拼，流式增量还要靠**正则刮 core 的 stderr** 才能显示。

更糟的是辅助任务各自又写了一份 HTTP 客户端（`llm-proxy.js`），与主链路各维护端点、
请求头、超时、错误分类 —— 改一处漏一处就漂移（历史上出现过「对话正常、压缩一跑就 400」）。

现在：**谁发请求，谁解析流**。宿主只交出 `url + headers + body`。
`src/llm-proxy.js`、`src/llm-stream-utils.js`、`src/llm-stream-bridge.js` 的自建 HTTP 通路**均已删除**。

## 2. RPC：`llm.complete`（通用一次调用）

宿主侧唯一入口是 `src/agent/llm-complete.js:completeOnce()`，别在调用点直接 `invoke('llm.complete')`。

| 入参 | 说明 |
|---|---|
| `url` | **完整端点**。路径约定与鉴权口径的唯一来源仍在 `src/agent/llm-request.js`，Rust 不重推导 |
| `body` | 请求体对象（`model` / `messages` / `tools` / `temperature` …），原样发出 |
| `stream` | 默认 `false`；`true` 时按 SSE 解析 |
| `llm` | 可选 `LlmConfig`（`baseUrl` / `apiKey` / `headers` / `authMode`）；缺省用 `core.configure` 里那份 |
| `runId` | **可选**。给了（且 `stream:true`）就把增量推事件通道；不给就是纯一次性调用 |
| `includeRaw` | 调试抓包：把响应原文（≤4MB）一并回传，供 `DIEYUN_LLM_RAW_LOG` 落盘 |

返回：`{ content, reasoning, finishReason, toolCalls:[{id,name,arguments}], usage, model, raw? }`

错误：`LLM_CONFIG`（端点空）、`LLM_HTTP`（传输层）、`LLM_API`（上游 4xx/5xx 或 `error` 包）、
`LLM_PARSE`（响应不是 JSON）。

> 注意：返回是 **core 的规范形状**，不是上游 OpenAI 的 `choices` 结构。
> 把它再包回 `choices` 等于伪造上游 JSON 的第二份表示 —— 宁可让调用方读 `content`。

### 2.1 谁在用它

| 调用方 | 位置 | 说明 |
|---|---|---|
| 会话标题 | `src/agent/session-title.js` | 失败静默、保留启发式标题 |
| 回合收尾汇总 | `src/agent/agent-synthesis.js` | `stream:true` + 专用 runId `<runId>-synthesis`，不跟主循环增量混流 |
| 回合评审 | `src/agent/turn-reviewer-run.js` | JSON 模式不支持就退普通模式重发；任何失败只「跳过验收」 |
| 计划执行 | `src/plans/runner.js` | `signal` 支持 abort 立刻返回 |
| 记忆提炼 | `src/agent/knowledge-maintainer.js` | `fetch` 参数退化为纯测试注入点 |
| planner 各相位 | `src/agent/rust-planner-runner.js` | `runWithLlmReconnectRetry` 留在 Node（业务决定，不是传输实现） |
| Renderer 的 LLM | `src/llm-stream-bridge.js` | Renderer 经 preload 的 `llmChatCompletion` / `llmStreamChat` → 这里 → `llm.complete` |

### 2.2 主循环不是走这条 RPC

agent 主循环由 core 自己驱动（`agent.run.start` / `agent.run.tools`，见
[`AGENT-RUN-MIGRATION.md`](./AGENT-RUN-MIGRATION.md)），core 内部直接调 `llm::chat_completion`。
旧的 `agent.llm.chat` 与 `agent.loop.*` **已删除**。

### 2.3 宿主对 transcript 的权限：只剩「摘图」

整段覆盖 messages 的 `agent.loop.set_messages` **已删除**，账本上的 `set_messages` 方法也一并删除。
上游拒图时的自愈现在在 **core 内部**完成（`driver` 收到「图片不被支持」→ `drop_images(全部)` → 重发一次）；
上下文溢出同理（强制折叠一次 → 重发一次）。两条都是「各只试一次」。

至此 **Node 没有任何写 transcript 的路径**：能改对话的只有 core。

## 3. 事件通道：`type:"event"`

core 在 stdout 上除了「响应」还会写事件行：

```json
{"type":"event","event":{"type":"agent.delta","runId":"run-7","round":2,"content":"片段","reasoning":null}}
```

宿主侧规则（`core-bridge.js`）：
- 行里有 `type:"event"` → 交给 `onCoreEvent` 的订阅者，**不参与 pending 匹配**；
- 行里有 `type:"call"` → 反向调用，交给 `onCoreCall` 注册的 handler，答复写回 stdin（见 `rpc/calls.rs`）；
- 其余行按 `id` 匹配响应。

事件是**进程级**的（一个 core 服务一个宿主），订阅方必须按 `runId`（必要时 `round`）自行过滤。
**订阅必须发生在发请求之前** —— 否则第一段增量会丢（`runId` 由宿主生成并传入正是为此）。

当前事件类型：

| type | 字段 | 用途 |
|---|---|---|
| `agent.delta` | `runId, round, content?, reasoning?` | 流式增量；两个通道**分开**下发，绝不合并 |
| `agent.usage` | `runId, usage, model` | 每轮真实用量（成本统计只认它，别自己估） |

## 4. 负向清单

- **不要**在 Node / Renderer 侧再写一份 HTTP 客户端或 SSE 解析（`llm-proxy.js` / `llm-stream-utils.js` 已删，
  别以任何理由加回来）。
- **不要**把 core 的 stderr 人类日志当事件源（那是上一版的做法，已删）。
- **不要**在这一层加重试/退避：上游抖动是外部系统，重试只会把一次失败变成多次失败 + 更长等待。
  （`runWithLlmReconnectRetry` 属于「同一请求再试一次」的业务决定，只在 planner 一处保留。）
- **不要**在 Rust 里拼端点路径或猜鉴权：`llm-request.js` 是唯一来源。
- **不要**让 `agent.delta` 承担「本轮结束」语义：结束/工具调用/错误仍由响应体表达。
- **不要**给一次性调用加取消 RPC：没人要结果时退订 + 停止转发即可。

## 5. 测试

```bash
cargo test -p dieyun-core --lib agent::llm              # 增量拼装 / 分片工具参数 / 双通道 / 整包 / 错误包 / 真 HTTP+SSE
cargo test -p dieyun-core --lib agent::driver           # 轮次驱动 + round.prepare + 溢出/拒图自愈
node scripts/test-core-event-channel.cjs                # 真进程：响应 / 事件 / 反向调用 / 答复 四种行 + llm.complete
```

真 HTTP 用例手写了一个最小 chunked 服务端，**故意把一条 JSON 切在两个 TCP 块之间** ——
块边界丢半行是这条链路最容易写错的地方。

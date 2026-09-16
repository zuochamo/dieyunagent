# AgentRunEvent 契约（自动生成）

> 源文件：[`src/agent/run-events.js`](../src/agent/run-events.js)。更新后运行 `npm run generate:agent-events`。

生成时间：2026-09-09T01:43:03.652Z

## 事件类型

| type | 说明 | Producer | Consumer |
|------|------|----------|----------|
| `run_start` | Agent run 开始 | Main/Rust loop | Renderer, Mobile |
| `prep` | 准备阶段（上下文/工具组装） | Renderer prep | Renderer thinking UI |
| `trace` | 思考 trace 更新 | Rust loop / Renderer | Renderer, Mobile task.progress |
| `stream` | 助手正文流式增量 | Rust loop | Renderer bubble, Mobile streamContent |
| `tool` | 工具调用轮次 | Rust loop | Renderer tool cards |
| `round_limit` | 达到轮次上限 | Guardrails | Renderer, Mobile |
| `arbitration` | 多 Agent 仲裁 | Planner | Renderer |
| `done` | 正常完成 | Rust loop / Renderer | Renderer, Mobile task.completed |
| `error` | 失败 | Rust loop / Main | Renderer, Mobile task.failed |
| `stopped` | 用户停止 | Main | Renderer, Mobile task.stopped |

## 公共字段（`createAgentRunEvent`）

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `type` | AgentRunEventType | 是 |  |
| `at` | number | 是 | Unix ms timestamp |
| `sessionId` | string|null | 否 |  |
| `runId` | string|null | 否 |  |
| `requestId` | string|null | 否 |  |
| `trace` | TraceEntry[] | 否 |  |
| `streamContent` | string | 否 | 助手回复流式正文（PC + 手机） |
| `hitRoundLimit` | boolean | 否 |  |
| `stopped` | boolean | 否 |  |
| `error` | string | 否 |  |
| `summary` | string | 否 |  |
| `mode` | string | 否 |  |
| `phase` | string | 否 |  |
| `tool` | object|null | 否 |  |
| `meta` | object|null | 否 | prepSteps 等扩展 |

## Mobile AgentService 映射

| service type | AgentRunEvent.type |
|--------------|-------------------|
| `task.started` | `run_start` |
| `task.queued` | `run_start` |
| `task.progress` | `trace` |
| `task.completed` | `done` |
| `task.failed` | `error` |
| `task.stopped` | `stopped` |
| `task.stopping` | `stopped` |

## PC → Mobile `task.progress` 字段

| 字段 | 路径 |
|------|------|
| `trace` | event.trace → task.progress.trace |
| `streamContent` | live.streamContent / runEvent.streamContent → task.progress.streamContent |
| `runEvent` | runEvent 附在 progress payload（bridge 可选转发） |
| `sessionId` | sessionId |
| `requestId` | requestId（手机任务关联） |

## 数据流

```
Rust/Main loop → dispatchAgentRunEvent (Renderer)
  → pushAgentServiceProgress → AgentService.progressTask
  → mobile bridge WebSocket → mobile app task.progress
```


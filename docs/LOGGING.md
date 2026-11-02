# 结构化日志约定（dieyunagent）

> Agent 调试时按前缀过滤日志。新增日志请使用 `[dieyun:<域>]` 前缀。

## 前缀表

| 前缀 | 域 | 典型文件 | 查什么 |
|------|-----|----------|--------|
| `[dieyun:agent]` | Agent 循环、护栏、compaction | `src/agent/`、`crates/dieyun-core/src/agent/` | 工具轮次、trace、压缩 |
| `[dieyun:mobile]` | 手机桥、AgentService | `src/mobile/bridge.js`、`src/agent/service.js` | task.progress、WebSocket |
| `[dieyun:gateway]` | 本地 Gateway RPC | `src/gateway/` | 工具执行、fs/host、RPC 错误 |
| `[dieyun:mcp]` | MCP 运行时与凭据库 | `src/mcp/` | 子进程启动、凭据解不开（safeStorage 密钥不一致） |
| `[dieyun:core]` | Rust sidecar bridge | `src/core-bridge.js`、core stdout | index/memory/Rust RPC |
| `[dieyun:renderer]` | 渲染进程（可选） | `src/renderer/` | UI 事件、气泡、思考区 |
| `[dieyun:test]` | 测试 runner | `scripts/test-*.cjs` | smoke 进度 |
| `[dieyun:rpc]` | RPC catalog 生成 | `scripts/generate-rpc-catalog.cjs` | 契约校验 |
| `[dieyun:events]` | AgentRunEvent 文档生成 | `scripts/generate-agent-run-events-doc.cjs` | 事件契约 |
| `[dieyun:bootstrap]` | 环境恢复 | `scripts/agent-bootstrap.ps1`、`bootstrap.cjs` | 依赖 / sidecar |

## 按问题查日志

| 现象 | 先看 | 再看 |
|------|------|------|
| 聊天气泡不更新 | Renderer DevTools console | Main `[dieyun:agent]` |
| 手机无流式回复 | `[dieyun:mobile]` task.progress | Renderer `pushAgentServiceProgress` |
| 工具执行失败 | `[dieyun:gateway]` RPC 错误 | 对应 tool handler |
| 索引 / 记忆异常 | `[dieyun:core]` | `memory.*` / `codebase.*` RPC |
| 某个 RPC 慢 / 超时（`RPC_TIMEOUT`、`CORE_RPC_TIMEOUT`） | Main `[dieyun:core] RPC_SLOW <method> <ms>`（端到端） | core stderr `[rpc-slow] <method> <ms>`（core 内部）；**只有前者 ⇒ 卡在传输 / 守护进程 / 宿主进程，两者都有 ⇒ 卡在 core**。两个阈值同值 2000ms（`src/core-rpc-timeouts.js:SLOW_RPC_LOG_MS` 与 `rpc::SLOW_RPC_LOG_MS`，跨语言无法共享常量） |
| 压缩失败 / 跳过 | `[dieyun:agent]` compaction | Rust `compaction.*` |
| 远程 SSH/WSL | `[remote-agent]`（已有） | `session-remote-transport` 测试 |
| 窗口冻结 / 卡顿 / 渲染进程崩溃重载 | Main `[dieyun:renderer] freeze`（`snapshot` → `unresponsive` → `render-process-gone`，看 `silentMs` 与 `metrics`） | Renderer DevTools Performance 面板 |
| 某段文字出自 `content` 还是 `reasoning_content` | `DIEYUN_LLM_RAW_LOG` 抓包文件 | `TraceRound`（只有合成结果，区分不了） |

## LLM 原始响应体抓包（临时排障）

`TraceRound` 一轮留 `thought` / `fullThought` / `contentSource` / `visibleContent` / `tools`。
`contentSource` 已能区分「本轮正文来自哪个通道」（`answer` / `reasoning` / `absent` / `synthetic`），
但它记的是**账本结论**（入口盖章 + Rust 分流之后），不是上游原始键 ——
要看「这段文字在响应体里落在哪个键下」，仍然要抓包，
`main.log` 也不含响应体。此时打开抓包，拿上游原始报文当唯一真相：

```bash
DIEYUN_LLM_RAW_LOG=/tmp/llm-raw.log npm run dev:fast
```

跑一轮要查的对话，然后在抓包文件里搜那段文字：它落在 `"content"` 还是
`"reasoning_content"` 键下，归属就钉死了。

- 每条记录带 `tag`（`runId` / `round` / `model`），响应体能对回某一轮；
- **不记请求头、不记请求体**：API Key 与图片 base64 都不会进这个文件，URL 去掉 query；
- 单条与文件都有上限，走统一落盘闸门；不设变量即零开销、零落盘。

## 约定

1. **前缀固定**：`console.log('[dieyun:gateway]', ...)`，域名小写、单数。
2. **不记录密钥**：API Key、token、Cookie 值勿写入 log。
3. **错误带 code**：`console.warn('[dieyun:agent]', e.code || 'ERR', e.message)`。
4. **Electron 开发**：`npm run dev:fast -- --enable-logging` 或 `npm run dev` 已带 `--enable-logging`。

## 相关契约文档

- [agent-run-events.md](./agent-run-events.md) — PC/Mobile 事件字段
- [rpc-catalog.md](./rpc-catalog.md) — RPC 方法清单

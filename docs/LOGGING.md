# 结构化日志约定（dieyunagent）

> Agent 调试时按前缀过滤日志。新增日志请使用 `[dieyun:<域>]` 前缀。

## 前缀表

| 前缀 | 域 | 典型文件 | 查什么 |
|------|-----|----------|--------|
| `[dieyun:agent]` | Agent 循环、护栏、compaction | `src/agent/`、`crates/dieyun-core/src/agent/` | 工具轮次、trace、压缩 |
| `[dieyun:mobile]` | 手机桥、AgentService | `src/mobile/bridge.js`、`src/agent/service.js` | task.progress、WebSocket |
| `[dieyun:gateway]` | 本地 Gateway RPC | `src/gateway/` | 工具执行、fs/host、RPC 错误 |
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
| 压缩失败 / 跳过 | `[dieyun:agent]` compaction | Rust `compaction.*` |
| 远程 SSH/WSL | `[remote-agent]`（已有） | `session-remote-transport` 测试 |

## 约定

1. **前缀固定**：`console.log('[dieyun:gateway]', ...)`，域名小写、单数。
2. **不记录密钥**：API Key、token、Cookie 值勿写入 log。
3. **错误带 code**：`console.warn('[dieyun:agent]', e.code || 'ERR', e.message)`。
4. **Electron 开发**：`npm run dev:fast -- --enable-logging` 或 `npm run dev` 已带 `--enable-logging`。

## 相关契约文档

- [agent-run-events.md](./agent-run-events.md) — PC/Mobile 事件字段
- [rpc-catalog.md](./rpc-catalog.md) — RPC 方法清单

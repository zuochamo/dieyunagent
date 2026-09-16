# Agent 开发速查（dieyunagent）

> 给 AI Agent 的一页纸。完整架构见 [ARCHITECTURE.md](./ARCHITECTURE.md)，仓库规则见根目录 [AGENTS.md](../AGENTS.md)。

**第一原则：禁用意图关键词硬编码** — 勿用固定中英文词表 / 寒暄正则路由注入与维护；用 `@Codebase`、路径、编辑器选区、召回命中、或 `agent-limits`。对用户查询做动态分词打分（FTS/向量）除外。

## 1. 进程与职责

| 层 | 目录 | Agent 应做什么 |
|----|------|----------------|
| Renderer | `src/renderer/` | DOM、聊天气泡、IPC 调用、**不**放 Agent 循环 / 工头协议 |
| Main | `src/main-entry.js`、`src/main/`、`src/agent/`、`src/ssh/` | 对话 LLM HTTP、工具委托、启动编排；窗口托盘 / 工位监控 / 活动统计在 `src/main/` |
| Gateway | `src/gateway/` | RPC 注册、鉴权、工具执行入口 |
| Rust | `crates/dieyun-core/` | 循环账本 `agent.loop`、planner、memory、index、compaction（不是对话 LLM） |

**循环哲学**：tool_calls = 继续；无工具的文字 = 本轮结束。允许总步数、完全相同工具+参数止损、声称已改却无写入。禁止 `agent_status`、假用户续跑（`SEGMENT_CONTINUE` 段满预算闸除外）、按只读/同文件读取/只计划逼写入。有模型正文就交付。空回复才 synthesis，且在 Node `rust-loop-runner`（Renderer 只展示）。完成验收只提示、不自动续跑、不挡交付。落库不以「已完成。」当弱回复替换。

**事件流**：Rust/Main 产生 progress → Renderer `dispatchAgentRunEvent` → UI；手机经 `AgentService` → `mobile/bridge.js` WebSocket。

## 2. 高频改动路径

Renderer 模块表：[`src/renderer/README.md`](../src/renderer/README.md)。

### 聊天 / 思考 UI（PC）

- `renderer-chat-render.js` — 气泡、live run、**推送到手机**（`pushAgentServiceProgress`）
- `renderer-thinking-trace.js` — 思考区 `<details>`、流式 patch
- `renderer-agent-loop.js` — 发送消息、启动 loop、完成回调

### Agent 执行

- `crates/dieyun-core/src/agent/loop_run.rs` — Rust 状态机
- `src/agent/agent-system-prompt.js` — 给模型看的准则/工作区/权限/SQL 文案（`assembleSystemPrompt`）
- `src/agent/system-prompt-prep.js` — Main 召回开文件 / codebase / AGENTS.md overview / 图谱（结构信号）/ 记忆 / Playbook / 技能索引 / MCP；Wiki 不自动注入
- `src/agent/rust-loop-runner.js` — Node ↔ Rust bridge（LLM / compact / sidecar cancel 分缝）
- `src/agent/tool-catalog.js` — 工具 schema 唯一目录（Renderer / plan-tools 共用）；MCP `mcp_*` 带精简 inputSchema，勿再广告空 `{}`
- `src/agent/session-context.js` — 会话账本投影；近 N 条原文 + 更早折叠条，再加字符硬顶；循环里 last-user 之后的 tool/assistant 也截断
- `src/agent/tool-result-cap.js` — 工具结果写入 loop 前截断（`toolResultMaxJson`）
- `src/agent/delegate-tool-gateway.js` — Agent `fs_read_file` 省略 maxBytes 时用 `fsReadDefaultMaxBytes`
- `src/agent/tool-bridge-main.js` — Main 执行；Renderer 仅 UI 工具（clarify / propose）
- `src/gateway/fs-edit-file.js` — 本地 Gateway 与 remote host 共用 `fs.edit_file`

### 手机端

- `src/mobile/public/app.js` — WebView UI、WebSocket、`task.progress`
- `src/agent/service.js` — 任务队列、trace、语音转写
- `src/mobile/bridge.js` — HTTP/WS 服务

### 记忆 / 会话

- `crates/dieyun-core/src/memory/` — SQLite 消息、trace
- `src/gateway/rpc.js` — 共享闭包、`createRpcHandlers` 组装
- `src/gateway/handlers/` — RPC 方法（含 `memory.js`、`fs.js`、`graph.js` 等）

### 护栏

- `src/agent/agent-limits.js` — **数字上限唯一配置源**
- `src/agent/guardrails-shared.js` — 工具拦截常量/逻辑（Main + Renderer 共用）。无只读探索/同文件重读硬拦。
- `src/agent/tool-guardrails.js` — Main 薄封装
- `src/renderer/agent-guardrails.js` — Renderer 薄封装 + 完成验收提示（不自动续跑）
- `src/renderer/renderer-agent-reviewer.js` — 可选 LLM Reviewer（默认关；独立模型 + 文件 diff）

## 3. 开发命令

```bash
npm ci && npm run bootstrap && npm run pack:dieyun-core
npm run check:contracts        # package.json / CODEMAP 路径是否还指向真实文件
npm run lint:agent             # src/agent + scripts/test-*.cjs
npm run dev:fast               # Agent 日常（跳过 remote-gateway pack）
npm run dev                    # 完整启动（含 remote-gateway pack）
npm test                       # 先跑 check:contracts，再按 git diff 跑 smoke
npm run test:agent             # agent smoke（无 sidecar 时跳过 core 项）
npm run test:agent-full        # 含 rust-*-smoke
npm run test:renderer          # renderer 静态检查
npm run cargo:test             # Rust 单元测试
npm run check:renderer         # Renderer 静态检查
```

GitHub Actions：`.github/workflows/ci.yml`（contracts + lint + smoke + cargo test/clippy）。

清理后恢复：`scripts/agent-bootstrap.ps1`（或 `workspace-cleanup.ps1 -Deep` 后执行）。

## 4. 测试映射

| 改了什么 | 跑什么 |
|----------|--------|
| `crates/.../agent/` | `npm run test:rust-agent-loop-smoke` |
| `crates/.../planner/` | `npm run test:rust-planner-smoke` |
| `src/agent/`（limits/护栏） | `npm run test:agent-limits` + `npm run test:task-tier` |
| `src/agent/write-smell-hints.js` | `npm run test:write-smell-hints` |
| `src/agent/agent-system-prompt.js` | `npm run test:agent-system-prompt` |
| `src/agent/system-prompt-prep.js` | `npm run test:system-prompt-prep` |
| 纯逻辑单测（Vitest） | `npm run test:unit` |
| 关键 JS 类型（`tsconfig.check.json` 白名单 + `checkJs`） | `npm run check:js` |
| `src/main/mcp-plans-boot.js` | `npm run test:unit` |
| `src/gateway/` | `npm run test:local-gateway-smoke` |
| `src/renderer/` | `npm run test:renderer` |
| `src/mobile/` | `npm run test:mobile` |
| 全仓库大改 | `npm run test:agent` + `npm run cargo:test` |

契约文档（改 RPC / 事件后重新生成）：

```bash
npm run generate:rpc-catalog
npm run generate:agent-events
npm run verify:rpc-catalog      # CI / 提交前
npm run verify:agent-events
```

`test:rust-*-smoke` 在无 LLM 配置时会 **SKIP**，不视为失败。

## 5. 关键 RPC（Gateway）

常见方法（完整列表待 codegen）：`memory.messages_recent`、`memory.message_append`、`agent.trace_get`、`agent.state_get`、`fs.read_file`、`fs.list_dir`、`codebase.search`、`graph.repo_map`、`graph.lsp_enrich`。

### 索引 / 图谱（Rust）

- `crates/dieyun-core/src/treesitter/` — AST 切块与符号抽取
- `crates/dieyun-core/src/index/` — codebase 索引与混合检索（FTS + 向量 ANN 采样）
- `crates/dieyun-core/src/graph/` — 依赖图、repo_map、符号向量
- `crates/dieyun-core/src/embedding/ann.rs` — 大库向量扫描阈值与采样模量

Rust 侧注册：`crates/dieyun-core/src/rpc/mod.rs`。Node 侧：`src/gateway/handlers/`。

## 6. AgentRunEvent 类型

定义：`src/agent/run-events.js`

`run_start` · `prep` · `trace` · `stream` · `tool` · `round_limit` · `done` · `error` · `stopped`

手机 `task.progress` 携带 `trace` + `streamContent`（PC 回复流式文字）。

## 7. 环境变量

| 变量 | 说明 |
|------|------|
| `DIEYUN_CORE_BIN` | 开发用 debug 二进制 |
| `DIEYUN_CORE=0` | 关 Rust |
| `DIEYUN_MOBILE_PORT` | 手机桥端口（默认 17331） |

## 8. 不要动

- `dist/`、`release/` 安装包与备份（除非发版任务）
- `skills/bundled/` 大批量 vendor（用现有 scripts 更新）
- 用户 `deploy.local.json`、API Key
- 为单一场景在 Renderer 堆业务逻辑（见 DEVELOPMENT 设计原则）

## 9. 相关文档

- [ARCHITECTURE.md](./ARCHITECTURE.md) — 打印级手册
- [DEVELOPMENT.md](./DEVELOPMENT.md) — 发版、dieyun-core 打包
- [AGENT-STRATEGY.md](./AGENT-STRATEGY.md) — 护栏与 taskTier
- [CODEMAP.json](./CODEMAP.json) — 模块机器索引
- [LOGGING.md](./LOGGING.md) — 日志前缀约定
- [rpc-catalog.md](./rpc-catalog.md) — RPC 清单
- [agent-run-events.md](./agent-run-events.md) — 事件契约
- [examples/agent-sandbox/README.md](../examples/agent-sandbox/README.md) — Agent 沙盒

## 仓库噪音 / 清理

- Agent 索引忽略：根目录 [`.cursorignore`](../.cursorignore)
- 深度清理：`powershell -File scripts/workspace-cleanup.ps1 -Deep -WhatIf`
- 恢复环境：`powershell -File scripts/agent-bootstrap.ps1`

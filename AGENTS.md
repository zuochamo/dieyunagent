# dieyunagent — AI Agent 开发指南

> 本文件面向 **在本仓库内改代码的 AI Agent**（Cursor / 叠云 Agent 等）。用户项目指南见 `assets/AGENTS.md.template`。

## 原则

1. **最小 diff**：只改与任务直接相关的文件；不顺手重构、不扩 scope。
2. **禁用意图关键词硬编码**：勿用固定中英文词表 / 寒暄正则决定「是否注入上下文、切 AGENTS 章节、是否触发索引」等路由；优先结构信号（`@Codebase`、消息内路径、编辑器选区）、召回是否命中、或 `agent-limits` 配置。对用户查询做动态分词打分（FTS/向量）不属于本禁令。
3. **分层边界**：Renderer 做 UI；**对话 LLM 与工具执行在 Main/Node**；Rust `dieyun-core` 做循环账本、planner、memory、index、compaction。工具走 Gateway RPC。勿在 Rust 循环里堆「工头」协议，勿在 Renderer 写长期 Agent 状态机。
4. **循环哲学（对齐 PI harness，不整仓替换）**：tool_calls = 继续；无工具的文字 = 本轮结束。允许总步数、完全相同工具+参数止损、声称已改却无写入。禁止 `agent_status` 状态机、假用户续跑、按只读步数/同文件读取/只计划逼写入。有模型正文就交付；空回复才 synthesis，且在 Node `rust-loop-runner`，Renderer 只展示。完成验收只提示、不自动续跑、不挡交付。
5. **护栏单一来源**：数字上限只改 `src/agent/agent-limits.js`；工具拦截常量/逻辑在 `src/agent/guardrails-shared.js`（Main `tool-guardrails.js` + Renderer `agent-guardrails.js` 共用）。
6. **不提交**：密钥、`deploy.local.json`、`.env`、`dist/`、`release/`（除文档说明的备份策略）。
7. **验证**：改完跑 `npm test`（按 diff 选测）或 `npm run test:agent`（全量 smoke）。

详细速查见 [`docs/AGENT-DEV.md`](docs/AGENT-DEV.md)。模块机器可读索引见 [`docs/CODEMAP.json`](docs/CODEMAP.json)。

---

## 改什么去哪

| 需求 | 首选路径 | 避免 |
|------|----------|------|
| 模型可见规则 / system prompt | `src/agent/agent-system-prompt.js`、`system-prompt-prep.js` | 勿在 Renderer 再写一份准则或 codebase/AGENTS/图谱/记忆/技能/MCP 召回；Renderer 上报快照 + 编辑器块 |
| 聊天气泡 / 思考区 / Composer | `src/renderer/renderer-chat-render.js`、`renderer-thinking-trace.js`、`renderer-agent-loop.js` | 在 Renderer 写长期 Agent 状态机 |
| Agent 工具轮次 / trace | `crates/dieyun-core/src/agent/`、`src/agent/rust-loop-runner.js` | 仅改 UI 期望 Rust 行为 |
| 工具 schema / 执行 | `src/agent/tool-catalog.js`（schema）、`src/agent/tool-bridge-main.js`（执行）、`src/gateway/fs-edit-file.js`（edit 实现） | 在 Renderer 再写一份 schema 或 `gatewayCall` 执行 host 工具 |
| Planner / 多 Agent | `crates/dieyun-core/src/planner/`、`src/agent/rust-planner-runner.js` | `planner-orchestrator.js`（已删除） |
| Gateway / 记忆 / fs RPC | `src/gateway/`、`crates/dieyun-core/src/rpc/`、`crates/dieyun-core/src/memory/` | preload 绕过 Gateway |
| 手机端 UI / 桥接 | `src/mobile/public/`、`src/mobile/bridge.js`、`src/agent/service.js` | 复制整套 PC Renderer |
| 模型 / 语音设置 | `src/model-settings.js`、`src/renderer/renderer-model-settings.js` | 散落硬编码 API URL |
| 打包 / 安装包 | `scripts/`、`build-installer.bat` | 任务无关不改 `electron-builder` 配置 |
| 护栏 / 探索限制 | `src/agent/agent-limits.js`（数字）、`guardrails-shared.js`（逻辑） | 多处重复常量 |

---

## 架构三层（必记）

```
Renderer (src/renderer/)     UI、事件展示、gatewayCall 客户端（不执行 host 工具）
Main (src/main-entry.js)     IPC、LLM HTTP、工具委托、Worktree、MobileBridge
Gateway (src/gateway/)       WebSocket RPC、工具、权限白名单
dieyun-core (Rust)           循环账本 agent.loop、planner、memory、index、compaction
```

事件协议：`src/agent/run-events.js`（`AgentRunEvent`：trace / stream / tool / done …）。

---

## 常用命令

```bash
# 依赖（清理仓库后）
npm ci
npm run bootstrap
npm run pack:dieyun-core          # 或 cargo build -p dieyun-core + DIEYUN_CORE_BIN=...

# 日常开发（完整 bootstrap + remote-gateway pack）
npm run dev

# Agent 日常迭代（跳过 remote-gateway pack 检查，本地 UI/Agent 改动更快）
npm run dev:fast
# 首次 SSH/WSL 远程或 pack 过期时仍用 npm run dev

# 改 Rust
npm run cargo:test
npm run test:rust-agent-loop-smoke

# 改 Agent / Gateway / Mobile 后验证
npm test                          # 按 git diff 跑相关 smoke
npm run test:agent                # agent smoke（无 sidecar 时跳过 core 相关项）
npm run test:agent-full           # 含 rust-*-smoke（需 pack:dieyun-core）

# 仅 Renderer
npm run check:renderer
npm run build:renderer:dev

# 工作区备份 / 深度清理
powershell -File scripts/workspace-backup.ps1
powershell -File scripts/workspace-cleanup.ps1 -Deep -WhatIf

# 清理后恢复（Agent 开发）
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/agent-bootstrap.ps1
powershell -File scripts/agent-bootstrap.ps1 -BuildCore   # 含 dieyun-core 构建
```

---

## 改动 → 测试（摘要）

| 改动路径前缀 | 建议测试 |
|--------------|----------|
| `crates/dieyun-core/src/agent/` | `npm run test:rust-agent-loop-smoke` |
| `crates/dieyun-core/src/planner/` | `npm run test:rust-planner-smoke` |
| `src/agent/` | `npm run test:agent-limits` + agent smoke |
| 纯函数 / MCP-计划装配 | `npm run test:unit`；`npm run check:js`（scoped checkJs） |
| `src/gateway/`、`src/gateway/` | `npm run test:local-gateway-smoke` |
| `src/lsp/`（LSP 定位 / 诊断） | `npm run test:lsp`（可选 `DIEYUN_LSP_E2E=1` 跑真 LSP 端到端） |
| `src/renderer/` | `npm run check:renderer` 或 `npm run test:renderer` |
| `src/mobile/` | `npm run test:mobile` |
| `src/agent/service.js` + mobile bridge | `npm run test:mobile` + `test:local-gateway-smoke` |

完整映射见 `scripts/test-agent-smoke.cjs` 与 `docs/CODEMAP.json`。

---

## 环境变量（调试）

| 变量 | 作用 |
|------|------|
| `DIEYUN_CORE=0` | 禁用 Rust sidecar（Agent / Plan / 记忆均不可用） |
| `DIEYUN_CORE_BIN` | 指定 dieyun-core 可执行文件（开发用 `target/debug/dieyun-core.exe`） |

---

## 数据路径（勿当源码改）

| 路径 | 内容 |
|------|------|
| `%APPDATA%/pixel-office-agent/` | Electron userData、Gateway DB |
| `~/.dieyun/` | 默认 workspace、skills、dieyun.md |
| `.dieyun/`（仓库内） | 本地索引 / worktree 缓存 |
| `dist/`、`target/`、`node_modules/` | 构建产物，不进版本库 |

---

## 文档索引

| 文档 | 用途 |
|------|------|
| [`docs/AGENT-DEV.md`](docs/AGENT-DEV.md) | Agent 一页速查 |
| [`src/renderer/README.md`](src/renderer/README.md) | Renderer 模块索引 |
| [`examples/agent-sandbox/README.md`](examples/agent-sandbox/README.md) | Agent 自举沙盒 |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | 完整架构手册 |
| [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md) | 发版与 dieyun-core 测试 |
| [`docs/LOGGING.md`](docs/LOGGING.md) | 结构化日志前缀 |
| [`docs/rpc-catalog.md`](docs/rpc-catalog.md) | RPC 方法清单（自动生成） |
| [`docs/agent-run-events.md`](docs/agent-run-events.md) | AgentRunEvent 契约 |
| [`docs/DESIGN.md`](docs/DESIGN.md) | 设计原理 |

---

## 提交前检查清单

- [ ] `npm test` 或对应模块 smoke 通过
- [ ] 未改动无关文件（git diff 可控）
- [ ] 新增 RPC / 事件字段已更新文档或 CODEMAP
- [ ] 未引入密钥或本地 deploy 配置

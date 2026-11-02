# Agent 开发速查（dieyunagent）

> 给 AI Agent 的一页纸。完整架构见 [ARCHITECTURE.md](./ARCHITECTURE.md)，仓库规则见根目录 [AGENTS.md](../AGENTS.md)。

**首条禁令：禁用意图关键词硬编码** — 勿用固定中英文词表 / 寒暄正则路由注入与维护；用 `@Codebase`、路径、编辑器选区、召回命中、或 `agent-limits`。对用户查询做动态分词打分（FTS/向量）除外。

## 1. 进程与职责

| 层 | 目录 | Agent 应做什么 |
|----|------|----------------|
| Renderer | `src/renderer/` | DOM、聊天气泡、IPC 调用、**不**放 Agent 循环 / 工头协议 |
| Main | `src/main-entry.js`、`src/main/`、`src/agent/`、`src/ssh/` | 对话 LLM HTTP、工具委托、启动编排；窗口托盘 / 工位监控 / 活动统计在 `src/main/` |
| Gateway | `src/gateway/` | RPC 注册、鉴权、工具执行入口 |
| Rust | `crates/dieyun-core/` | 循环账本 `agent.loop`、planner、memory、index、compaction（不是对话 LLM） |

**循环哲学**：tool_calls = 继续；无工具的文字 = 本轮结束。允许总步数、完全相同工具+参数止损、声称已改却无写入。禁止 `agent_status`、假用户续跑（`SEGMENT_CONTINUE` 段满预算闸除外）、按只读/同文件读取/只计划逼写入。

**交付四态**（`agent-round-text.resolveTurnDelivery`，单一来源）：有正文 → 交付正文；预算截断且只有思考 → 交付**带标签的思考引用**（仅展示，落库换占位）；正常收尾无正文 → 一次无工具 synthesis（Node `rust-loop-runner`，Renderer 只展示）；都没有 → 占位。思考**永不**当正文，只进 `messages.reasoning`（与 content 分列）。完成验收只提示、不自动续跑、不挡交付。落库不以「已完成。」当弱回复替换。

**事件流**：Rust/Main 产生 progress → Renderer `dispatchAgentRunEvent` → UI；手机经 `AgentService` → `mobile/bridge.js` WebSocket。

## 2. 高频改动路径

Renderer 模块表：[`src/renderer/README.md`](../src/renderer/README.md)。

### 聊天 / 思考 UI（PC）

- `renderer-chat-render.js` — 气泡、live run、**推送到手机**（`pushAgentServiceProgress`）
- `renderer-thinking-trace.js` — 思考区 `<details>`、流式 patch
- `renderer-agent-loop.js` — 发送消息、启动 loop、完成回调

### Agent 执行

- `crates/dieyun-core/src/agent/loop_run.rs` — Rust 状态机
- `src/agent/agent-system-prompt.js` — 给模型看的准则/工作区/权限文案（`assembleSystemPrompt`）
- `src/agent/system-prompt-prep.js` — Main 召回开文件 / codebase / AGENTS.md overview / 图谱（结构信号）/ 记忆 / 技能索引 / MCP
- `src/agent/rust-loop-runner.js` — Node ↔ Rust bridge（LLM / compact / sidecar cancel 分缝）
- `src/agent/tool-catalog.js` — 工具 schema 唯一目录（Renderer / plan-tools 共用）；MCP `mcp_*` 带精简 inputSchema，勿再广告空 `{}`
- `src/agent/session-context.js` — 会话账本投影；近 N 条原文 + 更早折叠条，再加字符硬顶；循环里 last-user 之后的 tool/assistant 也截断
- `src/agent/tool-result-cap.js` — 工具结果写入 loop 前截断（`toolResultMaxJson`）
- `src/agent/delegate-tool-gateway.js` — Agent `fs_read_file` 省略 maxBytes 时用 `fsReadDefaultMaxBytes`
- `src/agent/tool-bridge-main.js` — Main 执行；`RENDERER_ONLY_TOOLS`（`agent_clarify` / `session_new`）只反委托给 Renderer，Main 不执行
- `src/agent/browser-vision.js` — 运行期视觉缓冲（按 runId / 来源限流，注入后清空，不进账本）
- `src/agent/vision-image.js` — 工具图片的**可寻址凭证**：内容寻址落盘副本（`tool-output/vision/`，按 `visionImageKeepFiles` 裁剪）+ 视觉 token 口径（`visionTokensForSize`，DeepSeek 公开格网算法，≤1024）+ 成功/失败两句模型可见文案（唯一来源）。图入不进视觉通道都要在工具结果里留 `visionImage` / `visionTokens` / 只读副本路径
- `src/renderer/renderer-agent-tools.js` — Renderer 侧的 UI 工具执行体；`session_new` 复用 `createNewSession`（与「新对话」按钮同一条流程），勿另写一遍建会话 + 绑工作空间
- `src/gateway/fs-edit-file.js` — 本地 Gateway 与 remote host 共用 `fs.edit_file`
- `src/ssh/actions.js` — SSH 动作唯一实现（连/断/端口转发/切远端工作空间）：IPC `ssh:*` 与 Agent 工具 `ssh` 共用，勿在 handler 里重写
- `src/worktree/actions.js` — worktree 动作唯一实现（仓库上下文解析 + list/create/remove/cleanup/prune/preview/apply）：IPC `worktree:*` 与 Agent 工具 `worktree` 共用
- MCP 凭据：`mcp_manage` 的 `request_credential` 由 Main 推 `mcp:credential-request`（preload `onMcpCredentialRequest`）→ Renderer 打开同一个 MCP 配置弹窗由人填写；**模型永远拿不到明文**

### 模型选型（Auto / 手动）

- `src/renderer/renderer-composer.js` — `resolveComposerModelForSend` 是唯一选型点。Auto 只按**结构性事实**选：本条消息有无图片 → 设置里声明为 `vision` 的模型前置；其余一律「候选顺序即偏好」（供应商启用顺序 → 自定义模型顺序）。**不要**再用模型名正则猜「谁更强 / 该给复杂请求换 pro」：模型一换代就静默失效，而设置里没有可维护的对应字段。
- `src/agent/model-runtime-by-tier.js` — `resolveModelFacts(settings, route)` 是「route → 模型事实」唯一解析点（模型名 / 供应商 / 模态 / 自带窗口 / 上下文档位，`auto-*` 前缀同一口径）；`resolveContextTierIdFromSettings` / `resolveModelContextWindowFromSettings` 只是它的薄封装。勿再在 Main / Renderer 各自 `indexOf(':')` 拼 supplierId。
- `src/renderer/renderer-model-runtime.js` — Auto 下 `resolveActiveModelRoute` 取**上一次发送真正选中的 route**（由 `noteResolvedModelRoute` 回填），Renderer 预算与 Main 压缩才同口径。
- `scripts/report-auto-model-misfit.cjs` — 只读报表：从既有 `request_snapshots` 量「Auto 选中的模型有没有顶穿预算」。要加「route → 近期失败」这类试错账本之前先跑它，别凭感觉加机制。

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
- 测试同守此规：`scripts/test-*.cjs` 里的上限与探针必须**从 `agent-limits` 或本轮传入的 cap 推导**，勿抄裸字面量（抄了就会在改护栏数字时假红／假绿）。同理，断言优先写「精确契约」（集合相等、cap+1 探针），少用「条目数变多变少」这类代理指标。
- `src/agent/guardrails-shared.js` — 工具拦截常量/逻辑（Main + Renderer 共用）。无只读探索/同文件重读硬拦。
- `src/agent/tool-guardrails.js` — Main 薄封装
- `src/agent/completion-readiness.js` — **完成验收的唯一来源**（Main）：证据 = 循环账本 trace + Gateway `workspace.diagnostics` + 浏览器运行时事实；只提示、不自动续跑、不挡交付
- `src/renderer/agent-guardrails.js` — 只渲染验收提示（`applyReadinessNote`，不判定）
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

# 手动排障脚本（不接入 npm scripts / CI / smoke 链路）
node scripts/dev/check-memory-health.cjs     # 记忆 SQLite + 向量模型体检
node scripts/dev/probe-context-window.cjs    # 探测某模型的上下文窗口
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
- `crates/dieyun-core/src/index/` — codebase 索引与混合检索（FTS `trigram` + 向量池精确余弦 + 2 字短术语子串扫描，按名次 RRF 融合）
- `crates/dieyun-core/src/index/vector_pool.rs` — 常驻内存向量池（唯一的向量检索通道）
- `crates/dieyun-core/src/index/schema.rs` — 表 / `chunks_fts`（external content + 触发器）/ `SCHEMA_VERSION` 迁移
- `crates/dieyun-core/src/graph/` — 依赖图、repo_map

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
| `DIEYUN_LLM_RAW_LOG` | 抓 LLM 原始响应体到指定文件（排障用，默认关；见 [LOGGING.md](./LOGGING.md)） |

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
- [REASONING-ISOLATION-PLAN.md](./REASONING-ISOLATION-PLAN.md) — 思考通道隔离目标设计（**已实施**，提交 1-5；仅余取证重放）
- [examples/agent-sandbox/README.md](../examples/agent-sandbox/README.md) — Agent 沙盒

## 仓库噪音 / 清理

- Agent 索引忽略：根目录 [`.cursorignore`](../.cursorignore)
- 深度清理：`powershell -File scripts/workspace-cleanup.ps1 -Deep -WhatIf`
- 恢复环境：`powershell -File scripts/agent-bootstrap.ps1`

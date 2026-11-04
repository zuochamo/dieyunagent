# dieyunagent — AI Agent 开发指南

> 本文件面向 **在本仓库内改代码的 AI Agent**（Cursor / 叠云 Agent 等）。用户项目指南见 `assets/AGENTS.md.template`。

## 原则

1. **架构优先**：以「单一来源、消除重复实现、职责分层清晰」为设计目标；**不为最小 diff 而保留重复实现或错误职责**。改动仍聚焦任务本身，避免任务无关的顺手重构与无限扩 scope。
2. **减法优先（默认解法方向）**：排查与出方案时先问「能不能不做 / 能不能删 / 能不能收敛到既有单一来源」，再问「要加什么」。禁止用新增机制掩盖根因 —— **降级层、兜底层、重试层、开关、配置项、状态机**若只是「绕过」失败而非「消除」失败，即属加法反模式。任何新增的分支 / 机制 / 配置字段，方案里必须写明「为何删不掉、为何不能并入既有单一来源」；写不出来就回到减法。仅当根因位于本仓不可控的外部系统、且加法位置本身就是唯一来源时，才允许加。
3. **禁用意图关键词硬编码**：勿用固定中英文词表 / 寒暄正则决定「是否注入上下文、切 AGENTS 章节、是否触发索引」等路由；优先结构信号（`@Codebase`、消息内路径、编辑器选区）、召回是否命中、或 `agent-limits` 配置。对用户查询做动态分词打分（FTS/向量）不属于本禁令。
4. **分层边界**：Renderer 做 UI；**对话 LLM 与工具执行在 Main/Node**；Rust `dieyun-core` 做循环账本、planner、memory、index、compaction。工具走 Gateway RPC。勿在 Rust 循环里堆「工头」协议，勿在 Renderer 写长期 Agent 状态机。
5. **循环哲学（对齐 PI harness，不整仓替换）**：tool_calls = 继续；无工具的文字 = 本轮结束。允许总步数、完全相同工具+参数止损、声称已改却无写入。禁止 `agent_status` 状态机、假用户续跑、按只读步数/同文件读取/只计划逼写入。**交付四态**（`agent-round-text.resolveTurnDelivery` 单一来源）：有正文就交付；预算截断且只有思考 → 带标签思考引用（仅展示，落库换占位）；正常收尾无正文才 synthesis，且在 Node `rust-loop-runner`，Renderer 只展示。**思考永不顶正文**：只进 `messages.reasoning`（与 content 分列）。完成验收只提示、不自动续跑、不挡交付。
6. **护栏单一来源**：数字上限只改 `src/agent/agent-limits.js`；工具拦截常量/逻辑在 `src/agent/guardrails-shared.js`；**工具调用的关卡顺序只在 `src/agent/tool-gate.js` 声明**（加检查只改清单，不改流程）。
7. **不提交**：密钥、`deploy.local.json`、`.env`、`dist/`、`release/`（除文档说明的备份策略）。
8. **验证**：改完跑 `npm test`（按 diff 选测）或 `npm run test:agent`（全量 smoke）。

详细速查见 [`docs/AGENT-DEV.md`](docs/AGENT-DEV.md)。模块机器可读索引见 [`docs/CODEMAP.json`](docs/CODEMAP.json)。

---

## 改什么去哪

| 需求 | 首选路径 | 避免 |
|------|----------|------|
| 模型可见规则 / system prompt | `src/agent/agent-system-prompt.js`、`system-prompt-prep.js` | 勿在 Renderer 再写一份准则或 codebase/AGENTS/图谱/记忆/技能/MCP 召回；Renderer 上报快照 + 编辑器块 |
| 聊天气泡 / 思考区 / Composer | `src/renderer/renderer-chat-render.js`、`renderer-thinking-trace.js`、`renderer-agent-loop.js` | 在 Renderer 写长期 Agent 状态机 |
| Agent 工具轮次 / trace | `crates/dieyun-core/src/agent/`、`src/agent/rust-loop-runner.js` | 仅改 UI 期望 Rust 行为 |
| 交付文本 / 思考通道 | `src/agent/agent-round-text.js`（四态交付 + 真思考提取）、`src/agent/llm-channel.js`（通道身份）、`messages.reasoning`（账本分列） | 在 Rust / Node / Renderer 再写一份「思考顶正文」或长度阈值兜底 |
| 工具 schema / 执行 | `src/agent/tool-catalog.js`（schema）、`src/agent/tool-bridge-main.js`（执行）、`src/gateway/fs-edit-file.js`（edit 实现） | 在 Renderer 再写一份 schema 或 `gatewayCall` 执行 host 工具 |
| Planner / 多 Agent | `crates/dieyun-core/src/planner/`、`src/agent/rust-planner-runner.js` | `planner-orchestrator.js`（已删除） |
| Gateway / 记忆 / fs RPC | `src/gateway/`、`crates/dieyun-core/src/rpc/`、`crates/dieyun-core/src/memory/` | preload 绕过 Gateway |
| 联网搜索 / 网页抓取 | `src/gateway/web/`（`engines/` 一个引擎一个 parser；出网走 `transport.js`） | 另写一份 SERP 解析、fetch 或 SSRF 校验 |
| 手机端 UI / 桥接 | `src/mobile/public/`、`src/mobile/bridge.js`、`src/agent/service.js` | 复制整套 PC Renderer |
| 模型 / 语音设置 | `src/model-settings.js`、`src/renderer/renderer-model-settings.js` | 散落硬编码 API URL |
| 快捷键（键位 / 新增全局键） | `src/renderer/renderer-shortcuts.js`（键位表 + `matchesShortcut` + 「基础设置 → 快捷键」页；覆盖项存 `settings.shortcuts`） | 在调用点写 `ev.key === 'm'`、`ev.altKey && k === 's'`（用户改键后静默失效） |
| 朗读（语音合成 / TTS） | `src/gateway/speech-synthesize.js`（合成请求体 / 超时 / 长度上限的唯一来源）、`src/gateway/tts-cache.js`（按 text+voice+format+model+baseUrl 的字节上限 LRU）、`src/renderer/renderer-tts.js`（分句切块 + 边合成边播 + 停止/切歌语义）、`src/model-settings.js:resolveTtsApiConfig`（无 Renderer 的调用方与手机端选模型）、`src/mobile/public/app.js`（手机端朗读） | 在 Renderer / 手机端各拼一份合成请求体或选模型逻辑；拿 `speech`（转写）槽位跑合成 —— 两种能力常不同时存在 |
| LLM 端点拼接 / 请求头 | `src/agent/llm-request.js`（端点与请求头唯一来源） | 在调用点内联 `Content-Type + Authorization` |
| 打包 / 安装包 | `scripts/`、`build-installer.bat` | 任务无关不改 `electron-builder` 配置 |
| 离线预装的 MCP 产物 | `scripts/pack-mcp-bundled.cjs`（版本唯一来源 `src/mcp/registry.js`） | 再写一份版本/校验和或另造预装机制 |
| 护栏 / 探索限制 | `src/agent/agent-limits.js`（数字）、`guardrails-shared.js`（逻辑） | 多处重复常量 |
| 内网 agent 互通（跨机消息 / 会话即通道 / 建议式租约） | `src/peer/`（语义全在 `coordinator.js`，线协议 `wire.js`）、`src/main/ipc/peer.js`、`src/renderer/renderer-peer.js`（面板）、`src/renderer/renderer-connect.js`（「连接」外壳：手机连接 / Agent 互通 两个标签页）、`src/net/lan.js` | 另写一套发现/配对码；在 Renderer 判「谁可以自动跑一轮」；在 Rust 循环里堆跨机协议 |
| 完成验收（单轮「做完了没」） | `src/agent/completion-readiness.js`（Main：证据 + 判定唯一来源，只提示不续跑）、`src/renderer/agent-guardrails.js`（只渲染 note） | 在 Renderer 判定、从 `summary` 文本抠 exit code、把诊断塞成 trace 轮次 |
| 目标型长任务（无人值守跑到达成 / 收尾核对） | 语义单一来源 `src/plans/goal-run.js`（事实、`judgeGoalFinish` 核对、`decideContinuation` 续跑、`renderEvidenceBlock` / `renderSessionGoalBlock` 事实块）；计划目标存 `src/plans/store.js`（`goal.checks` + `evidence/claims/outcome`、`pruneFinishedGoals` 有界保留）、`src/main/mcp-plans-boot.js`（每轮开一次）；**会话目标**存 `src/goals/session-goal.js`（`session_goals` KV、每轮 `advanceAttempt`、一轮结束 `judgeAfterTurn`）+ `agent:rust-loop-run` 返回 `goal.cont`、`renderer-agent-send.js#startGoalTurn`（无用户文本的下一轮）、气泡上方**目标条** + 侧栏「目标」页（`renderer-goal-panel.js`：同一份视图、同一次取数）；工具 `goal_start` / `goal_update` / `goal_check` / `goal_finish`（`tool-catalog.js` + `tool-bridge-main.js`）、每轮注入在 `system-prompt-prep.js` | 在调度器/Renderer 里写「每轮必跑一条验收命令」「按档位/退避表推进」「连续 N 轮才许阻塞」；让代码输出「已完成/未完成」结论；用关键词从提示词里抠检查命令；在 Renderer 判续跑或存预算（它只读 `goal.cont` 一个布尔）；伪造用户消息驱动续跑 |
| 沙箱档位 / 越界审批 | `src/gateway/sandbox-policy.js`（三档判定，唯一来源）、`sandbox-approvals.js`（ask-once）、`permissions-store.js`（档位持久化） | 在 handler 里自己拼白名单；另写一份高危命令词表（`exec-policy.js` 已复用同一份） |
| 工具调用关卡（校验 / 止损 / 遥测 / 落盘顺序） | `src/agent/tool-gate.js`（流程 + 冻结关卡清单，加检查只改清单） | 在 `ToolHarnessSession` / `executeAgentTool` 里手写顺序，或另起一个"前置钩子层" |
| 会话工作空间绑定（外部频道指定 / 跟随桌面） | `src/agent/service.js`（外部提交入口：`task.submit.workspacePath`，未声明时按提交时刻的桌面工作空间钉住）、`renderer-composer.js`（`resolveSessionWorkspacePathSync` + `rememberActiveViewSessionWorkspace`：视图路径与会话 id 成对写）、`src/agent/session-workspace-bind.js`（会话行 + 进程内上下文两处都写的唯一实现）、工具 `session_set_workspace`（桌面：`renderer-workspace-ssh.js#applySessionWorkspaceFromTool`；频道：`channels/workspace-switch.js`） | 用 `sid === currentSessionId` 判定「视图路径就是该会话的绑定」（会话切换瞬间会把桌面目录写成外部会话的工作空间，见 `issue/2026-10-30-agent-channel-and-workspace-binding.md`） |
| 外部频道（企业微信等）接入 / 频道设置页 | `src/channels/`（`store` 配置与凭据、`wecom-client` 长连接与帧、`runtime` 调度与节流、`agent-turn` 在 Main 跑一轮、`workspace-switch` 微信里换项目、`boot` 装配）、`src/main/ipc/channels.js`、`src/renderer/renderer-channels.js`（设置 →「频道」） | 再写一份 Agent 装配（系统提示/工具/压缩/交付闸门都有单一来源）；让频道任务经 Renderer 或手机桥跑（会抢桌面焦点） |
| 共享记忆（跨机记忆条目 / 设置 → 扩展 → 共享记忆） | `src/memory-shared/`（`settings` 配置与密文口令、`pg` 连接/建表/探活、`service` 召回 SQL 与提炼锁）、`src/main/ipc/shared-memory.js`、`src/renderer/renderer-shared-memory.js`；提炼 prompt 仍在 `agent/knowledge-maintainer.js`，注入块仍在 `system-prompt-prep.js` | 上传对话消息；再写一份 Master/Slave 或角色表（提炼靠 advisory lock）；另写一份召回打分或 `secret/private` 过滤（复用 `isShareableKind`）；把共享库做成链路依赖（连不上即关，别加重试/队列） |
| 无界面运行（终端 REPL / 一次性 run / 浏览器 Web / cron 型服务） | `src/headless/`（`main` 入口生命周期 + `boot` 装配 + `local-executor` 本地执行器 + `secret-storage` safeStorage 替身）、`src/agent/main-turn-runner.js`（Main 侧跑一轮的唯一实现，频道/计划/headless 共用）、`scripts/pack-headless.cjs`（Linux 包 tgz + deb：内置 node + core + 纯 JS 依赖闭包 + 冷启动闸门）、`scripts/lib/tar-writer.cjs`（权限位可控的 tar/gzip）、`scripts/lib/deb-archive.cjs`（deb 读写唯一来源：ar/control/Packages 条目）、`scripts/publish-headless-apt.cjs`（deb → 内网 apt 源：Packages/Packages.gz/Release + 索引自检）、`src/browser/electron-host.js`（浏览器栈延迟取 electron）、`deploy/systemd/dieyun-headless.service` | 另写一份 Agent 装配或工具桥；让 headless 经 Renderer 跑；为无窗口加「能力开关表」；把桌面/原生依赖（`koffi` / `playwright-core`）塞进 Linux 包；在可达模块顶部 `require('electron')`（headless 会整进程起不来）；自研「查版本→下载→替换运行中二进制」的更新器（更新交给 apt / `unattended-upgrades`，本仓只产源） |
| 请求快照 / 「模型看到了什么」 | `src/agent/request-snapshot.js`（唯一装配与写入点）、`crates/dieyun-core/src/memory/snapshot.rs`（表与保留裁剪） | 在 Renderer/Main 各拼一份；另写事件溯源或格式迁移链 |
| 远端 Agent 传输 / 进程 / 多工作区 | `src/ssh/remote-gateway-manager.js`（懒拉起 daemon、`openAgentChannel` 走 SSH `direct-streamlocal`、探活与回收）、`src/remote/minimal-gateway-host.js`（socket 监听 + 单例 + `hello{workspace}` 按连接路由）、`remote-agent-client.js`（`openChannel` 通道客户端） | 重新引入远端 TCP 端口 / pid 文件 / 本地隧道 / token；按 socket 键缓存客户端而不带 workspace |
| 远端文件读写（哪条传输） | `src/gateway/rpc.js:getRemoteFs()`（**唯一出口**：Agent 可用走 `gateway/remote-agent-fs.js` 的 RPC；没 Agent 才走 `gateway/remote-fs.js` 的 SFTP；两者同接口，`transport` 标识决定谁补 `index.notify_change`） | 在 handler 里自己判「用 SFTP 还是 RPC」；写两套适配器形状；RPC 失败悄悄退 SSH exec |
| 「远端 Agent 是否可用」/ 客户端与缓存键 | `remote-agent-client.js:isRemoteAgentUsable`、`workspace-cache-keys.js:remoteAgentInfoKey` | 再写 `info.url && info.token`（P2 之后没有这两个字段）；按 socketPath 单键缓存（两个工作区会共用一份连接/索引缓存） |
| 远端 core 的 glibc 下限 | `scripts/pack-dieyun-core-linux-lib.cjs`（`CORE_GLIBC_TARGET` + `assertCoreGlibcTarget`，打包期闸门）、`pack-dieyun-core-linux-remote.cjs`（zig 目标） | 在远端运行时再「量宿主 glibc 猜兼容性」（已删；会误诊成「服务器太老」，真实原因是产物版本） |
| SSH 连接参数 / 认证方式 / 别名 / 跳板 | `src/ssh/connect-payload.js`（「连接意图 → 有效参数」唯一入口）、`ssh-config.js`（`~/.ssh/config` 解析）、`auth-methods.js`（agent / keyboard-interactive / 有序认证）、`proxy-jump.js`（`forwardOut` 串接） | 在 IPC 或自动重连里各拼一份 payload；自己手搓跳板串接 |

---

## 架构三层（必记）

```
Renderer (src/renderer/)     UI、事件展示、gatewayCall 客户端（不执行 host 工具）
Main (src/main-entry.js)     IPC、LLM HTTP、工具委托、Worktree、MobileBridge（Electron 入口 src/main.js）
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
npm run pack:mcp-bundled          # 离线预装 MCP 产物（断网构建：产物放 build/.cache/ 后重跑）

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

# 无界面（服务器）包：core → tgz + deb → 结构自检 → 内网 apt 源（build:all 末尾已附）
npm run build:headless
npm run publish:headless-apt      # 只重跑发布：dist/*.deb → release/headless-apt/pool + 索引自检

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
| `src/gateway/`、`crates/dieyun-core/src/rpc/` | `npm run test:local-gateway-smoke` + `verify:rpc-catalog` |
| `src/lsp/`（LSP 定位 / 诊断） | `npm run test:lsp`（可选 `DIEYUN_LSP_E2E=1` 跑真 LSP 端到端） |
| `src/renderer/` | `npm run check:renderer` 或 `npm run test:renderer` |
| `src/mobile/` | `npm run test:mobile` |
| `src/agent/service.js` + mobile bridge | `npm run test:mobile` + `npm run test:agent-run-events` |

完整映射见 `scripts/test-agent-smoke.cjs` 与 `docs/CODEMAP.json`。

---

## 环境变量（调试）

| 变量 | 作用 |
|------|------|
| `DIEYUN_CORE=0` | 禁用 Rust sidecar（Agent / Plan / 记忆均不可用） |
| `DIEYUN_CORE_BIN` | 指定 dieyun-core 可执行文件（开发用 `target/debug/dieyun-core.exe`） |
| `DIEYUN_USER_DATA` | 覆盖 userData 目录（headless / 多实例共用同一份解析规则，见 `src/app-paths.js`） |
| `DIEYUN_SECRET_KEY_FILE` | headless 的凭据加密密钥（32 字节或 64 位 hex，0600）；缺省时 MCP/SSH/频道凭据不可写，**不回退明文** |

---

## 数据路径（勿当源码改）

| 路径 | 内容 |
|------|------|
| `%APPDATA%/dieyunagent/` | Electron userData、Gateway DB（目录名唯一来源 `src/app-paths.js`；旧 `pixel-office-agent` 首次启动自动迁移） |
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
| [`docs/MEMORY.md`](docs/MEMORY.md) | 记忆系统分层与注入规则 |
| [`docs/MEMORY-VS-DSH.md`](docs/MEMORY-VS-DSH.md) | 与 DSH 记忆设计对照：抄了什么、明确不抄什么及反证条件（**改记忆系统前先读**，别把否过的方案搬回来） |
| [`docs/SQLITE-ACCESS.md`](docs/SQLITE-ACCESS.md) | SQLite 访问模型：写入连接 / 读池 / 长任务三条通道与在途预算（**改 core 库访问前先读**） |
| [`docs/VECTOR-SEARCH.md`](docs/VECTOR-SEARCH.md) | 向量检索：int8 量化全量扫描的误差界 / 内存上限 / **换 ANN 的触发条件**（改向量检索前先读） |
| [`docs/INDEX-VALUE-REVIEW.md`](docs/INDEX-VALUE-REVIEW.md) | 代码索引 / 结构索引：实测成本与使用率 / 能力定级 / **删 trigram、向量 opt-in、调用图按需** 的整改清单（改 `index/` 或 `graph/` 前先读） |
| [`docs/AGENT-STRATEGY.md`](docs/AGENT-STRATEGY.md) | Agent 策略分层 / taskTier 护栏 |
| [`docs/LSP-DIAGNOSTICS.md`](docs/LSP-DIAGNOSTICS.md) | LSP 定位 / 诊断链路 |
| [`docs/HARNESS-INVENTORY.md`](docs/HARNESS-INVENTORY.md) | harness 能力清单 |
| [`docs/REASONING-ISOLATION-PLAN.md`](docs/REASONING-ISOLATION-PLAN.md) | 思考通道隔离（**已实施**，提交 1-5；仅余取证重放） |
| [`docs/REQUEST-SNAPSHOT.md`](docs/REQUEST-SNAPSHOT.md) | 请求快照：模型看到了什么 / 为什么折叠 / 预留策略（**已实施**） |
| [`docs/TOOL-GATE.md`](docs/TOOL-GATE.md) | 工具关卡：一次工具调用的唯一流程与关卡清单（**已实施**） |
| [`docs/SANDBOX.md`](docs/SANDBOX.md) | 沙箱：三档能力边界 / ask-once 审批 / 未做的内核强制（**策略层已实施**） |
| [`docs/PEER-MESH-PLAN.md`](docs/PEER-MESH-PLAN.md) | 内网 agent 互通：按机器确认的信任清单 / UDP 发现 / 会话即通道 / 跳数与小时预算 / 建议式租约（**已实施 P0 + P1 授权**） |
| [`docs/MULTI-AGENT-WORKTREE-ISOLATION-PLAN.md`](docs/MULTI-AGENT-WORKTREE-ISOLATION-PLAN.md) | 多 agent 并行时 workspace 资源隔离（**SSH 会话已实施**：每会话一个远端 worktree；含 flock 设计） |
| [`docs/SSH-MODULE-REVIEW.md`](docs/SSH-MODULE-REVIEW.md) | SSH 模块全面审查：架构 / 整洁 / 完成度 + 与 Rust 核心的三个脆弱点（**改 src/ssh 或 src/remote 前先读**） |
| [`docs/CHANNEL-WECOM.md`](docs/CHANNEL-WECOM.md) | 内置频道（企业微信智能机器人）：设置页 / 长连接协议帧 / 在 Main 后台跑一轮 / 附件与主动推送（**已实施**） |
| [`docs/SHARED-MEMORY.md`](docs/SHARED-MEMORY.md) | 共享记忆（跨机 PostgreSQL，设置 → 扩展）：只同步记忆条目 / 一条召回 SQL（向量 + trigram 兜底）/ advisory lock 提炼 / 连不上即关闭（**已实施**） |
| [`docs/HEADLESS-MODE-PLAN.md`](docs/HEADLESS-MODE-PLAN.md) | 无界面运行（终端 REPL / 一次性 run / 浏览器 Web）：headless 装配、`main-turn-runner` 单一来源、safeStorage 替身、退出码与单实例边界、tgz + deb 分发与冷启动闸门（**P0–P5 已实施**） |
| [`docs/HEADLESS.md`](docs/HEADLESS.md) | 无界面运行**安装与运维手册**：deb / tarball 安装、env 文件 / 密钥 / model-settings、参数与退出码、systemd、安全、排障表、升级回滚 |

---

## 提交前检查清单

- [ ] `npm test` 或对应模块 smoke 通过
- [ ] 未改动无关文件（git diff 可控）
- [ ] 新增 RPC / 事件字段已更新文档或 CODEMAP
- [ ] 未引入密钥或本地 deploy 配置

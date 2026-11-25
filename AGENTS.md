# dieyunagent — AI Agent 开发指南

> 本文件面向 **在本仓库内改代码的 AI Agent**（Cursor / 叠云 Agent 等）。用户项目指南见 `assets/AGENTS.md.template`。

## 原则

1. **架构优先**：以「单一来源、消除重复实现、职责分层清晰」为设计目标；**不为最小 diff 而保留重复实现或错误职责**。改动仍聚焦任务本身，避免任务无关的顺手重构与无限扩 scope。
2. **减法优先（默认解法方向）**：排查与出方案时先问「能不能不做 / 能不能删 / 能不能收敛到既有单一来源」，再问「要加什么」。禁止用新增机制掩盖根因 —— **降级层、兜底层、重试层、开关、配置项、状态机**若只是「绕过」失败而非「消除」失败，即属加法反模式。任何新增的分支 / 机制 / 配置字段，方案里必须写明「为何删不掉、为何不能并入既有单一来源」；写不出来就回到减法。仅当根因位于本仓不可控的外部系统、且加法位置本身就是唯一来源时，才允许加。
3. **禁用意图关键词硬编码**：勿用固定中英文词表 / 寒暄正则决定「是否注入上下文、切 AGENTS 章节、是否触发索引」等路由；优先结构信号（`@Codebase`、消息内路径、编辑器选区）、召回是否命中、或 `agent-limits` 配置。对用户查询做动态分词打分（FTS/向量）不属于本禁令。
4. **分层边界**：Renderer 做 UI；**工具执行在 Main/Node**；Rust `dieyun-core` 做循环账本、**LLM 调用与流式（`agent/llm.rs`）**、planner、memory、index、compaction（折叠；transcript 唯一写者）。工具走 Gateway RPC。勿在 Rust 循环里堆「工头」协议，勿在 Renderer 写长期 Agent 状态机。
5. **循环哲学（对齐 PI harness，不整仓替换）**：tool_calls = 继续；无工具的文字 = 本轮结束。允许总步数、完全相同工具+参数止损、声称已改却无写入。禁止 `agent_status` 状态机、假用户续跑、按只读步数/同文件读取/只计划逼写入。**交付四态**（`agent-round-text.resolveTurnDelivery` 单一来源）：有正文就交付；预算截断且只有思考 → 带标签思考引用（仅展示，落库换占位）；正常收尾无正文才 synthesis，且在 Node `rust-loop-runner`，Renderer 只展示。**思考永不顶正文**：只进 `messages.reasoning`（与 content 分列）。完成验收只提示、不自动续跑、不挡交付。
6. **护栏单一来源**：数字上限只改 `src/agent/agent-limits.js`；**Node 与 Rust 两侧都要用的数字/词表**（token 折算、预算地板、触发比夹取、读上限、慢请求阈值、上下文溢出词表）只改 `src/agent/agent-shared.json`（Node 经 `src/agent/shared-constants.js`、Rust 经 `crates/dieyun-base/src/shared.rs` 读同一份；`npm run check:shared-constants` 会验「每个键两侧都有人读」）；工具拦截常量/逻辑在 `src/agent/guardrails-shared.js`；**工具调用的关卡顺序只在 `src/agent/tool-gate.js` 声明**（加检查只改清单，不改流程）。
7. **不提交**：密钥、`deploy.local.json`、`.env`、`dist/`、`release/`（除文档说明的备份策略）。
8. **验证**：改完跑 `npm test`（按 diff 选测）或 `npm run test:agent`（全量 smoke）。

详细速查见 [`docs/AGENT-DEV.md`](docs/AGENT-DEV.md)。模块机器可读索引见 [`docs/CODEMAP.json`](docs/CODEMAP.json)。

---

## 改什么去哪

| 需求 | 首选路径 | 避免 |
|------|----------|------|
| 模型可见规则 / system prompt | `src/agent/agent-system-prompt.js`、`system-prompt-prep.js` | 勿在 Renderer 再写一份准则或 codebase/AGENTS/图谱/记忆/技能/MCP 召回；Renderer 上报快照 + 编辑器块 |
| 聊天气泡 / 思考区 / Composer | `src/renderer/renderer-chat-render.js`、`renderer-thinking-trace.js`、`renderer-agent-loop.js` | 在 Renderer 写长期 Agent 状态机 |
| Agent 工具轮次 / trace | `crates/dieyun-runtime/src/agent/`、`src/agent/rust-loop-runner.js` | 仅改 UI 期望 Rust 行为 |
| 上下文压缩 / 折叠（旧「LLM 摘要压缩」已删除） | `crates/dieyun-base/src/compaction/fold.rs`（语义唯一来源：就地折叠 + 保 tool_call 骨架 + 幂等档位）、`src/agent/compaction-main.js`（输入预算 / 触发比 / 遥测）、`src/agent/compaction-loop.js`（归档）、`src/agent/compaction-telemetry.js`；触发口径优先用服务端 `usage.prompt_tokens`。见 [`docs/CONTEXT-FOLD.md`](docs/CONTEXT-FOLD.md) | 在压缩里再调一次 LLM 做摘要；折 user 消息文字或 `tool_calls` 参数；在 Node 侧重写「该不该压」的条数与字符比预判；把未触发的调用也写进遥测 |
| 交付文本 / 思考通道 | `src/agent/agent-round-text.js`（四态交付 + 真思考提取）、`src/agent/llm-channel.js`（通道身份）、`messages.reasoning`（账本分列） | 在 Rust / Node / Renderer 再写一份「思考顶正文」或长度阈值兜底 |
| 工具 schema / 执行 | `src/agent/tool-catalog.js`（schema）、`src/agent/tool-bridge-main.js`（执行）、`src/gateway/fs-edit-file.js`（edit 实现） | 在 Renderer 再写一份 schema 或 `gatewayCall` 执行 host 工具；**手写 required/type/enum/range 或「某 action 下才必填」** —— 机械校验由 schema 生成（`npm run generate:tool-validators`），条件/跨字段规则写进 catalog 的 `allOf`/`if/then`/`anyOf`，两侧求值都走 `src/agent/schema-rules.js`；改完跑 `npm run test:tool-args`（62 条双跑夹具） |
| Planner / 多 Agent | `crates/dieyun-runtime/src/planner/`、`src/agent/rust-planner-runner.js`（worker 批 / 并发闸）、开关 `agent-limits.plannerMultiAgentEnabled`（设置 →「子 Agent」）、worker 写作用域 `src/agent/delegate-tool-gateway.js#createWorkerWriteScope`（worktree 优先 / 越界拒绝 / 读 copy-on-read）、**远端（SSH）per-role 副本** `src/ssh/remote-run-worktree.js`（`<repo>/.dieyun/worktrees/<runId>/<role>`，收尾 commit + merge 回会话副本；本地/远端分派在 `src/agent/planner-main-bridge.js`） | `planner-orchestrator.js`（已删除）；在 worker 里靠提示词保证隔离；另写一份「哪条路径归哪份副本」的映射 |
| Plan worktree / agent 分支回收 | `src/git/worktree-service.js#sweepRunArtifacts`（**唯一语义**：只收「已并入 HEAD 的 `dieyun/agent-*` 分支」与「没有活 worktree 的 run 空壳」；触发点 = Main 每轮开跑前 `planner-main-bridge.runStart`、桌面启动的 `enforceWorktreeCleanupPolicy`、`scripts/workspace-cleanup.ps1 -IncludeLocalData`） | 直接 `Remove-Item .dieyun/worktrees`（目录没了、登记与分支全成悬挂）；给残留回收挂「条数/容量」阈值（没人配置 = 永不回收，正是 171 条分支的来源）；在 Renderer 判「该不该回收」 |
| Gateway / 记忆 / fs RPC | `src/gateway/`、`crates/dieyun-runtime/src/rpc/`、`crates/dieyun-memory/src/memory/` | preload 绕过 Gateway |
| 本地 Gateway 传输 / 端点（Renderer 怎么到 Gateway） | `src/gateway/local-endpoint.js`（**端点唯一来源**：POSIX `<userData>/gateway.sock` / Windows 命名管道；TCP+token 只在显式 `DIECLOUD_GATEWAY_PORT` 时）、`src/gateway/server.js`（监听 + `invokeRpc` + `onEvent`）、`src/main/ipc/gateway-shell.js`（`gateway:rpc` / `gateway:event`）、`src/headless/desktop-ui.js`（网页替身：同源 `/gateway` 翻成同一份 `invokeRpc`） | 在 Renderer 里再写一个 WebSocket 客户端或 `new WebSocket(...)`（Chromium 连不了 socket/管道，桌面走 IPC；网页走同源 `/gateway`）；另写一份端口 / token 文件逻辑；为「gateway 连不上」加重连状态机（IPC 没有连接可重连，失败就是这次调用失败） |
| 浏览器面板可见性 / 原生视图边界（BrowserView 盖住别的页签） | `src/renderer/renderer-browser.js#syncBrowserBounds`（**唯一写者**：页签是否可见 + `#browser-viewport` 矩形一起传）、`src/browser/controller.js#setPanelState`（只认 `open`+`bounds`，没 bounds 不开） | 在 Main / 工具层自己 `setPanelState({open:true})` —— 只有上一次的旧矩形，原生视图会贴到当前可见的任何页签上；要画面可见用 `requestAutoOpenPanel()` 请 Renderer 开页签 |
| 联网搜索 / 网页抓取 | `src/gateway/web/`（`engines/` 一个引擎一个 parser；出网走 `transport.js`） | 另写一份 SERP 解析、fetch 或 SSRF 校验 |
| 向量后端（本地推理优先 / 远端可选） | 判定唯一入口 `crates/dieyun-base/src/embedding/mod.rs::EmbeddingConfig::plan`（`auto`/`local`/`remote`）；本地推理 `embedding/local.rs`（`ort` + `load-dynamic`，模型与 onnxruntime 都按需下载：`DIEYUN_MODELS_DIR` / `DIEYUN_ORT_LIB`）；装配唯一入口 `src/agent/embedding-config.js`（远端端点 + 本地模型目录合成一份 payload，三处 `configure` 共用）；查询向量一律走 RPC `embedding.query`（`src/codebase/embedding-client.js` 只剩薄封装）。见 [`docs/LOCAL-EMBEDDING.md`](docs/LOCAL-EMBEDDING.md) | 在调用点各写一份「有没有向量通道 / 慢不慢」的判断（旧的 `interactiveEmbedBudgetMs` + `EMBEDDING_TOO_SLOW` + 并发闸门已整体删除）；让 Node 自己打 embedding 端点（文档向量与查询向量会分属两个后端，相似度静默变差）；把模型或 dylib 塞进安装包 |
| 手机端 UI / 桥接 | `src/mobile/public/`、`src/mobile/bridge.js`、`src/agent/service.js` | 复制整套 PC Renderer |
| 模型 / 语音设置 | `src/model-settings.js`、`src/renderer/renderer-model-settings.js`；**向量模型条目的归一化只此一份** `src/agent/model-settings-embedding.js`（Main 直接 require、Renderer 经 agent-bundle 的 `window.normalizeEmbeddingModels` / `applyActiveEmbedding` 调；改它要跑 `npx vitest run test/unit/model-settings-normalize-parity.test.cjs`） | 散落硬编码 API URL；在 Main / Renderer 各写一份条目归一化（会静默丢 `headers` / `authMode` / `userAgent` → 向量端点 401）；在编辑器里「重建六个键」式保存 |
| 快捷键（键位 / 新增全局键） | `src/renderer/renderer-shortcuts.js`（键位表 + `matchesShortcut` + 「基础设置 → 快捷键」页；覆盖项存 `settings.shortcuts`） | 在调用点写 `ev.key === 'm'`、`ev.altKey && k === 's'`（用户改键后静默失效） |
| 朗读（语音合成 / TTS） | `src/gateway/speech-synthesize.js`（合成请求体 / 超时 / 长度上限的唯一来源）、`src/gateway/tts-cache.js`（按 text+voice+format+model+baseUrl 的字节上限 LRU）、`src/renderer/renderer-tts.js`（分句切块 + 边合成边播 + 停止/切歌语义 + 逐句高亮）、`src/renderer/renderer-chat-scroll.js#followChatReadingRange`（念到哪一句的**视野跟随**：起点必须在视野里 / 用户一滚就整段让位 / 只往下带不回拽；用户滚动序号 `chatUserScrollSeq` 的唯一来源是 `markChatUserScrollIntent`）、`src/model-settings.js:resolveTtsApiConfig`（无 Renderer 的调用方与手机端选模型）、`src/mobile/public/app.js`（手机端朗读） | 在 Renderer / 手机端各拼一份合成请求体或选模型逻辑；拿 `speech`（转写）槽位跑合成 —— 两种能力常不同时存在；**在朗读里自己写 `scrollTop` / `scrollTo`** —— 每念一句就会把用户滚走的视口拽回去一次（`renderer-tts.js` 只交出 Range） |
| LLM 调用（请求 / 流式 / 事件） | `crates/dieyun-runtime/src/agent/llm.rs`（请求 + SSE 解析，唯一实现）；主循环由 core 自己驱动（`agent.run.*`），辅助任务统一走 RPC `llm.complete`（宿主唯一入口 `src/agent/llm-complete.js`）；事件出口 `crates/dieyun-runtime/src/rpc/events.rs` + 宿主订阅 `src/core-bridge.js:onCoreEvent`；端点路径与鉴权仍只由 `src/agent/llm-request.js` 给（Rust 不推导）。见 [`docs/LLM-RPC.md`](docs/LLM-RPC.md) | 在 Node / Renderer 再写一份 HTTP 客户端或 SSE 解析（`llm-proxy.js` / `llm-stream-utils.js` 已删）；把 core 的 stderr 当事件源；在这一层加重试/退避（重连只在宿主：主循环首轮 + planner 的 `llm.complete`，走 `src/llm-reconnect-retry.js`）；把传输层失败压成一句 `error sending request for url (...)`（必须给码 `LLM_TRANSPORT`，见 docs/LLM-RPC.md §3.1）；让 `agent.delta` 承担「本轮结束」语义 |
| LLM 端点拼接 / 请求头 | `src/agent/llm-request.js`（端点与请求头唯一来源） | 在调用点内联 `Content-Type + Authorization` |
| 打包 / 安装包 | `scripts/`、`build-installer.bat` | 任务无关不改 `electron-builder` 配置 |
| 离线预装的 MCP 产物 | `scripts/pack-mcp-bundled.cjs`（版本唯一来源 `src/mcp/registry.js`） | 再写一份版本/校验和或另造预装机制 |
| 护栏 / 探索限制 | `src/agent/agent-limits.js`（数字）、`guardrails-shared.js`（逻辑） | 多处重复常量 |
| 默认工作区回收（`~/.dieyun/workspace` 别再无限涨） | `src/default-workspace-gc.js`（语义唯一来源：到期回收 + 容量上限按最旧优先；两条硬边界 = 工程标记与宽限期永不自动删）、数字 `agent-limits.js` 的 `defaultWorkspace*`，装配在 `src/main-entry.js` 与 `src/headless/boot.js` 各一行 | 在别处再写一套保留期 / 保护名单；对**用户自选工作空间**做自动删除；用文件名关键词猜「是不是垃圾」 |
| 内网 agent 互通（跨机消息 / 会话即通道 / 建议式租约） | `src/peer/`（语义全在 `coordinator.js`，线协议 `wire.js`，**装配唯一来源 `boot.js`**：网络门 + 回合回传线，桌面与 headless 共用；**动作唯一来源 `actions.js`**：桌面 IPC 与 headless 网页 `/ws` 共用，加动作只改「`PEER_ACTION_NAMES` + `PEER_BRIDGE_METHODS`（方法名与参数整形）」两处表，`src/preload.js` 与 `src/headless/desktop-ui.js` 都从 `buildPeerBridge` / `PEER_BRIDGE_METHODS` 派生，不再手抄；`test/unit/peer-bridge-contract.test.cjs` 校验两张表一一对应）、`src/main/ipc/peer.js`、`src/renderer/renderer-peer.js`（面板）、`src/renderer/renderer-connect.js`（「连接」外壳：手机连接 / Agent 互通 两个标签页）、`src/headless/desktop-ui.js`（网页替身：`peer*` → `peer.<name>`）、`src/net/lan.js`；工具注入两处：`src/renderer/renderer-tool-defs.js`（聊天）与 `src/agent/main-agent-tools.js`（计划 / 频道 / headless）；授权开关 `peer/settings.json`（`enabled` / `autoTurn` / `autoTrust`，`autoTrust` 桌面默认 false、无人值守入口首启落 true） | 另写一套发现/配对码；在 Renderer 判「谁可以自动跑一轮」；在 Rust 循环里堆跨机协议；把互通装配在入口里各写一份（漏了回传线 = 对端等到超时，漏了网络门 = 模型那边永远 PEER_UNAVAILABLE）；把动作语义抄进 IPC 或网页转发层（面板只有一套，两侧漂移就是「桌面能点、网页空白」） |
| 摄像头（拍一张现实画面看一眼） | 手机：`src/mobile/camera-source.js`（`camera_look` 走 MobileBridge）；本机 UVC（OBSBOT Tiny 2 等）：`src/agent/desktop-camera-source.js`（`desktop_camera_look`，ffmpeg 抓一帧，`DIEYUN_FFMPEG` 或 PATH）；视觉通道 `src/agent/browser-vision.js`、不落盘文案 `vision-image.js#visionCameraText`、额度 `agent-limits.js`、开关 `permissions.camera` / `permissions.desktopCamera`（均默认关） | 在工具层内联 ffmpeg 参数；另写一份「现实画面不落盘」文案；把本机摄像头塞进 `camera_look` 当参数（两次失败路径完全不同：手机没连 / 没 ffmpeg） |
| 摄像头云台（把镜头转过去 / 读当前朝向） | 语义唯一来源 `src/agent/desktop-camera-ptz.js`（只报实测 `before`/`after`/`settled`/`reached`；范围一律取设备自己的 `GetRange` / `--list-ctrls`；越界报错不夹取）；Windows 传输层 `desktop-camera-ptz-win32.js`（DirectShow `IAMCameraControl` 的 koffi/COM 唯一实现）；工具 `desktop_camera_ptz`（schema 在 `catalog/computer.js`，action → 语义映射只在 `main-tools/camera.js`）；设备挑选复用 `desktop-camera-source.js#pickDevice`；开关**共用** `permissions.desktopCamera`；数字 `agent-limits.js` 的 `desktopCameraPtz*`；见 [`docs/DESKTOP-CAMERA-PTZ.md`](docs/DESKTOP-CAMERA-PTZ.md) | 另写一份 pan/tilt 上下限常量（设备自己会给）；写成功就当「已转到位」（必须读回）；给 `desktop_camera_look` 加 `pan` 参数（两条失败路径完全不同：没 ffmpeg / 没电机）；把云台放进生命感心跳轮（`ALIVE_READ_ONLY_TOOL_NAMES` 是只读清单，动机器是写）；用 `computer` 拖 OBSBOT Center 的摇杆（窗口位置 + DPI + AI 追踪三重不稳） |
| 完成验收（单轮「做完了没」） | `src/agent/completion-readiness.js`（Main：证据 + 判定唯一来源，只提示不续跑）、`src/renderer/agent-guardrails.js`（只渲染 note） | 在 Renderer 判定、从 `summary` 文本抠 exit code、把诊断塞成 trace 轮次 |
| 目标型长任务（无人值守跑到达成 / 收尾核对） | 语义单一来源 `src/plans/goal-run.js`（事实、`judgeGoalFinish` 核对、`decideContinuation` 续跑、`renderEvidenceBlock` / `renderSessionGoalBlock` 事实块）；计划目标存 `src/plans/store.js`（`goal.checks` + `evidence/claims/outcome`、`pruneFinishedGoals` 有界保留）、`src/main/mcp-plans-boot.js`（每轮开一次）；**会话目标**存 `src/goals/session-goal.js`（`session_goals` KV、每个**自动续跑轮** `advanceAttempt`（人驱动的轮不扣预算）、一轮结束 `judgeAfterTurn`、写入口按 `goalBlobMaxChars` 裁剪）+ `agent:rust-loop-run` 返回 `goal.cont`、`renderer-agent-send.js#startGoalTurn`（无用户文本的下一轮）、侧栏「目标」页（`renderer-goal-panel.js`：唯一视图面；气泡上方那条目标条已删除）；工具 `goal_start` / `goal_update` / `goal_check` / `goal_finish`（`tool-catalog.js` + `tool-bridge-main.js`）、每轮注入在 `system-prompt-prep.js` | 在调度器/Renderer 里写「每轮必跑一条验收命令」「按档位/退避表推进」「连续 N 轮才许阻塞」；让代码输出「已完成/未完成」结论；用关键词从提示词里抠检查命令；在 Renderer 判续跑或存预算（它只读 `goal.cont` 一个布尔）；伪造用户消息驱动续跑 |
| 沙箱档位 / 越界审批 | `src/gateway/sandbox-policy.js`（三档判定，唯一来源；`remote:true` 只换 POSIX 方言 + 大小写敏感，语义不变）、`sandbox-approvals.js`（ask-once）、`permissions-store.js`（档位持久化）、远端根由 `server.js:sandboxContext({remote})` 供（工作区 + `/tmp`）、作用域 `rpc.js:remoteSandboxScope()`、传输边界 `path-policy.js:remoteAllowedRoots`（由 `ssh/remote-path.js:resolveRemotePath` 先拒，不会先问你） | 在 handler 里自己拼白名单；另写一份高危命令词表（`exec-policy.js` 已复用同一份）；用 `path.resolve` 解析远端 POSIX 路径（Windows 上得到 `E:\srv\x` 假路径）；让远端写绕过档位（"本机解析不了远端路径"不是理由，见 docs/SANDBOX.md §1.1） |
| 工具调用关卡（校验 / 止损 / 遥测 / 落盘顺序） | `src/agent/tool-gate.js`（流程 + 冻结关卡清单，加检查只改清单） | 在 `ToolHarnessSession` / `executeAgentTool` 里手写顺序，或另起一个"前置钩子层" |
| 模型对「自己」的认知与申请（能力事实块 / 自检 / 申请开能力 / 改动回执） | `src/agent/capability-index.js`（**能力表唯一来源**：能力 → 开关判定 + 人话标签 + 设置落点；`formatCapabilityBlock` 进系统提示、`enabledCapabilities` 给自检、`resolveRequestKind` 给申请）、`src/agent/catalog/self.js`（`agent_inspect` / `agent_capability` schema）、`src/agent/main-tools/self.js`（执行体）、`src/agent/change-receipt.js`（`makeReceipt` / `fingerprintText` / 落盘 `<userData>/self-changes.jsonl`）、`system-prompt-prep-main.js#getSandboxState`（档位与可写根投影，与自检共用 `projectSandboxState`） | 在 prompt / 渲染器 / 自检里各写一份「哪些能力开着」（工具名映射仍归 `renderer-tool-defs.js`）；把 `agent_inspect` 做成 `agent_status` 状态机或让它给建议；让 `agent_capability` 替用户开权限（它只能把请求送到界面）；把配置 diff 塞进 `tool-telemetry.jsonl`（口径是每次工具调用的成败） |
| 工作空间候选（「切到 XX 项目」说得清） | `src/agent/workspace-candidates.js`（**唯一实现**：收候选 / 路径归一 / 目录名匹配 / 候选文案）、`channels/workspace-switch.js`（频道侧落绑定）、`renderer-workspace-ssh.js#applySessionWorkspaceFromTool`（桌面侧，经 agent-bundle 的 `DieyunWorkspaceCandidates`） | 两处各写一份匹配规则或各写一句候选文案；靠关键词猜「用户说的是哪个项目」 |
| 会话工作空间绑定（外部频道指定 / 跟随桌面） | `src/agent/service.js`（外部提交入口：`task.submit.workspacePath`，未声明时按提交时刻的桌面工作空间钉住）、`renderer-composer.js`（`resolveSessionWorkspacePathSync` + `rememberActiveViewSessionWorkspace`：视图路径与会话 id 成对写）、`src/agent/session-workspace-bind.js`（会话行 + 进程内上下文两处都写的唯一实现）、工具 `session_set_workspace`（桌面：`renderer-workspace-ssh.js#applySessionWorkspaceFromTool`；频道：`channels/workspace-switch.js`） | 用 `sid === currentSessionId` 判定「视图路径就是该会话的绑定」（会话切换瞬间会把桌面目录写成外部会话的工作空间，见 `issue/2026-10-30-agent-channel-and-workspace-binding.md`） |
| 外部频道（企业微信等）接入 / 频道设置页 | `src/channels/`（`store` 配置与凭据、`wecom-client` 长连接与帧、`wecom-media` 多媒体 AES 解密与判型、`runtime` 调度与节流、`agent-turn` 在 Main 跑一轮、`workspace-switch` 微信里换项目、`boot` 装配）、`src/main/ipc/channels.js`、`src/renderer/renderer-channels.js`（设置 →「频道」） | 再写一份 Agent 装配（系统提示/工具/压缩/交付闸门都有单一来源）；让频道任务经 Renderer 或手机桥跑（会抢桌面焦点）；**把附件 URL 直接当文件存**（长连接回调下载到的是 AES 密文，见 `wecom-media.js`） |
| 共享记忆（跨机记忆条目 / 设置 → 扩展 → 共享记忆） | `src/memory-shared/`（`settings` 配置与密文口令、`pg` 连接/建表/探活、`service` 召回 SQL 与提炼锁）、`src/main/ipc/shared-memory.js`、`src/renderer/renderer-shared-memory.js`；提炼 prompt 仍在 `agent/knowledge-maintainer.js`，注入块仍在 `system-prompt-prep.js` | 上传对话消息；再写一份 Master/Slave 或角色表（提炼靠 advisory lock）；另写一份召回打分或 `secret/private` 过滤（复用 `isShareableKind`）；把共享库做成链路依赖（连不上即关，别加重试/队列） |
| 生命感（设置 → 拟态 → 生命：心跳 / 相位 / 张力 / 自发唤醒 / 可拒绝 / 抽屉 / 眼睛 / 嘴与耳；拟态 → 设定：一个文本框，内容随意） | `src/alive/`（`runtime` 心跳编排、`vitals` 漂移与四相位、`tension` 未闭合项与阈值漂移、`waker` 唤醒门限、`decide` 决策与体征块、`store` 状态与感官开关/设定原文、`note` 抽屉、`voice` 说/听 + **依赖自检 `describeVoiceCapability` / 主动开口许可 `voicePolicy` / 设备枚举**）、`src/main/alive-boot.js`（装配唯一来源；**目前只桌面装配，headless 未装配** —— 无人值守要装配得先定静默策略）、`src/main/ipc/alive.js`、`src/renderer/renderer-alive.js`；数字 `agent-limits.js` 的 `alive*`（含 `aliveDecisionsKeep` / `aliveIntentsKeep` / `aliveSuspiciousWakeMin` / `aliveSetupMaxChars`，`decide.js` 里不留数字）；只读白名单 + 感官表在 `guardrails-shared.js`（**这份清单同时就是该档的工具表**，`aliveWakeToolNames` 派生，别在 `main-agent-tools` 里另拼）、关卡在 `tool-gate.js`；决策/抽屉/说话工具只在心跳轮注入 | 在 Renderer 判生死/唤醒/续跑或判"感官能不能用"（`capabilities` 是唯一来源）；给 `intent` 开一个展示口；把 `λ/ε/W` 做成设置项；**把设定做成结构化人格参数 / 拆成多字段 / 加说明文案或计数器，或让它进对话系统提示、或让代码替它编设定**；给心跳轮默认写盘或执行权限（写只有一个文件：`alive_note`→`note.md`，读回是 `alive_read_note`，无路径参数）；让抽屉变成双向通道（它能知道你在读就会开始表演）；把麦克风做成"一直听着"；用关键词判断"这轮算不算没做完"（未闭合项只能由模型声明）；把 REFUSE 当"这轮不想动"（那是 DEFER，空手 REFUSE 不计拒绝）；用 `load` 拦唤醒（要拦先用 `WAKE.load` 记清楚）；把相位说成昼夜节律（只有 load + fatigue 两个输入）；**把用户对话的 token 记进它的疲劳**（只数唤醒轮）；**逐跳写 TICK 事件**（288/天会把 WAKE/DECISION 挤出事件文件）；**存"睁眼"画面副本**（现实画面不落盘）；补 pause/resume（见 `docs/ALIVE.md` 负向清单） |
| 宠物（设置 → 宠物 → 点点：128 点桌面悬浮体，身体即状态） | `src/pet/settings.js`（设置权威唯一来源：默认值/夹取/读写 `<userData>/pet/settings.json`，数字边界只在这里；**预装默认关闭**——`enabled` 只有显式 `true` 才算开，没有文件 / 缺键 / `'no'` / `0` 一律当关；**没有形态偏好设置**：它自己变，当前形态只在悬浮窗页面内）、`src/pet/drag.js`（拖动的位置算账：抓取偏移 / 指针→窗口位置 / 夹进哪台显示器，纯函数，`test/unit/pet-drag.test.cjs` 直测；`main/pet-window.js` 只调屏幕 API）、`src/renderer/pet-window/pet-shapes.js`（形态表 + 色板，UMD 纯函数，Main 校验 / 设置页色块 / 悬浮窗渲染共用；新增形态在这里加生成函数 + 声明 `SHAPE_KINDS`）、`src/renderer/pet-window/pet-cat-gait.js`（**猫的步态唯一实现**：**四拍对角步行，落足顺序 右前 → 左后 → 左前 → 右后（每条腿差 1/4 拍）**；按静止坐标分四条腿/尾巴/头，支撑相脚踩住后扫、摆动相抬脚，躯干起伏 + 背线行波 + 尾巴慢摆；同一区间里远近两条腿的位移在分界处交叉淡入淡出（连续场，描边不撕）；纯函数，离线帧与 `test/unit/pet-gait.test.cjs` 都驱动它 —— 改走路只改这里，别在 `pet.js` 里再写一份腿摆）、`src/renderer/pet-window/pet.js`（128 组变量 + 弹簧 + 手写透视投影 + morph/呼吸/涟漪/暗下去，不加 three.js；**形态自己变（闲逛日程，没有设置项）**，当前形态经 `pet:state` 回报给 Main，心跳轮 `bodyLine` 报的是**页面回报的当前形态**；渲染帧率上限 30fps + 页面不可见时暂停）、`src/main/pet-window.js`（悬浮窗生命周期唯一实现：透明置顶/拖动绝对定位/命中式点击穿透/**显示器增删与分辨率变化后夹回工作区**）、`src/main/ipc/pet.js`（只做传输）、`src/renderer/pet-window/preload.js`（悬浮窗专用小桥，**不共用主窗口 preload**）、`src/renderer/renderer-pet.js`（设置页 UI）、`src/agent/catalog/pet.js`（`pet_set` / `pet_act` 的 schema **唯一来源**，**聊天轮 + 心跳轮都要注入**）、`src/alive/pet-tools.js`（参数白名单与执行 `runPetSet` / `runPetAct`，两个轮次共用同一份） | 在 Main / 设置页另写一份色值或形态枚举（pet-shapes 是唯一来源）；绕过 settings.js 直接改 `pet/settings.json` 合并逻辑（patch 只有一个写入口）；在渲染端 new BrowserWindow 或写窗口定位（生命周期只在 Main）；让悬浮窗抢焦点（showInactive / focusable=false 是底线）；给 128 点开原始写接口前先想 token 成本（动词优先，见分期）；headless 装配它（没有 GUI）；把 pet_set / pet_act 只挂在心跳轮（聊天轮没有工具 → 模型会去改源码） |
| 无界面运行（终端 REPL / 一次性 run / 浏览器 Web / cron 型服务） | `src/headless/`（`main` 入口生命周期 + `boot` 装配 + `local-executor` 本地执行器 + `secret-storage` safeStorage 替身）、`src/agent/main-turn-runner.js`（Main 侧跑一轮的唯一实现：**频道 / headless / 生命感共用**；计划另有 `src/plans/plan-agent-runner.js`，两者共用历史装配 `session-context.loadRecentTurnMessages` / `completionHistoryHelpers`、轮次上限 `agent-limits.resolveAgentMaxRounds` 与空交付文案 `agent-round-text.emptyTurnFailureMessage`）、`scripts/pack-headless.cjs`（Linux 包 tgz + deb：内置 node + core + 纯 JS 依赖闭包 + 冷启动闸门）、`scripts/lib/tar-writer.cjs`（权限位可控的 tar/gzip）、`scripts/lib/deb-archive.cjs`（deb 读写唯一来源：ar/control/Packages 条目）、`scripts/publish-headless-apt.cjs`（deb → 内网 apt 源：Packages/Packages.gz/Release + 索引自检）、`src/browser/electron-host.js`（浏览器栈延迟取 electron）、`deploy/systemd/dieyun-headless.service` | 另写一份 Agent 装配或工具桥；让 headless 经 Renderer 跑；为无窗口加「能力开关表」；把桌面/原生依赖（`koffi` / `playwright-core`）塞进 Linux 包；在可达模块顶部 `require('electron')`（headless 会整进程起不来）；自研「查版本→下载→替换运行中二进制」的更新器（更新交给 apt / `unattended-upgrades`，本仓只产源）；在计划里再抄一份历史装配 / 轮次上限 / 空交付文案 |
| 请求快照 / 「模型看到了什么」 | `src/agent/request-snapshot.js`（唯一装配与写入点）、`crates/dieyun-memory/src/memory/snapshot.rs`（表与保留裁剪） | 在 Renderer/Main 各拼一份；另写事件溯源或格式迁移链 |
| 回合撤回（撤回本轮改动 / 单检查点恢复） | `src/git/turn-tree.js`（**回合开始树** `git stash create` + 回合开始的未跟踪清单 + 树回滚与复核，唯一来源）、`src/undo/turn-undo-service.js`（栈 / 批次 / 内容预算 / 快照语义；栈深上限取 `agent-limits.maxUndoSteps`）、`src/undo/turn-undo-store.js`（元数据 + 内容块落盘）、`src/gateway/handlers/undo.js`（RPC：git 树回滚 → 快照兜底 → 复核通过才提交撤回）、`src/renderer/renderer-chat-bubbles.js` + `renderer-thinking-trace-dom.js`（「已恢复」与「部分改动未还原」提示） | 把「fs 工具写之前读一次原文」当撤回的唯一来源 —— `host_exec`（shell）改的文件既没有「改前」，又会在之后第一次 fs 编辑时被记成**改过之后**的内容，撤回等于没撤（2026-11-25 实测：SSH 一轮 55 次 host_exec，界面说「已恢复 7 个文件」，设计原封不动）；把「写成功几个文件」当撤回成功（必须复核 `git diff <回合开始树>` 为空）；用 `git diff` 找未跟踪文件（看不到，只有 `ls-files --others` 可见）；在撤回的旁路读里吞错（读失败 ≠ 文件不存在，那是「撤回=删文件」） |
| 远端 Agent 传输 / 进程 / 多工作区 | `src/ssh/remote-gateway-manager.js`（懒拉起 daemon、`openAgentChannel` 走 SSH `direct-streamlocal`、探活与回收）、`src/remote/minimal-gateway-host.js`（socket 监听 + 单例 + `hello{workspace}` 按连接路由）、`remote-agent-client.js`（`openChannel` 通道客户端）、`src/remote/remote-pack-layout.js`（**打包清单 + `checkRemotePackSourceBoundary`**：清单与包内相对 require 都不得越出 `src/` —— 远端包会拍平 `src/` 前缀，出 `src/` 的路径层级必然错位，2026-11-18 就是这样让远端 daemon 加载即崩） | 重新引入远端 TCP 端口 / pid 文件 / 本地隧道 / token；按 socket 键缓存客户端而不带 workspace；把运行期要加载的资源放在 `src/` 之外（`assets/…` 之类）而让被打包模块 `require('../../…')` 去取 |
| 远端文件读写（哪条传输） | `src/gateway/rpc.js:getRemoteFs()`（**唯一出口**：Agent 可用走 `gateway/remote-agent-fs.js` 的 RPC；没 Agent 才走 `gateway/remote-fs.js` 的 SFTP；两者同接口，`transport` 标识决定谁补 `index.notify_change`） | 在 handler 里自己判「用 SFTP 还是 RPC」；写两套适配器形状；RPC 失败悄悄退 SSH exec |
| 「这条路走本机还是远端主机」（SSH 会话里也要能碰本机） | 判定唯一入口 `src/gateway/rpc.js:resolveFsTarget()`（`fs_*` / `host_print_image` 读它；返回 `remote` 还是本机 + 本机相对基准）；前缀语义唯一来源 `src/gateway/host-local.js`（`local:` 路径前缀、`host_exec local:true`、`hostproc-`/`sshproc-` 句柄前缀、忘记写前缀时的 `annotateLocalPathMiss` 提示）；模型可见的那一句在 `tool-catalog.js` 的 `LOCAL_PATH_HINT` 与 `agent-system-prompt.js` 的 SSH 块 | 在 handler 里各写一份 `startsWith('local:')` 或各判一次 `getRemoteFs()`；按路径形状猜「这大概是本机」（SSH 到 Windows 时会静默读写错机器）；给本机路径套远端白名单（或反之）；用 `cwdForCall()` 当本机相对路径基准（SSH 会话里它是远端路径） |
| 看/操作哪台机器的屏幕（`computer` 的 `target`） | `src/computer/`（本机执行体：capture + win32-input + coordinate-map）；远端：`src/remote/ssh-screen.js`（能力探测 `parseProbeOutput` + 命令拼装 `buildCaptureCommand` / `buildInputCommand` + `pngSize`/`frameSignature`），编排与档位在 `gateway/handlers/computer.js`（`target=local` 默认 / `target=remote` 走 SSH）；坐标空间唯一口径 `computer/coordinate-map.js`（缩放在本地做，注入前换算回远端原生像素） | 用「工作空间是不是 SSH」决定 `computer` 管哪台机器（两条正交的轴）；把截图塞进 `ssh.exec` 的 stdout（512KB 上限，必截断）；不去探测就假定远端有 scrot/xdotool；自己写一套坐标比例或让下游视觉管线缩图（模型看到的图和注入坐标就会错位）；在远端命令里拼未经 `shellQuoteSingle` 的路径/文本 |
| 「远端 Agent 是否可用」/ 客户端与缓存键 | `remote-agent-client.js:isRemoteAgentUsable`、`workspace-cache-keys.js:remoteAgentInfoKey` | 再写 `info.url && info.token`（P2 之后没有这两个字段）；按 socketPath 单键缓存（两个工作区会共用一份连接/索引缓存） |
| 远端 core 的 glibc 下限 | `scripts/pack-dieyun-core-linux-lib.cjs`（`CORE_GLIBC_TARGET` + `assertCoreGlibcTarget`，打包期闸门）、`pack-dieyun-core-linux-remote.cjs`（zig 目标） | 在远端运行时再「量宿主 glibc 猜兼容性」（已删；会误诊成「服务器太老」，真实原因是产物版本） |
| SSH 连接参数 / 认证方式 / 别名 / 跳板 | `src/ssh/connect-payload.js`（「连接意图 → 有效参数」唯一入口）、`ssh-config.js`（`~/.ssh/config` 解析）、`auth-methods.js`（agent / keyboard-interactive / 有序认证）、`proxy-jump.js`（`forwardOut` 串接） | 在 IPC 或自动重连里各拼一份 payload；自己手搓跳板串接 |

---

## 架构三层（必记）

```
Renderer (src/renderer/)     UI、事件展示、gatewayCall 客户端（不执行 host 工具）
Main (src/main-entry.js)     IPC、工具委托/执行、Worktree、MobileBridge（Electron 入口 src/main.js）；LLM 调用已移入 core
Gateway (src/gateway/)       工具 RPC、权限白名单（Renderer 经 Main IPC 的 gateway:rpc 调 invokeRpc；私有 socket/命名管道只给本机其它进程）

Rust workspace（依赖方向由 Cargo 强制，只能向下依赖）
  dieyun-core        bin + 路径转发 shim（main.rs；`lib.rs` 把老路径原样 pub use 出来）
  dieyun-runtime     agent（循环账本 / llm / driver）、planner、rpc（分派 + handler）、fs_ops
  dieyun-codebase    index（切块 / 检索 / 向量）、graph（调用图）、treesitter、codebase_db
  dieyun-memory      memory（会话账本 / 长记忆 / 召回 / 归档 / 项目身份 / 快照）
  dieyun-base        error / shared / obs / blocking / sqlite / db_schema / config / embedding / compaction / fts
```

> 为什么是这五层而不是照 §7 的六 crate：模块依赖里存在**强连通块** ——
> `index ↔ graph ↔ codebase_db ↔ treesitter`、`config ↔ embedding`、`agent ↔ rpc`。
> 硬拆成独立 crate 只有两条路：要么先花几天打断这些环，要么把它们放在同一个 crate 里、
> 用「只暴露必要 API」当护栏。这里选后者，并把环的位置记在 §11。

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

# 改 Rust（测试现在分散在 4 个 crate 里，`-p dieyun-core --lib` 只会跑 0 个）
cargo test --workspace --lib                          # 默认特性（含 local-embed 本地推理）
cargo test --workspace --lib --no-default-features    # 远端 Linux 包口径；两套都过才算绿
cargo clippy --workspace --all-targets -- -D warnings # 带 --all-targets：测试代码也要检查
npm run cargo:test
npm run test:rust-agent-loop-smoke

# 改 Agent / Gateway / Mobile 后验证
npm test                          # 按 git diff 跑相关 smoke
npm run test:agent                # agent smoke（无 sidecar 时跳过 core 相关项）
npm run test:agent-full           # 含 rust-*-smoke（需 pack:dieyun-core）
node scripts/test-agent-smoke.cjs --all --require-core   # CI 口径：缺 dieyun-core 的套件 = 失败（不许静默跳过）

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
| `crates/dieyun-base/src/compaction/` | `cargo test -p dieyun-base --lib compaction` + `npx vitest run test/unit/compaction-telemetry.test.cjs` |
| `crates/dieyun-runtime/src/agent/` | `npm run test:rust-agent-loop-smoke` |
| `crates/dieyun-runtime/src/planner/` | `npm run test:rust-planner-smoke` |
| `src/agent/` | `npm run test:agent-limits` + agent smoke |
| 纯函数 / MCP-计划装配 | `npm run test:unit`；`npm run check:js`（scoped checkJs） |
| `src/gateway/`、`crates/dieyun-runtime/src/rpc/` | `npm run test:local-gateway-smoke` + `verify:rpc-catalog` |
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
| `DIEYUN_FFMPEG` | 本机摄像头（`desktop_camera_look`）用的 ffmpeg 路径；缺省时在 PATH 里找 `ffmpeg` |
| `DIEYUN_DESKTOP_CAMERA` | 多摄像头机器上指定用哪台（设备名子串）；缺省挑第一台非虚拟摄像头 |
| `DIEYUN_MIC_DEVICE` | 生命感「耳朵」（`alive_listen`）的**高级覆盖**：设备名优先在「设置 → 拟态 → 生命」里点选（存 `alive/settings.json`），这个变量只在没法点界面时用 |

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
| [`docs/ARCHITECTURE-DEBT.md`](docs/ARCHITECTURE-DEBT.md) | 架构技术债台账：哪几处仍然过时（本地 IPC / 日志当 IPC / 词法检索 / token 估算 / 快照体积 / JS 侧分期 / 降级 loop）、证据行号、动什么算完、优先级（**接手前先读，别以为都修完了**） |
| [`docs/CODE-CLEANLINESS-REVIEW-2026-11-21.md`](docs/CODE-CLEANLINESS-REVIEW-2026-11-21.md) | 全仓代码整洁度审查（当前工作树口径）：89 条分级发现（P0 6 / P1 26 / P2 34 / P3 23），每条带 `file:line` 证据 + 减法方案 + 验证方式；含闸门覆盖缺口、死通路实测、跨文件重复画像；取证 JSON 与复跑脚本在 `docs/audit/2026-11-cleanliness/`（**动手删/合并前先读**） |
| [`docs/TOOL-VALIDATE-DECISION.md`](docs/TOOL-VALIDATE-DECISION.md) | 工具参数校验：条件必填 / 跨字段规则放哪（`if/then` vs 生成器表 vs 交给执行端）的决策记录与实测成本；含「盘点前提被推翻」的更正（**改 `tool-validate.js` 或 catalog schema 前先读**） |
| [`docs/NODE-THINNING-PLAN.md`](docs/NODE-THINNING-PLAN.md) | 「让 Node 变薄」可排期清单：跨语言双写点清单（常量 / token 估算 / 工具校验 / RPC 契约）、语义上收 core 的边界、**判定留在 Node 别再搬**的负向清单、4 批排期与验收闸门（**改 `src/agent` 或想「把某段搬进 Rust」前先读**） |
| [`docs/RUST-CORE-REFACTOR-PLAN.md`](docs/RUST-CORE-REFACTOR-PLAN.md) | Rust 侧重构施工图：74 条缺陷分级地图（A/B/C/D，带 `文件:行`）、补丁越打越多的 6 条机制原因、目标形态（RPC 注册表 / 出站投影 / 状态字段 / 结构化观测）、P0–P6 批次与三条长期闸门、**「要不要整体重写」的判断依据与前置条件**；取证详档在 `docs/audit/2026-11-rust-core/`（**改 `crates/dieyun-core` 前先读**） |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | 完整架构手册 |
| [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md) | 发版与 dieyun-core 测试 |
| [`docs/LOGGING.md`](docs/LOGGING.md) | 结构化日志前缀 |
| [`docs/rpc-catalog.md`](docs/rpc-catalog.md) | RPC 方法清单（自动生成） |
| [`docs/agent-run-events.md`](docs/agent-run-events.md) | AgentRunEvent 契约 |
| [`docs/DESIGN.md`](docs/DESIGN.md) | 设计原理 |
| [`docs/MEMORY.md`](docs/MEMORY.md) | 记忆系统分层与注入规则 |
| [`docs/MEMORY-VS-DSH.md`](docs/MEMORY-VS-DSH.md) | 与 DSH 记忆设计对照：抄了什么、明确不抄什么及反证条件（**改记忆系统前先读**，别把否过的方案搬回来） |
| [`docs/MULTI-AGENT-VS-DSH.md`](docs/MULTI-AGENT-VS-DSH.md) | 与 DSH 子 Agent 设计对照：两条路线的差别、抄了什么（`subagent_status`）、明确不抄什么（独立子会话 / steer / 每子 agent 模型 / provider 注册表）及反证条件（**改 planner 或 subagent-runner 前先读**） |
| [`docs/SQLITE-ACCESS.md`](docs/SQLITE-ACCESS.md) | SQLite 访问模型：写入连接 / 读池 / 长任务三条通道与在途预算（**改 core 库访问前先读**） |
| [`docs/VECTOR-SEARCH.md`](docs/VECTOR-SEARCH.md) | 向量检索：int8 量化全量扫描的误差界 / 内存上限 / **换 ANN 的触发条件**（改向量检索前先读） |
| [`docs/INDEX-VALUE-REVIEW.md`](docs/INDEX-VALUE-REVIEW.md) | 代码索引 / 结构索引：实测成本与使用率 / 能力定级 / **删 trigram、向量 opt-in、调用图按需** 的整改清单（改 `index/` 或 `graph/` 前先读） |
| [`docs/AGENT-STRATEGY.md`](docs/AGENT-STRATEGY.md) | Agent 策略分层 / taskTier 护栏 |
| [`docs/LSP-DIAGNOSTICS.md`](docs/LSP-DIAGNOSTICS.md) | LSP 定位 / 诊断链路 |
| [`docs/HARNESS-INVENTORY.md`](docs/HARNESS-INVENTORY.md) | harness 能力清单 |
| [`docs/REASONING-ISOLATION-PLAN.md`](docs/REASONING-ISOLATION-PLAN.md) | 思考通道隔离（**已实施**，提交 1-5；仅余取证重放） |
| [`docs/AGENT-RUN-MIGRATION.md`](docs/AGENT-RUN-MIGRATION.md) | 把轮次控制搬进 core 的施工图与现状：`agent.run.*` 契约 / 反向调用协议（`round.prepare`・`tool.execute`）/ 施工顺序 / 负向清单（**第 1–6 步已实施**；`tool.execute` 反向调用按设计未接 —— 工具执行留在宿主） |
| [`docs/LLM-RPC.md`](docs/LLM-RPC.md) | LLM 调用与 core→宿主事件通道：`llm.complete` 契约（含七处调用方）/ core 规范返回形状 / `type:"event"` 与 `type:"call"` 分流 / 负向清单（**改 LLM 请求或流式前先读**） |
| [`docs/LOCAL-EMBEDDING.md`](docs/LOCAL-EMBEDDING.md) | 向量后端：本地推理优先（`ort` + 可选下载的模型/运行时）/ 远端可选 / provider 判定与签名口径 / **已删除的三层补偿**（改向量通道前先读） |
| [`docs/CONTEXT-FOLD.md`](docs/CONTEXT-FOLD.md) | 上下文折叠（compaction）：就地截短旧工具输出 / 保 tool_call 骨架 / 幂等档位 / usage 触发；已删除的 LLM 摘要与负向清单（**改压缩前先读**） |
| [`docs/REQUEST-SNAPSHOT.md`](docs/REQUEST-SNAPSHOT.md) | 请求快照：模型看到了什么 / 为什么折叠 / 预留策略（**已实施**） |
| [`docs/TOOL-GATE.md`](docs/TOOL-GATE.md) | 工具关卡：一次工具调用的唯一流程与关卡清单（**已实施**） |
| [`docs/SANDBOX.md`](docs/SANDBOX.md) | 沙箱：三档能力边界 / ask-once 审批 / 未做的内核强制（**策略层已实施**） |
| [`docs/PEER-MESH-PLAN.md`](docs/PEER-MESH-PLAN.md) | 内网 agent 互通：按机器确认的信任清单 / UDP 发现 / 会话即通道 / 跳数与小时预算 / 建议式租约（**已实施 P0 + P1 授权**） |
| [`docs/BOT-ROOM-PLAN.md`](docs/BOT-ROOM-PLAN.md) | Bot 面板与房间：侧栏 bot 页签（上 = 可信 agent、下 = 房间）/ 房间 = 一次任务 / 扇出不中继 / 工作身份只做展示（**第 1–4 步已实施**） |
| [`docs/MULTI-AGENT-WORKTREE-ISOLATION-PLAN.md`](docs/MULTI-AGENT-WORKTREE-ISOLATION-PLAN.md) | 多 agent 并行时 workspace 资源隔离（**SSH 会话已实施**：每会话一个远端 worktree；含 flock 设计） |
| [`docs/SSH-MODULE-REVIEW.md`](docs/SSH-MODULE-REVIEW.md) | SSH 模块全面审查：架构 / 整洁 / 完成度 + 与 Rust 核心的三个脆弱点（**改 src/ssh 或 src/remote 前先读**） |
| [`docs/CHANNEL-WECOM.md`](docs/CHANNEL-WECOM.md) | 内置频道（企业微信智能机器人）：设置页 / 长连接协议帧 / 在 Main 后台跑一轮 / 附件与主动推送（**已实施**） |
| [`docs/SHARED-MEMORY.md`](docs/SHARED-MEMORY.md) | 共享记忆（跨机 PostgreSQL，设置 → 扩展）：只同步记忆条目 / 一条召回 SQL（向量 + trigram 兜底）/ advisory lock 提炼 / 连不上即关闭（**已实施**） |
| [`docs/ALIVE.md`](docs/ALIVE.md) | 生命感（设置 → 拟态 → 生命）：心跳/四相位/张力/阈值漂移/自发唤醒/决策权在模型 + 感官（抽屉 / 眼睛 / 嘴与耳）+ **设定**（拟态 → 设定：一个文本框，原文只进心跳轮状态块）；**它不会死、没有损耗、不隔离记忆** —— 与原 `--alive` 设计的差别、隔离度审计与负向清单一文说清（**已实施**） |
| [`docs/PET.md`](docs/PET.md) | 宠物（设置 → 宠物 → 点点）：文件分工 / 设置字段与夹取 / **形态只有运行状态（没有设置项）** / **猫的四拍步态**（支撑-摆动占空比、为什么用深度线性场而不是枢轴旋转、远侧腿压暗）/ 命中式穿透与滞回 / 帧率与显示器边界 / 与生命感的接口 / 负向清单与已知未做（**改宠物模块前先读**） |
| [`docs/DESKTOP-CAMERA-PTZ.md`](docs/DESKTOP-CAMERA-PTZ.md) | 本机云台（`desktop_camera_ptz`）：为什么与取帧分开 / DirectShow `IAMCameraControl` 与 `v4l2-ctl` 两条传输 / 实测数字（打开 20ms、Set 2ms、持有滤镜不影响 ffmpeg 抓帧）/ 两个 koffi 坑 / 权限共用 `desktopCamera` / 与 AI 追踪打架时的表现（**已实施**） |
| [`docs/ALIVE-VISIBILITY-PLAN.md`](docs/ALIVE-VISIBILITY-PLAN.md) | 生命感的「看得见」三件事：每日 token 额度（成本护栏）/ 体征历史曲线（`history.jsonl`）/ 侧栏「生命」页签与 rail 心跳图标（**已实施**；图标不动画、与其它图标同色） |
| [`docs/HEADLESS-MODE-PLAN.md`](docs/HEADLESS-MODE-PLAN.md) | 无界面运行（终端 REPL / 一次性 run / 浏览器 Web）：headless 装配、`main-turn-runner` 单一来源、safeStorage 替身、退出码与单实例边界、tgz + deb 分发与冷启动闸门（**P0–P5 已实施**） |
| [`docs/HEADLESS.md`](docs/HEADLESS.md) | 无界面运行**安装与运维手册**：deb / tarball 安装、env 文件 / 密钥 / model-settings、参数与退出码、systemd、安全、排障表、升级回滚 |
| [`docs/AGENT-SELF-CONTROL-PLAN.md`](docs/AGENT-SELF-CONTROL-PLAN.md) | 模型对「自己」的控制面：能力事实块 / `agent_inspect` / `agent_capability` 申请闭环 / 改动回执 / 计划可改可停 / 自主配额 / 工作空间候选（**S1–S6 已实施**；含负向清单与未纳入项） |

---

## 提交前检查清单

- [ ] `npm test` 或对应模块 smoke 通过
- [ ] 未改动无关文件（git diff 可控）
- [ ] 新增 RPC / 事件字段已更新文档或 CODEMAP
- [ ] 未引入密钥或本地 deploy 配置

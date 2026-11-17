# Renderer 模块索引（dieyunagent）

> Agent 改 UI 时先查此表，避免全目录 grep。完整架构见 [`docs/ARCHITECTURE.md`](../../docs/ARCHITECTURE.md#8-渲染进程-ui-模块)。脚本加载顺序见 [`index.html`](index.html)。

**原则**：Renderer 只做展示与 IPC；Agent 循环在 Main + `dieyun-core`，勿把业务状态机堆进 renderer。

**三条防回流规矩**（2026-11 全仓混乱度审查后定，见 [`docs/MODULE-CHAOS-REVIEW.md`](../../docs/MODULE-CHAOS-REVIEW.md) §四）：

1. **不准新增 `window.X` 顶层函数做新逻辑**：新逻辑写进 `src/agent/`（经 `scripts/build-agent-bundle.cjs` 打包成 `agent-bundle.js`）或收进已有的 `renderer-*.js` 单一来源文件；渲染层只保留「取数 + 画 DOM」。（现状：约 470 个 `window.X` 导出、123 个 `<script>` 顺序拼接，函数声明本身就是全局，加得越多越拆不动。）
2. **会话/运行态只许一个写者**：`sessionActiveRuns`（`renderer-chat-state.js`）的写入只允许出现在 `renderer-chat-live-run.js` / `renderer-agent-send.js` 这两个「run 的开始与收尾」处；其它模块一律只读（`get` / `has`）。曾经 20 多个文件直接 `set/delete`，结果状态怎么变的没人说得清。
3. **账本类 RPC 只许一处**：`agent.trace_save` / `agent.run_upsert` / `agent.plan_save` 只能出现在 `src/renderer/agent/trace-store.js`。别在气泡或收尾流程里另发一次——那会把「一轮的账本」写两次。

**文案与数字格式（唯一来源）**：时间 / 字节 / 进度条文案只在 `renderer-utils.js` 实现 —— `fmtClock`（`14:35`）、`fmtMonthDayClock`（`03-14 14:35`）、`fmtRelShort`（`刚刚/5m/3d`，会话列表）、`fmtRelAgo`（`刚刚/5 分钟前/2 天前`，git 历史与产物）、`fmtDateTime`（本地完整时间）、`fmtBar`（`████▒▒ 40%`）、`fmtBytes`（`1.2 KB`）。**不要在面板里再写一份** `new Date(...).toLocaleTimeString()` 之类的取整逻辑：同一句「5 分钟前」曾经有四种口径。

**弹窗约定**：所有 modal / overlay 弹窗（`*-overlay`、lightbox、`showTextPrompt`）**只能由关闭按钮（× / 取消）或 Esc 关闭** —— 禁止给遮罩绑「点击空白处关闭」的 click 监听（误触会丢半截表单）。移动端抽屉同理：只由左侧「×」/ 面板内关闭按钮关闭，`*-backdrop` 仅用于挡住下层点击。下拉菜单（`renderer-select-menu.js`、Composer 的模型菜单、工作区菜单）不属于弹窗，保持「点外部 / Esc 关闭」。

## 核心链路（Agent / 聊天）

| 文件 | 职责 | 改 UI 时关联 |
|------|------|--------------|
| `renderer-agent-loop.js` | AgentService / 会话辅助 | 非发送主路径 |
| `renderer-agent-send.js` | sendMessage 编排（gate→prep→run→catch） | 发送主路径 |
| `renderer-agent-run.js` | runAgentCompletion（模型/工具轮） | 执行中气泡更新 |
| `renderer-agent-complete.js` | 成功收尾 / 验收提示渲染（判定在 Main）/ 断网暂停 | 完成门槛（不自动续跑） |
| `renderer-agent-resume.js` | resumeAgentToolLoop | 「继续」协议续跑 |
| `renderer-agent-abort.js` | 停止 / abort 等待 / 停止页脚 | 停止按钮 |
| `renderer-agent-prep-remote.js` | 远程 core 等待（`index.remote_wait_ready`） | 准备阶段远程 |
| `renderer-agent-context-ui.js` | Composer 上下文进度环 / token 统计 | 上下文用量 UI |
| `../agent/agent-system-prompt.js` | 模型可见准则与权限/工作区文案 | 改 Agent 规则 |
| `../agent/system-prompt-prep.js` | Main：codebase / 开文件 / AGENTS.md overview / 图谱(结构信号) / 记忆 / 技能索引 / MCP | 改召回装配 |
| `renderer-agent-system-message.js` | 视图快照 + 编辑器/诊断 + 缓存 | 系统消息注入 |
| `renderer-composer-mention.js` | Composer @ 提及菜单 | @ 菜单 |
| `renderer-agent-continue.js` | 续跑 / 取消 / 分段 | 停止与段续跑 |
| `renderer-agent-llm.js` | LLM HTTP / SSE / 记忆整理 | 模型请求 |
| `renderer-agent-compaction.js` | 上下文压缩 | compaction UI |
| `renderer-agent-rust-loop.js` | Rust loop / planner IPC | 主循环 |
| `renderer-agent-api.js` | Agent API 窗口导出 | compaction 进度桥 |
| `renderer-agent-prep.js` | 准备阶段 checklist 状态 | 「准备中」步骤 UI |
| `renderer-chat-scroll.js` | 会话滚动 / 跟随（贴底策略 + 朗读念到哪一句的视野跟随 + 用户滚动意图） | 切会话滚动 |
| `renderer-chat-live-run.js` | live run 气泡 / Agent 事件 | 执行中气泡 |
| `renderer-chat-bubbles.js` | 气泡、页脚、附件、toast | 聊天气泡 |
| `renderer-chat-render.js` | 历史渲染、流式钉底 | 会话重绘 |
| `renderer-chat-nav.js` | 消息导航刻度带（右缘：每条消息一根刻度 / 当前视口高亮 / 悬停摘要 / 点击跳转） | 聊天区右缘导航 |
| `renderer-thinking-trace-dom.js` | 思考区 DOM / 轮次块（折叠思考，旁白+工具在折叠外） | 思考过程 |
| `renderer-thinking-trace.js` | 流式 patch / 合成回退 | 思考区更新 |
| `renderer-answer-md.js` | 回答区 Markdown 渲染（无依赖）：顶层围栏扫描 / GFM 表格 / 标题 / 列表 / 行内语法 / 媒体占位（图 / 音频 / 视频）/ 链接点击走 `host.open_url`。单一来源，`renderer-mermaid.js` 复用它挑 mermaid 块 | 正式回复排版 |
| `renderer-answer-figures.js` | 正式回答里的媒体：正文 `![]()` 占位绑定 + 本轮媒体条（`tool.imagePaths` / 落盘的 path / base64 读图三个结构信号）。**图片**读盘转 blob，点图走通用灯箱全屏看（`openImageLightbox`）；**音频 / 视频**不读字节，`<video>/<audio>` 直接挂可 seek 的 `dieyun-media://` URL（Main 按 Range 分块取，见 `src/main/media-protocol.js`），播不了降级「用系统播放器打开」。读取与释放复用产物面板（`loadArtifactImageObjectUrl` / `openArtifactTab`） | 回答里的截图 / 音视频 |
| `renderer-subagent-panel.js` | 右侧面板「子代理」页：本次运行的子 Agent 全文思考（复用思考区卡片渲染原语） | 子代理详情 |
| `renderer-artifacts-session.js` | 会话产物桶 / UI batch | 产物会话态 |
| `renderer-artifacts-browse.js` | 工作区浏览路径 | 产物目录 |
| `renderer-artifact-diff-view.js` | 产物 diff 静态渲染 / 读盘 | 变更 diff 预览 |
| `renderer-artifacts.js` | 产物列表绘制 / 打开；图片 / Office / 音视频只读预览（音视频走 `artifactMediaUrlForCurrentSession` 造 `dieyun-media://` URL，不读字节） | 产物面板 |
| `renderer-artifacts-tabs.js` | 文件面板多标签 + 长驻编辑区（标签状态 / 未保存标记 / 文本域与 Monaco 二选一） | 文件面板多标签 |
| `renderer-artifacts-panel.js` | 侧栏「产物」页：会话产物桶（带 diff）+ 会话时间窗内 `artifact.list_files` 扫描结果（脚本 / 截图 / 插件落盘的 docx、xlsx、png、html） | 产物页 |
| `renderer-chat-history.js` | 会话列表、切换、加载消息；**更早历史分页的唯一来源**（首屏 32 条 / 每页 100 条、贴顶自动取、**页头按轮次开头对齐**：头不是用户消息就往前补，见 `alignRowsToTurnStart`、顶部「加载更早 / 重新加载 / 已到会话开头」那一行由 `chatHistoryEdgeMode` 判定） | 侧栏会话 / 更早历史 |
| `renderer-chat-state.js` | 当前会话 run 状态 | 进行中任务标记 |
| `renderer-composer.js` | 输入框、发送、模型选择 | Composer 行为 |
| `renderer-attachments.js` | 附件（粘贴 / 拖入 / 选择）与**通用图片全屏查看** `openImageLightbox()`（composer 预览与回答里的截图共用同一份，不另造大图查看器） | 附件与看图 |
| `renderer-composer-form.js` | 表单控件 | 输入区细节 |
| `renderer-composer-queue.js` | 排队发送、立即发送 | 多消息队列 |
| `renderer-composer-voice.js` | 语音输入 | 麦克风 / 转写 |
| `renderer-shortcuts.js` | **快捷键唯一来源**：键位表（默认组合 + 说明）、`matchesShortcut(ev, id)` 匹配口径、设置页「基础设置 → 快捷键」（点键位后按新键、冲突检查）；覆盖项存 `settings.shortcuts` | 改键位 / 新增全局快捷键 |
| `renderer-tool-defs.js` | 从 `tool-catalog` 组装工具列表 + 插件 UI | 工具列表注入 |
| `../agent/tool-catalog.js` | 静态工具 schema 唯一目录 | 改工具描述/参数 |
| `renderer-tool-results.js` | 工具结果卡片 | 工具输出 UI |
| `renderer-context-engine.js` | token 估算 / 工具结果截断 / LSP 诊断块 / 编辑器与 @Codebase 信号薄适配（召回全在 Main） | 上下文注入（非 loop） |
| `renderer-agent-session.js` | 会话上下文薄封装 | 历史消息组装 |
| `../agent/session-transcript.js` | 会话账本过滤（user/assistant） | 下轮模型历史投影 |
| `renderer-agent-tools.js` | 工具调用 UI 辅助 | tool 卡片交互 |

## Gateway / 工作区

| 文件 | 职责 |
|------|------|
| `renderer-gateway.js` | `gatewayCall(method, params)` —— 唯一 RPC 出口，走 `window.diecloud.gatewayRpc`（桌面 = Main IPC，网页 = shim 的同源 `/gateway`）。**本层不再持有 WebSocket** |
| `renderer-workspace-ssh.js` | SSH 工作区 UI |
| `renderer-session-view-state.js` | 视图 ↔ 会话绑定 |

## 侧栏与编辑器

| 文件 | 职责 |
|------|------|
| `renderer-side-panel.js` | 侧栏切换 |
| `renderer-pane-layout.js` | 分栏布局 |
| `renderer-monaco-core.js` | Monaco 加载 / 诊断 / diff 动画 |
| `renderer-monaco.js` | 产物 Monaco 挂载 |
| `terminal-screen.js` | 终端显示层：剥离 OSC/CSI、CR/BS/EL 归约（纯函数，可单测） |
| `renderer-terminal.js` | 内置终端（会话/输入转发/输入法宿主） |
| `renderer-browser.js` | 内置浏览器面板 |
| `renderer-changes-pane.js` | 变更列表 |
| `renderer-scm-pane.js` | 源码管理（更改/历史双模式：git 状态 + 暂存/提交、提交时间线泳道图 + 提交内 diff） |
| `renderer-path-utils.js` | 路径归一 / 匹配、trace 工具参数还原 |
| `renderer-artifacts.js` | 产物列表面板（session/browse/diff 见上表） |
| `renderer-codebase-panel.js` | 代码片段索引：状态 / 重建 / 建向量（面板已并入「索引」页签） |
| `renderer-graph-panel.js` | 结构索引：状态 / 重建 / 符号命中渲染（面板已并入「索引」页签） |
| `renderer-index-panel.js` | 「索引」面板外壳（`data-side-tab="index"`）：一个搜索框同查片段+符号、两个索引的 shown/hidden 扇出、rail busy 合成 |
| `renderer-goal-panel.js` | 会话目标的两个面：气泡区上方**目标条**（`#goal-bar`：目标 · 第几轮 · 最近一条事实，点开就地展开检查事实与清单）与侧栏**「目标」页**（`data-side-tab="goal"`）。视图由 Main 的 `goals/session-goal.js#toPanelView` 成形，这里只画；同一份视图、同一次取数、同一个轮询（可见 / 有目标时才跑）。进度条按视图的 `progressFrom` 选文案（`checks` = 验收通过数/声明检查数，客观；`todos` = 清单勾选，模型自述；`outcome` = 收尾 0/1），不自己判比例 |
| `renderer-problems.js` | LSP 诊断 |

## 设置 / 模型 / 技能

| 文件 | 职责 |
|------|------|
| `renderer-settings-shell.js` | 设置弹窗外壳 |
| `renderer-model-runtime.js` | 模型/上下文档位归一化 |
| `renderer-model-settings.js` | 供应商/自定义/Embedding 编辑器 |
| `renderer-skills-grid.js` | 技能/MCP 列表网格 |
| `renderer-skills-ui.js` | 技能详情 / MCP 配置 |
| `renderer-mcp-catalog.js` | MCP 服务管理 |
| `renderer-permissions.js` | 权限开关 |
| `renderer-agents-md.js` | 项目 AGENTS.md 维护 |
| `renderer-dieyun-md.js` | dieyun.md 编辑 |
| `renderer-channels.js` | 设置 →「频道」：企业微信智能机器人凭据 / 长连接状态 / 工作空间绑定（配置与运行时在 `src/channels/`，这里只读 `channels:*` IPC） |
| `renderer-shared-memory.js` | 设置 → 扩展 →「共享记忆」：PostgreSQL 连接（测试连接 / 保存即重连）、探活原因、召回条数与阈值展示（数据层在 `src/memory-shared/`） |

## 基础设施

| 文件 | 职责 |
|------|------|
| `renderer-theme.js` / `renderer-theme-bootstrap.js` | 主题 |
| `renderer-i18n.js` | 文案 |
| `renderer-utils.js` | 通用工具函数 + **文案格式唯一来源**（`fmtClock` / `fmtMonthDayClock` / `fmtRelShort` / `fmtRelAgo` / `fmtDateTime` / `fmtBar` / `fmtBytes`） |
| `renderer-window.js` | 窗口控制 |
| `renderer-connect.js` | 「连接」对话框外壳：手机连接 / Agent 互通 两个标签页（只切页与按需刷新，不做业务判定） |
| `renderer-mobile.js` | 手机桥接 UI（二维码等），渲染在「连接 → 手机连接」标签页 |
| `renderer-peer.js` | 内网 Agent 互通面板 + 会话即对端通道，渲染在「连接 → Agent 互通」标签页；会话绑定提示行（`#peer-session-row`）在输入框上方常显，发出 / 未送达的注记（`.msg-peer-note`）落在对话里 |
| `core/bootstrap.js` | 命名空间引导 | 

## 动效（唯一来源）

时长与曲线只有一份：`styles.css` 的 `:root --motion-*`（移动端、更新窗口声明同名同值 token）。

| token | 值 | 用在哪 |
|-------|----|--------|
| `--motion-fast` | 120ms | 悬停 / 按下 / 颜色变化 |
| `--motion-base` | 180ms | 小位移：chevron、开关、图标、进度条 |
| `--motion-slow` | 280ms | 会改布局占位的动作：折叠展开、侧栏进出场、列表分栏、toast 入场 |
| `--motion-ease-enter` / `-exit` / `-standard` | cubic-bezier | 减速进 / 加速出 / 对称（悬停、颜色） |

规则：

- 声明处**不写** `0.15s` / `ease`，一律引用 token；方向相关的曲线写在不同状态上（CSS 取「变化后」那条 transition，所以 `[open]` 用 enter、基线用 exit）。
- 折叠只有一种实现：容器 `grid-template-rows: 0fr ⇄ 1fr` + 子元素 `min-height:0` / `overflow:hidden`。`max-height: auto|none ⇄ 0` 不可插值，别再用。
- 会随指针/流式内容逐帧变化的尺寸（分隔条拖拽、语音波形）**不挂过渡**，波形用 `transform: scaleY()` 而不是逐帧写 `height`。
- JS 需要「等过渡结束」时用 `renderer-constants.js:motionMs('--motion-slow')` 读同名 token，不要复制毫秒数。
- 无限脉冲/旋转的节奏（0.75s–1.4s）是另一族，不并入过渡尺度。
- **无极阻尼**（设置 → 主题 开关，偏好 `tracePrefs.dampedFlow`，落到 `:root[data-thinking-flow='damped']`）：思考区改为连续入流。两半缺一不可 —— 流式新生块的入场动画（`thinking-damped-in`，只有 `data-flow-enter` 的块会有，历史重绘不重放）＋ 贴底改阻尼跟随（`renderer-chat-render.js:dampedChatFollowStep`）；只加动画不阻尼滚动仍然是一行一行跳。入场标记 `markThinkingFlowEnter` 必须在 `animationend` 后即摘（留着会让之后打开开关时整片重放）。**浮条/按钮的显隐只认 `chatAutoFollow` 这一个跨帧稳定的意图位**：追帧期间视口暂时不在底部是我们自己的动画中间态，用逐帧置位/复位的状态位去压它们，会让「上一问」浮条按 delta 节奏一闪一闪（无极阻尼开启后浮条狂闪的根因）。系统「减少动效」时整体退回整块瞬现，`matchMedia` 变化要实时重算，别只判一次。**入场动画必须幂等**：同一轮在流式期间会被重绘多次（节点可能整棵重建），入场按 `uiState.flowEntered` 记账、一轮只入一次流；旁白这类「随 `visibleContent` 有无反复重建」的节点一律不挂入场 —— 否则等于一帧播一次，看起来就是一直在闪。

## 改完验证

```bash
npm run check:renderer
npm run test:renderer    # check + bundle 语法
```

改动映射见 [`docs/CODEMAP.json`](../../docs/CODEMAP.json) → `renderer-all`。

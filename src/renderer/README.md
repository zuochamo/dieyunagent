# Renderer 模块索引（dieyunagent）

> Agent 改 UI 时先查此表，避免全目录 grep。完整架构见 [`docs/ARCHITECTURE.md`](../docs/ARCHITECTURE.md#8-渲染进程-ui-模块)。脚本加载顺序见 [`index.html`](index.html)。

**原则**：Renderer 只做展示与 IPC；Agent 循环在 Main + `dieyun-core`，勿把业务状态机堆进 renderer。

## 核心链路（Agent / 聊天）

| 文件 | 职责 | 改 UI 时关联 |
|------|------|--------------|
| `renderer-agent-loop.js` | AgentService / 会话辅助 | 非发送主路径 |
| `renderer-agent-send.js` | sendMessage 编排（gate→prep→run→catch） | 发送主路径 |
| `renderer-agent-run.js` | runAgentCompletion（模型/工具轮） | 执行中气泡更新 |
| `renderer-agent-complete.js` | 成功收尾 / 完成验收提示 / 断网暂停 | 完成门槛（不自动续跑） |
| `renderer-agent-resume.js` | resumeAgentToolLoop | 「继续」协议续跑 |
| `renderer-agent-abort.js` | 停止 / abort 等待 / 停止页脚 | 停止按钮 |
| `renderer-agent-prep-remote.js` | 远程 core 等待、自动 codebase 上下文 | 准备阶段远程 |
| `renderer-agent-context-ui.js` | Composer 上下文进度环 / token 统计 | 上下文用量 UI |
| `../agent/agent-system-prompt.js` | 模型可见准则与权限/工作区文案 | 改 Agent 规则 |
| `../agent/system-prompt-prep.js` | Main：codebase / 开文件 / AGENTS.md overview / 图谱(结构信号) / 记忆 / Playbook / 技能索引 / MCP；Wiki 不自动注入 | 改召回装配 |
| `renderer-agent-system-message.js` | 视图快照 + 编辑器/诊断 + 缓存 | 系统消息注入 |
| `renderer-agent-reviewer.js` | 可选 LLM Reviewer：默认关；须独立模型 + 文件 diff | 终态 opt-in |
| `renderer-composer-mention.js` | Composer @ 提及菜单 | @ 菜单 |
| `renderer-agent-continue.js` | 续跑 / 取消 / 分段 | 停止与段续跑 |
| `renderer-agent-llm.js` | LLM HTTP / SSE / 记忆整理 | 模型请求 |
| `renderer-agent-compaction.js` | 上下文压缩 | compaction UI |
| `renderer-agent-rust-loop.js` | Rust loop / planner IPC | 主循环 |
| `renderer-agent-api.js` | Agent API 窗口导出 | compaction 进度桥 |
| `renderer-agent-prep.js` | 准备阶段 checklist 状态 | 「准备中」步骤 UI |
| `renderer-chat-scroll.js` | 会话滚动 / 跟随 | 切会话滚动 |
| `renderer-chat-live-run.js` | live run 气泡 / Agent 事件 | 执行中气泡 |
| `renderer-chat-bubbles.js` | 气泡、页脚、附件、toast | 聊天气泡 |
| `renderer-chat-render.js` | 历史渲染、流式钉底 | 会话重绘 |
| `renderer-thinking-trace-dom.js` | 思考区 DOM / 轮次块（折叠思考，旁白+工具在折叠外） | 思考过程 |
| `renderer-thinking-trace.js` | 流式 patch / 合成回退 | 思考区更新 |
| `renderer-artifacts-session.js` | 会话产物桶 / UI batch | 产物会话态 |
| `renderer-artifacts-browse.js` | 工作区浏览路径 | 产物目录 |
| `renderer-artifacts-live-write.js` | live-write 预览 | 写入预览 |
| `renderer-artifacts.js` | 产物列表绘制 / 打开 | 产物面板 |
| `renderer-chat-history.js` | 会话列表、切换、加载消息 | 侧栏会话 |
| `renderer-chat-state.js` | 当前会话 run 状态 | 进行中任务标记 |
| `renderer-composer.js` | 输入框、发送、Agent/Plan 模式切换 | Composer 行为 |
| `renderer-composer-form.js` | 表单控件、快捷键 | 输入区细节 |
| `renderer-composer-queue.js` | 排队发送、立即发送 | 多消息队列 |
| `renderer-composer-voice.js` | 语音输入 | 麦克风 / 转写 |
| `renderer-tool-defs.js` | 从 `tool-catalog` 组装工具列表 + 插件 UI | 工具列表注入 |
| `../agent/tool-catalog.js` | 静态工具 schema 唯一目录 | 改工具描述/参数 |
| `renderer-tool-results.js` | 工具结果卡片 | 工具输出 UI |
| `renderer-context-engine.js` | 代码库/图谱/记忆召回辅助（Main 装配；此处保留 UI/其它入口） | 上下文注入（非 loop） |
| `renderer-agent-session.js` | 会话上下文薄封装 | 历史消息组装 |
| `../agent/session-transcript.js` | 会话账本过滤（user/assistant） | 下轮模型历史投影 |
| `renderer-agent-tools.js` | 工具调用 UI 辅助 | tool 卡片交互 |

## Gateway / 工作区

| 文件 | 职责 |
|------|------|
| `renderer-gateway.js` | `gatewayCall(method, params)` |
| `renderer-workspace-ssh.js` | SSH 工作区 UI |
| `renderer-workspace-busy.js` | 工作区忙状态遮罩 |
| `renderer-session-view-state.js` | 视图 ↔ 会话绑定 |

## 侧栏与编辑器

| 文件 | 职责 |
|------|------|
| `renderer-side-panel.js` | 侧栏切换 |
| `renderer-pane-layout.js` | 分栏布局 |
| `renderer-monaco-core.js` | Monaco 加载 / 诊断 / diff 动画 |
| `renderer-monaco.js` | 产物 Monaco 挂载 |
| `renderer-terminal.js` | 内置终端 |
| `renderer-browser.js` | 内置浏览器面板 |
| `renderer-changes-pane.js` | 变更列表 |
| `renderer-live-write.js` | Agent 写文件实时预览 |
| `renderer-artifacts.js` | 产物列表面板（session/browse/live-write 见上表） |
| `renderer-codebase-panel.js` | 代码索引侧栏 |
| `renderer-graph-panel.js` | 结构索引侧栏 |
| `renderer-wiki-panel.js` | 项目 Wiki（`.dieyun/wiki`） |
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

## 基础设施

| 文件 | 职责 |
|------|------|
| `renderer-theme.js` / `renderer-theme-bootstrap.js` | 主题 |
| `renderer-i18n.js` | 文案 |
| `renderer-utils.js` | 通用工具函数 |
| `renderer-window.js` | 窗口控制 |
| `renderer-mobile.js` | 手机桥接 UI（二维码等） |
| `core/bootstrap.js` | 命名空间引导 | 

## 改完验证

```bash
npm run check:renderer
npm run test:renderer    # check + bundle 语法
```

改动映射见 [`docs/CODEMAP.json`](../docs/CODEMAP.json) → `renderer-all`。

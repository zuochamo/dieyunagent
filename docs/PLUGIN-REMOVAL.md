# 插件层下线（决策记录）

**结论：`src/plugins/` 整体删除，插件不再是一种扩展机制。** 第三方能力只有两条路：MCP（外部工具）与技能（文本知识）。

## 为什么删

1. **工具通道与 MCP 重叠，且每一条轴都更差。** 旧插件用 `require()` 在主进程里跑插件代码并注入工具；MCP 是进程外协议、构建期 sha256、按需召回、schema 瘦身。同一个需求（「给我一个外部工具」），插件给的隔离更少、分发更脆、审计更难。3 个示例里 2 个（dingtalk-bot / http-api）是纯工具插件——它们先被删掉，改用 MCP 是等价替换。
2. **剩下唯一不可替代的面（生命周期钩子 `onAgentTurnEnd` / `onPlanRan`）没有真实使用方。** 全部使用者就是仓库自带的 3 个示例，即「作者自己写、自己用」。为一个没有第三方消费者的被动事件保留一套宿主 + 清单校验 + 安装器 + 设置页 + 12 个 RPC，是纯维护成本。
3. **能力隔离做不到，就不该承诺。** `src/plugins/permissions.js` 只有 17 行、且只拦 `ctx.fetch`；插件被 `require` 之后与主进程同权（能读任意文件、能联网）。这意味着插件必须被当作「完全可信的本机代码」——那么远程目录源 / URL 直装本来就不该存在（已在前面步骤关掉），而「本地可信代码的回调注册表」不值得单独一层架构。

判断顺序（都是先删再看）：删工具通道 → 关远程安装 → 钩子改进程外（可崩溃、可超时 kill）→ 仍然没有第三方钩子作者 → 整层下线。

## 删掉了什么

- `src/plugins/`（宿主 / 装载 / 清单 / 目录 / 打包 / 版本 / 权限 / 钩子运行时）
- `src/gateway/handlers/plugins.js` 与 12 个 `plugins.*` RPC；`Server.plugins`、`ctx.plugins`、`onPluginsChanged`
- Renderer：`renderer-plugin-settings.js`、`renderer-plugin-catalog.js`、`renderer-tool-defs.js` 里的插件列表/安装/详情 UI、设置页「插件」标签与导航项、`PLUGIN_TAXONOMY`
- `plugins/bundled/catalog.json`（内置目录）、`examples/plugins/`（5 个示例）
- `dialog:pick-plugin-zip` IPC、`plugins.*` 本地 RPC 前缀、`plugins.list` 冒烟断言
- 事件发射点：`renderer-agent-complete.js` 的 `onAgentTurnEnd`、`main/mcp-plans-boot.js` 的 `onPlanRan`

保留：`semver` 比较收敛到 `src/mcp/package-store.js`（MCP 是唯一消费者）。

## 以后又需要「Agent 收尾时做点什么」怎么办

不要重启一个通用钩子协议。落点按优先级：

1. 该动作如果本身就是外部系统的能力（推送、写工单、发消息）→ MCP 服务器，由 Agent 在对话里主动调用。
2. 该动作必须由系统在固定时刻触发（收尾 / 计划执行完）→ 写成 Gateway 或 Main 里的一个具名步骤，直接挂在既有事件流上（`plans` 的 run 完成、`run-events` 的 done），消费者写死、不做通用注册表。
3. 只有当出现**至少一个仓库外作者**、且他需要的是同一类事件时，才值得重新讨论「进程外钩子」；届时的起点是一个已知事件 + 一个已知消费者，而不是先造宿主。

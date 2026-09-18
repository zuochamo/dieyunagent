# 叠云 Agent 开发文档

本文档记录版本规划与发版流程。产品名：**叠云 Agent**（包名 `pixel-office-agent`）。

**设计原则**：叠云 Agent 的代码尽量场景通用，靠 Agent 自身的工具与推理能力完成任务，避免为单一业务场景堆叠专用代码。

### 部署默认值（内网 / COS）

配置集中在 `src/deploy-config.js`，按优先级加载（后者覆盖前者）：

1. 代码内置叠云内网默认（`BUILTIN_DEFAULTS`）
2. `~/.dieyun/deploy.json`
3. 开发机可选 `deploy.local.json`（已加入 `.gitignore`）
4. 环境变量（`SERVER_URL`、`UPDATE_URL` 等，优先级最高）

外网或自建部署时，用 `deploy.json` 或环境变量覆盖即可。仓库根 [`deploy.defaults.example.json`](../deploy.defaults.example.json) 与内置默认一致，便于复制修改。

开发机可在 `deploy.local.json`（gitignore）填写 `openApi` 四系统 URL/Key；`npm run dev` 时会注入到预装 MCP「叠云四系统 Open API」，并在首次启动时自动启用（若尚未手动开关过）。

---

## Agent 架构边界（阶段 2）

桌面 Agent 采用 **三层进程**，阶段 2 起统一 **`AgentRunEvent` 事件协议**（`src/agent/run-events.js`），便于后续将循环下沉 Main/Gateway。

| 层 | 目录 | 职责 |
|----|------|------|
| **Renderer** | `src/renderer/` | UI：聊天气泡、输入、Plan 进度展示；通过 `dispatchAgentRunEvent` 消费事件，**不**承载长期 Agent 内核 |
| **Main** | `src/main-entry.js`、`src/agent/coordinator.js` | Electron 壳、Worktree、LLM 代理、`AgentRunCoordinator`、手机 `AgentService` |
| **Gateway** | `src/gateway/` | 工具 RPC（fs/host/web）、SQLite 记忆、远程 SSH |

### 事件类型（`AgentRunEvent`）

`run_start` · `prep` · `trace` · `stream` · `tool` · `round_limit` · `arbitration` · `done` · `error` · `stopped`

Renderer 内：`updateSessionRunProgress(trace, …)` 为兼容层，内部转为 `trace` 事件并 `dispatchAgentRunEvent`。

### 会话上下文（共享）

`src/agent/session-transcript.js`：会话账本过滤（只保留 user/assistant）。  
`src/agent/session-context.js`：与 UI 无关的纯函数（历史投影、assistant 正文提取、弱回复落库折叠、压缩归档投影）。  
Renderer 薄封装：`renderer-agent-session.js`（绑定 `messages` 与 meta 解析）。

### 后续（阶段 3 — 已完成）

Agent 循环与 Plan 编排均在 **Main + dieyun-core**：

- Agent：`agent:rust-loop-run` → `agent.loop.*`
- Planner：`agent:planner-run` → `planner.run.*`（`src/agent/rust-planner-runner.js`）
- Renderer 仅 IPC + 事件展示；Agent/Planner loop 均在 dieyun-core（`planner-orchestrator.js` 已删除）

### dieyun-core 开发与测试

```bash
npm run cargo:test
npm run pack:dieyun-core          # 发布前重建 sidecar
npm run test:rust-agent-loop
npm run test:rust-planner-pipeline
npm run test:rust-planner-smoke  # mock LLM + Gateway 端到端
```

**AI Agent 在本仓库开发**：见根目录 [`AGENTS.md`](../AGENTS.md) 与 [`docs/AGENT-DEV.md`](./AGENT-DEV.md)。日常用 `npm run dev:fast`；改完跑 `npm test`（按 diff）或 `npm run test:agent`（全量 smoke）。Renderer 模块见 [`src/renderer/README.md`](../src/renderer/README.md)。

环境变量：`DIEYUN_CORE=0` 禁用 sidecar；开发可用 `DIEYUN_CORE_BIN=target/debug/dieyun-core.exe`。

---

## 当前版本能力（v1.3.0）

### 桌面客户端

- 无边框主界面、设置弹窗（模型 / 主题 / 数据库）
- 模型设置：**文本模型**、**多模态模型** 子标签；配置存 `localStorage`（`diecloud.model.settings.v1`）
- 本地 Gateway（loopback）、技能、SQL 只读、本机控制工具
- Agent 工具轮次无硬上限，依赖用户停止 + 上下文压缩；展示**思考过程**
- 开机自启、单实例（含 Windows 命名管道兜底）、generic 自动更新

## 本地开发指引

### 打包与发布

#### 版本号

完整发布时用根目录 `build-installer.bat` 输入版本号。脚本会同步更新桌面端 `package.json` / `package-lock.json` 和手机端 `mobile-app/android/gradle.properties`（协议版号 = PC / 手机统一版号）。

`scripts\build-installer-version.bat` 是带版号辅助的同一条发布链：不带参数时会自动识别开发版版号（`package.json`）+1 patch 作为建议协议版号并预填，**回车确认或改写后才开始构建**；带参数（`build-installer-version.bat 0.1.36`）则原样透传、不再交互。版号解析与推导的单一来源是 `scripts/app-version.cjs`（CLI：`scripts/resolve-next-version.cjs`）。

#### 完整发布

```bat
cd d:\opencode\dieyunagent
build-installer.bat 0.0.29
```

脚本会依次执行：

- 更新 PC 与手机端版本号
- 构建 Windows NSIS 安装包
- 构建 Android APK
- 发布到 `Y:\client-electron\updates-published`
- 上传到腾讯 COS

发布前确认：

| 项目 | 要求 |
|------|------|
| Y: | `Y:\client-electron\updates-published` 已映射且可写 |
| Android | `ANDROID_HOME` 可用，且手机端需要参与发布 |
| COS | `COS_SECRET_ID`、`COS_SECRET_KEY` 已设置 |

#### 本机构建

```bash
cd d:\opencode\dieyunagent
npm run build:nsis     # 仅 PC 安装包
npm run sync:updates   # 可选：同步到 updates-published/ 供本机静态服测试
```

产物目录 `dist/`：

| 文件 | 用途 |
|------|------|
| `dieyunagent-Setup-<version>.exe` | NSIS 安装包 |
| `dieyunagent-Setup-<version>.exe.blockmap` | 增量更新 blockmap |
| `latest.yml` | 桌面端更新清单 |
| `mobile/mobile-latest.json` | 手机端更新清单 |
| `mobile/dieyun-mobile-<version>.apk` | 手机端安装包 |

客户端内置更新源与 `package.json` → `build.publish.url` 一致，默认 **`http://192.168.31.62:3099/`**（`UPDATE_URL` 可覆盖）。

#### 只发布已有产物

当 `dist\latest.yml` 与匹配安装包已经存在时，可以只执行发布：

```bat
scripts\publish-updates-to-y.bat
node scripts\upload-updates-cos.mjs
```

`publish-updates-to-y.bat` 会清空 `Y:\client-electron\updates-published\` 下旧文件，再复制当前版本产物，避免目录里残留多版本清单导致客户端拉错包。`upload-updates-cos.mjs` 上传成功后同样会删除 COS 上旧版 `dieyunagent-Setup-*.exe` / `.blockmap` 和 `dieyun-mobile-*.apk`，只保留本次上传的最新版（`optional/` 与 `latest.yml` 不动）。需要保留历史包时设 `COS_KEEP_OLD=1`。

#### 本地更新联调

本地开发可不必映射 Y:，用 `sync:updates` + `serve:updates` 即可：

```bash
npm run sync:updates
npm run serve:updates
```

---

## 相关文档

- [README.md](../README.md) — 安装与监控上报

---

## 修订记录

| 日期 | 版本 | 说明 |
|------|------|------|
| 2026-06-20 | v1.3.82 | 更新为 `build-installer.bat` 统一发布流程 |
| 2026-05-21 | v1.3.18 | 补充 Y: 映射与 `publish-updates-to-y.bat` 每次发版流程 |

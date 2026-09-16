# 叠云 Agent 架构手册

> **产品名**：叠云 Agent（npm 包名 `dieyunagent` / `pixel-office-agent`）
> **文档类型**：架构说明 · 可打印版源稿
> **建议打印**：在浏览器中打开 [`ARCHITECTURE.print.html`](./ARCHITECTURE.print.html)，等待图表渲染完成后，选择 A4、双面、页边距「默认」或「窄」进行打印或导出 PDF。
> **关联文档**：[`DESIGN.md`](./DESIGN.md)（设计原理）· [`AGENT-STRATEGY.md`](./AGENT-STRATEGY.md)（Agent 策略分层 · 开放设计）· [`MEMORY.md`](./MEMORY.md)（记忆）· [`DEVELOPMENT.md`](./DEVELOPMENT.md)（开发发版）

---

## 目录

1. [概述](#1-概述)
2. [总体架构](#2-总体架构)
3. [进程与启动链](#3-进程与启动链)
4. [本地 Gateway](#4-本地-gateway)
5. [Agent 执行](#5-agent-执行)
6. [dieyun-core（Rust Sidecar）](#6-dieyun-corerust-sidecar)
7. [记忆系统](#7-记忆系统)
8. [渲染进程 UI 模块](#8-渲染进程-ui-模块)
9. [技能、MCP 与插件](#9-技能mcp-与插件)
10. [SSH 与远程工作空间](#10-ssh-与远程工作空间)
11. [浏览器自动化](#11-浏览器自动化)
12. [定时任务（Plans）](#12-定时任务plans)
13. [自动更新与打包](#14-自动更新与打包)
15. [代码库索引](#15-代码库索引)
16. [附录：目录速查与数据路径](#16-附录目录速查与数据路径)

---

## 1. 概述

叠云 Agent 是一个 **本地优先的桌面 AI Agent**：

- 用户在 Electron 窗口里对话；
- 模型可调用本机工具（读写文件、执行命令、查库、联网等）；
- 复杂任务走 **规划师 + 多子 Agent + Git Worktree 隔离**；
- 对话、技能、计划任务围绕同一套「模型设置 + Gateway」运转。

**一句话架构**：Electron 主进程负责「系统能力与安全边界 + Rust sidecar 编排」，渲染进程负责「Agent UI 与 Gateway 客户端」，本地 Gateway 用 WebSocket + RPC 桥接工具与记忆；复杂 Agent/Planner 循环在 **`dieyun-core`（Rust）**，LLM 与工具执行由 **Node 主进程** 委托。

### 1.1 核心设计取舍

| 话题 | 选择 | 原因 |
|------|------|------|
| Gateway 协议 | 自研 WebSocket RPC | 轻量、与 Electron 解耦 |
| 智能主路径 | 渲染进程 UI + Main/Rust 循环 | UI 迭代快；状态机在 Rust |
| 路径安全 | 白名单 | 用户选工作空间即授权 |
| 复杂任务 | Planner + worktree | 并行与隔离 |
| 简单任务 | 单 Agent Rust loop | 省规划延迟 |
| 记忆存储 | Rust SQLite（唯一写入路径） | 一致性与性能 |
| 定时任务 | 单次 LLM，无工具循环 | 可预测、低成本 |

### 1.2 安全模型

- `contextIsolation: true`，`nodeIntegration: false`——页面 JS 不能直接 `require`。
- 特权操作必须经 **preload IPC** 或 **Gateway RPC**。
- Gateway 只监听 **127.0.0.1**，带 **token 鉴权**。
- 文件/命令能力靠 **路径白名单 + 权限开关**。

---

## 2. 总体架构

```mermaid
flowchart TB
  subgraph Client["叠云 Agent 桌面端"]
    subgraph Renderer["渲染进程 renderer/"]
      UI[对话 / 设置 / 产物 / 终端 UI]
      GWClient[gatewayCall WebSocket 客户端]
      AgentUI[agent-loop / planner 路由]
      UI --> AgentUI
      AgentUI --> GWClient
      AgentUI -->|IPC| Preload
    end

    subgraph Preload["preload.js"]
      Bridge[window.diecloud contextBridge]
    end

    subgraph Main["主进程 main-entry.js"]
      IPC[IPC 处理器]
      Coord[AgentRunCoordinator]
      ToolBridge[tool-bridge-main]
      PlannerRun[planner-runner-main]
      Compaction[compaction-main]
      GitWT[worktree-service]
      Plans[PlansScheduler]
      BrowserSvc[BrowserView 控制器]
      SSH[SshSessionManager]
      CoreBridge[core-bridge stdio]
      LocalGW[LocalGateway server]
    end

    subgraph Core["dieyun-core.exe Rust sidecar"]
      AgentSM[agent.loop 状态机]
      PlannerSM[planner.run 状态机]
      MemRust[memory SQLite]
      CompRust[compaction]
      IndexRust[codebase 索引]
    end
  end

  subgraph External["外部依赖"]
    LLM[OpenAI 兼容 LLM API]
    MCP[MCP 服务器]
    Update[COS / 内网更新服]
    Remote[SSH 远程主机]
  end

  Renderer --> Preload --> IPC
  IPC --> Coord
  IPC --> PlannerRun
  IPC --> Compaction
  IPC --> GitWT
  IPC --> BrowserSvc
  IPC --> SSH
  CoreBridge --> Core
  PlannerRun --> CoreBridge
  IPC --> CoreBridge
  ToolBridge --> LocalGW
  ToolBridge --> MCP
  GWClient -->|127.0.0.1:17330 + token| LocalGW
  LocalGW --> CoreBridge
  LocalGW --> MemRust
  Main -->|HTTP| LLM
  SSH --> Remote
  Main --> Update
```

### 2.1 三层职责

| 层 | 目录 | 职责 |
|----|------|------|
| **Renderer** | `src/renderer/` | 聊天气泡、输入、Plan 进度、Gateway 客户端、工具 UI 委托 |
| **Main** | `src/main-entry.js`、`src/agent/` | 窗口/托盘、IPC、Worktree、LLM HTTP、Rust 桥、计划调度 |
| **Gateway** | `src/gateway/` | 工具 RPC、权限、路径白名单、桥接 Rust memory |
| **Rust** | `crates/dieyun-core/` | Agent/Planner 状态机、SQLite 记忆、压缩、索引 |

---

## 3. 进程与启动链

```mermaid
flowchart LR
  mainjs["main.js"] -->|正常启动| entry["main-entry.js"]
  mainjs -->|--update-bootstrap| bootstrap["update-bootstrap/"]
  entry --> preload["preload.js"]
  entry --> gw["gateway/server.js"]
  entry --> core["core-bridge → dieyun-core"]
  preload --> html["renderer/index.html"]
  html --> modules["renderer-*.js 模块链"]
  modules --> rjs["renderer.js 总线"]
```

| 文件 | 作用 |
|------|------|
| `src/main.js` | 极薄路由：正常应用或更新引导 |
| `src/main-entry.js` | Electron 应用主体：窗口、托盘、IPC、Gateway、更新、计划 |
| `src/preload.js` | `contextBridge` 暴露 `window.diecloud` |
| `src/renderer/index.html` | UI 壳，按序加载各 renderer 模块 |
| `src/renderer/renderer.js` | UI 总线与 Gateway 客户端入口 |

### 3.1 Rust 能力开关（环境变量）

| 变量 | 含义 |
|------|------|
| `DIEYUN_CORE=0` | 禁用 sidecar（Agent/Plan 不可用） |
| `DIEYUN_CORE_BIN` | 开发时指定 debug 二进制路径 |

---

## 4. 本地 Gateway

实现：`src/gateway/server.js` + `src/gateway/rpc.js`

### 4.1 连接协议（v1）

1. WebSocket 连接 `127.0.0.1:17330`（可用 `DIECLOUD_GATEWAY_PORT` 改端口）。
2. 首包 `{ type: 'auth', token }`，token 存于 `%APPDATA%/pixel-office-agent/gateway-token.txt`。
3. 之后 `{ type: 'call', id, method, params }` → `{ type: 'result', id, ok, data|error }`。

渲染进程封装：`gatewayCall(method, params)`（`renderer-gateway.js`）。

```mermaid
flowchart TB
  subgraph GW["本地 Gateway src/gateway/"]
    Server["server.js WebSocket :17330"]
    RPC["rpc.js 方法分发"]
    Host["host-control.js 路径/命令"]
    PathPol["path-policy.js 白名单"]
    Web["web-fetch.js SSRF 防护"]
    RemoteFS["remote-fs.js SSH 文件"]
    ProjMem["project-memory.js"]
  end

  WS[渲染进程 gatewayCall] -->|auth + call| Server
  Server --> RPC
  RPC --> Host
  RPC --> Web
  RPC --> RemoteFS
  RPC --> CoreMem["requireRustCore memory.*"]
  Host --> PathPol
  CoreMem --> SQLite[(diecloud-memory.sqlite)]
```

### 4.2 RPC 命名空间

| 前缀 | 职责 |
|------|------|
| `permissions.*` | 读/写/执行/SQL/联网开关 |
| `memory.*` | 会话、消息、长期记忆、每会话工作空间 |
| `compaction.*` | 上下文 token 估算与压缩 |
| `fs.*` | 白名单内读写列目录 |
| `host.*` | Shell、打开 URL |
| `web.*` | HTTP fetch、搜索（SSRF 防护） |
| `sql.*` | 可选 SQL Server 只读查询 |

### 4.3 工作空间（两层，勿混）

1. **Gateway 全局 `workspaceRoot`**（`userData/workspace.json`）——决定 `fs_*` / `host_exec` 的默认 cwd。
2. **每会话 `workspace_path`**（SQLite `sessions` 表）——切换历史对话时 `applySessionWorkspace()` 写回 Gateway。

**读根**：gateway-readable、userData、`~/.dieyun`、技能目录、工作空间等。
**写根**：更窄——gateway-readable、`~/.dieyun/skills`、当前工作空间。

---

## 5. Agent 执行

入口：`renderer-agent-loop.js` 的 `runAgentCompletion()`。

> 发送前 `taskTier` 只走结构信号（路径/选区/@Codebase），护栏数字在 `agent-limits`。详见 [AGENT-STRATEGY.md](./AGENT-STRATEGY.md)。

```mermaid
flowchart TB
  subgraph Renderer["渲染进程"]
    Send["runAgentCompletion()"]
    Mode{模式?}
    Send --> Mode
    Mode -->|agent| RustLoopIPC["IPC agent:rust-loop-run"]
    Mode -->|plan| PlannerIPC["IPC planner-run"]
  end

  subgraph Main["主进程 src/agent/"]
    RustRunner["rust-loop-runner.js"]
    PlannerMain["planner-runner-main.js"]
    ToolBridge["tool-bridge-main.js"]
    Coordinator["coordinator.js"]
    SubStore["subagent-store 检查点"]
    CompMain["compaction-main.js"]
  end

  RustLoopIPC --> RustRunner
  PlannerIPC --> PlannerMain
  RustRunner --> CoreLoop["Rust agent.loop.*"]
  PlannerMain --> CorePlan["Rust planner.run.*"]
  CoreLoop -->|need_llm| LLM[LLM HTTP]
  CoreLoop -->|need_delegate| ToolBridge
  CorePlan -->|各阶段| LLM
  CorePlan -->|explore/worker| RustRunner
  ToolBridge --> GW[Gateway RPC]
  ToolBridge --> MCP[MCP]
  ToolBridge --> UITool[Renderer 工具委托]
  PlannerMain --> Git["worktree-service"]
  PlannerMain --> Coord[Coordinator 消息总线]
```

### 5.1 单 Agent 工具循环（时序）

```mermaid
sequenceDiagram
  participant R as Renderer
  participant M as Main
  participant C as dieyun-core
  participant L as LLM API
  participant G as Gateway

  R->>M: agent:rust-loop-run
  M->>C: agent.loop.start
  C-->>M: need_llm
  M->>L: chat/completions stream
  L-->>M: content / tool_calls
  M->>C: agent.loop.continue
  C-->>M: need_delegate
  M->>G: tool-bridge 执行工具
  M->>C: agent.loop.tool_results
  C-->>M: done
  M-->>R: content + trace
```

要点：

- Rust **只负责循环状态机**；**LLM HTTP 在 Main**。
- 工具全部 `need_delegate` → `tool-bridge-main.js`。
- 压缩：`compaction-main.js` 在每轮 LLM 前可压缩 messages。
- 无 silent 回退 JS loop；sidecar 不可用则报错。

### 5.2 Planner 编排

触发：`getComposerAgentMode() === 'plan'`，或可恢复检查点。

```mermaid
flowchart LR
  Start[planner.run.start] --> Plan[need_plan_llm]
  Plan --> Explore[need_explore_loop]
  Explore --> Workers[need_workers]
  Workers --> BestN[need_best_of_n 可选]
  BestN --> Review[need_review_llm]
  Review --> Retry[need_retry_workers 可选]
  Retry --> Synth[need_synthesize_llm]
  Synth --> Done[done]

  Workers --> WT[".dieyun/worktrees/{runId}/{workerId}"]
  Done --> Preview[用户确认合并到工作区]
```

| 阶段 | agentType | 工具集 | 目的 |
|------|-----------|--------|------|
| Explore | explore | 只读 fs / 搜索 | 摸清代码库 |
| Shell | shell | 命令执行 | 构建、脚本 |
| Build | build | 读写 fs + 执行 | 改代码 |

**Worker 隔离**：Git 仓库下每个 Worker 在独立 worktree + 分支（`src/git/worktree-service.js`）。
**检查点**：`~/.dieyun/agent-checkpoints/{runId}.json`。
**后台运行**：`sessionActiveRuns` 允许切换会话后原 Agent 继续跑。

### 5.3 主进程协调器

`src/agent/coordinator.js`：run / task 队列、超时、取消、消息总线。
Planner 子 Agent 通过 coordinator 按 `toRole` 投递（`message-bus.js`）。

---

## 6. dieyun-core（Rust Sidecar）

`crates/dieyun-core`，经 `src/core-bridge.js` **stdio 行 JSON-RPC** 通信。

```mermaid
flowchart TB
  subgraph Crate["crates/dieyun-core/"]
    RPCio["rpc/stdio JSON-RPC"]
    Agent["agent/ loop_run + tools"]
    Planner["planner/ run + plan_parse"]
    Memory["memory/ SQLite store"]
    Compaction["compaction/ tokens + LLM 摘要"]
    Index["index/ walker + search + embedding"]
    Embed["embedding/ builtin + remote"]
    FS["fs_ops"]
  end

  Bridge["core-bridge.js spawn"] <-->|stdio| RPCio
  RPCio --> Agent
  RPCio --> Planner
  RPCio --> Memory
  RPCio --> Compaction
  RPCio --> Index
  Index --> Embed
```

| RPC 前缀 | 职责 |
|----------|------|
| `agent.loop.*` | 单 Agent 工具循环状态机 |
| `agent.ping` | 能力探测 |
| `planner.run.*` | Planner 编排状态机 |
| `memory.*` | SQLite 会话/消息/长期记忆/向量 |
| `compaction.*` | token 预算、原子块折叠、摘要 |
| `codebase.*` | 工作区索引与语义搜索 |

打包：`npm run pack:dieyun-core` → `build/dieyun-core/dieyun-core.exe`。

---

## 7. 记忆系统

存储：`crates/dieyun-core/src/memory/` → `%APPDATA%/pixel-office-agent/diecloud-memory.sqlite`（WAL）。

**唯一写入路径**：Gateway `requireRustCore('memory.*')`；sidecar 未就绪则 RPC 抛 `RUST_CORE_UNAVAILABLE`。

```mermaid
flowchart TB
  subgraph Write["写入"]
    ChatMsg[对话消息] --> GWmem[memory.message_append]
    LongMem[长期记忆] --> GWlong[memory.long_add]
    GWmem --> RustMem
    GWlong --> RustMem
  end

  subgraph RustMem["Rust MemoryStore"]
    Sessions[(sessions)]
    Messages[(messages)]
    Long[(long_memories)]
  end

  subgraph Read["读取 / 注入"]
    Recent[messages_recent] --> Render[重绘聊天]
    Recall[long_recall / keyword_search] --> Prompt[system prompt]
    Vector[向量语义召回] --> Prompt
  end

  RustMem --> Sessions
  RustMem --> Messages
  RustMem --> Long
```

### 7.1 表结构（逻辑）

| 表 | 用途 |
|----|------|
| `sessions` | 会话元数据：title、archived、workspace_path |
| `messages` | 短期对话：user / assistant / system |
| `long_memories` | 长期笔记式记忆 |

### 7.2 会话生命周期

- 当前会话 ID：`localStorage` `diecloud.active.session.v1`。
- 列表：`memory.sessions_list`（有消息的会话才显示）。
- 切换会话：拉 `messages_recent` 重绘 + 恢复工作空间与滚动位置。

详见 [`MEMORY.md`](./MEMORY.md)。

---

## 8. 渲染进程 UI 模块

```mermaid
flowchart TB
  subgraph Shell["壳层"]
    HTML[index.html]
    CSS[styles.css]
    Theme[renderer-theme*.js]
    Layout[renderer-pane-layout.js]
  end

  subgraph Chat["对话"]
    History[renderer-chat-history.js]
    Render[renderer-chat-render.js]
    State[renderer-chat-state.js]
    Composer[renderer-composer*.js]
    Loop[renderer-agent-loop.js]
    Trace[renderer-thinking-trace.js]
  end

  subgraph Side["侧栏 / 面板"]
    SkillsUI[renderer-skills-ui.js]
    Artifacts[renderer-artifacts.js]
    Changes[renderer-changes-pane.js]
    Terminal[renderer-terminal.js]
    BrowserUI[renderer-browser.js]
    SSHui[renderer-workspace-ssh.js]
  end

  subgraph Config["配置"]
    Model[renderer-model-settings.js]
    MCP[renderer-mcp-catalog.js]
    Perms[renderer-permissions.js]
    Components[renderer-components.js]
  end

  HTML --> Chat
  HTML --> Side
  HTML --> Config
  Loop --> Gateway[renderer-gateway.js]
```

### 8.1 脚本加载顺序（节选）

1. `renderer-context-engine.js` — 上下文拼装
2. `renderer-agent-api.js` / `renderer-agent-loop.js` — Agent IPC 入口
3. `renderer-chat-render.js` / `renderer-chat-history.js` — 聊天渲染与会话
4. `renderer.js` — UI 总线

---

## 9. 技能、MCP 与插件

```mermaid
flowchart TB
  subgraph Bundled["安装包 skills/bundled/"]
    MiniMax[minimax]
    Curated[curated]
    Dieyun[dieyun 预装]
    Weather[weather]
  end

  Bundled -->|seed 首次复制不覆盖| Home["~/.dieyun/skills/"]
  Home --> Scan[skills/scanner.js]
  Scan --> Catalog[skills/catalog.js]
  Catalog --> Prompt[buildSkillsPrompt → system]
  VectorIdx[skills/vector-index.js] --> Recall[按需召回]

  subgraph MCPmod["MCP src/mcp/"]
    Registry[registry + catalog]
    Bundled[servers/dieyun-open-api 随包]
    Runtime[runtime-manager]
    Creds[credentials-store]
  end

  Bundled --> Runtime
  Runtime --> Tools[Agent 工具列表]

  subgraph Plugins["plugins/"]
    Loader[loader.js]
    Host[host.js]
  end
```

- **Bundled**：随安装包（`extraResources`）。
- **Seed**：`seed-to-dieyun.js` 复制到用户目录，已存在不覆盖。
- **启用状态**：`localStorage` `diecloud.skills.enabled.v1` 等。
- **技能本质**：主要是 system prompt 知识；部分解锁工具（如天气）。
- **预装 MCP**：`src/mcp/registry.js`；`bundledServer`（如 `dieyun-open-api`）随 asar 打包，用 `ELECTRON_RUN_AS_NODE` 启动，密钥走环境变量。

---

## 10. SSH 与远程工作空间

```mermaid
flowchart TB
  UI[renderer-workspace-ssh.js] -->|IPC| SSHMgr[ssh/session-manager.js]
  SSHMgr --> Creds[credentials-store]
  SSHMgr --> Tunnel[tunnel / port-forward]
  SSHMgr --> RemoteGW[remote-gateway-manager.js]
  RemoteGW -->|部署 pack| RemoteHost[远程 Linux 主机]
  RemoteGW --> RemoteAgent[remote-gateway-pack]

  GWremote[gateway/remote-fs.js] --> SSHMgr
  GWremote --> PathPol[remote-path.js]
  IndexRemote[remote-index-transport.js] --> CoreIndex[Rust codebase 远程索引]
```

远程路径约束在 `ssh/remote-path.js`；工作空间 URI 形如 `ssh://user@host/path`。

---

## 11. 浏览器自动化

```mermaid
flowchart LR
  Tool[browser_* 工具] --> Svc[browser/service.js]
  Svc --> Ctrl[controller.js BrowserView]
  Svc --> PW[playwright-runner.js]
  Ctrl --> URLPol[url-policy.js]
  Ctrl --> Snap[snapshot-script]
  RendererUI[renderer-browser.js] -->|browser:state IPC| Ctrl
```

内嵌 `BrowserView`，仅允许 http/https；快照与点击坐标脚本在 `browser/snapshot-script.js`。

---

## 12. 定时任务（Plans）

```mermaid
flowchart LR
  UI[技能弹窗 / plan_create] --> Store[plans/store → plans.json]
  Scheduler[plans/scheduler.js RRULE] --> Runner[plans/runner.js 单次 LLM]
  Runner --> Deliver[plans/deliver.js → 指定会话]
  Parser[plans/parser.js] --> Store
```

| 对比 | 对话 Agent | 定时任务 Plans |
|------|------------|----------------|
| 入口 | 主聊天 | 技能弹窗 / 工具 |
| 执行 | 多轮工具循环 | **单次** LLM |
| 存储 | SQLite messages | `userData/plans.json` |
| 投递 | 当场显示 | 写入 `deliver.sessionId` 会话 |

---

## 14. 自动更新与打包

```mermaid
flowchart LR
  BuildAll[build-installer.bat] --> PC[electron-builder NSIS]
  BuildAll --> Mobile[Android APK]
  PC --> Dist[dist/ latest.yml + Setup.exe]
  Mobile --> DistMobile[dist/mobile/ mobile-latest.json + apk]
  Dist --> Y[Y: 内网 updates-published]
  Dist --> COS[腾讯云 COS]
  DistMobile --> Y
  DistMobile --> COS
  Client[electron-updater] -->|UPDATE_URL| Y
  Client -->|下载完成| Bootstrap[update-bootstrap/ 静默安装]
```

| 步骤 | 命令 / 路径 |
|------|-------------|
| 一键打包发布 | `build-installer.bat`（输入版本号，构建 PC + 手机，发布 Y: + COS） |
| 仅 PC 打包 | `npm run build:nsis` |
| 仅内网发布 | `scripts\publish-updates-to-y.bat` |
| 仅 COS 上传 | `node scripts\upload-updates-cos.mjs` |
| 可选资源上传 | `npm run upload:optional-cos` |
| 默认更新 URL | `http://192.168.31.62:3099/`（`main-entry.js`） |

---

## 15. 代码库索引

```mermaid
flowchart TB
  UI[索引触发 / Agent 搜索] --> GWcode[Gateway codebase.* / graph.*]
  GWcode --> RustIdx[Rust index + treesitter]
  GWcode --> RustGraph[Rust graph build + query]
  RustIdx --> Embed[embedding builtin BGE / remote]
  RustIdx --> SQLiteIdx[(索引 SQLite)]
  RustGraph --> SQLiteGraph[(图 SQLite)]
  LSP[Gateway LSP enrich] -->|standing job| SQLiteGraph
  NodeHelper[codebase/index-service.js] -->|远程采集常量| Remote
```

### 15.1 Codebase 文本索引

- `codebase.*` 仅 Rust 实现；Node 侧 `index-service.js` 保留远程采集辅助。
- 切块优先 **Tree-sitter**（JS/TS/Python/Go/Rust 按函数/类边界）；失败回退行窗（`CHUNK_LINES` / overlap）。
- 单仓库文件上限 **16000**；`codebase.search` 结果上限 **48**。
- 向量检索：≤2500 条精确余弦；更大库走 **FTS 候选重打分 + 分层模量采样**（`embedding/ann.rs`），不依赖 sqlite-vec / 原生 HNSW 扩展。

### 15.2 代码图谱

- 构建：`graph.index` / `graph.index.start`，AST 抽取符号、import、call（与 codebase 同语言范围）。
- 查询：`graph.symbols`、`graph.callers` / `callees`、`graph.repo_map`（枢纽文件/符号 + markdown 摘要）。
- Agent 准备上下文时注入「仓库结构图」；后台可 kick `graph.lsp_enrich`（冷却约 10 分钟）用 LSP 补全 callers。
- 符号向量检索与 codebase 共用 ANN 分层策略；单次语义结果上限 **80**。

---

## 16. 附录：目录速查与数据路径

### 16.1 源码目录

| 路径 | 内容 |
|------|------|
| `src/main-entry.js` | 主进程中枢 |
| `src/gateway/` | 本地 RPC 服务 |
| `src/agent/` | Agent / Planner / 工具桥 / 压缩 |
| `src/renderer/` | 全部 UI 模块 |
| `crates/dieyun-core/` | Rust sidecar |
| `skills/bundled/` | 预装技能 |
| `src/ssh/` | 远程 SSH 工作空间 |
| `src/plans/` | 定时任务 |
| `src/browser/` | 内嵌浏览器自动化 |
| `src/update-bootstrap/` | 更新安装引导 |
| `src/mcp/` | MCP 运行时 |
| `src/plugins/` | 插件宿主 |
| `src/lsp/` | 语言服务诊断 |
| `src/git/worktree-service.js` | Planner Worker 隔离 |

### 16.2 运行时数据路径

| 路径 | 内容 |
|------|------|
| `%APPDATA%/pixel-office-agent/` | userData：Gateway DB、权限、workspace、plans、更新 token |
| `~/.dieyun/` | skills、memory 笔记、默认 workspace、dieyun.md、checkpoints |
| `~/.dieyun/workspace/` | 未选工作空间时的默认可写目录 |
| `dist/` | 打包输出 |
| `Y:\client-electron\updates-published` | 内网更新静态文件 |

---

*文档版本：与仓库 `package.json` 同步维护 · 生成目的：A4 打印成册*

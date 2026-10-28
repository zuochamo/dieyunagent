# 叠云 Agent 开发文档

本文档记录版本规划与发版流程。产品名：**叠云 Agent**（npm 包名 `dieyunagent`）。

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

- 无边框主界面、设置弹窗（模型 / 主题）
- 模型设置：**文本模型**、**多模态模型** 子标签；配置存 `localStorage`（`diecloud.model.settings.v1`）
- 本地 Gateway（loopback）、技能、本机控制工具
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

#### 离线预装的 MCP（内网可用性）

`mcp-postgres`（PostgreSQL 只读）是**离线预装**：npm 包与平台二进制在构建期取好、随安装包分发到
`<resources>/mcp/bundled/mcp-postgres`，运行时既不 `npm install` 也不从 GitHub Releases 下载。
原因是该包默认在**首次使用时**才下载平台二进制，且用的是 Node `fetch` —— 内网不可达，企业 TLS
代理下即使「有网」也会 `fetch failed`（本机实测：curl 200 / Node fetch 失败）。

```bash
npm run pack:mcp-bundled     # 取产物 + 校 sha256 → build/mcp-bundled/
npm run verify:mcp-bundled   # 打包后校验安装包内产物与 registry 锁定版本/校验和一致
```

- 包名与版本的唯一来源是 `src/mcp/registry.js` 的 `mcp-postgres` 条目（`-y postgres-mcp-hardened@<ver>`），
  sha256 的唯一来源是该 npm 包自带的 `checksums.json`；**勿在别处再写一份版本或校验和**。
- 断网/内网构建：把 `postgres-mcp-hardened-<ver>.tgz` 与
  `postgres-mcp-hardened-x86_64-pc-windows-msvc.zip` 放进 `build/.cache/` 后重跑即可跳过下载（仍校 sha256）。
- `npm run dev` / `start` 会先执行 `scripts/ensure-mcp-bundled.cjs`；取不到产物只告警不阻断
  （该 MCP `defaultEnabled: false`，属可选能力）。
- 目前只做 Windows x64；新增平台改 `scripts/pack-mcp-bundled.cjs` 的 `TARGETS` 并确认随对应安装包分发。

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

## Rust 依赖升级约定（`crates/dieyun-core`）

**工具链**：`edition = "2024"`、`rust-version = "1.90"`（在根 `Cargo.toml` 的
`[workspace.package]` 声明，crate 用 `.workspace = true` 继承）。

**升级分两档，别混在同一个提交里**：

| 档位 | 命令 | 判据 |
|------|------|------|
| 补丁 / 次版本（semver 内） | `cargo update` | 跑 `cargo test -p dieyun-core --lib` 全绿即可 |
| 主版本 / 预发布跨段 | 手改 `Cargo.toml` 版本号 | 需单独评估 API 变更 + 预下载产物，见下 |

**已完成的升级（2026-10）**：`rusqlite 0.32 → 0.41`（`libsqlite3-sys` 0.39，FTS5 trigram 与
`auto_vacuum` 行为已由测试覆盖）、`tree-sitter 0.24 → 0.27` + `tree-sitter-javascript/python/go → 0.25`、
`base64 0.22 → 0.23`、`sha2 0.10 → 0.11`。

**升级 `tree-sitter` 时必须先跑 `treesitter::lang::tests::every_language_parses_a_minimal_sample`。**
该测试是护栏：grammar 的 ABI 超出 `tree-sitter` 支持范围时 `set_language` 会失败、
`parse_source` 返回 `None`，整条 AST 抽取就**静默**退回正则启发式 —— 表现是「符号还在、
跨文件边和调用边全没了」。`tree-sitter-rust 0.24.2` 配 `tree-sitter 0.24` 就是这个状态：
Rust 从来没走过 AST 路径，`mod util;` 的模块边一直是正则兜出来的。升到 0.27 后 AST 才真正生效，
`collect_rust` 也补上了 `mod_item`（无 body）→ 模块依赖 import（`mod:` spec 约定）。

**两个暂时固定在旧版的（各有硬理由，不要盲目 `cargo update`）**：

| crate | 固定值 | 为什么 |
|-------|--------|--------|
| `ort` | `=2.0.0-rc.12` | `download-binaries` 在 build script 里联网取 ONNX Runtime；升 rc.15 时下载会长时间卡住并**一直持有构建目录锁**（所有 `cargo build` 停在 `Compiling ort-sys`、CPU 为 0）。要升先把预下载产物放进缓存/CI。 |
| `reqwest` | `0.12` | 0.13 的 `rustls` 特性默认走 `aws-lc-rs`，它需要 `cmake` + NASM 才能构建（本机与打包机都没有）；改 `rustls-no-provider` 要在运行时装 crypto provider，改 `native-tls` 会让 Linux 产物多一条 OpenSSL 依赖。0.13 把 `rustls-tls` 特性名也改成了 `rustls`。 |

**不要随手跑 `cargo fmt`。** 仓库现有代码按旧 rustfmt 排序（`{json, Value}`），
edition 2024 的 import 排序规则会把它改成 `{Value, json}` —— 一次 `cargo fmt`
会产生整仓无关 diff。要格式化就只格式化自己新增的文件。

---

## 相关文档

- [README.md](../README.md) — 安装与监控上报

---

## 修订记录

| 日期 | 版本 | 说明 |
|------|------|------|
| 2026-06-20 | v1.3.82 | 更新为 `build-installer.bat` 统一发布流程 |
| 2026-05-21 | v1.3.18 | 补充 Y: 映射与 `publish-updates-to-y.bat` 每次发版流程 |

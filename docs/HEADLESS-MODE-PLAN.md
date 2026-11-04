# 无界面运行方案（headless / 终端 / Web）

> 状态：**P0–P5 已实施**（`npm run headless` 可跑；`npm run pack:deb:headless` 产出 `dist/dieyun-headless_<ver>_amd64.deb` 与 tgz，安装与排障见 [`docs/HEADLESS.md`](HEADLESS.md)）
> 目标：让同一套 Agent 能在 Linux 服务器上用纯 Node 跑起来 —— 没有窗口、没有 Electron 渲染进程，入口为**终端 REPL**、**一次性命令**和**浏览器 Web UI**。
> 实测记录见 §11。

---

## 1. 结论

三条事实决定了这个方案的做法：

1. **Agent 循环本来就不需要 UI** —— `src/channels/agent-turn.js`（企业微信）与 `src/plans/plan-agent-runner.js`（定时计划）已经在 Main 里跑完整一轮：模型解析、系统提示、工具、压缩、落库、记忆归纳，全部不经过 Renderer、不要窗口、不抢焦点。
2. **Web 前端已经存在** —— `src/mobile/bridge.js` + `src/mobile/public/` 是现成的「浏览器 ↔ Main 会话」前端与线协议（HTTP 静态 + WS + token）；它只依赖 `AgentService` 的方法与事件。
3. **`AgentService` 只差一个「谁跑这一轮」的实现** —— 现在只有 `desktopExecutor`（转发给 Renderer），没注入就报 `DESKTOP_EXECUTOR_UNAVAILABLE`。

所以方案是**补一个进程入口 + 一个本地执行器**，而不是新写一套 Agent/工具/会话：

```
                    ┌──────────────── src/headless/main.js（纯 Node）────────────────┐
 终端 REPL ────────▶│                                                            │
 一次性 run ───────▶│  AgentService ──executor──▶ local-executor ──▶ runMainTurn   │
 浏览器 (Web UI) ──▶│      ▲                          │                 │           │
                    │      │                    progressTask/        runRustAgentLoop│
                    │  MobileBridge                completeTask           │           │
                    │      │                          │            coreBridge(RPC)   │
                    │  LocalGateway ◀─────── tool bridge ◀───────────────┘           │
                    │      │                     (fs / host_exec / web / MCP)        │
                    └──────┼─────────────────────────────────────────────────────────┘
                           └─▶ dieyun-core sidecar（同一份 Rust 循环账本 / memory / index）
```

**不做**：不新写第二套 Agent 循环、不新写第二套 Web 前端、不新写任务执行器接口、不加「无窗口能力开关表」。

---

## 2. 目标形态（CLI 契约）

```bash
# 常驻 + 浏览器前端（服务器主用法）
dieyun-headless serve --workspace /srv/repo --web --host 127.0.0.1 --port 17331

# 一次性（cron / CI / 管道）
dieyun-headless run "把 README 第一段总结成一句话" --workspace /srv/repo --json

# 交互终端
dieyun-headless repl --workspace /srv/repo

# 无网络自检（部署验收 / CI）
dieyun-headless self-test
```

| 参数 | 默认 | 说明 |
|---|---|---|
| `--workspace <dir>` | `~/.dieyun/workspace` | 本次运行的默认工作空间；会话创建时绑定 |
| `--user-data <dir>` | 按 `app-paths.resolveUserDataDir()` | 与桌面同一套目录规则（`DIEYUN_USER_DATA` 覆盖） |
| `--web` / `--host` / `--port` | 关 / `127.0.0.1` / `17331` | 起 `MobileBridge`；**默认只听本地**，暴露需显式 `--host 0.0.0.0` |
| `--sandbox <mode>` | 读 `host-permissions.json`，缺省 `workspace-write` | 三档沿用 `gateway/sandbox-policy.js` |
| `--plans` | 关 | 同时启动定时计划调度器（可选，见 §6.1） |
| `--model <name>` / `--route <supplier>` | 模型设置里的默认文本模型 | 显式覆盖，不做静默兜底 |
| `--json` | 关 | 每行一个事件（NDJSON），供脚本消费 |
| `--log-level` | `info` | `error` / `warn` / `info` / `debug` |

退出码：`0` 成功 · `2` 本轮无交付/失败 · `3` 配置缺失（无 API Key、core 未就绪） · `130` SIGINT。

环境变量：`DIEYUN_USER_DATA`、`DIEYUN_SECRET_KEY_FILE`（见 §5.6）、`DIEYUN_MOBILE_PORT/HOST`。

---

## 3. 明确不做（减法论证）

| 诱惑 | 为什么不做 |
|---|---|
| 让 headless 直接 `require('../channels/agent-turn.js')` | 它绑死频道 store、联系人会话映射、企微附件 URL 下载。参数化抽成 `main-turn-runner` 比「复制一份再改」代码更少，也避免两处漂移。 |
| 在服务器上 `xvfb-run electron .` | 只为了隐藏窗口而背整套 Chromium + 图形依赖；`safeStorage` 在无 keyring 的容器里不可用；审批弹窗依然无处可问。headless 把这三条正面解决。 |
| 另写一个 Web 前端 / 另一个 WS 协议 | `mobile/public` 已是唯一「浏览器 ↔ Main 会话」实现，服务器 Web 模式和手机端是同一件事。 |
| 与 `src/remote/run-cli.js`（远端 Agent daemon）合并 | 两者信任模型与职责不同：`run-cli.js` 是「桌面 IDE 伸到服务器的远端手」，由桌面 SSH 拉起、unix socket、**不含 LLM**；headless 自己拥有模型与循环。合并会把两套生命周期搅在一起。保持并存，文档写清边界。 |
| 新增「无窗口时禁用 XX 工具」开关表 | 现有行为已经定义好了：`requestToolFromRenderer` 无 webContents → 立刻失败；沙箱审批未注入 → fail-closed；`buildMainAgentTools` 本来就只给 Main 侧工具档。只在启动日志里如实打印能力边界。 |
| 新增第二套 trace 归约 | 复用 `src/plans/plan-run-events.js#createPlanRunTrace`（Main 侧唯一实现，只产出 thought / tools / streamContent 事实）。 |
| 新增第二套目录/凭据规则 | `app-paths.js` 导出目录解析单一来源；凭据走 `secret-store` 同一接口，只换 `safeStorage` 实现（见 §5.6）。 |

---

## 4. 实施阶段与改动清单

### P0 依赖解耦（不改桌面行为，先让纯 Node 能 require 到网关）

| 文件 | 改动 | 原因 |
|---|---|---|
| `src/app-paths.js` | `require('electron')` 从模块顶移进 `configure()`；新增导出 `USER_DATA_DIR` 与 `resolveUserDataDir({ env, platform, appDataDir })`（`DIEYUN_USER_DATA` 优先，其次 `<appData>/dieyunagent`），`configure()` 内部改用它 | 纯 Node 下顶层 require electron 直接崩；目录名必须仍是单一来源 |
| `src/agent/tool-bridge-main.js` | **已核实：无需改动** | 原打算给 `decodeNativeImage()` 的 `require('electron')` 加 try/catch，实施时发现它已在 `fitVisionShotToBudget` 的 try/catch 内（失败即返回 `null` → 原图入队）。无窗口不会走到视觉缩放，保持原样（减法）；真要注入解码器再加 `deps.decodeImage` |
| `src/agent/service.js` | `setDesktopExecutor/setDesktopCanceller` → `setExecutor/setCanceller`；错误码 `DESKTOP_EXECUTOR_UNAVAILABLE` → `EXECUTOR_UNAVAILABLE`，文案「任务执行器未连接」；补 docstring 说明两种实现（Renderer 转发 / Main 本地轮） | 「谁跑这一轮」不再等于桌面；改名是纠正职责而非顺手重构（调用点只有 `main-entry.js` 两处） |
| `src/main-entry.js` | 跟随改名：注入 Renderer 转发的 executor/canceller（行为不变） | 同上 |
| `src/agent/renderer-tool-delegate.js` | （一行）无窗口时 reject 的错误补 `e.code = 'RENDERER_UNAVAILABLE'` | 现在只有文案没有 errorCode，Web 端只能显示裸中文；补码后才能区分「服务器没有这项能力」与「工具真的失败」 |

验收：`npm run test:mobile`（AgentService 契约）、`npm run test:agent-run-events`、`npm test` 全绿；桌面聊天/手机端行为无变化。

### P1 抽出「Main 侧一轮」的唯一实现

| 文件 | 改动 |
|---|---|
| **新增** `src/agent/main-turn-runner.js` | 从 `channels/agent-turn.js` 搬出通用部分：`loadModelSettings`+`resolveTextApiConfig` → `applyTierRuntime`/`getEffectiveInputBudget` → `sysPack = prepSystemPrompt(...)`（`buildPrepSystemPromptDeps`）→ `memory.messages_recent` → `buildCompletionMessagesFromHistory` → `buildMainAgentTools(mcpRuntime)` + `extraTools` → `runRustAgentLoop({turnEndSynthesis:true, runSource})` → `persistableTurnText` 落库 → `memory.touch_session` → `knowledge-maintainer.afterAgentRun`。返回 `{ sessionId, content, trace, runId, readiness, aborted }`。**逻辑原样搬，不重写**。 |
| `src/channels/agent-turn.js` | 只留频道特有：store / `ensureChannelSession` / 联系人映射 / 附件 URL 下载与收件箱落地 / `session_set_workspace` 频道实现 / `notifySessionsChanged` / `channelTriggerMeta`；调 `runMainTurn`。净减代码。 |

验收：`npx vitest run test/unit/channels-turn.test.cjs test/unit/channels-runtime.test.cjs`、`npm run test:agent`。

### P2 headless 入口（终端）

| 文件 | 职责 |
|---|---|
| **新增** `src/headless/cli-args.js` | 参数解析与 `--help`（唯一入口，别在别处再 parse `process.argv`） |
| **新增** `src/headless/log.js` | 分级日志到 stderr，`[dieyun-headless]` 前缀（对齐 `docs/LOGGING.md`） |
| **新增** `src/headless/secret-storage.js` | 实现 `{ isEncryptionAvailable, encryptString, decryptString }`（Electron `safeStorage` 的同形替身，见 §6.3） |
| **新增** `src/headless/boot.js` | 装配（只调既有工厂，不复制逻辑）：`new LocalGateway({ userDataPath, readableDir, log, logDebug })` → `ensureAgentHomeDirs`/`ensureDieyunMdInHome` → `resolveDieyunCoreBinary()`/`isRustCoreEnabled()` + `createCoreBridge` + `setRustCore` → `createMcpStore({safeStorage})` → `bootMcpSkillCatalogs` → `createMcpManager({ ..., notifyCredentialRequest: null })` → `createMainToolBridge({ gateway, webContents:null, getMobileBridge: () => mobileBridge })` → `createMainCompactionAgent(userData, coreBridge)` → `new AgentService(...)` + `setExecutor(localExecutor)` → `localGateway.setWorkspace(workspace)`。所有可选依赖（browserService / peer / sshActions / worktreeActions）**不传**，工具层已有结构化降级 |
| **新增** `src/headless/local-executor.js` | `AgentService.executor` 的本地实现：`runMainTurn` 跑一轮，`createPlanRunTrace` 归约 phase → `progressTask({trace, streamContent})`，收尾 `completeTask({status})`；canceller = `AbortController.abort()` |
| **新增** `src/headless/main.js` | 生命周期：`serve` / `repl` / `run <text>` / `self-test` / `gen-key`；SIGINT/SIGTERM 有序关闭（mobile → gateway → core → mcp）；退出码 `0/2/3`；NDJSON 事件流（`--json`） |
| `package.json` | `"headless": "node src/headless/main.js"`、`"test:headless": "node scripts/test-headless-smoke.cjs"` |
| **新增** `scripts/test-headless-smoke.cjs` | 不联网 smoke：`--help` / 未知参数退出码 + `self-test`（起 Gateway + core、建会话、走工具桥列目录）；无 core 产物时跳过 |

### P3 Web 模式（已随 P2 落地）

- `boot.js` 在 `--web` 时：`new MobileBridge({ agentService, userDataPath, log })` + `start()`，把 URL + token 打进日志（`http://<host>:<port>/#token=…`）。
- **前端零改动**：`src/mobile/public/` 直接用；它消费的 `sessions.list` / `messages.list` / `task.submit` / `task.progress` / `trace.get` / `speech.*` 全部由 `AgentService` 提供，与桌面无关。
- 暴露策略：缺省只听 `127.0.0.1`（`MobileBridge` 自身默认是 `0.0.0.0`，headless 把它收紧）；显式 `--host 0.0.0.0` 时才对外，并在日志里警告「访问控制只有 URL token」。
- 可选后置项：`POST /api/task`（NDJSON 流），与 WS 同一套 `agentService` 调用，只为 curl/CI 方便；不新增执行路径。

### P4 运维与打包（已实施）

| 文件 | 内容 |
|---|---|
| **新增** `scripts/pack-headless.cjs` | 产出 `dist/dieyun-headless-<ver>-linux-x64.tgz` 与（`--deb`）`dist/dieyun-headless_<ver>_amd64.deb`：`bin/node`（复用 `scripts/lib/node-linux-runtime.cjs`，与远端 Agent 包同一份下载/解压实现）、`build/dieyun-core/dieyun-core`（**放这个位置是因为 `core-bridge-path` 的探测顺序里就有它，零配置**；复用 `pack:dieyun-core:linux` 产物并做 glibc 地板闸门）、`build/mcp-bundled/`（`pack:mcp-bundled` 产物）、`src/`、`assets/`、裁剪后的 `node_modules`、`bin/dieyun-headless` 包装脚本、`HEADLESS.md`、`manifest.json`；支持 `--no-node` / `--no-mcp` / `--offline` / `--deb` / `--verify-only` |
| **新增** `scripts/lib/tar-writer.cjs` | 打包专用的 ustar 写入器：权限位、uid/gid、mtime 由脚本决定（Windows 的 `tar` 会把文件写成 0666、目录 0777，打进 deb 就是 `/opt` 里一堆 world-writable，打进 tgz 就是「装完还得 chmod」）；同一份源码在 Windows / Linux 上打出的包逐字节一致 |
| **新增** `src/browser/electron-host.js` | 浏览器栈延迟取 Electron 的唯一入口（`requireElectron` / `electronOrNull`）。原因见下方「修正 3」 |
| **新增** `deploy/systemd/dieyun-headless.service` | `EnvironmentFile=/etc/dieyun/headless.env`、`DIEYUN_MOBILE_HOST=127.0.0.1`、`ExecStartPre=+chmod`（兜住用不保权限的工具解包）、`Restart=on-failure`、`PrivateTmp`/`NoNewPrivileges`；deb 直接装这份 |
| **新增** `docs/HEADLESS.md` | 安装（deb / tarball）、配置（env 文件 / 密钥 / model-settings）、参数与退出码、systemd、安全（token / host / 沙箱档位 / 凭据密钥）、排障表、升级回滚、与 `remote/run-cli.js` 的边界 |

deb 外壳（`npm run pack:deb:headless`）只做「分发」，不再复制一份 payload：

- 内容 = 同一份 payload + `/usr/bin/dieyun-headless`（一行转发脚本）+ systemd 单元 +
  `/etc/dieyun/headless.env.example` + `/usr/share/doc/dieyun-headless/HEADLESS.md`；
- `Depends: libc6 (>= 2.28)`（取 `manifest.json` 的 `glibcFloor`，不是手写常量）；
- `postinst` 幂等三件事：建 `dieyun` 系统用户与 `/var/lib/dieyun-agent`、`/srv/agent-workspace`；
  首次生成 `/etc/dieyun/secret.key`（**绝不覆盖**，覆盖等于作废已有 MCP/SSH/频道凭据）；
  从 `.example` 复制 `headless.env`（已有则不动）。`prerm` 停服务，`postrm` 只 `daemon-reload`，**不删数据**；
- ar 容器在 Node 里写（60 字节头 + 偶数对齐），**不依赖 `dpkg-deb`** —— 打包机是 Windows，
  而 ar + tar + gzip 都与平台无关；成员名/权限字段按 dpkg 自己产出的 deb（`dist/dieyunagent_*.deb`）
  逐字节对齐，有 `dpkg-deb` 时再跑 `-I` / `-c` 交叉校验；
- **分发与更新都交给 apt**：`build:all`（桌面 NSIS + Ubuntu deb）末尾接上 `build:headless`
  （`pack:dieyun-core:linux` → `pack:deb:headless` → 两处 deb/tgz 结构自检 →
  `publish:headless-apt` 生成内网源 → 索引自检）。产物落 `dist/`，源目录落 `release/headless-apt/`
  （`release/` 不进版本库）。**不进 COS / Y: / 桌面更新通道**，`upload-updates-cos.mjs` 的
  `STALE_KEY_RE` 也不匹配 `dieyun-headless_*`，不会被当成旧版清理。
- **为什么更新走 apt 而不是自研**：服务器上已经有 apt、`unattended-upgrades`、`apt-daily.timer`，
  给它们一个源就有「自动更新 + 哈希校验 + 依赖解析 + 指定版本回滚」。自己写「查版本 → 下载 →
  替换运行中的二进制」是第二套更新真相，还要绕开 apt 的锁与 systemd 的重启语义 —— 减法优先，
  这里没有第二条路要走。索引文件（`Packages` / `Packages.gz` / `Release`）由
  `scripts/publish-headless-apt.cjs` 自己算，不依赖 `dpkg-scanpackages`（发布机是 Windows）；
  `scripts/lib/deb-archive.cjs` 是 deb 读写的唯一实现，打包（写）与发布（读 control）共用它。
- `-v` / `--version`（读包根 `package.json`）是升级验收的锚点：`dieyun-headless --version` 一眼看出
  服务器上跑的是哪一版，不用去翻 `/opt` 里的 manifest。
- **真 apt 验收（2026-11-04，Ubuntu 26.04 / apt 3.2.0）**：源目录直连 `file:` 挂载实测 ——
  ① 索引字段与 `dpkg-scanpackages` 逐行一致（含 `Size` / `SHA256`）；② `apt-get update` 零警告；
  ③ `apt-cache policy` 认出候选版本；④ `apt-get download` 后哈希与索引一致；⑤ 模拟安装依赖解析通过；
  ⑥ 双版本源里 `apt install` 取最新、`apt install dieyun-headless=<旧版本>` 取旧版（回滚路径）。

实施时对方案的三处修正（写清原因，避免后人再「改回去」）：

1. **依赖清单不手写，从入口推**：打包脚本从 `src/headless/main.js` 走一遍 `require` 图（240 个文件），
   收集真正的裸包名再与 `dependencies` 求交 → `@modelcontextprotocol/sdk` / `node-html-parser` / `rrule` / `ssh2` / `ws`。
   手写清单会在「加了 require 忘记更新」时让服务器上 `MODULE_NOT_FOUND`，而本地一切正常。
2. **`npm install` 必须带 `--omit=optional --ignore-scripts`，并扫 `*.node` 收尾**：`ssh2` 的可选依赖
   `cpu-features` 与它自己的安装脚本都会在**构建机**编出原生二进制（win32），混进 Linux 包就是「起不来且看不出原因」。
   实测第一次打包正是被这个闸门拦下的，否则问题要到服务器上才暴露。
3. **加「冷启动闸门」，并且必须**在**仓库外**跑**：`src/browser/controller.js` / `session-sync.js`
   顶部有 `require('electron')`，而 Gateway 的 handler 汇总是静态加载 `browser` handler 的 ——
   headless 于是也被迫加载它。在仓库里测（`node build/headless-pack/src/headless/main.js run ...`）会
   一路往上解析到**仓库自己的** `node_modules/electron`，「包能启动」这个结论是假的；把 tgz 解到
   `/tmp` 立刻 `MODULE_NOT_FOUND`。修法是**减法**：`src/browser/electron-host.js` 延迟取用（无 Electron 时
   给 `ELECTRON_UNAVAILABLE`），而不是往包里塞一个 stub `electron`。闸门把 payload 的 `src/assets/package.json`
   复制到临时目录、`node_modules` 与 `build` 用符号链接指回去，跑入口 `--help` —— 秒级、不联网，
   专治「依赖闭包看着对、干净机器上加载不起来」。


---

## 5. 关键设计细节

### 5.1 executor 契约（唯一的「谁跑这一轮」）

`AgentService` 已有的回调协议刚好够用，本地执行器只需要照着实现在同一进程内：

```
submitTask() ──▶ executor(task)                     # 桌面：转发 IPC 给 Renderer
                     │                              # headless：runMainTurn 就地跑
                     ├─▶ acceptTask({requestId})     # 进入 running
                     ├─▶ progressTask({trace, streamContent})   # 流式正文 + 工具行
                     └─▶ completeTask({status})      # completed / failed / stopped
stopTask()   ──▶ canceller({requestId}) ──▶ abort()
```

好处：手机端、Web 端、桌面端看到的是同一套 `AgentRunEvent`；不为 headless 造平行事件。

### 5.2 工具集与能力边界（如实告知，不做假兼容）

headless 的工具表 = `buildMainAgentTools()`（`PLAN_RUNTIME_TOOL_NAMES` + MCP 工具）= 与定时计划/频道同一档：`host_exec`、`fs_read_file`、`fs_edit`、`fs_write_file`、`fs_list_dir`、`web_fetch`、`web_search` + MCP。

没有的：`browser_*`（需 Electron 内嵌浏览器）、`computer_*`（需桌面截图/输入）、`camera_look`（需手机）、`agent_clarify` / `session_new` / `session_set_workspace`（Renderer-only，模型侧也拿不到这些 schema，不会误调）。启动日志固定打一行能力边界，而不是加开关。

### 5.3 沙箱与审批

- 档位读同一个 `host-permissions.json`（`permissions-store` 单一来源），`--sandbox` 只是本次覆盖。
- 审批通道**不注入** → `sandbox-approvals` 的既有语义生效：没有人可问 = 一律拒绝（fail-closed）。默认 `workspace-write`：工作区内写放行，越界写被拒并回给模型一条明确错误。
- 需要无人值守装环境时才用 `--sandbox danger-full-access`，文档里写明风险。

### 5.4 工作空间与会话

- `--workspace` 作为默认工作空间；每个会话的绑定仍走 `AgentService.submitTask({ workspacePath })` → `bindSessionWorkspace`（会话行 + 进程内上下文两处都写的唯一实现）。
- P2 不暴露 `session_set_workspace`（换目录先靠 `--workspace` 与新建会话）；后续要支持时复用频道那条 `workspace-switch` 抽象，而不是再写一份。

### 5.5 单实例（实施时修正：改为「告警」而非「硬退出」）

原方案想用 `LocalGateway.start()` 的 `EADDRINUSE` 判定「同一 userData 已有实例」并退出。实测发现这条路不成立，也不该成立：

- `WebSocketServer` 的监听错误是**异步 error 事件**，`start()` 不会同步抛，所以「必然 EADDRINUSE → 退出」抓不到；
- 更关键：本地 Gateway WS 只是**桌面端 Renderer 的接口**，headless 自己走 `invokeRpc` 不经过它。端口被占（例如桌面端正开着）时 headless 依然能正常干活，硬退反而是错的。

因此实现为：启动时探测端口，被占则打一条 WARN（「可能已有另一个进程在使用同一数据目录」），继续运行。**不引入 pid 文件锁**（那会是第二套「谁在跑」的真相）；并发风险由 SQLite 访问模型（`docs/SQLITE-ACCESS.md`）承担，唯一实际影响是两个进程会各起一份索引监听。使用约定写进 `docs/HEADLESS.md`（P4）：一个 userData 只跑一个 headless。

### 5.6 凭据（唯一需要新代码的「外部能力」）

`src/secret-store.js` 明确「不能加密就报错，绝不回退明文」。所以 headless 提供一个同形实现：

- 有 `DIEYUN_SECRET_KEY_FILE`（32 字节，0600）→ AES-256-GCM 加解密，落盘仍是 base64 字符串（`secret-store` 的形状不变）；但**与 Electron safeStorage 的密文互不通用**：桌面写过的 MCP/SSH 凭据在服务器上解不开，需要在服务器侧重填（文档写明，不假装可迁移）；
- 没有 → `isEncryptionAvailable()` 返回 `false` → 现有代码按既有语义报「当前系统无法加密存储凭据」。

**模型 API Key 不受影响**：`model-settings.json` 本来就是明文存 key，headless 开箱能用 LLM；受影响的只有 MCP / SSH / 频道这类走 `secret-store` 的凭据。

### 5.7 dieyun-core 二进制定位

`src/core-bridge-path.js` 不依赖 `app.isPackaged`，只用 `process.resourcesPath`（纯 Node 下为 `undefined`，自动跳过该分支），随后按 `DIEYUN_CORE_BIN` → `__dirname/build|target/{release,debug}` 探测。所以 headless 无需改代码，只需：打包态把 `bin/dieyun-core` 放进探测路径，或部署时设 `DIEYUN_CORE_BIN`。找不到时 `isRustCoreEnabled()=false` → 启动即报「core 未就绪」并退出（退出码 3），**不做 JS 回退**（与桌面一致）。

### 5.8 出网与系统代理（已知边界，先文档不先加层）

`src/gateway/web/transport.js` 在没有 Electron `net` 时退回 Node `fetch`，**不读系统代理**。因此服务器若在代理后才出网，`web_search` / `web_fetch` 会直接 `fetch failed`。P2 处理方式：

1. 启动日志与 `docs/HEADLESS.md` 写明这条边界；
2. 需要代理时用 Node 自带能力（如 `NODE_USE_ENV_PROXY=1` + `HTTPS_PROXY`，Node 版本支持则生效），**不在本仓另写一套 dispatcher**；
3. 只有在「Node 自带能力不足以覆盖、且该层是唯一出口」时，才允许给 `transport.js` 的纯 Node 分支加一个可选 dispatcher 注入点。

---

## 6. 可选扩展（同一入口，零新执行路径）

1. **定时计划**（`--plans`）：`bootPlansRuntime` 的 `getWindowTray`/`getTrayNotify` 已经全程 null-safe（`getMainWindowWebContents()` 返回 null 即静默丢弃 UI 事件），headless 传 `() => null` 即可在服务器上跑 cron 型任务。
2. **企业微信频道**（`--channels`）：`bootChannelsRuntime` 只需 `safeStorage`（用 §5.6 替身）+ gateway/core/mcp；频道一轮本来就跑在 Main，与窗口无关。
3. **`POST /api/task`**：给 CI 用最小 HTTP 入口。
4. **桌面界面当网页**（`--web` 自带 `/app/`，2026-11-04 实施）：`src/renderer` 本身就是浏览器页面
   （`contextIsolation: true` + `nodeIntegration: false`，RPC 自己连 Gateway WS），所以只加两件东西就够——
   `src/headless/desktop-ui.js`（`window.diecloud` 的浏览器替身 + 静态服务 + `/gateway` 同源 WS 代理）
   和 `MobileBridge` 的 upgrade 路由（原先 `path: '/ws'` 会把其它路径的 upgrade 直接 400 掉）。
   **没有第二个前端、也没有第二套 Agent 装配**；手机端页面继续保留（宽屏下只拉宽消息列）。

---

## 7. 测试与验收

| 阶段 | 自动化 | 手工 |
|---|---|---|
| P0 | `npm run test:mobile`、`npm run test:agent-run-events`、`npm run test:unit`、`npm test` | 桌面聊天、手机端、频道各跑一轮确认无回归 |
| P1 | `npx vitest run test/unit/channels-turn.test.cjs test/unit/channels-runtime.test.cjs`、`npm run test:agent` | 企微群里发一条消息，确认回复与落库一致 |
| P2 | `npm run test:headless`（新增，见下）；`npx vitest run test/unit/headless-*.test.cjs test/unit/main-turn-runner.test.cjs` | Linux 上 `dieyun-headless run "看看这个仓库是什么"`（真 API Key）、SIGTERM 后无残留 core 进程 |
| P3 | 复用 `npm run test:mobile`（桥未改） | 浏览器打开 `--web` 地址，发一条消息看到流式正文与工具行 |
| P4 | `npm run pack:headless` + `tar -tzf` 断言清单 + **冷启动闸门**（打包脚本内自动跑） | systemd 起服务、重启后计划任务照常触发 |
| P5（deb 外壳） | `npm run pack:deb:headless` + `npm run verify:headless-deb`（ar 成员顺序 / control 字段 / data 内关键路径 / 权限位） | `sudo apt install ./dieyun-headless_*.deb` → `dieyun-headless self-test` → `systemctl status` → `apt remove` 后数据仍在 |
| P5（内网 apt 源） | `npm run publish:headless-apt` + `npm run verify:headless-apt`（索引 Size/SHA256 与磁盘逐条比对） | 源目录直连 `file:` 挂载，`apt update` / `apt policy` / `apt install` / `apt download` 全走真 apt |
| **真机验收（2026-11-04）** | — | Ubuntu 26.04 / apt 3.2.0（`192.168.31.62`）：`apt install=0.1.72` → 服务 `active/enabled` + Web `HTTP 200` → `self-test: OK(core=ready)` → `apt install` 升到 0.1.73（**MainPID 变了 = 新版本接管进程**）→ `--allow-downgrades` 回滚到 0.1.72（服务仍 active）→ `/etc/dieyun` 与 `/var/lib/dieyun-agent` 全程未被覆盖 |

真机验收当场抓到并修掉三个问题（都只在 Linux/真机上才暴露，本地单测覆盖不到）：

1. `src/agent/delegate-tool-gateway.js:resolvePath` 对**已绝对**的 POSIX 路径又拼了一次工作区
   → `fs_list_dir` 拿到 `/ws/var/lib/x` 这种幻觉路径，自检直接失败。Windows 上因盘符早退没暴露
   （修法：POSIX 宿主上以 `/` 开头的输入按绝对路径直通；Windows 保留「`/src/x` = 工作区相对」旧语义）。
2. systemd 单元把 `--port/--workspace/--log-level` 写死 → `headless.env` 改不动；而这台机器上
   17331 已被 `remote/run-cli.js` 的 remote-agent 网关占着，服务必然起不来。改成
   `Environment=` 给默认值 + `${VAR}` 展开 + `EnvironmentFile=` 覆盖。
3. `MobileBridge.getInfo()` 不管绑在哪都报局域网地址 → 绑回环时日志里的 `http://192.168.x.x:port/#token=…`
   从别的机器根本连不上。改为：绑回环就打印 `127.0.0.1`。
4. apt 降级必须带 `--allow-downgrades`（只加 `-y` 会被 apt 直接拒绝）—— 文档与 `publish:headless-apt` 提示已改。

第二轮真机（同一天，真实干活验收）又抓到三个「装好了却跑不对」的问题：

5. `/etc/dieyun` 建成 `root:root 0750`，`dieyun` 用户连 `read(2)` 都到不了：systemd 以 root 读
   `EnvironmentFile` 所以服务照常起，但**手工 CLI 看不到配置**（报「未配置 API Key」）、运行时也读不到
   `secret.key`。postinst 改成 `install -d -o root -g dieyun -m 0750` + 显式 `chgrp/chmod`（已有安装升级即修）。
6. CLI 不读 `/etc/dieyun/headless.env`：手工 `run` 悄悄用 `~/.config/dieyunagent` 另建一套账本。
   包内启动器现在会补齐未设置的变量（显式 export 仍优先）。
7. `DIEYUN_WORKSPACE` 只被 unit 展开成 `--workspace`，CLI 不认 → 服务写 A 目录、命令行写 B 目录。
   `boot.js` 现在按 `--workspace > DIEYUN_WORKSPACE > ~/.dieyun/workspace` 解析，两边同一个含义。

最终端到端证据：`dieyun-headless run "在工作空间创建 hello.txt …"`（零 env 参数）→ 文件真的落在
`/run/media/dieyunx/dieyunserver/harness/dieyunagent/workspace/hello.txt`，内容与要求一致，模型回话正常。

端到端验收（最终）：在一台干净 Ubuntu 22.04 上，仅装 tarball → 写 `headless.env`（模型 Key + 凭据密钥）→ `systemctl start` → 浏览器发指令让它改一个文件、跑一条测试命令 → 会话与 trace 可从 Web 端回看。

---

## 8. 风险与对策

| 风险 | 对策 |
|---|---|
| 抽 `main-turn-runner` 时改坏频道语义 | 只做「搬 + 传参」，不改判定；`channels-turn.test.cjs` 保护，P1 单独一次提交 |
| `secret-store` 密文与桌面不互通 | 明文 key 不受影响；文档写明「服务器上重填 MCP 凭据」，不假装可迁移 |
| 服务器上模型侧误用 UI 工具 | 工具 schema 层就不给（`buildMainAgentTools` 档位），加上 `requestToolFromRenderer` 的 fail-fast 双保险 |
| 公网暴露 Web 端 | 默认只听 `127.0.0.1` + token；文档给反代片段 |
| 服务器在代理后才出网（`web_*` 失败） | §5.8：先文档 + Node 自带代理能力，不另写 dispatcher |
| core 二进制找不到（`resourcesPath` 为 undefined） | §5.7：打包放探测路径或设 `DIEYUN_CORE_BIN`；找不到就明确退出（码 3），不静默降级 |
| 与 `remote/run-cli.js` 被后人误合并 | §3 写明两者职责与信任模型差异，`docs/HEADLESS.md` 再强调一次 |

---

## 9. 工作量估计

| 阶段 | 规模 |
|---|---|
| P0 | 5 个文件、约 70 行净改动 |
| P1 | 新增 ~300 行（搬移）+ 频道净减 ~150 行 |
| P2 | 新增 ~550 行（boot / executor / cli / log / secret-storage / self-test） |
| P3 | ~60 行 |
| P4 | ~430 行脚本（`pack-headless.cjs` + 抽出的 `lib/node-linux-runtime.cjs`）+ `lib/tar-writer.cjs`（~130 行）+ systemd 单元 + 两份文档（方案 / 运维手册） |
| P5 | deb 外壳 ~230 行（并进 `pack-headless.cjs`：control 生成 / `postinst`·`prerm`·`postrm` / ar 写入 / 结构自检），**不新增打包脚本**——payload 与 tgz 完全共用 |

P0+P1 是「让单一来源成立」的前置；P2 之后即可在服务器上真正无界面运行；P3 拿到浏览器 UI；P4 是「装到服务器上」的最后一公里；P5 只是把同一份 payload 换成 `apt` 能装的外壳。

---

## 10. 附录：可行性取证（为什么不用改这些模块）

| 判定 | 取证 |
|---|---|
| `LocalGateway` 无 Electron | 构造只吃 `userDataPath`/`readableDir`（`server.js:96`）；`start()` 才绑 `127.0.0.1` 端口（`:1046`）；`invokeRpc()` 不依赖 `start()`（`:1225`） |
| `dieyun-core` 可纯 Node spawn | `core-bridge.js:283` `spawn(binaryPath, ['serve-stdio'])`；定位不用 `app.isPackaged`（`core-bridge-path.js:17-25`） |
| 计划运行时无窗口安全 | `mcp-plans-boot.js:183/217-225/228-236` 全部 null 守卫；`getWindowTray:()=>null` 只丢 UI 事件 |
| Main 侧工具表本来就是「无 Renderer」档 | `main-agent-tools.js:15`，注释明写「聊天在 Renderer，Main 侧只有静态 + MCP」 |
| 工具桥全部入参可 null | `tool-bridge-main.js:280-303`，缺依赖退化成结构化错误（`MCP_UNAVAILABLE` / `SSH_UNAVAILABLE` / `PEER_UNAVAILABLE`…） |
| Renderer-only 工具不会被误调 | `tool-catalog.js:2327` 只有 `agent_clarify` / `session_new` / `session_set_workspace`；不在 `PLAN_RUNTIME_TOOL_NAMES` |
| 无窗口审批 fail-closed | `renderer-tool-delegate.js:87-89` + `sandbox-approvals.js:153-157` → `SANDBOX_NO_CHANNEL`（不可重试） |
| 模型设置不碰 safeStorage | `model-settings.js:317` 只读 `<userData>/model-settings.json`（apiKey 明文） |
| MCP 无界面已有显式分支 | `mcp/manage.js:204-210` → `MCP_CREDENTIAL_UI_UNAVAILABLE` |
| 预装 MCP 可纯 Node 启动 | `bundled-launch.js:128-135`（`process.execPath` 即 node，`ELECTRON_RUN_AS_NODE` 被忽略） |
| 输出协议现成 | `src/agent/run-events.js` + `AgentService` 事件；Web 端已在消费 |

---

## 11. 实施记录（P0–P5 已完成）

改动落点与「跑出什么」的对应关系（命令都在 `E:\dieyunagent` 下实跑过）：

| 阶段 | 落点 | 实测 |
|---|---|---|
| P0 | `app-paths.js`（electron 移进 `configure()`，新增 `resolveUserDataDir`）、`agent/service.js`（`setExecutor`/`setCanceller` + `EXECUTOR_UNAVAILABLE`）、`main-entry.js`（跟随改名）、`renderer-tool-delegate.js`（`RENDERER_UNAVAILABLE`） | `node -e "require('./src/app-paths')"` 在纯 Node 下通过；`session-workspace-binding` 14 项通过 |
| P1 | 新增 `agent/main-turn-runner.js`（`runMainTurn` / `resolveTurnModel` / `buildTurnSnapshot`）；`channels/agent-turn.js` 缩减为频道特有部分并委托 | 频道三套测试 27 项通过；`test/unit/main-turn-runner.test.cjs` 7 项通过 |
| P2 | 新增 `src/headless/{cli-args,log,secret-storage,boot,local-executor,main}.js`、`scripts/test-headless-smoke.cjs`；`package.json` 加 `headless` / `test:headless`；`docs/CODEMAP.json` 加 `src/headless/` 与 `main-turn-runner.js` 两条 pathRule + 两个 suite 挂 `test:headless` | `npm run test:headless` → `self-test: OK`（core=ready / sandbox=workspace-write）；`run "…"` 真模型一轮返回并落库；无 Key 时退出码 3 且不留空会话 |
| P3 | `boot.js` 的 `--web` 分支（`MobileBridge` + 默认 127.0.0.1 + token URL 打日志） | `serve --web --port 17399` 后 `GET /` 返回 200（`src/mobile/public` 原样加载） |
| P4 | 新增 `scripts/pack-headless.cjs`、`scripts/lib/node-linux-runtime.cjs`（与 `pack-remote-gateway.cjs` 共用，后者改为引用它）、`deploy/systemd/dieyun-headless.service`、`docs/HEADLESS.md`；`package.json` 加 `pack:headless` / `verify:headless-pack` | `npm run pack:headless` → `dist/dieyun-headless-0.1.72-linux-x64.tgz`（52.2 MB / 5612 条目，内置 node v20.18.2 + core + 113 个纯 JS 依赖，GLIBC 地板 2.28）；`npm run verify:headless-pack` 通过；**把 tgz 解到 `%TEMP%` 后跑 `self-test` 与真模型一轮** → 均成功（只暴露过一次真问题，见下方第 3 条） |
| P5 | `scripts/pack-headless.cjs` 加 `--deb`（`buildDeb` / `buildControlText` / `writeAr` / `readArMembers` / `verifyDeb`）、`scripts/lib/tar-writer.cjs`、`src/browser/electron-host.js`；`package.json` 加 `pack:deb:headless` / `verify:headless-deb`；`docs/HEADLESS.md` 改为 deb 优先 | `npm run pack:deb:headless` → `dist/dieyun-headless_0.1.72_amd64.deb`（52.2 MB，Installed-Size 154986 KB）；ar 三个成员的头与 dpkg 产出的 `dist/dieyunagent_0.1.72_amd64.deb` 逐字节一致（仅压缩用 gz 而非 xz）；`npm run verify:headless-deb` 通过（control 字段 / 三个维护脚本 / data 关键路径）；层内权限 `bin/node`·`bin/dieyun-headless`·`dieyun-core`·`/usr/bin/dieyun-headless` 均 0755，其余 0644 |

新增单测：`test/unit/headless-cli.test.cjs`（参数解析与退出码相关的边界）、`test/unit/headless-secret-storage.test.cjs`（AES-GCM 往返 / 换钥不可解 / 缺钥拒绝加密）。

实施期发现并已修正的三处方案偏差：

1. **§5.5 单实例**：端口占用改为 WARN（理由见该节），不再硬退出；
2. **模型解析顺序**：`run`/`repl` 在**建会话之前**先校验模型配置（`resolveTurnModel` 只读配置、不出网），否则配置缺失时会在账本里留下一条没有消息的空会话；
3. **冷启动**（P5 才暴露）：`src/browser/controller.js` / `session-sync.js` 顶部 `require('electron')`，
   而 Gateway 的 handler 汇总是静态加载 `browser` handler —— headless 被迫跟着加载它。
   在仓库里验证时 Node 会解析到**仓库自己的** `node_modules/electron`，所以「包能跑」是假象；
   tgz 解到 `/tmp` 立即 `MODULE_NOT_FOUND`。修法是 `src/browser/electron-host.js` 延迟取用
   （无 Electron 抛 `ELECTRON_UNAVAILABLE`），并把它变成**打包期闸门**：在仓库外的临时目录里
   跑入口 `--help`，专治「依赖闭包看着对、干净机器上加载不起来」。

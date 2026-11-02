# 多 Agent workspace 资源隔离（方案 C：每 agent 一个 git worktree）

> 来源：`issue/2026-10-28-remote-index-infinite-retry-and-sigkill.md`（主 bug）与
> `issue/2026-10-28-multi-agent-workspace-resource-isolation.md`（架构）。
> 本文只讨论**架构层**；主 bug 的止血改动已落地，见 §2。

## 1. 结论先行

| 决策 | 取舍 |
|---|---|
| 目标态 | **方案 C**：一个 agent 会话 = 一个 git worktree，隔离靠目录而不是靠锁 |
| 过渡方案 A（单实例锁） | **不单独上线**，其 `flock` 并入本文 §8，作为 C 的收尾（语义从「防止并行」降级为「防止同一 worktree 重复实例」） |
| 方案 B（索引单写多读 + owner 选举） | **不做**。见 §4 |

理由一句话：撞车点的根因是「多实例共用一个 `<workspace>/.dieyun/`」，而 `.dieyun/` 是被 gitignore 的运行时目录 —— 换一个工作目录就天然各有一份。加锁、加转发协议都是给错误前提续命。

## 2. 已落地（不属于本方案，但属同一现场）

| 修复 | 位置 | 关键数字 |
|---|---|---|
| status 超时重试**有上限**、退避、回到 `run()`、耗尽即抛 | `src/remote/remote-index-core.js` | `STATUS_RETRY_MAX=1`，15s×2+0.3s ≈ 30s |
| status 超时 45s → 15s（单一来源） | `src/core-rpc-timeouts.js` | 30s 严格小于网关 45s RPC 预算，保证报错来自本层 |
| 兜底强杀留痕 + 宽限 | `src/core-bridge.js` | `STOP_GRACE_MS=5000`，SIGKILL 前打 `未响应 SIGTERM（5000ms），强制 SIGKILL` |
| 日志名带端口 | `src/ssh/remote-gateway-manager.js` | `agent-<slug>-<hash8>-<port>.log` |

日志带端口这条**在 C 之后仍然需要**：同一个 worktree 被客户端重连时，旧实例未死仍会撞文件。

## 3. 五个撞车点：真实归属（已按当前代码校正）

原 issue 的判断基本准确，但有两处需要更正，方案依赖这个更正：

| 资源 | 实际路径 | 谁决定 | worktree 能隔离吗 |
|---|---|---|---|
| `index.sqlite`（远端） | `<workspace>/.dieyun/index.sqlite` | `src/remote/workspace-index-path.js` | ✅ |
| `diecloud-memory.sqlite`（远端） | `<workspace>/.dieyun/diecloud-memory.sqlite` | 进程启动时是 `$DIEYUN_DATA_DIR`，但 `index.configure` 会把 `data_dir` 改写成 `<workspace>/.dieyun`（`src/remote/remote-index-core.js:206` → `crates/dieyun-core/src/config.rs:109`） | ✅ |
| `AGENTS.md` / `agents-*.json` | `<workspace>/.dieyun/` | 被 gitignore，不含在版本库 | ✅ |
| 运行日志 | `~/.dieyun/remote-agent/logs/` | 平台级，按 workspace 路径哈希 | ⚠️ 靠 §2 的端口段，不靠 worktree |
| 工作树 / git index | 主工作区 | git | ✅ 这就是 worktree 本身 |

**更正 1**：远端记忆库确实落在 `<workspace>/.dieyun/`（issue 说的对），但**不是**因为它天然在那儿 —— 而是 `index.configure` 显式改写了 `data_dir`。这条是实现细节，改动时会踩，所以记下来。

**更正 2（原 issue 没提，但对 C 影响更大）**：**本地**的索引库不是 per-workspace，而是**全局单库** `%APPDATA%/dieyunagent/codebase-index.sqlite`（`src/gateway/server.js:297` 只传 `data_dir: this.userDataPath`，不传 `index_db_path`）。也就是说：

- 远端：索引 per-workspace → worktree 隔离有效
- 本地：索引全局单库 → **worktree 隔离不到索引**；两个本地实例仍然抢同一个 sqlite

所以 C 落地时，本地侧若要真正并行，还需要让 `index_db_path` 也按 workspace 走（同样是「让既有机制作用在更细的目录上」，不是新机制）。这一条列进 §9 的 C1。

## 4. 为什么不做方案 B（索引单写多读）

B 要让 core 变成多客户端、加转发协议、加 owner 选举与故障转移 —— 全是新增机制，目的是维持「多人共用一份索引」这个前提。而「一份索引」本身不是需求，只是当年「一个人一个会话」的实现巧合。前提消失，mechanism 就不必存在。

## 5. 为什么 worktree 天然解决它

```bash
git worktree add -B dieyun/agent-<runId>-<roleId> .dieyun/worktrees/<runId>/<roleId> <baseSha>
```

- 共享同一个 `.git` 对象库（不复制历史），只多一份**检出**；分支必须唯一，所以 `-B` 带 runId+roleId
- `.dieyun/` 被 `.gitignore` 忽略（L14-22），所以每个 worktree 检出后是**各自新建的一份**
- `RemoteIndexCoreHost._ensureStarted()` 本来就会 `mkdir <workspace>/.dieyun`，核心侧 `config.rs:127` 也会 `create_dir_all(data_dir)` —— 新 worktree 什么都不用手工铺

即：**`workspaceIndexDbPath()` 一行代码都不用改**，隔离自然发生。这是本方案唯一的「免费午餐」，也是它优于一切加锁方案的根据。

## 6. 可复用的既有能力（不新写）

`src/git/worktree-service.js`（1121 行）已经具备：

| 能力 | 函数 | 说明 |
|---|---|---|
| 创建 | `createAgentWorktree(repoPath, {runId, roleId, baseRef})` | 基线解析成具体 sha 再落盘（避免基线随 HEAD 漂移）；已存在则 `reused:true` |
| 串行化创建 | `runWorktreeCreateExclusive` | 防止并行 `git worktree add` 抢同一仓库的 `index.lock` |
| 变更预览 / 合回 | `previewRunWorktreeChanges` / `applyRunWorktreeChanges` / `commitWorktreeChanges` | 产出先提交到 worktree 分支 → 清理不可逆也留了存档 |
| 清理策略 | `enforceWorktreeCleanupPolicy({maxRuns, maxSizeGb, protectedRunIds})` | 容量/数量双维度，UI 侧已有设置页 |
| 变更 diff | `listWorktreeChangesVsBase` / `getWorktreeChangeDiff` | 相对基线 sha，语义确定 |

**当前唯一调用点**是 Planner：`src/agent/planner-main-bridge.js:106`（由 `rust-planner-runner.js` 驱动）。普通单会话 agent 不建 worktree —— 这正是「用 agent 模式时 worktree 好像没用」的原因，不是 worktree 无用，是没人调用。

## 7. 落地点（按改动面从小到大）

**L1 会话级 workspaceRoot 解析（核心改动）**
在会话启动时决定 `cwd/workspaceRoot` 指向 `<wt>` 还是主仓库，复用 `createAgentWorktree`。判定点要单点，避免 Renderer / Main / Gateway 各算一份。

**L2 远端建 + 远端跑**（原文档此处低估了改动，2026-10-28 校正）

远端 workspace 是 git 仓库，但**不能复用本地的 `src/git/worktree-service.js`**：它内部走 `gitExec(repoPath)`，跑的是 Main 所在机器的 git（`worktree-service.js:305`）。远端仓库必须在远端执行 `git worktree add/remove`。

**地基已就绪（2026-10-28 实施）**：`src/ssh/remote-worktree.js`
- `remoteWorktreeKey(sessionId)` → `sess-<hash8>`，**纯派生**：同一会话永远映射同一份 worktree，重连/重启自动复用，不需要任何持久化状态或「陈旧锁回收」
- `remoteWorktreePath()` / `remoteWorktreeBranch()` → 目录 `.dieyun/worktrees/<id>/main`、分支 `dieyun/agent-<id>-main`（与本地 `worktree-service` 同一套规则，不另立一套）
- `ensureRemoteWorktree(sshManager, …)` → 幂等建库，用脚本标记行（`WT_CREATED` / `WT_REUSED` / `WT_NOT_GIT` / `WT_ADD_FAILED`）判定结果，不猜 git 的成功/失败文案
- 10 个单测覆盖命名、幂等、基线 sha、单引号转义、结果解析（`test/unit/remote-worktree.test.cjs`）

**接线时唯一需要想清楚的事：会话 workspace 与 agent workspace 必须分离**

`sshGatewayKey(target)` = `user@host:port|remotePath`（`src/workspace/target.js:148`），而 `allocateRemotePort` 已支持同一 `targetKey` 下的多个槽位。也就是说：**只要会话的 `remotePath` 换成 worktree 路径，pool 槽位、端口、日志名（哈希 remotePath）、索引库、沙箱根全部自动跟着变，远端每会话一个 agent 是现有架构本来就装得下的**，不需要新的机制。

因此 C2 的接线清单只有三处，必须同时改，否则会出现「agent 在 worktree、RPC 带主仓库路径」的错位：

| # | 位置 | 改什么 |
|---|---|---|
| 1 | `localGateway.getSessionWorkspaceTarget(sid)`（`session-remote-transport.js:78/273` 消费） | SSH 会话返回的 target，`remotePath` 指向该会话的 worktree（建库调 `ensureRemoteWorktree`）；会话记录里仍存用户选的仓库，UI 不变 |
| 2 | `src/main/remote-gateway.js` ensure 时传入的 target | 同上，保证池子/端口/`--workspace` 用的是 worktree |
| 3 | Renderer 的 `resolveSessionWorkspacePath*` → RPC `workspaceRoot` | 必须与 agent 的 workspace 一致，否则 RPC 里的路径与索引对不上 |

- 之后 `src/ssh/remote-gateway-manager.js:612` 的 `--workspace` 自然就是 worktree 路径（索引 / AGENTS.md / 记忆库随之自动隔离）
- `src/ssh/remote-path.js` 的 `remoteAllowedRoots` 按传入 workspaceRoot 推导，新路径天然放行

即：**本地靠 `worktree-service.js`，远端靠 SSH 执行同一组 git 命令**，两者共用同一套命名与清理语义（见 §11 的命名决策），不各写一份路径规则。

### C2 已实施（2026-10-28）

三处接线一次接完，改动面 `+2 模块 / 4 文件改动`，无新增配置项、无开关、无降级层：

| # | 位置 | 做法 |
|---|---|---|
| 1 | `src/session/session-worktree.js`（新） | `ensureSessionWorktree()`：会话说「我要用远端」时建/复用它的 worktree，然后把**会话工作区本身**改成 worktree 路径（`setSessionWorkspaceContext` + 落库 `memory.session_workspace_set`） |
| 2 | `src/session/session-remote-transport.js` | `setSessionRemoteLease` / `applySessionRemoteTransport` 在**租约快照之前**先 resolve worktree；`ensureRemoteGatewayForTarget(target, sessionId)` 的会话身份**必须由调用方显式给**（见下方 C2.1 修正） |
| 3 | `src/main/remote-gateway.js` | `ensureRemoteGatewayForCurrentWorkspace` 先 ensure worktree，再把 effective target 交给 pool |
| — | `src/gateway/server.js` | `_storeSessionWorkspaceTarget()` 唯一写入口 + 一条保护：会话已有 worktree 时，「把仓库根写回来」被忽略（防渲染端旧缓存抹掉 worktree） |

**C2.1 修正（2026-10-29）：会话身份不许按端点反推**

现场：同一台机器上开着两个仓库（`dieyundaizhang` / `dieyuntools`），一个 dieyuntools 会话的 `workspace_path` 每几秒在两个仓库的 worktree 之间翻一次，历史列表把这条会话画到了 dieyundaizhang 文件夹下。

根因：`ensureRemoteGatewayForTarget(target)` 三个调用点（`setSessionRemoteLease`、`applySessionRemoteTransport`、`ssh/reconnect.js`）都没传 sessionId，函数内部用 `sessionIdForTarget(target)` 补 —— 端点只认 `user@host:port`，同机多仓库时挑到了**别的会话**，随后 `withSessionWorktree(别人的会话, 这个仓库)` 在该仓库里建了一份别人的 worktree，`session-worktree.js` 又把它落库成那条会话的工作区。

修正（减法，无新机制）：删掉 `sessionIdForTarget`；`ensureRemoteGatewayForTarget` 没有 sessionId 时**只起槽位**（不建 worktree、不写任何会话工作区）；三个调用点补齐会话身份（`getLeasedTargets()` 让重连拿到 `(sessionId, target)` 对，`collectSshReconnectEntries` 保留会话身份）。同轮收掉渲染端 `resolveSendWorkspace` 在租约之后把**仓库根**写回会话工作区的那次写（远端只认 Main 那次落库，否则重启后又跑在共享树上）。回归：`npm run test:session-remote-transport` 的 `foreign-repo gateway ensure cannot hijack another session`。

**为什么「会话工作区 = worktree」而不是加一层 overlay**
渲染端解析会话工作区走 `memory.session_get`，RPC 路径解析走 `resolveCallWorkspaceTarget()`（`rpc.js:163`，内部读 `getSessionWorkspaceTarget`）。让**存下来的那个路径**就是 worktree，两条链路自然同源；加 overlay 则会出现「渲染端以为在仓库、RPC 在 worktree」的双份路径，正是本方案要消除的错位。

**未做（下一轮）**：无 —— C2 的会话隔离与应用回主目录都已闭环。剩余的是 C3 的 `flock` + `agent-<port>.pid` 存活校验（§8）。

**L3 日志带端口（已完成）** + `agent-<port>.pid` 读取前校验存活（issue §8 的残留 pid 问题）。

**L4 产出回收 UX（已实施，2026-10-28）**

单会话模式下「改完的文件不在主目录」是 C 最大的体验风险。远端版本用 **git 原生两步**收口，而不是把本地那套逐文件复制搬过来：

| 步骤 | 命令 | 为什么 |
|---|---|---|
| 1 | `git -C <wt> add -A` + `commit` | 副本改动落成一份可审计的提交（`dieyun/agent-sess-xxxx-main`） |
| 2 | `git -C <repo> merge --no-ff <branch>` | 冲突判定、冲突文件清单、回滚全由 git 提供 |
| 失败 | `git -C <repo> merge --abort` | 一行把主目录恢复原样，不需要备份目录 + manifest |

本地的 `applyRunWorktreeChanges` 之所以自己实现备份/回滚，是因为它按「文件粒度勾选」应用、且不能污染用户分支；远端会话副本是整份产出，走分支更简单也更安全。两条路径的边界写在 `src/main/ipc/worktree.js` 的注释里（本地 `worktree:*`，远端 `worktree:remote-*`）。

入口：工作空间菜单 →「会话副本」区块（显示副本位置 + 未应用文件数）→「应用改动到主目录」。提交身份固定为 `dieyun-agent <agent@dieyun.local>`，避免远端没配 `user.name` 就整条链路失败。

## 8. flock：并入 C 之后的形态

C 之后锁不再是「防止并行」，而是「防止同一个 worktree 上起两个实例」。仍然需要，因为：

- 客户端重连瞬间，旧实例可能还没死（现场证据：两个实例分别存活 5 小时 / 22.8 小时，core 已死但 run-cli 空转）
- `createAgentWorktree` 对已存在的 `<runId>/<roleId>` 是 `reused:true`，同一 worktree 会被复用

**锁对象**：`<workspace>/.dieyun/agent.lock`（随 worktree 天然独立）

**实现**：由启动方加锁，而不是在 `run-cli.js` 里自己实现：

```sh
flock -n -E 42 <ws>/.dieyun/agent.lock \
  env DIEYUN_REMOTE_TOKEN=... nohup node remote/run-cli.js --workspace <ws> --port <p> >> <log> 2>&1
```

- 抢不到 → `flock` 以 42 退出且**不启动 core**；启动方读锁文件里的 `pid/port/started_at` 原样报给用户
- 锁随持锁进程死亡自动释放 —— 不需要「陈旧锁清理」这套状态机，这是相对 pid 文件唯一的实质优点
- `run-cli.js` 启动成功后把 `pid port started_at` 写进锁文件，仅供人读

**被否掉的写法**：纯 Node 用 `fs.open(lock,'wx')` + `kill -0` 判活。它需要在仓内实现一遍「陈旧锁回收 + 回收竞态」，比 `flock` 多 30 行且更难测；`flock` 是 util-linux 自带、远端本就是 Linux，属于用外部既有能力而不是新增机制。

**能力探测**：启动前 `command -v flock`，缺失则跳过加锁并**明确打日志**（远端是 Linux，这是外部系统能力探测，不是兜底层）。

## 9. 成本与分阶段

### 成本（必须提前认账）

1. **索引冷启动**：每个新 worktree 的 `index.sqlite` 要重新建，不可复用主工作区那份（现场样本 122,085,376 B ≈ 116 MiB）。并行 N 个 agent ≈ N 份索引。这是 C 唯一的硬成本，没有减法空间。
2. **磁盘**：worktree 增量 = 源码检出（本项目 1048 个 tracked 文件、约 20 MB 量级；业务仓库另算）+ 上述索引。`.git` 对象库共享，不重复。
3. **产出不在主目录**：见 L4。

### 分阶段

| 阶段 | 内容 | 完成标志 |
|---|---|---|
| **C1** 本机单会话闭环 | L1 + L4；同时把本地 `index_db_path` 按 workspace 拆（§3 更正 2） | 两个本地会话并行，各自 `codebase_search` < 3s，互不影响 |
| **C2** 远端落地 | L2 + 部署验证 | 远端两个会话各自独立 `index.sqlite`，`fuser` 无跨实例持有 | 已实施（见 §7），待真远端验收 |
| **C3** 收尾 | §8 flock + L3 的 pid 存活校验 | 同一 worktree 第二实例被拒绝并报出 pid/port |

顺序不能反：先上 flock 会让人觉得「并行问题已解决」，实际只是把第二个 agent 挡在门外。

## 10. 验收标准

对齐原 issue 的 5 条：

1. 同一 workspace 第二实例：被拒绝，并输出已存在实例的 `pid` / `port` / 启动时间，**不启动 core**
2. 同一 workspace 的两个实例：日志文件名不同（已由端口段满足，见 §2）
3. 两个 agent 并行时，任一方 `codebase_search` / `graph.status` **< 3s** 返回，无超时
4. 两个 agent 同时提交 AGENTS.md 提案，两条都落盘，无覆盖丢失
5. 两个 worktree 的 `.dieyun/index.sqlite` 互不相同，`fuser` 验证无跨实例持有

### C2 在真远端怎么验（人肉三行）

```sh
# 1. 每个会话各有一份副本（两个窗口连同一台机器后应有两条）
ls -d ~/repo/.dieyun/worktrees/*/main

# 2. 索引库各在各的副本里，互不共享
ls -l ~/repo/.dieyun/worktrees/*/main/.dieyun/index.sqlite

# 3. 确认没有跨实例持有同一个库（正常应各输出自己的 pid，且互不相同）
fuser -v ~/repo/.dieyun/worktrees/*/main/.dieyun/index.sqlite
```

界面上判定：会话工作区路径会变成 `…/.dieyun/worktrees/sess-xxxxxxxx/main` —— 这就是「这个会话在自己那份副本里干活」的证据。

### 租约必须回「生效后」的工作区（2026-10-31）

worktree 是**在租约里**建的（`remote:session-lease` → `ensureSessionWorktree`），而渲染端在租约**之前**
就已经取好了会话工作区（当时还是仓库根）。两边差一条路径，症状是索引/图面板

```
索引根不一致——远端 Agent 连接声明的根是「…/worktrees/sess-xxx/main」，请求的根是「…/repo」
```

（两份 `index.sqlite`，`WORKSPACE_SCOPE_MISMATCH`）—— 而且这一轮**不会去建库**，于是「面板永远未建立」
+ `codebase_search` 0 次。真机实测：`dieyuntools` 的 10 个 worktree 里 0 份 `index.sqlite`。

约定：**`setSessionRemoteLease` 返回生效后的会话工作区**，调用方必须采用它
（`src/main/ipc/workspace-remote.js` → `src/renderer/renderer-agent-loop.js` →
`src/renderer/renderer-agent-send.js:resolveSendWorkspace`，并写回渲染端缓存）。
渲染端不许拿「租约前的路径」当这一轮的作用域 —— 那正是 `WORKSPACE_SCOPE_MISMATCH` 的制造方式。

### 会话 worktree 的回收规则（2026-10-31 实施）

乙案下每会话一份远端 worktree + 一份 `index.sqlite`（真机实测 19–38 MB / 份），而**远端会话
worktree 之前没有任何回收路径**：`enforceWorktreeCleanupPolicy` 是本地文件系统策略（拿远端仓库根
去扫，只会看到本机不存在的路径），`worktree:remove` 只服务 planner 的 worktree。结果是
`…/.dieyun/worktrees/` 随会话数无限增长（真机一次测得 13 份 ≈ 300 MB）。

规则（三处单一来源）：

| 事项 | 唯一来源 |
|---|---|
| 哪份会话还活着 | `memory.sessions_list` 的 `updatedAt` + 在途租约（`sessionLeases`）—— **不猜远端 mtime**（只读的会话几天不写文件，按 mtime 会删掉正在用的那份） |
| 保留期 | `src/session/session-worktree.js:SESSION_WORKTREE_KEEP_DAYS = 7` |
| 怎么删干净 | `src/ssh/remote-worktree.js:buildPruneWorktreesScript` / `pruneRemoteWorktrees` |

- **触发点**：新建 worktree 时（`ensureSessionWorktree` 拿到 `WT_CREATED`）。目录数就是在那时增长的，
  所以不需要定时器、不需要额外状态；复用分支（`WT_REUSED`）不扫。
- **保留**：当前会话 + 正在租用端点的会话 + 保留期内活跃过的会话，一份都不动。
  **归档不影响保留期**：归档是侧栏整理动作，不是「这份副本可以立刻删」，规则只有「最后活跃时间」一个判据
  （首跑时按 `archived:false` 单列表判断，把 10 份刚归档会话的副本直接收掉了 —— 见下方「首跑记录」）。
- **保护**：只碰 `sess-*` 形状的目录；`main/.git` 是文件（确实是 worktree）且 `git status --porcelain`
  有输出时**跳过**并记日志 —— 那是会话里未提交的改动，不是缓存。
- **分支不删**：`dieyun/agent-<key>-main` 可能装着会话的提交，删目录不等于丢它们。
- **已知边界**：会话表按 `updatedAt DESC` 取两份各 100 条（core 上限）；两份都没出现的会话，
  一定比第 100 个更老，正是该回收的那批。

**首跑记录（2026-10-31 17:24，真机）**：新建会话触发第一次扫描，回收 11 份
（`sess-zzsentinel` 哨兵 + 10 份归档会话副本），另有 5 份因有未提交改动被保留。
事后核对：被删的 10 份删前都是 clean（脚本的脏检查保证了这点），对应分支 9/10 仍在库里，
第 10 份本就是 detached 无分支 —— **没有内容丢失**，重开这些会话会按 `WT_CREATED` 重建副本（~2s）。
那次暴露的真问题不是「删太多」而是「判据漏了归档」：`sessions_list{archived:false}` 只给了活跃会话，
归档会话于是全被当成「表里没有」而回收。已改成两份列表都取、归档只当普通会话看待。

真机演练（2026-10-31，dieyuntools，19 份 worktree）：干净 worktree → `WT_PRUNED`，且
`git worktree list` 同步消失；带未提交改动 → `WT_KEPT_DIRTY` 保留；19 份真实会话 worktree 一份没动。

## 11. 已定决策（2026-10-28）

| # | 问题 | 决策 | 依据 |
|---|---|---|---|
| 1 | 远端 workspace 是 git 仓库吗 | **是**。SSH 工作区本身就在远端，与本地无关 | 用户确认 |
| 2 | worktree 生命周期 | **会话结束不自动删**。改动先提交到该 worktree 的分支（存档），之后由既有 `enforceWorktreeCleanupPolicy`（maxRuns / maxSizeGb，设置页已存在）淘汰 | 删也不丢内容的前提已被 Planner 验证；不新增生命周期状态机。**2026-10-31 修正**：`enforceWorktreeCleanupPolicy` 是本地文件系统策略，压根覆盖不到远端会话 worktree（实测无限增长），远端改由 `SESSION_WORKTREE_KEEP_DAYS` 保留期规则回收，见 §10 |
| 3 | 分支 / 目录命名 | 目录 `.dieyun/worktrees/sess-<会话id短hash>/main`，分支 `dieyun/agent-sess-<会话id短hash>-main` | 与 `createAgentWorktree(repoPath, {runId, roleId})` 同一套规则：runId 塞 `sess-<hash8>`、roleId 固定 `main`，**本地远端共用一套命名**；hash 规避会话 id 里的路径非法字符 |
| 5 | worktree 路径要不要反推回仓库 | **要**，`repoRemotePathOf()` | 会话工作区存的就是 worktree 路径；建库前反推回仓库根，保证重连不会派生嵌套目录（`.dieyun/worktrees/x/main/.dieyun/worktrees/...`） |
| 6 | 远端不是 git 仓库怎么办 | 沿用原目录，只打日志 | 属既有能力边界，不新增拦截；若为此加开关就是「用机制绕失败」 |
| 4 | 索引冷启动可接受吗 | **先接受，实测一次**（见下方待测数）。若单次 > 2-3 分钟再优化，优化方向是「索引按文件内容复用」，**不是**回到共享单库 | 共享单库 = 方案 B，已否 |
| 7 | 会话工作区存的是 worktree，UI 显示什么 | **显示项目、不显示副本**：`workspacePath`（写入位置，路由用）保持副本原值；`displayPath` 与 `memory.sessions_list` 的 `workspaceProjectPath` 一律剥掉 `.dieyun/worktrees/...` 尾巴（唯一实现 `src/workspace/target.js` 的 `stripWorktreeSuffix` / `projectWorkspacePath`） | 上线首日就暴露：历史列表把同一项目的每个会话拆成各自一个名为 `main` 的文件夹。副本是「写到哪儿」的实现细节，项目才是会话的身份；副本本身在「工作空间菜单 → 会话副本」里单独展示，信息不丢 |

### 仍待测的数字

- 远端 `dieyundaizhang` 的首次 `codebase.index` 耗时 / 仓库文件规模。取数位置：远端日志里的 `codebase.index` 耗时行，或 `git ls-files | wc -l`。
- 这个数字只影响 C1 之后的优化排序，**不阻塞 C1**（本地单会话闭环）。

# [ARCH] 多 agent 并行时 workspace 级资源零隔离：索引 / 日志 / AGENTS.md / 记忆库被多实例共享

- **优先级**：P1（架构）
- **影响范围**：`remote-agent` 0.1.58 远端守护链路 + `<workspace>/.dieyun/` 全部单例资源
- **环境**：Ubuntu，workspace `/run/media/dieyunx/dieyunserver/dieyundaizhang`（`index.sqlite` 122,085,376 B / WAL）
- **关联**：`docs/issues/2026-10-28-remote-index-infinite-retry-and-sigkill.md`（该 issue 的「根因三」与本文是同一根因，本文单独拉出来讨论架构层）
- **提出日期**：2026-10-28

## 1. 背景

现在常见用法是**多个 agent 会话同时开发同一个项目**。但当前远端机制假设「一个人、一个会话、一份索引」，多实例一上就自相冲突，表现为：代码检索 45s 超时、core 被 SIGKILL、端口跳变、日志互相覆盖、AGENTS.md 条目丢失。

需要说明：**SSH 传输层不是瓶颈**，问题出在 SSH 之上的一层。

## 2. 现状机制（实测，非推断）

```
1 个 SSH 会话
  └─ 1 个 run-cli 进程   （--workspace <path> --port <客户端指定>，PID 1 号直挂）
       ├─ 1 个本地 ws gateway  ws://127.0.0.1:<port>
       └─ 1 个 dieyun-core 子进程（serve-stdio）
```

实测样本：

```
470029  (ppid 1)  run-cli.js --workspace .../dieyundaizhang --port 17331
470046  (ppid 470029)  dieyun-core serve-stdio          ← 唯一持有 index.sqlite 的进程
265205  (ppid 1)  run-cli.js --workspace .../Workbuddy2api   --port 17333
```

**已经隔离到「实例」级的只有两样：**

| 隔离项 | 实现位置 | 说明 |
|---|---|---|
| 端口 | `run-cli.js:49` `--port` | 由客户端分配（17331/17332/17333），不冲突 |
| pid 文件 | `~/.dieyun/remote-agent/current/agent-<port>.pid` | 按**端口**命名，一个实例一个 |

**没有任何互斥。** 在 `remote/` 与根层全部 `.js` 中检索 `flock` / `.lock` / `pidFile` / `already running` / `EEXIST`，**零命中**。也就是说：开 10 个窗口，10 个实例都会起来，谁也不拦谁，然后一起抢同一个 workspace 的资源。

## 3. SSH 层为什么不是瓶颈（先排除）

| 检查项 | 实测结果 |
|---|---|
| sshd 主进程 | PID 572097，已连续运行 **13 天 6 小时**，无重启 |
| 并发槽位 | `sshd -D [listener] 0 of 10-100 startups` —— 一个都没占满 |
| 当前会话 | 3 条 `sshd-session`（pts/2、notty、pts/0），全部正常 |
| 监听 | 22 端口 IPv4 + IPv6，systemd socket 激活（`ssh.socket` active/enabled） |

结论：连接数、带宽、会话稳定度都不是问题。**评估多 agent 支持时不要把矛头指向 sshd。**

## 4. 撞车点（5 个，逐个带证据）

### 4.1 `index.sqlite` —— 最痛，已实际发生

- **路径**：`<workspace>/.dieyun/index.sqlite`，由 `remote/workspace-index-path.js` 决定
- **关键缺陷**：`workspaceIndexDbPath()` 只接受 `workspaceRoot` 一个参数，**路径里没有实例维度**。所有实例必然指向同一个文件。

```js
function workspaceIndexDbPath(workspaceRoot) {
  return path.join(workspaceDieyunDir(workspaceRoot), 'index.sqlite');
}
```

- **后果**：多个 `dieyun-core` 并发写同一 WAL 库 → 长事务/锁竞争 → `graph.status` 45s 超时 → 触发上一份 issue 的无限重试 → core 收到 SIGTERM 2s 内不退出 → 被 `stop()` 的兜底 SIGKILL 杀掉 → 客户端重连 → 叠加更多实例。
- **现场证据**：`fuser index.sqlite` 显示 `470046 dieyun-core`；清理前曾有 3 个实例、其中 2 个的 core 已死但 run-cli 仍空转（分别 5 小时 / 22.8 小时）。

### 4.2 运行日志 —— 直接导致排障误判

- **路径**：`~/.dieyun/remote-agent/logs/agent-run_<workspace路径下划线化>-<8位hash>.log`
- **关键缺陷**：文件名只由 **workspace 路径**哈希得出，**不含端口、不含 pid**。同一 workspace 的所有实例追加写同一个文件。
- **后果**：日志里 `ws://127.0.0.1:17331` 与 `17332`/`17334` 交替出现，看起来像"单实例反复重启"，实际是多个实例混写。本次排查中确实差点据此误判方向。
- **实测文件名**：
  ```
  agent-run_media_dieyunx_dieyunserver_dieyundaizhang-20b63574.log   2999 B
  ```

### 4.3 `AGENTS.md` / `agents-meta.json` / `agents-pending.json` —— 并发写丢条目

- **路径**：`<workspace>/.dieyun/AGENTS.md`（1408 B）、`agents-meta.json`（148 B）、`agents-pending.json`（0 B，当前）
- **现状**：已经设计了"提案 → pending → 合并"的队列思路（方向正确），但队列本身是**普通单文件**，写入是 last-write-wins。
- **后果**：两个 agent 同时提交 AGENTS.md 提案时，后写者覆盖先写者，条目静默丢失。

### 4.4 `diecloud-memory.sqlite` —— 并发写风险

- **路径**：`<workspace>/.dieyun/diecloud-memory.sqlite`（151,552 B，WAL 模式）
- **后果**：多实例同时写会遇到 `SQLITE_BUSY`；是否有 `busy_timeout` 未确认，若无则表现为记忆写入失败但不报错。

### 4.5 工作树与 git 索引 —— 零隔离

- 多个 agent 直接操作同一个目录：同时改同一文件、同时 `git add/commit/stash`、同时跑构建。
- 这是「多 agent 开发一个项目」真正的冲突面，属于 git 层问题，**不应由 SSH/索引机制承担**。

## 5. 影响汇总

| 现象 | 用户感知 |
|---|---|
| 代码检索/跳转 45s 超时后失败 | 工具直接不可用 |
| core 被反复 SIGKILL | 客户端显示"连接断开"、端口跳变、会话假死 |
| 用户反复重连 | 实例越叠越多，进一步加剧争抢（恶性循环） |
| 日志混写 | 排障方向被误导 |
| AGENTS.md 丢条目 | 项目地图"越用越不准"，但没人察觉 |

## 6. 方案（按「减法优先」排序）

### 方案 A —— 单实例锁 + 日志带端口（过渡，约半天）

```js
// 启动时对 <workspace>/.dieyun/agent.lock 加 flock(LOCK_EX | LOCK_NB)
// 抢不到 → 读锁文件里的 pid/port，打印后 exit(0)，不启动 core
```

- 日志文件名追加端口：`agent-run_<ws>-<hash>-<port>.log`
- 优点：改动小、能立刻止住"雪崩"
- **代价**：第二个 agent 直接起不来 —— 只防事故，不解决并行。不能作为终态。

### 方案 B —— 索引单写多读（**不推荐**，列出仅供对比）

首个实例的 core 独占写，其余实例把查询转发过去，自己不建 core。

- 需要给 core 增加多客户端能力、增加转发协议、增加 owner 选举与故障转移
- 这是在**新增机制去续命"共享一份索引"这个前提**，违背减法原则，不建议做。

### 方案 C —— 每个 agent 一个 git worktree（**推荐作为目标态**）

```bash
git worktree add ../<repo>-agent-<id> <branch>
```

- 每个 worktree 天然拥有独立的 `<...>/.dieyun/`（索引、AGENTS.md、记忆库全隔离）
- 并行零冲突；合并交给 git —— 也就是把"并发控制"这件事交还给本来就该管它的工具
- 需要额外处理的只有：平台级共享（`~/.dieyun/remote-agent/logs/` 仍按 workspace 哈希 → 应加入 worktree 路径或用端口区分）
- 代价：磁盘（每个 worktree 约 120 MB 索引）+ 需要分支/合并流程约定

### 推荐组合

**A 作为过渡立即上（防再次雪崩），C 作为目标态推进，B 跳过。**

## 7. 验收标准

1. 同一 workspace 第二实例启动时：被明确拒绝，输出已存在实例的 `pid` / `port` / 启动时间，**不启动 core**。
2. 日志目录检查：同一 workspace 的两个实例，其日志文件名**不相同**（含端口或实例 id）。
3. 两个 agent 并行开发时，任一方调用 `codebase_search` / `graph.status` 均 < 3s 返回，无 45s 超时。
4. 两个 agent 同时向 AGENTS.md 提交提案，两条都能落盘，无覆盖丢失。
5. 若采用方案 C：两个 worktree 各自 `.dieyun/index.sqlite` 互不相同，`fuser` 验证无跨实例持有。

## 8. 附带发现（建议单独处理）

- `agent-<port>.pid` 文件从不清理：当前残留 `agent-17332.pid`、`agent-17333.pid`，对应进程早已不在（17332 已清理、17333 属另一 workspace）。建议启动时校验 pid 是否存活，死文件直接覆盖或删除。
- `~/.dieyun/remote-agent/current/` 下有 `core-bridge.js`、`manifest.json` 等文件 mtime 显示为 `Jan 1 1970`，说明打包时未保留时间戳，导致无法据此判断版本发布时间。

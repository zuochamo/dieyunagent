# Issue：SSH 工作空间下 `host_exec` 执行后台命令必报 SSH_EXEC_TIMEOUT，但命令实际已执行

- 状态：**已修复**（2026-10-28，见文末「修复记录」）
- 记录日期：2026-10-28
- 组件：叠云 Agent · `host_exec`（SSH 远程执行模式）
- 严重级别：中（不丢数据、可绕过；但阻塞 90s/次且返回的 error 是错的，`suggestedFix` 的建议无效，容易让 Agent 反复踩坑）

## 环境

| 项目 | 值 |
|---|---|
| 工作空间 | `ssh://dieyunx@192.168.31.62/run/media/dieyunx/dieyunserver/dieyuntools` |
| 远程系统 | Linux 7.0.0-38-generic |
| 登录方式 | `sshd-session: dieyunx@notty`（无 PTY，`SSH_TTY` 为空，`tty` → `not a tty`） |
| 会话特征 | 该 `sshd-session` 自 10:23 起长期存活（CPU 5s），看起来 Agent 复用同一条 SSH 会话执行多条命令 |

## 最小复现

```bash
host_exec(command="nohup python3 -m http.server 8892 --directory /tmp >/tmp/pvt.log 2>&1 & echo started")
```

- 期望：立即返回 `started`
- 实际：等待 90s 后返回 `SSH_EXEC_TIMEOUT`（"远程命令超过 90000ms 未返回"）
- 但：`ss -ltn | grep 8892` 显示端口**已在监听**，进程确实起来了 —— 命令执行成功，只是本次调用等不到结束。

## 实测矩阵（同一远程主机，逐条单发验证）

| # | 命令写法 | detached | 结果 | 命令是否真的执行 |
|---|---|---|---|---|
| 1 | `nohup cmd & echo x` | false | **超时**（90s/20s/15s 均可复现） | ✅ 端口在听 |
| 2 | `nohup cmd >log 2>&1 </dev/null & echo x` | false | **超时** | ✅ |
| 3 | `setsid nohup cmd & echo x` | false | **超时** | ✅ |
| 4 | `( nohup cmd & ) ; echo x` | false | 立即返回 | ✅ |
| 5 | `( setsid nohup cmd & ) ; echo x` | false | 立即返回 | ✅ |
| 6 | `bash -c 'nohup cmd &' ; echo x` | false | 立即返回 | ✅ |
| 7 | `nohup cmd & echo x` | **true** | **超时** | ✅ 端口在听 |

结论性规律：

1. **决定因素是「多一层 shell 包裹」**（子 shell `( … & )` 或 `bash -c '… &'`），与 `setsid`、`nohup`、stdin/stdout 重定向均无关。
2. **`detached=true` 在 SSH 模式下同样超时**（第 7 行）—— 脱管通道没有被真正用到。
3. 每次超时都伴随「命令实际已执行」，属于典型**误报**。

## 影响

1. **每次浪费 90 秒**，且 Agent 在等待期间无法继续，长任务串行时体验很差。
2. **返回的 `suggestedFix` 是错的**：提示"改用脱管/后台执行（nohup … &）"，而用户/Agent 正是这么写的（第 1、2 行）—— 照着建议重试只会再超时 90s。这在本项目已造成多次无效重试（长期记忆 #179、#186 只能记成"必须 setsid/脱管"的 workaround，但实测 `setsid` 单独并不能解决，真正的解法是子 shell 包裹，之前的记忆结论也不准确）。
3. 因为报 error 而命令已生效，Agent 容易误判"启动失败"并重复启动，可能造成端口冲突、重复进程。

## 疑似根因（供内部确认）

- 执行器在等待本次命令的 channel / session 输出 EOF；后台进程即便重定向了 0/1/2，仍留在同一会话的进程组内，EOF 迟迟不到，直到超时。
- 加一层子 shell 后，内层 shell 先退出、会话得以结束，故立即返回 —— 与第 4~6 行现象吻合。
- `detached=true` 在 SSH 分支未做额外处理（未 setsid、未切成独立会话），所以同样卡住。

## 修复建议（按优先级）

1. **SSH 分支实现真正的脱管**：检测命令含后台标记（`&` 结尾 / `nohup` / `setsid`）时，自动包装为 `bash -c '( <cmd> & )'`，或统一在远端用 `setsid bash -c '<cmd>' </dev/null >/tmp/host_exec.<id>.log 2>&1 &` 启动并立即返回。
2. **超时前先探测，别把"已在跑"报成失败**：超时时检查目标命令是否已产生子进程/监听端口，返回 `{ok:true, detached:true, note:"命令已在后台运行，未等待结束"}`，而不是 error。
3. **修正 `suggestedFix` 文案**：当前建议（`nohup … &`）与实测矛盾，应改为「用 `( nohup … & )` 子 shell 包裹，或 `detached=true`（修复后）」。
4. 长期来看，SSH 模式与本地模式应共用同一套脱管语义（本地 `detached` 可用、远程不可用，属能力不一致）。

## 临时规避（用户/Agent 侧可直接用）

> 修复后已不再需要，保留作历史对照。

```bash
# 起临时服务
( setsid nohup python3 -m http.server 8899 --directory /tmp >/tmp/x.log 2>&1 & ) ; sleep 1 ; curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8899/
# 清理
fuser -k 8899/tcp
```

要点：**整条后台启动语句必须用括号子 shell 包住**，等待/探活语句放在括号外；不要依赖 `detached=true`。

---

## 修复记录（2026-10-28）

### 复现（真实 ssh2 客户端 → 192.168.31.62，记录事件时间线）

| 写法 | sshd 发 exit-status | channel close | 旧代码结果 |
|---|---|---|---|
| `nohup cmd >log 2>&1 & echo started` | 119ms | **永不到达** | 90s 超时（stdout 其实已收到 `started`） |
| `( nohup cmd & ) ; echo started` | 89ms | 89ms | 立即返回 |
| `nohup setsid cmd & echo $!` | 92ms | 永不到达 | 90s 超时 |
| `echo hi` | 96ms | 97ms | 正常 |

关键取证（另开一条 channel 观察后台进程的 `/proc/<pid>/fd`）：后台进程的 **stdout/stderr 仍指向
这次 session 的输出管道**，而 bash 对异步命令会多 fork 一层（`$!` 拿到的是那层 shell，
真进程是它的子进程）。所以「多一层子 shell 就正常」的真正原因是：**管道没被后台进程继承**，
channel 才能在命令结束时 close。`setsid` / `nohup` / 重定向都改不了继承关系，故无效。

### 根因

`session-manager.execRawOnce` 只等 `stream` 的 `close`。`close` 等价于「sshd 关掉输出管道」，
而不是「命令结束」；后台进程握着管道 → 永远等不到 → 超时，且报出的 error 语义完全错。

### 修法（从「等管道」改成「等命令」）

- 新增 `src/exec-settlement.js`（`attachExecSettlement`）作为**「一条命令何时算结束」的唯一判定**，
  本机 `runShell`（Node spawn）与远程 `session-manager.exec` 共用：`close` 优先；收到 exit-status
  （ssh2 `exit` / Node `exit`）后静默 400ms 收尾（每来一段输出重置窗口，保证 exit 之后仍在途的
  尾部输出不丢）；exit-status 一直不来才由各自的 timeout 兜底。
  SSH 侧在静默收尾时主动 `stream.close()` 释放 channel（实测 sshd 不会因为非 PTY 会话 channel
  close 去杀后台进程，后台服务照常在跑）。
- `SSH_EXEC_TIMEOUT` 的 `suggestedFix` 改成说真话：超时意味着**命令链还在前台跑**（不是「没启动」），
  要常驻请用 `detached=true`，要长输出请缩小范围；不再推荐无效的 `nohup … &`。
- 远程 `detached` 与本地对齐（`src/gateway/remote-processes.js`）：
  1. `setsid` 让命令自成会话/进程组，`pid` 就是命令本身（实测 PPID=1、PGID=SID=pid），
     `kill -TERM -<pid>` 结束整棵树 —— 不再返回那个「杀掉只会留孤儿」的包装 shell pid；
  2. stdout/stderr 落 `/tmp/dieyun-host-proc/bg-*.{out,err}.log`（`/tmp` 是远程允许根，可直接
     `fs_read_file`），不再丢进 `/dev/null`；
  3. 登记 `sshproc-N` 句柄，`host_proc` 的 list / output（含 `waitMs` 轮询）/ kill 在远程工作空间
     可用，语义与本机 `hostproc-N` 一致；启动脚本整体包 `{ … }`，`cd` 失败就整体失败
     （否则会在 HOME 里悄悄起一份，还回一个看着正常的 pid）。
- 本机侧同源问题一并修掉：`runShell` 以前也只等 `close`，POSIX 下 `sh -c 'daemon &'`（孙进程继承
  输出管道）会等到超时；现在同样按 exit-status 收尾，结果里用 `behindStillHoldingStdio: true`
  说明「命令主体已结束，但还有后台进程占着输出管道」。

### 验收（同机实测）

| 场景 | 修复前 | 修复后 |
|---|---|---|
| 复现矩阵 1/2/3（`nohup … &`、全重定向、`setsid`） | 90s → SSH_EXEC_TIMEOUT | ~0.5s，`code:0`，端口在听 |
| `( … & )` 子 shell | 0.19s | 0.19s（不再需要它） |
| `detached=true` | 90s 超时 | 48ms 返回 `sshproc-1` + 真实 pid + 日志路径 |
| 远端 detached 全链路 | — | list 看到活、output 读到日志、`waitMs` 等新行、kill 后端口释放 |
| 大输出 `seq 1 300000` | 正常 | 1,988,895 字节全部收到（与 `wc -c` 一致，不截断） |
| 非零退出 `ls /nope` | 正常 | `code:2` + stderr 原样 |
| 真·前台长命令 `sleep 3`（timeout 1.2s） | 超时 | 仍按时超时（不误判成功） |
| 本机 `sh -c 'sleep 3 & echo hi'` | 等 3s（管道被占） | ~0.4s 返回 + `behindStillHoldingStdio` |

单测：`test/unit/exec-settlement.test.cjs`（8 例，含「只来 exit-status」「exit 后仍到尾部输出」
「通道错误在 exit 之后不影响结论」）、`test/unit/remote-processes.test.cjs`（9 例，假 ssh 适配器跑
启动/list/output/kill 与会话隔离）、`test/unit/host-exec-long-task.test.cjs`（本机 POSIX 收尾回归）。

### 仍未做（有意留白）

- 「停止 Agent」时结束**远端未 detached** 的 host_exec 子进程：本机有 `killActiveShellChildren`，
  远端目前靠命令自身结束/channel 关闭，没有对应的远端清理入口。
- 远程句柄表在进程内，应用重启后不保留（本机句柄表同样如此）；重启前起的远端后台进程只能用
  `host_exec` 跑 `ps`/`pkill` 处理。

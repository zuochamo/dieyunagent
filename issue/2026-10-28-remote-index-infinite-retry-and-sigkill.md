# [BUG] remote-index-core 超时重试无上限 → RPC 永不返回 / core 被 SIGKILL 反复重启

| 项 | 内容 |
|---|---|
| 报告时间 | 2026-10-28 15:45 (Asia/Shanghai) |
| 组件 | `dieyun-remote-agent` **0.1.58**（`~/.dieyun/remote-agent/0.1.58`） |
| 环境 | 远端 Ubuntu，SSH 工作区 `/run/media/dieyunx/dieyunserver/dieyundaizhang` |
| 严重级 | **P1** —「代码检索/跳转」整体不可用，且引发 core 反复被强杀 |
| 类型 | 逻辑缺陷（主）+ 优雅退出缺陷（伴）+ 缺单实例互斥（放大） |

---

## 1. 现象

1. `graph.status` / `codebase.status` 稳定 **45s 超时**，随后连续重试，整个工具调用卡死 2 分钟以上仍不返回。
2. 日志重复出现：

```
[dieyun:core] RPC_TIMEOUT graph.status id=38 timeoutMs=45000
remote index: graph.status 超时，不杀进程，再试一次
[dieyun:core] RPC_TIMEOUT graph.status id=39 timeoutMs=45000
remote index: graph.status 超时，不杀进程，再试一次
[dieyun:core] RPC_TIMEOUT graph.status id=40 timeoutMs=45000
```

3. 随后出现 core 被强杀并重新拉起：

```
dieyun-core 退出 code=null signal=SIGKILL
remote gateway ws://127.0.0.1:1733x
```

4. 客户端侧表现为端口跳变（17331 → 17332 → 17334），会话"假死"。

---

## 2. 根因一（主因）：超时重试是**无限递归**，没有次数上限

**文件**：`remote/remote-index-core.js`
**位置**：L355–L369（`invoke()` 定义在 L325，`run()` 闭包定义在 L331，问题在 `run()` 的 catch 段）

```js
      try {
        return await this.bridge.invoke(method, payload, timeout);   // L346
      } catch (err) {
        const msg = err && err.message ? String(err.message) : String(err);
        // 进程真挂了：再拉起。仅「超时」绝不要 SIGTERM——会杀掉正在 embedding/建库的任务
        if (/已停止|已退出|not running|未启动/i.test(msg)) {          // L350
          ...
          return this.bridge.invoke(method, payload, timeout);        // L359
        }
        if (
          STATUS_FAST_METHODS.has(method) &&
          method !== 'index.ping' &&
          /超时|timeout/i.test(msg)
        ) {
          this.log(`remote index: ${method} 超时，不杀进程，再试一次`);  // L366
          return this.bridge.invoke(method, payload, timeout);          // L367  ← 问题在这
        }
        throw err;
      }
```

**问题点**：

1. **注释与实现不符**：注释是"再试一次"，代码是**无上限递归**。没有 attempt 计数、没有退避、没有总 deadline。
2. **递归目标选错**：重试时直接调 `this.bridge.invoke(...)`，而不是回到 `run()`。后果是不重新 `_ensureStarted()`、不重置 `started`、也不受 `_runExclusive()` 约束 —— 与上面"core 已死 → 重启后重试"分支的语义不一致。
3. **必然命中**：`core-bridge.js` L392–L402 超时路径 `reject(new Error(\`dieyun-core 超时: ${method}\`))`，消息里带"超时"，正好被 L364 的正则匹配 → 只要 core 一次不返回，就进入死循环。
4. **请求堆积**：`STATUS_FAST_METHODS`（L37–L41，含 `codebase.status` / `graph.status` / `index.ping`）走 `run()` 不排队，每进来一个请求就新开一条重试链，串行叠加。

**触发条件**：core 处理 `status` 的耗时 > 45s（`INDEX_TIMEOUT_MS` 对 status 分支写死 45000，见 L337–L345）。本例的触发条件是 117MB 索引库 + 多实例争用（见根因三）。

---

## 3. 根因二（伴随）：`stop()` 的 2 秒 SIGKILL 兜底，掩盖了 core 无法优雅退出

**文件**：`core-bridge.js`
**位置**：`stop()` L342–L369

```js
    try {
      child.kill('SIGTERM');                    // L349
    } catch { }
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { }   // L356
        resolve();
      }, 2000);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
    });
```

**结论**：日志里所有 `code=null signal=SIGKILL` 都来自这里，属于**自己人强杀**，不是崩溃。

已排除的猜测（避免后续排查走弯路）：
- 不是 OOM：内存 46G 总量、已用 9G、可用 37G，`dmesg` 无 OOM killer 记录；
- 不是磁盘：NVMe + ext4，1.7T 可用，无 I/O error。

**真正的缺陷在 core 侧**：SIGTERM 后 2 秒内没退出，说明信号处理无法在阻塞的索引/sqlite 调用中被及时响应。

**建议**：
1. core 收到 SIGTERM 立刻 set 一个 cancellation token，中断正在跑的 sqlite 长事务/embedding 批次，尽快退出；
2. `stop()` 的等待时间放宽到 5s，且 SIGKILL 前打一行明确的日志（如 `dieyun-core 未响应 SIGTERM，强制 SIGKILL`），使"被兜底强杀"和"被外部杀死"在日志上可区分。

---

## 4. 根因三（放大因素）：没有单实例互斥，多实例共享同一个 index.sqlite

> 本根因已拆分为独立 issue 讨论架构层（含 SSH 机制评估、5 个撞车点、worktree 方案）：
> `docs/issues/2026-10-28-multi-agent-workspace-resource-isolation.md`

- `remote/run-cli.js` 里没有 pid/lock 文件互斥逻辑（`grep -n "lock|pid"` 无命中）；
- `remote/workspace-index-path.js` 让同一 workspace 的所有实例指向**同一个** `.dieyun/index.sqlite`（117MB，WAL 模式）。

现场证据（清理前）：

```
PID 470029   :17331  存活 3 分钟   ← core 活着
PID 315351   :17332  存活 5 小时   ← core 已死，agent 空转
PID 3884900  :17334  存活 22.8 小时 ← core 已死，agent 空转
```

三个实例读写同一个索引库、写同一个日志文件（`agent-run_<workspace>-<hash>.log`），所以日志里端口交替出现，看起来像"单实例反复重启"，实际是多实例混写。

**建议**：启动时对 `<workspace>/.dieyun/agent.lock` 做 `flock`，抢不到就打印已有实例的 pid/port 后直接退出；或 sqlite 连接显式设置 `busy_timeout` 并在超限时明确失败，而不是静默卡住。

---

## 5. 影响面

| 影响 | 说明 |
|---|---|
| 功能不可用 | 代码检索/符号跳转长期卡死或失败，上层只能降级为文本 grep |
| 会话假死 | 端口跳变、客户端以为连接断开，触发用户重连 |
| 恶性循环 | 重连产生更多实例 → 更多索引争用 → 更容易超时 |
| 误导排查 | `signal=SIGKILL` 表面像"core 崩溃/OOM"，实际是重试死循环导致的自杀 |

---

## 6. 修复建议（最小改动）

### 6.1 给重试加上限 + 退避 + 回到 `run()`

```js
const STATUS_RETRY_MAX = 2;        // 总共最多 3 次
const STATUS_RETRY_DELAY_MS = 300;

const run = async (attempt = 0) => {
  await this._ensureStarted();
  /* ... payload / timeout 计算保持原样 ... */
  try {
    return await this.bridge.invoke(method, payload, timeout);
  } catch (err) {
    const msg = err && err.message ? String(err.message) : String(err);
    if (/已停止|已退出|not running|未启动/i.test(msg)) {
      /* 原逻辑：重启后重试，这里也应带上 attempt 上限 */
      if (attempt >= STATUS_RETRY_MAX) throw err;
      ...
      return run(attempt + 1);
    }
    if (STATUS_FAST_METHODS.has(method) && method !== 'index.ping' && /超时|timeout/i.test(msg)) {
      if (attempt >= STATUS_RETRY_MAX) {
        this.log(`remote index: ${method} 连续超时 ${attempt + 1} 次，放弃重试`);
        throw err;                       // ← 必须把错误抛给上层
      }
      this.log(`remote index: ${method} 超时，第 ${attempt + 1} 次重试`);
      await new Promise((r) => setTimeout(r, STATUS_RETRY_DELAY_MS * (attempt + 1)));
      return run(attempt + 1);           // ← 回到 run()，不要直接 bridge.invoke
    }
    throw err;
  }
};
```

要点：**默认路径必须是 `throw`**，不能让任何异常分支无限循环。

### 6.2 给 status 一个总 deadline
`45s × 3` 已 = 135s，过长。建议整体上限 60s（单次 20s × 3），或把 `status` 单次超时从 45s 降到 10–15s——正常的 status 在健康库上应是毫秒级，45s 本身就说明是异常态。

---

## 7. 验收标准

1. 人为挂起 core：`kill -STOP <core_pid>`，然后调用 `graph.status`：
   - 应在 ≤ 3 次重试内**抛出错误返回**，总耗时有限（不超过设定 deadline）；
   - **不得**出现无限重试或超过 3 条 `RPC_TIMEOUT` 日志。
2. `kill -CONT <core_pid>` 恢复后，下一次调用立即正常返回。
3. 日志能区分"未响应 SIGTERM 被兜底 SIGKILL"与"外部信号"。
4. 同一 workspace 启动第二个 agent 实例时被拒绝，并提示已存在实例的 pid/port。

---

## 8. 附带问题（独立缺陷，建议单独开一条）

### LSP 在 Linux 上 `spawn npx` 必然 ENOENT

- `lsp/language-registry.js:66,74` → `command: 'npx'`
- `lsp/lsp-client.js:49-58` 的 `resolveSpawnSpec()` **只对 win32 做了 `cmd.exe` 兜底**，Linux 走 `spawn('npx')`，依赖 `process.env.PATH`
- 远端经 sshd 非登录 shell 启动的 agent，`PATH` 为：
  `/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/usr/games:/usr/local/games:/snap/bin`
  而 `npx` 实际在 `/home/dieyunx/.local/bin/npx` → **ENOENT**
- 后果：远端 TS/Python LSP **静默不可用**，语义跳转悄无声息地降级为文本 grep（日志里只有一行 `spawn npx ENOENT`，不报给工具层）

建议：spawn 前拼接候选路径（`~/.local/bin`、`~/.nvm/versions/node/*/bin`、workspace `node_modules/.bin`），并在全部失败时**把原因上报给工具层**，不要静默降级。

# 沙箱（三档 + ask-once 审批）

> 解决的问题：`host_exec` 跑的是**你本人的完整权限**，`fs_*` 的白名单只是"我们代码里自己检查"。
> 代码写漏一处、工具实现有 bug、或者模型被网页/README 里的注入内容骗了，软检查会跟着一起被骗。
>
> 本档实现：**档位决定能力边界，越界问一次，问不到就拒绝**。
> 单一来源：`src/gateway/sandbox-policy.js`（判定） + `src/gateway/sandbox-approvals.js`（审批记忆）。

---

## 1. 三档能力表

| 档位 | 可写根 | 只读命令 | 写/装依赖 | 越界写 | 联网命令 | 高危命令 |
|---|---|---|---|---|---|---|
| `read-only` | 内部目录* + `%TEMP%` | 放行 | **问一次** | **问一次** | **问一次** | 拒 |
| `workspace-write`（默认） | 内部目录* + 工作区 + `%TEMP%` | 放行 | 工作区内放行 | **问一次** | 放行 | 拒 |
| `danger-full-access` | 本机所有卷根 | 放行 | 放行 | 放行 | 放行 | 拒 |

\* 内部目录是**逐个子目录**列的，不是「`~/.dieyun` 这一棵」：
`userDataPath`（DB / 日志 / 撤销栈）、`~/.dieyun/skills`、`~/.dieyun/memory`、`~/.dieyun/dieyun.md`。
它们不是用户代码，锁掉只会让 Agent 连账本都写不了，所以**任何档位都可写**。

> 为什么不能直接放行 `~/.dieyun` 父目录：它里面装着默认工作区 `~/.dieyun/workspace`。
> 放行父目录 = `read-only` 在默认工作区里完全失效（实测：read-only 下 Agent 往
> `~/.dieyun/workspace` 写文件，0 次询问直接落盘）。默认工作区只能作为**工作区**身份被
> `workspace-write` 放行，不能冒充"内部目录"。

**高危命令任何档位都拒**，且不给"问一次"的机会 —— 否则档位形同虚设。词表是
`sandbox-policy.SANDBOX_DENY_LIST`，**全仓唯一一份**：`exec-policy.js`（命令格式检查）也走它，
所以「被 exec 拦住」和「被沙箱拦住」永远给同一个答案。

高危命令的匹配分两种，语义不同，别混：

| 类型 | 例子 | 判据 |
|---|---|---|
| **整条命令正则**（危险恒危险） | `format c:`、`rm -rf /`、`bcdedit /set x`、`powershell -enc` | `SANDBOX_DENY_LIST` |
| **命令位置词**（只是说"关机"不算） | `shutdown /s`、`reboot`、`Restart-Computer` | `DENY_COMMAND_WORDS`：去掉引号段、跳过 `sudo`/`cmd`/`start`/`npx` 一类包装词后，只认**命令位**上的词 |

分两种是因为以前 `shutdown` 是整条命令匹配，于是 `grep -rn shutdown src/`
和 `git commit -m "fix reboot loop"` 都被当成关机命令硬拒，连问都不问 ——
"提到关键词"和"执行该命令"必须分开。

**「可能写盘」的判定**（`commandMayWrite`，`read-only` 下会问一次的那些）：
写动词（`rm` / `mv` / `cp` / `git commit` …）+ 写类工具（`sed -i`、`tar x`、`unzip`、
`Expand-Archive`、`Remove-Item`、`taskkill`、`choco|winget|npm install` …）+
**解释器/脚本**（`node` / `python` / `perl` / `powershell` / `cmd` / `bash` …）+ 
重定向（`>` / `>>` / `Out-File` / `Set-Content` / `Tee-Object`，但 `2>&1` 这类 fd 复制不算）。

解释器这一项**按"程序位"的 basename 认**（`runsScriptInterpreter`），不是按字面量匹配：
`"C:\Program Files\nodejs\node.exe" -e …`、`node.exe script.js`、`/usr/bin/python3 -c …`、
`sudo node build.js`、`cmd /c node -e …`、`timeout 10 node x.js` 全部命中；而
`grep -rn node src/`、`echo "node -e 1"`（`node` 只是参数/字面量）和 `node -v`、`python --version`
（纯信息开关）不会命中。以前用 `\bnode\s+-e\b` 这类字面量，绝对路径一出现就漏判 ——
实测 read-only 下 `"…\node.exe" -e "…"` **0 次询问直接跑**，档位形同虚设。

> `read-only` 的诚实边界：脚本**内部**的写盘无法逐条判断。`node build.js` 被归类为"可能写盘"
> 所以会问一次；但用户点「允许」之后，脚本里写什么都拦不住了。`read-only` 保证的是
> "可疑操作先问一次"，不是"写不进去"。真要后者得等内核级强制（见 §5）。
> 同理，`/E`、`/Y`、`/PID` 这类 Windows 开关不是 POSIX 绝对路径，别当路径解析
> （以前 `robocopy src dist /E` 会被读成"要写 `C:\E`"）。

---

## 2. ask-once 的粒度与理由

- **每一次都问** = 用户点「允许」点到麻木，等于没有审阅。
- **永远放行** = 等于没锁。
- **本会话 × 类别 × 目录 问一次** = 同一次任务里反复发生的同一件事只打扰一次；
  换任务（新 `sessionId`）、换类别（write / network）、**换目录**都重新问。

粒度为什么必须带上"目录"：只有「会话 × 类别」时，批准一次 `/tmp` 的写就等于批准了
**主目录**的写（实测：批准 `%TEMP%` 一次后写 `~` 下面的文件，0 次询问直接成功）。
用户批准的是"往这个位置写"，不是"以后随便写"。scope 取被批文件的**父目录**；
父目录是卷根时（`D:\x.txt`）退化成"只批这一个文件"，绝不放行整盘。

批准后把该目录并入 `writeRootsForCall()` —— 否则旧的路径白名单
会挡下用户刚刚批准的那次写（表现为"我明明点了允许，还是报路径不在白名单"）。

**档位收紧要作废已有批准**：从 `workspace-write` 切到 `read-only` 时清空全部批准，
否则"我刚切到只读，旧批准照样放行"，切换看起来生效了其实没有。

**fail-closed**：没有窗口可以问（headless / 窗口已销毁）、等到超时（120s）、用户点拒绝 → 一律按拒绝处理，
且**错误码分开**，让排查时一眼看出是哪种"没执行"：

| 情况 | errorCode | 含义 |
|---|---|---|
| 高危命令（`host.exec` 在格式检查阶段就拦） | `BLOCKED` | 与 `SANDBOX_DENIED` **同一份词表**，只是更早发作；改路径/改命令 |
| 高危命令 / 档位硬边界（沙箱判定阶段） | `SANDBOX_DENIED` | 不给问，改路径或放弃 |
| 用户点了拒绝 | `SANDBOX_DECLINED` | 用户不同意，别重试 |
| 没有审批通道（无窗口） | `SANDBOX_NO_CHANNEL` | 没人能回答，别重试 |
| 问了没回（超时 120s） | `SANDBOX_APPROVAL_TIMEOUT` | 无人应答，别重试 |
| Gateway 没注入沙箱对象 | `SANDBOX_UNAVAILABLE` | 配置故障，别重试（**不再静默放行**） |

审批卡片在超时后会被 Main 主动摘掉（`agent:sandbox-approval-expired`）；
不摘的话卡片一直挂着，用户事后点「允许」只会得到"点了没反应"。

---

## 3. 数据流

```
模型 tool_call
   │
   ├─ fs.write_file / fs.mkdir
   │     rpc.js assertSandboxWritable(path)      ← 判定 + 问一次 + 并入白名单
   │        └─ decideFsWrite(path, {mode, workspaceRoots, internalRoots})
   │
   └─ host_exec
         exec-policy.validateShellCommand(cmd)   ← 格式/长度/链长/高危词表
         host.js guardShell(cmd, cwd)            ← 判定 + 问一次
            └─ decideShellCommand(cmd, {mode, workspaceRoots, internalRoots, cwd})

判定结果 allow  → 执行
           ask   → Gateway.sandboxGuard → sandboxApprovals.ask → Main 弹窗（agent:sandbox-approval）
                     → 用户允许：执行 + 记住（会话 × 类别 × 目录）
                     → 用户拒绝/超时：抛 SANDBOX_DECLINED / SANDBOX_APPROVAL_TIMEOUT，**命令不执行**
           deny  → 抛 SANDBOX_DENIED，不询问
```

浏览器产物（截图 / PDF）走同一条判定：`writeArtifact` 先 `assertSandboxWritable`，
再 `assertAllowedPath(rawPath, writeRootsForCall())` —— 指示"存到某路径"时不能只查白名单不查沙箱。

拒绝话术里**必须包含"不要重试"**（`sandboxErrorFor` 统一生成）：否则模型会反复撞同一堵墙，
把步数预算烧在不可能成功的调用上。

---

## 4. 设置与观测

- 设置页「沙箱档位」下拉 = 唯一旋钮；「完全放开路径限制」开关是它的派生视图（勾上 = danger），
  输入区图标点一下也等价。三者互相同步，落盘只认 `sandboxMode`。
  下拉切换后会立刻回写并重绘三处视图 —— 以前下拉只写存储不重绘，开关状态会和档位对不上。
- `permissions.sandbox_state` RPC：返回 `mode`、`writableRoots`、`internalRoots`、`workspaceRoots`、
  本会话已批准的 `grants`（含 `scope` 目录）、`sessionId`、`remoteGoverned`（排查"为什么被拦"）。
- 日志前缀：`SANDBOX_ASK` / `SANDBOX_GRANTED` / `SANDBOX_DECLINED` / `SANDBOX_APPROVED` /
  `SANDBOX_DENY` / `SANDBOX_GRANTS_CLEARED`（档位收紧时清批准）。

---

## 5. 明确不在本档范围内的（下一步）

| 项 | 现状 | 说明 |
|---|---|---|
| 内核级强制（受限令牌 / AppContainer / 作业对象） | **未做** | 现在是**策略级**：判定在我们的代码里，`host_exec` 子进程仍以你本人权限运行。真正的内核锁需要原生代码（Rust `dieyun-core` 是天然落点），可与本档并存而不改判定 |
| 网络出口白名单 | 未做 | `workspace-write` 下联网默认放行（否则 `npm install` 全废）；`read-only` 下联网要问 |
| Linux / macOS | 未做 | 判定逻辑与平台无关（已就绪），只缺各自的强制手段（bubblewrap / seatbelt） |
| 脚本内部的写盘 | 不做（判定层做不到） | `node build.js` 会问一次，但允许之后脚本写哪儿就管不住了。见 §1 的诚实边界 |
| SSH 远程工作区 | 部分 | **本机沙箱看不到远端路径**，所以远程写一律**问一次**（`decideShellCommand` 的 `remote` 分支，理由与路径无关）；远程 `fs_*` 写不由本机沙箱判定，由 SSH 凭据与 `remoteAllowedRoots` 白名单约束 —— 这是**有意的边界**，不是漏判 |
| 让模型提前知道当前档位 | 未做 | 现在靠拒绝话术（`不要重试`）事后纠正；主动写进 system prompt 需在 Main 取 `getSandboxMode()`，留作后续 |

**换句话说**：本档做到的是「不该做的事会被拦住并且有据可查」，不是「想做也做不到」。
后者要等内核级强制落地 —— 判定层已经抽好，届时只换执行器，不用改判定。

---

## 6. 测试

| 命令 | 覆盖 |
|---|---|
| `npm run test:sandbox-policy` | 三档判定矩阵、路径抽取（含 `/E` 不是路径）、命令位高危词、拒绝话术与错误码、批准粒度（会话×类别×目录、卷根退化）、fail-closed、过期 |
| `npm run test:sandbox-gateway` | 真 Gateway + 真文件 + 真命令：档位切换、越界询问、批准后落盘、拒绝不留文件、高危命令恒拒、read-only 可写根不含 `~/.dieyun`、档位收紧清批准、无通道错误码、`host.exec` 引号（带空格路径） |
| `npm run test:sandbox-real` | **真实项目验收**：把本仓库当工作区。真 git 只读命令放行、`grep -rn shutdown src/` 不被当关机、程序路径带空格、绝对路径/`cmd /c` 包装的解释器在 read-only 下必问、默认工作区写入必问、收紧档位清批准。临时目录测不出的坑都在这一层 |
| `npm run test:local-gateway-smoke` | 白名单随档位变化，`unrestrictedPaths` 开关往返 |

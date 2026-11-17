# 沙箱（三档 + ask-once 审批）

> 解决的问题：`host_exec` 跑的是**你本人的完整权限**，`fs_*` 的白名单只是"我们代码里自己检查"。
> 代码写漏一处、工具实现有 bug、或者模型被网页/README 里的注入内容骗了，软检查会跟着一起被骗。
>
> 本档实现：**档位决定能力边界，越界问一次，问不到就拒绝**。
> 单一来源：`src/gateway/sandbox-policy.js`（判定） + `src/gateway/sandbox-approvals.js`（审批记忆）。

---

## 1. 三档能力表

| 档位 | 可写根 | 只读命令 | 写工作区内 | 写工作区外 / 装依赖到系统目录 | 联网命令 | 高危命令 |
|---|---|---|---|---|---|---|
| `read-only` | 内部目录* + `%TEMP%` | 放行 | **问一次** | **问一次** | **问一次** | 拒 |
| `workspace-write`（默认） | 内部目录* + 工作区 + `%TEMP%` | 放行 | 放行 | **问一次** | 放行 | 拒 |
| `danger-full-access` | 本机所有卷根 | 放行 | 放行 | 放行 | 放行 | 拒 |

「装依赖到系统目录」也是**按命令形态**判的（`npm i -g` / `pip --user` / `cargo|go|gem install` /
`make install` / `apt|brew|choco install` 等）：这类命令文本里没有目标路径，但产物一定落在工作区外，
所以 `workspace-write` 下**问一次**。`pip install`（venv 里） / `npm install`（项目里）不会问。

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

### 1.1 远端（SSH 工作空间）也是同一条档位链

档位管的是「哪台机器**由这次调用决定**」，不是「哪台机器跑着叠云」。会话工作空间在 SSH 远端时，
**远端落盘与远端命令会按远端根判同一套三档**：

| 档位 | 远端写（fs / 产物落盘） | 远端命令（host_exec） |
|---|---|---|
| `read-only` | 问一次 | 落盘类问一次，只读命令放行 |
| `workspace-write` | 远端工作区 + 远端 `/tmp` 放行；`$HOME` 其它位置问一次 | 同上（按命令里出现的远端路径判） |
| `danger-full-access` | 放行 | 放行 |

实现上的三件事（改前必读）：

- **判定仍是 `sandbox-policy.js` 一处**：`decideFsWrite` / `decideShellCommand` 多一个 `remote`
  开关，只换两样东西 —— 路径按 POSIX 解析（`path.posix`，Windows 上 `path.resolve('/srv/x')`
  会得到 `E:\srv\x` 这种假路径）与**大小写敏感**比较（Linux 上 `/srv/App` 与 `/srv/app` 是两个目录）。
- **远端根由 `server.sandboxContext({remote:{workspaceRoot}})` 给**（可写根的唯一组装点仍在这里）：
  远端工作区 + 远端 `/tmp`（对应本机的「工作区 + 系统临时目录」），`internalRoots` 为空
  —— 远端没有「本机内部目录」这回事。作用域来自 `rpc.js:remoteSandboxScope()`。
- **传输边界是外层兜底**：远端只开放 `remoteAllowedRoots`（工作区 / `$HOME` / `/tmp`）。
  越界路径在 handler 解析远端绝对路径那一步就被 `ssh/remote-path.resolveRemotePath` 拒掉
  （错误里列出实际开放的根），**不会先弹一次审批再失败** —— 那个位置问也写不进去。
  也就是说顺序是「传输边界 → 档位判定 → 审批」，档位只在传输允许的范围内起作用。
- **远端命令的写入目标靠文本分类**（`commandMayWrite` + `extractPathTokens`，与本地同一份）：
  - 「会不会写」的名单包含动词（`rm/cp/mv/…`）、中介（`tar x`、`unzip`、`sed -i`、解释器、重定向）、
    **建归档**（`tar czf` / `zip` / `7z a`）与 **`configure` / `make`**，以及**安装类**
    （`npm i -g`、`pip --user`、`cargo/go/gem install`、`make install`、系统包管理器）。
  - 「写到哪儿」除了按空白切的 token，还会在引号内与 `key=value` 里捞绝对路径
    （`node -e "writeFileSync('/home/me/x')"`、`dd of=/home/me/blob` 都必须认出来，
    否则「写到工作区外」会被判成「写在工作区内」而静默放行）。
  - `~/x` 按**主目录**展开（远端取 SSH 会话的 `$HOME`、本机取 `os.homedir()`）：
    不展开就会被当成「工作区里的相对路径」，于是「写到家目录」= 「写在工作区」。
  - 安装类命令文本里没有路径，所以单独判：命中即 **ask**（`workspace-write` 也一样）——
    这条就是本表「装到系统目录问一次」的实现。
  - 仍然看不出来的只剩**脚本内部**的写盘（`bash build.sh`、`node scripts/x.js`、`make` 里自定义的
    install 目标）：命令文本里没有任何线索，与本地 `read-only` 的诚实边界同一条。
- 审批粒度分三级：会话 × 类别 × （路径父目录 / 机器）。远端（POSIX）目录的批准**不进本机写白名单**
  （`/home/me` 在 Windows 上会被 resolve 成 `E:\home\me` 假根）；`computer` 的键鼠授权按
  「哪台机器」区分（本机 / 某台远端主机），换主机要重新问。

> 以前这里的立场是「远端路径本机解析不了，所以远端写不过档位，交给 SSH 凭据与白名单」。
> 代价是 SSH 会话里 `read-only` 名存实亡（远端写 0 次询问直接落盘）。现在判定看得见远端，
> 代价是需要把两套路径方言分清楚 —— 这就是上面第一条为什么必须用 `path.posix`。

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

审批卡片**超时后不再被摘掉**，人回来点「允许」也照样算数 —— 但那条工具调用本身已经
以拒绝结束了，所以迟到批准**只落 grant、不重放工具调用**（重放 `rm` 会跑两次）：

| 回包时机 | `delivered` | 效果 |
|---|---|---|
| 工具调用还在等（≤120s） | `live` | 决定直接交给这次调用 |
| 调用已超时结束，但请求仍在寿命内（≈2h） | `late` | 批准记进本会话「该会话 × 类别 × 目录」的 grant；界面提示「下次同类直接放行」 |
| 请求已过寿命 | `late`+`expired` | 界面提示「已过期，请重新执行」，**不再静默无反应** |

实现：`sandbox-approvals.js` 的 `requests` 与 `grants` 同寿命；`resolveLater(requestId, granted)`
是迟到决定的唯一入口；Main 用 `gateway.applyLateSandboxApproval` 注入给
`renderer-tool-delegate.setLateSandboxApprovalHandler`，Renderer 只负责解释 `delivered`。
回归：`npm run test:sandbox-approvals-late`。

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

### 3.1 第三个判定入口：computer（OS 级电脑控制）

`computer` 工具（截屏 + 鼠标键盘注入，`src/computer/`）是结构化动作、无路径语义，
判定入口是 `sandbox-policy.decideOsControlAction`：

- **总开关**：`permissions.osControl`（默认开，设置页「启用电脑控制」可关掉）。打开即代表
  同意读屏 —— `action=screenshot` 在任何档位直接放行，不走审批（否则开关形同虚设）；
  关掉则整个 `computer` 工具不再注入（键鼠动作仍按下面的档位判 ask-once，不受此开关替代）。
- **只读动作**：`screenshot` / `wait` / `wait_until` / `list_windows`。判定是**白名单倒置**的 ——
  除只读集合之外的一切 action（含以后新增的、拼错的、上游漏校验的）都按「会改变系统状态」处理：
  非 `danger-full-access` 档**问一次**，类别 `os-control`、无路径（scope=`-`）→ 审批记忆是
  「会话 × 类别」级；完全放开档放行。集合本身来自 `src/computer/actions.js`（`mutates:false`
  派生，动作枚举唯一来源），倒置保证「漏登记」的最坏结果是多问一次，而不是静默无审批直通。
- **动作枚举单一来源**：`src/computer/actions.js` 一张表声明每个动作的 `mutates` /
  `coordinate`（required/optional/none）/ `click` / `modifiers` / `region`，schema 描述、
  参数校验、沙箱只读集合、执行端分发全部派生。新增动作只改这一处，不会出现
  「schema 允许但校验拒绝」或「校验通过但沙箱没判」。
- `SANDBOX_DENY_LIST` 是 shell 命令词表，与 computer 正交（它不走 shell，不进 `guardShell`）。
- **`target` 决定看哪台机器**（两条正交的轴：会话工作空间在哪台机器 × 你要操作哪台机器）：
  - `target=local`（缺省）：**叠云所在机器**的屏幕，与会话工作空间是不是 SSH 无关
    （同 `browser_*` / `desktop_camera_look` / 生命感的「眼睛」—— 都是本机硬件）。
    曾经按「工作空间是 SSH」直接拒绝（`REMOTE_OS_CONTROL_UNSUPPORTED`）是选错了信号：禁用工具
    并不能防止模型误判，只会让「看一眼本机屏幕」彻底做不到。
  - `target=remote`：**当前会话 SSH 工作空间那台主机**自己的桌面（`src/remote/ssh-screen.js`）。
    走 `ssh.exec` 跑远端截图/注入命令，像素落远端临时文件后用**现成的远端文件通道**
    （SFTP/RPC `remoteFs.readFile`）取回 —— 不占 `exec` 的 512KB 输出上限，也不另造传输。
    能力**靠探测不靠猜**：先问一遍 OS / 图形会话 / 装了哪些工具，探到什么承诺什么；
    缺工具就回「装哪个、怎么装」（X11: scrot|imagemagick + xdotool；Wayland: grim + ydotool；
    macOS: screencapture + cliclick 且要在系统设置里给 SSH 会话「屏幕录制 / 辅助功能」权限）。
    **「只能看不能动」不算故障**：缺注入工具时截图照常给，只有输入动作报
    `REMOTE_SCREEN_INPUT_UNAVAILABLE`。远端 Windows 暂未接入（`REMOTE_SCREEN_OS_UNSUPPORTED`），
    纯命令行服务器如实回 `REMOTE_SCREEN_NO_DISPLAY`，探测不全回 `REMOTE_SCREEN_PROBE_INCOMPLETE`
    （三者别混成一个）；`list_windows` / `activate_window` 在远端没有通道，如实不支持。
    截图中间产物只落远端 `/tmp`（传输允许根之一），读完即删，不往 `$HOME` / 工作区丢隐藏文件。
  - 两台机器共用同一道档位判定与同一个总开关：远端输入动作同样按上一段「会改变系统状态」判
    ask-once（审批在你面前发生；档位不区分远端/本机 —— 都是「往一台机器里注入输入」），
    但**授权粒度按机器分开**（本机 / 某台远端主机，换主机重新问）。
  - 坐标空间口径对两台机器一致：模型看到的那张图就是坐标空间，缩放发生在**本地**（按视觉预算
    缩小后再注入，注入前换算回远端原生像素），所以「按看到的位置点」永远点得对。
    `screenshot` 带 `region` 之后，后续输入动作 / 等待返回的**仍是同一块区域**
    （与本地执行体同口径）；要回整屏就再截一次整屏。macOS Retina 上截图是物理像素、
    注入工具与 `screencapture -R` 吃逻辑点，比例由探测脚本里的逻辑点宽度算出
    （`pointWidth`），换算在注入与裁剪之前做。
- 职责分层：`src/computer/service.js` 是纯执行体（Win32 注入 + desktopCapturer 截图 +
  坐标换算），`src/remote/ssh-screen.js` 是远端执行体（探测 + 命令拼装）；
  档位判定在 `sandbox-policy.js`、审批在 handler（`gateway/handlers/computer.js`），
  与 host.exec 的三层同构。参数数字上限在 `agent-limits.js`（`computer*` 字段）。
- **两条诚实契约**（模型只能靠工具结果判断现实）：
  1. 注入被系统丢弃 → `INPUT_DROPPED`。UIPI（管理员窗口）、锁屏、UAC 安全桌面下
     `SendInput` **不报错只返回 0**，所以所有注入都走 `win32-input.sendInputs` 校验
     投递数，不等就抛错（`retryable:false` + 「不要原样重复」。过去忽略返回值 → 回
     `ok:true` + 没变化的截图，模型只能凭信念继续点）。`type` 的 `typed` 同样是
     **实际投递成功**的字符数，中途被打断会带「已输入 N 字」。
  2. 动作已执行、动作后截图失败 → `applied:true` + `screenshotError`，**不抛错**。
     抛错会让模型原样重试，变成重复点击/重复输入；这条只在输入动作生效，`action=screenshot`
     失败仍照常抛 `CAPTURE_FAILED`（那一轮没有任何动作被执行）。
  回报类探测（光标 / 前台窗口标题）失败不影响结论：少一个字段，而不是把已执行的动作说成失败。
- **坐标空间 = 模型最近看到的那张图**（`coordinate-map.js` 的「视图」）：全屏截图与
  `screenshot` 的 `region` 裁剪共用同一套映射（`{originX, originY, nativeWidth,
  nativeHeight, width, height}`），所以裁剪即新的坐标空间 —— 裁出来的那块图上的坐标
  直接就是模型下一步的 `coordinate`。动作后仍交付**同一块区域**的新画面（`sameViewRect`），
  一串精细操作不必每步重新对全屏坐标；再截一次整屏就回到全屏坐标。
- **两条画面事实**（模型判断「这一下有没有反应」的唯一客观信号）：
  `changed=false` 表示与上次看到的那张图逐像素同帧（同一坐标空间才比，`sameViewSpace`；
  跨空间宁可不说）；`stable` 表示交付的这一帧是否已「连续两帧相同」（最多等
  `computerSettleMaxMs`，等不到就如实 `false`，不硬等也不拿糊的当事实）。
  等稳定比固定 sleep 更准：慢弹窗/列表加载不再被截半截。
- **修饰键**：`modifiers: ["shift"|"ctrl"|"alt"|"win"]`（`win32-input.withModifiers`）
  在 click 家族与 drag 期间按住 —— 区间选择、多选、ctrl 拖拽复制。键名唯一来源是
  `win32-input.MODIFIER_KEYS`，`tool-validate` 只引用不复制；拼错直接拒（静默忽略会变成
  「按普通点击执行」，比失败更难查）。释放放 `finally`，动作抛错也不会把键卡在按下态。
- **`wait_until`：用看代替猜**。`condition=changed` 等画面相对模型上次看到的那张图发生变化，
  `condition=stable` 等连续两帧相同；超时上限 `computerWaitUntilMaxMs`（默认值另给）。
  等到了返回变化后的画面；**等不到返回 `timedOut:true` + `changed:false`** 并明说
  「你等的那个变化没发生」—— 这通常是「上一步输入没生效」的信号，比等满一个固定毫秒数
  有用得多。平台给不出帧指纹（`frameSignature` 返回 null）时**不烧预算假装在等**，
  直接说「判断不了」。
- **`list_windows` / `activate_window`：切窗口不再靠点任务栏猜位置**。
  `list_windows` 走 `GetWindow(GW_CHILD/GW_HWNDNEXT)` 链枚举顶层窗口（不用 koffi 回调 ——
  回调是本模块唯一的高风险面），返回 z 序、标题、`handle`、是否最小化、所在屏，
  `rect` 换算到**模型当前截图的像素口径**（与 `coordinate` 同一套，可直接拿去点）；
  条数上限 `computerWindowListMax`。`activate_window` 的 `handle` 必须出现在
  **最近一次 `list_windows` 的结果里**（挡住编造句柄与提示注入里的句柄），激活结果以
  `GetForegroundWindow` 的实际返回为准（不看 `SetForegroundWindow` 的返回值）：
  非前台进程抢不到焦点时先投一次 Alt 重置前台锁重试，仍失败抛 `ACTIVATE_FAILED` 并
  提示改用点击或让用户点任务栏 —— 绝不假装切过去了（否则后续点击全打在错的窗口上）。
- 多显示器两条硬口径（`src/computer/capture.js`，改前必读注释）：捕获源只能按
  `display_id === String(Display.id)` 匹配（`Display` 上没有 `displayId` 字段，且
  `getSources()` 顺序与 `getAllDisplays()` 不一致，按序号猜会截到另一块屏）；
  显示器物理原点只能问系统 `screen.dipToScreenPoint`（`bounds.x × 本屏 scaleFactor`
  在混合 DPI 下会偏，实测 960px 且区间与主屏重叠）。`display` 序号恒以主屏为 0。

拒绝话术里**必须包含"不要重试"**（`sandboxErrorFor` 统一生成）：否则模型会反复撞同一堵墙，
把步数预算烧在不可能成功的调用上。

---

## 4. 设置与观测

- 设置页独立「沙箱」标签页里的档位点选 = 唯一旋钮（该页只放这一个旋钮，权限页不再重复展示；
  设置页也没有独立的「完全放开路径限制」复选框——它与档位是同一件事，纯重复展示已删）；
  「完全放开」的快捷入口是输入区图标，点一下等价于切档。图标与档位点选是同一旋钮的两个视图，
  互相同步，落盘只认 `sandboxMode`。
  切换后会立刻回写并重绘视图 —— 以前只写存储不重绘，开关状态会和档位对不上。
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
| SSH 远程工作区 | **已做（档位 + 传输边界）** | 远端写与远端命令按**远端根**判同一套三档（见 §1.1）：`read-only` 问一次、`workspace-write` 只放远端工作区 + `/tmp`、`danger-full-access` 放行；再受 `remoteAllowedRoots`（工作区 / `$HOME` / `/tmp`）外层约束。审批弹窗出现在**你面前**（桌面端），不需要远端有人 |
| SSH 会话里访问**本机**（反过来那半边） | **已做** | 会话工作空间是 SSH 时，`local:` 前缀的路径与 `host_exec local:true` 明确指「跑叠云这台机器」：走**本机**白名单 + 本机沙箱档位（与本地会话同一条链，`gateway/rpc.js:resolveFsTarget` 是唯一判定点）。不带前缀仍指远端 |
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
| `npx vitest run test/unit/computer-*.test.cjs` | computer 判定口径（截屏放行 / 输入 ask-once / danger 放行）、**动作枚举单一来源一致性（schema 描述 / 校验 / 沙箱只读集合 / 分发同源）**、组合键解析与安全序列拒绝、坐标换算（DPI/多屏/比例校正/**region 裁剪视图**）、参数校验（含 modifiers / region 归属 / wait_until 条件 / activate_window 句柄）、出站净化剥 base64、视觉缓冲 computer 来源挤旧留新、注入被丢弃 → INPUT_DROPPED、动作已生效但截图失败 → applied + screenshotError、**changed / stable / 区域保持 / 修饰键按住 / wait_until 超时 / 窗口清单与切前台** |
| `npm run test:local-gateway-smoke` | 白名单随档位变化，`unrestrictedPaths` 开关往返 |

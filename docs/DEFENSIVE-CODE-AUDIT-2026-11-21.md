# 防御性代码审计（2026-11-21 · 当前工作树）

> **口径**：AGENTS.md 原则 2 —— 降级层 / 兜底层 / 重试层 / 开关 / 配置项若只是「绕过」失败而不是「消除」失败，即为缺陷；原则 6 —— 同一判定只该有一个来源。
> **范围**：`src/`（538 个 `.js`）、`crates/`（110 个 `.rs`）、`scripts/`；排除 `dist/`、`node_modules/`、`target/`。按**当前工作树**（含未提交改动）判定。
> **方法**：12 个分域子审计通读 + 机械取证（空 `catch` / `.catch(() => {})` / `typeof x === 'function'` / `|| 默认` / `?? 0` / `Math.min|max` / 同一字段多别名 / 重复 `raw`），lead 抽查复核 P0 与全部 P1 的代表条目（下文标 ✅ 的已由我逐行核对）。
> **结果**：**68 条 —— P0 1 / P1 12 / P2 36 / P3 19**。

---

## 一、结论（先看这里）

仓库的整体防御姿态是**偏「显式失败」**的（§五 列了 12 处「这是合法防御，别动」的正例：`completionCapDefault` 缺键即抛、`request-snapshot` 截断必带 `truncated:true`、`remote-pack-layout` 越界即拒……）。本轮 68 条不是「到处都在兜底」，而是 **5 个根因在系统性复现**：

| # | 根因 | 条数 | 典型后果 |
|---|------|------|----------|
| 1 | **装配断裂被 `typeof` / `try` 探测吞掉** | 14 | 新加的关卡通不了电，旧缺陷原样复发（含唯一的 P0） |
| 2 | **吞错后返回默认值**（"失败"与"没有"不可区分） | 21 | 静默数据损失（撤回删文件、基准覆盖、记忆被归档） |
| 3 | **同一判定两份实现**（护栏漂移） | 9 | 一处拦一处放；两份给出相反行为 |
| 4 | **兜底默认值把上游 bug 变成正常值** | 15 | 排查方向被带偏（错误端点、错误上限、错误字段） |
| 5 | **重试 / 降级长在错的层** | 9 | 双重副作用、弱实现冒充成功 |

**止血点只有一条 P0**：子 Agent 只读护栏（`tool-gate.js` 的 `subagent-scope`）在生产链路上**永远不生效** —— 见 §二.1。

---

## 二、P0 / P1 清单（13 条，逐条带证据）

### 2.1 P0 · 子 Agent 只读护栏拿不到白名单，`if (!allowed) return;` 把「没通电」当成「不拦」 ✅**已修**

- **位置**：`src/agent/tool-bridge-main.js:685-704`（装配）+ `src/agent/tool-gate.js:514`（判据）✅
- **证据**：`tool-gate.js:512-514` 从 `call.harness.ctx` 取 `allowedToolNames`，取不到就 `return`（放行）；而 `harnessCtx` 是**逐字段手抄**的对象，列到 `wakeBudget` 为止 —— 全文件零处 `allowedToolNames` / `harnessRunKey`。`callContext()`（`tool-gate.js:159`）确实只读 `call.harness.ctx`，所以链路必然断在这里。
- **谁在传**：`rust-planner-runner.js:627`、`subagent-runner.js:425`、`src/main/ipc/agent-runtime.js:500` 都把表塞进 ctx，全部在这一跳丢失。
- **后果**：`subagent` 承诺的「只读、不改工作区」只体现在「没发给模型」；模型吐出表外名字（幻觉 / 别名归一成写类工具）就真的落到 `executeAgentTool` 写主工作区。这正是 `tool-gate.js:500-504` 注释里 2026-11-19 审计 P0-7 描述的事故，补丁写好了却没接上线。单测红不了，因为 `scripts/test-tool-gate.cjs:356-376` 手搓 `harness.ctx`，正好绕过断层。
- **减法**：`const harnessCtx = { ...ctx, userDataPath }`（一个传递点，加字段不用改两处）；`if (!allowed) return;` → `allowed.length === 0` 明确拒绝 `SUBAGENT_TOOL_SCOPE`；夹具改走真链路 `createMainToolBridge().executeAgentTool()`。

### 2.2 P1 · 撤回快照读失败被当成「文件原本不存在」→ 撤回时删掉用户文件 ✅**已修**（本机 + 远端两个分支）

- **位置**：`src/gateway/handlers/fs.js:620-622` ✅（同形态 `:559`、`src/undo/turn-undo-service.js:628`）
- **证据**：`try { beforeText = await fs.readFile(safe, 'utf8') } catch { beforeText = null }`；而撤回侧 `src/gateway/rpc.js:885-895` 对 `item.before == null` 走 `fs.unlink` / `rm -rf`。读失败（占用、权限、编码）≠ 文件不存在，两者在撤回时不加区分。
- **减法**：读失败抛 `UNDO_SNAPSHOT_UNAVAILABLE`（撤回入口据此拒绝），只有 `ENOENT` 才允许 `before = null`。

### 2.3 P1 · 视觉基准读失败被当成「还没有基准」→ 覆盖用户已有文件 ✅**已修**

- **位置**：`src/gateway/handlers/browser.js:130-132` ✅
- **证据**：函数头注释自己写着「只有『文件确实不存在 / 读不出来』才返回空 buffer」—— 把两种语义合并成 `buffer: null`，`src/browser/service.js:614` 据此回写新基准并提示「已保存为新基准」。
- **减法**：只有 `ENOENT` 返回 `null`，其余错误上抛。

### 2.4 P1 · 摄像头权限闸「读不到权限快照就放行」，注释承诺的执行层兜底并不存在

- **位置**：`src/agent/tool-gate.js:214-215` + `permissionSnapshot()` `:232-243` ✅
- **证据**：`if (!perms) return; // 拿不到权限快照时不假装拦截：执行层另有失败兜底`。实际执行层 `src/agent/main-tools/camera.js` 三个 handler（`:23-89`）没有任何权限判断，`gateway/rpc.js` 只对 `computer` 有 `assertOsControlEnabled`。即「读权限文件失败」= 「拍现实世界的闸失效」。
- **减法**：删 `catch { return null }`，快照读不到即 `block PERMISSION_UNAVAILABLE`（fail-closed，与心跳轮的 `WAKE_POLICY_DENIED` 同姿态）。

### 2.5 P1 · 「是否在根下」多了第二、第三份实现，`..eslintrc` 类文件被判越界

- **位置**：`src/agent/delegate-tool-gateway.js:21-24`（`path.relative` 版）与 `:27-32`（POSIX 版）✅
- **证据**：唯一来源是 `src/gateway/sandbox-policy.js:379 isUnder`（导出在 `:769`，`tool-gate.js` 已经 import 它并留了「不许各写一份 `path.relative`」的注释）。这里两份自写版被 `createWorkerWriteScope` 的 `map` / `mapRead` 使用：`path.relative('E:\ws','E:\ws\..eslintrc')` → `'..eslintrc'` → 以 `..` 开头 → 判越界，worker 写副本里的 `.eslintrc` / `..cache/*` 会拿到 `WORKER_SCOPE_DENIED`。
- **减法**：删两份，改调 `sandbox-policy.isUnder(...)`；验收 `git grep "startsWith('..')" src/agent` 归零 + 补一条 `..eslintrc` 用例。

### 2.6 P1 · 历史投影 helpers 靠 `typeof` 探测，Main 侧静默退化成另一份更弱的实现

- **位置**：`src/agent/session-context.js:499-507`（探测）+ `:1035-1041`（默认 helpers 只有三件）✅
- **证据**：`assistantTextFromMessage` 对 `unpackAssistantMeta` / `splitPersistedAssistantTrace` / `toolFallback` 各做一次 `typeof` 探测并给空实现；`completionHistoryHelpers()` 只回三件，**没有** `toolFallback`、**没有** `splitPersistedAssistantTrace`。桌面侧传完整版，Main 侧（频道 / headless / 计划）读同一条历史行时：落库为 `(空响应)` / `已停止生成。` 的那一轮，桌面会把工具事实折回来，Main 原样喂给模型；`【思考过程】…---…正文` 包封也不拆（思考进正文）。
- **减法**：helpers 去可选化（缺就 `TypeError`），把两个缺失语义搬进 Main 可 require 的单一模块，让 `completionHistoryHelpers()` 回完整集合。

### 2.7 P1 · 同一份工具参数双写 `toolArgs` 与 `args`，下游靠 `||` 猜

- **位置**：`src/agent/live-loop-trace.js:303-311`，`mergeTraceTools` `:430-445`
- **证据**：写两遍、读 `tool.toolArgs || tool.args`、合并四路（`rust.args` / `rust.toolArgs` / `live.args` / `live.toolArgs`）。真实读者只认 `toolArgs`（`renderer-tool-results.js:363`、`renderer-undo-stack.js:245` 等）。只更新一边就是过期副本，思考区/撤销栈显示上一次的参数。
- **减法**：`toolArgs` 定为唯一字段，删 `args` 的写入与读出（含 `agent-round-text.js:170`、`plans/plan-run-events.js:143,150` 的转手）。

### 2.8 P1 · 归纳器维护链三步全部 `.catch(() => {})`：长期记忆永不衰减、项目记忆文件恒空

- **位置**：`src/agent/knowledge/run.js` / `knowledge-maintainer.js` 的衰减·归档、向量重建、`materializeProjectMemoryFile`（子审计定位到 `knowledge-maintainer.js:301,360,368` 同类三处）✅（同类三处已核）
- **证据**：没有日志、不写 `lastRunSummary`、无台账。失败与「本来没有可维护的东西」对外完全同形；设置页仍显示按时成功。
- **减法**：三步各留一行 + 写进 `lastRunSummary`；不加退避（错误原因就在返回值里）。

### 2.9 P1 · 账本自愈把「重挂 scope」的失败吞成 0，然后照旧整批归档 project 行

- **位置**：`crates/dieyun-memory/src/memory/misc.rs:128-138` ✅
- **证据**：`migrate_legacy_project_scopes().map(...).unwrap_or(0)`，紧接着 `UPDATE long_memories SET status='archived' WHERE scope='project'`；而 `:126-127` 注释写明「顺序不能反：先归档就会把可认领的行一起埋掉」。归档行不参与召回 → 「写进去却搜不到」。
- **减法**：`.unwrap_or(0)` → `?`，失败即整次自愈返回 Err，交给既有 `obs::degraded("memory.reconcile")`。

### 2.10 P1 · 同一个 rekey 有「留一行」与「`let _` 丢掉」两份，两处调用点走静默版

- **位置**：`crates/dieyun-memory/src/memory/projects.rs:105`、`:128`（对照 `:251-258 rekey_scope_logged`）
- **证据**：同文件 `rekey_scope_logged` 注释写明「必须留一行 —— rekey 没成功时那批记忆对带 scope 的召回永远不可见」。失败有没有痕迹取决于走哪条分支。
- **减法**：两处改调 `rekey_scope_logged`，日志口径只留一处。

### 2.11 P1 · best-of-N 选优解析失败静默取第 1 路，界面仍写「已选方案 1/N」

- **位置**：`crates/dieyun-runtime/src/planner/prompts.rs:430-431` + `planner/best_of_n.rs:120-131`
- **证据**：`unwrap_or(1)` + `idx.max(1).min(attempt_count)` + `.or_else(|| collected.first())` 三层兜底都指向「第 1 路」。N 路的钱已经花掉，交付的是先到先得那一路，trace 还替它作证。
- **减法**：`parse_best_of_n_winner` 返回 `Option<usize>`，`None` 就明确报错并把「本次没有交叉验证」写进 trace。

### 2.12 P1 · 「放弃全部」的销毁性清理失败被吞，随后仍弹「变更已丢弃」

- **位置**：`src/renderer/agent/worktree-ui.js:312-325` ✅
- **证据**：`worktreeCleanupRun(... { allowDiscardUncommitted: true, deleteBranches: true }).catch(() => {})`，紧接着 `showAgentToast('已放弃变更', 'Worktree 变更已丢弃')`。失败时未提交产出仍在、分支仍占着，用户以为干净了。
- **减法**：cleanup 结果参与判定，失败回显并保留待审行。

### 2.13 P1 · 信任授权失败无声（同文件的解除绑定路径有 toast）

- **位置**：`src/renderer/renderer-peer.js:1073-1077` ✅
- **证据**：`decidePeerTrust(peerId, 'allow').catch(() => {})`；对照 `:1079-1081` 的 `openPeerChat` 明确 toast，`:1059-1063` 的 unlink 也有 error toast。授权失败后面板不刷新、状态不变、无提示。
- **减法**：复用 unlink 的 toast 分支，删空 catch。

---

## 三、P2 / P3 清单（55 条，按域压缩成表）

> 每条一行：`文件:行` · 现象 · 减法。P2 = 会静默改变行为或掩盖故障；P3 = 冗余、死分支、口径不一。

### 3.1 src/agent（25 条）

| 级别 | 位置 | 现象 | 减法 |
|------|------|------|------|
| P2 | `rust-loop-runner.js:56-65` | `getAgentLimits` 失败吞成 `{}`，用默认上限照发（同文件 `:441` 读同一份却不吞） | 删 try/catch，异常冒到 `loop_failed` |
| P2 | `session-context.js:926` | `Math.max(4000, caps.requestMaxChars - …)` 地板：已超「硬上限」仍静默照发，audit 不记超多少 | 删地板；`room <= 0` 时记 `overRequestCap` 或报错 |
| P2 | `session-context.js:23` | `visionPartEqChars` 缺键静默退 6000（第二份数字来源），同文件 `completionCapDefault` 却缺键即抛 | 改走 `completionCapDefault` |
| P2 | `main-turn-runner.js:453-476` | `afterAgentRun` 返回值被丢弃 + 空 catch；真正的失败形态（`ok:false`）无日志 | 判返回值，`ok:false` 且非 `no_maintainer` 时告警一次 |
| P2 | `run-events.js:84` / `:202` | 未知事件类型静默改写成 `trace`：拼错终止类型 → live 永久「运行中」 | 非法类型抛错 |
| P2 | `tool-harness.js:150-157` | 进展探针 `require` + `typeof` 双兜底，拿不到就退回 45 分钟窗口（还原已修的误杀） | 顶层 require（无环），取不到就抛 |
| P2 | `main-tools/mcp.js:63-75` | 向量召回失败就地换「描述 includes」子串匹配，仍回 `ok:true` | 返回 `MCP_RECALL_UNAVAILABLE`；要保留关键词就做成显式 `mode` |
| P2 | `completion-readiness.js:484-486` / `:517-519` | 浏览器证据采集失败被吞成「0 条错误」，唯一会挡交付的判据静默失效 | 记 `consoleUnavailable`，note 区分「0 错误」与「没查到」 |
| P2 | `agent-limits.js:1578` | Renderer→Main 的整表同步 `.catch(() => {})`：用户改小的上限可静默不生效 | 留日志或让设置页提示「需重启」 |
| P2 | `system-prompt-prep.js:1019-1026` | `enabledMap()` 读失败当空表 → 用户关掉的技能被重新注入（叠在 store 层已有兜底之上） | 删 typeof + try，状态由 `enabled-store` 给 |
| P2 | `system-prompt-prep.js:1040-1056` | 技能召回失败静默退「已启用前 N 条」，错误对象丢弃；`typeof recall === 'function'` 为假时整块技能消失 | catch 留一行；装配期报错替代探测 |
| P2 | `session-context.js:486,554,732,964` | 另外四组 `typeof helpers.X ? X : 弱实现`（`(raw)=>({content:raw})` 会把 meta 封套当正文） | 同 §2.6 |
| P2 | `live-loop-trace.js:393-397` | 路径在 `filePath/path/file/result.path` 四名间猜，并回填进参数（模型没传的字段出现在参数摘要里） | 规范名由 catalog/结果层给，只读 `toolArgs.filePath` |
| P2 | `knowledge-maintainer.js:301,360,368` | 定时归纳三处 fire-and-forget（同文件队列路径 `:177` 反而有日志） | 与 `:177` 同句 |
| P3 | `main-turn-runner.js:391` | 又手写一份 `trace.reduce` 计数，与 `agent-round-text.countTraceTools` 重复 | 调单一来源 |
| P3 | `rust-loop-runner.js:292` | `round.prepare` 挂不上时 `typeof` 探测静默跳过：视觉注入与请求裁剪整轮消失 | 明确抛错 |
| P3 | `subagent-runner.js:104-129` | 上限解析三层盖事实：`n > 0` 让合法 0 变默认（已踩过一次）、`catch` 全量回落、逐键 if 打补丁 | 「哪些键允许 0」收进 `agent-limits` 的键表 |
| P3 | `tool-validate.js:423,445-454,714,722` | 生成物已覆盖的手写机械分支（不可达）+ `String(a.action \|\| 'status')` 给必填字段兜默认值 | 删死码；补 `browser_click/hover/drag` 的 `anyOf` 到 catalog |
| P3 | `catalog/groups.js:99` | `filter(Boolean)` 静默丢掉拼错/改名的工具名：清单里有、模型看不见 | 加载期断言命中 |
| P3 | `llm-channel.js:129-130` | `reasoningField: ''`（声明「没有思考通道」）被候选表压过 | 声明即只认声明 |
| P3 | `llm-complete.js:81` | 给了 `llm.headers` 就整条绕过 `buildLlmHeadersFromConfig`（`apiKey`/`authMode` 全不生效） | 自定义头经同一份归一化合并 |
| P3 | `llm-request.js:64` | 未知 `kind` 静默退化成 `chat` 端点 | 四值枚举写死报错 |
| P3 | `session-context.js:832` | `trimMessagesToCharBudget` 入参先浅拷整份 messages（函数本身不改写入参，姊妹函数也不拷） | 与 `:715` 对齐 |
| P3 | `agent-synthesis.js:238` | `isAbortError(err) \|\| err.name === 'AbortError'` 第二支恒冗余 | 删第二支 |

### 3.2 crates/（15 条）

| 级别 | 位置 | 现象 | 减法 |
|------|------|------|------|
| P2 | `memory/session.rs:306-308` | `sanitize_persisted_message(...).unwrap_or_else(\|\| content)`：`None` 同时表示「无需改动」与「解析失败」→ 坏 meta 原样落库 | 返回 `Result<Option<String>>`，解析失败走 `obs::degraded` 并剥 meta |
| P2 | `memory/snapshot.rs:26-30,201-203` | 保留上限在 Rust 另抄一份 `40/200/1500`（Node 侧确实会传 `undefined`） | 三字段改必填，或进 `agent-shared.json` |
| P2 | `planner/trace.rs:153` | `worktree_ctx.unwrap_or_else(\|\| json!({}))`：与上一行注释点名要删的写死实现同形 → 「声称改了却零 diff」的规则静默失效 | `Option` 保持到提示词层 |
| P2 | `agent/loop_run/mod.rs:321,332` | `handle.lock().map(\|s\| s.cancelled).unwrap_or(true)`：毒化被读成「已取消」，活着的 run 从账本里被删 | 走 `lock_run` → `AGENT_BUSY`，或 `into_inner` 正读 |
| P2 | `rpc/calls.rs:115` | `(None, None) => Ok(Value::Null)`：协议违约帧被读成一次成功调用 | 报 `HOST_CALL_PROTOCOL` |
| P2 | `codebase/index/search.rs:100-116` | `chunk_count` 的 `unwrap_or(0)` → 报「还没建索引」，把查询失败说成正常状态 | `.optional()?` |
| P2 | `codebase/graph/query.rs:131` | 读不出的行当没有这行：结果静默变少仍回 `ok:true` | 失败上抛 |
| P3 | `memory/longmem.rs:197-204` | 去重查询 `if let Ok(existing)`：查错与「没有重复」合并 → 去重护栏 fail-open | `.optional()?` |
| P3 | `embedding/remote.rs:175-218` | 回包认四种形状，三种用 `filter_map` 静默丢元素 | 只保留 OpenAI 兼容一种，写进文档 |
| P3 | `embedding/local.rs:385-391` | 找不到 `last_hidden_state` 就取「第一个输出」→ 换模型变成静默错向量 | 只按约定名取 |
| P3 | `compaction/fold.rs:110-134` | `token_budget.max(4096)` / 触发比 clamp / `keep_tail_atoms.max(1)`：预算给错永远不被看见 | 越界 `INVALID_PARAMS` |
| P3 | `memory/snapshot.rs:393-398` | 坏 JSON 列读成 `Null`，与「没有审计事实」混同 → 注入率分母被做小 | 单列 `unparsable` 计数 |

### 3.3 src/gateway · lsp · browser · undo（6 条）

| 级别 | 位置 | 现象 | 减法 |
|------|------|------|------|
| P2 | `undo/turn-undo-store.js:430-431` | debounce 落盘 `.catch(() => {})`（同文件 `:406` 写明「落盘失败必须有人看见」） | 复用 immediate 分支的留痕 |
| P2 | `handlers/lsp-workspace.js:350`、`:385` | 对恒存在的自家服务做 `typeof` 探测，判断恒真；改名即静默落到弱路径 | 删探测与重复判定 |
| P2 | `handlers/browser.js`→`browser/service.js:940` | `typeof pwRunner.clearCookies === 'function'` 为假时只清 BrowserView 就报 `ok:true` | 直接调，缺失在装配期暴露 |
| P3 | `handlers/workspace.js:59` | 远端 stat 失败写成 `size:0/mtime:0`，最新候选被排到末尾并截断 | 保留 `statFailed` 标记 |

### 3.4 src/ssh · remote · git · main · headless（6 条）

| 级别 | 位置 | 现象 | 减法 |
|------|------|------|------|
| P2 | `main/ipc/agent-runtime.js:879-881` | 缺本轮端点就回落磁盘 settings，还认 `baseUrl/builtinBaseUrl` 两个名字 | 缺 `apiConfig` 显式报错 |
| P2 | `main/ipc/agent-runtime.js:189` | `evaluateTurnReadiness` 抛错吞成 `readiness = null`：验收 note 静默消失 | 删这层 catch |
| P2 | `git/worktree-service.js:82` | 未知变更种类一律落 `modified` | 未知值抛错 |
| P2 | `headless/desktop-ui.js:728` | 缺 `getRustCoreReady` 就当「core 已就绪」（写进 `RUST_CORE_READY`） | 缺即 `false` |
| P3 | `remote/remote-pack-layout.js:245` | `st.isFile` 探测失败返回 `true`：preflight 闸门假通过 | 直接调，异常归 missing |
| P3 | `main/activity-stats.js:132,134` | `mouseClicksToday ?? mouseClicks`、`tokensTotal` 同类回落 | 定一个字段名 + 一次迁移 |

### 3.5 src/renderer · mobile（4 条）

| 级别 | 位置 | 现象 | 减法 |
|------|------|------|------|
| P2 | `renderer-agent-llm.js:237-256` | `window.LlmReconnectRetry` 缺失时降级为单次尝试（只 console.warn） | 符号缺失即抛（bundle 未重建是装配错误） |
| P2 | `renderer-tool-defs.js:265` | 弱模型召回上限 `Math.min(5, …)`，另一处 `renderer-context-engine.js:93` 兜底 10：两个数字都写在 Renderer | 上限（含弱模型档）只留 `agent-limits` |
| P2 | `renderer-artifacts.js:29` | 产物路径提取三份（`artifactPathFromTool` / `toolArtifactPath` / `editToolFilePath`）靠 `typeof` 互兜 | 只留一份 canonical，缺失即抛 |
| P2 | `mobile/public/app.js:1185` | 手机端自抄一份 `【叠云meta】` 剥离正则（`session-context.js:43-51` 已声明唯一来源） | 出站前由 bridge 剥好 |

### 3.6 src/channels · peer · alive · plans · goals · mcp · memory-shared（6 条）

| 级别 | 位置 | 现象 | 减法 |
|------|------|------|------|
| P2 | `channels/runtime.js:189-190` | 对同目录自家导出做 `typeof` 探测，恒真；改名即静默不刷新 `updatedAt` | 删探测 |
| P2 | `channels/runtime.js:202-210` | 会话不存在时**整轮 `runTurn` 重跑**，还用 `message.includes('SESSION_NOT_FOUND')` 猜码 | 只认 `e.code`，删二次 runTurn |
| P2 | `memory-shared/service.js:381`、`:615` | `Number(importance)/5 \|\| 0.5`：缺值与 0 都落成中值，`upsert` 用 GREATEST 后再也降不下来 | 抽 `normalizeImportance`，缺值报错 |
| P2 | `mcp/manage.js:168` | 装/升级后重挂会话 `.catch(() => {})`，而这是「工具表指向新包」的唯一保证 | 让失败随 `apply` 抛出 |
| P3 | `alive/recap.js:107,110,118` | `row.updatedAt \|\| row.updated_at`（注释已写明 Rust 只回驼峰） | 只读 `updatedAt` |
| P3 | `goals/session-goal.js:96` | `res.goalJson ?? res.goal_json`（Rust 只回驼峰） | 只读 `goalJson` |

---

## 四、按类别汇总

| 类别 | 条数 | 代表位置 |
|------|------|----------|
| 静默吞错 | 21 | `gateway/handlers/fs.js:621`、`memory/misc.rs:131`、`knowledge-maintainer` 三处、`worktree-ui.js:317` |
| 兜底默认值 | 15 | `tool-gate.js:514`（P0）、`llm-request.js:64`、`worktree-service.js:82`、`snapshot.rs:201` |
| 能力探测兜底 | 14 | `tool-bridge-main.js:685`（P0 装配）、`session-context.js` 五组、`tool-harness.js:153`、`browser/service.js:940` |
| 降级层 | 9 | `main-tools/mcp.js:63`、`renderer-agent-llm.js:242`、`agent-runtime.js:879` |
| 重复护栏 | 9 | `delegate-tool-gateway.js:21`（vs `sandbox-policy.isUnder`）、`projects.rs:105`、`main-turn-runner.js:391` |
| 重试退避层 | 9 | `channels/runtime.js:202`（整轮重跑）、`session-manager.js` 退避（⚠ 属外部边界，未计入缺陷） |
| 多形状适配 | 7 | `live-loop-trace.js:303`、`activity-stats.js:132`、`alive/recap.js:107`、`goals/session-goal.js:96` |
| 夹取掩盖 | 5 | `session-context.js:926`、`renderer-tool-defs.js:265`、`compaction/fold.rs:110` |
| 防御性拷贝 | 1 | `session-context.js:832` |
| 重复校验 | 1 | `tool-validate.js:445` |

---

## 五、这是合法防御，别动（抽样 12 处）

1. `src/agent/session-context.js:653` —— `completionCapDefault` 缺键即抛（「静默拿到 undefined 会让整条预算失效」）。**这是本仓该有的失败姿态，也是 §3.1 三条的对照物。**
2. `src/agent/request-snapshot.js:118` —— 超上限写结构化信封（`truncated:true` + chars + hash + 头尾预览），显式标注而不是悄悄改小。
3. `src/agent/request-snapshot.js:189` —— systemText 超限写 `NULL` 且注释钉死「NULL 只有一种含义＝没落库」。
4. `src/agent/rust-loop-runner.js:636` —— 上下文溢出停机：正文照交付，但 `stopReason: 'context_overflow'` 明确。
5. `src/agent/tool-gate.js:341` —— 根为空时拒绝，绝不回退 `process.cwd()`。
6. `src/agent/tool-gate.js:365` —— 心跳轮沙箱判定 fail-closed（`WAKE_POLICY_DENIED`）。
7. `src/agent/main-tools/index.js:28` —— handler 表 `Object.create(null)`，挡 `toString` / `constructor` 工具名。
8. `src/agent/knowledge/shared-memory.js:101` —— `!applied.ok` 必须 `throw`，把失败记进台账。
9. `crates/dieyun-base/src/shared.rs:111` —— 共享常量漏字段直接 panic（「宁可启动就炸」）。
10. `crates/dieyun-base/src/sqlite.rs:289` —— 脏事务先 `obs::degraded` 再 ROLLBACK。
11. `crates/dieyun-base/src/embedding/local.rs:110` —— 探活把「无 onnx / 无 tokenizer / dylib 失败」逐条翻成人话。
12. `src/llm-reconnect-retry.js` —— 全仓唯一许可的重连/退避点（其余重试层都应指向这里或删除）。

---

## 六、建议执行顺序

**第 0 批（止血，半天）**：§2.1 的 P0（装配改 `{...ctx}` + `allowed.length === 0` 拒绝 + 夹具走真链路）。✅ 已落地，见 §八。

**第 1 批（数据损失，可独立提交）**：§2.2 / §2.3（撤回删文件、基准覆盖）✅ 已落地、§2.9 / §2.10（记忆被归档 / rekey 静默）—— 共同手法都是「把 `Err` 收窄成 `Option`」，改动局部、可加单测。

**第 2 批（护栏漂移）**：§2.4（权限 fail-closed）、§2.5（`isUnder` 合流）、§2.6（历史投影 helpers 去可选化）、§2.11（best-of-N 选优）。这四条都要「删一份实现」，不是在原处加判断。

**第 3 批（默认值 → 显式报错）**：把 §三 里 15 条「兜底默认值」按影响面从大到小改；判据统一成「内部不变量缺字段 = 抛，外部边界缺字段 = 0/空」。

**不建议做**：给上面任何一条加「重试 / 开关 / 二次兜底」。本轮的 68 条里，凡是「再加一层」的方案都已剔掉。

---

## 七、取证与局限

- **子审计 12 个域**：agent-loop / agent-guards / agent-context / rust-base-memory / rust-runtime / host-tools / infra / renderer / features（补扫 4 域）。每域要求引文逐字可查。
- **lead 复核**：P0 全链路（`harnessCtx` → `callContext` → `hookSubagentScope` → 三个派发方的 `allowedToolNames`）、§2.2–§2.5、§2.6、§2.9、§2.12、§2.13 已逐行核对；其余 P2/P3 未逐条复核，引用行号以子审计为准（本机 `Get-Content` 对 LF-only 文件会漂行号，子审计用的是 `ripgrep`）。
- **未覆盖**：`scripts/`、`test/` 的测试夹具、`.github/workflows`；`src/browser/*-script.js`（注入脚本）与 `bundle.js` 生成物。
- **与既有审计的关系**：`docs/ARCHITECTURE-DEBT.md` 的 12 条结论、`docs/CODE-CLEANLINESS-REVIEW-2026-11-21.md` §8.2「先不动」5 条均未重复计入；§2.1 与 §3.1 的两条是**工作树里新长出来**的（`git diff` 可见 `tool-gate.js +44`、`session-context.js` 新增 `completionHistoryHelpers`），旧报告未覆盖。

---

## 八、执行记录（2026-11-21 · 第 0 批 + 第 1 批前两条）

| 条目 | 改了什么 | 为什么这样改（减法） |
|------|----------|----------------------|
| §2.1（P0） | `tool-bridge-main.js` 的 `harnessCtx` 由逐字段手抄改成 `{ ...ctx, workspacePath, userDataPath }`；`tool-gate.js` 的 `hookSubagentScope` 区分 `null`（不是子 Agent）与 `[]`（是子 Agent 但表为空 = 全拦） | 传递点从「N 个字段手抄一遍」变成「一份 ctx 透传」，归一仍在 `toolGate.callContext` 一处；没有新增开关 |
| §2.2 | `handlers/fs.js`：本机分支读失败抛 `UNDO_SNAPSHOT_UNAVAILABLE`（只有文件不存在才允许 `before=null`），远端分支按同一判据；新增 `undoSnapshotUnavailable()` 造错 | 复用本仓既有约定（撤回侧 `before==null` = 删除分支），失败方向选「这次写不生效」而不是「撤回时删文件」 |
| §2.3 | `handlers/browser.js`：`readArtifactIfExists` 只把「确实不存在」返回 `null`，其余错误上抛 | 与该文件头注释记录的原始事故同一条判据；不再新增「基准读不到」的标记位 |
| 判据单一来源 | 新增 `gateway/path-policy.js#isPathMissingError`（`ENOENT` / SFTP 2·11·`NO_SUCH_FILE` / 远端 RPC 码 / ssh2 文案），并让 `ssh/session-manager.js` 删掉自己的 `SFTP_NO_SUCH_FILE` 改用它 | 一处判据替代 4 处（本机 fs.write / 远端 fs.write / 视觉基准 / SFTP 浏览错误）各自为政；**净删一张重复码表** |
| 回归夹具 | `scripts/test-tool-gate.cjs`：新增「空白名单全拦」与**经 `createMainToolBridge().executeAgentTool` 真链路**的用例（并验证被拦的写调用不落盘）；新增 `test/unit/gateway-missing-path.test.cjs`（7 条：判据映射、撤回读失败即失败、新建仍放行、基准目录不报「已新建」） | 原夹具手搓 `harness.ctx`，正好绕过 §2.1 的断层 —— 夹具改走真链路才能防复发（已实测：把 `allowedToolNames` 从 `harnessCtx` 拿掉，新用例立刻红） |

**验证**：`npm run test:unit`（252 文件 / 2425 条全绿）、`npm run test:agent`、`npm run test:tool-gate`、`npm run test:tool-bridge-handlers`、`npm run test:tool-bridge-delegate`、`npm run test:sandbox-gateway`、`npm run test:local-gateway-smoke`、`npm run check:js`（tsc 无输出 = 干净）。

**留白（有意不动）**：`src/undo/turn-undo-service.js:622-632` 是同一手法（读失败记 `before: null`），但它属于「计划应用前的快照」，改它要连带定「捕获失败时 plan apply 是中止还是降级」，且该文件 `:741-744` 已有一条 `contentDropped` 的处置先例可参照 —— 单列到下一批，不在这一批里顺手改。

# SSH 会话索引「永远创建中」：根因与修法

> 来源：现场会话 `s-1793426278217-cf224b4`（`sess-01032a90`，dieyundaizhang）准备区两条红框
> ——「本会话工作区代码索引创建中，本次不等待」「本会话工作区结构索引创建中，本次不等待」。
> 取证：`request_snapshots` 14 条快照 + `messages_json` 工具结果；对照历史 SSH 会话 40 组。
> 本文只谈 **dieyunagent 仓内**要改什么，不改远端宿主、不改 Rust 侧建库算法。

## 0. 结论先行

| 判断 | 事实依据 |
|---|---|
| **不是「每轮重建同一份索引」** | 文案动词由 `st.indexed`（= `indexed_at > 0`）决定：「创建中」⇔ 该路径的库里**从来没有一次完整建库**，不是删了重建（`renderer-agent-prep.js:295`、`index/mod.rs:355-362`） |
| **是「每个会话一份冷库 + 每轮重新发起 + 建不完」** | SSH 会话工作区 = `…/.dieyun/worktrees/sess-<sha1(sessionId)>/main`（`remote-worktree.js:32`），索引库在 `<ws>/.dieyun/index.sqlite`，**跨会话永不复用**；prep 每轮都 `status → start` 且**一律不等待**（`renderer-agent-prep.js:351-452`） |
| **这一轮实际一个索引都没用上** | 该会话 14 条快照里 `repo_map`（`枢纽文件`）与 `【相关代码` 出现 **0 次**；模型全程 `host_exec` / `grep` / `glob` / `fs_read_file` |
| **向量从来没参与** | prep 发起的建库固定不带 `vectors`（`handlers/codebase.js:61-69` + `index/mod.rs:673` 向量 opt-in）；`codebase_search` 走子串/关键词通道 |

一句话：**这不是「更新还是重建」的问题，而是「这条链路上索引从未建成过」，而 UI 把它画成了一行永远不变的「创建中」。**

## 0.5 撤回一个错误推论：`codebase_search` 0.05% **不能**用来判定「语义检索没价值」

`docs/INDEX-VALUE-REVIEW.md` §3 的「7 天 8345 次调用里 `codebase_search` 4 次」曾被本方案用来推荐「砍掉片段索引」（旧版 P1 丙案）。**这个推论作废**，因为该数字同时被三处缺陷污染，任何一处都足以把它压到 0：

| # | 缺陷 | 证据（本机可复现） |
|---|---|---|
| 1 | **向量这条路实际上永远不开启** | `vectors:true` 全仓只有一处调用点：`renderer-codebase-panel.js:304`（面板「建向量」按钮）。agent 路径 `handlers/codebase.js:61-69` 固定 false；增量调度器仅在 `vectorCount>0` 时沿用（`codebase-incremental-scheduler.js:99`）。SSH 每会话一份库 ⇒ 要有向量就得**每会话手点一次全仓 embedding** |
| 2 | **没有向量时，词法通道对中文长句必然 0 命中** | `search.rs:250` 按空白/标点切词元，`LIKE '%term%'` 扫 `chunks`；中文问句整句就是一个词元（如「root每次必须手动输入密码登录」），代码里不会出现 ⇒ 0 命中。`context-signals.js:78` 命中为空直接返回 `''` ⇒ **模型侧看到的是「没有相关代码」，不是「没有索引」** |
| 3 | **索引常常压根没就绪** | SSH 会话冷库 + prep 每轮跳过（本文 §1）；本地也只在 prep 那一刻判一次 |

再加一条独立的反证：`tool-telemetry.jsonl` 现有 **2076 次工具调用里 `codebase_search` 0 次、`graph` 0 次、`lsp` 0 次**，`read_symbol` 11 次里 **9 次失败**；而 `messages` 里**从未出现过** `INDEX_REQUIRED` / `INDEXING_IN_PROGRESS` —— 说明模型不是「试了被拒」，而是**学会了不试**。用这种样本去评估语义检索的价值，等于用「没通电的灯泡从没亮过」证明灯泡没用。

**结论**：先让它能亮，再评估。P1 的推荐因此从「砍掉片段索引」改为「修好 + 两周实测」。

## 1. 现状（代码级事实）

| 机制 | 位置 | 后果 |
|---|---|---|
| SSH 会话 = 一个 git worktree，索引库在工作区内 | `src/ssh/remote-worktree.js:32-45`、`src/remote/remote-index-core.js:157-173` | 每个新会话一份**空库**；「更新中」在 SSH 下几乎不可达 |
| prep 门闩：status → 就绪则注入 → 在跑则只提示 → 未建则 start → **一律不等待** | `src/renderer/renderer-agent-prep.js:351-452` | 每一轮都会重新判一次、必要时重新发起；失败也照样放行 |
| 「创建中/更新中」由 `indexed_at` 决定，detail 不带路径、不带错误 | `renderer-agent-prep.js:264-303`；`lastError` 只在 `!indexing && !indexed` 时才显示（`:415-419`） | 正在跑时**永远盖住错误**；用户无法区分「首建」「卡住」「建在别的路径」 |
| 远端索引调用**静默丢弃**显式 `workspaceRoot`，一律用调用作用域 `remotePath` | `src/gateway/rpc.js:1225-1263` + `:626-662`（`workspaceRoot: ctxInfo.remotePath`） | 同一份「工作区」有两个来源：渲染端传的、作用域解析的。现场已看到错位：`host_exec` 的 `pwd` 是主仓库 `/run/media/…/dieyundaizhang`，而系统提示与 `fs_read_file`/`grep` 结果都是 `…/worktrees/sess-01032a90/main` |
| 建库与对话 RPC 共用远端 core | 同进程 | 同轮 `memory_recall` → `dieyun-core 超时: memory.long_recall`（`CORE_RPC_TIMEOUT`）；建库在跑时记忆召回直接被拖死 |
| `graph`/`codebase` 的 `status` 语义**是对的**（`indexing` 只在真有任务时为真） | `index/mod.rs:234-362` | 所以「创建中」不是假象：那一刻真的有任务在跑，只是**没跑完过** |

## 2. 修法：三批，各自可独立上线

### P0-A｜文案可诊断（Renderer，最小面）

**问题**：`formatPrepIndexProgress(st, kind, mode)` 只知道状态，不知道「哪个库」，且错误被进度盖住。

**改法**（`src/renderer/renderer-agent-prep.js`，唯一文案成形处）：

1. 加一个参数 `rootOfIndex`（由 `ensurePrepIndexReady` 从 `resolveIndexRoot()` 的结果传入，见 P0-B），文案变成：
   - 首建：`后台首建 代码索引 · dieyundaizhang · 312/1235 文件`
   - 刷新：`后台刷新 结构索引 · dieyundaizhang · 88 文件`
   - 有错：`索引失败：<lastError 前 120 字>（本轮用 grep）` ——**错误优先级高于进度**，`st.lastError` 有值就渲染，不再要求 `!indexing`
2. 动词判定保持单一来源（`st.indexed ? 刷新 : 首建`），**不改语义**，只改可见信息。
3. 同 root 连续两轮 `files_done` 没有前进时，追加 `（进度未前进）` —— 状态放 `live.prepSteps`（已有容器），不落库、不加字段。

**验收**：三种状态各截一张图；`npm run check:renderer`。

### P0-B｜索引根单一解析 + 远端 core 按索引根复用

**问题**：`resolveCodebaseContext()` 对 SSH **忽略传进来的 `workspaceRoot`**，而 `invokeIndexCore()` 又用 `ctxInfo.remotePath` 覆盖一次（两个写点）；同时远端 daemon 的 handler 按「hello 声明的 workspace」建，索引 core 也跟着按 worktree 建 —— 一旦作用域目标与实际会话工作区不一致，就会出现「索引建在 A、模型读写 B」，且**没有任何报错**。

**改法**：

1. 新增**唯一来源** `src/remote/index-root.js`（或并入 `workspace-index-path.js`，勿两处各写一份）：

   ```js
   /** 索引库归属的根：本地=工作区；远端=会话工作区（默认），或项目根（见 P1 甲案） */
   function resolveIndexRoot(target, { projectShared = false } = {}) {
     if (target.kind !== 'ssh') return target.path;
     const p = normalizeRemotePath(target.remotePath);
     return projectShared ? repoRemotePathOf(p) : p;   // repoRemotePathOf 已存在：ssh/remote-worktree.js:63
   }
   ```

2. `src/gateway/rpc.js:resolveCodebaseContext()`：远端分支**不再丢弃**显式 `workspaceRoot`，改成校验后接受：

   ```js
   const root = resolveIndexRoot(target);
   const asked = workspaceRoot ? normalizeRemotePath(String(workspaceRoot)) : '';
   if (asked && asked !== root) throw Object.assign(
     new Error(`索引目标与会话工作区不一致：index=${root} session=${asked}`),
     { code: 'WORKSPACE_SCOPE_MISMATCH', retryable: false,
       suggestedFix: '不要重试；这是调用作用域错位，先修 workspace 绑定，别在用 grep 时反复试索引。' });
   ```
3. `invokeIndexCore()` 删掉 `workspaceRoot: ctxInfo.remotePath` 这一次覆盖，统一用 `ctxInfo.rootKey`（唯一一处拼参数）。
4. `RemoteIndexCoreHost` 的 `workspaceRoot` / `indexDbPath` 改由 `resolveIndexRoot()` 给（`remote-index-core.js:157-173`）；`minimal-gateway-host.js:463` 的 `_sessionFor()` 缓存键改为**索引根**，多个会话共用同一份索引 host（避免两个 core 抢同一个 `index.sqlite`；这正是 §8 遗留 flock 问题在索引侧的正面解法）。fs/grep/exec 仍按各会话自己的根。

**验收**：`npm run test:local-gateway-smoke`、`npm run verify:rpc-catalog`；新增单测：同一项目两个会话 → 只创建一个 index host、`index.sqlite` 只有一份；显式 `workspaceRoot` 跨根 → `WORKSPACE_SCOPE_MISMATCH`。

### P0-C｜建库不再由「每一轮 prep」发起（减法）

**问题**：建库是「一次性的、慢的、后台的」事，prep 是发消息的热路径。两者耦合的直接结果就是你截图里那两行：**每轮都像在重新建**，而且带着 2 次瞬断重试（`INDEX_PREP_TRANSIENT_RE`，`:246-247`、`:369-382`）增加噪声。

**改法**：

1. 把 `ensurePrepIndexReady` 拆成两个：
   - `readPrepIndexStatus({kind, workspacePath, gatewayCall})` → 只读 status，返回 `{ready, indexing, status, root}`；**不发 start、不重试、不 note**。
   - `kickIndexBuildOnce(root, kind)` → 进程内 `Set<root:kind>` 去重，一个根只发起一次；失败后**只有**用户显式触发（面板「重建」按钮、`session_set_workspace` 换根、进程重启）才再次发起。
2. 删除：`INDEX_PREP_TRANSIENT_RE` 那套重试、`waitForFreshPrepIndex` 里为等待而做的状态轮询（`refreshPending` 时保留一次短等待即可，`:393-404`）。
3. prep 里 codebase/graph 两步的终态只有三种：`done`（已就绪、已注入）、`skipped`（`后台首建中，本轮用 grep`）、`failed`（真错误）。

**收益**：删约 40 行 + 一个正则 + 一个重试循环；trace 从「每轮创建中」变成「第一轮一句可读的跳过理由」。**不新增任何开关。**

**验收**：连发 3 轮消息，第 2、3 轮准备区不再出现索引行；`npm run test:agent`。

### P1｜索引归属：以**乙**为根，配三件套让向量真的能发挥

| 方案 | 索引根 | 向量可行性 | 结论 |
|---|---|---|---|
| 甲 项目共享 | 项目根 | 一次 embedding 全项目，成本最低 | 向量命中会是 worktree 提交前的旧代码 —— 语义检索最怕的就是这个 |
| **乙 会话私有（现状）** | 会话 worktree | 语义最准（就是模型读写的那份），但每会话要 embed 全仓 | **推荐为根**，但必须配 P1-a/b/c 才付得起 |
| 丙 砍掉片段索引 | 项目根 | 无向量 | **撤回**（见 §0.5）：与「让向量发挥作用」正好相反 |

乙是唯一「语义正确」的选择：向量检索的段内正文必须等于模型实际读到的那份代码，否则命中越准、误导越深。但换根只是前提，缺下面三件里任何一件，向量依然不会在模型侧出现：

**P1-a 向量意图必须能持久化（当前唯一来源是「人在面板上点一下」）**

- 改法：把「本工作区要语义检索」做成一条**持久意图**，位置复用设置页既有的「保存后自动增量」那组开关（`renderer/index.html:1491` 附近），配置落 `src/model-settings.js` 的 workspace 级字段；`startCodebaseIndexForContext()` 读它决定 `vectors`，一次打开对该工作区**每一次**建库都生效。
- 仍然 opt-in（默认关）：向量是最贵的一环，不能替用户默认打开。但**不能停留在「每次建库都要人点」**——SSH 每会话一份库，那等于永远不点，又回到 §0.5 的第 1 条。
- 这是本方案里**唯一新增的配置字段**，理由：它替代的是「每会话手点一次全仓 embedding」这个不可用的触发方式，没有别的既有单一来源可以承载「这个工作区要语义检索」这个意图。

**P1-b 向量按内容哈希复用（乙的成本解法）**

- 现状：乙 + 向量 = 每个会话把整仓重新 embedding 一遍，没人受得了。
- 改法：建库时把「chunk 内容哈希 → 向量」存进**项目级缓存**（跨 worktree 共享），新库只对缓存未命中的 chunk 调 embedding。冷库首建于是退化成「读缓存 + 少量新增文本」。
- 这不是新机制：`docs/MULTI-AGENT-WORKTREE-ISOLATION-PLAN.md` §11 #4 已把「索引按文件内容复用」列为既定优化方向；此处只是把触发条件从「冷启动 > 2-3 分钟」改成「乙案 + 向量」的**前置条件**。

**P1-c 空结果不许静默（否则修好了也看不出来）**

- `formatCodebaseBlock()` 命中为空返回 `''`（`context-signals.js:78`），「未建向量 + 中文长句」于是在模型侧等价于「没有相关代码」。
- 改法：`vectorCount === 0` 时返回一句可诊断说明（`未建向量：中文查询请用 grep / host_exec`）；有向量但真无命中才返回空。工具侧（`codebase.search`）同样返回 `vectorSearch:false` + 明确文案，让模型能学到「什么时候该换 grep」。

**P1 的验收指标（决定要不要再收敛到甲，用数据不用猜）**

连跑两周后统计：① `codebase_search` 调用数、成功率、非空命中率（`tool-telemetry.jsonl` + `request_snapshots.messages_json`）；② 注入块非空率（`messages_json like '%【相关代码%'`）；③ 建库耗时与实际 embedding 的 chunk 数（远端 `agent.log`）。**指标上不来才谈删，指标上来则甲/乙之争自然有答案。**

### P2｜建库与对话 RPC 争用（已实施，见 §6.8）

`memory.long_recall` 在建库同轮超时（有现场证据）。按 `docs/SQLITE-ACCESS.md` 的三通道模型查下来：
问题不在建库（建库用独立连接、另一个库文件），而在**召回把自己挂在了那条唯一的写入连接上**。
修法是**归属**（读走读池、非必要写走 `try_with_conn`），不是加超时。

## 3. 明确不做（加法反模式）

- ❌ 加「等索引建完再发消息」或把不等待改成等 N 秒
- ❌ 在设置页加「SSH 是否建索引」开关（那等于把 §1 的错位藏起来，而不是消掉）
- ❌ 新增「第 N 次尝试」「卡住」这类持久化状态字段
- ❌ 只改文案措辞（`创建中` → `更新中`）就当修好了 —— 那恰好是 `formatPrepIndexProgress` 注释里已经警告过的做法
- ❌ 为「远端索引建得慢」加降级层或兜底重试
- ❌ **拿「`codebase_search` 0.05%」当删功能的依据**（见 §0.5：那是三处缺陷叠加出来的 0，不是价值判断）

## 4. 真机验收（可复现，别靠肉眼）

前置：同一台远端、同一个项目、开两个新会话。

1. **一个会话只发起一次**：乙案下每个会话本来就有自己的冷库（这是设计成本，不是 bug），验收点是——同一会话内首建只 kick 一次、建完后同会话后续轮次的注入块里出现 `枢纽文件：`；**若将来采纳甲案**，追加「第二个会话不再出现首建」。
2. **不再每轮重复**：同一会话连发 3 轮，第 2、3 轮准备区没有索引步骤。
3. **路径不再打架**：同一会话里 `host_exec pwd` 与系统提示中的工作区路径一致；若故意让作用域与工作区错位，必须报 `WORKSPACE_SCOPE_MISMATCH`，不许静默建到别处。
4. **快照断言**（本地只读查库即可）：

   ```sql
   -- 该会话是否有 repo_map 注入
   select count(*) from request_snapshots
    where session_id=? and messages_json like '%枢纽文件%';
   -- 是否再出现「创建中」文案
   select count(*) from messages where content like '%创建中，本次不等待%';
   ```
5. **不再拖死记忆**：建库窗口内 `memory_recall` 不出现 `CORE_RPC_TIMEOUT`（P2 修完后）。
6. **向量真的通了**（P1-a/b 完成后）：打开语义检索开关 → 任一 SSH 会话用中文自然语言提问（如「登录记住密码存在哪」）→ 工具结果 `vectorSearch:true` 且命中非空；注入块 `模式：向量+子串`。若 `vectorSearch:false`，必须看到 `未建向量：请用 grep` 的明确说明（P1-c），不许是空块。
7. **向量不再重复计算**（P1-b）：`npm run verify:vector-cache-reuse`（需先 `cargo build -p dieyun-core`）在本机起一个假 embedding 端点，把「乙案」原样复现成两份独立索引库 + 同一个 `data_dir`：
   预期 `库A: reused 0 / embedded N`、`库B: reused N / embedded 0`，且两次建库合计只请求端点 **1** 次。
   真机上等价口径：面板「向量来源」在第二个会话里应该显示 `复用 N / 新算 0~少量`。

## 5. 分批、改动面与风险

| 批次 | 内容 | 改动文件 | 风险 |
|---|---|---|---|
| 1 ✅ | P0-A 文案 | `src/renderer/renderer-agent-prep.js` | 低（纯展示） |
| 2 ✅ | P0-C 解耦建库触发 | 同上 + `renderer-agent-system-message.js:195-332` | 中（本地首次触发点要覆盖：本地无面板点击也要能建一次 → 由 `kickIndexBuildOnce` 在首轮承担，等价现状但只一次） |
| 3 ✅ | P0-B 单一根 | `src/gateway/rpc.js`、`src/remote/{index-root,remote-index-core,minimal-gateway-host}.js`、`src/gateway/server.js`（显示剥尾不动） | 中高（跨会话共享 core 要单测覆盖 refcount） |
| 4 ✅ | **P1-c 空结果不许静默**（先做，成本最低、收益立竿见影） | `src/agent/context-signals.js`、`src/gateway/handlers/codebase.js`、`src/agent/system-prompt-prep.js` | 低（只改返回文案与降级标注） |
| 5 ✅ | P1-a 向量意图持久化 | `src/model-settings.js`、`renderer/index.html`、`renderer/renderer-model-settings.js`、`src/gateway/rpc.js:startIndexForContext` | 中（唯一新增配置字段，需文档同步） |
| 6 ✅ | P1-b 向量按内容复用 | `crates/dieyun-core/src/index/{vector_cache.rs,schema.rs,mod.rs,remote.rs}`、`src/embedding`（`cache_key`/`embedding_input`） | 中高（动 Rust 建库路径，需 `cargo test` + 真机耗时对比） |
| P2 ✅ | 建库窗口内召回不再排在写入连接后面 | `crates/dieyun-core/src/{sqlite.rs,memory/mod.rs}`、`src/{core-bridge,core-rpc-timeouts}.js` | 中（动内存库读写归属，需 `cargo test` + 压测对比） |
| P3 ✅ | 冷启动 endpoint 往返：批大小 + 有界并发（§6.11） | `crates/dieyun-core/src/embedding/mod.rs`、两个耗时验证脚本 | 中（动请求形状：批太大撞端点 token 上限、并发太高撞限流；真机 238s → 39s 复核） |

每批的测试：`npm run test:agent`（1/2/4）、`npm run test:local-gateway-smoke` + `verify:rpc-catalog`（3）、`npm run check:renderer`（1/5）、`npm run test:rust-agent-loop-smoke` + 真机耗时（6）；全量收口 `npm test`。

## 6. 落地记录（批次 1–6 + P2 全部实施）

### 6.1 改了什么

| 位置 | 改动 | 守的约束 |
|---|---|---|
| `renderer-agent-prep.js:formatPrepIndexProgress` | 新签名 `(st, kind, mode, root)`：动词只由 `st.indexed` 决定（`首建` / `刷新`），**错误优先于进度**，带根名（`shortIndexRoot` 把 `…/<项目>/.dieyun/worktrees/<id>/main` 剥成项目名），进度连续两轮不前进时补一句「进度未前进」，新增 `idle` 态直接给出「可在侧栏索引面板重建」 | 一个状态一句话；detail 不带 kind 名与括号（行渲染是 `label（detail）`） |
| `renderer-agent-prep.js:readPrepIndexStatus` | 从 `ensurePrepIndexReady` 拆出的**只读**部分：一次 status、不重试、不发 start；查不到状态时 `phase='unavailable'` 且**不 kick** | 建库是慢事，prep 是热路径 |
| `renderer-agent-prep.js:kickIndexBuildOnce` | `Set<kind:root>` 进程内去重：一个索引根只发起一次；换根天然是新 key；重新发起只有「面板重建 / 换工作区 / 进程重启」三条显式路径 | 减法：不加「第 N 次尝试」「卡住」这类持久字段 |
| 同上 | 删除 `INDEX_PREP_TRANSIENT_RE` 那套 2 次重试 + 重试 note；`waitForFreshPrepIndex` 保留（只在 `refreshPending` 时最多等 2s）但**不再在等待期间刷进度文案** | 删掉「准备区一直显示在创建」的主要噪声源 |
| `renderer-agent-system-message.js` | 兜底文案 `本次不等待` → `本轮用 grep`（两处），与新 vocabulary 对齐 | 单一来源：文案只在 `formatPrepIndexProgress` 成形 |
| `context-signals.js:formatCodebaseBlock` | 0 命中分三态：没索引 → 「改用 grep / host_exec」；没向量 → 「中文自然语言在子串通道基本不命中，改用 grep / host_exec」；**有向量且真无命中才返回空** | 不许把「没通电」说成「没有相关代码」 |
| `gateway/handlers/codebase.js:codebase.search` | `INDEXING_IN_PROGRESS` / `INDEX_REQUIRED` 文案改成可执行指令 + `retryable:false`；0 命中且 `vectorCount === 0` 时回一个 `hint` | 模型侧要能学到「该换 grep」 |

### 6.2 测试

- 新增 `test/unit/prep-index-copy.test.cjs`（11 条）：动词区分、错误优先、根名剥尾、进度两形态、`started`/`idle` 两态、**同根只 kick 一次**、状态不可用时不 kick。
- 新增 `test/unit/codebase-block-degraded.test.cjs`（4 条）：0 命中三态 + 有命中时格式与「模式」标注不变。
- 更新 `scripts/test-system-prompt-prep.cjs`：旧断言 `formatCodebaseBlock('q', {results: []}) === ''` 正是本次要修的行为，改为三态断言。
- 已跑：`npx vitest run`（166 文件 / 1624 用例）、`npm run check:renderer`、`npm run check:js`、`npm run test:local-gateway-smoke`、`npm run verify:rpc-catalog`、`npm run test:agent` 全绿。
  - 注：`test:lsp` 在本机需要先 `Remove-Item Env:\ELECTRON_RUN_AS_NODE`，否则它的 `npx child keeps default env` 断言会因宿主环境变量而失败（与本改动无关）。

### 6.3 还没做（批次 3 / 5 / 6）

- **批次 3 P0-B 单一根**：`resolveCodebaseContext` 的 remote 分支仍会丢弃显式 `workspaceRoot`，索引路径来自调用域 `remotePath`——这正是「系统提示里是 worktree、`host_exec pwd` 是主仓」那条未解释证据的候选根因，需要单独一批动 `src/gateway/rpc.js` + `src/remote/`。
- **批次 5 P1-a 向量意图持久化**、**批次 6 P1-b 向量按内容复用**：向量能不能在模型侧出现，全看这两批。当前 `vectors:true` 仍只有面板「建向量」按钮一处。
- **P2**：`memory.long_recall` 在建库同轮 `CORE_RPC_TIMEOUT` —— 已在 §6.8 修完（归属问题：召回排在写入连接后面）。

### 6.4 批次 3（P0-B 索引根单一解析）已实施

新增 `src/remote/index-root.js` —— 「这次索引操作针对哪个根」的**唯一判定处**。
一条远端索引链路上本来有三个「根」的说法：调用方显式传的 `workspaceRoot`、本次调用作用域
（`runWorkspaceRoot` / 会话绑定）、远端 daemon 连接 `hello{workspace}` 声明的根。
第 1 个被第 2 个静默丢弃、第 3 个从没被比对过，症状统一为「面板/准备区永远未建立，
而工具调用看起来都成功」——因为建的是 A 的库、查的是 B 的哈希。

| 位置 | 改动 |
|---|---|
| `src/remote/index-root.js`（新） | `normalizeIndexRoot()`：ssh URI → remotePath、POSIX 归一、相对路径相对作用域展开、Windows 路径原样（交给比对报错）；`resolveIndexRoot()`：两个根不等即 `WORKSPACE_SCOPE_MISMATCH`（错误里**必须**同时带两个根 + 不可重试 + 指向 `runWorkspaceRoot`） |
| `src/gateway/rpc.js:resolveCodebaseContext` | 远端分支不再丢弃 `workspaceRoot`，改由 `resolveIndexRoot` 合一，并回传 `rootSource` |
| `src/gateway/rpc.js:invokeIndexCore` | 远端调用前把「请求的根」与「daemon 连接声明的根（`info.workspaceRoot`）」比对，不再用 `ctxInfo.remotePath` 静默覆盖 |
| `src/remote/remote-index-core.js` | `RemoteIndexCoreHost.invoke` 只服务自己的根：**起 core 之前**就比对，别的工作区的根直接拒（以前照抄 `params.workspaceRoot`，用 A 的库建 B 的哈希）；`indexDbPath` 与「比对身份」分开（`path.resolve` 是平台相关的） |
| `src/remote/remote-pack-layout.js` | `index-root.js` 与 `src/workspace/target.js` 加进远端打包闭包清单（漏了 = daemon 侧 `Cannot find module`，且 hash 不含它时还会「跳过上传」） |

测试：`test/unit/index-root-scope.test.cjs`（12 条：归一化五态、显式 vs 作用域、URI/尾斜杠等价、
不一致报错内容、本机路径混进远端调用、远端 core 拒绝别人的根且**在起进程前**拒绝）。
`test/unit/remote-pack-requires.test.cjs` 的传递闭包校验也覆盖了新文件。

### 6.5 批次 5（P1-a 向量意图持久化）已实施

| 位置 | 改动 |
|---|---|
| `src/model-settings.js` | 新增配置字段 `indexSemanticSearch`（默认 **false**，归一 `=== true`）+ `resolveIndexVectorsIntent(userData, explicit)` 作为「这次建库要不要带向量」的**唯一判定**：显式布尔优先（面板一次性动作 / 增量调度器沿用），没说话才看持久意图，缺文件/脏值一律 false |
| `src/gateway/rpc.js:startIndexForContext` | `vectors` 由 `!!opts.vectors` 改为 `resolveIndexVectorsIntent(...)` —— 这是 prep / agent / 面板**所有**建库路径的必经之处 |
| `src/gateway/handlers/codebase.js` | `codebase.index.start` 不再 `!!vectors`（把「没说话」压成「不要向量」），原样透传；`codebase.index`（老 daemon 同步路径）同样走判定；`codebase.search` 的 0 命中提示补上「设置 → 代码索引语义检索」这条长期解法 |
| `src/renderer/index.html`、`renderer-codebase-panel.js`、`renderer-model-runtime.js` | 设置页新增「代码索引语义检索（向量）」开关（与「保存后自动增量」同一组），默认关；打开时顺手对**当前**工作区补一次向量（走与面板「建向量」同一条增量路径）；renderer 侧默认值与归一同步 |

测试：`test/unit/index-vectors-intent.test.cjs`（4 条：默认关、意图开、脏值按关、显式覆盖意图）。

**为什么是持久设置而不是「多一个按钮」**：SSH 会话的索引库是每会话一份（`<worktree>/.dieyun/index.sqlite`），
手点「建向量」等于每开一个会话就手点一次全仓 embedding——实践上等于永远不点，
`vectorCount` 长期为 0。本字段是本方案里**唯一新增的配置**，它替代的是一个不可用的触发方式。

### 6.6 批次 6（P1-b 向量按内容哈希复用）已实施

`workspaces.embedding_model` 那套元数据只描述「这一个库里的向量是谁算的」；跨会话就失效了。
新增的 `vector_cache` 换了个口径：**一条向量只由「送进模型的文本」和「谁算的」决定**，
跟它在哪个 worktree、哪个文件、第几行无关 —— 所以键就是
`(sha256(实际送进模型的文本) 前 32 位, cache_key)`，`cache_key` = 模型@维度|端点。

| 位置 | 改动 |
|---|---|
| `crates/dieyun-core/src/index/vector_cache.rs`（新） | 跨 worktree 缓存本体：`<data_dir>/vector-cache.sqlite`（**不写进项目**：纯派生缓存，删掉只影响下次建库速度）；`content_hash()` 用 sha256 前 128 位（不用 `DefaultHasher`：它不保证跨 Rust 版本稳定，键一漂移整个缓存会在升级后失效）；`get_many` / `put_many` / `count` / `prune`（按 `created_at` 裁，命中不写库 ⇒ 是「按写入时间」而非严格 LRU） |
| `crates/dieyun-core/src/embedding/mod.rs` | `embedding_input()` 公开（缓存键必须哈希**实际送进模型的文本**，超长 chunk 会被截断）；新增 `cache_key()` = 签名 + `base_url`（索引元数据仍用 `signature()`，只有缓存键带端点：两个提供商可能都叫 `bge-m3` 且都是 1024 维，喂错向量不报错、只会让检索悄悄变差） |
| `crates/dieyun-core/src/index/mod.rs` | `IndexService`：`with_vector_cache(path)`（`from_config` 接 `<data_dir>/vector-cache.sqlite`，`new()` 保持无缓存 ⇒ 存量测试零改动）；`apply_cached_vectors`（同步：查缓存并写回命中项）+ `store_embedded_vectors`（同步：写库 + 回填缓存 + 裁剪）。分两段而不是一个 async fn：`&Connection` 不是 `Send`，跨 `await` 会让整个 RPC handler 的 future 失去 `Send` |
| `crates/dieyun-core/src/index/remote.rs` | SFTP 摄取路径改用同两个函数（原来它自己复制了一份 upsert）——两条建库路径的「查缓存 → 补算 → 写库 → 回填」只此一份实现 |
| `crates/dieyun-core/src/index/schema.rs` | `SCHEMA_VERSION` 4 → **5**：`workspaces` 加 `vectors_reused` / `vectors_embedded` 两列（`PRAGMA table_info` 判存在再 `ALTER`，幂等） |
| `StatusResult` | 透出 `vectorsReused` / `vectorsEmbedded`；面板新增「向量来源：复用 N / 新算 M」一行 |

不复用也不报错：缓存打不开、写满、加锁失败一律按「全部未命中」处理 —— 缓存是优化，
永远不许让一次建库失败。

测试：

- `index::vector_cache::tests`（4 条）：内容哈希稳定且区分文本；同签名命中 / 换模型不命中 / 维度不符不命中；
  `prune` 只裁最老的；同键覆盖写。
- `index::tests::vectors_reuse_from_content_hash_cache_without_calling_endpoint`：三步走 —— 先只建 chunk、
  把每个 chunk 的向量按 `run_index` 的算键方式预置进缓存、再带向量重建。**端点地址是必连不上的
  `127.0.0.1:9`**，所以只要复用漏掉任何一个 chunk，这个用例就会失败而不是「静默变慢」；
  断言 `vectors_embedded == 0 && vectors_reused == chunk_count`。

真机耗时对比（同一个仓、两个 SSH 会话，2026-10-31 实跑，`dieyunx@192.168.31.62`）：

被测目标 = `dieyuntools` 会话 worktree（302 文件 / 25 MB → **7178 片段**），假 embedding 端点每批模拟 250ms：

```
                     串行 · 8 条/批        →   有界并发 4 · 预算分批（§6.11）
A-冷启动             238170ms              →   39133ms      ← 6.1×
B-第二个会话             616ms              →     663ms      ← 向量全复用，几乎白拿
C-同库重建               716ms              →     666ms
端点请求                 899 次             →   578 次（≈12.4 条/批，在飞峰值 4）
```
（两轮都是 8→10 条断言全过；改前/改后跑的是同一份 worktree、同一个假端点延迟。）

同一目标把端点延迟设 0 再跑一次，隔离出「索引本身」的成本（改前那轮）：

```
A-冷启动    13792ms · 复用 0    / 新算 7178   ← 端点被请求 899 次 / 7179 条文本
B-第二个会话   616ms · 复用 7178 / 新算 0
C-同库重建     720ms · 复用 7178 / 新算 0
ALL OK (8 checks)
```

三个数放在一起才说明问题：

1. **第二个会话 0.6s，冷启动 238s —— 396×**。批次 6 的内容哈希缓存确实把「每个新会话重算整仓」消掉了。
2. **冷启动的成本几乎全在 embedding 往返，不在索引**：建库 + 切片 + 写库 13.8s，剩下 224s 是
   `899 批 × 250ms`（当时 `EMBED_BATCH_SIZE = 8` 且全进程串行）。真实端点若每批 1s，冷启动就是 15 分钟。
3. **批量 + 有界并发把这一段压到 25s**（238s → 39s，其中 13.8s 是索引本身）：见 §6.11。

驱动本体 `scripts/index-timing-driver.py` 也在本机跑通过同一口径（`npm run verify:index-timing-local`，
60 文件小语料，每批模拟 60ms，断言包含「请求数 < 片段数」「在飞峰值 ∈ (1,4]」）：

```
标签            耗时      文件   片段   向量   复用   新算      库大小
A-冷启动          359ms    60    240    240      0    240      1790 KB
B-第二个会话      104ms    60    240    240    240      0      1790 KB
C-同库重建        103ms    60    240    240    240      0      2270 KB
端点调用：输入 241 条 / 请求 10 次 · 在飞峰值 4（闸门 4）   检索：vectorSearch=true
```

真机跑法：`DY_SSH_HOST=<host> DY_WS=<远端项目> npm run verify:index-timing-ssh`
（认证优先用 `%TEMP%\dy_ssh_pw`，没有该文件就走 `~/.ssh/config` 的 key / agent，与 app 同源）。

已可复现的等价验收（本机，`npm run verify:vector-cache-reuse`，2026-10-31 实跑）：

```
库A: {"chunkCount":3,"vectorCount":3,"vectorsReused":0,"vectorsEmbedded":3,"embeddingCalls":1}
库B: {"chunkCount":3,"vectorCount":3,"vectorsReused":3,"vectorsEmbedded":0,"embeddingCalls":1}
检索: {"vectorSearch":true,"hits":3}
缓存文件: <data_dir>/vector-cache.sqlite（项目目录里没有）
```

两份独立的索引库 = 两个 SSH 会话；`embeddingCalls` 停在 1 = 第二个会话一次都没再调端点。

### 6.7 本批回归

`cargo test -p dieyun-core --lib`（165 用例）、`npx vitest run`（168 文件 / 1640 用例）、
`npm run check:renderer`、`npm run check:js`、`npm run test:agent`
（含 `local-gateway-smoke` / `session-remote-transport` / `verify:rpc-catalog`）全绿。

### 6.8 P2：建库窗口内 `memory.long_recall` 超时（已实施）

**现场**：`%APPDATA%/dieyunagent/logs/main.log` 有两行
`RPC_TIMEOUT memory.long_recall id=… timeoutMs=120000`（13:59:38 / 14:12:43），
都发生在 SSH 会话刚开、远端索引库第一次建的时候。

**先把三件事测掉，再动手**（这一步比改代码重要）：

1. **不是「建库把 core 卡住」**：`scripts/repro-recall-stall.cjs` 用真实体量的 memory 库副本
   （544 MB）+ 1074 文件的仓建库，期间每 400ms 打一次 `long_recall`：
   基线 p50 1ms，建库期间 p50 2ms / max 3ms，`[rpc-slow]` 零行。建库用的是
   `open_dedicated`（独立连接、另一个库文件），**不占内存库的任何通道**。
2. **不是「召回的读太慢」**：`long_memories` 只有 1738 行 / 235 KB 正文，召回是毫秒级。
3. **是归属错了**：召回链路里 `count_active_long_memories` / `recent_long_memories` /
   `semantic_search_long` 都走 `with_conn`（**那条唯一的写入连接**），末尾的
   `bump_memory_usage` 也是。也就是说「每轮系统提示都要等的读」排在「聊天落库」队列后面。

**改法（修归属，不加超时、不加降级）**：

| 位置 | 改动 |
|---|---|
| `crates/dieyun-core/src/memory/mod.rs` | 召回链路三处纯读 `with_conn` → `read()`（读池）；`bump_memory_usage` → `try_with_conn`（拿不到锁就跳过，它只是 `access_count` 提示信号） |
| `crates/dieyun-core/src/sqlite.rs` | 新增 `SqliteHandle::try_with_conn`（`try_lock` 失败返回 `None`）；把 `with_conn` / `try_with_conn` 共用的三条不变量（连接就绪 / 已初始化 / 必须 autocommit）提成 `prepare_locked`，两份实现不许漂 |
| `crates/dieyun-core/src/rpc/{stdio,mod}.rs` | `[rpc-slow] <method> <ms>`（core 侧耗时 ≥2s 落 stderr）+ `SLOW_RPC_LOG_MS` |
| `src/core-bridge.js` / `src/core-rpc-timeouts.js` | 对称的 `RPC_SLOW <method> <ms>`（端到端）；两个常数同值，注释互相指向 |

两侧日志的用法：**端到端慢但 core 没打 `[rpc-slow]` ⇒ 卡在传输 / 守护进程 / 宿主进程**；
两侧都慢 ⇒ 卡在 core。这次吃亏就吃在没有这组对照，只能推理。

**实测对比**（`scripts/repro-recall-blocked-by-writes.cjs`，一个 60MB 快照写入 ≈ 500ms 持锁）：

| 召回 p50 / p95 / max | 安静 | 写入持锁期间 |
|---|---|---|
| 修前 | 0 / 1 / 1ms | **135** / 230 / 519ms |
| 修后 | 0 / 1 / 1ms | **1** / 138 / 139ms |

并发短写（6 路 4MB）时同样是 p50 189ms → 4ms。

**仍未证实的一环**（写清楚，别当成已解决）：120s 那个量级需要「写入连接被单一长任务按住两分钟」
才解释得通，而现场日志里没有这样一条长写。现在有了两侧耗时日志，同样的症状再次出现时，
`[rpc-slow]` / `RPC_SLOW` 会直接指出是 core、传输还是宿主进程。届时若证实是某条长写，
继续修那条写的归属；**不要**给 `memory.long_recall` 加长超时（那是把「被拖死」写成「本来就慢」）。

### 6.9 本批回归（P2）

`cargo test -p dieyun-core --lib`（167 用例，含新增 `try_with_conn_skips_instead_of_waiting_when_write_conn_is_busy`）、
`npx vitest run`（170 文件 / 1652 用例）、`npm run check:js`、
`npm run test:agent`（`local-gateway-smoke` / `session-remote-transport` 全 OK）、
`npm run verify:index-timing-local`（A/B/C 三次测量 5 条断言全过）、
`npm run verify:index-timing-ssh`（真机 A/B/C，8 条断言全过）。

### 6.10 「索引根不一致」= 租约把会话切进 worktree，渲染端还在用租约前的仓库根

**现场**：面板两行

```
索引代码库（索引状态暂不可用：codebase.status：索引根不一致——远端 Agent 连接声明的根是
「…/dieyuntools/.dieyun/worktrees/sess-06b7fd1f/main」，请求的根是「…/dieyuntools」…）
```

这不是误报，是 6.1/6.4 那套严格比对在正确履职：两份根 = 两份 `index.sqlite`。
错的是**渲染端拿的那个根**。

**链路**（`src/session/session-worktree.js` + `src/renderer/renderer-agent-send.js`）：

1. 渲染端发消息前，用 `resolveSessionWorkspacePathSync(sessionId)` 得到会话工作区（此刻是**仓库根**）；
2. 拿它去 `remote:session-lease` 租 SSH 通路；
3. Main 在租约里 `ensureSessionWorktree` 把会话切进 `…/worktrees/<sid>/main`，并落库 + 写进程内上下文；
4. **但渲染端手上还是第 1 步那个旧根** —— 这一轮的索引查询（`codebase.status` / `codebase.index.start`）
   于是用仓库根去问，而远端 Agent 那条连接的 `hello{workspace}` 是 worktree；
5. 严格比对 → `WORKSPACE_SCOPE_MISMATCH` → 面板「状态暂不可用」，**这一轮也不会去建库**。

**改法（让租约回生效路径，一行契约）**：

| 位置 | 改动 |
|---|---|
| `src/session/session-remote-transport.js` | `setSessionRemoteLease` 返回**生效后**的会话工作区（`workspacePathForSession(effective)`；同在途复用分支也返回，释放返回 `''`） |
| `src/main/ipc/workspace-remote.js` | `remote:session-lease` 把该路径回给渲染端（原来是 `{ok:true}`） |
| `src/renderer/renderer-agent-loop.js` | `syncSessionRemoteLease` 返回 Main 给的生效路径 |
| `src/renderer/renderer-agent-send.js` | 租约后若路径变了就采用它，并 `rememberSessionWorkspacePath` —— 整轮（索引/记忆/沙箱）从此同一个根 |

测试：`scripts/test-session-remote-transport.cjs` 新增
`ok lease returns effective worktree workspace`（worktree 新建时租约必须回 `ssh://u@h1/…/.dieyun/worktrees/sess-a/main`，
释放后回空）。

**顺手量到的两件事**（同一台真机，2026-10-31 15:46）：

1. `dieyuntools` 下 **10 个 worktree 里 0 份 `index.sqlite`**，`dieyundaizhang` 同样 0 份；仓库根那份
   还是 10-28 的旧库（234 MB）。也就是说乙案落地之后，SSH 会话的索引**从来没建起来过**
   —— 与「面板永远未建立 / `codebase_search` 0 次」完全吻合，根因就是本节这条。
2. 用 `verify:index-timing-ssh` 直接在**会话 worktree** 上建库是通的（7178 片段 / 47 MB / 检索
   `vectorSearch=true`），所以修好根之后建库链路本身没有问题，成本账见 §6.6。

### 6.11 冷启动的 224s 端点往返 → 25s：批大小 + 有界并发

§6.6 量到冷启动 238s 里只有 13.8s 是索引本身，其余是 `899 次串行请求 × 每批延迟`。
根因两条，都在 `crates/dieyun-core/src/embedding/mod.rs`：

| 原来 | 现在 | 为什么 |
|---|---|---|
| `EMBED_BATCH_SIZE = 8`（固定条数） | `plan_embed_batches`：**条数上限 32 + 字符预算 24k**，取先撞的那个 | 端点限制有两种口径（条数 / 总 token），只按条数切会让长 chunk 的批超 token；只按 token 切会让超短 chunk 拼成巨长请求 |
| `static EMBED_SERIAL: Mutex<()>`：**全进程串行** | `static EMBED_INFLIGHT: Semaphore(4)`：**全进程有界并发** | 串行锁是「不能同时打端点」的唯一来源，改成闸门后仍是唯一来源（多个索引库同时建也只共享 4 个名额），但单次建库能用满 |

配套细节：

- **字符按「真正发出去的文本」计**（先按 `EMBED_TEXT_MAX_CHARS = 6000` 截断），否则一个 40k 字符的
  chunk 会让预算失真；单条超预算也自成一批（永不产出空批）。
- **摊开窗口 = 闸门 × 2**（`EMBED_CONCURRENCY * 2` 个 `JoinSet` 任务在飞）：喂得满 4 个名额，
  又不会给十万片段的仓一次 clone 出上千个任务。
- **顺序无所谓**：调用方 `store_embedded_vectors` 用 `hash_by_id` 按 chunk id 回填，所以完成乱序安全。
- **不加重试 / 不加 429 退避 / 不加配置项**：真被限流时会报 `EMBEDDING_API`（带端点原始 message）。
  并发取 4 是保守值（多数端点按 RPM/TPM 限流）。要调只改这两个常数，没有第二处口径。

**真机实测**（同一 worktree、同一假端点 250ms/批）：

| | 改造前 | 改造后 |
|---|---|---|
| A 冷启动 | 238 170 ms | **39 133 ms** |
| 端点请求数 | 899（8 条/批） | **578（≈12.4 条/批，字符预算先撞）** |
| 在飞峰值 | 1（串行） | **4** |
| B 第二个会话 | 616 ms | 663 ms（仍是全复用） |

也就是说：`224s 端点往返 → 25s`，冷启动整体 **6.1×**。再往上只剩两条路——抬字符预算（风险：
小模型端点按总 token 卡）或抬并发（风险：限流），两者都得先拿到目标端点的真实上限，不做猜测。

**本批回归**：`cargo test -p dieyun-core --lib` 174 用例（含 7 条新增 `embedding::tests::plan_*`：
条数上限 / 字符预算 / 截断后计长 / 单条超预算 / 顺序与不丢不重 / 空输入 / 按字符截断不 panic）、
`verify:index-timing-local`（8 条断言，含「请求数 < 片段数」「在飞峰值 ∈ (1,4]」）、
`verify:index-timing-ssh`（10 条断言，同上口径在真机复核）。

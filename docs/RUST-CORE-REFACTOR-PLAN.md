# Rust core 重构方案（2026-11-17）

> **一句话**：不建议「推倒重写」。这套 Rust 的问题不是「代码烂到该重写」，而是**同一份知识有第二份实现**，于是每次修 bug 都只能打在消费端 —— 补丁因此越打越多。
> 正确做法是**一趟删除 + 一趟归位**：先把 74 条已取证的缺陷分级止血，再把重复实现收敛到单一来源，最后才谈结构重排。
> 本文配套取证：`docs/audit/2026-11-rust-core/{agent,memory,index,graph}.md`（逐条带 `文件:行` 与代码原文）；`{rpc,runtime,planner}.md` 只有「2026-11-18 收尾批」的一页进度记录（逐条取证未落盘，未闭合项看该文件自己的 F 编号）。
> **进度（2026-11-19 复核）**：P0–P8 全部落地（`cargo test` 239 → **346 全绿**），另加**拆 5 个 crate**（§11）、**R2 出站投影**（§12）、**抽取层二选一**（§13）、§10.8 收尾三件（§14）、**CI 两套 feature 闸门**（§15）、四处减法（§16）、三个巨型函数拆分（§17–§18）、跨语言契约债收口（§19–§20）、**请求快照大字段去重**（§21）。§2 的 19 条 A 级全清零；`docs/ARCHITECTURE-DEBT.md` 里 §6 / §10 / §11 / §12 四条「需决策 / 未动」均已收口。

---

## 0. 结论先行

**三句话**

1. **该重写的不是这套代码，而是「契约的存放位置」**。RPC 字段、token 折算、溢出词表、折叠标记、维度口径、图抽取规则，这些知识现在都是「Rust 一份 + Node 一份 + 注释写着务必对齐」。重写 Rust 之后这层双写**原封不动**留在原地，bug 会以同样的形状在新代码里长回来。
2. **「还有哪些 bug」不能靠感觉，只能靠可复现的证据**。本次对 7 个模块做了静态审计并逐条核对到行：**74 条**（high 27 / medium 38 / low 9），其中 **19 条是「现在就在错」**（A 级），**11 条是「静默劣化」**（不报错但质量下降）。表在 §2，详档在 `docs/audit/`。
3. **方案是 7 批、可独立停在上线**：P0 止血（2–3 人日）→ P1 契约生成与闸门 → P2 巨石文件拆分 → P3 单一来源收敛 → P4 生命周期与错误处理 → P5 「做不到」显式化 → P6 死代码清除。**没有一批需要"停功能一周"**，也没有一批是"先重构后再说行为"。

**明确不做**（详见 §7 负向清单）

- 不做「一次性全量重写」：26.7k 行里承载的是 20+ 轮线上回归换来的隐含约束（思考不顶正文、折叠保 tool_call 骨架、`fold:L` 幂等档位、worktree 写作用域…），这些**没有一篇文档写全**，重写等于把它们重新变成未知。
- 不引入 DI 容器 / async-trait 抽象层 / 换 rusqlite → sqlx：这些是「用新机制掩盖职责不清」，按 AGENTS.md 原则 2 属于加法反模式。
- 不把工具执行搬进 Rust（平台能力在 Node，见 `docs/NODE-THINNING-PLAN.md` §6）。

---

## 1. 现状账（测量基线）

| 项 | 数字 | 说明 |
|---|---|---|
| Rust 源码 | **66 文件 / 26,748 行** | `crates/dieyun-core`，含 `#[cfg(test)]` |
| 单测 | **264 个，全绿**（13s；P0 落地前 239） | `cargo test -p dieyun-core --lib`；`main.rs` / doc-tests 0 个 |
| 最大文件 | `index/mod.rs` 1935、`memory/mod.rs` 1488、`agent/loop_run.rs` 1481、`rpc/mod.rs` **1454 → 304**（P1 已把 86 条臂全部搬进 `handlers/`）、`planner/run.rs` 1310、`graph/mod.rs` 1112 | rpc/index/memory 三个是「巨石 + 测试占一半」 |
| **最大测试缺口** | `rpc/mod.rs` 曾 **1454 行、85 条分派臂、1 个测试**（还钉着一个不存在的 `memory.status`）→ P1 后：方法表 + parity/可达性测试 + 每方法 handler（86/86） | 所有跨进程契约都从这里出去 |
| 近 400 次提交里最热的文件 | `memory/mod.rs` 19 次、`rpc/mod.rs` 16 次、`memory/schema.rs` 10 次、`index/mod.rs` 10 次 | 热点 = 补丁密度最高的地方 |
| 静默吞错气味 | `let _ =` **123** 处、`.ok()` **19** 处、`unwrap_or_default()` **40** 处 | 含测试；生产代码里集中在清理/迁移/写回路径 |
| panic 面 | `unwrap()` **683**、`expect()` **260** | 绝大多数在测试；危险的是 `Mutex::lock().unwrap()`（17 处）与字节切片 |
| 观测能力 | `eprintln!` **13** 处、`tracing` **0** 处 | `docs/ARCHITECTURE-DEBT.md` §2 的「结构化事件」仍未做 |
| 本次审计发现 | **74 条**（A 级 19 / B 级 35 / C 级 11 / D 级 9） | 7 模块并行静态审计 + 我逐条核对高危项 |

**审计覆盖**：agent（driver/loop_run/llm）、memory、rpc、index、graph、runtime（compaction/embedding/config/sqlite/main）、planner。
**未覆盖**：`embedding/local.rs` 的 dylib 加载（只做静态推断）、tree-sitter grammar 自身行为、planner 的 worktree 隔离（在 Node）。

---

## 2. 「还有哪些 bug」：分级缺陷地图

> 分级口径：**A = 现在就在错**（可复现，用户能感知）；**B = 条件触发**（潜伏）；**C = 静默劣化**（不报错但质量下降）；**D = 结构债**（下一步会变成 bug 的地方）。
> 每条详档都有：证据原文 / 触发条件 / 修法方向 / 怎么确认（可执行的测试名或最小复现）。下表只列「先修什么」。

### 2.1 A 级（现在就在错，P0 止血对象）· **19 条已全部清零（2026-11-18）**

> 分布：P0 修 A1–A7 / A9 / A10 / A12 / A16（11 条）；P1 修 A15；P2 修 A8 / A11；
> **A13 / A14 / A17 / A18 / A19 于 2026-11-18 单独一批修完**（下面表格保留原始证据，供回溯）。

| # | 缺陷 | 位置 | 用户能看到什么 |
|---|---|---|---|
| A1 | **cancel / 出错的 run 永不释放**：`runs.remove` 只在 `finish_run`，cancel 只置位不复位 | `agent/loop_run.rs:475,840` | 长驻进程里 transcript 越积越多；同一个 runId 之后永远回「已取消」 |
| A2 | **取消是死信号**：RPC 层 `agentCancelled` 恒 true（cancel 找不到也返回 Ok），宿主停止路径调的 `agent.loop.cancel` 在 Rust 侧已删除 | `rpc/mod.rs:843`、`src/main/ipc/agent-runtime.js:682,771` | 点「停止」看不出是否真停；Rust 侧一个 run 都没取消 |
| A3 | **思考顶正文的残留分支**：撞上限分支用 `llm.content` 当 assistant 正文与 `trace.visibleContent`，绕开了 `delivered_content()` | `agent/loop_run.rs:540-549` | 单通道模型的思考被当成回答显示、并被回灌模型 |
| A4 | **本地向量维度写错**：写 `embedding.dimensions`(1024) 而非 `effective_dimensions()`(768)，4 处 | `memory/longmem.rs:509,538`、`index/mod.rs:169,1152` | 语义召回恒空、近重复不抑制、跨 worktree 向量复用 100% 落空、面板维度说谎 |
| A5 | **精确去重不带 scope**：别的项目写过的同一句话被吞掉 | `memory/longmem.rs:200-214` | B 项目里"写了却搜不到" |
| A6 | **删会话不清理归档/快照**：已删会话的折叠原文仍可被检索出来 | `memory/session.rs:438-461`、`archive.rs:230-237` | 删了的东西还会被交给模型；库只涨不消 |
| A7 | **graph callers/callees 恒空且没有「未建」信号**：默认结构图不带调用边，agent 侧还关掉了补建 | `graph/types.rs:93-100`、`rpc/mod.rs:763`、`delegate-tool-gateway.js:457` | 模型把"查不到"当"没人调用"，据此改坏代码 |
| A8 | **结构增量重建静默吃掉调用边**：`clear_file_graph` 无条件删出边，`calls_missing` 只看全局 `call_count==0` | `graph/build.rs:111,441,734` | 编辑过的文件从此永久丢调用边，只有 force 全量能回来 |
| A9 | **planner 评审把「不合法输出」当验收通过**：`accepted` 缺省 `true`，非 JSON 也 `true` | `planner/plan_parse.rs:366-393` | 验收→重试闸门整层失效，坏产出直接进汇总 |
| A10 | **planner best-of-N 只抬不压**：`max(cfg, model)`，cfg=0 也照开 3 路 | `planner/run.rs:1067-1070` | 关掉的 best-of-N 被模型一句话打开，成本 ×3 |
| A11 | **增量索引对「路径还在但已不可索引」的文件永不清理** | `index/mod.rs:929-935,967-1010` | 搜索继续返回文件里已不存在的内容 |
| A12 | **本地向量运行时加载失败被 `OnceLock` 永久缓存** | `embedding/local.rs:124-140` | 用户补装 onnxruntime 后仍报不可用，**必须重启 core** |
| A13 | **token 估值漏 `reasoning_content`，却与服务端 usage 直接相减** | `compaction/tokens.rs:72-78`、`fold.rs:93-97,163` | 带思考的模型永远估不准 → 该折不折；遥测虚报节省量 |
| A14 | **`rpc.cancel` / 一半 async 臂直接同步跑 rusqlite** | `rpc/mod.rs:1225-1269` | 5 条 memory 方法把 tokio worker 钉住，并发时 ping 都超时 |
| A15 | **`memory.messages_clear` 与 `session_delete` 合并成一个臂**，语义是删整个会话行 | `rpc/mod.rs:336-342` | 任何一天有人把它接到"清空对话"，用户丢整个会话 |
| A16 | **`llm.complete` 被漏出超时表**：660s 预算挂在已删除的 `agent.llm.chat` 上，真正在跑的只有 120s | `src/core-rpc-timeouts.js:66-69` | 长回答说到一半突然失败 |
| A17 | **折叠幂等靠全文搜 `fold:L`**：工具输出里出现这串字就永远不再折 | `compaction/fold.rs:327-335` | 模型读过 `fold.rs` / `CONTEXT-FOLD.md` 之后该条消息永久留在上下文 |
| A18 | **`planner` 恢复检查点失败被静默吞掉**：已完成子任务全部重跑 | `planner/run.rs:110-132` | 「又从头跑了一遍」，还重写 worktree |
| A19 | **`compaction.estimate` 对形状错误入参返回 `{tokens:0}`** | `compaction/mod.rs:27-33` | UI 圆环显示"空上下文" |

### 2.2 B 级（条件触发，P1/P4 处理）

| 缺陷 | 位置 | 触发条件 |
|---|---|---|
| 溢出词表两套 + Node 把 core 的硬失败降级成 `phase:'done'` | `driver.rs:189-197` / `rust-loop-runner.js:558-567` | 上游措辞落在 Node 清单：一次「正常完成的空轮」 |
| 溢出自愈无条件重发（`fold_now` 返回值 `?;` 丢掉） | `driver.rs:147-152` | 预算为 0 / 折不动：白花一次 token 与等待 |
| 流式从不申请 `stream_options.include_usage` | `agent/llm.rs:333-338` | 所有流式 run：usage 恒空、成本统计全空 |
| tool_calls index 无上限 + 缺 index 跨块串槽 + name `push_str` 拼接 | `agent/llm.rs:196-215` | 兼容网关：参数被拼错、工具名变 `fs_read_filefs_read_file` |
| SSE 只处理 `choices[0]`，`finish_reason` 丢 → 截断的工具调用照样执行 | `agent/llm.rs:102-113` | `n>1` 或中转合并 choice |
| `agent.run.tools` 漏传 results → 整批工具被记成"未返回结果"并继续 | `loop_run.rs:762-770` | 上层裁剪/重试漏字段 |
| `core.configure` 半应用：config 已指向新库、`MemoryStore` 还是旧库，无回滚 | `rpc/mod.rs:933-971` | 新路径不可写：写入落旧库、`ping` 报新路径 |
| 分派任务无 panic 兜底、stdio 三处写失败被吞 | `rpc/stdio.rs:60-90`、`events.rs:36` | 任一 panic：宿主干等 120s，连 error 行都没有 |
| schema 迁移 16 条 ALTER 全 `let _ =` | `memory/schema.rs:208-267` | 旧库升级失败只会在业务 RPC 炸 `no such column` |
| `recent_messages` 按 `created_at` 排序 | `memory/session.rs:352-371` | 同毫秒多条：历史顺序倒转 |
| 语义召回手写可见性谓词（丢 `expires_at`/`stale`） | `memory/recall.rs:611-617` | stale 行永不被注入 / 过期行被注入 |
| `FOREIGN KEY ... CASCADE` 声明了但 `foreign_keys` 没开（index + graph 两处） | `sqlite.rs:70-72`、`graph/schema.rs:78`、`index/schema.rs:167` | 孤儿行/孤儿边，任何新删除路径都会犯 |
| 相似度 NaN 不受阈值约束 / 向量池维度取「第一行」 | `index/vector_pool.rs:104,36` | 上游返回 NaN，或模型切换后的残留行：向量通道静默消失 |
| chunking 整段压在一个写事务（分钟级），embedding 又逐条隐式事务 | `index/mod.rs:962,201` | 与 graph 建库并发：`database is locked` |
| `apply_configure` 非原子 + `main.rs` 把它 `.ok()` 掉 | `config.rs:96-117`、`main.rs:66,84,107` | 一个工作区路径失效：llm/embedding 静默不生效；CLI 下白名单 fail-open |
| 远端 embedding 120s 超时吃在交互查询上，`EMBEDDING_TIMEOUT_CODE` 无消费方 | `embedding/remote.rs:31-39` | 端点挂住：每轮对话先卡 120s |
| 远端 embedding 回包 `index` 错位 → 向量静默对应到错的文本 | `embedding/remote.rs:142-154` | 部分行带 index：检索永久错位，不报错 |
| `fs_read_file` 按字节切 + `from_utf8_lossy` → 中文被切成 `�` | `fs_ops.rs:41-70` | 分块读中文：模型去"修"一处不存在的乱码 |
| `planner` `to_lowercase()` 与原文混用字节偏移 → panic，std Mutex 毒化后 planner 永久不可用 | `planner/run.rs` | 上游可控的大写文本 |
| `planner` 撞轮次分支丢弃整批 results、跳过验收、用某一路半成品顶最终答复 | `planner/run.rs:566-572` | 长任务几乎必经 |
| graph `ingest_lsp_callers` 先删后插、无事务 | `graph/lsp_ingest.rs:13-51` | 二次 ingest + 文件被重索引：LSP 边净丢 |
| graph 抽取不判 `has_error`，AST 与启发式结果混进同一个库 | `treesitter/extract.rs:12-22` | 半保存/混语法的文件：ERROR 区之后的 import/call 全丢 |
| `MAX_GRAPH_FILES` 作用在全部文本文件上再按语言过滤 | `graph/extract/files.rs:15-20` | 文档多的仓：代码目录整个不进图，无截断信号 |

### 2.3 C 级（静默劣化，P3/P5 处理）

- 关键词召回分数量纲跨分支不同，Node 用单一绝对阈值 0.12 → 注入与否取决于查询词长度（`memory/recall.rs:545,513`）。
- 子串通道把「路径命中」也算命中 → `hits` 可大于词元数 → 全覆盖强证据静默丢失（`index/search.rs:444,481`）。
- 命中行定位区分大小写、摘录预算按字节（`index/search.rs:497,564`）：命中词既不定位也被截掉，中文比 Node 的 2400 字符更早截断。
- 同一行数据两套 JSON 形状，Node 被迫 `r.createdAt || r.created_at`（`memory/recall.rs`、`misc.rs`）。
- `apply_configure` / `prune_missing_workspaces` 在写锁内做文件系统探测；Linux 上「未挂载的卷」被判成"已删除"（`index/mod.rs:301,1363`）。

### 2.4 D 级（结构债：下一批 bug 的温床）

1. **契约靠注释**：RPC 字段/默认值/阈值/词表在 Rust 与 Node 各一份（`N1.3` 的生成器仍未做）。
2. **同一语义多入口**：`async match`（27 臂）vs `ServiceSnapshot::dispatch`（58 臂）决定"谁阻塞"；本地 `run_index` vs 远端 `index_remote` 两份逐字重复；AST 抽取 vs 启发式抽取两套规则。
3. **巨石文件**：`rpc/mod.rs`（1454 行 / 85 臂 / 1 测试）、`index/mod.rs`（1935 行 / 7 职责）、`loop_run.rs`（1481 行 / 5 职责）。
4. **吞错文化**：`let _ =` 123 / `.ok()` 19 / `unwrap_or_default()` 40，集中在清理、迁移、写回。
5. **没有「我做不到」的字段**：`CallGraphResult` 没有 `callGraphBuilt`，`GraphStatus` 没有 `truncated`，`compaction.estimate` 用 0 表示"算不出来"。**没有信号 = 模型把失败当事实**（A7 就是这条的直接后果）。
6. **可观测面缺位**：`eprintln!` 13、`tracing` 0；事件通道覆盖不全（`agent.delta.round` 三个调用点硬写 `None`）。
7. **schema 双真相**：`CREATE TABLE` 与 `ALTER` 清单人工同步（memory 16 条、graph 2 条），新增列只改一处 = 老库静默缺列。
8. **死代码无人清**：`index/remote.rs` 整条链路（344 行）无 RPC 入口、`Accumulator.started`、`EMBEDDING_TIMEOUT_CODE`、`.env` 白名单、`messages_clear` 别名、`request_budget_ms`。

### 2.5 核实后「不是 bug」的（避免后来人重复怀疑）

- `AppState::new` 里的 `panic!`：`MemoryStore::open` 全惰性，实际不可达。
- `codebase.index.start` 不传 `vectors`：意图已在 `gateway/rpc.js:1752` 解析完。
- `memory.messages_search` / `compaction_folded` 的 `snippetChars`：Rust 内部 `clamp(60,2000/4000)`，不越界、不切碎中文。
- `ConfigureParams` 是 snake_case，与 `gateway/server.js:321` 一致；`LlmConfig` 是 camelCase，与 `llm-complete.js` 一致。
- `index/walker.rs` 的忽略规则与 `src/index/source-files.js` 目前**未漂移**（有 `ignore-rules-parity` 测试兜着）。

---

## 3. 补丁为什么越打越多：6 条机制原因

> 这一段是方案的设计依据 —— 不解决这 6 条，重构只会把同样的补丁换到新文件里。

1. **修在消费端，而不是修在唯一来源。**
   例：上下文溢出词表 Rust 5 条 / Node 8 条；`echoReasoning` 在 Node 能力表、内核却无条件回传；`live` 修复 6631579/4d81e15/30fb083 三次都打在 `llm.rs` 的同一条分支上。补丁在"最近一次出错"的地方落下，而不是在"这份知识该住的地方"。
2. **同一份知识有 N 份实现，测试只锁住其中一份。**
   `take_ident` 5 份 / `scan_call_targets` 5 份 / `strip_comment` 3 份 / `CALL_SKIP` 4 份；`run_index` 本地与远端两份；长记忆行形状 3 份。**双跑 fixture 只有 token 估算这一处做过**（`test-fixtures/token-estimate-cases.json`），其余全靠注释。
3. **巨石文件让"改一处必改另一处"成为必然。**
   `rpc/mod.rs` 85 条臂共用一份 `match`，超时/阻塞/校验三种策略靠"写在哪张 match 里"表达；`index/mod.rs` 一个文件 7 种职责。文件越大，"就近打补丁"的概率越高。
4. **默认值代替错误。**
   123 处 `let _ =` + 19 处 `.ok()`：清理失败留着孤儿、迁移失败延迟到业务 RPC 才炸、写失败静默。**库里看不见的垃圾，最后都会以"查不到/召回变差"的形状回来**（A4/A7/A8 都是这条的下游）。
5. **失败没有字段可写，于是被写成成功。**
   `accepted` 缺省 true、`callCount==0` 代表"调用图没建"、`tokens:0` 代表"算不出来"。用法是"如果拿不到信号就当没事"。
6. **没有跨语言闸门，只有自证循环。**
   `verify:rpc-catalog` 比的是"生成物与生成物"（生成器的正则还认不出交替臂，A15 就是这样漏的）；Rust 侧超时 20s / Node 侧 15s，谁都不会红。

---

## 4. 目标形态

### 4.1 分层（一行一责）

```
transport   rpc/stdio.rs      只做帧（读行、写响应、panic → error 帧）
registry    rpc/registry.rs   方法表：name / params 类型 / 预算 / 阻塞与否 / handler   ← 新，取代 85 臂 match
services    agent/  memory/  index/  graph/  planner/  embedding/   （各自 commit 边界清晰）
support     sqlite.rs  config.rs  error.rs  blocking.rs  obs.rs      （obs.rs = 结构化事件，替 eprintln）
```

判据（一条改动该放哪）：**是不是"账本/策略"** → services；**是不是"平台动作"** → Node；**是不是"协议"** → registry；**是不是"底座细节"** → support。

### 4.2 四个必须新增的机制（每个都说明「为什么删不掉」）

| 机制 | 替代了什么加法 | 为什么不能靠"加开关/加兜底"替代 |
|---|---|---|
| **R1 RPC 注册表**（表驱动分派 + 生成 `types/core-rpc.d.ts` + 修正 catalog 生成器认交替臂） | 删掉 1454 行 match 与"哪些方法阻塞"的两份清单 | 字段漂移只有"生成 + `tsc --noEmit`"能永久锁住；靠注释对齐已经失败 3 次（见 §3.1） |
| **R2 出站投影**（账本 messages → 上游 body 的**唯一**函数，含 `synthetic` 剥离、`echoReasoning` 策略、`stream_options`） | 删掉 Node 的 `sanitizeMessagesForChatApi` 与内核"直接序列化"两套 | 出站形状是**一份知识**，只能有一个作者；两份必然分叉（Node 侧 `echoReasoning` 对内核无效就是分叉） |
| **R3 结果状态字段**（`callGraphBuilt` / `truncated` / `filesSkipped` / `tokens: null`） | 删掉 Node 侧 `callCount>0`、`indexed&&!stale` 这类代理推断 | 代理推断的失效是静默的（A7 让模型把"没建"当"没人调用"）；状态字段是唯一能让"做不到"变成可读错误的地方 |
| **R4 结构化观测**（`obs.rs`：`[rpc-slow]` / 折叠事实 / 每轮 usage / 工具耗时统一走事件；删 13 处 `eprintln!`） | 删掉"grep 日志"的排障方式 | 诊断价值的唯一合法落点；同时是 §6 闸门的数据来源 |

### 4.3 不动清单（防下一轮误搬，与 `NODE-THINNING-PLAN.md` §6 对齐）

工具执行、`src/gateway/`、`src/ssh`、`src/mcp`、`src/lsp`、`src/browser`、`system-prompt-prep`、`tool-gate`、`completion-readiness`、`agent-round-text`（交付四态）—— **留在 Node**，重构 Rust 不碰。

---

## 5. 施工批次

> 每批都可独立上线、可停；每批先写「会红的用例」再改（缺陷转用例），这是本方案唯一不可省的纪律。

### P0 · 止血（2–3 人日，风险低）· **已落地 2026-11-17**

> 结论：9 项全部落地，`cargo test -p dieyun-core --lib` **239 → 247 全绿**，`npm test` / `npm run check:js` / `node scripts/test-rust-loop-runner.cjs` 通过。
> 每条都先落会红的用例（A3 已做变异验证：把修复改回去，用例确实红）。

| 项 | 内容 | 验收（实际用例名） | 状态 |
|---|---|---|---|
| P0.1 | A1 + A2：run 生命周期 RAII（`driver.rs:RunLifetime`）、`cancel` 返回真实 bool + 立刻释放大字段、删宿主侧 `agent.loop.cancel` 两处改走 `agent.run.cancel` | `cancel_reports_truth_and_drops_the_run` | ✅ |
| P0.2 | A3：撞上限分支改用 `delivered_content()`（轮次上限 + 工具次数上限两处） | `single_channel_limit_never_stores_reasoning_as_answer`（已变异验证） | ✅ |
| P0.3 | A4：落库维度改为「跟着向量走」/`effective_dimensions()`（memory 2 处、index 2 处、remote 1 处） | `stored_vector_dimensions_come_from_the_vector_not_the_config` | ✅ |
| P0.4 | A5 + A6：精确去重带 scope、`clear_session` 补删 `compaction_archives` / `request_snapshots` | `exact_dedupe_is_scoped`、`clear_session_purges_archives_and_snapshots` | ✅ |
| P0.5 | A7：`CallGraphResult.callGraphBuilt` + `note`（未建时一句话说明），并写进模型可见的工具描述 | `call_graph_is_built_on_demand_and_backfills_unchanged_files`（扩了三条断言） | ✅ |
| P0.6 | A9 + A10：`accepted` 缺省 false（含字符串/数字/嵌套形状归一）、`best_of_n` 只压不抬 | `review_never_treats_unclear_output_as_accepted`、`finalize_plan_never_raises_best_of_n_above_the_host_cap` | ✅ |
| P0.7 | A12：dylib 加载失败不入 `OnceLock`（只缓存成功），并把缓存语义抽成可测的 `ensure_runtime_cached` | `runtime_failure_is_not_cached_but_success_is` | ✅ |
| P0.8 | A16：`core-rpc-timeouts.js` 删幽灵 `agent.llm.chat`、加 `llm.complete` 走 660s | `test/unit/core-rpc-timeouts.test.cjs`（4 条） | ✅ |

**为什么先做这批**：19 条 A 级里有 8 条是「一行到五行」，但每一条都在**持续产生用户可见的错误结论**（尤其 A4/A7：模型基于错的检索结果做决定）。修它们不需要任何结构改动。

**这批留下的尾巴（进 P1/P4，不要忘）**
- A2 的取消仍只拦「交付」不打断在途请求：`cancel` 置位后，在途那次 600s SSE 要等下一层观察才收手。真要打断请求需要传输层的取消令牌（`llm.rs`），归 P4。
- A7 的 `callGraphBuilt` 来自 `graph_workspaces.call_count > 0` —— 这仍是代理判据（见 graph 审计 F2：增量重建会吞掉调用边）。真正的修法是把 scope 落库，归 P3。
- A4 的 index 侧只改了「写入用什么维度」，读侧缓存按生效维度校验；跨 backend 混存的极端情形仍靠 P3 的单一来源收口。

### P1 · 契约与闸门（4–6 人日，风险低）· **已全部落地 2026-11-17**

> 已落地四块（`cargo test` 239 → **264 全绿**，`verify:rpc-catalog` / `check:js` / `check:shared-constants` / `check:renderer` / `build:renderer:dev` / `npm test` 通过）：
> ① 跨语言数值与词表单一来源；② 三条跨语言双跑 fixture；③ catalog 生成器修交替臂 + d.ts + 两条新闸门；④ RPC 方法表 + **86/86 handler**（`rpc/mod.rs` 1458 → 304 行）+ parity/可达性测试。
> （唯一不在本批的遗留：7 个老文件的 pragma 归位 + 19 处类型债，见文末「唯一未做」。）

- ✅ **数值/词表单源**：`src/agent/agent-shared.json`（14 个键）→ Node `src/agent/shared-constants.js` / Rust `crates/dieyun-core/src/shared.rs`（`include_str!` 编译期嵌入）。
  改读点：`agent-limits`（token 系数 ×2 + 图片等效字符 + snippet 预算）、`model-runtime-by-tier`（窗口地板）、`compaction-main`（触发比夹取）、`fs-read-limits`（三个读上限）、`core-rpc-timeouts`（慢请求阈值）、`llm-reconnect-retry`（溢出词表）；Rust 侧 `tokens.rs` / `fold.rs` / `config.rs` / `rpc/mod.rs` / `agent/driver.rs`。
  - **4096 vs 8192 的处理**：核实后确认二者不是同一个数（8192 = Node 的**窗口地板**派生基准；4096 = 内核对「别人递进来的预算」的守卫），所以没硬合并，而是把 8192 放进共享文件 + Rust 侧测试断言 `守卫 ≤ 窗口地板`，两者关系由测试锁死。
  - **顺手修掉的真 bug**：`index/search.rs` 的摘录预算此前是「3600 **字节**」与「字符」上限比较，中文正文只有约 1/3 预算（≈1200 汉字就截断），比 Node 的 2400 字符更早 —— 现在按字符算，预算 4800 字符（共享文件里，且测试断言必须大于 Node 的）。
- ✅ **双跑 fixture**：`test/fixtures/context-overflow-cases.json`（15 条上游文案，Rust `driver.rs` + Node `cross-language-fixtures.test.cjs` 读同一份）、`test/fixtures/snippet-budget-cases.json`（摘录预算的关系与字符口径），加上已有的 `token-estimate-cases.json`（含图片等效 1875）= 3 条。
- ✅ **catalog 闸门**：生成器认 `"a" | "b" =>` 交替臂（`memory.messages_clear` 正是这么漏的）；新增「Node 调用但 catalog 无实现」检查（`agent.loop.cancel` 那类死调用现在会红）；产出 `types/core-rpc.d.ts`（方法名 union + 层归属表，已纳入 `check:js`）。
- ✅ **RPC 方法表（R1 的骨架）**：新增 `crates/dieyun-core/src/rpc/registry.rs` —— **86 个方法**（27 Async / 59 Blocking）的名字、路由、预算档位**只写在这张表里**；`AppState::dispatch` 先查表：未知方法立刻回 `UNKNOWN_METHOD`（不再落进兜底分支被当成阻塞方法），Blocking 项统一走阻塞池。
  - 删掉了 `request_budget_ms`（方法名白名单）与 `FAST_METHOD_BUDGET_MS=20s`：预算改由表里的 `Budget::{Fast,None}` 给。**顺手修掉一条死机制**：20s > 宿主侧最小超时 15s，那条预算永远轮不到触发；现在 10s，先于宿主发声，错误里带方法名。
  - parity/可达性测试（搬完之后**只剩两类**，因为「表 ↔ 臂」那条已失效——没有臂了）：①表无重复；②只有轮询类方法带预算；③`.status` 集合就是实际存在的三个（旧测试断言的 `memory.status` 从来没实现过）；④**方法名不许出现在 dispatch 里**（扫源码，钉「加方法漏登记」）；⑤**可达性**（端到端，86 个方法各调一次，都没有 `UNKNOWN_METHOD`——变异验证过）。
  - catalog 生成器现在同时认「表行」与「分派臂」，所以把臂搬进 handler 文件之后闸门不会失效。
- ✅ **A15**：`memory.messages_clear` 别名已删（Rust 侧只留 `session_delete`：它删的是**会话行**）。
- ✅ **每方法一个 handler：86 / 86（全部搬完）** —— `rpc/mod.rs` **1458 → 304 行**。
  - 阻塞侧 59 个：`handlers/{memory 37, graph 9, agent 6, codebase 2, fs 2, system 3}.rs`；async 侧 27 个：`handlers/{async_core 15, async_data 12}.rs`（签名 `fn(&'a AppState, &'a Value) -> BoxFuture<'a>`）。
  - `AppState::dispatch` 现在只剩：查表 → `Impl::Async` 直接 await / `Impl::Blocking` 扔阻塞池。**没有 `match method`**，方法名只存在于表里。
  - 迁移中顺手做的减法：删掉 `MethodSpec.route` 字段 —— `Impl` 的变体已经表达「谁阻塞」，两份信息只会漂移；`ServiceSnapshot::dispatch` 那条只剩兜底的 `match` 也整段删除。
  - 闸门从「扫源码对名字」升级成两类：
    1. **可达性 parity（端到端）**：`every_registered_method_reaches_an_implementation` 用临时 `AppState` 把 86 个方法各调一次（参数传 `{}`），断言没有一个是 `UNKNOWN_METHOD`/「没接实现」—— 变异验证过（把 `memory.ping` 过滤掉，立刻红）。
    2. **方法名不许再出现在 dispatch 里**：`no_method_names_left_in_the_dispatch_chain` 扫 dispatch 函数体，出现任何表里的方法名就红（钉住「加方法漏登记」这条历史事故）。
  - handler 单测：8 条（`fs.read_file` 缺参、`codebase.index.start` 缺 embedding 必须报错、`embedding.status` 维度同源…）。
- ✅ **`// @ts-check`（三个 core 调用方全部生效）**：
  - `src/agent/llm-complete.js`：方法名写成 `/** @type {import('../../types/core-rpc').CoreRpcMethod} */ const LLM_COMPLETE_METHOD = 'llm.complete'` —— 变异验证过：改成 `llm.complet`，`check:js` 立刻 `TS2820`。
  - `src/agent/rust-loop-runner.js`（645 行）+ `src/core-bridge.js`（459 行）：开 pragma 后暴露 **23 处**类型错，全部按「类型没描述真实形状」修正（**只改 JSDoc / 局部标注，运行期逻辑零改动**）：
    - `opts` 漏写 `log` / `foldSpec`；`llm` 缺 `sessionId` / 应为可选；
    - 桥的形状没写 `onCoreCall`（core→宿主反向调用真的挂在这个字段上）→ 抽 `@typedef CoreBridgeLike` 给两处共用；
    - `getAgentLimits()` 没有返回类型（推断成 `{}`）→ 声明 `Record<string, any>` 并写清「为什么不为几百个键逐一declare」；
    - `Error` 上不存在 `.code`（协议错误码 / errno）→ `@typedef CodedError`；`abortPending(opts)` 漏 `methods`；在途表漏 `startedAt`；`lastUsage` 标 `any`。
  - **顺带发现一个假闸门**：`// @ts-check` 写在 `'use strict';` 之后**会被 TypeScript 忽略**（pragma 必须在任何代码之前）。仓里原有的 7 个 `@ts-check` 文件全是这个写法 —— 也就是说 `npm run check:js` 这些年只验证了「文件能解析」，没检查过类型。这 7 个文件（`agent-limits` / `run-events` / `mcp-plans-boot` …）挪到首行会立刻暴露 **19 处**类型错，属**独立任务**，别混进功能改动（见下方「未做」）。
- ⏳ **唯一未做（独立任务，非 P1 范围）**：上面那 7 个文件的 pragma 归位 + 19 处类型债。做完之后 `npm run check:js` 才覆盖全仓 scoped 文件。
- ⏳ **未做（一项）**：`rust-loop-runner.js` / `core-bridge.js` 上 `// @ts-check`。实测代价：仅 `rust-loop-runner.js`（645 行）就有 **13 处**类型错（多为 JSDoc 与实现脱节：`mcp-plans-boot` 的 `isBusy` / `plansIdlePollMs` 已不存在、`run-events` 的 `AgentRunEventType` 收窄等同类问题），要先判定「是类型过期还是代码错」才能改 —— 归到下面的类型债任务一起做，别混进 P1。
  3. （独立任务，非 P1）7 个文件的 pragma 归位 + 19 处类型债 + 这两个 runner 的 13+ 处，见上。

**原计划条目**（保留，供下一轮对照）

- R1 的前半：**RPC 注册表**（把 85 臂搬进 `rpc/registry.rs` + 每方法一个 handler 函数，`match` 变成查表）；同一批把 A15 的 `messages_clear` 别名删掉。
- R1 的后半：`scripts/generate-rpc-catalog.cjs` 认 `"a" | "b" =>` 交替臂 + 自检「臂数 == catalog 条目数」；产出 `types/core-rpc.d.ts`，`rust-loop-runner.js` / `core-bridge.js` 上 `// @ts-check`。
- 数值单一来源（`NODE-THINNING-PLAN N1.1`）：token 系数 / 图片等效 token / 预算地板 / 触发比夹取范围 / 读上限 / 慢请求阈值 → 一份 `src/agent/agent-shared.json`，两侧读同一份；**顺手修 4096 vs 8192 的不一致**。
- 跨语言双跑 fixture（`N1.2`）：先补 3 条 —— 溢出词表、忽略目录、展示截断口径。

**验收**：`npm run verify:rpc-catalog` + `npm run check:js` + `cargo test -p dieyun-core --lib` + `npm run test:rust-agent-loop-smoke` + `npm run check:shared-constants`。

### P2 · 巨石拆分（5–8 人日，纯移动，风险中）· **已完成 2026-11-18**

> 只搬不改行为；每搬一块，`cargo test` 必须全绿且 diff 只含移动。

| 目标 | 拆成 | 附带收益 |
|---|---|---|
| ✅ `rpc/mod.rs` **1454 → 304** | `rpc/registry.rs`、`handlers/{memory,graph,agent,codebase,fs,system,async_core,async_data}.rs` | 每方法一个 handler（**86/86 完成**）；单测从 1 个涨到「表 parity + 可达性 + 8 条 handler」 |
| ✅ `index/mod.rs` **2249 → 1093** | `index/{status,vectors,build,repair}.rs` | **A11 已修** + **chunking 整段事务改分批提交** |
| ✅ `agent/loop_run.rs` **1637 → loop_run/{mod,ledger,trace,delivery,fold}.rs** | ledger 470 / delivery 73 / fold 46 / trace 45 | 交付四态只剩 `delivery::delivered_content` 一处入口（结构事实，不是约定） |
| ✅ `graph`：`mod.rs` **1121 → 906** + `build.rs` 909 → 820 | `graph/{status,queries,cleanup,incremental}.rs` | **A8 已修**（建库范围黏性落库）；「删符号连带删边」收进 `cleanup.rs` 一份 |

**三块共用的搬家纪律**（都在本批验证过）：脚本按 `impl` 的方法边界切块（doc 注释随方法走），每块带自己的 `use` 前奏；搬完立刻 `cargo test`，由编译器/测试指出漏掉的 import 与要放宽到 `pub(crate)` 的方法。唯一的可见性变化就是跨子模块互调的方法从私有变 `pub(crate)`。

**本批顺手修掉的两个真 bug**
- **A11**（index）：增量索引遇到「路径还在、但已不可索引」（超限 / 含 NUL）过去只 `continue` —— 库里永远留着这份文件**上一次**的正文，`codebase.search` 照旧返回给模型。现在永久不可索引 → 清旧 chunk；暂时读不到 → 保留重试。用例 `incremental_index_purges_chunks_of_now_unindexable_files`（变异验证）。
- **A8**（graph）：建过调用图之后，普通保存触发的**结构态**增量把该文件的出边删掉却不重建，而「未变文件要不要重解析」只看全局 `call_count == 0` —— 于是**编辑过的文件永久丢调用边**，只有 force 能回来。现在建库范围落库并黏性（`calls_built`），只有「结构态 → 调用态」这一轮才回填未变文件；`call_graph_built` / `callsBuilt` 也改读这一列（Node 两处 `callCount > 0` 的代理推断同步去掉）。用例 `structural_incremental_keeps_call_edges_of_edited_files`（变异验证）。

**验收**：`cargo test` 239 → **269 全绿**、零 warning；`npm test`、vitest（225 文件 / 2208 条）、`verify:rpc-catalog` 通过。

### P3 · 单一来源收敛（6–10 人日，风险中）· **已完成 2026-11-18**（第 6 条 A13 在收尾批完成）

| 项 | 状态 | 落点 / 证据 |
|---|---|---|
| ✅ **外键二选一** | 已做 | **选「删掉无约束力的声明」**（不是开 `foreign_keys`）：memory 库走 `SqliteHandle::new_with_foreign_keys`，它的 CASCADE 是真的；index / graph 的库连接按 `TuneOptions::foreign_keys=false` 打开，`graph_calls` 与 `chunk_vectors` 上的 `FOREIGN KEY … ON DELETE CASCADE` 从来没生效过 —— 删掉并在建表处写明「级联的唯一实现是 `graph/cleanup.rs` / `index/build.rs` 的写库原语」。顺手修掉第四处不一致：`memory/misc.rs` 的修剪线程以前 `open_tuned` + 手写 `pragma_update(foreign_keys, ON)` 且 `if …is_ok()` 放行（一次 pragma 失败就静默跳过整个修剪，孤儿 traces/plans 越攒越多），改用 `open_tuned_with(.., TuneOptions { foreign_keys: true })`（失败会 Err）。两条守卫用例 `schema_declares_no_unenforced_foreign_keys`（index / graph 各一条，扫 `sqlite_master` 的实际建表语句） |
| ✅ **命中位置一份** | 已做 | `fts::first_hit_byte(content, terms)` 是唯一实现（大小写不敏感，返回字节偏移）；`fts::first_hit_index`（摘录要字符下标）与 `index::search::first_hit_line`（要行号）都从它派生。此前 search 自己写了一遍 `content.find(term)`（**区分**大小写），于是「摘录围绕的位置」与「命中行」会指向不同地方。用例 `hit_position_has_a_single_source`。摘录预算按字符在 P1 已改 |
| ✅ **可见性 / 维度 / 形状三份收敛** | 已做 | ①**可见性**：`semantic_search_long` 以前手写 `m.status = 'active'`（关键词分支用 `long_mem_visible_sql`）→ 过期记忆照样能被语义召回，同一个问题问两次两套结果；现在两条分支共用 `long_mem_visible_sql`，SQL 成形在 `semantic_long_sql()` 里便于断言（绑定顺序 ?1 签名 / ?2 现在 / ?3 scope）。②**维度**：index 三处 P0/P1 已换 `effective_dimensions()`；远端回包的校验（`embedding/remote.rs`）也改成它 —— 数值本来就相同，但「判定口径」只有一处。③**形状**：`recall.rs` 里长记忆命中 JSON **三份**（`keyword_search_long_memories` / `keyword_search_long` / `semantic_search_long`，字段名还在 `created_at` 与 `createdAt` 之间来回）→ 收成 `long_mem_hit_json()` 一处，统一用 `created_at`（与完整行 `map_long_memory_row` 一致），分数统一 `round_score`。用例 `semantic_branch_uses_the_shared_visibility_predicate`、`hit_projection_has_one_shape`。**没并的**：`archive.rs` 的「搜索命中」与 `misc.rs` 的「增量同步整行」是两个不同契约（片段 vs 完整行），合并会把两种用途硬塞进一个形状 —— 已在代码注释里写明，不再当重复实现处理 |
| ✅ **五份抽取器合并** | 已做 | 新增 `graph/extract/heuristic.rs`（236 行）：`is_ident` / `take_ident` / `scan_call_targets(skip)` / `strip_comment(style)` / `extract_calls(skip, style)` —— 四个语言模块各自的 `take_ident`+`scan_call_targets`+`strip_comment`+`extract_calls` 全删，只留 `CALL_SKIP` 表与一行委托；`treesitter/extract.rs` 的第五份 `is_ident` 也改成用它。**顺手修的真 bug**：go / rust 的 `strip_comment` 是裸 `find("//")`（python 那份才是引号感知的），`print("http://x")` 会把整行后面的调用吃掉 → 静默少边；现在只有一份引号感知实现（含 `'` / `"` / 反引号模板串 + 转义）。**对称性用例** `ast_minus_heuristic_is_only_the_deliberate_skip_list`：精确不变量是 `AST \ 启发式 ⊆ CALL_SKIP`（AST 保留 `print` 这类内置调用，启发式按语言表故意滤掉；除这份故意跳过，启发式不许漏 —— 少报就是丢边）。净减 371 行 |
| ✅ **schema 声明式迁移** | 已做 | 新增 `src/db_schema.rs`：`Column { name, decl }` + `ensure_table(conn, table, columns, constraints)` —— **一份列清单**同时产出 `CREATE TABLE` 与 `ALTER TABLE ADD COLUMN`（补列只吞「列已存在」，其余上抛）。memory 的 `sessions` / `messages` / `long_memories` / `compaction_archives`（覆盖全部 16 条后加列）与 graph 的 `graph_workspaces` 改成列清单；`graph::ensure_schema` **不再「表存在就早退」**——这正是**真 bug**：老库（表已存在但缺 `symbol_count` / `call_count` / `calls_built`）永远不会被补列，`graph.status` 一查就是 `no such column`。用例：`existing_table_gains_missing_columns_in_declared_order` / `existing_table_is_still_reconciled` / `legacy_graph_db_gains_columns_added_later`（**变异验证**：恢复早退立刻红）/ `fresh_and_legacy_*_end_with_the_same_columns`（比列**集合**，老库列序取决于当年建表，不比顺序）。顺带修：`idx_messages_session` / `idx_compaction_archives_session` 原来在第一批建表里，改成声明式建表后会变成「先建索引后建表」→ 挪到建表之后 |
| ✅ A13 token 估值 | 收尾批已做 | 见 §2.1 |

**验收**：`cargo test` 281 → **284 全绿**、零 warning；`npm test`、`verify:rpc-catalog` 通过。

### P4 · 生命周期与错误处理（6–8 人日，风险中高）· **已完成 2026-11-18**

| 项 | 状态 | 落点 / 证据 |
|---|---|---|
| **折叠搬出全局临界区 + per-run 锁** | ✅ | `loop_run/mod.rs`：`runs: Arc<Mutex<HashMap<String, Arc<Mutex<RunState>>>>>` —— 外层 map 锁只保护「哪个 run 在哪」，O(n) 折叠跑在**本 run 自己的锁**上。纪律写进字段注释：**永远先放 map 锁再拿 run 锁**（`finish_run` 因此改成「先在 map 锁下摘句柄、放锁后再读 messages」）。用例 `one_runs_lock_does_not_block_other_runs`（握住 A 的锁 300ms，B 的账本操作必须 <150ms 返回；做过敏感性验证：让折叠侧也握 B 的锁 → 立即红） |
| `finish_run` 一次加锁 + poison 恢复 | ✅ | `loop_run/trace.rs`（`into_inner()` 明确恢复，不把「拿不到 messages」静默成 None） |
| **`agent.run.tools` 的 `results` 必填** | ✅ | `handlers/async_core.rs`：缺字段直接 `INVALID_PARAMS`。用例 `agent_run_tools_requires_results` |
| **分派 panic 兜底** | ✅ | `rpc/mod.rs`：`guard_panic()` → `RPC_PANIC` 错误帧（阻塞池那条本来就有 `BLOCKING_JOIN_FAILED`）。为它把 `futures-util` 从传递依赖显式化（不新增编译单元） |
| **`core.configure` 原子化** | ✅ | `handlers/async_core.rs`：候选 config 锁外算 + 新 MemoryStore 先建成功、再一次写锁整体替换。用例 `configure_failure_leaves_the_live_config_untouched` |
| **吞错清账** | ✅ | memory schema **16 条 ALTER** → `ensure_column` / `drop_column_if_exists`（只吞「列已存在 / 本就没有」）；`graph/cleanup.rs` 的 **4 条 DELETE `.ok()`** 改上抛 `GRAPH_CLEANUP_FAILED`；`index/repair.rs` 的 `let _ = graph::clear_workspace_rows(..)` 改成「诊断 + 跳过 + 下次重试」；`main.rs` 三处 `apply_configure(..).ok()` 改 `?`；`memory/session.rs` 那处标题补写**保留吞错并写明理由**（读路径顺手修复，不影响本次展示）。用例 `migration_swallow_tests` 2 条 |
| **A17 折叠幂等** | ✅ 收尾批已做 | `applied_level` 只认 `clip()` 写出的完整形状 |

> 剩下的 `let _ =` / `.ok()`（约 100 处）多数在测试与「删临时文件」「socket 写回」这类位置；
> `agent/driver.rs` 里 9 处是 `tool.execute` 反向调用通道的 socket 写（该通道按设计未接），
> 归 P6 死代码清除时一并处理。

**验收**：`cargo test` 274 → **281 全绿**、零 warning；`npm test`、`verify:rpc-catalog`、`check:js` 通过。

### P5 · 「做不到」显式化 + 观测（3–5 人日）· **已完成 2026-11-18**

| 项 | 状态 | 落点 / 证据 |
|---|---|---|
| **R3 显式化** | ✅ | ①`graph.status.callsBuilt`（P2，调用图建过没有）；②`index.status.filesSkipped` / `filesTruncated`（看见了但不可索引 vs 仓比 16k 上限还大 → 后者这一轮**压根没看到文件**）；③`compaction.estimate` 形状错误改硬报 `INVALID_PARAMS`（A19，选了「报错」而不是「返回 null」——调用方不会把 null 当 0 用）；④**`planner.done.truncated` + `truncatedNote`**：计划被宿主上限压低（模型要 3 路 best-of-N、设置关掉）时说一句人话，否则「为什么这条任务没有交叉验证」永远查不出来 |
| **R4 观测收口** | ✅ | 新增 `src/obs.rs`：`[rpc-slow]`（唯一一条，阈值仍读 `src/agent/agent-shared.json` 的 `rpc.slowLogMs`）、`[rpc-fold]`（折叠事实：档位 / 两个口径的 before / after / 触发源）、`[rpc-usage]`（每轮 prompt/completion/total，上游没给 `prompt_tokens` 就不写，避免假 0）、`[rpc-tools]`（工具段墙钟：`need_delegate` 出发打点、`agent.run.tools` 回来算差）。格式化函数是纯函数，4 条用例钉格式；只有 `emit` 碰 IO |
| **`agent.delta.round`** | ✅ 删字段 | 三处调用点全传 `None`（恒为 null 的字段），根因是语义不成立：增量属于「正在飞的那一轮」，而账本 `round` 收到响应才自增。删字段 + 宿主直接用 `llmRound` |
| **20s 预算机制** | ✅ 核实后不存在 | P1 已把 `FAST_METHOD_BUDGET_MS` 改成 10s（先于宿主 15s 发声），机制本身是活的（防轮询方法无限等），不删；`registry.rs` 里留了一句「历史上这里是 20s，等于死代码」 |
| **清陈旧注释** | ✅ | `INTERACTIVE_EMBED_BUDGET_MS` / `EMBEDDING_TOO_SLOW`（那三层补偿已删，注释改成说明现状）、`agent.llm.chat`（→ `agent.run.*` / `llm.complete`）、**45s 口径 → 15s**（`sqlite.rs` / `graph/mod.rs` 三处；真实值在 `src/core-rpc-timeouts.js`） |

**验收**：`cargo test` 297 → **302 全绿**、零 warning；`npm test`、`verify:rpc-catalog`、`check:js`、`check:shared-constants` 通过。

### P6 · 死代码清除（1–2 人日）· **已完成 2026-11-18**

**核实结果**（每个候选先 grep 全部调用点，含 Node 侧 RPC 名与注册表）：

| 候选 | 结论 |
|---|---|
| `index/remote.rs` 整条（344 行 + `RemoteIngestHandle`） | **真死**：核心 RPC 表里没有 `index.remote*`（Node 侧 `index.remote_*` 是 Gateway handler，另一个命名空间）。连带 `IndexService::index_remote` / `RemoteFileInput` / graph 的 `index_remote` / `index_remote_begin` / `index_remote_push` / `index_remote_finish` / `run_remote_build` / `remote_files` 字段，以及两条远端用例 —— **一起删**（−695 行 / +13 行） |
| `Accumulator.started` | 只写不读 → 删 |
| `EMBEDDING_TIMEOUT_CODE` | **不是死代码**：`embedding/remote.rs` 的两条超时分支都用它当错误码（调用方据此区分「端点没回」与「端点报错」）→ **保留** |
| `walker.rs` 的 `.env` 白名单 | 两处都不可达（`.env` 是隐藏文件，walker 直接跳过；`Path::extension()` 对点文件返回 `None`）→ 删 |
| `messages_clear` 别名 | P1 已删，只剩一句注释 → 无事可做 |
| `PlannerContinueInput.partial_body` | 三个赋值点、零读取点 → 删（连同 `RunState` 里那份） |
| `store.rs` 空注释 | **核实后不存在**（现存的两处 `//` 是多行注释的续行，有内容）→ 无事可做 |
| `graph/build.rs` 的 `MAX_GRAPH_FILES` | 与 `index::MAX_FILES` 同值同义 → `MAX_FILES` 提为 `pub(crate)`，graph 直接用 |
| `agent/driver.rs` 的 9 处 socket 写吞错 | **更正 P4 时的判断**：那些都在 `#[cfg(test)] mod tests` 里（`one_shot_server` / `recording_server` 假宿主），生产路径的反向调用走 `rpc::calls::call_host`（`round.prepare` 在用）→ 不删 |

**验收**：`cargo test` 298 → **296 全绿**（少的两条正是被删的远端摄取用例）、零 warning；`npm test`、`verify:rpc-catalog`、`check:shared-constants` 通过。

---

## 6. 闸门：怎么让「还有哪些 bug」不再增长

**每批的统一验收**

```bash
# 两套 feature 都要过（CI 就是跑这两条，见 §15）：默认特性 = 桌面 sidecar 口径，
# `--no-default-features` = 远端 Linux 包口径（不带 ORT）。少跑一套就是一条盲区。
cargo test --workspace --lib                        # 只许加不许减
cargo test --workspace --lib --no-default-features
cargo clippy --workspace --all-targets -- -D warnings             # 含测试目标
cargo clippy --workspace --no-default-features --all-targets -- -D warnings
npm run check:js                          # 含 types/core-rpc.d.ts 的字段检查
npm run verify:rpc-catalog                # P1 之后含「臂数 == 条目数」自检
npm run verify:core-contracts             # Rust @contract → types/core-contracts.d.ts 不过期
npm run test:rust-agent-loop-smoke        # 改 agent/ 必跑
npm run test:rust-planner-smoke           # 改 planner/ 必跑
npm run test:local-gateway-smoke          # 改 rpc/ 或 gateway 交互必跑
```

**三条长期闸门（P1 落地后永久生效）**

1. **契约闸门**：`types/core-rpc.d.ts` 由 Rust 侧声明生成，`tsc --noEmit` 报字段漂移；catalog 自检防止"实现了但文档没有"（A15 的漏法）。
2. **双跑闸门**：凡两侧都算的知识（token 系数、忽略规则、溢出词表、截断口径）必须共用一份 `test/fixtures/*-cases.json`，两侧测试读同一份。
3. **吞错闸门**：`#![deny(clippy::let_underscore_must_use)]` + 对 `Result` 的 `let _ =` 一律 `expect` 说明理由；`.ok()` 在白名单外禁止（CI 用 `clippy -- -D warnings` 跑）。**这一条比任何重构都便宜，也最能止血。**

**缺陷转用例纪律**：本文 §2 的每条 A/B 级 finding 在修之前先落一条会红的测试（详档里每条都写好了测试名或最小复现）。修完测试名保留 —— 这是防"补丁回潮"的唯一机制。

---

## 7. 如果坚持「整体重写」：前提、范围、代价

**先说代价（诚实版）**

| 维度 | 重写的代价 |
|---|---|
| 隐含知识 | 20+ 轮线上回归的结论活在代码与注释里（思考不顶正文、折叠保 tool_call 骨架、`fold:L` 幂等、worktree 写作用域、SSE 方言容错）。**文档没写全**，重写 = 把它们重新变成未知 |
| 跨语言面 | Rust 重写后 Node 侧 16.6 万行不变，双写面**不变**；真正的收益（R1–R4）在重写里也照样要做 |
| 时间 | 26.7k 行按"重写 + 回归"估 ≥ 6–8 周，期间功能冻结；而 P0–P2（前 2 周内）就能把 19 条 A 级全部止血 |
| 风险回收 | 239 个测试只覆盖约 1/3 行；没有 §6 的闸门，重写后无法判断"哪个行为变了" |

**若仍要做，前置条件（缺一不可）**

1. §6 三条闸门先落地 —— 否则重写没有对照系。
2. 把 core 拆成 workspace 多 crate，**先拆边界再重写实现**：`dieyun-store`（sqlite + schema 迁移）、`dieyun-index`、`dieyun-graph`、`dieyun-agent`、`dieyun-rpc`、`dieyun-core`（bin）。crate 边界 = 编译期护栏，比任何规范都硬。
3. 重写范围**只限两处**：①`index` + `graph` 的抽取/建库层（重复实现最多、测试最薄）；②`rpc` 分派层（R1 的正面实现）。**不重写** `sqlite.rs` / `compaction/fold.rs` / `agent/llm.rs` 的传输层 —— 这三处已经收敛成单一来源，重写只会丢经验。
4. 分批上线，每批「新路径 + 旧路径」双跑一个版本周期，用同一份 fixture 比对输出。

**顺序**：`P0 → P1 → 拆 crate → 重写 index/graph 抽取层 → 重写 rpc 分发`。注意这条路的第 1、2 步与 §5 的 P0–P2 **完全重合** —— 也就是说"重写"不是另一条路，而是 P0–P2 之后的一个可选项。

---

## 8. 度量：怎么算「重构完了」

| 指标 | 现在 | 目标 | 判据 |
|---|---|---|---|
| A 级缺陷 | **19 → 0**（P0 修 11 条、P1 修 1 条、P2 修 2 条、收尾批修 5 条） | 0 | §2.1 每条都有测试且绿 |

### 类型债（独立于 P0–P6）· **已清零 2026-11-18**

**根因**：`// @ts-check` 写在 `use strict` 声明**之后**会被 TypeScript 直接忽略 —— 仓里 **30 个**文件全是这个写法，于是 `npm run check:js` 这些年只覆盖 4 个手工列进 `tsconfig.check.json` 的文件（那 4 个的 pragma 也在这处错位）。闸门一直在，但一直在空转。

**结果（数字都是实测）**：

- pragma 全部挪到第 1 行后，真正的类型错是 **108 处**（当初估的是 19 处，差一个数量级），分布在 30 个文件里；**108 处全部修完**。
- `npm run check:js` 现在覆盖 **31 个文件**（30 个源文件 + `types/core-rpc.d.ts`）、**0 错误**。
- 修法三类（**没有一处用 `any` 或 `@ts-ignore` 掩盖**）：
  1. **形状过期**（绝大多数）：JSDoc 形状没跟上代码真实读写的字段 —— 补 `remote` / `roomId` / `peerRole` / `getRole` / `isBusy` / `outcome` / `aborted` / `mutatingToolCalls` / `planId` 之类；`{object}` + 分散标签的写法收成一处内联形状。
  2. **真死代码**：`agent-system-prompt.js` 里 `const pack = loadPackSystemPrompt()` 把 `packSystemPrompt()` 当无参函数**调用**了（拿到的是对象），于是 `typeof pack === "function"` 恒假、那条分支从来没走过 —— 已删。
  3. **判别式联合不收窄**：本仓 `tsconfig.check.json` 没开 `strictNullChecks`，`ok: true` / `ok: false` 这类字面量判别式不参与收窄，凡是「先 return 再读另一支字段」的写法都会报「字段不存在」。改法是局部显式声明扁平形状（`tool-gate.js` / `mcp-plans-boot.js` / `sandbox-approvals.js`），**判定逻辑不变**。

**不变式（以后核对用）**：`pragma 在第 1 行` ⇔ `在 tsconfig.check.json 里` ⇒ `check:js` 真的检查它。当前 **30 = 30，差值为 0**。

**闸门有效性**：在 `run-events.js` 与 `peer/coordinator.js` 各注入过一个假类型（`@type {{n:number}}` 套 `{n:"x"}`），两次都立刻报 TS2352；删掉即回到 0 错误。

**两条纪律（省下一次的弯路）**：① PowerShell 会吃掉 `node -e` 里的引号 / 星号 —— 一律「先写 `.cjs` 脚本再执行」，每个替换带 `if (!includes) throw`；② CRLF 会让 `\n` 字符串模式静默不匹配 —— 脚本里统一 normalize 再还原。

---

## 9. 附录

### 9.1 取证文件

| 文件 | 覆盖 | 条目 |
|---|---|---|
| [`audit/2026-11-rust-core/agent.md`](audit/2026-11-rust-core/agent.md) | driver / loop_run / llm | 11 |
| [`audit/2026-11-rust-core/memory.md`](audit/2026-11-rust-core/memory.md) | memory 全模块 | 10 |
| [`audit/2026-11-rust-core/rpc.md`](audit/2026-11-rust-core/rpc.md) | rpc 分派 / 事件 / stdio | 收尾进度页（F2 已修，F3–F9 仍开） |
| [`audit/2026-11-rust-core/index.md`](audit/2026-11-rust-core/index.md) | index / fts / codebase_db | 11 |
| [`audit/2026-11-rust-core/graph.md`](audit/2026-11-rust-core/graph.md) | graph / treesitter | 11 |
| [`audit/2026-11-rust-core/runtime.md`](audit/2026-11-rust-core/runtime.md) | compaction / embedding / config / sqlite / main | 收尾进度页（F2/F3/F11 已修，F4–F7、F10 仍开） |
| [`audit/2026-11-rust-core/planner.md`](audit/2026-11-rust-core/planner.md) | planner | 收尾进度页（F3 已修，F4–F11 仍开） |

前四份每条含：类型 / 严重度 / `文件:行` / 代码原文证据 / 触发条件 / 修法方向 / 怎么确认 / 置信度；后三份只有一页进度记录。

### 9.2 与其他文档的分工

- `docs/ARCHITECTURE-DEBT.md`：记「哪里还旧」（§1–§9）。本文不重复它的条目，只在 §2 引用结论（§2 结构化事件、§3 FTS5、§5 token 校准、§6 快照体积、§7 的 JS 侧、§8 工具定义两处注入点）。
- `docs/NODE-THINNING-PLAN.md`：记「怎么让 Node 变薄」（N1–N4）。本文 P1 直接复用它的 N1.1/N1.2/N1.3、P3 复用 N3.1/N3.2。
- `docs/AGENT-RUN-MIGRATION.md`：`agent.run.*` 契约与负向清单（**改 agent/ 前先读**）。
- `docs/SQLITE-ACCESS.md`：改任何 `sqlite.rs` 访问方式前先读（本文 P3 的「外键二选一」与 P4 的「连接面收敛」都以它为前提）。
- 本文：**Rust 侧重构的施工图**（缺陷地图 + 批次 + 闸门）。

### 9.3 维护规则

- 每批落地后回来改状态，并更新行号（行号会漂）。
- 新发现的缺陷按 §2 的格式追加（`文件:行` + 证据 + 确认方式），**没有证据的条目一律视为未核实**。
- 修完一条就把「缺陷转用例」的测试名写进对应详档 —— 没有测试的修复视为未完成。

---

## 10. 2026-11-18 复核（P0–P6 之后）+ P7 批次

> 复核口径：不信本文 §5 的自述，逐条回到代码取证；每条都带 `文件:行` 或可执行用例名，
> 拿不到证据的一律按「未修」处理（§9.3 的纪律）。

### 10.1 实测基线（复核时）

| 项 | 结果 |
|---|---|
| `cargo test -p dieyun-core --lib` | **302 passed / 0 failed**（复核起点）→ P7 后 **327** |
| `npm run verify:rpc-catalog` / `check:js` / `check:shared-constants` | 全绿 |
| `cargo clippy -p dieyun-core --no-default-features -- -D warnings` | **红灯**（clippy 1.96 下 20 条 lint：`needless_borrow` ×11、doc 注释后空行 ×6 …）→ P7 已清零 |
| Rust 规模 | 91 文件 / 31,141 行（基线 66 / 26,748） |
| `rpc/mod.rs` | 1454 → **462** 行（86/86 handler + 注册表） |

### 10.2 复核结论：P0–P6 是真的，但**仍有 10 条「现在就在错」未闭合**

按影响排序（全部已取证，详见各批次的落点表）：

1. 流式从不申请 `stream_options.include_usage`（`agent/llm.rs`）→ `agent.usage` 事件、成本统计、
   「上游吞 tool_calls」诊断、折叠的 usage 触发口径**四处连带静默失效**。
2. `tool_calls` 分片：index 无上限（一个坏帧分配十万槽）、缺 index 用数组下标兜底（串槽）、
   `name` 用 `push_str` 拼接（`fs_read_filefs_read_file`）。
3. 非法/被截断的工具入参被伪造成 `{"raw": …}` 后**照常执行**（`loop_run/mod.rs`）。
4. `fs_read_file` 按字节切 + `from_utf8_lossy` → 中文碎成 `�`；而 `handlers/fs.rs` 的注释
   声称「由它自己的测试兜住」（实际零测试）。
5. planner：`to_lowercase()` 的偏移拿去切原文（panic）、`lock().unwrap()` 毒化后永久不可用、
   撞轮次丢整批 results、worker_batch 不校验数量。
6. 溢出自愈逻辑反了：`fold_now` 返回 `Ok(None)`（没折成）也照发第二次。
7. graph 建库整轮零事务、`lsp_ingest` 先删后插无事务、抽取不判 `has_error`、
   `MAX_FILES` 在**全部文本文件**上截断后才按语言筛（文档多的仓把代码挤出调用图）。
8. `rpc/stdio.rs` / `events.rs` 写失败全 `let _ =`（宿主已死 core 还在跑完整条 run）。
9. memory 三条静默失真：`recent_messages` 同毫秒倒序、NaN 过相似度阈值、
   embedding 锁毒化被表达成「用户没配向量」。
10. Node 侧：溢出停机伪装成 `phase:'done'`（无人消费 `overflowStopped`）、
    聊天路径的 `compactMessages` 缺 `archiveFold`（折叠→归档→快照回填断成两截）。

### 10.3 P7 批次一（agent/ 契约面 + 闸门）· 已落地

| 项 | 落点 | 用例 |
|---|---|---|
| 申请 usage | `agent/llm.rs:apply_transport_fields`（请求体唯一作者；宿主显式关掉则尊重） | `streaming_request_asks_for_usage` / `transport_fields_do_not_overwrite_explicit_stream_options` |
| 工具调用分片 | `llm.rs:ToolCallSlot` + `MAX_TOOL_CALLS=64` + 按 `id`/续片关联 | `absurd_tool_index_is_reported_instead_of_allocating` / `tool_call_fragments_without_index_stay_in_one_slot` / `tool_calls_without_index_do_not_collide` / `repeated_tool_name_is_not_concatenated` |
| 非法入参不执行 | `loop_run/mod.rs:parse_tool_arguments` 返回 `Result`；整批不执行且每个 `tool_call_id` 都补 error 回执 | `invalid_tool_arguments_are_not_delegated` |
| 折叠自愈 | `agent/driver.rs`：只有 `fold_now` 真的折了东西才重发 | `overflow_without_foldable_content_does_not_retry`（原 `retries_once_after_force_folding_on_context_overflow` 实际测的是「什么都没折也重发」，已改名区分） |
| 多 choice | `llm.rs:feed_sse_data` 全部 choice 都累积 | `extra_choices_are_accumulated_not_dropped` |
| clippy 闸门回绿 | 20 条 lint（含 6 处 doc 注释后空行、11 处 `needless_borrow`）零语义修正 | `cargo clippy … -D warnings` exit 0 |

### 10.4 P7 批次二（I/O、planner、graph、memory、Node）· 已落地

| 项 | 落点 | 用例 |
|---|---|---|
| stdout / 事件写失败出声 | `rpc/stdio.rs`（`STDOUT_ALIVE` + `write_line`）、`rpc/events.rs`（`SINK_CLOSED`）、`agent/driver.rs` 每轮请求前检查 | `write_failure_is_reported_not_swallowed` / `broken_stdout_flips_the_liveness_flag` / `io_line_names_the_channel_and_the_error` |
| 分块读字符边界 | `fs_ops.rs`：`align_to_char_boundary` + `decode_utf8_block` + `nextOffset` 字段（A→Z 对齐说明见 `handlers/fs.rs` 注释） | `chunked_reads_reassemble_chinese_text_without_replacement_chars` / `offset_inside_a_character_is_aligned_to_its_start` / `non_utf8_block_still_advances` |
| planner 字节偏移 | `planner/plan_parse.rs` 删掉 `to_lowercase()`（` ``` ` 是 ASCII，不需要也不允许先小写化） | `json_fence_extraction_survives_unicode_case_folding` |
| planner 锁毒化 | `planner/run.rs:lock_runs`（`unwrap_or_else(into_inner)`，与 `sqlite.rs` 同口径） | `poisoned_lock_does_not_brick_the_planner` |
| planner 撞轮次 | `handle_worker_batch` / `handle_best_of_n_attempt`：结果收下、不再派新活、照常验收；`planner.state` 增 `hitRoundLimit` | `round_limit_batch_keeps_results_and_goes_to_review` |
| planner 结果校验 | 少回的子任务补一条 error 结果、多回的记 trace | `missing_worker_result_becomes_an_explicit_error` |
| graph 分批事务 | `graph/build.rs` 与 index 共用 `index::CHUNK_COMMIT_EVERY`；`backfill_unique_callees` 留在事务外（它自己开事务） | 既有 graph 用例全绿 |
| LSP ingest 事务 | `graph/lsp_ingest.rs`：DELETE+INSERT+`call_count` 同一事务，失败上抛（原 `.ok()`） | 既有 `ingests_lsp_callers_with_confidence_one` |
| 语法错不独占 AST | `treesitter/extract.rs`：`root_node().has_error()` → 返回 None 交启发式 | `syntax_error_files_fall_back_to_the_heuristic` |
| 截断如实上报 | `index/walker.rs` 返回 `(entries, truncated)`（`collect_text_files_where` 先筛后计数）；`index/build.rs` 不再用 `len() >= MAX_FILES` 代理；`graph.status.filesTruncated` 落库并暴露（`graph_workspaces.files_truncated`） | `exactly_the_cap_is_not_reported_as_truncated` / `code_files_survive_when_text_files_outnumber_the_cap` |
| `*.env` 不进索引 | `index/walker.rs`：新增 `SECRET_EXT`（`prod.env` 也不放行；刻意与 `IGNORE_EXT` 分开，否则会破 `ignore-rules-parity` 那条「与 Node `BINARY_EXT` 完全相等」的闸门） | `skips_hidden_entries`（已补 `prod.env` 断言） |
| 相似度阈值 NaN 安全 | `embedding::passes_min_similarity`（唯一判定，`is_finite() && > MIN`），索引池与长记忆召回共用 | `nan_never_passes_the_similarity_floor` |
| recent_messages 同毫秒 | `memory/session.rs`：`ORDER BY created_at DESC, id DESC` | `recent_messages_break_created_at_ties_by_id` |
| 锁毒化不清空向量配置 | `memory/store.rs`：`set_embedding` / `embedding()` 都用 `into_inner()` | 既有 configure 用例 |
| 吞错出声 | `obs::degraded`（`[rpc-degraded]`）：修剪线程、scope rekey | `degraded_line_names_area_and_message` |
| 溢出停机不再冒充成功 | `rust-loop-runner.js`：`stopReason:'context_overflow'` + `stopNote`；`main-turn-runner.js` 留痕并把它放进轮次结果 | 既有 `test:rust-loop-runner` / `test:agent` |
| 聊天路径补归档 | `main/ipc/agent-runtime.js` 改用 `compaction-loop.buildLoopCompactionHandler`（含 `archiveFold`） | `npm test`（request-snapshot / agent 相关项） |

**验收**：`cargo test --lib` 302 → **327 全绿**、`cargo clippy … -D warnings` **0 错误**、
`verify:rpc-catalog` / `check:js` / `check:shared-constants` / `npm test` 通过。

### 10.5 文档债纠正（复核时发现的三处「说法与代码不符」）

1. **`EMBEDDING_TIMEOUT_CODE` 没有消费方**：§2.2 写「调用方据此区分『端点没回』与『端点报错』」，
   实际全仓没有任何 code 判断（Node 侧只有 `EMBEDDING_DISABLED`）。要么删常量，要么给它真消费方。
2. **`.env` 白名单并未删除**：§5 P6 声称已删，实际 `index/walker.rs` 的扩展名白名单里还在，
   而白名单会放行 `prod.env`。P7 已真正挡掉（见 10.4）。
3. **`handlers/fs.rs` 的「由它自己的测试兜住」是假承诺**：`fs_ops.rs` 当时 110 行零测试。
   P7 补了三条用例，注释改成指向具体用例名。

### 10.6 「可以重构了吗」：本轮的判定

**可以，但「重构」= 拆 crate + 三处边界重排，不是推倒重写。** 判据：

- **不重写整体**：Node 16.6 万行不动、双写面不变、隐含约束（`stream:false` 丢 tool_calls、`fold:L` 幂等、
  末 3 原子保锚点、思考不顶正文）没有一篇文档写全 → 重写等于把它们变回未知。
- **必须做边界**：`index/mod.rs` 1093 → **1286（回涨）**、`memory/mod.rs` 1786 行里 **1628 行是测试**、
  `planner/run.rs` 1488 行从未拆、出站请求体至今**两个作者**（`loop_run/ledger.rs:493` + `llm.rs:329`，
  `stream_options` 无处安放正是这条分叉的直接后果）。
- **顺序**：P7（已落地）→ 拆 crate（`dieyun-store` / `index` / `graph` / `agent` / `rpc` / bin，编译期护栏）
  → R2 出站投影（请求体唯一作者）→ 局部重写 index/graph 抽取层。

### 10.7 P8 · 向量与 embedding 面（§10.6 的前四条）· 已落地

| 项 | 落点 | 用例 |
|---|---|---|
| 向量落库分批提交 | `index/vectors.rs` 新增 `batched_write`（批大小共用 `index::CHUNK_COMMIT_EVERY`）；`apply_cached_vectors` / `store_embedded_vectors` 两条路径都改 | `batched_write_commits_across_batches`（跨两批 + 零头，断言全部落库） |
| `results: []` 与字段缺失同罪 | `rpc/handlers/async_core.rs`：空数组直接 `INVALID_PARAMS` | `agent_run_tools_rejects_empty_results` |
| 查询用短超时 | `embedding/remote.rs` 新增 `EMBED_QUERY_TIMEOUT_MS=10s`（批量仍是 120s）；唯一入口 `embedding::embed_query`（召回与 `embedding.query` 共用） | `query_timeout_is_much_shorter_than_batch_timeout` |
| 写路径失败降级 | `memory/longmem.rs`：写入即索引 / 近重复前的 embedding 失败 → `[rpc-degraded]` 并**照常写记忆**（没有向量只影响召回通道） | 既有 long-memory 用例 |
| `EMBEDDING_TIMEOUT_CODE` 有消费方 | `embed_query` 是唯一消化点（记超时值 + 语义通道跳过说明）；`CoreError::code()` 新增，判定靠码不靠文案 | `count_mismatch_is_rejected`（用到 `err.code()`） |
| 回包 index 兜底 | `parse_embedding_vectors(json, expected)`：缺 `index` 用**行位置**（不是「已解析条数」），条数校验收到唯一解析点；`embed_batch` 的重复检查删掉 | `out_of_order_index_is_sorted_back` / `rows_without_index_are_not_dropped` / `count_mismatch_is_rejected` |

**验收**：`cargo test --lib` 327 → **333 全绿**、`cargo clippy … -D warnings` 0 错误。

### 10.8 仍未闭合（下一批）

| # | 缺陷 | 位置 | 为什么还没做 |
|---|---|---|---|
| 1 | 子串通道把「路径命中」算进 `hits`，`hits == 词元数` 判全覆盖 → 强证据静默丢 / 文件名顶第一 | `index/search.rs` | 要拆 `hits` 与 `content_hits` 两个表达式并补两条用例 |
| 2 | 召回分数量纲跨分支不同，Node 用单一绝对阈值 0.12 | `memory/recall.rs` + `system-prompt-prep.js` | 要把「注入判定」收回分数产生方（`injectScore`），属跨语言契约改动 |
| 3 | ✅ 已落地：`agent.run.tools` 的条数与归属必须和账本一致 | `loop_run/ledger.rs:pending_delegate_ids` + `handlers/async_core.rs`：缺/多/空一律在入口拒绝，拒绝不动账本 | 用例 `agent_run_tools_requires_one_result_per_delegate` |
| 5 | 子串通道把「路径命中」算进 `hits`，`hits == 词元数` 判全覆盖 → 强证据静默丢 / 文件名顶第一 | `index/search.rs` | 要拆 `hits` 与 `content_hits` 两个表达式并补两条用例 |
| 6 | 召回分数量纲跨分支不同，Node 用单一绝对阈值 0.12 | `memory/recall.rs` + `system-prompt-prep.js` | 要把「注入判定」收回分数产生方（`injectScore`），属跨语言契约改动 |
| 7 | ~~巨石回涨 / 测试与实现同居 / 两套抽取器 / R2 / 拆 crate~~ | — | **已完成**：§11 拆 crate、§12 R2、§13 抽取层、§14.1 测试分离；`planner/run.rs` 也已拆三刀（`trace` / `best_of_n` / `workers`，1229 → 560 行） |

---

## 11. 拆 crate（2026-11-18 落地）

### 11.1 边界怎么定的：先量，再拆

动手前跑了一遍「模块 → `crate::X` 依赖」，结论是**照原计划拆成 6 个 crate 会撞强连通块**：

| 环 | 成员 | 后果 |
|---|---|---|
| 索引族 | `index ↔ graph ↔ codebase_db ↔ treesitter` | `index` 用 `graph` 的 LSP 摄取，`graph` 用 `index` 的文件收集，`codebase_db` 两边都要 —— 拆开必须先改实现 |
| 配置/向量 | `config ↔ embedding` | `AppConfig` 持 `EmbeddingConfig`；`embedding` 用 `config::apply_llm_headers` |
| 循环/RPC | `agent ↔ rpc` | `AppState` 持 `Arc<AgentLoopManager>`；`agent` 反过来调 `rpc::events` / `rpc::calls`（反向调用通道） |

所以最终是 **5 个 crate**，每个环整体落在一个 crate 里，用「只暴露必要 API」当护栏（而不是先花几天拆环）：

```
dieyun-core        bin + lib.rs（把老路径 pub use 出来，上一层的 crate::… 引用一行未改）
  └ dieyun-runtime    agent / planner / rpc / fs_ops
      ├ dieyun-memory     memory
      ├ dieyun-codebase   index / graph / treesitter / codebase_db
      └ dieyun-base       error / shared / obs / blocking / sqlite / db_schema / config / embedding / compaction / fts
```

数一下：（91 文件 / 31k 行的 Rust）现在是 **5 个编译单元**，依赖方向由 Cargo 强制 ——
`dieyun-base` 不可能反向依赖 `dieyun-runtime`，这不是靠约定，是编译错误。

### 11.2 迁移做法（纯移动，零行为改动）

1. `git mv` 搬文件 —— 模块形状不变（`memory/mod.rs` 仍是 `memory`，`index/build.rs` 仍是 `index::build`），
   所以**同 crate 内的 `crate::` 引用不用动**。
2. 只有跨 crate 的引用要改：搬出来的模块里的 `crate::config::` / `crate::error::` 之类改成
   `dieyun_base::config::` / `dieyun_base::error::`（脚本化的机械替换，一次跑完再 `cargo check` 收敛）。
3. `dieyun-core/src/lib.rs` 变成**路径转发 shim**：`pub use dieyun_base::{config, error, …};`
   —— 于是 `crate::error::CoreError` 这种上千处引用保持不变，`main.rs` 也不用改。
4. `pub(crate)` 在跨 crate 之后等于「本 crate 私有」，被上层用到的一律放宽成 `pub`
   （只放宽可见性，签名与实现不动）。

### 11.3 顺手修掉的两处层次违规

| 问题 | 修法 |
|---|---|
| `obs::fold_fact(run_id, &agent::FoldFact)` —— 观测层反向依赖 agent | 参数改成基本类型（观测层不认识 agent 的类型） |
| `db_schema::column_names` 带 `#[cfg(test)]` 却要被 memory / graph 的用例用 | 去掉 `cfg(test)`（它本来就是「测试与诊断用」的公开工具） |

### 11.4 命令与闸门的变化

| 项 | 之前 | 现在 |
|---|---|---|
| Rust 单测 | `cargo test -p dieyun-core --lib`（334 条） | `cargo test --workspace --lib`（**77 + 113 + 57 + 87 = 334**，数字与拆分前一致） |
| clippy | `-p dieyun-core` | `--workspace --no-default-features -- -D warnings` |
| 契约闸门 | `check-shared-constants` 只扫一个 `src/` | 扫 `crates/*/src`（读者散在 4 个 crate，只扫一个会把「别人读了」误判成「没人读」） |
| RPC catalog | 扫 `crates/dieyun-core/src/rpc` | 扫 `crates/dieyun-runtime/src/rpc`（标签随之变成 `dieyun-runtime/...`） |

> ⚠️ **`cargo test -p dieyun-core --lib` 现在会跑 0 个用例** —— 这条命令骗过人不奇怪，
> 所以 CI、`package.json`、`AGENTS.md` 都一起改了。新增 Rust 单测时放哪个 crate，就 `-p` 哪个，
> 或直接用 `--workspace`。

### 11.5 这一步**没有**解决什么

拆 crate 只是把「谁能依赖谁」变成编译期事实，它**不**消除重复实现：

- 出站请求体仍是两个作者（`loop_run/ledger.rs` + `agent/llm.rs`）—— R2 出站投影还没做；
- `index` 与 `graph` 各有一份抽取器（AST vs 启发式），靠一条用例手工对齐；
- `memory` 里的测试仍与实现同居（`memory/mod.rs` 1600+ 行是 `mod tests`）；
- §10.8 的两条跨语言契约债（子串 `hits`、召回分数量纲）原样。

下一批的顺序：**R2 出站投影** → 抽取层二选一 → 测试与实现分离。

---

## 12. R2 · 出站投影（2026-11-18 落地）

### 12.1 之前是「两个作者」

| 谁写 | 写了什么 |
|---|---|
| `loop_run/ledger.rs::need_llm` | `{model, messages, tools}` |
| `agent/llm.rs::chat_completion` | `stream`（+ `stream_options`，2026-11-18 才补） |
| Node `round.prepare` → `reasoning-backfill.js` | 把账本 `reasoning` 抬成 `reasoning_content` / 补占位 / 剥账本字段 |

于是 `stream_options.include_usage` 漏了三个月没人发现（三处消费方全都「没数据就静默跳过」），
而「思考回传」这件事**只有宿主知道**，内核并不知道能力表怎么声明。

### 12.2 现在：`agent/outbound.rs` 是唯一作者

```
账本事实（messages / tools / 模型） ──► outbound::project_body(.., OutboundSpec)
                                          │  ① 剥账本内部字段 synthetic / reasoning
                                          │  ② reasoning_content：已有真值保留；
                                          │     需要回传（带 tools / 有 tool_calls / echoReasoning）
                                          │     就抬账本真思考，缺了补统一占位串
                                          │  ③ stream + stream_options.include_usage
                                          │  ④ 空 tools 数组整键删掉（兼容网关会 400）
                                          ▼
                                        HTTP（llm.rs 只管发、收、解析）
```

**调用点只有一个**：`driver::drive`，位置在宿主 `round.prepare` **交回请求副本之后** ——
投影必须在宿主做完视觉注入 / 附件补图 / 裁剪之后执行，否则思考会被宿主那一份覆盖；
放在之前就等于让「思考回传」重新有两个作者。

`llm.rs::chat_completion` 不再自己拼传输字段，只调 `outbound::apply_transport`（补缺，幂等），
服务宿主自建 body 的 `llm.complete` 路径。

### 12.3 能力表怎么过界的

`echoReasoning` 由宿主在 `transport()` 里随每一轮 `agent.run.*` 的 params 传，
`rpc::drive_spec` 读成 `DriveSpec.echo_reasoning`，投影据此决定要不要补 `reasoning_content`。
内核**不认识** `getChannelPolicy`，只知道「宿主声明了这个模型要不要回传」。

### 12.4 Node 侧删掉了什么

`rust-loop-runner.js` 的 `round.prepare` 不再调 `backfillReasoningContent`
（只留视觉注入 + 字符上限 + 图片 sanitize，这些是**请求级策略**，不是出站形状）。
`reasoning-backfill.js` 仍然存在，但只剩 **Renderer 辅助单轮**（它自己拼 `llm.complete` 的
body，不走这条投影）一个消费方 —— 文件头注释已按现状改。

### 12.5 用例

| 用例 | 钉住什么 |
|---|---|
| `synthetic_marker_never_reaches_upstream` | 平台补的正文标记只活在账本里 |
| `book_reasoning_is_promoted_and_stripped` | 账本 `reasoning` 抬成 `reasoning_content`，且自身不许上行 |
| `missing_reasoning_gets_the_placeholder` | 占位串来自 `agent-shared.json`（Node / Rust 同一份），且 **trim 后仍非空**（零宽空格；人话占位会被上游回显成真思考） |
| `no_tools_no_echo_keeps_the_message_clean` | 不需要回传时**不编**字段 |
| `echo_reasoning_forces_the_field` | 能力表声明脱工具也要回传 |
| `empty_tools_array_is_dropped` | 空 `tools` 整键删掉 |
| `transport_fields_ask_for_usage` | 流式申请 usage / 非流式不申请 / 宿主显式关掉就尊重 |
| `outbound_body_is_projected_once_by_core`（driver 端到端，抓真实请求体） | 上面四条在**真正发出去的 HTTP body** 里同时成立 |

**验收**：`cargo test --workspace --lib` 334 → **343 全绿**；clippy / `check:js` / `npm test` 通过。

---

## 13. 抽取层二选一（2026-11-18 落地）

### 13.1 之前：同一份知识两份实现

| 实现 | 位置 | 产出 | 何时运行 |
|---|---|---|---|
| tree-sitter AST | `treesitter/extract.rs`（481 行 + 4 语言 walker） | imports / symbols / calls | 首选 |
| 启发式正则扫描 | `graph/extract/{js_ts,python,go,rust_lang,symbols,heuristic}.rs`（**1330 行**） | imports / symbols / calls | 只在 AST 返回 `None` 时（语法错 / 未知语言） |

两者覆盖**同一批四种语言**、产出**同样三样东西**，靠一条 parity 用例
（`ast_minus_heuristic_is_only_the_deliberate_skip_list`）手工对齐 —— 这正是
AGENTS.md 原则 2 说的「同一份知识有第二份实现」，而且它只在**坏文件**上运行：
正则猜出来的边既会漏（把「没解析出来」伪装成「没人调用」）也会错。

### 13.2 现在：只留 tree-sitter

| 动作 | 结果 |
|---|---|
| 删掉 `graph/extract/{js_ts,python,go,rust_lang}.rs` 里的 `extract_import_specs` / `extract_symbols` / `extract_calls` / `strip_comment` / `CALL_SKIP` / `parse_*` 正则扫描 | −900 行量级 |
| 删掉 `graph/extract/heuristic.rs`（249 行）与 `symbols.rs`（145 行） | 两套扫描原语一起消失 |
| `is_ident`（唯一的合法用户是 AST 侧）搬进 `treesitter/extract.rs` | 单一来源，不再跨模块借 |
| `graph/build.rs::index_file` 改吃 `&AstGraphExtract`，三条 `if let Some(ast) {...} else if is_xx_path ...` 分支整段删除 | 分支从 3×4 条降到 0 |
| parity 用例随被删实现一起消失 | 不再需要「两套实现对齐」这条约束 |

**行为变化（有意）**：语法有错 / 非四种语言的文件**这一轮不贡献任何边，且不记 mtime** ——
下次保存会重新尝试。由 `unparsable_file_is_skipped_and_retried_after_fixing` 钉住
（坏 → 不建边 → 修好 → 增量自动补回）。

### 13.3 数字

| 项 | 之前 | 现在 |
|---|---|---|
| `graph/extract/` 目录 | 8 文件 / **1587 行** | 6 文件 / **415 行** |
| 抽取实现数量 | 2（AST + 启发式） | **1**（AST） |
| `cargo test --workspace --lib` | 343 | **332**（删掉 12 条测启发式的用例，新增 1 条跳过/重试用例） |

### 13.4 没解决什么

- `graph` 与 `index` 仍然共用 `codebase_db`（同一个库，见 §11.1 的强连通块）；
- `index` 侧的切块（`treesitter/chunk.rs`）与图抽取各走各的 AST walk —— 它们产出不同
  （chunk 区间 vs import/call/symbol），目前没有合并的理由；
- §10.8 的两条跨语言契约债照旧。

---

## 14. §10.8 收尾三件（2026-11-18 落地）

### 14.1 测试与实现分离

把每个「实现文件里塞几百上千行 `mod tests`」拆成同级独立文件
（`#[cfg(test)] #[path = "tests.rs"] mod tests;`，模块身份与 `use super::*` 语义都不变）：

| 文件 | 原 | 现在（实现 + 测试） |
|---|---|---|
| `memory/mod.rs` | 1701 | **132 + 1569** |
| `planner/run.rs` | 1653 | 1229 + 425 |
| `agent/loop_run/mod.rs` | 1201 | **300 + 903** |
| `index/mod.rs` | 1195 | **449 + 748** |
| `agent/llm.rs` | 936 | 544 + 435 |
| `index/search.rs` | 933 | 521 + 487 |
| `agent/driver.rs` | 888 | **253 + 636** |
| `sqlite.rs` | 888 | **311 + 473** |
| `graph/mod.rs` | 864 | **298 + 567** |
| `memory/misc.rs` | 655 | 464 + 194 |
| `compaction/fold.rs` | 594 | 341 + 255 |
| `rpc/mod.rs` / `memory/schema.rs` | 580 / 580 | 297 + 219 / 449 + 134 |

判据只有一条：**测试数量与结论不变**（拆完 `cargo test --workspace --lib` 全绿，条数一致）。
收益是「改一个方法不用在整片用例之间翻」，diff 也可读了。

### 14.2 子串通道的「强证据」判据

`index/search.rs` 原来只有一个 `hits`：`content LIKE` 与 `rel_path LIKE` 各算一分。
于是 `hits == 词元数` 这个「覆盖度 100%」判据两头都错：

| 情形 | 旧行为 | 现在 |
|---|---|---|
| 正文全覆盖 + 路径也命中 | `hits = 2n ≠ n` → **强证据被静默丢弃** | 用 `content_hits`（只数正文）= n → 强证据成立 |
| 只有**文件名**命中（正文一个都没有） | `hits = n` → 被当成「全覆盖强证据」顶到第一 | `content_hits = 0` → 不是证据 |
| 排序 | `hits`（含路径） | 不变（路径相关确实更可能是要找的） |

用例：`path_only_match_is_not_strong_evidence` / `content_full_coverage_counts_even_when_path_also_matches`。

### 14.3 召回分数量纲：注入判定收回 Rust

之前宿主拿两个**不同量纲**的绝对阈值卡召回结果：语义 0.32（余弦）／关键词 0.12（bm25 派生的
`-rank + importance*0.035 + freshness*0.08`）。bm25 的量纲随语料与查询词长度漂移 ——
「注不注入」实际上取决于查询词有几个字。

现在每条命中带 **`injectScore ∈ [0,1]`**，由产生它的分支归一（唯一来源）：

| 分支 | 归一方式 | 理由 |
|---|---|---|
| 语义 | `cosine.clamp(0,1)` | 余弦本身就是绝对的、跨查询可比 |
| 关键词 / LIKE | `score / 本次查询的最佳 score` | bm25 只能在同一查询内比较 |
| 最近记忆（无查询） | 恒 `1.0` | 「按时间取最近」本身就是这次的决定，没有证据强弱 |

宿主侧只剩一个阈值 `agent-limits.memoryInjectMinScore`（0.32），并且：
- 只读 `injectScore`，**不再看 `score`**（`score` 降级为分支内排序量纲，注释已写明）；
- 缺字段（老 core / 测试桩）时不丢（`Number.isFinite` 判不了就放行），避免版本混跑时整块记忆被静默清空。

用例：`keyword_inject_score_is_relative_to_the_best_hit` / `cosine_inject_score_clamps_and_rejects_nan`，
宿主侧 `test:system-prompt-prep` 的桩已按新契约给 `injectScore`。

### 14.4 验收

`cargo test --workspace --lib` **337 全绿**（78 base / 104 codebase / 59 memory / 96 runtime）·
`cargo clippy --workspace --no-default-features -- -D warnings` 0 错误 ·
`npm test` / `check:js` / `lint:agent` / `verify:rpc-catalog` / `check:shared-constants` / `check:contracts` 通过。

### 14.5 没解决什么

- **共享记忆**（`src/memory-shared/`）仍有两个「语义 / 关键词」阈值（`sharedMemoryMinScore*`），
  量纲问题与这里同形 —— 但它走的是 PostgreSQL 上的另一条召回 SQL，得先看那边的打分再动；
- `injectScore` 是「分支内相对强度」，跨分支的**绝对**可比（例如「语义 0.5 与关键词 0.9 谁更可信」）
  仍然没有统一口径 —— 统一它需要一份标定数据，不是纯代码问题。

---

## 15. CI 缺一套 feature（2026-11-19 复核 · 已修）

### 15.1 缺陷：CI 的 Rust 测试步骤从 2026-11-18 起编译不过

| 项 | 内容 |
|---|---|
| 现象 | `cargo test --workspace --no-default-features`（`ci.yml` 的 Rust 测试步骤）→ `error: could not compile 'dieyun-base' (lib test) due to 6 previous errors`：`E0425 cannot find type 'OnceLock'` ×2、`E0425 cannot find function 'ensure_runtime_cached'` ×4 |
| 位置 | `crates/dieyun-base/src/embedding/local.rs` 的 `mod tests`：用例 `runtime_failure_is_not_cached_but_success_is` 引用了只在 `feature = "local-embed"` 下存在的测试缝（`imp::ensure_runtime_cached` + `std::sync::OnceLock`） |
| 引入 | `5048f36`（P0 止血 · A12 的验收用例，2026-11-18） |
| **为什么没人发现** | **两侧闸门用的 feature 集合从未碰面**：CI 只跑 `--no-default-features`，文档 / 本地只跑默认特性（`cargo test --workspace --lib`）。而且 CI 的 clippy **不带 `--all-targets`** —— 测试目标根本不参与检查。反向也行得通：`local-embed` 的**生产代码**（`ort` 那条链）从没在 CI 里被 type-check 过 |

这不是「一行写错」，是**闸门定义不完整**：把 feature 组合当成实现细节，于是「两套 feature 各自的测试代码」成了没人编译的第三片区域。

### 15.2 修法（只补闸门与 lint，零语义改动）

1. **`local.rs`**：那条用例加 `#[cfg(feature = "local-embed")]`（测试缝本身只在有 feature 时存在）。同模块另外 4 条**两套都跑** —— `compiled_flag_matches_feature` / `probe_without_model_dir_explains_why` 正好钉住「没有 feature 时也必须说人话」，所以不是整块 `mod tests` 挂 cfg。
2. **`ci.yml`**：Rust 步骤 2 条 → **4 条**（`test` ×2 + `clippy --all-targets` ×2），`timeout-minutes` 45 → 60（默认特性那套要编 `ort` / `tokenizers`）。
3. **清掉 `--all-targets` 下暴露的 16 条测试侧 lint**（此前没人看见）：

| 位置 | lint | 改法 |
|---|---|---|
| `embedding/local.rs:603` | `cloned_ref_to_slice_refs` | `&[query.clone()]` → `std::slice::from_ref(&query)` |
| `embedding/remote.rs:268,269` | `assertions_on_constants` ×2 | 改**编译期断言** `const _: () = assert!(..)`（改坏常量现在编不过） |
| `obs.rs:261` | `unit_arg` | `assert!(usage(..).eq(&()))` → 直接调用（形状已由上一行钉住） |
| `memory/tests.rs:538` | `len_zero`（`>= 1`） | `!…is_empty()` |
| `index/search_tests.rs:480` | `unnecessary_to` | `&vec.to_vec()` → `vec.as_slice()` |
| `index/tests.rs` ×7（63/307/315/325/435/507/569） | `field_reassign_with_default` | `EmbeddingConfig::default()` + 逐字段赋值 → 结构体字面量 + `..Default::default()` |
| `rpc/registry.rs:266` | `assertions_on_constants` | 改编译期断言（同 §2） |
| `rpc/stdio.rs:264` | `err().expect()` | → `expect_err(..)` |
| `rpc/tests.rs:137` | `len_zero`（`> 0`） | `!…is_empty()` |

> 顺带修掉一处会误导人的文档：§6 的「统一验收」块还写着 `cargo test -p dieyun-core --lib`（拆 crate 之后这条**只跑 0 个用例**，§11.4 早就警告过）。已改成两套 feature 的 `--workspace` 命令，并把四条命令与 CI 对齐。

### 15.3 验收（实测）

| 命令 | 结果 |
|---|---|
| `cargo test --workspace --lib`（默认特性） | **339 通过 / 0 失败** |
| `cargo test --workspace --lib --no-default-features` | **338 通过 / 0 失败**（少的那一条正是需要 `local-embed` 的用例） |
| `cargo clippy --workspace --all-targets -- -D warnings` | 0 错误 |
| `cargo clippy --workspace --no-default-features --all-targets -- -D warnings` | 0 错误 |
| `npm run verify:rpc-catalog` / `verify:core-contracts` / `check:shared-constants` | 全 OK |

### 15.4 纪律（下一轮别复发）

**「这个配置 CI 跑不跑」要和「这个代码编不编」一一对上**：本仓的两套 feature 是**两个真实产品形态**（桌面 sidecar 带本地推理 / 远端 Linux 包不带 ORT），不是可选优化 —— 任何一侧的测试代码、lint、type-check 都得两侧各跑一次。同理，`cargo clippy` 不带 `--all-targets` 等于「只检查生产代码」，加测试用例时不会有人替你发现它编不过。

---

## 16. 2026-11-19 收尾：四处减法（工作区键 / 死字段 / 死返回值 / 化石变量）

### 16.1 做了什么

| # | 项 | 之前 | 现在 |
|---|---|---|---|
| 1 | **工作区键派生** | 同一规则两份实现：`dieyun-base/src/config.rs` 的 `hex16` + `hash_workspace_root`，与 `dieyun-codebase/src/index/workspace.rs` 的 `hex16` + `hash_workspace_key_str`（都是 `sha256(输入)` 取前 8 字节 → 16 hex） | 唯一来源 `dieyun_base::config::workspace_key_hash(&str)`；`hash_workspace_root(&Path)` 只是它的薄包装；远端键（`ssh://…`）直接调它。**失败形状**：一边改了截断长度或加 salt，索引键与记忆键就静默错位（查不到东西、不报错） |
| 2 | **`RunState.workspace_root`** | 只在 `ledger.rs` 写入一次、没有任何读取点，靠 `#[allow(dead_code)]` 压住 | 删字段与赋值。`StartParams.workspace_root` **保留**（宿主真在发，是 `@contract` 字段）并在字段上写明「循环不读它」—— 否则下一个人会以为内核按它切工作区 |
| 3 | **`graph::BuildStats`** | 建库结束返回一份 `{file_count, edge_count, symbol_count, call_count}`，两个调用点都 `.map(|_| ())` 直接丢掉；靠 `#[allow(dead_code)]` 压住 | 删结构体；`run_build_with_progress` 返回 `Result<(), CoreError>`。计数本来就在同一次 `UPDATE graph_workspaces` 里落库，库是唯一读侧 |
| 4 | **`index/build.rs` 的 `let _ = workspace_key;`** | 第 49 行声明、第 138 行只为消 unused 警告而「用」一次 | 连变量带这行一起删 |

### 16.2 一处更正（诚实账）

上一轮复核说「4 个 `#[allow(dead_code)]` 里 3 个是失效残留」—— 逐条核对后**只有 1 个**是残留（`RunState.workspace_root`）。另外两个是**故意**的编译期断言守卫，不该删：

| 位置 | 它是干什么的 |
|---|---|
| `rpc/mod.rs:27 _assert_app_state_is_send_sync` | `AppState` 必须 `Send + Sync`，否则 RPC 无法多线程 spawn（裸 `Connection` 混进来时立刻编不过） |
| `rpc/mod.rs:83 _assert_snapshot_is_send_static` | `ServiceSnapshot` 必须能整体移进阻塞池 |

「函数只为类型检查而存在」时带 `#[allow(dead_code)]` 是正确写法；删掉它们等于拆掉一条编译期护栏。所以本批**只清 1 个 allow**，另外 2 个保留并在 §15.4 之后的新纪律里写明判据：**「没有调用点」不等于「没有作用」**。

### 16.3 验收与契约影响

| 项 | 结果 |
|---|---|
| `cargo test --workspace --lib` / `--no-default-features` | 339 / 338 全绿（条数不变，行为零改动） |
| `cargo clippy --workspace [--no-default-features] --all-targets -- -D warnings` | 两套 0 错误 |
| `types/core-contracts.d.ts` | 只多 1 行字段文档（`StartParams.workspaceRoot` 的说明），`verify:core-contracts` / `check:js` 通过 |
| `verify:rpc-catalog` / `check:shared-constants` / `check:contracts` | 全 OK |
| 残留 | `fn hex16` 只剩 base 一处；`#[allow(dead_code)]` 2 处（都是故意断言）；`>100 行`生产函数仍 **18 个** —— 那是下一批（拆 `run_index` / `continue_llm` / `status_with_conn`）的事 |

---

## 17. 2026-11-19 第二批：三个巨型函数拆开（纯移动）

### 17.1 拆法

没有引入任何新机制、没有改一个判断：每个函数按**它本来就在做的阶段**切开，切出来的都是同文件内的
私有方法或模块级纯函数，签名带注释写明「为什么是这个边界」。

| 函数 | 之前 | 现在 | 切出来的阶段 |
|---|---|---|---|
| `index::build::run_index` | **356** | **88** | `mark_indexing`(登记在跑) → `collect_scope`(扫文件+增量基线 30) → `vector_plan`(向量口径 30) → `chunk_pass`(逐文件切块 141) → `prepare_embed`(缓存命中+待办 78) / `store_embed`(落库 19) → `write_meta`(元数据+重建池 50) |
| `loop_run::ledger::continue_llm` | **264** | **111** | `stop_at_round_limit`(出口一 37) / `stop_at_tool_limit`(出口二 29)、`RoundText::of`(正文/思考/可见性口径)、`assistant_tool_call_message`(24)、`absorb_tool_batch`(整批入参校验+回执 50)、`truncated_tool_results`(12)、`delegates_from_pending`(11) |
| `index::status::status_with_conn` | **205** | **64** | `load_status_row`(读一行)、`empty_status`(没建过索引 30)、`reconcile_counts`(只读核对+维修建议 126) |

顺带消掉一处重复表达式：`chunk_pass` 里「首个 / 每 8 个 / 最后一个才报进度」的条件原本**写了两遍**，
现在只有 `progress_due(done, total)` 一处。

### 17.2 拆的过程中撞到的一个真陷阱（值得记住）

`run_index` 原来是**一个** async fn：`conn`（拥有的 `Connection`）跨 await 没问题，因为 `Connection: Send`。
把它按阶段拆开时，我把「算缓存命中 + 真调端点」整体挪进了一个 `async fn embed_missing(conn: &Connection, ..)`，
于是 `&Connection` 活过了 await 点 —— `Connection` 不是 `Sync`，`&Connection` 不是 `Send`，整条 future 变成
`!Send`，`index_workspace` 的调用方在 tokio 上直接编不过：

```
error: future cannot be sent between threads safely
note: required because it's used within this async fn body  --> index/build.rs:248 (index_workspace)
```

修法不是加 `Box::pin` 或 `spawn_blocking`，而是**把 async 边界挪到正确的位置**：
`prepare_embed`（同步，算该算哪些）→ `run_index` 里那一处 `.await`（只借 `&self.embedding` 与已算好的文本）→
`store_embed`（同步，落库）。**判据**：任何拿 `&Connection` / `MutexGuard` 的函数都不许是 async。

### 17.3 验收

| 项 | 结果 |
|---|---|
| `cargo test --workspace --lib` / `--no-default-features` | **339 / 338 全绿**（条数一条没变 = 行为零改动；含 96 条 ledger / 104 条 index 用例） |
| `cargo clippy --workspace [--no-default-features] --all-targets -- -D warnings` | 两套 0 错误 |
| `verify:rpc-catalog` / `verify:core-contracts` / `check:shared-constants` / `check:contracts` | 全 OK（没有 `@contract` 类型变化） |

### 17.4 诚实结论：`>100 行` 的个数没降（18 → 18），但形状变了

| 区间 | 之前 | 现在 |
|---|---|---|
| `>200` | 4 | **1**（只剩 `memory::schema::init_schema` **300** 行 —— 它是列清单 + 触发器 SQL，数据不是逻辑） |
| `150–200` | 4 | 4（`build_response` 198 / `run_build_with_progress` 192 / `repo_map` 152 / `save_agent_trace` 151 / `drive` 150 中的四个） |
| `100–150` | 10 | **13**（新增的三个正是 `chunk_pass` 141 / `reconcile_counts` 126 / `continue_llm` 111） |

也就是说：**三个最大的洞被填掉了（最大 356 → 300），但它们的碎片仍各自落在 100–150 区间**。
这不是失败，是「按阶段切」的必然结果 —— 下一步要再降，得切**循环体内部**（`chunk_pass` 的「处理一个文件」
可以独立成 `index_one_file`）或**核对块内部**（`reconcile_counts` 的「探针 / 重数 / 出维修建议」三段），
那已经接近「重写这段逻辑」而不只是搬家，风险与收益要重新称一次。这也是本批停在这里的理由。

---

## 18. 2026-11-19 第三批：把 §17.4 点名的两处「循环体内部」也切了

### 18.1 做了什么

| 函数 | 之前 | 现在 | 切出来的东西 |
|---|---|---|---|
| `index::build::chunk_pass` | **141** | **79** | 单个文件的全部判断 → `index_one_file`(**64**) + `FileOutcome` 枚举 |
| `index::status::reconcile_counts` | **126** | **101** | 两个 `EXISTS` 探针 → `probe_db` + `DbProbe`（30 行） |

顺带合并了一处重复：`chunk_pass` 里「mtime 没变」分支与「建完 chunk」分支**各写了一遍**完全相同的
进度上报（条件、参数逐字相同），且都夹在 `file_count += 1` 之后 —— 现在统一成
「`file_count += 1` → `if progress_due(..)` 一处」。这是**行为等价**的合并（同一位置、同一条件），
不是「顺手改逻辑」。

### 18.2 `index_one_file` 的契约（为什么这么切）

- **事务边界不在它手里**：分批提交（`CHUNK_COMMIT_EVERY`）留在 `chunk_pass`，它只吃 `&Transaction`；
  否则「一批多大」这件事会散进单文件处理里。
- **三种去向用枚举显式写出**：`Indexed` / `Unchanged` / `Skipped`。以前这三种是三条 `continue`，
  「这个文件到底算不算这一轮的账」只能靠读 `file_count += 1` 出现在哪几个分支里才知道。
- 「暂时读不到」与「永久不可索引」**回执相同（`Skipped`）**，差别只在要不要清旧 chunk ——
  这条差异以前埋在 `continue` 之前三行，现在写在函数体注释与分支注释里。
- 参数 6 个、无新增全局状态、无新增配置项。

### 18.3 数字

| 区间 | §17 之后 | 现在 |
|---|---|---|
| `>200` | 1 | 1（`init_schema` 300 —— 列清单 + 触发器 SQL，数据不是逻辑） |
| `150–200` | 4 | 4 |
| `100–150` | 13 | 12 |
| **合计 `>100`** | 18 | **17** |

本批三个原目标现在是：`run_index` **356 → 88**、`continue_llm` **264 → 111**、`status_with_conn` **205 → 64**；
`chunk_pass` **141 → 79**、`index_one_file` 64、`reconcile_counts` **126 → 101**。

> `reconcile_counts` 停在 101（差一行）是**故意的**：再切只能切出「三行的小函数」，
> 那是为指标而指标，不是为可读性。

### 18.4 验收

`cargo test --workspace --lib` **339** / `--no-default-features` **338** 全绿（条数一条没变）·
`cargo clippy --workspace [--no-default-features] --all-targets -- -D warnings` 两套 0 错误 ·
`verify:rpc-catalog` / `verify:core-contracts` / `check:shared-constants` / `check:contracts` / `check:js` 全 OK · `npm test` OK。

### 18.5 仍 `>100` 的 12 个（都是本轮之前就有的，本批没动）

`build_response` 198 · `run_build_with_progress` 192 · `repo_map` 152 · `save_agent_trace` 151 ·
`drive` 150 · `graph::start_index_workspace` 141 · `index::start_index_workspace` 138 · `chat_completion` 134 ·
`search` 122 · `serve_stdio` 121 · `save_agent_steps` 115 · `planner::start` 109 · `search_messages` 104 ·
`graph::index_file` 103 —— 这些的「该不该切」需要各自判断（有的是守卫序列、有的是 SQL 拼装、
有的是流程编排），不再有「一个函数在做五件不相干的事」那种明显信号。要降它们，应当按**各自模块的
下一张工单**推进，而不是继续做搬家。

---

## 19. 2026-11-19 第四批：两条跨语言契约债的收口

两条都是 `docs/ARCHITECTURE-DEBT.md` 里标着「需决策」的项 —— 本批先**改正诊断**，再决定动不动代码。

### 19.1 `injectScore`：诊断错了，真问题在关键词分支

| | |
|---|---|
| 原诊断 | 「语义用余弦、关键词用相对最佳，两个量纲却被同一个阈值卡」→ 结论是需要标定数据，纯代码无解 |
| **更正** | 「跨分支可比」**不是需求**：`memory.long_recall` 每次只返回**一个** mode（semantic / keyword / recent / none），两条分支的结果从不进同一个列表、也不互相排序。真正的问题在关键词分支自己：只有相对量 → **top 命中恒为 1.0**，于是任何命中都等于满分 |
| 后果（可感知） | 一条只蹭到一个常见词的长句，每轮都被注入；而 +它把整个通道的过滤能力弄没了 |
| 已实施 | `crates/dieyun-base/src/fts.rs`：`query_terms` / `term_coverage`（与 `match_query` 共用切分规则与 `MAX_TERMS`，别处不许再切一遍）；`memory/recall.rs`：`keyword_inject_score = 覆盖度 × 相对强度`。片段之间是 **OR**（见 `fts.rs` 文件头第 3 条），所以「有命中 ≠ 对上了」，覆盖度是这条链路上唯一与语料无关的绝对量 |
| 用例 | `keyword_inject_score_is_coverage_times_relative`（纯函数）、`term_coverage_counts_matched_fragments` / `term_coverage_is_case_insensitive_and_capped`（切分与大小写）、`keyword_inject_score_discounts_partial_term_coverage`（端到端：两个片段只命中一个 → ≤0.5） |
| 不动 | 宿主阈值仍是 `agent-limits.memoryInjectMinScore = 0.32`（一个数）；语义分支不变（余弦本来就是绝对的） |
| 仍然没有 | 「余弦 0.9 与关键词 1.0 谁更可信」的答案 —— 但**现在没人需要回答**（单 mode）。真要把两分支合并排序时才需要标定数据 |

### 19.2 请求快照：不搬装配，把差异钉住

| | |
|---|---|
| 原诊断 | 快照取自 `round.prepare` 的宿主副本，而出站投影发生在**之后** → 快照与实发差一个 `reasoning_content` |
| **决定** | **不搬装配、不加事件通道、不加列**。理由：① 要 core 把投影后的 body 交回宿主，等于每轮多搬一份完整 body；② 把 `buildRequestSnapshotPayload` 搬进 core 会把 session / limits / contextAudit 三处宿主专属事实一起拖过去（另一张工单），且它有 schema 与测试 |
| 改成什么 | 把差异变成**被钉住的清单**：`outbound.rs` 用例 `projection_touches_only_the_documented_fields` 求投影前后被改动的路径集合，断言恰好是 `messages[].synthetic` / `messages[].reasoning` / `messages[].reasoning_content` / `tools`（空数组整键删）/ `stream` / `stream_options`，并断言 `content` 一字未动。**加任何新改写就红** |
| 文档 | `docs/REQUEST-SNAPSHOT.md` §7「快照 vs 真正发出去的那一份」：五项逐条列出，并写明结论 —— **快照里的信息 ⊇ 模型看到的**，唯一的内容级差异是同值换名（`reasoning` → `reasoning_content`）+ 缺值补占位串 |
| 残留 | 需要「快照 = 实发字节」（逐字节 replay）的场合仍然没有；那得连装配一起搬，属 Node 变薄那条线 |

### 19.3 验收

`cargo test --workspace --lib` **342**（82 base / 104 codebase / 60 memory / 97 runtime；
新增 3 条：两条 `fts` 切分与覆盖度、一条 memory 端到端）· `--no-default-features` **341** 全绿 ·
`cargo clippy --workspace [--no-default-features] --all-targets -- -D warnings` 两套 0 错误 ·
`verify:rpc-catalog` / `verify:core-contracts` / `check:shared-constants` / `check:contracts` / `check:js` 全 OK · `npm test` OK。

---

## 20. 2026-11-19 第五批：共享记忆的第三处量纲债（§19 的同形）

`docs/ARCHITECTURE-DEBT.md` §11 是 §10 的同形债，只是换了一套数据源（跨机 PostgreSQL）。本批先按它自己
写好的判据走：「先看 `memory-shared/service.js` 的打分能否给 `injectScore`」。

### 20.1 能做的一半：给 `injectScore`（统一字段名与口径）

`service.js` 的召回行现在同时带 `score`（排序量纲）与 **`injectScore ∈ [0,1]`**（该不该注入），
与本地长期记忆**同名同义**；宿主 `fetchSharedMemoryBlock` 只读 `injectScore`。

| 分支 | `injectScore` 怎么来 | 有没有天花板 |
|---|---|---|
| 向量行 | `clamp(1 − 余弦距离)` | 无（余弦本身绝对、跨查询可比） |
| trigram 行 | `pg_trgm similarity()` | **有**：量的是 `\|A∩B\|/\|A∪B\|` 的特例，天花板随「查询/条目」长度比下降 |

用例：`判定只看 injectScore：score 再高、injectScore 不够也不注入`（把「两个字段各有各的读法」这条路堵死）。

### 20.2 不能做的一半：合并成一个阈值（有结构原因，不是懒）

本地那边能收成一个数（0.32），是因为①两条分支**从不进同一批**（`long_recall` 单 mode）；②关键词强度
已经做成与语料无关（片段覆盖度 × 相对命中）。共享记忆恰恰相反：**同一批里混着两种相似度**，而 trigram
的数值天花板天生比余弦低一个量级 —— 并成 0.32 会让「没向量时的文本兜底」整段失效，
直接推翻 `COALESCE` 的设计前提。所以保留 0.32 / 0.12 两个数，把「为什么这里与本地不同」写进
`docs/SHARED-MEMORY.md` §4，而不是硬凑一个数。

### 20.3 仍未做（不是债）

给 trigram 通道也造「与长度无关」的绝对强度 = 在 Node 侧把查询切成片段算覆盖度再下传
（与 `fts::term_coverage` 同形）。PG 侧没有等价的分词器（中文只能靠 trigram），这属于另一张工单。

### 20.4 验收

`npx vitest run test/unit/shared-memory.test.cjs` 22 条（+1 新用例）通过 · `check:js` 0 错误 ·
Rust 侧未改动（本批只动 `src/memory-shared/service.js`、`src/agent/system-prompt-prep.js` 与其单测 + 文档）。

---

## 21. 2026-11-19 第六批：请求快照大字段内容寻址去重

### 21.1 依据（先量再动）

只读探针看线上记忆库（`%APPDATA%/dieyunagent/diecloud-memory.sqlite`）：

| 表 | 占用 | 关键事实 |
|---|---|---|
| `request_snapshots` | **413 MB / 626 MB（66%）** | 1500 行 / 45 会话 |
| └ `tools_json` | 88.6 MB | **只有 82 种内容**（同一份 schema 拷了 1500 次） |
| └ `system_text` | 6.8 MB | 只有 65 种内容 |
| └ `messages_json` | 198 MB | 每轮都不同，**这是它的本职** |

### 21.2 做了什么

新表 `snapshot_blobs(hash → text)`（内容寻址）；行的 `system_text` / `tools_json` 写 NULL，靠
`system_hash` / `tools_hash` 回查。**没有**回到「与上一行相同就写 NULL」那条被否掉的路 ——
那套的问题（NULL 二义 / 游标跨并发 / 丢确定性）内容寻址一条都不碰：
`hash 有 + blob 有 = 去重`，`hash 有 + blob 无 = 超上限没落库`。

| 面 | 落点 |
|---|---|
| schema | `memory/schema.rs`：`CREATE TABLE IF NOT EXISTS snapshot_blobs`（在同一个 batch 里，老库自动补） |
| 写 | `snapshot.rs::stash_blob`（`INSERT OR IGNORE`，同 hash 只留一份） |
| 读 | `get_request_snapshot` 改成 `LEFT JOIN snapshot_blobs` + `COALESCE`，**调用方看到的仍是全文** |
| 清理 | `prune_request_snapshots` 删完行清**孤立 hash**（不然省下的体积会以另一种形状还回去） |
| 迁移 | `backfill_snapshot_blobs`（每拍 400 行）挂在**修剪线程**已有节拍上 —— 不在启动路径上搬几十 MB 卡首屏；读侧两种形状都认 |
| 用例 | `dedupes_system_and_tools_by_hash` / `over_cap_text_is_not_faked_back` / `prune_drops_orphan_blobs` / `backfill_moves_legacy_inline_text_into_blobs` |

### 21.3 实测收益

在**库副本**上跑同一套 SQL + `VACUUM`：**626.4 MB → 461.7 MB（−164.6 MB / −26.3%）**；
去重后正文只剩 **5.4 MB（148 个 blob）**；抽查最新一行：`system 4301 字符 / tools 66818 字符` 都按 hash 拼回。

### 21.4 决定不做的那一半

`messages_json`（198 MB）**不去重、不压缩、不存 diff**：它是每轮都不同的真实内容，差分/回放会让读侧
需要一条「还原链」，与「旁路事实、不参与 replay」的定位直接冲突。要再降只有压
`requestSnapshotKeepPerSession`（一行配置）。

### 21.5 验收

`cargo test --workspace --lib` **346**（82 / 104 / 64 / 97，本批 +4）· `--no-default-features` **345** ·
`cargo clippy --workspace [--no-default-features] --all-targets -- -D warnings` 两套 0 错误 ·
`npm test` / `check:js` / `check:contracts` / `verify:rpc-catalog` / `verify:core-contracts` / `check:shared-constants` 全 OK。

# Rust core 重构方案（2026-11-17）

> **一句话**：不建议「推倒重写」。这套 Rust 的问题不是「代码烂到该重写」，而是**同一份知识有第二份实现**，于是每次修 bug 都只能打在消费端 —— 补丁因此越打越多。
> 正确做法是**一趟删除 + 一趟归位**：先把 74 条已取证的缺陷分级止血，再把重复实现收敛到单一来源，最后才谈结构重排。
> 本文配套取证：`docs/audit/2026-11-rust-core/{agent,memory,rpc,index,graph,runtime,planner}.md`（每条都带 `文件:行` 与代码原文）。
> **进度**：**P0 止血**（9 项 / 8 条 A 级）与 **P1 契约与闸门**（共享常量 + 3 条双跑 fixture + catalog/d.ts + RPC 方法表 + 86/86 handler）均已落地，`cargo test` 239 → **264 全绿**（见 §5）；P2–P6 未开始。

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

- ✅ **数值/词表单源**：`assets/agent-shared.json`（14 个键）→ Node `src/agent/shared-constants.js` / Rust `crates/dieyun-core/src/shared.rs`（`include_str!` 编译期嵌入）。
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
- 数值单一来源（`NODE-THINNING-PLAN N1.1`）：token 系数 / 图片等效 token / 预算地板 / 触发比夹取范围 / 读上限 / 慢请求阈值 → 一份 `assets/agent-shared.json`，两侧读同一份；**顺手修 4096 vs 8192 的不一致**。
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

### P3 · 单一来源收敛（6–10 人日，风险中）· **2 / 5 已落地（2026-11-18），第 6 条已在收尾批完成**

| 项 | 状态 | 落点 / 证据 |
|---|---|---|
| ✅ **外键二选一** | 已做 | **选「删掉无约束力的声明」**（不是开 `foreign_keys`）：memory 库走 `SqliteHandle::new_with_foreign_keys`，它的 CASCADE 是真的；index / graph 的库连接按 `TuneOptions::foreign_keys=false` 打开，`graph_calls` 与 `chunk_vectors` 上的 `FOREIGN KEY … ON DELETE CASCADE` 从来没生效过 —— 删掉并在建表处写明「级联的唯一实现是 `graph/cleanup.rs` / `index/build.rs` 的写库原语」。顺手修掉第四处不一致：`memory/misc.rs` 的修剪线程以前 `open_tuned` + 手写 `pragma_update(foreign_keys, ON)` 且 `if …is_ok()` 放行（一次 pragma 失败就静默跳过整个修剪，孤儿 traces/plans 越攒越多），改用 `open_tuned_with(.., TuneOptions { foreign_keys: true })`（失败会 Err）。两条守卫用例 `schema_declares_no_unenforced_foreign_keys`（index / graph 各一条，扫 `sqlite_master` 的实际建表语句） |
| ✅ **命中位置一份** | 已做 | `fts::first_hit_byte(content, terms)` 是唯一实现（大小写不敏感，返回字节偏移）；`fts::first_hit_index`（摘录要字符下标）与 `index::search::first_hit_line`（要行号）都从它派生。此前 search 自己写了一遍 `content.find(term)`（**区分**大小写），于是「摘录围绕的位置」与「命中行」会指向不同地方。用例 `hit_position_has_a_single_source`。摘录预算按字符在 P1 已改 |
| ✅ **可见性 / 维度 / 形状三份收敛** | 已做 | ①**可见性**：`semantic_search_long` 以前手写 `m.status = 'active'`（关键词分支用 `long_mem_visible_sql`）→ 过期记忆照样能被语义召回，同一个问题问两次两套结果；现在两条分支共用 `long_mem_visible_sql`，SQL 成形在 `semantic_long_sql()` 里便于断言（绑定顺序 ?1 签名 / ?2 现在 / ?3 scope）。②**维度**：index 三处 P0/P1 已换 `effective_dimensions()`；远端回包的校验（`embedding/remote.rs`）也改成它 —— 数值本来就相同，但「判定口径」只有一处。③**形状**：`recall.rs` 里长记忆命中 JSON **三份**（`keyword_search_long_memories` / `keyword_search_long` / `semantic_search_long`，字段名还在 `created_at` 与 `createdAt` 之间来回）→ 收成 `long_mem_hit_json()` 一处，统一用 `created_at`（与完整行 `map_long_memory_row` 一致），分数统一 `round_score`。用例 `semantic_branch_uses_the_shared_visibility_predicate`、`hit_projection_has_one_shape`。**没并的**：`archive.rs` 的「搜索命中」与 `misc.rs` 的「增量同步整行」是两个不同契约（片段 vs 完整行），合并会把两种用途硬塞进一个形状 —— 已在代码注释里写明，不再当重复实现处理 |
| ⏳ **五份抽取器合并** | 未做 | `extract/{symbols,go,python,rust_lang}.rs` 的 `take_ident`/`scan_call_targets`/`strip_comment` + `treesitter/extract.rs` 的 `is_ident` → `extract/heuristic.rs`；补 AST↔启发式对称性测试 |
| ⏳ **schema 声明式迁移** | 未做 | 一份列清单生成 `CREATE TABLE` 与 `ALTER`（memory 16 条 / graph 2 条 / index 若干）；`ensure_schema` 不再靠「表存在就早退」 |
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

### P5 · 「做不到」显式化 + 观测（3–5 人日）

- R3：`GraphStatusCallGraph`、`IndexStatus.truncated/skipped`、`compaction.estimate{tokens:null}`、`planner.done` 带 `truncated:true`。
- R4：`obs.rs` 收口 `[rpc-slow]`（保留唯一一条，删掉 20s 预算机制，理由见 §6）、折叠事实、每轮 usage、工具耗时；`agent.delta.round` 填真实 `round_of()`（或删字段 + 删文档 + 删宿主兜底，二选一）。
- 删掉「已删除机制的注释」：`INTERACTIVE_EMBED_BUDGET_MS`、`agent.llm.chat`、45s 口径、`fold:L` 之外的旧描述。

### P6 · 死代码清除（1–2 人日）

`index/remote.rs` 整条（344 行 + `RemoteIngestHandle` + 其单测）、`Accumulator.started`、`EMBEDDING_TIMEOUT_CODE`、`walker.rs` 的 `.env` 白名单、`messages_clear` 别名、`PlannerContinueInput.partial_body`、`store.rs` 里搬走后留下的空注释、`graph/build.rs` 的 `MAX_GRAPH_FILES` 重复常量。

**先核实再删**：删之前 grep 调用点，无调用点才删；有调用点就按 P3 收敛（不要留转发壳）。

---

## 6. 闸门：怎么让「还有哪些 bug」不再增长

**每批的统一验收**

```bash
cargo test -p dieyun-core --lib          # 239 起，只许加不许减
npm run check:js                          # 含 types/core-rpc.d.ts 的字段检查
npm run verify:rpc-catalog                # P1 之后含「臂数 == 条目数」自检
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
| 「同一份知识两份实现」 | 审计列出 40+ 处 | ≤ 5（且每处有理由） | 详档「度量」小节逐条勾掉 |
| `rpc/mod.rs` 单测 | 1 | 每 handler ≥1 | `cargo test -- --list \| grep rpc::` |
| 静默吞错 | `let _ =` 123 / `.ok()` 19 | 白名单外 0 | `clippy -D warnings` |
| 最大文件 | 1935 行 | ≤ 800 行 | `Get-ChildItem -Recurse *.rs \| Measure-Object -Line` |
| 结构化事件覆盖 | 13 处 `eprintln` / 0 `tracing` | 关键路径 100% 事件化、`eprintln` 0 | `obs.rs` + grep |
| 跨语言 fixture | 1 处（token） | ≥ 5 处 | `test/fixtures/*-cases.json` |

**停止条件**：P0–P6 全部落地 + 上表达标 → 这套 Rust 进入"可长期维护"状态，此时再评估 §7 的重写才是有依据的选择。

---

## 9. 附录

### 9.1 取证文件

| 文件 | 覆盖 | 条目 |
|---|---|---|
| [`audit/2026-11-rust-core/agent.md`](audit/2026-11-rust-core/agent.md) | driver / loop_run / llm | 11 |
| [`audit/2026-11-rust-core/memory.md`](audit/2026-11-rust-core/memory.md) | memory 全模块 | 10 |
| [`audit/2026-11-rust-core/rpc.md`](audit/2026-11-rust-core/rpc.md) | rpc 分派 / 事件 / stdio | 9 |
| [`audit/2026-11-rust-core/index.md`](audit/2026-11-rust-core/index.md) | index / fts / codebase_db | 11 |
| [`audit/2026-11-rust-core/graph.md`](audit/2026-11-rust-core/graph.md) | graph / treesitter | 11 |
| [`audit/2026-11-rust-core/runtime.md`](audit/2026-11-rust-core/runtime.md) | compaction / embedding / config / sqlite / main | 11 |
| [`audit/2026-11-rust-core/planner.md`](audit/2026-11-rust-core/planner.md) | planner | 11 |

每条含：类型 / 严重度 / `文件:行` / 代码原文证据 / 触发条件 / 修法方向 / 怎么确认 / 置信度。

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

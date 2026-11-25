# 架构技术债台账（2026-11 审查 · 持续更新）

> **这份文档存在的唯一理由**：列清「哪里还旧、旧在哪、怎么算修完」。
> 每一条都带**当前工作树里的证据**（`文件:行`），不引用改造前快照；
> 每一条都写清「动什么算完」，避免只做一半。
> 状态图例：`未动` / `半条` / `需决策` / `已完成`。
>
> **2026-11-18 全量复核**：Rust 侧 P0–P7（缺陷止血）+ 拆 crate + 抽取层二选一 + §10.8 三件
> 已全部落地（见 [`RUST-CORE-REFACTOR-PLAN.md`](RUST-CORE-REFACTOR-PLAN.md) §10–§14），
> 全部 Rust 路径因此变了：`crates/dieyun-base/src/...` → `crates/dieyun-{base,codebase,memory,runtime}/src/...`。
> 本次把每条证据的行号与新路径重新核过一遍，并按下面的速览表更新状态。
>
> **速览（2026-11-18）**
>
> | § | 条目 | 状态 |
> |---|---|---|
> | 2 | 日志被当 IPC 用 | **已完成**（13 处 ad-hoc `eprintln!` 全部迁进 `obs.rs` + 源码守卫用例） |
> | 3 | 词法检索是 `LIKE '%…%'` 全表扫 | 未动（**已量**：本仓语料 hit@5 100% / MRR 0.98 / p95 115ms，未触发；测量脚本可复跑） |
> | 4 | 向量 int8 全表暴力扫 | 不该动（有触发线闸门） |
> | 5 | token 估算是字符比启发式 | 半条（触发口径已用 usage；**校准仍未做**） |
> | 6 | `request_snapshots` 每轮存整份 prompt | 未动 |
> | 7 | JS 这一侧更旧 | 未动（①契约生成：方法名层已生成，字段层仍手写） |
> | 8 | 工具定义两份注入点 | **已完成**（两处都是组装器；MCP 工具定义/候选项已收成 `schema-slim.js` 一份） |
> | 9 | Renderer 降级 loop | 已完成（2026-11-17） |
> | 10–14 | 本次复核新发现 | 见各条 |

---

## 0. 已完成（20+ 轮，2026-11-17）

原审查排第一的是**循环的切分方式**：一个 agent 循环被切成三段（Rust 账本 / Node 控制流 / Node HTTP），每轮跨进程 3 次、messages 全量搬 2 次。这一条**已经反过来**，且 2026-11-18 又往前推了一步。

| 维度 | 之前 | 现在 | 落点（新路径） |
|---|---|---|---|
| 谁驱动轮次 | Node 的 `while` | core 的 `driver::drive` | `crates/dieyun-runtime/src/agent/driver.rs` |
| 谁发 LLM | Node（`llm-stream-utils.js`） | core（`agent/llm.rs`），宿主经 RPC `llm.complete` | `crates/dieyun-runtime/src/agent/llm.rs`、`rpc/handlers/async_core.rs` |
| transcript 写者 | 两个（Node `set_messages` + core 折叠） | **只有 core**（账本上的 `set_messages` 已删除） | `crates/dieyun-runtime/src/agent/loop_run/` |
| 压缩 | 滚雪球 LLM 摘要 + 伪造 assistant 回执 | 就地折叠（保 `tool_call` 骨架、幂等档位、usage 触发） | `crates/dieyun-base/src/compaction/fold.rs` |
| 溢出 / 拒图自愈 | Node 发现 → 回写 messages → 重发 | core 内部折叠 / 摘图 → 重发一次（**折不动就不重发**，2026-11-18 修） | `driver.rs` |
| 出站请求体形状 | 三个作者（账本 / llm.rs / Node `round.prepare`） | **只有 `agent/outbound.rs`**（R2，2026-11-18） | `crates/dieyun-runtime/src/agent/outbound.rs` |
| 可观测性 | 宿主正则刮 core 的 stderr | 结构化事件通道 + `obs.rs` 出口（`[rpc-slow|fold|usage|tools|io|degraded]`） | `crates/dieyun-base/src/obs.rs`、`rpc/events.rs` |
| 向量后端 | 只有远端 HTTP + 三层补偿 | 本地 `ort` 推理优先，补偿层整体删除 | `crates/dieyun-base/src/embedding/local.rs` |
| 结构 | 单 crate 26.7k 行 | **5 个 crate，依赖方向由 Cargo 强制** | 见 `AGENTS.md`「架构三层」 |

主循环的跨进程边界现在只剩两处，且都有理由：**工具执行**（平台能力在 Node）与 **`round.prepare`**（每轮请求级装配：视觉注入 / 字符上限 / 图片 sanitize）。

---

## 2. 日志被当 IPC 用 · `已完成（2026-11-18 收尾）`

| | |
|---|---|
| **原证据** | `core-bridge.js` 里把 `[compaction-llm]` 正则解析成 `compaction.progress` |
| **现在** | 那条解析已删；P5 建了 `crates/dieyun-base/src/obs.rs` 作为**唯一写出口**：`rpc_slow` / `fold_fact` / `usage` / `tool_round` / `io_line` / `degraded` 六个出口，格式函数是纯函数（有用例钉格式），调用点 14 处。宿主直接消费事件，不再 grep 人类日志 |
| **2026-11-18 收尾** | 那 13 处全部迁进 `obs.rs`（调用点 14 → **28**）：失败类走 `degraded`（`sqlite.dirty_txn` / `index.skipped_files` / `index.prune_workspaces` / `index.query_vector` / `index.graph_cleanup` / `memory.reconcile` / `memory.fts_rebuild` / `round.prepare` / `rpc-runtime`），**自愈动作**走新增的 `heal`（`[rpc-heal] run=… action=fold_resend|fold_skip|image_drop_none|image_resend`，不与失败混进降级率）。生产路径 ad-hoc `eprintln!` 现在 **0 处**（`embedding/local.rs:562` 那处在 `#[cfg(test)]` 里，守守护例不扫测试代码） |
| **守卫** | `obs::tests::eprintln_lives_only_in_the_sink`：走全 `crates/*/src`，只看 `#[cfg(test)]` 之前的生产代码，除 `obs.rs` 的 sink 外出现 `eprintln!` 就红。**变异验证过**（往 `sqlite.rs` 塞一行 `eprintln!` 立刻红，删掉即绿） |
| **仍未做** | `tracing` 仍 0 处：那是「引依赖 + 决定导出端点」的独立决定，OTel 同 |
| **优先级** | 已完成（OTel 单独立项） |

## 3. 词法检索是 `LIKE '%…%'` 全表扫 · `未动（已量，未触发）`

| | |
|---|---|
| **现状证据** | `crates/dieyun-codebase/src/index/search.rs:461,464`（`content LIKE '%' \|\| ? || '%'`，路径与正文各一条表达式） |
| **为什么过时** | 命中按「命中词数」排序，没有 bm25；语料一大就退化成全表扫 |
| **动什么算完** | FTS5 + `bm25()`（中文需要合适的 `unicode61` / 分词配置）。注意 `search.rs` 那条注释说的是 **trigram 索引**占库 40%，不是 bm25 的代价 |
| **2026-11-18 相关但不同的改动** | §14.2 修的是「**强证据判据**」（`hits` 拆成 `hits` / `content_hits`），与「换不换 FTS5」无关，别混为一谈 |
| **2026-11-18 实测（可复跑）** | `npm run measure:lexical`（`scripts/measure-lexical-quality.cjs`）：spawn 本仓 core → 只建词法索引 → 机械抽样题目（标识符题取高频 token、多词题切真实注释行）→ ground truth 由脚本自扫（**只数正文**、按 `.gitignore` 与隐藏项过滤，与索引口径一致）→ 报 hit@1 / hit@limit / MRR / p50 / p95，并落 JSON 到 `.dieyun/measure-lexical/`。<br>本仓实测（1251 个进索引文件 / 18.3k chunk / 60 题）：**hit@1 96.7% · hit@5 100% · MRR 0.983 · p95 115ms** → 判据（hit@limit ≥ 90% ∧ MRR ≥ 0.70 ∧ p95 ≤ 300ms）**未触发**，`verdict=keep-LIKE` |
| **判据为什么写死在脚本里** | 免得「看了数据再改口径」：三项都不在线内才 `trigger-FTS5`；触发时脚本会把未命中的题目逐条列出来（含 truth 份数与返回条数） |
| **什么时候再量** | 语料翻倍（>3000 文件 / >40k chunk）、或用户报「搜不到」时先跑一次；`--workspace <dir>` 可以对任意项目量（远端大仓尤其值得，16k 上限的截断也会打出来） |
| **优先级** | 低（有数据：本仓不触发；等语料触发线） |

## 4. 向量是 int8 全表暴力扫 · `未动（按既有结论不该动）`

| | |
|---|---|
| **现状证据** | `crates/dieyun-codebase/src/index/vector_pool.rs:32` `VECTOR_POOL_MAX_BYTES = 3GB`；`docs/VECTOR-SEARCH.md §4` 写明换 ANN 的触发条件（>200 万向量 / P95 > 300ms / dim ≥ 1024） |
| **为什么现在不动** | 实测未触发。加 HNSW 是复杂度与召回率的交易 |
| **动什么算完** | 只有触发线被满足才动，届时按 `VECTOR-SEARCH.md §4` 执行 |
| **优先级** | 低（有明确闸门） |

## 5. token 估算是字符比启发式，且没回灌校准 · `半条`

| | |
|---|---|
| **现状证据** | `crates/dieyun-base/src/compaction/tokens.rs:70`（`cjk/cjk_chars_per_token + other/chars_per_token`，系数来自 `agent-shared.json`）、`:24` 图片等效走 `shared::image_part_equiv_tokens`、`:73` `estimate_messages_tokens` **已把 `reasoning_content` 计入**（P0 修的 A13）；触发口径用服务端 usage：`loop_run/ledger.rs:190` 写 `observed_prompt_tokens`，`compaction/fold.rs` 的 `trigger_source = usage \| estimate` |
| **还差什么** | **估算没有用 usage 回灌校准**：拿到真实用量却只用来判「该不该折」，不修正「估得准不准」 |
| **动什么算完** | 用 `usage.prompt_tokens` 与本地估算的比值做**低频、可回滚**的滑动校准（按模型 + 通道），偏差超上限有告警 |
| **风险** | 别做成每轮动态调参的抖动源 |
| **优先级** | 中低（精度问题，不是结构问题） |

## 6. `request_snapshots` 每轮存整份 prompt · `已收口（2026-11-19：大字段内容寻址去重）`

| | |
|---|---|
| **现状证据（改前）** | `crates/dieyun-memory/src/memory/snapshot.rs`：`messages_json: String` 每轮整份落库，`system_text` / `tools_json` 也**逐轮内联**。只读探针实测（2026-11-19，线上库）：`request_snapshots` **413 MB / 626 MB（66%）**，其中 `tools_json` 88.6 MB / 1500 行但**只有 82 种内容**、`system_text` 6.8 MB / 65 种 |
| **为什么仍算债** | 「同一个会话每轮发的 system / tools 是同一份」这件事没有任何结构表达 —— 拷 1500 次 |
| **已实施** | 新表 `snapshot_blobs(hash → text)`（内容寻址）；行的 `system_text` / `tools_json` 改写 NULL，靠 `system_hash` / `tools_hash` 回查。NULL 的两种含义**不再靠推断**：hash 有 + blob 有 ⇒ 去重；hash 有 + blob 无 ⇒ 超上限没落库（这正是当年否掉「与上一行相同写 NULL」的三条理由，内容寻址一条都不碰） |
| **迁移** | 新写入即刻生效；历史行由**修剪线程**每拍搬 400 行（`backfill_snapshot_blobs`，独立连接 + 固定节拍，不在启动路径上卡首屏）；读侧两种形状都认 |
| **孤立清理** | `prune_request_snapshots` 删完行顺手清孤儿 hash —— 否则省下的体积会以另一种形状还回去 |
| **实测收益** | 库副本上跑同一套 SQL + `VACUUM`：**626.4 MB → 461.7 MB（−164.6 MB / −26.3%）**；去重后正文只剩 5.4 MB（148 个 blob） |
| **用例** | `dedupes_system_and_tools_by_hash`（两行只存一份、读回全文一致）· `over_cap_text_is_not_faked_back`（没落库就是 NULL）· `prune_drops_orphan_blobs` · `backfill_moves_legacy_inline_text_into_blobs`（搬运不改读侧结果） |
| **仍未做** | `messages_json` 仍是整份每轮落库（198 MB）。它是**每轮都不同**的真实内容，去重/差分会引入读侧回放链 —— 与「旁路事实、不参与 replay」的定位冲突，**决定不做**；要再降只能压 `requestSnapshotKeepPerSession`（配置） |
| **优先级** | 已关闭 |

## 7. 比 Rust 更旧的是 JS 这一侧 · `未动`

| | |
|---|---|
| **现状证据（2026-11-18 实测）** | `src/renderer/index.html` **122 个 `<script src>`** 按顺序加载；`src/agent/tool-validate.js` **787 行**（机械校验已由 schema 生成，手写只剩语义判定 —— 见下）；`src` 下 JS（排除 `dist`）**515 文件 / 173,820 行**；零 ESM、零 TS（`tsc --checkJs` 只做检查，覆盖 30 个文件）；靠脚本查全局命名污染维持秩序 |
| **① 契约生成** | **已完成（2026-11-18）**，两条都闭环：<br>· **RPC 字段契约**：方法名层 `types/core-rpc.d.ts`（P1）+ 字段层 `types/core-contracts.d.ts`（N1.3：Rust 带 `@contract` 的 19 个 struct/enum → TS；`verify:core-contracts` 防过期、`check:js` 防调用方读错字段）；<br>· **工具参数校验**（N2.1 全链路）：`catalog schema` 成为唯一契约 → `npm run generate:tool-validators` 生成机械校验 → 62 条双跑夹具 62/62 一致（`test:tool-args`）→ **已接管并删掉手写机械块**：`tool-validate.js` **1128 → 787 行**，只剩 11 处语义判定（`computer`/`ssh`/`host_exec`/`apply_patch`/`fs_edit`/`web_fetch`/`host_open_url`/`graph`/`skill_delete`/`mcp_*`）。条件必填与跨字段规则写在 schema 的 `allOf`/`if/then`/`anyOf`，两侧求值共用 `src/agent/schema-rules.js`。取证：`TOOL-VALIDATE-INVENTORY.md` / `TOOL-VALIDATE-DUALRUN.md` / `TOOL-VALIDATE-DECISION.md` |
| **② 模块化（ESM）** | 未动。`<script>` 顺序依赖是隐式契约，不能批量改 |
| **动什么算完** | ① ~~工具参数校验从 schema 生成（N2.1）+ RPC 字段类型生成（N1.3）~~ **已完成**；② 逐模块 ESM 化，入场券是「全局符号零调用点」闸门（N4.1）—— 仍未动 |
| **优先级** | ① 已完成；② ESM 单独立项（低）。<br>**遗留待议**：`tool-gate.js` 里「参数校验」在「scope/权力」之前 —— 对「这一轮根本不许用这个工具」的场景，先报 `READ_ONLY_SCOPE` 比先报 `MISSING_ARG` 更准确；是否调换两关顺序是独立决策（会动 AGENTS §6 的关卡顺序），见 `docs/TOOL-VALIDATE-DECISION.md` |

## 8. 工具定义两份注入点 · `已完成（2026-11-18 收尾）`

| | |
|---|---|
| **核实结论（2026-11-18）** | **不是债**。两处都只是**组装器**，schema 只有一份：`src/agent/tool-catalog.js`（静态工具 + `toolsByNames` + `PLAN_RUNTIME_TOOL_NAMES` 等清单）。`src/agent/main-agent-tools.js:24-54` 用 `catalog.toolsByNames(...)`；`src/renderer/renderer-tool-defs.js:4-40` 全部从 `DieyunToolCatalog` 取（`_tc.X`），只按编辑器态/权限做开关。MCP 工具整形也只有一份：`src/mcp/schema-slim.js`（`slimMcpInputSchema` / `compactMcpToolDef`），经 catalog 再导出给两侧 |
| **2026-11-18 收尾** | 新增 `src/mcp/schema-slim.js` 的三个出口并成为唯一实现：`mcpToolDescription`（`[MCP · server] 描述` 模板）、`mcpCandidate`（召回用条目）、`mcpAgentTool`（目录条目 → 工具定义，含参数瘦身与 96 字描述上限）。三处调用点全部改成调它们：`src/agent/main-agent-tools.js`（原来内联且**不瘦身**）、`src/agent/main-tools/mcp.js`（候选描述）、`src/renderer/renderer-tool-defs.js`（描述模板，经 `_tc` 取、带同口径兜底） |
| **守卫** | `test/unit/mcp-tool-def.test.cjs`：同一份目录条目，Main 侧（`mcpAgentTool`）与 Renderer 侧（`compactMcpToolDef(entry)`）产出的定义必须**逐字段相同**；另断言深嵌套参数被折叠成 `mcp_tool_schema` 指引 |
| **优先级** | 已完成 |

## 9. Renderer 保留了一整套降级 loop · `已完成（裁决：删；2026-11-17）`

| | |
|---|---|
| **重新取证** | 降级 loop 的控制流早就不在了：`renderer-agent-run.js` 不再是分派器，非 Rust 的 `chatCompletionWithTools` 全仓 0 处，`renderer-agent-llm.js` 的 HTTP/SSE 已收口到 Main → core |
| **那一轮真正缺的** | 「`DIEYUN_CORE=0` 时明确告知不可用」没有单一来源（判据散在两处各抛一次，且跑到一半才炸） |
| **落地** | `renderer-agent-rust-loop.js:requireAgentRuntime()`（单一判据 + `AGENT_RUNTIME_UNAVAILABLE`）、`renderer-agent-run.js` 顶部断言、`renderer-agent-send.js:gateSendMessage` 发送前闸门 |
| **为什么不保留降级** | 保留 = 主链路两份循环实现，且要长期养一条只为降级存在的 smoke |

---

## 10. `injectScore` 的量纲 · `已收口（2026-11-19）`

| | |
|---|---|
| **当时的诊断** | 语义分支用余弦（绝对、跨查询可比），关键词分支用「相对本次最佳命中」（只能同查询内比），却由宿主用**同一个**阈值卡 |
| **复核后的更正** | 「跨分支绝对可比」这个需求**不成立**：`memory.long_recall` 每次只返回**一个** mode（semantic / keyword / recent / none），两条分支的结果从不进同一个列表、也不互相排序。真正的问题是关键词分支**只有相对量** —— top 命中恒为 1.0，于是「任何命中」都等于满分（一条只蹭到一个常见词的长句每轮都会被注入） |
| **已实施** | `crates/dieyun-base/src/fts.rs` 新增 `query_terms` / `term_coverage`（与 `match_query` 共用切分规则与 `MAX_TERMS`）；`memory/recall.rs` 的 `keyword_inject_score = 覆盖度 × 相对强度`。覆盖度是与语料无关的绝对量（查询 3 个片段、命中 1 个 = 1/3）—— 片段之间是 **OR**，所以「有命中 ≠ 对上了」。用例：`keyword_inject_score_is_coverage_times_relative`、`term_coverage_counts_matched_fragments`、`keyword_inject_score_discounts_partial_term_coverage`（端到端） |
| **仍未做（且不是债）** | 「余弦 0.9 与关键词 1.0 谁更可信」依然没有答案，但**现在没人需要回答**（单 mode）。将来真要把两条分支合并成一份排序，才需要标定数据 |
| **同形但另一套数据源** | 共享记忆（§11）仍是两个阈值：它在 PostgreSQL 上、打分在 `memory-shared/service.js`，与本地库这条链路不同源 —— 要统一得先给那边也造出 `injectScore` |
| **优先级** | 已关闭 |

## 11. 共享记忆仍在用两把量纲不同的阈值 · `已收口（2026-11-19：给 injectScore，但不合并阈值）`

| | |
|---|---|
| **现状证据** | `src/agent/agent-limits.js` 的 `sharedMemoryMinScoreSemantic` / `sharedMemoryMinScoreKeyword`；消费点 `src/agent/system-prompt-prep.js` 的 `SHARED_MEMORY_MIN_SEMANTIC/KEYWORD`；打分在 `src/memory-shared/service.js`（PostgreSQL 一条召回 SQL，向量 + trigram 兜底） |
| **复核结论（能做的那一半）** | 两种成分**都是 [0,1] 的有界相似度**（`1 − 余弦距离` / `pg_trgm similarity()`），所以可以给统一字段：`service.js` 现在每行返回 `injectScore ∈ [0,1]`，与本地长期记忆**同名同义**；宿主只读 `injectScore`、不再读 `score`（用例 `判定只看 injectScore：score 再高、injectScore 不够也不注入`） |
| **不能合并的那一半（有结构原因）** | trigram 相似度量的是 `|A∩B|/|A∪B|` 的特例：**天花板随「查询/条目」长度比下降** —— 短查询配长条目永远到不了 0.3。若把两个阈值并成 0.32，无向量时的文本兜底会整段失效（而 `COALESCE` 的设计前提正是「没向量也能召回」）。所以保留 0.32 / 0.12 两个数，并在 `docs/SHARED-MEMORY.md` §4 写明「为什么这里和本地记忆不同（一个数 vs 两个数）」 |
| **与 §10 的关系** | §10 那边能收成一个数，是因为本地两条分支**从不进同一批**、且关键词强度已经做到与语料无关；这里恰恰相反（同一批里混着两种相似度） |
| **仍未做** | 想让 trigram 通道也有「与长度无关」的绝对强度，需要把查询也切成片段做覆盖度（与本地 `fts::term_coverage` 同形）—— 但 PG 侧没有等价的分词器（中文靠 trigram），要做就得在 Node 侧切词再下传，属另一张工单 |
| **优先级** | 已关闭 |

## 12. 请求快照记录的是「投影前」的副本 · `已收口（2026-11-19，决定「不搬装配，改成钉住差异」)`

| | |
|---|---|
| **现状证据** | 出站形状唯一作者是 `crates/dieyun-runtime/src/agent/outbound.rs`（剥 `synthetic` / `reasoning`、补 `reasoning_content`、落 `stream_options`）；而快照由宿主 `src/agent/request-snapshot.js` 写，取自 `round.prepare` 交回的那份副本 —— 投影**之后**才发生 |
| **决定（不搬、不加通道、不加列）** | ① 让 `round.prepare` 回包带「投影后 messages」要新增一次 core→宿主的完整 body 往返（每轮多搬一份，体积与今天的快照写库同量级）；② 把 `buildRequestSnapshotPayload` 搬进 core 会把 session / limits / contextAudit 三处**宿主专属事实**一起拖过去，属另一张工单（Node 变薄），且它带着 schema 与测试 |
| **改成什么** | 把差异变成**被钉住的清单**：`outbound.rs` 新增用例 `projection_touches_only_the_documented_fields` —— 对同一份 body 求投影前后「被改动的路径」，断言恰好是 `messages[].synthetic` / `messages[].reasoning` / `messages[].reasoning_content` / `tools`（空数组整键删）/ `stream` / `stream_options`，并断言 `content` 一字未动。**往投影里加任何新改写，这条用例立刻红**，逼着回来同步文档 |
| **文档** | `docs/REQUEST-SNAPSHOT.md` 新增「快照 vs 真正发出去的那一份」：逐条列这五项，并写明「快照里的信息 ⊇ 模型看到的」—— 唯一的内容级差异是 `reasoning` → `reasoning_content`（同值换名；缺值补占位串） |
| **残留** | 需要「快照 = 实发字节」的场合（逐字节 replay 比对）仍然没有；那是另一件事，得连装配一起搬 |
| **优先级** | 已关闭（取证精度，不影响运行） |

## 13. 【新】`planner/run.rs` 仍是单文件巨石 · `已完成（2026-11-18 拆三刀）`

| | |
|---|---|
| **收尾（2026-11-18，纯移动）** | `run.rs` **1229 → 560 行**，按职责切三刀、每刀 `cargo test` 全绿：<br>· `planner/trace.rs`（**287 行**）：`build_response` / `emit_phase` / `update_plan_trace*` / `push_trace` / `phase_name` —— 「内部状态 → JSON」只在一处；<br>· `planner/best_of_n.rs`（**170 行**）：`handle_best_of_n_attempt` / `handle_best_of_n_pick_llm` / `start_best_of_n_job` + `BestOfNState` / `BestOfNAttemptRecord` / `summarize_worker_results`；<br>· `planner/workers.rs`（**272 行**）：`handle_worker_batch` / `prepare_worker_jobs` / `set_worker_queues` / `build_worker_loop_start` / `build_retry_jobs` |
| **搬家纪律** | 全部是 `impl PlannerRunManager` 的方法：搬到兄弟模块后可见性改成 `pub(super)`，`PlannerRunState` 的字段也一并 `pub(super)`；唯一的语义变化是「谁能看见谁」，没有一行逻辑改动 |
| **现状** | `run.rs` 只剩：对外 API（`start` / `continue_run` / `worker_loop_body` / `state` / `cancel` / `ping`）、阶段推进（`handle_plan_llm` / `advance_after_plan` / `handle_explore_loop` / `begin_best_of_n_or_review` / `handle_review_llm` / `handle_synthesize_llm`）、类型与 `finalize_plan` |
| **优先级** | 已完成 |

## 14. 【新】`memory/mod.rs` 之外仍有几处「实现 + 数百行测试同居」· `半条`

| | |
|---|---|
| **现状证据** | 2026-11-18 已把 13 个大文件的测试拆到同级 `tests.rs`（见 §14.1 of `RUST-CORE-REFACTOR-PLAN.md`）；仍同居的还有 `crates/dieyun-codebase/src/index/schema.rs`（353 行，含触发器 SQL 与列清单对账）、`crates/dieyun-memory/src/memory/{longmem.rs（579 行）, projects.rs（260 行）}` —— 后两个文件 `#[test]` 计数都是 **0** |
| **为什么算债** | 测试薄 + 职责杂：`longmem.rs` 同时管「写入即索引 / 近重复抑制 / 向量落库 / 写侧 await embedding」 |
| **动什么算完** | 给 `projects.rs` / `longmem.rs` 各补最小用例（rekey 断言、无 embedding 分支、维度取自向量），再按「写入策略 / 向量索引」拆文件 |
| **优先级** | 中低 |

---

## 15.【新】`llm_delta` 的载荷是「累计全文」 · `半条（合批已落地；协议改增量未做）`

| | |
|---|---|
| **现状证据** | `crates/dieyun-runtime/src/agent/llm.rs` 的 `agent.delta` 只带**本片增量**（这是对的）；宿主立刻累积成全文再逐分片外发：`src/agent/rust-loop-runner.js:663-674`。下游全部按「累积值」消费：`src/renderer/renderer-agent-rust-loop.js`（`ev.data.content` 直接当正文）、`src/agent/live-loop-trace.js:172`、`src/plans/plan-run-events.js:176`、`src/headless/main.js:36`、`src/agent/main-turn-runner.js:311` |
| **为什么过时** | 每个分片都搬整段回答 → 单轮传输量 O(正文²)；下游每片还要在整段上做一次归一化/O(n) 合并 |
| **2026-11-21 已做（合批）** | `src/agent/progress-flush.js` 成为**唯一**的流式合批实现：Main 的 `llm_delta` 与 planner `progress`、Renderer 主循环与 planner 两条流、计划 trace 队列共用同一份状态机（以前四处各写 pending/timer/rAF，数字还有 120/160 两套）；间隔只认 `agent-limits.agentProgressFlushMs`=40ms。另在 `llm-tool-call-fallback.js#stripToolCallMarkup` 加了「没有 `<` 就只折空行」的快路径。事件数与搬运量降一个量级，但**载荷语义没变** |
| **动什么算完** | 协议改成只带 `{seq, contentDelta, reasoningDelta}`，累积只留在 Renderer 的 `liveContent` 一处；上面 5 个消费方各自改成按增量追加（`headless/main.js` 那段「累计值差分打印」可整段删掉） |
| **为什么不顺手做** | 5 个消费方各有一套「整段归一化」写法（剥离工具标记 / 思考区截断 / 手机镜像），语义要一起改，得单独一个改动窗口；合批已经拿走九成收益 |
| **优先级** | 中 |

---

## 附录 A · 施工顺序（2026-11-18 重排，按「用户可感知度 ÷ 成本」）

1. ~~§1 本地 IPC 换 socket/pipe~~ —— 已完成（2026-11-17）
2. ~~§9 降级 loop~~ —— 已完成（2026-11-17）
3. ~~§8 工具定义两份注入点~~ —— 已核实：不是债；只剩「main-agent-tools 未 slim」这 10 行
4. ~~**§2 收尾**~~ —— 已完成（2026-11-18）：13 处迁进 `obs.rs` + 源码守卫（含变异验证）
5. ~~**§13 planner 拆三刀**~~ / ~~**§8 残留 10 行**~~ —— 均已完成（2026-11-18）
6. **§3 FTS5 bm25** —— 先跑 `npm run measure:lexical`；本仓已量（未触发），大仓/远端再量
8. **§7① 字段级契约生成 + 工具校验从 schema 生成**（消灭手写对照表）
9. §5 / §6 / §10 / §11 / §12 / §14（精度、库体、取证、测试厚度）
10. §4（等触发线）、§7②（单独立项）

## 附录 B · 维护规则

- **每条改动落地后回到这里改状态**，并把证据行号更新（行号会漂）。
- **复核先跑数字**：本文档里所有计数（`eprintln!` 处数、`<script src>` 数、JS 行数、单文件行数）都可以一条命令重测；
  改完一条别忘了顺手重测相邻条目 —— 2026-11-18 这次复核就发现「日志当 IPC」其实已经落地大半，而文档还写着 13 处 / 0 tracing。
- **新发现的过时设计**按同样格式追加：现状证据 / 为什么过时 / 动什么算完 / 风险 / 优先级。
- **不要在本文档里写「计划」而不写「证据」**：没有 `文件:行` 的条目一律视为未核实。
- 与 `docs/ARCHITECTURE.md`（现状手册）分工：那边写「现在是什么样」，这里写「哪里还旧、旧在哪、怎么算修完」。

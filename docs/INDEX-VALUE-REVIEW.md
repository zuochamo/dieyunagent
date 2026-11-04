# 代码索引 / 结构索引：收益评估与整改清单

> 评估日期：2026-10-29 · 样本：本机 `%APPDATA%/dieyunagent/codebase-index.sqlite`（29 个工作区）+ 7 天工具遥测
> 相关：`docs/VECTOR-SEARCH.md`（向量边界）、`docs/ARCHITECTURE.md` §15（索引实现）、`issue/2026-10-28-read-queries-share-resident-conn.md`（长读争用事故）
> 本页只做两件事：**给「这两个设计值不值」一个可复核的结论**，并把结论落成**可执行的减法清单**。所有建议默认服从 `AGENTS.md` 原则 2（减法优先）：能删就不加，删不掉必须写明理由。

---

## 0. 结论（先看这七条）

1. **代码索引是这两者里唯一的重资产，也是唯一该被削的**：库体 1056 MB，其中 trigram 倒排 40%（426 MB）、向量 33%（344 MB）；图只占 7%。
2. **代码索引最贵的那一半（trigram FTS）与既有 `grep` 工具功能重叠，且新鲜度更差** → 删除本地词法通道（R2，已落地）。
3. **向量通道不是伪需求，但不该默认建**：中文自然语言提问确有增益（Cursor 自评 +12.5%、SWE-QA 65.2% vs 46.2%），代价是首建要跑 embedding + 库体 1/3 → 改为显式 opt-in（R3，已落地）。
4. **结构索引里只有 `repo_map` + 符号/import 表值得常驻**（9.8 MB，每轮注入 ≤4500 字符换全局骨架）；**调用图 391k 行 / 65 MB 服务了 7 天里 1 次 `graph` 调用** → 按需建（R5，已落地）。
5. **实测使用率**：7 天 8345 次工具调用中，`codebase_search` 4 次（0.05%）、`graph` 1 次、`lsp` 3 次；`read_symbol` 101 次（结构索引的真实消费者）；`host_exec`/`grep`/`fs_read_file` 才是主力。
6. **流行度**：语义索引已从「默认必备」降级为「可索引只读问答的加速器」（Anthropic 已撤、Cursor 仍用、AAAI 2026 关键词 agent 达 RAG 94.5% 忠实度）；结构化 repo map 仍在（aider 一脉 + LSP 符号工具 + code-graph MCP），但从未是编辑型 agent 的主流默认。**结论：设计没过时，默认值过时了。**
7. **但比默认值更致命的是「接线」**：7 天 947 次请求快照里【相关代码】注入 **0 次**、【仓库结构图】注入 **0 次**（同期【项目地图】884 次正常）。原因是注入判定 `injectCode` 要求用户**先点名文件/选中代码/打 `@Codebase`**，而这只在「已经有了目标文件」时成立——索引恰好在它唯一有用（用户不知道文件在哪）的时候不触发。**所以本轮真正的修复不是删，而是把触发条件从「是否有路径」换成「这轮是否要碰代码库」（R8）。**

### 0.1 实施状态（2026-10-29 已全部落地）

| 项 | 状态 | 落点 |
|---|---|---|
| R4 增量默认关 | ✅ | `src/model-settings.js`（`codebaseAutoIncremental=false`，`graphAutoIncremental` 仍默认为 `true`）、`src/index/codebase-incremental-scheduler.js`（无向量不维护、busy 不排重试）、`src/renderer/index.html`、`test/unit/incremental-index-dedupe.test.cjs` |
| R2 删 trigram FTS | ✅ | `crates/dieyun-core/src/index/schema.rs`（`SCHEMA_VERSION=4`，迁移只做 `DROP`）、`index/search.rs`（词法只剩子串通道，双路 RRF） |
| R3 向量 opt-in | ✅ | `index/mod.rs` / `index/remote.rs`（`vectors` 请求参数）、`rpc/mod.rs`、`src/gateway/handlers/codebase.js`、`src/gateway/rpc.js`、面板「建向量」按钮、CLI `--vectors` |
| R3 补丁：向量生命周期 | ✅ | `index/mod.rs`（`vectors=false` 不再 `DELETE FROM chunk_vectors`；`embedding_model/dims` 沿用库里真实存在的向量）、`index/remote.rs`（`vector_count` 取库里实数、签名不归零）、`rpc/mod.rs`（`vectors:true` 且端点未配置 → `EMBEDDING_NOT_CONFIGURED`）、`src/index/codebase-incremental-scheduler.js`（增量带 `vectors:true`，只在已有向量时跑）、`renderer-utils.js:describeVectorSync`（覆盖不足要提示）、面板「建向量」改走增量补齐；用例 `index::tests::rebuild_without_vectors_keeps_existing_vectors` / `vectors_available_follows_embedding_config` / `test/unit/vector-sync-label.test.cjs` / `test/unit/incremental-index-dedupe.test.cjs` |
| R5 调用图按需 | ✅ | `graph/build.rs`（`GraphScope::Structural \| WithCalls`）、`graph/mod.rs`、`rpc/mod.rs`（`calls` 参数）、`src/gateway/handlers/graph.js`（`callers`/`callees`/`lsp_resolve` 首次自动补建一次）、`test/unit` + 新增 Rust 用例 |
| R7 删死代码 | ✅ | `src/gateway/rpc.js`（`tryRemoteGrepFallback` / `formatGrepMatchesAsSearchResults` 已删）、`src/agent/context-signals.js`（模式文案读真实字段） |
| R8 修注入接线 | ✅ | `src/agent/context-signals.js:shouldAutoCodebaseSearch`（不再依赖 `shouldInjectCodeContext`）、`src/agent/system-prompt-prep.js`（`allowCodebase` 独立于 `injectCode`、`repo_map` 去路径前置）、`src/renderer/renderer-agent-system-message.js`、`src/renderer/agent/agent-bundle-entry.js`（`shouldAutoCodebaseSearch` 进 compat） |
| R1 加固 repo_map | ✅ | `scripts/test-system-prompt-prep.cjs:runRepoMapInjection`（无 `injectCode` 也取骨架、字符预算截断、必有「枢纽文件/关键符号」） |
| 界面合并（R8 之后） | ✅ | 侧栏两个页签（代码索引 / 结构索引）合并为一个「索引」页签：两个区块各自带状态摘要与重建按钮，一个搜索框同时查片段 + 符号。外壳 `src/renderer/renderer-index-panel.js`，护栏 `scripts/check-renderer-index-panel.cjs`（rail/pane 页签唯一性 + 面板 JS 引用的 DOM id 必须存在） |

细节见 §6 各项；R6（三个月后复核）仍未到点。

---
## 1. 现状：两个索引各自是什么

| | 代码索引（`codebase.*`） | 结构索引（`graph.*`） |
|---|---|---|
| 产物（v4 后） | `chunks` + `chunk_vectors`（int8，opt-in） | `graph_symbols` / `graph_imports` / `graph_file_mtime` 常建；`graph_calls` 按需 |
| 建库 | Tree-sitter 切块（失败回退行窗）→ 写 `chunks`；向量只在本次请求显式要时写 | Tree-sitter 抽符号/import（+调用，仅 `WithCalls`）→ 收尾按「同文件 → import 目标 → 全库唯一同名」解析调用边 |
| 查询 | 向量余弦 / 子串 `LIKE` 两路 RRF(k=60) 融合（trigram FTS 已于 R2 删除） | `symbol_search` / `module_deps` / `repo_map` 常驻；`callers` / `callees` / `impact` 需调用边 |
| 出口 | `codebase.search`（工具 `codebase_search`）+ prep 自动注入块 | 工具 `graph` + prep 注入 `【仓库结构图】` + `read_symbol`/`lsp` 的本地回退 |
| 增量 | `src/index/codebase-incremental-scheduler.js`（**默认关**，且无向量时直接不跑） | `src/graph/graph-incremental-scheduler.js`（默认开：便宜，且 `repo_map` 要新鲜） |
| 单一来源 | Rust `crates/dieyun-core/src/index/`（schema/search/vector_pool/walker） | Rust `crates/dieyun-core/src/graph/`（build/query/extract） |
| 界面入口 | 侧栏「索引」页签的上半区（`codebase-panel-*`） | 同一页签的下半区（`graph-panel-*`）；试搜框是一个，同查两路 |
| 触发（v4 后） | 本轮「要碰代码库」即允许：`@Codebase` / 消息内路径 / 编辑器选区 / **结构信号下的自动检索** | 同上（`allowCodebase`），不再要求用户先点名文件 |

关键常量（`src/agent/agent-limits.js`）：`codebaseAutoLimit=12`、`codebaseMentionLimit=16`、`codebaseSnippetMax=2400`、`graphRepoMapLimit=32`、`graphRepoMapMaxChars=4500`。

---

## 2. 实测成本（本机，2026-10-29）

### 2.1 磁盘

| 对象 | 体积 | 占比 | 备注 |
|---|---|---|---|
| `chunks_fts_data`（trigram） | 425.6 MB | 40.3% | 相对正文 192.9 MB 放大 ≈ 2.2×（`ARCHITECTURE.md` 小样本口径 4.7×）；**v4 迁移已 DROP，此项为历史基线** |
| `chunk_vectors`（int8） | 343.5 MB | 32.5% | 115,042 chunk / 33,099 向量 |
| `chunks`（正文） | 192.9 MB | 18.3% | 平均 chunk 1100 字符 |
| `graph_calls` + 3 索引 | 64.7 MB | 6.1% | 391,401 行 |
| `graph_symbols` / `graph_imports` | 9.8 MB | 0.9% | 54,128 符号 / 17,916 边 |
| **`codebase-index.sqlite` 合计** | **1056.4 MB** | 100% | 29 个工作区 |

### 2.2 查询延迟（都不是瓶颈）

| 操作 | 实测 | 口径 |
|---|---|---|
| FTS `match "工具调用"` | 1.2 ms | 10,846 chunk（`E:\dieyunagent`） |
| FTS `match "sandbox"` | 2.8 ms | 同上 |
| FTS `match "配置"`（2 字中文） | **0 命中** | trigram 物理下限，改走 `LIKE` |
| `LIKE '%配置%'` 全表扫 | 19.8 ms（192 命中） | 同上；74k chunk 仓按线性外推 ≈ 140 ms |
| `graph.repo_map` | 198 ms 热 / 1.9 s 冷 | `issue/2026-10-28` 修复后 |
| 向量全量扫描 | ≈350 ms @114k chunk 768 维 | `ARCHITECTURE.md` §15.1 |

> 说明：延迟从来不是这套设计的问题。把它当「慢」去优化是打错靶子；成本在**磁盘、首建时间、注入 token、维护噪音**。

### 2.3 Token（真正的每轮成本）

| 注入块 | 上限 | 触发条件 |
|---|---|---|
| `【相关代码】/【Codebase 检索】` | `12 × 2400` 字符（`@Codebase` 时 `16 × 2400`）≈ 最高 9k token | 结构信号：`@Codebase` / 消息内路径 / 编辑器选区 / artifact / **结构信号下的自动检索**（`src/agent/context-signals.js`） |
| `【仓库结构图】`（repo_map） | 4500 字符 ≈ 1–2k token | `allowCodebase`（含自动检索）且图已就绪 |

### 2.4 维护噪音

- `main.log` 出现 `[codebase] incremental index skipped: still busy after 60 retries` —— 60 次重试后放弃，属「用重试层绕失败」，违反原则 2。
- 结构索引长事务曾把 `codebase.status` 打到 45 s 全量超时（`issue/2026-10-28-read-queries-share-resident-conn.md`）。
- 默认值：`codebaseAutoIncremental=true` / `graphAutoIncremental=true` / `embeddingEnabled=true`（`src/model-settings.js:52-53` 与 `:46`）——**三个重活默认全开**。

---

## 3. 实测收益（本机，7 天 8345 次工具调用）

| 工具 | 次数 | 成功率 | 归属 |
|---|---|---|---|
| `host_exec` | 4922 | 98% | 通用 |
| `fs_read_file` | 704 | 99% | 通用 |
| `fs_write_file` / `fs_edit` | 583 / 578 | 100% / 85% | 通用 |
| `grep` | 526 | 99% | **实际承担了「找代码」** |
| `glob` | 118 | 100% | 通用 |
| `read_symbol` | 101 | 72% | **结构索引/LSP 的真实消费者** |
| **`codebase_search`** | **4** | 100% | 代码索引 |
| **`lsp`** | **3** | 67% | LSP + 结构索引 |
| **`graph`** | **1** | 100% | 结构索引 |

口径提醒：

- 遥测只记**工具调用**，不记 prep 自动注入（路径/选区触发的 `codebase.search` 与 `repo_map` 走 RPC，不进 `tool-telemetry.jsonl`）→ 真实调用次数高于此表，但「模型主动想起来用索引」这件事，上表就是答案。
- 该样本 7 天、单机、以本仓 + 若干业务仓为主，不能外推到「所有用户」。

---

## 4. 拆成四个能力分别定级

| 能力 | 不可替代性 | 成本 | 新鲜度 | 定级 |
|---|---|---|---|---|
| **trigram 全文（FTS）** | 低：与 `grep` 工具重叠；`grep` 直读文件系统，永远不旧 | 库体 40%（426 MB） | 落后一轮增量 | **删默认通道（R2）** |
| **向量语义（chunk_vectors）** | 中：中文自然语言 / 标识符未知 / 跨语言确有增益；本仓覆盖率 100%（外部 embedding 端点，bge-base-zh 768），但 74k chunk 的大仓 0 向量（半残）；内置 ONNX 推理已删除 ⇒ 不配端点即 0 向量 | 库体 33% + 首建 embedding 墙钟 | 落后一轮增量 | **保留，显式 opt-in（R3）** |
| **符号 + import 图** | 高：`repo_map` 骨架、`find_symbol`、远程无 LSP 时的定位兜底 | 9.8 MB，便宜 | 同轮增量 | **保留（R1）** |
| **调用图（graph_calls）** | 中：`callers/callees/impact`「改一处影响哪」，但 LSP 更准 | 65 MB + LSP enrich 后台任务 | 需 LSP 补强 | **按需建（R5）** |

---

## 5. 是否还流行（外部证据）

### 5.1 代码索引 / 语义检索：默认地位已翻转

- **唱衰侧**：Anthropic 于 2025-05 从 Claude Code 移除向量管线（embedding、本地向量库、切块启发式全删），换 `grep`，作者称 "outperformed everything, by a lot"；Windsurf / Cline / Devin / Sourcegraph Amp 相继转工具驱动检索；AAAI 2026《Keyword Search Is All You Need》测得纯关键词 ReAct agent 达 RAG **94.5%** 忠实度、**91.5%** 答案正确性。综述见 [dbaplus：向量数据库凉了？](https://dbaplus.cn/news-160-7481-1.html)。
- **支撑侧**：Cursor 2026-01 仍以语义索引为主打，自评**平均 +12.5% 回答准确率**，并用 Merkle 树 + 团队索引复用把「首查时间」压到秒级（[secure-codebase-indexing](https://cursor.com/de/blog/secure-codebase-indexing)）；[arXiv 2608.01507](https://browse-export.arxiv.org/abs/2608.01507)（2026-08，SWE-QA）实测**语义检索 65.2% vs 深度 agentic 检索 46.2%，且单题成本不到一半**，并指出 agentic 检索最大失败模式（41.8%）发生在 planner→subagent 交接处且**静默出错**。
- **判定**：不是「过时」，是「从默认掉到可选」。它成立的前提有两条硬约束——**增量足够便宜**（内容哈希/Merkle，不重跑全库）与**新鲜度可接受**。本仓两条都踩了（每次保存都触发增量、常驻连接争用），所以低使用率不能全赖设计。

### 5.2 结构索引 / repo map：一直活在少数派

- 仍在用的三类：aider 式 repo map（rank 裁剪后注入）、LSP 符号级工具（定义/引用/诊断）、以及一批 code-graph MCP 服务。
- 在编辑型 agent 里它始终是**辅助位**：Claude Code 连向量都撤了，也没引入调用图，改用 `Explore` 子代理 + Grep。
- **判定**：`repo_map` 这种「压缩骨架」是低成本高杠杆，值得留；「全量调用图常驻」是重资产轻使用，该收。

---

## 6. 整改清单（R1–R5 + 顺带发现的 R7、R8）

执行顺序：**R4 → R2 → R7 → R3 → R5 → R1 + R8**（先止血、再减重、最后修接线并加回归护栏）。R6 是三个月后的复核判据，不在本轮执行。

### R4 关闭「保存后自动增量」默认值

| 项 | 内容 |
|---|---|
| 问题 | 每次保存触发一次增量建库，`main.log` 里出现 60 次重试后放弃；这是「用重试绕失败」 |
| 动作 | `codebaseAutoIncremental` 默认改 `false`；改为**会话内首次 prep 需要时触发一次**（复用 `index.start` 的 `skipIfReady`），面板仍可手动开。**`graphAutoIncremental` 保留默认 `true`**（有意偏离初版方案：图增量只做 mtime 比对 + 单文件重解析，代价小，而 `repo_map` 的新鲜度直接决定注入骨架对不对；关掉它省不到钱却会让骨架过期） |
| diff 面 | `src/model-settings.js:52-53`（默认值）+ `:200-201`（归一化 `!== false` 保留）、`src/index/codebase-incremental-scheduler.js:57`、`src/graph/graph-incremental-scheduler.js:58`、`src/renderer/index.html:1410-1412`（默认勾选态文案）、`docs/ARCHITECTURE.md` §15 |
| 验收 | 连续编辑 20 个文件 → `main.log` 零 `incremental index started (save)`；无 `still busy after 60 retries`；面板手动「重建」仍可用 |
| 测试 | `npm run test:unit`（`test/unit/incremental-index-dedupe.test.cjs`）、`npm run test:local-gateway-smoke` |
| 回滚 | 纯默认值改动，改回 `true` 即可 |

### R2 删除本地 trigram FTS 词法通道

| 项 | 内容 |
|---|---|
| 问题 | 426 MB（40%）买一个与 `grep` 重叠、且落后一轮增量的能力；2 字中文仍要走 `LIKE` 全表扫 |
| 动作（方案 A，推荐） | `SCHEMA_VERSION 3 → 4`：迁移里 `DROP` 三个触发器 + `DROP TABLE chunks_fts`；`search.rs` 删 `lexical_hits`，词法只剩 `substring_hits`（放宽为「对切词后的每个词各跑一次 `LIKE`」，不再只限 2 字术语）；RRF 降为「向量 + 子串」两路 |
| diff 面 | Rust：`crates/dieyun-core/src/index/schema.rs`（版本+迁移+触发器+测试）、`index/search.rs`（`lexical_hits` / `fts_query` / `fuse` / `empty_result` / `hit_line_from_highlight`）、`index/mod.rs`（`codebase.status` 若有 FTS 相关字段）<br>Main：`src/gateway/handlers/codebase.js`（错误文案「请稍后再试或使用 grep/读文件」保持）、`src/gateway/rpc.js`（`phase` 文案）<br>Renderer：`src/renderer/renderer-codebase-panel.js:245`（模式文案）、`src/renderer/index.html:1693-1695`（帮助文案）<br>文档：`docs/ARCHITECTURE.md` §15.1、`docs/VECTOR-SEARCH.md` §1 |
| 为何不新增兜底 | `grep` 工具（`src/gateway/rg-search.js`）已在用 526 次/周，**它就是唯一来源**；不要复活已经死掉的 `tryRemoteGrepFallback`（见 R7） |
| 风险（必须在验收里量化） | 中文 3 字以上从「bm25 排名」降为「子串命中按 chunk id 排序」，**召回不降、排序变差**；74k chunk 仓每次 `LIKE` ≈140 ms |
| 保守替代（方案 B） | 只把分词器 `trigram → unicode61`（trigram 索引全部三字滑窗，unicode61 只索引词元，预计省 70–85% FTS 体积**待实测**；中文词法失效由 `LIKE`/`grep` 承担），代码结构不动，diff 面最小 |
| 决策规则 | 方案 A 验收时若 74k chunk 仓 P95 > 200 ms，或 `codebase.search` 词法召回在 5 个真实查询上低于方案 B → 退方案 B |
| 测试 | `npm run cargo:test`（新增迁移测试 + 现有 `search` 用例）、`npm run test:local-gateway-smoke`、`npm run verify:rpc-catalog`（若 `codebase.status` 字段有增减）、`npm run test:unit` |

> 索引库是派生产物，**删库可无痛重建**——这是本次整改里唯一「删错了也能恢复」的一类改动，风险最低。

> **派生也会派生垃圾（2026-11-04 补）**：`workspaces` 行会随项目目录一起「变成孤儿」——目录删了、行还在，而 `status` / `search` 第一步就是 `resolve_workspace`，路径不存在直接返回 `INVALID_WORKSPACE`，**根本走不到那一行**去清它（实测一条已删项目留了 53,538 段区段）。所以 `IndexService::from_config` 在起动时调 `prune_missing_workspaces()`：**本地根目录确实消失（卷根还在）**就删掉它的 `chunks` / `chunk_vectors` / `graph_*` / `workspaces` 行；候选集取 `workspaces` 与 `graph_workspaces` 的**并集**（只建过图谱、索引后被重置的仓库只在后者留痕，实测 9 个这样的孤儿挂着 5,100 条调用边）；两类一律跳过 —— 远端工作区（`ssh://` 的 key 不是本地路径，本地看不看得见与它的数据无关）与**整卷离线**（移动盘没插、`F:\` 本身不存在）。后者的「看不见」是暂时的，删了等于让用户插回盘后白重建几小时向量。用例：`prune_missing_workspaces_drops_rows_of_deleted_dirs_only`、`prune_keeps_remote_keys_and_offline_volumes`。

### R3 向量通道改为显式 opt-in

| 项 | 内容 |
|---|---|
| 问题 | `embeddingEnabled` 默认 `true`，建库即跑 embedding（首建墙钟 + 344 MB），而模型主动用 `codebase_search` 4 次/周；大仓还常年停在「chunk 有、向量 0」的半残态 |
| 动作 | 建库默认只写 `chunks`（不写向量）；向量只在显式请求 `vectors: true` 时建：面板「建向量」按钮、CLI `--vectors`、以及任何显式传 `vectors` 的 RPC 调用方（`@Codebase` 与 prep 自动建库**不**带，见 §8 的取舍说明）。已存在向量照常可用 |
| diff 面 | Rust：`crates/dieyun-core/src/index/mod.rs`（`use_vectors = self.embedding.enabled()` 的判定改为「配置启用 **且** 本次请求要求向量」）、`index/schema.rs`（`vector_count` 语义不变）、`crates/dieyun-core/src/embedding/`（`EmbeddingConfig::enabled` 不动，勿改语义）<br>Main：`src/gateway/rpc.js:667-682`（configure payload 增加「本次是否建向量」）、`src/gateway/handlers/codebase.js`（`codebase.index.start` 透传）<br>Renderer：`renderer-codebase-panel.js`（「建向量」按钮 + 未建提示）、`src/renderer/index.html:1694-1695`<br>文档：`docs/VECTOR-SEARCH.md` §1/§2、`docs/ARCHITECTURE.md` §15.1 |
| 为何删不掉（保留理由） | 只有向量通道能回答「中文自然语言 + 不知道标识符」的查询（`LIKE` 只能字面、`grep` 要求你已知关键词）；`docs/VECTOR-SEARCH.md` §4 的换 ANN 触发条件也只在保留通道时才有意义 |
| 为何不新增开关字段 | 原判：不新增独立配置项：请求参数即「本次意图」，面板按钮与 `@Codebase` 都走同一个 `codebase.index.start`（单一来源），开关不进 `agent-limits`。**2026-10-31 修正**：新增 `indexSemanticSearch`（`src/model-settings.js`）——因为在「每会话一份索引库」下手点按钮根本不可用，见下方「R3 后续修正」 |
| 验收 | 新建工作区 → 建库后 `codebase.status.vector_count = 0` 且不报错；`@Codebase` 一次后向量补满；`codebase.search` 在无向量时返回词法结果且 `vectorSearch=false` |
| 测试 | `npm run test:unit`（`test/unit/vector-index.test.cjs`）、`npm run test:local-gateway-smoke`、`npm run cargo:test` |

#### R3 后续修正（2026-10-31）：opt-in 不是「默认关向量」，而是「别每次重算」

opt-in 落地后发现一个设计错误：在**每会话一份索引库**（SSH worktree）的场景下，
「要向量就手点一次」等于**永远没有向量**——每开一个会话都是空库。实测 `codebase_search`
4 次/周里有相当一部分是「库刚建、向量还没有」，而 0 命中又被静默成空串（见
`docs/SSH-INDEX-COLD-START-PLAN.md` §0.5）。两处修正：

1. **意图持久化**：设置项 `indexSemanticSearch`（`src/model-settings.js:resolveIndexVectorsIntent`），
   打开后 agent / prep 的每次建库都带 `vectors: true`，不再依赖手点面板。
2. **内容哈希复用**：`<data_dir>/vector-cache.sqlite`（`crates/dieyun-core/src/index/vector_cache.rs`），
   同签名下同一段代码只算一次向量，跨 worktree / 跨会话命中（见 `docs/VECTOR-SEARCH.md` §1.2）。
   没有这一条，上面那个开关在日常使用里就是「每个新会话等一次全仓 embedding」。

R3 的成本判断不变（向量确实贵），变的是「贵」不该由**重复计算**来承担。R6 复核判据里
「`codebase_search` 使用率」这一条也因此加了先决条件（见 §7 开头）。

### R3 补丁：`vectors=false` 不再等于「清空向量」

R3 把向量从「配置项」改成「请求参数」后，`run_index` 里那句 `if !use_vectors { DELETE FROM chunk_vectors ... }` 从「几乎不会走到」变成「最常见的路径」：面板「重建片段」、增量建库、prep 首次建库、裸 `codebase.index` 调用全都不带 `vectors`。后果是用户点「建向量」跑完几分钟、一次「重建片段」或一次保存就清零，面板回到「0（子串检索）」——**用户因此得出「向量没用」的结论，而实际从来没活过一轮**。

| 项 | 内容 |
|---|---|
| 问题 | 「这次不要向量」被实现成「这个工作区不要向量了」：本地物理删 `chunk_vectors`；远程把 `workspace.embedding_model` 写 NULL、`vector_count` 写本批条数（增量时=0） |
| 根因 | 请求参数承载的是**本次意图**，而代码把它当成**持久状态**。同一处代码里 `force` 全量重建（chunk id 全换）与签名变更（维度不兼容）才是真正必须清空的两种场景 |
| 动作 | 删掉 `!use_vectors` 的 DELETE 分支；`model_changed` 的删除保留（否则新旧维度混库）。本地/远程都改成「元数据描述库里真实存在的向量」：`vector_count == 0` → `(None, 0)`，本次建了 → 用当前签名，本次没建但库里有 → **沿用旧签名与维度**。远程 `vector_count` 直接查库（`super::count_vectors`），不再累加本批 |
| 附带 | `vectors: true` 但 embedding 端点没配（`model`/`base_url` 空或被禁用）时，RPC 直接返回 `EMBEDDING_NOT_CONFIGURED`，而不是静默跑一次「只建片段」让用户以为建好了 |
| 增量 | `codebase-incremental-scheduler` 对「已建过向量」的工作区增量时带 `vectors: true`（此前只在 `vectorCount > 0` 才跑增量、却不带向量：按文件删旧 chunk 时向量一起没，改过的文件从此只有子串召回 —— 日志承诺「增量接管」，代码却在让覆盖率单向下滑） |
| 面板 | `describeVectorSync` 增加覆盖度判定：`vectorCount < chunkCount` 说明增量重建过文件却没带向量，那部分只能靠子串召回 —— 以前显示「与当前设置一致」，等于把半残说成正常。同时「建向量」改为增量（`force: false`）：只补缺向量的 chunk（签名变了才整库重算），不再为了补几个文件也全量重切+重嵌 —— 那条路径太贵，等于没人点，覆盖率只会往下掉 |
| 验收 | 建过向量的工作区跑一次「重建片段」→ 面板向量数不变、`vectorSearch=true`；未配 embedding 点「建向量」→ 明确报错；`vectorCount < chunkCount` 时面板出现「仅覆盖 N/M 段」 |
| 测试 | `cargo test -p dieyun-core --lib`（新增 `index::tests::rebuild_without_vectors_keeps_existing_vectors`：把 DELETE 分支加回去该用例立刻红，`left: 0, right: 1`；另加 `vectors_available_follows_embedding_config`）、`test/unit/incremental-index-dedupe.test.cjs`（断言增量带 `vectors: true`）、`test/unit/vector-sync-label.test.cjs`（覆盖度文案 7 例） |

### R5 调用图改为按需构建

| 项 | 内容 |
|---|---|
| 问题 | `graph_calls` 391k 行 / 65 MB，服务 7 天 1 次 `graph` 调用；建它还要 LSP enrich 后台任务 |
| 动作 | `graph.index` 默认只建 `symbols + imports + file_mtime`（够 `repo_map` / `symbol_search` / `module_deps`）；`callers` / `callees` / `impact` / `lsp_callers` 命中空表时，用**已有的** `autoIndex` 参数触发一次局部 calls 构建 |
| diff 面 | Rust：`crates/dieyun-core/src/graph/build.rs`（拆分 build scope：`symbols+imports` / `+calls`）、`graph/mod.rs`（`graph.index.start` 参数）、`graph/query.rs`（`callers/callees/impact` 在 calls 缺失时返回既有的「未就绪」语义，勿新增错误码）、`graph/schema.rs`（表结构不变）<br>Main：`src/gateway/handlers/graph.js:19-37`（`graph.index.start` / `graph.index` 透传 scope；`123/136/149` 的 `autoIndex` 保持）<br>Agent：`src/agent/tool-catalog.js` `GRAPH_TOOL` 描述补一句「callers 首次可能触发一次建边」<br>Renderer：`renderer-graph-panel.js`（状态行区分「符号已建 / 调用边未建」） |
| 唯一需新增的参数 | `graph.index.start` / `graph.index` 增加 `calls: boolean`（缺省 `false`）。**为何删不掉**：调用边的产物量级（65 MB / 391k 行）与触发频次（1 次/周）相差 5 个数量级，必须可选；它不进 `agent-limits`，也不是「绕过失败」的开关，而是构建范围本身。实现形态是 Rust 内部的 `GraphScope::Structural \| WithCalls` 枚举，RPC 只做布尔映射（`rpc/mod.rs:graph_scope_from_params`），不引入配置字段 |
| 实现要点 | ①`graph/build.rs` 的 `index_file` 在 `Structural` 下直接跳过调用抽取与 `backfill_unique_callees`；②**补建必须重解析未变文件**：`calls_missing = scope.with_calls() && !force && call_count == 0` 时禁用 mtime 跳过，否则「按需建调用图」在增量模式下永远抽不到边；③`handlers/graph.js` 的 `callers`/`callees`/`lsp_resolve` 在 `indexed && callCount===0` 时自动发起一次 `calls: true` 构建并返回 `GRAPH_INDEXING_IN_PROGRESS`（提示稍后再试），不新增错误码 |
| 验收 | 新建工作区 → `graph.status` 报 `symbol_count>0 && call_count=0`；`repo_map`/`symbol_search` 正常；`callers` 首次调用后 `call_count>0`；`graph.lsp_enrich` 不再默认后台跑 |
| 测试 | `npm run cargo:test`、`npm run test:local-gateway-smoke`、`npm run test:lsp`（回退链）、`npm run verify:rpc-catalog` |

### R7 删掉已死的 grep 兜底与误导性判定（本轮顺带发现）

| 项 | 内容 |
|---|---|
| 问题 | `src/gateway/rpc.js:1205 tryRemoteGrepFallback` **全仓零调用**（`formatGrepMatchesAsSearchResults:1187` 仅被它使用）；`src/agent/context-signals.js:58` 判断 `data.grepFallback`，但没有任何生产者写这个字段（远端返回的是 `source`），注入块标题会恒走「全文/词元」分支 |
| 动作 | 删 `tryRemoteGrepFallback` + `formatGrepMatchesAsSearchResults`（约 40 行）；`formatCodebaseBlock` 的模式判定改为读实际存在的字段（`vectorSearch` / `source`），或直接删掉该行 |
| diff 面 | `src/gateway/rpc.js`、`src/agent/context-signals.js:58` |
| 为何不做 | 不要为「远端没索引」补一条 grep 兜底：`grep` 工具本身就是那条路，补丁只会再造一个第二来源 |
| 验收 | `npm run check:js` 通过；远端（SSH）`codebase.search` 未建库时仍抛 `INDEX_REQUIRED`，错误文案指向 `grep` |
| 测试 | `npm run test:unit`、`npm run test:local-gateway-smoke`、`npm run test:agent` |

### R1 保留并加固 `repo_map` 注入（唯一保留项）

| 项 | 内容 |
|---|---|
| 动作 | 不动实现，只做三件事：①在 `docs/ARCHITECTURE.md` §15.2 写明「repo_map 是结构索引的保留理由」；②给注入块加断言（≤`graphRepoMapMaxChars`，且含「枢纽文件/关键符号」段）；③把 `repo_map` 的规模护栏测试保留在改动清单里（防止再次出现 O(符号×调用)） |
| diff 面 | `docs/ARCHITECTURE.md`、`scripts/test-system-prompt-prep.cjs`（断言） |
| 为什么必须留 | 它是唯一用 ≤1–2k token 换来「全局骨架 + 枢纽 + 模块边 + 循环依赖」的通道；`grep`/`read_file` 结构上无法回答「这个仓库长什么样、哪里是枢纽、有没有环」 |
| 测试 | `npm run cargo:test`（`graph::query::tests::repo_map_*` 两条）、`npm run test:system-prompt-prep`（新增 `runRepoMapInjection`）、`npm run test:agent-system-prompt` |

### R8 修注入触发接线（本轮最重要的一项）

| 项 | 内容 |
|---|---|
| 问题（实测） | 7 天 947 次请求快照、33 个会话：【相关代码】注入 **0 次**、【仓库结构图】注入 **0 次**；同批快照里【项目地图 · AGENTS.md】884 次、【本轮上下文】775 次、【系统时间】正常。即**索引链路本身没坏，是根本没被触发** |
| 根因 | Renderer 的 `injectCode` = `@Codebase` \| 消息内含路径 \| 编辑器有选区 \| 有 artifact；`allowCodebase` 由 `injectCode` 派生；`fetchGraphRepoMapBlock` 又要求 `injectCode`。于是「用户已知文件在哪」时才检索——恰好是语义检索最没用的场景；用户说「这个项目的服务端入口在哪」时，全部关卡为 false |
| 动作 | ①`context-signals.js:shouldAutoCodebaseSearch()` 不再委托 `shouldInjectCodeContext`（那是「要不要把代码贴进上下文」的判定，语义不同），改为结构化信号：有工作区 + SSH 已连 + 查询长度 ≥4 + 无 `@Codebase` + 无打开文件/artifact；②`system-prompt-prep.js` 里 `allowCodebase = snapshot.allowCodebase ?? (injectCode \|\| autoCodebase \|\| textHasCodebaseMention(query))`；③`fetchGraphRepoMapBlock` 的门从 `if (!injectCode)` 改为 `if (!injectCode && !allowCodebase)`；④`shouldAutoCodebaseSearch` 进 renderer bundle 的 `compat` 名单，Renderer 侧用同一个判定（否则两侧漂移，索引又会 0 次被用到） |
| 为何不是「新开关」 | 没有新增配置项、没有新增意图词表。判定只喂结构信号（工作区/连接/查询形态/显式 `@Codebase`/打开文件），符合 `AGENTS.md` 原则 3；「是否检索」这件事仍然只有一份实现 |
| 验收 | 打开任意仓库，问一个不含路径、不含文件名的自然语言问题（如「服务端入口在哪」）→ 请求快照里出现【仓库结构图】（`repo_map` 已就绪时）或 `codebase.search` 调用；点名文件的轮次行为不变 |
| 测试 | `npm run test:system-prompt-prep`（`runRepoMapInjection` 断言「无 `injectCode` 也要取 repo_map」）、`npm run test:unit`、`npm run check:js`、`npm run check:renderer` |

---

## 7. R6 Revisit 判据（3 个月后执行）

> ⚠️ **2026-10-31 更正：第 1 条不能按现在的 0.06% 触发。** 那个数字被三处缺陷压成了 0，
> 不是「语义检索没价值」的证据：
> ① 向量只有「面板手点建向量」一条触发路径，agent/prep 建库固定 `vectors:false`，
> SSH 每会话一份索引库 ⇒ 实际上永远 0 向量；
> ② 没有向量时词法通道是纯子串 `LIKE`（`index/search.rs:275`），中文问句整句就是一个词元
> ⇒ 必然 0 命中，而命中为空时 `formatCodebaseBlock` 直接返回 `''`，模型看到的是
> 「这个仓库里没有相关代码」；
> ③ SSH 会话冷库 + prep 每轮跳过，「索引从未建成过」被 UI 画成一行永远的「创建中」。
> 现在 ①已修（`model-settings:indexSemanticSearch` 持久意图 + `resolveIndexVectorsIntent`）、
> ②已改为「0 命中必须说清是哪种 0」、③已改为「首建只 kick 一次 + 可诊断文案」。
> **复核前的先决条件**：向量开关打开、`codebase_search` 的成功率与非空命中率、注入块非空率
> 都进入统计口径（见 `docs/SSH-INDEX-COLD-START-PLAN.md` §0.5 与 §6）。
> 用「没通电的灯泡从没亮过」证明灯泡没用，是本次最容易犯的错。

3 个月后（≈2027-01-29）用同一套口径复核，满足任一条即执行「停用并删除」：

1. **在向量可用、注入非空的前提下**，`codebase_search` + `graph` 工具调用合计 **< 总调用 1%** → 删工具通道，只留 `repo_map` 注入；
2. 索引库体积 **> 2 GB** 或单仓 `codebase.index` 首建 **> 10 min** → 强制走 R2 方案 A；
3. 出现「索引滞后导致答错」的用户可见事故 ≥2 次 → 向量通道也降级为手动；
4. 反之，若向量 opt-in 后 `codebase_search` 使用率 **> 3%** 且成功率 >90% → 证明通道有用，可考虑恢复自动建向量（但**不**恢复 trigram）。

### 7.1 现在有地方看了：统计信息页「索引使用率」

复核判据要能执行，数字就得随手可见，否则又变成「凭感觉砍功能」。统计信息页新增
**「索引使用率」**，口径定义只有两处常量/函数，都在 `src/agent/tool-telemetry.js`：
`INDEX_TOOL_GROUPS`（哪些工具算索引工具）与 `describeIndexInjections`（注入那一半怎么算）。

| 分组 | 工具 | 为什么这么分组 |
|---|---|---|
| 代码索引 | `codebase_search` | 代码索引**唯一**的 Agent 出口（`codebase.status` 等是面板内部调用，不过工具闸门、不进遥测） |
| 结构索引 | `graph`、`read_symbol` | `graph` 查模块依赖 / 调用关系，`read_symbol` 是远端无 LSP 时的符号定位兜底 |

`grep` 与 `lsp` **不计入**：前者直读文件系统、恰恰是索引的替代品（算进来会让「索引没用」看起来像「索引在用」），
后者是语言服务器而非索引库。

窗口用**全量遥测文件**（2 MB 上限，约数千到数万次调用），不是「近 200 次」：用短窗口评估索引，
「刚建完索引的一次使用」会被放大成 50% —— 这正是 0.05% 那个数字的反向同类错误。
清单 + 占比 + 成功率 + 错误码都显示，`0 次` 如实写 `0`，不伪装成「无数据」。

实测（2026-10-31，本机 30 小时内 2234 次工具调用）：

| 分组 | 次数 | 占比 | 成功率 |
|---|---|---|---|
| 代码索引 | 0 | 0% | — |
| 结构索引 | 15（`read_symbol` 15，`graph` 0） | 0.7% | 33.3% |

两条必须一起记下的结论：

1. `codebase_search` **仍然是 0 次**。批次 1-6 修的是「索引建不起来 / 建了不生效」，
   没有改变「模型没有理由去用代码索引」这件事本身；本机会话里用户往往直接给了路径，`grep` 就够。
   所以 §7 第 1 条判据**先决条件仍未满足**，现在拿这个 0 去砍工具通道还是同一个错误。
2. **`read_symbol` 成功率只有 33.3%（10/15 是 `SYMBOL_NOT_FOUND`）**，且集中在一个会话的
   4 秒内连打 5 次 —— 形态更像「模型猜符号名」而不是「结构索引不可用」。
   **已按 §7.2 实测结案**：抽 20 个真实存在的符号，`read_symbol` 20/20 成功、路径全对；
   当时的失败是名字不存在，工具报 `SYMBOL_NOT_FOUND` 是正确行为。

#### 7.1.1 「只有一半口径」这件事本身是个缺陷（2026-11-03 补上）

上面那个面板只统计**工具调用**。但 prep 的**自动注入**（`repo_map` 的【仓库结构图】、
【相关代码】）走 RPC、**不进工具遥测**，于是「一直在注入、所以不必额外调工具」会被读成
「索引没人用」——面板自己那句「占比长期接近 0 说明触发链路或能力本身有问题」正好把人
引向「砍功能」。§7.5 就是这次误判的实测记录。

修法（不是加开关，是把缺掉的事实补上）：

| 项 | 落点 |
|---|---|
| 事实产生 | `src/agent/system-prompt-prep.js` → `indexAudit = { allow, code: 'explicit'\|'auto'\|null, repoMap }`（Main 是唯一知道「哪个块真的进了 turnHost」的人） |
| 事实搬运 | `src/renderer/renderer-agent-send.js`：`contextAudit.index` → `request_snapshots.context_audit_json.index` |
| 聚合 | `crates/dieyun-core/src/memory/snapshot.rs:count_index_injections` + RPC `memory.request_snapshot_index_audit`（**只数带 `index` 审计的轮次**，改造前的历史行另记 `total`，否则旧数据会被读成「一直没注入」） |
| 展示 | `src/agent/tool-telemetry.js:describeIndexInjections`（占比/空值口径唯一来源）→ `src/renderer/renderer-help.js`：面板下半区两行「注入 · 仓库结构图 / 注入 · 相关代码」 |
| 契约 | 聚合窗口用**工具遥测窗口的起点**（`since`），两个口径同一段时间；core 未就绪时返回 `null` → UI 写「不可用」，不画成 0 |


---

## 7.2 有效性实测：索引 vs 无索引基线（2026-10-31，真机真库）

上面 §7.1 只看「用了几次」。这一节回答另一半：**用起来到底准不准**。脚本
`scripts/verify-index-effectiveness.cjs`（`npm run` 之外的单跑脚本，需要 app 在跑 + 会话 id）：

```
DY_SESSION=<会话 id> DY_SSH_HOST=<远端主机> DY_SAMPLE=20 node scripts/verify-index-effectiveness.cjs
```

口径（不挑好答的）：

1. **走真 app 的真链路**：连本机网关（`ws://127.0.0.1:17330` + `gateway-token.txt`），只传
   `sessionId` 让 Main 自己解析会话根 —— 与工具调用同一条路；不手拼 `workspaceRoot`；
2. **题目从被测仓库机械抽样**：标识符题 = 345 个定义点里等距抽 20 个符号名；
   自然语言题 = 21 条中文注释里等距抽 10 条；
3. **每题都有 ground truth**（符号/注释所在文件），算 hit@1 / hit@5 / MRR；
4. **基线与索引打同一个分**：`ssh grep -rc | sort -rn | head -5`（无索引时 agent 的真实替代品）。

被测对象：`dieyuntools` 会话 worktree（239 文件 / 7204 片段 / **0 向量**：这台机器的
`embeddingEnabled=false`，语义通道根本不存在）。建库 1.1s，建结构索引 1.1s。

| 族 | 题 | 索引 hit@1 | 索引 hit@5 | 索引 MRR | 索引 p50 | grep hit@1 | grep hit@5 | grep MRR |
|---|---|---|---|---|---|---|---|---|
| 标识符（找定义） | 20 | 45% | 90% | **0.63** | 102ms | 75% | 95% | **0.84** |
| 自然语言（注释原文） | 10 | 90% | 100% | 0.95 | 114ms | 100% | 100% | 1.00 |
| 自然语言（去虚词改写） | 9 | 78% | 100% | **0.87** | 115ms | 0% | 0% | **0.00** |

读法：

- **「按名字找定义」索引比 grep 差**（0.63 vs 0.84）：索引按**命中词数**排序（`index/search.rs`
  分词子串，无 FTS 倒排），把「某文件里用了一次」的块也能排到前面；grep 按**出现次数**排，
  定义点天然分数高。这是排序口径差，不是覆盖率差（hit@5 90% vs 95%）。
- **「记得原话」grep 满分**（1.00），索引 0.95 —— 精确子串本来就是 grep 的主场。
- **「换个说法问同一件事」是索引唯一不可替代的收益**：去掉虚词后子串断开，grep 归零，
  索引仍有 0.87。注意这**不是语义**：它靠分词后逐词 `LIKE`，所以只能说「词袋子串」，
  真要跨同义词/概念还得配 embedding（当前这台机器没配）。
- **延迟**：索引 102-115ms vs grep 169ms；但 grep 那一侧含一次 ssh 往返，比较对 grep 不利，
  只能说明「索引不比 grep 慢」，不能当优势写。

结构索引（同一仓库）：

| 能力 | 结果 |
|---|---|
| `graph.status` | indexed，135 文件 / 2632 符号 / 20311 调用边 |
| `graph.symbol_search`（名 → 文件，前 3） | **19/20 命中** |
| `fs.read_symbol`（名 + filePath） | **20/20 成功**，路径全对 |
| `graph.callers`（3 个有真实调用者的符号） | 4 / 3 / 4 条调用点，符号正确定位 |

→ **§7.1 那个「`read_symbol` 成功率 33.3%」的怀疑可以结案了**：本次抽的 20 个**真实存在**的符号
全部一次成功。当时的失败是「模型报了一个不存在的名字」，工具回 `SYMBOL_NOT_FOUND` 是正确行为，
不是索引不可用。

**由此得到两条待办（不是本轮做）**：

1. **标识符查询应该先看符号表**：`codebase.search` 命中单一标识符时，用同库 `graph_symbols`
   的定义点（`rel_path` + `start_line`）把结果顶到前面。两条通道本来就是一份 `index.sqlite`，
   这是收敛到单一来源，不是加一层。
2. **配 embedding 才有语义**：不配的时候 `vectorSearch=false`，上面 0.87 只是分词子串的运气；
   概念类提问（「哪里处理退款审批流」这种不问原话的）只能靠向量。

### 7.3 第 1 条已落地：定义点通道（同一份库里的 `graph_symbols`）

`index/search.rs` 新增**通道 0**：查询是单一标识符（`_parse_ts` / `useEffect` / `Store.save`）时，
先把 `graph_symbols` 里 `name` / `qualified_name` 精确命中的定义行 JOIN 回覆盖它的 chunk，
按名次融进同一套 RRF。**没有新权重、没有新配置、没有新表**：定义点是结构索引早就写好的事实，
只是以前没人拿它排序。

同一批题、同一个库、间隔 30 分钟两次实测（`scripts/verify-index-effectiveness.cjs`，`DY_SAMPLE=20`）：

| 族 | 指标 | 改造前 | 改造后 | grep 基线 |
|---|---|---|---|---|
| 标识符 | hit@1 | 45% | **95%** | 75% |
| 标识符 | hit@5 | 90% | 95% | 95% |
| 标识符 | MRR | 0.63 | **0.95** | 0.84 |
| 标识符 | p50 | 102ms | 121ms | 169ms |
| 自然语言（原文） | MRR | 0.95 | 0.95 | 1.00 |
| 自然语言（改写） | MRR | 0.87 | 0.87 | 0.00 |

另外两族一分不差，符合预期：定义点通道只对「这个名字定义在哪」有意义。

**前提**：结构索引建过（`graph_symbols` 有这张工作区的行）。没建时这一路为空、行为与改造前
完全一致（有回归测试 `missing_graph_tables_is_not_an_error`）。这条前提要记住：
`codebase.search` 的「找定义」质量现在取决于结构索引建没建，而结构索引仍是按需构建（§R5）。

回归测试三条（`crates/dieyun-core/src/index/search.rs`）：
`definition_site_ranks_above_usage`（改造前必失败）、`multi_term_query_does_not_use_definition_channel`、
`missing_graph_tables_is_not_an_error`。

**本地工作区同样生效**（不走 app，直连 `target/release/dieyun-core.exe serve-stdio`，
脚本 `scripts/verify-index-definition-ranking-local.py`；把 `src/gateway` + `src/remote`
（61 文件 / 759 片段 / 568 符号）拷到临时目录当被测仓库，机械抽 15 个定义点当题）：

| | hit@1 | hit@5 | MRR |
|---|---|---|---|
| 索引 | 15/15 | 15/15 | 1.00 |
| grep | 14/15 | 15/15 | 0.97 |

（这个子集里每个名字基本只定义一次，属于偏容易的样本，只用来确认「本地这条路径也把定义顶到最前」，
不当成难度基准。）

### 7.4 第 2 条没做成，但查清了原因（2026-10-31）

这台机器**其实配了 embedding**（`text-embedding-qwen3-embedding-4b`，2560 维，
`http://192.168.31.62:5018/v1`），关着的是设置 →「代码索引语义检索」这个 opt-in 开关
（`indexSemanticSearch: false`，§R3 的设计）。试着按面板「建向量」的路径真开一次，结论是
**当前端点不具备可用吞吐**：

| 请求（输入 2 360 字符） | 耗时 |
|---|---|
| 1 条 | 53s |
| 8 条 | 90s |
| 32 条（批上限） | 131s |

- 32 条一批 131s > core 的单请求 120s 超时 ⇒ 每批必超时，向量永远是 0（真机：跑了 15 分钟、
  `vector_count = 0`）；
- 即便放宽超时，7 204 片段 ≈ 226 批 ≈ 2 小时起步（服务端不并行），1 万片段要跑一晚上。

所以第 2 条**不建议现在开**：开了只会让每个新会话的冷库从 1.1s 变成几小时，而且大概率一条向量
都存不下来。要么换一个吞吐够的 embedding 服务（本机另配的 `zen-embedding-8b`
在 `192.168.31.37:1234` 当前没在跑，无法对比），要么维持关键词通道 + 结构索引这条组合。
量端点的方法论与「建向量前的 configure 顺序」修复见 `docs/VECTOR-SEARCH.md` §1.3。

---

### 7.5 2026-11-03 复核：0.1% / 0.6% 不是「索引没用」，是两个真缺陷

窗口：`tool-telemetry.jsonl`（10-30 08:43 ~ 11-03 20:11，**8112 次工具调用**）+
`request_snapshots`（同窗 **1771 轮**）。面板当时显示：代码索引 0.1%（6 次，成功 83.3%）、
结构索引 0.6%（`read_symbol` 45 + `graph` 1，成功 58.7%）。

**第一条：结构索引一直在用，只是不进遥测。** 同窗口【仓库结构图】注入 **833 轮 = 47%**
（【项目地图】1226、【本轮上下文】1507）。也就是说 R8 的接线**已经生效**：索引内容每两轮
进一次上下文。工具只调用 46 次不等于没人用 —— 上下文里已经有骨架，就不必再调工具。
所以 §7 第 1 条判据（<1% 就删通道）在这个读水下**依然不能执行**，先决条件还差向量通道。

**第二条：`read_symbol` 的成功率被两件事拉低，其中一件确实是故障。**

| 现象 | 证据 | 判定 |
|---|---|---|
| SSH + `filePath+line` 先打远程 LSP，**空等 20.0 秒**再回落结构索引 | 10-31 19:35:02 = **20012ms**、11-01 20:29:23 = **20017ms**（另一次 45072ms），三次都 `ok=true` 所以不计入错误 | **真缺陷**：`REMOTE_READ_SYMBOL_LSP_TIMEOUT_MS` 就是 20000。已修（见下） |
| 18 个 `SYMBOL_NOT_FOUND` 里 6 个是同一会话 **2 秒内连打**（10-31 14:09:44–45），另有两对连击 | 与 §7.1/§7.2 结论一致 | 模型在猜名字，工具报错正确；58.7% 被这个连击会话放大，不能当「结构索引不可用」 |
| `INVALID_WORKSPACE` ×2 都落在 11-02 21:56:29 / 21:56:33（1ms / 4ms 即失败），46 秒后同样的 `codebase_search` 成功（65ms） | 工作区在那一刻解析不出来（SSH / worktree 绑定窗口） | 不是索引坏，但它把两个通道的成功率都拉低 |

正向读数：`codebase_search` 6 次里 4 次集中在 11-02 21:57 那 5 分钟，5/6 成功、49–212ms ——
**真被想起来用的时候是能用的**，与 §7.1「0 次」不是同一件事。

对 `read_symbol` 的修法（减法，不是加兜底）：

1. **给了 `name` 就不打远程 LSP**：结构索引按名返回的候选自带 `startLine/endLine`
   （§7.2 实测 20/20），`locateSymbolForRead` 末尾「取包含该行且范围最小者」照样成立，
   远程 LSP 只是同一条结论的更慢路径；
2. **超时 20000 → 3000ms**：只剩「按行定位且没给名字」这一条结构索引替代不了的路，
   3 秒答不出来就等于不可用，再等 17 秒买不到任何东西。

回归护栏：`test/unit/read-symbol-remote-lsp.test.cjs`（给 name 时断言不出现 `lsp.query`；
只给 filePath+line 时断言仍走 LSP 且超时预算 ≤5s）。

### 7.6 强证据优先：字面全命中不再被名次投票推翻（2026-11-05）

**问题**：两路 RRF 只看名次，丢掉了「这条命中覆盖了查询的多少」这个量级信号。150 文件 /
2231 段 / 54 题的双胞胎消融（同一份内容两棵树，一棵有向量一棵没有）实测：

| 族 | 纯子串（无向量） | 融合（有向量） | 说明 |
|---|---|---|---|
| 原句（查询就是源码里的注释行，n=12） | **100% / 100% / 1.00** | 83% / 92% / 0.88 | 向量把正确第 1 名挤到 2–4 |
| 去虚词骨架（n=12） | **100% / 100% / 1.00** | 67% / 92% / 0.75 | 同上，且更严重 |
| 手写改写（n=10） | 0% / 0% / 0 | **40% / 60% / 0.47** | 向量唯一不可替代的位置 |

**改法**（`index/search.rs`，无新配置、无权重、`fuse()` 一行未改）：把「可验证的字面事实」
从融合投票里拿出来，直接排在融合结果之前——

1. **强证据** = 符号定义点（`graph_symbols` 命中，§7.3 那条通道）**或**词法通道里
   **查询词元全部命中**（`hits == terms.len()`）的 chunk；
2. 强证据加一个固定加成 `n / (K+1)`（`n` = 参与融合的通道数），即「所有通道都把票投给
   同一个候选」的上界 ⇒ 任何非强证据候选的融合分都不可能追上，且强证据之间仍按各自融合分
   排先后（定义点因此天然排在「只是读到了整句」之前）；
3. 没有任何 chunk 全命中时（改写问法）**行为与改造前逐字相同**，向量照常决定名次。

复测（同一个库、同一批 54 题，只换二进制）：

| 族 | 融合改前 | 融合改后 | 纯子串 | 字面 grep |
|---|---|---|---|---|
| 标识符（n=20） | 100% / 100% / 1.00 | 100% / 100% / 1.00 | 80% / 95% / 0.87 | 80% / 100% / 0.90 |
| 原句（n=12） | 83% / 92% / 0.88 | **92% / 100% / 0.96** | 100% / 100% / 1.00 | 100% / 100% / 1.00 |
| 去虚词（n=12） | 67% / 92% / 0.75 | **100% / 100% / 1.00** | 100% / 100% / 1.00 | 0% / 0% / 0 |
| 改写（n=10） | 40% / 60% / 0.47 | 40% / 60% / 0.47 | 0% / 0% / 0 | 0% / 0% / 0 |
| 合计（n=54） | 78% / 89% / 0.82 | **87% / 93% / 0.89** | 74% / 80% / 0.77 | 52% / 59% / 0.56 |

原句族剩下的 1/12 不是融合问题：同一段说明在 `src/agent/agent-limits.js` 与
`crates/dieyun-core/src/agent/loop_run.rs` 各有一份（后者带 Markdown `**`，所以词元只落到
2/3，不构成强证据），两处都是正确答案，题库的「期望文件」只认了其中一个。

回归测试两条（`crates/dieyun-core/src/index/search.rs`）：
`full_coverage_literal_hit_outranks_vector_only_hit`（改前必失败）、
`vector_still_decides_when_no_literal_evidence`（守住改写族的价值不被这次改动带走）。

**为什么不是「给向量降权」**：那要求一个不可验证的魔数（正是 §R2 反对的加法），而且换个模型
就得重调。强证据是一个可验证的布尔事实（「这些词都在这个块里」/「这个名字在这里定义」），
与语料规模、模型、通道条数都无关。

---

## 8. 明确不做的事（写清楚，免得当成 TODO）

- 不实现 ANN / HNSW：触发条件见 `docs/VECTOR-SEARCH.md` §4，触发前是纯负收益。
- 不恢复符号级语义检索（`graph.embed_symbols` 一族已于本轮之前整体移除）。
- 不把「有路径才检索」再写回去（R8 已改判据：`allowCodebase` 独立于 `injectCode`，改回即等于让索引重新 0 次被用到）。
- 不为「远端无索引」补 grep 兜底（R7）。
- 不做「索引新鲜度增量校验/双写/事件溯源」——索引是派生物，过期就重建一次，比补一致性机制便宜。
- 不改 Tree-sitter 切块策略、不改 RRF 公式（本轮只删通道，不动剩下通道的算法）。
- 不把「这次不建向量」再写成「删掉已有向量」（R3 补丁已改：`vectors=false` 只表示本次不写，清空仅限 `force` 全量重建与签名变更）。
- 不让 `@Codebase` / prep 自动建库隐式建向量：那是把「用户的显式检索手势」变成为整库 embedding 付费的授权，且首建在 prep 里不阻塞（后台继续跑）但也不可见。向量入口保持显式（面板「建向量」/ CLI），缺口用面板的覆盖度提示暴露。要改这条，先拿 `codebase_search` 使用率与向量覆盖率数据（见 §7 复核点 4）。

---

## 9. 附录：数据复现

```powershell
# ① 库体与各表体积（需 better-sqlite3，仓库内已装）
node -e "const D=require('better-sqlite3');const db=new D(process.env.APPDATA+'\\dieyunagent\\codebase-index.sqlite',{readonly:true});console.table(db.prepare('select name,round(sum(pgsize)/1048576.0,1) MB from dbstat group by name order by MB desc limit 12').all())"

# ② 行数
node -e "const D=require('better-sqlite3');const db=new D(process.env.APPDATA+'\\dieyunagent\\codebase-index.sqlite',{readonly:true});for(const t of ['workspaces','chunks','chunk_vectors','graph_symbols','graph_imports','graph_calls'])console.log(t,db.prepare('select count(*) c from '+t).get().c)"

# ③ 7 天工具使用分布
node -e "const fs=require('fs');const m=new Map();for(const l of fs.readFileSync(process.env.APPDATA+'\\dieyunagent\\tool-telemetry.jsonl','utf8').trim().split('\n')){try{const r=JSON.parse(l);m.set(r.tool,(m.get(r.tool)||0)+1)}catch{}};console.table([...m].sort((a,b)=>b[1]-a[1]).slice(0,15).map(([tool,n])=>({tool,n})))"

# ④ FTS vs LIKE 延迟（把 root_hash 换成目标工作区）
node -e "const D=require('better-sqlite3');const db=new D(process.env.APPDATA+'\\dieyunagent\\codebase-index.sqlite',{readonly:true});const q=db.prepare('select count(*) c from chunks where root_hash=? and content like ?');const t=Date.now();console.log('LIKE hits',q.get('edf29efc5f04d515','%配置%').c,Date.now()-t+'ms')"
```

> 单机单周样本 + 公开资料，够下「默认值该翻」的判断，不够下「全量删除」的判断——所以 R2/R3/R5 都保留了保守分支与 revisit 判据。

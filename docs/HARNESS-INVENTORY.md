# Harness 资产清单：硬编码规则 & 提示词

> 用途：定期 review「随模型换代 / 需求变化而腐坏」的资产，决定保留、改配置、还是删除。
> 口径：**精确** = 可逐个枚举；**近似** = grep 调用点计数（含多义命中）。
> 生成方式：逐文件通读 + 行号核对。改动相关代码后请同步更新本文件。
> 相关：`AGENTS.md`（禁用意图关键词硬编码）、`docs/AGENT-DEV.md`、`docs/AGENT-STRATEGY.md`。

---

## 0. 总览

| 资产类别 | 约计 | 分布 | 精度 |
|---|---|---|---|
| 数字上限 / 阈值 / clamp | ≈ **285** 处 | JS ≈165（其中 `agent-limits.js` 单源 104）、Rust ≈120 | 近似 |
| 词表 / 数组常量 | ≈ **43** 张（元素合计 ≥ 900） | JS ≈22 张、Rust ≈21 张 | 近似 |
| 白名单 / 黑名单 | ≈ **23** 张 | 全部 JS | 近似 |
| 正则表达式 | ≈ **145** 条 | 全部 JS（Rust 用 `contains`/`matches!` 替代） | 近似 |
| 字符串启发式 / 分支判定 | ≈ **150** 处 | JS ≈40、Rust ≈110 | 近似 |
| 状态机 / 枚举 | ≈ **38** 组 | JS ≈28（多为 errorCode）、Rust 10 | 近似 |
| **提示词（system/user prompt 构造点）** | ≈ **60** 处 | 主链 9、注入块 ≈16、子调用 ≈14、Rust ≈22 | 近似 |
| Skills | **14** 个技能 / **70** 个 `.md` | `skills/bundled/` | 精确 |
| 模板文件 | **2** 个 | `assets/` | 精确 |
| **意图关键词硬编码（明令禁止类）** | **0** | 全仓核查（见 §A6） | 精确 |

**三条结论**：
1. 数量最大的两块是**数字上限**和**正则**，两者都集中在少数几个文件（见各节）。
2. 按 `AGENTS.md` 的意图关键词硬编码禁令要求，**“用固定词表判断用户查询意图 / 是否注入上下文”已实现清零**，改造为结构信号。
3. 最需要 review 的不是“多”，而是**重复定义**（§C）与**兼容垫片**（§D）。§C 的 11 项已于本轮清零；剩 §D 的兼容垫片待观察使用率。

---

## A. 硬编码规则

### A1. 数字上限（单一来源 + 分布）

#### A1.1 `src/agent/agent-limits.js` — 唯一配置源

> **本节只记区块与条数，不记行号** —— 行号每次改动都会漂移，定位请用符号名（`AGENT_LIMITS_DEFAULTS` / `AGENT_LIMITS_SCHEMA` / `SCHEMA_BY_KEY`）。

| 区块 | 条数 |
|---|---|
| `AGENT_LIMITS_DEFAULTS` | **129** 键（127 数字 + 2 布尔） |
| ↳ 其中不上设置页的折算系数 | 3（`visionPartEqChars` / `charsPerToken` / `cjkCharsPerToken`） |
| `AGENT_LIMITS_SCHEMA`（min/max/step/单位/中文标签） | **71** 项 |

> 条数会随改动漂移：**核对命令**（不靠肉眼数）：
> `node -e "const L=require('./src/agent/agent-limits');const D=L.AGENT_LIMITS_DEFAULTS;const k=Object.keys(D);console.log(k.length,k.filter(x=>typeof D[x]==='number').length,k.filter(x=>typeof D[x]==='boolean').length,L.AGENT_LIMITS_SCHEMA.flatMap(g=>g.items).length)"`
| 存储键：`dieyun.agent.limitsByTier.v1` / `agent-limits-by-tier.json`（Renderer / Main） | 2 |
| 兜底 tier 白名单（default / ctx-16k…ctx-2m） | 9 |

`AGENT_LIMITS_DEFAULTS` 分组（键名即定位）：

| 组 | 键 |
|---|---|
| 护栏 | `repeatToolStreakLimit` `repeatHistoryMax` `writeSmellHintMaxItems` `writeSmellHintMaxChars` `writeSmellScanTimeoutMs` `taskTierEnabled` |
| 完成验收（内部预算，不进 schema） | `readinessRpcTimeoutMs` `readinessMaxDiagFiles` `readinessBrowserQueryLimit` `readinessBrowserQueryTimeoutMs` `readinessMaxErrorSamples` `readinessErrorSampleChars` |
| Harness | `transientMaxRetries` `retryBaseMs` |
| UI 联动 | `artifactsUiFlushMs` `lspSyncDebounceMs` `monacoMaxChars` |
| 上下文 | `toolResultMaxJson` `codebaseSnippetMax` `codebaseAutoLimit` `openFilesMax` `filePreviewMaxChars` `fsReadDefaultMaxBytes` `lspDiagMaxChars` `visionShotsPerRound` `visionReattachPerRound` `visionMaxBase64Chars` `visionPartEqChars` `completionHistoryMaxChars` `completionMessageMaxChars` `completionLastUserMaxChars` `completionTurnRideMaxChars` `completionRecentTurns` `completionFoldedMaxChars` `userSystemMaxChars` `systemStableMaxChars` `llmRequestMaxChars` `charsPerToken` `cjkCharsPerToken` `projectMemoryFileMaxChars` `memoryToolRecallLimit` `memoryToolForgetMaxIds` |
| LLM 重试 | `streamRoundMaxAttempts` `llmRetryBaseMs` `llmReconnectMaxWaitMs` `llmFirstTokenTimeoutMs` `llmStreamIdleTimeoutMs` `synthesisTimeoutMs` `synthesisReconnectMaxWaitMs` |
| 编辑器/Diff | `maxUndoSteps` `editorSelectionMax` `editorVisibleLines` `maxDiffChars` `diffFullTextCap` `chatImagePreviewMaxMb` `attachmentRetentionMaxMb` `attachmentDownsampleMaxPx` `attachmentDownsampleMinKb` |

> **本文件是数字上限的唯一合法改动点**（`AGENTS.md` 原则 6）。除下面 A1.2 的“模块内局部阈值”外，其余文件的数字应尽量改为读这里。
> 例外：`visionPartEqChars` 是上下文账本的折算系数（非策略上限），故意不上设置页 —— `contentCharLen` 没有 tier 上下文、只读全局默认值，做成可调项会「改了不生效」。
> 同类例外：`charsPerToken`(3.2) / `cjkCharsPerToken`(1.5) 也是折算系数，唯一来源在本文件，renderer 侧经 `window.CHARS_PER_TOKEN` / `window.CJK_CHARS_PER_TOKEN` 消费；Rust 同值见 `crates/dieyun-core/src/compaction/tokens.rs`。

#### A1.2 其它 JS 文件内嵌数字（应知悉，非单源）

| 文件 | 值 | 用途 |
|---|---|---|
| `gateway/exec-policy.js:18,36` | 8 / 12000 | shell 链长上限、命令长度上限 |
| `agent/task-schema.js:16,17,18,47,48,50` | 3 / 900000 / 5 / 0..3 / 5000 / 1..10 | 默认重试、超时、优先级 |
| `agent/task-tier.js:17,50,51,81` | 6 / 240 / 2 / 6 | 文件数上限、短文本阈值、限定阈值 |
| `agent/agent-round-text.js:14,15,163,169,182` | 12 / 80 / 8 / 48 / 24 | 去重/记录/可用性阈值 |
| `agent/tool-output-spill.js:11,12,66,105,108,111` | 8192 / 40 / 48 / 3 / 8 / 20 | 溢出阈值、预览行、各工具切片 |
| `agent/tool-harness.js:21,24` | 80 / 80 | argsBrief 截断 |
| `agent/tool-result-cap.js:19,26,36` | 0.3 / 4000 / 14000 | 尾部保留比例与硬顶 |
| `attachment-retention.js:28,30,32,34` | 72 / 0.9 / 64MB / 32 | JPEG 质量、最小收缩比、单文件读取上限、单趟文件数 |
| `renderer/renderer-attachments.js:8,9` | 15 / 800000 | 读不到 agent-limits 时的兜底（上限单一来源见 `chatImagePreviewMaxMb` / `llmRequestMaxChars`） |
| `agent/write-smell-hints.js:27,295` | 64 / 6 | 追踪器 run 上限、同胞文件展示数 |
| `agent/agent-synthesis.js` | 2048 / 2500 / 8000 / 500 | 摘要阈值 |
| `agent/session-context.js` | 8 / 14000 / 2400 | 近轮/字符上限 |
| `agent/completion-readiness.js` | 160 | 断言摘要截断（样本条数/长度、诊断文件数、RPC/浏览器查询超时全部读 `agent-limits.readiness*`） |
| `renderer/renderer-skills-grid.js:8,11,12,13,248` | 15 / 3500 / 3 / 5 / 200 | 分页、注入上限、防抖 |
| `browser/url-policy.js:39,44,185` | 255 / 2 / 443·80 | IPv4 段、TLD 长度、默认端口 |
| `agent/guardrails-shared.js:146-152,226` | 500 / 2 | 参数截断、止损下限 |
| `agent/agent-system-prompt.js:156,163` | 8000 / 16000 | user system / stable 兜底帽 |
| `agent/compaction-main.js:73,97,103` | 0.25 / 6 / 1 | 工具 schema 扣减封顶比例、冷却轮数（**唯一来源**，Rust 已无默认值，缺参即报错）、压缩后轮次计数；字符→token 折算读 `agent-limits.js` |
| `agent/rust-loop-runner.js:38-41,46` | 30000 / 30000 / 600000 / 300000 / 2 | loop RPC 超时、单轮图片自愈次数；**不再有**条数 / 字符比压缩门槛（压缩判据单点在 Rust） |
| `lsp/diagnostics-service.js` | `LSP_SETTINGS_DEFAULTS`：maxFiles 6 / maxPerFile 20 / timeoutMs 8000 | LSP 文件数 · 条数 · 超时的**唯一来源**；`agent-limits.lspDiagMaxChars` 只管注入字符上限 |

> `renderer/renderer-context-engine.js` 的 `CTX_LIMITS`、`agent/session-context.js` 的 `DEFAULT_COMPLETION_CAPS`、`agent/system-prompt-prep.js` 的 `DEFAULT_LIMITS` 已改为**从 `agent-limits.js` 映射**（`ctxAgentLimitDefault` / `completionCapDefault`），不再各存一份默认值；其中的兜底字面量只在 agent-limits 未加载时命中。
>
> 运行期刷新同理：`agent-limits` 键（camelCase）→ `CTX_LIMITS` 键（SCREAMING_SNAKE）的映射表 `CTX_LIMITS_FROM_AGENT_LIMITS` **只存在于** `renderer-context-engine.js`。`renderer-agent-limits-runtime.js` 只回答「何时刷」（启动 + 档位/limits 变更事件），`ctxLimitsFor()` 复用同一张表取单次快照；它原先另存一份 14 键表，已删。

#### A1.3 Rust 数字常量与 clamp

| 文件 | 主要值（行号） |
|---|---|
| `agent/loop_run.rs` | `DEFAULT_MAX_TOOL_CALLS=150`:12 `DEFAULT_MAX_ROUNDS=96`:13 `MIN_RECORDED_PLAN_CHARS=80`:14 `MIN_DUP_CHARS=12`:15 `24`:60 `500`:510 |
| `planner/run.rs` | explore `maxRounds=24`:342、worker `maxRounds=96`:1008、plan 修复 `<2`:504、best-of-n `.max(2).min(3)`:712、`take(4000)`:417,687、title `take(48)`:1086 |
| `planner/plan_parse.rs` | todos `take(20)`:216 / `take(8)`:238、title `take(48)`:178、brief `take(4000)`:338、best_of_n `.min(3)`:323 |
| `memory/mod.rs` | `MEMORY_EMBED_TEXT_MAX=6000`:24、`clamp(1,500)`:813、`clamp(1,200)`:969、`clamp(1,50)`:1705,1918（词法 / 语义召回上限）、`take(120)`:2218（scope 归一，唯一实现 `normalize_memory_scope`）、`take(80)`:485、`chars().take(64)`:911、`take(4000)`:1507,1513、`take(200_000)`:1523；写入政策常量 `NEAR_DUP_COSINE=0.92`:132、`CONSOLIDATION_MIN_IMPORTANCE=3`:137；检索打分只剩稳定信号：重要度 `0.035`:1995、新鲜度 `0.08`:1996、stale `-0.15`:1993、语义阈值 `0.05`:2076（复用 `embedding::MIN_SIMILARITY`；词法排序交给 bm25 + `fts::match_query`，手写分词与 `LIMIT 1000` 窗口已删除） |
| `embedding/mod.rs` | `EMBED_BATCH_MAX_INPUTS=32`:13 `EMBED_BATCH_MAX_CHARS=24_000`:14 `EMBED_TEXT_MAX_CHARS=6000`:15、`EMBED_CONCURRENCY=4`:26（批量席位 `3`=共享减 1）、`INTERACTIVE_EMBED_BUDGET_MS=10_000`:61（与 Node `agent-limits.interactiveEmbedBudgetMs` 成对：超预算的**交互查询**不发请求、回 `EMBEDDING_TOO_SLOW`）、`MIN_SIMILARITY=0.05`:195（代码向量池与记忆语义召回共用） |
| `compaction/llm.rs` | `3`:10 `800`:11 `3000`:12 `60_000`:13 `180_000`:15 `3`:16 `5_000`:17 `75`:19、`min(4)`:108、温度 `0.15`:141、`max_tokens=4096`:142 |
| `compaction/mod.rs` + `atoms.rs` | `POST_COMPACTION_ROUND_COUNT=1`:76 `max(8192)`:125 `clamp(0.3,0.95)`:126、`recent_budget=budget*0.42`:233、keep `len*0.3`:246、`take(32_000/48_000/120_000)`、正文截断 6000/4000（预算 / 触发比 / 冷却轮数已改为**调用方必传**，Rust 不再存默认值） |
| `index/search.rs` | `SEARCH_LIMIT_MAX=48`:12、`limit*6`:87、权重 `0.35`:94 `0.3`:119 `0.55`:290 `0.6`:435、阈值 `0.05`:116,286、`LIMIT 8000`:104、`chunks(400)`:241、`take(12/900)`:357,361 |
| `graph/query.rs` | depth `clamp(1,8)`:29 / `clamp(1,12)`:402、limit `clamp(1,80)`:79,163 / `clamp(8,64)`:671、权重 `+0.35`:308 `+0.15`:310、阈值 `0.05`:312、渲染 `take(16/28/24/4)` |
| `index/walker.rs` | `SNIFF_BYTES=8192`:45、`MAX_SNIFF_FILE_BYTES=2MB`:46、阈值 `0.85`:167 / `0.92`:170 |
| `graph/build.rs` | `MAX_GRAPH_FILES=16_000`:33、置信度 `0.9/0.8`:430 |

---

### A2. 词表 / 数组常量

#### A2.1 JS（≈23 张）

| 文件:行号 | 名称 | 数量 | 用途 |
|---|---|---|---|
| `guardrails-shared.js:9-19` | `TOOL_NAME_ALIASES` | 9 | 工具别名归一（rg→grep 等） |
| `guardrails-shared.js:22-30` | `GRAPH_LEGACY_OPS` | 7 | 7 个旧 `graph_*` → `graph.operation` |
| `guardrails-shared.js:32-34` | `GRAPH_OPERATIONS` | 7 | 图谱操作枚举 |
| `guardrails-shared.js:37-49` | `MUTATING_TOOL_NAMES` | 9 | 会改动状态的工具 |
| `guardrails-shared.js:52-54` | `FILE_WRITE_TOOL_NAMES` | 5 | 会写本地文件的工具 |
| `guardrails-shared.js:57-77` | `BROWSER_MUTATING_PREFIXES` | 19 | 改页面状态的浏览器工具前缀 |
| `planner-tool-filters.js:5-24` | `EXPLORE_TOOL_NAMES` | 21 | Explore 只读白名单（**唯一来源**，经 agent-bundle 镜像给 Renderer） |
| `planner-tool-filters.js:36-45` | `SHELL_TOOL_NAMES` | 11 | Shell 模式白名单（同上） |
| `planner-tool-filters.js:63` | `READONLY_MCP_SERVER_IDS` | 1 | 只读阶段放行的 MCP 服务（服务端契约拒写；`mcp-postgres`）。前缀经 `mcp/tool-name.js` 生成，不在此复写编码格式 |
| `llm-tool-call-fallback.js:20-35` | `TOOL_NAME_ALIASES` | 14 | 解析模型输出里的工具名 |
| `llm-tool-call-fallback.js:37-40` | `TOOL_PARAM_NAMES` | 派生 | 由 `tool-catalog.ALL_STATIC_TOOLS` 派生（外加 3 个执行端仍认的历史名），不再手抄 |
| `browser/url-policy.js:10-17` | `LOCAL_FILE_EXTENSIONS` | 65 | 本地文件扩展名白名单 |
| `browser/url-policy.js:210` | `REMOTE_PREVIEW_HOSTS` | 4 | localhost/127.0.0.1/0.0.0.0/::1 |
| `renderer/renderer-skills-grid.js:17-181` | `SKILLS_TAXONOMY[].keywords` | 8 组 / **127** 词 | 技能 UI 分类 |
| `renderer/renderer-skills-grid.js:184` | `SKILLS_TAXONOMY_REMOVED` | 3 | 分类黑名单 |
| `renderer/renderer-skills-grid.js:184-196` | `MCP/AUTOMATION_TAXONOMY` | 3/5 | 分类表 |
| `agent/write-smell-hints.js:24` | `CONTENT_WRITE_TOOLS` | 2 | 内容写工具 |
| `agent/write-smell-hints.js:109-113` | `SWALLOWED_EXCEPTION_PATTERNS` | 3 | 吞异常形态 |
| `agent/agent-round-text.js:33` | `isPassthroughThought` 前缀 | 9 | 过场思考前缀（**中文词表，见 §A6**） |
| `agent/tool-harness.js:33,52,55` | 错误分类正则词表 | 3 组 | 工具错误分类（**见 §A6**） |
| `agent/agent-limits.js` | 兜底 tier 白名单 | 9 | 已知 context tier |
| `agent/task-tier.js:15` | `TASK_TIERS` | 3 | trivial/normal/heavy |
| `agent/task-schema.js:3,14,28` | 状态/策略/Agent 类型 | 8/3/3 | 任务 schema |

#### A2.2 Rust（≈21 张）

| 文件:行号 | 名称 | 数量 | 用途 |
|---|---|---|---|
| `index/walker.rs:4-20` | `IGNORE_DIRS` | 16 | 索引跳过目录 |
| `index/walker.rs:23-32` | `IGNORE_EXT` | 58 | 排除扩展名 |
| `index/walker.rs:35-43` | `KNOWN_TEXT_EXT` | 69 | 文本白名单 |
| `index/walker.rs:108-120` | 无扩展名特殊文件 | 12 | Dockerfile/Makefile 等 |
| `graph/extract/symbols.rs:3-34` | `CALL_SKIP`（JS/TS） | 30 | 语言关键字过滤 |
| `graph/extract/rust_lang.rs:237-287` | `CALL_SKIP`（Rust） | 49 | 同上 |
| `graph/extract/python.rs:186-236` | `CALL_SKIP`（Python） | 49 | 同上 |
| `graph/extract/go.rs:173-212` | `CALL_SKIP`（Go） | 38 | 同上 |
| `memory/mod.rs:1216` | 记忆 kind 白名单 | 3 | normal/private/secret |
| `memory/mod.rs:1253` | 记忆状态白名单 | 4 | active/stale/archived/deleted |
| `memory/mod.rs:1231-1237` | `looks_secret` | 7 | api_key/password/密码/密钥… |
| `memory/mod.rs:1242-1248` | `looks_private` | 7 | 手机号/身份证/邮箱/database… |
| `memory/mod.rs:275-283,1298-1306` | 标题黑名单 | ≈5 | 对话/新对话/【叠云meta】… |
| `compaction/llm.rs:54-58` | 网关超时消息 | 5 | http 502/503/504… |
| `compaction/llm.rs:68-86` | 瞬时错误关键词 | 19 | econnreset/socket hang up… |
| `planner/plan_parse.rs:142-321` | 字段名候选键组 | **10 组** | instruction/worker/id/title/todos… |
| `planner/plan_parse.rs:80-87` | agent type 枚举 | 3 | explore/shell/build |
| `graph/query.rs:715-717` | 枢纽 kind 白名单 | 10 | function/method/class… |
| `agent/loop_run.rs:17-31` | 过场思考前缀 | 10 | 请求中/思考中/生成中…（**见 §A6**） |
| `agent/loop_run.rs:44-52` | 状态值 | 4 | continue/final/blocked/ask_user |
| `planner/run.rs:1105-1118` | phase 名映射 | 10 | need_plan_llm… |

---

### A3. 白名单 / 黑名单（≈24 张）

| 类型 | 位置 | 数量 |
|---|---|---|
| **黑名单** | `gateway/exec-policy.js:5-14` `BLOCKED_PATTERNS`（rm -rf /、del /s、format、mkfs、写裸设备、fork bomb、shutdown、reboot、-enc） | 10 |
| 黑名单 | `renderer/renderer-skills-grid.js:184` 分类移除 | 3 |
| 白名单 | `planner-tool-filters.js` Explore / Shell + 只读 MCP 放行名单 | 21 / 11 / 1 |
| 白名单 | `agent/tool-validate.js:271` lsp operation | 4 |
| 白名单 | `guardrails-shared.js` 改写/文件写工具集 | 9 / 5 |
| 白名单 | `browser/url-policy.js` 扩展名 / 内网主机 | 65 / 4 |
| 白名单 | `renderer/renderer-skills-grid.js:9,10` 默认启用技能 | 1 / 2 |
| 白名单 | `agent/agent-limits.js` 兜底 tier | 9 |
| 白名单 | Rust `index/walker.rs` `KNOWN_TEXT_EXT` / `IGNORE_*` | 69 / 74 |
| 白名单 | Rust `graph/extract/*` `CALL_SKIP` | 166 |
| 白名单 | Rust `graph/query.rs:715-717` 枢纽 kind | 10 |
| 白名单 | Rust `memory/mod.rs` kind / status | 3 / 4 |

---

### A4. 正则表达式（≈145 条，全部 JS）

按文件分布：

| 文件 | 条数 | 主要用途 |
|---|---|---|
| `llm-tool-call-fallback.js` | ≈56 | 解析模型输出的 tool_call / DSML markup |
| `browser/url-policy.js` | 22 | URL/主机/路径校验 |
| `renderer/renderer-skills-grid.js` | 14 | skill id → 分类 |
| `gateway/exec-policy.js` | 13 | 高危命令黑名单 + 引号剥离 |
| `agent/write-smell-hints.js` | 13 | 吞异常 / 明文凭据 / 常量赋值 / 路径归一 |
| `agent/agent-round-text.js` | 8 | 状态行、过场思考、tool_call 标记 |
| `agent/completion-readiness.js` | 3 | 结构化 exit code、写入/验证工具归类、断言只看最后一次 |
| `agent/tool-output-spill.js` | 4 | 行切分、文件名清洗 |
| `agent/task-schema.js` | 3 | workerId 格式 |
| `agent/tool-harness.js` | 3 | 错误瞬时/策略分类 |
| `agent/guardrails-shared.js` | 2 | host_exec 写文件 / 校验类判定 |
| `agent/agent-limits.js` `tool-validate.js` `task-tier.js` | 各 1 | 路径分隔符 / apply_patch / 反斜杠归一 |
| 其余 | 0 | — |

> Rust 侧无正则库，用 `contains`/`starts_with`/`matches!` 实现，约 **110 处**启发式判定，集中在 `memory/mod.rs`(20)、`compaction/llm.rs`(34)、`graph/query.rs`。

---

### A5. 状态机 / 枚举（≈38 组）

| 位置 | 名称 | 成员数 |
|---|---|---|
| `crates/.../planner/run.rs:27-39` | `InternalPhase`（核心状态机） | **10** |
| `crates/.../agent/loop_run.rs:44-52` | 状态值 | 4 |
| `crates/.../planner/plan_parse.rs:80-87` | agent type | 3 |
| `crates/.../memory/mod.rs:1216/1253` | kind / status | 3 / 4 |
| `agent/task-schema.js:3,14,28` | 任务状态 / 异常策略 / Agent 类型 | 8 / 3 / 3 |
| `agent/task-tier.js:15` | `TASK_TIERS` | 3 |
| `agent/agent-round-text.js:4` | `STATUS_VALUES` | 4 |
| `agent/tool-validate.js` | `errorCode`（INVALID_NAME/MISSING_*/BLOCKED/USE_FS_EDIT） | 8 |
| `agent/tool-harness.js` | `errorCode`（TRANSIENT/EXCEPTION/POLICY/TOOL_ERROR/REPEAT_BLOCK/ok） | 6 |
| `gateway/exec-policy.js` | `errorCode`（EMPTY/TOO_LONG/BLOCKED/CHAIN_LIMIT） | 4 |
| `browser/url-policy.js` | `errorCode`（INVALID_URL/PATH_NOT_ALLOWED/FILE_NOT_FOUND） | 3 |
| `agent/guardrails-shared.js:32-34` | `GRAPH_OPERATIONS` | 7 |
| `goals/session-goal.js:29` | `STATUSES`（会话目标：进行中 / 暂停 / 预算用尽 / 阻塞；收尾另存 `outcome`） | 4 |

---

### A6. ⚠️ 意图关键词硬编码 — 专项核查

**结论：全仓 0 处**符合 `AGENTS.md` 禁止模式（“固定中英文词表 → 决定是否注入上下文 / 是否触发索引 / 用户查询路由”）。

**正向证据（代码显式声明禁用并改用结构信号）：**

| 位置 | 说明 |
|---|---|
| `src/agent/task-tier.js:41` | 注释「结构信号…**不用意图词表**，不另打分级 LLM」 |
| `src/agent/completion-readiness.js` | 完成验收：工具名归类（写入/验证）+ 结构化退出码，**不读模型自述文字**，不解析用户意图 |
| `src/agent/context-signals.js:2-12` | 「结构信号（@Codebase / 路径 / 编辑器选区）→ 是否注入代码 / 自动检索」的**唯一来源**，注释声明「不含任何平台分支或关键词表」 |
| `src/agent/knowledge-maintainer.js`（`shouldRunKnowledgeMaintenance`） | 注释「结构信号；**禁用寒暄关键词门闩**」，阈值走 `agent-limits` 的 `knowledge*` |
| `src/agent/write-smell-hints.js:16` | 「判定对象是写入产物…**不构成意图关键词路由**」 |
| `src/agent/system-prompt-prep.js:34-49` | 注入判定 = `@Codebase` 正则 + 路径正则（结构信号） |

**残留词表（不违规，但属“词表判定”，建议每次 review 时确认用途未漂移）：**

| 位置 | 词表 | 判定对象 | 风险 |
|---|---|---|---|
| `src/agent/agent-round-text.js:33` | 9 个中文过场前缀 | 助手思考文本 | ⚠️ 唯一中文“意图风格”词表，建议复核 |
| `crates/.../agent/loop_run.rs:17-31` | 10 个中文前缀 | LLM 占位思考文本 | ⚠️ 与上条为双份实现 |
| `src/agent/tool-harness.js:33,52,55` | 中英文错误词 | 工具错误消息 | 低（错误分类） |
| `crates/.../compaction/llm.rs:54-86` | 错误消息词 | LLM 错误消息 | 低 |
| `src/renderer/renderer-skills-grid.js:17-181` | 127 词 | 技能元数据 | 低（UI 分类） |
| `crates/.../memory/mod.rs:1231-1248` | 7+7 词 | 记忆内容敏感性 | 低 |

---

## B. 提示词（Prompt）

### B1. 主 Agent system prompt 链路

组装入口：`src/agent/agent-system-prompt.js:177-198` `assembleSystemPrompt()`。
拼接顺序（stable → turn）：`language → userSystem → 核心准则 → stableDataChunks → 家目录 → 工作空间 → 权限 ｜ 系统时间 → turnDataChunks`。

| 文件:行号 | 构造器 | 内容 | 模型可见 |
|---|---|---|---|
| `agent-system-prompt.js:8-46` | `buildCoreAgentRules()` | **【Agent 准则】15 条 + subagent + peer 块**（≈2300 字符） | ✅ 稳定块 |
| `agent-system-prompt.js:54-69` | `formatSystemTimeChunk()` | 【系统时间】 | ✅ 轮次块 |
| `agent-system-prompt.js:70-78` | `formatAgentHomeChunk()` | 【技能/计划】 | ✅ 稳定块 |
| `agent-system-prompt.js:79-106` | `formatWorkspaceChunk()` | 【当前工作空间】/【默认工作目录】 | ✅ 稳定块 |
| `agent-system-prompt.js:107-133` | `formatPermissionsChunk()` | 【本机控制能力】/【联网抓取】 | ✅ 稳定块 |
| `agent-system-prompt.js:146-159` | `capUserSystemText()` / `capStableSystemText()` | 8000 / 16000 字符截断 | — |
| `renderer/renderer-i18n.js:216-230` | `agentLanguagePrompt()` | 【回答语言】中/英 | ✅ 稳定块首位 |
| `renderer/renderer-agent-system-message.js:113,319,361` | 编排 | 取 i18n / dieyun 块 / userSystem | 组装器 |
| `renderer/renderer-model-runtime.js` | `DEFAULTS.system` | 默认自定义 system（**空**；身份/人设唯一来源见 `dieyun.md` 与 `ASSISTANT_IDENTITY`） | ✅（经 settings，用户填了才注入） |

**核心准则包含的硬编码规则文本**（review 时重点）：

| 行号 | 内容 |
|---|---|
| `:31` | 预注入代码优先，少做重复 list/read |
| `:32` | 工具可并行；读大文件用 offset/maxBytes |
| `:33` | 用 web_search→web_fetch 核验；禁止伪造搜索结果 |
| `:34` | 技能：先读 SKILL.md；host_exec cwd=技能目录 |
| `:35` | 仅无法抉择时才 agent_clarify；适合表格用 Markdown |
| `:36` | **无 tool_calls 的文字回复即本轮结束** |
| `:37-38` | Mermaid：每回复最多 1 块、节点 ≤15、嵌套 subgraph ≤2、标签双引号 |
| `:39` | `.dieyun/AGENTS.md` 项目地图 |
| `:40` | 会话记忆判定规则 |
| `:41` | 任务优先级规则 |
| `:42` | 折叠历史使用规则 |
| `:43` | 写代码“能改”原则；同常量单源 |
| `:44` | 结构化文件 parse→dump，勿正则替换；勿静默吞异常 |
| `:45` | 完成校验：声称已改须有写操作 |
| `:46-48` | subagent / peer 块（无模式分支：Composer 模式选择器已删除） |

### B2. 上下文注入块构造器（≈16 个）

| 文件:行号 | 构造器 | 注入块 |
|---|---|---|
| `agent/context-signals.js` | `formatCodebaseBlock` | 【相关代码 · 自动检索】 |
| `agent/system-prompt-prep.js:82` | `formatRecentChanges` | 【本会话变更文件】 |
| `agent/system-prompt-prep.js:309` | `fetchOpenFilesBlock` | 【当前关注文件 · 会话上下文】 |
| `agent/system-prompt-prep.js:402` | `fetchAgentsMdBlock` | 【仓库约定 · AGENTS.md】→【项目地图 · AGENTS.md】（两层链，宽泛在前） |
| `agent/system-prompt-prep.js:471` | `isInjectableMemoryRow` | `kind=secret/private` 不进自动注入 |
| `agent/system-prompt-prep.js:476` | `formatMemoryLines` | 记忆行 |
| `agent/system-prompt-prep.js:488` | `fetchProjectMemoryBlock` | 【项目记忆】 |
| `agent/system-prompt-prep.js:523` | `fetchGlobalMemoryBlock` | 【长期记忆】 |
| `agent/system-prompt-prep.js:629` | `fetchSessionHandoffBlock` | 【上个会话交接】（`<handoff>` 定界 + `<` 转义，旧会话内容不受信任） |
| `agent/system-prompt-prep.js:604` | `formatAgentStateBlock` | ## 工作记忆快照 / ## 最近步骤 |
| `agent/system-prompt-prep.js:643` | `fetchWorkMemoryBlock` | 【工作记忆模板】 |
| `agent/system-prompt-prep.js:670` | `fetchSkillsBlock` | 【相关技能 · 索引】 |
| `agent/system-prompt-prep.js:766` | `formatMcpPromptBlock` | 【MCP · 服务列表】 |
| `agent/session-context.js:18-25` | 4 个 header 常量 | 近期对话 / 压缩摘要 / 已折叠 / Turn Context |
| `agent/session-context.js:79-98` | `formatCompactionArchiveBlock` | 压缩背景块 |
| `agent/session-context.js:242-252` | `buildCurrentTaskText` | 【当前任务】 |
| `agent/agents-md.js:271-283` | `formatAgentsMdSystemBlock` | 【项目地图 · AGENTS.md】 |
| `agent/dieyun-instructions.js:59-63` | `formatDieyunSystemBlock` | 【全局用户规则 · dieyun.md】 |
| `renderer/renderer-dieyun-md.js` | `formatDieyunMdInjectBlock` | 只决定「注入哪几条 + 模式提示」；文案转发 Main `formatDieyunBlock`（IPC `workspace:format-dieyun-md`） |
| `renderer/renderer-agents-md.js` | `formatAgentsMdBlock` | 纯转发 Main `formatAgentsMdSystemBlock`（IPC `agents-md:format-block`），不再自带文案 |
| `agent/task-tier.js:79-86` | `formatTaskTierSystemBlock` | 【任务分级】 |
| `automation/skill-prompt.js:13-38` | `buildTaskSkillsSystem` | 【定时任务关联技能】 |
| `plans/goal-run.js` | `renderSessionGoalBlock`（经 `system-prompt-prep.js#fetchSessionGoalBlock` 注入，排在 `turnHost` 最前） | 会话目标块：目标 / 清单 / 最近事实 / 第几轮 / 预算余量；无目标时返回空串（普通会话零注入） |
| `plans/goal-run.js` | `renderEvidenceBlock` | 计划目标的事实块（与上面同一份措辞来源） |

### B3. 子 Agent / 独立子调用 prompt（≈14 个）

| 文件:行号 | 位置 | 角色 | 用途 |
|---|---|---|---|
| `src/compaction-prompts.js:7-33` | `COMPACTION.SYSTEM` | system | 压缩器（含「2000 字以内」） |
| `src/compaction-prompts.js:35-52` | `COMPACTION.USER` | user | 压缩主模板 |
| `src/compaction-prompts.js:54-61` | `INCREMENTAL_SYSTEM` | system | 增量压缩 |
| `src/compaction-prompts.js:63-71` | `INCREMENTAL_USER` | user | 增量压缩 |
| `src/compaction-prompts.js:73-74` | `COMPACT_PREFIX/SUFFIX` | 注入 | 摘要前后缀 |
| `src/compaction-prompts.js:76-79` | `WORKER_*/PLANNER_*` | system/user | Worktree / Planner 压缩 |
| ~~`src/agent/compaction-rust-bridge.js`~~ | — | — | **已删除**：唯一消费者改为直接读 `compaction-prompts.js`，映射写在 `compaction-main.js` |
| `src/agent/agent-synthesis.js:74-106` | 汇总助手 | system | 最终汇总 |
| ~~`src/renderer/renderer-thinking-trace.js` 汇总助手~~ | — | — | **已删除**：Renderer 侧那份逐字重复且无调用点 |
| `src/agent/turn-reviewer.js`（修复提示词） | 格式修复器 | system | 强制合法 JSON |
| `src/agent/turn-reviewer.js`（主判定） | Reviewer | system/user | 独立验收（浏览器证据规则） |
| ~~`src/renderer/renderer-agent-llm.js` 记忆归纳器~~ | — | — | **已删除**：与知识维护器重复的第二份归纳提示词 |
| `src/agent/knowledge-maintainer.js` | 知识维护器（**Main 侧唯一实现，含触发**） | system | 两分支（fullPeriodic / 默认）；触发由 `afterAgentRun` 在三个 loop 调用点统一发起 |
| `src/renderer/renderer-agents-md.js:635-637` | AGENTS 冷启动 | system | 初始化 section |
| `src/plans/parser.js:6-19` | `PARSE_SYSTEM` | system | 自然语言 → RRULE JSON |
| `src/plans/plan-agent-runner.js:36-69` | 计划 Agent | system/user | 定时任务执行 |
| `src/agent/handoff-prompts.js:11-32` | 会话交接归纳器 | system/user | 跨会话交接生成（结构固定五段，600 字内） |
| `src/plans/runner.js:10-92` | 轻量执行 | system | `ASSISTANT_IDENTITY` + dieyun + 技能 |
| `src/agent/agent-synthesis.js:9-12` | trace 阶段文案 | UI | 汇总阶段名 |

### B4. Rust 内嵌 prompt

| 文件:行号 | 名称 | 角色 | 用途 |
|---|---|---|---|
| `planner/prompts.rs:5-36` | `PLANNER_SYSTEM` | system | 规划师（≈900 字） |
| `planner/prompts.rs:38-45` | `PLANNER_REPAIR_USER` | user | JSON 修复轮 |
| `planner/prompts.rs:47-62` | `REVIEW_SYSTEM` | system | 验收 |
| `planner/prompts.rs:64-68` | `EXPLORE_SYSTEM` | system | Explore 只读勘察 |
| `planner/prompts.rs:75-142` | `build_planner_user_text` / `build_explore_loop_messages` | user/system | 背景 + 当前任务 + 子任务简报 |
| `planner/prompts.rs:157-181` | `build_worker_task_system` | system | 执行器主提示（≈230 字） |
| `planner/prompts.rs:200-201` | `build_review_llm_body` | system/user | 验收请求 |
| `planner/prompts.rs:219-244` | `build_synthesize_llm_body` | user | 汇总块 |
| `planner/prompts.rs:258-259` | 汇总 system | system | 「任务总结」+ Markdown 表格 |
| `planner/prompts.rs:276-292` | best-of-n 评审 | system/user | `{"winnerIndex":1}` |
| `planner/run.rs:997-1000` | worker 启动 user | user | 【用户原始需求】+ 完成子任务 |
| `planner/plan_parse.rs:337-364` | `build_fallback_plan` | 降级指令 | 规划失败降级为单任务 |
| `compaction/mod.rs:38-42` | `CompactionPrompts::default()` | system/user | 压缩默认提示 |
| `compaction/mod.rs:204-217` | 增量兜底 | user/system | 英文兜底串 |
| `compaction/atoms.rs:7` | `COMPACT_DIGEST_MARK` | 标记 | `【对话摘要】` |
| `compaction/atoms.rs:222-237` | 摘要字段标签 | 注入 | 11 个中文字段标题 |
| `compaction/atoms.rs:285` | ack 文案 | assistant | 「收到，已基于压缩摘要继续执行。」 |

> 其余 trace 阶段中文文案（`规划师 · 任务拆解`、`Explore · 只读勘察`、`汇总` 等）约 28 处，仅 UI 展示，不参与路由。

### B5. Skills

| 技能 | SKILL.md 行数 |
|---|---|
| `weather` | 17 |
| `curated/baidu-search` | 14 |
| `curated/weather-china` | 16 |
| `curated/skill-vetter` | 142 |
| `curated/skill-creator` | 360 |
| `curated/multi-search-engine` | 161 |
| `minimax/frontend-dev` | 573 |
| `minimax/fullstack-dev` | 1041 |
| `minimax/minimax-docx` | 278 |
| `minimax/minimax-multimodal-toolkit` | 363 |
| `minimax/minimax-pdf` | 196 |
| `minimax/minimax-xlsx` | 142 |
| `minimax/pptx-generator` | 253 |
| `minimax/vision-analysis` | 178 |

- 技能 **14** 个，`SKILL.md` **14** 个，`skills/` 下 `.md` 共 **70** 个。
- `references/` 子目录：**7** 个技能，共 **52** 篇参考文档。
- `BUNDLED-MANIFEST.json`：`required` **14** 条（minimax 8 + curated 5 + `weather/SKILL.md`），`weather` **已登记**。

### B6. 模板文件

| 文件 | 规模 | 说明 |
|---|---|---|
| `assets/AGENTS.md.template` | 47 行 / **8 个 section 占位** | overview / structure / commands / conventions / testing / architecture / gotchas / changelog(auto) |
| `assets/dieyun.md` | 25 行 / **4 个字段** | 身份与称呼 / 语言与风格 / 沟通偏好 / 跨项目编码习惯 |
| 仓库根 `AGENTS.md` | 147 行 | **不参与运行时注入**（仅本仓库开发指南） |
| 仓库根 `dieyun.md` | 28 行 | **不参与运行时注入**（示例） |

> 运行时真正注入的是：工作区 `<workspace>/.dieyun/AGENTS.md`（由 `system-prompt-prep.js:274-301` + `agents-md.js:271-283` 读取）与 `~/.dieyun/dieyun.md`（由 `dieyun-instructions.js:45-63` 读取）。两者分别从 `assets/` 的模板初始化生成。

---

## C. 重复定义与一致性风险（review 优先项）

> 本节 11 项已于本轮全部处理，处置方式如下 —— 后续新增重复时按同样口径登记。

| # | 项 | 唯一权威实现 | 处置 |
|---|---|---|---|
| 1 | 最终汇总助手 system | `agent-synthesis.js`（Main，rust-loop-runner 调用） | **已删** Renderer 侧逐字重复且无调用点的 `buildAgentSynthesisBody` |
| 2 | 汇总 / 回注过程摘要构造 | `agent-synthesis.js` `buildTraceFactsDigest` | 同上（同一次删除）；**并收窄为「只由工具事实构成」**：汇总 LLM 的输入与子 Agent 回注都不再含思考（`docs/REASONING-ISOLATION-PLAN.md` §3.7 D3） |
| 3 | 技能索引块 | `system-prompt-prep.js` `fetchSkillsBlock` | **已删** Renderer `buildSkillsPrompt`（无调用点）及 `agentToolsIncludeCompactMcp` |
| 4 | MCP 块 | `system-prompt-prep.js` `formatMcpPromptBlock` | **已删** Renderer `buildMcpPrompt`（无调用点） |
| 5 | AGENTS.md 注入块 | `agents-md.js` `formatAgentsMdSystemBlock`（IPC `agents-md:format-block`） | Renderer 改为**纯转发**，删掉复制的文案与 `AGENTS_MD_MAX` 兜底 |
| 6 | dieyun.md 注入块 | `dieyun-instructions.js` `formatDieyunBlock`（IPC `workspace:format-dieyun-md`） | Renderer 只保留「注入哪几条 + 模式提示」，header/前言单一来源 |
| 7 | 压缩兜底文案 | `compaction-prompts.js` | **已删** `compaction-rust-bridge.js`，映射内联到 `compaction-main.js`；字段缺失由 Rust `CompactionPrompts::default()` 兜底 |
| 8 | 过场思考前缀词表 | JS `agent-round-text.js` + Rust `loop_run.rs`（跨语言无法共享常量） | 新增 `check-repo-contracts.cjs` 契约检查，两边不同步即 fail |
| 9 | 默认 system | 默认两侧均为空串；人设由 `dieyun.md` + `ASSISTANT_IDENTITY` 承载 | **已解决**：`normalize()` 不再强制清空；`LEGACY_RUNTIME_PRESETS.system` 迁移清掉旧内置人设 |
| 10 | 助手身份串 | `dieyun-instructions.js` `ASSISTANT_IDENTITY` =「叠云 Agent（小芸）」 | **已解决**：`assets/dieyun.md` / 仓库根 `dieyun.md` / `index.html` 关于面板同口径 |
| 11 | weather 技能 | `BUNDLED-MANIFEST.json` `required` | **本就已登记**（`weather/SKILL.md`），原文「未登记」是误记，已更正 |
| 12 | 工具调用关卡（校验 / 重复止损 / 遥测 / 落盘顺序） | `src/agent/tool-gate.js`（流程 + 冻结关卡清单） | **已收敛**：`ToolHarnessSession` 只留会话状态与重试；**已删** Renderer `agent-guardrails.js` 三个无人调用的止损薄包装 + 恒 false 的 `replyClaimsFileWork` 死分支。见 [`TOOL-GATE.md`](TOOL-GATE.md) |
| 12b | 完成验收（证据采集 + 判定） | `src/agent/completion-readiness.js`（Main 唯一来源） | **已迁移**：原 Renderer 规则门、`verifyTargetCompletion` 空壳、summary 正则抠 exit code、诊断伪 trace 轮次、`readinessRetry` 死分支全部删除；Renderer 只 `applyReadinessNote`。见 [`AGENT-STRATEGY.md`](AGENT-STRATEGY.md) §4.3 |
| 13 | 执行能力边界（能不能写、能不能越界跑） | `src/gateway/sandbox-policy.js`（三档判定，唯一来源）、`sandbox-approvals.js`（ask-once） | **策略层已实施**：`read-only` / `workspace-write` / `danger-full-access` + 越界问一次（拒绝/超时即拒）；`exec-policy.js` 的高危词表已并到同一份。**内核级强制（受限令牌 / AppContainer）未做**。见 [`SANDBOX.md`](SANDBOX.md) |

---

## D. 应对“过时”的处置策略

按腐坏速度排序，从最快到最慢：

| 腐坏类型 | 典型资产 | 处置 |
|---|---|---|
| **兼容垫片**（模型换代即失效） | `guardrails-shared.js` `TOOL_NAME_ALIASES`(15，**全仓单一来源**) / `GRAPH_LEGACY_OPS`(7)、`llm-tool-call-fallback.js` 参数表(50) | **观察使用率后删除**；不要无限增长。工具名别名表已合并到 `guardrails-shared.js`（`llm-tool-call-fallback.js` 改为 require 引用同一对象），由 `test:guardrails-sync` 断言两侧一致 |
| **模型行为假设** | 核心准则 21 条、`compaction-prompts.js` 强制 JSON/字数 | 用**行为回归**（同批任务看工具轨迹）而非字符串快照；改前跑 `test:agent-system-prompt` |
| **调参值** | `agent-limits.js` 全部 49 项（+3 折算系数不上设置页） | 已配置化（设置 UI + tier 分层），**改配置不改代码** |
| **环境事实** | `IGNORE_DIRS`/`KNOWN_TEXT_EXT`、`CALL_SKIP`、`BLOCKED_PATTERNS`、`url-policy` 扩展名 | 腐坏慢；新增语言/工具时补 |
| **UI 分类词表** | `renderer-skills-grid.js` 127 词 + 14 正则 | 新增技能时补；不影响行为 |

**建议的 review 节奏**：
1. **每次模型换代**：复查 `D` 表前两行，跑 `npm run test:agent` + `test:agent-full`。
2. **每次发布**：跑 `npm test`，抽查 §C 的 11 项是否仍一致。
3. **每季度**：清点 §A2/A3 词表元素使用率，删除长期零命中的别名/兼容项；更新本文件行号。

**已有测试兜底**（改动对应资产后应跑）：

| 资产 | 测试命令 |
|---|---|
| `agent-limits.js` | `npm run test:agent-limits` |
| `guardrails-shared.js` / Main 护栏 | `npm run test:agent-limits` |
| `guardrails-shared.js` 别名表 / `llm-tool-call-fallback.js` | `npm run test:guardrails-sync` + `npm run test:llm-tool-call-fallback` |
| `agent-system-prompt.js` | `npm run test:agent-system-prompt` |
| `system-prompt-prep.js` | `npm run test:system-prompt-prep` |
| `task-tier.js` | `npm run test:task-tier` |
| `write-smell-hints.js` | `npm run test:write-smell-hints` |
| `crates/.../agent/` | `npm run test:rust-agent-loop-smoke` |
| `crates/.../planner/` | `npm run test:rust-planner-smoke` |
| `src/gateway/` | `npm run test:local-gateway-smoke` |
| 全量 | `npm run test:agent` / `test:agent-full` |

---

## E. 维护约定

1. 本文件行号会随代码漂移，**改动 `agent-limits.js` / `agent-system-prompt.js` / `guardrails-shared.js` / `planner/prompts.rs` 时应同步更新**。
2. 新增硬编码规则前先问：能否改为 `agent-limits.js` 配置？能否用结构信号替代词表？
3. 新增 prompt 前先搜 §B 是否已有同类实现，避免加重 §C 的重复。
4. 数字上限**只改** `agent-limits.js`（`AGENTS.md` 原则 6）。

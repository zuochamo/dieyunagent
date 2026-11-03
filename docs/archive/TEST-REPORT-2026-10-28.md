# dieyunagent 全量测试报告（2026-10-28）

> 结论先行，逐项列证据。执行者：DSH 会话 `session-a4f4d694`；被测工作区：`E:\dieyunagent`（分支 `main`，HEAD `f6fb470`，工作树含 **208 个未提交改动文件，+12403 / −9916**，由两个并行 agent 会话产出）。

---

## 0. 结论

**没有功能回归。64 个可执行测试入口全部通过（含 Rust 154 项单测、vitest 1355 项单测、真机 SSH 验收 2/2、`npm test` 整体链路 39 项 ALL OK），另有 24 项端到端功能探针全部通过。发现 2 个「行为/可观测性」观察项（经比对 HEAD 确认均非本次改动引入），0 个新回归。**

三条要点：

1. **两个并行会话的改动面都经受住了验证**：代码索引 / 结构索引整改（Rust `index/`、`graph/`、`memory/`、`embedding/`）与 SSH 模块整改（`src/ssh/`、`src/remote/`）——索引侧由 `cargo test` 154 项 + 12 项功能探针覆盖，SSH 侧由 9 个套件 + 真机（192.168.31.62）两次验收覆盖。
2. **两个观察项不阻塞交付**：①`codebase.search` 的向量通道没有绝对相关性阈值、分数又按头名归一化 → 任意查询都返回 k 条且分数接近 1.0；②启动自愈线程与 schema 初始化争同一个写连接，导致部分首次启动会打印一条误导性的「FTS 重建后写入仍失败」。详见 §5。
3. **5 个入口按规则未执行**（聚合命令 / 需真实 LLM / 生成器类），逐条列原因，未静默略过（§6）。

---

## 1. 被测对象与测试前置

### 1.1 等待并确认其他会话收工（本次任务的第一段）

| 会话 | 在做的事 | 收工判定 |
|---|---|---|
| `session-b3631fb2` | 「代码索引 / 结构索引过时设计」整改 + bug 审计（`crates/dieyun-core/src/{index,graph,memory,embedding,fts.rs}`、`src/gateway/handlers/{codebase,graph}.js`） | 最后一帧 `turn/end`（turn 8），文件 5 分钟无增长 |
| `session-39ca889a` | SSH 模块 P1–P5 整改 + bug 修复 + 真机验收（`src/ssh/*`、`src/remote/*`） | 最后一帧 `turn/end`（turn 13），文件 5 分钟无增长 |

判定手段：解压 `~/.dsh/sessions/--E-dieyunagent--/<id>/session.v4.jsonl.zstd` 的**最后一帧**（逐帧 zstd 解压），检查是否为 `turn/end`；同时轮询进程表确认没有 `test-*` / `cargo` / `rustc` 在跑。两者**同时**空闲 323 秒、且无测试/构建进程后才开测（避免抢端口、抢 CPU 造成假失败）。

### 1.2 环境与二进制

| 项 | 值 |
|---|---|
| 平台 / Node | Windows，node v24.21.0 |
| Rust | cargo / rustc 1.96.0 |
| 被测 sidecar | **`target/release/dieyun-core.exe`（23:03 新构建，1m38s）** |
| 为何不用 `build/dieyun-core/dieyun-core.exe` | `npm run pack:dieyun-core` 复制产物时 **EBUSY**：`npm run dev` 的常驻实例（PID 47592）正持有该 exe；本次用 `DIEYUN_CORE_BIN` 指向新构建的 release 二进制，并另跑 `npm run test:dieyun-core-pack` 验证打包逻辑本身 |
| 串行策略 | 全部经 `.agents/skills/full-test/scripts/run-batch.cjs` 串行执行：单套件失败自动重跑一次、超时杀整棵进程树、失败不中断后续 |

---

## 2. 覆盖与结果汇总

| # | 功能域 | 入口数 | 结果 |
|---|---|---|---|
| A | 静态检查 + 仓库契约 | 6 | **6/6 PASS** |
| B | 单元测试（vitest） | 1（1355 例） | **PASS** |
| C | Agent 循环与交付 | 12 | **12/12 PASS** |
| D | 沙箱与权限 | 4 | **4/4 PASS** |
| E | 工具与编辑 | 7 | **7/7 PASS** |
| F | SSH / 远端 / 内网互通 | 9（含真机 2） | **9/9 PASS** |
| G | 会话 / UI / 移动端 / SCM / Worktree / MCP / 更新 | 14 | **14/14 PASS** |
| H | Rust core 与 sidecar 链路 | 7 + cargo | **7/7 + 154/154 PASS** |
| I | 内置 embedding 向量链 | 1 | **PASS**（1265 向量） |
| J | 打包产物校验 | 2 | **2/2 PASS** |
| K | 整体链路 `npm test`（按 git diff 选测） | 39 | **ALL OK（2m08s）** |
| L | 功能探针（端到端，独立于单测） | 24 断言 | **24/24 PASS** |

合计 **64 个可执行入口 + 24 项功能断言，0 FAIL**。

---

## 3. 逐项测试明细

### A. 静态检查与仓库契约（6/6 PASS）

| 入口 | 实际命令 / 覆盖 | 结果 |
|---|---|---|
| `check:js` | `tsc -p tsconfig.check.json --noEmit`（scoped checkJs：JSDoc 类型与跨模块签名） | PASS |
| `lint:agent` | `eslint "src/agent/**/*.js" "scripts/test-*.cjs"` | PASS |
| `check:contracts` | `scripts/check-repo-contracts.cjs`（仓库契约：分层边界、单一来源、禁用词表等） | PASS |
| `verify:agent-events` | AgentRunEvent 文档 ↔ 代码一致性（`--check`） | PASS |
| `verify:rpc-catalog` | RPC 目录生成物 ↔ 代码一致性（`--check`） | PASS |
| `check:renderer` | `check-renderer-globals.py` + `check-renderer-critical.py`（Renderer 全局泄漏 / 关键路径） | PASS |

### B. 单元测试（PASS，1355 例）

`test:unit` → `vitest run`：**137 个测试文件 / 1355 个测试全部通过**，用时 43.89s。覆盖纯函数层（JSON 修复、rrule、脱敏、路径归一、MCP 计划装配、readiness note 去重、host-exec 长任务、console hook 等）。

### C. Agent 循环与交付（12/12 PASS）

| 入口 | 该套件钉住的功能契约 | 结果 |
|---|---|---|
| `test:agent-round-text` | 交付四态 + 真思考提取（`agent_status` 协议与中文占位词表删除后的现状） | PASS |
| `test:llm-channel` | `classifyDelta` 通道归属必须与既有 golden 一致（思考不顶正文的通道身份） | PASS |
| `test:agent-run-events` | `AgentRunEvent` 事件契约（trace / stream / tool / done） | PASS |
| `test:agent-limits` | `agent-limits.js` 单一来源的数字上限（总步数、同工具同参数止损等） | PASS |
| `test:task-tier` | `taskTier` 策略分层与护栏联动 | PASS |
| `test:guardrails-sync` | Main `tool-guardrails` 与 `guardrails-shared` 常量/逻辑不分叉 | PASS |
| `test:tool-gate` | 工具关卡顺序（校验 → 止损 → 遥测 → 落盘）只在 `tool-gate.js` 声明 | PASS |
| `test:tool-harness` | 工具 harness 会话的调用/结果配对与失败传播 | PASS |
| `test:agent-system-prompt` | 系统提示词规则装配（含【Agent 准则】段） | PASS |
| `test:system-prompt-prep` | 上下文注入路由（纯文本不注入 codebase 上下文等） | PASS |
| `test:session-context` | 会话级上下文（工作区/编辑器快照）装配 | PASS |
| `test:request-snapshot` | 请求快照契约「模型看到了什么」写入 + 保留裁剪（需 sidecar） | PASS |

### D. 沙箱与权限（4/4 PASS）

| 入口 | 覆盖 | 结果 |
|---|---|---|
| `test:sandbox-smoke` | 三档沙箱能力的端到端冒烟 | PASS |
| `test:sandbox-policy` | 三档判定 + ask-once 审批契约（纯函数，无 UI 依赖） | PASS |
| `test:sandbox-gateway` | 真 Gateway、真文件、真命令的档位 + ask-once 端到端 | PASS |
| `test:sandbox-real` | 临时目录测不出来的真实路径（越界审批、符号链接等） | PASS |

### E. 工具与编辑（7/7 PASS）

| 入口 | 覆盖 | 结果 |
|---|---|---|
| `test:fs-edit` | `fs-edit-file` 编辑实现（精确替换、多重匹配、编码/换行） | PASS |
| `test:write-smell-hints` | 写坏味道提示（替身键归一含 step4b 中段数字、扩展名不同不算同族等） | PASS |
| `test:delegate-batch` | 批量委派（子任务切片与结果聚合） | PASS |
| `test:tool-bridge-delegate` | 工具桥的委派路径（Main 侧执行，不经 Renderer） | PASS |
| `test:llm-tool-call-fallback` | 残缺 tool_calls 文本的降级解析 | PASS |
| `test:llm-reconnect-retry` | LLM 断流重连 / 重试预算 | PASS |
| `test:reviewer-json` | reviewer 输出 JSON 解析与 reason 保留 | PASS |

### F. SSH / 远端 / 内网互通（9/9 PASS，含真机）

| 入口 | 覆盖 | 结果 |
|---|---|---|
| `test:ssh-reconnect-targets` | 自动重连目标解析（连接意图 → 有效参数） | PASS |
| `test:session-remote-transport` | 「远端 Agent 信息」按会话隔离的传输（不再按 socketPath 单键） | PASS |
| `test:workspace-remote-runtime` | 远端工作区运行时（daemon / socket / workspace 路由） | PASS |
| `test:remote-pack` | 远端 core 打包（glibc 目标闸门等） | PASS |
| `verify:remote-agent-socket` | **真机**：SSH 直连 + 真实部署 + 真实 RPC（16 项断言，含两工作区单进程、零端口、退出零残留、kill 后自动重建） | PASS（192.168.31.62） |
| `verify:remote-agent-fs` | **真机**：远端文件读写走 RPC 通道（`remote-agent-fs`）、`index.notify_change` 回传 | PASS（192.168.31.62） |
| `test:peer` | 内网互通地基：身份稳定、配对码校验、超长正文截断、未知类型丢弃 | PASS |
| `test:peer-mesh` | 两端实例同进程互连的端到端（送达 / 跳数 / 预算 / 租约冲突 / 会话绑定 / presence） | PASS |
| `test:peer-tools` | 内网工具的「协调器形状 → 模型可见形状」映射 | PASS |

> 说明：`verify:remote-agent-*` 是**环境门控**脚本（需 `DY_SSH_HOST` / `DY_SSH_USER` / `DY_SSH_PW_FILE` / `DY_WS_BASE`）。首轮无该环境时按退出码 2 报「缺环境」，不是产品失败；随后用真实主机参数重跑，2/2 PASS（密码只从 `%TEMP%\dy_ssh_pw` 读取，未进命令行/仓库）。

### G. 会话 / UI / 移动端 / SCM / Worktree / MCP / 更新（14/14 PASS）

| 入口 | 覆盖 | 结果 |
|---|---|---|
| `test:phase5-handlers` | 拆分后的 gateway handlers + 真 LocalGateway RPC（冒烟 ALL OK） | PASS |
| `test:composer-queue` | Composer 排队与插入语义 | PASS |
| `test:main-shell` | Main 侧 IPC/窗口外壳装配 | PASS |
| `test:mobile` | 手机端桥接与服务（`src/mobile/`、`src/agent/service.js`） | PASS |
| `test:worktree` | Worktree 基线（「一旦回归就静默毁数据」的路径） | PASS |
| `test:scm` | 真跑 git 的 SCM 场景（临时仓库自配身份） | PASS |
| `test:mcp-store` | MCP 存储 / 预装产物版本单一来源 | PASS |
| `test:app-updater-feeds` | 更新源（feeds）解析 | PASS |
| `test:monitor-outbox` | 监控待发队列（outbox）语义 | PASS |
| `test:knowledge-maintainer` | 记忆归纳（Main 侧唯一实现） | PASS |
| `test:project-memory-file` | 项目记忆文件「谁来写、写到哪个工作空间」 | PASS |
| `test:planner-parallel` | Planner 并行分发 | PASS |
| `test:dieyun-core-pack` | `pack:dieyun-core` 打包逻辑（版本/产物/校验） | PASS |
| `test:browser-smoke` | 内置浏览器（会话/导航）冒烟 | PASS |

### H. Rust core 与 sidecar 链路（7/7 + 154/154 PASS）

| 入口 | 覆盖 | 结果 |
|---|---|---|
| `cargo test -p dieyun-core` | **154 项**：sqlite 读池/写连接调优、index 增量、graph 抽取与查询、treesitter 分块/提取、memory FTS 与 scope 重挂、embedding 并发一致性 | PASS（13.3s） |
| `test:local-gateway-smoke` | Local Gateway + runWorkspaceRoot + compaction 分 session（20/20 断言 ALL OK；含历史白名单用例） | PASS |
| `test:core-bridge` | core-bridge ↔ dieyun-core 联通、索引与检索基本通路 | PASS |
| `test:rust-loop-runner` | Rust 循环账本 runner 与 Node 侧事件对齐 | PASS |
| `test:rust-planner-pipeline` | Planner 流水线 | PASS |
| `test:rust-agent-loop-smoke` | agent.loop 端到端 smoke | PASS |
| `test:rust-planner-smoke` | planner smoke | PASS |
| `test:lsp` | LSP 定位 / 诊断链路 | PASS（**须先清 `ELECTRON_RUN_AS_NODE`**，见 §5.5） |

### I. 内置 embedding 向量链（PASS）

`npm run test:builtin-embedding-rust src/agent`（小目录变体，按基线不跑全仓）：
- 索引写入 **1265 个向量**，签名 `builtin:bge-base-zh-v1.5@768`（模型与维度一致）；
- 检索 `vectorSearch: true`，5 条命中，首条 `run-events.js`。

### J. 打包产物校验（2/2 PASS）

| 入口 | 覆盖 | 结果 |
|---|---|---|
| `verify:asar` | `dist/win-unpacked` 的 app.asar 内容清单与源码一致性 | PASS |
| `verify:mcp-bundled` | 离线预装 MCP 产物（版本/校验和来自 `src/mcp/registry.js`） | PASS |

### K. 整体链路 `npm test`（39 项 ALL OK，2m08s）

`npm test` 按 `git status` 的 208 个改动文件自动选测，实际选中 **39 项**：
`check:contracts, cargo:test, test:core-bridge, test:agent-limits, test:task-tier, test:tool-harness, test:rust-loop-runner, test:agent-system-prompt, check:renderer, test:guardrails-sync, test:agent-run-events, test:rust-agent-loop-smoke, test:request-snapshot, test:session-context, test:system-prompt-prep, test:tool-bridge-delegate, test:tool-gate, test:local-gateway-smoke, verify:rpc-catalog, test:knowledge-maintainer, test:project-memory-file, test:sandbox-real, test:unit, test:scm, test:lsp, test:monitor-outbox, test:phase5-handlers, test:mcp-store, test:worktree, test:ssh-reconnect-targets, test:main-shell, test:workspace-remote-runtime, test:mobile, test:remote-pack, test:fs-edit, test:llm-tool-call-fallback, test:reviewer-json, test:peer, check:js`
→ 链路未中断，末尾 `[dieyun:test] OK`（exit 0）。

---

## 4. 功能探针（端到端，24/24 PASS）

> 目的：单测是「函数级」的，索引/图谱/记忆这条链路的真实行为要用**真 sidecar + 真 SQLite + 真文件**验。探针脚本：`%TEMP%\dieyun-fulltest\probe-functions.cjs`，结果 JSON 同目录 `probe-results.json`。夹具：临时工作区 5 个文件（含中文注释、路径词、依赖关系）。

| ID | 功能 | 断言 | 实测 | 结果 |
|---|---|---|---|---|
| F0-1 | core 连通 | `core.ping` 返回引擎信息 | `{engine:rust, ok:true, version:0.1.0}` | PASS |
| F1-1 | 代码索引 | 全量建索引：fileCount≥5 且 chunk>0 | 5 文件 / 12 块 / 12 向量 | PASS |
| F1-2 | 代码索引 | `codebase.status` 与建索引结果一致（计数不漂移） | 两项完全相同 | PASS |
| F2-1 | 检索 | 英文标识符 `computeTotal` → `src/orders.js` | 命中，首位即 orders.js | PASS |
| F2-2 | 检索 | 中文 4 字 `订单总价`（trigram 路径）→ orders.js | 命中 | PASS |
| F2-3 | 检索 | 中文 2 字短词 `退款`（短词/LIKE 路径）→ `docs/notes.md` | 命中，首位即 notes.md | PASS |
| F2-4 | 检索 | 仅路径出现的词 `pricing` → `src/pricing-engine.js` | 命中 | PASS |
| F2-5 | 检索 | 无关查询：文本通道零命中、向量通道返回近邻且头名归一化为 1（既有设计） | 8 条近邻、`textHit=false`、`topScore=1` | PASS（行为已钉住，见 §5.1） |
| F3-1 | 增量索引 | 新增文件后增量可见 | `src/returns.js` 命中 | PASS |
| F3-2 | 增量索引 | 改文件后正文/snippet 已是新内容（无陈旧文本） | snippet 为 `processRefund`，`staleText=false` | PASS |
| F3-3 | 增量索引 | 删文件后索引与计数同步下降 | 6→5 文件、14→12 块/向量，旧符号零命中 | PASS |
| F4-1 | 结构索引 | `graph.index` 建图谱 | 4 符号 / 2 边 | PASS |
| F4-2 | 结构索引 | `graph.symbol_search createOrder` | 命中 orders.js | PASS |
| F4-3 | 结构索引 | `graph.callers createOrder` 找到调用点 | `callerPath=src/billing.js`（confidence 0.8） | PASS |
| F4-4 | 结构索引 | `graph.repo_map` 返回骨架 | 1429 字节骨架 | PASS |
| F4-5 | 结构索引 | `graph.module_deps billing.js → orders.js` | `to:src/orders.js`，circular 为空 | PASS |
| F5-1 | 记忆 | `memory.session_create` | 返回 `s-…` 会话 id | PASS |
| F5-2 | 记忆 | `message_append` + `messages_recent` 回读 | 内容完整回读 | PASS |
| F5-3 | 记忆 | global 长期记忆写入 + 召回 | `mode` 为 keyword/semantic，命中「整数分」 | PASS |
| F5-4 | 记忆 | `project_resolve`：scope 恒为 `project:<id>` | `scope=project:1` | PASS |
| F5-5 | 记忆 | 项目 scope 写入 + 同 scope 召回 | `mode=keyword`，命中「三步审批」 | PASS |
| F5-6 | 记忆 | global 召回不串项目条目（scope 隔离） | 结果全是 `global` | PASS |
| F6-1 | 向量检索 | 内置 embedding 写向量并签名 | 12 向量，`builtin:bge-base-zh-v1.5@768` | PASS |
| F6-2 | 向量检索 | 语义查询「折扣计算」走向量通道 | `vectorSearch=true`，命中 orders/pricing-engine | PASS |

---

## 5. 失败与异常分类

**新回归：0 个。** 下列 2 项为「行为/可观测性观察」，经与 HEAD 比对确认**不是本次改动引入**；5 项为环境或预算类，已按基线判定。

### 5.1 观察项｜`codebase.search` 向量通道没有绝对相关性阈值（P3，非回归）

- **现象**：`--no-embedding` 时无关查询返回 0 条；开启 embedding 后，任意查询（哪怕是 `zzz_not_exist_symbol_qqq`）都返回 k 条近邻，且 `score` 是「相对头名归一化」的值（头名恒为 1.0，其余 0.96–0.99）。
- **根因**：`crates/dieyun-core/src/index/search.rs:vector_hits()` 取 `pool.scan_into` 的 top-m，**无余弦下限**；结果分数在 `search()` 里按 `score / top` 归一化。`git show HEAD:.../search.rs` 同样是这套逻辑 → **既有设计，不是回归**。
- **影响**：`codebase.search` 无法表达「没找到」；agent 上下文可能被注入语义相近但无关的文件，且分数看起来都很自信。
- **建议**：加绝对余弦阈值（如 0.35，可按 int8 量化误差界留余量）或同时返回绝对分数；改前先在 `docs/VECTOR-SEARCH.md` 记录阈值依据。

### 5.2 观察项｜启动自愈与 schema 初始化争写锁，首启会打印误导性 FTS 警告（P3，非回归）

- **现象**（`test:builtin-embedding-rust` 启动即现，**清空数据目录后依旧复现**）：
  ```
  [core] [dieyun:memory] FTS 索引重建后写入仍失败：long_memories 的写入路径可能已被其它损坏阻塞
  [core] [dieyun:memory] 账本自愈失败（下次启动重试）: database is locked
  ```
- **根因**：`memory/mod.rs:246` 起的 `dieyun-memory-prune` 后台线程在 `open()` 后立即跑 `reconcile_memory_ledger()`，与主线程 `memory/schema.rs` 的 schema 初始化/FTS 探针抢同一个写连接；探针（`SAVEPOINT … UPDATE long_memories SET status=status …`）拿不到锁 → 走到 warning 分支。
- **实际影响**：**数据无损**——探针 F5-3/F5-5 证明关键词召回仍工作；自愈只是一次幂等 UPDATE，下次启动会重试。但这行日志会把排障引向「库损坏」，属于可观测性缺陷。
- **建议**：自愈线程等 schema 初始化完成再跑（同一把初始化锁/一次性信号），或把 FTS 探针挪进初始化事务内；warning 文案区分「locked（稍后重试）」与「malformed（需重建）」。

### 5.3 环境｜`pack:dieyun-core` 复制产物 EBUSY（不阻塞）

`npm run dev` 的常驻实例持有 `build/dieyun-core/dieyun-core.exe` → `copyfile` 报 EBUSY。release 编译本身成功（1m38s）。本次测试用 `DIEYUN_CORE_BIN` 指向新构建的 `target/release/dieyun-core.exe`。**要刷新 `build/` 下的 sidecar 必须先退出 dev 实例。**

### 5.4 环境｜`verify:remote-agent-socket` / `verify:remote-agent-fs` 缺环境时报退出码 2（不阻塞）

首轮无 `DY_SSH_HOST`/`DY_WS_BASE` → 脚本明确提示缺环境并退出 2。补齐真实主机参数（192.168.31.62 / dieyunx / `%TEMP%\dy_ssh_pw` / `/run/media/dieyunx/Data/ceshi`）后 **2/2 PASS**。

### 5.5 环境｜`test:lsp` 在 `ELECTRON_RUN_AS_NODE=1` 宿主下必假失败（基线 #3，已复现并排除）

宿主（DSH 以 `ELECTRON_RUN_AS_NODE=1` 启动）把该变量注入 `process.env`，`childEnvForCommand('npx')` 对非 `process.execPath` 命令原样返回 `process.env`，断言 `ELECTRON_RUN_AS_NODE == null` 因此不成立。清空该变量后本套件 **PASS**。

### 5.6 预算｜`test:builtin-embedding-rust` 全仓默认超时（基线 #1，未触发）

按 skill 只跑小目录变体（`src/agent`，几分钟内过）。全仓默认 600s 预算 < 实测约 13 分钟，属容量问题，未在本次执行范围内。

---

## 6. 未执行项与原因

| 入口 | 原因 |
|---|---|
| `test:agent` / `test:agent-full` | 聚合命令，逐项内容已在本报告 C/H 段单独跑过，重复执行无新增信息 |
| `test:renderer` | 与 `check:renderer` 同一实现，已在 A 段执行 |
| `test:rust-agent-loop` | 需要真实 LLM 配置（`DIEYUN_USER_DATA` 指向含 model-settings 的目录）才算有意义，本机未提供 |
| `verify:bundled-skills` | 该命令是**生成器**（`prepare-bundled-skills.mjs`），会改写 `skills/bundled/`；按 skill 规则默认不跑，避免弄脏工作树 |

---

## 7. 建议（按优先级）

1. **P3** 给向量通道加绝对相关性阈值，并让 `codebase.search` 能表达「没找到」（§5.1）——当前行为会让 agent 拿到「假命中」。
2. **P3** 修启动期写锁竞争，让 FTS 探针/自愈在 schema 初始化之后跑，并把 warning 文案分档（§5.2）。
3. **P4** `pack:dieyun-core` 复制前检测目标 exe 是否被占用，给出「请先退出 dev 实例」的明确提示，而不是 EBUSY 栈（§5.3）。
4. **P4** 把这轮的观察项写进 `docs/`（向量阈值取舍、自愈时序），避免下次排障重复考古。

---

## 附录 A：执行命令（可复现）

```powershell
# 0) 等两个会话收工后
$env:ELECTRON_RUN_AS_NODE=$null
$env:DIEYUN_CORE_BIN='E:\dieyunagent\target\release\dieyun-core.exe'   # 新构建的 sidecar

# A 静态与契约
node .agents/skills/full-test/scripts/run-batch.cjs check:js lint:agent check:contracts verify:agent-events verify:rpc-catalog check:renderer
# B 单元
node .agents/skills/full-test/scripts/run-batch.cjs test:unit
# C Agent 循环与交付
node .agents/skills/full-test/scripts/run-batch.cjs test:agent-round-text test:llm-channel test:agent-run-events test:agent-limits test:task-tier test:guardrails-sync test:tool-gate test:tool-harness test:agent-system-prompt test:system-prompt-prep test:session-context test:request-snapshot
# D+E 沙箱 / 工具
node .agents/skills/full-test/scripts/run-batch.cjs test:sandbox-smoke test:sandbox-policy test:sandbox-gateway test:sandbox-real test:fs-edit test:write-smell-hints test:delegate-batch test:tool-bridge-delegate test:llm-tool-call-fallback test:llm-reconnect-retry test:reviewer-json
# F SSH / 远端 / peer（含真机两项，需环境变量）
node .agents/skills/full-test/scripts/run-batch.cjs test:ssh-reconnect-targets test:session-remote-transport test:workspace-remote-runtime test:remote-pack verify:remote-agent-socket verify:remote-agent-fs test:peer test:peer-mesh test:peer-tools
# G 会话 / UI / 移动端 / SCM / MCP
node .agents/skills/full-test/scripts/run-batch.cjs test:phase5-handlers test:composer-queue test:main-shell test:mobile test:worktree test:scm test:mcp-store test:app-updater-feeds test:monitor-outbox test:knowledge-maintainer test:project-memory-file test:planner-parallel test:dieyun-core-pack test:browser-smoke
# H Rust 与 sidecar 链路
cargo test -p dieyun-core
node .agents/skills/full-test/scripts/run-batch.cjs test:local-gateway-smoke test:core-bridge test:rust-loop-runner test:rust-planner-pipeline test:rust-agent-loop-smoke test:rust-planner-smoke test:lsp
# I embedding 小目录变体
npm run -s test:builtin-embedding-rust src/agent
# J 打包产物
node .agents/skills/full-test/scripts/run-batch.cjs --no-retry verify:asar verify:mcp-bundled
# K 整体链路
npm test
# L 功能探针
node %TEMP%\dieyun-fulltest\probe-functions.cjs
```

## 附录 B：证据文件

> 2026-11-03 文档清理：`docs/test-artifacts-2026-10-28/` 下的原始证据已删除（一次性测试残留），如需重跑见 `scripts/` 与下方 `%TEMP%` 可复现命令。

| 文件 | 内容 |
|---|---|
| `docs/test-artifacts-2026-10-28/probe-results.json`（**已删除**） | 24 项功能探针的期望值 / 实测值 / 证据（入库归档） |
| `docs/test-artifacts-2026-10-28/npm-test.log`（**已删除**） | `npm test` 完整日志（39 项选中 + ALL OK，入库归档） |
| `%TEMP%\dieyun-fulltest\cargo-test.log` | `cargo test -p dieyun-core` 完整日志（154 项） |
| `%TEMP%\dieyun-fulltest\probe-functions.cjs` | 探针脚本（可重跑；如需长期保留可移入 `scripts/`） |

---

*报告生成时间：2026-10-28 23:20（Asia/Shanghai）；执行窗口 22:39–23:20，其中 22:39–23:04 用于等待两个并行会话收工。*

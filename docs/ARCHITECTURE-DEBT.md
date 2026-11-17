# 架构技术债台账（2026-11 审查 · 持续更新）

> **这份文档存在的唯一理由**：2026-11 那次架构审查列出的「明显过时项」里，只有三项被裁决并已落地。
> 其余几条**仍然原样**，而且中间几轮没有人回头报告「它们没被顺手解决」。
> 下次接手的人读这里，不要以为「都修完了」。
>
> - 每条都带**当前工作树里的证据**（`文件:行`），不引用改造前快照。
> - 每条都写清「**动什么算完**」，避免只做一半。
> - 状态图例：`未动` / `半条` / `需决策` / `已完成`。

---

## 0. 已完成（20+ 轮，2026-11-17）

原审查排第一的是**循环的切分方式**：一个 agent 循环被切成三段（Rust 账本 / Node 控制流 / Node HTTP），每轮跨进程 3 次、messages 全量搬 2 次。这一条**已经反过来**。

| 维度 | 之前 | 现在 | 落点 |
|---|---|---|---|
| 谁驱动轮次 | Node 的 `while` | core 的 `driver::drive` | `crates/dieyun-core/src/agent/driver.rs` |
| 谁发 LLM | Node（`llm-stream-utils.js`） | core（`agent/llm.rs`），宿主经 RPC `llm.complete` | `crates/dieyun-core/src/rpc/mod.rs` |
| transcript 写者 | 两个（Node `set_messages` + core 折叠） | **只有 core**（账本上的 `set_messages` 方法已删除） | `agent/loop_run.rs` |
| 压缩 | 滚雪球 LLM 摘要 + 伪造 assistant 回执 | 就地折叠（保 `tool_call` 骨架、幂等档位、usage 触发） | `compaction/fold.rs` |
| 溢出 / 拒图自愈 | Node 发现 → 回写 messages → 重发 | core 内部折叠 / 摘图 → 重发一次 | `driver.rs` |
| 可观测性 | 宿主正则刮 core 的 stderr（`[compaction-llm]`） | 结构化事件通道（`type:"event"`）+ 反向调用（`type:"call"`） | `rpc/events.rs`、`rpc/calls.rs` |
| 向量后端 | 只有远端 HTTP + 三层补偿 | 本地 `ort` 推理优先，补偿层整体删除 | `embedding/local.rs` |

主循环的跨进程边界现在只剩两处，且都是有理由的：**工具执行**（平台能力在 Node）与 **`round.prepare`**（每轮请求级装配）。

提交序列：`d4b86e8` `f36f15b` `f0c87f6` `c33152c` `1337a59` `eb9dd82` `f39fa7f` `cebb9a7` `1ac66ec` `e6bf829`，以及更早的折叠 / 向量 / 循环搬迁提交。

---

## 1. 本地 IPC 比远端还旧 · `未动`

| | |
|---|---|
| **现状证据** | 本地：`src/gateway/server.js:53` `DEFAULT_PORT = 17330`、`:141` `gateway-token.txt`、`:1123` `new WebSocketServer({ host:'127.0.0.1', port })`。远端：`src/remote/minimal-gateway-host.js:429-436` 注释明写「`socketPath` 指向用户私有的 AF_UNIX socket；没有 TCP 端口、没有 token —— 安全边界就是文件权限（目录 0700 / socket 0600）」 |
| **为什么过时** | 两条链路方向相反：远端按 2026 的做法（本地 socket + 文件权限），本地反而是要占端口、惹防火墙、用 token 文件当门禁的 2015 做法。端口冲突 / 防火墙弹窗 / token 文件丢失都会变成用户可见故障 |
| **动什么算完** | 本地默认走 **AF_UNIX socket（Linux/macOS）/ 命名管道（Windows）**，鉴权交给文件系统权限；TCP + token 只在「显式配置远程/调试」时保留。客户端连接处（`core-bridge` 之外的 gateway 客户端）同步改 |
| **风险** | 需要一次兼容窗口：现有安装里 `gateway-token.txt` 与 17330 端口要先探测再迁移；Windows 命名管道权限模型与 AF_UNIX 不同（不要抄 UN*X 的 0600 语义） |
| **优先级** | 高（用户可感知） |

## 2. 日志被当 IPC 用 · `半条`

| | |
|---|---|
| **现状证据** | **具体做法已消除**：`core-bridge.js` 里转 `[compaction-llm]` → `compaction.progress` 的解析已删，只剩 `:268` 一句提到 `[rpc-slow]` 的注释与 `:61-77` 的 stderr 尾巴（纯排障用）。**但可观测性没建**：core 里 `eprintln!` **13 处**、`tracing`/`opentelemetry` **0 处** |
| **为什么过时** | 事件通道有了，但「慢在哪、第几轮、花了多少 token」仍要从人类日志里读。翻文档里那些「只能靠猜」「无从判断卡在哪」，根因就在这里 |
| **动什么算完** | 关键路径产出**结构化事件**而非人类日志：RPC 耗时（替代 `[rpc-slow]`）、折叠事实（已有 `compacted`）、每轮 usage（已有 `agent.usage`）、工具执行耗时。宿主侧直接消费，不再 grep |
| **风险** | 不要一步跳到 OTel GenAI semconv：那是「引入依赖 + 决定导出端点」的独立决定。先做「事件化」，OTel 留作后续 |
| **优先级** | 中高（排障价值大，改动局部） |

## 3. 词法检索是 `LIKE '%…%'` 全表扫 · `未动`

| | |
|---|---|
| **现状证据** | `crates/dieyun-core/src/index/search.rs:118-124`（注释自陈「通道 1：词法 = 子串扫描，`LIKE '%term%'`」「v4 起没有 FTS 倒排表」）、`:408` |
| **为什么过时** | 命中按「命中词数」排序，没有 bm25；语料一大就退化成全表扫 |
| **动什么算完** | FTS5 + `bm25()` 一行 SQL（中文需要合适的分词/`unicode61` 配置）。**注意**：`search.rs:120` 说「trigram 索引占库 40% 只换来 bm25」——那是 trigram 的代价，不是 bm25 的；不要用这个理由否决 FTS5 |
| **风险** | 分词选型会影响召回（中文尤其）；需要保留现有子串通道作为兜底并可对比命中 |
| **优先级** | 中（用户说的是「低成本」，我同意 —— 但要先量一次真实语料） |

## 4. 向量是 int8 全表暴力扫 · `未动（按既有结论不该动）`

| | |
|---|---|
| **现状证据** | `crates/dieyun-core/src/vector_pool.rs`（3GB 池上限）；`docs/VECTOR-SEARCH.md §4` 已写明换 ANN 的触发条件：>200 万向量 / P95 > 300ms / dim ≥ 1024 |
| **为什么现在不动** | 原审查实测 33k 向量 ~350ms，**未触发**。加 HNSW（sqlite-vec / usearch）是复杂度与召回率的交易，不到触发线不做 |
| **动什么算完** | 只有触发条件被满足才动；届时按 `VECTOR-SEARCH.md §4` 执行，别凭感觉换 |
| **优先级** | 低（有明确闸门） |

## 5. token 估算是字符比启发式，且没回灌校准 · `半条`

| | |
|---|---|
| **现状证据** | `crates/dieyun-core/src/compaction/tokens.rs`：`cjk/1.5 + other/3.2`；图片按 `visionPartEqChars(6000) / 3.2 = 1875` 折算；**触发口径**已改成服务端 `usage.prompt_tokens`（`loop_run.rs` 的 `observed_prompt_tokens`），但**估算没有用 usage 回灌校准** |
| **为什么过时** | 已经拿到真实用量，却只用它判断「要不要折」，不用它修正「估得准不准」 |
| **动什么算完** | 用 `usage.prompt_tokens` 与本地估算的比值做滑动校准（按模型 + 通道），落到可观测的系数上；估算与真实值偏差有上限告警 |
| **风险** | 别做成「每轮动态调参」的抖动源；校准应是低频、可回滚的 |
| **优先级** | 中低（精度问题，不是结构问题） |

## 6. `request_snapshots` 每轮存整份 prompt · `未动`

| | |
|---|---|
| **现状证据** | `crates/dieyun-core/src/memory/snapshot.rs:41` `messages_json: String`（`:44-49` 已存 `messages_hash` / `system_hash` / `tools_hash`） |
| **为什么过时** | 曾占到库体 86%。现在虽然写了 hash 可以判重，但**整份 prompt 仍在每轮落库** |
| **动什么算完** | 「hash 行 + 压缩 blob（或仅存 diff）」，同 hash 复用上一行；保留裁剪策略不变 |
| **风险** | 快照的用途是「模型看到了什么」的取证，压缩后仍需能还原出可比对的文本 |
| **优先级** | 中低 |

## 7. 比 Rust 更旧的是 JS 这一侧 · `未动（最大、最慢）`

| | |
|---|---|
| **现状证据** | `src/renderer/index.html` **122 个 `<script src>`** 按顺序加载；`src/agent/tool-validate.js` **1109 行**手写参数校验；`src` 下 JS（排除 `dist`）**16.1 万行**；零 ESM、零 TS（`tsc --checkJs` 只做检查）；靠脚本查全局命名污染维持秩序 |
| **为什么过时** | Rust↔Node 的契约两边手写：这边 serde struct，那边手写校验，靠注释约定「字段务必逐字对齐」（`loop_run.rs` 里那条测试注释就是自白）。契约应由类型/schema 生成 |
| **动什么算完** | 分两刀，不要一起做：<br>① **契约生成**：从 Rust 的 serde struct / `rpc-catalog` 生成 JS 侧的校验与类型声明，删掉手写对照表；<br>② **模块化**：逐模块 ESM 化（一次一个，带构建闸门），`<script>` 顺序依赖是隐式契约，不能批量改 |
| **风险** | ② 的隐式顺序依赖 + 全局符号污染：必须先有「全局符号调用点计数」的闸门（本轮我就踩过：删掉一个导出，`node --check` 与单测都过，但三个 module 在运行时 import 它）。① 相对安全 |
| **优先级** | ① 中高；② 低（单独排期，别混在功能改动里） |

## 8. 工具定义可能有两份注入点 · `需核实`

| | |
|---|---|
| **现状证据** | `AGENTS.md` 自己列出两处：`src/renderer/renderer-tool-defs.js`（聊天）与 `src/agent/main-agent-tools.js`（计划 / 频道 / headless）。**我尚未把两边导出与 `tool-catalog.js` 做对比** |
| **为什么算债** | 两份 schema = 两份漂移可能；AGENTS.md 已把它列为风险但没给「谁合谁」 |
| **动什么算完** | 一次逐字段对比，产出一张差异表；能合的合到 `tool-catalog.js`，不能合的写清理由 |
| **优先级** | 先核查再谈（核查成本低，合并成本未知） |

## 9. Renderer 保留了一整套降级 loop · `需决策`

| | |
|---|---|
| **现状证据** | `renderer-agent-run.js:1` 的全局依赖里同时有 `chatCompletionWithToolsViaRust` 与 `isDieyunCoreReady`：`runAgentCompletion` 是**分派器** —— core 就绪走 Rust，未就绪（`DIEYUN_CORE=0` / sidecar 挂了）走旧渲染层 loop；`renderer-agent-send.js:712` 仍调用它。这就是 `renderer-agent-{loop,run,complete,continue,resume,compaction,prep,tools}.js` 至今没死的原因 |
| **为什么算债** | 「有没有 core」的分叉在 Renderer 里，等于主链路有两份实现。本轮已把它的**传输**收口到 IPC → core（不再自己 fetch/SSE），但**控制流分叉仍在** |
| **两条路，选一条** | ① **保留降级**：必须在文档与代码里写清「这是降级通道，不是主路径」，并给它一条 smoke（否则它会静默腐烂）；<br>② **删掉降级**：`DIEYUN_CORE=0` 时明确告知「不可用」，删掉的那 2000+ 行不再维护 |
| **优先级** | 高（决定影响后面所有清理的范围） |

---

## 附录 A · 按「用户可感知度」排序的施工顺序建议

1. **§1 本地 IPC 换 socket/pipe**（端口冲突、防火墙弹窗、token 文件丢失 → 用户直接感知）
2. **§9 降级 loop：留还是删**（决定清理范围，越早越好）
3. **§2 结构化事件**（排障成本）
4. **§3 FTS5 bm25**（检索质量）
5. **§7① 契约生成**（消灭手写对照表）
6. §5 / §6 / §8（精度、库体、核查）
7. §4（等触发线）、§7②（单独立项）

## 附录 B · 维护规则

- **每条改动落地后回到这里改状态**，并把证据行号更新（行号会漂）。
- **新发现的过时设计**按同样格式追加：现状证据 / 为什么过时 / 动什么算完 / 风险 / 优先级。
- **不要在本文档里写「计划」而不写「证据」**：没有 `文件:行` 的条目一律视为未核实。
- 与 `docs/ARCHITECTURE.md`（现状手册）分工：那边写「现在是什么样」，这里写「哪里还旧、旧在哪、怎么算修完」。

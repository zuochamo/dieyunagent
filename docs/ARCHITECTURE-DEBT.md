# 架构技术债台账（2026-11 审查 · 持续更新）

> **这份文档存在的唯一理由**：2026-11 那次架构审查列出的「明显过时项」里，只有三项被裁决并已落地。
> 其余几条**仍然原样**，而且中间几轮没有人回头报告「它们没被顺手解决」。
> 下次接手的人读这里，不要以为「都修完了」。
>
> - 每条都带**当前工作树里的证据**（`文件:行`），不引用改造前快照。
> - 每条都写清「**动什么算完**」，避免只做一半。
> - 状态图例：`未动` / `半条` / `需决策` / `已完成`。
>
> **2026-11-17 更新**：§1（本地 IPC）与 §9（降级 loop）已施工完毕，见各自条目。
> §9 那条要特别注意：**原始描述已经不准了** —— 降级 loop 早在 LLM 收口那几轮就没了，
> 本轮补的是「缺 core 时明确不可用」这件小事。剩下 §2 / §3 / §5 / §6 / §7 / §8 仍未动。

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

## 1. 本地 IPC 比远端还旧 · `已完成（2026-11-17）`

| | |
|---|---|
| **原证据** | 本地：`DEFAULT_PORT = 17330`、`gateway-token.txt`、`new WebSocketServer({ host:'127.0.0.1', port })`。远端：`src/remote/minimal-gateway-host.js:429-436` 早就写「`socketPath` 指向用户私有的 AF_UNIX socket；没有 TCP 端口、没有 token —— 安全边界就是文件权限（目录 0700 / socket 0600）」 |
| **现在是什么样** | Renderer **不再持有 WebSocket**：`renderer-gateway.js:rawGatewayCall` 只调 `window.diecloud.gatewayRpc` → `main/ipc/gateway-shell.js`（`gateway:rpc`）→ `LocalGateway#invokeRpc`。本地监听默认是**私有端点**：POSIX `<userData>/gateway.sock`（目录 0700 / socket 0600）、Windows 命名管道 `\\.\pipe\dieyun-gateway-<userData 摘要>`；**不再写 `gateway-token.txt`**（TCP 模式下才写）。端点唯一来源 `src/gateway/local-endpoint.js`。TCP + token 只在显式 `DIECLOUD_GATEWAY_PORT` 时保留。网页版（headless `--web`）由 `headless/desktop-ui.js:bridgeGatewaySocket` 在同源 `/gateway` 上翻成同一份 `invokeRpc`，shim 给渲染层同一个 `gatewayRpc`/`onGatewayEvent`。 |
| **与原计划的差异（为什么这么改）** | 原计划是「本地默认 socket，客户端连接处同步改」。实际取证发现真正的消费者是 **Renderer**，而它是 Chromium —— **连不了** socket / 命名管道；同时它与 Gateway 本来就同进程。所以正确解法是把这一跳换成 Main IPC（Renderer 一个 WebSocket 都不再持有），私有端点只留给「**另一个本机进程**想驱动同一个 Gateway」。TCP 现在唯一的仓内消费者是 `scripts/verify-index-effectiveness.cjs`（已改为默认连私有端点），因此它留在显式配置后面。 |
| **证据（改动落点）** | `src/gateway/local-endpoint.js`；`src/gateway/server.js`（`_startListener` / `_listenUnix` / `_wireConnection` / `getInfo` / `onEvent` / `_publishEvent`）；`src/main/ipc/gateway-shell.js`（`gateway:rpc` + `gateway:event`）；`src/preload.js`（`gatewayRpc` / `onGatewayEvent`）；`src/renderer/renderer-gateway.js`；`src/headless/desktop-ui.js`；`src/headless/boot.js`（单实例提示改成端点探测） |
| **风险 / 没做的** | 不需要兼容窗口：外部没有任何安装依赖 `gateway-token.txt`，旧文件留着不读（可手删）。Windows 管道权限沿用系统默认 ACL，**没有**额外 SDDL 收紧 —— 那是另一件事，需要单独验证。SSH 远端那套（`minimal-gateway-host`）本来就是这个模型。 |
| **测试** | `test/unit/local-gateway-endpoint.test.cjs`（端点解析 / 残留 socket 清理 / 私有端点免 token 的 `auth+call` / 事件订阅）、`test/unit/gateway-ipc-bridge.test.cjs`（`gateway:rpc` 与 `gateway:event` 的契约）、`test/unit/headless-desktop-ui.test.cjs`、`scripts/test-headless-desktop-ui.cjs`、`npm run test:local-gateway-smoke`、`npm run test:headless` |

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
| **排期落在哪** | ① 已细化成 [`docs/NODE-THINNING-PLAN.md`](NODE-THINNING-PLAN.md) 的 N1.3（RPC 字段契约生成）+ N2.1（工具校验从 schema 生成）+ N1.1/N1.2（跨语言常量与一致性 fixture）；② 的入场券是 N4.1（渲染层零调用点闸门）。**改这块先看那份清单，别在这里重新拍一遍** |

## 8. 工具定义可能有两份注入点 · `需核实`

| | |
|---|---|
| **现状证据** | `AGENTS.md` 自己列出两处：`src/renderer/renderer-tool-defs.js`（聊天）与 `src/agent/main-agent-tools.js`（计划 / 频道 / headless）。**我尚未把两边导出与 `tool-catalog.js` 做对比** |
| **为什么算债** | 两份 schema = 两份漂移可能；AGENTS.md 已把它列为风险但没给「谁合谁」 |
| **动什么算完** | 一次逐字段对比，产出一张差异表；能合的合到 `tool-catalog.js`，不能合的写清理由 |
| **优先级** | 先核查再谈（核查成本低，合并成本未知） |

## 9. Renderer 保留了一整套降级 loop · `已完成（裁决：删；2026-11-17）`

| | |
|---|---|
| **重新取证的结果（重要）** | 这条的原始描述**已经过时**：降级 loop 的控制流早就不在了。`renderer-agent-run.js` 不再是分派器（core 未就绪直接抛），非 Rust 的 `chatCompletionWithTools` 全仓 **0 处**，`renderer-agent-llm.js` 的 `fetchChatCompletion` / `streamChatCompletion` 已收口到 Main → core（渲染层没有直连 HTTP、没有 SSE 解析）。所以「删掉 2000+ 行」这一步**不需要再做** —— `renderer-agent-{loop,run,complete,continue,resume,compaction,prep,tools}.js` 现在各自都有活：会话胶水、交付四态、prep、trace 落库。 |
| **那一轮实际缺的是什么** | 「`DIEYUN_CORE=0` 时明确告知不可用」这件事没有单一来源：判据散在 planner / rust 两个分支里各抛一次错，文案各写一句，且都是**跑到一半**才炸（气泡已建、prep 已跑）。 |
| **本轮落地** | ① 单一判据 + 单一文案：`renderer-agent-rust-loop.js:requireAgentRuntime()` / `AGENT_RUNTIME_UNAVAILABLE`；② `renderer-agent-run.js:runAgentCompletion` 顶部一处断言（发送 / 继续 / 目标续跑**都**经过它），删掉两个分支里重复的 `!isDieyunCoreReady()` 抛错；③ 发送闸门 `renderer-agent-send.js:gateSendMessage` 在动手前就拒绝并给一条用户可见提示（与「尚未配置可用模型」同一层，不再先建气泡再失败）。 |
| **为什么没有「保留降级 + 补 smoke」这条路** | 保留降级 = 主链路两份实现（一份 Rust 循环 + 一份 Renderer 循环），且要长期养一条只为降级存在的 smoke。既然 core 已经是唯一循环实现，缺 core 就该是「不可用」，不是「换个地方跑」。 |
| **证据** | `src/renderer/renderer-agent-rust-loop.js:requireAgentRuntime`、`src/renderer/renderer-agent-run.js`（函数顶部断言）、`src/renderer/renderer-agent-send.js:gateSendMessage`（能力闸门） |
| **测试** | `npm run check:renderer`（globals/critical 仍认 `runAgentCompletion`/`gatewayCall`）；能力缺失路径靠人工核对：`DIEYUN_CORE=0` 启动后点发送应得到一条红色气泡提示且不建运行态 |

---

## 附录 A · 按「用户可感知度」排序的施工顺序建议

1. ~~**§1 本地 IPC 换 socket/pipe**~~ —— **已完成**（2026-11-17）：Renderer 改走 Main IPC，本地监听换私有端点
2. ~~**§9 降级 loop：留还是删**~~ —— **已裁决：删**（2026-11-17）：loop 早已不存在，缺 core 现在明确告知不可用
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

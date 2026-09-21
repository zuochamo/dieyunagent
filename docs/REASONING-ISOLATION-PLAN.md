# 思考通道隔离 · 目标设计（根治方案）

> 状态：**已实施（提交 1-5 + H4 + 提交 6）**，逐条进度见 §5 与 §1 各表的 ✅ / ⚠️ 标注；
> 通道身份由入口盖章（`llm-channel.js`），账本记事实（`ContentChannel` / `TraceRound.contentSource`），
> 交付四态收口于 `agent-round-text.resolveTurnDelivery()`；跨边界文本契约见 §3.7（D3 / D4 已落地）；
> 仅剩 `提交 0` 取证重放。
> 目标：让「思考绝不进正文 / 思考绝不进本地上下文」成为**结构事实**，而不是靠多处启发式碰运气。
> 取证工具：[`LOGGING.md` § LLM 原始响应体抓包](./LOGGING.md)（`DIEYUN_LLM_RAW_LOG`）

---

## 0. 结论先行

现在做不到。原因不是「少了一条 if」，而是**代码里没有「这段文本是思考还是正文」的第一性事实** ——
只有 5 处互相独立、阈值还不同的启发式在**猜**（Rust 1 处、Node 4 处，其中 3 处逐字重复）。

根治办法是把「通道身份」变成**数据**：在**唯一入口**给每段文本盖章，下游只搬运、不再判断。
以此替换掉 11 处判断点 + 2 份重复解析 + 2 份重复占位。

---

## 1. 现状：11 处泄漏/猜测点（全部 `file:line`）

### A. 正文 ← 思考（「思考进了正文」）

| # | 位置 | 行为 |
|---|---|---|
| A1 | `crates/dieyun-core/src/agent/loop_run.rs:54` `content_or_reasoning()`（被 `:76` `delivered_content()` 用作交付正文） | 正文为空时用 `reasoning` 顶替（≥24 字、排除 `<tool_call`） |
| A2 | `src/agent/agent-round-text.js:166` `thoughtFallbackCoversSynthesis()` + `:181` `pickNormalizedAssistantReply()` | 同一策略的 Node 版：思考 ≥48 字当交付、≥24 字当正文 |
| A3 | `src/agent/agent-synthesis.js:43` `thoughtFallbackFromTrace()` → `:162-165` | 把 trace 最近 4 轮的 `fullThought`/`thought` 拼起来**直接写进 `done.content`** |

A1 与 A2 是**同一策略的两份实现，阈值 24 / 48 不一致** → 同一轮内容在 Rust 与 Node 可能得到不同归属。

**✅ 已全部删除**（提交 4 / 5）：A1 → `delivered_content(content, channel)` 只认非思考通道，正文空即 `None`；
A2 → `resolveTurnDelivery()` 四态决策（**无任何长度阈值**）；A3 → `thoughtFallbackFromTrace()` 已删，
交付只能来自 `answer` / 带标签的 `reasoning-fallback` / 汇总 LLM。

### B. 思考 ← 正文（「正文进了思考区」）

| # | 位置 | 行为 |
|---|---|---|
| B1 | `loop_run.rs:516-521` | `thought_raw = reasoning 非空 ? reasoning : stored_content` —— 无 reasoning 的模型，整段正文被存成「思考」 |
| B2 | `src/agent/live-loop-trace.js:187-198` | `thoughtSource = reasoning \|\| contentOnly \|\| rawContent`；无 reasoning 时 `liveContent = ''` |
| B3 | `src/plans/plan-run-events.js:169-183` | 同上，第二份 |
| B4 | `src/renderer/renderer-agent-rust-loop.js:702-717` | 同上，第三份（单通道 `content` → 思考，`liveContent = ''`） |

B2/B3/B4 **逐字重复**；B1 是 Rust 侧第四份。

**✅ 已全部删除**：B1 → `llm_thought_raw()` 只取思考通道（`reasoning` 键，或单通道模型的 `content` 键），
不再拿正文兜底；B2/B3/B4 → 三处判定改为消费入口盖章的 `channel`（提交 2），
账本侧另有 `TraceRound.contentSource` / `visibleContent` 作为**事实**（提交 4）。

### C. 占位文本进上下文（污染 prompt）

| # | 位置 | 行为 |
|---|---|---|
| C1 | `src/agent/reasoning-backfill.js` `backfillReasoningContent()`（由 `rust-loop-runner.js` 注入 `requestBody.messages`） | 历史 assistant 缺 `reasoning_content` 时补假文本 `'（思考内容未随消息保存）'` **（已合并为单一来源）** |
| C2 | ~~`src/renderer/renderer-agent-llm.js:521-531`~~ **已合并** → 同上，Renderer 经 `window.ReasoningBackfill` 消费 | 判定与 C1 统一为「本轮 hasTools 或该消息 tool_calls」 |
| C3 | `loop_run.rs:379-388` `push_assistant_text_only()` | 触顶轮把合成文本 `"已达本段 N 轮上限"` 写进 messages |

C1/C2 本身是症状：`session-context.js:829` 重建历史**只带 `content`**（见 D1），真思考在落库那步就丢了，于是只能在发送前**现编**。

**✅ 已处理**（提交 3 / 4 / 5）：真思考从落库那步就不再丢（`messages.reasoning`，§3.5），
`backfillReasoningContent` 改为**真值优先**（账本 `reasoning` → `reasoning_content`），占位只在真值不可得时触发；
C3 → `push_assistant_text_only()` 写进 messages 的合成文本已标 `synthetic: true`，账本记 `ContentSource::Synthetic`。

### D. 历史 / 上下文（思考回流）

| # | 位置 | 行为 |
|---|---|---|
| D1 | `src/agent/session-context.js:801-829` `buildCompletionMessagesFromHistory()` | assistant 只取 `assistantTextFromMessage()`，**不带 `reasoning_content`** → 真思考丢失 |
| D2 | `src/agent/session-transcript.js` `TRANSCRIPT_FIELDS` / `projectTranscriptMessage`（**✅ 已落地**） | 账本投影改为**字段白名单 + 浅拷贝**：只保留 `role` / `content` / `tool_calls` / `tool_call_id` / `name`，**排除 `reasoning_content`** 与 UI 字段（`meta` / `transientTrace`）。出站侧另有 wire 白名单（`sanitizeMessagesForChatApi`），两层职责分离。 |
| D3 | `src/agent/subagent-runner.js:116-124` | 子 Agent 摘要**以 trace 的 `thought`/`fullThought` 为唯一来源**回注主上下文 → 思考跨 Agent 进上下文 |
| D4 | `src/agent/service.js:254-261, 275-282` | `traceText = trace.map(fullThought \|\| thought).join('\n')` 作为 run 的可回读文本 |

**D3 ✅ / D4 ✅ 已实施**（提交 6，契约见 §3.7）：`buildTraceFactsDigest()` 只回注 / 只喂**工具事实**；
`traceText` 整条链路（Main live 拼接、Renderer `formatTracePlain`、Rust `agent_traces.trace_text` 列）全部删除。

**D1 ✅ 已反转**（提交 5）：`assistantTextFromMessage()` 只投影 `content`（+ 工具事实兜底），
**不再**把 `message.reasoning` 或落库 trace 里的思考当正文读回；同时新增 `messages.reasoning` 与 content **分列**落库，
重建出的 completion 消息带 `reasoning` 作为**同级传输字段**（供上行回传真值），不进正文语义。
### E. 压缩（思考被当摘要长期驻留上下文）

| # | 位置 | 行为 |
|---|---|---|
| E1 | `crates/dieyun-core/src/compaction/llm.rs:203-216` `extract_completion_text()` | `content` 空 → 回退 `reasoning_content` → 回退 `reasoning`。压缩模型是思考模型时，**整份摘要可能是思考** |

**✅ 已处理**（提交 4）：`extract_completion_text()` 拆为「正文抽取」与「思考抽取」两条通道，
摘要只取正文；正文空即判失败，不再用 `reasoning_content` / `reasoning` 冒充摘要。
### F. 入口解析重复（最该盖章的地方有两份）

| # | 位置 | 行为 |
|---|---|---|
| F1 | `src/llm-stream-utils.js:8-15` `extractDeltaReasoning()` + `:17-56` `emitParsedSseJson()` + `:59` `processSseTextChunk()` | Main 侧 |
| F2 | `src/renderer/renderer-agent-llm.js:871-914, 916, 973-980`（+ `:956-971` `repairDeltaMojibake` 再扫一遍三键） | Renderer 侧**逐字重复** |

`reasoning_content` 全仓只出现在 6 个源文件：`loop_run.rs`、`compaction/llm.rs`、`rust-loop-runner.js`、
`llm-stream-utils.js`、`renderer-agent-llm.js`、`llm-raw-tap.js`。其中**解析 2 份、回填 2 份、通道判定 4 份**。

### G. 「DeepSeek 硬校验」的真相与归属（本方案的事实基础）

**它不是我方校验，是上游约束 + 我方注释。** 全仓**没有**本地校验/抛错逻辑：

- Rust 侧 grep `deepseek|mimo|claude|openai|qwen`，在 `crates/dieyun-core/src` **只命中 `loop_run.rs:548-549` 这一行注释**
  —— 没有模型名硬编码；
- Node 侧唯一「响应 400」的代码是 `rust-loop-runner.js:313-331` `markReasoningDiag()`：
  正则匹配错误信息里的 `reasoning_content`，只往 `err.message` 追加诊断串，**不改变行为**；
- 硬编码的是**策略**而不是模型名 —— `rust-loop-runner.js:304`：
  `needsField = !!hasTools || (Array.isArray(m.tool_calls) && m.tool_calls.length > 0)`，
  只要本轮带 tools 就给**每一条** assistant 消息补 `reasoning_content`（有真值保留、缺的补占位，`:306`），
  **完全不区分模型**；
- 该行为已被测试固化：`scripts/test-rust-loop-runner.cjs:1089-1123`，其中 `:1113` 断言
  「tools 请求要给普通 assistant 补占位」。

**真值只活在单次 run 的内存里** —— 这是「删了不行、留着有害」的根源：

```
Node/Main ──HTTP + SSE──> 上游
  ├─ onDelta → onPhase('llm_delta', {content, reasoning})          rust-loop-runner.js:384 / :410
  ├─ normalizeLlmResponse: reasoning = msg.reasoning_content || msg.reasoning   :897-903
  └─ RPC agent.loop.continue { runId, llm: llmResp }               :804-807 ──> Rust 账本
                                                        └─ 工具轮回传真值 loop_run.rs:550-552
```

run 一结束、历史从 `book` 重建（D1：`session-context.js:829` 只带 `content`），真思考即丢 →
Node 那层**每次续跑补的都是假值**。故现状里「补占位」是**常规路径**，不是兜底。

**归属：判定必须在入口，账本事实必须在 Rust。**

| 层 | 该在哪 | 现状 |
|---|---|---|
| 原始判定（哪个键 / 单通道分流） | Node/Main 入口，**只做一次** | `llm-stream-utils.js` 一份 + `renderer-agent-llm.js` 一份（后者为残留） |
| 账本事实（本轮正文=？思考=？`contentSource`） | **Rust**（持 `messages` + `TraceRound`） | **缺** → 才逼出 A1 / B1 的 `\|\|` 兜底 |
| 展示判定（`thought` / `visibleContent`） | 一个共享模块 | 3 份（`live-loop-trace` / `plan-run-events` / `renderer-agent-rust-loop`） |

Rust 收到的是已被 `normalizeLlmResponse` 压平的 `{content, reasoning}` 两个裸字符串，**看不到原始键**；
所以「通道身份只在 Rust 判定」的前提是先把 LLM HTTP/SSE 搬进 Rust —— 与 AGENTS.md 分层明文
（「对话 LLM 与工具执行在 Main/Node；Rust 做循环账本」）冲突，属架构级重定，不在本方案内。
本方案取的是「**入口盖章（Node）→ 账本落字段（Rust）**」：`llm_delta` 事件也确实由 Node 发出
（`crates/dieyun-core/src/agent/mod.rs` 里 `llm_delta` 零命中）。

**仓库自证**：`docs/LOGGING.md:29-43` 已把「库里区分不了正文与思考」写成已知限制
（「`TraceRound`（只有合成结果，区分不了）」「`thought_raw = reasoning || content` —— 两者落库前已经合成一段文字」），
并且只能靠 `DIEYUN_LLM_RAW_LOG` 抓包区分 —— 这正是 §3 要消灭的状态。

**残留清单（非"Node 整体残留"，而是三处具体重复）**：

1. `src/renderer/renderer-agent-llm.js:871-980` + `:1032-1180`：Renderer 第二份 SSE 解析与推理通道。
   文件本身**是活的**（`fetchChatCompletion:624` / `streamChatCompletion:1178` 被
   `renderer-knowledge-maintainer.js:447,784`、`renderer-agents-md.js:615`、`renderer-agent-reviewer.js:92-100`、
   `renderer-agent-loop.js:79` 调用），
   但**这些调用方只要 `content`**（知识维护 / reviewer / AGENTS 冷启动）→ 推理通道那段是
   重复实现 + 无真实消费者；
2. `src/agent/live-loop-trace.js:187-198` 与 `src/plans/plan-run-events.js:169-183`：两份 `llm_delta` 消费逻辑逐字重复；
3. `docs/LOGGING.md:29-43` 本身：因 Rust 把两通道合成一段，只能靠抓包区分 —— 缺陷自证。

---

## 2. 根因

1. **「通道身份」不是一等公民**：`reasoning_content` 只是**一个可能存在的 JSON 键**，谁都能读、谁都能当正文用。
2. **`content` 被迫承担两种语义**：既是「正文」，又是「单通道模型（如 mimo）的思考」。
   判定依据（本轮有没有出现 `reasoning` 字段）**只在流式那一刻可得**，之后全丢 → 每个消费点只能自己重猜。
3. **`wire`（上行载荷）与 `book`（本地账本）共用一份 messages**：
   DeepSeek 硬要求工具轮回传 `reasoning_content`（`loop_run.rs:548-552`），产品要求思考不进本地上下文。
   一份数组服务两个矛盾目标，只能靠占位补丁妥协。
4. **策略没有单一来源**：A1↔A2 两份、B1↔B2↔B3↔B4 四份、C1↔C2 两份、F1↔F2 两份。

---

## 3. 目标设计

### 3.1 三个不变式（可测）

- **I-正文**：交付正文只可能来自上游 `choices[].delta.content`，或本轮**明确标注为合成**的 synthesis 结果。
  `reasoning` 永不**静默**成为正文。
- **I-思考**：思考区只显示 `reasoning`；`content` 永不进思考区。单通道模型的 `content` 按**能力表**在入口分流，
  不在展示层猜。
- **I-账本**：`book`（落库历史）只存正文与用户消息；`wire`（上行 messages）按上游协议需要回传思考。二者不同源。

### 3.2 `channel`：通道身份的唯一来源

新增 `src/agent/llm-channel.js`（Main / Renderer 共用，经 `agent-bundle-entry.js` 注册，与 `agent-round-text.js` 同层）：

```js
// 模型能力表：结构声明，不是关键词表（符合 AGENTS.md「禁用意图关键词硬编码」）
//   reasoningField : 上游思考字段名；'' = 该模型没有独立思考通道
//   singleChannel  : 只有一个字段、且语义是推理（如 mimo）→ content 进思考
//   echoReasoning  : 工具轮 assistant 必须回传思考（DeepSeek 思考模式）
getChannelPolicy(model) -> { reasoningField, singleChannel, echoReasoning }

// 入口盖章：全流程唯一把上游 JSON 变成「带身份的文本」的地方
classifyDelta(delta, policy) -> [{ channel: 'reasoning' | 'answer', text, source: 'upstream' }]
```

能力表挂在既有模型元数据侧（`src/model-settings.js`），按 `model` 匹配 —— 与模型配置同一事实源，不新造词表。

**盖章之后，下游不再有 `||` 判断**：

- B2 / B3 / B4 三份重复判定**删除**，改为消费 `{channel, text}`；
- `extractDeltaReasoning()` 与 `renderer-agent-llm.js:973-980` 的副本**删除**，只留 `classifyDelta`；
- `renderer-agent-llm.js:871-980` 的 SSE 解析整段**删除**，改为复用 `llm-stream-utils`
  （Renderer 复用同源实现已有先例：`agent-bundle-entry.js:172-196`）。

### 3.3 Rust 账本层：正文与思考不再互相顶替

`LlmResponseInput` 补 `content_channel: Answer | Reasoning | Absent`（`content` / `reasoning` 已有）：

- `delivered_content()`：**删除** reasoning 兜底 → 正文空就是空，交由 Node 显式处理（见 3.4）；
- `thought_raw`：**删除** `unwrap_or_else(stored_content)` → 不采集思考的模型，思考区就是空，不再复述正文；
- `TraceRound` 补 `visibleContent`（`plan-run-events.js:91` 已有雏形）与 `contentSource`；
- `push_assistant_text_only()` 的合成文本带 `synthetic: true`，使「合成内容」与「模型原文」后端可区分。

### 3.4 交付决策：单一来源 + 显式降级

把「正文为空怎么办」收到 `src/agent/agent-round-text.js` **一处**（删除 A1、A3 各自那份），分四态：

| 情形 | 交付 | 标签 |
|---|---|---|
| 有正文 | 正文 | `answer` |
| 无正文、有思考、**因预算/轮次截断** | 思考原文 + 「（以下为模型思考，本轮未成文）」 | `reasoning-fallback`（**显式**，不伪装成正文） |
| 无正文、有思考、**正常收尾** | 走既有 synthesis 链路 | `synthesis` |
| 都无 | 「模型未生成文字答复」 | `empty` |

`reasoning-fallback` 在 UI 上复用思考区的引用样式，且**不写进 book** —— 这样 D1 的历史重建永远拿不到它，
「思考不进上下文」才是落地的，而不是靠下游自觉。

### 3.5 账本 vs 上行：真思考落库，回传时取真值

- `book` 增加**独立字段** `reasoning`（与 `content` 并列、不混），`session-context.js:801-829` 重建时**不读它**；
- 上行由 `src/agent/llm-request.js`（端点与请求头唯一来源，AGENTS.md 指定）统一处理：
  按 `getChannelPolicy(model).echoReasoning` 决定是否回传，回传时取该轮**真实** reasoning；
- 真值不可得（老数据 / 压缩后）才补占位，文案与 `synthetic: true` 一起集中在该模块，**删除** C1 / C2 两份实现。

改造后「补占位」从常规路径降级为异常兜底 —— 这是与现状最大的行为差异。

### 3.6 压缩：宁可跳过，不把思考当摘要

`compaction/llm.rs:203-216` 删除 reasoning 兜底 → 空摘要直接走既有错误分支
`"压缩模型返回空内容（未写入摘要，已跳过压缩）"`(`:172-175`)。
理由：一段思考冒充摘要长期驻留上下文，比「本轮不压缩」危害大得多。

### 3.7 跨边界文本契约（D3 / D4）：没有结论就只给事实

§3.4 / §3.5 管的是**一次运行内部**的两条边界（交付、账本）。还剩两条**跨边界**文本 ——
它们不是「展示 vs 账本」，而是「一个 Agent 的产物 → 另一个消费者的输入」，口径必须另行定义：

| 边界 | 现状实现 | 缺陷 |
|---|---|---|
| 子 Agent → 主 Agent 上下文（**D3**） | `subagent-runner.js` 无正文时用 `buildSynthesisDigest(trace)`（`thought`/`fullThought` 拼接）当「已完成的发现」回注 | 思考是子 Agent 的**私有推理**，含中间猜测与元评论；主 Agent 无法区分「它查到的」与「它猜的」，且这是**跨 Agent** 污染 |
| 一次运行 → 「可回读纯文本」（**D4**） | 两处各拼一份：Main `service.js` 的 `trace.map(fullThought \|\| thought).join('\n')`、Renderer `formatTracePlain()` → `agent_traces.trace_text` | 同名字段**两个来源**（违反单一来源）；且两个字段**读者为零**（下方逐处核对） |

#### 契约 1（D3）：跨 Agent 只允许「正文 ∪ 工具事实」

回注给协调者的文本，只允许由三类材料构成：

- **正文**：`child.content` —— 有正文时它就是结论本身（截断时显式标注「可能不完整」）；
- **工具事实**：`entry.tools[]` 的 `name` / `argsBrief` / `summary` / `error`（工具层已归纳的事实）；
- **结构信号**：`hitRoundLimit` / `reason` / `truncated`（协调者据此决定重派还是换问法）。

**禁止**：`thought` / `fullThought`（完整与否都一样），以及 UI 过场文案（`请求中` / `正在准备` / `生成中`）。

理由：①思考里是**过程猜测**，越界即被当事实；②这条边界不该比账本更宽松 ——
账本正文也只认 `content`（§3.5），跨 Agent 回注没有理由放宽；③一旦为子 Agent 开口，
「思考只在展示层」就重新变成「多处启发式碰运气」。

代价（有意接受）：子 Agent 若把结论只留在思考里（没写进正文），协调者只能拿到工具事实 ——
这是**如实**的代价，由子 Agent 提示词「结论先行 / 查不到就说查不到」（`buildSubagentPrompt`）负责，
而不是靠回注思考兜底。

实现：`buildSynthesisDigest()` → **`buildTraceFactsDigest()`**（只输出工具行），一次改动同时覆盖两个消费者：
①子 Agent 回注摘要（D3）②汇总 LLM 的【Agent 执行过程摘要】（§3.4 `synthesis` 态）。
文案同步：`SUMMARY_HEAD_*_WITH_TRACE` 的「已完成的发现」→「已完成的工具调用记录」。

#### 契约 2（D4）：没有读者的派生文本不是契约，整条删掉

先摆事实（逐处核对过）：

- `agent.trace_get` 的两个读者都**只读 `trace`**：Renderer `hydrateAssistantTraceFromStore()`（`row.trace`）、
  移动端 `trace.get`（`trace.trace` / `streamContent`）；
- `service.js` live 分支的 `active.traceText` 与 Rust 终态列 `agent_traces.trace_text` **没有任何读者**；
- 同一语义两个生产者：`formatTracePlain()`（Renderer，终态写库）与 `service.js` 的 thought-join（Main，live 读回）。

契约：**「可回读纯文本」不是一等概念**。跨边界可回读的只有**结构化 `trace`**（事实源）；
展示用纯文本一律由展示层从 `trace` **现场格式化**，不落库、不出 RPC。

据此删除整条链路：

- Main `service.js`：删 `active.traceText`（两处拼接）与 `getTrace()` 出参里的 `traceText`；
- Renderer `trace-store.js`：终态 `trace_save` 不再传 `traceText`（`withTraceText` 参数一并删除），
  `formatTracePlain()` 因无调用点而删除；
- Rust：`agent.trace_save` 忽略 `traceText` 入参、`get_agent_trace` 不再出 `traceText`，
  `agent_traces.trace_text` 从 schema 移除（老库 best-effort `DROP COLUMN`；失败也不影响读写）。

理由：这两个字段的存在让「思考被当可回读文本」看起来像一个**契约**（有人写、有列存、有 RPC 出参），
实际读者为零；保留只会让下一个人以为它是权威事实，继续往里塞思考。

---

## 4. 关键取舍（先说清楚再决定）

1. **DeepSeek `reasoning_content` 回传是上游约束，不是我方校验**（`loop_run.rs:548-552` 注释；无本地校验逻辑，见 §1 G）。
   所以「思考绝不进上行 messages」在协议层**做不到**。本方案取的是：思考进**上行协议载荷**（按需回传真值），
   但绝不进 `book`、绝不进摘要、绝不静默当正文。
   - **不能裸删 C1**：删掉当下不报错，但真思考落库前，每一轮带 tools 的续跑都会被上游 400 ——
     现在是靠假占位挡住 400，代价是把「（思考内容未随消息保存）」喂给模型。
     顺序必须是**先落真值（§3.5），再让占位降级为罕见兜底**；
   - **Rust 那份（`loop_run.rs:550-552`）不能删**：它是同一轮里唯一的真值来源；
   - 若要求「连上行也不出现」，唯一替代是**对这些模型在 tools 场景禁用思考模式**，代价是失去推理能力 —— 不建议。
2. **预算截断轮的「正文」会变成带标签的思考引用**（3.4）。观感变化是有意的：它本来就是思考。
3. **删掉 `content || reasoning` 系列兜底会让既有断言失败**：
   `loop_run.rs:904`、`:997` 与 `scripts/test-rust-loop-runner.cjs` 有 6 处 `reasoning_content` 断言，需同步改写为「断言不兜底」。
4. **影响面**：Rust 契约（`LoopResponse` / `TraceRound` / `LlmResponseInput`）、
   Node（`llm-stream-utils` / `rust-loop-runner` / `llm-request` / `session-context` / `session-transcript`）、
   Renderer（4 处 trace 构建 + SSE 解析去重）、文档（`docs/agent-run-events.md`、`docs/rpc-catalog.md`）。
5. **回归重点**：单通道模型（mimo）正文判定、预算截断交付、DeepSeek 工具轮 400、subagent 摘要。

---

## 5. 实施清单（按提交切分，每步独立可验收）

> 约定：每步一个独立提交，可单独 review / 单独回滚。除注明外，**先落地身份（1）、再切消费方（2）、再收敛补丁（3）、再删兜底（4）、最后收口交付（5）** —— 顺序不可颠倒，否则会在真值落库前产生上游 400（见 §4.1）。
> 命令均在仓库根目录、PowerShell 环境下执行。
>
> **进度（滚动更新）**：提交 1 ✅ 已落地（`llm-channel.js` / `sse-delta-parse.js` 及 bundle 注册）；
> B2 / B4 已改消费 `contentChannel`；C1/C2 已合并为 `src/agent/reasoning-backfill.js`
> （独立模块，未并入 `llm-request.js` —— 占位补全是请求**体**的职责，与端点/请求头单一来源解耦）；
> D2 ✅ 已落地（`session-transcript.js` 账本投影字段白名单，排除 `reasoning_content`）。
> **H4 ✅ 已落地**（跨语言 token 估算对齐，见「附带整改 · H4」，不在提交序列内）。
> **提交 4 ✅ 已落地**（Rust 账本去兜底 + 入口通道盖章，`delivered_content` / `thought_raw` 不再互相顶替）。
> **提交 5 ✅ 已落地**（交付四态收口 + 真思考分列落库 + 历史重建不读思考 + 上行回传真值优先）：
> `resolveTurnDelivery()` / `persistableTurnText()` / `reasoningTextFromTrace()` 成为交付与落库的单一来源；
> A1/A2/A3 三处「思考顶正文」已全部删除；`messages.reasoning` 走 RPC `memory.message_append` 落库并按需回读。
>
> **提交 6 ✅ 已落地**（跨边界文本契约 D3 / D4，见 §3.7）：
> `buildSynthesisDigest()` → `buildTraceFactsDigest()`（子 Agent 回注与汇总摘要只吃**工具事实**）；
> 「可回读纯文本」整条链路删除（Main `active.traceText`、Renderer `formatTracePlain()`、
> Rust `agent_traces.trace_text` 列）。
>
> **未做的只剩取证**：`提交 0`（抓包端到端重放，需活体 LLM，见 §7）。
>
> **另一条 assistant 落库口**：`src/plans/plan-run-turn.js`（计划运行）。它不开启 `turnEndSynthesis`，
> 交付物里**不可能**出现展示用标签（故未接 `persistableTurnText`）；但它也没有按轮 trace 取数链路，
> 因此不落 `reasoning` —— 计划会话的上行回传仍走占位兜底，属本方案的已知遗留。

### 提交 0（可选，强烈建议）· 取证基线

**目的**：动代码前先抓一份"问题现场"，作为最后回归的逐字对照物（§7）。

```powershell
$env:DIEYUN_LLM_RAW_LOG = "$PWD\.dieyun\llm-raw-baseline.jsonl"
npm run dev:fast      # 复现一次：思考进正文 / 回复空白的那个场景
Remove-Item Env:\DIEYUN_LLM_RAW_LOG
```

**产出**：`.dieyun/llm-raw-baseline.jsonl`，并记下出问题那一轮的 `tag`。
**验收**：能指出该轮正文究竟来自 `"content"` 还是 `"reasoning_content"` 键 —— 没有这份基线，`提交 5` 的端到端回归就只能靠肉眼。

---

### 提交 1 · `llm-channel.js` + 能力表（只加不改，行为零变化）

**目标**：让「通道身份」成为一等公民，但**不动任何消费方**。

**改动**
1. 新增 `src/agent/llm-channel.js`，只导出两个函数：
   - `getChannelPolicy(model)` → `{ reasoningField, singleChannel, echoReasoning }`。
     能力表按模型名匹配，挂在**既有模型元数据侧**（`src/model-settings.js` 的 `customModels` 结构或 `src/agent/model-api-config.js` 的供应商清单）—— 与模型配置同一事实源，**不新造词表**（AGENTS.md §2）。
     未知模型默认：`{ reasoningField: 'reasoning_content', singleChannel: false, echoReasoning: false }`。
   - `classifyDelta(delta, policy)` → `[{ channel: 'reasoning' | 'answer', text, source: 'upstream' }]`。
     全流程**唯一**把上游 JSON 变成「带身份文本」的地方；键名候选沿用 `src/llm-stream-utils.js:10` 现值（`reasoning_content` / `reasoning` / `thinking`），非流式走 `message` 分支。
2. `src/renderer/agent/agent-bundle-entry.js`：加 `require`（第 26 行 `agent-round-text` 旁）与 `register('DieyunLlmChannel', ...)`（第 169-171 行同款写法）。
3. 新增 `scripts/test-llm-channel.cjs`，并在 `package.json` 加 `"test:llm-channel"`。
   单测以**现状为 golden**：同一串 delta，`classifyDelta` 的通道序列必须与当前 `llm-stream-utils` 判定逐项相等 —— 先把「现状」钉死，`提交 2` 才敢改。

**验收**
```powershell
node scripts/test-llm-channel.cjs
npm run check:js
npm run test:agent-round-text
npm run check:renderer
```
**回滚**：纯新增 + 注册，删文件即回到原状。

---

### 提交 2 · 消掉 4 份通道判定 + 1 份重复解析（B2 / B3 / B4 + F2）

**目标**：展示层不再「猜」通道，重复实现归零；**归属结论与现状一致**。

**改动**
1. `llm_delta` 事件的发出方补 `channel` 字段（`src/agent/rust-loop-runner.js` 的 `onPhase('llm_delta', ...)`，约 `:384` / `:410`）。
2. 删 `src/agent/live-loop-trace.js:186-202`（B2）与 `src/plans/plan-run-events.js:169-189`（B3）里的 `reasoning || contentOnly || rawContent` 判定，改为消费 `channel`。
3. `src/renderer/renderer-agent-rust-loop.js:702-717`（B4）同样改为消费 `channel`。
4. `src/renderer/renderer-agent-llm.js` 删除 SSE 解析重复段（`:871-980`，含 `:956-971` `repairDeltaMojibake` 的第二遍三键扫描），改为复用 `src/llm-stream-utils.js`（同源复用已有先例：`agent-bundle-entry.js:146` 的 `llm-request` 注册）。
   注意：该文件**是活的**（被知识维护 / reviewer / AGENTS 冷启动调用），但调用方只要 `content` → 只删推理通道那一段，保留 `content` 通路。

**验收**
```powershell
npm run check:renderer
npm run test:renderer
npm run test:unit            # 含 live-loop-trace.test.cjs / plan-run-events.test.cjs
npm run test:llm-tool-call-fallback
npm run test:agent
```
**回归点**：单通道模型（mimo）此时仍应「正文落思考区、回答区为空」——本步只去重，**归属不得变化**。

---

### 提交 3 · 占位收敛 + 上行字段白名单（C1 / C2 + D2）

**目标**：假思考文案从「每轮常规路径」降级为「罕见兜底」，且只留一处。

**改动**
1. **✅ 已落地（变体）**：C1/C2 两份 `backfillReasoningContent`（`rust-loop-runner.js` / `renderer-agent-llm.js`）未并入 `llm-request.js`，而是抽出为**独立模块** `src/agent/reasoning-backfill.js`（占位补全是请求**体**的职责，与端点/请求头单一来源解耦）。`rust-loop-runner.js` 直接 `require`，Renderer 经 `agent-bundle` 注册的 `window.ReasoningBackfill` 消费；判定统一为「本轮 `hasTools` 或该消息 `tool_calls`」。
   **顺序警告（仍然有效）**：真思考尚未落库（`提交 5` 才做），故**保留占位兜底**，只做「两份并一份」；不可提前删，否则每轮带 tools 的续跑都会上游 400。
2. **✅ 已落地（D2）**：`src/agent/session-transcript.js` 新增 `TRANSCRIPT_FIELDS` + `projectTranscriptMessage`，`transcriptFromMessages` 改为「role 过滤 + 字段白名单 + 返回浅拷贝」：历史投影只保留 `role` / `content` / `tool_calls` / `tool_call_id` / `name`，**排除 `reasoning_content`** 与 UI 字段。
   - **取证结论（重要）**：出站侧早已有 wire 白名单 —— Renderer 的 `sanitizeMessagesForChatApi`（保留 `reasoning_content`）在种子进 Rust 前净化，Main 的 `backfillReasoningContent` 再按需补占位。因此**刻意不在出站处再剥 `reasoning_content`**：剥了只会把本 turn 的真思考降级成占位串（§4.1），字段仍会被补回。账本层（`TRANSCRIPT_FIELDS`）与 wire 层（`sanitizeMessagesForChatApi`）各自单源、职责分离。

**验收**
```powershell
npm run test:rust-loop-runner        # 改写 :1089-1123：断言「补位只剩一份、且按 policy 触发」
npm run test:session-context
npm run test:llm-tool-call-fallback
npm run test:agent-limits
npm run check:js
```

---

### 附带整改 · H4：跨语言 token 估算一致性（不在提交序列内）

**起因**：`src/agent/token-estimate.js` 注释声称与 Rust `compaction/tokens.rs` 「逐字对齐」，实测有分叉：

| # | 差异点 | 原 JS | Rust |
|---|---|---|---|
| 1 | 长度口径 | `s.length`（UTF-16 码元，星平面字符算 2） | `chars()`（Unicode 码点，算 1） |
| 2 | 数组 content | 各元素分别计费求和、无分隔符 | 同（本就一致） |
| 3 | 裸对象 | 无 JSON 全量兜底 | `Value::to_string()` |
| 4 | `tool_calls` | 计入 message | 不计（**刻意保留**，见下） |

差异 1 会让含 emoji / 扩展区的消息在 JS 侧虚高，使上下文预算、UI 圆环与 Rust compaction 的判定互相打架。

**落点**
1. `src/agent/token-estimate.js`：`estimateTextTokens` 改 `for...of` 迭代**码点**；新增 `estimateContentTokens`（null / string / array / object / scalar 五分支，与 Rust `estimate_tokens` 同构）与 `estimateJsonTokens`；CJK 字符类抽 `CJK_CLASS` 常量供两个正则共用（单源）；删除无消费者的 `messageContentText`。
2. `test/fixtures/token-estimate-cases.json`（**新建 · 唯一真值**）：`textCases` 18 例（emoji / 星平面 / 全角 / 假名 / 谚文）、`sharedMessageCases` 8 例；`jsOnly` 段显式记录 tool_calls 的刻意差异。
3. `test/unit/token-estimate.test.cjs`（新建）：读 fixture 逐例断言，另加码点计数、数组无分隔符、tool_calls 增量。
4. `crates/dieyun-core/src/compaction/tokens.rs` `#[cfg(test)]`：`include_str!` 同一 fixture，`text_cases_match_shared_fixture` / `message_cases_match_shared_fixture` / `counts_unicode_scalar_values_not_utf16_units`。

**保留的差异（有意为之）**：JS `estimateMessageTokens` 额外计入 `assistant.tool_calls`，Rust `estimate_messages_tokens` 不计 —— 二者**用途不同**（JS 面向真实窗口占用，Rust 面向消息正文），故 fixture 的 `sharedMessageCases` 只收不含 tool_calls 的消息，差异由 `jsOnly` 显式声明而非隐藏。
**不变式**：改公式必须**同时**改两侧实现与本 fixture；两侧测试各自守住半边，fixture 即跨语言契约的单源。

**验收**
```powershell
npm run test:unit            # 含 token-estimate（6 例）
cargo test -p dieyun-core tokens
```

---

### 提交 4 · Rust 账本去兜底（A1 / B1 / C3 / E1）

**目标**：正文与思考在账本层不再互相顶替。

**改动**
1. `crates/dieyun-core/src/agent/loop_run.rs:54 / :76` `delivered_content()` 删除 reasoning 兜底 → 正文空就是空，交 `提交 5` 显式处理。
2. 同文件 `:516-521` `thought_raw` 删除 `unwrap_or_else(|| stored_content.clone())` → 不采思考的模型，思考区就是空，不再复述正文。
3. 同文件 `:379-388` `push_assistant_text_only()` 写进 messages 的合成文本标 `synthetic: true`。
4. 同文件 `:264-273` `LlmResponseInput` 补 `content_channel`（`Answer | Reasoning | Absent`）；`TraceRound` 补 `visibleContent` / `contentSource`（`plan-run-events.js:91` 已有雏形）。
5. `crates/dieyun-core/src/compaction/llm.rs:203-216` `extract_completion_text`（E1）删除 `reasoning_content` 回退 → 空摘要直接走既有错误分支 `:172-175`（「未写入摘要，已跳过压缩」）。

**验收**
```powershell
npm run cargo:test
npm run pack:dieyun-core
npm run test:rust-agent-loop-smoke
npm run test:rust-loop-runner
```
**必须同步改写的旧断言**（不改本步必红）：
- `crates/dieyun-core/src/agent/loop_run.rs:904` `delivered_content_is_none_only_when_both_empty` → 改为断言「不再用 reasoning 顶正文」。
- 同文件 `:997` 附近既有 reasoning 断言。
- `crates/dieyun-core/src/compaction/llm.rs:341-344` `extract_content_from_string_or_parts` 的 `"only think"` 用例 → 改为断言返回空。
- `scripts/test-rust-loop-runner.cjs` 6 处 `reasoning_content` 断言（含 `:1098`、`:1112`）。
- 若 `docs/agent-run-events.md` 含 `TraceRound` 字段说明，跑 `npm run generate:agent-events` 重新生成。

---

### 提交 5 · 交付收口 + 真思考落库（3.4 / 3.5）

**目标**：正文空的处置收到唯一一处，「思考不进 book」成为结构事实。

**改动**
1. `src/agent/agent-round-text.js`：把 A1 / A3 的策略收口到这里，落 §3.4 四态 ——
   有正文=`answer`；截断且只有思考=`reasoning-fallback`（带标签，复用思考区引用样式，**不写进 book**）；正常收尾走 synthesis；都无=`empty`。
2. 删 `src/agent/agent-synthesis.js:43` `thoughtFallbackFromTrace()` → `:162-165` 把 `fullThought` 拼进 `done.content` 的那段（A3），改走上面已带标签的交付物。
3. `book` 增独立 `reasoning` 字段（与 `content` 并列、不混）；`src/agent/session-context.js:801-829` `buildCompletionMessagesFromHistory` 重建时**不读它** —— 真思考有地方存，但默认不进历史（D1 反转）。
4. 上行回传自此从 `book.reasoning` 取**真值**；占位仅在老数据 / 压缩后触发 —— `提交 3` 那条兜底正式降级为异常路径（与现状最大的行为差异）。

**验收**
```powershell
npm run test:agent-round-text
npm run test:session-context
npm run test:unit
npm run test:agent-full
# 端到端：重放 提交 0 的 .dieyun/llm-raw-baseline.jsonl
#   content 只进正文、reasoning_content 只进思考；DB 中 reasoning 与 content 分列
npm run verify:agent-events      # 事件契约有变时
npm run verify:rpc-catalog       # RPC 契约有变时
```
**回归重点（§4.5）**：单通道模型（mimo）正文判定、预算截断交付、DeepSeek 工具轮 400、subagent 摘要。

---

## 6. 不做的事

- 不加新的「思考 vs 正文」关键词/长度启发式 —— 现状 5 处启发式正是病根。
- 不在 Renderer 再写一份通道判定 —— 现状 3 份重复正因允许「就近判断」。
- 不给 `thought_raw` 改个名了事 —— B1 的病是兜底方向，不是命名。
- 不动抓包 `llm-raw-tap.js` —— 它是本次改造的**验收工具**（见 §7）。

---

## 7. 与抓包的关系：先取证，后改造，再回归

1. **取证**：`DIEYUN_LLM_RAW_LOG=<文件>` 抓当前那一轮，确认出问题的文字究竟落在 `"content"` 还是 `"reasoning_content"` 键下。
2. **改造**：按 §5 分步实施。
3. **回归**：同一份原始报文重放，要求 `content` 只进正文、`reasoning_content` 只进思考 —— 抓包文件可作为逐字对照的验收依据。

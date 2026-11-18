# 上下文折叠（compaction）

> **状态**：已实施（2026-11-17）。取代旧的「LLM 摘要 + 伪造 assistant 回执」压缩。
> **代码**：`crates/dieyun-base/src/compaction/`（语义全部在 `fold.rs`）、`src/agent/compaction-main.js`（预算与遥测）、`src/agent/compaction-loop.js`（归档）、`src/agent/compaction-telemetry.js`。

---

## 1. 一句话

把**旧消息里超长的内容就地截短**，保留 `tool_calls` 骨架与 tool 消息的配对。确定性、幂等、无网络、无 LLM。

## 2. 为什么换掉旧的

旧的压缩是「滚雪球 LLM 摘要」：把要折叠的那段对话喂给模型，输出 JSON 摘要，再把摘要与一条**平台伪造的 assistant 回执**（`收到，已基于压缩摘要继续执行。`）插回消息列表。它的四个固有代价：

| 代价 | 具体表现 |
|---|---|
| 关键路径上一次网络往返 | 75s 超时的摘要请求，压在「发请求之前」；失败要把整轮拖到 90s 才放弃 |
| 前缀缓存从头失效 | 摘要每重写一次，system 之后的第一批消息就变了，上游缓存全部作废 |
| 伪造轮次 | 模型从未说过那句回执，却出现在后续每一轮的上下文里 |
| 信息降级 | 折叠后只剩摘要 + 一张路径白名单，工具调用的结构、参数、原始输出全部消失 |

折叠不产生任何新消息，因此上面四条同时消失。

## 3. 现在的语义

```
越线判定 → 定尾部边界 → 逐档折叠 → 幂等标记
```

1. **触发**：`used >= tokenBudget × triggerRatio`，或 `force`（溢出兜底）。
   `used` 优先取上一轮服务端回报的 `usage.prompt_tokens`；拿不到（首轮 / 非兼容端点）才回落到字符比估值（`tokens.rs`，`cjk/1.5 + other/3.2`）。
2. **尾部保留**：最后 `keepTailAtoms`（默认 3）个「原子」原样不动。原子 = 一条 assistant（可能带 `tool_calls`）+ 紧随其后的 tool 消息；其余角色各自成一个原子。
3. **折叠**：对尾部之前的消息按三档加深（`LEVELS`：保留头 800/尾 200，最小触发 1600 字符 → 300/100/600 → 120/60/240），估算降到预算的 80% 即停手。
4. **不动的东西**：`system` 消息、`tool_calls` 参数（骨架）、`reasoning_content`（带 tool_calls 的 assistant 必须原样回传，截断会被上游 400）、user 消息的**文字**（用户意图是锚点）。
5. **图片**：非 user 消息里的图片 part 换成文字标记；user 消息只摘图片、不动文字（`loop_run.rs` 的首轮后 strip 之外再兜一层，避免 base64 长期占位）。
6. **幂等**：标记里带 `fold:L<n>`，同一档不重复折；只有估算仍超目标才加深一档。第二次调用不会再把内容啃掉一截。

## 4. 数字在哪

| 数字 | 位置 |
|---|---|
| 折叠档位（头/尾/最小触发字符） | `compaction/fold.rs:LEVELS` |
| 停止阈值（预算的 80%） | `compaction/fold.rs:FOLD_TARGET_RATIO` |
| 尾部保留原子数 | `compaction/fold.rs:DEFAULT_KEEP_TAIL_ATOMS` |
| 输入预算 / 触发比 / 工具 schema 扣减 | `src/agent/compaction-main.js` + `model-runtime-presets.js`（唯一来源） |
| RPC 超时（30s） | `src/core-rpc-timeouts.js:COMPACTION_FOLD_TIMEOUT_MS` |

## 5. 已删除（别再搬回来）

- `compaction/llm.rs`：Rust 侧第二条 LLM 通道（唯一目的就是发摘要请求）。
- `compaction/atoms.rs` 里的 `build_digest_messages` / `reassemble_after_compaction` / `format_compaction_summary`：摘要格式化与消息重组。
- `compaction/file_ops.rs`：折叠后「只留路径白名单」的路径回收。
- `CompactionPrompts`（`src/compaction-prompts.js`）：摘要提示词全文。
- `cumulativeSummary` / `compactionRoundCount` / 冷却窗口 6 轮 / `POST_COMPACTION_ROUND_COUNT`：只为实现「摘要失败后别每轮重打」的补偿层。折叠是纯 CPU 的幂等操作，没有需要冷却的资源。
- `parseCompactionLlmLogLine` 与 `compaction.progress`：把 core 的 stderr 人类日志用正则解析成 IPC 事件。折叠没有中途进度。
- `compaction:reset-state` IPC 与 Renderer 的 `resetCompactionState*`：没有每会话状态可重置。
- `agent.loop.set_messages`（宿主整段覆盖 messages）：改成 `agent.loop.drop_images`（只摘图）。
  折叠与账本推进由 core 独占，宿主不再有第二个写者。

## 6. 负向清单（重要）

- **不要**在压缩里重新引入「用模型总结历史」。要记信息就写进记忆（`memory.long_add`），不要在压缩路径里偷偷调一次大模型。
- **不要**为了让数字好看去折叠 user 消息文字或 `tool_calls` 参数。前者改写用户意图，后者毁掉调用骨架（上游会 400，或模型看到不完整补丁）。
- **不要**在 Node 侧再写一份「该不该压」的条数/字符比预判。预算与触发比只有一个来源，判定只在 Rust。
- **不要**把 `triggered` 之外的调用也写进遥测：每轮都会问一次折叠器，未触发的行只会稀释成功率。
- **不要**用「压缩成功」当作用户可见结论；提示词与文案只说「较早的工具输出已折叠」。

## 7. 测试

```bash
cargo test -p dieyun-core --lib compaction   # 折叠器本体：幂等 / 骨架保留 / 尾部不动 / usage 触发
npx vitest run test/unit/compaction-telemetry.test.cjs
npm run test:local-gateway-smoke             # 预算扣减 + RPC 报错软跳过
npm run test:agent-run-events
node scripts/test-rust-loop-runner.cjs
```

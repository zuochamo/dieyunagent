# agent 审计（driver / loop_run / llm）

> **2026-11-17 P0 已修**：F1（run 泄漏 → `RunLifetime` guard + `cancel` 真 bool + 取消即释放大字段，用例 `cancel_reports_truth_and_drops_the_run`）、F2（思考顶正文 → 两处上限分支改走 `delivered_content()`，用例 `single_channel_limit_never_stores_reasoning_as_answer`，已变异验证）。F3–F11 仍开。

审计范围：`crates/dieyun-core/src/agent/{mod,driver,loop_run,llm}.rs`（约 3.1k 行）。
交叉求证：`src/agent/rust-loop-runner.js`、`src/agent/agent-round-text.js`、`src/agent/llm-request.js`、`src/agent/llm-channel.js`、`src/renderer/renderer-agent-rust-loop.js`、`src/llm-reconnect-retry.js`、`src/core-rpc-timeouts.js`。

## 度量

- 行数：loop_run 1481 / llm 684 / driver 681 / mod 7。
- 一个文件混了几种职责：
  - `loop_run.rs`：①轮次账本（round / tool_calls_used / trace / pending_delegate）②折叠调度（在全局锁内做 O(n) 折叠）③run 生命周期（全局 Mutex，cancel 只置位，finish 两次加锁）④交付正文四态（`delivered_content` / `llm_thought_raw` / `ContentSource`）⑤工具结果回填与 trace 拼装。
  - `driver.rs`：轮次驱动 + 上游错误分类与自愈（按错误文本嗅探「上下文溢出 / 拒图」）+ 宿主反向调用（`round.prepare`）+ usage 事件出口 + `DriveStop` 契约。
  - `llm.rs`：HTTP 客户端与超时口径 + SSE 行解析 + 响应累加器 + 供应商方言容错 + 抓包上限 + Outcome 序列化。
- 同一份知识两份实现（跨语言为主）：
  - 「上下文溢出」判定：`driver.rs:189-197` vs `src/llm-reconnect-retry.js:isContextOverflowError`（词表不同）。
  - 「出站 message 形状」：`loop_run.rs:808-812` 直接序列化 `state.messages`，Node 侧 `sanitizeMessagesForChatApi`（`renderer-agent-llm.js:466-508`）在内核路径上不存在。
  - 「思考回传」：`loop_run.rs:607-609` 对所有模型无条件回传 `reasoning_content`，Node 的 `echoReasoning` 能力表（`llm-channel.js:39-40,76`）无效。
  - 「流式 usage」：旧 Renderer 路径有 `stream_options.include_usage`（`renderer-agent-llm.js:697`），内核 `llm.rs` 没有。
  - 「交付四态 / 空回复」：`loop_run.rs:25-35` vs `src/agent/agent-round-text.js:114-126` + `rust-loop-runner.js:689-699`。
  - 「本轮结束 / 继续」：`driver.rs:82-96` 的 phase 状态机 vs `rust-loop-runner.js:643-715` 的 `while(true)`。
  - 「折叠触发口径」：`loop_run.rs:524-531`（usage 优先）vs `compaction/fold.rs:98`（字符比估算）。

## 发现

### F1 取消或失败的 run 永不从 `AgentLoopManager.runs` 移除 —— 长驻 sidecar 里整段 transcript 永久泄漏
- 类型：live-bug｜严重度：high
- 位置：`loop_run.rs:839-841`（唯一 `runs.remove`，只在 `finish_run` 里）；`loop_run.rs:475-484`（cancel 只置位）；`driver.rs:166`（出错直接 `return Err(err)`，`finish_run` 不被调用）
- 触发：用户点「停止」，或任一次上游 4xx/5xx/超时。core 长驻，聊天 + planner worker + 频道共用同一个 manager；泄漏的 RunState 含全部 messages。副作用：同 runId 之后永远返回 `AGENT_CANCELLED` 而不是 `NOT_FOUND`；HashMap 无界增长。
- 修法：run 生命周期收进一处 —— `drive`/`drive_with_results` 用 RAII guard 在 Ok/Err 两条出口都 `discard(run_id)`；cancel 直接移除。
- 确认：`cancelled_run_is_dropped_from_ledger` —— cancel 后断言 `contains_key == false`（现在为 true）。

### F2 撞上限时思考原文被写进账本 assistant 正文与 `trace.visibleContent`
- 类型：live-bug｜严重度：high
- 位置：`loop_run.rs:540-549`（同模式 613-622、303-319）；唯一绕开 `delivered_content()`（25-35）的正文出口
- 触发：能力表声明 `singleChannel`（`llm-channel.js:50`）的模型，且同轮带 tool_calls 并命中 `max_rounds` / `max_tool_calls`。后果：思考被当上一轮回答回灌模型，并在 UI 显示成旁白。现有用例（`loop_run.rs:1257`）只喂 `content: Some("")`，正好绕过。
- 修法：该分支改传 `delivered_content(llm.content.as_deref(), channel)`（同一函数在 535/551/624/694 已用四次，这处漏用）。
- 确认：`limit_branches_never_promote_reasoning_to_content` 首个用例改成非空正文 + `ContentChannel::Reasoning`。

### F3 「上下文溢出」两套词表 + Node 把 core 的硬失败降级成 `phase:'done'`
- 类型：latent-bug｜严重度：high
- 位置：`driver.rs:189-197` vs `src/llm-reconnect-retry.js`；降级点 `src/agent/rust-loop-runner.js:558-567`
- 触发：上游措辞落在 Node 清单而不在 Rust 清单（`exceeds the maximum length` / `input length` / `max context`）→ driver 不认、直接 `return Err`（没折过）→ Node 认、返回 `phase:'done'` + `overflowStopped:true` + 空 content。Main 侧调用方（频道 / 计划 / headless）看到的是一次「正常完成的空轮」。
- 修法：词表只能有一份，且溢出判定与折叠都归 core（它才有 transcript）；Node 的 `phase:'done'` 降级改成错误或带 `errors`。
- 确认：同一字符串喂两侧，断言结论一致；端到端用 `driver.rs:514` 的 `scripted_server` 首包回 400。

### F4 溢出自愈是无条件重发：`fold_now` 的返回值被 `?;` 丢掉
- 类型：live-bug｜严重度：medium
- 位置：`driver.rs:147-152`（对照 `loop_run.rs:350-353`、`fold.rs:136`）
- 触发：①调用方没传 `tokenBudget`（默认 0）②`triggerRatio=0` ③可折区全在 keep_tail 之后 —— 三者任一：账本没变，第二次请求与第一次逐字节相同，必然再失败，日志却说「强制折叠后重发一次」，`FoldFact` 也丢（遥测缺失）。
- 修法：`let fact = fold_now(...)?`；`fact.is_none()` 就 `return Err(err)`，不许重发未变请求；预算为 0 时的跳过要显式诊断。
- 确认：`token_budget=0` + 首包 400，断言 `hits == 1`（现为 2），并断言两次请求体相等。

### F5 流式请求从不申请 usage：折叠退化成字符比估算，`agent.usage` 与成本统计全空
- 类型：live-bug｜严重度：medium
- 位置：`llm.rs:333-338`（只插入 `stream`）；消费点 `loop_run.rs:524-531`、`rust-loop-runner.js:578-587`
- 触发：所有走 core 的流式 run，对任何 OpenAI 兼容端点 → `Accumulator.usage` 恒 None → `agent.usage` 永不 emit → `observed_prompt_tokens` 恒 None → 折叠触发永远退回估值；`recordLlmUsage` 一次都不写。
- 修法：usage 是传输层事实，归 `llm.rs`：`stream=true` 时与 `stream` 一起插 `stream_options.include_usage=true`（宿主已给则合并）。
- 确认：`driver.rs` 的 `round_prepare_rewrites_messages_sent_upstream` 抓到的请求体加一行断言。

### F6 上游可控的 tool_calls index 无上限分配 + 缺 index 时跨块串槽 + name 用 `push_str` 拼接
- 类型：latent-bug｜严重度：medium
- 位置：`llm.rs:196-215`
- 触发：①`index: 900000000` → 按 index 扩张 Vec（OOM 面）；②端点不逐帧给 index → `unwrap_or(position)` 用本帧序号，第二帧 call[0] 落回 slot 0，两个工具参数被拼进一个 JSON → `parse_tool_arguments` 退化 `{"raw":…}`；③端点每帧重复 `name` → `fs_read_filefs_read_file`。同一个元组两套合并规则（id 覆盖、name 追加），必有一套错。
- 修法：只对 `arguments` 追加；`id`/`name` 取首个非空；index 缺失时用「上一帧已知最大 index 推进」，并设上限或改 BTreeMap。
- 确认：三条小用例（超大 index / 重复 name / 无 index 两帧）各一断言。

### F7 SSE 累加器只处理 `choices[0]`；非流式却把多个 choice 串接
- 类型：latent-bug｜严重度：medium
- 位置：`llm.rs:102-113`（`return` 在第一个 choice）vs `llm.rs:129-134`
- 触发：`n>1`，或中转把多 choice / 「choice0 带 delta、choice1 带 finish_reason」合在一帧 → 后续 choice 的正文与 `finish_reason` 全丢 → `is_length_stop` 认不出截断 → 被截断的工具调用照样执行。
- 修法：抽 `take_choice(choice)`，遍历所有 choice，只对主 choice 累积文本、每个都 `take_finish`；两条路径共用。
- 确认：`multi_choice_frames_keep_first_choice_text_and_finish_reason`。

### F8 `agent.run.tools` 漏传 results → 整批工具被记成「未返回结果」并以成功继续
- 类型：latent-bug｜严重度：medium
- 位置：`loop_run.rs:762-770`（对照 `driver.rs:52-53` 的契约注释、`rpc/mod.rs:1037-1043` 的 `unwrap_or_default()`）
- 触发：宿主 need_tools 之后调 `agent.run.tools` 但 results 缺失/为空 → 工具一次没跑，账本为每个 pending 写 `"工具 X 未返回结果"` 并继续；模型被告知跑过但无结果。驱动层注释还把这个事实说成「等价于直接推进」。
- 修法：`results` 空且 `pending_delegate` 非空 = 契约违规，直接 `INVALID_PARAMS`；RPC 层把 results 变必填；改注释。
- 确认：不带 results 调 `agent.run.tools`，断言下一轮请求体出现「未返回结果」。

### F9 单一全局 `std::sync::Mutex` + 折叠在锁内做整段 messages 的 O(n) 处理
- 类型：structural-debt｜严重度：medium
- 位置：`loop_run.rs:269-272`、`355-364`、`834-841`
- 触发：聊天 run + planner worker + 频道并发时，任一 run 触发折叠，全进程所有 run 的账本操作一起等（长会话数十万字符）。`finish_run` 两次 `lock().ok()` 把 poison 与失败都映射成 None → done 响应 messages=null → 本段工具结果整体丢失。
- 修法：折叠搬出临界区（取 messages → 锁外折 → 写回）；per-run 锁；finish 合成一次加锁，poison 用 `into_inner()` 明确恢复。
- 确认：`fold_blocks_other_runs_ledger`（并发的 `round_of` 最大耗时）。

### F10 出站 message 白名单只存在于 Node：内核自己拼 body 时不过任何白名单
- 类型：structural-debt｜严重度：medium
- 位置：`loop_run.rs:296-302`（注释）+ `605-609` + `808-812`
- 触发：`synthetic: true` 随 messages 直上上游（严格供应商报 Extra inputs are not permitted）；`echoReasoning` 能力表对内核路径完全无效。
- 修法：出站形状只留一份 —— 把投影搬进 core（剥账本内部字段、按传入的 `echoReasoning` 决定 reasoning 回传），Node 只留能力声明。
- 确认：`recording_server` 抓两轮请求体，塞一条 `synthetic:true` 断言它仍在（即过滤不存在）。

### F11 流式 / 非流式未合并：status 错误文案、整包兜底、多 choice、upstream_error 各写一遍；`Accumulator.started` 死字段
- 类型：structural-debt｜严重度：medium
- 位置：`llm.rs:346-363` vs `365-444`；死字段 76/160/179
- 触发：漂移已经发生两次（6631579 / 4d81e15 / 30fb083 都在补「stream 字段 / 空回复 / 整包丢 tool_calls」）；下一次改动仍会只改一处。
- 修法：合成一个入口（喂 Accumulator → 统一判错 → `finish()`），整包兜底降级为「零 SSE 行时复用 `feed_body`」；删 `started`。
- 确认：`parses_whole_response_body` 与 `whole_json_body_while_streaming_is_parsed` 期望统一。

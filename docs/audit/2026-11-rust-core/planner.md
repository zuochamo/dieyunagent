# planner 审计

> **2026-11-17 P0 已修**：F1（评审把不合法输出当通过 → `accepted` 缺省 false + 取值归一 + 认嵌套形状，用例 `review_never_treats_unclear_output_as_accepted`）、F2（best-of-N 只抬不压 → 只压不抬，用例 `finalize_plan_never_raises_best_of_n_above_the_host_cap`）。F3–F11 仍开。

审计范围：`crates/dieyun-core/src/planner/{mod.rs,run.rs,plan_parse.rs,prompts.rs,types.rs}`，对照 Node 侧 `src/agent/rust-planner-runner.js`、`src/rpc/mod.rs`（planner.* 分发）、`src/agent/agent-limits.js`。

## 度量

- 行数：2318（run.rs 1361 / plan_parse.rs 492 / prompts.rs 335 / types.rs 123 / mod.rs 7）
- 一个文件混了几种职责：
  - `run.rs`：①planner 状态机账本（`InternalPhase` + `PlannerRunState`）②JSON 应答契约组装（`build_response`，把 phase/trace/llmBody/workerJobs 拼给 Node）③worker 队列与作业划分（`prepare_worker_jobs`/`set_worker_queues`）④best-of-N 调度（attempt/pick/total 计数）⑤重试计划构造（`build_retry_jobs`）⑥prompt 与 LLM 请求体分发（调 `prompts::*`，同时塞自己的 24/96/0.2）⑦并发与存储（`Mutex<HashMap>`）⑧单测（11 个）。
  - `plan_parse.rs`：①任意文本里抠 JSON（`extract_json_block`/围栏扫描/宽松修复）②计划规范化（`normalize_plan_payload` + 8 种键名 or_else 链）③评审解析（`parse_review_content`）④降级计划生产（`build_fallback_plan`）⑤计划序列化回 JSON（`plan_to_json`）。
  - `prompts.rs`：①prompt 常量文本 ②LLM 请求体组装（含预算字面量）③best-of-N 结果解析（`parse_best_of_n_winner` 本该在 plan_parse）。
  - `types.rs`：纯 DTO，但 `PlannerContinueInput.partial_body` 是死字段（见 F10）。
- 同一份知识有两份实现：
  - 评审 LLM 请求体：`run.rs:403-429`（`&json!({})`）与 `run.rs:669-695`（真实 `worktree_ctx`）；两处的 `results_json` 映射逐字重复（`run.rs:405-416` vs `672-683`）。
  - best-of-N 开关：`run.rs:1067`（`finalize_plan` 取 max）／`rust-planner-runner.js:105-119`（`clampPlanContentBestOfN` 改文本）／`rust-planner-runner.js:121-124`（`sanitizePlanBestOfN` 改对象）。
  - 计划 JSON 解析容错：`plan_parse.rs:15-64`（围栏+首尾大括号+弯引号+尾逗号修复）／`rust-planner-runner.js:110-118`（裸 `JSON.parse`，失败原样返回）／`src/agent/knowledge-maintainer.js:307`（只认 `subtasks|tasks`）。
  - worker id 归一：`plan_parse.rs:66-78`（唯一实现）与 `run.rs:1002`（重试路径完全没用它）。
  - 预算数字：`run.rs:338`(24)、`run.rs:986`(96)、`run.rs:987`、`prompts.rs:123`(4096)/`212`(1024)/`304`(128)、`run.rs:337`+`prompts.rs:211`(0.2) vs `agent-limits.js:285-286`(subagentMaxRounds/ToolCalls)、`306`(plannerMaxParallelWorkers)、`313`(plannerBestOfN)、`model-runtime-schema.js:39-43,78-82`。
  - 「轮次上限」口径：`rust-planner-runner.js:486-490`（`spec.maxRounds > 0` 就用 Rust 的）与 Rust 恒定非 0/非空。
  - `hitRoundLimit` 语义：`run.rs:566-572`（worker_batch 直接 Done）／`592-598`（BN 同）与 `rust-planner-runner.js:753-792`（先收齐整批再早退）。

## 发现

### F1 评审解析把「不合法输出」一律当成验收通过，整条重试闸门失效
- 类型：live-bug
- 严重度：high
- 位置：`crates/dieyun-core/src/planner/plan_parse.rs:366-393`（消费点 `run.rs:741`）
- 证据：
```rust
pub fn parse_review_content(content: &str) -> ReviewResult {
    if let Some(parsed) = extract_json_block(content) {
        let accepted = parsed
            .get("accepted")
            .and_then(|v| v.as_bool())
            .unwrap_or(true);
        ...
    ReviewResult {
        accepted: true,
        retry: vec![],
        notes: content.to_string(),
    }
```
```rust
// run.rs:741
        if review.accepted || review.retry.is_empty() {
            run.phase = InternalPhase::NeedSynthesizeLlm;
```
  对照 `prompts.rs:49-57`：REVIEW_SYSTEM 要求「输出纯 JSON」，并且**自己给了形如 `[{ "worker": "A", "subtaskIds": ["A1"], ... }]` 的示例**。
- 触发：评审模型只要不给出严格 JSON（非常常见）：
  1) `{"accepted":"false","retry":[{"worker":"A","subtaskIds":["A1"],"reason":"测试没过"}]}` —— `accepted` 是字符串，`as_bool()` 返回 None → 默认 `true` → `review.accepted` 短路 → **retry 被整条丢弃**，坏产出直接进汇总；
  2) 散文里带示例 JSON（`extract_json_block` 取「首个 `{` 到末个 `}`」，两个对象拼一起解析失败 → `None`）→ `accepted: true`；
  3) `{"review":{"accepted":false}}` 这类嵌套 → 顶层取不到 → `true`。
  结果：验收→重试这一层等于不存在，而 `phase=done` 里仍带着 `review.accepted=false`，UI 显示「需重试」却什么都没重试。
- 修法方向：默认值改成「拿不到明确 true 就不放行」（`accepted` 缺省 false 或直接判解析失败重问一次），`accepted` 支持 `true/1/"true"` 归一；删掉 `retry` 丢失时的静默短路。
- 怎么确认：单测 `cargo test -p dieyun-core --lib planner::plan_parse`，新增 `review_stringified_false_is_not_silent_pass`；Node 侧把 `scripts/test-rust-planner-pipeline.cjs:64` 的 review content 换成 `{"accepted":"false","retry":[{"worker":"A","subtaskIds":["A1"],"reason":"x"}]}`，当前会直接跳 `need_synthesize_llm`。
- 置信度：high

### F2 best-of-N 只「抬」不「压」：宿主关掉了（plannerBestOfN=0）模型一句话也能开 3 路
- 类型：live-bug
- 严重度：high
- 位置：`crates/dieyun-core/src/planner/run.rs:1067-1070`；`plan_parse.rs:59-64`、`318-323`；对照 `src/agent/rust-planner-runner.js:105-119`
- 证据：
```rust
// run.rs:1067-1070
    plan.best_of_n = plan.best_of_n.max(cfg_best_of_n.min(3)).min(3);
    if plan.best_of_n <= 1 {
        plan.best_of_n = 0;
    }
```
```js
// src/agent/rust-planner-runner.js:111-118
  try {
    const obj = JSON.parse(trimmed.slice(start, end + 1));
    obj.bestOfN = 0;
    obj.best_of_n = 0;
    ...
  } catch {
    return content;
  }
```
```rust
// plan_parse.rs:59-64
fn strip_loose_json(text: &str) -> String {
    text.replace(['\u{201c}', '\u{201d}'], "\"")
        ...
        .replace(",}", "}")
```
- 触发：设置里 `plannerBestOfN=0`（默认关闭）。规划模型输出里写 `"bestOfN": 3`，同时 JSON 带一个尾逗号（`...],}`）或中文弯引号已存在——Node 的 `JSON.parse` 抛错 → `catch` 原样返回未清洗的 content → core 的 `strip_loose_json` 把 `,}` 修好，照样解析成功 → `finalize_plan` 用 `max(0, 3)` 保留 3 → build 类子任务各跑 3 次完整 worker loop + 3 个 worktree。
  同向漂移：用户设 2、模型写 3，Rust 的 `max` 也会抬到 3；Node 的注释（`rust-planner-runner.js:90-96`）声明 `agent-limits.plannerBestOfN` 是唯一来源，实际没有任何一层把它当上限。
- 修法方向：`plan.best_of_n = model_n.min(cfg)。min(3)`，cfg<2 直接 0；同时删掉 Node 的 `clampPlanContentBestOfN`（改文本那份）与 `sanitizePlanBestOfN`，开关只在 core 一处生效。
- 怎么确认：单测 `finalize_plan(plan.best_of_n=3, cfg_best_of_n=0)` 断言 `0`（现有 `finalize_plan_clamps_best_of_n_to_three` 只用 cfg=99，正好绕过了这条）；RPC 最小复现：`planner.run.start {bestOfN:0}` → `planner.run.continue {step:'plan_llm', content:'{"planSummary":"x","bestOfN":3,"subtasks":[{"id":"A1","worker":"A","agentType":"build","instruction":"do"},]}'}`（尾逗号），响应 phase 变成 `need_best_of_n_attempt`。
- 置信度：high

### F3 检查点恢复失败被静默吞掉：已完成子任务全部重跑
- 类型：latent-bug
- 严重度：high
- 位置：`crates/dieyun-core/src/planner/run.rs:110-132`
- 证据：
```rust
        if let Some(cp) = &params.resume_checkpoint {
            if let Some(data) = cp.get("data").or_else(|| Some(cp)) {
                if let Some(p) = data.get("plan") {
                    if let Ok(parsed) = serde_json::from_value::<Plan>(p.clone()) {
                        plan = Some(finalize_plan(parsed, params.best_of_n));
                        explore_skipped = true;
                        let (ids, outputs) = parse_completed_outputs(
                            data.get("completedOutputs")
                                .or_else(|| data.get("completed_outputs")),
                        );
                        resume_completed_ids = ids;
                        restored_results = outputs;
                    }
                }
```
  注意 `parse_completed_outputs` 被嵌在 `if let Ok(parsed)` 里，且 `types.rs:6-13` 的 `Subtask` 六个字段、`types.rs:17-24` 的 `Plan.todos/best_of_n` 都没有 `#[serde(default)]`。
- 触发：checkpoint 里的 plan 有任何字段缺失/类型漂移（老版本 core 写的断点、被外部清洗过的 plan、`todos` 不是数组……）→ `from_value::<Plan>` 返回 Err → 整块被跳过：`plan=None`、`explore_skipped=false`、`results` 空，phase 回落 `NeedPlanLlm` **重新规划**；断点里已经完成的子任务（`completedOutputs`）一起被丢弃 → 再次执行、再次写 worktree、再合并一次。全程没有 error、没有 trace 提示，Node 侧 `latestPlan` 仍显示旧计划，用户看到的是「又从头跑了一遍」。
- 修法方向：把「恢复 plan」与「恢复 completedOutputs」解耦成两次独立解析；plan 恢复失败要么直接报 `INVALID_PARAMS`，要么至少 `push_trace("检查点不可用，已重新规划")`。
- 怎么确认：单测 `resume_plan_missing_field_keeps_completed_outputs`：把 `run.rs:1210` 那个 checkpoint 里 `B1` 的 `agentType` 删掉，断言 `phase == "need_workers"`（当前得到 `need_plan_llm`）。
- 置信度：high

### F4 撞轮次分支：整批 results 被丢弃、验收被跳过、一路 worker 的半成品正文顶替最终答复
- 类型：live-bug
- 严重度：medium
- 位置：`crates/dieyun-core/src/planner/run.rs:566-572`（另 `592-598`、`462-468`）
- 证据：
```rust
        if input.hit_round_limit {
            run.hit_round_limit = true;
            run.final_content = input.partial_content;
            run.partial_body = input.partial_body;
            run.phase = InternalPhase::Done;
            return self.build_response(run);
        }
```
  对照正常路径 `run.rs:581`：`run.results.extend(input.worker_results);`。Node 在 `rust-planner-runner.js:882-894` 把 `workerResults: batch.workerResults`、`partialContent: batch.partial?.content` 一起送来。
- 触发：任一 worker loop 撞轮次上限（`run.rs:986` 硬编码 `maxRounds: 96`）→ Node 带 `hitRoundLimit: true` 回来即可，长任务几乎必经。
- 后果：①`run.results` 不并入 `worker_results`，`done.results` 少了整批（其中**已成功**的 worker 也一起丢），`renderer-agent-loop.js:130-133` 的 `stepsFromAgentPlan` 于是把已完成的子任务全显示成未完成；②`NeedReviewLlm` 完全不跑，半成品没人验收；③`final_content` = 撞轮次那一路 worker 的 partial 正文，被当成整轮最终答复交付（`rust-planner-runner.js:993`）。
- 修法方向：`hit_round_limit` 分支先 `run.results.extend(input.worker_results)` 再 Done；`review` 置为 `None` 并把「预算截断」写进 `review.notes`；不要把子任务正文写成 `final_content`（应让 Node 走一次汇总或明确交付 partial 并带标签）。
- 怎么确认：`cargo test -p dieyun-core --lib planner::run` 新增 `worker_batch_hit_round_limit_keeps_results`：`step:"worker_batch", hitRoundLimit:true, workerResults:[{id:"A1",output:"half"}]` → 断言 `r["results"].len() == 1`（当前是 0）。
- 置信度：high

### F5 重试路径不复用 worker id 归一 → 评审要求重试的子任务被静默丢掉
- 类型：latent-bug
- 严重度：medium
- 位置：`crates/dieyun-core/src/planner/run.rs:1001-1024`（对照 `plan_parse.rs:66-78`）
- 证据：
```rust
    for item in &review.retry {
        let worker = item.get("worker").and_then(|v| v.as_str()).unwrap_or("A");
        ...
        let tasks: Vec<Subtask> = plan
            .subtasks
            .iter()
            .filter(|t| t.worker == worker && (ids.is_empty() || ids.contains(&t.id)))
            .cloned()
            .collect();
        if tasks.is_empty() {
            continue;
        }
```
- 触发：评审模型按自然语言写 `"worker": "a"`、`"Worker A"`、`"执行器A"`（或把 retry 项写成字符串数组，`item.get("worker")` 取不到 → 兜底 `"A"`）：
  - 前一类 → `t.worker == worker` 精确比较（plan 里已被 `normalize_worker_id` 成 `"A"`）失败 → `tasks.is_empty()` → `continue` → 重试整条消失；随后 `run.rs:755-761` 因队列空直接进 `NeedSynthesizeLlm`，Done 里 `review.accepted=false` 却什么都没重试；
  - 后一类 → 兜底 `"A"` + `ids` 为空 → 把 A 的**所有**子任务全部重跑（过宽重试，重复写盘）。
- 修法方向：`build_retry_jobs` 里对 `worker` 调用 `plan_parse::normalize_worker_id`，匹配不到 worker 时 `push_trace` 说明而不是静默 `continue`。
- 怎么确认：单测 `retry_worker_name_is_normalized`：review content `{"accepted":false,"retry":[{"worker":"a","subtaskIds":["A1"],"reason":"x"}]}` → 期望 `need_retry_workers`（当前 `need_synthesize_llm`）。
- 置信度：high

### F6 `continue` 不校验 step 与当前 phase：重复/乱序/取消后的 RPC 一律照跑
- 类型：latent-bug
- 严重度：medium
- 位置：`crates/dieyun-core/src/planner/run.rs:243-257`、`193-229`（`worker_loop_body`）、`275-283`（`cancel`）
- 证据：
```rust
        match input.step.as_str() {
            "plan_llm" => self.handle_plan_llm(run, input.content.unwrap_or_default()),
            "explore_loop" => self.handle_explore_loop(run, input),
            "worker_batch" => self.handle_worker_batch(run, input),
            "best_of_n_attempt" => self.handle_best_of_n_attempt(run, input),
            ...
            _ => Err(CoreError::rpc("INVALID_PARAMS", format!("未知 step: {}", input.step))),
        }
```
```rust
// worker_loop_body（run.rs:203-229）：只有 run_id 校验，没有 run.cancelled 校验
        let runs = self.runs.lock().unwrap();
        let run = runs.get(run_id)...
```
- 触发：同一步的 continue 被投递两次（上层重试、双窗口同一会话、超时后重发）：
  - 重发 `worker_batch` → `run.results.extend` 追加第二遍（同 id 重复，`renderer-agent-loop.js:131` 的 `new Map` 只留最后一条）+ 再排一次 `NeedReviewLlm`；
  - 重发 `plan_llm`（`run.rs:492-506`）→ plan 被新内容覆盖，Node 用新 jobs 重跑，先前 worker 已写的改动无人认领；
  - `planner.run.cancel` / `rpc.cancel` 把 `phase` 设成 `Cancelled` 后，`worker_loop_body` 仍会为已取消的 run 组装完整 worker spec（只有 Node 侧的 `signal` 在兜）。
- 修法方向：每个 step 声明唯一合法 phase，不匹配返回 `INVALID_STATE`；`worker_loop_body` 开头加 `if run.cancelled { return Err(CANCELLED) }`。
- 怎么确认：单测 `duplicate_worker_batch_is_rejected`：连续两次 `step:"worker_batch"` 同结果 → 第二次期望 `INVALID_STATE`（当前会返回 `need_review_llm` 且 `results.len()==2`）。
- 置信度：high

### F7 `to_lowercase()` 与原文混用字节偏移 → 上游可控文本可 panic；被 std Mutex 毒化放大成 planner 永久不可用
- 类型：latent-bug
- 严重度：high
- 位置：`crates/dieyun-core/src/planner/plan_parse.rs:32-57`（关键 `34-40`）；放大点 `run.rs:189/203/236/261/276` 的 `.lock().unwrap()`
- 证据：
```rust
fn regex_lite_find_json_fences(raw: &str) -> Vec<String> {
    let mut out = Vec::new();
    let lower = raw.to_lowercase();
    let mut i = 0;
    while let Some(idx) = lower[i..].find("```") {
        let start = i + idx + 3;
        let rest = &raw[start..];            // ← 用 lower 的字节下标切 raw
        ...
        i = content_start + end_idx + 3;     // i 混用两套坐标系
```
- 触发：模型输出里出现「小写化后 UTF-8 字节长度会变」的字符，且其后再出现 ``` 围栏：`İ`(U+0130, 2→3 字节)、`ẞ`(3→2)、`K`(U+212A, 3→1)。偏移错位后 `&raw[start..]` 落在多字节字符中间 → `byte index is not a char boundary` panic。
  放大：panic 发生在 `handle_plan_llm` 里（`run.rs:496` → `try_parse_plan_from_content`），此时 `continue_run` 正持着 `runs: std::sync::Mutex` 的守卫 → 锁中毒 → 之后 `start/state/continue/cancel/worker_loop_body` 里所有 `.lock().unwrap()` 全部 panic，**planner 子系统在该进程内永久不可用**（一次野字符 = 整个计划模式瘫痪，直到重启）。
- 修法方向：围栏只在 `raw` 上找（`find("```")` 本来就不需要小写化），非要用 `lower` 就用 `char_indices`/同源切片，禁止跨字符串做字节算术；`Mutex` 换成 `lock().unwrap_or_else(|e| e.into_inner())` 或改用 `parking_lot`。
- 怎么确认：单测 `fence_after_casefold_expanding_char`：`extract_json_block("İİ```json\n{\"a\":1}\n```")` 当前 panic（`cargo test -p dieyun-core --lib planner::plan_parse`）。
- 置信度：high

### F8 评审 LLM 请求体有两份实现，其中一份把 `worktreeChanges` 写成 `{}`
- 类型：structural-debt
- 严重度：medium
- 位置：`crates/dieyun-core/src/planner/run.rs:403-429` vs `run.rs:669-695`
- 证据：
```rust
// run.rs:403-429（build_response 里的 NeedReviewLlm 分支）
                            build_review_llm_body(
                                &run.params.model,
                                &run.params.sys_content,
                                plan,
                                &results_json,
                                &json!({}),          // ← worktreeChanges 永远是空对象
                            ),
```
```rust
// run.rs:684-693（begin_best_of_n_or_review 里又拼了一遍，这次带 wt）
                    obj.insert(
                        "llmBody".into(),
                        build_review_llm_body(
                            ...
                            &wt,
                        ),
                    );
```
  而 `prompts.rs:60-61` 的 REVIEW_SYSTEM 明确写着「结合 worktreeChanges：若子任务声称改文件/跑命令，但对应 worker 的 worktree 无 diff，应 retry」。
- 漂移后果：只要进入 `NeedReviewLlm` 不是经 `begin_best_of_n_or_review`（典型：断点恢复时所有子任务都已完成 → `prepare_worker_jobs`（`run.rs:827-831`）直接跳到 `NeedReviewLlm`），下发的评审请求体里 `worktreeChanges = {}`，评审模型只能凭 worker 自述判断「改没改」，验收规则形同虚设。两处 `results_json` 映射逐字复制（`405-416` / `672-683`），任何一处改过滤阈值另一处必定漂移。
- 修法方向：删掉 `build_response` 里那份，只留一个 `build_review_payload(run, worktree_ctx)`，并把 Node 每批都发来的 `worktree_ctx` 存进 `PlannerRunState`（不要靠"上一次调用顺手塞进 resp"）。
- 怎么确认：单测 `review_body_from_resume_path_includes_worktree_changes`：`resume_checkpoint` 里所有子任务都在 `completedOutputs` 中 → 断言响应 `llmBody.messages[1].content` 含 `"worktreeChanges"` 且不为 `{}`。
- 置信度：high

### F9 planner 的轮次/输出预算在 Rust 里硬编码，绕过 agent-limits 与 `clampModelRuntimeValue`
- 类型：structural-debt
- 严重度：medium
- 位置：`run.rs:338`（`"maxRounds": 24`）、`run.rs:986`（`"maxRounds": 96`）、`run.rs:987`；`prompts.rs:123`（`"max_tokens": 4096`）、`prompts.rs:212`（1024）、`prompts.rs:304`（128）；`run.rs:337` + `prompts.rs:211`（`"temperature": 0.2`）
- 证据：
```rust
// run.rs:333-341
                            json!({
                                "model": run.params.model,
                                "messages": [...],
                                "temperature": 0.2,
                                "maxRounds": 24,
                                "maxToolCalls": planner_max_tool_calls(&run.params),
```
```rust
// run.rs:985-988
        "temperature": run.params.temperature,
        "maxRounds": 96,
        "maxToolCalls": planner_max_tool_calls(&run.params),
```
  对照 `agent-limits.js:282-286`：「已两次放宽：16/32 → 32/64 → 48/96 …… 护栏数字只在这里改」；`model-runtime-schema.js:39-43`（maxOutputTokens 1k–240k）、`78-82`（agentMaxRounds 下限 15）。
- 漂移后果：
  1) `rust-planner-runner.js:486-490` 的取值是 `Number(spec.maxRounds) > 0 ? spec.maxRounds : settings.agentMaxRounds` —— Rust 永远给 24/96（非 0），所以**用户设置的 agentMaxRounds 与 agent-limits 的 subagentMaxRounds(48) 对 planner worker / explore 完全无效**，下次在 agent-limits 里调数字，planner 依然按 96/24 跑；
  2) explore 的 `temperature` 恒 0.2，用户 temperature 设置只对 worker（`run.params.temperature`）生效——同一轮里两套温度口径；
  3) `max_tokens` 4096/1024/128 是字面量，不受 `clampModelRuntimeValue('maxOutputTokens', ...)`（Node 已经算好放在 `startParams.maxOutputTokens`，但 Rust 只给 synthesize 用）约束；接一个输出上限 2048 的模型 → 计划请求直接 400 → 计划没生成，整轮 planner 抛错（此路径没有任何兜底）。
- 修法方向：把 Node 已算好的 `subagentMaxRounds/subagentMaxToolCalls/agentMaxRounds`、`maxOutputTokens`、`temperature` 一并放进 `PlannerStartParams`，Rust 侧只保留「宿主没给时的默认」，删掉这 6 个字面量。
- 怎么确认：`node scripts/test-rust-planner-smoke.cjs` 里断言 `startParams.maxToolCalls=1` 时 `loopStart.maxToolCalls` 与 `workerLoop.maxToolCalls` 都为 1（当前 `prompts`/`run` 都用 `planner_max_tool_calls`，看似通过；关键缺口在 maxRounds——断言 `workerLoop.maxRounds === settings.agentMaxRounds` 必失败）。
- 置信度：high

### F10 `runs` 只增不减 + 一批死字段/死分支（补丁痕迹）
- 类型：structural-debt
- 严重度：medium
- 位置：`run.rs:82-86`（`runs: Mutex<HashMap<String, PlannerRunState>>`）、`run.rs:462-480`（Done 分支不清理）、`run.rs:77/537/569/595`（`partial_body`）、`run.rs:70/583/890`（`standard_worker_jobs`）、`run.rs:318-321`（`skipExplore`）、`run.rs:23-25`（`planner_max_tool_calls`）
- 证据：
```rust
// run.rs:22-25：filter 是恒等变换，写了等于没写
fn planner_max_tool_calls(params: &PlannerStartParams) -> u32 {
    params.max_tool_calls.filter(|&n| n > 0).unwrap_or(0)
}
```
```rust
// run.rs:318-321：自陈「不该发生」的死分支
                InternalPhase::NeedExploreLoop => {
                    if run.explore_skipped || !run.params.has_explore_tools {
                        // Should not happen if logic correct; Node may skip calling loop
                        obj.insert("skipExplore".into(), json!(true));
```
  `partial_body`：`run.rs:537/569/595` 三处写入，全仓无任何读取（`grep partial_body` 只有 types 定义 + 这 3 个写入点）；Node 侧 `rust-planner-runner.js:862/890/908` 每次 `hitRoundLimit` 都把它送来。`standard_worker_jobs`：`set_worker_queues` 写入、`handle_worker_batch` 清空，从不读。
- 漂移后果：
  1) 没有任何 `planner.run.finish`/回收路径（Node 只调 `planner.run.start/continue/worker_loop/cancel`，`grep` 可证），`Done` 之后 `PlannerRunState`（含 `sys_content`、`chat_history_block`、每路 worker 全量 `output`、完整 `trace`）永久驻留；长会话 + 多计划模式 → 进程内存单调增长，且 `cancel` 也只置标记；
  2) `partial_body` 承载的「撞轮次的半成品 body」全链路丢失 —— 而 `rust-planner-runner.js:979-981` 的注释正是靠断点+partial 支撑「继续」入口，实际没人消费；
  3) `skipExplore` 分支与 `planner_max_tool_calls` 的 filter 是补丁残留，读者会以为存在「explore 被跳过」的真实状态。
- 修法方向：`Done`/`Cancelled` 时把 run 从 map 里移除（Node 完结后只可能 `cancel`），或加显式 `planner.run.finish`；删掉 `partial_body`、`standard_worker_jobs`、`skipExplore` 分支与那句恒等 filter。
- 怎么确认：跑完一次完整 flow 后调用 `planner.run.state`，期望 `NOT_FOUND`（当前返回完整历史）；内存侧可 `process.memoryUsage()` 前后对比 20 次 plan run。
- 置信度：high

### F11 宽松解析把「胡写的 JSON」变成半真计划，fallback 再把解析失败变成正常成功
- 类型：structural-debt（其中 (a)(d) 可 live-bug 触发）
- 严重度：medium
- 位置：`plan_parse.rs:141-151`（instruction 的 7 个候选键名 / 6 层 or_else）、`plan_parse.rs:286-296`（单对象兜底）、`plan_parse.rs:15-21`（首个 `{` 到末个 `}`）、`plan_parse.rs:337-364`（`build_fallback_plan`）、`run.rs:497-507`
- 证据：
```rust
// plan_parse.rs:141-151
    let instruction = obj
        .get("instruction")
        .or_else(|| obj.get("prompt"))
        .or_else(|| obj.get("description"))
        .or_else(|| obj.get("desc"))
        .or_else(|| obj.get("content"))
        .or_else(|| obj.get("task"))
        .or_else(|| obj.get("detail"))
        .and_then(|v| v.as_str())
```
```rust
// plan_parse.rs:286-296：任意带 title/description 的对象都被当成「单子任务计划」
    } else if obj.contains_key("instruction")
        || obj.contains_key("title")
        || obj.contains_key("description")
    {
        let mut worker_seq = std::collections::HashMap::new();
        normalize_one_subtask(parsed, &mut worker_seq)
```
```rust
// run.rs:497-502
        if plan.is_none() && run.plan_repair_attempt < 2 {
            run.plan_repair_attempt += 1;
            ...
        }
        let mut plan = plan.unwrap_or_else(|| build_fallback_plan(&run.user_prompt));
```
- 触发/后果：
  (a) 模型回 `{"title":"无法完成","description":"缺少必要信息，请补充…"}` → 被当成 1 个 `build` 子任务，带着写权限去执行一句拒绝的话；
  (b) 模型回 `{"summary":"…","steps":["改 A","跑测试"]}`（steps 是字符串数组）→ 数组项 `as_object()` 失败全被过滤 → `subtasks` 空 → `None` → 白烧两次 repair；
  (c) 三次都失败 → `build_fallback_plan`：`fallback: true`、`plan_summary` 写着「规划输出未通过校验，已自动降级为单任务」，但整轮**继续**跑 worker→验收→汇总并 `phase=done`。Node 侧全仓没有任何 `plan.fallback` 消费点（`src/**/*.js` grep 无命中），也就是说「规划失败」在机器可读层面等于成功，唯一信号是 trace 里一句中文；
  (d) 同一函数 id 也不去重（`plan_parse.rs:164-171` 只在**缺省**时生成 `{worker}{seq}`）：模型给两个 `"id":"A1"` → `worker_loop_body`（`run.rs:215-219`）按 id `find` 拿到**第一条** → 第二个子任务执行第一个的指令（重复劳动），`renderer-agent-loop.js:131-133` 的 `new Map(… String(r.id) …)` 又会吞掉其中一条结果。
- 修法方向：只认契约键名（`subtasks|tasks` + `instruction` + `worker` + `agentType`），删掉 6 个 or_else 兜底和「单对象即计划」兜底；解析失败让 run 失败（或在 Done 里带 `planInvalid:true` 且不派 worker），删掉 fallback 计划；`normalize_one_subtask` 里对 id 做冲突重编号。
- 怎么确认：单测 `normalize_plan_payload(&json!({"title":"t","description":"d"}), "")` 期望 `None`（当前返回 1 个子任务）；`id_collision_is_renumbered`：两个同 `"A1"` 的计划 → 断言 id 不同。
- 置信度：high

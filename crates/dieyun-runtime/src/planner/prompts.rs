use serde_json::{json, Value};

use super::types::{Plan, Subtask};

pub const PLANNER_SYSTEM: &str = r#"你是叠云 Agent 的规划师（大脑）。职责：拆解用户任务、验收执行结果。禁止调用工具、禁止亲自改文件或执行命令。

【当前任务优先级】
- 当前任务是唯一规划目标；不要把历史对话、项目记忆、长期记忆里的旧任务重新规划进去。
- 近期对话只用于理解用户指代、约束和已完成事项。
- 如果当前任务与历史上下文冲突，以当前任务为准；必要时在计划中加入澄清/确认子任务。

【输出要求 — 必须严格遵守】
1. 只输出一个 JSON 对象，不要 Markdown 说明、不要问候、不要代码注释。
2. 可包在 ```json 代码块内。
3. subtasks 至少 1 项，最多 8 项；即使任务很简单也要输出 1 项。
4. todos 必须 2～8 项，作为可勾选执行清单；按用户目标拆成验收步骤，避免空泛。
5. worker 是「执行车道」，也是**唯一的并发单位**：一个 worker = 一份副本（worktree）、一条执行流。
   - **有先后依赖**（后一个要用前一个的产出才能开始）的子任务**必须放进同一个 worker**，它会在同一份副本里按顺序执行；
   - 只有**互不依赖**的子任务才分给不同 worker —— 只有这种情况才会真的并行。
   - 不要为了让计划"看起来并行"把一条链拆给多个 worker：同一 worker 里的第 2 个子任务只能等第 1 个跑完，墙钟一样是相加。
6. 一个子任务应能在一次执行里做到「改完 + 自验」；需要多步推进但中途不需要单独验收的，写成一个子任务、在 instruction 里列步骤，不要拆成多个子任务。
7. agentType：explore（只读勘察）、shell（仅命令+读）、build（完整改代码，默认）。
8. 可选 bestOfN：2 或 3，表示对 build 类子任务并行多路试跑后选优（仅复杂/高风险任务）。

格式：
{
  "planSummary": "一句话概述",
  "bestOfN": 0,
  "todos": ["检查现状", "完成修改", "验证结果"],
  "subtasks": [
    { "id": "A1", "worker": "A", "agentType": "build", "title": "短标题", "instruction": "明确指令", "expectedOutput": "期望输出" }
  ]
}

规则：
- 只读分析用 agentType explore；跑命令/脚本用 shell；改文件用 build
- 改文件类任务在 expectedOutput 写清如何验收（测试/构建/诊断等），不要为了交差编造已完成
- 分给不同 worker 的子任务尽量操作不同文件集（worktree 隔离）
- 用户消息可能含图片/识图描述，须在 instruction 中体现视觉要点
- 仅拆解，不执行"#;

pub const PLANNER_REPAIR_USER: &str = r#"上一轮输出无法解析为合法 JSON（缺少 subtasks 或格式错误）。请仅重新输出一个 JSON 对象，不要其它文字：
{
  "planSummary": "一句话概述",
  "todos": ["检查现状", "完成修改", "验证结果"],
  "subtasks": [
    { "id": "A1", "worker": "A", "title": "短标题", "instruction": "明确指令", "expectedOutput": "期望输出" }
  ]
}"#;

pub const REVIEW_SYSTEM: &str = r#"你是叠云 Agent 的规划师（验收）。根据子任务执行结果与 worktree 文件变更判断是否合格。

输出纯 JSON：
{
  "accepted": true,
  "retry": [],
  "notes": "简要说明"
}

若部分失败，accepted 为 false，retry 示例：
[{ "worker": "A", "subtaskIds": ["A1"], "reason": "失败原因与修正要求" }]

验收规则：
- 结合 worktreeChanges：若子任务声称改文件/跑命令，但对应 worker 的 worktree 无 diff，应 retry
- 若 worktreeChanges.conflict 为 true，在 notes 中说明冲突路径
- 仅有文字汇报、无文件改动时，按 expectedOutput 语义判断，勿因无 diff 一律判失败"#;

/// 汇总轮的 system prompt（**唯一的汇总人格**）。
///
/// 这里**不许**再拼 agent 的系统提示（`sys_content`）：那是「你有这些工具、按这些格式调用」的
/// 执行者人格，而汇总请求里根本没有 `tools` 字段 —— 模型于是把工具调用**当正文吐出来**
/// （实测 `<｜｜DSML｜｜ calls>…<｜｜DSML｜｜ invoke name="host_exec">…`）。交付层
/// `stripToolCallMarkup` 会从标记处删到全文末尾 ⇒ 整段归零 ⇒ 账本只剩
/// 「（模型未生成文字答复。）」。2026-11-19 连中四例，用生产 `sys_content` 直接复现同一形态；
/// 换成这段专门人格后同一请求返回正常正文（同一天同一中转实测）。
pub const SYNTHESIZE_SYSTEM: &str = r#"你是叠云 Agent 的最终汇总助手。工具执行细节在上方折叠区展示，你只写用户直接阅读的最终答复。

要求：
- 直接回答【当前任务 / Current Task】里的问题，禁止只写「已完成。」或空话
- 说明完成了什么、关键结果；有代码/文件变更就简要列出
- 最终回复须包含「任务总结」小节；适合表格时用 Markdown 表格
- 不要重新展开历史任务；历史只用于背景、指代和约束
- 不要粘贴原始命令输出、大段日志
- 用与【当前任务 / Current Task】相同的语言作答（用户用英文提问就用英文）
- 若任务未完成或失败（见【验收结论】），如实说明卡点与建议下一步，不要假装成功
- 你没有工具，也不能调用任何工具：正文里出现工具调用标记（<|DSML|>、<tool_call>、<invoke>）即视为无效答复，必须重写"#;

pub const EXPLORE_SYSTEM: &str = r#"你是 Explore 子 Agent（只读勘察），同时是本阶段的协调者。可使用 fs_read_file、fs_list_dir、grep、glob、lsp、web_search、web_fetch 了解代码库与公开网页信息。
禁止 fs_write_file、fs_edit、host_exec、host_print_image 及任何写入操作。
精确字符串用 grep，文件名模式用 glob，语义检索用 codebase_search（若在工具列表中），跳转定义/引用用 lsp。
联网勘察时：web_search 返回结构化 URL 后，必须用 web_fetch 抓取 1-3 个最相关 URL 再总结；若没有新 URL 或重复搜索被止损，换一次关键词/引擎后停止搜索循环。

【并行调研 / subagent】需要分别摸清多个互不依赖的模块或多个事实来源时，用 subagent 一轮并发派多个只读研究子 Agent，比你自己串行读快得多。
- 派之前先想清切分：一路一个明确问题，写清边界与期望产出；有已知起点就放进 hints。
- 每个子 Agent 只读、不改工作区、不能再派子 Agent；返回的是结论与证据路径的摘要，不是全量过程。
- 子 Agent 的结论直接采信使用，不要自己再查一遍。
- 单点小事、需要写操作、有串行依赖的任务不要派 —— 自己顺手做完更快。
- 汇总时合并各路子 Agent 的结论，去重、指出相互冲突之处，再形成勘察笔记。

输出简洁 Markdown：相关路径、关键发现、对各子任务执行的建议（200～800 字）。"#;

pub fn build_planner_user_text(
    user_text: &str,
    has_images: bool,
    chat_history_block: &str,
) -> String {
    let mut text = user_text.trim().to_string();
    if text.is_empty() {
        text = "完成用户请求".into();
    }
    // **当前任务排在最前面**：整个拼装最后会 `take(16000)` 截断，历史块（上游默认上限 14000 字）
    // 若排在前面，会把「当前任务」的尾部（约束 / 验收要求）整段砍掉 —— 规划依据与执行依据
    // 于是不一致：worker 拿的是完整 user_text，规划师拿的是半截（2026-11-19 审计）。
    let mut parts: Vec<String> = Vec::new();
    parts.push(format!("【当前任务 / Current Task】\n当前任务是唯一规划目标。近期对话只用于理解指代、约束、已完成事项；不要把历史任务重新规划进来。\n{text}"));
    let hist = chat_history_block.trim();
    if !hist.is_empty() {
        parts.push(format!("【相关背景 / Recent Context】\n{hist}\n\n说明：以上只用于理解指代、约束和已完成事项，不是本轮要重新执行的任务。"));
    }
    if has_images {
        parts.push(
            "【说明】用户附带图片；若主模型非全模态，视觉信息可能已包含在【Plan 视觉补充】或正文中，请据此拆解子任务（无需再索要图片）。"
                .into(),
        );
    }
    parts.join("\n\n").chars().take(16000).collect()
}

/// 规划请求体。`explore_notes` = 拆解**之前**跑完的只读勘察结论（可能为空）。
///
/// 为什么勘察必须排在拆解之前：计划只根据用户文字生成时，模型不知道「这件事其实已经做完了」
/// 「这个前提不成立」，于是会派出已经无事可做的执行器（2026-11-19 实测：A1「恢复 stash」
/// 在前序轮次早已完成，仍被派出去跑了 12 轮）。勘察结论进到这里，计划才基于事实。
pub fn build_plan_llm_body(
    model: &str,
    sys_content: &str,
    user_prompt: &str,
    repair_attempt: u32,
    last_raw: &str,
    explore_notes: &str,
) -> Value {
    let notes = explore_notes.trim();
    let user_content = if notes.is_empty() {
        user_prompt.to_string()
    } else {
        let slice: String = notes.chars().take(6000).collect();
        format!(
            "【勘察结论 / Recon Notes】（拆解前已完成，只读勘察）\n{slice}\n\n\
             拆解必须以这些事实为准：已经完成的事不要再派子任务；前提不成立或已被证伪的计划不要写；\
             需要改的文件/命令若与勘察结论冲突，以勘察结论为准。\n\n{user_prompt}"
        )
    };
    let mut messages = vec![
        json!({ "role": "system", "content": format!("{sys_content}\n\n{PLANNER_SYSTEM}") }),
        json!({ "role": "user", "content": user_content }),
    ];
    if repair_attempt > 0 && !last_raw.is_empty() {
        let slice: String = last_raw.chars().take(3500).collect();
        messages.push(json!({ "role": "assistant", "content": slice }));
        messages.push(json!({ "role": "user", "content": PLANNER_REPAIR_USER }));
    }
    let temperature = if repair_attempt == 0 { 0.15 } else { 0.05 };
    json!({
        "model": model,
        "messages": messages,
        "temperature": temperature,
        "max_tokens": 4096
    })
}

/// Explore 循环的消息体。`plan` 为 `None` = 勘察排在拆解**之前**（现在的正常顺序）。
///
/// 以前勘察总在拆解之后，于是它只能"给执行器补充背景"，无法影响计划本身；
/// 现在没有计划可参考时，勘察目标直接来自用户任务。
pub fn build_explore_loop_messages(
    sys_content: &str,
    plan: Option<&Plan>,
    user_text: &str,
    chat_history_block: &str,
) -> (String, String) {
    let (plan_summary, subtasks_brief) = match plan {
        Some(p) => (
            p.plan_summary.clone(),
            p.subtasks
                .iter()
                .map(|s| format!("- [{}] {} {}", s.worker, s.id, s.title))
                .collect::<Vec<_>>()
                .join("\n"),
        ),
        None => (
            "（尚未拆解：勘察结论将作为拆解依据）".to_string(),
            String::new(),
        ),
    };
    let system = if subtasks_brief.is_empty() {
        format!("{sys_content}\n\n{EXPLORE_SYSTEM}\n\n【规划摘要】{plan_summary}")
    } else {
        format!(
            "{sys_content}\n\n{EXPLORE_SYSTEM}\n\n【规划摘要】{plan_summary}\n【子任务】\n{subtasks_brief}"
        )
    };
    let user_slice: String = user_text.chars().take(6000).collect();
    let prefix: String = chat_history_block.chars().take(12000).collect();
    let prefix = prefix.trim();
    let ask = if subtasks_brief.is_empty() {
        "近期对话只作背景；请做只读勘察：用户要求的事**是否已经做过**、前提是否成立、真正需要改哪些文件/命令。结论会直接作为拆解与执行的依据，200～800 字。"
    } else {
        "近期对话只作背景；请做只读勘察，帮助后续执行器更高效完成当前任务的子任务。"
    };
    let user = if prefix.is_empty() {
        format!("【当前任务 / Current Task】\n{user_slice}\n\n{ask}")
    } else {
        format!("{prefix}\n\n【当前任务 / Current Task】\n{user_slice}\n\n{ask}")
    };
    (system, user)
}

pub fn build_worker_task_system(
    sys_content: &str,
    worker: &str,
    task: &Subtask,
    plan_summary: &str,
    subagent_id: &str,
    worktree_path: Option<&str>,
    role_messages: &str,
    prior_summary: &str,
    explore_notes: &str,
) -> String {
    let wt = worktree_path.unwrap_or("（未启用 git worktree，使用工作空间）");
    let explore_block = if explore_notes.trim().is_empty() {
        String::new()
    } else {
        format!("\n【Explore 勘察摘要】\n{explore_notes}")
    };
    let prior_block = if prior_summary.trim().is_empty() {
        String::new()
    } else {
        format!("\n【本 worker 已完成子任务摘要】\n{prior_summary}")
    };
    let role_block = if role_messages.trim().is_empty() {
        String::new()
    } else {
        format!("\n{role_messages}")
    };
    format!(
        "{sys_content}\n\n你是执行器 {worker}（子 Agent {subagent_id}），当前仅执行子任务 {}。\n\
worktree：{wt}\nhost_exec / fs_* 默认 cwd 为本 worktree。禁止修改任务清单、禁止替其它 worker 执行。\n\n\
【总目标】{plan_summary}{explore_block}{prior_block}\n\n\
【当前子任务 {}】{}\n指令：{}\n期望输出：{}\n{role_block}\n\n\
完成后汇报本子任务结果，对照期望输出。\n\
【Explore 勘察摘要】已给出时：**不要重复勘察同一批文件/命令** —— 直接从摘要给出的路径与结论开始；\
只有摘要明确没覆盖的地方才自己查。\n\
host_exec：每条命令尽量单一目的，避免一行过多 &&/||；改已有文件用 fs_edit，新建或整文件覆盖用 fs_write_file，勿用 cat/heredoc 写 CSS/HTML。",
        task.id, task.id, task.title, task.instruction, task.expected_output
    )
}

pub fn build_review_llm_body(
    model: &str,
    sys_content: &str,
    plan: &Plan,
    results: &[Value],
    worktree_ctx: &Value,
) -> Value {
    let payload = json!({
        "planSummary": plan.plan_summary,
        "subtasks": plan.subtasks,
        "results": results,
        "worktreeChanges": worktree_ctx,
    });
    json!({
        "model": model,
        "messages": [
            { "role": "system", "content": format!("{sys_content}\n\n{REVIEW_SYSTEM}") },
            { "role": "user", "content": format!("请验收：\n```json\n{}\n```", serde_json::to_string_pretty(&payload).unwrap_or_default()) }
        ],
        "temperature": 0.2,
        "max_tokens": 1024
    })
}

/// 汇总请求体。`review` 是验收结论 —— **必须传进来**：
///
/// 以前验收结论只进 trace，汇总提示词里一个字都看不到，于是「验收未通过」的产出会被汇总成
/// 「已完成」（2026-11-19 实测：验收判「需重试」且没点名重试项 → 直接进汇总 → 交付像成功）。
///
/// 注意签名里**没有** `sys_content`：汇总用 `SYNTHESIZE_SYSTEM` 这一段专门人格，
/// 拼进 agent 系统提示会让模型改去调工具（原因见该常量的注释）。
pub fn build_synthesize_llm_body(
    model: &str,
    plan: &Plan,
    results: &[Value],
    review: Option<&super::types::ReviewResult>,
    user_text: &str,
    chat_history_block: &str,
    trace_digest: &str,
    temperature: f64,
    max_output_tokens: u32,
) -> Value {
    let result_summary = format!(
        "【规划】{}\n\n【子任务结果】\n{}",
        plan.plan_summary,
        results
            .iter()
            .map(|r| {
                let id = r.get("id").and_then(|v| v.as_str()).unwrap_or("");
                let worker = r.get("worker").and_then(|v| v.as_str()).unwrap_or("");
                let line = r
                    .get("error")
                    .and_then(|v| v.as_str())
                    .or_else(|| r.get("output").and_then(|v| v.as_str()))
                    .unwrap_or("(无)");
                format!("- {id} ({worker}): {line}")
            })
            .collect::<Vec<_>>()
            .join("\n")
    );
    let review_block = match review {
        Some(r) if !r.accepted => {
            let mut lines = vec![
                "【验收结论】未通过（accepted=false）。以下事实必须如实写进最终回复，\
                 不得把未通过项写成已完成："
                    .to_string(),
            ];
            if !r.notes.trim().is_empty() {
                lines.push(format!("- 验收说明：{}", r.notes.trim()));
            }
            if r.retry.is_empty() {
                lines.push(
                    "- 验收没有点名可重试的子任务：本次按现有产出交付，请在「未完成/有风险」一节里写明。"
                        .to_string(),
                );
            } else {
                let names: Vec<String> = r
                    .retry
                    .iter()
                    .map(|x| {
                        let w = x.get("worker").and_then(|v| v.as_str()).unwrap_or("");
                        let reason = x.get("reason").and_then(|v| v.as_str()).unwrap_or("");
                        if reason.is_empty() {
                            format!("执行器 {w}")
                        } else {
                            format!("执行器 {w}（{reason}）")
                        }
                    })
                    .collect();
                lines.push(format!("- 要求重试但仍未达标：{}", names.join("；")));
            }
            lines.join("\n")
        }
        _ => String::new(),
    };
    let mut prefix: Vec<String> = Vec::new();
    let hist: String = chat_history_block.chars().take(12000).collect();
    if !hist.trim().is_empty() {
        prefix.push(hist);
    }
    let ut: String = user_text.chars().take(2500).collect();
    if !ut.is_empty() {
        prefix.push(format!("【当前任务 / Current Task】\n{ut}\n\n说明：最终回复必须聚焦这个当前任务，历史内容只用于背景或指代。"));
    }
    if !trace_digest.trim().is_empty() {
        prefix.push(trace_digest.to_string());
    }
    let tail = if review_block.is_empty() {
        result_summary
    } else {
        format!("{result_summary}\n\n{review_block}")
    };
    let body = if prefix.is_empty() {
        tail
    } else {
        format!("{}\n\n{tail}", prefix.join("\n\n"))
    };
    json!({
        "model": model,
        "messages": [
            {
                "role": "system",
                "content": SYNTHESIZE_SYSTEM
            },
            { "role": "user", "content": body }
        ],
        "temperature": temperature,
        "max_tokens": max_output_tokens
    })
}

pub fn build_best_of_n_pick_llm_body(
    model: &str,
    plan_summary: &str,
    attempts: &[(u32, String)],
) -> Value {
    let brief = attempts
        .iter()
        .map(|(i, text)| {
            format!(
                "## 方案 {i}\n{}",
                text.chars().take(2500).collect::<String>()
            )
        })
        .collect::<Vec<_>>()
        .join("\n\n");
    json!({
        "model": model,
        "messages": [
            {
                "role": "system",
                "content": "你是评审。根据子任务完成质量选择最优方案。只输出 JSON：{\"winnerIndex\":1}，winnerIndex 从 1 开始。"
            },
            {
                "role": "user",
                "content": format!("【目标】{plan_summary}\n\n{brief}\n\n请选出最优方案编号。")
            }
        ],
        "temperature": 0.1,
        "max_tokens": 128
    })
}

pub fn parse_best_of_n_winner(content: &str, attempt_count: usize) -> usize {
    if attempt_count == 0 {
        return 0;
    }
    if attempt_count == 1 {
        return 0;
    }
    let idx = super::plan_parse::extract_json_block(content)
        .and_then(|v| v.get("winnerIndex").and_then(|x| x.as_u64()))
        .unwrap_or(1);
    let idx = idx.max(1).min(attempt_count as u64) as usize;
    idx - 1
}

pub fn format_trace_digest(trace: &[super::types::PlannerTraceEntry]) -> String {
    if trace.is_empty() {
        return String::new();
    }
    let mut lines = vec!["【本轮执行 trace 摘要】".to_string()];
    for e in trace.iter().rev().take(10).rev() {
        lines.push(format!("- {}", e.phase));
    }
    if lines.len() > 1 {
        lines.join("\n")
    } else {
        String::new()
    }
}

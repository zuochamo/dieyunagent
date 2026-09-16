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
5. worker 使用 "A"～"F" 或 "W1"、"W2"（多路并行）；互不依赖的子任务分给不同 worker。
6. agentType：explore（只读勘察）、shell（仅命令+读）、build（完整改代码，默认）。
7. 可选 bestOfN：2 或 3，表示对 build 类子任务并行多路试跑后选优（仅复杂/高风险任务）。

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

pub const EXPLORE_SYSTEM: &str = r#"你是 Explore 子 Agent（只读勘察）。可使用 fs_read_file、fs_list_dir、grep、glob、lsp、sql_query、web_search、web_fetch 了解代码库与公开网页信息。
禁止 fs_write_file、fs_edit、host_exec、host_print_image 及任何写入操作。
精确字符串用 grep，文件名模式用 glob，语义检索用 codebase_search（若在工具列表中），跳转定义/引用用 lsp。
联网勘察时：web_search 返回结构化 URL 后，必须用 web_fetch 抓取 1-3 个最相关 URL 再总结；若没有新 URL 或重复搜索被止损，换一次关键词/引擎后停止搜索循环。
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
    let mut parts: Vec<String> = Vec::new();
    let hist = chat_history_block.trim();
    if !hist.is_empty() {
        parts.push(format!("【相关背景 / Recent Context】\n{hist}\n\n说明：以上只用于理解指代、约束和已完成事项，不是本轮要重新执行的任务。"));
    }
    parts.push(format!("【当前任务 / Current Task】\n当前任务是唯一规划目标。近期对话只用于理解指代、约束、已完成事项；不要把历史任务重新规划进来。\n{text}"));
    if has_images {
        parts.push(
            "【说明】用户附带图片；若主模型非全模态，视觉信息可能已包含在【Plan 视觉补充】或正文中，请据此拆解子任务（无需再索要图片）。"
                .into(),
        );
    }
    parts.join("\n\n").chars().take(16000).collect()
}

pub fn build_plan_llm_body(
    model: &str,
    sys_content: &str,
    user_prompt: &str,
    repair_attempt: u32,
    last_raw: &str,
) -> Value {
    let mut messages = vec![
        json!({ "role": "system", "content": format!("{sys_content}\n\n{PLANNER_SYSTEM}") }),
        json!({ "role": "user", "content": user_prompt }),
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

pub fn build_explore_loop_messages(
    sys_content: &str,
    plan: &Plan,
    user_text: &str,
    chat_history_block: &str,
) -> (String, String) {
    let subtasks_brief = plan
        .subtasks
        .iter()
        .map(|s| format!("- [{}] {} {}", s.worker, s.id, s.title))
        .collect::<Vec<_>>()
        .join("\n");
    let system = format!(
        "{sys_content}\n\n{EXPLORE_SYSTEM}\n\n【规划摘要】{}\n【子任务】\n{subtasks_brief}",
        plan.plan_summary
    );
    let user_slice: String = user_text.chars().take(6000).collect();
    let prefix: String = chat_history_block.chars().take(12000).collect();
    let prefix = prefix.trim();
    let user = if prefix.is_empty() {
        format!("【当前任务 / Current Task】\n{user_slice}\n\n近期对话只作背景；请做只读勘察，帮助后续执行器更高效完成当前任务的子任务。")
    } else {
        format!("{prefix}\n\n【当前任务 / Current Task】\n{user_slice}\n\n近期对话只作背景；请做只读勘察，帮助后续执行器更高效完成当前任务的子任务。")
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

pub fn build_synthesize_llm_body(
    model: &str,
    sys_content: &str,
    plan: &Plan,
    results: &[Value],
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
    let body = if prefix.is_empty() {
        result_summary
    } else {
        format!("{}\n\n{result_summary}", prefix.join("\n\n"))
    };
    json!({
        "model": model,
        "messages": [
            {
                "role": "system",
                "content": format!("{sys_content}\n\n你是叠云 Agent 的最终汇总助手。最终回复须包含「任务总结」小节；若适合表格呈现，请用 Markdown 表格。必须聚焦最后的【当前任务 / Current Task】，不要重新展开历史任务；历史只用于背景、指代和约束。")
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

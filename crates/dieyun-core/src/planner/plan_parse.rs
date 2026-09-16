use serde_json::{json, Value};

use super::types::{Plan, ReviewResult, Subtask, WorkerJobOut, WorkerResultInput};

pub fn extract_json_block(text: &str) -> Option<Value> {
    let raw = text.trim();
    if raw.is_empty() {
        return None;
    }
    let mut candidates: Vec<String> = Vec::new();
    for cap in regex_lite_find_json_fences(raw) {
        candidates.push(cap);
    }
    candidates.push(raw.to_string());
    if let Some(start) = raw.find('{') {
        if let Some(end) = raw.rfind('}') {
            if end > start {
                candidates.push(raw[start..=end].to_string());
            }
        }
    }
    for cand in candidates {
        for s in [cand.as_str(), strip_loose_json(&cand).as_str()] {
            if let Ok(v) = serde_json::from_str::<Value>(s) {
                return Some(v);
            }
        }
    }
    None
}

fn regex_lite_find_json_fences(raw: &str) -> Vec<String> {
    let mut out = Vec::new();
    let lower = raw.to_lowercase();
    let mut i = 0;
    while let Some(idx) = lower[i..].find("```") {
        let start = i + idx + 3;
        let rest = &raw[start..];
        let after_tick = rest.trim_start();
        let content_start = start + (rest.len() - after_tick.len());
        if let Some(end_idx) = after_tick.find("```") {
            let inner = after_tick[..end_idx].trim();
            let inner = inner
                .strip_prefix("json")
                .or_else(|| inner.strip_prefix("JSON"))
                .unwrap_or(inner)
                .trim();
            if !inner.is_empty() {
                out.push(inner.to_string());
            }
            i = content_start + end_idx + 3;
        } else {
            break;
        }
    }
    out
}

fn strip_loose_json(text: &str) -> String {
    text.replace(['\u{201c}', '\u{201d}'], "\"")
        .replace(['\u{2018}', '\u{2019}'], "'")
        .replace(",}", "}")
        .replace(",]", "]")
}

pub fn normalize_worker_id(raw: &str) -> String {
    let w = raw.trim().to_uppercase();
    if w.len() == 1 && w.chars().next().unwrap().is_ascii_uppercase() && w <= "F".to_string() {
        return w;
    }
    if w.starts_with('W') && w[1..].chars().all(|c| c.is_ascii_digit()) {
        return w;
    }
    if w.contains("-BN") {
        return w;
    }
    "A".into()
}

pub fn normalize_agent_type(raw: &str) -> String {
    match raw.trim().to_lowercase().as_str() {
        "explore" => "explore".into(),
        "shell" => "shell".into(),
        "build" => "build".into(),
        _ => "build".into(),
    }
}

pub fn worker_job_needs_best_of_n(plan: &Plan, job: &WorkerJobOut) -> bool {
    plan.best_of_n > 1
        && job
            .tasks
            .iter()
            .any(|t| normalize_agent_type(&t.agent_type) == "build")
}

pub fn parse_completed_outputs(
    value: Option<&Value>,
) -> (std::collections::HashSet<String>, Vec<WorkerResultInput>) {
    use std::collections::HashSet;
    let mut ids = HashSet::new();
    let mut results = Vec::new();
    let Some(arr) = value.and_then(|v| v.as_array()) else {
        return (ids, results);
    };
    for o in arr {
        let id = o
            .get("id")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
            .to_string();
        if id.is_empty() {
            continue;
        }
        ids.insert(id.clone());
        results.push(WorkerResultInput {
            id,
            worker: o
                .get("worker")
                .and_then(|v| v.as_str())
                .unwrap_or("A")
                .to_string(),
            subagent_id: o
                .get("subagentId")
                .or_else(|| o.get("subagent_id"))
                .and_then(|v| v.as_str())
                .map(String::from),
            output: o.get("output").and_then(|v| v.as_str()).map(String::from),
            error: o.get("error").and_then(|v| v.as_str()).map(String::from),
        });
    }
    (ids, results)
}

fn normalize_one_subtask(
    raw: &Value,
    worker_seq: &mut std::collections::HashMap<String, u32>,
) -> Option<Subtask> {
    let obj = raw.as_object()?;
    let instruction = obj
        .get("instruction")
        .or_else(|| obj.get("prompt"))
        .or_else(|| obj.get("description"))
        .or_else(|| obj.get("desc"))
        .or_else(|| obj.get("content"))
        .or_else(|| obj.get("task"))
        .or_else(|| obj.get("detail"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim();
    if instruction.is_empty() {
        return None;
    }
    let worker = normalize_worker_id(
        obj.get("worker")
            .or_else(|| obj.get("executor"))
            .or_else(|| obj.get("assignee"))
            .and_then(|v| v.as_str())
            .unwrap_or("A"),
    );
    let seq = worker_seq.entry(worker.clone()).or_insert(0);
    *seq += 1;
    let id = obj
        .get("id")
        .or_else(|| obj.get("taskId"))
        .or_else(|| obj.get("task_id"))
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| format!("{worker}{seq}"));
    let title = obj
        .get("title")
        .or_else(|| obj.get("name"))
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| instruction.chars().take(48).collect());
    let expected_output = obj
        .get("expectedOutput")
        .or_else(|| obj.get("expected_output"))
        .or_else(|| obj.get("output"))
        .or_else(|| obj.get("deliverable"))
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| instruction.to_string());
    let agent_type = normalize_agent_type(
        obj.get("agentType")
            .or_else(|| obj.get("agent_type"))
            .or_else(|| obj.get("type"))
            .and_then(|v| v.as_str())
            .unwrap_or("build"),
    );
    Some(Subtask {
        id,
        worker,
        title,
        instruction: instruction.to_string(),
        expected_output,
        agent_type,
    })
}

fn normalize_todo_list(
    raw: Option<&Value>,
    subtasks: &[Subtask],
    plan_summary: &str,
) -> Vec<String> {
    let mut todos: Vec<String> = raw
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|x| x.as_str().map(|s| s.trim().to_string()))
                .filter(|s| !s.is_empty())
                .take(20)
                .collect()
        })
        .unwrap_or_default();
    if !todos.is_empty() {
        return todos;
    }
    todos = subtasks
        .iter()
        .filter_map(|st| {
            let t = if st.title.is_empty() {
                st.instruction.clone()
            } else {
                st.title.clone()
            };
            let t = t.trim().to_string();
            if t.is_empty() {
                None
            } else {
                Some(t)
            }
        })
        .take(8)
        .collect();
    if !todos.is_empty() {
        return todos;
    }
    let summary = plan_summary.trim();
    if summary.is_empty() {
        vec!["完成用户请求并交付结果".into()]
    } else {
        vec![summary.to_string()]
    }
}

pub fn normalize_plan_payload(parsed: &Value, _user_text: &str) -> Option<Plan> {
    if let Some(arr) = parsed.as_array() {
        let mut worker_seq = std::collections::HashMap::new();
        let subtasks: Vec<Subtask> = arr
            .iter()
            .filter_map(|item| normalize_one_subtask(item, &mut worker_seq))
            .collect();
        if subtasks.is_empty() {
            return None;
        }
        return Some(Plan {
            plan_summary: "任务执行".into(),
            todos: normalize_todo_list(None, &subtasks, "任务执行"),
            subtasks,
            best_of_n: 0,
            fallback: false,
        });
    }
    let obj = parsed.as_object()?;
    let mut subtasks_raw = obj
        .get("subtasks")
        .or_else(|| obj.get("tasks"))
        .or_else(|| obj.get("steps"))
        .or_else(|| obj.get("subTasks"))
        .or_else(|| obj.get("children"));
    if subtasks_raw.is_none() {
        if let Some(plan) = obj.get("plan").and_then(|p| p.as_object()) {
            subtasks_raw = plan.get("subtasks").or_else(|| plan.get("tasks"));
        }
    }
    let subtasks: Vec<Subtask> = if let Some(arr) = subtasks_raw.and_then(|v| v.as_array()) {
        let mut worker_seq = std::collections::HashMap::new();
        arr.iter()
            .filter_map(|raw| normalize_one_subtask(raw, &mut worker_seq))
            .collect()
    } else if obj.contains_key("instruction")
        || obj.contains_key("title")
        || obj.contains_key("description")
    {
        let mut worker_seq = std::collections::HashMap::new();
        normalize_one_subtask(parsed, &mut worker_seq)
            .into_iter()
            .collect()
    } else {
        return None;
    };
    if subtasks.is_empty() {
        return None;
    }
    let plan_summary = obj
        .get("planSummary")
        .or_else(|| obj.get("summary"))
        .or_else(|| obj.get("title"))
        .or_else(|| obj.get("overview"))
        .and_then(|v| v.as_str())
        .unwrap_or("任务执行")
        .trim()
        .to_string();
    let nested = obj.get("plan").and_then(|p| p.as_object());
    let raw_todos = obj
        .get("todos")
        .or_else(|| obj.get("todoList"))
        .or_else(|| obj.get("todo_list"))
        .or_else(|| obj.get("checklist"))
        .or_else(|| nested.and_then(|p| p.get("todos")))
        .or_else(|| nested.and_then(|p| p.get("todoList")))
        .or_else(|| nested.and_then(|p| p.get("checklist")));
    let best_of_n = obj
        .get("bestOfN")
        .or_else(|| obj.get("best_of_n"))
        .and_then(|v| v.as_u64())
        .unwrap_or(0) as u32;
    let best_of_n = best_of_n.min(3);
    Some(Plan {
        plan_summary,
        todos: normalize_todo_list(raw_todos, &subtasks, &subtasks[0].title),
        subtasks,
        best_of_n: if best_of_n > 1 { best_of_n } else { 0 },
        fallback: false,
    })
}

pub fn try_parse_plan_from_content(content: &str, user_text: &str) -> Option<Plan> {
    extract_json_block(content).and_then(|p| normalize_plan_payload(&p, user_text))
}

pub fn build_fallback_plan(user_text: &str) -> Plan {
    let brief: String = user_text.chars().take(4000).collect();
    let brief = if brief.trim().is_empty() {
        "完成用户任务".to_string()
    } else {
        brief
    };
    Plan {
        plan_summary: "单步执行（规划输出未通过校验，已自动降级为单任务）".into(),
        todos: vec![
            "理解用户请求".into(),
            "完成必要修改或操作".into(),
            "验证结果并汇报".into(),
        ],
        subtasks: vec![Subtask {
            id: "A1".into(),
            worker: "A".into(),
            title: "执行用户任务".into(),
            instruction: format!(
                "请根据以下用户请求完成工作（含图片/附件说明时一并处理）：\n\n{brief}"
            ),
            expected_output: "完成用户请求，并给出可验收的结果摘要".into(),
            agent_type: "build".into(),
        }],
        best_of_n: 0,
        fallback: true,
    }
}

pub fn parse_review_content(content: &str) -> ReviewResult {
    if let Some(parsed) = extract_json_block(content) {
        let accepted = parsed
            .get("accepted")
            .and_then(|v| v.as_bool())
            .unwrap_or(true);
        let retry = parsed
            .get("retry")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();
        let notes = parsed
            .get("notes")
            .and_then(|v| v.as_str())
            .unwrap_or(content)
            .to_string();
        return ReviewResult {
            accepted,
            retry,
            notes,
        };
    }
    ReviewResult {
        accepted: true,
        retry: vec![],
        notes: content.to_string(),
    }
}

pub fn collect_workers_from_plan(subtasks: &[Subtask]) -> Vec<String> {
    let mut set = std::collections::BTreeSet::new();
    for st in subtasks {
        set.insert(st.worker.clone());
    }
    set.into_iter().collect()
}

pub fn plan_to_json(plan: &Plan) -> Value {
    json!({
        "planSummary": plan.plan_summary,
        "todos": plan.todos,
        "bestOfN": plan.best_of_n,
        "fallback": plan.fallback,
        "subtasks": plan.subtasks.iter().map(|st| json!({
            "id": st.id,
            "worker": st.worker,
            "title": st.title,
            "instruction": st.instruction,
            "expectedOutput": st.expected_output,
            "agentType": st.agent_type,
        })).collect::<Vec<_>>(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_plan_json_block() {
        let raw = r#"```json
{"planSummary":"test","subtasks":[{"id":"A1","worker":"A","title":"t","instruction":"do it","expectedOutput":"done"}]}
```"#;
        let plan = try_parse_plan_from_content(raw, "user").unwrap();
        assert_eq!(plan.subtasks.len(), 1);
        assert_eq!(plan.subtasks[0].id, "A1");
    }

    #[test]
    fn fallback_plan() {
        let p = build_fallback_plan("fix bug");
        assert_eq!(p.subtasks.len(), 1);
        assert!(p.fallback);
    }

    fn sample_subtask(id: &str, worker: &str, agent_type: &str) -> Subtask {
        Subtask {
            id: id.into(),
            worker: worker.into(),
            title: "t".into(),
            instruction: "i".into(),
            expected_output: "o".into(),
            agent_type: agent_type.into(),
        }
    }

    #[test]
    fn collect_workers_splits_two_workers() {
        let subtasks = vec![
            sample_subtask("A1", "A", "build"),
            sample_subtask("B1", "B", "explore"),
        ];
        assert_eq!(
            collect_workers_from_plan(&subtasks),
            vec!["A".to_string(), "B".to_string()]
        );
    }

    #[test]
    fn worker_job_needs_best_of_n_only_for_build() {
        let plan = Plan {
            plan_summary: "s".into(),
            todos: vec![],
            subtasks: vec![],
            best_of_n: 3,
            fallback: false,
        };
        let build_job = WorkerJobOut {
            worker: "A".into(),
            tasks: vec![sample_subtask("A1", "A", "build")],
            is_retry: false,
            retry_reason: None,
            use_best_of_n: false,
            best_of_n_total: 0,
        };
        let explore_job = WorkerJobOut {
            worker: "B".into(),
            tasks: vec![sample_subtask("B1", "B", "explore")],
            is_retry: false,
            retry_reason: None,
            use_best_of_n: false,
            best_of_n_total: 0,
        };
        assert!(worker_job_needs_best_of_n(&plan, &build_job));
        assert!(!worker_job_needs_best_of_n(&plan, &explore_job));
    }
}

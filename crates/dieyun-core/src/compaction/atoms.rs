use std::collections::HashSet;

use serde_json::{json, Value};

use super::tokens::estimate_tokens;

pub const COMPACT_DIGEST_MARK: &str = "【对话摘要】";

#[derive(Debug, Clone)]
pub struct Atom {
    pub assistant: Option<Value>,
    pub tools: Vec<Value>,
    pub other: Option<Value>,
    pub tokens: usize,
}

pub fn group_messages_into_atoms(messages: &[Value]) -> Vec<Atom> {
    let mut atoms = Vec::new();
    let mut pending: Option<Atom> = None;

    for m in messages {
        let role = m.get("role").and_then(|v| v.as_str()).unwrap_or("");
        let has_tool_calls = role == "assistant"
            && m.get("tool_calls")
                .and_then(|v| v.as_array())
                .map(|a| !a.is_empty())
                .unwrap_or(false);

        if has_tool_calls {
            if let Some(p) = pending.take() {
                atoms.push(p);
            }
            pending = Some(Atom {
                assistant: Some(m.clone()),
                tools: Vec::new(),
                other: None,
                tokens: estimate_tokens(&m.get("content").cloned().unwrap_or(Value::Null)),
            });
        } else if role == "tool" {
            if let Some(p) = &mut pending {
                let t = estimate_tokens(&m.get("content").cloned().unwrap_or(Value::Null)) + 4;
                p.tools.push(m.clone());
                p.tokens += t;
            }
        } else {
            if let Some(p) = pending.take() {
                atoms.push(p);
            }
            atoms.push(Atom {
                assistant: None,
                tools: Vec::new(),
                other: Some(m.clone()),
                tokens: estimate_tokens(&m.get("content").cloned().unwrap_or(Value::Null)) + 4,
            });
        }
    }
    if let Some(p) = pending {
        atoms.push(p);
    }
    atoms
}

pub fn is_user_atom(a: &Atom) -> bool {
    a.other
        .as_ref()
        .and_then(|m| m.get("role"))
        .and_then(|v| v.as_str())
        == Some("user")
}

pub fn is_pinned_atom(a: &Atom) -> bool {
    is_user_atom(a)
}

pub fn is_compact_digest_atom(a: &Atom) -> bool {
    if !is_user_atom(a) {
        return false;
    }
    let content = a
        .other
        .as_ref()
        .and_then(|m| m.get("content"))
        .and_then(|v| v.as_str())
        .unwrap_or("");
    content.contains(COMPACT_DIGEST_MARK)
}

pub fn atom_to_messages(a: &Atom) -> Vec<Value> {
    let mut out = Vec::new();
    if let Some(o) = &a.other {
        out.push(o.clone());
    } else if let Some(asst) = &a.assistant {
        out.push(asst.clone());
        out.extend(a.tools.iter().cloned());
    }
    out
}

pub fn format_atoms_for_summary(atoms: &[Atom]) -> String {
    let mut lines = Vec::new();
    for a in atoms {
        if is_user_atom(a) {
            continue;
        }
        if let Some(o) = &a.other {
            let role = o.get("role").and_then(|v| v.as_str()).unwrap_or("unknown");
            let body = content_as_string(o.get("content"), 6000);
            lines.push(format!("[{role}]\n{body}"));
        } else if let Some(asst) = &a.assistant {
            let body = content_as_string(asst.get("content"), 6000);
            let tool_names: Vec<String> = asst
                .get("tool_calls")
                .and_then(|v| v.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|tc| {
                            tc.get("function")
                                .and_then(|f| f.get("name"))
                                .and_then(|n| n.as_str())
                                .map(str::to_string)
                        })
                        .collect()
                })
                .unwrap_or_default();
            let tool_line = if tool_names.is_empty() {
                String::new()
            } else {
                format!(" [调用工具: {}]", tool_names.join(", "))
            };
            lines.push(format!("[assistant{tool_line}]\n{body}"));
            for t in &a.tools {
                let body = content_as_string(t.get("content"), 4000);
                lines.push(format!("[tool_result]\n{body}"));
            }
        }
    }
    lines.join("\n\n---\n\n")
}

pub fn reassemble_after_compaction(
    systems: &[Value],
    atoms: &[Atom],
    folded: &HashSet<usize>,
    compact_user: Value,
    compact_ack: Value,
) -> Vec<Value> {
    let mut next: Vec<Value> = systems
        .iter()
        .filter(|m| {
            !m.get("content")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .contains(COMPACT_DIGEST_MARK)
        })
        .cloned()
        .collect();
    let mut digest_inserted = false;
    for (i, a) in atoms.iter().enumerate() {
        if is_pinned_atom(a) {
            if is_compact_digest_atom(a) {
                continue;
            }
            next.extend(atom_to_messages(a));
        } else if folded.contains(&i) {
            if !digest_inserted {
                next.push(compact_user.clone());
                next.push(compact_ack.clone());
                digest_inserted = true;
            }
        } else {
            next.extend(atom_to_messages(a));
        }
    }
    if !digest_inserted && !folded.is_empty() {
        next.push(compact_user);
        next.push(compact_ack);
    }
    next
}

pub fn partition_atoms(atoms: &[Atom], recent_token_budget: usize) -> (Vec<usize>, Vec<usize>) {
    let mut recent = Vec::new();
    let mut recent_tokens = 0usize;
    let mut split_at = atoms.len();
    for i in (0..atoms.len()).rev() {
        if recent_tokens + atoms[i].tokens <= recent_token_budget {
            recent.push(i);
            recent_tokens += atoms[i].tokens;
        } else {
            split_at = i + 1;
            break;
        }
    }
    recent.reverse();
    let middle: Vec<usize> = (0..split_at).collect();
    (middle, recent)
}

fn content_as_string(content: Option<&Value>, max_chars: usize) -> String {
    let s = match content {
        Some(Value::String(t)) => t.clone(),
        Some(Value::Array(parts)) => parts
            .iter()
            .filter_map(|p| match p {
                Value::String(t) => Some(t.as_str()),
                Value::Object(o) => o
                    .get("text")
                    .or_else(|| o.get("content"))
                    .and_then(|v| v.as_str()),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join("\n"),
        Some(v) => v.as_str().unwrap_or(&v.to_string()).to_string(),
        None => String::new(),
    };
    s.chars().take(max_chars).collect()
}

pub fn format_compaction_summary(json: &Value) -> String {
    let mut lines = Vec::new();
    push_field(&mut lines, "历史进展（非本轮任务）", json.get("summary"));
    push_field(&mut lines, "历史用户目标（非本轮）", json.get("userGoal"));
    push_list(&mut lines, "关键决策", json.get("keyDecisions"), false);
    push_list(&mut lines, "已读文件", json.get("filesRead"), true);
    push_list(&mut lines, "已创建文件", json.get("filesCreated"), true);
    push_list(&mut lines, "已修改文件", json.get("filesModified"), true);
    push_list(
        &mut lines,
        "已执行命令",
        json.get("commandsExecuted"),
        false,
    );
    push_list(&mut lines, "已遇错误", json.get("errors"), false);
    push_list(&mut lines, "未解决", json.get("unresolved"), false);
    push_list(&mut lines, "约束", json.get("constraints"), false);
    push_field(&mut lines, "历史最近操作（非下一步指令）", json.get("lastActions"));
    lines.join("\n\n")
}

fn push_field(lines: &mut Vec<String>, title: &str, value: Option<&Value>) {
    if let Some(Value::String(s)) = value {
        if !s.trim().is_empty() {
            lines.push(format!("**{title}**\n{s}"));
        }
    }
}

fn push_list(lines: &mut Vec<String>, title: &str, value: Option<&Value>, code: bool) {
    let Some(Value::Array(arr)) = value else {
        return;
    };
    if arr.is_empty() {
        return;
    }
    let items: Vec<String> = arr
        .iter()
        .filter_map(|v| v.as_str().map(str::to_string))
        .map(|s| {
            if code {
                format!("- `{s}`")
            } else {
                format!("- {s}")
            }
        })
        .collect();
    if !items.is_empty() {
        lines.push(format!("**{title}**\n{}", items.join("\n")));
    }
}

pub fn build_digest_messages(
    summary_json: &Value,
    compact_prefix: &str,
    compact_suffix: &str,
) -> (Value, Value) {
    let summary_text = format_compaction_summary(summary_json);
    let user = json!({
        "role": "user",
        "content": format!("{compact_prefix}\n{summary_text}")
    });
    let ack = json!({
        "role": "assistant",
        "content": if compact_suffix.is_empty() {
            "收到，已基于压缩摘要继续执行。".to_string()
        } else {
            compact_suffix.to_string()
        }
    });
    (user, ack)
}

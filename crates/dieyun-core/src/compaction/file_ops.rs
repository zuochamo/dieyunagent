use serde_json::{json, Value};

const MAX_PATHS: usize = 40;

#[derive(Debug, Default, Clone)]
pub struct FileOps {
    pub read: Vec<String>,
    pub modified: Vec<String>,
    pub created: Vec<String>,
}

fn parse_args(raw: &Value) -> Value {
    if let Some(s) = raw.as_str() {
        if let Ok(v) = serde_json::from_str::<Value>(s) {
            return v;
        }
        return json!({ "raw": s });
    }
    raw.clone()
}

fn file_path_from_args(args: &Value) -> Option<String> {
    for key in ["filePath", "path", "file", "filename"] {
        if let Some(s) = args.get(key).and_then(|v| v.as_str()) {
            let t = s.trim();
            if !t.is_empty() {
                return Some(t.replace('\\', "/"));
            }
        }
    }
    None
}

fn push_unique(out: &mut Vec<String>, path: String) {
    if out.iter().any(|p| p == &path) {
        return;
    }
    if out.len() >= MAX_PATHS {
        return;
    }
    out.push(path);
}

fn classify_tool(name: &str) -> Option<&'static str> {
    let n = name.trim();
    let n = n.strip_prefix("fs.").unwrap_or(n);
    let n = n.strip_prefix("fs_").unwrap_or(n);
    match n {
        "read_file" | "read" => Some("read"),
        "edit_file" | "edit" | "str_replace" => Some("modified"),
        "write_file" | "write" => Some("created"),
        _ => None,
    }
}

fn ingest_tool_call(ops: &mut FileOps, name: &str, arguments: &Value) {
    let Some(kind) = classify_tool(name) else {
        return;
    };
    let args = parse_args(arguments);
    let Some(path) = file_path_from_args(&args) else {
        return;
    };
    match kind {
        "read" => push_unique(&mut ops.read, path),
        "modified" => push_unique(&mut ops.modified, path),
        "created" => push_unique(&mut ops.created, path),
        _ => {}
    }
}

/// Collect file paths from assistant `tool_calls` in the folded window.
pub fn extract_file_ops_from_messages(messages: &[Value]) -> FileOps {
    let mut ops = FileOps::default();
    for msg in messages {
        let role = msg.get("role").and_then(|v| v.as_str()).unwrap_or("");
        if role != "assistant" {
            continue;
        }
        let Some(calls) = msg.get("tool_calls").and_then(|v| v.as_array()) else {
            continue;
        };
        for tc in calls {
            let name = tc
                .get("function")
                .and_then(|f| f.get("name"))
                .and_then(|v| v.as_str())
                .or_else(|| tc.get("name").and_then(|v| v.as_str()))
                .unwrap_or("");
            let args = tc
                .get("function")
                .and_then(|f| f.get("arguments"))
                .or_else(|| tc.get("arguments"))
                .cloned()
                .unwrap_or(Value::Null);
            ingest_tool_call(&mut ops, name, &args);
        }
    }
    ops
}

fn merge_list(existing: Option<&Value>, extra: &[String]) -> Vec<String> {
    let mut out = Vec::new();
    if let Some(Value::Array(arr)) = existing {
        for v in arr {
            if let Some(s) = v.as_str() {
                push_unique(&mut out, s.trim().replace('\\', "/"));
            }
        }
    }
    for s in extra {
        push_unique(&mut out, s.clone());
    }
    out
}

/// LLM 摘要里的文件列表经常漏；把折叠窗口里真实工具路径并进去。
pub fn merge_summary_file_ops(summary: &Value, ops: &FileOps) -> Value {
    let mut obj = match summary {
        Value::Object(map) => map.clone(),
        _ => serde_json::Map::new(),
    };
    let read = merge_list(obj.get("filesRead"), &ops.read);
    let modified = merge_list(obj.get("filesModified"), &ops.modified);
    let created = merge_list(obj.get("filesCreated"), &ops.created);
    if !read.is_empty() {
        obj.insert("filesRead".into(), json!(read));
    }
    if !modified.is_empty() {
        obj.insert("filesModified".into(), json!(modified));
    }
    if !created.is_empty() {
        obj.insert("filesCreated".into(), json!(created));
    }
    Value::Object(obj)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_read_and_edit_paths() {
        let messages = vec![json!({
            "role": "assistant",
            "tool_calls": [
                {"id":"1","type":"function","function":{"name":"fs_read_file","arguments":"{\"filePath\":\"src/a.js\"}"}},
                {"id":"2","type":"function","function":{"name":"fs_edit","arguments":{"filePath":"src/a.js","oldString":"x","newString":"y"}}},
                {"id":"3","type":"function","function":{"name":"fs_write_file","arguments":{"filePath":"src/b.js","content":"ok"}}}
            ]
        })];
        let ops = extract_file_ops_from_messages(&messages);
        assert_eq!(ops.read, vec!["src/a.js"]);
        assert_eq!(ops.modified, vec!["src/a.js"]);
        assert_eq!(ops.created, vec!["src/b.js"]);
    }

    #[test]
    fn merge_keeps_llm_and_tool_paths() {
        let summary = json!({"filesModified":["old.ts"], "summary":"x"});
        let ops = FileOps {
            read: vec!["src/a.js".into()],
            modified: vec!["src/a.js".into()],
            created: vec![],
        };
        let merged = merge_summary_file_ops(&summary, &ops);
        let modified = merged["filesModified"].as_array().unwrap();
        assert_eq!(modified.len(), 2);
        assert_eq!(merged["filesRead"][0], "src/a.js");
        assert_eq!(merged["summary"], "x");
    }
}

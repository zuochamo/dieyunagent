use serde_json::Value;

fn is_cjk(ch: char) -> bool {
    matches!(ch,
        '\u{4e00}'..='\u{9fff}'
            | '\u{3400}'..='\u{4dbf}'
            | '\u{f900}'..='\u{faff}'
            | '\u{3040}'..='\u{309f}'
            | '\u{30a0}'..='\u{30ff}'
            | '\u{ac00}'..='\u{d7af}'
    )
}

pub fn estimate_tokens(content: &Value) -> usize {
    match content {
        Value::Null => 0,
        Value::String(s) => estimate_text_tokens(s),
        Value::Array(parts) => parts.iter().map(estimate_tokens).sum(),
        Value::Object(obj) => {
            if let Some(Value::String(t)) = obj.get("text").or_else(|| obj.get("content")) {
                estimate_text_tokens(t)
            } else {
                estimate_text_tokens(&content.to_string())
            }
        }
        other => estimate_text_tokens(&other.to_string()),
    }
}

pub fn estimate_text_tokens(text: &str) -> usize {
    let mut cjk = 0usize;
    let mut total = 0usize;
    for ch in text.chars() {
        total += 1;
        if is_cjk(ch) {
            cjk += 1;
        }
    }
    let other = total.saturating_sub(cjk);
    ((cjk as f64 / 1.5) + (other as f64 / 3.2)).ceil() as usize
}

pub fn estimate_messages_tokens(messages: &[Value]) -> usize {
    messages
        .iter()
        .map(|m| {
            let content = m.get("content").cloned().unwrap_or(Value::Null);
            estimate_tokens(&content) + 6
        })
        .sum()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn estimates_cjk_heavier() {
        assert!(estimate_text_tokens("你好世界") > estimate_text_tokens("hello"));
    }
}

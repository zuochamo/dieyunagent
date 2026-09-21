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

    /// 与 JS `src/agent/token-estimate.js` 共用同一基线（H4）。
    /// 改公式必须同时改两侧实现与本文件，否则两侧会分叉。
    const TOKEN_FIXTURE: &str = include_str!("../../../../test/fixtures/token-estimate-cases.json");

    fn fixture() -> Value {
        serde_json::from_str(TOKEN_FIXTURE).expect("token fixture 必须是合法 JSON")
    }

    #[test]
    fn estimates_cjk_heavier() {
        assert!(estimate_text_tokens("你好世界") > estimate_text_tokens("hello"));
    }

    #[test]
    fn text_cases_match_shared_fixture() {
        let f = fixture();
        let cases = f["textCases"].as_array().expect("textCases 必须是数组");
        assert!(!cases.is_empty(), "textCases 不能为空");
        for case in cases {
            let input = case["input"].as_str().expect("input 必须是字符串");
            let expected = case["expected"].as_u64().expect("expected 必须是数字") as usize;
            assert_eq!(
                estimate_text_tokens(input),
                expected,
                "estimate_text_tokens({:?}) 与 fixture 不一致",
                input
            );
        }
    }

    #[test]
    fn message_cases_match_shared_fixture() {
        let f = fixture();
        let cases = f["sharedMessageCases"]
            .as_array()
            .expect("sharedMessageCases 必须是数组");
        assert!(!cases.is_empty(), "sharedMessageCases 不能为空");
        for case in cases {
            let message = case["message"].clone();
            let expected = case["expected"].as_u64().expect("expected 必须是数字") as usize;
            assert_eq!(
                estimate_messages_tokens(std::slice::from_ref(&message)),
                expected,
                "estimate_messages_tokens({}) 与 fixture 不一致",
                message
            );
        }
    }

    #[test]
    fn counts_unicode_scalar_values_not_utf16_units() {
        // 星平面字符（emoji / 数学字母）按码点算 1，而非 UTF-16 码元的 2。
        assert_eq!(estimate_text_tokens("😀😀"), 1);
        assert_eq!(estimate_text_tokens("中😀"), 1);
        assert_eq!(estimate_text_tokens("𝕏"), 1);
    }
}

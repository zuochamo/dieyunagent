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

/// 图片 part 的等效 token 数（由 `assets/agent-shared.json` 的等效字符数换算）。
///
/// 图片在真实请求里由服务端**按像素**换算成「图片 token」，与 base64 长度无关：
/// 同一张图存成 1.5MB PNG 与压成 200KB JPEG，输入 token 几乎相同。若按 base64 长度计
/// （图片 part 既无 `text` 也无 `content`，会退化成整个 JSON 计费），一张图就被放大数百倍
/// —— 实测一张 PNG 让本函数估到 685406 token，越过压缩触发线，而图片既不可折叠也不可压缩，
/// 于是变成「每轮都压、却压不掉」的假压缩。
///
/// 系数唯一来源是 `assets/agent-shared.json`（Node 侧 `visionPartEqChars` ÷ `charsPerToken`），
/// Rust 侧由 [`crate::shared::image_part_equiv_tokens`] 换算 —— 两侧同源，不再手抄 1875。
fn image_part_equiv_tokens() -> usize {
    crate::shared::image_part_equiv_tokens()
}

/// 图片 part 形状（与 JS `guardrails-shared.isChatImagePart` 同一集合）：
/// OpenAI chat `image_url` / Responses `input_image` / Anthropic `image`(source)。
///
/// 非对象（字符串 / 数组 / null）在 `Value::get` 下统一取不到 `type`，天然为 false。
pub(super) fn is_image_part(part: &Value) -> bool {
    matches!(
        part.get("type").and_then(|t| t.as_str()),
        Some("image_url") | Some("input_image") | Some("image")
    )
}

pub fn estimate_tokens(content: &Value) -> usize {
    // 图片先判：它是「由服务端换算的图片 token」，与文本长度无关，绝不能落到下方 JSON 全量计费
    if is_image_part(content) {
        return image_part_equiv_tokens();
    }
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
    let s = &crate::shared::shared().token_estimate;
    ((cjk as f64 / s.cjk_chars_per_token) + (other as f64 / s.chars_per_token)).ceil() as usize
}

pub fn estimate_messages_tokens(messages: &[Value]) -> usize {
    messages
        .iter()
        // 借 `content` 而不是整份 clone：每条消息的内容可能很长，而这里只需要长度估算。
        //
        // `reasoning_content` 必须一起算：推理模型每轮都把思考随 assistant 消息**原样回传**
        // （见 `agent/loop_run.rs`，不回传会被上游 400），那份体积同样进 prompt。只数
        // `content` 会系统性低估 —— 真实 prompt 已越过折叠触发线，估值却还没到，于是「该折
        // 不折」直接撞上游 400 / 截断；而 `tokens_before - tokens_after` 还会虚报节省量。
        .map(|m| {
            let content = m.get("content").map_or(0, estimate_tokens);
            let reasoning = m.get("reasoning_content").map_or(0, estimate_tokens);
            content + reasoning + 6
        })
        .sum()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

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

    /// 图片按等效 token 计，与 base64 长度无关；三种 part 形状同价。
    /// 回归背景：按 base64 全量计费时，一张 PNG 就能把估值放大到几十万 token，
    /// 使压缩每轮被触发却压不掉（实测 685406 token / 75s 白等一次超时）。
    #[test]
    fn image_parts_cost_eq_tokens_regardless_of_base64_length() {
        let small = json!({
            "type": "image_url",
            "image_url": { "url": "data:image/png;base64,iVBORw0KGgo=" }
        });
        assert_eq!(estimate_tokens(&small), image_part_equiv_tokens());

        let big_b64 = "A".repeat(4096);
        let big = json!({
            "type": "image_url",
            "image_url": { "url": format!("data:image/png;base64,{big_b64}") }
        });
        assert_eq!(
            estimate_tokens(&big),
            image_part_equiv_tokens(),
            "base64 长度不得影响图片计费"
        );

        for kind in ["input_image", "image"] {
            let part = json!({ "type": kind, "source": { "type": "base64", "data": big_b64 } });
            assert_eq!(
                estimate_tokens(&part),
                image_part_equiv_tokens(),
                "{kind} 应与 image_url 同价"
            );
        }

        // 数组里的图片 part 同样按等效计（消息 content 的常见形状）
        let as_content = json!([{ "type": "text", "text": "看图" }, small]);
        assert_eq!(
            estimate_tokens(&as_content),
            estimate_text_tokens("看图") + image_part_equiv_tokens()
        );
    }

    #[test]
    fn counts_unicode_scalar_values_not_utf16_units() {
        // 星平面字符（emoji / 数学字母）按码点算 1，而非 UTF-16 码元的 2。
        assert_eq!(estimate_text_tokens("😀😀"), 1);
        assert_eq!(estimate_text_tokens("中😀"), 1);
        assert_eq!(estimate_text_tokens("𝕏"), 1);
    }

    /// 回归（A13）：`reasoning_content` 同样进 prompt，必须计入估值。
    ///
    /// 推理模型每轮把思考随 assistant 消息**原样回传**（不回传会被上游 400，见
    /// `agent/loop_run.rs`），那份体积真实占预算。旧实现只数 `content`：真实 prompt 已越过
    /// 折叠触发线、估值却还没到 —— 该折不折，最后撞上游 400 / 截断；同时
    /// `tokens_before - tokens_after` 也把省下的量算多了。
    #[test]
    fn reasoning_content_counts_toward_the_estimate() {
        let reasoning = "思".repeat(3000);
        let with_reasoning = estimate_messages_tokens(&[json!({
            "role": "assistant",
            "content": "hi",
            "reasoning_content": reasoning,
        })]);
        let without = estimate_messages_tokens(&[json!({"role": "assistant", "content": "hi"})]);
        assert!(
            with_reasoning > without + 1000,
            "思考体积必须计入估值：{with_reasoning} 应远大于 {without}"
        );
    }
}

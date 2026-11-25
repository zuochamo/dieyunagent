//! 出站投影：账本里的 messages → 发给上游的请求体。**唯一作者**。
//!
//! 为什么必须有这一个函数（R2）：以前出站形状有**两个作者** —— `loop_run/ledger.rs`
//! 拼 `{model, messages, tools}`，`agent/llm.rs` 再往里塞 `stream`；而「思考回传」
//! 与「平台补的正文」这两件事还各自散在 Node 的 `round.prepare` 里。任何新字段都要猜
//! 「该写哪一处」，`stream_options.include_usage` 就是这样漏掉的（2026-11-18 复核）。
//!
//! 现在：**账本只管事实**，这一层负责「事实长成什么形状发给上游」——
//! - 剥掉账本内部字段（`synthetic` / `reasoning`）；
//! - 按能力表与工具在场情况决定 `reasoning_content` 的去留（DeepSeek 思考模式的硬校验）；
//! - 落 `stream` / `stream_options.include_usage`；
//! - 空 `tools` 数组整键删掉（部分兼容网关见空数组就 400）。
//!
//! 依赖方向：只依赖 `serde_json`，不认识账本类型也不认识 HTTP —— 纯函数、好测。

use serde_json::{json, Value};

/// 账本内部字段：真思考（与上游 `reasoning_content` **分列**，绝不直接上行）。
const BOOK_REASONING_FIELD: &str = "reasoning";
/// 账本内部字段：这段正文是平台补的（上限提示），不是模型原话。
const SYNTHETIC_FIELD: &str = "synthetic";
/// 上游协议里的思考字段。
const UPSTREAM_REASONING_FIELD: &str = "reasoning_content";

/// 历史轮缺思考真值时的兜底占位串。**值在 `agent-shared.json`**（Node 侧
/// `reasoning-backfill.js` 读同一份），这里不再手抄字面量。
///
/// 只求「字段存在且非空」，**不承担可读语义**：上游会把历史 `reasoning_content` 当成
/// 「上一段思考的开头」接着写，一串人话占位会被原样回显成真思考（实测
/// `messages.reasoning` 里 114 条「占位 + 真思考」），再落库、再上行 → 自我维持链。
pub fn reasoning_placeholder() -> &'static str {
    &dieyun_base::shared::shared().reasoning.placeholder
}

/// 一次出站请求的形状参数（全部来自宿主：能力表与本次调用方式）。
#[derive(Debug, Clone, Copy)]
pub struct OutboundSpec {
    /// 这一轮要不要流式（传输语义，唯一作者也在这里）。
    pub stream: bool,
    /// 能力表声明：这个模型**脱了工具也要求**回传思考（`echoReasoning`）。
    pub echo_reasoning: bool,
    /// 本轮请求是否带 tools —— DeepSeek 思考模式的硬校验条件（带 tools 就必须回传）。
    pub has_tools: bool,
}

impl OutboundSpec {
    pub fn new(stream: bool, echo_reasoning: bool, has_tools: bool) -> Self {
        Self {
            stream,
            echo_reasoning,
            has_tools,
        }
    }
}

/// 账本 messages → 上游请求体。**这是唯一的投影入口**。
pub fn project_body(body: &mut Value, spec: OutboundSpec) {
    let Some(obj) = body.as_object_mut() else {
        return;
    };
    if let Some(Value::Array(messages)) = obj.get_mut("messages") {
        project_messages(messages, spec);
    }
    if matches!(obj.get("tools"), Some(Value::Array(tools)) if tools.is_empty()) {
        obj.remove("tools");
    }
    apply_transport(obj, spec.stream);
}

/// 只落传输字段（`llm.complete` 这类宿主自建 body 的路径用；主循环走 [`project_body`]）。
pub fn apply_transport(obj: &mut serde_json::Map<String, Value>, stream: bool) {
    obj.insert("stream".to_string(), Value::Bool(stream));
    if stream && obj.get("stream_options").is_none() {
        obj.insert(
            "stream_options".to_string(),
            json!({ "include_usage": true }),
        );
    }
}

/// 逐条投影：剥账本内部字段 + 归一化思考回传。
pub fn project_messages(messages: &mut [Value], spec: OutboundSpec) {
    for message in messages.iter_mut() {
        let Some(obj) = message.as_object_mut() else {
            continue;
        };
        obj.remove(SYNTHETIC_FIELD);
        if obj.get("role").and_then(|r| r.as_str()) != Some("assistant") {
            // 非 assistant 消息不该带思考字段；带上就是账本漏了，顺手清掉。
            obj.remove(BOOK_REASONING_FIELD);
            continue;
        }
        let book_reasoning = obj
            .get(BOOK_REASONING_FIELD)
            .and_then(|v| v.as_str())
            .map(|s| s.trim().to_string())
            .unwrap_or_default();
        let has_book_field = obj.remove(BOOK_REASONING_FIELD).is_some();
        let existing = obj
            .get(UPSTREAM_REASONING_FIELD)
            .and_then(|v| v.as_str())
            .map(|s| s.trim().to_string())
            .unwrap_or_default();
        let has_tool_calls = matches!(obj.get("tool_calls"), Some(Value::Array(c)) if !c.is_empty());
        let want = spec.has_tools || has_tool_calls || spec.echo_reasoning;
        if !existing.is_empty() {
            // 已有真值（同一 run 内账本回传的那份）：原样保留。
            continue;
        }
        if want {
            let value = if book_reasoning.is_empty() {
                reasoning_placeholder().to_string()
            } else {
                book_reasoning
            };
            obj.insert(UPSTREAM_REASONING_FIELD.to_string(), Value::String(value));
        } else if has_book_field {
            // 不需要回传时也**不编**占位：干净地不发这个字段。
            obj.remove(UPSTREAM_REASONING_FIELD);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn msg(role: &str, extra: Value) -> Value {
        let mut obj = json!({ "role": role, "content": "x" });
        if let (Some(target), Some(src)) = (obj.as_object_mut(), extra.as_object()) {
            for (k, v) in src {
                target.insert(k.clone(), v.clone());
            }
        }
        obj
    }

    /// 平台补的正文标记是**账本内部**的：不许出现在发给上游的请求里。
    #[test]
    fn synthetic_marker_never_reaches_upstream() {
        let mut body = json!({ "messages": [
            msg("assistant", json!({ "synthetic": true, "content": "已达轮次上限" }))
        ]});
        project_body(&mut body, OutboundSpec::new(false, false, false));
        assert!(body["messages"][0].get("synthetic").is_none());
    }

    /// 带 tools 时思考**必须**回传（DeepSeek 硬校验）：账本 `reasoning` 抬成
    /// `reasoning_content`，而 `reasoning` 本身要被剥掉。
    #[test]
    fn book_reasoning_is_promoted_and_stripped() {
        let mut body = json!({ "messages": [
            msg("assistant", json!({ "reasoning": " 先看文件 ", "content": "结论" }))
        ], "tools": [{ "type": "function" }] });
        project_body(&mut body, OutboundSpec::new(false, false, true));
        let m = &body["messages"][0];
        assert_eq!(m["reasoning_content"], json!("先看文件"));
        assert!(m.get("reasoning").is_none(), "账本字段不许上行");
    }

    /// 账本没有真思考时补占位（同一串，单一来源），且必须是「trim 后仍非空」的值。
    #[test]
    fn missing_reasoning_gets_the_placeholder() {
        let mut body = json!({ "messages": [
            msg("assistant", json!({ "tool_calls": [{ "id": "c1" }] }))
        ]});
        project_body(&mut body, OutboundSpec::new(false, false, true));
        let filled = body["messages"][0]["reasoning_content"]
            .as_str()
            .unwrap_or_default();
        assert!(!filled.trim().is_empty(), "占位被 trim 成空串 = 上游会重新 400");
        assert_eq!(json!(filled), json!(reasoning_placeholder()));
    }

    /// 不带 tools、能力表也没要求 → 不要凭空加 reasoning_content（也别保留账本字段）。
    #[test]
    fn no_tools_no_echo_keeps_the_message_clean() {
        let mut body = json!({ "messages": [
            msg("assistant", json!({ "reasoning": "想了点事" }))
        ]});
        project_body(&mut body, OutboundSpec::new(false, false, false));
        let m = &body["messages"][0];
        assert!(m.get("reasoning_content").is_none());
        assert!(m.get("reasoning").is_none());
    }

    /// `echoReasoning`（能力表声明）脱了工具也要回传。
    #[test]
    fn echo_reasoning_forces_the_field() {
        let mut body = json!({ "messages": [msg("assistant", json!({ "reasoning": "r" }))] });
        project_body(&mut body, OutboundSpec::new(false, true, false));
        assert_eq!(body["messages"][0]["reasoning_content"], json!("r"));
    }

    /// 空 tools 数组整键删掉（部分兼容网关见它就 400）。
    #[test]
    fn empty_tools_array_is_dropped() {
        let mut body = json!({ "messages": [], "tools": [] });
        project_body(&mut body, OutboundSpec::new(false, false, false));
        assert!(body.get("tools").is_none());
    }

    /// 流式必须申请 usage；非流式不申请；宿主显式关掉就尊重。
    #[test]
    fn transport_fields_ask_for_usage() {
        let mut body = json!({ "messages": [] });
        project_body(&mut body, OutboundSpec::new(true, false, false));
        assert_eq!(body["stream"], json!(true));
        assert_eq!(body["stream_options"]["include_usage"], json!(true));

        let mut plain = json!({ "messages": [] });
        project_body(&mut plain, OutboundSpec::new(false, false, false));
        assert!(plain.get("stream_options").is_none());

        let mut explicit = json!({ "messages": [], "stream_options": { "include_usage": false } });
        project_body(&mut explicit, OutboundSpec::new(true, false, false));
        assert_eq!(explicit["stream_options"]["include_usage"], json!(false));
    }

    /// 递归收集「前后两份 body 之间被改动的路径」（新增 / 删除 / 值变化都算）。
    fn changed_paths(before: &Value, after: &Value, path: String, out: &mut Vec<String>) {
        match (before, after) {
            (Value::Object(a), Value::Object(b)) => {
                for (k, v) in a {
                    let p = if path.is_empty() {
                        k.clone()
                    } else {
                        format!("{path}.{k}")
                    };
                    match b.get(k) {
                        Some(other) => changed_paths(v, other, p, out),
                        None => out.push(p),
                    }
                }
                for k in b.keys() {
                    if !a.contains_key(k) {
                        out.push(if path.is_empty() {
                            k.clone()
                        } else {
                            format!("{path}.{k}")
                        });
                    }
                }
            }
            (Value::Array(a), Value::Array(b)) => {
                for i in 0..a.len().min(b.len()) {
                    changed_paths(&a[i], &b[i], format!("{path}[{i}]"), out);
                }
                if a.len() != b.len() {
                    out.push(path);
                }
            }
            _ => {
                if before != after {
                    out.push(path);
                }
            }
        }
    }

    /// **投影只碰这几处** —— 请求快照记的是投影前的那一份（`docs/REQUEST-SNAPSHOT.md`），
    /// 两者之间的差异就是这张清单。
    ///
    /// 这条用例是那份文档的闸门：往 `project_body` 里加任何新的改写，这个集合就会变红，
    /// 逼着人回来把「快照与实发的差异」一并更新 —— 否则快照会开始**少说**模型看到的东西，
    /// 而看快照的人不会知道该怀疑哪里。
    #[test]
    fn projection_touches_only_the_documented_fields() {
        let mut body = json!({
            "model": "m",
            "messages": [
                { "role": "assistant", "content": "答", "synthetic": true, "reasoning": "想" },
                { "role": "user", "content": "问", "synthetic": true }
            ],
            "tools": []
        });
        let before = body.clone();
        // 带 tools 的流式请求：思考要回传（has_tools=true）、传输字段要落
        project_body(&mut body, OutboundSpec::new(true, false, true));

        let mut touched = Vec::new();
        changed_paths(&before, &body, String::new(), &mut touched);
        touched.sort();

        assert_eq!(
            touched,
            vec![
                // ① 账本内部字段被剥掉（平台补的正文标记 / 真思考）
                "messages[0].reasoning".to_string(),
                // ② 真思考抬成上游字段（缺了补占位串）
                "messages[0].reasoning_content".to_string(),
                "messages[0].synthetic".to_string(),
                "messages[1].synthetic".to_string(),
                // ③ 传输字段
                "stream".to_string(),
                "stream_options".to_string(),
                // ④ 空 tools 整键删（兼容网关会 400）
                "tools".to_string(),
            ]
        );
        // 「模型看到的内容」一个字段都不许动：正文与 tool_calls 原样。
        assert_eq!(body["messages"][0]["content"], json!("答"));
        assert_eq!(body["messages"][1]["content"], json!("问"));
    }
}

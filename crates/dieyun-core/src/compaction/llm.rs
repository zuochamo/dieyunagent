use std::time::Duration;

use serde_json::{json, Value};

use crate::config::LlmConfig;
use crate::error::CoreError;

/// 压缩请求超时。压缩是可选优化、且不重试，一次成败即定论。
/// 取满 75s 而非更小值：摘要请求 prefill 重（48K~120K 字符）且输出预算 4096 token，
/// 调小超时只会把「慢但会成功」的请求误判为失败（新引入失败），并不消除失败。
const LLM_HTTP_TIMEOUT_SECS: u64 = 75;

#[derive(Debug, Clone)]
pub struct LlmCompletionResult {
    pub content: String,
    pub usage: Option<Value>,
    pub model: String,
}

fn resolve_chat_url(base_url: &str) -> Result<String, CoreError> {
    let raw = base_url.trim().trim_end_matches('/');
    if raw.is_empty() {
        return Err(CoreError::rpc("LLM_CONFIG", "LLM baseUrl 未配置"));
    }
    let lower = raw.to_ascii_lowercase();
    if lower.ends_with("/chat/completions") {
        return Ok(raw.to_string());
    }
    Ok(format!("{raw}/chat/completions"))
}

/// 压缩摘要 LLM：单次调用，不重试。
/// 失败由上层就地跳过（`compaction_skipped = "llm_error"`）—— 压缩是可选优化，
/// 机械折叠 + 字符硬顶已能兜住上下文压力，重试只会把注定失败的大请求再打一遍。
pub async fn chat_completion(
    cfg: &LlmConfig,
    model: &str,
    system: &str,
    user: &str,
) -> Result<LlmCompletionResult, CoreError> {
    let url = resolve_chat_url(&cfg.base_url)?;
    let model_name = if model.trim().is_empty() {
        cfg.text_model.clone()
    } else {
        model.to_string()
    };
    if model_name.trim().is_empty() {
        return Err(CoreError::rpc("LLM_CONFIG", "压缩模型未配置（请指定当前会话模型）"));
    }

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(LLM_HTTP_TIMEOUT_SECS))
        .build()
        .map_err(|e| CoreError::rpc("LLM_HTTP", e.to_string()))?;

    let body = json!({
        "model": model_name,
        "messages": [
            { "role": "system", "content": system },
            { "role": "user", "content": user },
        ],
        "temperature": 0.15,
        "max_tokens": 4096,
        "stream": false,
    });

    let mut req = client.post(url).json(&body);
    // 请求头单一来源：Node 侧 llm-request.js 装配后经 LlmConfig.headers 传入。
    // 改造前这里自己拼 Content-Type + Authorization，导致「对话带自定义头、压缩不带」。
    req = crate::config::apply_llm_headers(req, &cfg.headers, &cfg.api_key, &cfg.auth_mode);

    let resp = req
        .send()
        .await
        .map_err(|e| CoreError::rpc(transport_error_code(&e), e.to_string()))?;
    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(CoreError::rpc(
            http_status_code(status.as_u16(), &text),
            format!(
                "HTTP {status}: {}",
                text.chars().take(400).collect::<String>()
            ),
        ));
    }
    let json: Value = resp
        .json()
        .await
        .map_err(|e| CoreError::rpc(transport_error_code(&e), e.to_string()))?;
    let content = extract_completion_text(&json);
    if content.trim().is_empty() {
        let code = empty_content_code(&json);
        let hint = if code == "LLM_REASONING_ONLY" {
            "压缩模型只输出了思考、正文为空（未写入摘要，已跳过压缩）"
        } else {
            "压缩模型返回空内容（未写入摘要，已跳过压缩）"
        };
        return Err(CoreError::rpc(code, hint));
    }
    let usage = json.get("usage").cloned();
    Ok(LlmCompletionResult {
        content,
        usage,
        model: model_name,
    })
}

/// 传输层失败分类（还没拿到 HTTP 状态码的阶段：连不上 / 超时 / 响应不是 JSON）。
///
/// 分类要回答的是「谁的锅」—— 网络与代理、模型、还是配置。日志与遥测的失败原因分布
/// 直接消费这些码，所以它们必须稳定，且唯一来源在此；Node 侧只做提取与翻译，不再二次判定。
fn transport_error_code(err: &reqwest::Error) -> &'static str {
    if err.is_timeout() {
        "LLM_TIMEOUT"
    } else if err.is_connect() {
        "LLM_CONNECT"
    } else if err.is_decode() {
        "LLM_BAD_JSON"
    } else {
        "LLM_HTTP"
    }
}

/// HTTP 非 2xx 的分类。
///
/// 5xx 要再看一眼响应体：中转代理会把「往上游写请求体超时」原样转述成 502 +
/// `TimeoutError('The write operation timed out')`。这类是**代理侧超时**（调代理的
/// 上游写超时即可解），与「上游服务真的挂了」不是一回事 —— 混在一个码里，
/// 排查时只能靠人肉读响应体，这正是本次分类要消除的。
fn http_status_code(status: u16, body: &str) -> &'static str {
    if status >= 500 {
        let lower = body.to_ascii_lowercase();
        if lower.contains("timed out") || lower.contains("timeout") {
            return "LLM_UPSTREAM_TIMEOUT";
        }
        return "LLM_UPSTREAM_5XX";
    }
    match status {
        401 | 403 => "LLM_AUTH",
        429 => "LLM_RATE_LIMIT",
        _ => "LLM_BAD_REQUEST",
    }
}

/// 正文为空时的细分：模型只输出了思考（走 reasoning 通道）还是压根没写。
/// 旧实现这两种在日志里长得完全一样（都报「返回空内容」），排查时无从区分。
fn empty_content_code(json: &Value) -> &'static str {
    let Some(msg) = json.pointer("/choices/0/message") else {
        return "LLM_EMPTY_CONTENT";
    };
    for key in ["reasoning_content", "reasoning"] {
        if let Some(text) = msg.get(key).and_then(|v| v.as_str()) {
            if !text.trim().is_empty() {
                return "LLM_REASONING_ONLY";
            }
        }
    }
    "LLM_EMPTY_CONTENT"
}

fn flatten_content(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(parts)) => parts
            .iter()
            .filter_map(|part| {
                if let Some(s) = part.as_str() {
                    return Some(s.to_string());
                }
                part.get("text")
                    .and_then(|t| t.as_str())
                    .map(|s| s.to_string())
            })
            .collect(),
        _ => String::new(),
    }
}

fn extract_completion_text(json: &Value) -> String {
    let Some(msg) = json.pointer("/choices/0/message") else {
        return String::new();
    };
    // 只认正文通道。思考文本（`reasoning_content` / `reasoning`）不是压缩摘要 ——
    // 旧实现在正文为空时把它们顶上来，于是「模型只思考、没输出」会被记成一份「摘要」写进
    // 上下文，而摘要的内容其实是模型的思考过程。宁可返回空让上层跳过压缩。
    flatten_content(msg.get("content"))
}

pub fn parse_compaction_json(raw: &str) -> Value {
    let mut text = raw.trim().to_string();
    if text.starts_with("```") {
        text = text
            .trim_start_matches("```json")
            .trim_start_matches("```JSON")
            .trim_start_matches("```")
            .trim()
            .trim_end_matches("```")
            .trim()
            .to_string();
    }
    serde_json::from_str(&text).unwrap_or_else(|_| {
        json!({
            "summary": text.chars().take(1000).collect::<String>(),
            "_raw": true
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extract_content_from_string_or_parts() {
        let as_string = json!({
            "choices": [{ "message": { "content": "hello" } }]
        });
        assert_eq!(extract_completion_text(&as_string), "hello");

        let as_parts = json!({
            "choices": [{ "message": { "content": [{ "type": "text", "text": "ab" }, { "type": "text", "text": "cd" }] } }]
        });
        assert_eq!(extract_completion_text(&as_parts), "abcd");

        // 思考通道不是摘要：正文为空即视为「压缩模型没给结论」，由调用方判空跳过压缩。
        let reasoning_only = json!({
            "choices": [{ "message": { "content": "", "reasoning_content": "only think" } }]
        });
        assert!(
            extract_completion_text(&reasoning_only).trim().is_empty(),
            "reasoning_content 不得被当作压缩摘要"
        );

        let empty = json!({ "choices": [{ "message": { "content": "" } }] });
        assert!(extract_completion_text(&empty).trim().is_empty());
    }

    #[test]
    fn classify_http_failures_by_owner() {
        // 代理把「往上游写超时」转述成 502，必须与普通 5xx 分开 —— 前者调代理可解
        assert_eq!(
            http_status_code(
                502,
                "('Connection aborted.', TimeoutError('The write operation timed out'))"
            ),
            "LLM_UPSTREAM_TIMEOUT"
        );
        assert_eq!(
            http_status_code(504, "Gateway Timeout"),
            "LLM_UPSTREAM_TIMEOUT"
        );
        assert_eq!(
            http_status_code(503, "upstream unavailable"),
            "LLM_UPSTREAM_5XX"
        );
        assert_eq!(http_status_code(401, "unauthorized"), "LLM_AUTH");
        assert_eq!(http_status_code(403, "forbidden"), "LLM_AUTH");
        assert_eq!(http_status_code(429, "rate limited"), "LLM_RATE_LIMIT");
        assert_eq!(http_status_code(400, "bad body"), "LLM_BAD_REQUEST");
    }

    #[test]
    fn classify_empty_content_vs_reasoning_only() {
        let reasoning_only = json!({
            "choices": [{ "message": { "content": "", "reasoning_content": "think" } }]
        });
        assert_eq!(empty_content_code(&reasoning_only), "LLM_REASONING_ONLY");

        let alt_key = json!({
            "choices": [{ "message": { "content": "  ", "reasoning": "think" } }]
        });
        assert_eq!(empty_content_code(&alt_key), "LLM_REASONING_ONLY");

        let truly_empty = json!({ "choices": [{ "message": { "content": "" } }] });
        assert_eq!(empty_content_code(&truly_empty), "LLM_EMPTY_CONTENT");

        // 连 choices 都没有（代理给了个 200 的空壳）也归到「真空内容」
        let no_choices = json!({ "object": "error" });
        assert_eq!(empty_content_code(&no_choices), "LLM_EMPTY_CONTENT");
    }
}

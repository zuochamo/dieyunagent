use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tokio::time::sleep;

use crate::config::LlmConfig;
use crate::error::CoreError;

/// 与 Node `llm-reconnect-retry.js` 对齐的退避基数；压缩场景另有更短上限（见 chat_completion）。
const LLM_RECONNECT_SHORT_ATTEMPTS: u32 = 3;
const LLM_RECONNECT_SHORT_BASE_MS: u64 = 800;
const LLM_RECONNECT_LONG_BASE_MS: u64 = 3000;
const LLM_RECONNECT_LONG_MAX_INTERVAL_MS: u64 = 60_000;
/// 压缩摘要：总重试窗口（勿用 15 分钟，否则停止按键会被卡死）
const COMPACTION_LLM_MAX_WAIT_MS: u64 = 180_000;
const COMPACTION_LLM_MAX_ATTEMPTS: u32 = 3;
const COMPACTION_LLM_MAX_RETRY_SLEEP_MS: u64 = 5_000;
/// 网关常在 ~60s 回 504；再等满 180s 只会拖住发送。
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

fn parse_http_status_from_message(message: &str) -> Option<u16> {
    let msg = message.trim();
    let rest = msg.strip_prefix("HTTP ")?;
    let status_str = rest.split_whitespace().next()?;
    status_str.parse().ok()
}

fn is_gateway_timeout_llm_message(message: &str) -> bool {
    if let Some(status) = parse_http_status_from_message(message) {
        if matches!(status, 502..=504) {
            return true;
        }
    }
    let msg = message.to_ascii_lowercase();
    msg.contains("http 502")
        || msg.contains("http 503")
        || msg.contains("http 504")
        || msg.contains("gateway timeout")
        || msg.contains("provider request timeout")
}

fn is_transient_llm_message(message: &str) -> bool {
    let msg = message.to_ascii_lowercase();
    if let Some(status) = parse_http_status_from_message(message) {
        if matches!(status, 429 | 502 | 503 | 504) {
            return true;
        }
    }
    msg.contains("network error")
        || msg.contains("failed to fetch")
        || msg.contains("network request failed")
        || msg.contains("socket hang up")
        || msg.contains("econnreset")
        || msg.contains("connection reset")
        || msg.contains("connection aborted")
        || msg.contains("connection_error")
        || msg.contains("etimedout")
        || msg.contains("timedout")
        || msg.contains("enotfound")
        || msg.contains("getaddrinfo")
        || msg.contains("operation timed out")
        || msg.contains("error sending request")
        || msg.contains("error trying to connect")
        || msg.contains("http 429")
        || msg.contains("http 502")
        || msg.contains("http 503")
        || msg.contains("http 504")
}

fn is_transient_llm_error(err: &CoreError) -> bool {
    match err {
        CoreError::Rpc { code, message } => {
            if *code == "LLM_RECONNECT_EXHAUSTED" {
                return false;
            }
            if *code == "LLM_CONFIG" {
                return false;
            }
            is_transient_llm_message(message)
        }
        CoreError::Other(_) => true,
    }
}

fn reconnect_wait_ms(attempt: u32) -> u64 {
    if attempt <= LLM_RECONNECT_SHORT_ATTEMPTS {
        LLM_RECONNECT_SHORT_BASE_MS * attempt as u64
    } else {
        let exp = (attempt.saturating_sub(LLM_RECONNECT_SHORT_ATTEMPTS + 1)).min(4);
        let ms = LLM_RECONNECT_LONG_BASE_MS.saturating_mul(1u64 << exp);
        ms.min(LLM_RECONNECT_LONG_MAX_INTERVAL_MS)
    }
}

async fn chat_completion_once(
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

    let mut req = client
        .post(url)
        .header("Content-Type", "application/json")
        .json(&body);
    if !cfg.api_key.trim().is_empty() {
        req = req.header("Authorization", format!("Bearer {}", cfg.api_key.trim()));
    }

    let resp = req
        .send()
        .await
        .map_err(|e| CoreError::rpc("LLM_HTTP", e.to_string()))?;
    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(CoreError::rpc(
            "LLM_HTTP",
            format!(
                "HTTP {status}: {}",
                text.chars().take(400).collect::<String>()
            ),
        ));
    }
    let json: Value = resp
        .json()
        .await
        .map_err(|e| CoreError::rpc("LLM_HTTP", e.to_string()))?;
    let content = extract_completion_text(&json);
    if content.trim().is_empty() {
        return Err(CoreError::rpc(
            "LLM_HTTP",
            "压缩模型返回空内容（未写入摘要，已跳过压缩）",
        ));
    }
    let usage = json.get("usage").cloned();
    Ok(LlmCompletionResult {
        content,
        usage,
        model: model_name,
    })
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
    let content = flatten_content(msg.get("content"));
    if !content.trim().is_empty() {
        return content;
    }
    let reasoning = flatten_content(msg.get("reasoning_content"));
    if !reasoning.trim().is_empty() {
        return reasoning;
    }
    flatten_content(msg.get("reasoning"))
}

/// 压缩摘要 LLM：瞬时错误短重试；失败由上层跳过压缩，避免拖死停止。
pub async fn chat_completion(
    cfg: &LlmConfig,
    model: &str,
    system: &str,
    user: &str,
) -> Result<LlmCompletionResult, CoreError> {
    let started = Instant::now();
    let mut attempt: u32 = 0;
    let mut last_err: Option<CoreError> = None;

    while attempt < COMPACTION_LLM_MAX_ATTEMPTS
        && (started.elapsed().as_millis() as u64) < COMPACTION_LLM_MAX_WAIT_MS
    {
        attempt += 1;
        match chat_completion_once(cfg, model, system, user).await {
            Ok(result) => return Ok(result),
            Err(err) => {
                if !is_transient_llm_error(&err) {
                    return Err(err);
                }
                // 502/503/504：同一大包摘要几乎必再超时，重试只会挡住本轮。
                if is_gateway_timeout_llm_message(&err.to_string()) {
                    return Err(err);
                }
                last_err = Some(err);
                let elapsed = started.elapsed().as_millis() as u64;
                let wait_ms = reconnect_wait_ms(attempt).min(COMPACTION_LLM_MAX_RETRY_SLEEP_MS);
                if attempt >= COMPACTION_LLM_MAX_ATTEMPTS
                    || elapsed.saturating_add(wait_ms) >= COMPACTION_LLM_MAX_WAIT_MS
                {
                    break;
                }
                if let Some(ref e) = last_err {
                    eprintln!(
                        "[compaction-llm] transient error, retry in {wait_ms}ms (attempt {attempt}): {e}"
                    );
                }
                sleep(Duration::from_millis(wait_ms)).await;
            }
        }
    }

    if let Some(err) = last_err {
        Err(err)
    } else {
        Err(CoreError::rpc(
            "LLM_RECONNECT_EXHAUSTED",
            "compaction LLM 重连超时",
        ))
    }
}

#[allow(dead_code)]
pub async fn chat_completion_content(
    cfg: &LlmConfig,
    model: &str,
    system: &str,
    user: &str,
) -> Result<String, CoreError> {
    Ok(chat_completion(cfg, model, system, user).await?.content)
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
    fn parse_http_status() {
        assert_eq!(
            parse_http_status_from_message("HTTP 504 Gateway Timeout: {\"error\":{}}"),
            Some(504)
        );
        assert_eq!(parse_http_status_from_message("HTTP 401"), Some(401));
    }

    #[test]
    fn transient_errors() {
        assert!(is_transient_llm_message(
            "HTTP 504 Gateway Timeout: Provider request timeout"
        ));
        assert!(is_gateway_timeout_llm_message(
            "HTTP 504 Gateway Timeout: {\"error\":{}}"
        ));
        assert!(is_gateway_timeout_llm_message("HTTP 502 Bad Gateway"));
        assert!(!is_gateway_timeout_llm_message("HTTP 429 Too Many Requests"));
        assert!(is_transient_llm_message("operation timed out"));
        assert!(!is_transient_llm_message("HTTP 401 Unauthorized"));
        assert!(!is_transient_llm_message("压缩模型未配置"));
    }

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

        let reasoning = json!({
            "choices": [{ "message": { "content": "", "reasoning_content": "only think" } }]
        });
        assert_eq!(extract_completion_text(&reasoning), "only think");

        let empty = json!({ "choices": [{ "message": { "content": "" } }] });
        assert!(extract_completion_text(&empty).trim().is_empty());
    }

    #[test]
    fn reconnect_wait_schedule() {
        assert_eq!(reconnect_wait_ms(1), 800);
        assert_eq!(reconnect_wait_ms(2), 1600);
        assert_eq!(reconnect_wait_ms(3), 2400);
        assert_eq!(reconnect_wait_ms(4), 3000);
        assert_eq!(reconnect_wait_ms(5), 6000);
        assert_eq!(reconnect_wait_ms(8), 48_000);
        assert_eq!(
            reconnect_wait_ms(8).min(COMPACTION_LLM_MAX_RETRY_SLEEP_MS),
            COMPACTION_LLM_MAX_RETRY_SLEEP_MS
        );
    }
}

//! LLM 客户端：**请求发出去、流式增量拿回来**的唯一实现。
//!
//! 历史：请求体在 Rust（`agent.loop.need_llm` 拼 `llm_body`）、HTTP 与 SSE 解析在 Node
//! （`llm-stream-utils.js`）、请求头又在 Node（`llm-request.js`）——一次对话要跨进程来回
//! 三次才能发出一个请求，而「这轮到底发了什么」永远要靠日志拼。这里把它收成一处：
//! Node 只交 **url + 请求头 + body**（端点约定与鉴权口径仍在 `llm-request.js`，别在这里
//! 重新推导），Rust 负责发、收、解析、把增量推给宿主。
//!
//! 刻意不做的事：
//! - 不做重试/退避。上游抖动属于外部系统，重试层只会把「一次失败」变成「多次失败 + 更长的
//!   等待」；调用方（run 的 watchdog）已经有超时与取消语义。
//! - 不猜供应商方言。`reasoning_content` / `content` 通道语义由入口盖章（见 `ContentChannel`），
//!   这里只按字段搬运。

use std::time::Duration;

use serde_json::{json, Value};

use crate::config::{apply_llm_headers, LlmConfig};
use crate::error::CoreError;

/// 抓包原文的字节上限（只影响调试抓包，不影响解析）。
const RAW_CAP_BYTES: usize = 4 * 1024 * 1024;

/// 单次请求的墙钟上限。流式默认更宽：一旦开始出字，慢慢吐是正常的。
pub const STREAM_TIMEOUT_SECS: u64 = 600;
pub const NON_STREAM_TIMEOUT_SECS: u64 = 300;

/// 一条流式增量（已经归一到两个通道）。
#[derive(Debug, Clone, Default)]
pub struct Delta {
    pub content: Option<String>,
    pub reasoning: Option<String>,
}

/// 一次调用的完整结果。
#[derive(Debug, Clone, Default)]
pub struct Outcome {
    pub content: String,
    pub reasoning: Option<String>,
    pub tool_calls: Vec<ToolCall>,
    pub finish_reason: Option<String>,
    pub usage: Option<Value>,
    pub model: Option<String>,
    /// 抓包原文（includeRaw 时才填）：DIEYUN_LLM_RAW_LOG 的调试通路靠它。
    pub raw: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    /// 原始 JSON 字符串（模型可能分片吐出，这里已经把分片拼回去）
    pub arguments: String,
}

/// SSE / 响应体的累加器（纯函数式，好测）。
///
/// 只认 OpenAI 兼容的两件事：`choices[0].delta`（流式）与 `choices[0].message`（非流式），
/// 以及顶层 `usage` / `model`。工具调用按 `index` 累积分片。
#[derive(Debug, Default)]
pub struct Accumulator {
    content: String,
    reasoning: String,
    /// index → (id, name, args 片段)
    tool_calls: Vec<(String, String, String)>,
    finish_reason: Option<String>,
    usage: Option<Value>,
    model: Option<String>,
    /// 是否收到过 `[DONE]`
    done: bool,
    /// 上游把错误当正常流回吐（HTTP 200 + `data: {"error":…}`）时的原文：
    /// 不识别它，这一轮就会以「空回复」收场，上游只会写成「执行完成、无文本摘要」。
    upstream_error: Option<String>,
}

impl Accumulator {
    pub fn new() -> Self {
        Self::default()
    }

    /// 喂一行 SSE 数据（已去掉 `data: ` 前缀）或一整段 JSON。返回本次带来的增量。
    pub fn feed_sse_data(&mut self, payload: &str) -> Option<Delta> {
        let payload = payload.trim();
        if payload.is_empty() {
            return None;
        }
        if payload == "[DONE]" {
            self.done = true;
            return None;
        }
        let Ok(value) = serde_json::from_str::<Value>(payload) else {
            // 供应商偶尔插入注释行 / 心跳：不理解就跳过，不是错误
            return None;
        };
        if let Some(err) = value.get("error") {
            self.upstream_error = Some(error_message(err));
        }
        self.take_meta(&value);
        if let Some(choices) = value.get("choices").and_then(|c| c.as_array()) {
            for choice in choices {
                self.take_finish(choice);
                if let Some(delta) = choice.get("delta") {
                    return self.take_texts(delta);
                }
                if let Some(message) = choice.get("message") {
                    self.take_message(message);
                    return None;
                }
            }
        }
        None
    }

    /// 非流式：整包响应体。
    pub fn feed_body(&mut self, body: &str) -> Result<(), CoreError> {
        let value: Value = serde_json::from_str(body)
            .map_err(|e| CoreError::rpc("LLM_PARSE", format!("响应不是 JSON：{e}")))?;
        if let Some(err) = value.get("error") {
            return Err(CoreError::rpc("LLM_API", error_message(err)));
        }
        self.take_meta(&value);
        let choices = value
            .get("choices")
            .and_then(|c| c.as_array())
            .ok_or_else(|| CoreError::rpc("LLM_PARSE", "响应缺少 choices".to_string()))?;
        for choice in choices {
            self.take_finish(choice);
            if let Some(message) = choice.get("message") {
                self.take_message(message);
            }
        }
        self.done = true;
        Ok(())
    }

    fn take_meta(&mut self, value: &Value) {
        if let Some(model) = value.get("model").and_then(|m| m.as_str()) {
            self.model = Some(model.to_string());
        }
        if let Some(usage) = value.get("usage") {
            if usage.is_object() && !usage.as_object().map(|o| o.is_empty()).unwrap_or(true) {
                self.usage = Some(usage.clone());
            }
        }
    }

    fn take_finish(&mut self, choice: &Value) {
        if let Some(reason) = choice.get("finish_reason").and_then(|r| r.as_str()) {
            if !reason.trim().is_empty() {
                self.finish_reason = Some(reason.to_string());
            }
        }
    }

    /// 取 `delta` / `message` 里的两个文本通道与工具调用分片。
    fn take_texts(&mut self, holder: &Value) -> Option<Delta> {
        let content = text_of(holder.get("content"));
        let reasoning = text_of(holder.get("reasoning_content"))
            .or_else(|| text_of(holder.get("reasoning")))
            .or_else(|| text_of(holder.get("reasoning_content_delta")));
        if let Some(c) = &content {
            self.content.push_str(c);
        }
        if let Some(r) = &reasoning {
            self.reasoning.push_str(r);
        }
        self.take_tool_call_deltas(holder);
        if content.is_none() && reasoning.is_none() {
            return None;
        }
        Some(Delta { content, reasoning })
    }

    fn take_message(&mut self, message: &Value) {
        if let Some(c) = text_of(message.get("content")) {
            self.content.push_str(&c);
        }
        if let Some(r) = text_of(message.get("reasoning_content")).or_else(|| text_of(message.get("reasoning"))) {
            if self.reasoning.is_empty() {
                self.reasoning = r;
            }
        }
        self.take_tool_call_deltas(message);
    }

    fn take_tool_call_deltas(&mut self, holder: &Value) {
        let Some(calls) = holder.get("tool_calls").and_then(|c| c.as_array()) else {
            return;
        };
        for (position, call) in calls.iter().enumerate() {
            let index = call
                .get("index")
                .and_then(|i| i.as_u64())
                .map(|i| i as usize)
                .unwrap_or(position);
            while self.tool_calls.len() <= index {
                self.tool_calls.push((String::new(), String::new(), String::new()));
            }
            let slot = &mut self.tool_calls[index];
            if let Some(id) = call.get("id").and_then(|v| v.as_str()) {
                if !id.trim().is_empty() {
                    slot.0 = id.to_string();
                }
            }
            if let Some(function) = call.get("function") {
                if let Some(name) = function.get("name").and_then(|v| v.as_str()) {
                    if !name.trim().is_empty() {
                        slot.1.push_str(name);
                    }
                }
                match function.get("arguments") {
                    Some(Value::String(s)) => slot.2.push_str(s),
                    Some(other) if !other.is_null() => slot.2.push_str(&other.to_string()),
                    _ => {}
                }
            }
        }
    }

    pub fn finish(self) -> Outcome {
        let content = self.content;
        let reasoning = if self.reasoning.trim().is_empty() {
            None
        } else {
            Some(self.reasoning)
        };
        let tool_calls = self
            .tool_calls
            .into_iter()
            .enumerate()
            .filter(|(_, (_, name, _))| !name.trim().is_empty())
            .map(|(i, (id, name, arguments))| ToolCall {
                id: if id.trim().is_empty() {
                    format!("call-{i}")
                } else {
                    id
                },
                name,
                arguments: if arguments.trim().is_empty() {
                    "{}".to_string()
                } else {
                    arguments
                },
            })
            .collect();
        Outcome {
            content,
            reasoning,
            tool_calls,
            finish_reason: self.finish_reason,
            usage: self.usage,
            model: self.model,
            raw: None,
        }
    }

    /// 上游在流里回了错误包时的原文（`feed_sse_data` 期间累积）。
    pub fn upstream_error(&self) -> Option<&str> {
        self.upstream_error.as_deref()
    }
}

fn error_message(err: &Value) -> String {
    if let Some(msg) = err.get("message").and_then(|m| m.as_str()) {
        return msg.to_string();
    }
    if let Some(text) = err.as_str() {
        return text.to_string();
    }
    err.to_string()
}

fn text_of(value: Option<&Value>) -> Option<String> {
    match value {
        Some(Value::String(s)) if !s.is_empty() => Some(s.clone()),
        Some(Value::Array(parts)) => {
            let joined: String = parts
                .iter()
                .filter_map(|p| match p {
                    Value::String(s) => Some(s.clone()),
                    Value::Object(o) => o
                        .get("text")
                        .and_then(|t| t.as_str())
                        .map(str::to_string),
                    _ => None,
                })
                .collect::<Vec<_>>()
                .join("");
            if joined.is_empty() {
                None
            } else {
                Some(joined)
            }
        }
        _ => None,
    }
}

/// 发一次 chat completion。
///
/// `on_delta` 在**每一条**增量上被调用（用来给 UI 推流）；`stream = false` 时不调用。
pub async fn chat_completion(
    cfg: &LlmConfig,
    url: &str,
    headers: &std::collections::HashMap<String, String>,
    body: Value,
    stream: bool,
    include_raw: bool,
    on_delta: impl Fn(&Delta),
) -> Result<Outcome, CoreError> {
    let url = url.trim();
    if url.is_empty() {
        return Err(CoreError::rpc("LLM_CONFIG", "LLM 端点为空"));
    }
    let timeout = if stream {
        STREAM_TIMEOUT_SECS
    } else {
        NON_STREAM_TIMEOUT_SECS
    };
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(timeout))
        .build()
        .map_err(|e| CoreError::rpc("LLM_HTTP", e.to_string()))?;
    // `stream` 是**传输**语义：宿主/账本只表达「这一轮要不要增量」，请求体里的 `stream`
    // 字段以这里为准 —— 唯一 HTTP 实现说了算，别处再写一次就会分叉（2026-11-17 的坑：
    // `loop_run.next_body` 曾硬写 `stream: false`，端点于是回整包，中转在非流式口径下
    // 直接丢掉 tool_calls，用户看到「模型什么都没说」）。
    let mut body = body;
    if let Some(obj) = body.as_object_mut() {
        obj.insert("stream".to_string(), Value::Bool(stream));
    }
    let request = apply_llm_headers(client.post(url), headers, &cfg.api_key, &cfg.auth_mode)
        .json(&body);
    let response = request
        .send()
        .await
        .map_err(|e| CoreError::rpc("LLM_HTTP", e.to_string()))?;
    let status = response.status();
    let mut acc = Accumulator::new();

    if !stream {
        let text = response
            .text()
            .await
            .map_err(|e| CoreError::rpc("LLM_HTTP", e.to_string()))?;
        if !status.is_success() {
            return Err(CoreError::rpc(
                "LLM_API",
                format!("HTTP {status}: {}", tail(&text, 240)),
            ));
        }
        acc.feed_body(&text)?;
        let mut outcome = acc.finish();
        if include_raw {
            outcome.raw = Some(text);
        }
        return Ok(outcome);
    }

    if !status.is_success() {
        let text = response.text().await.unwrap_or_default();
        return Err(CoreError::rpc(
            "LLM_API",
            format!("HTTP {status}: {}", tail(&text, 240)),
        ));
    }

    let mut response = response;
    let mut buffer = String::new();
    let mut raw = String::new();
    // 整包兜底：端点**忽略 `stream: true`**（或压根不看这个字段）时会回一份完整 JSON
    // （`content-type: application/json`，不是 SSE）。此时下面的循环一条 `data:` 都找不到，
    // 若就这么收场，本轮会以「空回复」结束，而且 content / reasoning / tool_calls 三样一起丢
    // ——2026-11-17 真事：中转回整包 `message.tool_calls`，客户端表现成「模型什么都没说」。
    // 所以这里留一份原文，一行 SSE 都没见过就按非流式解析（与非流式分支同一条路径）。
    let mut whole = String::new();
    let mut saw_sse = false;
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|e| CoreError::rpc("LLM_HTTP", e.to_string()))?
    {
        let text = String::from_utf8_lossy(&chunk).to_string();
        if include_raw && raw.len() < RAW_CAP_BYTES {
            raw.push_str(&text);
        }
        if whole.len() < RAW_CAP_BYTES {
            whole.push_str(&text);
        }
        buffer.push_str(&text);
        // 逐行消费；半行留在 buffer 里等下一块
        while let Some(idx) = buffer.find('\n') {
            let line: String = buffer.drain(..=idx).collect();
            let line = line.trim_end_matches(['\r', '\n']);
            let Some(data) = line.strip_prefix("data:") else {
                // `event:` / 心跳 / 空行：不是数据行
                continue;
            };
            saw_sse = true;
            if let Some(delta) = acc.feed_sse_data(data) {
                on_delta(&delta);
            }
        }
        if acc.done {
            break;
        }
    }
    if !buffer.trim().is_empty() {
        if let Some(data) = buffer.trim_start().strip_prefix("data:") {
            saw_sse = true;
            if let Some(delta) = acc.feed_sse_data(data) {
                on_delta(&delta);
            }
        }
    }
    // 一条 SSE 数据行都没有 → 上游回的是整包（或错误页）。按非流式解析：正常就能拿到
    // content / reasoning / tool_calls；不是 JSON 就报 LLM_PARSE，而不是静默当空回复。
    if !saw_sse && !whole.trim().is_empty() {
        acc.feed_body(&whole)?;
        if include_raw {
            raw = whole.clone();
        }
    }
    // 上游把错误当正常流回吐：必须变成失败，否则这轮以「空回复」收场。
    if let Some(upstream) = acc.upstream_error() {
        let message = format!("LLM 上游错误：{upstream}");
        if include_raw {
            return Err(CoreError::rpc(
                "LLM_API",
                format!("{message}\n--- raw ---\n{raw}"),
            ));
        }
        return Err(CoreError::rpc("LLM_API", message));
    }
    let mut outcome = acc.finish();
    if include_raw {
        outcome.raw = Some(raw);
    }
    Ok(outcome)
}

fn tail(text: &str, max: usize) -> String {
    let chars: Vec<char> = text.chars().collect();
    if chars.len() <= max {
        return text.to_string();
    }
    chars[chars.len() - max..].iter().collect()
}

/// 供 `agent.run.*` 与 `llm.complete` 返回给宿主的结构化结果（`agent.llm.chat` 已删除）。
pub fn outcome_to_json(outcome: &Outcome) -> Value {
    json!({
        "content": outcome.content,
        "reasoning": outcome.reasoning,
        "finishReason": outcome.finish_reason,
        "toolCalls": outcome.tool_calls.iter().map(|c| json!({
            "id": c.id,
            "name": c.name,
            "arguments": c.arguments,
        })).collect::<Vec<_>>(),
        "usage": outcome.usage,
        "model": outcome.model,
        // 只有宿主显式要（`includeRaw`）时才有值：抓包通路靠它，默认不占带宽
        "raw": outcome.raw,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn feed_all(acc: &mut Accumulator, chunks: &[&str]) -> Vec<Delta> {
        let mut out = Vec::new();
        for chunk in chunks {
            if let Some(d) = acc.feed_sse_data(chunk) {
                out.push(d);
            }
        }
        out
    }

    /// 正文分片按顺序拼回去，且每片都作为增量交出去（UI 靠它边收边显示）。
    #[test]
    fn streams_content_incrementally() {
        let mut acc = Accumulator::new();
        let deltas = feed_all(
            &mut acc,
            &[
                r#"{"choices":[{"delta":{"content":"你好"}}]}"#,
                r#"{"choices":[{"delta":{"content":"，世界"}}]}"#,
                r#"{"choices":[{"delta":{},"finish_reason":"stop"}]}"#,
                "[DONE]",
            ],
        );
        assert_eq!(deltas.len(), 2);
        assert_eq!(deltas[0].content.as_deref(), Some("你好"));
        let outcome = acc.finish();
        assert_eq!(outcome.content, "你好，世界");
        assert_eq!(outcome.finish_reason.as_deref(), Some("stop"));
    }

    /// 思考通道与正文通道分开累积，绝不互相污染（思考永不顶正文）。
    #[test]
    fn keeps_reasoning_channel_separate() {
        let mut acc = Accumulator::new();
        feed_all(
            &mut acc,
            &[
                r#"{"choices":[{"delta":{"reasoning_content":"先看文件"}}]}"#,
                r#"{"choices":[{"delta":{"content":"结论"}}]}"#,
            ],
        );
        let outcome = acc.finish();
        assert_eq!(outcome.content, "结论");
        assert_eq!(outcome.reasoning.as_deref(), Some("先看文件"));
    }

    /// 工具调用参数是**分片**吐的：必须按 index 拼回完整 JSON，否则模型收到的参数是半个。
    #[test]
    fn reassembles_streamed_tool_call_arguments() {
        let mut acc = Accumulator::new();
        feed_all(
            &mut acc,
            &[
                r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_a","function":{"name":"fs_read_file","arguments":"{\"file"}}]}}]}"#,
                r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"Path\":\"a.txt\"}"}}]}}]}"#,
                r#"{"choices":[{"delta":{},"finish_reason":"tool_calls"}]}"#,
            ],
        );
        let outcome = acc.finish();
        assert_eq!(outcome.tool_calls.len(), 1);
        assert_eq!(outcome.tool_calls[0].id, "call_a");
        assert_eq!(outcome.tool_calls[0].name, "fs_read_file");
        let parsed: Value = serde_json::from_str(&outcome.tool_calls[0].arguments).expect("合法 JSON");
        assert_eq!(parsed["filePath"], "a.txt");
        assert_eq!(outcome.finish_reason.as_deref(), Some("tool_calls"));
    }

    #[test]
    fn accumulates_usage_and_model() {
        let mut acc = Accumulator::new();
        feed_all(
            &mut acc,
            &[
                r#"{"model":"glm-4","choices":[{"delta":{"content":"x"}}]}"#,
                r#"{"usage":{"prompt_tokens":1234,"completion_tokens":56},"choices":[]}"#,
                "[DONE]",
            ],
        );
        let outcome = acc.finish();
        assert_eq!(outcome.model.as_deref(), Some("glm-4"));
        assert_eq!(outcome.usage.unwrap()["prompt_tokens"], 1234);
    }

    /// 非流式整包也要能解析（端点忽略 stream=true 时走这条路）。
    #[test]
    fn parses_whole_response_body() {
        let mut acc = Accumulator::new();
        acc.feed_body(
            r#"{"model":"m","choices":[{"message":{"content":"整包","tool_calls":[{"id":"c1","function":{"name":"t","arguments":"{}"}}]},"finish_reason":"stop"}],"usage":{"prompt_tokens":9}}"#,
        )
        .expect("parse");
        let outcome = acc.finish();
        assert_eq!(outcome.content, "整包");
        assert_eq!(outcome.tool_calls[0].name, "t");
        assert_eq!(outcome.usage.unwrap()["prompt_tokens"], 9);
    }

    /// 上游 error 包必须报成 `LLM_API`，不能当成「空回复」继续跑。
    #[test]
    fn upstream_error_payload_is_an_error() {
        let mut acc = Accumulator::new();
        let err = acc
            .feed_body(r#"{"error":{"message":"model not allowed"}}"#)
            .expect_err("应当报错");
        match err {
            CoreError::Rpc { code, message } => {
                assert_eq!(code, "LLM_API");
                assert!(message.contains("model not allowed"));
            }
            other => panic!("错误类型不对：{other:?}"),
        }
    }

    /// 上游把错误当正常流回吐（HTTP 200 + `data: {"error":…}`）时必须变成失败。
    ///
    /// 不识别它，这轮就会以「空回复」收场，上层写成「执行完成、无文本摘要」——
    /// 一次完全没执行的任务被记成成功。
    #[test]
    fn upstream_error_inside_stream_is_recorded() {
        let mut acc = Accumulator::new();
        acc.feed_sse_data(r#"{"error":{"message":"model not allowed"}}"#);
        assert_eq!(acc.upstream_error(), Some("model not allowed"));
    }

    /// 无 id / 无 name 的碎片不该造出假工具调用。
    #[test]
    fn ignores_tool_call_fragments_without_name() {
        let mut acc = Accumulator::new();
        feed_all(&mut acc, &[r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{}}]}}]}"#]);
        assert!(acc.finish().tool_calls.is_empty());
    }

    #[test]
    fn unknown_lines_are_skipped_not_fatal() {
        let mut acc = Accumulator::new();
        assert!(acc.feed_sse_data(": keep-alive").is_none());
        assert!(acc.feed_sse_data("not json").is_none());
        assert!(acc.feed_sse_data("").is_none());
    }

    /// 端到端：真的发一次 HTTP、真的按块读 SSE、真的套上请求头。
    ///
    /// 手写一个最小 HTTP/1.1 服务端（只回一次），因为这条路径的三个失败模式
    /// （请求头没套上 / 分块没拼好 / 半行被丢掉）都只有真连一次才暴露。
    #[tokio::test]
    async fn streams_from_a_real_http_endpoint() {
        use std::collections::HashMap;
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let addr = listener.local_addr().expect("addr");
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.expect("accept");
            let mut buf = vec![0u8; 4096];
            let mut request = String::new();
            loop {
                let n = socket.read(&mut buf).await.expect("read");
                if n == 0 {
                    break;
                }
                request.push_str(&String::from_utf8_lossy(&buf[..n]));
                if request.contains("\r\n\r\n") {
                    break;
                }
            }
            // 刻意把两条事件分两次写：验证客户端能处理「块边界落在半行中间」
            let first = "data: {\"choices\":[{\"delta\":{\"content\":\"你好\"}}]}\n\ndata: {\"choi";
            let second = "ces\":[{\"delta\":{\"content\":\"，世界\"}}]}\n\ndata: [DONE]\n\n";
            let head = format!(
                "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\nconnection: close\r\ntransfer-encoding: chunked\r\n\r\n{:x}\r\n{}\r\n{:x}\r\n{}\r\n0\r\n\r\n",
                first.len(),
                first,
                second.len(),
                second
            );
            socket.write_all(head.as_bytes()).await.expect("write");
            socket.flush().await.ok();
            request
        });

        let mut headers = HashMap::new();
        headers.insert("x-custom".to_string(), "abc".to_string());
        let cfg = LlmConfig {
            api_key: "sk-test".to_string(),
            auth_mode: "bearer".to_string(),
            ..Default::default()
        };
        let url = format!("http://{addr}/v1/chat/completions");
        let deltas = std::sync::Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
        let sink = std::sync::Arc::clone(&deltas);
        let outcome = chat_completion(
            &cfg,
            &url,
            &headers,
            json!({"model": "fake", "stream": true}),
            true,
            true,
            move |delta| {
                if let Some(text) = &delta.content {
                    sink.lock().unwrap().push(text.clone());
                }
            },
        )
        .await
        .expect("chat");

        assert_eq!(outcome.content, "你好，世界");
        assert_eq!(*deltas.lock().unwrap(), vec!["你好", "，世界"]);

        let request = server.await.expect("server join");
        let lower = request.to_ascii_lowercase();
        assert!(lower.contains("x-custom: abc"), "自定义头要透传：{request}");
        assert!(
            lower.contains("authorization: bearer sk-test"),
            "缺省鉴权要按 auth_mode 拼：{request}"
        );
        assert!(request.contains("\"stream\":true"), "请求体要原样发出去：{request}");
    }

    /// 端点忽略 `stream: true`、直接回整包 JSON 时，必须按非流式解析。
    ///
    /// 2026-11-17 真事：两家中转（DY / XHX）对「模型想调工具」的请求都回整包
    /// `message.tool_calls`（`content-type: application/json`），而客户端被告知 stream=true；
    /// 老的 SSE 循环只认 `data:` 行，于是 content / reasoning / tool_calls 全部丢掉，
    /// 用户看到的是「（模型未生成文字答复。）」。这条用例钉住兜底路径。
    #[tokio::test]
    async fn whole_json_body_while_streaming_is_parsed() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let addr = listener.local_addr().expect("addr");
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.expect("accept");
            let mut buf = vec![0u8; 4096];
            let mut request = String::new();
            loop {
                let n = socket.read(&mut buf).await.expect("read");
                if n == 0 {
                    break;
                }
                request.push_str(&String::from_utf8_lossy(&buf[..n]));
                if request.contains("\r\n\r\n") {
                    break;
                }
            }
            let body = json!({
                "model": "m",
                "choices": [{
                    "index": 0,
                    "finish_reason": "tool_calls",
                    "message": {
                        "role": "assistant",
                        "content": "",
                        "reasoning_content": "先看朝向再拍",
                        "tool_calls": [{
                            "id": "call_0",
                            "type": "function",
                            "function": { "name": "desktop_camera_look", "arguments": "{\"x\":1}" }
                        }]
                    }
                }],
                "usage": { "prompt_tokens": 12, "completion_tokens": 34 }
            })
            .to_string();
            let head = format!(
                "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\nconnection: close\r\ncontent-length: {}\r\n\r\n{}",
                body.len(),
                body
            );
            socket.write_all(head.as_bytes()).await.expect("write");
            socket.flush().await.ok();
            request
        });

        let cfg = LlmConfig::default();
        let url = format!("http://{addr}/v1/chat/completions");
        let outcome = chat_completion(
            &cfg,
            &url,
            &std::collections::HashMap::new(),
            // 故意带一个 `stream: false`：传输层要按自己的口径覆盖它（这正是 2026-11-17 的坑 ——
            // `next_body` 硬写 false，端点回整包，中转在非流式口径下丢 tool_calls）
            json!({ "model": "m", "messages": [], "stream": false }),
            true,
            true,
            |_delta| {},
        )
        .await
        .expect("整包响应不该报错");

        assert_eq!(outcome.content, "");
        assert_eq!(outcome.reasoning.as_deref(), Some("先看朝向再拍"));
        assert_eq!(outcome.tool_calls.len(), 1, "整包里的 tool_calls 必须解析出来");
        assert_eq!(outcome.tool_calls[0].name, "desktop_camera_look");
        assert_eq!(outcome.tool_calls[0].arguments, "{\"x\":1}");
        assert_eq!(outcome.finish_reason.as_deref(), Some("tool_calls"));
        assert!(outcome.raw.is_some(), "includeRaw 打开时要回传原文");
        let request = server.await.expect("server join");
        assert!(
            request.contains("\"stream\":true"),
            "传输层要覆盖请求体里的 stream:false（否则端点回整包、中转丢 tool_calls）：{request}"
        );
    }
}

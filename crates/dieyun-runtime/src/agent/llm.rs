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
//!   等待」；调用方（run 的 watchdog）已经有超时与取消语义。要重连的那一层在宿主
//!   （`src/llm-reconnect-retry.js`），它唯一需要的东西是**结构信号**，见下一条。
//! - 不把传输失败说成一句 `error sending request for url (...)`。reqwest 的 `Display` 只描述
//!   「请求没发成功」，真正的原因（`connection refused` / `connection closed before message
//!   completed`）在 `source` 链里；宿主按文案分类就一定会漏（2026-11-18 现场：网关重启掐断
//!   在途请求，宿主不认识那句文案，于是「可重连的瞬断」直接变成「本轮失败」）。
//!   所以传输层失败一律给码 `LLM_TRANSPORT`（值在 `agent-shared.json`，两端同一份）
//!   + 全链文案。业务性失败仍走 `LLM_API` / `LLM_CONFIG`，两者不混。
//! - 不猜供应商方言。`reasoning_content` / `content` 通道语义由入口盖章（见 `ContentChannel`），
//!   这里只按字段搬运。

use std::sync::OnceLock;
use std::time::Duration;

use serde_json::{json, Value};

use dieyun_base::config::{apply_llm_headers, LlmConfig};
use dieyun_base::error::CoreError;

/// 抓包原文的字节上限（只影响调试抓包，不影响解析）。
const RAW_CAP_BYTES: usize = 4 * 1024 * 1024;

/// 单次请求的墙钟上限。流式默认更宽：一旦开始出字，慢慢吐是正常的。
pub const STREAM_TIMEOUT_SECS: u64 = 600;
pub const NON_STREAM_TIMEOUT_SECS: u64 = 300;

/// 进程级 HTTP 客户端：连接池 / keep-alive / HTTP/2 多路复用都挂在 `Client` 内部。
///
/// 构建失败只可能是 TLS 后端不可用这类环境问题，所以结果也缓存 —— 没必要每轮重试一次
/// 构建（真正要重试的是请求，那在宿主）。超时按请求设置（`RequestBuilder::timeout`），
/// 两个预算仍是上面那两个常量。
fn http_client() -> Result<&'static reqwest::Client, CoreError> {
    static CLIENT: OnceLock<Result<reqwest::Client, String>> = OnceLock::new();
    let built = CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .build()
            .map_err(|e| format!("LLM 客户端构建失败：{e}"))
    });
    match built {
        Ok(client) => Ok(client),
        Err(message) => Err(CoreError::rpc("LLM_CONFIG", message.clone())),
    }
}

/// 传输层失败的协议码（唯一来源 `src/agent/agent-shared.json` 的 `llmErrors.transportCode`）。
///
/// 宿主 `llm-reconnect-retry.isTransientLlmError` 认这个码做「可重连的瞬断」判定；
/// 值两端口径必须一致，所以不在这里写死字面量。
fn transport_code() -> &'static str {
    dieyun_base::shared::shared()
        .llm_errors
        .transport_code
        .as_str()
}

/// 失败发生的**位置**（人读 / 日志用；分类只认码）。
fn transport_kind(err: &reqwest::Error) -> &'static str {
    if err.is_timeout() {
        "timeout"
    } else if err.is_connect() {
        "connect"
    } else if err.is_body() || err.is_decode() {
        "body"
    } else if err.is_request() {
        "request"
    } else {
        "other"
    }
}

/// reqwest 错误的**全链**文案：顶层 + 所有 `source()`，同一条不重复。
///
/// `e.to_string()` 只有 `error sending request for url (...)`，看不出到底是被拒绝、
/// 被掐断还是超时 —— 排查时缺的就是后面这几节。
fn describe_transport(err: &reqwest::Error) -> String {
    let mut parts: Vec<String> = vec![err.to_string()];
    let mut cur: Option<&(dyn std::error::Error + 'static)> = std::error::Error::source(err);
    while let Some(source) = cur {
        let text = source.to_string();
        if !text.is_empty() && !parts.iter().any(|p| *p == text) {
            parts.push(text);
        }
        cur = source.source();
    }
    parts.join(" ← ")
}

/// 传输层失败 → `LLM_TRANSPORT`（宿主知道这是「可以重连的那一类」）。
fn transport_error(err: &reqwest::Error) -> CoreError {
    CoreError::rpc(
        transport_code(),
        format!("模型接口传输失败（{}）：{}", transport_kind(err), describe_transport(err)),
    )
}

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

/// 一次响应里允许的工具调用个数上限。
///
/// 槽位按上游给的 `index` 定位，所以一个离谱的 `index`（兼容网关曾在实测里给过
/// 六位数）就能让「按 index 扩容」变成「分配十万个空槽」。超限的帧不再扩容，
/// 而是按上游协议错误报出去 —— 静默丢掉调用则会让模型以为工具没被请求过。
const MAX_TOOL_CALLS: usize = 64;

/// 一个工具调用的累积槽位（`index` → 槽位）。
#[derive(Debug, Default)]
struct ToolCallSlot {
    id: String,
    name: String,
    args: String,
}

/// SSE / 响应体的累加器（纯函数式，好测）。
///
/// 只认 OpenAI 兼容的几件事：`choices[].delta`（流式）与 `choices[].message`（非流式），
/// 以及顶层 `usage` / `model`。工具调用按 `index` 累积分片。
#[derive(Debug, Default)]
pub struct Accumulator {
    content: String,
    reasoning: String,
    tool_calls: Vec<ToolCallSlot>,
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
            // 所有 choice 都累积。历史上这里在第一个带 `delta` 的 choice 上直接 `return`，
            // 于是 `n > 1` 或中转合并 choice 时，`choices[1..]` 的正文与工具调用**静默消失**
            // （用户看到半截回答，而且没有任何信号说少了一半）。
            let mut merged: Option<Delta> = None;
            for choice in choices {
                self.take_finish(choice);
                let taken = if let Some(delta) = choice.get("delta") {
                    self.take_texts(delta)
                } else if let Some(message) = choice.get("message") {
                    self.take_message(message);
                    None
                } else {
                    None
                };
                if let Some(delta) = taken {
                    let slot = merged.get_or_insert_with(Delta::default);
                    if let Some(content) = delta.content {
                        slot.content = Some(slot.content.take().unwrap_or_default() + &content);
                    }
                    if let Some(reasoning) = delta.reasoning {
                        slot.reasoning = Some(slot.reasoning.take().unwrap_or_default() + &reasoning);
                    }
                }
            }
            return merged;
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
        for call in calls {
            let id = call
                .get("id")
                .and_then(|v| v.as_str())
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty());
            let index = match call.get("index").and_then(|i| i.as_u64()) {
                Some(raw) => {
                    if raw as usize >= MAX_TOOL_CALLS {
                        self.upstream_error.get_or_insert_with(|| {
                            format!("上游 tool_calls 的 index={raw} 超过 {MAX_TOOL_CALLS}，拒绝按它扩容")
                        });
                        continue;
                    }
                    raw as usize
                }
                // 没有 `index` 的三种形状，按「同一调用」优先关联，绝不按数组下标硬凑：
                //  · 同一 `id` 再来一次（兼容网关整包重发）→ 落回原槽；
                //  · 有 `id` 但没见过（非流式整包里的第二条）→ 新槽；
                //  · 既无 `index` 也无 `id`（参数续片）→ 续到最后一个槽。
                // 旧实现用「本块数组下标」兜底，第二条 call 会被写进第一条里（串槽）。
                None => match id.as_deref() {
                    Some(id) => match self.tool_calls.iter().position(|s| s.id == id) {
                        Some(pos) => pos,
                        // id 可能比首个分片晚到：上一条还没有 id 的槽就是它（同一调用）。
                        None => match self.tool_calls.last() {
                            Some(last) if last.id.is_empty() => self.tool_calls.len() - 1,
                            _ => self.tool_calls.len(),
                        },
                    },
                    None if self.tool_calls.is_empty() => 0,
                    None => self.tool_calls.len() - 1,
                },
            };
            if index >= self.tool_calls.len() {
                self.tool_calls.resize_with(index + 1, ToolCallSlot::default);
            }
            let slot = &mut self.tool_calls[index];
            if let Some(id) = id {
                if slot.id.is_empty() {
                    slot.id = id;
                }
            }
            if let Some(function) = call.get("function") {
                if let Some(name) = function.get("name").and_then(|v| v.as_str()) {
                    let name = name.trim();
                    // 只在空槽时赋值：每个 delta 重发全名（兼容网关会）不许拼成
                    // `fs_read_filefs_read_file`。名字是**标识**，不是增量。
                    if !name.is_empty() && slot.name.is_empty() {
                        slot.name = name.to_string();
                    }
                }
                match function.get("arguments") {
                    Some(Value::String(s)) => slot.args.push_str(s),
                    Some(other) if !other.is_null() => slot.args.push_str(&other.to_string()),
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
            .filter(|(_, slot)| !slot.name.trim().is_empty())
            .map(|(i, slot)| ToolCall {
                id: if slot.id.trim().is_empty() {
                    format!("call-{i}")
                } else {
                    slot.id
                },
                name: slot.name,
                arguments: if slot.args.trim().is_empty() {
                    "{}".to_string()
                } else {
                    slot.args
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

/// 把「这一轮要不要流式」落到请求体上：`stream` 与 `stream_options.include_usage`
/// **只在这里写**（唯一 HTTP 实现）。
///
/// 为什么必须申请 `include_usage`：OpenAI 兼容端点默认**不**在流式回包里带 `usage`，
/// 而内核有三处消费面全挂在这份数据上 —— `agent.usage` 事件（成本统计）、
/// 「上游吞了 tool_calls」的诊断、折叠的 `usage` 触发口径（拿不到就永远退回字符比估算）。
/// 缺了它不会报错，只会让这三处**永远静默跳过**。
fn apply_transport_fields(body: &mut Value, stream: bool) {
    let Some(obj) = body.as_object_mut() else {
        return;
    };
    obj.insert("stream".to_string(), Value::Bool(stream));
    if stream && obj.get("stream_options").is_none() {
        obj.insert(
            "stream_options".to_string(),
            json!({ "include_usage": true }),
        );
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
    // 进程级客户端 + **按请求**超时：连接池 / keep-alive / HTTP/2 多路复用都挂在 `Client`
    // 内部，逐次新建等于每一轮都重做一次 DNS + TCP + TLS 握手（`chat_completion` 一轮一次，
    // 工具轮越多付得越多），上一轮的连接也永远复用不到。
    let client = http_client()?;
    // `stream` 是**传输**语义：宿主/账本只表达「这一轮要不要增量」，请求体里的 `stream`
    // 字段以这里为准 —— 唯一 HTTP 实现说了算，别处再写一次就会分叉（2026-11-17 的坑：
    // `loop_run.next_body` 曾硬写 `stream: false`，端点于是回整包，中转在非流式口径下
    // 直接丢掉 tool_calls，用户看到「模型什么都没说」）。
    let mut body = body;
    apply_transport_fields(&mut body, stream);
    let request = apply_llm_headers(client.post(url), headers, &cfg.api_key, &cfg.auth_mode)
        .timeout(Duration::from_secs(timeout))
        .json(&body);
    let response = request.send().await.map_err(|e| transport_error(&e))?;
    let status = response.status();
    let mut acc = Accumulator::new();

    if !stream {
        let text = response
            .text()
            .await
            .map_err(|e| transport_error(&e))?;
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
    // 缓冲按**字节**累积、切出完整行之后再解码：TCP / HTTP 分片边界不保证落在 UTF-8
    // 字符边界上（中文与 emoji 是 3–4 字节），先 `from_utf8_lossy` 会把被截断那一半
    // 永久替换成 U+FFFD —— 而且这个坏字符会经 `acc.content` 落进账本、下一轮原样回传给
    // 模型，属于不可恢复的丢字。
    let mut buffer: Vec<u8> = Vec::new();
    let mut raw: Vec<u8> = Vec::new();
    // 整包兜底：端点**忽略 `stream: true`**（或压根不看这个字段）时会回一份完整 JSON
    // （`content-type: application/json`，不是 SSE）。此时下面的循环一条 `data:` 都找不到，
    // 若就这么收场，本轮会以「空回复」结束，而且 content / reasoning / tool_calls 三样一起丢
    // ——2026-11-17 真事：中转回整包 `message.tool_calls`，客户端表现成「模型什么都没说」。
    // 所以这里留一份原文，一行 SSE 都没见过就按非流式解析（与非流式分支同一条路径）。
    let mut whole: Vec<u8> = Vec::new();
    let mut saw_sse = false;
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|e| transport_error(&e))?
    {
        if include_raw && raw.len() < RAW_CAP_BYTES {
            raw.extend_from_slice(&chunk);
        }
        if whole.len() < RAW_CAP_BYTES {
            whole.extend_from_slice(&chunk);
        }
        buffer.extend_from_slice(&chunk);
        // 逐行消费；半行（含不完整的 UTF-8 尾字节）留在 buffer 里等下一块
        while let Some(idx) = buffer.iter().position(|b| *b == b'\n') {
            let line: Vec<u8> = buffer.drain(..=idx).collect();
            // 到 `\n` 为止是完整的一行：此时才解码，跨分片的多字节字符不会再被切开。
            // 真出现非法字节（上游本身乱码）只影响这一行，不污染后续。
            let line = String::from_utf8_lossy(&line);
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
    if !buffer.is_empty() {
        let rest = String::from_utf8_lossy(&buffer);
        let rest = rest.trim();
        if let Some(data) = rest.strip_prefix("data:") {
            saw_sse = true;
            if let Some(delta) = acc.feed_sse_data(data) {
                on_delta(&delta);
            }
        }
    }
    // 一条 SSE 数据行都没有 → 上游回的是整包（或错误页）。按非流式解析：正常就能拿到
    // content / reasoning / tool_calls；不是 JSON 就报 LLM_PARSE，而不是静默当空回复。
    let whole_text = String::from_utf8_lossy(&whole).to_string();
    if !saw_sse && !whole_text.trim().is_empty() {
        acc.feed_body(&whole_text)?;
        if include_raw {
            raw = whole;
        }
    }
    // 上游把错误当正常流回吐：必须变成失败，否则这轮以「空回复」收场。
    if let Some(upstream) = acc.upstream_error() {
        let message = format!("LLM 上游错误：{upstream}");
        if include_raw {
            // 抓包原文只为看：整段一次性解码（解析路径才是逐行解码的）
            let raw_text = String::from_utf8_lossy(&raw);
            return Err(CoreError::rpc(
                "LLM_API",
                format!("{message}\n--- raw ---\n{raw_text}"),
            ));
        }
        return Err(CoreError::rpc("LLM_API", message));
    }
    let mut outcome = acc.finish();
    if include_raw {
        outcome.raw = Some(String::from_utf8_lossy(&raw).to_string());
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
#[path = "llm_tests.rs"]
mod tests;

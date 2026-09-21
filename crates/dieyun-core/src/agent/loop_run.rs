use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::config::AppConfig;
use crate::error::CoreError;
use crate::index::IndexService;
/// Host should pass `maxToolCalls` from `agent-limits` `ctxAgentToolCallLimit` (or the model setting).
const DEFAULT_MAX_TOOL_CALLS: u32 = 150;
const DEFAULT_MAX_ROUNDS: u32 = 96;
const MIN_RECORDED_PLAN_CHARS: usize = 80;
const MIN_DUP_CHARS: usize = 12;

fn is_passthrough_thought(text: &str) -> bool {
    let t = text.trim();
    t.is_empty()
        || t == "…"
        || t.starts_with("请求中")
        || t.starts_with("思考中")
        || t.starts_with("生成中")
        || t.starts_with("处理中")
        || t.starts_with("启动")
        || t.starts_with("等待")
        || t.starts_with("连接中断")
        || t.starts_with("请求 LLM")
        || t.starts_with("多模态识图")
        || t.starts_with("执行工具")
}

fn collapse_ws(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn split_paras(text: &str) -> Vec<String> {
    text.split("\n\n")
        .map(|p| p.trim().to_string())
        .filter(|p| !p.is_empty())
        .collect()
}

fn parse_status_value(raw: &str) -> Option<&'static str> {
    match raw.trim().to_ascii_lowercase().as_str() {
        "continue" => Some("continue"),
        "final" => Some("final"),
        "blocked" => Some("blocked"),
        "ask_user" => Some("ask_user"),
        _ => None,
    }
}

/// 本段结束、交给下游的正文 —— **四条终态路径（正常收尾 / 轮次上限 / 工具次数上限）
/// 只有这一处口径**：
/// - 思考通道（`ContentChannel::Reasoning`，单通道模型的 `content` 键）**永不**作为正文；
/// - 其余情况正文为空即 `None`：下游（`applyTurnEndSynthesis`、子 Agent 摘要）据此
///   判定「空回复」，而不是拿到一段空字符串的假正文。
///
/// 旧实现会在正文为空时把「像正文的」reasoning 顶上来（`chars().count() >= 24` 且不含
/// `<tool_call`）。那条兜底让「模型到底有没有给结论」在 UI 上失真 —— 思考被复述成回答，
/// 且阈值纯属拍脑袋的启发式。通道身份改由入口盖章（`ContentChannel`）后即可删掉。
/// 「被轮次/预算截断」这一事实由 `hit_round_limit` 与 `TraceRound.content_source` 表达，
/// 交付形态交给 Node 侧的四态收口（见 docs/REASONING-ISOLATION-PLAN.md §3.4）。
fn delivered_content(content: Option<&str>, channel: ContentChannel) -> Option<String> {
    if channel == ContentChannel::Reasoning {
        return None;
    }
    let text = content.unwrap_or("");
    if text.trim().is_empty() {
        None
    } else {
        Some(text.to_string())
    }
}

fn strip_agent_status(raw: &str) -> String {
    let s = raw.trim_start();
    let lower = s.to_ascii_lowercase();
    if let Some(rest) = lower.strip_prefix("<agent_status>") {
        if let Some(end) = rest.find("</agent_status>") {
            let after_tag = end + "</agent_status>".len();
            let prefix_len = "<agent_status>".len();
            let byte_end = prefix_len + after_tag;
            if byte_end <= s.len() {
                return s[byte_end..].trim_start().to_string();
            }
        }
    }

    let (first, rest) = match s.split_once('\n') {
        Some((a, b)) => (a, Some(b)),
        None => (s, None),
    };
    let line = first.trim().trim_start_matches('[').trim_end_matches(']').trim();
    let lower_line = line.to_ascii_lowercase();
    if let Some(after) = lower_line.strip_prefix("agent_status") {
        let after = after.trim_start_matches(|c: char| c == ':' || c == '=' || c.is_whitespace());
        if parse_status_value(after).is_some() {
            return rest.unwrap_or("").trim_start().to_string();
        }
        if rest.is_none() {
            return String::new();
        }
    }
    s.trim().to_string()
}

fn strip_repeated_preamble(current: &str, previous: &str) -> String {
    let cur = strip_agent_status(current);
    let cur = cur.trim().to_string();
    let prev = strip_agent_status(previous);
    let prev = prev.trim().to_string();
    if cur.is_empty() {
        return String::new();
    }
    if prev.is_empty() {
        return cur;
    }
    if cur == prev {
        return String::new();
    }

    let cur_n = collapse_ws(&cur);
    let prev_n = collapse_ws(&prev);
    if cur_n == prev_n {
        return String::new();
    }
    if prev_n.starts_with(&cur_n) && cur_n.chars().count() >= MIN_DUP_CHARS {
        return String::new();
    }
    if cur.starts_with(&prev) {
        return cur[prev.len()..].trim().to_string();
    }
    if cur_n.starts_with(&prev_n) && prev_n.chars().count() >= MIN_DUP_CHARS {
        let paras = split_paras(&cur);
        let prev_paras = split_paras(&prev);
        let mut i = 0;
        while i < paras.len() && i < prev_paras.len() && collapse_ws(&paras[i]) == collapse_ws(&prev_paras[i])
        {
            i += 1;
        }
        if i > 0 {
            return paras[i..].join("\n\n");
        }
    }

    let paras = split_paras(&cur);
    let mut i = 0;
    while i < paras.len() {
        let p_n = collapse_ws(&paras[i]);
        if p_n.chars().count() < MIN_DUP_CHARS {
            if prev_n.contains(&p_n) {
                i += 1;
                continue;
            }
            break;
        }
        if prev_n.contains(&p_n) {
            i += 1;
            continue;
        }
        break;
    }
    if i == 0 {
        return cur;
    }
    paras[i..].join("\n\n")
}

fn sanitize_thought(raw: &str, previous: &[String]) -> String {
    if is_passthrough_thought(raw) {
        return raw.trim().to_string();
    }
    let mut out = strip_agent_status(raw);
    for prev in previous {
        if prev.trim().is_empty() || is_passthrough_thought(prev) {
            continue;
        }
        out = strip_repeated_preamble(&out, prev);
        if out.is_empty() {
            break;
        }
    }
    out
}

fn parse_tool_arguments(raw: &Value) -> Value {
    if let Some(s) = raw.as_str() {
        if let Ok(v) = serde_json::from_str(s) {
            return v;
        }
        return json!({ "raw": s });
    }
    raw.clone()
}

/// After the first LLM round, drop inline image_url parts so later rounds do not resend huge base64 blobs.
fn strip_inline_images_from_messages(messages: &mut [Value]) {
    for msg in messages.iter_mut() {
        let role = msg.get("role").and_then(|v| v.as_str()).unwrap_or("");
        if role != "user" {
            continue;
        }
        let Some(Value::Array(parts)) = msg.get("content") else {
            continue;
        };
        let image_count = parts
            .iter()
            .filter(|p| p.get("type").and_then(|t| t.as_str()) == Some("image_url"))
            .count();
        if image_count == 0 {
            continue;
        }
        let mut texts: Vec<String> = parts
            .iter()
            .filter(|p| p.get("type").and_then(|t| t.as_str()) == Some("text"))
            .filter_map(|p| p.get("text").and_then(|t| t.as_str()).map(str::to_string))
            .collect();
        texts.push(format!(
            "（本轮已附 {image_count} 张图片；若需重新确认细节，可用 fs_read_file 设 encoding=base64 重读 [附件图 …] 标注的路径）"
        ));
        if let Some(obj) = msg.as_object_mut() {
            obj.insert("content".into(), json!(texts.join("\n")));
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartParams {
    pub model: String,
    #[serde(default)]
    pub messages: Vec<Value>,
    #[serde(default)]
    pub tools: Vec<Value>,
    #[serde(default)]
    pub workspace_root: Option<String>,
    #[serde(default)]
    pub max_tool_calls: Option<u32>,
    #[serde(default)]
    pub max_rounds: Option<u32>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolCallInput {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub arguments: Value,
}

/// 入口盖章（Node `llm-channel.getChannelPolicy`）：本轮 `content` 键属于哪个通道。
///
/// 单通道模型（能力表按精确模型 id 声明 `singleChannel`）把思考塞在 `content` 键里，
/// 盖章后 Rust 账本不必再用「文本长度 / 是否含 markup」这类启发式猜。
/// 未声明的模型一律 `Answer`；未知取值降级为 `Absent`，不阻断请求。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum ContentChannel {
    Answer,
    Reasoning,
    #[default]
    #[serde(other)]
    Absent,
}

/// 账本事实：本轮**可交付正文**的来源（`TraceRound.content_source`）。
///
/// 与 `ContentChannel` 刻意分开：入口只可能盖出前三种，`Synthetic` 是**平台补的**
/// 文本（段上限提示），只有账本会记录它。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ContentSource {
    Answer,
    Reasoning,
    Absent,
    Synthetic,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct LlmResponseInput {
    #[serde(default)]
    pub content: Option<String>,
    #[serde(default)]
    pub reasoning: Option<String>,
    #[serde(default)]
    pub tool_calls: Vec<ToolCallInput>,
    #[serde(default)]
    pub finish_reason: Option<String>,
    #[serde(default)]
    pub content_channel: ContentChannel,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolResultInput {
    pub id: String,
    pub result: Value,
    #[serde(default)]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TraceRound {
    pub round: u32,
    pub thought: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub full_thought: Option<String>,
    /// 本轮正文来自哪个通道 —— 账本事实。展示层据此决定「要不要进回答区」，
    /// 不再用 `reasoning || content` 之类启发式回推。
    pub content_source: ContentSource,
    /// 本轮面向用户的正文（`Answer` 才非空；`Synthetic` 记平台提示文本）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub visible_content: Option<String>,
    pub tools: Vec<TraceTool>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TraceTool {
    pub name: String,
    pub args: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoopResponse {
    pub phase: String,
    pub run_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub llm_body: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub delegates: Option<Vec<DelegateTool>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub trace: Option<Vec<TraceRound>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hit_round_limit: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub messages: Option<Vec<Value>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DelegateTool {
    pub id: String,
    pub name: String,
    pub arguments: Value,
}

struct RunState {
    model: String,
    messages: Vec<Value>,
    tools: Vec<Value>,
    #[allow(dead_code)]
    workspace_root: Option<String>,
    max_tool_calls: u32,
    max_rounds: u32,
    round: u32,
    tool_calls_used: u32,
    trace: Vec<TraceRound>,
    cancelled: bool,
    pending_delegate: Vec<(String, String, Value)>,
    recorded_plan: Option<String>,
}

pub struct AgentLoopManager {
    runs: Arc<Mutex<HashMap<String, RunState>>>,
    next_id: AtomicU64,
}

impl Default for AgentLoopManager {
    fn default() -> Self {
        Self {
            runs: Arc::new(Mutex::new(HashMap::new())),
            next_id: AtomicU64::new(1),
        }
    }
}

fn is_length_stop(reason: &Option<String>) -> bool {
    matches!(
        reason
            .as_deref()
            .map(|s| s.trim().to_ascii_lowercase())
            .as_deref(),
        Some("length") | Some("max_tokens")
    )
}

const TRUNCATED_TOOL_ERROR: &str =
    "未执行：模型输出触及 token 上限，参数可能不完整。请用完整参数重新调用。";

/// When a segment hits the tool-call cap, persist text-only assistant output.
/// Never append `tool_calls` without matching `tool` results — that breaks long-horizon continuation.
///
/// `synthetic: true` 标明这段正文是**平台补的**（上限提示），不是模型原话。账本据此把
/// 该轮记成 `ContentSource::Synthetic`。字段只活在账本里：发给上游前会经出站白名单
/// `sanitizeMessagesForChatApi` 过滤，未知字段不会漏到 OpenAI 兼容接口。
/// 返回写入的文本，供调用方记账。
fn push_assistant_text_only(
    messages: &mut Vec<Value>,
    content: Option<&String>,
    fallback: &str,
) -> String {
    let text = content
        .filter(|c| !c.trim().is_empty())
        .map(|c| c.as_str())
        .unwrap_or(fallback)
        .to_string();
    messages.push(json!({
        "role": "assistant",
        "content": text,
        "synthetic": true
    }));
    text
}

/// 思考原文的来源**唯一**：`reasoning` 键；单通道模型（入口盖章 `content` 即思考）
/// 则取 `content` 键。绝不拿「正文」兜底思考 —— 旧实现正是靠那条兜底让思考区复述回答。
fn llm_thought_raw(llm: &LlmResponseInput) -> Option<String> {
    let pick = |slot: &Option<String>| -> Option<String> {
        slot.as_ref().filter(|v| !v.trim().is_empty()).cloned()
    };
    match llm.content_channel {
        ContentChannel::Reasoning => pick(&llm.content).or_else(|| pick(&llm.reasoning)),
        _ => pick(&llm.reasoning),
    }
}

impl AgentLoopManager {
    pub fn start(&self, params: StartParams) -> Result<LoopResponse, CoreError> {
        if params.model.trim().is_empty() {
            return Err(CoreError::rpc("INVALID_PARAMS", "model 必填"));
        }
        if params.messages.is_empty() {
            return Err(CoreError::rpc("INVALID_PARAMS", "messages 不能为空"));
        }
        let run_id = format!("run-{}", self.next_id.fetch_add(1, Ordering::Relaxed));
        let state = RunState {
            model: params.model,
            messages: params.messages,
            tools: params.tools,
            workspace_root: params.workspace_root,
            max_tool_calls: params.max_tool_calls.unwrap_or(DEFAULT_MAX_TOOL_CALLS),
            max_rounds: params.max_rounds.unwrap_or(DEFAULT_MAX_ROUNDS),
            round: 0,
            tool_calls_used: 0,
            trace: Vec::new(),
            cancelled: false,
            pending_delegate: Vec::new(),
            recorded_plan: None,
        };
        self.runs
            .lock()
            .map_err(|_| CoreError::rpc("AGENT_BUSY", "agent lock poisoned"))?
            .insert(run_id.clone(), state);
        Ok(self.need_llm(&run_id)?)
    }

    pub fn cancel(&self, run_id: &str) -> Result<(), CoreError> {
        let mut runs = self
            .runs
            .lock()
            .map_err(|_| CoreError::rpc("AGENT_BUSY", "agent lock poisoned"))?;
        if let Some(state) = runs.get_mut(run_id) {
            state.cancelled = true;
        }
        Ok(())
    }

    pub fn set_messages(&self, run_id: &str, messages: Vec<Value>) -> Result<(), CoreError> {
        if messages.is_empty() {
            return Err(CoreError::rpc("INVALID_PARAMS", "messages 不能为空"));
        }
        let mut runs = self
            .runs
            .lock()
            .map_err(|_| CoreError::rpc("AGENT_BUSY", "agent lock poisoned"))?;
        let state = runs
            .get_mut(run_id)
            .ok_or_else(|| CoreError::rpc("AGENT_RUN_NOT_FOUND", "run 不存在或已结束"))?;
        if state.cancelled {
            return Err(CoreError::rpc("AGENT_CANCELLED", "run 已取消"));
        }
        state.messages = messages;
        Ok(())
    }

    /// 纯内存账本推进：本函数不做任何 IO，**同步**即可（此前写成 `async` 是历史遗留，
    /// 会在多线程运行时下让 `std::sync::MutexGuard` 跨 await，违反 `Send`）。
    /// 与 `submit_tool_results` 共用 `self.runs`（非重入锁），故每条路径都用 `drop(runs)` 收窄临界区。
    pub fn continue_llm(
        &self,
        _config: &AppConfig,
        _index: &IndexService,
        run_id: &str,
        llm: LlmResponseInput,
    ) -> Result<LoopResponse, CoreError> {
        let mut runs = self
            .runs
            .lock()
            .map_err(|_| CoreError::rpc("AGENT_BUSY", "agent lock poisoned"))?;
        let state = runs
            .get_mut(run_id)
            .ok_or_else(|| CoreError::rpc("AGENT_RUN_NOT_FOUND", "run 不存在或已结束"))?;

        if state.cancelled {
            return Err(CoreError::rpc("AGENT_CANCELLED", "run 已取消"));
        }
        // 通道身份随本轮一起进来：`Reasoning` 表示 `content` 键里装的是思考
        // （单通道模型），账本据此把它记进思考，绝不进交付正文。
        let channel = llm.content_channel;
        if state.round >= state.max_rounds {
            if llm.tool_calls.is_empty() {
                let trace = state.trace.clone();
                let content = delivered_content(llm.content.as_deref(), channel);
                drop(runs);
                return Ok(self.finish_run(run_id, trace, content, false));
            }
            let hint = format!("已达本段 {} 轮上限", state.max_rounds);
            let synthetic_text =
                push_assistant_text_only(&mut state.messages, llm.content.as_ref(), &hint);
            state.trace.push(TraceRound {
                round: state.round,
                thought: hint,
                full_thought: llm_thought_raw(&llm),
                content_source: ContentSource::Synthetic,
                visible_content: Some(synthetic_text),
                tools: Vec::new(),
            });
            let trace = state.trace.clone();
            let content = delivered_content(llm.content.as_deref(), channel);
            drop(runs);
            return Ok(self.finish_run(run_id, trace, content, true));
        }

        state.round += 1;
        let round_no = state.round;
        let previous_thoughts: Vec<String> = state
            .trace
            .iter()
            .map(|r| {
                r.full_thought
                    .clone()
                    .unwrap_or_else(|| r.thought.clone())
            })
            .collect();
        let content_raw = llm.content.clone().unwrap_or_default();
        let content_stripped = strip_agent_status(&content_raw);
        let had_plan = state.recorded_plan.is_some();
        let stored_content = if let Some(plan) = state.recorded_plan.as_ref() {
            strip_repeated_preamble(&content_stripped, plan)
        } else {
            content_stripped.clone()
        };
        if !had_plan && content_stripped.chars().count() >= MIN_RECORDED_PLAN_CHARS {
            state.recorded_plan = Some(content_stripped.clone());
        }
        // 思考原文只来自思考通道：`reasoning` 键，或（单通道模型）`content` 键。
        // 不再用「正文」兜底思考 —— 那正是旧实现让思考区复述回答的路径。
        let thought_raw = llm_thought_raw(&llm).unwrap_or_default();
        let display_thought = sanitize_thought(&thought_raw, &previous_thoughts);
        let full_thought = if display_thought.is_empty() {
            None
        } else {
            Some(display_thought.clone())
        };
        let thought = display_thought.chars().take(500).collect::<String>();
        // 可交付正文 = 非思考通道 且 内容非空。思考通道的 `content` 只是思考的存放处，
        // 交给下游会把推理复述成结论（UI 上就是「回答区出现了思考」）。
        let visible_content = if channel != ContentChannel::Reasoning
            && !stored_content.trim().is_empty()
        {
            Some(stored_content.clone())
        } else {
            None
        };
        let content_source = if visible_content.is_some() {
            ContentSource::Answer
        } else if full_thought.is_some() {
            ContentSource::Reasoning
        } else {
            ContentSource::Absent
        };
        let trace_tools = Vec::new();

        if !llm.tool_calls.is_empty() {
            let mut assistant_msg = json!({
                "role": "assistant",
                "content": stored_content.clone(),
                "tool_calls": llm.tool_calls.iter().map(|tc| json!({
                    "id": tc.id,
                    "type": "function",
                    "function": {
                        "name": tc.name,
                        "arguments": if tc.arguments.is_string() {
                            tc.arguments.as_str().unwrap_or("{}").to_string()
                        } else {
                            serde_json::to_string(&tc.arguments).unwrap_or_else(|_| "{}".into())
                        }
                    }
                })).collect::<Vec<_>>()
            });
            // 思考模式（DeepSeek V4 等）：带 tool_calls 的 assistant 消息必须原样回传
            // reasoning_content，否则下一轮请求会被上游以 HTTP 400 拒绝。
            if let Some(reasoning) = llm.reasoning.as_deref().filter(|s| !s.trim().is_empty()) {
                assistant_msg["reasoning_content"] = json!(reasoning);
            }

            if state.tool_calls_used + llm.tool_calls.len() as u32 > state.max_tool_calls {
                let hint = format!("已达本段 {} 次工具调用上限", state.max_tool_calls);
                let synthetic_text =
                    push_assistant_text_only(&mut state.messages, llm.content.as_ref(), &hint);
                state.trace.push(TraceRound {
                    round: round_no,
                    thought: hint,
                    full_thought: llm_thought_raw(&llm),
                    content_source: ContentSource::Synthetic,
                    visible_content: Some(synthetic_text),
                    tools: trace_tools,
                });
                let trace = state.trace.clone();
                let content = delivered_content(llm.content.as_deref(), channel);
                drop(runs);
                return Ok(self.finish_run(run_id, trace, content, true));
            }

            state.messages.push(assistant_msg);

            for tc in &llm.tool_calls {
                let args = parse_tool_arguments(&tc.arguments);
                state
                    .pending_delegate
                    .push((tc.id.clone(), tc.name.clone(), args));
            }

            state.trace.push(TraceRound {
                round: round_no,
                thought: thought.clone(),
                full_thought,
                content_source,
                visible_content: visible_content.clone(),
                tools: trace_tools,
            });

            if is_length_stop(&llm.finish_reason) {
                let results: Vec<ToolResultInput> = llm
                    .tool_calls
                    .iter()
                    .map(|tc| ToolResultInput {
                        id: tc.id.clone(),
                        result: json!({}),
                        error: Some(format!("工具「{}」{TRUNCATED_TOOL_ERROR}", tc.name)),
                    })
                    .collect();
                drop(runs);
                return self.submit_tool_results(_config, _index, run_id, results);
            }

            let delegates = state
                .pending_delegate
                .iter()
                .map(|(id, name, args)| DelegateTool {
                    id: id.clone(),
                    name: name.clone(),
                    arguments: args.clone(),
                })
                .collect();
            drop(runs);
            return Ok(LoopResponse {
                phase: "need_delegate".into(),
                run_id: run_id.to_string(),
                llm_body: None,
                delegates: Some(delegates),
                content: None,
                trace: None,
                hit_round_limit: None,
                messages: None,
                message: None,
            });
        }

        state.trace.push(TraceRound {
            round: round_no,
            thought,
            full_thought,
            content_source,
            visible_content,
            tools: trace_tools,
        });
        let trace = state.trace.clone();
        let content = delivered_content(llm.content.as_deref(), channel);
        drop(runs);
        Ok(self.finish_run(run_id, trace, content, false))
    }

    /// 与 `continue_llm` 同属纯内存账本推进，见其注释：**同步**，无 IO。
    pub fn submit_tool_results(
        &self,
        _config: &AppConfig,
        _index: &IndexService,
        run_id: &str,
        results: Vec<ToolResultInput>,
    ) -> Result<LoopResponse, CoreError> {
        let mut runs = self
            .runs
            .lock()
            .map_err(|_| CoreError::rpc("AGENT_BUSY", "agent lock poisoned"))?;
        let state = runs
            .get_mut(run_id)
            .ok_or_else(|| CoreError::rpc("AGENT_RUN_NOT_FOUND", "run 不存在或已结束"))?;

        if state.cancelled {
            return Err(CoreError::rpc("AGENT_CANCELLED", "run 已取消"));
        }

        if state.pending_delegate.is_empty() {
            drop(runs);
            return self.need_llm(run_id);
        }

        let pending: HashMap<String, (String, Value)> = state
            .pending_delegate
            .drain(..)
            .map(|(id, name, args)| (id, (name, args)))
            .collect();

        let returned_ids: std::collections::HashSet<String> =
            results.iter().map(|r| r.id.clone()).collect();

        for tr in results {
            let Some((name, args)) = pending.get(&tr.id).map(|(n, a)| (n.clone(), a.clone()))
            else {
                continue;
            };
            state.tool_calls_used += 1;
            if let Some(round) = state.trace.last_mut() {
                round.tools.push(TraceTool {
                    name: name.clone(),
                    args: args.clone(),
                    result: if tr.error.is_none() {
                        Some(tr.result.clone())
                    } else {
                        None
                    },
                    error: tr.error.clone(),
                });
            }
            state.messages.push(json!({
                "role": "tool",
                "tool_call_id": tr.id,
                "content": if let Some(err) = &tr.error {
                    err.clone()
                } else {
                    serde_json::to_string(&tr.result).unwrap_or_else(|_| "{}".into())
                }
            }));
        }

        for (id, (name, args)) in pending {
            if returned_ids.contains(&id) {
                continue;
            }
            state.messages.push(json!({
                "role": "tool",
                "tool_call_id": id,
                "content": format!("工具 {name} 未返回结果")
            }));
            if let Some(round) = state.trace.last_mut() {
                round.tools.push(TraceTool {
                    name,
                    args,
                    result: None,
                    error: Some("delegate missing".into()),
                });
            }
        }

        strip_inline_images_from_messages(&mut state.messages);
        drop(runs);
        self.need_llm(run_id)
    }

    fn need_llm(&self, run_id: &str) -> Result<LoopResponse, CoreError> {
        let runs = self
            .runs
            .lock()
            .map_err(|_| CoreError::rpc("AGENT_BUSY", "agent lock poisoned"))?;
        let state = runs
            .get(run_id)
            .ok_or_else(|| CoreError::rpc("AGENT_RUN_NOT_FOUND", "run 不存在或已结束"))?;
        if state.cancelled {
            return Err(CoreError::rpc("AGENT_CANCELLED", "run 已取消"));
        }
        let llm_body = json!({
            "model": state.model,
            "messages": state.messages,
            "tools": state.tools,
            "stream": false
        });
        Ok(LoopResponse {
            phase: "need_llm".into(),
            run_id: run_id.to_string(),
            llm_body: Some(llm_body),
            delegates: None,
            content: None,
            trace: None,
            hit_round_limit: None,
            messages: None,
            message: None,
        })
    }

    fn finish_run(
        &self,
        run_id: &str,
        trace: Vec<TraceRound>,
        content: Option<String>,
        hit_limit: bool,
    ) -> LoopResponse {
        let messages = self
            .runs
            .lock()
            .ok()
            .and_then(|runs| runs.get(run_id).map(|s| s.messages.clone()));
        if let Ok(mut runs) = self.runs.lock() {
            runs.remove(run_id);
        }
        self.build_done(run_id, trace, content, hit_limit, messages)
    }

    fn build_done(
        &self,
        run_id: &str,
        trace: Vec<TraceRound>,
        content: Option<String>,
        hit_limit: bool,
        messages: Option<Vec<Value>>,
    ) -> LoopResponse {
        LoopResponse {
            phase: "done".into(),
            run_id: run_id.to_string(),
            llm_body: None,
            delegates: None,
            content,
            trace: Some(trace),
            hit_round_limit: if hit_limit { Some(true) } else { None },
            messages,
            message: None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::AppConfig;
    use crate::embedding::EmbeddingConfig;
    use crate::index::IndexService;
    use serde_json::json;
    use tempfile::tempdir;

    #[test]
    fn start_returns_need_llm() {
        let mgr = AgentLoopManager::default();
        let r = mgr
            .start(StartParams {
                model: "test-model".into(),
                messages: vec![json!({"role":"user","content":"hello"})],
                tools: vec![],
                workspace_root: None,
                max_tool_calls: None,
                max_rounds: None,
            })
            .unwrap();
        assert_eq!(r.phase, "need_llm");
        assert!(r.llm_body.is_some());
        assert!(!r.run_id.is_empty());
    }

    #[tokio::test]
    async fn normal_done_returns_messages_for_continuation_guard() {
        let dir = tempdir().unwrap();
        let config = AppConfig::default();
        let index = IndexService::new(
            crate::codebase_db::handle(dir.path().join("idx.sqlite")),
            EmbeddingConfig::default(),
            Vec::new(),
        );
        let mgr = AgentLoopManager::default();
        let start = mgr
            .start(StartParams {
                model: "test-model".into(),
                messages: vec![json!({"role":"user","content":"inspect project"})],
                tools: vec![],
                workspace_root: None,
                max_tool_calls: Some(10),
                max_rounds: Some(10),
            })
            .unwrap();

        let done = mgr
            .continue_llm(
                &config,
                &index,
                &start.run_id,
                LlmResponseInput {
                    content: Some("Let me check one more file.".into()),
                    ..Default::default()
                },
            )
            .unwrap();

        assert_eq!(done.phase, "done");
        assert_eq!(done.hit_round_limit, None);
        let msgs = done.messages.expect("messages for continuation guard");
        assert_eq!(msgs.len(), 1);
        assert_eq!(msgs[0].get("role").and_then(|r| r.as_str()), Some("user"));
    }

    /// 只有思考、没有正文的轮次：**不**把思考顶上来当正文（旧行为），
    /// 而是 `content = None` + 账本记 `Reasoning`。空回复的收口在 Node 侧
    /// （`applyTurnEndSynthesis` 用 trace 汇总），见 REASONING-ISOLATION-PLAN §3.4。
    #[tokio::test]
    async fn reasoning_only_turn_yields_no_content_but_keeps_thought() {
        let dir = tempdir().unwrap();
        let config = AppConfig::default();
        let index = IndexService::new(
            crate::codebase_db::handle(dir.path().join("idx.sqlite")),
            EmbeddingConfig::default(),
            Vec::new(),
        );
        let mgr = AgentLoopManager::default();
        let start = mgr
            .start(StartParams {
                model: "test-model".into(),
                messages: vec![json!({"role":"user","content":"summarize work"})],
                tools: vec![],
                workspace_root: None,
                max_tool_calls: Some(10),
                max_rounds: Some(10),
            })
            .unwrap();

        let writeup = "已改 renderer-agent-complete.js：循环返回后立刻收口气泡，避免停在生成回答中。";
        let done = mgr
            .continue_llm(
                &config,
                &index,
                &start.run_id,
                LlmResponseInput {
                    content: Some("".into()),
                    reasoning: Some(writeup.into()),
                    tool_calls: vec![],
                    ..Default::default()
                },
            )
            .unwrap();

        assert_eq!(done.phase, "done");
        assert_eq!(done.content, None, "思考不得作为正文交付");
        let rounds = done.trace.expect("trace");
        let last = rounds.last().expect("round");
        assert_eq!(last.content_source, ContentSource::Reasoning);
        assert!(last.visible_content.is_none());
        assert_eq!(last.full_thought.as_deref(), Some(writeup));
    }

    /// 单通道模型（如 mimo）：入口把 `content` 键盖章为思考通道。
    /// 此时 `content` 里的推理文本只进思考，**不得**成为交付正文 ——
    /// 这是删掉 `content_or_reasoning` 兜底后「正文不等于思考」的核心回归点。
    #[tokio::test]
    async fn single_channel_content_becomes_thought_not_visible_reply() {
        let dir = tempdir().unwrap();
        let config = AppConfig::default();
        let index = IndexService::new(
            crate::codebase_db::handle(dir.path().join("idx.sqlite")),
            EmbeddingConfig::default(),
            Vec::new(),
        );
        let mgr = AgentLoopManager::default();
        let start = mgr
            .start(StartParams {
                model: "mimo-v2-flash".into(),
                messages: vec![json!({"role":"user","content":"改一处 bug"})],
                tools: vec![],
                workspace_root: None,
                max_tool_calls: Some(10),
                max_rounds: Some(10),
            })
            .unwrap();

        let reasoning_text = "先读 a.txt 再改 b.js，确认三处调用点都在同一条路径上，然后跑一次冒烟。";
        let done = mgr
            .continue_llm(
                &config,
                &index,
                &start.run_id,
                LlmResponseInput {
                    content: Some(reasoning_text.into()),
                    tool_calls: vec![],
                    content_channel: ContentChannel::Reasoning,
                    ..Default::default()
                },
            )
            .unwrap();

        assert_eq!(done.phase, "done");
        assert_eq!(done.content, None, "单通道模型的 content 是思考，不能当正文");
        let rounds = done.trace.expect("trace");
        let last = rounds.last().expect("round");
        assert_eq!(last.content_source, ContentSource::Reasoning);
        assert!(last.visible_content.is_none());
        assert_eq!(last.full_thought.as_deref(), Some(reasoning_text));
    }

    /// 入口传的是 camelCase 字段 + snake_case 取值，务必与 Node 端逐字对齐，
    /// 否则通道盖章到不了账本（症状是「改了没效果」）。
    #[test]
    fn llm_response_input_deserializes_content_channel() {
        let as_reasoning: LlmResponseInput =
            serde_json::from_value(json!({ "content": "推理文本", "contentChannel": "reasoning" }))
                .unwrap();
        assert_eq!(as_reasoning.content_channel, ContentChannel::Reasoning);

        // 缺字段（旧版 Node / 未声明模型）回落 `Absent`，不报错
        let legacy: LlmResponseInput = serde_json::from_value(json!({ "content": "ok" })).unwrap();
        assert_eq!(legacy.content_channel, ContentChannel::Absent);

        // 未知取值不阻断请求
        let unknown: LlmResponseInput =
            serde_json::from_value(json!({ "contentChannel": "whatever" })).unwrap();
        assert_eq!(unknown.content_channel, ContentChannel::Absent);
    }

    /// 正文口径唯一：只看 `content` 与通道身份，**永不看** reasoning 文本长短。
    #[test]
    fn delivered_content_only_accepts_answer_channel() {
        assert_eq!(
            delivered_content(Some("正文"), ContentChannel::Answer).as_deref(),
            Some("正文")
        );
        // 思考通道：即便有文本也不交付
        assert_eq!(
            delivered_content(
                Some("很长的推理文本，但它属于思考通道，不该被当成回答。"),
                ContentChannel::Reasoning
            ),
            None
        );
        assert_eq!(delivered_content(Some("  "), ContentChannel::Answer), None);
        assert_eq!(delivered_content(None, ContentChannel::Absent), None);
        // 入口未盖章（旧版 Node / 未声明的模型）：按内容判定，保持向后兼容
        assert_eq!(
            delivered_content(Some("正文"), ContentChannel::Absent).as_deref(),
            Some("正文")
        );
    }

    /// 命中上限的两条分支与正常收尾共用同一正文口径：**思考不顶正文**。
    /// 上限轮的账本记 `ContentSource::Synthetic`（平台补的提示），
    /// 「被截断」这一事实由 `hit_round_limit` 表达，交付形态交给 Node 收口。
    #[tokio::test]
    async fn limit_branches_never_promote_reasoning_to_content() {
        let dir = tempdir().unwrap();
        let config = AppConfig::default();
        let index = IndexService::new(
            crate::codebase_db::handle(dir.path().join("idx.sqlite")),
            EmbeddingConfig::default(),
            Vec::new(),
        );
        let reasoning = "已定位 loop_run.rs 的四条终态路径，接下来统一正文口径。";
        let tool_call = |id: &str| ToolCallInput {
            id: id.into(),
            name: "read_file".into(),
            arguments: json!({"path":"a.txt"}),
        };

        // 轮次上限（带 tool_calls）
        let mgr = AgentLoopManager::default();
        let start = mgr
            .start(StartParams {
                model: "test-model".into(),
                messages: vec![json!({"role":"user","content":"run tools"})],
                tools: vec![],
                workspace_root: None,
                max_tool_calls: Some(10),
                max_rounds: Some(1),
            })
            .unwrap();
        {
            let mut runs = mgr.runs.lock().unwrap();
            runs.get_mut(&start.run_id).unwrap().round = 1;
        }
        let done = mgr
            .continue_llm(
                &config,
                &index,
                &start.run_id,
                LlmResponseInput {
                    content: Some("".into()),
                    reasoning: Some(reasoning.into()),
                    tool_calls: vec![tool_call("tc1")],
                    ..Default::default()
                },
            )
            .unwrap();
        assert_eq!(done.hit_round_limit, Some(true));
        assert_eq!(done.content, None, "上限轮不得把思考当正文交付");
        let last = done.trace.as_ref().and_then(|t| t.last()).expect("round");
        assert_eq!(last.content_source, ContentSource::Synthetic);
        assert_eq!(last.full_thought.as_deref(), Some(reasoning));

        // 工具次数上限
        let start2 = mgr
            .start(StartParams {
                model: "test-model".into(),
                messages: vec![json!({"role":"user","content":"run tools"})],
                tools: vec![],
                workspace_root: None,
                max_tool_calls: Some(0),
                max_rounds: Some(10),
            })
            .unwrap();
        let done2 = mgr
            .continue_llm(
                &config,
                &index,
                &start2.run_id,
                LlmResponseInput {
                    content: Some("".into()),
                    reasoning: Some(reasoning.into()),
                    tool_calls: vec![tool_call("tc2")],
                    ..Default::default()
                },
            )
            .unwrap();
        assert_eq!(done2.hit_round_limit, Some(true));
        assert_eq!(done2.content, None, "上限轮不得把思考当正文交付");
        let last2 = done2.trace.as_ref().and_then(|t| t.last()).expect("round");
        assert_eq!(last2.content_source, ContentSource::Synthetic);
    }

    #[tokio::test]
    async fn tool_limit_leaves_no_dangling_tool_calls_in_messages() {
        let dir = tempdir().unwrap();
        let config = AppConfig::default();
        let index = IndexService::new(
            crate::codebase_db::handle(dir.path().join("idx.sqlite")),
            EmbeddingConfig::default(),
            Vec::new(),
        );
        let mgr = AgentLoopManager::default();
        let start = mgr
            .start(StartParams {
                model: "test-model".into(),
                messages: vec![json!({"role":"user","content":"run tools"})],
                tools: vec![],
                workspace_root: None,
                max_tool_calls: Some(0),
                max_rounds: Some(10),
            })
            .unwrap();

        let done = mgr
            .continue_llm(
                &config,
                &index,
                &start.run_id,
                LlmResponseInput {
                    content: Some("partial progress".into()),
                    reasoning: None,
                    tool_calls: vec![ToolCallInput {
                        id: "tc1".into(),
                        name: "read_file".into(),
                        arguments: json!({"path":"a.txt"}),
                    }],
                    ..Default::default()
                },
            )
            .unwrap();

        assert_eq!(done.phase, "done");
        assert_eq!(done.hit_round_limit, Some(true));
        let msgs = done.messages.expect("messages for segment continue");
        for m in &msgs {
            if m.get("role").and_then(|r| r.as_str()) == Some("assistant") {
                assert!(
                    m.get("tool_calls").is_none(),
                    "assistant must not have dangling tool_calls: {m}"
                );
            }
        }
        let last = msgs.last().unwrap();
        assert_eq!(last.get("role").and_then(|r| r.as_str()), Some("assistant"));
        assert_eq!(
            last.get("content").and_then(|c| c.as_str()),
            Some("partial progress")
        );
    }

    #[tokio::test]
    async fn tool_call_assistant_message_keeps_reasoning_content() {
        let dir = tempdir().unwrap();
        let config = AppConfig::default();
        let index = IndexService::new(
            crate::codebase_db::handle(dir.path().join("idx.sqlite")),
            EmbeddingConfig::default(),
            Vec::new(),
        );
        let mgr = AgentLoopManager::default();
        let start = mgr
            .start(StartParams {
                model: "test-model".into(),
                messages: vec![json!({"role":"user","content":"run tools"})],
                tools: vec![],
                workspace_root: None,
                max_tool_calls: None,
                max_rounds: Some(10),
            })
            .unwrap();

        let phase = mgr
            .continue_llm(
                &config,
                &index,
                &start.run_id,
                LlmResponseInput {
                    content: Some("".into()),
                    reasoning: Some("need to read a.txt".into()),
                    tool_calls: vec![ToolCallInput {
                        id: "tc1".into(),
                        name: "read_file".into(),
                        arguments: json!({"path":"a.txt"}),
                    }],
                    ..Default::default()
                },
            )
            .unwrap();
        assert_eq!(phase.phase, "need_delegate");

        let runs = mgr.runs.lock().unwrap();
        let state = runs.get(&start.run_id).expect("run still live");
        let assistant = state
            .messages
            .iter()
            .find(|m| {
                m.get("role").and_then(|r| r.as_str()) == Some("assistant")
                    && m.get("tool_calls").is_some()
            })
            .expect("assistant tool-call message");
        assert_eq!(
            assistant.get("reasoning_content").and_then(|c| c.as_str()),
            Some("need to read a.txt")
        );
    }

    #[tokio::test]
    async fn round_limit_blocks_tool_delegate() {
        let dir = tempdir().unwrap();
        let config = AppConfig::default();
        let index = IndexService::new(
            crate::codebase_db::handle(dir.path().join("idx.sqlite")),
            EmbeddingConfig::default(),
            Vec::new(),
        );
        let mgr = AgentLoopManager::default();
        let start = mgr
            .start(StartParams {
                model: "test-model".into(),
                messages: vec![json!({"role":"user","content":"run tools"})],
                tools: vec![],
                workspace_root: None,
                max_tool_calls: Some(10),
                max_rounds: Some(1),
            })
            .unwrap();

        {
            let mut runs = mgr.runs.lock().unwrap();
            if let Some(state) = runs.get_mut(&start.run_id) {
                state.round = 1;
            }
        }

        let done = mgr
            .continue_llm(
                &config,
                &index,
                &start.run_id,
                LlmResponseInput {
                    content: Some("one more tool".into()),
                    reasoning: None,
                    tool_calls: vec![ToolCallInput {
                        id: "tc1".into(),
                        name: "read_file".into(),
                        arguments: json!({"path":"a.txt"}),
                    }],
                    ..Default::default()
                },
            )
            .unwrap();

        assert_eq!(done.phase, "done");
        assert_eq!(done.hit_round_limit, Some(true));
        assert!(done.delegates.is_none());
    }

    #[test]
    fn strip_agent_status_drops_protocol_line() {
        let body = "可以补全，主人。\n\n验收目标";
        assert_eq!(
            strip_agent_status(&format!("agent_status: continue\n{body}")),
            body
        );
        assert_eq!(
            strip_agent_status("<agent_status>final</agent_status>\n完成。"),
            "完成。"
        );
        assert_eq!(strip_agent_status("agent_status: continue"), "");
    }

    #[test]
    fn strip_repeated_preamble_keeps_only_delta() {
        let plan = "可以补全，主人。\n\n验收目标\n- 单人/多人三档难度\n- 房间创建后锁定难度";
        let round2 = format!("agent_status: continue\n{plan}\n\n接下来读取 difficulty.cjs。");
        assert_eq!(
            strip_repeated_preamble(&round2, plan),
            "接下来读取 difficulty.cjs。"
        );
        assert_eq!(strip_repeated_preamble(plan, plan), "");
    }

    #[tokio::test]
    async fn later_tool_round_does_not_repeat_recorded_plan() {
        let dir = tempdir().unwrap();
        let config = AppConfig::default();
        let index = IndexService::new(
            crate::codebase_db::handle(dir.path().join("idx.sqlite")),
            EmbeddingConfig::default(),
            Vec::new(),
        );
        let mgr = AgentLoopManager::default();
        let start = mgr
            .start(StartParams {
                model: "test-model".into(),
                messages: vec![json!({"role":"user","content":"补难度档位"})],
                tools: vec![],
                workspace_root: None,
                max_tool_calls: Some(10),
                max_rounds: Some(10),
            })
            .unwrap();

        let plan = "可以补全，主人。\n\n验收目标\n- 单人/多人三档难度\n- 房间创建后锁定难度\n- 普通/困难调整非 Boss 参数\n- 语法检查、构建、Boss HP 断言与浏览器进程作为证据";
        assert!(plan.chars().count() >= MIN_RECORDED_PLAN_CHARS);
        let content = format!("agent_status: continue\n{plan}");

        let first = mgr
            .continue_llm(
                &config,
                &index,
                &start.run_id,
                LlmResponseInput {
                    content: Some(content.clone()),
                    reasoning: None,
                    tool_calls: vec![ToolCallInput {
                        id: "tc1".into(),
                        name: "read_file".into(),
                        arguments: json!({"path":"difficulty.cjs"}),
                    }],
                    ..Default::default()
                },
            )
            .unwrap();
        assert_eq!(first.phase, "need_delegate");

        let need = mgr
            .submit_tool_results(
                &config,
                &index,
                &start.run_id,
                vec![ToolResultInput {
                    id: "tc1".into(),
                    result: json!({"ok": true}),
                    error: None,
                }],
            )
            .unwrap();
        assert_eq!(need.phase, "need_llm");
        let msgs = need
            .llm_body
            .as_ref()
            .and_then(|b| b.get("messages"))
            .and_then(|m| m.as_array())
            .cloned()
            .unwrap_or_default();
        assert!(
            !msgs.iter().any(|m| {
                m.get("role").and_then(|r| r.as_str()) == Some("user")
                    && m.get("content")
                        .and_then(|c| c.as_str())
                        .unwrap_or("")
                        .contains("验收计划已记录")
            }),
            "must not inject plan-recorded reminder"
        );
        let first_assistant = msgs
            .iter()
            .find(|m| m.get("role").and_then(|r| r.as_str()) == Some("assistant"))
            .and_then(|m| m.get("content").and_then(|c| c.as_str()))
            .unwrap_or("");
        assert!(!first_assistant.contains("agent_status"));
        assert!(first_assistant.contains("验收目标"));

        let second = mgr
            .continue_llm(
                &config,
                &index,
                &start.run_id,
                LlmResponseInput {
                    content: Some(format!("{content}\n\n接下来再搜一遍。")),
                    reasoning: None,
                    tool_calls: vec![ToolCallInput {
                        id: "tc2".into(),
                        name: "grep".into(),
                        arguments: json!({"pattern":"difficulty"}),
                    }],
                    ..Default::default()
                },
            )
            .unwrap();
        assert_eq!(second.phase, "need_delegate");

        let runs = mgr.runs.lock().unwrap();
        let state = runs.get(&start.run_id).expect("run still live");
        let assistants: Vec<&str> = state
            .messages
            .iter()
            .filter(|m| m.get("role").and_then(|r| r.as_str()) == Some("assistant"))
            .filter_map(|m| m.get("content").and_then(|c| c.as_str()))
            .collect();
        assert_eq!(assistants.len(), 2);
        assert!(
            !assistants[1].contains("验收目标"),
            "second assistant content must not repeat the plan: {}",
            assistants[1]
        );
        let last_thought = state.trace.last().map(|r| r.thought.as_str()).unwrap_or("");
        assert!(!last_thought.contains("agent_status"));
        assert!(
            !last_thought.contains("验收目标"),
            "second thought must not repeat the plan: {last_thought}"
        );
    }

    #[tokio::test]
    async fn length_stop_does_not_delegate_truncated_tool_calls() {
        let dir = tempdir().unwrap();
        let config = AppConfig::default();
        let index = IndexService::new(
            crate::codebase_db::handle(dir.path().join("idx.sqlite")),
            EmbeddingConfig::default(),
            Vec::new(),
        );
        let mgr = AgentLoopManager::default();
        let start = mgr
            .start(StartParams {
                model: "test-model".into(),
                messages: vec![json!({"role":"user","content":"edit"})],
                tools: vec![],
                workspace_root: None,
                max_tool_calls: Some(10),
                max_rounds: Some(10),
            })
            .unwrap();

        let next = mgr
            .continue_llm(
                &config,
                &index,
                &start.run_id,
                LlmResponseInput {
                    content: Some("editing".into()),
                    tool_calls: vec![ToolCallInput {
                        id: "tc1".into(),
                        name: "fs_edit".into(),
                        arguments: json!({"filePath":"a.js","oldString":"x","newString":"y"}),
                    }],
                    finish_reason: Some("length".into()),
                    ..Default::default()
                },
            )
            .unwrap();

        assert_eq!(next.phase, "need_llm");
        assert!(next.delegates.is_none());
        let msgs = next
            .llm_body
            .as_ref()
            .and_then(|b| b.get("messages"))
            .and_then(|m| m.as_array())
            .cloned()
            .unwrap_or_default();
        let tool_msg = msgs
            .iter()
            .rev()
            .find(|m| m.get("role").and_then(|r| r.as_str()) == Some("tool"));
        let content = tool_msg
            .and_then(|m| m.get("content").and_then(|c| c.as_str()))
            .unwrap_or("");
        assert!(
            content.contains("token 上限"),
            "expected truncation error, got {content}"
        );
    }
}

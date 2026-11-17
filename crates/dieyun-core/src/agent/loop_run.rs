use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::config::AppConfig;
use crate::error::CoreError;
use crate::index::IndexService;
/// 护栏数字的唯一来源是 Node：`agent-limits.js` 解析、模型设置 `agentToolCallLimit`
/// （按 Context 档位存）/ `agentMaxRounds` 提供数值，
/// 由 `rust-loop-runner.applyResolvedLoopSpec` 在唯一入口填进 `StartParams`。
/// 内核**不留**同名默认值：跨语言复制一个数字，改一边就静默分叉。


/// 本段结束、交给下游的正文 —— **四条终态路径（正常收尾 / 轮次上限 / 工具次数上限）**
/// 只有这一处口径：
/// - 思考通道（`ContentChannel::Reasoning`，单通道模型的 `content` 键）**永不**作为正文；
/// - 其余情况正文为空即 `None`：下游（`applyTurnEndSynthesis`、子 Agent 摘要）据此
///   判定「空回复」，而不是拿到一段空字符串的假正文。
///
/// 「被轮次/预算截断」这一事实用 `hit_round_limit` 与 `TraceRound.content_source` 表达；
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
    /// 必填：唯一来源是 Node `agent-limits.js`（`applyResolvedLoopSpec` 填入）。
    /// 缺参直接报错，而不是在内核里回落到一份会静默分叉的默认值。
    pub max_tool_calls: u32,
    pub max_rounds: u32,
    /// 折叠预算（token）。0 = 本 run 不折叠（老调用方 / 测试）。
    /// 数值唯一来源是 Node compaction-main.resolveFoldSpec，内核不存默认值。
    #[serde(default)]
    pub token_budget: usize,
    /// 折叠触发比（0.3~0.95）。同样只在 Node 算。
    #[serde(default)]
    pub trigger_ratio: f64,
    /// 宿主指定的 runId（可选）：给了就用它。
    ///
    /// 宿主要在本轮**发请求之前**订阅增量事件（按 runId 过滤）；等 core 生成 id 再返回就晚了，
    /// 第一轮的增量会丢。
    #[serde(default)]
    pub run_id: Option<String>,
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
    /// 服务端 usage（含 prompt_tokens）：折叠的触发口径优先用它，字符比只兜底。
    #[serde(default)]
    pub usage: Option<Value>,
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
    /// 本轮之前是否折叠过（账本事实，Node 据此写遥测 / 归档 / toast）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub compacted: Option<FoldFact>,
}

/// 一次折叠的账本事实（没折叠时整条为 None）。
///
/// 折叠**在循环内部**做（发出下一次请求之前），因为 transcript 归这层所有：
/// 早先由 Node 每轮调 `compaction.fold` 再把 messages 用 `set_messages` 推回来，
/// 等于同一份对话有两个写者。现在 Node 只读事实、写遥测。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FoldFact {
    pub level: u8,
    pub tokens_before: usize,
    pub tokens_after: usize,
    pub trigger_source: String,
    pub folded_tool_results: usize,
    pub folded_texts: usize,
    pub folded_images: usize,
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
    /// 折叠预算 / 触发比（0 表示本 run 不折叠）
    token_budget: usize,
    trigger_ratio: f64,
    /// 上一轮服务端回报的 usage.prompt_tokens：折叠触发优先用它
    observed_prompt_tokens: Option<usize>,
    /// 下一次回给宿主的折叠事实（取走即清）
    pending_fold: Option<FoldFact>,
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

/// 在发出下一次请求之前折叠自己的 messages。
///
/// 为什么在核心里做：transcript 归这层所有。早先由 Node 每轮调 compaction.fold、
/// 再用 gent.loop.set_messages 把整段对话推回来 —— 同一份对话两个写者，谁都能改。
///
/// 预算 / 触发比来自 Node（0 = 本 run 不折）；已用 token 优先取上一轮服务端
/// usage.prompt_tokens，拿不到才让折叠器回落到字符比估值。
fn fold_if_needed(state: &mut RunState) {
    fold_state(state, false);
}

/// 强制折叠一次：宿主在「上下文溢出」时用。那次失败已经证明估算不准，
/// 不能再等触发线（与旧实现里 `force: true` 的语义一致）。
fn fold_force(state: &mut RunState) {
    fold_state(state, true);
}

fn fold_state(state: &mut RunState, force: bool) {
    if state.token_budget == 0 || state.trigger_ratio <= 0.0 {
        return;
    }
    // 借用转移而不是 clone：这段 messages 可能上百 KB，每轮复制一次不值得
    let messages = std::mem::take(&mut state.messages);
    let result = crate::compaction::fold(crate::compaction::FoldParams {
        messages,
        token_budget: state.token_budget,
        trigger_ratio: state.trigger_ratio,
        observed_prompt_tokens: state.observed_prompt_tokens,
        force,
        keep_tail_atoms: None,
    });
    state.messages = result.messages;
    if result.compacted {
        state.pending_fold = Some(FoldFact {
            level: result.level,
            tokens_before: result.tokens_before,
            tokens_after: result.tokens_after,
            trigger_source: result.trigger_source.to_string(),
            folded_tool_results: result.folded_tool_results,
            folded_texts: result.folded_texts,
            folded_images: result.folded_images,
        });
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
        // 宿主给了 id 就用它（见 `run_id` 字段的注释）；没给才自己生成。
        let run_id = params
            .run_id
            .clone()
            .map(|id| id.trim().to_string())
            .filter(|id| !id.is_empty())
            .unwrap_or_else(|| format!("run-{}", self.next_id.fetch_add(1, Ordering::Relaxed)));
        let state = RunState {
            model: params.model,
            messages: params.messages,
            tools: params.tools,
            workspace_root: params.workspace_root,
            max_tool_calls: params.max_tool_calls,
            max_rounds: params.max_rounds,
            round: 0,
            tool_calls_used: 0,
            trace: Vec::new(),
            cancelled: false,
            pending_delegate: Vec::new(),
            token_budget: params.token_budget,
            trigger_ratio: params.trigger_ratio,
            observed_prompt_tokens: None,
            pending_fold: None,
        };
        self.runs
            .lock()
            .map_err(|_| CoreError::rpc("AGENT_BUSY", "agent lock poisoned"))?
            .insert(run_id.clone(), state);
        Ok(self.need_llm(&run_id)?)
    }

    /// 从账本里摘掉图片 part，返回（摘掉张数, 当前 messages）。
    ///
    /// 为什么要有这条：上游 400「图片不支持」时，Node 只能**请求**「把这几条消息里的图摘掉」，
    /// 不能自己改写 transcript —— 那会让同一份对话出现第二个写者。返回 messages 只是给宿主
    /// 拼本次重发请求用，落库的真相仍在 core。
    pub fn drop_images(
        &self,
        run_id: &str,
        indices: Option<&[usize]>,
    ) -> Result<(usize, Vec<Value>), CoreError> {
        let mut runs = self
            .runs
            .lock()
            .map_err(|_| CoreError::rpc("AGENT_BUSY", "agent lock poisoned"))?;
        let state = runs
            .get_mut(run_id)
            .ok_or_else(|| CoreError::rpc("AGENT_RUN_NOT_FOUND", "run 不存在或已结束"))?;
        let mut dropped = 0usize;
        match indices {
            Some(list) => {
                for idx in list {
                    if let Some(msg) = state.messages.get_mut(*idx) {
                        dropped += crate::compaction::strip_images_only(msg);
                    }
                }
            }
            None => {
                for msg in state.messages.iter_mut() {
                    dropped += crate::compaction::strip_images_only(msg);
                }
            }
        }
        Ok((dropped, state.messages.clone()))
    }

    /// 强制折叠一次，返回事实（没折成 / 本 run 不折叠时 None）。
    ///
    /// 只给「上下文溢出」这条路径用：正常触发由 `need_llm` 内部的 `fold_if_needed` 负责，
    /// 宿主不再自己折完把 messages 推回来。
    pub fn fold_now(&self, run_id: &str, force: bool) -> Result<Option<FoldFact>, CoreError> {
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
        if force {
            fold_force(state);
        } else {
            fold_if_needed(state);
        }
        Ok(state.pending_fold.take())
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

    /// 当前轮次（只读快照；run 已结束或不存在时返回 `None`）。
    ///
    /// 谁需要它：驱动器在每次发请求前把「第几轮」告诉宿主（`round.prepare` 的 `round`），
    /// 宿主据此给 UI / 视觉注入标轮次。轮次是账本事实，宿主不能自己数（一个 run 会被
    /// `agent.run.start` / `agent.run.tools` 分多次驱动，宿主侧的计数必然与账本分叉）。
    pub fn round_of(&self, run_id: &str) -> Option<u32> {
        self.runs
            .lock()
            .ok()
            .and_then(|runs| runs.get(run_id).map(|state| state.round))
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
        // 服务端 usage 是折叠触发的首选口径：有了它就不必靠字符比猜「用了多少」
        if let Some(prompt) = llm
            .usage
            .as_ref()
            .and_then(|u| u.get("prompt_tokens"))
            .and_then(|v| v.as_u64())
        {
            state.observed_prompt_tokens = Some(prompt as usize);
        }
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
        // 本段正文就是模型原文：不再剥 `agent_status` 行，也不做「重复前言」字符串去重
        // —— 每轮 assistant 消息本身就是增量；跨轮重复是模型行为，不是账本该改写的事实。
        let stored_content = llm.content.clone().unwrap_or_default();
        // 思考原文只来自思考通道：`reasoning` 键，或（单通道模型）`content` 键。
        // 不再用「正文」兜底思考 —— 那正是旧实现让思考区复述回答的路径。
        let thought_raw = llm_thought_raw(&llm).unwrap_or_default();
        let full_thought = if thought_raw.is_empty() {
            None
        } else {
            Some(thought_raw.clone())
        };
        let thought = thought_raw.chars().take(500).collect::<String>();
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
                compacted: None,
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

    /// 取「下一次该发什么」（内含折叠）。驱动器在自愈（强制折叠 / 摘图）之后要靠它重新取 body。
    pub fn next_body(&self, run_id: &str) -> Result<LoopResponse, CoreError> {
        self.need_llm(run_id)
    }

    fn need_llm(&self, run_id: &str) -> Result<LoopResponse, CoreError> {
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
        // 折叠在**发出请求之前**做，且只动自己的账本：transcript 的写者只有这一处。
        fold_if_needed(state);
        // 注意：**不要**在这里写 `stream`。要不要流式是传输层的事（`DriveSpec.stream` →
        // `agent::llm::chat_completion` 统一注入请求体）；这里硬写 `stream: false` 会让端点
        // 改回非流式，而 D Y/XHX 这类中转在非流式口径下会**丢掉 tool_calls**
        // （2026-11-17 实测：整包回 `message` 里没有 tool_calls，表现为「模型什么都没说」）。
        let llm_body = json!({
            "model": state.model,
            "messages": state.messages,
            "tools": state.tools
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
            compacted: state.pending_fold.take(),
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
            compacted: None,
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

    /// 摘图只动账本里的图片：文字保留、没指到的消息不动、不带下标才全摘。
    ///
    /// 这条钉住「transcript 唯一写者」的边界：上游拒图时宿主只能请 core 摘，
    /// 不能自己覆盖 messages。
    #[tokio::test]
    async fn drop_images_only_strips_targeted_messages() {
        let mgr = AgentLoopManager::default();
        let img = |name: &str| {
            json!({
                "role": "user",
                "content": [
                    {"type": "text", "text": name},
                    {"type": "image_url", "image_url": {"url": "data:image/png;base64,AAAA"}}
                ]
            })
        };
        let start = mgr
            .start(StartParams {
                model: "m".into(),
                messages: vec![
                    img("first"),
                    img("second"),
                    json!({"role":"user","content":"plain"}),
                ],
                tools: vec![],
                workspace_root: None,
                max_tool_calls: 10,
                max_rounds: 10,
                token_budget: 0,
                trigger_ratio: 0.0,
                run_id: None,
            })
            .unwrap();

        let (dropped, messages) = mgr.drop_images(&start.run_id, Some(&[0])).unwrap();
        assert_eq!(dropped, 1);
        let first = messages[0]["content"].as_str().unwrap();
        assert!(first.contains("first"), "用户文字必须保留：{first}");
        assert!(first.contains("已摘除"), "图片应换成可读标记：{first}");
        assert_eq!(
            messages[1]["content"][1]["type"], "image_url",
            "没指到的消息不该被动"
        );

        let (dropped_all, messages_all) = mgr.drop_images(&start.run_id, None).unwrap();
        assert_eq!(dropped_all, 1, "只剩第二条还有图");
        assert_eq!(messages_all[2]["content"], "plain");
    }

    /// 折叠发生在**循环内部**：越线后返回的 `llm_body` 里 content 已经变短，而账本事实
    /// 随响应交给宿主（Node 只读事实、写遥测——不再自己折完再推回来）。
    #[tokio::test]
    async fn loop_folds_messages_before_next_llm_call() {
        let dir = tempdir().unwrap();
        let config = AppConfig::default();
        let index = IndexService::new(
            crate::codebase_db::handle(dir.path().join("idx.sqlite")),
            EmbeddingConfig::default(),
        );
        let mgr = AgentLoopManager::default();
        // 长度只够「折叠得动」（L1 阈值 1600 字符），但不够触发首轮估算越线。
        // 这样折叠只可能由服务端 usage 触发，正好验证「usage 优先」这条口径。
        let big = "x".repeat(2_000);
        let call = |id: &str| {
            json!({"role":"assistant","content":"","tool_calls":[{"id":id,"type":"function",
                   "function":{"name":"fs_read_file","arguments":"{\"filePath\":\"a.txt\"}"}}]})
        };
        let start = mgr
            .start(StartParams {
                model: "m".into(),
                messages: vec![
                    json!({"role":"user","content":"start"}),
                    call("c1"),
                    json!({"role":"tool","tool_call_id":"c1","content": big}),
                    json!({"role":"user","content":"go on"}),
                    call("c2"),
                    json!({"role":"tool","tool_call_id":"c2","content":"ok"}),
                    json!({"role":"user","content":"keep going"}),
                ],
                tools: vec![],
                workspace_root: None,
                max_tool_calls: 10,
                max_rounds: 10,
                token_budget: 4096,
                trigger_ratio: 0.8,
                run_id: None,
            })
            .unwrap();

        // 第 1 轮：模型要工具（服务端说这轮用了 5000 token，越过 4096*0.8）
        let delegated = mgr
            .continue_llm(
                &config,
                &index,
                &start.run_id,
                LlmResponseInput {
                    content: Some(String::new()),
                    tool_calls: vec![ToolCallInput {
                        id: "c3".into(),
                        name: "fs_read_file".into(),
                        arguments: json!({"filePath":"b.txt"}),
                    }],
                    usage: Some(json!({ "prompt_tokens": 5000 })),
                    ..Default::default()
                },
            )
            .unwrap();
        assert_eq!(delegated.phase, "need_delegate");

        // 第 2 轮之前：应当先折叠，再把（变短的）messages 交给宿主
        let next = mgr
            .submit_tool_results(
                &config,
                &index,
                &start.run_id,
                vec![ToolResultInput {
                    id: "c3".into(),
                    result: json!({"ok": true}),
                    error: None,
                }],
            )
            .unwrap();
        assert_eq!(next.phase, "need_llm");
        let fact = next.compacted.expect("越线时必须报折叠事实");
        assert_eq!(fact.trigger_source, "usage", "有 usage 就不该用字符比估值");
        assert!(fact.level >= 1);
        assert!(fact.folded_tool_results >= 1);

        let messages = next
            .llm_body
            .as_ref()
            .and_then(|b| b.get("messages"))
            .and_then(|m| m.as_array())
            .cloned()
            .expect("llm_body.messages");
        let folded_tool = messages
            .iter()
            .find(|m| m.get("tool_call_id").and_then(|v| v.as_str()) == Some("c1"))
            .expect("折叠不能删消息");
        assert!(
            folded_tool["content"].as_str().unwrap().len() < 2000,
            "旧工具结果应被就地截短"
        );
        let kept_call = messages
            .iter()
            .find(|m| {
                m.get("tool_calls")
                    .and_then(|t| t.as_array())
                    .map(|a| a.iter().any(|c| c["id"] == "c1"))
                    .unwrap_or(false)
            })
            .expect("assistant tool_calls 必须保留");
        assert_eq!(kept_call["tool_calls"][0]["function"]["name"], "fs_read_file");
        assert_eq!(messages.len(), 9, "折叠不新增/不删除消息（7 + assistant + tool 结果）");

        // 事实只交一次：下一轮没有新折叠就不能再报
        let again = mgr
            .continue_llm(
                &config,
                &index,
                &start.run_id,
                LlmResponseInput {
                    content: Some("done".into()),
                    ..Default::default()
                },
            )
            .unwrap();
        assert_eq!(again.phase, "done");
        assert!(again.compacted.is_none(), "没折叠就不该再报事实");
    }

    #[test]
    fn start_returns_need_llm() {
        let mgr = AgentLoopManager::default();
        let r = mgr
            .start(StartParams {
                model: "test-model".into(),
                messages: vec![json!({"role":"user","content":"hello"})],
                tools: vec![],
                workspace_root: None,
                max_tool_calls: 150,
                max_rounds: 96,
                token_budget: 0,
                trigger_ratio: 0.0,
                run_id: None,
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
        );
        let mgr = AgentLoopManager::default();
        let start = mgr
            .start(StartParams {
                model: "test-model".into(),
                messages: vec![json!({"role":"user","content":"inspect project"})],
                tools: vec![],
                workspace_root: None,
                max_tool_calls: 10,
                max_rounds: 10,
                token_budget: 0,
                trigger_ratio: 0.0,
                run_id: None,
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
        );
        let mgr = AgentLoopManager::default();
        let start = mgr
            .start(StartParams {
                model: "test-model".into(),
                messages: vec![json!({"role":"user","content":"summarize work"})],
                tools: vec![],
                workspace_root: None,
                max_tool_calls: 10,
                max_rounds: 10,
                token_budget: 0,
                trigger_ratio: 0.0,
                run_id: None,
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
        );
        let mgr = AgentLoopManager::default();
        let start = mgr
            .start(StartParams {
                model: "mimo-v2-flash".into(),
                messages: vec![json!({"role":"user","content":"改一处 bug"})],
                tools: vec![],
                workspace_root: None,
                max_tool_calls: 10,
                max_rounds: 10,
                token_budget: 0,
                trigger_ratio: 0.0,
                run_id: None,
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
                max_tool_calls: 10,
                max_rounds: 1,
                token_budget: 0,
                trigger_ratio: 0.0,
                run_id: None,
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
                max_tool_calls: 0,
                max_rounds: 10,
                token_budget: 0,
                trigger_ratio: 0.0,
                run_id: None,
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
        );
        let mgr = AgentLoopManager::default();
        let start = mgr
            .start(StartParams {
                model: "test-model".into(),
                messages: vec![json!({"role":"user","content":"run tools"})],
                tools: vec![],
                workspace_root: None,
                max_tool_calls: 0,
                max_rounds: 10,
                token_budget: 0,
                trigger_ratio: 0.0,
                run_id: None,
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
        );
        let mgr = AgentLoopManager::default();
        let start = mgr
            .start(StartParams {
                model: "test-model".into(),
                messages: vec![json!({"role":"user","content":"run tools"})],
                tools: vec![],
                workspace_root: None,
                max_tool_calls: 150,
                max_rounds: 10,
                token_budget: 0,
                trigger_ratio: 0.0,
                run_id: None,
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
        );
        let mgr = AgentLoopManager::default();
        let start = mgr
            .start(StartParams {
                model: "test-model".into(),
                messages: vec![json!({"role":"user","content":"run tools"})],
                tools: vec![],
                workspace_root: None,
                max_tool_calls: 10,
                max_rounds: 1,
                token_budget: 0,
                trigger_ratio: 0.0,
                run_id: None,
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

    #[tokio::test]
    async fn length_stop_does_not_delegate_truncated_tool_calls() {
        let dir = tempdir().unwrap();
        let config = AppConfig::default();
        let index = IndexService::new(
            crate::codebase_db::handle(dir.path().join("idx.sqlite")),
            EmbeddingConfig::default(),
        );
        let mgr = AgentLoopManager::default();
        let start = mgr
            .start(StartParams {
                model: "test-model".into(),
                messages: vec![json!({"role":"user","content":"edit"})],
                tools: vec![],
                workspace_root: None,
                max_tool_calls: 10,
                max_rounds: 10,
                token_budget: 0,
                trigger_ratio: 0.0,
                run_id: None,
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

mod fold;
mod delivery;
mod trace;
mod ledger;
use std::collections::HashMap;
use std::sync::atomic::AtomicU64;
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};

use dieyun_base::error::CoreError;
use serde_json::{json, Value};

/// 工具入参解析：模型可能吐半个 JSON（流被掐、网关截断、参数分片丢了尾巴）。
///
/// **不许**把解析失败降级成一个 `{"raw": …}` 交给宿主执行 —— 那会把一次协议错误变成
/// 一次真实的写盘 / 命令执行（工具看到的是「调用方给了一个叫 raw 的怪参数」）。
/// 失败就返回原因，由账本记成一条 `error` 的工具结果，让模型自己重发。
fn parse_tool_arguments(raw: &Value) -> Result<Value, String> {
    match raw {
        Value::String(s) => match serde_json::from_str::<Value>(s) {
            Ok(value) => Ok(value),
            Err(err) => Err(format!(
                "入参不是合法 JSON（可能被截断），未执行：{err}；原文前 120 字：{}",
                s.chars().take(120).collect::<String>()
            )),
        },
        // 上游已经给了对象/数组（部分兼容网关这么回）：原样用。
        other => Ok(other.clone()),
    }
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

/// 一次 run 的启动参数（宿主唯一入口：`rust-loop-runner.applyResolvedLoopSpec`）。
///
/// 护栏数字的唯一来源是 Node：`agent-limits.js` 解析、模型设置 `agentToolCallLimit`
/// （按 Context 档位存）/ `agentMaxRounds` 提供数值。**内核不留同名默认值** ——
/// 跨语言复制一个数字，改一边就静默分叉。
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
    /// 折叠前的本地估值（与 `tokens_after` 同口径；见 `compaction::FoldResult`）。
    pub tokens_before_estimated: usize,
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
    /// 本批工具交给宿主的那一刻（`need_delegate` 出发时打点，`agent.run.tools` 回来时算差）。
    /// core 不执行工具，但这段**墙钟**是「这一轮为什么慢」的一半答案。
    pending_since: Option<std::time::Instant>,
}

pub struct AgentLoopManager {
    /// runId → **每个 run 自己的一把锁**。
    ///
    /// 外层 map 锁只保护「哪个 run 在哪」，绝不保护 run 的内容：旧实现用一个全局
    /// `HashMap<String, RunState>`，于是 `need_llm` 里那段 O(n) 折叠（整份 messages 的
    /// 字符串处理）是在**全局锁**上做的 —— 一个 run 触发折叠，排在他后面的所有 run
    /// （并发 subagent、频道任务、planner worker 共用同一个 manager）全部卡住。
    ///
    /// 纪律：**永远先放 map 锁，再拿 run 锁**。任何路径都不许在持 map 锁时去拿 run 锁
    /// （锁序反转 = 死锁）；需要「从账本摘下并读内容」时，先在 map 锁下 `remove` 拿到句柄，
    /// 放锁之后再 `lock()` 读。
    runs: Arc<Mutex<HashMap<String, Arc<Mutex<RunState>>>>>,
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

/// 取 run 的句柄：只在 map 锁下克隆一次 `Arc`，随即放锁 —— run 的内容由它自己那把锁保护。
fn run_handle(runs: &Mutex<HashMap<String, Arc<Mutex<RunState>>>>, run_id: &str) -> Option<Arc<Mutex<RunState>>> {
    runs.lock().ok()?.get(run_id).cloned()
}

fn lock_run(handle: &Arc<Mutex<RunState>>) -> Result<std::sync::MutexGuard<'_, RunState>, CoreError> {
    handle
        .lock()
        .map_err(|_| CoreError::rpc("AGENT_BUSY", "agent lock poisoned"))
}

/// 取消的 run 在被**观察到**的那一刻就离开账本。
///
/// 为什么必须在这里删：`finish_run` 只在正常收尾时跑；「用户点停止」与「上游报错」
/// 两条路径都不会走到它。core 是长驻进程，聊天 / planner worker / 频道共用同一个
/// `AgentLoopManager`，不删就等于整段 transcript 永久驻留（真实会话可达数 MB），
/// 而且该 runId 之后每次操作都只会回「已取消」而不会回「不存在」。
///
/// 两次取锁（先 run 后 map）而不是嵌套：judge 在 run 锁下，摘除在 map 锁下，中间放锁。
fn take_if_cancelled(runs: &Mutex<HashMap<String, Arc<Mutex<RunState>>>>, run_id: &str) -> bool {
    let Some(handle) = run_handle(runs, run_id) else {
        return false;
    };
    let cancelled = handle.lock().map(|s| s.cancelled).unwrap_or(true);
    if !cancelled {
        return false;
    }
    // 摘除前再确认一次：这个 runId 可能刚被复用（同一 id 重新 start），别把新 run 摘掉。
    let mut map = match runs.lock() {
        Ok(m) => m,
        Err(poisoned) => poisoned.into_inner(),
    };
    match map.get(run_id) {
        Some(current) if Arc::ptr_eq(current, &handle) => {
            let still_cancelled = current.lock().map(|s| s.cancelled).unwrap_or(true);
            if still_cancelled {
                map.remove(run_id);
                true
            } else {
                false
            }
        }
        _ => false,
    }
}

impl AgentLoopManager {
    /// 取某个 run 的句柄（map 锁只在这几行里持有）。测试用它把 run 的账本状态摆到指定位置，
    /// 也用它验证「一个 run 的锁不挡别的 run」。生产路径直接用自由函数 `run_handle()`。
    #[cfg(test)]
    fn run_handle(&self, run_id: &str) -> Option<Arc<Mutex<RunState>>> {
        run_handle(&self.runs, run_id)
    }
}

#[cfg(test)]
#[path = "tests.rs"]
mod tests;

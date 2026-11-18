mod fold;
mod delivery;
mod trace;
mod ledger;
use std::collections::HashMap;
use std::sync::atomic::AtomicU64;
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};

use crate::error::CoreError;
use serde_json::{json, Value};

/// 护栏数字的唯一来源是 Node：`agent-limits.js` 解析、模型设置 `agentToolCallLimit`
/// （按 Context 档位存）/ `agentMaxRounds` 提供数值，
/// 由 `rust-loop-runner.applyResolvedLoopSpec` 在唯一入口填进 `StartParams`。
/// 内核**不留**同名默认值：跨语言复制一个数字，改一边就静默分叉。


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
mod tests {
    use super::delivery::delivered_content;
    use super::*;
    use crate::config::AppConfig;
    use crate::error::CoreError;
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

    /// 回归（P4.1）：一个 run 的锁不许卡住别的 run。
    ///
    /// 旧实现是**一个全局** `HashMap<String, RunState>`，而 `need_llm` 里那段 O(n) 折叠
    /// （整份 messages 的字符串处理）就在这把全局锁上跑 —— 一个 run 折叠时，排在他后面的
    /// run（并发 subagent、频道任务、planner worker 共用同一个 manager）全部等锁，表现为
    /// 「所有会话同时卡住一下」。
    ///
    /// 现在每个 run 一把锁，map 锁只在「取句柄」那几行里持有。断言方式是**计时**而不是等锁：
    /// 另一个线程把 A 的 run 锁握 300ms，主线程做 B 的账本操作必须远早于它返回。
    #[test]
    fn one_runs_lock_does_not_block_other_runs() {
        let mgr = AgentLoopManager::default();
        let params = |text: &str| StartParams {
            model: "test-model".into(),
            messages: vec![json!({"role": "user", "content": text})],
            tools: vec![],
            workspace_root: None,
            max_tool_calls: 150,
            max_rounds: 96,
            token_budget: 0,
            trigger_ratio: 0.0,
            run_id: None,
        };
        let a = mgr.start(params("run a")).unwrap();
        let b = mgr.start(params("run b")).unwrap();

        let handle_a = mgr.run_handle(&a.run_id).expect("run a live");
        std::thread::scope(|s| {
            s.spawn(|| {
                // 模拟「run A 正在折叠」：把 A 的 run 锁握 300ms（有界，不会把测试挂死）
                let _guard = handle_a.lock().unwrap();
                std::thread::sleep(std::time::Duration::from_millis(300));
            });
            std::thread::sleep(std::time::Duration::from_millis(50)); // 让上面先拿到锁
            let started = std::time::Instant::now();
            let round = mgr.round_of(&b.run_id);
            let waited = started.elapsed();
            assert_eq!(round, Some(0));
            assert!(
                waited < std::time::Duration::from_millis(150),
                "B 的账本操作被 A 的锁挡了 {waited:?} —— per-run 锁可能被改回了一把全局锁"
            );
        });
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
            // guard 借的是那个 Arc：先把句柄绑出来，别在临时值上 lock。
            let handle = mgr.run_handle(&start.run_id).expect("run still live");
            let mut state = handle.lock().unwrap();
            state.round = 1;
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

    /// 单通道模型（思考放在 `content` 键）撞上限时：**提示文本**可以落账本，**思考不行**。
    ///
    /// 钉住「思考永不顶正文」的第四条终态路径：上限分支曾经绕过 `delivered_content()`，
    /// 把 `content` 原文既写成 assistant 正文（下一轮再作为「我上一轮的回复」回灌模型），
    /// 又当成 `visibleContent` 显示成旁白。
    #[tokio::test]
    async fn single_channel_limit_never_stores_reasoning_as_answer() {
        let dir = tempdir().unwrap();
        let config = AppConfig::default();
        let index = IndexService::new(
            crate::codebase_db::handle(dir.path().join("idx.sqlite")),
            EmbeddingConfig::default(),
        );
        let reasoning = "我在查 loop_run.rs 的四条终态路径，先把正文口径统一。";
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
            // guard 借的是那个 Arc：先把句柄绑出来，别在临时值上 lock。
            let handle = mgr.run_handle(&start.run_id).expect("run still live");
            let mut state = handle.lock().unwrap();
            state.round = 1;
        }
        let done = mgr
            .continue_llm(
                &config,
                &index,
                &start.run_id,
                LlmResponseInput {
                    content: Some(reasoning.into()),
                    reasoning: None,
                    content_channel: ContentChannel::Reasoning,
                    tool_calls: vec![ToolCallInput {
                        id: "tc1".into(),
                        name: "read_file".into(),
                        arguments: json!({"path":"a.txt"}),
                    }],
                    ..Default::default()
                },
            )
            .unwrap();
        assert_eq!(done.hit_round_limit, Some(true));
        assert_eq!(done.content, None, "思考通道不是正文");
        let last = done.trace.as_ref().and_then(|t| t.last()).expect("round");
        let visible = last.visible_content.clone().unwrap_or_default();
        assert!(visible.contains("已达本段"), "上限提示要落账本：{visible}");
        assert!(
            !visible.contains("四条终态路径"),
            "思考不得成为可见正文：{visible}"
        );
        assert_eq!(
            last.full_thought.as_deref(),
            Some(reasoning),
            "思考仍要留档（只进 full_thought）"
        );
        let messages = done.messages.expect("收尾要回传 messages");
        let text = messages
            .last()
            .and_then(|m| m.get("content"))
            .and_then(|v| v.as_str())
            .unwrap_or("");
        assert!(text.contains("已达本段"), "落库的应是平台提示：{text}");
        assert!(
            !text.contains("四条终态路径"),
            "思考不得写进 assistant 正文：{text}"
        );
    }

    /// 取消必须做到两件事：**返回真实 bool**、**把 run 从账本里带走**。
    ///
    /// 钉住长驻进程的泄漏：`finish_run` 只在正常收尾时跑，「点停止」与「上游报错」都不经过
    /// 它 —— 旧实现因此让整段 transcript 永久留在 `runs` 里，且该 runId 之后每次操作都回
    /// 「已取消」（取消信号本身也因此无法被观测）。
    #[tokio::test]
    async fn cancel_reports_truth_and_drops_the_run() {
        let mgr = AgentLoopManager::default();
        let start = mgr
            .start(StartParams {
                model: "test-model".into(),
                messages: vec![json!({"role":"user","content":"hi"})],
                tools: vec![],
                workspace_root: None,
                max_tool_calls: 10,
                max_rounds: 10,
                token_budget: 0,
                trigger_ratio: 0.0,
                run_id: None,
            })
            .unwrap();
        assert!(mgr.cancel(&start.run_id).unwrap(), "第一次要报真");
        match mgr.next_body(&start.run_id) {
            Err(CoreError::Rpc { code, .. }) => {
                assert_eq!(code, "AGENT_CANCELLED", "在途路径下一次观察就收手")
            }
            other => panic!("应回 AGENT_CANCELLED，实际 {other:?}"),
        }
        assert!(
            mgr.round_of(&start.run_id).is_none(),
            "取消的 run 必须离开账本"
        );
        assert!(
            !mgr.cancel(&start.run_id).unwrap(),
            "已不在账本：不得再报「已取消」"
        );
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

        let handle = mgr.run_handle(&start.run_id).expect("run still live");
        let state = handle.lock().unwrap();
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
            if let Some(handle) = mgr.run_handle(&start.run_id) {
                let mut state = handle.lock().unwrap();
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

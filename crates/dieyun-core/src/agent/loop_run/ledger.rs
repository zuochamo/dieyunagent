//! 账本推进：轮次 / 工具计数 / 待执行工具 / 取消与生命周期。
//!
//! 从 `agent/loop_run.rs` 机械搬来（纯移动）。**纯内存、无 IO**：本层不做任何 `.await`，
//! LLM 调用由 `agent/driver.rs` 驱动。**transcript 的唯一写者**也在这里（`messages` 只由
//! `continue_llm` / `submit_tool_results` 改）。

use std::collections::HashMap;
use std::sync::atomic::Ordering;

use serde_json::{json, Value};

use super::delivery::{
    delivered_content, is_length_stop, llm_thought_raw, push_assistant_text_only,
    TRUNCATED_TOOL_ERROR,
};
use super::fold::{fold_force, fold_if_needed};
use super::{
    parse_tool_arguments, strip_inline_images_from_messages, take_if_cancelled, AgentLoopManager,
    ContentChannel, ContentSource, DelegateTool, FoldFact, LlmResponseInput, LoopResponse, RunState,
    StartParams, ToolResultInput, TraceRound, TraceTool,
};
use crate::config::AppConfig;
use crate::error::CoreError;
use crate::index::IndexService;

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
        if take_if_cancelled(&mut runs, run_id) {
            return Err(CoreError::rpc("AGENT_CANCELLED", "run 已取消"));
        }
        let state = runs
            .get_mut(run_id)
            .ok_or_else(|| CoreError::rpc("AGENT_RUN_NOT_FOUND", "run 不存在或已结束"))?;
        if force {
            fold_force(state);
        } else {
            fold_if_needed(state);
        }
        Ok(state.pending_fold.take())
    }


    /// 取消一个 run：置位让在途路径在下一次账本操作时收手，并**立刻释放**大字段。
    ///
    /// 返回「是否真的找到并取消了」。旧实现恒返回 `Ok(())`，于是 `rpc.cancel` 的
    /// `agentCancelled` 永远是 true —— 取消信号本身无法被观测（传错 runId、run 已结束、
    /// core 刚重启，全都报「已取消」）。
    pub fn cancel(&self, run_id: &str) -> Result<bool, CoreError> {
        let mut runs = self
            .runs
            .lock()
            .map_err(|_| CoreError::rpc("AGENT_BUSY", "agent lock poisoned"))?;
        let Some(state) = runs.get_mut(run_id) else {
            return Ok(false);
        };
        state.cancelled = true;
        // 取消后账本只剩「这个 run 已被取消」一个事实：transcript / 工具表 / 待执行工具
        // 都没有读者了（交付文本在取消那一刻之前已经交给宿主）。留着它们 = 长驻进程里
        // 的永久内存。run 本身由 `take_if_cancelled` 在下一次观察时移除。
        state.messages = Vec::new();
        state.tools = Vec::new();
        state.pending_delegate.clear();
        Ok(true)
    }


    /// 把 run 从账本里移除。正常收尾由 `finish_run` 负责，其余出口（出错 / 取消）
    /// 由本函数兜底 —— 驱动器用 guard 在两条出口都调它。
    pub fn discard(&self, run_id: &str) {
        if let Ok(mut runs) = self.runs.lock() {
            runs.remove(run_id);
        }
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
            // 正文口径只有 `delivered_content()` 一处：思考通道在这里必须是 None，
            // 否则思考会被写成 assistant 正文（下一轮再作为「我上一轮的回复」回灌模型）。
            let synthetic_text = push_assistant_text_only(
                &mut state.messages,
                delivered_content(llm.content.as_deref(), channel).as_deref(),
                &hint,
            );
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
                // 与轮次上限同一口径：思考通道的 content 不得落成 assistant 正文。
                let synthetic_text = push_assistant_text_only(
                    &mut state.messages,
                    delivered_content(llm.content.as_deref(), channel).as_deref(),
                    &hint,
                );
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


    pub(crate) fn need_llm(&self, run_id: &str) -> Result<LoopResponse, CoreError> {
        let mut runs = self
            .runs
            .lock()
            .map_err(|_| CoreError::rpc("AGENT_BUSY", "agent lock poisoned"))?;
        if take_if_cancelled(&mut runs, run_id) {
            return Err(CoreError::rpc("AGENT_CANCELLED", "run 已取消"));
        }
        let state = runs
            .get_mut(run_id)
            .ok_or_else(|| CoreError::rpc("AGENT_RUN_NOT_FOUND", "run 不存在或已结束"))?;
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


}

//! 轮次驱动器：把 `while (phase !== 'done')` 从宿主搬进 core。
//!
//! 与 `loop_run`（纯内存账本）的分工：
//! - `loop_run::AgentLoopManager` 只管账本事实（轮次、工具计数、trace、交付正文），**不做 IO**；
//! - 这个模块是唯一把「账本推进」与「LLM 调用」串成循环的地方。
//!
//! 驱动到什么时候停：
//! - 账本说 `done`（正常收尾 / 命中上限）→ 返回 [`DriveStop::Done`]；
//! - 账本说 `need_delegate` → 返回 [`DriveStop::NeedTools`]，**工具由宿主执行**（平台能力在 Node），
//!   宿主把结果交回 `submit_tool_results` 后再调一次本函数继续。
//!
//! 为什么工具不在这里执行：工具是宿主能力的入口（Playwright / ssh2 / koffi / MCP），
//! core 里没有也不该有。这也是为什么 `agent.run` 不是一条长 RPC，而是「跑到要工具就返回」。

use super::llm::{self, Delta, Outcome};
use super::outbound;
use crate::agent::loop_run::{
    AgentLoopManager, ContentChannel, DelegateTool, LlmResponseInput, LoopResponse, ToolCallInput,
};
use dieyun_base::config::LlmConfig;
use dieyun_base::error::CoreError;

/// 一次驱动停在哪里。
#[derive(Debug)]
pub enum DriveStop {
    /// 需要宿主执行这些工具；拿到结果后调 [`drive`] 继续（内部会先 `submit_tool_results`）。
    NeedTools { response: LoopResponse, delegates: Vec<DelegateTool> },
    /// 本轮结束。
    Done(LoopResponse),
}

impl DriveStop {
    pub fn phase(&self) -> &str {
        match self {
            DriveStop::NeedTools { .. } => "need_tools",
            DriveStop::Done(response) => response.phase.as_str(),
        }
    }
}

/// 驱动参数（数值全部来自宿主，内核不留默认值）。
#[derive(Debug, Clone)]
pub struct DriveSpec {
    pub url: String,
    pub stream: bool,
    /// 单通道模型入口盖章：`content` 键装的是思考时传 `Reasoning`。
    pub content_channel: ContentChannel,
    /// 抓包原文（`DIEYUN_LLM_RAW_LOG`）：由宿主决定要不要，内核只负责如实回传。
    pub include_raw: bool,
    /// 能力表声明：这个模型**脱了工具也要求**回传思考（`echoReasoning`）。
    /// 出站投影据此决定要不要给 assistant 消息补 `reasoning_content`。
    pub echo_reasoning: bool,
}

/// run 生命周期的唯一收尾点：驱动器的**两条出口**（Ok / Err）都要把账本里的 run 删掉。
///
/// 为什么用 guard 而不是「在每个 return 前调一次 discard」：`?` 会静默绕过手写调用 ——
/// 那正是「上游 4xx / 超时之后 run 永远留在账本里」的成因（长驻 core 里等于整段
/// transcript 永久驻留）。
///
/// 唯一的例外是 `need_delegate`：账本要留着等宿主把工具结果交回来，此时先 `keep()`。
struct RunLifetime<'a> {
    manager: &'a AgentLoopManager,
    run_id: String,
    handed_back: bool,
}

impl<'a> RunLifetime<'a> {
    fn new(manager: &'a AgentLoopManager, run_id: &str) -> Self {
        Self {
            manager,
            run_id: run_id.to_string(),
            handed_back: false,
        }
    }

    /// 交回宿主继续驱动（`need_delegate`）：账本必须留着。
    fn keep(&mut self) {
        self.handed_back = true;
    }
}

impl Drop for RunLifetime<'_> {
    fn drop(&mut self) {
        if !self.handed_back {
            self.manager.discard(&self.run_id);
        }
    }
}

/// 收到工具结果之后继续驱动。
///
/// `results` 为空表示「没有待执行工具」，等价于直接推进到下一次 LLM 调用。
pub async fn drive_with_results(
    manager: &AgentLoopManager,
    cfg: &dieyun_base::config::AppConfig,
    index: &dieyun_codebase::index::IndexService,
    run_id: &str,
    results: Vec<crate::agent::ToolResultInput>,
    spec: &DriveSpec,
    llm_cfg: &LlmConfig,
    on_delta: &(dyn Fn(&Delta) + Sync),
) -> Result<DriveStop, CoreError> {
    let mut lifetime = RunLifetime::new(manager, run_id);
    let first = manager.submit_tool_results(cfg, index, run_id, results)?;
    lifetime.keep();
    drive(manager, cfg, index, run_id, first, spec, llm_cfg, on_delta).await
}

/// 驱动循环：账本要什么就发什么，直到要工具或结束。
pub async fn drive(
    manager: &AgentLoopManager,
    cfg: &dieyun_base::config::AppConfig,
    index: &dieyun_codebase::index::IndexService,
    run_id: &str,
    mut response: LoopResponse,
    spec: &DriveSpec,
    llm_cfg: &LlmConfig,
    on_delta: &(dyn Fn(&Delta) + Sync),
) -> Result<DriveStop, CoreError> {
    // 自愈各一次：溢出折叠、拒图摘图。都用「本轮已试过」的标记，不是无限重试。
    let mut overflow_retried = false;
    let mut image_retried = false;
    let mut lifetime = RunLifetime::new(manager, run_id);
    loop {
        match response.phase.as_str() {
            "need_delegate" => {
                let delegates = response.delegates.clone().unwrap_or_default();
                // 工具在宿主执行：账本要留到 `agent.run.tools` 把结果交回来。
                lifetime.keep();
                return Ok(DriveStop::NeedTools { response, delegates });
            }
            "done" => return Ok(DriveStop::Done(response)),
            "need_llm" => {}
            other => {
                return Err(CoreError::rpc(
                    "AGENT_LOOP",
                    format!("账本给出了未知阶段：{other}"),
                ))
            }
        }

        let mut body = response
            .llm_body
            .clone()
            .ok_or_else(|| CoreError::rpc("AGENT_LOOP", "need_llm 阶段缺少 llm_body"))?;

        // 宿主没了（stdout 写失败）就收手：再发一次请求只会白烧 token，
        // 结果也永远送不出去。这一条以前不存在 —— 宿主崩了之后 core 仍跑完整条 run。
        if !crate::rpc::stdio::stdout_alive() {
            return Err(CoreError::rpc(
                "OUTPUT_CLOSED",
                "标准输出已断（宿主进程已退出），停止本次 run",
            ));
        }

        // 逐轮请求准备（视觉注入 / 附件补看图 / 请求级裁剪）的唯一入口：
        // 每发一次请求前问宿主「这一次的 messages 该长什么样」，宿主回一份**请求用副本**。
        // 账本（transcript）仍归 core —— 宿主只交出副本，不回写（docs/AGENT-RUN-MIGRATION.md §5）。
        //
        // 只在有宿主通道时才问：单测 / 一次性命令没有宿主，问了只能等到超时。
        // 失败一律 fail-open：注入失败是一张图的事，不该让整轮对话失败。
        if crate::rpc::events::enabled() {
            let prepared = crate::rpc::calls::call_host(
                "round.prepare",
                serde_json::json!({
                    "runId": run_id,
                    "round": manager.round_of(run_id),
                    "messages": body.get("messages").cloned().unwrap_or(serde_json::Value::Null),
                }),
            )
            .await;
            match prepared {
                Ok(value) => {
                    if let Some(msgs) = value.get("messages").filter(|m| m.is_array()) {
                        body["messages"] = msgs.clone();
                    }
                }
                Err(err) => eprintln!("[round.prepare] 本轮跳过请求准备：{err}"),
            }
        }

        // 出站投影的**唯一**调用点：宿主交回请求用副本之后（视觉注入 / 附件补图 / 裁剪都在那份
        // 副本里完成），这里把账本事实长成上游协议形状。放在 `round.prepare` 之前就等于让
        // 「思考回传」有两个作者 —— R2 之前 Node 的 `round.prepare` 就在干这件事。
        {
            let has_tools = matches!(body.get("tools"), Some(serde_json::Value::Array(t)) if !t.is_empty());
            let spec = outbound::OutboundSpec::new(spec.stream, spec.echo_reasoning, has_tools);
            outbound::project_body(&mut body, spec);
        }

        let outcome = match llm::chat_completion(
            llm_cfg,
            &spec.url,
            &llm_cfg.headers.clone(),
            body,
            spec.stream,
            spec.include_raw,
            |delta| on_delta(delta),
        )
        .await
        {
            Ok(outcome) => outcome,
            Err(err) => {
                // 两条**自愈**路径，各只试一次（试第二次仍失败就是真失败，不再空转）：
                //  · 上下文溢出 → 强制折一次（估算已经不准了，不能再等触发线）
                //  · 图片被上游拒 → 摘掉账本里的图，再发一次「无图」请求
                // 以前这两件事在 Node 的循环里做，还要把 messages 推回内核；现在内核自己就能做。
                let text = err.to_string();
                if !overflow_retried && looks_like_context_overflow(&text) {
                    overflow_retried = true;
                    // 只有**真的折了东西**才重发：`fold_now` 返回 `Ok(None)` 表示没有可折的内容
                    // （预算为 0 / 没到可折档位 / 尾巴全是锚点）。以前这里只接 `?`（Err）就重发，
                    // 于是「折不动」也照发一次 —— 原样再失败一次，白花一次 token 与等待。
                    if manager.fold_now(run_id, true)?.is_some() {
                        eprintln!("[agent.run] 上下文溢出：强制折叠后重发一次");
                        response = manager.next_body(run_id)?;
                        continue;
                    }
                    eprintln!("[agent.run] 上下文溢出但无可折内容：不再重发");
                    return Err(err);
                }
                if !image_retried && looks_like_image_reject(&text) {
                    image_retried = true;
                    let (dropped, _) = manager.drop_images(run_id, None)?;
                    if dropped == 0 {
                        // 账本里本来就没有图：说明是请求级注入的图，交给下一轮 round.prepare 不再注入
                        eprintln!("[agent.run] 上游拒图，但账本里没有可摘的图（本轮放弃注入）");
                    } else {
                        eprintln!("[agent.run] 上游拒图：摘掉 {dropped} 张后重发一次");
                    }
                    response = manager.next_body(run_id)?;
                    continue;
                }
                return Err(err);
            }
        };
        // usage 作为**事件**回流：`LoopResponse` 是账本事实（不带供应商口径），而成本统计
        // 只关心「这一轮花了多少」，走事件比塞进账本更合适，也免得每个响应形状都多一个字段。
        if let Some(usage) = outcome.usage.clone() {
            crate::rpc::events::emit(
                "agent.usage",
                serde_json::json!({
                    "runId": run_id,
                    "usage": usage,
                    "model": outcome.model,
                }),
            );
        }
        response = manager.continue_llm(cfg, index, run_id, to_input(outcome, spec.content_channel))?;
    }
}

/// 上游「上下文太长」的常见措辞（各供应商不一致，只能按文本认）。
///
/// 为什么不按 HTTP 状态码判：同一个 400 既可能是「太长」也可能是「图片不支持」，
/// 状态码分辨不了；而这两种情况的处置完全不同（折叠 vs 摘图）。
fn looks_like_context_overflow(text: &str) -> bool {
    let t = text.to_ascii_lowercase();
    // 词表唯一来源：`src/agent/agent-shared.json` 的 `contextOverflowPatterns`
    // （Node 侧 `llm-reconnect-retry.js:isContextOverflowError` 读同一份）。
    // 两份词表曾经漂移：措辞落在 Node 清单里时，内核连折都没折就把这一轮判成失败，
    // 而 Node 又把 core 的硬失败降级成「正常完成」—— 用户看到的是一次空轮。
    dieyun_base::shared::shared()
        .context_overflow_patterns
        .iter()
        .any(|pattern| t.contains(pattern.as_str()))
}

/// 上游「这张图不支持」的常见措辞。
fn looks_like_image_reject(text: &str) -> bool {
    let t = text.to_ascii_lowercase();
    (t.contains("image") || t.contains("vision"))
        && (t.contains("unsupported")
            || t.contains("invalid")
            || t.contains("not supported")
            || t.contains("upload"))
}

/// `llm::Outcome` → 账本入参。参数统一序列化成字符串：账本不解析工具参数，只搬运。
fn to_input(outcome: Outcome, content_channel: ContentChannel) -> LlmResponseInput {
    LlmResponseInput {
        content: Some(outcome.content),
        reasoning: outcome.reasoning,
        tool_calls: outcome
            .tool_calls
            .into_iter()
            .map(|call| ToolCallInput {
                id: call.id,
                name: call.name,
                arguments: serde_json::Value::String(call.arguments),
            })
            .collect(),
        finish_reason: outcome.finish_reason,
        content_channel,
        usage: outcome.usage,
    }
}

#[cfg(test)]
#[path = "driver_tests.rs"]
mod tests;

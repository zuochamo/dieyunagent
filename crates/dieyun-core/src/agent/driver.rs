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

use crate::agent::llm::{self, Delta, Outcome};
use crate::agent::loop_run::{
    AgentLoopManager, ContentChannel, DelegateTool, LlmResponseInput, LoopResponse, ToolCallInput,
};
use crate::config::LlmConfig;
use crate::error::CoreError;

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
}

/// 收到工具结果之后继续驱动。
///
/// `results` 为空表示「没有待执行工具」，等价于直接推进到下一次 LLM 调用。
pub async fn drive_with_results(
    manager: &AgentLoopManager,
    cfg: &crate::config::AppConfig,
    index: &crate::index::IndexService,
    run_id: &str,
    results: Vec<crate::agent::ToolResultInput>,
    spec: &DriveSpec,
    llm_cfg: &LlmConfig,
    on_delta: &(dyn Fn(&Delta) + Sync),
) -> Result<DriveStop, CoreError> {
    let first = manager.submit_tool_results(cfg, index, run_id, results)?;
    drive(manager, cfg, index, run_id, first, spec, llm_cfg, on_delta).await
}

/// 驱动循环：账本要什么就发什么，直到要工具或结束。
pub async fn drive(
    manager: &AgentLoopManager,
    cfg: &crate::config::AppConfig,
    index: &crate::index::IndexService,
    run_id: &str,
    mut response: LoopResponse,
    spec: &DriveSpec,
    llm_cfg: &LlmConfig,
    on_delta: &(dyn Fn(&Delta) + Sync),
) -> Result<DriveStop, CoreError> {
    // 自愈各一次：溢出折叠、拒图摘图。都用「本轮已试过」的标记，不是无限重试。
    let mut overflow_retried = false;
    let mut image_retried = false;
    loop {
        match response.phase.as_str() {
            "need_delegate" => {
                let delegates = response.delegates.clone().unwrap_or_default();
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
                    manager.fold_now(run_id, true)?;
                    eprintln!("[agent.run] 上下文溢出：强制折叠后重发一次");
                    response = manager.next_body(run_id)?;
                    continue;
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
    t.contains("context length")
        || t.contains("context_length")
        || t.contains("prompt is too long")
        || t.contains("too many tokens")
        || t.contains("maximum context")
        || t.contains("reduce the length")
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
mod tests {
    use super::*;
    use crate::config::AppConfig;
    use crate::embedding::EmbeddingConfig;
    use serde_json::json;

    fn spec_for(addr: std::net::SocketAddr) -> DriveSpec {
        DriveSpec {
            url: format!("http://{addr}/v1/chat/completions"),
            stream: true,
            content_channel: ContentChannel::Answer,
            include_raw: false,
        }
    }

    fn services(dir: &std::path::Path) -> (AppConfig, crate::index::IndexService) {
        let cfg = AppConfig::default();
        let index = crate::index::IndexService::new(
            crate::codebase_db::handle(dir.join("idx.sqlite")),
            EmbeddingConfig::default(),
        );
        (cfg, index)
    }

    /// 起一个只回一次的服务端，返回 (监听地址, 后台任务)。
    fn one_shot_server(body: &'static str) -> std::net::SocketAddr {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
        let addr = listener.local_addr().expect("addr");
        std::thread::spawn(move || {
            if let Ok((mut socket, _)) = listener.accept() {
                let mut buf = [0u8; 4096];
                let _ = std::io::Read::read(&mut socket, &mut buf);
                let head = format!(
                    "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\nconnection: close\r\ncontent-length: {}\r\n\r\n{}",
                    body.len(),
                    body
                );
                use std::io::Write;
                let _ = socket.write_all(head.as_bytes());
                let _ = socket.flush();
            }
        });
        addr
    }

    /// 宿主回的「请求用 messages」里塞的标记：断言它出现在**上游真的收到的**请求里。
    const INJECTED_MARKER: &str = "VISION-INJECTED";

    /// 假宿主：装一个 `events` sink，并按 `round.prepare` 的约定答复（`calls::resolve_reply`）。
    ///
    /// 为什么是进程级一次性：`events::SINK` 是 `OnceLock`（一个进程只有一个宿主），
    /// 所以答复线程也得跑在进程级，且**所有**反向调用都要回话 —— 否则同进程里别的
    /// 用例会踩上「通道在、没人回」，白等 30s。
    fn install_fake_host() {
        static HOST: std::sync::Once = std::sync::Once::new();
        HOST.call_once(|| {
            let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<serde_json::Value>();
            std::thread::spawn(move || {
                let rt = tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                    .expect("host runtime");
                rt.block_on(async move {
                    while let Some(event) = rx.recv().await {
                        if event.get("type").and_then(|t| t.as_str()) != Some("host.call") {
                            continue;
                        }
                        let Some(id) = event.get("id").and_then(|v| v.as_u64()) else {
                            continue;
                        };
                        let params = event.get("params").cloned().unwrap_or(serde_json::Value::Null);
                        let (result, error) = fake_host_reply(&params);
                        crate::rpc::calls::resolve_reply(id, result, error);
                    }
                });
            });
            crate::rpc::events::install(tx);
        });
    }

    /// `round.prepare` 的假答复：正常 run 追加一条带标记的 user 消息；`fail-*` 的 run 报错。
    fn fake_host_reply(
        params: &serde_json::Value,
    ) -> (Option<serde_json::Value>, Option<serde_json::Value>) {
        let run_id = params
            .get("runId")
            .and_then(|v| v.as_str())
            .unwrap_or_default();
        if run_id.starts_with("fail-") {
            return (
                None,
                Some(json!({"code": "HOST_BOOM", "message": "宿主炸了"})),
            );
        }
        let mut messages = params
            .get("messages")
            .cloned()
            .filter(|m| m.is_array())
            .unwrap_or_else(|| json!([]));
        if let Some(list) = messages.as_array_mut() {
            list.push(json!({"role": "user", "content": INJECTED_MARKER}));
        }
        (
            Some(json!({"messages": messages, "visionInjected": 1})),
            None,
        )
    }

    fn find_subsequence(haystack: &[u8], needle: &[u8]) -> Option<usize> {
        haystack
            .windows(needle.len())
            .position(|window| window == needle)
    }

    /// 起一个只回一次的服务端，并把**收到的原始请求**（头 + 体）留下。
    fn recording_server(
        sse: &'static str,
    ) -> (
        std::net::SocketAddr,
        std::sync::Arc<std::sync::Mutex<String>>,
    ) {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
        let addr = listener.local_addr().expect("addr");
        let captured = std::sync::Arc::new(std::sync::Mutex::new(String::new()));
        let sink = std::sync::Arc::clone(&captured);
        std::thread::spawn(move || {
            let Ok((mut socket, _)) = listener.accept() else {
                return;
            };
            let _ = socket.set_read_timeout(Some(std::time::Duration::from_millis(500)));
            let mut buf: Vec<u8> = Vec::new();
            let mut chunk = [0u8; 4096];
            let mut header_end = None;
            while header_end.is_none() {
                match socket.read(&mut chunk) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        buf.extend_from_slice(&chunk[..n]);
                        header_end = find_subsequence(&buf, b"\r\n\r\n").map(|p| p + 4);
                    }
                }
            }
            // 按 content-length 把 body 读全（读不到就靠上面的读超时收手）
            if let Some(hend) = header_end {
                let head = String::from_utf8_lossy(&buf[..hend]).to_ascii_lowercase();
                let want = head
                    .lines()
                    .find_map(|line| line.strip_prefix("content-length:"))
                    .and_then(|v| v.trim().parse::<usize>().ok())
                    .unwrap_or(0);
                while buf.len() < hend + want {
                    match socket.read(&mut chunk) {
                        Ok(0) | Err(_) => break,
                        Ok(n) => buf.extend_from_slice(&chunk[..n]),
                    }
                }
            }
            if let Ok(mut guard) = sink.lock() {
                *guard = String::from_utf8_lossy(&buf).to_string();
            }
            let head = format!(
                "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\nconnection: close\r\ncontent-length: {}\r\n\r\n{}",
                sse.len(),
                sse
            );
            let _ = socket.write_all(head.as_bytes());
            let _ = socket.flush();
        });
        (addr, captured)
    }

    fn start_params(run_id: Option<&str>, messages: Vec<serde_json::Value>) -> crate::agent::StartParams {
        crate::agent::StartParams {
            model: "m".into(),
            messages,
            tools: vec![],
            workspace_root: None,
            max_tool_calls: 5,
            max_rounds: 5,
            token_budget: 0,
            trigger_ratio: 0.0,
            run_id: run_id.map(|s| s.to_string()),
        }
    }

    /// `round.prepare` 的回包必须真的替换掉**发往上游**的那份 messages。
    #[tokio::test]
    async fn round_prepare_rewrites_messages_sent_upstream() {
        install_fake_host();
        let dir = tempfile::tempdir().unwrap();
        let (cfg, index) = services(dir.path());
        let (addr, captured) = recording_server(
            "data: {\"choices\":[{\"delta\":{\"content\":\"hello\"}}]}\n\ndata: [DONE]\n\n",
        );
        let manager = AgentLoopManager::default();
        let start = manager
            .start(start_params(
                Some("run-prepare-1"),
                vec![json!({"role":"user","content":"hi"})],
            ))
            .expect("start");
        let run_id = start.run_id.clone();

        let stop = drive(
            &manager,
            &cfg,
            &index,
            &run_id,
            start,
            &spec_for(addr),
            &LlmConfig::default(),
            &|_delta| {},
        )
        .await
        .expect("drive");

        assert!(matches!(stop, DriveStop::Done(_)), "注入不该改变收场");
        let request = captured.lock().unwrap().clone();
        let body = request
            .split_once("\r\n\r\n")
            .map(|(_, b)| b.to_string())
            .unwrap_or_default();
        let sent: serde_json::Value = serde_json::from_str(&body).expect("请求体是 JSON");
        let messages = sent["messages"].as_array().expect("messages");
        assert!(
            messages
                .iter()
                .any(|m| m.get("content").and_then(|c| c.as_str()) == Some(INJECTED_MARKER)),
            "注入的 messages 必须真的发给上游：{}",
            sent["messages"]
        );
        // 账本没被宿主改写：host 只交副本，下一轮 messages 仍从账本长出来
        assert_eq!(messages.len(), 2, "原 user 消息 + 注入的一条");
    }

    /// 宿主答复失败（抛错 / 超时 / HOST_UNAVAILABLE）只降级为「不注入」，绝不让整轮失败。
    #[tokio::test]
    async fn round_prepare_failure_keeps_original_messages() {
        install_fake_host();
        let dir = tempfile::tempdir().unwrap();
        let (cfg, index) = services(dir.path());
        let (addr, captured) = recording_server(
            "data: {\"choices\":[{\"delta\":{\"content\":\"hello\"}}]}\n\ndata: [DONE]\n\n",
        );
        let manager = AgentLoopManager::default();
        let start = manager
            .start(start_params(
                Some("fail-run-1"),
                vec![json!({"role":"user","content":"hi"})],
            ))
            .expect("start");
        let run_id = start.run_id.clone();

        let stop = drive(
            &manager,
            &cfg,
            &index,
            &run_id,
            start,
            &spec_for(addr),
            &LlmConfig::default(),
            &|_delta| {},
        )
        .await
        .expect("宿主答复失败时 drive 仍要成功");

        assert!(matches!(stop, DriveStop::Done(_)), "失败也要正常收场");
        let request = captured.lock().unwrap().clone();
        let body = request
            .split_once("\r\n\r\n")
            .map(|(_, b)| b.to_string())
            .unwrap_or_default();
        let sent: serde_json::Value = serde_json::from_str(&body).expect("请求体是 JSON");
        let messages = sent["messages"].as_array().expect("messages");
        assert_eq!(messages.len(), 1, "失败时用原 messages");
        assert!(
            !request.contains(INJECTED_MARKER),
            "失败时不该有注入内容：{request}"
        );
    }

    /// 上游：第一次给 `first`（状态码 + 体），之后都给 `second`（正常 SSE）。
    /// 返回 (地址, 被连次数)。
    fn scripted_server(
        first_status: &'static str,
        first_body: &'static str,
        second_body: &'static str,
    ) -> (std::net::SocketAddr, std::sync::Arc<std::sync::atomic::AtomicUsize>) {
        use std::io::Write;
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::sync::Arc;
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
        let addr = listener.local_addr().expect("addr");
        let hits = Arc::new(AtomicUsize::new(0));
        let counter = Arc::clone(&hits);
        std::thread::spawn(move || {
            for _ in 0..4 {
                let Ok((mut socket, _)) = listener.accept() else {
                    return;
                };
                let mut buf = [0u8; 8192];
                let _ = std::io::Read::read(&mut socket, &mut buf);
                let n = counter.fetch_add(1, Ordering::SeqCst);
                let (status, body) = if n == 0 {
                    (first_status, first_body)
                } else {
                    ("200 OK", second_body)
                };
                let head = format!(
                    "HTTP/1.1 {status}\r\ncontent-type: text/event-stream\r\nconnection: close\r\ncontent-length: {}\r\n\r\n{body}",
                    body.len()
                );
                let _ = socket.write_all(head.as_bytes());
                let _ = socket.flush();
            }
        });
        (addr, hits)
    }

    /// 上下文溢出 → 内核**自己**强制折一次并重发，不需要宿主插手。
    #[tokio::test]
    async fn retries_once_after_force_folding_on_context_overflow() {
        use std::sync::atomic::Ordering;
        let dir = tempfile::tempdir().unwrap();
        let (cfg, index) = services(dir.path());
        let (addr, hits) = scripted_server(
            "400 Bad Request",
            "{\"error\":{\"message\":\"This model's maximum context length is exceeded\"}}",
            "data: {\"choices\":[{\"delta\":{\"content\":\"ok\"}}]}\n\ndata: [DONE]\n\n",
        );
        let manager = AgentLoopManager::default();
        let start = manager
            .start(start_params(
                None,
                vec![json!({"role":"user","content":"hi"})],
            ))
            .expect("start");
        let run_id = start.run_id.clone();
        let stop = drive(
            &manager,
            &cfg,
            &index,
            &run_id,
            start,
            &spec_for(addr),
            &LlmConfig::default(),
            &|_d| {},
        )
        .await
        .expect("drive");
        assert!(matches!(stop, DriveStop::Done(_)), "折叠后应正常收尾");
        assert_eq!(hits.load(Ordering::SeqCst), 2, "只许重发一次");
    }

    /// 上游拒图 → 内核摘图后重发一次；第二次请求里不应再有图片。
    #[tokio::test]
    async fn retries_once_after_dropping_images_when_upstream_rejects_them() {
        use std::sync::atomic::Ordering;
        let dir = tempfile::tempdir().unwrap();
        let (cfg, index) = services(dir.path());
        let (addr, hits) = scripted_server(
            "400 Bad Request",
            "{\"error\":{\"message\":\"You have uploaded an unsupported image\"}}",
            "data: {\"choices\":[{\"delta\":{\"content\":\"ok\"}}]}\n\ndata: [DONE]\n\n",
        );
        let manager = AgentLoopManager::default();
        let start = manager
            .start(start_params(
                None,
                vec![json!({
                    "role": "user",
                    "content": [
                        {"type": "text", "text": "look"},
                        {"type": "image_url", "image_url": {"url": "data:image/png;base64,AAAA"}}
                    ]
                })],
            ))
            .expect("start");
        let run_id = start.run_id.clone();
        let stop = drive(
            &manager,
            &cfg,
            &index,
            &run_id,
            start,
            &spec_for(addr),
            &LlmConfig::default(),
            &|_d| {},
        )
        .await
        .expect("drive");
        assert!(matches!(stop, DriveStop::Done(_)), "摘图后应正常收尾");
        assert_eq!(hits.load(Ordering::SeqCst), 2, "只许重发一次");
    }

    /// 无工具的一轮：驱动器应当自己发请求、自己推进账本，最后停在 done。
    #[tokio::test]
    async fn drives_a_tool_free_turn_to_done() {
        let dir = tempfile::tempdir().unwrap();
        let (cfg, index) = services(dir.path());
        let addr = one_shot_server(
            "data: {\"choices\":[{\"delta\":{\"content\":\"hello\"}}]}\n\ndata: [DONE]\n\n",
        );
        let manager = AgentLoopManager::default();
        let start = manager
            .start(crate::agent::StartParams {
                model: "m".into(),
                messages: vec![json!({"role":"user","content":"hi"})],
                tools: vec![],
                workspace_root: None,
                max_tool_calls: 5,
                max_rounds: 5,
                token_budget: 0,
                trigger_ratio: 0.0,
                run_id: None,
            })
            .expect("start");

        let run_id = start.run_id.clone();
        let stop = drive(
            &manager,
            &cfg,
            &index,
            &run_id,
            start,
            &spec_for(addr),
            &LlmConfig::default(),
            &|_delta| {},
        )
        .await
        .expect("drive");

        match stop {
            DriveStop::Done(response) => {
                assert_eq!(response.phase, "done");
                assert_eq!(response.content.as_deref(), Some("hello"));
            }
            other => panic!("应停在 done，实际 {:?}", other.phase()),
        }
    }

    /// 有工具的一轮：驱动器发完请求后必须**停在 need_tools**，把执行权交回宿主。
    #[tokio::test]
    async fn stops_at_need_tools_and_hands_execution_back() {
        let dir = tempfile::tempdir().unwrap();
        let (cfg, index) = services(dir.path());
        let addr = one_shot_server(
            "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"c1\",\"function\":{\"name\":\"fs_read_file\",\"arguments\":\"{\\\"filePath\\\":\\\"a.txt\\\"}\"}}]},\"finish_reason\":\"tool_calls\"}]}\n\ndata: [DONE]\n\n",
        );
        let manager = AgentLoopManager::default();
        let start = manager
            .start(crate::agent::StartParams {
                model: "m".into(),
                messages: vec![json!({"role":"user","content":"read a"})],
                tools: vec![],
                workspace_root: None,
                max_tool_calls: 5,
                max_rounds: 5,
                token_budget: 0,
                trigger_ratio: 0.0,
                run_id: None,
            })
            .expect("start");

        let run_id = start.run_id.clone();
        let stop = drive(
            &manager,
            &cfg,
            &index,
            &run_id,
            start,
            &spec_for(addr),
            &LlmConfig::default(),
            &|_delta| {},
        )
        .await
        .expect("drive");

        match stop {
            DriveStop::NeedTools { delegates, .. } => {
                assert_eq!(delegates.len(), 1);
                assert_eq!(delegates[0].name, "fs_read_file");
                assert_eq!(delegates[0].arguments["filePath"], "a.txt");
            }
            other => panic!("应停在 need_tools，实际 {:?}", other.phase()),
        }
    }
}

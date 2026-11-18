//! 这个模块的测试。实现留在同级文件里。
//! 拆开的理由：几百行用例与实现同居时，改一个方法要在整片用例之间翻，diff 也不可读。

use super::*;

/// R2 回归：真正发出去的请求体里 ——
/// ① 有 `stream_options.include_usage`（否则 `agent.usage` / 成本 / 折叠触发口径全空）；
/// ② 账本内部字段（`synthetic` / `reasoning`）一个都不许上行；
/// ③ 带 tools 时 assistant 的思考抬成上游字段 `reasoning_content`（DeepSeek 硬校验）。
#[tokio::test]
async fn outbound_body_is_projected_once_by_core() {
    let dir = tempfile::tempdir().unwrap();
    let (cfg, index) = services(dir.path());
    let (addr, captured) = recording_server(
        "data: {\"choices\":[{\"delta\":{\"content\":\"ok\"}}]}\n\ndata: [DONE]\n\n",
    );
    let manager = AgentLoopManager::default();
    let start = manager
        .start(crate::agent::StartParams {
            model: "m".into(),
            messages: vec![
                json!({"role":"user","content":"hi"}),
                json!({
                    "role":"assistant",
                    "content":"上一轮",
                    "reasoning":"想了点事",
                    "synthetic":true
                }),
            ],
            tools: vec![json!({"type":"function","function":{"name":"fs_read_file"}})],
            workspace_root: None,
            max_tool_calls: 5,
            max_rounds: 5,
            token_budget: 0,
            trigger_ratio: 0.0,
            run_id: None,
        })
        .unwrap();
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
    assert!(matches!(stop, DriveStop::Done(_)));

    let raw = captured.lock().unwrap().clone();
    assert!(raw.contains("\"include_usage\":true"), "必须申请 usage：{raw}");
    assert!(!raw.contains("\"synthetic\""), "账本字段不许上行：{raw}");
    assert!(
        raw.contains("\"reasoning_content\":\"想了点事\""),
        "带 tools 时思考必须回传：{raw}"
    );
    assert!(!raw.contains("\"reasoning\":"), "账本 reasoning 字段不许上行：{raw}");
}

/// 与 Node 同一份 fixture（`test/fixtures/context-overflow-cases.json`）：
/// 两侧对每条上游错误文案的判定必须一致。
///
/// 钉住的是「两份词表漂移」这条历史事故：措辞只落在 Node 清单里时，内核连折都没折
/// 就把这一轮判成失败，而 Node 又把 core 的硬失败降级成「正常完成」。
/// Node 侧的同一份断言在 `test/unit/cross-language-fixtures.test.cjs`。
#[test]
fn context_overflow_matches_the_shared_fixture() {
    const FIXTURE: &str = include_str!("../../../../test/fixtures/context-overflow-cases.json");
    let v: serde_json::Value = serde_json::from_str(FIXTURE).expect("fixture 必须是合法 JSON");
    let cases = v["cases"].as_array().expect("cases");
    assert!(!cases.is_empty());
    for case in cases {
        let message = case["message"].as_str().expect("message");
        let expected = case["overflow"].as_bool().expect("overflow");
        assert_eq!(
            looks_like_context_overflow(message),
            expected,
            "判定不一致：{message}"
        );
    }
}
use dieyun_base::config::AppConfig;
use dieyun_base::embedding::EmbeddingConfig;
use serde_json::json;

fn spec_for(addr: std::net::SocketAddr) -> DriveSpec {
    DriveSpec {
        url: format!("http://{addr}/v1/chat/completions"),
        stream: true,
        content_channel: ContentChannel::Answer,
        include_raw: false,
        // 出站投影据此决定要不要补 `reasoning_content`（能力表声明）
        echo_reasoning: false,
    }
}

fn services(dir: &std::path::Path) -> (AppConfig, dieyun_codebase::index::IndexService) {
    let cfg = AppConfig::default();
    let index = dieyun_codebase::index::IndexService::new(
        dieyun_codebase::codebase_db::handle(dir.join("idx.sqlite")),
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
            // 必须读满整个请求（头 + `Content-Length` 指定的体）再关 socket：
            // 只读一次 8KB 就关闭，客户端还在发更大的 body 时内核会回 RST，
            // 症状是「error sending request」——在并行跑测试时随机出现。
            let mut got: Vec<u8> = Vec::new();
            loop {
                match std::io::Read::read(&mut socket, &mut buf) {
                    Ok(0) => break,
                    Ok(n) => got.extend_from_slice(&buf[..n]),
                    Err(_) => break,
                }
                let Some(pos) = find_subsequence(&got, b"\r\n\r\n") else {
                    continue;
                };
                let header = String::from_utf8_lossy(&got[..pos]).to_ascii_lowercase();
                let want = header
                    .lines()
                    .find_map(|line| {
                        line.strip_prefix("content-length:")
                            .and_then(|v| v.trim().parse::<usize>().ok())
                    })
                    .unwrap_or(0);
                if got.len() >= pos + 4 + want {
                    break;
                }
            }
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

/// 一段足够长的历史（长工具输出 ×4 + 收尾），给折叠器真的留出可折区间。
///
/// 刻意选在「估算已过折叠目标（budget × 0.8）但还没到触发线（budget × 0.95）」之间：
/// 这样请求发出时**没有**自动折叠，溢出后由驱动器的强制折叠去折 —— 正是要走的那条路。
fn foldable_history() -> Vec<serde_json::Value> {
    let big = "x".repeat(2_800);
    let mut messages = vec![
        json!({"role":"user","content":"任务目标：修好 a.txt 的解析"}),
    ];
    for i in 0..4 {
        messages.push(json!({
            "role": "assistant",
            "content": "",
            "tool_calls": [{
                "id": format!("call-{i}"),
                "type": "function",
                "function": {"name": "fs_read_file", "arguments": "{\"filePath\":\"a.txt\"}"}
            }]
        }));
        messages.push(json!({
            "role": "tool",
            "tool_call_id": format!("call-{i}"),
            "content": big.clone()
        }));
        messages.push(json!({"role": "assistant", "content": "读完了"}));
    }
    messages.push(json!({"role": "user", "content": "继续"}));
    messages
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
        .start(crate::agent::StartParams {
            token_budget: 4096,
            trigger_ratio: 0.95,
            ..start_params(None, foldable_history())
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
        &|_d| {},
    )
    .await
    .expect("drive");
    assert!(matches!(stop, DriveStop::Done(_)), "折叠后应正常收尾");
    assert_eq!(hits.load(Ordering::SeqCst), 2, "只许重发一次");
}

/// 上下文溢出但**没有可折的内容**（预算 0 / 尾巴全是锚点）→ 直接失败，不许重发。
///
/// 旧实现只接 `fold_now` 的 `Err`，`Ok(None)`（折不动）照样重发一次 —— 原样再失败一次，
/// 白花一次 token 与等待。这条用例钉住「折不动就别发第二次」。
#[tokio::test]
async fn overflow_without_foldable_content_does_not_retry() {
    use std::sync::atomic::Ordering;
    let dir = tempfile::tempdir().unwrap();
    let (cfg, index) = services(dir.path());
    let (addr, hits) = scripted_server(
        "400 Bad Request",
        "{\"error\":{\"message\":\"This model's maximum context length is exceeded\"}}",
        "data: {\"choices\":[{\"delta\":{\"content\":\"ok\"}}]}\n\ndata: [DONE]\n\n",
    );
    let manager = AgentLoopManager::default();
    // token_budget = 0 ⇒ 本 run 不折（宿主没给预算），强制折叠也折不出东西。
    let start = manager
        .start(start_params(
            None,
            vec![json!({"role":"user","content":"hi"})],
        ))
        .expect("start");
    let run_id = start.run_id.clone();
    let err = drive(
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
    .expect_err("折不动就没有第二次机会，应把上游错误原样交出去");
    assert!(
        err.to_string().contains("maximum context length"),
        "原样回传上游错误: {err}"
    );
    assert_eq!(hits.load(Ordering::SeqCst), 1, "折不动时不许重发");
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

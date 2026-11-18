//! 这个模块的测试。实现留在同级文件里。
//! 拆开的理由：几百行用例与实现同居时，改一个方法要在整片用例之间翻，diff 也不可读。

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

/// 名字是**标识**不是增量：兼容网关每个 delta 都重发全名，不许拼成
/// `fs_read_filefs_read_file`（模型会去调一个不存在的工具）。
#[test]
fn repeated_tool_name_is_not_concatenated() {
    let mut acc = Accumulator::new();
    feed_all(
        &mut acc,
        &[
            r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_a","function":{"name":"fs_read_file","arguments":"{}"}}]}}]}"#,
            r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"fs_read_file","arguments":""}}]}}]}"#,
        ],
    );
    let outcome = acc.finish();
    assert_eq!(outcome.tool_calls.len(), 1);
    assert_eq!(outcome.tool_calls[0].name, "fs_read_file");
    assert_eq!(outcome.tool_calls[0].arguments, "{}");
}

/// 参数续片常常既不带 `index` 也不带 `id`（有的网关连首片也不带 index）：
/// 必须续到**同一个**槽，否则参数被拆成两个半截调用。
#[test]
fn tool_call_fragments_without_index_stay_in_one_slot() {
    let mut acc = Accumulator::new();
    feed_all(
        &mut acc,
        &[
            r#"{"choices":[{"delta":{"tool_calls":[{"function":{"name":"fs_read_file","arguments":"{\"file"}}]}}]}"#,
            r#"{"choices":[{"delta":{"tool_calls":[{"id":"call_a","function":{"arguments":"Path\":\"a.txt\"}"}}]}}]}"#,
        ],
    );
    let outcome = acc.finish();
    assert_eq!(outcome.tool_calls.len(), 1, "两片属于同一个调用");
    assert_eq!(outcome.tool_calls[0].id, "call_a");
    assert_eq!(outcome.tool_calls[0].name, "fs_read_file");
    assert_eq!(outcome.tool_calls[0].arguments, r#"{"filePath":"a.txt"}"#);
}

/// 非流式整包里的**第二条**调用不许因为「本块数组下标」被写进第一条（历史串槽：
/// 两个工具合成一个，参数还是错的）。
#[test]
fn tool_calls_without_index_do_not_collide() {
    let mut acc = Accumulator::new();
    acc.feed_body(
        r#"{"choices":[{"message":{"tool_calls":[
            {"id":"call_a","function":{"name":"fs_read_file","arguments":"{\"filePath\":\"a\"}"}},
            {"id":"call_b","function":{"name":"fs_write_file","arguments":"{\"filePath\":\"b\"}"}}
        ]},"finish_reason":"tool_calls"}]}"#,
    )
    .expect("整包解析");
    let outcome = acc.finish();
    assert_eq!(outcome.tool_calls.len(), 2);
    assert_eq!(outcome.tool_calls[0].id, "call_a");
    assert_eq!(outcome.tool_calls[1].id, "call_b");
    assert_eq!(outcome.tool_calls[1].name, "fs_write_file");
    assert_eq!(outcome.tool_calls[1].arguments, r#"{"filePath":"b"}"#);
}

/// 离谱的 `index` 不许变成「分配十万个空槽」，也不许静默丢：
/// 记成上游协议错误，让上层看得见。
#[test]
fn absurd_tool_index_is_reported_instead_of_allocating() {
    let mut acc = Accumulator::new();
    feed_all(
        &mut acc,
        &[r#"{"choices":[{"delta":{"tool_calls":[{"index":100000,"id":"call_a","function":{"name":"fs_read_file","arguments":"{}"}}]}}]}"#],
    );
    assert!(
        acc.upstream_error().unwrap_or("").contains("index=100000"),
        "必须报出来：{:?}",
        acc.upstream_error()
    );
    assert!(acc.finish().tool_calls.is_empty(), "不许按坏 index 造槽");
}

/// `n > 1` 或中转合并 choice 时，后面的 choice 不许静默丢（用户只看到半截答案）。
#[test]
fn extra_choices_are_accumulated_not_dropped() {
    let mut acc = Accumulator::new();
    feed_all(
        &mut acc,
        &[
            r#"{"choices":[{"delta":{"content":"第一段"}},{"delta":{"content":"第二段"}}]}"#,
            "[DONE]",
        ],
    );
    assert_eq!(acc.finish().content, "第一段第二段");
}

/// 流式请求体必须申请 `usage`：不带 `stream_options.include_usage` 时端点不回 usage，
/// 于是 `agent.usage` 事件、成本统计、折叠的 usage 触发口径**全部静默失效**。
#[test]
fn streaming_request_asks_for_usage() {
    let mut body = json!({"model":"m","messages":[]});
    apply_transport_fields(&mut body, true);
    assert_eq!(body["stream"], json!(true));
    assert_eq!(body["stream_options"]["include_usage"], json!(true));
}

/// 非流式不申请；宿主已显式给 `stream_options` 时不覆盖（唯一作者是这里，别打架）。
#[test]
fn transport_fields_do_not_overwrite_explicit_stream_options() {
    let mut body = json!({"model":"m"});
    apply_transport_fields(&mut body, false);
    assert_eq!(body["stream"], json!(false));
    assert!(body.get("stream_options").is_none(), "非流式不该带");

    let mut explicit = json!({"stream_options":{"include_usage":false}});
    apply_transport_fields(&mut explicit, true);
    assert_eq!(
        explicit["stream_options"]["include_usage"],
        json!(false),
        "宿主显式关掉就尊重"
    );
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

/// 传输层失败必须给**结构化码** + 全链文案，而不是只回一句 url。
///
/// 2026-11-18 现场：网关重启掐断在途请求，`e.to_string()` 只有
/// `error sending request for url (...)`；宿主分类器只能按文案猜，猜不中就把它判成永久失败
/// （可重连的瞬断 → 本轮直接失败）。这条钉住「码 + source 链」这两样宿主真正需要的东西。
#[tokio::test]
async fn transport_failure_carries_code_and_source_chain() {
    use std::collections::HashMap;

    // 先占端口再释放：随后连它必然被拒绝（不依赖外网，也不受防火墙策略影响）
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let addr = listener.local_addr().expect("addr");
    drop(listener);

    let cfg = LlmConfig {
        api_key: "sk-test".to_string(),
        auth_mode: "bearer".to_string(),
        ..Default::default()
    };
    let url = format!("http://{addr}/v1/chat/completions");
    let err = chat_completion(
        &cfg,
        &url,
        &HashMap::new(),
        json!({ "model": "m", "messages": [] }),
        false,
        false,
        |_delta| {},
    )
    .await
    .expect_err("连不上时必须报错");

    assert_eq!(
        err.code(),
        dieyun_base::shared::shared().llm_errors.transport_code,
        "传输层失败的码必须是宿主认的那一个（agent-shared.json#llmErrors）"
    );
    let msg = err.to_string();
    assert!(msg.contains("传输失败"), "文案要说明这是传输层：{msg}");
    assert!(msg.contains("connect"), "要标出失败位置（connect/timeout/body）：{msg}");
    assert!(
        msg.contains('←'),
        "必须带 source 链：真正原因只在链里，顶层只有一句 error sending request：{msg}"
    );
}

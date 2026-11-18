//! 这个模块的测试。实现留在同级文件里。
//! 拆开的理由：几百行用例与实现同居时，改一个方法要在整片用例之间翻，diff 也不可读。

use super::*;

use serde_json::json;

/// 测试用的紧凑预算：12.8K 档的真实取值在 Node（`computeEffectiveInputBudget`），
/// 这里只取够用的最小合法值，好让用例的 payload 不必写成几十 KB。
fn params(messages: Vec<Value>) -> FoldParams {
    FoldParams {
        messages,
        token_budget: 4096,
        trigger_ratio: 0.8,
        observed_prompt_tokens: None,
        force: false,
        keep_tail_atoms: None,
    }
}

fn roles(msgs: &[Value]) -> Vec<String> {
    msgs.iter().map(|m| role_of(m).to_string()).collect()
}

fn call_msg(id: &str, tool: &str, args: &str) -> Value {
    json!({
        "role": "assistant",
        "content": "",
        "tool_calls": [{ "id": id, "type": "function", "function": { "name": tool, "arguments": args } }]
    })
}

/// 一段足够长的历史：4 个较早的「读文件」回合 + 收尾。
/// 尾部 3 个原子（最后的 user / assistant 组）保持在可折区之外。
fn history(big_tool_output: &str) -> Vec<Value> {
    let mut m = vec![json!({"role":"user","content":"任务目标：修好 a.txt 的解析"})];
    for i in 0..4 {
        m.push(call_msg(
            &format!("call-{i}"),
            "fs_read_file",
            "{\"filePath\":\"a.txt\"}",
        ));
        m.push(json!({
            "role": "tool",
            "tool_call_id": format!("call-{i}"),
            "content": if i == 0 { big_tool_output.to_string() } else { "ok".to_string() }
        }));
        m.push(json!({"role":"user","content": format!("继续 {i}")}));
    }
    m.push(json!({"role":"assistant","content":"完成"}));
    m
}

#[test]
fn small_context_is_untouched() {
    let messages = vec![
        json!({"role":"user","content":"hi"}),
        json!({"role":"assistant","content":"hello"}),
    ];
    let r = fold(params(messages.clone()));
    assert!(!r.compacted);
    assert_eq!(r.messages, messages);
    assert_eq!(r.level, 0);
}

/// 核心契约：折叠**不新增/不删除消息**，也不伪造 assistant 轮。
#[test]
fn folding_never_adds_or_drops_messages() {
    let messages = history(&"x".repeat(20_000));
    let before_roles = roles(&messages);
    let r = fold(params(messages));
    assert!(r.compacted);
    assert_eq!(roles(&r.messages), before_roles, "角色序列必须原样");
    assert_eq!(r.messages.len(), before_roles.len());
    // 不得出现平台伪造的 assistant 回执
    let fake = r.messages.iter().any(|m| {
        role_of(m) == "assistant"
            && m.get("content")
                .and_then(|c| c.as_str())
                .map(|s| s.contains("已基于压缩摘要"))
                .unwrap_or(false)
    });
    assert!(!fake, "不得伪造 assistant 回执");
}

#[test]
fn long_tool_result_is_clipped_but_keeps_pairing() {
    let messages = history(&"内容".repeat(4000));
    let r = fold(params(messages));
    assert!(r.compacted);
    // assistant 的 tool_calls 骨架必须原样保留
    let assistant = r
        .messages
        .iter()
        .find(|m| m.get("tool_calls").is_some())
        .expect("assistant tool_calls");
    assert_eq!(assistant["tool_calls"][0]["function"]["name"], "fs_read_file");
    assert_eq!(
        assistant["tool_calls"][0]["function"]["arguments"],
        "{\"filePath\":\"a.txt\"}"
    );
    // tool 消息的配对键必须还在，内容被截短且带折叠标记
    let tool = r
        .messages
        .iter()
        .find(|m| m.get("tool_call_id").and_then(|v| v.as_str()) == Some("call-0"))
        .expect("tool message");
    assert_eq!(tool["tool_call_id"], "call-0");
    let text = tool["content"].as_str().unwrap();
    assert!(text.contains("已折叠"), "内容应带折叠标记: {text}");
    assert!(char_len(text) < 2000, "折叠后应显著变短: {}", char_len(text));
    assert_eq!(r.folded_tool_results, 1);
}

/// 最近几轮（尾部原子）原样保留：刚跑完的工具结果模型还要用。
#[test]
fn tail_atoms_stay_intact() {
    let big = "y".repeat(20_000);
    let messages = vec![
        json!({"role":"user","content":"开始"}),
        call_msg("old", "a", "{}"),
        json!({"role":"tool","tool_call_id":"old","content": big.clone()}),
        call_msg("new", "b", "{}"),
        json!({"role":"tool","tool_call_id":"new","content": big.clone()}),
    ];
    let r = fold(FoldParams {
        keep_tail_atoms: Some(1),
        ..params(messages)
    });
    assert!(r.compacted);
    let new_tool = r
        .messages
        .iter()
        .find(|m| m.get("tool_call_id").and_then(|v| v.as_str()) == Some("new"))
        .expect("new tool");
    assert_eq!(new_tool["content"].as_str().unwrap(), big, "尾巴不得被折");
    let old_tool = r
        .messages
        .iter()
        .find(|m| m.get("tool_call_id").and_then(|v| v.as_str()) == Some("old"))
        .expect("old tool");
    assert!(old_tool["content"].as_str().unwrap().contains("已折叠"));
}

#[test]
fn user_text_is_never_folded() {
    let big_user = "u".repeat(30_000);
    let mut messages = history(&"x".repeat(20_000));
    messages[0] = json!({"role":"user","content": big_user.clone()});
    let r = fold(params(messages));
    assert_eq!(
        r.messages[0]["content"].as_str().unwrap(),
        big_user,
        "用户消息的文字是锚点，不折"
    );
}

/// 幂等：折过一次后再折，内容不再变化（不会每轮都把尾巴啃掉一截）。
#[test]
fn folding_is_idempotent() {
    let mut first = fold(params(history(&"z".repeat(20_000))));
    assert!(first.compacted);
    // 连 force 都不该再改动：同档已被标记，更深档在估算已低于目标时不必施加
    let second = fold(FoldParams {
        force: true,
        ..params(first.messages.clone())
    });
    assert_eq!(second.messages, first.messages, "第二次折叠不应再改动内容");
    // 反向再确认一次：第三次同样不动
    let third = fold(FoldParams {
        force: true,
        ..params(second.messages)
    });
    first.messages = third.messages.clone();
    assert_eq!(third.messages, first.messages);
}

#[test]
fn old_images_are_stripped_from_user_and_kept_out_of_base64() {
    let big_b64 = format!("data:image/png;base64,{}", "A".repeat(4000));
    let mut messages = history(&"x".repeat(20_000));
    messages[0] = json!({
        "role": "user",
        "content": [
            {"type":"text","text":"看这张图"},
            {"type":"image_url","image_url":{"url": big_b64}}
        ]
    });
    let r = fold(params(messages));
    assert!(r.compacted);
    assert!(r.folded_images >= 1);
    let text = r.messages[0]["content"].as_str().unwrap();
    assert!(text.contains("看这张图"), "用户文字必须保留: {text}");
    assert!(text.contains("已摘除"), "图片应换成标记: {text}");
    assert!(!text.contains("base64"), "base64 不应残留");
}

/// 触发口径：服务端 usage 越过触发线即折，哪怕字符比估值还没到。
#[test]
fn observed_usage_triggers_before_estimate() {
    let messages = history(&"w".repeat(3000));
    // 估值远低于触发线（6553）→ 不折
    let idle = fold(params(messages.clone()));
    assert!(!idle.compacted);
    assert_eq!(idle.trigger_source, "estimate");
    // 同一批消息，服务端说已用 7000/8192 → 折
    let r = fold(FoldParams {
        observed_prompt_tokens: Some(7000),
        ..params(messages)
    });
    assert!(r.compacted);
    assert_eq!(r.trigger_source, "usage");
    assert_eq!(r.tokens_before, 7000);
    assert!(r.tokens_after < 7000);
}

#[test]
fn force_bypasses_threshold_and_reports_level() {
    let r = fold(FoldParams {
        force: true,
        ..params(history(&"q".repeat(5000)))
    });
    assert!(r.compacted);
    assert!(r.level >= 1 && r.level <= 3);
    assert!(r.tokens_after < r.tokens_before);
}

/// tool_calls 参数（可能是几 KB 的补丁）绝不截断：那是调用骨架。
#[test]
fn tool_call_arguments_are_never_truncated() {
    let huge_args = format!("{{\"patch\":\"{}\"}}", "p".repeat(9000));
    let mut messages = history(&"x".repeat(20_000));
    messages[1] = call_msg("call-0", "fs_edit", &huge_args);
    let r = fold(params(messages));
    let assistant = r
        .messages
        .iter()
        .find(|m| m.get("tool_calls").is_some())
        .expect("assistant");
    assert_eq!(assistant["tool_calls"][0]["function"]["arguments"], huge_args);
}

/// 折叠标记必须能被读回，否则幂等与加深都会失效。
#[test]
fn fold_mark_round_trips_level() {
    for lv in 1..=3u8 {
        let marked = clip(&"a".repeat(5000), 100, 50, lv);
        assert_eq!(applied_level(&marked), Some(lv));
    }
    assert_eq!(applied_level("普通文本"), None);
}

/// 回归（A17）：正文里**提到** `fold:L` 不等于「已经折过」。
///
/// 折叠是唯一的压缩机制。旧实现全文 `find("fold:L")`：模型读过 `fold.rs` /
/// `docs/CONTEXT-FOLD.md`、或者任何一份引用了折叠标记的日志 / 审计报告进了上下文，
/// 那条消息就被当成「已折到 L9」—— 从此既不裁也不再推进档位，估值只增不减。
#[test]
fn text_mentioning_the_marker_is_still_folded() {
    // 看起来像标记、但不是我们写出的完整形状
    assert_eq!(applied_level("文档里写着 fold:L9 这一档，别删。"), None);
    assert_eq!(applied_level("［已折叠］但没写档位，后面才提 fold:L3"), None);

    // 真正的工具输出里提到标记 → 仍然必须被折叠
    let doc = format!("fold.rs 里写着 fold:L9 这一档。{}", "x".repeat(20_000));
    let messages = history(&doc);
    let before: usize = messages.iter().map(|m| m.to_string().len()).sum();
    let r = fold(params(messages));
    assert!(r.compacted, "提到标记的正文仍要折叠");
    let after: usize = r.messages.iter().map(|m| m.to_string().len()).sum();
    assert!(after < before, "该消息必须真的被裁短：{after} !< {before}");
}

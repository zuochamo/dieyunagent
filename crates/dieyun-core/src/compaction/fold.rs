//! 上下文折叠：compaction 的**唯一**实现。
//!
//! 取代旧的「滚雪球 LLM 摘要 + 伪造 assistant 回执」：那套做法每压一次就改写对话
//! 头部（摘要重写 ⇒ 前缀缓存从头失效）、在请求关键路径上挂一次最长 75s 的 LLM 调用、
//! 凭空插入一条模型从未说过的 assistant 消息（`收到，已基于压缩摘要继续执行。`），
//! 并且折叠后工具调用只剩一张路径白名单，调参全靠一排手调魔数。
//!
//! 这里只做确定性的事：把**旧消息里超长的内容**就地截短，保留 assistant 的
//! `tool_calls` 骨架与 tool 消息的配对关系。由此得到四条性质：
//! - 无网络、无 LLM、无超时：纯 CPU，毫秒级，不会把发送卡在超时上；
//! - 幂等：折叠标记里记着已施加的档位，同一档不会重复折（见 [`applied_level`]）；
//! - 前缀友好：只在越过触发线时动一次**较早**的区域，不重写头部、不插入新消息；
//! - 触发口径优先用服务端 usage（真实 `prompt_tokens`），字符比估值只作兜底。
//!
//! 刻意不做的事：不动 `reasoning_content`（带 `tool_calls` 的 assistant 消息必须原样回传，
//! 截断会被上游以 400 拒绝）、不动 `tool_calls` 参数（那是骨架）、不折 user 消息的**文字**
//! （用户意图是锚点）—— 但 user 消息里的图片 part 会被摘掉，见 [`strip_images`]。

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::tokens::{estimate_messages_tokens, is_image_part};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FoldParams {
    pub messages: Vec<Value>,
    /// 有效输入预算（token）。数值唯一来源是 Node `compaction-main.js`
    /// （模型窗口 - 输出预留 - 系统预留 - 工具 schema 超出预留的那部分）。
    pub token_budget: usize,
    /// 触发比（0.3~0.95）。唯一来源 Node `model-runtime-presets.js`。
    pub trigger_ratio: f64,
    /// 上一轮服务端回报的 `usage.prompt_tokens`。有它就以此为准——字符比估值只为兜底。
    #[serde(default)]
    pub observed_prompt_tokens: Option<usize>,
    /// 溢出兜底：跳过错峰判断，直接折叠一次。
    #[serde(default)]
    pub force: bool,
    /// 尾部原样保留的原子数（默认 3）：最近几轮的工具结果必须完整可见。
    #[serde(default)]
    pub keep_tail_atoms: Option<usize>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FoldResult {
    pub compacted: bool,
    /// 是否越过触发线（或 force）。未触发的早退不写遥测——否则每一轮 LLM 前都会多一行
    /// 「本轮没压」的记录，把成功率稀释成没有意义的数。
    pub triggered: bool,
    pub messages: Vec<Value>,
    pub tokens_before: usize,
    pub tokens_after: usize,
    /// 触发口径：`usage` = 服务端 usage；`estimate` = 字符比估值。
    pub trigger_source: &'static str,
    /// 折叠档位：0 = 没动，1..=3 逐级加深。
    pub level: u8,
    pub folded_tool_results: usize,
    pub folded_texts: usize,
    pub folded_images: usize,
}

/// 三档折叠力度：`(保留头部字符, 保留尾部字符, 触发折叠的最小字符数)`。
///
/// 逐档加深而不是一次到底：轻度折叠（只砍最长的工具输出）通常就够，砍到 120 字符的
/// 损失要留到真正顶穿预算时才付。档位数字只在这一处。
const LEVELS: [(usize, usize, usize); 3] = [(800, 200, 1600), (300, 100, 600), (120, 60, 240)];

/// 折叠目标：折到预算的这个比例就停手，不追求压到最低（留出下几轮的增量空间）。
const FOLD_TARGET_RATIO: f64 = 0.80;

/// 尾部保留的原子数缺省值。
const DEFAULT_KEEP_TAIL_ATOMS: usize = 3;

/// 预算地板：低于它的预算无意义（调用方给错也不至于把上下文折成空）。
///
/// 与 Node 的 `contextWindowFloorTokens`（8192，见 `assets/agent-shared.json`）不是同一个数：
/// 那个是「窗口」地板的派生基准，这个是「别人递进来的预算」的兜底守卫。守卫必须**小于等于**
/// 那个地板，否则 Node 算出的合法预算会被内核静默抬高 —— `shared.rs` 的测试钉着这条关系。
pub(crate) const MIN_BUDGET_TOKENS: usize = 4096;
///
/// 折叠标记的公共前缀；`fold:L<n>` 记下已施加的档位，幂等与「加深一档」都靠它。
///
/// 标记里刻意用 ASCII 的 `fold:L` 作为机器可读部分：中文全角标点在不同编辑器 / 输入法
/// 下会被换成外形相同而码点不同的字符，正则/`find` 一旦对不上，幂等就静默失效。
const FOLD_MARK: &str = "［已折叠";
const LEVEL_TAG: &str = "fold:L";

#[derive(Debug, Default, Clone, Copy)]
struct Stats {
    tool_results: usize,
    texts: usize,
    images: usize,
}

pub fn fold(params: FoldParams) -> FoldResult {
    let estimated = estimate_messages_tokens(&params.messages);
    let (used, trigger_source) = match params.observed_prompt_tokens {
        Some(n) if n > 0 => (n, "usage"),
        _ => (estimated, "estimate"),
    };
    let numbers = &crate::shared::shared().compaction;
    // 触发比夹取区间是跨语言常量：唯一来源 `assets/agent-shared.json`
    // （Node 的 `getCompactionTriggerRatio` 用同一份 min/max）。
    let budget = params.token_budget.max(MIN_BUDGET_TOKENS);
    let trigger =
        (budget as f64 * params.trigger_ratio.clamp(numbers.trigger_ratio_min, numbers.trigger_ratio_max))
            as usize;

    if !params.force && used < trigger {
        return FoldResult {
            compacted: false,
            triggered: false,
            messages: params.messages,
            tokens_before: used,
            tokens_after: used,
            trigger_source,
            level: 0,
            folded_tool_results: 0,
            folded_texts: 0,
            folded_images: 0,
        };
    }

    let keep_tail = params
        .keep_tail_atoms
        .unwrap_or(DEFAULT_KEEP_TAIL_ATOMS)
        .max(1);
    let mut messages = params.messages;
    // 折叠边界与档位一起定好：折叠只会缩短较早的区域，边界因此始终有效。
    let tail_start = tail_start_index(&messages, keep_tail);
    let target = (budget as f64 * FOLD_TARGET_RATIO) as usize;
    let mut stats = Stats::default();
    let mut level = 0u8;

    for (i, (head, tail, min_chars)) in LEVELS.iter().enumerate() {
        let this_level = (i + 1) as u8;
        // 已经折到目标以内就停手：不再为了「更小」而去啃尾巴
        if i > 0 && estimate_messages_tokens(&messages) <= target {
            break;
        }
        let mut changed = false;
        for idx in 0..tail_start.min(messages.len()) {
            // 角色先取出，避免与下面的可变借用重叠
            let role = role_of(&messages[idx]).to_string();
            if role == "system" {
                continue;
            }
            if role == "user" {
                // 用户消息的文字是锚点，一个字都不动；只摘掉图片 part
                if strip_images(&mut messages[idx], &mut stats) {
                    changed = true;
                }
                continue;
            }
            if fold_message(
                &mut messages[idx],
                *head,
                *tail,
                *min_chars,
                this_level,
                &mut stats,
            ) {
                changed = true;
            }
        }
        if changed {
            level = this_level;
            if estimate_messages_tokens(&messages) <= target {
                break;
            }
        }
    }

    let after = estimate_messages_tokens(&messages);
    FoldResult {
        compacted: level > 0,
        triggered: true,
        messages,
        tokens_before: used,
        tokens_after: after,
        trigger_source,
        level,
        folded_tool_results: stats.tool_results,
        folded_texts: stats.texts,
        folded_images: stats.images,
    }
}

fn role_of(msg: &Value) -> &str {
    msg.get("role").and_then(|v| v.as_str()).unwrap_or("")
}

/// 尾部保留区间的起点：`messages[tail_start..]` 原样不动。
///
/// 「原子」= 一条 assistant（可能带 `tool_calls`）+ 它后面紧跟的 tool 消息；其余角色
/// 各自成一个原子。从尾部往前数满 `keep_atoms` 个原子，其头部下标即保留区起点；
/// 早于它的内容才是可折区。
fn tail_start_index(msgs: &[Value], keep_atoms: usize) -> usize {
    let mut i = msgs.len();
    let mut atoms = 0usize;
    while i > 0 {
        i -= 1;
        if role_of(&msgs[i]) == "tool" {
            // tool 消息属于它前面那个 assistant 原子，不单独成原子
            continue;
        }
        atoms += 1;
        if atoms == keep_atoms {
            return i;
        }
    }
    0
}

/// 就地折叠一条非 user 消息的 `content`。返回是否真的改动了内容。
fn fold_message(
    msg: &mut Value,
    head: usize,
    tail: usize,
    min_chars: usize,
    level: u8,
    stats: &mut Stats,
) -> bool {
    let role = role_of(msg).to_string();
    // `content` 是 Null（纯 tool_calls 的 assistant）时无事可做
    if msg.get("content").map(|c| c.is_null()).unwrap_or(true) {
        return false;
    }
    let Some(content) = msg.get_mut("content") else {
        return false;
    };

    let changed = match content {
        Value::String(text) => clip_text(text, head, tail, min_chars, level),
        Value::Array(_) => {
            let (joined, images) = flatten_parts(content);
            let already = applied_level(&joined).is_some_and(|l| l >= level);
            let needs_clip = !already && char_len(&joined) > min_chars;
            if images == 0 && !needs_clip {
                return false;
            }
            let mut out = if needs_clip {
                clip(&joined, head, tail, level)
            } else {
                joined
            };
            if images > 0 {
                stats.images += images;
                out.push_str(&image_marker(images));
            }
            // 收敛成纯字符串：下游（模型 API / 账本 / 快照）只认一种形状，
            // 少一层「数组里只有一个 text part」的等价形态要处理。
            *content = Value::String(out);
            true
        }
        // 对象 / 数字等非常规形状：不猜语义，原样保留
        _ => false,
    };

    if changed {
        if role == "tool" {
            stats.tool_results += 1;
        } else {
            stats.texts += 1;
        }
    }
    changed
}

/// 文字折叠：已施加过同档或更深档位的内容不再动（幂等）。
fn clip_text(text: &mut String, head: usize, tail: usize, min_chars: usize, level: u8) -> bool {
    if applied_level(text).is_some_and(|l| l >= level) {
        return false;
    }
    if char_len(text) <= min_chars {
        return false;
    }
    *text = clip(text, head, tail, level);
    true
}

/// 数组形状的 content → (文本, 图片张数)。图片本来与 base64 长度无关（服务端按像素
/// 计 token），留在这里唯一的作用是把后续轮次的请求撑大；旧轮次的图片没有用处
/// （要看图会重新读或重新截图）。
fn flatten_parts(content: &Value) -> (String, usize) {
    let parts = content.as_array().map(Vec::as_slice).unwrap_or(&[]);
    let images = parts.iter().filter(|p| is_image_part(p)).count();
    let text = parts
        .iter()
        .filter(|p| !is_image_part(p))
        .filter_map(part_text)
        .collect::<Vec<_>>()
        .join("\n");
    (text, images)
}

fn image_marker(images: usize) -> String {
    format!("\n…［已摘除 {images} 张旧图片：需要画面请重新读取或重新截图］…")
}

/// 只摘图片、不动文字（user 消息专用）。返回是否改动。
/// 摘掉一条消息里的图片 part，返回摘掉的张数。
///
/// 循环侧的 `agent.loop.drop_images` 复用它：图片是**请求级**事实（上游拒绝某张图），
/// 但 ledger 归 core 所有，所以「从账本里摘掉」必须发生在 core，不能让宿主自己改 messages。
pub fn strip_images_only(msg: &mut Value) -> usize {
    let mut stats = Stats::default();
    strip_images(msg, &mut stats);
    stats.images
}

fn strip_images(msg: &mut Value, stats: &mut Stats) -> bool {
    let Some(content) = msg.get_mut("content") else {
        return false;
    };
    if !content.is_array() {
        return false;
    }
    let (joined, images) = flatten_parts(content);
    if images == 0 {
        return false;
    }
    stats.images += images;
    *content = Value::String(format!("{joined}{}", image_marker(images)));
    true
}

fn part_text(part: &Value) -> Option<String> {
    if let Some(t) = part.as_str() {
        return Some(t.to_string());
    }
    part.get("text")
        .or_else(|| part.get("content"))
        .and_then(|v| v.as_str())
        .map(str::to_string)
}

/// 从文本里读出「已折叠到第几档」；没有折叠标记时为 `None`。
fn applied_level(text: &str) -> Option<u8> {
    let at = text.find(LEVEL_TAG)?;
    let digits: String = text[at + LEVEL_TAG.len()..]
        .chars()
        .take_while(|c| c.is_ascii_digit())
        .collect();
    digits.parse().ok()
}

fn char_len(s: &str) -> usize {
    s.chars().count()
}

/// 保留头部 `head` 字符 + 尾部 `tail` 字符，中间换成折叠标记。
fn clip(s: &str, head: usize, tail: usize, level: u8) -> String {
    let chars: Vec<char> = s.chars().collect();
    if chars.len() <= head + tail {
        return s.to_string();
    }
    let removed = chars.len() - head - tail;
    let h: String = chars[..head].iter().collect();
    let t: String = chars[chars.len() - tail..].iter().collect();
    format!("{h}\n…{FOLD_MARK} {removed} 字符 {LEVEL_TAG}{level}；需要原文请重新读取文件或重跑命令］…\n{t}")
}

#[cfg(test)]
mod tests {
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
}

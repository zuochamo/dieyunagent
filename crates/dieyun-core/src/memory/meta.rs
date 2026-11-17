// 依赖与 mod.rs 同源：域文件里直接用，不再各自拼一套 use。

use rusqlite::{params, Connection, OptionalExtension};
use serde_json::Value;

use crate::error::CoreError;

/**
 * 消息 meta 与标题判据：`【叠云meta】` 前缀的打包/清洗/剥离、标题启发式与「占位标题」判定。
 * 标题该不该被自动覆盖，全仓只有 `title_needs_repair` 一个判据（`session.rs` 与 misc 的撤回路径都调它）。
 */

/// 落库消息的 meta 前缀：`【叠云meta】{json}\n<正文>`。
/// 与 JS `session-context.MESSAGE_META_PREFIX` 同口径（那里是唯一打包口）。
pub(crate) const MESSAGE_META_PREFIX: &str = "【叠云meta】";

/// 落库 meta 里单个字符串字段的长度上限：**比 JS 打包侧宽 5 倍**（那边是 20000，见
/// `session-context.js:META_STRING_MAX`）。这不是「同口径」，是刻意的两级：
/// 打包侧负责「别写进去」，这里是最后一道兜底 —— 它还要拦住别的写入方（旧版本、
/// remote peer、Rust 侧自写）塞进来的字节形态，收紧到 20000 反而会误删那边的合法长字段。
///
/// 量级依据：远高于任何合法元数据（路径 / 模型名 / 输入文本），远低于任何以字节形式
/// 混进来的内容 —— 一张 1MB 图片的 base64 就有约 145 万字符。
pub(crate) const MESSAGE_META_STRING_MAX: usize = 100_000;

/// 标题来源：`sessions.title_source` 的取值域。
///
/// - `heuristic`：首条用户消息切片（`title_from_user_content`），随时可被更好的标题替换；
/// - `ai`：模型总结出来的标题，每会话只生成一次（Node 侧据此决定是否再调模型）；
/// - `user`：用户手动改名，任何自动流程都不得覆盖。
pub(crate) const TITLE_SOURCE_HEURISTIC: &str = "heuristic";

pub(crate) const TITLE_SOURCE_AI: &str = "ai";

pub(crate) const TITLE_SOURCE_USER: &str = "user";

/// 标题来源只能由服务端枚举决定：写进来的是 SQL 列值，不能是任意字符串。
pub(crate) fn normalize_title_source(source: &str) -> Result<&'static str, CoreError> {
    match source.trim() {
        TITLE_SOURCE_AI => Ok(TITLE_SOURCE_AI),
        TITLE_SOURCE_USER => Ok(TITLE_SOURCE_USER),
        TITLE_SOURCE_HEURISTIC => Ok(TITLE_SOURCE_HEURISTIC),
        other => Err(CoreError::rpc(
            "INVALID_PARAMS",
            format!("未知的标题来源: {other}"),
        )),
    }
}

/// 这个会话标题是不是「占位 / 脏值」，也就是**可以被自动标题覆盖**吗。
///
/// 这是 Rust 侧唯一的判据：`touch_session`（补启发式标题）与
/// `maybe_set_title_from_user_message`（首条用户消息改标题）都调它 ——
/// 原先两处各写一份（其中一份还是逐字重复两遍的 SQL CASE），漏改一处就是半截状态。
///
/// 覆盖顺序与作者优先级见 `TITLE_SOURCE_*`：`user` > `ai` > `heuristic`；
/// 本判据只决定「heuristic 该不该落笔」，不参与作者优先级。
pub(crate) fn title_needs_repair(title: Option<&str>) -> bool {
    match title.map(str::trim).filter(|s| !s.is_empty()) {
        None => true,
        Some("对话") | Some("新对话") => true,
        Some(t) if t.starts_with("【叠云meta】") => true,
        Some(t) if t.starts_with('{') && t.contains("inputText") => true,
        Some(_) => false,
    }
}

pub(crate) fn maybe_set_title_from_user_message(
    conn: &Connection,
    session_id: &str,
    content: &str,
) -> Result<(), CoreError> {
    let existing: Option<String> = conn
        .query_row(
            "SELECT title FROM sessions WHERE id = ?1",
            params![session_id],
            |row| row.get::<_, Option<String>>(0),
        )
        .optional()?
        .flatten();
    // 「要不要覆盖」只有一个判据：`title_needs_repair`（占位 / 脏值才值得覆盖）。
    //
    // 原先这里还叠了 `!= 新对话` / `!= 对话` / `!starts_with("[计划]")` 三条 —— 都是死条件：
    // 前两条 `title_needs_repair` 已含；`[计划] xx` 本来就不是占位值，判据返回 false，
    // 加不加都是「不覆盖」。留着只会让人以为计划标题有专门保护，其实没有。
    if !title_needs_repair(existing.as_deref()) {
        return Ok(());
    }
    let plain = strip_message_meta(content);
    if let Some(t) = title_from_user_content(plain) {
        conn.execute(
            "UPDATE sessions SET title = ?1, title_source = ?2 WHERE id = ?3",
            params![t, TITLE_SOURCE_HEURISTIC, session_id],
        )?;
    }
    Ok(())
}

/// 会话结束即失效的临时 URL：object URL 与 data URL 落库后都没有读者。
pub(crate) fn is_ephemeral_meta_string(s: &str) -> bool {
    let t = s.trim_start();
    t.starts_with("data:") || t.starts_with("blob:")
}

/// 递归清洗 meta 值：丢弃「字节形态」的字符串（超长 / data: / blob:）。
///
/// `messages.content` 的 meta 只该存引用与元数据。base64 之类的东西没有读者
/// （回传与渲染都只认路径），却让单行涨到 MB 级、每次开会话都要经 Gateway RPC
/// 搬进 Renderer 再 JSON.parse。
pub(crate) fn sanitize_meta_value(value: Value) -> Option<Value> {
    match value {
        Value::String(s) => {
            if s.len() > MESSAGE_META_STRING_MAX || is_ephemeral_meta_string(&s) {
                None
            } else {
                Some(Value::String(s))
            }
        }
        Value::Array(items) => Some(Value::Array(
            items.into_iter().filter_map(sanitize_meta_value).collect(),
        )),
        Value::Object(map) => Some(Value::Object(
            map.into_iter()
                .filter_map(|(k, v)| sanitize_meta_value(v).map(|v| (k, v)))
                .collect(),
        )),
        other => Some(other),
    }
}

/// 清洗一条待落库的消息内容；无需改动时返回 `None`。
///
/// 这是「meta 里不得出现字节」不变量的唯一咽喉：`append_message` 落库前必经这里，
/// 将来任何新调用点写错也进不了库。
pub(crate) fn sanitize_persisted_message(content: &str) -> Option<String> {
    let rest = content.strip_prefix(MESSAGE_META_PREFIX)?;
    let idx = rest.find('\n')?;
    let (meta_raw, body) = rest.split_at(idx);
    let meta: Value = serde_json::from_str(meta_raw).ok()?;
    let cleaned = sanitize_meta_value(meta)?;
    let cleaned_raw = serde_json::to_string(&cleaned).ok()?;
    if cleaned_raw == meta_raw {
        return None;
    }
    Some(format!("{MESSAGE_META_PREFIX}{cleaned_raw}{body}"))
}

pub(crate) fn strip_message_meta(content: &str) -> &str {
    let s = content.trim();
    if let Some(rest) = s.strip_prefix(MESSAGE_META_PREFIX) {
        if let Some(idx) = rest.find('\n') {
            return rest[idx + 1..].trim();
        }
        return rest.trim();
    }
    s
}

/// 计划 / 定时触发那一轮的正文抬头是**本仓自己拼的**（`src/plans/plan-run-turn.js`）：
/// 第一行 `[计划 · 名字]`、第二行 `<时间> · 定时触发|目标续跑`。
/// 同一事实还有结构载体：meta 里的 `trigger{kind,planName,at}`。所以标题**先读 meta**——
/// 有 trigger 就直接用 planName，不再从正文里猜「哪一行像抬头」（旧写法
/// `contains('·') && contains("定时触发")` 会把用户正文里恰好提到这两个词的句子当抬头跳过）。
pub(crate) fn title_from_user_content(content: &str) -> Option<String> {
    let text = strip_message_meta(content);
    if text.is_empty() {
        return None;
    }
    if let Some(name) = message_meta_trigger_plan_name(content) {
        // 计划轮：标题就是计划名（比「第一句正文」更有信息量），正文抬头整段跳过
        if let Some(t) = first_line_title(&name) {
            return Some(t);
        }
    }
    // 无 meta 的历史行：只跳**本仓自己的抬头格式**（精确首尾），不做词面猜测
    for line in text.lines().map(str::trim).filter(|l| !l.is_empty()) {
        if line.starts_with("[计划 · ") && line.ends_with(']') {
            continue;
        }
        if line.ends_with(" · 定时触发") || line.ends_with(" · 目标续跑") {
            continue;
        }
        if let Some(t) = first_line_title(line) {
            return Some(t);
        }
    }
    first_line_title(text)
}

/// 从 `【叠云meta】{json}` 里取 `trigger` 对象（只有机器触发的一轮才有 trigger）。
/// 取不到就返回 None —— 不猜、不回落成正文解析。
pub(crate) fn message_meta_trigger(content: &str) -> Option<Value> {
    let rest = content.trim().strip_prefix(MESSAGE_META_PREFIX)?;
    let json_line = rest.lines().next().unwrap_or("").trim();
    if json_line.is_empty() {
        return None;
    }
    let value: Value = serde_json::from_str(json_line).ok()?;
    let trigger = value.get("trigger")?;
    if !trigger.is_object() {
        return None;
    }
    Some(trigger.clone())
}

/// `trigger.planName`（计划/定时触发轮才有）：标题用它当会话名。
pub(crate) fn message_meta_trigger_plan_name(content: &str) -> Option<String> {
    let trigger = message_meta_trigger(content)?;
    let name = trigger.get("planName").and_then(|v| v.as_str()).unwrap_or("").trim();
    if name.is_empty() {
        return None;
    }
    Some(name.to_string())
}

/// `trigger.kind`（`schedule` / `goal` / `alive` …）：侧栏按它决定「这类会话」的图标。
pub(crate) fn message_meta_trigger_kind(content: &str) -> Option<String> {
    let trigger = message_meta_trigger(content)?;
    let kind = trigger.get("kind").and_then(|v| v.as_str())?.trim();
    if kind.is_empty() {
        None
    } else {
        Some(kind.to_string())
    }
}

pub(crate) fn first_line_title(content: &str) -> Option<String> {
    let text = content.trim();
    if text.is_empty() {
        return None;
    }
    let first = text
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .unwrap_or(text);
    let normalized: String = first.split_whitespace().collect::<Vec<_>>().join(" ");
    let t = normalized.chars().take(48).collect::<String>();
    if t.is_empty() {
        None
    } else {
        Some(t)
    }
}

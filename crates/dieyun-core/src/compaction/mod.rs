mod atoms;
mod file_ops;
mod llm;
mod tokens;

use std::collections::HashSet;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

pub use atoms::{group_messages_into_atoms, Atom, COMPACT_DIGEST_MARK};
pub use tokens::{estimate_messages_tokens, estimate_text_tokens, estimate_tokens};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompactionPrompts {
    #[serde(default)]
    pub system: String,
    #[serde(default)]
    pub user: String,
    #[serde(default)]
    pub incremental_system: String,
    #[serde(default)]
    pub incremental_user: String,
    #[serde(default = "default_compact_prefix")]
    pub compact_prefix: String,
    #[serde(default)]
    pub compact_suffix: String,
}

fn default_compact_prefix() -> String {
    COMPACT_DIGEST_MARK.to_string()
}

impl Default for CompactionPrompts {
    fn default() -> Self {
        Self {
            system: "你是上下文压缩器。输出 JSON 摘要。摘要保留目标、约束、已完成与未完成项供后续继续，不能替代最后一条用户消息。".to_string(),
            user: "请压缩以下较早对话。摘要须让后续能继续同一会话，且不得改写最后一条用户消息。\n\n{CONVERSATION}".to_string(),
            incremental_system: String::new(),
            incremental_user: String::new(),
            compact_prefix: default_compact_prefix(),
            compact_suffix: String::new(),
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrepareParams {
    pub messages: Vec<Value>,
    #[serde(default = "default_budget")]
    pub token_budget: usize,
    #[serde(default = "default_trigger")]
    pub trigger_ratio: f64,
    #[serde(default = "default_cooldown")]
    pub cool_down_rounds: i64,
    #[serde(default)]
    pub force: bool,
    #[serde(default)]
    pub compaction_round_count: i64,
    #[serde(default)]
    pub cumulative_summary: Option<Value>,
    #[serde(default)]
    pub prompts: CompactionPrompts,
}

/// 与 `model-runtime-presets.js` 的「默认」档（128K）对齐：
/// 128_000 − 16_384(maxOutputTokens) − 16_384(contextReserveTokens)。
fn default_budget() -> usize {
    95_232
}
fn default_trigger() -> f64 {
    0.85
}
fn default_cooldown() -> i64 {
    6
}

/// 压缩成功后写入的轮次计数。必须 >0 且 < `default_cooldown()`：
/// 计数为 0 时 `prepare` 的冷却条件（`>0 && < cool_down`）不成立，
/// 压力未解除时会在下一轮立刻复压，每次最多拖住发送 210s。
const POST_COMPACTION_ROUND_COUNT: i64 = 1;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrepareResult {
    pub compacted: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tokens_before: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tokens_after: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub need_llm: Option<LlmCompactRequest>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LlmCompactRequest {
    pub mode: String,
    pub system: String,
    pub user: String,
    pub folded_indices: Vec<usize>,
    pub folded_transcript: String,
    pub tokens_before: usize,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyParams {
    pub messages: Vec<Value>,
    pub summary_json: Value,
    pub folded_indices: Vec<usize>,
    #[serde(default)]
    pub prompts: CompactionPrompts,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyResult {
    pub compacted: bool,
    pub messages: Vec<Value>,
    pub tokens_before: usize,
    pub tokens_after: usize,
    pub summary: Value,
    pub folded_transcript: String,
    pub pinned_user_count: usize,
}

pub fn prepare(params: PrepareParams) -> Result<PrepareResult, crate::error::CoreError> {
    let budget = params.token_budget.max(8192);
    let trigger = (budget as f64 * params.trigger_ratio.clamp(0.3, 0.95)) as usize;
    let est = estimate_messages_tokens(&params.messages);
    if est < trigger {
        return Ok(PrepareResult {
            compacted: false,
            tokens_before: Some(est),
            tokens_after: Some(est),
            need_llm: None,
        });
    }

    let non_system: Vec<Value> = params
        .messages
        .iter()
        .filter(|m| m.get("role").and_then(|v| v.as_str()) != Some("system"))
        .cloned()
        .collect();

    if !params.force
        && params.compaction_round_count > 0
        && params.compaction_round_count < params.cool_down_rounds
    {
        return Ok(PrepareResult {
            compacted: false,
            tokens_before: Some(est),
            tokens_after: Some(est),
            need_llm: None,
        });
    }

    let atoms = group_messages_into_atoms(&non_system);
    let compressible: Vec<(usize, &Atom)> = atoms
        .iter()
        .enumerate()
        .filter(|(_, a)| !atoms::is_pinned_atom(a))
        .collect();

    if compressible.len() < 2 {
        return Ok(PrepareResult {
            compacted: false,
            tokens_before: Some(est),
            tokens_after: Some(est),
            need_llm: None,
        });
    }

    let recent_tail = compressible.len().max(4).div_ceil(4).max(1);
    let recent_set: HashSet<usize> = compressible
        .iter()
        .rev()
        .take(recent_tail)
        .map(|(i, _)| *i)
        .collect();

    if let Some(prev) = &params.cumulative_summary {
        // 摘要提示与折叠集合必须同源：只把「本次真正会被折叠」的原子喂给摘要模型。
        // 若提示取前一半、折叠取前 3/4，错位的那部分会被折叠却从未进入摘要，
        // 只有 apply() 里的 file_ops 能靠路径幸存，叙述内容静默丢失。
        let folded_indices: Vec<usize> = compressible
            .iter()
            .filter(|(i, _)| !recent_set.contains(i))
            .map(|(i, _)| *i)
            .collect();
        let folded_atoms: Vec<Atom> = folded_indices.iter().map(|i| atoms[*i].clone()).collect();
        if folded_atoms.len() >= 2 {
            let conversation = atoms::format_atoms_for_summary(&folded_atoms)
                .chars()
                .take(32_000)
                .collect::<String>();
            let prev_text = if prev.is_string() {
                prev.as_str().unwrap_or("").to_string()
            } else {
                prev.to_string()
            };
            let inc_user = if params.prompts.incremental_user.is_empty() {
                format!("Previous summary:\n{prev_text}\n\nNew conversation:\n{conversation}")
            } else {
                params
                    .prompts
                    .incremental_user
                    .replace("{PREVIOUS_SUMMARY}", &prev_text)
                    .replace("{NEW_CONVERSATION}", &conversation)
            };
            let inc_system = if params.prompts.incremental_system.is_empty() {
                params.prompts.system.clone()
            } else {
                params.prompts.incremental_system.clone()
            };
            return Ok(PrepareResult {
                compacted: false,
                tokens_before: Some(est),
                tokens_after: None,
                need_llm: Some(LlmCompactRequest {
                    mode: "incremental".into(),
                    system: inc_system,
                    user: inc_user,
                    folded_indices,
                    folded_transcript: atoms::format_atoms_for_summary(&folded_atoms)
                        .chars()
                        .take(120_000)
                        .collect(),
                    tokens_before: est,
                }),
            });
        }
    }

    let recent_budget = (budget as f64 * 0.42) as usize;
    let compressible_indices: Vec<usize> = compressible.iter().map(|(i, _)| *i).collect();
    let compressible_atoms: Vec<Atom> = compressible_indices
        .iter()
        .map(|i| atoms[*i].clone())
        .collect();
    let (middle, _recent) = atoms::partition_atoms(&compressible_atoms, recent_budget);
    let to_fold: Vec<usize> = if middle.len() >= 2 {
        middle
            .into_iter()
            .map(|i| compressible_indices[i])
            .collect()
    } else {
        let keep = (compressible.len() as f64 * 0.3).floor() as usize;
        compressible_indices
            .iter()
            .take(compressible.len().saturating_sub(keep.max(1)))
            .copied()
            .collect()
    };

    if to_fold.is_empty() {
        return Ok(PrepareResult {
            compacted: false,
            tokens_before: Some(est),
            tokens_after: Some(est),
            need_llm: None,
        });
    }

    let _ = _recent;
    let folded_atoms: Vec<Atom> = to_fold.iter().map(|i| atoms[*i].clone()).collect();
    let conversation = atoms::format_atoms_for_summary(&folded_atoms)
        .chars()
        .take(48_000)
        .collect::<String>();
    let user = params.prompts.user.replace("{CONVERSATION}", &conversation);

    Ok(PrepareResult {
        compacted: false,
        tokens_before: Some(est),
        tokens_after: None,
        need_llm: Some(LlmCompactRequest {
            mode: "full".into(),
            system: params.prompts.system.clone(),
            user,
            folded_indices: to_fold,
            folded_transcript: atoms::format_atoms_for_summary(&folded_atoms)
                .chars()
                .take(120_000)
                .collect(),
            tokens_before: est,
        }),
    })
}

pub fn apply(params: ApplyParams) -> ApplyResult {
    let est = estimate_messages_tokens(&params.messages);
    let systems: Vec<Value> = params
        .messages
        .iter()
        .filter(|m| m.get("role").and_then(|v| v.as_str()) == Some("system"))
        .cloned()
        .collect();
    let non_system: Vec<Value> = params
        .messages
        .iter()
        .filter(|m| m.get("role").and_then(|v| v.as_str()) != Some("system"))
        .cloned()
        .collect();
    let atoms = group_messages_into_atoms(&non_system);
    let folded: HashSet<usize> = params.folded_indices.into_iter().collect();
    let mut folded_messages = Vec::new();
    for (i, atom) in atoms.iter().enumerate() {
        if !folded.contains(&i) {
            continue;
        }
        if let Some(m) = &atom.assistant {
            folded_messages.push(m.clone());
        }
        folded_messages.extend(atom.tools.iter().cloned());
        if let Some(m) = &atom.other {
            folded_messages.push(m.clone());
        }
    }
    let file_ops = file_ops::extract_file_ops_from_messages(&folded_messages);
    let summary_json = file_ops::merge_summary_file_ops(&params.summary_json, &file_ops);
    let (compact_user, compact_ack) = atoms::build_digest_messages(
        &summary_json,
        &params.prompts.compact_prefix,
        &params.prompts.compact_suffix,
    );
    let next =
        atoms::reassemble_after_compaction(&systems, &atoms, &folded, compact_user, compact_ack);
    let tokens_after = estimate_messages_tokens(&next);
    let pinned = atoms.iter().filter(|a| atoms::is_user_atom(a)).count();
    ApplyResult {
        compacted: true,
        messages: next,
        tokens_before: est,
        tokens_after,
        summary: summary_json,
        folded_transcript: String::new(),
        pinned_user_count: pinned,
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MaybeCompactParams {
    #[serde(flatten)]
    pub prepare: PrepareParams,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub llm: Option<crate::config::LlmConfig>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MaybeCompactResult {
    pub compacted: bool,
    pub messages: Vec<Value>,
    pub tokens_before: usize,
    pub tokens_after: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub summary: Option<Value>,
    #[serde(default)]
    pub folded_transcript: String,
    #[serde(default)]
    pub pinned_user_count: usize,
    pub compaction_round_count: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cumulative_summary: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub llm_usage: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub llm_model: Option<String>,
    /// 跳过原因：`llm_error` 等（未压缩时给 UI 展示）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub compaction_skipped: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub llm_error: Option<String>,
}

pub async fn maybe_compact(
    llm: &crate::config::LlmConfig,
    params: MaybeCompactParams,
) -> Result<MaybeCompactResult, crate::error::CoreError> {
    let llm_override = params.llm.clone();
    let model_override = params.model.clone();
    let mut round_count = params.prepare.compaction_round_count;
    let source_messages = params.prepare.messages.clone();
    let cumulative = params.prepare.cumulative_summary.clone();
    let prompts = params.prepare.prompts.clone();
    let prep = prepare(params.prepare)?;
    let tokens_before = prep.tokens_before.unwrap_or(0);

    let Some(need) = prep.need_llm else {
        if !prep.compacted {
            round_count += 1;
        }
        return Ok(MaybeCompactResult {
            compacted: false,
            messages: source_messages,
            tokens_before,
            tokens_after: prep.tokens_after.unwrap_or(tokens_before),
            summary: None,
            folded_transcript: String::new(),
            pinned_user_count: 0,
            compaction_round_count: round_count,
            cumulative_summary: cumulative,
            llm_usage: None,
            llm_model: None,
            compaction_skipped: None,
            llm_error: None,
        });
    };

    let model = model_override.as_deref().unwrap_or("");
    let llm_cfg = llm_override.as_ref().unwrap_or(llm);
    let llm_resp = match llm::chat_completion(llm_cfg, model, &need.system, &need.user).await {
        Ok(r) => r,
        Err(err) => {
            eprintln!("[compaction-llm] skip compaction after LLM failure: {err}");
            round_count += 1;
            return Ok(MaybeCompactResult {
                compacted: false,
                messages: source_messages,
                tokens_before,
                tokens_after: prep.tokens_after.unwrap_or(tokens_before),
                summary: None,
                folded_transcript: String::new(),
                pinned_user_count: 0,
                compaction_round_count: round_count,
                cumulative_summary: cumulative,
                llm_usage: None,
                llm_model: None,
                compaction_skipped: Some("llm_error".into()),
                llm_error: Some(err.to_string()),
            });
        }
    };
    let raw = llm_resp.content;
    let summary_json = llm::parse_compaction_json(&raw);
    let applied = apply(ApplyParams {
        messages: source_messages,
        summary_json: summary_json.clone(),
        folded_indices: need.folded_indices,
        prompts,
    });
    let folded = if need.folded_transcript.is_empty() {
        applied.folded_transcript.clone()
    } else {
        need.folded_transcript
    };

    Ok(MaybeCompactResult {
        compacted: true,
        messages: applied.messages,
        tokens_before: applied.tokens_before,
        tokens_after: applied.tokens_after,
        summary: Some(applied.summary),
        folded_transcript: folded,
        pinned_user_count: applied.pinned_user_count,
        compaction_round_count: POST_COMPACTION_ROUND_COUNT,
        cumulative_summary: Some(summary_json),
        llm_usage: llm_resp.usage,
        llm_model: Some(llm_resp.model),
        compaction_skipped: None,
        llm_error: None,
    })
}

pub fn estimate(params: &Value) -> Value {
    let messages = params
        .get("messages")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let budget = params
        .get("tokenBudget")
        .and_then(|v| v.as_u64())
        .unwrap_or_else(|| default_budget() as u64) as usize;
    let ratio = params
        .get("triggerRatio")
        .and_then(|v| v.as_f64())
        .unwrap_or_else(default_trigger);
    let used = estimate_messages_tokens(&messages);
    json!({
        "tokens": used,
        "budget": budget,
        "trigger": ((budget as f64 * ratio) as usize),
        "overTrigger": used >= ((budget as f64 * ratio) as usize),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn prepare_skips_small_context() {
        let r = prepare(PrepareParams {
            messages: vec![json!({"role":"user","content":"hi"})],
            token_budget: 96_000,
            trigger_ratio: 0.72,
            cool_down_rounds: 6,
            force: false,
            compaction_round_count: 0,
            cumulative_summary: None,
            prompts: CompactionPrompts::default(),
        })
        .unwrap();
        assert!(!r.compacted);
        assert!(r.need_llm.is_none());
    }

    #[test]
    fn prepare_requests_llm_for_few_huge_messages() {
        let huge = "x".repeat(80_000);
        let r = prepare(PrepareParams {
            messages: vec![
                json!({"role":"user","content": huge}),
                json!({"role":"assistant","content": huge}),
                json!({"role":"user","content": huge}),
                json!({"role":"assistant","content": huge}),
                json!({"role":"user","content":"now"}),
            ],
            token_budget: 96_000,
            trigger_ratio: 0.72,
            cool_down_rounds: 6,
            force: false,
            compaction_round_count: 0,
            cumulative_summary: None,
            prompts: CompactionPrompts::default(),
        })
        .unwrap();
        assert!(r.need_llm.is_some());
    }

    #[test]
    fn apply_merges_tool_file_paths_into_digest() {
        let messages = vec![
            json!({"role":"user","content":"fix a"}),
            json!({
                "role":"assistant",
                "content":"edit",
                "tool_calls":[{
                    "id":"1",
                    "type":"function",
                    "function":{"name":"fs_edit","arguments":"{\"filePath\":\"src/app.js\",\"oldString\":\"a\",\"newString\":\"b\"}"}
                }]
            }),
            json!({"role":"tool","tool_call_id":"1","content":"ok"}),
            json!({"role":"user","content":"keep me"}),
        ];
        let atoms = group_messages_into_atoms(
            &messages
                .iter()
                .filter(|m| m.get("role").and_then(|v| v.as_str()) != Some("system"))
                .cloned()
                .collect::<Vec<_>>(),
        );
        let fold_idx = atoms
            .iter()
            .enumerate()
            .find(|(_, a)| a.assistant.is_some())
            .map(|(i, _)| i)
            .unwrap();
        let applied = apply(ApplyParams {
            messages,
            summary_json: json!({"summary":"did work"}),
            folded_indices: vec![fold_idx],
            prompts: CompactionPrompts::default(),
        });
        assert!(applied.compacted);
        let digest = applied
            .messages
            .iter()
            .find(|m| {
                m.get("content")
                    .and_then(|c| c.as_str())
                    .map(|s| s.contains("【对话摘要】"))
                    .unwrap_or(false)
            })
            .and_then(|m| m.get("content").and_then(|c| c.as_str()))
            .unwrap_or("");
        assert!(
            digest.contains("src/app.js"),
            "digest should keep edited path, got {digest}"
        );
        assert_eq!(applied.summary["filesModified"][0], "src/app.js");
    }

    /// 增量压缩：摘要提示覆盖的原子必须与 folded_indices 完全一致，
    /// 否则错位部分的叙述内容会被折叠却从未被摘要。
    #[test]
    fn incremental_prompt_covers_every_folded_atom() {
        let big = "测".repeat(2_000);
        let mut messages = vec![json!({"role":"user","content":"task"})];
        for i in 0..8 {
            messages.push(json!({
                "role":"assistant",
                "content": format!("atom-{i} {big}")
            }));
        }
        let r = prepare(PrepareParams {
            messages,
            token_budget: 8192,
            trigger_ratio: 0.85,
            cool_down_rounds: 6,
            force: false,
            compaction_round_count: 0,
            cumulative_summary: Some(json!("prev summary")),
            prompts: CompactionPrompts::default(),
        })
        .unwrap();
        let need = r.need_llm.expect("should request incremental summary");
        assert_eq!(need.mode, "incremental");
        // 压缩集 = 全部 8 个 assistant 原子去掉最近 1/4（末 2 个）→ atoms[1..=6]
        assert_eq!(need.folded_indices, vec![1, 2, 3, 4, 5, 6]);
        // 每一个将被折叠的原子都必须出现在摘要提示里（旧实现只喂前一半，丢掉 atom-4/5）
        for i in 0..6 {
            assert!(
                need.user.contains(&format!("atom-{i}")),
                "prompt must cover folded atom-{i}"
            );
        }
        // 最近的原子不折叠，也不该被当成本次压缩对象
        assert!(!need.user.contains("atom-6"));
    }

    /// 冷却：刚压过一轮（round_count = POST_COMPACTION_ROUND_COUNT）时不得复压。
    #[test]
    fn cooldown_blocks_compaction_right_after_a_round() {
        let huge = "x".repeat(80_000);
        let r = prepare(PrepareParams {
            messages: vec![
                json!({"role":"user","content": huge}),
                json!({"role":"assistant","content": huge}),
                json!({"role":"assistant","content": huge}),
            ],
            token_budget: 8192,
            trigger_ratio: 0.85,
            cool_down_rounds: 6,
            force: false,
            compaction_round_count: POST_COMPACTION_ROUND_COUNT,
            cumulative_summary: None,
            prompts: CompactionPrompts::default(),
        })
        .unwrap();
        assert!(
            r.need_llm.is_none(),
            "cooldown must suppress compaction after a recent round"
        );
        // force 必须能穿透冷却（上下文溢出兜底路径依赖它）
        let forced = prepare(PrepareParams {
            messages: vec![
                json!({"role":"user","content": huge}),
                json!({"role":"assistant","content": huge}),
                json!({"role":"assistant","content": huge}),
            ],
            token_budget: 8192,
            trigger_ratio: 0.85,
            cool_down_rounds: 6,
            force: true,
            compaction_round_count: POST_COMPACTION_ROUND_COUNT,
            cumulative_summary: None,
            prompts: CompactionPrompts::default(),
        })
        .unwrap();
        assert!(forced.need_llm.is_some(), "force must bypass cooldown");
    }

    #[test]
    fn post_compaction_round_count_stays_inside_cooldown() {
        assert!(POST_COMPACTION_ROUND_COUNT > 0);
        assert!(POST_COMPACTION_ROUND_COUNT < default_cooldown());
    }
}

//! 跨语言常量的唯一来源：`assets/agent-shared.json`（`include_str!` 编译期嵌入）。
//!
//! 为什么在 Rust 里也读这份文件：token 折算系数、预算地板、触发比夹取、读上限、慢请求
//! 阈值、上下文溢出词表 —— 这些知识 Node 与 Rust **两边都要用**，而两侧互相 `require`
//! 不到。历史上靠手抄 + 注释「与 Rust 同值」，2026-11 审计实测已经漂了两处（预算地板
//! 4096/8192、溢出词表少三条），都没有任何测试变红。
//!
//! 规则：
//! - 值只写在 `assets/agent-shared.json`，本模块只负责解析；
//! - 结构体字段与 JSON 一一对应（`camelCase`），**漏字段会 panic**（宁可编译/启动就炸，
//!   也不要静默用默认值 —— 那正是双写的成因）；
//! - 加键必须两侧都有人读，`scripts/check-shared-constants.cjs` 会验。

use std::sync::OnceLock;

const RAW: &str = include_str!("../../../assets/agent-shared.json");

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SharedConstants {
    pub version: u32,
    pub token_estimate: TokenEstimate,
    pub compaction: CompactionNumbers,
    pub read_limits: ReadLimits,
    pub rpc: RpcNumbers,
    pub snippets: SnippetNumbers,
    /// 上游「上下文溢出」错误文案（小写子串）。两侧都用 `contains` 判，不各写一份正则。
    pub context_overflow_patterns: Vec<String>,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenEstimate {
    /// 非 CJK 字符 → token 的除数。
    pub chars_per_token: f64,
    /// CJK 字符 → token 的除数（一个汉字大致 1/1.5 token）。
    pub cjk_chars_per_token: f64,
    /// 一个图片 part 的等效字符数；token 数由 `image_part_equiv_tokens()` 换算。
    pub image_part_eq_chars: f64,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompactionNumbers {
    /// 上下文窗口地板：低于它的窗口不当作「有效窗口」（Node 由它派生输入预算）。
    /// 内核只在测试里读它 —— 它保证 `fold.rs` 的预算守卫不会高过 Node 派生的合法预算。
    pub context_window_floor_tokens: usize,
    pub trigger_ratio_min: f64,
    pub trigger_ratio_max: f64,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadLimits {
    pub default_max_bytes: u64,
    pub absolute_max_bytes: u64,
    pub index_file_max_bytes: u64,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RpcNumbers {
    pub slow_log_ms: u64,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnippetNumbers {
    /// Node 侧最终展示预算（字符）。
    pub codebase_snippet_max_chars: usize,
    /// Rust 侧单条命中预算（字符）—— 必须大于 Node 的展示预算，否则 Rust 先截断、
    /// Node 再也补不回来（历史上这里是 3600「字节」≈ 1200 汉字，正好相反）。
    pub rust_budget_chars: usize,
}

pub fn shared() -> &'static SharedConstants {
    static ONCE: OnceLock<SharedConstants> = OnceLock::new();
    ONCE.get_or_init(|| {
        serde_json::from_str(RAW).expect("assets/agent-shared.json 与 shared.rs 结构不一致")
    })
}

/// 一个图片 part 的等效 token 数（由等效字符数 ÷ 折算系数得出）。
pub fn image_part_equiv_tokens() -> usize {
    let s = &shared().token_estimate;
    (s.image_part_eq_chars / s.chars_per_token).round() as usize
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 两侧共享的系数必须落在合理区间：这类「看着像常量、其实影响全局」的数字，
    /// 一个手误（3.2 → 32）会让上下文账本整体失真且没有任何报错。
    #[test]
    fn coefficients_are_in_sane_ranges() {
        let s = shared();
        assert!((1.0..=8.0).contains(&s.token_estimate.chars_per_token));
        assert!((1.0..=4.0).contains(&s.token_estimate.cjk_chars_per_token));
        assert!(s.token_estimate.image_part_eq_chars > 0.0);
        assert!(s.compaction.trigger_ratio_min < s.compaction.trigger_ratio_max);
        assert!(s.read_limits.default_max_bytes <= s.read_limits.absolute_max_bytes);
        assert!(!s.context_overflow_patterns.is_empty());
        for p in &s.context_overflow_patterns {
            assert_eq!(*p, p.to_ascii_lowercase(), "词表必须是小写：{p}");
        }
    }

    /// 图片等效 token 必须仍是 1875（= 6000 ÷ 3.2）：这个数被
    /// `test/fixtures/token-estimate-cases.json` 的图片用例钉着，改系数就会变。
    #[test]
    fn image_part_equiv_tokens_is_1875() {
        assert_eq!(image_part_equiv_tokens(), 1875);
    }

    /// 两个「地板」不是同一个数、也不能反过来：Node 用窗口地板派生预算，内核再兜一层。
    /// 若哪天有人把内核守卫调到窗口地板之上，Node 算出的合法预算会被内核静默抬高。
    ///
    /// 内核守卫是 Rust 独有的数字（Node 不需要它），所以它不在共享文件里 ——
    /// 但两者必须满足这条关系，这就是「共享文件」要 contain 窗口地板的原因。
    #[test]
    fn budget_guard_never_exceeds_the_context_window_floor() {
        let floor = shared().compaction.context_window_floor_tokens;
        let guard = crate::compaction::MIN_BUDGET_TOKENS;
        assert!(guard <= floor, "guard={guard} floor={floor}");
    }

    /// Rust 的摘录预算必须**大于** Node 的展示预算，否则 Rust 先截断、命中词直接没了。
    #[test]
    fn snippet_budget_is_larger_than_node_display_budget() {
        let s = &shared().snippets;
        assert!(
            s.rust_budget_chars > s.codebase_snippet_max_chars,
            "rust={} node={}",
            s.rust_budget_chars,
            s.codebase_snippet_max_chars
        );
    }
}

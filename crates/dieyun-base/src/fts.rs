//! FTS5 查询串的**唯一**构造点。
//!
//! 索引（`chunks_fts`）与记忆（`long_memories_fts`）都要把「用户/模型给的一段话」
//! 变成 SQLite `MATCH` 的查询串。这件事看着简单，实则三处都要对：
//!
//! 1. **注入**：FTS5 的 MATCH 有自己的语法（`AND` / `OR` / `NOT` / `NEAR` / `*` / `"`），
//!    原样塞进用户输入，一个引号就能让查询报错或语义全变；
//! 2. **切分**：自然语言查询按空白与标点切开，每个片段各自成为短语（`"片段"`）；
//! 3. **召回倾向**：片段之间用 `OR` 而不是 `AND` —— 一个词不命中就整条查不到，
//!    对「中文长句 + 代码标识符」这种混合查询过于苛刻。
//!
//! 以前这套规则只存在于 `index/search.rs` 里，记忆侧是另一套（手写 CJK 打分）。
//! 现在统一到这里：两个调用方只提供**表名**，查询串怎么造只有这一份实现。

/// FTS5 `MATCH` 查询串的最大片段数。
///
/// 一个查询带上十几个片段已经没什么区分度，却会让 FTS 的 OR 展开变得很贵。
const MAX_TERMS: usize = 12;

/// 片段最小字节数。单字节（单个 ASCII 字符）噪声太大，直接丢。
///
/// 注意这是**字节**数：一个中文字符是 3 字节，所以中文单字不会被这里滤掉。
const MIN_TERM_BYTES: usize = 2;

/// trigram 索引能命中的最短片段长度（字符数，不是字节数）。
const MIN_TRIGRAM_CHARS: usize = 3;

/// 把一段自然语言 / 代码混合文本变成 FTS5 查询串。
///
/// 返回 `None` 表示「没有任何可用片段」（空查询、纯标点），调用方应直接返回空结果，
/// 不要把空串塞进 `MATCH`（那在 FTS5 里是语法错误）。
pub fn match_query(query: &str) -> Option<String> {
    let terms: Vec<String> = terms(query)
        .into_iter()
        .take(MAX_TERMS)
        .map(|p| format!("\"{p}\""))
        .collect();
    if terms.is_empty() {
        None
    } else {
        Some(terms.join(" OR "))
    }
}

/// trigram 分词器的硬约束：只有 ≥3 字符的片段才进得了索引。
///
/// 用 trigram 的表在查询片段全短于 3 字符时（中文双字词 `索引`、`记忆` 很常见）
/// `MATCH` 必然空结果 —— 这不是 bug，是索引结构决定的。调用方需要据此改走
/// 子串扫描，本函数就是那个判断的唯一来源。
pub fn has_indexable_term(query: &str) -> bool {
    terms(query)
        .iter()
        .any(|p| p.chars().count() >= MIN_TRIGRAM_CHARS)
}

/// 首个命中片段在 `content` 里的**字符**下标，用于围绕命中处截取摘录。
///
/// 与 `match_query` / `has_indexable_term` 共用同一份切分规则：摘录要围绕「真正被检索的
/// 词」展开，切分规则差一点就会把摘录截在毫不相关的位置上。找不到时返回 `None`，
/// 调用方退回头部截断（不是错误：子串可能被词法切分改写过）。
/// 首个命中词在 `content` 里的**字节**偏移（大小写不敏感）；找不到返回 `None`。
///
/// 这是「命中位置」的**唯一**实现：`fts::first_hit_index`（要字符下标，做摘录）与
/// `index::search::first_hit_line`（要行号）都从它派生。此前两份各写一遍、口径还不一样
/// （一份大小写不敏感、一份区分大小写），于是同一段正文的「摘要位置」与「命中行」会指向
/// 不同的地方 —— 用户看到摘录里没有那个词，而行号却标着命中。
pub fn first_hit_byte(content: &str, terms: &[String]) -> Option<usize> {
    // 小写化可能**改变字节长度**（如 `İ` → 两个码点）。长度变了就不能拿小写串的下标当
    // 原文下标用 —— 那种情况下退回区分大小写的匹配：宁可「没找到」，也不给一个错位置。
    let lowered = content.to_lowercase();
    let lower_usable = lowered.len() == content.len();
    let mut best: Option<usize> = None;
    for term in terms {
        if term.is_empty() {
            continue;
        }
        let hit = content.find(term.as_str()).or_else(|| {
            if !lower_usable {
                return None;
            }
            lowered
                .find(&term.to_lowercase())
                .filter(|pos| content.is_char_boundary(*pos))
        });
        if let Some(pos) = hit {
            best = Some(best.map_or(pos, |cur| cur.min(pos)));
        }
    }
    best
}

/// 首个命中片段的**字符**下标，用于围绕命中处截取摘录。
///
/// 与 `match_query` / `has_indexable_term` 共用同一份切分规则：摘录要围绕「真正被检索的
/// 词」展开，切分规则差一点就会把摘录截在毫不相关的位置上。找不到时返回 `None`，
/// 调用方退回头部截断（不是错误：子串可能被词法切分改写）。
pub fn first_hit_index(content: &str, query: &str) -> Option<usize> {
    let byte = first_hit_byte(content, &terms(query))?;
    Some(content[..byte].chars().count())
}

/// 自然语言 / 代码混合文本 → 纯文本片段（已去掉 FTS5 语法字符）。
fn terms(query: &str) -> Vec<String> {
    query
        .split(|c: char| c.is_whitespace() || "/\\.,;:!?，。；：、()[]{}<>\"'`".contains(c))
        .map(strip_fts_specials)
        .filter(|p| p.len() >= MIN_TERM_BYTES)
        .collect()
}

/// 一次查询被切成的片段（与 `match_query` / `has_indexable_term` **同一份切分规则**，
/// 同样按 `MAX_TERMS` 截断）。
///
/// 调用方要回答「这条命中覆盖了查询的几成」时用它 —— 别在别处再切一遍。
pub fn query_terms(query: &str) -> Vec<String> {
    terms(query).into_iter().take(MAX_TERMS).collect()
}

/// 命中覆盖度 ∈ (0,1]：`content` 里出现了这次查询的几成片段（大小写不敏感的子串判定）。
///
/// 为什么必须有它：片段之间是 **OR**（见文件头第 3 条），所以「有命中」不等于「对上了」——
/// 一条只蹭到一个常见词的长句照样能排到最前；而 bm25 的量纲随语料与查询词长度漂移，
/// 当不了绝对强度。覆盖度是这条链路上**唯一**与语料无关的绝对量：查询给了 3 个片段，
/// 命中 1 个就是 1/3，跟语料多大、词多常见都没关系。
pub fn term_coverage(content: &str, terms: &[String]) -> f64 {
    if terms.is_empty() {
        return 1.0;
    }
    let lowered = content.to_lowercase();
    let hit = terms
        .iter()
        .filter(|t| lowered.contains(&t.to_lowercase()))
        .count();
    hit as f64 / terms.len() as f64
}

/// 去掉 FTS5 的语法字符与引号，留下纯文本片段。
///
/// 只删不改写：多删的后果是「少一个召回词」，改写（比如把 `-` 换成空格）则会
/// 悄悄改变用户的查询意图。
fn strip_fts_specials(part: &str) -> String {
    part.replace(['"', '\'', '*', '^', ':', '{', '}'], "").trim().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wraps_terms_as_phrases_with_or() {
        assert_eq!(
            match_query("代码库 索引 parseConfig"),
            Some("\"代码库\" OR \"索引\" OR \"parseConfig\"".to_string())
        );
    }

    #[test]
    fn strips_fts_specials_so_match_never_breaks() {
        // 引号 / 星号 / 冒号都是 FTS5 语法：留下任何一个都会改变语义或直接报错。
        let q = match_query("foo\"bar OR *baz^ qux:").expect("有可用片段");
        assert!(!q.contains('*'), "{q}");
        assert!(!q.contains('^'), "{q}");
        assert_eq!(q.matches('"').count(), q.matches(" OR ").count() * 2 + 2, "{q}");
    }

    #[test]
    fn empty_or_punctuation_only_yields_none() {
        assert_eq!(match_query(""), None);
        assert_eq!(match_query("   "), None);
        assert_eq!(match_query("，。；：、"), None);
    }

    #[test]
    fn caps_term_count() {
        let long = (0..40).map(|i| format!("term{i}")).collect::<Vec<_>>().join(" ");
        let q = match_query(&long).expect("有可用片段");
        assert_eq!(q.matches(" OR ").count() + 1, MAX_TERMS);
    }

    #[test]
    fn short_cjk_terms_are_not_indexable() {        // trigram 索引里 2 字符片段查不到 —— 调用方要据此改走子串扫描
        assert!(!has_indexable_term("索引"));
        assert!(!has_indexable_term("记忆 图谱"));
        assert!(has_indexable_term("ANN"));
        assert!(has_indexable_term("代码库"));
        assert!(has_indexable_term("索引 parseConfig"));
    }

    #[test]
    fn first_hit_index_points_at_the_matched_term() {
        let content = "先读 README，然后改 parseConfig 里的分支";
        let idx = first_hit_index(content, "parseConfig").expect("应命中");
        assert_eq!(content.chars().nth(idx), Some('p'));
    }

    #[test]
    fn first_hit_index_is_case_insensitive_and_byte_safe() {
        // 小写化后字节偏移与原文一致才允许换算成字符下标
        let content = "Line one\nparSECONFIG here";
        assert_eq!(first_hit_index(content, "parseconfig"), Some(9));
        assert_eq!(first_hit_index("完全无关", "parseConfig"), None);
        assert_eq!(first_hit_index("任意内容", ""), None);
    }

    /// 回归（P3）：命中位置只有一份实现 —— 摘录用的字符下标与命中行用的字节偏移同源。
    ///
    /// 此前 `index::search::first_hit_line` 自己写了一遍 `content.find(term)`（区分大小写），
    /// 与这里（不区分）口径不同：同一段正文会出现「摘录围绕的位置」和「命中行」对不上。
    #[test]
    fn hit_position_has_a_single_source() {
        let content = "line1\nLINE2: Fatal Error here\nline3";
        let terms = vec!["error".to_string()];

        let byte = first_hit_byte(content, &terms).expect("应命中");
        assert_eq!(&content[byte..byte + "Error".len()], "Error", "大小写不敏感");

        // 字符下标由同一处派生
        assert_eq!(
            first_hit_index(content, "error"),
            Some(content[..byte].chars().count())
        );
        // 行号也从它派生（这里落在第 2 行，1 基偏移由调用方加）
        assert_eq!(content[..byte].matches('\n').count(), 1);

        assert!(first_hit_byte(content, &["nope".to_string()]).is_none());
        assert!(first_hit_index(content, "nope").is_none());
    }

    /// 覆盖度：片段之间是 OR，所以「有命中」不等于「对上了」—— 覆盖度是这里唯一的绝对量。
    #[test]
    fn term_coverage_counts_matched_fragments() {
        let terms = query_terms("parseConfig 索引 cfg");
        assert_eq!(terms.len(), 3);
        assert!((term_coverage("parseConfig 的索引实现", &terms) - 2.0 / 3.0).abs() < 1e-9);
        assert_eq!(term_coverage("完全无关的正文", &terms), 0.0);
        assert_eq!(term_coverage("随便什么", &[]), 1.0, "没有片段时不做折扣");
    }

    #[test]
    fn term_coverage_is_case_insensitive_and_capped() {
        let terms = query_terms("ParseConfig");
        assert_eq!(term_coverage("... parseconfig ...", &terms), 1.0);

        // 上限与 match_query 共用（同一份切分 + 同一个 MAX_TERMS）
        let long = (0..40).map(|i| format!("term{i}")).collect::<Vec<_>>().join(" ");
        assert_eq!(query_terms(&long).len(), MAX_TERMS);
    }
}

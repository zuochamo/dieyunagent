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

/// 自然语言 / 代码混合文本 → 纯文本片段（已去掉 FTS5 语法字符）。
fn terms(query: &str) -> Vec<String> {
    query
        .split(|c: char| c.is_whitespace() || "/\\.,;:!?，。；：、()[]{}<>\"'`".contains(c))
        .map(strip_fts_specials)
        .filter(|p| p.len() >= MIN_TERM_BYTES)
        .collect()
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
    fn short_cjk_terms_are_not_indexable() {
        // trigram 索引里 2 字符片段查不到 —— 调用方要据此改走子串扫描
        assert!(!has_indexable_term("索引"));
        assert!(!has_indexable_term("记忆 图谱"));
        assert!(has_indexable_term("ANN"));
        assert!(has_indexable_term("代码库"));
        assert!(has_indexable_term("索引 parseConfig"));
    }
}

//! 启发式抽取的三件套：**标识符判定 / 调用目标扫描 / 去注释**。
//!
//! 这四个语言模块（`symbols` / `go` / `python` / `rust_lang`）以前各写一遍
//! `take_ident` + `scan_call_targets` + `CALL_SKIP` + `strip_comment`，`treesitter/extract.rs`
//! 还有第五份 `is_ident`。它们的**规则本来就该相同**（都是「ASCII 标识符 + 后面紧跟 `(`」），
//! 于是改一处漏四处：比如 `strip_comment` 只有 python 那份是引号感知的，go / rust 用的
//! 是裸 `find("//")` —— `foo("http://…")` 会被当成注释截断，整行剩下的调用全丢。
//!
//! 现在只有这一份实现；语言差异用**参数**表达（`CALL_SKIP` 表、注释标记），不用复制代码。

use crate::graph::types::ParsedCall;

/// 注释标记：各语言的行注释各不相同，语义（「引号外遇到它就到行尾」）相同。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum LineComment {
    /// `//`（Go / Rust / JS / TS / C 系列）
    DoubleSlash,
    /// `#`（Python / Shell / Ruby / YAML）
    Hash,
}

/// 是不是一个「像标识符」的整串（`^[A-Za-z_][A-Za-z0-9_]*$`）。
pub(crate) fn is_ident(s: &str) -> bool {
    let mut chars = s.chars();
    match chars.next() {
        Some(c) if c.is_ascii_alphabetic() || c == '_' => {
            chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
        }
        _ => false,
    }
}

/// 从 `text` 开头**取一段**标识符（遇到非标识符字符就停），空则 `None`。
pub(crate) fn take_ident(text: &str) -> Option<String> {
    let mut out = String::new();
    for ch in text.chars() {
        if ch.is_ascii_alphanumeric() || ch == '_' {
            out.push(ch);
        } else {
            break;
        }
    }
    if out.is_empty() {
        None
    } else {
        Some(out)
    }
}

/// 扫一行里所有「后面紧跟 `(`」的标识符，跳过 `skip` 表里的关键字。
///
/// 两种形态都算调用：`foo(`（自由函数）与 `.foo(`（方法 / 字段上的调用）。
/// `skip` 是每门语言自己的关键字表（`CALL_SKIP`），**不是**在这里再写一份。
pub(crate) fn scan_call_targets(line: &str, skip: &[&str]) -> Vec<String> {
    let mut out = Vec::new();
    let bytes = line.as_bytes();
    let mut i = 0usize;
    while i < bytes.len() {
        if bytes[i].is_ascii_alphabetic() || bytes[i] == b'_' {
            let start = i;
            i += 1;
            while i < bytes.len() && (bytes[i].is_ascii_alphanumeric() || bytes[i] == b'_') {
                i += 1;
            }
            let ident = &line[start..i];
            if next_nonspace_is_paren(bytes, i) && !skip.contains(&ident) {
                out.push(ident.to_string());
            }
            continue;
        }
        if bytes[i] == b'.' {
            i += 1;
            let start = i;
            while i < bytes.len() && (bytes[i].is_ascii_alphanumeric() || bytes[i] == b'_') {
                i += 1;
            }
            if start < i {
                let method = &line[start..i];
                if next_nonspace_is_paren(bytes, i) && !skip.contains(&method) {
                    out.push(method.to_string());
                }
            }
            continue;
        }
        i += 1;
    }
    out
}

/// `(` 之前允许有空白：`foo (` 在 Go / Python 里都还算调用。
fn next_nonspace_is_paren(bytes: &[u8], mut j: usize) -> bool {
    while j < bytes.len() && bytes[j].is_ascii_whitespace() {
        j += 1;
    }
    j < bytes.len() && bytes[j] == b'('
}

/// 去掉行尾注释（**引号感知**：字符串里的 `//` / `#` 不当注释）。
///
/// 三引号 / 模板串在这一层不特殊处理（它们是**跨行**的，逐行扫描本来也处理不了）；
/// 调用方在扫描前已把整行当普通文本，误判的代价只是少一条启发式边，AST 路径会补上。
pub(crate) fn strip_comment(line: &str, style: LineComment) -> String {
    let bytes = line.as_bytes();
    let mut in_single = false;
    let mut in_double = false;
    let mut in_backtick = false;
    let mut escaped = false;
    let mut i = 0usize;
    while i < bytes.len() {
        let ch = bytes[i] as char;
        if escaped {
            escaped = false;
            i += 1;
            continue;
        }
        if ch == '\\' && (in_single || in_double || in_backtick) {
            escaped = true;
            i += 1;
            continue;
        }
        match ch {
            '\'' if !in_double && !in_backtick => in_single = !in_single,
            '"' if !in_single && !in_backtick => in_double = !in_double,
            '`' if !in_single && !in_double => in_backtick = !in_backtick,
            '/' if !in_single && !in_double && !in_backtick => {
                if style == LineComment::DoubleSlash && bytes.get(i + 1) == Some(&b'/') {
                    return line[..i].to_string();
                }
            }
            '#' if !in_single && !in_double && !in_backtick => {
                if style == LineComment::Hash {
                    return line[..i].to_string();
                }
            }
            _ => {}
        }
        i += 1;
    }
    line.to_string()
}

/// 四个语言模块的 `extract_calls` 骨架：逐行去注释 → 扫目标 → 按 `名字@行` 去重。
///
/// 各语言的差别只剩两处：`CALL_SKIP` 表与注释标记。
pub(crate) fn extract_calls(source: &str, skip: &[&str], style: LineComment) -> Vec<ParsedCall> {
    let mut out = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for (idx, raw) in source.lines().enumerate() {
        let line_no = (idx + 1) as i64;
        let line = strip_comment(raw, style);
        if line.trim().is_empty() {
            continue;
        }
        for callee in scan_call_targets(&line, skip) {
            if seen.insert(format!("{callee}@{line_no}")) {
                out.push(ParsedCall {
                    callee,
                    line: line_no,
                });
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ident_rules() {
        assert!(is_ident("foo"));
        assert!(is_ident("_foo1"));
        assert!(!is_ident("1foo"));
        assert!(!is_ident("foo bar"));
        assert!(take_ident("abcDef rest").is_some_and(|s| s == "abcDef"));
        assert_eq!(take_ident("("), None);
    }

    #[test]
    fn scans_both_free_and_method_calls() {
        let names = scan_call_targets("let x = foo(bar.baz(1));", &["let"]);
        assert_eq!(names, vec!["foo".to_string(), "baz".to_string()]);
        // 关键字不进
        assert!(scan_call_targets("if (x) { }", &["if"]).is_empty());
        // `.` 与 `(` 之间允许空白
        assert_eq!(scan_call_targets("a.b (1)", &[]), vec!["b".to_string()]);
    }

    #[test]
    fn strip_comment_is_quote_aware() {
        assert_eq!(
            strip_comment("x := \"http://a\" // tail", LineComment::DoubleSlash),
            "x := \"http://a\" "
        );
        assert_eq!(
            strip_comment("url = 'a#b'  # tail", LineComment::Hash),
            "url = 'a#b'  "
        );
        // 模板串里的 // 也是正文
        assert_eq!(
            strip_comment("const u = `http://x`; // c", LineComment::DoubleSlash),
            "const u = `http://x`; "
        );
        // 没有注释就原样返回
        assert_eq!(strip_comment("plain()", LineComment::Hash), "plain()");
    }

    /// 回归（P3）：`//` 出现在**字符串里**不许把整行后面的调用截掉。
    ///
    /// go / rust 两份 `strip_comment` 以前是裸 `find("//")`：`print("http://x")` 之后
    /// 同一行的调用全部丢失（静默少边）。
    #[test]
    fn url_in_string_does_not_hide_later_calls() {
        let calls = extract_calls("print(\"http://a\"); later()", &["print"], LineComment::DoubleSlash);
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].callee, "later");
        assert_eq!(calls[0].line, 1);
    }
    /// 对称性：**启发式漏掉的调用只能是它故意跳过的那几个**（内置 / 关键字）。
    ///
    /// 精确关系是 `AST \ 启发式 ⊆ CALL_SKIP`：AST 会保留 `print(...)` 这类内置调用，
    /// 而启发式按每门语言的 `CALL_SKIP` 表把它们滤掉（内置函数调用占了图上的大量噪音，
    /// 且基本不指向仓内符号）。除了这份**故意**跳过，启发式不许漏 —— 少报就是丢边，
    /// 而「编辑过的文件永久丢调用边」正是这类事故的形态。
    #[test]
    fn ast_minus_heuristic_is_only_the_deliberate_skip_list() {
        use std::collections::HashSet;

        // (文件名, 源码, 该语言的 CALL_SKIP)
        let samples: &[(&str, &str, &[&str])] = &[
            (
                "a.go",
                "package main\nfunc run() {\n\tfmt.Println(helper(1))\n\tobj.Method()\n}\n",
                crate::graph::extract::go::CALL_SKIP,
            ),
            (
                "a.py",
                "def run():\n    print(helper(1))\n    obj.method()\n",
                crate::graph::extract::python::CALL_SKIP,
            ),
            (
                "a.rs",
                "fn run() {\n    helper(1);\n    obj.method();\n}\n",
                crate::graph::extract::rust_lang::CALL_SKIP,
            ),
            (
                "a.js",
                "function run() {\n  helper(1);\n  obj.method();\n}\n",
                crate::graph::extract::symbols::CALL_SKIP,
            ),
        ];

        for (rel, src, skip) in samples {
            let ast: HashSet<String> = crate::treesitter::extract_graph_ast(rel, src)
                .map(|e| e.calls.into_iter().map(|c| c.callee).collect())
                .unwrap_or_default();
            let heuristic: HashSet<String> = match rel.rsplit('.').next().unwrap_or("") {
                "go" => crate::graph::extract::go::extract_calls(src),
                "py" => crate::graph::extract::python::extract_calls(src),
                "rs" => crate::graph::extract::rust_lang::extract_calls(src),
                _ => crate::graph::extract::symbols::extract_calls(src),
            }
            .into_iter()
            .map(|c| c.callee)
            .collect();

            let missing: Vec<&String> = ast
                .difference(&heuristic)
                .filter(|name| !skip.contains(&name.as_str()))
                .collect();
            assert!(
                missing.is_empty(),
                "{rel}: 启发式漏掉了 AST 抽到的调用 {missing:?}（这些不在 CALL_SKIP 里，属于丢边）"
            );
            // 反向不必相等：启发式会把 `fn foo(` 这类声明也算成调用（噪音，不是丢信息）
            assert!(!heuristic.is_empty(), "{rel}: 启发式一条调用都没抽到");
        }
    }
}

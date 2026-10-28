use std::path::Path;

use tree_sitter::{Language, Parser, Tree};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SourceLang {
    JavaScript,
    TypeScript,
    Tsx,
    Python,
    Go,
    Rust,
}

impl SourceLang {
    pub fn from_path(rel_path: &str) -> Option<Self> {
        let ext = Path::new(rel_path)
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        match ext.as_str() {
            "js" | "mjs" | "cjs" | "jsx" => Some(Self::JavaScript),
            "ts" => Some(Self::TypeScript),
            "tsx" => Some(Self::Tsx),
            "py" => Some(Self::Python),
            "go" => Some(Self::Go),
            "rs" => Some(Self::Rust),
            _ => None,
        }
    }

    pub fn language(self) -> Language {
        match self {
            Self::JavaScript => tree_sitter_javascript::LANGUAGE.into(),
            Self::TypeScript => tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into(),
            Self::Tsx => tree_sitter_typescript::LANGUAGE_TSX.into(),
            Self::Python => tree_sitter_python::LANGUAGE.into(),
            Self::Go => tree_sitter_go::LANGUAGE.into(),
            Self::Rust => tree_sitter_rust::LANGUAGE.into(),
        }
    }
}

pub fn parse_source(lang: SourceLang, source: &str) -> Option<Tree> {
    let mut parser = Parser::new();
    parser.set_language(&lang.language()).ok()?;
    // Guard pathological inputs
    if source.len() > 2 * 1024 * 1024 {
        return None;
    }
    parser.parse(source, None)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 回归护栏：任何一门语言的 grammar ABI 与 `tree-sitter` 不兼容时，
    /// `set_language` 会失败、`parse_source` 返回 `None`，整条 AST 抽取就**静默**
    /// 退回正则启发式 —— 表现是「符号有、跨文件边和调用边没有」。
    /// 升 `tree-sitter` / 各 grammar 之后这里必须仍然全绿（rust 曾这样隐形失效过：
    /// `tree-sitter-rust 0.24.2` 的 ABI 比 `tree-sitter 0.24` 支持的高一位）。
    #[test]
    fn every_language_parses_a_minimal_sample() {
        let samples = [
            (SourceLang::JavaScript, "function a() {}\n"),
            (SourceLang::TypeScript, "function a(): void {}\n"),
            (SourceLang::Tsx, "const x = <div />;\n"),
            (SourceLang::Python, "def a():\n    pass\n"),
            (SourceLang::Go, "package main\nfunc main() {}\n"),
            (SourceLang::Rust, "fn a() {}\n"),
        ];
        for (lang, src) in samples {
            let tree = parse_source(lang, src);
            assert!(
                tree.is_some(),
                "{lang:?} 解析失败：grammar 的 ABI 超出 tree-sitter 支持范围？"
            );
            assert!(
                !tree.unwrap().root_node().has_error(),
                "{lang:?} 解析出语法错误"
            );
        }
    }
}
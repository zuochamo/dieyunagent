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

use super::heuristic;
use super::heuristic::take_ident;
use std::collections::HashSet;
use std::path::Path;

use crate::graph::types::{ParsedCall, ParsedImport, ParsedSymbol};

pub fn is_rust_path(rel_path: &str) -> bool {
    rel_path.to_ascii_lowercase().ends_with(".rs")
}

pub fn extract_import_specs(source: &str) -> Vec<ParsedImport> {
    let mut out = Vec::new();
    for (idx, line) in source.lines().enumerate() {
        let line_no = (idx + 1) as i64;
        let line_stripped = strip_comment(line);
        let trimmed = line_stripped.trim();
        if trimmed.is_empty() {
            continue;
        }
        if let Some(spec) = parse_use(trimmed) {
            out.push(ParsedImport {
                spec,
                line: line_no,
            });
            continue;
        }
        if let Some(spec) = parse_mod(trimmed) {
            out.push(ParsedImport {
                spec,
                line: line_no,
            });
        }
    }
    out
}

pub fn extract_symbols(source: &str) -> Vec<ParsedSymbol> {
    let mut out = Vec::new();
    for (idx, line) in source.lines().enumerate() {
        let line_stripped = strip_comment(line);
        let trimmed = line_stripped.trim();
        if trimmed.is_empty() {
            continue;
        }
        let line_no = (idx + 1) as i64;
        if let Some(name) = parse_fn(trimmed) {
            out.push(ParsedSymbol {
                name,
                kind: "function".to_string(),
                line: line_no,
                end_line: line_no,
            });
            continue;
        }
        if let Some(name) = parse_struct_or_enum(trimmed) {
            out.push(ParsedSymbol {
                name,
                kind: "type".to_string(),
                line: line_no,
                end_line: line_no,
            });
            continue;
        }
        if let Some(name) = parse_trait(trimmed) {
            out.push(ParsedSymbol {
                name,
                kind: "trait".to_string(),
                line: line_no,
                end_line: line_no,
            });
        }
    }
    out
}

/// 本语言的注释标记（实现只有 `heuristic::strip_comment` 那一份，这里只是默认参数）。
const COMMENT: heuristic::LineComment = heuristic::LineComment::DoubleSlash;

fn strip_comment(line: &str) -> String {
    heuristic::strip_comment(line, COMMENT)
}

pub fn extract_calls(source: &str) -> Vec<ParsedCall> {
    heuristic::extract_calls(source, &CALL_SKIP, heuristic::LineComment::DoubleSlash)
}

pub fn resolve_rust_import(from_rel: &str, spec: &str, known_files: &HashSet<String>) -> Option<String> {
    let spec = spec.trim();
    if spec.is_empty() || is_external_spec(spec) {
        return None;
    }
    if spec.starts_with("mod:") {
        return resolve_mod_path(
            from_rel,
            spec.strip_prefix("mod:").unwrap_or(""),
            known_files,
        );
    }
    if spec.starts_with("crate::") {
        let pathish = spec
            .strip_prefix("crate::")
            .unwrap_or("")
            .replace("::", "/");
        return pick_rust_file(&pathish, known_files)
            .or_else(|| pick_rust_file(&format!("src/{pathish}"), known_files));
    }
    if spec.starts_with("super::") || spec.starts_with("self::") {
        return resolve_relative_use(from_rel, spec, known_files);
    }
    let pathish = spec.replace("::", "/");
    pick_rust_file(&pathish, known_files)
        .or_else(|| pick_rust_file(&format!("src/{pathish}"), known_files))
}

pub fn is_external_spec(spec: &str) -> bool {
    spec.starts_with("std::")
        || spec.starts_with("core::")
        || spec.starts_with("alloc::")
        || (!spec.contains("::")
            && !spec.starts_with("mod:")
            && !spec.starts_with("crate::")
            && !spec.starts_with("super::")
            && !spec.starts_with("self::"))
}

fn parse_use(line: &str) -> Option<String> {
    let mut s = line.trim();
    if let Some(r) = s.strip_prefix("pub(crate) ") {
        s = r;
    } else if let Some(r) = s.strip_prefix("pub(super) ") {
        s = r;
    } else if let Some(r) = s.strip_prefix("pub ") {
        s = r;
    }
    let rest = s.strip_prefix("use ")?;
    let path = rest.split('{').next()?.trim().trim_end_matches(';').trim();
    if path.is_empty() {
        return None;
    }
    let main = path.split(',').next()?.trim();
    if main.is_empty() {
        None
    } else {
        Some(main.to_string())
    }
}

fn parse_mod(line: &str) -> Option<String> {
    let mut s = line.trim();
    if let Some(r) = s.strip_prefix("pub(crate) ") {
        s = r;
    } else if let Some(r) = s.strip_prefix("pub(super) ") {
        s = r;
    } else if let Some(r) = s.strip_prefix("pub ") {
        s = r;
    }
    let rest = s.strip_prefix("mod ")?;
    let name = take_ident(rest.trim())?;
    if rest.contains(';') {
        Some(format!("mod:{name}"))
    } else {
        None
    }
}

fn parse_fn(line: &str) -> Option<String> {
    let mut s = line.trim();
    if let Some(r) = s.strip_prefix("pub(crate) ") {
        s = r;
    } else if let Some(r) = s.strip_prefix("pub(super) ") {
        s = r;
    } else if let Some(r) = s.strip_prefix("pub ") {
        s = r;
    }
    if let Some(r) = s.strip_prefix("async ") {
        s = r;
    }
    if let Some(r) = s.strip_prefix("unsafe ") {
        s = r;
    }
    if let Some(r) = s.strip_prefix("const ") {
        s = r;
    }
    let rest = s.strip_prefix("fn ")?;
    take_ident(rest)
}

fn parse_struct_or_enum(line: &str) -> Option<String> {
    let mut s = line.trim();
    if let Some(r) = s.strip_prefix("pub(crate) ") {
        s = r;
    } else if let Some(r) = s.strip_prefix("pub(super) ") {
        s = r;
    } else if let Some(r) = s.strip_prefix("pub ") {
        s = r;
    }
    let rest = s
        .strip_prefix("struct ")
        .or_else(|| s.strip_prefix("enum "))?;
    take_ident(rest)
}

fn parse_trait(line: &str) -> Option<String> {
    let mut s = line.trim();
    if let Some(r) = s.strip_prefix("pub(crate) ") {
        s = r;
    } else if let Some(r) = s.strip_prefix("pub(super) ") {
        s = r;
    } else if let Some(r) = s.strip_prefix("pub ") {
        s = r;
    }
    let rest = s.strip_prefix("trait ")?;
    take_ident(rest)
}

pub(crate) const CALL_SKIP: &[&str] = &[
    "if",
    "for",
    "while",
    "loop",
    "match",
    "return",
    "break",
    "continue",
    "move",
    "async",
    "await",
    "unsafe",
    "fn",
    "let",
    "mut",
    "pub",
    "use",
    "mod",
    "struct",
    "enum",
    "trait",
    "impl",
    "where",
    "Self",
    "self",
    "super",
    "crate",
    "type",
    "const",
    "static",
    "ref",
    "Box",
    "Vec",
    "Option",
    "Result",
    "Ok",
    "Err",
    "Some",
    "None",
    "println",
    "print",
    "format",
    "panic",
    "assert",
    "assert_eq",
    "todo",
    "unreachable",
    "write",
    "writeln",
];

fn resolve_mod_path(from_rel: &str, name: &str, known_files: &HashSet<String>) -> Option<String> {
    let from = Path::new(from_rel);
    let parent = from
        .parent()
        .unwrap_or_else(|| Path::new(""))
        .to_string_lossy()
        .replace('\\', "/");
    let base = if parent.is_empty() {
        name.to_string()
    } else {
        format!("{parent}/{name}")
    };
    pick_rust_file(&base, known_files)
}

fn resolve_relative_use(from_rel: &str, spec: &str, known_files: &HashSet<String>) -> Option<String> {
    let from = Path::new(from_rel);
    let mut base_dir = from.parent().unwrap_or_else(|| Path::new(""));
    let mut rest = spec;
    while rest.starts_with("super::") {
        base_dir = base_dir.parent().unwrap_or_else(|| Path::new(""));
        rest = &rest[7..];
    }
    if rest.starts_with("self::") {
        rest = &rest[6..];
    }
    if rest.is_empty() {
        return None;
    }
    let pathish = rest.replace("::", "/");
    let rel_base = base_dir.to_string_lossy().replace('\\', "/");
    let full = if rel_base.is_empty() {
        pathish
    } else {
        format!("{rel_base}/{pathish}")
    };
    pick_rust_file(&full, known_files)
}

fn pick_rust_file(base: &str, known_files: &HashSet<String>) -> Option<String> {
    let base = base.replace('\\', "/").trim_end_matches(".rs").to_string();
    let candidates = [format!("{base}.rs"), format!("{base}/mod.rs")];
    for cand in candidates {
        if known_files.contains(&cand) {
            return Some(cand);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_rust_use_and_mod() {
        let src = r#"
use crate::graph::query;
use super::build;
mod extract;
"#;
        let specs: Vec<_> = extract_import_specs(src)
            .into_iter()
            .map(|p| p.spec)
            .collect();
        assert!(specs.contains(&"crate::graph::query".to_string()));
        assert!(specs.contains(&"super::build".to_string()));
        assert!(specs.contains(&"mod:extract".to_string()));
    }

    #[test]
    fn resolves_crate_and_mod_paths() {
        let known: HashSet<String> = [
            "src/graph/query.rs".to_string(),
            "src/graph/extract/mod.rs".to_string(),
        ]
        .into_iter()
        .collect();
        let hit = resolve_rust_import("src/graph/mod.rs", "crate::graph::query", &known);
        assert_eq!(hit.as_deref(), Some("src/graph/query.rs"));
        let mod_hit = resolve_rust_import("src/graph/mod.rs", "mod:extract", &known);
        assert_eq!(mod_hit.as_deref(), Some("src/graph/extract/mod.rs"));
    }
}

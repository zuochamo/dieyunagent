use std::path::Path;

use crate::graph::types::{ParsedCall, ParsedImport, ParsedSymbol};

pub fn is_go_path(rel_path: &str) -> bool {
    rel_path.to_ascii_lowercase().ends_with(".go")
}

pub fn extract_import_specs(source: &str) -> Vec<ParsedImport> {
    let mut out = Vec::new();
    let mut in_block = false;
    for (idx, line) in source.lines().enumerate() {
        let line_no = (idx + 1) as i64;
        let line_stripped = strip_comment(line);
        let trimmed = line_stripped.trim();
        if trimmed.is_empty() {
            continue;
        }
        if trimmed.starts_with("import (") {
            in_block = true;
            let rest = trimmed.strip_prefix("import (").unwrap_or("").trim();
            if !rest.is_empty() && rest != ")" {
                if let Some(spec) = parse_go_import_line(rest) {
                    out.push(ParsedImport {
                        spec,
                        line: line_no,
                    });
                }
            }
            continue;
        }
        if in_block {
            if trimmed == ")" {
                in_block = false;
                continue;
            }
            if let Some(spec) = parse_go_import_line(trimmed) {
                out.push(ParsedImport {
                    spec,
                    line: line_no,
                });
            }
            continue;
        }
        if let Some(spec) = parse_single_import(trimmed) {
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
        if trimmed.is_empty() || trimmed.starts_with("package ") {
            continue;
        }
        let line_no = (idx + 1) as i64;
        if let Some(name) = parse_func(trimmed) {
            out.push(ParsedSymbol {
                name,
                kind: "function".to_string(),
                line: line_no,
                end_line: line_no,
            });
        } else if let Some(name) = parse_type(trimmed) {
            out.push(ParsedSymbol {
                name,
                kind: "type".to_string(),
                line: line_no,
                end_line: line_no,
            });
        }
    }
    out
}

pub fn extract_calls(source: &str) -> Vec<ParsedCall> {
    let mut out = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for (idx, line) in source.lines().enumerate() {
        let line_no = (idx + 1) as i64;
        for callee in scan_call_targets(&strip_comment(line)) {
            let key = format!("{callee}@{line_no}");
            if seen.insert(key) {
                out.push(ParsedCall {
                    callee,
                    line: line_no,
                });
            }
        }
    }
    out
}

pub fn resolve_go_import(from_rel: &str, spec: &str, known_files: &[String]) -> Option<String> {
    let spec = spec.trim();
    if spec.is_empty() {
        return None;
    }
    if spec.starts_with("./") || spec.starts_with("../") {
        return resolve_relative_go(from_rel, spec, known_files);
    }
    module_to_go_file(spec, known_files)
}

pub fn is_relative_spec(spec: &str) -> bool {
    spec.starts_with("./") || spec.starts_with("../")
}

fn parse_single_import(line: &str) -> Option<String> {
    let rest = line.strip_prefix("import ")?;
    parse_go_import_line(rest)
}

fn parse_go_import_line(line: &str) -> Option<String> {
    let s = line.trim().trim_end_matches(',').trim();
    if s == ")" || s.is_empty() {
        return None;
    }
    if s.starts_with('"') {
        return extract_quoted(s);
    }
    // alias "path"
    if let Some(pos) = s.rfind('"') {
        let start = s[..pos].rfind('"')?;
        return Some(s[start + 1..pos].to_string());
    }
    None
}

fn parse_func(line: &str) -> Option<String> {
    let rest = line.strip_prefix("func ")?;
    if rest.starts_with('(') {
        if let Some(close) = rest.find(')') {
            let after = rest[close + 1..].trim();
            return take_ident(after);
        }
        return None;
    }
    take_ident(rest)
}

fn parse_type(line: &str) -> Option<String> {
    let rest = line
        .strip_prefix("type ")
        .or_else(|| line.strip_prefix("struct "))
        .or_else(|| line.strip_prefix("interface "))?;
    take_ident(rest)
}

fn take_ident(text: &str) -> Option<String> {
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

const CALL_SKIP: &[&str] = &[
    "if",
    "for",
    "switch",
    "return",
    "go",
    "defer",
    "make",
    "new",
    "len",
    "cap",
    "append",
    "copy",
    "delete",
    "panic",
    "print",
    "println",
    "close",
    "complex",
    "real",
    "imag",
    "func",
    "var",
    "const",
    "type",
    "package",
    "import",
    "range",
    "map",
    "chan",
    "struct",
    "interface",
    "select",
    "case",
    "default",
    "fallthrough",
    "break",
    "continue",
    "goto",
];

fn scan_call_targets(line: &str) -> Vec<String> {
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
            let mut j = i;
            while j < bytes.len() && bytes[j].is_ascii_whitespace() {
                j += 1;
            }
            if j < bytes.len() && bytes[j] == b'(' && !CALL_SKIP.contains(&ident) {
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
                let mut j = i;
                while j < bytes.len() && bytes[j].is_ascii_whitespace() {
                    j += 1;
                }
                if j < bytes.len() && bytes[j] == b'(' && !CALL_SKIP.contains(&method) {
                    out.push(method.to_string());
                }
            }
            continue;
        }
        i += 1;
    }
    out
}

fn resolve_relative_go(from_rel: &str, spec: &str, known_files: &[String]) -> Option<String> {
    let from = Path::new(from_rel);
    let base = from.parent().unwrap_or_else(|| Path::new(""));
    let joined = normalize_rel_path(&base.join(spec).to_string_lossy());
    pick_go_file(&joined, known_files)
}

fn module_to_go_file(spec: &str, known_files: &[String]) -> Option<String> {
    if let Some(hit) = pick_go_file(spec, known_files) {
        return Some(hit);
    }
    let norm_spec = spec.replace('\\', "/");
    known_files
        .iter()
        .find(|f| {
            let n = f.replace('\\', "/");
            n.ends_with(".go") && (n.contains(&format!("/{norm_spec}/")) || n.contains(&norm_spec))
        })
        .cloned()
}

fn pick_go_file(base: &str, known_files: &[String]) -> Option<String> {
    let base = base.replace('\\', "/").trim_end_matches('/').to_string();
    let candidates = [format!("{base}.go"), format!("{base}/main.go")];
    for cand in candidates {
        if known_files.iter().any(|f| f == &cand) {
            return Some(cand);
        }
    }
    known_files
        .iter()
        .find(|f| {
            let n = f.replace('\\', "/");
            n.starts_with(&format!("{base}/")) && n.ends_with(".go")
        })
        .cloned()
}

fn normalize_rel_path(raw: &str) -> String {
    let normalized = raw.replace('\\', "/");
    let parts: Vec<&str> = normalized.split('/').collect();
    let mut stack: Vec<&str> = Vec::new();
    for part in parts {
        if part.is_empty() || part == "." {
            continue;
        }
        if part == ".." {
            stack.pop();
            continue;
        }
        stack.push(part);
    }
    stack.join("/")
}

fn strip_comment(line: &str) -> String {
    if let Some(pos) = line.find("//") {
        line[..pos].to_string()
    } else {
        line.to_string()
    }
}

fn extract_quoted(text: &str) -> Option<String> {
    let quote = text.chars().next()?;
    if quote != '"' {
        return None;
    }
    let mut out = String::new();
    let mut escaped = false;
    for ch in text.chars().skip(1) {
        if escaped {
            out.push(ch);
            escaped = false;
            continue;
        }
        if ch == '\\' {
            escaped = true;
            continue;
        }
        if ch == quote {
            return Some(out);
        }
        out.push(ch);
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_go_imports() {
        let src = r#"
package main
import "fmt"
import (
  "os"
  helper "./helper"
)
"#;
        let specs: Vec<_> = extract_import_specs(src)
            .into_iter()
            .map(|p| p.spec)
            .collect();
        assert!(specs.contains(&"fmt".to_string()));
        assert!(specs.contains(&"os".to_string()));
        assert!(specs.contains(&"./helper".to_string()));
    }

    #[test]
    fn resolves_relative_go_import() {
        let known = vec!["pkg/helper/helper.go".to_string()];
        let hit = resolve_go_import("pkg/main.go", "./helper", &known);
        assert_eq!(hit.as_deref(), Some("pkg/helper/helper.go"));
    }
}

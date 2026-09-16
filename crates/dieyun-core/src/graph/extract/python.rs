use std::path::Path;

use crate::graph::types::{ParsedCall, ParsedImport, ParsedSymbol};

const PY_EXT: &str = ".py";

pub fn is_python_path(rel_path: &str) -> bool {
    rel_path.to_ascii_lowercase().ends_with(PY_EXT)
}

pub fn extract_import_specs(source: &str) -> Vec<ParsedImport> {
    let mut out = Vec::new();
    for (idx, line) in source.lines().enumerate() {
        let line_stripped = strip_comment(line);
        let trimmed = line_stripped.trim();
        if trimmed.is_empty() {
            continue;
        }
        let line_no = (idx + 1) as i64;
        if let Some(spec) = parse_from_import(trimmed) {
            out.push(ParsedImport {
                spec,
                line: line_no,
            });
            continue;
        }
        if let Some(spec) = parse_import_line(trimmed) {
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
        if let Some(name) = parse_def(trimmed) {
            out.push(ParsedSymbol {
                name,
                kind: "function".to_string(),
                line: line_no,
                end_line: line_no,
            });
            continue;
        }
        if let Some(name) = parse_class(trimmed) {
            out.push(ParsedSymbol {
                name,
                kind: "class".to_string(),
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
        let trimmed = strip_comment(line);
        for callee in scan_call_targets(&trimmed) {
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

pub fn resolve_python_import(from_rel: &str, spec: &str, known_files: &[String]) -> Option<String> {
    if spec.starts_with('.') {
        return resolve_relative_python(from_rel, spec, known_files);
    }
    module_to_file(spec, known_files)
}

pub fn is_relative_spec(spec: &str) -> bool {
    spec.starts_with('.')
}

fn strip_comment(line: &str) -> String {
    let mut in_single = false;
    let mut in_double = false;
    let mut escaped = false;
    let bytes = line.as_bytes();
    let mut i = 0usize;
    while i < bytes.len() {
        let ch = bytes[i] as char;
        if escaped {
            escaped = false;
            i += 1;
            continue;
        }
        if ch == '\\' && (in_single || in_double) {
            escaped = true;
            i += 1;
            continue;
        }
        if ch == '\'' && !in_double {
            in_single = !in_single;
            i += 1;
            continue;
        }
        if ch == '"' && !in_single {
            in_double = !in_double;
            i += 1;
            continue;
        }
        if ch == '#' && !in_single && !in_double {
            return line[..i].to_string();
        }
        i += 1;
    }
    line.to_string()
}

fn parse_from_import(line: &str) -> Option<String> {
    let rest = line.strip_prefix("from ")?.trim();
    let import_pos = rest.find(" import ")?;
    let module = rest[..import_pos].trim();
    if module.is_empty() {
        return None;
    }
    Some(module.to_string())
}

fn parse_import_line(line: &str) -> Option<String> {
    if !line.starts_with("import ") {
        return None;
    }
    let rest = line.strip_prefix("import ")?.trim();
    let first = rest.split(',').next()?.trim();
    let module = first.split(" as ").next()?.trim();
    if module.is_empty() {
        None
    } else {
        Some(module.to_string())
    }
}

fn parse_def(line: &str) -> Option<String> {
    let rest = line
        .strip_prefix("async ")
        .unwrap_or(line)
        .strip_prefix("def ")?;
    take_ident(rest)
}

fn parse_class(line: &str) -> Option<String> {
    let rest = line.strip_prefix("class ")?;
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
    "while",
    "with",
    "assert",
    "print",
    "raise",
    "pass",
    "break",
    "continue",
    "return",
    "yield",
    "del",
    "global",
    "nonlocal",
    "lambda",
    "elif",
    "else",
    "try",
    "except",
    "finally",
    "class",
    "def",
    "import",
    "from",
    "not",
    "and",
    "or",
    "is",
    "in",
    "async",
    "await",
    "super",
    "type",
    "isinstance",
    "len",
    "range",
    "int",
    "str",
    "float",
    "bool",
    "list",
    "dict",
    "set",
    "tuple",
    "open",
    "staticmethod",
    "classmethod",
    "property",
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

fn resolve_relative_python(from_rel: &str, spec: &str, known_files: &[String]) -> Option<String> {
    let from_path = Path::new(from_rel);
    let mut base_dir = from_path.parent().unwrap_or_else(|| Path::new(""));
    let mut rest = spec;
    while rest.starts_with('.') {
        if rest.starts_with("..") {
            base_dir = base_dir.parent().unwrap_or_else(|| Path::new(""));
            rest = &rest[2..];
            if rest.starts_with('.') {
                rest = &rest[1..];
            }
        } else {
            rest = &rest[1..];
        }
    }
    let module_path = rest.trim_start_matches('.');
    if module_path.is_empty() {
        return None;
    }
    let rel_base = base_dir.to_string_lossy().replace('\\', "/");
    let file_base = if rel_base.is_empty() {
        module_path.replace('.', "/")
    } else {
        format!("{}/{}", rel_base, module_path.replace('.', "/"))
    };
    pick_python_file(&file_base, known_files)
}

fn module_to_file(spec: &str, known_files: &[String]) -> Option<String> {
    let pathish = spec.replace('.', "/");
    if let Some(hit) = pick_python_file(&pathish, known_files) {
        return Some(hit);
    }
    known_files
        .iter()
        .find(|f| {
            f.strip_suffix(".py")
                .map(|stem| stem.replace('\\', "/").ends_with(&pathish))
                .unwrap_or(false)
                || f.replace('\\', "/") == format!("{pathish}.py")
        })
        .cloned()
}

fn pick_python_file(base: &str, known_files: &[String]) -> Option<String> {
    let base = base.replace('\\', "/");
    let candidates = [format!("{base}.py"), format!("{base}/__init__.py")];
    for cand in candidates {
        if known_files.iter().any(|f| f == &cand) {
            return Some(cand);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_python_imports() {
        let src = r#"
import os
import json as js
from . import helper
from ..pkg import util
from foo.bar import baz
"#;
        let specs: Vec<_> = extract_import_specs(src)
            .into_iter()
            .map(|p| p.spec)
            .collect();
        assert!(specs.contains(&"os".to_string()));
        assert!(specs.contains(&"json".to_string()));
        assert!(specs.contains(&".".to_string()));
        assert!(specs.contains(&"..pkg".to_string()));
        assert!(specs.contains(&"foo.bar".to_string()));
    }

    #[test]
    fn resolves_python_relative_import() {
        let known = vec![
            "pkg/helper.py".to_string(),
            "pkg/util.py".to_string(),
            "lib/foo.py".to_string(),
        ];
        let hit = resolve_python_import("pkg/main.py", ".helper", &known);
        assert_eq!(hit.as_deref(), Some("pkg/helper.py"));
        let up = resolve_python_import("pkg/sub/mod.py", "..util", &known);
        assert_eq!(up.as_deref(), Some("pkg/util.py"));
    }

    #[test]
    fn extracts_python_symbols_and_calls() {
        let src = r#"
def alpha():
    pass

class Beta:
    def run(self):
        gamma()

async def delta():
    helper.process()
"#;
        let names: Vec<_> = extract_symbols(src).into_iter().map(|s| s.name).collect();
        assert!(names.contains(&"alpha".to_string()));
        assert!(names.contains(&"Beta".to_string()));
        assert!(names.contains(&"run".to_string()));
        assert!(names.contains(&"delta".to_string()));

        let calls: Vec<_> = extract_calls(src).into_iter().map(|c| c.callee).collect();
        assert!(calls.contains(&"gamma".to_string()));
        assert!(calls.contains(&"process".to_string()));
    }
}

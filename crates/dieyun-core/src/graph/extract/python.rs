use super::heuristic;
use super::heuristic::take_ident;
use std::collections::HashSet;
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

/// 本语言的注释标记（实现只有 `heuristic::strip_comment` 那一份，这里只是默认参数）。
const COMMENT: heuristic::LineComment = heuristic::LineComment::Hash;

fn strip_comment(line: &str) -> String {
    heuristic::strip_comment(line, COMMENT)
}

pub fn extract_calls(source: &str) -> Vec<ParsedCall> {
    heuristic::extract_calls(source, &CALL_SKIP, heuristic::LineComment::Hash)
}

pub fn resolve_python_import(from_rel: &str, spec: &str, known_files: &HashSet<String>) -> Option<String> {
    if spec.starts_with('.') {
        return resolve_relative_python(from_rel, spec, known_files);
    }
    module_to_file(spec, known_files)
}

pub fn is_relative_spec(spec: &str) -> bool {
    spec.starts_with('.')
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

pub(crate) const CALL_SKIP: &[&str] = &[
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

fn resolve_relative_python(from_rel: &str, spec: &str, known_files: &HashSet<String>) -> Option<String> {
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

fn module_to_file(spec: &str, known_files: &HashSet<String>) -> Option<String> {
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

fn pick_python_file(base: &str, known_files: &HashSet<String>) -> Option<String> {
    let base = base.replace('\\', "/");
    let candidates = [format!("{base}.py"), format!("{base}/__init__.py")];
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
        let known: HashSet<String> = [
            "pkg/helper.py".to_string(),
            "pkg/util.py".to_string(),
            "lib/foo.py".to_string(),
        ]
        .into_iter()
        .collect();
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

use std::path::Path;

use crate::graph::types::ParsedImport;

const JS_TS_EXT: &[&str] = &[".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx"];

pub fn is_js_ts_path(rel_path: &str) -> bool {
    let lower = rel_path.to_ascii_lowercase();
    JS_TS_EXT.iter().any(|ext| lower.ends_with(ext))
}

pub fn extract_import_specs(source: &str) -> Vec<ParsedImport> {
    let mut out = Vec::new();
    for (idx, line) in source.lines().enumerate() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with("//") {
            continue;
        }
        for spec in scan_line_specs(trimmed) {
            if !spec.is_empty() {
                out.push(ParsedImport {
                    spec,
                    line: (idx + 1) as i64,
                });
            }
        }
    }
    out
}

fn scan_line_specs(line: &str) -> Vec<String> {
    let mut specs = Vec::new();
    if let Some(spec) = extract_quoted_after(line, "from ") {
        specs.push(spec);
    }
    if let Some(spec) = extract_require_spec(line) {
        specs.push(spec);
    }
    if line.starts_with("import ") {
        if let Some(spec) = extract_import_side_effect(line) {
            specs.push(spec);
        }
    }
    specs
}

fn extract_quoted_after(line: &str, needle: &str) -> Option<String> {
    let pos = line.find(needle)?;
    let rest = line[pos + needle.len()..].trim();
    extract_quoted(rest)
}

fn extract_require_spec(line: &str) -> Option<String> {
    let pos = line.find("require(")?;
    let rest = &line[pos + "require(".len()..];
    extract_quoted(rest.trim())
}

fn extract_import_side_effect(line: &str) -> Option<String> {
    let rest = line.strip_prefix("import ")?.trim();
    if rest.starts_with('{') || rest.starts_with('*') || rest.contains(" from ") {
        return None;
    }
    extract_quoted(rest)
}

fn extract_quoted(text: &str) -> Option<String> {
    let quote = text.chars().next()?;
    if quote != '\'' && quote != '"' {
        return None;
    }
    let mut escaped = false;
    let mut out = String::new();
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

pub fn resolve_relative_import(
    from_rel: &str,
    spec: &str,
    known_files: &[String],
) -> Option<String> {
    if !(spec.starts_with("./") || spec.starts_with("../")) {
        return None;
    }
    let from = Path::new(from_rel);
    let base = from.parent().unwrap_or_else(|| Path::new(""));
    let joined = normalize_rel_path(&base.join(spec).to_string_lossy());
    resolve_with_extensions(&joined, known_files)
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

fn resolve_with_extensions(base: &str, known_files: &[String]) -> Option<String> {
    let base_norm = base.replace('\\', "/");
    let candidates = extension_candidates(&base_norm);
    for cand in candidates {
        if known_files.iter().any(|f| f == &cand) {
            return Some(cand);
        }
    }
    None
}

fn extension_candidates(base: &str) -> Vec<String> {
    let mut out = vec![base.to_string()];
    if !JS_TS_EXT.iter().any(|ext| base.ends_with(ext)) {
        for ext in JS_TS_EXT {
            out.push(format!("{base}{ext}"));
        }
        for ext in JS_TS_EXT {
            out.push(format!("{base}/index{ext}"));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_commonjs_and_esm() {
        let src = r#"
const fs = require('fs');
const { x } = require("./util");
import path from 'path';
export { foo } from "../shared";
import './side-effect';
"#;
        let specs: Vec<_> = extract_import_specs(src)
            .into_iter()
            .map(|p| p.spec)
            .collect();
        assert!(specs.contains(&"fs".to_string()));
        assert!(specs.contains(&"./util".to_string()));
        assert!(specs.contains(&"path".to_string()));
        assert!(specs.contains(&"../shared".to_string()));
        assert!(specs.contains(&"./side-effect".to_string()));
    }

    #[test]
    fn resolves_relative_paths() {
        let known = vec![
            "src/core-bridge.js".to_string(),
            "src/util/index.ts".to_string(),
        ];
        let hit = resolve_relative_import("src/main-entry.js", "./core-bridge", &known);
        assert_eq!(hit.as_deref(), Some("src/core-bridge.js"));
    }
}

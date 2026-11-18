use std::collections::HashSet;
use std::path::Path;


const JS_TS_EXT: &[&str] = &[".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx"];

pub fn is_js_ts_path(rel_path: &str) -> bool {
    let lower = rel_path.to_ascii_lowercase();
    JS_TS_EXT.iter().any(|ext| lower.ends_with(ext))
}

pub fn resolve_relative_import(
    from_rel: &str,
    spec: &str,
    known_files: &HashSet<String>,
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

fn resolve_with_extensions(base: &str, known_files: &HashSet<String>) -> Option<String> {
    let base_norm = base.replace('\\', "/");
    let candidates = extension_candidates(&base_norm);
    for cand in candidates {
        if known_files.contains(&cand) {
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
    fn resolves_relative_paths() {
        let known: HashSet<String> = [
            "src/core-bridge.js".to_string(),
            "src/util/index.ts".to_string(),
        ]
        .into_iter()
        .collect();
        let hit = resolve_relative_import("src/main-entry.js", "./core-bridge", &known);
        assert_eq!(hit.as_deref(), Some("src/core-bridge.js"));
    }
}

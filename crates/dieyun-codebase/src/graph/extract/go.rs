use std::collections::HashSet;
use std::path::Path;


pub fn is_go_path(rel_path: &str) -> bool {
    rel_path.to_ascii_lowercase().ends_with(".go")
}

pub fn resolve_go_import(from_rel: &str, spec: &str, known_files: &HashSet<String>) -> Option<String> {
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

fn resolve_relative_go(from_rel: &str, spec: &str, known_files: &HashSet<String>) -> Option<String> {
    let from = Path::new(from_rel);
    let base = from.parent().unwrap_or_else(|| Path::new(""));
    let joined = normalize_rel_path(&base.join(spec).to_string_lossy());
    pick_go_file(&joined, known_files)
}

fn module_to_go_file(spec: &str, known_files: &HashSet<String>) -> Option<String> {
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

fn pick_go_file(base: &str, known_files: &HashSet<String>) -> Option<String> {
    let base = base.replace('\\', "/").trim_end_matches('/').to_string();
    let candidates = [format!("{base}.go"), format!("{base}/main.go")];
    for cand in candidates {
        if known_files.contains(&cand) {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_relative_go_import() {
        let known: HashSet<String> = ["pkg/helper/helper.go".to_string()].into_iter().collect();
        let hit = resolve_go_import("pkg/main.go", "./helper", &known);
        assert_eq!(hit.as_deref(), Some("pkg/helper/helper.go"));
    }
}

use std::collections::HashSet;
use std::path::Path;


pub fn is_rust_path(rel_path: &str) -> bool {
    rel_path.to_ascii_lowercase().ends_with(".rs")
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

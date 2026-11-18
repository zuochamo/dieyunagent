use std::collections::HashSet;
use std::path::Path;


const PY_EXT: &str = ".py";

pub fn is_python_path(rel_path: &str) -> bool {
    rel_path.to_ascii_lowercase().ends_with(PY_EXT)
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

use std::path::Path;

use super::go::is_go_path;
use super::js_ts::is_js_ts_path;
use super::python::is_python_path;
use super::rust_lang::is_rust_path;

pub fn is_graph_path(rel_path: &str) -> bool {
    is_js_ts_path(rel_path)
        || is_python_path(rel_path)
        || is_go_path(rel_path)
        || is_rust_path(rel_path)
}

pub fn collect_graph_files(root: &Path, max_files: usize) -> Vec<String> {
    crate::index::collect_text_files(root, max_files)
        .into_iter()
        .filter(|e| is_graph_path(&e.rel))
        .map(|e| e.rel.replace('\\', "/"))
        .collect()
}

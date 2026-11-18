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

pub fn collect_graph_files(root: &Path, max_files: usize) -> (Vec<String>, bool) {
    // 先按语言筛、**再**按上限截断（`keep` 在计数之前生效）。
    // 旧实现先在上限处截断「全部文本文件」，再按语言过滤：文档多的仓库（md/json/log）
    // 会把代码目录整个挤出调用图，而且看不出是这个原因。
    let (entries, truncated) = crate::index::collect_text_files_where(root, max_files, |abs| {
        let rel = abs.strip_prefix(root).unwrap_or(abs).to_string_lossy();
        is_graph_path(&rel)
    });
    let files = entries
        .into_iter()
        .map(|e| e.rel.replace('\\', "/"))
        .collect();
    (files, truncated)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 文档/数据文件再多，也不许把代码挤出调用图：`keep` 必须在**计数之前**生效。
    ///
    /// 旧实现先按上限截断「全部文本文件」、再按语言过滤 —— 文档多的仓库里，
    /// 代码目录会整段不见，而状态页看不出是这个原因。
    #[test]
    fn code_files_survive_when_text_files_outnumber_the_cap() {
        let dir = tempfile::tempdir().unwrap();
        for i in 0..40 {
            std::fs::write(dir.path().join(format!("doc{i}.txt")), "x").unwrap();
            std::fs::write(dir.path().join(format!("note{i}.md")), "# n").unwrap();
        }
        std::fs::write(dir.path().join("app.js"), "function a(){ b(); }").unwrap();

        let (files, truncated) = collect_graph_files(dir.path(), 4);
        assert_eq!(files, vec!["app.js".to_string()], "代码文件不许被文档挤掉");
        assert!(!truncated, "只筛掉了非代码文件，调用图本身是完整的");
    }
}

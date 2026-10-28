use std::path::{Path, PathBuf};

use ignore::WalkBuilder;
use rayon::prelude::*;

/// 「这一层目录一定不是源码」的显式名单。
///
/// 只保留 **.gitignore 通常管不到**的那几个：`node_modules` / `dist` / `target` 之类
/// 即使仓库没写 .gitignore 也必须跳过（否则首索引等于把整个依赖树读一遍）。
/// 隐藏目录（`.git` / `.venv` / `.next` / `.dieyun` …）不再列出：`ignore` crate 默认
/// 跳过隐藏项，维护两份名单只会让两份逐渐不一致。
const IGNORE_DIRS: &[&str] = &[
    "node_modules",
    "dist",
    "build",
    "out",
    "coverage",
    "__pycache__",
    "venv",
    "target",
    "vendor",
    "win-unpacked",
];

/// Definitely binary / media — never index by content sniff.
const IGNORE_EXT: &[&str] = &[
    ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".bmp", ".svg", ".psd", ".ai",
    ".zip", ".7z", ".rar", ".gz", ".tgz", ".bz2", ".xz", ".tar",
    ".exe", ".dll", ".so", ".dylib", ".bin", ".o", ".obj", ".a", ".lib", ".wasm",
    ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
    ".woff", ".woff2", ".ttf", ".otf", ".eot",
    ".mp4", ".mp3", ".wav", ".avi", ".mov", ".mkv", ".webm", ".flac",
    ".sqlite", ".db", ".mdb",
    ".pyc", ".pyo", ".class", ".jar", ".apk", ".dmg", ".iso",
];

/// Fast-path allowlist（已知源码/文本）。未命中时再做内容嗅探，避免永远扩展此表。
const KNOWN_TEXT_EXT: &[&str] = &[
    ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".json", ".md", ".css", ".scss", ".html", ".htm",
    ".py", ".java", ".go", ".rs", ".sql", ".yaml", ".yml", ".toml", ".xml", ".vue", ".svelte",
    ".sh", ".bat", ".ps1", ".cpp", ".c", ".h", ".hpp", ".cs", ".rb", ".php", ".swift", ".kt",
    ".txt", ".text", ".log", ".csv", ".tsv", ".ini", ".cfg", ".conf", ".properties", ".env",
    ".gitignore", ".dockerignore", ".editorconfig", ".gradle", ".proto", ".graphql", ".gql",
    ".r", ".R", ".jl", ".lua", ".pl", ".pm", ".scala", ".dart", ".zig", ".nim", ".ex", ".exs",
    ".tf", ".hcl", ".nix", ".cmake", ".makefile",
];

const SNIFF_BYTES: usize = 8192;
const MAX_SNIFF_FILE_BYTES: u64 = 2 * 1024 * 1024;

/// 内容嗅探阶段的候选超采样倍数。
///
/// 遍历阶段只能按扩展名先粗筛（快），真正的「是不是文本」要开文件读 8KB（慢）。
/// 我们不需要为了 max_files 个结果只嗅探 max_files 个文件——二进制多的仓库会
/// 提前触顶。多取几倍候选并行嗅探，再按相对路径排序截断，结果仍然确定。
const SNIFF_OVERSAMPLE: usize = 4;
const SNIFF_MIN_HEADROOM: usize = 256;

pub struct FileEntry {
    pub abs: PathBuf,
    pub rel: String,
}

/// 收集可索引文本文件。
///
/// 两段式，职责分开：
/// 1. **遍历**（串行、`ignore` crate）：忽略规则只有一份 —— `.gitignore` /
///    `.git/info/exclude` / 全局 gitignore / `.ignore` 全部由 crate 提供，
///    我们只额外声明 `IGNORE_DIRS` 那几条（见其文档）。不跟符号链接（防环 + 防越界）。
/// 2. **嗅探**（并行、`rayon`）：逐文件开 IO 判定是否文本，这是真正的耗时项。
///
/// 隐藏项由 crate 默认跳过：`.env` / `.gitignore` 这类点文件因此不再进索引。
/// 这是**有意**的取舍 —— 少索引几个点配置文件，换掉「把 `.env` 里的密钥送进向量库」。
pub fn collect_text_files(root: &Path, max_files: usize) -> Vec<FileEntry> {
    let cap = max_files
        .saturating_mul(SNIFF_OVERSAMPLE)
        .max(max_files.saturating_add(SNIFF_MIN_HEADROOM));
    let mut candidates: Vec<PathBuf> = Vec::new();
    let walker = WalkBuilder::new(root)
        // 工作区不一定是 git 仓库，但 .gitignore 依然是对「哪些是产物」的准确声明
        .require_git(false)
        .follow_links(false)
        .filter_entry(|entry| {
            if entry.depth() == 0 {
                return true;
            }
            if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                let name = entry.file_name().to_string_lossy();
                return !IGNORE_DIRS.contains(&name.as_ref());
            }
            true
        })
        .build();
    for entry in walker.flatten() {
        if !entry.file_type().map(|t| t.is_file()).unwrap_or(false) {
            continue;
        }
        candidates.push(entry.into_path());
        if candidates.len() >= cap {
            break;
        }
    }

    let mut entries: Vec<FileEntry> = candidates
        .into_par_iter()
        .filter(|path| is_indexable_text_file(path))
        .map(|path| FileEntry {
            rel: path
                .strip_prefix(root)
                .unwrap_or(&path)
                .to_string_lossy()
                .into_owned(),
            abs: path,
        })
        .collect();
    entries.sort_by(|a, b| a.rel.cmp(&b.rel));
    entries.truncate(max_files);
    entries
}

fn file_ext_lower(path: &Path) -> String {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| format!(".{}", e.to_lowercase()))
        .unwrap_or_default()
}

/// 可索引文本：黑名单排除 → 已知扩展 / 常见无扩展名 → 其余用内容嗅探。
fn is_indexable_text_file(path: &Path) -> bool {
    let ext = file_ext_lower(path);
    if !ext.is_empty() && IGNORE_EXT.iter().any(|e| *e == ext) {
        return false;
    }
    if !ext.is_empty() && KNOWN_TEXT_EXT.iter().any(|e| *e == ext) {
        return true;
    }
    let base = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
    if base == "Dockerfile"
        || base == "Makefile"
        || base == "Rakefile"
        || base == "Gemfile"
        || base == "Procfile"
        || base.starts_with(".env")
        || base.eq_ignore_ascii_case("readme")
        || base.eq_ignore_ascii_case("license")
        || base.eq_ignore_ascii_case("licence")
        || base.eq_ignore_ascii_case("changelog")
        || base.eq_ignore_ascii_case("authors")
        || base.eq_ignore_ascii_case("contributing")
    {
        return true;
    }
    // 无扩展名或未知扩展名：嗅探是否像文本，而不是继续往白名单里硬加类型。
    looks_like_text_file(path)
}

fn looks_like_text_file(path: &Path) -> bool {
    let meta = match std::fs::metadata(path) {
        Ok(m) => m,
        Err(_) => return false,
    };
    if !meta.is_file() || meta.len() == 0 || meta.len() > MAX_SNIFF_FILE_BYTES {
        return false;
    }
    let mut file = match std::fs::File::open(path) {
        Ok(f) => f,
        Err(_) => return false,
    };
    use std::io::Read;
    let mut buf = vec![0u8; SNIFF_BYTES.min(meta.len() as usize)];
    let n = match file.read(&mut buf) {
        Ok(n) => n,
        Err(_) => return false,
    };
    if n == 0 {
        return false;
    }
    buf.truncate(n);
    bytes_look_like_text(&buf)
}

fn bytes_look_like_text(buf: &[u8]) -> bool {
    if buf.iter().any(|&b| b == 0) {
        return false;
    }
    // UTF-8 BOM
    let sample = if buf.starts_with(&[0xEF, 0xBB, 0xBF]) {
        &buf[3..]
    } else {
        buf
    };
    if sample.is_empty() {
        return true;
    }
    // Prefer valid UTF-8; allow a small ratio of replacement via lossy only as last resort.
    if std::str::from_utf8(sample).is_ok() {
        return printable_ratio(sample) >= 0.85;
    }
    // Latin-1 / mixed: still accept if mostly printable ASCII + common whitespace
    printable_ratio(sample) >= 0.92
}

fn printable_ratio(buf: &[u8]) -> f32 {
    if buf.is_empty() {
        return 1.0;
    }
    let good = buf
        .iter()
        .filter(|&&b| b == b'\t' || b == b'\n' || b == b'\r' || (b >= 0x20 && b != 0x7f) || b >= 0x80)
        .count();
    good as f32 / buf.len() as f32
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn known_ext_and_sniff_txt_alike() {
        let dir = tempfile::tempdir().unwrap();
        let md = dir.path().join("a.md");
        std::fs::write(&md, "# hi").unwrap();
        assert!(is_indexable_text_file(&md));

        let weird = dir.path().join("note.weirdlang");
        std::fs::write(&weird, "hello world\n第二行\n").unwrap();
        assert!(is_indexable_text_file(&weird));

        let bin = dir.path().join("blob.bin");
        let mut f = std::fs::File::create(&bin).unwrap();
        f.write_all(&[0u8, 1, 2, 3, 255]).unwrap();
        assert!(!is_indexable_text_file(&bin));

        let png_named = dir.path().join("x.png");
        std::fs::write(&png_named, b"not really png but ignored by ext").unwrap();
        assert!(!is_indexable_text_file(&png_named));
    }

    fn rel_paths(dir: &Path) -> Vec<String> {
        let mut v: Vec<String> = collect_text_files(dir, 1000)
            .into_iter()
            .map(|e| e.rel.replace('\\', "/"))
            .collect();
        v.sort();
        v
    }

    /// 忽略规则的唯一来源是 `ignore` crate：项目自己的 .gitignore 必须被尊重。
    #[test]
    fn respects_project_gitignore() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join(".gitignore"), "generated/\n*.min.js\n").unwrap();
        std::fs::create_dir_all(dir.path().join("generated")).unwrap();
        std::fs::write(dir.path().join("generated/schema.rs"), "fn main() {}").unwrap();
        std::fs::write(dir.path().join("app.min.js"), "var a=1;").unwrap();
        std::fs::write(dir.path().join("app.js"), "var a=1;").unwrap();
        assert_eq!(rel_paths(dir.path()), vec!["app.js".to_string()]);
    }

    /// 没有 .gitignore 也必须跳过依赖树 / 构建产物目录（`IGNORE_DIRS` 存在的理由）。
    #[test]
    fn skips_dependency_and_build_dirs_without_gitignore() {
        let dir = tempfile::tempdir().unwrap();
        for sub in ["node_modules/pkg", "target/debug", "src"] {
            std::fs::create_dir_all(dir.path().join(sub)).unwrap();
        }
        std::fs::write(dir.path().join("node_modules/pkg/index.js"), "x").unwrap();
        std::fs::write(dir.path().join("target/debug/out.rs"), "x").unwrap();
        std::fs::write(dir.path().join("src/main.rs"), "fn main() {}").unwrap();
        assert_eq!(rel_paths(dir.path()), vec!["src/main.rs".to_string()]);
    }

    /// 隐藏项不进索引（有意取舍：宁可少索引点配置文件，也不把 .env 送进向量库）。
    #[test]
    fn skips_hidden_entries() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join(".venv/lib")).unwrap();
        std::fs::write(dir.path().join(".venv/lib/site.py"), "x").unwrap();
        std::fs::write(dir.path().join(".env"), "API_KEY=1").unwrap();
        std::fs::write(dir.path().join("main.py"), "print(1)").unwrap();
        assert_eq!(rel_paths(dir.path()), vec!["main.py".to_string()]);
    }
}

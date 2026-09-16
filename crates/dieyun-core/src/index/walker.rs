use std::collections::HashSet;
use std::path::{Path, PathBuf};

const IGNORE_DIRS: &[&str] = &[
    "node_modules",
    ".git",
    "dist",
    "build",
    "out",
    ".dieyun",
    "coverage",
    "__pycache__",
    ".venv",
    "venv",
    ".next",
    ".nuxt",
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

pub struct FileEntry {
    pub abs: PathBuf,
    pub rel: String,
}

pub fn collect_text_files(root: &Path, max_files: usize) -> Vec<FileEntry> {
    let mut out = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let read_dir = match std::fs::read_dir(&dir) {
            Ok(r) => r,
            Err(_) => continue,
        };
        for ent in read_dir.flatten() {
            let path = ent.path();
            let name = ent.file_name().to_string_lossy().into_owned();
            if path.is_dir() {
                if should_skip_dir(&name) {
                    continue;
                }
                stack.push(path);
            } else if is_indexable_text_file(&path) {
                let rel = path
                    .strip_prefix(root)
                    .unwrap_or(&path)
                    .to_string_lossy()
                    .into_owned();
                out.push(FileEntry { abs: path, rel });
                if out.len() >= max_files {
                    out.sort_by(|a, b| a.rel.cmp(&b.rel));
                    return out;
                }
            }
        }
    }
    out.sort_by(|a, b| a.rel.cmp(&b.rel));
    out
}

fn should_skip_dir(name: &str) -> bool {
    IGNORE_DIRS.contains(&name) || name.starts_with('.')
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

#[allow(dead_code)]
fn tokenize_for_semantic(text: &str) -> HashSet<String> {
    let s = text.to_lowercase();
    let mut set = HashSet::new();
    for ch in s.chars().filter(|c| ('\u{4e00}'..='\u{9fff}').contains(c)) {
        set.insert(ch.to_string());
    }
    let cjk: Vec<char> = s
        .chars()
        .filter(|c| ('\u{4e00}'..='\u{9fff}').contains(c))
        .collect();
    for w in cjk.windows(2) {
        set.insert(w.iter().collect());
    }
    for word in s.split(|c: char| c.is_whitespace() || "/\\._-+".contains(c)) {
        if (2..=48).contains(&word.len()) {
            set.insert(word.to_string());
        }
    }
    set
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
}

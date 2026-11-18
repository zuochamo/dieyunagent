use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

use serde::Serialize;

use dieyun_base::config::{normalize_read_params, AppConfig};
use dieyun_base::error::CoreError;

#[derive(Debug, Serialize)]
pub struct ReadFileResult {
    pub data: String,
    pub encoding: String,
    pub path: String,
    pub size: u64,
    /// 这一块**实际开始**的字节偏移（落在多字节字符中间时会向后对齐到字符起点）。
    pub offset: u64,
    /// 下一块该从这里读。**按它翻页就不会切碎字符**，也不会重复/跳过字节。
    pub next_offset: u64,
    pub truncated: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListDirEntry {
    pub name: String,
    pub is_directory: bool,
    pub size: u64,
    pub mtime_ms: f64,
}

pub fn read_file(
    config: &AppConfig,
    file_path: &str,
    encoding: Option<&str>,
    offset: Option<u64>,
    max_bytes: Option<u64>,
) -> Result<ReadFileResult, CoreError> {
    let safe = config.assert_allowed_path(Path::new(file_path))?;
    let enc = match encoding {
        Some("base64") => "base64",
        _ => "utf8",
    };
    let (offset, max_bytes) = normalize_read_params(offset, max_bytes);
    let meta = fs::metadata(&safe).map_err(|e| CoreError::rpc("FS_READ_FAILED", e.to_string()))?;
    let size = meta.len();
    if offset >= size {
        return Ok(ReadFileResult {
            data: String::new(),
            encoding: enc.to_string(),
            path: safe.to_string_lossy().into_owned(),
            size,
            offset,
            next_offset: offset,
            truncated: false,
        });
    }
    let mut file =
        fs::File::open(&safe).map_err(|e| CoreError::rpc("FS_READ_FAILED", e.to_string()))?;
    // 文本读取必须落在字符边界上：`offset` 可能是调用方按字节数出来的，也可能就是
    // 上一块的 `next_offset`。落在多字节字符中间时向后对齐到该字符起点，
    // 否则这一块会以一个 `�` 开头，模型会去「修」一处根本不存在的乱码。
    let start = if enc == "utf8" {
        align_to_char_boundary(&mut file, offset, size)?
    } else {
        offset
    };
    file.seek(SeekFrom::Start(start))
        .map_err(|e| CoreError::rpc("FS_READ_FAILED", e.to_string()))?;
    let read_len = max_bytes.min(size - start);
    let mut buf = vec![0u8; read_len as usize];
    let bytes_read = file
        .read(&mut buf)
        .map_err(|e| CoreError::rpc("FS_READ_FAILED", e.to_string()))?;
    buf.truncate(bytes_read);
    let (data, consumed) = if enc == "base64" {
        use base64::Engine;
        (
            base64::engine::general_purpose::STANDARD.encode(&buf),
            buf.len(),
        )
    } else {
        decode_utf8_block(&buf)
    };
    let next_offset = start + consumed as u64;
    Ok(ReadFileResult {
        data,
        encoding: enc.to_string(),
        path: safe.to_string_lossy().into_owned(),
        size,
        offset: start,
        next_offset,
        truncated: next_offset < size,
    })
}

/// 把 `offset` 对齐到字符起点：最多往前看 3 个字节（`offset` 本身就是边界就原样返回）。
///
/// 判据不是「前一个字节是不是续字节」——那只在 `offset` 恰好落在字符第二个字节之后才成立。
/// 正确做法是找到包住 `offset` 的那个首字节，按它声明的宽度算出这个字符的结束位置：
/// 结束位置越过 `offset` 就说明切在字符中间，退回首字节。
fn align_to_char_boundary(
    file: &mut fs::File,
    offset: u64,
    size: u64,
) -> Result<u64, CoreError> {
    if offset == 0 || offset >= size {
        return Ok(offset);
    }
    let back = offset.min(3) as usize;
    let from = offset - back as u64;
    let mut probe = [0u8; 3];
    file.seek(SeekFrom::Start(from))
        .map_err(|e| CoreError::rpc("FS_READ_FAILED", e.to_string()))?;
    let n = file
        .read(&mut probe[..back])
        .map_err(|e| CoreError::rpc("FS_READ_FAILED", e.to_string()))?;
    if n == 0 {
        return Ok(offset);
    }
    let Some(lead) = (0..n).rev().find(|j| probe[*j] & 0xC0 != 0x80) else {
        // 连续续字节都不成字符：文件本身不是 UTF-8，交给 lossy 兜底，不在这里纠偏。
        return Ok(offset);
    };
    let char_start = from + lead as u64;
    let width = match probe[lead] {
        0x00..=0x7f => 1,
        0xC0..=0xDF => 2,
        0xE0..=0xEF => 3,
        0xF0..=0xF7 => 4,
        _ => 1,
    };
    if char_start + width > offset {
        return Ok(char_start);
    }
    Ok(offset)
}

/// 解一「块」字节，返回（文本, 实际消费的字节数）。
///
/// 尾部若正好切在一个多字节字符中间，**只解到最后一个完整字符**，多出来的字节留给下一块
/// （`next_offset` 会指回那里）。整块都不是 UTF-8（二进制被当文本读）时退回整块 lossy ——
/// 否则 `next_offset` 原地不动，按它翻页会死循环。
fn decode_utf8_block(buf: &[u8]) -> (String, usize) {
    match std::str::from_utf8(buf) {
        Ok(text) => (text.to_string(), buf.len()),
        Err(err) if err.valid_up_to() == 0 => (String::from_utf8_lossy(buf).into_owned(), buf.len()),
        Err(err) => {
            let valid = err.valid_up_to();
            let text = std::str::from_utf8(&buf[..valid])
                .map(|s| s.to_string())
                .unwrap_or_else(|_| String::from_utf8_lossy(&buf[..valid]).into_owned());
            (text, valid)
        }
    }
}

pub fn list_dir(config: &AppConfig, dir_path: &str) -> Result<Vec<ListDirEntry>, CoreError> {
    let safe = config.assert_allowed_path(Path::new(dir_path))?;
    let read_dir =
        fs::read_dir(&safe).map_err(|e| CoreError::rpc("FS_LIST_FAILED", e.to_string()))?;
    let mut out = Vec::new();
    for ent in read_dir {
        let ent = ent.map_err(|e| CoreError::rpc("FS_LIST_FAILED", e.to_string()))?;
        let name = ent.file_name().to_string_lossy().into_owned();
        let meta = ent.metadata().ok();
        let (is_dir, size, mtime_ms) = match meta {
            Some(m) => (
                m.is_dir(),
                m.len(),
                m.modified()
                    .ok()
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_secs_f64() * 1000.0)
                    .unwrap_or(0.0),
            ),
            None => (false, 0, 0.0),
        };
        out.push(ListDirEntry {
            name,
            is_directory: is_dir,
            size,
            mtime_ms: mtime_ms,
        });
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn read(config: &AppConfig, path: &Path, offset: u64, max_bytes: u64) -> ReadFileResult {
        read_file(
            config,
            &path.to_string_lossy(),
            None,
            Some(offset),
            Some(max_bytes),
        )
        .expect("read")
    }

    /// 中文按**小到必然切在字符中间**的块翻页：不许出现 U+FFFD，拼回来必须等于原文。
    ///
    /// 旧实现直接 `String::from_utf8_lossy(&buf)`，每块的中文都会被切成 `�`，
    /// 模型于是去「修」一处根本不存在的乱码。
    #[test]
    fn chunked_reads_reassemble_chinese_text_without_replacement_chars() {
        let dir = tempfile::tempdir().unwrap();
        let config = AppConfig::default();
        let path = dir.path().join("cn.txt");
        let original = "第一段中文内容🙂第二段中文内容";
        std::fs::write(&path, original).unwrap();

        let mut got = String::new();
        let mut offset = 0u64;
        loop {
            let r = read(&config, &path, offset, 5);
            got.push_str(&r.data);
            if !r.truncated {
                break;
            }
            assert!(r.next_offset > offset, "next_offset 必须前进，否则翻页会死循环");
            offset = r.next_offset;
        }
        assert_eq!(got, original);
        assert!(!got.contains('\u{FFFD}'), "不许出现替换字符：{got}");
    }

    /// `offset` 落在多字节字符中间 → 对齐到该字符起点（而不是吐半个字符）。
    #[test]
    fn offset_inside_a_character_is_aligned_to_its_start() {
        let dir = tempfile::tempdir().unwrap();
        let config = AppConfig::default();
        let path = dir.path().join("cn.txt");
        std::fs::write(&path, "中文").unwrap(); // 「中」占 3 字节

        let r = read(&config, &path, 1, 3);
        assert_eq!(r.offset, 0, "应对齐到字符起点");
        assert_eq!(r.data, "中");
        assert_eq!(r.next_offset, 3);
        assert!(r.truncated, "后面还有「文」");
    }

    /// 二进制/非 UTF-8 内容：整块 lossy 解出并全部消费，`next_offset` 不许原地打转。
    #[test]
    fn non_utf8_block_still_advances() {
        let dir = tempfile::tempdir().unwrap();
        let config = AppConfig::default();
        let path = dir.path().join("bin.dat");
        std::fs::write(&path, [0xff, 0xfe, 0xfd, 0xfc]).unwrap();

        let r = read(&config, &path, 0, 4);
        assert_eq!(r.next_offset, 4, "整块消费掉");
        assert!(!r.truncated);
    }
}

use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

use serde::Serialize;

use crate::config::{normalize_read_params, AppConfig};
use crate::error::CoreError;

#[derive(Debug, Serialize)]
pub struct ReadFileResult {
    pub data: String,
    pub encoding: String,
    pub path: String,
    pub size: u64,
    pub offset: u64,
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
    let read_len = max_bytes.min(size.saturating_sub(offset));
    if read_len == 0 {
        return Ok(ReadFileResult {
            data: String::new(),
            encoding: enc.to_string(),
            path: safe.to_string_lossy().into_owned(),
            size,
            offset,
            truncated: offset < size,
        });
    }
    let mut file =
        fs::File::open(&safe).map_err(|e| CoreError::rpc("FS_READ_FAILED", e.to_string()))?;
    file.seek(SeekFrom::Start(offset))
        .map_err(|e| CoreError::rpc("FS_READ_FAILED", e.to_string()))?;
    let mut buf = vec![0u8; read_len as usize];
    let bytes_read = file
        .read(&mut buf)
        .map_err(|e| CoreError::rpc("FS_READ_FAILED", e.to_string()))?;
    buf.truncate(bytes_read);
    let truncated = offset + (bytes_read as u64) < size;
    let data = if enc == "base64" {
        use base64::Engine;
        base64::engine::general_purpose::STANDARD.encode(&buf)
    } else {
        String::from_utf8_lossy(&buf).into_owned()
    };
    Ok(ReadFileResult {
        data,
        encoding: enc.to_string(),
        path: safe.to_string_lossy().into_owned(),
        size,
        offset,
        truncated,
    })
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

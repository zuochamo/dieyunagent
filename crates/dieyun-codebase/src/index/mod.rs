mod repair;
mod build;
mod vectors;
mod status;
mod schema;
mod search;
pub(crate) mod vector_cache;
pub(crate) mod vector_pool;
mod walker;
mod workspace;

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use rusqlite::{params, Connection};
use serde::Serialize;

use dieyun_base::config::AppConfig;
use dieyun_base::error::CoreError;
use dieyun_base::sqlite::SqliteHandle;
use vector_pool::PoolCache;

use dieyun_base::embedding::{self, EmbeddingConfig};

pub use schema::{ensure_schema, init_schema, SCHEMA_VERSION};
pub use search::SearchResult;
pub use walker::{collect_text_files, collect_text_files_where};
pub use workspace::{resolve_workspace, WorkspaceRef};

pub(crate) const CHUNK_LINES: usize = 55;
pub(crate) const CHUNK_OVERLAP: usize = 10;
pub(crate) const MAX_FILES: usize = 16_000;
/// 每个写事务最多覆盖多少个文件。**index 与 graph 共用这一个数**：两条建库路径写的是
/// 同一个库文件（同一条常驻连接），各写一份分批阈值必然漂移。
///
/// 取值与「一批的切块耗时」同一量级（单文件毫秒级 → 一批几百毫秒），足够短到不让
/// 另一条写连接撞上 `database is locked`（busy_timeout 15s），又足够长到不会把 WAL
/// 打成一条条独立提交。建库幂等，分批提交不需要「要么全成要么全不成」。
pub(crate) const CHUNK_COMMIT_EVERY: usize = 128;
pub(crate) const CHUNK_CONTENT_MAX_CHARS: usize = 12000;

#[derive(Debug, Clone, Default)]
pub(crate) struct ProgressSnapshot {
    pub phase: String,
    pub files_done: i64,
    pub files_total: i64,
    pub chunk_count: i64,
    pub vector_count: i64,
    pub last_error: Option<String>,
}

/// 纳秒时间戳下限（1e12）：低于此值的存量记录是旧的「秒级」mtime。
/// 秒级精度会让同一秒内的两次保存被判为「未变化」，是增量索引漏更新的根因。
pub(crate) const MTIME_NS_FLOOR: i64 = 1_000_000_000_000;

/// 文件 mtime 纳秒时间戳（本地增量索引的判据）。
pub(crate) fn file_mtime_stamp(meta: &std::fs::Metadata) -> i64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_nanos().min(i64::MAX as u128) as i64)
        .unwrap_or(0)
}

/// 仅当存量记录已是纳秒精度且完全相等时才算未变化；
/// 旧的秒级记录一律视为已变化，从而重建一次并升级到纳秒精度。
pub(crate) fn mtime_unchanged(stored: i64, current: i64) -> bool {
    stored >= MTIME_NS_FLOOR && stored == current
}

pub(crate) fn truncate_chars(text: &str, max_chars: usize) -> &str {
    if text.chars().count() <= max_chars {
        return text;
    }
    match text.char_indices().nth(max_chars) {
        Some((idx, _)) => &text[..idx],
        None => text,
    }
}

#[derive(Clone)]
pub struct IndexService {
    /// codebase.db 句柄：与 `GraphService` 共享同一条常驻连接（同库，故同连接）。
    db: Arc<SqliteHandle>,
    embedding: EmbeddingConfig,
    indexing: Arc<Mutex<HashSet<String>>>,
    /// 本进程已经拿库实数核对过元数据的 root_hash：每个工作区只核一次。
    ///
    /// 为什么需要：`indexing` 旗标只能证明「这次崩了」，证明不了「上一进程崩过、旗标已被
    /// 前面某次 status 清掉、元数据却还是旧的」—— 那正是本仓 2026-11-04 的现场（元数据
    /// 10,846 段向量、库里只剩 1 条）。核对成本是一次 COUNT，按工作区、按进程各一次，
    /// 不进热路径。
    meta_checked: Arc<Mutex<HashSet<String>>>,
    progress: Arc<Mutex<HashMap<String, ProgressSnapshot>>>,
    /// root_hash -> 常驻内存 chunk 向量池
    vector_pools: PoolCache,
    /// 跨 worktree 的向量复用缓存（`<data_dir>/vector-cache.sqlite`）。
    /// 为 None 时退化为「每次都真算」——缓存是优化，不是正确性的一部分。
    vector_cache_path: Option<PathBuf>,
    vector_cache: Arc<Mutex<Option<vector_cache::VectorCache>>>,
}

impl IndexService {
    pub fn new(db: Arc<SqliteHandle>, embedding: EmbeddingConfig) -> Self {
        Self {
            db,
            embedding,
            indexing: Arc::new(Mutex::new(HashSet::new())),
            meta_checked: Arc::new(Mutex::new(HashSet::new())),
            progress: Arc::new(Mutex::new(HashMap::new())),
            vector_pools: PoolCache::new(),
            vector_cache_path: None,
            vector_cache: Arc::new(Mutex::new(None)),
        }
    }

    /// 打开「按内容哈希复用向量」的跨 worktree 缓存。
    ///
    /// 建库最贵的一环是 embedding；SSH 会话的索引库是每会话一份，没有复用时
    /// 每开一个会话就要把整仓重算一遍（见 `index/vector_cache.rs` 顶部说明）。
    pub fn with_vector_cache(mut self, path: Option<PathBuf>) -> Self {
        self.vector_cache_path = path;
        self
    }

    pub(crate) fn set_progress(
        &self,
        root_hash: &str,
        phase: &str,
        files_done: i64,
        files_total: i64,
        chunk_count: i64,
        vector_count: i64,
    ) {
        if let Ok(mut guard) = self.progress.lock() {
            let entry = guard.entry(root_hash.to_string()).or_default();
            entry.phase = phase.to_string();
            entry.files_done = files_done;
            entry.files_total = files_total;
            entry.chunk_count = chunk_count;
            entry.vector_count = vector_count;
            entry.last_error = None;
        }
    }

    pub(crate) fn set_progress_error(&self, root_hash: &str, err: &str) {
        if let Ok(mut guard) = self.progress.lock() {
            let entry = guard.entry(root_hash.to_string()).or_default();
            entry.phase = "error".into();
            entry.last_error = Some(err.to_string());
        }
    }

    pub(crate) fn clear_progress(&self, root_hash: &str) {
        if let Ok(mut guard) = self.progress.lock() {
            guard.remove(root_hash);
        }
    }

    /// 本进程第一次看到该工作区时返回 `true`（之后恒为 `false`）。
    ///
    /// 用途只有一处：`status` 首次读到某个工作区时，用库实数和元数据对一次账
    /// （见 [`meta_checked`](Self::meta_checked) 字段说明）。建库收尾会自己写对元数据，
    /// 所以「一次」就够；拿不到锁时按「已核对」处理，宁可少修一次也不要拖慢读。
    fn take_meta_check(&self, root_hash: &str) -> bool {
        match self.meta_checked.lock() {
            Ok(mut guard) => guard.insert(root_hash.to_string()),
            Err(_) => false,
        }
    }

    fn progress_for(&self, root_hash: &str) -> Option<ProgressSnapshot> {
        self.progress
            .lock()
            .ok()
            .and_then(|g| g.get(root_hash).cloned())
    }

    pub fn from_config(config: &AppConfig, db: Arc<SqliteHandle>) -> Self {
        // 向量复用缓存落在 data_dir（不写进项目：它是纯派生缓存，每个 worktree 一份毫无意义）
        let svc = Self::new(db, config.embedding.clone()).with_vector_cache(Some(
            config.data_dir.join(vector_cache::CACHE_FILE_NAME),
        ));
        // 起动时对一次账：根目录已经不在的工作区，索引行留着既占库体又让「库里有什么」
        // 的统计失真（实测某条已删项目留了 53,538 段区段）。构造期做，不和在跑的建库抢锁。
        let removed = svc.prune_missing_workspaces();
        if !removed.is_empty() {
            dieyun_base::obs::degraded(
                "index.prune_workspaces",
                &format!(
                    "清掉 {} 个根目录已消失的工作区：{}",
                    removed.len(),
                    removed.join(", ")
                ),
            );
        }
        svc
    }

    /// 独立连接：用于跨 `.await` 或分钟级长任务，避免长时间占用常驻锁。
    fn open_dedicated(&self) -> Result<Connection, CoreError> {
        self.db.open_dedicated()
    }

    /// 读侧连接（池化、受并发上限约束）：扫描型查询只借一次，不占常驻锁。
    fn read_conn(&self) -> Result<dieyun_base::sqlite::ReadConn<'_>, CoreError> {
        self.db.read_conn()
    }

    pub async fn search(
        &self,
        workspace_root: &str,
        query: &str,
        limit: Option<u32>,
    ) -> Result<SearchResult, CoreError> {
        let ws = resolve_workspace(workspace_root)?;
        // 分两段用连接：中间要 await embedding，而常驻锁的 MutexGuard 拿不过 await。
        // `st` 在两段之间沿用同一份快照，与改造前「先取状态、再检索」的取值时机一致。
        let st = self.status_impl(&ws)?;

        let mut query_vector = None;
        let can_vector = self.embedding.enabled()
            && st.vector_count > 0
            && self.embedding.signature()
                == st.embedding_model.as_deref().unwrap_or("");
        if can_vector {
            let q = query.trim();
            if !q.is_empty() {
                // 查询向量：本地推理是毫秒级矩阵乘；远端端点失败（含超时）时这次检索就没有
                // 向量通道 —— 向量通道本来就是可选增强，降级到子串检索即可，别把整次检索
                // （以及调用它的那轮对话）打挂。旧的「预判端点太慢就不发」已随本地推理删除。
                match embedding::embed_texts(&self.embedding, &[q.to_string()]).await {
                    Ok(vectors) => {
                        if let Some(vec) = vectors.into_iter().next() {
                            query_vector = Some(vec);
                        }
                    }
                    Err(err) => {
                        dieyun_base::obs::degraded("index.query_vector", &err.to_string());
                    }
                }
            }
        }

        // 检索本体可能很慢（FTS + 向量全扫 + 池加载）：借一条**读池**连接，
        // 既不占常驻锁，也不无限开连接（并发检索超过池上限时排队）。
        let conn = self.read_conn()?;
        // 向量通道**只**走常驻内存池（全量精确余弦）。池装载失败时不退化成抽样近似——
        // 抽样会让同一查询在池暖/冷时给出不同答案，且召回率无处可测（见 search.rs 里的融合说明）。
        let pool = if query_vector.is_some() {
            self.vector_pool_for(&conn, &ws.root_hash)
        } else {
            None
        };
        search::search(
            &conn,
            &ws.root_hash,
            query,
            limit,
            query_vector.as_deref(),
            pool.as_deref(),
        )
    }
}

/// status 读路径发现的脏状态：读路径只发现不写库，由调用方用独立连接补写
/// （见 [`IndexService::status_impl`]）。
pub(crate) struct StatusRepair {
    file_count: i64,
    chunk_count: i64,
    indexed_at: i64,
    /// 库里真实的向量条数（`chunk_vectors` 实数，不是上一轮写下的元数据）
    vector_count: i64,
    /// 向量为 0 时清空签名：留着旧签名会让面板/检索都以为「库里有那个模型的向量」
    embedding_model: Option<String>,
    embedding_dims: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusResult {
    pub ok: bool,
    pub indexed: bool,
    pub file_count: i64,
    pub chunk_count: i64,
    pub vector_count: i64,
    pub indexed_at: i64,
    pub indexing: bool,
    pub embedding_model: Option<String>,
    pub embedding_dims: i64,
    /// 当前配置是否启用了向量（`embedding_enabled` + 库里实际签名 = 面板要展示的两件事）
    pub embedding_enabled: bool,
    /// 库里已有向量、但签名与**当前设置**不一致 ⇒ 语义检索会静默退化成名称匹配，建议重建
    pub embedding_stale: bool,
    /// 上一次建库中「按内容哈希复用」的向量条数（跨 worktree，见 `index/vector_cache.rs`）
    pub vectors_reused: i64,
    /// 上一次建库中真正调用 embedding 端点的条数
    pub vectors_embedded: i64,
    /// 上一次建库「没能进索引」的文件数（超单文件上限 / 二进制 / 读不出来）。
    /// 说出来才有用：否则用户只会看到「我明明有这个文件，搜不到」。
    pub files_skipped: i64,
    /// 上一次建库是否被扫描上限（`MAX_FILES`）**截断**：仓比上限大时，多出来的文件
    /// 这一轮根本没被看到 —— 这与「被跳过」是两件事，必须分开报。
    pub files_truncated: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub phase: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub files_done: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub files_total: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartIndexResult {
    pub started: bool,
    pub already_running: bool,
    #[serde(flatten)]
    pub status: StatusResult,
}

/// chunk 写入的唯一入口（本机索引与远程摄取共用）。
///
/// 只写 `chunks` 一行：v4 起没有全文倒排表（`search.rs` 走子串扫描），`chunks` 是正文
/// 唯一来源；`chunk_vectors` 由调用方在拿到返回正文后单独写。
/// 空白片段不落库，返回 `None` 让调用方跳过；返回的正文与入库内容一致，可直接拿去算向量。
fn insert_chunk(
    conn: &Connection,
    root_hash: &str,
    rel_path: &str,
    start_line: i64,
    end_line: i64,
    slice: &str,
    mtime: i64,
) -> Result<Option<(i64, String)>, CoreError> {
    if slice.trim().is_empty() {
        return Ok(None);
    }
    let content = truncate_chars(slice, CHUNK_CONTENT_MAX_CHARS);
    // 每个分片一条 INSERT：走 `prepare_cached`，同一轮建库只编译一次语句
    // （全量建库是几万条，逐条 prepare + finalize 的解析开销不小）
    {
        let mut stmt = conn
            .prepare_cached(
                "INSERT INTO chunks (root_hash, rel_path, start_line, end_line, content, mtime)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            )
            .map_err(|e| CoreError::rpc("INDEX_FAILED", e.to_string()))?;
        stmt.execute(params![root_hash, rel_path, start_line, end_line, content, mtime])
            .map_err(|e| CoreError::rpc("INDEX_FAILED", e.to_string()))?;
    }
    Ok(Some((conn.last_insert_rowid(), content.to_string())))
}

/// `chunk_vectors` 写入的唯一入口：缓存命中与真算命中走同一条 SQL，
/// 免得两条路径的 upsert 语义（dims 覆盖）出现偏差。
fn write_chunk_vector(conn: &Connection, chunk_id: i64, vec: &[f32]) -> Result<(), CoreError> {
    // 与 insert_chunk 同理：每个分片一次，语句只编译一次
    let mut stmt = conn
        .prepare_cached(
            "INSERT INTO chunk_vectors (chunk_id, dims, vector) VALUES (?1, ?2, ?3)
             ON CONFLICT(chunk_id) DO UPDATE SET dims = excluded.dims, vector = excluded.vector",
        )
        .map_err(|e| CoreError::rpc("INDEX_FAILED", e.to_string()))?;
    stmt.execute(params![chunk_id, vec.len() as i64, embedding::vector_to_blob(vec)])
        .map_err(|e| CoreError::rpc("INDEX_FAILED", e.to_string()))?;
    Ok(())
}

/// 当前 Unix 秒（时间戳的唯一来源）。
fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn delete_all_chunks(conn: &Connection, root_hash: &str) -> Result<(), CoreError> {
    conn.execute(
        "DELETE FROM chunk_vectors WHERE chunk_id IN (SELECT id FROM chunks WHERE root_hash = ?1)",
        params![root_hash],
    )
    .ok();
    conn.execute("DELETE FROM chunks WHERE root_hash = ?1", params![root_hash])
        .map_err(|e| CoreError::rpc("INDEX_FAILED", e.to_string()))?;
    Ok(())
}

fn delete_chunks_for_path(conn: &Connection, root_hash: &str, rel: &str) -> Result<(), CoreError> {
    conn.execute(
        "DELETE FROM chunk_vectors
         WHERE chunk_id IN (SELECT id FROM chunks WHERE root_hash = ?1 AND rel_path = ?2)",
        params![root_hash, rel],
    )
    .ok();
    conn.execute(
        "DELETE FROM chunks WHERE root_hash = ?1 AND rel_path = ?2",
        params![root_hash, rel],
    )
    .map_err(|e| CoreError::rpc("INDEX_FAILED", e.to_string()))?;
    Ok(())
}

fn load_chunk_mtimes(conn: &Connection, root_hash: &str) -> Result<HashMap<String, i64>, CoreError> {
    let mut stmt = conn
        .prepare("SELECT rel_path, MAX(mtime) FROM chunks WHERE root_hash = ?1 GROUP BY rel_path")
        .map_err(|e| CoreError::rpc("INDEX_FAILED", e.to_string()))?;
    let rows = stmt
        .query_map(params![root_hash], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))
        .map_err(|e| CoreError::rpc("INDEX_FAILED", e.to_string()))?;
    let mut map = HashMap::new();
    for row in rows {
        let (rel, mtime) = row.map_err(|e| CoreError::rpc("INDEX_FAILED", e.to_string()))?;
        map.insert(rel, mtime);
    }
    Ok(map)
}

fn purge_stale_chunk_paths(
    conn: &Connection,
    root_hash: &str,
    keep: &HashSet<String>,
) -> Result<(), CoreError> {
    let stored: Vec<String> = {
        let mut stmt = conn
            .prepare("SELECT DISTINCT rel_path FROM chunks WHERE root_hash = ?1")
            .map_err(|e| CoreError::rpc("INDEX_FAILED", e.to_string()))?;
        let rows = stmt
            .query_map(params![root_hash], |r| r.get(0))
            .map_err(|e| CoreError::rpc("INDEX_FAILED", e.to_string()))?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row.map_err(|e| CoreError::rpc("INDEX_FAILED", e.to_string()))?);
        }
        out
    };
    for rel in stored {
        if !keep.contains(&rel) {
            delete_chunks_for_path(conn, root_hash, &rel)?;
        }
    }
    Ok(())
}

fn count_chunks(conn: &Connection, root_hash: &str) -> Result<i64, CoreError> {
    conn.query_row(
        "SELECT COUNT(*) FROM chunks WHERE root_hash = ?1",
        params![root_hash],
        |r| r.get(0),
    )
    .map_err(|e| CoreError::rpc("INDEX_FAILED", e.to_string()))
}

fn count_vectors(conn: &Connection, root_hash: &str) -> Result<i64, CoreError> {
    conn.query_row(
        "SELECT COUNT(*) FROM chunk_vectors WHERE chunk_id IN (SELECT id FROM chunks WHERE root_hash = ?1)",
        params![root_hash],
        |r| r.get(0),
    )
    .map_err(|e| CoreError::rpc("INDEX_FAILED", e.to_string()))
}

fn load_all_chunk_texts(conn: &Connection, root_hash: &str) -> Result<Vec<(i64, String)>, CoreError> {
    let mut stmt = conn
        .prepare("SELECT id, content FROM chunks WHERE root_hash = ?1")
        .map_err(|e| CoreError::rpc("INDEX_FAILED", e.to_string()))?;
    let rows = stmt
        .query_map(params![root_hash], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))
        .map_err(|e| CoreError::rpc("INDEX_FAILED", e.to_string()))?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row.map_err(|e| CoreError::rpc("INDEX_FAILED", e.to_string()))?);
    }
    Ok(out)
}

fn load_chunks_missing_vectors(
    conn: &Connection,
    root_hash: &str,
) -> Result<Vec<(i64, String)>, CoreError> {
    let mut stmt = conn
        .prepare(
            "SELECT c.id, c.content FROM chunks c
             LEFT JOIN chunk_vectors v ON v.chunk_id = c.id
             WHERE c.root_hash = ?1 AND v.chunk_id IS NULL",
        )
        .map_err(|e| CoreError::rpc("INDEX_FAILED", e.to_string()))?;
    let rows = stmt
        .query_map(params![root_hash], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))
        .map_err(|e| CoreError::rpc("INDEX_FAILED", e.to_string()))?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row.map_err(|e| CoreError::rpc("INDEX_FAILED", e.to_string()))?);
    }
    Ok(out)
}

#[cfg(test)]
#[path = "tests.rs"]
mod tests;

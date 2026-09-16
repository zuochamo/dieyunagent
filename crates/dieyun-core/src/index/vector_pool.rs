//! 常驻内存的向量池（chunk 向量与符号向量共用）。
//!
//! 向量原本以 f32 BLOB 存在 SQLite 里，每次检索都要逐行读出 + 反序列化
//! （实测 4096 维 31MB 约 54ms，而余弦只占 18ms）。搬进连续内存后，
//! 检索路径只剩余弦计算。
//!
//! 设计约束：
//! - **只做加速，不改语义**：仍是全量精确余弦，recall 保持 100%；
//! - 池只是缓存，缺失/不一致时回退到 SQL 路径，不影响正确性；
//! - 范数在加载时预计算，扫描时每个元素只做一次乘加。

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Instant;

use rusqlite::{params, Connection};

use crate::embedding::blob_to_vector;
use crate::error::CoreError;

/// 低于此相似度的向量命中直接丢弃（与 SQL 路径保持一致）。
pub(crate) const MIN_SIMILARITY: f64 = 0.05;

/// 每类向量缓存（chunk / 符号各一份）的内存上限；超出按最久未用淘汰。
pub(crate) const VECTOR_POOL_MAX_BYTES: usize = 3 * 1024 * 1024 * 1024;

const CHUNK_VECTOR_SQL: &str = "SELECT c.id, v.dims, v.vector FROM chunk_vectors v
     JOIN chunks c ON c.id = v.chunk_id
     WHERE c.root_hash = ?1
     ORDER BY c.id";

const SYMBOL_VECTOR_SQL: &str = "SELECT s.id, v.dims, v.vector FROM graph_symbol_vectors v
     JOIN graph_symbols s ON s.id = v.symbol_id
     WHERE s.root_hash = ?1
     ORDER BY s.id";

pub(crate) struct VectorPool {
    dims: usize,
    /// 连续存储：slot * dims .. (slot+1) * dims 为第 slot 条向量
    data: Vec<f32>,
    /// slot -> 主键（chunk_id 或 symbol_id）
    ids: Vec<i64>,
    /// slot -> 向量 L2 范数（预计算）
    norms: Vec<f32>,
    slot_of: HashMap<i64, usize>,
}

impl VectorPool {
    /// 读取 chunk 向量（codebase.search 用）。
    pub(crate) fn load(conn: &Connection, root_hash: &str) -> Result<Option<Self>, CoreError> {
        Self::load_with_sql(conn, CHUNK_VECTOR_SQL, root_hash)
    }

    /// 读取符号向量（graph.symbol_semantic_search 用）。
    pub(crate) fn load_symbols(
        conn: &Connection,
        root_hash: &str,
    ) -> Result<Option<Self>, CoreError> {
        Self::load_with_sql(conn, SYMBOL_VECTOR_SQL, root_hash)
    }

    fn load_with_sql(
        conn: &Connection,
        sql: &str,
        root_hash: &str,
    ) -> Result<Option<Self>, CoreError> {
        let fail = |e: rusqlite::Error| CoreError::rpc("INDEX_FAILED", e.to_string());
        let mut stmt = conn.prepare(sql).map_err(fail)?;
        let mut rows = stmt.query(params![root_hash]).map_err(fail)?;

        let mut dims = 0usize;
        let mut ids: Vec<i64> = Vec::new();
        let mut data: Vec<f32> = Vec::new();
        let mut norms: Vec<f32> = Vec::new();

        while let Some(row) = rows.next().map_err(fail)? {
            let id: i64 = row.get(0).map_err(fail)?;
            let d: i64 = row.get(1).map_err(fail)?;
            let blob: Vec<u8> = row.get(2).map_err(fail)?;
            if d <= 0 {
                continue;
            }
            let d = d as usize;
            if dims == 0 {
                dims = d;
            }
            // 混维度（模型切换残留）时跳过异常行，避免整池失效
            if d != dims {
                continue;
            }
            let Some(vec) = blob_to_vector(&blob, d) else {
                continue;
            };
            let mut acc = 0.0f64;
            for v in &vec {
                acc += (*v as f64) * (*v as f64);
            }
            ids.push(id);
            data.extend_from_slice(&vec);
            norms.push(acc.sqrt() as f32);
        }

        if dims == 0 || ids.is_empty() {
            return Ok(None);
        }
        let mut slot_of = HashMap::with_capacity(ids.len());
        for (slot, id) in ids.iter().enumerate() {
            slot_of.insert(*id, slot);
        }
        Ok(Some(Self {
            dims,
            data,
            ids,
            norms,
            slot_of,
        }))
    }

    #[cfg(test)]
    pub(crate) fn dims(&self) -> usize {
        self.dims
    }

    #[cfg(test)]
    pub(crate) fn len(&self) -> usize {
        self.ids.len()
    }

    /// 池占用的近似字节数，用于全局预算淘汰。
    pub(crate) fn bytes(&self) -> usize {
        self.data.len() * std::mem::size_of::<f32>()
            + self.norms.len() * std::mem::size_of::<f32>()
            + self.ids.len() * std::mem::size_of::<i64>()
            + self.slot_of.len() * 24
    }

    pub(crate) fn query_norm(q: &[f32]) -> f64 {
        let mut acc = 0.0f64;
        for v in q {
            acc += (*v as f64) * (*v as f64);
        }
        acc.sqrt()
    }

    pub(crate) fn matches_dims(&self, q: &[f32]) -> bool {
        self.dims > 0 && q.len() == self.dims
    }

    fn similarity_with_norm(&self, slot: usize, q: &[f32], q_norm: f64) -> f64 {
        let base = slot * self.dims;
        let v = &self.data[base..base + self.dims];
        let mut dot = 0.0f64;
        for i in 0..self.dims {
            dot += (q[i] as f64) * (v[i] as f64);
        }
        let denom = q_norm * (self.norms[slot] as f64);
        if denom <= 1e-8 {
            0.0
        } else {
            dot / denom
        }
    }

    /// 单个 id 的相似度（用于给词法候选补向量分）。
    pub(crate) fn similarity_of(&self, id: i64, q: &[f32], q_norm: f64) -> Option<f64> {
        let slot = *self.slot_of.get(&id)?;
        Some(self.similarity_with_norm(slot, q, q_norm))
    }

    /// 全量扫描，收集 (id, 相似度)，只保留超过阈值的项。
    pub(crate) fn scan_into(&self, q: &[f32], q_norm: f64, out: &mut Vec<(i64, f32)>) {
        out.clear();
        if self.dims == 0 || q.len() != self.dims || q_norm <= 1e-8 {
            return;
        }
        out.reserve(self.ids.len());
        for slot in 0..self.ids.len() {
            let sim = self.similarity_with_norm(slot, q, q_norm);
            if sim <= MIN_SIMILARITY {
                continue;
            }
            out.push((self.ids[slot], sim as f32));
        }
    }
}

struct Slot {
    pool: Arc<VectorPool>,
    last_used: Instant,
}

/// 向量池缓存：lazy 装载 + LRU + 字节预算淘汰。chunk 与符号各持一个实例。
/// Clone 共享同一份缓存（service 的 clone 不会复制池）。
#[derive(Clone)]
pub(crate) struct PoolCache {
    slots: Arc<Mutex<HashMap<String, Slot>>>,
}

impl Default for PoolCache {
    fn default() -> Self {
        Self::new()
    }
}

impl PoolCache {
    pub(crate) fn new() -> Self {
        Self {
            slots: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// 命中则刷新 LRU 并返回池；未命中返回 None（由调用方决定是否装载）。
    pub(crate) fn get(&self, key: &str) -> Option<Arc<VectorPool>> {
        let mut guard = self.slots.lock().ok()?;
        let slot = guard.get_mut(key)?;
        slot.last_used = Instant::now();
        Some(Arc::clone(&slot.pool))
    }

    pub(crate) fn contains(&self, key: &str) -> bool {
        self.slots
            .lock()
            .map(|g| g.contains_key(key))
            .unwrap_or(false)
    }

    /// 登记池并执行字节预算淘汰（最久未用优先释放）。
    pub(crate) fn insert(&self, key: &str, pool: Arc<VectorPool>) {
        let Ok(mut guard) = self.slots.lock() else {
            return;
        };
        guard.remove(key);
        let mut total: usize =
            guard.values().map(|s| s.pool.bytes()).sum::<usize>() + pool.bytes();
        if total > VECTOR_POOL_MAX_BYTES {
            let mut entries: Vec<(String, Instant, usize)> = guard
                .iter()
                .map(|(k, v)| (k.clone(), v.last_used, v.pool.bytes()))
                .collect();
            entries.sort_by_key(|(_, t, _)| *t);
            for (k, _, bytes) in entries {
                if total <= VECTOR_POOL_MAX_BYTES {
                    break;
                }
                guard.remove(&k);
                total = total.saturating_sub(bytes);
            }
        }
        guard.insert(
            key.to_string(),
            Slot {
                pool,
                last_used: Instant::now(),
            },
        );
    }

    pub(crate) fn remove(&self, key: &str) {
        if let Ok(mut guard) = self.slots.lock() {
            guard.remove(key);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::index::init_schema;

    fn pool_conn() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        init_schema(&conn).unwrap();
        conn.execute(
            "INSERT INTO workspaces (root_hash, root_path) VALUES ('rh', '/tmp')",
            [],
        )
        .unwrap();
        conn
    }

    fn insert_chunk(conn: &Connection, rel: &str, content: &str) -> i64 {
        conn.execute(
            "INSERT INTO chunks (root_hash, rel_path, start_line, end_line, content, mtime)
             VALUES ('rh', ?1, 1, 1, ?2, 0)",
            params![rel, content],
        )
        .unwrap();
        conn.last_insert_rowid()
    }

    fn insert_vector(conn: &Connection, chunk_id: i64, vec: &[f32]) {
        let blob = crate::embedding::vector_to_blob(vec);
        conn.execute(
            "INSERT INTO chunk_vectors (chunk_id, dims, vector) VALUES (?1, ?2, ?3)",
            params![chunk_id, vec.len() as i64, blob],
        )
        .unwrap();
    }

    #[test]
    fn loads_and_scans_exactly() {
        let conn = pool_conn();
        let a = insert_chunk(&conn, "a.rs", "alpha");
        let b = insert_chunk(&conn, "b.rs", "beta");
        insert_vector(&conn, a, &[1.0, 0.0]);
        insert_vector(&conn, b, &[0.0, 1.0]);

        let pool = VectorPool::load(&conn, "rh").unwrap().expect("pool");
        assert_eq!(pool.len(), 2);
        assert_eq!(pool.dims(), 2);

        let q = [1.0f32, 0.0];
        let qn = VectorPool::query_norm(&q);
        let mut hits = Vec::new();
        pool.scan_into(&q, qn, &mut hits);
        assert_eq!(hits.len(), 1, "正交向量应被 0.05 阈值过滤");
        assert_eq!(hits[0].0, a);
        assert!((hits[0].1 - 1.0).abs() < 1e-5);

        assert!((pool.similarity_of(a, &q, qn).unwrap() - 1.0).abs() < 1e-5);
        assert!(pool.similarity_of(b, &q, qn).unwrap().abs() < 1e-5);
    }

    #[test]
    fn skips_mismatched_dims_while_loading() {
        let conn = pool_conn();
        let a = insert_chunk(&conn, "a.rs", "alpha");
        let b = insert_chunk(&conn, "b.rs", "beta");
        insert_vector(&conn, a, &[1.0, 0.0]);
        insert_vector(&conn, b, &[1.0, 0.0, 0.0]);
        let pool = VectorPool::load(&conn, "rh").unwrap().unwrap();
        assert_eq!(pool.len(), 1, "混维度残留行应被跳过");
        assert_eq!(pool.dims(), 2);
    }

    #[test]
    fn loads_symbol_vectors_from_graph_tables() {
        let conn = pool_conn();
        conn.execute_batch(
            "CREATE TABLE graph_symbols (
                 id INTEGER PRIMARY KEY AUTOINCREMENT, root_hash TEXT NOT NULL, rel_path TEXT NOT NULL,
                 kind TEXT NOT NULL, name TEXT NOT NULL, qualified_name TEXT NOT NULL,
                 start_line INTEGER NOT NULL, end_line INTEGER NOT NULL, mtime INTEGER NOT NULL);
             CREATE TABLE graph_symbol_vectors (
                 symbol_id INTEGER PRIMARY KEY, dims INTEGER NOT NULL, vector BLOB NOT NULL,
                 symbol_mtime INTEGER NOT NULL);",
        )
        .unwrap();
        for (name, vec) in [
            ("alpha", [1.0f32, 0.0]),
            ("beta", [0.0f32, 1.0]),
        ] {
            conn.execute(
                "INSERT INTO graph_symbols (root_hash, rel_path, kind, name, qualified_name,
                                            start_line, end_line, mtime)
                 VALUES ('rh', 'a.rs', 'function', ?1, ?1, 1, 2, 0)",
                params![name],
            )
            .unwrap();
            let id = conn.last_insert_rowid();
            conn.execute(
                "INSERT INTO graph_symbol_vectors (symbol_id, dims, vector, symbol_mtime)
                 VALUES (?1, 2, ?2, 0)",
                params![id, crate::embedding::vector_to_blob(&vec)],
            )
            .unwrap();
        }
        let pool = VectorPool::load_symbols(&conn, "rh").unwrap().expect("pool");
        assert_eq!(pool.len(), 2);
        let q = [1.0f32, 0.0];
        let qn = VectorPool::query_norm(&q);
        let mut hits = Vec::new();
        pool.scan_into(&q, qn, &mut hits);
        assert_eq!(hits.len(), 1);
    }

    #[test]
    fn cache_is_lru_and_evictable() {
        let conn = pool_conn();
        let a = insert_chunk(&conn, "a.rs", "alpha");
        insert_vector(&conn, a, &[1.0, 0.0]);
        let pool = Arc::new(VectorPool::load(&conn, "rh").unwrap().unwrap());

        let cache = PoolCache::new();
        assert!(cache.get("rh").is_none());
        cache.insert("rh", Arc::clone(&pool));
        assert!(cache.contains("rh"));
        assert!(cache.get("rh").is_some());
        cache.remove("rh");
        assert!(!cache.contains("rh"));
        // 重新登记不应因 key 重复而重复计数
        cache.insert("rh", Arc::clone(&pool));
        cache.insert("rh", pool);
        assert!(cache.contains("rh"));
    }
}

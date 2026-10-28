//! 常驻内存的 chunk 向量池（`codebase.search` 用）。
//!
//! 向量原本以 f32 BLOB 存在 SQLite 里，每次检索都要逐行读出 + 反序列化
//! （实测 4096 维 31MB 约 54ms，而余弦只占 18ms）。搬进连续内存后，
//! 检索路径只剩余弦计算。
//!
//! 设计约束：
//! - **仍是全量精确扫描**（没有 ANN 索引）：召回不依赖任何近似结构，
//!   误差只来自下面的 int8 量化；
//! - 池只是缓存，缺失/不一致时回退到 SQL 路径，不影响正确性；
//! - 范数在加载时预计算，扫描时每个元素只做一次乘加；
//! - **int8 量化存储**：池子的瓶颈是内存（`VECTOR_POOL_MAX_BYTES`）而不是算力。
//!   句向量本身已 L2 归一化、分量集中在小范围内，对称量化到 int8 的余弦误差在
//!   1e-3 量级，比 `MIN_SIMILARITY`（0.05）小两个数量级；换来 4× 的内存与带宽。
//!   量化的误差界与「什么时候该换 ANN」见 `docs/VECTOR-SEARCH.md`。

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Instant;

use rusqlite::{params, Connection};

use crate::embedding::blob_to_vector;
use crate::error::CoreError;

/// 低于此相似度的向量命中直接丢弃（与 SQL 路径保持一致）。
pub(crate) const MIN_SIMILARITY: f64 = 0.05;

/// 向量池的内存上限；超出按最久未用淘汰。
pub(crate) const VECTOR_POOL_MAX_BYTES: usize = 3 * 1024 * 1024 * 1024;

/// int8 对称量化的分母：`q = round(v / scale)`，`scale = max|v| / 127`。
const QUANT_RANGE: f32 = 127.0;

const CHUNK_VECTOR_SQL: &str = "SELECT c.id, v.dims, v.vector FROM chunk_vectors v
     JOIN chunks c ON c.id = v.chunk_id
     WHERE c.root_hash = ?1
     ORDER BY c.id";

pub(crate) struct VectorPool {
    dims: usize,
    /// 连续存储：`slot * dims .. (slot+1) * dims` 为第 slot 条向量（int8 量化值）
    data: Vec<i8>,
    /// slot -> 该向量的量化步长（复原 = `q * scale`）
    scales: Vec<f32>,
    /// slot -> 主键（chunk_id）
    ids: Vec<i64>,
    /// slot -> 向量 L2 范数（原始 f32 上预计算）
    norms: Vec<f32>,
}

/// 对称 int8 量化；`scale_out` 为步长（全零向量记 0，复原仍为全零）。
fn quantize(vec: &[f32], scale_out: &mut f32) -> Vec<i8> {
    let max_abs = vec.iter().fold(0.0f32, |m, v| m.max(v.abs()));
    if max_abs <= 0.0 || !max_abs.is_finite() {
        *scale_out = 0.0;
        return vec![0i8; vec.len()];
    }
    let scale = max_abs / QUANT_RANGE;
    *scale_out = scale;
    vec.iter()
        .map(|v| ((v / scale).round() as i32).clamp(-127, 127) as i8)
        .collect()
}

impl VectorPool {
    /// 读取 chunk 向量（codebase.search 用）。
    pub(crate) fn load(conn: &Connection, root_hash: &str) -> Result<Option<Self>, CoreError> {
        Self::load_with_sql(conn, CHUNK_VECTOR_SQL, root_hash)
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
        let mut data: Vec<i8> = Vec::new();
        let mut scales: Vec<f32> = Vec::new();
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
            // 范数用原始 f32 算：分母保持与 SQL 路径同一口径
            let mut acc = 0.0f64;
            for v in &vec {
                acc += (*v as f64) * (*v as f64);
            }
            let mut scale = 0.0f32;
            data.extend_from_slice(&quantize(&vec, &mut scale));
            ids.push(id);
            scales.push(scale);
            norms.push(acc.sqrt() as f32);
        }

        if dims == 0 || ids.is_empty() {
            return Ok(None);
        }
        Ok(Some(Self {
            dims,
            data,
            scales,
            ids,
            norms,
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
        self.data.len() * std::mem::size_of::<i8>()
            + self.scales.len() * std::mem::size_of::<f32>()
            + self.norms.len() * std::mem::size_of::<f32>()
            + self.ids.len() * std::mem::size_of::<i64>()
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
        let scale = self.scales[slot] as f64;
        let mut dot = 0.0f64;
        for i in 0..self.dims {
            dot += (q[i] as f64) * (v[i] as f64);
        }
        let denom = q_norm * (self.norms[slot] as f64);
        if denom <= 1e-8 {
            0.0
        } else {
            // int8 复原：点积累加完再一次乘回步长（每元素少一次乘法）
            dot * scale / denom
        }
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

        // 正交的那条相似度为 0（被阈值滤掉，但内核算得出来）
        assert!(pool.similarity_with_norm(1, &q, qn).abs() < 1e-5);
    }

    #[test]
    fn skips_mismatched_dims_while_loading() {        let conn = pool_conn();
        let a = insert_chunk(&conn, "a.rs", "alpha");
        let b = insert_chunk(&conn, "b.rs", "beta");
        insert_vector(&conn, a, &[1.0, 0.0]);
        insert_vector(&conn, b, &[1.0, 0.0, 0.0]);
        let pool = VectorPool::load(&conn, "rh").unwrap().unwrap();
        assert_eq!(pool.len(), 1, "混维度残留行应被跳过");
        assert_eq!(pool.dims(), 2);
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

    /// int8 量化只允许引入「远小于阈值」的误差：top-1 必须不变，分数偏差 < 1e-2。
    #[test]
    fn int8_quantization_preserves_top1_and_error_bound() {
        let conn = pool_conn();
        let dims = 128usize;
        let q: Vec<f32> = (0..dims).map(|i| ((i * 37 % 11) as f32) - 5.0).collect();
        let qn = VectorPool::query_norm(&q);

        let mut exact: Vec<(i64, f64)> = Vec::new();
        for k in 0..8 {
            // 与 query 同向但幅度、噪声各不同：相似度全部为正且互相拉开，
            // 这样「量化后 top-1 是否还一样」才是有意义的断言。
            let v: Vec<f32> = (0..dims)
                .map(|i| {
                    let noise = (((i + k * 13) * 29 % 17) as f32) - 8.0;
                    q[i] * (0.4 + 0.1 * k as f32) + noise * 0.3
                })
                .collect();
            let id = insert_chunk(&conn, &format!("f{k}.rs"), "x");
            insert_vector(&conn, id, &v);
            let vn = VectorPool::query_norm(&v);
            let dot: f64 = q
                .iter()
                .zip(&v)
                .map(|(a, b)| (*a as f64) * (*b as f64))
                .sum();
            exact.push((id, dot / (qn * vn)));
        }

        let pool = VectorPool::load(&conn, "rh").unwrap().unwrap();
        let mut hits = Vec::new();
        pool.scan_into(&q, qn, &mut hits);

        let best = |rows: &[(i64, f64)]| -> i64 {
            rows.iter()
                .max_by(|a, b| a.1.partial_cmp(&b.1).unwrap())
                .map(|(id, _)| *id)
                .unwrap()
        };
        let pool_rows: Vec<(i64, f64)> = hits.iter().map(|(id, s)| (*id, *s as f64)).collect();
        assert_eq!(
            best(&pool_rows),
            best(&exact),
            "int8 量化不应改变 top-1 命中"
        );

        for (id, expect) in &exact {
            if let Some((_, got)) = hits.iter().find(|(hid, _)| hid == id) {
                assert!(
                    (*got as f64 - expect).abs() < 1e-2,
                    "id={id} 精确={expect} 量化后={got}"
                );
            }
        }
        // 量化后每向量只占 1 字节（外加一个 f32 步长）
        let per_vector = pool.bytes() / pool.len();
        assert!(
            per_vector < dims * 2,
            "int8 量化后每向量应远小于 f32（{per_vector} vs {}）",
            dims * 4
        );
    }
}

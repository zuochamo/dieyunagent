//! 按 chunk 内容哈希复用向量的**跨 worktree 缓存**。
//!
//! ## 为什么需要它
//!
//! SSH 会话的索引库是每会话一份（`<worktree>/.dieyun/index.sqlite`，见
//! `docs/MULTI-AGENT-WORKTREE-ISOLATION-PLAN.md`），而 embedding 是建库最贵的一环。
//! 没有复用时「乙案 + 向量」就等于**每开一个会话把整仓重新 embedding 一遍**——
//! 没人付得起，于是向量开关只能常年关着，检索只剩子串通道（中文自然语言几乎不命中）。
//! 这是 `docs/SSH-INDEX-COLD-START-PLAN.md` §6.6 / 批次 6。
//!
//! ## 为什么可以跨 worktree 复用
//!
//! 一条向量只由两样东西决定：**送进模型的文本**和 **embedding 签名（模型@维度）**。
//! 它跟「这段代码在哪个 worktree、哪个文件、第几行」毫无关系。所以键就是
//! `(sha256(实际送进模型的文本) 前 32 位, 签名)`——同一段代码在任何会话、任何目录下
//! 都命中同一条向量。
//!
//! 注意键用的是 [`dieyun_base::embedding::embedding_input`] 的产物（那才是真正发给端点的文本，
//! 超长 chunk 会被截断），不是原始正文：否则两个只在截断点之后不同的 chunk 会算两次、
//! 得到完全相同的向量。
//!
//! ## 为什么放在 data_dir 而不是项目里
//!
//! 它是**纯派生缓存**：删掉只影响下一次建库的速度，不影响任何正确性。写进项目会让每个
//! worktree 各多一份（正好是我们要避免的重复），也会进入用户的 git 视野。
//!
//! ## 失败策略
//!
//! 缓存不可用（磁盘满、文件被占用、schema 旧）时**一律降级为「没命中」**：建库照常走
//! 原始路径，只是慢一点。缓存永远不许让一次建库失败——它是优化，不是正确性的一部分。

use std::collections::HashMap;
use std::path::Path;
use std::time::Duration;

use rusqlite::{params, Connection};
use sha2::{Digest, Sha256};

use dieyun_base::error::CoreError;

/// 缓存文件名（`<data_dir>/vector-cache.sqlite`）。
pub const CACHE_FILE_NAME: &str = "vector-cache.sqlite";

/// 默认行数上限。**体积随模型维度变**，别按固定 4 KB/行 估：
/// 1024 维 ≈ 4 KB/行 ⇒ 15 万行 ≈ 600 MB；真机在用的 2560 维 ≈ 10 KB/行 ⇒ 约 1.5 GB
/// （见 `docs/VECTOR-SEARCH.md`）。这里的上限是「行数」，磁盘预算要按实际维度算。
///
/// 这个量级与「一份完整索引里的向量部分」（本机实测 344 MB）同阶——缓存换来的正是
/// 「不再为每个新 worktree 重算一遍」，所以允许它和一份索引一样大。超了按插入时间裁最老的。
pub const DEFAULT_MAX_ROWS: i64 = 150_000;

/// 一次 `IN (...)` 查询里最多带多少个键（SQLite 变量上限是 32766，留足余量）。
const LOOKUP_CHUNK: usize = 400;

/// 内容哈希：`sha256` 前 32 个十六进制字符（128 位）。
///
/// 用 sha2 而不是 `DefaultHasher`：后者不保证跨 Rust 版本稳定，缓存键一旦漂移，
/// 整个缓存会在升级后全部失效（表现是「升级后突然每个会话都在重算向量」）。
pub fn content_hash(embedding_input: &str) -> String {
    let digest = Sha256::digest(embedding_input.as_bytes());
    let hex: String = digest.iter().map(|b| format!("{b:02x}")).collect();
    hex[..32].to_string()
}

/// 跨 worktree 的向量缓存（一个 SQLite 文件，单写多读的进程内使用）。
pub struct VectorCache {
    conn: Connection,
}

impl VectorCache {
    /// 打开（不存在则建表）。父目录会自动创建。
    pub fn open(path: &Path) -> Result<Self, CoreError> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)
                .map_err(|e| CoreError::rpc("VECTOR_CACHE_IO", e.to_string()))?;
        }
        let conn = Connection::open(path)
            .map_err(|e| CoreError::rpc("VECTOR_CACHE_IO", e.to_string()))?;
        // 抢不到锁就放弃（缓存不是正确性的一部分，不能拖住建库）
        conn.busy_timeout(Duration::from_millis(1500))
            .map_err(|e| CoreError::rpc("VECTOR_CACHE_IO", e.to_string()))?;
        // WAL + NORMAL：一次性写入上万行时避免每条 fsync；缓存丢几条无所谓。
        let _ = conn.pragma_update(None, "journal_mode", "WAL");
        let _ = conn.pragma_update(None, "synchronous", "NORMAL");
        let cache = Self { conn };
        cache.ensure_schema()?;
        Ok(cache)
    }

    #[cfg(test)]
    pub fn open_in_memory() -> Result<Self, CoreError> {
        let conn = Connection::open_in_memory()
            .map_err(|e| CoreError::rpc("VECTOR_CACHE_IO", e.to_string()))?;
        let cache = Self { conn };
        cache.ensure_schema()?;
        Ok(cache)
    }

    fn ensure_schema(&self) -> Result<(), CoreError> {
        self.conn
            .execute_batch(
                "CREATE TABLE IF NOT EXISTS vector_cache (
                     content_hash TEXT NOT NULL,
                     model_sig    TEXT NOT NULL,
                     dims         INTEGER NOT NULL,
                     vector       BLOB NOT NULL,
                     created_at   INTEGER NOT NULL,
                     PRIMARY KEY (content_hash, model_sig)
                 ) WITHOUT ROWID;
                 CREATE INDEX IF NOT EXISTS idx_vector_cache_age ON vector_cache(created_at);",
            )
            .map_err(|e| CoreError::rpc("VECTOR_CACHE_SCHEMA", e.to_string()))
    }

    /// 批量取向量：只返回**签名相同且维度对得上**的行。
    ///
    /// 换模型/换维度时签名不同 ⇒ 全部 miss ⇒ 自然重算，不需要「先清空缓存」这种动作。
    pub fn get_many(
        &self,
        model_sig: &str,
        hashes: &[String],
        dims: usize,
    ) -> Result<HashMap<String, Vec<f32>>, CoreError> {
        let mut out = HashMap::new();
        if hashes.is_empty() || dims == 0 {
            return Ok(out);
        }
        for chunk in hashes.chunks(LOOKUP_CHUNK) {
            // 占位符 ?1 = model_sig，?2.. = hashes
            let placeholders: Vec<String> = (0..chunk.len()).map(|i| format!("?{}", i + 2)).collect();
            let sql = format!(
                "SELECT content_hash, vector FROM vector_cache
                 WHERE model_sig = ?1 AND content_hash IN ({})",
                placeholders.join(",")
            );
            let mut stmt = self
                .conn
                .prepare(&sql)
                .map_err(|e| CoreError::rpc("VECTOR_CACHE_QUERY", e.to_string()))?;
            let mut values: Vec<&dyn rusqlite::ToSql> = Vec::with_capacity(chunk.len() + 1);
            values.push(&model_sig);
            for h in chunk {
                values.push(h);
            }
            let rows = stmt
                .query_map(values.as_slice(), |r| {
                    Ok((r.get::<_, String>(0)?, r.get::<_, Vec<u8>>(1)?))
                })
                .map_err(|e| CoreError::rpc("VECTOR_CACHE_QUERY", e.to_string()))?;
            for row in rows {
                let (hash, blob) =
                    row.map_err(|e| CoreError::rpc("VECTOR_CACHE_QUERY", e.to_string()))?;
                if let Some(vec) = dieyun_base::embedding::blob_to_vector(&blob, dims) {
                    out.insert(hash, vec);
                }
            }
        }
        Ok(out)
    }

    /// 批量写入（同一 `(hash, sig)` 覆盖写）。返回实际写入行数。
    pub fn put_many(
        &self,
        model_sig: &str,
        rows: &[(String, Vec<f32>)],
        now: i64,
    ) -> Result<usize, CoreError> {
        if rows.is_empty() || model_sig.is_empty() {
            return Ok(0);
        }
        let tx = self
            .conn
            .unchecked_transaction()
            .map_err(|e| CoreError::rpc("VECTOR_CACHE_WRITE", e.to_string()))?;
        let mut n = 0usize;
        {
            let mut stmt = tx
                .prepare(
                    "INSERT INTO vector_cache (content_hash, model_sig, dims, vector, created_at)
                     VALUES (?1, ?2, ?3, ?4, ?5)
                     ON CONFLICT(content_hash, model_sig) DO UPDATE SET
                       dims = excluded.dims,
                       vector = excluded.vector,
                       created_at = excluded.created_at",
                )
                .map_err(|e| CoreError::rpc("VECTOR_CACHE_WRITE", e.to_string()))?;
            for (hash, vec) in rows {
                if vec.is_empty() {
                    continue;
                }
                let blob = dieyun_base::embedding::vector_to_blob(vec);
                stmt.execute(params![hash, model_sig, vec.len() as i64, blob, now])
                    .map_err(|e| CoreError::rpc("VECTOR_CACHE_WRITE", e.to_string()))?;
                n += 1;
            }
        }
        tx.commit()
            .map_err(|e| CoreError::rpc("VECTOR_CACHE_WRITE", e.to_string()))?;
        Ok(n)
    }

    pub fn count(&self) -> Result<i64, CoreError> {
        self.conn
            .query_row("SELECT COUNT(*) FROM vector_cache", [], |r| r.get(0))
            .map_err(|e| CoreError::rpc("VECTOR_CACHE_QUERY", e.to_string()))
    }

    /// 超过上限时按 `created_at` 裁掉最老的若干行。返回删除行数。
    ///
    /// 命中时**不**刷新 `created_at`：读路径上不写库（一次建库几千次命中就是几千次写），
    /// 所以这是「按写入时间」而不是严格 LRU。对缓存够用——最近新建的向量最可能被再次用到。
    ///
    /// `keep_after`（通常是本批写入的时间戳）之后的行**一律不裁**：同一批 `put_many` 的
    /// `created_at` 完全相同，只按 `created_at ASC` 排序会在这批里随机删——刚算完的向量
    /// 当场被丢掉，下一次建库还得重算一遍，正是这个缓存要避免的事。超大仓（>15 万片段）
    /// 会因此暂时超出上限，下次建库再裁。
    pub fn prune(&self, max_rows: i64, keep_after: i64) -> Result<usize, CoreError> {
        if max_rows <= 0 {
            return Ok(0);
        }
        let total = self.count()?;
        if total <= max_rows {
            return Ok(0);
        }
        let excess = total - max_rows;
        // 表是 WITHOUT ROWID（没有 rowid 列），按主键的整行值删；
        // `(a, b) IN (SELECT a, b ...)` 是 SQLite 3.15+ 的行值语法。
        let deleted = self
            .conn
            .execute(
                "DELETE FROM vector_cache WHERE (content_hash, model_sig) IN (
                     SELECT content_hash, model_sig FROM vector_cache
                     WHERE created_at < ?2
                     ORDER BY created_at ASC, content_hash ASC LIMIT ?1
                 )",
                params![excess, keep_after],
            )
            .map_err(|e| CoreError::rpc("VECTOR_CACHE_WRITE", e.to_string()))?;
        Ok(deleted)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vec3(a: f32, b: f32, c: f32) -> Vec<f32> {
        vec![a, b, c]
    }

    #[test]
    fn content_hash_is_stable_and_text_specific() {
        assert_eq!(content_hash("fn a() {}"), content_hash("fn a() {}"));
        assert_ne!(content_hash("fn a() {}"), content_hash("fn a() { }"));
        assert_eq!(content_hash("").len(), 32);
    }

    #[test]
    fn roundtrip_reuses_vectors_and_honours_signature() {
        let cache = VectorCache::open_in_memory().unwrap();
        let h = content_hash("fn parse_config() {}");
        cache
            .put_many("bge@3", &[(h.clone(), vec3(0.1, 0.2, 0.3))], 1)
            .unwrap();

        let hits = cache.get_many("bge@3", std::slice::from_ref(&h), 3).unwrap();
        assert_eq!(hits.len(), 1, "同签名同内容必须命中");
        assert!((hits[&h][1] - 0.2).abs() < 1e-6);

        // 换模型（签名不同）⇒ 不能拿旧向量充数，必须重算
        assert!(cache.get_many("other@3", std::slice::from_ref(&h), 3).unwrap().is_empty());
        // 维度对不上 ⇒ 同样不命中（避免解码出垃圾向量）
        assert!(cache.get_many("bge@3", std::slice::from_ref(&h), 1024).unwrap().is_empty());
    }

    #[test]
    fn prune_drops_oldest_rows_only() {
        let cache = VectorCache::open_in_memory().unwrap();
        let rows: Vec<(String, Vec<f32>)> = (0..5)
            .map(|i| (content_hash(&format!("chunk-{i}")), vec3(i as f32, 0.0, 0.0)))
            .collect();
        // created_at 递增：0 最老
        for (i, row) in rows.iter().enumerate() {
            cache.put_many("m@3", std::slice::from_ref(row), i as i64).unwrap();
        }
        assert_eq!(cache.count().unwrap(), 5);

        let deleted = cache.prune(3, i64::MAX).unwrap();
        assert_eq!(deleted, 2, "超出的两行要被裁掉");
        assert_eq!(cache.count().unwrap(), 3);

        let hashes: Vec<String> = rows.iter().map(|(h, _)| h.clone()).collect();
        let hits = cache.get_many("m@3", &hashes, 3).unwrap();
        assert!(!hits.contains_key(&hashes[0]), "最老的两条应被裁掉");
        assert!(!hits.contains_key(&hashes[1]));
        for h in &hashes[2..] {
            assert!(hits.contains_key(h), "较新的三条要留着");
        }
    }

    #[test]
    fn prune_keeps_the_batch_that_was_just_written() {
        let cache = VectorCache::open_in_memory().unwrap();
        // 老的一批（ts=1），新的一批（ts=2）；上限只够放新的这批
        for i in 0..4 {
            let row = (content_hash(&format!("old-{i}")), vec3(i as f32, 0.0, 0.0));
            cache.put_many("m@3", &[row], 1).unwrap();
        }
        for i in 0..4 {
            let row = (content_hash(&format!("new-{i}")), vec3(i as f32, 0.0, 0.0));
            cache.put_many("m@3", &[row], 2).unwrap();
        }
        assert_eq!(cache.count().unwrap(), 8);

        // keep_after = 2：同批（created_at=2）一条都不许裁，只裁老的那批
        let deleted = cache.prune(4, 2).unwrap();
        assert_eq!(deleted, 4);
        assert_eq!(cache.count().unwrap(), 4);
        let new_hashes: Vec<String> = (0..4)
            .map(|i| content_hash(&format!("new-{i}")))
            .collect();
        let hits = cache.get_many("m@3", &new_hashes, 3).unwrap();
        assert_eq!(hits.len(), 4, "刚算完的向量必须还在");
    }

    #[test]
    fn put_many_is_idempotent_on_same_key() {
        let cache = VectorCache::open_in_memory().unwrap();
        let h = content_hash("same");
        cache.put_many("m@3", &[(h.clone(), vec3(1.0, 0.0, 0.0))], 1).unwrap();
        cache.put_many("m@3", &[(h.clone(), vec3(0.0, 1.0, 0.0))], 2).unwrap();
        assert_eq!(cache.count().unwrap(), 1);
        let hits = cache.get_many("m@3", std::slice::from_ref(&h), 3).unwrap();
        assert!((hits[&h][1] - 1.0).abs() < 1e-6, "后写的覆盖前写的");
    }
}

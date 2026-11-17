//! 向量复用与向量池：按内容哈希复用、批量落库、池刷新。
//!
//! 从 `index/mod.rs` 机械搬来（纯移动）。这一层只回答「这份向量能不能复用 / 怎么落库」，
//! 触发与预算归 `build.rs`。

use std::collections::HashMap;
use std::sync::Arc;

use rusqlite::Connection;

use super::vector_cache;
use super::vector_pool::VectorPool;
use super::{now_secs, write_chunk_vector, IndexService};
use crate::embedding;
use crate::error::CoreError;

impl IndexService {

    /// 在缓存上做一次短操作：拿不到缓存（未配置 / 打开失败 / 加锁失败）就返回 None，
    /// 调用方按「全部未命中」处理。**不要**在这类闭包里 `await`：锁不能跨 await 持有。
    pub(crate) fn vector_cache_op<T>(&self, f: impl FnOnce(&vector_cache::VectorCache) -> Result<T, CoreError>) -> Option<T> {
        let path = self.vector_cache_path.clone()?;
        // 毒化的锁按「数据仍然可用」处理（与 sqlite.rs 的 with_conn 同规则）：
        // 这里持锁只是在用缓存连接，一次 panic 不该让本进程永久失去向量复用。
        let mut guard = self
            .vector_cache
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        if guard.is_none() {
            *guard = vector_cache::VectorCache::open(&path).ok();
        }
        let cache = guard.as_ref()?;
        f(cache).ok()
    }


    /// ① 向量复用的前半段（**同步**）：查跨 worktree 内容哈希缓存，命中项直接写进
    /// `chunk_vectors`。返回 `(未命中列表, 复用条数)`。
    ///
    /// 本机建库（[`Self::run_index`]）与远端摄取（`remote::index_remote_finish_inner`）都走这里：
    /// 「查缓存 → 补算 → 写库 → 回填缓存」只能有一份实现，否则复用在其中一条路径上悄悄失效
    /// （本仓反复踩过的坑）。分两段而不是合成一个 async fn，是因为 `&Connection` 不是 `Send`：
    /// 只要它跨过 `await`，整个 RPC handler 的 future 就再也 `Send` 不了。
    pub(crate) fn apply_cached_vectors(
        &self,
        conn: &Connection,
        pending: Vec<(i64, String)>,
    ) -> Result<(Vec<(i64, String, String)>, i64), CoreError> {
        // (chunk_id, 正文, 内容哈希)。哈希对象是**实际送进模型的文本**（`embedding_input`：
        // 超长 chunk 会被截断），不是原始正文——否则只在截断点之后不同的两个 chunk 会各算
        // 一次、拿到完全一样的向量。
        let pending: Vec<(i64, String, String)> = pending
            .into_iter()
            .map(|(id, text)| {
                let hash = vector_cache::content_hash(&embedding::embedding_input(&text));
                (id, text, hash)
            })
            .collect();
        if pending.is_empty() {
            return Ok((pending, 0));
        }
        let hashes: Vec<String> = pending.iter().map(|(_, _, h)| h.clone()).collect();
        // 同一段代码在别的 worktree / 上一个会话里算过的向量直接拿来用。这就是
        // 「每会话一份索引库（乙案）+ 向量」付得起的原因：换会话不换代码，第二次起
        // 整仓几乎全部命中，只剩改动的那几个 chunk 要真算。
        let cache_key = self.embedding.cache_key();
        let hits = self
            .vector_cache_op(|cache| {
                cache.get_many(&cache_key, &hashes, self.embedding.effective_dimensions() as usize)
            })
            .filter(|h| !h.is_empty());
        let Some(hits) = hits else {
            return Ok((pending, 0));
        };
        let mut reused = 0i64;
        let mut misses = Vec::with_capacity(pending.len());
        for (chunk_id, text, hash) in pending {
            match hits.get(&hash) {
                Some(vec) => {
                    write_chunk_vector(conn, chunk_id, vec)?;
                    reused += 1;
                }
                None => misses.push((chunk_id, text, hash)),
            }
        }
        Ok((misses, reused))
    }


    /// ② 向量复用的后半段（**同步**，在 `embed_batches` 之后调用）：把算出来的向量写库并
    /// 回填缓存（超上限时裁最老的）。`on_progress` 收到「本轮已写入的向量条数」（含复用）。
    pub(crate) fn store_embedded_vectors(
        &self,
        conn: &Connection,
        rows: Vec<(i64, Vec<f32>)>,
        hash_by_id: &HashMap<i64, String>,
        reused: i64,
        mut on_progress: impl FnMut(i64),
    ) -> Result<i64, CoreError> {
        let mut embedded = 0i64;
        let mut fresh: Vec<(String, Vec<f32>)> = Vec::with_capacity(rows.len());
        for (chunk_id, vec) in rows {
            if let Some(hash) = hash_by_id.get(&chunk_id) {
                fresh.push((hash.clone(), vec.clone()));
            }
            write_chunk_vector(conn, chunk_id, &vec)?;
            embedded += 1;
            if embedded == 1 || embedded % 32 == 0 {
                on_progress(reused + embedded);
            }
        }
        // 回填缓存。**失败一律吞掉**：缓存不可用只该让下次慢一点，不该让一次建库失败。
        let now_ts = now_secs();
        let cache_key = self.embedding.cache_key();
        self.vector_cache_op(|cache| {
            let written = cache.put_many(&cache_key, &fresh, now_ts)?;
            if written > 0 {
                cache.prune(vector_cache::DEFAULT_MAX_ROWS, now_ts)?;
            }
            Ok(())
        });
        Ok(embedded)
    }


    /// 取工作区的向量池：命中则刷新 LRU，否则从 SQLite 全量载入。
    /// 池只是加速层，加载失败时返回 None，调用方回退到 SQL 路径。
    pub(crate) fn vector_pool_for(&self, conn: &Connection, root_hash: &str) -> Option<Arc<VectorPool>> {
        if let Some(pool) = self.vector_pools.get(root_hash) {
            return Some(pool);
        }
        let pool = Arc::new(VectorPool::load(conn, root_hash).ok().flatten()?);
        self.vector_pools.insert(root_hash, Arc::clone(&pool));
        Some(pool)
    }


    /// 索引写入完成后重建池（仅当该工作区已加载过），保证检索读到最新向量。
    /// 重建发生在索引路径上，检索路径始终是纯内存扫描。
    pub(crate) fn refresh_pool(&self, conn: &Connection, root_hash: &str) {
        if !self.vector_pools.contains(root_hash) {
            return;
        }
        match VectorPool::load(conn, root_hash) {
            Ok(Some(p)) => self.vector_pools.insert(root_hash, Arc::new(p)),
            // 向量被清空或读取异常：丢弃池，让下次检索按需重建
            _ => self.vector_pools.remove(root_hash),
        }
    }


    /// embedding 端点是否可用（`model` 与 `base_url` 都配了且没被禁用）。
    ///
    /// 调用方要求 `vectors=true` 时先问这个：配置缺失时建库会**静默**退化成只建 chunk，
    /// 用户看着进度条走完、向量还是 0，不知道是没配端点。校验放在 RPC 入口，报错才可解释。
    pub fn vectors_available(&self) -> bool {
        self.embedding.enabled()
    }


}

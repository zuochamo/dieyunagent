use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use rusqlite::params;
use serde::Deserialize;

use super::workspace::WorkspaceRef;
use super::{delete_all_chunks, insert_chunk, IndexService, StatusResult};
use crate::embedding;
use crate::error::CoreError;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteFileInput {
    pub rel_path: String,
    pub content: String,
    pub mtime: i64,
}

pub(crate) struct RemoteIngestState {
    pub(crate) root_key: String,
    pub(crate) pending_embed: Vec<(i64, String)>,
    pub(crate) file_count: i64,
    pub(crate) chunk_count: i64,
    pub(crate) use_vectors: bool,
    pub(crate) embed_sig: String,
    pub(crate) embed_dims: u32,
}

#[derive(Clone, Default)]
pub struct RemoteIngestHandle {
    pub(crate) jobs: Arc<Mutex<HashMap<String, RemoteIngestState>>>,
}

impl IndexService {
    pub async fn index_remote_begin(
        &self,
        ws: &WorkspaceRef,
        force: bool,
        vectors: bool,
    ) -> Result<(), CoreError> {
        if !force {
            let st = self.status(&ws.key)?;
            let sig = self.embedding.signature();
            let embedding_stale = st.chunk_count > 0
                && !sig.is_empty()
                && st.embedding_model.as_deref().unwrap_or("") != sig;
            if st.indexed && !embedding_stale {
                return Ok(());
            }
        }

        {
            let mut guard = self
                .indexing
                .lock()
                .map_err(|_| CoreError::rpc("INDEX_BUSY", "索引锁不可用"))?;
            if guard.contains(&ws.root_hash) {
                return Ok(());
            }
            guard.insert(ws.root_hash.clone());
        }

        // begin / push / finish 是一次远程摄取会话，都是批量写：用独立连接，
        // 免得把常驻锁按在一批 DELETE/INSERT 上，拖住期间 UI 的 status 轮询。
        let conn = self.open_dedicated()?;
        conn.execute(
            "INSERT INTO workspaces (root_hash, root_path, indexing) VALUES (?1, ?2, 1)
             ON CONFLICT(root_hash) DO UPDATE SET indexing = 1, root_path = excluded.root_path",
            params![ws.root_hash, ws.key],
        )
        .map_err(|e| CoreError::rpc("INDEX_FAILED", e.to_string()))?;
        // 清空复用本机索引的同一个入口
        delete_all_chunks(&conn, &ws.root_hash)?;

        // 与 `run_index` 同一条规则：向量只在调用方显式要求时建。
        let use_vectors = vectors && self.embedding.enabled();
        let state = RemoteIngestState {
            root_key: ws.key.clone(),
            pending_embed: Vec::new(),
            file_count: 0,
            chunk_count: 0,
            use_vectors,
            embed_sig: self.embedding.signature(),
            embed_dims: if use_vectors {
                self.embedding.effective_dimensions()
            } else {
                0
            },
        };
        self.remote_ingest
            .jobs
            .lock()
            .map_err(|_| CoreError::rpc("INDEX_BUSY", "远程索引状态锁不可用"))?
            .insert(ws.root_hash.clone(), state);
        self.set_progress(&ws.root_hash, "chunking", 0, 0, 0, 0);
        Ok(())
    }

    pub fn index_remote_push(
        &self,
        ws: &WorkspaceRef,
        files: &[RemoteFileInput],
    ) -> Result<(), CoreError> {
        let mut jobs = self
            .remote_ingest
            .jobs
            .lock()
            .map_err(|_| CoreError::rpc("INDEX_BUSY", "远程索引状态锁不可用"))?;
        let state = jobs
            .get_mut(&ws.root_hash)
            .ok_or_else(|| CoreError::rpc("REMOTE_INDEX_STATE", "远程索引未 begin"))?;

        let conn = self.open_dedicated()?;
        let tx = conn
            .unchecked_transaction()
            .map_err(|e| CoreError::rpc("INDEX_FAILED", e.to_string()))?;

        for file in files {
            if file.content.contains('\0') {
                continue;
            }
            state.file_count += 1;
            let rel = file.rel_path.replace('\\', "/");

            for (start_line, end_line, slice) in
                crate::treesitter::iter_chunk_slices(&rel, &file.content)
            {
                let Some((id, content)) = insert_chunk(
                    &tx,
                    &ws.root_hash,
                    &rel,
                    start_line,
                    end_line,
                    &slice,
                    file.mtime,
                )?
                else {
                    continue;
                };
                state.chunk_count += 1;
                if state.use_vectors {
                    state.pending_embed.push((id, content));
                }
            }
        }

        let files_done = state.file_count;
        let chunks_done = state.chunk_count;
        drop(jobs);

        tx.commit()
            .map_err(|e| CoreError::rpc("INDEX_FAILED", e.to_string()))?;
        self.set_progress(
            &ws.root_hash,
            "chunking",
            files_done,
            files_done,
            chunks_done,
            0,
        );
        Ok(())
    }

    /// 远程摄取的收尾：**成功与失败都必须走到**，否则该工作区会被永久卡住。
    ///
    /// 半路失败（embedding 报错、写库失败）时若不清理：`self.indexing` 里留着这个
    /// root → `status` 恒报「索引中」、`codebase.search` 一直被 `INDEXING_IN_PROGRESS`
    /// 挡掉；`workspaces.indexing` 停在 1；`jobs` 里已无 state，再 `begin` 静默返回
    /// Ok 而 `push` 必然报 `REMOTE_INDEX_STATE`。只有重启进程能恢复。
    pub async fn index_remote_finish(&self, ws: &WorkspaceRef) -> Result<StatusResult, CoreError> {
        let result = self.index_remote_finish_inner(ws).await;

        // 唯一收尾点：无论成败，放锁 + 清 job + 清进度 / 落 indexing=0
        if let Ok(mut guard) = self.indexing.lock() {
            guard.remove(&ws.root_hash);
        }
        if let Ok(mut jobs) = self.remote_ingest.jobs.lock() {
            jobs.remove(&ws.root_hash);
        }
        match &result {
            Ok(_) => self.clear_progress(&ws.root_hash),
            Err(e) => {
                self.set_progress_error(&ws.root_hash, &e.to_string());
                if let Ok(conn) = self.open_dedicated() {
                    let _ = conn.execute(
                        "UPDATE workspaces SET indexing = 0 WHERE root_hash = ?1",
                        params![ws.root_hash],
                    );
                }
            }
        }
        result
    }

    async fn index_remote_finish_inner(
        &self,
        ws: &WorkspaceRef,
    ) -> Result<StatusResult, CoreError> {
        let mut state = self
            .remote_ingest
            .jobs
            .lock()
            .map_err(|_| CoreError::rpc("INDEX_BUSY", "远程索引状态锁不可用"))?
            .remove(&ws.root_hash)
            .ok_or_else(|| CoreError::rpc("REMOTE_INDEX_STATE", "远程索引未 begin"))?;

        let conn = self.open_dedicated()?;
        // 本次不要向量时（`vectors=false`）沿用库里的签名与维度，别把已有向量的元数据
        // 抹成 NULL/0——那会让 status 报 vectorCount=0，检索侧 `can_vector` 直接判 false，
        // 一次不带向量的重建就把语义检索通道静默关掉（与本地 `run_index` 同一条规则）。
        let (prev_embed_model, prev_embed_dims): (Option<String>, i64) = conn
            .query_row(
                "SELECT embedding_model, embedding_dims FROM workspaces WHERE root_hash = ?1",
                params![ws.root_hash],
                |r| {
                    Ok((
                        r.get::<_, Option<String>>(0)?,
                        r.get::<_, Option<i64>>(1)?.unwrap_or(0),
                    ))
                },
            )
            .unwrap_or((None, 0));

        // 本轮没建向量（增量 / 远端 push）时保留上一轮的复用统计，别把它抹成 0/0
        let mut vectors_reused: Option<i64> = None;
        let mut vectors_embedded: Option<i64> = None;
        if state.use_vectors && !state.pending_embed.is_empty() {
            self.set_progress(
                &ws.root_hash,
                "embedding",
                state.file_count,
                state.file_count,
                state.chunk_count,
                0,
            );
            // 与本机建库同一条实现（含跨 worktree 内容哈希复用）：SFTP 摄取也不能每次重算整仓
            let (misses, reused) = self.apply_cached_vectors(
                &conn,
                std::mem::take(&mut state.pending_embed),
            )?;
            vectors_reused = Some(reused);
            if reused > 0 {
                self.set_progress(
                    &ws.root_hash,
                    "embedding",
                    state.file_count,
                    state.file_count,
                    state.chunk_count,
                    reused,
                );
            }
            if !misses.is_empty() {
                let inputs: Vec<(i64, String)> = misses
                    .iter()
                    .map(|(id, text, _)| (*id, text.clone()))
                    .collect();
                let hash_by_id: HashMap<i64, String> = misses
                    .iter()
                    .map(|(id, _, h)| (*id, h.clone()))
                    .collect();
                let rows = embedding::embed_batches(&self.embedding, &inputs).await?;
                vectors_embedded = Some(self.store_embedded_vectors(
                    &conn,
                    rows,
                    &hash_by_id,
                    reused,
                    |written| {
                        self.set_progress(
                            &ws.root_hash,
                            "embedding",
                            state.file_count,
                            state.file_count,
                            state.chunk_count,
                            written,
                        );
                    },
                )?);
            }
        }

        // 以库里的真实条数为准：本次没建向量（增量 / 远端 push）时库里的向量仍在，
        // 只累加本批条数会把它写成 0。
        let vector_count = super::count_vectors(&conn, &ws.root_hash)?;

        self.set_progress(
            &ws.root_hash,
            "finishing",
            state.file_count,
            state.file_count,
            state.chunk_count,
            vector_count,
        );

        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        let (embedding_model, embed_dims) = if vector_count == 0 {
            (None, 0i64)
        } else if state.use_vectors {
            (Some(state.embed_sig.clone()), state.embed_dims as i64)
        } else {
            (prev_embed_model, prev_embed_dims)
        };

        conn.execute(
            "INSERT INTO workspaces (root_hash, root_path, file_count, chunk_count, vector_count,
             indexed_at, indexing, embedding_model, embedding_dims, vectors_reused, vectors_embedded)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, ?7, ?8, COALESCE(?9, 0), COALESCE(?10, 0))
             ON CONFLICT(root_hash) DO UPDATE SET
               root_path = excluded.root_path,
               file_count = excluded.file_count,
               chunk_count = excluded.chunk_count,
               vector_count = excluded.vector_count,
               indexed_at = excluded.indexed_at,
               indexing = 0,
               embedding_model = excluded.embedding_model,
               embedding_dims = excluded.embedding_dims,
               vectors_reused = COALESCE(?9, workspaces.vectors_reused),
               vectors_embedded = COALESCE(?10, workspaces.vectors_embedded)",
            params![
                ws.root_hash,
                state.root_key,
                state.file_count,
                state.chunk_count,
                vector_count,
                now,
                embedding_model,
                embed_dims,
                vectors_reused,
                vectors_embedded
            ],
        )
        .map_err(|e| CoreError::rpc("INDEX_FAILED", e.to_string()))?;

        // chunks 被整批换掉（begin 里 delete_all_chunks），常驻向量池里的 chunk id 全部
        // 作废。不刷新的话池里只剩查不到行的旧 id，向量通道整条静默消失（检索退化成
        // 词法 / 词元覆盖率），直到进程重启才恢复。
        self.refresh_pool(&conn, &ws.root_hash);

        self.status(&ws.key)
    }
}

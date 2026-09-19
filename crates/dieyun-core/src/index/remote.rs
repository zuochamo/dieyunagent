use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use rusqlite::params;
use serde::Deserialize;

use super::workspace::WorkspaceRef;
use super::{
    truncate_chars, IndexService, StatusResult, CHUNK_CONTENT_MAX_CHARS,
};
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
    ) -> Result<(), CoreError> {
        if !force {
            let st = self.status(&ws.key)?;
            let sig = self.embedding.signature(&self.models_dirs);
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
        conn.execute(
            "DELETE FROM chunk_vectors WHERE chunk_id IN (SELECT id FROM chunks WHERE root_hash = ?1)",
            params![ws.root_hash],
        )
        .ok();
        conn.execute(
            "DELETE FROM chunks_fts WHERE rowid IN (SELECT id FROM chunks WHERE root_hash = ?1)",
            params![ws.root_hash],
        )
        .ok();
        conn.execute(
            "DELETE FROM chunks WHERE root_hash = ?1",
            params![ws.root_hash],
        )
        .map_err(|e| CoreError::rpc("INDEX_FAILED", e.to_string()))?;

        let use_vectors = self.embedding.enabled(&self.models_dirs);
        let state = RemoteIngestState {
            root_key: ws.key.clone(),
            pending_embed: Vec::new(),
            file_count: 0,
            chunk_count: 0,
            use_vectors,
            embed_sig: self.embedding.signature(&self.models_dirs),
            embed_dims: if use_vectors {
                self.embedding.effective_dimensions(&self.models_dirs)
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

            let mut push_chunk =
                |start_line: i64, end_line: i64, slice: &str| -> Result<(), CoreError> {
                    if slice.trim().is_empty() {
                        return Ok(());
                    }
                    let content = truncate_chars(slice, CHUNK_CONTENT_MAX_CHARS);
                    tx.execute(
                    "INSERT INTO chunks (root_hash, rel_path, start_line, end_line, content, mtime)
                         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                    params![ws.root_hash, rel, start_line, end_line, content, file.mtime],
                )
                .map_err(|e| CoreError::rpc("INDEX_FAILED", e.to_string()))?;
                    let id = tx.last_insert_rowid();
                    tx.execute(
                        "INSERT INTO chunks_fts (rowid, rel_path, content) VALUES (?1, ?2, ?3)",
                        params![id, rel, content],
                    )
                    .map_err(|e| CoreError::rpc("INDEX_FAILED", e.to_string()))?;
                    state.chunk_count += 1;
                    if state.use_vectors && !content.trim().is_empty() {
                        state.pending_embed.push((id, content.to_string()));
                    }
                    Ok(())
                };

            for (start_line, end_line, slice) in
                crate::treesitter::iter_chunk_slices(&rel, &file.content)
            {
                push_chunk(start_line, end_line, &slice)?;
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

    pub async fn index_remote_finish(&self, ws: &WorkspaceRef) -> Result<StatusResult, CoreError> {
        let state = self
            .remote_ingest
            .jobs
            .lock()
            .map_err(|_| CoreError::rpc("INDEX_BUSY", "远程索引状态锁不可用"))?
            .remove(&ws.root_hash)
            .ok_or_else(|| CoreError::rpc("REMOTE_INDEX_STATE", "远程索引未 begin"))?;

        let conn = self.open_dedicated()?;
        let mut vector_count = 0i64;
        if state.use_vectors && !state.pending_embed.is_empty() {
            self.set_progress(
                &ws.root_hash,
                "embedding",
                state.file_count,
                state.file_count,
                state.chunk_count,
                0,
            );
            let embedded =
                embedding::embed_batches(&self.embedding, &self.models_dirs, &state.pending_embed)
                    .await?;
            for (chunk_id, vec) in embedded {
                let blob = embedding::vector_to_blob(&vec);
                conn.execute(
                    "INSERT INTO chunk_vectors (chunk_id, dims, vector) VALUES (?1, ?2, ?3)",
                    params![chunk_id, vec.len() as i64, blob],
                )
                .map_err(|e| CoreError::rpc("INDEX_FAILED", e.to_string()))?;
                vector_count += 1;
            }
        }

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
        let embedding_model = if state.use_vectors && vector_count > 0 {
            Some(state.embed_sig)
        } else {
            None
        };

        conn.execute(
            "INSERT INTO workspaces (root_hash, root_path, file_count, chunk_count, vector_count,
             indexed_at, indexing, embedding_model, embedding_dims)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, ?7, ?8)
             ON CONFLICT(root_hash) DO UPDATE SET
               root_path = excluded.root_path,
               file_count = excluded.file_count,
               chunk_count = excluded.chunk_count,
               vector_count = excluded.vector_count,
               indexed_at = excluded.indexed_at,
               indexing = 0,
               embedding_model = excluded.embedding_model,
               embedding_dims = excluded.embedding_dims",
            params![
                ws.root_hash,
                state.root_key,
                state.file_count,
                state.chunk_count,
                vector_count,
                now,
                embedding_model,
                state.embed_dims as i64
            ],
        )
        .map_err(|e| CoreError::rpc("INDEX_FAILED", e.to_string()))?;

        if let Ok(mut guard) = self.indexing.lock() {
            guard.remove(&ws.root_hash);
        }
        self.clear_progress(&ws.root_hash);
        self.status(&ws.key)
    }
}

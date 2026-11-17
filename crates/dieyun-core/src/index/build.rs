//! 建库主循环：walk → 切块 → 向量复用/补算 → 写元数据（含进度与增量判定）。
//!
//! 从 `index/mod.rs` 机械搬来（纯移动）。这一层只负责「按顺序把活干完」；
//! 状态判定归 `status.rs`，向量复用细节归 `vectors.rs`，路径失效判定归 `repair.rs`，
//! 写库原语（`insert_chunk` / `delete_chunks_for_path` …）仍留在 `mod.rs`。

use std::collections::{HashMap, HashSet};
use std::path::Path;

use rusqlite::params;

use super::{
    count_chunks, count_vectors, delete_all_chunks, delete_chunks_for_path, file_mtime_stamp,
    insert_chunk, load_all_chunk_texts, load_chunk_mtimes, load_chunks_missing_vectors,
    mtime_unchanged, now_secs, purge_stale_chunk_paths, resolve_workspace, walker, IndexService,
    RemoteFileInput, StartIndexResult, StatusResult, MAX_FILES,
};
use crate::embedding;
use crate::error::CoreError;

/// 每个写事务最多覆盖多少个文件。
///
/// 取值与「一批的切块耗时」同一量级（单文件毫秒级 → 一批几百毫秒），足够短到不让同库
/// 另一条写连接（graph 建库）撞上 `database is locked`（busy_timeout 15s），又足够长到
/// 不会把 WAL 打成一条条独立提交。索引幂等，分批提交不需要「要么全成要么全不成」。
const CHUNK_COMMIT_EVERY: usize = 128;

impl IndexService {

    /// 后台启动本地索引（立即返回，便于轮询 status 进度）
    /// - `force`: 全量清空再建
    /// - `skip_if_ready`: true 时若已就绪则跳过（prep 门闩）；false 时即使已索引也启动 mtime 增量（保存后刷新）
    /// - `vectors`: 是否同时生成向量。**显式 opt-in**（默认 false）：向量是这套索引里
    ///   最贵的一环（embedding 调用 + 343 MB 库体），而实测调用率极低（见
    ///   docs/INDEX-VALUE-REVIEW.md §3）。只有调用方明确要语义检索时才建。
    pub fn start_index_workspace(
        &self,
        workspace_root: &str,
        force: bool,
        skip_if_ready: bool,
        vectors: bool,
    ) -> Result<StartIndexResult, CoreError> {
        let ws = resolve_workspace(workspace_root)?;
        if ws.is_remote {
            return Err(CoreError::rpc(
                "REMOTE_INDEX_REQUIRED",
                "远程工作空间请使用 codebase.index_remote 或在远端本地路径上建索引",
            ));
        }
        let root = ws
            .local_path
            .as_ref()
            .ok_or_else(|| CoreError::rpc("INVALID_WORKSPACE", "无法解析本地工作区"))?
            .clone();
        let root_hash = ws.root_hash.clone();
        let workspace_key = workspace_root.to_string();

        // 注意：切勿在持有 self.indexing 锁时调用 self.status()，
        // status() 会再次加同一把非重入锁 → 死锁。故先把“是否已在跑”读出来即释放锁。
        let already_running = {
            let guard = self
                .indexing
                .lock()
                .map_err(|_| CoreError::rpc("INDEX_BUSY", "索引锁不可用"))?;
            guard.contains(&root_hash)
        };
        if already_running {
            let st = self.status(workspace_root)?;
            return Ok(StartIndexResult {
                started: false,
                already_running: true,
                status: st,
            });
        }
        if !force && skip_if_ready {
            let st = self.status(workspace_root)?;
            // prep / send 门闩：已建库即可跳过（含空仓）；embedding 过期交给后台增量，勿堵住发消息
            if st.indexed {
                return Ok(StartIndexResult {
                    started: false,
                    already_running: false,
                    status: st,
                });
            }
        }
        {
            let mut guard = self
                .indexing
                .lock()
                .map_err(|_| CoreError::rpc("INDEX_BUSY", "索引锁不可用"))?;
            // 复核竞态：上面查 status 期间可能有其它线程已启动
            if guard.contains(&root_hash) {
                drop(guard);
                let st = self.status(workspace_root)?;
                return Ok(StartIndexResult {
                    started: false,
                    already_running: true,
                    status: st,
                });
            }
            guard.insert(root_hash.clone());
        }

        self.set_progress(&root_hash, "walking", 0, 0, 0, 0);

        let svc = self.clone();
        let hash = root_hash.clone();
        // 独立线程 + 自有 runtime：stdio 可在建库时继续处理 codebase.status
        std::thread::Builder::new()
            .name("dieyun-codebase-index".into())
            .spawn(move || {
                let finish = |svc: &IndexService, hash: &str, result: Result<(), CoreError>| {
                    if let Ok(mut guard) = svc.indexing.lock() {
                        guard.remove(hash);
                    }
                    match result {
                        Ok(_) => svc.clear_progress(hash),
                        Err(e) => {
                            svc.set_progress_error(hash, &e.to_string());
                            if let Ok(conn) = svc.open_dedicated() {
                                let _ = conn.execute(
                                    "UPDATE workspaces SET indexing = 0 WHERE root_hash = ?1",
                                    params![hash],
                                );
                            }
                        }
                    }
                };
                let rt = match tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                {
                    Ok(rt) => rt,
                    Err(e) => {
                        finish(
                            &svc,
                            &hash,
                            Err(CoreError::rpc("INDEX_FAILED", format!("index runtime: {e}"))),
                        );
                        return;
                    }
                };
                let result = rt.block_on(svc.run_index(&root, &hash, force, vectors));
                finish(&svc, &hash, result);
                let _ = workspace_key;
            })
            .map_err(|e| CoreError::rpc("INDEX_FAILED", format!("无法启动索引线程: {e}")))?;

        // 避免在写库线程刚启动时同步 status 可能长时间阻塞；返回进行中快照
        Ok(StartIndexResult {
            started: true,
            already_running: false,
            status: StatusResult {
                ok: true,
                indexed: false,
                file_count: 0,
                chunk_count: 0,
                vector_count: 0,
                indexed_at: 0,
                indexing: true,
                embedding_model: None,
                embedding_dims: 0,
                embedding_enabled: self.embedding.enabled(),
                embedding_stale: false,
                vectors_reused: 0,
                vectors_embedded: 0,
                phase: Some("walking".into()),
                files_done: Some(0),
                files_total: None,
                last_error: None,
            },
        })
    }


    pub async fn index_workspace(
        &self,
        workspace_root: &str,
        force: bool,
        vectors: bool,
    ) -> Result<StatusResult, CoreError> {
        let ws = resolve_workspace(workspace_root)?;
        if ws.is_remote {
            return Err(CoreError::rpc(
                "REMOTE_INDEX_REQUIRED",
                "远程工作空间请使用 codebase.index_remote",
            ));
        }
        let root = ws
            .local_path
            .as_ref()
            .ok_or_else(|| CoreError::rpc("INVALID_WORKSPACE", "无法解析本地工作区"))?;
        let root_hash = ws.root_hash.clone();
        {
            let mut guard = self
                .indexing
                .lock()
                .map_err(|_| CoreError::rpc("INDEX_BUSY", "索引锁不可用"))?;
            if guard.contains(&root_hash) {
                // 先放锁再查状态：status() 会再加同一把非重入锁，持锁调用即死锁。
                // 与 start_index_workspace 的写法对齐（那里早就踩过这个坑）。
                drop(guard);
                return self.status(workspace_root);
            }
            // sync index：始终跑一遍（force=false 时按 mtime 增量），供保存后后台刷新
            guard.insert(root_hash.clone());
        }

        self.set_progress(&root_hash, "walking", 0, 0, 0, 0);
        let result = self.run_index(root, &root_hash, force, vectors).await;
        if let Ok(mut guard) = self.indexing.lock() {
            guard.remove(&root_hash);
        }
        match &result {
            Ok(_) => self.clear_progress(&root_hash),
            Err(e) => self.set_progress_error(&root_hash, &e.to_string()),
        }
        result?;
        self.status(workspace_root)
    }


    pub async fn index_remote(
        &self,
        workspace_root: &str,
        files: Vec<RemoteFileInput>,
        force: bool,
        vectors: bool,
    ) -> Result<StatusResult, CoreError> {
        let ws = resolve_workspace(workspace_root)?;
        if !ws.is_remote {
            return Err(CoreError::rpc(
                "LOCAL_INDEX_REQUIRED",
                "本地工作空间请使用 codebase.index",
            ));
        }
        self.index_remote_begin(&ws, force, vectors).await?;
        if !force {
            let st = self.status(workspace_root)?;
            let sig = self.embedding.signature();
            let embedding_stale = st.chunk_count > 0
                && !sig.is_empty()
                && st.embedding_model.as_deref().unwrap_or("") != sig;
            if st.indexed && !embedding_stale {
                return Ok(st);
            }
        }
        const BATCH: usize = 30;
        for batch in files.chunks(BATCH) {
            self.index_remote_push(&ws, batch)?;
        }
        self.index_remote_finish(&ws).await
    }


    /// 全量 / 增量建库。统计值直接写进 `workspaces` 与进度快照，调用方只看成败。
    async fn run_index(
        &self,
        root: &Path,
        root_hash: &str,
        force: bool,
        vectors: bool,
    ) -> Result<(), CoreError> {
        // 跨 await + 分钟级任务：既拿不住 MutexGuard，也不该占着常驻锁。
        let conn = self.open_dedicated()?;
        conn.execute(
            "INSERT INTO workspaces (root_hash, root_path, indexing) VALUES (?1, ?2, 1)
             ON CONFLICT(root_hash) DO UPDATE SET indexing = 1, root_path = excluded.root_path",
            params![root_hash, root.to_string_lossy()],
        )
        .map_err(|e| CoreError::rpc("INDEX_FAILED", e.to_string()))?;

        if force {
            delete_all_chunks(&conn, root_hash)?;
        }

        self.set_progress(root_hash, "walking", 0, 0, 0, 0);
        let files = walker::collect_text_files(root, MAX_FILES);
        let files_total = files.len() as i64;
        self.set_progress(root_hash, "chunking", 0, files_total, 0, 0);

        let stored_mtimes = if force {
            HashMap::new()
        } else {
            load_chunk_mtimes(&conn, root_hash)?
        };
        let rel_set: HashSet<String> = files
            .iter()
            .map(|f| f.rel.replace('\\', "/"))
            .collect();
        if !force {
            purge_stale_chunk_paths(&conn, root_hash, &rel_set)?;
        }

        // 向量是**显式 opt-in**：调用方要（`vectors=true`）且 embedding 配置可用才建。
        // 没有向量时 `chunks` 仍可检索（子串通道），索引照样能用。
        let use_vectors = vectors && self.embedding.enabled();
        let embed_sig = self.embedding.signature();
        // 库里已有的向量签名：本次**不要**向量时要沿用它（见下方 opt-in 语义说明），
        // 不能因为"这次不写向量"就把元数据抹掉。
        let (prev_embed_model, prev_embed_dims): (Option<String>, i64) = conn
            .query_row(
                "SELECT embedding_model, embedding_dims FROM workspaces WHERE root_hash = ?1",
                params![root_hash],
                |r| {
                    Ok((
                        r.get::<_, Option<String>>(0)?,
                        r.get::<_, Option<i64>>(1)?.unwrap_or(0),
                    ))
                },
            )
            .unwrap_or((None, 0));
        let model_changed = use_vectors
            && !embed_sig.is_empty()
            && prev_embed_model.as_deref().unwrap_or("") != embed_sig;

        let mut file_count = 0i64;
        // 「这一轮没进索引」的文件数：永久不可索引的（超限 / 二进制）会被顺带清掉旧 chunk，
        // 暂时读不到的只是这轮跳过。两者都不该让进度条永远到不了 total，所以单独计数并说一句。
        let mut skipped = 0i64;
        let mut pending_embed: Vec<(i64, String)> = Vec::new();

        {
            // 分批提交：整段建成一个事务会抱着写锁跑几分钟，而同库还有**另一条写连接**
            // （graph 建库走 open_dedicated）—— 它抢不到锁就 15s 后报 `database is locked`，
            // 面板上表现为「建图谱失败而索引正常」。索引是幂等的（status 会按真实条数修复），
            // 所以按文件分批提交是安全的：持锁时长从「整轮」压到「一批的切块耗时」。
            let mut tx = conn
                .unchecked_transaction()
                .map_err(|e| CoreError::rpc("INDEX_FAILED", e.to_string()))?;
            let mut in_tx = 0usize;

            for file in &files {
                // 逐批提交（见上面注释）：到量就先提交、再开新事务，把写锁的持有时间切碎。
                if in_tx >= CHUNK_COMMIT_EVERY {
                    tx.commit()
                        .map_err(|e| CoreError::rpc("INDEX_FAILED", e.to_string()))?;
                    tx = conn
                        .unchecked_transaction()
                        .map_err(|e| CoreError::rpc("INDEX_FAILED", e.to_string()))?;
                    in_tx = 0;
                }
                in_tx += 1;
                let rel = file.rel.replace('\\', "/");
                let meta = match std::fs::metadata(&file.abs) {
                    Ok(m) => m,
                    // 暂时读不到（独占锁 / 权限）：**保留**旧 chunk，下一轮重试。
                    // 不能用「删掉」掩盖临时故障，否则一次抖动就把索引挖空。
                    Err(_) => {
                        skipped += 1;
                        continue;
                    }
                };
                // 「路径还在、但已经不该索引」（超限 / 不是文件）：必须**清掉旧 chunk**。
                // 旧实现只 `continue`，于是 `purge_stale_chunk_paths` 认为它还在（rel 在集合里）、
                // 这里又不重建 —— 库里永远留着这份文件「上一次」的内容，搜索照旧返回它。
                if !meta.is_file() || meta.len() > crate::config::index_file_max_bytes() {
                    if !force {
                        delete_chunks_for_path(&tx, root_hash, &rel)?;
                    }
                    skipped += 1;
                    continue;
                }
                let mtime = file_mtime_stamp(&meta);

                if !force {
                    if let Some(prev) = stored_mtimes.get(&rel).copied() {
                        if mtime_unchanged(prev, mtime) {
                            file_count += 1;
                            if file_count == 1 || file_count % 8 == 0 || file_count == files_total {
                                let cc = count_chunks(&tx, root_hash)?;
                                self.set_progress(
                                    root_hash,
                                    "chunking",
                                    file_count,
                                    files_total,
                                    cc,
                                    0,
                                );
                            }
                            continue;
                        }
                    }
                }

                // 先读成功再删旧 chunk，避免读失败把已有索引抠掉
                let text = match std::fs::read_to_string(&file.abs) {
                    Ok(t) => t,
                    Err(_) => {
                        skipped += 1;
                        continue;
                    }
                };
                if text.contains('\0') {
                    // 永久不可索引（二进制内容）：与「超限」同理，旧 chunk 必须清掉。
                    if !force {
                        delete_chunks_for_path(&tx, root_hash, &rel)?;
                    }
                    skipped += 1;
                    continue;
                }

                if !force {
                    delete_chunks_for_path(&tx, root_hash, &rel)?;
                }

                file_count += 1;
                for (start_line, end_line, slice) in
                    crate::treesitter::iter_chunk_slices(&rel, &text)
                {
                    let Some((id, content)) =
                        insert_chunk(&tx, root_hash, &rel, start_line, end_line, &slice, mtime)?
                    else {
                        continue;
                    };
                    if use_vectors {
                        pending_embed.push((id, content));
                    }
                }

                if file_count == 1 || file_count % 8 == 0 || file_count == files_total {
                    let cc = count_chunks(&tx, root_hash)?;
                    self.set_progress(
                        root_hash,
                        "chunking",
                        file_count,
                        files_total,
                        cc,
                        0,
                    );
                }
            }

            tx.commit()
                .map_err(|e| CoreError::rpc("INDEX_FAILED", e.to_string()))?;
        }

        if skipped > 0 {
            // 一行诊断：永久不可索引的文件已清掉旧 chunk，暂时读不到的下一轮再试。
            // 没有这一行，「搜索返回文件里已不存在的内容」只能靠人翻库才发现。
            eprintln!(
                "[index] {} 个文件本轮未进索引（超限/二进制已清旧 chunk，读失败下轮重试）",
                skipped
            );
        }

        // 以库里的真实条数为准（增量时大部分文件被跳过，逐块累加没有意义）
        let chunk_count = count_chunks(&conn, root_hash)?;

        // 本次不要向量（`vectors=false`：面板「重建片段」、增量建库、prep 首次建库…）
        // **不删**已有向量。「这次不写向量」≠「用户不要向量了」——按后者实现时，一次
        // 重建或一次保存就会把整库向量清空，语义检索无声失效（面板显示 0，用户以为没用）。
        // 需要清空的只有两种情况：`force` 全量重建（chunk id 全换，`delete_all_chunks`
        // 已清）与签名变更（维度不兼容，必须重建）。
        if model_changed {
            conn.execute(
                "DELETE FROM chunk_vectors WHERE chunk_id IN (SELECT id FROM chunks WHERE root_hash = ?1)",
                params![root_hash],
            )
            .ok();
            pending_embed = load_all_chunk_texts(&conn, root_hash)?;
        } else if use_vectors {
            // 补齐缺向量的 chunk（例如上次 embedding 中断，或增量改过文件但那次没带向量）。
            // 只在本次真要写向量时算：这条是 chunks ⨝ chunk_vectors 的反连接，`vectors=false`
            // 的增量（每次保存都可能跑）没必要为一次用不上的结果扫全表。
            let missing = load_chunks_missing_vectors(&conn, root_hash)?;
            if !missing.is_empty() {
                let mut seen: HashSet<i64> = pending_embed.iter().map(|(id, _)| *id).collect();
                for row in missing {
                    if seen.insert(row.0) {
                        pending_embed.push(row);
                    }
                }
            }
        }

        // 只有本次确实产生了新向量（或模型变更）时才重建内存池；否则保留现有池，避免
        // "保存一下就把整库向量重读一遍"。`!use_vectors` 也要刷：增量重建会按文件删掉
        // 旧 chunk（连同其向量），池里那些 chunk id 已作废，不刷会留下查不到行的僵尸条目。
        let vectors_changed = !use_vectors || model_changed || !pending_embed.is_empty();

        // 本轮「复用缓存命中」与「真的调了 embedding」的条数，写进 workspaces 供面板/诊断读。
        // `use_vectors == false` 时必须**保留上一轮的值**（下面 SQL 用 COALESCE 只在本轮真建向量
        // 时才覆盖）：每轮保存后的后台增量刷新都是 `vectors=false`，若无条件写 0，面板会立刻
        // 把上一条「复用 7000 / 新算 0」抹成 0/0 —— 那正是这两列存在的唯一目的。
        let mut vectors_reused: Option<i64> = None;
        let mut vectors_embedded: Option<i64> = None;
        if use_vectors && !pending_embed.is_empty() {
            self.set_progress(
                root_hash,
                "embedding",
                file_count,
                files_total,
                chunk_count,
                0,
            );
            // ① 缓存命中直接落库（不碰网络）② 未命中的才真的调端点 ③ 新算的回填缓存
            let (misses, reused) = self.apply_cached_vectors(&conn, pending_embed)?;
            vectors_reused = Some(reused);
            if reused > 0 {
                self.set_progress(
                    root_hash,
                    "embedding",
                    file_count,
                    files_total,
                    chunk_count,
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
                            root_hash,
                            "embedding",
                            file_count,
                            files_total,
                            chunk_count,
                            written,
                        );
                    },
                )?);
            }
        }
        let vector_count = count_vectors(&conn, root_hash)?;

        self.set_progress(
            root_hash,
            "finishing",
            file_count,
            files_total,
            chunk_count,
            vector_count,
        );

        let now = now_secs();

        // 元数据必须描述"库里真实存在的向量"：本次没建向量、但之前建的还在，就沿用旧
        // 签名；否则会出现 vectorCount>0 而 embedding_model=NULL，检索侧 `can_vector`
        // 判 false，整条向量通道静默消失。
        let (embedding_model, embed_dims) = if vector_count == 0 {
            (None, 0i64)
        } else if use_vectors {
            (Some(embed_sig), self.embedding.effective_dimensions() as i64)
        } else {
            (prev_embed_model.clone(), prev_embed_dims)
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
                root_hash,
                root.to_string_lossy(),
                file_count,
                chunk_count,
                vector_count,
                now,
                embedding_model,
                embed_dims,
                vectors_reused,
                vectors_embedded
            ],
        )
        .map_err(|e| CoreError::rpc("INDEX_FAILED", e.to_string()))?;

        // 向量有变化时重建池（池未加载时 refresh_pool 会直接返回）
        if vectors_changed {
            self.refresh_pool(&conn, root_hash);
        }

        Ok(())
    }


}

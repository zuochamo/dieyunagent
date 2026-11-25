//! 建库主循环：walk → 切块 → 向量复用/补算 → 写元数据（含进度与增量判定）。
//!
//! 从 `index/mod.rs` 机械搬来（纯移动）。这一层只负责「按顺序把活干完」；
//! 状态判定归 `status.rs`，向量复用细节归 `vectors.rs`，路径失效判定归 `repair.rs`，
//! 写库原语（`insert_chunk` / `delete_chunks_for_path` …）仍留在 `mod.rs`。

use std::collections::{HashMap, HashSet};
use std::path::Path;

use rusqlite::{params, Connection, Transaction};

use super::{
    count_chunks, count_vectors, delete_all_chunks, delete_chunks_for_path, file_mtime_stamp,
    insert_chunk, load_all_chunk_texts, load_chunk_mtimes, load_chunks_missing_vectors,
    mtime_unchanged, now_secs, purge_stale_chunk_paths, resolve_workspace, walker, IndexService,
    StartIndexResult, StatusResult, CHUNK_COMMIT_EVERY, MAX_FILES,
};
use dieyun_base::embedding;
use dieyun_base::error::CoreError;

/// 建库各阶段的进度计数（一次算清，后面几个阶段共用同一份）。
#[derive(Clone, Copy)]
struct ProgressCounts {
    file_count: i64,
    files_total: i64,
    chunk_count: i64,
}

/// 扫到的文件与增量基线（`collect_scope` 的产出）。
struct IndexScope {
    files: Vec<walker::FileEntry>,
    files_total: i64,
    /// 仓比扫描上限还大：后面的文件这一轮**根本没看到**（与「看到了但不可索引」是两件事）
    truncated: bool,
    /// 上一轮的 rel → mtime（force 时为空 = 全量重建）
    stored_mtimes: HashMap<String, i64>,
}

/// 本轮向量口径（`vector_plan` 的产出）。
struct VectorPlan {
    use_vectors: bool,
    embed_sig: String,
    prev_model: Option<String>,
    prev_dims: i64,
    model_changed: bool,
}

/// 建 chunk 阶段的事实（`chunk_pass` 的产出）。
struct ChunkPass {
    file_count: i64,
    skipped: i64,
    pending_embed: Vec<(i64, String)>,
}

/// 一次 embedding 待办（`prepare_embed` 的产出）：缓存命中已落库，剩下的才要真打端点。
struct EmbedPrep {
    /// 命中缓存的条数（本轮事实，写进 `workspaces`）
    reused: i64,
    /// (chunk_id, 送进模型的文本)
    inputs: Vec<(i64, String)>,
    /// chunk_id → 内容哈希（新算之后回填缓存用）
    hash_by_id: HashMap<i64, String>,
}

/// 收尾落库需要的全部事实（十来个位置参数只会读错顺序）。
struct MetaFacts<'a> {
    root: &'a Path,
    file_count: i64,
    chunk_count: i64,
    vector_count: i64,
    skipped: i64,
    truncated: bool,
    embedding_model: Option<String>,
    embed_dims: i64,
    vectors_reused: Option<i64>,
    vectors_embedded: Option<i64>,
    vectors_changed: bool,
}

/// 登记「正在建库」，并按 `force` 决定要不要先清空。
fn mark_indexing(
    conn: &Connection,
    root: &Path,
    root_hash: &str,
    force: bool,
) -> Result<(), CoreError> {
    conn.execute(
        "INSERT INTO workspaces (root_hash, root_path, indexing) VALUES (?1, ?2, 1)
         ON CONFLICT(root_hash) DO UPDATE SET indexing = 1, root_path = excluded.root_path",
        params![root_hash, root.to_string_lossy()],
    )
    .map_err(|e| CoreError::rpc("INDEX_FAILED", e.to_string()))?;

    if force {
        delete_all_chunks(conn, root_hash)?;
    }
    Ok(())
}

/// 进度上报的节流口径：首个、每 8 个、以及最后一个。**只此一处**，别在循环里再写一遍。
fn progress_due(done: i64, total: i64) -> bool {
    done == 1 || done % 8 == 0 || done == total
}

/// 一个文件在本轮建库里的去向。
enum FileOutcome {
    /// 建了 chunk（或整份文件被跳过所有 chunk），本轮计入 `file_count`
    Indexed,
    /// mtime 没变：沿用上一轮的 chunk，不重切
    Unchanged,
    /// 「看见了但没进索引」：暂时读不到（下轮重试）或永久不可索引（旧 chunk 已清）
    Skipped,
}

/// 处理一个文件：判读不读 → 读 → 切块落库，并把要算向量的 chunk 交回调用方。
///
/// 事务由调用方给（分批提交的边界不在这一层）。三种去向见 [`FileOutcome`]；
/// 「暂时读不到」与「永久不可索引」的区别只在**要不要清旧 chunk**，回执都是 `Skipped`。
fn index_one_file(
    tx: &Transaction<'_>,
    root_hash: &str,
    file: &walker::FileEntry,
    force: bool,
    use_vectors: bool,
    prev_mtime: Option<i64>,
) -> Result<(FileOutcome, Vec<(i64, String)>), CoreError> {
    let rel = file.rel.replace('\\', "/");
    let meta = match std::fs::metadata(&file.abs) {
        Ok(m) => m,
        // 暂时读不到（独占锁 / 权限）：**保留**旧 chunk，下一轮重试。
        // 不能用「删掉」掩盖临时故障，否则一次抖动就把索引挖空。
        Err(_) => return Ok((FileOutcome::Skipped, Vec::new())),
    };
    // 「路径还在、但已经不该索引」（超限 / 不是文件）：必须**清掉旧 chunk**。
    // 旧实现只 `continue`，于是 `purge_stale_chunk_paths` 认为它还在（rel 在集合里）、
    // 这里又不重建 —— 库里永远留着这份文件「上一次」的内容，搜索照旧返回它。
    if !meta.is_file() || meta.len() > dieyun_base::config::index_file_max_bytes() {
        if !force {
            delete_chunks_for_path(tx, root_hash, &rel)?;
        }
        return Ok((FileOutcome::Skipped, Vec::new()));
    }
    let mtime = file_mtime_stamp(&meta);

    if !force {
        if let Some(prev) = prev_mtime {
            if mtime_unchanged(prev, mtime) {
                return Ok((FileOutcome::Unchanged, Vec::new()));
            }
        }
    }

    // 先读成功再删旧 chunk，避免读失败把已有索引抠掉
    let text = match std::fs::read_to_string(&file.abs) {
        Ok(t) => t,
        Err(_) => return Ok((FileOutcome::Skipped, Vec::new())),
    };
    if text.contains('\0') {
        // 永久不可索引（二进制内容）：与「超限」同理，旧 chunk 必须清掉。
        if !force {
            delete_chunks_for_path(tx, root_hash, &rel)?;
        }
        return Ok((FileOutcome::Skipped, Vec::new()));
    }

    if !force {
        delete_chunks_for_path(tx, root_hash, &rel)?;
    }

    let mut pending_embed: Vec<(i64, String)> = Vec::new();
    for (start_line, end_line, slice) in crate::treesitter::iter_chunk_slices(&rel, &text) {
        let Some((id, content)) =
            insert_chunk(tx, root_hash, &rel, start_line, end_line, &slice, mtime)?
        else {
            continue;
        };
        if use_vectors {
            pending_embed.push((id, content));
        }
    }
    Ok((FileOutcome::Indexed, pending_embed))
}

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
                files_skipped: 0,
                files_truncated: false,
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

    /// 全量 / 增量建库。统计值直接写进 `workspaces` 与进度快照，调用方只看成败。
    ///
    /// 按阶段切成五个方法（纯搬运，执行顺序与语义未变）：
    /// `mark_indexing`（登记在跑）→ `collect_scope`（扫文件 + 增量基线）→
    /// `vector_plan`（本轮向量口径）→ `chunk_pass`（逐文件切块落库）→
    /// `embed_missing`（补算哪些向量并真的算）→ `write_meta`（落元数据 + 重建内存池）。
    async fn run_index(
        &self,
        root: &Path,
        root_hash: &str,
        force: bool,
        vectors: bool,
    ) -> Result<(), CoreError> {
        // 跨 await + 分钟级任务：既拿不住 MutexGuard，也不该占着常驻锁。
        let conn = self.open_dedicated()?;
        mark_indexing(&conn, root, root_hash, force)?;

        let scope = self.collect_scope(&conn, root, root_hash, force)?;
        let plan = self.vector_plan(&conn, root_hash, vectors);
        let pass = self.chunk_pass(&conn, root_hash, force, &scope, &plan)?;

        // 以库里的真实条数为准（增量时大部分文件被跳过，逐块累加没有意义）
        let chunk_count = count_chunks(&conn, root_hash)?;
        let counts = ProgressCounts {
            file_count: pass.file_count,
            files_total: scope.files_total,
            chunk_count,
        };

        let (vectors_changed, prep) =
            self.prepare_embed(&conn, root_hash, &plan, pass.pending_embed, counts)?;

        // 本轮「复用缓存命中」与「真的调了 embedding」的条数，写进 workspaces 供面板/诊断读。
        // `plan.use_vectors == false` 时必须**保留上一轮的值**（下面 SQL 用 COALESCE 只在本轮真建向量
        // 时才覆盖）：每轮保存后的后台增量刷新都是 `vectors=false`，若无条件写 0，面板会立刻
        // 把上一条「复用 7000 / 新算 0」抹成 0/0 —— 那正是这两列存在的唯一目的。
        let vectors_reused = prep.as_ref().map(|p| p.reused);
        // 本轮「新算 0」也是一个事实：全部命中缓存时必须把它写进库，否则 COALESCE
        // 会留下上一轮的数字（面板/诊断就一直报「新算 240」，实际一次端点都没打）。
        // 未命中时用真实条数覆盖；`plan.use_vectors == false` 那一路仍然不写。
        let vectors_embedded = match prep {
            None => None,
            Some(prep) if prep.inputs.is_empty() => Some(0),
            Some(prep) => {
                // 网络调用只在这一处等：它只借 `&self.embedding` 与已算好的文本，
                // `conn` 是拥有的 `Connection`（Send），所以 future 仍然是 `Send`。
                let rows = embedding::embed_batches(&self.embedding, &prep.inputs).await?;
                Some(self.store_embed(&conn, root_hash, &prep, rows, counts)?)
            }
        };

        let vector_count = count_vectors(&conn, root_hash)?;

        self.set_progress(
            root_hash,
            "finishing",
            counts.file_count,
            counts.files_total,
            chunk_count,
            vector_count,
        );

        // 元数据必须描述"库里真实存在的向量"：本次没建向量、但之前建的还在，就沿用旧
        // 签名；否则会出现 vectorCount>0 而 embedding_model=NULL，检索侧 `can_vector`
        // 判 false，整条向量通道静默消失。
        let (embedding_model, embed_dims) = if vector_count == 0 {
            (None, 0i64)
        } else if plan.use_vectors {
            (Some(plan.embed_sig.clone()), self.embedding.effective_dimensions() as i64)
        } else {
            (plan.prev_model.clone(), plan.prev_dims)
        };

        // 「没进索引」的两个事实要落库：不报出来，用户只会看到「我明明有这个文件却搜不到」。
        // `truncated` 与 `skipped` 是两件事：前者是仓比扫描上限还大（后面的文件这一轮根本没看到），
        // 后者是看见了但内容不可索引（超单文件上限 / 二进制 / 读失败）。
        self.write_meta(
            &conn,
            root_hash,
            MetaFacts {
                root,
                file_count: counts.file_count,
                chunk_count,
                vector_count,
                skipped: pass.skipped,
                truncated: scope.truncated,
                embedding_model,
                embed_dims,
                vectors_reused,
                vectors_embedded,
                vectors_changed,
            },
        )
    }

    /// 阶段一：扫文件 + 增量基线（mtime 表、当前路径集合、清掉已消失路径的旧 chunk）。
    fn collect_scope(
        &self,
        conn: &Connection,
        root: &Path,
        root_hash: &str,
        force: bool,
    ) -> Result<IndexScope, CoreError> {
        self.set_progress(root_hash, "walking", 0, 0, 0, 0);
        let (files, files_truncated) = walker::collect_text_files(root, MAX_FILES);
        let files_total = files.len() as i64;
        self.set_progress(root_hash, "chunking", 0, files_total, 0, 0);
        let stored_mtimes = if force {
            HashMap::new()
        } else {
            load_chunk_mtimes(conn, root_hash)?
        };
        let rel_set: HashSet<String> = files
            .iter()
            .map(|f| f.rel.replace('\\', "/"))
            .collect();
        if !force {
            purge_stale_chunk_paths(conn, root_hash, &rel_set)?;
        }
        Ok(IndexScope {
            files,
            files_total,
            truncated: files_truncated,
            stored_mtimes,
        })
    }

    /// 阶段二：本轮向量口径（要不要写、签名、库里已有签名、是否模型变更）。
    fn vector_plan(&self, conn: &Connection, root_hash: &str, vectors: bool) -> VectorPlan {
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
        VectorPlan {
            use_vectors,
            embed_sig,
            prev_model: prev_embed_model,
            prev_dims: prev_embed_dims,
            model_changed,
        }
    }

    /// 阶段三：逐文件切块落库（分批提交，把写锁持有时间切碎）。
    ///
    /// 只负责「批次边界 + 计数 + 进度」；单个文件的去向交给 [`index_one_file`]。
    fn chunk_pass(
        &self,
        conn: &Connection,
        root_hash: &str,
        force: bool,
        scope: &IndexScope,
        plan: &VectorPlan,
    ) -> Result<ChunkPass, CoreError> {
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

            for file in &scope.files {
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

                let prev_mtime = scope
                    .stored_mtimes
                    .get(&file.rel.replace('\\', "/"))
                    .copied();
                let (outcome, mut embed) =
                    index_one_file(&tx, root_hash, file, force, plan.use_vectors, prev_mtime)?;
                pending_embed.append(&mut embed);

                if matches!(outcome, FileOutcome::Skipped) {
                    skipped += 1;
                    continue;
                }
                // 走到这里 = 这个文件在本轮「有账」：新建了 chunk，或沿用了上一轮的（mtime 没变）。
                file_count += 1;
                if progress_due(file_count, scope.files_total) {
                    let cc = count_chunks(&tx, root_hash)?;
                    self.set_progress(
                        root_hash,
                        "chunking",
                        file_count,
                        scope.files_total,
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
            dieyun_base::obs::degraded(
                "index.skipped_files",
                &format!("{skipped} 个文件本轮未进索引（超限/二进制已清旧 chunk，读失败下轮重试）"),
            );
        }
        Ok(ChunkPass {
            file_count,
            skipped,
            pending_embed,
        })
    }

    /// 阶段四（同步段）：决定这一轮还要补算哪些向量（模型变更 → 全清重算；否则只补缺），
    /// 再把缓存命中的落库，只把「要真打端点的那一批」交回调用方。
    ///
    /// 返回（向量池是否需要重建, 待办）。**这个函数不能是 async**：`&Connection` 一旦活着
    /// 穿过 await 点，整个 future 就变成 `!Send`（`rusqlite::Connection` 不是 `Sync`），
    /// 而 `index_workspace` 的调用方在 tokio 上跑 —— 拆函数时踩过一次，编译期就直接拦下。
    fn prepare_embed(
        &self,
        conn: &Connection,
        root_hash: &str,
        plan: &VectorPlan,
        mut pending_embed: Vec<(i64, String)>,
        counts: ProgressCounts,
    ) -> Result<(bool, Option<EmbedPrep>), CoreError> {
        // 本次不要向量（`vectors=false`：面板「重建片段」、增量建库、prep 首次建库…）
        // **不删**已有向量。「这次不写向量」≠「用户不要向量了」——按后者实现时，一次
        // 重建或一次保存就会把整库向量清空，语义检索无声失效（面板显示 0，用户以为没用）。
        // 需要清空的只有两种情况：`force` 全量重建（chunk id 全换，`delete_all_chunks`
        // 已清）与签名变更（维度不兼容，必须重建）。
        if plan.model_changed {
            conn.execute(
                "DELETE FROM chunk_vectors WHERE chunk_id IN (SELECT id FROM chunks WHERE root_hash = ?1)",
                params![root_hash],
            )
            .ok();
            pending_embed = load_all_chunk_texts(conn, root_hash)?;
        } else if plan.use_vectors {
            // 补齐缺向量的 chunk（例如上次 embedding 中断，或增量改过文件但那次没带向量）。
            // 只在本次真要写向量时算：这条是 chunks ⨝ chunk_vectors 的反连接，`vectors=false`
            // 的增量（每次保存都可能跑）没必要为一次用不上的结果扫全表。
            let missing = load_chunks_missing_vectors(conn, root_hash)?;
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
        // "保存一下就把整库向量重读一遍"。`!plan.use_vectors` 也要刷：增量重建会按文件删掉
        // 旧 chunk（连同其向量），池里那些 chunk id 已作废，不刷会留下查不到行的僵尸条目。
        let vectors_changed = !plan.use_vectors || plan.model_changed || !pending_embed.is_empty();

        if !plan.use_vectors || pending_embed.is_empty() {
            return Ok((vectors_changed, None));
        }

        self.set_progress(
            root_hash,
            "embedding",
            counts.file_count,
            counts.files_total,
            counts.chunk_count,
            0,
        );
        // ① 缓存命中直接落库（不碰网络）② 未命中的交回调用方真的调端点 ③ 新算的回填缓存
        let (misses, reused) = self.apply_cached_vectors(conn, pending_embed)?;
        if reused > 0 {
            self.set_progress(
                root_hash,
                "embedding",
                counts.file_count,
                counts.files_total,
                counts.chunk_count,
                reused,
            );
        }
        let inputs: Vec<(i64, String)> = misses
            .iter()
            .map(|(id, text, _)| (*id, text.clone()))
            .collect();
        let hash_by_id: HashMap<i64, String> =
            misses.iter().map(|(id, _, h)| (*id, h.clone())).collect();
        Ok((
            vectors_changed,
            Some(EmbedPrep {
                reused,
                inputs,
                hash_by_id,
            }),
        ))
    }

    /// 阶段四（同步收尾）：新算出来的向量落库并回填缓存，返回写入条数。
    fn store_embed(
        &self,
        conn: &Connection,
        root_hash: &str,
        prep: &EmbedPrep,
        rows: Vec<(i64, Vec<f32>)>,
        counts: ProgressCounts,
    ) -> Result<i64, CoreError> {
        self.store_embedded_vectors(conn, rows, &prep.hash_by_id, prep.reused, |written| {
            self.set_progress(
                root_hash,
                "embedding",
                counts.file_count,
                counts.files_total,
                counts.chunk_count,
                written,
            );
        })
    }

    /// 阶段五：把这一轮的事实写进 `workspaces`（面板与 `status` 的唯一来源），
    /// 并按需重建内存向量池。
    fn write_meta(
        &self,
        conn: &Connection,
        root_hash: &str,
        facts: MetaFacts<'_>,
    ) -> Result<(), CoreError> {
        let now = now_secs();

        conn.execute(
            "INSERT INTO workspaces (root_hash, root_path, file_count, chunk_count, vector_count,
             indexed_at, indexing, embedding_model, embedding_dims, vectors_reused, vectors_embedded,
             files_skipped, files_truncated)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, ?7, ?8, COALESCE(?9, 0), COALESCE(?10, 0), ?11, ?12)
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
               vectors_embedded = COALESCE(?10, workspaces.vectors_embedded),
               files_skipped = ?11,
               files_truncated = ?12",
            params![
                root_hash,
                facts.root.to_string_lossy(),
                facts.file_count,
                facts.chunk_count,
                facts.vector_count,
                now,
                facts.embedding_model,
                facts.embed_dims,
                facts.vectors_reused,
                facts.vectors_embedded,
                facts.skipped,
                i64::from(facts.truncated)
            ],
        )
        .map_err(|e| CoreError::rpc("INDEX_FAILED", e.to_string()))?;

        // 向量有变化时重建池（池未加载时 refresh_pool 会直接返回）
        if facts.vectors_changed {
            self.refresh_pool(conn, root_hash);
        }

        Ok(())
    }


}

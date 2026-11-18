//! 索引状态（只读路径）与「脏状态维修」协议。
//!
//! 从 `index/mod.rs` 机械搬来（纯移动，逻辑一行未改）。状态是**纯读**：它绝不排队等写连接，
//! 也绝不在读锁里做重活 —— 面板每秒轮询一次，任何一次阻塞都会显示成「索引卡住」。

use super::workspace::{resolve_workspace, WorkspaceRef};
use super::{count_vectors, IndexService, StatusRepair, StatusResult};
use dieyun_base::error::CoreError;
use rusqlite::{params, Connection};

impl IndexService {

    pub fn status(&self, workspace_root: &str) -> Result<StatusResult, CoreError> {
        let ws = resolve_workspace(workspace_root)?;
        self.status_impl(&ws)
    }


    /// 状态读取的唯一入口：走**读池**纯读，维修动作挪到独立连接。
    ///
    /// 读路径里不许写的原因：常驻连接是 index / graph 共用的唯一写入连接，
    /// 一次等锁就是 `BUSY_TIMEOUT_SECS`（15s）起步，`codebase.status` 这类必须秒回的
    /// 请求挂住之后，上层只能看到「Gateway RPC 超时: codebase.status (45s)」。
    /// 详见 `docs/SQLITE-ACCESS.md`。
    pub(crate) fn status_impl(&self, ws: &WorkspaceRef) -> Result<StatusResult, CoreError> {
        let (st, repair) = self.db.read(|conn| self.status_with_conn(conn, ws))?;
        if let Some(repair) = repair {
            self.apply_status_repair(ws, &repair);
        }
        Ok(st)
    }


    /// 修掉崩溃 / 半初始化留下的脏状态（`indexing = 1` 却没人真在跑、元数据残缺）。
    ///
    /// best-effort：独立连接 + `busy_timeout(0)`，抢不到写锁就放弃，等下一次 status
    /// 再修。返回给调用方的数值已经算好了，与这次是否落盘无关 —— 维修绝不能拖慢读。
    pub(crate) fn apply_status_repair(&self, ws: &WorkspaceRef, repair: &StatusRepair) {
        let Ok(conn) = self.open_dedicated() else {
            return;
        };
        let _ = conn.busy_timeout(std::time::Duration::ZERO);
        let _ = conn.execute(
            "UPDATE workspaces SET indexing = 0, file_count = ?2, chunk_count = ?3, indexed_at = ?4,
             vector_count = ?5, embedding_model = ?6, embedding_dims = ?7
             WHERE root_hash = ?1",
            params![
                ws.root_hash,
                repair.file_count,
                repair.chunk_count,
                repair.indexed_at,
                repair.vector_count,
                repair.embedding_model,
                repair.embedding_dims
            ],
        );
    }


    /// `status` 的实现本体：连接由调用方提供。
    ///
    /// **纯读**：只读不写，脏状态以 [`StatusRepair`] 的形式交回调用方用独立连接补写
    /// （见 [`status_impl`](Self::status_impl)）。凡「已经拿着连接」的地方都走这个入口，
    /// 在其中再调 `self.status` 会直接自锁。
    pub(crate) fn status_with_conn(
        &self,
        conn: &Connection,
        ws: &WorkspaceRef,
    ) -> Result<(StatusResult, Option<StatusRepair>), CoreError> {
        let live_indexing = self
            .indexing
            .lock()
            .map(|g| g.contains(&ws.root_hash))
            .unwrap_or(false);

        // 向量元信息：模型 / 维度取**库里实际写入**的值（下面 row 里读），
        // 当前配置的签名只用来回答「库里的向量是不是当前这个模型产的」。
        let current_signature = self.embedding.signature();
        let embedding_enabled = self.embedding.enabled();

        let row: Option<(i64, i64, i64, i64, i64, Option<String>, i64, i64, i64, i64, i64)> = conn
            .query_row(
                "SELECT file_count, chunk_count, vector_count, indexed_at, indexing,
                        embedding_model, embedding_dims, vectors_reused, vectors_embedded,
                        files_skipped, files_truncated
                 FROM workspaces WHERE root_hash = ?1",
                params![ws.root_hash],
                |r| {
                    Ok((
                        r.get(0)?,
                        r.get(1)?,
                        r.get(2)?,
                        r.get(3)?,
                        r.get(4)?,
                        r.get(5)?,
                        r.get(6)?,
                        r.get(7)?,
                        r.get(8)?,
                        r.get(9)?,
                        r.get(10)?,
                    ))
                },
            )
            .ok();

        Ok(match row {
            None => {
                let mut st = StatusResult {
                    ok: true,
                    indexed: false,
                    file_count: 0,
                    chunk_count: 0,
                    vector_count: 0,
                    indexed_at: 0,
                    indexing: live_indexing,
                    embedding_model: None,
                    embedding_dims: 0,
                    embedding_enabled,
                    embedding_stale: false,
                    vectors_reused: 0,
                    vectors_embedded: 0,
                    files_skipped: 0,
                    files_truncated: false,
                    phase: None,
                    files_done: None,
                    files_total: None,
                    last_error: None,
                };
                self.apply_live_progress(&ws.root_hash, &mut st);
                (st, None)
            }
            Some((fc, cc, vc, ia, db_indexing, em, ed, reused, embedded, skipped, truncated)) => {
                // 仅当旗标或元数据明显残缺时再 COUNT，避免每次 status 扫表
                let mut db_flag = db_indexing;
                let mut file_count = fc;
                let mut chunk_count = cc;
                let mut vector_count = vc;
                let mut indexed_at = ia;
                let mut embedding_model = em.clone();
                let mut embedding_dims = ed;
                let mut repair = None;
                if !live_indexing {
                    let need_clear_flag = db_flag != 0;
                    // 崩溃可能落在「清空 chunks」和「写回 counts」之间：库里已经空了，
                    // 元数据还是上一轮的满值。不查一下就会一直报「已索引 N 段」，而
                    // search 因 chunk_count != 0 绕过 needsIndex 门槛，静默返回 0 条。
                    // 探针用 EXISTS（走 root_hash 索引，微秒级），不是 COUNT(*)。
                    let has_rows: i64 = conn
                        .query_row(
                            "SELECT EXISTS(SELECT 1 FROM chunks WHERE root_hash = ?1)",
                            params![ws.root_hash],
                            |r| r.get(0),
                        )
                        // 查询失败按「有数据」保守处理，别把好索引误判成空
                        .unwrap_or(1);
                    // 向量侧同款探针：`force` 全量重建会先把老 `chunks`（连带 `chunk_vectors`）
                    // 删掉再重切。进程若在 embedding 阶段被杀，留下的是「chunk 有、向量几乎没
                    // 有」，而元数据还是上一轮的满值 —— 面板报几千条向量，检索侧却只能靠签名
                    // 拒绝它。`docs/VECTOR-SEARCH.md` §1.1 规则 3 要求元数据描述**真实存在**的
                    // 向量。探针同样用 EXISTS（`chunk_vectors.chunk_id` 是主键，命中即返回）。
                    let has_vectors: i64 = conn
                        .query_row(
                            "SELECT EXISTS(SELECT 1 FROM chunk_vectors WHERE chunk_id IN
                                 (SELECT id FROM chunks WHERE root_hash = ?1))",
                            params![ws.root_hash],
                            |r| r.get(0),
                        )
                        // 查不到按「有向量」保守处理，别把好索引误判成空
                        .unwrap_or(1);
                    let vector_meta_lies = vector_count > 0 && has_vectors == 0;
                    // 旗标只能证明「这次崩了」，证明不了「上一进程崩过、旗标已被前面某次
                    // status 清掉、元数据还是旧的」。本进程第一次看到这个工作区时核一次账。
                    let first_sight = self.take_meta_check(&ws.root_hash);
                    let meta_looks_broken = indexed_at == 0
                        || (chunk_count == 0 && file_count == 0)
                        || (chunk_count > 0 && has_rows == 0)
                        || vector_meta_lies
                        || first_sight;
                    if need_clear_flag || meta_looks_broken {
                        let real_chunks: i64 = conn
                            .query_row(
                                "SELECT COUNT(*) FROM chunks WHERE root_hash = ?1",
                                params![ws.root_hash],
                                |r| r.get(0),
                            )
                            .unwrap_or(0);
                        if real_chunks > 0 {
                            // 数与库不符就按库说话：半途被杀的重建会让 chunk 数变了、元数据没跟上
                            chunk_count = real_chunks;
                            if file_count == 0 {
                                file_count = conn
                                    .query_row(
                                        "SELECT COUNT(DISTINCT rel_path) FROM chunks WHERE root_hash = ?1",
                                        params![ws.root_hash],
                                        |r| r.get(0),
                                    )
                                    .unwrap_or(0);
                            }
                            if indexed_at == 0 {
                                indexed_at = std::time::SystemTime::now()
                                    .duration_since(std::time::UNIX_EPOCH)
                                    .map(|d| d.as_secs() as i64)
                                    .unwrap_or(0);
                            }
                        } else if chunk_count > 0 {
                            // 内容真的没了：如实归零（indexed_at=0 → indexed=false，上层会提示重建）
                            chunk_count = 0;
                            file_count = 0;
                            indexed_at = 0;
                        }
                        // 向量计数取库实数；一条都没有就把签名一起归零 —— `can_vector` 与面板的
                        // 「向量一致性」都以「库里真有向量」为前提，留着旧签名只会把假数据说圆
                        if let Ok(real_vectors) = count_vectors(conn, &ws.root_hash) {
                            vector_count = real_vectors;
                            if real_vectors == 0 {
                                embedding_model = None;
                                embedding_dims = 0;
                            }
                        }
                        // 读路径不写库：只把「欠一次修」交回调用方。健康工作区的首次核对
                        // 算出来的值与元数据一样，不必写（写一次就多一轮 WAL）。
                        let changed = file_count != fc
                            || chunk_count != cc
                            || indexed_at != ia
                            || vector_count != vc
                            || embedding_model != em
                            || embedding_dims != ed;
                        if changed || need_clear_flag {
                            repair = Some(StatusRepair {
                                file_count,
                                chunk_count,
                                indexed_at,
                                vector_count,
                                embedding_model: embedding_model.clone(),
                                embedding_dims,
                            });
                        }
                        db_flag = 0;
                    }
                }
                let embedding_stale = vector_count > 0
                    && !current_signature.is_empty()
                    && embedding_model.as_deref().unwrap_or("") != current_signature;
                let mut st = StatusResult {
                    ok: true,
                    indexed: indexed_at > 0,
                    file_count,
                    chunk_count,
                    vector_count,
                    indexed_at,
                    indexing: live_indexing || db_flag != 0,
                    embedding_model,
                    embedding_dims,
                    embedding_enabled,
                    embedding_stale,
                    vectors_reused: reused,
                    vectors_embedded: embedded,
                    files_skipped: skipped,
                    files_truncated: truncated != 0,
                    phase: None,
                    files_done: None,
                    files_total: None,
                    last_error: None,
                };
                self.apply_live_progress(&ws.root_hash, &mut st);
                (st, repair)
            }
        })
    }


    pub(crate) fn apply_live_progress(&self, root_hash: &str, st: &mut StatusResult) {
        // 只有**本进程正在建库**时才有实时进度（`set_progress` 写的那份）。
        // 以前这里还叠了一份「远端摄取任务」的进度，那条链路没有任何 RPC 入口（P6 已删）。
        if let Some(p) = self.progress_for(root_hash) {
            if !p.phase.is_empty() {
                st.phase = Some(p.phase.clone());
            }
            if p.files_total > 0 || p.files_done > 0 {
                st.files_done = Some(p.files_done);
                st.files_total = Some(p.files_total);
            }
            if p.chunk_count > st.chunk_count {
                st.chunk_count = p.chunk_count;
            }
            if p.vector_count > st.vector_count {
                st.vector_count = p.vector_count;
            }
            if let Some(err) = p.last_error {
                st.last_error = Some(err);
            }
        }
    }


}

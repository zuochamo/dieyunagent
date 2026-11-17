// 依赖与 mod.rs 同源：域文件里直接用，不再各自拼一套 use。
use super::*;

use rusqlite::params;
use serde_json::{json, Value};

use crate::embedding::{self};
use crate::error::CoreError;

/// 长记忆「还在用」的状态集合 —— **唯一来源**：所有召回与计数 SQL 都从这里拼。
///
/// 只允许 `active` 与 `stale`：衰减后仍可命中（打分要扣分，见 `fts_search_long`），
/// `archived` 一律不可见（软删除：可恢复，但不参与注入与召回）。
const LONG_MEM_ALIVE_STATUSES: &str = "'active', 'stale'";

/**
 * 读侧：长记忆召回（FTS / 关键词 / 语义）与会话正文检索的打分、可见性与分页。
 * 「这条记忆看得见吗」只有 `long_mem_visible_sql` 一处（`misc.rs` 的衰减 UPDATE 是反过来的谓词，别并进来）。
 */

/// 长记忆「还在用」的状态集合 —— **唯一来源**：所有召回与计数 SQL 都从这里拼。

pub(crate) fn is_global_memory_scope(scope: &str) -> bool {
    scope.trim().eq_ignore_ascii_case(GLOBAL_MEMORY_SCOPE)
}

/// 只判状态（不判过期）：向量覆盖率这类「统计在用条数」的 SQL 用它。
pub(crate) fn long_mem_alive_sql(alias: &str) -> String {
    let prefix = if alias.is_empty() {
        String::new()
    } else {
        format!("{alias}.")
    };
    format!("{prefix}status IN ({LONG_MEM_ALIVE_STATUSES})")
}

/// 「这条长记忆现在看得见吗」的**唯一 SQL 片段**：状态在用 + 未过期。
///
/// 这句话原本手抄了 10 处，改一处忘九处 —— 现在只有这一份。
///
/// - `alias`：有表别名（`LEFT JOIN` / FTS 联查）时传 `"m"`，列会写成 `m.status`；无别名传 `""`；
/// - `now_index`：SQL 里「现在」那个 `?N` 的序号。绑定顺序归调用方，helper 不猜 ——
///   猜错不会报错，只会静默查空。
///
/// **别把 `misc.rs` 的衰减 UPDATE 并进来**：那条筛的是「已过期、该归档」的行，
/// 与本函数的「还看得见」正好相反。
/// 语义召回那条 SQL（作用域不同，绑定的参数个数不同，所以单独成形以便测试）。
///
/// 关键点：可见性谓词必须走 [`long_mem_visible_sql`] —— 以前这条分支手写
/// `m.status = 'active'`，于是**过期记忆照样能被语义召回**，而关键词分支不会；
/// 同一个问题问两次得到两套记忆，是记忆系统最不该有的行为。
fn semantic_long_sql(scope: &str) -> String {
    format!(
        "SELECT m.id, m.content, m.source, m.created_at, m.scope, m.kind, m.importance, m.status, v.vector, v.dimensions
         FROM long_memories m
         JOIN long_memory_vectors v ON v.memory_id = m.id
         WHERE {} AND {} AND v.model = ?1",
        long_mem_visible_sql("m", 2),
        long_memory_scope_filter("m.scope", scope, 3)
    )
}

pub(crate) fn long_mem_visible_sql(alias: &str, now_index: i32) -> String {
    let col = if alias.is_empty() {
        "expires_at".to_string()
    } else {
        format!("{alias}.expires_at")
    };
    format!(
        "{} AND ({col} IS NULL OR {col} <= 0 OR {col} > ?{now_index})",
        long_mem_alive_sql(alias)
    )
}

/// SQL filter for long_memories.scope — `global` must not match project:* rows.
pub(crate) fn long_memory_scope_filter(scope_col: &str, scope: &str, bind_index: i32) -> String {
    if is_global_memory_scope(scope) {
        format!(
            "(COALESCE(NULLIF({scope_col}, ''), '{GLOBAL_MEMORY_SCOPE}') = '{GLOBAL_MEMORY_SCOPE}')"
        )
    } else {
        format!("{scope_col} = ?{bind_index}")
    }
}

type LongMemKeywordRow = (
    i64,
    String,
    Option<String>,
    Option<String>,
    Option<String>,
    i64,
    String,
    i64,
);

pub(crate) fn map_long_mem_keyword_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<LongMemKeywordRow> {
    Ok((
        row.get(0)?,
        row.get(1)?,
        row.get(2)?,
        row.get(3)?,
        row.get(4)?,
        row.get(5)?,
        row.get(6)?,
        row.get(7)?,
    ))
}

type LongMemSemanticRow = (
    i64,
    String,
    Option<String>,
    i64,
    Option<String>,
    Option<String>,
    i64,
    String,
    Vec<u8>,
    i64,
);

pub(crate) fn map_long_mem_semantic_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<LongMemSemanticRow> {
    Ok((
        row.get(0)?,
        row.get(1)?,
        row.get(2)?,
        row.get(3)?,
        row.get(4)?,
        row.get(5)?,
        row.get(6)?,
        row.get(7)?,
        row.get(8)?,
        row.get(9)?,
    ))
}

/// 新鲜度（0..1，180 天线性衰减）：检索打分的**稳定**信号之一，与语料统计无关。
pub(crate) fn freshness_score(now: i64, created_at: i64) -> f64 {
    let age_ms = (now - created_at).max(0) as f64;
    let max_age = 180.0 * 24.0 * 60.0 * 60.0 * 1000.0;
    (1.0 - (age_ms / max_age).min(1.0)).max(0.0)
}

/// 围绕命中处截取摘录：模型要看到的是「哪一句」，不是整段历史。
///
/// 命中点前留四分之一上下文，其余给后半段；找不到命中片段时退回头部截断
/// （词法切分可能已经把查询改写成了子串，那不算错误）。
pub(crate) fn snippet_around(content: &str, query: &str, max_chars: usize) -> String {
    let total = content.chars().count();
    if total <= max_chars {
        return content.to_string();
    }
    let hit = crate::fts::first_hit_index(content, query).unwrap_or(0);
    let lead = max_chars / 4;
    let mut start = hit.saturating_sub(lead);
    let mut end = start + max_chars;
    if end > total {
        end = total;
        start = end.saturating_sub(max_chars);
    }
    let mut out: String = content.chars().skip(start).take(end - start).collect();
    if start > 0 {
        out.insert(0, '…');
    }
    if end < total {
        out.push('…');
    }
    out
}

/// `LIKE` 子串扫描的匹配模式：`%片段%`，转义用户输入里的 `%` / `_` / `\`。
pub(crate) fn like_pattern(query: &str) -> String {
    let mut out = String::with_capacity(query.len() + 2);
    out.push('%');
    for ch in query.trim().chars() {
        if matches!(ch, '%' | '_' | '\\') {
            out.push('\\');
        }
        out.push(ch);
    }
    out.push('%');
    out
}

/// 对外暴露的分数保留 3 位小数（展示 / 断言用，不参与排序）。
pub(crate) fn round_score(score: f64) -> f64 {
    (score * 1000.0).round() / 1000.0
}

/// 一条长记忆作为**检索命中**时的 JSON 形状（关键词分支与语义分支共用）。
///
/// 以前这两条分支各拼一遍 `json!`：字段顺序不同、`created_at` 一处写成 `created_at`
/// 一处跟着 camelCase 走，加一个字段要改两处，漏一处就是「同一个东西两个形状」。
/// 完整行（带 `updated_at` / `last_used_at` / `access_count`）仍由
/// `longmem::map_long_memory_row` 出，那是列表接口的形状，不是命中形状。
fn long_mem_hit_json(
    id: i64,
    content: String,
    source: Option<String>,
    scope: Option<String>,
    kind: Option<String>,
    importance: i64,
    status: String,
    created_at: i64,
    score: f64,
    vector_search: bool,
) -> serde_json::Value {
    let mut hit = json!({
        "id": id,
        "content": content,
        "source": source,
        "scope": scope,
        "kind": kind,
        "importance": importance,
        "status": status,
        "created_at": created_at,
        "score": round_score(score),
    });
    if vector_search {
        hit["vectorSearch"] = json!(true);
    }
    hit
}

impl MemoryStore {
    /// 会话维度：这个会话沉淀了哪些记忆（只读，走读池）。
    ///
    /// 存在的理由只有一个：归纳器把记忆写成项目级/用户级之后，「哪条是这次对话产生的」
    /// 在库里没有任何痕迹 —— 用户问「这个会话是不是乱记了什么 / 把它记的忘掉」时,
    /// 只能全表翻 + 猜时间。写入点就在 add_long_memory，一列即可回答。
    pub fn long_memories_by_session(
        &self,
        session_id: &str,
        limit: i64,
    ) -> Result<Vec<Value>, CoreError> {
        let sid = session_id.trim();
        if sid.is_empty() {
            return Ok(Vec::new());
        }
        let lim = limit.clamp(1, 200);
        let now = now_ms();
        self.read(|conn| {
            let sql = format!(
                "SELECT id, content, source, scope, kind, importance, status, created_at, updated_at, last_used_at, access_count
                 FROM long_memories
                 WHERE session_id = ?1
                   AND {}
                 ORDER BY id DESC
                 LIMIT ?3",
                long_mem_visible_sql("", 2)
            );
            let mut stmt = conn.prepare(&sql)?;
            let mapped = stmt.query_map(params![sid, now, lim], map_long_memory_row)?;
            mapped.collect::<Result<Vec<_>, _>>().map_err(CoreError::from)
        })
    }

    pub fn recent_long_memories(
        &self,
        limit: i64,
        scope: Option<&str>,
    ) -> Result<Vec<Value>, CoreError> {
        let now = now_ms();
        // 读池：召回是每轮系统提示的读路径，绝不能排在「聊天落库」的写入连接后面
        // （`memory.long_recall` 两次 120s 超时就是在写入连接上排队，见 docs/SQLITE-ACCESS.md）
        self.read(|conn| {
            let rows = if let Some(sc) = scope.filter(|s| !s.is_empty()) {
                if is_global_memory_scope(sc) {
                    let sql = format!(
                        "SELECT id, content, source, scope, kind, importance, status, created_at, updated_at, last_used_at, access_count
                         FROM long_memories
                         WHERE {}
                           AND {}
                         ORDER BY updated_at DESC, id DESC
                         LIMIT ?2",
                        long_memory_scope_filter("scope", sc, 1),
                        long_mem_visible_sql("", 1)
                    );
                    let mut stmt = conn.prepare(&sql)?;
                    let mapped = stmt.query_map(params![now, limit], map_long_memory_row)?;
                    mapped.collect::<Result<Vec<_>, _>>()?
                } else {
                    let sql = format!(
                        "SELECT id, content, source, scope, kind, importance, status, created_at, updated_at, last_used_at, access_count
                         FROM long_memories
                         WHERE scope = ?1
                           AND {}
                         ORDER BY updated_at DESC, id DESC
                         LIMIT ?3",
                        long_mem_visible_sql("", 2)
                    );
                    let mut stmt = conn.prepare(&sql)?;
                    let mapped = stmt.query_map(params![sc, now, limit], map_long_memory_row)?;
                    mapped.collect::<Result<Vec<_>, _>>()?
                }
            } else {
                let sql = format!(
                    "SELECT id, content, source, scope, kind, importance, status, created_at, updated_at, last_used_at, access_count
                     FROM long_memories
                     WHERE {}
                       AND {}
                     ORDER BY updated_at DESC, id DESC
                     LIMIT ?2",
                    long_memory_scope_filter("scope", GLOBAL_MEMORY_SCOPE, 1),
                    long_mem_visible_sql("", 1)
                );
                let mut stmt = conn.prepare(&sql)?;
                let mapped = stmt.query_map(params![now, limit], map_long_memory_row)?;
                mapped.collect::<Result<Vec<_>, _>>()?
            };
            Ok(rows)
        })
    }

    pub fn long_memory_vector_status(&self) -> Result<Value, CoreError> {
        let embedding = self.embedding();
        let sig = embedding.signature();
        self.with_conn(|conn| {
            let total_sql = format!(
                "SELECT COUNT(*) FROM long_memories WHERE {}",
                long_mem_alive_sql("")
            );
            let total: i64 = conn.query_row(
                &total_sql,
                [],
                |row| row.get(0),
            )?;
            let vector_count: i64 = if sig.is_empty() {
                0
            } else {
                let covered_sql = format!(
                    "SELECT COUNT(*)
                     FROM long_memory_vectors v
                     JOIN long_memories m ON m.id = v.memory_id
                     WHERE {} AND v.model = ?1",
                    long_mem_alive_sql("m")
                );
                conn.query_row(
                    &covered_sql,
                    params![sig],
                    |row| row.get(0),
                )?
            };
            Ok(json!({
                "ok": true,
                "total": total,
                "vectorCount": vector_count,
                "embeddingModel": if sig.is_empty() { Value::Null } else { json!(sig) },
            }))
        })
    }

    pub fn keyword_search_long_memories(
        &self,
        query: &str,
        limit: i64,
    ) -> Result<Value, CoreError> {
        let q = query.trim();
        if q.is_empty() {
            return Ok(json!({ "ok": true, "mode": "keyword", "results": [] }));
        }
        let hits = self.fts_search_long(None, q, limit)?;
        let total = hits.len();
        let results: Vec<Value> = hits
            .into_iter()
            .map(|(score, row)| {
                let (id, content, source, scope, kind, importance, status, created_at) = row;
                long_mem_hit_json(
                    id,
                    content,
                    source,
                    scope,
                    kind,
                    importance,
                    status,
                    created_at,
                    score,
                    false,
                )
            })
            .collect();
        Ok(json!({
            "ok": true,
            "mode": "keyword",
            "results": results,
            "totalCandidates": total,
        }))
    }

    pub async fn recall_long_memories(
        &self,
        query: &str,
        scope: Option<&str>,
        limit: i64,
    ) -> Result<Value, CoreError> {
        let q = query.trim();
        let scope_opt = scope.map(str::trim).filter(|s| !s.is_empty());
        let scope_str = scope_opt.unwrap_or(GLOBAL_MEMORY_SCOPE);
        // 空 scope（尤其新工作区）跳过 embedding，避免堵住 dieyun-core 单线程 RPC。
        if self.count_active_long_memories(scope_str)? == 0 {
            return Ok(json!({ "ok": true, "mode": "none", "results": [] }));
        }
        if q.is_empty() {
            let mut recent = self.recent_long_memories(limit, Some(scope_str))?;
            recent.reverse();
            let results: Vec<Value> = recent
                .into_iter()
                .map(|mut row| {
                    if let Some(obj) = row.as_object_mut() {
                        obj.insert("score".into(), json!(0));
                    }
                    row
                })
                .collect();
            self.bump_memory_usage(&results)?;
            return Ok(json!({ "ok": true, "mode": "recent", "results": results }));
        }
        if self.embedding().enabled() {
            let embedding = self.embedding();
            // 召回是**每轮**都要走的读路径。本地推理下这是一次毫秒级矩阵乘；远端端点下
            // 失败（含超时）直接落到下面的关键词通道 —— 语义通道拿不到不等于召回失败。
            // 旧的「预判端点太慢就不发」已随本地推理一起删除（见 embedding/mod.rs 头注释）。
            match embedding::embed_texts(&embedding, &[q.to_string()]).await {
                Ok(vectors) => {
                    let query_vec = vectors.into_iter().next().unwrap_or_default();
                    if !query_vec.is_empty() {
                        let semantic = self.semantic_search_long(scope_str, &query_vec, limit)?;
                        if !semantic.is_empty() {
                            self.bump_memory_usage(&semantic)?;
                            return Ok(json!({
                                "ok": true,
                                "mode": "semantic",
                                "results": semantic,
                                "vectorSearch": true,
                            }));
                        }
                    }
                }
                Err(err) => {
                    // 语义通道不可用不是召回失败：关键词/FTS 是既有兜底（DB 侧毫秒级）。
                    eprintln!("[memory] 语义召回跳过（embedding 不可用）：{err}");
                }
            }
        }
        let keyword = self.keyword_search_long(scope_str, q, limit)?;
        if !keyword.is_empty() {
            self.bump_memory_usage(&keyword)?;
            return Ok(json!({
                "ok": true,
                "mode": "keyword",
                "results": keyword,
            }));
        }
        Ok(json!({ "ok": true, "mode": "none", "results": [] }))
    }

    /// 召回即「用了一次」：`last_used_at` / `access_count` 的唯一写入点。
    ///
    /// 这两列此前只有读者没有写者，于是 `decay_long_memories` 里的
    /// `COALESCE(access_count, 0) = 0` 恒成立 ——「用过的记忆越用越牢」这条反馈闭环
    /// 实际不存在。召回成功后统一 bump，衰减只会碰真的没人再用的条目。
    pub(crate) fn bump_memory_usage(&self, rows: &[Value]) -> Result<(), CoreError> {
        let now = now_ms();
        let ids: Vec<i64> = rows
            .iter()
            .filter_map(|r| r.get("id").and_then(|v| v.as_i64()))
            .filter(|id| *id > 0)
            .collect();
        if ids.is_empty() {
            return Ok(());
        }
        // 「用了哪条记忆」是排序/修剪的提示信号，不是召回结果的一部分：
        // 拿不到写连接就跳过这一次，绝不为此让每轮的召回排在聊天落库后面
        // （实测差额见 `SqliteHandle::try_with_conn` 的注释）。
        let _ = self.db.try_with_conn(|conn| {
            let mut stmt = conn.prepare(
                "UPDATE long_memories
                 SET last_used_at = ?1, access_count = COALESCE(access_count, 0) + 1
                 WHERE id = ?2",
            )?;
            for id in &ids {
                stmt.execute(params![now, id])?;
            }
            Ok(())
        })?;
        Ok(())
    }

    pub(crate) fn count_active_long_memories(&self, scope: &str) -> Result<i64, CoreError> {
        let scope_filter = scope.trim();
        let sql = format!(
            "SELECT COUNT(*) FROM long_memories
             WHERE {}
               AND {}",
            long_mem_visible_sql("", 1),
            long_memory_scope_filter("scope", scope_filter, 2)
        );
        // 只读计数，走读池：它和召回同一条路径，写在「写入连接」上会跟着排队
        self.read(|conn| {
            let now = now_ms();
            let n: i64 = if is_global_memory_scope(scope_filter) {
                conn.query_row(&sql, params![now], |r| r.get(0))?
            } else {
                conn.query_row(&sql, params![now, scope_filter], |r| r.get(0))?
            };
            Ok(n)
        })
    }

    /// 长记忆词法检索本体（**唯一**实现；scope 过滤与 JSON 组装由调用方各自负责）。
    ///
    /// 主路径是 FTS5 + `bm25`；排序口径与 `index/search.rs` 一致：**只用名次，不用分数
    /// 绝对值** —— bm25 的量纲随语料统计漂移、跨查询不可比。bm25 决定候选顺序，
    /// 重要度 / 新鲜度 / stale 惩罚只做同一查询内的微调（权重刻意小于一个名次位）。
    ///
    /// `scope == None` 表示不限 scope（记忆界面跨 scope 检索）。
    ///
    /// 分词器边界：`long_memories_fts` 用的是 trigram，只能索引 **≥3 字符** 的片段。
    /// 中文双字词（`索引` / `记忆`）因此没有可命中的 trigram，`MATCH` 必然空结果 ——
    /// 这类查询退回 `LIKE` 子串扫描（`long_memories` 行数由修剪策略封顶，扫描是有界的），
    /// 相关度记常量，排序由重要度 / 新鲜度决定。
    pub(crate) fn fts_search_long(
        &self,
        scope: Option<&str>,
        query: &str,
        limit: i64,
    ) -> Result<Vec<(f64, LongMemKeywordRow)>, CoreError> {
        let lim = limit.clamp(1, 50);
        let now = now_ms();
        if query.trim().is_empty() {
            return Ok(Vec::new());
        }
        let scope_trimmed = scope.map(str::trim);
        let (scope_sql, binds_scope) = match scope_trimmed {
            None => (String::new(), false),
            Some(s) => (
                format!("AND {}", long_memory_scope_filter("m.scope", s, 4)),
                !is_global_memory_scope(s),
            ),
        };
        let (sql, first_param) = if crate::fts::has_indexable_term(query) {
            let Some(match_q) = crate::fts::match_query(query) else {
                return Ok(Vec::new());
            };
            (
                format!(
                    "SELECT m.id, m.content, m.source, m.scope, m.kind, m.importance, m.status, m.created_at,
                            bm25(long_memories_fts) AS rank
                     FROM long_memories_fts
                     JOIN long_memories m ON m.id = long_memories_fts.rowid
                     WHERE long_memories_fts MATCH ?1
                       AND {}
                       {scope_sql}
                     ORDER BY rank
                     LIMIT ?3",
                    long_mem_visible_sql("m", 2)
                ),
                match_q,
            )
        } else {
            let pattern = like_pattern(query);
            (
                format!(
                    "SELECT m.id, m.content, m.source, m.scope, m.kind, m.importance, m.status, m.created_at,
                            -1.0 AS rank
                     FROM long_memories m
                     WHERE m.content LIKE ?1 ESCAPE '\\'
                       AND {}
                       {scope_sql}
                     ORDER BY m.importance DESC, m.id DESC
                     LIMIT ?3",
                    long_mem_visible_sql("m", 2)
                ),
                pattern,
            )
        };
        let mut args = vec![
            rusqlite::types::Value::Text(first_param),
            rusqlite::types::Value::Integer(now),
            rusqlite::types::Value::Integer(lim),
        ];
        if binds_scope {
            if let Some(s) = scope_trimmed {
                args.push(rusqlite::types::Value::Text(s.to_string()));
            }
        }
        // 读池：词法检索不该排在「聊天落库」的写连接后面。
        self.read(|conn| {
            let mut stmt = conn.prepare(&sql)?;
            let map = |row: &rusqlite::Row<'_>| -> rusqlite::Result<(LongMemKeywordRow, f64)> {
                Ok((map_long_mem_keyword_row(row)?, row.get(8)?))
            };
            let rows: Vec<(LongMemKeywordRow, f64)> = stmt
                .query_map(rusqlite::params_from_iter(args), map)?
                .collect::<Result<Vec<_>, _>>()?;
            let mut scored: Vec<(f64, LongMemKeywordRow)> = rows
                .into_iter()
                .map(|(row, rank)| {
                    let importance = row.5;
                    let status = row.6.as_str();
                    let created_at = row.7;
                    let relevance = -rank; // bm25 越相关越「负」，取反得到正相关度
                    let status_penalty = if status == "stale" { -0.15 } else { 0.0 };
                    let score = relevance
                        + (importance as f64) * 0.035
                        + freshness_score(now, created_at) * 0.08
                        + status_penalty;
                    (score, row)
                })
                .collect();
            scored.sort_by(|a, b| {
                b.0.partial_cmp(&a.0)
                    .unwrap_or(std::cmp::Ordering::Equal)
                    .then(b.1 .0.cmp(&a.1 .0))
            });
            Ok(scored)
        })
    }

    pub(crate) fn keyword_search_long(
        &self,
        scope: &str,
        query: &str,
        limit: i64,
    ) -> Result<Vec<Value>, CoreError> {
        let q = query.trim();
        if q.is_empty() {
            return Ok(Vec::new());
        }
        Ok(self
            .fts_search_long(Some(scope), q, limit)?
            .into_iter()
            .map(|(score, row)| {
                let (id, content, source, scope, kind, importance, status, created_at) = row;
                long_mem_hit_json(
                    id,
                    content,
                    source,
                    scope,
                    kind,
                    importance,
                    status,
                    created_at,
                    score,
                    false,
                )
            })
            .collect())
    }

    pub(crate) fn semantic_search_long(
        &self,
        scope: &str,
        query_vec: &[f32],
        limit: i64,
    ) -> Result<Vec<Value>, CoreError> {
        let embedding = self.embedding();
        let sig = embedding.signature();
        if sig.is_empty() {
            return Ok(Vec::new());
        }
        let sql = semantic_long_sql(scope);
        // 语义召回是纯读（全量余弦在 Rust 侧算），同样走读池
        self.read(|conn| {
            let mut scored: Vec<(f64, Value)> = Vec::new();
            let mut stmt = conn.prepare(&sql)?;
            let rows: Vec<LongMemSemanticRow> = if is_global_memory_scope(scope) {
                stmt.query_map(params![sig, now_ms()], map_long_mem_semantic_row)?
                    .collect::<Result<Vec<_>, _>>()?
            } else {
                // ?1 = v.model（模型签名）、?2 = 「现在」（可见性谓词用）、?3 = m.scope。
                stmt.query_map(params![sig, now_ms(), scope], map_long_mem_semantic_row)?
                    .collect::<Result<Vec<_>, _>>()?
            };
            for (id, content, source, created_at, scope, kind, importance, status, blob, dims) in rows {
                let Some(vec) = embedding::blob_to_vector(&blob, dims as usize) else {
                    continue;
                };
                let score = embedding::cosine_similarity(query_vec, &vec);
                // 与代码索引的向量池共用同一个下限（`embedding::MIN_SIMILARITY`），不各写一份
                if score <= embedding::MIN_SIMILARITY {
                    continue;
                }
                scored.push((
                    score,
                    long_mem_hit_json(
                        id,
                        content,
                        source,
                        scope,
                        kind,
                        importance,
                        status,
                        created_at,
                        score,
                        true,
                    ),
                ));
            }
            scored.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
            Ok(scored
                .into_iter()
                .take(limit as usize)
                .map(|(_, v)| v)
                .collect())
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 回归（P3）：语义召回必须和关键词召回**同一个可见性谓词**。
    ///
    /// 旧实现手写 `m.status = 'active'`：过期记忆照样能被语义召回（关键词分支用的是
    /// `long_mem_visible_sql`），同一个问题问两次得到两套记忆。
    #[test]
    fn semantic_branch_uses_the_shared_visibility_predicate() {
        let global = semantic_long_sql(GLOBAL_MEMORY_SCOPE);
        assert!(
            global.contains("expires_at"),
            "语义分支必须用过期判定（long_mem_visible_sql）：{global}"
        );
        assert!(
            !global.contains("m.status = 'active'"),
            "别退回硬编码单一状态：{global}"
        );
        // 绑定顺序：?1 模型签名 / ?2「现在」/ ?3 scope（可见性谓词占用了 ?2）
        assert!(global.contains("?2"), "{global}");
        let project = semantic_long_sql("project:abc");
        assert!(project.contains("m.scope = ?3"), "作用域必须绑 ?3：{project}");
    }

    /// 回归（P3）：长记忆的「命中」形状只有一份（关键词 / 语义两条分支共用）。
    #[test]
    fn hit_projection_has_one_shape() {
        let kw =
            long_mem_hit_json(1, "c".into(), None, None, None, 3, "active".into(), 42, 0.5, false);
        let sem =
            long_mem_hit_json(1, "c".into(), None, None, None, 3, "active".into(), 42, 0.5, true);
        assert_eq!(kw["created_at"], 42, "统一用 created_at（与完整行一致）");
        assert!(kw.get("createdAt").is_none(), "不许两种命名并存");
        assert!(kw.get("vectorSearch").is_none());
        assert_eq!(sem["vectorSearch"], true);
        assert_eq!(kw["score"], sem["score"], "分数同样四舍五入");
    }
}

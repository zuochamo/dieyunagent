// 依赖与 mod.rs 同源：域文件里直接用，不再各自拼一套 use。
use super::*;

use rusqlite::{params, OptionalExtension};
use serde_json::{json, Value};

use crate::embedding::{self};
use crate::error::CoreError;

/// 近重复判定的余弦阈值：同一 scope 内相似度 ≥ 该值的写入视为「同一件事的另一种说法」。
/// 取 0.92 而不是 0.8：记忆粒度本来就抽象，0.8 会把「偏好中文」和「偏好简短」并成一条。
const NEAR_DUP_COSINE: f64 = 0.92;

/// 自动归纳（source 含 consolidation）条目的 importance 下限，低于此值不落库。
/// 依据是库里的真实分布：importance ≤ 2 的条目既进不了每轮 8+5 的注入预算，
/// 又会在语义召回里占位 —— 那就别写进来。
const CONSOLIDATION_MIN_IMPORTANCE: i64 = 3;

/**
 * 长记忆写入侧：去重（精确 / 近重复）、kind 与重要度归一、向量索引与重建。
 * **写入策略只在这里**（`add_long_memory*` / `apply_long_memory_deduped`），工具层不许绕过。
 */

/// 近重复判定的余弦阈值：同一 scope 内相似度 ≥ 该值的写入视为「同一件事的另一种说法」。

/// 自动归纳（source 含 consolidation）条目的 importance 下限，低于此值不落库。

pub(crate) fn map_long_memory_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Value> {
    Ok(json!({
        "id": row.get::<_, i64>(0)?,
        "content": row.get::<_, String>(1)?,
        "source": row.get::<_, Option<String>>(2)?,
        "scope": row.get::<_, Option<String>>(3)?,
        "kind": row.get::<_, Option<String>>(4)?,
        "importance": row.get::<_, i64>(5)?,
        "status": row.get::<_, String>(6)?,
        "created_at": row.get::<_, i64>(7)?,
        "updated_at": row.get::<_, Option<i64>>(8)?,
        "last_used_at": row.get::<_, Option<i64>>(9)?,
        "access_count": row.get::<_, Option<i64>>(10)?,
    }))
}

/// `kind` 的判据只有两处，且**先模型、后凭据形状**：
///
/// 1. 写入方给的 `kind`（归纳器 schema、`memory_long_add` 入参）是权威 —— 模型看得懂
///    「这条是隐私还是工程事实」，代码看不懂；
/// 2. 唯一的代码否决权是凭据形状（`password=` / `sk-…` / `AKIA…` / PEM 头 / URL 里带口令）：
///    命中就把 `normal` 升级成 `secret`。这是 fail-safe —— 模型漏标一次，密钥就会在下一轮
///    被自动注入；反向（把一条正常记忆多标一次 secret）只是少注入一条，代价不对称。
///
/// 这里**不再**按话题词猜 `private`（旧的 `邮箱/手机号/身份证/数据库/host/内网` 会把
/// 「连库走 5432」「内网是 10.0.0.0/8」这类工程事实判成 private，而 private 的下游是
/// 「永不自动注入 + 永不写 .dieyun/memory.md」—— 知识静默消失，用户还看不到原因）。
/// 敏感与否由模型的 `kind` 决定。
pub(crate) fn detect_memory_kind(content: &str, requested: Option<&str>) -> String {
    let requested_kind = requested
        .map(str::trim)
        .map(str::to_lowercase)
        .filter(|s| ["normal", "private", "secret"].contains(&s.as_str()));
    if looks_like_credential(content) {
        return "secret".into();
    }
    requested_kind.unwrap_or_else(|| "normal".into())
}

/// 凭据**形状**（不是话题词表）：赋值形态 + 已知密钥前缀 + PEM 头 + URL 内联口令。
/// 判的是「这串字符本身长什么样」，与内容在讲哪件事无关，因此不误伤工程记忆。
pub(crate) fn looks_like_credential(text: &str) -> bool {
    let lower = text.to_lowercase();
    if lower.contains("-----begin") && lower.contains("private key") {
        return true;
    }
    if lower.contains("sk-") && lower.len() > 15 {
        return true;
    }
    if lower.contains("akia") || lower.contains("ghp_") || lower.contains("xoxb-") {
        return true;
    }
    if has_inline_url_userinfo(&lower) {
        return true;
    }
    // 赋值形态：`password=…` / `api_key: …` / `密码：…`（只认「键 + 分隔符」，不认裸词）。
    const CREDENTIAL_KEYS: [&str; 8] = [
        "password", "passwd", "api_key", "apikey", "secret_key", "token", "密码", "密钥",
    ];
    CREDENTIAL_KEYS.iter().any(|key| {
        lower
            .find(key)
            .map(|idx| {
                lower[idx + key.len()..]
                    .trim_start_matches([' ', '\t', '"', '\''])
                    .chars()
                    .next()
                    .map(|c| c == '=' || c == ':' || c == '：')
                    .unwrap_or(false)
            })
            .unwrap_or(false)
    })
}

/// `scheme://user:pass@host` 形态：连接串里带口令，肉眼就是密钥。
/// 只认 authority 段内的 `@`，不会因为正文里同时出现网址和邮箱就误判。
pub(crate) fn has_inline_url_userinfo(text: &str) -> bool {
    let mut rest = text;
    while let Some(scheme_end) = rest.find("://") {
        let authority = &rest[scheme_end + 3..];
        let authority_end = authority
            .find(|c: char| c == '/' || c.is_whitespace())
            .unwrap_or(authority.len());
        if authority[..authority_end].contains('@') && authority[..authority_end].contains(':') {
            return true;
        }
        rest = &authority[authority_end..];
    }
    false
}

pub(crate) fn normalize_memory_status(status: &str) -> String {
    let s = status.trim().to_lowercase();
    if ["active", "stale", "archived", "deleted"].contains(&s.as_str()) {
        s
    } else {
        "active".into()
    }
}

pub(crate) fn normalize_importance(value: Option<i64>) -> i64 {
    value.unwrap_or(3).clamp(1, 5)
}

/// 写入 scope 的归一（**唯一**实现）：空 / 缺省 = 用户级 `global`，过长截到 120 字符。
/// 单条写入、批量写入、写入前的近重复判定必须用同一份口径，否则「同一个 scope」
/// 在不同路径上会变成两个字符串，近重复抑制就失效。
pub(crate) fn normalize_memory_scope(scope: Option<&str>) -> String {
    scope
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(GLOBAL_MEMORY_SCOPE)
        .chars()
        .take(120)
        .collect::<String>()
}

/// 低价值闸（归纳器写入政策的一部分）：自动归纳出来的低 importance 条目不落库。
/// 单条与批量入口共用这一份判定。
pub(crate) fn is_low_value_consolidation(source: &str, importance: Option<i64>) -> bool {
    source.contains("consolidation") && normalize_importance(importance) < CONSOLIDATION_MIN_IMPORTANCE
}

pub(crate) fn low_value_json(importance: Option<i64>) -> Value {
    json!({
        "ok": true,
        "skipped": "low_importance",
        "importance": normalize_importance(importance),
        "vector": json!({ "ok": true, "indexed": false, "reason": "skipped" }),
    })
}

pub(crate) fn skipped_json(reason: &str) -> Value {
    json!({
        "ok": true,
        "skipped": reason,
        "vector": json!({ "ok": true, "indexed": false, "reason": "skipped" }),
    })
}

impl MemoryStore {
    pub fn add_long_memory(
        &self,
        content: &str,
        source: &str,
        kind: Option<&str>,
        scope: Option<&str>,
        importance: Option<i64>,
        expires_at: Option<i64>,
        metadata: Option<&Value>,
        session_id: Option<&str>,
    ) -> Result<Value, CoreError> {
        let normalized = content.trim();
        if normalized.is_empty() {
            return Err(CoreError::rpc("INVALID_CONTENT", "content 必填"));
        }
        let now = now_ms();
        let kind = detect_memory_kind(normalized, kind);
        let scope = normalize_memory_scope(scope);
        let importance = normalize_importance(importance);
        let session_id = session_id
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(|s| s.chars().take(64).collect::<String>());
        let metadata_json = metadata.map(|m| {
            if m.is_string() {
                m.as_str().unwrap_or("").to_string()
            } else {
                m.to_string()
            }
        });
        self.with_conn(|conn| {
            if let Ok(existing) = conn.query_row(
                "SELECT id FROM long_memories WHERE content = ?1 AND status != 'deleted' LIMIT 1",
                params![normalized],
                |row| row.get::<_, i64>(0),
            ) {
                conn.execute(
                    "UPDATE long_memories
                     SET updated_at = ?1, source = COALESCE(source, ?2),
                         status = CASE WHEN status = 'archived' THEN 'active' ELSE status END,
                         session_id = COALESCE(session_id, ?4)
                     WHERE id = ?3",
                    params![now, source, existing, session_id],
                )?;
                return Ok(json!({ "localMemoryId": existing, "duplicate": true }));
            }
            conn.execute(
                "INSERT INTO long_memories
                  (content, source, scope, kind, importance, status, created_at, updated_at, expires_at, metadata_json, session_id)
                 VALUES (?1, ?2, ?3, ?4, ?5, 'active', ?6, ?6, ?7, ?8, ?9)",
                params![
                    normalized,
                    source,
                    scope,
                    kind,
                    importance,
                    now,
                    expires_at.filter(|v| *v > 0),
                    metadata_json,
                    session_id
                ],
            )?;
            Ok(json!({ "localMemoryId": conn.last_insert_rowid() }))
        })
    }

    /// 会话维度：把这个会话沉淀的记忆整体**软归档**（可恢复，不物理删除）。
    ///
    /// 与「删掉记忆」分开：状态位是既有生命周期（active/stale/archived）的一部分，
    /// 不新增删除路径，也不需要询问模型；恢复走 memory.long_status_set。
    pub fn archive_long_memories_by_session(&self, session_id: &str) -> Result<i64, CoreError> {
        let sid = session_id.trim();
        if sid.is_empty() {
            return Ok(0);
        }
        let now = now_ms();
        self.with_conn(|conn| {
            let n = conn.execute(
                "UPDATE long_memories
                 SET status = 'archived', updated_at = ?1
                 WHERE session_id = ?2 AND status != 'archived'",
                params![now, sid],
            )?;
            Ok(n as i64)
        })
    }

    /// 写入策略层（**唯一**政策点）：低价值闸 + 近重复抑制 + 写入即索引。
    ///
    /// 为什么政策放在这里而不在 Node：memory.long_add 是全部写入方（归纳器、记忆工具、
    /// 手动）的共同终点，也是唯一能在**插入前**看到 embedding 的地方。
    ///
    /// - 低价值闸：source 带 consolidation（自动归纳）且 importance 低于阈值则不落库。
    ///   数据事实：注入预算每轮只给 8+5 条，importance ≤ 2 的近 400 条既进不去又挤占召回。
    /// - 近重复抑制：同 scope 内余弦 ≥ 阈值视为「同一件事的另一种说法」，只更新既有行
    ///   （importance 取大、updated_at 刷新、来源会话 COALESCE 补齐），不再新增一行。
    ///   复用既有 embedding 与语义检索，不另造一套文本相似度。
    ///
    /// 单条入口。批量写入（归纳器一次 8 条）走
    /// [`add_long_memories_deduped`](Self::add_long_memories_deduped)：同一套政策，
    /// 区别只在「向量是一次批量算出来的」。
    pub async fn add_long_memory_deduped(
        &self,
        content: &str,
        source: &str,
        kind: Option<&str>,
        scope: Option<&str>,
        importance: Option<i64>,
        expires_at: Option<i64>,
        metadata: Option<&Value>,
        session_id: Option<&str>,
    ) -> Result<Value, CoreError> {
        let normalized = content.trim();
        if normalized.is_empty() {
            return Err(CoreError::rpc("INVALID_CONTENT", "content 必填"));
        }
        if is_low_value_consolidation(source, importance) {
            return Ok(low_value_json(importance));
        }
        let scope_value = normalize_memory_scope(scope);
        let vector = self.embed_for_write(normalized).await?;
        self.apply_long_memory_deduped(
            &vector,
            normalized,
            source,
            kind,
            scope_value.as_str(),
            importance,
            expires_at,
            metadata,
            session_id,
        )
    }

    /// 一次写多条（同一 source / scope / 会话）—— **一次** embedding 请求算完全部向量。
    ///
    /// 为什么不是循环调 `long_add`：端点串行时每条要付一次完整往返（自建 4B 模型实测
    /// 34–44s/条），一次归纳 8 条 = 5.5 分钟**独占**端点，期间每轮召回与代码检索全部排队
    /// 超时（现场：`codebase.search 超时` 打挂整轮发送）。批量化后同样 8 条只要 1 次往返，
    /// 批大小上限仍是 `embedding::plan_embed_batches` 那一份。
    ///
    /// 逐条结果按入参顺序返回（`results[i]` 对应 `items[i]`），计数由调用方自己算 ——
    /// 这里不编造「保存了 N 条」的第二个真相。
    ///
    /// 失败语义与单条入口一致：embedding 不通就让整批报错（宁可这轮一条都不写，
    /// 也不写进判定不了近重复、以后检索只能靠子串的行）。代价是单次失败的影响面从
    /// 1 条变 N 条 —— 因为一次归纳就是一组同源条目，重跑一次归纳即可。
    pub async fn add_long_memories_deduped(
        &self,
        items: &[LongMemoryInput],
        source: &str,
        scope: Option<&str>,
        session_id: Option<&str>,
    ) -> Result<Value, CoreError> {
        let scope_value = normalize_memory_scope(scope);
        // 先按「不需要向量」的闸门挑出要写哪几条，其余直接给结论（不占 embedding 预算）
        let mut results: Vec<Value> = Vec::with_capacity(items.len());
        let mut pending: Vec<(i64, String)> = Vec::new();
        for (i, item) in items.iter().enumerate() {
            let content = item.content.trim();
            if content.is_empty() {
                results.push(skipped_json("empty_content"));
                continue;
            }
            if is_low_value_consolidation(source, item.importance) {
                results.push(low_value_json(item.importance));
                continue;
            }
            results.push(Value::Null);
            pending.push((
                i as i64,
                content.chars().take(MEMORY_EMBED_TEXT_MAX).collect(),
            ));
        }

        let embedding = self.embedding();
        let mut vectors: std::collections::HashMap<i64, Vec<f32>> =
            std::collections::HashMap::new();
        if embedding.enabled() && !pending.is_empty() {
            for (idx, vector) in embedding::embed_batches(&embedding, &pending).await? {
                if !vector.is_empty() {
                    vectors.insert(idx, vector);
                }
            }
        }

        for (i, item) in items.iter().enumerate() {
            if !results[i].is_null() {
                continue;
            }
            let vector = vectors.remove(&(i as i64)).unwrap_or_default();
            results[i] = self.apply_long_memory_deduped(
                &vector,
                item.content.trim(),
                source,
                item.kind.as_deref(),
                scope_value.as_str(),
                item.importance,
                None,
                item.metadata.as_ref(),
                session_id,
            )?;
        }
        Ok(json!({ "ok": true, "results": results }))
    }

    pub(crate) fn apply_long_memory_deduped(
        &self,
        vector: &[f32],
        content: &str,
        source: &str,
        kind: Option<&str>,
        scope: &str,
        importance: Option<i64>,
        expires_at: Option<i64>,
        metadata: Option<&Value>,
        session_id: Option<&str>,
    ) -> Result<Value, CoreError> {
        let imp = normalize_importance(importance);
        if !vector.is_empty() {
            if let Some((dup_id, similarity)) = self.near_duplicate(scope, vector)? {
                let now = now_ms();
                self.with_conn(|conn| {
                    conn.execute(
                        "UPDATE long_memories
                         SET updated_at = ?1,
                             importance = MAX(COALESCE(importance, 3), ?2),
                             session_id = COALESCE(session_id, ?4)
                         WHERE id = ?3",
                        params![now, imp, dup_id, session_id],
                    )?;
                    Ok(())
                })?;
                return Ok(json!({
                    "ok": true,
                    "localMemoryId": dup_id,
                    "duplicate": "near",
                    "similarity": round_score(similarity),
                    "vector": json!({ "ok": true, "indexed": false, "reason": "duplicate" }),
                }));
            }
        }
        let ins = self.add_long_memory(
            content,
            source,
            kind,
            Some(scope),
            importance,
            expires_at,
            metadata,
            session_id,
        )?;
        let memory_id = ins
            .get("localMemoryId")
            .and_then(|v| v.as_i64())
            .unwrap_or(0);
        let vector_res = self.store_long_memory_vector(memory_id, vector)?;
        Ok(json!({
            "ok": true,
            "localMemoryId": memory_id,
            "duplicate": ins.get("duplicate").cloned().unwrap_or(Value::Bool(false)),
            "vector": vector_res,
        }))
    }

    /// 写入前的 embedding（**不含**近重复判定：判定在 `apply_long_memory_deduped` 里，
    /// 批量路径要先批量算完向量再逐条判定）。
    async fn embed_for_write(&self, content: &str) -> Result<Vec<f32>, CoreError> {
        let embedding = self.embedding();
        if !embedding.enabled() {
            return Ok(Vec::new());
        }
        let text = content
            .chars()
            .take(MEMORY_EMBED_TEXT_MAX)
            .collect::<String>();
        Ok(embedding::embed_texts(&embedding, &[text])
            .await?
            .into_iter()
            .next()
            .unwrap_or_default())
    }

    /// 同 scope 内最近的一条近重复（余弦 ≥ [`NEAR_DUP_COSINE`]）。
    pub(crate) fn near_duplicate(
        &self,
        scope: &str,
        vector: &[f32],
    ) -> Result<Option<(i64, f64)>, CoreError> {
        let hits = self.semantic_search_long(scope, vector, 1)?;
        Ok(hits.first().and_then(|hit| {
            let id = hit.get("id").and_then(|v| v.as_i64())?;
            let score = hit.get("score").and_then(|v| v.as_f64())?;
            if score >= NEAR_DUP_COSINE {
                Some((id, score))
            } else {
                None
            }
        }))
    }

    pub async fn index_long_memory(&self, memory_id: i64) -> Result<Value, CoreError> {
        let row = self.with_conn(|conn| {
            Ok(conn
                .query_row(
                    "SELECT content FROM long_memories WHERE id = ?1 AND status != 'deleted'",
                    params![memory_id],
                    |row| row.get::<_, String>(0),
                )
                .optional()?)
        })?;
        let Some(content) = row.filter(|c| !c.trim().is_empty()) else {
            return Ok(json!({ "ok": false, "indexed": false, "reason": "not_found" }));
        };
        let embedding = self.embedding();
        if !embedding.enabled() {
            return Ok(json!({ "ok": false, "indexed": false, "reason": "embedding_disabled" }));
        }
        let text = content
            .chars()
            .take(MEMORY_EMBED_TEXT_MAX)
            .collect::<String>();
        let vectors = embedding::embed_texts(&embedding, &[text]).await?;
        let vector = vectors.into_iter().next().unwrap_or_default();
        if vector.is_empty() {
            return Ok(json!({ "ok": false, "indexed": false, "reason": "embedding_failed" }));
        }
        self.store_long_memory_vector(memory_id, &vector)
    }

    /// 向量落库（**唯一**实现）：index_long_memory 与「写入即索引」共用。
    ///
    /// 抽出来的理由只有一个：抑制近重复时必须先算一次 embedding，
    /// 算完不该为了入库再算第二次（远程 embedding 一次往返就是几百毫秒）。
    pub(crate) fn store_long_memory_vector(&self, memory_id: i64, vector: &[f32]) -> Result<Value, CoreError> {
        if vector.is_empty() {
            return Ok(json!({ "ok": false, "indexed": false, "reason": "embedding_failed" }));
        }
        let embedding = self.embedding();
        let sig = embedding.signature();
        let dims = embedding.dimensions;
        let blob = embedding::vector_to_blob(vector);
        let now = now_ms();
        self.with_conn(|conn| {
            conn.execute(
                "INSERT INTO long_memory_vectors (memory_id, model, dimensions, vector, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5)
                 ON CONFLICT(memory_id) DO UPDATE SET
                   model = excluded.model,
                   dimensions = excluded.dimensions,
                   vector = excluded.vector,
                   updated_at = excluded.updated_at",
                params![memory_id, sig, dims, blob, now],
            )?;
            Ok(json!({
                "ok": true,
                "indexed": true,
                "memoryId": memory_id,
                "embeddingModel": sig,
            }))
        })
    }

    pub async fn reindex_long_memories(&self, limit: i64) -> Result<Value, CoreError> {
        let embedding = self.embedding();
        if !embedding.enabled() {
            return Ok(json!({ "ok": false, "indexed": 0, "reason": "embedding_disabled" }));
        }
        let sig = embedding.signature();
        let dims = embedding.dimensions;
        let now = now_ms();
        let rows = self.with_conn(|conn| -> Result<Vec<(i64, String)>, CoreError> {
            let sql = format!(
                "SELECT m.id, m.content
                 FROM long_memories m
                 LEFT JOIN long_memory_vectors v ON v.memory_id = m.id AND v.model = ?1
                 WHERE {}
                   AND v.memory_id IS NULL
                 ORDER BY m.id ASC
                 LIMIT ?3",
                long_mem_visible_sql("m", 2)
            );
            let mut stmt = conn.prepare(&sql)?;
            let mapped = stmt.query_map(params![sig, now, limit], |row| {
                Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
            })?;
            mapped
                .collect::<Result<Vec<_>, _>>()
                .map_err(CoreError::from)
        })?;
        let mut indexed = 0i64;
        // 一批一个请求：原来每条记忆单独发一次 embedding HTTP（100 条 = 100 次串行往返）。
        // 分批与并发上限都在 embedding::embed_batches 里（进程级闸门单一来源）。
        let pending: Vec<(i64, String)> = rows
            .into_iter()
            .map(|(id, content)| {
                let text = content
                    .chars()
                    .take(MEMORY_EMBED_TEXT_MAX)
                    .collect::<String>();
                (id, text)
            })
            .collect();
        for (id, vector) in embedding::embed_batches(&embedding, &pending).await? {
            if vector.is_empty() {
                continue;
            }
            let blob = embedding::vector_to_blob(&vector);
            self.with_conn(|conn| {
                conn.execute(
                    "INSERT INTO long_memory_vectors (memory_id, model, dimensions, vector, updated_at)
                     VALUES (?1, ?2, ?3, ?4, ?5)
                     ON CONFLICT(memory_id) DO UPDATE SET
                       model = excluded.model,
                       dimensions = excluded.dimensions,
                       vector = excluded.vector,
                       updated_at = excluded.updated_at",
                    params![id, sig, dims, blob, now],
                )?;
                Ok(())
            })?;
            indexed += 1;
        }
        let batch_len = indexed;
        Ok(json!({
            "ok": true,
            "indexed": indexed,
            "remainingPossible": batch_len >= limit,
            "embeddingModel": sig,
        }))
    }

    pub fn update_long_memory_status(
        &self,
        memory_id: i64,
        status: &str,
    ) -> Result<Value, CoreError> {
        let normalized = normalize_memory_status(status);
        let now = now_ms();
        self.with_conn(|conn| {
            conn.execute(
                "UPDATE long_memories SET status = ?1, updated_at = ?2 WHERE id = ?3",
                params![normalized, now, memory_id],
            )?;
            if normalized == "deleted" {
                conn.execute(
                    "DELETE FROM long_memory_vectors WHERE memory_id = ?1",
                    params![memory_id],
                )?;
            }
            Ok(json!({ "ok": true, "status": normalized }))
        })
    }
}

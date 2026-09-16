use std::collections::{HashMap, HashSet};

use rusqlite::{params, Connection};
use serde::Serialize;

use crate::embedding::{
    blob_to_vector, cosine_similarity, exact_scan_threshold, query_seed, sample_modulus_for,
};
use crate::error::CoreError;

use super::vector_pool::{self, VectorPool};

/// Max results a single codebase.search may return.
pub const SEARCH_LIMIT_MAX: u32 = 48;

/// 单条命中的带行号正文上限。命中在 chunk 内的位置不确定，整块给出更省一次回读。
/// 字节上限略高于 Node 侧 codebaseSnippetMax（2400 字符），避免中文先被 Rust 截断。
const SNIPPET_MAX_CHARS: usize = 3600;
const SNIPPET_MAX_LINES: usize = 80;

/// 轻量 rerank 的候选池规模：limit * FACTOR + BASE，只对头部候选重算词元覆盖率。
const RERANK_POOL_FACTOR: usize = 6;
const RERANK_POOL_BASE: usize = 24;

/// 命中行之前保留的上下文行数。片段以命中行为锚点向后展开，
/// 避免「命中在大 chunk 中后部、被字符预算截掉」——那会让模型看到整段却看不到命中词。
const SNIPPET_PRE_LINES: usize = 8;

/// 单个展示行的字符上限（与 Node 侧 grep 的 slice(0,400) 对齐）。
/// 压缩产物等超长单行若不截断，会把整块字符预算吃光，只剩一行截断提示。
const SNIPPET_LINE_MAX_CHARS: usize = 400;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub path: String,
    pub start_line: i64,
    pub end_line: i64,
    pub score: f64,
    pub snippet: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    pub ok: bool,
    pub results: Vec<SearchHit>,
    pub query: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub needs_index: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total_candidates: Option<usize>,
    pub vector_search: bool,
}

pub fn search(
    conn: &Connection,
    root_hash: &str,
    query: &str,
    limit: Option<u32>,
    query_vector: Option<&[f32]>,
    pool: Option<&VectorPool>,
) -> Result<SearchResult, CoreError> {
    let q = query.trim();
    let limit = limit.unwrap_or(8).clamp(1, SEARCH_LIMIT_MAX) as usize;
    let vector_search = query_vector.is_some();
    if q.is_empty() {
        return Ok(empty_result(q, false, vector_search));
    }

    let chunk_count: i64 = conn
        .query_row(
            "SELECT chunk_count FROM workspaces WHERE root_hash = ?1",
            params![root_hash],
            |r| r.get(0),
        )
        .unwrap_or(0);
    if chunk_count == 0 {
        return Ok(SearchResult {
            ok: true,
            results: vec![],
            query: q.to_string(),
            needs_index: Some(true),
            total_candidates: Some(0),
            vector_search: false,
        });
    }

    let query_tokens = tokenize_for_semantic(q);
    let fts_query = escape_fts_query(q);
    let mut scored: HashMap<i64, (f64, ChunkRow)> = HashMap::new();

    if let Some(fts_q) = fts_query {
        let mut stmt = conn
            .prepare(
                "SELECT c.id, c.rel_path, c.start_line, c.end_line, c.content,
                        bm25(chunks_fts) AS rank,
                        highlight(chunks_fts, 1, char(2), char(3)) AS hl
                 FROM chunks_fts
                 JOIN chunks c ON c.id = chunks_fts.rowid
                 WHERE chunks_fts MATCH ?1 AND c.root_hash = ?2
                 ORDER BY rank
                 LIMIT ?3",
            )
            .map_err(|e| CoreError::rpc("SEARCH_FAILED", e.to_string()))?;
        // 词法候选取宽一些：ANN 模式下这些候选会全量重算余弦，
        // 候选越全，越不容易漏掉「词法相关但被抽样跳过」的真命中。
        let fts_candidates = (limit * 12).max(60).min(400) as i64;
        let rows = stmt
            .query_map(params![fts_q, root_hash, fts_candidates], map_chunk_with_rank)
            .map_err(|e| CoreError::rpc("SEARCH_FAILED", e.to_string()))?;
        for row in rows.flatten() {
            let (id, rank, chunk) = row;
            let fts_score = (-rank).max(0.0);
            scored.insert(id, (fts_score * 0.35, chunk));
        }
    }

    if let Some(q_vec) = query_vector {
        match pool {
            // 内存池命中：全量精确余弦，不做抽样
            Some(p) if p.matches_dims(q_vec) => {
                apply_vector_scores_from_pool(conn, root_hash, p, q_vec, &mut scored, limit)?;
            }
            _ => apply_vector_scores(conn, root_hash, q, q_vec, &mut scored)?,
        }
    } else {
        let mut stmt = conn
            .prepare(
                "SELECT id, rel_path, start_line, end_line, content FROM chunks
                 WHERE root_hash = ?1 LIMIT 8000",
            )
            .map_err(|e| CoreError::rpc("SEARCH_FAILED", e.to_string()))?;
        let rows = stmt
            .query_map(params![root_hash], map_chunk)
            .map_err(|e| CoreError::rpc("SEARCH_FAILED", e.to_string()))?;
        for row in rows.flatten() {
            let chunk_tokens = tokenize_for_semantic(&row.content);
            let path_tokens =
                tokenize_for_semantic(&row.rel_path.replace(['/', '\\', '.', '_', '-'], " "));
            let sem = semantic_overlap_score(&query_tokens, &chunk_tokens, &path_tokens);
            if sem <= 0.05 {
                continue;
            }
            let entry = scored.entry(row.id).or_insert((0.0, row));
            entry.0 += sem * 0.3;
        }
    }

    let mut ranked: Vec<(f64, ChunkRow)> = scored.into_values().collect();
    ranked.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));

    // 轻量 rerank：融合分只说明「像不像」，再用 query 词元覆盖率修正一次——
    // 语义相近但正文没提到 query 词的 chunk 不该挤掉真命中。只对头部候选重算，控制成本。
    let pool = ranked.len().min(limit * RERANK_POOL_FACTOR + RERANK_POOL_BASE);
    for item in ranked.iter_mut().take(pool) {
        let chunk_tokens = tokenize_for_semantic(&item.1.content);
        let path_tokens =
            tokenize_for_semantic(&item.1.rel_path.replace(['/', '\\', '.', '_', '-'], " "));
        let cover = semantic_overlap_score(&query_tokens, &chunk_tokens, &path_tokens);
        item.0 *= 0.55 + 0.45 * cover;
    }
    ranked.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));

    let total = ranked.len();
    let results = ranked
        .into_iter()
        .take(limit)
        .map(|(score, row)| SearchHit {
            path: row.rel_path.clone(),
            start_line: row.start_line,
            end_line: row.end_line,
            score: (score * 1000.0).round() / 1000.0,
            snippet: snippet(&row.content, row.start_line, row.hit_line),
        })
        .collect();

    Ok(SearchResult {
        ok: true,
        results,
        query: q.to_string(),
        needs_index: None,
        total_candidates: Some(total),
        vector_search,
    })
}

/// 走内存向量池：全量精确余弦（无抽样），并把「无词法信号但语义相近」的候选补进来。
fn apply_vector_scores_from_pool(
    conn: &Connection,
    root_hash: &str,
    pool: &VectorPool,
    q_vec: &[f32],
    scored: &mut HashMap<i64, (f64, ChunkRow)>,
    limit: usize,
) -> Result<(), CoreError> {
    let q_norm = VectorPool::query_norm(q_vec);
    if q_norm <= 1e-8 {
        return Ok(());
    }

    let mut hits: Vec<(i64, f32)> = Vec::new();
    pool.scan_into(q_vec, q_norm, &mut hits);
    if hits.is_empty() {
        return Ok(());
    }
    hits.sort_unstable_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));

    // 1) 词法候选（FTS 命中，已在 scored 里）补向量分
    let lexical_ids: Vec<i64> = scored.keys().copied().collect();
    for id in lexical_ids {
        if let Some(sim) = pool.similarity_of(id, q_vec, q_norm) {
            if sim > vector_pool::MIN_SIMILARITY {
                if let Some(entry) = scored.get_mut(&id) {
                    entry.0 += sim * 0.55;
                }
            }
        }
    }

    // 2) 语义召回：取前 M（保证覆盖最终 top-limit），只对尚未进入 scored 的补齐正文
    let m = (limit * 8 + 256).min(hits.len());
    let mut need: HashMap<i64, f64> = HashMap::new();
    for (id, sim) in hits.iter().take(m) {
        if scored.contains_key(id) {
            continue;
        }
        need.insert(*id, *sim as f64);
    }
    if need.is_empty() {
        return Ok(());
    }

    let ids: Vec<i64> = need.keys().copied().collect();
    for chunk in ids.chunks(400) {
        let placeholders: String = (1..=chunk.len())
            .map(|i| format!("?{}", i + 1))
            .collect::<Vec<_>>()
            .join(",");
        let sql = format!(
            "SELECT id, rel_path, start_line, end_line, content FROM chunks
             WHERE root_hash = ?1 AND id IN ({placeholders})"
        );
        let mut stmt = conn
            .prepare(&sql)
            .map_err(|e| CoreError::rpc("SEARCH_FAILED", e.to_string()))?;
        let mut params_vec: Vec<Box<dyn rusqlite::ToSql>> = Vec::with_capacity(1 + chunk.len());
        params_vec.push(Box::new(root_hash.to_string()));
        for id in chunk {
            params_vec.push(Box::new(*id));
        }
        let param_refs: Vec<&dyn rusqlite::ToSql> = params_vec.iter().map(|p| p.as_ref()).collect();
        let rows = stmt
            .query_map(param_refs.as_slice(), map_chunk)
            .map_err(|e| CoreError::rpc("SEARCH_FAILED", e.to_string()))?;
        for row in rows.flatten() {
            let sim = need.get(&row.id).copied().unwrap_or(0.0);
            if sim <= vector_pool::MIN_SIMILARITY {
                continue;
            }
            let entry = scored.entry(row.id).or_insert((0.0, row));
            entry.0 += sim * 0.55;
        }
    }
    Ok(())
}

fn apply_vector_scores(
    conn: &Connection,
    root_hash: &str,
    query: &str,
    q_vec: &[f32],
    scored: &mut HashMap<i64, (f64, ChunkRow)>,
) -> Result<(), CoreError> {
    let vector_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM chunk_vectors v
             JOIN chunks c ON c.id = v.chunk_id
             WHERE c.root_hash = ?1",
            params![root_hash],
            |r| r.get(0),
        )
        .unwrap_or(0);

    if vector_count <= 0 {
        return Ok(());
    }

    // 维度决定单条字节数，进而决定「多少条还值得全量扫描」
    let dims: i64 = conn
        .query_row(
            "SELECT v.dims FROM chunk_vectors v
             JOIN chunks c ON c.id = v.chunk_id
             WHERE c.root_hash = ?1 LIMIT 1",
            params![root_hash],
            |r| r.get(0),
        )
        .unwrap_or(0);

    if vector_count <= exact_scan_threshold(dims) {
        score_all_vectors(conn, root_hash, q_vec, scored)?;
        return Ok(());
    }

    // ANN mode: always rescore lexical candidates, then stratified sample of the rest.
    // Track ids that already received a vector boost so FTS∩sample does not double-count.
    let mut vector_scored: HashSet<i64> = HashSet::new();
    let lexical_ids: Vec<i64> = scored.keys().copied().collect();
    if !lexical_ids.is_empty() {
        score_vectors_by_ids(
            conn,
            root_hash,
            q_vec,
            &lexical_ids,
            scored,
            &mut vector_scored,
        )?;
    }

    let modulus = sample_modulus_for(vector_count, dims);
    let residue = query_seed(query).rem_euclid(modulus);
    let mut stmt = conn
        .prepare(
            "SELECT c.id, c.rel_path, c.start_line, c.end_line, c.content, v.dims, v.vector
             FROM chunk_vectors v
             JOIN chunks c ON c.id = v.chunk_id
             WHERE c.root_hash = ?1 AND (c.id % ?2) = ?3",
        )
        .map_err(|e| CoreError::rpc("SEARCH_FAILED", e.to_string()))?;
    let rows = stmt
        .query_map(params![root_hash, modulus, residue], map_chunk_with_vector)
        .map_err(|e| CoreError::rpc("SEARCH_FAILED", e.to_string()))?;
    for row in rows.flatten() {
        accumulate_vector_score(q_vec, row, scored, &mut vector_scored);
    }
    Ok(())
}

fn score_all_vectors(
    conn: &Connection,
    root_hash: &str,
    q_vec: &[f32],
    scored: &mut HashMap<i64, (f64, ChunkRow)>,
) -> Result<(), CoreError> {
    let mut vector_scored: HashSet<i64> = HashSet::new();
    let mut stmt = conn
        .prepare(
            "SELECT c.id, c.rel_path, c.start_line, c.end_line, c.content, v.dims, v.vector
             FROM chunk_vectors v
             JOIN chunks c ON c.id = v.chunk_id
             WHERE c.root_hash = ?1",
        )
        .map_err(|e| CoreError::rpc("SEARCH_FAILED", e.to_string()))?;
    let rows = stmt
        .query_map(params![root_hash], map_chunk_with_vector)
        .map_err(|e| CoreError::rpc("SEARCH_FAILED", e.to_string()))?;
    for row in rows.flatten() {
        accumulate_vector_score(q_vec, row, scored, &mut vector_scored);
    }
    Ok(())
}

fn score_vectors_by_ids(
    conn: &Connection,
    root_hash: &str,
    q_vec: &[f32],
    ids: &[i64],
    scored: &mut HashMap<i64, (f64, ChunkRow)>,
    vector_scored: &mut HashSet<i64>,
) -> Result<(), CoreError> {
    // Batch IN clauses to stay within SQLite variable limits.
    for chunk in ids.chunks(400) {
        let placeholders: String = (1..=chunk.len())
            .map(|i| format!("?{}", i + 1))
            .collect::<Vec<_>>()
            .join(",");
        let sql = format!(
            "SELECT c.id, c.rel_path, c.start_line, c.end_line, c.content, v.dims, v.vector
             FROM chunk_vectors v
             JOIN chunks c ON c.id = v.chunk_id
             WHERE c.root_hash = ?1 AND c.id IN ({placeholders})"
        );
        let mut stmt = conn
            .prepare(&sql)
            .map_err(|e| CoreError::rpc("SEARCH_FAILED", e.to_string()))?;
        let mut params_vec: Vec<Box<dyn rusqlite::ToSql>> = Vec::with_capacity(1 + chunk.len());
        params_vec.push(Box::new(root_hash.to_string()));
        for id in chunk {
            params_vec.push(Box::new(*id));
        }
        let param_refs: Vec<&dyn rusqlite::ToSql> = params_vec.iter().map(|p| p.as_ref()).collect();
        let rows = stmt
            .query_map(param_refs.as_slice(), map_chunk_with_vector)
            .map_err(|e| CoreError::rpc("SEARCH_FAILED", e.to_string()))?;
        for row in rows.flatten() {
            accumulate_vector_score(q_vec, row, scored, vector_scored);
        }
    }
    Ok(())
}

fn accumulate_vector_score(
    q_vec: &[f32],
    row: (i64, ChunkRow, i64, Vec<u8>),
    scored: &mut HashMap<i64, (f64, ChunkRow)>,
    vector_scored: &mut HashSet<i64>,
) {
    let (id, chunk, dims, blob) = row;
    if vector_scored.contains(&id) {
        return;
    }
    let Some(vec) = blob_to_vector(&blob, dims as usize) else {
        return;
    };
    let sim = cosine_similarity(q_vec, &vec);
    vector_scored.insert(id);
    if sim <= 0.05 {
        return;
    }
    let entry = scored.entry(id).or_insert((0.0, chunk));
    entry.0 += sim * 0.55;
}

fn empty_result(q: &str, needs_index: bool, vector_search: bool) -> SearchResult {
    SearchResult {
        ok: true,
        results: vec![],
        query: q.to_string(),
        needs_index: if needs_index { Some(true) } else { None },
        total_candidates: Some(0),
        vector_search,
    }
}

#[derive(Clone)]
struct ChunkRow {
    id: i64,
    rel_path: String,
    start_line: i64,
    end_line: i64,
    content: String,
    /// 词法命中的行号（FTS highlight 推出）；仅向量命中时为 None
    hit_line: Option<i64>,
}

fn map_chunk_with_vector(
    row: &rusqlite::Row<'_>,
) -> rusqlite::Result<(i64, ChunkRow, i64, Vec<u8>)> {
    Ok((
        row.get(0)?,
        ChunkRow {
            id: row.get(0)?,
            rel_path: row.get(1)?,
            start_line: row.get(2)?,
            end_line: row.get(3)?,
            content: row.get(4)?,
            hit_line: None,
        },
        row.get(5)?,
        row.get(6)?,
    ))
}

fn map_chunk(row: &rusqlite::Row<'_>) -> rusqlite::Result<ChunkRow> {
    Ok(ChunkRow {
        id: row.get(0)?,
        rel_path: row.get(1)?,
        start_line: row.get(2)?,
        end_line: row.get(3)?,
        content: row.get(4)?,
        hit_line: None,
    })
}

/// FTS5 highlight 的起始标记（对应 SQL 里的 char(2)）。
const HL_OPEN: char = '\u{2}';

/// 从 FTS5 highlight 文本里推出第一个命中所在的绝对行号。
fn hit_line_from_highlight(hl: &str, start_line: i64) -> Option<i64> {
    let idx = hl.find(HL_OPEN)?;
    let rel = hl[..idx].matches('\n').count() as i64;
    Some(start_line + rel)
}

fn map_chunk_with_rank(row: &rusqlite::Row<'_>) -> rusqlite::Result<(i64, f64, ChunkRow)> {
    let start_line: i64 = row.get(2)?;
    // highlight 结果只用于定位命中行，不参与展示
    let hl: Option<String> = row.get::<_, Option<String>>(6).ok().flatten();
    let hit_line = hl.as_deref().and_then(|h| hit_line_from_highlight(h, start_line));
    Ok((
        row.get(0)?,
        row.get::<_, f64>(5)?,
        ChunkRow {
            id: row.get(0)?,
            rel_path: row.get(1)?,
            start_line,
            end_line: row.get(3)?,
            content: row.get(4)?,
            hit_line,
        },
    ))
}

fn snippet(content: &str, start_line: i64, hit_line: Option<i64>) -> String {
    let lines: Vec<&str> = content.lines().collect();
    if lines.is_empty() {
        return String::new();
    }
    let total = lines.len();
    // 命中行在 chunk 内的下标；只有词法命中才知道，向量命中按开头处理
    let hit_idx = hit_line
        .map(|h| (h - start_line).clamp(0, total as i64 - 1) as usize)
        .unwrap_or(0);
    // 以命中行为锚点向后展开（前面留少量上下文），命中行因此不会被字符预算截掉
    let begin = hit_idx.saturating_sub(SNIPPET_PRE_LINES);
    let end = (begin + SNIPPET_MAX_LINES).min(total);
    let mut out = String::new();
    for i in begin..end {
        let no = start_line + i as i64;
        // 超长单行（压缩产物等）先逐行截断，否则首行就撑爆字符预算、整块只剩提示
        let raw = lines[i];
        let shown = if raw.chars().count() > SNIPPET_LINE_MAX_CHARS {
            let head: String = raw.chars().take(SNIPPET_LINE_MAX_CHARS).collect();
            format!("{head}…")
        } else {
            raw.to_string()
        };
        let piece = format!("{no:>5}| {shown}\n");
        if out.len() + piece.len() > SNIPPET_MAX_CHARS {
            out.push_str("     …（本块后续内容已截断）\n");
            break;
        }
        out.push_str(&piece);
    }
    out.trim_end().to_string()
}

fn escape_fts_query(query: &str) -> Option<String> {
    let parts: Vec<String> = query
        .split(|c: char| c.is_whitespace() || "/\\.,;:!?，。；：、".contains(c))
        .map(|p| p.replace(['"', '\'', '*'], "").trim().to_string())
        .filter(|p| p.len() >= 2)
        .take(12)
        .map(|p| format!("\"{}\"", p.replace('"', "")))
        .collect();
    if parts.is_empty() {
        None
    } else {
        Some(parts.join(" OR "))
    }
}

fn tokenize_for_semantic(text: &str) -> HashSet<String> {
    let s = text.to_lowercase();
    let mut set = HashSet::new();
    let cjk: Vec<char> = s
        .chars()
        .filter(|c| ('\u{4e00}'..='\u{9fff}').contains(c))
        .collect();
    for ch in &cjk {
        set.insert(ch.to_string());
    }
    for w in cjk.windows(2) {
        set.insert(w.iter().collect());
    }
    for id in extract_ids(&s) {
        if id.len() >= 2 {
            set.insert(id.to_lowercase());
        }
    }
    for word in s.split(|c: char| c.is_whitespace() || "/\\._-+".contains(c)) {
        if (2..=48).contains(&word.len()) {
            set.insert(word.to_string());
        }
    }
    set
}

fn extract_ids(s: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    for ch in s.chars() {
        if ch.is_ascii_alphanumeric() || ch == '_' {
            cur.push(ch);
        } else if !cur.is_empty() {
            out.push(std::mem::take(&mut cur));
        }
    }
    if !cur.is_empty() {
        out.push(cur);
    }
    out
}

fn semantic_overlap_score(
    query_tokens: &HashSet<String>,
    chunk_tokens: &HashSet<String>,
    path_tokens: &HashSet<String>,
) -> f64 {
    if query_tokens.is_empty() {
        return 0.0;
    }
    let mut hit = 0.0;
    for t in query_tokens {
        if chunk_tokens.contains(t) {
            hit += 1.0;
        } else if path_tokens.contains(t) {
            hit += 0.6;
        }
    }
    hit / query_tokens.len() as f64
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::embedding::vector_to_blob;

    #[test]
    fn vector_boost_applied_once_even_if_rescored() {
        let q = [1.0f32, 0.0];
        let blob = vector_to_blob(&q);
        let chunk = ChunkRow {
            id: 42,
            rel_path: "a.rs".into(),
            start_line: 1,
            end_line: 2,
            content: "fn a() {}".into(),
            hit_line: None,
        };
        let mut scored = HashMap::new();
        scored.insert(42, (0.35, chunk.clone()));
        let mut vector_scored = HashSet::new();

        accumulate_vector_score(
            &q,
            (42, chunk.clone(), 2, blob.clone()),
            &mut scored,
            &mut vector_scored,
        );
        let after_first = scored.get(&42).unwrap().0;
        assert!(after_first > 0.35);

        accumulate_vector_score(
            &q,
            (42, chunk, 2, blob),
            &mut scored,
            &mut vector_scored,
        );
        assert_eq!(scored.get(&42).unwrap().0, after_first);
    }

    /// 池只是加速层：同样的查询必须得到与 SQL 路径一致的结果。
    #[test]
    fn pool_path_matches_sql_path() {
        use crate::index::init_schema;

        let conn = Connection::open_in_memory().unwrap();
        init_schema(&conn).unwrap();
        conn.execute(
            "INSERT INTO workspaces (root_hash, root_path, chunk_count) VALUES ('rh', '/tmp', 3)",
            [],
        )
        .unwrap();

        let texts = ["alpha parse config", "beta render view", "gamma parse config twice"];
        let vecs: [[f32; 3]; 3] = [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.9, 0.1, 0.0]];
        for (i, text) in texts.iter().enumerate() {
            let rel = format!("f{i}.rs");
            conn.execute(
                "INSERT INTO chunks (root_hash, rel_path, start_line, end_line, content, mtime)
                 VALUES ('rh', ?1, 1, 1, ?2, 0)",
                params![rel, text],
            )
            .unwrap();
            let id = conn.last_insert_rowid();
            conn.execute(
                "INSERT INTO chunks_fts (rowid, rel_path, content) VALUES (?1, ?2, ?3)",
                params![id, rel, text],
            )
            .unwrap();
            let blob = vector_to_blob(&vecs[i]);
            conn.execute(
                "INSERT INTO chunk_vectors (chunk_id, dims, vector) VALUES (?1, 3, ?2)",
                params![id, blob],
            )
            .unwrap();
        }

        let q = [1.0f32, 0.0, 0.0];
        let sql_res = search(&conn, "rh", "parse config", Some(3), Some(&q), None).unwrap();
        let pool = VectorPool::load(&conn, "rh").unwrap().expect("pool");
        let pool_res = search(&conn, "rh", "parse config", Some(3), Some(&q), Some(&pool)).unwrap();

        let shape = |r: &SearchResult| {
            r.results
                .iter()
                .map(|h| (h.path.clone(), h.start_line, h.end_line))
                .collect::<Vec<_>>()
        };
        assert!(!sql_res.results.is_empty());
        assert_eq!(shape(&sql_res), shape(&pool_res), "池路径不得改变检索语义");
    }

    /// 命中行必须落在片段里——即使 chunk 很长，也不能被字符预算截掉。
    #[test]
    fn snippet_centers_on_hit_line() {
        let content: String = (1..=40).map(|i| format!("line {i}\n")).collect();
        let content = content.trim_end();
        let start_line = 100;
        // chunk 起始 100 行，命中落在第 30 行 → 绝对行号 129
        let out = snippet(content, start_line, Some(129));
        assert!(out.contains("129| line 30"), "命中行必须在片段内: {out}");
        // 命中行之前保留 SNIPPET_PRE_LINES 行上下文
        assert!(out.contains("121| line 22"), "命中前应保留上下文: {out}");
        assert!(!out.contains("120| line 21"), "不应从更早的位置开始: {out}");
    }

    /// 超长单行（压缩产物等）必须先逐行截断，否则首行就吃光字符预算，整块只剩提示。
    #[test]
    fn snippet_truncates_very_long_line() {
        let long = "x".repeat(20_000);
        let content = format!("head\n{long}\ntail");
        let out = snippet(&content, 1, Some(1));
        assert!(out.contains("    1| head"), "首行必须在片段内");
        assert!(out.contains('…'), "超长行应被截断");
        assert!(
            out.len() < SNIPPET_MAX_CHARS + 200,
            "片段不能被单行撑爆: {}",
            out.len()
        );
    }
}

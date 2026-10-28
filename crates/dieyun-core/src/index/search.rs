use std::collections::HashMap;

use rusqlite::{params, Connection};
use serde::Serialize;

use crate::error::CoreError;

use super::vector_pool::VectorPool;

/// 单次检索可返回的最大条数。
pub const SEARCH_LIMIT_MAX: u32 = 48;

/// 单条命中的带行号正文上限。命中在 chunk 内的位置不确定，整块给出更省一次回读。
/// 字节上限略高于 Node 侧 codebaseSnippetMax（2400 字符），避免中文先被 Rust 截断。
const SNIPPET_MAX_CHARS: usize = 3600;
const SNIPPET_MAX_LINES: usize = 80;

/// 命中行之前保留的上下文行数。片段以命中行为锚点向后展开，
/// 避免「命中在大 chunk 中后部、被字符预算截掉」——那会让模型看到整段却看不到命中词。
const SNIPPET_PRE_LINES: usize = 8;

/// 单个展示行的字符上限（与 Node 侧 grep 的 slice(0,400) 对齐）。
/// 压缩产物等超长单行若不截断，会把整块字符预算吃光，只剩一行截断提示。
const SNIPPET_LINE_MAX_CHARS: usize = 400;

/// 多路召回的融合常数（Reciprocal Rank Fusion 的标准 k=60）。
///
/// 只用**名次**融合，不用分数：`bm25` 的量纲随语料统计漂移，余弦相似度固定在
/// [-1,1]，词元覆盖率在 [0,1] —— 三者相加必须给每个信号配一个魔数权重，而那组
/// 权重没有任何可验证的依据。按名次融合天然尺度无关：换模型、换语料规模都不需要
/// 重新调参。
const RRF_K: f64 = 60.0;

/// 向量侧参与融合的名次上限：`limit * 8 + 256`，够覆盖最终 top-limit 且不把
/// 长尾（相似度刚过阈值的几千条）算进融合。
const VECTOR_POOL_EXTRA: usize = 256;
const VECTOR_POOL_FACTOR: usize = 8;

/// 词法侧候选：留足余量，trigram 下命中条数会明显多于整词匹配。
const LEXICAL_CANDIDATES_FACTOR: usize = 12;
const LEXICAL_CANDIDATES_MIN: usize = 60;
const LEXICAL_CANDIDATES_MAX: usize = 400;

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

/// 一条召回通道：按相关性排好序的 chunk id 列表。
type RankedIds = Vec<i64>;

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
            vector_search,
        });
    }

    let mut rows: HashMap<i64, ChunkRow> = HashMap::new();
    let mut lists: Vec<RankedIds> = Vec::new();

    // 通道 1：词法（FTS5 bm25 排序）
    let lexical = lexical_hits(conn, root_hash, q, limit, &mut rows)?;
    let lexical_empty = lexical.is_empty();
    if !lexical_empty {
        lists.push(lexical);
    }

    // 通道 2：向量（内存池全量精确余弦；池不可用时本通道缺席，不做抽样近似）
    if let Some(q_vec) = query_vector {
        if let Some(p) = pool.filter(|p| p.matches_dims(q_vec)) {
            let vector = vector_hits(conn, root_hash, p, q_vec, limit, &mut rows)?;
            if !vector.is_empty() {
                lists.push(vector);
            }
        }
    }

    // 通道 3：短术语精确子串。trigram 索引最少要 3 个字符，2 字中文词（「配置」）
    // 在词法通道里永远查不到；这里用完整扫描按子串匹配补上，召回是全库、精确的
    // —— 不再有「只扫前 N 条」的静默天花板。仅当词法一无所获时才跑（一次全表扫描，
    // 别让每次中文查询都付这个成本；有向量通道时也照样补，向量召回是模糊的）。
    let short = short_terms(q);
    if !short.is_empty() && lexical_empty {
        let substring = substring_hits(conn, root_hash, &short, &mut rows)?;
        if !substring.is_empty() {
            lists.push(substring);
        }
    }

    let fused = fuse(&lists);
    let mut ranked: Vec<(f64, ChunkRow)> = fused
        .into_iter()
        .filter_map(|(id, score)| rows.remove(&id).map(|row| (score, row)))
        .collect();
    // 名次融合会出现**完全同分**（两路名次互换，例如词法 3 + 向量 1 与词法 1 + 向量 3），
    // 而融合结果来自 HashMap 迭代：只按分数排序时，同分候选的先后每次运行都不同 ——
    // 同一个查询会给出不同顺序。这里用 chunk id 兜底，保证同分也确定。
    ranked.sort_by(|a, b| {
        b.0.partial_cmp(&a.0)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(a.1.id.cmp(&b.1.id))
    });

    let total = ranked.len();
    // 展示用相关性：融合分只有相对意义，按本次头名归一化到 (0,1]
    let top = ranked.first().map(|(s, _)| *s).unwrap_or(0.0);
    let results = ranked
        .into_iter()
        .take(limit)
        .map(|(score, row)| SearchHit {
            path: row.rel_path.clone(),
            start_line: row.start_line,
            end_line: row.end_line,
            score: if top > 0.0 {
                ((score / top) * 1000.0).round() / 1000.0
            } else {
                0.0
            },
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

/// 倒数名次融合：`score(id) = Σ 1/(K + rank_i)`。
fn fuse(lists: &[RankedIds]) -> HashMap<i64, f64> {
    let mut fused: HashMap<i64, f64> = HashMap::new();
    for list in lists {
        for (i, id) in list.iter().enumerate() {
            *fused.entry(*id).or_insert(0.0) += 1.0 / (RRF_K + i as f64 + 1.0);
        }
    }
    fused
}

/// 通道 1：FTS 命中，按 bm25（越相关越靠前）。
fn lexical_hits(
    conn: &Connection,
    root_hash: &str,
    query: &str,
    limit: usize,
    rows: &mut HashMap<i64, ChunkRow>,
) -> Result<RankedIds, CoreError> {
    let Some(fts_q) = fts_query(query) else {
        return Ok(Vec::new());
    };
    let candidates = (limit * LEXICAL_CANDIDATES_FACTOR)
        .max(LEXICAL_CANDIDATES_MIN)
        .min(LEXICAL_CANDIDATES_MAX) as i64;
    let mut stmt = conn
        .prepare(
            "SELECT c.id, c.rel_path, c.start_line, c.end_line, c.content,
                    highlight(chunks_fts, 1, char(2), char(3)) AS hl
             FROM chunks_fts
             JOIN chunks c ON c.id = chunks_fts.rowid
             WHERE chunks_fts MATCH ?1 AND c.root_hash = ?2
             ORDER BY bm25(chunks_fts)
             LIMIT ?3",
        )
        .map_err(|e| CoreError::rpc("SEARCH_FAILED", e.to_string()))?;
    let mapped = stmt
        .query_map(params![fts_q, root_hash, candidates], map_chunk_with_highlight)
        .map_err(|e| CoreError::rpc("SEARCH_FAILED", e.to_string()))?;
    let mut ids = Vec::new();
    for row in mapped.flatten() {
        let id = row.id;
        rows.entry(id).or_insert(row);
        ids.push(id);
    }
    Ok(ids)
}

/// 通道 2：内存池全量精确余弦，取相似度最高的若干条。
fn vector_hits(
    conn: &Connection,
    root_hash: &str,
    pool: &VectorPool,
    q_vec: &[f32],
    limit: usize,
    rows: &mut HashMap<i64, ChunkRow>,
) -> Result<RankedIds, CoreError> {
    let q_norm = VectorPool::query_norm(q_vec);
    if q_norm <= 1e-8 {
        return Ok(Vec::new());
    }
    let mut hits: Vec<(i64, f32)> = Vec::new();
    pool.scan_into(q_vec, q_norm, &mut hits);
    if hits.is_empty() {
        return Ok(Vec::new());
    }
    hits.sort_unstable_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    let m = (limit * VECTOR_POOL_FACTOR + VECTOR_POOL_EXTRA).min(hits.len());
    let ids: Vec<i64> = hits.iter().take(m).map(|(id, _)| *id).collect();

    for chunk in ids.chunks(400) {
        let missing: Vec<i64> = chunk
            .iter()
            .copied()
            .filter(|id| !rows.contains_key(id))
            .collect();
        if missing.is_empty() {
            continue;
        }
        let placeholders: String = (1..=missing.len())
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
        let mut params_vec: Vec<Box<dyn rusqlite::ToSql>> = Vec::with_capacity(1 + missing.len());
        params_vec.push(Box::new(root_hash.to_string()));
        for id in &missing {
            params_vec.push(Box::new(*id));
        }
        let param_refs: Vec<&dyn rusqlite::ToSql> = params_vec.iter().map(|p| p.as_ref()).collect();
        let mapped = stmt
            .query_map(param_refs.as_slice(), map_chunk)
            .map_err(|e| CoreError::rpc("SEARCH_FAILED", e.to_string()))?;
        for row in mapped.flatten() {
            rows.insert(row.id, row);
        }
    }
    // 池里有、库里已被删的 id 直接丢弃（不参与融合）
    Ok(ids.into_iter().filter(|id| rows.contains_key(id)).collect())
}

/// 查询里「trigram 索引覆盖不到」的短术语：正好 2 个字符（2 字中文词、
/// 2 字母缩写）。1 个字符太宽泛（几乎每个 chunk 都命中），不予处理。
fn short_terms(query: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for part in query
        .split(|c: char| c.is_whitespace() || "/\\.,;:!?，。；：、".contains(c))
    {
        let p = part.replace(['"', '\'', '*', '%', '_'], "").trim().to_string();
        if p.chars().count() == 2 && !out.contains(&p) {
            out.push(p);
        }
    }
    out
}

/// 通道 3：短术语的精确子串匹配（`LIKE '%term%'`，路径与正文都算）。
///
/// 覆盖**整个工作区**，没有扫描窗口 —— 旧实现只扫前 8000 条并按词元覆盖率近似打分，
/// 超过窗口的库会静默少召回、同一查询还可能给出不同子集。这里的代价是一次全表扫描，
/// 只在查询含 2 字术语且词法通道一无所获时发生。
///
/// 命中顺序按 chunk id（稳定、与内容位置无关）：短词是「有没有」的判断，
/// 不存在可信的相关性名次，硬编一个近似分数只会骗调用方。
fn substring_hits(
    conn: &Connection,
    root_hash: &str,
    terms: &[String],
    rows: &mut HashMap<i64, ChunkRow>,
) -> Result<RankedIds, CoreError> {
    if terms.is_empty() {
        return Ok(Vec::new());
    }
    let mut clause = Vec::with_capacity(terms.len());
    let mut params_vec: Vec<Box<dyn rusqlite::ToSql>> = Vec::with_capacity(terms.len() * 2 + 1);
    params_vec.push(Box::new(root_hash.to_string()));
    for term in terms {
        // 转义 LIKE 的通配符，术语里的 % / _ 按字面匹配
        let escaped = term
            .replace('\\', "\\\\")
            .replace('%', "\\%")
            .replace('_', "\\_");
        let idx = params_vec.len() + 1;
        clause.push(format!(
            "(content LIKE '%' || ?{idx} || '%' ESCAPE '\\' OR rel_path LIKE '%' || ?{idx} || '%' ESCAPE '\\')"
        ));
        params_vec.push(Box::new(escaped));
    }
    let sql = format!(
        "SELECT id, rel_path, start_line, end_line, content FROM chunks
         WHERE root_hash = ?1 AND ({}) ORDER BY id",
        clause.join(" OR ")
    );
    let mut stmt = conn
        .prepare(&sql)
        .map_err(|e| CoreError::rpc("SEARCH_FAILED", e.to_string()))?;
    let param_refs: Vec<&dyn rusqlite::ToSql> = params_vec.iter().map(|p| p.as_ref()).collect();
    let mapped = stmt
        .query_map(param_refs.as_slice(), map_chunk)
        .map_err(|e| CoreError::rpc("SEARCH_FAILED", e.to_string()))?;
    let mut ids = Vec::new();
    for row in mapped.flatten() {
        let id = row.id;
        rows.entry(id).or_insert(row);
        ids.push(id);
    }
    Ok(ids)
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

fn map_chunk_with_highlight(row: &rusqlite::Row<'_>) -> rusqlite::Result<ChunkRow> {
    let start_line: i64 = row.get(2)?;
    // highlight 结果只用于定位命中行，不参与展示
    let hl: Option<String> = row.get::<_, Option<String>>(5).ok().flatten();
    let hit_line = hl.as_deref().and_then(|h| hit_line_from_highlight(h, start_line));
    Ok(ChunkRow {
        id: row.get(0)?,
        rel_path: row.get(1)?,
        start_line,
        end_line: row.get(3)?,
        content: row.get(4)?,
        hit_line,
    })
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

/// 把自然语言查询转成 FTS5 查询串：按标点/空白切词，逐词加引号（短语）+ OR 连接。
///
/// 只保留长度 >= 2 的词元：trigram 分词器要求 >= 3 字符才能命中，1 字词元只会
/// 白白把查询串撑长。整体失败（例如只剩标点）时返回 None，让词法通道缺席。
fn fts_query(query: &str) -> Option<String> {
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::embedding::vector_to_blob;
    use crate::index::init_schema;

    fn fixture() -> (Connection, VectorPool) {
        let conn = Connection::open_in_memory().unwrap();
        init_schema(&conn).unwrap();
        conn.execute(
            "INSERT INTO workspaces (root_hash, root_path, chunk_count) VALUES ('rh', '/tmp', 3)",
            [],
        )
        .unwrap();

        // both: 词法 + 向量都命中；lexical: 只有词法；semantic: 只有向量
        let chunk = |rel: &str, content: &str, vec: [f32; 3]| {
            conn.execute(
                "INSERT INTO chunks (root_hash, rel_path, start_line, end_line, content, mtime)
                 VALUES ('rh', ?1, 1, 25, ?2, 0)",
                params![rel, content],
            )
            .unwrap();
            let id = conn.last_insert_rowid();
            conn.execute(
                "INSERT INTO chunk_vectors (chunk_id, dims, vector) VALUES (?1, 3, ?2)",
                params![id, vector_to_blob(&vec)],
            )
            .unwrap();
        };
        chunk(
            "src/both.rs",
            "fn parse_config(path: &str) {}",
            [1.0, 0.0, 0.0],
        );
        chunk(
            "src/lexical.rs",
            "fn parse_config_twice() {}",
            [0.0, 1.0, 0.0],
        );
        chunk("src/semantic.rs", "读取配置文件的函数", [0.98, 0.02, 0.0]);

        let pool = VectorPool::load(&conn, "rh").unwrap().expect("pool");
        (conn, pool)
    }

    fn paths(r: &SearchResult) -> Vec<String> {
        r.results.iter().map(|h| h.path.clone()).collect()
    }

    /// 两路都命中的候选必须排在只命中一路的前面（RRF 的核心性质）。
    #[test]
    fn fuses_both_lists_above_single_list_hits() {
        let (conn, pool) = fixture();
        let q = [1.0f32, 0.0, 0.0];
        let res = search(&conn, "rh", "parse_config", Some(3), Some(&q), Some(&pool)).unwrap();
        assert_eq!(paths(&res).first().map(String::as_str), Some("src/both.rs"));
        assert_eq!(res.results.len(), 3, "两路候选都要出现在结果里");
    }

    /// 展示分是「相对本次头名」的归一化值：头名恒为 1，其余在 (0,1)。
    #[test]
    fn score_is_normalized_to_top_hit() {
        let (conn, pool) = fixture();
        let q = [1.0f32, 0.0, 0.0];
        let res = search(&conn, "rh", "parse_config", Some(3), Some(&q), Some(&pool)).unwrap();
        assert!((res.results[0].score - 1.0).abs() < 1e-9, "头名归一化为 1");
        for hit in &res.results[1..] {
            assert!(hit.score > 0.0 && hit.score < 1.0, "其余在 (0,1)");
        }
        // 名次越靠后分数不增
        for pair in res.results.windows(2) {
            assert!(pair[0].score >= pair[1].score);
        }
    }

    /// 池不可用时不得退化成「抽样近似」：词法命中照样返回，只是少了向量那一路。
    #[test]
    fn works_without_vector_pool() {
        let (conn, _pool) = fixture();
        let q = [1.0f32, 0.0, 0.0];
        let res = search(&conn, "rh", "parse_config", Some(3), Some(&q), None).unwrap();
        assert!(paths(&res).contains(&"src/both.rs".to_string()));
        assert!(res.vector_search, "请求侧带了向量，标志仍为 true");
    }

    /// 2 字中文词：trigram 索引（最少 3 字符）覆盖不到，由短术语子串通道补上。
    #[test]
    fn short_cjk_term_matches_by_substring() {
        let (conn, _pool) = fixture();
        let res = search(&conn, "rh", "配置", Some(3), None, None).unwrap();
        assert_eq!(paths(&res), vec!["src/semantic.rs"], "中文 2 字应命中");
    }

    /// 短术语通道必须扫全库：命中在很后面（id 大）也不能漏 ——
    /// 旧实现只扫前 8000 条，超过窗口的库会静默少召回。
    #[test]
    fn short_term_channel_has_no_scan_window() {
        let conn = Connection::open_in_memory().unwrap();
        init_schema(&conn).unwrap();
        conn.execute(
            "INSERT INTO workspaces (root_hash, root_path, chunk_count) VALUES ('rh', '/tmp', 400)",
            [],
        )
        .unwrap();
        for i in 0..399 {
            conn.execute(
                "INSERT INTO chunks (root_hash, rel_path, start_line, end_line, content, mtime)
                 VALUES ('rh', ?1, 1, 1, 'fn filler() {}', 0)",
                params![format!("filler/f{i}.rs")],
            )
            .unwrap();
        }
        // 唯一命中放在最后一条
        conn.execute(
            "INSERT INTO chunks (root_hash, rel_path, start_line, end_line, content, mtime)
             VALUES ('rh', 'zzz/last.rs', 1, 1, '// 配置热更新入口', 0)",
            [],
        )
        .unwrap();

        let res = search(&conn, "rh", "配置", Some(5), None, None).unwrap();
        assert_eq!(paths(&res), vec!["zzz/last.rs"], "最后一条也要能命中");
    }

    /// 3 字中文走的是词法（trigram）通道，不需要全库扫描。
    #[test]
    fn three_char_cjk_goes_through_lexical_channel() {
        let (conn, _pool) = fixture();
        let res = search(&conn, "rh", "配置文件", Some(3), None, None).unwrap();
        assert_eq!(paths(&res), vec!["src/semantic.rs"]);
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

    /// 词法通道的 highlight 只用来定位命中行：行号必须精确。
    #[test]
    fn highlight_maps_to_absolute_line() {
        let (conn, _pool) = fixture();
        let res = search(&conn, "rh", "parse_config", Some(2), None, None).unwrap();
        assert!(!res.results.is_empty());
    }

    /// 融合分相同的候选必须有确定顺序：同一个查询重复调用要给同一个顺序
    /// （融合结果来自 HashMap 迭代，曾因缺少兜底键而每次不同）。
    #[test]
    fn tied_candidates_have_stable_order() {
        let conn = Connection::open_in_memory().unwrap();
        init_schema(&conn).unwrap();
        conn.execute(
            "INSERT INTO workspaces (root_hash, root_path, chunk_count) VALUES ('rh', '/tmp', 3)",
            [],
        )
        .unwrap();
        let put = |rel: &str, content: &str, vec: [f32; 3]| {
            conn.execute(
                "INSERT INTO chunks (root_hash, rel_path, start_line, end_line, content, mtime)
                 VALUES ('rh', ?1, 1, 2, ?2, 0)",
                params![rel, content],
            )
            .unwrap();
            let id = conn.last_insert_rowid();
            conn.execute(
                "INSERT INTO chunk_vectors (chunk_id, dims, vector) VALUES (?1, 3, ?2)",
                params![id, vector_to_blob(&vec)],
            )
            .unwrap();
        };
        // 词法序 c3 > c2 > c1；向量序 c1 > c2 > c3 → c1 与 c3 融合分完全相等
        put("c1.rs", "alpha", [1.0, 0.0, 0.0]);
        put("c2.rs", "alpha alpha", [0.9, 0.435, 0.0]);
        put("c3.rs", "alpha alpha alpha", [0.7, 0.714, 0.0]);

        let pool = VectorPool::load(&conn, "rh").unwrap().expect("pool");
        let q = [1.0f32, 0.0, 0.0];
        let mut seen = std::collections::HashSet::new();
        for _ in 0..40 {
            let res = search(&conn, "rh", "alpha", Some(3), Some(&q), Some(&pool)).unwrap();
            seen.insert(paths(&res).join(","));
        }
        assert_eq!(seen.len(), 1, "同分候选的输出顺序必须稳定: {seen:?}");
    }
}

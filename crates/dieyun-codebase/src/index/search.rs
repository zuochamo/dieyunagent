use std::collections::{HashMap, HashSet};

use rusqlite::{params, Connection};
use serde::Serialize;

use dieyun_base::error::CoreError;

use super::schema::table_exists;
use super::vector_pool::VectorPool;

/// 单次检索可返回的最大条数。
pub const SEARCH_LIMIT_MAX: u32 = 48;

/// 单条命中的带行号正文上限。命中在 chunk 内的位置不确定，整块给出更省一次回读。
///
/// 数值唯一来源 `src/agent/agent-shared.json` 的 `snippets.rustBudgetChars`，且必须**大于**
/// Node 的展示预算（`codebaseSnippetMaxChars`）—— 否则 Rust 先截断、Node 再也补不回来。
/// 历史上这里是「3600 字节」≈1200 汉字，比 Node 的 2400 字符更早截断，与注释意图相反。
fn snippet_max_chars() -> usize {
    dieyun_base::shared::shared().snippets.rust_budget_chars
}
const SNIPPET_MAX_LINES: usize = 80;

/// 命中行之前保留的上下文行数。片段以命中行为锚点向后展开，
/// 避免「命中在大 chunk 中后部、被字符预算截掉」——那会让模型看到整段却看不到命中词。
const SNIPPET_PRE_LINES: usize = 8;

/// 单个展示行的字符上限（与 Node 侧 grep 的 slice(0,400) 对齐）。
/// 压缩产物等超长单行若不截断，会把整块字符预算吃光，只剩一行截断提示。
const SNIPPET_LINE_MAX_CHARS: usize = 400;

/// 多路召回的融合常数（Reciprocal Rank Fusion 的标准 k=60）。
///
/// 只用**名次**融合，不用分数：子串命中数是整数计数、余弦相似度固定在 [-1,1]，
/// 两者相加必须给每个信号配一个魔数权重，而那组权重没有任何可验证的依据。
/// 按名次融合天然尺度无关：换模型、换语料规模都不需要重新调参。
///
/// **但名次会丢掉一个量级信号**：某条命中到底覆盖了查询的多少。实测（150 文件 / 54 题，
/// 见 `E:\_vec-ab\VECTOR-AB-REPORT.md` §五）里，查询本身就是源码原句时，纯子串通道
/// hit@1 = 100%，融合后掉到 83%（原句族）与 67%（去虚词族）：向量通道把正确第一名挤到 2–4。
/// 所以见 [`strong_evidence`]：**强证据不进投票，直接排在融合结果之前**。
/// 这不是给某一路配权重（那正是上面禁止的东西），而是「可验证的字面事实优先于名次投票」。
const RRF_K: f64 = 60.0;

/// 向量侧参与融合的名次上限：`limit * 8 + 256`，够覆盖最终 top-limit 且不把
/// 长尾（相似度刚过阈值的几千条）算进融合。
const VECTOR_POOL_EXTRA: usize = 256;
const VECTOR_POOL_FACTOR: usize = 8;

/// 词法（子串）侧候选：留足余量。按 `hits` 降序取前 N 条，截掉的都是命中词更少的。
const LEXICAL_CANDIDATES_FACTOR: usize = 12;
const LEXICAL_CANDIDATES_MIN: usize = 60;
const LEXICAL_CANDIDATES_MAX: usize = 400;

/// 定义点通道的候选上限：同名符号可能散落在多个文件（`get_user` 这种），
/// 但排在前面的几十条足够覆盖，再多只会把「只是提到这个名字」的块挤进融合。
const DEFINITION_CANDIDATES_MAX: usize = 24;

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
    // 强证据：可验证的字面事实，永远排在融合结果之前（见 strong_evidence 的说明）。
    let mut strong: Vec<i64> = Vec::new();

    // 通道 1：词法 = 子串扫描（路径 + 正文，`LIKE '%term%'`）。
    //
    // v4 起没有 FTS 倒排表：trigram 索引占库体 40% 却只换来「按 bm25 排名」，
    // 而排名这件事与 `grep` 工具重叠、且索引永远落后一轮增量（见
    // docs/INDEX-VALUE-REVIEW.md §R2）。这里改为直接扫 `chunks`：
    // 召回口径与 trigram 一致（子串命中），排序改用**命中词数**（可解释、无需魔数权重），
    // 并且一次 `LIKE` 覆盖任意长度的词 —— 2 字中文（trigram 的物理下限）也在内。
    // 代价是一次全表扫描：10k chunk 实测约 20ms（见文档 §2.2）。
    let terms = query_terms(q);
    // 通道 0：符号定义（结构索引的 `graph_symbols`，与 `chunks` 同一份 `index.sqlite`）。
    // 放在词法之前没有任何排序含义（RRF 只按名次求和），只是读起来「先结构、后词法、再向量」。
    if let Some(name) = identifier_query(q, &terms) {
        let defs = definition_hits(conn, root_hash, name, limit, &mut rows)?;
        if !defs.is_empty() {
            // 符号定义点就是「这个名字在这里被定义」的字面事实，连同名次一起进强证据。
            strong.extend(defs.iter().copied());
            lists.push(defs);
        }
    }
    if !terms.is_empty() {
        let lex = substring_hits(conn, root_hash, &terms, limit, &mut rows)?;
        if !lex.ids.is_empty() {
            strong.extend(lex.full_coverage.iter().copied());
            lists.push(lex.ids);
        }
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

    let fused = fuse(&lists);
    let strong: HashSet<i64> = strong.into_iter().collect();
    let bonus = strong_evidence_bonus(lists.len());
    let mut ranked: Vec<(f64, ChunkRow)> = fused
        .into_iter()
        .filter_map(|(id, score)| {
            let b = if strong.contains(&id) { bonus } else { 0.0 };
            rows.remove(&id).map(|row| (score + b, row))
        })
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

/// 强证据的固定加成：等于「所有通道的票都投给同一个候选」的上界 `n / (K+1)`。
///
/// 为什么取上界而不是某个体验值：任何**非**强证据候选的融合分都不可能超过它（每路最多贡献
/// `1/(K+1)`），而强证据候选自身的融合分 `> 0`，于是「强证据全部排在融合结果之前」严格成立，
/// 既不需要按语料规模调参，也不给某一路配权重；强证据之间仍按各自的融合分决先后
/// （符号定义点因为多一路投票，天然排在只是「读到了整句」的前面）。
///
/// 刻度影响：存在强证据时，归一化后强证据落在 (0.5, 1]、融合结果落在 (0, 0.5]。
/// `score` 本来就是「按本次头名归一化」的展示值，见 `SearchHit::score`。
fn strong_evidence_bonus(list_count: usize) -> f64 {
    list_count as f64 / (RRF_K + 1.0)
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

/// 把自然语言查询切成词元：按标点/空白切分，丢掉 1 字符词元（几乎每个 chunk 都命中，
/// 只会把预算烧光），去重后最多 12 个。
///
/// 只剥掉引号与通配星号（模型写 FTS 风格 `parse*` 时的残留）；
/// **下划线与百分号必须原样保留** —— `parse_config` 去掉下划线就变成 `parseconfig`，
/// 谁都不匹配（这是把旧 FTS 通道改写成子串通道时最容易踩的一脚）。
fn query_terms(query: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for part in query
        .split(|c: char| c.is_whitespace() || "/\\.,;:!?，。；：、".contains(c))
    {
        let p = part.replace(['"', '\'', '*'], "").trim().to_string();
        if p.chars().count() < 2 || out.contains(&p) {
            continue;
        }
        out.push(p);
        if out.len() >= 12 {
            break;
        }
    }
    out
}

/// 查询是否「就是一个标识符」：`parse_config` / `useEffect` / `_parse_ts` / `Store.save`。
///
/// 只有这种查询才有明确的「定义在哪」答案，也才值得去问符号表；自然语言问句没有定义点。
/// 刻意**不**用语言关键词表判断，只看形状（单一词元 + 标识符字符集）。
fn identifier_query<'a>(query: &str, terms: &'a [String]) -> Option<&'a str> {
    if terms.len() != 1 {
        return None;
    }
    let q = query.trim();
    // `parse_config file` 这种「一个词元 + 一些标点」的查询不走这里：词元与原串不一致时
    // 说明用户还说了别的，定义点未必是他要的东西。
    if q != terms[0] {
        return None;
    }
    let mut chars = q.chars();
    let first = chars.next()?;
    if !(first.is_alphabetic() || first == '_' || first == '$') {
        return None;
    }
    let len = q.chars().count();
    if !(3..=80).contains(&len) {
        return None;
    }
    if !q
        .chars()
        .all(|c| c.is_alphanumeric() || c == '_' || c == '$' || c == '.')
    {
        return None;
    }
    Some(terms[0].as_str())
}

/// 通道 0：符号定义 —— 结构索引已经知道「这个名字定义在哪个文件哪一行」，直接拿来当一路召回。
///
/// 为什么需要它：词法通道按**命中词数**排序，对 `_parse_ts` 这类查询，「某个文件里用过一次」
/// 与「定义它的那个文件」得分完全一样，只靠 chunk id 决胜负 —— 实测「找定义」MRR 0.63，
/// 还不如 `grep -rc | sort -rn` 的 0.84（`docs/INDEX-VALUE-REVIEW.md` §7.2）。
/// 定义点不需要给词法通道加权重，它是同一份库里另一张表已有的**事实**，按名次融合天然叠分。
///
/// 结构索引没建（整张 `graph_symbols` 表都不存在）或没索引过这个工作区时，这一路为空，
/// 行为与改造前完全一致 —— 不猜、不兜底。
fn definition_hits(
    conn: &Connection,
    root_hash: &str,
    name: &str,
    limit: usize,
    rows: &mut HashMap<i64, ChunkRow>,
) -> Result<RankedIds, CoreError> {
    if !table_exists(conn, "graph_symbols")? {
        return Ok(Vec::new());
    }
    let candidates = (limit * 4)
        .max(DEFINITION_CANDIDATES_MAX)
        .min(LEXICAL_CANDIDATES_MAX) as i64;
    // 定义行 → 覆盖该行的 chunk。`kind` 排序只是「同名符号挑哪个先」：
    // 可调用的定义（函数/方法）优先，其次类型，最后 trait/其他。
    let sql = "SELECT c.id, c.rel_path, c.start_line, c.end_line, c.content, g.start_line
         FROM graph_symbols g
         JOIN chunks c
           ON c.root_hash = g.root_hash
          AND c.rel_path = g.rel_path
          AND c.start_line <= g.start_line
          AND g.start_line <= c.end_line
        WHERE g.root_hash = ?1 AND (g.name = ?2 OR g.qualified_name = ?2)
        ORDER BY CASE g.kind
                   WHEN 'function' THEN 0
                   WHEN 'class' THEN 1
                   WHEN 'type' THEN 2
                   WHEN 'trait' THEN 2
                   ELSE 3
                 END,
                 g.rel_path,
                 g.start_line
        LIMIT ?3";
    let mut stmt = conn
        .prepare(sql)
        .map_err(|e| CoreError::rpc("SEARCH_FAILED", e.to_string()))?;
    let mapped = stmt
        .query_map(params![root_hash, name, candidates], |row| {
            let mut chunk = map_chunk(row)?;
            // 命中行 = 符号定义行，片段从定义处展开（而不是从 chunk 开头）
            chunk.hit_line = Some(row.get::<_, i64>(5)?);
            Ok(chunk)
        })
        .map_err(|e| CoreError::rpc("SEARCH_FAILED", e.to_string()))?;
    let mut ids: RankedIds = Vec::new();
    // 行映射失败必须显式报错（与词法通道同一口径）：静默丢行会让「索引读坏了」表现成「没有命中」
    for row in mapped {
        let row = row.map_err(|e| CoreError::rpc("SEARCH_FAILED", e.to_string()))?;
        let id = row.id;
        if ids.contains(&id) {
            continue; // 同文件同名符号（重载/多个绑定）落进同一个 chunk
        }
        rows.entry(id).or_insert(row);
        ids.push(id);
    }
    Ok(ids)
}

/// 通道 1：子串命中（`LIKE '%term%'`，路径与正文都算）。
/// 覆盖**整个工作区**，没有扫描窗口 —— 旧实现（v1）只扫前 8000 条并按词元覆盖率近似打分，
/// 超过窗口的库会静默少召回。这里的代价是一次全表扫描。
///
/// 排序用**命中词数**（`hits`：有几个查询词出现在该 chunk 里），同分按 chunk id：
/// 这是唯一一个「不需要给每路信号配魔数权重」又能表达相关性的信号。
/// 候选上限 `SUBSTRING_CANDIDATES_MAX` 只截长尾：`hits` 降序保证截掉的都是命中更少的。
/// 词法通道的召回结果。
struct LexicalHits {
    /// 按名次排好的 chunk id（`hits` 降序，同分按 id）。
    ids: RankedIds,
    /// `ids` 里**查询词元全部命中**（覆盖度 100%）的那些：强证据，见 [`strong_evidence_bonus`]。
    full_coverage: Vec<i64>,
}

fn substring_hits(
    conn: &Connection,
    root_hash: &str,
    terms: &[String],
    limit: usize,
    rows: &mut HashMap<i64, ChunkRow>,
) -> Result<LexicalHits, CoreError> {
    if terms.is_empty() {
        return Ok(LexicalHits {
            ids: Vec::new(),
            full_coverage: Vec::new(),
        });
    }
    let candidates = (limit * LEXICAL_CANDIDATES_FACTOR)
        .max(LEXICAL_CANDIDATES_MIN)
        .min(LEXICAL_CANDIDATES_MAX) as i64;
    // 两个分数必须分开（它们回答不同的问题）：
    // - `hits`：排序用，**路径命中算分**（文件名相关的块确实更可能是用户要找的）；
    // - `content_hits`：判「覆盖度 100%」用，**只数正文**。
    // 旧实现只有 `hits`，于是两头都错：正文全覆盖但路径也命中时 hits=2n≠n（强证据被静默丢），
    // 而只有文件名命中的块 hits=n（被当成强证据顶到第一）。
    let mut hit_exprs = Vec::with_capacity(terms.len());
    let mut content_exprs = Vec::with_capacity(terms.len());
    let mut params_vec: Vec<Box<dyn rusqlite::ToSql>> = Vec::with_capacity(terms.len() * 2 + 2);
    params_vec.push(Box::new(root_hash.to_string()));
    for term in terms {
        // 转义 LIKE 的通配符，术语里的 % / _ 按字面匹配
        let escaped = term
            .replace('\\', "\\\\")
            .replace('%', "\\%")
            .replace('_', "\\_");
        let idx = params_vec.len() + 1;
        hit_exprs.push(format!(
            "((content LIKE '%' || ?{idx} || '%' ESCAPE '\\') + (rel_path LIKE '%' || ?{idx} || '%' ESCAPE '\\'))"
        ));
        content_exprs.push(format!(
            "(content LIKE '%' || ?{idx} || '%' ESCAPE '\\')"
        ));
        params_vec.push(Box::new(escaped));
    }
    let limit_idx = params_vec.len() + 1;
    params_vec.push(Box::new(candidates));
    // 别名不能用在 WHERE 里，所以套一层子查询：内层算 hits，外层过滤 + 排序 + 限流。
    let sql = format!(
        "SELECT id, rel_path, start_line, end_line, content, hits, content_hits FROM (
            SELECT id, rel_path, start_line, end_line, content,
                   ({}) AS hits,
                   ({}) AS content_hits
            FROM chunks WHERE root_hash = ?1
         ) WHERE hits > 0 ORDER BY hits DESC, id LIMIT ?{limit_idx}",
        hit_exprs.join(" + "),
        content_exprs.join(" + ")
    );
    let mut stmt = conn
        .prepare(&sql)
        .map_err(|e| CoreError::rpc("SEARCH_FAILED", e.to_string()))?;
    let param_refs: Vec<&dyn rusqlite::ToSql> = params_vec.iter().map(|p| p.as_ref()).collect();
    let mapped = stmt
        .query_map(param_refs.as_slice(), |row| {
            let mut chunk = map_chunk(row)?;
            // 子串命中也知道命中行：取最早出现的位置，让 snippet 从命中行开始展开
            chunk.hit_line = first_hit_line(&chunk.content, chunk.start_line, terms);
            // 第 6 列 hits（含路径，排序用）、第 7 列 content_hits（只数正文，判覆盖度用）。
            let hits: i64 = row.get(5)?;
            let content_hits: i64 = row.get(6)?;
            Ok((chunk, hits, content_hits))
        })
        .map_err(|e| CoreError::rpc("SEARCH_FAILED", e.to_string()))?;
    let mut ids = Vec::new();
    let mut full_coverage = Vec::new();
    let all_terms = terms.len() as i64;
    // 行映射失败必须显式报错：静默 flatten 掉会让「查询语法写错」表现成「没有命中」
    for row in mapped {
        let (chunk, _hits, content_hits) =
            row.map_err(|e| CoreError::rpc("SEARCH_FAILED", e.to_string()))?;
        let id = chunk.id;
        rows.entry(id).or_insert(chunk);
        // 覆盖度只看**正文**：`content_hits` 的上限才是词元数（路径不算证据，
        // 文件名里有这两个词不等于这个块讲了这两件事）。
        if content_hits == all_terms {
            full_coverage.push(id);
        }
        ids.push(id);
    }
    Ok(LexicalHits { ids, full_coverage })
}

/// 命中行：内容里最早出现的任一查询词所在行（行号是相对文件的绝对行号）。
///
/// 位置判定只有一份实现（`fts::first_hit_byte`，大小写不敏感）。这里此前自己写了一遍
/// `content.find(term)`，与 `fts::first_hit_index`（摘录用）口径不同 —— 同一段正文的
/// 「摘录围绕的位置」与「命中行」会指向不同地方。
fn first_hit_line(content: &str, start_line: i64, terms: &[String]) -> Option<i64> {
    let byte = dieyun_base::fts::first_hit_byte(content, terms)?;
    Some(start_line + content[..byte].matches('\n').count() as i64)
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
    /// 词法（子串）命中的行号；仅向量命中时为 None
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
    // 预算按**字符**累计。旧实现用 `out.len() + piece.len()`（字节）与「字符」上限比较，
    // 于是中文正文实际只有约 1/3 的预算 —— 命中词常被提前截掉，与注释的意图正好相反。
    let budget_chars = snippet_max_chars();
    let mut used_chars = 0usize;
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
        let piece_chars = piece.chars().count();
        if used_chars + piece_chars > budget_chars {
            out.push_str("     …（本块后续内容已截断）\n");
            break;
        }
        used_chars += piece_chars;
        out.push_str(&piece);
    }
    out.trim_end().to_string()
}

#[cfg(test)]
#[path = "search_tests.rs"]
mod tests;

use std::collections::{HashMap, HashSet, VecDeque};

use rusqlite::{params, Connection};

use crate::embedding::{
    blob_to_vector, cosine_similarity, exact_scan_threshold, query_seed, sample_modulus_for,
};
use crate::error::CoreError;
use crate::graph::types::{
    CallGraphResult, CallSiteHit, ImpactResult, ImportEdge, ModuleDepsResult, SymbolHit,
    SymbolSearchResult,
};
use crate::index::vector_pool::VectorPool;

struct EdgeRow {
    from_path: String,
    to_path: Option<String>,
    spec: String,
    line: i64,
    external: bool,
}

pub fn module_deps(
    conn: &Connection,
    root_hash: &str,
    path: Option<&str>,
    depth: u32,
    indexed: bool,
) -> Result<ModuleDepsResult, CoreError> {
    let depth = depth.clamp(1, 8);
    let rows = load_import_edges(conn, root_hash)?;
    if rows.is_empty() {
        return Ok(ModuleDepsResult {
            ok: true,
            indexed,
            path: path.map(|s| s.to_string()),
            dependencies: vec![],
            dependents: vec![],
            circular: vec![],
        });
    }

    let circular = find_import_cycles(&rows);
    let start = path.map(normalize_path_key).filter(|p| !p.is_empty());

    let dependencies = if let Some(ref from) = start {
        collect_import_dependencies(&rows, from, depth)
    } else {
        rows.iter().map(row_to_import_edge).collect()
    };

    let dependents = if let Some(ref to) = start {
        rows.iter()
            .filter(|r| r.to_path.as_deref() == Some(to.as_str()))
            .map(row_to_import_edge)
            .collect()
    } else {
        vec![]
    };

    Ok(ModuleDepsResult {
        ok: true,
        indexed,
        path: start,
        dependencies,
        dependents,
        circular,
    })
}

pub fn symbol_search(
    conn: &Connection,
    root_hash: &str,
    query: &str,
    kind: Option<&str>,
    limit: u32,
    indexed: bool,
) -> Result<SymbolSearchResult, CoreError> {
    let q = query.trim();
    let limit = limit.clamp(1, 80) as i64;
    if q.is_empty() {
        return Ok(SymbolSearchResult {
            ok: true,
            indexed,
            query: String::new(),
            results: vec![],
            needs_embed: None,
            vector_search: false,
        });
    }
    let q_lower = q.to_lowercase();
    // 用 INSTR 而不是 LIKE：免去通配符转义，并且能直接用于相关度排序。
    // 排序档位：名称精确 > 名称前缀 > 名称包含 > 仅限定名命中；同档短名优先（更可能是本体）。
    let sql = if kind.map(|k| !k.is_empty()).unwrap_or(false) {
        "SELECT id, rel_path, kind, name, qualified_name, start_line, end_line
         FROM graph_symbols
         WHERE root_hash = ?1 AND kind = ?2
           AND (INSTR(LOWER(name), ?3) > 0 OR INSTR(LOWER(qualified_name), ?3) > 0)
         ORDER BY
           CASE
             WHEN LOWER(name) = ?3 THEN 0
             WHEN INSTR(LOWER(name), ?3) = 1 THEN 1
             ELSE 2
           END,
           LENGTH(name), name, rel_path
         LIMIT ?4"
    } else {
        "SELECT id, rel_path, kind, name, qualified_name, start_line, end_line
         FROM graph_symbols
         WHERE root_hash = ?1
           AND (INSTR(LOWER(name), ?2) > 0 OR INSTR(LOWER(qualified_name), ?2) > 0)
         ORDER BY
           CASE
             WHEN LOWER(name) = ?2 THEN 0
             WHEN INSTR(LOWER(name), ?2) = 1 THEN 1
             ELSE 2
           END,
           LENGTH(name), name, rel_path
         LIMIT ?3"
    };
    let mut stmt = conn
        .prepare(sql)
        .map_err(|e| CoreError::rpc("GRAPH_QUERY_FAILED", e.to_string()))?;
    let rows = if let Some(k) = kind.filter(|k| !k.is_empty()) {
        stmt.query_map(params![root_hash, k, q_lower, limit], map_symbol_hit)
    } else {
        stmt.query_map(params![root_hash, q_lower, limit], map_symbol_hit)
    }
    .map_err(|e| CoreError::rpc("GRAPH_QUERY_FAILED", e.to_string()))?;
    Ok(SymbolSearchResult {
        ok: true,
        indexed,
        query: q.to_string(),
        results: rows.filter_map(|r| r.ok()).collect(),
        needs_embed: None,
        vector_search: false,
    })
}

pub fn symbol_semantic_search(
    conn: &Connection,
    root_hash: &str,
    query: &str,
    kind: Option<&str>,
    limit: u32,
    indexed: bool,
    symbol_vector_count: i64,
    query_vector: Option<&[f32]>,
    pool: Option<&VectorPool>,
) -> Result<SymbolSearchResult, CoreError> {
    let q = query.trim();
    if q.is_empty() {
        return Ok(SymbolSearchResult {
            ok: true,
            indexed,
            query: String::new(),
            results: vec![],
            needs_embed: None,
            vector_search: false,
        });
    }

    let can_vector = symbol_vector_count > 0 && query_vector.is_some();
    if !can_vector {
        let mut result = symbol_search(conn, root_hash, q, kind, limit, indexed)?;
        if symbol_vector_count == 0 && indexed {
            let symbol_count: i64 = conn
                .query_row(
                    "SELECT symbol_count FROM graph_workspaces WHERE root_hash = ?1",
                    params![root_hash],
                    |r| r.get(0),
                )
                .unwrap_or(0);
            if symbol_count > 0 {
                result.needs_embed = Some(true);
            }
        }
        return Ok(result);
    }

    let q_vec = query_vector.unwrap();
    let q_lower = q.to_lowercase();
    let limit = limit.clamp(1, 80) as usize;
    let kind_filter = kind.filter(|k| !k.is_empty());

    let mut ranked: Vec<(f64, SymbolHit)> = Vec::new();
    if let Some(p) = pool.filter(|p| p.matches_dims(q_vec)) {
        // 内存池命中：全量精确余弦 + 名称加成，不做抽样
        symbol_scores_from_pool(
            conn,
            root_hash,
            p,
            q_vec,
            &q_lower,
            kind_filter,
            limit,
            &mut ranked,
        )?;
    } else {
        // 符号向量维度同样由模型决定（768 / 4096 并存），阈值按字节预算换算
        let symbol_dims: i64 = conn
            .query_row(
                "SELECT v.dims FROM graph_symbol_vectors v
                 JOIN graph_symbols s ON s.id = v.symbol_id
                 WHERE s.root_hash = ?1 LIMIT 1",
                params![root_hash],
                |r| r.get(0),
            )
            .unwrap_or(0);

        if symbol_vector_count <= exact_scan_threshold(symbol_dims) {
            score_symbol_vectors(
                conn,
                root_hash,
                kind_filter,
                None,
                None,
                q_vec,
                &q_lower,
                &mut ranked,
            )?;
        } else {
            // Prefer symbols whose name already matches the query (lexical anchors).
            // Skip when the LIKE pattern would be "%" (matches everything).
            let like_body = q.replace(['%', '_'], "");
            if !like_body.is_empty() {
                let like = format!("%{like_body}%");
                let lexical_sql = if kind_filter.is_some() {
                    "SELECT s.id, s.rel_path, s.kind, s.name, s.qualified_name, s.start_line, s.end_line,
                            v.dims, v.vector
                     FROM graph_symbol_vectors v
                     JOIN graph_symbols s ON s.id = v.symbol_id
                     WHERE s.root_hash = ?1 AND s.kind = ?2
                       AND (LOWER(s.name) LIKE LOWER(?3) OR LOWER(s.qualified_name) LIKE LOWER(?3))
                     LIMIT 200"
                } else {
                    "SELECT s.id, s.rel_path, s.kind, s.name, s.qualified_name, s.start_line, s.end_line,
                            v.dims, v.vector
                     FROM graph_symbol_vectors v
                     JOIN graph_symbols s ON s.id = v.symbol_id
                     WHERE s.root_hash = ?1
                       AND (LOWER(s.name) LIKE LOWER(?2) OR LOWER(s.qualified_name) LIKE LOWER(?2))
                     LIMIT 200"
                };
                let mut stmt = conn
                    .prepare(lexical_sql)
                    .map_err(|e| CoreError::rpc("GRAPH_QUERY_FAILED", e.to_string()))?;
                let rows = if let Some(k) = kind_filter {
                    stmt.query_map(params![root_hash, k, like], map_symbol_vector_row)
                } else {
                    stmt.query_map(params![root_hash, like], map_symbol_vector_row)
                }
                .map_err(|e| CoreError::rpc("GRAPH_QUERY_FAILED", e.to_string()))?;
                for row in rows.flatten() {
                    accumulate_symbol_vector_score(q_vec, &q_lower, row, &mut ranked);
                }
            }

            let modulus = sample_modulus_for(symbol_vector_count, symbol_dims);
            let residue = query_seed(q).rem_euclid(modulus);
            score_symbol_vectors(
                conn,
                root_hash,
                kind_filter,
                Some(modulus),
                Some(residue),
                q_vec,
                &q_lower,
                &mut ranked,
            )?;
        }
    }

    ranked.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
    let results = ranked.into_iter().take(limit).map(|(_, hit)| hit).collect();

    Ok(SymbolSearchResult {
        ok: true,
        indexed,
        query: q.to_string(),
        results,
        needs_embed: None,
        vector_search: true,
    })
}

/// 走内存符号向量池：与 SQL 路径同一套打分公式（余弦 + 名称加成），但向量分数
/// 来自常驻内存，且是**全量精确**而非抽样。
fn symbol_scores_from_pool(
    conn: &Connection,
    root_hash: &str,
    pool: &VectorPool,
    q_vec: &[f32],
    q_lower: &str,
    kind_filter: Option<&str>,
    limit: usize,
    ranked: &mut Vec<(f64, SymbolHit)>,
) -> Result<(), CoreError> {
    let q_norm = VectorPool::query_norm(q_vec);
    if q_norm <= 1e-8 {
        return Ok(());
    }
    let mut seen: HashSet<i64> = ranked.iter().map(|(_, h)| h.id).collect();

    let name_bonus = |name: &str| -> f64 {
        let lower = name.to_lowercase();
        if lower == q_lower {
            0.35
        } else if lower.contains(q_lower) {
            0.15
        } else {
            0.0
        }
    };

    // 1) 名称词法锚点：名字精确/包含匹配的符号即使余弦排名靠后也要保留
    let like_body = q_lower.replace(['%', '_'], "");
    if !like_body.is_empty() {
        let like = format!("%{like_body}%");
        let sql = if kind_filter.is_some() {
            "SELECT id, rel_path, kind, name, qualified_name, start_line, end_line
             FROM graph_symbols
             WHERE root_hash = ?1 AND kind = ?2
               AND (LOWER(name) LIKE LOWER(?3) OR LOWER(qualified_name) LIKE LOWER(?3))
             LIMIT 200"
        } else {
            "SELECT id, rel_path, kind, name, qualified_name, start_line, end_line
             FROM graph_symbols
             WHERE root_hash = ?1
               AND (LOWER(name) LIKE LOWER(?2) OR LOWER(qualified_name) LIKE LOWER(?2))
             LIMIT 200"
        };
        let mut stmt = conn
            .prepare(sql)
            .map_err(|e| CoreError::rpc("GRAPH_QUERY_FAILED", e.to_string()))?;
        let rows = if let Some(k) = kind_filter {
            stmt.query_map(params![root_hash, k, like], map_symbol_hit)
        } else {
            stmt.query_map(params![root_hash, like], map_symbol_hit)
        }
        .map_err(|e| CoreError::rpc("GRAPH_QUERY_FAILED", e.to_string()))?;
        for hit in rows.flatten() {
            if !seen.insert(hit.id) {
                continue;
            }
            let sim = pool.similarity_of(hit.id, q_vec, q_norm).unwrap_or(0.0);
            let score = sim + name_bonus(&hit.name);
            if score <= 0.05 {
                continue;
            }
            ranked.push((
                score,
                SymbolHit {
                    score: Some(score),
                    ..hit
                },
            ));
        }
    }

    // 2) 语义召回：池全量扫描后取前 M，补齐这些符号的元数据
    let mut hits: Vec<(i64, f32)> = Vec::new();
    pool.scan_into(q_vec, q_norm, &mut hits);
    if hits.is_empty() {
        return Ok(());
    }
    hits.sort_unstable_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    let m = (limit * 8 + 256).min(hits.len());
    let sim_of: HashMap<i64, f64> = hits.iter().take(m).map(|(id, s)| (*id, *s as f64)).collect();
    let need: Vec<i64> = sim_of
        .keys()
        .copied()
        .filter(|id| !seen.contains(id))
        .collect();
    if need.is_empty() {
        return Ok(());
    }

    for chunk in need.chunks(400) {
        let placeholders: String = (1..=chunk.len())
            .map(|i| format!("?{}", i + 1))
            .collect::<Vec<_>>()
            .join(",");
        let sql = format!(
            "SELECT id, rel_path, kind, name, qualified_name, start_line, end_line
             FROM graph_symbols WHERE root_hash = ?1 AND id IN ({placeholders})"
        );
        let mut stmt = conn
            .prepare(&sql)
            .map_err(|e| CoreError::rpc("GRAPH_QUERY_FAILED", e.to_string()))?;
        let mut params_vec: Vec<Box<dyn rusqlite::ToSql>> = Vec::with_capacity(1 + chunk.len());
        params_vec.push(Box::new(root_hash.to_string()));
        for id in chunk {
            params_vec.push(Box::new(*id));
        }
        let param_refs: Vec<&dyn rusqlite::ToSql> = params_vec.iter().map(|p| p.as_ref()).collect();
        let rows = stmt
            .query_map(param_refs.as_slice(), map_symbol_hit)
            .map_err(|e| CoreError::rpc("GRAPH_QUERY_FAILED", e.to_string()))?;
        for hit in rows.flatten() {
            // 池里没有 kind 信息，按 kind 过滤在这一步完成
            if let Some(k) = kind_filter {
                if hit.kind != k {
                    continue;
                }
            }
            if seen.contains(&hit.id) {
                continue;
            }
            let sim = sim_of.get(&hit.id).copied().unwrap_or(0.0);
            let score = sim + name_bonus(&hit.name);
            if score <= 0.05 {
                continue;
            }
            seen.insert(hit.id);
            ranked.push((
                score,
                SymbolHit {
                    score: Some(score),
                    ..hit
                },
            ));
        }
    }
    Ok(())
}

fn score_symbol_vectors(
    conn: &Connection,
    root_hash: &str,
    kind: Option<&str>,
    modulus: Option<i64>,
    residue: Option<i64>,
    q_vec: &[f32],
    q_lower: &str,
    ranked: &mut Vec<(f64, SymbolHit)>,
) -> Result<(), CoreError> {
    let has_kind = kind.map(|k| !k.is_empty()).unwrap_or(false);
    let has_mod = modulus.is_some();
    let sql = match (has_kind, has_mod) {
        (true, true) => {
            "SELECT s.id, s.rel_path, s.kind, s.name, s.qualified_name, s.start_line, s.end_line,
                    v.dims, v.vector
             FROM graph_symbol_vectors v
             JOIN graph_symbols s ON s.id = v.symbol_id
             WHERE s.root_hash = ?1 AND s.kind = ?2 AND (s.id % ?3) = ?4"
        }
        (true, false) => {
            "SELECT s.id, s.rel_path, s.kind, s.name, s.qualified_name, s.start_line, s.end_line,
                    v.dims, v.vector
             FROM graph_symbol_vectors v
             JOIN graph_symbols s ON s.id = v.symbol_id
             WHERE s.root_hash = ?1 AND s.kind = ?2"
        }
        (false, true) => {
            "SELECT s.id, s.rel_path, s.kind, s.name, s.qualified_name, s.start_line, s.end_line,
                    v.dims, v.vector
             FROM graph_symbol_vectors v
             JOIN graph_symbols s ON s.id = v.symbol_id
             WHERE s.root_hash = ?1 AND (s.id % ?2) = ?3"
        }
        (false, false) => {
            "SELECT s.id, s.rel_path, s.kind, s.name, s.qualified_name, s.start_line, s.end_line,
                    v.dims, v.vector
             FROM graph_symbol_vectors v
             JOIN graph_symbols s ON s.id = v.symbol_id
             WHERE s.root_hash = ?1"
        }
    };
    let mut stmt = conn
        .prepare(sql)
        .map_err(|e| CoreError::rpc("GRAPH_QUERY_FAILED", e.to_string()))?;
    let rows = match (kind.filter(|k| !k.is_empty()), modulus, residue) {
        (Some(k), Some(m), Some(r)) => {
            stmt.query_map(params![root_hash, k, m, r], map_symbol_vector_row)
        }
        (Some(k), None, None) => stmt.query_map(params![root_hash, k], map_symbol_vector_row),
        (None, Some(m), Some(r)) => {
            stmt.query_map(params![root_hash, m, r], map_symbol_vector_row)
        }
        _ => stmt.query_map(params![root_hash], map_symbol_vector_row),
    }
    .map_err(|e| CoreError::rpc("GRAPH_QUERY_FAILED", e.to_string()))?;
    for row in rows.flatten() {
        accumulate_symbol_vector_score(q_vec, q_lower, row, ranked);
    }
    Ok(())
}

fn accumulate_symbol_vector_score(
    q_vec: &[f32],
    q_lower: &str,
    row: (SymbolHit, i64, Vec<u8>),
    ranked: &mut Vec<(f64, SymbolHit)>,
) {
    let (hit, dims, blob) = row;
    let Some(vec) = blob_to_vector(&blob, dims as usize) else {
        return;
    };
    let mut score = cosine_similarity(q_vec, &vec);
    let name_lower = hit.name.to_lowercase();
    if name_lower == q_lower {
        score += 0.35;
    } else if name_lower.contains(q_lower) {
        score += 0.15;
    }
    if score <= 0.05 {
        return;
    }
    if ranked.iter().any(|(_, existing)| existing.id == hit.id) {
        return;
    }
    ranked.push((
        score,
        SymbolHit {
            score: Some(score),
            ..hit
        },
    ));
}

pub fn callers(
    conn: &Connection,
    root_hash: &str,
    symbol_id: Option<i64>,
    path: Option<&str>,
    name: Option<&str>,
    indexed: bool,
) -> Result<CallGraphResult, CoreError> {
    let symbol = resolve_symbol(conn, root_hash, symbol_id, path, name)?;
    let Some(sym) = symbol.clone() else {
        return Ok(CallGraphResult {
            ok: true,
            indexed,
            symbol: None,
            sites: vec![],
        });
    };
    let sites = load_call_sites(
        conn,
        "SELECT c.caller_path, s.name, c.callee_name, c.callee_symbol_id, c.line, c.confidence, cs.rel_path
         FROM graph_calls c
         JOIN graph_symbols s ON s.id = c.caller_symbol_id
         LEFT JOIN graph_symbols cs ON cs.id = c.callee_symbol_id
         WHERE c.root_hash = ?1 AND (c.callee_symbol_id = ?2 OR c.callee_name = ?3)",
        params![root_hash, sym.id, sym.name],
    )?;
    Ok(CallGraphResult {
        ok: true,
        indexed,
        symbol: Some(sym),
        sites,
    })
}

pub fn callees(
    conn: &Connection,
    root_hash: &str,
    symbol_id: Option<i64>,
    path: Option<&str>,
    name: Option<&str>,
    indexed: bool,
) -> Result<CallGraphResult, CoreError> {
    let symbol = resolve_symbol(conn, root_hash, symbol_id, path, name)?;
    let Some(sym) = symbol.clone() else {
        return Ok(CallGraphResult {
            ok: true,
            indexed,
            symbol: None,
            sites: vec![],
        });
    };
    let sites = load_call_sites(
        conn,
        "SELECT c.caller_path, s.name, c.callee_name, c.callee_symbol_id, c.line, c.confidence, cs.rel_path
         FROM graph_calls c
         JOIN graph_symbols s ON s.id = c.caller_symbol_id
         LEFT JOIN graph_symbols cs ON cs.id = c.callee_symbol_id
         WHERE c.root_hash = ?1 AND c.caller_symbol_id = ?2",
        params![root_hash, sym.id],
    )?;
    Ok(CallGraphResult {
        ok: true,
        indexed,
        symbol: Some(sym),
        sites,
    })
}

pub fn impact(
    conn: &Connection,
    root_hash: &str,
    path: &str,
    depth: u32,
    indexed: bool,
) -> Result<ImpactResult, CoreError> {
    let depth = depth.clamp(1, 12);
    let start = normalize_path_key(path);
    let rows = load_import_edges(conn, root_hash)?;
    let mut reverse: HashMap<String, Vec<String>> = HashMap::new();
    for row in &rows {
        if let Some(ref to) = row.to_path {
            reverse
                .entry(to.clone())
                .or_default()
                .push(row.from_path.clone());
        }
    }
    let mut affected = Vec::new();
    let mut seen = HashSet::new();
    let mut queue = VecDeque::from([(start.clone(), 0u32)]);
    while let Some((node, level)) = queue.pop_front() {
        if level >= depth {
            continue;
        }
        let Some(nexts) = reverse.get(&node) else {
            continue;
        };
        for next in nexts {
            if seen.insert(next.clone()) {
                affected.push(next.clone());
                queue.push_back((next.clone(), level + 1));
            }
        }
    }
    affected.sort();
    Ok(ImpactResult {
        ok: true,
        indexed,
        path: start,
        affected_files: affected,
        depth,
    })
}

fn resolve_symbol(
    conn: &Connection,
    root_hash: &str,
    symbol_id: Option<i64>,
    path: Option<&str>,
    name: Option<&str>,
) -> Result<Option<SymbolHit>, CoreError> {
    if let Some(id) = symbol_id {
        return conn
            .query_row(
                "SELECT id, rel_path, kind, name, qualified_name, start_line, end_line
                 FROM graph_symbols WHERE root_hash = ?1 AND id = ?2",
                params![root_hash, id],
                map_symbol_hit,
            )
            .optional()
            .map_err(|e| CoreError::rpc("GRAPH_QUERY_FAILED", e.to_string()));
    }
    let path = path.map(normalize_path_key).filter(|p| !p.is_empty());
    let name = name.map(|s| s.trim()).filter(|s| !s.is_empty());
    match (path, name) {
        (Some(p), Some(n)) => conn
            .query_row(
                "SELECT id, rel_path, kind, name, qualified_name, start_line, end_line
                 FROM graph_symbols WHERE root_hash = ?1 AND rel_path = ?2 AND name = ?3
                 ORDER BY start_line LIMIT 1",
                params![root_hash, p, n],
                map_symbol_hit,
            )
            .optional()
            .map_err(|e| CoreError::rpc("GRAPH_QUERY_FAILED", e.to_string())),
        (None, Some(n)) => conn
            .query_row(
                "SELECT id, rel_path, kind, name, qualified_name, start_line, end_line
                 FROM graph_symbols WHERE root_hash = ?1 AND name = ?2
                 ORDER BY rel_path, start_line LIMIT 1",
                params![root_hash, n],
                map_symbol_hit,
            )
            .optional()
            .map_err(|e| CoreError::rpc("GRAPH_QUERY_FAILED", e.to_string())),
        _ => Ok(None),
    }
}

fn load_call_sites<P: rusqlite::Params>(
    conn: &Connection,
    sql: &str,
    params: P,
) -> Result<Vec<CallSiteHit>, CoreError> {
    let mut stmt = conn
        .prepare(sql)
        .map_err(|e| CoreError::rpc("GRAPH_QUERY_FAILED", e.to_string()))?;
    let rows = stmt
        .query_map(params, |r| {
            Ok(CallSiteHit {
                caller_path: r.get(0)?,
                caller_symbol: r.get(1)?,
                callee_name: r.get(2)?,
                callee_symbol_id: r.get(3)?,
                line: r.get(4)?,
                confidence: r.get(5)?,
                callee_path: r.get(6)?,
            })
        })
        .map_err(|e| CoreError::rpc("GRAPH_QUERY_FAILED", e.to_string()))?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

fn map_symbol_hit(row: &rusqlite::Row<'_>) -> rusqlite::Result<SymbolHit> {
    Ok(SymbolHit {
        id: row.get(0)?,
        path: row.get(1)?,
        kind: row.get(2)?,
        name: row.get(3)?,
        qualified_name: row.get(4)?,
        start_line: row.get(5)?,
        end_line: row.get(6)?,
        score: None,
    })
}

fn map_symbol_vector_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<(SymbolHit, i64, Vec<u8>)> {
    Ok((
        SymbolHit {
            id: row.get(0)?,
            path: row.get(1)?,
            kind: row.get(2)?,
            name: row.get(3)?,
            qualified_name: row.get(4)?,
            start_line: row.get(5)?,
            end_line: row.get(6)?,
            score: None,
        },
        row.get(7)?,
        row.get(8)?,
    ))
}

fn normalize_path_key(path: &str) -> String {
    path.replace('\\', "/").trim_start_matches("./").to_string()
}

fn load_import_edges(conn: &Connection, root_hash: &str) -> Result<Vec<EdgeRow>, CoreError> {
    let mut stmt = conn
        .prepare(
            "SELECT from_path, to_path, spec, line, external
             FROM graph_imports WHERE root_hash = ?1",
        )
        .map_err(|e| CoreError::rpc("GRAPH_QUERY_FAILED", e.to_string()))?;
    let rows = stmt
        .query_map(params![root_hash], |r| {
            Ok(EdgeRow {
                from_path: r.get(0)?,
                to_path: r.get(1)?,
                spec: r.get(2)?,
                line: r.get(3)?,
                external: r.get::<_, i64>(4)? != 0,
            })
        })
        .map_err(|e| CoreError::rpc("GRAPH_QUERY_FAILED", e.to_string()))?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

fn row_to_import_edge(row: &EdgeRow) -> ImportEdge {
    ImportEdge {
        from: row.from_path.clone(),
        to: row.to_path.clone(),
        spec: row.spec.clone(),
        line: row.line,
        external: row.external,
    }
}

fn collect_import_dependencies(rows: &[EdgeRow], start: &str, depth: u32) -> Vec<ImportEdge> {
    let mut adj: HashMap<String, Vec<&EdgeRow>> = HashMap::new();
    for row in rows {
        adj.entry(row.from_path.clone()).or_default().push(row);
    }
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    let mut queue = VecDeque::from([(start.to_string(), 0u32)]);
    while let Some((node, level)) = queue.pop_front() {
        if level >= depth {
            continue;
        }
        let Some(edges) = adj.get(&node) else {
            continue;
        };
        for row in edges {
            let key = format!("{}::{}::{}", row.from_path, row.spec, row.line);
            if !seen.insert(key) {
                continue;
            }
            out.push(row_to_import_edge(row));
            if let Some(ref to) = row.to_path {
                if level + 1 < depth {
                    queue.push_back((to.clone(), level + 1));
                }
            }
        }
    }
    out
}

fn find_import_cycles(rows: &[EdgeRow]) -> Vec<Vec<String>> {
    let mut adj: HashMap<String, Vec<String>> = HashMap::new();
    for row in rows {
        if let Some(ref to) = row.to_path {
            adj.entry(row.from_path.clone())
                .or_default()
                .push(to.clone());
        }
    }
    let mut cycles = Vec::new();
    let mut visiting = HashSet::new();
    let mut visited = HashSet::new();
    let mut stack = Vec::new();
    fn dfs(
        node: &str,
        adj: &HashMap<String, Vec<String>>,
        visiting: &mut HashSet<String>,
        visited: &mut HashSet<String>,
        stack: &mut Vec<String>,
        cycles: &mut Vec<Vec<String>>,
    ) {
        if visited.contains(node) {
            return;
        }
        if visiting.contains(node) {
            if let Some(pos) = stack.iter().position(|n| n == node) {
                let mut cycle = stack[pos..].to_vec();
                cycle.push(node.to_string());
                cycles.push(cycle);
            }
            return;
        }
        visiting.insert(node.to_string());
        stack.push(node.to_string());
        if let Some(nexts) = adj.get(node) {
            for next in nexts {
                dfs(next, adj, visiting, visited, stack, cycles);
            }
        }
        stack.pop();
        visiting.remove(node);
        visited.insert(node.to_string());
    }
    for node in adj.keys() {
        dfs(
            node,
            &adj,
            &mut visiting,
            &mut visited,
            &mut stack,
            &mut cycles,
        );
    }
    cycles
}

/// 压缩仓库地图：枢纽文件 + 关键符号 + 内部依赖边，供 Agent prep 注入。
pub fn repo_map(
    conn: &Connection,
    root_hash: &str,
    limit: u32,
    indexed: bool,
) -> Result<crate::graph::types::RepoMapResult, CoreError> {
    use crate::graph::types::{RepoMapEdgeHit, RepoMapFileHit, RepoMapHubSymbol, RepoMapResult};

    let limit = limit.clamp(8, 64) as i64;
    let file_limit = (limit / 2).clamp(8, 32);
    let edge_limit = limit.clamp(12, 48);

    let mut hub_files = Vec::new();
    {
        let mut stmt = conn
            .prepare(
                "SELECT rel_path, COUNT(*) AS n
                 FROM graph_symbols
                 WHERE root_hash = ?1
                 GROUP BY rel_path
                 ORDER BY n DESC, rel_path
                 LIMIT ?2",
            )
            .map_err(|e| CoreError::rpc("GRAPH_QUERY_FAILED", e.to_string()))?;
        let rows = stmt
            .query_map(params![root_hash, file_limit], |r| {
                Ok(RepoMapFileHit {
                    path: r.get::<_, String>(0)?,
                    symbol_count: r.get(1)?,
                })
            })
            .map_err(|e| CoreError::rpc("GRAPH_QUERY_FAILED", e.to_string()))?;
        for row in rows.flatten() {
            hub_files.push(row);
        }
    }

    let mut hub_symbols = Vec::new();
    {
        let mut stmt = conn
            .prepare(
                "SELECT s.id, s.rel_path, s.kind, s.name, s.qualified_name, s.start_line,
                        (
                          SELECT COUNT(*) FROM graph_calls c
                          WHERE c.root_hash = s.root_hash
                            AND (
                              c.callee_symbol_id = s.id
                              OR (c.callee_symbol_id IS NULL AND c.callee_name = s.name)
                            )
                        ) AS refs
                 FROM graph_symbols s
                 WHERE s.root_hash = ?1
                   AND s.kind IN (
                     'function','method','class','struct','interface','type','trait','enum','mod','module'
                   )
                 ORDER BY
                   CASE s.kind
                     WHEN 'class' THEN 0 WHEN 'struct' THEN 0 WHEN 'interface' THEN 1
                     WHEN 'trait' THEN 1 WHEN 'enum' THEN 2 WHEN 'type' THEN 2
                     WHEN 'mod' THEN 3 WHEN 'module' THEN 3
                     WHEN 'function' THEN 4 WHEN 'method' THEN 5 ELSE 6
                   END,
                   refs DESC,
                   s.name
                 LIMIT ?2",
            )
            .map_err(|e| CoreError::rpc("GRAPH_QUERY_FAILED", e.to_string()))?;
        let rows = stmt
            .query_map(params![root_hash, limit], |r| {
                Ok(RepoMapHubSymbol {
                    id: r.get(0)?,
                    path: r.get(1)?,
                    kind: r.get(2)?,
                    name: r.get(3)?,
                    qualified_name: r.get(4)?,
                    start_line: r.get(5)?,
                    call_refs: r.get(6)?,
                })
            })
            .map_err(|e| CoreError::rpc("GRAPH_QUERY_FAILED", e.to_string()))?;
        for row in rows.flatten() {
            hub_symbols.push(row);
        }
    }

    let mut edges = Vec::new();
    {
        let mut stmt = conn
            .prepare(
                "SELECT from_path, to_path
                 FROM graph_imports
                 WHERE root_hash = ?1 AND external = 0 AND to_path IS NOT NULL AND to_path != ''
                 ORDER BY from_path, to_path
                 LIMIT ?2",
            )
            .map_err(|e| CoreError::rpc("GRAPH_QUERY_FAILED", e.to_string()))?;
        let rows = stmt
            .query_map(params![root_hash, edge_limit], |r| {
                Ok(RepoMapEdgeHit {
                    from: r.get(0)?,
                    to: r.get::<_, String>(1)?,
                })
            })
            .map_err(|e| CoreError::rpc("GRAPH_QUERY_FAILED", e.to_string()))?;
        for row in rows.flatten() {
            edges.push(row);
        }
    }

    let circular = {
        let rows = load_import_edges(conn, root_hash)?;
        let mut cycles = find_import_cycles(&rows);
        cycles.truncate(6);
        for c in &mut cycles {
            if c.len() > 8 {
                c.truncate(8);
            }
        }
        cycles
    };

    let markdown = format_repo_map_markdown(&hub_files, &hub_symbols, &edges, &circular);

    Ok(RepoMapResult {
        ok: true,
        indexed,
        hub_files,
        hub_symbols,
        edges,
        circular,
        markdown,
    })
}

fn format_repo_map_markdown(
    hub_files: &[crate::graph::types::RepoMapFileHit],
    hub_symbols: &[crate::graph::types::RepoMapHubSymbol],
    edges: &[crate::graph::types::RepoMapEdgeHit],
    circular: &[Vec<String>],
) -> String {
    let mut lines = Vec::new();
    lines.push("【仓库结构图】".to_string());
    if !hub_files.is_empty() {
        lines.push("枢纽文件：".to_string());
        for f in hub_files.iter().take(16) {
            lines.push(format!("- {} ({} symbols)", f.path, f.symbol_count));
        }
    }
    if !hub_symbols.is_empty() {
        lines.push("关键符号：".to_string());
        for s in hub_symbols.iter().take(28) {
            let q = if s.qualified_name != s.name {
                format!(" ({})", s.qualified_name)
            } else {
                String::new()
            };
            let refs = if s.call_refs > 0 {
                format!(" refs={}", s.call_refs)
            } else {
                String::new()
            };
            lines.push(format!(
                "- [{}] {}{} @ {}:{}{}",
                s.kind, s.name, q, s.path, s.start_line, refs
            ));
        }
    }
    if !edges.is_empty() {
        lines.push("模块依赖（抽样）：".to_string());
        for e in edges.iter().take(24) {
            lines.push(format!("- {} → {}", e.from, e.to));
        }
    }
    if !circular.is_empty() {
        lines.push("循环依赖：".to_string());
        for c in circular.iter().take(4) {
            lines.push(format!("- {}", c.join(" → ")));
        }
    }
    if lines.len() <= 1 {
        lines.push("（结构索引暂无足够节点，可用 graph_symbol_search / codebase_search 继续查）".to_string());
    }
    lines.join("\n")
}

trait OptionalRow {
    fn optional(self) -> Result<Option<SymbolHit>, rusqlite::Error>;
}

impl OptionalRow for rusqlite::Result<SymbolHit> {
    fn optional(self) -> Result<Option<SymbolHit>, rusqlite::Error> {
        match self {
            Ok(v) => Ok(Some(v)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(e),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::graph::schema::init_graph_schema;

    fn test_conn() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        init_graph_schema(&conn).unwrap();
        conn.execute(
            "INSERT INTO graph_workspaces (root_hash, root_path) VALUES ('rh', '/tmp')",
            [],
        )
        .unwrap();
        conn
    }

    fn add_symbol(conn: &Connection, name: &str, vec: [f32; 2]) -> i64 {
        conn.execute(
            "INSERT INTO graph_symbols (root_hash, rel_path, kind, name, qualified_name,
                                        start_line, end_line, mtime)
             VALUES ('rh', 'src/a.js', 'function', ?1, ?2, 1, 3, 0)",
            params![name, format!("src/a.js::{name}")],
        )
        .unwrap();
        let id = conn.last_insert_rowid();
        conn.execute(
            "INSERT INTO graph_symbol_vectors (symbol_id, dims, vector, symbol_mtime)
             VALUES (?1, 2, ?2, 0)",
            params![id, crate::embedding::vector_to_blob(&vec)],
        )
        .unwrap();
        id
    }

    /// 符号池只是加速层：同样的查询必须与 SQL 路径结果一致。
    #[test]
    fn pool_path_matches_sql_path_for_symbols() {
        let conn = test_conn();
        let exact = add_symbol(&conn, "parseConfig", [1.0, 0.0]);
        add_symbol(&conn, "renderView", [0.0, 1.0]);
        let partial = add_symbol(&conn, "parse", [0.9, 0.1]);

        let q = [1.0f32, 0.0];
        let sql_res =
            symbol_semantic_search(&conn, "rh", "parseConfig", None, 5, true, 3, Some(&q), None)
                .unwrap();
        let pool = VectorPool::load_symbols(&conn, "rh").unwrap().expect("pool");
        let pool_res = symbol_semantic_search(
            &conn,
            "rh",
            "parseConfig",
            None,
            5,
            true,
            3,
            Some(&q),
            Some(&pool),
        )
        .unwrap();

        let ids = |r: &SymbolSearchResult| r.results.iter().map(|h| h.id).collect::<Vec<_>>();
        assert!(!sql_res.results.is_empty());
        assert_eq!(ids(&sql_res), ids(&pool_res), "符号池路径不得改变检索语义");
        assert_eq!(
            ids(&sql_res).first().copied(),
            Some(exact),
            "名称精确匹配应排第一"
        );
        assert!(ids(&sql_res).contains(&partial), "名称部分匹配应保留");
    }
}

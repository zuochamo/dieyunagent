use std::collections::{HashMap, HashSet, VecDeque};

use rusqlite::{params, Connection};

use crate::error::CoreError;
use crate::graph::types::{
    CallGraphResult, CallSiteHit, ImpactResult, ImportEdge, ModuleDepsResult, SymbolHit,
    SymbolSearchResult,
};

struct EdgeRow {
    from_path: String,
    to_path: Option<String>,
    spec: String,
    line: i64,
    external: bool,
}

/// 仓库地图只报前几条循环依赖（再多也塞不进注入预算）
const MAX_REPO_MAP_CYCLES: usize = 6;

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

    let circular = find_import_cycles(&rows, usize::MAX);
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
    })
}

/// 这个工作区建过调用边没有。
///
/// 调用边只在 `calls:true` 的建库范围内抽取（`build.rs`），而默认的结构索引**一份都没有** ——
/// 所以 `sites: []` 必须先分清是「真没人调用」还是「没建过」。这是唯一判据。
fn call_graph_built(conn: &Connection, root_hash: &str) -> bool {
    conn.query_row(
        "SELECT call_count FROM graph_workspaces WHERE root_hash = ?1",
        params![root_hash],
        |row| row.get::<_, i64>(0),
    )
    .map(|n| n > 0)
    .unwrap_or(false)
}

/// 「没建调用图」这句话只有一份写法，调用方直接透传给模型 / 面板。
fn call_graph_note(built: bool) -> Option<String> {
    if built {
        return None;
    }
    Some(
        "本工作区尚未建立调用图（默认只建结构索引）：本次结果不代表「没有调用方/被调用方」。\
         需要调用关系请先执行 graph.index.start{calls:true} 建一次。"
            .to_string(),
    )
}

pub fn callers(
    conn: &Connection,
    root_hash: &str,
    symbol_id: Option<i64>,
    path: Option<&str>,
    name: Option<&str>,
    indexed: bool,
) -> Result<CallGraphResult, CoreError> {
    let built = call_graph_built(conn, root_hash);
    let symbol = resolve_symbol(conn, root_hash, symbol_id, path, name)?;
    let Some(sym) = symbol.clone() else {
        // 符号已经不在库里（被改名 / 删除 / 还没索引到）：调用点本身可能还留在源码里。
        // 按裸名把**未解析**的调用点报出来（只认 `callee_symbol_id IS NULL`，解析到别处
        // 的同名调用不会混进来）——这就是「悬空引用」，改名后「谁还在调它」全靠它。
        // `symbol: null` 同时告诉调用方：这个名字在库里没有对应符号。
        let sites = match name {
            Some(n) if !n.is_empty() => load_call_sites(
                conn,
                "SELECT c.caller_path, s.name, c.callee_name, c.callee_symbol_id, c.line, c.confidence, cs.rel_path
                 FROM graph_calls c
                 JOIN graph_symbols s ON s.id = c.caller_symbol_id
                 LEFT JOIN graph_symbols cs ON cs.id = c.callee_symbol_id
                 WHERE c.root_hash = ?1
                   AND c.callee_symbol_id IS NULL
                   AND c.callee_name = ?2
                 ORDER BY c.caller_path, c.line",
                params![root_hash, n],
            )?,
            _ => Vec::new(),
        };
        return Ok(CallGraphResult {
            ok: true,
            indexed,
            call_graph_built: built,
            note: call_graph_note(built),
            symbol: None,
            sites,
        });
    };
    let sites = load_call_sites(
        conn,
        // 已解析的调用按**符号 id**认，未解析的才按裸名认。
        //
        // 原实现写成 `callee_symbol_id = ?2 OR callee_name = ?3`：一条已解析到别处
        // `render()` 的调用，会因为同名的 `render()` 也被算成它的调用者 —— 跨文件同名
        // 越常见，`callers` 越会把不相干的位置报给模型。名字只是「未解析行」的唯一证据，
        // 与 repo_map 的 refs_by_id / refs_by_name 是同一套口径。
        "SELECT c.caller_path, s.name, c.callee_name, c.callee_symbol_id, c.line, c.confidence, cs.rel_path
         FROM graph_calls c
         JOIN graph_symbols s ON s.id = c.caller_symbol_id
         LEFT JOIN graph_symbols cs ON cs.id = c.callee_symbol_id
         WHERE c.root_hash = ?1
           AND (c.callee_symbol_id = ?2
                OR (c.callee_symbol_id IS NULL AND c.callee_name = ?3))",
        params![root_hash, sym.id, sym.name],
    )?;
    Ok(CallGraphResult {
        ok: true,
        indexed,
        call_graph_built: built,
        note: call_graph_note(built),
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
    let built = call_graph_built(conn, root_hash);
    let symbol = resolve_symbol(conn, root_hash, symbol_id, path, name)?;
    let Some(sym) = symbol.clone() else {
        return Ok(CallGraphResult {
            ok: true,
            indexed,
            call_graph_built: built,
            note: call_graph_note(built),
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
        call_graph_built: built,
        note: call_graph_note(built),
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

/// 找导入环，最多记录 `limit` 个（`repo_map` 只要前几条，`module_deps` 要全量）。
///
/// 邻接表、访问集合与栈都借用 `rows` 里的 `&str`：原来每条边 clone 两个 String、
/// 每个节点入栈再 clone 一次，大仓库几十万次分配；枚举顺序与结果完全一致。
fn find_import_cycles(rows: &[EdgeRow], limit: usize) -> Vec<Vec<String>> {
    let mut adj: HashMap<&str, Vec<&str>> = HashMap::new();
    for row in rows {
        if let Some(ref to) = row.to_path {
            adj.entry(row.from_path.as_str())
                .or_default()
                .push(to.as_str());
        }
    }
    let mut cycles: Vec<Vec<String>> = Vec::new();
    let mut visiting: HashSet<&str> = HashSet::new();
    let mut visited: HashSet<&str> = HashSet::new();
    let mut stack: Vec<&str> = Vec::new();
    fn dfs<'a>(
        node: &'a str,
        adj: &HashMap<&'a str, Vec<&'a str>>,
        visiting: &mut HashSet<&'a str>,
        visited: &mut HashSet<&'a str>,
        stack: &mut Vec<&'a str>,
        cycles: &mut Vec<Vec<String>>,
        limit: usize,
    ) {
        if cycles.len() >= limit {
            return;
        }
        if visited.contains(node) {
            return;
        }
        if visiting.contains(node) {
            if let Some(pos) = stack.iter().position(|n| *n == node) {
                let mut cycle: Vec<String> = stack[pos..].iter().map(|n| (*n).to_string()).collect();
                cycle.push(node.to_string());
                cycles.push(cycle);
            }
            return;
        }
        visiting.insert(node);
        stack.push(node);
        if let Some(nexts) = adj.get(node) {
            for next in nexts {
                dfs(next, adj, visiting, visited, stack, cycles, limit);
                if cycles.len() >= limit {
                    break;
                }
            }
        }
        stack.pop();
        visiting.remove(node);
        visited.insert(node);
    }
    for node in adj.keys() {
        dfs(
            node,
            &adj,
            &mut visiting,
            &mut visited,
            &mut stack,
            &mut cycles,
            limit,
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
        // 引用数必须用**两次聚合 + LEFT JOIN**，不能写成「每符号一个相关子查询」。
        //
        // 相关子查询的 WHERE 里带 OR（callee_symbol_id = s.id OR callee_name = s.name），
        // 索引 idx_graph_calls_callee 只能吃到 root_hash 前缀，于是执行计划退化成
        // 「每个符号全扫一遍本工作区的全部 graph_calls」：O(符号数 × 调用数)。
        // 在真实工作区上（7742 符号 / 114377 调用）单符号 155ms ⇒ 整体约 20 分钟，
        // 而这段查询是在**常驻连接**（index / graph 共用那一把非重入锁）上跑的，
        // 期间所有 codebase.status / graph.status / codebase.index.start 全部排队，
        // 上层只能看到「Gateway RPC 超时: codebase.status (45s)」。
        //
        // 两次 GROUP BY 各扫一遍 graph_calls（走 root_hash 索引），与符号数无关：
        // 同一份数据实测 322ms。
        let mut stmt = conn
            .prepare(
                "WITH refs_by_id AS (
                   SELECT callee_symbol_id AS sid, COUNT(*) AS n
                   FROM graph_calls
                   WHERE root_hash = ?1 AND callee_symbol_id IS NOT NULL
                   GROUP BY callee_symbol_id
                 ),
                 refs_by_name AS (
                   SELECT callee_name AS nm, COUNT(*) AS n
                   FROM graph_calls
                   WHERE root_hash = ?1 AND callee_symbol_id IS NULL AND callee_name IS NOT NULL
                   GROUP BY callee_name
                 )
                 SELECT s.id, s.rel_path, s.kind, s.name, s.qualified_name, s.start_line,
                        COALESCE(rb.n, 0) + COALESCE(rn.n, 0) AS refs
                 FROM graph_symbols s
                 LEFT JOIN refs_by_id rb ON rb.sid = s.id
                 LEFT JOIN refs_by_name rn ON rn.nm = s.name
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
        // 只要前 6 条：原来先枚举全部环再 truncate，大仓库会先攒下成千上万条再丢掉
        let mut cycles = find_import_cycles(&rows, MAX_REPO_MAP_CYCLES);
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

    fn add_repo_symbol(conn: &Connection, name: &str, kind: &str) -> i64 {
        conn.execute(
            "INSERT INTO graph_symbols (root_hash, rel_path, kind, name, qualified_name,
                                        start_line, end_line, mtime)
             VALUES ('rh', 'src/a.js', ?1, ?2, ?3, 1, 3, 0)",
            params![kind, name, format!("src/a.js::{name}")],
        )
        .unwrap();
        conn.last_insert_rowid()
    }

    fn add_call(conn: &Connection, callee_name: &str, callee_symbol_id: Option<i64>) {
        conn.execute(
            "INSERT INTO graph_calls (root_hash, caller_symbol_id, caller_path, callee_name,
                                      callee_symbol_id, line)
             VALUES ('rh', 1, 'src/a.js', ?1, ?2, 1)",
            params![callee_name, callee_symbol_id],
        )
        .unwrap();
    }

    fn add_symbol_at(conn: &Connection, rel_path: &str, name: &str, kind: &str) -> i64 {
        conn.execute(
            "INSERT INTO graph_symbols (root_hash, rel_path, kind, name, qualified_name,
                                        start_line, end_line, mtime)
             VALUES ('rh', ?1, ?2, ?3, ?4, 1, 3, 0)",
            params![rel_path, kind, name, format!("{rel_path}::{name}")],
        )
        .unwrap();
        conn.last_insert_rowid()
    }

    /// 已解析的调用不得按裸名匹配到同名符号：`callers` 只报真调用点。
    #[test]
    fn callers_do_not_match_resolved_edges_by_bare_name() {
        let conn = test_conn();
        let _caller = add_symbol_at(&conn, "src/a.js", "caller", "function"); // id 1
        let render_a = add_symbol_at(&conn, "src/a.js", "render", "function");
        let render_b = add_symbol_at(&conn, "src/b.js", "render", "function");

        add_call(&conn, "render", Some(render_b)); // 已解析：指向 b 的 render
        add_call(&conn, "render", None); // 未解析：只有名字

        let a = callers(&conn, "rh", Some(render_a), None, None, true).unwrap();
        assert_eq!(
            a.sites.len(),
            1,
            "已解析到别的符号的调用，不能按同名算给 render_a：{:?}",
            a.sites.iter().map(|s| s.line).collect::<Vec<_>>()
        );
        let b = callers(&conn, "rh", Some(render_b), None, None, true).unwrap();
        assert_eq!(b.sites.len(), 2, "未解析调用按名归属同名符号，已解析的也要算");
    }

    /// 引用数 = 「按 id 命中」+「未解析 callee_symbol_id、按名字命中」，两者都要算。
    #[test]
    fn repo_map_counts_refs_by_symbol_id_and_by_name() {
        let conn = test_conn();
        let alpha = add_repo_symbol(&conn, "alpha", "function");
        add_repo_symbol(&conn, "beta", "method");
        let gamma = add_repo_symbol(&conn, "gamma", "class");
        add_repo_symbol(&conn, "localVar", "variable"); // 非枢纽 kind，不应出现

        add_call(&conn, "alpha", Some(alpha));
        add_call(&conn, "alpha", Some(alpha));
        add_call(&conn, "beta", None);
        add_call(&conn, "beta", None);
        add_call(&conn, "beta", None);
        add_call(&conn, "gamma", Some(gamma));
        add_call(&conn, "gamma", None);
        add_call(&conn, "unrelated", None);

        let map = repo_map(&conn, "rh", 32, true).unwrap();
        let refs = |name: &str| {
            map.hub_symbols
                .iter()
                .find(|s| s.name == name)
                .unwrap_or_else(|| panic!("缺少枢纽符号 {name}"))
                .call_refs
        };
        assert_eq!(refs("alpha"), 2, "按 id 命中的调用都要计入");
        assert_eq!(refs("beta"), 3, "未解析调用按名字计入");
        assert_eq!(refs("gamma"), 2, "id + 名字两种命中要相加");
        assert!(
            !map.hub_symbols.iter().any(|s| s.name == "localVar"),
            "非枢纽 kind 不应进仓库地图"
        );
    }

    /// 回归护栏：引用数不得是「每符号全扫 graph_calls」。
    ///
    /// 曾经的实现是相关子查询（WHERE 里带 OR，索引只用得上 root_hash 前缀），
    /// 复杂度 O(符号数 × 调用数)：真实工作区（7742 符号 / 114377 调用）要算约 20 分钟，
    /// 而它跑在 index / graph 共用的那条常驻连接上，于是期间所有 status 请求 45s 超时。
    /// 下面这组数据在旧实现上约 4 秒起步、且随规模继续线性放大；改写成两次聚合后是几十毫秒。
    #[test]
    fn repo_map_refs_scale_with_calls_not_symbols_times_calls() {
        let conn = test_conn();
        const SYMBOLS: usize = 600;
        const CALLS: usize = 40_000;
        {
            let tx = conn.unchecked_transaction().unwrap();
            for i in 0..SYMBOLS {
                add_repo_symbol(&tx, &format!("sym{i}"), "function");
            }
            for i in 0..CALLS {
                let callee = format!("sym{}", i % SYMBOLS);
                let resolved = if i % 3 == 0 { None } else { Some(((i % SYMBOLS) + 1) as i64) };
                add_call(&tx, &callee, resolved);
            }
            tx.commit().unwrap();
        }

        let started = std::time::Instant::now();
        let map = repo_map(&conn, "rh", 32, true).unwrap();
        let elapsed = started.elapsed();

        assert!(!map.hub_symbols.is_empty(), "应返回枢纽符号");
        assert!(
            map.hub_symbols.iter().any(|s| s.call_refs > 0),
            "引用数应被统计到"
        );
        assert!(
            elapsed < std::time::Duration::from_secs(2),
            "{SYMBOLS} 符号 × {CALLS} 调用的仓库地图耗时 {elapsed:?}，\
             说明引用数统计又退化成了 O(符号数 × 调用数)"
        );
    }

    fn edge(from: &str, to: Option<&str>) -> EdgeRow {
        EdgeRow {
            from_path: from.to_string(),
            to_path: to.map(|t| t.to_string()),
            spec: String::new(),
            line: 1,
            external: false,
        }
    }

    /// 环检测：成环必须报出来，且首尾同名；上限生效（repo_map 只要前几条）。
    #[test]
    fn find_import_cycles_reports_cycles_and_honors_limit() {
        // 两个不相交的环：a <-> b 与 c -> d -> c
        let rows = vec![
            edge("a.js", Some("b.js")),
            edge("b.js", Some("a.js")),
            edge("c.js", Some("d.js")),
            edge("d.js", Some("c.js")),
            edge("e.js", Some("a.js")), // 只有入边，不成环
            edge("f.js", None),         // 外部/未解析，不参与
        ];

        let all = find_import_cycles(&rows, usize::MAX);
        assert!(all.len() >= 2, "两个环都应报出来，实际 {:?}", all);
        for cycle in &all {
            assert!(cycle.len() >= 2, "环至少两个节点：{:?}", cycle);
            assert_eq!(cycle.first(), cycle.last(), "环必须首尾同名：{:?}", cycle);
        }

        let limited = find_import_cycles(&rows, 1);
        assert_eq!(limited.len(), 1, "limit=1 时只报一条");

        assert!(
            find_import_cycles(&[], usize::MAX).is_empty(),
            "空图不应报环"
        );
    }
}

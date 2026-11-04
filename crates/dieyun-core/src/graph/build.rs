use std::collections::{HashMap, HashSet};
use std::path::Path;

use rusqlite::{params, Connection};

use crate::error::CoreError;
use crate::graph::extract::files::{collect_graph_files, is_graph_path};
use crate::graph::extract::go::{
    extract_calls as extract_go_calls, extract_import_specs as extract_go_imports,
    extract_symbols as extract_go_symbols, is_go_path, is_relative_spec as is_go_relative_spec,
    resolve_go_import,
};
use crate::graph::extract::js_ts::{
    extract_import_specs as extract_js_imports, is_js_ts_path,
    resolve_relative_import as resolve_js_import,
};
use crate::graph::extract::python::{
    extract_calls as extract_py_calls, extract_import_specs as extract_py_imports,
    extract_symbols as extract_py_symbols, is_python_path, is_relative_spec as is_py_relative_spec,
    resolve_python_import,
};
use crate::graph::extract::rust_lang::{
    extract_calls as extract_rust_calls, extract_import_specs as extract_rust_imports,
    extract_symbols as extract_rust_symbols, is_external_spec as is_rust_external_spec,
    is_rust_path, resolve_rust_import,
};
use crate::graph::extract::symbols::{
    extract_calls as extract_js_calls, extract_symbols as extract_js_symbols,
};
use crate::index::RemoteFileInput;

const MAX_GRAPH_FILES: usize = 16_000;

#[derive(Debug)]
#[allow(dead_code)]
pub struct BuildStats {
    pub file_count: i64,
    pub edge_count: i64,
    pub symbol_count: i64,
    pub call_count: i64,
}

/// 建库范围（R5）：调用图是结构索引里唯一「贵且少用」的部分。
///
/// 实测 39 万条 `graph_calls` 占结构索引库体约 42%（33.8 MB / 81 MB），而
/// `callers`/`callees`/`impact` 三类工具在 7 天里合计 1 次调用。符号 + import +
/// mtime 是 `repo_map` 与 `find_symbol`/`module_deps` 的底座，必须常建；
/// 调用关系改为**按需**（第一次问到调用关系时再建一次）。
///
/// 只在「建库」这一层表达，不加配置项、不加第二个索引服务。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GraphScope {
    /// 符号 + import + mtime（repo_map / find_symbol / module_deps 够用）
    Structural,
    /// 结构 + 调用关系（callers / callees / impact 需要）
    WithCalls,
}

impl GraphScope {
    pub fn with_calls(self) -> bool {
        matches!(self, GraphScope::WithCalls)
    }
}


pub fn run_build_with_progress(
    conn: &Connection,
    root: &Path,
    root_hash: &str,
    force: bool,
    scope: GraphScope,
    on_progress: Option<&dyn Fn(&str, i64, i64, i64, i64, i64)>,
) -> Result<BuildStats, CoreError> {
    let report = |phase: &str, done: i64, total: i64, edges: i64, symbols: i64, calls: i64| {
        if let Some(cb) = on_progress {
            cb(phase, done, total, edges, symbols, calls);
        }
    };

    conn.execute(
        "INSERT INTO graph_workspaces (root_hash, root_path, indexing)
         VALUES (?1, ?2, 1)
         ON CONFLICT(root_hash) DO UPDATE SET indexing = 1, root_path = excluded.root_path",
        params![root_hash, root.to_string_lossy()],
    )
    .map_err(|e| CoreError::rpc("GRAPH_INDEX_FAILED", e.to_string()))?;

    report("walking", 0, 0, 0, 0, 0);

    if force {
        clear_workspace_graph(conn, root_hash)?;
    }

    let rel_files = collect_graph_files(root, MAX_GRAPH_FILES);
    let files_total = rel_files.len() as i64;
    report("parsing", 0, files_total, 0, 0, 0);
    let rel_set: HashSet<String> = rel_files.iter().cloned().collect();
    if force {
        purge_removed_files(conn, root_hash, &rel_set)?;
    } else {
        purge_stale_files(conn, root_hash, &rel_set)?;
    }

    let stored_mtimes = load_file_mtimes(conn, root_hash)?;
    let mut import_count = count_imports(conn, root_hash)?;
    let mut symbol_count = count_symbols(conn, root_hash)?;
    let mut call_count = count_calls(conn, root_hash)?;
    let mut files_done = 0i64;
    // 上次只建了结构（没有调用边）而这次要调用图：mtime 没变也必须重解析，
    // 否则「按需建调用图」永远抽不出任何东西（增量只处理变过的文件）。
    let calls_missing = scope.with_calls() && !force && call_count == 0;

    for rel in &rel_files {
        let abs = root.join(rel.replace('/', std::path::MAIN_SEPARATOR_STR));
        let meta = match std::fs::metadata(&abs) {
            Ok(m) => m,
            Err(_) => continue,
        };
        let mtime = crate::index::file_mtime_stamp(&meta);
        if !force {
            let unchanged = !calls_missing
                && stored_mtimes
                    .get(rel)
                    .copied()
                    .map(|prev| crate::index::mtime_unchanged(prev, mtime))
                    .unwrap_or(false);
            if unchanged {
                files_done += 1;
                if files_done == 1 || files_done % 16 == 0 || files_done == files_total {
                    report(
                        "parsing",
                        files_done,
                        files_total,
                        import_count,
                        symbol_count,
                        call_count,
                    );
                }
                continue;
            }
            let (di, ds, dc) = clear_file_graph(conn, root_hash, rel)?;
            // 用「删了多少行」推进度，不再三条全表 COUNT（见 clear_file_graph 注释）
            import_count -= di;
            symbol_count -= ds;
            call_count -= dc;
        }

        let text = match std::fs::read_to_string(&abs) {
            Ok(t) if !t.contains('\0') => t,
            _ => continue,
        };

        let (ic, sc, cc) = index_file(conn, root_hash, rel, &text, mtime, &rel_set, scope)?;
        import_count += ic;
        symbol_count += sc;
        call_count += cc;

        conn.execute(
            "INSERT INTO graph_file_mtime (root_hash, rel_path, mtime)
             VALUES (?1, ?2, ?3)
             ON CONFLICT(root_hash, rel_path) DO UPDATE SET mtime = excluded.mtime",
            params![root_hash, rel, mtime],
        )
        .map_err(|e| CoreError::rpc("GRAPH_INDEX_FAILED", e.to_string()))?;

        files_done += 1;
        if files_done == 1 || files_done % 16 == 0 || files_done == files_total {
            report(
                "parsing",
                files_done,
                files_total,
                import_count,
                symbol_count,
                call_count,
            );
        }
    }

    // 所有文件都入库后再回填「名字唯一」的解析目标（消除文件处理顺序的影响）
    if scope.with_calls() {
        backfill_unique_callees(conn, root_hash)?;
    }

    report(
        "finishing",
        files_done,
        files_total,
        import_count,
        symbol_count,
        call_count,
    );

    let indexed_at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);

    conn.execute(
        "UPDATE graph_workspaces
         SET file_count = ?2, edge_count = ?3, symbol_count = ?4, call_count = ?5,
             indexed_at = ?6, indexing = 0
         WHERE root_hash = ?1",
        params![
            root_hash,
            rel_files.len() as i64,
            import_count,
            symbol_count,
            call_count,
            indexed_at
        ],
    )
    .map_err(|e| CoreError::rpc("GRAPH_INDEX_FAILED", e.to_string()))?;

    Ok(BuildStats {
        file_count: rel_files.len() as i64,
        edge_count: import_count,
        symbol_count,
        call_count,
    })
}

pub fn run_remote_build(
    conn: &Connection,
    root_key: &str,
    root_hash: &str,
    files: &[RemoteFileInput],
    force: bool,
    scope: GraphScope,
) -> Result<BuildStats, CoreError> {
    conn.execute(
        "INSERT INTO graph_workspaces (root_hash, root_path, indexing)
         VALUES (?1, ?2, 1)
         ON CONFLICT(root_hash) DO UPDATE SET indexing = 1, root_path = excluded.root_path",
        params![root_hash, root_key],
    )
    .map_err(|e| CoreError::rpc("GRAPH_INDEX_FAILED", e.to_string()))?;

    if force {
        clear_workspace_graph(conn, root_hash)?;
    }

    let mut seen = HashSet::new();
    let rel_files: Vec<String> = files
        .iter()
        .filter_map(|f| {
            let rel = f.rel_path.replace('\\', "/");
            if rel.is_empty()
                || rel.starts_with("../")
                || rel.contains('\0')
                || !is_graph_path(&rel)
            {
                return None;
            }
            if seen.insert(rel.clone()) {
                Some(rel)
            } else {
                None
            }
        })
        .take(MAX_GRAPH_FILES)
        .collect();
    let rel_set: HashSet<String> = rel_files.iter().cloned().collect();
    if force {
        purge_removed_files(conn, root_hash, &rel_set)?;
    } else {
        purge_stale_files(conn, root_hash, &rel_set)?;
    }

    let stored_mtimes = load_file_mtimes(conn, root_hash)?;
    let mut import_count = count_imports(conn, root_hash)?;
    let mut symbol_count = count_symbols(conn, root_hash)?;
    let mut call_count = count_calls(conn, root_hash)?;
    // 与本地建库同一条规则：要调用图但没有调用边 → 未变文件也要重解析
    let calls_missing = scope.with_calls() && !force && call_count == 0;

    // rel_path 归一化一次建表：原来每个文件都 `files.iter().find(...replace('\\',"/"))`，
    // 16k 文件就是 2.5 亿次字符串替换 + 全表比对。同名保留**第一个**（与 find 同语义）。
    let mut by_rel: HashMap<String, &RemoteFileInput> = HashMap::with_capacity(files.len());
    for file in files.iter() {
        by_rel
            .entry(file.rel_path.replace('\\', "/"))
            .or_insert(file);
    }

    for rel in &rel_files {
        let Some(file) = by_rel.get(rel.as_str()).copied() else {
            continue;
        };
        if file.content.contains('\0') {
            continue;
        }
        let mtime = file.mtime;
        if !force {
            if !calls_missing && stored_mtimes.get(rel).copied() == Some(mtime) {
                continue;
            }
            let (di, ds, dc) = clear_file_graph(conn, root_hash, rel)?;
            import_count -= di;
            symbol_count -= ds;
            call_count -= dc;
        }

        let (ic, sc, cc) = index_file(conn, root_hash, rel, &file.content, mtime, &rel_set, scope)?;
        import_count += ic;
        symbol_count += sc;
        call_count += cc;

        conn.execute(
            "INSERT INTO graph_file_mtime (root_hash, rel_path, mtime)
             VALUES (?1, ?2, ?3)
             ON CONFLICT(root_hash, rel_path) DO UPDATE SET mtime = excluded.mtime",
            params![root_hash, rel, mtime],
        )
        .map_err(|e| CoreError::rpc("GRAPH_INDEX_FAILED", e.to_string()))?;
    }

    // 远端摄取同理：候选文件全部入库后回填名字唯一的解析目标
    backfill_unique_callees(conn, root_hash)?;

    let indexed_at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);

    conn.execute(
        "UPDATE graph_workspaces
         SET file_count = ?2, edge_count = ?3, symbol_count = ?4, call_count = ?5,
             indexed_at = ?6, indexing = 0
         WHERE root_hash = ?1",
        params![
            root_hash,
            rel_files.len() as i64,
            import_count,
            symbol_count,
            call_count,
            indexed_at
        ],
    )
    .map_err(|e| CoreError::rpc("GRAPH_INDEX_FAILED", e.to_string()))?;

    Ok(BuildStats {
        file_count: rel_files.len() as i64,
        edge_count: import_count,
        symbol_count,
        call_count,
    })
}

fn index_file(
    conn: &Connection,
    root_hash: &str,
    rel: &str,
    text: &str,
    mtime: i64,
    known_files: &HashSet<String>,
    scope: GraphScope,
) -> Result<(i64, i64, i64), CoreError> {
    // Tree-sitter 优先；失败回退启发式
    let ast = crate::treesitter::extract_graph_ast(rel, text);

    let mut import_count = 0i64;
    let imports = if let Some(ref a) = ast {
        a.imports.clone()
    } else if is_js_ts_path(rel) {
        extract_js_imports(text)
    } else if is_python_path(rel) {
        extract_py_imports(text)
    } else if is_go_path(rel) {
        extract_go_imports(text)
    } else if is_rust_path(rel) {
        extract_rust_imports(text)
    } else {
        Vec::new()
    };

    for import in imports {
        let resolved = if is_js_ts_path(rel) {
            resolve_js_import(rel, &import.spec, known_files)
        } else if is_python_path(rel) {
            resolve_python_import(rel, &import.spec, known_files)
        } else if is_go_path(rel) {
            resolve_go_import(rel, &import.spec, known_files)
        } else if is_rust_path(rel) {
            resolve_rust_import(rel, &import.spec, known_files)
        } else {
            None
        };
        let external = if is_js_ts_path(rel) {
            resolved.is_none()
                && !(import.spec.starts_with("./") || import.spec.starts_with("../"))
        } else if is_python_path(rel) {
            resolved.is_none() && !is_py_relative_spec(&import.spec)
        } else if is_go_path(rel) {
            resolved.is_none() && !is_go_relative_spec(&import.spec)
        } else if is_rust_path(rel) {
            resolved.is_none() && is_rust_external_spec(&import.spec)
        } else {
            resolved.is_none()
        };
        import_count += insert_import(conn, root_hash, rel, &import, resolved, external)?;
    }

    let symbols = if let Some(ref a) = ast {
        a.symbols.clone()
    } else if is_js_ts_path(rel) {
        extract_js_symbols(text)
    } else if is_python_path(rel) {
        extract_py_symbols(text)
    } else if is_go_path(rel) {
        extract_go_symbols(text)
    } else if is_rust_path(rel) {
        extract_rust_symbols(text)
    } else {
        Vec::new()
    };
    let mut symbol_ids: Vec<(i64, i64, i64)> = Vec::new();
    let mut symbol_count = 0i64;
    for sym in &symbols {
        let qn = format!("{rel}::{}", sym.name);
        conn.execute(
            "INSERT INTO graph_symbols
             (root_hash, rel_path, kind, name, qualified_name, start_line, end_line, mtime)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                root_hash,
                rel,
                sym.kind,
                sym.name,
                qn,
                sym.line,
                sym.end_line,
                mtime
            ],
        )
        .map_err(|e| CoreError::rpc("GRAPH_INDEX_FAILED", e.to_string()))?;
        let id = conn.last_insert_rowid();
        symbol_ids.push((id, sym.line, sym.end_line));
        symbol_count += 1;
    }

    // 调用关系只在 `WithCalls` 范围内抽取：它是全量建库中最贵的一段（每条 call 都要
    // 走一次 callee 解析），而用到它的工具最少。`Structural` 下直接跳过。
    if !scope.with_calls() {
        return Ok((import_count, symbol_count, 0));
    }

    let import_targets = load_import_targets(conn, root_hash, rel)?;
    // 调用解析的内存索引：本文件 + import 目标，一次查询，逐 call O(1)。
    let symbol_index = load_symbol_index(conn, root_hash, rel, &import_targets)?;
    let calls = if let Some(ref a) = ast {
        a.calls.clone()
    } else if is_js_ts_path(rel) {
        extract_js_calls(text)
    } else if is_python_path(rel) {
        extract_py_calls(text)
    } else if is_go_path(rel) {
        extract_go_calls(text)
    } else if is_rust_path(rel) {
        extract_rust_calls(text)
    } else {
        Vec::new()
    };
    let mut call_count = 0i64;
    for call in calls {
        let caller_id = caller_symbol_for_line(&symbol_ids, call.line);
        let Some(caller_id) = caller_id else {
            continue;
        };
        let callee_id = resolve_callee_symbol(rel, &call.callee, &symbol_index, &import_targets);
        let confidence = if callee_id.is_some() { 0.9 } else { 0.8 };
        conn.execute(
            "INSERT INTO graph_calls
             (root_hash, caller_symbol_id, caller_path, callee_name, callee_symbol_id, line, confidence)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                root_hash,
                caller_id,
                rel,
                call.callee,
                callee_id,
                call.line,
                confidence
            ],
        )
        .map_err(|e| CoreError::rpc("GRAPH_INDEX_FAILED", e.to_string()))?;
        call_count += 1;
    }

    Ok((import_count, symbol_count, call_count))
}

fn insert_import(
    conn: &Connection,
    root_hash: &str,
    rel: &str,
    import: &crate::graph::types::ParsedImport,
    resolved: Option<String>,
    external: bool,
) -> Result<i64, CoreError> {
    conn.execute(
        "INSERT INTO graph_imports (root_hash, from_path, to_path, spec, line, external)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![
            root_hash,
            rel,
            resolved,
            import.spec,
            import.line,
            if external { 1 } else { 0 }
        ],
    )
    .map_err(|e| CoreError::rpc("GRAPH_INDEX_FAILED", e.to_string()))?;
    Ok(1)
}

/// 把调用行归属到**包住它**的最近符号。
///
/// 只比 start_line 是不够的：函数体结束后、文件作用域的调用（`server.listen(3000)`）
/// 会被算到上一个函数头上，`callees(setup)` 于是凭空多出一条 listen。
/// `end_line` 缺失（0 或小于 start）的解析器按「直到文件末尾」处理，保持老行为。
fn caller_symbol_for_line(symbol_ids: &[(i64, i64, i64)], call_line: i64) -> Option<i64> {
    symbol_ids
        .iter()
        .filter(|(_, start, end)| {
            *start <= call_line && (*end <= *start || call_line <= *end)
        })
        .max_by_key(|(_, start, _)| *start)
        .map(|(id, _, _)| *id)
}

/// 一次载入「可解析目标」的符号 id：本文件 + 所有 import 目标文件 → 名字 → 符号 id。
///
/// 原来每条 call 都按 (rel_path, name) 单独点查一次，import 多的文件就是
/// 「call 数 × import 目标数」次查询 —— 这是 WithCalls 全量建库最贵的一段。
/// 语义与逐条查一致：同一 (文件, 名字) 有多个符号时取 `start_line` 最小的那个
/// （`ORDER BY start_line` + 首见即插入）。
fn load_symbol_index(
    conn: &Connection,
    root_hash: &str,
    rel: &str,
    import_targets: &[String],
) -> Result<HashMap<String, HashMap<String, i64>>, CoreError> {
    let mut paths: Vec<&str> = Vec::with_capacity(import_targets.len() + 1);
    paths.push(rel);
    for target in import_targets {
        if !paths.contains(&target.as_str()) {
            paths.push(target.as_str());
        }
    }
    let placeholders = vec!["?"; paths.len()].join(",");
    let sql = format!(
        "SELECT rel_path, name, id FROM graph_symbols
          WHERE root_hash = ?1 AND rel_path IN ({placeholders})
          ORDER BY start_line"
    );
    let mut stmt = conn
        .prepare(&sql)
        .map_err(|e| CoreError::rpc("GRAPH_INDEX_FAILED", e.to_string()))?;
    let mut bound: Vec<&dyn rusqlite::ToSql> = Vec::with_capacity(paths.len() + 1);
    bound.push(&root_hash);
    for path in &paths {
        bound.push(path);
    }
    let rows = stmt
        .query_map(rusqlite::params_from_iter(bound), |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, i64>(2)?,
            ))
        })
        .map_err(|e| CoreError::rpc("GRAPH_INDEX_FAILED", e.to_string()))?;
    let mut index: HashMap<String, HashMap<String, i64>> = HashMap::new();
    for row in rows.flatten() {
        index.entry(row.0).or_default().entry(row.1).or_insert(row.2);
    }
    Ok(index)
}

fn resolve_callee_symbol(
    rel: &str,
    callee: &str,
    symbol_index: &HashMap<String, HashMap<String, i64>>,
    import_targets: &[String],
) -> Option<i64> {
    if let Some(id) = symbol_index.get(rel).and_then(|m| m.get(callee)) {
        return Some(*id);
    }
    for target in import_targets {
        if let Some(id) = symbol_index.get(target).and_then(|m| m.get(callee)) {
            return Some(*id);
        }
    }
    // 没有 import 依据时**不猜**：曾经这里回落到「全工作区同名的第一个（按 rel_path）」，
    // 于是两处同名函数（如 `init`）会被解析到字典序更小的那个，凭空造出一条假边。
    // 名字唯一的跨文件调用统一由 `backfill_unique_callees` 在建库收尾时回填，
    // 那里的判据是「整个工作区只有这一个同名符号」，不需要猜。
    None
}

/// 建库收尾：把「按名字能唯一定位」的未解析调用回填成解析边。
///
/// 必须在**所有文件都索引完**之后跑：索引顺序是按 rel_path 的，调用方先于被调用方
/// 处理时（`a.js` 调 `b.js` 的函数）当场查不到目标，于是永久留成未解析 —— 图谱精度
/// 就变成了「文件名的字典序」决定的。名字在库内不唯一的保持未解析（按名字匹配由
/// `callers` / `callees` 负责），绝不猜。
///
/// 实现上把「一次性分组扫描 + 内存映射」放在前面，行更新收在一个事务里：
/// 建库是 autocommit 的，几万条逐行提交会让收尾比整个建库还慢。
fn backfill_unique_callees(conn: &Connection, root_hash: &str) -> Result<i64, CoreError> {
    let mut unique: HashMap<String, i64> = HashMap::new();
    {
        let mut stmt = conn
            .prepare(
                "SELECT name, MIN(id) FROM graph_symbols
                  WHERE root_hash = ?1 GROUP BY name HAVING COUNT(*) = 1",
            )
            .map_err(|e| CoreError::rpc("GRAPH_INDEX_FAILED", e.to_string()))?;
        let rows = stmt
            .query_map(params![root_hash], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?))
            })
            .map_err(|e| CoreError::rpc("GRAPH_INDEX_FAILED", e.to_string()))?;
        for row in rows.flatten() {
            unique.insert(row.0, row.1);
        }
    }
    if unique.is_empty() {
        return Ok(0);
    }

    let mut pending: Vec<(i64, i64)> = Vec::new();
    {
        let mut stmt = conn
            .prepare(
                "SELECT id, callee_name FROM graph_calls
                  WHERE root_hash = ?1 AND callee_symbol_id IS NULL",
            )
            .map_err(|e| CoreError::rpc("GRAPH_INDEX_FAILED", e.to_string()))?;
        let rows = stmt
            .query_map(params![root_hash], |r| {
                Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?))
            })
            .map_err(|e| CoreError::rpc("GRAPH_INDEX_FAILED", e.to_string()))?;
        for row in rows.flatten() {
            if let Some(sym_id) = unique.get(&row.1) {
                pending.push((row.0, *sym_id));
            }
        }
    }
    if pending.is_empty() {
        return Ok(0);
    }

    let tx = conn
        .unchecked_transaction()
        .map_err(|e| CoreError::rpc("GRAPH_INDEX_FAILED", e.to_string()))?;
    let mut updated = 0i64;
    {
        let mut upd = tx
            .prepare("UPDATE graph_calls SET callee_symbol_id = ?2, confidence = 0.9 WHERE id = ?1")
            .map_err(|e| CoreError::rpc("GRAPH_INDEX_FAILED", e.to_string()))?;
        for (call_id, sym_id) in pending {
            updated += upd
                .execute(params![call_id, sym_id])
                .map_err(|e| CoreError::rpc("GRAPH_INDEX_FAILED", e.to_string()))?
                as i64;
        }
    }
    tx.commit()
        .map_err(|e| CoreError::rpc("GRAPH_INDEX_FAILED", e.to_string()))?;
    Ok(updated)
}

fn load_import_targets(
    conn: &Connection,
    root_hash: &str,
    rel: &str,
) -> Result<Vec<String>, CoreError> {
    let mut stmt = conn
        .prepare(
            "SELECT to_path FROM graph_imports
             WHERE root_hash = ?1 AND from_path = ?2 AND external = 0 AND to_path IS NOT NULL",
        )
        .map_err(|e| CoreError::rpc("GRAPH_QUERY_FAILED", e.to_string()))?;
    let rows = stmt
        .query_map(params![root_hash, rel], |r| r.get::<_, String>(0))
        .map_err(|e| CoreError::rpc("GRAPH_QUERY_FAILED", e.to_string()))?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

pub(crate) fn clear_workspace_graph(conn: &Connection, root_hash: &str) -> Result<(), CoreError> {
    conn.execute(
        "DELETE FROM graph_calls WHERE root_hash = ?1",
        params![root_hash],
    )
    .ok();
    conn.execute(
        "DELETE FROM graph_symbols WHERE root_hash = ?1",
        params![root_hash],
    )
    .ok();
    conn.execute(
        "DELETE FROM graph_imports WHERE root_hash = ?1",
        params![root_hash],
    )
    .ok();
    conn.execute(
        "DELETE FROM graph_file_mtime WHERE root_hash = ?1",
        params![root_hash],
    )
    .ok();
    Ok(())
}

/// 清掉某文件的图谱行，返回 `(imports, symbols, calls)` 各删掉多少行。
///
/// 增量建库要在循环里维护「已入库行数」的进度；原来每删一个文件都重跑三条
/// `COUNT(*)`（全表扫描 × 文件数），这里直接报告删除行数，减一下即可。
fn clear_file_graph(
    conn: &Connection,
    root_hash: &str,
    rel: &str,
) -> Result<(i64, i64, i64), CoreError> {
    let symbol_ids: Vec<i64> = {
        let mut stmt = conn
            .prepare("SELECT id FROM graph_symbols WHERE root_hash = ?1 AND rel_path = ?2")
            .map_err(|e| CoreError::rpc("GRAPH_INDEX_FAILED", e.to_string()))?;
        let rows = stmt
            .query_map(params![root_hash, rel], |r| r.get(0))
            .map_err(|e| CoreError::rpc("GRAPH_INDEX_FAILED", e.to_string()))?;
        rows.filter_map(|r| r.ok()).collect()
    };
    let mut calls_deleted = 0i64;
    for id in symbol_ids {
        if let Ok(n) = conn.execute(
            "DELETE FROM graph_calls WHERE caller_symbol_id = ?1",
            params![id],
        ) {
            calls_deleted += n as i64;
        }
        // 指向本文件符号的调用边来自**别的文件**：那些文件的源码没变，调用点也还在，
        // 只是解析目标要重新算。整行删掉等于把它们的调用关系一段段吃掉 —— 增量重建
        // （未改文件直接跳过）不会把这些行再插回来，图谱会随每次编辑变稀疏。
        // 所以这里只**撤销解析**，保留调用点按名字匹配。
        conn.execute(
            "UPDATE graph_calls SET callee_symbol_id = NULL, confidence = 0.8
             WHERE root_hash = ?1 AND callee_symbol_id = ?2 AND caller_path <> ?3",
            params![root_hash, id, rel],
        )
        .ok();
    }
    let symbols_deleted = conn
        .execute(
            "DELETE FROM graph_symbols WHERE root_hash = ?1 AND rel_path = ?2",
            params![root_hash, rel],
        )
        .map(|n| n as i64)
        .unwrap_or(0);
    let imports_deleted = conn
        .execute(
            "DELETE FROM graph_imports WHERE root_hash = ?1 AND from_path = ?2",
            params![root_hash, rel],
        )
        .map(|n| n as i64)
        .unwrap_or(0);
    conn.execute(
        "DELETE FROM graph_file_mtime WHERE root_hash = ?1 AND rel_path = ?2",
        params![root_hash, rel],
    )
    .ok();
    Ok((imports_deleted, symbols_deleted, calls_deleted))
}

fn purge_removed_files(
    conn: &Connection,
    root_hash: &str,
    keep: &HashSet<String>,
) -> Result<(), CoreError> {
    let existing = load_indexed_files(conn, root_hash)?;
    for rel in existing {
        if !keep.contains(&rel) {
            clear_file_graph(conn, root_hash, &rel)?;
        }
    }
    Ok(())
}

fn purge_stale_files(
    conn: &Connection,
    root_hash: &str,
    keep: &HashSet<String>,
) -> Result<(), CoreError> {
    purge_removed_files(conn, root_hash, keep)
}

fn load_indexed_files(conn: &Connection, root_hash: &str) -> Result<Vec<String>, CoreError> {
    let mut stmt = conn
        .prepare("SELECT rel_path FROM graph_file_mtime WHERE root_hash = ?1")
        .map_err(|e| CoreError::rpc("GRAPH_QUERY_FAILED", e.to_string()))?;
    let rows = stmt
        .query_map(params![root_hash], |r| r.get(0))
        .map_err(|e| CoreError::rpc("GRAPH_QUERY_FAILED", e.to_string()))?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

fn load_file_mtimes(conn: &Connection, root_hash: &str) -> Result<HashMap<String, i64>, CoreError> {
    let mut out = HashMap::new();
    let mut stmt = conn
        .prepare("SELECT rel_path, mtime FROM graph_file_mtime WHERE root_hash = ?1")
        .map_err(|e| CoreError::rpc("GRAPH_QUERY_FAILED", e.to_string()))?;
    let rows = stmt
        .query_map(params![root_hash], |r| {
            Ok((r.get::<_, String>(0)?, r.get(1)?))
        })
        .map_err(|e| CoreError::rpc("GRAPH_QUERY_FAILED", e.to_string()))?;
    for row in rows.flatten() {
        out.insert(row.0, row.1);
    }
    Ok(out)
}

fn count_imports(conn: &Connection, root_hash: &str) -> Result<i64, CoreError> {
    conn.query_row(
        "SELECT COUNT(*) FROM graph_imports WHERE root_hash = ?1",
        params![root_hash],
        |r| r.get(0),
    )
    .map_err(|e| CoreError::rpc("GRAPH_QUERY_FAILED", e.to_string()))
}

fn count_symbols(conn: &Connection, root_hash: &str) -> Result<i64, CoreError> {
    conn.query_row(
        "SELECT COUNT(*) FROM graph_symbols WHERE root_hash = ?1",
        params![root_hash],
        |r| r.get(0),
    )
    .map_err(|e| CoreError::rpc("GRAPH_QUERY_FAILED", e.to_string()))
}

fn count_calls(conn: &Connection, root_hash: &str) -> Result<i64, CoreError> {
    conn.query_row(
        "SELECT COUNT(*) FROM graph_calls WHERE root_hash = ?1",
        params![root_hash],
        |r| r.get(0),
    )
    .map_err(|e| CoreError::rpc("GRAPH_QUERY_FAILED", e.to_string()))
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

    fn known(paths: &[&str]) -> HashSet<String> {
        paths.iter().map(|p| p.to_string()).collect()
    }

    /// 本文件内的调用：`main()` 里调 `local_helper()`，应解析到同一文件的符号。
    #[test]
    fn resolves_callee_in_same_file() {
        let conn = test_conn();
        let src = "function local_helper() {\n  return 1;\n}\nfunction main() {\n  local_helper();\n}\n";
        index_file(
            &conn,
            "rh",
            "src/a.js",
            src,
            0,
            &known(&["src/a.js"]),
            GraphScope::WithCalls,
        )
        .unwrap();

        let (callee, rel): (Option<i64>, String) = conn
            .query_row(
                "SELECT c.callee_symbol_id, s.rel_path
                   FROM graph_calls c JOIN graph_symbols s ON s.id = c.callee_symbol_id
                  WHERE c.callee_name = 'local_helper'",
                [],
                |r| Ok((r.get(0).ok(), r.get(1)?)),
            )
            .map_err(|e| e.to_string())
            .expect("local_helper() 应解析出边");
        assert!(callee.is_some());
        assert_eq!(rel, "src/a.js");
    }

    /// 跨文件调用：`helper()` 由 `./b` 引入，应解析到 `src/b.js` 的符号。
    ///
    /// 这条同时锁住 `load_symbol_index` 的 IN 批量载入：import 目标不在索引里就解析不到。
    #[test]
    fn resolves_callee_via_import_target() {
        let conn = test_conn();
        let b = "export function helper() {\n  return 1;\n}\n";
        let a = "import { helper } from './b';\nexport function main() {\n  helper();\n}\n";
        let files = known(&["src/a.js", "src/b.js"]);
        // 被调用方先索引：旧逐条查的语义要求目标符号已在库内
        index_file(&conn, "rh", "src/b.js", b, 0, &files, GraphScope::WithCalls).unwrap();
        index_file(&conn, "rh", "src/a.js", a, 0, &files, GraphScope::WithCalls).unwrap();

        let (callee, rel): (Option<i64>, String) = conn
            .query_row(
                "SELECT c.callee_symbol_id, s.rel_path
                   FROM graph_calls c JOIN graph_symbols s ON s.id = c.callee_symbol_id
                  WHERE c.callee_name = 'helper'",
                [],
                |r| Ok((r.get(0).ok(), r.get(1)?)),
            )
            .map_err(|e| e.to_string())
            .expect("helper() 应经 import 目标解析出边");
        assert!(callee.is_some());
        assert_eq!(rel, "src/b.js");
    }

    /// 没有 import 依据的跨文件同名调用必须留空（交给 `backfill_unique_callees`），
    /// 绝不按「字典序更小的同名符号」猜。
    #[test]
    fn unresolved_callee_stays_null_without_import() {
        let conn = test_conn();
        let b = "export function helper() {\n  return 1;\n}\n";
        let a = "export function main() {\n  helper();\n}\n";
        let files = known(&["src/a.js", "src/b.js"]);
        index_file(&conn, "rh", "src/b.js", b, 0, &files, GraphScope::WithCalls).unwrap();
        index_file(&conn, "rh", "src/a.js", a, 0, &files, GraphScope::WithCalls).unwrap();

        let callee: Option<i64> = conn
            .query_row(
                "SELECT callee_symbol_id FROM graph_calls WHERE callee_name = 'helper'",
                [],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())
            .expect("应记录一条未解析的调用边");
        assert!(callee.is_none());
    }

    /// 增量建库靠「删除行数」递减进度计数器（不再每文件三条全表 COUNT）：
    /// `clear_file_graph` 报告的删除数必须与三条 COUNT 的实际差值逐项相等。
    #[test]
    fn clear_file_graph_reports_exact_deleted_counts() {
        let conn = test_conn();
        let b = "export function helper() {\n  return 1;\n}\n";
        let a = "import { helper } from './b';\nexport function main() {\n  helper();\n}\n";
        let files = known(&["src/a.js", "src/b.js"]);
        index_file(&conn, "rh", "src/b.js", b, 0, &files, GraphScope::WithCalls).unwrap();
        index_file(&conn, "rh", "src/a.js", a, 0, &files, GraphScope::WithCalls).unwrap();

        let before = (
            count_imports(&conn, "rh").unwrap(),
            count_symbols(&conn, "rh").unwrap(),
            count_calls(&conn, "rh").unwrap(),
        );
        let reported = clear_file_graph(&conn, "rh", "src/a.js").unwrap();
        let after = (
            count_imports(&conn, "rh").unwrap(),
            count_symbols(&conn, "rh").unwrap(),
            count_calls(&conn, "rh").unwrap(),
        );
        assert_eq!(
            reported,
            (before.0 - after.0, before.1 - after.1, before.2 - after.2),
            "报告的删除行数必须等于实际减少量（进度计数靠它递减）"
        );
        // 只清掉 a.js：b.js 的符号与文件时间戳都还在
        assert_eq!(after.1, 1, "src/b.js 的 helper 应保留");
    }
}

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
use crate::graph::types::ParsedSymbol;
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

#[allow(dead_code)]
pub fn run_build(
    conn: &Connection,
    root: &Path,
    root_hash: &str,
    force: bool,
) -> Result<BuildStats, CoreError> {
    run_build_with_progress(conn, root, root_hash, force, None)
}

pub fn run_build_with_progress(
    conn: &Connection,
    root: &Path,
    root_hash: &str,
    force: bool,
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

    for rel in &rel_files {
        let abs = root.join(rel.replace('/', std::path::MAIN_SEPARATOR_STR));
        let meta = match std::fs::metadata(&abs) {
            Ok(m) => m,
            Err(_) => continue,
        };
        let mtime = crate::index::file_mtime_stamp(&meta);
        if !force {
            let unchanged = stored_mtimes
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
            clear_file_graph(conn, root_hash, rel)?;
            import_count = count_imports(conn, root_hash)?;
            symbol_count = count_symbols(conn, root_hash)?;
            call_count = count_calls(conn, root_hash)?;
        }

        let text = match std::fs::read_to_string(&abs) {
            Ok(t) if !t.contains('\0') => t,
            _ => continue,
        };

        let (ic, sc, cc) = index_file(conn, root_hash, rel, &text, mtime, &rel_files)?;
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

    for rel in &rel_files {
        let Some(file) = files.iter().find(|f| f.rel_path.replace('\\', "/") == *rel) else {
            continue;
        };
        if file.content.contains('\0') {
            continue;
        }
        let mtime = file.mtime;
        if !force {
            if stored_mtimes.get(rel).copied() == Some(mtime) {
                continue;
            }
            clear_file_graph(conn, root_hash, rel)?;
            import_count = count_imports(conn, root_hash)?;
            symbol_count = count_symbols(conn, root_hash)?;
            call_count = count_calls(conn, root_hash)?;
        }

        let (ic, sc, cc) = index_file(conn, root_hash, rel, &file.content, mtime, &rel_files)?;
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
    rel_files: &[String],
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
            resolve_js_import(rel, &import.spec, rel_files)
        } else if is_python_path(rel) {
            resolve_python_import(rel, &import.spec, rel_files)
        } else if is_go_path(rel) {
            resolve_go_import(rel, &import.spec, rel_files)
        } else if is_rust_path(rel) {
            resolve_rust_import(rel, &import.spec, rel_files)
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
    let mut symbol_ids: Vec<(i64, i64)> = Vec::new();
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
        symbol_ids.push((id, sym.line));
        symbol_count += 1;
    }

    let import_targets = load_import_targets(conn, root_hash, rel)?;
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
        let callee_id = resolve_callee_symbol(
            conn,
            root_hash,
            rel,
            &call.callee,
            &symbols,
            &import_targets,
        )?;
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

fn caller_symbol_for_line(symbol_ids: &[(i64, i64)], call_line: i64) -> Option<i64> {
    symbol_ids
        .iter()
        .filter(|(_, line)| *line <= call_line)
        .max_by_key(|(_, line)| line)
        .map(|(id, _)| *id)
}

fn resolve_callee_symbol(
    conn: &Connection,
    root_hash: &str,
    rel: &str,
    callee: &str,
    local_symbols: &[ParsedSymbol],
    import_targets: &[String],
) -> Result<Option<i64>, CoreError> {
    if local_symbols.iter().any(|s| s.name == callee) {
        if let Ok(id) = conn.query_row(
            "SELECT id FROM graph_symbols
             WHERE root_hash = ?1 AND rel_path = ?2 AND name = ?3
             ORDER BY start_line LIMIT 1",
            params![root_hash, rel, callee],
            |r| r.get(0),
        ) {
            return Ok(Some(id));
        }
    }
    for target in import_targets {
        if let Ok(id) = conn.query_row(
            "SELECT id FROM graph_symbols
             WHERE root_hash = ?1 AND rel_path = ?2 AND name = ?3
             ORDER BY start_line LIMIT 1",
            params![root_hash, target, callee],
            |r| r.get(0),
        ) {
            return Ok(Some(id));
        }
    }
    Ok(conn
        .query_row(
            "SELECT id FROM graph_symbols
             WHERE root_hash = ?1 AND name = ?2
             ORDER BY rel_path LIMIT 1",
            params![root_hash, callee],
            |r| r.get(0),
        )
        .ok())
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

fn clear_workspace_graph(conn: &Connection, root_hash: &str) -> Result<(), CoreError> {
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

fn clear_file_graph(conn: &Connection, root_hash: &str, rel: &str) -> Result<(), CoreError> {
    let symbol_ids: Vec<i64> = {
        let mut stmt = conn
            .prepare("SELECT id FROM graph_symbols WHERE root_hash = ?1 AND rel_path = ?2")
            .map_err(|e| CoreError::rpc("GRAPH_INDEX_FAILED", e.to_string()))?;
        let rows = stmt
            .query_map(params![root_hash, rel], |r| r.get(0))
            .map_err(|e| CoreError::rpc("GRAPH_INDEX_FAILED", e.to_string()))?;
        rows.filter_map(|r| r.ok()).collect()
    };
    for id in symbol_ids {
        conn.execute(
            "DELETE FROM graph_calls WHERE caller_symbol_id = ?1",
            params![id],
        )
        .ok();
        conn.execute(
            "DELETE FROM graph_calls WHERE root_hash = ?1 AND callee_symbol_id = ?2",
            params![root_hash, id],
        )
        .ok();
    }
    conn.execute(
        "DELETE FROM graph_symbols WHERE root_hash = ?1 AND rel_path = ?2",
        params![root_hash, rel],
    )
    .ok();
    conn.execute(
        "DELETE FROM graph_imports WHERE root_hash = ?1 AND from_path = ?2",
        params![root_hash, rel],
    )
    .ok();
    conn.execute(
        "DELETE FROM graph_file_mtime WHERE root_hash = ?1 AND rel_path = ?2",
        params![root_hash, rel],
    )
    .ok();
    Ok(())
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

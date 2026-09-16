use rusqlite::{params, Connection};

use crate::error::CoreError;
use crate::graph::types::{IngestLspResult, LspCallSiteIn};

pub fn ingest_lsp_callers(
    conn: &Connection,
    root_hash: &str,
    callee_symbol_id: i64,
    callee_name: &str,
    sites: &[LspCallSiteIn],
) -> Result<IngestLspResult, CoreError> {
    conn.execute(
        "DELETE FROM graph_calls
         WHERE root_hash = ?1 AND callee_symbol_id = ?2 AND confidence >= 1.0",
        params![root_hash, callee_symbol_id],
    )
    .map_err(|e| CoreError::rpc("GRAPH_INGEST_FAILED", e.to_string()))?;

    let mut ingested = 0i64;
    let mut seen = std::collections::HashSet::new();

    for site in sites {
        let caller_path = normalize_path_key(&site.caller_path);
        if caller_path.is_empty() {
            continue;
        }
        let line = site.line.max(1);
        let key = format!("{caller_path}:{line}");
        if !seen.insert(key) {
            continue;
        }
        let Some(caller_id) = caller_symbol_at_line(conn, root_hash, &caller_path, line)? else {
            continue;
        };
        conn.execute(
            "INSERT INTO graph_calls
             (root_hash, caller_symbol_id, caller_path, callee_name, callee_symbol_id, line, confidence)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1.0)",
            params![
                root_hash,
                caller_id,
                caller_path,
                callee_name,
                callee_symbol_id,
                line
            ],
        )
        .map_err(|e| CoreError::rpc("GRAPH_INGEST_FAILED", e.to_string()))?;
        ingested += 1;
    }

    let call_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM graph_calls WHERE root_hash = ?1",
            params![root_hash],
            |r| r.get(0),
        )
        .map_err(|e| CoreError::rpc("GRAPH_QUERY_FAILED", e.to_string()))?;

    conn.execute(
        "UPDATE graph_workspaces SET call_count = ?2 WHERE root_hash = ?1",
        params![root_hash, call_count],
    )
    .ok();

    Ok(IngestLspResult {
        ok: true,
        ingested,
        call_count,
    })
}

fn caller_symbol_at_line(
    conn: &Connection,
    root_hash: &str,
    rel_path: &str,
    line: i64,
) -> Result<Option<i64>, CoreError> {
    match conn.query_row(
        "SELECT id FROM graph_symbols
         WHERE root_hash = ?1 AND rel_path = ?2 AND start_line <= ?3
         ORDER BY start_line DESC LIMIT 1",
        params![root_hash, rel_path, line],
        |r| r.get(0),
    ) {
        Ok(id) => Ok(Some(id)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(CoreError::rpc("GRAPH_QUERY_FAILED", e.to_string())),
    }
}

fn normalize_path_key(raw: &str) -> String {
    raw.replace('\\', "/").trim_start_matches("./").to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::graph::schema::init_graph_schema;
    use crate::index::init_schema;

    fn test_conn() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        init_schema(&conn).unwrap();
        init_graph_schema(&conn).unwrap();
        conn
    }

    #[test]
    fn ingests_lsp_callers_with_confidence_one() {
        let conn = test_conn();
        let root = "rh1";
        conn.execute(
            "INSERT INTO graph_workspaces (root_hash, root_path) VALUES (?1, '/tmp')",
            params![root],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO graph_symbols (root_hash, rel_path, kind, name, qualified_name, start_line, end_line, mtime)
             VALUES (?1, 'b.py', 'function', 'helper', 'b.py::helper', 1, 1, 0)",
            params![root],
        )
        .unwrap();
        let callee_id = conn.last_insert_rowid();
        conn.execute(
            "INSERT INTO graph_symbols (root_hash, rel_path, kind, name, qualified_name, start_line, end_line, mtime)
             VALUES (?1, 'a.py', 'function', 'main', 'a.py::main', 1, 3, 0)",
            params![root],
        )
        .unwrap();

        let r = ingest_lsp_callers(
            &conn,
            root,
            callee_id,
            "helper",
            &[LspCallSiteIn {
                caller_path: "a.py".to_string(),
                line: 2,
                caller_symbol: Some("main".to_string()),
            }],
        )
        .unwrap();
        assert_eq!(r.ingested, 1);

        let conf: f64 = conn
            .query_row(
                "SELECT confidence FROM graph_calls WHERE root_hash = ?1 AND callee_symbol_id = ?2",
                params![root, callee_id],
                |row| row.get(0),
            )
            .unwrap();
        assert!((conf - 1.0).abs() < f64::EPSILON);
    }
}

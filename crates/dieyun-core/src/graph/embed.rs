use rusqlite::{params, Connection};

use crate::embedding::{self, EmbeddingConfig};
use crate::error::CoreError;

pub fn symbol_embed_text(kind: &str, name: &str, rel_path: &str) -> String {
    format!("{kind} {name} in {rel_path}")
}

struct SymbolEmbedRow {
    id: i64,
    text: String,
    mtime: i64,
}

pub async fn run_embed_symbols(
    conn: &Connection,
    cfg: &EmbeddingConfig,
    models_dirs: &[std::path::PathBuf],
    root_hash: &str,
    force: bool,
) -> Result<(i64, Option<String>), CoreError> {
    if !cfg.enabled(models_dirs) {
        return Err(CoreError::rpc(
            "EMBEDDING_DISABLED",
            "未配置 Embedding 模型，无法构建符号向量",
        ));
    }
    let embed_sig = cfg.signature(models_dirs);
    if embed_sig.is_empty() {
        return Err(CoreError::rpc(
            "EMBEDDING_DISABLED",
            "Embedding 模型签名无效",
        ));
    }

    let stored_sig: Option<String> = conn
        .query_row(
            "SELECT symbol_embedding_model FROM graph_workspaces WHERE root_hash = ?1",
            params![root_hash],
            |r| r.get(0),
        )
        .ok()
        .flatten();

    let model_changed = stored_sig.as_deref() != Some(embed_sig.as_str());
    let needs_full = force || model_changed;
    let pending = collect_symbols_needing_embed(conn, root_hash, needs_full)?;

    if pending.is_empty() {
        if needs_full {
            purge_workspace_symbol_vectors(conn, root_hash)?;
        }
        let count = count_symbol_vectors(conn, root_hash)?;
        return Ok((count, stored_sig));
    }

    if needs_full {
        purge_workspace_symbol_vectors(conn, root_hash)?;
    }

    let mtime_by_id: std::collections::HashMap<i64, i64> =
        pending.iter().map(|(id, _, m)| (*id, *m)).collect();
    let embed_inputs: Vec<(i64, String)> = pending
        .iter()
        .map(|(id, text, _)| (*id, text.clone()))
        .collect();
    let embedded = embedding::embed_batches(cfg, models_dirs, &embed_inputs).await?;
    for (symbol_id, vec) in embedded {
        let mtime = mtime_by_id.get(&symbol_id).copied().unwrap_or(0);
        let blob = embedding::vector_to_blob(&vec);
        conn.execute(
            "INSERT INTO graph_symbol_vectors (symbol_id, dims, vector, symbol_mtime)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(symbol_id) DO UPDATE SET
               dims = excluded.dims,
               vector = excluded.vector,
               symbol_mtime = excluded.symbol_mtime",
            params![symbol_id, vec.len() as i64, blob, mtime],
        )
        .map_err(|e| CoreError::rpc("GRAPH_EMBED_FAILED", e.to_string()))?;
    }

    let vector_count = count_symbol_vectors(conn, root_hash)?;
    conn.execute(
        "UPDATE graph_workspaces
         SET symbol_vector_count = ?2, symbol_embedding_model = ?3
         WHERE root_hash = ?1",
        params![root_hash, vector_count, embed_sig],
    )
    .map_err(|e| CoreError::rpc("GRAPH_EMBED_FAILED", e.to_string()))?;

    Ok((vector_count, Some(embed_sig)))
}

fn collect_symbols_needing_embed(
    conn: &Connection,
    root_hash: &str,
    full: bool,
) -> Result<Vec<(i64, String, i64)>, CoreError> {
    let sql = if full {
        "SELECT s.id, s.kind, s.name, s.rel_path, s.mtime
         FROM graph_symbols s
         WHERE s.root_hash = ?1
         ORDER BY s.id"
    } else {
        "SELECT s.id, s.kind, s.name, s.rel_path, s.mtime
         FROM graph_symbols s
         LEFT JOIN graph_symbol_vectors v ON v.symbol_id = s.id
         WHERE s.root_hash = ?1
           AND (v.symbol_id IS NULL OR v.symbol_mtime < s.mtime)
         ORDER BY s.id"
    };
    let mut stmt = conn
        .prepare(sql)
        .map_err(|e| CoreError::rpc("GRAPH_EMBED_FAILED", e.to_string()))?;
    let rows = stmt
        .query_map(params![root_hash], |r| {
            Ok(SymbolEmbedRow {
                id: r.get(0)?,
                text: symbol_embed_text(
                    &r.get::<_, String>(1)?,
                    &r.get::<_, String>(2)?,
                    &r.get::<_, String>(3)?,
                ),
                mtime: r.get(4)?,
            })
        })
        .map_err(|e| CoreError::rpc("GRAPH_EMBED_FAILED", e.to_string()))?;
    Ok(rows
        .filter_map(|r| r.ok())
        .map(|row| (row.id, row.text, row.mtime))
        .collect())
}

pub fn count_symbol_vectors(conn: &Connection, root_hash: &str) -> Result<i64, CoreError> {
    conn.query_row(
        "SELECT COUNT(*) FROM graph_symbol_vectors v
         JOIN graph_symbols s ON s.id = v.symbol_id
         WHERE s.root_hash = ?1",
        params![root_hash],
        |r| r.get(0),
    )
    .map_err(|e| CoreError::rpc("GRAPH_QUERY_FAILED", e.to_string()))
}

fn purge_workspace_symbol_vectors(conn: &Connection, root_hash: &str) -> Result<(), CoreError> {
    conn.execute(
        "DELETE FROM graph_symbol_vectors
         WHERE symbol_id IN (SELECT id FROM graph_symbols WHERE root_hash = ?1)",
        params![root_hash],
    )
    .map_err(|e| CoreError::rpc("GRAPH_EMBED_FAILED", e.to_string()))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_symbol_embed_text() {
        let t = symbol_embed_text("function", "repairMcp", "src/mcp/package-store.js");
        assert!(t.contains("repairMcp"));
        assert!(t.contains("package-store.js"));
    }
}

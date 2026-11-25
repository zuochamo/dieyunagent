//! 图谱清理：删文件 / 删工作区时，符号、导入、**调用边**必须一起收干净。
//!
//! 从 `graph/build.rs` 机械搬来（纯移动）。这一份就是「删符号连带删边」的唯一实现：
//! schema 里的 `FOREIGN KEY ... ON DELETE CASCADE` 在这条库连接上**不生效**
//! （`sqlite.rs` 默认不开 `foreign_keys`），所以级联必须手写在这里；任何新增的删除路径
//! 都必须调这几个函数，别自己拼 DELETE。

use std::collections::HashSet;

use rusqlite::{params, Connection};

use super::build::load_indexed_files;

use dieyun_base::error::CoreError;

pub(crate) fn clear_workspace_graph(conn: &Connection, root_hash: &str) -> Result<(), CoreError> {
    conn.execute(
        "DELETE FROM graph_calls WHERE root_hash = ?1",
        params![root_hash],
    )
    .map_err(|e| CoreError::rpc("GRAPH_CLEANUP_FAILED", e.to_string()))?;
    conn.execute(
        "DELETE FROM graph_symbols WHERE root_hash = ?1",
        params![root_hash],
    )
    .map_err(|e| CoreError::rpc("GRAPH_CLEANUP_FAILED", e.to_string()))?;
    conn.execute(
        "DELETE FROM graph_imports WHERE root_hash = ?1",
        params![root_hash],
    )
    .map_err(|e| CoreError::rpc("GRAPH_CLEANUP_FAILED", e.to_string()))?;
    conn.execute(
        "DELETE FROM graph_file_mtime WHERE root_hash = ?1",
        params![root_hash],
    )
    .map_err(|e| CoreError::rpc("GRAPH_CLEANUP_FAILED", e.to_string()))?;
    Ok(())
}


/// 清掉某文件的图谱行，返回 `(imports, symbols, calls)` 各删掉多少行。
///
/// 增量建库要在循环里维护「已入库行数」的进度；原来每删一个文件都重跑三条
/// `COUNT(*)`（全表扫描 × 文件数），这里直接报告删除行数，减一下即可。
pub(crate) fn clear_file_graph(
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


pub(crate) fn purge_removed_files(
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


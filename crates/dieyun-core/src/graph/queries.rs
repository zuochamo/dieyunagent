//! 图谱查询门面：`module_deps` / `repo_map` / `symbol_search` / `callers` / `callees` /
//! `impact` / `ingest_lsp_callers`。
//!
//! 从 `graph/mod.rs` 机械搬来（纯移动）。真正的 SQL 与图算法在 `query.rs`，这里只做
//! 「参数 → 工作区 → 调用」的门面，以及「调用图建过没有」的信号透传。


use super::lsp_ingest::ingest_lsp_callers;
use super::query::{callees, callers, impact, module_deps, repo_map, symbol_search};
use crate::index::resolve_workspace;
use super::{
    CallGraphResult, GraphService, ImpactResult, IngestLspResult, LspCallSiteIn, ModuleDepsResult,
    RepoMapResult, SymbolSearchResult,
};
use crate::error::CoreError;

impl GraphService {

    pub fn module_deps(
        &self,
        workspace_root: &str,
        path: Option<&str>,
        depth: Option<u32>,
    ) -> Result<ModuleDepsResult, CoreError> {
        let ws = resolve_workspace(workspace_root)?;
        self.read_dedicated(&ws, |conn, indexed| {
            module_deps(conn, &ws.root_hash, path, depth.unwrap_or(1), indexed)
        })
    }


    pub fn repo_map(
        &self,
        workspace_root: &str,
        limit: Option<u32>,
    ) -> Result<RepoMapResult, CoreError> {
        let ws = resolve_workspace(workspace_root)?;
        self.read_dedicated(&ws, |conn, indexed| {
            repo_map(conn, &ws.root_hash, limit.unwrap_or(32), indexed)
        })
    }


    pub fn symbol_search(
        &self,
        workspace_root: &str,
        query: &str,
        kind: Option<&str>,
        limit: Option<u32>,
    ) -> Result<SymbolSearchResult, CoreError> {
        let ws = resolve_workspace(workspace_root)?;
        self.read_dedicated(&ws, |conn, indexed| {
            symbol_search(
                conn,
                &ws.root_hash,
                query,
                kind,
                limit.unwrap_or(20),
                indexed,
            )
        })
    }


    pub fn callers(
        &self,
        workspace_root: &str,
        symbol_id: Option<i64>,
        path: Option<&str>,
        name: Option<&str>,
    ) -> Result<CallGraphResult, CoreError> {
        let ws = resolve_workspace(workspace_root)?;
        self.read_dedicated(&ws, |conn, indexed| {
            callers(conn, &ws.root_hash, symbol_id, path, name, indexed)
        })
    }


    pub fn callees(
        &self,
        workspace_root: &str,
        symbol_id: Option<i64>,
        path: Option<&str>,
        name: Option<&str>,
    ) -> Result<CallGraphResult, CoreError> {
        let ws = resolve_workspace(workspace_root)?;
        self.read_dedicated(&ws, |conn, indexed| {
            callees(conn, &ws.root_hash, symbol_id, path, name, indexed)
        })
    }


    pub fn impact(
        &self,
        workspace_root: &str,
        path: &str,
        depth: Option<u32>,
    ) -> Result<ImpactResult, CoreError> {
        let ws = resolve_workspace(workspace_root)?;
        self.read_dedicated(&ws, |conn, indexed| {
            impact(conn, &ws.root_hash, path, depth.unwrap_or(4), indexed)
        })
    }


    pub fn ingest_lsp_callers(
        &self,
        workspace_root: &str,
        callee_symbol_id: i64,
        callee_name: &str,
        sites: Vec<LspCallSiteIn>,
    ) -> Result<IngestLspResult, CoreError> {
        let ws = resolve_workspace(workspace_root)?;
        self.with_conn(|conn| {
            ingest_lsp_callers(conn, &ws.root_hash, callee_symbol_id, callee_name, &sites)
        })
    }

}

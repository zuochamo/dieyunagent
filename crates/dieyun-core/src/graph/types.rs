use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SymbolHit {
    pub id: i64,
    pub path: String,
    pub kind: String,
    pub name: String,
    pub qualified_name: String,
    pub start_line: i64,
    pub end_line: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub score: Option<f64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SymbolSearchResult {
    pub ok: bool,
    pub indexed: bool,
    pub query: String,
    pub results: Vec<SymbolHit>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub needs_embed: Option<bool>,
    pub vector_search: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphStatusResult {
    pub ok: bool,
    pub indexed: bool,
    pub file_count: i64,
    pub edge_count: i64,
    pub symbol_count: i64,
    pub call_count: i64,
    pub symbol_vector_count: i64,
    pub symbol_embedding_model: Option<String>,
    pub indexed_at: i64,
    pub indexing: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub phase: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub files_done: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub files_total: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphStartIndexResult {
    pub started: bool,
    pub already_running: bool,
    #[serde(flatten)]
    pub status: GraphStatusResult,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportEdge {
    pub from: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub to: Option<String>,
    pub spec: String,
    pub line: i64,
    pub external: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModuleDepsResult {
    pub ok: bool,
    pub indexed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    pub dependencies: Vec<ImportEdge>,
    pub dependents: Vec<ImportEdge>,
    pub circular: Vec<Vec<String>>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CallSiteHit {
    pub caller_path: String,
    pub caller_symbol: String,
    pub callee_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub callee_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub callee_symbol_id: Option<i64>,
    pub line: i64,
    pub confidence: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CallGraphResult {
    pub ok: bool,
    pub indexed: bool,
    pub symbol: Option<SymbolHit>,
    pub sites: Vec<CallSiteHit>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImpactResult {
    pub ok: bool,
    pub indexed: bool,
    pub path: String,
    pub affected_files: Vec<String>,
    pub depth: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspCallSiteIn {
    pub caller_path: String,
    pub line: i64,
    #[serde(default)]
    pub caller_symbol: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IngestLspResult {
    pub ok: bool,
    pub ingested: i64,
    pub call_count: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoMapFileHit {
    pub path: String,
    pub symbol_count: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoMapEdgeHit {
    pub from: String,
    pub to: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoMapHubSymbol {
    pub id: i64,
    pub path: String,
    pub kind: String,
    pub name: String,
    pub qualified_name: String,
    pub start_line: i64,
    pub call_refs: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoMapResult {
    pub ok: bool,
    pub indexed: bool,
    pub hub_files: Vec<RepoMapFileHit>,
    pub hub_symbols: Vec<RepoMapHubSymbol>,
    pub edges: Vec<RepoMapEdgeHit>,
    pub circular: Vec<Vec<String>>,
    pub markdown: String,
}

#[derive(Debug, Clone)]
pub struct ParsedImport {
    pub spec: String,
    pub line: i64,
}

#[derive(Debug, Clone)]
pub struct ParsedSymbol {
    pub name: String,
    pub kind: String,
    pub line: i64,
    pub end_line: i64,
}

#[derive(Debug, Clone)]
pub struct ParsedCall {
    pub callee: String,
    pub line: i64,
}

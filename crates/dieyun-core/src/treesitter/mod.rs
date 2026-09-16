//! Tree-sitter 结构切块与图抽取（失败时调用方回退到行窗 / 启发式）。

mod chunk;
mod extract;
mod lang;

pub use chunk::{iter_chunk_slices, structural_chunk_ranges};
pub use extract::extract_graph_ast;
pub use lang::SourceLang;

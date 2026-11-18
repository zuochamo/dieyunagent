//! Tree-sitter 结构切块与图抽取（**抽取的唯一实现**；失败时调用方跳过该文件）。
//!
//! 「失败回退到启发式」那套已删除（2026-11-18 抽取层二选一）：同一批语言、同样的三样产出，
//! 两套实现只能靠一条 parity 用例手工对齐，而启发式只在**坏文件**上运行 —— 猜出来的边
//! 既会漏也会错。现在 AST 抽不出来就跳过，且不记 mtime（下次保存再试）。

mod chunk;
mod extract;
mod lang;

pub use chunk::{iter_chunk_slices, structural_chunk_ranges};
pub use extract::{extract_graph_ast, AstGraphExtract};
pub use lang::SourceLang;

//! 代码索引与结构图：切块、FTS 检索、调用图、tree-sitter 抽取。
//!
//! 依赖方向由 Cargo 强制：只许依赖 dieyun-base 与更下层。

pub mod codebase_db;
pub mod index;
pub mod graph;
pub mod treesitter;

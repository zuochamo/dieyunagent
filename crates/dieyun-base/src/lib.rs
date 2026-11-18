//! dieyun-core 的底座：错误、共享常量、观测、SQLite、schema、配置、向量后端、折叠、FTS。
//!
//! 为什么单独成 crate：这些都是**下层的下层**（`crate::error` 被 15 个模块引用），
//! 放在同一个编译单元里时，任何上层模块都能顺手依赖它们而不会有人反对；
//! 拆出来之后「谁能依赖谁」由 Cargo 说了算，不用靠自觉。

pub mod blocking;
pub mod compaction;
pub mod config;
pub mod db_schema;
pub mod embedding;
pub mod error;
pub mod fts;
pub mod obs;
pub mod shared;
pub mod sqlite;

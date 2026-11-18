// 底座已在 `dieyun-base`：**路径原地保留**（`crate::error::…` / `crate::config::…`
// 这些引用一行都不用改），但依赖方向从此由 Cargo 强制。
pub use dieyun_base::{
    blocking,
    compaction,
    config,
    db_schema,
    embedding,
    error,
    fts,
    obs,
    shared,
    sqlite,
};

pub use dieyun_memory::memory;

pub use dieyun_codebase::{    codebase_db,
    index,
    graph,
    treesitter,};


pub use dieyun_runtime::{    agent,
    planner,
    rpc,
    fs_ops,};

use config::AppConfig;

pub fn new_state(config: AppConfig) -> rpc::AppState {
    rpc::AppState::new(config)
}

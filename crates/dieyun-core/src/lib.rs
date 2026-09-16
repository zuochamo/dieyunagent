#![allow(clippy::redundant_field_names)]
#![allow(clippy::needless_question_mark)]
#![allow(clippy::manual_clamp)]
#![allow(clippy::type_complexity)]
#![allow(clippy::manual_find)]
#![allow(clippy::too_many_arguments)]
#![allow(clippy::manual_contains)]
#![allow(clippy::collapsible_if)]
#![allow(clippy::while_let_on_iterator)]
#![allow(clippy::blocks_in_conditions)]
#![allow(clippy::cmp_owned)]
#![allow(clippy::unnecessary_lazy_evaluations)]
#![allow(clippy::format_in_format_args)]
#![allow(clippy::derivable_impls)]
#![allow(clippy::map_identity)]
#![allow(clippy::needless_range_loop)]
#![allow(clippy::trim_split_whitespace)]

pub mod agent;
pub mod compaction;
pub mod config;
pub mod embedding;
pub mod error;
pub mod fs_ops;
pub mod graph;
pub mod index;
pub mod memory;
pub mod planner;
pub mod rpc;
pub mod treesitter;

use config::AppConfig;

pub fn new_state(config: AppConfig) -> rpc::AppState {
    rpc::AppState::new(config)
}

//! 运行时：agent 主循环、planner、RPC 分派与 handler、fs 动作。
//!
//! 依赖方向由 Cargo 强制：只许依赖 dieyun-base 与更下层。

pub mod agent;
pub mod planner;
pub mod rpc;
pub mod fs_ops;

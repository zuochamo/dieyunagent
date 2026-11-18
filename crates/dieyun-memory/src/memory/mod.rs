mod agent;
mod goal;
mod misc;
mod projects;
mod schema;
mod snapshot;

pub use snapshot::RequestSnapshotInput;

use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use dieyun_base::embedding::EmbeddingConfig;
use dieyun_base::sqlite::SqliteHandle;

const MEMORY_EMBED_TEXT_MAX: usize = 6000;
const GLOBAL_MEMORY_SCOPE: &str = "global";

/// 后台修剪周期。原实现只在 `MemoryStore::open()` 跑一次 —— 长驻进程的
/// `agent_runs` / `agent_traces` 等于没有上限，可以涨到任意大小。
const PRUNE_INTERVAL: Duration = Duration::from_secs(30 * 60);

/// 启动后先等一会儿再修剪，避开 serve-stdio 启动与首批 RPC 的锁竞争。
const PRUNE_STARTUP_DELAY: Duration = Duration::from_secs(60);

/// 悬空归纳作业的判定阈值：`pending` 且开始时间早于 now - 该值 → 判 failed。
/// 真实归纳是秒到分钟级，超过 30 分钟还 pending 只可能是进程已经退出。
const STALE_CONSOLIDATION_JOB_MS: i64 = 30 * 60 * 1000;

/// `agent_runs` 里 `running` 行的存活判据：`running` 且 `updated_at` 早于 now - 该值 → 判 stopped。
/// agent loop 每 2.5s 会 upsert 一次同源快照（含 `state_snapshot`），2 分钟没有任何更新的
/// running 行不可能是活的 —— 只可能是进程被 kill / 重启，Rust 没机会写终态。
/// 留 2 分钟余量而不是 0：同一个库理论上可能被两个 core 进程看到（headless 共用 userData），
/// 判据必须是「陈旧」而不是「不是本进程起的」。
const STALE_AGENT_RUN_MS: i64 = 2 * 60 * 1000;

// —— impl MemoryStore 按职责拆分（2026-11-17）：纯机械搬运，语义未改 ——
// 各域在 `store` / `session` / `longmem` / `recall` / `archive` / `meta` 里各自 `impl MemoryStore`；
// 剪枝任务并进 `misc`（那里本来就是「维护 / 自愈」的家）。
// 兄弟模块用 `use super::*;` 拿到对方的 pub(crate) 项，所以「原来互相看得到」的现在仍然看得到；
// 对外（rpc）只有 `pub fn` 可见，口径不变。
mod store;
mod session;
mod longmem;
mod recall;
mod archive;
mod meta;

// 搬出去的东西重新导出：`use super::*` 与 `tests` 都靠它，名字集合与拆分前一致。
pub(crate) use store::*;
pub(crate) use longmem::*;
pub(crate) use recall::*;
pub(crate) use meta::*;

#[derive(Clone)]
pub struct MemoryStore {
    db_path: PathBuf,
    embedding: std::sync::Arc<Mutex<EmbeddingConfig>>,
    /// 库生命周期归口到 `SqliteHandle`（写入连接 + 池化读连接 + 长任务连接），
    /// 记忆侧不再自己持有裸 `Connection` 和一把私锁。
    db: std::sync::Arc<SqliteHandle>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionRow {
    pub id: String,
    pub updated_at: i64,
    pub title: Option<String>,
    /// 标题来源（`heuristic` / `ai` / `user`）。AI 标题的「只生成一次」判据在这里，
    /// 见 [`MemoryStore::set_session_title`]。
    pub title_source: Option<String>,
    pub preview: Option<String>,
    pub archived: bool,
    pub workspace_path: Option<String>,
    /// 这个会话是不是「机器开的一轮」在跑：**最早**一条带 `trigger` 的 user 行的
    /// `trigger.kind`（`schedule` / `goal` / `alive` …）；纯人聊的会话为 None。
    ///
    /// 为什么不只看首条消息：计划会话常是「先在聊天里聊了两句，再被绑成定时任务」，
    /// 活体心跳会话也可能是复用一条已有会话——只看首条就会把这类会话当成纯人聊。
    /// 也不反过来取「最新一条」：目标续跑会在定时会话里持续追加 `goal` 轮，
    /// 最新一条会让图标在「时钟 / 目标」之间来回跳。取最早的那次机器触发＝这个会话
    /// 「属于哪一种自动化」，稳定且可解释。
    ///
    /// 与标题的 `planName` 同源（同一份 `【叠云meta】`），Renderer 不再自己扫消息、
    /// 也不靠标题前缀猜。`get_session` / `session_create` 不返它（那里没有消息可看）。
    pub trigger_kind: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageRow {
    pub id: i64,
    pub session_id: String,
    pub role: String,
    pub content: String,
    /// 该轮真思考（与 `content` 分列）。历史重建默认不读它。
    pub reasoning: Option<String>,
    pub created_at: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppendMessageResult {
    pub local_msg_id: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompactionArchiveInput {
    pub session_id: Option<String>,
    pub workspace_path: Option<String>,
    pub tokens_before: Option<i64>,
    pub tokens_after: Option<i64>,
    pub summary: Option<Value>,
    pub folded_transcript: Option<String>,
    pub folded_text: Option<String>,
}

/// 批量写入的一条（`memory.long_add_many`）。字段口径与单条 `memory.long_add`
/// 完全一致，只是 `expiresAt` 不在批量里（归纳器的条目从不带过期时间）。
///
/// `content` 给默认值：缺字段 / 空串都归成「空条目」，由批量入口记一条 `skipped`，
/// 而不是让**整批**因为一条脏数据 INVALID_PARAMS 掉光。
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LongMemoryInput {
    #[serde(default)]
    pub content: String,
    #[serde(default)]
    pub kind: Option<String>,
    #[serde(default)]
    pub importance: Option<i64>,
    #[serde(default)]
    pub metadata: Option<Value>,
}

pub(crate) fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn rand_suffix() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let n = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.subsec_nanos())
        .unwrap_or(0);
    format!("{:x}", n)
}

#[cfg(test)]
#[path = "tests.rs"]
mod tests;

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

use crate::embedding::EmbeddingConfig;
use crate::sqlite::SqliteHandle;

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
mod tests {
    use super::*;
    // 测试模块真正用到的名字（不要靠父模块的私有 use）。
    use rusqlite::{params, Connection};
    use serde_json::json;
    use crate::error::CoreError;

    #[test]
    fn title_from_packed_user_message() {
        let packed = "【叠云meta】{\"inputText\":\"写一个俄罗斯方块\"}\n写一个俄罗斯方块";
        assert_eq!(
            title_from_user_content(packed).as_deref(),
            Some("写一个俄罗斯方块")
        );
        assert!(title_needs_repair(Some("【叠云meta】{\"inputText\":\"x\"")));
    }

    /// `kind` 只由「模型给的 kind」与「凭据形状」决定，不再按话题词猜 private。
    /// 旧词表会把工程事实判成 private，而 private 的下游是「永不注入 + 永不写记忆文件」。
    #[test]
    fn memory_kind_trusts_model_then_credential_shape() {
        // 工程事实 → normal（旧词表里 `数据库`/`内网`/`host`/`邮箱` 会把它们判成 private）
        assert_eq!(
            detect_memory_kind("连库走 5432，内网是 10.0.0.0/8", None),
            "normal"
        );
        assert_eq!(detect_memory_kind("报警发到 ops@example.com", None), "normal");
        assert_eq!(detect_memory_kind("host 名是 build-01", None), "normal");

        // 凭据形状：即使模型标了 normal 也升级为 secret（代价不对称，宁可少注入一条）
        assert_eq!(detect_memory_kind("password=hunter2", None), "secret");
        assert_eq!(detect_memory_kind("密码：hunter2", Some("normal")), "secret");
        assert_eq!(
            detect_memory_kind("DATABASE_URL=postgres://u:p@db.internal:5432/app", None),
            "secret"
        );
        assert_eq!(detect_memory_kind("key 是 sk-abcdefghijklmnop", None), "secret");

        // 隐私与否由模型判断：合法 kind 原样采纳，非法值退回 normal
        assert_eq!(
            detect_memory_kind("用户手机号我不要存", Some("private")),
            "private"
        );
        assert_eq!(detect_memory_kind("提交前跑 npm test", Some("PROJECT")), "normal");
    }

    /// 计划轮标题读 meta 的 `trigger.planName`，不再靠正文里的中文抬头猜。
    #[test]
    fn plan_turn_title_comes_from_meta_trigger() {
        let packed = "【叠云meta】{\"trigger\":{\"kind\":\"schedule\",\"planId\":\"p1\",\"planName\":\"每日构建巡检\",\"at\":\"2026-11-03T02:00:00.000Z\"}}\n[计划 · 每日构建巡检]\n2026/11/3 10:00:00 · 定时触发\n\n检查夜间构建";
        assert_eq!(
            title_from_user_content(packed).as_deref(),
            Some("每日构建巡检")
        );

        // 没有 meta 的历史行：抬头按本仓自己的格式精确跳过，落到正文第一句
        let legacy = "[计划 · 每日构建巡检]\n2026/11/3 10:00:00 · 定时触发\n\n检查夜间构建";
        assert_eq!(title_from_user_content(legacy).as_deref(), Some("检查夜间构建"));

        // 用户正文里恰好出现「·」和「定时触发」不该被当成抬头跳过（旧写法会）
        let user_text = "每天 9:00 · 定时触发 这条计划为什么没跑";
        assert_eq!(
            title_from_user_content(user_text).as_deref(),
            Some("每天 9:00 · 定时触发 这条计划为什么没跑")
        );
    }

    /// 侧栏「哪一类会话」读的是最早一条带 `trigger` 的 user 行的 `kind`：
    /// 定时/心跳会话带 kind，人自己打的字是 None（不扫标题、不猜正文）。
    /// 「先聊两句、后来被绑成定时任务」的会话同样要认出 schedule。
    #[test]
    fn session_trigger_kind_comes_from_earliest_triggered_user_turn() {
        let db = std::env::temp_dir().join(format!("dieyun-mem-trigger-{}.sqlite", now_ms()));
        let _ = std::fs::remove_file(&db);
        let store = MemoryStore::open(db.clone(), EmbeddingConfig::default()).unwrap();

        let plan = store.create_session(None, None).unwrap();
        store
            .append_message(
                &plan.id,
                "user",
                "【叠云meta】{\"trigger\":{\"kind\":\"schedule\",\"planId\":\"p1\",\"planName\":\"每日构建巡检\",\"at\":\"2026-11-03T02:00:00.000Z\"}}\n[计划 · 每日构建巡检]\n检查夜间构建",
                None,
            )
            .unwrap();

        // 计划会话绑到一条已有的人聊会话上：首条是人打的字，机器轮在后面
        let bound = store.create_session(None, None).unwrap();
        store
            .append_message(
                &bound.id,
                "user",
                "【叠云meta】{\"inputText\":\"hi\"}\nhi",
                None,
            )
            .unwrap();
        store
            .append_message(
                &bound.id,
                "assistant",
                "【叠云meta】{\"modelId\":\"m\"}\n在的，需要我做什么？",
                None,
            )
            .unwrap();
        store
            .append_message(
                &bound.id,
                "user",
                "【叠云meta】{\"trigger\":{\"kind\":\"goal\",\"planId\":\"p2\",\"planName\":\"收尾\"}}\n[计划 · 收尾]\n继续推进",
                None,
            )
            .unwrap();
        // 之后还有一轮定时触发：图标取**最早**那次（goal），不随后续轮跳动
        store
            .append_message(
                &bound.id,
                "user",
                "【叠云meta】{\"trigger\":{\"kind\":\"schedule\",\"planId\":\"p2\",\"planName\":\"收尾\"}}\n[计划 · 收尾]\n再跑一次",
                None,
            )
            .unwrap();

        let alive = store.create_session(None, None).unwrap();
        store
            .append_message(
                &alive.id,
                "user",
                "【叠云meta】{\"trigger\":{\"kind\":\"alive\",\"trigger\":\"internal\"}}\n[系统] 生命体征",
                None,
            )
            .unwrap();

        let human = store.create_session(None, None).unwrap();
        store
            .append_message(&human.id, "user", "帮我看看这个报错", None)
            .unwrap();

        let rows = store.list_sessions(10, false).unwrap();
        let kind = |id: &str| {
            rows.iter()
                .find(|r| r.id == id)
                .and_then(|r| r.trigger_kind.clone())
        };
        assert_eq!(kind(&plan.id).as_deref(), Some("schedule"));
        assert_eq!(kind(&bound.id).as_deref(), Some("goal"));
        assert_eq!(kind(&alive.id).as_deref(), Some("alive"));
        assert_eq!(kind(&human.id), None);
        let _ = std::fs::remove_file(db);
    }

    /// 落库 meta 只该存引用：base64 / data URL 进不了库（append_message 是唯一写库口）。
    #[test]
    fn sanitize_persisted_message_strips_meta_bytes() {
        let huge = "A".repeat(MESSAGE_META_STRING_MAX + 1);
        let packed = format!(
            "【叠云meta】{{\"inputText\":\"看图\",\"attachments\":[{{\"path\":\"/tmp/a.png\",\"_pasteBase64\":\"{huge}\",\"previewUrl\":\"blob:http://x/1\"}}]}}\n看图"
        );
        let cleaned = sanitize_persisted_message(&packed).expect("脏 meta 应当被清洗");
        assert!(!cleaned.contains(&huge), "base64 必须被丢弃");
        assert!(!cleaned.contains("blob:"), "临时 URL 必须被丢弃");
        assert!(cleaned.contains("\"path\":\"/tmp/a.png\""), "附件引用保留");
        assert!(cleaned.ends_with("\n看图"), "正文不受影响");

        // 干净的 meta 与没有 meta 的正文都不该被改写。
        assert!(sanitize_persisted_message("【叠云meta】{\"inputText\":\"x\"}\nx").is_none());
        assert!(sanitize_persisted_message("裸正文").is_none());
    }

    /// 历史脏数据由修剪线程顺手洗掉，且不碰没有 meta 的超长正文。
    #[test]
    fn purge_oversized_message_meta_repairs_legacy_rows() {
        let conn = Connection::open_in_memory().expect("memory db");
        schema::init_schema(&conn).expect("schema");
        conn.execute(
            "INSERT INTO sessions (id, updated_at, title) VALUES ('s1', 1, 't')",
            [],
        )
        .expect("session");
        let huge = "A".repeat(MESSAGE_META_STRING_MAX + 1);
        let dirty = format!(
            "【叠云meta】{{\"inputText\":\"看图\",\"attachments\":[{{\"path\":\"/tmp/a.png\",\"_pasteBase64\":\"{huge}\"}}]}}\n看图"
        );
        let long_body = format!(
            "【叠云meta】{{\"inputText\":\"x\"}}\n{}",
            "长".repeat(MESSAGE_META_STRING_MAX + 10)
        );
        for content in [dirty.as_str(), long_body.as_str()] {
            conn.execute(
                "INSERT INTO messages (session_id, role, content, created_at) VALUES ('s1', 'assistant', ?1, 1)",
                params![content],
            )
            .expect("legacy row");
        }
        assert_eq!(
            MemoryStore::purge_oversized_message_meta(&conn).expect("purge"),
            1,
            "只洗 meta 里有字节的那条"
        );
        let washed: String = conn
            .query_row("SELECT content FROM messages ORDER BY id LIMIT 1", [], |row| {
                row.get(0)
            })
            .expect("row");
        assert!(!washed.contains(&huge) && washed.ends_with("\n看图"));
        let untouched: String = conn
            .query_row(
                "SELECT content FROM messages ORDER BY id DESC LIMIT 1",
                [],
                |row| row.get(0),
            )
            .expect("row");
        assert_eq!(untouched, long_body, "无 meta 大正文原样保留");
    }

    /// 显式标题（AI 总结）必须盖得住启发式标题，并把来源记成 `ai` ——
    /// Node 侧靠这一列判断「这个会话已经有过模型标题，别再调一次模型」。
    #[test]
    fn set_session_title_overrides_heuristic_and_records_source() {
        let db = std::env::temp_dir().join(format!("dieyun-title-test-{}.sqlite", now_ms()));
        let _ = std::fs::remove_file(&db);
        let store = MemoryStore::open(db.clone(), EmbeddingConfig::default()).unwrap();
        let session = store.create_session(None, None).unwrap();
        store
            .append_message(&session.id, "user", "帮我修一下这个 bug", None)
            .unwrap();

        // 启发式标题先落库（首条用户消息切片）
        let row = store.get_session(&session.id).unwrap().unwrap();
        assert_eq!(row.title.as_deref(), Some("帮我修一下这个 bug"));
        assert_eq!(row.title_source.as_deref(), Some(TITLE_SOURCE_HEURISTIC));

        // 模型标题无条件覆盖
        let out = store
            .set_session_title(&session.id, "  修复登录崩溃\n多余的第二行  ", TITLE_SOURCE_AI)
            .unwrap();
        assert_eq!(out["updated"].as_i64(), Some(1));
        let row = store.get_session(&session.id).unwrap().unwrap();
        assert_eq!(row.title.as_deref(), Some("修复登录崩溃"), "只留首行并折叠空白");
        assert_eq!(row.title_source.as_deref(), Some(TITLE_SOURCE_AI));

        // 已有 ai 标题后，后续用户轮次的启发式写入不得覆盖它
        store
            .append_message(&session.id, "user", "再改一处", None)
            .unwrap();
        let row = store.get_session(&session.id).unwrap().unwrap();
        assert_eq!(row.title.as_deref(), Some("修复登录崩溃"));

        // 空标题 / 未知来源都拒绝，且不弄脏现有标题
        assert!(store.set_session_title(&session.id, "   ", TITLE_SOURCE_AI).is_err());
        assert!(store
            .set_session_title(&session.id, "x", "robot")
            .is_err());
        assert!(store.set_session_title("", "x", TITLE_SOURCE_AI).is_err());
        let row = store.get_session(&session.id).unwrap().unwrap();
        assert_eq!(row.title.as_deref(), Some("修复登录崩溃"));

        let _ = std::fs::remove_file(&db);
    }

    /// 标题判据只有一个：`title_needs_repair`。它同时管「补启发式标题」(`touch_session`)
    /// 与「首条用户消息改标题」(`maybe_set_title_from_user_message`)。
    ///
    /// 守住三件事（重构自「两段逐字重复的 SQL CASE + 三条死条件」）：
    /// 1. 占位标题会被启发式标题覆盖；
    /// 2. 已有真标题不被覆盖，`title_source` 也不动（不能出现「来源换了、标题没换」）；
    /// 3. `[计划] xx` 这类语义标题不是占位值，撤回/新消息都不改它。
    #[test]
    fn title_repair_judgement_lives_in_one_place() {
        let db = std::env::temp_dir().join(format!("dieyun-title-repair-{}.sqlite", now_ms()));
        let _ = std::fs::remove_file(&db);
        let store = MemoryStore::open(db.clone(), EmbeddingConfig::default()).unwrap();
        let session = store.create_session(None, None).unwrap();
        let force_title = |title: &str, source: &str| {
            store
                .with_conn(|conn| {
                    conn.execute(
                        "UPDATE sessions SET title = ?1, title_source = ?2 WHERE id = ?3",
                        params![title, source, session.id],
                    )?;
                    Ok(())
                })
                .unwrap();
        };

        // 1) 占位标题：补齐时被启发式标题覆盖
        force_title("对话", TITLE_SOURCE_HEURISTIC);
        store
            .touch_session(&session.id, Some("帮我看看构建为什么挂了"))
            .unwrap();
        let row = store.get_session(&session.id).unwrap().unwrap();
        assert_eq!(row.title.as_deref(), Some("帮我看看构建为什么挂了"));
        assert_eq!(row.title_source.as_deref(), Some(TITLE_SOURCE_HEURISTIC));

        // 2) 已有真标题：再补不覆盖，来源也不变
        store.touch_session(&session.id, Some("完全不同的标题")).unwrap();
        let row = store.get_session(&session.id).unwrap().unwrap();
        assert_eq!(row.title.as_deref(), Some("帮我看看构建为什么挂了"), "真标题不被启发式覆盖");
        assert_eq!(row.title_source.as_deref(), Some(TITLE_SOURCE_HEURISTIC));

        // 3) [计划] xx 是**内部抬头**：用户真说话后要洗成正文标题。
        //    这是旧行为（旧守卫里 !starts_with("[计划]") 的作用），拆判据时不能当冗余删掉。
        force_title("[计划] 夜间构建巡检", TITLE_SOURCE_HEURISTIC);
        store
            .append_message(&session.id, "user", "这轮正文要成为标题", None)
            .unwrap();
        let row = store.get_session(&session.id).unwrap().unwrap();
        assert_eq!(
            row.title.as_deref(),
            Some("这轮正文要成为标题"),
            "[计划] 抬头被下一条用户消息洗掉（旧行为）"
        );

        let _ = std::fs::remove_file(&db);
    }

    /// 往不存在的会话写消息要给稳定错误码，而不是把 SQLite 的外键串抛给界面
    /// （peer 会话链接过期时，用户看到的就是「发送失败 · FOREIGN KEY constraint failed」）。
    #[test]
    fn append_message_reports_missing_session() {
        let db = std::env::temp_dir().join(format!("dieyun-append-missing-{}.sqlite", now_ms()));
        let _ = std::fs::remove_file(&db);
        let store = MemoryStore::open(db.clone(), EmbeddingConfig::default()).unwrap();
        let session = store.create_session(None, None).unwrap();
        store
            .append_message(&session.id, "user", "在的会话", None)
            .unwrap();

        let err = store
            .append_message("s-does-not-exist", "user", "写不进去", None)
            .unwrap_err();
        match err {
            CoreError::Rpc { code, .. } => assert_eq!(code, "SESSION_NOT_FOUND"),
            other => panic!("应给出 SESSION_NOT_FOUND，实际: {other:?}"),
        }

        let _ = std::fs::remove_file(&db);
    }

    #[test]
    fn handoff_roundtrip_and_latest() {        let db = std::env::temp_dir().join(format!("dieyun-handoff-test-{}.sqlite", now_ms()));
        let _ = std::fs::remove_file(&db);
        let store = MemoryStore::open(db.clone(), EmbeddingConfig::default()).unwrap();
        let a = store.create_session(Some("会话A"), None).unwrap();
        let b = store
            .create_session(Some("会话B"), Some("ssh://dieyunx@192.168.31.62/srv/repo"))
            .unwrap();

        // 空载荷拒绝
        assert!(store.handoff_save(&a.id, "t", "   ").is_err());

        store.handoff_save(&a.id, "会话A", "目标：做X\n未完成：Y").unwrap();
        std::thread::sleep(std::time::Duration::from_millis(5));
        store.handoff_save(&b.id, "会话B", "目标：做P").unwrap();

        // 精确取回
        let got = store.handoff_get(&a.id).unwrap().expect("a 的交接");
        assert_eq!(got["payload"].as_str().unwrap(), "目标：做X\n未完成：Y");
        assert_eq!(got["title"].as_str().unwrap(), "会话A");

        // latest：排除当前会话后取最新
        let latest = store.handoff_latest(Some(&b.id)).unwrap().expect("应取到 A");
        assert_eq!(latest["sessionId"].as_str().unwrap(), a.id);
        let latest_all = store.handoff_latest(None).unwrap().expect("应取到 B");
        assert_eq!(latest_all["sessionId"].as_str().unwrap(), b.id);
        // 交接带着来源会话的工作区：跨项目「继续上次」靠它挂到正确的仓库
        assert_eq!(
            latest_all["workspacePath"].as_str().unwrap(),
            "ssh://dieyunx@192.168.31.62/srv/repo"
        );
        assert!(got["workspacePath"].is_null());

        // 同会话重生成 → 覆盖（每会话最多一份）
        store.handoff_save(&a.id, "会话A", "更新后的交接").unwrap();
        let got2 = store.handoff_get(&a.id).unwrap().unwrap();
        assert_eq!(got2["payload"].as_str().unwrap(), "更新后的交接");

        // 领走即删：交接是一次性资源，第二次领同一份必须空手
        let taken = store.handoff_take(&a.id).unwrap().expect("第一次应领到");
        assert_eq!(taken["payload"].as_str().unwrap(), "更新后的交接");
        assert!(store.handoff_take(&a.id).unwrap().is_none(), "领过的交接不该再被领");
        assert!(store.handoff_get(&a.id).unwrap().is_none(), "领走 = 删掉");
        assert!(
            store.handoff_latest(None).unwrap().is_some_and(|v| v["sessionId"] == b.id),
            "领走 A 之后「最近一份」应该只剩 B"
        );

        // 会话删除要连带删掉它的交接：留着就是指向已消失会话的死账
        store.clear_session(&b.id).unwrap();
        assert!(store.handoff_latest(None).unwrap().is_none(), "B 删了，交接也该没了");

        let _ = std::fs::remove_file(&db);
    }

    #[test]
    fn memory_roundtrip() {
        let db = std::env::temp_dir().join(format!("dieyun-mem-test-{}.sqlite", now_ms()));
        let _ = std::fs::remove_file(&db);
        let store = MemoryStore::open(db.clone(), EmbeddingConfig::default()).unwrap();
        let session = store.create_session(Some("测试"), None).unwrap();
        store
            .append_message(&session.id, "user", "你好，Rust memory", None)
            .unwrap();
        store
            .append_message(
                &session.id,
                "assistant",
                "答复正文",
                Some("  这是该轮真思考  "),
            )
            .unwrap();
        // 空串与空白按「无」处理，统一落 NULL。
        store
            .append_message(&session.id, "assistant", "无思考轮", Some("   "))
            .unwrap();
        let msgs = store.recent_messages(&session.id, 10).unwrap();
        assert_eq!(msgs.len(), 3);
        assert_eq!(msgs[0].role, "user");
        assert_eq!(msgs[0].reasoning, None);
        assert_eq!(msgs[1].reasoning.as_deref(), Some("这是该轮真思考"));
        assert_eq!(msgs[2].reasoning, None);
        let _ = std::fs::remove_file(db);
    }

    #[test]
    fn recall_bumps_usage_counters() {
        // `access_count` / `last_used_at` 此前只有读者没有写者，衰减里的
        // `COALESCE(access_count, 0) = 0` 于是恒成立。这里锁住唯一写入口的行为。
        let db = std::env::temp_dir().join(format!("dieyun-mem-usage-{}.sqlite", now_ms()));
        let _ = std::fs::remove_file(&db);
        let store = MemoryStore::open(db.clone(), EmbeddingConfig::default()).unwrap();
        store
            .add_long_memory(
                "用户偏好中文回复并给出简短结论",
                "user",
                None,
                Some("global"),
                Some(3),
                None,
                None,
                None,
            )
            .unwrap();
        let before = store.recent_long_memories(5, Some("global")).unwrap();
        assert_eq!(before.len(), 1);
        assert_eq!(before[0]["access_count"].as_i64().unwrap_or(0), 0);
        assert!(before[0]["last_used_at"].is_null());
        // 召回结果就是这些行：bump 一下等价于「这条被用过」
        store.bump_memory_usage(&before).unwrap();
        store.bump_memory_usage(&before).unwrap();
        let after = store.recent_long_memories(5, Some("global")).unwrap();
        assert_eq!(after[0]["access_count"].as_i64().unwrap(), 2);
        assert!(after[0]["last_used_at"].as_i64().unwrap() > 0);
        // 空白输入不该触发任何写入
        store.bump_memory_usage(&[]).unwrap();
        let _ = std::fs::remove_file(db);
    }

    #[test]
    fn session_memories_are_traceable_and_forgettable() {
        // 归纳器写的记忆是项目级/用户级的，库里原本没有任何「哪个会话写的」的痕迹：
        // 这里锁住唯一写入口（session_id）与两个会话维度查询/归档的行为。
        let db = std::env::temp_dir().join(format!("dieyun-mem-session-{}.sqlite", now_ms()));
        let _ = std::fs::remove_file(&db);
        let store = MemoryStore::open(db.clone(), EmbeddingConfig::default()).unwrap();
        store
            .add_long_memory(
                "本次会话决定用 JWT 而不是 session cookie",
                "auto_consolidation",
                None,
                Some("project:/ws/a"),
                Some(3),
                None,
                None,
                Some("sess-a"),
            )
            .unwrap();
        store
            .add_long_memory(
                "另一个会话的独立结论",
                "auto_consolidation",
                None,
                Some("project:/ws/a"),
                Some(3),
                None,
                None,
                Some("sess-b"),
            )
            .unwrap();
        // 无 session 的历史写入口径必须仍然可用（NULL 不算任何会话）
        store
            .add_long_memory("旧记忆没有会话来源", "user", None, Some("global"), Some(3), None, None, None)
            .unwrap();

        let a = store.long_memories_by_session("sess-a", 20).unwrap();
        assert_eq!(a.len(), 1);
        assert!(a[0]["content"].as_str().unwrap().contains("JWT"));
        assert_eq!(store.long_memories_by_session("sess-b", 20).unwrap().len(), 1);
        assert!(store.long_memories_by_session("  ", 20).unwrap().is_empty());

        // 软归档：只影响该会话的条目，可恢复
        assert_eq!(store.archive_long_memories_by_session("sess-a").unwrap(), 1);
        assert!(store.long_memories_by_session("sess-a", 20).unwrap().is_empty());
        assert_eq!(store.long_memories_by_session("sess-b", 20).unwrap().len(), 1);
        assert_eq!(store.archive_long_memories_by_session("sess-a").unwrap(), 0);
        assert!(store.recent_long_memories(10, Some("global")).unwrap().len() >= 1);

        // 同内容再次写入会复活既有行，并把来源会话补上（COALESCE 不覆盖旧来源）
        store
            .add_long_memory(
                "另一个会话的独立结论",
                "auto_consolidation",
                None,
                Some("project:/ws/a"),
                Some(3),
                None,
                None,
                Some("sess-c"),
            )
            .unwrap();
        assert_eq!(store.long_memories_by_session("sess-c", 20).unwrap().len(), 0);
        assert_eq!(store.long_memories_by_session("sess-b", 20).unwrap().len(), 1);
        let _ = std::fs::remove_file(db);
    }

    #[tokio::test]
    async fn write_policy_gates_low_value_and_exact_duplicates() {
        // 写入策略（唯一政策点）：自动归纳的低价值条目不落库；显式写入不受此闸；
        // 完全相同的正文仍然只留一行（近重复判定需要 embedding，测试环境无向量能力，走 none 分支）。
        let db = std::env::temp_dir().join(format!("dieyun-mem-policy-{}.sqlite", now_ms()));
        let _ = std::fs::remove_file(&db);
        let store = MemoryStore::open(db.clone(), EmbeddingConfig::default()).unwrap();

        let skipped = store
            .add_long_memory_deduped(
                "顺手打开了个网页",
                "auto_consolidation",
                None,
                Some("global"),
                Some(2),
                None,
                None,
                Some("sess-1"),
            )
            .await
            .unwrap();
        assert_eq!(skipped.get("skipped").and_then(|v| v.as_str()), Some("low_importance"));
        assert_eq!(store.recent_long_memories(10, Some("global")).unwrap().len(), 0);

        // 显式写入（非 consolidation）即使 importance=1 也要落库：用户说过的就是事实
        let kept = store
            .add_long_memory_deduped(
                "我的猫叫咪咪",
                "user",
                None,
                Some("global"),
                Some(1),
                None,
                None,
                Some("sess-1"),
            )
            .await
            .unwrap();
        assert_eq!(kept.get("skipped"), None);
        assert!(kept.get("localMemoryId").and_then(|v| v.as_i64()).unwrap_or(0) > 0);
        assert_eq!(store.recent_long_memories(10, Some("global")).unwrap().len(), 1);

        // 归纳器写 importance=3 通过闸门
        let ok = store
            .add_long_memory_deduped(
                "camera 模块导出统一走 runtime 配置",
                "auto_consolidation",
                None,
                Some("global"),
                Some(3),
                None,
                None,
                Some("sess-2"),
            )
            .await
            .unwrap();
        assert_eq!(ok.get("skipped"), None);
        assert_eq!(store.recent_long_memories(10, Some("global")).unwrap().len(), 2);

        // 正文完全相同 → 复用既有行，不再新增
        let dup = store
            .add_long_memory_deduped(
                "camera 模块导出统一走 runtime 配置",
                "auto_consolidation",
                None,
                Some("global"),
                Some(3),
                None,
                None,
                Some("sess-3"),
            )
            .await
            .unwrap();
        assert_eq!(dup.get("duplicate"), Some(&Value::Bool(true)));
        assert_eq!(store.recent_long_memories(10, Some("global")).unwrap().len(), 2);
        let _ = std::fs::remove_file(db);
    }

    /// 批量写入（归纳器一次 8 条）：逐条结果按入参顺序返回，政策与单条完全一致。
    ///
    /// 存在的理由是把「8 次端点往返」压成「1 次」—— 端点串行时一条 34–44s，
    /// 8 条就是几分钟独占端点，期间所有交互查询排队超时。
    #[tokio::test]
    async fn batch_write_keeps_input_order_and_shares_single_write_policy() {
        let db = std::env::temp_dir().join(format!("dieyun-mem-batch-{}.sqlite", now_ms()));
        let _ = std::fs::remove_file(&db);
        let store = MemoryStore::open(db.clone(), EmbeddingConfig::default()).unwrap();

        let items = vec![
            LongMemoryInput {
                content: "第一条事实：Samba 挂载 -13 先查账号".into(),
                importance: Some(3),
                ..Default::default()
            },
            LongMemoryInput {
                content: "   ".into(),
                ..Default::default()
            },
            LongMemoryInput {
                // 自动归纳 + importance 2 → 低价值闸拦下（与单条入口同一个判定）
                content: "顺手打开了个网页".into(),
                importance: Some(2),
                ..Default::default()
            },
            LongMemoryInput {
                content: "第二条事实：testparm -s 看共享段".into(),
                importance: Some(4),
                ..Default::default()
            },
        ];
        let out = store
            .add_long_memories_deduped(&items, "auto_consolidation", Some("global"), Some("sess-b"))
            .await
            .unwrap();
        let results = out.get("results").and_then(|v| v.as_array()).expect("results");
        assert_eq!(results.len(), 4, "逐条结果必须与入参一一对应");

        assert!(results[0].get("localMemoryId").and_then(|v| v.as_i64()).unwrap_or(0) > 0);
        assert_eq!(results[1].get("skipped").and_then(|v| v.as_str()), Some("empty_content"));
        assert_eq!(
            results[2].get("skipped").and_then(|v| v.as_str()),
            Some("low_importance")
        );
        assert!(results[3].get("localMemoryId").and_then(|v| v.as_i64()).unwrap_or(0) > 0);

        // 只有过了闸的两条真的落库（顺序也按入参）
        let rows = store.recent_long_memories(10, Some("global")).unwrap();
        assert_eq!(rows.len(), 2);
        assert!(rows
            .iter()
            .any(|r| r.to_string().contains("Samba 挂载 -13")));
        assert!(rows.iter().any(|r| r.to_string().contains("testparm -s")));

        // 同内容再批量写一次：完全重复的正文仍只留一行（与单条路径同一份判定）
        let again = store
            .add_long_memories_deduped(&items, "auto_consolidation", Some("global"), None)
            .await
            .unwrap();
        let again_rows = again.get("results").and_then(|v| v.as_array()).expect("results");
        assert_eq!(
            again_rows[0].get("duplicate"),
            Some(&Value::Bool(true)),
            "完全相同的正文复用既有行"
        );
        assert_eq!(store.recent_long_memories(10, Some("global")).unwrap().len(), 2);
        let _ = std::fs::remove_file(db);
    }

    #[test]
    fn reconcile_rekeys_legacy_path_scopes_to_project_ids() {
        // 老库的 scope 是路径字符串。projects 表登记了根路径后，能正向复算出这些历史 key，
        // 于是整批重挂到 project:<id>（而不是把可认领的行当孤儿埋掉）。
        let db = std::env::temp_dir().join(format!("dieyun-mem-rescope-{}.sqlite", now_ms()));
        let _ = std::fs::remove_file(&db);
        let store = MemoryStore::open(db.clone(), EmbeddingConfig::default()).unwrap();

        let root = "E:\\repo\\legacyproj";
        let proj = store.resolve_project(root, None).unwrap();
        let id = proj.get("projectId").and_then(|v| v.as_i64()).unwrap();
        let legacy = super::projects::legacy_scope_key(root);
        assert!(legacy.starts_with("project:E:\\repo"), "短路径用原路径形态");

        for (content, scope) in [
            ("老行 1", legacy.as_str()),
            ("老行 2", legacy.as_str()),
            ("认领不了的行", "project:E:\\gone\\nowhere"),
        ] {
            store
                .test_conn()
                .execute(
                    "INSERT INTO long_memories (content, source, scope, kind, importance, status, created_at)
                     VALUES (?1, 'auto_consolidation', ?2, 'normal', 3, 'active', ?3)",
                    params![content, scope, now_ms()],
                )
                .unwrap();
        }

        let res = store.reconcile_memory_ledger(now_ms()).unwrap();
        assert_eq!(res.get("rescopedMemories").and_then(|v| v.as_i64()), Some(2));

        let rescoped: i64 = store
            .test_conn()
            .query_row(
                "SELECT COUNT(*) FROM long_memories WHERE scope = ?1",
                params![format!("project:{id}")],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(rescoped, 2, "两条老行都挂到了 project:<id>");
        let untouched: i64 = store
            .test_conn()
            .query_row(
                "SELECT COUNT(*) FROM long_memories WHERE scope = 'project:E:\\gone\\nowhere' AND status = 'active'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(untouched, 1, "认领不了的行不动它（不猜、不删）");

        // 幂等：再跑一次不再改
        let again = store.reconcile_memory_ledger(now_ms()).unwrap();
        assert_eq!(again.get("rescopedMemories").and_then(|v| v.as_i64()), Some(0));

        let _ = std::fs::remove_file(db);
    }

    #[test]
    fn reconcile_heals_orphan_scope_dangling_jobs_and_stale_runs() {
        // 两条都是「进程没跑完」留下的脏数据：孤儿 scope='project' 永远召回不到，
        // 悬空 pending 作业让账本永远显示「还在跑」。自愈必须幂等且不动新鲜作业。
        let db = std::env::temp_dir().join(format!("dieyun-mem-reconcile-{}.sqlite", now_ms()));
        let _ = std::fs::remove_file(&db);
        let store = MemoryStore::open(db.clone(), EmbeddingConfig::default()).unwrap();

        // 旧版本按路径算 scope 失败留下的字面量 project
        store
            .test_conn()
            .execute(
                "INSERT INTO long_memories (content, source, scope, kind, importance, status, created_at)
                 VALUES ('孤儿项目记忆', 'auto_consolidation', 'project', 'normal', 3, 'active', ?1)",
                params![now_ms()],
            )
            .unwrap();
        let stale = store.create_consolidation_job(Some("global"), Some("task"), None).unwrap();
        let stale_id = stale.get("jobId").and_then(|v| v.as_i64()).unwrap();
        let fresh = store.create_consolidation_job(Some("global"), Some("task"), None).unwrap();
        let fresh_id = fresh.get("jobId").and_then(|v| v.as_i64()).unwrap();
        store
            .test_conn()
            .execute(
                "UPDATE memory_consolidation_jobs SET started_at = ?1 WHERE id = ?2",
                params![now_ms() - 60 * 60 * 1000, stale_id],
            )
            .unwrap();

        let res = store.reconcile_memory_ledger(now_ms()).unwrap();
        assert_eq!(res.get("orphanScopes").and_then(|v| v.as_i64()), Some(1));
        assert_eq!(res.get("staleJobs").and_then(|v| v.as_i64()), Some(1));

        let orphan_status: String = store
            .test_conn()
            .query_row(
                "SELECT status FROM long_memories WHERE scope = 'project'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(orphan_status, "archived");
        let stale_status: String = store
            .test_conn()
            .query_row(
                "SELECT status FROM memory_consolidation_jobs WHERE id = ?1",
                params![stale_id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(stale_status, "failed");
        let fresh_status: String = store
            .test_conn()
            .query_row(
                "SELECT status FROM memory_consolidation_jobs WHERE id = ?1",
                params![fresh_id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(fresh_status, "pending", "新鲜作业不能被自愈判死");

        // 僵尸运行行：进程被 kill / 重启时 `agent_runs.status` 永远停在 running，
        // 既骗 `get_latest_agent_state`，又永远进不了「已结束」修剪。
        store.touch_session("s-reconcile-run", None).unwrap();
        let now = now_ms();
        for (id, updated, summary) in [
            ("run-stale", now - 60 * 60 * 1000, "运行中"),
            ("run-fresh", now, "运行中"),
        ] {
            store
                .test_conn()
                .execute(
                    "INSERT INTO agent_runs (id, session_id, status, summary, created_at, updated_at)
                     VALUES (?1, 's-reconcile-run', 'running', ?3, ?2, ?2)",
                    params![id, updated, summary],
                )
                .unwrap();
        }
        let res_runs = store.reconcile_memory_ledger(now).unwrap();
        assert_eq!(res_runs.get("staleRuns").and_then(|v| v.as_i64()), Some(1));
        let stale_run: (String, String) = store
            .test_conn()
            .query_row(
                "SELECT status, COALESCE(summary, '') FROM agent_runs WHERE id = 'run-stale'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(stale_run.0, "stopped");
        assert!(
            stale_run.1.contains("未收尾"),
            "僵尸行要留下人话解释（占位的「运行中」必须被覆盖）：{}",
            stale_run.1
        );
        let fresh_run: (String, String) = store
            .test_conn()
            .query_row(
                "SELECT status, COALESCE(summary, '') FROM agent_runs WHERE id = 'run-fresh'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(fresh_run.0, "running", "刚写过状态的运行不能被自愈判死");
        assert_eq!(fresh_run.1, "运行中", "活着的运行摘要不被动");

        // 幂等：再跑一次什么都不改
        let again = store.reconcile_memory_ledger(now_ms()).unwrap();
        assert_eq!(again.get("orphanScopes").and_then(|v| v.as_i64()), Some(0));
        assert_eq!(again.get("staleJobs").and_then(|v| v.as_i64()), Some(0));
        assert_eq!(again.get("staleRuns").and_then(|v| v.as_i64()), Some(0));
        let _ = std::fs::remove_file(db);
    }

    #[test]
    fn project_identity_survives_rename_case_and_worktree_paths() {
        // 老实现把路径编进 scope：改目录名 / 大小写差异 / 换盘符都会变成「另一个项目」，
        // 之前沉淀的记忆静默失联。而且同一个 git remote 的新路径应该自动成为别名。
        let db = std::env::temp_dir().join(format!("dieyun-mem-projects-{}.sqlite", now_ms()));
        let _ = std::fs::remove_file(&db);
        let store = MemoryStore::open(db.clone(), EmbeddingConfig::default()).unwrap();

        let a = store
            .resolve_project(
                "E:\\repo\\dieyunagent",
                Some("github.com/acme/dieyunagent"),
            )
            .unwrap();
        let id = a.get("projectId").and_then(|v| v.as_i64()).unwrap();
        assert_eq!(a.get("scope").and_then(|v| v.as_str()), Some(format!("project:{id}").as_str()));
        assert_eq!(a.get("aliased").and_then(|v| v.as_bool()), Some(false));

        // 大小写 / 斜杠 / 尾分隔符差异 → 同一个 project（不新建）
        for same in ["e:/repo/dieyunagent/", "E:\\repo\\DIEYUNAGENT", "e:\\repo\\dieyunagent"] {
            let r = store
                .resolve_project(same, Some("github.com/acme/dieyunagent"))
                .unwrap();
            assert_eq!(
                r.get("projectId").and_then(|v| v.as_i64()),
                Some(id),
                "同一路径的不同写法必须解析到同一个 project：{same}"
            );
        }

        // 仓库搬家（换盘符）：git origin 相同 → 自动挂成别名，记忆跟着走
        let moved = store
            .resolve_project("D:\\work\\dieyunagent", Some("github.com/acme/dieyunagent"))
            .unwrap();
        assert_eq!(moved.get("projectId").and_then(|v| v.as_i64()), Some(id));
        assert_eq!(moved.get("aliased").and_then(|v| v.as_bool()), Some(true));

        // 没有 remote 的本地仓库：手动挂别名（`memory.project_alias_add`）
        let local = store.resolve_project("E:\\scratch\\app", None).unwrap();
        let local_id = local.get("projectId").and_then(|v| v.as_i64()).unwrap();
        assert_ne!(local_id, id, "无 remote 的不同路径是不同项目");
        store.add_project_alias(local_id, "E:\\scratch\\app-old").unwrap();
        let aliased = store.resolve_project("E:\\scratch\\app-old", None).unwrap();
        assert_eq!(aliased.get("projectId").and_then(|v| v.as_i64()), Some(local_id));

        // 清单：路径别名条数如实反映
        let list = store.list_projects(10).unwrap();
        let rows = list.get("results").and_then(|v| v.as_array()).unwrap();
        assert_eq!(rows.len(), 2);
        let first = rows
            .iter()
            .find(|r| r.get("projectId").and_then(|v| v.as_i64()) == Some(id))
            .expect("第一个项目应在清单里");
        assert_eq!(first.get("pathCount").and_then(|v| v.as_i64()), Some(2));

        let _ = std::fs::remove_file(db);
    }

    #[test]
    fn prunes_finished_runs_and_cascades_children() {
        let db = std::env::temp_dir().join(format!("dieyun-prune-runs-{}.sqlite", now_ms()));
        let _ = std::fs::remove_file(&db);
        let store = MemoryStore::open(db.clone(), EmbeddingConfig::default()).unwrap();
        let session = store.create_session(Some("修剪"), None).unwrap();

        for i in 0..3 {
            let run_id = format!("run-done-{i}");
            store
                .upsert_agent_run(&json!({
                    "id": run_id,
                    "sessionId": session.id,
                    "status": "completed",
                }))
                .unwrap();
            store
                .save_agent_trace(&json!({
                    "runId": run_id,
                    "sessionId": session.id,
                    "status": "completed",
                    "trace": [{ "type": "text", "content": "x" }],
                }))
                .unwrap();
        }
        // 非终态的 run 必须原样保留：running 进行中，planned 是 planner 中间态。
        for run_id in ["run-live", "run-planned"] {
            let status = if run_id == "run-live" {
                "running"
            } else {
                "planned"
            };
            store
                .upsert_agent_run(&json!({
                    "id": run_id,
                    "sessionId": session.id,
                    "status": status,
                }))
                .unwrap();
        }

        let policy = PrunePolicy {
            runs_keep_recent: 1,
            // 关掉时间窗口，只验证「保留最近 N 条」这条路径
            run_max_age_ms: i64::MAX / 2,
            ..PrunePolicy::default()
        };
        let guard = store.test_conn();
        let deleted = MemoryStore::prune_finished_agent_runs(&guard, &policy).unwrap();
        assert_eq!(deleted, 2, "应删掉 2 个超出保留窗口的终态 run");
        let runs: i64 = guard
            .query_row("SELECT COUNT(*) FROM agent_runs", [], |r| r.get(0))
            .unwrap();
        assert_eq!(runs, 3, "保留 1 个终态 + running + planned");
        let traces: i64 = guard
            .query_row("SELECT COUNT(*) FROM agent_traces", [], |r| r.get(0))
            .unwrap();
        assert_eq!(traces, 1, "agent_traces 应随 run 级联删除");
        drop(guard);
        let _ = std::fs::remove_file(db);
    }

    #[test]
    fn prunes_surplus_traces_per_run() {
        let db = std::env::temp_dir().join(format!("dieyun-prune-traces-{}.sqlite", now_ms()));
        let _ = std::fs::remove_file(&db);
        let store = MemoryStore::open(db.clone(), EmbeddingConfig::default()).unwrap();
        let session = store.create_session(Some("修剪"), None).unwrap();
        store
            .upsert_agent_run(&json!({
                "id": "run-1",
                "sessionId": session.id,
                "status": "running",
            }))
            .unwrap();
        // 新写入已是原地覆盖，这里直接造出「老库」形态（同一 run 堆多份 checkpoint）
        // 来验证裁剪逻辑本身。
        {
            let guard = store.test_conn();
            for i in 0..5 {
                guard
                    .execute(
                        "INSERT INTO agent_traces
                           (run_id, session_id, message_id, phase, trace_json, created_at)
                         VALUES ('run-1', ?1, NULL, 'assistant', ?2, ?3)",
                        params![
                            session.id,
                            json!([{ "type": "text", "content": i.to_string() }]).to_string(),
                            now_ms()
                        ],
                    )
                    .unwrap();
            }
        }

        let policy = PrunePolicy {
            traces_trigger: 1,
            traces_per_run: 2,
            ..PrunePolicy::default()
        };
        let guard = store.test_conn();
        let deleted = MemoryStore::prune_surplus_agent_traces(&guard, &policy).unwrap();
        assert_eq!(deleted, 3, "5 条只留 2 条");
        drop(guard);

        let remaining: i64 = {
            let guard = store.test_conn();
            guard
                .query_row("SELECT COUNT(*) FROM agent_traces", [], |r| r.get(0))
                .unwrap()
        };
        assert_eq!(remaining, 2);
        // 唯一读取路径（runId + LIMIT 1）拿到的必须仍是最新那次 checkpoint。
        let row = store
            .get_agent_trace(&json!({ "runId": "run-1" }))
            .unwrap()
            .unwrap();
        let content = row
            .get("trace")
            .and_then(|v| v.as_array())
            .and_then(|a| a.first())
            .and_then(|v| v.get("content"))
            .and_then(|v| v.as_str());
        assert_eq!(content, Some("4"));
        let _ = std::fs::remove_file(db);
    }

    #[test]
    fn merges_incremental_trace_checkpoints() {
        let db = std::env::temp_dir().join(format!("dieyun-trace-delta-{}.sqlite", now_ms()));
        let _ = std::fs::remove_file(&db);
        let store = MemoryStore::open(db.clone(), EmbeddingConfig::default()).unwrap();
        let session = store.create_session(Some("增量"), None).unwrap();

        // 首帧是全量：客户端游标为空，traceFrom 缺省为 0。
        store
            .save_agent_trace(&json!({
                "runId": "run-delta",
                "sessionId": session.id,
                "status": "running",
                "trace": [
                    { "type": "round", "thought": "A" },
                    { "type": "round", "thought": "B" }
                ],
            }))
            .unwrap();

        // 增量帧：客户端只重发「会变的尾部」+ 新增条目，从第 1 条起拼。
        let res = store
            .save_agent_trace(&json!({
                "runId": "run-delta",
                "sessionId": session.id,
                "status": "running",
                "traceFrom": 1,
                "trace": [
                    { "type": "round", "thought": "B2" },
                    { "type": "round", "thought": "C" }
                ],
            }))
            .unwrap();
        assert!(res.get("stale").is_none(), "游标合法时不该回 stale");
        let row = store
            .get_agent_trace(&json!({ "runId": "run-delta" }))
            .unwrap()
            .unwrap();
        let thoughts = |row: &Value| -> Vec<String> {
            row.get("trace")
                .and_then(|v| v.as_array())
                .map(|rows| {
                    rows.iter()
                        .filter_map(|r| r.get("thought").and_then(|v| v.as_str()))
                        .map(str::to_string)
                        .collect()
                })
                .unwrap_or_default()
        };
        assert_eq!(
            thoughts(&row),
            vec!["A", "B2", "C"],
            "前缀按 traceFrom 保留 + 尾部覆盖 + 新增追加"
        );
        // §3.7 D4：`traceText`（思考拼成的纯文本）已整体废除 —— 跨边界可回读的只有结构化 trace，
        // 出参里不得再出现该字段。
        assert!(
            row.get("traceText").is_none(),
            "get_agent_trace 不再出 traceText"
        );

        // 旧客户端仍可能带 traceText：必须被忽略，且不影响 trace 增量语义。
        store
            .save_agent_trace(&json!({
                "runId": "run-delta",
                "sessionId": session.id,
                "status": "running",
                "traceText": "A / B2 / C2",
                "trace": [
                    { "type": "round", "thought": "A" },
                    { "type": "round", "thought": "B2" },
                    { "type": "round", "thought": "C2" }
                ],
            }))
            .unwrap();
        store
            .save_agent_trace(&json!({
                "runId": "run-delta",
                "sessionId": session.id,
                "status": "running",
                "traceFrom": 2,
                "trace": [{ "type": "round", "thought": "C3" }],
            }))
            .unwrap();
        let row = store
            .get_agent_trace(&json!({ "runId": "run-delta" }))
            .unwrap()
            .unwrap();
        assert_eq!(thoughts(&row), vec!["A", "B2", "C3"]);
        assert!(
            row.get("traceText").is_none(),
            "legacy traceText 入参被忽略，出参不带该字段"
        );

        // 游标过期（traceFrom 超出已存条数）必须拒写并回 stale，绝不能落成半截快照。
        let res = store
            .save_agent_trace(&json!({
                "runId": "run-delta",
                "sessionId": session.id,
                "status": "running",
                "traceFrom": 99,
                "trace": [{ "type": "round", "thought": "X" }],
            }))
            .unwrap();
        assert_eq!(res.get("stale").and_then(|v| v.as_bool()), Some(true));
        let row = store
            .get_agent_trace(&json!({ "runId": "run-delta" }))
            .unwrap()
            .unwrap();
        assert_eq!(thoughts(&row), vec!["A", "B2", "C3"], "stale 时不改已存快照");
        let _ = std::fs::remove_file(db);
    }

    // ---- 长记忆词法检索（FTS5 + bm25，取代手写 CJK 打分）----

    fn seed_memory(store: &MemoryStore, content: &str, source: &str, age_days: i64) {
        let created = now_ms() - age_days * 24 * 60 * 60 * 1000;
        store
            .test_conn()
            .execute(
                "INSERT INTO long_memories
                   (content, source, scope, kind, importance, status, created_at, updated_at)
                 VALUES (?1, ?2, 'global', 'normal', 3, 'active', ?3, ?3)",
                params![content, source, created],
            )
            .expect("seed long memory");
    }

    /// 中文子串与标识符子串都要召回：trigram 分词器的语义就是子串命中。
    #[test]
    fn fts_search_hits_cjk_and_identifier_substrings() {
        let db = std::env::temp_dir().join(format!("dieyun-fts-hit-{}.sqlite", now_ms()));
        let _ = std::fs::remove_file(&db);
        let store = MemoryStore::open(db.clone(), EmbeddingConfig::default()).unwrap();
        seed_memory(&store, "代码库索引的增量更新逻辑走 root_hash 比对", "codebase", 1);
        seed_memory(&store, "fn parseConfig(path: &str) 读取配置", "src/config.rs", 1);
        seed_memory(&store, "用户偏好：回答用中文，少用列表", "chat", 1);

        let cjk = store.keyword_search_long_memories("索引", 5).unwrap();
        let cjk_contents = json_strings(&cjk, "results", "content");
        assert_eq!(cjk_contents.len(), 1, "中文子串应精确命中一条：{cjk}");
        assert!(cjk_contents[0].contains("增量更新"));

        // trigram 让「标识符中间一段」也能召回（unicode61 分词器做不到）
        let ident = store.keyword_search_long_memories("onfig", 5).unwrap();
        assert_eq!(
            json_strings(&ident, "results", "content"),
            vec!["fn parseConfig(path: &str) 读取配置".to_string()],
            "标识符子串应命中：{ident}"
        );

        assert!(
            store
                .keyword_search_long_memories("不存在的词", 5)
                .unwrap()
                .get("results")
                .and_then(|v| v.as_array())
                .map(|a| a.is_empty())
                .unwrap_or(false),
            "无命中应返回空数组"
        );
        let _ = std::fs::remove_file(db);
    }

    /// 旧实现 `ORDER BY id DESC LIMIT 1000` 只能看到最近 1000 行；FTS 没有这个窗口。
    #[test]
    fn fts_search_sees_memories_beyond_the_old_1000_row_window() {
        let db = std::env::temp_dir().join(format!("dieyun-fts-window-{}.sqlite", now_ms()));
        let _ = std::fs::remove_file(&db);
        let store = MemoryStore::open(db.clone(), EmbeddingConfig::default()).unwrap();
        // 最老的一条是唯一命中项，后面再压 1200 条噪声
        seed_memory(&store, "早期决定：向量检索先用精确余弦，不接 ANN", "design", 30);
        {
            let conn = store.test_conn();
            conn.execute_batch("BEGIN;").unwrap();
            for i in 0..1200 {
                conn.execute(
                    "INSERT INTO long_memories
                       (content, source, scope, kind, importance, status, created_at, updated_at)
                     VALUES (?1, 'noise', 'global', 'normal', 3, 'active', ?2, ?2)",
                    params![format!("噪声记录 {i}"), now_ms()],
                )
                .unwrap();
            }
            conn.execute_batch("COMMIT;").unwrap();
        }

        let hits = store.keyword_search_long_memories("ANN", 5).unwrap();
        assert_eq!(
            json_strings(&hits, "results", "content"),
            vec!["早期决定：向量检索先用精确余弦，不接 ANN".to_string()],
            "窗口外的那条必须能检索到：{hits}"
        );
        let _ = std::fs::remove_file(db);
    }

    /// 触发器保证增删改与索引一致（外部内容表不复制正文，靠触发器同步）。
    #[test]
    fn fts_index_follows_update_and_delete() {
        let db = std::env::temp_dir().join(format!("dieyun-fts-sync-{}.sqlite", now_ms()));
        let _ = std::fs::remove_file(&db);
        let store = MemoryStore::open(db.clone(), EmbeddingConfig::default()).unwrap();
        seed_memory(&store, "旧内容：使用 SQLite 全文索引", "note", 2);
        let id = store
            .keyword_search_long_memories("全文索引", 5)
            .unwrap()
            .get("results")
            .and_then(|v| v.as_array())
            .and_then(|a| a.first())
            .and_then(|v| v.get("id"))
            .and_then(|v| v.as_i64())
            .expect("先能检索到");

        store
            .test_conn()
            .execute(
                "UPDATE long_memories SET content = ?1 WHERE id = ?2",
                params!["新内容：改用 bm25 排序", id],
            )
            .unwrap();
        let after_update = json_strings(
            &store.keyword_search_long_memories("bm25", 5).unwrap(),
            "results",
            "content",
        );
        assert_eq!(after_update, vec!["新内容：改用 bm25 排序".to_string()]);
        assert!(
            json_strings(
                &store.keyword_search_long_memories("全文索引", 5).unwrap(),
                "results",
                "content"
            )
            .is_empty(),
            "改前的内容不该再被召回"
        );

        store
            .test_conn()
            .execute("DELETE FROM long_memories WHERE id = ?1", params![id])
            .unwrap();
        assert!(
            json_strings(
                &store.keyword_search_long_memories("bm25", 5).unwrap(),
                "results",
                "content"
            )
            .is_empty(),
            "删掉的记忆不该再被召回"
        );
        let _ = std::fs::remove_file(db);
    }

    /// 跨会话检索：默认按 workspace 圈定，且「中文双字词」走 LIKE 分支也要能命中。
    #[test]
    fn messages_search_matches_across_sessions_within_workspace() {
        let db = std::env::temp_dir().join(format!("dieyun-msg-search-{}.sqlite", now_ms()));
        let _ = std::fs::remove_file(&db);
        let store = MemoryStore::open(db.clone(), EmbeddingConfig::default()).unwrap();
        let a = store
            .create_session(Some("登录问题"), Some("E:/ws/alpha"))
            .unwrap();
        let b = store
            .create_session(Some("报表问题"), Some("E:/ws/beta"))
            .unwrap();
        store
            .append_message(
                &a.id,
                "user",
                "登录接口偶发 500，日志里是 pool timeout",
                None,
            )
            .unwrap();
        store
            .append_message(
                &a.id,
                "assistant",
                "连接池上限只有 5，调大到 20 后压力测试通过",
                None,
            )
            .unwrap();
        store
            .append_message(&b.id, "user", "导出报表总是乱码", None)
            .unwrap();

        // trigram 分支：标识符 / 长词
        let hit = store.search_messages("timeout", None, None, 10, 200).unwrap();
        assert_eq!(hit.get("mode").and_then(|v| v.as_str()), Some("fts"), "{hit}");
        assert_eq!(json_strings(&hit, "results", "sessionId"), vec![a.id.clone()]);

        // 中文双字词没有可命中的 trigram → 退 LIKE，结果不能因此丢
        let cjk = store.search_messages("登录", None, None, 10, 200).unwrap();
        assert_eq!(cjk.get("mode").and_then(|v| v.as_str()), Some("like"), "{cjk}");
        assert_eq!(
            json_strings(&cjk, "results", "sessionId"),
            vec![a.id.clone()],
            "{cjk}"
        );

        // workspace 圈定：beta 里查不到 alpha 的内容
        let beta = store
            .search_messages("timeout", Some("E:/ws/beta"), None, 10, 200)
            .unwrap();
        assert!(json_strings(&beta, "results", "sessionId").is_empty(), "{beta}");
        // 大小写 / 反斜杠 / 尾斜杠归一后仍算同一个 workspace（path_key 单一来源）
        let alpha = store
            .search_messages("timeout", Some("e:\\ws\\alpha\\"), None, 10, 200)
            .unwrap();
        assert_eq!(
            json_strings(&alpha, "results", "sessionId"),
            vec![a.id.clone()],
            "{alpha}"
        );
        let _ = std::fs::remove_file(&db);
    }

    /// 影子表要跟着账本走：改 / 删消息后检索必须同步 —— 这是触发器存在的唯一理由。
    #[test]
    fn messages_fts_index_follows_update_and_delete() {
        let db = std::env::temp_dir().join(format!("dieyun-msg-fts-{}.sqlite", now_ms()));
        let _ = std::fs::remove_file(&db);
        let store = MemoryStore::open(db.clone(), EmbeddingConfig::default()).unwrap();
        let s = store.create_session(Some("t"), Some("E:/ws/a")).unwrap();
        store
            .append_message(&s.id, "user", "第一条：索引可以搜到 alpha", None)
            .unwrap();
        assert_eq!(
            json_strings(
                &store.search_messages("alpha", None, None, 10, 200).unwrap(),
                "results",
                "sessionId"
            ),
            vec![s.id.clone()]
        );

        store
            .test_conn()
            .execute(
                "UPDATE messages SET content = '第一条：索引可以搜到 beta' WHERE session_id = ?1",
                params![s.id],
            )
            .expect("update");
        assert!(
            json_strings(
                &store.search_messages("alpha", None, None, 10, 200).unwrap(),
                "results",
                "sessionId"
            )
            .is_empty(),
            "旧正文的 trigram 必须随 UPDATE 触发器消失"
        );
        assert_eq!(
            json_strings(
                &store.search_messages("beta", None, None, 10, 200).unwrap(),
                "results",
                "sessionId"
            ),
            vec![s.id.clone()]
        );

        store
            .test_conn()
            .execute("DELETE FROM messages WHERE session_id = ?1", params![s.id])
            .expect("delete");
        assert!(json_strings(
            &store.search_messages("beta", None, None, 10, 200).unwrap(),
            "results",
            "sessionId"
        )
        .is_empty());
        let _ = std::fs::remove_file(&db);
    }

    /// 压缩归档的 `folded_text` 要有读的出口：它是被压缩掉的历史原文的最后一份材料。
    #[test]
    fn compaction_folded_search_reads_folded_text() {
        let db = std::env::temp_dir().join(format!("dieyun-folded-{}.sqlite", now_ms()));
        let _ = std::fs::remove_file(&db);
        let store = MemoryStore::open(db.clone(), EmbeddingConfig::default()).unwrap();
        let s = store
            .create_session(Some("长任务"), Some("E:/ws/a"))
            .unwrap();
        store
            .test_conn()
            .execute(
                "INSERT INTO compaction_archives
                 (session_id, workspace_path, tokens_before, tokens_after, summary_text, folded_text, created_at)
                 VALUES (?1, 'E:/ws/a', 9000, 1200, '摘要', '折叠掉的原文：pgbouncer 的 pool_mode 要设 transaction', 1)",
                params![s.id],
            )
            .expect("seed archive");

        let hit = store
            .search_compaction_folded("pgbouncer", Some("E:/ws/a"), None, 10, 400)
            .unwrap();
        let snippets = json_strings(&hit, "results", "snippet");
        assert_eq!(snippets.len(), 1, "{hit}");
        assert!(snippets[0].contains("pool_mode"), "{hit}");

        // 空 query = 「这条会话压缩过什么」（只列清单，不带正文）
        let listed = store
            .search_compaction_folded("", None, Some(&s.id), 10, 400)
            .unwrap();
        assert_eq!(listed.get("mode").and_then(|v| v.as_str()), Some("recent"));
        assert_eq!(
            json_strings(&listed, "results", "sessionId"),
            vec![s.id.clone()]
        );
        // 别的 workspace 看不到
        assert!(json_strings(
            &store
                .search_compaction_folded("pgbouncer", Some("E:/ws/beta"), None, 10, 400)
                .unwrap(),
            "results",
            "snippet"
        )
        .is_empty());
        let _ = std::fs::remove_file(&db);
    }

    fn json_strings(v: &Value, list_key: &str, field: &str) -> Vec<String> {
        v.get(list_key)
            .and_then(|x| x.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|r| r.get(field).and_then(|f| f.as_str()).map(str::to_string))
                    .collect()
            })
            .unwrap_or_default()
    }
}


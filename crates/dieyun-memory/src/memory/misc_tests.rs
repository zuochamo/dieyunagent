//! 这个模块的测试。实现留在同级文件里。
//! 拆开的理由：几百行用例与实现同居时，改一个方法要在整片用例之间翻，diff 也不可读。

use super::*;

use dieyun_base::embedding::EmbeddingConfig;

pub(crate) fn open_store(tag: &str) -> (MemoryStore, std::path::PathBuf) {
    let db = std::env::temp_dir().join(format!("dieyun-misc-{tag}-{}.sqlite", now_ms()));
    let _ = std::fs::remove_file(&db);
    let store = MemoryStore::open(db.clone(), EmbeddingConfig::default()).unwrap();
    (store, db)
}

pub(crate) fn status_of(store: &MemoryStore, id: i64) -> String {
    store
        .with_conn(|conn| {
            Ok(conn.query_row(
                "SELECT status FROM long_memories WHERE id = ?1",
                params![id],
                |row| row.get::<_, String>(0),
            )?)
        })
        .unwrap()
}

/// 衰减的三条规则各管各的：过期归档 / 低价值久未用转 stale / 高价值与 secret 不动。
///
/// 这条 SQL 会**改库状态**（active → stale → archived）却一直没有测试：
/// 改错一个条件，表现是「记忆悄悄消失」，界面上看不出是谁干的。
#[test]
pub(crate) fn decay_applies_expired_stale_and_archive_rules_independently() {
    let (store, db) = open_store("decay");
    let now = now_ms();
    // 10 天：过了 stale 阈值（7 天）但没过 archive 阈值（14 天）；40 天：两个阈值都过了
    let ten_days = now - 10 * 24 * 60 * 60 * 1000;
    let long_ago = now - 40 * 24 * 60 * 60 * 1000;

    let expired = store
        .add_long_memory(
            "这条已经过期了",
            "test",
            Some("normal"),
            Some("global"),
            Some(5),
            Some(now - 1_000),
            None,
            None,
        )
        .unwrap();
    let low = store
        .add_long_memory("低价值且十几天没用过", "test", Some("normal"), Some("global"), Some(1), None, None, None)
        .unwrap();
    let low_old = store
        .add_long_memory("低价值且四十天没用过", "test", Some("normal"), Some("global"), Some(1), None, None, None)
        .unwrap();
    let high = store
        .add_long_memory("高价值事实", "test", Some("normal"), Some("global"), Some(5), None, None, None)
        .unwrap();
    let secret = store
        .add_long_memory("password=hunter2", "test", Some("normal"), Some("global"), Some(1), None, None, None)
        .unwrap();

    let low_id = low["localMemoryId"].as_i64().unwrap();
    let low_old_id = low_old["localMemoryId"].as_i64().unwrap();
    let high_id = high["localMemoryId"].as_i64().unwrap();
    let secret_id = secret["localMemoryId"].as_i64().unwrap();
    assert_eq!(
        store
            .with_conn(|conn| {
                Ok(conn.query_row(
                    "SELECT kind FROM long_memories WHERE id = ?1",
                    params![secret_id],
                    |row| row.get::<_, String>(0),
                )?)
            })
            .unwrap(),
        "secret",
        "凭据形状的正文会被判成 secret（衰减必须放过它）"
    );

    // 把三条做旧（secret 那条也要做旧，才能证明「不是因为它新」）
    store
        .with_conn(|conn| {
            conn.execute(
                "UPDATE long_memories SET created_at = ?1, last_used_at = NULL, access_count = 0 WHERE id = ?2",
                params![ten_days, low_id],
            )?;
            for id in [low_old_id, high_id, secret_id] {
                conn.execute(
                    "UPDATE long_memories SET created_at = ?1, last_used_at = NULL, access_count = 0 WHERE id = ?2",
                    params![long_ago, id],
                )?;
            }
            Ok(())
        })
        .unwrap();

    let out = store.decay_long_memories(7, 14).unwrap();
    assert_eq!(out["expired"].as_i64(), Some(1), "过期行直接归档");
    // 两条低价值都被 active→stale 这一步捞到；40 天那条接着在同一次调用里被归档，
    // 所以 stale 计数是 2、archived 计数是 1 —— 计数口径是「本步改了几行」，不是最终状态分布。
    assert_eq!(out["stale"].as_i64(), Some(2));
    assert_eq!(out["archived"].as_i64(), Some(1), "只有「四十天」那条一路归档");

    assert_eq!(status_of(&store, expired["localMemoryId"].as_i64().unwrap()), "archived");
    assert_eq!(status_of(&store, low_id), "stale", "阈值内只降级到 stale（仍可命中，打分扣分）");
    assert_eq!(
        status_of(&store, low_old_id),
        "archived",
        "同一次衰减里按时间跨度直达它该在的档位（stale → archived 不等下一轮）"
    );
    assert_eq!(status_of(&store, high_id), "active", "高价值永不衰减");
    assert_eq!(status_of(&store, secret_id), "active", "secret 不衰减（否则等于悄悄删掉凭据提醒）");

    let _ = std::fs::remove_file(&db);
}

/// 撤回一轮：消息 / trace / 运行行一起收，标题按剩下的首条用户消息重算。
#[test]
pub(crate) fn delete_turn_messages_cascades_and_retitles() {
    let (store, db) = open_store("delete-turn");
    let session = store.create_session(None, None).unwrap();
    store.append_message(&session.id, "user", "第一条用户消息", None).unwrap();
    store.append_message(&session.id, "assistant", "第一条回答", None).unwrap();
    store.append_message(&session.id, "user", "第二条用户消息", None).unwrap();
    assert_eq!(
        store.get_session(&session.id).unwrap().unwrap().title.as_deref(),
        Some("第一条用户消息")
    );

    // 按 id 删首条用户消息 → 标题跟着剩下的首条用户消息走
    let first_id = store.list_messages_after_id(0, 10).unwrap()[0]["id"].as_i64().unwrap();
    let out = store.delete_turn_messages(&session.id, &[first_id], None).unwrap();
    assert_eq!(out["deleted"].as_i64(), Some(1));
    assert_eq!(
        store.get_session(&session.id).unwrap().unwrap().title.as_deref(),
        Some("第二条用户消息"),
        "撤回后按新的首条用户消息重算启发式标题"
    );

    // 有明确作者的标题不许被撤回改写
    store
        .set_session_title(&session.id, "AI 总结的标题", super::super::TITLE_SOURCE_AI)
        .unwrap();
    let out = store.delete_turn_messages(&session.id, &[], Some(5)).unwrap();
    assert_eq!(out["deleted"].as_i64(), Some(2), "remove_count 删掉最后 N 条");
    assert_eq!(
        store.get_session(&session.id).unwrap().unwrap().title.as_deref(),
        Some("AI 总结的标题"),
        "撤回不是改标题的入口：ai 标题保持"
    );

    // 空 sessionId 不静默成功
    let bad = store.delete_turn_messages("  ", &[1], None).unwrap();
    assert_eq!(bad["ok"], json!(false));

    let _ = std::fs::remove_file(&db);
}

/// 增量读（请求快照 / 索引追赶都用它）：按 id 升序分页，limit 夹在 1..=2000。
#[test]
pub(crate) fn list_messages_after_id_pages_and_clamps_limit() {
    let (store, db) = open_store("list-msgs");
    let session = store.create_session(None, None).unwrap();
    for i in 0..3 {
        store
            .append_message(&session.id, "user", &format!("消息 {i}"), None)
            .unwrap();
    }
    let all = store.list_messages_after_id(0, 100).unwrap();
    assert_eq!(all.len(), 3);
    assert!(all[0]["id"].as_i64() < all[2]["id"].as_i64(), "按 id 升序");

    let page = store.list_messages_after_id(all[0]["id"].as_i64().unwrap(), 100).unwrap();
    assert_eq!(page.len(), 2, "after_id 是开区间");
    assert_eq!(store.list_messages_after_id(0, 0).unwrap().len(), 1, "limit 夹到至少 1");
    assert_eq!(store.list_messages_after_id(0, 99_999).unwrap().len(), 3);

    let _ = std::fs::remove_file(&db);
}

/// 长期记忆的增量读同上（索引追赶用）：limit 夹在 1..=500。
#[test]
pub(crate) fn list_long_memories_after_id_pages_and_clamps_limit() {
    let (store, db) = open_store("list-mem");
    let a = store
        .add_long_memory("第一条记忆", "test", Some("normal"), Some("global"), None, None, None, None)
        .unwrap();
    store
        .add_long_memory("第二条记忆", "test", Some("normal"), Some("global"), None, None, None, None)
        .unwrap();

    let all = store.list_long_memories_after_id(0, 100).unwrap();
    assert_eq!(all.len(), 2);
    assert_eq!(all[0]["content"].as_str(), Some("第一条记忆"));
    let rest = store
        .list_long_memories_after_id(a["localMemoryId"].as_i64().unwrap(), 100)
        .unwrap();
    assert_eq!(rest.len(), 1);
    assert_eq!(store.list_long_memories_after_id(0, 0).unwrap().len(), 1, "limit 夹到至少 1");

    let _ = std::fs::remove_file(&db);
}

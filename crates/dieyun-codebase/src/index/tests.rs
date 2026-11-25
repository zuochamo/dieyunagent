//! 这个模块的测试。实现留在 `mod.rs`。
//! 拆开的理由：750+ 行测试和实现塞在同一个文件里，改一个方法要在整片用例之间翻。

use super::*;

use dieyun_base::embedding::EmbeddingConfig;
use crate::index::repair::local_root_vanished;
use std::path::Path;
use tempfile::tempdir;

#[test]
fn mtime_uses_nanosecond_precision() {
    // 纳秒值：完全相等才算未变化
    assert!(mtime_unchanged(
        1_700_000_000_123_456_789,
        1_700_000_000_123_456_789
    ));
    // 同一秒内不同的纳秒：必须判为已变化（秒级精度会漏掉这种保存）
    assert!(!mtime_unchanged(
        1_700_000_000_123_456_789,
        1_700_000_000_123_456_790
    ));
    // 存量秒级记录：一律视为已变化，强制重建一次升级精度
    assert!(!mtime_unchanged(1_700_000_000, 1_700_000_000_123_456_789));
    assert!(!mtime_unchanged(1_700_000_000, 1_700_000_000));
}

#[tokio::test]
async fn index_and_search_smoke() {
    let dir = tempdir().unwrap();
    std::fs::write(
        dir.path().join("hello.rs"),
        "fn main() {\n    println!(\"hello world\");\n}\n",
    )
    .unwrap();
    let db = dir.path().join("idx.sqlite");
    let svc = IndexService::new(
        crate::codebase_db::handle(db),
        EmbeddingConfig::default(),
    );
    let root = dir.path().to_string_lossy();
    let st = svc.index_workspace(&root, true, false).await.unwrap();
    assert!(st.indexed);
    assert!(st.chunk_count > 0);
    let sr = svc.search(&root, "hello", Some(5)).await.unwrap();
    assert!(!sr.results.is_empty());
}

/// 缓存命中时**一次 embedding 请求都不发**：第 ① 步只建 chunk，第 ② 步把每个 chunk 的
/// 向量按 `run_index` 的算键方式预置进缓存，第 ③ 步带向量重建 —— 端点地址是必然连不上的
/// `127.0.0.1:9`，所以只要复用逻辑失效（哪怕只漏一个 chunk），这个用例就会失败而不是静默变慢。
///
/// 这就是 batch 6 的验收点：乙案（每会话一份索引库）+ 向量 不再是「每个新会话重算整仓」。
#[tokio::test]
async fn vectors_reuse_from_content_hash_cache_without_calling_endpoint() {
    let dir = tempdir().unwrap();
    std::fs::write(dir.path().join("a.rs"), "fn alpha() { let x = 1; }\n").unwrap();
    std::fs::write(dir.path().join("b.rs"), "fn beta() { let y = 2; }\n").unwrap();
    let db = dir.path().join("idx.sqlite");
    let root = dir.path().to_string_lossy().to_string();

    // 「已启用」但端点不可达：任何真实请求都会失败。
    let cfg = EmbeddingConfig {
        model: "test-embed".into(),
        base_url: "http://127.0.0.1:9".into(),
        dimensions: 3,
        ..Default::default()
    };
    assert!(cfg.enabled());

    // ① 只建 chunk（不带向量），拿到这一版 chunk 正文
    let svc = IndexService::new(crate::codebase_db::handle(db.clone()), cfg.clone());
    let st1 = svc.index_workspace(&root, true, false).await.unwrap();
    assert!(st1.chunk_count > 0);

    // ② 按 run_index 的方式算键，把向量预置进跨 worktree 缓存。
    //    键是 `cache_key()`（签名 + 端点），不是 `signature()`：缓存全局共享，
    //    两个提供商可能都叫同名的同名模型，端点必须进键。
    assert_ne!(cfg.cache_key(), cfg.signature());
    let cache_path = dir.path().join(vector_cache::CACHE_FILE_NAME);
    let seeded = {
        let cache = vector_cache::VectorCache::open(&cache_path).unwrap();
        let conn = Connection::open(&db).unwrap();
        let mut stmt = conn.prepare("SELECT content FROM chunks").unwrap();
        let texts: Vec<String> = stmt
            .query_map([], |r| r.get::<_, String>(0))
            .unwrap()
            .map(|r| r.unwrap())
            .collect();
        let rows: Vec<(String, Vec<f32>)> = texts
            .iter()
            .map(|t| {
                (
                    vector_cache::content_hash(&embedding::embedding_input(t)),
                    vec![0.5f32, 0.25, 0.125],
                )
            })
            .collect();
        cache.put_many(&cfg.cache_key(), &rows, 1).unwrap()
    };
    assert_eq!(seeded as i64, st1.chunk_count);

    // ③ 先把上一轮的数字改成非 0 —— 真实场景里那正是「上一次真算过」留下的值。
    //    旧实现写的是 `COALESCE(?10, workspaces.vectors_embedded)`，全命中时传 None，
    //    于是库里 999 原地不动，面板便一直报「新算 999」。新库测试（旧值本就 0）测不出，
    //    所以这里必须显式造出「旧值非 0」的前置条件。
    {
        let conn = Connection::open(&db).unwrap();
        conn.execute(
            "UPDATE workspaces SET vectors_embedded = 999, vectors_reused = 0",
            [],
        )
        .unwrap();
    }

    // ④ 带向量重建：全部命中 ⇒ vectors_embedded 必须是 0（覆盖上一轮的 999）
    let svc2 = IndexService::new(crate::codebase_db::handle(db.clone()), cfg.clone())
        .with_vector_cache(Some(cache_path));
    let st2 = svc2.index_workspace(&root, true, true).await.unwrap();
    assert_eq!(st2.vectors_embedded, 0, "全命中缓存时不该真的调 embedding");
    assert_eq!(
        st2.vectors_reused, st2.chunk_count,
        "每个 chunk 都该复用缓存里的向量"
    );
    assert_eq!(st2.vector_count, st2.chunk_count);
}

#[tokio::test]
async fn index_incremental_skips_unchanged_and_updates_changed() {
    let dir = tempdir().unwrap();
    let a = dir.path().join("a.rs");
    let b = dir.path().join("b.rs");
    std::fs::write(&a, "fn a() { /* keep */ }\n").unwrap();
    std::fs::write(&b, "fn b() { /* old */ }\n").unwrap();
    let db = dir.path().join("idx.sqlite");
    let svc = IndexService::new(
        crate::codebase_db::handle(db),
        EmbeddingConfig::default(),
    );
    let root = dir.path().to_string_lossy();
    let st1 = svc.index_workspace(&root, true, false).await.unwrap();
    assert!(st1.indexed);
    assert!(st1.chunk_count >= 2);
    let c1 = st1.chunk_count;

    // 不变 → 增量后 chunk 数不变
    let st2 = svc.index_workspace(&root, false, false).await.unwrap();
    assert!(st2.indexed);
    assert_eq!(st2.chunk_count, c1);

    // 改一个文件 → 仍可搜到新内容
    std::thread::sleep(std::time::Duration::from_millis(1100));
    std::fs::write(&b, "fn b() { /* unique_token_xyz */ }\n").unwrap();
    let st3 = svc.index_workspace(&root, false, false).await.unwrap();
    assert!(st3.indexed);
    let sr = svc.search(&root, "unique_token_xyz", Some(5)).await.unwrap();
    assert!(!sr.results.is_empty());
}

/// 回归（A11）：「路径还在、但已经不该索引」的文件，旧 chunk 必须被清掉。
///
/// 旧实现遇到「超限 / 二进制 / 读不出来」一律 `continue`：`purge_stale_chunk_paths` 认为
/// 它还在（rel 仍在 walker 列表里），这里又不重建 —— 库里永远留着这份文件**上一次**的
/// 内容，`codebase.search` 照旧把它当事实返回给模型，而磁盘上早就没有那段文字了。
///
/// 现在：永久不可索引（超限 / 含 NUL）→ 清旧 chunk；暂时读不到 → 保留，下一轮重试。
#[tokio::test]
async fn incremental_index_purges_chunks_of_now_unindexable_files() {
    let dir = tempdir().unwrap();
    let file = dir.path().join("a.rs");
    std::fs::write(&file, "fn a() { /* unique_token_purged */ }\n").unwrap();
    let db = dir.path().join("idx.sqlite");
    let svc = IndexService::new(crate::codebase_db::handle(db), EmbeddingConfig::default());
    let root = dir.path().to_string_lossy();

    let st1 = svc.index_workspace(&root, true, false).await.unwrap();
    assert!(st1.indexed);
    assert!(
        !svc.search(&root, "unique_token_purged", Some(5))
            .await
            .unwrap()
            .results
            .is_empty(),
        "先确认它确实进了索引"
    );

    // 变成「不再可索引」：写二进制内容（含 NUL），但**路径不变**
    std::thread::sleep(std::time::Duration::from_millis(1100));
    std::fs::write(&file, [b"fn a() { /* unique_token_purged */ }\0\0\0".as_slice()].concat())
        .unwrap();
    let st2 = svc.index_workspace(&root, false, false).await.unwrap();
    assert!(st2.indexed);

    assert!(
        svc.search(&root, "unique_token_purged", Some(5))
            .await
            .unwrap()
            .results
            .is_empty(),
        "文件已不可索引，库里不该还有它的旧正文"
    );
}

/// 回归（P5 R3）：`status` 必须说出「这次建库有几个文件没进索引」。
///
/// 不说出来的后果很具体：用户看到「我明明有这个文件，搜不到」，而面板只说「索引完成」。
/// `skipped`（看见了但内容不可索引）与 `truncated`（仓比扫描上限还大、后面的文件压根没看到）
/// 是两件事，分开报。
#[tokio::test]
async fn status_reports_files_skipped() {
    let dir = tempdir().unwrap();
    std::fs::write(dir.path().join("ok.rs"), "fn a() { b(); }\n").unwrap();
    // 文本扩展名 + NUL 内容 → 走「不可索引」分支
    std::fs::write(dir.path().join("binary.rs"), [b"\0\0".as_slice(), b"\0".as_slice()].concat())
        .unwrap();
    let db = dir.path().join("idx.sqlite");
    let svc = IndexService::new(crate::codebase_db::handle(db), EmbeddingConfig::default());
    let root = dir.path().to_string_lossy();

    let st = svc.index_workspace(&root, true, false).await.unwrap();
    assert!(st.indexed);

    let status = svc.status(&root).unwrap();
    assert_eq!(
        status.files_skipped, 1,
        "二进制文件要报成 skipped（实际 {status:?}）"
    );
    assert!(
        !status.files_truncated,
        "小仓不该被报成 truncated（那是「仓比 16k 上限还大」）"
    );
}

/// 回归：`vectors=false` 只该表示「这次不建向量」，**不能**把已有向量删掉。
///
/// 旧实现把两者混为一谈（`if !use_vectors { DELETE FROM chunk_vectors ... }`），于是
/// 面板「重建片段」、增量建库、prep 首次建库任意一次都会清空整库向量 —— 用户花几分钟
/// 建好的向量一次保存就没，面板回到「0（子串检索）」，自然得出「向量没用」的结论。
#[tokio::test]
async fn rebuild_without_vectors_keeps_existing_vectors() {
    let dir = tempdir().unwrap();
    std::fs::write(dir.path().join("a.rs"), "fn a() { /* keep */ }\n").unwrap();
    let db = dir.path().join("idx.sqlite");
    let handle = crate::codebase_db::handle(db);
    let svc = IndexService::new(Arc::clone(&handle), EmbeddingConfig::default());
    let root = dir.path().to_string_lossy().to_string();
    let ws = resolve_workspace(&root).unwrap();

    let st = svc.index_workspace(&root, true, false).await.unwrap();
    assert!(st.chunk_count > 0);

    // 造出「库里已有向量」的状态（不依赖真实 embedding 端点）
    const SIG: &str = "test-embed@3";
    let seeded = handle
        .with_conn(|conn| {
            let ids: Vec<i64> = conn
                .prepare("SELECT id FROM chunks WHERE root_hash = ?1")
                .map_err(|e| CoreError::rpc("TEST_SEED", e.to_string()))?
                .query_map(params![ws.root_hash], |r| r.get(0))
                .map_err(|e| CoreError::rpc("TEST_SEED", e.to_string()))?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| CoreError::rpc("TEST_SEED", e.to_string()))?;
            for id in &ids {
                let blob = dieyun_base::embedding::vector_to_blob(&[1.0f32, 0.0, 0.0]);
                conn.execute(
                    "INSERT INTO chunk_vectors (chunk_id, dims, vector) VALUES (?1, 3, ?2)",
                    params![id, blob],
                )
                .map_err(|e| CoreError::rpc("TEST_SEED", e.to_string()))?;
            }
            conn.execute(
                "UPDATE workspaces SET vector_count = ?2, embedding_model = ?3,
                                       embedding_dims = 3
                 WHERE root_hash = ?1",
                params![ws.root_hash, ids.len() as i64, SIG],
            )
            .map_err(|e| CoreError::rpc("TEST_SEED", e.to_string()))?;
            Ok(ids.len() as i64)
        })
        .expect("seed vectors");
    assert!(seeded > 0);

    // 增量建库、这次不要向量
    let st2 = svc.index_workspace(&root, false, false).await.unwrap();
    assert_eq!(
        st2.vector_count, seeded,
        "vectors=false 不得清空已有向量（否则语义检索会无声消失）"
    );
    assert_eq!(
        st2.embedding_model.as_deref(),
        Some(SIG),
        "签名元数据必须沿用到库里真实存在的向量，不能抹成 NULL"
    );
    assert_eq!(st2.embedding_dims, 3, "维度不能被抹成 0");
}

/// RPC 入口用 `vectors_available()` 决定「要求向量但端点没配」要不要报
/// `EMBEDDING_NOT_CONFIGURED`。判据必须与 `EmbeddingConfig::enabled` 完全一致：
/// 只有「没被禁用 + model + base_url 都非空」才算可用，缺一项就不该假装配好了。
#[test]
fn vectors_available_follows_embedding_config() {
    let dir = tempdir().unwrap();
    let off = IndexService::new(
        crate::codebase_db::handle(dir.path().join("a.sqlite")),
        EmbeddingConfig::default(),
    );
    assert!(!off.vectors_available(), "默认配置（空 model/base_url）不可用");

    let only_model = EmbeddingConfig {
        model: "text-embedding-3-small".into(),
        ..Default::default()
    };
    let half = IndexService::new(
        crate::codebase_db::handle(dir.path().join("b.sqlite")),
        only_model,
    );
    assert!(!half.vectors_available(), "只有 model、没有 base_url 仍不可用");

    let disabled = EmbeddingConfig {
        model: "text-embedding-3-small".into(),
        base_url: "https://api.example.com/v1".into(),
        disabled: true,
        ..Default::default()
    };
    let off2 = IndexService::new(
        crate::codebase_db::handle(dir.path().join("c.sqlite")),
        disabled,
    );
    assert!(!off2.vectors_available(), "显式禁用时不可用");

    let on = EmbeddingConfig {
        model: "text-embedding-3-small".into(),
        base_url: "https://api.example.com/v1".into(),
        ..Default::default()
    };
    let svc = IndexService::new(crate::codebase_db::handle(dir.path().join("d.sqlite")), on);
    assert!(svc.vectors_available());
}

/// status 是**纯读**：哪怕库里有崩溃残留（`indexing=1`、元数据残缺）且另一个连接
/// 正占着写事务，也必须秒回 —— 否则面板轮询会一路撞到 45s 超时。
#[test]
fn status_is_pure_read_and_never_waits_on_writer() {
    let dir = tempdir().unwrap();
    let db = dir.path().join("idx.sqlite");
    let handle = crate::codebase_db::handle(db);
    let svc = IndexService::new(
        Arc::clone(&handle),
        EmbeddingConfig::default(),
    );
    let root = dir.path().to_string_lossy().to_string();
    let ws = resolve_workspace(&root).unwrap();

    // 造脏状态：indexing=1、元数据全 0，但 chunks 里其实有 2 条
    handle
        .with_conn(|conn| {
            conn.execute(
                "INSERT INTO workspaces (root_hash, root_path, indexing) VALUES (?1, ?2, 1)",
                params![ws.root_hash, &root],
            )
            .map_err(|e| CoreError::rpc("TEST_SEED", e.to_string()))?;
            for _ in 0..2 {
                conn.execute(
                    "INSERT INTO chunks (root_hash, rel_path, start_line, end_line, content, mtime)
                     VALUES (?1, 'a.rs', 1, 2, 'x', 0)",
                    params![ws.root_hash],
                )
                .map_err(|e| CoreError::rpc("TEST_SEED", e.to_string()))?;
            }
            Ok(())
        })
        .expect("seed stale workspace");

    let writer = handle.open_dedicated().expect("open writer");
    writer
        .execute_batch(
            "BEGIN IMMEDIATE;
             INSERT INTO chunks (root_hash, rel_path, start_line, end_line, content, mtime)
             VALUES ('other', 'b.rs', 1, 2, 'y', 0);",
        )
        .expect("hold write transaction");

    let started = std::time::Instant::now();
    let st = svc.status(&root).expect("status");
    let elapsed = started.elapsed();

    writer.execute_batch("ROLLBACK").expect("rollback");
    drop(writer);

    assert!(!st.indexing, "没人在跑索引时不应报 indexing");
    assert_eq!(st.chunk_count, 2, "读路径应就地算出真实 chunk 数");
    assert!(st.indexed, "indexed_at 应被补上");
    assert!(
        elapsed < std::time::Duration::from_secs(1),
        "status 等了 {elapsed:?}：读路径又被写锁堵住了"
    );
}

/// force 重建期间崩溃（chunks 已清空、counts 还没写回）不能伪装成「已索引」：
/// 否则 status 说「已索引 N 段」、search 又绕过 needsIndex 门槛，静默返回 0 条。
#[tokio::test]
async fn status_zeroes_counts_when_chunks_were_cleared_but_metadata_is_stale() {
    let dir = tempdir().unwrap();
    let db = dir.path().join("idx.sqlite");
    let handle = crate::codebase_db::handle(db);
    let svc = IndexService::new(
        Arc::clone(&handle),
        EmbeddingConfig::default(),
    );
    let root = dir.path().to_string_lossy().to_string();
    let ws = resolve_workspace(&root).unwrap();

    // 元数据是上一轮的满值，chunks 表却已经空（重建半途崩）
    handle
        .with_conn(|conn| {
            conn.execute(
                "INSERT INTO workspaces (root_hash, root_path, indexing, chunk_count, file_count,
                                         indexed_at)
                 VALUES (?1, ?2, 0, 42, 7, 1700000000)",
                params![ws.root_hash, &root],
            )
            .map_err(|e| CoreError::rpc("TEST_SEED", e.to_string()))?;
            Ok(())
        })
        .expect("seed stale counts");

    let st = svc.status(&root).expect("status");
    assert_eq!(st.chunk_count, 0, "库里没内容就不能报旧 chunk 数");
    assert_eq!(st.file_count, 0);
    assert!(!st.indexed, "内容没了应判为需要重建");
    let sr = svc.search(&root, "anything", Some(5)).await.unwrap();
    assert_eq!(sr.needs_index, Some(true), "search 应提示需要重建索引");
}

/// 面板展示的三件事：库里的向量模型、维度、以及「是否与当前设置一致」。
///
/// 前两者必须取**库里实际写入**的值（而不是当前设置），一致性才用当前设置比对。
#[test]
fn status_reports_vector_model_dims_and_staleness() {
    let dir = tempdir().unwrap();
    let db = dir.path().join("idx.sqlite");
    let handle = crate::codebase_db::handle(db);
    let cfg = EmbeddingConfig {
        model: "test-model".into(),
        base_url: "http://127.0.0.1:1".into(),
        dimensions: 768,
        ..Default::default()
    };
    let svc = IndexService::new(Arc::clone(&handle), cfg);
    let root = dir.path().to_string_lossy().to_string();
    let ws = resolve_workspace(&root).unwrap();

    // 元数据与库一致（10 段 / 10 条向量都是库里真有的行）：本条只验证「签名/维度取库里
    // 实际写入的值」与「与当前设置比一致性」，不验证计数（那是下面两条用例的事）。
    handle
        .with_conn(|conn| {
            conn.execute(
                "INSERT INTO workspaces (root_hash, root_path, indexing, embedding_model,
                                         embedding_dims, vector_count, chunk_count, file_count, indexed_at)
                 VALUES (?1, ?2, 0, 'builtin:bge-base-zh-v1.5@768', 768, 10, 10, 3, 1700000000)",
                params![ws.root_hash, &root],
            )
            .map_err(|e| CoreError::rpc("TEST_SEED", e.to_string()))?;
            for i in 0..10 {
                conn.execute(
                    "INSERT INTO chunks (root_hash, rel_path, start_line, end_line, content, mtime)
                     VALUES (?1, ?2, 1, 2, ?3, 0)",
                    params![ws.root_hash, "src/a.rs", format!("fn f{i}() {{}}")],
                )
                .map_err(|e| CoreError::rpc("TEST_SEED", e.to_string()))?;
                let chunk_id = conn.last_insert_rowid();
                conn.execute(
                    "INSERT INTO chunk_vectors (chunk_id, dims, vector) VALUES (?1, 768, ?2)",
                    params![chunk_id, vec![0u8; 768 * 4]],
                )
                .map_err(|e| CoreError::rpc("TEST_SEED", e.to_string()))?;
            }
            Ok(())
        })
        .expect("seed workspace");

    let st = svc.status(&root).expect("status");
    assert_eq!(
        st.embedding_model.as_deref(),
        Some("builtin:bge-base-zh-v1.5@768"),
        "模型取库里实际写入的签名"
    );
    assert_eq!(st.embedding_dims, 768, "维度取库里实际写入的值");
    assert!(st.embedding_enabled);
    assert!(st.embedding_stale, "库里是别的模型，应判为与当前设置不一致");

    // 换成与当前设置一致的签名：不再报警
    handle
        .with_conn(|conn| {
            conn.execute(
                "UPDATE workspaces SET embedding_model = 'test-model@768' WHERE root_hash = ?1",
                params![ws.root_hash],
            )
            .map_err(|e| CoreError::rpc("TEST_SEED", e.to_string()))?;
            Ok(())
        })
        .expect("update model");
    let st2 = svc.status(&root).expect("status");
    assert!(!st2.embedding_stale, "一致时不应提示重建");
}

/// `force` 重建在 embedding 阶段被杀：chunks 已经是新内容、向量几乎全丢，而元数据还停在
/// 上一轮的满值（本机 2026-11-04 现场：元数据 10,846 段向量，库里只剩 1 条）。
///
/// status 必须按**库实数**报，否则面板、「向量一致性」提示、`can_vector` 的判断全都在用
/// 假数字 —— 这正是 `docs/VECTOR-SEARCH.md` §1.1 规则 3 要求的那件事。
#[test]
fn status_reports_real_vector_count_after_interrupted_force_rebuild() {
    let dir = tempdir().unwrap();
    let db = dir.path().join("idx.sqlite");
    let handle = crate::codebase_db::handle(db);
    let cfg = EmbeddingConfig {
        model: "test-model".into(),
        base_url: "http://127.0.0.1:1".into(),
        dimensions: 8,
        ..Default::default()
    };
    let svc = IndexService::new(Arc::clone(&handle), cfg);
    let root = dir.path().to_string_lossy().to_string();
    let ws = resolve_workspace(&root).unwrap();

    handle
        .with_conn(|conn| {
            // 元数据：上一轮的满值（42 段 / 42 条向量，签名与当前设置一致）
            conn.execute(
                "INSERT INTO workspaces (root_hash, root_path, indexing, chunk_count, file_count,
                                         indexed_at, vector_count, embedding_model, embedding_dims)
                 VALUES (?1, ?2, 0, 42, 7, 1700000000, 42, 'test-model@8', 8)",
                params![ws.root_hash, &root],
            )
            .map_err(|e| CoreError::rpc("TEST_SEED", e.to_string()))?;
            // 库里实际：重切后 3 段，向量只活下来 1 条
            for i in 0..3 {
                conn.execute(
                    "INSERT INTO chunks (root_hash, rel_path, start_line, end_line, content, mtime)
                     VALUES (?1, ?2, 1, 2, ?3, 0)",
                    params![ws.root_hash, format!("src/f{i}.rs"), format!("fn f{i}() {{}}")],
                )
                .map_err(|e| CoreError::rpc("TEST_SEED", e.to_string()))?;
            }
            conn.execute(
                "INSERT INTO chunk_vectors (chunk_id, dims, vector)
                 SELECT id, 8, ?2 FROM chunks WHERE root_hash = ?1 LIMIT 1",
                params![ws.root_hash, vec![0u8; 8 * 4]],
            )
            .map_err(|e| CoreError::rpc("TEST_SEED", e.to_string()))?;
            Ok(())
        })
        .expect("seed half-built index");

    let st = svc.status(&root).expect("status");
    assert_eq!(st.chunk_count, 3, "chunk 数应按库实数，不能报上一轮的 42");
    assert_eq!(st.vector_count, 1, "向量数应按库实数，不能报上一轮的 42");

    // 元数据被就地修好，下一次 status（另一个进程也会）看到的就是真值
    let (cc, vc): (i64, i64) = handle
        .with_conn(|conn| {
            conn.query_row(
                "SELECT chunk_count, vector_count FROM workspaces WHERE root_hash = ?1",
                params![ws.root_hash],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .map_err(|e| CoreError::rpc("TEST_SEED", e.to_string()))
        })
        .expect("read repaired meta");
    assert_eq!((cc, vc), (3, 1), "维修应把元数据写成库实数");
}

/// 向量一条不剩（重建在 embedding 开头就死了）：计数归零，**签名也要一起清掉**。
/// 留着旧签名会让面板说「与当前设置一致」、`can_vector` 也会先过签名这一关。
#[test]
fn status_clears_vector_signature_when_vectors_are_gone() {
    let dir = tempdir().unwrap();
    let db = dir.path().join("idx.sqlite");
    let handle = crate::codebase_db::handle(db);
    let cfg = EmbeddingConfig {
        model: "test-model".into(),
        base_url: "http://127.0.0.1:1".into(),
        dimensions: 8,
        ..Default::default()
    };
    let svc = IndexService::new(Arc::clone(&handle), cfg);
    let root = dir.path().to_string_lossy().to_string();
    let ws = resolve_workspace(&root).unwrap();

    handle
        .with_conn(|conn| {
            conn.execute(
                "INSERT INTO workspaces (root_hash, root_path, indexing, chunk_count, file_count,
                                         indexed_at, vector_count, embedding_model, embedding_dims)
                 VALUES (?1, ?2, 0, 2, 1, 1700000000, 42, 'test-model@8', 8)",
                params![ws.root_hash, &root],
            )
            .map_err(|e| CoreError::rpc("TEST_SEED", e.to_string()))?;
            for i in 0..2 {
                conn.execute(
                    "INSERT INTO chunks (root_hash, rel_path, start_line, end_line, content, mtime)
                     VALUES (?1, ?2, 1, 2, ?3, 0)",
                    params![ws.root_hash, format!("src/g{i}.rs"), format!("fn g{i}() {{}}")],
                )
                .map_err(|e| CoreError::rpc("TEST_SEED", e.to_string()))?;
            }
            Ok(())
        })
        .expect("seed workspace without vectors");

    let st = svc.status(&root).expect("status");
    assert_eq!(st.vector_count, 0, "库里没有向量就不能报 42");
    assert_eq!(st.embedding_model, None, "向量为 0 时签名必须清空");
    assert_eq!(st.embedding_dims, 0);
    assert!(!st.embedding_stale, "没有向量就谈不上「与当前设置不一致」");
}

/// 根目录被删掉的工作区要**自动**清干净：chunks / 向量 / 图谱 / workspaces 行全删，
/// 而目录还在的邻居一行都不许动。
#[test]
fn prune_missing_workspaces_drops_rows_of_deleted_dirs_only() {
    let dir = tempdir().unwrap();
    let db = dir.path().join("idx.sqlite");
    let handle = crate::codebase_db::handle(db);
    let svc = IndexService::new(Arc::clone(&handle), EmbeddingConfig::default());

    let alive = dir.path().join("alive");
    let gone = dir.path().join("gone");
    let graph_only = dir.path().join("graph-only");
    std::fs::create_dir_all(&alive).unwrap();
    std::fs::create_dir_all(&gone).unwrap();
    std::fs::create_dir_all(&graph_only).unwrap();
    let alive_key = resolve_workspace(&alive.to_string_lossy()).unwrap();
    let gone_key = resolve_workspace(&gone.to_string_lossy()).unwrap();
    let graph_only_key = resolve_workspace(&graph_only.to_string_lossy()).unwrap();

    for (ws, path) in [(&alive_key, &alive_key.key), (&gone_key, &gone_key.key)] {
        handle
            .with_conn(|conn| {
                conn.execute(
                    "INSERT INTO workspaces (root_hash, root_path, indexing, chunk_count,
                                             file_count, indexed_at, vector_count,
                                             embedding_model, embedding_dims)
                     VALUES (?1, ?2, 0, 2, 1, 1700000000, 2, 'test-model@4', 4)",
                    params![ws.root_hash, path],
                )
                .map_err(|e| CoreError::rpc("TEST_SEED", e.to_string()))?;
                for i in 0..2 {
                    conn.execute(
                        "INSERT INTO chunks (root_hash, rel_path, start_line, end_line, content, mtime)
                         VALUES (?1, 'a.rs', 1, 2, ?2, 0)",
                        params![ws.root_hash, format!("fn f{i}() {{}}")],
                    )
                    .map_err(|e| CoreError::rpc("TEST_SEED", e.to_string()))?;
                    let chunk_id = conn.last_insert_rowid();
                    conn.execute(
                        "INSERT INTO chunk_vectors (chunk_id, dims, vector) VALUES (?1, 4, ?2)",
                        params![chunk_id, vec![0u8; 16]],
                    )
                    .map_err(|e| CoreError::rpc("TEST_SEED", e.to_string()))?;
                }
                conn.execute(
                    "INSERT INTO graph_workspaces (root_hash, root_path) VALUES (?1, ?2)",
                    params![ws.root_hash, path],
                )
                .map_err(|e| CoreError::rpc("TEST_SEED", e.to_string()))?;
                Ok(())
            })
            .expect("seed workspaces");
    }

    // 只在图谱表留痕的孤儿（建过图谱、索引后被重置的仓库就是这个形状）
    handle
        .with_conn(|conn| {
            conn.execute(
                "INSERT INTO graph_workspaces (root_hash, root_path) VALUES (?1, ?2)",
                params![graph_only_key.root_hash, &graph_only_key.key],
            )
            .map_err(|e| CoreError::rpc("TEST_SEED", e.to_string()))?;
            conn.execute(
                "INSERT INTO graph_symbols (root_hash, rel_path, kind, name, qualified_name,
                                            start_line, end_line, mtime)
                 VALUES (?1, 'a.rs', 'function', 'f', 'f', 1, 2, 0)",
                params![graph_only_key.root_hash],
            )
            .map_err(|e| CoreError::rpc("TEST_SEED", e.to_string()))?;
            Ok(())
        })
        .expect("seed graph-only orphan");

    // 目录消失（删掉后不清空 workspaces / graph_workspaces 行）
    std::fs::remove_dir_all(&gone).unwrap();
    std::fs::remove_dir_all(&graph_only).unwrap();

    let mut removed = svc.prune_missing_workspaces();
    removed.sort();
    let mut expected = vec![gone_key.key.clone(), graph_only_key.key.clone()];
    expected.sort();
    assert_eq!(removed, expected, "只该清掉目录已消失的那些");

    handle
        .with_conn(|conn| {
            // (工作区, workspaces, chunks, chunk_vectors, graph_workspaces) 期望行数
            let cases = [
                (&gone_key, (0i64, 0i64, 0i64, 0i64)),
                (&graph_only_key, (0, 0, 0, 0)),
                (&alive_key, (1, 2, 2, 1)),
            ];
            for (ws, expected) in cases {
                let sqls = [
                    "SELECT COUNT(*) FROM workspaces WHERE root_hash = ?1",
                    "SELECT COUNT(*) FROM chunks WHERE root_hash = ?1",
                    "SELECT COUNT(*) FROM chunk_vectors WHERE chunk_id IN
                         (SELECT id FROM chunks WHERE root_hash = ?1)",
                    "SELECT COUNT(*) FROM graph_workspaces WHERE root_hash = ?1",
                ];
                for (sql, want) in sqls.into_iter().zip([
                    expected.0, expected.1, expected.2, expected.3,
                ]) {
                    let n: i64 = conn
                        .query_row(sql, params![ws.root_hash], |r| r.get(0))
                        .map_err(|e| CoreError::rpc("TEST_SEED", e.to_string()))?;
                    assert_eq!(n, want, "{sql} 对 {}", ws.key);
                }
            }
            // 图谱符号也要跟着清（只删 graph_workspaces 会留下无主的符号/调用边）
            let symbols: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM graph_symbols WHERE root_hash = ?1",
                    params![graph_only_key.root_hash],
                    |r| r.get(0),
                )
                .map_err(|e| CoreError::rpc("TEST_SEED", e.to_string()))?;
            assert_eq!(symbols, 0, "孤儿工作区的图谱符号必须一起清掉");
            Ok(())
        })
        .expect("verify pruned rows");
}

/// 远端工作区与「整卷离线」的工作区不许清：前者本地看不看得见与数据无关，
/// 后者是暂时的（插回移动盘后索引仍然有效）。
#[test]
fn prune_keeps_remote_keys_and_offline_volumes() {
    let dir = tempdir().unwrap();
    let db = dir.path().join("idx.sqlite");
    let handle = crate::codebase_db::handle(db);
    let svc = IndexService::new(Arc::clone(&handle), EmbeddingConfig::default());

    let remote_key = "ssh://dev@192.168.1.10/home/dev/project";
    let remote_hash = dieyun_base::config::workspace_key_hash(remote_key);
    handle
        .with_conn(|conn| {
            conn.execute(
                "INSERT INTO workspaces (root_hash, root_path, indexed_at) VALUES (?1, ?2, 1700000000)",
                params![remote_hash, remote_key],
            )
            .map_err(|e| CoreError::rpc("TEST_SEED", e.to_string()))?;
            Ok(())
        })
        .expect("seed remote workspace");

    // 找一个本机不存在的卷，构造「盘没插」形态的路径；机器上所有盘符都在时跳过这段
    let offline = ('D'..='Z')
        .map(|c| format!("{c}:\\"))
        .find(|root| !Path::new(root).exists())
        .map(|root| format!("{root}nope\\project"));
    if let Some(offline) = offline {
        assert!(
            !local_root_vanished(Path::new(&offline)),
            "整卷离线时不能判成「目录已消失」：{offline}"
        );
        let hash = dieyun_base::config::hash_workspace_root(Path::new(&offline));
        handle
            .with_conn(|conn| {
                conn.execute(
                    "INSERT INTO workspaces (root_hash, root_path, indexed_at) VALUES (?1, ?2, 1700000000)",
                    params![hash, offline],
                )
                .map_err(|e| CoreError::rpc("TEST_SEED", e.to_string()))?;
                Ok(())
            })
            .expect("seed offline workspace");
    }

    assert!(
        svc.prune_missing_workspaces().is_empty(),
        "远端 key 与离线卷都不该被清"
    );
    handle
        .with_conn(|conn| {
            let n: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM workspaces",
                    [],
                    |r| r.get(0),
                )
                .map_err(|e| CoreError::rpc("TEST_SEED", e.to_string()))?;
            assert!(n >= 1, "远端工作区必须还在");
            Ok(())
        })
        .expect("verify kept rows");
}

#[test]
fn start_index_returns_immediately() {
    let dir = tempdir().unwrap();
    std::fs::write(dir.path().join("a.js"), "console.log('a');\n").unwrap();
    let db = dir.path().join("idx.sqlite");
    let svc = IndexService::new(
        crate::codebase_db::handle(db),
        EmbeddingConfig::default(),
    );
    let root = dir.path().to_string_lossy().to_string();
    let started = svc.start_index_workspace(&root, true, true, false).unwrap();
    assert!(started.started);
    assert!(started.status.indexing);
    assert_eq!(started.status.phase.as_deref(), Some("walking"));
    // 给后台线程一点时间；不强制 join，避免阻塞 CI
    std::thread::sleep(std::time::Duration::from_millis(300));
    let again = svc.start_index_workspace(&root, true, true, false).unwrap();
    // 要么仍在跑要么已完成
    assert!(again.already_running || again.status.indexed || again.started || !again.status.indexing);
}

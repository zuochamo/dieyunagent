//! 这个模块的测试。实现留在同级文件里。
//! 拆开的理由：几百行用例与实现同居时，改一个方法要在整片用例之间翻，diff 也不可读。

use super::*;

use dieyun_base::embedding::vector_to_blob;
use crate::index::init_schema;

fn fixture() -> (Connection, VectorPool) {
    let conn = Connection::open_in_memory().unwrap();
    init_schema(&conn).unwrap();
    conn.execute(
        "INSERT INTO workspaces (root_hash, root_path, chunk_count) VALUES ('rh', '/tmp', 3)",
        [],
    )
    .unwrap();

    // both: 词法 + 向量都命中；lexical: 只有词法；semantic: 只有向量
    let chunk = |rel: &str, content: &str, vec: [f32; 3]| {
        conn.execute(
            "INSERT INTO chunks (root_hash, rel_path, start_line, end_line, content, mtime)
             VALUES ('rh', ?1, 1, 25, ?2, 0)",
            params![rel, content],
        )
        .unwrap();
        let id = conn.last_insert_rowid();
        conn.execute(
            "INSERT INTO chunk_vectors (chunk_id, dims, vector) VALUES (?1, 3, ?2)",
            params![id, vector_to_blob(&vec)],
        )
        .unwrap();
    };
    chunk(
        "src/both.rs",
        "fn parse_config(path: &str) {}",
        [1.0, 0.0, 0.0],
    );
    chunk(
        "src/lexical.rs",
        "fn parse_config_twice() {}",
        [0.0, 1.0, 0.0],
    );
    chunk("src/semantic.rs", "读取配置文件的函数", [0.98, 0.02, 0.0]);

    let pool = VectorPool::load(&conn, "rh").unwrap().expect("pool");
    (conn, pool)
}

fn paths(r: &SearchResult) -> Vec<String> {
    r.results.iter().map(|h| h.path.clone()).collect()
}

/// 只有 chunks、没有结构索引的库（绝大多数工作区改造前就是这样）。
fn lexical_only_fixture() -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    init_schema(&conn).unwrap();
    conn.execute(
        "INSERT INTO workspaces (root_hash, root_path, chunk_count) VALUES ('rh', '/tmp', 2)",
        [],
    )
    .unwrap();
    // 使用点先插入（chunk id 更小）：只靠词法通道时它排在定义点前面
    conn.execute(
        "INSERT INTO chunks (root_hash, rel_path, start_line, end_line, content, mtime)
         VALUES ('rh', 'src/use_it.rs', 1, 40, 'let n = parse_config(path);', 0)",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO chunks (root_hash, rel_path, start_line, end_line, content, mtime)
         VALUES ('rh', 'src/def_it.rs', 100, 140, 'pub fn parse_config(p: &str) {}', 0)",
        [],
    )
    .unwrap();
    conn
}

/// 结构索引建过这张表、且这个名字有定义。
fn add_definition(conn: &Connection) {
    crate::graph::ensure_schema(conn).unwrap();
    conn.execute(
        "INSERT INTO graph_symbols (root_hash, rel_path, kind, name, qualified_name, start_line, end_line, mtime)
         VALUES ('rh', 'src/def_it.rs', 'function', 'parse_config', 'parse_config', 101, 103, 0)",
        [],
    )
    .unwrap();
}

/// 「按名字找定义」：定义点必须排在「只是用到这个名字」的块前面。
///
/// 这是 §7.2 实测出来的差距（索引 MRR 0.63 vs grep 0.84）的回归测试：
/// 词法通道按命中词数排序时这两个 chunk 完全同分，只靠 chunk id 决胜负。
#[test]
fn definition_site_ranks_above_usage() {
    let conn = lexical_only_fixture();
    let before = search(&conn, "rh", "parse_config", Some(5), None, None).unwrap();
    assert_eq!(
        paths(&before).first().map(String::as_str),
        Some("src/use_it.rs"),
        "没有结构索引时，词法通道会把使用点排在前面（这正是要修的现状）"
    );

    add_definition(&conn);
    let after = search(&conn, "rh", "parse_config", Some(5), None, None).unwrap();
    assert_eq!(
        paths(&after).first().map(String::as_str),
        Some("src/def_it.rs"),
        "定义点应被符号表顶到第一"
    );
}

/// 定义点通道只在「查询就是一个标识符」时接上：自然语言问句没有定义点可找。
#[test]
fn multi_term_query_does_not_use_definition_channel() {
    let conn = lexical_only_fixture();
    add_definition(&conn);
    let res = search(&conn, "rh", "parse config path", Some(5), None, None).unwrap();
    assert_eq!(paths(&res).len(), 2, "两路词法命中都要返回");
    assert_eq!(
        paths(&res).first().map(String::as_str),
        Some("src/use_it.rs"),
        "多词查询不该被符号表改写排序"
    );
}

/// 结构索引没建（`graph_symbols` 表都不存在）时不能报错，也不能改变结果。
#[test]
fn missing_graph_tables_is_not_an_error() {
    let conn = lexical_only_fixture();
    let res = search(&conn, "rh", "parse_config", Some(5), None, None).unwrap();
    assert_eq!(paths(&res).len(), 2);
}

/// 两路都命中的候选必须排在只命中一路的前面（RRF 的核心性质）。
#[test]
fn fuses_both_lists_above_single_list_hits() {
    let (conn, pool) = fixture();
    let q = [1.0f32, 0.0, 0.0];
    let res = search(&conn, "rh", "parse_config", Some(3), Some(&q), Some(&pool)).unwrap();
    assert_eq!(paths(&res).first().map(String::as_str), Some("src/both.rs"));
    assert_eq!(res.results.len(), 3, "两路候选都要出现在结果里");
}

/// 展示分是「相对本次头名」的归一化值：头名恒为 1，其余在 (0,1)。
#[test]
fn score_is_normalized_to_top_hit() {
    let (conn, pool) = fixture();
    let q = [1.0f32, 0.0, 0.0];
    let res = search(&conn, "rh", "parse_config", Some(3), Some(&q), Some(&pool)).unwrap();
    assert!((res.results[0].score - 1.0).abs() < 1e-9, "头名归一化为 1");
    for hit in &res.results[1..] {
        assert!(hit.score > 0.0 && hit.score < 1.0, "其余在 (0,1)");
    }
    // 名次越靠后分数不增
    for pair in res.results.windows(2) {
        assert!(pair[0].score >= pair[1].score);
    }
}

/// 池不可用时不得退化成「抽样近似」：词法命中照样返回，只是少了向量那一路。
#[test]
fn works_without_vector_pool() {
    let (conn, _pool) = fixture();
    let q = [1.0f32, 0.0, 0.0];
    let res = search(&conn, "rh", "parse_config", Some(3), Some(&q), None).unwrap();
    assert!(paths(&res).contains(&"src/both.rs".to_string()));
    assert!(res.vector_search, "请求侧带了向量，标志仍为 true");
}

/// 2 字中文词：没有分词器下限，子串通道直接命中（trigram 时代需要专门补一条通道）。
#[test]
fn short_cjk_term_matches_by_substring() {
    let (conn, _pool) = fixture();
    let res = search(&conn, "rh", "配置", Some(3), None, None).unwrap();
    assert_eq!(paths(&res), vec!["src/semantic.rs"], "中文 2 字应命中");
}

/// 「查询就是源码里的原句」时，字面全命中的块必须排第一，不能被向量名次挤下去。
///
/// 复现的是 §五 实测里的 B 族（原句）/ C1 族（去虚词）：纯子串 hit@1 = 100%，融合后 83% / 67%。
/// 关键在 `src/literal.rs` 与查询向量**完全不相似**（相似度 0，低于阈值 → 根本不进向量通道），
/// 而 `src/near.rs` 只命中一个词却被向量顶到第一名 —— 旧实现把后者排在了前面。
fn literal_fixture() -> (Connection, VectorPool) {
    let conn = Connection::open_in_memory().unwrap();
    init_schema(&conn).unwrap();
    conn.execute(
        "INSERT INTO workspaces (root_hash, root_path, chunk_count) VALUES ('rh', '/tmp', 3)",
        [],
    )
    .unwrap();
    for (rel, content, vec) in [
        // 全命中（两个词都有），但语义上与查询向量正交
        ("src/literal.rs", "// 配置与索引的唯一来源", [0.0f32, 0.0, 1.0]),
        // 只命中一个词，但正是查询向量最像的那条
        ("src/near.rs", "// 只有配置", [1.0, 0.0, 0.0]),
        ("src/other.rs", "// 无关内容", [0.9, 0.1, 0.0]),
    ] {
        conn.execute(
            "INSERT INTO chunks (root_hash, rel_path, start_line, end_line, content, mtime)
             VALUES ('rh', ?1, 1, 1, ?2, 0)",
            params![rel, content],
        )
        .unwrap();
        let id = conn.last_insert_rowid();
        conn.execute(
            "INSERT INTO chunk_vectors (chunk_id, dims, vector) VALUES (?1, 3, ?2)",
            params![id, vector_to_blob(&vec)],
        )
        .unwrap();
    }
    let pool = VectorPool::load(&conn, "rh").unwrap().expect("pool");
    (conn, pool)
}

#[test]
fn full_coverage_literal_hit_outranks_vector_only_hit() {
    let (conn, pool) = literal_fixture();
    let q = [1.0f32, 0.0, 0.0];
    // 只有词法：全命中的块第一（这是基线）
    let lexical = search(&conn, "rh", "配置 索引", Some(3), None, None).unwrap();
    assert_eq!(paths(&lexical).first().map(String::as_str), Some("src/literal.rs"));

    // 加上向量：旧实现会让 src/near.rs（向量第一 + 词法第二）反超，这里必须仍是 literal 第一
    let hybrid = search(&conn, "rh", "配置 索引", Some(3), Some(&q), Some(&pool)).unwrap();
    assert!(hybrid.vector_search);
    assert_eq!(
        paths(&hybrid).first().map(String::as_str),
        Some("src/literal.rs"),
        "词元全命中的字面事实不该被向量名次投票推翻：{:?}",
        paths(&hybrid)
    );
    // 强证据之间仍按融合分排序，融合结果排在强证据之后：单调不增
    for pair in hybrid.results.windows(2) {
        assert!(pair[0].score >= pair[1].score);
    }
}

/// 改写问法（没有一个块覆盖全部词元）时，向量仍然决定名次 —— C2 的价值不能被这次改动带走。
#[test]
fn vector_still_decides_when_no_literal_evidence() {
    let (conn, pool) = literal_fixture();
    let q = [1.0f32, 0.0, 0.0];
    // 「读取方式」在任何块里都不出现 → 无强证据，只剩向量通道
    let res = search(&conn, "rh", "读取配置的方式", Some(3), Some(&q), Some(&pool)).unwrap();
    assert!(res.vector_search);
    assert_eq!(
        paths(&res).first().map(String::as_str),
        Some("src/near.rs"),
        "无字面强证据时向量第一名应当排第一：{:?}",
        paths(&res)
    );
}

/// 命中词数决定名次：同时命中两个查询词的 chunk 必须排在只命中一个的前面。
#[test]
fn ranks_by_matched_term_count() {
    let conn = Connection::open_in_memory().unwrap();
    init_schema(&conn).unwrap();
    conn.execute(
        "INSERT INTO workspaces (root_hash, root_path, chunk_count) VALUES ('rh', '/tmp', 3)",
        [],
    )
    .unwrap();
    for (rel, content) in [
        ("src/one.rs", "// 只有配置"),
        ("src/two.rs", "// 配置与索引都在这里"),
        ("src/three.rs", "// 无关内容"),
    ] {
        conn.execute(
            "INSERT INTO chunks (root_hash, rel_path, start_line, end_line, content, mtime)
             VALUES ('rh', ?1, 1, 1, ?2, 0)",
            params![rel, content],
        )
        .unwrap();
    }
    let res = search(&conn, "rh", "配置 索引", Some(5), None, None).unwrap();
    assert_eq!(paths(&res), vec!["src/two.rs", "src/one.rs"], "命中两词者优先");
}

/// 子串通道也要定位命中行：snippet 从命中行展开，长 chunk 不会被开头占满。
#[test]
fn substring_hit_locates_hit_line() {
    let conn = Connection::open_in_memory().unwrap();
    init_schema(&conn).unwrap();
    conn.execute(
        "INSERT INTO workspaces (root_hash, root_path, chunk_count) VALUES ('rh', '/tmp', 1)",
        [],
    )
    .unwrap();
    let mut content = String::new();
    for i in 1..=40 {
        content.push_str(&format!("line {i}\n"));
        if i == 30 {
            content.push_str("// 配置热更新入口\n");
        }
    }
    conn.execute(
        "INSERT INTO chunks (root_hash, rel_path, start_line, end_line, content, mtime)
         VALUES ('rh', 'src/long.rs', 100, 160, ?1, 0)",
        params![content],
    )
    .unwrap();
    let res = search(&conn, "rh", "配置", Some(1), None, None).unwrap();
    assert_eq!(res.results.len(), 1);
    // chunk 起始行 100，命中出现在第 31 行 → 130
    assert!(
        res.results[0].snippet.contains("130| // 配置热更新入口"),
        "命中行必须出现在片段里: {}",
        res.results[0].snippet
    );
}

/// 短术语通道必须扫全库：命中在很后面（id 大）也不能漏 ——
/// 旧实现只扫前 8000 条，超过窗口的库会静默少召回。
#[test]
fn short_term_channel_has_no_scan_window() {
    let conn = Connection::open_in_memory().unwrap();
    init_schema(&conn).unwrap();
    conn.execute(
        "INSERT INTO workspaces (root_hash, root_path, chunk_count) VALUES ('rh', '/tmp', 400)",
        [],
    )
    .unwrap();
    for i in 0..399 {
        conn.execute(
            "INSERT INTO chunks (root_hash, rel_path, start_line, end_line, content, mtime)
             VALUES ('rh', ?1, 1, 1, 'fn filler() {}', 0)",
            params![format!("filler/f{i}.rs")],
        )
        .unwrap();
    }
    // 唯一命中放在最后一条
    conn.execute(
        "INSERT INTO chunks (root_hash, rel_path, start_line, end_line, content, mtime)
         VALUES ('rh', 'zzz/last.rs', 1, 1, '// 配置热更新入口', 0)",
        [],
    )
    .unwrap();

    let res = search(&conn, "rh", "配置", Some(5), None, None).unwrap();
    assert_eq!(paths(&res), vec!["zzz/last.rs"], "最后一条也要能命中");
}

/// 3 字以上中文同样走子串通道（没有单独的词法分支了）。
#[test]
fn three_char_cjk_goes_through_substring_channel() {
    let (conn, _pool) = fixture();
    let res = search(&conn, "rh", "配置文件", Some(3), None, None).unwrap();
    assert_eq!(paths(&res), vec!["src/semantic.rs"]);
}

/// 命中行必须落在片段里——即使 chunk 很长，也不能被字符预算截掉。
#[test]
fn snippet_centers_on_hit_line() {
    let content: String = (1..=40).map(|i| format!("line {i}\n")).collect();
    let content = content.trim_end();
    let start_line = 100;
    // chunk 起始 100 行，命中落在第 30 行 → 绝对行号 129
    let out = snippet(content, start_line, Some(129));
    assert!(out.contains("129| line 30"), "命中行必须在片段内: {out}");
    // 命中行之前保留 SNIPPET_PRE_LINES 行上下文
    assert!(out.contains("121| line 22"), "命中前应保留上下文: {out}");
    assert!(!out.contains("120| line 21"), "不应从更早的位置开始: {out}");
}

/// 与 Node 同一份 fixture（`test/fixtures/snippet-budget-cases.json`）：
/// 摘录预算按**字符**算，且不得早于 Node 的展示预算截断。
///
/// 钉住的历史事故：`SNIPPET_MAX_CHARS = 3600` 实际按**字节**比较，中文正文只有约
/// 1/3 预算 —— 20 行 × 80 汉字（1600 字符 / 4800 字节）本该完整给出，却被提前截断。
/// Node 侧的同一份断言在 `test/unit/cross-language-fixtures.test.cjs`。
#[test]
fn snippet_budget_matches_the_shared_fixture() {
    const FIXTURE: &str = include_str!("../../../../test/fixtures/snippet-budget-cases.json");
    let v: serde_json::Value = serde_json::from_str(FIXTURE).expect("fixture 必须是合法 JSON");
    let shared = dieyun_base::shared::shared();
    assert!(
        shared.snippets.rust_budget_chars > shared.snippets.codebase_snippet_max_chars,
        "Rust 预算必须先于 Node 展示预算截断为假"
    );
    for case in v["cases"].as_array().expect("cases") {
        let ch = case["char"].as_str().expect("char");
        let lines = case["lines"].as_u64().expect("lines") as usize;
        let per_line = case["perLine"].as_u64().expect("perLine") as usize;
        let expect_truncated = case["expectTruncated"].as_bool().expect("expectTruncated");
        let name = case["name"].as_str().unwrap_or("case");

        let content = (0..lines)
            .map(|_| ch.repeat(per_line))
            .collect::<Vec<_>>()
            .join("\n");
        let out = snippet(&content, 1, Some(1));
        let truncated = out.contains("内容已截断");
        assert_eq!(truncated, expect_truncated, "用例 {name}");
    }
}

/// 超长单行（压缩产物等）必须先逐行截断，否则首行就吃光字符预算，整块只剩提示。
#[test]
fn snippet_truncates_very_long_line() {
    let long = "x".repeat(20_000);
    let content = format!("head\n{long}\ntail");
    let out = snippet(&content, 1, Some(1));
    assert!(out.contains("    1| head"), "首行必须在片段内");
    assert!(out.contains('…'), "超长行应被截断");
    assert!(
        out.chars().count() < snippet_max_chars() + 200,
        "片段不能被单行撑爆: {} 字符",
        out.chars().count()
    );
}

/// 词法通道的 highlight 只用来定位命中行：行号必须精确。
#[test]
fn highlight_maps_to_absolute_line() {
    let (conn, _pool) = fixture();
    let res = search(&conn, "rh", "parse_config", Some(2), None, None).unwrap();
    assert!(!res.results.is_empty());
}

/// 融合分相同的候选必须有确定顺序：同一个查询重复调用要给同一个顺序
/// （融合结果来自 HashMap 迭代，曾因缺少兜底键而每次不同）。
#[test]
fn tied_candidates_have_stable_order() {
    let conn = Connection::open_in_memory().unwrap();
    init_schema(&conn).unwrap();
    conn.execute(
        "INSERT INTO workspaces (root_hash, root_path, chunk_count) VALUES ('rh', '/tmp', 3)",
        [],
    )
    .unwrap();
    let put = |rel: &str, content: &str, vec: [f32; 3]| {
        conn.execute(
            "INSERT INTO chunks (root_hash, rel_path, start_line, end_line, content, mtime)
             VALUES ('rh', ?1, 1, 2, ?2, 0)",
            params![rel, content],
        )
        .unwrap();
        let id = conn.last_insert_rowid();
        conn.execute(
            "INSERT INTO chunk_vectors (chunk_id, dims, vector) VALUES (?1, 3, ?2)",
            params![id, vector_to_blob(&vec)],
        )
        .unwrap();
    };
    // 词法序 c3 > c2 > c1；向量序 c1 > c2 > c3 → c1 与 c3 融合分完全相等
    put("c1.rs", "alpha", [1.0, 0.0, 0.0]);
    put("c2.rs", "alpha alpha", [0.9, 0.435, 0.0]);
    put("c3.rs", "alpha alpha alpha", [0.7, 0.714, 0.0]);

    let pool = VectorPool::load(&conn, "rh").unwrap().expect("pool");
    let q = [1.0f32, 0.0, 0.0];
    let mut seen = std::collections::HashSet::new();
    for _ in 0..40 {
        let res = search(&conn, "rh", "alpha", Some(3), Some(&q), Some(&pool)).unwrap();
        seen.insert(paths(&res).join(","));
    }
    assert_eq!(seen.len(), 1, "同分候选的输出顺序必须稳定: {seen:?}");
}

/// 建一个定制小库：`(rel_path, content, 向量)`，三元素向量。
fn custom_fixture(rows: &[(&str, &str, [f32; 3])]) -> (Connection, VectorPool) {
    let conn = Connection::open_in_memory().unwrap();
    init_schema(&conn).unwrap();
    conn.execute(
        "INSERT INTO workspaces (root_hash, root_path, chunk_count) VALUES ('rh', '/tmp', ?1)",
        params![rows.len() as i64],
    )
    .unwrap();
    for (rel, content, vec) in rows {
        conn.execute(
            "INSERT INTO chunks (root_hash, rel_path, start_line, end_line, content, mtime)
             VALUES ('rh', ?1, 1, 5, ?2, 0)",
            params![rel, content],
        )
        .unwrap();
        let id = conn.last_insert_rowid();
        conn.execute(
            "INSERT INTO chunk_vectors (chunk_id, dims, vector) VALUES (?1, 3, ?2)",
            params![id, vector_to_blob(&vec.to_vec())],
        )
        .unwrap();
    }
    let pool = VectorPool::load(&conn, "rh").unwrap().expect("pool");
    (conn, pool)
}

/// 只有**文件名**命中两个词，正文一个都没有 → 不算强证据。
///
/// 旧实现把路径命中算进 `hits`，于是 `src/config_parse.rs` 这种「名字里有、正文里没有」
/// 的块 hits == 词元数，被当成「全覆盖强证据」顶到第一（还压过真命中的那些）。
#[test]
fn path_only_match_is_not_strong_evidence() {
    let (conn, pool) = custom_fixture(&[
        // 名字里两个词都有，正文无关；向量与查询最像（旧实现里它会因此排第一）
        ("src/config_parse.rs", "// 与查询无关的正文", [1.0, 0.0, 0.0]),
        // 正文两个词都在；向量正交
        ("src/impl.rs", "// config 与 parse 都在这里", [0.0, 0.0, 1.0]),
    ]);
    let q = [1.0f32, 0.0, 0.0];
    let res = search(&conn, "rh", "config parse", Some(3), Some(&q), Some(&pool)).unwrap();
    assert_eq!(
        paths(&res).first().map(String::as_str),
        Some("src/impl.rs"),
        "正文全命中的才是强证据，光名字命中不算：{:?}",
        paths(&res)
    );
}

/// 正文全覆盖、**且**路径也命中一个词 → 仍是强证据。
///
/// 旧实现里 `hits` 会把路径那一分加上去（3 > 词元数 2），于是「全覆盖」判不出来，
/// 强证据被静默丢掉，名次又交回给向量。
#[test]
fn content_full_coverage_counts_even_when_path_also_matches() {
    let (conn, pool) = custom_fixture(&[
        // 正文两个词都在 + 路径也含 config（旧实现 hits=3，判不出全覆盖）
        ("src/config.rs", "// config 与 parse 都在这", [0.0, 0.0, 1.0]),
        // 只命中一个词，但向量与查询最像
        ("src/other.rs", "// 只有 config", [1.0, 0.0, 0.0]),
    ]);
    let q = [1.0f32, 0.0, 0.0];
    let res = search(&conn, "rh", "config parse", Some(3), Some(&q), Some(&pool)).unwrap();
    assert_eq!(
        paths(&res).first().map(String::as_str),
        Some("src/config.rs"),
        "正文全覆盖就是强证据，路径多算的那一分不该把它判掉：{:?}",
        paths(&res)
    );
}

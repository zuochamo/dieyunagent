//! 这个模块的测试。实现留在同级文件里。
//! 拆开的理由：几百行用例与实现同居时，改一个方法要在整片用例之间翻，diff 也不可读。

use super::*;

use crate::graph::extract::files::is_graph_path;
use crate::graph::extract::go::is_go_path;
use crate::graph::extract::js_ts::is_js_ts_path;
use crate::graph::extract::python::is_python_path;
use crate::graph::extract::rust_lang::is_rust_path;
use std::fs;
use std::path::PathBuf;

fn test_graph(db: std::path::PathBuf) -> GraphService {
    GraphService::new(crate::codebase_db::handle(db))
}

#[test]
fn indexes_dieyunagent_main_entry_imports() {
    let repo = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    if !repo.join("src/main-entry.js").is_file() {
        return;
    }
    let dir = tempfile::tempdir().unwrap();
    let svc = test_graph(dir.path().join("graph-test.db"));
    let root = repo.canonicalize().unwrap();
    let st = svc
        .index_workspace(&root.to_string_lossy(), true, GraphScope::WithCalls)
        .expect("index");
    assert!(st.edge_count > 0, "expected import edges");
    assert!(st.symbol_count > 0, "expected symbols");
    assert!(st.call_count > 0, "expected calls");

    let deps = svc
        .module_deps(&root.to_string_lossy(), Some("src/main-entry.js"), Some(1))
        .expect("deps");
    let has_core_bridge = deps.dependencies.iter().any(|e| {
        e.spec.contains("core-bridge") || e.to.as_deref() == Some("src/core-bridge.js")
    });
    assert!(has_core_bridge, "main-entry should import core-bridge");

    let hits = svc
        .symbol_search(
            &root.to_string_lossy(),
            "repairMcpEnvironment",
            None,
            Some(5),
        )
        .expect("search");
    assert!(
        hits.results
            .iter()
            .any(|s| s.name == "repairMcpEnvironment"),
        "should find repairMcpEnvironment symbol"
    );
}

#[test]
fn skips_non_graph_files_in_build_list() {
    assert!(is_js_ts_path("a.ts"));
    assert!(is_python_path("a.py"));
    assert!(is_go_path("main.go"));
    assert!(is_rust_path("lib.rs"));
    assert!(!is_graph_path("a.java"));
}

/// 读侧：状态秒回、数据查询不占常驻锁。另一个连接占着写事务时同样不许被堵。
///
/// 常驻连接被 index / graph 共用一把非重入锁，慢读占住它 => 所有 status 撞到宿主 15s 预算
/// （见 `docs/SQLITE-ACCESS.md`）。
#[test]
fn graph_reads_do_not_wait_on_open_write_transaction() {
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("graph.sqlite");
    let handle = crate::codebase_db::handle(db);
    let svc = GraphService::new(Arc::clone(&handle));
    let root = dir.path().to_string_lossy().to_string();
    let ws = resolve_workspace(&root).unwrap();

    // 造脏状态：indexing=1（崩溃残留），且已有一个符号
    handle
        .with_conn(|conn| {
            conn.execute(
                "INSERT INTO graph_workspaces (root_hash, root_path, indexing, indexed_at)
                 VALUES (?1, ?2, 1, 1)",
                params![ws.root_hash, &root],
            )
            .map_err(|e| CoreError::rpc("TEST_SEED", e.to_string()))?;
            conn.execute(
                "INSERT INTO graph_symbols (root_hash, rel_path, kind, name, qualified_name,
                                            start_line, end_line, mtime)
                 VALUES (?1, 'a.rs', 'function', 'alpha', 'a.rs::alpha', 1, 2, 0)",
                params![ws.root_hash],
            )
            .map_err(|e| CoreError::rpc("TEST_SEED", e.to_string()))?;
            Ok(())
        })
        .expect("seed stale graph workspace");

    let writer = handle.open_dedicated().expect("open writer");
    writer
        .execute_batch(
            "BEGIN IMMEDIATE;
             INSERT INTO graph_symbols (root_hash, rel_path, kind, name, qualified_name,
                                        start_line, end_line, mtime)
             VALUES ('other', 'b.rs', 'function', 'beta', 'b.rs::beta', 1, 2, 0);",
        )
        .expect("hold write transaction");

    let started = std::time::Instant::now();
    let st = svc.status(&root).expect("status");
    let status_elapsed = started.elapsed();

    let started = std::time::Instant::now();
    let hits = svc
        .symbol_search(&root, "alpha", None, Some(5))
        .expect("symbol_search");
    let search_elapsed = started.elapsed();

    writer.execute_batch("ROLLBACK").expect("rollback");
    drop(writer);

    assert!(!st.indexing, "没人在跑结构索引时不应报 indexing");
    assert!(
        hits.results.iter().any(|s| s.name == "alpha"),
        "写事务在飞时读侧仍应看到已提交的符号"
    );
    assert!(
        status_elapsed < std::time::Duration::from_secs(1),
        "graph.status 等了 {status_elapsed:?}：读路径被写锁堵住了"
    );
    assert!(
        search_elapsed < std::time::Duration::from_secs(2),
        "symbol_search 等了 {search_elapsed:?}：读路径被写锁堵住了"
    );
}

#[test]
fn temp_go_graph_roundtrip() {
    let dir = tempfile::tempdir().unwrap();
    fs::create_dir_all(dir.path().join("helper")).unwrap();
    fs::write(
        dir.path().join("main.go"),
        "package main\nimport \"./helper\"\nfunc main() { helper.Run() }\n",
    )
    .unwrap();
    fs::write(
        dir.path().join("helper").join("helper.go"),
        "package helper\nfunc Run() {}\n",
    )
    .unwrap();

    let svc = test_graph(dir.path().join("g.db"));
    let root = dir.path().canonicalize().unwrap();
    let st = svc
        .index_workspace(&root.to_string_lossy(), true, GraphScope::WithCalls)
        .unwrap();
    assert_eq!(st.file_count, 2);
    assert!(st.edge_count >= 1);
    assert!(st.symbol_count >= 2);
}

/// 增量重建时只改了**被调用方**：其它文件指向它的调用边不能丢。
///
/// 曾经 `clear_file_graph` 会把 `callee_symbol_id` 指向本文件符号的行整行删掉，
/// 而那些调用方文件没变、增量直接跳过 → 调用关系再也不会被插回来，图谱随每次
/// 编辑变稀疏（实测 callers(foo): 1 → 0）。
#[test]
fn incremental_rebuild_keeps_inbound_call_sites() {
    let dir = tempfile::tempdir().unwrap();
    fs::write(
        dir.path().join("aa.js"),
        "export function foo() { return 1; }\nexport function baz() { return 3; }\n",
    )
    .unwrap();
    fs::write(
        dir.path().join("zz.js"),
        "import { foo } from './aa.js';\nexport function useIt() { return foo(); }\n",
    )
    .unwrap();

    let svc = test_graph(dir.path().join("g.db"));
    let root = dir.path().canonicalize().unwrap();
    let key = root.to_string_lossy().to_string();
    let st = svc.index_workspace(&key, true, GraphScope::WithCalls).unwrap();
    assert_eq!(st.call_count, 1, "首次建库应有 1 条调用边");
    let before = svc.callers(&key, None, None, Some("foo")).unwrap();
    assert_eq!(before.sites.len(), 1, "首次建库应能查到调用点");
    assert_eq!(before.sites[0].caller_path, "zz.js");

    // 只改被调用方：aa.js 追加一个无关函数，zz.js 一动不动
    std::thread::sleep(std::time::Duration::from_millis(20));
    fs::write(
        dir.path().join("aa.js"),
        "export function foo() { return 1; }\nexport function baz() { return 3; }\nexport function extra() { return 2; }\n",
    )
    .unwrap();
    svc.index_workspace(&key, false, GraphScope::WithCalls).unwrap();

    let after = svc.callers(&key, None, None, Some("foo")).unwrap();
    assert_eq!(
        after
            .sites
            .iter()
            .filter(|s| s.caller_path == "zz.js")
            .count(),
        1,
        "增量重建后入边不能丢: {:?}",
        after.sites
    );
}

/// 解析不受文件处理顺序影响：调用方排在前面（先处理）时也要解析成功。
#[test]
fn call_resolution_does_not_depend_on_file_order() {
    let dir = tempfile::tempdir().unwrap();
    // aa.js 先处理，它调用 zz.js 里的唯一函数 foo
    fs::write(
        dir.path().join("aa.js"),
        "import { foo } from './zz.js';\nexport function callIt() { return foo(); }\n",
    )
    .unwrap();
    fs::write(dir.path().join("zz.js"), "export function foo() { return 1; }\n").unwrap();

    let svc = test_graph(dir.path().join("g.db"));
    let root = dir.path().canonicalize().unwrap();
    let key = root.to_string_lossy().to_string();
    svc.index_workspace(&key, true, GraphScope::WithCalls).unwrap();

    let res = svc.callers(&key, None, None, Some("foo")).unwrap();
    assert_eq!(res.sites.len(), 1, "应查到 aa.js 的调用点");
    assert!(
        res.sites[0].callee_symbol_id.is_some(),
        "名字唯一的跨文件调用必须被解析，不该留成未解析: {:?}",
        res.sites[0]
    );
}

/// 调用归属必须看符号的作用域：函数体之后的文件级调用不能算到上一个函数头上。
#[test]
fn file_level_calls_are_not_attributed_to_previous_function() {
    let dir = tempfile::tempdir().unwrap();
    fs::write(
        dir.path().join("server.js"),
        "export function setup() {\n  return 1;\n}\nserver.listen(3000);\n",
    )
    .unwrap();

    let svc = test_graph(dir.path().join("g.db"));
    let root = dir.path().canonicalize().unwrap();
    let key = root.to_string_lossy().to_string();
    svc.index_workspace(&key, true, GraphScope::WithCalls).unwrap();

    let res = svc.callees(&key, None, Some("server.js"), Some("setup")).unwrap();
    assert!(
        !res.sites.iter().any(|s| s.callee_name == "listen"),
        "listen 在 setup 作用域之外，不该算成 setup 的调用: {:?}",
        res.sites
    );
}

/// 符号被改名/删除后，`callers(name)` 仍要给出**悬空调用点**：
/// 调用点还在源码里，只是解析不到目标了，这正是「谁还在调这个已经不存在的东西」。
#[test]
fn callers_reports_dangling_sites_when_symbol_is_gone() {
    let dir = tempfile::tempdir().unwrap();
    fs::write(dir.path().join("aa.js"), "export function foo() { return 1; }\n").unwrap();
    fs::write(
        dir.path().join("zz.js"),
        "import { foo } from './aa.js';\nexport function useIt() { return foo(); }\n",
    )
    .unwrap();

    let svc = test_graph(dir.path().join("g.db"));
    let root = dir.path().canonicalize().unwrap();
    let key = root.to_string_lossy().to_string();
    svc.index_workspace(&key, true, GraphScope::WithCalls).unwrap();
    let before = svc.callers(&key, None, None, Some("foo")).unwrap();
    assert!(before.symbol.is_some(), "建库后 foo 应存在");
    assert_eq!(before.sites.len(), 1);

    // 只把被调用方改名，调用方源码原样不动
    std::thread::sleep(std::time::Duration::from_millis(20));
    fs::write(dir.path().join("aa.js"), "export function bar() { return 1; }\n").unwrap();
    svc.index_workspace(&key, false, GraphScope::WithCalls).unwrap();

    let after = svc.callers(&key, None, None, Some("foo")).unwrap();
    assert!(after.symbol.is_none(), "foo 已不存在");
    assert_eq!(
        after
            .sites
            .iter()
            .filter(|s| s.caller_path == "zz.js")
            .count(),
        1,
        "应报出 zz.js 里那个悬空的 foo() 调用点: {:?}",
        after.sites
    );

    // 新名字本身没有调用点
    let bar = svc.callers(&key, None, None, Some("bar")).unwrap();
    assert!(bar.symbol.is_some());
    assert!(bar.sites.is_empty(), "没人调 bar: {:?}", bar.sites);
}

#[test]
fn temp_rust_graph_roundtrip() {
    let dir = tempfile::tempdir().unwrap();
    fs::create_dir_all(dir.path().join("pkg")).unwrap();
    fs::write(
        dir.path().join("pkg").join("mod.rs"),
        "mod util;\npub fn entry() { util::work(); }\n",
    )
    .unwrap();
    fs::write(dir.path().join("pkg").join("util.rs"), "pub fn work() {}\n").unwrap();
    fs::write(dir.path().join("lib.rs"), "mod pkg;\n").unwrap();

    let svc = test_graph(dir.path().join("g.db"));
    let root = dir.path().canonicalize().unwrap();
    let st = svc.index_workspace(&root.to_string_lossy(), true, GraphScope::WithCalls).unwrap();
    assert!(st.file_count >= 3);
    assert!(st.symbol_count >= 2);
    assert!(st.edge_count >= 1);

    let deps = svc
        .module_deps(&root.to_string_lossy(), Some("pkg/mod.rs"), Some(1))
        .unwrap();
    assert!(
        deps.dependencies
            .iter()
            .any(|e| e.to.as_deref() == Some("pkg/util.rs")),
        "pkg/mod should depend on util"
    );
}

#[test]
fn indexes_dieyun_core_graph_module() {
    let core = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    if !core.join("src/graph/mod.rs").is_file() {
        return;
    }
    let dir = tempfile::tempdir().unwrap();
    let svc = test_graph(dir.path().join("g.db"));
    let root = core.canonicalize().unwrap();
    let st = svc
        .index_workspace(&root.to_string_lossy(), true, GraphScope::WithCalls)
        .expect("index");
    assert!(st.file_count > 10, "expected rust graph files");
    assert!(st.symbol_count > 50, "expected rust symbols");

    let deps = svc
        .module_deps(&root.to_string_lossy(), Some("src/graph/mod.rs"), Some(1))
        .expect("deps");
    assert!(
        deps.dependencies.iter().any(|e| {
            e.to.as_deref() == Some("src/graph/build.rs")
                || e.to.as_deref() == Some("src/graph/query.rs")
                || e.spec.contains("build")
        }),
        "graph/mod.rs should reference build or query"
    );
}

#[test]
fn temp_python_graph_roundtrip() {
    let dir = tempfile::tempdir().unwrap();
    fs::create_dir_all(dir.path().join("pkg")).unwrap();
    fs::write(
        dir.path().join("pkg").join("main.py"),
        "from .helper import work\n\ndef main():\n    work()\n",
    )
    .unwrap();
    fs::write(
        dir.path().join("pkg").join("helper.py"),
        "def work():\n    pass\n",
    )
    .unwrap();

    let svc = test_graph(dir.path().join("g.db"));
    let root = dir.path().canonicalize().unwrap();
    let st = svc.index_workspace(&root.to_string_lossy(), true, GraphScope::WithCalls).unwrap();
    assert_eq!(st.file_count, 2);
    assert!(st.edge_count >= 1);
    assert!(st.symbol_count >= 2);

    let deps = svc
        .module_deps(&root.to_string_lossy(), Some("pkg/main.py"), Some(1))
        .unwrap();
    assert!(
        deps.dependencies
            .iter()
            .any(|e| e.to.as_deref() == Some("pkg/helper.py")),
        "main should import helper"
    );

    let callers = svc
        .callers(
            &root.to_string_lossy(),
            None,
            Some("pkg/helper.py"),
            Some("work"),
        )
        .unwrap();
    assert!(!callers.sites.is_empty());
}

#[test]
fn temp_workspace_graph_roundtrip() {
    let dir = tempfile::tempdir().unwrap();
    fs::write(
        dir.path().join("a.js"),
        "const b = require('./b');\nfunction caller() { b.helper(); }\n",
    )
    .unwrap();
    fs::write(
        dir.path().join("b.js"),
        "function helper() {}\nmodule.exports = { helper };\n",
    )
    .unwrap();

    let svc = test_graph(dir.path().join("g.db"));
    let root = dir.path().canonicalize().unwrap();
    let st = svc.index_workspace(&root.to_string_lossy(), true, GraphScope::WithCalls).unwrap();
    assert_eq!(st.file_count, 2);
    assert!(st.edge_count >= 1);
    assert!(st.symbol_count >= 2);
    assert!(st.call_count >= 1);

    let deps = svc
        .module_deps(&root.to_string_lossy(), Some("a.js"), Some(1))
        .unwrap();
    assert_eq!(deps.dependencies.len(), 1);
    assert_eq!(deps.dependencies[0].to.as_deref(), Some("b.js"));

    let callees = svc
        .callees(&root.to_string_lossy(), None, Some("a.js"), Some("caller"))
        .unwrap();
    assert!(!callees.sites.is_empty());

    let callers = svc
        .callers(&root.to_string_lossy(), None, Some("b.js"), Some("helper"))
        .unwrap();
    assert!(!callers.sites.is_empty());

    let map = svc.repo_map(&root.to_string_lossy(), Some(16)).unwrap();
    assert!(map.ok && map.indexed);
    assert!(map.markdown.contains("仓库结构图"));
    assert!(!map.hub_files.is_empty() || !map.hub_symbols.is_empty());
    assert!(!map.edges.is_empty());

    let impact = svc
        .impact(&root.to_string_lossy(), "b.js", Some(2))
        .unwrap();
    assert!(impact.affected_files.contains(&"a.js".to_string()));
}

#[test]
fn incremental_skips_unchanged_file() {
    let dir = tempfile::tempdir().unwrap();
    fs::write(dir.path().join("a.js"), "function foo() {}\n").unwrap();
    let svc = test_graph(dir.path().join("g.db"));
    let root = dir.path().canonicalize().unwrap();
    let root_s = root.to_string_lossy().to_string();
    let st1 = svc.index_workspace(&root_s, true, GraphScope::Structural).unwrap();
    let st2 = svc.index_workspace(&root_s, false, GraphScope::Structural).unwrap();
    assert_eq!(st1.symbol_count, st2.symbol_count);
}

/// R5：默认只建结构（符号 + import），调用边为 0；问到调用关系时再补建，
/// 且补建必须**重解析未变文件**（增量默认会跳过 mtime 未变的文件）。
#[test]
fn call_graph_is_built_on_demand_and_backfills_unchanged_files() {
    let dir = tempfile::tempdir().unwrap();
    fs::write(
        dir.path().join("a.js"),
        "export function helper() { return 1; }\n",
    )
    .unwrap();
    fs::write(
        dir.path().join("b.js"),
        "import { helper } from './a.js';\nexport function caller() { return helper(); }\n",
    )
    .unwrap();
    let svc = test_graph(dir.path().join("g.db"));
    let root = dir.path().canonicalize().unwrap();
    let key = root.to_string_lossy().to_string();

    let st1 = svc.index_workspace(&key, true, GraphScope::Structural).unwrap();
    assert!(st1.symbol_count > 0, "符号是结构层，必须常建");
    assert_eq!(st1.call_count, 0, "默认不抽调用边");
    let none = svc.callers(&key, None, None, Some("helper")).unwrap();
    assert!(none.sites.is_empty(), "没有调用边就没有调用点");
    // 空列表必须能自证是「没建过」而不是「没人调用」：否则模型据此断言「无调用方」。
    assert!(!none.call_graph_built, "结构索引下调用图未建");
    assert!(
        none.note.as_deref().unwrap_or("").contains("尚未建立调用图"),
        "未建时必须给一句可读原因：{:?}",
        none.note
    );

    // 按需补建（force=false，走增量）：未变文件也必须重新解析出调用边
    let st2 = svc.index_workspace(&key, false, GraphScope::WithCalls).unwrap();
    assert!(st2.call_count > 0, "按需建调用图必须真的抽到调用边");
    let sites = svc.callers(&key, None, None, Some("helper")).unwrap();
    assert!(
        sites.sites.iter().any(|s| s.caller_path == "b.js"),
        "补建后应能查到 b.js 的调用点"
    );
    assert!(sites.call_graph_built, "建过之后字段要翻成 true");
    assert!(sites.note.is_none(), "建过就不再给「未建」提示");
}

/// 回归（A8）：建过调用图之后，**普通保存引起的增量（结构态）不许把调用边吃掉**。
///
/// 旧实现按「这一轮传进来的 scope」决定要不要抽调用边：用户改一个文件 → 保存触发的
/// 增量是结构态 → `clear_file_graph` 把该文件的出边删掉，`index_file` 又直接返回不重建；
/// 而「未变文件要不要重解析」只看全局 `call_count == 0`（此时 > 0）—— 于是**编辑过的
/// 文件永久丢调用边**，只有 force 全量重建能回来，且全程没有日志。
///
/// 现在建库范围是黏性的（`graph_workspaces.calls_built`）：建过调用图的工作区，增量也按
/// WithCalls 维护它。
#[test]
fn structural_incremental_keeps_call_edges_of_edited_files() {
    let dir = tempfile::tempdir().unwrap();
    fs::write(dir.path().join("a.js"), "export function helper() { return 1; }\n").unwrap();
    fs::write(
        dir.path().join("b.js"),
        "import { helper } from './a.js';\nexport function caller() { return helper(); }\n",
    )
    .unwrap();
    let svc = test_graph(dir.path().join("g.db"));
    let root = dir.path().canonicalize().unwrap();
    let key = root.to_string_lossy().to_string();

    // 1) 全量建库并建调用图
    let st1 = svc.index_workspace(&key, true, GraphScope::WithCalls).unwrap();
    assert!(st1.call_count > 0, "前提：这一轮真的建出了调用边");

    // 2) 改 b.js（mtime 变化），然后用**保存路径的默认 scope**（Structural）跑增量
    std::thread::sleep(std::time::Duration::from_millis(1100));
    fs::write(
        dir.path().join("b.js"),
        "import { helper } from './a.js';\nexport function caller() { return helper() + 1; }\n",
    )
    .unwrap();
    let st2 = svc.index_workspace(&key, false, GraphScope::Structural).unwrap();
    assert!(st2.indexed);

    // 3) 那个文件刚被改过，它的调用边必须还在（而不是等下一次 force 才回来）
    let sites = svc.callers(&key, None, None, Some("helper")).unwrap();
    assert!(
        sites.sites.iter().any(|s| s.caller_path == "b.js"),
        "编辑过的文件不该丢调用边（旧实现只 continue 不重建，边会永久消失）"
    );
}
/// 抽取层只剩 tree-sitter：**解析不出来的文件本轮跳过，且不记 mtime** ——
/// 修好之后同一条增量路径会自动把它补回来。
///
/// 旧实现会退回启发式正则扫描（同一份知识的第二份实现）：坏文件照样进图，
/// 猜出来的边既可能漏（把「没解析出来」伪装成「没人调用」）也可能错，
/// 而且它一被「索引过」就记了 mtime，之后即使语法修好也不会再解析。
#[test]
fn unparsable_file_is_skipped_and_retried_after_fixing() {
    let dir = tempfile::tempdir().unwrap();
    fs::write(dir.path().join("a.js"), "export function helper() { return 1; }\n").unwrap();
    // 语法坏掉：少一个 `{`
    fs::write(
        dir.path().join("b.js"),
        "export function caller( { return helper(); }\n",
    )
    .unwrap();
    let svc = test_graph(dir.path().join("g.db"));
    let root = dir.path().canonicalize().unwrap();
    let key = root.to_string_lossy().to_string();

    let st1 = svc.index_workspace(&key, true, GraphScope::WithCalls).unwrap();
    assert!(st1.call_count == 0, "坏文件不该贡献调用边（猜出来的边不算数）");

    // 修好语法（mtime 变化），用保存路径的默认 scope 跑增量
    std::thread::sleep(std::time::Duration::from_millis(1100));
    fs::write(
        dir.path().join("b.js"),
        "export function caller() { return helper(); }\n",
    )
    .unwrap();
    let st2 = svc.index_workspace(&key, false, GraphScope::Structural).unwrap();
    assert!(st2.indexed);

    let sites = svc.callers(&key, None, None, Some("helper")).unwrap();
    assert!(
        sites.sites.iter().any(|s| s.caller_path == "b.js"),
        "修好语法后增量必须把这条边补回来（说明坏那一轮没记 mtime）"
    );
}

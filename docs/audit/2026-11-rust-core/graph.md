# graph 审计

> **2026-11-17 P0 已修**：F1 的**信号部分**（`CallGraphResult.callGraphBuilt` + `note`，并写进模型可见的 `graph` 工具描述，用例扩在 `call_graph_is_built_on_demand_and_backfills_unchanged_files`）。F1 的根因（Node 三处 `callCount > 0` 代理推断）与 F2（增量吞掉调用边）仍开，归 P3。
> **2026-11-18 P2 已修**：F2 = **A8**（结构增量重建吞掉调用边）—— 建库范围落库并黏性（`graph_workspaces.calls_built` + 旧库补列），只有「结构态 → 调用态」这一轮才回填未变文件；`call_graph_built` / `graph.status.callsBuilt` 改读这一列；Node 两处 `callCount > 0` 代理推断（`handlers/graph.js#ensureCallGraph`、`rpc.js#graphNeedsFullIndex`）同步去掉。用例 `structural_incremental_keeps_call_edges_of_edited_files` + `graph/incremental.rs` 的 3 条判定，均做过变异验证。同批把 `graph` 拆成 `{status,queries,cleanup,incremental}.rs`，「删符号连带删边」收进 `cleanup.rs` 一份。F3–F11 仍开。

审计范围：`crates/dieyun-core/src/graph/{mod,build,query,schema,types,lsp_ingest}.rs`、`graph/extract/{mod,symbols,js_ts,go,python,rust_lang}.rs`、`treesitter/{chunk,extract}.rs`（`lang.rs` 只作为证据引用）。
已交叉核对 Node 侧契约：`src/gateway/handlers/graph.js`、`src/gateway/rpc.js`、`src/agent/delegate-tool-gateway.js`、`src/graph/graph-incremental-scheduler.js`、`src/renderer/renderer-graph-panel.js`、`src/lsp/reference-service.js`。

## 度量

- 行数：**5968**（14 个指派文件；`mod.rs` 1205 / `build.rs` 979 / `query.rs` 894 / `extract.rs` 481 / `rust_lang.rs` 425 / `python.rs` 400 / `go.rs` 376 / `chunk.rs` 257 / `symbols.rs` 221 / `schema.rs` 200 / `types.rs` 185 / `js_ts.rs` 183 / `lsp_ingest.rs` 156 / `extract/mod.rs` 6；另有被依赖的 `extract/files.rs` 21 行未计入）

- 一个文件混了几种职责：
  - `graph/mod.rs`：RPC 门面（12 个方法）+ 状态快照/脏旗标维修 + 内存进度环 + 线程生命周期 + 连接使用纪律注释 + 15 个集成测试语料。
  - `graph/build.rs`：文件遍历 + 语言分派 + **SQL 写入** + 调用目标解析 + 增量 diff + 「已入库行数」计数器代数 + 清理级联（手工模拟外键）。
  - `graph/query.rs`：SQL 查询 + 图算法（**递归 DFS 环检测**、BFS 影响面）+ markdown 渲染 + 路径/符号解析 + 自造 `OptionalRow` trait。
  - `treesitter/extract.rs`：AST 遍历 + 语言分派 + import spec 的**文本再解析**（`python_import_specs`/`go_import_specs`/`rust_use_spec` 又回退成字符串扫描）+ ident 校验 + 符号/调用映射。
  - `treesitter/chunk.rs`：又一趟 AST 遍历（第二份「什么是定义」的表）+ 行窗切块 + 内容截断。

- 同一份知识有两份实现：
  - `scan_call_targets`：`extract/symbols.rs:145`、`extract/go.rs:215`、`extract/python.rs:239`、`extract/rust_lang.rs:290`（4 份）+ `treesitter/extract.rs:318 leaf_callee_name`（第 5 份）
  - `take_ident`：`extract/symbols.rs:129`、`extract/go.rs:158`、`extract/python.rs:171`、`extract/rust_lang.rs:222`（4 份）
  - `is_ident`（第 5 份、规则不同）：`treesitter/extract.rs:351`
  - `CALL_SKIP` 词表：`extract/symbols.rs:3`、`extract/go.rs:174`、`extract/python.rs:187`、`extract/rust_lang.rs:238`；**AST 路径 0 份**（`treesitter/extract.rs` 完全没有过滤）
  - `strip_comment`：`extract/go.rs:314`、`extract/rust_lang.rs:384`（朴素 `//` 截断）、`extract/python.rs:98`（唯一的引号感知版）
  - 调用归属：`graph/build.rs:521 caller_symbol_for_line` vs `graph/lsp_ingest.rs:74 caller_symbol_at_line`
  - 本地建库 vs 远端建库：`graph/build.rs:66 run_build_with_progress` vs `graph/build.rs:222 run_remote_build`（增量判定已经漂移：`121-126` 用 `mtime_unchanged` 容差，`294` 用 `== Some(mtime)`）
  - 文件数上限：`index/mod.rs:31 MAX_FILES = 16_000` vs `graph/build.rs:32 MAX_GRAPH_FILES = 16_000`
  - 「什么是定义」：`treesitter/chunk.rs:36-56` vs `treesitter/extract.rs:59-303` vs `graph/query.rs:563-566`（repo_map hub kind 白名单）
  - 「调用图建过没有」：Node `handlers/graph.js:21` + `rpc.js:1429`（`callCount>0`），Rust 侧 `types.rs:93-100` 无字段
  - schema：`graph/schema.rs:33-89`（CREATE TABLE 全量）与 `graph/schema.rs:91-98`（老库 ALTER 清单）
  - `purge_stale_files` 是 `purge_removed_files` 的纯转发：`build.rs:789-795`

## 发现

### F1 调用图「未建」没有信号：agent 的 graph 工具直连 RPC 且 `autoIndex:false`，callers/callees 恒为空
- 类型：live-bug
- 严重度：high
- 位置：`crates/dieyun-core/src/graph/types.rs:93-100`；`crates/dieyun-core/src/graph/query.rs:186-193`；`crates/dieyun-core/src/rpc/mod.rs:758-772`；`src/gateway/handlers/codebase.js:55-63`；`src/agent/delegate-tool-gateway.js:457-478`；`src/gateway/handlers/graph.js:18-24,148-151`
- 证据：

  `types.rs` 的调用图返回里**没有**任何「调用边未建」字段，只有 `indexed`（整库建过没有）：
  ```rust
  pub struct CallGraphResult {
      pub ok: bool,
      pub indexed: bool,
      pub symbol: Option<SymbolHit>,
      pub sites: Vec<CallSiteHit>,
  }
  ```

  所以 `callers` 在没有调用边时返回的是「成功 + 符号存在 + 空列表」，与「真的没人调用」完全同形：
  ```rust
  Ok(CallGraphResult { ok: true, indexed, symbol: Some(sym), sites })
  ```

  默认建库范围是 **Structural（不含调用边）**：
  ```rust
  fn graph_scope_from_params(params: &Value) -> GraphScope {
      let with_calls = params.get("calls").and_then(|v| v.as_bool()).unwrap_or(false);
  ```
  而「用到符号表就顺手建一次」的主路径显式 `calls: false`：
  ```js
  await startGraphIndexForContext(ctxInfo, { force: false, skipIfReady: false, calls: false });
  ```

  agent 侧唯一入口把补建也关掉了（`autoIndex: false`），于是 `ensureCallGraph` 与 `assertGraphIndexReady` 双双跳过：
  ```js
  if (op === 'callers') {
    return gateway.invokeRpc('graph.callers', withRunWorkspace({ ..., autoIndex: false }));
  ```
  ```js
  async function ensureCallGraph(ctxInfo, st, autoIndex) {
    if (autoIndex === false) return false;
  ```
- 触发：工作区首次被 `codebase.search`（→ `ensureSymbolIndex`）或面板建库，得到 Structural 图；模型随后调 `graph{operation:"callers"}` → 返回 `{ok:true,indexed:true,symbol:{…},sites:[]}`，模型据此断言「没有调用方」。只有走 `graph.lsp_resolve` 或 RPC 默认 `autoIndex` 才会补建。
- 修法方向：把「调用图是否建过」变成 `graph_status`/`CallGraphResult` 的显式字段（`callGraphBuilt: bool` 或 `scope: "structural"|"with_calls"`），删掉 Node 三处 `callCount > 0` 推断（`graph.js:21`、`rpc.js:1429`），并让 `autoIndex:false` 的调用路径在 `callGraphBuilt:false` 时报可读错误而不是空列表。
- 怎么确认：`cargo test -p dieyun-core --lib graph::tests::call_graph_is_built_on_demand_and_backfills_unchanged_files`（它已经证明 Structural 下 `call_count == 0` 且 `sites` 为空），再用 Node 侧 `invokeRpc('graph.callers', { workspaceRoot, name:'helper', autoIndex:false })` 对刚建好的工作区调用一次，观察 `sites` 为空而 `graph.status.callCount === 0`。
- 置信度：high

### F2 结构增量重建静默吃掉调用边，且 `calls_missing` 只看全局 `call_count == 0`，删掉的边永久不再补
- 类型：live-bug
- 严重度：high
- 位置：`crates/dieyun-core/src/graph/build.rs:111,120-127,141-146,441-445,734-741`；`src/graph/graph-incremental-scheduler.js:53-58`；`src/renderer/renderer-graph-panel.js:183-186`
- 证据：`clear_file_graph` 无条件删除本文件的出边（与 scope 无关）：
  ```rust
  let mut calls_deleted = 0i64;
  for id in symbol_ids {
      if let Ok(n) = conn.execute(
          "DELETE FROM graph_calls WHERE caller_symbol_id = ?1",
          params![id],
      ) {
  ```
  同一个文件被 Structural 范围重建时，`index_file` 直接返回，不再插回调用边：
  ```rust
  // 调用关系只在 `WithCalls` 范围内抽取 …
  if !scope.with_calls() {
      return Ok((import_count, symbol_count, 0));
  }
  ```
  而「要不要重新解析未变文件」只由一个全局计数推断：
  ```rust
  let calls_missing = scope.with_calls() && !force && call_count == 0;
  ...
  let unchanged = !calls_missing
      && stored_mtimes.get(rel).copied()
          .map(|prev| crate::index::mtime_unchanged(prev, mtime))
          .unwrap_or(false);
  ```
  触发它的调用方是常规保存路径（**不传 `calls`**，默认 Structural）：
  ```js
  return { action: 'run', method: 'graph.index.start',
           params: { workspaceRoot, force: false, skipIfReady: false }, timeoutMs: 60000 };
  ```
- 触发：（a）先按需建过调用图（`calls:true`，`call_count>0`）→ （b）用户改任意一个文件保存 → 增量 scheduler 以 Structural 跑一次，该文件出边被删、`call_count` 由 COUNT 递减但>0 →（c）以后再以 `calls:true` 增量（`calls_missing=false`）时该文件 mtime 已更新，被跳过 → 这些边**只有 force 全量重建才能回来**。另一条触发路径：面板「重建」`graph.index.start {force:true}` 不传 `calls` → `clear_workspace_graph` 把 `graph_calls` 全删，`callCount` 归零。
- 修法方向：把 scope 落库（`graph_workspaces.calls_built` 一列 / 或 `scope` 文本），增量重建时「上一轮范围 ⊉ 本轮范围」就强制重解析；同时删掉 `calls_missing = call_count == 0` 这条代理判据和 Node 侧 `callCount>0` 的镜像（F1 同源）。触发一次的错误状态只有「用户编辑过的文件静默丢边」，没有日志——修好后建议顺带记一条 `graph.calls_scope` 升级事件。
- 怎么确认：新增 `cargo test -p dieyun-core --lib graph::tests::structural_incremental_keeps_call_edges`：`index_workspace(force=true, WithCalls)` → 改 `zz.js` 内容 → `index_workspace(force=false, Structural)` → `callers("foo")` 断言仍能看到 `zz.js`（现状为 0）；参照已被修过的入边用例 `graph::tests::incremental_rebuild_keeps_inbound_call_sites`（只覆盖了入边，出边这条漏了）。
- 置信度：high

### F3 `take_ident` / `scan_call_targets` / `strip_comment` / `CALL_SKIP` 各写五份，词表与规则互不一致
- 类型：structural-debt
- 严重度：high
- 位置：`extract/symbols.rs:3-34,129-191`；`extract/go.rs:158-172,174-257,314-320`；`extract/python.rs:98-132,171-185,187-281`；`extract/rust_lang.rs:222-236,238-288,384-390`；`treesitter/extract.rs:318-359`
- 证据：四份 `scan_call_targets` 字节循环几乎逐字复制，只有 `$` 与词表不同（JS 版认 `$`，Go/Python/Rust 版不认）：
  ```rust
  // extract/symbols.rs:150
  if bytes[i].is_ascii_alphabetic() || bytes[i] == b'_' || bytes[i] == b'$' {
  // extract/go.rs:220 / python.rs:244 / rust_lang.rs:295
  if bytes[i].is_ascii_alphabetic() || bytes[i] == b'_' {
  ```
  第五份 `is_ident` 在 AST 路径，规则又是第三种（**拒绝 `$`**）：
  ```rust
  fn is_ident(s: &str) -> bool {
      match chars.next() {
          Some(c) if c.is_ascii_alphabetic() || c == '_' => {
  ```
  四份 `CALL_SKIP` 词表各自演化，AST 路径一份都没有：`println` 在 Rust 启发式被跳过、`print/len/range/isinstance` 在 Python 启发式被跳过，但 tree-sitter 路径照收：
  ```rust
  // extract/rust_lang.rs:278-288
  "println", "print", "format", "panic", "assert", "assert_eq", "todo", "unreachable", "write", "writeln",
  ```
  `strip_comment` 三份，只有 Python 那份是引号/转义感知的，Go/Rust 是裸 `find("//")`（字符串里的 `//` 会把后半行当注释切掉，例如 `let u = "http://a"; helper::run();`）：
  ```rust
  fn strip_comment(line: &str) -> String {
      if let Some(pos) = line.find("//") { line[..pos].to_string() } else { line.to_string() }
  }
  ```
- 触发：不触发即错，但一旦切换抽取路径（语法解析失败 / 文件 >2MB / grammar ABI 不匹配，见 `treesitter/lang.rs:59-64` 自陈「rust 曾这样隐形失效」）同一份源码产出的边集立刻不同：Python 里 `print(len(x))` 在 AST 路径算 2 条调用边、在回退路径算 0 条；JS 的 `$el = $('#x')` 符号在回退路径保留、在 AST 路径被 `push_symbol` 丢掉。
- 漂移后果：`graph_calls`/`graph_symbols` 的内容取决于「建库那天走的是哪条抽取路径」，而库表里**没有记录走的是哪条**；增量重建只重算变过的文件，于是同一个库内两种口径长期共存，`callers`/`callees`/`repo_map refs` 都查不出自己读到的是哪一套。
- 修法方向：合并成一份 `extract/heuristic.rs`（一个 `scan_call_targets(lang, line)` + 一份按语言的 `CALL_SKIP` 表 + 一个引号感知的 `strip_comment`），`treesitter/extract.rs` 的 `is_ident`/过滤直接复用同一份判据；四份旧实现整段删除，不留转发壳。
- 怎么确认：`cargo test -p dieyun-core --lib graph::extract`（现有 8 个抽取单测按文件跑）；再补一条对称性测试：同一段 Python 源码经 `extract_graph_ast` 与 `extract_py_calls` 得到的 `callee` 集合必须相等（现状不等）。
- 置信度：high

### F4 tree-sitter 解析出语法错误（`has_error`）时不回退，AST 与启发式抽取结果混进同一个库
- 类型：latent-bug
- 严重度：medium
- 位置：`crates/dieyun-core/src/treesitter/extract.rs:12-22`；`crates/dieyun-core/src/treesitter/chunk.rs:5-27`；对照 `treesitter/lang.rs:78-83`
- 证据：唯一的回退判据是「三样全空」，不看解析错误：
  ```rust
  let tree = parse_source(lang, source)?;
  let root = tree.root_node();
  let mut out = AstGraphExtract::default();
  walk(root, source.as_bytes(), lang, &mut out);
  if out.imports.is_empty() && out.symbols.is_empty() && out.calls.is_empty() {
      return None;
  }
  ```
  而 `lang.rs` 自己的测试明确要求 `!has_error()`，但生产路径从不查：
  ```rust
  assert!(!tree.unwrap().root_node().has_error(), "{lang:?} 解析出语法错误");
  ```
  `chunk.rs` 同样只判 `ranges.is_empty()`，解析错位时按错位的节点行范围切块。
- 触发：文件处于「保存到一半 / 混语法」状态时——`.js` 里写 TS 注解、`.js` 里写 JSX、局部括号未闭合、生成文件被截断。tree-sitter 会返回**带 ERROR 节点但仍有部分节点**的树，于是 `symbols` 非空 → 不回退 → 该文件里 ERROR 区之后的 `import`/`call` 全部静默缺失；`chunk` 侧的块行号也可能与实际内容错位，`codebase.search` 命中行号指向错误行。
- 修法方向：在 `extract_graph_ast`/`structural_chunk_ranges` 里加 `if root.has_error() { return None; }`（或返回带 `partial` 标记的结果并让 `build.rs` 记一条 per-file 警告），让「解析不可信」变成显式状态而不是被「三样全空」这一条近似判据掩盖。
- 怎么确认：`extract_graph_ast("a.js", "function f( {\\n  bad\\n}\\nimport {x} from './y';\\n")` 现在返回 `Some` 且 `imports` 缺 `./y`；加 `has_error` 后应返回 `None`，`build.rs` 走启发式后能抽到该 import。
- 置信度：high

### F5 「什么是定义」写了三份表，`kind` 词表互不匹配（`impl` 永远进不了 repo_map）
- 类型：structural-debt
- 严重度：medium
- 位置：`treesitter/chunk.rs:36-56`；`treesitter/extract.rs:234-303`（尤其 `280-289`）；`graph/query.rs:563-566`
- 证据：chunk 侧的定义表：
  ```rust
  SourceLang::Rust => matches!(kind,
      "function_item" | "impl_item" | "struct_item" | "enum_item" | "trait_item" | "mod_item"),
  ```
  extract 侧把 `impl` 写成符号 kind（不是任何白名单里的值）：
  ```rust
  "impl_item" => {
      if let Some(ty) = node.child_by_field_name("type") {
          ...
          push_symbol(out, "impl", short, node);
  ```
  repo_map 的枢纽白名单里没有 `impl`，也没有 Go 启发式产出的 `type` 之外的任何同义词：
  ```rust
  AND s.kind IN ('function','method','class','struct','interface','type','trait','enum','mod','module')
  ```
  另外 Rust 的启发式把 `struct/enum` 记为 `type`（`extract/rust_lang.rs:54-61`），AST 路径记为 `struct`/`enum`：同一份 Rust 文件在两套抽取下 `kind` 不同。
- 触发/漂移后果：装了可用的 Rust grammar → `impl` 符号进 `graph_symbols` 但被 repo_map 白名单整体过滤（枢纽符号配额被 `impl` 挤占的 `ORDER BY` 分支永远走 `ELSE 6`）；grammar 失效回退后同一文件的 `kind` 从 `struct` 变 `type`，`graph.symbol_search` 的 `kind:'struct'` 过滤会突然查不到东西。`graph_symbol_search` 的 `kind` 参数由模型/用户给，两套词表下同一个 kind 字符串命中率随时间变化。
- 修法方向：把「定义节点 → (kind, 是否枢纽)」收成一张表（语言 × node kind → 规范 kind），`chunk.rs` 的范围选择和 `repo_map` 的白名单都从这张表派生，删掉另外两份；同时把 `impl` 归到 `type` 或明确从 `graph_symbols` 里剔除。
- 怎么确认：对同一段 Rust 源码分别用 `extract_graph_ast` 与 `extract_rust_symbols` 比对 `(name, kind)` 集合；再在真实工作区跑 `cargo test -p dieyun-core --lib graph::tests::indexes_dieyun_core_graph_module`，断言 `repo_map` 的 hub_symbols 里不出现 `kind == "impl"`（当前会被查出来再被 SQL 过滤，属于「存了但永远读不到」）。
- 置信度：high

### F6 `ingest_lsp_callers` 先删后插、无事务，失败即净丢边
- 类型：latent-bug
- 严重度：medium
- 位置：`crates/dieyun-core/src/graph/lsp_ingest.rs:13-18,23-51`
- 证据：先把该 callee 的**所有**高置信边删掉：
  ```rust
  conn.execute(
      "DELETE FROM graph_calls
       WHERE root_hash = ?1 AND callee_symbol_id = ?2 AND confidence >= 1.0",
      params![root_hash, callee_symbol_id],
  )
  ```
  然后逐条插入，任何一条找不到 caller 或在任何一条上失败，前面删掉的都不会回来（没有事务、没有「全成功才提交」）：
  ```rust
  let Some(caller_id) = caller_symbol_at_line(conn, root_hash, &caller_path, line)? else {
      continue;
  };
  ```
- 触发：第二次 `graph.lsp_resolve` / `graph.lsp_enrich` 时，LSP 返回的调用点所在文件恰好被重新索引过（符号行号变化）、或调用点落在文件里第一个符号之前的位置（`caller_symbol_at_line` 返回 None）→ 该 callee 的历史 LSP 边被删光、新边插 0 条，`call_count` 随之变小，`callers` 从「有」变「无」。此外 `ingest` 里 `UPDATE graph_workspaces SET call_count = ?2` 被 `.ok()` 吞掉（`61-65`），计数失败也不报。
- 修法方向：整个 ingest 放进一个事务（`unchecked_transaction`，与 `build.rs:655` 已有的写法一致），删除动作挪到**插入之后**（按本次新边集合做差集删除），`call_count` 的 UPDATE 用 `?` 上报错误而不是 `.ok()`。
- 怎么确认：`cargo test -p dieyun-core --lib graph::lsp_ingest::tests::ingests_lsp_callers_with_confidence_one` 后追加一步：先建一条 `confidence=1.0` 边，再用 `sites=[{caller_path:"nosuch.py",line:2}]` 调第二次，断言那条边仍在（现状会被删掉）。
- 置信度：high

### F7 调用归属有两份实现，LSP 那份不看 `end_line`；且 `callerSymbol` 传过来后 Rust 从不读
- 类型：structural-debt
- 严重度：medium
- 位置：`crates/dieyun-core/src/graph/build.rs:516-529` vs `crates/dieyun-core/src/graph/lsp_ingest.rs:74-91`；`crates/dieyun-core/src/graph/types.rs:112-119`；Node 侧 `src/gateway/rpc.js:1693-1697`、`src/lsp/reference-service.js:43-49`
- 证据：`build.rs` 那一份是修过的（函数体外不再算上一个函数）：
  ```rust
  .filter(|(_, start, end)| {
      *start <= call_line && (*end <= *start || call_line <= *end)
  })
  .max_by_key(|(_, start, _)| *start)
  ```
  `lsp_ingest.rs` 那一份只有 `start_line`：
  ```rust
  "SELECT id FROM graph_symbols
   WHERE root_hash = ?1 AND rel_path = ?2 AND start_line <= ?3
   ORDER BY start_line DESC LIMIT 1",
  ```
  LSP 的调用点里 `callerSymbol` 一路传到 Rust，却没有任何代码读它：
  ```rust
  pub struct LspCallSiteIn {
      pub caller_path: String,
      pub line: i64,
      #[serde(default)]
      pub caller_symbol: Option<String>,
  }
  ```
  ```js
  sites: lsp.sites.map((s) => ({ callerPath: s.callerPath, line: s.line, callerSymbol: s.callerSymbol || undefined }))
  ```
- 触发/漂移后果：`graph.lsp_resolve` 持久化的边按「最后一个 `start_line` 小于调用行的符号」归属。文件级代码（`server.listen(3000)`、模块顶层初始化）会被算进上一个函数 → `callees(setup)` 凭空多一条 `listen`，这正是 `graph/mod.rs:942-962` 那条测试专门在 build 路径上锁住的回归，LSP 路径把它原样放回来了。上游 LSP 若给了 `from.name`（reference-service 传了），本可以精确归属，但现在被丢弃。
- 修法方向：删掉 `caller_symbol_at_line`，把 `build.rs:521` 的 `caller_symbol_for_line` 提到一个共享位置（接受 `&[(id, start, end)]`），`ingest` 查符号时带上 `end_line`；`caller_symbol` 要么用来直接匹配 `graph_symbols.name`、要么从类型里删掉，不要留一个「看起来生效」的入参。
- 怎么确认：`cargo test -p dieyun-core --lib graph::tests::file_level_calls_are_not_attributed_to_previous_function` 通过，但对同一文件跑 `graph.ingest_lsp_callers`（`sites=[{callerPath:"server.js", line:4}]`）后 `callees(setup)` 会多出 `listen` —— 把该断言复制到 lsp_ingest 测试里即可复现。
- 置信度：high

### F8 `FOREIGN KEY ... ON DELETE CASCADE` 声明了但永不生效，级联靠手写第二份实现维持
- 类型：structural-debt
- 严重度：medium
- 位置：`crates/dieyun-core/src/graph/schema.rs:69-79`；`crates/dieyun-core/src/sqlite.rs:68-75`；`crates/dieyun-core/src/codebase_db.rs:22`；手工级联 `crates/dieyun-core/src/graph/build.rs:734-752`
- 证据：schema 声明了约束：
  ```sql
  FOREIGN KEY(caller_symbol_id) REFERENCES graph_symbols(id) ON DELETE CASCADE
  ```
  但 codebase.db 用的是不开外键的句柄，注释自陈：
  ```rust
  /// 注意这里**默认不开** `foreign_keys`：memory 库原本就开着，而 index / graph 原本没开。
  pub fn tune(conn: &Connection) -> Result<(), CoreError> { tune_with(conn, TuneOptions::default()) }
  ```
  ```rust
  Arc::new(SqliteHandle::new(db_path, ensure_schema))
  ```
  于是删除符号时必须手工模拟级联：
  ```rust
  for id in symbol_ids {
      if let Ok(n) = conn.execute("DELETE FROM graph_calls WHERE caller_symbol_id = ?1", params![id]) {
  ```
- 触发/漂移后果：现在只有 `clear_file_graph`/`clear_workspace_graph` 两条删除路径记得手工清 `graph_calls`；任何新的「删符号」路径（清理失效工作区、将来加 pruning、手工修数据）都会留下 `caller_symbol_id` 指向已删行的孤儿边。孤儿边对查询是隐形的（`callers`/`callees` 都 `JOIN graph_symbols`），但会进 `repo_map` 的 `refs_by_id` 计数（`query.rs:546-551` 不 JOIN 符号表），也会抬高 `call_count` —— 而 `call_count > 0` 正是 Node 判断「调用图已建」的唯一依据（F1）。
- 修法方向：二选一，别两套并存：要么给 codebase.db 打开 `foreign_keys`（`TuneOptions { foreign_keys: true }`）并删掉手工级联循环，要么把 schema 里的 FOREIGN KEY 删掉、并在注释里写明「级联由 `clear_file_graph` 唯一负责」。
- 怎么确认：`cargo test -p dieyun-core --lib graph::build::tests::clear_file_graph_reports_exact_deleted_counts`（证明手工级联确实是实际生效的那一份）；再执行 `SELECT COUNT(*) FROM graph_calls c LEFT JOIN graph_symbols s ON s.id=c.caller_symbol_id WHERE s.id IS NULL` 对现有库查孤儿数，非 0 即已发生。
- 置信度：high

### F9 清理路径用 `.ok()` 吞掉 DELETE 失败，行数计数器却按「理论值」写回
- 类型：latent-bug
- 严重度：medium
- 位置：`crates/dieyun-core/src/graph/build.rs:692-714`、`746-751`、`753-772`
- 证据：整库清理四条 DELETE 全部 `.ok()`，函数永远返回 `Ok(())`：
  ```rust
  conn.execute("DELETE FROM graph_calls WHERE root_hash = ?1", params![root_hash]).ok();
  conn.execute("DELETE FROM graph_symbols WHERE root_hash = ?1", params![root_hash]).ok();
  ```
  单文件清理里两条 `.ok()` + 两条 `.unwrap_or(0)`：
  ```rust
  conn.execute(
      "UPDATE graph_calls SET callee_symbol_id = NULL, confidence = 0.8
       WHERE root_hash = ?1 AND callee_symbol_id = ?2 AND caller_path <> ?3", params![root_hash, id, rel]).ok();
  ...
  let symbols_deleted = conn.execute(...).map(|n| n as i64).unwrap_or(0);
  ```
  而 `run_build_with_progress` 直接用这些「算出来的」数字当最终统计写库（`build.rs:198-212`），不回头 COUNT。
- 触发：`force` 重建时 `clear_workspace_graph` 撞上写锁/IO 错（`busy_timeout` 15s 过期、磁盘满、只读挂载）→ 旧符号没删，新符号照样 INSERT：`graph_symbols` 没有唯一约束，于是同一符号出现两份，`symbol_count` 被算成「旧+新」，`graph.symbol_search` 返回重复命中，`repo_map` 的 refs 翻倍；增量路径下则是「删了 0 行」但计数器照减 → 进度条与最终 `symbol_count`/`call_count` 长期偏小。
- 修法方向：清理函数返回真实删除行数并 `?` 传播错误（`clear_file_graph` 已经是这个形状，`clear_workspace_graph` 改成一致）；最终统计改为在最后一次性 `COUNT(*)`（或保留代数但断言与实际一致）。
- 怎么确认：`cargo test -p dieyun-core --lib graph::build::tests::clear_file_graph_reports_exact_deleted_counts` 是同一条不变量的正例；反向用 `cargo test` 里 `graph::tests::graph_reads_do_not_wait_on_open_write_transaction` 的写法持一个 `BEGIN IMMEDIATE` 写事务，再调 `index_workspace(force=true)`，观察 `symbol_count` 与实际行数不一致。
- 置信度：high

### F10 `MAX_GRAPH_FILES` 作用在「全部文本文件」上再按语言过滤，大仓静默漏索引代码文件
- 类型：latent-bug
- 严重度：medium
- 位置：`crates/dieyun-core/src/graph/extract/files.rs:15-20`；`crates/dieyun-core/src/index/walker.rs:104-118`；重复常量 `crates/dieyun-core/src/graph/build.rs:32` 与 `crates/dieyun-core/src/index/mod.rs:31`
- 证据：上限在**过滤语言之前**就被 `collect_text_files` 用掉（内部 `entries.sort_by(rel)` 后 `truncate`）：
  ```rust
  pub fn collect_graph_files(root: &Path, max_files: usize) -> Vec<String> {
      crate::index::collect_text_files(root, max_files)
          .into_iter()
          .filter(|e| is_graph_path(&e.rel))
  ```
  ```rust
  entries.sort_by(|a, b| a.rel.cmp(&b.rel));
  entries.truncate(max_files);
  ```
  远端路径同理（`build.rs:243-261` 先 dedupe 再 `.take(MAX_GRAPH_FILES)`）。
- 触发：工作区文本文件（`.md` / `.json` / `.lock` / `.txt` / i18n / 快照）总数 ≥ 16000 —— 结构化日志、翻译、fixture 多的仓很常见。按相对路径字典序截断后，排在后面的代码目录整个不进图，且 `graph.status.file_count`/`symbol_count` 只是「实际索引到了多少」，没有任何「已达上限、有文件未索引」的信号（`GraphStatusResult` 里没有 `truncated`/`skipped` 字段）。
- 修法方向：把语言过滤下推到 `collect_text_files`（传一个 `accept: impl Fn(&str)->bool`），让上限只约束「代码文件数」；同时删掉 `MAX_GRAPH_FILES` 这份重复常量，复用 `index::MAX_FILES`，并在状态里回报是否截断。
- 怎么确认：造一个含 16000+ 个 `note-*.md` 和 2 个 `.py` 的目录（`.py` 按字典序排在 `note-` 之后），`cargo test -p dieyun-core --lib graph::tests::temp_python_graph_roundtrip` 的写法跑一次，断言 `file_count == 2`（现状为 0 或 1）。
- 置信度：high

### F11 schema 有两份真相：`CREATE TABLE` 与 `ensure_column` 清单，老库拿不到新增列/索引
- 类型：structural-debt
- 严重度：low
- 位置：`crates/dieyun-core/src/graph/schema.rs:11-28`、`30-99`
- 证据：表已存在就整体早退，只跑一次「删死表/删死列」的清理：
  ```rust
  if has_graph {
      // 老库才需要清残留；新库在 init_graph_schema 里压根不会建那张表
      drop_legacy_symbol_vectors(conn).map_err(...)?;
      return Ok(());
  }
  init_graph_schema(conn).map_err(...)
  ```
  所以新加的列/索引只写在 `CREATE TABLE`/`CREATE INDEX` 里时，**老库永远拿不到**；目前只能靠下面这两条手工 ALTER 补救，而且它就是全部迁移面：
  ```rust
  ensure_column(conn, "graph_workspaces", "symbol_count", "INTEGER DEFAULT 0")?;
  ensure_column(conn, "graph_workspaces", "call_count", "INTEGER DEFAULT 0")?;
  ```
  另外 `drop_column_if_exists`/`ensure_column` 用**错误消息子串**判断幂等（`"no such column"` / `"duplicate column name"`），依赖 SQLite 英文文案。
- 触发/漂移后果：下一个改 schema 的人极可能在 `CREATE TABLE` 里加一列（例如 F2 修法要加的 `calls_built`），本地新库测试全绿，用户的老 `codebase.db` 上该列不存在 → 运行期 `no such column`（或更糟：查询静默走默认值）。索引侧 `idx_graph_*` 同理，老库不会被补建。
- 修法方向：把「表定义 + 索引定义 + 逐列迁移」收敛成一份声明（列清单常量），`init_graph_schema` 与迁移都从它生成；或至少让 `ensure_schema` 在 `has_graph` 时也执行 `CREATE INDEX IF NOT EXISTS` + 逐列 `ensure_column`，把 `has_graph` 早退只留给「删死表」这一步。
- 怎么确认：`cargo test -p dieyun-core --lib graph::schema::tests::ensure_schema_drops_legacy_symbol_vector_state`（它已证明「已存在表的库走的是旁路」）；补一条：先按旧列建表，再在 `CREATE TABLE` 里加一列，断言 `ensure_schema` 后 `PRAGMA table_info` 含新列（现状不含）。
- 置信度：medium

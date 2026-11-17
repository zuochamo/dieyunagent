# index 审计

> **2026-11-18 P2 已修**：F2（增量索引对「路径还在但已不可索引」的文件永不清理旧 chunk → 永久不可索引的清旧 chunk、暂时读不到的保留重试，用例 `incremental_index_purges_chunks_of_now_unindexable_files`，已变异验证）、F10 的写事务部分（chunking 整段一个写事务 → 每 128 文件分批提交，避免与 graph 建库撞 `database is locked`）。同时把 `index/mod.rs` 拆成 `{status,vectors,build,repair}.rs`（纯移动）。F4/F5/F6/F7/F8/F9/F11 仍开。

审计范围：`crates/dieyun-core/src/index/{mod,search,vector_cache,vector_pool,walker,schema,remote,workspace}.rs`、`crates/dieyun-core/src/codebase_db.rs`、`crates/dieyun-core/src/fts.rs`（全部读完）。只读分析，未改源码、未跑 cargo。

## 度量

- 行数：约 **5,273** 行（含测试约 1,718 行，生产代码约 3,555 行）
  - `index/mod.rs` 2249、`index/search.rs` 999、`index/vector_pool.rs` 425、`index/schema.rs` 355、`index/remote.rs` 344、`index/vector_cache.rs` 336、`index/walker.rs` 284、`index/workspace.rs` 72、`codebase_db.rs` 61、`fts.rs` 148
- 一个文件混了几种职责：
  - `index/mod.rs`（2249 行，一个文件 ≥7 种职责）：①服务装配与依赖持有（`IndexService::from_config` 顺手做全库 DELETE，301-317）；②`status` 读路径 + 脏状态修复协议（`StatusResult` / `StatusRepair` / `apply_status_repair`，394-673、1251-1301）；③建库主循环（walk→chunk→embed→写元数据，899-1193）；④向量复用的前半段/后半段（`apply_cached_vectors` / `store_embedded_vectors`，144-222）；⑤三张表的写入原语（`insert_chunk` / `write_chunk_vector` / `delete_*`，1303-1411）；⑥工作区清理与「卷是否离线」判定（331-374、1359-1385）；⑦`search` 的 RPC 侧编排（1195-1248，含调 embedding 与取池）＋ 一处 RPC 语义（`REMOTE_INDEX_REQUIRED`）。
  - `search.rs`：同时是「召回通道编排 / RRF 融合+强证据打分 / SQL 拼装 / 摘录渲染（snippet） / 查询分词」五种职责。
  - `vector_pool.rs`：向量池数据结构 + int8 量化 + LRU 缓存容器（`PoolCache`，含全局内存预算淘汰）。
- 同一份知识有两份实现：
  - **建库元数据写回**：`index/mod.rs:1157-1185` 与 `index/remote.rs:307-335` —— 同一段 `workspaces` upsert SQL（含 `COALESCE(?9, ...)`）逐字两份。
  - **向量复用管线**：`index/mod.rs:1093-1131` 与 `index/remote.rs:238-279` —— 命中→补算→回填三步各写一遍。
  - **「已就绪就不重建」判定**：`index/mod.rs:720-730`、`index/remote.rs:42-51`、`index/mod.rs:881-890` —— 同一套 `indexed && !embedding_stale` 三次。
  - **命中位置定位**：`index/search.rs:497` `first_hit_line`（区分大小写）与 `fts.rs:61` `first_hit_index`（不区分大小写），两份都在算「命中在哪」。
  - **查询分词**：`index/search.rs:292` `query_terms` 与 `fts.rs:72` `terms` —— 两套切分规则（索引一套、记忆一套），`fts.rs` 头部注释还声称「现在统一到这里」。
  - **生效维度**：`embedding/mod.rs:247` `effective_dimensions()` 与调用点直接读 `self.embedding.dimensions`（`index/mod.rs:169`、`index/mod.rs:1152`）。
  - **「删 chunk 连带删向量」**：`index/schema.rs:167` 的 `ON DELETE CASCADE` 声明 vs 各删除点手写 `DELETE FROM chunk_vectors`（`index/mod.rs:1389`、`1400`）。
  - **忽略规则**：`index/walker.rs:12-46` 与 `src/index/source-files.js:28-109`（由 `test/unit/ignore-rules-parity.test.cjs` 兜着，暂未漂移）。

---

## 发现

### F1 本地推理（768 维）下用配置里的 `dimensions`(1024) 当维度：跨 worktree 向量复用 100% 落空，面板维度还说谎

- 类型：live-bug
- 严重度：high
- 位置：`crates/dieyun-core/src/index/mod.rs:169`、`crates/dieyun-core/src/index/mod.rs:1152`
- 证据：

```rust
// index/mod.rs:166-171（缓存查询用「配置里的维度」）
        let cache_key = self.embedding.cache_key();
        let hits = self
            .vector_cache_op(|cache| {
                cache.get_many(&cache_key, &hashes, self.embedding.dimensions as usize)
            })
            .filter(|h| !h.is_empty());
```

```rust
// index/mod.rs:1149-1155（写进元数据的维度也是「配置里的维度」）
        let (embedding_model, embed_dims) = if vector_count == 0 {
            (None, 0i64)
        } else if use_vectors {
            (Some(embed_sig), self.embedding.dimensions as i64)
```

```rust
// embedding/mod.rs:246-252（正确口径就摆在旁边，但索引侧没用它）
    /// 实际生效的维度：本地模型固定，远端取配置。
    pub fn effective_dimensions(&self) -> u32 {
        match self.plan() {
            Provider::Local { .. } => local::LOCAL_DIMENSIONS,
            _ => self.dimensions,
        }
    }
```

```rust
// embedding/local.rs:31  —— 本地模型真实维度
pub const LOCAL_DIMENSIONS: u32 = 768;
```

```rust
// embedding/mod.rs:259-262 —— 维度不等就直接丢掉，不报错
pub fn blob_to_vector(blob: &[u8], dims: usize) -> Option<Vec<f32>> {
    if dims == 0 || blob.len() != dims * 4 {
        return None;
    }
```

```js
// src/agent/embedding-config.js:126 —— 宿主永远把 1024 塞进 payload（本地模式也不改）
    dimensions: Number(remote.dimensions) || 1024,
```

- 触发：`provider=auto/local` 且本地模型已下载（文档里就是「本地推理优先」的默认路径）时，`self.embedding.dimensions` = 1024，而 `local::embed` 返回的是 768 维。此时：
  ①`apply_cached_vectors` 用 `dims=1024` 去校验 768 维 blob → `blob_to_vector` 全部返回 `None` → `hits` 为空 → `reused` 恒为 0，整个「跨 worktree/跨会话按内容哈希复用向量」能力**静默失效**（这正是 `vector_cache.rs` 顶部那一段存在的唯一目的：SSH 每会话一份索引库时不必重算整仓）；②`workspaces.embedding_dims` 写成 1024，`codebase.status` 报给面板（`src/renderer/renderer-codebase-panel.js:141`）也是 1024，而同一进程的 `embedding.status` 报的是 768：

```rust
// rpc/mod.rs:508-516 —— 同一个进程对「维度」有第二个答案
                    "dimensions": e.effective_dimensions(),
```

- 修法方向：两处 `self.embedding.dimensions` 改用 `self.embedding.effective_dimensions()`（`remote.rs:86` 同改），并在 `apply_cached_vectors` 里用「实际返回向量的长度」而不是配置值去查缓存；`effective_dimensions()` 已经是单一来源，直接用它。
- 怎么确认：`cargo test -p dieyun-core --lib index::tests::vectors_reuse_from_content_hash_cache_without_calling_endpoint` 改成 `provider="local"` 就能复现（该用例现在用 `cfg.model/cfg.base_url` 走远端分支，所以 768 的坑没被覆盖）；或最小复现：配置 `provider:"auto"`、`localModelDir` 指向已下载模型、`dimensions` 缺省（1024），建两次索引，看 `status.vectorsReused` 恒为 0 而 `vectorsEmbedded` 等于 chunk 数。
- 置信度：high

### F2 增量索引对「路径还在、但已不可索引」的文件永不清理旧 chunk —— 搜索持续返回文件里已不存在的内容

- 类型：live-bug
- 严重度：high
- 位置：`crates/dieyun-core/src/index/mod.rs:929-935`（保活集合）、`crates/dieyun-core/src/index/mod.rs:967-1010`（四条 `continue` 都在删旧 chunk 之前）
- 证据：

```rust
// index/mod.rs:929-935 —— rel_set 来自 walker 的完整列表，后面的过滤都不影响它
        let rel_set: HashSet<String> = files
            .iter()
            .map(|f| f.rel.replace('\\', "/"))
            .collect();
        if !force {
            purge_stale_chunk_paths(&conn, root_hash, &rel_set)?;
        }
```

```rust
// index/mod.rs:967-1010 —— 任何一条 continue 都发生在 delete_chunks_for_path 之前
            for file in &files {
                let meta = match std::fs::metadata(&file.abs) {
                    Ok(m) => m,
                    Err(_) => continue,
                };
                if !meta.is_file() || meta.len() > INDEX_FILE_MAX_BYTES {
                    continue;
                }
                ...
                // 先读成功再删旧 chunk，避免读失败把已有索引抠掉
                let text = match std::fs::read_to_string(&file.abs) {
                    Ok(t) => t,
                    Err(_) => continue,
                };
                if text.contains('\0') {
                    continue;
                }

                if !force {
                    delete_chunks_for_path(&tx, root_hash, &rel)?;
                }
```

- 触发：一个**曾经被索引过**的文件，路径和扩展名没变，但内容变成「不可索引」：超过 `INDEX_FILE_MAX_BYTES`（2 MB，`config.rs:8`）、含 NUL（被写成 UTF-16 / 追加了二进制）、或临时读不出来（被独占锁/权限）。此时它在 `rel_set` 里 → `purge_stale_chunk_paths` 不动它；循环里 `continue` → 旧 chunk 原样留在库里；新内容一行都没进。`codebase.search` 会继续把旧正文当事实返回给模型（`chunk_count != 0` 也不会走 `needsIndex` 提示）。常见触发物：`pnpm-lock.yaml`/`*.json` 长到 2 MB 以上、日志被改名成 `.txt`、`fixture` 二进制被改名成 `.dat` 之外又在白名单里的扩展名。附带：这些文件也被 `continue` 挡在 `file_count += 1` 之前，进度条永远到不了 `files_total`。
- 修法方向：把「本次确实不想再索引这个 rel」与「本次暂时读不出来」拆开——前者（大小超限 / 含 NUL / walker 明确排除）就在跳过的同时 `delete_chunks_for_path`；后者（metadata/read 失败）保持现状并在下一轮重试。后者不要用 `.ok()` 掩盖，留一条进度可见的计数。
- 怎么确认：最小复现：临时目录写 `a.txt`（内容 `unique_token_before`）→ `index.index`（force=true）→ 把 `a.txt` 改成 3 MB 内容 → `index.index`（force=false）→ `codebase.search query=unique_token_before` 仍命中 `a.txt`，而 `Get-Content a.txt | Select-String unique_token_before` 为空。可加一条 `cargo test --lib index::tests::incremental_purges_chunks_of_now_unindexable_file`。
- 置信度：high

### F3 子串通道「路径命中」也算一个命中 → `hits` 可以大于词元数 → 全覆盖强证据静默丢失（正是这段代码要防的回归）

- 类型：live-bug
- 严重度：medium
- 位置：`crates/dieyun-core/src/index/search.rs:444-453`（每个词元贡献 0~2）、`crates/dieyun-core/src/index/search.rs:481-490`（按「等于词元数」判断覆盖度）
- 证据：

```rust
// search.rs:442-453
    for term in terms {
        // 转义 LIKE 的通配符，术语里的 % / _ 按字面匹配
        let escaped = term
            .replace('\\', "\\\\")
            .replace('%', "\\%")
            .replace('_', "\\_");
        let idx = params_vec.len() + 1;
        hit_exprs.push(format!(
            "((content LIKE '%' || ?{idx} || '%' ESCAPE '\\') + (rel_path LIKE '%' || ?{idx} || '%' ESCAPE '\\'))"
        ));
        params_vec.push(Box::new(escaped));
    }
```

```rust
// search.rs:481-490
    let all_terms = terms.len() as i64;
    ...
        // `hits` 的上限就是词元数（每个词元最多算 1）
        if hits == all_terms {
            full_coverage.push(id);
        }
```

- 触发：单个词元同时出现在**该 chunk 的 `rel_path` 与正文**里 —— 例如查 `index`、`search`、`config`、`memory`、`vector` 这类既常见又是目录/文件名的词（本仓 `index/mod.rs` 里查 `index` 就是）。此时 `hits` = 2 = `all_terms * 2`，`hits == all_terms` 为假 → 这个**最字面的命中**不进 `strong_evidence`，于是被只有一路向量票的候选按 RRF 挤到后面 —— 而 `search.rs:33-37` 的注释明确说这条强证据机制就是为了修「原句族 hit@1 从 100% 掉到 83%/67%」的回归。也就是说：注释里的上限假设（`hits ≤ 词元数`）与实际 SQL 不符，回归只在「词不在路径里」的用例下被修好了。
- 修法方向：覆盖度按「每个词元贡献 ≥1」判，而不是按和相等：内层再算一列 `matched_terms`（如 `(content LIKE x OR rel_path LIKE x)` 作为布尔并集再求和），或直接 `if hits >= all_terms`。顺手把排序键也改成这个 `matched_terms`，避免路径+正文双计把「命中 1 个词两次」排到「命中 2 个词」前面。
- 怎么确认：`cargo test -p dieyun-core --lib index::search::tests` 加一条用例：块 A 的 `rel_path='src/config.rs'`、`content='// config 与索引的唯一来源'`（词元同时在路径与正文 → `hits=2`），块 B 语义上与查询向量最像但只命中一个词；断言 A 仍排第一（现在 A 拿不到强证据加成，会被 B 反超）。若把 A 的 `rel_path` 改成 `src/other.rs`，同一断言今天就是通过的 —— 正好说明差别只在「词也在路径里」。
- 置信度：high

### F4 相似度的 NaN 不受阈值约束：一条 NaN 向量即可污染整个向量通道的排序与归一化

- 类型：latent-bug
- 严重度：medium
- 位置：`crates/dieyun-core/src/index/vector_pool.rs:104-115`、`crates/dieyun-core/src/index/vector_pool.rs:160-191`、`crates/dieyun-core/src/index/search.rs:236-245`
- 证据：

```rust
// vector_pool.rs:104-115 —— 量化有 is_finite 保护，但 norms 用原始 f32 求和，没有
            let vec = blob_to_vector(&blob, d)...;
            let mut acc = 0.0f64;
            for v in &vec {
                acc += (*v as f64) * (*v as f64);
            }
            ...
            norms.push(acc.sqrt() as f32);
```

```rust
// vector_pool.rs:160-175 —— NaN 进 denom 后一路传下去
        let denom = q_norm * (self.norms[slot] as f64);
        if denom <= 1e-8 {
            0.0
        } else {
            dot * scale / denom
        }
```

```rust
// vector_pool.rs:184-190 —— NaN 与 MIN_SIMILARITY 比较恒为 false ⇒ 不被过滤
            let sim = self.similarity_with_norm(slot, q, q_norm);
            if sim <= MIN_SIMILARITY {
                continue;
            }
            out.push((self.ids[slot], sim as f32));
```

```rust
// search.rs:236-239 —— 同样的空洞：NaN 的 q_norm 过不了这道闸（比较为 false 才是通过）
    let q_norm = VectorPool::query_norm(q_vec);
    if q_norm <= 1e-8 {
        return Ok(Vec::new());
    }
```

- 触发：库里有一条向量的某个分量是 NaN（远端 embedding 返回 `NaN`/`Inf` 时 `vector_to_blob` 原样落库，`quantize` 只保护了 `max_abs`：`f32::max` 会忽略 NaN，于是 `data` 里该分量变 0 而 `norms` 仍是 NaN），或查询向量含 NaN（端点返回异常）。结果：该条 `sim` 为 NaN → 通过阈值 → 进入 `hits` → `sort_unstable_by(partial_cmp().unwrap_or(Equal))` 把 NaN 当等值，可能被排到最前；`score` 归一化 `if top > 0.0`（`search.rs:184`）对 NaN 为假 → 本次检索所有 `score` 全为 0，且顺序不再可解释。
- 修法方向：在 `scan_into` 与 `query_norm` 处加一条 `is_finite` 判定（`if !sim.is_finite() { continue; }`、`if !q_norm.is_finite() || q_norm <= 1e-8`），并在 `write_chunk_vector` 落库前拒绝非有限分量（把坏向量当成 embedding 失败，而不是静默入库）。
- 怎么确认：`cargo test -p dieyun-core --lib index::vector_pool` 加一条：插入 `[f32::NAN, 1.0]` 的向量，`scan_into` 后断言 `hits` 里不出现该 id（现在会出现）。最小复现输入：`INSERT INTO chunk_vectors (chunk_id, dims, vector) VALUES (…, 2, <8 字节含 NaN 的 blob>)`。
- 置信度：high（机制确凿；触发依赖上游返回非有限值）

### F5 向量池的维度取自「第一行」（`ORDER BY c.id`，即最老那条）：一条残留的异维度行能让整池失效、向量通道静默消失

- 类型：latent-bug
- 严重度：medium
- 位置：`crates/dieyun-core/src/index/vector_pool.rs:36-39`（`ORDER BY c.id`）、`crates/dieyun-core/src/index/vector_pool.rs:91-105`
- 证据：

```rust
// vector_pool.rs:36-39
const CHUNK_VECTOR_SQL: &str = "SELECT c.id, v.dims, v.vector FROM chunk_vectors v
     JOIN chunks c ON c.id = v.chunk_id
     WHERE c.root_hash = ?1
     ORDER BY c.id";
```

```rust
// vector_pool.rs:91-105
            let d = d as usize;
            if dims == 0 {
                dims = d;
            }
            // 混维度（模型切换残留）时跳过异常行，避免整池失效
            if d != dims {
                continue;
            }
```

- 触发：库里同时存在两种维度的行，且**异维度那条 `chunk_id` 更小**（模型切换前的老 chunk 恰恰最老、id 最小）。于是 `dims` 被钉成老维度，之后所有新维度行都被 `continue` 丢掉 → 池变成「1 条向量 + 错维度」→ `matches_dims(q_vec)` 为假（`search.rs:147`）→ 向量通道整条缺席，检索退化成子串，**不报错、不留日志**。`delete_all_chunks`/`model_changed` 能挡住大部分情况，但 `delete_chunks_for_path` 与 `delete_all_chunks` 里那句 `.ok()`（见 F8）会留下孤儿行，正好制造这个前提。现有单测 `skips_mismatched_dims_while_loading` 只覆盖了「正确维度那条 id 更小」的顺序，所以没抓到。
- 修法方向：维度不取第一行，改为按 `workspaces.embedding_dims`/`effective_dimensions()` 传入期望维度，或对行做一次众数统计后按多数维度过滤；两种都行，但不要再「第一行说了算」。
- 怎么确认：`cargo test -p lib index::vector_pool` 把 `skips_mismatched_dims_while_loading` 的插入顺序反过来（先插 3 维、再插 2 维），断言 `pool.dims()==2 && pool.len()==1` —— 现在会得到 `dims()==3 && len()==1`。
- 置信度：high

### F6 命中行定位区分大小写、摘录预算却是字节：命中词可能既不定位也被截掉，另有一份同功能实现在 `fts.rs`

- 类型：latent-bug
- 严重度：medium
- 位置：`crates/dieyun-core/src/index/search.rs:497-505`、`crates/dieyun-core/src/index/search.rs:14-25`、`crates/dieyun-core/src/index/search.rs:554-570`
- 证据：

```rust
// search.rs:497-505 —— 大小写敏感
fn first_hit_line(content: &str, start_line: i64, terms: &[String]) -> Option<i64> {
    let mut earliest: Option<usize> = None;
    for term in terms {
        if let Some(pos) = content.find(term.as_str()) {
            earliest = Some(earliest.map_or(pos, |cur| cur.min(pos)));
        }
    }
    earliest.map(|pos| start_line + content[..pos].matches('\n').count() as i64)
}
```

```rust
// search.rs:14-25 —— 名字是 CHARS，注释说「字符预算」，用法是字节
/// 单条命中的带行号正文上限。命中在 chunk 内的位置不确定，整块给出更省一次回读。
/// 字节上限略高于 Node 侧 codebaseSnippetMax（2400 字符），避免中文先被 Rust 截断。
const SNIPPET_MAX_CHARS: usize = 3600;
```

```rust
// search.rs:564-569 —— out.len()/piece.len() 都是字节
        let piece = format!("{no:>5}| {shown}\n");
        if out.len() + piece.len() > SNIPPET_MAX_CHARS {
            out.push_str("     …（本块后续内容已截断）\n");
            break;
        }
```

- 触发：①查询词与正文大小写不同（`ParseConfig` vs `parseConfig`）——`LIKE` 对 ASCII 不区分大小写（命中），`content.find` 区分（定位失败）→ `hit_line=None` → `snippet` 从 chunk 头部（`hit_idx = 0`）展开，命中若在第 30 行之后就被 `SNIPPET_MAX_LINES=80`/字节预算切掉，模型拿到的片段里没有它要的词；②中文正文下 `SNIPPET_MAX_CHARS=3600` 实为 3600 **字节** ≈ 1200 汉字，比 Node 的 `codebaseSnippetMax=2400` **字符** 更早截断，与注释「避免中文先被 Rust 截断」的意图正好相反。另有第二份实现 `fts.rs:61 first_hit_index`（不区分大小写、返回字符下标），两份规则不一致。
- 修法方向：`first_hit_line` 改成与 SQL 同口径（在 `content.to_lowercase()` 上找、或用 `eq_ignore_ascii_case` 逐窗口比较）；字节预算改成字符预算（`out.chars().count()`），并删掉 `fts.rs` 那份同功能实现、让两处共用一个「命中位置」函数。
- 怎么确认：`cargo test -p dieyun-core --lib index::search::tests` 加：40 行内容第 31 行写 `parseConfig`，用 `query="ParseConfig"`，断言 `snippet` 含 `131|`（现在不含）；另加一条中文用例断言片段字符数 ≥ 2400（现在约 1200）。
- 置信度：high

### F7 「远端摄取」整条链路（`remote.rs` 344 行 + `index_remote`）没有任何 RPC 入口，且里面已经漂移出一个锁泄漏

- 类型：structural-debt
- 严重度：high
- 位置：`crates/dieyun-core/src/index/mod.rs:866-896`、`crates/dieyun-core/src/index/remote.rs:36-194`
- 证据：

```rust
// index/mod.rs:880-896 —— push 用 `?` 提前返回时，index_remote_finish 永远不会被调用
        self.index_remote_begin(&ws, force, vectors).await?;
        if !force {
            let st = self.status(workspace_root)?;
            ...
        }
        const BATCH: usize = 30;
        for batch in files.chunks(BATCH) {
            self.index_remote_push(&ws, batch)?;
        }
        self.index_remote_finish(&ws).await
```

```rust
// remote.rs:165-171 —— 它自己写明了「唯一收尾点」的纪律
    /// 远程摄取的收尾：**成功与失败都必须走到**，否则该工作区会被永久卡住。
    ///
    /// 半路失败（embedding 报错、写库失败）时若不清理：`self.indexing` 里留着这个
    /// root → `status` 恒报「索引中」、`codebase.search` 一直被 `INDEXING_IN_PROGRESS`
    /// 挡掉；`workspaces.indexing` 停在 1；...
```

```rust
// remote.rs:54-62 —— 第二次 begin 静默 Ok，让 push 写进上一次的 state
        {
            let mut guard = self
                .indexing
                .lock()
                .map_err(|_| CoreError::rpc("INDEX_BUSY", "索引锁不可用"))?;
            if guard.contains(&ws.root_hash) {
                return Ok(());
            }
```

- 触发/漂移后果：
  ①**没有调用方**：core 的 RPC 分发表（`crates/dieyun-core/src/rpc/mod.rs`）与 `docs/rpc-catalog.md:87-90` 里只有 `codebase.{status,index,index.start,search}`，`remote-index-core.js:14-17` 的前置白名单同样没有 push/finish；全仓 grep 后 `IndexService::index_remote` 只被 `index/mod.rs:1567` 的单测（`remote_index_from_files_smoke`）调用。真正的远端建库现在是「远端那台机器上的 core 自己 walk 本地路径」，这条 SFTP 摄取路线属于没接完的计划。
  ②它却是**第二份** `run_index`：`workspaces` upsert SQL、`use_vectors`/`prev_embed_model` 沿用规则、`apply_cached_vectors → embed_batches → store_embedded_vectors` 三步、`set_progress` 相位，全部逐字抄一遍（见「度量」里的两实现清单）。漂移已经发生：本地实现用 `?` 前先经 `finish`，远端这条路却在 `index_remote` 里直接 `?` 返回，把 `self.indexing` 的 root 和 `remote_ingest.jobs` 的 state 一起留在内存里 —— 一旦哪天把它接到 RPC 上，一次 `SQLITE_BUSY`/磁盘满就换来「该工作区永远索引中、`codebase.search` 永远 `INDEXING_IN_PROGRESS`、只有重启进程能恢复」，正是 `remote.rs:165-170` 警告的那个现场。另外 `begin` 撞上已在跑时返回 `Ok(())`（不是 `already_running`），并发两次摄取会把两批文件混进同一份 state，然后第二批 `finish` 报 `REMOTE_INDEX_STATE`。
- 修法方向：删掉整条 `index/remote.rs` 与 `mod.rs:866-896`（连同 `RemoteIngestHandle`、`apply_live_progress` 里的 jobs 分支、`remote_index_from_files_smoke` 用例），远端建库继续走「远端 core 自己 walk」这一条；如果确实要留，就必须让 `index_remote` 的失败路径走 `finish`（例如把 body 包进一个内部函数，`?` 之后统一收尾）。
- 怎么确认：`Select-String -Path crates\dieyun-core\src\rpc\mod.rs -Pattern 'index_remote'` 无结果 + `Select-String -Path docs\rpc-catalog.md -Pattern 'codebase\.'` 只列出 4 个方法，即可证明无入口；若决定保留，用 `cargo test --lib index::tests::remote_index_from_files_smoke` 改成「第二个 batch 传入非法 root_hash 触发 push 失败」，断言失败后 `status().indexing == false`（现在会是 true）。
- 置信度：high

### F8 `chunk_vectors` 声明了 `ON DELETE CASCADE`，但 codebase.db 根本没开 `foreign_keys`；两处删向量的 SQL 又用 `.ok()` 吞错 → 孤儿向量行永久残留

- 类型：structural-debt
- 严重度：medium
- 位置：`crates/dieyun-core/src/index/schema.rs:163-168`、`crates/dieyun-core/src/sqlite.rs:70-72`、`crates/dieyun-core/src/index/mod.rs:1387-1411`
- 证据：

```rust
// index/schema.rs:163-168 —— 声明了级联
    CREATE TABLE IF NOT EXISTS chunk_vectors (
        chunk_id INTEGER PRIMARY KEY,
        dims INTEGER NOT NULL,
        vector BLOB NOT NULL,
        FOREIGN KEY(chunk_id) REFERENCES chunks(id) ON DELETE CASCADE
    );
```

```rust
// sqlite.rs:70-72 —— 但这条库连接根本没开外键
/// 注意这里**默认不开** `foreign_keys`：memory 库原本就开着，而 index / graph 原本没开。
/// 需要外键约束的库用 [`TuneOptions::foreign_keys`] 显式声明。
```

```rust
// index/mod.rs:1387-1404 —— 于是每个删除点都手写一遍删向量，且失败被 `.ok()` 吞掉
fn delete_all_chunks(conn: &Connection, root_hash: &str) -> Result<(), CoreError> {
    conn.execute(
        "DELETE FROM chunk_vectors WHERE chunk_id IN (SELECT id FROM chunks WHERE root_hash = ?1)",
        params![root_hash],
    )
    .ok();
    conn.execute("DELETE FROM chunks WHERE root_hash = ?1", params![root_hash])
```

- 触发/后果：同一份「删 chunk 要连带删向量」的知识存在三份（schema 的 CASCADE 声明、`delete_all_chunks`、`delete_chunks_for_path`）。CASCADE 是**永假**的那一份：`SqliteHandle::new` 不开 `foreign_keys`，SQLite 默认 OFF，于是声明形同注释；真正生效的两份里，删向量的那条失败时被 `.ok()` 丢掉，而删 chunks 的那条成功了 → 留下 `chunk_vectors` 孤儿行。孤儿行被所有查询的 `JOIN chunks` / `IN (SELECT id FROM chunks)` 过滤掉，所以**从外部完全看不见**，只能表现为库体持续涨；同时它们会给 F5 提供「异维度老行 id 更小」的前提。将来谁相信了那句 CASCADE 而删掉手工 DELETE，就会直接产生不可见的垃圾。
- 修法方向：二选一，别并存。要么 `codebase_db::handle` 用 `TuneOptions{foreign_keys:true}` 打开外键并删掉两处手工删向量；要么删掉 schema 里的 `FOREIGN KEY ... CASCADE` 声明（一条没有约束力的注释最危险），并把两处 `.ok()` 改成 `?`（删不掉向量就该让这次删除失败，而不是静默留垃圾）。
- 怎么确认：`cargo test -p dieyun-core --lib codebase_db` 加一条：`handle` 建库后 `pragma_query_value(None,"foreign_keys")` 断言为 1，再插 chunk+vector、删 chunk，断言 `chunk_vectors` 为空（现在会剩 1 行）。或最小复现：`DELETE FROM chunks WHERE id=1` 后 `SELECT COUNT(*) FROM chunk_vectors` 仍为 1。
- 置信度：high

### F9 `status` 构造期顺手做的「清理已消失工作区」被放进 `core.configure` 的写锁里做阻塞 IO；且在 Linux 上会误删「暂时未挂载」的工作区

- 类型：latent-bug
- 严重度：medium
- 位置：`crates/dieyun-core/src/index/mod.rs:301-317`、`crates/dieyun-core/src/rpc/mod.rs:938-952`、`crates/dieyun-core/src/index/mod.rs:1359-1385`
- 证据：

```rust
// index/mod.rs:301-317 —— 构造函数里就 DELETE
    pub fn from_config(config: &AppConfig, db: Arc<SqliteHandle>) -> Self {
        let svc = Self::new(db, config.embedding.clone()).with_vector_cache(Some(...));
        // 起动时对一次账：根目录已经不在的工作区，索引行留着既占库体又让「库里有什么」
        // 的统计失真（实测某条已删项目留了 53,538 段区段）。构造期做，不和在跑的建库抢锁。
        let removed = svc.prune_missing_workspaces();
```

```rust
// rpc/mod.rs:938-952 —— 它在 tokio 的写锁里被同步调用
                let reopen_cfg = {
                    let mut guard = self.inner.write().await;
                    ...
                    guard.index =
                        IndexService::from_config(&guard.config, Arc::clone(&codebase_db));
```

```rust
// index/mod.rs:1363-1385 —— 非 Windows 一律把卷根当成 "/"（永远存在）
fn local_root_vanished(path: &Path) -> bool {
    if path.exists() { return false; }
    volume_root(path).map(|v| v.exists()).unwrap_or(false)
}
...
#[cfg(not(windows))]
fn volume_root(_path: &Path) -> Option<PathBuf> {
    Some(PathBuf::from("/"))
}
```

- 触发：①每次 `core.configure`（Node 在切模型/推 embedding 配置时会调）都会在**持有 `self.inner` 写锁**的同一段里跑 `prune_missing_workspaces()`：打开一条独立连接、`SELECT … UNION SELECT …`、对每个工作区做一次 `path.exists()`（挂断过的 SMB/NFS 路径上这一步能卡数秒）、再逐条 `DELETE`（+ `graph::clear_workspace_rows`）。这期间所有 `codebase.status` / `search` 都拿不到读锁 —— 正是仓库里反复出现的「configure 45061ms 超时 / codebase.status 45s 超时」的形状。②`volume_root` 在非 Windows 恒为 `/`，于是「NFS/移动盘没挂上」在 Linux（本仓有 headless 发行版）会被判成「目录已被删除」，把该工作区的 chunks/向量/**图谱符号**一起删掉 —— 而 Windows 分支专门为此写了「整卷离线不删」的保护，两个平台语义不一致。
- 修法方向：把 `prune_missing_workspaces` 从构造函数里挪出去（放到启动时的后台任务，或 `codebase.status` 的维修通道里），并且不要在 `core.configure` 的写锁内做文件系统探测；`volume_root` 的 Linux 分支要能识别「这是一个挂载点且当前未挂载」（读 `/proc/mounts` 或 `statfs` 失败），否则保留数据。
- 怎么确认：`cargo test -p dieyun-core --lib index::tests::prune_keeps_remote_keys_and_offline_volumes` 在 Linux 上补一个用例：把某路径列为未挂载挂载点（或用 `tempdir` + 不存在的子目录）断言不被删；性能侧可用 `RUST_LOG` 计时 `core.configure` 前后 `codebase.status` 的耗时落点。
- 置信度：medium（机制确凿；「误删」需要未挂载挂载点这一前提）

### F10 整个 chunking 阶段压在一个写事务里（分钟级），与同库另一条写连接（graph）并发即撞 `SQLITE_BUSY`；embedding 阶段又反过来逐条隐式事务

- 类型：latent-bug
- 严重度：medium
- 位置：`crates/dieyun-core/src/index/mod.rs:962-1040`、`crates/dieyun-core/src/index/mod.rs:119-222`（`store_embedded_vectors` 无事务）、`crates/dieyun-core/src/sqlite.rs:30`
- 证据：

```rust
// index/mod.rs:962-965 —— 一个事务包住所有文件的切分与插入
        {
            let tx = conn
                .unchecked_transaction()
                .map_err(|e| CoreError::rpc("INDEX_FAILED", e.to_string()))?;

            for file in &files {
```

```rust
// index/mod.rs:1038-1043 —— 直到全部文件处理完才提交
            tx.commit()
                .map_err(|e| CoreError::rpc("INDEX_FAILED", e.to_string()))?;
        }
```

```rust
// index/mod.rs:201-210 —— 同一个函数的第二阶段：每条向量一个隐式事务
        for (chunk_id, vec) in rows {
            ...
            write_chunk_vector(conn, chunk_id, &vec)?;
            embedded += 1;
```

```rust
// sqlite.rs:30 —— 抢不到写锁就等 15s 然后报错
const BUSY_TIMEOUT_SECS: u64 = 15;
```

- 触发：`codebase.index.start`（后台线程，独立连接）与 `graph.index.start`（同样走 `open_dedicated()`，`graph/mod.rs:70-71`、`432`）同时跑时，两者是**同一个 codebase.db 上两条写连接**。index 的写事务要持续「walk 16k 文件 + 切分」的整段时间（分钟级），期间 graph 的写连接只能等 15s 然后报 `database is locked`（面板上表现为「建图谱失败」而索引正常）。反过来 embedding 阶段每条向量一个隐式事务（几千条 = 几千次 commit/WAL 追加），比批处理慢一个量级；一次 embedding 中途失败还会留下「chunks 完整、向量写了一半」的半成品（靠 `status` 的 EXISTS 探针兜，见 `mod.rs:534-543`）。
- 修法方向：把 chunking 事务按文件（或每 N 个文件）分块提交，别让一次 build 持写锁几分钟；`store_embedded_vectors` 用一条事务包住整批 `write_chunk_vector`（和 chunk 写入同一个纪律），失败则整批回滚。
- 怎么确认：`npm run test:local-gateway-smoke` 里串行触发 `codebase.index.start` + `graph.index.start`（同一 workspace），看 graph 是否报锁；或 `cargo test --lib` 加一条并发用例：一个线程持写事务 2s，另一线程 `graph.index_workspace` 断言不因 busy 失败。
- 置信度：medium（并发条件明确，实际面板同时点两下即触发）

### F11 walker 的 16000 上限是在**未排序的遍历序**上截断的：大于上限的仓库，每次增量索引到的文件集合都不同；`.env`/`.gitignore` 那条白名单还是死代码

- 类型：latent-bug
- 严重度：low
- 位置：`crates/dieyun-core/src/index/walker.rs:74-119`、`crates/dieyun-core/src/index/walker.rs:128-155`
- 证据：

```rust
// walker.rs:74-102 —— 先按遍历顺序收满 cap，再排序
    let cap = max_files
        .saturating_mul(SNIFF_OVERSAMPLE)
        .max(max_files.saturating_add(SNIFF_MIN_HEADROOM));
    let mut candidates: Vec<PathBuf> = Vec::new();
    ...
    for entry in walker.flatten() {
        if !entry.file_type().map(|t| t.is_file()).unwrap_or(false) {
            continue;
        }
        candidates.push(entry.into_path());
        if candidates.len() >= cap {
            break;
        }
    }
```

```rust
// walker.rs:116-118 —— 排序发生在截断之后
    entries.sort_by(|a, b| a.rel.cmp(&b.rel));
    entries.truncate(max_files);
    entries
```

```rust
// walker.rs:137-143 —— 隐藏文件根本到不了这里（crate 默认跳过），这条白名单是死的
    let base = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
    if base == "Dockerfile"
        ...
        || base.starts_with(".env")
```

- 触发：工作区文本候选 > `cap = 16000*4 = 64000`（大 monorepo、含大量小文本的仓库）时，`ignore::Walk` 的 `readdir` 顺序决定「哪 64000 个进候选」，每次运行可能不同 → 排序后截断出的 16000 个随之变化 → `purge_stale_chunk_paths` 每轮把掉出名单的文件的 chunk 删掉、把回到名单的重建一次，索引持续抖动且结果不可复现。次一级：`truncate(max_files)` 之后超出的文件**静默不进索引**，Node 侧 `codebaseHasSearchableIndex` 仍判「可检索」（`src/gateway/rpc.js:1954`），模型查不到也无从得知。另外 `base.starts_with(".env")` 与 `KNOWN_TEXT_EXT` 里的 `.gitignore/.dockerignore/.editorconfig` 永远不会命中（`ignore` crate 默认跳过隐藏项，walker.rs:72-73 自己写了这一点），白名单与注释互相矛盾。
- 修法方向：把 `cap` 截断挪到「排序之后」（先收集全部相对路径并排序，再取前 `cap` 个去做 IO 嗅探），并给「因上限被丢弃的文件数」一个可见计数（进度快照里带一个 `files_skipped`）；顺手删掉 `.env` 那几行死白名单，避免下一个人以为点文件会被索引。
- 怎么确认：`cargo test -p dieyun-core --lib index::walker` 加一条：造 3 个文件、`collect_text_files(dir, 2)`，断言返回的是字典序前 2 个（现在取决于 readdir 顺序，在 NTFS 上通常恰好也是字典序，故需用 64000 规模或注入乱序目录名才能稳定复现 —— 也可以用 `cap` 极小 + 名字逆序构造）。
- 置信度：medium

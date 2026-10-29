# Issue：只读查询与索引写入共用同一条常驻连接 → 任一慢查询即让全部 status 45s 超时（「代码索引面板读取失败」）

- 状态：**已修复**（2026-10-28，见文末「修复记录」）；触发者 `repo_map` 的 O(符号×调用) 子查询同批修掉
- 记录日期：2026-10-28
- 组件：`dieyun-core`（Rust）· `index` / `graph` · `SqliteHandle`（`crates/dieyun-core/src/sqlite.rs`）
- 严重级别：**P1** —— 面板长期显示「读取失败」，status 轮询被整段冻结，且现象会被误判成「索引坏了 / 换了向量模型导致」

## 环境

| 项目 | 值 |
|---|---|
| 应用 | `dieyunagent` dev build（Electron），core = `E:\dieyunagent\build\dieyun-core\dieyun-core.exe` |
| 工作区 | `D:\PixelOfficeMonitor`（3067 文件 / 27,262 chunks） |
| 索引库 | `%APPDATA%\dieyunagent\codebase-index.sqlite`，**1.02 GB**，WAL，全库 113,964 chunks / 52,956 图符号 / 384,594 调用 |
| 机器 | Windows，Ryzen 7 9700X（8C/16T），32G+ 内存 |

## 现象

1. 「代码索引」面板状态行：`读取失败：Gateway RPC 超时: codebase.status (45s)`；其它字段（源文件 / 代码片段 / 向量 / 更新时间 / 进度）停留在**上一次成功读取**的快照，看起来像「建到一半卡死」。
2. `main.log` 里同一方法成串超时。2026-10-28 全天 **254 次** `[dieyun:core] RPC_TIMEOUT`，分布：

   | 方法 | 次数 |
   |---|---|
   | `graph.status` | 175 |
   | `codebase.status` | 67 |
   | `codebase.index.start` | 4 |
   | `graph.repo_map` | 3 |
   | `memory.long_recall` | 5 |

   时间集中在 4 段：`12:53–12:57`、`14:53–15:01`、`16:37–17:04`（零星）、`17:12–17:16`。
3. **与换向量模型无关**：库里 `workspaces` 行显示 `builtin:bge-base-zh-v1.5@768`、`chunk_count=27262`、`vector_count=27262`、`indexed_at=2026-10-28 14:44:35` —— 全量重嵌入已成功收尾。
4. **重启应用无效**：`17:10:32` 新 core 起来，`17:12` 起又开始 45s 超时（新会话的 prep 立刻又触发同一个慢查询，见下）。
5. 期间 core 进程持续吃掉约 0.8–1 个核，但数据库读本身毫秒级（`SELECT COUNT(*) FROM chunks` 7.8 ms / `chunk_vectors` 40.7 ms），排除「库太大读不动」。

## 已确认并已修掉的触发者：`graph.repo_map` 的 O(符号数 × 调用数)

`graph.repo_map` 的 hub_symbols 查询里，引用数用了**每符号一个相关子查询**，`WHERE` 里带 `OR`：

```sql
(SELECT COUNT(*) FROM graph_calls c
  WHERE c.root_hash = s.root_hash
    AND (c.callee_symbol_id = s.id
         OR (c.callee_symbol_id IS NULL AND c.callee_name = s.name)))
```

`idx_graph_calls_callee` 是 `(root_hash, callee_name)`，被 OR 挡住只能吃到 `root_hash` 前缀 ⇒ 执行计划退化为「每个符号全扫一遍本工作区全部 `graph_calls`」：

```
CORRELATED SCALAR SUBQUERY 1
  SEARCH c USING INDEX idx_graph_calls_callee (root_hash=?)
```

实测：单符号 **155 ms** × 7,742 个候选符号 ≈ **1,204 秒（20 分钟）**，全程攥着下面那把共享锁。

**已修**（`crates/dieyun-core/src/graph/query.rs`）：改为两次 `GROUP BY` 聚合 + `LEFT JOIN`，同一份数据实测 **322 ms**，`graph.repo_map` 端到端从「>120 s 不返回」降到 **2.6 s**（冷缓存首次调用）。同时补了两条回归测试（语义等价 + 规模护栏）。

> 修掉它只消掉了**这一次**的触发者，下面的结构性问题没变：下一个分钟级只读查询照样会引发同一场 45s 风暴。

## 结构性问题（本 issue 主体）

1. **index 与 graph 共用一条常驻连接**：`crates/dieyun-core/src/codebase_db.rs` → `SqliteHandle::new(db_path, ensure_schema)`，两个服务拿同一个 `Arc<SqliteHandle>`。
2. **这条连接的锁是非重入 `std::sync::Mutex`，且没有排队上限**：`crates/dieyun-core/src/sqlite.rs` 的 `with_conn`（注释已明确「f 应当是短操作，长任务用 `open_dedicated`」）。`busy_timeout = 15s` 只作用于 **SQLite 文件锁**；进程内 mutex 排队是**无限等**的，所以 45s 只是被客户端撞破的时刻，不是 core 自己的判断。
3. **读侧全都在抢这把锁**：

   | 路径 | 位置 |
   |---|---|
   | `codebase.status` | `index/mod.rs:183` → `with_conn` → `status_with_conn` |
   | `codebase.search` | `index/mod.rs:848` / `867` |
   | `graph.status` | `graph/mod.rs:189` |
   | `graph.repo_map` | `graph/mod.rs:584` |
   | `graph.module_deps` | `graph/mod.rs:571` |
   | `graph.symbol_search` | `graph/mod.rs:596` |
   | `graph.callers` / `graph.impact` | `graph/mod.rs:704` / `732` |
   | `graph.symbol_semantic_search` | `graph/mod.rs:663` / `682` |

4. **写侧反而是对的**：`run_index`（`index/mod.rs:562`）、`index_remote_begin/push/finish`、`embed_symbols`（`graph/mod.rs:639`）都已经用 `open_dedicated()`。**问题只在读侧没跟上** —— 这条不对称正是坑。
5. **读路径里还藏了一次写**：`status_with_conn`（`index/mod.rs:250–280`）在 `workspaces.indexing != 0` 或元数据看着不对时，会在同一把锁上顺手做 `COUNT(*)` + `UPDATE workspaces SET indexing = 0 ...`。status 本该是纯读，藏写意味着它还要等写锁/`SQLITE_BUSY`（最多 15s）。
6. **重试放大**：面板 busy 时每 2 s 轮询（`src/renderer/renderer-codebase-panel.js`），graph / codebase 增量调度器各自也有轮询（`src/graph/graph-incremental-scheduler.js:85`、`src/index/codebase-incremental-scheduler.js:126`，超时 15 s）⇒ 一次分钟级慢查询能产出上百条超时日志，把真正的故障淹掉。

## 复现方法（外部可复现，不靠读代码）

用真实索引库**副本** + 当前 `build\dieyun-core\dieyun-core.exe`，直接走 `serve-stdio` JSON-RPC：

1. `core.configure`（`builtin: true`，`models_dirs` 指向 `E:\dieyunagent\models`）→ `codebase.status`：**1–3 ms**
2. 发 `graph.repo_map`（`limit: 32`）不 await，同时每 400 ms 发一次 `codebase.status`：
   - 修复前：repo_map 120 s 不返回；status **10/10 全部超时**
   - 修复后：repo_map 2.6 s 返回；期间 status `170, 0, 1, 1, 1, 1 ms`

第 2 步的「一条长查询 ⇒ 所有 status 哑火」与具体是哪个查询无关，换任意慢只读查询都能复现。

## 影响面

| 影响 | 说明 |
|---|---|
| 功能表现错位 | 面板/prep 分不清「正在建索引」和「core 不响应」，一律显示「读取失败」，用户会怀疑索引坏了或换模型失败 |
| 雪崩 | 一次慢查询 → 全部 status 排队 → 上层重试 → 更多排队，恢复时间被拉长到分钟级 |
| 误导排查 | 与 `issue/2026-10-28-remote-index-infinite-retry-and-sigkill.md` 叠加时，超时链会最终表现为 core 被 SIGKILL，看起来像崩溃/OOM |
| 波及非索引功能 | 同期出现 5 次 `memory.long_recall` 超时（不同的库，疑似同一时间片内阻塞池/运行时被这些排队请求挤占），值得一并观察 |

## 修复建议（减法优先）

1. **把「读」从这条锁里分出去（首选）**：`SqliteHandle` 从「1 条常驻连接」变成「reader 常驻 + writer 常驻」两条，`with_conn` 保留给写与短操作，新增 `with_reader` 给 status / search / graph 只读查询。
   理由：这不是新增兜底层，而是把「读」和「写」这两个本质不同的职责拆开 —— 现状是把两者硬塞进一把非重入锁里，锁本身就是重复职责的来源。WAL 天然支持 1 writer + N readers，语义上不改任何可见行为。
2. **status 必须无条件秒回**：走 reader 连接，且**只做纯读**；`status_with_conn` 里那次 `UPDATE ... SET indexing = 0` 要么挪到写侧（索引线程收尾时自己修），要么由「读到的脏标记」驱动写侧处理。
3. **排队上限**：进程内 mutex 上无限等 45 s 不是可接受的形态。短期若不拆连接，至少 `try_lock` + 明确错误码（如 `DB_BUSY_IN_PROCESS`），让上层立刻降级成「索引忙，稍后再看」而不是挂 45 s。
4. 明确**不做**：加超时兜底 / 重试层 / 开关 / 把 timeout 调更大 —— 都只是让症状更安静，不消除排队。

## 验收标准

1. 人为制造一个分钟级只读查询在飞，期间 `codebase.status` / `graph.status` **P95 < 50 ms**，不出现 45 s 超时。
2. 索引重建 / remote ingest 写入进行中，status 仍秒回（写侧已是独立连接的对照回归）。
3. `cargo test -p dieyun-core` 全绿，并新增一条「reader 不被 writer / 长查询阻塞」的并发测试（可直接复用本次的复现姿势：长查询在飞 + 连发 status，断言全部 < 1 s）。
4. 一次正常会话里，`main.log` 不再出现同一方法的成串 `RPC_TIMEOUT`（`codebase.status` / `graph.status`）。

## 修复记录（2026-10-28）

### 1. 读侧拆开：状态走常驻连接，数据查询走独立连接

新增两个**单一入口**，读路径不许再自己拼连接：

| 入口 | 位置 | 职责 |
|---|---|---|
| `IndexService::status_impl` | `crates/dieyun-core/src/index/mod.rs` | `codebase.status` 唯一读入口（纯读） |
| `GraphService::read_dedicated` / `status_snapshot` / `read_conn` | `crates/dieyun-core/src/graph/mod.rs` | `graph.*` 读侧唯一取数姿势 |

落到具体方法：

- `codebase.search` 的**检索段**（FTS + 向量全扫 + 池加载）改走 `open_dedicated()`；
- `graph.repo_map` / `module_deps` / `symbol_search` / `callers` / `callees` / `impact` /
  `symbol_semantic_search` 的查询段全部改走独立连接（状态快照仍走常驻连接，1ms）；
- `graph.ingest_lsp_callers`（短写）仍走常驻连接。

### 2. status 纯读化：维修动作移出读路径

`index::status_with_conn` 与 `graph::status_with_conn` 现在**只读不写**：

- index 侧把「`indexing=1` 残留 / 元数据残缺」以 `StatusRepair` 交回调用方，由
  `apply_status_repair` 用独立连接 + `busy_timeout(0)` best-effort 补写；
- graph 侧同理，返回 `(status, stale_flag)`，由 `repair_stale_indexing_flag` 补写；
- 返回给上层的数值已经是修好的值，**是否落盘与本次读无关**，修不上就下次再修。

### 3. 顺带查出的第二个根因：新开连接自己也会撞写锁（实测 16.4s）

`sqlite::tune` 里的 `PRAGMA auto_vacuum=INCREMENTAL` **即便目标值与当前值相同也要拿写锁**。
长任务（结构索引 / 向量构建）开着写事务时，`open_dedicated()` 里的这一步会阻塞满
`BUSY_TIMEOUT_SECS`：实测 **16,398 ms**。也就是说，只把慢读挪到独立连接还不够 ——
开连接这一下就能把读请求堵 16s。

改为：先 `PRAGMA auto_vacuum` 读一次，已经是 `INCREMENTAL` 就**不执行这条 pragma**；
需要申请时用 `busy_timeout(0)` 试一次，抢不到就放弃（它本来就是 best-effort，下次开连接再试）。

### 4. 刻意**没有**做的两件事

- **reader + writer 两条常驻连接**（原建议 1）：做完上面 1、2 之后，常驻连接上已经
  **没有任何写者**（写侧全在独立连接），慢查询也全在独立连接上；再加一条常驻连接等于
  多一份状态、多一条要同步的生命周期，收益为 0。保留「单条常驻连接 + 只跑秒回级短读」
  的契约，并写进 `sqlite.rs` 的文档注释。
- **进程内 `try_lock` + `DB_BUSY_IN_PROCESS` 错误码**（原建议 3）：它的前提是「不拆连接」，
  读侧现在已不与慢查询/写事务共享锁，再加一条错误分支只是新增机制。

### 5. 回归测试（4 条，全部断言「写事务在飞时读仍秒回」）

| 测试 | 位置 | 卡住的是什么 |
|---|---|---|
| `resident_read_is_not_blocked_by_open_write_transaction` | `sqlite.rs` | 常驻连接读 vs 打开着的写事务 |
| `opening_dedicated_connection_does_not_wait_on_open_write_transaction` | `sqlite.rs` | 开连接（`tune`）vs 写事务（老库路径） |
| `status_is_pure_read_and_never_waits_on_writer` | `index/mod.rs` | `codebase.status` 纯读 + 维修不阻塞 |
| `graph_reads_do_not_wait_on_open_write_transaction` | `graph/mod.rs` | `graph.status` / `symbol_search` vs 写事务 |
| `repo_map_refs_scale_with_calls_not_symbols_times_calls` | `graph/query.rs` | 上一批的 O(符号×调用) 退化 |

`cargo test -p dieyun-core --lib` → **118 passed**。

### 6. 端到端复验（真实库副本 1.02 GB / 7742 符号 / 114,377 调用）

功能（每个读方法都换了连接）：

| 方法 | 耗时 | 结果 |
|---|---|---|
| `codebase.status` | 41 ms（冷）/ 1 ms（热） | 27,262 chunks / 27,262 vectors / bge-base-zh-v1.5@768 |
| `codebase.search` | 247 ms | 5 hits |
| `graph.status` | 1 ms | 7742 symbols / 114,377 calls |
| `graph.symbol_search` | 4 ms | 命中 |
| `graph.module_deps` | 7 ms | deps=2 / dependents=1002 / circular=8 |
| `graph.callers` | 103 ms | sites=1366 |
| `graph.impact` | 6 ms | affected=1486 |
| `graph.repo_map` | 198 ms（热）/ 1872 ms（冷） | 32 hub symbols / 32 edges |

两个关键场景：

- **长读在飞**：`graph.repo_map` 跑着，同时连发 6 次 `codebase.status` → `1, 0, 1, 1, 1, 1 ms`。
- **真的在跑索引**（60 文件 / 60 chunks / 60 向量，边建边问）→ 40 次 status/graph.status 全部
  `0–3 ms`，最大 3 ms。

## 相关

- `issue/2026-10-28-remote-index-infinite-retry-and-sigkill.md` —— 远端同一症状的超时重试无上限（放大同一条链路）
- `issue/2026-10-28-multi-agent-workspace-resource-isolation.md` —— 多实例共享同一个索引库
- 已修（2026-10-28）：`crates/dieyun-core/src/graph/query.rs` `repo_map` 引用数聚合 + 两条回归测试

## 后续（同日）：符号向量检索整体删除

起因：结构索引面板的「符号向量」永远是 `0 / — / — / 未写入向量`。查出 `graph.index.start`（面板「重建」与自动增量）
从不建符号向量，只有 `graph.embed_symbols` / `graph.symbol_semantic_search` 会建。中途我一度判断「没有调用方」，
那是错的 —— agent 工具 `graph` 的 `operation: 'semantic_find'` 走的就是它（`src/agent/delegate-tool-gateway.js`，
schema 在 `tool-catalog.js`），库里也确实有 63 条历史向量（4 个工作区，`text-embedding-zen-embedding-8b@4096`）。

用户确认不要这个能力后按「减法」整体删除：

- Rust：`graph/embed.rs`、`graph_symbol_vectors` 表、`graph_workspaces` 的 `symbol_vector_count` / `symbol_embedding_model` 两列、
  `graph.embed_symbols` / `graph.symbol_semantic_search` 两个 RPC、`VectorPool::load_symbols`、`GraphService::from_config`
- Node：网关两个 handler、`INDEX_RPC_METHODS` 白名单、RPC 超时归组、工具层 `semantic_find`（catalog / 校验 / 护栏 / 委托四处的单一来源一起摘）
- Renderer：结构索引面板 4 行（符号向量 / 向量模型 / 向量维度 / 向量一致性）+ 帮助文案里的「语义找符号」段
- 迁移：`graph::schema::ensure_schema` 打开既有库时 `DROP TABLE graph_symbol_vectors` 并删两列（幂等；新库不建这两列）

验证：`cargo test -p dieyun-core --lib` **117 passed**（含新增 `ensure_schema_drops_legacy_symbol_vector_state`）；
真实库副本（1.02 GB）打开即完成迁移（ping 25 ms），表与两列消失、`graph_workspaces` 32 行原样、`PRAGMA integrity_check` = ok；
`graph.status` 5 ms 且返回 JSON 不再带向量字段，`graph.symbol_search` 不再带 `vectorSearch` / `needsEmbed`，
两个已删方法返回 `UNKNOWN_METHOD`；`graph.repo_map` 167 ms。自然语言找代码从此只有一条路：`codebase.search`。

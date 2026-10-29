# SQLite 访问模型（唯一入口 `sqlite.rs`）

> 改任何 `crates/dieyun-core` 里的库访问前先读这一页。三个入口，三种寿命，**没有第四种**。

## 三条连接通道

| 入口 | 用途 | 并发 | 寿命 |
|------|------|------|------|
| `SqliteHandle::with_conn` | **唯一写入连接**（短事务、status 级小写） | 串行（一把 Mutex） | 进程级常驻 |
| `SqliteHandle::read` / `read_conn` | 只读查询（地图 / 符号检索 / 代码检索 / status / 记忆召回） | 池内并发，上限 `READ_POOL_CAP = 4`，超出排队 | 一次查询，Drop 归还 |
| `SqliteHandle::open_dedicated` | 分钟级长任务（建库 / 向量构建 / 远程索引） | 不设上限，调用方自己保证数量 | 任务结束即关 |

选择标准只有一条：**这段代码会不会把连接占住很久**。
- 会（分钟级、跨 `.await` 的构建）→ `open_dedicated`；
- 不会，但是扫描型查询 → `read`（池化）；
- 写，或者必须和已有写事务同一条连接 → `with_conn`。

**memory 库也走这套。** `MemoryStore` 以前自己攥一条裸 `Connection` + 一把私锁，
所有读（提示词召回、记忆界面检索）都要排队等「聊天落库」的写；现在它只持有
`Arc<SqliteHandle>`，`MemoryStore::with_conn` / `read` 直接转发到上面两条通道。
长任务（向量构建、修剪）仍用 `open_dedicated`。

### 按库声明的 `TuneOptions`

`foreign_keys` 不能统一打开：memory 库依赖 `ON DELETE CASCADE` 清子表
（traces / plans / steps / vectors），而 index / graph 原本没开、历史数据里还有孤儿行，
统一打开会让原本静默通过的 INSERT 开始报错。所以它是**每个库文件自己**的开关：

```rust
SqliteHandle::new(path, init_schema)                     // 默认：不开外键
SqliteHandle::new_with_foreign_keys(path, init_schema)   // memory 库
```

写入连接与池化读连接用的是**同一份** `TuneOptions` —— 否则同一条语句在不同连接上语义不同。

## 为什么读侧要单独一个池

常驻连接是 index / graph / memory **共用的一条**写入连接，外面是一把非重入 `Mutex`。
读查询一旦挂在它上面，代价不是「慢一点」，而是排队到 `BUSY_TIMEOUT_SECS`（15s）：
`codebase.status` / `graph.status` 这类被面板轮询的请求会直接顶到宿主客户端超时
（历史症状：`Gateway RPC 超时: codebase.status (45s)`，然后宿主重试、队列更满）。

所以：

1. 读查询不碰常驻锁，走池子；
2. 池子有上限（4）。超限的读在 `Condvar` 上排队 —— **排队而不是再开一条**，
   否则「并发子 Agent 数」就等于「连接数」；
3. 池化连接出错就丢弃（`ReadConn::discard`），不放回池子，避免一次磁盘级故障反复复发；
4. `initialized`（`AtomicBool`）让读侧在建表完成后彻底绕开常驻锁，
   否则每次读都要先探一次「初始化没有」，碰上长任务照样白等。

## 读路径里不许写

`*.status` 一类方法的脏状态修复（`indexing = 1` 却没人真在跑）**不在读路径做**：
读只把脏状态以结构体形式交回，由调用方用独立连接 + `busy_timeout(0)` 补写，
抢不到写锁就下次再来（`index::IndexService::apply_status_repair`、
`graph::GraphService::read_dedicated`）。维修绝不能拖慢读。

## 常驻连接必须常驻 autocommit

`with_conn` 的 `f` 里可以自己开事务（`conn.unchecked_transaction()`），但**进去之前必须是 autocommit**。
带着未提交事务进来，只可能是前面某条语句在事务里报错后没人回滚：

- SQLite **不会**替你回滚语句级错误，事务继续开着；
- `execute_batch("BEGIN/SAVEPOINT …; 会失败的语句; ROLLBACK; RELEASE")` 这种写法，失败点到 `ROLLBACK`
  之间的语句全部被跳过 —— 包括那句回滚自己；
- 之后这个库的每条写入都进那个永不提交的事务，进程一退全部丢失，而且**全程没有报错**。

真实事故：`memory/schema.rs` 的 FTS 写入探针用了这种批次，一次探针失败让 memory 库在 14 小时里
写了 31MB / 7611 帧 WAL、只有 10 个 commit 标记，重启后整段对话蒸发。

所以：**需要事务就用 `rusqlite::Transaction`（Drop 必回滚），不要手写 BEGIN/ROLLBACK 批次**；
`with_conn` 入口同时兜一层不变量：发现残留事务就记日志并 `ROLLBACK`，宁可丢掉那笔来路不明的
未提交写入，也不让它吞掉整个进程的数据。

## 在途预算（`rpc::request_budget_ms`）

`core.ping` / `*.status` / `rpc.cancel` 这些**宿主轮询**方法带 20s 在途预算，
超了直接回 `RPC_TIMEOUT`，让宿主知道「core 忙」而不是「core 死了」。
长任务（建库 / 检索 / 压缩）**不设预算**：掐断 awaiter 也停不下已经跑起来的阻塞任务，
只会制造假失败。

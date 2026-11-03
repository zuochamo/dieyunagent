# 向量检索：现状、边界与换 ANN 的条件

> 改 `index/vector_pool.rs`、`memory` 语义召回、或想「上向量数据库」之前先读这一页。
> 结论先写：**当前是精确全量扫描 + int8 量化，没有 ANN 索引**；换 ANN 有明确触发条件（见 §4），
> 触发之前自己写 HNSW 是纯负收益。

## 1. 三条检索路径

| 路径 | 向量来源 | 存储形态 | 扫描实现 |
|------|----------|----------|----------|
| `codebase.search` 词法之外的语义通道 | `chunk_vectors`（**只在本次建库显式要向量时**写入，`vectors: true`） | **常驻内存 `VectorPool`**（int8 + 每向量 f32 步长） | `VectorPool::scan_into` 全量余弦 |
| 记忆语义召回（`memory.long_recall` 第一级） | `long_memory_vectors` | 每次查询从 SQLite 读 BLOB、反序列化 | Rust 内全量余弦（f32，量远小于代码块） |
| 远端索引（SSH / WSL） | 远端库 | 远端进程内同样走 `VectorPool` | 同上 |

三者共用同一套「余弦 + 阈值」口径（`MIN_SIMILARITY = 0.05`，唯一来源 `crates/dieyun-core/src/embedding/mod.rs`：代码索引向量池与长记忆语义召回都读它），没有第二套打分公式。

> 代码索引的**词法通道**现在只有一条：子串 `LIKE`（按命中词数排序）。trigram FTS 已于 `SCHEMA_VERSION 4` 删除（体积/使用率判据见 `docs/INDEX-VALUE-REVIEW.md` R2）；`memory` 的 `long_memories_fts` 仍用 trigram，两者互不影响。

### 1.1 向量的生命周期（谁建、谁删、什么时候失效）

`vectors` 是**请求参数**，描述「本次建库要不要顺手写向量」，不是工作区的持久开关。据此有三条硬规则：

1. **只有显式 `vectors: true` 才写向量**：面板「建向量」（增量补齐）、CLI `--vectors`、显式传参的 RPC 调用方，以及**已经建过向量的工作区的保存增量**（`codebase-incremental-scheduler` 仅在 `vectorCount > 0` 时才跑，带 `vectors: true` 沿用同一意图 —— 它按文件删旧 chunk 会连向量一起删，不跟着补就等于让覆盖率单向下滑；`embeddingEnabled === false` 时退回不带向量，避免每次保存都撞 `EMBEDDING_NOT_CONFIGURED`）。`@Codebase` 与 prep 首次建库**不**带向量（见 `INDEX-VALUE-REVIEW.md` §8 的取舍）。
2. **`vectors: false` 不删已有向量**（`INDEX-VALUE-REVIEW.md` R3 补丁）：删过一次就会「用户建了几分钟的向量，一次重建片段/一次保存全没了」，语义通道无声消失。清空只发生在两种地方 —— `force` 全量重建（chunk id 全换）与 embedding 签名变更（维度不兼容）。
3. **元数据描述真实存在的向量**：`workspace.vector_count` 查库实数，`embedding_model/dims` 在「本次没建但库里还有」时沿用旧签名。`codebase.search` 只有在「端点可用 **且** `vector_count > 0` **且** 签名与当前设置一致」时才挂向量通道，否则静默走子串（`vectorSearch: false`，面板会显示原因）。

覆盖度是**可观测**的：`vectorCount < chunkCount` 说明增量改过的文件只有 chunk 没向量（那部分只能靠子串召回），面板「向量一致性」会显示「仅覆盖 N/M 段」，点「建向量」补齐（`load_chunks_missing_vectors` 只补缺的，不重算全部）。

请求 `vectors: true` 但端点没配（`model` / `base_url` 为空或被禁用）时，RPC 返回 `EMBEDDING_NOT_CONFIGURED`，不会静默降级成「只建片段」。

### 1.2 向量复用：跨 worktree 的内容哈希缓存

「`vectors` 是请求参数」在**每会话一份索引库**的场景下有个致命后果：SSH 会话的库是
`<worktree>/.dieyun/index.sqlite`，换个会话就是空库，于是每个新会话都要把整仓重新
embedding 一遍。这就是向量长期开不起来的真原因（不是「模型没用」）。

修法不是加开关，而是认识到**一条向量只由两样东西决定**：送进模型的文本、以及谁算的
（模型@维度|端点）。跟它在哪个 worktree、哪个文件、第几行无关。所以：

| 项 | 内容 |
|---|---|
| 位置 | `<data_dir>/vector-cache.sqlite`（`index/vector_cache.rs`，`CACHE_FILE_NAME`）。**不写进项目**：纯派生缓存，删掉只影响下次建库速度，写进项目会让每个 worktree 多一份 |
| 键 | `(sha256(实际送进模型的文本) 前 32 位, cache_key)`；`cache_key = model@dims|base_url`（`EmbeddingConfig::cache_key`）。哈希用 `embedding_input()` 的产物——超长 chunk 会被截断，用原始正文做键会让两个只在截断点之后不同的 chunk 各算一次、拿到相同向量 |
| 为什么缓存键带端点而索引元数据不带 | `workspaces.embedding_model` 存的是 `signature()`（`model@dims`），改口径会让存量库集体判「过期」并重算；缓存是全局共享的，两个提供商可能都叫 `bge-m3` 都是 1024 维，喂错向量**不报错、只会让检索悄悄变差**，所以缓存键必须更严 |
| 上限 | `DEFAULT_MAX_ROWS = 150_000`（≈600 MB），超了按 `created_at` 裁最老的。命中不写库（否则一次建库几千次写），所以是「按写入时间」而非严格 LRU |
| 失败策略 | 打不开 / 写满 / 加锁失败 ⇒ 一律当「全部未命中」，建库照常走原路，只是慢。缓存是优化，永远不许让建库失败 |
| 实现入口 | `IndexService::apply_cached_vectors`（查 + 写命中）+ `store_embedded_vectors`（写库 + 回填 + 裁剪），本机建库与 SFTP 摄取**共用这一份** |
| 可观测 | `workspaces.vectors_reused / vectors_embedded`（schema v5）→ `StatusResult.vectorsReused/vectorsEmbedded` → 面板「向量来源：复用 N / 新算 M」 |

判「开关是否真的省事」只看一个数：同一仓第二次建库时 `vectorsEmbedded` 应该只剩改动文件，
`vectorsReused` 接近 `chunkCount`。如果反过来，说明缓存键漂了（换模型/换端点 ⇒ 全量重算，
这是对的）或者缓存没接上（`with_vector_cache` 未传路径）。

可复现验收：`npm run verify:vector-cache-reuse`（需先 `cargo build -p dieyun-core`）。
它起一个假 embedding 端点、造两份独立索引库（等价两个 SSH 会话）+ 同一个 `data_dir`，
断言第二份库 `vectorsReused = chunkCount && vectorsEmbedded = 0` 且端点总调用次数不变。

带**耗时**口径的两条（A 冷启动 / B 第二个会话 / C 同库重建 三次测量，驱动是
`scripts/index-timing-driver.py`）：

- `npm run verify:index-timing-local` —— 本机，验测量口径与断言（含「请求数 < 片段数」「在飞峰值 ∈ (1,4]」）；
- `npm run verify:index-timing-ssh` —— 真机 SSH，需 `DY_SSH_HOST` / `DY_WS=<远端项目>`；认证优先用
  `%TEMP%\dy_ssh_pw`，没有该文件就走 `~/.ssh/config` 的 key / agent（与 app 同源）。

### 1.3 请求形状：批大小 + 有界并发（冷启动的时间账几乎全在这里）

`crates/dieyun-core/src/embedding/mod.rs` 里只有两个常数决定「一次建库打端点多少次、同时打几条」：

| 常数 | 值 | 口径 |
|---|---|---|
| `EMBED_BATCH_MAX_INPUTS` + `EMBED_BATCH_MAX_CHARS` | 32 条 / 24 000 字符 | 一次请求的上限，**取先撞的那个**（`plan_embed_batches`，纯函数）。端点限制有两种口径：条数（OpenAI 兼容普遍 2048）与总 token（多数本地部署按总量卡）。字符按**截断后真正发出去的文本**计 |
| `EMBED_CONCURRENCY` | 4 | 全进程同时在飞的请求数（`EMBED_INFLIGHT: Semaphore`）。**这是唯一口径**：多个索引库同时建也只共享这 4 个名额 |

实测（7178 片段的真机 worktree，端点每批 250ms）：串行 8 条/批 = 899 次请求 = 238s →
有界并发 4 + 字符预算 = 578 次请求 = 39s（其中 13.8s 是索引本身）。细节见
`SSH-INDEX-COLD-START-PLAN.md` §6.11。

有意不做：**429 退避 / 自动降批 / 并发可配置**。被限流时应当报 `EMBEDDING_API`（带端点原始 message）
—— 加退避层只会把「端点说不行」变成「慢慢试」，把真实上限藏起来。要调就改上面两个常数，没有第二处。

#### 端点本身太慢时：批与并发都救不回来（2026-10-31 真机实测）

同一台机器上配的是一个自建 embedding 服务（`text-embedding-qwen3-embedding-4b`，2560 维，
`http://192.168.31.62:5018/v1`）。直接压它（输入 2 360 字符）：

| 请求 | 耗时 |
|---|---|
| 1 条输入 | 53s |
| 8 条输入 | 90s |
| 32 条输入（本仓批大小上限） | 131s |

于是两件事同时成立，且都不是调参能解决的：

1. **单请求 120s 超时 < 一批 32 条的 131s** → 每批必超时，`vectors_embedded` 永远是 0；
   真机上表现为「建向量跑了 15 分钟、向量 0 条、库里 `vector_count = 0`」。
2. 就算把超时放大，7 204 片段 = 226 批，按 131s/批、并发 4（服务端明显不并行，实测并发不提速）
   ≈ **2 小时起步，1 万片段的仓库要跑一晚上**。这条全在端点吞吐上，`EMBED_BATCH_MAX_INPUTS`
   调到 8 或 64 都不会改变总时长的数量级。

结论：**先用真实负载量一次端点，再决定开不开语义检索**。量法：

```
# 在本机或远端主机上，用与 core 相同的请求形状压一次
python3 - <<'PY'
import json, time, urllib.request
url, key = "http://<host>:<port>/v1/embeddings", "<api-key>"
txt = "def parse_config(path: str) -> dict:\n    return load(path)\n" * 40
body = json.dumps({"model": "text-embedding-qwen3-embedding-4b", "input": [txt] * 32}).encode()
req = urllib.request.Request(url, body, {"Content-Type": "application/json", "Authorization": "Bearer " + key})
t = time.time()
with urllib.request.urlopen(req, timeout=600) as r:
    d = json.load(r)
print("%.1fs, %d dims" % (time.time() - t, len(d["data"][0]["embedding"])))
PY
```

一批 32 条的耗时就是单轮冷启动的下界：批耗时 × ⌈片段数 / 32⌉ ÷ 4。这个数超过几分钟，
语义检索就不该开（**关键词/子串通道仍然可用**，见 `INDEX-VALUE-REVIEW.md` §7.2）。

#### 建向量前的 configure 顺序（已修）

远端 daemon 每个工作区一份 core host（乙案：每会话一个 worktree）。新工作区的 host 冷启动时
没有任何配置，而 `invokeIndexCore` 只看「core 已就绪」缓存、命中就跳过 `index.configure` ——
于是面板「建向量」在**新会话**里必然回 `EMBEDDING_NOT_CONFIGURED`（真机实测；手动跑一次
`index.remote_sync_configure` 后同一工作区立刻 `embeddingEnabled=true`）。

修法在调用侧：`src/gateway/rpc.js:startIndexForContext` 在**这次要建向量**时先把配置推到这条
连接上（`syncRemoteIndexCoreConfig()`，幂等、单一来源），再发 `codebase.index.start`。
不是重试层：它修的是「配置下发与使用不同步」这个顺序问题。

## 2. `VectorPool` 的三个硬边界

```rust
pub(crate) const VECTOR_POOL_MAX_BYTES: usize = 3 * 1024 * 1024 * 1024;  // 3GB，LRU 淘汰
```

1. **内存上限 3GB**（进程级，chunk 池与符号池各自一个 `PoolCache`）。
   int8 量化后单条向量的成本 ≈ `dims + 16` 字节：

   | 维度 | 单向量 | 3GB 约可容纳 |
   |------|--------|--------------|
   | 768 | ≈ 784 B | ≈ 410 万条 |
   | 1024 | ≈ 1040 B | ≈ 310 万条 |
   | 4096 | ≈ 4112 B | ≈ 78 万条 |

   超出后按最久未用淘汰 —— 大量 workspace 交替检索时会出现反复重装（装载 = 一次全表读 + 反序列化）。
2. **扫描复杂度 O(N·d)**，与向量条数线性相关。百万级 768 维 int8 点积是单核百毫秒量级；
   这条路径**没有**任何剪枝，`N` 增长时延迟线性增长。
3. **装载粒度是整个 root_hash**：不支持的增量装载，索引更新后整池重载。

## 3. int8 量化的误差界

- 对称量化：`scale = max|v| / 127`，`q = round(v / scale)`；扫描时点积累加完再一次乘回步长。
- 范数仍用**原始 f32** 计算（分母与 SQL 路径同一口径），修正项不引入额外偏差。
- 句向量本身已 L2 归一化、分量集中在小范围，量化后的余弦误差在 **1e-3 量级**，
  比阈值 `0.05` 小两个数量级。`int8_quantization_preserves_top1_and_error_bound`
  守着这条约定：top-1 不可变，单条分数偏差 < 1e-2。
- 换来的是 4× 内存下降与 4× 扫描带宽下降。**不改变「全量扫描」这件事本身**。

## 4. 什么时候必须换 ANN（触发条件）

满足任一条，就说明该换实现而不是继续调参：

1. 单个 workspace 的有效向量数 > **200 万**（3GB 内存能装下，但单次扫描已到亚秒级，且与聊天 RPC 争 CPU）；
2. 检索 P95 延迟 > **300ms**（`codebase.search` 的宿主超时预算是秒级，再高会触发重试风暴）；
3. 出现 **LRU 抖动**：同一 workspace 连续检索仍在反复重装（多工作区并行时的典型症状）；
4. 向量维度升到 1024+ 且语料量级不变（内存先撞上限，而不是 CPU）。

## 5. 换的时候怎么做（不要自己写）

- **落点只有一个**：`index/vector_pool.rs::scan_into` 是所有检索的扫描入口，
  换实现只改这里 + 装载路径，调用方（`index/search.rs`）不用动。
- **优先用已维护的库**（`sqlite-vec` / `usearch` 之类），指数与向量同库同事务，
  这样删除/更新的一致性由库保证。手写 HNSW 意味着还要自己实现墓碑删除、
  增量插入、参数调优、以及与 `chunks` 表的一致性修复 —— 那是**第二套索引结构**，
  违反「单一来源、减法优先」。
- 换之前先确认量化已开启（本页 §3）：很多情况下 int8 + 全量扫描已经足够，
  ANN 的召回损失反而不划算。
- 换之后必须保留本页 §2 的三个数字与 §3 的误差约定，并在 `docs/HARNESS-INVENTORY.md`
  更新常量清单。

## 6. 已知不做的事（写清楚，免得当成 TODO）

- 不实现「近似召回 + 精确重排」的两段式：当前扫描一次就出全部分数，
  加一层预筛只会在 `N` 不够大时损失召回、换不到延迟。
- 不对 query 做量化：查询只有一条，量化它不会省任何时间，只会引入额外误差。
- 不给 `long_memory_vectors` 建常驻池：记忆条数由修剪策略封顶（数量级远小于代码块），
  常驻反而是无谓占内存。
- 不给 embedding 请求加 429 退避 / 自动降批 / 并发配置项（见 §1.3）：限流就报错，
  加退避只会把「端点说不行」变成「慢慢试」，还会让真实上限无人知晓。

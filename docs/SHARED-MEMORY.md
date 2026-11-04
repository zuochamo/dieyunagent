# 共享记忆（跨机 PostgreSQL）

> 属于「记忆系统」的一层：局域网内多台叠云 Agent 共用一个记忆库。
> 记忆分层的全貌见 [MEMORY.md](./MEMORY.md)；本文只讲**跨机**这一层。
> 旧实现（`758d1ae` 之前的「蜂群共享记忆」）已删除，本文说明重做后的形态与**为什么不回到旧形态**。

---

## 1. 一句话

**本机归纳出的记忆条目，同步到一个内网 PostgreSQL 库；其他机器按需召回，进 system prompt 的【共享记忆】块。只同步记忆条目，不上传对话。**

开关在 设置 → 扩展 → **共享记忆**（默认开启）。检查不到数据库就自动停用，本地记忆与对话完全不受影响。

---

## 2. 与本地记忆的分工

| 层 | 存哪 | 谁写 | 谁读 | 生命周期 |
|----|------|------|------|----------|
| 用户级记忆 | 本机 SQLite `long_memories` | 本机归纳器 | 本机每轮 prompt | 本机 |
| 项目记忆 | `<workspace>/.dieyun/memory.md` | 归纳器 / 用户 / Agent | 本机每轮 prompt | 跟仓库走 |
| **共享记忆** | **内网 PG `dieyun_memory.shared_memory`** | **各机器的归纳器（镜像上传）** | **各机器每轮 prompt（按需召回）** | 跨机、跨项目 |

共享库**不是**真相源：它只是「别的机器学到的东西」的聚合。删库不丢本机记忆；
某台机器的本地记忆被用户手改，也不会反向覆盖共享库（上传只在归纳器写入新条目时发生）。

---

## 3. 数据模型

建表语句唯一来源：`src/memory-shared/schema.sql`（`ensureSchema` 首次连上时执行，幂等）。

| 表 | 作用 |
|----|------|
| `shared_memory` | 记忆条目：`content`、`content_hash`（唯一，跨机去重）、`kind`、`scope`、`node_id`、`importance`、`embedding`（pgvector，**不锁维度**）、`embedding_model` / `embedding_dim`、`status`（`active` / `merged` / `archived`）、`merged_into`、`access_count`、`last_used_at` |
| `memory_nodes` | 参与节点心跳（主机名 + 客户端版本 + 最后活跃时间）—— 只用于「谁在共用这份记忆」的可见性 |
| `memory_consolidations` | 提炼台账：谁抢到锁、扫了多少条、合并/新增多少、用了哪个模型 |

索引：`(scope, status)`、`gin(content gin_trgm_ops)`（中文没有分词器，trigram 就是文本兜底）、
`(embedding_dim) WHERE embedding IS NOT NULL`（部分索引，避免维度过滤走全表）。

**为什么 `embedding` 不定维度**：不同机器可能配了不同的 embedding 模型（维度不同）。
定死 `vector(1024)` 会让换模型直接写不进去。这里存无维度 `vector`，用 `embedding_dim` 标明实际维度，
召回时 `embedding_dim = 查询维度` 才走向量通道，其余行退回文本相似度。

---

## 4. 召回：一条 SQL，两个来源

唯一构造点：`src/memory-shared/service.js#buildRecallQuery`（纯函数，有单测）。

```sql
ORDER BY COALESCE(向量距离, 1 - trigram 相似度) ASC, importance DESC, last_used_at DESC
```

- 查询向量为空 / 该行没向量 / 维度对不上 → `COALESCE` 自然落到文本分。**不是两条代码路径**，是同一个排序语义。
- 服务端能力只影响表达式，不影响语义：
  - 没装 `vector` 扩展 → SQL 里不出现 `::vector`（否则 PG 报 `type "vector" does not exist`）；
  - 没装 `pg_trgm` → 相似度退化为 0，排序退到「重要度 + 冷热」。
- 阈值与本地记忆同一套：语义 `0.32` / 关键词 `0.12`（`agent-limits.js#sharedMemoryMinScore*`）。
  **按行取阈值，不按批**：同一批结果里可能既有向量行（`score = 1 - 余弦距离`）又有 trigram 行
  （`score = similarity`），两者量纲不同；按批级 `mode` 一刀切会让兜底行永远过不了 0.32，
  等于「有向量就再也用不上文本兜底」—— 与上面的 `COALESCE` 设计直接相违。

注入点只有一处：`src/agent/system-prompt-prep.js#fetchSharedMemoryBlock`，
块标题 `【共享记忆 · 局域网其他机器沉淀 · …】`，排在【长期记忆】之后、【压缩】之前 ——
**他人结论不该盖过本机事实**。

注入克制：只有本轮有用户 query 才召回；块内条数 ≤ `sharedMemoryRecallLimit`（5），
字符 ≤ `sharedMemoryBlockMaxChars`（1600）。服务不可达直接返回空串，块缺席。

---

## 5. 上传：什么会离开本机

归纳器写完本地用户级记忆后（`knowledge-maintainer.js#applyMemoryItems`），把本轮
**新写入**的条目镜像上传（`mirrorShareable`）：

1. **只上传用户级（`scope='global'`）记忆**：项目记忆的真相是仓库文件，跨机共享会变成「别人的项目结论」；
2. **`kind` 为 `secret` / `private` 永不出本机**：判定只有一处 `project-memory-file.js#isShareableKind`，
   与写 `.dieyun/memory.md` 共用（两份落地物后果一样：一份会进版本库，一份是全网段共读）；
3. **幂等**：按 `content_hash`（空白折叠后的 sha256）去重，重复上传只是更新 `access_count` / `updated_at`；
4. **失败只记日志**：共享库挂了不影响本地记忆与归纳结果（fail-open，不重试、不入队）。

---

## 6. 提炼（合并冗余）：谁来做

旧设计靠「Master / Slave 模式文件 + 授权密码 + 心跳角色表」决定谁跑 LLM。全部删掉。

现在：**谁来提炼由数据库的 advisory lock 决定**。

```
claimConsolidation(trigger)  → pg_try_advisory_lock(0x64696579) 抢到才继续
  ├─ 冷却检查：读 memory_consolidations 里上次完成的 finished_at（跨机口径，不是本机内存）
  ├─ listConsolidationCandidates()  取一批 active 条目
  ├─ LLM 合并（提示词与模型调用在 agent/knowledge-maintainer.js，唯一实现）
  ├─ applyConsolidation()           被合并的标 merged，合并后的新条目入库
  └─ releaseConsolidation()         解锁 + 记台账
```

- 抢不到锁 / 在冷却期 → 直接返回 `{ok:false, reason:'locked_or_cooldown'}`，**不排队、不重试**。
- 触发点不新增定时器：搭在归纳器已有的两个心跳上（任务收尾归纳、定时完整归纳），
  外加设置页的「立即提炼」按钮。
- 提炼提示词要求模型输出与归纳器**同一套 JSON**（`memories` / `archive_memory_ids`），
  因此解析复用 `parseKnowledgeJson`，没有第二份解析器。
- 只允许归档「本次候选里出现过的 id」—— 模型编不出库里没有的行。

---

## 7. 可用性：检查不到就关

状态判定只有一处：`service.js#getStatus`，四个字段决定一切：

```js
active = enabled && configured && available
reason = disabled | no-password | unconfigured | unreachable | unprobed
```

- `enabled` 是用户的开关（默认 `true`）；
- `configured` = 主机/库名/账号 + 口令齐全（口令没填就不算配置好）；
- `available` = 最近一次探活成功（`probe()`：连上 → `ensureSchema` → 心跳）。

**探活失败不改用户的 `enabled`**：只是本轮及以后不参与读写，设置页显示原因；
下次启动或用户点「重新检测」再试。不加重试层、不加降级链 —— 这就是「连不上就关」。

口令存储：`src/secret-store.js`（MCP / SSH / 频道同一份），系统加密 + `0600`，**绝不回退明文**；
页面永不回显，只显示「已保存过口令，留空表示不修改」。

---

## 8. 装配位置（改代码前去这几处）

| 关注点 | 唯一位置 |
|--------|----------|
| 配置 + 口令 | `src/memory-shared/settings.js`（`shared-memory.json`，默认值即内网约定） |
| 连接池 / TLS 协商 / 建表 / 探活 | `src/memory-shared/pg.js` |
| 召回 SQL / 上传 / 提炼锁 / 状态 | `src/memory-shared/service.js` |
| 提炼提示词与 LLM 调用 | `src/agent/knowledge-maintainer.js#runSharedMemoryConsolidation` |
| 注入块 | `src/agent/system-prompt-prep.js#fetchSharedMemoryBlock` |
| 镜像上传触发 | `src/agent/knowledge-maintainer.js#applyMemoryItems` → `mirrorShareable` |
| 实例装配（Main） | `src/main-entry.js`（`createSharedMemoryService` + 启动探活） |
| IPC | `src/main/ipc/shared-memory.js` |
| 设置页 | `src/renderer/renderer-shared-memory.js` + `index.html`（扩展 → 共享记忆） |
| 数字预算 | `src/agent/agent-limits.js`（`sharedMemory*` 一组） |

`src/memory-shared/*` **不 require `src/agent/*`**（避免循环）：服务实例由 Main 装配后注入
（归纳器拿 `getSharedMemory()`，prompt 装配拿 `deps.sharedMemory`）。
Headless 未装配该实例，因此 headless 轮次不注入共享记忆、也不上传 —— 这是有意的边界。

---

## 9. 服务端准备（一次性）

目标机（示例：`192.168.31.62`，PG 18）：

```bash
sudo apt-get install -y postgresql-18-pgvector          # 向量扩展（可选，缺了走文本召回）
sudo -u postgres psql -c "CREATE ROLE role_mem LOGIN PASSWORD '<口令>'"
sudo -u postgres psql -c "CREATE DATABASE dieyun_memory OWNER role_mem"
sudo -u postgres psql -d dieyun_memory -c \
  "CREATE EXTENSION IF NOT EXISTS vector; CREATE EXTENSION IF NOT EXISTS pg_trgm"
```

- `pg_hba.conf` 需允许内网段（示例 `host all all 192.168.31.0/24 scram-sha-256`）；
- **口令只放在服务器的凭据文件里，不进仓库**；客户端在设置页粘贴一次即可；
- 表结构不用手工建：客户端首次连上会执行 `schema.sql`（幂等）。

---

## 10. 明确不抄的东西（旧设计的坑）

| 旧做法 | 现在 | 理由 |
|--------|------|------|
| 每条对话消息都上传 | 只上传记忆条目 | N 台机 × 每条消息，是旧设计最贵的部分；对话检索本机已有 `messages_fts` / `session_recall` |
| Master / Slave 模式文件 + 授权密码 | advisory lock | 多一份配置、多一个「谁说了算」的协商点，还会出现两台机同时烧 LLM |
| 定时器在 Renderer | 搭在归纳器心跳上，不新增定时器 | 窗口一关就停摆；定时器属于 Main |
| 服务端 7 张表（含消息、任务、成员） | 3 张表 | 只解决「记忆条目共享」，其余是没人读的账 |
| 召回失败重试 / 队列 | fail-open 直接跳过 | 共享库是增益，不是链路依赖；重试只会把故障放大成卡顿 |

---

## 11. 验证

```bash
npm run test:unit                     # 含 test/unit/shared-memory.test.cjs（SQL 构造 / 去重 / 口令语义）
npm run check:renderer                # 设置页脚本与 i18n

# 真机连通（口令走环境变量，不进仓库）
DIEYUN_PG_SMOKE=1 DIEYUN_PG_PASSWORD=<口令> npx vitest run test/unit/shared-memory.test.cjs
```

真机用例会做：探活 → 建表 → 上传一条带唯一标记的条目 → 按同一句话召回 → 断言命中。

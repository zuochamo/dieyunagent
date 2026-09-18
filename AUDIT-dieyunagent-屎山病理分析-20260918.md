# dieyunagent 屎山病理分析报告

- **审计对象**：`F:\dieyunagent`（Electron + Rust `dieyun-core` 的本地 Agent 运行时）
- **审计时间**：2026-09-18
- **审计方式**：静态源码审计（含 3 个并行子审计：能力校验 / 上下文记忆 / Git 链路与功能面）。**未做运行时压测**，所有写入量均为按代码路径推导的量级估计，非实测值。
- **审计范围排除**：`node_modules/`、`dist/`、`release/`、`deploy/`、`target/`、`mobile-app/`（构建产物与第三方代码）

---

## 0. 结论速览

| 命题 | 判定 | 严重度 | 核心证据 |
|---|---|---|---|
| 1. 默认开 TRACE 疯狂落盘 SQLite | **不成立**（无日志级别体系），但存在等效更差的病 | 高 | 全仓无 `LOG_LEVEL`/`TRACE` 开关；改由 4 条无熔断落盘流 + 每 2.5s 全量 checkpoint 承担 |
| 2. 常驻多媒体渲染挤占算力 | **不成立** | 低 | renderer 无 canvas/sprite/PIXI；音频链路清理完整 |
| 3. "缓存只有 1G 所以不会写爆磁盘" | **工程概念错误（双重）** | 高 | 全仓无 `cache_size`；唯一量级预算是 3GB×2 的**内存**池，与磁盘无关 |
| 4. 把模型幻觉的生成能力当产品特性 | **工具层不成立，展示层部分成立** | 中 | 无任何生成类工具；但 UI 用「全模态」描述识图模型，内置技能宣传图/视频/音乐生成 |
| 5. 上下文隔离 / 注意力分配 | **部分缺失**（有 compaction，无作用域隔离） | 高 | 全局记忆无 workspace 过滤；subagent 复制父会话完整 system prompt |
| 6. 在坏掉的 Git PR 链路上堆外围功能 | **前提不成立**：根本没有 PR/commit/push 链路 | 极高 | 全仓无 `git add/commit/push`、无 `gh pr`；worktree 应用变更靠 `copyFileSync` 覆盖 |

**一句话结论**：这不是"某个模块写烂了"的屎山，而是**"最危险的写盘路径没有闸门、最需要正确性的写入链路没有实现、最贵的上下文没有隔离"**的三重结构性缺失。功能面已经铺到 13.5 万行（核心只占 24%），而承载这些功能结果的 Git 写入链路只有 955 行、零测试、失败模式是静默数据丢失。

---

## 1. 日志系统与 I/O 写放大（对应问题 2 前半 + 问题 1）

### 1.1 先修正前提：没有日志级别，也就不存在"默认 TRACE"

全仓 grep `LOG_LEVEL` / `DIEYUN_DEBUG` / `DEBUG_LOG` / `verbose` 开关，仅在 `src/browser/console-collector.js:31` 命中一处**字符串映射**：

```js
if (l === 'verbose') return 'debug';
```

即：项目**没有日志分级体系**，也没有"默认开启 TRACE"的配置项。所以 Codex 式"TRACE 默认开 + 疯狂落盘 SQLite"这个具体病灶**不存在**。

但它的等效病理换了个形式存在，而且更隐蔽：**分级缺失 → 无节流 → 无上限 → 无熔断**。下面四条落盘流，一条比一条严重。

### 1.2 四条落盘流（含熔断对照）

| # | 落盘流 | 位置 | 频率 | 上限 | 轮转 | 节流 | 熔断 |
|---|---|---|---|---|---|---|---|
| A | 集成终端日志 | `src/agent/terminal-log.js:31`<br>触发点 `src/main/ipc/terminal.js:141,159,182` | **每个 PTY 数据块** | **无** | **无** | **无** | **无** |
| B | gateway.log | `src/gateway-file-log.js:20-37` | 每行日志 | 2MB | 有（截留 65%） | 无 | 无 |
| C | tool-telemetry.jsonl | `src/agent/tool-telemetry.js:33` | 每次工具调用 | 2MB | 有（留 1 份 .1） | 无 | 无 |
| D | plans-logs | `src/plans/plan-agent-runner.js:87`<br>`src/plans/runner.js:73` | 每轮流式正文 | **无** | **无** | **无** | **无** |

**A 条（终端日志）是本项目最被低估的磁盘杀手**：

```js
// src/agent/terminal-log.js:29-33
state = {
  filePath,
  stream: fs.createWriteStream(filePath, { flags: 'a', encoding: 'utf8' })
};
```
```js
// src/main/ipc/terminal.js:141
onData: (text) => sendTerminalData(sessionId, text),
```

`onData` 是 PTY 的原生回调——**终端每吐一个数据块就写一次文件**，没有合并窗口、没有速率上限、没有大小上限。落点在工作区内部：`<workspace>/.dieyun/terminals/integrated.log`（`terminal-log.js:13`）。

对照 B/C 两条都写了 2MB 上限和轮转，说明作者**知道要做这件事**，唯独漏了最容易爆的这一条（终端里跑一次 `npm run dev`（HMR/进度条）或任何 verbose 构建，产出量是日志系统的几个数量级）。

> 附带核实（避免误报）：`.dieyun` 已被索引器排除，见 `crates/dieyun-core/src/index/walker.rs:10`，所以终端日志不会被代码库索引重复吞掉。这一点是干净的。

**B 条（gateway.log）是写放大 + 主线程阻塞的组合**：

```js
// src/gateway-file-log.js:20-30, 36-37
function trimIfNeeded() {
  const { size } = fs.statSync(logPath);       // 每次写入都 statSync
  if (size <= MAX_BYTES) return;
  const raw = fs.readFileSync(logPath, 'utf8'); // 全文读入内存
  fs.writeFileSync(logPath, raw.slice(-Math.floor(MAX_BYTES * 0.65)), 'utf8'); // 全量回写
}
...
trimIfNeeded();
fs.appendFileSync(logPath, `[${...}] ${text}\n`, 'utf8');   // 同步写，逐行
```

- 阈值 2MB、每次截留 65%（1.31MB）→ 每写入约 0.69MB 新数据就触发一次 1.31MB **全文件重写**，写放大系数 ≈ **2.9×**；
- 全程 `*Sync`，跑在 Electron **主进程**上 → 日志越频繁，UI 卡顿越明显；
- 无速率上限、无熔断。

**C 条**每次工具调用 `appendFileSync`（一次 open+write+close 系统调用），且 `summarizeTelemetry`（`:61-62`）每次 `readFileSync` 全量读入再 `split` —— 同步全量读，也是主进程。

**D 条**每轮流式正文 `appendFileSync` 直写 `plans-logs/*.md`，无上限。

### 1.3 SQLite 侧：真正的 SSD 杀手（问题 2 的核心）

#### (1) trace checkpoint 每 2.5s **全量**落盘，写入量与时长成平方关系

```js
// src/renderer/agent/trace-store.js:5
const TRACE_CHECKPOINT_INTERVAL_MS = 2500;
```
```js
// src/renderer/agent/trace-store.js:134-143
const payload = {
  runId, sessionId,
  trace: trace.map((entry) => ({          // 全量 trace 深拷贝
    ...entry,
    tools: Array.isArray(entry.tools) ? entry.tools.map((tool) => ({ ...tool })) : []
  })),
  streamContent: params.streamContent || '', // 累积到当前的完整回复正文
  ...
};
```
```js
// crates/dieyun-core/src/memory/agent.rs:29-31（作者自己的注释，已确认节奏）
// 运行中的任务每 ~2.5s 保存一次 trace checkpoint（agent.trace_save → upsert_agent_run），
```

而 Rust 端一次 `agent.trace_save` 会**写两张表、把同一份内容序列化三遍**：

```rust
// crates/dieyun-core/src/memory/agent.rs:125-133  → 写 agent_runs.state_snapshot（全量快照）
self.upsert_agent_run(&json!({
    "id": run_id, "sessionId": session_id, "status": status,
    "summary": input.get("summary"),
    "stateSnapshot": input.get("stateSnapshot"),
}))?;

// crates/dieyun-core/src/memory/agent.rs:134-160 → 写 agent_traces（trace_json + trace_text）
let trace_json = ...;                       // 全量 trace JSON
let trace_text = ... "traceText" ...;       // 同一份内容的纯文本版（第二次序列化）
conn.execute(
    "INSERT INTO agent_traces
      (run_id, session_id, message_id, phase, trace_json, trace_text, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)", /* ... */)?;
```

注意这里是 **INSERT 而非 UPSERT** —— `agent_traces` 每 2.5s **新增一行**，不覆盖。

**量级推算**：一次 10 分钟的运行 = 240 次 checkpoint；`trace_json` + `trace_text` + `state_snapshot` 三份同源内容，随回复长度线性增长。若最终 trace 为 30 万字符，单次 checkpoint 落盘约 300KB 级 → **单回合 60～70MB 级别写入**；且因为是"每 2.5s 写一份**当前全量**"，总量与时长成**平方关系**而非线性。这是纯粹的写放大，没有任何新信息被写进去。

#### (2) 表只涨不缩：修剪只在启动时跑，且漏掉了最肥的表

```rust
// crates/dieyun-core/src/memory/mod.rs:162-199
fn spawn_prune_surplus_agent_traces(db_path: PathBuf) {
    std::thread::Builder::new().name("dieyun-memory-prune".into()).spawn(move || {
        ...
        let _ = Self::prune_surplus_agent_traces(&conn);
    })
}
fn prune_surplus_agent_traces(conn: &Connection) -> Result<(), CoreError> {
    let count: i64 = conn.query_row("SELECT COUNT(*) FROM agent_traces", [], |r| r.get(0)).unwrap_or(0);
    if count < 4_000 { return Ok(()); }
    conn.execute_batch(r#"
        DELETE FROM agent_traces WHERE id NOT IN (
          SELECT id FROM (SELECT id, ROW_NUMBER() OVER (PARTITION BY run_id ORDER BY id DESC) AS rn
            FROM agent_traces) WHERE rn <= 2);
    "#)?;
}
```

三个问题：
1. **只在 `MemoryStore::open()` 时触发一次**，不是周期任务 → 一个长驻进程可以涨到任意大小；
2. **只修剪 `agent_traces`，不修剪 `agent_runs`** —— 而 `agent_runs.state_snapshot` 恰恰是同一份全量快照（1.3 节 (1)）；
3. **全仓无 `VACUUM`**（`crates/` 内 grep `VACUUM` 0 命中）→ DELETE 只把页标记为空闲，**文件永不缩回**。作者注释已经承认这个后果：

```rust
// crates/dieyun-core/src/memory/mod.rs:157
// 后台修剪，勿阻塞 serve-stdio 启动（4GB 库同步 DELETE 可卡数十秒）
```

"4GB 库"就是这套机制自己生产的。

#### (3) WAL 三件套全缺 + 连接管理反模式

`journal_mode=WAL` 设了，但配套的**一个都没设**：

| PRAGMA | 状态 | 位置 |
|---|---|---|
| `journal_mode=WAL` | ✅ 已设 | `memory/mod.rs:146`、`index/mod.rs:177`、`graph/mod.rs:117` |
| `busy_timeout` | ✅ 已设 | `memory/mod.rs:169`、`index/mod.rs:175`、`graph/mod.rs:116` |
| `foreign_keys` | ✅ 已设 | `memory/mod.rs:148` |
| `synchronous` | ❌ **未设 → 默认 FULL** | — |
| `wal_autocheckpoint` | ❌ 未设 | — |
| `cache_size` | ❌ **未设 → 默认 ≈ 2MB** | — |
| `mmap_size` | ❌ 未设 | — |

`synchronous` 保持默认 `FULL`，在 WAL 模式下意味着**每次 commit 都 fsync**——恰好丢掉了 WAL 最主要的性能收益（`NORMAL`）。这是"用了 WAL 但没吃到 WAL 好处，只继承了复杂度"的典型。

**连接管理反模式（更能解释"为什么机器一直热"）**：`IndexService` 与 `GraphService` **不持有连接**，每次 RPC 现开现关。

```rust
// crates/dieyun-core/src/index/mod.rs:71-80  —— 结构体里只有 db_path，没有 conn
pub struct IndexService {
    db_path: PathBuf,
    embedding: EmbeddingConfig,
    models_dirs: Vec<PathBuf>,
    indexing: Arc<Mutex<HashSet<String>>>,
    progress: Arc<Mutex<HashMap<String, ProgressSnapshot>>>,
    remote_ingest: remote::RemoteIngestHandle,
    vector_pools: PoolCache,
}

// crates/dieyun-core/src/index/mod.rs:168-178  —— 每次调用新建连接 + 重设 pragma
fn open(&self) -> Result<Connection, CoreError> {
    let conn = Connection::open(&self.db_path)?;
    conn.busy_timeout(std::time::Duration::from_secs(15))?;
    conn.pragma_update(None, "journal_mode", "WAL")?;
    ...
}
```

`self.open()` 在 `index/` + `graph/` 共 **18 处**调用（含 `index/mod.rs:205` 的 `status()`），`graph/mod.rs` 一处就 13 次。

在 WAL 数据库上，**最后一个连接关闭时会执行一次 checkpoint 并删除 `-wal`/`-shm` 文件**。而这两个服务恰好被前端定时轮询驱动：`renderer-codebase-panel.js:75`、`renderer-graph-panel.js:75`、`renderer-components.js:204`（3s）。于是形成一个永动机：**轮询 → 新连接 → 读 → 关闭 → checkpoint → 删 WAL → 下次再建**。即使有别的连接存活（如 `MemoryStore` 持锁常驻，`memory/mod.rs:251-255`），每次仍要重新打开文件、重跑 `journal_mode=WAL`（这是会加写锁的操作）。

### 1.4 "缓存只有 1G 所以绝对不会写爆磁盘"——三重工程错误

**错误一：概念错位（WAL ≠ 页缓存）。**
`cache_size` 管的是 SQLite 在**内存**里缓存多少页；WAL 文件大小由**写入量**、`wal_autocheckpoint`（未设，默认 1000 页 ≈ 4MB）、以及**是否有活跃读快照/长事务阻塞 checkpoint** 决定。这两者之间**没有任何数量关系**。把"缓存小"当成"磁盘写入量小"的保证，是把内存配额当成了磁盘闸门。

**错误二：代码事实不符。**
全仓**根本没有设置 `cache_size`**（grep 0 命中）→ 实际是 SQLite 默认值 `-2000` 页 ≈ **2MB**，不是 1G。

**错误三：代码里唯一的量级预算常量是 3GB×2，而且它是内存、不是磁盘。**

```rust
// crates/dieyun-core/src/index/vector_pool.rs:24-25
/// 每类向量缓存（chunk / 符号各一份）的内存上限；超出按最久未用淘汰。
pub(crate) const VECTOR_POOL_MAX_BYTES: usize = 3 * 1024 * 1024 * 1024;
```

chunk 池 + 符号池各 3GB → **理论常驻上限 6GB 向量内存**。这是真正的内存风险点（见第 2 章），可它依然**完全不能约束**第 1.2/1.3 节的磁盘写入。

**结论**：真正需要在意的磁盘膨胀源，一个都不受任何"缓存大小"管辖：

| 膨胀源 | 边界 |
|---|---|
| `integrated.log`（每个 PTY 块） | 无 |
| `plans-logs/*.md`（每轮正文） | 无 |
| `agent_traces`（每 2.5s 追加一行全量） | 仅启动时修剪 |
| `agent_runs.state_snapshot` | **从不修剪** |
| `-wal` 文件 | 无 autocheckpoint，靠连接关闭被动 checkpoint |
| 已删除行占用的空闲页 | **无 VACUUM，永不回收** |

---

## 2. 内存与常驻算力（对应问题 2 后半）

### 2.1 前提修正：「常驻多媒体渲染挤占算力」不成立

- **没有多媒体渲染管线**：`src/renderer/` 全目录 grep `canvas` / `getContext(` / `sprite` / `PIXI` / `lottie` → **0 命中**（只有 `.gif` 的 MIME 映射，如 `renderer-attachments.js:72`）。项目名里的 "pixel-office" 是遗留命名，UI 是纯 DOM。
- **音频链路清理是干净的**，只在录音期间存活：

```js
// src/renderer/renderer-composer-voice.js:95-106
cancelAnimationFrame(waveAnimId); waveAnimId = null;
if (audioContext) { try { audioContext.close(); } catch {} audioContext = null; analyser = null; }
```
```js
// src/renderer/renderer-composer-voice.js:161-169
for (const track of mediaStream.getTracks()) track.stop();
mediaStream = null;
stopWaveform();
if (voiceTimerId) { clearInterval(voiceTimerId); voiceTimerId = null; }
```

AudioContext 关闭 ✅、rAF 取消 ✅、MediaStream 轨道停止 ✅、定时器清理 ✅。`MediaRecorder` 也只按 250ms 分片（`renderer-composer-voice.js:221`）。**这一块无可指摘，硬要扣分只能扣"波形动画改 `height` 会触发 layout"（`renderer-composer-voice.js:135`），且仅录音时存在。**

### 2.2 真实的常驻开销：定时器 × 轮询 × 每次新建 SQLite 连接

常驻但被忽视的定时器/轮询清单：

| 位置 | 周期 | 代价 |
|---|---|---|
| `renderer-components.js:204` | 3s | 组件页刷新 |
| `renderer-codebase-panel.js:75` | 轮询 | → `IndexService::status()` → **新建连接** |
| `renderer-graph-panel.js:75` | 轮询 | → `GraphService` → **新建连接** |
| `renderer-knowledge-maintainer.js:1021,1025` | 定时 + 首跑 90s | 知识整合 |
| `renderer-agent-llm.js:835` | 定时 | 记忆维护 |
| `renderer-wiki-panel.js:345` | 定时 | wiki 等待轮询 |

再叠加每 2.5s 一次的 checkpoint（1.3 节）与其 fsync（`synchronous` 未设，默认 FULL）——**这才是"机器一直热、风扇一直转"的物理来源**：不是多媒体在渲染，而是**定时器在驱动磁盘同步写**。修法也很明确：连接常驻化 + 轮询改推送，比优化任何渲染代码收益都大。

### 2.3 真正需要担心的内存项

- `VECTOR_POOL_MAX_BYTES = 3GB` × 2 池（`index/vector_pool.rs:25`）= 理论 6GB 常驻向量池，LRU 淘汰（`:228-250`）。这在"Electron 主进程 + renderer（109 个文件 / 61k 行 UI）+ LLM 请求缓冲"之上叠加，是明确的内存压力源。
- 反过来看，这一条**恰好说明"写盘风险"和"缓存上限"是两套独立的账**——向量池有 3GB 上限就很安全吗？不，它只管内存；磁盘那五条流一条都没被它管到。

---

## 3. 能力校验与 AI 幻觉（对应问题 3）

### 3.1 工具层：**"把幻觉当产品特性"这一步没有发生**

`src/agent/tool-catalog.js` 全量枚举 60+ 工具（`:3-1520`），**没有任何图像 / 视频 / 音频生成工具**。唯一与"生成"沾边的是：

- `host_print_image`（`:21`）——打印
- `browser_screenshot`（`:538`）——网页截图
- `browser_pdf`（`:561`）——导出 PDF

所以"纯文本模型幻觉出'我能生成视频'，然后被注册成产品特性"这条链路在本项目里**断在了第一环**：没有对应的工具被定义，幻觉无法被"兑现"。

### 3.2 但能力校验层整体缺失

模型元数据只有一个 `modalitySetting`，且语义仅是**图片输入**：

```js
// src/renderer/renderer-model-settings.js:723-733
const next = { id, name, baseUrl, apiKey,
  modalitySetting: window.ModelCapabilities?.normalizeModalitySetting(modalitySetting) || 'text' };
```

**不存在** `capabilities` / `modalities` / `supportsVision` / `supportsImage` / `supportsVideo` 等字段。全仓 grep `capabilities.*(check|support|vision)` → 仅 1 命中且在 bundle 里。

唯一的真闸门是"识图"：

```js
// src/renderer/renderer-agent-send.js:560-572
const canSendImages = prepared.hasImages && modelSupportsMultimodal(composerModel, route);
if (prepared.hasImages && !canSendImages) {
  effectivePrepared = stripMultimodalFromPrepared(prepared);  // 降级为纯文本
}
```

但这条闸门有三个缺口：

1. **上游无条件构造图片 part**：`src/renderer/renderer-attachments.js:546` 直接构造 `{type:'image_url'}`，`processAttachmentsForSend` **不接收模型参数**；序列化层 `renderer-agent-llm.js:442-451` 只校验 URL 格式（`sanitizeOutboundImageUrl`），**不校验模型是否收图**。闸门只有一处，绕过即发。
2. **静默丢图无提示**：`stripMultimodalFromPrepared`（`renderer-agent-loop.js:42-57`）静默降级，用户不会知道自己的图被丢了（对比 `renderer-attachments.js:553` 附件超限是有 toast 的）。
3. **无工具调用能力校验、无长上下文校验**：工具暴露只按权限开关（`host.*`）；弱模型判定是**模型名启发式**而非能力声明：

```js
// src/agent/tool-catalog.js:1390-1402
const weakModel = isWeakToolCallerModel(opts.model);
```
`contextWindow` 纯用户手填（`src/model-settings.js:120-124`），不校验模型真实窗口。

### 3.3 系统提示词里没有任何能力边界声明

```js
// src/agent/agent-system-prompt.js:17-41  buildCoreAgentRules
'- 完成校验：声称已改文件/已完成实现时，须确有写操作工具或会话变更；否则应补做或更正表述。',
```

全仓 grep「不具备 / 不能生成 / 无法生成 / 不支持生成 / 能力声明」→ **0 命中**。也就是说：模型在对话里声称"我可以生成视频/图片"，**系统没有任何一句话告诉它"你不行"，也没有任何一层拦截这种输出**。防护完全依赖用户自己识破。

### 3.4 展示层的混淆（这部分前提成立）

两处把"能读图"包装成"能出图/全模态"：

1. `src/renderer/index.html:1764-1768` 模型类型标签为「文本 / **全模态** / 语音」；`renderer-model-capabilities.js:3-7` 标签亦是「全模态」；文案为
   ```js
   // src/renderer/renderer-model-settings.js:209-213
   MODALITY_HINTS：「支持识图与 image_url 多模态输入」
   ```
   把"输入侧识图"称为"全模态"，用户自然会预期输出侧也能生成。
2. 内置技能公开宣传生成能力，但**未标注它来自外部 CLI、与当前所选模型无关**：
   - `skills/bundled/minimax/minimax-multimodal-toolkit/SKILL.md:3,11,85-245`（`mmx image generate` / `mmx video generate` / `mmx music generate` / `mmx speech synthesize`）
   - `src/skills/bundled-i18n-zh.js:19-24`（中文界面文案）

### 3.5 附带：项目自违规则

`AGENTS.md` 第 2 条明令「禁用意图关键词硬编码」，而 `src/renderer/renderer-skills-grid.js:14-178` 是一份**硬编码中英关键词分类表**（`SKILLS_TAXONOMY`），`:320` 还有一个大正则。界定：它只驱动 UI 分类 Tab（`resolveSkillTaxonomy`，`:341-352`），不参与路由，**不构成对规则的实质违反，但形式上是同一类技术债**；且其中 `'generate-image'` / `'search-image'`（`:102-103`）在仓库里**没有对应技能**，属死配置。

### 3.6 能力校验缺失清单

1. 无通用能力模型（只有 `modalitySetting`，且仅表达输入模态）
2. 图片落地无能力兜底（`renderer-attachments.js:546` 不问模型即构造）
3. 静默丢图，无用户提示
4. 无工具调用能力校验（模型名启发式替代能力声明）
5. 无长上下文能力校验（用户手填窗口值）
6. 无输出模态隔离（外部 CLI 技能与当前模型能力未在 UI 区分）
7. 无系统提示能力边界声明，无幻觉输出拦截

---

## 4. 上下文与记忆管理（对应问题 4）

### 4.1 拼装与预算（机制是有的，且比多数同类项目认真）

- 主入口 `assembleSystemPrompt`（`agent-system-prompt.js:186-207`）
- stable 部分硬截 **16000 字符**（`:162-167`；阈值 `agent-limits.js:95`）
- turn 部分**不截断**（`session-context.js:44-52`）
- 总量兜底 `trimMessagesToCharBudget`（`session-context.js:594-675`），`requestMaxChars = 800000`（`agent-limits.js:96`），**只丢非 system 消息**
- Compaction：budget **95232 token**、触发比 **0.85**、冷却 **6 轮**、保留最近 1/4（`crates/dieyun-core/src/compaction/mod.rs:70-141`）
- Token 计量为**字符估算**：`tokens = cjk/1.5 + other/3.2`（`compaction/tokens.rs:30-51`、`agent-limits.js:82-83`），图片按 6000 字符计（`agent-limits.js:76`）

### 4.2 注入块清单（各带上限）

`system-prompt-prep.js` 每轮注入：codebase 检索（mention 16 / auto 12 条，片段 2400 字符，`:26,:204`）、打开文件（12 个路径 / 预览 4000 字符 / 上限 48KB，`:231-252`）、git diff（12000 字符，`:271`）、近期变更（16 条，`:143`）、AGENTS.md（**仅 overview 节，2800 字符**，`:300-308`）、repo map（32 符号 / 4500 字符，`:331-332`）、项目记忆（8 条 × 420 字符）、全局记忆（5 条 × 360 字符）、playbook（3）、compaction 摘要（2400）、工作记忆（12 步）、技能索引（5）、MCP、编辑器选区（2400）、LSP 诊断（10000）、**工具 schema（每轮全量）**。

### 4.3 真实缺陷：有预算，无隔离

**缺陷 ①：工具 schema 每轮全量重发。**

```rust
// crates/dieyun-core/src/agent/loop_run.rs:719-722
"tools": state.tools,
```
MCP 目录不做裁剪，只是从预算里扣掉 25%（`compaction-main.js:57-69`）。启用多个 MCP 后，每轮都有一份固定的大额开销压在 800k 字符预算上。配合 `tool-catalog.js` 里 **30+ 个 `browser_*` 工具**（`:254-1000`，远超核心 fs/exec 的约 10 个），这个固定开销相当可观。

**缺陷 ②：每个 subagent 复制父会话的完整 stable system prompt。**

```js
// src/renderer/renderer-agent-send.js:699
sysContent: sysStable,
```
→ `planner/prompts.rs:173-181` 中 worker 以 `{sys_content}` 为 system 前缀，而 `roleMessages` 传空串（`rust-planner-runner.js:931`）。结果：**N 个并行 worker = N 份父会话的记忆 / 图谱 / AGENTS.md / 项目约定**。这是最直接的 token 放大器，并行度越高成本越线性膨胀。

**缺陷 ③：全局记忆无作用域过滤。**

```js
// src/renderer/system-prompt-prep.js:401-443
// scope='global' 的记忆不做 session / workspace 过滤
```
任意会话只要 query 非空就注入，**甲项目的沉淀会进乙项目的上下文**。

**缺陷 ④：同 workspace 的多会话共享项目记忆**（`src/gateway/handlers/memory.js:177-186`）——同一目录并行开两个会话会互相看到对方刚写入的记忆。

**关于"把不同任务的预注入贬低为没意义的 Role Play"**：这句话在仓库里**查不到对应代码或文档**，而且代码事实与之相反——记忆确实被检索、打分、按阈值过滤、按时效衰减后注入：

```rust
// crates/dieyun-core/src/memory/keyword.rs:140-151
// 命中率×0.65 + 字面×0.25 + importance×0.035 + 时效×0.08，stale -0.15
// 时效为 180 天线性衰减
```
并且有语义优先 / 关键词兜底、双向 `score <= 0.05` 丢弃（`memory/mod.rs:1101,1168`）、写入时精确去重（`mod.rs:557-569`）、`formatMemoryLines` 硬限 20 行（`system-prompt-prep.js:357`）。

我不为这句转述背书。**从架构角度看，真问题不是"要不要预注入"，而是"注入没有作用域和分层"**——即上面的 ①②③。这三条带来的不是"Role Play"，而是：
- **上下文污染**：跨项目记忆串味，模型把别的项目约定当成当前项目事实；worker 被父会话的既有结论带偏（同一个 system 前缀里塞了不属于它的判断）；
- **Token 爆炸**：工具 schema 每轮固定开销 + N 个 worker 复制 N 份稳定前缀，两者都不随任务复杂度缩放，而是随"开关数量 / 并行度"线性增长。

### 4.4 上下文风险清单（按严重度）

| 级别 | 问题 | 位置 | 触发条件 |
|---|---|---|---|
| 高 | 工具 schema 每轮全量，MCP 无裁剪 | `loop_run.rs:719-722` | 启用多个 MCP |
| 高 | subagent 复制父会话完整 stable prompt | `renderer-agent-send.js:699`→`planner/prompts.rs:173-181` | Planner 并行多 worker |
| 中 | 全局记忆无 session/workspace 过滤 | `system-prompt-prep.js:401-443` | 任意会话非空 query |
| 中 | 同 workspace 多会话共享项目记忆 | `handlers/memory.js:177-186` | 同目录并行会话 |
| 低 | 字符估算忽略 JSON / tool_calls 开销，低估真实 token | `session-context.js:540` | 每轮 |
| 低 | 打开文件预览最坏 4×4000 字符 + 12 条路径 | `system-prompt-prep.js:231-252` | 选区文件多 |

---

## 5. Git 链路与功能蔓延（对应问题 5）

### 5.1 前提修正：**这个项目没有 PR 链路，也没有 commit / push**

全仓 grep 结果：

| 查找项 | 结果 |
|---|---|
| `gh pr ` / `createPullRequest` / `octokit` / `api.github` | **0 命中** |
| `git commit` | **0 命中**（`src/` 内） |
| `git add` / `--cached` / staged | **0 命中** |
| `git push` / `fetch` / `merge` / `rebase` | **0 命中** |

所以"底层 Git PR 链路存在 Bug 却强行开发外围功能"这个前提**不成立**——不是"有 Bug 的链路"，而是**根本没有这条链路**。

它有的是一个 **worktree 沙箱**（`src/git/worktree-service.js`，共 955 行），能力止于"看 diff"。

### 5.2 而且这个沙箱的失败模式是**静默数据丢失**

| # | 缺陷 | 证据 |
|---|---|---|
| 1 | 用文件覆盖冒充合并，**静默覆盖主工作区** | `worktree-service.js:464-466` `fs.copyFileSync(src, dest)`，无三方合并、无备份 |
| 2 | 预览算出的 `mainDirty` 被丢弃 | 预览计算于 `:325`，但 `applyRunWorktreeChanges`（`:510-533`）只判 `ch.conflict`，**从不读 `mainDirty`** → 主工作区已有改动会被直接覆盖 |
| 3 | **强制删 worktree 会销毁未提交成果** | `worktree remove --force`，失败再 `fs.rmSync(..., {recursive, force})`（`:133-137`）；`enforceWorktreeCleanupPolicy` 按数量/容量自动清理最旧 run（`:262-280`）。**由于 agent 从不 commit，全部产出都是未提交态** → 会被无提示删除 |
| 4 | 分支 ref 永久累积 | 只 `worktree remove` + `prune`（`:128-155`），**从不 `git branch -D dieyun/agent-*`** |
| 5 | rename 丢旧路径 | `parsePorcelainStatus` 对 `R old -> new` 只取新路径（`:74`）→ 主工作区旧文件不被删除 |
| 6 | baseline 静默截断 | `MAX_BASELINE_FILES = 120` 超限直接 break，不报错（`baseline-capture.js:8,24`）→ 撤回不完整 |
| 7 | worktree 复用不校验有效性 | 目录已存在即复用（`:113-120`） |

**测试覆盖：0。** `test/` 共 17 个用例，grep `worktree|gitExec|git commit|diff-context` **0 命中**。

### 5.3 功能蔓延实测

| 维度 | 数值 | 占比 |
|---|---|---|
| 全 `src/` | ≈ **135,182 行** | 100% |
| 核心 Agent 循环（`agent/` 14,667 + `gateway/` 10,144 + `renderer-agent-*.js` 7,918） | ≈ **32,729 行** | **24%** |
| 外围（renderer 其余 51,853 + browser 9,971 + lsp 4,878 + main 5,450 + mobile 3,657 + mcp 3,358 + ssh 3,114 + wiki/graph/playbook/plans/…） | ≈ **102,453 行** | **76%** |
| `src/renderer/` 单目录 | 109 文件 / **61,472 行** | 45% |
| **Git 链路** | **955 行** | **0.7%** |

`src/` 共 29 个子目录。核心：`agent`、`gateway`、`git`、`session`、`undo`、`tools`、`workspace`、`index`、`codebase`、`lsp`、`graph`、`remote`、`ssh`。外围：`renderer`（最大）、`browser`、`mobile`、`wiki`、`playbook`、`optional-assets`、`monitor`、`terminal`、`automation`、`plans`、`skills`、`plugins`、`mcp`、`main`、`update-bootstrap`、`wsl`（空目录）。

面板/设置类模块清单：`renderer-codebase-panel.js`、`renderer-graph-panel.js`、`renderer-help.js`、`renderer-mermaid.js`、`renderer-model-settings.js`、`renderer-playbook.js`、`renderer-plugin-settings.js`、`renderer-settings-shell.js`、`renderer-side-panel.js`、`renderer-theme-bootstrap.js`、`renderer-theme.js`、`renderer-wiki-generate.js`、`renderer-wiki-panel.js`、`renderer-worktrees-settings.js`，另加 `src/model-settings.js`、`src/main/ipc/settings.js`。

### 5.4 关于提到的"原神机制 / 上帝视角 / 笔墨纸砚"

**本仓库 grep（中文 + 英文 `genshin|godsview|brush|ink|mascot|achievement|gamif`）均无命中**；无宠物、无成就、无游戏机制代码。装饰仅限 `theme.js` / `styles.css` 的主题与 Mermaid 渲染。故该部分前提与仓库不符，本报告不作展开、不编造。

### 5.5 对"稳定性与维护成本"的实际影响

把问题 5 的问法换成事实成立的版本：

- 外围功能（76% 代码量、109 个 UI 文件、30+ 浏览器工具、独立移动端 App、SSH/Wiki/图谱/插件/MCP 多套面板）**全部依赖"Agent 产出 → 应用回工作区"这一条 955 行、零测试、失败即丢数据的链路**；
- 于是**每加一个外围功能，都在扩大受那条链路风险影响的面积**，而链路本身的缺陷密度不因外围增长而降低；
- 维护成本的真正损耗点不是"功能多"，而是**没有一条可信的产出闭环**：用户的工作成果可能被 `copyFileSync` 覆盖、被自动清理策略删除、被不完整的 baseline 撤回。在这之上加功能 = 在无地基的结构上调楼层。

---

## 6. 修复优先级清单

### P0 — 数据丢失级（先于一切外围开发）

1. `worktree-service.js:510-533` 在 apply 前**必须读取并使用 `mainDirty`**；引入备份（copy 到 `.dieyun/backup/<ts>/`）或三方合并，禁止裸 `copyFileSync` 覆盖。
2. `enforceWorktreeCleanupPolicy`（`:262-280`）**禁止对未提交 run 自动 force 清理**；改为提示 + 人工确认；补 `git branch -D` 分支回收（`:128-155`）。
3. `agent_runs.state_snapshot` 纳入修剪范围；为 memory DB 设 `PRAGMA auto_vacuum=INCREMENTAL` 并周期 `PRAGMA incremental_vacuum`。

### P1 — 硬件寿命 / 性能

4. `terminal-log.js` 补大小上限 + 轮转（复用 `gateway-file-log.js` 的 2MB 逻辑），`plans-logs` 同理。
5. trace checkpoint 增量化：只追加新增 trace 条目与 `streamContent` 增量，而非每 2.5s 全量深拷贝 + 三份重复序列化（`trace-store.js:134-143`、`memory/agent.rs:125-160`）。
6. SQLite：补 `synchronous=NORMAL` + `wal_autocheckpoint` + `cache_size`；`IndexService` / `GraphService` 改**持有常驻连接**（消除 18 处 `self.open()`），面板轮询改推送。
7. `gateway-file-log.js` 改异步批写或落盘前按行数合并，去掉逐行 `statSync`（`:20-30`）。

### P2 — 产品与成本风险

8. 能力边界写入 system prompt（`agent-system-prompt.js:17-41`）+ 对"我能生成 X"类输出做拦截；UI 把「全模态」改回「图片输入」；MiniMax 技能文案标注"外部 CLI 依赖，与所选模型无关"。
9. 全局记忆加 workspace 作用域（`system-prompt-prep.js:401-443`）；subagent 的 stable 前缀瘦身为子集（`renderer-agent-send.js:699`）；工具 schema 按需裁剪（`loop_run.rs:719-722`）。
10. 清洗 `SKILLS_TAXONOMY` 中无对应技能的死关键词（`renderer-skills-grid.js:102-103`）。

---

## 7. 审计方法与局限

- 方法：静态源码审计 + 3 个并行子审计（能力校验 / 上下文记忆 / Git 与功能面）；所有结论附 `file:line`。
- 局限：
  1. **未做运行时压测** —— 第 1.3 节的 MB 级写入量是按代码路径推导的量级估计，未实测 fsync 次数与 MB/s；
  2. 未覆盖构建产物与第三方代码（`node_modules`/`dist`/`deploy`/`target`）；
  3. 用户转述中的三条（"缓存只有 1G"、"Role Play 论"、"原神机制/上帝视角/笔墨纸砚"）**在仓库中找不到对应代码或文档**，已在正文单独标注，未据此下结论；
  4. "发热/卡顿"的因果归因（定时器轮询 + checkpoint fsync）是基于代码结构的推断，未经采样式性能剖析验证。

# runtime 审计

> **2026-11-17 P0 已修**：F1（dylib 加载失败被 `OnceLock` 永久缓存 → 只缓存成功，语义抽成可测的 `ensure_runtime_cached`，用例 `runtime_failure_is_not_cached_but_success_is`）。F2–F11 仍开。

范围（13 个文件全读）：`compaction/{fold,tokens,mod}.rs`、`embedding/{mod,local,remote}.rs`、`config.rs`、`error.rs`、`blocking.rs`、`sqlite.rs`、`fs_ops.rs`、`main.rs`、`lib.rs`。
为求证契约另读了调用方：`rpc/stdio.rs`、`rpc/mod.rs`、`agent/loop_run.rs`、`agent/llm.rs`、`index/mod.rs`、`graph/mod.rs`，以及 Node 侧 `src/core-bridge.js`、`src/core-rpc-timeouts.js`、`src/agent/compaction-main.js`、`src/agent/embedding-config.js`、`src/agent/llm-request.js`、`src/gateway/server.js`、`src/gateway/handlers/fs.js`。

## 度量

- 行数：3560（含 `#[cfg(test)]` 约 1070 行；非测试约 2490 行）
  - sqlite.rs 888、fold.rs 602、local.rs 558、embedding/mod.rs 548、config.rs 205、remote.rs 190、tokens.rs 180、main.rs 118、fs_ops.rs 110、error.rs 54、lib.rs 40、compaction/mod.rs 34、blocking.rs 33
- 一个文件混了几种职责（只列 >2 的）：
  - `sqlite.rs`：①PRAGMA 调优（tune_with）②常驻写连接生命周期 ③池化读连接 + Condvar 排队 ④独立连接（第三种打开方式）⑤「带未提交事务」兜底回滚。**四种连接姿势共存于一个类型**，选哪一种只靠注释。
  - `config.rs`：①读上限常量 ②配置结构 + 环境变量默认值 ③配置应用（含建目录）④路径归一化 / 白名单 / 工作区哈希 ⑤**出站 HTTP 请求头装配**（`apply_llm_headers`，传输层语义混进配置模块）⑥读参数归一化。
  - `embedding/mod.rs`：①后端判定 `plan` ②签名 ③缓存键 ④批规划 ⑤并发扇出 ⑥纯向量数学（`cosine_similarity` / blob 互转）⑦召回阈值。
  - `embedding/local.rs`：①可用性探测 ②动态库加载（进程级 OnceLock）③ONNX Session 池 ④分词 + 张量拼装 ⑤CLS 池化 + L2 归一化 ⑥模型实例缓存。
  - `embedding/remote.rs`：①URL 推导 ②请求体方言分支 ③超时口径常量 ④响应解析（4 种形状）⑤错误体截断。
  - `fold.rs`：①触发判定 ②档位循环 ③文本裁剪 ④数组形状收敛成字符串 ⑤图片摘除 ⑥折叠标记的编码与解码（写/读各一处）。
  - `main.rs`：①CLI 定义 ②配置装载（三处重复）③index/search 服务装配。
- 同一份知识有两份实现：
  - token 折算系数 `1.5 / 3.2`：`compaction/tokens.rs:69` ↔ `src/agent/agent-limits.js:243`
  - 图片等效 token `1875`（=6000/3.2）：`compaction/tokens.rs:26` ↔ `src/agent/agent-limits.js:217`
  - 预算地板：`compaction/fold.rs:76`（4096）↔ `src/agent/model-runtime-by-tier.js:301,293`（8192）——**同用途、不同值**
  - 触发比夹取范围：`compaction/fold.rs:99` `clamp(0.3, 0.95)` ↔ `src/agent/compaction-main.js:100` `Math.min(0.95, Math.max(0.3, r))`
  - 读参数归一化：`config.rs:197-205` ↔ `src/gateway/fs-read-limits.js:8-16`（连 2MB/16MB 两个上限都各写一份）
  - 超时口径：`rpc/mod.rs:40` `FAST_METHOD_BUDGET_MS=20_000` ↔ `src/core-rpc-timeouts.js:58` `15000`（**不同值**，见 F8）
  - 向量后端「有没有通道」：`embedding/mod.rs:117-119` `enabled()` ↔ `src/agent/embedding-config.js:144-148`（后者自陈「粗判」，属显式分工，仅记录）
  - `embedding/remote.rs:8-29` 自己推导 `/v1/embeddings` 与「direct `/embed`」两种端点，而全仓约定「端点拼接只在 Node」（AGENTS.md「LLM 端点拼接 / 请求头」行）；embedding 侧没有对应 Node 实现，所以目前是唯一一份，但它是同一类知识在 Rust 里又落了一次。

## 发现

### F1 本地向量运行时加载失败被进程级 OnceLock 永久缓存：宿主补装完仍报不可用
- 类型：live-bug
- 严重度：high
- 位置：`crates/dieyun-core/src/embedding/local.rs:124-140`（判定入口 `probe`，见 `local.rs:98-116`；被 `embedding/mod.rs:135-149,165-202` 反复调用）
- 证据：
  ```rust
  fn ensure_runtime(dylib: Option<&Path>) -> Result<(), String> {
      static LOADED: OnceLock<Result<(), String>> = OnceLock::new();
      let dylib = dylib.map(Path::to_path_buf);
      LOADED
          .get_or_init(|| match dylib {
              Some(path) if path.is_file() => init_from(&path),
              Some(path) => Err(format!("指定的 onnxruntime 不存在：{}", path.display())),
              None => match scan_for_runtime() {
                  Some(path) => init_from(&path),
                  None => Err(format!("未找到 onnxruntime 动态库（{}）…", super::runtime_lib_name())),
              },
          })
          .clone()
  }
  ```
  以及判定只按「文件在不在 + 库能不能加载」：
  ```rust
  // local.rs:104-112
  if onnx_path(dir).is_none() { return Availability::Unavailable(...) }
  if !dir.join("tokenizer.json").is_file() { return Availability::Unavailable(...) }
  if let Err(err) = ensure_runtime(dylib) { return Availability::Unavailable(format!("onnxruntime 动态库不可用：{err}")) }
  ```
- 触发：core 是长命 sidecar。首次 `core.configure` / `embedding.status` 时模型或 dylib **还不在**（安装包刻意不打包，`docs/LOCAL-EMBEDDING.md:53-68` 就是「可选下载的落点」），于是 `LOADED` 缓存了 `Err(..)`；用户随后把 `onnxruntime.dll` / `bge-base-zh-v1.5` 放进 `<userData>/models`，Node 下一次 `core.configure` 会带上新的 `localModelDir` / `localRuntimeLib`（`src/agent/embedding-config.js:115-132`），`probe` 依然返回 `Unavailable`，`provider="auto"` 静默留在远端、`provider="local"` 一直 `Disabled("已选择本地推理但不可用…")`。**必须重启整个 core 进程才恢复**，而设置页只会显示「onnxruntime 动态库不可用」。同一缺陷还有第二个面：缓存键里没有 `dylib` 路径，先成功加载 A 路径后再配置 B 路径也永远用 A。
- 修法方向：把「可加载性结论」降级成一次尝试，别把它固化成永不刷新的进程级状态——缓存只缓存**成功**的 handle（`OnceLock<Result<...>>` 换成 `Mutex<Option<(PathBuf, ())>>`，失败不入缓存）；或把 `dylib` 路径纳入键，变化即重试。
- 怎么确认：`cargo test -p dieyun-core --lib embedding::local`（现有用例只在启动前就绪时跑）；最小复现：起 core → 调 `embedding.status`（人为让 `<userData>/models/onnxruntime/` 为空）→ 放入 dll → 再调 `core.configure` + `embedding.status`，`localReady` 仍为 `false`。
- 置信度：high

### F2 token 估值漏掉 `reasoning_content`，而折叠报告拿「服务端 usage」和「本地估值」两个口径直接相减
- 类型：live-bug
- 严重度：high
- 位置：`crates/dieyun-core/src/compaction/tokens.rs:72-78`；口径混用在 `compaction/fold.rs:93-97,163-175`
- 证据：
  ```rust
  // tokens.rs:72-78 —— 只数 content
  pub fn estimate_messages_tokens(messages: &[Value]) -> usize {
      messages.iter()
          .map(|m| m.get("content").map_or(0, estimate_tokens) + 6)
          .sum()
  }
  ```
  而 core 自己把思考塞进同一条上行消息（`agent/loop_run.rs:605-609`）：
  ```rust
  // 思考模式（DeepSeek V4 等）：带 tool_calls 的 assistant 消息必须原样回传
  // reasoning_content，否则下一轮请求会被上游以 HTTP 400 拒绝。
  if let Some(reasoning) = llm.reasoning.as_deref().filter(|s| !s.trim().is_empty()) {
      assistant_msg["reasoning_content"] = json!(reasoning);
  }
  ```
  发出去的 body 就是这本账（`loop_run.rs:808-812` `"messages": state.messages`），折叠也作用在同一份（`loop_run.rs:355-360`）。
  两个口径直接相减：
  ```rust
  // fold.rs:94-97
  let (used, trigger_source) = match params.observed_prompt_tokens {
      Some(n) if n > 0 => (n, "usage"),
      _ => (estimated, "estimate"),
  };
  // fold.rs:163-169
  let after = estimate_messages_tokens(&messages);
  FoldResult { tokens_before: used, tokens_after: after, … }
  ```
- 触发：①任何带工具调用的推理模型 run——每轮 assistant 消息都挂 `reasoning_content`，估值把它们全部算成 0；②更常见的是触发口径本身：`llm.rs:333-338` 只往 body 里塞 `stream`，**从不设置 `stream_options.include_usage`**，流式响应普遍不带 `usage`，于是 `observed_prompt_tokens` 长期为 `None`（`loop_run.rs:524-531`），折叠完全靠漏算的估值决定压不压。后果：真实 prompt 已经越过触发线而估值没到 → 不折 → 上游 400/截断；`tokens_before - tokens_after`（进遥测与 UI，`compaction-main.js:185-196`）是同一条消息「usage 减去漏算估值」的差额，系统性虚报节省量。`fold_force`（宿主溢出后强制折一次，`loop_run.rs:346-348`）对思考体积无解，重试仍是同一个超预算 body。
- 修法方向：`estimate_messages_tokens` 把 `reasoning_content`（以及 `content` 为数组时的 reasoning part）计入；`tokens_after` 与 `tokens_before` 必须同口径（要么都估、要么在 `trigger_source == "usage"` 时明确标注 `tokens_after` 是估算），否则不要相减。
- 怎么确认：给 `tokens.rs` 加用例——`[{"role":"assistant","content":"hi","reasoning_content":"x".repeat(3000)}]` 的估值应远大于 `[{"role":"assistant","content":"hi"}]`（当前两者相等）；或 `cargo test -p dieyun-core --lib compaction::tokens`。
- 置信度：high

### F3 折叠幂等靠「全文搜 `fold:L`」，工具输出里出现这串字就永远不再折叠
- 类型：latent-bug
- 严重度：medium
- 位置：`crates/dieyun-core/src/compaction/fold.rs:327-335`（判据使用点 `fold.rs:226,261`）
- 证据：
  ```rust
  /// 从文本里读出「已折叠到第几档」；没有折叠标记时为 `None`。
  fn applied_level(text: &str) -> Option<u8> {
      let at = text.find(LEVEL_TAG)?;          // LEVEL_TAG = "fold:L"
      let digits: String = text[at + LEVEL_TAG.len()..]
          .chars().take_while(|c| c.is_ascii_digit()).collect();
      digits.parse().ok()
  }
  ```
  ```rust
  // fold.rs:260-268 —— 只要 ≥ 当前档就直接跳过
  fn clip_text(text: &mut String, …) -> bool {
      if applied_level(text).is_some_and(|l| l >= level) { return false; }
  ```
- 触发：可折区里任何一条消息的正文中**恰好包含** `fold:L<数字>`——最典型的来源就是本仓自己：模型读过 `crates/dieyun-core/src/compaction/fold.rs`、`docs/CONTEXT-FOLD.md`、或任何一份引用了折叠标记的日志/审计报告，那条 tool 结果就会被判成「已折到 L3」，从此既不再被裁剪也不会推进档位。同类输入还有 `…fold:L2024…`、崩溃堆栈、CI 日志。由于折叠是唯一的压缩机制（LLM 摘要已整体删除），这条消息会永久留在上下文里，估值只增不减。
- 修法方向：判据不要「全文 find」，改成只认**自己写出的完整标记形状**（`FOLD_MARK` + 空格 + 数字 + `字符 fold:L<n>`，或把档位写进消息的结构化字段如 `"_foldLevel"`），并且优先用结构化字段（把知识从「正文里埋字符串」搬到数据上）。
- 怎么确认：`cargo test -p dieyun-core --lib compaction`，新增用例：`fold` 一条 `content = "文档里写着 fold:L9 这一档……" + "x".repeat(5000)` 的 tool 消息，断言它仍被折叠（当前断言会失败）。
- 置信度：high

### F4 `apply_configure` 非原子：一个工作区路径解析失败，整份 llm / embedding 配置静默不生效；`main.rs` 还把这个错误 `.ok()` 掉
- 类型：latent-bug
- 严重度：medium
- 位置：`crates/dieyun-core/src/config.rs:96-117`；`crates/dieyun-core/src/main.rs:56-107`；后果放大点 `config.rs:119-133`
- 证据：
  ```rust
  // config.rs:96-111 —— 前面几项已改，workspace_roots 失败即整体早退
  if let Some(dir) = &params.data_dir { self.data_dir = PathBuf::from(dir); }
  if !params.workspace_roots.is_empty() {
      self.workspace_roots = params.workspace_roots.iter()
          .map(|p| normalize_path(Path::new(p)))       // canonicalize：路径必须已存在
          .collect::<anyhow::Result<Vec<_>>>()?;        // ← 一个失败 → 整个 configure 失败
  }
  self.embedding = params.embedding.clone();            // ← 这两行再也不会执行
  self.llm = params.llm.clone();
  ```
  ```rust
  // config.rs:119-123 —— 白名单为空时直接放行一切
  pub fn assert_allowed_path(&self, input: &Path) -> Result<PathBuf, CoreError> {
      let resolved = normalize_path(input)?;
      if self.workspace_roots.is_empty() { return Ok(resolved); }
  ```
  ```rust
  // main.rs:58-68（三处同样写法：66 / 84 / 107）
  config.apply_configure(&…).ok();      // 错误被丢掉，随后照常 create_dir_all + serve
  ```
- 触发：`src/gateway/server.js:314-334` 每轮配置同步把 `data_dir + workspace_roots + embedding + llm` 一起推。只要 `workspace_roots` 里有一个路径在 canonicalize 那一刻不可解析（刚被删/被重命名的工作区目录、拔掉的移动盘、断开的网络盘、SSH 会话的远端路径），整个 `core.configure` 就失败：`embedding` 与 `llm` 停在旧值（首次则停在 `default()` 的空 base_url），Node 只打一行 `rust core configure: 无法解析路径…`。这条已被 Node 侧打过一次补丁（`server.js:469-470` 注释自陈「不存在的目录必须剔除，否则 Rust configure 因 canonicalize 失败而整体不生效」，且只过滤了这一个调用点）。而 `main.rs` 的三个子命令直接 `.ok()`：`ServeStdio --workspace <不存在>` 时 `workspace_roots` 保持空 → `assert_allowed_path` 对任意路径放行（fail-open），白名单静默失效。
- 修法方向：`apply_configure` 先全量解析（`Vec<PathBuf>` 备好）再一次性落库，任一项失败就整份拒绝并返回明确错误（不要半套生效）；工作区根里不可解析的那几条应当**逐条剔除并回传剔除名单**，而不是拖垮 embedding/llm。`main.rs` 的 `.ok()` 删掉——CLI 传了 `--workspace` 而解析失败时必须退出报错，否则等于关掉白名单。
- 怎么确认：`cargo test -p dieyun-core --lib config`；最小复现：`core.configure` 传 `{data_dir, workspace_roots:["E:\\不存在的目录"], llm:{baseUrl:"http://x", headers:{…}}}` → 返回错误，且随后 `embedding.status` / 一次不带 `llm` 的 `agent.run.start` 仍用旧/空 llm（`rpc/mod.rs:1416-1422` 的兜底会拿到空 `base_url`）。
- 置信度：high

### F5 远端向量 120s 超时同样吃在**交互查询**上，而两处注释引用的 `INTERACTIVE_EMBED_BUDGET_MS` 已被整体删除
- 类型：latent-bug（口径漂移 + 死常量）
- 严重度：medium
- 位置：`crates/dieyun-core/src/embedding/remote.rs:31-39`；唯一调用点 `embedding/mod.rs:299-319`；消费方 `rpc/mod.rs:976-992`
- 证据：
  ```rust
  // remote.rs:31-39
  /// 后台 embedding 请求的墙钟上限（建库 / 归纳写入 / 手工重建向量都等得起）。
  ///
  /// **交互式查询不用这个数**：它必须受 `INTERACTIVE_EMBED_BUDGET_MS` 约束，否则端点挂死时
  /// 每轮召回要等满 120s（真机现场：`memory.long_recall` 连续两次 120008ms 超时）。
  pub const EMBED_REQUEST_TIMEOUT_MS: u64 = 120_000;
  /// …调用方据此判定「端点没回」而不是「端点报错」，交互闸门也只在超时（有证据证明它慢）时关闸，401 / 解析失败不关。
  pub const EMBEDDING_TIMEOUT_CODE: &str = "EMBEDDING_TIMEOUT";
  ```
  ```rust
  // embedding/mod.rs:314-316 —— 所有路径共用这一个超时，没有第二条交互通道
  Provider::Remote => {
      remote::embed_remote(cfg, &prepared, remote::EMBED_REQUEST_TIMEOUT_MS).await
  }
  ```
  ```rust
  // embedding/mod.rs:11-16 自陈整层删除
  //! 「预判太慢就不发」。本地推理是毫秒级、无网络，这三层的根因消失，于是整体删除
  ```
- 触发：远端后端（`provider="remote"`，或 `auto` 且本地不可用——见 F1，F1 会让本该走本地的机器长期停在远端）时，`embedding.query`（`rpc/mod.rs:976-992`）→ `embed_texts` → 120s 墙钟。而 `embedding.query` 正是召回关键路径：`memory.long_recall` 每轮系统提示前都会问一次。端点变慢（反代 502 挂住、DNS 黑洞）时表现为「每轮对话先卡 120s」，正是注释里引用的那次事故形状；`rpc/mod.rs` 对 `memory.long_recall` 也不设任何在途预算（`request_budget_ms` 只覆盖 `*.status`/`ping`/`cancel`）。另外 `EMBEDDING_TIMEOUT_CODE` 全仓**只有生产者没有消费者**（Node 侧无 `EMBEDDING_TIMEOUT` 分支），相关说明还留在 `docs/VECTOR-SEARCH.md:170`、`docs/HARNESS-INVENTORY.md:104`（写着 `embed_texts_interactive` / `INTERACTIVE_EMBED_BUDGET_MS=10_000` 等已不存在的符号）。
- 修法方向：把「查询」与「后台建库」的超时拆成两个显式参数（`embed_texts(cfg, inputs, budget)`，查询传小值、建库传 120s），并把 `remote.rs` 里引用了已删机制的注释与死常量（`EMBEDDING_TIMEOUT_CODE` 没有消费方就删掉）一起清掉——注释指向不存在的代码比没注释更危险。
- 怎么确认：`grep -rn "EMBEDDING_TIMEOUT" src/`（0 命中，只有 Rust 生产端）；最小复现：把 embedding `baseUrl` 指向一个只接受连接不回包的端口，调 `memory.long_recall`，测到 ~120s 才返回。
- 置信度：high

### F6 远端向量回包 `index` 解析可让向量静默对应到错误的输入文本
- 类型：latent-bug
- 严重度：medium
- 位置：`crates/dieyun-core/src/embedding/remote.rs:142-154`；位置配对的消费点 `embedding/mod.rs:359-379`
- 证据：
  ```rust
  let mut parsed: Vec<(u32, Vec<f32>)> = Vec::new();
  for row in rows {
      let item: EmbedRow = serde_json::from_value(row.clone())…?;
      if let Some(vec) = item.embedding {
          parsed.push((item.index.unwrap_or(parsed.len() as u32), to_f32_vec(vec)?));
      }
  }
  parsed.sort_by_key(|(idx, _)| *idx);          // ← 只按 index 排
  return Ok(parsed.into_iter().map(|(_, v)| v).collect());
  ```
  ```rust
  // embedding/mod.rs:374-378 —— 只校验条数，按位置 zip 回 id
  Ok(batch.into_iter().map(|(id, _)| id).zip(vectors).collect())
  ```
- 触发：端点返回的 `data[]` 里**部分行带 `index`、部分行不带**（有的网关只在部分分支回填），此时缺省值 `parsed.len()` 会与已存在的显式 index 撞车或错位；`index` 从 1 开始、或在去重/丢弃后重排的端点同样错位。因为 `embed_batch` 只比较 `vectors.len() == batch.len()`（`mod.rs:368-373`），条数一致就**不报错**，于是 chunk A 落库时拿到的是 chunk B 的向量——相似度不会崩，只是检索永久错位（属于「不报错、只让相似度悄悄变差」里最坏的一种，`MIN_SIMILARITY` 还会帮忙把真命中过滤掉）。
- 修法方向：只在**全部**行都带 `index` 且这些 index 恰好是 `0..n` 的一个排列时才按 index 重排，否则按到达顺序用；`index` 越界/重复一律报 `EMBEDDING_PARSE`，别静默接受。
- 怎么确认：`cargo test -p dieyun-core --lib embedding`，新增：`{"data":[{"index":2,"embedding":[1.0]},{"embedding":[0.0]}]}` 应报错或不重排（当前会排成 `[[0.0],[1.0]]`，即两条向量互换了）。
- 置信度：medium

### F7 SQLite 有四个访问面却只有注释做护栏：`open_dedicated` 自陈「不占常驻锁」但实现先抢常驻锁，读并发上限只挡住一条路
- 类型：structural-debt
- 严重度：high
- 位置：`crates/dieyun-core/src/sqlite.rs:32-38`（`READ_POOL_CAP`）、`299-352`（`read`/`read_conn`）、`384-387`（`open_dedicated`）、`242-262`（`try_with_conn`）
- 证据：
  ```rust
  // sqlite.rs:384-387
  /// 开一条**独立**连接，不占用常驻锁（建表仍由常驻连接一次性完成）。
  pub fn open_dedicated(&self) -> Result<Connection, CoreError> {
      self.with_conn(|_| Ok(()))?;                 // ← 先抢常驻写锁
      open_tuned_with(&self.path, self.opts)
  }
  ```
  ```rust
  // sqlite.rs:231-240（with_conn 的约束只写在注释里）
  /// - `f` 内不得再调 `with_conn`，否则自锁。
  pub fn with_conn<T>(&self, f: …) -> Result<T, CoreError> {
      let mut guard = self.conn.lock().unwrap_or_else(|e| e.into_inner());
  ```
  ```rust
  // sqlite.rs:32-38 —— 上限只对 read 池生效
  pub const READ_POOL_CAP: usize = 4;
  ```
- 触发/漂移后果：①`open_dedicated` 与「不占常驻锁」相反，任何一条长 `with_conn` 写（大 trace / snapshot 落库）都会把所有「独立」开连接的动作排住——这正是文档声称已解决的那类堵点；②真正的并发上限只有 `read_conn`（4 条），而 `open_dedicated` **没有上限**，且它被状态读路径**每次轮询**调用一次（`index/mod.rs:417-421` `apply_status_repair` → `open_dedicated()` + `busy_timeout(0)`，`graph/mod.rs:88,167` 同款）——UI 每秒轮询 status，修不掉的脏旗标期间就等于每秒 open+drop 一条连接并重跑一遍 `tune`（含 `journal_mode/cache_size/auto_vacuum` 探测）；③`with_conn` 的非重入约束无编译期保障，一旦有人在闭包里调 `status()`/`open_dedicated()` 就自锁（`index/mod.rs:438-442`、`graph/mod.rs:58-61` 都只能靠注释警告）；`try_with_conn` 又给同一件事加了第四种语义（拿不到就放弃），调用方要自己判断「这次写丢了是否安全」。
- 修法方向：减法优先——把 `open_dedicated` 的语义与文档对齐（要么真的不碰常驻锁：用 `initialized` 原子位短路，与 `read_conn` 同款；要么删掉它，让长任务也走读池/写队列）；`apply_status_repair` 这类 best-effort 写不该每次轮询开连接（改为同一连接复用 + 进程内退避），否则「读池上限」只是把并发从一个面挪到另一个面。
- 怎么确认：`cargo test -p dieyun-core --lib sqlite`（现有 `read_pool_caps_concurrent_readers` 只测读池）；新增/手工：让一个 `with_conn` 持锁 400ms，同时调 `open_dedicated()`，测量耗时——当前会等满 400ms，与 `read_does_not_wait_on_resident_lock_holder` 的承诺正好相反。
- 置信度：high

### F8 `*.status` 的 core 侧在途预算（20s）比宿主侧超时（15s）还长：`RPC_TIMEOUT` 永远发不出去，而底层阻塞任务停不下来
- 类型：structural-debt
- 严重度：medium
- 位置：`crates/dieyun-core/src/rpc/mod.rs:31-59` + `crates/dieyun-core/src/rpc/stdio.rs:117-133`；对照 `src/core-rpc-timeouts.js:56-58`；桥接层 `crates/dieyun-core/src/blocking.rs:25-33`
- 证据：
  ```rust
  // rpc/mod.rs:38-40
  /// 长任务（建库 / 检索 / 压缩）刻意不设预算：…掐断 awaiter 也停不下底下已经跑起来的阻塞任务…
  pub const FAST_METHOD_BUDGET_MS: u64 = 20_000;
  // rpc/mod.rs:55-57
  if method.ends_with(".status") { return Some(FAST_METHOD_BUDGET_MS); }
  ```
  ```js
  // src/core-rpc-timeouts.js:57-58
  // status 是纯读库，健康库上应毫秒级返回；15s 只会在真卡住时把调用拖成「假死」。
  if (m === 'codebase.status' || m === 'graph.status') return 15000;
  ```
  ```rust
  // blocking.rs:25-33 —— 唯一的同步桥，无上限无超时
  pub async fn run_blocking<T, F>(f: F) -> Result<T, CoreError> {
      tokio::task::spawn_blocking(f).await.map_err(|e| CoreError::rpc("BLOCKING_JOIN_FAILED", e.to_string()))?
  }
  ```
- 触发/漂移后果：宿主 15s 先放弃（它不会得到 core 的 `RPC_TIMEOUT {method}`，只能看到通用 `RPC_TIMEOUT codebase.status id=…`），core 那条读还在阻塞池里跑；宿主重试把**同一条慢查询**再塞一个进池，池里没有上限也没有取消（`spawn_blocking` 无法中断），于是「重试 → 队列更长 → 更慢」自我放大。`rpc/mod.rs:35` 的注释还写着「比让宿主客户端 45s 后才超时」，45s 这个口径早已不存在（现在是 15s / 120s / 600s 三档，见 `core-rpc-timeouts.js`）。同一处 `let _ = serde_json::to_string(&response)`（`stdio.rs:85`）在序列化失败时直接丢响应，宿主只能等超时——没有 `type:"event"` 之外任何可观测信号。
- 修法方向：core 侧预算必须**严格小于**宿主侧（例如 status 用 10s），否则这个机制只是噪音；两个数字放在同一张表里成对改（跨语言至少加一条 `npm run test:unit` 断言读取 Rust 常量或注释化对照）。`run_blocking` 至少要能上报「在途多少个阻塞任务」，让 `[rpc-slow]` 能区分「排队」与「真慢」。
- 怎么确认：`cargo test -p dieyun-core --lib rpc::tests::budget_covers_polling_methods_only`（只钉分类不钉数值）；最小复现：用一条 `with_conn` 持锁 25s 的窗口内轮询 `codebase.status`，宿主在 15s 先报 `RPC_TIMEOUT`，core 侧 20s 的 `RPC_TIMEOUT` 永不出现在响应里。
- 置信度：high

### F9 「同一份数值」在 Rust / Node 各存一份，且已经出现不一致（预算地板 4096 vs 8192）
- 类型：structural-debt
- 严重度：medium
- 位置：`compaction/tokens.rs:22-26,59-70`；`compaction/fold.rs:67,73,76,99`；对照 `src/agent/agent-limits.js:217,243`、`src/agent/model-runtime-by-tier.js:293,301,313-318`、`src/agent/compaction-main.js:98-102`
- 证据：
  ```rust
  // fold.rs:75-76
  /// 预算地板：低于它的预算无意义（调用方给错也不至于把上下文折成空）。
  const MIN_BUDGET_TOKENS: usize = 4096;
  ```
  ```js
  // src/agent/model-runtime-by-tier.js:293,301
  const CONTEXT_WINDOW_FLOOR = 8192;
  const MIN_INPUT_BUDGET_TOKENS = CONTEXT_WINDOW_FLOOR;
  ```
  ```rust
  // fold.rs:98-99
  let budget = params.token_budget.max(MIN_BUDGET_TOKENS);
  let trigger = (budget as f64 * params.trigger_ratio.clamp(0.3, 0.95)) as usize;
  ```
  ```js
  // src/agent/compaction-main.js:98-102
  const r = Number(settings.compactionTriggerRatio);
  if (Number.isFinite(r) && r > 0) return Math.min(0.95, Math.max(0.3, r));
  ```
  同类还有：`tokens.rs:26` `IMAGE_PART_EQUIV_TOKENS = 1875`（自陈「折算系数的唯一来源是 JS 侧 `agent-limits.js` 的 `visionPartEqChars` ÷ `charsPerToken`」）、`tokens.rs:69` 的 `1.5 / 3.2`、`config.rs:6-7` 的 `2MB / 16MB` 与 `src/gateway/fs-read-limits.js:9-15`、`config.rs:197-205` 与同文件 `normalizeReadParams` 的逐行等价实现。
- 漂移后果：Node 把预算地板/折算系数/夹取范围调大或调紧时，Rust 静默用旧值夹回去——表现为「设置里改了触发比，行为没变」（被 `clamp` 吃掉）或「UI 圆环的 token 数与真实计费差一个系数」。`4096` 与 `8192` 这对已经不一致了（目前无害，只因为 Node 永远不会送 <8192 的预算；一旦某个小窗口档降到 4096~8192 之间，两边对「地板」的理解立刻不同）。这类「注释里写着与 X 同值」的复制是 AGENTS.md「单一来源」原则的正面违反。
- 修法方向：把数值类知识做成**唯一数据源**：`test/fixtures/` 里放一份（`tokens.rs:87` 已经在用 `token-estimate-cases.json` 这个正确姿势做公式基线），地板/系数/夹取范围也从这份 fixture 读；或让 Node 在 `compaction.fold` 入参里显式传地板（它本来就该决定预算口径），Rust 侧删掉 `MIN_BUDGET_TOKENS` 与 `clamp`。
- 怎么确认：`npx vitest run test/unit/compaction-telemetry.test.cjs` + `cargo test -p dieyun-core --lib compaction`；把 `agent-limits.charsPerToken` 改成 4.0 后只跑 Node 测试——全绿，说明两侧根本不会被一起验证。
- 置信度：high

### F10 分块读按**字节**切、`from_utf8_lossy` 兜底：中文字符会被切成 U+FFFD，而 `offset/truncated` 又是字节口径
- 类型：latent-bug
- 严重度：medium
- 位置：`crates/dieyun-core/src/fs_ops.rs:41-70`（口径定义 `config.rs:197-205`）
- 证据：
  ```rust
  let (offset, max_bytes) = normalize_read_params(offset, max_bytes);
  let read_len = max_bytes.min(size.saturating_sub(offset));
  …
  let mut buf = vec![0u8; read_len as usize];
  let bytes_read = file.read(&mut buf)…?;
  buf.truncate(bytes_read);
  let truncated = offset + (bytes_read as u64) < size;
  let data = if enc == "base64" { … } else { String::from_utf8_lossy(&buf).into_owned() };
  ```
- 触发：模型用 `fs_read_file` 分块读中文/emoji 文件（`maxBytes` 正好落在多字节字符中间，例如 UTF-8 中文每 3 字节、`maxBytes=2*1024*1024` 时概率 ~2/3 命中边界；小分块如 1000 字节时几乎必然命中）。切点处的字符被替换成 `\u{FFFD}`，工具结果里出现 `�`，模型会把它当成文件真实内容（进而「修复」一处并不存在的乱码，或在 diff 里引入替换字符）。同时 `offset` 与 `truncated` 都是字节口径，而返回值 `data` 是字符口径——任何按 `data.length` 推进 offset 的续读调用方都会错位（`src/gateway/handlers/fs.js:315-324` 直接透传 Rust 结果，没有对齐到字符边界）。
- 修法方向：切点对齐到 UTF-8 字符边界（`buf` 末尾回溯到 `0b10xxxxxx` 之后，或 `str::from_utf8` 失败时用 `Utf8Error::valid_up_to()` 截断并把它算进 `truncated`），并在返回结构里显式声明 `offset` 单位是字节（base64 与 utf8 两条分支共用同一个 `offset` 语义，必须写清楚）。
- 怎么确认：`cargo test -p dieyun-core --lib fs_ops`；最小复现：对一个纯中文文件调用 `fs.read_file {offset:0, maxBytes:4}`（"中" 是 3 字节 + 1 字节残留）——当前 `data` 结尾必然是 `\u{FFFD}`。
- 置信度：high

### F11 `compaction.estimate` 对形状错误的入参返回 `{tokens: 0}`，UI 上下文圆环会显示「空上下文」
- 类型：live-bug
- 严重度：low
- 位置：`crates/dieyun-core/src/compaction/mod.rs:27-33`
- 证据：
  ```rust
  pub fn estimate(params: &Value) -> Value {
      let messages = params
          .get("messages")
          .and_then(|v| v.as_array())
          .cloned()
          .unwrap_or_default();          // ← 缺失 / 形状不对 → 空数组
      json!({ "tokens": estimate_messages_tokens(&messages) })
  }
  ```
- 触发：调用方传 `messages` 为 null / 字符串 / 对象（Node 侧透传前做了投影的路径、或 Renderer 传了 `null` 表示「还没加载」）。`tokens: 0` 与真实「空上下文」不可区分，圆环显示 0、任何「接近上限才提醒」的 UI 判断都不触发；而同文件的 `compaction.fold` 对同一类错误会硬报 `INVALID_PARAMS`（`rpc/mod.rs:521-525`）——同一个参数、两套容错口径。
- 修法方向：`messages` 缺失或非数组时返回 `INVALID_PARAMS` 错误（与 `fold` 一致），或至少返回 `{ tokens: null }` 让前端显式区分「算不出来」与「0」。
- 怎么确认：`cargo test -p dieyun-core --lib compaction`；Node smoke：`bridge.invoke('compaction.estimate', { messages: null })` 当前返回 `{tokens:0}` 而不是报错。
- 置信度：high

# 全局冗余设计审查（2026-11-03）

> 只读审计，**未修改任何源码**。判定依据 AGENTS.md 原则 1（单一来源）/ 原则 2（减法优先）。
> 检测手段：① 标识符归一化后的 8 行滑窗指纹（找出「改了名但代码同形」的副本）；② 跨文件同名函数 / 同名常量 / 同值数字；③ 中文字面量跨层重复（找出 Renderer 抄 Main 的 prompt 与文案）；④ 人工逐条复核（22 个簇 + 5 个横切面）。
> 复跑脚本：`%TEMP%\red-audit\{scan,pairs,blocks,names,consts,literals}.py`。

## 结论

1. **最大的一类冗余不是「复制粘贴函数」，而是「同一语义在不同层各写一遍编排」**：录音状态机、模型设置归一化、mutate 队列、增量索引调度、catalog 列表页、codebase/graph 面板、凭据存储、AGENTS.md 提议流程 —— 这 8 组每一组都**已经真实漂移过**（一边修了另一边没修），不是理论风险。
2. `agent-bundle` 的 `window.Dieyun*` 通道已经存在，因此「Renderer 与 Main 各一份」在多数场景**不再是豁免理由**；现有副本大多是没迁完的残渣，不是架构必需。
3. AGENTS.md 里写明的「唯一来源」有 3 处已经漂移：`llm-request`（Renderer 仍内联端点 + Bearer 兜底）、`getRemoteFs`（fs handler 自判传输）、`session-workspace-bind`（另有两处双写）。
4. 「数字只在 agent-limits.js」这条规则有实证违规：`12 * 60 * 1000` 在 `agent-limits.js:93`（正本）、`mutate-queue.js:25`、`renderer-mutate-queue.js:18` 三处；另有计划调度 60s/5min、run 级看门狗 5min/45min 自写字面量。
5. 最省事的收益是**纯删除**：`12*60*1000` ×2、`summarizeLineDiff` ×3、`（模型未生成文字答复。）` ×3、`正在生成最终答复…` ×2、`SKILLS_GRID_PAGE_SIZE : 15` ×3、`guessMime` ×2、`withTimeout` 可合并 4 份 —— 全部零行为变化。

---

## A 级：真冗余且已发生漂移（建议先动）

### A1. 浏览器录音 → 转写状态机两份（high）
- `src/mobile/public/voice.js`（334 行）↔ `src/renderer/renderer-composer-voice.js`（319 行），49/59 个同形窗口，约 240 行可删。
- 逐字相同：`pickRecorderMimeType`、`extensionForMime`、`formatVoiceTimer`、`startWaveform`、`cleanupVoiceStream`、`stopVoiceBlob`、`toggleVoiceRecording` + 4 个常量 + 11 个状态变量。
- **已漂移**：波形条数 10 vs 12、振幅下限 0.17 vs 0.15（同一次提交 `67df2d1` 判两遍手抄当场分叉）；手机端提示硬编码中文、桌面端走 `t('voice_*')`；`voice.js:82-98` 自建 `showToast` 绕过 `app.js:2098` 注入的原生通知通道；`arrayBufferToBase64` 还有第三份在 `renderer-attachments.js:76`。
- 减法：抽一个纯浏览器共享脚本（`src/web-shared/voice-recorder.js`，plain script，工厂参数化 `{els, showToast, isBusy, insertText}`），两侧各留 ≤60 行薄壳。手机侧 `bridge.js:133-145` 需加静态根映射（**必须保留 `'..'` 拒绝与 `startsWith` 校验**）。
- 风险：Android WebView 的 MediaRecorder 编码候选顺序是实测结果，别"顺手简化"；`index.html:148` 的 `?v=` 版本串要同步。

### A2. 凭据加密存储三份（high，安全相关）
- `src/channels/store.js:63-90`、`src/mcp/credentials-store.js:30-66`、`src/ssh/credentials-store.js:13-60`：`canEncrypt` / `encryptSecret` / `decryptSecret` 各一份。
- **已漂移**：MCP 侧写盘**没有 0600**（ssh 有 `chmod`，channels 是原子写 + 0600）；MCP 坏文件静默返 `{}`，channels 抛错。三者同在 Main 同进程，无跨进程豁免。
- 减法：`src/secrets/encrypted-json-store.js`（能力判定 + 加解密 + 原子写 0600 + 坏文件抛错），三处退化为「文件名 + 行映射」；复用既有 `gateway/fs-atomic.js`。
- 风险：坏文件语义从「静默」改「抛错」需逐调用点确认；三份单测要迁移。

### A3. 忽略规则 / 文件遍历两份（且与 Rust 不一致）（high）
- `src/gateway/rg-search.js:8-53`（两张表 + `shouldSkipDir/File`）↔ `src/index/source-files.js:38-96`（自称 Node 侧唯一来源）↔ `crates/dieyun-core/src/index/walker.rs:12-35`。
- 三方已经不同：`source-files.js` 多 `.git/.venv/.next`、缺 `.ai/.a`；`rg-search.js:143-149` 与前者无任何引用关系；`rg-search.js:818-825` 与 `rpc.js:1003-1071` 各自内联 `--glob` 排除清单。
- 减法：`rg-search` 改 require `source-files` 的判定；`--glob` 提成单一常量供三处复用；`source-files` 目录表逐条镜像 `walker.rs` 并加漂移测试。
- 风险：合并后 `.svg/.docx/.xlsx` 是否仍被 grep 命中会变，需先定口径。

### A4. mutating 队列两份实现（medium，逐字同语义）
- `src/agent/mutate-queue.js`（183 行）↔ `src/renderer/renderer-mutate-queue.js`（145 行）：`normalizeWorkspaceMutateKey`、`getMutateQueue`、`runExclusive`、`isWorkspaceMutateBusy`、`listWorkspaceMutateHolders` 逐字相同，连 `MUTATE_QUEUE_STALL … 已放行后续写类工具` 日志串都一样。
- 文件头已声明「同语义的两份实现」，但**没有给出"为何删不掉"**：`renderer-workspace-busy.js` 只用它做「工作区忙」提示，主进程才是权威串行点。
- 减法：优先**删掉 Renderer 那份**，忙碌状态改读 Main 的 `getWorkspaceMutateSnapshot`（已有 RPC 侧数据）；若必须保留本地计数，则由 `agent-bundle` 把同一模块注册为 `window.MutateQueue`（纯函数，无 electron 依赖）。
- 顺带：`agent-limits.js:93 toolStallMs = 12 * 60 * 1000` 是唯一来源，两份队列各自硬编码同值 → 改 require / 经 `getAgentLimits()` 取。

### A5. 增量索引调度骨架两份（medium，已漂移）
- `src/graph/graph-incremental-scheduler.js` ↔ `src/index/codebase-incremental-scheduler.js`：`DEFAULT_DEBOUNCE_MS=3500`、`WORKSPACE_OPEN_DEBOUNCE_MS=1500`、节流日志、`schedule()`、`resolveWorkspaceRoot`、`notifyFileSaved/Opened` 全部同形；`src/gateway/server.js:153-178` 连 `invokeRustCore` 闭包都抄了两遍。
- **已漂移**：graph 侧保留了 codebase 侧明确否决的「busy 时 5s 重试」（`docs/INDEX-VALUE-REVIEW.md:23` 把「busy 不排重试」记为整改成果）；`graph:46 queuedAfterBusy` 是只写不读的死状态；两侧都写着「与 X 侧同构」——用注释代替单一来源。
- 减法：一个 `createIncrementalScheduler({label, isSourcePath, autoFlag, statusMethod, precheck, delayMs})` 工厂，删掉一个文件；测试从未绑定 3500（都显式传 debounceMs），需补一条「未传时窗口相同」的断言。

### A6. 模型设置默认值与归一化两份（medium，已产生真实 bug）
- `src/model-settings.js:23-65/211-315` ↔ `src/renderer/renderer-model-runtime.js:14-55/465-527`：`DEFAULTS` 字段表、`isLegacyBuiltinEmbedding*`、`normalizeEmbedding*`、embedding 重建块各两份；`EMBEDDING_DIMENSIONS_MIN/MAX=64/8192` 与默认 1024 在 `model-settings.js`、`renderer-model-runtime.js`、`codebase/embedding-client.js:7-9` **三处**。
- **实际后果**：Main 版 `normalizeEmbeddingEntry` 保留 `headers/authMode/userAgent`（`:233-235`），Renderer 版只重建 6 个键 → 用户每次保存设置都把向量端点的自定义头剥掉，永不回来（401/400）；`temperature` 只在 Main 侧 clamp，两侧显示值来回翻；`embedding-default / text-embedding-v4` 过滤只在 Renderer 存在 → 设置页与实际使用不一致。
- 减法：抽 `src/agent/model-settings-schema.js`（纯函数）→ `agent-bundle` 注册 → 两侧只留各自独占的 shaping（suppliers/customModels/speech）。并补 `model-settings-normalize-parity.test.cjs`（同 fixture 双跑深等）——没有这条闸门，收敛后会再分叉。

### A7. 市场列表页（MCP / 技能）UI 骨架两份（medium）
- `renderer-mcp-catalog.js` ↔ `renderer-skill-catalog.js`（53 个同形窗口）：分页条渲染、`pageCount/slice`、load 状态机、350ms 搜索防抖、分类 tab、下一页 handler。同一个 window 作用域，无跨进程豁免。
- **已漂移**：`skill-catalog.js:427-431` 加载更多后不推进 `pageIndex`（要再点一次才看到）；缺 `mcp-catalog.js:399` 的 loading guard；`errors` 字段只有 MCP 版有。
- 仓库**已有**单一来源：`renderer-skills-grid.js:198-268` 的 `renderGridCategoryTabs / updateGridPagination / bindGridSearchInput / bindGridPagination`（automation 与 skills-ui 都在用），这两个 catalog 自己手写绕过。
- 减法：接上那四个已有函数；`renderer-automation.js:35-36`、两个 catalog 的 `: 15` 页大小兜底是死代码（`skills-ui.js:944` 已提供）。
- **已修（2026-11-21）**：两个 catalog 与 `renderer-skills-grid.js` 自己的列表页全部改调那四个 helper —— 分页条 / 分类 tab / 350ms→统一 200ms 搜索防抖 / 下一页 handler 都不再有第二份。`updateGridPagination` 增加可选 `{ loading, canLoadMore, label }`（"末页还能继续加载"是既有语义，不是新开关），`bindGridPagination` 增加 `{ onNext, onPrev }` 接管"末页先向服务端加载再推进索引"。同时修掉本条目记的两个真缺陷：技能市场加载更多后**真的推进 `pageIndex`**、失败提示不再被 `finally` 用旧数据盖掉；`renderSkillCatalogGrid`/`renderMcpCatalogGrid` 的 `errors` 差异收敛成一份 `parseGridListResult`（旧「结果是数组」兼容分支删除）。回归：`test/unit/renderer-grid-paging.test.cjs`（含"末页加载更多后到新页"的断言）。

### A8. AGENTS.md「唯一来源」声明已漂移（high）
| 声明 | 现实 |
|---|---|
| `agent/llm-request.js` 是端点与请求头唯一来源 | `renderer/renderer-agent-llm.js:11-14` 内联三条端点规则、`:31-35` 内联 `Content-Type + Bearer` 兜底（与 `renderer-model-settings.js` 的「不再自拼 Authorization」立场相反） |
| `gateway/rpc.js:getRemoteFs()` 是远端 fs 唯一出口 | `gateway/handlers/fs.js:739-753` 直接走 `getRemoteAgentClient().call('fs.grep')`、`:754+` 再判 `transport === 'sftp'`；`handlers/lsp-workspace.js` 同类 |
| `agent/session-workspace-bind.js` 是绑定唯一实现 | `main/ipc/workspace-remote.js:46-61`、`session/session-worktree.js:194-200` 各有一套双写；`agent/service.js:257-264` 只写会话行（半写） |
| TTS 合成请求体唯一 | 成立；仅 `'audio/mpeg'` mime 兜底两份 |

减法：删 Renderer 内联兜底（bundle 缺失即抛，与 model-settings 一致）；把 `search` 补进 `getRemoteFs()` 接口后，handler 不再自判传输；三处绑定改调 `session-workspace-bind`。

### A9. AGENTS.md 提议流程两份（medium）
- `src/agent/propose-tools-main.js:60-190`（模型工具路径）↔ `src/renderer/renderer-agents-md.js:381-444`（UI / 自动维护路径）：`mode==='off'`、空变更、`draft-only` 写草稿、`preview` 入队、commit、size 警告六个分支各写一遍，**5 条提示文案逐字相同**（`变更已存在或置信度过低，已跳过`、`已写入草稿 .dieyun/agents-draft.md，未修改 AGENTS.md`、`已打开 Diff 预览，请采纳或放弃`、`项目地图维护已关闭（设置 → 电脑权限）`、`请先选择工作空间`）。
- 合并核心 `applySectionUpdates` 已单一来源（`agents-md.js:331`），所以**可以删的只是编排**：Renderer 改走既有 `ipc('agents-md:apply-updates')`，删 `renderer-agents-md.js:381-444` 与 `writeAgentsMdDraft`。

### A10. Renderer 复制了 Main 的 system prompt 上下文块（medium）
- `src/agent/system-prompt-prep.js:316-354`（`fetchOpenFilesBlock`）↔ `src/renderer/renderer-context-engine.js:240-330`（`buildOpenFilesContext`）：同一段 `【当前关注文件 · 会话上下文】` + `用户/Agent 最近触及的文件（类似 Cursor 打开文件上下文）：` + `【本会话变更文件】` + `（二进制或空，未注入全文）` + ` [文件未完，可用 offset 续读]` + `…（已截断，原文 N 字符）`。
- 直接违反 AGENTS.md 表格：「模型可见规则 / system prompt → `agent-system-prompt.js`、`system-prompt-prep.js`；**勿在 Renderer 再写一份**」。
- **已漂移**：`maxPreviews` Main=4 / Renderer=3；Main 串行、Renderer 支持 parallel 分支。
- 减法：该块的唯一来源放 `agent/context-signals.js` 或 `system-prompt-prep.js` 并导出，经 `agent-bundle` 镜像给 Renderer（`shouldAutoCodebaseSearch` 已经这么做了，是现成通道）。

### A11. 交付四态 / 汇总占位文案散落（medium）
- `（模型未生成文字答复。）`：正本 `agent/agent-round-text.js:33`（`TURN_EMPTY_REPLY_TEXT`），副本 `agent/session-context.js:484`、`renderer/agent-guardrails.js:45`、`renderer/renderer-thinking-trace.js:667`。
- `正在生成最终答复…` / `汇总未完成，见下方答复`：`agent/agent-synthesis.js:11-13` ↔ `renderer/renderer-thinking-trace.js:538,540`。
- 这与 AGENTS.md 原则 5「交付四态单一来源（`agent-round-text.resolveTurnDelivery`）」直接冲突：任何一侧改文案都会出现「思考顶正文」式的语义分叉。
- 减法：全部改为引用 `AgentRoundText` / `agent-synthesis` 导出的常量（Renderer 侧已在 agent-bundle 里）。

### A12. 浏览器双引擎的引擎无关语义各写两遍（medium）
`browser/controller.js` ↔ `browser/playwright-runner.js`：
- `guessMime`（`controller:373-384` ≡ `pw:1494-1505`）；
- dropzone 兜底：`snapshot-script.js:654-719` 已有实现，`pw:1508-1526` 又手写一遍；
- 对话框策略白名单（`controller:2354` / `pw:1928`）、路由规则工厂（`controller:2414-2426` / `pw:1982-1994`）、'未找到规则' 文案；
- `VIEWPORT_REQUIRED` + 同一句文案 **四处**（每个文件内两遍）；
- `emulate` 的 `applied/errors/ok` 信封两份，且 controller 内 `['geolocation','notifications']` 硬编码两遍（与 `viewport.js:43-50 EMULATE_PERMISSIONS` 单一来源脱钩）；
- **已漂移**：`interception` 字段两引擎语义不同（是否已生效 vs 有无规则）；下载等待超时 BrowserView 有 120s 上限、Playwright 无上限。
- 减法：`guessMime`→`snapshot-script.js`；`normalizeRouteRule` / `normalizeDialogPolicy` / `shapeEmulateResult` / `requireViewport` 各抽一次（落在 pw 可 require 的零依赖模块，pw 必须保持 electron-free）；超时 clamp 提到 `service.js`。

### A13. codebase / graph 面板骨架（medium）
`renderer-codebase-panel.js` ↔ `renderer-graph-panel.js`：约 190 行同形（工作区解析、可见性、2s/5s 轮询状态机、rail busy、`onShown/onHidden`、rebuild、init 幂等绑定）。
- **已漂移**：`renderer-gateway.js:482-486` 的 `viewSid === sid` 守卫（会话工作区漂移根因修复）只进了 gateway，两份面板的本地副本至今没有；两处 `sync*RailBusy(busy)` 被以 2 个实参调用，`progress` 是死参数。
- 减法：删两份 `resolve*WorkspaceRoot`（`renderer-gateway.js:463` 的 `resolveWorkspaceRootForIndexPanels` 已是单一来源且无条件导出），再抽一个 `createIndexPanelSection({prefix, paneSelector, fetchStatus, applyStats, phases})`；RPC 名/字段映射/phase 表/增量默认值留作参数。
- 注意：`renderer-automation.js` 已有第三份同族写法（`renderer-agent-context-ui.js:822` 注释自称「与 codebase-panel 同构」），抽工厂时一并纳入，否则会长出第四份。

### A14. 其余真冗余（低到中，一次可清）
| 位置 | 重复内容 | 减法 |
|---|---|---|
| `agent/compaction-telemetry.js` ↔ `agent/tool-telemetry.js` | jsonl 拼路径 / 写一行 / 容错读 / 截断清空 / 一位小数 | 抽 `createJsonlRowWriter` + `readJsonlRows`（两条流本身不合并） |
| `agent/agent-limits-by-tier.js` ↔ `agent/model-runtime-by-tier.js` | 档位持久化脚手架（fold 未知档 / localStorage / 只存覆盖 / set-reset-getAll-hydrate）；`8192` 又散在 `model-runtime-by-tier.js:293/301/359` 与 `model-runtime-schema.js:33` | 抽 tier-store 工厂；`agent-bundle-entry.js:101-102/118` 的 `STORAGE_KEY` compat 无读点可删 |
| `gateway/server.js` ↔ `remote/minimal-gateway-host.js` | RPC 线协议手写两遍（BAD_JSON / id 归一 / UNKNOWN_TYPE / UNKNOWN_METHOD / retryable 信封 / `_send` / `stop()`） | 抽 `gateway/wire-protocol.js`，加进 `REMOTE_GATEWAY_SOURCE_PATHS`；握手差异留宿主 |
| `skills/vector-index.js` ↔ `tools/tool-vector-index.js` | 索引构建骨架 + 查询嵌入 + `QUERY_EMBED_TEXT_MAX=1200`；batchSize 8 vs 16 无说明 | 复用 `codebase/vector-index.js` 既有原语，加 `createIndexStore` / `embedPending` |
| Rust ↔ Node | 记忆衰减 120/240 天、检索摘录 240/600 字在 `rpc/mod.rs:441/445` 的 `unwrap_or` 与 `knowledge-maintainer.js:921` 的 `\|\|` 各留默认值；压缩比 0.3–0.95 与地板 8192 双侧各夹一次 | 改必填由 `agent-limits` 下发，删两侧兜底（步数/工具上限已经这么做了，是正例） |
| `renderer-undo-stack.js:234-242` | 手抄 7 个「会碰文件」的工具名，与 `guardrails-shared.js:77` 的 `FILE_WRITE_TOOL_NAMES` 部分重叠 | 该集合移进 `guardrails-shared`，经 `window.GuardrailsShared` 消费 |
| `gateway/rpc.js:69`、`gateway/remote-fs.js:11`、`remote/minimal-gateway-host.js:27` | `summarizeLineDiff` 三份一行包装，都只是转调 `line-diff-stats` | 直接调 `computeLineDiffStats` |

### A15. 通用工具函数（低，但删起来零风险）
- `withTimeout` × 6（`agent/system-prompt-prep.js`、`agent/tool-bridge-main.js`、`browser/service.js`、`gateway/sandbox-approvals.js`、`lsp/navigate-service.js`、`mcp/runtime-manager.js`）——其中两处逐字相同（吞型）、两处仅文案差、两处带错误码 → **已收敛为 `src/timeout.js` 的 `(promise, ms, {mode, message, code})` 一个工厂**（注意别把"吞超时"与"抛超时"混同：`mode` 就是这个区别，不是新开关）。
- `readJsonFile/writeJsonFile` × 3（`deploy-config.js`、`mcp/catalog.js`、`skills/catalog.js`，前两份字节级相同）。
- `capText` × 3（`system-prompt-prep.js:79`、`renderer-context-engine.js:190`、`renderer-agent-context-ui.js`）→ 走 agent-bundle 镜像。
- `filterEntries` 的 `urlPattern/sinceMs/engine` 三段在 `browser/console-collector.js`、`network-collector.js`、`timeline.js` 复制三次。
- `clampInt/clampNumber` × 5、`normalizePathKey` × 3：**语义确实不同**（包含与否、平台差异），保留，但在头注释标注差异点，避免下一轮审计重复发现。

---

## B 级：刻意双份，但数字/文案未声明（漂移面）

- `mutate-queue` 两份与 `renderer-mutate-queue` 的 `12 * 60 * 1000`（`agent-limits.js:93` 是正本）。
- `plans/scheduler.js:27-28` 的 60s / 5min、`rust-loop-runner.js:601,603` 的 5min/45min、`knowledge-maintainer.js:1264` 的 5min：都是「静默/轮询」类阈值，未挂在 `agent-limits`。
- `tool-output-spill.js:13` 的 8192、`session-context.js:616-623` 与 `renderer-context-engine.js:90-119` 的 `toolResultMaxJson=14000` 死兜底。
- Renderer / mobile 各有一张 i18n 表（`renderer-i18n.js` / `mobile/public/app.js:48`）：**不同页面、不同键集，属合理双份**，但注意桌面语音提示已走 i18n 而手机端仍硬编码中文（见 A1）。

---

## C 级：伪冗余（明确不动，避免下轮重复审计）

- `require` 区块、`close/ensurePage/guard` 骨架：同一批共享模块的两个 import 表。
- `browser/engine-target.js`、`ref-namespace.js`、`journal-scope.js`、`render-health.js`、`line-diff-stats.js`、`fs-atomic.js`、`path-policy`：都已经是单一来源，两侧只是消费。
- Rust 的 FTS 构造、分块、图算法：Rust 唯一真相，Node 侧只是薄客户端。
- 双引擎的原语层（CDP `sendCommand` vs Playwright `page.*`、BrowserView 前台单例 vs Playwright 多会话无头）：必须两份。
- `model-settings.js:96-99` 与 `ModelCapabilities.pickTtsModel` 的 TTS 判据重叠：文件注释已声明「两台服务能力常不同时存在」，刻意。
- `resolveTextApiConfig`（`model-settings.js:149-170`）与 `clampRuntimeValue`（`renderer-model-runtime.js:60-77`）：仅形状相似，语义无关。

---

## 建议执行顺序（每步可独立提交）

1. **P0 纯删除 / 零行为变化**：A15 的 `summarizeLineDiff`×3、`withTimeout` 可并 4 份、`readJsonFile`×2、A11 文案常量、A7 的 `: 15` 死兜底与 `parseSkillCatalogListResult`、A13 的两份 `resolve*WorkspaceRoot`（带 bug 的兜底）、A8 的 Renderer 内联端点/头、A4 的 `12*60*1000`×2。
2. **P1 单一来源收敛（有明确定位）**：A2 凭据、A3 忽略规则、A5 调度器、A6 设置归一化（先补 parity 测试）、A9 提议流程、A10 prompt 块、A14 遥测/tier/线协议。
3. **P2 需要产品/交互确认**：A1 录音共享壳（真机验证）、A7 catalog 骨架（分页文案与 tab 顺序会变）、A12 双引擎（`interception` 字段语义变更、下载超时收紧）、A13 面板工厂（护栏 `check-renderer-index-panel.cjs` 需同批更新）。
4. **P3 跨层必填化**：Rust/Node 的 120/240、240/600、压缩比与地板改必填 —— 需要先盘清远端 core 与手机端调用点。

## P0 执行记录（已完成，`npm test` OK）

| # | 动作 | 结果 |
|---|---|---|
| 1 | 新增 `src/json-file.js`（`readJsonFile` + BOM 剥离 / `writeJsonFile`），`mcp/catalog.js`、`skills/catalog.js`、`deploy-config.js` 三份实现 → 1 份 | −2 份拷贝；读失败语义不变（返回 fallback） |
| 2 | `gateway/remote-fs.js`、`remote/minimal-gateway-host.js` 的 `summarizeLineDiff` 一行包装删除，直接调 `computeLineDiffStats` | `gateway/rpc.js` 那份是**富信封**（`beforeLines/created/beforeSnippet…`），不是包装，保留；本地写与远端写返回字段仍不一致，记入下一轮（见注 1） |
| 3 | `agent/mutate-queue.js` 与 `renderer/renderer-mutate-queue.js` 的 `12 * 60 * 1000` 改为读 `agent-limits.toolStallMs`（`resolveStallMs` / `resolveMutateStallMs`，来源缺失即抛） | 数字回到单一来源；`DEFAULT_STALL_MS` 导出无读点，删除 |
| 4 | 交付文案常量：`（模型未生成文字答复。）` / `正在生成最终答复…` / `已完成` / `汇总未完成，见下方答复` 全部收进 `agent-round-text.js`（`SYNTHESIS_*`），`agent-synthesis.js`、`session-context.js`、`renderer/agent-guardrails.js`、`renderer-thinking-trace.js` 改为引用 | 4 处 → 1 处；同时删掉 `renderer-thinking-trace.js` 里 `needsAssistantReplySynthesis` / `synthesizedReplyIsUsable` / `normalizeAssistantReplyForStorage` 的三段内联兜底与重复的 `countTraceTools` |
| 5 | 两个 catalog 的 `SKILLS_GRID_PAGE_SIZE ? … : 15` 死兜底删除 | `renderer-automation.js` 的同类兜底**是活的**（加载序早于 skills-ui），保留并加注释说明为何删不掉 |
| 6 | `renderer-codebase-panel.js` / `renderer-graph-panel.js` 的 `resolve*WorkspaceRoot` 四级回落副本删除，统一调 `renderer-gateway.js:resolveWorkspaceRootForIndexPanels` | 面板不再解析到上一个会话的工作区（守卫修复终于对面板生效） |
| 7 | `renderer-agent-llm.js` 内联端点三规则 + `Content-Type + Bearer` 兜底删除，统一 `window.LlmRequest`（缺失即抛） | 与 `renderer-model-settings.js` / `renderer-model-capabilities.js` 的既有调用方式一致 |
| 8 | 新增 `src/timeout.js`（`withTimeout(promise, ms, { mode, message, code })`），六份手写实现全部删除：`agent/system-prompt-prep.js`（7 处调用）、`agent/tool-bridge-main.js`、`browser/service.js`（2 处）、`gateway/sandbox-approvals.js`、`lsp/navigate-service.js`（2 处）、`mcp/runtime-manager.js`（2 处） | 6 → 1；两种模式（抛 / 吞成 null）是既有语义，不是新开关；顺手补上原两份漏掉的 `clearTimeout`；新增 `test/unit/timeout.test.cjs` 12 条契约用例 |
| 9 | `src/remote/remote-pack-layout.js` 的 `REMOTE_GATEWAY_SOURCE_PATHS` 补入 `src/timeout.js` | 仓库自带的闭包校验（`remote-pack-requires`）当场报出「清单外 require」——正是 2026-10-18 `spawn-args` 事故形态；不补则远端注入 `Cannot find module '../timeout'` 且 hash 相同导致坏包刷不掉 |

验证：`npm test` 全绿（含 173 个单测文件 / 1686 用例）；`npm run check:renderer`、`npm run check:js` 全绿；改动模块的 smoke 逐个过：`test:lsp`、`test:local-gateway-smoke`、`test:mcp-store`、`test:system-prompt-prep`、`test:tool-bridge-delegate`、`test:browser-smoke`、`test:sandbox-gateway`、`test:sandbox-policy`、`test:agent-round-text`、`test:session-context`、`test:guardrails-sync`；agent-bundle 已重建（`src/renderer/dist/agent-bundle.js` 含新的 `SYNTHESIS_*` / `TURN_EMPTY_REPLY_TEXT`）。
注：本机 harness 环境带 `ELECTRON_RUN_AS_NODE=1`，会让 `test:lsp` 断言「npx child keeps default env」误红；跑测试前 `$env:ELECTRON_RUN_AS_NODE=$null` 即可。

注 1（新发现，未修）：写文件返回的 `diff` 信封本地（`gateway/handlers/fs.js` → `rpc.js:69` 富信封）与远端（`remote-fs.js` / `minimal-gateway-host.js` → 只有 `{added, removed}`）字段不同，UI 在远端会话缺 `beforeLines/created/beforeSnippet`。属同一语义两份形状，建议下一轮统一到 `line-diff-stats`。

注 2（未做，P1）：`upsertSynthesisTraceRound` 仍是两份（`agent-synthesis.js:100` / `renderer-thinking-trace.js:560`），差异只在 Renderer 额外打的 `synthesisRound` / `answerPhase` 两个 UI 标记 —— 收敛前要先定「这两个标记能否由 `phase === 汇总` 推导」，否则只是把两份合成一份带开关的。

## P1 执行记录（顺序：调度器 → 忽略规则 → 凭据；`npm test` OK）

| # | 动作 | 结果 |
|---|---|---|
| 1 | 新增 `src/index/incremental-scheduler.js`（去抖 / 节流 / 远程工作区判定 / 定时器回收的唯一实现）；`graph/graph-incremental-scheduler.js` 与 `index/codebase-incremental-scheduler.js` 只剩三处策略：开关（graph 默认开、codebase 默认关）、来源过滤、`decide()` 状态判定 | 两份 ~190 行骨架 → 1 份工厂 + 两份策略；`3500ms` 去抖窗口从两份变一份（历史上正是只改了一边）；顺手删掉 graph 侧 `queuedAfterBusy`（只 add/delete，从没人读）；`incremental-index-dedupe` 9 条行为用例全过 |
| 2 | 忽略规则：删掉 `gateway/rg-search.js` 自带的 `IGNORE_DIRS` + `IGNORE_EXT`（扩展名表只有 Rust 的一半），改引 `index/source-files.js`；Node `BINARY_EXT` 补 `.ai` / `.a` 与 `walker.rs` 对齐；新增 `test/unit/ignore-rules-parity.test.cjs` | 三份口径 → Node 一份（rg/glob 与同步索引共用）+ Rust 权威一份；parity 测机器校验：扩展名**完全相等**、目录 Rust ⊆ Node、Node 多出来的必须是隐藏目录（`ignore` crate 默认跳过隐藏项，Node 没有这个默认行为） |
| 3 | 新增 `src/secret-store.js`（safeStorage 加解密 + 原子写 + 0600 + 读失败策略）；`channels/store.js`、`mcp/credentials-store.js`、`ssh/credentials-store.js` 的三份 `canEncrypt` / `encryptSecret` / `decryptSecret` 全部删除 | **MCP 的 `mcp-secrets.json` 从此也是 0600**（此前是 umask 默认，同机其他用户可读）；MCP / SSH 顺带拿到原子写；读坏文件策略成为显式参数（`'empty'` = MCP/SSH，`'throw'` + `CHANNEL_STORE_CORRUPT` = 频道），不再靠三处各写一遍；新增 `test/unit/secret-store.test.cjs` 10 条（含「MCP 侧从此也是 0600」） |

验证：`npm test` 全绿（175 个单测文件 / 1700 用例）；`check:js`、`check:renderer` 全绿；相关 smoke 逐个过：`test:mcp-store`、`test:llm-channel`、`test:local-gateway-smoke`、`test:agent-run-events`；单测：`incremental-index-dedupe`、`source-files`、`grep-oversize-hint`、`channels-core`、`channels-store-robustness`、`channels-turn`、`channels-workspace-switch`、`mcp-credentials-store`、`ssh-credentials-store`、`mcp-env-fields-ui`。

注 3（P1 之外剩下的原创收项，未做）：模型设置归一化 + 两侧 parity 测、propose-AGENTS 流程、`renderer-context-engine` 的「当前关注文件」块、telemetry/tier/wire-protocol。

## P1-4 执行记录：凭据文件损坏的显式状态（原注 4，已实施）

动机：`secret-store` 收敛后，MCP / SSH 的「读到坏文件当空」还在 —— 坏文件 + 任意一次保存 = 静默丢掉其余条目（与频道配置当初那个 bug 同一形态）。就地改成 `'throw'` 不行：这两个 store 的读取在 Agent 轮内高频命中，抛错会打断工具调用。所以做成**显式状态 + 显式动作**：

| 层 | 改动 | 要点 |
|---|---|---|
| `src/secret-store.js` | 读坏文件时记录损坏态（`getHealth()`）**并落一个旁路标记 `<凭据文件>.corrupt.json`**，**此后 `writeJson` 抛 `SECRET_STORE_CORRUPT`**；`resetCorruptFile()` 把坏文件改名成 `<file>.corrupt-<时间戳>` 备份后解除损坏态 | 保护点只有一处：写之前问「这个文件我读得懂吗」。改名而非删除 —— 里面可能有还能人工救回的密文，删掉是不可逆的数据损失 |
| ↳ 为什么要落标记 | 内存态重启即失效，得等「第一次读到坏文件」才重新成立；只要重启后先发生的是**保存**（懒加载列表、脚本调用、将来某个新入口），闸门就晚一拍 —— 而晚一拍正好等于覆盖掉其余条目。标记让「文件坏了」变成启动时就能看见的事实，与读取顺序无关。过期标记不算数：`writeJson` 撞上标记会先**真读一次**，能解析就清标记继续写；读到正常文件 / 文件不存在 / 备份重建后也一律清掉 | 标记只存解析错误信息（无密文），best-effort 写；写不进去只降级回「本实例内存」并记一条日志，不影响读路径 |
| `src/mcp/credentials-store.js`、`src/ssh/credentials-store.js` | 增 `readStoreHealth()`（先读一次再报）、`resetStore()` | 保留各自 `onCorrupt: 'empty'` 的读语义，只是不再「假装什么都没发生」 |
| IPC / preload | `mcp:credentials-health`、`mcp:credentials-reset`、`ssh:credentials-reset`；`ssh:get-profile` 增加 `storeCorrupt` / `storeCorruptMessage` | MCP 单开一个通道而不是塞进 `mcp:list`（后者是数组，被 plan boot / mobile 共用，改形状会牵一片） |
| Renderer | MCP：设置页列表上方的 `#mcp-credentials-warning` 提示条 + 「备份并重建」；SSH：连接面板复用 `#ssh-connect-encrypt-hint` 说明「读不出来，且保存会被拦下」，并加「备份损坏的凭据文件并重建」按钮 | 文案明说**保存会被拦住**，避免用户以为只要重填就行 |

测试：`test/unit/secret-store.test.cjs` 扩到 20 条（损坏态拒绝写且原文件一字不动、改名备份后可写、MCP/SSH 的 health→拒绝保存→重建→恢复全链路，以及标记落盘的 5 条：**重启后不必先读也报坏且拒绝写**、过期标记被真读纠正、成功读/文件消失/备份重建后标记清除、标记写不进去只降级）；新增 `test/unit/mcp-credentials-corrupt-ui.test.cjs` 4 条（提示条显隐、文案含「备份并重建」、接口失败不挡页面、用户取消时不动文件）。`npm run test:unit` 176 文件 / 1714 用例、`npm test`、`check:renderer` 全绿。

## 附：本次未做的事

- P0 / P1 / P1-4 之外（P2/P3）未动：模型设置归一化、propose-AGENTS 流程、`parseSkillCatalogListResult`、语音外壳、目录骨架、双浏览器引擎、面板工厂、Rust/Node 必填参数整改、写文件 `diff` 信封统一（注 1）、`upsertSynthesisTraceRound`（注 2）。
- 未审计 `src/renderer/dist/`（构建产物）、`node_modules`、`crates/dieyun-core` 之外的 Rust 目标目录。
- 静态检测的"同形窗口"会把「同一批 require」「同一段 try/catch」算进来，本文已把这类剔除；未复核的剩余低分簇（`<4` 窗口）多为巧合。

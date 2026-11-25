# 全仓代码整洁度审查（2026-11-21）

> 一次**只看整洁度**的全面体检：重复实现 / 死代码 / 超长与混杂职责 / 魔法数字 / 层级越界 / 错误吞掉 / 生成物混放 / 测试与实现同居 / 用降级层绕过问题。
> 审查对象是**当前工作树**（本轮开始时 `git status --short` 有 ~180 个改动文件、18 个未跟踪文件），不是 HEAD。
> 只读审查：**本轮的审查环节没有修改任何源码**（本轮只新增了本文 + `docs/audit/2026-11-cleanliness/` 取证目录，并在 `AGENTS.md` 文档索引加了一行）。复跑脚本见 `docs/audit/2026-11-cleanliness/tools/`，见 §六。

---

## 一、结论（先看这里）

1. **能自动拦的地方是绿的，问题都在拦不到的地方。** `check:js`（scoped tsc）、`check:renderer`、`check:contracts`、`check:shared-constants`、`verify:tool-validators`、`verify:rpc-catalog`、`verify:core-contracts`、`verify:agent-events`、`cargo clippy --workspace --all-targets -D warnings` 九项全过。整洁度风险不来自「跑红的检查」，而来自「没有检查的维度」。

2. **最贵的一类问题仍是「同一语义两份、靠注释维系」**：8 行滑窗克隆检测在 `src/` + `crates/` 上测出 **49 对跨文件重复**，其中约 10 对是真同一语义。多对**已经漂移**，也就是两处对同一件事给出不同答案（下面「三、亲手核实」有两条已确认会误导使用者）。

3. **一条硬结论 + 一条自我更正（都逐行核实过，不依赖子审查）**
   - **`check:renderer` 只做单向校验**：它验证「465 个 `window.X` 都能解析到声明」，但从不验证「声明了有没有人用」。实测 `src/renderer` 有 **20 处顶层声明全仓零调用点**（我独立扫出 22 个名字，其中 2 组同簇；域审查独立得出同一个 20 的量级）：`switchPanel`、`initUndoStackUI`、`initArtifactsBtn`、`refreshWorkspaceArtifacts`、`getComposerSelectedModelId`、`isLocalOnlyMethod`、`updateRustBootStep` 等。这不是新事——`docs/NODE-THINNING-PLAN.md` 的 **N4.1 早就预言过**并给出施工方案（`scripts/check-renderer-dead-exports.cjs`），**那个脚本至今不存在**。
   - **自我更正：`agent:main-tool-delegate` 不是死通路**（我本轮第一版报告判错了，见 §3.1）。Main 侧确实有发送方与回包处理器，渲染层确实在执行 `RENDERER_ONLY_TOOLS`。因此 `src/renderer/renderer-agent-tools.js` 与 `renderer-mutate-queue.js` **不能按「死代码」删**；它们是「同语义两份」的重复（P1），不是死码。

4. **该补的机械闸门只有一个，而且它是减法**：把 N4.1 的零调用点检查建起来、接进 `check:renderer`（先报告后硬失败）。理由：本轮所有「死代码」发现都是「删掉 → 没人再拦 → 下一个人再长回来」的循环产物，`renderer-agent-llm.js` / `renderer-agent-loop.js` 的历史遗留就是这么留下的。

5. **没有发现「需要新机制」的整洁度问题。** 报告里每一条的解法都是删 / 合并 / 搬进既有单一来源；没有一条建议新增开关、阈值或状态机。

---

## 二、口径与量化画像

### 2.1 体量（`dist/`、`vendor/`、`node_modules/` 已排除；行数用 `ReadAllLines` 实数）

| 区域 | 文件 | 行 |
|---|---:|---:|
| `src/`（含所有子目录） | 525 | 185,590 |
| ├ `src/renderer` | 119 | 57,922 |
| ├ `src/agent`（含 `catalog/` `main-tools/`） | 106 | 34,709 |
| ├ `src/gateway` | 57 | 17,010 |
| ├ `src/browser` | 22 | 11,174 |
| ├ `src/main`（含 `ipc/`） | 33 | 8,178 |
| ├ `src/ssh` | 20 | 6,154 |
| ├ `src/lsp` | 9 | 5,899 |
| ├ `src/mcp` | 12 | 3,670 |
| ├ `src/peer` | 10 | 3,550 |
| ├ `src/mobile`（不含 html/css） | 4 | 3,134 |
| ├ `src/alive` | 10 | 3,003 |
| ├ `src/remote` | 8 | 2,466 |
| ├ `src/plans` + `src/goals` | 13 | 2,941 |
| └ 其余（channels/skills/computer/index/…） | — | ~10,900 |
| `crates/`（`*.rs`） | 110 | 34,790 |
| `scripts/` | 136 | 33,218 |
| `test/` | 249 | 40,585 |

总源码约 **29 万行**（`src` + `crates` + `scripts` + `test`）。

### 2.2 超长文件（≥800 行，`dist/` 与生成物已排除，共 66 个 / 1,019 个源文件）

最长的十二个：`browser/controller.js` 3,101 · `lsp/diagnostics-service.js` 2,383 · `browser/playwright-runner.js` 2,186 · `gateway/rpc.js` 2,164 · `renderer/renderer-chat-history.js` 2,129 · `mobile/public/app.js` 2,102 · `scripts/test-alive.cjs` 1,989 · `agent/agent-limits.js` 1,819 · `crates/dieyun-memory/src/memory/tests.rs` 1,691 · `renderer/renderer-alive.js` 1,681 · `agent/knowledge-maintainer.js` 1,653 · `scripts/test-rust-loop-runner.cjs` 1,529。

> 注意：这个数字（66 个 ≥800 行）本身不是结论。既有文档已裁定 `agent-limits.js`（数字主源）与 `system-prompt-prep.js`（一族注入块）**不拆**，报告里也不重复提；只有「一个文件同时做 IO + 状态机 + 文本拼装」才成条。

### 2.3 跨文件重复（8 行归一化滑窗，`src/` + `crates/`，排除生成物与测试）

- 命中窗口 124,112 个，**跨文件重复窗口 183 个**，聚成 **49 对**。
- 前五：`mobile/public/voice.js` ↔ `renderer-composer-voice.js`（31 窗）· `browser/controller.js` ↔ `browser/playwright-runner.js`（12）· `agent/mutate-queue.js` ↔ `renderer/renderer-mutate-queue.js`（10）· `gateway/rg-search.js` ↔ `gateway/rpc.js`（10）· `renderer-agent-continue.js` ↔ `renderer-thinking-trace.js`（10）。
- 交叉核对后**判为伪冗余**（同批 require / 共享工具的不同消费方，不该合并）：`computer.js` ↔ `ssh-screen.js`、`window-tray.js` ↔ `workplace-monitor.js`、`handlers/fs.js` ↔ `minimal-gateway-host.js`、`context-signals.js` ↔ `system-prompt-prep.js`、`artifact-diff-view.js` ↔ `artifacts.js`、`agent-resume.js` ↔ `agent-send.js`。

### 2.4 其他硬指标

| 指标 | 数值 | 说明 |
|---|---:|---|
| `TODO/FIXME/XXX/HACK` | 21 处 | 全仓（`src` + `crates`），无集中堆积，不构成问题 |
| `console.*`（`src`，非 `dist`） | 168 处 | 其中 Main/Gateway 侧 `console.log/debug/info` 只有 5 处（`docs/LOGGING.md` 的口径守住了）；主要是 Renderer 的 `console.warn(err)` 无上下文 |
| 硬编码 `setTimeout(..., ≥100ms)` | 34 处 | 不在 `agent-limits.js` 里 |
| 裸大阈值比较（`>= 1xxx`） | 42 处 | 同上，多为局部语义上限 |
| 生产 Rust `unwrap()/expect()` | 28 个文件 | **注意口径**：`866` 这个总数里绝大多数在 `#[cfg(test)]` 内联测试里（如 `index/walker.rs` 25 处全是测试），真正的生产路径裸 unwrap 很少 |
| `scripts/` vs `test/` | 69 个 `scripts/test-*.cjs` / 245 个 `test/unit/*.test.cjs` | 两套体系并存，`docs/CODEMAP.json` 的 `suites` 已把 `test:unit` 收进 `agent` 套件 |
| npm scripts | 145 个 | `check:contracts` 会校验 CODEMAP 与 scripts 的一致性 |

### 2.5 闸门覆盖的洞（这才是 2.2–2.4 数字的来源）

| 洞 | 证据 | 后果 |
|---|---|---|
| `check:renderer` 只查「能解析」不查「有人用」 | `scripts/check-renderer-globals.py` / `check-renderer-critical.py` / `check-renderer-index-panel.cjs` 三件套 | 21 个零调用点声明长期绿 |
| ESLint 只覆盖 `src/agent` / `src/computer` / `scripts/test-*.cjs` | `.eslintrc.cjs:14` 的 `files` 数组 | `src/renderer`、`src/gateway`、`src/ssh`… 没有 lint。我用同一套 recommended 规则临时全量跑 `src`：**1,869 条**（`no-unused-vars` 1,853 / `no-empty` 9 / `no-constant-condition` 6 / `no-useless-catch` 1）。其中 renderer 的 1,081 条多数是「脚本拼接作用域」造成的假阳（跨文件调用不可见），但非 renderer 的 **~40 条是真未用变量**，外加 `src/ssh/connection-pool.js:155` 的空 catch、`src/preload.js:405` 的无用 try/catch |
| `test:tool-args`（62 条双跑夹具）与 `verify:tool-validators` 只在「按路径映射」的本地 `npm test` 里跑 | `docs/CODEMAP.json` 的 `pathRules` 有映射，但 `suites.agent` 里没有这两项；CI 跑的是 `npm run test:agent`（= `--all`，不看 diff） | 改 catalog schema / 忘了重生成校验器时，CI 仍可能全绿 |

> 反面要说清：**CI 覆盖面其实很宽**（`ci.yml` 51 行，经 `npm run test:agent` 会跑 57 个步骤，含 `test:unit`、`check:shared-constants`、`verify:rpc-catalog`、`verify:agent-events`、`check:js`、`check:renderer`、`lint:agent`，外加两套 feature 的 `cargo test` + `clippy`）。上表是三个具体的缺口，不是「CI 没做」。

---

## 三、我亲手核实的四条（不依赖子审查，可单独复核）

### 3.1 我判错并已更正的一条：`agent:main-tool-delegate` 不是死通路

第一版报告写的是「preload 暴露了两个通道，但全仓没有 Main 侧发送方与处理器，所以 `renderer-agent-tools.js` + `renderer-mutate-queue.js` 没有驱动」。**这条是错的**，起因是我的检索范围写窄了：我只扫了 `src/main/` 与 `src/*.js`，漏掉了 `src/agent/`。

实际接线（2026-11-21 复核）：

- 发送方：`src/agent/renderer-tool-delegate.js:21 requestToolFromRenderer` → `:47 webContents.send('agent:main-tool-delegate', …)`，带 300s 超时与 `RENDERER_UNAVAILABLE` 错误码。
- 谁在用：`src/agent/tool-bridge-main.js:455-456` —— `isRendererOnlyTool(toolName)` 为真时走它。`RENDERER_ONLY_TOOLS = ['agent_clarify','session_new','session_set_workspace']`（`src/agent/catalog/groups.js:88`）确实只能由渲染层执行。
- 回包：`renderer-tool-delegate.js:169 ipcMain.handle('agent:main-tool-delegate-result')`，由 `src/main-entry.js:885 registerRendererToolDelegateIpc(ipcMain)` 注册；渲染侧消费在 `src/renderer/renderer-agent-tools.js:251-282`。

所以这两个文件是**活的**。它们仍然值得处理，但理由要换成「同语义两份 + 已漂移三处（`sessionId` 口径 / 日志出口 / 快照 API）」，而不是「死代码」——等级仍是 P1，规模从「删」变成「先定一份」。

> 留在报告里的教训：**「零调用点」这种结论必须用「全仓所有文本文件」复核，不能只扫我心理上以为相关的目录**。本轮 `tools/verify-dead-exports.cjs` 就是为了这个教训写的：它把候选清单再对全仓所有文本文件核一遍。

### 3.2 `check:renderer` 的反向缺口已经有 20 处样本

扫描口径：对 `src/renderer` 每个 `^function name(` 与每个 `window.X =`，在 `src/**`（含 `index.html`）+ `src/mobile/public` 里做标识符计数，只保留「除声明行外全仓零提及」。裸扫得 28 个，剔除动态引用 / 引导注册 / 只有单测在用的之后剩 **22 个名字（20 处声明，含 2 组同簇）**，我逐条用「全仓所有文本文件」复核过（`tools/verify-dead-exports.cjs`），例如：

`renderer-settings-shell.js:103 switchPanel` · `renderer-undo-stack.js:328 initUndoStackUI` · `renderer-artifacts.js:1356 initArtifactsBtn` · `renderer-artifacts-browse.js:595 refreshWorkspaceArtifacts` · `renderer-model-runtime.js:574 getComposerSelectedModelId` · `:591 getComposerSelectedApiConfig` · `renderer-gateway.js:25 LOCAL_RPC_PREFIXES` + `isLocalOnlyMethod` · `renderer-rust-loop-boot.js:25 updateRustBootStep` · `renderer-agent-llm.js:373 safeJsonStringify` · `renderer-composer.js:84 loadComposerModelPick`。

### 3.3 本机/远端「rg 解析」有两份，但**不该合并成一份实现**

`src/gateway/rpc.js:958 parseClassicGrepLines`（远端 `grep -C` 的 `path:line:text` / `path-line-text` 双分隔符形态）与 `src/gateway/rg-search.js:253 parseRgJsonMatches`（本机 `rg --json` 的 NDJSON）——输入形态不同，**不该合并**。但两者的后半段（`byPath` → 按 before/after 组装 entry、`20000` 条原始行上限、`slice(0,400)` 截断、命中数到 `n` 即返回）是**逐字相同的两段**。可减法：抽一个 `assembleMatches(byPath, order, limit, ctx)` 纯函数，两份共用；不引入开关。

### 3.4 「Renderer 的 mutate-queue 值得收敛」有它自己的注释作证（但**不是**死代码）

`src/renderer/renderer-mutate-queue.js:6-9` 自陈：与 `src/agent/mutate-queue.js` 是「同语义的两份实现」，并且**「原先那个『并行写入』金色提示已删（判定源是这里的本地计数，而写类工具早已在 Main / Rust 执行，本地 pending 恒为 0）」**。

> 注意口径：这段注释足以说明「这一层今天能提供的收益接近 0」，但**不能**说明它没人调用 —— 3.1 里已经更正过。它的真实消费方是 `renderer-agent-tools.js:16-22`，而那条通路接到 `RENDERER_ONLY_TOOLS` 的反向委托上，是活的。所以这条的正确等级是 **P1 重复实现**（先定一份、再删多余那份），并且删之前必须手测三个委托工具，不能当零风险删除处理。

---

## 四、分域发现

> 每条含：`file:line` 证据 / 为什么算不整洁 / **减法方案** / 验证方式 / 是否在既有文档里已记录（`already_on_record`）。
> 等级：**P0** 已漂移、正在或即将产生真实 bug；**P1** 确定可删或可合并、成本小；**P2** 结构性、需分批；**P3** 小卫生。

### 4.0 总览（本轮共 89 条：P0 6 / P1 26 / P2 34 / P3 23）

| 域 | P0 | P1 | P2 | P3 | 一句话 |
|---|---:|---:|---:|---:|---|
| `agent` | 0 | 4 | 2 | 6 | 没有 P0：src/agent 里「已漂移成真实 bug」级别的重复，上一轮（REDUNDANCY-REVIEW / NODE-THINNING / MODULE-CHAOS）基本 |
| `renderer` | 2 | 3 | 5 | 2 | Renderer 最大的整洁问题不是「重复函数」而是「同一语义两份、靠注释维系，且已在两侧给出不同答案」：录音转写、tool_call 标签剥离、模型设置归一化三对都还在漂移，其中 |
| `main-gateway` | 1 | 3 | 7 | 1 | 中下，但比提示里预期的干净 |
| `features` | 0 | 1 | 6 | 4 | 没有 P0：这个域里「已经漂移成真实 bug」的重复，上一轮基本收完了（识别规则三份→一份、凭据存储三份→secret-store、增量调度骨架两份→工厂、mutate-queue |
| `rust` | 0 | 6 | 3 | 3 | 整体已从「巨石 + 吞错」收敛到「五层 crate + 注册表分派」：rpc/mod |
| `scripts-tests` | 1 | 4 | 4 | 3 | 不通过 |
| `single-source` | 2 | 2 | 2 | 2 | 抽查 14 条「唯一来源」声明：11 条实测成立（llm-request 端点/头、tool-gate 关卡顺序、agent-round-text |
| `diff` | 0 | 3 | 5 | 2 | 中上 |

> 域内顺序即建议顺序：P0 先止血，P1 是零风险减法，P2 需分批，P3 可顺手。

### 4.1 src/agent（含 src/agent/catalog、src/agent/main-tools）

**总评**：没有 P0：src/agent 里「已漂移成真实 bug」级别的重复，上一轮（REDUNDANCY-REVIEW / NODE-THINNING / MODULE-CHAOS）基本修完了 —— 交付四态文案、工具校验生成物、增量调度器、凭据存储、忽略规则、mutate-queue 的 12*60*1000 都已收口。本次值钱的是四件「单一来源被绕过 / 第二份实现已无收益」：① 删 Renderer 的 mutate-queue（它自陈的唯一用途『并行写入提示』已删，本地 pending 恒为 0，且已和 Main 分叉三处）；② 把工具结果摘要收成一份（Main 的 live-loop-trace 与 Renderer 的 renderer-tool-results 已漂出 4 处不同文案，同一张思考区里两种说法）；③ 计划轮与 main-turn-runner 是两份同形编排，而 AGENTS.md:58 写着「Main 侧跑一轮的唯一实现，频道/计划/headless 共用」，声明不成立；④ 「这个工作空间是不是远端」在本目录里还有 4 处内联正则，其中 delegate-tool-gateway 同一个文件里既 require 了唯一来源又内联了一遍，且 `^ssh://` 与 `^ssh:` 结论不同。另有两件结构性账（tier 存储脚手架两份、knowledge-maintainer.js 1653 行五职责）与六件小卫生。核对后**不报**：agent-limits.js 作为数字主源与「不拆大文件」（既有负向清单已裁定，本目录里 knowledge*/alive*/desktopCamera* 等键确实都在这一份里）；guardrails-shared.js 的工具清单与 tool-gate.js 的关卡顺序（真单一来源，含『这份清单同时是心跳轮工具表』的派生）；tool-validate.js 与 tool-validate.generated.js 的边界（机械校验已由生成物接管、手写只剩语义判定，且有 verify + 62 条双跑夹具，属既定设计而非混放）；agent-limits-by-tier.js 与 agent-limits.js 的循环 require（注释已写明原因）；rust-planner-runner.js 的 `while (phase.phase !== 'done')`（那是 planner.run.* 协议的薄转发，续跑判定仍在 core，没有长出第二份「该不该继续」）；context-signals.js ↔ system-prompt-prep.js 的克隆窗口（**假阳**：system-prompt-prep.js:1350-1356 只是把 context-signals 的六个函数再导出一次，实现只有一份）；测试与实现同居（src/agent 106 个文件里 0 个 describe/it）；陈旧 TODO/FIXME（全目录 3 处命中都是 `TODO 清单` 这类文案，不是待办）。

**审查口径与实读范围**：范围：src/agent + src/agent/catalog + src/agent/main-tools，共 106 个 .js。实读文件：mutate-queue / renderer-mutate-queue / renderer-agent-tools / main-turn-runner / plans/plan-agent-runner / plans/runner / headless/desktop-turn / rust-loop-runner / rust-planner-runner（关键区段）/ live-loop-trace / renderer-tool-results / context-signals / system-prompt-prep / agent-round-text / agent-limits（尾部 API 区）/ agent-limits-by-tier / model-runtime-by-tier / model-runtime-schema / shared-constants + agent-shared.json / knowledge-maintainer（多处）/ tool-bridge-main / tool-validate / tool-classify / guardrails-shared / completion-readiness（引用处）/ session-transcript / session-context（区段）/ service.js（头部）/ delegate-tool-gateway（区段）/ workspace/target.js / main-entry.js（require 区）。行数用 [System.IO.File]::ReadAllLines().Count 实测：agent-limits 1819、knowledge-maintainer 1653、system-prompt-prep 1369、rust-planner-runner 1304、session-context 1045、delegate-tool-gateway 970、rust-loop-runner 932、guardrails-shared 897、tool-bridge-main 858、tool-validate 817、tool-validate.generated 3016、live-loop-trace 630、tool-gate 578。4 组克隆窗口逐组核实：mutate-queue（真重复、已漂移 3 处）、live-loop-trace↔renderer-tool-results（真重复、已漂移 4 处）、main-turn-runner↔plan-agent-runner（真重复骨架 + AGENTS 声明不符）、agent-limits-by-tier↔model-runtime-by-tier（真重复脚手架）、context-signals↔system-prompt-prep（假阳）。另做一次导出读点扫描（对 src/ + test/ + scripts/ 全量词边界计数）：34 个模块导出在自身文件外零引用，其中可确认为纯死导出（仅内部使用仍对外暴露）的 8 个已收进一条 finding。未跑任何运行时行为验证（只读审查）。

#### agent-1 [P1] Renderer 的 mutate-queue 是第二份实现（自陈的唯一用途已删）且已与 Main 分叉三处；但这条通路是活的，不能按死代码删

- **类型**：重复实现 / 可缺席的装饰层（原则 2） · 规模 **S**
- **证据**：
  - `src/renderer/renderer-mutate-queue.js:6-9 —— 文件头自陈「与 src/agent/mutate-queue.js 是同语义的两份实现」，并写明「原先那个『并行写入』金色提示已删（判定源是这里的本地计数，而写类工具早已在 Main / Rust 执行，本地 pending 恒为 0）」`
  - `src/renderer/renderer-agent-tools.js:16-22 —— 全仓唯一消费点：'window.MutateQueue' 取不到就直接 'return fn()'，说明它本身就是可缺席的装饰层`
  - `src/renderer/renderer-mutate-queue.js:66-124（runExclusive 主体）↔ src/agent/mutate-queue.js:91-154 —— 同形：闸门/gate、watchdog、openGate/settleAccounting 逐段对应`
  - `已漂移①：src/agent/mutate-queue.js:129 'sessionId: String(opts.sessionId || holder || '')' vs src/renderer/renderer-mutate-queue.js:100 'sessionId: String(holder || '')'`
  - `已漂移②：src/agent/mutate-queue.js:138-141 走注入的 logHook（src/main-entry.js:109 注入 electron-log）vs src/renderer/renderer-mutate-queue.js:108-115 裸 console.warn`
  - `已漂移③：src/agent/mutate-queue.js:182-190 有 getWorkspaceMutateSnapshot（诊断快照），Renderer 那份没有`
  - `src/renderer/index.html:2718 —— 仍在按 <script> 加载这份文件`
- **为什么不整洁**：写类工具真正在 Main 串行（src/agent/tool-bridge-main.js:286-287 runExclusiveMain → agent/mutate-queue，调用点 :471）；Renderer 这一份服务于「Main 反向委托 UI 工具」那条通路（src/agent/renderer-tool-delegate.js:47 → src/renderer/renderer-agent-tools.js:251-282，RENDERER_ONLY_TOOLS 三个工具走它），所以**不是死代码**。它自己的注释写明「本地 pending 恒为 0、原先的『并行写入』提示已删」——即这一层今天能提供的收益接近 0，属于可缺席的装饰层。两份已分叉 sessionId 口径 / 日志出口 / 快照 API 三处，第三份能力（快照）只在 Main 有。
- **减法方案**：先定一份：既然 Main 的 runExclusiveMain 已在真实执行点串行，Renderer 侧只保留「取不到就直跑」的语义 —— 删 src/renderer/renderer-mutate-queue.js（159 行）与 index.html 的 script 标签，renderer-agent-tools.js:16-22 的 runExclusiveAgentTool 收敛成直接 invoke()。若将来要在渲染层展示「工作区忙」，读 Main 已有的 getWorkspaceMutateSnapshot，不要在这里再记一份计数。**注意：这不是死代码删除，需手测委托通路**。
- **验证**：npm run check:renderer + npm run test:agent；手测 RENDERER_ONLY_TOOLS 三件（弹一次确认卡 / 新建对话 / 换工作空间），确认委托通路仍通。
- **既有记录**：docs/REDUNDANCY-REVIEW-2026-11-03.md A4（:38-42）判「优先删掉 Renderer 那份」；其 P0 执行记录（:156）只修了数字（改为读 agent-limits.toolStallMs），两份实现仍在；同条建议里「删掉并行写入提示」已执行 —— 于是删实现的成本比当时更低，现在仍然成立。

#### agent-2 [P1] 工具结果摘要两份：Main 的 live-loop-trace 与 Renderer 的 renderer-tool-results 已漂出 4 处不同文案 · **已合流（2026-11-21，见 §8.5②）**

- **类型**：重复实现（已漂移） · 规模 **S**
- **证据**：
  - `src/agent/live-loop-trace.js:370-395（summarizeLoopTool）↔ src/renderer/renderer-tool-results.js:76-130（summarizeToolResult）—— 同一件事：把工具结果压成一行给思考区`
  - `逐字同形段：src/agent/live-loop-trace.js:375-386 ↔ src/renderer/renderer-tool-results.js:84-92（fs_write_file / fs_edit：文件名 + 新建/已替换/已写入 + '+N -M' + 'N 处'）`
  - `已漂移①：src/agent/live-loop-trace.js:400-402 'result.timedOut && result.stillRunning' → 「转后台继续运行（句柄）」vs src/renderer/renderer-tool-results.js:55-58 'result.detached' → 「已后台启动 PID」——两个字段名、两种说法`
  - `已漂移②：src/agent/live-loop-trace.js:410 的『看起来不像输出』正则只有 4 支（'/*' '#' '<!DOCTYPE' '<html'）vs src/renderer/renderer-tool-results.js:66 多一支 '^import '`
  - `已漂移③：src/agent/live-loop-trace.js:411 把非零 exit 压成 'exit ${exit ?? 0} · 输出 N 字'（丢掉真实退出码）vs src/renderer/renderer-tool-results.js:67 保留 'exit ${exit}'`
  - `已漂移④：无输出兜底 src/agent/live-loop-trace.js:417 '完成' vs src/renderer/renderer-tool-results.js:73 '命令成功（无输出）'`
  - `失败前缀也不同：src/agent/live-loop-trace.js:311-313/:371 用 '错误: …'，src/renderer/renderer-tool-results.js:78-81 用「失败：[CODE] … · suggestedFix」`
- **为什么不整洁**：两条路径写进的是**同一块思考区**：桌面主循环的工具行由 Renderer 摘要，planner 执行器 / 并发子 Agent 的工具行由 Main 的 live-loop-trace 摘要（rust-planner-runner.js:558-567 用 createLiveLoopTraceTracker）。用户同一屏里会看到「已后台启动 PID 123」和「转后台继续运行（hostproc-7）」两种说法，且其中一份把非零退出码丢了 —— 这是「同一语义两份实现」的典型已漂移形态，而它影响的是模型/用户判断工具到底成没成。
- **减法方案**：抽 src/agent/tool-result-summary.js（零依赖：只吃 name + result 对象，产出那一行字符串），Main 侧 live-loop-trace 直接 require，Renderer 侧经 agent-bundle 镜像成 window（与 AgentRoundText / GuardrailsShared 同一条既有通道）。两侧差异（timedOut/detached）先在合并前定成一处判据：`(r.timedOut && r.stillRunning) || r.detached` → 统一文案。
- **验证**：`npm run test:agent`、`npm run test:planner-workers`；手测：分别跑一次「长命令转后台」+「fs_edit」在桌面轮与 planner 轮里对比工具行文案是否一致。

#### agent-3 [P1] 「跑一轮」的编排有两份：plan-agent-runner 与 main-turn-runner 同形，AGENTS.md:58 的「唯一实现」声明不成立 · **部分合流（2026-11-21，见 §8.6③）**

- **类型**：重复实现（同一语义两份编排）+ 文档单一来源声明失真 · 规模 **M**
- **证据**：
  - `AGENTS.md:58 —— 「'src/agent/main-turn-runner.js'（Main 侧跑一轮的唯一实现，频道/计划/headless 共用）」`
  - `src/plans/runner.js:68 —— 计划实际调用的是 runPlanAgentLoop，不是 runMainTurn`
  - `模型解析同形：src/plans/plan-agent-runner.js:122-144 ↔ src/agent/main-turn-runner.js:106-122（loadModelSettings + resolveTextApiConfig + 缺 key/缺模型两段报错 + tier + budget + apiCfg 整体继承）`
  - `预算同形：src/plans/plan-agent-runner.js:154-155、:167-169 ↔ src/agent/main-turn-runner.js:116-121（applyTierRuntime + getEffectiveInputBudget + '{...llm, baseUrl, apiKey}' 同一句注释）`
  - `历史装配同形：src/plans/plan-agent-runner.js:52-73、:160-162 ↔ src/agent/main-turn-runner.js:261-289（memory.messages_recent limit 120 → 只留 user/assistant → buildCompletionMessagesFromHistory + 同一份 helpers）`
  - `循环装配同形：src/plans/plan-agent-runner.js:186-225 ↔ src/agent/main-turn-runner.js:303-368（runRustAgentLoop 的参数集合、maxToolCalls/maxRounds、compactMessages、turnEndSynthesis、finally clearToolHarnessSessionsForSession 逐项对应）`
  - `收尾同形：src/plans/plan-agent-runner.js:272-293 ↔ src/agent/main-turn-runner.js:464-487（同一个 afterAgentRun 调用 + 同一个 'catch {}' 吞掉）`
  - `已漂移文案：src/plans/plan-agent-runner.js:259-260「…请查看日志后重跑」vs src/agent/main-turn-runner.js:402-403「…请查看日志后重试」——同一句空交付报错两种措辞`
- **为什么不整洁**：AGENTS.md 把「Main 侧跑一轮」写成单一来源，现实是计划走自己的一份骨架，两份已经在小处漂移（空交付文案），且每加一个「本轮要注入什么 / 怎么落库」的改动都要改两处。这正是 REDUNDANCY 结论 1 说的「最大一类冗余是同一语义在不同层各写一遍编排」。计划侧真正独有的只有三件事：计划专用 system 块（:23-50）、GOAL_TOOLS 追加（:165）、plan 的 modelRoute/strict 解析（:123-127）+ mutatingToolCalls 统计（:175/:222）—— 其余都应是 main-turn-runner 的入参。
- **减法方案**：两条路二选一，我倾向合并：把 runMainTurn 的入参补三个可选口（`systemBlocks` / `extraTools` / `modelRoute+model`），删掉 plan-agent-runner 的模型解析、历史装配、循环装配、收尾四段（保留 :23-50 的 system 块与 :175 的事实统计）；否则至少把 AGENTS.md:58 的声明改成「频道/headless/生命感共用；计划另有 plan-agent-runner」，并把 :122-144 与 :160-162 改调 main-turn-runner 已导出的 resolveTurnModel / buildCompletionMessagesFromHistory 包装。同时统一那句空交付文案（一个常量放 agent-round-text）。
- **验证**：`npm run test:rust-planner-smoke`、`npm run test:planner-e2e`、`npm run test:agent`；手测：跑一次定时计划 + 一次频道轮 + 一次 headless run，确认三者都还落 user/assistant 两条、trace 有 runId、记忆归纳仍触发。
- **既有记录**：docs/MODULE-CHAOS-REVIEW.md §6.4（:170）只记了「main-turn-runner 没有 judgeAfterTurn / goal.cont」（那是另一件事：会话目标续跑只在桌面链路）。「计划走第二份骨架、AGENTS.md 声明不符」尚未记账。

#### agent-4 [P1] 「这个工作空间是不是远端」还留着 4 处内联正则；delegate-tool-gateway 同一文件里既 require 了唯一来源又内联一遍，且判据不同

- **类型**：层级越界 / 单一来源被绕过（AGENTS.md「这条路走本机还是远端主机」） · 规模 **S**
- **证据**：
  - `唯一来源：src/workspace/target.js:34-36 'isRemoteWorkspacePath(input) { return /^ssh:/i.test(...) }'（导出 :242）`
  - `src/agent/delegate-tool-gateway.js:13 已经 require 了 isRemoteWorkspacePath、:79 用了它，但 :247 又内联 '/^ssh:\/\//i.test(String(base))'、:262 内联 '/^ssh:\/\//i.test(w)'`
  - `src/agent/main-turn-runner.js:82 'kind: /^ssh:/i.test(workspacePath) ? 'ssh' : 'local''`
  - `src/agent/rust-planner-runner.js:273 'const remoteWorkspace = /^ssh:/i.test(String(workspacePath || ''))'（:873 据此选「远端会话 / 本地工作区」文案）`
  - `src/agent/service.js:24 'return /^ssh:/i.test(s) ? s : s.toLowerCase()'（sameWorkspacePath 的比较口径靠它分支）`
  - `对照正例：src/agent/host-sidecar.js:5 就是 require 同一个 helper 再判`
- **为什么不整洁**：两套判据在**同一个字符串形态上结论相反**：helper 认 `^ssh:`（含 legacy `ssh:user@host:/path`），delegate-tool-gateway 的两处认 `^ssh://`（要求两条斜杠）。于是同一台机器上 legacy 形态的远端工作区，一处判远端、一处判本地 —— 后者会把 base 当成可拼接的本地根，拼出 `ssh:user@host:/path/src/…` 这种假路径（与 docs/SSH-MODULE-REVIEW / target.js:71-75 记的那类事故同形）。AGENTS.md 已把这条判定收口到「唯一入口」并明令「在 handler 里各写一份 startsWith('local:') 或各判一次」为反模式。
- **减法方案**：四处改调 `isRemoteWorkspacePath`（工作量 6 行）。若确实需要区分「严格 URI 形态」，就在 workspace/target.js 里加第二个具名函数（`isRemoteWorkspaceUri`）并写清与 `isRemoteWorkspacePath` 的差别 —— 不要在调用点各写正则。
- **验证**：`npm run test:local-gateway-smoke`、`npm run test:agent`；`git grep -n "ssh:\\\\/\\\\/" src/agent` 应只剩 workspace/target.js 一处。

#### agent-5 [P2] 按档持久化的脚手架两份（agent-limits-by-tier ↔ model-runtime-by-tier），且「只存覆盖」规则各写一遍

- **类型**：重复实现（同语义脚手架） · 规模 **M**
- **证据**：
  - `src/agent/agent-limits-by-tier.js:18-19 STORAGE_KEY / LEGACY_STORAGE_KEY、:52-61 extractOverrides（与工厂值相同即不存）、:63-73 读 localStorage、:75-81 写、:83-98 legacy 迁移、:110-168 get/set/reset/getAll/hydrate、:170-174 isLimitsByTierShape`
  - `src/agent/model-runtime-by-tier.js:70-89 localStorage 读写、:98-137 getRuntimeValuesForTier/set/reset、:109-117 extractRuntimeOverrides、:188-200 saveRuntimeByTierToMain、:204-214 hydrate、:216-224 getAll、:234-262 migrateGlobalSettingsToDefaultTier`
  - `两处「只存覆盖」的同一份规则：src/agent/agent-limits-by-tier.js:56-59 vs src/agent/model-runtime-by-tier.js:113-115（都是 'factory[k] === v → continue'）`
  - `磁盘侧也各有一套：src/agent/model-runtime-by-tier.js:161-200（model-runtime-by-tier.json）vs src/agent/agent-limits.js:1667-1736（agent-limits-by-tier.json + legacy 迁移）`
  - `src/agent/model-runtime-by-tier.js:10 注释自陈「与 agent-limits-by-tier.json 同邻同形」，即用注释代替单一来源`
- **为什么不整洁**：两份 ~140 行脚手架（读 / 写 / 迁 legacy / 只存覆盖 / hydrate / shape 判定）承担完全相同的语义，只是数据键不同；两份都已经各自写过一次 legacy 迁移（agent-limits 是 `dieyun.agent-limits.v1`，runtime 是全局 settings → default 档），任何一条口径（比如「未知档位丢弃」「同值不落盘」）改一边就分叉。这是本轮唯一还没做的「同语义两份脚手架」。
- **减法方案**：抽 `src/agent/tier-store.js` 工厂：`createTierStore({ storageKey, legacyKey, defaults, normalize, extractOverrides, file })`，两份退化为「键 + 默认值 + 归一化函数」三行；Main 侧的磁盘版同理共用 `loadFromDisk/saveToDisk`。
- **验证**：`npx vitest run test/unit/`（tier / agent-limits / model-runtime 相关）、`npm run test:agent-limits`、`npm run check:renderer`；手测：改一档极限值 → 重启 → 该档生效、其它档不受影响。
- **既有记录**：docs/REDUNDANCY-REVIEW-2026-11-03.md A14（:107）已记「抽 tier-store 工厂」，未执行；同条里 `model-runtime-by-tier.js:293/301` 的 8192 已改读 shared-constants（本次复核确认），:359 与 model-runtime-schema.js:33 仍未改（见本报告 P3 条）。

#### agent-6 [P2] knowledge-maintainer.js 1653 行、五类职责同居；文件内部同一张设置字段表还写了两遍

- **类型**：超长文件 / 职责混杂 + 重复实现（同文件内） · 规模 **L**
- **证据**：
  - `src/agent/knowledge-maintainer.js:1-1653 —— 共 1653 行（[System.IO.File]::ReadAllLines().Count 实测；本目录第一大非 limits 文件）`
  - `职责分组：设置存储 :141-218、提示词与规则文本 :60-140、触发信号与门闩 :272-357、记忆写入（global/项目/共享镜像）:432-580、AGENTS.md 更新 :581-636、共享记忆提炼 :893-985、周期任务与 LLM 调用 :713-892、定时器/队列工厂 :1275-1588、对外入口 :1609-1633`
  - `同文件内重复：:152-167 normalizeKnowledgeSettings 与 :190-205 applyKnowledgeSettingsPatch —— 同一张 7 字段表、同一套「枚举内才收 / 布尔才收 / slice(0,240)」规则各写一遍`
  - `格式化上限仍散在文件里：:165 与 :203 'slice(0, 240)'、:228 'Number(max) || 360'、:237 'slice(0, 180)'`
- **为什么不整洁**：这是 src/agent 里第二大文件，而它的职责横跨「配置文件 IO / 提示词 / 记忆落库 / 共享记忆 PG 上传 / 定时器」，任一处改动都要在 1600 行里定位；更实际的风险是 :152-167 与 :190-205 那份字段表：加一个新设置字段时漏改第二份，就是「设置页能存、运行时忽略」的静默失效（该文件注释里已记过一次同类事故：:185-189）。注：它的数字已经归口（agent-limits.js:419-454 的 knowledge* 块，注释写明「唯一读者是 knowledge-maintainer.js」），所以本条不是魔法数字问题，是职责与文件长度问题。
- **减法方案**：按现有注释的自然断点切三刀（纯移动，不改逻辑）：`knowledge/settings.js`（:141-218 + :169-173，同时把两份字段表合成一份 `applyPatch(base, patch)`）、`knowledge/prompt.js`（:60-140 + :224-271 的 compact/summarize）、`knowledge/apply.js`（:412-712 记忆与 AGENTS 落库）。`:1275+` 的工厂留原处或另立 `knowledge/scheduler.js`。验收只认 `npm run test:knowledge-maintainer` + `test:system-prompt-prep` 全绿。
- **验证**：`npm run test:knowledge-maintainer`、`npm run test:project-memory-file`、`npm run test:agent`；`git grep -n "normalizeKnowledgeSettings"` 确认只剩一份字段表。

#### agent-7 [P3] 轮次上限的「唯一来源」函数没有生产调用点：四处调用方各自内联同一个 clamp

- **类型**：死代码 / 单一来源空转 · 规模 **S**
- **证据**：
  - `src/agent/agent-limits.js:1751-1759 'resolveAgentMaxRounds(settings)'，注释写明「轮次上限的唯一来源…Loop 启动前由 applyResolvedLoopSpec 填进 agent.loop.start」；导出 :1815`
  - `它的唯一消费点是同文件 :1769（resolveAgentLoopSpec 内部），而三个真实 runner 全部绕过它自己写 clamp：src/agent/main-turn-runner.js:325、src/plans/plan-agent-runner.js:202、src/headless/desktop-turn.js:220（'clampModelRuntimeValue('agentMaxRounds', …)'）`
  - `第四处同样形式：src/agent/rust-planner-runner.js:589-592（'Number(spec.maxRounds) > 0 ? … : settings.agentMaxRounds' 再 clamp）`
  - `对照正例：同文件的 resolveLoopToolCallLimit（:1747-1749）被三处正常调用（main-turn-runner.js:324、plan-agent-runner.js:201、desktop-turn.js:219）`
- **为什么不整洁**：同一个「轮次上限」有两个写法：一处包成函数并声明是唯一来源，四处调用点却内联 `clampModelRuntimeValue('agentMaxRounds', …)`。今天两写法等价（都是 15–1200 夹取），但只要将来给轮次加上「档位缺省 / 子 Agent 倍率 / 下限」任一规则，四处不会跟着变 —— 与 :1754-1755 注释里反对的「跨语言各留一份默认值」是同一种病，只是发生在同一侧。
- **减法方案**：四处改成 `resolveAgentMaxRounds(runSettings)`（rust-planner-runner 那处改成 `spec.maxRounds > 0 ? clampModelRuntimeValue('agentMaxRounds', spec.maxRounds) : resolveAgentMaxRounds(settings)`），或反过来删掉 resolveAgentMaxRounds 并把注释改准。二选一，不要两个都留。
- **验证**：`npm run test:agent-limits`、`npm run test:rust-planner-smoke`、`npm run check:js`；`git grep -n "'agentMaxRounds'"` 的调用点应收敛到 agent-limits 与 model-runtime-schema 两处。

#### agent-8 [P3] 一批导出只有内部使用仍对外暴露（8 个可确认的死导出）

- **类型**：死代码（未使用导出） · 规模 **S**
- **证据**：
  - `src/agent/session-context.js:1012 'META_STRING_MAX'（仅 :81 / :122 内部用）、:1026 'GOAL_CONTINUE_USER_PREFIX'（仅 :305/:321 内部用）、:1028 'isAliveStateUserContent'（仅 :330 内部用）`
  - `src/agent/session-title.js:229 'TITLE_SOURCE_AI'（仅 :32 / :211 内部用）`
  - `src/agent/browser-vision.js:323 'MAX_SHOTS_PER_RUN'（仅 :53 / :78-88 内部用）`
  - `src/agent/turn-reviewer.js:214 'buildReviewerBrowserEvidence'（仅 :122 内部用）`
  - `src/agent/mutate-queue.js:193 'resolveStallMs'（仅 :39 内部用）`
  - `src/agent/session-transcript.js:59-60 'TRANSCRIPT_FIELDS' / 'projectTranscriptMessage'（仅 :37 / :54 内部用；外部只消费 transcriptFromMessages，见 src/agent/session-context.js:30 与 src/renderer/agent/agent-bundle-entry.js:28）`
- **为什么不整洁**：这批名字在 +自身文件+ 之外（src/、test/、scripts/ 全量、含 json 里的名字串）零引用（词边界计数）。它们让「这个模块对外承诺了什么」失真：读代码的人会以为 META_STRING_MAX 是可供调用的契约阈值，实际改动它只影响本文件；agent-bundle 的镜像清单也不会因为多一个名字而报警。这与 NODE-THINNING N4.1「渲染层零调用点导出闸门」是同一类问题，只是发生在 Main 侧。
- **减法方案**：逐个从 module.exports 删名（保留 const 与内部使用），一次提交、零行为变化。若要防复发，把 N4.1 的 dead-export 报告脚本扩到 src/agent（先报告不拦）。
- **验证**：`npm run test:unit`、`npm run check:js`、`npm run check:contracts`（CODEMAP 若引用了这些名字会红）。

#### agent-9 [P3] 8192 这个「窗口下限」仍有两处字面量，而单一来源（agent-shared.json）就在隔壁且已被消费

- **类型**：魔法数字该进既有单一来源 · 规模 **S**
- **证据**：
  - `单一来源：src/agent/agent-shared.json:10 的 '"contextWindowFloorTokens": 8192'（Node 经 src/agent/shared-constants.js:28 读）`
  - `已改好的同族：src/agent/model-runtime-by-tier.js:293 'CONTEXT_WINDOW_FLOOR = require('./shared-constants').compaction.contextWindowFloorTokens'、:301 'MIN_INPUT_BUDGET_TOKENS = CONTEXT_WINDOW_FLOOR'`
  - `未改①：src/agent/model-runtime-schema.js:33 'min: 8192'（contextWindow 的 schema 下限）—— 而 src/agent/model-runtime-by-tier.js:292 的注释用的是「与 model-runtime-schema 的 min 对齐」这种注释型约定`
  - `未改②：src/agent/model-runtime-by-tier.js:359 'if (/\b8k\b/.test(name)) return 8192;'`
- **为什么不整洁**：同一个「8k 窗口」在三处各写一次 8192，两处读共享常量、两处仍是字面量。注释里「与 X 对齐」正是 NODE-THINNING N1.1 要消灭的形态（该文档 :49 已经点名 model-runtime-by-tier 是这类手抄点）。改动风险低：值相同，只是把来源收成一处。
- **减法方案**：model-runtime-schema.js 引 shared-constants 取同一个键（它已经在 require ./model-runtime-presets，加一行无新依赖）；:359 复用文件内已有的 CONTEXT_WINDOW_FLOOR，并把 :292 的「对齐」注释删掉。
- **验证**：`npm run check:shared-constants`（每个键两侧都有人读）、`npm run test:agent-limits`、`npm run test:unit`。
- **既有记录**：docs/REDUNDANCY-REVIEW-2026-11-03.md A14（:107）记「8192 又散在 model-runtime-by-tier.js:293/301/359 与 model-runtime-schema.js:33」。2026-11-19 的 shared-constants 收敛把 :293/:301 修掉了，:33 与 :359 仍在 → 条目半修，仍成立。

#### agent-10 [P3] browser_snapshot / browser_observe 的 textPreview 6000 字符上限写了两遍，且与 snapshot 脚本里那份不同源

- **类型**：魔法数字该进既有单一来源 · 规模 **S**
- **证据**：
  - `src/agent/tool-bridge-main.js:256-257（browser_snapshot：'length > 6000' → 'slice(0, 6000) + '…''）`
  - `src/agent/tool-bridge-main.js:263-264（browser_observe：同一段逐字复制，只差没有 outputFile 判定）`
  - `src/browser/snapshot-script.js:468 —— 采集端也按 6000 截 'textPreview'（同一个语义的第三个落点）`
  - `agent-limits.js 里没有对应键（最接近的 'dieyunMdMaxChars: 6000'（:348）是另一件事）`
- **为什么不整洁**：这是模型可见的截断阈值，同时出现在「采集」「出站净化」两处，且净化侧复制了两份；三处任一处单改就会出现「采集截到 6000、净化按 4000 再截」或反之的静默截断。MODULE-CHAOS §11.1 已经把 6000 当成断言写进 test:tool-bridge-handlers（「browser_snapshot 6000 字符截断但已落盘时不截断」），说明它是被承诺的行为，更该有单一数字。
- **减法方案**：agent-limits 增 `browserSnapshotPreviewMaxChars`（或复用既有的 snapshot 类键），三处改读；净化侧那两段顺带合成一个小函数 `capSnapshotPreview(result, {requireNoOutputFile})`。
- **验证**：`npm run test:tool-bridge-handlers`、`npm run test:browser-smoke`。

#### agent-11 [P3] base64 剥离信封手写 4 份：同一组 5 个字段在四处反复罗列

- **类型**：重复实现（同形白名单，改一处漏三处） · 规模 **S**
- **证据**：
  - `src/agent/tool-bridge-main.js:156-193（computer）、:195-211（camera_look）、:212-227（desktop_camera_look）、:228-253（browser_screenshot）`
  - `四份里逐字相同的五件事，每份各抄一遍：visionImage/visionTokens（:180-181、:205-206、:221-222、:244-245）、base64Omitted/base64Length（:186-187、:207-208、:223-224、:249-250）、note 兜底（:190-192、:209、:225、:251）`
  - `回归网已存在：test/unit/computer-tool-pipeline.test.cjs:9（'const { sanitizeToolResultForApi } = require('../../src/agent/tool-bridge-main')'）、test/unit/computer-action-honesty.test.cjs:18 —— 所以收敛有测试兜底，属「可安全合并」`
  - `调用点只有一个：src/agent/tool-bridge-main.js:823（after 关卡的 sanitize-result）`
- **为什么不整洁**：视觉信封的五个字段是**契约**（模型/UI 两边都读），现在靠四段手抄维持：加一个字段（例如将来要带 `visionSource`）必须改四处，漏一处就变成「某个工具的图不进视觉通道」—— 而这类失败是静默的（模型只会说看不见）。这正是 MODULE-CHAOS §3.1 记的「按工具名硬编码 if 链 + 手列字段白名单」的残留形态。
- **减法方案**：抽 `visionOmissionEnvelope(result, { keep, note })`：公共 5 字段由它统一加，每个工具只交自己的 `keep` 列表；`browser_snapshot` / `browser_observe` 的预览截断同理（可与上一条 6000 一起做）。不改语义，测试兜底。
- **验证**：`npm run test:tool-bridge-handlers`、`npx vitest run test/unit/computer-tool-pipeline.test.cjs test/unit/computer-action-honesty.test.cjs`。
- **既有记录**：docs/MODULE-CHAOS-REVIEW.md §3.2 A2（:64）已给方案「sanitizeToolResultForApi 改表驱动（每工具一条 {omit, keep}）」；同表 §3.1#5（:51）记的「结果清洗零测试」已**不再成立**（现有 2 个测试文件引用），本次复核更新；实现仍是四份手写。

#### agent-12 [P3] planner 的 8 处 console.warn 不走同层已有的日志钩子，planner 的排障日志进不了 electron-log 文件

- **类型**：console.* 当日志 · 规模 **S**
- **证据**：
  - `src/agent/rust-planner-runner.js:319-322（副本回收失败）、:352（模型接口连接中断重试）、:906（本批实际并发）、:1151 / :1186 / :1191（worker/评审异常）、:1234（收尾 note）—— 全是裸 console.warn`
  - `同层已有机制：src/main-entry.js:109 'require('./agent/mutate-queue').setMutateQueueLog((m) => log.warn(m))'、:112 'require('./agent/rust-loop-runner').setLoopRunnerLog((m) => log.warn(m))'（log = electron-log，:36）`
  - `该机制的自我说明：src/agent/rust-loop-runner.js:253-260「日志出口由 Main 注入（electron-log）…一个模块一个钩子，避免 4 个调用点各传一遍」`
- **为什么不整洁**：同一个 crate 级日志约定里，主循环与写队列都把日志交给 electron-log 落文件，只有 planner（同样是长跑、同样会产生「重连中 / 回收失败 / 并发被夹」这些事后要看的事实）直接 console.warn —— 在 Electron 主进程里 console 只到终端，用户点「打开日志」看不到。src/agent 其余 console.* 里，knowledge-maintainer / main-turn-runner 的也都带 `[dieyun:*]` 前缀走同一套既有习惯，planner 这 8 处不是「漏了前缀」而是「漏了出口」。
- **减法方案**：照 mutate-queue / rust-loop-runner 的既有做法加一个 `setPlannerRunnerLog(fn)`（不要新机制：同形的第三个钩子），main-entry 注入处加一行；8 处 console.warn 换成模块内 runLog。
- **验证**：`npm run test:rust-planner-smoke`、`npm run test:agent`；手测：断网跑一次 plan，确认「模型接口连接中断…」出现在 electron-log 文件里。

### 4.2 src/renderer（119 个 .js，排除 dist）+ src/mobile/public 对照

**总评**：Renderer 最大的整洁问题不是「重复函数」而是「同一语义两份、靠注释维系，且已在两侧给出不同答案」：录音转写、tool_call 标签剥离、模型设置归一化三对都还在漂移，其中前两对的漂移会直接表现为用户可见的错误（手机端转写卡住无法取消 / 气泡里漏出工具标记）。此外 245 行顶层函数全仓零调用点、check:renderer 至今只做单向校验（N4.1 未做），以及收尾落库的 35 行块在一个文件里写了 4 遍。所有建议都是删 / 合并 / 搬进既有单一来源，没有一条需要新增开关或状态机。

**审查口径与实读范围**：119 个 .js / 58,037 行（ReadAllLines 实数，排除 dist）；≥1400 行文件 5 个、≥90 行函数 106 个；index.html 123 个 <script>。8 行滑窗（标识符归一）复测给定 6 组：voice.js↔renderer-composer-voice.js 91 窗（各 370 行，几乎同构）、renderer-codebase-panel↔renderer-graph-panel 88 窗、renderer-agent-continue↔renderer-thinking-trace 21 窗（96-121 与 662-687 逐字符相同）、model-settings↔renderer-model-runtime 28 窗、agent/trace-store↔renderer-agent-complete 28 窗、renderer-agent-prep↔renderer-rust-loop-boot 11 窗。零调用点顶层函数实测 20 个（约 245 行，逐条见第 3 条）；console.* 106 处、裸 console.warn(err) 49 处、拒绝式空处理（`.catch(空函数)` 一族，含 `e => {}`）168 处、真空 catch 8 处。校正一条外部结论：docs/CODE-CLEANLINESS-REVIEW-2026-11-21.md §3.1 判「agent:main-tool-delegate 是死通路」不成立 —— 发送方在 src/agent/renderer-tool-delegate.js:47、处理器在 :169，调用方 src/agent/tool-bridge-main.js:15 与 src/main-entry.js:87，因此 renderer-agent-tools.js 与 renderer-mutate-queue.js 都是活的，本次未按死代码上报。

#### renderer-1 [P0] 录音→转写：手机端与桌面端各一份（91/370 窗口同形），已漂移出用户可见缺陷（手机上转写卡住时无法取消）

- **类型**：重复实现（已漂移） · 规模 **M**
- **证据**：
  - `src/mobile/public/voice.js:4-7 ↔ src/renderer/renderer-composer-voice.js:4-7 —— VOICE_MAX_MS / VOICE_TICK_MS / 两个 localStorage 键两份；pickRecorderMimeType / extensionForMime / formatVoiceTimer / startWaveform / cleanupVoiceStream / stopVoiceBlob / toggleVoiceRecording 逐字相同`
  - `src/mobile/public/voice.js:153（'for (let i = 0; i < 10; i++)'，波形 10 条）↔ src/renderer/renderer-composer-voice.js:124（'i < 12'）—— 已漂移`
  - `src/mobile/public/voice.js:166（'Math.max(0.17, ...)'）↔ src/renderer/renderer-composer-voice.js:137（'0.15'）—— 已漂移`
  - `src/renderer/renderer-composer-voice.js:12、227、296、299、313、319 —— 桌面端点取消用 voiceGen 代际守卫：取消后回来的转写结果被丢弃；src/mobile/public/voice.js:272-279 的 cancelVoiceRecording 没有这层守卫，取消后结果仍会经 finishVoiceRecording 的 insertTranscript 插进输入框`
  - `src/renderer/renderer-composer-voice.js:150-151 —— 桌面端注释「『取消』永不置灰：转写请求可能长时间不返回，这是用户唯一的出口」，代码只置灰 confirm；src/mobile/public/voice.js:181 却 'if (cancel) cancel.disabled = !!disabled;'，配合 :320 转写中 setVoiceControlsDisabled(true) → 手机端转写卡住时按钮不可点，且 voice.js 全文件无 keydown/Esc 分支`
  - `src/mobile/public/voice.js:26-34 getSpeechWhisperModel 只读 localStorage，无 settings 回落；src/renderer/renderer-composer-voice.js:30 有 settings?.speechWhisperModel 回落 —— 同名字段两套取值口径`
  - `src/mobile/public/voice.js:61-69 与 src/renderer/renderer-attachments.js:76 —— arrayBufferToBase64 第三份（桌面端 voice 用的是全局那份）`
- **为什么不整洁**：这 6 个函数不是「两个不同页面各写一遍」而是同一段录音状态机被复制两次；复制发生在同一次提交，随后两侧分别修 bug：桌面端补了代际守卫与「取消永不置灰」，手机端一条没拿到。结果不是风格问题，是手机端「转写中」变成死状态（用户没有出口，只能等超时或刷新页面），以及用户明确取消后结果仍被插进输入框。
- **减法方案**：抽一个纯浏览器共享脚本 src/web-shared/voice-recorder.js（plain script，工厂参数化 {els, showToast, t, isBusy, insertText}），两侧各留 ≤60 行薄壳；代际守卫与「取消永不置灰」作为共享实现的一部分，不再各写一遍。手机端 bridge.js 需加静态根映射（现有的 .. 拒绝与 startsWith 校验必须保留）。不要「顺手简化」mime 候选顺序（Android WebView 实测结果）。
- **验证**：node 复跑 8 行归一化滑窗：voice.js ↔ renderer-composer-voice.js 应从 91 窗降到 <10；真机 Android WebView：录音 → 点「转写」→ 在请求返回前点取消，确认按钮可点且结果不再插进输入框。
- **既有记录**：REDUNDANCY-REVIEW-2026-11-03 A1（记为「49/59 窗口、约 240 行可删」，排 P2「需真机验证」）。现在仍成立且比记录更严重：本轮实测 91 个同形窗口（我用的归一化把标识符全替换，比当年口径更宽），且上面列的 4 处漂移（波形条数、振幅、代际守卫、取消置灰）全部仍在，一处未修。

#### renderer-2 [P0] tool_call 标签剥离两份逐字相同 + 与 Main 唯一实现已漂移（缺 <calls> 归一 → 气泡里漏出工具标记） · **已合流（2026-11-21，见 §8.5①）**

- **类型**：重复实现（已漂移） · 规模 **S**
- **证据**：
  - `src/renderer/renderer-agent-continue.js:96-121（stripVisibleToolCallMarkup）与 src/renderer/renderer-thinking-trace.js:662-687（stripAssistantVisibleToolCallMarkup）—— 实测 21 个 8 行窗口全部相等，唯一差别是函数名`
  - `src/renderer/renderer-agent-continue.js:95 注释「展示层剥掉模型误输出的 tool_call XML（须与 src/llm-tool-call-fallback.js 同步）」—— 用注释代替单一来源`
  - `src/llm-tool-call-fallback.js:63-64（把裸 calls / /calls 归一到 tool_calls）与同文件 :19（「外层标签名可能写成 calls 而不是 tool_calls（2026-11-19 子 Agent 事故的真实形态）」）—— 两份 Renderer 副本没有这两条归一`
  - `src/llm-tool-call-fallback.js:387-405 stripToolCallMarkupFromNormalized —— 与两份 Renderer 副本同一条 14 步正则链，即第 3 份实现`
  - `src/renderer/renderer-agent-rust-loop.js:759、802、1096、1102 与 src/renderer/renderer-thinking-trace.js:653、658、697 —— 两份副本都真的在跑，不是死代码`
- **为什么不整洁**：同一条模型输出在 Main 侧被剥净（有裸 calls 归一），在 Renderer 侧没被剥净 → 工具标记作为正文漏进气泡与思考区。Renderer 内部还并存两份完全相同的实现，任何一次补正则都要改三处（含注释里的「须与…同步」），改漏一处就复发 2026-11-19 那次形态。
- **减法方案**：src/llm-tool-call-fallback.js 是纯函数、零 electron 依赖，agent-bundle 通道现成（src/renderer/agent/agent-bundle-entry.js:13-39 的 require + register 模式）→ 在 bundle 暴露 stripToolCallMarkup，删掉两份 Renderer 副本（约 −52 行），Renderer 侧只剩取 window.X 一行。不要反向把 Renderer 版抄进 Node（Node 已有更全的那份）。
- **验证**：npm run check:renderer + 用同一夹具（含裸 calls 开头的 DSML 变体）比较 Main 与 Renderer 输出必须逐字相同；npm run test:llm-tool-call-fallback 扩一条「Renderer 与 Main 同夹具同输出」。
- **既有记录**：REDUNDANCY-REVIEW A11 只记了文案常量，未记这条正则链；docs/CODE-CLEANLINESS-REVIEW-2026-11-21 §2.3 记了「renderer-agent-continue ↔ renderer-thinking-trace 10 窗」但只当纯重复，未指出 <calls> 漂移。本条为新增证据（漂移方向 + 用户可见后果）。

#### renderer-3 [P1] 20 个顶层函数全仓零调用点（约 245 行），因为 check:renderer 只做单向校验（N4.1 的闸门至今不存在）

- **类型**：死代码 · 规模 **S**
- **证据**：
  - `src/renderer/agent/worktree-ui.js:427-534 openWorktreeApplyDialog（108 行，全仓仅此一处出现）`
  - `src/renderer/renderer-settings-shell.js:103-112 switchPanel（10 行；本文件无 window 导出，index.html 无 onclick 引用）`
  - `src/renderer/renderer-model-runtime.js:574-589 getComposerSelectedModelId、:591-603 getComposerSelectedApiConfig`
  - `src/renderer/renderer-composer.js:84-86 loadComposerModelPick、:166-168 builtinModelsCacheEndpointKey、:208-221 saveBuiltinModelsCache、:362-374 formatBuiltinDetectMeta`
  - `src/renderer/renderer-artifacts-browse.js:287-290 getWorkspaceRootPath、:583-586 isMissingRpcHandlerError、:595-597 refreshWorkspaceArtifacts`
  - `src/renderer/renderer-skills-grid.js:179-184 skillSearchHaystack、:192-194 skillDomainLabel；src/renderer/renderer-plan-changes.js:269-278 planPreviewSubtaskForPath；src/renderer/renderer-agent-context-ui.js:543-546 estimateSystemToolsExtra；src/renderer/renderer-agent-llm.js:373-382 safeJsonStringify；src/renderer/renderer-gateway.js:27-30 isLocalOnlyMethod；src/renderer/renderer-rust-loop-boot.js:25-35 updateRustBootStep；src/renderer/renderer-artifacts.js:1356-1358 initArtifactsBtn；src/renderer/renderer-undo-stack.js:328-330 initUndoStackUI`
  - `scripts/check-renderer-globals.py 只校验「window.X 能否解析到声明」；docs/NODE-THINNING-PLAN.md:138-139 的 N4.1 明确要建 scripts/check-renderer-dead-exports.cjs，而 scripts/ 下只有 check-renderer-critical.py / check-renderer-globals.py / check-renderer-index-panel.cjs`
- **为什么不整洁**：这些声明既没有调用点也没有 window 导出（少数有导出但无人调用），属于「看得见、改得动、但没人跑」的残留。它们让 check:renderer 的绿失去意义：绿灯只证明「引用的符号有声明」，不证明「声明的符号有人用」。
- **减法方案**：按 N4.1 建 scripts/check-renderer-dead-exports.cjs（对 index.html 加载脚本的顶层声明做同文件 + 跨文件 + window.X 计数，动态引用走带理由的白名单），接进 npm run check:renderer；第一批就把上面 20 个删掉（约 −245 行），零行为变化 —— 它们本来就没人调。
- **验证**：npm run check:renderer；删完后再 node --check 各文件并跑 build:renderer:dev 重建 bundle（确认没有 window.X = 未定义 的脚本加载序问题）。
- **既有记录**：NODE-THINNING-PLAN N4.1（未做）与 CODE-CLEANLINESS-REVIEW-2026-11-21 §3.2（记 21 个，含 LOCAL_RPC_PREFIXES 这类非函数常量）。本条给出逐条 file:line 与行数，可直接照删。

#### renderer-4 [P1] 收尾落库：同一 35 行「message_append + 三次账本写入」在一个文件里写 4 遍，加 trace-store 第 5 份，且 5 份里只有 3 份回填 localMsgId

- **类型**：重复实现（职责混杂） · 规模 **M**
- **证据**：
  - `src/renderer/renderer-agent-complete.js:443-475、:500-536、:573-613、:634-674 —— 同一序列 4 份：gatewayCall(memory.message_append) → saveAgentRunState → saveAssistantTraceRecord → saveAgentPlanState → refreshHistoryList，差别只在分支条件（后台完成 / 已切走会话 / 正常收尾）`
  - `src/renderer/agent/trace-store.js:322-352 —— 第 5 份同类块（同一序列，变量名不同）`
  - `src/renderer/renderer-agent-complete.js:443、:505 两份没有回填本地消息 id；:582-585、:643-646 与 src/renderer/agent/trace-store.js:331-334 有 assistantMsg.localMsgId/id = ins.localMsgId —— 5 份已经出现行为分叉`
  - `src/renderer/renderer-agent-complete.js:448-451、:505-508、:639-642 —— 落库失败只有 console.warn(e); return null;（同一文件三处缩进还不一致）`
- **为什么不整洁**：收尾落库是「一轮的账本」唯一入口，src/renderer/README.md:11 要求这类编排只存在于 trace-store.js，但编排被复制了 4 次：改一处语义（加字段、调终态判定）必须改 4 处，而 5 份里已经有一处漏了 localMsgId 回填，正是这类复制的典型后果。
- **减法方案**：把「append 消息 + saveAgentRunState + saveAssistantTraceRecord + saveAgentPlanState」收成一个 finalizeRunPersistence({runSessionId, trace, status, state, userMessageId, plan, results}) 放回 src/renderer/agent/trace-store.js（与 README 的单一来源规则同位），4 处调用退化为传参；localMsgId 回填进共享实现，5 份自动一致。
- **验证**：test:unit 现有 renderer 相关用例 + 手工三条路径：前台正常收尾、切走会话后再完成、后台任务完成（托盘文案、气泡终态、agent_runs.status 三处都要看）。
- **既有记录**：docs/MODULE-CHAOS-REVIEW.md:325 只把「renderer-agent-complete.js 的 4 处落库收口」写成 Reviewer 回迁的附带工作，从未单独立项。本条为新增证据（4 份 + 第 5 份、localMsgId 分叉）。

#### renderer-5 [P1] 模型设置归一化两份（Main 与 Renderer 各一套 DEFAULTS + embedding 归一），embedding 条目的请求修饰字段在 Renderer 侧被丢 · **已合流（2026-11-21，见 §8.4）**

- **类型**：重复实现（已漂移） · 规模 **M**
- **证据**：
  - `src/model-settings.js:233-259（isLegacyBuiltinEmbeddingEntry / normalizeEmbeddingEntry）↔ src/renderer/renderer-model-runtime.js:475-491（isLegacyBuiltinEmbedding / normalizeEmbedding）—— 同一语义两份；Main 版 :255-257 保留 headers/authMode/userAgent，Renderer 版只重建 6 个键`
  - `src/agent/embedding-config.js:114、:128-129 —— 向量端点载荷真的读这些字段（headers: buildLlmHeadersFromConfig(remote)、authMode）；手写进 model-settings.json 的自定义头，在用户打开设置页并保存一次后即被 Renderer 的归一化丢掉 → 向量请求静默变 401/403`
  - `src/renderer/renderer-model-settings.js:1076-1082 —— 保存向量模型的编辑器本身也只重建 7 个键（第二次丢，与归一化叠加）`
  - `src/renderer/renderer-model-runtime.js:512-514 —— embedding-default / text-embedding-v4 的过滤只存在于 Renderer；src/model-settings.js 无对应逻辑（同一份设置两侧结论不同）`
  - `src/model-settings.js:23-24 与 src/renderer/renderer-model-runtime.js:17-18 —— EMBEDDING_DIMENSIONS_MIN/MAX = 64/8192 两份（第三处在 codebase/embedding-client.js）`
  - `src/model-settings.js:279 temperature = clampModelRuntimeValue(temperature, …) ↔ src/renderer/renderer-model-runtime.js:392 只做 Number 强转、不 clamp`
- **为什么不整洁**：两份归一化回答同一个问题「磁盘里的设置该怎么读」，却给出不同答案：一边保留请求修饰字段、一边丢弃；一边过滤历史默认条目、一边不过滤；一边 clamp 温度、一边不 clamp。用户看到的是「设置页填好的东西一保存就没了」，排查成本极高（同一段理由在 renderer-model-runtime.js:313-315 与 :431 已经各写了一次）。
- **减法方案**：抽 src/agent/model-settings-schema.js（纯函数：DEFAULTS 表 + supplier / customModel / embedding 三个归一 + 夹取），经 agent-bundle 注册（clampModelRuntimeValue 已经是这么过去的，见 agent-bundle-entry.js:55）→ 两侧只留各自独占的 shaping；再补一条 parity 测试（同 fixture 双跑深等）。不加开关、不新增字段。
- **验证**：新增 test/unit/model-settings-normalize-parity.test.cjs（同 fixture 双跑深等）；手工：在 model-settings.json 给某个向量条目手写 headers → 打开设置页 → 保存 → 读回该文件确认 headers 仍在。
- **既有记录**：REDUNDANCY-REVIEW A6（medium，「已产生真实 bug」）。现在仍成立、未修（该文注 3 把它列为 P1 之外未做项）。需要更正一处：A6 说的「自定义头被剥掉」只在手写配置向量端点时成立（设置 UI 没有 headers 输入框），因此今天不是普遍路径，严重度按「已漂移、窄路径真实 401」处理。

#### renderer-6 [P2] codebase / graph 两个索引面板共 88 个同形窗口：轮询状态机、pane 可见性、rail busy、时间格式化各两份（A13 只修掉了 resolve*WorkspaceRoot）

- **类型**：重复实现 · 规模 **M**
- **证据**：
  - `src/renderer/renderer-codebase-panel.js:11-19 formatCodebaseIndexedAt ↔ src/renderer/renderer-graph-panel.js:11-19 formatGraphPanelIndexedAt —— 同一实现两个名字，且都绕开 src/renderer/renderer-utils.js 的 fmtDateTime（src/renderer/README.md:14 声明时间格式唯一来源）`
  - `src/renderer/renderer-codebase-panel.js:5-9、47-63 ↔ src/renderer/renderer-graph-panel.js:5-9、47-63 —— 逐字同构的轮询状态机，连 2000 / 5000 两个魔法数都一样`
  - `src/renderer/renderer-codebase-panel.js:34-45（isCodebasePaneActive + setCodebasePanelText）↔ src/renderer/renderer-graph-panel.js:34-45（isGraphPaneActive + setGraphPanelText）—— 同一 selector、同一「—」兜底`
  - `src/renderer/renderer-codebase-panel.js:76-84 syncCodebaseRailBusy ↔ src/renderer/renderer-graph-panel.js:71-77 syncGraphRailBusy —— 同一份 dataset.busy* + applyIndexRailBusy 规则`
  - `src/renderer/renderer-graph-panel.js:71 函数签名只接 1 个参数，:146 却以 2 个实参调用（syncGraphRailBusy(indexing, progress)）—— progress 是死参数，复制留下的痕迹`
- **为什么不整洁**：两个面板是同一个「索引面板」的两个半区（同一 data-side-pane=index、同一个 rail 按钮），骨架却各一份：88 个同形窗口意味着近一半代码要成对维护。历史事故正是只改一边（resolveWorkspaceRoot 的四级回落副本没跟着修 → 面板解析到上一个会话的工作区），A13 记的 P0 只清掉那一处，其余骨架仍在。
- **减法方案**：抽 createIndexPanelSection({prefix, paneSelector, summaryId, rpc, applyStats, phases, pollMs})：轮询 / 可见性 / rail busy / setText / onShown / onHidden 一份，RPC 名与字段映射留作参数；两个面板各剩「取数 + 渲染 stats」约 60 行。时间格式化改调 renderer-utils 的 fmtDateTime，删掉两份同名实现。
- **验证**：npm run check:renderer（含 scripts/check-renderer-index-panel.cjs 的护栏，需同批更新）+ 手工：切换会话后打开「索引」面板，两个半区的状态 / 进度 / rail 忙标记都不串会话。
- **既有记录**：REDUNDANCY-REVIEW A13（medium）+ 该文 P0 执行记录第 6 条（只删了两份 resolve*WorkspaceRoot 四级回落）。现在仍成立：骨架两份未合，死参数 progress 也还在；「长出第三份」的风险仍在（src/renderer/renderer-agent-context-ui.js:822 注释自称与 codebase-panel 同构）。

#### renderer-7 [P2] 两套「步骤条状态机」：agent-prep 与 rust-loop-boot 同语义各一份，detail 上限已漂移（420 vs 120）

- **类型**：重复实现 · 规模 **M**
- **证据**：
  - `src/renderer/renderer-agent-prep.js:148-162 agentPrepStepStart ↔ src/renderer/renderer-rust-loop-boot.js:37-49 rustBootStepStart —— 「pending/active → active，已 done/skipped/failed 不动」逐字同构`
  - `src/renderer/renderer-agent-prep.js:164-178 ↔ src/renderer/renderer-rust-loop-boot.js:67-82（done）；src/renderer/renderer-agent-prep.js:180-196 ↔ src/renderer/renderer-rust-loop-boot.js:84-99（skip）；src/renderer/renderer-agent-prep.js:214-230 ↔ src/renderer/renderer-rust-loop-boot.js:51-65（note）—— 同一套状态迁移写两遍`
  - `src/renderer/renderer-agent-prep.js:184、221 与 src/renderer/renderer-rust-loop-boot.js:53、74、91 —— detail 截断 420 字 vs 120 字（同语义两个上限）`
  - `src/renderer/renderer-rust-loop-boot.js:25-35 updateRustBootStep —— 零调用点，是这套复制里掉队的一块`
  - `两套都在跑：src/renderer/renderer-agent-send.js:534-553、src/renderer/renderer-agent-system-message.js:124、src/renderer/renderer-agent-prep-remote.js:51 调 prep；src/renderer/renderer-agent-rust-loop.js:740、855、1009、1034、1039 调 boot`
- **为什么不整洁**：「一串带状态的步骤」在本仓出现了两次实现，迁移规则相同、截断上限不同、后来者还多写了一个没人用的 updateRustBootStep。下一次给步骤条加状态（例如 cancelled）必须改两处，漏一处就是两个面板显示不一致。
- **减法方案**：抽 createStepList({steps}) 返回 {start, done, skip, fail, note, sig}（纯操作，是否 emit / 重绘由调用方决定），两处各去掉约 60 行；detail 上限作为参数传入，并在注释里写清两个面板为何不同（若确实没有理由，就统一成一个数）。
- **验证**：node --check 两文件 + 手工：发一条消息看 prep 步骤条推进；跑一轮看 rust boot 步骤条推进（两者都不该出现卡在 active）。
- **既有记录**：未在既有四份文档里出现过 —— 本轮新发现（REDUNDANCY-REVIEW 未收录这一对）。

#### renderer-8 [P2] Renderer 仍在推导 Agent 终态并写账本（架构线：AGENTS 原则 4「勿在 Renderer 写长期 Agent 状态机」）

- **类型**：层级越界 · 规模 **L**
- **证据**：
  - `src/renderer/renderer-agent-loop.js:86-128 buildAgentStateSnapshot —— 在 UI 层把「暂停 / 失败 / 验证 / 完成」算成 taskStage，并有 4 个消费点把结果写进 runs 表（src/renderer/agent/trace-store.js:187、292、371；src/renderer/renderer-agent-complete.js:365）`
  - `src/renderer/renderer-agent-complete.js:342-348 —— 终态词表 completed / awaiting_user / blocked / pending_apply 由 UI 决定（函数本体 :253-480 共 480 行，见超长函数条）`
  - `src/renderer/agent/trace-store.js:54、:112 —— status: status || completed：写账本时把「没传状态」默认成 completed`
  - `src/renderer/agent/trace-store.js:185-263 —— Renderer 自研的写库节流状态机（TRACE_CHECKPOINT_INTERVAL_MS=2500 / FORCE_MS=30000，见 :6、:12），并自述曾把 trace_save 打到 45s 超时`
- **为什么不整洁**：主循环与 transcript 已经搬进 core（ARCHITECTURE-DEBT §0），但「这一轮算完成 / 暂停 / 待应用」仍由 UI 推导并写库 —— 这是 AGENTS 原则 4 明令禁止的形态，也是同一事实（一轮的结果）有两个作者的地方。docs/MODULE-CHAOS-REVIEW.md:85-92 已把它列为模块 B 的核心越界；Reviewer 判定回迁（该文 §405）只解决了其中一个来源。
- **减法方案**：终态由 core 随 agent.run.* 事件给出（Renderer 只展示）；buildAgentStateSnapshot 的摘要块保留为纯展示、不再回写 runs 表；账本写入只留 trace-store 一个入口。注意这需要先定「UI 的 awaiting_user / pending_apply 与 core 终态怎么对应」——属产品语义确认，别用「保留两条判定、谁先到听谁的」这种加法解决。
- **验证**：npm run check:renderer + 手工三条路径（正常完成 / 用户停止 / 切会话后完成）核对 agent_runs.status 与气泡终态一致；test:unit 现有 renderer 收尾用例。
- **既有记录**：MODULE-CHAOS-REVIEW 模块 B（:77-92、:116-118）与 §13.2 / §405（Reviewer 已回迁）。现在仍成立：Reviewer 判定已删，但 taskStage / completionStatus / 账本写入仍在 Renderer。

#### renderer-9 [P2] 超长函数与超长文件：4 个 ≥300 行函数 + 5 个 ≥1400 行文件，单个函数混了 IO、状态机与文本拼装

- **类型**：超长函数 / 职责混杂 · 规模 **L**
- **证据**：
  - `src/renderer/renderer-agent-rust-loop.js:361 chatCompletionWithToolsViaRust —— 829 行（一轮运行的整段编排：payload 组装、重试分段、trace 映射、压缩前置、事件订阅）`
  - `src/renderer/renderer-agent-complete.js:253 completeAgentRunAfterSuccess —— 480 行（含上一条的 4 份重复落库块）`
  - `src/renderer/renderer-agent-send.js:470 executeSendPrepAndRun —— 413 行；src/renderer/renderer-agent-system-message.js:115 buildSystemMessageBody —— 328 行；src/renderer/renderer-tool-results.js:76 summarizeToolResult —— 257 行`
  - `文件长度（ReadAllLines）：src/renderer/renderer-chat-history.js 2130、renderer-alive.js 1682、renderer-automation.js 1525、renderer-workspace-ssh.js 1438、renderer-thinking-trace-dom.js 1418`
  - `全 renderer ≥90 行函数共 106 个（src/renderer/dist 里的同名副本另计，不计入）`
- **为什么不整洁**：829 行的单函数里同时有组装请求 / 重试分段 / 事件订阅 / 落库四类职责，任何一处改动都要通读整段；这与 MODULE-CHAOS 记的「单函数 846 行」是同一处（行号漂到 361，长度只降了 17 行）。超长文件本身不算结论，这里成条的理由是职责确实混在一起（chat-history 同时管列表 / 分组 / 分页 / 切换流水线）。
- **减法方案**：按 // --- 分节机械搬迁（只改可见性不改逻辑，参照 ARCHITECTURE-DEBT §13 里 Rust planner/run.rs 1229→560 的做法）：rust-loop 先切出「事件订阅」「重试分段」两段；chat-history 按 MODULE-CHAOS §129 的既有裁定切 renderer-chat-list.js / renderer-chat-switch.js。每刀单独提交、单独跑 check:renderer + 手工回归。
- **验证**：npm run check:renderer + npm run test:renderer + 手工六条回归（发送 / 流式 / 切会话 / 朗读跟随 / SSH 连接 / 计划运行）。
- **既有记录**：MODULE-CHAOS-REVIEW §2.2（超长文件 12 强）、:116-122（846 行函数）、:129（chat-history 一刀切两半）与 :148（明确「不要先动 chat-history」）均已裁定分批。现在仍成立：829 行、2130 行，一条没动。

#### renderer-10 [P2] 错误被吞：168 处 拒绝式空处理 `.catch(空函数)`、8 处真空 catch 块、49 处裸 console.warn(e)（Renderer 没有前端错误该往哪报的约定）

- **类型**：错误被吞 / console 当日志 · 规模 **M**
- **证据**：
  - `src/renderer/renderer-agent-abort.js:23 —— loopApi.agentRunCancel(live.gatewayRunId, 用户停止)上挂空处理函数：停止请求失败对用户完全不可见（界面会显示「已停止」）`
  - `src/renderer/renderer-agent-compaction.js:150 —— persistCompactionArchive(cr, opts)上挂空处理函数：折叠归档写失败静默丢弃`
  - `src/renderer/agent/trace-store.js:58-60 与 :116-119 —— 账本写入失败 catch (e) { console.warn(e); return null; }（两条主账本写入，UI 无痕）`
  - `src/renderer/renderer-terminal.js:170、183、194、196 —— 终端 detach / stop / ensure 全部空吞；src/renderer/renderer-browser.js:194、207、396、586 —— 原生视图 panelState 调用全部空吞`
  - `统计口径：src/renderer/**（排除 dist）共 106 处 console.*，其中 49 处是裸 console.warn(e)（e 没有上下文，串 grep 也定位不到会话 / 工具）；拒绝式空处理（'.catch(空函数)' 一族，含 'e => {}'）168 处；真空 catch 块 8 处`
- **为什么不整洁**：口径第 6 条：空 catch 与「catch 后 return null 无痕迹」都算吞错。这里的问题规模不是个别手误，而是 Renderer 没有一份「前端错误往哪报」的约定 —— 于是 168 处各自决定静默。停止 / 归档 / 账本这三类失败有用户后果（界面说成功了，实际没成功），且都只留一条无上下文的 warn。
- **减法方案**：不建新机制：复用 LOGGING.md 的结构化前缀口径 + 一个 renderer 侧 reportUiError(scope, err, extra)（内部只做「带 scope 的 console.error + 可选 toast」两件事），先把有用户后果的三类（取消运行、归档落库、账本落库）接上；其余纯装饰性的空处理（隐藏面板、预加载 monaco 之类）在注释里写明 fire-and-forget，让下一轮审计不再重复发现。
- **验证**：node 统计脚本复跑（目标 168 → <80，且剩余每处都有 fire-and-forget 注释）；手工：断网后点「停止」，确认有提示而不是静默。
- **既有记录**：CODE-CLEANLINESS-REVIEW-2026-11-21 §2.4 记了「src 168 处 console、主要是 Renderer 的 console.warn(err) 无上下文」这一统计，但没有落到 renderer 的吞错点、也没给减法。本条为展开。

#### renderer-11 [P3] 手抄的工具名集合绕开既有单一来源：undo 快照的 7 个「会碰文件」工具名 vs guardrails-shared 的 FILE_WRITE_TOOL_NAMES

- **类型**：魔法字符串本该进既有单一来源 · 规模 **S**
- **证据**：
  - `src/renderer/renderer-undo-stack.js:234-244 —— 手写 fs_write_file / fs_edit / host_print_image / skill_create / plan_create / plan_delete / agents_md_propose 七个字符串`
  - `src/agent/guardrails-shared.js:81-83 —— FILE_WRITE_TOOL_NAMES = {fs_write_file, fs_edit, skill_create, agents_md_propose}；该模块已经经 agent-bundle 镜像到 window（src/renderer/agent/agent-bundle-entry.js:22）`
  - `src/renderer/renderer-undo-stack.js:230-233 —— 同一循环里还硬编码了 host_exec 触发「全量快照」的语义`
- **为什么不整洁**：这不是「同一集合两份」而是「概念相邻、内容不同的两份手抄」：undo 侧多 host_print_image / plan_*（确实会写文件）。后果是新增写类工具时 undo 快照静默漏文件（回滚回不干净），而没有任何检查会红。
- **减法方案**：在该集合真正的归属地（src/agent/guardrails-shared.js）加一个具名导出 UNDO_SNAPSHOT_TOOL_NAMES，注释里写明它与 FILE_WRITE_TOOL_NAMES 的差集与理由；renderer 侧改读 window.GuardrailsShared。让「差集」成为一次显式决定，而不是下一轮审计的又一条发现。
- **验证**：npm run check:renderer；手工：用 host_print_image / plan_create 各跑一次，确认「撤销」能把文件恢复。
- **既有记录**：REDUNDANCY-REVIEW A14 最后一行（「手抄 7 个会碰文件的工具名…该集合移进 guardrails-shared」）。现在仍成立、未修。

#### renderer-12 [P3] 遗留空壳文件 renderer-agent-api.js：全文 8 行只有一句 window 赋值，却挂着 40 个与内容无关的 /* global */ 声明

- **类型**：遗留兼容层 / 注释复述 · 规模 **S**
- **证据**：
  - `src/renderer/renderer-agent-api.js:1 —— 40 个 /* global … */ 名字，而正文（:3-7）只引用 window 与 cleanupSessionContinueState；实测这 40 个名字在正文里 0 次出现`
  - `src/renderer/renderer-agent-api.js:5 —— 全文唯一内容 window.cleanupSessionContinueState = cleanupSessionContinueState;，函数定义在 src/renderer/renderer-agent-continue.js:156`
  - `src/renderer/index.html:2770 —— 为这 8 行单独挂一个 <script>；src/renderer/README.md:38 还把它列成「Agent API 窗口导出」模块`
- **为什么不整洁**：文件名与内容已经对不上（并不存在「API 层」），它只是 renderer-agent-continue.js 的窗口导出被拆到另一个文件；那 40 个 global 声明是从旧文件整段复制来的垃圾，会误导人以为这里用了大量跨文件全局。
- **减法方案**：把 :5 那一行搬进 src/renderer/renderer-agent-continue.js 尾部（与同类 window 导出放一起），删文件 + 删 index.html:2770 的 <script> + 删 README 对应行（即 N4.2 的既有方案）。
- **验证**：npm run check:renderer（window 导出仍全部有声明）+ grep -r cleanupSessionContinueState src/renderer。
- **既有记录**：NODE-THINNING-PLAN N4.2（记「7 行」，实测 8 行）。现在仍成立、未修。

### 4.3 src/gateway + src/ssh + src/remote + src/git + src/lsp + src/browser + src/main + src/headless（代码整洁度）

**总评**：中下，但比提示里预期的干净。三条提示需要更正：①ssh/ 下 6 个文件不是死代码 —— ssh-config / auto-reconnect / connection-pool / remote-gateway-pool / reconnect / tunnel 全部经 src/main/workspace-remote-runtime.js（← src/main-entry.js）与 src/ssh/port-forward-manager.js 实连，反向 require 索引与 test 引用都命中，唯一「零 requirer」的只有 remote/run-cli.js 与 headless/main.js 两个入口文件；②沙箱三档仍只在 sandbox-policy.js（SANDBOX_MODES/SANDBOX_MODE_META/decideFsWrite 是唯一来源，server.js:490-583 只组装「档位→根」，且注释与两条判定链都指向它），本域没有另写一份档位判定；③window-tray.js ↔ workplace-monitor.js 的克隆窗口是伪冗余 —— 前者把状态推给 Renderer（pushStatus/buildTrayContextMenu），后者把负载发监控 socket（buildMonitorPayload/emitToAllMonitors），同形的只是 JSON 设置读写与定时器骨架，语义不重叠。真正的问题集中在四条：本机/远端判定的第二、第三真值（含一处取错作用域，P0）、远程搜索实现与排除表的三份漂移、浏览器双引擎的引擎无关语义两份且 interception 已分叉、以及 rpc.js 这个 2164 行分派器仍兼任实现文件。rg-search ↔ rpc.js 的克隆窗口确认为真（排除表 + 6 个上限数字 + 上下文夹取），fs.js / lsp-workspace.js ↔ rpc.js 的克隆窗口归因于「绕过 resolveFsTarget 的重复分支」而不是复制粘贴函数，已并入第 1 条。

**审查口径与实读范围**：范围实测行数（[System.IO.File]::ReadAllLines().Count）：gateway 57 文件 / 17010 行、ssh 20 / 6154、remote 8 / 2466、git 8 / 2885、lsp 9 / 5899、browser 22 / 11174、main 33 / 8178、headless 8 / 2842。最大文件：browser/controller.js 3101、lsp/diagnostics-service.js 2383、browser/playwright-runner.js 2186、gateway/rpc.js 2164、gateway/server.js 1474、lsp/cli-fallback.js 1459、main/ipc/agent-runtime.js 1376、git/worktree-service.js 1292、gateway/host-control.js 1272、browser/service.js 1197、main-entry.js 1188。已读并遵守四份既有结论：REDUNDANCY-REVIEW-2026-11-03（含 C 节伪冗余）、NODE-THINNING-PLAN（§6 负向清单）、ARCHITECTURE-DEBT、MODULE-CHAOS-REVIEW，另参考 docs/SSH-MODULE-REVIEW.md（ssh 部分）。方法：反向 require 索引（src+scripts+test）核死代码/死导出、人工逐条读码核行号、空 catch 与 console.* 全量扫描。本域空 catch 共 38 处，其中 30 处在 browser/frame-script.js（9）与 snapshot-script.js（21）的注入页脚本里（DOM 操作逐个 try，属刻意），其余 8 处分别在 evaluate.js 的序列化守卫（4）、timeline.js（2）、controller.js:1625 与 console-collector.js:42，均为「失败即按缺省继续」的页内/采集语义，未发现生产链路上被静默吞掉的真错误，console.* 只在 rpc.js:422/434（core 不可用告警）、remote/run-cli.js（CLI 入口）、headless/desktop-ui.js（浏览器侧脚本）三处，均非「console 当日志」；沙箱与 web/ 的 SSRF 校验都已是单一来源，未发现层级越界到 Renderer 的新增点。

#### main-gateway-1 [P0] 「本机 vs 远端」判定有四种写法，其中两处取的是「视图工作空间」而不是「本次调用作用域」 · **已收口（2026-11-21，见 §8.6①②）**

- **类型**：层级越界 / 重复实现 · 规模 **M**
- **证据**：
  - `src/gateway/rpc.js:1286 —— resolveFsTarget() 是 AGENTS.md 声明的唯一入口（纯函数 host-local.js:decideFsTarget），内部经 resolveCallWorkspaceTarget() 取调用作用域`
  - `src/gateway/rpc.js:173-175 —— 同文件注释写明「显式 sessionId 作用域：禁止回落到当前视图工作区（避免并行 SSH 串台）」：这是本仓自己定下的不变量`
  - `src/gateway/handlers/fs.js:820-836 —— fs.grep 不看 resolveFsTarget 的结果，先 isRemoteAgentUsable(agentInfo) 判一道，再 remote.transport === 'sftp' 判一道`
  - `src/gateway/handlers/fs.js:893-899 —— fs.glob 同样自判（isRemoteAgentUsable + remote.transport === 'sftp'）`
  - `src/gateway/handlers/lsp-workspace.js:159-161 —— lsp.query 用 ctx.getWorkspaceTarget() 判 target.kind === 'ssh'；server.js:888 的注入是 '() => this.getWorkspaceTarget()'（视图作用域，无 session）`
  - `src/gateway/handlers/fs.js:370-375 —— fs.read_symbol 同一函数内先取视图作用域 target 判 isSsh，紧接着又用调用作用域的 cwdForCall() 算 root`
  - `src/gateway/handlers/lsp-workspace.js:500-503 —— lsp.document_sync 用视图作用域判「ssh 就 skip」，同一函数 :512 又用 cwdForCall() 当根；:308-309、:637-638 同类`
- **为什么不整洁**：同一语义有四套判定：resolveFsTarget（调用作用域，唯一来源）、handler 自判 transport、handler 自判视图工作区、rpc.js 远程搜索里的第三套。已经真实漂移：并行 SSH 会话（用户看着本地工作区、Agent 在另一个会话的远端跑）时，lsp.query / fs.read_symbol 会按「本地」分支走，把远端路径交给本机 LSP 与白名单——这正是 rpc.js:173 那条注释要防的「串台」，而 lsp.document_sync 甚至在同一函数里混用两种作用域。
- **减法方案**：handler 里删掉 isRemoteAgentUsable / transport === 'sftp' 分支，统一消费注入的 getRemoteFs() / resolveFsTarget()（fs.grep 的 search 要补进 getRemoteFs 接口）；把 resolveCallWorkspaceTarget 作为依赖传进 handlers，5 处 ctx.getWorkspaceTarget() 全部改用它，或直接只用 cwdForCall() / resolveFsTarget()。
- **验证**：起两个并行会话（一个本地视图、一个 SSH），在 SSH 会话内跑 lsp / fs_read_symbol / fs_glob，断言落在会话工作空间那台机器；顺带 npm run test:lsp 与 test:phase5-handlers-smoke。
- **既有记录**：REDUNDANCY-REVIEW A8 记了「handlers 自判 getRemoteFs」——仍成立（行号已重核）；「视图作用域 vs 调用作用域」这条漂移是本次新增证据，A8 没覆盖。

#### main-gateway-2 [P1] 远程 grep/glob 的实现与结果解析共三份，排除表已经三套

- **类型**：重复实现 · 规模 **M**
- **证据**：
  - `src/gateway/rpc.js:1040-1211 —— grepViaRemoteExec：SFTP/无 Agent 时 fs.grep 的实现，自建 rg 与系统 grep 两条命令行、PIPESTATUS 退码、rg 缺失退 grep`
  - `src/gateway/rpc.js:958-1014 —— parseClassicGrepLines：把 'path:N:text' / 'path-N-text' 解析成命中与上下文`
  - `src/gateway/rpc.js:1214-1237 —— globViaRemoteExec：另一份 rg --files 拼装（:1221 只排除 node_modules/.git）`
  - `src/gateway/rpc.js:1816-1826 + :1836-1880 + :1882-1955 —— graph 调用方搜索的第三份实现：parseRemoteGrepLine / execRemoteGrepForCallers / resolveRemoteGraphCallers，自带一套 rg→grep 退壳与退出码语义`
  - `src/gateway/rg-search.js:743-750 / :788-795 / :835-842 —— 同一份「排除 4 个目录」在本地 grep、计数模式、glob 各写一遍`
  - `src/gateway/rpc.js:1111-1113 —— 远程 grep 又手抄一遍那 4 个 --glob`
  - `src/gateway/rpc.js:1893-1896 —— graph 调用方搜索的排除表是第三套（vendor / build / coverage / *.min.js）`
  - `src/gateway/rpc.js:1043 —— 注释「与 rg-search.resolveGrepContext 同规则」：口径靠注释维持`
- **为什么不整洁**：同一语义（在工作区里跑一次 ripgrep 并把结果解析成命中）有四处实现，排除表三套且已经不一致：本地 globWorkspace 排除 dist/target，SFTP 会话的 fs_glob 不排除 —— 同一工作区在两条通道上会给出不同的文件集合，模型据此判「产物没生成」是很容易踩的坑。
- **减法方案**：rg-search.js 导出 EXCLUDE_GLOBS（一个常量数组）、buildRgArgs、parseGrepOutput；rpc.js 的 grepViaRemoteExec / globViaRemoteExec / resolveRemoteGraphCallers 全部改为复用（远程只替换 shellQuote 与 exec 注入）；本地、远程、远程退壳三处共用同一份排除表。
- **验证**：同一工作区分别用本地通道与 SFTP 通道跑同一条 glob/grep（工作区里放一个 dist/ 文件），命中集合必须相同；npm run test:local-gateway-smoke。
- **既有记录**：REDUNDANCY-REVIEW A3 记了「rg-search.js 与 rpc.js 各自内联 --glob 排除清单」——仍成立；「实现三份 + graph 那条第三套排除表」是本次补的，且 dist/target 漂移已实测。

#### main-gateway-3 [P1] browser 双引擎的引擎无关语义各写两遍（guessMime 逐字相同），route 的 interception 字段两引擎语义已不同

- **类型**：重复实现 · 规模 **M**
- **证据**：
  - `src/browser/controller.js:374-385 与 src/browser/playwright-runner.js:1494-1505 —— guessMime 逐字符相同的 12 行`
  - `src/browser/controller.js:2408-2419 与 src/browser/playwright-runner.js:1983-1993 —— route add 的规则对象 12 行逐字相同`
  - `src/browser/controller.js:2401 与 src/browser/playwright-runner.js:1969 —— 「未找到规则 」文案两份`
  - `src/browser/controller.js:2870-2875 / :2894-2898 与 src/browser/playwright-runner.js:1729-1745 / :1775-1778 —— requireViewport 的三行守卫 + 同一句错误文案四处（normalizeViewport 本身已是单一来源，唯独这层壳没抽）`
  - `src/browser/controller.js:2429 / :2442 —— interception 报的是「拦截机制是否生效」（fetchEnabled）`
  - `src/browser/playwright-runner.js:1978 / :2013 —— interception 报的是「有没有规则」（routeRulesPw.length > 0），:2004 硬写 true`
- **为什么不整洁**：两个字段同一个名字却回答两个问题：BrowserView 在 CDP 不可用、规则已存时给 interception:false；Playwright 在规则被 remove 光之后仍可能给出 true。模型据此判「请求改写是否生效」，答案取决于选了哪个引擎。guessMime / 规则对象这些无引擎差异的部分两份，历史上就是改一边漏一边。
- **减法方案**：guessMime、route 规则整形、requireViewport 收进一个不引 electron 的小模块（playwright-runner 必须保持 electron-free），两引擎 require；interception 先定一个定义（建议「当前是否有生效中的改写规则」）并在同一处计算。
- **验证**：npm run test:browser-smoke；对两引擎跑同一组 route 动作（add / remove / clear），interception 必须一致。
- **既有记录**：REDUNDANCY-REVIEW A12 ——仍成立（行号已重核；interception 语义漂移确认未修）。

#### main-gateway-4 [P1] 远程搜索的 6 个上限/口径在 rpc.js 里手抄，rg-search.js 已有的同名常量没导出

- **类型**：魔法数字 · 规模 **S**
- **证据**：
  - `src/gateway/rg-search.js:14-24 —— DEFAULT_GREP_LIMIT=50 / MAX_GREP_LIMIT=200 / DEFAULT_GLOB_LIMIT=80 / MAX_GLOB_LIMIT=400 / MAX_GREP_CONTEXT=10 / MAX_RAW_GREP_ITEMS=20000；:855-862 的 module.exports 没有导出它们`
  - `src/gateway/rpc.js:959 与 :1042 —— 'Math.min(200, Math.max(1, Number(...) || 50))' 内联两遍`
  - `src/gateway/rpc.js:960-961 与 :1046 —— 上下文行上限 10 内联两遍`
  - `src/gateway/rpc.js:970 —— 原始条目上限 20000 内联`
  - `src/gateway/rpc.js:981 —— 单行截断 slice(0, 400)（rg-search.js:52 是同一口径）`
  - `src/gateway/rpc.js:1216 —— glob 的 400 / 80 又一次内联`
- **为什么不整洁**：这些数字决定「模型一次能看到多少命中」。改 rg-search 的上限不会改到远程通道，两条通道的截断口径从此只能靠人肉对齐；同一条工作区在本地与 SFTP 通道上表现不同，排查时没有任何一处能回答「上限是多少」。
- **减法方案**：rg-search 导出这些常量（或一个 resolveGrepLimits()），rpc.js 直接取；顺带把 slice(0,400) 收成 clipGrepLine()，两侧共用。
- **验证**：把 MAX_GREP_LIMIT 改成 120，断言本地与 SFTP 两条通道的 maxResults 都被夹到 120。
- **既有记录**：REDUNDANCY-REVIEW A3 只记了排除清单，未记这组数字；本次新增。

#### main-gateway-5 [P2] src/git 里「跑一条 git」「判是不是仓库」「抓回合前脏文件基线」各有两个实现，而 git-target 已同时支持本机与远端

- **类型**：重复实现 · 规模 **M**
- **证据**：
  - `src/git/git-target.js:252 —— target.isRepo()（rev-parse --git-dir），本机/远端共用 withGitTextHelpers`
  - `src/git/worktree-service.js:135-143 —— isGitRepo() 把同一条命令再实现一次（rpc.js:49 取的正是这一份）`
  - `src/git/worktree-service.js:120-133 —— 自建 gitExec（execFile + maxBuffer），与 git-target.js:103 的 target.run 并存`
  - `src/git/git-target.js:22 —— GIT_MAX_BUFFER = 12 * 1024 * 1024（未导出）↔ src/git/worktree-service.js:124 手写同值`
  - `src/git/baseline-capture.js:20-58 与 src/git/remote-baseline-capture.js:25-72 —— 同一个循环、同一个 120 上限、同一个 encodeWorktreeContent，只把 fs.readFileSync 换成 ssh.sftpReadFile；返回形状还漂了（远端多 isGitRepo 字段，本机没有）`
  - `src/git/baseline-capture.js:13 与 src/git/remote-baseline-capture.js:12 —— MAX_BASELINE_FILES = 120 各一份`
- **为什么不整洁**：git-target 就是「同一套 git 语义、两种传输」的既有单一来源（:259-268），但 worktree-service 与两份基线捕获都绕过它自己写。WORKTREE_SNAPSHOT_MAX_BYTES 的注释（git-target.js:29「过去四处各写一遍 4MB」）说明这批已经这么收过一次，12MB 与基线循环这批没收。两份基线捕获的返回形状已经不同，是「复制粘贴后各自演化」的典型体征。
- **减法方案**：worktree-service 的 gitExec/isGitRepo 改调 createGitTarget({kind:'local'}) 并删除；两份 baseline 捕获合成一个 captureGitBaseline(target, readFile)，本机注入 fs 读取、远端注入 sftpReadFile；GIT_MAX_BUFFER 导出复用。
- **验证**：npm run test:worktree-*（现有 smoke）；SSH 会话里跑一次 turn_begin 回撤，确认远端基线仍能撤回。

#### main-gateway-6 [P2] rpc.js 仍是 2164 行的分派器：handler 已外迁，但 fs/graph 的远程实现、远端 core 就绪状态机、undo 捕获仍住在里面

- **类型**：超长文件 / 职责混杂 · 规模 **M**
- **证据**：
  - `src/gateway/rpc.js:119-2162 —— createRpcHandlers 一个函数约 2040 行；:2059-2153 一次性注入约 95 个闭包依赖（无分组，没有名字能说明边界）`
  - `src/gateway/rpc.js:958-1237 —— fs.grep / fs.glob 的远程实现，以 deps 形式注入 handlers/fs.js:80-83`
  - `src/gateway/rpc.js:484-740 —— 远端 dieyun-core 的就绪缓存、配置重试、等待循环（约 256 行状态机）`
  - `src/gateway/rpc.js:738-956 —— undo 捕获 / 恢复上下文`
  - `src/gateway/rpc.js:1436-1810 —— 索引与图谱编排（轮询就绪、LSP 富化、符号调用方落库）`
  - `src/gateway/rpc.js:340-410 —— 沙箱作用域与远端根判定`
- **为什么不整洁**：handlers/ 已经把 18 个域拆走了，但「实现」与「依赖装配」仍混在一个文件：改 fs.grep 的远程行为要去 rpc.js:1040，改它的 handler 骨架要去 handlers/fs.js，改沙箱档位要去 sandbox-policy.js 与 server.js。分派器同时是注入点、是状态机宿主、还是搜索/undo 的实现文件，review 与阅读成本全压在这一处。
- **减法方案**：把 :958-1237 搬进 gateway/remote-search.js（与 rg-search 同目录）、:484-740 搬进 gateway/remote-core-ready.js、:738-956 搬进 gateway/undo-context.js；rpc.js 只保留「建 ctx → 分组注入 deps → 返回 handlers」。纯搬运、导出集合不变。
- **验证**：npm run test:local-gateway-smoke + test:phase5-handlers-smoke（搬运期间行为不变）。

#### main-gateway-7 [P2] lsp/diagnostics-service.js 一个文件 2383 行 / 55 个函数，八类职责挤在一起

- **类型**：超长文件 / 职责混杂 · 规模 **L**
- **证据**：
  - `src/lsp/diagnostics-service.js:282-433 —— 工作区 store 桶 + LSP 客户端池 + 结果缓存`
  - `src/lsp/diagnostics-service.js:433-830 —— 本机批量诊断 + 远端批量诊断（含引擎级失败分类与阻断）`
  - `src/lsp/diagnostics-service.js:925-1150 —— 目录监听、脏文件队列、逐文件刷新`
  - `src/lsp/diagnostics-service.js:1457-1610 —— live 文档同步与快照`
  - `src/lsp/diagnostics-service.js:1764-2170 —— 项目级扫描（引擎探测 + 批量跑 + 调度）`
  - `src/lsp/diagnostics-service.js:2172-2383 —— CLI 兜底入口与单文件诊断`
- **为什么不整洁**：一个模块同时管「怎么连 LSP / 什么时候扫 / 结果存哪 / 远端还是本机」，改任何一条都要在 2383 行里跳。MODULE-CHAOS §八 明确写明 src/lsp 不在那轮覆盖范围内，所以这是首次量到：形态与 browser（§五 已认定需要收敛失败语义）同型。
- **减法方案**：按「客户端池 / 缓存与 store / 监听与调度 / 扫描执行」切四个文件，导出集合不变（纯移动）；并把「本机 or 远端引擎」判定从 dispatch 里抽成一处。
- **验证**：npm run test:lsp（可选 DIEYUN_LSP_E2E=1 跑真 LSP 端到端）。

#### main-gateway-8 [P2] 三个采集器的 filterEntries 各自实现了同一段 urlPattern / sinceMs 过滤，且每份都写着「唯一来源」

- **类型**：重复实现 · 规模 **S**
- **证据**：
  - `src/browser/console-collector.js:107-132 —— urlPattern 正则 + 失败退字面量 + sinceMs，注释自称「唯一来源」`
  - `src/browser/network-collector.js:39-67 —— 同一段（同样的 try/catch 退字面量、同样的 Date.now()-sinceMs），注释同样写「唯一来源」`
  - `src/browser/timeline.js:175-211 —— 第三份，逐段相同`
  - `src/browser/timeline.js:214 与 console-collector.js:135 / network-collector.js:70 —— list() 上限各写一套（300/80 vs 200/50）`
- **为什么不整洁**：urlPattern / sinceMs 是模型传给浏览器工具的参数，三条通道必须给出同一个解释，否则「按 URL 过滤」在不同动作上行为不同。三处各自标注「唯一来源」正是「用注释代替单一来源」的形态。
- **减法方案**：抽一个 filterByCommonArgs(entries, args)（engine / urlPattern / sinceMs 三段），三个 collector 共用；list 上限进同一张常量表。
- **验证**：npm run test:browser-smoke；补一条「三通道同参数同结果」的单测。
- **既有记录**：REDUNDANCY-REVIEW A15 记了「filterEntries 的 urlPattern/sinceMs/engine 三段在三个文件复制三次」——仍成立。

#### main-gateway-9 [P2] 浏览器动作的超时默认值散在约 20 处（15000 一处出现 8 次），没有单一来源

- **类型**：魔法数字 · 规模 **S**
- **证据**：
  - `src/browser/playwright-runner.js:953 / :998 / :1082 / :1084 / :1176 / :1203 / :1257 / :1548 —— 'Number(args.timeoutMs) || 15000' 八处`
  - `src/browser/playwright-runner.js:1347 / :1441 / :1480 / :1636 —— 30000 / 60000 / 60000 / 60000 又四套默认`
  - `src/browser/controller.js:608 / :1389 / :1956 / :2620 / :2724 —— Math.min/max 夹取上下限各一套（500..30000、500..120000、1000..120000）`
  - `src/browser/service.js:198 / :476 / :978 —— 第三套默认（30000 / 15000 / 15000）`
- **为什么不整洁**：同一个动作在两引擎上的等待上限不同（既有文档已记「下载等待 BrowserView 有 120s 上限、Playwright 无上限」），模型遇到慢页面时拿到的失败码取决于走哪个引擎；而且仓库里没有任何一处能回答「这个动作默认等多久」。
- **减法方案**：browser/limits.js 一张表 {navigate, click, type, waitFor, download, evaluate, contentSignals} → {defaultMs, minMs, maxMs}，两引擎共读；service.dispatch 统一 clamp。
- **验证**：npm run test:browser-smoke；断言两引擎对同一动作取到同一个默认值与上下限。
- **既有记录**：MODULE-CHAOS §五 browser 行③（「超时默认值收一处，现 8000/15000/30000 四处硬编码」）——仍成立，实测已扩到约 20 处。

#### main-gateway-10 [P2] Gateway RPC 线协议（v/type/id/ok/error 信封 + BAD_JSON/UNKNOWN_TYPE/UNKNOWN_METHOD）手写两遍

- **类型**：重复实现 · 规模 **M**
- **证据**：
  - `src/gateway/server.js:1272 —— BAD_JSON 帧`
  - `src/gateway/server.js:1311 与 :1335 —— UNKNOWN_TYPE / UNKNOWN_METHOD 帧`
  - `src/gateway/server.js:1348-1360 —— result 成功/失败信封（含 retryable / suggestedFix 透传）`
  - `src/remote/minimal-gateway-host.js:626 / :659 / :670 —— 同一批错误码第二次手写`
  - `src/remote/minimal-gateway-host.js:678-695 —— 同一份 result 信封，注释也写着「与本地 Gateway 同一份失败契约」`
- **为什么不整洁**：远端 daemon 与本地 Gateway 是两条必须逐字段一致的线，现在靠注释对齐。任一帧字段只改一侧，远端 Agent 的握手或结果解析会静默半通（这正是 remote-pack 那次事故的形态）。
- **减法方案**：抽 src/gateway/wire-protocol.js（encodeResult / encodeError / parseFrame），两侧 require；同时把它加进 src/remote/remote-pack-layout.js 的 REMOTE_GATEWAY_SOURCE_PATHS（漏了远端注入即 Cannot find module）。
- **验证**：npm run test:local-gateway-smoke + 远端 daemon smoke；远端包 require 闭包校验（remote-pack-requires）。
- **既有记录**：REDUNDANCY-REVIEW A14（gateway/server.js ↔ remote/minimal-gateway-host.js 线协议手写两遍）——仍成立（行号已重核）。

#### main-gateway-11 [P2] 桌面与 headless 各手写一遍同一批工厂装配，已经漂移（headless 的工具桥没接 ssh / worktree 动作）

- **类型**：重复实现 / 职责混杂 · 规模 **M**
- **证据**：
  - `src/main-entry.js:893-914 —— createRustLoopToolBridge 注入 sshActions / worktreeActions / onSkillsChanged / plansCreateFromText`
  - `src/headless/boot.js:196-216 —— 同一个 createMainToolBridge 只注入约 12 个依赖，没有 sshActions / worktreeActions`
  - `src/agent/main-tools/remote.js:21-23 —— 缺 sshActions 时直接返回 SSH_UNAVAILABLE（模型看到的是「能力不可用」，不是「这台机器没配」）`
  - `src/main-entry.js（1188 行）与 src/headless/boot.js（497 行）—— 两个入口各列约 15 项装配，没有共享的 assemble 模块`
- **为什么不整洁**：同一语义两份装配，漂移已经产生真实差异：headless 明明有 gateway 与 SSH 能力，ssh 工具却恒返回 SSH_UNAVAILABLE。这种漂移不报错，只在无人值守场景表现为「模型说连不上」——既有的 MODULE-CHAOS §六#1 已经把它记下来，但只有人记得要同步两侧。
- **减法方案**：抽 src/app/assemble-runtime.js（纯桌面项由调用方补：窗口/托盘/自动更新），两个入口只传「有无窗口」；加一条装配完整性断言（工具桥必需依赖清单缺失即启动失败）。
- **验证**：npm run test:headless；headless 里跑一次 ssh status（无会话时应报「没有已保存目标」而不是 SSH_UNAVAILABLE）。
- **既有记录**：MODULE-CHAOS §六#1 ——仍成立（本次核对：headless 仍未注入 sshActions/worktreeActions）；该文档同时记着「是否设计如此」待拍板，若确定 headless 不该管 SSH，则应把 ssh/worktree 从共享 catalog 的 headless 侧同样摘掉，而不是留一个恒失败的入口。

#### main-gateway-12 [P3] 8 个模块里 18 个导出零外部引用；其中句柄前缀常量的「单一来源」正被两处字面量绕过

- **类型**：死代码 / 魔法字符串 · 规模 **S**
- **证据**：
  - `src/gateway/host-local.js:28-30 —— LOCAL_PROC_HANDLE_PREFIX / REMOTE_PROC_HANDLE_PREFIX 声明为「句柄自己说出它在哪台机器」的唯一来源，注释直接点名 host-control / remote-processes`
  - `src/gateway/host-control.js:149 —— 实际写的是 'hostproc-${++processHandleSeq}' 字面量`
  - `src/gateway/remote-processes.js:132 —— 实际写的是 'sshproc-${++handleSeq}' 字面量`
  - `src/gateway/host-local.js:227-231 —— 上述两个常量连同 LOCAL_PATH_PREFIX、looksLikeWindowsPath 导出后无任何外部引用（host-local.js:188 只在文件内用）`
  - `src/gateway/sandbox-policy.js:759 / :763 / :770 —— DENY_COMMAND_WORDS / runsScriptInterpreter / isUnderAny 同样零外部引用`
  - `src/remote/remote-index-core.js:495、src/remote/ssh-screen.js:505、src/git/diff-context.js:200、src/git/worktree-service.js:1280、src/main/linux-deb-install.js:293、src/main/media-protocol.js:218 与 :220、src/gateway/str-replace.js:274、src/gateway/exec-policy.js:59、src/gateway/fs-read-limits.js:24、src/gateway/local-endpoint.js:144 —— 同类零引用导出`
- **为什么不整洁**：没人 require 的导出会被当成「有调用方的公共 API」保留下来，下一轮审计还要重新判一次。句柄前缀那两条更糟：常量的全部意义就是防两处字面量分叉，而它恰恰是被两处字面量绕过 —— 哪天要改前缀（或加第三种句柄），procHandleScope 会认不出新句柄。
- **减法方案**：host-control.js:149 与 remote-processes.js:132 改用已有常量；18 个零引用导出从 module.exports 删掉（只在本文件用的保持私有）。
- **验证**：全仓 rg 确认各名字零引用后删除；node --check + npm test。

### 4.4 features 域：src/channels + src/mobile + src/alive + src/plans + src/goals + src/peer + src/skills + src/mcp + src/memory-shared + src/index + src/graph + src/automation + src/tools + src/undo + src/workspace + src/computer + src/terminal

**总评**：没有 P0：这个域里「已经漂移成真实 bug」的重复，上一轮基本收完了（识别规则三份→一份、凭据存储三份→secret-store、增量调度骨架两份→工厂、mutate-queue 的 12*60*1000、rewards 文案）。本次值钱的是五件「第二份实现还在长」：① 会话工作空间的「归一或抛错」写了两份逐字相同的实现（channels/store.js 与 gateway/handlers/memory.js），而这两处正是代码注释里自称「同一份解析」的地方 —— 它是写库闸门，历史上就是这条链把 `ssh:user@host:/path` 原样写进表；② 手机端朗读切块抄了 renderer-tts 的规则，且已经漂移（桌面用 ttsSafeSlice 不切半个代理对，手机直接 slice）；③ alive/ 目录仍在手写数字（decide.js 自己写着「本文件不留数字」，实有 6 处字面量 + 4 个与 agent-limits 同值的 `||` 兜底）；④ skills/vector-index 与 tools/tool-vector-index 的建索引骨架两份（batchSize 8 vs 16、QUERY_EMBED_TEXT_MAX 1200、tokenize 截 2000 全在两边各写一遍）；⑤ 结构索引调度器保留着代码索引侧明确否决的「busy 时 5s 重试」。另有一件死代码（plans/runner 的无工具单轮降级分支在树内已无调用点，且它自己又拼了一遍计划提示与「执行 TODO」块）、一件超长混杂（peer/coordinator.js 1343 行六类状态机）与四件小卫生。三个指定重复窗口实地核实结论：skills/tools 向量索引 = 真重复（已报）；graph/index 两个增量调度器 = 骨架合并**已完成**（REDUNDANCY A5 / P1-1 落地），只剩 decide() 策略差异（已单独报）；channels/store ↔ gateway/handlers/memory = 真重复，命中的正是 workspace 归一（已报）。提示逐条核实：alive/decide.js **确实留了数字**（违反 AGENTS 明令，已报）；plans 与 goals 的续跑判定**只有一份**（goals/session-goal.js:303 与 main/mcp-plans-boot.js:434,558 都调 plans/goal-run.js#decideContinuation，不报）；peer 的 actions/wire/coordinator 三层职责**分层正确**（actions 只做参数整形、coordinator 只做业务判定、wire 只有协议），但动作集合有第三张平行表没被契约测试锁住（P3）；channels/wecom-media.js 与 wecom-client.js **没有重复解帧/判型**（wecom-client 只归一字段，wecom-media 只解密 + 调 guardrails-shared 的魔数判型，实现各一份，**不报**）；mobile/public/app.js 复制 PC Renderer 一事已在 MODULE-CHAOS-REVIEW:159 裁定「不重写、只守三条」，本次只把它真正已漂移的一处（TTS 切块）按「已漂移」报，不重报「大文件」。刻意不报：agent-limits.js 与 system-prompt-prep.js 不拆（既有裁定）、memory-shared/service.js 的阈值口径（limitsOf 单一入口做得对）、peer 的 autoTrust 默认值、wecom-media 里那层同签名包装、各目录普遍存在的 `catch { // ignore }`（多数写明了理由，属既有风格而非吞错）。

**审查口径与实读范围**：范围：17 个目录、89 个 .js 文件、26,129 行（[System.IO.File]::ReadAllLines().Count 实数，html/css 未计）。实读全文：channels/store、channels/wecom-media、channels/agent-turn（区段）、channels/runtime（搜索项）、alive/decide、alive/tension、alive/voice（头部 + 常量区）、alive/runtime（resolveAliveConfig 全段）、plans/scheduler、plans/runner、plans/plan-agent-runner（头部）、main/mcp-plans-boot（250-505）、main/ipc/peer、headless/desktop-turn（155-194）、peer/actions、peer/index、peer/boot（require 区）、peer/coordinator（结构）、skills/vector-index、skills/install-integrity、tools/tool-vector-index、mcp/credentials-store、mcp/server-config、mcp/store（头部）、mcp/manage（40-280 区段）、mcp/package-store（结构）、memory-shared/service（数字与 limitsOf 区）、index/incremental-scheduler、index/codebase-incremental-scheduler、graph/graph-incremental-scheduler、workspace/target、computer/actions + coordinate-map（结构）、mobile/public/app.js（TTS 全段 866-1045 + 全文搜索）、mobile/bridge、renderer/renderer-tts（260-334，越界取证）、renderer/renderer-tool-defs（250-339，越界取证）、gateway/handlers/memory（1-60，越界取证）、agent/system-prompt-prep-main、agent/main-tools/mcp、agent/agent-limits（340-414、473-677 区段）、agent/tool-catalog（引用处）。方法：8 行克隆窗口三对逐行对照；`catch` 形态扫描（空 catch / 仅注释 catch / `.catch(() => {})`）全目录；未引用导出启发式扫描（导出名在 src+test+scripts 全量计数）；`TODO/FIXME/legacy/兼容` 全目录扫描（本域无陈旧 TODO，命中都是 `todos` 字段）；`console.*` 全仓扫描后按目录过滤（本域只剩 mcp/credentials-store 的两条）；行数一律 ReadAllLines 实测。未跑任何运行时验证（只读审查）。

#### features-1 [P1] 会话工作空间「归一或抛错」两份逐字相同的实现：channels/store.js 与 gateway/handlers/memory.js

- **类型**：重复实现（同一语义两份） · 规模 **S**
- **证据**：
  - `src/channels/store.js:34-44 —— normalizeWorkspacePath：trim → parseWorkspaceInput → 失败抛 INVALID_PARAMS → 'target.kind === 'ssh' ? buildSshUri(target) : target.path'`
  - `src/gateway/handlers/memory.js:16-26 —— normalizeSessionWorkspacePath：同样的十行，连报错文案「工作空间路径无法识别：${raw}（远端须写成 ssh://user@host/path）」一字不差`
  - `src/channels/store.js:28-30 —— 注释自称「工作空间字符串的唯一归一入口（与 Gateway 写库闸门同一份解析，见 gateway/handlers/memory.js#normalizeSessionWorkspacePath）」：用注释维系，而不是同一份实现`
  - `src/workspace/target.js:144-148 —— workspacePathForSession 已经是「ssh → buildSshUri，否则 path」这半句；:58-91 parseWorkspaceInput 已经是解析失败返回 null 的唯一实现，缺的只是「失败即抛」`
  - `src/channels/store.js:212、:263 —— 两处调用（创建频道、改频道）`
- **为什么不整洁**：这不是普通工具函数，是「会话 cwd 指向哪里」的写库闸门。memory.js:12-14 的注释记着历史事故：`ssh:user@host:/path`（scp 风格）被原样写进表，解析端当成本地路径，整条会话 cwd 指向不存在的 Windows 目录。两处各写一遍意味着下次只修一侧就静默放进非法路径 —— 而两处目前恰好一致，所以任何一只被改都不会有人发现。
- **减法方案**：把 wrapper 收进既有单一来源 `src/workspace/target.js`（例如 export `normalizeWorkspacePathOrThrow`，内部用 parseWorkspaceInput + workspacePathForSession），两处各删 11 行改为 require；`channels/store.js` 只剩调用点。
- **验证**：`npm test`（channels-store-robustness / channels-workspace-switch 用例）+ 补一条断言「非法 workspace 抛 INVALID_PARAMS」；收尾 `grep -rn "parseWorkspaceInput(raw)" src` 确认只剩一份。

#### features-2 [P2] 手机端朗读切块复制了 Renderer 的规则且已漂移：桌面不切半个代理对，手机直接 slice

- **类型**：重复实现（已漂移）/ 魔法数字没有单一来源 · 规模 **M**
- **证据**：
  - `src/mobile/public/app.js:873-875 —— TTS_CHUNK_TARGET = 90 / TTS_CHUNK_MAX = 180 / TTS_BREAK = '。！？!?；;\n'`
  - `src/renderer/renderer-tts.js:270-274 —— TTS_CHUNK_TARGET = 90 / TTS_CHUNK_MAX = 180 / TTS_CHUNK_BREAK：同一组三个字面量各写一遍`
  - `src/mobile/public/app.js:888-918 —— splitTtsChunks 整段（成句 + 合并到 90 + 超长硬切）与 renderer-tts.js:338-383 的 splitTtsChunksDetailed 同形`
  - `src/renderer/renderer-tts.js:267-268 —— 注释自己承认：「手机端有一份等价实现……改这里的切块规则时同步改那边，否则两端语速/切句不一致」= 靠注释同步`
  - `src/renderer/renderer-tts.js:276-283 —— ttsSafeSlice：不切半个代理对；src/mobile/public/app.js:911-913 'cur.slice(0, TTS_CHUNK_MAX)' 无此保护 → **已漂移**：同一段含 emoji/生僻字的文本，手机端可能切出孤立代理项送进合成，桌面端不会`
  - `src/mobile/public/app.js:870-872 —— 注释仍写着「切块阈值与电脑端保持一致」，即两端都以为自己在对齐`
- **为什么不整洁**：同一语义两份 + 已经漂移，且漂移点是「不可见的坏字符」——没人会把它和切块函数联系起来。切句规则还直接决定朗读语速与停顿，靠注释同步必然再分叉（REDUNDANCY A1 记的语音状态机就是同一个形态）。
- **减法方案**：手机端是独立 bundle（无模块系统），把切块抽成一个零依赖 plain script（本仓已有 `src/agents-md-sections.js` 这类零依赖共享先例；renderer 侧 require、手机侧 `<script>` 引入），手机端删 31 行自写实现与三个常量。**最小止血**（可独立提交）：先把 ttsSafeSlice 的等价保护搬进手机端，并把三个常量改为从共享脚本取。
- **验证**：同一批中英 emoji 混排文本 fixture 双跑（node 侧 require 共享函数 + 手机端脚本在 jsdom 里跑），断言块数与每块文本一致、无孤立代理项（`/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/`）；`npm run test:mobile`。
- **既有记录**：部分：docs/CODE-CLEANLINESS-REVIEW-2026-11-21.md §2.3 记的同族第一对是 mobile/public/voice.js ↔ renderer-composer-voice.js（另案），TTS 切块这一对未记；MODULE-CHAOS-REVIEW.md:159 只裁定「手机端不重写」，不含切块；漂移（无代理对保护）本轮新发现。

#### features-3 [P2] 生命感的数字仍在 alive/ 里手写：decide.js 自称「不留数字」，实有 6 处字面量 + 4 个与 agent-limits 同值的兜底

- **类型**：魔法数字本该进既有单一来源 · 规模 **M**
- **证据**：
  - `src/alive/runtime.js:38-111 —— resolveAliveConfig 是这些键的唯一装配处，decisionsKeep/intentsKeep/suspiciousWakeMin/recapMaxChars/voiceTextMaxChars 全部由它提供（永远有值）`
  - `src/alive/decide.js:85 —— 注释自陈「保留条数来自 agent-limits（aliveDecisionsKeep / aliveIntentsKeep），本文件不留数字」`
  - `src/alive/decide.js:122-123 —— 'Number(cfg.decisionsKeep) || 200' / 'Number(cfg.intentsKeep) || 20'：与 agent-limits.js:657-658 同值的兜底（第二份真相，改主源这两处永远不生效）`
  - `src/alive/decide.js:390 —— 'Number(cfg.suspiciousWakeMin) || 5'，同 agent-limits.js:660`
  - `src/alive/decide.js:212 —— 'Number(cfg.recapMaxChars) || 800'，同 agent-limits.js:569`
  - `src/alive/decide.js:20 —— INTENT_MAX_CHARS = 300：无对应键的纯本地字面量`
  - `src/alive/decide.js:115 —— 'raw.done.slice(0, 12)'：一轮最多关几条，纯字面量（与 aliveLoopMax 12 同值但语义不同）`
  - `src/alive/tension.js:13、:61-65、:113、:124、:140 —— LOOP_TEXT_MAX = 160、weight 夹取 1..3、'loopTension(...) >= 1'、'Math.max(60000, cfg.refusalWindowMs)' ×2`
  - `src/alive/voice.js:31-37 —— LISTEN_MAX_SECONDS 15 / LISTEN_DEFAULT_SECONDS 5 / SPEAK_MAX_CHARS 300 / SPAWN_TIMEOUT_MARGIN_MS 20000 / LIST_DEVICES_TIMEOUT_MS 8000`
  - `src/agent/agent-limits.js:629 —— aliveVoiceTextMaxChars: 300（与 voice.js 的 SPEAK_MAX_CHARS 同值、不同语义，正好是最容易互相覆盖的那类）`
- **为什么不整洁**：AGENTS.md 生命感那一行明写「数字 agent-limits.js 的 alive*（含 aliveDecisionsKeep / aliveIntentsKeep / aliveSuspiciousWakeMin / aliveSetupMaxChars，**decide.js 里不留数字**）」。现在不仅有 6 处字面量，还有 4 个「与主源同值的 `||` 兜底」—— 兜底看着安全，实际是第二份真相：把 aliveRecapMaxChars 从 800 改小，decide.js 只会在 cfg 缺键时用 800，而 cfg 永远不缺键，于是这四处改动永远不会被验证。
- **减法方案**：在 agent-limits.js 补 6 个键（aliveIntentMaxChars / aliveLoopsClosePerTurn / aliveLoopTextMaxChars / aliveLoopWeightMin / aliveLoopWeightMax / aliveLoopDecayMinTension / aliveRefusalWindowFloorMs / aliveVoiceListenMaxSeconds / aliveSpawnTimeoutMarginMs / aliveListDevicesTimeoutMs），runtime.js#resolveAliveConfig 统一夹取下发，decide.js/tension.js/voice.js 改为纯读 cfg（缺键即抛，与本仓 `resolveStallMs` 的既有做法一致），删掉 4 个 `||` 兜底。
- **验证**：`npm run test:alive`（scripts/test-alive.cjs 现成）+ `npx vitest run test/unit/alive-*`；收尾扫 `alive/*.js` 里 `const [A-Z_]+ = \d+` 应为 0。
- **既有记录**：是（声明在 AGENTS.md 生命感行与 src/agent/agent-limits.js:654-657 的注释里 —— 注释称「以前这两处硬编码在 decide.js（20 / 200）」，主值确实搬走了，但兜底与另外 6 处仍留在原地），现在**仍成立**。

#### features-4 [P2] 技能索引与工具索引的「建索引 + 召回」骨架两份，关键数字两边各写一遍

- **类型**：重复实现（同一语义两份） · 规模 **M**
- **证据**：
  - `src/skills/vector-index.js:90-159 ensureSkillIndex / src/tools/tool-vector-index.js:59-120 ensureToolIndex —— 同形骨架：createEmbeddingClient → embeddingSignature → canVector → readIndexFile → previous Map → 去重 Set → entryIsFresh → baseEntry → toEmbed → 分批 embed + vectorToBase64 → writeIndexFile → { index, vector }`
  - `src/skills/vector-index.js:21 与 src/tools/tool-vector-index.js:20 —— QUERY_EMBED_TEXT_MAX = 1200 各写一遍（无单一来源）`
  - `src/skills/vector-index.js:123 与 src/tools/tool-vector-index.js:83 —— 'Array.from(tokenize(document)).slice(0, 2000)' 同一段截断各写一遍`
  - `src/skills/vector-index.js:176 与 src/tools/tool-vector-index.js:262 —— 'rankByKeyword(entries, q, set, Math.max(max, 12))' 同一个 12 各写一遍`
  - `src/skills/vector-index.js:22 DEFAULT_LIMIT = 8（调用方 src/agent/system-prompt-prep-main.js:67 又写了一遍 'limit || 8'）/ src/tools/tool-vector-index.js:21 DEFAULT_LIMIT = 10（= agent-limits.js:364 toolRecallLimit: 10）`
  - `已漂移两处且无说明：批量大小 8（skills:137）vs 16（tools:97）；tools:111-117 多了 mergedPrevious + '.slice(0, 500)' 保留孤儿条目，skills 侧没有`
- **为什么不整洁**：两个文件解决的是同一件事（把一批文档按「文本 hash + embedding 签名」增量建向量索引，再按同一套 rankBySemantic 召回），差别只有文档拼装与条目字段。骨架两份的直接代价是「向量索引怎么算新鲜 / 怎么分批」这类共性缺陷要修两遍 —— batchSize 8 vs 16 已经是一次无说明的分叉；1200 / 2000 / 12 三个数字两边各写一遍，改召回质量参数时会漏一侧。
- **减法方案**：在 `src/codebase/vector-index.js`（已经是 hashText/embeddingSignature/vectorToBase64/tokenize/readIndexFile/writeIndexFile/rankByKeyword/rankBySemantic 的唯一来源）旁边加 `createVectorIndexStore({ indexPath, docOf, entryBase, isFresh, batchSize, keepOrphans })` + `embedPending()`，两份 ensure* 只剩「文档怎么拼」与「召回策略」；三个数字进 agent-limits（与 skillRecall*/toolRecall* 阈值同一批）。
- **验证**：现有 test/unit 里技能/工具召回用例 + `npm run test:agent`；补一条「两侧 batchSize 同值」的断言（正是历史漂移点）。
- **既有记录**：是：docs/REDUNDANCY-REVIEW-2026-11-03.md A14 最后一行（「索引构建骨架 + 查询嵌入 + QUERY_EMBED_TEXT_MAX=1200；batchSize 8 vs 16 无说明」→ 减法「复用 codebase/vector-index.js 既有原语，加 createIndexStore / embedPending」），**至今未做，仍成立**。

#### features-5 [P2] plans/runner.js 的「无工具单轮」降级分支在树内已走不到，而它自带第二份计划提示与「执行 TODO」块

- **类型**：死代码 / 降级层（原则 2 明令禁止的加法反模式） · 规模 **S**
- **证据**：
  - `src/plans/runner.js:66-69 —— 只有 'ctx.gateway && ctx.coreBridge && typeof ctx.createToolBridge === 'function'' 全缺时才落到 else 分支（即「无工具、单次 LLM」）`
  - `src/main/mcp-plans-boot.js:389-412 —— 唯一生产调用点，planCtx 里恒传 gateway:gw / coreBridge / createToolBridge / mcpRuntime → 恒走 :68 的 runPlanAgentLoop；'deps.runPlan' 是测试缝（:205、:211），src/ 内无人注入`
  - `src/plans/runner.js:71-99 —— 降级分支自己又拼一遍：dieyun 系统块（:75-76）+ 技能块（:78-83）+ 「执行 TODO」块（:85-87）+ 空正文判失败（:95-97）`
  - `src/plans/plan-run-turn.js:58-60 —— '执行 TODO：\\n${todos.map((t, i) => '${i + 1}. ${t}').join('\\n')}' 与 runner.js:85-87 逐字相同（第二份）`
  - `src/plans/plan-agent-runner.js:23-50 —— 计划系统提示的第三处拼装（本域已被 agent 域另案报告为「与 main-turn-runner 同形」，此处只补充它下面的这一层）`
- **为什么不整洁**：AGENTS 原则 2：降级层若只是绕过失败而非消除失败，就该删。这里的判据甚至不是「core 不可用」，而是「调用方没传三件依赖」—— 真出现 core 故障时走不到它（runRustAgentLoop 自己会报错），所以它既不被使用、也不解决问题，只留下「计划提示 + TODO 块」的第二、第三份写法。删它不会减少任何真实能力。
- **减法方案**：删 runner.js:71-99 的 else 分支与随之无用的 ASSISTANT_IDENTITY / buildTaskSkillsSystem / appendPlanLog require（注意 `chatCompletion` 必须保留：src/plans/parser.js:111 还在用它做计划解析），runPlan 直接 `return runPlanAgentLoop(ctx, plan)`；「执行 TODO」块只留 plan-run-turn.js 一份。
- **验证**：`npx vitest run test/unit/plans-*.test.cjs`、`test/unit/mcp-plans-boot.test.cjs`、`npm run test:rust-planner-smoke`；`grep -rn "执行 TODO" src` 应只剩一处。
- **既有记录**：部分：docs/DESIGN.md:429 与 docs/ARCHITECTURE.md:702 把这条记成「core 不可用时降级为单次 LLM」（当作设计而非债务），因此从未进过减法清单；docs/CODE-CLEANLINESS-REVIEW-2026-11-21.md §五 第 5 步记的是它上层的 main-turn-runner ↔ plan-agent-runner 骨架合并。本条是那一层下面的死分支，**仍成立**。

#### features-6 [P2] 结构索引调度器保留了代码索引侧明确否决的「busy 时 5s 重试」：同族两个调度器对同一事件给出相反策略

- **类型**：重试层（原则 2）/ 重复实现已漂移 · 规模 **S**
- **证据**：
  - `src/graph/graph-incremental-scheduler.js:11 —— CODEBASE_BUSY_RETRY_MS = 5000；:36-42 拿 codebase.status 见 'indexing' 就 'return { action: 'retry', delayMs: 5000 }'`
  - `src/index/codebase-incremental-scheduler.js:51-58 —— 相反策略且写了理由：「索引正在跑时不再排队重试：保存是高频事件，重试风暴比『这次不增量』更贵。下一次保存/打开工作区自然会再触发一次」`
  - `src/index/incremental-scheduler.js:99-102 —— 工厂对 retry 的处理就是 'schedule(workspaceRoot, verdict.delayMs, reason)'，于是 graph 侧每条保存事件都会变成「每 5s 一次 codebase.status + graph.status」的轮询，直到 codebase 不再 indexing`
  - `src/graph/graph-incremental-scheduler.js:10、:38、:44、:57 —— RETRY_DELAY_MS 2000 / 15000 / 30000 / 60000 四个超时字面量也在本文件里，未进 agent-limits（REDUNDANCY §B 同类项已登记）`
- **为什么不整洁**：骨架合并（A5 / P1-1）只合了机制，把「busy 时怎么办」留成两份策略，而且留下的正是被否决的那一份。后果是同一台机器上「代码索引在跑」这件事，一个调度器判为「跳过、下次再说」，另一个判为「5 秒后再问一遍」——下一次为同类问题做决定时，两个先例都在，谁也不知道哪个是现行口径。
- **减法方案**：删 graph 侧的 codebase.status 预检与 retry（graph-incremental-scheduler.js:11、:36-42），与 codebase 一样「这次跳过，下次保存再触发」；四个超时字面量收进 agent-limits（与 plansIdle*/index* 同类）。
- **验证**：`npx vitest run test/unit/incremental-index-dedupe.test.cjs`（现有 9 条行为用例）+ 补一条「codebase.indexing 时 graph 侧不 schedule」；`npm run test:local-gateway-smoke`。
- **既有记录**：是：docs/REDUNDANCY-REVIEW-2026-11-03.md A5（「graph 侧保留了 codebase 侧明确否决的『busy 时 5s 重试』」）与 docs/INDEX-VALUE-REVIEW.md:23（把「busy 不排重试」记为 R4 整改成果）。A5 的骨架合并已完成（P1 执行记录第 1 条），**这条策略差异仍在，仍成立**。

#### features-7 [P2] peer/coordinator.js 1343 行：租约 / 房间 / 会话绑定 / 信任 / 收发 / 回传六类状态机同居一个文件

- **类型**：超长文件 / 职责混杂 · 规模 **L**
- **证据**：
  - `src/peer/coordinator.js:1343 —— ReadAllLines 实测（本域最长文件）`
  - `src/peer/coordinator.js:53-56、:149-201、:981-1072 —— 占位/租约（claimKey、ownClaims、peerClaims、allClaims、conflictsFor、broadcastClaim、claim）`
  - `src/peer/coordinator.js:364-553 —— 房间（newRoomId、roomsList、resolveRoomMembers、createRoom、closeRoom、sendToRoom、roomTimeline）`
  - `src/peer/coordinator.js:284-362 —— 会话绑定与重建（createSessionForPeer、sessionAlive、ensureSessionForPeer）`
  - `src/peer/coordinator.js:697-790 —— 信任与待确认缓冲（trustDecision、pendingTrustList、bufferUntrusted、trustPeer、untrustPeer）`
  - `src/peer/coordinator.js:578-696、:849-1110 —— 入站分派、出站发送与回合回传（handleMessage、handleReply、dispatchEnvelope、onEnvelope、sendToPeer、normalizeSendResult、noteTurnCompleted、noteTurnProgress）`
  - `src/peer/coordinator.js:80-108 —— 同时持有 9 个内存 Map（ownClaims/peerClaims/learnedPeers/pendingTurns/turnBudget/seenInbound/turnText/pendingInbound/awaitingReplies）+ :71 落盘 store + :567-577 拼给模型的入站文本`
  - `src/peer/coordinator.js:1118-1240 —— 生命周期与设置（status、start、stop、restart、setEnabled、setAutoTurn、setAutoTrust、setName、setRole、refresh）`
- **为什么不整洁**：一个文件同时做持久化接线、六类状态机、跨机文本拼装。改任何一类都得读全 1343 行，而本仓对 peer 的唯一机械闸门（test/unit/peer-bridge-contract.test.cjs）只覆盖动作表与桥表，覆盖不到语义——也就是说这个文件里最贵的部分恰好没有任何拆分或契约保护。
- **减法方案**：按文件里已有的函数分组机械拆三刀：`claims.js`（租约/占位）、`rooms.js`（房间 + 会话绑定）、`trust.js`（信任/待确认），coordinator 只留门面、dispatch 与生命周期；不改语义、不动 wire.js / actions.js / boot.js。以现有注释分节为界，逐块搬迁。
- **验证**：`npm run test:peer-tools` + `npx vitest run test/unit/peer-*.test.cjs` + `npm run test:unit`（peer-bridge-contract 必须全绿，否则说明动作表被搬坏）。

#### features-8 [P3] plans/scheduler.js 三处小卫生：与 agent-limits 同值的兜底、四份相同的执行块、一处静默吞错

- **类型**：魔法数字 / 重复实现（文件内）/ 错误被吞掉 · 规模 **S**
- **证据**：
  - `src/plans/scheduler.js:27-28 —— 'opts.idlePollMs > 0 ? ... : 60 * 1000' / ': 5 * 60 * 1000'，与 src/agent/agent-limits.js:45-46 的 plansIdlePollMs / plansIdleQuietMs 同值；而唯一生产调用方 src/main/mcp-plans-boot.js:288-289 每次都传 → 这两个兜底永不生效，只是第二份真相`
  - `src/plans/scheduler.js:91-98、:130-139、:157-166、:173-180 —— 四段逐字相同：'this.running.add(id) → await this.runPlan(plan) → catch log → finally { delete + lastBusyAt = Date.now() }'`
  - `src/plans/scheduler.js:108 —— 'this._idleTick().catch(() => {})'：定时器回调里的异常不留任何痕迹（log 钩子就在同一个类上，:22）`
- **为什么不整洁**：三处都是「同一个文件里同一件事写多遍」：默认值两份（改 agent-limits 不生效）、执行块四份（改错误处理要改四处）、空 catch（定时任务静默死掉时日志里什么都没有，与本仓「错误要留痕」的口径相反）。
- **减法方案**：删 :27-28 的兜底改读 agent-limits 默认值；抽 `_runExclusive(plan, label)` 覆盖四处（runNow 需要返回值，参数化即可）；:108 改成 `.catch((e) => this.log('闲时轮询异常: …'))`。
- **验证**：`npx vitest run test/unit/plans-scheduler.test.cjs test/unit/plans-idle-queue.test.cjs`（现有用例覆盖 idle 节流与 target 优先）。
- **既有记录**：是：docs/REDUNDANCY-REVIEW-2026-11-03.md §B 记了「plans/scheduler.js:27-28 的 60s / 5min……未挂在 agent-limits」；**部分已修**（agent-limits.js:45-46 现在有这两个键，调用方也传了），剩下的正是这两份同值兜底 —— 仍成立。

#### features-9 [P3] peer/actions.js 的同一动作集合有三张平行表，契约测试只锁住两张

- **类型**：重复实现（同一集合多份清单，缺闸门） · 规模 **S**
- **证据**：
  - `src/peer/actions.js:19-42 —— PEER_ACTION_NAMES：22 个动作名`
  - `src/peer/actions.js:59-82 —— PEER_BRIDGE_METHODS：22 条（方法名 + 参数整形）`
  - `src/peer/actions.js:133-243 —— HANDLERS：22 个键，真正的实现`
  - `test/unit/peer-bridge-contract.test.cjs:26-37 —— 只校验「动作表 ↔ 桥表」一一对应且方法名由动作名派生，**HANDLERS 不在任何断言里**`
  - `src/peer/actions.js:116-117 —— 动作名在表里但忘了写 handler 时，只有到运行期才返回「未知的互通动作」`
  - `src/peer/actions.js:129 —— 'return { handle, names: PEER_ACTION_NAMES }'：'names' 在 src/ + test/ + scripts/ 内无消费者（src/main/ipc/peer.js:24 直接用模块级常量）`
- **为什么不整洁**：文件头 :46-55 自己写着「加动作只改两处表，契约测试会校验一一对应」，而真实实现是第三张表 —— 正是它记录的「set-auto-trust 在动作表里有、preload 里没有」那类漂移的下一个入口：现在漏写 HANDLERS 同样不会红。
- **减法方案**：让 `PEER_ACTION_NAMES` 从 HANDLERS 派生（`Object.freeze(Object.keys(HANDLERS))`，把 HANDLERS 提到前面），或至少给契约测试补一条「HANDLERS 键集合 == PEER_ACTION_NAMES」；删掉无消费者的 `names` 返回值。
- **验证**：故意删掉一个 HANDLERS 条目，`npx vitest run test/unit/peer-bridge-contract.test.cjs` 必须变红。

#### features-10 [P3] mcp/manage.js 里「这个服务是不是远端」又手写了一遍，而单一来源就在隔壁

- **类型**：重复实现（同一判定多份） · 规模 **S**
- **证据**：
  - `src/mcp/server-config.js:5-9 —— transportKind(server)：'transportKind === 'remote' || server.remoteUrl' 的唯一实现（读服务定义口径）`
  - `src/mcp/store.js:8-14 —— 为此专门起别名（'transportKind: resolveServerTransportKind'）并写注释「server-config.transportKind 是读服务定义的口径，mcp/manage.js 是入参口径」，说明本仓已把它当单一来源`
  - `src/mcp/manage.js:252 —— 'const remote = server.transportKind === 'remote' || !!server.remoteUrl;'：与 transportKind() 同义、未 require 的手写第三份`
  - `src/mcp/manage.js:40-49 —— 同文件自己声明「transport 的唯一来源：schema enum、参数校验、store 落库、Renderer 选项表全都从这里取，任何一处另抄一份都会分叉（历史上就是 transport='http' 过校验却按 stdio 落库）」`
- **为什么不整洁**：谓词有第三份。真出现新的远端形态（例如再把 `http` 认成 remote）时，这一处不会跟着改，表现为「设置页显示远端、凭据弹窗按 stdio 处理」这类只在特定服务上出现的错。
- **减法方案**：改调 `require('./server-config').transportKind(server) === 'remote'`（server-config 只依赖 env-hints，无环）；同类内联在 src/mcp 内仅此一处。
- **验证**：`npm run test:mcp-store` + `npx vitest run test/unit/mcp-*.test.cjs`；`grep -rn "transportKind === 'remote' ||" src/mcp` 应为 0。

#### features-11 [P3] mcp/credentials-store.js 拿 console.warn 当日志：注入的 log 通道它拿不到，去重键也永不失效

- **类型**：console.* 当日志 / 错误被吞掉 · 规模 **S**
- **证据**：
  - `src/mcp/credentials-store.js:14、:17 —— 'console.warn('[dieyun:mcp] …')' 两条（解不开密文的告警）`
  - `src/mcp/credentials-store.js:5-8 —— 注释说明它刻意只喊一次、且这是高频路径（列表/弹窗/建会话都读）`
  - `src/mcp/credentials-store.js:6 —— 'const warnedUndecryptable = new Set()' 是模块级、永不清空：换过 userData、用户重新填对凭据后，同一 serverId 再坏也不会再告警`
  - `src/channels/store.js:55 —— 同层相邻模块的做法是 'deps.log' 注入（'typeof deps.log === 'function' ? deps.log : () => {}'）；createMcpCredentialsStore（:24-26）的 deps 只有 safeStorage / userDataPath，没有 log`
  - `src/core-bridge.js:37-45 —— 本仓记过同一个坑：「曾经默认 noop + RPC_TIMEOUT 硬写 console.warn ⇒ GUI 打包后（无 stdout）」`
- **为什么不整洁**：打包后没有 stdout，这两条告警等于丢失；而它恰恰是「凭据存了但解不开」的唯一提示 —— 丢失后表现为「子进程拿到空 env、工具莫名其妙失败」。去重键不含失败原因，也让「同一个 ID 后来因为别的原因解不开」静默。
- **减法方案**：`createMcpCredentialsStore({ ..., log })`，两条改 `log(...)`（调用方 src/mcp/store.js 已有 log 钩子可传）；去重键带上原因类别（safeStorage 不可用 / 密钥不匹配），并在 saveSecrets 成功后清掉该 serverId 的键。
- **验证**：`npm run test:mcp-store` + test/unit/mcp-credentials-store.test.cjs（现有用例，补一条「重新保存后再坏会再告警」）。

### 4.5 rust（crates/ 110 个文件 + crates/dieyun-core 的路径转发 shim）

**总评**：整体已从「巨石 + 吞错」收敛到「五层 crate + 注册表分派」：rpc/mod.rs 336 行、handlers/ 与 registry.rs 不重复、EMBEDDING_TIMEOUT_CODE / request_budget_ms / messages_clear / index/remote.rs 等旧死代码确已删净、eprintln 只剩 obs.rs 一个出口。但仍有 5 处「同一语义两份实现」落在活路径上（出站传输字段两个作者、建库 start/sync 双入口、index/graph 两套并行状态机、表存在判定三份、graph 级联删除手写两半），另有 2 处零风险死代码、1 处指向已删 RPC 的文案会误导模型。没有发现 P0。

**审查口径与实读范围**：实测口径：Get-ChildItem crates -Recurse *.rs = 110 个文件；行数用 [System.IO.File]::ReadAllLines().Count。抽查 RUST-CORE-REFACTOR-PLAN.md 74 条地图的 10 条：D2 巨石（rpc/mod.rs 462→336、index/mod.rs 1935→503、loop_run 拆完）= 已修；D3/D8 死代码（index/remote.rs、request_budget_ms、messages_clear、EMBEDDING_TIMEOUT_CODE 无消费方）= 已修（EMBEDDING_TIMEOUT_CODE 现在 embedding/mod.rs:354 有消费方）；C 级「子串通道路径命中当强证据」= 已修（index/search.rs:446-507 拆出 content_hits）；C 级「召回量纲」= 已修（memory/recall.rs:237-247 injectScore）；B 级「MAX_GRAPH_FILES 先截断后筛」= 已修（graph/build.rs:74 复用 index::MAX_FILES + keep 预筛）；B 级「graph/schema 声明外键却不生效」= 已修（有 schema_declares_no_unenforced_foreign_keys 用例）；§12 R2 出站唯一作者 = 只成立一半（见 findings 第 1 条）；§14.1 测试分离 = 只搬了 12 个文件，另 6 处仍同居（第 9 条）。生产路径 unwrap()/expect() 逐个核过：非测试区仅 7 处，其中 5 处是有守卫的不变量（sqlite.rs:138/281、shared.rs:111、plan_parse.rs:76、planner/run.rs:229 紧邻 is_some 判定），db_schema.rs:96/98 是唯一没守卫的（且该函数只被测试调）；其余全部在 #[cfg(test)] 内联块里，未误报。clone 检测窗口逐条核实后的处置：graph/build.rs↔graph/query.rs 是 query_map(...).map_err(GRAPH_QUERY_FAILED) 样板（14 处 3 行同形），属错误映射惯用法、不是同一份语义，不建议合并；index/schema.rs↔index/vector_pool.rs 与 graph/types.rs↔index/mod.rs 的窗口命中的是并行 DTO/状态机的字段序列（已并入第 8 条）；codebase.rs↔graph.rs 的 5 个窗口是真样板（workspaceRoot / force / skipIfReady 解析），但 11 个 handler 各调各的服务，只值得抽一个参数解析 helper（P3，未成条，与第 7 条同源）。另有三项小卫生未单独成条：treesitter/chunk.rs:190 truncate 与 index/mod.rs:72 truncate_chars 是同一语义两份；now_secs 三份（index/mod.rs:374、index/status.rs:309-312、graph/build.rs:211-214）；dieyun-core/src/main.rs:56-70/76-90/100-117 三处重复的 configure + create_dir_all 样板，且 :30 的 --force 用 default_value_t = true 声明成布尔开关（永不可能是 false）。

#### rust-1 [P1] 出站传输字段 stream / stream_options.include_usage 仍有两个作者，两份注释各自自称唯一

- **类型**：重复实现 · 规模 **S**
- **证据**：
  - `crates/dieyun-runtime/src/agent/outbound.rs:71 —— apply_transport 写 stream 与 stream_options.include_usage，:73 的 if stream && obj.get(stream_options).is_none() 分支与 llm.rs 逐字相同`
  - `crates/dieyun-runtime/src/agent/llm.rs:425 —— apply_transport_fields 是同一份知识的第二份实现（:430 同一判断、同一 json 字面量），:468 在 chat_completion 里每次发请求前再写一遍`
  - `crates/dieyun-runtime/src/agent/driver.rs:188-189 与 :197 —— 同一个 spec.stream 既喂给 project_body 又传给 chat_completion，最终值由后写者（llm.rs）决定，OutboundSpec.stream 实际是会被覆盖的输入`
  - `crates/dieyun-runtime/src/agent/outbound.rs:1 与 :38 —— 模块头写「唯一作者」、OutboundSpec.stream 注释写「唯一作者也在这里」`
  - `crates/dieyun-runtime/src/agent/llm.rs:418-419 —— llm.rs 反向声明「stream 与 stream_options.include_usage 只在这里写」`
  - `crates/dieyun-runtime/src/agent/outbound.rs:70 —— apply_transport 注释说给 llm.complete 这类宿主自建 body 的路径用，但 llm.complete（crates/dieyun-runtime/src/rpc/handlers/async_core.rs:427）走的是 llm.rs 那份，这份 pub 函数只有 project_body 一个调用点`
- **为什么不整洁**：§12 记的是「出站投影已收成一个作者」，实际只收了 messages 投影，传输字段仍两份且互相覆盖。今天两处取值来自同一个 spec.stream 所以看不出差别；下次往里加传输字段（max_tokens 夹取、include_obfuscation、超时相关开关）只改一处就会分叉，而这正是 A16/stream_options 漏水那次事故的复现路径。
- **减法方案**：二选一，不要两份：删 llm.rs:425-436，chat_completion 改调 outbound::apply_transport（签名只需包一层 as_object_mut）；或反过来只留 llm.rs 作唯一写入点，把 outbound::apply_transport 删掉并删 OutboundSpec.stream 字段（现在它是被覆盖的死输入）。
- **验证**：cargo test --workspace --lib agent::llm agent::outbound agent::driver_tests；保留既有用例 streaming_request_asks_for_usage / transport_fields_do_not_overwrite_explicit_stream_options；grep stream_options 的写入点应只剩 1 处。
- **既有记录**：RUST-CORE-REFACTOR-PLAN.md §12「R2 · 出站投影（2026-11-18 落地）——现在：agent/outbound.rs 是唯一作者」。仍成立一半：messages 投影确实唯一，传输字段不是。

#### rust-2 [P1] 面向模型/用户的错误文案仍指向 P6 已删除的 codebase.index_remote

- **类型**：遗留兼容层 / 陈旧引用 · 规模 **S**
- **证据**：
  - `crates/dieyun-codebase/src/index/build.rs:203 —— REMOTE_INDEX_REQUIRED 的文案：「远程工作空间请使用 codebase.index_remote 或在远端本地路径上建索引」`
  - `crates/dieyun-codebase/src/index/build.rs:342 —— 同一个已不存在的方法名（sync 入口那份文案，措辞还不一样）`
  - `crates/dieyun-codebase/src/index/vectors.rs:73 —— 文档注释仍引用 remote::index_remote_finish_inner（该模块已整体删除）`
  - `crates/dieyun-runtime/src/rpc/registry.rs:80-167 —— METHODS 全表 86 个方法里只有 codebase.status / index / index.start / search，没有 index_remote`
- **为什么不整洁**：这是 core 交给上层的原文：远端工作区一旦撞到这条分支，模型/用户拿到的是一条「请调用 X」，而 X 会回 UNKNOWN_METHOD。P6 删掉 index/remote.rs 时没人回改这两句面向调用方的文案，属于「删了实现、留着指路牌」。
- **减法方案**：两处文案改成与 graph 侧同款说法（crates/dieyun-codebase/src/graph/mod.rs:99 已经写成「请使用远端本地路径上的 graph.index.start」）；vectors.rs:73 删掉 remote:: 引用。
- **验证**：grep -r index_remote crates/ 归零（docs/ 下历史记录可保留）；远端工作区调 codebase.index.start 应只看到「在远端本地路径上建索引」。
- **既有记录**：RUST-CORE-REFACTOR-PLAN.md §2.4 D8 死代码清单 / §5 P6「index/remote.rs 整条（344 行 + RemoteIngestHandle）真死，一起删」。代码删了，指路文案与文档注释没删 —— 现在仍成立。

#### rust-3 [P1] 「这个库里有没有这张表」三份实现，其中一份注释自称唯一定义

- **类型**：重复实现 · 规模 **S**
- **证据**：
  - `crates/dieyun-codebase/src/index/schema.rs:46-48 —— 注释写「这张表在这个库里存在吗」的唯一定义，pub(super) fn table_exists，查询 sqlite_master`
  - `crates/dieyun-codebase/src/graph/schema.rs:27-36 —— graph 侧又一份 fn has_table，同一条 SELECT 1 FROM sqlite_master WHERE type=table AND name=?1 LIMIT 1`
  - `crates/dieyun-codebase/src/codebase_db.rs:36-44 —— 第三份（测试模块内，用 SELECT COUNT(*) 变体），而它自己的测试就是在验证 index/graph 两张表`
- **为什么不整洁**：同一个 crate 里三份同一 SQL，index 那份是 pub(super)，graph 用不上于是各写一份 —— 注释宣告的单一来源是假的。将来换成 user_version 判定、加前缀或加 schema 校验，改一处会让另两处静默按老逻辑走；三份的返回类型还不一致（Result<bool, CoreError> vs bool）。
- **减法方案**：把 table_exists 提到 dieyun_base::db_schema（与 ensure_table / ensure_column 同一处，那个模块的存在理由正是「一份结构清单」），删 graph/schema.rs 的 has_table 与 codebase_db.rs 测试里的第三份，graph 的 has_table 调用点（graph/schema.rs:19）改调公共版本。
- **验证**：cargo test -p dieyun-codebase --lib（schema / codebase_db 用例）；grep -c sqlite_master crates/dieyun-codebase/src 应只剩 db_schema 与我列出的 schema 自检用例。

#### rust-4 [P1] graph/query.rs 手搓的 OptionalRow 是 rusqlite OptionalExtension 的重造

- **类型**：重复实现 · 规模 **S**
- **证据**：
  - `crates/dieyun-codebase/src/graph/query.rs:735-747 —— trait OptionalRow 与 impl，语义就是 QueryReturnedNoRows → None，其余上抛（13 行）`
  - `crates/dieyun-codebase/src/graph/schema.rs:1 —— 同一个 crate 的另一个文件一直用的是真的 use rusqlite::OptionalExtension`
  - `crates/dieyun-memory/src/memory/projects.rs:64 —— 全仓其它点也都是 .optional()? 的标准用法`
- **为什么不整洁**：同一 crate 里一半人用标准扩展 trait、一半人用手搓的，读代码要先证明两者等价；而 query.rs 的三处 .optional() 调用（:329/:343/:353）看上去和标准 API 一模一样，最容易让后来人以为引错了 crate。
- **减法方案**：删 query.rs:735-747，文件头加 use rusqlite::OptionalExtension，三个调用点不动（方法名相同、语义相同）。
- **验证**：cargo test -p dieyun-codebase --lib graph::query；cargo clippy --workspace --all-targets -- -D warnings。

#### rust-5 [P1] purge_stale_files 是 purge_removed_files 的纯转发包装，两个名字表达同一件事

- **类型**：死代码 · 规模 **S**
- **证据**：
  - `crates/dieyun-codebase/src/graph/cleanup.rs:116-122 —— 函数体只有一行 purge_removed_files(conn, root_hash, keep)`
  - `crates/dieyun-codebase/src/graph/build.rs:78-82 —— force 分支调 purge_removed_files，非 force 分支调 purge_stale_files，其实同一个函数，让读者以为 force / 增量有不同清理语义`
- **为什么不整洁**：纯历史原因保留的第二个名字：没有任何参数、语义或注释上的差别。它让「force 与非 force 的清理差异在哪」这个真问题凭空多出一个分支要看。
- **减法方案**：删 cleanup.rs:116-122，build.rs:81 改调 purge_removed_files；若确实想要「增量时清哪些」的语义文档，写成 purge_removed_files 的注释而不是空壳函数。
- **验证**：cargo test -p dieyun-codebase --lib graph；grep purge_stale_files 归零。

#### rust-6 [P1] walk_defs 的 src 参数没人用，靠 let _ = src 压掉警告

- **类型**：死代码 / 未使用参数 · 规模 **S**
- **证据**：
  - `crates/dieyun-codebase/src/treesitter/chunk.rs:30 —— 形参 src: &[u8]`
  - `crates/dieyun-codebase/src/treesitter/chunk.rs:69 —— let _ = src; // keep signature parity for future text checks`
  - `crates/dieyun-codebase/src/treesitter/chunk.rs:77 —— 递归调用把它一路往下传（每层都传一个没人读的切片）`
- **为什么不整洁**：注释自己承认是为「将来可能要用」保留的签名，正是「只为历史原因保留」；占位语句还把编译器对未用参数的提示一起消掉了，于是下一轮审计只能靠人工发现。
- **减法方案**：删形参、删 chunk.rs:10 的实参与 :77 的递归实参、删 :69 的占位行；将来真要按文本判断再加参数。
- **验证**：cargo test -p dieyun-codebase --lib treesitter::chunk；cargo clippy --workspace --all-targets -- -D warnings。

#### rust-7 [P2] 建库两条入口（*.index.start 与 *.index）各一份实现，前置守卫抄两遍且已漂移

- **类型**：重复实现 / 职责重叠 · 规模 **M**
- **证据**：
  - `crates/dieyun-codebase/src/index/build.rs:192 —— start_index_workspace（后台线程 + 进度）`
  - `crates/dieyun-codebase/src/index/build.rs:332-376 —— index_workspace（同步跑）；is_remote 守卫、resolve_workspace、加锁、已运行判定与 start 版逐字同形，只有错误文案和「是否复核竟态」不同`
  - `crates/dieyun-codebase/src/graph/mod.rs:88 与 :230 —— graph 侧同形的两份；竞态复核只在 start 版（:142-151），sync 版 :249-259 只查一次就直接 insert`
  - `crates/dieyun-runtime/src/rpc/handlers/codebase.rs:25-35 与 crates/dieyun-runtime/src/rpc/handlers/async_data.rs:122-132 —— EMBEDDING_NOT_CONFIGURED 守卫连中文文案都抄了两份（只差一句「或在设置里配好 embedding 后重试」）`
  - `src/gateway/rpc.js:1771-1782 —— 同步入口现在只剩「旧 core / 旧远端包不认识 .index.start」时的兼容回退在用，且它只匹配 REMOTE_INDEX_UNSUPPORTED 与 unknown method 两个信号`
- **为什么不整洁**：这是 §2.4 D2「同一语义多入口」仅存的一对：谁阻塞、谁带 skipIfReady、谁复核竞态，两条路各写一次。已经漂移 —— sync 路没有 start 路的竞态复核，两处远端报错文案不一致，EMBEDDING 守卫要让两处同时改才不跑偏。
- **减法方案**：让 sync 入口变薄壳：index_workspace / graph.index 内部改成「调 start_index_workspace，然后等线程结束读 status」，守卫只留 handlers 层一份 helper；如果确认兼容回退已无用（remote-index-core.js:15-20 白名单里本来就有 .index.start），连 sync RPC 与 gateway 的 syncMethod 分支一起删。
- **验证**：cargo test --workspace --lib；npm run verify:rpc-catalog；codebase.index / graph.index 两条 RPC 的返回形状与 already_running / skipIfReady 语义逐项对齐 start 版。
- **既有记录**：RUST-CORE-REFACTOR-PLAN.md §2.4 D2 记的是「本地 run_index vs 远端 index_remote 两份逐字重复」，远端那条已删；start / sync 这一对当时没记，现在仍成立。

#### rust-8 [P2] index 与 graph 两套并行状态机：进度表、脏旗标修复、进行中快照三处同形各写一份

- **类型**：重复实现 · 规模 **M**
- **证据**：
  - `crates/dieyun-codebase/src/index/mod.rs:127-159 —— set_progress / set_progress_error / clear_progress，字段 chunk_count/vector_count`
  - `crates/dieyun-codebase/src/graph/status.rs:22-58 —— 同三个方法，逐字同形只换字段名（edge/symbol/call_count）`
  - `crates/dieyun-codebase/src/index/status.rs:363-384 与 crates/dieyun-codebase/src/graph/status.rs:61-85 —— apply_live_progress 两份（phase / files_done / files_total 取大值合并进状态）`
  - `crates/dieyun-codebase/src/index/status.rs:133-152 与 crates/dieyun-codebase/src/graph/status.rs:208-214 —— best-effort 脏旗标修复两份：都是 open_dedicated + busy_timeout(0) + UPDATE ... SET indexing = 0，只是 index 侧顺带回写计数`
  - `crates/dieyun-codebase/src/index/mod.rs:43-51 与 crates/dieyun-codebase/src/graph/status.rs:192-201 —— ProgressSnapshot vs GraphProgressSnapshot，同一形状；index/mod.rs:316-323 与 graph/types.rs:58-65 的 StartIndexResult vs GraphStartIndexResult 也只差内层状态类型`
- **为什么不整洁**：一条「后台任务 + 进程内进度表 + 崩溃残留修复 + 进行中快照」的骨架写了两遍，约 120 行。已经出现不一致：graph 的 apply_live_progress 不把 error 之外的相位信息回填、index 的修复要顺带对齐计数，两套越各自长越难判断「这条 status 字段该由谁产出」。
- **减法方案**：抽一个 LiveProgress<T>（HashMap + set/error/clear/apply）与一个 repair_stale_flag(conn, table, root_hash)，index / graph 只提供字段映射闭包；Start*Result 用泛型包装或直接复用同一结构（\.status 里已有 serde(flatten) 的先例）。
- **验证**：cargo test --workspace --lib（index/graph 的 status、legacy、repair 用例）；两套 status 的字段语义分别有 panel 侧断言，改后 npm run test:local-gateway-smoke 仍绿。

#### rust-9 [P2] 「实现 + 数百行测试同居」仍剩 6 处，最重的是 memory/snapshot.rs（333 行测试）与 index/vector_pool.rs（296 / 426 行）

- **类型**：测试与实现同居 · 规模 **M**
- **证据**：
  - `crates/dieyun-memory/src/memory/snapshot.rs:497 —— cfg(test) 起，文件共 829 行，测试区 333 行`
  - `crates/dieyun-codebase/src/index/vector_pool.rs:131 —— 测试区 296 行 / 全文 426 行，实现只占前 130 行`
  - `crates/dieyun-codebase/src/index/vector_cache.rs:90 —— 测试区 247 行 / 全文 336 行`
  - `crates/dieyun-codebase/src/index/schema.rs:204（197 行）；crates/dieyun-codebase/src/graph/query.rs:749（184 行）；crates/dieyun-runtime/src/agent/outbound.rs:124（182 行 / 全文 305 行）`
- **为什么不整洁**：§14.1 那一轮只搬了 12 个大文件（memory/mod.rs、index/mod.rs、llm.rs…），这批没进名单，其中最差的两个文件已经是「读实现先翻过 2/3 的用例」。这不是个人风格问题：它让「改一个量化参数」要在 296 行用例之间定位，也让 diff 不可读。
- **减法方案**：照 §14.1 的既有做法纯移动：同级 xxx_tests.rs + #[cfg(test)] #[path = "xxx_tests.rs"] mod tests;，一条用例都不改（模块身份与 use super::* 语义不变）。按性价比先做 vector_pool / vector_cache / snapshot 三个。
- **验证**：cargo test --workspace --lib 条数一致、全绿；--no-default-features 同样一致。
- **既有记录**：ARCHITECTURE-DEBT.md §14 标「半条」；RUST-CORE-REFACTOR-PLAN.md §14.1 列了已搬的 12 个文件、§10.8 第 7 条标「已完成」—— 对这 6 个文件不成立，仍成立。

#### rust-10 [P3] 陈旧/错位注释：指向已删的 ServiceSnapshot::dispatch、与代码相反的 .env 归属、悬空的列说明

- **类型**：陈旧注释 / 注释与代码不符 · 规模 **S**
- **证据**：
  - `crates/dieyun-runtime/src/rpc/registry.rs:11 —— 「Blocking → ServiceSnapshot::dispatch」，该函数已不存在（dispatch 只有 AppState 一个，crates/dieyun-runtime/src/rpc/mod.rs:162）`
  - `crates/dieyun-runtime/src/rpc/mod.rs:157 —— rustdoc 链接 [ServiceSnapshot::dispatch] 已经是断链（ServiceSnapshot 上没有任何 impl）`
  - `crates/dieyun-runtime/src/rpc/handlers/graph.rs:3 —— 文件头写「由 ServiceSnapshot::dispatch 的臂体机械搬来」；codebase.rs:3 / agent.rs:3 / memory.rs:3 同款`
  - `crates/dieyun-codebase/src/index/walker.rs:85-86 —— 注释说「IGNORE_EXT 里有 .env，别把它加回扩展名白名单」，实际 .env 在 SECRET_EXT（:46），IGNORE_EXT（:26-35）里没有它`
  - `crates/dieyun-memory/src/memory/schema.rs:260-271 —— 四段列说明（title_source / session_id / reasoning / trace_text）悬在唯一一句 drop_column_if_exists 上方，对应列已改由 :6-41 的列清单声明，注释与那行代码毫无关系`
- **为什么不整洁**：五处都在讲「已经不存在的东西」：读的人会去找一个没有的函数（断链），或者按注释去 IGNORE_EXT 里删 .env（那会破 test/unit/ignore-rules-parity 的「与 Node BINARY_EXT 完全相等」闸门），或者在删列语句上方读到四段讲加列的说明。
- **减法方案**：改字与移位，零行为变化：registry.rs:11 与 4 个 handler 头改成「AppState::dispatch + registry::METHODS」；walker.rs:85 改成 SECRET_EXT；memory/schema.rs:260-270 的四段搬回顶部对应列声明旁，trace_text 那段留在 drop 处。
- **验证**：cargo doc -p dieyun-core --no-deps 无 broken intra-doc link 警告；cargo test --workspace --lib。

#### rust-11 [P3] 调用边置信度 0.8/0.9 散在四处，进度上报的 % 16 写两遍，repo_map 的 markdown 上限还与 limit 参数脱钩

- **类型**：魔法数字 · 规模 **S**
- **证据**：
  - `crates/dieyun-codebase/src/graph/build.rs:321 —— confidence = if callee_id.is_some() { 0.9 } else { 0.8 }`
  - `crates/dieyun-codebase/src/graph/build.rs:512 —— 回填时 UPDATE graph_calls SET callee_symbol_id = ?2, confidence = 0.9 WHERE id = ?1（字面量第三个副本）`
  - `crates/dieyun-codebase/src/graph/cleanup.rs:72 —— 撤销解析的 SQL 里又硬写 confidence = 0.8`
  - `crates/dieyun-codebase/src/graph/schema.rs:99 —— 表定义 DEFAULT 0.8，同一份知识的第四处`
  - `crates/dieyun-codebase/src/graph/build.rs:123 与 :180 —— files_done % 16 == 0 同一条上报条件写两遍（无名数字）`
  - `crates/dieyun-codebase/src/graph/query.rs:694/700/719/725 —— markdown 逐段只 take(16) / take(28) / take(24) / take(4)，而 :539-541 算出的 file_limit(≤32) / edge_limit(≤48) 只作用于 JSON，打印口径与 limit 参数无关（limit=64 时文件段仍只印 16 条）`
- **为什么不整洁**：「置信度只有两档」是一件真知识，却有四个字面量副本：改档位要改四处，漏一处就是同一张图里两种置信度并存。markdown 的四个上限则是另一类：它们看起来像 limit 派生值，实际是独立常量，让 limit 参数的一半语义失效。
- **减法方案**：在 graph 模块内加 CONF_RESOLVED / CONF_UNRESOLVED 两个常量（schema 的 DEFAULT 引用同一份文本、cleanup 的 UPDATE 用常量拼 SQL）；% 16 提成 PROGRESS_EVERY；markdown 段用传入的 limit 派生（或明确命名 MARKDOWN_FILES_MAX 等并写清与 limit 的关系）。
- **验证**：cargo test -p dieyun-codebase --lib graph（repo_map 与 refs 两条用例不改数值即绿）。

#### rust-12 [P3] 手写级联删除的前一半把错误吞掉：孤儿向量与进度少报都不出声

- **类型**：错误被吞掉 · 规模 **S**
- **证据**：
  - `crates/dieyun-codebase/src/index/mod.rs:386 —— 删 chunk_vectors 的那句挂 .ok()，紧接着 :387 删 chunks 用 ? 上抛：前一半失败就留下永久孤儿向量行`
  - `crates/dieyun-codebase/src/index/mod.rs:398 —— delete_chunks_for_path 同款（先 .ok() 删向量，再 ? 删 chunk）`
  - `crates/dieyun-codebase/src/graph/cleanup.rs:61-66 —— if let Ok(n) = conn.execute(DELETE FROM graph_calls ...) { calls_deleted += n }：失败既不报错也不计数，调用方的进度计数静默少报`
  - `crates/dieyun-codebase/src/graph/cleanup.rs:76 与 :96 —— 同函数里另两处 .ok()`
- **为什么不整洁**：crates/dieyun-codebase/src/index/schema.rs:186-190 明写「级联在这儿是一份手写实现」——既然它是唯一实现，它的失败路径就不能无声。而孤儿 chunk_vectors 恰恰看不见：count_vectors 与探针都用 JOIN chunks，面板与 can_vector 都不会报，只有库体在涨（这与 VECTOR-SEARCH 要求的「元数据描述真实存在的向量」是同一类静默问题）。
- **减法方案**：两处 DELETE 都改成 ? 或收进同一个事务（失败则整对回滚，语义正确且无孤儿）；确实可以失败即放弃的位置改用 dieyun_base::obs::degraded 留一行，别用 .ok()。
- **验证**：cargo test -p dieyun-codebase --lib；用只读打开的连接跑 delete_chunks_for_path 应返回 Err 而不是静默 Ok。

### 4.6 scripts/ + test/ + .github/workflows（代码整洁度）

**总评**：不通过。本域没有自动滑窗命中，但实地读下来有 1 处 P0：一个「测试」把自己要测的生产逻辑抄进脚本里再断言副本（且已与生产漂移）——等于该模块零真实覆盖。另有 4 处 P1：同一提交里落的重复测试、全仓零引用的调试脚本兼第六份 safeStorage 解密路径、CI 上恒 SKIP 的 3 个 core 依赖套件、30 个 test/verify 闸门既不进 CI 也不在任何 CODEMAP suite。结构性问题（69 个手写 smoke 与 246 个 vitest 两套体系并行；test-alive.cjs 单函数 1896 行）属 P2 需分批。

**审查口径与实读范围**：scripts/ 138 文件（其中 test-*.cjs 69 个 / 21045 行）；test/ 255 文件（test/unit 246 个 / 40384 行，vitest include=test/unit/**/*.test.cjs）；.github/workflows 仅 ci.yml 51 行；package.json 145 个 npm script，CI 只显式调 8 个（check:contracts / lint:agent / verify:core-contracts / check:js / check:renderer / test:agent + 2 条 cargo 双特性）；30 个 test:*/verify:* 闸门不在 CI 也不在 CODEMAP suites；40/69 个 smoke 脚本 require 的 src 模块同时被 test/unit 引用；scripts/ 与 test/unit 同名 5 组，逐组核过：1 组全重复、1 组半重复、2 组在注释里明确分工、1 组分不同入口。

#### scripts-tests-1 [P0] test-composer-queue-edit.cjs 把 renderer-composer-queue 的生产逻辑抄进脚本再断言副本（已漂移）

- **类型**：重复实现（已漂移） · 规模 **M**
- **证据**：
  - `scripts/test-composer-queue-edit.cjs:10-46 —— 脚本自己定义 newComposerQueueItemId / normalizeComposerQueueItem / normalizeComposerQueueList / reorderById 四个函数，全文件 require 只有 'assert'（:8），从不 require 生产模块`
  - `scripts/test-composer-queue-edit.cjs:26 —— 副本的 attachments 语义是 'Array.isArray(raw&&raw.attachments) ? raw.attachments.slice() : []'`
  - `src/renderer/renderer-composer-queue.js:59-63,84 —— 生产用 cloneQueueAttachments() → cloneAttachmentSnapshot()（renderer-attachments.js:34）做附件快照克隆；副本只有浅 slice，非数组时返回 [] —— 同一语义两份且已经不同`
  - `src/renderer/renderer-composer-queue.js:654-666 —— 生产 reorderComposerQueueItem(sessionId,id,toIndex) 有一条副本里根本不存在的业务规则：:656 'if (editingIdFor(sid) === String(id||'')) return false'（正在编辑的条目不许挪），另加 persistComposerQueues()/updateComposerQueueUi() 副作用`
  - `scripts/test-composer-queue-edit.cjs:80-88 —— 脚本断言的是自己那份 reorderById/rev 语义，所以 :656 这条规则、持久化、UI 刷新全部零覆盖`
  - `test/unit 里 grep 'renderer-composer-queue' 零命中 —— 919 行模块在 vitest 单测体系里没有任何测试，唯一「测试」就是这份副本`
- **为什么不整洁**：这是整洁度口径 1 的最坏形态：同一语义两份实现，且副本已被当成「事实来源」——测试全绿只能证明副本自洽。生产侧 rev 计数、编辑互斥、附件克隆任一漂移都不会红；而发送队列是用户可见路径。
- **减法方案**：删掉脚本里那四个函数，改成从 src/renderer/renderer-composer-queue.js 取实现（该模块是 renderer 脚本，需要 vm 沙箱装载，可复用 test/unit/lib/load-renderer-fmt.cjs 那种装载方式），把断言改成对生产实现的断言；随后把 scripts/test-composer-queue-edit.cjs 整体并入 test/unit/renderer-composer-queue.test.cjs，删 package.json:51 的 test:composer-queue。
- **验证**：npx vitest run test/unit/renderer-composer-queue.test.cjs；改 :656 的 editingIdFor 判据应能让新测试变红（变异验证）。

#### scripts-tests-2 [P1] 会话交接同一个功能落了两份同语义测试（脚本 109 行 / 单测 117 行）

- **类型**：重复实现（测试） · 规模 **S**
- **证据**：
  - `scripts/test-session-handoff.cjs:3-8 —— 自述「钉住三件事：快照是确定性投影 / 判断在前原文在后 / 注入块有定界标签 + '<' 转义」`
  - `test/unit/session-handoff.test.cjs:5-11 —— 同三件事逐条重述，可逐句对应`
  - `scripts/test-session-handoff.cjs:41-42 —— buildSnapshot([],500)==='' 与空白正文用例；test/unit/session-handoff.test.cjs:68-86 —— 同一组空态用例，但用更严的 EMPTY_SESSION / EMPTY_HANDOFF 错误码`
  - `scripts/test-session-handoff.cjs:88-97 与 test/unit/session-handoff.test.cjs:107-108 —— '<handoff>' 定界与「不得执行」断言两边各写一遍`
  - `git: 5506a46「feat(agent): 会话交接摘要」一个提交同时带入 scripts/test-session-handoff.cjs(+109) 与 test/unit/session-handoff.test.cjs 的变更`
  - `docs/CODEMAP.json:1767-1769 —— pathRule 把 src/agent/session-handoff.js 只映到 test:session-handoff，即改这个模块时 npm test 跑的是要删的那一份，更全的单测反而不会被选中`
  - `package.json:76 —— test:session-handoff 定义；该闸门也不在 CI 也不在 CODEMAP suites`
- **为什么不整洁**：两份守同一批断言，脚本这份唯一多出的是 audit.handoff.from、`\u003c` 转义形态、`</handoff>` 只出现一次三条；其余全被单测覆盖且更严。留着就是每次改交接要维护两处、且改了单测不会影响 CODEMAP 选中项。
- **减法方案**：把上面三条断言搬进 test/unit/session-handoff.test.cjs 后删 scripts/test-session-handoff.cjs 与 package.json:76；docs/CODEMAP.json:1769 把 test:session-handoff 换成 test:unit。
- **验证**：npx vitest run test/unit/session-handoff.test.cjs；npm run check:contracts（CODEMAP 与 npm scripts 一致性闸门）。

#### scripts-tests-3 [P1] dev-decrypt-ssh-pw.cjs 全仓零引用，且是 safeStorage 解密路径的又一份手写实现（失败还以 exit 0 收场）

- **类型**：死代码 + 重复实现 · 规模 **S**
- **证据**：
  - `scripts/dev-decrypt-ssh-pw.cjs:30-37 —— 自己 readFileSync(ssh-profiles.json) + Buffer.from(row.secretEnc,'base64') + safeStorage.decryptString + 直接 writeFileSync(明文,{mode:0o600})，全程绕过 src/secret-store.js`
  - `src/ssh/credentials-store.js:10-22 —— 生产侧加解密只是转调 createSecretStore（唯一实现），并有 onCorrupt / 0600 / 原子写语义；scripts 这份自成一套`
  - `scripts/dev-decrypt-ssh-pw.cjs:39-42 —— catch 里只 console.log('DECRYPT_FAIL …') 然后 app.exit(0)：解不出来时调用方/脚本看到的是成功退出`
  - `全仓检索（排除 node_modules/build/.git）只在本文件 :10、:29 的用法注释里出现 —— 零调用点、无 npm script、无文档引用`
  - `git fd5dd1a「feat(ssh): 连接参数/认证/跳板/结果语义收敛」一并提交后就再没被改过或被引用`
- **为什么不整洁**：既是死代码（口径 2），又是凭据解密路径的第六份实现（口径 1/6）。它还会把明文密码写进 %TEMP%，而且失败退出码是 0 —— 真出问题时会静默留一个空/旧文件给真机验收脚本。
- **减法方案**：删文件。若确实还需要真机取一次密码，就用 electron 跑一个只调 src/secret-store.js 读接口的一次性命令（文档写在 docs/ 里），不要在 scripts/ 留第二份解密实现。
- **验证**：grep -r 'dev-decrypt-ssh-pw'（含 .gitignore 外全仓）→ 0 命中；npm run check:contracts 仍绿。

#### scripts-tests-4 [P1] CI 上 npm run test:agent 恒 SKIP 三个 core 依赖套件，且以 exit 0 通过

- **类型**：死代码（闸门从不执行）+ 错误被吞掉 · 规模 **S**
- **证据**：
  - `scripts/test-agent-smoke.cjs:22-31 —— REQUIRES_CORE 手抄清单（8 个脚本名）`
  - `scripts/test-agent-smoke.cjs:99-103 —— allowSkip 且 resolveDieyunCoreBinary() 为 null 时只 console.log('SKIP …') 然后 return，不计失败`
  - `scripts/test-agent-smoke.cjs:156 —— 运行套件时一律 allowSkip:true`
  - `.github/workflows/ci.yml:24-37 —— npm ci 之后依次 check:contracts / lint:agent / verify:core-contracts / check:js / check:renderer / test:agent，**没有任何 cargo build 或 pack:dieyun-core**；cargo 两条在 :44-51，排在 test:agent 之后`
  - `.gitignore:9 —— build/dieyun-core/ 被忽略，CI 工作区里不可能有预置二进制`
  - `docs/CODEMAP.json:2041-2098 suites.agent 里在册的 test:core-bridge(:2047) / test:request-snapshot(:2072) / test:planner-e2e(:2080) 因此永远走 SKIP 分支`
- **为什么不整洁**：这不是「少跑几条」，而是三条闸门在唯一自动化环境里恒不执行、还返回成功 —— 与空 catch 同型。request-snapshot 的落库语义、core-bridge、planner-e2e 目前没有任何机器保护。
- **减法方案**：二选一且都不加机制：①CI 在 test:agent 之前加 `cargo build -p dieyun-core` 并 export DIEYUN_CORE_BIN（cargo 步骤本来就在，只是顺序）；②给 smoke runner 加 --no-skip，CI 用它，让缺 core 变成红。不要再往 REQUIRES_CORE 里加名字。
- **验证**：CI 日志里 grep 'SKIP test:' 应为 0；本地 DIEYUN_CORE_BIN 指向不存在路径时 npm run test:agent --no-skip 应非零退出。

#### scripts-tests-5 [P1] 30 个 test:*/verify:* 闸门既不进 CI 也不在任何 CODEMAP suite；其中至少 5 个是纯函数、本可免费进 CI

- **类型**：死代码（闸门未接线） · 规模 **M**
- **证据**：
  - `.github/workflows/ci.yml:9-51 —— 全仓唯一 workflow，跑的闸门就是 :27/:29/:31/:33/:35/:37 六条 + cargo 两条`
  - `docs/CODEMAP.json:2041-2098 suites.agent（56 项）、:2033-2040 suites.minimal（6 项）、:2099-2158 agent-full（57 项）—— 不含下表中的任何一项`
  - `不在 CI 也不在 suite 的 test:*（16 个）：test:renderer-csp / test:composer-queue / test:phase5-handlers / test:sandbox-real / test:browser-smoke / test:project-memory-file / test:session-handoff / test:core-event-channel / test:desktop-camera / test:reviewer-json / test:rust-agent-loop / test:llm-reconnect-retry / test:rust-planner-pipeline / test:remote-worktree-live / test:tool-bridge-delegate / test:dieyun-core-pack`
  - `不在 CI 也不在 suite 的 verify:*（14 个）：verify:bundled-skills / verify:asar / verify:remote-pack / verify:remote-agent-socket / verify:remote-agent-fs / verify:mcp-bundled / verify:vector-cache-reuse / verify:index-timing-local / verify:index-timing-ssh / verify:index-effectiveness / verify:headless-pack / verify:headless-deb / verify:headless-apt / verify:tool-validators`
  - `反例（说明不是「必须手动」）：scripts/test-reviewer-json.cjs:3-9 纯函数断言；scripts/test-llm-reconnect-retry.cjs:3-11 纯函数；scripts/test-project-memory-file.cjs:3-9 自述「这里只测纯函数」；scripts/test-tool-bridge-delegate.cjs:3-7 用本地 mock gateway；scripts/test-phase5-handlers-smoke.cjs:6-10 用 scripts/lib/test-gateway-harness.cjs（本地进程）`
  - `确属环境受限的（保持手动没错）：scripts/test-renderer-csp.cjs:3-15 需要真 Chromium/Playwright；scripts/verify-remote-gateway-pack.cjs:7-9 读打包产物 resources/remote-gateway-pack`
  - `package.json:152 —— verify:tool-validators 是 'generate-tool-validators.cjs --check'，即 N2.1 的生成物过期闸门，同样不在 CI`
- **为什么不整洁**：闸门存在但不被任何自动化调用，等于把「跑没跑」交给人的记性；且 package.json 里同时躺着 generate:X 与 verify:X --check 成对定义，看起来有保护，实际没人跑。NODE-THINNING-PLAN 的验收口径默认这些闸门在 CI 上。
- **减法方案**：两步减法：①5-6 个纯函数脚本迁进 test/unit/（vitest 已被 suites.agent 的 test:unit 覆盖，等同免费进 CI），删对应 npm script；②把只读的 --check 型闸门（verify:tool-validators / verify:mcp-bundled / verify:asar / verify:remote-pack）加成一个 ci.yml step。不为「跑不到的闸门」再添开关。
- **验证**：npm run check:contracts 不因删除而红（CODEMAP 引用需同步）；ci.yml 里每个 verify:* 步骤应当能在干净 checkout 上直接跑通。
- **既有记录**：部分在册：MODULE-CHAOS-REVIEW.md:195 明确把 `scripts/`（63 个 test + 打包链）列为尚未审计的区域；NODE-THINNING-PLAN.md:69 只把 verify:core-contracts 写进 CI，:87 的 verify:tool-validators 从未进 CI —— 本轮把缺口落成具体清单。

#### scripts-tests-6 [P2] test-alive.cjs：1989 行单文件、单个 main() 约 1896 行、47 用例横跨 9 个模块 8 个验收面

- **类型**：超长函数 / 职责混杂 · 规模 **L**
- **证据**：
  - `scripts/test-alive.cjs:88 —— 'async function main() {' 开始；:1986 'main().catch(...)' 结束 —— 单函数约 1896 行`
  - `scripts/test-alive.cjs:3-15 —— 自述 A–H 八个互不相干的验收面（漂移 / 相位 / 张力 / 阈值 / 决策 / 30 天运行 / 疲劳口径 / 感官）`
  - `scripts/test-alive.cjs:22-38 —— 一次 require 九个 src/alive/* 模块 + session-context + llm-usage-recorder`
  - `scripts/test-alive.cjs:47-86 —— ok()/okAsync()/mkTmp()/seededRng()/testCfg() 五个自造辅助，全部只为这一个函数服务`
  - `47 个 'ok(' / 'okAsync(' 用例（计数）全压在同一个函数体内；文件头自称「单元测试」，却以 scripts/ 下的手写 runner 形式存在，不属于被 CI 覆盖的 test:unit`
- **为什么不整洁**：改 alive 的任一子模块都要在近 2000 行的同一函数里定位与插入用例；断言失败时调用栈只指向一个巨大函数，定位成本高。这也是「测试与实现同居以致阅读成本高」的典型（口径 3/8）。
- **减法方案**：按 A–H 拆成 test/unit/alive-{vitals,phase,tension,waker,decide,runtime,senses}.test.cjs（vitest 已被 CI 覆盖），scripts/ 只留一个跑 30 天整链路的 smoke。
- **验证**：拆完后 npx vitest run test/unit/alive-*.test.cjs 覆盖原 47 条；npm run test:alive 应只剩整链路一条。

#### scripts-tests-7 [P2] test-headless-desktop-ui.cjs 的存在理由已被 test/unit/headless-desktop-ui.test.cjs 覆盖（半重复）

- **类型**：重复实现（测试） · 规模 **S**
- **证据**：
  - `scripts/test-headless-desktop-ui.cjs:6-10 —— 唯一的立项理由：「shim 是模板字符串生成的 JS，反引号会提前闭合模板，产物语法坏掉而 node --check 查不出来」`
  - `scripts/test-headless-desktop-ui.cjs:30 —— 'assert.doesNotThrow(() => new Function(shim))' 就是这条理由的落地`
  - `test/unit/headless-desktop-ui.test.cjs:133-140 —— 「替身真跑一遍」用 'vm.runInNewContext(shim, sandbox)' 执行同一份 shim，语法坏一样会抛；:141-184 还断言 gatewayRpc/onGatewayEvent 形状与能力诚实性`
  - `scripts/test-headless-desktop-ui.cjs:47-57 —— 剩下的独有断言只是 shim 字符串包含 'desktop.set_workspace' 等 RPC 名（字符串包含式检查）`
  - `package.json:148 —— test:headless-desktop-ui；该脚本也在 suites.agent / agent-full 里，即 CI 会跑重复的那一半`
- **为什么不整洁**：两份都守「shim 必须合法且形状对」，单测那份更强（真执行 + 形状断言）。脚本留着只增加一处需要同步维护的字符串白名单。
- **减法方案**：把 :47-57 的 RPC 名清单与 tricky 路径/空 workspace 两个边界搬进 test/unit/headless-desktop-ui.test.cjs 的一个 it()，删 scripts/test-headless-desktop-ui.cjs 与 package.json:148，并从 docs/CODEMAP.json 的 suites 与 pathRules 里摘掉该名字。
- **验证**：npx vitest run test/unit/headless-desktop-ui.test.cjs；npm run check:contracts。

#### scripts-tests-8 [P2] 两套并行测试体系：69 个手写 smoke（21045 行）与 246 个 vitest（40384 行），只有后者被 test:unit 固定覆盖

- **类型**：职责混杂 / 体系分裂 · 规模 **M**
- **证据**：
  - `规模：scripts/test-*.cjs 69 个文件 21045 行（'[System.IO.File]::ReadAllLines' 计数）；test/unit 246 个文件 40384 行；vitest.config.cjs:6 include 只认 test/unit/**/*.test.cjs`
  - `40/69 个 smoke 脚本 require 的 src 模块同时被 test/unit 引用（按 require 路径程序化统计）；即同一批模块两套体系各测一遍`
  - `同名 5 组逐一核过：session-handoff=全重复；headless-desktop-ui=半重复（本清单单列）；headless-desktop-turn / request-snapshot / scm-service=互补（scripts/test-headless-desktop-turn.cjs:3-10 走 set_workspace 真路径、test/unit/headless-desktop-turn.test.cjs:3-11 只测桌面轮边界；test/unit/request-snapshot.test.cjs:6-8 明确写「落库见 scripts/test-request-snapshot.cjs」；scripts/test-scm-service.cjs:4-11 明确写为什么要真跑 git）`
  - `纯函数断言却放在 smoke runner 里的例子：scripts/test-reviewer-json.cjs:3-9、scripts/test-llm-reconnect-retry.cjs:3-11、scripts/test-project-memory-file.cjs:3-9、scripts/test-composer-queue-edit.cjs（还抄了实现）`
  - `两套的 runner 语义也不同：smoke 用手写 assert + process.exit(1)（69 个脚本里 37 个自定义 function assert(、42 个自带 process.exit(1)），vitest 那套有 globals/forks/串行配置（vitest.config.cjs:1-13）`
- **为什么不整洁**：没有一条判定规则说「什么样的测试该放哪」，于是同名、同模块、同断言在两边生长；连带后果是 CI 只覆盖其中一套，另一套只能靠人记得敲 npm run test:xxx（见本清单 P1 那条 30 个闸门）。
- **减法方案**：只立一条判定并执行：需要真 core 进程 / 真机 / Electron / 硬件 / 外网 → 留 scripts/；纯函数与可 mock → 迁 test/unit 并删 npm script。不为「统一」新造第三套 runner。
- **验证**：迁移后 scripts/test-*.cjs 数量应显著下降，且每个残留脚本头部都能一句话说明「为什么不能用 vitest 跑」。
- **既有记录**：MODULE-CHAOS-REVIEW.md:195 把 scripts/（63 个 test + 打包链）列为未审计区域，本轮给出规模与抽样结论；REDUNDANCY-REVIEW C 节（伪冗余清单）不涉及测试目录。

#### scripts-tests-9 [P2] inventory-tool-validate.cjs 的前提已被自家决策文档推翻，产出数字也已漂移（1128 / 787 / 817 三个版本）

- **类型**：陈旧一次性脚本（口径 7/2） · 规模 **S**
- **证据**：
  - `scripts/inventory-tool-validate.cjs:3-8 —— 自述任务：「回答这 1128 行里，哪些是 schema 一句话就能表达的机械校验」，产出 docs/TOOL-VALIDATE-INVENTORY.md`
  - `docs/TOOL-VALIDATE-DECISION.md:11 —— 小节标题「先纠正一个前提（盘点结论有误）」；:23 说明盘点脚本把「schema 解析不到」记成了「schema 为空」`
  - `docs/TOOL-VALIDATE-DECISION.md:85 —— 记录当时 tool-validate.js 1128 → 787 行；实测当前 src/agent/tool-validate.js 为 817 行（[System.IO.File]::ReadAllLines 计数）—— 与 1128、787 都不一致`
  - `scripts/inventory-tool-validate.cjs 的分类口径（:10-18「机械 · required / enum / type / range；跨字段 · conditional；语义 · 必须人写」）与 scripts/lib/tool-validate-dualrun.cjs:31 起的差异分类是两份各自演进的口径`
  - `package.json:113 —— inventory:tool-validate；该脚本无任何自动调用点（不进 CI、不进 suite、只在 docs/TOOL-VALIDATE-INVENTORY.md 里被提及）`
- **为什么不整洁**：一次性盘点脚本的结论已被自己的决策文档判为「前提有误」，它产出的 md 里的行数也已过期三轮；继续留在 scripts/ 且挂着 npm script，只会让下一个人重新按错口径数一遍。
- **减法方案**：删 scripts/inventory-tool-validate.cjs、package.json:113 与 docs/TOOL-VALIDATE-INVENTORY.md；若要留取证，把它降级成 docs/archive/ 里的一份历史记录并注明「前提已被 TOOL-VALIDATE-DECISION §0 推翻」。分类口径只保留 dualrun 那一份。
- **验证**：grep 'inventory-tool-validate|TOOL-VALIDATE-INVENTORY' 仅剩 archive 说明；npm run generate:tool-validators 与 test:tool-args 不受影响。

#### scripts-tests-10 [P3] test-alive.cjs 自行声明 TICK = 300*1000，与 agent-limits 的 aliveTickIntervalMs 构成第二份数字

- **类型**：魔法数字（应进既有单一来源） · 规模 **S**
- **证据**：
  - `scripts/test-alive.cjs:40-42 —— 本地定义 HOUR / DAY / TICK，TICK = 300 * 1000`
  - `src/agent/agent-limits.js:480 —— aliveTickIntervalMs: 300000（生命感数字的唯一来源，:478 已声明「越界由 alive/runtime.js#resolveAliveConfig 夹取」）`
  - `scripts/test-alive.cjs:36 已经 require AGENT_LIMITS_DEFAULTS 并在 :96 等处用它取 alive* 数字 —— 说明改成读单一来源成本为零，只是这一处漏了`
  - `scripts/test-alive.cjs:149-174 —— 相位切换用例用 TICK 推进模拟时钟，若生产 tick 间隔改掉，测试仍按 5 分钟步长跑，口径会静默分叉`
- **为什么不整洁**：口径 4 的直接违反：测试在模拟生产节拍，却自己写死节拍值。
- **减法方案**：`const TICK = AGENT_LIMITS_DEFAULTS.aliveTickIntervalMs;`，HOUR/DAY 若 agent-limits 已有对应键也一并取。
- **验证**：改 agent-limits 的 aliveTickIntervalMs 后，test:alive 的模拟步长应跟着变（可用断言 TICK === AGENT_LIMITS_DEFAULTS.aliveTickIntervalMs 锁住）。

#### scripts-tests-11 [P3] CI 里 lint:agent / check:js / check:renderer 各跑两遍（独立 step + test:agent 的 suite）

- **类型**：重复执行 · 规模 **S**
- **证据**：
  - `.github/workflows/ci.yml:29 —— name: Agent lint (narrow) / run: npm run lint:agent`
  - `.github/workflows/ci.yml:33 —— JSDoc check (scoped) / npm run check:js`
  - `.github/workflows/ci.yml:35 —— Renderer static checks / npm run check:renderer`
  - `.github/workflows/ci.yml:37 —— Agent smoke / npm run test:agent → scripts/test-agent-smoke.cjs --all（:123-124 取 map.suites.agent）`
  - `docs/CODEMAP.json:2092-2094 —— suites.agent 里第一段就是 "lint:agent" / "check:js" / "check:renderer"，因此同一次 CI 任务里这三项各被执行两次`
- **为什么不整洁**：同一份闸门在同一个 job 里跑两次，既费 CI 分钟也让「哪一步是权威」变得含糊；且改动 suite 时容易误以为 CI 已经不跑。
- **减法方案**：删 ci.yml 里这三个 step（保留 :27 check:contracts / :31 verify:core-contracts，它们不在 suite 里），或在 suite 里拿掉这三项并把 step 顺序固定。推荐前者：一份清单（CODEMAP suites）决定跑什么。
- **验证**：对比改动前后 CI 日志里 eslint / tsc / python check 的出现次数各为 1。

#### scripts-tests-12 [P3] verify:bundled-skills 名字是校验，实际是会写盘的生成脚本（且没有 --check 分支）

- **类型**：命名与行为不符（生成物/手写混放） · 规模 **S**
- **证据**：
  - `package.json:12 —— "verify:bundled-skills": "node scripts/prepare-bundled-skills.mjs"`
  - `scripts/prepare-bundled-skills.mjs:2-4 —— 自述「构建前准备核心预装技能：裁剪非核心技能；缺失时尝试 vendor / curated 同步」`
  - `scripts/prepare-bundled-skills.mjs:79 —— fs.writeFileSync 落盘；全文件没有 process.argv / --check / --verify 分支（grep 无命中）`
  - `对照既有口径：package.json 里 generate:tool-validators 与 verify:tool-validators（:152，generate…--check）、generate:rpc-catalog 与 verify:rpc-catalog 都是「生成 + --check」成对`
- **为什么不整洁**：把会改仓库的脚本挂在 verify: 前缀下，等于给了「只读校验」的错误承诺；放进任何 CI/预检脚本都会让工作树变脏，而输出仍是一句成功。
- **减法方案**：二选一：改名 prepare:bundled-skills；或给它加 --check（只比对 CORE_REQUIRED 是否齐、内容是否一致，不写盘）并让 verify:bundled-skills 走 --check。写盘入口只留一个。
- **验证**：npm run verify:bundled-skills 后 git status --porcelain 应为空。

### 4.7 single-source（AGENTS.md「唯一来源」声明实测核对，横切）

**总评**：抽查 14 条「唯一来源」声明：11 条实测成立（llm-request 端点/头、tool-gate 关卡顺序、agent-round-text.resolveTurnDelivery、resolveFsTarget 判定本体、syncBrowserBounds 唯一写者、peer/boot 装配、alive 只读白名单、default-workspace-gc、sweepRunArtifacts、session-workspace-bind 已修、peer actions 两表）；3 条不成立——main-turn-runner「Main 侧跑一轮唯一」（计划走 plan-agent-runner，系统提示另拼）、getRemoteFs「远端 fs 唯一出口」（fs/lsp handler 自判传输）、agent-limits「数字唯一」（四处自写默认值，键已存在）。另有一条声明之外的重复：远端/本地分支前缀 dieyun/agent- 两份声明。

**审查口径与实读范围**：抽查声明 14 条 · 成立 11 · 违反 3 · 发现 8 条（P0×2 / P1×2 / P2×2 / P3×2）· 已读并遵守 REDUNDANCY-REVIEW-2026-11-03（含 C 节伪冗余）、NODE-THINNING-PLAN 负向清单、ARCHITECTURE-DEBT、MODULE-CHAOS-REVIEW、CODE-CLEANLINESS-REVIEW-2026-11-21

#### single-source-1 [P0] AGENTS.md:58「main-turn-runner 是 Main 侧跑一轮的唯一实现（频道/计划/headless 共用）」不成立：计划走第二套 runPlanAgentLoop，系统提示自己另拼一份 · **声明已改准 + 四个来源已共用（§8.6③）**

- **类型**：重复实现（同一轮语义两份，且已语义分叉） · 规模 **M**
- **证据**：
  - `AGENTS.md:58 —— 声明 src/agent/main-turn-runner.js 是「Main 侧跑一轮的唯一实现，频道/计划/headless 共用」`
  - `src/plans/runner.js:68 —— 计划运行实际走 return runPlanAgentLoop(ctx, plan)，完全不经过 runMainTurn`
  - `src/plans/plan-agent-runner.js:158 —— 系统提示在本文件手拼：const sysContent = await buildPlanSystemMessage(...)（定义在 :23-50：ASSISTANT_IDENTITY + 【定时计划 Agent】人格 + 计划名 + dieyun 块 + skills）`
  - `src/agent/main-turn-runner.js:249-257 —— 会话轮的系统提示走单一来源 buildPrepSystemPromptDeps(...).prepSystemPrompt(...)（该装配产出 AGENTS 项目规则 / 记忆召回 / 代码召回 / 共享记忆 / goal 事实块 / turnRide）`
  - `src/plans/plan-agent-runner.js:52-64 与 src/agent/main-turn-runner.js:261-268 —— 「memory.messages_recent(limit 120) → 过滤 user/assistant → 归一 created_at」同一段历史加载逻辑两份`
  - `src/plans/plan-agent-runner.js:66-73 与 src/agent/main-turn-runner.js:269-273 —— 消息装配的 helpers 也两份：计划侧手接 stripUserMeta/stripAssistantMeta，会话侧用 unpackMessageMeta`
  - `src/plans/plan-agent-runner.js:186 —— 下半截（runRustAgentLoop / turnEndSynthesis / 压缩）确实共用，只有提示词与历史装配是两份`
- **为什么不整洁**：不只是文件两份，而是**模型可见规则分叉**：计划轮拿不到 prepSystemPrompt 那一族块（项目 AGENTS.md 规则、记忆/代码召回、共享记忆、goal 事实、turnRide），于是同一个仓库里「用户当面问」与「定时计划里跑」看到的准则不同。AGENTS.md 表格要求 system prompt 只在 agent-system-prompt.js / system-prompt-prep.js 一份，这条正是被绕开的那一处。
- **减法方案**：让 runPlanAgentLoop 退化成「给 runMainTurn 传计划专属参数」的薄壳：人格段/计划名/trigger==='goal' 的 GOAL_TOOLS 用 runMainTurn 已有的 extraTools + snapshot 通路传进去，删 buildPlanSystemMessage / loadSessionMessages / buildPlanCompletionMessages（约 50 行）。计划与聊天从此共用同一份提示词装配。
- **验证**：npm run test:unit（plans-*.test.cjs）+ 一次 goal 型计划真跑：断言 plan 轮的 sysContent 含 prepSystemPrompt 既有块且【定时计划 Agent】人格段仍在；对比 runSource:plan 的请求快照前后 diff，确认没有意外丢块。
- **既有记录**：docs/CODE-CLEANLINESS-REVIEW-2026-11-21.md:136（§五 第 2 批第 5 条「main-turn-runner 与 plan-agent-runner 的骨架合并（或退一步：先修 AGENTS.md:58 的声明）」）—— 现在**仍成立**（plan-agent-runner.js 仍 309 行、runner.js:68 仍走它）；本条补上「系统提示为何不同」的证据与减法路径。

#### single-source-2 [P0] AGENTS.md:61/62「getRemoteFs 是远端 fs 唯一出口、handler 不许自己判 SFTP/RPC」不成立：fs.grep / fs.glob / lsp-workspace 各判一 · **已收口（2026-11-21，§8.6②）**遍

- **类型**：层级越界（Gateway handler 自己判「本机还是远端」/ 自选传输） · 规模 **M**
- **证据**：
  - `AGENTS.md:61 —— 声明 src/gateway/rpc.js:getRemoteFs() 是「唯一出口」，避免列明「在 handler 里自己判『用 SFTP 还是 RPC』」`
  - `AGENTS.md:62 —— 避免列明「在 handler 里各写一份 startsWith('local:') 或各判一次 getRemoteFs()」`
  - `src/gateway/rpc.js:1248-1274 —— 唯一出口本体：target.kind + getRemoteAgentInfo + isRemoteAgentUsable 在这里只判一次，返回 remote-agent-fs（transport rpc）或 remote-fs（transport sftp）`
  - `src/gateway/handlers/fs.js:821-822 —— fs.grep 自己再判一次：getRemoteAgentInfo() + isRemoteAgentUsable(agentInfo)`
  - `src/gateway/handlers/fs.js:826 —— 判完直接 getRemoteAgentClient(agentInfo).call('fs.grep', ...)，绕过适配器`
  - `src/gateway/handlers/fs.js:836-852 —— 又自己 target.remote.transport === 'sftp' 分支到 grepViaRemoteExec（= handler 自选传输）`
  - `src/gateway/handlers/fs.js:893-902 —— fs.glob 同形：先 getRemoteAgentInfo()/isRemoteAgentUsable，再 getRemoteFs() 取 remote.transport === 'sftp'`
  - `src/gateway/handlers/lsp-workspace.js:164-165 —— 同形的第三处（getRemoteAgentInfo + isRemoteAgentUsable 后直连 RPC）`
  - `src/gateway/remote-agent-fs.js:124 / src/gateway/remote-fs.js:158 —— 两个适配器都自带 transport 标识，说明「谁被选中」本已由 getRemoteFs 决定`
- **为什么不整洁**：「远端 Agent 可用吗 / 这一批文件走哪条传输」有两份判定：一份在 getRemoteFs，一份在三个 handler。handler 读到的 transport 又恰好是 getRemoteFs 选的，所以今天答案一致——但这正是 A8 记的形态：改 getRemoteFs 的口径（例如把 grep/glob 收进适配器接口）不会带动这三处，下一次漂移就是「同一操作两个答案」。
- **减法方案**：把 grep / glob 补进两个适配器接口（remote-agent-fs → fs.grep RPC；remote-fs → 现有 grepViaRemoteExec / globViaRemoteExec），handler 只留 if (target.remote) return target.remote.grep(...)；删 fs.js:821-853、fs.js:893-902、lsp-workspace.js:164 三段自判。适配器形状本来就是「同接口」的既定设计，不是新增机制。
- **验证**：npm run test:local-gateway-smoke + test:unit（grep-oversize-hint）；「有远端 Agent」与「只有 SFTP」两种 SSH 会话各跑一次 fs_grep / fs_glob，断言结果字段与今天一致且 index.notify_change 仍由 transport 决定。
- **既有记录**：docs/REDUNDANCY-REVIEW-2026-11-03.md:65（A8 第二行，当时写 handlers/fs.js:739-753，行号已漂到 821-853）标「未修」；docs/CODE-CLEANLINESS-REVIEW-2026-11-21.md:137（第 6 条「Gateway 侧『本机还是远端』的第二来源收回到唯一判定」）—— 现在**仍成立**。

#### single-source-3 [P1] 「数字只在 agent-limits.js」仍有四处自写默认值，而四处对应的既有键都已存在、装配点也已在传值

- **类型**：魔法数字该进既有单一来源（且是永不命中的副本） · 规模 **S**
- **证据**：
  - `src/plans/scheduler.js:27-28 —— this.idlePollMs = opts.idlePollMs > 0 ? opts.idlePollMs : 60 * 1000；this.idleQuietMs = ... : 5 * 60 * 1000`
  - `src/agent/agent-limits.js:45-46 —— 同一语义的正本 plansIdlePollMs: 60 * 1000、plansIdleQuietMs: 5 * 60 * 1000`
  - `src/main/mcp-plans-boot.js:288-289 —— 唯一生产装配已经传 idlePollMs / idleQuietMs（于是 scheduler 那两行永不命中）`
  - `src/agent/rust-loop-runner.js:330-332 —— createRunStallWatchdog 的缺省 warnMs 5 * 60 * 1000、abortMs Math.max(warnMs, 45 * 60 * 1000)`
  - `src/agent/agent-limits.js:139-140 —— 正本 runStallWarnMs / runStallAbortMs 同值；唯一调用点 src/agent/rust-loop-runner.js:453-455 已经传 stallLimits.runStallWarnMs / runStallAbortMs`
  - `src/agent/knowledge-maintainer.js:1406 —— Number(ctx.limits().knowledgePlanApplyWaitMs) || 20 * 60 * 1000`
  - `src/agent/knowledge-maintainer.js:1493 —— Number(ctx.limits().knowledgeIdleRetryMs) || 5 * 60 * 1000`
  - `src/agent/agent-limits.js:443 / :445 —— 正本 knowledgePlanApplyWaitMs: 20 * 60 * 1000、knowledgeIdleRetryMs: 5 * 60 * 1000`
  - `src/agent/session-context.js:551-552 —— 同文件里仍有 maxTurns : 8、maxChars : 14000 两个字面量闭包，而 :646-648 注释自陈「这里不再各写一份字面量」`
- **为什么不整洁**：四处都是「键已存在 + 装配点已传值 + 再抄一份同值」的兜底。它们今天不生效，但一旦 limits 键被删/改名，静默回到旧值——正是 REDUNDANCY 结论 4 说的「实证违规」，也是 AGENTS.md 原则 2 明令禁止的兜底层形态。
- **减法方案**：照同仓正例 src/agent/mutate-queue.js:37-44 的 resolveStallMs（取不到即抛）改：scheduler 两行、watchdog 两个缺省、knowledge-maintainer 两处 || 全部改成「缺键抛错」或删缺省让唯一调用点必传；session-context:551-552 同样收进 agent-limits 或改抛。
- **验证**：npm run test:agent-limits + test:unit（plans-idle-queue 显式传 idlePollMs:10，不受影响）+ test:rust-loop-runner（注意 test/unit/run-stall-watchdog.test.cjs:82 那条无参构造会变成抛错，需改成显式传值）。
- **既有记录**：docs/REDUNDANCY-REVIEW-2026-11-03.md:126（§B 第 2 条，当时写 plans/scheduler.js:27-28、rust-loop-runner.js:601,603、knowledge-maintainer.js:1264）—— 数字一处都没改，只是行号漂移（watchdog 现 330-332、knowledge 现 1406/1493），现在**仍成立**。

#### single-source-4 [P1] `dieyun/agent-` 分支前缀有两份声明，其中一份在同一行注释里自称「唯一来源」

- **类型**：魔法字符串（本地/远端必须同口径，却各写一次） · 规模 **S**
- **证据**：
  - `src/git/worktree-service.js:31-36 —— 注释「Agent worktree 分支命名空间。唯一来源：创建分支、判断归属、回收分支都引用它」+ const AGENT_BRANCH_PREFIX = 'dieyun/agent-';`
  - `src/ssh/remote-worktree.js:23 —— 同值再声明一次 const BRANCH_PREFIX = 'dieyun/agent-'（:58 用它拼远端分支名）`
  - `src/ssh/remote-worktree.js:233 —— 再以 AGENT_BRANCH_PREFIX: BRANCH_PREFIX 导出，src/ssh/remote-run-worktree.js:24 从这里取`
  - `src/workspace/target.js:152 —— 路径/目录形状已声明为「本地 / 远端共用」规则所在地；src/remote/remote-pack-layout.js:29 已把该文件打进远端包（= 现成的共享落点）`
  - `src/git/worktree-service.js:33-34 —— 注释记录的历史事故正是「创建用一处字面量、回收用另一处 → 回收静默匹配 0 个分支」`
- **为什么不整洁**：本地 worktree 与远端 worktree 必须同一前缀（远端收尾 commit/merge 回会话副本全靠它）。现在口径两处书写，而 worktree-service 的注释把「唯一来源」写在了只有本地那一半的文件里——下次改前缀，远端那一份不会跟着动，重现的是同一条静默失效。
- **减法方案**：把 AGENT_BRANCH_PREFIX 提到 src/workspace/target.js（远端包已含、且本来就是「本地/远端共用形状」的家），worktree-service 与 ssh/remote-worktree 都从那里 require，删 ssh 侧的 BRANCH_PREFIX 与 re-export。
- **验证**：npm run test:worktree + npm run test:remote-pack；grep 全仓后 dieyun/agent- 字面量只剩一处定义。
- **既有记录**：无（REDUNDANCY-REVIEW §C 把 path/target 一类列为「已是单一来源」——这里是那个结论的漏网项）

#### single-source-5 [P2] 三档档位名与中文标签在 Renderer 里另有一份字面量，SANDBOX_MODES / SANDBOX_MODE_META 没有镜像通道，label 已经两版字

- **类型**：魔法字符串该进既有单一来源 + 层级越界（Renderer 自留护栏常量） · 规模 **S**
- **证据**：
  - `src/gateway/sandbox-policy.js:31 —— SANDBOX_MODES = ['read-only','workspace-write','danger-full-access']；:34 —— DEFAULT_SANDBOX_MODE = 'workspace-write'；:36-61 —— SANDBOX_MODE_META 带中文 label`
  - `src/renderer/renderer-permissions.js:417 —— let lastNonDangerMode = 'workspace-write'`
  - `src/renderer/renderer-permissions.js:421 —— 自己列一遍档位集合 if (v === 'read-only' || v === 'workspace-write')（= SANDBOX_MODES 去掉 danger，手抄）`
  - `src/renderer/renderer-permissions.js:427 —— 再写一次缺省 const value = dangerToggle === true ? 'danger-full-access' : mode || 'workspace-write'`
  - `src/renderer/renderer-sandbox-approval.js:22-26 —— 另抄一份 label 表：'工作区内可写'，而 sandbox-policy.js:47 的是 '工作区内可写（默认）'（已经不同字）`
  - `src/agent/tool-gate.js:364 与 :402 —— 心跳轮把档位名当字面参数写死 mode: 'workspace-write'（刻意收窄，但没有具名常量说明这是收窄而非用户档位）`
  - `src/gateway/permissions-store.js:43 是正例：sandboxMode 直接取 DEFAULT_SANDBOX_MODE、归一走 normalizeSandboxMode（同进程可达，所以没有副本）`
- **为什么不整洁**：档位名是跨 Renderer / Gateway / tool-gate 三层的判定输入，而 Renderer 侧没有既有镜像通道可用（sandbox-policy 未进 agent-bundle），只能手抄；label 已经出现两种写法。AGENT-STRATEGY.md:69 明写「Renderer 不再留任何判定/常量」。
- **减法方案**：照既有通道（agent-bundle 的 window.Dieyun*，REDUNDANCY 结论 2 已确认这是既定做法）把 SANDBOX_MODES / DEFAULT_SANDBOX_MODE / SANDBOX_MODE_META.label 镜像给 Renderer，两处改引用；tool-gate 的 'workspace-write' 换成具名常量并加一行「刻意收窄，不跟用户档位」。
- **验证**：npm run check:renderer（window 导出声明）+ npm run test:renderer；设置页三档点选、危险档来回切、越界审批卡文案各看一次。
- **既有记录**：部分：docs/REDUNDANCY-REVIEW-2026-11-03.md 结论 2 只确认了「agent-bundle 通道存在」，没有点名档位名；docs/SANDBOX.md 未列此项。

#### single-source-6 [P2] resolveFsTarget 链上的 getRemoteAgentInfo 吞掉异常返回 null：远端目标会静默退化成「没有远端 Agent」

- **类型**：错误被吞掉（catch 后 return null 无痕迹） · 规模 **S**
- **证据**：
  - `src/gateway/rpc.js:946-955 —— function getRemoteAgentInfo() { ... try { return ctx.getRemoteAgentInfo(callSid) } catch { return null; } }，无日志、无 errorCode`
  - `src/gateway/rpc.js:1288 —— resolveFsTarget 的唯一输入里就含 getRemoteFs()，而 getRemoteFs 在 :1270-1271 吃这个 null 决定走 RPC 还是 SFTP`
  - `src/gateway/handlers/fs.js:821-822 —— 同一个 null 也会让 fs.grep 直接掉到本机分支`
  - `AGENTS.md:62 —— 明令避免项「按路径形状猜『这大概是本机』（SSH 到 Windows 时会静默读写错机器）」是同一形态`
- **为什么不整洁**：这个返回值决定「这批文件操作去哪台机器」。抛错被折成 null 之后，一次真实故障的表现是「本机找不到这个文件」，与「远端会话写错机器」的失败形态无法区分；空 catch 也违反仓里「不吞错误」的既定口径（tool-gate.js:27 同款表述）。
- **减法方案**：不吞：记一次 warn（带 callSid）后原样上抛，或返回结构化 {ok:false, code:'REMOTE_AGENT_INFO_FAILED'} 由调用方明说；不加任何重试/兜底。
- **验证**：注入一个会抛的 ctx.getRemoteAgentInfo 跑 test:local-gateway-smoke，断言 fs_write_file / fs_read_file 报错而不是静默写本机。
- **既有记录**：无

#### single-source-7 [P3] trace 相位名「汇总」在 Rust 与 Node 各写一遍字面量，没有 agent-shared.json 键，而 Node 的交付四态正靠这个字符串匹配

- **类型**：魔法字符串（Node 与 Rust 两侧都要用的常量未收进 agent-shared） · 规模 **S**
- **证据**：
  - `src/agent/agent-round-text.js:75 —— const SYNTHESIS_PHASE = '汇总'；:101 —— NON_MODEL_PHASES = new Set([SYNTHESIS_PHASE, '完成验收'])`
  - `src/agent/agent-round-text.js:129 —— 按 NON_MODEL_PHASES.has(phase) 跳过相位（决定哪些 trace 段不算模型思考/正文）`
  - `crates/dieyun-runtime/src/planner/run.rs:471 —— push_trace(run, "汇总", "验收通过，正在生成最终答复…")；:482 / :489 / :499 / :574 四处同样以 "汇总" 作相位名`
  - `crates/dieyun-runtime/src/planner/trace.rs:197 —— obj.insert("tracePhase".into(), json!("汇总"))`
  - `src/agent/agent-shared.json —— 已有 llmErrors.transportCode / contextOverflowPatterns 这类跨语言键的先例，唯独相位名没有`
  - `src/renderer/renderer-thinking-trace.js:589-592 —— Renderer 也从 AgentRoundText.SYNTHESIS_PHASE 取（Node 侧已单一来源，缺的只是 Rust 那一侧）`
- **为什么不整洁**：相位名是「这条 trace 是不是模型轮」的判定输入：Rust 发射、Node 匹配、Renderer 展示三方共用同一串中文。任一侧改名都不会有编译/测试失败，只会让汇总轮被当成真思考或真正文——静默改变交付语义（AGENTS.md 原则 5 的核心）。
- **减法方案**：在 src/agent/agent-shared.json 增 phases.synthesis（Node 经 shared-constants.js、Rust 经 shared.rs 读同一份；npm run check:shared-constants 会验两侧都有读点），Rust 的 push_trace 与 Node 的 SYNTHESIS_PHASE 都改读常量。
- **验证**：npm run check:shared-constants + npm run test:rust-planner-smoke + test:agent-round-text（都已有）。
- **既有记录**：无

#### single-source-8 [P3] tool-gate.js:23 注释里的行号引用已经漂了 1100 行（引 tool-bridge-main.js:1944，实际 820）

- **类型**：陈旧注释 / 注释复述代码位置 · 规模 **S**
- **证据**：
  - `src/agent/tool-gate.js:23 —— 注释写「它由调用方作为 after 关卡传入（tool-bridge-main.js:1944 的 sanitize-result）」`
  - `src/agent/tool-bridge-main.js:820 —— sanitize-result 关卡实际在这里（该文件全文 858 行，1944 行不存在）`
  - `src/agent/tool-bridge-main.js:153 —— sanitizeToolResultForApi 本体在这里`
- **为什么不整洁**：这类行号引用没有任何机械校验，审计时会被当成真实现位置去找（MODULE-CHAOS-REVIEW §八 item 4 曾因同类假注释修过一轮：当时的错误是「sanitize 在 guardrails-shared」）。位置类断言应写函数名/关卡 id，不写行号。
- **减法方案**：把该行改成「调用方以 after 关卡传入（tool-bridge-main.js 的 sanitize-result 关卡，必须晚于 record-browser-screenshot）」，去掉行号。
- **验证**：grep sanitize-result 两处一致即可，无需测试。
- **既有记录**：docs/MODULE-CHAOS-REVIEW.md:54/§八 item 4 修过同一条注释的**归属**，但行号仍是错的——现在**仍成立**（只是残留更小）。

### 4.8 当前未提交改动 + 未跟踪新增文件（diff / new files）

**总评**：中上。新增模块的单一来源意识明显好于仓库平均水平（trace-graph 纯函数只有一份、skills/enabled-store 是唯一权威、wecom-media 把 AES 解密与判型收在一处、判定卡的 phase 名共享常量、MCP 传输键改成从 mcp/manage.js 派生）。但同一批改动里仍长出四类旧病：①远端 per-run worktree 的「归档 → 删目录（留分支）」循环在 Main 桥与新 ssh 模块各写一遍；②「侧模型判定卡」的结构在 Renderer 与 Main 各拼一份，只有 phase 名共享；③护栏数字又回到模块内局部常量（planner-router 四个 + fan_out 的 12），而同一批的 plannerRunWorktreeKeep 却正确进了 agent-limits；④Renderer 又长出第三套滚动跟随状态机与三处「bundle 缺失就降级」的兜底（REDUNDANCY A8 已判掉）。未发现 P0：dist 产物已同步（bundle.js / agent-bundle.js 都含新符号），plannerRouter* 虽未进 model-settings DEFAULTS 但因 normalize 保留未知键而未致丢失。

**审查口径与实读范围**：git status: 166 个已跟踪文件改动（+7918 / -2250）、30 个未跟踪新增（8 个源码 + 17 个单测 + 3 份 archive 文档 + build/audit/）；行数用 [System.IO.File]::ReadAllLines().Count 实测：planner-router 243、trace-graph 247、wecom-media 124、renderer-trace-graph 583、enabled-store 91、remote-run-worktree 528、agent-mode 55、examples/trace-graph-preview.html 189、planner-main-bridge 369（原约 160）、renderer-thinking-trace-dom 1417。已读并对照四份既有结论：REDUNDANCY-REVIEW-2026-11-03（含 C 节伪冗余）、NODE-THINNING-PLAN（§6 负向清单）、ARCHITECTURE-DEBT、MODULE-CHAOS-REVIEW。本域无 8 行滑窗自动命中，全部为人工核对。

#### diff-1 [P1] 远端 per-run 副本「归档每个 role 再删目录（必须留分支）」的循环写了两份

- **类型**：重复实现 · 规模 **S**
- **证据**：
  - `src/agent/planner-main-bridge.js:199 —— worktreeCleanupRun 的远端分支：:203 listRunWorktreeRoles → :211 archiveRunWorktree → :219 removeRunWorktree({deleteBranch:false})（:224），逐 role 收集 ok/error 后在 :228 汇总`
  - `src/ssh/remote-run-worktree.js:410 —— pruneRunWorktreeRoots 对每个过期 run 跑同一串：:411 listRunWorktreeRoles → :415 archiveRunWorktree → :424 removeRunWorktree({deleteBranch:false})（:428）→ :432-439 空目录 rmdir`
  - `两份只差归档 message 文案与「roles 为空」分支的写法；失败处置（archived.ok / archived.missing → 保留副本、okRun 记账）逐条同义`
- **为什么不整洁**：「停止 / 回收时先把未提交改动提交进该 role 分支，再删 checkout，分支必须留」是同一语义，现在有两处实现。任一处改口径（比如将来把 archive 换成 merge、或给 deleteBranch 加例外、或改失败处置）另一处不会跟着改；这次改动本身就是同时引入这两份。
- **减法方案**：在 remote-run-worktree.js 里抽 archiveAndDropRunRoles(sshManager, {repoPath, runId, message})（内部 listRunWorktreeRoles → archiveRunWorktree → removeRunWorktree({deleteBranch:false}) → 空目录 rmdir），worktreeCleanupRun 与 pruneRunWorktreeRoots 各留一行调用，bridge 只传 runId。
- **验证**：npx vitest run test/unit/remote-run-worktree.test.cjs test/unit/planner-main-bridge.test.cjs；手工：SSH 会话跑一次 planner 后中途「停止」，确认 dieyun/agent-<run>-<role> 分支仍在、副本目录已删、再续跑能复用 runId。

#### diff-2 [P1] 「侧模型判定卡」的结构在 Renderer 与 Main 各拼一份，只有 phase 名是共享的

- **类型**：重复实现 / 层级越界 · 规模 **S**
- **证据**：
  - `src/renderer/renderer-agent-send.js:445 —— buildPlannerJudgeTraceEntry 组装 {round:0, phase, thought, fullThought, tools:[]}，:454 自己拼 '【判定模型思考】' 包装，:455 另塞一个 planJudge:true`
  - `src/agent/rust-planner-runner.js:488 —— routeNoteEntry 组装同一张卡，:495 同样拼 '【判定模型思考】'，但 thought 兜底文案是另一句（'侧模型判定：拆成多路并行走 planner' vs Renderer 的 '不拆，按普通工具循环跑'）`
  - `src/agent/agent-round-text.js:86 —— 只有 PLANNER_ROUTE_PHASE 一个常量被共享（:93 另造 PLANNER_HANDOFF_PHASE）；卡片结构本身没有单一来源`
  - `全仓搜 planJudge 只命中写点 renderer-agent-send.js:455 与 dist 产物（src/renderer/dist/bundle.js:55738），无读者`
- **为什么不整洁**：「这一轮拆不拆」是同一张卡的两半，现在两半各写一次结构 + 各写一套兜底文案；AGENTS 原则 5 把 trace 整形定在 Main、Renderer 只展示，这里却是 Renderer 往 run.result.trace 里插节点（正是 MODULE-CHAOS-REVIEW §4.1(1)「Renderer 是 Agent 账本写者之一」的同一形态，只是这次新加了一个入口）。
- **减法方案**：agent-round-text.js 出 buildPlannerRouteCard({verdict:'use'|'skip'|'handoff', reason, thinking}) 纯函数（现在已有 PLANNER_ROUTE_PHASE / PLANNER_HANDOFF_PHASE 两常量可复用），Renderer 与 planner 都调它；删两处内联对象与 planJudge 标记。
- **验证**：npx vitest run test/unit/fan-out-handoff.test.cjs；node scripts/test-rust-planner-smoke.cjs（已断言「拆」与「中途改道」两种 phase 同形）。

#### diff-3 [P1] 新增模块把护栏数字写成模块内常量，绕开 agent-limits 单一来源

- **类型**：魔法数字 · 规模 **S**
- **证据**：
  - `src/agent/planner-router.js:26 ROUTER_TIMEOUT_MS=20000、:28 ROUTER_MAX_OUTPUT_TOKENS=256、:30 ROUTER_USER_TEXT_MAX_CHARS=2000、:108 ROUTER_THINKING_MAX_CHARS=1200，四个都留在模块内且全部经 module.exports（:234-236）对外`
  - `src/agent/main-tools/agent-mode.js:18 FAN_OUT_MAX_SUBTASKS=12 —— 这是「subtasks 最多留几条」的唯一约束：src/agent/catalog/session.js:155 的 subtasks 数组没有 maxItems`
  - `src/agent/agent-limits.js:318 plannerRunWorktreeKeep: 20 —— 同一批改动里这个数就正确进了 agent-limits（注释还写「机制预算，故意不进 SCHEMA」），说明这批改动同时存在两种口径`
- **为什么不整洁**：AGENTS 原则 6 与 agent-limits 既有惯例都表明这类数属于同一处：同类「一次小请求的时长 / 条数上限」已经在那里（synthesisTimeoutMs:155、sessionTitleTimeoutMs:160、readinessRpcTimeoutMs:35、peerSendTimeoutMs:81）。留在模块里意味着用户改不了、别的模块要用只能再抄一遍，下一个并行实现必然再写一个 20000。
- **减法方案**：搬成 plannerRouterTimeoutMs / plannerRouterMaxOutputTokens / plannerRouterUserTextMaxChars / plannerRouterThinkingMaxChars / fanOutMaxSubtasks；删模块内常量及其导出（同时解决下方的死导出）；给 subtasks 补 maxItems，让 schema 生成器带进 tool-validate.generated.js。
- **验证**：npm run test:agent-limits；npm run generate:tool-validators + npm run verify:tool-validators；npx vitest run test/unit/planner-router.test.cjs test/unit/fan-out-handoff.test.cjs。

#### diff-4 [P2] Renderer 又长出三处「bundle / 桥缺失就降级」的兜底（REDUNDANCY A8 已判掉）

- **类型**：降级层 / 兜底层 · 规模 **S**
- **证据**：
  - `src/renderer/renderer-agent-send.js:446-449 —— AgentRoundText 不在就把 phase 写成字面量 '调度 · 侧模型判定'（与 agent-round-text.js:86 各一份）`
  - `src/renderer/renderer-agent-send.js:464-468 —— readFanOutHandoff：没有 AgentRoundText.findFanOutRequest 就 return null（:462 注释自陈「这里只做 bundle 兼容」）`
  - `src/renderer/renderer-agent-send.js:768-771 —— agentApi.agentPlannerRoute 不存在就编一条 {use:false, reason:'当前入口没有路由判定（旧版桥），按不拆处理'}`
- **为什么不整洁**：三处都只在「生成物过期」时生效，而那时正确行为是立刻失败（重建 bundle），不是让功能静默消失。768-771 尤其糟：判定被跳过时用户只看到「不拆」，与「判定失败 / 超时」在界面上不可区分。
- **减法方案**：三处改成直接调用并在符号缺失时抛（与 renderer-model-settings / renderer-agent-llm 现在的写法一致，缺失即暴露），删掉字面量 phase 兜底。
- **验证**：npm run check:renderer；npm run build:renderer:dev 后手工发一条消息，确认思考区仍出现判定卡 + 不拆时也能看到理由。
- **既有记录**：REDUNDANCY-REVIEW-2026-11-03.md:69（A8「删 Renderer 内联兜底（bundle 缺失即抛）」与该文 P0 执行记录第 7 条：renderer-agent-llm.js 的三条端点规则 + Content-Type/Bearer 兜底已删）。结论现在仍成立、且本次改动把同一形态加了回来；dist/agent-bundle.js 随仓库提交，缺符号只可能是没重建。

#### diff-5 [P2] 子 Agent 卡片的滚动跟随即长出第三套状态机（与 chat-scroll 的单一来源重复）

- **类型**：重复实现 / 层级 · 规模 **M**
- **证据**：
  - `src/renderer/renderer-thinking-trace-dom.js:1091-1133 —— bindIsolatedCardFollowIntent 自己绑定 wheel / touchmove / pointerdown(滚动条) / keydown 四类「用户接管」事件，意图位是 DOM dataset data-cardFollowYield（:1095、:1128-1130）`
  - `src/renderer/renderer-chat-scroll.js:451-494 —— 既有唯一来源 markChatUserScrollIntent 绑定的是同一批事件，意图位是 chatUserScrollSeq（:20）`
  - `src/renderer/renderer-thinking-trace-dom.js:1073-1074 —— 24px 贴底判据第三份；:1151-1194 —— 阻尼逼近公式与 renderer-chat-render.js:85 同一式（都用 SCROLL_DAMP_TAU_MS）`
- **为什么不整洁**：三份「贴底 + 用户一滚就让位 + 阻尼」各自判「用户是不是接管了」：任何一次手感调整（阈值、让位策略、阻尼时间常数）都要改三处；两套意图位（dataset vs chatUserScrollSeq）意味着朗读跟随 / 聊天跟随看不到卡片内的滚动。
- **减法方案**：把「跟随容器贴底」抽成一个函数（接收容器 + 既有滚动意图源），聊天区与卡片正文共用；删 data-card-follow-yield，统一读 chatUserScrollSeq（它已经是用户滚动的唯一来源）。
- **验证**：npm run test:renderer（注意 check:renderer 不测行为）+ 手工六条：流式跟随 / 上翻不拽回 / 滚回贴底恢复跟随 / 子 Agent 多轮卡片 / 朗读跟随 / 切会话。
- **既有记录**：docs/MODULE-CHAOS-REVIEW.md:109 已记「滚动贴底/跟随 2 套独立状态机 / 25 处」（chat-scroll vs chat-render），:136 规则 2「会话/运行态只许一个写者」。两条结论现在仍成立，且本次改动没有合流既有两套、而是加了第三套 —— 该文「两套合流到 renderer-chat-scroll.js」的减法因此更贵了。

#### diff-6 [P2] plannerRouter* 三个配置键没进 model-settings 的 DEFAULTS/normalize，同族的 reviewer* 进了

- **类型**：单一来源 / 漂移面 · 规模 **S**
- **证据**：
  - `src/model-settings.js:52-56 —— reviewerEnabled / reviewerModel / reviewerBaseUrl / reviewerApiKey 在 DEFAULTS 显式列出，:286-289 在 normalize() 逐键 trim / 严格布尔（注释「只用显式值」）`
  - `src/model-settings.js:28-72 —— DEFAULTS 全表没有 plannerRouterModel / plannerRouterBaseUrl / plannerRouterApiKey；它们能落盘只是因为 normalize 第一行 '{ ...DEFAULTS, ...raw }' 保留了未知键`
  - `src/renderer/renderer-encoding-params.js:317-321 —— Renderer 另建字段表 PLANNER_ROUTER_FIELDS，:349 直接 saveSettings(settings) 写全局 settings`
  - `src/renderer/renderer-encoding-params.js:382 —— '.catch(() => {})'：从 Main 取存档失败时完全无声，界面就是三个空框`
- **为什么不整洁**：「有哪些侧模型配置键、怎么归一」现在有两套口径：显式契约（reviewer*）与靠 spread 兜住（plannerRouter*）。后者不会 trim/clamp（apiKey 带空格不会被裁），任何一天有人给 normalize 加白名单或收紧保留未知键的行为，判定模型配置就静默丢失，而用户只会觉得「填了没生效」。
- **减法方案**：三个键进 DEFAULTS + normalize（与 reviewer* 同样式），Renderer 只留标签与提示；:382 的空 catch 改成报错或至少一行 console.warn。
- **验证**：npx vitest run test/unit/model-settings*.test.cjs；手工：设置页填判定模型 → 保存 → 重启仍在；手改 model-settings.json 给 apiKey 加空格 → 保存后应被 trim。
- **既有记录**：docs/MODULE-CHAOS-REVIEW.md:402 记过同一件事的上一轮处理：reviewer* 四键「normalize 本来就保留未知键，现在把它们变成显式契约」。本次新增的 plannerRouter* 三键又回到依赖未知键透传的状态。

#### diff-7 [P2] 「正文里有没有残留工具调用标记」的判据两份，形态集合已经不一样

- **类型**：重复实现（已漂移） · 规模 **M**
- **证据**：
  - `src/agent/agent-round-text.js:20-27 —— TOOL_CALL_MARKUP_RE 是宽判据：'</?(tool_calls?|invoke|function_call)'、'function='、'<| |DSML| | invoke'、'|DSML|'，以及 antml / parameter 形态（:16-19 注释说明这是为修 2026-11-19 泄漏事故新放宽的）`
  - `src/llm-tool-call-fallback.js:22-31 —— 同一件事的形态集合另有 TOOL_CALL_OPEN_RE / TOOL_CALL_CLOSE_RE / DSML_BARS / DSML_TAG_PREFIX 四条正则；hasToolCallMarkupHint（:412）只认 <tool_call> / <tool_calls> / <invoke name=" / <function= / <parameter name="`
  - `src/agent/live-loop-trace.js:177 —— 思考区展示走 fallback 侧 stripToolCallMarkup，不认识新宽判据里的 antml / parameter 形态，这类泄漏会原样进 trace`
- **为什么不整洁**：两处共同决定「这段是不是泄漏正文」，但形态表各写一份且已分叉：宽判据本次多认 3~4 种形态，剥除/提取侧不认。下次再加形态只改一边，就回到「判出泄漏但不剥除」或「剥掉了却判没泄漏」两种半真半假的状态。
- **减法方案**：把「什么算工具调用标记」的形态表提成一处（零依赖模块或 agent-round-text 导出，fallback require 它），normalizeToolCallMarkup 的替换表与 hasToolCallMarkupHint 从同一张表派生；「抽取工具调用」与「判是否泄漏」两个语义仍分开，别合并。
- **验证**：node scripts/test-llm-tool-call-fallback.cjs + npx vitest run test/unit/agent-round-text*.test.cjs；补一条夹具：`<antml:invoke name="fs_read_file">` 经 stripToolCallMarkup 后应为空串。

#### diff-8 [P2] planner-main-bridge 变成「本地 + 远端编排」混合体，且两处 catch 后 return null 无痕迹

- **类型**：职责混杂 / 错误被吞 · 规模 **M**
- **证据**：
  - `src/agent/planner-main-bridge.js 实测 369 行（改动前约 160）：coordinator 桥（:64-143）+ 6 个 worktree 方法的本地/远端分派（:149-330）+ 远端 prune/finalize 编排（:247-313）三类职责同居`
  - `src/agent/planner-main-bridge.js:31-36 —— remoteTarget() 里 'catch { return null }'：解析远端目标失败即静默按本机跑（SSH 会话会去建本机 worktree）`
  - `src/agent/planner-main-bridge.js:46-61 —— sweepRunResidue 里 try/catch 与 '.catch(() => null)' 两重静默；:66 'void sweepRunResidue(meta)' 连 promise 都不留`
- **为什么不整洁**：这条链路的失败模式全是「悄悄换成另一条路」，而两条路在用户侧看起来一样 —— 出问题时没有一行日志可对照。回收那条尤其讽刺：它存在的理由就是「残留没人收」（注释引 19 份 worktree / 171 条分支），失败静默等于回到事故现场。
- **减法方案**：远端编排搬回 src/ssh/remote-run-worktree.js（它已经是这段语义的家），bridge 只留「有 remote → 调 X，否则调 worktreeService」的一行分派；三处 catch 至少留一行带原因的日志，或把 error 放进返回值让 runStart 侧能看见。
- **验证**：npx vitest run test/unit/planner-main-bridge.test.cjs；手工：断开 SSH 后跑 planner，日志里应能看出「远端不可用 → 走本机」。

#### diff-9 [P3] 新增文件里的死导出与纯透传包装（4 处）

- **类型**：死代码 · 规模 **S**
- **证据**：
  - `src/agent/main-tools/agent-mode.js:18 + :55 —— FAN_OUT_MAX_SUBTASKS 被导出，全仓无外部读点（只有本文件 :41 自用）`
  - `src/ssh/remote-run-worktree.js:25 + :527 —— repoRemotePathOf 从 remote-worktree 转手再导出一遍；真实调用点都走 require('../ssh/remote-worktree').repoRemotePathOf（gateway/server.js:60、session-worktree.js:9、worktree/actions.js:5 等），没有一处从这个入口取`
  - `src/channels/wecom-media.js:110-118 —— sniffImageMime 是 sniffImageMimeFromBytes 的同签名空壳（注释自陈「这里只保留一个同签名包装」），唯一调用点 agent-turn.js:184 可直接 require guardrails-shared`
  - `src/skills/enabled-store.js:25 + :82 —— version: 1 只写不读（readEnabledMap 不看 version，也没有迁移分支）`
- **为什么不整洁**：导出面越大，「这个符号还有没有用」的判断成本越高；NODE-THINNING-PLAN N4.1 那条「零调用点导出」闸门正是为这类残渣准备的，但它目前只覆盖 Renderer，Main/ssh/channels 侧的残渣没人扫。
- **减法方案**：删 FAN_OUT_MAX_SUBTASKS 的导出（数字搬进 agent-limits，见上方那条）、删 repoRemotePathOf 的转手导出、删 sniffImageMime 包装（agent-turn.js:184 改为 require ../agent/guardrails-shared 的 sniffImageMimeFromBytes）、enabled-store 要么读 version 做迁移要么不写。
- **验证**：npm run check:js；npx vitest run test/unit/wecom-media.test.cjs test/unit/remote-run-worktree.test.cjs test/unit/fan-out-handoff.test.cjs test/unit/skills-enabled-store.test.cjs。

#### diff-10 [P3] 同一张子 Agent 卡片的状态文案两份，且已经不一样（轮数只在面板侧出现）

- **类型**：重复实现（已漂移） · 规模 **S**
- **证据**：
  - `src/renderer/renderer-subagent-panel.js:148-161 —— subagentCardStatusLabel 输出「已完成 · N 轮 · N 步」`
  - `src/renderer/renderer-thinking-trace-dom.js:462-465 —— thinkingRoundSummaryParts 对同一张卡输出「已完成 · N 步」（本次改动还把思考预览从标题里摘掉了）`
- **为什么不整洁**：两处描述同一个对象的同一状态；这次只更新了思考区那份（摘掉 preview），面板那份没跟，于是同一屏里同一张卡片有两种说法（一个带轮数、一个不带）。
- **减法方案**：状态文案收进一个函数（或经 agent-bundle 共享），两处都调；确需区分（面板知道整轮状态）就把差异做成参数，而不是两份实现。
- **验证**：npm run test:renderer；手工跑一次带子 Agent 的运行，对比侧栏卡片标题与思考区标题文案。

---

## 五、建议的执行顺序（每步可独立提交，先减法后结构）

### 5.0 六个 P0 是止血点（先看这六条，别先重构）

| # | 域 | 一句话 | 规模 |
|---|---|---|---|
| 1 | `scripts-tests` | `scripts/test-composer-queue-edit.cjs` 把生产逻辑抄进脚本再断言副本 —— 这个测试永远绿，且副本已漂移（该文件只 `require('assert')`） | S |
| 2 | `main-gateway` | 「本机 vs 远端」判定有四种写法，其中 5 处 handler 取的是**视图**工作空间而不是本次调用作用域（`fs.js:371` + `lsp-workspace.js:160/309/501/638`） | S |
| 3 | `renderer` | 录音→转写两份实现，手机端没拿到「取消永不置灰」这条修复 → 转写卡住时没有出口 | M |
| 4 | `renderer` | `tool_call` 标签剥离两份逐字相同，且与 Main 唯一实现漂移（缺 `<calls>` 归一）→ 工具标记漏进气泡 | S |
| 5 | `single-source` | `AGENTS.md:58`「main-turn-runner 是跑一轮的唯一实现」不成立（计划走第二套骨架） | M |
| 6 | `single-source` | `AGENTS.md:61/62`「getRemoteFs 是远端 fs 唯一出口」不成立（`fs.grep` / `fs.glob` / `lsp-workspace` 各判一遍） | S |

> 第 1、2、4、6 条的修法都是「删掉一份 / 改调既有唯一来源」，不涉及设计决策。第 5 条要么合并骨架、要么改声明 —— **改声明是允许的**（成本 1 行），前提是承认两份编排长期并存。
> ✅ `renderer-5`（模型设置归一化两份，存一次设置就静默丢 `headers` / `authMode` / `userAgent`）**已在本轮合流**，见 §8.4。

### 5.1 分批建议

**第 0 批 · 零风险删除（半天，纯减行，先做）—— ✅ 已于 2026-11-21 执行，明细见 §八**
1. 删 3.2 的 20 处零调用点声明（约 −245 行）。
2. 删各域「死代码 / 不可达分支 / 零引用导出」条目（多为 P1/P2 里的 **S** 项）：`purge_stale_files` 纯转发包装、`walk_defs` 的 `let _ = src`、`plans/runner.js` 不可达降级分支、`scripts/dev-decrypt-ssh-pw.cjs`、`renderer-agent-api.js` 空壳文件、`src/agent` 8 个只内部使用的导出、新增文件里 4 处死导出/纯透传包装。

**第 1 批 · 已漂移的重复（先止血，别先重构）** —— ✅ 全部完成
4. ✅ `renderer-5` 模型设置归一化（会静默丢 `headers`/`authMode`/`userAgent`）已合流，见 §8.4。
5. ✅ 剩下四对（`tool_call` 标签剥离 / 工具结果摘要 / 行差异统计 / 剪贴板）已合流，见 §8.5。

**第 2 批 · 单一来源对齐（声明与代码不一致的）** —— ✅ 完成（机制部分）
6. ✅ Gateway「本机 vs 远端」：5 处 handler 直读视图目标收回到 `resolveCallWorkspaceTarget()`；`fs.grep`/`fs.glob` 收回到适配器接口。见 §8.6①②。
7. ✅ 计划执行器与主循环的**历史装配 / helpers / 轮次上限 / 空交付文案 / 模型解析**已共用，`AGENTS.md:58` 的声明已改准；系统提示装配仍各一份（计划独有，夹具已就位待下一轮合并）。见 §8.6③ + §8.7③。

**第 3 批 · 补机械闸门** —— ✅ 2/3 完成
8. ✅ 按 `docs/NODE-THINNING-PLAN.md` N4.1 建 `scripts/check-renderer-dead-exports.cjs`，接进 `check:renderer`（白名单必须写理由）；因为同批已把 20 处清干净，**直接以严格模式上线**，见 §8.3。
9. ✅ `test:tool-args` 与 `verify:tool-validators` 已收进 `docs/CODEMAP.json` 的 `suites.agent`（verify 排在 test 之前），CI 从此守住 catalog ↔ 校验器同源，见 §8.7①。
10. ✅ 让 CI 的 `npm run test:agent` 不再因为缺 sidecar 而静默 SKIP 三个 core 依赖套件：CI 现在先 `cargo build -p dieyun-core`，再用 `--require-core` 把「缺内核的套件」变成失败，见 §8.7④。

**第 4 批 · 结构（P2，需分批，每步跑对应 smoke）**
11. 超长且混杂的文件按既有 `// ---` 分节机械搬迁（`knowledge-maintainer.js`、`gateway/rpc.js`、`peer/coordinator.js`），只改可见性不改逻辑；参考 `docs/ARCHITECTURE-DEBT.md` §13 里 Rust `planner/run.rs` 1229→560 的同一套做法。

---

## 六、复现与取证

- 机器可读的完整发现（每条含全部证据行、减法方案、验证方式）：`docs/audit/2026-11-cleanliness/*.json`，一域一份（`agent` / `renderer` / `main-gateway` / `features` / `rust` / `scripts-tests` / `single-source` / `diff`）。本报告 §四 由这些 JSON 直接渲染。
- 复跑扫描（只读，不改源码）：
  - `node docs/audit/2026-11-cleanliness/tools/clone-scan.cjs` —— 8 行归一化滑窗克隆检测（产出 `clone-report.txt`）
  - `node docs/audit/2026-11-cleanliness/tools/clone-pairs.cjs` —— 按文件对聚合重复窗口
  - `node docs/audit/2026-11-cleanliness/tools/dead-scan.cjs` —— 孤儿模块扫描（**本轮实测 0 个**：`src/` 525 个文件全部有引用方）
  - `node docs/audit/2026-11-cleanliness/tools/renderer-dead-fns.cjs` —— Renderer 零调用点声明
  - `node docs/audit/2026-11-cleanliness/tools/verify-dead-exports.cjs` —— 对候选清单做全仓复核（排除动态引用）
  - `node docs/audit/2026-11-cleanliness/tools/doc-path-drift.cjs` —— 文档里引用的源码路径是否存在
- 另外两条一次性命令（未脚本化）：全量 ad-hoc ESLint 与 `clippy`，见 §2.5 / §二表。

---

## 七、本次未覆盖 / 刻意不报

- **没跑运行时行为验证**：本轮只做只读审查 + 静态闸门，没有跑 `npm test` 全量、没有跑 `cargo test`（只跑了 `clippy`）。改动前仍需按 `AGENTS.md`「改动 → 测试」表跑对应项。
- **刻意不报**（既有文档已裁定、或属伪冗余）：`agent-limits.js` 拆文件、`system-prompt-prep.js` 拆文件、两套滚动跟随合流（`MODULE-CHAOS-REVIEW` §10.4 明写「刻意不做」）、`alias`/`peer` 的 `autoTrust` 默认值、`REDUNDANCY-REVIEW` §C 的伪冗余清单、`NODE-THINNING-PLAN` 负向清单里的「判定留在 Node 别再搬」。
- **`docs/` 自身的整洁度**：抽查了「文档里引用的源码路径是否存在」，确认有 40 余处引用了**已删除文件**（如 `docs/LLM-RPC.md` 提 `src/llm-proxy.js`、`docs/REDUNDANCY-REVIEW` 提 `src/web-shared/voice-recorder.js`）。其中绝大多数是**历史叙述**（「已删除」本就是结论的一部分），我**不建议**去清，因为删掉历史会把「否决过的方案」从记忆里抹掉。唯一需要动的是 `NODE-THINNING-PLAN.md` N4.1 里那个「动什么算完」指向的脚本——按 §五 第 7 步真正建起来，别让文档继续承诺一个不存在的东西。
- **性能与安全审查**：不在本次口径内（`src/gateway` 的沙箱/白名单语义属于安全面，本轮只在「是否为唯一来源」这个整洁度维度上看）。

---

## 八、执行记录（2026-11-21 已落地）

> 本节记录**真正删掉的东西**，与上面「发现」严格对应。原则：只动「删掉之后没人会缺」的部分，不引入任何新机制。

### 8.1 第 0 批 · 删掉的（净减约 590 行，新增约 110 行——都是把「断言副本」换成「断言真代码」）

| # | 做了什么 | 文件 | 行 |
|---|---|---|---:|
| 1 | Renderer 20 处零调用点顶层声明（含被它们独占的 108 行 worktree apply 对话框） | `agent/worktree-ui.js`、`renderer-composer.js`、`renderer-model-runtime.js`、`renderer-artifacts*.js`、`renderer-plan-changes.js`、`renderer-rust-loop-boot.js`、`renderer-settings-shell.js`、`renderer-skills-grid.js`、`renderer-undo-stack.js`、`renderer-graph-panel.js`、`renderer-agent-context-ui.js`、`renderer-agent-llm.js` 等 12 个文件 | −245 |
| 2 | 被上一条连带的孤儿：`findDomainById`（只有 `skillDomainLabel` 用它） | `renderer-skills-grid.js` | −9 |
| 3 | 三处「一行 window 别名」死导出：`renderChannelsSettings` / `clientToUserInViewBox` / `cancelMobileVoice` | `renderer-channels.js`、`renderer-trace-graph.js`、`mobile/public/voice.js` | −3 |
| 4 | 与逐名导出重复的 `window.DieyunGoalPanel` 聚合对象（同一批函数已各自 `window.X =`） | `renderer-goal-panel.js` | −10 |
| 5 | `renderer-agent-api.js` 空壳文件（8 行只有一句 `window.cleanupSessionContinueState = …`，函数本身在 `renderer-agent-continue.js`；`/* global */` 里列的 40 个名字正文一个没用） | 删文件 + `index.html` script + `README.md` 一行 + `CODEMAP` 两处 | −8 |
| 6 | `src/agent` 9 个「只内部用却对外导出」的名字 | `session-context.js`(3)、`session-title.js`、`browser-vision.js`、`turn-reviewer.js`、`mutate-queue.js`、`session-transcript.js`(2) | −9 |
| 7 | `purge_stale_files` 纯转发包装（force / 非 force 两个分支本来就是同一个函数） | `crates/.../graph/cleanup.rs`、`graph/build.rs` | −11 |
| 8 | `walk_defs` 的未用参数 `src` 与 `let _ = src` 占位 | `crates/.../treesitter/chunk.rs` | −2 |
| 9 | `plans/runner.js` 的「无工具单次 LLM」降级分支（唯一生产调用点恒传 gateway/coreBridge/createToolBridge，树内走不到；它自带第二份 dieyun 系统块 + 技能块 + 执行 TODO 块）；`runPlan` 变成 `runPlanAgentLoop` 的具名别名 | `src/plans/runner.js` | −29 |
| 10 | `scripts/dev-decrypt-ssh-pw.cjs`（全仓零引用 + 又一份 safeStorage 解密实现 + 失败还 `exit 0`） | 删文件 | −40 |
| 11 | `scripts/test-session-handoff.cjs`（与 `test/unit/session-handoff.test.cjs` 测同一件事）；**删前先把它独有的 4 条「`<` 转义 / 定界符不可伪造 / 注入审计」断言搬进了单测** | 删文件 + `package.json` 一行 + `CODEMAP` 映射改指 `test:unit` | −98 |
| 12 | `scripts/test-composer-queue-edit.cjs` 里那批「自己抄一份实现再断自己」的假测试（`reorderById` / `shouldAutoFlush` / `takeById` 在 `src/` 里**根本不存在**）；改成用沙箱加载**真实**的 `renderer-composer-queue.js` 与 `renderer-chat-live-run.js` 再断言 | 重写该脚本 | −159 / +76 |
| 13 | 新增模块 `agent-mode.js` 的死导出 `FAN_OUT_MAX_SUBTASKS`、`remote-run-worktree.js` 的转手再导出 `repoRemotePathOf`、两个未使用的 marker 常量 | `agent/main-tools/agent-mode.js`、`ssh/remote-run-worktree.js` | −4 |

### 8.2 现场判定「先不动」的（附理由，避免下轮重复讨论）

| 项 | 为什么不动 |
|---|---|
| `renderer-agent-tools.js` / `renderer-mutate-queue.js` | **判错了并已更正**（§3.1）：委托通路是活的。它们是真重复（P1），删之前得先定「一份」，还要手测三个 `RENDERER_ONLY_TOOLS`，不能算零风险删除。 |
| `wecom-media.js:116 sniffImageMime` 同签名包装 | `test/unit/wecom-media.test.cjs:117-118` 明确把「与 `guardrails-shared.sniffImageMimeFromBytes` 逐值相等」钉成了契约 —— 它有测试锁，属「刻意」而非漏删。 |
| `skills/enabled-store.js` 的 `version` 字段 | 要么读它做迁移、要么不写；这是设计决定（迁移策略），不是删除。 |
| `ssn/…` 之外的 `getSessionComposerDraft` | 它是 `test/unit/composer-draft-session.test.cjs` 在用的接口，不是死码。 |
| `mobile/public/app.js` 的 `window.__dieyunCameraResult` | 我的扫描把它标成零引用，**实际由 Android 原生回调**（`mobile-app/android/.../MainActivity.java:1284`）—— 差点误删，留作教训：**跨语言回调必须查原生代码**。 |

### 8.3 第 3 批 · 补上「零调用点」闸门（唯一新增的机制，也是防止本轮删掉的东西再长回来的那道闸）

| 做了什么 | 文件 |
|---|---|
| 规则一 · 零调用点：对 `index.html` 加载的每个脚本做顶层声明计数（同文件 + 跨文件 + `window.X`），零调用点即失败；白名单 `scripts/renderer-dead-exports-allow.json` 每条必须写 `reason`，且「已经不再成立」的条目会报 stale | `scripts/check-renderer-dead-exports.cjs`（新）、`scripts/renderer-dead-exports-allow.json`（新） |
| 规则二 · 不许覆盖 bundle 导出：index.html 的脚本若声明了与 `agent-bundle-entry.js` 某个 `compat` 同名的顶层绑定，就失败 —— 经典 `<script>` 的函数声明会**覆盖** window 上的同名属性，于是「壳里读 `window.X`」变成自己调自己（栈溢出）。**这条规则是当天被自己的 bug 逼出来的**（见 §8.5②） | 同上 |
| 接进 `npm run check:renderer`，**直接以严格模式上线** | `package.json` |
| 正向对照已验：塞一个死函数 → `FAIL` 点名；塞一个与 bundle 同名的壳 → `FAIL` 点名；两项都删掉 → `OK` | — |

> 白名单当前 2 条，都是「刻意同名/刻意保留」并写了理由：`renderer-model-runtime.js` 的 `STORAGE_KEY`（它自己的 localStorage 键，与 tier-store 的键同名不同义）与 `isSupplierModelEnabled`（委托壳，读的是命名空间 `window.DieyunModelApiConfig` 而不是同名全局，给零 window 沙箱兜底）。
>
> 已知盲区写进了脚本头部：`src/renderer/agent/*` 那批走 `agent-bundle-entry.js` 打进 `dist/`，导出经 `DieyunNamespaces.register({ … })` 成对象，**对象字面量里出现名字就算被引用**，本闸门在那里判不出死导出。别把它当成「全仓死代码证明」。

### 8.4 第 1 批 · 已漂移的重复：`renderer-5`（模型设置归一化，会静默丢字段的那条）已合流

**症状（改之前）**：`src/model-settings.js`（Main）与 `src/renderer/renderer-model-runtime.js`（Renderer）各写一套 embedding 条目归一化。Renderer 那份只重建 `id/name/baseUrl/apiKey/dimensions/active` 六个键 → 用户在设置页保存一次，`headers` / `authMode` / `userAgent` 就没了；而 `src/agent/embedding-config.js:114,128-129` 恰恰读它们（`headers: buildLlmHeadersFromConfig(…)`）→ 向量端点静默 401/403，界面上没有任何报错。第二条丢法在编辑器里：`saveEmbeddingModelFromEditor` 也只重建六个键。

**改法（减法，没加开关）**：

| 文件 | 动作 |
|---|---|
| `src/agent/model-settings-embedding.js` | **新增**纯函数模块：`EMBEDDING_DIMENSIONS_MIN/MAX`、`isLegacyBuiltinEmbeddingEntry`、`normalizeEmbeddingEntry`（保留请求修饰字段）、`normalizeEmbeddingModels`（老单条迁移 → 丢内置 BGE → 逐条归一 → 只留有名字+端点 → 丢 `embedding-default/text-embedding-v4` 占位 → `active` 单选）、`applyActiveEmbedding`（回填顶层 `embedding*` 缓存字段） |
| `src/model-settings.js` | 删掉本地的 `isLegacyBuiltinEmbeddingEntry` / `normalizeEmbeddingEntry` / 整段流水线（约 −45 行），改调共享模块；`64 / 8192` 字面量随之只留一份 |
| `src/renderer/renderer-model-runtime.js` | 删掉同一段（约 −55 行）与本地 `EMBEDDING_DIMENSIONS_MIN/MAX` 字面量；改成 `embeddingApi.normalizeEmbeddingModels / applyActiveEmbedding` —— **故意不给兜底实现**，缺了就抛「agent-bundle 未加载」（`index.html` 里 bundle 先于本文件加载） |
| `src/renderer/agent/agent-bundle-entry.js` | `register('DieyunModelSettingsEmbedding', …)`，compat 暴露 7 个名字（与 `clampModelRuntimeValue` 同一条通道） |
| `src/renderer/renderer-model-settings.js` | 编辑器保存时先 `...models[idx]` 再覆盖六个键 —— 不再把没暴露在界面上的字段冲掉 |

**同批消掉的第二处漂移**：历史占位条目（`id=embedding-default` + `name=text-embedding-v4`）的过滤以前**只在 Renderer**，同一份磁盘配置两侧结论不同；现在搬进共享函数，两侧一致。缺 id 的条目也从 `embedding-${Date.now()}-${i}`（每次归一化都换 id，编辑中再保存会变两条）改成确定性的 `embedding-${i+1}`。

**新增 parity 用例**：`test/unit/model-settings-normalize-parity.test.cjs` —— 8 组 fixture（请求修饰字段 / 内置 BGE / 历史占位 / active 单选 / 缺名字或缺端点 / 维度夹取 / 老单条迁移 / 全都不启用）双跑 Main 与 Renderer 深等，另加「headers 经 Renderer 归一化后仍在」「缺 id 得到确定性 id」两条。**这条用例在改之前是红的**（正是它把丢字段抓出来的）。

### 8.5 第 1 批 · 剩下四对已合流（2026-11-21 第二轮）

> 四对的共同形态：**同一份语义在 Main 与 Renderer 各写一遍，已经给出不同答案**。改法统一为「留信息更全的那份，另一份改调」，没有一条加开关。
> 两条纪律：Renderer 侧一律**不写第二份实现** —— 能直接读全局就读全局（`summarizeToolResult` / `computeLineDiffStats` 走 bundle 的 compat 镜像，但**不许声明同名壳**，见 §8.5② 的坑）；确实需要「缺 bundle 就说清」的地方用**调用时**解析（embedding 归一化），不在加载时抛错 —— 这几个文件会被单测在零 window 沙箱里加载。
> 取证来源：① 与 ② 在 `docs/audit/2026-11-cleanliness/` 的 `renderer.json` / `agent.json` 里有完整条目；③ 行差异统计与 ④ 剪贴板是**第一轮取证**（第二轮 JSON 未重复收录），证据行为当时实测：`src/gateway/line-diff-stats.js` ↔ `renderer-tool-results.js:421-448`、`renderer-chat-bubbles.js:181-219` ↔ `renderer-mobile.js:56-80`。

**① `tool_call` 标签剥离（P0）** —— Renderer 两份逐字副本（`renderer-agent-continue.js` / `renderer-thinking-trace.js`）删掉，改调 `window.stripToolCallMarkup`（`src/llm-tool-call-fallback.js`，Main 侧唯一实现）。

- 漂移点：两份副本只认全角 `<\uff5cDSML\uff5c` 与 `<tool calls>`，**不认裸 `<calls>`、不认半角竖线 / 带空格的 DSML 变体** → 同一条回复在 Main 侧剥净、气泡里漏出工具标记。
- 回归用例：`scripts/test-llm-tool-call-fallback.cjs` 新增「裸 `<calls>` 必须剥净且能解析出调用」+「纯文本不许被剥变形」两条。

**② 工具结果摘要** —— 新增 `src/agent/tool-result-summary.js`（≈300 行，纯函数），从 Renderer 搬出整套按工具的摘要（它比 Main 那份全得多），Main 的 `live-loop-trace.js` 改调它并删掉自己的 `summarizeLoopTool` / `summarizeHostExecInline`（−42 行）。

- 统一了四处漂移：后台化判据 `(timedOut && stillRunning) || detached`（以前两个字段名各认一个）、非零退出码保留真实值（以前 Main 压成 `exit 0`）、「看起来不像输出」正则取并集（补 `import `）、无输出兜底统一「命令成功（无输出）」。
- 失败文案统一成「失败：[CODE] … · 建议」，Main 那几个「错误: …」分支删掉。
- 回归用例：`test/unit/tool-result-summary.test.cjs`（8 条，逐条钉住上面四个漂移点 + result.error 与 phase error 同句）。
- ⚠️ **踩到一个坑（已修，并变成闸门规则二）**：第一版我保留了同名的薄壳 `function summarizeToolResult(){ return window.summarizeToolResult(...) }`。经典 `<script>` 的顶层函数声明会在脚本实例化时**覆盖** window 上的同名属性，而 bundle 早已把 `window.summarizeToolResult` 设成共享实现 —— 于是壳里读到的就是壳自己，**一调用就栈溢出**。正确写法是**不声明同名壳**：调用点（含 Renderer 内部）直接用全局名；`check-renderer-dead-exports.cjs` 现在会拦这一类。

**③ 行差异统计（+N −M 徽标）** —— Renderer 自己那份 LCS（不裁公共前后缀、按 `'\n'` 切、超限用 `max(0, m-n)` 兜底）删掉，改调 `src/gateway/line-diff-stats.js`（Main 三处也用它）；新增 `withinLineDiffBudget()` 作为「这份 diff 还算得动吗」的**唯一判据**，`buildLineDiffOps` 也改用它（以前两处各写 4000 / 400000）。

- 顺带修掉两个真实缺陷：CRLF 文件以前被当成「每行都改」（按 `'\n'` 切留下 `\r`），大文件以前徽标给 `+0 −0`、展开却是块级差。
- 回归用例：`test/unit/line-diff-stats.test.cjs` 增 `withinLineDiffBudget` 三条（含异常输入按 0 处理）。

**④ 剪贴板** —— 唯一实现挪到 `renderer-utils.js#writeClipboardText`（异步 API 优先 + 降级 textarea 后**必须交还焦点**）；`renderer-chat-bubbles.js` 与 `renderer-mobile.js` 各删一份。

- 漂移点：手机连接页那份是「textarea 优先 + 从不交还焦点」→ 点一次「复制连接地址」，光标掉出输入框、接着敲字不进 composer（桌面那份的注释里早就写明了这个坑）。
- 没有专门用例（纯 DOM 行为）；靠 `check:renderer` 保证导出可解析 + 手测清单：气泡复制多行代码、连接页复制后直接敲字。

**本批的净变化**：Renderer 侧 `renderer-tool-results.js` **−281 行**、`renderer-agent-continue.js` / `renderer-thinking-trace.js` 各 −27 行、`renderer-mobile.js` −20 行；Main 侧 `live-loop-trace.js` −42 行；新增共享模块 `src/agent/tool-result-summary.js`（≈300 行，但它是**唯一**一份，此前两份合计 ≈470 行）。bundle 新增三个 namespace：`DieyunToolResultSummary` / `DieyunLineDiffStats` / `DieyunToolCallFallback`。

### 8.6 第 2 批 · Gateway 的两条 P0 + 计划执行器去重（2026-11-21 第三轮）

**① handler 读的是「视图」，不是「这次调用」——5 处收回 `resolveCallWorkspaceTarget()`**

`fs.js:371` 与 `lsp-workspace.js:160 / 309 / 501 / 638` 读的 `ctx.getWorkspaceTarget()` 是**视图**（当前桌面在看哪个目录），而 `rpc.js:164 resolveCallWorkspaceTarget()` 才认「这次调用属于哪个会话 / 哪个 run」（它内部优先 run 作用域与显式 `sessionId`，最后才回落视图）。

- 后果（改动前）：并行会话或显式传 `sessionId` 的频道/计划轮里，`fs.read_symbol` 会**按视图判成本机**（套本机读白名单、不连远端 LSP），而真正读文件却按调用上下文走远端 —— 一边远端读、一边本机白名单；`lsp.*` 四个方法同样会去连错机器的 LSP。
- 改法：把 `resolveCallWorkspaceTarget` 注进这两个 handler（`computer` / `host` / `scm` / `workspace` 早就这么拿），5 处内联全部换成它；`ctx.getWorkspaceTarget` 现在只留在 `rpc.js:176` 那一个回落点。
- 回归用例：**新增 `test/unit/handler-workspace-scope.test.cjs`** —— 视图=本机 + 调用=SSH 时 `fs.read_symbol` 必须按远端降级语义回报；反向再一条。**这两条在旧代码上是红的**。

**② `fs.grep` / `fs.glob` 自己判传输 —— 收回适配器接口**

两个 handler 原来各自「先看有没有远端 Agent，再判 `transport === 'sftp'`」，等于把 `getRemoteFs()` 的判断抄了一遍。

- 改法：把 `grep` / `glob` 补进两个适配器的接口（`remote-agent-fs.js` 走 `fs.grep`/`fs.glob` RPC；`remote-fs.js` 走注入的 `execGrep`/`execGlob`，即原来的 `grepViaRemoteExec`/`globViaRemoteExec`，由 `rpc.js:getRemoteFs()` 注入）。handler 只留一句「问适配器，做不了就回落本机」。
- 兼容：适配器可能没实现 grep（老远端包 / 单测假对象）→ handler 用 `typeof … === 'function'` 判能力并回落本机搜索，不新增开关。
- 夹具：`test/unit/host-local-routing.test.cjs` 的假远端 fs 补上 `grep`/`glob`（照生产同一条契约接到 exec），并在 `read-symbol-remote-lsp.test.cjs` 里把 deps 从 `ctx.getWorkspaceTarget` 改成 `resolveCallWorkspaceTarget`。

**③ 计划执行器去重（`plan-agent-runner` ↔ `main-turn-runner`）**

**没有整块合并骨架**，理由是：计划侧的 tier 解析口径（按 `plan.modelRoute || llmModel`）、系统提示（无 UI 上下文自己拼）会变行为，而仓里没有能断言的「计划真跑一轮」夹具 —— 先做安全的部分，把差异钉在代码里：

| 抽成单一来源 | 位置 |
|---|---|
| 历史读取（`memory.messages_recent` → 只留 user/assistant → 补 `created_at`） | `session-context.loadRecentTurnMessages` —— **顺带修了漂移**：计划那份只认 `created_at`、主循环那份认 `createdAt || created_at` |
| `buildCompletionMessagesFromHistory` 的三件套 helpers | `session-context.completionHistoryHelpers` |
| 轮次上限 | `agent-limits.resolveAgentMaxRounds`（三处内联 clamp：计划 / 主循环 / `headless/desktop-turn`） |
| 「这一轮什么都没交付」的用户文案 | `agent-round-text.emptyTurnFailureMessage`（以前「请查看日志后重跑」vs「请查看日志后重试」两种） |

计划执行器删掉 `loadSessionMessages` / `buildPlanCompletionMessages`（−30 行），并在文件头写明**只有三处是计划独有**（计划专属 system 块 / `GOAL_TOOLS` / `mutatingToolCalls` 统计），其余一律改共用那份。`AGENTS.md` 里「main-turn-runner 是唯一实现（频道/计划/headless 共用）」这句同时改准：频道/headless/生命感共用，计划另有执行器且共用四个来源。

### 8.7 收尾闸门 + 计划轮夹具 + 模型解析合并（2026-11-21 第四轮）

**① 最后一条闸门：把两条只跑在「按路径映射」里的检查收进 CI 套件**

`test:tool-args`（62 条双跑夹具）与 `verify:tool-validators`（生成物新鲜度）以前只在 `docs/CODEMAP.json` 的 `pathRules` 里，也就是**只有改到那几个文件时本地 `npm test` 才会跑**；CI 跑的是 `npm run test:agent`（`--all`，不看 diff），于是「改了 catalog 忘了重生成校验器」可以一路绿到合并。

- 改法：两条加进 `suites.agent`（56 → 58 步），并让 `verify:tool-validators` 排在 `test:tool-args` 之前（先验生成物新鲜度，再谈双跑一致率）。
- 验证：`npm run test:tool-args` 单独跑通（62/62 一致、差异 0）；`test:agent` 现在会带它们。

**② 计划轮夹具（补齐「合并前先有网」这一步）**

`test/unit/plan-agent-run-turn.test.cjs` —— 用 `ctx.runRustAgentLoop`（**测试缝，生产调用方从不传**）把 `runPlanAgentLoop` 的整条编排跑起来，钉住 5 件事：

1. 系统提示必须同时含：身份段、`【定时计划 Agent】`、`计划名称：`、`工作空间`、`【本次任务】`；
2. `startParams`：模型名 / 轮次上限（= `agent-limits` 的 clamp 值）/ 工具上限 / `workspaceRoot` / `runSource: 'plan'`；
3. 只有 `trigger === 'goal'` 的计划才拿 `goal_check` / `goal_finish`；
4. 历史只留 user/assistant，且 `createdAt` 与 `created_at` 两种字段都归一（这条单独测 `loadRecentTurnMessages`）；
5. 空正文如实失败，文案与主循环同一份（`emptyTurnFailureMessage`）。

**③ 计划执行器的模型解析并进主循环那份**

删掉计划侧自带的「loadModelSettings → resolveTextApiConfig → 缺 key/缺模型两段报错 → tier → budget → apiCfg」整段（约 25 行，那句「逐字段重建会丢 headers / authMode / userAgent」的注释此前在四个文件里各抄一遍），改调 `main-turn-runner#resolveTurnModel`：

- `strict: true` 保留（路由失效明确报错，绝不静默换 key）；
- 新增可选 `tierHint` 参数：计划按「计划绑定的路由」判 Context 档位（定时执行没有设置页可问），主循环不传则按解析出的模型名 —— 这就是原先两处口径差异的显式化，不是新开关；
- 计划侧独有的报错措辞（「计划绑定的模型不可用（X）」）用一个 `try/catch` 保住：只有在**确实绑定过模型**时才改写，否则原样抛。

计划执行器随之摘掉 4 个不再需要的 import（`model-settings` / `model-runtime-by-tier` / `compaction-main` / `model-runtime-schema`）。

**仍然没并的**：计划专属的**系统提示装配**（`buildPlanSystemMessage`）。它要拼「无 UI 上下文的人格段 + 计划名 + 工作空间」，与聊天那条 `prepSystemPrompt` 的输入快照不是同一形状；合并等于给计划轮加进 AGENTS 规则/记忆召回/代码召回等一整批块，属于**行为变更**。现在夹具已经能断言「喂了什么」，下一轮可以拿它做对照再合。

**④ CI 的 core 依赖套件不再静默跳过（用户拍板：选「先编译内核 + 跳过即失败」）**

问题很朴素：agent 套件 58 步里有 3 步要真连 `dieyun-core`（`test:core-bridge` / `test:request-snapshot` / `test:planner-e2e`），而 CI 里 `Agent smoke` 这一步排在**所有 Rust 步骤之前** —— 那时内核还没编译，于是这 3 步各自打印 `SKIP ...` 然后算通过。结果是：**CI 全绿，但这三条链路一次都没验过**。

改法两步：

| 改哪 | 怎么改 |
|---|---|
| `.github/workflows/ci.yml` | 在 Agent smoke 之前加 `cargo build -p dieyun-core`（产出 `target/debug/dieyun-core`，正是 `core-bridge-path.js` 的候选路径之一）；`Agent smoke` 改成 `npm run test:agent -- --require-core` |
| `scripts/test-agent-smoke.cjs` | 新增 `--require-core`：缺内核时**直接失败并说清怎么做**（`cargo build -p dieyun-core` / `npm run pack:dieyun-core`），不再打印 SKIP。本地默认仍是「缺就跳过」，不影响没 pack 过的人 |

双向都验过：把三个候选二进制临时移走 → `--require-core` 立刻退出 1 并给提示（随后已还原，无残留）；二进制在场时整套跑通。CI 会因此多花约 3–6 分钟（Rust 增量缓存后更少）。

### 8.8 第 4 批 · 结构搬迁（`knowledge-maintainer.js` 七刀）

`knowledge-maintainer.js` 是 `src/agent` 里第二大非 limits 文件（1653 行），同时握着「设置 IO / 提示词 / 信号与门闩 / 记忆落库 / 共享记忆上传 / 定时器」六件事。按**依赖顺序**切了七刀，每刀都跑 `test:knowledge-maintainer` + eslint 未用变量检查：

| 刀 | 搬了什么 | 去哪 | 行数变化 |
|---|---|---|---|
| 1 | 设置的落盘 / 归一 / 档位常量（9 个名字） | **新增** `src/agent/knowledge/settings.js` | 1653 → 1571（−82）／新模块 117 |
| 2 | 信号与门闩：`compactPlain` / `summarizeTrace` / `toolPathOf` / `collectKnowledgeSignals` / `shouldRunKnowledgeMaintenance` / `MEMORY_SCOPES` / `MEMORY_KINDS` / `normalizeMemoryScope` / `parseKnowledgeJson` | **新增** `src/agent/knowledge/signals.js`（只依赖 guardrails 工具名表 + `toolFailed`） | 1572 → 1388（−184）／新模块 217 |
| 3 | 提示词与写入规则：`PROJECT_MEMORY_FILE_RULE` / `UNIFIED_KNOWLEDGE_SCHEMA` / `AGENTS_MERGE_RULE` / `agentsPressureNote` / `buildKnowledgeSystemPrompt` | **新增** `src/agent/knowledge/prompt.js`（只依赖 `agents-md` 的 `MAX_FILE_CHARS`） | 1389 → 1313（−76）／新模块 104 |
| 4 | 落库：`formatMemoryRowsForPrompt` / `writeGlobalMemories` / `applyMemoryItems` / `mirrorShareable` / `applyArchiveMemoryIds` / `applyAgentsUpdates` + 项目记忆文件（`projectFileCtx` / `readProjectMemoryText` / `writeProjectMemoryText` / `appendProjectMemoryToFile` / `materializeProjectMemoryFile` / `readWorkspaceText`） | **新增** `src/agent/knowledge/apply.js`（只依赖 `project-memory-file` / `workspace/target` / `propose-tools-main` / `signals`） | 1314 → **1009**（−305）／新模块 349 |
| 5 | LLM 调用：`resolveLlmCall`（端点 / 请求头 / 超时解析）/ `callLlm`（走 core `llm.complete`，可注入替身）/ `extractContent` | **新增** `src/agent/knowledge/llm.js`（只依赖 `llm-complete` / `llm-request` / `model-settings`） | 1010 → **929**（−81）／新模块 98 |
| 6 | 共享记忆提炼：`SHARED_CONSOLIDATE_SYSTEM` + `runSharedMemoryConsolidation`（抢锁 → 取候选 → 模型合并 → 落库 → 记台账） | **新增** `src/agent/knowledge/shared-memory.js` | 930 → 836（−94）／新模块 117 |
| 7 | 两条运行路径：`gatherPeriodicCorpus` / `runTaskMaintenance` / `finishJob` / `runPeriodicMaintenance` / `buildRunFacts` | **新增** `src/agent/knowledge/run.js` | 836 → **466**（−370）／新模块 398 |

- **七刀都是纯搬移**：逻辑一行没改；`knowledge-maintainer.js` 继续再导出被外部用到的名字，**导出面 22 个名字一字未变**（`main/ipc/agent-runtime.js`、`scripts/test-knowledge-maintainer.cjs` 都不用改）。
- 每刀顺手清掉搬走后变死的 import（`fs` / `path` / `guardrails-shared` / `toolFailed` / `propose-tools-main` / 若干不再用到的再导出名）——四个 `knowledge/*` 文件 + barrel 现在 **eslint 零告警**。
- CODEMAP 已有 `pathRule`（`src/agent/knowledge/` → `test:knowledge-maintainer`），改这一片时 `npm test` 会选中对应 smoke。
- **净结果：1653 → 466 行（−1187）**，职责从「一个文件六件事」变成「barrel（调度器 + 入口 + 22 个再导出）+ 7 个各管一件事的模块」。

> 过程记录（切片脚本的坑，都靠「先断言、后落盘」拦住，未留半截状态）：① `trim() === '}'` 把缩进 3 格的 `}` 当函数结尾；② 把小节标题下面那行 `// ---`（本节自己的收尾）当成下一节开头；③ 第四节把「项目记忆文件」小节里**原本内联的 require** 又抄进了新文件头部 → 重复声明；④ 迁移后 barrel 仍用到 `projectFileCtx` / `projectMemoryFile`，第一次漏进 import 列表（smoke 立刻报 `projectFileCtx is not defined`）。前两处 `git checkout` 复原重来，后两处是当场补 import / 删重复。

### 8.9 第 4 批 · `peer/coordinator.js` 第一刀（房间语义抽出）

`peer/coordinator.js`（1343 行）与知识归纳器不同：它**没有**按小节分开的顶层函数，六类状态机全在
`createPeerCoordinator(deps)` 一个大闭包里，共享 12 个可变 Map/Set（`ownClaims` / `peerClaims` /
`pendingTurns` / `turnBudget` / `seenInbound` / `pendingInbound` / `awaitingReplies` …）。所以「机械按
`// ---` 切」在这里不成立 —— 一刀下去必须同时定「谁还够得着那些状态」。

第一刀选了**最内聚、且对外只露 7 个函数**的一段：房间（agent 聊天室）。

| 搬了什么 | 去哪 |
|---|---|
| `newRoomId` / `roomsList` / `resolveRoomMembers` / `createRoom` / `closeRoom` / `peerNameOf` / `peerRoleOf` / `sendToRoom` / `roomTimeline` / `appendInbound` / `inboundText` | **新增** `src/peer/rooms.js`（271 行，`createPeerRooms(host)`） |

**怎么切才不会偷偷改变行为**：房间只依赖下面 9 个宿主能力，全部显式传进来（不再靠「同一个闭包里什么都够得着」）：

```js
const rooms = createPeerRooms({
  store,                      // peer 存储（房间/信任/设置的唯一读写口）
  rpc: (m, p) => d.rpc(m, p), // 只给 memory.message_append / messages_recent
  findPeer, sendToPeer,       // 扇出与成员解析
  emit,                       // room-created / room-closed 事件
  nowMs, workspaceInfo, limitInt,
  isStarted: () => started    // 「没启动就别发」的闸（惰性求值，搬不走状态）
});
```

- **纯搬移**：函数体逐字未改，唯一改动是闭包内名换成宿主名（`d.rpc(...)` → `rpc(...)`、`started` → `isStarted()`）——这两处是 `eslint no-undef` 逼出来的，正是这刀想的收益：房间从此不可能偷读租约状态。
- `coordinator.js`：**1343 → 1144 行**（−199）；`rooms.js` +271；导出面不变（仍是 `{ createPeerCoordinator }`）。
- 顺手删掉搬走后变死的 `require('crypto')`（`newRoomId` 带走了它）。

**验证**：`npm run test:peer-mesh`（含 74 行房间断言）/ `test:peer-tools` / `test:peer` 全通过；
`check:js` / `check:contracts` / vitest 2412 用例 / `test:agent --require-core` 全绿；
`coordinator.js` + `rooms.js` 在 `no-undef` + `no-unused-vars` 下零告警。

> 下一刀（未做）：**租约（claim / broadcastClaim）**与**入站可信判定（trust/autoTrust/pendingInbound）**
> 是剩下两段里耦合最浅的；出站发送（`sendToPeer` / `registerPeerFromHandshake` / `awaitingReplies`）与
> 生命周期（`start`/`stop`/`restart`/`setXxx`）互相咬得最紧，建议放最后，且一次只搬一段、每段都跑同一套
> peer 测试。

### 8.10 第 4 批 · `peer/coordinator.js` 第二刀（租约语义抽出）

第二刀搬**租约（`file` / `task` 互斥）**：这是六类状态机里耦合第二浅的一段（只依赖「在线对端列表 +
发送 + 事件 + 身份」）。和房间那刀不同，这次**状态本身也跟着搬走** —— `ownClaims` / `peerClaims`
两个 Map 与 60 秒裁剪定时器都进了新文件。

| 搬了什么 | 去哪 |
|---|---|
| `ownClaims` / `peerClaims` / `claimTimer`（状态）+ `pruneClaims` / `ownClaimList` / `allClaims` / `conflictsFor` / `handleClaim` / `handleRelease` / `broadcastClaim` / `claim` | **新增** `src/peer/leases.js`（255 行，`createPeerLeases(host)`） |

宿主能力（9 个，全部显式）：`identity` / `emit` / `limitInt` / `peersList` / `getClient`（惰性取，`start()` 前是 null）/
`registerPeerFromHandshake` / `nowMs` / `claimKey` / `claimsKeepMs`。

**新加的两个访问口**（原先 coordinator 直接摸 Map，现在改成走接口 —— 这是这刀唯一「新增代码」的地方，各 3 行）：
- `claimsOf(peerId)` ← `peersList()` 拼在线列表时要读对端租约快照；
- `setPeerClaims(peerId, claims)` ← `registerPeerFromHandshake` 握手带回 claims 时写入。
另外把 `start()` 里那段 `setInterval(pruneClaims + emit)` 与 `stop()` 里的 `clearInterval` 收成
`startPruneTimer()` / `stopPruneTimer()`，定时器状态不再散在生命周期代码里。

- `coordinator.js`：**1144 → 991 行**（−153）；`leases.js` +255；导出面不变（仍是 `{ createPeerCoordinator }`）。
- 顺手摘掉搬完后在本文件变死的 `CLAIM_KIND` / `normalizeClaim`（`normalizeClaims` 仍被握手用）。
- 函数体逐字未改，只有两处名字换成宿主名：`PEER_CLAIMS_KEEP_MS` → `claimsKeepMs`、`client.send(` → `getClient().send(`（都由 `eslint no-undef` 逼出来）。

**验证**：`test-peer-mesh` 里租约相关断言全部真跑并绿（`A 拿到租约` / `B 能看到 A 的租约（广播生效）` /
`陌生机器拿不到租约快照` / `B 拿到冲突` / `对端带回自己的租约快照字段`）；`test:peer-tools` / `test:peer` /
`check:js` / `check:contracts` / vitest 2412 用例 / `test:agent --require-core` 全绿；三个 peer 文件在
`no-undef` + `no-unused-vars` 下零告警。

**现状**：`coordinator.js` 991 行，剩下四类 —— 入站可信判定（`trustDecision` / `pendingTrustList` /
`bufferUntrusted` / `trustPeer` / `untrustPeer` + `pendingInbound` / `autoAllowed`）、入站消息处理、
出站发送（`sendToPeer` / `registerPeerFromHandshake` / `awaitingReplies`）、生命周期（`start`/`stop`/`restart`/`setXxx`）。
下一刀建议先搬**信任判定**（与租约同构：自己的状态 + 明确的宿主能力）。

### 8.11 第 4 批 · `peer/coordinator.js` 第三刀（信任判定抽出）

第三刀搬**信任判定**——入站唯一授权来源（取代 P0 的共享配对码）。它和租约同构：自己两块状态 +
一组明确宿主能力，而且 `test-peer-mesh` 里「未表态不投递 / autoTrust / deny 拦截 / 撤销」那十几条
断言正好盯着它。

| 搬了什么 | 去哪 |
|---|---|
| `pendingInbound` / `autoAllowed`（状态）+ `trustDecision` / `pendingTrustList` / `bufferUntrusted` / `trustPeer` / `untrustPeer` + 常量 `PEER_PENDING_MAX` | **新增** `src/peer/trust.js`（167 行，`createPeerTrust(host)`） |

宿主能力 5 个：`store`（`trustStatus` / `setTrust` / `settings` / `trustEntries`）、`log`、`emit`、`nowMs`、
`dispatchEnvelope`（用户在弹窗点「允许」后要把缓存的来信按顺序补投）。

**新增的两个访问口**（原来是 `stop()` / `setAutoTrust()` 直接操作闭包里的 Map/Set，各 3 行）：
- `clearPending()` ← `stop()` 关互通时不再攒陌生来信；
- `resetAutoAllowed()` ← `setAutoTrust()` 切开关时清掉「已记过日志」的记忆。

- `coordinator.js`：**991 → 890 行**（−101）；`trust.js` +167；导出面不变。
- 常量 `PEER_PENDING_MAX` 随语义一起进 `trust.js`（改名 `PENDING_MAX`），coordinator 里不再出现这个数字 —— 原先它只在 `bufferUntrusted` 用一次。
- 函数体逐字未改，只有 `PEER_PENDING_MAX` → `pendingMax` 的改名（`eslint no-undef` 逼出来的）。

**验证**：`test-peer-mesh` 里信任相关断言全跑并绿 —— `A→B 首封信被拦（未确认）`、`未确认 → 发送方拿到 NOT_TRUSTED`、
`NOT_TRUSTED 不可重试`、`B 出现一条待确认请求`、`待确认里带对方名字与来信预览`、`B 发了 trust-request 事件`、
`待确认列表清空`、`A→B 送达（已确认）`、`陌生机器 → NOT_TRUSTED`、`被拒绝的机器不再产生待确认`、
`撤销后从清单消失`、`撤销后再来信重新进入待确认`、`autoTrust=true 也拦明确 deny 的对端`；
`test:peer-tools` / `test:peer` / `check:js` / `check:contracts` / vitest 2412 用例 / `test:agent --require-core` 全绿；
四个 peer 文件在 `no-undef` + `no-unused-vars` 下零告警。

**现状**：`coordinator.js` 890 行，剩三类 —— 入站消息处理（`handleMessage` / `handleReply` / `onEnvelope`）、
出站发送（`sendToPeer` / `registerPeerFromHandshake` / `normalizeSendResult` / `awaitingReplies` / `sendFromSession`）、
生命周期与状态视图（`start`/`stop`/`restart`/`setXxx`/`status`/`noteTurnCompleted`）。下一刀建议**出站发送**
（`sendToPeer` 是最大的一块，也最独立）。

### 8.12 第 4 批 · `peer/coordinator.js` 第四刀（出站发送抽出）

第四刀是剩下最大也最独立的一块：**出站发送**。搬完 coordinator 只剩「入站编排 + 生命周期/状态视图」
两件事。

| 搬了什么 | 去哪 |
|---|---|
| `learnedPeers` / `awaitingReplies`（状态）+ `registerPeerFromHandshake` / `sendToPeer` / `normalizeSendResult` / `sendFromSession` | **新增** `src/peer/outbound.js`（235 行，`createPeerOutbound(host)`） |

宿主能力 8 个：`store` / `emit` / `limitInt` / `findPeer` / `isStarted` / `getClient`（`start()` 前是 null）/
`setPeerClaims`（来自租约：握手带回 claims 时写入）/ `nowMs`。

**新增的两个访问口**（原来都是直接摸闭包状态）：
- `learnedList()` ← `peersList()` 合并在线列表要读「握手学到的对端」；
- `resolveReply(inReplyTo, text)` ← `handleReply` 用它认领「等答复」（原来 4 行里直接操作 `awaitingReplies`）。

**跨簇回调用惰性包装**：`rooms` 要 `sendToPeer`、`leases` 要 `registerPeerFromHandshake`，而两者都在
`outbound` 之前创建 → 宿主里写成 `(input) => outbound.sendToPeer(input)` / `(peer) => outbound.registerPeerFromHandshake(peer)`。
箭头闭包在**调用时**才解引用，早于 `outbound` 初始化也不会被调用（都在 `start()` 之后）。

- `coordinator.js`：**890 → 727 行**（−163）；`outbound.js` +235；导出面不变。
- 顺手摘掉本文件变死的 `normalizeClaims` / `newMessageId`（握手与信封 id 都随出站走了）。
- 函数体逐字未改，只有两处名字换成宿主名：`if (!started)` → `if (!isStarted())`、`await client.send(` → `await getClient().send(`、`leases.setPeerClaims(` → `setPeerClaims(`。
- `check:js` 抓到一个我漏掉的点：工厂调用里还传着 `log`，但新模块的 host 契约没有它（tsc 的 `Object literal may only specify known properties`）—— 删掉即绿。这就是 scoped checkJs 的价值。

**验证**：`test-peer-mesh` 全通过，含**真正的「等答复」端到端**断言：`expectReply 的来信被对端收到` +
慢回复认领（`awaitingReplies` 走通 `resolveReply`）、`A 收到 B 的回复`、`回传用完整正文而不是 400 字摘要`；
`test:peer-tools` / `test:peer` / `check:js` / `check:contracts` / vitest 2412 用例 / `test:agent --require-core` 全绿；
五个 peer 文件在 `no-undef` + `no-unused-vars` 下零告警。

**现状**：`coordinator.js` 727 行，剩两件事 —— 入站编排（`onEnvelope` / `dispatchEnvelope` / `handleMessage` /
`handleReply` / 会话绑定 `ensureSessionForPeer` / 预算 `budgetAllows` / `rememberInbound`）与生命周期
（`start`/`stop`/`restart`/`setXxx`/`status`/`noteTurnCompleted`）。这两块天然咬在一起（入站要跑一轮就得改生命周期状态），
**建议就停在这里**：再切下去会把「一个协调器」拆成「两个互相回调的半协调器」，可读性反而下降。

### 8.13 还没做（下一轮的起点）

- **第 4 批已收口**：`knowledge-maintainer.js` 现在 466 行 = 调度器 + 入口（`createKnowledgeMaintainer` / `registerKnowledgeMaintainer` / `getActiveKnowledgeMaintainer` / `afterAgentRun` / `resolveKnowledgePlanOutcome`）+ 22 个再导出。**刻意不再改名成 `knowledge/maintainer.js`**：8 个调用方都 import 这个路径，改名只是搬运成本、没有可读性收益；「barrel 就该是入口文件」本身就是清晰的。
- **`peer/coordinator.js` 继续切**（现 991 行，四类状态机）：信任判定（`trustDecision` / `pendingTrustList` / `bufferUntrusted` / `trustPeer` / `untrustPeer` + `pendingInbound` / `autoAllowed`）→ 入站消息处理 → 出站发送（`sendToPeer` / `registerPeerFromHandshake` / `awaitingReplies`）→ 生命周期（`start`/`stop`/`restart`/`setXxx`）。最后一类与前三类都咬着，放最后。
- **另一处同型搬迁**：`gateway/rpc.js`（2164 行，剩「远程 exec / 索引 / 沙箱 / LLM 桥」几组闭包）。
- **计划系统提示装配并入 `main-turn-runner`** —— 夹具（§8.7②）已经就位，可以用「同 fixture 双跑、逐块对照」的方式做。
- 报告里其余 P1/P2 项（`renderer` 的「落库 4 遍」、`mutate-queue` 两份先定一份、`agent-limits-by-tier` 的 tier-store 工厂）都还没动 —— 都需要「选定一份」的判断，不是纯机械删除。

### 8.14 改动自查（2026-11-21 第五轮：只查不跑新批次）

把这一轮所有改动按「机械可验」的方式自查了一遍，抓到 **4 处我自己引入的 bug**（都已修）与 1 处需要说明的行为变化。

#### 用什么方法查（可复跑）

| 检查 | 做什么 | 结果 |
|---|---|---|
| **搬移等价性** | 把 64 个「从老文件搬到新文件」的函数逐个与 `git show HEAD:` 的原文逐字对比（只归一刻意改的名字：`d.rpc(`→`rpc(`、`client.send(`→`getClient().send(`、`PEER_PENDING_MAX`→`pendingMax` 等） | **64/64 逐字一致** —— 搬家没改逻辑 |
| **被删函数反向核对** | 从 `git diff` 里抓出所有被删的顶层函数（97 个）与导出名，逐个 `git grep -w` 查全仓残留引用 | 命中项全是「同一函数另有权威定义」或「本文件内部使用」，无真残留 |
| **API 面比对** | `peer/coordinator` 返回对象键集合 vs HEAD | 35 → 35，**一个不多一个不少** |
| **no-undef / no-unused-vars** | 对我改过的 28 个 JS 文件逐个过（项目 lint 覆盖不到的也过） | 抓到 4 处死引用，已清 |
| **项目自带 lint** | `npm run lint:agent` | 修完只剩 4 条告警，全在我没碰过的文件（既有问题） |

#### 抓到的 bug（已修）

| # | 严重度 | 问题 | 怎么发现的 |
|---|---|---|---|
| 1 | **高（运行时报错）** | `src/headless/desktop-turn.js` 调 `resolveAgentMaxRounds(runSettings)`，但文件顶部**没 import 它** —— 无界面 desktop 轮次在没有显式 `maxRounds` 时会 `ReferenceError: resolveAgentMaxRounds is not defined` | `no-undef` 扫描。`tsc` 的 `tsconfig.check.json` 不含这个文件、`lint:agent` 也不覆盖 `src/headless/`，所以两套静态闸门都放过了 |
| 2 | 中（死代码） | `src/agent/main-turn-runner.js` 留下两个不再使用的 import：`clampModelRuntimeValue`（换成 `resolveAgentMaxRounds` 后失效）、`unpackMessageMeta`（换成 `completionHistoryHelpers()` 后失效） | `npm run lint:agent` |
| 3 | 低（死代码） | `src/gateway/handlers/fs.js` 的 `globViaRemoteExec` 解构不再使用（glob 改走适配器）；`src/gateway/handlers/lsp-workspace.js` 的 `ctx` 解构不再使用（4 处改读 `resolveCallWorkspaceTarget`） | `no-unused-vars` 扫描 |
| 4 | 低（整洁） | `src/agent/session-context.js` 的 `module.exports` 里留下 3 个空行（第 0 批删 3 个死导出时的切片残留） | 读 diff 时发现 |

顺带做的一处去重：`fs.grep` 里远端与本地两条参数列表原本逐字段重复，改成共用 `...ctxArgs`（少一处「加字段只改一边」的隐患）。

#### 一处需要说明的行为变化（不是 bug）

计划执行器的模型解析并进 `resolveTurnModel` 后，**「既没绑路由也没绑模型」时的报错文案**从
「计划未绑定模型，且没有可用的默认模型：请在「定时任务 → 编辑」里选择模型，或在「模型设置」中启用一个供应商模型」
变成主循环那句「没有可用的默认模型，请在「模型设置」里启用一个供应商模型」。仍然是 `userSafe`、仍然指向设置页，但**少了「定时任务 → 编辑」这个更近的入口**。若要保留那句，得让 `resolveTurnModel` 接受错误文案覆盖 —— 那属于「为一句文案加参数」，暂不做。

#### 查过但确认没问题的（免得下轮重复怀疑）

- `META_STRING_MAX` / `GOAL_CONTINUE_USER_PREFIX` / `isAliveStateUserContent` 从 `session-context` 的导出里删了，但**定义与内部使用都在**，且 `agent-bundle-entry.js` 的 compat 清单没列它们 → 不影响 `window.*`；
- `repoRemotePathOf` 从 `ssh/remote-run-worktree.js` 的**转手再导出**里删了，真正的单一来源 `ssh/remote-worktree.js:68` 仍在导出，20 个调用方全部 require 的是后者；
- `isLegacyBuiltinEmbeddingEntry` / `normalizeEmbeddingEntry` 从 `model-settings.js` 的导出里删了，但已由 `agent/model-settings-embedding.js` 导出，且 bundle 注册的是后者；
- `bindGridPagination` / `isSkillEnabled` / `computeLineDiffStats` / `pauseAgentForToolLimit` / `raceToolStall` / `sniffVisionImageMime` 都仍有权威定义（删掉的只是重复声明或过期导出）；
- `shouldDefaultEnableSkillId` 全仓已无定义、也无调用 —— 那是**用户自己的**技能分类改动（用 `skill.defaultEnabled` 取代内建 id 白名单），只有 `src/skills/taxonomy.js:64` 的一句注释还提到它（注释待更新，不是 bug）；
- `isChannelDownError`（`rpc.js`）在 `remote-agent-client.js:35` 有定义并导出，`rpc.js` 的引用有效。

#### 仍未覆盖的（诚实记账）

- 没有真机/真 SSH 的手工验证：`peer` 的四刀只在进程内两机 mesh 测试里验证；`fs.grep/glob` 的 SFTP 分支只有单测假对象；
- `cargo test`/`clippy` 这轮没重跑（Rust 侧这轮只碰过第 0 批的 `purge_stale_files` 与 `walk_defs`，且 `cargo` 结果记录在 §8.8 之前那一轮）；
- `npx vitest run` / `test:agent --require-core` 在修完上述 4 处后各重跑了一遍（见下）。

### 8.15 验证（本轮最终状态）

| 闸门 | 结果 |
|---|---|
| `npm run check:js` | 通过 |
| `npm run check:renderer` | 通过（零调用点 / 同名覆盖两条规则 OK） |
| `npm run check:contracts` | 通过（CODEMAP 新增 `src/agent/knowledge/` 的 pathRule） |
| `npm run verify:tool-validators` / `verify:rpc-catalog` / `check:shared-constants` | 通过 |
| `npx vitest run` | **249 文件 / 2412 用例通过，2 skipped** |
| `npm run test:knowledge-maintainer` / `test:project-memory-file` / `test:system-prompt-prep` | 通过（三套都直接读设置段） |
| `npm run test:tool-args` / `test:agent-limits` / `test:planner-e2e` / `test:headless` / `test:local-gateway-smoke` / `test:phase5-handlers` | 通过 |
| `npm run test:agent`（CI 同一套，58 步） | 通过：`[dieyun:test] OK` |
| `cargo test --workspace --lib` / `cargo clippy -D warnings` | 357 通过 / 通过 |

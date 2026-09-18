# Agent 层双宿主（UMD）清理 Plan

> 目标：消除 `src/agent/*.js` 的「一份文件两种宿主」模式，把**模块解析从运行时搬到构建期**，
> 使 agent 层成为单一模块格式（CJS），renderer 侧经**唯一适配入口 + 既有命名空间**获得 API。

## 1. 问题（已实证）

### 1.1 现状

`src/renderer/index.html` 直接以 `<script>` 加载 15 个 agent 层文件，靠「脚本顺序 + 全局变量」通信：

```
1949 model-runtime-presets.js    1956 guardrails-shared.js     2005 run-events.js
1950 model-runtime-schema.js     1957 tool-catalog.js          2006 session-transcript.js
1951 agent-limits.js             1958 tool-classify.js         2007 session-context.js
1952 task-tier.js                1959 agent-round-text.js      2008 agent-system-prompt.js
1953 agent-limits-by-tier.js     1960 agent-guardrails.js(r)   2009 reviewer-json.js
1954 model-runtime-by-tier.js
1955 renderer-context-engine.js(r)  ← 依赖 1951，顺序被写进注释当契约
```

同时 Main/Node 侧 15+ 文件、40+ 处 `require('../agent/xxx')` 使用同一批文件。

### 1.2 五种双宿主写法并存

| # | 模式 | 文件 |
|---|------|------|
| V1 | `(function(global){…})(window\|\|globalThis)` + `Object.assign(global,api)` | `model-runtime-presets`、`model-runtime-schema`、`model-runtime-by-tier`、`agent-limits-by-tier` |
| V2 | 裸脚本 + `if(typeof window!=='undefined'){const w=window; w.X=…}` | `agent-limits`、`task-tier`、`agent-system-prompt`、`guardrails-shared` |
| V3 | 裸脚本 + 逐个 `window.X = …` | `session-context`、`reviewer-json` |
| V4 | 裸脚本 + 仅 `module.exports` | `session-transcript`、`run-events` |
| V5 | `(function(root,factory){…})(globalThis\|\|this,factory)` + `root.DieyunXxx=` | `tool-catalog`、`tool-classify` |

### 1.3 三重兜底与副本（6 处）

`model-runtime-by-tier`(4)、`agent-limits-by-tier`(4，另抄 9 档位数组)、`agent-limits:745-760`、
`guardrails-shared:236-247`、`session-context:3-11`、`model-runtime-schema:13`，形如：
「先查全局 → 再 `try{require}` → 再返回**硬编码副本**」。

副本当前**行为与正本一致（已实测未漂移）**，但无机制保证，且风格已分叉（`globalThis` vs `global`）。

### 1.4 打包只是字符串拼接

`scripts/build-renderer-bundle.cjs` 用 `esbuild.transform`（仅 minify），**不是 `bundle`**。
产物里 `require('./model-runtime-presets')` 仍是字面 `require` → 浏览器 ReferenceError → 照样进 catch。
且 esbuild **未声明为依赖**（`package.json` 无），`--minify` 实际空转。

### 1.5 全局污染（实测）

`node -e "require('./src/agent/model-runtime-presets')"` 向 **Node 全局对象**写入 5 个键；13 个文件同款尾部。
→ Main 侧「是否命中全局分支」取决于进程加载历史，①② 边界被全局状态模糊。

## 2. 目标 / 非目标

**目标**：① agent 层纯 CJS（无 UMD / 无 `window.X=` / 无运行时 `require` 探测 / 无副本）；
② renderer 只经**一个**构建期产物取 API，并注册进既有 `DieyunNamespaces`；③ 产物无字面 `require(`；④ dev 与 packaged 同构。

**非目标**：不改 Main 40+ 处 `require`；不重写 renderer 100+ 调用点（由 `compat` 承接，Step 4 渐进迁移）；
不动 Rust / Gateway / Mobile。

## 3. 目标架构

```
src/agent/*.js                            纯 CJS（module.exports = api）
  ├─ Main:        require('./agent/x')     不变
  └─ Browser:     构建期由 esbuild 打包
src/renderer/agent/agent-bundle-entry.js  新增：唯一适配入口（只注册，无业务规则）
src/renderer/dist/agent-bundle.js         产物（gitignored，IIFE，无 require）
```

`agent-bundle-entry.js` 调 `DieyunNamespaces.register(name, exports, { compat })`；
`compat` 把键**镜像回 `window.*`**（`namespaces.js:49-62`），故 100+ 调用点零改动。

## 4. Step 1：agent 层转纯 CJS

| 变换 | 说明 |
|------|------|
| **a 去包装** | 删 V1/V5 的 IIFE，改顶层 `'use strict';` |
| **b 删导出** | 删 `Object.assign(global,api)` / `window.X=…` / `root.DieyunXxx=`；保留 `module.exports` |
| **c 替兜底** | 三层兜底 → 顶层 `const {…} = require('./真源')`；**删所有硬编码副本** |
| **d 归一环境** | `global.` → `globalThis.`；**保留** `typeof window/globalThis!=='undefined'` 能力守卫（`localStorage`/`dispatchEvent`） |

**关键简化**：bundle 后 `globalThis === window`，能力守卫（`localStorage`/`dispatchEvent`）**无需注入改造**，Node 下自然跳过 → 行为自动保持。

### 4.1 S1-e：Node-only 依赖（**实测新增，原 plan 漏项**）

`agent-limits.js` 是**裸脚本**且内含 Node-only 磁盘 I/O，`esbuild --platform=browser` 静态解析会失败：

| 位置 | 依赖 | 说明 |
|------|------|------|
| `agent-limits.js:716` | `require('path').isAbsolute` | 已有 try/catch 兜底 |
| `agent-limits.js:905,910,916,959,960` | `fs` / `path` | 磁盘 I/O（`*ByTierFromDisk` / `save*ToDisk`） |
| `agent-limits.js:1033` | `require('../model-settings')` | 间接牵入 `electron` + `src/codebase/local-embedding` |
| `agent-limits.js:1034,1039` | `require('./model-runtime-by-tier')` | 同上 |

实测：对 15 个文件干跑，**6 个失败**（根因 1 个，其余为级联）。

**解法（已实测可行）**：在 `agent-limits.js` 顶部加一个**自包含**的间接 require
（**不引入新文件**，避免顶层 `require('./node-only')` 在「裸脚本阶段」直接打断 renderer）：

```js
/** Node-only 依赖入口：浏览器下为抛错桩，避免 esbuild 静态解析 fs/path/electron。 */
const nodeRequire = typeof require === 'function' ? require : function () { throw new Error('node-only dependency'); };
```

各处改为 `nodeRequire('path')` / `nodeRequire('fs')` / `nodeRequire('../model-settings')`：

- Node：`nodeRequire === require`，行为**完全不变**。
- 裸脚本（无 `require`）：`typeof` 守卫安全，退化为抛错桩 → 与今日 `catch` 分支同效。
- browser bundle：esbuild 转为 `__require`，仅在被调用时抛错；上述函数**只在 Node 路径被调用**
  （`resolveContextTierIdForNode` 等未出现在 window 导出清单中）→ 实为死代码。

**范围**：15 个文件中**只有 `agent-limits.js`** 含 Node-only 依赖。其余 `fs`/`path`/`os` 命中都在
`tool-telemetry`、`host-sidecar`、`tool-output-spill`、`subagent-store` 等**不在本次范围**的 Main 专用文件。

**注**：更彻底的做法是把磁盘 I/O 整体拆到 `agent-limits-node.js`（Main 专用），
但会牵动 Main 多处调用点，列为 Step 1.5 可选后续。

### 4.2 window 导出 ≠ module.exports（另一处漏项）

`agent-limits.js:1079-1080` 额外挂了两个**不在 `agentLimitsApi` 中**的全局：

```js
w.CHARS_PER_TOKEN = AGENT_LIMITS_DEFAULTS.charsPerToken;
w.CJK_CHARS_PER_TOKEN = AGENT_LIMITS_DEFAULTS.cjkCharsPerToken;
```

Step 2 的 `compat` 列表必须**额外**包含这两个键（由 entry 显式补上）。
其余文件同理：**以 window 导出块为准，而非 `module.exports`**。

需镜像回 window 的键（供 Step 2 的 `compat` 用）：

| 文件 | compat 键 |
|------|-----------|
| `model-runtime-presets` | `MODEL_RUNTIME_PRESETS` `MODEL_RUNTIME_DEFAULTS` `getModelRuntimePresetById` `remapLegacyContextTierId` `foldLegacyContextTierRecord` `LEGACY_CONTEXT_TIER_ALIASES` |
| `model-runtime-schema` | `CONTEXT_WINDOW_MAX` `MODEL_RUNTIME_SCHEMA` `formatModelRuntimeValue` `MODEL_RUNTIME_DEFAULTS` |
| `agent-limits` | `AGENT_LIMITS_DEFAULTS` `normalizeAgentLimits` `getAgentLimits` `resolveContextTierIdForNode` `resolveLoopToolCallLimit` `resolveAgentLoopSpec` `scaleLimitForLongHorizon` `applyLongHorizonGuardrails` `LONG_HORIZON_GUARDRAIL_SCALE` …（全量） |
| `agent-limits-by-tier` | 全量 11 键 |
| `model-runtime-by-tier` | `inferContextTierFromModelName` `inferContextWindowFromModelName` `resolveModelContextWindowFromSettings` `normalizeContextTierId` …（全量） |
| `task-tier` | `formatTaskTierSystemBlock` `isTaskTierFeatureEnabled` … |
| `guardrails-shared` | `GuardrailsShared`（整对象；`agent-guardrails.js:4` 读裸名并 throw） |
| `tool-catalog` | `DieyunToolCatalog` |
| `tool-classify` | `DieyunToolClassify` |
| `agent-round-text` | `AgentRoundText` |
| `run-events` | 全量 |
| `session-transcript` | `transcriptFromMessages` `TRANSCRIPT_ROLES` |
| `session-context` | 20+ 键（`persistableAssistantText` `buildCompletionMessages` `buildSessionChatHistoryBlock` …） |
| `agent-system-prompt` | `formatSystemTimeChunk` `assembleSystemPrompt` `agentSystemPromptApi` |
| `reviewer-json` | `closeTruncatedJson` `extractReviewerJson` `inferReviewerFromPartial` `collectReviewerFileDiffs` |

**验收**：`npm run test:agent-limits` 必须**原样通过**（全程 `require`，不依赖全局）；
且 15 个文件的 `esbuild --platform=browser` 干跑**全部 OK**。

## 5. Step 2：唯一适配入口

新增 `src/renderer/agent/agent-bundle-entry.js`：

```js
'use strict';
// 全仓唯一把 agent 层 API 交给 renderer 的地方。只做注册，零业务规则。
const { register } = window.DieyunNamespaces;
const limits   = require('../../agent/agent-limits');
const presets  = require('../../agent/model-runtime-presets');
// … 其余 13 个
register('DieyunAgentLimits',    limits,                  { compat: [...] });
register('DieyunModelRuntime',   { ...presets, ...schema, ...byTier }, { compat: [...] });
register('DieyunAgentPrompt',    systemPrompt,            { compat: [...] });
// …
```

**必须同时**把 `core/namespaces.js` 提到 agent bundle **之前**加载（当前在 1962，晚于 1949）。

## 6. Step 3：构建期 bundle

1. 新增 `scripts/build-agent-bundle.cjs`：
   ```js
   await esbuild.build({ entryPoints: ['src/renderer/agent/agent-bundle-entry.js'],
     bundle: true, format: 'iife', platform: 'browser', target: ['chrome120'],
     outfile: 'src/renderer/dist/agent-bundle.js', sourcemap: minify ? false : 'inline',
     minify, legalComments: 'none' });
   ```
2. `esbuild` 写入 `devDependencies`（现装 0.28.2，仅靠传递依赖不可靠）。
3. `build-renderer-bundle.cjs`：把 `./dist/agent-bundle.js` 加入 **skip 集**（不参与 concat），
   并在 `generateBundledHtml` 中**显式保留**该 tag（置于 `./dist/bundle.js` 之前）。
4. `index.html`：删除 1949~1959 与 2005~2009 共 **15 个** `../agent/*.js` tag，
   在 **1949 位置**插入 `<script src="./dist/agent-bundle.js"></script>`。
   （1955/1960 的 renderer 文件依赖由 bundle 提前满足，比今日更安全。）
5. `bootstrap.cjs` 追加调用 `build-agent-bundle.cjs`，使 `npm run dev` 也有产物。
6. `check-renderer-globals.py`：跳过 `./dist/` 前缀（否则新克隆无产物时报 `MISSING` 并 fail）。

## 7. Step 4：调用点迁移（可分文件批次，可延后）

`compat` 已保证零改动可用；本步是**收敛命名空间**的渐进清理：

- 目标：`renderer-model-runtime.js`(28 处)、`renderer-model-settings.js`(12)、`renderer-context-engine.js`(8)、
  `renderer-attachments.js`(5)、`renderer-agent-tools.js`(5)、`renderer-encoding-params.js`(5) 等 28 文件。
- 每次把裸名改为 `DieyunNamespaces.get('Xxx')`（或直接读 `window.DieyunModelRuntime.*`）。
- `check-renderer-critical.py` 的 `CRITICAL` 裸名列表可随之逐步清空。

## 8. 风险与回滚

| 风险 | 缓解 |
|------|------|
| agent 依赖闭包含 Node 内置模块 → bundle 失败 | Step 0 预检 `esbuild` 干跑；实测 15 文件闭包仅互相引用，无 `fs/os/path` |
| esbuild 未声明导致新环境失败 | 写入 `devDependencies` |
| dev 未构建产物 → 白屏 | `bootstrap.cjs` 接入；`index.html` 仅保留 bundle tag |
| 顺序契约被破坏 | bundle 在 1949 提前满足全部依赖 |
| 回滚 | 单 commit；`DIEYUN_LEGACY_RENDERER_SCRIPTS=1` 通道仍可用（`window-tray.js:17-23`） |

## 9. 验证清单

```
npm run test:agent-limits     # 纯 CJS 后必须原样通过
npm run check:renderer        # 全局重复声明 + 关键符号
npm run test:agent            # agent smoke
npm run build:renderer:dev && node --check src/renderer/dist/bundle.js
node -e "…"                   # 断言 agent-bundle.js 内不含字面 require(
```

## 10. 执行顺序

**改为「始终可运行」的增量顺序**（每步可单独验证、可回滚）：

| 步 | 内容 | 验证 |
|----|------|------|
| **S0** | 预检：基线测试 + 15 文件 esbuild 干跑 | `test:agent-limits` 绿；干跑暴露 6 个失败 |
| **S1-e** | `agent-limits.js` 的 Node-only 依赖改间接 | 15 文件干跑**全 OK** |
| **S2+S3** | entry + build 脚本 + `index.html` 换 bundle（**agent 文件暂不动**） | `check:renderer`；产物 window 键集合与今日**逐一比对** |
| **S1** | 去 UMD/IIFE、删 window 导出块，改由 entry `compat` 承担 | `test:agent-limits` + `check:renderer` + 键比对仍一致 |
| **S4** | 调用点渐进迁移命名空间 | `check:renderer-critical` |

**顺序理由**：先做 S2+S3 时 agent 文件仍是 UMD，bundle 执行后 `window` 键集合与今日**完全一致**，
可用「产物键比对」做零行为变化证明，再动 Step 1 —— 比反过来安全得多。

> 原约束「Step 1 与 Step 3 必须同批」仍然成立，但被上表拆成了可验证的两半：
> 先让 bundle 接管（键集合不变），再拆 IIFE（`compat` 顶上）。

---

## 11. 执行记录（已完成）

**状态：S0 / S1-e / S2+S3 / S1 已完成；S4 未执行（见 11.4）。**

### 11.1 改动清单

| 区域 | 改动 |
|------|------|
| `src/agent/*.js`（15 个） | 全部转纯 CJS：删 V1/V5 IIFE 外壳、删 `window.*=` / `Object.assign(global, api)` / `root.DieyunXxx=` 导出块、删「全局 → 运行期 require → 硬编码副本」三层兜底，改顶层 `require` 真源 |
| `src/agent/agent-limits.js` | 顶部新增 `nodeRequire` 间接入口（S1-e），`fs`/`path`/`../model-settings` 改走它；`tierGlobalFn(...)` 4 处改为惰性 `limitsByTierModule().X`；仅保留 renderer 专属跨层钩子 `crossLayerGlobalFn('resolveContextTierId')` |
| `src/renderer/agent/agent-bundle-entry.js` | 唯一适配入口：按 index.html 原顺序 `require` 15 个模块并 `DieyunNamespaces.register`，用 `compat` 镜像回 `window.*` |
| `scripts/build-agent-bundle.cjs` | esbuild `bundle:true` + `format:iife` + `platform:browser`，产物 `src/renderer/dist/agent-bundle.js` |
| `src/renderer/index.html` | 删 15 个 `../agent/*.js` tag，改为 `./core/namespaces.js` + `./dist/agent-bundle.js`（namespaces 必须在 bundle 之前） |
| `scripts/build-renderer-bundle.cjs` | `PREBUILT_SCRIPTS` 增加 `./core/namespaces.js`（不参与 concat、原位保留 tag），否则 bundled 模式下 bundle.js 会晚于 agent-bundle 定义 `DieyunNamespaces` |
| `scripts/bootstrap.cjs` | 追加 agent bundle 构建；`npm run dev` 也有产物 |
| `scripts/check-renderer-globals.py` | 跳过 `./dist/` 前缀 |
| `package.json` / `package-lock.json` | `esbuild` 写入 `devDependencies` |

### 11.2 执行中发现、plan 未覆盖的点

1. **`tierGlobalFn` 遗留**：`agent-limits.js` 原有 4 处 `tierGlobalFn('getLimitsForTier' | 'setLimitsForTier' | 'resetLimitsForTier' | 'getAllLimitsByTier')` 依赖了改造前 V1 文件对 `globalThis` 的污染。已改为惰性 `limitsByTierModule().X`，语义由「看进程加载历史」变为确定。
2. **`CHARS_PER_TOKEN` / `CJK_CHARS_PER_TOKEN`**（plan §4.2 已预判）：二者不在 `module.exports`，entry 用 `{...limits, CHARS_PER_TOKEN, CJK_CHARS_PER_TOKEN}` 显式补。
3. **键名 ≠ 导出名**：`window.AgentRoundText` / `window.GuardrailsShared` 是「整对象」导出（导出对象里没有同名键），entry 同样用 `{...api, AgentRoundText: api}` / `{...api, GuardrailsShared: api}` 承接。
4. **`tool-catalog` / `tool-classify` 走 `globalThis`**（V5）：原始基线抓取脚本只记录 `window`，故当时记为 `added: []`；真实浏览器里 `globalThis === window`，基线已补上 `DieyunToolCatalog` / `DieyunToolClassify`，最终键数 **97 → 99**。
5. **bundled 模式顺序**：`build-renderer-bundle.cjs` 会把所有非 prebuilt 脚本 concat 进 `dist/bundle.js`（在 body 末尾）。`core/namespaces.js` 若不单独保留 tag，就会晚于 `agent-bundle.js` 定义，dev/打包行为分叉 → 已加入 `PREBUILT_SCRIPTS`。

### 11.3 验证证据（全部通过）

```
npm run test:agent-limits      # ok（纯 CJS 后原样通过）
npm run test:agent             # OK（含 lint:agent 0 error、check:js、check:renderer）
npm run build:renderer:dev     # 102 scripts -> dist/bundle.js，index.bundled.html 顺序为
                               # 1949 core/namespaces.js -> 1951 dist/agent-bundle.js -> 2054 dist/bundle.js
npm run check:renderer         # 无重复声明；26 critical symbols；9 namespace exports；5 bootstrap domains
npm run check:contracts        # OK
node scripts/build-agent-bundle.cjs
```

产物契约比对（vm 沙箱按 index.html 顺序执行 `core/namespaces.js` → `dist/agent-bundle.js`）：

- `window` 契约键 **99 / 99 一致（missing 0, extra 0）**；命名空间容器键（`DieyunAgentLimits` 等 13 个）不计入契约。
- 产物内**无字面 `require(`**。
- 形状抽检：`DieyunToolCatalog.RENDERER_ONLY_TOOLS`、`DieyunToolClassify.isMutatingAgentTool`、`AgentRoundText.pickNormalizedAssistantReply`、`GuardrailsShared.MUTATING_TOOL_NAMES`、`assembleSystemPrompt`、`STORAGE_KEY` 均按预期可达。

契约的**版本控制真源**是 `src/renderer/agent/agent-bundle-entry.js` 的各 `compat` 数组（共 99 键）；
`window` 契约键清单 = 这些 compat 数组的并集，回归时直接与之比对即可。临时抓取脚本与基线快照已按 §7 要求清理。

### 11.4 Step 4（调用点迁移）状态：**未执行**

`compat` 已保证 renderer 侧 100+ 裸名调用点零改动可用，本步只是收敛命名空间、让 `check-renderer-critical.py` 的 `CRITICAL` 裸名列表可逐步清空，属纯风格收益。

未在本批执行的原因：
- 需迁移的键里有 `getAgentLimits`、`normalizeContextTierId`、`STORAGE_KEY` 等高重名风险标识符，无法用机械 codemod 全仓替换，必须逐文件人工核对（本地函数/对象字面量键/`/* global */` 注释/`window.X =` 赋值都要排除）。
- 与 `AGENTS.md`「最小 diff、不顺手重构、不扩 scope」冲突；plan §7 已写明「可分文件批次，可延后」。

后续分批建议（每批一个文件，改完跑 `npm run check:renderer` + `npm run test:renderer`）：
1. `renderer-model-runtime.js`（28 处）
2. `renderer-model-settings.js`（12 处）
3. `renderer-context-engine.js`（8 处）
4. `renderer-attachments.js` / `renderer-agent-tools.js` / `renderer-encoding-params.js`（各 5 处）
5. 其余文件与新出现的裸名

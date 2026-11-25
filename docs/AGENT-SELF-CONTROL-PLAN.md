# 模型对「自己」的控制：缺漏整改方案

> 范围：**只处理自控面的非安全缺口** —— 模型看不清自己的能力事实（A）、能力申请没有闭环（B）、
> 自修改没有回执（C）、自主性缺配额与收口（D）、自检拿不到事实（E）、两处一致性口子（F）。
>
> **不含**：沙箱判定的收紧、凭据存放、路径白名单、审批策略语义。那些属于安全面，另一条线处理，
> 本方案里任何一条都不得改变它们的判定结果。
>
> 依据：`docs/AGENT-DEV.md` 的「减法优先 / 单一来源 / 数字进 agent-limits / schema 进 catalog /
> 关卡只改清单」五条纪律。每一节都写明「为什么删不掉、为什么不能并入既有单一来源」。
>
> **实施状态**：S1–S6 已实施（2026-11-22）。落地时的偏差与验证结果见 §12。

---

## 0. 结论

六项改动（S1–S6）、五个新文件（都是**把已存在但散落的事实收成一份**，不是新机制）：

| 落点 | 性质 | 谁消费 |
|---|---|---|
| `src/agent/capability-index.js`（新） | 能力表：能力 → 权限键 / 工具名 / 设置落点 / 申请文案 | prompt 块、`agent_inspect`、`agent_capability` |
| `src/agent/workspace-candidates.js`（新） | 候选匹配纯函数（从 `channels/workspace-switch.js` 抽出） | 频道切换、桌面切换、测试 |
| `src/agent/change-receipt.js`（新） | 改动回执形状 + 单一追加日志 | 所有配置类工具 |
| `src/agent/catalog/self.js`（新） | `agent_inspect` / `agent_capability` 两个 schema | Main 工具桥 |
| `src/agent/main-tools/self.js`（新） | 上面两个工具的执行体 | `main-tools/index.js` |

为什么不能并入既有文件：
- 能力表现在**隐含在** `renderer-tool-defs.js:171-215` 的一串 `if (host.osControl) tools.push(...)` 里，
  prompt / 自检 / 申请三处都需要同一份映射，不抽出来就必然出现第二份（历史上 `web_search`
  在工具表里、白名单里没有，就是这类漂移）。
- 候选匹配现在**只有**频道那一份（`channels/workspace-switch.js:74-92`），桌面路径没有；
  抽成纯函数才能两侧共用，而不是复制。
- 改动回执现在**没有载体**：`tool-telemetry.jsonl` 是「每次工具调用」的口径，塞配置 diff 会让
  成功率统计失真（同样的理由，compaction 遥测当年也是单开一条流，见 `compaction-telemetry.js:10`）。

---

## 1. S1 能力事实块：让模型看见「这一轮我能做什么、什么关着」（对应 A1 / A2）

### 问题
- `agent-system-prompt.js:118-146` 的 `formatPermissionsChunk` 只列**已开启**的能力；
  沙箱档位、真实可写根、有没有审批通道，一个字都没有。
- `formatWorkspaceChunk:108-110` 写「本机可读写范围另含：用户主目录与系统临时目录」——
  在 `workspace-write` / `read-only` 下主目录并不整片可写（可写根见 `server.js:536-548`）。
- 权限关掉的工具**直接不注入**（`renderer-tool-defs.js:171-215`），模型分不清
  「没有这个能力」和「有但用户关着」。

### 改法
1. 新建 `src/agent/capability-index.js`：**能力表唯一来源**。

```js
// 形状（示意）
const CAPABILITIES = [
  { key: 'fsRead',     label: '读文件',            tools: ['fs_read_file', 'grep', 'glob', 'read_symbol', 'lsp'] },
  { key: 'fsWrite',    label: '写文件',            tools: ['fs_write_file', 'fs_edit'] },
  { key: 'shellExec',  label: '执行 Shell',        tools: ['host_exec', 'host_proc'] },
  { key: 'browser',    label: '浏览器',            tools: ['browser_navigate', '…'] },
  { key: 'webFetch',   label: '联网抓取',          tools: ['web_fetch', 'web_search'] },
  { key: 'osControl',  label: '电脑控制（截屏/键鼠）', tools: ['computer'],  request: { anchor: 'perm-os-control' } },
  { key: 'camera',     label: '手机摄像头',        tools: ['camera_look'],   request: { anchor: 'perm-camera' } },
  { key: 'desktopCamera', label: '本机摄像头',     tools: ['desktop_camera_look', 'desktop_camera_ptz'], request: { anchor: 'perm-desktop-camera' } },
  { key: 'peer',       label: '内网互通',          tools: ['peer_send', 'peer_claim'], request: { modal: 'peer' } },
  { key: 'plannerMultiAgent', label: '多路并行执行', tools: ['fan_out'], request: { param: 'plannerMultiAgentEnabled' } }
];
```

导出（三个，别多）：
- `CAPABILITIES` / `CAPABILITY_BY_KEY`
- `enabledCapabilities(permissions)` → `{ on: [...], off: [...] }`（只读，纯函数）
- `formatCapabilityBlock({ permissions, sandboxState })` → 文本块（下方格式）

2. `agent-system-prompt.js`
- `formatPermissionsChunk` → 换成 `formatCapabilityBlock`（实现在 `capability-index`），
  `assembleSystemPrompt` 的 stableChunks 里替换原来的那一项（**不要两块并存**）。
- 删掉 `formatWorkspaceChunk` 的 `localExtra` 那句（可写根由 S1 的块负责说，不再各写一份）。
- 同步改 `test/unit/sandbox-remote-scope-prompt.test.cjs:12`（唯一引用点）。

3. `src/agent/system-prompt-prep-main.js`：新增一个依赖（**唯一装配点**，IPC / 频道 / headless
   三条路都从这里取，见文件头注释）：

```js
getSandboxState: async () => {
  try { return await gateway.invokeRpc('permissions.sandbox_state', {}); } catch { return null; }
}
```

`system-prompt-prep.js` 在 `assembleSystemPrompt({...})`（`1303` 起）里把 `sandboxState` 传下去；
取不到就不出「可写根」这一行（不要编）。

Renderer 兜底路径（`renderer-agent-system-message.js:433`，Main 的
`agent:prep-system-prompt` 不可用时的降级装配）不传 `permissions` → 该块为空，行为与今天一致，
不需要为它单独补一份数据（补了就是第二份来源）。

### 输出格式（定版，改动只改这一处）

```
【本轮能力事实】
沙箱：工作区内可写（越界需用户当场确认）
可写根：E:\work\proj、C:\Users\me\AppData\Roaming\dieyunagent、%TEMP%
已开：读文件、写文件、执行 Shell、浏览器、联网抓取
关着（这些能力不会出现在工具表里）：电脑控制、手机摄像头、本机摄像头、内网互通、多路并行执行
```

- 「关着」只在非空时出现；没有可写根时不写这一行。
- 全文 ≤ 8 行、无数字上限需求（名字是有限枚举）。
- **不写**「某工具为什么不出现」这种逐工具解释 —— 只给能力级名单。

### 验收
- `npx vitest run test/unit/capability-block.test.cjs`（新增：三档 × 开关组合，断言「关着」那行）
- `npx vitest run test/unit/sandbox-remote-scope-prompt.test.cjs`
- `npm run check:js`

---

## 2. S2 自省工具：`agent_inspect`（对应 A3 / E1 / E2）

### 问题
`permissions.sandbox_state`（`gateway/handlers/permissions.js:21`）已经把档位 + 真实可写根 +
已批准位置算好了，但只给设置页；遥测摘要 `summarizeTelemetry` 只经 IPC 进「帮助」面板
（`main/ipc/agent-runtime.js:748`）。模型想知道「我为什么老失败」只能猜文件路径。

### 改法
- 新 `src/agent/catalog/self.js`：`AGENT_INSPECT_TOOL`（`name: 'agent_inspect'`，无参数）
- 新 `src/agent/main-tools/self.js`：`createSelfHandlers(shared)`，在 `main-tools/index.js` 注册
- 依赖全部由 `shared` 传入（现有 `getAgentLimits` / `userDataPath` / `gateway` 已有；
  新增 `summarizeTelemetry` 一项，取 `require('../../agent/tool-telemetry').summarizeTelemetry`）

返回**只有事实**，无判定、无建议：

```js
{
  ok: true,
  sandbox: { mode, writableRoots: [], grantedPaths: [], remoteGoverned },
  capabilities: { on: ['fsRead', …], off: ['camera', …] },
  limits: {
    // 本轮真正生效的循环预算：resolveAgentLoopSpec(settings, userDataPath, tierId)
    loop: { maxRounds, maxToolCalls },
    // 其余从 getAgentLimits(userDataPath, tierId) 取，键名与 agent-limits 一致
    subagent: { maxRounds, maxToolCalls },
    goal: { maxAttempts, maxWallMs }
  },
  telemetry: { window, successRate, repeatBlocks, retries, topErrors: [{errorCode, count}], byTool: [{tool, total, failed}][:5] },
  note: '以上是当前生效的事实；要改其中任何一项，用 agent_capability（S3）或对应设置页。'
}
```

约束（写进代码注释）：
- **不是** `agent_status` 状态机：没有 phase、没有「该不该继续」、不计入 tool-gate 关卡顺序；
- 只读：不写盘、不改配置；
- 预算数字**一律**取现成解析器：循环 `resolveAgentLoopSpec`、其余 `getAgentLimits(userDataPath, ctx.contextTierId)`，
  不留第二份缺省、不自己算 `maxRounds`。

### 工具表要登记两处（既有约束，本方案不合并）
新增工具的装配点现在有两份，缺一处就是「桌面能调、频道调不到」（或反之）：
- 聊天/桌面：`src/renderer/renderer-tool-defs.js`（`tools.push(AGENT_INSPECT_TOOL)`）；
- 计划 / 频道 / headless / peer 来信轮：`src/agent/catalog/groups.js` 的
  `PLAN_RUNTIME_TOOL_NAMES`（`main-agent-tools.js:26` 就是按它派生）。
`agent_inspect` 与 `agent_capability` **两处都要加**：自检与「我能做什么」在任何档位都有意义；
申请在无 UI 时退化成 `list` + 落点文案（S3）。
（把这两份装配合并成一份属于另一个改造，不在本方案范围。）

### 验收
- `npm run verify:tool-validators`（新 schema → 重新生成 `tool-validate.generated.js`）
- `node scripts/test-tool-bridge-handlers.cjs`（加一条：字段形状 + 无副作用）
- `npx vitest run test/unit/session-tool-catalog.test.cjs`（已有断言会覆盖 `PLAN_RUNTIME_TOOL_NAMES`，
  加工具后要顺手核对）
- `npm run test:tool-args`

---

## 3. S3 能力申请：一条通道 + 一张表（对应 B1 / B2 / B3）

### 问题
`sandbox-policy` 之外，只有 `mcp_manage.action=request_credential` 是完整闭环
（模型发起 → 用户填 → `action=list` 复查 `configured`，见 `mcp/manage.js:230-260`）。
摄像头 / 键鼠 / 互通 / 多路并行 / 档位都没有对应动作；桌面以外连 `agent_clarify` 都没有
（`catalog/groups.js:88` 的 `RENDERER_ONLY_TOOLS`）。

### 改法
1. `capability-index.js` 的每条能力补 `request` 字段（**唯一文案来源**）：
   `{ anchor: 'perm-camera' }` / `{ modal: 'peer' }` / `{ param: 'plannerMultiAgentEnabled' }` /
   `{ page: 'sandbox' }`。渲染层只认这三种落点描述符，不认能力名。
2. 新工具 `agent_capability`（`catalog/self.js`，执行体在 `main-tools/self.js`；
   工具表两处登记同 S2）：
   - `action: 'request'` + `kind`（能力 key）+ 可选 `reason` → 把请求送到界面，返回
     `{ ok, delivered, kind, howToEnable, verifyWith: 'agent_capability:list' }`；
   - `action: 'list'` → `{ capabilities: [{key, label, on, tools, howToEnable}] }`（闭环复查用）。
   - 无 UI（频道 / headless）时返回 `CAPABILITY_UI_UNAVAILABLE` + `howToEnable` 文本，
     **不假装成功**（照 `mcp_manage` 的 `MCP_CREDENTIAL_UI_UNAVAILABLE` 先例）。
3. 事件通道统一为 `agent:capability-request`：
   - `main-tools/mcp.js:121-128` 的 `mcp:credential-request` 迁过来，`kind: 'mcpCredential'`
     （`capability-index` 里也登记这一条，`request: { page: 'skills', tab: 'mcp' }`）；
   - `preload.js:213-217` 的 `onMcpCredentialRequest` → `onCapabilityRequest`（回调形状加 `kind`）；
   - `renderer-skills-ui.js:948` 的监听改为按 `kind` 分派：`mcpCredential` 走原弹窗，
     其余按落点 `switchSettingsPage(page)` + `scrollIntoView` 高亮 + toast。
4. 频道 / headless 不新写装配：`webContents` 不存在时 `canNotify=false` 的分支已经存在，
   沿用（`main-tools/mcp.js:121`）。
5. 网页替身：`headless/desktop-ui.js` 的 shim 是按 preload 手抄的一套接口（`94` 行注释写明），
   要么补一个同名 `onCapabilityRequest`（照 `peer:event` 的订阅形态），要么保持缺省 ——
   缺省时渲染器里的 `typeof … === 'function'` 守卫会让它静默不弹，此时工具返回
   `CAPABILITY_UI_UNAVAILABLE` 并把落点写进 `howToEnable`，模型照样能说清「去哪个页面打开」。
   推荐先补 shim（网页版也有设置页，补了才闭环），但它是**可选项**，不阻塞本批。

### 验收
- `npx vitest run test/unit/capability-request.test.cjs`（新增：无 UI 分支、落点描述符分发）
- `npm run check:renderer`（`switchSettingsPage` / 新全局方法进白名单）
- `node scripts/test-tool-bridge-handlers.cjs`

---

## 4. S4 改动回执 + 计划可改可停 + 技能可改（对应 C2 / C3 / C4）

### 4.1 改动回执 `src/agent/change-receipt.js`（新）
```js
// 形状唯一，调用点只填字段
makeReceipt({ target, before, after, effectiveFrom, verifyWith })
// → { target, before:{hash,chars}, after:{hash,chars}, effectiveFrom, verifyWith, at }
```
- `hash` 复用 `agents-md.js#contentHash`（已在用）；**不存全文**（日志会爆）。
- 追加日志：`<userData>/self-changes.jsonl`，走 `logs/rotating-file-log`（与 `tool-telemetry` 同闸门）。
- 调用点（结果里加 `change` 字段，一处形状）：
  `mcp_manage`、`skill_create`、`skill_delete`、`skill_update`（本轮新增）、
  `agents_md_propose`、`plan_create` / `plan_update` / `plan_set_enabled` / `plan_delete`、
  `session_set_workspace`（渲染器侧：`applySessionWorkspaceFromTool` 返回里带 `effectiveFrom: 'next-round'`）。
- **纠正**：`agents_md_propose` 默认是 `prefs.preview === true` → 写 `.dieyun/agents-pending.json` 并等
  用户采纳（`propose-tools-main.js:140-160`、`agents-md-prefs.js:8-10`），不是直写。本方案**不改它的语义**，
  只在结果里补 `change`（`effectiveFrom: 'user-accept'`）。

### 4.2 计划可改可停（C4）
- `catalog/plan.js` 增两件：
  - `plan_update`：`id` + 可选 `name/prompt/description/rrule/onceAt/goal/skillIds/todos/workspace`；
  - `plan_set_enabled`：`id` + `enabled`（**「停用但保留事实」的唯一形态** —— 现在只能删）。
- `main-tools/plans.js`：
  - `plan_update` 必须 **get 后合并** 再 `store.upsert()`：`normalizePlan` 会把缺省字段填默认，
    直接 upsert 会把 `evidence/attempt/outcome` 以外的东西冲掉（`store.js:168-206` 已保住运行态，
    但普通字段仍需合并）；
  - 改完 `scheduler.reload()`（`scheduler.js:49`）让新规则立即上钟；
  - 结果带 `change`（4.1）。
- `plan_delete` 描述里「让用户去面板停用」的那句改成指向 `plan_set_enabled`。

### 4.3 技能可改（C3）
- `agent-home.js` 增 `updateUserSkill(userData, workspacePath, { dir, name, description, content })`：
  - 目录校验复用 `deleteUserSkill` 的同一套（`filterAccessibleSkillRoots` + 目录里确有 `SKILL.md`），
    不另写一份判定；
  - 保留原 `skillKey`（同目录，不重命名目录）；
  - 返回 `{ dir, skillPath, before, after }` 供回执。
- `catalog/memory.js` 增 `skill_update`（`dir` 必填，其余可选）；`main-tools/skills.js` 加 handler。
- 顺带说明：`createUserSkill` 同名会派生 `name-1`（`agent-home.js:279-283`）—— 有了 `skill_update`，
  模型不必再「重建」技能，这个坑从入口上就绕开了（不改 create 的行为）。

### 验收
- `npx vitest run test/unit/plans-store.test.cjs test/unit/plans-scheduler.test.cjs`（加 update/setEnabled 用例）
- `npx vitest run test/unit/change-receipt.test.cjs`（新增）
- `node scripts/test-tool-bridge-handlers.cjs`
- `npm run verify:tool-validators` + `npm run test:tool-args`（新 schema，含 `plan_update` 的条件必填时
  规则要进 `allOf`/`if-then`，**不要**写进手写校验）
- `npm run test:agent`

---

## 5. S5 自主计划配额与频次事实（对应 D1 / D3）

### 问题
`FREQ=MINUTELY;INTERVAL=1` 合法（`catalog/plan.js:52-56`、`plans/parser.js:13`），计划条数无上限
（`plans/store.js` 只裁「已完成目标」的保留量）。`alive` 有心跳日额度、目标有轮次/墙钟预算 ——
只有自主计划这一档没有上限。

### 改法
1. `agent-limits.js` DEFAULTS（`plansIdlePollMs` 那一段附近）加**一个**数字：
   `plansMaxCount: 50`（机制预算，**不进** `AGENT_LIMITS_SCHEMA`，理由同
   `defaultWorkspaceGc*` 那一类：这是防无界增长的机制上限，不是给人调的旋钮）。
2. `plans/store.js#upsert`：新建（`idx < 0`）且 `this.plans.length >= plansMaxCount` 时抛
   `code:'PLANS_LIMIT'` 的结构化错误，文案给「先 plan_list 删旧的」。
3. `main-tools/plans.js#plan_create` 回执补频次事实（**用 `rrule-next` 算，不另写解析**）：
   `schedule: { nextAt, intervalMs, runsPerDay | '不定时' }`，让模型/用户在开口前就能自评。

### 明确不做
- **不做**「最小间隔夹取」：静默把用户写的 `MINUTELY` 改成 5 分钟，等于代码替用户改规则
  （与「代码不判定意图」同一条纪律冲突）。要挡就用条数上限 + 频次事实。
- **不做** `goal_pause` 之类的新工具：「停一下」已经有两个出口 —— `goal_finish(blocked)` 收尾，
  或 `plan_set_enabled(false)` 停掉目标型计划（S4.2）。

### 验收
- `npx vitest run test/unit/plans-store.test.cjs test/unit/plans-rrule-next.test.cjs`
- `npm run test:agent-limits`

---

## 6. S6 工作空间候选：一处实现，两侧共用（对应 F1）

### 问题
同一个 `session_set_workspace`：频道侧有候选清单 + 目录名匹配 + 歧义提示
（`channels/workspace-switch.js:47-87`），桌面侧 `applyLocalWorkspacePath` 只判空
（`renderer-workspace-ssh.js:724-746`），模型在桌面只能猜路径。

### 改法
1. 新建 `src/agent/workspace-candidates.js`：把 `normalizePathKey` / `baseNameOf` /
   `matchCandidate` / `candidateText` 四个纯函数**整体搬出**，`channels/workspace-switch.js`
   改为 require（其导出的同名函数继续 re-export，避免测试与调用点改动）。
2. `src/renderer/agent/agent-bundle-entry.js`：注册 `DieyunWorkspaceCandidates`
   （compat: 四个名字），Renderer 侧从 `window` 取，不复制实现。
3. `renderer-workspace-ssh.js#applySessionWorkspaceFromTool`：
   - 候选 = 当前视图路径 + 本机会话列表里的 `workspaceProjectPath`（`renderer-chat-history.js:216`
     已经在用同一字段）；收候选/匹配/文案都走 `workspace-candidates.js`（与频道同一份）；
   - 绝对路径 → 走原流程（**不收紧**：模型仍然可以指到一个从没打开过的目录，那是合法能力）；
   - 只给目录名 → 按 `matchCandidate` 匹配：唯一才切，歧义返回候选，没命中返回候选；
   - 空参数 → 只返回候选清单（以前只回一句「当前是 X」，模型拿不到可选项目）；
   - **不做存在性校验**（为什么见 §9「未纳入」：桌面侧没有 stat 通道，且要改 Gateway 的失败模式）。
4. 「切换是用户点选」这条不变：本改动只让**模型说得出候选、说得清歧义**，不新增自动切换，
   也不引入候选白名单（候选只是「猜错时的兜底信息」）。

### 验收
- `npx vitest run test/unit/channels-workspace-switch.test.cjs`（回归，函数搬家后应零差异）
- `npx vitest run test/unit/renderer-session-workspace-tool.test.cjs`（补三条：唯一 / 歧义 / 未命中）
- `npm run check:renderer` + `npm run check:js`

---

## 7. 批次与合并顺序

| 批 | 内容 | 依赖 | 建议验证 |
|---|---|---|---|
| 1 | S1 能力事实块 + S6 候选一致性 | 无 | `test:unit` 子集 + `check:js` + `check:renderer` |
| 2 | S2 `agent_inspect` | 批 1 的 `capability-index` | `verify:tool-validators` + `test:tool-args` + handlers |
| 3 | S4 回执 / 计划 / 技能 | 无（可与批 2 并行） | `plans-*` 单测 + `test:agent` |
| 4 | S3 能力申请（依赖 S2 的 `list` 复查） | 批 2 | `check:renderer` + handlers |
| 5 | S5 计划配额 | 批 3（同文件） | `plans-store` + `test:agent-limits` |

全量闸门（每批合入前）：`npm run test:unit`、`npm run check:js`、`npm run verify:tool-validators`；
涉及 `src/agent` 或 `src/gateway` 再跑 `npm run test:agent`（有 core 时 `npm run test:agent-full`）。

---

## 8. 负向清单（本方案明确不做的）

1. **不把能力表再抄一份**进 `renderer-tool-defs.js`：工具注入继续按开关分支，但**权限键 → 工具名**
   的映射从 `capability-index` 取（`CAPABILITY_BY_KEY`），不新增第二份 if 链。
2. **不给 `agent_inspect` 加判定 / 建议 / 状态机**：它只回事实；「该不该继续 / 该不该收尾」永远在模型。
3. **不用关键词或启发式**判断「该不该申请能力 / 该不该建计划」：入口是工具，判定在模型。
4. **不在 plans 里加退避表、最小间隔夹取、分时段配额**：那是拿规则换预算，会自己长出策略层。
5. **不把改动回执写进 `tool-telemetry.jsonl`**：口径是「每次工具调用的成败」，混入配置 diff 会让
   成功率失真；也不把 AGENTS.md / SKILL.md 全文写进日志（只存 hash + 字符数）。
6. **不让能力申请在无 UI 时假装成功**：返回 `CAPABILITY_UI_UNAVAILABLE` + 落点文案。
7. **不新增 `agent_status` 类聚合状态**（`AGENTS.md` 第 5 条已禁）；自检只回既有事实。
8. **不改沙箱判定、不碰审批策略语义**：S1 只是把判定结果**读出来**显示，不改 `decideFsWrite/decideShellCommand`。

---

## 9. 未纳入（附再评估条件）

| 项 | 为什么先不做 | 什么时候再做 |
|---|---|---|
| 对端能力事实（F2：`peer_list` 只有身份，没有「对面能写吗」） | 要改线协议 `peer/wire.js` 的 `from` 形状并做版本兼容，属于跨机契约 | 出现「按对端能力分派任务」的真实需求；最小形态 `from.caps = { sandboxMode, readOnly }`，未知一律当未知 |
| 本机多会话互见（F3：同机两个会话改同一仓库没有等价信号） | 语义未定：建议式租约 vs 硬锁；且与 worktree 隔离方案重叠 | 先定语义（建议式，照 `peer/leases.js` 的做法），再复用同一份租约实现 |
| 后台轮次（计划 / 频道）是否允许「弹设置页」申请 | 现在**允许**（桌面窗口存在即发事件）—— 与既有 `mcp_manage.request_credential` 的行为一致；真要区分得把 `runSource` 下到工具 ctx（10 处装配） | 出现「后台计划半夜顶掉用户正在看的设置页」的真实投诉时再做，届时只加一个 `ctx.runSource` 白名单 |
| 本地目录存在性校验（模型给了一个打错的绝对路径时立刻知道） | 桌面侧没有拿得出手的 stat 通道（`fs.stat` 被读根白名单限住，恰好判不了「工作区之外的新目录」）；做在 `gateway.setLocalWorkspace` 里则要把失败模式从「静默切过去」改成「抛错」，IPC 与 headless 两处调用方和 UI 预期都得跟着改 | 先定「谁负责校验 + 失败怎么呈现」，再在 `gateway.setLocalWorkspace` 一处做（不要各入口各写一份） |
| 配置改动的 undo | undo 栈的作用域是「工作区文件」，配置在 userData，语义不同 | 先定「配置回滚 = 恢复哪一份快照」，再做；在此之前只做回执（4.1） |
| 模型的上下文自主权（主动压缩 / 钉住证据 / 清理） | 与 compaction 单点（Rust 折叠）冲突，另需一套协议 | 另立计划，先回答「模型怎么表达 pin」 |
| `skill_update` 之外的技能目录重命名 / 迁移 | 重命名会改 `skillKey`（启用状态键），影响面大 | 有真实需求时按「迁移 = 新建 + 删旧 + 迁启用位」做一次显式动作 |

---

## 10. 风险与回滚（合入前逐条确认）

| 改动 | 主要风险 | 规避 / 回滚 |
|---|---|---|
| S1 能力事实块 | 每轮多 ~120–200 字进 stable 块 | 进 stable 段（缓存友好）；超预算时只压「已开」这一行，**不做**事后裁剪（裁剪会造出第二份上限） |
| S2 / S3 新工具 | 工具表 +2 项（≈400 token schema） | 不进 planner worker / 只读子 Agent 白名单（那两档用不着）；出问题先摘 `PLAN_RUNTIME_TOOL_NAMES` 里的登记 |
| S4 `plan_update` | `normalizePlan` 会补默认值，直接 upsert 会冲掉未给字段 | 一律 `get(id)` → 浅合并 → `upsert`；单测要断言「只改 name 时 evidence/attempt/outcome/checks 不变」 |
| S4 schema 增改 | `tool-validate.generated.js` 过期 | 每批跑 `npm run verify:tool-validators`；条件必填只写进 `allOf`/`if-then` |
| S5 计划配额 | 存量已超 50 条的老用户 | 只在**新建**时判定；超限的存量仍可 `plan_update` / `plan_set_enabled` / 运行，不阻塞 |
| S6 函数搬家 | 频道切换行为漂移 | `channels-workspace-switch.test.cjs` 必须零差异通过；`workspace-switch.js` 继续 re-export 同名函数，调用点零改动 |

---

## 11. 落地附带（仓库惯例，别漏）

- `AGENTS.md`「改什么去哪」加三行（单一来源新增）：
  能力事实/能力申请 → `src/agent/capability-index.js`；
  工作空间候选匹配 → `src/agent/workspace-candidates.js`；
  自修改回执 → `src/agent/change-receipt.js`。
- `AGENTS.md` 文档索引 + `docs/AGENT-DEV.md` 速查各加一行指向本文件。
- `docs/CODEMAP.json` 补三个新模块条目（`check:contracts` 只查「指向的文件是否存在」，
  不查「新文件是否登记」，但索引是给人看的，不补就查不到）。
- **不新增 RPC、不新增事件类型**：`permissions.sandbox_state` 与 `summarizeTelemetry` 都是现成的；
  所以 `docs/rpc-catalog.md` 与 `docs/agent-run-events.md` 不需要重新生成。
- 工具相关：新增三个 schema（`agent_inspect` / `agent_capability` / `plan_update` / `plan_set_enabled` /
  `skill_update`）→ 必须 `npm run generate:tool-validators` 并把产物一起提交；
  若给 `plan_update` 写了条件必填，`npm run test:tool-args` 的双跑夹具要一起加。

---

## 12. 实施记录（2026-11-22）

### 落地形态（与本文档的差异，按实现为准）

| 项 | 实际落地 |
|---|---|
| S1 | `formatPermissionsChunk` 整体换成 `capability-index#formatCapabilityBlock`（不保留旧名，唯一引用点 `test/unit/sandbox-remote-scope-prompt.test.cjs` 已同步）；工作空间块里那句「主目录与临时目录可读写」改成「能用绝对路径，能不能写见能力事实」；`getSandboxState` 的投影函数 `projectSandboxState` 放在 `capability-index`（系统提示与自检共用）。 |
| S2 | `agent_inspect` 落在 `catalog/self.js` + `main-tools/self.js`；**并进 `PLAN_RUNTIME_TOOL_NAMES`** —— 计划 / 频道 / headless / peer 来信这四档没有设置页，最需要自检。 |
| S3 | 通道统一为 `agent:capability-request`（`mcp_manage.request_credential` 也走它，`kind:'mcpCredential'`）；preload 的 `onMcpCredentialRequest` 改为 `onCapabilityRequest`，分发在 `renderer-skills-ui.js`（原有弹窗就住在那儿）。**无 UI 时落点文案走 `suggestedFix`** —— 失败信封只保 `error` / `errorCode` / `suggestedFix` / `retryable`，`howToEnable` 会被收窄掉。 |
| S4 | `agents_md_propose` **不改语义**（默认本来就是 `preview` → 用户采纳），只补 `change` 回执；`plan_update` 不允许「定时 ↔ 目标型」互切（`PLAN_MODE_FIXED`，换了验收面就该重建）；`skill_update` 复用 `deleteUserSkill` 的判定（扫描根内 + 非种子 + 确有 SKILL.md），只改正文/名称/简介，目录与 `skillKey` 不变。 |
| S5 | 只做 `plansMaxCount`（新建时判定，存量不锁）+ `plan_create` / `plan_update` 回执带 `schedule{nextAt,intervalMs,runsPerDay}`；**没做**最小间隔夹取（按 §5 的「明确不做」）。 |
| S6 | 去掉「绝对路径不存在 → 返回候选」那条（桌面侧没有可用 stat 通道，见 §9 未纳入）；实际行为：空参列候选、只给项目名按 `matchCandidate` 唯一匹配、绝对路径照切。 |

### 顺带修掉的一处闸门红

`docs/CODEMAP.json` 里 pet 模块的 `tests` 原写的是 `npx vitest run test/unit/pet-shapes.test.cjs`
（不是 npm script），`npm run check:contracts` 因此一直红；已改成 `test:unit`。
本次同时补了 `agent-self-control` 模块条目。

### 自查修掉的 bug（2026-11-22 复检）

| # | 现象 | 根因 | 修法 |
|---|---|---|---|
| 1 | `plan_update` 传 `workspace: ""`（描述里写着「改回跟随」）被判 `MISSING_ARG` | `schema-rules#present` 把空白串当「没给」，而 `workspace` 的空串是**有意义的空值** | `BLANK_OK` 加 `workspace`（+ 单测：`workspace:''` 通过、`name:'  '` 仍判缺） |
| 2 | 「只换一条检查命令」会把 `goal.cwd` 清掉 | `patch.goal = a.goal` 整体替换，schema 里 `cwd` 可选 | 合并 `{...cur.goal, ...a.goal}`（不给就沿用旧值；给了空串才清） |
| 3 | 空闲触发（`trigger:'idle'`）的计划被 `plan_update` 收下 `rrule` 后静默不生效 | 只挡了 `goal`，漏了 `idle` | 同样回 `PLAN_MODE_FIXED`，并说清「触发源是静默够久」 |
| 4 | `mcp_manage action=list` / `request_credential` / `check_update` / `repair_env` 也往 `self-changes.jsonl` 写「我改了配置」 | 回执无条件挂上 | 只对**真的改盘**的动作留回执（+ 单测三条） |
| 5 | 远端（SSH）会话的能力块会列出**本机**可写根，又同时说「本机档位不参与」 | `sandbox_state` 报的是本机档位的根；投影原样透传 | `projectSandboxState` 在 `remoteGoverned` 时清空 roots/granted，`formatCapabilityBlock` 再兜一道（+ 单测） |
| 6 | 技能「改/删」在界面上弹「技能已创建」 | `registerCreatedSkillInUi` 只认新建，`{updated}`/`{deleted}` 落到「没找到 → 已创建」分支 | 先按 `updated`/`deleted` 分支给正确提示（删的那条是既有 bug，顺带修） |
| 7 | `agent_inspect` 在还没有任何工具调用时给出 `successRate: 0`，读起来像「全在失败」 | 只报比率不报样本数 | 同报 `total / ok / failed` |
| 8 | `agent_capability` 的 `reason` 原样进界面 toast | 没截断 | 折空白 + 截 200 字 |
| 9 | 能力块里「这些能力**不在工具表里**」在弱模型 / 子 Agent 白名单下是假话 | 措辞把「关着」与「被裁剪」混为一谈 | 改成「现在用不了」 |

顺带：`plansMaxCount` 的错误文案改成对人也成立（设置页新建按钮会显示同一句）。

### 验证结果（全绿）

- `npm run test:unit` → 258 files / 2483 passed（2 skipped）
- `npm run test:agent` → OK（含 alive 68/68、`verify:tool-validators`、`test:tool-args` 62/62）
- `npm run check:js` / `npm run check:renderer` / `npm run check:contracts` → OK
- `npm run verify:tool-validators` → OK（84 个工具）
- `node scripts/test-tool-bridge-handlers.cjs` → OK（注册表 31 个，含新工具的形状与副作用断言）
- `npm run build:renderer:dev` → OK（bundle 含 `DieyunWorkspaceCandidates`）

### 新增测试

`test/unit/capability-block.test.cjs`、`test/unit/agent-inspect-tool.test.cjs`、
`test/unit/change-receipt.test.cjs`、`test/unit/skill-update.test.cjs`；
`test/unit/renderer-session-workspace-tool.test.cjs`（+4 例）、`test/unit/plans-rrule-next.test.cjs`（+4 例）、
`test/unit/plans-store.test.cjs`（+2 例）、`scripts/test-tool-bridge-handlers.cjs`（+5 组）。

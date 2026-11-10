---
name: full-test
description: dieyunagent 全量测试流水线：按安全顺序跑完本项目所有可执行的测试套件，产出「结论先行」的判定报告，并把每个失败分类为新回归 / 已知环境问题 / 超时预算。凡用户要求「测试所有功能」「全量测试」「跑一遍所有测试」「回归测试」「检查项目健康度」，或改了大片代码想整体验证，都用本 skill——即使用户没说"全量"两个字。
---

# dieyunagent 全量测试

目标：跑完本仓库全部可运行的测试，给出有没有回归的明确结论。两条铁律：**失败必须分类**（不许把已知问题当新回归，也不许拿已知问题掩盖新失败）；**重测试串行跑**（并行跑会互相抢 CPU/端口，把慢的拖成超时假失败）。

## 执行顺序（串行，总耗时约 30–45 分钟）

### 0. 前置盘点

```bash
ls build/dieyun-core/dieyun-core.exe && cargo --version   # sidecar 与 Rust 工具链
tasklist //FI "IMAGENAME eq dieyun-core.exe"              # 确认无残留进程
node -e "console.log(Object.keys(require('./package.json').scripts).filter(k=>k.startsWith('test:')||k.startsWith('check')||k.startsWith('verify')||k.startsWith('lint')).join('\n'))"
```

- 缺 sidecar → 先 `npm run pack:dieyun-core`；缺 Rust → 跳过 Rust 类套件并在报告注明原因，不要静默略过。
- 套件清单以 package.json 实际输出为准（会增删），不要凭记忆背。

### 1. `npm test`（按 git diff 选测）

直接跑。本机会在 `test:local-gateway-smoke` 的已知 FAIL 处**中断链**（见「已知问题基线」），这不是全盘失败：

1. 从输出解析 `[dieyun:test] running: a, b, c...` 拿到完整选中清单；
2. 对比已跑完的部分，把**没跑到**的选中套件用批量 runner（见下）补跑；
3. 中断点本身按基线规则判定。

### 2. 静态检查 + 单元测试（一个批次，快）

```bash
node .agents/skills/full-test/scripts/run-batch.cjs check:js lint:agent check:contracts verify:agent-events check:renderer test:unit
```

### 3. 其余 smoke 套件（每批 ≤12 个）

典型清单（以步骤 0 的实际清单为准；步骤 1/2 已跑过的不要重复计入报告）：

- 批 A：`test:phase5-handlers test:session-remote-transport test:agent-run-events test:guardrails-sync test:sandbox-smoke test:sandbox-policy test:sandbox-gateway test:tool-gate test:write-smell-hints test:session-context test:agent-system-prompt test:system-prompt-prep`
- 批 B：`test:monitor-outbox test:planner-parallel test:mcp-store test:app-updater-feeds test:ssh-reconnect-targets test:main-shell test:reviewer-json test:fs-edit test:delegate-batch test:dieyun-core-pack test:tool-bridge-delegate test:llm-reconnect-retry`
- 批 C：`test:mobile test:composer-queue test:task-tier test:agent-limits test:worktree test:scm test:llm-tool-call-fallback test:agent-round-text test:llm-channel test:request-snapshot test:remote-pack test:sandbox-real`
- 批 D（sidecar/Rust 链路 + 新模块）：`test:local-gateway-smoke test:workspace-remote-runtime test:core-bridge test:rust-loop-runner test:rust-planner-pipeline test:rust-agent-loop-smoke test:rust-planner-smoke test:lsp test:peer test:browser-smoke test:headless test:linux-deb-install`

批 C 自 2026-11-04 起补入：`test:mobile-camera test:session-handoff test:knowledge-maintainer test:project-memory-file`；批 A 补入 `test:tool-harness`；批 B 补入 `test:shortcuts`；静态批补入 `verify:rpc-catalog`。
2026-11-10 复核实测新增的可执行套件（共 84 个 npm 脚本，已全量跑过一遍，建议按同批位置归入）：批 A 加 `test:sandbox-approvals-late test:default-workspace-gc test:embedding-budget test:request-snapshot`；批 B 加 `test:llm-reconnect-retry`；批 C 加 `test:desktop-camera test:alive test:peer-mesh test:peer-tools test:headless-desktop-ui test:headless-desktop-turn`；批 D（产物校验）建议直接用：`verify:asar verify:headless-pack verify:headless-deb verify:headless-apt verify:mcp-bundled verify:bundled-skills verify:remote-pack`（0.1.78 产物实测全过）。

无界面 / 分发链路另有一档（产物已存在时可直接验，2026-11-04 实测三项全过）：`verify:headless-pack verify:headless-deb verify:headless-apt`（读 `dist/*.tgz|*.deb` 与 `release/headless-apt/pool`；无产物时先 `npm run build:headless`）。

默认跳过并单独注明：`test:rust-agent-loop`（需真实 LLM 配置）、聚合命令（`test:agent` / `test:agent-full`，与子套件重复）、build 验证类（`verify:asar` `verify:remote-pack` `verify:bundled-skills`，依赖打包产物）、`test:renderer`（即 check:renderer，已在静态批次覆盖）。

### 4. Rust 单测

```bash
cargo test -p dieyun-core
```

首次需编译测试二进制，可能 10 分钟以上——后台运行并轮询，勿前台死等。

### 5. embedding / 向量链路（特殊，永远单独跑）

脚本 `test:builtin-embedding-rust` 已在 v0.1.59 之后下线（package.json 里查不到，`npm run` 会直接报 missing script）。现在这一档改用仓库内的验收脚本：

- **功能验证（默认做这个）**：`node scripts/verify-vector-cache-reuse.cjs` —— 起一个假 embedding 端点 + 真实 core 进程，跑「库 A 首建 → 库 B 复用」，几秒到一分钟出结论，覆盖向量写入 / 签名 / 跨库复用 / 检索命中。期望：库 A `vectorsEmbedded>0, vectorsReused=0`；库 B `vectorsReused>0, vectorsEmbedded=0`；检索 `vectorSearch=true` 且 hits>0。
- **全仓耗时/召回复测**：`verify:index-timing-local` / `verify:index-timing-ssh` / `verify:index-effectiveness`（脚本在 `scripts/`，SSH 那条要真远端）。
- 仅当用户明确要验证**全仓真 embedding**时：把 `bridge.invoke('codebase.index', ..., 600000)` 的超时改大（如 3600000）后脱离运行（后台任务有 ~10 分钟上限），等 ~15 分钟看结果。
- 排障常识：嵌入阶段「CPU 跑满但索引库文件零增长」是设计使然（`embed_batches` 全算完才落盘），不是卡死；看到 code=143 先想是不是自己的 timeout 杀的。

## 批量 runner

```bash
node .agents/skills/full-test/scripts/run-batch.cjs [--timeout MS] suite1 suite2 ...
```

逐套件运行 `npm run -s <suite>`，单个失败不中断后续；失败自动单独重跑一次（端口/时序抖动常见）再定论；超时默认 10 分钟并 taskkill 整棵进程树。输出 `PASS/FAIL(code) <suite>`，FAIL 附最后几行日志，结尾给通过数汇总。

## 已知问题基线（截至 2026-11-02，本机）

判定规则：FAIL 的**签名**（失败信息 + 通过项数量）与基线一致 → 已知问题，报告标「非回归」；签名不同、通过项变少、或出现新 FAIL → 按新回归排查。基线会过时——每次全量测试后核对，状态变了就更新本节，并同步 auto-memory 对应条目。

1. **（已失效）test:builtin-embedding-rust 全仓超时**：该脚本自 v0.1.59 后已从 package.json 下线，本项不再适用于任何一次运行；向量链路按步骤 5 改用 `verify-vector-cache-reuse.cjs`（2026-11-02 实测：库 A embedded=3/reused=0，库 B reused=3/embedded=0，检索 3 命中）。
2. 历史项 test:local-gateway-smoke 白名单 FAIL（`关闭开关后白名单未收窄`）已于 2026-09-21、2026-10-24 连续两轮 PASS，按规则移出基线；若该签名再现，重新立案排查。
3. **test:lsp 在 Electron 宿主下必假 FAIL**：签名 = `Error: npx child keeps default env`（scripts/test-lsp.cjs:116，断言 `childEnvForCommand('npx').ELECTRON_RUN_AS_NODE == null`）。根因是宿主（DSH / 任何以 `ELECTRON_RUN_AS_NODE=1` 启动的 shell）把该变量注入 `process.env`，被测函数对非 `process.execPath` 命令**原样返回 process.env**，断言因此不成立。排除法：同一命令加 `Remove-Item Env:ELECTRON_RUN_AS_NODE` 后 `test-lsp.cjs ok` → 环境问题非回归。
4. 环境前提备忘：宿主全局 gitconfig 已于 2026-10-24 配好 user.name/email（此前缺失曾致 test:scm 场景 5 失败）。test:scm 已改为临时仓库自配身份（scripts/test-scm-service.cjs），不依赖宿主配置，换了机器也稳；其他新建临时 git 仓库做提交的测试若报 GIT_IDENTITY_MISSING，同法自配。
5. **（已失效，2026-11-04 复测全绿）test:unit 的 `lsp-watch-batch.test.cjs › 排空时按单批上限切片`（2026-11-03 立案）**：提交 6a0b156「watch 空批次心跳降级到 debug 通道」之后 test:unit 全绿（196 files / 1890 passed / 2 skipped），按规则移出基线，签名再现再重新立案。以下为当时记录：签名 = `Error: Test timed out in 5000ms`（用例内 `waitUntil(..., 8000)` > vitest 默认 5000，所以报超时而非断言失败），伴随 `Test Files 1 failed | 176 passed`、`Tests 1 failed | 1741 passed`。根因：`src/lsp/diagnostics-service.js` 把 drain 汇总行改成 `withDiagnostics > 0 || failed ? log : logDebug`，而测试只注入 `log`（空批次心跳走 `logDebug`）→ 汇总行永远进不了 `logs`。功能本身正常（30 个假文件 866ms 排空完）。修法：测试改为收集 `logDebug` 并给用例显式超时，或撤回降级。**签名一致时按已知问题记，但它是真实待修项，别当环境噪声放过。**
6. **verify:index-timing-local 的 C 断言（2026-11-03 立案，既有口径缺陷）**：签名 = 仅 `✗ C 同库重建应全部复用（新算 0）`，C 行 `复用 N / 新算 N`，其余 7 条断言全过，端点调用数不增加。根因：`index/mod.rs` 的 `vectors_embedded = COALESCE(?10, workspaces.vectors_embedded)` 只在有 miss 时写值，同库 force 重建全部命中缓存时写 `None` → 保留上一轮数字。core 自己的单测用新库（旧值本就 0）测不出。判定时别误判为「真在重算」。另：`verify:asar` 报 `renderer bundle is older than index.html` 时先 `npm run build:renderer`（产物过期，非回归）；`verify:remote-pack` 报 `缺少 X` 时同理先重跑打包。
7. **缺少远端 / 会话上下文即必 FAIL 的验收器（2026-11-05 立案，2026-11-10 补 index-effectiveness）**：`verify:remote-agent-socket` / `verify:remote-agent-fs` 签名 = `需要 DY_SSH_HOST 与 DY_WS_BASE`（exit 2，本机无可用远端时必现）。`verify:index-effectiveness` 签名 = `✗ 需要 DY_SESSION=<会话 id>`（作用域只认会话，脚本不拼 workspaceRoot，exit 1）。这些都是环境前提而非回归：要么按变量接一台真远端 / 传 DY_SESSION 再跑，要么在报告里注明「未覆盖」，不要当新 FAIL 排查。同类：`verify:index-timing-ssh` 需真远端（exit 2）。
   附 2026-11-05 全量复核：第 3 项（test:lsp 宿主注入 `ELECTRON_RUN_AS_NODE`）与第 6 项（index-timing C 断言）签名与上述完全一致，均确认仍在；第 2、5 项无再现。

## 报告格式

结论先行，第一句给总判定（有没有回归）。示例骨架：

```
结论：没有功能回归——42 项全绿，2 项失败均已查实为环境/预算问题。

| 类别 | 结果 |          ← 按类别汇总 PASS（选测链 / 单测 / 静态 / smoke / Rust）
| ...  | ...  |

## 失败项（每个单列）
1. 现象 → 根因 → 分类（回归/已知/预算）→ 建议

## 本次改动相关          ← 用户新 diff 对应的测试单独点名（新改动是否安全）
```

用户要的是「能不能放心」的答案，不是流水账——砍掉不改变结论的细节，但每个 FAIL 的证据要留。

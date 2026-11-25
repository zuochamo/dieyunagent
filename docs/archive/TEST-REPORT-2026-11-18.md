# dieyunagent 全量测试报告（2026-11-18）

> 结论先行，逐项列证据。执行者：DSH 会话 root agent `lead`；被测工作区 `E:\dieyunagent`（分支 `main`，HEAD `469bf2f`，版本 `0.1.80`）。
> 执行依据：[`docs/TEST-PLAN-2026-11-18.md`](TEST-PLAN-2026-11-18.md)（13 模块 × 94 个入口，16 个串行批次）。
> 执行时间：2026-11-18 17:16–17:26（工作树 5 改 1 新：`src/plans/*`、`src/main/mcp-plans-boot.js`、`test/unit/plans-scheduler.test.cjs`、新增 `test/unit/plans-session.test.cjs`）。

---

## 0. 结论

**没有功能回归。** 94 个可执行入口中 **84 个首轮 PASS**、**5 个 FAIL**、**5 个按环境前提未覆盖**。5 个 FAIL 里 **2 个是真问题、已当场修掉并各留一条提交**（修后转绿 → 有效结论 **86 PASS / 3 未覆盖/未验**），另外 3 个是「本机没有 Linux 产物」的驱动问题，与代码无关。

三条要点：

1. **本次 plans 改动是绿的**：定向 10 个用例文件 **108 例全过**；`test:unit` 全量 **230 文件 / 2241 通过 / 2 跳过 / 0 失败**；静态契约 10 件全过（含 `check:contracts`、`verify:rpc-catalog`、`verify:core-contracts`）；`test:local-gateway-smoke` 绿（`memory.session_get` / `session_workspace_set` 真 core 链路）。
2. **5 个 FAIL 全部核对过签名，均非回归**；**其中两个真问题已在本轮顺手修掉并各留一条提交**：
   - `test:lsp`（基线 #3）：断言依赖「宿主 env 干净」→ 改成断言「非 `process.execPath` 命令原样传 env」，**提交 `e46c51a`**；现在带 `ELECTRON_RUN_AS_NODE=1` 也通过。
   - `verify:index-timing-local`（基线 #6，真缺陷）：全命中缓存时「新算 0」没写回库 → **提交 `db73cd18`**；C 行现在 `复用 240 / 新算 0`，8 条断言全过。
   - 剩余 3 个 `verify:headless-pack/deb/apt` 是本机无 Linux 产物驱动，代码无关，需在 Linux 构建机上验。
3. **原本会被记成「未覆盖」的 3 项产物校验被救回来了**：本机缺 `dist/win-unpacked` 时 `verify:asar` / `verify:remote-pack` / `verify:mcp-bundled` 必 FAIL；本轮直接跑 `npx electron-builder --dir --win` 造出解包目录后 **3 项全 PASS**，产物层从「未覆盖」变成「已验证」。

---

## 1. 汇总（按模块）

| 模块 | 入口数 | 结果 | 备注 |
|---|---|---|---|
| M1 Rust core（5 crate + 链路 + 向量） | 13 | **9 PASS / 1 已修→PASS / 3 未覆盖** | `cargo test --workspace --lib` 339 例全过；向量复用 PASS；`index-timing-local` = 基线 #6，本轮已修（`db73cd18`） |
| M2 Agent 循环 / 工具 / 护栏 / 规划 | 21 | **21 PASS** | 含 `tool-args` 双跑 62/62 一致 |
| M3 上下文 / 记忆 / 提示词 | 7 | **7 PASS** | 含折叠、快照、记忆提炼 |
| M4 计划 / 自动化（**本次改动**） | 0 专属（10 文件定向） | **108 例 PASS** | 见 §3 |
| M5 Gateway / RPC / 沙箱 | 8 | **8 PASS** | `local-gateway-smoke`、`sandbox-real` 均绿 |
| M6 Renderer / 桌面外壳 | 5 | **5 PASS** | `check:renderer`、CSP、快捷键 |
| M7 主进程服务 / 更新 / MCP / SCM / Worktree | 7 | **7 PASS** | `linux-deb-install` 纯逻辑层 |
| M8 SSH / 远端 / 工作区 | 5 | **3 PASS / 2 未覆盖** | 两个 `verify:remote-agent-*` 缺 `DY_SSH_HOST` |
| M9 移动端 / Headless | 8 | **5 PASS / 3 FAIL（缺产物）** | headless tgz/deb/apt 本机无产物 |
| M10 生命感 / 摄像头 / 浏览器 | 4 | **4 PASS** | 无硬件时走纯逻辑分支 |
| M11 内网互通 peer | 3 | **3 PASS** | 无跨机回合（需第二台机器） |
| M12 LSP | 1 | **1 已修→PASS（基线 #3）** | 断言改为环境无关（`e46c51a`） |
| M13 静态 / 契约 / 打包校验 | 10 | **10 PASS** | 含 `verify:asar`（造出 `win-unpacked` 后） |
| 全局单元层（`test:unit` / `test:remote-pack`） | 2 | **2 PASS** | `test:unit` = 230 文件 / 2241 例 |
| 全局选测链 `npm test`（复跑 `test:unit`） | — | **PASS** | 选中 `check:contracts` + `test:unit`，退出码 0 |

> 计数校验：13+21+7+0+8+5+7+5+8+4+3+1+10+2 = **94**。首轮 **84 PASS + 5 FAIL + 5 未覆盖**；两项修复落地并复验后为 **86 PASS + 3 FAIL（缺 Linux 产物）+ 5 未覆盖**。

---

## 2. 关键数字（可直接引用的证据）

| 项 | 实测 |
|---|---|
| `npm test`（diff 选测链） | 选中 `check:contracts` + `test:unit`；退出码 0；`Test Files 230 passed (230)` / `Tests 2241 passed \| 2 skipped (2243)` / 54.38s |
| `cargo test --workspace --lib` | base 80 + codebase 104 + core 0（shim）+ memory 59 + runtime 96 = **339 通过 / 0 失败**，`LASTEXITCODE=0` |
| plans 定向（B8） | 10 文件 **108 例全过**（`plans-goal` 44、`mcp-plans-boot` 13、`plans-parser` 12、`plans-rrule-next` 9、`plans-store` 7、`plans-idle-queue` 6、`plan-run-events` 6、`plans-session` 4、`plans-run-tool` 4、`plans-scheduler` 3），1.79s |
| 工具参数双跑一致性 | `[dualrun] 一致 62/62，差异 0` |
| 向量链路复用 | 库 A `向量 240 / 复用 0 / 新算 240`，库 B `复用 240 / 新算 0`，检索 `vectorSearch=true hits=3` |
| 批次通过情况 | B1 10/10、B2 4/4、B3+B4+B5 26/26、B6+B7 13/14、B9–B13 25/25、B14a 4/4（造产物后）、B15 1/1、B16 1/2 |

---

## 3. 本次改动相关（plans：判据收敛 + 幽灵 timer + 日志文案）

### 3.1 定向结果：全绿

```
✓ plans-session.test.cjs (4)   ✓ plans-scheduler.test.cjs (3)   ✓ plans-store (7)
✓ plans-run-tool (4)   ✓ plans-goal (44)   ✓ plans-idle-queue (6)
✓ plans-parser (12)   ✓ plans-rrule-next (9)   ✓ mcp-plans-boot (13)   ✓ plan-run-events (6)
Test Files 10 passed (10) | Tests 108 passed (108)
```

四条新断言（`plans-session`）= 归档另开且写回 `deliver`、**不调** `memory.session_archive`、已删除另开、工作空间变更只同步不重建；一条新断言（`plans-scheduler`）= 重复上钟只跑一次。

### 3.2 契约一致性核对（静态 + 真链路）

| 核对点 | 结论 | 证据 |
|---|---|---|
| `memory.session_get` 是否真返回 `archived` | **是** | Rust `SessionRow` 有该字段（`crates/dieyun-memory/src/memory/session.rs:163,172`）；`src/gateway/handlers/memory.js:145` 直通 core；`test:local-gateway-smoke` PASS |
| `Number(row.archived)` 对 boolean / 0-1 双形态成立 | **成立**（`false→0` 复用、`true→1` 重建） | 判据 `!Number(...)`；Rust 侧序列化为布尔，host 侧有 0/1 形态 |
| 工作空间同步走哪条 RPC | `memory.session_workspace_set` | `src/agent/session-workspace-bind.js:28`；新测试第 2 例断言参数正确 |
| 归档位不得被程序改写 | 未改写（测试显式断言无 archive 调用） | `plans-session` 第 3 例 |
| 与生命感心跳会话同口径 | 一致 | `src/main/alive-boot.js:187`：`row && row.id && !Number(row.archived)` |
| `_arm` 远期分支（`TIMER_MAX_MS`）递归自调用不会清掉新 timer | 安全 | `scheduler.js:71–78` 先 `timers.delete` 再 `_arm(fresh)` |
| `reload()` 逐个 `_arm` 不互相清 | 安全（按 `planId` 精确 `_disarm`） | `scheduler.js:42–55` |
| `running` 中再次到点不丢钟 | 安全（命中即重新上钟，且先 `_disarm`） | `scheduler.js:87–90` |

### 3.3 行为观测（L6）：本轮未做，留手工复核

自动化只能证「上钟去重 / 复用判据」，**证不了「真到点只跑一次、报告确实落到可见会话」**。建议手工复核（约 5 分钟，需起 app）：

1. 建 1–2 分钟后触发的计划 → 到点后日志同一计划**只有一条**起跑记录（若两条相隔 <100ms 即 #2 未生效）。
2. 侧栏归档该计划的专用会话 → 下次触发日志出现 `计划绑定会话已归档，已重建: <plan> (<old> → <new>)`，新会话在侧栏可见。
3. 删除该会话 → 同一日志应显示「已失联」。
4. 改计划工作空间 → 触发后**不**重建（`rebuilt=false`），只发 `session_workspace_set`。

---

## 4. 失败项（逐项：现象 → 根因 → 分类 → 建议）

### 4.1 `test:lsp` — FAIL(1)（**环境前提，基线 #3**）→ **已修复（`e46c51a`）**

- **现象**：`Error: npx child keeps default env` @ `scripts/test-lsp.cjs:116`（`assertServerSpecs`）→ `scripts/test-lsp.cjs:40`。
- **根因**：断言写的是「`npx` 子进程里**没有** `ELECTRON_RUN_AS_NODE`」，而 `childEnvForCommand` 对非 `process.execPath` 命令的契约是「**不改就原样传** `process.env`」。宿主（DSH / 任何以 `ELECTRON_RUN_AS_NODE=1` 启动的 shell）会把该变量注入 `process.env`，于是断言必假失败——**把真实 LSP 回归掩盖成「已知环境问题」才是真风险**。
- **排除验证**：`Remove-Item Env:ELECTRON_RUN_AS_NODE` 后重跑 → `test-lsp.cjs ok`（说明代码无问题）。
- **修法**：断言改为 `childEnvForCommand('npx') === process.env`（引用相等 = 原样传），不再依赖宿主环境；`process.execPath` 那条不变。
- **验证**：在**仍带** `ELECTRON_RUN_AS_NODE=1` 的本会话里 `npm run test:lsp` → 退出码 0、`test-lsp.cjs ok`；`check:js` / `lint:agent`（0 error）均过。

### 4.2 `verify:index-timing-local` — FAIL(1)（**已知缺陷，基线 #6**）→ **已修复（`db73cd18`）**

- **现象**：8 条断言中仅 `✗ C 同库重建应全部复用（新算 0）`；C 行 `复用 240 / 新算 240`；端点调用 `输入 241 条 / 请求 10 次`（未真的重算）。
- **根因**：`index/build.rs` 的 `vectors_embedded = COALESCE(?10, workspaces.vectors_embedded)` 只在有 miss 时写值；同库 force 重建全命中缓存时传 `None` → 保留上一轮的「新算 N」，面板/诊断一直报「新算 240」。
- **修法**：进入向量分支即写 `Some(0)`，命中后再被真实条数覆盖；`vectors=false` 的后台增量刷新仍不写（那一路必须保留上一次的复用/新算，是这两列存在的目的）。
- **红绿实测**：先 stash 掉修复 → 用例失败 `left: 999 / right: 0`（正是造出来的「旧值非 0」前置）；还原修复 → `cargo test --workspace --lib` **339 例全过**，`node scripts/verify-index-timing-local.cjs` **8/8 断言通过**（C 行 `复用 240 / 新算 0`，库大小 1160 KB 不变）。
- **附注**：`verify-index-timing-local` 默认吃 `target/release/dieyun-core.exe`，修完必须先 `cargo build -p dieyun-core --release` 再跑，否则读到的是旧二进制（本轮第一次复跑就踩了这个）。

### 4.3 `verify:headless-pack` / `verify:headless-deb` / `verify:headless-apt` — FAIL（**环境前提：缺产物**）

- **现象**：`E:\dieyunagent\dist 里没有 .tgz 产物（先跑 npm run pack:headless）`；`… 没有 .deb 产物（先跑 npm run pack:deb:headless）`；`[apt] 校验失败：…\release\headless-apt\pool\Packages 不存在`。
- **根因**：headless 产物需 Linux 侧 core（`pack:dieyun-core:linux` 走 zigbuild/远端），本机 Windows 无该工具链——`npm run build:dir` 在本轮实测即卡在 `pack:dieyun-core:linux 失败（exit 1）`。
- **结论**：非回归，未覆盖。**建议**：在 Linux 构建机跑 `npm run build:headless`（内部含 verify:deb / verify:pack / publish:apt / verify:apt）后再判。

### 4.4 本轮「先失败后被救回」的三项（过程记录，结论 PASS）

首次跑 `verify:asar` / `verify:remote-pack` / `verify:mcp-bundled` 时全部 FAIL，签名一致：`missing: E:\dieyunagent\dist\win-unpacked\resources\…`。补 `npx electron-builder --dir --win` 造出解包目录后重跑 → **4/4 PASS**。说明：这三项不是代码问题，是本机没打过包。

---

## 5. 未覆盖清单（含补齐条件）

| 入口 | 原因 | 补齐条件 |
|---|---|---|
| `test:rust-agent-loop` | 需真实 LLM 端点与额度 | 配好模型设置后 `npm run test:rust-agent-loop` |
| `verify:remote-agent-socket` / `verify:remote-agent-fs` | 缺 `DY_SSH_HOST` + `DY_WS_BASE`（基线 #7） | 接一台真远端后跑 |
| `verify:index-timing-ssh` | 需真远端 | 同上 |
| `verify:index-effectiveness` | 需 `DY_SESSION=<会话 id>` | 指定会话后跑（约 15 min） |
| `verify:headless-pack/deb/apt` | 需 Linux 构建机产物 | Linux 机 `npm run build:headless` |
| 真实 LLM 回合 / 跨机 peer / 摄像头·麦克风·云台硬件 / 界面真实点击流 / 计划真到点投递 | 无对应环境或自动化框架 | 见 §3.3 手工项与 §4.1 备注 |

---

## 6. 执行附注（可复现性）

- **sidecar**：`build/dieyun-core/dieyun-core.exe`（17,395,712 B，17:16 时间戳；执行期间被 17:16:37 起的一个 dev 实例重新落盘，未影响任何套件）。测试期间观察到 dev 实例在跑（electron PID 8640/14556/30300/42628 + core PID 26728）；所有套件用假 gateway / 临时目录，未出现端口或文件锁冲突。
- **为了产物校验新增的构建产物**（均在 gitignore 范围）：`dist/win-unpacked/`（electron-builder `--dir`），`src/renderer/dist/bundle.js` 与 `index.bundled.html`（`npm run build:renderer` 重新生成）。
- **副作用已回滚**：`verify:bundled-skills` 是生成器，跑它会改写 `skills/bundled/BUNDLED-MANIFEST.json` 的 `generatedAt`；已 `git checkout --` 还原，工作树与执行前一致（仅本次改动 + 本方案/报告两份文档）。
- **本轮的提交**（与 plans 改动分开，未混在一起）：
  - `e46c51a` test(lsp): 断言「非 execPath 命令原样传 env」，不依赖宿主环境是否干净
  - `db73cd18` fix(codebase): 全命中向量缓存时把「新算 0」写回库，别留上一轮的数字
- **注意**：`build/dieyun-core/dieyun-core.exe` 仍是旧二进制（执行期间有 dev 实例在用，未覆盖）。要跑依赖 sidecar 的套件请先 `npm run pack:dieyun-core`，或直接 `cargo build -p dieyun-core --release` 后把 `DIEYUN_CORE_BIN` 指过去。
- **串行策略**：全部经 `.agents/skills/full-test/scripts/run-batch.cjs`（逐套件、失败自动重跑一次、超时杀进程树）执行；两个无法避免的失败用单独命令复核以取得完整签名。

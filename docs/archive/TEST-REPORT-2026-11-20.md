# dieyunagent 全量测试报告（2026-11-20）

> 结论先行。执行者：DSH 会话 root agent `lead`；被测工作区 `E:\dieyunagent`（分支 `main`，HEAD `469bf2f` + 未提交改动 **140 个文件 / +6050 −1618**，版本 `0.1.84`）。
> 执行时间：2026-11-20 07:10–07:35。依据：[`.agents/skills/full-test/SKILL.md`](../../.agents/skills/full-test/SKILL.md)。

---

## 0. 结论

**没有功能回归 —— 93 个 npm 测试入口里 86 项 PASS，7 项因环境前提未覆盖（缺远端 / 缺 Linux 产物），0 项遗留失败。打包链路已实测：`npm run build`（NSIS）与 `npm run build:dir` 均 exit 0，产物三项校验全绿。**

首轮跑出 **4 个 FAIL 全是真问题**（不是环境噪声），已当场定位并修掉、逐项复验：

| # | 失败 | 性质 | 处置 |
|---|------|------|------|
| 1 | `cargo clippy -D warnings` 红（`EMBED_QUERY_TIMEOUT_MS as u64`） | 新代码 lint 闸门 | 删多余 cast，复跑 clippy `0 warning` |
| 2 | `test:unit` → `thinking-damped-flow › 追帧` `ReferenceError: SCROLL_DAMP_TAU_MS` | 重构后**夹具**没跟上（常量搬进 `renderer-constants.js`） | 夹具按真实加载顺序先求值常量表 |
| 3 | `test:request-snapshot` `'SYS' !== null` | 快照大字段改成**内容寻址去重**后，测试还在断旧语义 | 断言改为「hash 命中 blob ⇒ get 拼回全文」 |
| 4 | `test:peer-tools` / `test:peer` `preload 里应能扫到 peer:* 通道，实际 0` | preload / 网页替身改成从 `PEER_BRIDGE_METHODS` 派生，源码无 `invoke('peer:xxx'` 字面量 | 断言改为校验桥表契约（面板用到 ⊆ 桥表 / 两侧都从表派生） |

四个都是「实现往前走了、测试或 lint 没跟上」，**没有一条指向运行时行为坏了**：这四条修完之后，vitest 全量、cargo 两套特性、peer/snapshot 定向套件、clippy 全部复绿。

---

## 1. 汇总

| 类别 | 入口数 | 结果 | 证据 |
|------|--------|------|------|
| 选测链 `npm test`（按 git diff） | 1 | **PASS** | 选中 14 个套件（含 `test:peer`、`check:js`、`check:renderer`、`test:renderer-csp`），`[dieyun:test] OK` |
| 静态 / 契约（批 B1） | 11 | **11 PASS** | `check:js` / `lint:agent`（0 error、5 既有 warning）/ `check:contracts` / `check:shared-constants` / `verify:agent-events` / `verify:rpc-catalog` / `verify:tool-validators` / `verify:core-contracts` / `check:renderer` / `test:tool-args` / `test:unit` |
| 单元层 `test:unit` | 1 | **PASS**（修后） | **239 files / 2332 passed / 2 skipped / 0 failed**，56.7s |
| Agent / 护栏 / 提示（B2） | 17 | **17 PASS** | 含 `tool-gate`、`tool-harness`、`sandbox-*`、`renderer-csp`、`core-event-channel` |
| 主进程 / MCP / SCM / 委派（B3） | 15 | **15 PASS** | 含 `dieyun-core-pack`、`tool-bridge-delegate`、`tool-bridge-handlers`、`planner-workers`、`shortcuts` |
| 移动端 / 任务层 / 快照 / 沙箱（B4） | 12 | **12 PASS**（修后） | `test:request-snapshot` 修后 `OK rows=6 prunedLast=1 capA=2` |
| 生命感 / 摄像头 / peer / headless-UI（B5） | 12 | **12 PASS**（修后） | `test:peer` 全绿（含 `autoTrust` 四态）、`test:peer-tools`、`desktop-camera-ptz` |
| sidecar / Rust 链路（B6） | 13 | **13 PASS** | `local-gateway-smoke`、`core-bridge`、`rust-loop-runner`、`rust-agent-loop-smoke`、`rust-planner-smoke`、`planner-e2e`、`lsp`、`headless`、`linux-deb-install`、`remote-worktree-live` |
| 验收器（B7） | 13 | **6 PASS / 7 环境前提** | 见 §2 |
| Rust 单测（默认特性） | 1 | **PASS** | base 82 + codebase 104 + core 0（shim）+ memory 64 + runtime 107 = **357 passed / 0 failed** |
| Rust 单测（`--no-default-features`，远端 Linux 包口径） | 1 | **PASS** | 81 + 104 + 0 + 64 + 107 = **356 passed / 0 failed** |
| `cargo clippy --workspace --all-targets -- -D warnings` | 1 | **PASS**（修后） | `Finished dev profile` |
| 向量链路 | 2 | **PASS** | `verify:vector-cache-reuse`（库 A 首建 / 库 B 全复用）、`verify:index-timing-local`（C 行复用/新算断言） |
| 产物层：`npm run build:dir`（win dir） | 1 | **PASS** | exit 0；内置三项校验全绿 |
| 产物层：`npm run build`（win NSIS 安装包） | 1 | **PASS** | exit 0 → `dist/dieyunagent-Setup-0.1.84.exe` 159,551,272 B（08:24:49），内置 `verify:asar` / `verify:remote-pack` / `verify:mcp-bundled` 全绿 |
| 产物校验独立复跑 | 4 | **4 PASS** | `verify:asar`（523 JS 文件 + renderer bundle + monaco）、`verify:remote-pack`（core 14108 KB / remote-agent 0.1.84）、`verify:mcp-bundled`（mcp-postgres 0.1.10, sha256 3113fb06…）、`verify:bundled-skills` |

合计：**93 个 npm 入口 + 3 类 Rust 闸门 + 2 个打包目标；86 PASS，7 环境前提，0 遗留失败。**

---

## 2. 未覆盖项（环境前提，非回归）

| 项 | 签名 | 原因 | 补齐方式 |
|----|------|------|----------|
| `verify:index-timing-ssh` | `需要 DY_SSH_HOST 与 DY_WS`（exit 2） | 本机无可用远端 | 接一台真远端并设变量 |
| `verify:index-effectiveness` | `✗ 需要 DY_SESSION=<会话 id>`（exit 1） | 脚本作用域只认会话 | 传 `DY_SESSION` |
| `verify:remote-agent-socket` / `verify:remote-agent-fs` | `需要 DY_SSH_HOST 与 DY_WS_BASE`（exit 2） | 同上 | 建远端可写目录后跑 |
| `verify:headless-pack` / `-deb` / `-apt` | `dist 里没有 .tgz 产物` / `release/headless-apt/pool/Packages 不存在` | Windows 上跑不了 `pack:dieyun-core:linux`，本机无 Linux 产物 | 在 Linux 构建机跑 `npm run build:headless` |
| `test:rust-agent-loop` | — | 需真实 LLM 配置，按 skill 默认跳过（与 `rust-agent-loop-smoke` 重复度高） | 配好模型后单独跑 |

> ✅ **原先被占用挡住的三项已补验**：关闭桌面实例后 `npm run build:dir` 与 `npm run build` 都成功，`verify:asar` / `verify:remote-pack` / `verify:mcp-bundled` **3/3 PASS**（另加 `verify:bundled-skills`，独立复跑 4/4）。打包这一步本身也已过：`dist/dieyunagent-Setup-0.1.84.exe` 08:24:49 生成，只有代码签名未配置（`CSC_LINK` 缺 → SmartScreen 会拦，属预期）。

---

## 3. 本次改动相关（140 文件 diff 的定向结论）

改动面：`src/` 58 文件（+2255/−681）、`crates/dieyun-runtime` 15（+1437/−330）、`crates/dieyun-codebase` 7（+722/−433）、`crates/dieyun-memory` 6、`crates/dieyun-base` 6、测试 10 + 新增 10 个单测文件、scripts 8。

| 改动块 | 证据 |
|--------|------|
| 请求快照**内容寻址去重**（`snapshot_blobs` + 修剪清孤立 blob + 历史行回填） | Rust 单测 3 条（去重 / 不产生噪声 blob / 回填后读侧逐字节不变）全绿；`test:request-snapshot` 6 步全过；文档 `docs/REQUEST-SNAPSHOT.md` 已同步 |
| **peer 桥单一来源**（`PEER_BRIDGE_METHODS` → preload / headless 网页派生） | 新 `test/unit/peer-bridge-contract.test.cjs` + `test:peer`（含 `autoTrust` 四态）、`test:peer-tools`、`test:peer-mesh` 全绿 |
| planner（router / workers / best-of-n / trace） | `test:planner-parallel`、`test:planner-workers`、`test:planner-e2e`、`test:rust-planner-pipeline`、`test:rust-planner-smoke` 全绿 |
| 频道（wecom-media 解密 / agent-turn / runtime） | `channels-*` 单测（含新 `wecom-media.test.cjs`）+ `test:unit` 全绿 |
| 远端 worktree（`remote-run-worktree.js` 新） | `test:remote-worktree-live`、`test:ssh-reconnect-targets`、`test:workspace-remote-runtime` 全绿 |
| 检索 / 向量（index、graph、embedding、fts、shared） | `cargo test` 两套特性全绿；`verify:vector-cache-reuse`、`verify:index-timing-local` 通过 |
| 渲染层（chat-render 阻尼追帧、constants 收口、subagent 面板） | `check:renderer` + `thinking-damped-flow`（7 例）+ `subagent-panel` 等 vitest 全绿 |

---

## 4. 本次顺手改的文件（都是测试 / lint 侧，无运行时行为改动）

```
crates/dieyun-base/src/embedding/remote.rs   10 +2 -2   删多余 cast（clippy -D warnings）
test/unit/thinking-damped-flow.test.cjs       6 +1 -1   夹具先求值 renderer-constants.js
scripts/test-request-snapshot.cjs             7 +2 -2   断言改成内容寻址去重语义
scripts/test-peer-tools.cjs                  37 +7 -30  断言改成 peer 桥表契约
.agents/skills/full-test/SKILL.md             9 +3 -6   基线追加第 8、9 条（本轮四修 + 打包占用）
```

未提交。产物：`dist/win-unpacked/`（246,216,704 B）+ `dist/dieyunagent-Setup-0.1.84.exe`（159,551,272 B，08:24:49）+ `latest.yml`；`build/dieyun-core/dieyun-core.exe` 为当前 release core（内容寻址去重那份）。

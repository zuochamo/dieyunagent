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

- 批 A：`test:phase5-handlers test:session-remote-transport test:agent-run-events test:guardrails-sync test:sandbox-smoke test:write-smell-hints test:session-context test:agent-system-prompt test:system-prompt-prep test:monitor-outbox test:planner-parallel test:mcp-store`
- 批 B：`test:app-updater-feeds test:ssh-reconnect-targets test:main-shell test:reviewer-json test:fs-edit test:delegate-batch test:dieyun-core-pack test:tool-bridge-delegate test:llm-reconnect-retry test:mobile test:browser-smoke test:composer-queue`
- 批 C（sidecar/Rust 链路）：`test:workspace-remote-runtime test:core-bridge test:rust-loop-runner test:rust-planner-pipeline test:rust-agent-loop-smoke test:rust-planner-smoke test:lsp`

默认跳过并单独注明：`test:rust-agent-loop`（需真实 LLM 配置）、build 验证类（`verify:asar` `verify:remote-pack` `verify:bundled-skills`，依赖打包产物）。

### 4. Rust 单测

```bash
cargo test -p dieyun-core
```

首次需编译测试二进制，可能 10 分钟以上——后台运行并轮询，勿前台死等。

### 5. embedding 测试（特殊，永远单独跑）

全仓默认**必超时**：测试脚本硬编码 600s RPC 超时，而全仓 force 重建实测约 13 分钟（CPU ONNX，~1 万 chunk × 批 8）。所以：

- **功能验证（默认做这个）**：`npm run -s test:builtin-embedding-rust src/agent` —— 小目录，几分钟内过，能验证向量写入 / 签名 / 检索全链路。
- 仅当用户明确要验证全仓索引时：把脚本复制到 /tmp，`bridge.invoke('codebase.index', ..., 600000)` 的超时改大（如 3600000），`nohup node ... &` 脱离运行（后台任务有 ~10 分钟上限），等 ~15 分钟后看结果。
- 排障常识：嵌入阶段「CPU 跑满但索引库文件零增长」是设计使然（`embed_batches` 全算完才落盘），不是卡死；看到 code=143 先想是不是自己的 timeout 杀的。

## 批量 runner

```bash
node .agents/skills/full-test/scripts/run-batch.cjs [--timeout MS] suite1 suite2 ...
```

逐套件运行 `npm run -s <suite>`，单个失败不中断后续；失败自动单独重跑一次（端口/时序抖动常见）再定论；超时默认 10 分钟并 taskkill 整棵进程树。输出 `PASS/FAIL(code) <suite>`，FAIL 附最后几行日志，结尾给通过数汇总。

## 已知问题基线（截至 2026-09-21，本机）

判定规则：FAIL 的**签名**（失败信息 + 通过项数量）与基线一致 → 已知问题，报告标「非回归」；签名不同、通过项变少、或出现新 FAIL → 按新回归排查。基线会过时——每次全量测试后核对，状态变了就更新本节，并同步 auto-memory 对应条目。

1. **test:local-gateway-smoke 白名单 FAIL**（2026-09-21 复测 PASS，未复现）：历史签名 = 10 项 ok + `FAIL: 关闭开关后白名单未收窄`。2026-09-21 全量测试中该项单独跑与批量跑均 PASS；疑似已修复或环境不再触发。保留为观察项：若后续再次出现该签名，按已知问题判定；连续多轮不 FAIL 后可移除。
2. **test:builtin-embedding-rust 全仓超时**：签名 = `RPC_TIMEOUT codebase.index`，600s 预算 < 实测 ~789s。容量问题非回归，功能用小目录变体验证（2026-09-21 以 `src/agent` 变体跑通：713 vectors / vectorSearch true / OK）。

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

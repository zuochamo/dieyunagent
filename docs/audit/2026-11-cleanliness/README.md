# 代码整洁度审查取证（2026-11-21）

主报告：[`docs/CODE-CLEANLINESS-REVIEW-2026-11-21.md`](../../CODE-CLEANLINESS-REVIEW-2026-11-21.md)

## 这里有什么

| 文件 | 内容 |
|---|---|
| `agent.json` | `src/agent`（106 文件 / 34.7k 行） |
| `renderer.json` | `src/renderer`（119 文件 / 57.9k 行）+ `src/mobile/public` 对照 |
| `main-gateway.json` | `src/gateway` + `ssh` + `remote` + `git` + `lsp` + `browser` + `main` + `headless` |
| `features.json` | `channels` / `mobile` / `alive` / `plans` / `goals` / `peer` / `skills` / `mcp` / `memory-shared` / `index` / `graph` / `automation` / `tools` / `undo` / `workspace` / `computer` / `terminal` |
| `rust.json` | `crates/`（110 文件 / 34.8k 行） |
| `scripts-tests.json` | `scripts/` + `test/` + `.github/workflows` |
| `single-source.json` | `AGENTS.md`「唯一来源」声明的逐条实测核对 |
| `diff.json` | 审查当时的未提交改动与未跟踪新增文件 |

每条 finding 的字段：`title` / `severity`（P0–P3）/ `category` / `evidence`（`file:line` 列表）/ `why` / `subtraction`（怎么减）/ `verify`（怎么验）/ `already_on_record`（既有文档是否记过、现在是否仍成立）/ `effort`（S/M/L）。

## 复跑扫描（只读，不改源码）

```powershell
node docs/audit/2026-11-cleanliness/tools/clone-scan.cjs     # 8 行归一化滑窗克隆检测 -> clone-report.txt
node docs/audit/2026-11-cleanliness/tools/clone-pairs.cjs    # 按文件对聚合
node docs/audit/2026-11-cleanliness/tools/dead-scan.cjs      # 孤儿模块（本轮 0 个）
node docs/audit/2026-11-cleanliness/tools/renderer-dead-fns.cjs   # Renderer 零调用点声明
node docs/audit/2026-11-cleanliness/tools/verify-dead-exports.cjs # 候选清单全仓复核
node docs/audit/2026-11-cleanliness/tools/doc-path-drift.cjs      # 文档里引用的源码路径是否存在
```

## 两条注意事项

1. **行数口径**：本目录与主报告的行数一律用 `[System.IO.File]::ReadAllLines($path).Count` 或 `fs.readFileSync().split('\n')` 实数。`Get-Content | Measure-Object -Line` 会少算（对无结尾换行的文件少 1，对 CRLF 文件在部分组合下少更多），不要用它对比数字。
2. **`dead-scan.cjs` 的已知盲区**：它按「basename 或 require 词干是否在别处出现」判活。词干 ≤2 字符时会被跳过，动态拼名加载（`require('./engines/' + name)`）也会漏。本轮实测 0 个孤儿，但它是**弱证据**，不能替代人工确认。

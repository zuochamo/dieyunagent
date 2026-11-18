# 工具校验：手写 vs 生成 双跑报告

> **AUTO-GENERATED** by `npm run report:tool-validators`（数据源 `scripts/lib/tool-validate-dualrun.cjs`）。
> 生成的 `src/agent/tool-validate.generated.js` **还没生效**：手写 `tool-validate.js` 仍是唯一实现。
> 这份报告回答的是「schema 到底能表达多少校验」以及「还差什么才能替换」。

**一致 62/62 条（100%），差异 0 条。**

| 分类 | 条数 | 含义 |
|---|---|---|
| `schema-empty` | 0 | schema 里没有这个字段/规则（先在 catalog 补字段，生成器才有的可生成） |
| `schema-conditional` | 0 | 要在某个 action 下才必填（要么 schema 支持 if/then，要么生成器显式列条件） |
| `schema-lacks-enum` | 0 | 手写有取值集合，schema 没写 enum |
| `schema-lacks-range` | 0 | 手写有上下限，schema 没写 minimum/maximum |
| `alias` | 0 | 手写接受别名（一个字段多个名字），schema 声明不了 |
| `errorCode-taxonomy` | 0 | 两边都拒绝，只是错误码归类不同（口径问题，不是行为问题） |
| `handwritten-missing-enum` | 0 | schema 有 enum 而手写没校验（旧代码漏了） |

## 逐条差异

| 工具 | 用例 | 手写 | 生成 | 分类 |
|---|---|---|---|---|

## 结论：要替换手写校验，先补这四件事

1. **`goal_*` / `plan_create` / `host_proc` / `read_symbol` 的 schema 是空的或只有类型** —— 
   跨字段规则（「objective / todos / checks 至少一个」「filePath+name 或 filePath+line」）schema 目前表达不了；
2. **条件必填 6 处**（`lsp` 的 operation 分支、`worktree` 的 create/remove、`host_proc kill`）：
   要在 catalog 里写 `if/then`，或在生成器里显式列「action → 必填字段」表 —— 二选一；
3. **别名**（`grep.query` / `glob.glob` / `fs_read_file.dirPath`）：
   schema 只能声明一个字段名，要么删别名（改调用方），要么在生成器里加 `aliases` 映射（并接受它是第二来源）；
4. ~~**`lsp.operation` 的 enum、`web_search.fetchTop/page` 的 min/max 补进 schema**~~ —— 
   **已完成（2026-11-18）**：手写改成从 schema 读（`toolActionEnum(name, field)` / `numericBounds(name, field)`），
   数字只有一份；`schema-lacks-enum` 与 `schema-lacks-range` 两类归零，一致率 35 → 37。


# runtime 审计
> **2026-11-18 收尾批已修**：F2（token 估值漏 `reasoning_content`，且拿「服务端 usage」和「本地估值」两个口径相减）—— 估值计入思考，并新增 `tokens_before_estimated` 让「省了多少」同口径（Node 遥测已改用）；F3（折叠幂等靠全文搜 `fold:L`）—— `applied_level` 改为逐段校验 `clip()` 写出的完整形状，正文提到这串字不再算「已折过」；F11（`compaction.estimate` 形状错误回 `{tokens:0}`）—— 改硬报 `INVALID_PARAMS`。三条都有回归用例，F2/F3 做过变异验证。F4–F7、F10 仍开（F8/F9 已在 P1 修）。

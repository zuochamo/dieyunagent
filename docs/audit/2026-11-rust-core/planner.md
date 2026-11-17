# planner 审计
> **2026-11-18 收尾批已修**：F3（检查点恢复失败被静默吞掉 → 已完成子任务全重跑）—— `plan` 解析失败改报 `INVALID_PARAMS` 并说明「不会静默重跑」，用例 `unparsable_checkpoint_fails_loudly_instead_of_rerunning`。F4–F11 仍开。

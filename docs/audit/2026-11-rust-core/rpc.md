# rpc 审计
> **2026-11-18 收尾批已修**：F2（一半 async 臂直接同步跑 rusqlite）—— `memory.project_resolve/list/alias_add`、`long_by_session`、`long_forget_session` 搬回阻塞池（表里改 `Impl::Blocking`，handler 移到 `handlers/memory.rs`），并加结构断言钉住「体内只有 SQLite 的方法不许再写成 async」。F3–F9 仍开。

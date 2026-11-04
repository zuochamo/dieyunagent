# RPC Catalog（自动生成）

> 勿手改。更新 RPC 注册后运行 `npm run generate:rpc-catalog`，CI 用 `npm run verify:rpc-catalog` 校验。

生成时间：2026-11-04T11:52:08.317Z

| 统计 | 数量 |
|------|------|
| 总计 | 188 |
| Gateway only | 106 |
| Rust only | 23 |
| Both | 59 |

## 按命名空间

### agent (12)

| Method | Layer | Gateway source | Rust |
|--------|-------|----------------|------|
| `agent.loop.cancel` | rust | — | yes |
| `agent.loop.continue` | rust | — | yes |
| `agent.loop.set_messages` | rust | — | yes |
| `agent.loop.start` | rust | — | yes |
| `agent.loop.tool_results` | rust | — | yes |
| `agent.ping` | rust | — | yes |
| `agent.plan_save` | both | gateway/handlers/agent.js | yes |
| `agent.run_upsert` | both | gateway/handlers/agent.js | yes |
| `agent.state_get` | both | gateway/handlers/agent.js | yes |
| `agent.steps_save` | both | gateway/handlers/agent.js | yes |
| `agent.trace_get` | both | gateway/handlers/agent.js | yes |
| `agent.trace_save` | both | gateway/handlers/agent.js | yes |

### artifact (2)

| Method | Layer | Gateway source | Rust |
|--------|-------|----------------|------|
| `artifact.list_files` | gateway | gateway/handlers/artifact.js | — |
| `artifact.read_file` | gateway | gateway/handlers/artifact.js | — |

### browser (40)

| Method | Layer | Gateway source | Rust |
|--------|-------|----------------|------|
| `browser.a11y_snapshot` | gateway | gateway/handlers/browser.js | — |
| `browser.back` | gateway | gateway/handlers/browser.js | — |
| `browser.click` | gateway | gateway/handlers/browser.js | — |
| `browser.close` | gateway | gateway/handlers/browser.js | — |
| `browser.configure` | gateway | gateway/handlers/browser.js | — |
| `browser.console` | gateway | gateway/handlers/browser.js | — |
| `browser.cookies` | gateway | gateway/handlers/browser.js | — |
| `browser.dialog` | gateway | gateway/handlers/browser.js | — |
| `browser.downloads` | gateway | gateway/handlers/browser.js | — |
| `browser.drag` | gateway | gateway/handlers/browser.js | — |
| `browser.emulate` | gateway | gateway/handlers/browser.js | — |
| `browser.evaluate` | gateway | gateway/handlers/browser.js | — |
| `browser.expect` | gateway | gateway/handlers/browser.js | — |
| `browser.export_storage` | gateway | gateway/handlers/browser.js | — |
| `browser.fill` | gateway | gateway/handlers/browser.js | — |
| `browser.forward` | gateway | gateway/handlers/browser.js | — |
| `browser.frames` | gateway | gateway/handlers/browser.js | — |
| `browser.har_export` | gateway | gateway/handlers/browser.js | — |
| `browser.hover` | gateway | gateway/handlers/browser.js | — |
| `browser.import_storage` | gateway | gateway/handlers/browser.js | — |
| `browser.navigate` | gateway | gateway/handlers/browser.js | — |
| `browser.network` | gateway | gateway/handlers/browser.js | — |
| `browser.observe` | gateway | gateway/handlers/browser.js | — |
| `browser.pdf` | gateway | gateway/handlers/browser.js | — |
| `browser.press_key` | gateway | gateway/handlers/browser.js | — |
| `browser.reload` | gateway | gateway/handlers/browser.js | — |
| `browser.reset_logs` | gateway | gateway/handlers/browser.js | — |
| `browser.route` | gateway | gateway/handlers/browser.js | — |
| `browser.screenshot` | gateway | gateway/handlers/browser.js | — |
| `browser.scroll` | gateway | gateway/handlers/browser.js | — |
| `browser.select_option` | gateway | gateway/handlers/browser.js | — |
| `browser.snapshot` | gateway | gateway/handlers/browser.js | — |
| `browser.status` | gateway | gateway/handlers/browser.js | — |
| `browser.tabs` | gateway | gateway/handlers/browser.js | — |
| `browser.timeline` | gateway | gateway/handlers/browser.js | — |
| `browser.type` | gateway | gateway/handlers/browser.js | — |
| `browser.upload_file` | gateway | gateway/handlers/browser.js | — |
| `browser.viewport` | gateway | gateway/handlers/browser.js | — |
| `browser.visual_diff` | gateway | gateway/handlers/browser.js | — |
| `browser.wait_for` | gateway | gateway/handlers/browser.js | — |

### codebase (4)

| Method | Layer | Gateway source | Rust |
|--------|-------|----------------|------|
| `codebase.index` | both | gateway/handlers/codebase.js | yes |
| `codebase.index.start` | both | gateway/handlers/codebase.js | yes |
| `codebase.search` | both | gateway/handlers/codebase.js | yes |
| `codebase.status` | both | gateway/handlers/codebase.js | yes |

### compaction (2)

| Method | Layer | Gateway source | Rust |
|--------|-------|----------------|------|
| `compaction.estimate` | rust | — | yes |
| `compaction.maybe_compact` | rust | — | yes |

### computer (1)

| Method | Layer | Gateway source | Rust |
|--------|-------|----------------|------|
| `computer.action` | gateway | gateway/handlers/computer.js | — |

### core (2)

| Method | Layer | Gateway source | Rust |
|--------|-------|----------------|------|
| `core.configure` | rust | — | yes |
| `core.ping` | rust | — | yes |

### fs (9)

| Method | Layer | Gateway source | Rust |
|--------|-------|----------------|------|
| `fs.edit_file` | gateway | gateway/handlers/fs.js | — |
| `fs.glob` | gateway | gateway/handlers/fs.js | — |
| `fs.grep` | gateway | gateway/handlers/fs.js | — |
| `fs.list_dir` | both | gateway/handlers/fs.js | yes |
| `fs.mkdir` | gateway | gateway/handlers/fs.js | — |
| `fs.read_file` | both | gateway/handlers/fs.js | yes |
| `fs.read_symbol` | gateway | gateway/handlers/fs.js | — |
| `fs.stat` | gateway | gateway/handlers/fs.js | — |
| `fs.write_file` | gateway | gateway/handlers/fs.js | — |

### graph (12)

| Method | Layer | Gateway source | Rust |
|--------|-------|----------------|------|
| `graph.callees` | both | gateway/handlers/graph.js | yes |
| `graph.callers` | both | gateway/handlers/graph.js | yes |
| `graph.impact` | both | gateway/handlers/graph.js | yes |
| `graph.index` | both | gateway/handlers/graph.js, gateway/rpc.js | yes |
| `graph.index.start` | both | gateway/handlers/graph.js, gateway/rpc.js | yes |
| `graph.ingest_lsp_callers` | rust | — | yes |
| `graph.lsp_enrich` | gateway | gateway/handlers/graph.js | — |
| `graph.lsp_resolve` | gateway | gateway/handlers/graph.js | — |
| `graph.module_deps` | both | gateway/handlers/graph.js | yes |
| `graph.repo_map` | both | gateway/handlers/graph.js | yes |
| `graph.status` | both | gateway/handlers/graph.js, gateway/rpc.js | yes |
| `graph.symbol_search` | both | gateway/handlers/graph.js | yes |

### host (7)

| Method | Layer | Gateway source | Rust |
|--------|-------|----------------|------|
| `host.exec` | gateway | gateway/handlers/host.js | — |
| `host.open_url` | gateway | gateway/handlers/host.js | — |
| `host.print_image` | gateway | gateway/handlers/host.js | — |
| `host.proc_kill` | gateway | gateway/handlers/host.js | — |
| `host.proc_list` | gateway | gateway/handlers/host.js | — |
| `host.proc_output` | gateway | gateway/handlers/host.js | — |
| `host.proc_settled` | gateway | gateway/handlers/host.js | — |

### index (2)

| Method | Layer | Gateway source | Rust |
|--------|-------|----------------|------|
| `index.remote_sync_configure` | gateway | gateway/handlers/index-remote.js | — |
| `index.remote_wait_ready` | gateway | gateway/handlers/index-remote.js | — |

### lsp (6)

| Method | Layer | Gateway source | Rust |
|--------|-------|----------------|------|
| `lsp.diagnostics_report` | gateway | gateway/handlers/lsp-workspace.js | — |
| `lsp.diagnostics_snapshot` | gateway | gateway/handlers/lsp-workspace.js | — |
| `lsp.document_sync` | gateway | gateway/handlers/lsp-workspace.js | — |
| `lsp.query` | gateway | gateway/handlers/lsp-workspace.js | — |
| `lsp.settings_get` | gateway | gateway/handlers/lsp-workspace.js | — |
| `lsp.settings_set` | gateway | gateway/handlers/lsp-workspace.js | — |

### memory (50)

| Method | Layer | Gateway source | Rust |
|--------|-------|----------------|------|
| `memory.compaction_archive` | both | gateway/handlers/memory.js | yes |
| `memory.compaction_folded` | both | gateway/handlers/memory.js | yes |
| `memory.compaction_recent` | both | gateway/handlers/memory.js | yes |
| `memory.consolidation_job_create` | both | gateway/handlers/memory.js | yes |
| `memory.consolidation_job_finish` | both | gateway/handlers/memory.js | yes |
| `memory.handoff_get` | both | gateway/handlers/memory.js | yes |
| `memory.handoff_latest` | both | gateway/handlers/memory.js | yes |
| `memory.handoff_save` | both | gateway/handlers/memory.js | yes |
| `memory.long_add` | both | gateway/handlers/memory.js | yes |
| `memory.long_by_session` | rust | — | yes |
| `memory.long_decay` | both | gateway/handlers/memory.js | yes |
| `memory.long_forget_session` | rust | — | yes |
| `memory.long_keyword_search` | both | gateway/handlers/memory.js | yes |
| `memory.long_memories_after` | both | gateway/handlers/memory.js | yes |
| `memory.long_recall` | both | gateway/handlers/memory.js | yes |
| `memory.long_recent` | both | gateway/handlers/memory.js | yes |
| `memory.long_reindex` | both | gateway/handlers/memory.js | yes |
| `memory.long_status_set` | both | gateway/handlers/memory.js | yes |
| `memory.long_vector_status` | both | gateway/handlers/memory.js | yes |
| `memory.message_append` | both | gateway/handlers/memory.js | yes |
| `memory.messages_after` | both | gateway/handlers/memory.js | yes |
| `memory.messages_clear` | gateway | gateway/handlers/memory.js | — |
| `memory.messages_delete_turn` | both | gateway/handlers/memory.js | yes |
| `memory.messages_older` | both | gateway/handlers/memory.js | yes |
| `memory.messages_recent` | both | gateway/handlers/memory.js | yes |
| `memory.messages_search` | both | gateway/handlers/memory.js | yes |
| `memory.ping` | rust | — | yes |
| `memory.project_add` | gateway | gateway/handlers/memory.js | — |
| `memory.project_alias_add` | both | gateway/handlers/memory.js | yes |
| `memory.project_list` | both | gateway/handlers/memory.js | yes |
| `memory.project_recall` | gateway | gateway/handlers/memory.js | — |
| `memory.project_resolve` | rust | — | yes |
| `memory.project_scope` | gateway | gateway/handlers/memory.js | — |
| `memory.request_snapshot_append` | rust | — | yes |
| `memory.request_snapshot_get` | both | gateway/handlers/memory.js | yes |
| `memory.request_snapshot_index_audit` | rust | — | yes |
| `memory.request_snapshot_recent` | both | gateway/handlers/memory.js | yes |
| `memory.session_archive` | both | gateway/handlers/memory.js | yes |
| `memory.session_create` | both | gateway/handlers/memory.js | yes |
| `memory.session_delete` | both | gateway/handlers/memory.js | yes |
| `memory.session_get` | both | gateway/handlers/memory.js | yes |
| `memory.session_goal_get` | both | gateway/handlers/memory.js | yes |
| `memory.session_goal_put` | both | gateway/handlers/memory.js | yes |
| `memory.session_memories` | gateway | gateway/handlers/memory.js | — |
| `memory.session_memories_forget` | gateway | gateway/handlers/memory.js | — |
| `memory.session_set_title` | both | gateway/handlers/memory.js | yes |
| `memory.session_workspace_set` | both | gateway/handlers/memory.js | yes |
| `memory.sessions_list` | both | gateway/handlers/memory.js | yes |
| `memory.sessions_with_messages` | both | gateway/handlers/memory.js | yes |
| `memory.touch_session` | both | gateway/handlers/memory.js | yes |

### permissions (2)

| Method | Layer | Gateway source | Rust |
|--------|-------|----------------|------|
| `permissions.get` | gateway | gateway/handlers/permissions.js | — |
| `permissions.sandbox_state` | gateway | gateway/handlers/permissions.js | — |

### planner (5)

| Method | Layer | Gateway source | Rust |
|--------|-------|----------------|------|
| `planner.ping` | rust | — | yes |
| `planner.run.cancel` | rust | — | yes |
| `planner.run.continue` | rust | — | yes |
| `planner.run.start` | rust | — | yes |
| `planner.run.worker_loop` | rust | — | yes |

### rpc (1)

| Method | Layer | Gateway source | Rust |
|--------|-------|----------------|------|
| `rpc.cancel` | rust | — | yes |

### scm (9)

| Method | Layer | Gateway source | Rust |
|--------|-------|----------------|------|
| `scm.commit` | gateway | gateway/handlers/scm.js | — |
| `scm.commit_diff` | gateway | gateway/handlers/scm.js | — |
| `scm.commit_files` | gateway | gateway/handlers/scm.js | — |
| `scm.discard` | gateway | gateway/handlers/scm.js | — |
| `scm.file_diff` | gateway | gateway/handlers/scm.js | — |
| `scm.log` | gateway | gateway/handlers/scm.js | — |
| `scm.stage` | gateway | gateway/handlers/scm.js | — |
| `scm.status` | gateway | gateway/handlers/scm.js | — |
| `scm.unstage` | gateway | gateway/handlers/scm.js | — |

### speech (3)

| Method | Layer | Gateway source | Rust |
|--------|-------|----------------|------|
| `speech.synthesize` | gateway | gateway/handlers/speech.js | — |
| `speech.transcribe` | gateway | gateway/handlers/speech.js | — |
| `speech.transcribe_probe` | gateway | gateway/handlers/speech.js | — |

### undo (11)

| Method | Layer | Gateway source | Rust |
|--------|-------|----------------|------|
| `undo.can_rollback` | gateway | gateway/handlers/undo.js | — |
| `undo.capture_batch` | gateway | gateway/handlers/undo.js | — |
| `undo.capture_plan_apply` | gateway | gateway/handlers/undo.js | — |
| `undo.mark_worktree_only` | gateway | gateway/handlers/undo.js | — |
| `undo.rollback` | gateway | gateway/handlers/undo.js | — |
| `undo.rollback_batch` | gateway | gateway/handlers/undo.js | — |
| `undo.rollback_commit` | gateway | gateway/handlers/undo.js | — |
| `undo.session_clear` | gateway | gateway/handlers/undo.js | — |
| `undo.stack_get` | gateway | gateway/handlers/undo.js | — |
| `undo.turn_begin` | gateway | gateway/handlers/undo.js | — |
| `undo.turn_finalize` | gateway | gateway/handlers/undo.js | — |

### web (2)

| Method | Layer | Gateway source | Rust |
|--------|-------|----------------|------|
| `web.fetch` | gateway | gateway/handlers/web.js | — |
| `web.search` | gateway | gateway/handlers/web.js | — |

### workspace (6)

| Method | Layer | Gateway source | Rust |
|--------|-------|----------------|------|
| `workspace.diagnostics` | gateway | gateway/handlers/lsp-workspace.js | — |
| `workspace.diagnostics_scan` | gateway | gateway/handlers/lsp-workspace.js | — |
| `workspace.diagnostics_status` | gateway | gateway/handlers/lsp-workspace.js | — |
| `workspace.diagnostics_store` | gateway | gateway/handlers/lsp-workspace.js | — |
| `workspace.git_diff` | gateway | gateway/handlers/lsp-workspace.js | — |
| `workspace.resolve_path` | gateway | gateway/handlers/workspace.js | — |


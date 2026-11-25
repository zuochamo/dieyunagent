'use strict';

/**
 * planner 的 Main 侧桥（`createPlannerMainBridge`）：**远端分派是否真的接线**。
 *
 * 这条链以前断在装配上：`rust-planner-runner` 构造 bridge 时没转发 `resolveRemoteRunTarget`，
 * 于是 `remoteTarget()` 恒 null、`remote-run-worktree.js` 在主链上一次都没跑过，SSH 会话
 * 每个执行器都去本地 `worktreeService` 建一个 `ssh://…` 的假路径副本（必然失败）→ 整批串行，
 * 还把根因说成「远端建不出隔离副本」（2026-11-19 审计）。这里钉住：
 * 有远端目标就走远端三件事（建副本 / 预览 / 收尾清理），没有才走本地。
 */

const { createPlannerMainBridge } = require('../../src/agent/planner-main-bridge');

const REPO = '/srv/app';
const SESSION_WT = '/srv/app/.dieyun/worktrees/sess-1/main';

function fakeSshManager() {
  const calls = [];
  return {
    calls,
    async execScript(script, timeoutMs) {
      calls.push({ script, timeoutMs });
      if (script.includes('--name-status')) {
        return { code: 0, stdout: 'RW_BASE=A|abc1234\nRW_CHG=A|M|src/a.go\nRW_DONE\n', stderr: '' };
      }
      if (script.includes('RW_ROLE=')) return { code: 0, stdout: 'RW_ROLE=A\n', stderr: '' };
      if (script.includes('status --porcelain')) return { code: 0, stdout: 'RW_ARCHIVED=abc1234\n', stderr: '' };
      if (script.includes('--git-dir')) return { code: 0, stdout: 'WT_CREATED\nRW_BASE=abc1234\n', stderr: '' };
      return { code: 0, stdout: '', stderr: '' };
    }
  };
}

function fakeWorktreeService() {
  const calls = [];
  const rec = (name) => async (...args) => {
    calls.push({ name, args });
    return { ok: true, local: true };
  };
  return {
    calls,
    createAgentWorktree: rec('createAgentWorktree'),
    previewRunWorktreeChanges: rec('previewRunWorktreeChanges'),
    applyRunWorktreeChanges: rec('applyRunWorktreeChanges'),
    cleanupRunWorktrees: rec('cleanupRunWorktrees')
  };
}

function buildBridge({ remote }) {
  const manager = fakeSshManager();
  const worktreeService = fakeWorktreeService();
  const bridge = createPlannerMainBridge({
    coordinator: null,
    worktreeService,
    subagentStore: {},
    dieyunHome: () => '/tmp/home',
    workspaceRootPath: () => (remote ? `ssh://u@h${SESSION_WT}` : '/local/ws'),
    resolveRemoteRunTarget: remote
      ? () => ({ manager, repoPath: REPO, sessionWtPath: SESSION_WT })
      : undefined
  });
  return { bridge, manager, worktreeService };
}

describe('planner Main 桥 · 远端分派接线', () => {
  it('有远端目标 → 建副本走远端（per-role 路径），不碰本地 worktreeService', async () => {
    const { bridge, manager, worktreeService } = buildBridge({ remote: true });
    const r = await bridge.worktreeCreate('run-1', 'B');
    expect(r.ok).toBe(true);
    expect(r.path).toBe(`${REPO}/.dieyun/worktrees/run-1/B`);
    expect(worktreeService.calls).toHaveLength(0);
    expect(manager.calls[0].script).toContain('.dieyun/worktrees/run-1/B');
  });

  it('没有远端目标 → 仍然走本地（本地行为零变化）', async () => {
    const { bridge, manager, worktreeService } = buildBridge({ remote: false });
    await bridge.worktreeCreate('run-1', 'B');
    expect(manager.calls).toHaveLength(0);
    expect(worktreeService.calls.map((c) => c.name)).toContain('createAgentWorktree');
  });

  it('有远端目标 → 变更预览走远端脚本（验收拿得到 diff）', async () => {
    const { bridge, manager, worktreeService } = buildBridge({ remote: true });
    const r = await bridge.worktreePreviewRun('run-1');
    expect(r.ok).toBe(true);
    expect(r.changes).toHaveLength(1);
    expect(r.changes[0].repoPath).toBe('src/a.go');
    expect(worktreeService.calls).toHaveLength(0);
    expect(manager.calls[0].script).toContain('--name-status');
  });

  it('有远端目标 → 逐文件应用明确拒绝（不是静默空结果）', async () => {
    const { bridge, worktreeService } = buildBridge({ remote: true });
    const r = await bridge.worktreeApplyRun('run-1', ['src/a.go']);
    expect(r.ok).toBe(false);
    expect(r.remote).toBe(true);
    expect(String(r.error)).toContain('合并回会话副本');
    expect(worktreeService.calls).toHaveLength(0);
  });

  it('有远端目标 → 停止时先归档再删目录，且**不删分支**', async () => {
    const { bridge, manager } = buildBridge({ remote: true });
    const r = await bridge.worktreeCleanupRun('run-1');
    expect(r.ok).toBe(true);
    const all = manager.calls.map((c) => c.script).join('\n');
    expect(all).toContain('commit -m "$MSG"'); // 归档
    expect(all).toContain('worktree remove --force');
    expect(all).not.toContain('branch -D'); // 分支是产出存档，必须留着
    expect(all.indexOf('commit -m "$MSG"')).toBeLessThan(all.indexOf('worktree remove --force'));
  });

  it('没有远端目标时不回收副本（本地由变更面板/清理脚本管）', async () => {
    const { bridge, manager } = buildBridge({ remote: false });
    const r = await bridge.worktreePruneRunCopies({ keep: 5 });
    expect(r).toEqual({ ok: true, skipped: true });
    expect(manager.calls).toHaveLength(0);
  });
});

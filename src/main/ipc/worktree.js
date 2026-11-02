'use strict';

const {
  createWorktreeActions,
  resolveRemoteSessionWorktree
} = require('../../worktree/actions');
const { previewRemoteWorktree, applyRemoteWorktree } = require('../../ssh/remote-worktree-apply');

/**
 * Worktree IPC：只做转发。仓库上下文解析、每个动作的实现都在 `src/worktree/actions.js`
 * —— Agent 工具 `worktree` 走同一份，不允许在 IPC 里再写一遍（会漂移）。
 * @param {object} ctx
 */
function registerWorktreeIpc(ctx) {
  const { ipcMain } = ctx;
  const worktree = ctx.worktreeActions || createWorktreeActions(ctx);

  ipcMain.handle('worktree:list', () => worktree.list());
  ipcMain.handle('worktree:create', async (_evt, payload) => worktree.create(payload || {}));
  ipcMain.handle('worktree:remove', async (_evt, payload) => worktree.remove(payload || {}));
  ipcMain.handle('worktree:cleanup-run', async (_evt, payload) => worktree.cleanupRun(payload || {}));
  ipcMain.handle('worktree:prune-branches', async (_evt, payload) => worktree.pruneBranches(payload || {}));
  ipcMain.handle('worktree:restore-apply-backup', async (_evt, { backupDir } = {}) => {
    const c = worktree.resolveWorktreeRepoContext();
    if (!c.ok) return { ok: false, error: c.error, hint: c.hint || '' };
    const service = ctx.getWorktreeService();
    try {
      return await service.restoreApplyBackup(c.repoPath, backupDir);
    } catch (e) {
      return { ok: false, error: e.message || String(e) };
    }
  });
  ipcMain.handle('worktree:list-managed', () => worktree.listManaged());
  ipcMain.handle('worktree:enforce-cleanup', async (_evt, payload) => {
    const c = worktree.resolveWorktreeRepoContext();
    if (!c.ok) return { ok: false, error: c.error, hint: c.hint || '' };
    try {
      return await ctx.getWorktreeService().enforceWorktreeCleanupPolicy(c.repoPath, payload || {});
    } catch (e) {
      return { ok: false, error: e.message || String(e) };
    }
  });
  ipcMain.handle('worktree:preview-run', async (_evt, payload) => worktree.previewRun(payload || {}));
  ipcMain.handle('worktree:apply-run', async (_evt, payload) => worktree.applyRun(payload || {}));
  ipcMain.handle('worktree:change-diff', async (_evt, payload) => worktree.changeDiff(payload || {}));

  ipcMain.handle('worktree:remote-preview', async (_evt, payload) => {
    const c = resolveRemoteSessionWorktree(ctx, payload);
    if (!c.ok) return c;
    try {
      const r = await previewRemoteWorktree(c.manager, { wtPath: c.wtPath });
      return { ...r, sessionId: c.sid, branch: r.branch || c.branch };
    } catch (e) {
      return { ok: false, code: 'preview_failed', error: e.message || String(e), files: [] };
    }
  });

  ipcMain.handle('worktree:remote-apply', async (_evt, payload) => {
    const c = resolveRemoteSessionWorktree(ctx, payload);
    if (!c.ok) return c;
    try {
      const r = await applyRemoteWorktree(c.manager, {
        repoPath: c.repoPath,
        wtPath: c.wtPath,
        branch: c.branch,
        message: `dieyun: 会话产出（${c.sid}）`
      });
      return { ...r, sessionId: c.sid };
    } catch (e) {
      return { ok: false, code: 'apply_failed', error: e.message || String(e), files: [] };
    }
  });
}

module.exports = { registerWorktreeIpc };

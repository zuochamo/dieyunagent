'use strict';

const fs = require('fs');

function resolveWorktreeRepoContext(getLocalGateway) {
  const localGateway = getLocalGateway();
  if (!localGateway) {
    return {
      ok: false,
      code: 'no_gateway',
      error: 'Gateway 未就绪',
      hint: '请重启应用后重试。',
      repoPath: null,
      displayPath: ''
    };
  }
  const ws = localGateway.getWorkspace();
  const target =
    typeof localGateway.getEffectiveWorkspaceTarget === 'function'
      ? localGateway.getEffectiveWorkspaceTarget()
      : null;
  const displayPath = (ws && (ws.displayPath || ws.workspacePath)) || '';

  if (!target) {
    return {
      ok: false,
      code: 'no_workspace',
      error: '未设置工作空间',
      hint: '请先在对话页选择本地 Git 项目文件夹。',
      repoPath: null,
      displayPath: ''
    };
  }
  if (target.kind === 'ssh') {
    return {
      ok: false,
      code: 'remote_workspace',
      kind: 'ssh',
      error: '当前为 SSH 远程工作空间',
      hint: '远程工作空间无法在设置页列出副本。',
      repoPath: null,
      displayPath
    };
  }
  const root = target.path;
  if (!root || !fs.existsSync(root)) {
    return {
      ok: false,
      code: 'path_missing',
      error: '工作空间路径不存在',
      hint: root ? `路径无效或已移动：${root}` : '请重新选择工作空间文件夹。',
      repoPath: null,
      displayPath: root || displayPath
    };
  }
  return { ok: true, code: 'ok', repoPath: root, displayPath: root };
}

function worktreeContextFailure(ctx, extra = {}) {
  return {
    ok: false,
    error: ctx.error || '无法加载 worktree 列表',
    hint: ctx.hint || '',
    code: ctx.code || 'worktree_context',
    workspaceKind: ctx.kind || null,
    repoPath: ctx.displayPath || null,
    runs: [],
    totalBytes: 0,
    ...extra
  };
}

/**
 * @param {object} ctx
 */
function registerWorktreeIpc(ctx) {
  const { ipcMain, getLocalGateway, getWorktreeService } = ctx;

  ipcMain.handle('worktree:list', async () => {
    const repo = resolveWorktreeRepoContext(getLocalGateway);
    if (!repo.ok) return worktreeContextFailure(repo, { worktrees: [] });
    return getWorktreeService().listWorktrees(repo.repoPath);
  });
  ipcMain.handle('worktree:create', async (_evt, { runId, roleId, baseRef }) => {
    const repo = resolveWorktreeRepoContext(getLocalGateway);
    if (!repo.ok) return worktreeContextFailure(repo);
    try {
      return await getWorktreeService().createAgentWorktree(repo.repoPath, { runId, roleId, baseRef });
    } catch (e) {
      return { ok: false, error: e.message || String(e) };
    }
  });
  ipcMain.handle('worktree:remove', async (_evt, { path: wtPath }) => {
    const repo = resolveWorktreeRepoContext(getLocalGateway);
    if (!repo.ok) return worktreeContextFailure(repo);
    try {
      return await getWorktreeService().removeAgentWorktree(repo.repoPath, wtPath);
    } catch (e) {
      return { ok: false, error: e.message || String(e) };
    }
  });
  ipcMain.handle('worktree:cleanup-run', async (_evt, payload) => {
    const repo = resolveWorktreeRepoContext(getLocalGateway);
    if (!repo.ok) return worktreeContextFailure(repo);
    const { runId, archive, allowDiscardUncommitted, deleteBranches } = payload || {};
    try {
      return await getWorktreeService().cleanupRunWorktrees(repo.repoPath, runId, {
        archive: archive !== false,
        allowDiscardUncommitted: !!allowDiscardUncommitted,
        deleteBranches: !!deleteBranches
      });
    } catch (e) {
      return { ok: false, error: e.message || String(e) };
    }
  });
  ipcMain.handle('worktree:prune-branches', async (_evt, payload) => {
    const repo = resolveWorktreeRepoContext(getLocalGateway);
    if (!repo.ok) return worktreeContextFailure(repo);
    try {
      return await getWorktreeService().pruneRunBranches(repo.repoPath, payload || {});
    } catch (e) {
      return { ok: false, error: e.message || String(e) };
    }
  });
  ipcMain.handle('worktree:restore-apply-backup', async (_evt, { backupDir }) => {
    const repo = resolveWorktreeRepoContext(getLocalGateway);
    if (!repo.ok) return worktreeContextFailure(repo);
    try {
      return await getWorktreeService().restoreApplyBackup(repo.repoPath, backupDir);
    } catch (e) {
      return { ok: false, error: e.message || String(e) };
    }
  });
  ipcMain.handle('worktree:list-managed', async () => {
    const repo = resolveWorktreeRepoContext(getLocalGateway);
    if (!repo.ok) return worktreeContextFailure(repo);
    try {
      return await getWorktreeService().listManagedWorktreeRuns(repo.repoPath);
    } catch (e) {
      return worktreeContextFailure(repo, { error: e.message || String(e) });
    }
  });
  ipcMain.handle('worktree:enforce-cleanup', async (_evt, payload) => {
    const repo = resolveWorktreeRepoContext(getLocalGateway);
    if (!repo.ok) return worktreeContextFailure(repo);
    try {
      return await getWorktreeService().enforceWorktreeCleanupPolicy(repo.repoPath, payload || {});
    } catch (e) {
      return worktreeContextFailure(repo, { error: e.message || String(e) });
    }
  });
  ipcMain.handle('worktree:preview-run', async (_evt, { runId }) => {
    const repo = resolveWorktreeRepoContext(getLocalGateway);
    if (!repo.ok) return worktreeContextFailure(repo, { changes: [] });
    try {
      return await getWorktreeService().previewRunWorktreeChanges(repo.repoPath, runId);
    } catch (e) {
      return worktreeContextFailure(repo, { error: e.message || String(e), changes: [] });
    }
  });
  ipcMain.handle('worktree:apply-run', async (_evt, payload) => {
    const repo = resolveWorktreeRepoContext(getLocalGateway);
    if (!repo.ok) return worktreeContextFailure(repo);
    const { runId, paths, forceConflict, changeIds, forceChangeIds, allowOverwriteMainDirty } =
      payload || {};
    try {
      return await getWorktreeService().applyRunWorktreeChanges(repo.repoPath, runId, {
        paths: paths || [],
        changeIds: changeIds || [],
        forceConflict: !!forceConflict,
        forceChangeIds: forceChangeIds || [],
        allowOverwriteMainDirty: !!allowOverwriteMainDirty
      });
    } catch (e) {
      return { ok: false, error: e.message || String(e) };
    }
  });
  ipcMain.handle('worktree:change-diff', async (_evt, { change }) => {
    const repo = resolveWorktreeRepoContext(getLocalGateway);
    if (!repo.ok) return worktreeContextFailure(repo, { patch: '' });
    try {
      return await getWorktreeService().getWorktreeChangeDiff(repo.repoPath, change || {});
    } catch (e) {
      return { ok: false, error: e.message || String(e), patch: '' };
    }
  });
}

module.exports = { registerWorktreeIpc };

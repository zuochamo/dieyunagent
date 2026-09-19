'use strict';

/**
 * Main 进程 AgentRunCoordinator / worktree / checkpoint 桥接（供 planner 使用）。
 */
function createPlannerMainBridge(deps) {
  const coordinator = deps.coordinator;
  const worktreeService = deps.worktreeService;
  const subagentStore = deps.subagentStore;
  const dieyunHome = deps.dieyunHome;
  const workspaceRootPath = deps.workspaceRootPath;

  return {
    runStart(meta) {
      if (!coordinator) return { ok: false, error: 'coordinator_unavailable' };
      return { ok: true, ...coordinator.startRun(meta || {}) };
    },
    runEnd(runId) {
      if (!coordinator) return { ok: false };
      return coordinator.endRun(runId);
    },
    runCancel(runId, reason) {
      if (!coordinator) return { ok: false };
      return coordinator.cancelRun(runId, reason);
    },
    isCancelled(runId) {
      return { cancelled: coordinator ? coordinator.isRunCancelled(runId) : true };
    },
    taskEnqueue(runId, task) {
      if (!coordinator) return { ok: false };
      try {
        const r = coordinator.enqueueTask(runId, task || {});
        return { ok: true, task: r.task };
      } catch (e) {
        return { ok: false, error: e.message || String(e) };
      }
    },
    taskRunning(runId, taskId) {
      if (!coordinator) return { ok: false };
      try {
        coordinator.markTaskRunning(runId, taskId);
        return { ok: true };
      } catch (e) {
        return { ok: false, error: e.message || String(e) };
      }
    },
    taskComplete(runId, taskId, result) {
      if (!coordinator) return { ok: false };
      try {
        coordinator.completeTask(runId, taskId, result);
        return { ok: true };
      } catch (e) {
        return { ok: false, error: e.message || String(e) };
      }
    },
    taskFail(runId, taskId, error, cancel) {
      if (!coordinator) return { ok: false };
      try {
        const r = coordinator.failTask(runId, taskId, error, { cancel: !!cancel });
        return { ok: true, needsArbitration: !!r?.needsArbitration };
      } catch (e) {
        return { ok: false, error: e.message || String(e) };
      }
    },
    messagePost(runId, message) {
      if (!coordinator) return { ok: false };
      try {
        coordinator.postMessage(runId, message || {});
        return { ok: true };
      } catch (e) {
        return { ok: false, error: e.message || String(e) };
      }
    },
    messagesForRole(runId, roleId) {
      return {
        ok: true,
        messages: coordinator ? coordinator.getMessagesForRole(runId, roleId) : []
      };
    },
    messagesForRoleSince(runId, roleId, since) {
      if (!coordinator) return { ok: true, messages: [], lastAt: since || 0 };
      const r = coordinator.getMessagesForRoleSince(runId, roleId, since);
      return { ok: true, messages: r.messages, lastAt: r.lastAt };
    },
    trace(runId) {
      return coordinator ? coordinator.getTrace(runId) : { ok: false };
    },
    arbitrate(runId, decision) {
      if (!coordinator) return { ok: false };
      return coordinator.arbitrate(runId, decision || {});
    },
    checkpointSave(runId, data) {
      try {
        return subagentStore.saveCheckpoint(dieyunHome(), runId, data || {});
      } catch (e) {
        return { ok: false, error: e.message || String(e) };
      }
    },
    checkpointDelete(runId) {
      return subagentStore.deleteCheckpoint(dieyunHome(), runId);
    },
    async worktreeCreate(runId, roleId, baseRef) {
      const root = workspaceRootPath();
      if (!root) return { ok: false, error: '未设置工作空间' };
      try {
        return await worktreeService.createAgentWorktree(root, { runId, roleId, baseRef });
      } catch (e) {
        return { ok: false, error: e.message || String(e) };
      }
    },
    async worktreeRemove(wtPath) {
      const root = workspaceRootPath();
      if (!root) return { ok: false, error: '未设置工作空间' };
      try {
        return await worktreeService.removeAgentWorktree(root, wtPath);
      } catch (e) {
        return { ok: false, error: e.message || String(e) };
      }
    },
    async worktreeCleanupRun(runId) {
      const root = workspaceRootPath();
      if (!root) return { ok: false, error: '未设置工作空间' };
      try {
        return await worktreeService.cleanupRunWorktrees(root, runId);
      } catch (e) {
        return { ok: false, error: e.message || String(e) };
      }
    },
    async worktreePreviewRun(runId) {
      const root = workspaceRootPath();
      if (!root) return { ok: false, error: '未设置工作空间' };
      try {
        return await worktreeService.previewRunWorktreeChanges(root, runId);
      } catch (e) {
        return { ok: false, error: e.message || String(e) };
      }
    },
    async worktreeApplyRun(runId, paths, forceConflict, changeIds, applyOpts) {
      const root = workspaceRootPath();
      if (!root) return { ok: false, error: '未设置工作空间' };
      try {
        return await worktreeService.applyRunWorktreeChanges(root, runId, {
          paths: paths || null,
          changeIds: changeIds || null,
          forceConflict: !!forceConflict,
          forceChangeIds: (applyOpts && applyOpts.forceChangeIds) || [],
          allowOverwriteMainDirty: !!(applyOpts && applyOpts.allowOverwriteMainDirty)
        });
      } catch (e) {
        return { ok: false, error: e.message || String(e) };
      }
    }
  };
}

module.exports = { createPlannerMainBridge };

'use strict';

function createUndoHandlers(d) {
  const {
    turnUndo,
    getActiveRunWorkspaceRoot,
    isSshConnectedForCall,
    getRemoteFs,
    captureRemoteGitWorkingBaseline,
    captureGitWorkingBaseline,
    mergeBaselineFilesInto,
    isGitRepo,
    requireSshForCall,
    workspaceRootForUndo,
    normalizeUndoTouchPaths,
    captureUndoCheckpointSnapshot,
    restoreUndoFilesConcurrent,
    runWithCallContext,
    undoRestoreCallContext
  } = d;
  return {
    'undo.turn_begin': async ({
      sessionId,
      turnId,
      mode,
      runId,
      workspaceKind,
      workspaceRoot,
      runWorkspaceRoot
    }) => {
      if (!turnUndo) return { ok: false, error: 'undo 未启用' };
      /** @type {{ isGitRepo?: boolean, head?: string, files?: Record<string, unknown> } | null} */
      let remoteGitBaseline = null;
      const uri = runWorkspaceRoot || getActiveRunWorkspaceRoot() || null;
      if (
        (workspaceKind === 'ssh' || /^ssh:/i.test(String(uri || ''))) &&
        (workspaceRoot || uri) &&
        isSshConnectedForCall()
      ) {
        const remote = getRemoteFs();
        if (remote) {
          try {
            remoteGitBaseline = await Promise.race([
              captureRemoteGitWorkingBaseline(requireSshForCall(), remote.root),
              new Promise((_, reject) =>
                setTimeout(() => reject(new Error('remote git baseline timeout')), 20000)
              )
            ]);
          } catch {
            remoteGitBaseline = null;
          }
        }
      }
      return turnUndo.beginTurn({
        sessionId,
        turnId,
        mode,
        runId,
        workspaceKind,
        workspaceRoot,
        runWorkspaceRoot: uri,
        remoteGitBaseline
      });
    },

    'undo.turn_finalize': ({ sessionId, turnId }) => {
      if (!turnUndo) return { ok: false, error: 'undo 未启用' };
      return turnUndo.finalizeTurn({ sessionId, turnId });
    },

    'undo.mark_worktree_only': ({ sessionId, turnId, runId }) => {
      if (!turnUndo) return { ok: false, error: 'undo 未启用' };
      return turnUndo.markWorktreeOnly({ sessionId, turnId, runId });
    },

    'undo.capture_plan_apply': ({ sessionId, turnId, paths, workspaceRoot }) => {
      if (!turnUndo) return { ok: false, error: 'undo 未启用' };
      return turnUndo.capturePlanApplyPaths({
        sessionId,
        turnId,
        paths,
        workspaceRoot: workspaceRoot || workspaceRootForUndo()
      });
    },

    'undo.capture_batch': async ({ sessionId, turnId, round, touchPaths, fullSnapshot }) => {
      if (!turnUndo) return { ok: false, error: 'undo 未启用' };
      const sid = String(sessionId || '').trim();
      const tid = String(turnId || '').trim();
      const record = turnUndo.getRecord(sid, tid);
      if (!record || record.rolledBack || record.strategy === 'worktree-only') {
        return { ok: false, skipped: true };
      }

      let merged = 0;
      /** @type {string[]} */
      let mergedKeys = [];
      if (record.strategy !== 'git') {
        const remote = getRemoteFs();
        if (remote && isSshConnectedForCall()) {
          try {
            const baseline = await captureRemoteGitWorkingBaseline(requireSshForCall(), remote.root);
            if (baseline.isGitRepo) {
              const mergeResult = mergeBaselineFilesInto(record.files, baseline.files);
              merged = mergeResult.merged || 0;
              mergedKeys = mergeResult.mergedKeys || [];
            }
          } catch {
            // ignore
          }
        } else {
          const root = workspaceRootForUndo();
          if (root && (await isGitRepo(root))) {
            try {
              const baseline = await captureGitWorkingBaseline(root);
              const mergeResult = mergeBaselineFilesInto(record.files, baseline.files);
              merged = mergeResult.merged || 0;
              mergedKeys = mergeResult.mergedKeys || [];
            } catch {
              // ignore
            }
          }
        }
      }

      const lastBatch = (record.batches || [])[record.batches.length - 1];
      const undoRoot = workspaceRootForUndo();
      const touchOnly =
        !fullSnapshot && Array.isArray(touchPaths) && touchPaths.length
          ? normalizeUndoTouchPaths(touchPaths, undoRoot)
          : null;
      const touchedPaths = [...mergedKeys, ...(touchOnly ? [...touchOnly] : [])];
      const filesSnapshot = await captureUndoCheckpointSnapshot(record.files, {
        touchOnly,
        lastBatchFiles: lastBatch && lastBatch.files
      });
      return turnUndo.captureBatchCheckpoint({
        sessionId: sid,
        turnId: tid,
        round,
        merged,
        touchedPaths,
        fullSnapshot: !!fullSnapshot,
        filesSnapshot
      });
    },

    'undo.rollback_batch': async ({ sessionId, turnId, batchId }) => {
      if (!turnUndo) {
        const e = new Error('undo 未启用');
        e.code = 'UNDO_DISABLED';
        throw e;
      }
      const plan = turnUndo.planRollbackBatch({ sessionId, turnId, batchId });
      if (!plan.ok) {
        const e = new Error(plan.error || '恢复 checkpoint 失败');
        e.code = 'UNDO_FAILED';
        throw e;
      }
      const runRestore = async () => {
        const errors = [];
        const batchRestore = await restoreUndoFilesConcurrent(plan.restore || [], 6);
        const restored = batchRestore.restored;
        errors.push(...batchRestore.errors);
        if (errors.length) {
          return {
            ok: false,
            strategy: plan.strategy,
            batchId: plan.batchId,
            restored,
            files: plan.files || [],
            errors,
            committed: false
          };
        }
        return {
          ok: true,
          strategy: plan.strategy,
          batchId: plan.batchId,
          restored,
          files: plan.files || [],
          errors: [],
          committed: false
        };
      };
      return runWithCallContext(undoRestoreCallContext(plan, sessionId), runRestore);
    },

    'undo.can_rollback': ({ sessionId, turnId }) => {
      if (!turnUndo) return { ok: true, can: false };
      return { ok: true, can: turnUndo.canRollback(sessionId, turnId) };
    },

    'undo.stack_get': ({ sessionId }) => {
      if (!turnUndo) return { ok: true, stack: [] };
      return { ok: true, stack: turnUndo.getStack(sessionId) };
    },

    'undo.rollback': async ({ sessionId, turnId }) => {
      if (!turnUndo) {
        const e = new Error('undo 未启用');
        e.code = 'UNDO_DISABLED';
        throw e;
      }
      const plan = turnUndo.planRollback({ sessionId, turnId });
      if (!plan.ok) {
        const e = new Error(plan.error || '撤回失败');
        e.code = 'UNDO_FAILED';
        throw e;
      }
      if (plan.strategy === 'worktree-only') {
        return {
          ok: true,
          strategy: plan.strategy,
          runId: plan.runId,
          restored: 0,
          files: [],
          needsWorktreeCleanup: true
        };
      }
      const runRestore = async () => {
        const errors = [];
        const batchRestore = await restoreUndoFilesConcurrent(plan.restore || [], 6);
        const restored = batchRestore.restored;
        errors.push(...batchRestore.errors);
        if (errors.length) {
          return {
            ok: false,
            strategy: plan.strategy,
            runId: plan.runId,
            restored,
            files: plan.files || [],
            errors,
            committed: false
          };
        }
        turnUndo.commitRollback({ sessionId, turnId });
        return {
          ok: true,
          strategy: plan.strategy,
          runId: plan.runId,
          restored,
          files: plan.files || [],
          errors: [],
          committed: true
        };
      };
      // 绑回该 turn 的工作区，避免并行/切会话后写到当前视图目录
      return runWithCallContext(undoRestoreCallContext(plan, sessionId), runRestore);
    },

    'undo.rollback_commit': ({ sessionId, turnId }) => {
      if (!turnUndo) return { ok: false, error: 'undo 未启用' };
      return turnUndo.commitRollback({ sessionId, turnId });
    },

    'undo.session_clear': ({ sessionId }) => {
      if (!turnUndo) return { ok: true };
      return turnUndo.clearSession(sessionId);
    },
  };
}

module.exports = { createUndoHandlers };

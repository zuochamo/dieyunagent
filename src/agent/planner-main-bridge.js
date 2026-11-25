'use strict';

const {
  ensureRunWorktree,
  resetRunWorktree,
  removeRunWorktree,
  listRunWorktreeRoles,
  runWorktreeBranch,
  runWorktreePath,
  previewRunWorktreeChanges,
  archiveRunWorktree,
  pruneRunWorktreeRoots,
  mergeRunWorktreeInto
} = require('../ssh/remote-run-worktree');

/**
 * Main 进程 AgentRunCoordinator / worktree / checkpoint 桥接（供 planner 使用）。
 *
 * worktree 一族方法对**本地与远端（SSH）**同一接口：`deps.resolveRemoteRunTarget(workspacePath)`
 * 能解析出远端目标就走远端实现，否则走本地 `worktreeService`。
 */
function createPlannerMainBridge(deps) {
  const coordinator = deps.coordinator;
  const worktreeService = deps.worktreeService;
  const subagentStore = deps.subagentStore;
  const dieyunHome = deps.dieyunHome;
  const workspaceRootPath = deps.workspaceRootPath;
  const resolveRemoteRunTarget = deps.resolveRemoteRunTarget || (() => null);

  /** 本轮工作区的远端目标（SSH）；null = 本地（或 SSH 未连接） */
  function remoteTarget() {
    try {
      return resolveRemoteRunTarget(workspaceRootPath()) || null;
    } catch {
      return null;
    }
  }

  /**
   * 一轮开跑前回收上一批漏下的 run 残留（已并入 HEAD 的 agent 分支 + 没人在用的 run 空壳）。
   * 语义全在 `worktreeService.sweepRunArtifacts`，这里只负责给仓库与本轮要保护的 runId。
   *
   * 为什么挂在这里而不是桌面启动：启动清扫只在 Renderer 活着时跑，无人值守（headless）
   * 与「进程被强杀」的残留永远没人收 —— 实测攒到 19 份 worktree（473 MB）/ 171 条分支。
   * runStart 是桌面与 headless 共用的唯一开跑点，且此刻新 run 的 worktree 还没建，
   * 续跑复用的 runId 由 protectRunIds 明确排除。
   */
  function sweepRunResidue(meta) {
    try {
      if (remoteTarget()) return null; // 远端会话的副本在服务器上，本地没有本轮的 worktree
      const root = workspaceRootPath();
      if (!root) return null;
      const runId = meta && meta.runId ? String(meta.runId).trim() : '';
      // 不 await：回收不能拖慢开跑；失败静默（内部逐项跳过，外层再兜一层）
      return worktreeService
        .sweepRunArtifacts(root, { protectRunIds: runId ? [runId] : [] })
        .catch(() => null);
    } catch {
      return null;
    }
  }

  return {
    runStart(meta) {
      if (!coordinator) return { ok: false, error: 'coordinator_unavailable' };
      void sweepRunResidue(meta);
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
      const remote = remoteTarget();
      if (remote) {
        // 远端（SSH）：每个执行器一份远端副本 `<repo>/.dieyun/worktrees/<runId>/<role>`。
        // 以前这里只走本地 `worktreeService`（纯本地 fs/git），远端会话必然失败 → 整批静默串行。
        try {
          return await ensureRunWorktree(remote.manager, {
            repoPath: remote.repoPath,
            runId,
            roleId,
            baseRef: baseRef || 'HEAD'
          });
        } catch (e) {
          return { ok: false, error: e.message || String(e) };
        }
      }
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
    async worktreeReset(wtPath, baseSha) {
      const remote = remoteTarget();
      if (remote && String(wtPath || '').startsWith(remote.repoPath)) {
        try {
          return await resetRunWorktree(remote.manager, { wtPath, baseSha });
        } catch (e) {
          return { ok: false, error: e.message || String(e) };
        }
      }
      const root = workspaceRootPath();
      if (!root) return { ok: false, error: '未设置工作空间' };
      try {
        return await worktreeService.resetAgentWorktree(root, wtPath, baseSha);
      } catch (e) {
        return { ok: false, error: e.message || String(e) };
      }
    },
    async worktreeCleanupRun(runId) {
      const remote = remoteTarget();
      if (remote) {
        try {
          const roles = await listRunWorktreeRoles(remote.manager, { repoPath: remote.repoPath, runId });
          const results = [];
          for (const roleId of roles) {
            // **先归档再删目录**（与本地 `cleanupRunWorktrees` 同口径）：UI 的「停止」是暂停，
            // 续跑复用同一 runId；以前这里直接 `branch -D`，一次停止就把各路未合并的产出
            // 连分支一起删掉，续跑只能从 HEAD 重建、活重做一遍（2026-11-19 实测的返工）。
            // 归档失败就保留副本（绝不静默降级成删除）。
            const wtPath = runWorktreePath(remote.repoPath, runId, roleId);
            const archived = await archiveRunWorktree(remote.manager, {
              wtPath,
              message: `dieyun: plan ${runId} · ${roleId}（停止时归档，未合并）`
            });
            if (!archived.ok && !archived.missing) {
              results.push({ roleId, ok: false, error: archived.error });
              continue;
            }
            const r = await removeRunWorktree(remote.manager, {
              repoPath: remote.repoPath,
              runId,
              roleId,
              // 分支必须留着：它就是归档出来的产出
              deleteBranch: false
            });
            results.push({ roleId, ...r, archived: !!archived.committed });
          }
          return { ok: results.every((r) => r.ok), removed: results.filter((r) => r.ok).length, errors: results.filter((r) => !r.ok) };
        } catch (e) {
          return { ok: false, error: e.message || String(e) };
        }
      }
      const root = workspaceRootPath();
      if (!root) return { ok: false, error: '未设置工作空间' };
      try {
        return await worktreeService.cleanupRunWorktrees(root, runId);
      } catch (e) {
        return { ok: false, error: e.message || String(e) };
      }
    },

    /**
     * 回收**过期**的 per-run 副本目录（远端才有成本：每个副本是一份完整 checkout）。
     * 先归档（提交进各自分支）再删目录、保留分支；本地由变更面板与清理脚本管，这里跳过。
     * @param {{ keep?: number, protectRunIds?: string[] }} [opts]
     */
    async worktreePruneRunCopies(opts = {}) {
      const remote = remoteTarget();
      if (!remote) return { ok: true, skipped: true };
      const keep = Math.max(0, Math.floor(Number(opts.keep) || 0));
      if (!keep) return { ok: true, skipped: true };
      try {
        return await pruneRunWorktreeRoots(remote.manager, {
          repoPath: remote.repoPath,
          keep,
          protectRunIds: opts.protectRunIds || []
        });
      } catch (e) {
        return { ok: false, error: e.message || String(e) };
      }
    },

    /**
     * 收尾：把远端各路副本的改动**并回会话副本**。本地路径是空操作（本地走 apply 面板）。
     *
     * 为什么在收尾就合并：SSH 会话的「变更」面板一直看的是**会话副本**，并回去之后用户
     * 的审阅/应用流程完全不变；不合并的话各路产出只躺在一堆没人能找到的 per-role 目录里。
     */
    async worktreeFinalizeRun(runId) {
      const remote = remoteTarget();
      if (!remote) return { ok: true, skipped: true };
      try {
        const roles = await listRunWorktreeRoles(remote.manager, { repoPath: remote.repoPath, runId });
        const merged = [];
        const failed = [];
        for (const roleId of roles) {
          const branch = runWorktreeBranch(runId, roleId);
          const wtPath = runWorktreePath(remote.repoPath, runId, roleId);
          const r = await mergeRunWorktreeInto(remote.manager, {
            wtPath,
            branch,
            targetWtPath: remote.sessionWtPath,
            message: `dieyun: plan ${runId} · ${roleId}`
          });
          if (r.ok) {
            merged.push({ roleId, merged: !!r.merged });
            // 合并成功（含「这一路没改动」）就把副本收掉：提交已经并进会话副本的历史，
            // 再留着 per-role 目录只会无限增长（远端没有本地的容量策略在扫）。
            // 冲突 / 失败时**保留**，那是还需要人看的东西。
            try {
              await removeRunWorktree(remote.manager, {
                repoPath: remote.repoPath,
                runId,
                roleId,
                deleteBranch: true
              });
            } catch {
              // 收不掉不影响这次交付
            }
          } else {
            failed.push({
              roleId,
              conflict: !!r.conflict,
              paths: r.paths || [],
              wtPath,
              branch,
              error: r.error || ''
            });
          }
        }
        return { ok: failed.length === 0, merged, failed };
      } catch (e) {
        return { ok: false, error: e.message || String(e) };
      }
    },
    async worktreePreviewRun(runId) {
      const remote = remoteTarget();
      if (remote) {
        // 远端：读各路副本相对**各自基线**的变更（与本地同形状）。
        // 以前这里没有 remote 分支，读到的是本机不存在的路径 → 空 diff →
        // 验收 prompt 的 worktreeChanges 为空，「声称改了却零 diff」的规则整条失效。
        try {
          return await previewRunWorktreeChanges(remote.manager, {
            repoPath: remote.repoPath,
            runId
          });
        } catch (e) {
          return { ok: false, error: e.message || String(e), changes: [] };
        }
      }
      const root = workspaceRootPath();
      if (!root) return { ok: false, error: '未设置工作空间', changes: [] };
      try {
        return await worktreeService.previewRunWorktreeChanges(root, runId);
      } catch (e) {
        return { ok: false, error: e.message || String(e), changes: [] };
      }
    },
    async worktreeApplyRun(runId, paths, forceConflict, changeIds, applyOpts) {
      const remote = remoteTarget();
      if (remote) {
        // 远端**没有**逐文件应用这一步：各路副本在收尾时 `commit + merge --no-ff` 并回会话副本，
        // 用户审阅的是会话副本自己的 diff（远端 fs/diff 通道）。这里如实拒绝，
        // 而不是拿远端路径去调本地实现（会静默返回空结果）。
        return {
          ok: false,
          remote: true,
          error:
            '远端（SSH）会话不支持逐文件应用：各路执行器的改动已在收尾时合并回会话副本，请在「变更」面板审阅会话副本的改动'
        };
      }
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

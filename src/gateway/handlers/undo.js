'use strict';

const { gitTargetForWorkspace, rollbackToTree } = require('../../git/turn-tree');

/** 快照撤不到的路径类型：shell 命令改的文件逐文件捕获不到（见 git/turn-tree.js 头注释） */
const SHELL_UNCOVERED_WARNING =
  '本轮有 shell 命令（host_exec）改过文件，撤回快照逐文件记不到它们，只能靠回合开始时的 git 树撤回。' +
  '这次工作区不是 git 仓库（或拿不到回合开始树），这些改动没有还原。';

/**
 * 本轮把改动提交过（HEAD 变了）：`git diff <回合开始树>` 与工作区一致，看不出差异，
 * 但那些改动还在提交里 —— 只报「已恢复 N 个文件」就是又一次「撤回成功、代码还在」。
 */
const HEAD_MOVED_WARNING =
  '本轮 HEAD 变过（改动已被提交）：工作区已回到回合开始的样子，但提交里的改动没有被撤回，' +
  '要彻底退回请在仓库里自行 git reset（本功能不改写历史）。';

/** 快照内容被体积预算丢弃：git 树盖得住已跟踪文件，盖不住未跟踪文件的原文 */
const SNAPSHOT_DROPPED_WARNING =
  '该回合的部分「改前内容」已按体积预算丢弃：已跟踪文件按回合开始树还原了，' +
  '但未跟踪文件的原文无法还原（已被修改的会保持现状）。';

function createUndoHandlers(d) {
  const {
    turnUndo,
    getActiveRunWorkspaceRoot,
    isSshConnectedForCall,
    getRemoteFs,
    captureRemoteGitWorkingBaseline,
    captureGitWorkingBaseline,
    mergeBaselineFilesInto,
    requireSshForCall,
    workspaceRootForUndo,
    normalizeUndoTouchPaths,
    captureUndoCheckpointSnapshot,
    restoreUndoFilesConcurrent,
    runWithCallContext,
    undoRestoreCallContext,
    inferUndoWorkspaceKind
  } = d;
  return {
    'undo.turn_begin': async ({ sessionId, turnId, workspaceKind, workspaceRoot, runWorkspaceRoot }) => {
      if (!turnUndo) return { ok: false, error: 'undo 未启用' };
      /** @type {{ isGitRepo?: boolean, head?: string, stashSha?: string, untracked?: string[]|null, files?: Record<string, unknown> } | null} */
      let remoteGitBaseline = null;
      const uri = runWorkspaceRoot || getActiveRunWorkspaceRoot() || null;
      // 「这一轮到底在不在远端工作区」只有一处判据（service 的 inferUndoWorkspaceKind），
      // 这里不再自己重写 `workspaceKind === 'ssh' || /^ssh:/i.test(uri)`。
      const kind = inferUndoWorkspaceKind({ workspaceKind, workspaceRoot, runWorkspaceRoot: uri });
      if (kind === 'ssh' && (workspaceRoot || uri) && isSshConnectedForCall()) {
        const remote = getRemoteFs();
        if (remote) {
          try {
            remoteGitBaseline = await Promise.race([
              captureRemoteGitWorkingBaseline(requireSshForCall(), remote.root, { turnStartState: true }),
              new Promise((_, reject) =>
                // 基线要多两次 git 往返（`stash create` 建回合开始树、`ls-files` 记未跟踪清单），
                // 20s 在脏文件多的仓库上不够；超时就退回快照撤回（并诚实告知覆盖不到 shell 改动）。
                setTimeout(() => reject(new Error('remote git baseline timeout')), 30000)
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
        workspaceKind: kind,
        workspaceRoot,
        runWorkspaceRoot: uri,
        remoteGitBaseline
      });
    },

    'undo.turn_finalize': ({ sessionId, turnId }) => {
      if (!turnUndo) return { ok: false, error: 'undo 未启用' };
      return turnUndo.finalizeTurn({ sessionId, turnId });
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
      if (!record || record.rolledBack) {
        return { ok: false, skipped: true };
      }

      // 非 git 策略：每批补一次「当前 git 脏文件内容」，让下一批的 checkpoint 有个像样的起点
      // （git 策略在回合开始就已经收过基线，不重复扫）。
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
            // 补基线失败不该毁掉这批 checkpoint
          }
        } else {
          const root = workspaceRootForUndo();
          if (root) {
            try {
              // 「是不是仓库 / 有哪些脏文件」由基线捕获回答（不再先单独 isGitRepo 一次）
              const baseline = await captureGitWorkingBaseline(root);
              if (baseline.isRepo) {
                const mergeResult = mergeBaselineFilesInto(record.files, baseline.files);
                merged = mergeResult.merged || 0;
                mergedKeys = mergeResult.mergedKeys || [];
              }
            } catch {
              // 同上
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
        // 单检查点没有 git 树可比对：本轮用过 shell 就明说「这些路径没还原」，不许假成功
        const warning = plan.shellMutated ? SHELL_UNCOVERED_WARNING : '';
        if (errors.length) {
          return {
            ok: false,
            strategy: plan.strategy,
            batchId: plan.batchId,
            restored,
            files: plan.files || [],
            errors,
            warning,
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
          warning,
          committed: false
        };
      };
      return runWithCallContext(undoRestoreCallContext(plan, sessionId), runRestore);
    },

    'undo.can_rollback': ({ sessionId, turnId }) => {
      if (!turnUndo) return { ok: true, can: false };
      return { ok: true, can: turnUndo.canRollback(sessionId, turnId) };
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
      const hasGitTree = plan.strategy === 'git' && !!plan.gitStashSha;
      /** git 树回滚的执行目标（会话作用域：远端就走这条会话自己的 ssh） */
      let gitTargetFailure = '';
      const gitTarget = () => {
        if (!hasGitTree) return null;
        try {
          const sshExec =
            plan.workspaceKind === 'ssh'
              ? (command, cwd, timeoutMs) => requireSshForCall().exec(command, cwd, timeoutMs)
              : undefined;
          return gitTargetForWorkspace(plan, { sshExec });
        } catch (err) {
          // 拿不到目标（SSH 断了 / 没有工作区根）：留成错误项，别把整次撤回抛断
          gitTargetFailure = (err && err.message) || String(err);
          return null;
        }
      };
      const runRestore = async () => {
        const errors = [];
        /** git 树已经处理过的路径：不再拿快照内容写一遍（快照里的「改前」可能正是改过之后的内容） */
        const gitHandled = new Set();
        let gitRestored = 0;
        let uncovered = [];
        let headMoved = false;
        const target = gitTarget();
        if (target) {
          try {
            const tree = await rollbackToTree(target, plan.gitStashSha, {
              untrackedAtStart: plan.gitUntrackedAtStart,
              headAtStart: plan.gitHead
            });
            for (const p of tree.handled) gitHandled.add(p);
            gitRestored = tree.restored + tree.removed;
            errors.push(...tree.errors);
            uncovered = tree.uncovered || [];
            headMoved = !!tree.headMoved;
          } catch (err) {
            errors.push({ path: '', error: (err && err.message) || String(err) });
          }
        } else if (hasGitTree) {
          // 有回合开始树却没有可用的仓库目标（SSH 断了 / 工作区根丢了）：不许悄悄退成快照撤回
          errors.push({
            path: '',
            error: gitTargetFailure
              ? `无法按回合开始树撤回：${gitTargetFailure}`
              : '拿不到该回合的工作区根，无法按回合开始树撤回'
          });
        }
        // 快照兜底：git 树没覆盖的路径（未跟踪的新建 / 未跟踪目录里的文件）
        const snapshotItems = (plan.restore || []).filter((item) => !gitHandled.has(item.path));
        const snap = await restoreUndoFilesConcurrent(snapshotItems, 6);
        errors.push(...snap.errors);
        // 复核没干净：如实报错，不提交撤回（提交了就再也没法重试）
        for (const p of uncovered) {
          errors.push({ path: p, error: '撤回后仍与回合开始不一致（未能还原）' });
        }
        const warningParts = [];
        if (!hasGitTree && plan.shellMutated) warningParts.push(SHELL_UNCOVERED_WARNING);
        if (plan.snapshotDropped && hasGitTree) warningParts.push(SNAPSHOT_DROPPED_WARNING);
        if (headMoved) warningParts.push(HEAD_MOVED_WARNING);
        const warning = warningParts.join(' ');
        const restored = snap.restored + gitRestored;
        if (errors.length) {
          return {
            ok: false,
            strategy: plan.strategy,
            restored,
            files: plan.files || [],
            errors,
            uncovered,
            warning,
            committed: false
          };
        }
        turnUndo.commitRollback({ sessionId, turnId });
        return {
          ok: true,
          strategy: plan.strategy,
          restored,
          files: plan.files || [],
          errors: [],
          uncovered: [],
          warning,
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
    }
  };
}

module.exports = { createUndoHandlers };

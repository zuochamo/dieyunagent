'use strict';

const fs = require('fs');
const { normalizeRemotePath } = require('../workspace/target');
const { repoRemotePathOf, remoteWorktreeBranch } = require('../ssh/remote-worktree');

/**
 * Worktree 动作的**唯一实现**：设置页「副本」面板与 Agent 工具 `worktree` 共用。
 *
 * 原先 13 个 `worktree:*` handler 各写一遍「取仓库根 → 调 service」，Agent 侧一个工具都没有：
 * 用户让 Agent「先开个副本再改，别动我的分支」时它只能直接改主工作区。
 * 这里把「仓库上下文解析」和每个动作收成一份；IPC 与工具都只做转发。
 *
 * 依赖用取值函数传入（启动期服务可能还没建好）。
 *
 * @param {{ getLocalGateway: () => object|null, getWorktreeService: () => object }} ctx
 */
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

function createWorktreeActions(ctx) {
  const deps = ctx && typeof ctx === 'object' ? ctx : {};
  const getLocalGateway = typeof deps.getLocalGateway === 'function' ? deps.getLocalGateway : () => null;
  const getService = () => (typeof deps.getWorktreeService === 'function' ? deps.getWorktreeService() : null);

  /** 每个动作的共同前置：仓库上下文 + service 可用性 */
  function context(extra) {
    const repo = resolveWorktreeRepoContext(getLocalGateway);
    if (!repo.ok) return { ok: false, failure: worktreeContextFailure(repo, extra) };
    const service = getService();
    if (!service) return { ok: false, failure: { ok: false, error: 'Worktree 服务未就绪' } };
    return { ok: true, repoPath: repo.repoPath, service };
  }

  async function run(method, args, extra) {
    const c = context(extra);
    if (!c.ok) return c.failure;
    try {
      return await c.service[method](c.repoPath, ...args);
    } catch (e) {
      return { ok: false, error: (e && e.message) || String(e), ...(extra || {}) };
    }
  }

  return {
    resolveWorktreeRepoContext: () => resolveWorktreeRepoContext(getLocalGateway),
    list: () => run('listWorktrees', []),
    create: (payload = {}) =>
      run('createAgentWorktree', [
        { runId: payload.runId, roleId: payload.roleId, baseRef: payload.baseRef }
      ]),
    remove: (payload = {}) => run('removeAgentWorktree', [payload.path || payload.wtPath]),
    cleanupRun: (payload = {}) =>
      run('cleanupRunWorktrees', [
        payload.runId,
        {
          archive: payload.archive !== false,
          allowDiscardUncommitted: !!payload.allowDiscardUncommitted,
          deleteBranches: !!payload.deleteBranches
        }
      ]),
    pruneBranches: (payload = {}) => run('pruneRunBranches', [payload || {}]),
    listManaged: () => run('listManagedWorktreeRuns', []),
    previewRun: (payload = {}) => run('previewRunWorktreeChanges', [payload.runId], { changes: [] }),
    applyRun: (payload = {}) =>
      run('applyRunWorktreeChanges', [
        payload.runId,
        {
          paths: payload.paths || [],
          changeIds: payload.changeIds || [],
          forceConflict: !!payload.forceConflict,
          forceChangeIds: payload.forceChangeIds || [],
          allowOverwriteMainDirty: !!payload.allowOverwriteMainDirty
        }
      ]),
    changeDiff: (payload = {}) =>
      run('getWorktreeChangeDiff', [payload.change || {}], { patch: '' })
  };
}

/**
 * 远端会话副本（SSH 工作区里每个会话一个 worktree）：预览/写回。
 * 与本地那套的区别是「副本在哪」—— 这里靠会话的远端工作区路径推，不看本地 workspace。
 * @returns {{ ok: true, sid, repoPath, wtPath, branch, manager } | { ok: false, code, error, files: [] }}
 */
function resolveRemoteSessionWorktree(ctx, payload) {
  const fail = (code, error) => ({ ok: false, code, error, files: [] });
  const localGateway = ctx.getLocalGateway();
  if (!localGateway) return fail('no_gateway', 'Gateway 未就绪');
  const sid = String((payload && payload.sessionId) || localGateway.activeSessionId || '').trim();
  if (!sid) return fail('no_session', '没有活动会话');
  const target =
    typeof localGateway.getSessionWorkspaceTarget === 'function'
      ? localGateway.getSessionWorkspaceTarget(sid)
      : null;
  if (!target || target.kind !== 'ssh') return fail('not_remote', '当前会话不是 SSH 远程工作区');
  const wtPath = normalizeRemotePath(target.remotePath);
  const repoPath = repoRemotePathOf(wtPath);
  if (repoPath === wtPath) return fail('not_session_worktree', '当前会话的工作区就是主目录，没有独立副本');
  const pool = typeof ctx.getSshConnectionPool === 'function' ? ctx.getSshConnectionPool() : null;
  if (!pool) return fail('ssh_not_connected', 'SSH 未连接');
  const manager = pool.getConnectedManager(target) || pool.getManagerForTarget(target);
  if (!manager || typeof manager.status !== 'function' || !manager.status().connected) {
    return fail('ssh_not_connected', 'SSH 未连接');
  }
  return { ok: true, sid, repoPath, wtPath, branch: remoteWorktreeBranch(sid), manager };
}

module.exports = {
  createWorktreeActions,
  resolveWorktreeRepoContext,
  resolveRemoteSessionWorktree
};

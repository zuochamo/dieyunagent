/* global window, gwState, gatewayCall, currentSessionId, messages, invalidateWorkspaceArtifacts, clearArtifacts, showAgentToast, getAgentLimits */
'use strict';

function maxUndoSteps() {
  return typeof getAgentLimits === 'function' ? getAgentLimits().maxUndoSteps : 5;
}

/** sessionId -> active undo turnId for that session's in-flight run */
const sessionUndoTurnIds = new Map();

/** sessionId -> turnId -> userMsgIndex */
const turnMsgIndexBySession = new Map();

/** sessionId:turnId -> in-flight batch capture */
const batchCaptureInflight = new Map();

/** sessionId -> last RPC timeout warn timestamp */
const batchCaptureTimeoutWarnAt = new Map();

/** sessionId:turnId -> in-flight whole-turn rollback */
const turnRollbackInflight = new Map();

function createUndoTurnId() {
  return `turn-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function getUndoTurnIdForSession(sessionId) {
  const sid = String(sessionId || '').trim();
  if (!sid) return null;
  return sessionUndoTurnIds.get(sid) || null;
}

function getCurrentUndoTurnId() {
  return getUndoTurnIdForSession(currentSessionId);
}

function rememberTurnMsgIndex(sessionId, turnId, userMsgIndex) {
  const sid = String(sessionId || '');
  if (!sid || !turnId) return;
  if (!turnMsgIndexBySession.has(sid)) turnMsgIndexBySession.set(sid, new Map());
  turnMsgIndexBySession.get(sid).set(String(turnId), userMsgIndex);
}

function workspaceFromSessionPath(workspacePath) {
  if (!workspacePath) return { kind: 'local', workspaceRoot: null };
  const s = String(workspacePath).trim();
  if (/^ssh:/i.test(s)) {
    const m = s.match(/^ssh:(?:\/\/)?[^@/]+@[^/:]+(?::\d+)?(\/.*)?$/i);
    return { kind: 'ssh', workspaceRoot: (m && m[1] ? m[1] : '/') || '/' };
  }
  return { kind: 'local', workspaceRoot: s };
}

async function resolveWorkspaceForUndo() {
  try {
    const api = window.diecloud || {};
    const ws = api.getWorkspace ? await api.getWorkspace() : null;
    if (!ws) return { kind: 'local', workspaceRoot: null };
    if (ws.kind === 'ssh') {
      return { kind: 'ssh', workspaceRoot: ws.remotePath || ws.workspacePath || null };
    }
    return { kind: 'local', workspaceRoot: ws.workspacePath || null };
  } catch {
    return { kind: 'local', workspaceRoot: null };
  }
}

async function resolveWorkspaceForUndoSession(sessionId, workspacePath) {
  if (workspacePath) return workspaceFromSessionPath(workspacePath);
  if (String(sessionId) === String(currentSessionId)) return resolveWorkspaceForUndo();
  return { kind: 'local', workspaceRoot: null };
}

function patchUserMessageUndoMeta(userMsgIndex, turnId) {
  if (userMsgIndex < 0 || !turnId) return;
  const msg = messages && messages[userMsgIndex];
  if (!msg || msg.role !== 'user') return;
  msg.meta = { ...(msg.meta || {}), undoTurnId: turnId };
}

/**
 * @param {{ mode?: 'agent'|'plan', userMsgIndex: number, runId?: string|null, sessionId?: string, workspacePath?: string|null }} opts
 */
async function beginTurnUndo(opts) {
  if (typeof getComposerLongHorizon === 'function' && getComposerLongHorizon()) return null;
  const sessionId = String((opts && opts.sessionId) || currentSessionId || '').trim();
  if (!gwState.authed || !sessionId) return null;
  const turnId = createUndoTurnId();
  sessionUndoTurnIds.set(sessionId, turnId);
  rememberTurnMsgIndex(sessionId, turnId, opts.userMsgIndex);
  patchUserMessageUndoMeta(opts.userMsgIndex, turnId);
  const ws = await resolveWorkspaceForUndoSession(sessionId, opts && opts.workspacePath);
  const mode = opts && opts['mode'] === 'plan' ? 'plan' : 'agent';
  try {
    await gatewayCall(
      'undo.turn_begin',
      {
        sessionId,
        turnId,
        mode,
        runId: opts && opts.runId ? opts.runId : null,
        workspaceKind: ws.kind,
        workspaceRoot: ws.workspaceRoot,
        ...(opts && opts.workspacePath ? { runWorkspaceRoot: opts.workspacePath } : {})
      },
      { timeoutMs: 90000 }
    );
    return turnId;
  } catch (e) {
    console.warn(e);
    if (sessionUndoTurnIds.get(sessionId) === turnId) sessionUndoTurnIds.delete(sessionId);
    return null;
  }
}

async function finalizeTurnUndo(turnId, sessionId) {
  const sid = String(sessionId || currentSessionId || '').trim();
  if (!gwState.authed || !sid || !turnId) return;
  if (sessionUndoTurnIds.get(sid) === turnId) sessionUndoTurnIds.delete(sid);
  try {
    await gatewayCall('undo.turn_finalize', { sessionId: sid, turnId });
  } catch (e) {
    console.warn(e);
  }
}

async function markTurnWorktreeOnly(turnId, runId, sessionId) {
  const sid = String(sessionId || currentSessionId || '').trim();
  if (!gwState.authed || !sid || !turnId || !runId) return;
  try {
    await gatewayCall('undo.mark_worktree_only', {
      sessionId: sid,
      turnId,
      runId
    });
  } catch (e) {
    console.warn(e);
  }
}

async function capturePlanApplyForUndo(turnId, paths, workspaceRoot, sessionId) {
  const sid = String(sessionId || currentSessionId || '').trim();
  if (!gwState.authed || !sid || !turnId || !paths || !paths.length) return;
  try {
    await gatewayCall('undo.capture_plan_apply', {
      sessionId: sid,
      turnId,
      paths,
      workspaceRoot,
      ...(workspaceRoot ? { runWorkspaceRoot: workspaceRoot } : {})
    });
  } catch (e) {
    console.warn(e);
  }
}

async function canRollbackTurn(turnId, sessionId) {
  const sid = String(sessionId || currentSessionId || '').trim();
  if (!gwState.authed || !sid || !turnId) return false;
  try {
    const r = await gatewayCall('undo.can_rollback', { sessionId: sid, turnId });
    return !!(r && r.can);
  } catch {
    return false;
  }
}

/** Finalize an in-flight turn when possible so file rollback can proceed (no-op if already ready). */
async function prepareTurnForWithdraw(turnId, sessionId) {
  const sid = String(sessionId || currentSessionId || '').trim();
  if (!gwState.authed || !sid || !turnId) return { canRollbackFiles: false };
  let allowed = await canRollbackTurn(turnId, sid);
  if (allowed) return { canRollbackFiles: true };
  try {
    await finalizeTurnUndo(turnId, sid);
  } catch (e) {
    console.warn(e);
  }
  allowed = await canRollbackTurn(turnId, sid);
  return { canRollbackFiles: !!allowed };
}

async function rollbackTurnFiles(turnId, sessionId, runWorkspaceRoot) {
  const sid = String(sessionId || currentSessionId || '').trim();
  if (!gwState.authed || !sid || !turnId) {
    return { ok: false, error: '未连接 Gateway' };
  }
  const inflightKey = `${sid}:${turnId}`;
  if (turnRollbackInflight.has(inflightKey)) {
    return { ok: false, error: '文件恢复正在进行中' };
  }
  turnRollbackInflight.set(inflightKey, true);
  try {
    const r = await gatewayCall('undo.rollback', {
      sessionId: sid,
      turnId,
      ...(runWorkspaceRoot ? { runWorkspaceRoot } : {})
    });
    if (r && r.needsWorktreeCleanup && r.runId) {
      const api = window.diecloud || {};
      if (api.worktreeCleanupRun) {
        try {
          await api.worktreeCleanupRun(r.runId);
        } catch (e) {
          return { ok: false, error: e.message || String(e), strategy: r.strategy, committed: false };
        }
      }
      try {
        await gatewayCall('undo.rollback_commit', { sessionId: sid, turnId });
        r.committed = true;
      } catch (e) {
        return { ok: false, error: e.message || String(e), strategy: r.strategy, committed: false };
      }
    }
    // 仅当前可见会话才清侧栏；后台会话撤回勿污染当前文件区
    if (String(currentSessionId || '') === sid) {
      if (typeof invalidateWorkspaceArtifacts === 'function') invalidateWorkspaceArtifacts();
      if (typeof clearArtifacts === 'function') clearArtifacts();
    }
    return r || { ok: false };
  } finally {
    turnRollbackInflight.delete(inflightKey);
  }
}

function extractUndoTouchPathsFromTools(tools) {
  const paths = [];
  let fullSnapshot = false;
  for (const t of tools || []) {
    const name = String(t.name || '').trim();
    if (name === 'host_exec') {
      fullSnapshot = true;
      continue;
    }
    if (
      name !== 'fs_write_file' &&
      name !== 'fs_edit' &&
      name !== 'host_print_image' &&
      name !== 'skill_create' &&
      name !== 'plan_create' &&
      name !== 'plan_delete' &&
      name !== 'agents_md_propose' &&
      name !== 'playbook_propose'
    ) {
      continue;
    }
    const args = t.toolArgs && typeof t.toolArgs === 'object' ? t.toolArgs : {};
    for (const key of ['path', 'filePath', 'file', 'targetPath', 'target']) {
      if (typeof args[key] === 'string' && args[key].trim()) paths.push(args[key].trim());
    }
    if (Array.isArray(args.paths)) {
      for (const p of args.paths) {
        if (typeof p === 'string' && p.trim()) paths.push(p.trim());
      }
    }
  }
  return { touchPaths: paths, fullSnapshot };
}

async function captureTurnBatchCheckpoint(opts = {}) {
  if (typeof getComposerLongHorizon === 'function' && getComposerLongHorizon()) return null;
  const sessionId = String(opts.sessionId || currentSessionId || '').trim();
  if (!gwState.authed || !sessionId) return null;
  const turnId =
    opts.turnId ||
    getUndoTurnIdForSession(sessionId) ||
    (typeof getCurrentUndoTurnId === 'function' ? getCurrentUndoTurnId() : null);
  if (!turnId) return null;
  const inflightKey = `${sessionId}:${turnId}`;
  if (batchCaptureInflight.has(inflightKey)) return null;
  batchCaptureInflight.set(inflightKey, true);
  let touchPaths;
  let fullSnapshot = false;
  if (Array.isArray(opts.tools) && opts.tools.length) {
    const extracted = extractUndoTouchPathsFromTools(opts.tools);
    touchPaths = extracted.touchPaths;
    fullSnapshot = extracted.fullSnapshot;
  }
  try {
    return await gatewayCall('undo.capture_batch', {
      sessionId,
      turnId,
      round: opts.round,
      ...(touchPaths && touchPaths.length ? { touchPaths } : {}),
      ...(fullSnapshot ? { fullSnapshot: true } : {}),
      ...(opts.runWorkspaceRoot ? { runWorkspaceRoot: opts.runWorkspaceRoot } : {})
    });
  } catch (e) {
    const msg = e && e.message ? String(e.message) : String(e);
    if (msg.includes('Gateway RPC 超时')) {
      const now = Date.now();
      const last = batchCaptureTimeoutWarnAt.get(sessionId) || 0;
      if (now - last > 120000) {
        batchCaptureTimeoutWarnAt.set(sessionId, now);
        console.warn('undo 批次 checkpoint 较慢或超时，中间轮次 checkpoint 可能缺失（整轮撤回仍可用）');
      }
    } else {
      console.warn(e);
    }
    return null;
  } finally {
    batchCaptureInflight.delete(inflightKey);
  }
}

async function rollbackToBatchCheckpoint(turnId, batchId, sessionId, runWorkspaceRoot) {
  const sid = String(sessionId || currentSessionId || '').trim();
  if (!gwState.authed || !sid || !turnId || !batchId) {
    return { ok: false, error: '未连接 Gateway' };
  }
  const r = await gatewayCall('undo.rollback_batch', {
    sessionId: sid,
    turnId,
    batchId,
    ...(runWorkspaceRoot ? { runWorkspaceRoot } : {})
  });
  if (typeof invalidateWorkspaceArtifacts === 'function') invalidateWorkspaceArtifacts();
  if (typeof clearArtifacts === 'function') clearArtifacts();
  return r || { ok: false };
}

function clearSessionUndo(sessionId) {
  const sid = String(sessionId || '');
  sessionUndoTurnIds.delete(sid);
  turnMsgIndexBySession.delete(sid);
  if (gwState.authed && sid) {
    gatewayCall('undo.session_clear', { sessionId: sid }).catch(() => {});
  }
}

function initUndoStackUI() {
  // no-op; hooks live in chat-render + agent-loop
}

window.getUndoTurnIdForSession = getUndoTurnIdForSession;
window.getCurrentUndoTurnId = getCurrentUndoTurnId;
window.beginTurnUndo = beginTurnUndo;
window.finalizeTurnUndo = finalizeTurnUndo;
window.markTurnWorktreeOnly = markTurnWorktreeOnly;
window.capturePlanApplyForUndo = capturePlanApplyForUndo;
window.captureTurnBatchCheckpoint = captureTurnBatchCheckpoint;
window.rollbackToBatchCheckpoint = rollbackToBatchCheckpoint;
window.canRollbackTurn = canRollbackTurn;
window.prepareTurnForWithdraw = prepareTurnForWithdraw;
window.rollbackTurnFiles = rollbackTurnFiles;
window.clearSessionUndo = clearSessionUndo;
Object.defineProperty(window, 'MAX_UNDO_STEPS', { get: maxUndoSteps, configurable: true });

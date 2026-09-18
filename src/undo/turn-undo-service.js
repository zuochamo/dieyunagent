'use strict';

const fs = require('fs/promises');
const fsSync = require('fs');
const path = require('path');
const { captureGitWorkingBaseline } = require('../git/baseline-capture');
const { isGitRepo } = require('../git/worktree-service');
const { createTurnUndoStore } = require('./turn-undo-store');
const { normalizeRemotePath, parseWorkspaceInput } = require('../workspace/target');

const MAX_STACK = 5;
const MAX_BATCHES_PER_TURN = 32;

function cloneFilesMap(files) {
  return JSON.parse(JSON.stringify(files || {}));
}

function isRemoteUndoKind(kind) {
  return kind === 'ssh';
}

function inferUndoWorkspaceKind(input) {
  if (input.workspaceKind === 'ssh') return input.workspaceKind;
  const uri = String(input.runWorkspaceRoot || input.workspaceRoot || '').trim();
  if (/^ssh:/i.test(uri)) return 'ssh';
  return 'local';
}

/** Local roots may be resolved; SSH roots stay POSIX (never path.resolve on Windows). */
function normalizeUndoWorkspaceRoot(kind, workspaceRoot) {
  if (!workspaceRoot) return null;
  const raw = String(workspaceRoot).trim();
  if (!raw) return null;
  if (isRemoteUndoKind(kind) || /^ssh:/i.test(raw)) {
    const parsed = parseWorkspaceInput(raw);
    if (parsed && parsed.kind === 'ssh') {
      return normalizeRemotePath(parsed.remotePath);
    }
    const posixish = raw.replace(/\\/g, '/').replace(/^[A-Za-z]:/, '');
    return normalizeRemotePath(posixish);
  }
  return path.resolve(raw);
}

function normalizeUndoRunWorkspaceRoot(kind, runWorkspaceRoot, workspaceRoot) {
  const uri = runWorkspaceRoot ? String(runWorkspaceRoot).trim() : '';
  if (uri && /^ssh:/i.test(uri)) return uri;
  if (workspaceRoot && /^ssh:/i.test(String(workspaceRoot))) {
    return String(workspaceRoot).trim();
  }
  if (isRemoteUndoKind(kind)) return uri || null;
  return uri || (workspaceRoot ? String(workspaceRoot).trim() : null);
}

function restoreIsRemote(record, meta) {
  return !!(
    (meta && meta.remote) ||
    isRemoteUndoKind(record && record.workspaceKind)
  );
}

/**
 * @typedef {'git'|'snapshot'|'worktree-only'} UndoStrategy
 * @typedef {{
 *   turnId: string,
 *   sessionId: string,
 *   mode: 'agent'|'plan',
 *   strategy: UndoStrategy,
 *   runId: string|null,
 *   gitHead: string|null,
 *   files: Record<string, { before: string|null, encoding: 'utf8'|'base64', remote?: boolean }>,
 *   batches: Array<{ id: string, round: number, files: Record<string, { before: string|null, encoding: 'utf8'|'base64', remote?: boolean }>, createdAt: number }>,
 *   planApplied: boolean,
 *   rolledBack: boolean,
 *   createdAt: number,
 *   finalized: boolean,
 *   touchedPaths?: string[]
 * }} TurnUndoRecord
 */

/**
 * @param {{ userDataPath?: string }} [opts]
 */
function createTurnUndoService(opts = {}) {
  /** @type {Map<string, { activeTurnId: string|null, stack: string[], records: Map<string, TurnUndoRecord> }>} */
  const sessions = new Map();
  const store = opts.userDataPath ? createTurnUndoStore(opts.userDataPath) : null;

  function persistSession(sessionId, opts = {}) {
    if (!store) return;
    const st = sessions.get(String(sessionId || '').trim());
    if (!st) return;
    if (opts.immediate) {
      store.writeSessionSync(sessionId, st);
      return;
    }
    store.scheduleSave(sessionId, st);
  }

  function sessionState(sessionId) {
    const id = String(sessionId || '').trim();
    if (!id) return null;
    if (!sessions.has(id)) {
      const loaded = store ? store.loadSessionSync(id) : null;
      if (loaded) {
        sessions.set(id, loaded);
      } else {
        sessions.set(id, { activeTurnId: null, stack: [], records: new Map() });
      }
    }
    return sessions.get(id);
  }

  function relKey(filePath, workspaceRoot) {
    const fp = String(filePath || '').replace(/\\/g, '/');
    const root = workspaceRoot ? String(workspaceRoot).replace(/\\/g, '/').replace(/\/+$/, '') : '';
    if (root && (fp === root || fp.startsWith(root + '/'))) {
      return fp.slice(root.length + 1);
    }
    return fp;
  }

  function trimStack(st) {
    while (st.stack.length > MAX_STACK) {
      const oldId = st.stack.shift();
      if (oldId) st.records.delete(oldId);
    }
  }

  function markTouchedPaths(record, paths) {
    if (!record || !paths) return;
    if (!Array.isArray(record.touchedPaths)) record.touchedPaths = [];
    const seen = new Set(record.touchedPaths);
    for (const raw of paths) {
      const key = String(raw || '').replace(/\\/g, '/').trim();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      record.touchedPaths.push(key);
    }
  }

  function rollbackRestorePaths(record) {
    if (!record || !record.files) return [];
    if (Array.isArray(record.touchedPaths)) {
      return record.touchedPaths.filter(Boolean);
    }
    return Object.keys(record.files);
  }

  /**
   * @param {{
   *   sessionId: string,
   *   turnId: string,
   *   mode?: 'agent'|'plan',
   *   runId?: string|null,
   *   workspaceKind?: 'local'|'ssh',
   *   workspaceRoot?: string|null,
   *   remoteGitBaseline?: { isGitRepo?: boolean, head?: string, files?: Record<string, unknown> }
   * }} input
   */
  async function beginTurn(input) {
    const sessionId = String(input.sessionId || '').trim();
    const turnId = String(input.turnId || '').trim();
    if (!sessionId || !turnId) {
      return { ok: false, error: 'sessionId / turnId 必填' };
    }
    const st = sessionState(sessionId);
    const mode = input['mode'] === 'plan' ? 'plan' : 'agent';
    const workspaceKind = inferUndoWorkspaceKind(input);
    const runWorkspaceRoot = normalizeUndoRunWorkspaceRoot(
      workspaceKind,
      input.runWorkspaceRoot,
      input.workspaceRoot
    );
    const workspaceRoot = normalizeUndoWorkspaceRoot(workspaceKind, input.workspaceRoot);

    let strategy = 'snapshot';
    let gitHead = null;
    /** @type {Record<string, { before: string|null, encoding: 'utf8'|'base64', remote?: boolean }>} */
    let files = {};

    if (workspaceKind === 'local' && workspaceRoot && (await isGitRepo(workspaceRoot))) {
      strategy = 'git';
      const baseline = await captureGitWorkingBaseline(workspaceRoot);
      gitHead = baseline.head || null;
      files = { ...baseline.files };
    } else if (
      workspaceKind === 'ssh' &&
      input.remoteGitBaseline &&
      input.remoteGitBaseline.isGitRepo
    ) {
      strategy = 'git';
      gitHead = input.remoteGitBaseline.head || null;
      files = { ...(input.remoteGitBaseline.files || {}) };
    }

    /** @type {TurnUndoRecord} */
    const record = {
      turnId,
      sessionId,
      mode,
      strategy,
      runId: input.runId ? String(input.runId) : null,
      workspaceKind,
      workspaceRoot,
      runWorkspaceRoot,
      gitHead,
      files,
      batches: [
        {
          id: 'b0',
          round: 0,
          files: cloneFilesMap(files),
          createdAt: Date.now()
        }
      ],
      planApplied: false,
      rolledBack: false,
      createdAt: Date.now(),
      finalized: false,
      touchedPaths: []
    };
    st.records.set(turnId, record);
    st.activeTurnId = turnId;
    persistSession(sessionId, { immediate: true });
    return { ok: true, turnId, strategy, fileCount: Object.keys(files).length };
  }

  function getRecord(sessionId, turnId) {
    const st = sessionState(sessionId);
    if (!st) return null;
    return st.records.get(String(turnId || '')) || null;
  }

  /**
   * @param {{
   *   sessionId: string,
   *   turnId?: string,
   *   filePath: string,
   *   beforeText?: string|null,
   *   encoding?: 'utf8'|'base64',
   *   remote?: boolean,
   *   workspaceRoot?: string|null
   * }} input
   */
  function captureWrite(input) {
    const sessionId = String(input.sessionId || '').trim();
    const st = sessionState(sessionId);
    if (!st) return { ok: false, skipped: true };
    const turnId = String(input.turnId || st.activeTurnId || '').trim();
    if (!turnId) return { ok: false, skipped: true };
    const record = st.records.get(turnId);
    if (!record || record.rolledBack || record.strategy === 'worktree-only') {
      return { ok: false, skipped: true };
    }
    const key = relKey(input.filePath, input.workspaceRoot);
    if (!key) return { ok: false, skipped: true };
    if (record.files[key]) {
      // Git baseline may already hold turn-start content; still mark the path so rollback restores it.
      markTouchedPaths(record, [key]);
      persistSession(sessionId);
      return { ok: true, skipped: true, existed: true };
    }
    const enc = input.encoding === 'base64' ? 'base64' : 'utf8';
    record.files[key] = {
      before: input.beforeText == null ? null : String(input.beforeText),
      encoding: enc,
      remote: !!input.remote || isRemoteUndoKind(record.workspaceKind)
    };
    markTouchedPaths(record, [key]);
    persistSession(sessionId);
    return { ok: true, captured: true, path: key };
  }

  /**
   * Phase B：工具批次执行前拍 checkpoint（合并后的 files 深拷贝）。
   * @param {{ sessionId: string, turnId?: string, round?: number, merged?: number, filesSnapshot?: Record<string, unknown> }} input
   */
  function captureBatchCheckpoint(input) {
    const sessionId = String(input.sessionId || '').trim();
    const st = sessionState(sessionId);
    if (!st) return { ok: false, skipped: true };
    const turnId = String(input.turnId || st.activeTurnId || '').trim();
    if (!turnId) return { ok: false, skipped: true };
    const record = st.records.get(turnId);
    if (!record || record.rolledBack || record.strategy === 'worktree-only') {
      return { ok: false, skipped: true };
    }
    if (Array.isArray(input.touchedPaths) && input.touchedPaths.length) {
      markTouchedPaths(record, input.touchedPaths);
    }
    if (input.fullSnapshot) {
      markTouchedPaths(record, Object.keys(record.files || {}));
    }
    if (!Array.isArray(record.batches)) record.batches = [];
    if (record.batches.length >= MAX_BATCHES_PER_TURN) {
      return { ok: false, error: 'checkpoint 数量已达上限', skipped: true };
    }
    const batchId = `b${record.batches.length}`;
    const snapshot = input.filesSnapshot
      ? cloneFilesMap(input.filesSnapshot)
      : cloneFilesMap(record.files);
    record.batches.push({
      id: batchId,
      round: Number(input.round) || record.batches.length,
      files: snapshot,
      createdAt: Date.now()
    });
    persistSession(sessionId);
    return {
      ok: true,
      batchId,
      batchIndex: record.batches.length - 1,
      merged: Number(input.merged) || 0,
      fileCount: Object.keys(record.files).length
    };
  }

  /**
   * 恢复到 turn 内某一 checkpoint（不 pop 栈，不标记 rolledBack）。
   */
  function planRollbackBatch({ sessionId, turnId, batchId }) {
    const st = sessionState(sessionId);
    if (!st) return { ok: false, error: '无效 session' };
    const id = String(turnId || '').trim();
    const record = st.records.get(id);
    if (!record || record.rolledBack) {
      return { ok: false, error: '记录不可恢复' };
    }
    if (record.strategy === 'worktree-only') {
      return { ok: false, error: 'worktree 模式请使用整轮撤回' };
    }
    const bid = String(batchId || '').trim();
    const batch = (record.batches || []).find((b) => b.id === bid);
    if (!batch) return { ok: false, error: 'checkpoint 不存在' };

    const batchFiles = batch.files || {};
    const allPaths = new Set([...Object.keys(record.files), ...Object.keys(batchFiles)]);
    const restoreRoot = record.workspaceRoot || null;
    const restoreCtx = record.runWorkspaceRoot || restoreRoot;
    const restore = [];
    for (const relPath of allPaths) {
      const meta = batchFiles[relPath];
      if (meta) {
        restore.push({
          path: relPath,
          before: meta.before,
          encoding: meta.encoding || 'utf8',
          remote: restoreIsRemote(record, meta),
          workspaceKind: record.workspaceKind || 'local',
          workspaceRoot: restoreRoot
        });
      } else {
        const cur = record.files[relPath];
        restore.push({
          path: relPath,
          before: null,
          encoding: cur?.encoding || 'utf8',
          remote: restoreIsRemote(record, cur),
          workspaceKind: record.workspaceKind || 'local',
          workspaceRoot: restoreRoot
        });
      }
    }
    return {
      ok: true,
      strategy: record.strategy,
      runId: record.runId,
      workspaceRoot: restoreRoot,
      runWorkspaceRoot: restoreCtx,
      workspaceKind: record.workspaceKind || 'local',
      batchId: bid,
      files: restore.map((r) => r.path),
      restore
    };
  }

  function markWorktreeOnly({ sessionId, turnId, runId }) {
    const record = getRecord(sessionId, turnId);
    if (!record || record.rolledBack) return { ok: false };
    record.strategy = 'worktree-only';
    record.runId = runId ? String(runId) : record.runId;
    record.files = {};
    persistSession(sessionId, { immediate: true });
    return { ok: true, strategy: record.strategy, runId: record.runId };
  }

  /**
   * Plan 应用 worktree 到主仓前，为将写回的路径记录主仓改前内容。
   */
  function capturePlanApplyPaths({ sessionId, turnId, paths, workspaceRoot }) {
    const record = getRecord(sessionId, turnId);
    if (!record || record.rolledBack) return { ok: false };
    const root = workspaceRoot ? path.resolve(String(workspaceRoot)) : null;
    let n = 0;
    for (const p of paths || []) {
      const key = relKey(p, root);
      if (!key) continue;
      if (!record.files[key]) {
        const full = root ? path.join(root, key) : key;
        if (fsSync.existsSync(full) && fsSync.statSync(full).isFile()) {
          try {
            const buf = fsSync.readFileSync(full);
            if (buf.length > 4 * 1024 * 1024) continue;
            const isBinary = buf.includes(0);
            record.files[key] = isBinary
              ? { before: buf.toString('base64'), encoding: 'base64' }
              : { before: buf.toString('utf8'), encoding: 'utf8' };
          } catch {
            record.files[key] = { before: null, encoding: 'utf8' };
          }
        } else {
          record.files[key] = { before: null, encoding: 'utf8' };
        }
      }
      markTouchedPaths(record, [key]);
      n += 1;
    }
    record.planApplied = true;
    record.strategy = record.strategy === 'worktree-only' ? 'snapshot' : record.strategy;
    if (n > 0) persistSession(sessionId, { immediate: true });
    return { ok: true, captured: n };
  }

  function markTurnTouched({ sessionId, turnId, paths }) {
    const record = getRecord(sessionId, turnId);
    if (!record) return { ok: false };
    markTouchedPaths(record, paths);
    persistSession(sessionId);
    return { ok: true, count: Array.isArray(record.touchedPaths) ? record.touchedPaths.length : 0 };
  }

  function finalizeTurn({ sessionId, turnId }) {
    const st = sessionState(sessionId);
    if (!st) return { ok: false };
    const id = String(turnId || st.activeTurnId || '').trim();
    const record = st.records.get(id);
    if (!record) return { ok: false, error: '未找到 turn 记录' };
    record.finalized = true;
    if (st.activeTurnId === id) st.activeTurnId = null;
    if (!st.stack.includes(id)) st.stack.push(id);
    trimStack(st);
    persistSession(sessionId, { immediate: true });
    return {
      ok: true,
      turnId: id,
      strategy: record.strategy,
      fileCount: Object.keys(record.files).length,
      stackDepth: st.stack.length
    };
  }

  function stackTop(sessionId) {
    const st = sessionState(sessionId);
    if (!st || !st.stack.length) return null;
    for (let i = st.stack.length - 1; i >= 0; i--) {
      const rec = st.records.get(st.stack[i]);
      if (rec && !rec.rolledBack) return rec;
    }
    return null;
  }

  function canRollback(sessionId, turnId) {
    const top = stackTop(sessionId);
    return !!(top && top.turnId === String(turnId || '') && top.finalized);
  }

  function getStack(sessionId) {
    const st = sessionState(sessionId);
    if (!st) return [];
    return st.stack
      .map((id) => st.records.get(id))
      .filter(Boolean)
      .map((r) => ({
        turnId: r.turnId,
        mode: r['mode'],
        strategy: r.strategy,
        runId: r.runId,
        planApplied: r.planApplied,
        rolledBack: r.rolledBack,
        finalized: r.finalized,
        fileCount: Object.keys(r.files).length,
        batchCount: Array.isArray(r.batches) ? r.batches.length : 0,
        createdAt: r.createdAt
      }));
  }

  function clearSession(sessionId) {
    const id = String(sessionId || '').trim();
    sessions.delete(id);
    if (store) {
      store.deleteSession(id).catch(() => {});
    }
    return { ok: true };
  }

  /**
   * 生成撤回计划（不修改状态）。
   */
  function planRollback({ sessionId, turnId }) {
    const st = sessionState(sessionId);
    if (!st) return { ok: false, error: '无效 session' };
    const id = String(turnId || '').trim();
    if (!canRollback(sessionId, id)) {
      return { ok: false, error: '只能按倒序撤回最近一轮' };
    }
    const record = st.records.get(id);
    if (!record) return { ok: false, error: '未找到记录' };

    if (record.strategy === 'worktree-only') {
      return {
        ok: true,
        strategy: 'worktree-only',
        runId: record.runId,
        workspaceRoot: record.workspaceRoot || null,
        runWorkspaceRoot: record.runWorkspaceRoot || null,
        workspaceKind: record.workspaceKind || 'local',
        files: [],
        restore: []
      };
    }

    const restoreRoot = record.workspaceRoot || null;
    const restore = rollbackRestorePaths(record)
      .filter((relPath) => record.files[relPath])
      .map((relPath) => {
        const meta = record.files[relPath];
        return {
          path: relPath,
          before: meta.before,
          encoding: meta.encoding || 'utf8',
          remote: restoreIsRemote(record, meta),
          workspaceKind: record.workspaceKind || 'local',
          workspaceRoot: restoreRoot
        };
      });
    return {
      ok: true,
      strategy: record.strategy,
      runId: record.runId,
      workspaceRoot: restoreRoot,
      runWorkspaceRoot: record.runWorkspaceRoot || restoreRoot,
      workspaceKind: record.workspaceKind || 'local',
      files: restore.map((r) => r.path),
      restore
    };
  }

  function commitRollback({ sessionId, turnId }) {
    const st = sessionState(sessionId);
    if (!st) return { ok: false, error: '无效 session' };
    const id = String(turnId || '').trim();
    const record = st.records.get(id);
    if (!record || record.rolledBack) return { ok: false, error: '记录不可提交' };
    record.rolledBack = true;
    st.stack = st.stack.filter((x) => x !== id);
    persistSession(sessionId, { immediate: true });
    return { ok: true, turnId: id };
  }

  return {
    MAX_STACK,
    beginTurn,
    captureWrite,
    captureBatchCheckpoint,
    markWorktreeOnly,
    capturePlanApplyPaths,
    markTurnTouched,
    finalizeTurn,
    canRollback,
    getStack,
    planRollback,
    planRollbackBatch,
    commitRollback,
    clearSession,
    getRecord
  };
}

module.exports = {
  createTurnUndoService,
  MAX_STACK: 5,
  normalizeUndoWorkspaceRoot,
  normalizeUndoRunWorkspaceRoot
};

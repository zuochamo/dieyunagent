'use strict';

const fs = require('fs/promises');
const fsSync = require('fs');
const path = require('path');
const { captureGitWorkingBaseline } = require('../git/baseline-capture');
const { encodeWorktreeContent, WORKTREE_SNAPSHOT_MAX_BYTES } = require('../git/git-target');
const { createTurnUndoStore } = require('./turn-undo-store');
const { normalizeRemotePath, parseWorkspaceInput } = require('../workspace/target');
const { AGENT_LIMITS_DEFAULTS } = require('../agent/agent-limits');

/** 栈深默认值：数字本身只住在 `agent-limits`（护栏单一来源）；设置项改动走 `opts.maxStack` 生效 */
const DEFAULT_MAX_STACK = AGENT_LIMITS_DEFAULTS.maxUndoSteps;

// 单轮 checkpoint 上限：到顶后**合并最老两个**而不是停止拍快照 ——
// 停止拍会让长回合从某一批之后彻底失去「退回这一批之前」的能力（而且不留任何痕迹）。
// 合并保住的语义：恢复点仍在，只是最老的那几个粒度变粗（宁可粗，不可悄悄消失）。
const MAX_BATCHES_PER_TURN = 32;

/**
 * 「文件路径 → 回合快照的相对 key」的唯一实现（原来 service 的 `relKey` 与
 * `gateway/rpc.js:normalizeUndoTouchPaths` 各写一份，改口径就得改两处）。
 *
 * 语义：反斜杠归一、去掉工作区根前缀（含尾斜杠差异）、路径不在根下就原样返回。
 * 这里**不**做 `path.resolve` / `..` 拒绝 —— 远端 POSIX 路径在 Windows 上 resolve 会变假路径，
 * 越界判定归 `path-policy` / `remote-path` 各层自己。
 *
 * @param {string} filePath
 * @param {string|null|undefined} workspaceRoot
 * @returns {string}
 */
function undoRelativeKey(filePath, workspaceRoot) {
  const fp = String(filePath || '').replace(/\\/g, '/');
  const root = workspaceRoot ? String(workspaceRoot).replace(/\\/g, '/').replace(/\/+$/, '') : '';
  if (root && (fp === root || fp.startsWith(root + '/'))) {
    return fp.slice(root.length + 1);
  }
  return fp;
}

/**
 * 单会话内容预算（字符数；ASCII 约等于字节，中文按 3 倍字节算）。
 *
 * 只限条数不限大小是不够的：`MAX_BATCHES_PER_TURN × 栈深` 只封住「多少个恢复点」，
 * 每个恢复点里放多少原文完全不受控。实测一个会话因此堆到 252MB（171.7MB 重复原文），
 * 落盘时在主线程上 `JSON.stringify` + 写盘要 0.4~0.9s（issue/2026-11-07-smoothness-investigation.md）。
 *
 * 32M 字符 ≈ 32MB ASCII / 96MB 纯中文：正常回合（几十个文件、几批 checkpoint）连零头都用不到，
 * 撞到它的只有「大文件 + 几十批 checkpoint」的病态回合。超了按 `enforceContentBudget` 的顺序丢内容。
 */
const UNDO_CONTENT_BUDGET_CHARS = 32 * 1024 * 1024;

/**
 * 条目浅拷贝即可：`before` 是不可变字符串，其余字段都是原始值。
 *
 * 这里曾经是 `JSON.parse(JSON.stringify(files))` —— 它把同一份原文按 batch 复制成成百份
 * 独立字符串：实测同一个会话里 10858 个条目共 171.7MB「重复内容」全在主进程堆里。
 * 浅拷贝后同一份内容在内存里只有一份，落盘再由 store 按内容哈希去重。
 */
function cloneFilesMap(files) {
  const out = {};
  for (const [key, meta] of Object.entries(files || {})) {
    out[key] = meta && typeof meta === 'object' ? { ...meta } : meta;
  }
  return out;
}

/** 一份内容集合的字符数（按内容去重：同一份原文被多批引用只算一次） */
function filesContentChars(files, seen) {
  let n = 0;
  for (const meta of Object.values(files || {})) {
    const text = meta && typeof meta.before === 'string' ? meta.before : '';
    if (!text || seen.has(text)) continue;
    seen.add(text);
    n += text.length;
  }
  return n;
}

/** 收集一份内容集合里出现过的原文字符串 */
function filesContents(files, into = new Set()) {
  for (const meta of Object.values(files || {})) {
    const text = meta && typeof meta.before === 'string' ? meta.before : '';
    if (text) into.add(text);
  }
  return into;
}

function sessionContentChars(st) {
  const seen = new Set();
  let total = 0;
  for (const record of st.records.values()) {
    total += filesContentChars(record.files, seen);
    for (const batch of record.batches || []) {
      if (batch && !batch.contentDropped) total += filesContentChars(batch.files, seen);
    }
  }
  return total;
}

/** 一个回合引用到的全部内容（record.files + 它的 checkpoint；同一回合内重复只算一次） */
function recordContents(record) {
  const seen = new Set();
  filesContentChars(record.files, seen); // 只为收集 set
  for (const batch of record.batches || []) {
    if (batch && !batch.contentDropped) filesContentChars(batch.files, seen);
  }
  return seen;
}

/**
 * 每个内容被多少个**回合**引用：`1` = 只有这一个回合在用，丢掉它就真的能省下内存。
 *
 * 只按「条数」裁剪是不够的，只按「字符数」裁也会踩坑：内容被更晚的回合共用时，
 * 丢老回合的副本省不下任何东西（内存里本来就是同一个字符串、盘上也是同一个内容块），
 * 纯属白丢功能。所以裁剪前先问一句「丢了到底省不省」。
 */
function contentOwnerCount(records) {
  const counts = new Map();
  for (const record of records) {
    for (const text of recordContents(record)) counts.set(text, (counts.get(text) || 0) + 1);
  }
  return counts;
}

function exclusiveChars(record, owners) {
  let n = 0;
  for (const text of recordContents(record)) {
    if (owners.get(text) === 1) n += text.length;
  }
  return n;
}

/**
 * 内容预算裁决（就地裁剪内存态，落盘自然跟着变小）。
 *
 * 顺序按「越难用到越先丢」，且**每一步都先验证「丢了能省下」**，省不下就跳过：
 * 1. 最老的回合先丢：先丢它的所有 checkpoint 内容（batch 只留 id/round，回滚时明确报「已丢弃」），
 *    还不够再丢它的 `record.files`（该回合整轮撤回同样明确报错）；
 * 2. 最老回合的内容若被更新的回合共用（省不下），跳过它；
 * 3. 最后才动**最新一轮**，且只丢它最老的 checkpoint 内容 —— `record.files` 永不丢：
 *    能整轮撤回的就是它（`canRollback` 只认栈顶），宁可超预算也不让主能力失效。
 */
function enforceContentBudget(st, budget = UNDO_CONTENT_BUDGET_CHARS) {
  let total = sessionContentChars(st);
  if (total <= budget) return { droppedBatches: 0, droppedRecords: 0 };
  let droppedBatches = 0;
  let droppedRecords = 0;
  const records = [...st.records.values()]; // Map 插入序 = 时间序
  // 最新一轮 = 最后一个记录：回合跑完后 activeTurnId 会清空，但栈顶仍是它
  const newest = records.length ? records[records.length - 1] : null;

  for (const record of records) {
    if (total <= budget) break;
    if (record === newest) break;
    if (!recordContents(record).size) continue;
    if (exclusiveChars(record, contentOwnerCount(records)) <= 0) continue; // 丢了也省不下
    let changed = false;
    for (const batch of record.batches || []) {
      if (!batch || batch.contentDropped || !batch.files) continue;
      if (!Object.keys(batch.files).length) continue;
      batch.files = {};
      batch.contentDropped = true;
      droppedBatches += 1;
      changed = true;
    }
    if (changed) total = sessionContentChars(st);
    if (total <= budget) break;
    if (Object.keys(record.files || {}).length) {
      record.files = {};
      record.contentDropped = true;
      droppedRecords += 1;
      total = sessionContentChars(st);
    }
  }

  // 极端的单回合长任务：上面动不了（最新一轮受保护），只能从它最老的 checkpoint 开始放，
  // 且同样只在「丢了真能省下」时才丢（内容是 record.files 或兄弟 checkpoint 还要用的同一份就跳过）
  if (total > budget && newest) {
    for (const batch of newest.batches || []) {
      if (total <= budget) break;
      if (!batch || batch.contentDropped || !batch.files) continue;
      const own = filesContents(batch.files);
      if (!own.size) continue;
      const others = filesContents(newest.files);
      for (const other of newest.batches || []) {
        if (other === batch || other.contentDropped) continue;
        filesContents(other.files, others);
      }
      let gain = 0;
      for (const text of own) if (!others.has(text)) gain += text.length;
      if (gain <= 0) continue;
      batch.files = {};
      batch.contentDropped = true;
      droppedBatches += 1;
      total = sessionContentChars(st);
    }
  }
  return { droppedBatches, droppedRecords };
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
 * 恢复项（plan → handler → `restoreUndoFile`）的唯一构造处。
 * 整轮撤回与单检查点撤回共用它：两个 plan 各写一遍映射时，「谁判远端」「带哪些字段」
 * 迟早漂移（handler 侧原来还要再判一次 `workspaceKind === 'ssh'`）。
 *
 * @param {TurnUndoRecord} record
 * @param {string} relPath
 * @param {{ before: string|null, encoding?: string, remote?: boolean } | null} meta
 * @returns {{ path: string, before: string|null, encoding: 'utf8'|'base64', remote: boolean, workspaceKind: string, workspaceRoot: string|null }}
 */
function toRestoreItem(record, relPath, meta) {
  const src = meta || { before: null };
  return {
    path: relPath,
    before: src.before == null ? null : src.before,
    encoding: src.encoding === 'base64' ? 'base64' : 'utf8',
    remote: restoreIsRemote(record, src),
    workspaceKind: record.workspaceKind || 'local',
    workspaceRoot: record.workspaceRoot || null
  };
}

/**
 * @typedef {'git'|'snapshot'} UndoStrategy
 * @typedef {{
 *   turnId: string,
 *   sessionId: string,
 *   strategy: UndoStrategy,
 *   gitHead: string|null,
 *   gitStashSha: string|null,
 *   gitUntrackedAtStart: string[]|null,
 *   shellMutated: boolean,
 *   files: Record<string, { before: string|null, encoding: 'utf8'|'base64', remote?: boolean }>,
 *   batches: Array<{ id: string, round: number, files: Record<string, { before: string|null, encoding: 'utf8'|'base64', remote?: boolean }>, createdAt: number, mergedCount?: number }>,
 *   batchSeq?: number,
 *   rolledBack: boolean,
 *   createdAt: number,
 *   finalized: boolean,
 *   touchedPaths?: string[]
 * }} TurnUndoRecord
 */

/**
 * @param {{ userDataPath?: string, maxStack?: () => number }} [opts]
 *   `maxStack`：栈深上限的取值器（设置页改「撤回步数上限」后立刻生效）。
 *   缺省读 `agent-limits` 的默认值 —— 数字只在那一处定义。
 */
function createTurnUndoService(opts = {}) {
  /** @type {Map<string, { activeTurnId: string|null, stack: string[], records: Map<string, TurnUndoRecord> }>} */
  const sessions = new Map();
  const store = opts.userDataPath ? createTurnUndoStore(opts.userDataPath) : null;
  const maxStack = () => {
    const n = Number(typeof opts.maxStack === 'function' ? opts.maxStack() : NaN);
    return Number.isFinite(n) && n >= 1 ? Math.floor(n) : DEFAULT_MAX_STACK;
  };

  /**
   * 落盘：**不再有同步写**。
   *
   * 过去 `immediate` 走 `fsSync.writeFileSync` + `renameSync` 写整份 250MB JSON，
   * 主线程直接被占 0.4~0.9s（Gateway / IPC 全排队 = 用户看到的「卡半秒」）。
   * 现在元数据只有 ~1MB 级、内容块独立且去重，写盘一律异步 + 每会话串行。
   */
  function persistSession(sessionId, opts = {}) {
    if (!store) return;
    const st = sessions.get(String(sessionId || '').trim());
    if (!st) return;
    enforceContentBudget(st);
    if (opts.immediate) {
      store.writeSessionNow(sessionId, st).catch((e) => {
        // 撤回快照写不进去要留痕：静默失败会让用户在想回退时才发现没有记录
        console.warn('[undo] 快照落盘失败', e && (e.message || e));
      });
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

  function trimStack(st) {
    const cap = maxStack();
    while (st.stack.length > cap) {
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
   *   workspaceKind?: 'local'|'ssh',
   *   workspaceRoot?: string|null,
   *   remoteGitBaseline?: { isGitRepo?: boolean, head?: string, stashSha?: string, untracked?: string[]|null, files?: Record<string, unknown> }
   * }} input
   */
  async function beginTurn(input) {
    const sessionId = String(input.sessionId || '').trim();
    const turnId = String(input.turnId || '').trim();
    if (!sessionId || !turnId) {
      return { ok: false, error: 'sessionId / turnId 必填' };
    }
    const st = sessionState(sessionId);
    const workspaceKind = inferUndoWorkspaceKind(input);
    const runWorkspaceRoot = normalizeUndoRunWorkspaceRoot(
      workspaceKind,
      input.runWorkspaceRoot,
      input.workspaceRoot
    );
    const workspaceRoot = normalizeUndoWorkspaceRoot(workspaceKind, input.workspaceRoot);

    let strategy = 'snapshot';
    let gitHead = null;
    /** 回合开始树的 commit（`git stash create`）——整轮撤回的唯一可靠来源，见 git/turn-tree.js */
    let gitStashSha = null;
    /** 回合开始时就存在的未跟踪路径：撤回时不许删它们（`null` = 未知 → 不动未跟踪文件） */
    let gitUntrackedAtStart = null;
    /** @type {Record<string, { before: string|null, encoding: 'utf8'|'base64', remote?: boolean }>} */
    let files = {};

    if (workspaceKind === 'local' && workspaceRoot) {
      // 「是不是 git 仓库」由基线捕获自己回答，别在这里再 `isGitRepo()` 一次（多一次 git 往返）
      const baseline = await captureGitWorkingBaseline(workspaceRoot, { turnStartState: true });
      if (baseline.isRepo) {
        strategy = 'git';
        gitHead = baseline.head || null;
        gitStashSha = baseline.stashSha || null;
        gitUntrackedAtStart = Array.isArray(baseline.untracked) ? baseline.untracked : null;
        files = { ...baseline.files };
      }
    } else if (
      workspaceKind === 'ssh' &&
      input.remoteGitBaseline &&
      input.remoteGitBaseline.isGitRepo
    ) {
      strategy = 'git';
      gitHead = input.remoteGitBaseline.head || null;
      gitStashSha = input.remoteGitBaseline.stashSha || null;
      gitUntrackedAtStart = Array.isArray(input.remoteGitBaseline.untracked)
        ? input.remoteGitBaseline.untracked
        : null;
      files = { ...(input.remoteGitBaseline.files || {}) };
    }

    /** @type {TurnUndoRecord} */
    const record = {
      turnId,
      sessionId,
      strategy,
      workspaceKind,
      workspaceRoot,
      runWorkspaceRoot,
      gitHead,
      gitStashSha,
      gitUntrackedAtStart,
      shellMutated: false,
      files,
      batches: [
        {
          id: 'b0',
          round: 0,
          files: cloneFilesMap(files),
          createdAt: Date.now()
        }
      ],
      rolledBack: false,
      createdAt: Date.now(),
      finalized: false,
      touchedPaths: []
    };
    st.records.set(turnId, record);
    st.activeTurnId = turnId;
    persistSession(sessionId, { immediate: true });
    return {
      ok: true,
      turnId,
      strategy,
      fileCount: Object.keys(files).length,
      gitStashSha: gitStashSha || null
    };
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
    if (!record || record.rolledBack) return { ok: false, skipped: true };
    const key = undoRelativeKey(input.filePath, input.workspaceRoot);
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
   * 把最老的两个 checkpoint 合并成一个（最老那一批的 id / round / createdAt 保留）：
   * 同一路径取**较早**那份 before（已有则保留、没有则补上），因此「退回该点」永远不超过
   * 原来那一批该退的范围，只是少了中间那个更细的边界。
   */
  function mergeOldestBatch(record) {
    const batches = record.batches;
    if (!Array.isArray(batches) || batches.length < 2) return 0;
    const older = batches[0];
    const newer = batches[1];
    const merged = cloneFilesMap(newer && newer.files);
    for (const [p, meta] of Object.entries((older && older.files) || {})) {
      merged[p] = meta;
    }
    const mergedCount =
      (Number(older && older.mergedCount) || 1) + (Number(newer && newer.mergedCount) || 1);
    batches.splice(0, 2, {
      id: older.id,
      round: older.round,
      files: merged,
      createdAt: older.createdAt,
      mergedCount
    });
    return mergedCount;
  }

  function nextBatchId(record) {
    if (!Number.isFinite(record.batchSeq)) record.batchSeq = 0;
    const used = new Set((record.batches || []).map((b) => b && b.id));
    let id;
    do {
      id = `b${record.batchSeq}`;
      record.batchSeq += 1;
    } while (used.has(id));
    return id;
  }

  /**
   * Phase B：工具批次执行前拍 checkpoint（合并后的 files 深拷贝）。
   * 到 MAX_BATCHES_PER_TURN 后先合并最老两个再拍，永不「超过 N 批就不再记录」。
   * @param {{ sessionId: string, turnId?: string, round?: number, merged?: number, fullSnapshot?: boolean, filesSnapshot?: Record<string, unknown> }} input
   */
  function captureBatchCheckpoint(input) {
    const sessionId = String(input.sessionId || '').trim();
    const st = sessionState(sessionId);
    if (!st) return { ok: false, skipped: true };
    const turnId = String(input.turnId || st.activeTurnId || '').trim();
    if (!turnId) return { ok: false, skipped: true };
    const record = st.records.get(turnId);
    if (!record || record.rolledBack) return { ok: false, skipped: true };
    // `fullSnapshot` = 这一批里出现过 shell 命令（host_exec）。那些改动**逐文件捕获不到**，
    // 只能靠回合开始树撤回；记下来是为了「撤不干净时不许装作成功」（见 planRollback.shellMutated）。
    if (input.fullSnapshot) record.shellMutated = true;
    if (Array.isArray(input.touchedPaths) && input.touchedPaths.length) {
      markTouchedPaths(record, input.touchedPaths);
    }
    if (input.fullSnapshot) {
      markTouchedPaths(record, Object.keys(record.files || {}));
    }
    if (!Array.isArray(record.batches)) record.batches = [];
    let mergedBatches = 0;
    if (record.batches.length >= MAX_BATCHES_PER_TURN) {
      mergedBatches = mergeOldestBatch(record);
    }
    const batchId = nextBatchId(record);
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
      mergedBatches,
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
    const bid = String(batchId || '').trim();
    const batch = (record.batches || []).find((b) => b.id === bid);
    if (!batch) {
      // 超长回合里最老的几个 checkpoint 会被合并，只剩合并后的那个 id
      return { ok: false, error: '该检查点已被合并（单轮最多 32 个），请用整轮撤回或较新的检查点' };
    }
    if (batch.contentDropped) {
      // 内容按体积预算丢弃过：宁可明说不可用，也不能拿空内容去「恢复」成删文件
      return { ok: false, error: '该检查点的内容已按体积预算丢弃，请用整轮撤回或较新的检查点' };
    }

    const batchFiles = batch.files || {};
    const allPaths = new Set([...Object.keys(record.files), ...Object.keys(batchFiles)]);
    const restoreRoot = record.workspaceRoot || null;
    const restoreCtx = record.runWorkspaceRoot || restoreRoot;
    // 不在该检查点里的路径 = 那一刻还不存在 → 恢复 = 删除（before 为 null）
    const restore = [...allPaths].map((relPath) =>
      toRestoreItem(record, relPath, batchFiles[relPath] || { before: null, encoding: record.files[relPath]?.encoding })
    );
    return {
      ok: true,
      strategy: record.strategy,
      workspaceRoot: restoreRoot,
      runWorkspaceRoot: restoreCtx,
      workspaceKind: record.workspaceKind || 'local',
      batchId: bid,
      // 单检查点撤回没有 git 树（那是整轮语义），shell 改动同样撤不回来 —— 如实交出这个事实
      shellMutated: !!record.shellMutated,
      files: restore.map((r) => r.path),
      restore
    };
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
      const key = undoRelativeKey(p, root);
      if (!key) continue;
      if (!record.files[key]) {
        const full = root ? path.join(root, key) : key;
        let captured = null;
        if (fsSync.existsSync(full) && fsSync.statSync(full).isFile()) {
          try {
            const buf = fsSync.readFileSync(full);
            if (buf.length <= WORKTREE_SNAPSHOT_MAX_BYTES) captured = encodeWorktreeContent(buf);
          } catch {
            captured = null;
          }
        }
        // 读不到 / 不存在都要能区分：只有「确实不存在」才记 null（撤回=删除）
        record.files[key] = captured
          ? { before: captured.before, encoding: captured.encoding }
          : { before: null, encoding: 'utf8' };
      }
      markTouchedPaths(record, [key]);
      n += 1;
    }
    if (n > 0) persistSession(sessionId, { immediate: true });
    return { ok: true, captured: n };
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

    // 内容按体积预算丢弃过：restore 里再给 null 就等于「把文件删掉」。但**有回合开始树**时
    // 已跟踪文件由 git 树回滚负责、根本不依赖快照内容 —— 此时拒绝撤回是把能做的事也挡掉了。
    const hasGitTree = record.strategy === 'git' && !!record.gitStashSha;
    if (record.contentDropped && !hasGitTree) {
      return { ok: false, error: '该回合的改前内容已按体积预算丢弃，无法整轮撤回' };
    }

    const restoreRoot = record.workspaceRoot || null;
    const restore = rollbackRestorePaths(record)
      .filter((relPath) => record.files[relPath])
      .map((relPath) => toRestoreItem(record, relPath, record.files[relPath]));
    return {
      ok: true,
      strategy: record.strategy,
      workspaceRoot: restoreRoot,
      runWorkspaceRoot: record.runWorkspaceRoot || restoreRoot,
      workspaceKind: record.workspaceKind || 'local',
      /** 回合开始树的 commit：有它才能覆盖 shell 改的文件（见 git/turn-tree.js） */
      gitStashSha: record.gitStashSha || null,
      /** 回合开始时的 HEAD：撤回时拿它判「本轮改动是否被提交过」 */
      gitHead: record.gitHead || null,
      /** 回合开始时就有哪些未跟踪文件：撤回时按它区分「本轮新建」与「本来就有」 */
      gitUntrackedAtStart: Array.isArray(record.gitUntrackedAtStart)
        ? record.gitUntrackedAtStart.slice()
        : null,
      /** 本轮用过 shell 命令改文件：快照撤不全，撤回必须如实报告 */
      shellMutated: !!record.shellMutated,
      /** 快照内容被体积预算丢弃过：git 树盖不住的那部分（未跟踪文件）原文没了 */
      snapshotDropped: !!record.contentDropped,
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
    beginTurn,
    captureWrite,
    captureBatchCheckpoint,
    capturePlanApplyPaths,
    finalizeTurn,
    canRollback,
    planRollback,
    planRollbackBatch,
    commitRollback,
    clearSession,
    getRecord
  };
}

module.exports = {
  createTurnUndoService,
  // 路径 key 的单一实现：gateway 的 touchPaths 归一也从这里取（别在 handler 里再写一份）
  undoRelativeKey,
  // 工作区是不是远端：handler 决定「要不要抓远端 git 基线」时问这里，不自己判 URI 前缀
  inferUndoWorkspaceKind,
  // 预算策略的单一来源（测试与诊断直接读这两个符号，不另抄一份数字）
  UNDO_CONTENT_BUDGET_CHARS,
  enforceContentBudget
};

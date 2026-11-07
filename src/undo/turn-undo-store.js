'use strict';

const fs = require('fs/promises');
const fsSync = require('fs');
const path = require('path');
const crypto = require('crypto');

/**
 * 回合撤回（undo）的落盘层：**元数据 + 内容块**两件东西。
 *
 * 过去它是一份单体 JSON：`records[*].files[*].before` 直接存改前全文，而每个 checkpoint
 * batch 又整份复制一遍。实测单个会话能长到 252MB（10858 个 file 条目 / 171.7MB 重复原文），
 * 而落盘是主线程上的 `JSON.stringify` + `writeFileSync` + `renameSync` —— 一次 0.4~0.9s，
 * 400ms 去抖叠加后「编辑文件的那几秒」主线程基本被占满（issue/2026-11-07-smoothness-investigation.md）。
 *
 * 现在：
 *   - 内容按 sha256 前 16 字节（32 hex）去重，单独落 `undo-sessions/<sid>.blobs/<ref>`：
 *     同一份原文被 N 个 batch 引用也只写一次（实测正是这种 1:N 复制把文件撑到 250MB）；
 *   - 元数据只留引用，体积从 250MB 级降到 ~1MB 级，序列化/写盘都是毫秒量级；
 *   - 写盘走 fs/promises，只有「首次加载会话」这条冷路径还是同步读（且只读元数据 + 按 ref
 *     去重的内容块，见 `loadSessionSync`）；
 *   - 写完元数据立刻删掉本次不再被引用的内容块 —— 保留策略是「还被引用」，不做定时清理；
 *   - 先写内容块再写元数据：崩溃最多丢最后一次 checkpoint，不会留下悬空引用。
 *
 * 兼容：`version < 2` 的老文件（before 内联）照常读，下一次写入时自动升级成引用格式，
 * 顺手把那份 250MB 的文件缩回去。
 */

/** 元数据格式版本：2 = 内容块分离（`before` → `beforeRef`） */
const STORE_VERSION = 2;
const SAVE_DEBOUNCE_MS = 400;
const BLOB_DIR_SUFFIX = '.blobs';
/**
 * 引用长度（hex）。按生日界，32 hex = 128 bit：即使单个会话有 10^6 个内容块，
 * 碰撞概率也在 10^-26 量级 —— 用它当文件名足够，且元数据里每个条目只多 32 字节。
 */
const REF_HEX_LEN = 32;

function safeSessionFileName(sessionId) {
  return String(sessionId || 'unknown')
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .slice(0, 120);
}

function undoSessionsDir(userDataPath) {
  return path.join(String(userDataPath || ''), 'undo-sessions');
}

function sessionFilePath(userDataPath, sessionId) {
  return path.join(undoSessionsDir(userDataPath), `${safeSessionFileName(sessionId)}.json`);
}

/** 每个会话一个内容块目录：`clearSession` / 删除会话 = 连目录一起删，不需要跨会话引用计数 */
function blobDirPath(userDataPath, sessionId) {
  return path.join(undoSessionsDir(userDataPath), `${safeSessionFileName(sessionId)}${BLOB_DIR_SUFFIX}`);
}

function blobFilePath(userDataPath, sessionId, ref) {
  return path.join(blobDirPath(userDataPath, sessionId), String(ref));
}

/**
 * 内容 → 引用。同一个 meta 对象只算一次（记在 `meta.ref` 上）：`before` 是字符串且不可变，
 * 引用与它一一对应，所以这个缓存字段等价于「该内容的持久化 id」。
 */
function contentRef(text) {
  return crypto.createHash('sha256').update(String(text), 'utf8').digest('hex').slice(0, REF_HEX_LEN);
}

function metaRef(meta) {
  // 空字符串也是合法内容（空文件）：必须照样给引用，否则会退化成「没有 before」= 撤回时删文件
  const text = meta && typeof meta.before === 'string' ? meta.before : null;
  if (text == null) return '';
  // `refLen` 是同一份派生的校验：万一有人就地改写 `before`（本仓目前没有这种写法），
  // 长度变了就重算，绝不拿旧引用去覆盖别人的内容块。
  if (typeof meta.ref === 'string' && meta.ref && meta.refLen === text.length) return meta.ref;
  meta.ref = contentRef(text);
  meta.refLen = text.length;
  return meta.ref;
}

/** 元数据化：`before` 换成 `beforeRef`，其余（encoding / remote / contentDropped）原样保留 */
function serializeEntry(meta, blobs) {
  const out = { encoding: meta && meta.encoding === 'base64' ? 'base64' : 'utf8' };
  if (!meta) return out;
  if (meta.remote) out.remote = true;
  if (meta.contentDropped) out.contentDropped = true;
  if (typeof meta.before === 'string') {
    const ref = metaRef(meta);
    out.beforeRef = ref;
    blobs.set(ref, meta.before);
  } else {
    // null = 该路径在快照点不存在（撤回 = 删除文件），与「内容被丢弃」是两件事，必须分开表达
    out.beforeRef = null;
  }
  return out;
}

function serializeFilesMap(files, blobs) {
  const out = {};
  for (const [relPath, meta] of Object.entries(files || {})) {
    if (!relPath) continue;
    out[relPath] = serializeEntry(meta, blobs);
  }
  return out;
}

function serializeSessionState(st) {
  const blobs = new Map();
  const records = {};
  for (const [turnId, record] of st.records.entries()) {
    const out = {
      turnId: record.turnId,
      sessionId: record.sessionId,
      mode: record.mode,
      strategy: record.strategy,
      runId: record.runId,
      workspaceKind: record.workspaceKind,
      workspaceRoot: record.workspaceRoot,
      runWorkspaceRoot: record.runWorkspaceRoot,
      gitHead: record.gitHead,
      planApplied: !!record.planApplied,
      rolledBack: !!record.rolledBack,
      finalized: !!record.finalized,
      createdAt: record.createdAt,
      files: serializeFilesMap(record.files, blobs)
    };
    if (record.contentDropped) out.contentDropped = true;
    if (Array.isArray(record.touchedPaths)) out.touchedPaths = record.touchedPaths.slice();
    if (Array.isArray(record.batches)) {
      out.batches = record.batches.map((batch) => {
        const b = { id: batch.id, round: batch.round, createdAt: batch.createdAt };
        if (batch.mergedCount) b.mergedCount = batch.mergedCount;
        if (batch.contentDropped) b.contentDropped = true;
        b.files = batch.contentDropped ? {} : serializeFilesMap(batch.files, blobs);
        return b;
      });
    }
    records[turnId] = out;
  }
  return {
    version: STORE_VERSION,
    activeTurnId: st.activeTurnId || null,
    stack: Array.isArray(st.stack) ? st.stack.slice() : [],
    records,
    /** 只用于诊断：本次落盘引用的内容块数量（读的时候不依赖它） */
    blobCount: blobs.size,
    blobs
  };
}

/** 元数据里出现过的所有引用（用于装回内容 / 清理孤儿块） */
function collectRefs(records) {
  const refs = new Set();
  const scan = (files) => {
    for (const entry of Object.values(files || {})) {
      if (entry && typeof entry.beforeRef === 'string' && entry.beforeRef) refs.add(entry.beforeRef);
    }
  };
  for (const record of Object.values(records || {})) {
    scan(record && record.files);
    for (const batch of (record && record.batches) || []) scan(batch && batch.files);
  }
  return refs;
}

function hydrateEntry(entry, texts) {
  const src = entry || {};
  const out = { encoding: src.encoding === 'base64' ? 'base64' : 'utf8' };
  if (src.remote) out.remote = true;
  if (src.contentDropped) out.contentDropped = true;
  // v1 文件：内容内联在 `before` 里（没有块库）。原样装回，下次写入自动升级成引用格式。
  if (typeof src.before === 'string') {
    out.before = src.before;
    return out;
  }
  const ref = typeof src.beforeRef === 'string' ? src.beforeRef : '';
  if (!ref) {
    out.before = null;
    return out;
  }
  const text = texts.get(ref);
  if (typeof text === 'string') {
    out.before = text;
    out.ref = ref;
    return out;
  }
  // 内容块缺失（被外部删掉 / 老文件残留悬空引用）：明确标记，绝不退化成「撤回=删文件」
  out.before = null;
  out.contentDropped = true;
  return out;
}

function hydrateFilesMap(files, texts) {
  const out = {};
  for (const [relPath, entry] of Object.entries(files || {})) {
    if (!relPath) continue;
    out[relPath] = hydrateEntry(entry, texts);
  }
  return out;
}

function deserializeSessionState(raw, texts) {
  if (!raw || typeof raw !== 'object') return null;
  const records = new Map();
  for (const [turnId, record] of Object.entries(raw.records || {})) {
    if (!record || typeof record !== 'object') continue;
    const next = {
      turnId: record.turnId || turnId,
      sessionId: record.sessionId,
      mode: record.mode,
      strategy: record.strategy,
      runId: record.runId == null ? null : record.runId,
      workspaceKind: record.workspaceKind,
      workspaceRoot: record.workspaceRoot,
      runWorkspaceRoot: record.runWorkspaceRoot,
      gitHead: record.gitHead == null ? null : record.gitHead,
      planApplied: !!record.planApplied,
      rolledBack: !!record.rolledBack,
      finalized: !!record.finalized,
      createdAt: record.createdAt,
      files: hydrateFilesMap(record.files, texts)
    };
    if (record.contentDropped) next.contentDropped = true;
    if (Array.isArray(record.touchedPaths)) next.touchedPaths = record.touchedPaths.slice();
    if (Array.isArray(record.batches)) {
      next.batches = record.batches.map((batch) => {
        const b = {
          id: batch.id,
          round: batch.round,
          createdAt: batch.createdAt,
          files: batch.contentDropped ? {} : hydrateFilesMap(batch.files, texts)
        };
        if (batch.mergedCount) b.mergedCount = batch.mergedCount;
        if (batch.contentDropped) b.contentDropped = true;
        return b;
      });
    }
    records.set(turnId, next);
  }
  return {
    activeTurnId: raw.activeTurnId || null,
    stack: Array.isArray(raw.stack) ? raw.stack.slice() : [],
    records
  };
}

/**
 * @param {string} userDataPath
 */
function createTurnUndoStore(userDataPath) {
  const root = String(userDataPath || '').trim();
  /** @type {Map<string, ReturnType<typeof setTimeout>>} */
  const pendingTimers = new Map();
  /** @type {Map<string, object>} */
  const pendingPayloads = new Map();
  /** 每个会话的写盘串行链：避免两次 persist 交叉 rename */
  const writeChains = new Map();
  /** 每个会话已知已落盘的内容块引用（只在内存里，用于少写重复块） */
  const writtenRefs = new Map();

  function refsSet(sessionId) {
    let set = writtenRefs.get(sessionId);
    if (!set) {
      set = new Set();
      writtenRefs.set(sessionId, set);
    }
    return set;
  }

  /** 首次接触一个会话时，磁盘上的块就是「已落盘」的基准 */
  function seedWrittenRefs(sessionId, refs) {
    const set = refsSet(sessionId);
    for (const ref of refs) set.add(ref);
  }

  function readBlobsSync(sessionId, refs) {
    /** @type {Map<string, string>} */
    const texts = new Map();
    if (!root) return texts;
    for (const ref of refs) {
      try {
        texts.set(ref, fsSync.readFileSync(blobFilePath(root, sessionId, ref), 'utf8'));
      } catch {
        // 缺失由 hydrateEntry 标记成 contentDropped
      }
    }
    return texts;
  }

  async function readBlobs(sessionId, refs) {
    /** @type {Map<string, string>} */
    const texts = new Map();
    if (!root) return texts;
    for (const ref of refs) {
      try {
        texts.set(ref, await fs.readFile(blobFilePath(root, sessionId, ref), 'utf8'));
      } catch {
        // 同上
      }
    }
    return texts;
  }

  function readMetaSync(sessionId) {
    const sid = String(sessionId || '').trim();
    if (!root || !sid) return null;
    try {
      const raw = JSON.parse(fsSync.readFileSync(sessionFilePath(root, sid), 'utf8').replace(/^\uFEFF/, ''));
      return raw && typeof raw === 'object' ? raw : null;
    } catch {
      return null;
    }
  }

  async function readMeta(sessionId) {
    const sid = String(sessionId || '').trim();
    if (!root || !sid) return null;
    try {
      const body = await fs.readFile(sessionFilePath(root, sid), 'utf8');
      const raw = JSON.parse(body.replace(/^\uFEFF/, ''));
      return raw && typeof raw === 'object' ? raw : null;
    } catch {
      return null;
    }
  }

  /**
   * 会话首次加载。只读元数据 + 按 ref 去重的内容块：250MB 单体读 → 1MB 元数据 + 不重复的内容。
   * 这是冷路径（每个会话每进程一次），保留同步实现以免把 `sessionState()` 变成异步。
   */
  function loadSessionSync(sessionId) {
    const sid = String(sessionId || '').trim();
    const raw = readMetaSync(sid);
    if (!raw) return null;
    const refs = collectRefs(raw.records);
    seedWrittenRefs(sid, refs);
    return deserializeSessionState(raw, readBlobsSync(sid, refs));
  }

  async function loadSession(sessionId) {
    const sid = String(sessionId || '').trim();
    const raw = await readMeta(sid);
    if (!raw) return null;
    const refs = collectRefs(raw.records);
    seedWrittenRefs(sid, refs);
    return deserializeSessionState(raw, await readBlobs(sid, refs));
  }

  /** 内容块落盘：只写本次新出现的引用；批量写失败不影响元数据（宁可丢内容也不写悬空引用） */
  async function writeBlobs(sessionId, blobs) {
    const known = refsSet(sessionId);
    const missing = [...blobs.entries()].filter(([ref]) => ref && !known.has(ref));
    if (!missing.length) return 0;
    await fs.mkdir(blobDirPath(root, sessionId), { recursive: true });
    for (const [ref, text] of missing) {
      await fs.writeFile(blobFilePath(root, sessionId, ref), text, 'utf8');
      known.add(ref);
    }
    return missing.length;
  }

  /** 保留策略：先把元数据落稳，再删本次没被引用的块（trimStack / 落成旧格式都会产生孤儿） */
  async function pruneOrphanBlobs(sessionId, keepRefs) {
    const dir = blobDirPath(root, sessionId);
    let names;
    try {
      names = await fs.readdir(dir);
    } catch {
      return 0;
    }
    let removed = 0;
    const known = refsSet(sessionId);
    for (const name of names) {
      if (keepRefs.has(name)) continue;
      try {
        await fs.unlink(path.join(dir, name));
        known.delete(name);
        removed += 1;
      } catch {
        // 删不掉不算错，下次写盘再试
      }
    }
    return removed;
  }

  async function writeMeta(sessionId, payload) {
    const fp = sessionFilePath(root, sessionId);
    await fs.mkdir(undoSessionsDir(root), { recursive: true });
    const tmp = `${fp}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(payload), 'utf8');
    await fs.rename(tmp, fp);
  }

  async function doWrite(sessionId, st) {
    const { blobs, ...meta } = serializeSessionState(st);
    await writeBlobs(sessionId, blobs);
    await writeMeta(sessionId, meta);
    await pruneOrphanBlobs(sessionId, collectRefs(meta.records));
  }

  /**
   * 立即落盘（异步）。调用方（`persistSession`）已经把内容预算裁过了。
   * 同一会话的写串行化：后一次写覆盖前一次，绝不交叉 rename。
   * 失败会 reject —— 落盘失败必须有人看见（撤回能力是用户可感知的功能）。
   */
  function writeSessionNow(sessionId, st) {
    const sid = String(sessionId || '').trim();
    if (!root || !sid || !st) return Promise.resolve(false);
    const prev = writeChains.get(sid) || Promise.resolve();
    const next = prev.catch(() => {}).then(() => doWrite(sid, st)).then(() => true);
    writeChains.set(sid, next.catch(() => {}));
    return next;
  }

  function scheduleSave(sessionId, st) {
    const sid = String(sessionId || '').trim();
    if (!root || !sid || !st) return;
    pendingPayloads.set(sid, st);
    const prev = pendingTimers.get(sid);
    if (prev) clearTimeout(prev);
    pendingTimers.set(
      sid,
      setTimeout(() => {
        pendingTimers.delete(sid);
        const latest = pendingPayloads.get(sid);
        pendingPayloads.delete(sid);
        if (!latest) return;
        writeSessionNow(sid, latest).catch(() => {});
      }, SAVE_DEBOUNCE_MS)
    );
  }

  async function flushSession(sessionId) {
    const sid = String(sessionId || '').trim();
    if (!root || !sid) return;
    const timer = pendingTimers.get(sid);
    if (timer) {
      clearTimeout(timer);
      pendingTimers.delete(sid);
    }
    const st = pendingPayloads.get(sid);
    pendingPayloads.delete(sid);
    if (st) await writeSessionNow(sid, st);
  }

  async function deleteSession(sessionId) {
    const sid = String(sessionId || '').trim();
    if (!root || !sid) return;
    const timer = pendingTimers.get(sid);
    if (timer) {
      clearTimeout(timer);
      pendingTimers.delete(sid);
    }
    pendingPayloads.delete(sid);
    const pendingWrite = writeChains.get(sid);
    if (pendingWrite) await pendingWrite.catch(() => {});
    writeChains.delete(sid);
    writtenRefs.delete(sid);
    try {
      await fs.unlink(sessionFilePath(root, sid));
    } catch (err) {
      if (err && err.code !== 'ENOENT') throw err;
    }
    try {
      await fs.rm(blobDirPath(root, sid), { recursive: true, force: true });
    } catch {
      // 内容块目录删不掉不影响撤回能力（元数据已删，无人再引用）
    }
  }

  function hasStore() {
    return !!root;
  }

  return {
    hasStore,
    loadSession,
    loadSessionSync,
    scheduleSave,
    flushSession,
    deleteSession,
    writeSessionNow
  };
}

module.exports = {
  createTurnUndoStore,
  contentRef,
  REF_HEX_LEN,
  STORE_VERSION,
  SAVE_DEBOUNCE_MS
};

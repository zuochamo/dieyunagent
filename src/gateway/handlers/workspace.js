'use strict';

const path = require('path');
const {
  normalizeResolveInput,
  extractTailSegments,
  buildCandidateGlobs,
  rankPathCandidates,
  MAX_CANDIDATE_SEGMENTS
} = require('../../workspace/resolve-path-candidates');

/**
 * 工作区路径的「权威解析」。
 *
 * 问题：Agent 输出 / 会话记录 / 本地剪贴板带来的路径常常是别的视角的
 * （`C:\Users\me\proj\src\a.ts`、另一台机器的 `/home/other/proj/src/a.ts`），
 * 在当前远程工作区里原样不存在。Renderer 只有一份文件列表**副本**，
 * 用它推断映射就是猜 —— 猜错会打开另一个文件，而且那个路径会被编辑器的
 * 保存按钮写下去（覆盖错误的远程文件，不可逆）。
 *
 * 本 handler 把判断权交回给持有文件系统的那一层：先按原路径 stat（零搜索），
 * 未命中才用尾部特征让远程 rg 找候选，**多候选交给用户选，绝不自动采用**。
 *
 * 算法（特征提取 / glob 生成 / 排序）在 workspace/resolve-path-candidates.js，
 * 是纯函数并有单测；本文件只负责编排 IO 与护栏。
 */

const DEFAULT_TIMEOUT_MS = 10000;
const MIN_TIMEOUT_MS = 3000;
const MAX_TIMEOUT_MS = 30000;
const DEFAULT_MAX_CANDIDATES = 20;
/** 同会话同输入的重入窗口：防止用户连点造成远程 rg 风暴。 */
const DEDUPE_WINDOW_MS = 5000;
/** 候选补 stat 的并发度（拿 size/mtime 供排序）。 */
const STAT_CONCURRENCY = 5;

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

/**
 * 并发受限的 stat：拿不到就退化为 0（排序仍可用路径长度兜底），不因单个失败中断。
 * @param {{ stat: (p: string) => Promise<{size?: number, mtimeMs?: number}> }} remote
 * @param {string[]} paths 绝对路径
 */
async function statCandidates(remote, paths) {
  const out = new Array(paths.length);
  let next = 0;
  async function worker() {
    while (next < paths.length) {
      const i = next++;
      const p = paths[i];
      try {
        const st = await remote.stat(p);
        out[i] = { path: p, size: (st && st.size) || 0, mtimeMs: (st && st.mtimeMs) || 0 };
      } catch {
        out[i] = { path: p, size: 0, mtimeMs: 0 };
      }
    }
  }
  const width = Math.min(STAT_CONCURRENCY, Math.max(1, paths.length));
  await Promise.all(Array.from({ length: width }, () => worker()));
  return out;
}

/**
 * @param {{
 *   getRemoteFs: Function,
 *   globViaRemoteExec: Function,
 *   resolveCallWorkspaceTarget: Function,
 *   isSshConnectedForCall: Function,
 *   getActiveCallSessionId?: Function
 * }} deps
 */
function createWorkspaceHandlers(deps) {
  const getRemoteFs = deps.getRemoteFs;
  const globViaRemoteExec = deps.globViaRemoteExec;
  const resolveCallWorkspaceTarget = deps.resolveCallWorkspaceTarget;
  const isSshConnectedForCall = deps.isSshConnectedForCall;
  const getActiveCallSessionId =
    typeof deps.getActiveCallSessionId === 'function' ? deps.getActiveCallSessionId : () => null;

  /** `${sessionId}|${input}` → 上次解析时间戳 */
  const recentResolves = new Map();

  function isReentrant(key) {
    const now = Date.now();
    // 顺手清理过期项：这张表只会随「用户点过的不同路径」增长，不清会慢慢变大
    for (const [k, ts] of recentResolves) {
      if (now - ts > DEDUPE_WINDOW_MS) recentResolves.delete(k);
    }
    const last = recentResolves.get(key);
    if (last != null && now - last < DEDUPE_WINDOW_MS) return true;
    recentResolves.set(key, now);
    return false;
  }

  async function resolvePath(params) {
    const raw = params && params.inputPath != null ? params.inputPath : '';
    const input = normalizeResolveInput(raw);
    if (!input) {
      return { ok: false, code: 'INVALID_PATH', reason: '路径为空', inputPath: '' };
    }

    // 本地工作区：路径无歧义，不做模糊匹配（否则只会引入新风险）
    const target = resolveCallWorkspaceTarget();
    if (!target || target.kind !== 'ssh') {
      return {
        ok: false,
        code: 'NOT_SSH_WORKSPACE',
        reason: '当前工作区在本地，本地路径无需远程解析',
        inputPath: input
      };
    }
    if (!isSshConnectedForCall()) {
      return { ok: false, code: 'SSH_NOT_CONNECTED', reason: 'SSH 未连接', inputPath: input };
    }
    const remote = getRemoteFs();
    if (!remote || !remote.root) {
      return { ok: false, code: 'SSH_NOT_CONNECTED', reason: '远程工作区不可用', inputPath: input };
    }

    const timeoutMs = clampInt(params && params.timeoutMs, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
    const maxCandidates = clampInt(
      params && params.maxCandidates,
      1,
      50,
      DEFAULT_MAX_CANDIDATES
    );
    const started = Date.now();
    const deadline = started + timeoutMs;

    // 同输入重入：直接复用上一条建议（不再重复打远程）
    const sid = getActiveCallSessionId() || '';
    if (isReentrant(`${sid}|${input}`)) {
      return {
        ok: false,
        code: 'THROTTLED',
        reason: '刚刚已解析过这个路径，请稍候再试',
        inputPath: input
      };
    }

    // ——— Step 1：原样尝试。只有 1 次 SFTP stat，零搜索 ———
    // 越界路径（PATH_NOT_ALLOWED）不在这里判失败：它可能是别的机器的路径，
    // 尾部特征仍然值得去远程找一找；但绝不允许把越界路径直接当成目标返回。
    try {
      const st = await remote.stat(input);
      if (st) {
        return {
          ok: true,
          exact: true,
          path: input,
          candidates: [],
          truncated: false,
          searched: { patterns: [], roots: [remote.root], elapsedMs: Date.now() - started }
        };
      }
    } catch {
      // 继续走候选查找
    }

    // ——— Step 2：尾部特征 glob，由长到短，命中即停 ———
    const segments = extractTailSegments(input, MAX_CANDIDATE_SEGMENTS);
    const patterns = buildCandidateGlobs(segments);
    if (!patterns.length) {
      return {
        ok: false,
        code: 'NOT_FOUND',
        reason: '该路径没有可用于匹配的文件名特征',
        inputPath: input
      };
    }

    const searchedPatterns = [];
    let hit = null;
    let usedPattern = '';
    let searchUnavailable = '';
    for (const pattern of patterns) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      searchedPatterns.push(pattern);
      let r = null;
      try {
        r = await globViaRemoteExec(remote.root, {
          pattern,
          maxResults: maxCandidates + 1,
          timeoutMs: Math.max(MIN_TIMEOUT_MS, remaining)
        });
      } catch {
        r = null;
      }
      if (r && r.ok === false) {
        searchUnavailable = String(r.error || r.errorCode || '');
        break;
      }
      const files = r && Array.isArray(r.files) ? r.files.filter(Boolean) : [];
      if (files.length) {
        hit = files;
        usedPattern = pattern;
        break;
      }
    }

    if (!hit) {
      if (searchUnavailable) {
        return {
          ok: false,
          code: 'SEARCH_UNAVAILABLE',
          reason: `远程检索不可用：${searchUnavailable}`,
          inputPath: input
        };
      }
      return {
        ok: false,
        code: 'NOT_FOUND',
        reason: `远程工作区内没有与 ${segments.join('/')} 匹配的文件`,
        inputPath: input
      };
    }

    // rg --files 给的是相对 cwd 的路径：补全为工作区绝对路径
    const absPaths = hit
      .map((rel) => (path.posix.isAbsolute(rel) ? rel : path.posix.join(remote.root, rel)))
      .filter(Boolean)
      .slice(0, maxCandidates + 1);

    const statted = await statCandidates(remote, absPaths);
    const withRel = statted.map((c) => ({
      ...c,
      relativePath: path.posix.relative(remote.root, c.path) || c.path,
      matchKind: usedPattern.replace(/^\*\*\//, '')
    }));
    const ranked = rankPathCandidates(withRel, { maxCandidates });

    if (!ranked.candidates.length) {
      return {
        ok: false,
        code: 'NOT_FOUND',
        reason: `远程工作区内没有与 ${segments.join('/')} 匹配的文件`,
        inputPath: input
      };
    }

    return {
      ok: true,
      exact: false,
      path: '',
      candidates: ranked.candidates,
      truncated: ranked.truncated,
      searched: {
        patterns: searchedPatterns,
        roots: [remote.root],
        elapsedMs: Date.now() - started
      }
    };
  }

  return {
    'workspace.resolve_path': resolvePath
  };
}

module.exports = { createWorkspaceHandlers };

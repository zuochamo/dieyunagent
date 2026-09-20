'use strict';

/**
 * SSH 工作区「路径权威解析」的纯算法部分。
 *
 * 背景：Agent 输出、会话记录、本地剪贴板经常带来「别的视角」的路径
 * （`C:\Users\me\proj\src\a.ts`、另一台机器上的 `/home/other/proj/src/a.ts`），
 * 它们在当前远程工作区里原样并不存在。Renderer 手里只有一份文件列表**副本**，
 * 用它去推断真实状态本质上就是猜（猜错的代价是打开另一个文件，且那个路径会被
 * 编辑器的保存按钮写进去）。唯一有资格下判断的是持有文件系统的那一层。
 *
 * 本模块只负责「怎么问」：从输入路径里提取**可辨识的尾部特征**，生成由长到短的
 * glob 模式（越长越精确，命中即停可避免返回一堆同名噪音），并对命中的候选排序。
 * 不含任何 IO / 不依赖 ssh 模块，便于单测。
 */

const SSH_URI_RE = /^ssh:(?:\/\/)?[^@/]+@[^/:]+(?::\d+)?(\/.*)?$/i;

/** 盘符段（`C:` / `D:`）不是「路径段」，参与匹配只会引入噪音。 */
const DRIVE_SEGMENT_RE = /^[a-zA-Z]:$/;

/** 超长段可能是 base64 / 哈希目录名，不适合当匹配特征。 */
const MAX_SEGMENT_LEN = 128;

/** 尾部特征段数上限：段数越多越精确，但中间目录名一旦不同就会全灭。 */
const MAX_CANDIDATE_SEGMENTS = 3;

/** 候选数硬上限（UI 可读性 + 传输量）。 */
const MAX_CANDIDATE_LIMIT = 50;

/**
 * 归一化外部输入：去首尾引号、反斜杠转正斜杠、剥离 `ssh:` URI。
 *
 * 刻意只做「归一化」，不判断合法性 —— 「这个路径是否被允许」由 Gateway 的
 * 权威校验（resolveRemotePath / assertAllowedPath）负责，避免两套判定不一致。
 *
 * @param {string} inputPath
 * @returns {string} 归一化后的路径；空输入返回 ''
 */
function normalizeResolveInput(inputPath) {
  let s = String(inputPath == null ? '' : inputPath).trim();
  if (!s) return '';
  s = s.replace(/^["']+|["']+$/g, '');
  const m = s.match(SSH_URI_RE);
  if (m) s = m[1] || '/';
  return s.replace(/\\/g, '/');
}

/**
 * 提取尾部特征段（从浅到深，最多 limit 段）。
 *
 *   'C:\\Users\\me\\proj\\src\\renderer\\agent\\foo.js'
 *     → ['src', 'renderer', 'agent', 'foo.js']  // limit=4 时
 *     → ['renderer', 'agent', 'foo.js']         // limit=3 时（默认）
 *
 * 过滤掉：空段、`.`、`..`、盘符段、超长段。
 *
 * @param {string} inputPath
 * @param {number} [limit]
 * @returns {string[]}
 */
function extractTailSegments(inputPath, limit) {
  const norm = normalizeResolveInput(inputPath);
  if (!norm) return [];
  const segs = norm.split('/').filter((s) => {
    if (!s || s === '.' || s === '..') return false;
    if (DRIVE_SEGMENT_RE.test(s)) return false;
    return s.length <= MAX_SEGMENT_LEN;
  });
  if (!segs.length) return [];
  const n = Math.max(1, Math.min(segs.length, Number(limit) || MAX_CANDIDATE_SEGMENTS));
  return segs.slice(-n);
}

/**
 * 由长到短生成 glob 模式：越长越精确，调用方按序尝试、命中即停。
 *
 *   ['renderer','agent','foo.js']
 *     → ['**​/renderer/agent/foo.js', '**​/agent/foo.js', '**​/foo.js']
 *
 * @param {string[]} segments
 * @returns {string[]}
 */
function buildCandidateGlobs(segments) {
  const segs = Array.isArray(segments) ? segments.filter(Boolean) : [];
  const out = [];
  for (let n = segs.length; n >= 1; n -= 1) {
    const tail = segs.slice(segs.length - n).join('/');
    if (tail) out.push(`**/${tail}`);
  }
  return out;
}

/**
 * 候选排序 + 去重 + 截断。
 *
 * 排序：mtime 降序（最近改动的更可能是目标）→ 路径更短者优先（更浅的更可能）
 * → 字典序兜底（保证结果稳定，便于测试与复现）。
 *
 * @param {Array<{path?: string, relativePath?: string, size?: number, mtimeMs?: number, matchKind?: string}>} candidates
 * @param {{ maxCandidates?: number }} [opts]
 * @returns {{ candidates: object[], truncated: boolean, total: number }}
 */
function rankPathCandidates(candidates, opts = {}) {
  const wanted = Number(opts && opts.maxCandidates) || 20;
  const max = Math.max(1, Math.min(MAX_CANDIDATE_LIMIT, wanted));
  const seen = new Set();
  const out = [];
  for (const c of Array.isArray(candidates) ? candidates : []) {
    const p = String((c && c.path) || '').trim();
    if (!p) continue;
    const key = p.replace(/\\/g, '/');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      path: p,
      relativePath: String((c && c.relativePath) || ''),
      size: Number((c && c.size) || 0),
      mtimeMs: Number((c && c.mtimeMs) || 0),
      matchKind: String((c && c.matchKind) || '')
    });
  }
  out.sort((a, b) => {
    const dm = (b.mtimeMs || 0) - (a.mtimeMs || 0);
    if (dm) return dm;
    const dl = a.path.length - b.path.length;
    if (dl) return dl;
    return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
  });
  return {
    candidates: out.slice(0, max),
    truncated: out.length > max,
    total: out.length
  };
}

module.exports = {
  normalizeResolveInput,
  extractTailSegments,
  buildCandidateGlobs,
  rankPathCandidates,
  MAX_CANDIDATE_SEGMENTS,
  MAX_CANDIDATE_LIMIT
};

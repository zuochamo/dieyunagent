'use strict';

const fsp = require('fs/promises');
const path = require('path');
const { spawn } = require('child_process');
const { bufferLooksBinary } = require('../git/git-target');
// 忽略口径的唯一来源：`index/source-files.js`（与 Rust `index/walker.rs` 的 IGNORE_DIRS /
// IGNORE_EXT 对齐，并由 `test/unit/ignore-rules-parity.test.cjs` 机器校验）。
// 本文件此前自带一份 IGNORE_DIRS + IGNORE_EXT：目录表逐字相同，扩展名表却只有一半
// （缺 .docx/.xlsx/.pptx/.tar/.dylib/.apk …），于是 grep/glob 会把办公文档当文本返回，
// 而同一份工作区的索引进不去 —— 两套口径对不上时，用户看到的就是「搜得到、索引里没有」。
const { IGNORED_DIRS, BINARY_EXT } = require('../index/source-files');

const DEFAULT_GREP_LIMIT = 50;
const MAX_GREP_LIMIT = 200;
const DEFAULT_GLOB_LIMIT = 80;
const MAX_GLOB_LIMIT = 400;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_WALK_FILES = 8000;
const RG_TIMEOUT_MS = 20000;
/** 每侧上下文行上限，防止一次 grep 把整文件灌回模型 */
const MAX_GREP_CONTEXT = 10;
/** 解析前收集的原始条目上限，防御病态输入 */
const MAX_RAW_GREP_ITEMS = 20000;
/** 0 命中时探测「被体积上限跳过」的文件：只 stat 不解压，硬上限防超大仓库拖住 */
const OVERSIZE_PROBE_MAX_WALK = 4000;
const OVERSIZE_PROBE_MAX_DEPTH = 10;

function clampLimit(n, fallback, max) {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return fallback;
  return Math.min(max, Math.max(1, Math.floor(v)));
}

function clampContext(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return 0;
  return Math.min(MAX_GREP_CONTEXT, Math.floor(v));
}

/** 解析 before/after 上下文请求；context 为双向快捷方式 */
function resolveGrepContext(opts) {
  const both = clampContext(opts.context);
  const before = opts.beforeContext != null ? clampContext(opts.beforeContext) : both;
  const after = opts.afterContext != null ? clampContext(opts.afterContext) : both;
  return { before, after };
}

function sliceContext(lines, startIdx, endIdx) {
  const out = [];
  for (let i = Math.max(0, startIdx); i < Math.min(lines.length, endIdx); i++) {
    out.push({ line: i + 1, text: String(lines[i]).slice(0, 400) });
  }
  return out;
}

function escapeRegex(s) {
  return String(s).replace(/[|\\{}()[\]^$+*?.]/g, '\\$&');
}

function globToRegExp(glob) {
  let g = String(glob || '')
    .replace(/\\/g, '/')
    .trim();
  if (!g || g === '**' || g === '**/*') return /^.*$/i;
  if (!g.includes('/')) g = `**/${g}`;
  let re = '^';
  for (let i = 0; i < g.length; ) {
    if (g[i] === '*' && g[i + 1] === '*') {
      if (g[i + 2] === '/') {
        re += '(?:.*/)?';
        i += 3;
      } else {
        re += '.*';
        i += 2;
      }
      continue;
    }
    if (g[i] === '*') {
      re += '[^/]*';
      i += 1;
      continue;
    }
    if (g[i] === '?') {
      re += '[^/]';
      i += 1;
      continue;
    }
    re += escapeRegex(g[i]);
    i += 1;
  }
  re += '$';
  return new RegExp(re, 'i');
}

function matchGlob(relPath, pattern) {
  if (!pattern) return true;
  const norm = String(relPath || '').replace(/\\/g, '/');
  return globToRegExp(pattern).test(norm);
}

function shouldSkipDir(name) {
  return IGNORED_DIRS.has(String(name || '')) || String(name || '').startsWith('.');
}

function shouldSkipFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return BINARY_EXT.has(ext);
}

/** 单次遍历累积的 gitignore 规则上限，防御超大 ignore 文件 */
const GITIGNORE_MAX_RULES = 4000;

/**
 * gitignore 通配转正则。支持 `*`（不跨 /）、`**`（跨 /）、`?`、字符类、
 * `\` 转义；未含 `/` 的规则可匹配任意层级。
 */
function gitignoreGlobToRegExp(pattern, anchored) {
  let re = anchored ? '^' : '(?:^|/)';
  for (let i = 0; i < pattern.length; ) {
    const ch = pattern[i];
    if (ch === '\\' && i + 1 < pattern.length) {
      re += escapeRegex(pattern[i + 1]);
      i += 2;
      continue;
    }
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        if (pattern[i + 2] === '/') {
          re += '(?:.*/)?';
          i += 3;
        } else {
          re += '.*';
          i += 2;
        }
        continue;
      }
      re += '[^/]*';
      i += 1;
      continue;
    }
    if (ch === '?') {
      re += '[^/]';
      i += 1;
      continue;
    }
    if (ch === '[') {
      const end = pattern.indexOf(']', i + 1);
      if (end > i + 1) {
        const cls = pattern.slice(i, end + 1);
        re += /^\[\^?[^\]]+\]$/.test(cls) ? cls : escapeRegex(cls);
        i = end + 1;
        continue;
      }
    }
    re += escapeRegex(ch);
    i += 1;
  }
  re += '(?:/.*)?$';
  return new RegExp(re, 'i');
}

/** 解析一段 .gitignore 文本，baseRel 为该文件所在目录相对工作区根的路径 */
function parseGitignoreLines(text, baseRel) {
  const rules = [];
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    let line = rawLine.replace(/\s+$/, '');
    if (!line.trim() || line.startsWith('#')) continue;
    let negated = false;
    if (line.startsWith('!')) {
      negated = true;
      line = line.slice(1);
    }
    if (!line) continue;
    let dirOnly = false;
    if (line.endsWith('/')) {
      dirOnly = true;
      line = line.replace(/\/+$/, '');
    }
    if (!line) continue;
    const anchored = line.includes('/');
    if (line.startsWith('/')) line = line.slice(1);
    if (!line) continue;
    rules.push({ re: gitignoreGlobToRegExp(line, anchored), negated, dirOnly, baseRel });
    if (rules.length >= GITIGNORE_MAX_RULES) break;
  }
  return rules;
}

/** 按声明顺序应用规则，后出现的（更深层）覆盖先前 */
function isGitIgnored(relPath, isDir, rules) {
  if (!rules || !rules.length) return false;
  const norm = String(relPath).replace(/\\/g, '/');
  let ignored = false;
  for (const r of rules) {
    if (r.dirOnly && !isDir) continue;
    let probe = norm;
    if (r.baseRel) {
      if (!norm.startsWith(`${r.baseRel}/`)) continue;
      probe = norm.slice(r.baseRel.length + 1);
    }
    if (!probe) continue;
    if (r.re.test(probe)) ignored = !r.negated;
  }
  return ignored;
}

function spawnRg(args, cwd, timeoutMs) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const proc = spawn('rg', args, {
      cwd,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const timer = setTimeout(() => {
      try {
        proc.kill();
      } catch {
        /* ignore */
      }
    }, timeoutMs || RG_TIMEOUT_MS);
    proc.stdout.on('data', (c) => {
      stdout += c.toString('utf8');
      if (stdout.length > 8 * 1024 * 1024) {
        try {
          proc.kill();
        } catch {
          /* ignore */
        }
      }
    });
    proc.stderr.on('data', (c) => {
      stderr += c.toString('utf8');
    });
    proc.on('error', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, missing: true });
    });
    proc.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: true, code: code == null ? 1 : code, stdout, stderr });
    });
  });
}

function parseRgJsonMatches(stdout, root, limit, ctx = {}) {
  const before = ctx.before || 0;
  const after = ctx.after || 0;
  const wantContext = before > 0 || after > 0;
  /** @type {Map<string, Array<{ isMatch: boolean, line: number, text: string }>>} */
  const byPath = new Map();
  const order = [];
  let rawItems = 0;

  for (const raw of String(stdout || '').split(/\n/)) {
    if (!raw.trim()) continue;
    if (rawItems >= MAX_RAW_GREP_ITEMS) break;
    let obj;
    try {
      obj = JSON.parse(raw);
    } catch {
      continue;
    }
    if (!obj || !obj.data) continue;
    const isMatch = obj.type === 'match';
    const isContext = obj.type === 'context';
    if (!isMatch && !isContext) continue;
    const p = obj.data.path && obj.data.path.text;
    if (!p) continue;
    const abs = path.isAbsolute(p) ? p : path.join(root, p);
    const rel = path.relative(root, abs).replace(/\\/g, '/');
    const text =
      obj.data.lines && obj.data.lines.text != null
        ? String(obj.data.lines.text).replace(/\n$/, '')
        : '';
    if (!byPath.has(rel)) {
      byPath.set(rel, []);
      order.push(rel);
    }
    byPath.get(rel).push({
      isMatch,
      line: Number(obj.data.line_number) || 1,
      text: text.slice(0, 400)
    });
    rawItems += 1;
  }

  const matches = [];
  for (const rel of order) {
    const items = byPath.get(rel);
    for (let i = 0; i < items.length; i++) {
      if (!items[i].isMatch) continue;
      const entry = { path: rel, line: items[i].line, text: items[i].text };
      if (wantContext) {
        if (before > 0) {
          const seg = [];
          for (let j = Math.max(0, i - before); j < i; j++) {
            if (items[j].isMatch) continue;
            seg.push({ line: items[j].line, text: items[j].text });
          }
          if (seg.length) entry.before = seg;
        }
        if (after > 0) {
          const seg = [];
          for (let j = i + 1; j < Math.min(items.length, i + 1 + after); j++) {
            if (items[j].isMatch) continue;
            seg.push({ line: items[j].line, text: items[j].text });
          }
          if (seg.length) entry.after = seg;
        }
      }
      matches.push(entry);
      if (matches.length >= limit) return matches;
    }
  }
  return matches;
}

function parseRgFiles(stdout, root, limit) {
  const out = [];
  for (const line of String(stdout || '').split(/\r?\n/)) {
    const p = line.trim();
    if (!p) continue;
    const abs = path.isAbsolute(p) ? p : path.join(root, p);
    const rel = path.relative(root, abs).replace(/\\/g, '/');
    if (!rel || rel.startsWith('..')) continue;
    out.push(rel);
    if (out.length >= limit) break;
  }
  return out;
}

async function walkFiles(root, glob, limit, maxWalk, useGitignore = false) {
  const out = [];
  /** @type {Array<{ dir: string, rel: string, rules: object[] }>} */
  const stack = [{ dir: root, rel: '', rules: [] }];
  let walked = 0;
  while (stack.length && walked < maxWalk && out.length < limit) {
    const frame = stack.pop();
    const { dir, rel } = frame;
    let ents;
    try {
      ents = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    // 只在该目录确实存在 .gitignore 时才读；否则每个目录都要付一次失败的 IO
    let rules = frame.rules;
    if (useGitignore && ents.some((e) => e.name === '.gitignore' && e.isFile())) {
      try {
        const text = await fsp.readFile(path.join(dir, '.gitignore'), 'utf8');
        const extra = parseGitignoreLines(text, rel);
        if (extra.length) rules = frame.rules.concat(extra);
      } catch {
        /* 读不到就沿用上层规则 */
      }
    }
    for (const ent of ents) {
      const full = path.join(dir, ent.name);
      const childRel = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isDirectory()) {
        if (shouldSkipDir(ent.name)) continue;
        if (useGitignore && isGitIgnored(childRel, true, rules)) continue;
        stack.push({ dir: full, rel: childRel, rules });
        continue;
      }
      if (!ent.isFile()) continue;
      walked += 1;
      if (walked > maxWalk) break;
      if (shouldSkipFile(full)) continue;
      if (useGitignore && isGitIgnored(childRel, false, rules)) continue;
      const relPath = childRel.replace(/\\/g, '/');
      if (!matchGlob(relPath, glob)) continue;
      out.push(relPath);
      if (out.length >= limit) break;
    }
  }
  out.sort((a, b) => a.localeCompare(b));
  return { files: out, truncated: walked >= maxWalk || out.length >= limit };
}

/** rg 类型名 → 扩展名（JS 兜底路径用；rg 侧直接用 -t） */
const TYPE_EXT = {
  rust: ['.rs'],
  go: ['.go'],
  js: ['.js', '.mjs', '.cjs', '.jsx'],
  ts: ['.ts', '.tsx', '.mts', '.cts'],
  py: ['.py'],
  json: ['.json'],
  md: ['.md', '.markdown'],
  css: ['.css', '.scss'],
  html: ['.html', '.htm'],
  sh: ['.sh', '.bash'],
  yaml: ['.yml', '.yaml']
};

/** JS 兜底遍历的并发度：此前逐文件串行 await，大仓库很慢 */
const GREP_JS_CONCURRENCY = 16;

function compileGrepNeedle(pattern, regex, caseInsensitive, multiline = false) {
  const raw = String(pattern || '');
  const flags = `${caseInsensitive ? 'gi' : 'g'}${multiline ? 's' : ''}`;
  if (regex) {
    try {
      return new RegExp(raw, flags);
    } catch {
      return { error: 'INVALID_REGEX', message: 'pattern 不是合法正则' };
    }
  }
  return new RegExp(escapeRegex(raw), flags);
}

/** 每行起始 offset，用于把跨行匹配的字符下标换算成行号 */
function buildLineStarts(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) starts.push(i + 1);
  }
  return starts;
}

function lineNumberForOffset(starts, offset) {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

/**
 * 多行模式的 `/g` 副本：同一轮检索里 `needle` 是同一个对象，只编译一次。
 * 每次进文件前必须把 `lastIndex` 归零（与原「每文件新建一个正则」等价）。
 */
let multilineNeedleCache = null;

function multilineRegExpFor(needle) {
  if (multilineNeedleCache && multilineNeedleCache.needle === needle) return multilineNeedleCache.re;
  const re = new RegExp(needle.source, needle.flags.includes('g') ? needle.flags : `${needle.flags}g`);
  multilineNeedleCache = { needle, re };
  return re;
}

/** 扫单个文件；返回 { entries, total }，不可读/二进制的返回 null */
async function scanOneFileForGrep(root, rel, needle, opts) {
  const abs = path.join(root, rel);
  let st;
  try {
    st = await fsp.stat(abs);
  } catch {
    return null;
  }
  if (st.size > MAX_FILE_BYTES) return null;
  let text;
  try {
    const buf = await fsp.readFile(abs);
    // 「含 NUL 即二进制」是全局单一规则（见 git/git-target.bufferLooksBinary）
    if (bufferLooksBinary(buf)) return null;
    text = buf.toString('utf8');
  } catch {
    return null;
  }

  const entries = [];
  let total = 0;

  if (opts.multiline) {
    // 跨行匹配：整文件跑正则，再把字符下标换算成行号
    const starts = buildLineStarts(text);
    const re = multilineRegExpFor(needle);
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      total += 1;
      if (!opts.countOnly && entries.length < opts.limit) {
        const lineNo = lineNumberForOffset(starts, m.index);
        const nl = text.indexOf('\n', m.index);
        const raw = text.slice(m.index, nl === -1 ? undefined : nl);
        entries.push({ path: rel, line: lineNo, text: raw.slice(0, 400) });
      }
      if (m.index === re.lastIndex) re.lastIndex += 1; // 防零宽匹配死循环
    }
    return { entries, total };
  }

  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    needle.lastIndex = 0;
    if (!needle.test(lines[i])) continue;
    total += 1;
    if (opts.countOnly || entries.length >= opts.limit) continue;
    const entry = { path: rel, line: i + 1, text: lines[i].slice(0, 400) };
    if (opts.before > 0) {
      const seg = sliceContext(lines, i - opts.before, i);
      if (seg.length) entry.before = seg;
    }
    if (opts.after > 0) {
      const seg = sliceContext(lines, i + 1, i + 1 + opts.after);
      if (seg.length) entry.after = seg;
    }
    entries.push(entry);
  }
  return { entries, total };
}

async function grepJsFallback(root, opts) {
  const limit = clampLimit(opts.maxResults, DEFAULT_GREP_LIMIT, MAX_GREP_LIMIT);
  const { before, after } = resolveGrepContext(opts);
  const multiline = opts.multiline === true;
  const countOnly = opts.count === true;
  const typeFilter = String(opts.type || '').trim().toLowerCase();
  const needle = compileGrepNeedle(opts.pattern, opts.regex, opts.caseInsensitive, multiline);
  if (needle.error) return { ok: false, errorCode: needle.error, error: needle.message };

  const walk = await walkFiles(root, opts.glob, MAX_WALK_FILES, MAX_WALK_FILES, true);
  const exts = TYPE_EXT[typeFilter];
  const files = exts
    ? walk.files.filter((rel) => exts.includes(path.extname(rel).toLowerCase()))
    : walk.files;

  const matches = [];
  let total = 0;
  let truncated = false;

  // 分批并行读文件
  for (let i = 0; i < files.length; i += GREP_JS_CONCURRENCY) {
    const batch = files.slice(i, i + GREP_JS_CONCURRENCY);
    const scanned = await Promise.all(
      batch.map((rel) =>
        scanOneFileForGrep(root, rel, needle, { multiline, countOnly, before, after, limit })
      )
    );
    for (const r of scanned) {
      if (!r) continue;
      total += r.total;
      if (countOnly) continue;
      for (const e of r.entries) {
        matches.push(e);
        if (matches.length >= limit) {
          truncated = true;
          break;
        }
      }
      if (truncated) break;
    }
    if (truncated) break;
  }

  if (countOnly) {
    return { ok: true, matches: [], count: total, truncated: false, source: 'js', countOnly: true };
  }
  return { ok: true, matches, truncated, source: 'js', context: { before, after } };
}

/**
 * 有界扫描：数一数搜索范围内有多少文件超过 MAX_FILE_BYTES。
 *
 * 为什么需要它：rg 侧用 `--max-filesize 1M` 跳过超大文件，JS 兜底也在 scanOneFileForGrep
 * 里 `return null`——两条路都是**静默**的。模型搜 UE/渲染日志（单文件几百 MB）时会拿到
 * 「0 命中」，进而得出「日志里没有这个报错」的错误结论。这里只在 0 命中时补一次 stat
 * 扫描（不读内容），把「被跳过」这件事说出口。
 *
 * @param {string} root 工作区根（用于生成相对路径）
 * @param {string} searchPath 本次搜索的起点
 * @returns {Promise<{ count: number, examples: string[], limitBytes: number, scanned: number, truncated: boolean }>}
 */
async function probeOversizeFiles(root, searchPath) {
  const out = { count: 0, examples: [], limitBytes: MAX_FILE_BYTES, scanned: 0, truncated: false };
  const startRel = path.relative(root, searchPath);
  const stack = [{ dir: searchPath, rel: startRel }];
  let walked = 0;
  while (stack.length) {
    const { dir, rel } = stack.pop();
    if (rel.split(/[\\/]/).filter(Boolean).length > OVERSIZE_PROBE_MAX_DEPTH) {
      out.truncated = true;
      continue;
    }
    let ents;
    try {
      ents = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of ents) {
      if (ent.isDirectory()) {
        if (shouldSkipDir(ent.name)) continue;
        stack.push({ dir: path.join(dir, ent.name), rel: path.join(rel, ent.name) });
        continue;
      }
      if (!ent.isFile()) continue;
      walked += 1;
      if (walked > OVERSIZE_PROBE_MAX_WALK) {
        out.truncated = true;
        stack.length = 0;
        break;
      }
      const full = path.join(dir, ent.name);
      if (shouldSkipFile(full)) continue;
      let st;
      try {
        st = await fsp.stat(full);
      } catch {
        continue;
      }
      if (st.size <= MAX_FILE_BYTES) continue;
      out.count += 1;
      if (out.examples.length < 3) {
        out.examples.push(path.relative(root, full).replace(/\\/g, '/'));
      }
    }
  }
  out.scanned = walked;
  return out;
}

/**
 * 给「0 命中」的结果补一条可执行的说明：有多少文件因为体积被跳过、该怎么查。
 * 有命中时原样返回（不增加任何开销）。
 * @param {object} result grepWorkspace / grepJsFallback 的返回
 * @param {string} absRoot
 * @param {string} searchPath
 */
async function withOversizeHint(result, absRoot, searchPath) {
  if (!result || !result.ok) return result;
  const noHit =
    Array.isArray(result.matches) && result.matches.length === 0 && !(Number(result.count) > 0);
  if (!noHit) return result;
  let oversize;
  try {
    oversize = await probeOversizeFiles(absRoot, searchPath);
  } catch {
    return result;
  }
  if (!oversize.count) return result;
  const sample = oversize.examples.join('、');
  const countText = `${oversize.truncated ? '至少 ' : ''}${oversize.count} 个`;
  return {
    ...result,
    oversizeSkipped: oversize,
    note:
      `0 命中，但搜索范围内有 ${countText} >1MB 的文件**没有参与搜索**` +
      `（如 ${sample}）；这些文件里的内容本次查不到，不等于不存在。` +
      '大日志请改用 host_exec：`findstr /C:"关键词" "文件路径"`，或写临时 py 脚本读尾部。'
  };
}

/**
 * 搜索根必须真的存在——否则「没搜到」和「没搜」在返回值里长得一模一样。
 *
 * 为什么不能省：rg 找不到路径时退出码是 2，`grepWorkspace` 随即退到 JS 兜底；而兜底的
 * `walkFiles` 读不到目录只是返回空列表，于是整条链路以 `{ok:true, matches:[], count:0}`
 * 收尾。模型据此得出「仓库里没有这段代码」并放弃检索，真实原因却是**根不对**
 * （远端会话的路径被拼成本机盘符等，见 SSH-MODULE-REVIEW S14）。
 *
 * 只判「根是否存在、是不是目录」：这是唯一能确定的证据，不做路径猜测。
 *
 * @param {string} absRoot 已 resolve 的搜索根
 * @param {string} searchPath 已 resolve 的搜索范围（可能等于根，也可能是文件）
 * @returns {Promise<null | { ok: false, errorCode: string, error: string, root: string }>}
 */
async function searchRootProblem(absRoot, searchPath) {
  let rootStat = null;
  try {
    rootStat = await fsp.stat(absRoot);
  } catch {
    rootStat = null;
  }
  if (!rootStat || !rootStat.isDirectory()) {
    return {
      ok: false,
      errorCode: 'SEARCH_ROOT_UNREADABLE',
      error:
        `搜索根不存在或不是目录：${absRoot}。这不是「没有匹配」，而是一个文件都没搜到 —— ` +
        '确认这个路径在本机真的存在；远端会话的路径必须带 ssh:// 工作区作用域，' +
        '否则会被拼成本机盘符下的同名路径。',
      root: absRoot
    };
  }
  if (searchPath && searchPath !== absRoot) {
    let targetStat = null;
    try {
      targetStat = await fsp.stat(searchPath);
    } catch {
      targetStat = null;
    }
    if (!targetStat) {
      return {
        ok: false,
        errorCode: 'SEARCH_ROOT_UNREADABLE',
        error: `搜索范围不存在：${searchPath}（工作区 ${absRoot} 下）。这不是「没有匹配」。`,
        root: searchPath
      };
    }
  }
  return null;
}

async function grepWorkspace(root, opts = {}) {
  const absRoot = path.resolve(root);
  const pattern = String(opts.pattern || '');
  if (!pattern) {
    return { ok: false, errorCode: 'MISSING_PATTERN', error: 'pattern 必填' };
  }
  const limit = clampLimit(opts.maxResults, DEFAULT_GREP_LIMIT, MAX_GREP_LIMIT);
  const ctx = resolveGrepContext(opts);
  const countOnly = opts.count === true;
  const multiline = opts.multiline === true;
  const typeFilter = String(opts.type || '').trim();
  const searchPath = opts.path ? path.resolve(absRoot, String(opts.path)) : absRoot;
  const rootKey = absRoot.toLowerCase();
  const searchKey = searchPath.toLowerCase();
  if (searchKey !== rootKey && !searchKey.startsWith(rootKey + path.sep.toLowerCase())) {
    return { ok: false, errorCode: 'PATH_OUTSIDE', error: 'path 必须在工作空间内' };
  }
  // 「根不对」必须在两条搜索通道之前拦住：它们都会把「读不到」折成「0 命中」。
  const rootProblem = await searchRootProblem(absRoot, searchPath);
  if (rootProblem) return rootProblem;

  // 命中判定 + 类型/跨行过滤，两种模式共用
  const common = [];
  if (!opts.regex) common.push('-F');
  if (opts.caseInsensitive) common.push('-i');
  if (opts.glob) common.push('-g', String(opts.glob));
  if (typeFilter) common.push('-t', typeFilter);
  if (multiline) common.push('-U', '--multiline-dotall');

  if (countOnly) {
    // 计数模式用 --count-matches（输出 path:count），不受 maxResults 截断影响
    const cargs = [
      '--count-matches',
      '--no-config',
      '--max-filesize',
      '1M',
      '--glob',
      '!node_modules/**',
      '--glob',
      '!.git/**',
      '--glob',
      '!dist/**',
      '--glob',
      '!target/**',
      ...common,
      '--',
      pattern,
      searchPath
    ];
    const rgCount = await spawnRg(cargs, absRoot, opts.timeoutMs);
    if (rgCount.ok && !rgCount.missing) {
      let total = 0;
      for (const line of String(rgCount.stdout || '').split(/\r?\n/)) {
        const m = line.trim().match(/:(\d+)$/);
        if (m) total += Number(m[1]) || 0;
      }
      return withOversizeHint(
        {
          ok: true,
          matches: [],
          count: total,
          truncated: false,
          source: 'rg',
          countOnly: true
        },
        absRoot,
        searchPath
      );
    }
    return withOversizeHint(
      await grepJsFallback(absRoot, { ...opts, maxResults: limit }),
      absRoot,
      searchPath
    );
  }

  const args = [
    '--json',
    '--no-config',
    '--max-filesize',
    '1M',
    '--glob',
    '!node_modules/**',
    '--glob',
    '!.git/**',
    '--glob',
    '!dist/**',
    '--glob',
    '!target/**',
    ...common
  ];
  if (ctx.before > 0) args.push('-B', String(ctx.before));
  if (ctx.after > 0) args.push('-A', String(ctx.after));
  args.push('--', pattern, searchPath);
  const rg = await spawnRg(args, absRoot, opts.timeoutMs);
  if (rg.ok && !rg.missing && (rg.code <= 1 || String(rg.stdout || '').trim())) {
    const matches = parseRgJsonMatches(rg.stdout, absRoot, limit, ctx);
    return withOversizeHint(
      {
        ok: true,
        matches,
        truncated: matches.length >= limit,
        source: 'rg',
        context: ctx
      },
      absRoot,
      searchPath
    );
  }
  return withOversizeHint(
    await grepJsFallback(absRoot, { ...opts, maxResults: limit }),
    absRoot,
    searchPath
  );
}

async function globWorkspace(root, opts = {}) {
  const absRoot = path.resolve(root);
  const pattern = String(opts.pattern || '').trim();
  if (!pattern) {
    return { ok: false, errorCode: 'MISSING_PATTERN', error: 'pattern 必填' };
  }
  const limit = clampLimit(opts.maxResults, DEFAULT_GLOB_LIMIT, MAX_GLOB_LIMIT);
  const rootProblem = await searchRootProblem(absRoot);
  if (rootProblem) return rootProblem;
  const args = [
    '--files',
    '--no-config',
    '--glob',
    '!node_modules/**',
    '--glob',
    '!.git/**',
    '--glob',
    '!dist/**',
    '--glob',
    '!target/**',
    '-g',
    pattern
  ];
  const rg = await spawnRg(args, absRoot, opts.timeoutMs);
  if (rg.ok && !rg.missing && (rg.code <= 1 || String(rg.stdout || '').trim())) {
    const files = parseRgFiles(rg.stdout, absRoot, limit);
    return { ok: true, files, truncated: files.length >= limit, source: 'rg' };
  }
  const walk = await walkFiles(absRoot, pattern, limit, MAX_WALK_FILES, true);
  return { ok: true, files: walk.files.slice(0, limit), truncated: walk.truncated, source: 'js' };
}

module.exports = {
  grepWorkspace,
  globWorkspace,
  walkFiles,
  probeOversizeFiles,
  TYPE_EXT,
  MAX_FILE_BYTES
};

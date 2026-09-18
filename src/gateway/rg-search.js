'use strict';

const fsp = require('fs/promises');
const path = require('path');
const { spawn } = require('child_process');

const IGNORE_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'out',
  '.dieyun',
  'coverage',
  '__pycache__',
  '.venv',
  'venv',
  '.next',
  '.nuxt',
  'target',
  'vendor',
  'win-unpacked'
]);

const IGNORE_EXT = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.ico',
  '.bmp',
  '.zip',
  '.7z',
  '.rar',
  '.gz',
  '.exe',
  '.dll',
  '.so',
  '.wasm',
  '.pdf',
  '.woff',
  '.woff2',
  '.ttf',
  '.mp4',
  '.mp3',
  '.sqlite',
  '.db',
  '.pyc',
  '.class',
  '.jar'
]);

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
  return IGNORE_DIRS.has(String(name || '')) || String(name || '').startsWith('.');
}

function shouldSkipFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return IGNORE_EXT.has(ext);
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
    if (buf.includes(0)) return null;
    text = buf.toString('utf8');
  } catch {
    return null;
  }

  const entries = [];
  let total = 0;

  if (opts.multiline) {
    // 跨行匹配：整文件跑正则，再把字符下标换算成行号
    const starts = buildLineStarts(text);
    const re = new RegExp(
      needle.source,
      needle.flags.includes('g') ? needle.flags : `${needle.flags}g`
    );
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
      return {
        ok: true,
        matches: [],
        count: total,
        truncated: false,
        source: 'rg',
        countOnly: true
      };
    }
    return grepJsFallback(absRoot, { ...opts, maxResults: limit });
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
    return {
      ok: true,
      matches,
      truncated: matches.length >= limit,
      source: 'rg',
      context: ctx
    };
  }
  return grepJsFallback(absRoot, { ...opts, maxResults: limit });
}

async function globWorkspace(root, opts = {}) {
  const absRoot = path.resolve(root);
  const pattern = String(opts.pattern || '').trim();
  if (!pattern) {
    return { ok: false, errorCode: 'MISSING_PATTERN', error: 'pattern 必填' };
  }
  const limit = clampLimit(opts.maxResults, DEFAULT_GLOB_LIMIT, MAX_GLOB_LIMIT);
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
  globToRegExp,
  matchGlob,
  grepWorkspace,
  globWorkspace,
  walkFiles,
  parseGitignoreLines,
  isGitIgnored,
  TYPE_EXT,
  DEFAULT_GREP_LIMIT,
  DEFAULT_GLOB_LIMIT,
  MAX_GREP_LIMIT,
  MAX_GLOB_LIMIT,
  MAX_GREP_CONTEXT
};

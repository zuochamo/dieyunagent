'use strict';

const path = require('path');
const fsSync = require('fs');
const { spawn } = require('child_process');
const { resolveTsServerPath } = require('./language-registry');
const { filterByMinSeverity, severityRank } = require('./lsp-client');

const DEFAULT_TIMEOUT_MS = 30000;

function resolveSpawn(command, args, cwd) {
  if (process.platform === 'win32' && command === 'npx') {
    const cmdLine = ['npx', ...args].join(' ');
    return {
      command: 'cmd.exe',
      args: ['/d', '/s', '/c', cmdLine],
      cwd
    };
  }
  return { command, args, cwd };
}

function childEnvForCommand(command) {
  if (command !== process.execPath) return process.env;
  return { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
}

function runProcess(command, args, opts = {}) {
  const cwd = opts.cwd || process.cwd();
  const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
  const spec = command === 'npx' ? resolveSpawn(command, args, cwd) : { command, args, cwd };

  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    const proc = spawn(spec.command, spec.args, {
      cwd: spec.cwd,
      env: childEnvForCommand(spec.command),
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const timer = setTimeout(() => {
      try {
        proc.kill();
      } catch {
        // ignore
      }
      reject(new Error('CLI 诊断超时'));
    }, timeoutMs);
    proc.stdout.on('data', (c) => {
      stdout += c.toString('utf8');
    });
    proc.stderr.on('data', (c) => {
      stderr += c.toString('utf8');
    });
    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code != null ? code : 1, stdout, stderr });
    });
  });
}

function normalizePathKey(p) {
  return path.resolve(String(p || '')).toLowerCase();
}

function pathsMatch(a, b, projectRoot) {
  const A = normalizePathKey(a);
  const B = normalizePathKey(b);
  if (A === B) return true;
  const baseA = path.basename(A);
  const baseB = path.basename(B);
  if (baseA && baseA === baseB) return true;
  if (projectRoot) {
    const rel = normalizePathKey(path.relative(path.resolve(projectRoot), path.resolve(b)));
    if (A === rel) return true;
    if (A.endsWith(`/${rel}`)) return true;
  }
  return false;
}

function limitDiags(diags, minSeverity, maxPerFile) {
  let out = filterByMinSeverity(diags, minSeverity || 'warning');
  out.sort((a, b) => {
    const sr = severityRank(a.severity) - severityRank(b.severity);
    if (sr !== 0) return sr;
    return a.line - b.line || a.col - b.col;
  });
  const max = maxPerFile != null ? Number(maxPerFile) : 20;
  if (max > 0 && out.length > max) out = out.slice(0, max);
  return out;
}

/** @param {number} maxFiles 0 或未设 = 不限制文件数 */
function applyFileCap(items, maxFiles) {
  const max = maxFiles != null ? Number(maxFiles) : 0;
  if (!max || max <= 0) return items;
  return items.slice(0, max);
}

function parseTscOutput(text) {
  const diags = [];
  const raw = String(text || '');
  const patterns = [
    /^(.+?)\((\d+),(\d+)\):\s+(error|warning)\s+TS(\d+):\s+(.*)$/gm,
    /^(.+?):(\d+):(\d+)\s+-\s+(error|warning)\s+TS(\d+):\s+(.*)$/gm
  ];
  for (const re of patterns) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(raw))) {
      diags.push({
        severity: m[4] === 'warning' ? 'warning' : 'error',
        line: Number(m[2]) || 1,
        col: Number(m[3]) || 1,
        message: String(m[6] || '').trim(),
        code: `TS${m[5]}`,
        source: 'typescript',
        file: path.normalize(m[1])
      });
    }
  }
  return diags;
}

function parsePyrightTextOutput(text) {
  const diags = [];
  const re = /^(.+?):(\d+):(\d+)\s+-\s+(error|warning|information):\s+(.*?)(?:\s+\(([^)]+)\))?$/gm;
  let m;
  while ((m = re.exec(String(text || '')))) {
    const sev = m[4] === 'warning' ? 'warning' : m[4] === 'information' ? 'info' : 'error';
    diags.push({
      severity: sev,
      line: Number(m[2]) || 1,
      col: Number(m[3]) || 1,
      message: String(m[5] || '').trim(),
      code: m[6] ? String(m[6]) : '',
      source: 'pyright',
      file: path.normalize(m[1])
    });
  }
  return diags;
}

function parseEslintJsonOutput(text) {
  try {
    const rows = JSON.parse(String(text || ''));
    if (!Array.isArray(rows)) return [];
    const diags = [];
    for (const row of rows) {
      const filePath = row.filePath ? path.normalize(String(row.filePath)) : '';
      for (const msg of row.messages || []) {
        const severity =
          msg.severity === 2 ? 'error' : msg.severity === 1 ? 'warning' : 'info';
        diags.push({
          severity,
          line: Number(msg.line) || 1,
          col: Number(msg.column) || 1,
          message: String(msg.message || '').trim(),
          code: msg.ruleId ? String(msg.ruleId) : '',
          source: 'eslint',
          file: filePath
        });
      }
    }
    return diags;
  } catch {
    return [];
  }
}

function resolveEslintCommand(projectRoot) {
  try {
    const eslintJs = require.resolve('eslint/bin/eslint.js', { paths: [projectRoot] });
    return { command: process.execPath, args: [eslintJs] };
  } catch {
    return { command: 'npx', args: ['-y', 'eslint'] };
  }
}

function groupEslintByFile(rows, projectRoot, workspaceRoot, minSeverity, maxPerFile, maxFiles) {
  const byFile = new Map();
  for (const d of rows) {
    if (!d.file) continue;
    let abs = path.isAbsolute(d.file)
      ? path.normalize(d.file)
      : path.normalize(path.join(projectRoot, d.file));
    if (!isUnderWorkspace(abs, workspaceRoot)) continue;
    const key = abs.toLowerCase();
    if (!byFile.has(key)) byFile.set(key, { file: abs, diagnostics: [] });
    const { file, ...rest } = d;
    byFile.get(key).diagnostics.push(rest);
  }

  const items = [];
  for (const entry of byFile.values()) {
    entry.diagnostics = limitDiags(entry.diagnostics, minSeverity, maxPerFile);
    if (entry.diagnostics.length) items.push(entry);
  }

  items.sort((a, b) => {
    const ae = a.diagnostics.some((x) => x.severity === 'error') ? 0 : 1;
    const be = b.diagnostics.some((x) => x.severity === 'error') ? 0 : 1;
    if (ae !== be) return ae - be;
    return String(a.file).localeCompare(String(b.file));
  });

  return {
    items: applyFileCap(items, maxFiles),
    rawCount: rows.length
  };
}

function parsePyrightJsonOutput(text) {
  try {
    const data = JSON.parse(String(text || ''));
    const rows = data.generalDiagnostics || data.diagnostics || [];
    return rows.map((d) => {
      const sev =
        d.severity === 'warning' ? 'warning' : d.severity === 'information' ? 'info' : 'error';
      const range = d.range || {};
      const start = range.start || {};
      return {
        severity: sev,
        line: Number(start.line != null ? start.line : 0) + 1,
        col: Number(start.character != null ? start.character : 0) + 1,
        message: String(d.message || '').trim(),
        code: d.rule ? String(d.rule) : '',
        source: 'pyright',
        file: d.file ? path.normalize(d.file) : ''
      };
    });
  } catch {
    return [];
  }
}

function resolveTscJs(fromDir) {
  // Use lib/tsc.js — typescript/bin/tsc has no extension; Electron treats it as a
  // new main-process entry and throws ERR_UNKNOWN_FILE_EXTENSION.
  return require.resolve('typescript/lib/tsc.js', { paths: [fromDir] });
}

function resolveTscCommand(projectRoot) {
  try {
    return { command: process.execPath, args: [resolveTscJs(projectRoot)] };
  } catch {
    const tsServer = resolveTsServerPath(projectRoot);
    if (tsServer) {
      try {
        return {
          command: process.execPath,
          args: [resolveTscJs(path.dirname(tsServer))]
        };
      } catch {
        // fall through
      }
    }
  }
  return { command: 'npx', args: ['-y', 'typescript', '--noEmit', '--pretty', 'false'] };
}

async function runTscFallback(opts) {
  const projectRoot = path.resolve(opts.projectRoot);
  const absPath = path.resolve(opts.absPath);
  const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
  const base = resolveTscCommand(projectRoot);
  const args =
    base.command === 'npx'
      ? base.args
      : [...base.args, '--noEmit', '--pretty', 'false'];

  const result = await runProcess(base.command, args, { cwd: projectRoot, timeoutMs });
  const combined = `${result.stdout}\n${result.stderr}`;
  const all = parseTscOutput(combined);
  const matched = all.filter((d) => d.file && pathsMatch(d.file, absPath, projectRoot));
  return limitDiags(
    matched.map(({ file, ...rest }) => rest),
    opts.minSeverity,
    opts.maxPerFile
  );
}

async function runPyrightFallback(opts) {
  const projectRoot = path.resolve(opts.projectRoot);
  const absPath = path.resolve(opts.absPath);
  const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
  const rel = path.relative(projectRoot, absPath) || path.basename(absPath);

  let result;
  try {
    result = await runProcess('npx', ['-y', 'pyright', '--outputjson', rel], {
      cwd: projectRoot,
      timeoutMs
    });
    const jsonDiags = parsePyrightJsonOutput(result.stdout);
    if (jsonDiags.length) {
      const matched = jsonDiags.filter((d) => !d.file || pathsMatch(d.file, absPath, projectRoot));
      return limitDiags(
        matched.map(({ file, ...rest }) => rest),
        opts.minSeverity,
        opts.maxPerFile
      );
    }
  } catch {
    // try text output
  }

  result = await runProcess('npx', ['-y', 'pyright', rel], { cwd: projectRoot, timeoutMs });
  const all = parsePyrightTextOutput(`${result.stdout}\n${result.stderr}`);
  const matched = all.filter((d) => d.file && pathsMatch(d.file, absPath, projectRoot));
  return limitDiags(
    matched.map(({ file, ...rest }) => rest),
    opts.minSeverity,
    opts.maxPerFile
  );
}

/**
 * cargo check / go vet 的成本远高于 tsc：一次是全项目语义检查而非单文件。
 * 因此给更长超时，并按 projectRoot 做短期结果复用，避免「保存一个文件就重跑一次」。
 */
const CARGO_DEFAULT_TIMEOUT_MS = 120000;
const GO_DEFAULT_TIMEOUT_MS = 60000;
const HEAVY_FALLBACK_CACHE_MS = 45000;
/** @type {Map<string, { at: number, diagnostics: object[] }>} */
const heavyFallbackCache = new Map();

/** 从 startDir 向上找含 marker 的目录（monorepo 里 workspaceRoot 未必是 crate/module 根） */
function findProjectMarkerRoot(startDir, marker) {
  let dir = path.resolve(String(startDir || '.'));
  for (let i = 0; i < 12; i++) {
    try {
      if (fsSync.existsSync(path.join(dir, marker))) return dir;
    } catch {
      /* 忽略权限等问题，继续向上 */
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function heavyCacheGet(key) {
  const hit = heavyFallbackCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > HEAVY_FALLBACK_CACHE_MS) {
    heavyFallbackCache.delete(key);
    return null;
  }
  return hit.diagnostics;
}

/** cargo --message-format=json 是 NDJSON；只取 error/warning 的 primary span */
function parseCargoJsonMessages(text) {
  const out = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line[0] !== '{') continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (!obj || obj.reason !== 'compiler-message' || !obj.message) continue;
    const msg = obj.message;
    const level = String(msg.level || '');
    if (level !== 'error' && level !== 'warning') continue;
    const spans = Array.isArray(msg.spans) ? msg.spans : [];
    const span =
      spans.find((s) => s && s.is_primary && s.file_name) || spans.find((s) => s && s.file_name);
    if (!span) continue;
    out.push({
      file: String(span.file_name),
      severity: level === 'error' ? 'error' : 'warning',
      line: Number(span.line_start) || 1,
      col: Number(span.column_start) || 1,
      message: String(msg.message || '').trim().slice(0, 400),
      code: msg.code && msg.code.code ? String(msg.code.code) : '',
      source: 'cargo'
    });
  }
  return out;
}

async function runCargoCheckFallback(opts) {
  const projectRoot = path.resolve(opts.projectRoot);
  const absPath = path.resolve(opts.absPath);
  const timeoutMs =
    opts.timeoutMs && opts.timeoutMs > DEFAULT_TIMEOUT_MS ? opts.timeoutMs : CARGO_DEFAULT_TIMEOUT_MS;
  // cargo 必须在 crate 根跑；cargo 输出的路径也相对该目录
  const cargoRoot = findProjectMarkerRoot(projectRoot, 'Cargo.toml') || projectRoot;
  const cacheKey = `cargo:${cargoRoot}`;
  let all = heavyCacheGet(cacheKey);
  if (!all) {
    const result = await runProcess('cargo', ['check', '--message-format=json', '--quiet'], {
      cwd: cargoRoot,
      timeoutMs
    });
    all = parseCargoJsonMessages(`${result.stdout}\n${result.stderr}`);
    heavyFallbackCache.set(cacheKey, { at: Date.now(), diagnostics: all });
  }
  const matched = all.filter((d) => pathsMatch(d.file, absPath, cargoRoot));
  return limitDiags(
    matched.map(({ file, ...rest }) => rest),
    opts.minSeverity,
    opts.maxPerFile
  );
}

/** go vet 文本输出：./path/file.go:12:5: message */
function parseGoVetOutput(text) {
  const out = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^(.+?\.go):(\d+):(\d+):\s*(.+)$/);
    if (!m) continue;
    out.push({
      file: m[1],
      // go vet 报的是静态检查问题，不作为编译错误
      severity: 'warning',
      line: Number(m[2]) || 1,
      col: Number(m[3]) || 1,
      message: m[4].trim().slice(0, 400),
      code: '',
      source: 'go vet'
    });
  }
  return out;
}

async function runGoVetFallback(opts) {
  const projectRoot = path.resolve(opts.projectRoot);
  const absPath = path.resolve(opts.absPath);
  const timeoutMs =
    opts.timeoutMs && opts.timeoutMs > DEFAULT_TIMEOUT_MS ? opts.timeoutMs : GO_DEFAULT_TIMEOUT_MS;
  const goRoot = findProjectMarkerRoot(projectRoot, 'go.mod') || projectRoot;
  const cacheKey = `govet:${goRoot}`;
  let all = heavyCacheGet(cacheKey);
  if (!all) {
    const result = await runProcess('go', ['vet', './...'], { cwd: goRoot, timeoutMs });
    all = parseGoVetOutput(`${result.stdout}\n${result.stderr}`);
    heavyFallbackCache.set(cacheKey, { at: Date.now(), diagnostics: all });
  }
  const matched = all.filter((d) => pathsMatch(d.file, absPath, goRoot));
  return limitDiags(
    matched.map(({ file, ...rest }) => rest),
    opts.minSeverity,
    opts.maxPerFile
  );
}

function isUnderWorkspace(absPath, workspaceRoot) {
  const abs = String(absPath || '').replace(/\\/g, '/');
  const root = String(workspaceRoot || '').replace(/\\/g, '/').replace(/\/$/, '');
  if (root.startsWith('/') || abs.startsWith('/')) {
    return abs === root || abs.startsWith(`${root}/`);
  }
  const resolvedRoot = path.resolve(workspaceRoot);
  const resolvedAbs = path.resolve(absPath);
  const rel = path.relative(resolvedRoot, resolvedAbs);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

const PRETTIER_NOISE_LINE_RE =
  /^(npm|npx|node)\s|command not found|cannot find module|ENOENT|checking formatting|code style issues found|warn\s+deprecated|npm warn/i;
const PRETTIER_SHELL_ERR_RE =
  /没有那个文件|no such file or directory|not found|permission denied|is a directory|不是内部或外部命令/i;

function looksLikePrettierListedPath(raw) {
  let line = String(raw || '').trim();
  if (!line || line.length > 480) return false;
  if (PRETTIER_NOISE_LINE_RE.test(line)) return false;
  if (PRETTIER_SHELL_ERR_RE.test(line)) return false;
  if (/^[\w.-]+:\s*[\u4e00-\u9fff]/.test(line)) return false;
  if (/^[\w.-]+:\s*(no such file|not found|command not found)/i.test(line)) return false;

  line = line.replace(/^\[warn\]\s+/i, '').trim();
  if (!line || PRETTIER_NOISE_LINE_RE.test(line) || PRETTIER_SHELL_ERR_RE.test(line)) return false;

  if (line.startsWith('/')) return !/[\u0000-\u001f]/.test(line);
  if (/^[A-Za-z]:[\\/]/.test(line)) return true;
  if (line.includes('/')) return !/[\u0000-\u001f]/.test(line);
  return /\.[A-Za-z0-9]{1,12}$/.test(line);
}

function isPlausibleDiagnosticFilePath(filePath, workspaceRoot) {
  const f = String(filePath || '').replace(/\\/g, '/');
  if (!f || f.length > 520) return false;
  if (PRETTIER_SHELL_ERR_RE.test(f)) return false;
  if (/^[\w.-]+:\s*[\u4e00-\u9fff]/.test(f)) return false;
  if (/^[\w.-]+:\s*(no such file|not found|command not found)/i.test(f)) return false;
  if (f.includes(':') && !/^[A-Za-z]:\//.test(f) && !f.startsWith('/')) return false;
  const root = String(workspaceRoot || '')
    .replace(/\\/g, '/')
    .replace(/\/$/, '');
  if (root.startsWith('/') && !f.startsWith('/')) return false;
  return looksLikePrettierListedPath(f) || f.startsWith('/') || /^[A-Za-z]:\//.test(f);
}

function joinRemotePath(projectRoot, relOrAbs) {
  const root = String(projectRoot || '').replace(/\\/g, '/').replace(/\/$/, '');
  const raw = String(relOrAbs || '').trim().replace(/\\/g, '/');
  if (!raw) return '';
  if (raw.startsWith('/')) return raw.replace(/\/+$/, '') || raw;
  if (/^[A-Za-z]:\//.test(raw)) return raw;
  return `${root}/${raw.replace(/^\.\//, '')}`;
}

function remotePrettierOutputHasFormatIssue(combined, relPath) {
  const text = String(combined || '');
  const rel = String(relPath || '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\//, '');
  if (!rel) return false;
  const base = rel.split('/').pop() || rel;
  const patterns = [
    new RegExp(`\\[warn\\]\\s+${rel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i'),
    new RegExp(`\\[warn\\]\\s+${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i')
  ];
  if (patterns.some((re) => re.test(text))) return true;
  if (/code style issues found/i.test(text)) {
    const baseRe = new RegExp(base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    return baseRe.test(text);
  }
  return false;
}

/**
 * 工作区级 tsc --noEmit（一次编译，按文件分组写入 Diagnostic Store）。
 */
async function runTscProjectScan(opts) {
  const projectRoot = path.resolve(String(opts.projectRoot || ''));
  const workspaceRoot = path.resolve(String(opts.workspaceRoot || projectRoot));
  const timeoutMs = opts.timeoutMs || 120000;
  const maxFiles = opts.maxFiles != null ? Number(opts.maxFiles) : 0;
  const maxPerFile = opts.maxPerFile != null ? Number(opts.maxPerFile) : 8;
  const minSeverity = opts.minSeverity || 'warning';

  const base = resolveTscCommand(projectRoot);
  const args =
    base.command === 'npx'
      ? base.args
      : [...base.args, '--noEmit', '--pretty', 'false'];

  const result = await runProcess(base.command, args, { cwd: projectRoot, timeoutMs });
  const all = parseTscOutput(`${result.stdout}\n${result.stderr}`);
  const byFile = new Map();

  for (const d of all) {
    if (!d.file) continue;
    let abs = path.isAbsolute(d.file)
      ? path.normalize(d.file)
      : path.normalize(path.join(projectRoot, d.file));
    if (!isUnderWorkspace(abs, workspaceRoot)) continue;
    const key = abs.toLowerCase();
    if (!byFile.has(key)) byFile.set(key, { file: abs, diagnostics: [] });
    const { file, ...rest } = d;
    byFile.get(key).diagnostics.push(rest);
  }

  const items = [];
  for (const entry of byFile.values()) {
    entry.diagnostics = limitDiags(entry.diagnostics, minSeverity, maxPerFile);
    if (entry.diagnostics.length) items.push(entry);
  }

  items.sort((a, b) => {
    const ae = a.diagnostics.some((x) => x.severity === 'error') ? 0 : 1;
    const be = b.diagnostics.some((x) => x.severity === 'error') ? 0 : 1;
    if (ae !== be) return ae - be;
    return String(a.file).localeCompare(String(b.file));
  });

  return {
    ok: true,
    engine: 'tsc',
    projectRoot,
    items: applyFileCap(items, maxFiles),
    rawCount: all.length
  };
}

/**
 * 工作区级 pyright --outputjson。
 */
async function runPyrightProjectScan(opts) {
  const projectRoot = path.resolve(String(opts.projectRoot || ''));
  const workspaceRoot = path.resolve(String(opts.workspaceRoot || projectRoot));
  const timeoutMs = opts.timeoutMs || 120000;
  const maxFiles = opts.maxFiles != null ? Number(opts.maxFiles) : 0;
  const maxPerFile = opts.maxPerFile != null ? Number(opts.maxPerFile) : 8;
  const minSeverity = opts.minSeverity || 'warning';

  const result = await runProcess('npx', ['-y', 'pyright', '--outputjson', projectRoot], {
    cwd: projectRoot,
    timeoutMs
  });
  const rows = parsePyrightJsonOutput(result.stdout);
  const byFile = new Map();

  for (const d of rows) {
    if (!d.file) continue;
    let abs = path.isAbsolute(d.file)
      ? path.normalize(d.file)
      : path.normalize(path.join(projectRoot, d.file));
    if (!isUnderWorkspace(abs, workspaceRoot)) continue;
    const key = abs.toLowerCase();
    if (!byFile.has(key)) byFile.set(key, { file: abs, diagnostics: [] });
    const { file, ...rest } = d;
    byFile.get(key).diagnostics.push(rest);
  }

  const items = [];
  for (const entry of byFile.values()) {
    entry.diagnostics = limitDiags(entry.diagnostics, minSeverity, maxPerFile);
    if (entry.diagnostics.length) items.push(entry);
  }

  items.sort((a, b) => {
    const ae = a.diagnostics.some((x) => x.severity === 'error') ? 0 : 1;
    const be = b.diagnostics.some((x) => x.severity === 'error') ? 0 : 1;
    if (ae !== be) return ae - be;
    return String(a.file).localeCompare(String(b.file));
  });

  return {
    ok: true,
    engine: 'pyright',
    projectRoot,
    items: applyFileCap(items, maxFiles),
    rawCount: rows.length
  };
}

/**
 * 工作区级 eslint --format json。
 */
async function runEslintProjectScan(opts) {
  const projectRoot = path.resolve(String(opts.projectRoot || ''));
  const workspaceRoot = path.resolve(String(opts.workspaceRoot || projectRoot));
  const timeoutMs = opts.timeoutMs || 120000;
  const maxFiles = opts.maxFiles != null ? Number(opts.maxFiles) : 0;
  const maxPerFile = opts.maxPerFile != null ? Number(opts.maxPerFile) : 12;
  const minSeverity = opts.minSeverity || 'warning';

  const base = resolveEslintCommand(projectRoot);
  const args = [...base.args, '.', '--format', 'json', '--no-error-on-unmatched-pattern'];

  let result;
  try {
    result = await runProcess(base.command, args, { cwd: projectRoot, timeoutMs });
  } catch (err) {
    return { ok: false, engine: 'eslint', projectRoot, error: err.message || String(err), items: [], rawCount: 0 };
  }

  const rows = parseEslintJsonOutput(result.stdout || result.stderr);
  const grouped = groupEslintByFile(rows, projectRoot, workspaceRoot, minSeverity, maxPerFile, maxFiles);

  return {
    ok: true,
    engine: 'eslint',
    projectRoot,
    items: grouped.items,
    rawCount: grouped.rawCount
  };
}

/**
 * 单文件 eslint --format json（watch / 按需刷新）。
 */
async function runEslintFileScan(opts) {
  const projectRoot = path.resolve(String(opts.projectRoot || ''));
  const absPath = path.resolve(String(opts.absPath || ''));
  const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
  const rel = path.relative(projectRoot, absPath) || path.basename(absPath);
  const base = resolveEslintCommand(projectRoot);
  const args = [...base.args, rel, '--format', 'json', '--no-error-on-unmatched-pattern'];

  let result;
  try {
    result = await runProcess(base.command, args, { cwd: projectRoot, timeoutMs });
  } catch {
    return [];
  }

  const rows = parseEslintJsonOutput(result.stdout || result.stderr);
  const matched = rows.filter((d) => d.file && pathsMatch(d.file, absPath, projectRoot));
  return limitDiags(
    matched.map(({ file, ...rest }) => rest),
    opts.minSeverity,
    opts.maxPerFile
  );
}

function parseRuffJsonOutput(text) {
  try {
    const rows = JSON.parse(String(text || ''));
    if (!Array.isArray(rows)) return [];
    return rows.map((row) => ({
      severity: 'error',
      line: Number(row.location && row.location.row != null ? row.location.row : 1),
      col: Number(row.location && row.location.column != null ? row.location.column : 1),
      message: String(row.message || '').trim(),
      code: row.code ? String(row.code) : '',
      source: 'ruff',
      file: row.filename ? path.normalize(String(row.filename)) : ''
    }));
  } catch {
    return [];
  }
}

function resolveRuffCommand(projectRoot) {
  try {
    const ruffBin = require.resolve('ruff/bin/ruff', { paths: [projectRoot] });
    return { command: ruffBin, args: [] };
  } catch {
    return { command: 'npx', args: ['-y', 'ruff'] };
  }
}

function groupRuffByFile(rows, projectRoot, workspaceRoot, minSeverity, maxPerFile, maxFiles) {
  const byFile = new Map();
  for (const d of rows) {
    if (!d.file) continue;
    let abs = path.isAbsolute(d.file)
      ? path.normalize(d.file)
      : path.normalize(path.join(projectRoot, d.file));
    if (!isUnderWorkspace(abs, workspaceRoot)) continue;
    const key = abs.toLowerCase();
    if (!byFile.has(key)) byFile.set(key, { file: abs, diagnostics: [] });
    const { file, ...rest } = d;
    byFile.get(key).diagnostics.push(rest);
  }
  const items = [];
  for (const entry of byFile.values()) {
    entry.diagnostics = limitDiags(entry.diagnostics, minSeverity, maxPerFile);
    if (entry.diagnostics.length) items.push(entry);
  }
  items.sort((a, b) => String(a.file).localeCompare(String(b.file)));
  return { items: applyFileCap(items, maxFiles), rawCount: rows.length };
}

async function runRuffProjectScan(opts) {
  const projectRoot = path.resolve(String(opts.projectRoot || ''));
  const workspaceRoot = path.resolve(String(opts.workspaceRoot || projectRoot));
  const timeoutMs = opts.timeoutMs || 120000;
  const maxFiles = opts.maxFiles != null ? Number(opts.maxFiles) : 0;
  const maxPerFile = opts.maxPerFile != null ? Number(opts.maxPerFile) : 12;
  const minSeverity = opts.minSeverity || 'warning';

  const base = resolveRuffCommand(projectRoot);
  const args = [...base.args, 'check', '.', '--output-format', 'json'];

  let result;
  try {
    result = await runProcess(base.command, args, { cwd: projectRoot, timeoutMs });
  } catch (err) {
    return { ok: false, engine: 'ruff', projectRoot, error: err.message || String(err), items: [], rawCount: 0 };
  }

  const rows = parseRuffJsonOutput(result.stdout || result.stderr);
  const grouped = groupRuffByFile(rows, projectRoot, workspaceRoot, minSeverity, maxPerFile, maxFiles);
  return {
    ok: true,
    engine: 'ruff',
    projectRoot,
    items: grouped.items,
    rawCount: grouped.rawCount
  };
}

async function runRuffFileScan(opts) {
  const projectRoot = path.resolve(String(opts.projectRoot || ''));
  const absPath = path.resolve(String(opts.absPath || ''));
  const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
  const rel = path.relative(projectRoot, absPath) || path.basename(absPath);
  const base = resolveRuffCommand(projectRoot);
  const args = [...base.args, 'check', rel, '--output-format', 'json'];

  let result;
  try {
    result = await runProcess(base.command, args, { cwd: projectRoot, timeoutMs });
  } catch {
    return [];
  }

  const rows = parseRuffJsonOutput(result.stdout || result.stderr);
  const matched = rows.filter((d) => d.file && pathsMatch(d.file, absPath, projectRoot));
  return limitDiags(
    matched.map(({ file, ...rest }) => rest),
    opts.minSeverity,
    opts.maxPerFile
  );
}

function parsePrettierListOutput(text, projectRoot, workspaceRoot) {
  const diags = [];
  const root = String(projectRoot || '').replace(/\\/g, '/').replace(/\/$/, '');
  const wsRoot = String(workspaceRoot || projectRoot || '')
    .replace(/\\/g, '/')
    .replace(/\/$/, '');
  for (const line of String(text || '').split(/\r?\n/)) {
    const raw = line.trim();
    if (!raw || !looksLikePrettierListedPath(raw)) continue;
    let rel = raw.replace(/^\[warn\]\s+/i, '').trim();
    if (!looksLikePrettierListedPath(rel)) continue;
    const abs = joinRemotePath(root, rel);
    if (!abs || !isUnderWorkspace(abs, wsRoot)) continue;
    diags.push({
      file: abs,
      severity: 'warning',
      line: 1,
      col: 1,
      message: 'File is not formatted according to Prettier',
      code: 'prettier/format',
      source: 'prettier'
    });
  }
  return diags;
}

function resolvePrettierCommand(projectRoot) {
  try {
    const prettierBin = require.resolve('prettier/bin/prettier.cjs', { paths: [projectRoot] });
    return { command: process.execPath, args: [prettierBin] };
  } catch {
    try {
      const prettierBin = require.resolve('prettier/bin-prettier.js', { paths: [projectRoot] });
      return { command: process.execPath, args: [prettierBin] };
    } catch {
      return { command: 'npx', args: ['-y', 'prettier'] };
    }
  }
}

function groupPrettierByFile(rows, minSeverity, maxPerFile, maxFiles) {
  const byFile = new Map();
  for (const d of rows) {
    if (!d.file) continue;
    const key = d.file.toLowerCase();
    if (!byFile.has(key)) byFile.set(key, { file: d.file, diagnostics: [] });
    const { file, ...rest } = d;
    byFile.get(key).diagnostics.push(rest);
  }
  const items = [];
  for (const entry of byFile.values()) {
    entry.diagnostics = limitDiags(entry.diagnostics, minSeverity, maxPerFile);
    if (entry.diagnostics.length) items.push(entry);
  }
  return { items: applyFileCap(items, maxFiles), rawCount: rows.length };
}

async function runPrettierProjectScan(opts) {
  const projectRoot = path.resolve(String(opts.projectRoot || ''));
  const workspaceRoot = path.resolve(String(opts.workspaceRoot || projectRoot));
  const timeoutMs = opts.timeoutMs || 120000;
  const maxFiles = opts.maxFiles != null ? Number(opts.maxFiles) : 0;
  const maxPerFile = opts.maxPerFile != null ? Number(opts.maxPerFile) : 4;
  const minSeverity = opts.minSeverity || 'warning';

  const base = resolvePrettierCommand(projectRoot);
  const args = [...base.args, '--list-different', '.'];

  let result;
  try {
    result = await runProcess(base.command, args, { cwd: projectRoot, timeoutMs });
  } catch (err) {
    return { ok: false, engine: 'prettier', projectRoot, error: err.message || String(err), items: [], rawCount: 0 };
  }

  const rows = parsePrettierListOutput(`${result.stdout}\n${result.stderr}`, projectRoot, workspaceRoot);
  const grouped = groupPrettierByFile(rows, minSeverity, maxPerFile, maxFiles);
  return {
    ok: true,
    engine: 'prettier',
    projectRoot,
    items: grouped.items,
    rawCount: grouped.rawCount
  };
}

async function runPrettierFileScan(opts) {
  const projectRoot = path.resolve(String(opts.projectRoot || ''));
  const absPath = path.resolve(String(opts.absPath || ''));
  const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
  const rel = path.relative(projectRoot, absPath) || path.basename(absPath);
  const base = resolvePrettierCommand(projectRoot);
  const args = [...base.args, '--check', rel];

  let result;
  try {
    result = await runProcess(base.command, args, { cwd: projectRoot, timeoutMs });
  } catch {
    return [];
  }
  if (result.code === 0) return [];
  return [
    {
      severity: 'warning',
      line: 1,
      col: 1,
      message: 'File is not formatted according to Prettier',
      code: 'prettier/format',
      source: 'prettier'
    }
  ];
}

/**
 * Remote (SSH) TS diagnostics via tsc on the remote host.
 */
async function runRemoteTscFallback(opts) {
  const projectRoot = String(opts.projectRoot || '').replace(/\\/g, '/');
  const absPath = String(opts.absPath || '').replace(/\\/g, '/');
  const byFile = await runRemoteTscBatch({
    exec: opts.exec,
    projectRoot,
    absPaths: [absPath],
    timeoutMs: opts.timeoutMs,
    minSeverity: opts.minSeverity,
    maxPerFile: opts.maxPerFile
  });
  return byFile.get(absPath) || [];
}

async function runRemoteTscBatch(opts) {
  const projectRoot = String(opts.projectRoot || '').replace(/\\/g, '/');
  const absPaths = [...new Set((opts.absPaths || []).map((p) => String(p || '').replace(/\\/g, '/')))].filter(
    Boolean
  );
  const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
  const byFile = new Map(absPaths.map((p) => [p, []]));
  if (!absPaths.length) return byFile;

  const cmd = 'npx -y typescript --noEmit --pretty false 2>&1; exit 0';
  const r = await opts.exec(cmd, projectRoot, timeoutMs);
  const combined = `${r.stdout || ''}\n${r.stderr || ''}`;
  const all = parseTscOutput(combined);

  for (const absPath of absPaths) {
    const matched = all.filter((d) => {
      const f = String(d.file || '').replace(/\\/g, '/');
      return pathsMatch(f, absPath, projectRoot) || f === absPath || f.endsWith(`/${path.posix.basename(absPath)}`);
    });
    byFile.set(
      absPath,
      limitDiags(
        matched.map(({ file, ...rest }) => rest),
        opts.minSeverity,
        opts.maxPerFile
      )
    );
  }
  return byFile;
}

async function runRemoteCliJsonScan(opts) {
  const projectRoot = String(opts.projectRoot || '').replace(/\\/g, '/');
  const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
  const cmd = String(opts.command || '');
  const r = await opts.exec(cmd, projectRoot, timeoutMs);
  return `${r.stdout || ''}\n${r.stderr || ''}`;
}

async function runRemoteEslintBatch(opts) {
  const projectRoot = String(opts.projectRoot || '').replace(/\\/g, '/');
  const absPaths = [...new Set((opts.absPaths || []).map((p) => String(p || '').replace(/\\/g, '/')))].filter(
    Boolean
  );
  const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
  const byFile = new Map(absPaths.map((p) => [p, []]));
  if (!absPaths.length) return byFile;

  const rels = absPaths.map((p) => {
    const rel = p.startsWith(projectRoot) ? p.slice(projectRoot.length + 1) : path.posix.basename(p);
    return rel.replace(/^\.\//, '');
  });
  const cmd = `npx -y eslint ${rels.map((r) => JSON.stringify(r)).join(' ')} --format json --no-error-on-unmatched-pattern 2>&1; exit 0`;
  const combined = await runRemoteCliJsonScan({ exec: opts.exec, projectRoot, timeoutMs, command: cmd });
  const rows = parseEslintJsonOutput(combined);

  for (const absPath of absPaths) {
    const matched = rows.filter((d) => {
      const f = String(d.file || '').replace(/\\/g, '/');
      return pathsMatch(f, absPath, projectRoot) || f.endsWith(`/${path.posix.basename(absPath)}`);
    });
    byFile.set(
      absPath,
      limitDiags(
        matched.map(({ file, ...rest }) => rest),
        opts.minSeverity,
        opts.maxPerFile
      )
    );
  }
  return byFile;
}

async function runRemoteRuffBatch(opts) {
  const projectRoot = String(opts.projectRoot || '').replace(/\\/g, '/');
  const absPaths = [...new Set((opts.absPaths || []).map((p) => String(p || '').replace(/\\/g, '/')))].filter(
    Boolean
  );
  const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
  const byFile = new Map(absPaths.map((p) => [p, []]));
  if (!absPaths.length) return byFile;

  const rels = absPaths.map((p) => {
    const rel = p.startsWith(projectRoot) ? p.slice(projectRoot.length + 1) : path.posix.basename(p);
    return rel.replace(/^\.\//, '');
  });
  const cmd = `npx -y ruff check ${rels.map((r) => JSON.stringify(r)).join(' ')} --output-format json 2>&1; exit 0`;
  const combined = await runRemoteCliJsonScan({ exec: opts.exec, projectRoot, timeoutMs, command: cmd });
  const rows = parseRuffJsonOutput(combined);

  for (const absPath of absPaths) {
    const matched = rows.filter((d) => {
      const f = String(d.file || '').replace(/\\/g, '/');
      return pathsMatch(f, absPath, projectRoot) || f.endsWith(`/${path.posix.basename(absPath)}`);
    });
    byFile.set(
      absPath,
      limitDiags(
        matched.map(({ file, ...rest }) => rest),
        opts.minSeverity,
        opts.maxPerFile
      )
    );
  }
  return byFile;
}

async function runRemotePrettierBatch(opts) {
  const projectRoot = String(opts.projectRoot || '').replace(/\\/g, '/');
  const absPaths = [...new Set((opts.absPaths || []).map((p) => String(p || '').replace(/\\/g, '/')))].filter(
    Boolean
  );
  const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
  const byFile = new Map(absPaths.map((p) => [p, []]));
  if (!absPaths.length) return byFile;

  for (const absPath of absPaths) {
    const rel = absPath.startsWith(projectRoot)
      ? absPath.slice(projectRoot.length + 1)
      : path.posix.basename(absPath);
    const cmd = `npx -y prettier --check ${JSON.stringify(rel)} 2>&1; exit 0`;
    const combined = await runRemoteCliJsonScan({ exec: opts.exec, projectRoot, timeoutMs, command: cmd });
    if (remotePrettierOutputHasFormatIssue(combined, rel)) {
      byFile.set(absPath, [
        {
          severity: 'warning',
          line: 1,
          col: 1,
          message: 'File is not formatted according to Prettier',
          code: 'prettier/format',
          source: 'prettier'
        }
      ]);
    }
  }
  return byFile;
}

async function runRemoteEslintProjectScan(opts) {
  const projectRoot = String(opts.projectRoot || '').replace(/\\/g, '/');
  const workspaceRoot = String(opts.workspaceRoot || projectRoot).replace(/\\/g, '/');
  const timeoutMs = opts.timeoutMs || 120000;
  const maxFiles = opts.maxFiles != null ? Number(opts.maxFiles) : 0;
  const maxPerFile = opts.maxPerFile != null ? Number(opts.maxPerFile) : 12;
  const minSeverity = opts.minSeverity || 'warning';
  const cmd = 'npx -y eslint . --format json --no-error-on-unmatched-pattern 2>&1; exit 0';
  const combined = await runRemoteCliJsonScan({ exec: opts.exec, projectRoot, timeoutMs, command: cmd });
  const rows = parseEslintJsonOutput(combined);
  const grouped = groupEslintByFile(
    rows,
    projectRoot,
    workspaceRoot,
    minSeverity,
    maxPerFile,
    maxFiles
  );
  return { ok: true, engine: 'eslint', projectRoot, items: grouped.items, rawCount: grouped.rawCount };
}

async function runRemoteRuffProjectScan(opts) {
  const projectRoot = String(opts.projectRoot || '').replace(/\\/g, '/');
  const workspaceRoot = String(opts.workspaceRoot || projectRoot).replace(/\\/g, '/');
  const timeoutMs = opts.timeoutMs || 120000;
  const maxFiles = opts.maxFiles != null ? Number(opts.maxFiles) : 0;
  const maxPerFile = opts.maxPerFile != null ? Number(opts.maxPerFile) : 12;
  const minSeverity = opts.minSeverity || 'warning';
  const cmd = 'npx -y ruff check . --output-format json 2>&1; exit 0';
  const combined = await runRemoteCliJsonScan({ exec: opts.exec, projectRoot, timeoutMs, command: cmd });
  const rows = parseRuffJsonOutput(combined);
  const grouped = groupRuffByFile(rows, projectRoot, workspaceRoot, minSeverity, maxPerFile, maxFiles);
  return { ok: true, engine: 'ruff', projectRoot, items: grouped.items, rawCount: grouped.rawCount };
}

async function runRemoteTscProjectScan(opts) {
  const projectRoot = String(opts.projectRoot || '').replace(/\\/g, '/');
  const workspaceRoot = String(opts.workspaceRoot || projectRoot).replace(/\\/g, '/');
  const timeoutMs = opts.timeoutMs || 120000;
  const maxFiles = opts.maxFiles != null ? Number(opts.maxFiles) : 0;
  const maxPerFile = opts.maxPerFile != null ? Number(opts.maxPerFile) : 12;
  const minSeverity = opts.minSeverity || 'warning';
  const cmd = 'npx -y typescript --noEmit --pretty false 2>&1; exit 0';
  const combined = await runRemoteCliJsonScan({ exec: opts.exec, projectRoot, timeoutMs, command: cmd });
  const all = parseTscOutput(combined);
  const byFile = new Map();
  for (const d of all) {
    if (!d.file) continue;
    let abs = String(d.file).replace(/\\/g, '/');
    if (!abs.startsWith('/')) abs = `${projectRoot}/${abs.replace(/^\.\//, '')}`;
    if (!isUnderWorkspace(abs, workspaceRoot)) continue;
    const key = abs.toLowerCase();
    if (!byFile.has(key)) byFile.set(key, { file: abs, diagnostics: [] });
    const { file, ...rest } = d;
    byFile.get(key).diagnostics.push(rest);
  }
  const items = [];
  for (const entry of byFile.values()) {
    entry.diagnostics = limitDiags(entry.diagnostics, minSeverity, maxPerFile);
    if (entry.diagnostics.length) items.push(entry);
  }
  return { ok: true, engine: 'tsc', projectRoot, items: applyFileCap(items, maxFiles), rawCount: all.length };
}

async function runRemotePrettierProjectScan(opts) {
  const projectRoot = String(opts.projectRoot || '').replace(/\\/g, '/');
  const workspaceRoot = String(opts.workspaceRoot || projectRoot).replace(/\\/g, '/');
  const timeoutMs = opts.timeoutMs || 120000;
  const maxFiles = opts.maxFiles != null ? Number(opts.maxFiles) : 0;
  const maxPerFile = opts.maxPerFile != null ? Number(opts.maxPerFile) : 4;
  const minSeverity = opts.minSeverity || 'warning';
  const cmd = 'npx -y prettier --list-different . 2>&1; exit 0';
  const combined = await runRemoteCliJsonScan({ exec: opts.exec, projectRoot, timeoutMs, command: cmd });
  const rows = parsePrettierListOutput(combined, projectRoot, workspaceRoot);
  const grouped = groupPrettierByFile(rows, minSeverity, maxPerFile, maxFiles);
  return { ok: true, engine: 'prettier', projectRoot, items: grouped.items, rawCount: grouped.rawCount };
}

module.exports = {
  parseTscOutput,
  parsePyrightTextOutput,
  parsePyrightJsonOutput,
  parseEslintJsonOutput,
  parseRuffJsonOutput,
  runTscFallback,
  runPyrightFallback,
  runEslintFileScan,
  runRuffFileScan,
  runPrettierFileScan,
  runCargoCheckFallback,
  runGoVetFallback,
  runTscProjectScan,
  runPyrightProjectScan,
  runEslintProjectScan,
  runRuffProjectScan,
  runPrettierProjectScan,
  runRemoteTscFallback,
  runRemoteTscBatch,
  runRemoteEslintBatch,
  runRemoteRuffBatch,
  runRemotePrettierBatch,
  runRemoteEslintProjectScan,
  runRemoteRuffProjectScan,
  runRemoteTscProjectScan,
  runRemotePrettierProjectScan,
  pathsMatch,
  isPlausibleDiagnosticFilePath,
  resolveTscCommand,
  childEnvForCommand
};

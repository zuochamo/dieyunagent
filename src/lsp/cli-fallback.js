'use strict';

const path = require('path');
const fsSync = require('fs');
const { spawn } = require('child_process');
const { resolveTsServerPath } = require('./language-registry');
const { filterByMinSeverity, severityRank } = require('./lsp-client');
const { buildCmdLine } = require('./spawn-args');
// 远端命令是拼成 shell 字符串执行的：JSON.stringify 只给双引号，`$(...)` / 反引号仍会被远端
// shell 解释（文件名可控 → 远端任意命令执行）。POSIX 单引号才能挡住。
const { shellQuoteSingle } = require('../ssh/remote-path');

const DEFAULT_TIMEOUT_MS = 30000;

function resolveSpawn(command, args, cwd) {
  if (process.platform === 'win32' && command === 'npx') {
    // 逐参数加引号：`--project <userData>/lsp-stubs/...` 里 userData 常带空格，
    // 裸 join(' ') 会被 cmd.exe 劈成两个参数，pyright 参数错误退出 → 诊断静默为空。
    const cmdLine = buildCmdLine('npx', args);
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
      const filePath = row.filePath ? toAbsoluteReportedPath(row.filePath, '') : '';
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

/**
 * 把 CLI 上报的文件路径统一成「绝对路径」。
 *
 * 关键：**远程项目是 POSIX 路径，而宿主可能是 Windows**。
 * `path.normalize('/srv/app/a.js')` 在 win32 上返回 `\srv\app\a.js`，
 * 丢掉「以 / 开头」这个唯一判据，随后 `path.isAbsolute` 判 false、
 * `isUnderWorkspace` 直接丢条目 —— 表现为「远程 eslint/ruff 永远 0 条诊断」。
 * 所以先看分隔符风格，再决定用 posix 还是平台实现。
 */
function toAbsoluteReportedPath(file, projectRoot) {
  const s = String(file || '');
  const proot = String(projectRoot || '');
  const posixWorld = s.startsWith('/') || proot.startsWith('/');
  if (posixWorld) {
    const base = proot.replace(/\\/g, '/').replace(/\/$/, '');
    const rel = s.replace(/\\/g, '/');
    if (rel.startsWith('/')) return path.posix.normalize(rel);
    return path.posix.normalize(base ? `${base}/${rel}` : rel);
  }
  if (path.isAbsolute(s)) return path.normalize(s);
  return path.normalize(path.join(proot, s));
}

function groupEslintByFile(rows, projectRoot, workspaceRoot, minSeverity, maxPerFile, maxFiles) {
  const byFile = new Map();
  for (const d of rows) {
    if (!d.file) continue;
    const abs = toAbsoluteReportedPath(d.file, projectRoot);
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
  // 包 `typescript` 有两个 bin（tsc / tsserver），`npx -y typescript` 会报
  // `npm error could not determine executable to run`（实测 5.8.3 必现）—— 必须显式点名 `tsc`。
  return { command: 'npx', args: ['-y', '-p', 'typescript', 'tsc', '--noEmit', '--pretty', 'false'] };
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

/**
 * pyright CLI 的 `--project` 参数（B3）。
 * 只有在「项目自己没配置 pyright」且「userData 下装了类型存根」时才注入，
 * 避免覆盖用户项目的 venv/include 设置（那会静默改变诊断口径）。
 * 存根（bpy 等）是 PEP 561 stub-only 包，必须经 stubPath 才能被 import 解析器看到，
 * 所以要让 CLI 路线上也生效。
 *
 * @param {string} projectRoot
 * @param {string} [stubDir] userData/lsp-stubs
 * @returns {string[]}
 */
function pyrightProjectArgs(projectRoot, stubDir) {
  const dir = String(stubDir || '').trim();
  if (!dir) return [];
  try {
    if (!fsSync.statSync(dir).isDirectory()) return [];
  } catch {
    return [];
  }
  if (hasOwnPyrightConfig(projectRoot)) return [];
  const cfgPath = path.join(dir, 'pyright-stubconfig.json');
  const config = {
    extraPaths: [dir],
    stubPath: dir,
    // stub-only 包没有 .py 实现，pyright 会误报 "could not be resolved from source"
    reportMissingModuleSource: 'none'
  };
  try {
    fsSync.writeFileSync(cfgPath, JSON.stringify(config, null, 2), 'utf8');
  } catch {
    return [];
  }
  return ['--project', cfgPath];
}

/** 项目自己是否有 pyright 配置（有则不动，交回项目口径） */
function hasOwnPyrightConfig(projectRoot) {
  const root = path.resolve(projectRoot);
  let dir = root;
  for (let i = 0; i < 8; i++) {
    try {
      if (fsSync.existsSync(path.join(dir, 'pyrightconfig.json'))) return true;
    } catch {
      /* ignore */
    }
    const pyproject = path.join(dir, 'pyproject.toml');
    try {
      if (fsSync.existsSync(pyproject) && /\[tool\.pyright\]/i.test(fsSync.readFileSync(pyproject, 'utf8'))) {
        return true;
      }
    } catch {
      /* ignore */
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return false;
}

async function runPyrightFallback(opts) {
  const projectRoot = path.resolve(opts.projectRoot);
  const absPath = path.resolve(opts.absPath);
  const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
  const rel = path.relative(projectRoot, absPath) || path.basename(absPath);
  const projectArgs = pyrightProjectArgs(projectRoot, opts.stubDir);

  let result;
  try {
    result = await runProcess('npx', ['-y', 'pyright', ...projectArgs, '--outputjson', rel], {
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

  result = await runProcess('npx', ['-y', 'pyright', ...projectArgs, rel], {
    cwd: projectRoot,
    timeoutMs
  });
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

  // 与单文件兜底共用同一份 stub 配置：不接进来时，项目扫描层会对 `import bpy`
  // 报 could not be resolved，而单文件层（有 stub）不报；mergeDiagnosticsLayers
  // 是并集，这条幽灵错误永不被清掉且排在前面。
  const projectArgs = pyrightProjectArgs(projectRoot, opts.stubDir);
  const result = await runProcess('npx', ['-y', 'pyright', '--outputjson', ...projectArgs, projectRoot], {
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
      file: row.filename ? toAbsoluteReportedPath(row.filename, '') : ''
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
    const abs = toAbsoluteReportedPath(d.file, projectRoot);
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

async function runRemoteTscBatch(opts) {
  const projectRoot = String(opts.projectRoot || '').replace(/\\/g, '/');
  const absPaths = [...new Set((opts.absPaths || []).map((p) => String(p || '').replace(/\\/g, '/')))].filter(
    Boolean
  );
  const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
  const byFile = new Map(absPaths.map((p) => [p, []]));
  if (!absPaths.length) return remoteEngineSuccess('tsc', byFile);

  // `-p typescript tsc`：包有两个 bin（tsc/tsserver），直接 `npx -y typescript` 会
  // 报 `npm error could not determine executable to run`，远程 tsc 永远跑不起来。
  const cmd = 'npx -y -p typescript tsc --noEmit --pretty false 2>&1';
  const scan = await runRemoteCliJsonScan({ exec: opts.exec, projectRoot, timeoutMs, command: cmd });
  const all = parseTscOutput(scan.text);
  // 与项目扫描同判据：解析不出诊断但退出码非 0 ⇒ 工具没跑起来（npx/tsconfig 缺失）。
  if (!all.length && scan.code !== 0 && scan.code !== null) {
    return remoteEngineFailure(
      'tsc',
      scan,
      `tsc 未产生任何可解析诊断但退出码 ${scan.code}（远程可能没装 node/npx，或 tsconfig 有问题）`
    );
  }

  // 路径归一化 / basename 后缀只算一次：原来这两句落在「文件 × 诊断」的双重循环里，
  // 200 个文件 × 300 条诊断就是 6 万次重复字符串处理。匹配规则与顺序均不变。
  const normalized = all.map((d) => ({ diag: d, file: String(d.file || '').replace(/\\/g, '/') }));
  for (const absPath of absPaths) {
    const suffix = `/${path.posix.basename(absPath)}`;
    const matched = [];
    for (const row of normalized) {
      const f = row.file;
      if (pathsMatch(f, absPath, projectRoot) || f === absPath || f.endsWith(suffix)) {
        matched.push(row.diag);
      }
    }
    byFile.set(
      absPath,
      limitDiags(
        matched.map(({ file, ...rest }) => rest),
        opts.minSeverity,
        opts.maxPerFile
      )
    );
  }
  return remoteEngineSuccess('tsc', byFile);
}

/**
 * 远程 CLI 扫描的**唯一**执行出口。
 *
 * 保留退出码：此前每个命令都拼 `; exit 0`，把「工具根本没跑起来」和「跑完没问题」
 * 压成同一种结果（都是 0 诊断），远程诊断因此长期静默返回「0 个问题」。
 *
 * @returns {Promise<{ text: string, code: number|null }>} code 为远程命令退出码，拿不到时为 null
 */
async function runRemoteCliJsonScan(opts) {
  const projectRoot = String(opts.projectRoot || '').replace(/\\/g, '/');
  const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
  const cmd = String(opts.command || '');
  const r = await opts.exec(cmd, projectRoot, timeoutMs);
  return {
    text: `${(r && r.stdout) || ''}\n${(r && r.stderr) || ''}`,
    code: r && r.code != null ? Number(r.code) : null
  };
}

/**
 * `--format json` 的 CLI 无论有没有问题都会输出 JSON 数组（干净时是 `[]`）。
 * 整段输出里翻不出 JSON 数组 ⇒ 命令没跑起来（npx/工具缺失、网络、权限），
 * 不能当成「0 个问题」。这是远程扫描「静默成功」的可靠判据，不必靠关键词猜。
 */
function findJsonArray(text) {
  const s = String(text || '').trim();
  if (!s) return null;
  const direct = (() => {
    try {
      const v = JSON.parse(s);
      return Array.isArray(v) ? v : null;
    } catch {
      return null;
    }
  })();
  if (direct) return direct;
  const start = s.indexOf('[');
  const end = s.lastIndexOf(']');
  if (start < 0 || end <= start) return null;
  try {
    const v = JSON.parse(s.slice(start, end + 1));
    return Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

/** 失败时带一小段输出尾巴，让人直接看出是「npx 不可用」还是「工具报错」。 */
function outputTail(text, limit = 400) {
  const s = String(text || '').trim();
  if (!s) return '';
  return s.length > limit ? `…${s.slice(-limit)}` : s;
}

/**
 * 远程引擎「没跑起来」的统一失败形状（与项目扫描的 `ok:false + failures` 同口径）。
 *
 * **为什么批量路径也必须判**：批量调用点的上层全是 `.catch(() => new Map())`，
 * 返回空 Map（或抛错被吞）都会被解读成「这个文件没有诊断」⇒ 面板显示「无问题」。
 * 半个引擎残废比整个引擎不可用更危险：用户会以为代码是干净的。
 *
 * @param {'tsc'|'eslint'|'ruff'|'prettier'} engine
 * @param {{ text?: string, code?: number|null }} scan
 * @param {string} error
 */
function remoteEngineFailure(engine, scan, error) {
  return {
    ok: false,
    engine,
    byFile: new Map(),
    error,
    detail: outputTail((scan && scan.text) || ''),
    exitCode: scan && scan.code != null ? scan.code : null
  };
}

/** 成功形状：`byFile` 是唯一的诊断出口，`ok:false` 时它是空 Map（上层不得据此写「无问题」）。 */
function remoteEngineSuccess(engine, byFile) {
  return { ok: true, engine, byFile };
}

/**
 * 「被检查过的文件数」的**唯一口径**：诊断条目里的 file 去重后的个数。
 *
 * 不能用 `rows.length`：eslint 的 `--format json` 是「一个文件一条」，ruff 是
 * 「一条诊断一条」。同一个 `scannedFiles` 字段直接取行数时，ruff 会把
 * 「一个文件 5 个警告」报成「扫描了 5 个文件」—— 正是 `fileCount` 被误读成
 * 「扫到 0 个文件」那类口径事故的同款。
 */
function countScannedFiles(rows) {
  const files = new Set();
  for (const d of rows || []) {
    const f = String((d && d.file) || '')
      .replace(/\\/g, '/')
      .toLowerCase();
    if (f) files.add(f);
  }
  return files.size;
}

async function runRemoteEslintBatch(opts) {
  const projectRoot = String(opts.projectRoot || '').replace(/\\/g, '/');
  const absPaths = [...new Set((opts.absPaths || []).map((p) => String(p || '').replace(/\\/g, '/')))].filter(
    Boolean
  );
  const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
  const byFile = new Map(absPaths.map((p) => [p, []]));
  if (!absPaths.length) return remoteEngineSuccess('eslint', byFile);

  const rels = absPaths.map((p) => {
    const rel = p.startsWith(projectRoot) ? p.slice(projectRoot.length + 1) : path.posix.basename(p);
    return rel.replace(/^\.\//, '');
  });
  const cmd = `npx -y eslint ${rels.map((r) => shellQuoteSingle(r)).join(' ')} --format json --no-error-on-unmatched-pattern 2>&1`;
  const scan = await runRemoteCliJsonScan({ exec: opts.exec, projectRoot, timeoutMs, command: cmd });
  if (!findJsonArray(scan.text)) {
    return remoteEngineFailure(
      'eslint',
      scan,
      'eslint 未产生 JSON 输出（远程可能没装 node/npx，或命令失败）'
    );
  }
  const rows = parseEslintJsonOutput(scan.text);

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
  return remoteEngineSuccess('eslint', byFile);
}

async function runRemoteRuffBatch(opts) {
  const projectRoot = String(opts.projectRoot || '').replace(/\\/g, '/');
  const absPaths = [...new Set((opts.absPaths || []).map((p) => String(p || '').replace(/\\/g, '/')))].filter(
    Boolean
  );
  const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
  const byFile = new Map(absPaths.map((p) => [p, []]));
  if (!absPaths.length) return remoteEngineSuccess('ruff', byFile);

  const rels = absPaths.map((p) => {
    const rel = p.startsWith(projectRoot) ? p.slice(projectRoot.length + 1) : path.posix.basename(p);
    return rel.replace(/^\.\//, '');
  });
  const cmd = `npx -y ruff check ${rels.map((r) => shellQuoteSingle(r)).join(' ')} --output-format json 2>&1`;
  const scan = await runRemoteCliJsonScan({ exec: opts.exec, projectRoot, timeoutMs, command: cmd });
  if (!findJsonArray(scan.text)) {
    return remoteEngineFailure('ruff', scan, 'ruff 未产生 JSON 输出（远程可能没装 node/npx，或命令失败）');
  }
  const rows = parseRuffJsonOutput(scan.text);

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
  return remoteEngineSuccess('ruff', byFile);
}

async function runRemotePrettierBatch(opts) {
  const projectRoot = String(opts.projectRoot || '').replace(/\\/g, '/');
  const absPaths = [...new Set((opts.absPaths || []).map((p) => String(p || '').replace(/\\/g, '/')))].filter(
    Boolean
  );
  const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
  const byFile = new Map(absPaths.map((p) => [p, []]));
  if (!absPaths.length) return remoteEngineSuccess('prettier', byFile);

  let failedScan = null;
  let failedCount = 0;
  for (const absPath of absPaths) {
    const rel = absPath.startsWith(projectRoot)
      ? absPath.slice(projectRoot.length + 1)
      : path.posix.basename(absPath);
    const cmd = `npx -y prettier --check ${shellQuoteSingle(rel)} 2>&1`;
    const scan = await runRemoteCliJsonScan({ exec: opts.exec, projectRoot, timeoutMs, command: cmd });
    // `prettier --check` 的退出码有语义：0=已格式化，1=待格式化（正常结果），>1=执行错误。
    // 只把 >1 当失败，绝不因为「有文件待格式化」就判引擎不可用。
    if (scan.code != null && scan.code > 1) {
      failedCount += 1;
      if (!failedScan) failedScan = scan;
      // 126/127 = 命令本身不存在（如 `sh: prettier: not found`）：后面的文件必然同样失败，
      // 立刻停下，别把整批文件逐个重试一遍（线上实测：远端没装 prettier 时文件数=命令数）。
      if (scan.code === 126 || scan.code === 127) break;
      continue;
    }
    if (remotePrettierOutputHasFormatIssue(scan.text, rel)) {
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
  if (failedScan) {
    return remoteEngineFailure(
      'prettier',
      failedScan,
      `prettier 在 ${failedCount} 个文件上执行失败（退出码 ${failedScan.code}）`
    );
  }
  return remoteEngineSuccess('prettier', byFile);
}

async function runRemoteEslintProjectScan(opts) {
  const projectRoot = String(opts.projectRoot || '').replace(/\\/g, '/');
  const workspaceRoot = String(opts.workspaceRoot || projectRoot).replace(/\\/g, '/');
  const timeoutMs = opts.timeoutMs || 120000;
  const maxFiles = opts.maxFiles != null ? Number(opts.maxFiles) : 0;
  const maxPerFile = opts.maxPerFile != null ? Number(opts.maxPerFile) : 12;
  const minSeverity = opts.minSeverity || 'warning';
  const cmd = 'npx -y eslint . --format json --no-error-on-unmatched-pattern 2>&1';
  const scan = await runRemoteCliJsonScan({ exec: opts.exec, projectRoot, timeoutMs, command: cmd });
  const rows = findJsonArray(scan.text);
  if (!rows) {
    // 拿不到 JSON 数组 = eslint 没跑起来。以前这里会被解析成 0 条，然后上游
    // 汇报「扫描完成，0 个问题」—— 用户看到的是「没毛病」，实际是「没扫描」。
    return {
      ok: false,
      engine: 'eslint',
      error: 'eslint 未产生 JSON 输出（远程可能没装 node/npx，或命令失败）',
      detail: outputTail(scan.text),
      exitCode: scan.code,
      projectRoot
    };
  }
  const parsed = parseEslintJsonOutput(scan.text);
  const grouped = groupEslintByFile(
    parsed,
    projectRoot,
    workspaceRoot,
    minSeverity,
    maxPerFile,
    maxFiles
  );
  return {
    ok: true,
    engine: 'eslint',
    projectRoot,
    items: grouped.items,
    rawCount: grouped.rawCount,
    // 真正被检查过的文件数（与「有诊断的文件数」不是一回事，别混用）
    scannedFiles: countScannedFiles(parsed)
  };
}

async function runRemoteRuffProjectScan(opts) {
  const projectRoot = String(opts.projectRoot || '').replace(/\\/g, '/');
  const workspaceRoot = String(opts.workspaceRoot || projectRoot).replace(/\\/g, '/');
  const timeoutMs = opts.timeoutMs || 120000;
  const maxFiles = opts.maxFiles != null ? Number(opts.maxFiles) : 0;
  const maxPerFile = opts.maxPerFile != null ? Number(opts.maxPerFile) : 12;
  const minSeverity = opts.minSeverity || 'warning';
  const cmd = 'npx -y ruff check . --output-format json 2>&1';
  const scan = await runRemoteCliJsonScan({ exec: opts.exec, projectRoot, timeoutMs, command: cmd });
  const rows = findJsonArray(scan.text);
  if (!rows) {
    return {
      ok: false,
      engine: 'ruff',
      error: 'ruff 未产生 JSON 输出（远程可能没装 node/npx，或命令失败）',
      detail: outputTail(scan.text),
      exitCode: scan.code,
      projectRoot
    };
  }
  const parsed = parseRuffJsonOutput(scan.text);
  const grouped = groupRuffByFile(parsed, projectRoot, workspaceRoot, minSeverity, maxPerFile, maxFiles);
  return {
    ok: true,
    engine: 'ruff',
    projectRoot,
    items: grouped.items,
    rawCount: grouped.rawCount,
    // ruff 的 JSON 是「一条诊断一条」，文件数必须去重（见 countScannedFiles）
    scannedFiles: countScannedFiles(parsed)
  };
}

async function runRemoteTscProjectScan(opts) {
  const projectRoot = String(opts.projectRoot || '').replace(/\\/g, '/');
  const workspaceRoot = String(opts.workspaceRoot || projectRoot).replace(/\\/g, '/');
  const timeoutMs = opts.timeoutMs || 120000;
  const maxFiles = opts.maxFiles != null ? Number(opts.maxFiles) : 0;
  const maxPerFile = opts.maxPerFile != null ? Number(opts.maxPerFile) : 12;
  const minSeverity = opts.minSeverity || 'warning';
  // `-p typescript tsc`：包有两个 bin（tsc/tsserver），直接 `npx -y typescript` 会
  // 报 `npm error could not determine executable to run`，远程 tsc 永远跑不起来。
  const cmd = 'npx -y -p typescript tsc --noEmit --pretty false 2>&1';
  const scan = await runRemoteCliJsonScan({ exec: opts.exec, projectRoot, timeoutMs, command: cmd });
  const all = parseTscOutput(scan.text);
  // tsc 干净时零输出且 exit 0；解析不出诊断但**退出码非 0** ⇒ 没跑起来（npx/tsconfig 缺失）。
  if (!all.length && scan.code !== 0 && scan.code !== null) {
    return {
      ok: false,
      engine: 'tsc',
      error: `tsc 未产生任何可解析诊断但退出码 ${scan.code}（远程可能没装 node/npx，或 tsconfig 有问题）`,
      detail: outputTail(scan.text),
      exitCode: scan.code,
      projectRoot
    };
  }
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
  const cmd = 'npx -y prettier --list-different . 2>&1';
  const scan = await runRemoteCliJsonScan({ exec: opts.exec, projectRoot, timeoutMs, command: cmd });
  // prettier --list-different 的退出码语义：0 = 全部已格式化，1 = 有文件待格式化，>=2 = 出错。
  if (scan.code != null && scan.code > 1) {
    return {
      ok: false,
      engine: 'prettier',
      error: `prettier 执行失败（退出码 ${scan.code}）`,
      detail: outputTail(scan.text),
      exitCode: scan.code,
      projectRoot
    };
  }
  const rows = parsePrettierListOutput(scan.text, projectRoot, workspaceRoot);
  const grouped = groupPrettierByFile(rows, minSeverity, maxPerFile, maxFiles);
  return { ok: true, engine: 'prettier', projectRoot, items: grouped.items, rawCount: grouped.rawCount };
}

module.exports = {
  pyrightProjectArgs,
  hasOwnPyrightConfig,
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

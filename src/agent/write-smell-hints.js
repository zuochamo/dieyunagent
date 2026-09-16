'use strict';
// @ts-check

/**
 * 写入即反馈：文件写成功后，对「刚落盘的路径与内容」做结构性坏味道检查，
 * 结果作为 warnings 挂在该次工具结果上，让模型在下一步立刻看到自己产出的形状。
 *
 * 针对 agent 的四个真实习惯：
 *   1) 用文件名记版本：convert_ico / convert_ico2 / convert_ico3 …（同一目录同族文件）
 *   2) 静默吞异常：except: pass / except Exception: ... pass / catch {}
 *   3) 明文凭据写进源码
 *   4) 同一常量在多个文件各写一份（改一处漏一处）
 *
 * 边界（勿扩）：
 *   - 只报告：不阻断工具结果、不触发重跑、不改文件（循环哲学：有模型正文就交付）
 *   - 判定对象是写入产物，不涉及用户消息，因此不构成意图关键词路由
 *   - 目录同胞靠注入的 readDirNames 取（Main 侧走 Gateway glob RPC）；
 *     取不到（无注入 / 失败 / 超时）时能力降级为「只看得见本轮」，绝不因此影响工具结果
 */

const { AGENT_LIMITS_DEFAULTS } = require('./agent-limits');

/** 能同时提供「路径 + 内容」的写工具。其余写类工具（skill_create 等）参数形态不同，不在此处理。 */
const CONTENT_WRITE_TOOLS = new Set(['fs_write_file', 'fs_edit']);

/** 追踪器按 run 保留的条数上限，防止长驻进程内存堆积。 */
const TRACKER_MAX_RUNS = 64;

/** glob 模式里的元字符：命中就放弃这次目录查询（宁可降级，不要给出错误模式） */
const GLOB_META_RE = /[[\]{}*?\\]/;

function slashPath(filePath) {
  return String(filePath || '').replace(/\\/g, '/');
}

function baseName(filePath) {
  const s = slashPath(filePath);
  return s.slice(s.lastIndexOf('/') + 1);
}

function dirName(filePath) {
  const s = slashPath(filePath);
  const i = s.lastIndexOf('/');
  return i < 0 ? '' : s.slice(0, i);
}

/**
 * 替身键：扩展名 + 「数字串（含紧跟单字母，如 step4b）归一为 #」的基名。
 * 带扩展名是为了避免 icon.png / icon.ico 这类同胞不同用途的误判。
 */
function twinKey(filePath) {
  const base = baseName(filePath);
  const dot = base.lastIndexOf('.');
  const ext = dot > 0 ? base.slice(dot).toLowerCase() : '';
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const normalized = stem.replace(/\d+[a-z]?/gi, '#').replace(/[#_-]+$/, '');
  return `${ext}:${normalized}`;
}

/**
 * 写入文件所在目录相对工作区的路径（'' = 工作区根）。
 * 返回 null 表示无法确定（绝对路径且不在工作区内）。
 */
function relDirOf(filePath, workspaceRoot) {
  const s = slashPath(filePath);
  const i = s.lastIndexOf('/');
  const dir = i < 0 ? '' : s.slice(0, i);
  const root = slashPath(workspaceRoot).replace(/\/+$/, '');
  const isAbs = /^[a-zA-Z]:\//.test(s) || s.startsWith('/');
  let rel;

  if (root && dir.toLowerCase().startsWith(root.toLowerCase())) {
    rel = dir.slice(root.length);
  } else if (isAbs) {
    return null; // 绝对路径且不在工作区内：无从构造相对路径
  } else {
    rel = dir; // 相对工作区路径（fs_write_file / fs_edit 的常见形态）
  }

  rel = rel.replace(/^\/+/, '').replace(/^\.\//, '').replace(/\/+$/, '');
  return rel === '.' ? '' : rel;
}

/**
 * 把「写入文件所在目录」换算成 glob 模式。返回 null 表示无法安全构造
 * （工作区外绝对路径 / 目录名含 glob 元字符）。
 */
function relDirGlobPattern(filePath, workspaceRoot) {
  const rel = relDirOf(filePath, workspaceRoot);
  if (rel === null) return null;
  if (rel && GLOB_META_RE.test(rel)) return null;
  return rel === '' ? '*' : `${rel}/*`;
}

/**
 * 从 glob 结果里筛出「目标目录的直接子项」名字。
 *
 * 必须自己筛：ripgrep 对**不含** `/` 的模式是按 basename 在任意深度匹配的，
 * 而工作区根目录生成的模式恰好就是 `'*'` —— 不筛就会递归命中子目录，
 * 把 `sub/convert_ico2.py` 误判成同族。留空目录名（''）即工作区根：只留顶层文件。
 * 返回的 files 可能是绝对路径也可能是相对路径，两种都容纳。
 */
function filterDirNames(files, targetDirRel, workspaceRoot) {
  const root = slashPath(workspaceRoot).replace(/\/+$/, '').toLowerCase();
  const want = String(targetDirRel || '').replace(/^\/+|\/+$/g, '').toLowerCase();
  const out = [];
  for (const raw of Array.isArray(files) ? files : []) {
    let f = slashPath(String(raw));
    if (root && f.toLowerCase().startsWith(root)) f = f.slice(root.length);
    f = f.replace(/^\/+/, '');
    const i = f.lastIndexOf('/');
    const dirPart = i < 0 ? '' : f.slice(0, i);
    if (dirPart.toLowerCase() !== want) continue;
    out.push(f.slice(i + 1));
  }
  return out;
}

function extractFilePath(args) {
  const a = args && typeof args === 'object' ? args : {};
  const p = a.filePath || a.path || a.file || a.filename;
  return typeof p === 'string' && p.trim() ? p.trim() : '';
}

/** 取本次写入的文本：fs_write_file 的 content；fs_edit 的新文本（含 edits 数组）。 */
function extractWriteText(toolName, args) {
  const a = args && typeof args === 'object' ? args : {};
  if (toolName === 'fs_write_file') return typeof a.content === 'string' ? a.content : '';
  const parts = [];
  if (typeof a.newString === 'string') parts.push(a.newString);
  if (typeof a.new_string === 'string') parts.push(a.new_string);
  if (Array.isArray(a.edits)) {
    for (const e of a.edits) {
      if (!e || typeof e !== 'object') continue;
      if (typeof e.newString === 'string') parts.push(e.newString);
      if (typeof e.new_string === 'string') parts.push(e.new_string);
    }
  }
  return parts.join('\n');
}

const SWALLOWED_EXCEPTION_PATTERNS = [
  { re: /except\b[^:\n]*:[ \t]*(pass|\.\.\.)\b/, label: 'except: pass' },
  // \r?\n 兼容 CRLF：Windows 上编辑过的 .py 多为 CRLF，漏掉 \r 会整体检不出
  { re: /except\b[^:\n]*:[ \t]*\r?\n[ \t]*(pass|\.\.\.)\b/, label: 'except 后接 pass' },
  { re: /catch\s*(?:\([^)]*\))?\s*\{\s*\}/, label: 'catch {}' }
];

/** @returns {string} 命中的形态，未命中返回空串 */
function scanSwallowedExceptions(text) {
  const s = String(text || '');
  for (const p of SWALLOWED_EXCEPTION_PATTERNS) {
    if (p.re.test(s)) return p.label;
  }
  return '';
}

const PLAINTEXT_SECRET_RE =
  /\b(password|passwd|pwd|pass|secret|api[_-]?key|apikey|access[_-]?key|token)\b\s*[:=]\s*["'][^"'\n]{1,64}["']/i;

/** @returns {string} 命中的字段名，未命中返回空串 */
function scanPlaintextSecret(text) {
  const m = PLAINTEXT_SECRET_RE.exec(String(text || ''));
  return m ? m[1] : '';
}

/**
 * 抽「全大写常量 = 字面量」的赋值。用全大写作为结构信号（常量约定），
 * 不依赖具体字段名词表。支持 `HOST = "x"` 与 PowerShell 的 `$HOST = "x"`。
 */
const CONST_ASSIGN_RE = /^[ \t]*\$?([A-Z][A-Z0-9_]{1,40})\s*[:=]\s*["']([^"'\n]{2,80})["'][ \t]*\r?$/gm;

/** @returns {Array<{name: string, value: string}>} */
function extractConstantAssignments(text) {
  const s = String(text || '');
  const out = [];
  CONST_ASSIGN_RE.lastIndex = 0;
  let m = CONST_ASSIGN_RE.exec(s);
  while (m) {
    out.push({ name: m[1], value: m[2] });
    m = CONST_ASSIGN_RE.exec(s);
  }
  return out;
}

function createWriteSmellTracker() {
  return { dirs: new Map(), consts: new Map(), dirNames: new Map() };
}

const trackers = new Map();

function trackerFor(runKey) {
  const key = String(runKey || '');
  let t = trackers.get(key);
  if (!t) {
    t = createWriteSmellTracker();
    trackers.set(key, t);
    while (trackers.size > TRACKER_MAX_RUNS) {
      const oldest = trackers.keys().next().value;
      if (oldest === undefined || oldest === key) break;
      trackers.delete(oldest);
    }
  }
  return t;
}

function resetWriteSmellTrackers() {
  trackers.clear();
}

/** limits 允许传对象或惰性取值函数：非写工具的调用不应付出解析开销。 */
function resolveLimits(limits) {
  if (typeof limits === 'function') {
    try {
      const v = limits();
      return v && typeof v === 'object' ? v : {};
    } catch {
      return {}; // 取不到上限就用默认值，不因配置读取失败影响工具结果
    }
  }
  return limits && typeof limits === 'object' ? limits : {};
}

function capHints(hints, limits) {
  const l = resolveLimits(limits);
  const rawItems = Number(l.writeSmellHintMaxItems);
  const rawChars = Number(l.writeSmellHintMaxChars);
  const maxItems = Number.isFinite(rawItems)
    ? Math.max(0, Math.floor(rawItems))
    : AGENT_LIMITS_DEFAULTS.writeSmellHintMaxItems;
  const maxChars = Number.isFinite(rawChars)
    ? Math.max(0, Math.floor(rawChars))
    : AGENT_LIMITS_DEFAULTS.writeSmellHintMaxChars;
  const out = [];
  let used = 0;
  for (const h of hints) {
    if (out.length >= maxItems) break;
    const s = String(h);
    if (used + s.length > maxChars) break;
    used += s.length;
    out.push(s);
  }
  return out;
}

/**
 * 取该文件所在目录的同胞文件名。按 (run, 目录) 只查一次：成功与失败都缓存，
 * 失败缓存为 null 表示本轮不再重试（避免权限/超时目录被反复戳）。
 *
 * @param {{ dirs: Map<string, Map<string, Set<string>>>, consts: Map<string, string>, dirNames: Map<string, Promise<string[]|null>> }} tracker
 * @param {string} dir
 * @param {string} filePath
 * @param {((filePath: string) => Promise<string[]|null>) | undefined} readDirNames
 * @returns {Promise<string[]|null>}
 */
function dirNamesCached(tracker, dir, filePath, readDirNames) {
  if (typeof readDirNames !== 'function') return Promise.resolve(null);
  if (tracker.dirNames.has(dir)) return tracker.dirNames.get(dir);
  // 缓存 Promise 而非结果：同一目录的并行写入（delegate 批次按文件跨文件并行）共享同一次查询
  const pending = (async () => {
    try {
      const r = await readDirNames(filePath);
      return Array.isArray(r) ? r.map((n) => String(n)) : null;
    } catch {
      return null; // 查询失败即降级：本轮不再重试该目录
    }
  })();
  tracker.dirNames.set(dir, pending);
  return pending;
}

/**
 * @param {{
 *   toolName?: string,
 *   args?: object,
 *   result?: unknown,
 *   runKey?: string,
 *   limits?: object | (() => object),
 *   readDirNames?: (filePath: string) => Promise<string[]|null>
 * }} input
 * @returns {Promise<string[]>} 结构性提示（已按上限裁剪）；无则为空数组
 */
async function collectWriteSmellHints(input) {
  const src = input && typeof input === 'object' ? input : {};
  const toolName = String(src.toolName || '');
  if (!CONTENT_WRITE_TOOLS.has(toolName)) return [];

  const result = src.result;
  if (result && typeof result === 'object') {
    const r = /** @type {Record<string, unknown>} */ (result);
    if (r.error || r.ok === false) return [];
  }

  const filePath = extractFilePath(src.args);
  if (!filePath) return [];

  const text = extractWriteText(toolName, src.args);
  const tracker = trackerFor(src.runKey);
  const hints = [];

  const dir = dirName(filePath);
  const name = baseName(filePath);
  const key = twinKey(filePath);

  const dirNames = await dirNamesCached(tracker, dir, filePath, src.readDirNames);

  let byKey = tracker.dirs.get(dir);
  if (!byKey) {
    byKey = new Map();
    tracker.dirs.set(dir, byKey);
  }
  const seen = byKey.get(key) || new Set();
  const isNewName = !seen.has(name);
  const sameRunTwins = [...seen].filter((n) => n !== name);
  seen.add(name);
  byKey.set(key, seen);

  const onDiskTwins = Array.isArray(dirNames)
    ? dirNames.filter((n) => n !== name && twinKey(n) === key)
    : [];
  const twins = [...new Set([...sameRunTwins, ...onDiskTwins])];

  // 只有「新建出来」的文件才提示：若它在写入前已存在于该目录，那是一次正常编辑。
  // 取不到目录清单时退回「本轮是否首次见到该文件名」。
  const existedBefore = Array.isArray(dirNames) ? dirNames.includes(name) : null;
  const justCreated = existedBefore === null ? isNewName : !existedBefore;

  if (justCreated && twins.length) {
    const where = onDiskTwins.length ? '同目录已存在同族文件' : '同一目录本轮已写入同族文件';
    hints.push(
      `${where} ${twins.slice(0, 6).join('、')}${twins.length > 6 ? ' 等' : ''}：` +
        '同一功能尽量只留一个文件。版本历史交给 git，勿用文件名后缀记版本；确需多个文件时名字应能说明差别。'
    );
  }

  const swallow = text ? scanSwallowedExceptions(text) : '';
  if (swallow) {
    hints.push(
      `本次写入包含静默吞异常（${swallow}）：异常要么处理、要么向上抛。` +
        '确实要忽略时，请在 catch/except 内写明原因，别让失败看起来像成功。'
    );
  }

  const secret = text ? scanPlaintextSecret(text) : '';
  if (secret) {
    hints.push(
      `本次写入疑似包含明文凭据（${secret}）：凭据应取自环境变量或密钥文件，勿写进源码。示例值可忽略本条。`
    );
  }

  if (text) {
    for (const c of extractConstantAssignments(text)) {
      const ck = `${c.name}=${c.value}`;
      const first = tracker.consts.get(ck);
      if (!first) {
        tracker.consts.set(ck, filePath);
        continue;
      }
      if (first !== filePath) {
        hints.push(
          `常量 ${c.name} = "${c.value}" 已在本轮写入的 ${first} 中出现过：` +
            '同一事实只留一处来源，避免改一处漏一处。'
        );
      }
    }
  }

  if (!hints.length) return [];
  return capHints(hints, src.limits);
}

module.exports = {
  CONTENT_WRITE_TOOLS,
  twinKey,
  baseName,
  dirName,
  relDirOf,
  relDirGlobPattern,
  filterDirNames,
  scanSwallowedExceptions,
  scanPlaintextSecret,
  extractConstantAssignments,
  createWriteSmellTracker,
  resetWriteSmellTrackers,
  collectWriteSmellHints
};

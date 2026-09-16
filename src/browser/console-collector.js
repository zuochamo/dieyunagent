'use strict';

/**
 * 浏览器 console 采集（HAR-lite 的网络记录之外，补齐"页面运行时错误"信号）。
 *
 * 覆盖三类：
 * - console.* 调用（两个引擎都能原生拿到）
 * - 未捕获异常 pageerror：BrowserView 没有 page.on('pageerror')，需要在页面里
 *   注入钩子把 window 'error' / 'unhandledrejection' 转发到 console.error，
 *   再由 console-message 采集（注入脚本见 buildConsoleErrorHookScript）。
 * - 未处理 Promise 拒绝（同上）
 *
 * 纯逻辑 + 内存环形缓冲，零 Electron 依赖，便于单测。
 */

const DEFAULT_MAX_ENTRIES = 500;
const ENTRY_TEXT_MAX = 2000;
const PAGE_ERROR_MARKER = '[dieyun-pageerror]';
const UNHANDLED_REJECTION_MARKER = '[dieyun-unhandledrejection]';
const HOOK_FLAG = '__dieyunConsoleHookInstalled';

const NUMERIC_LEVELS = ['debug', 'info', 'warn', 'error'];

/** 归一化等级：兼容 Electron 旧版数字等级、Chromium 'warning' 与常见别名。 */
function normalizeLevel(raw) {
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return NUMERIC_LEVELS[raw] || 'log';
  }
  const l = String(raw == null ? '' : raw).toLowerCase();
  if (l === 'warning') return 'warn';
  if (l === 'verbose') return 'debug';
  if (l === 'log' || l === 'debug' || l === 'info' || l === 'warn' || l === 'error') return l;
  return 'log';
}

/** 页面内注入脚本：把未捕获异常/未处理拒绝转发到 console.error，供 Main 采集。 */
function buildConsoleErrorHookScript() {
  return `(() => {
  if (window.${HOOK_FLAG}) return 'already';
  window.${HOOK_FLAG} = true;
  const report = (marker, detail) => {
    try { console.error(marker + ' ' + detail); } catch (_) {}
  };
  window.addEventListener('error', (e) => {
    if (!e) return;
    const msg = (e.error && e.error.message) || e.message || 'unknown error';
    const where = e.filename ? ' @ ' + e.filename + ':' + (e.lineno || 0) : '';
    report('${PAGE_ERROR_MARKER}', String(msg) + where);
  }, true);
  window.addEventListener('unhandledrejection', (e) => {
    const r = e && e.reason;
    const msg = r && (r.message ? r.message : r);
    report('${UNHANDLED_REJECTION_MARKER}', String(msg || 'unhandled rejection'));
  });
  return 'installed';
})()`;
}

/** 识别注入钩子的转发文本，还原成结构化来源。 */
function classifyConsoleEntry(level, text) {
  const raw = String(text == null ? '' : text);
  if (raw.startsWith(PAGE_ERROR_MARKER)) {
    return { source: 'pageerror', level: 'error', text: raw.slice(PAGE_ERROR_MARKER.length).trim() };
  }
  if (raw.startsWith(UNHANDLED_REJECTION_MARKER)) {
    return {
      source: 'unhandledrejection',
      level: 'error',
      text: raw.slice(UNHANDLED_REJECTION_MARKER.length).trim()
    };
  }
  return { source: 'console', level: normalizeLevel(level), text: raw };
}

function createConsoleJournal(opts = {}) {
  const maxEntries = Math.max(50, Number(opts.maxEntries) || DEFAULT_MAX_ENTRIES);
  /** @type {Array<object>} */
  let entries = [];
  let seq = 0;

  function add(partial = {}) {
    seq += 1;
    const entry = {
      id: `con-${seq}`,
      ts: Date.now(),
      source: partial.source || 'console',
      level: normalizeLevel(partial.level),
      text: String(partial.text || '').slice(0, ENTRY_TEXT_MAX),
      url: partial.url ? String(partial.url).slice(0, 500) : '',
      line: partial.line != null ? Number(partial.line) || 0 : undefined,
      engine: partial.engine
    };
    entries.push(entry);
    if (entries.length > maxEntries) entries = entries.slice(-maxEntries);
    return entry;
  }

  function clear() {
    entries = [];
  }

  function list(args = {}) {
    const limit = Math.min(200, Math.max(1, Number(args.limit) || 50));
    let out = entries.slice();
    if (args.errorsOnly) out = out.filter((e) => e.level === 'error');
    if (args.level) {
      const level = normalizeLevel(args.level);
      out = out.filter((e) => e.level === level);
    }
    if (args.urlPattern) {
      const raw = String(args.urlPattern);
      let match;
      try {
        const re = new RegExp(raw, 'i');
        match = (e) => re.test(e.url || '');
      } catch {
        const needle = raw.toLowerCase();
        match = (e) => String(e.url || '').toLowerCase().includes(needle);
      }
      out = out.filter(match);
    }
    if (args.sinceMs) {
      const since = Date.now() - Math.max(0, Number(args.sinceMs) || 0);
      out = out.filter((e) => e.ts >= since);
    }
    return out.slice(-limit);
  }

  function status() {
    const tail = entries.slice(-50);
    return { total: entries.length, recentErrors: tail.filter((e) => e.level === 'error').length };
  }

  return { add, clear, list, status };
}

function summarizeConsoleEntries(entries) {
  const list = Array.isArray(entries) ? entries : [];
  return {
    count: list.length,
    errorCount: list.filter((e) => e.level === 'error').length,
    entries: list.map((e) => ({
      id: e.id,
      ts: e.ts,
      source: e.source,
      level: e.level,
      text: String(e.text || '').slice(0, 300),
      url: e.url || '',
      line: e.line
    }))
  };
}

module.exports = {
  DEFAULT_MAX_ENTRIES,
  PAGE_ERROR_MARKER,
  UNHANDLED_REJECTION_MARKER,
  normalizeLevel,
  buildConsoleErrorHookScript,
  classifyConsoleEntry,
  createConsoleJournal,
  summarizeConsoleEntries
};

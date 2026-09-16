'use strict';

const fs = require('fs');
const path = require('path');

const LOG_RETENTION_DAYS = 3;
const LOG_RETENTION_MS = LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000;

/** 运行日志 UI 中不展示的 SQL Server 相关行 */
const SQL_SERVER_LOG_LINE_RE =
  /\bSQL Server\b|sqlserver|SqlServer|\bmssql\b|SQL Server 服务|SQL Server 未启用|未配置 SQL Server 密码/i;

/**
 * @param {string} line
 */
function isSqlServerLogLine(line) {
  return SQL_SERVER_LOG_LINE_RE.test(String(line || ''));
}

/**
 * @param {string} content
 */
function filterLogContentForDisplay(content) {
  if (!content) return '';
  return content
    .split(/\r?\n/)
    .filter((line) => !isSqlServerLogLine(line))
    .join('\n');
}

/**
 * @param {string} line
 * @returns {number | null}
 */
function parseLogLineTime(line) {
  const s = String(line || '');
  const iso = s.match(/^\[(\d{4}-\d{2}-\d{2}T[\d:.]+Z?)\]/);
  if (iso) {
    const t = Date.parse(iso[1]);
    return Number.isNaN(t) ? null : t;
  }
  const elog = s.match(/^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?)\]/);
  if (elog) {
    const t = Date.parse(elog[1].replace(' ', 'T'));
    return Number.isNaN(t) ? null : t;
  }
  return null;
}

/**
 * @param {string} userData
 * @returns {{ id: string, label: string, path: string }[]}
 */
function listLogSources(userData, opts = {}) {
  const appLogPath =
    opts.mainLogPath && String(opts.mainLogPath).trim()
      ? String(opts.mainLogPath).trim()
      : path.join(userData, 'logs', 'main.log');
  return [
    {
      id: 'app',
      label: '应用主日志',
      path: appLogPath
    },
    {
      id: 'gateway',
      label: '本地 Gateway',
      path: path.join(userData, 'gateway-readable', 'gateway.log')
    }
  ];
}

/**
 * @param {string} filePath
 * @param {number} maxLines
 */
function readLogTail(filePath, maxLines = 600) {
  if (!filePath || !fs.existsSync(filePath)) {
    return { path: filePath, missing: true, content: '', lineCount: 0 };
  }
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const lines = raw.split(/\r?\n/);
    const tail = lines.slice(-Math.max(1, maxLines));
    const filtered = filterLogContentForDisplay(tail.join('\n'));
    const filteredLines = filtered ? filtered.split(/\r?\n/) : [];
    return {
      path: filePath,
      missing: false,
      content: filtered,
      lineCount: filteredLines.length,
      totalLines: lines.length
    };
  } catch (e) {
    return {
      path: filePath,
      missing: false,
      error: e.message || String(e),
      content: '',
      lineCount: 0
    };
  }
}

/**
 * @param {string} filePath
 * @param {number} maxAgeMs
 * @param {string} [activeLogPath]
 */
function pruneLogFileByAge(filePath, maxAgeMs, activeLogPath = '') {
  if (!filePath || !fs.existsSync(filePath)) {
    return { path: filePath, removedLines: 0, deleted: false };
  }
  const normalizedActive = activeLogPath ? path.resolve(activeLogPath) : '';
  const resolved = path.resolve(filePath);
  const cutoff = Date.now() - maxAgeMs;

  if (normalizedActive && resolved !== normalizedActive) {
    try {
      const st = fs.statSync(resolved);
      if (st.isFile() && st.mtimeMs < cutoff) {
        fs.unlinkSync(resolved);
        return { path: filePath, removedLines: 0, deleted: true };
      }
    } catch {
      // ignore
    }
    return { path: filePath, removedLines: 0, deleted: false };
  }

  try {
    const raw = fs.readFileSync(resolved, 'utf8');
    const lines = raw.split(/\r?\n/);
    let removedLines = 0;
    const kept = [];
    for (const line of lines) {
      const t = parseLogLineTime(line);
      if (t == null) {
        if (kept.length) kept.push(line);
        continue;
      }
      if (t >= cutoff) kept.push(line);
      else removedLines++;
    }
    if (removedLines > 0) {
      const out = kept.join('\n');
      fs.writeFileSync(resolved, out ? `${out}\n` : '', 'utf8');
    }
    return { path: filePath, removedLines, deleted: false };
  } catch {
    return { path: filePath, removedLines: 0, deleted: false };
  }
}

/**
 * @param {string} logsDir
 * @param {number} maxAgeMs
 * @param {string} activeLogPath
 */
function pruneLogDirectoryArchives(logsDir, maxAgeMs, activeLogPath) {
  const deleted = [];
  if (!logsDir || !fs.existsSync(logsDir)) return deleted;
  const cutoff = Date.now() - maxAgeMs;
  const activeResolved = activeLogPath ? path.resolve(activeLogPath) : '';
  for (const name of fs.readdirSync(logsDir)) {
    const full = path.join(logsDir, name);
    if (activeResolved && path.resolve(full) === activeResolved) continue;
    try {
      const st = fs.statSync(full);
      if (st.isFile() && st.mtimeMs < cutoff) {
        fs.unlinkSync(full);
        deleted.push(full);
      }
    } catch {
      // ignore
    }
  }
  return deleted;
}

/**
 * @param {string} filePath
 */
function truncateLogFile(filePath) {
  if (!filePath || !fs.existsSync(filePath)) {
    return { path: filePath, cleared: false, previousLines: 0, missing: true };
  }
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const previousLines = raw.split(/\r?\n/).filter((line) => line.length > 0).length;
    fs.writeFileSync(filePath, '', 'utf8');
    return { path: filePath, cleared: true, previousLines };
  } catch (e) {
    return { path: filePath, cleared: false, previousLines: 0, error: e.message || String(e) };
  }
}

/**
 * @param {string} logsDir
 * @param {string} activeLogPath
 */
function clearLogDirectoryArchives(logsDir, activeLogPath) {
  const deleted = [];
  if (!logsDir || !fs.existsSync(logsDir)) return deleted;
  const activeResolved = activeLogPath ? path.resolve(activeLogPath) : '';
  for (const name of fs.readdirSync(logsDir)) {
    const full = path.join(logsDir, name);
    if (activeResolved && path.resolve(full) === activeResolved) continue;
    try {
      const st = fs.statSync(full);
      if (st.isFile()) {
        fs.unlinkSync(full);
        deleted.push(full);
      }
    } catch {
      // ignore
    }
  }
  return deleted;
}

/**
 * @param {string} userData
 * @param {{ mainLogPath?: string }} [opts]
 */
function clearAllLogs(userData, opts = {}) {
  const sources = listLogSources(userData, opts);
  const activeMain = sources.find((s) => s.id === 'app')?.path || '';
  const results = sources.map((src) => truncateLogFile(src.path));
  const logsDir = path.join(userData, 'logs');
  const deletedArchives = clearLogDirectoryArchives(logsDir, activeMain);
  return {
    ok: true,
    mode: 'all',
    results,
    deletedArchives,
    cleanedAt: Date.now()
  };
}

/**
 * @param {string} userData
 * @param {{ mainLogPath?: string, retentionDays?: number, all?: boolean, mode?: string }} [opts]
 */
function cleanLogs(userData, opts = {}) {
  if (opts.all || opts.mode === 'all') {
    return clearAllLogs(userData, opts);
  }
  const days = Number(opts.retentionDays) > 0 ? Number(opts.retentionDays) : LOG_RETENTION_DAYS;
  const maxAgeMs = days * 24 * 60 * 60 * 1000;
  const sources = listLogSources(userData, opts);
  const activeMain = sources.find((s) => s.id === 'app')?.path || '';
  const results = [];

  for (const src of sources) {
    results.push(pruneLogFileByAge(src.path, maxAgeMs, src.id === 'app' ? activeMain : src.path));
  }

  const logsDir = path.join(userData, 'logs');
  const deletedArchives = pruneLogDirectoryArchives(logsDir, maxAgeMs, activeMain);

  return {
    ok: true,
    mode: 'retention',
    retentionDays: days,
    results,
    deletedArchives,
    cleanedAt: Date.now()
  };
}

/**
 * @param {string} userData
 * @param {{ maxLinesPerFile?: number }} [opts]
 */
function fetchAllLogs(userData, opts = {}) {
  const maxLines = opts.maxLinesPerFile || 500;
  const sections = listLogSources(userData, opts).map((src) => {
    const chunk = readLogTail(src.path, maxLines);
    return {
      id: src.id,
      label: src.label,
      path: src.path,
      ...chunk
    };
  });
  return {
    sections,
    fetchedAt: Date.now(),
    retentionDays: LOG_RETENTION_DAYS
  };
}

module.exports = {
  LOG_RETENTION_DAYS,
  listLogSources,
  readLogTail,
  fetchAllLogs,
  cleanLogs,
  clearAllLogs,
  filterLogContentForDisplay,
  isSqlServerLogLine
};

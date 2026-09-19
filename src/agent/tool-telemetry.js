'use strict';

const fs = require('fs');
const path = require('path');
const { getRotatingLog, flushLog, DEFAULT_MAX_BYTES } = require('../logs/rotating-file-log');

function telemetryPath(userDataPath) {
  return path.join(userDataPath || '', 'tool-telemetry.jsonl');
}

/**
 * 每次工具调用记一行。
 * 原来这里是 `appendFileSync`（一次 open+write+close 系统调用）且跑在主进程上，
 * 现在走统一闸门批写，高频工具轮次下能省掉大量 syscall。
 * @param {object} row
 */
function recordToolTelemetry(userDataPath, row) {
  if (!userDataPath) return;
  const filePath = telemetryPath(userDataPath);
  const log = getRotatingLog(filePath, { maxBytes: DEFAULT_MAX_BYTES });
  if (!log) return;
  log.write(
    `${JSON.stringify({
      ts: Date.now(),
      ...row
    })}\n`
  );
}

function summarizeTelemetry(userDataPath, limit = 200) {
  const filePath = telemetryPath(userDataPath);
  const empty = {
    windowRows: limit,
    total: 0,
    ok: 0,
    failed: 0,
    successRate: 0,
    repeatBlocks: 0,
    retries: 0,
    byTool: [],
    topErrors: [],
    rows: []
  };
  try {
    // 日志是批写的，读取前必须先刷缓冲，否则会统计到陈旧数据
    flushLog(filePath);
    const raw = fs.readFileSync(filePath, 'utf8');
    const lines = raw.trim().split('\n').slice(-limit);
    const byKey = new Map();
    const byToolMap = new Map();
    const errorMap = new Map();
    let ok = 0;
    let failed = 0;
    let repeatBlocks = 0;
    let retries = 0;

    for (const line of lines) {
      let row;
      try {
        row = JSON.parse(line);
      } catch {
        continue;
      }
      const tool = String(row.tool || '?');
      const errorCode = row.errorCode || (row.ok ? 'ok' : 'err');
      const key = `${tool}::${errorCode}`;
      byKey.set(key, (byKey.get(key) || 0) + 1);

      if (row.ok) ok += 1;
      else failed += 1;
      if (errorCode === 'REPEAT_BLOCK') repeatBlocks += 1;
      if (typeof row.attempt === 'number' && row.attempt > 0) retries += 1;

      if (!byToolMap.has(tool)) {
        byToolMap.set(tool, { tool, total: 0, ok: 0, failed: 0, repeatBlocks: 0 });
      }
      const tb = byToolMap.get(tool);
      tb.total += 1;
      if (row.ok) tb.ok += 1;
      else tb.failed += 1;
      if (errorCode === 'REPEAT_BLOCK') tb.repeatBlocks += 1;

      if (!row.ok && errorCode && errorCode !== 'err') {
        errorMap.set(errorCode, (errorMap.get(errorCode) || 0) + 1);
      }
    }

    const total = ok + failed;
    const rows = [...byKey.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .map(([k, n]) => ({ key: k, count: n }));

    const byTool = [...byToolMap.values()]
      .sort((a, b) => b.total - a.total)
      .slice(0, 12)
      .map((t) => ({
        ...t,
        successRate: t.total ? Math.round((t.ok / t.total) * 1000) / 10 : 0
      }));

    const topErrors = [...errorMap.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([errorCode, count]) => ({ errorCode, count }));

    return {
      windowRows: limit,
      total,
      ok,
      failed,
      successRate: total ? Math.round((ok / total) * 1000) / 10 : 0,
      repeatBlocks,
      retries,
      byTool,
      topErrors,
      rows
    };
  } catch {
    return empty;
  }
}

module.exports = {
  recordToolTelemetry,
  summarizeTelemetry,
  telemetryPath
};

'use strict';

const path = require('path');
const { getRotatingLog, DEFAULT_MAX_BYTES } = require('./logs/rotating-file-log');

/**
 * gateway.log。
 *
 * 原实现是「每行 statSync + 超限时读全文再截断重写 + appendFileSync」：
 * 每写入约 0.69MB 新数据就要重写 1.31MB（写放大 ≈2.9×），且全程 `*Sync`，
 * 跑在 Electron 主进程上——日志越频繁 UI 越卡。
 * 现在交由 logs/rotating-file-log.js 做批写 + rename 轮转：
 * 轮转是 O(1) 的 rename，不再有读-改-写放大，也不再有逐行 statSync。
 *
 * @param {string} readableDir
 * @param {(msg: string) => void} [forwardLog]
 */
function createGatewayFileLogger(readableDir, forwardLog) {
  const logPath = path.join(String(readableDir || ''), 'gateway.log');
  const log = getRotatingLog(logPath, { maxBytes: DEFAULT_MAX_BYTES });

  return (msg) => {
    const text = String(msg == null ? '' : msg);
    if (forwardLog) forwardLog(text);
    if (!log) return;
    log.write(`[${new Date().toISOString()}] ${text}\n`);
  };
}

module.exports = { createGatewayFileLogger };

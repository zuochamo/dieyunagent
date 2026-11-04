'use strict';

/**
 * headless 入口的日志：**只写 stderr**，一条一行。
 *
 * 为什么不复用 `electron-log`：它绑 Electron 的路径与生命周期，纯 Node 入口拿不到。
 * 也不往 stdout 写：`--json` 模式下 stdout 是给脚本消费的事件流，日志混进去就没法 parse。
 *
 * 返回的是「函数 + 分级方法」的混合对象：本仓既有依赖有的按 `log(msg)` 调
 * （频道 / 工具桥），有的按 `log.info(msg)` / `log.warn(msg)` 调（MCP / 计划装配），
 * 一种形状同时满足两边，免得各处包一层适配。
 */

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };

function normalizeLevel(level) {
  const v = String(level || '').trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(LEVELS, v) ? v : 'info';
}

/**
 * @param {{ level?: string, stream?: { write: (s: string) => any }, prefix?: string, now?: () => Date }} [opts]
 */
function createLogger(opts = {}) {
  const threshold = LEVELS[normalizeLevel(opts.level)];
  const stream = opts.stream || process.stderr;
  const prefix = String(opts.prefix || 'dieyun-headless');
  const now = typeof opts.now === 'function' ? opts.now : () => new Date();

  function write(level, msg) {
    if (LEVELS[level] > threshold) return;
    const text = msg == null ? '' : typeof msg === 'string' ? msg : String(msg);
    const line = `[${prefix}] ${now().toISOString()} ${level.toUpperCase()} ${text}\n`;
    try {
      stream.write(line);
    } catch {
      // 日志写不出去（管道断开等）不能反过来把进程打挂
    }
  }

  /** @type {any} */
  const log = (msg) => write('info', msg);
  log.error = (msg) => write('error', msg);
  log.warn = (msg) => write('warn', msg);
  log.info = (msg) => write('info', msg);
  log.debug = (msg) => write('debug', msg);
  log.level = normalizeLevel(opts.level);
  log.isDebug = () => threshold >= LEVELS.debug;
  return log;
}

module.exports = { createLogger, normalizeLevel, LEVELS };

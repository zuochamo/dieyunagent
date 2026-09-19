'use strict';

const fs = require('fs');
const path = require('path');

/**
 * 统一的落盘闸门：任何「会持续增长的日志文件」都必须走这里。
 *
 * 背景：仓库里原本有四条落盘流（集成终端、gateway.log、tool-telemetry、plans-logs），
 * 其中两条写了 2MB 上限 + 轮转、两条完全没有——而恰好量级最大的两条（终端、plans）漏了。
 * 四份各自为政的实现意味着「新加一条日志流」能不能记得加上限全靠自觉。
 *
 * 这里把四件事收敛成唯一实现：
 *  - 批写节流：写入先进内存缓冲，按 flushIntervalMs 合并成一次 append。
 *    顺带消掉原来「每行一次 statSync + appendFileSync」的主进程阻塞与 syscall 放大。
 *  - 轮转：超限时把文件 rename 成 `.1`（单份备份）。**不做读全文再重写**——
 *    那会让每写 0.69MB 就重写 1.31MB，写放大接近 3 倍。
 *  - 熔断：缓冲超过 maxBufferChars 时丢弃最旧的部分、保留最新尾部。
 *    终端里跑一次 verbose 构建可以瞬间喷出几十 MB，没有这层兜底缓冲会直接吃满内存。
 *  - 失败不抛：日志写不下去绝不能反过来打断主流程。
 */

const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const DEFAULT_BACKUPS = 1;
const DEFAULT_FLUSH_MS = 250;
const DEFAULT_MAX_BUFFER_CHARS = 256 * 1024;

/** @type {Map<string, ReturnType<typeof createRotatingLog>>} */
const registry = new Map();
let exitHookBound = false;

function createRotatingLog(opts = {}) {
  const rawPath = String(opts.filePath || '').trim();
  if (!rawPath) throw new Error('createRotatingLog 需要 filePath');
  const filePath = path.resolve(rawPath);
  const maxBytes = Math.max(1024, Number(opts.maxBytes) || DEFAULT_MAX_BYTES);
  const backups = Math.max(1, Math.floor(Number(opts.backups) || DEFAULT_BACKUPS));
  const flushMs = Math.max(0, Number(opts.flushIntervalMs ?? DEFAULT_FLUSH_MS));
  const maxBufferChars = Math.max(1024, Number(opts.maxBufferChars) || DEFAULT_MAX_BUFFER_CHARS);

  let buffer = '';
  let droppedChars = 0;
  let flushing = false;
  let closed = false;
  /** @type {NodeJS.Timeout|null} */
  let timer = null;

  function rotateIfNeeded() {
    let size;
    try {
      size = fs.statSync(filePath).size;
    } catch {
      return; // 文件尚不存在
    }
    if (size <= maxBytes) return;
    try {
      for (let i = backups; i >= 1; i -= 1) {
        const dst = `${filePath}.${i}`;
        if (i === backups && fs.existsSync(dst)) fs.unlinkSync(dst);
        const src = i === 1 ? filePath : `${filePath}.${i - 1}`;
        if (fs.existsSync(src)) fs.renameSync(src, dst);
      }
    } catch {
      // 轮转失败也要能继续写：日志缺失比日志超限更难排查
    }
  }

  function appendSync(chunk) {
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      rotateIfNeeded();
      fs.appendFileSync(filePath, chunk, 'utf8');
    } catch {
      // ignore
    }
  }

  /** 立刻同步落盘（读日志前、进程退出前必须调用，否则读到的是旧内容） */
  function flushSync() {
    if (!buffer) return;
    const chunk = buffer;
    buffer = '';
    appendSync(chunk);
  }

  function flush() {
    if (closed || flushing || !buffer) return;
    flushing = true;
    const chunk = buffer;
    buffer = '';
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
    } catch {
      // 目录建不出来时交给 appendFile 自行失败
    }
    rotateIfNeeded();
    fs.appendFile(filePath, chunk, 'utf8', () => {
      flushing = false;
      if (buffer) flush();
    });
  }

  function scheduleFlush() {
    if (flushMs <= 0) {
      flush();
      return;
    }
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      flush();
    }, flushMs);
    // 日志缓冲不该拖住进程退出
    if (typeof timer.unref === 'function') timer.unref();
  }

  function write(text) {
    if (closed) return;
    const chunk = String(text == null ? '' : text);
    if (!chunk) return;
    buffer += chunk;
    if (buffer.length > maxBufferChars) {
      // 熔断：保留最新尾部。排障关心的是「刚刚发生了什么」，
      // 而且在无上限的 PTY 输出面前，裁掉头部是唯一能让写入有界的方式。
      droppedChars += buffer.length - maxBufferChars;
      buffer = buffer.slice(-maxBufferChars);
    }
    scheduleFlush();
  }

  function close() {
    if (closed) return;
    closed = true;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    flushSync();
  }

  function stats() {
    let size = 0;
    try {
      size = fs.statSync(filePath).size;
    } catch {
      size = 0;
    }
    return {
      filePath,
      size,
      maxBytes,
      pendingChars: buffer.length,
      droppedChars
    };
  }

  return { write, flush, flushSync, close, stats, filePath };
}

/**
 * 按路径复用实例。
 * 同一个日志文件在进程内只能有一个缓冲实例，否则「批写」会退化成两股写入互相交错。
 * @param {string} filePath
 * @param {object} [opts]
 */
function getRotatingLog(filePath, opts = {}) {
  const key = path.resolve(String(filePath || ''));
  if (!key) return null;
  let inst = registry.get(key);
  if (!inst) {
    inst = createRotatingLog({ ...opts, filePath: key });
    registry.set(key, inst);
  }
  bindExitFlush();
  return inst;
}

/** 读日志前调用：把缓冲刷下去，否则会读到过期内容 */
function flushLog(filePath) {
  const key = path.resolve(String(filePath || ''));
  const inst = registry.get(key);
  if (!inst) return false;
  inst.flushSync();
  return true;
}

function closeLog(filePath) {
  const key = path.resolve(String(filePath || ''));
  const inst = registry.get(key);
  if (!inst) return false;
  inst.close();
  registry.delete(key);
  return true;
}

function bindExitFlush() {
  if (exitHookBound) return;
  exitHookBound = true;
  try {
    // exit 回调必须是同步的，所以这里用 flushSync
    process.on('exit', () => {
      for (const inst of registry.values()) inst.flushSync();
    });
  } catch {
    // 某些受限环境不允许挂 exit，忽略即可
  }
}

module.exports = {
  createRotatingLog,
  getRotatingLog,
  flushLog,
  closeLog,
  DEFAULT_MAX_BYTES
};

'use strict';

/**
 * 从可读流里读**至多 limit 字节**，够数立刻停流。
 *
 * 为什么单独一个模块：SFTP 的 `createReadStream` 按 ~64KB 一块交付，旧实现在 data 回调里
 * 「累加后再判断是否超 limit」，于是跨过 limit 的那一整块被丢掉 —— `maxBytes=4096` 读一个
 * 1MB 的文件会返回**空内容**（第一块 64KB 就超限）。而且到点不停流，只读 2MB 也要把整个文件
 * 走完 SFTP，最后撞上层超时。两件事都必须在这里一次解决：精确切片 + 够数即 destroy。
 *
 * 不依赖 ssh2，便于单测：任何 EventEmitter 形状的流都能跑（data/end/error + destroy）。
 *
 * @param {import('events').EventEmitter & { destroy?: () => void }} stream
 * @param {number} limit 最多读取的字节数（>0）
 * @returns {Promise<{ buf: Buffer, read: number, truncated: boolean }>}
 *   read = 实际收到的字节数（可 ≥ limit）；truncated = 因为到限而提前截断
 */
function readLimitedFromStream(stream, limit) {
  const cap = Math.max(1, Math.floor(Number(limit) || 1));
  return new Promise((resolve, reject) => {
    const chunks = [];
    let read = 0;
    let settled = false;

    const stopStream = () => {
      try {
        if (typeof stream.destroy === 'function') stream.destroy();
        else if (typeof stream.close === 'function') stream.close();
      } catch {
        // 停流失败不影响「已经拿到的字节」
      }
    };

    const cleanup = () => {
      stream.removeListener('data', onData);
      stream.removeListener('end', onEnd);
      stream.removeListener('error', onError);
      stream.removeListener('close', onClose);
    };

    const settle = (truncated) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ buf: Buffer.concat(chunks), read, truncated });
    };

    const fail = (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };

    function onData(chunk) {
      if (settled) return;
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
      const need = cap - read;
      if (need <= 0) {
        stopStream();
        settle(true);
        return;
      }
      // 关键：跨过上限的那一块要**切**，不能整块丢
      chunks.push(need >= buf.length ? buf : buf.subarray(0, need));
      read += Math.min(need, buf.length);
      if (read >= cap) {
        stopStream();
        settle(true);
      }
    }

    function onEnd() {
      settle(read >= cap);
    }

    function onClose() {
      // 有些实现不发 end 只发 close（例如被对端关掉）：按已读到的内容收尾
      settle(read >= cap);
    }

    function onError(err) {
      fail(err);
    }

    stream.on('data', onData);
    stream.on('end', onEnd);
    stream.on('error', onError);
    stream.on('close', onClose);
  });
}

module.exports = { readLimitedFromStream };

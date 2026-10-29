'use strict';

const { EXEC_OUTPUT_MAX_CHARS } = require('./exec-limits');

/**
 * 「一条命令什么时候算结束」的唯一判定（本机 spawn 与远程 exec 共用）。
 *
 * 只等 `close` 是不够的：`close` 的语义是「输出管道全关了」，而命令自己拉起的后台进程
 * （`cmd &` / nohup / setsid / daemon）会继承这条管道 —— 管道不关，事件就不来。
 * 于是一条「其实已经跑完」的命令要等到 timeout，把「已启动」报成失败
 * （issue/issue-host-exec-background-timeout.md；本机 POSIX 侧同源）。
 *
 * 判定顺序（先到先得）：
 *   1. `close` —— 正常收尾，用 close 带的 exit code；
 *   2. 收到 exit-status（`exit` 事件）后静默 quietMs —— 后台进程仍握着管道时走这条；
 *      静默窗口每来一段输出就重置，保证 exit 之后仍在途的尾部输出读干净
 *      （实测 ssh `seq 1 300000`：exit 时只收到 1.37MB/1.99MB，尾部数据在 exit 之后才到）；
 *   3. 都不来 —— 命令链真的还在前台跑，由调用方的 timeout 兜底。
 *
 * 调用方自己决定收尾动作（SSH 关 channel 释放资源；本机什么也不用做，
 * 输出缓冲本身有上限，后台进程后续输出仍可经 host_proc 读）。
 */

/** exit-status 之后等待尾部输出的静默窗口（毫秒）。 */
const EXIT_QUIET_MS = 400;

/**
 * @param {{
 *   out?: import('events').EventEmitter | null,   // stdout 数据源（emit 'data'）
 *   err?: import('events').EventEmitter | null,   // stderr 数据源
 *   life: import('events').EventEmitter            // 生命周期源（emit 'exit' / 'close' / 'error'）
 * }} sources
 * @param {{ quietMs?: number, accumulate?: boolean, onSettle?: (settledBy: 'close' | 'exit') => void, maxChars?: number }} [opts]
 *   accumulate=true 时把输出收进返回值（远程 exec 用；本机 runShell 自己有带上限的缓冲，不重复收）
 *   onSettle 在 resolve 之前调用，供调用方释放资源
 * @returns {Promise<{ code: number | null, settledBy: 'close' | 'exit', stdout?: string, stderr?: string, truncated?: boolean, droppedChars?: number }>}
 */
function attachExecSettlement(sources, opts = {}) {
  const quietMs = Math.max(50, Number(opts.quietMs) || EXIT_QUIET_MS);
  const accumulate = opts.accumulate === true;
  const maxChars = Math.max(1024, Number(opts.maxChars) || EXEC_OUTPUT_MAX_CHARS);
  const onSettle = typeof opts.onSettle === 'function' ? opts.onSettle : null;
  const out = sources && sources.out ? sources.out : null;
  const err = sources && sources.err ? sources.err : null;
  const life = sources && sources.life ? sources.life : null;

  return new Promise((resolve, reject) => {
    /**
     * 累加器用**带 stream 的解码器**逐块解 UTF-8：ssh2 的 data 以 32KB 包按字节边界交付，
     * 每个包单独 `toString()` 会把被切开的汉字/emoji 解成 U+FFFD（远端 openShell 早已这么修，
     * 这里漏了）。超上限时丢头部留尾部 —— 长任务的报错与进度都在尾部。
     */
    const decoder = new TextDecoder('utf-8');
    const makeSink = () => ({ text: '', total: 0, dropped: 0 });
    const sinks = { stdout: makeSink(), stderr: makeSink() };
    const append = (key, chunk) => {
      if (!accumulate) return;
      const text = typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
      if (!text) return;
      const sink = sinks[key];
      sink.total += text.length;
      let next = sink.text + text;
      if (next.length > maxChars) {
        sink.dropped += next.length - maxChars;
        next = next.slice(-maxChars);
      }
      sink.text = next;
    };
    let exitCode = null;
    let sawExit = false;
    let done = false;
    let quietTimer = null;

    const stopListening = () => {
      clearTimeout(quietTimer);
      if (out && typeof out.removeListener === 'function') out.removeListener('data', onStdout);
      if (err && typeof err.removeListener === 'function') err.removeListener('data', onStderr);
    };

    const finish = (settledBy) => {
      if (done) return;
      done = true;
      stopListening();
      // 把解码器里剩下的半个字符冲出来（被截断的尾字节按 U+FFFD 表示，至少不是静默丢失）
      if (accumulate) {
        for (const key of ['stdout', 'stderr']) {
          const tail = decoder.decode();
          if (tail) append(key, tail);
        }
      }
      if (onSettle) {
        try {
          onSettle(settledBy);
        } catch {
          // 释放资源失败不该改变「命令已结束」这个结论
        }
      }
      const result = { code: exitCode, settledBy };
      if (accumulate) {
        result.stdout = sinks.stdout.text;
        result.stderr = sinks.stderr.text;
        const dropped = sinks.stdout.dropped + sinks.stderr.dropped;
        result.truncated = dropped > 0;
        if (dropped > 0) result.droppedChars = dropped;
      }
      resolve(result);
    };

    const armQuiet = () => {
      clearTimeout(quietTimer);
      quietTimer = setTimeout(() => finish('exit'), quietMs);
    };

    function onStdout(chunk) {
      append('stdout', chunk);
      if (sawExit) armQuiet();
    }

    function onStderr(chunk) {
      append('stderr', chunk);
      if (sawExit) armQuiet();
    }

    if (out) out.on('data', onStdout);
    if (err) err.on('data', onStderr);
    if (!life) {
      reject(new Error('attachExecSettlement 缺少 life 源'));
      return;
    }
    life.on('exit', (code) => {
      sawExit = true;
      exitCode = code == null ? null : code;
      armQuiet();
    });
    life.on('close', (code) => {
      if (code != null) exitCode = code;
      finish('close');
    });
    life.on('error', (e) => {
      // 已拿到 exit-status 说明命令本身跑完了，之后的通道错误不影响结论
      if (done || sawExit) return;
      done = true;
      stopListening();
      reject(e);
    });
  });
}

module.exports = { attachExecSettlement, EXIT_QUIET_MS };

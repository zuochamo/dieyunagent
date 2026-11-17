// @ts-check
'use strict';

const { spawn } = require('child_process');
const {
  DEFAULT_TIMEOUT_MS,
  SLOW_RPC_LOG_MS,
  resolveCoreRpcTimeoutMs
} = require('./core-rpc-timeouts');

/**
 * @typedef {object} CoreBridgeOptions
 * @property {string} binaryPath
 * @property {(msg: string) => void} [log]
 */

/**
 * dieyun-core stdio JSON-RPC 客户端（Main 进程 sidecar）。
 */

/**
 * SIGTERM 后等 core 自行退出的上限，超过才 SIGKILL。
 * 索引 / embedding 批次是阻塞调用，响应信号需要时间；2s 太紧，会把「正常收尾」
 * 变成日志里的 signal=SIGKILL，让人误判成崩溃/OOM。
 */
const STOP_GRACE_MS = 5000;

/**
 * dieyun-core stdio JSON-RPC 客户端（Main 进程 sidecar）
 */
function createCoreBridge(opts) {
  const binaryPath = opts.binaryPath;
  const args = Array.isArray(opts.args) && opts.args.length ? opts.args : ['serve-stdio'];
  const extraEnv = opts.env && typeof opts.env === 'object' ? opts.env : {};
  const pingTimeoutMs =
    Number(opts.pingTimeoutMs) > 0 ? Number(opts.pingTimeoutMs) : 15000;
  // 未注入时退回 console.warn：**不能是 noop**。
  // 曾经默认 noop + RPC_TIMEOUT 硬写 console.warn ⇒ GUI 打包后（无 stdout）
  // 「dieyun-core 的请求超时了」这件事在 main.log 里一行都看不到，排查时只能猜。
  const log =
    typeof opts.log === 'function'
      ? opts.log
      : (msg) => {
          try {
            console.warn(msg);
          } catch {
            /* ignore */
          }
        };

  /** @type {import('child_process').ChildProcess | null} */
  let proc = null;
  let ready = false;
  let nextId = 1;
  /** @type {Map<number, { resolve: Function, reject: Function, timer: NodeJS.Timeout, method: string, runId: string|null, startedAt: number }>} */
  const pending = new Map();
  /** @type {Set<(event: object) => void>} core 主动推来的事件（流式增量等）订阅者 */
  const eventListeners = new Set();
  /** core 反向调用（type:call）的 handler 表：method -> (params) => any */
  const coreCallHandlers = new Map();
  let stdoutBuffer = '';
  let stderrBuffer = '';
  let stderrTail = '';
  let lastExitCode = null;
  let lastExitSignal = null;

  function noteStderr(chunk) {
    const s = String(chunk || '');
    stderrTail += s;
    if (stderrTail.length > 8192) stderrTail = stderrTail.slice(-8192);
  }

  function coreDiedMessage(prefix) {
    const bits = [prefix || 'dieyun-core 已退出'];
    if (lastExitCode != null || lastExitSignal) {
      bits.push(`code=${lastExitCode == null ? '' : lastExitCode} signal=${lastExitSignal || ''}`);
    }
    const tail = String(stderrTail || '')
      .trim()
      .split(/\r?\n/)
      .slice(-12)
      .join('\n')
      .trim();
    if (tail) bits.push(tail);
    return bits.join('\n').replace(/`/g, "'");
  }
  /** 注册一个反向调用 handler（core 主动调宿主）。返回取消注册函数。 */
  function onCoreCall(method, handler) {
    if (typeof handler !== 'function') return () => {};
    coreCallHandlers.set(String(method), handler);
    return () => {
      coreCallHandlers.delete(String(method));
    };
  }

  function isReady() {
    return ready && proc && !proc.killed;
  }

  /**
   * 订阅 core 主动推来的事件（流式增量等）。返回取消订阅函数。
   *
   * 事件带 `runId`，订阅方自行过滤：一个 core 进程服务整个宿主，事件是进程级的。
   */
  function onCoreEvent(listener) {
    if (typeof listener !== 'function') return () => {};
    eventListeners.add(listener);
    return () => {
      eventListeners.delete(listener);
    };
  }

  function extractRunId(params) {
    if (!params || typeof params !== 'object') return null;
    const rid = params.runId != null ? params.runId : params.run_id;
    const s = rid != null ? String(rid).trim() : '';
    return s || null;
  }

  /** @typedef {Error & { code?: string }} CodedError 带错误码的 Error（协议错误码 / errno） */
  /** @returns {CodedError} */
  function createCoreAbortError(reason) {
    /** @type {CodedError} */
    const err = new Error(reason || '已停止');
    err.name = 'AbortError';
    err.code = 'CORE_RPC_CANCELLED';
    return err;
  }

  function writeFireAndForget(method, params) {
    if (!proc || !proc.stdin || proc.killed || proc.stdin.destroyed) return;
    try {
      const cancelId = nextId++;
      const cancelPayload =
        JSON.stringify({ id: cancelId, method, params: params || {} }) + '\n';
      proc.stdin.write(cancelPayload);
    } catch {
      // ignore
    }
  }

  function bestEffortCancelForMethod(method, runId, requestId) {
    if (!runId) return;
    if (/^planner\.run\./.test(String(method))) {
      writeFireAndForget('planner.run.cancel', { runId });
      return;
    }
    if (/^agent\.loop\./.test(String(method))) {
      writeFireAndForget('agent.run.cancel', { runId });
    }
  }

  /**
   * 协议级取消：立即 settle 匹配的 pending invoke，并向 core 发送 cancel。
   * @param {{ runId?: string, ids?: number[], reason?: string, methods?: string[] }} [opts]
   *   `methods`：只 settle 这些方法名的在途调用（宿主停止时按方法过滤；不传=按 runId/ids 匹配）
   * @returns {{ abortedIds: number[], runId: string|null, runIds: string[] }}
   */
  function abortPending(opts = {}) {
    const runId = opts.runId != null ? String(opts.runId).trim() : '';
    const idSet =
      Array.isArray(opts.ids) && opts.ids.length
        ? new Set(opts.ids.map((x) => Number(x)).filter((n) => Number.isFinite(n)))
        : null;
    if (!runId && !idSet) {
      return { abortedIds: [], runId: null, runIds: [] };
    }
    const methodSet =
      Array.isArray(opts.methods) && opts.methods.length
        ? new Set(opts.methods.map((m) => String(m)))
        : null;
    const reason = opts.reason || '已停止';
    const abortedIds = [];
    const runIdsTouched = new Set();
    for (const [id, entry] of [...pending.entries()]) {
      const matchId = idSet ? idSet.has(id) : false;
      const matchRun = !!(runId && entry.runId && entry.runId === runId);
      const matchMethod = !methodSet || methodSet.has(String(entry.method || ''));
      const shouldAbort = idSet && runId ? matchId || matchRun : idSet ? matchId : matchRun;
      if (!shouldAbort || !matchMethod) continue;
      clearTimeout(entry.timer);
      pending.delete(id);
      abortedIds.push(id);
      if (entry.runId) runIdsTouched.add(entry.runId);
      try {
        entry.reject(createCoreAbortError(reason));
      } catch {
        // ignore
      }
      bestEffortCancelForMethod(
        entry.method,
        methodSet ? null : entry.runId || runId || null,
        id
      );
    }
    if (runId && !methodSet) {
      runIdsTouched.add(runId);
      writeFireAndForget('rpc.cancel', { runId, ids: abortedIds });
      writeFireAndForget('agent.run.cancel', { runId });
      writeFireAndForget('planner.run.cancel', { runId });
    } else if (abortedIds.length) {
      writeFireAndForget('rpc.cancel', { ids: abortedIds });
    }
    return { abortedIds, runId: runId || null, runIds: [...runIdsTouched] };
  }

  function rejectAll(reason) {
    for (const [id, entry] of pending.entries()) {
      clearTimeout(entry.timer);
      entry.reject(reason);
      pending.delete(id);
    }
  }

  function onStdoutChunk(chunk) {
    stdoutBuffer += String(chunk || '');
    let idx;
    while ((idx = stdoutBuffer.indexOf('\n')) >= 0) {
      const line = stdoutBuffer.slice(0, idx).trim();
      stdoutBuffer = stdoutBuffer.slice(idx + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        log(`dieyun-core 无效 JSON: ${line.slice(0, 200)}`);
        continue;
      }
      // core → 宿主的**反向调用**（`type:"call"`）：请求 + 答复，答复写回 stdin。
      // 与事件同一条分流规则，只是这里要回话。
      if (msg && msg.type === 'call') {
        const callId = msg.id;
        const method = String(msg.method || '');
        const handler = coreCallHandlers.get(method);
        const reply = (payload) => {
          if (!proc || !proc.stdin || proc.stdin.destroyed) return;
          try {
            proc.stdin.write(`${JSON.stringify({ type: 'reply', id: callId, ...payload })}\n`);
          } catch {
            /* 宿主已退出：core 侧按超时收场 */
          }
        };
        if (!handler) {
          reply({ error: { code: 'HOST_CALL_UNSUPPORTED', message: `宿主未实现 ${method}` } });
          continue;
        }
        Promise.resolve()
          .then(() => handler(msg.params || {}))
          .then((result) => reply({ result: result == null ? null : result }))
          .catch((e) =>
            reply({ error: { code: 'HOST_CALL_FAILED', message: String((e && e.message) || e) } })
          );
        continue;
      }
      // core → 宿主的事件（流式增量等）：带 `type:"event"`，不是任何请求的响应。
      // 与响应共用 stdout，靠 `type` 分流；未订阅时静默丢弃（例如 `dieyun-core index`）。
      if (msg && msg.type === 'event') {
        const event = msg.event || {};
        for (const listener of eventListeners) {
          try {
            listener(event);
          } catch (e) {
            log(`core event listener 抛错: ${e && e.message ? e.message : e}`);
          }
        }
        continue;
      }
      const id = Number(msg.id);
      const entry = pending.get(id);
      if (!entry) continue;
      clearTimeout(entry.timer);
      pending.delete(id);
      // 端到端慢请求落日志：与 core 自己打的 `[rpc-slow]` 一比，就能分清
      // 「core 内部慢」还是「RPC 堵在管道 / 守护进程 / SSH 里」。
      // 口径 2000ms 与 Rust 侧 `rpc::SLOW_RPC_LOG_MS` 同值（跨语言无法共享常量，
      // 改一个必须改另一个，见 docs/LOGGING.md）。
      const elapsedMs = Date.now() - entry.startedAt;
      if (elapsedMs >= SLOW_RPC_LOG_MS) {
        log(`[dieyun:core] RPC_SLOW ${entry.method} ${elapsedMs}ms (id=${id})`);
      }
      if (msg.error) {
        /** @type {CodedError} */
        const err = new Error(msg.error.message || 'rust core error');
        err.code = msg.error.code || 'RUST_CORE_ERROR';
        entry.reject(err);
      } else {
        entry.resolve(msg.result);
      }
    }
  }

  function handleProcStreamError(label, err) {
    if (!err) return;
    if (err.code === 'EPIPE') {
      log(`dieyun-core ${label} 已关闭 (EPIPE)`);
      return;
    }
    log(`dieyun-core ${label} 错误: ${err.message || err}`);
  }

  async function start() {
    if (proc) return;
    lastExitCode = null;
    lastExitSignal = null;
    stderrTail = '';
    const childEnv = { ...process.env, ...extraEnv };
    if (process.platform !== 'win32') {
      delete childEnv.APPDATA;
    }
    proc = spawn(binaryPath, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: childEnv
    });

    proc.stdout.setEncoding('utf8');
    proc.stderr.setEncoding('utf8');
    proc.stdout.on('data', onStdoutChunk);
    proc.stderr.on('data', (buf) => {
      noteStderr(buf);
      stderrBuffer += String(buf || '');
      let idx;
      while ((idx = stderrBuffer.indexOf('\n')) >= 0) {
        const line = stderrBuffer.slice(0, idx).replace(/\r$/, '').trim();
        stderrBuffer = stderrBuffer.slice(idx + 1);
        if (!line) continue;
        log(`dieyun-core: ${line}`);
      }
    });
    if (proc.stdin) {
      proc.stdin.on('error', (err) => handleProcStreamError('stdin', err));
    }
    proc.stdout.on('error', (err) => handleProcStreamError('stdout', err));
    proc.stderr.on('error', (err) => handleProcStreamError('stderr', err));
    proc.on('error', (err) => {
      log(`dieyun-core 进程错误: ${err.message || err}`);
      ready = false;
      rejectAll(err);
    });
    proc.on('exit', (code, signal) => {
      lastExitCode = code;
      lastExitSignal = signal || null;
      log(`dieyun-core 退出 code=${code} signal=${signal || ''}`);
      ready = false;
      const stdin = proc && proc.stdin;
      if (stdin && !stdin.destroyed) {
        try {
          stdin.destroy();
        } catch {
          // ignore
        }
      }
      proc = null;
      rejectAll(new Error(coreDiedMessage('dieyun-core 已退出')));
    });

    try {
      await invoke('core.ping', {}, pingTimeoutMs);
      ready = true;
    } catch (err) {
      ready = false;
      const child = proc;
      proc = null;
      /** @type {CodedError} */
      const wrapped = new Error(coreDiedMessage((err && err.message) || 'dieyun-core 启动失败'));
      wrapped.code = err && err.code ? err.code : 'CORE_START_FAILED';
      rejectAll(wrapped);
      if (child && !child.killed) {
        try {
          child.kill('SIGTERM');
        } catch {
          // ignore
        }
      }
      throw wrapped;
    }
  }

  async function stop() {
    ready = false;
    rejectAll(new Error('dieyun-core 已停止'));
    if (!proc) return;
    const child = proc;
    proc = null;
    // 已退出的子进程不会再发 exit 事件，等满 grace 纯属空等——「core 已死→重启」
    // 这条重试路径上每次 stop() 都会踩到它。
    if (child.exitCode != null || child.signalCode != null) return;
    try {
      child.kill('SIGTERM');
    } catch {
      // ignore
    }
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        // 必须留痕：日志里的 signal=SIGKILL 到底是「自己人兜底强杀」还是「被外部杀掉」，
        // 是排查 remote index 事故的第一分歧点，不能靠猜。
        log(`dieyun-core 未响应 SIGTERM（${STOP_GRACE_MS}ms），强制 SIGKILL`);
        try {
          child.kill('SIGKILL');
        } catch {
          // ignore
        }
        resolve();
      }, STOP_GRACE_MS);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  /**
   * @param {{ data_dir?: string, workspace_roots?: string[] }} params
   */
  async function configure(params) {
    if (!proc || proc.killed) return { ok: false, reason: 'not_running' };
    return invoke('core.configure', params || {}, 30000);
  }

  /**
   * @param {string} method
   * @param {object} [params]
   * @param {number} [timeoutMs]
   */
  function invoke(method, params, timeoutMs) {
    if (!proc || !proc.stdin || proc.killed || proc.exitCode != null) {
      return Promise.reject(new Error('dieyun-core 未启动'));
    }
    const id = nextId++;
    const timeout = resolveCoreRpcTimeoutMs(method, timeoutMs);
    const payload = JSON.stringify({ id, method, params: params || {} }) + '\n';
    const runId = extractRunId(params);

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const entry = pending.get(id);
        pending.delete(id);
        if (entry && entry.timer) clearTimeout(entry.timer);
        // 走注入的 log 通道（main.log），不再只 console.warn：
        // 「core 请求超时」是判断「run 为什么不动」的第一线索，必须落盘。
        log(`[dieyun:core] RPC_TIMEOUT ${method} id=${id} timeoutMs=${timeout}`);
        bestEffortCancelForMethod(method, runId, id);
        /** @type {CodedError} */
        const err = new Error(`dieyun-core 超时: ${method}`);
        err.code = 'CORE_RPC_TIMEOUT';
        reject(err);
      }, timeout);
      pending.set(id, { resolve, reject, timer, method: String(method || ''), runId, startedAt: Date.now() });
      const stdin = proc.stdin;
      if (!stdin || proc.killed || proc.exitCode != null || stdin.destroyed || stdin.writableEnded) {
        clearTimeout(timer);
        pending.delete(id);
        reject(new Error('dieyun-core 未启动'));
        return;
      }
      try {
        stdin.write(payload, (/** @type {NodeJS.ErrnoException} */ err) => {
          if (err) {
            clearTimeout(timer);
            pending.delete(id);
            if (err.code === 'EPIPE') {
              reject(new Error(coreDiedMessage('dieyun-core 已退出')));
            } else {
              reject(err);
            }
          }
        });
      } catch (err) {
        clearTimeout(timer);
        pending.delete(id);
        if (err && err.code === 'EPIPE') {
          reject(new Error(coreDiedMessage('dieyun-core 已退出')));
        } else {
          reject(err);
        }
      }
    });
  }

  return {
    start,
    stop,
    configure,
    invoke,
    abortPending,
    isReady,
    onCoreEvent,
    onCoreCall
  };
}

module.exports = {
  createCoreBridge
};

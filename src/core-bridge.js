'use strict';

const { spawn } = require('child_process');
const {
  DEFAULT_TIMEOUT_MS,
  resolveCoreRpcTimeoutMs
} = require('./core-rpc-timeouts');

/**
 * @typedef {object} CoreBridgeOptions
 * @property {string} binaryPath
 * @property {(msg: string) => void} [log]
 * @property {(evt: { method: string, params?: object }) => void} [onNotify]
 */

/**
 * 解析 dieyun-core stderr 中的压缩 LLM 进度行，供思考区展示。
 * @param {string} line
 * @returns {{ method: string, params: object } | null}
 */
function parseCompactionLlmLogLine(line) {
  const t = String(line || '').trim();
  if (!t.includes('[compaction-llm]')) return null;
  const retry = t.match(
    /\[compaction-llm\]\s*transient error,\s*retry in\s*(\d+)ms\s*\(attempt\s*(\d+)\):\s*(.*)$/i
  );
  if (retry) {
    return {
      method: 'compaction.progress',
      params: {
        kind: 'llm_retry',
        waitMs: Number(retry[1]) || 0,
        attempt: Number(retry[2]) || 0,
        message: String(retry[3] || '').trim()
      }
    };
  }
  const skip = t.match(/\[compaction-llm\]\s*skip compaction after LLM failure:\s*(.*)$/i);
  if (skip) {
    return {
      method: 'compaction.progress',
      params: {
        kind: 'llm_skip',
        message: String(skip[1] || '').trim()
      }
    };
  }
  return {
    method: 'compaction.progress',
    params: {
      kind: 'llm_log',
      message: t.replace(/^.*\[compaction-llm\]\s*/i, '').trim() || t
    }
  };
}

/**
 * dieyun-core stdio JSON-RPC 客户端（Main 进程 sidecar）
 */
function createCoreBridge(opts) {
  const binaryPath = opts.binaryPath;
  const args = Array.isArray(opts.args) && opts.args.length ? opts.args : ['serve-stdio'];
  const extraEnv = opts.env && typeof opts.env === 'object' ? opts.env : {};
  const pingTimeoutMs =
    Number(opts.pingTimeoutMs) > 0 ? Number(opts.pingTimeoutMs) : 15000;
  const log = typeof opts.log === 'function' ? opts.log : () => {};
  const onNotify = typeof opts.onNotify === 'function' ? opts.onNotify : null;

  /** @type {import('child_process').ChildProcess | null} */
  let proc = null;
  let ready = false;
  let nextId = 1;
  /** @type {Map<number, { resolve: Function, reject: Function, timer: NodeJS.Timeout, method: string, runId: string|null }>} */
  const pending = new Map();
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
  function isReady() {
    return ready && proc && !proc.killed;
  }

  function extractRunId(params) {
    if (!params || typeof params !== 'object') return null;
    const rid = params.runId != null ? params.runId : params.run_id;
    const s = rid != null ? String(rid).trim() : '';
    return s || null;
  }

  function createCoreAbortError(reason) {
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
    if (String(method) === 'compaction.maybe_compact') {
      const ids = Number.isFinite(Number(requestId)) ? [Number(requestId)] : [];
      writeFireAndForget('rpc.cancel', { ids });
      return;
    }
    if (!runId) return;
    if (/^planner\.run\./.test(String(method))) {
      writeFireAndForget('planner.run.cancel', { runId });
      return;
    }
    if (/^agent\.loop\./.test(String(method))) {
      writeFireAndForget('agent.loop.cancel', { runId });
    }
  }

  /**
   * 协议级取消：立即 settle 匹配的 pending invoke，并向 core 发送 cancel。
   * @param {{ runId?: string, ids?: number[], reason?: string }} [opts]
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
      writeFireAndForget('agent.loop.cancel', { runId });
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
      const id = Number(msg.id);
      const entry = pending.get(id);
      if (!entry) continue;
      clearTimeout(entry.timer);
      pending.delete(id);
      if (msg.error) {
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
        if (!onNotify || !line.includes('[compaction-llm]')) continue;
        try {
          const evt = parseCompactionLlmLogLine(line);
          if (evt) onNotify(evt);
        } catch {
          // ignore notify errors
        }
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
    try {
      child.kill('SIGTERM');
    } catch {
      // ignore
    }
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          // ignore
        }
        resolve();
      }, 2000);
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
        console.warn('[dieyun:core]', 'RPC_TIMEOUT', method, `id=${id}`);
        bestEffortCancelForMethod(method, runId, id);
        const err = new Error(`dieyun-core 超时: ${method}`);
        err.code = 'CORE_RPC_TIMEOUT';
        reject(err);
      }, timeout);
      pending.set(id, { resolve, reject, timer, method: String(method || ''), runId });
      const stdin = proc.stdin;
      if (!stdin || proc.killed || proc.exitCode != null || stdin.destroyed || stdin.writableEnded) {
        clearTimeout(timer);
        pending.delete(id);
        reject(new Error('dieyun-core 未启动'));
        return;
      }
      try {
        stdin.write(payload, (err) => {
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
    isReady
  };
}

module.exports = {
  createCoreBridge,
  parseCompactionLlmLogLine
};

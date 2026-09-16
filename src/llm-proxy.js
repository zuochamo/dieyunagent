'use strict';

const http = require('http');
const https = require('https');
const { URL } = require('url');

/** 建立 TCP / 等到响应 headers（慢模型生成 JSON 可能长时间无输出） */
const CONNECT_TIMEOUT_MS = Number(process.env.LLM_CONNECT_TIMEOUT_MS) || 180000;
/** 流式：headers 已到但迟迟无有效 SSE data（忽略 `: keep-alive` 假心跳） */
const STREAM_FIRST_TOKEN_TIMEOUT_MS =
  Number(process.env.LLM_FIRST_TOKEN_TIMEOUT_MS) || 180000;
/** 流式两包之间的 idle 超时（网关长生成） */
const STREAM_IDLE_TIMEOUT_MS = Number(process.env.LLM_STREAM_IDLE_TIMEOUT_MS) || 600000;
/** 单次流式请求总时长上限 */
const STREAM_TOTAL_TIMEOUT_MS = Number(process.env.LLM_STREAM_TOTAL_TIMEOUT_MS) || 1800000;

/** 是否含完整 SSE `data:` 行（keep-alive 注释 `: ...` 不算） */
function sseChunkHasDataLine(text, lineCarry) {
  let buf = String(lineCarry || '') + String(text || '');
  const lines = buf.split(/\r?\n/);
  const rest = lines.pop() || '';
  let found = false;
  for (const line of lines) {
    const t = line.trim();
    if (t.startsWith('data:') && t.slice(5).trim()) {
      found = true;
      break;
    }
  }
  return { found, rest };
}

function isAbortError(err) {
  return err && (err.code === 'ABORT_ERR' || err.name === 'AbortError' || err.message === 'aborted');
}

function listenAbort(signal, onAbort) {
  if (!signal) return () => {};
  if (signal.aborted) {
    onAbort();
    return () => {};
  }
  if (typeof signal.addEventListener === 'function') {
    signal.addEventListener('abort', onAbort, { once: true });
    return () => {
      if (typeof signal.removeEventListener === 'function') {
        signal.removeEventListener('abort', onAbort);
      }
    };
  }
  if (typeof signal.aborted === 'boolean') {
    const poll = setInterval(() => {
      if (signal.aborted) {
        clearInterval(poll);
        onAbort();
      }
    }, 100);
    return () => clearInterval(poll);
  }
  return () => {};
}

function requestOnce(url, { method = 'POST', headers = {}, body = '' }, signal) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(url);
    } catch (e) {
      reject(new Error('无效的 URL'));
      return;
    }
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: `${u.pathname}${u.search}`,
        method,
        headers
      },
      (res) => {
        settle({ res, req });
      }
    );

    let settled = false;
    let unlistenAbort = () => {};
    const settle = (value) => {
      if (settled) return;
      settled = true;
      unlistenAbort();
      try {
        // 首包到达后取消短连接超时，避免慢生成（TTFB 长 / 包间隔）被 60s 误杀
        req.setTimeout(0);
      } catch {
        // ignore
      }
      resolve(value);
    };
    const fail = (err) => {
      if (settled) return;
      settled = true;
      unlistenAbort();
      try {
        req.destroy();
      } catch {
        // ignore
      }
      reject(err);
    };

    req.setTimeout(CONNECT_TIMEOUT_MS, () => fail(new Error('ETIMEDOUT connect')));
    req.on('error', fail);

    if (signal) {
      unlistenAbort = listenAbort(signal, () =>
        fail(Object.assign(new Error('aborted'), { name: 'AbortError', code: 'ABORT_ERR' }))
      );
    }

    if (body) req.write(body);
    req.end();
  });
}

/**
 * @param {string} url
 * @param {{ method?: string, headers?: object, body?: string, signal?: { aborted?: boolean, addEventListener?: Function, removeEventListener?: Function } }} opts
 */
async function chatCompletionJson(url, opts = {}) {
  const signal = opts.signal || null;
  const { res, req } = await requestOnce(
    url,
    {
      method: opts.method || 'POST',
      headers: opts.headers || {},
      body: opts.body || ''
    },
    signal
  );

  const chunks = [];
  await new Promise((resolve, reject) => {
    let settled = false;
    let unlistenAbort = () => {};
    let idleTimer = null;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      unlistenAbort();
      if (idleTimer) clearTimeout(idleTimer);
      clearTimeout(totalTimer);
      try {
        req.destroy();
        res.destroy();
      } catch {
        // ignore
      }
      reject(err);
    };
    const armIdle = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => fail(new Error('ETIMEDOUT body')), STREAM_IDLE_TIMEOUT_MS);
    };
    const totalTimer = setTimeout(
      () => fail(new Error('ETIMEDOUT total')),
      STREAM_TOTAL_TIMEOUT_MS
    );
    armIdle();
    res.on('data', (c) => {
      if (settled) return;
      chunks.push(c);
      armIdle();
    });
    res.on('end', () => {
      if (!settled) {
        settled = true;
        unlistenAbort();
        if (idleTimer) clearTimeout(idleTimer);
        clearTimeout(totalTimer);
        resolve();
      }
    });
    res.on('error', fail);
    if (signal) {
      unlistenAbort = listenAbort(signal, () =>
        fail(Object.assign(new Error('aborted'), { name: 'AbortError', code: 'ABORT_ERR' }))
      );
    }
  });

  const raw = Buffer.concat(chunks).toString('utf8');
  if (res.statusCode && res.statusCode >= 400) {
    const err = new Error(`HTTP ${res.statusCode} ${raw.slice(0, 400)}`);
    err.statusCode = res.statusCode;
    throw err;
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`响应非 JSON：${raw.slice(0, 200)}`);
  }
}

/**
 * @param {string} url
 * @param {{ headers?: object, body?: string, signal?: object, onChunk?: (text: string) => void }} opts
 */
async function streamChatSse(url, opts = {}) {
  const signal = opts.signal || null;
  const onChunk = typeof opts.onChunk === 'function' ? opts.onChunk : () => {};

  const { res, req } = await requestOnce(
    url,
    {
      method: 'POST',
      headers: opts.headers || {},
      body: opts.body || ''
    },
    signal
  );

  if (res.statusCode && res.statusCode >= 400) {
    const errBody = await readAll(res, {
      signal,
      req,
      idleMs: Math.min(STREAM_IDLE_TIMEOUT_MS, 30000),
      totalMs: Math.min(STREAM_TOTAL_TIMEOUT_MS, 60000)
    });
    const err = new Error(`HTTP ${res.statusCode} ${errBody.slice(0, 400)}`);
    err.statusCode = res.statusCode;
    throw err;
  }

  const started = Date.now();
  await new Promise((resolve, reject) => {
    let settled = false;
    let idleTimer = null;
    let firstTokenTimer = null;
    let gotFirstToken = false;
    let sseLineCarry = '';
    let rawPreview = '';
    let unlistenAbort = () => {};

    const fail = (err) => {
      if (settled) return;
      settled = true;
      unlistenAbort();
      if (idleTimer) clearTimeout(idleTimer);
      if (firstTokenTimer) clearTimeout(firstTokenTimer);
      clearTimeout(totalTimer);
      try {
        req.destroy();
        res.destroy();
      } catch {
        // ignore
      }
      reject(err);
    };

    const armIdle = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => fail(new Error('ETIMEDOUT idle')), STREAM_IDLE_TIMEOUT_MS);
    };

    const armFirstToken = () => {
      if (gotFirstToken) return;
      if (firstTokenTimer) clearTimeout(firstTokenTimer);
      const firstTokenMs =
        Number(opts.firstTokenTimeoutMs) > 0
          ? Number(opts.firstTokenTimeoutMs)
          : STREAM_FIRST_TOKEN_TIMEOUT_MS;
      firstTokenTimer = setTimeout(() => {
        console.warn(
          '[dieyun:agent]',
          'LLM_FIRST_TOKEN_TIMEOUT',
          `headers 后 ${firstTokenMs}ms 无有效 SSE data（可能被 keep-alive 假续命）`
        );
        fail(new Error('ETIMEDOUT first_token'));
      }, firstTokenMs);
    };

    const markFirstToken = () => {
      if (gotFirstToken) return;
      gotFirstToken = true;
      if (firstTokenTimer) {
        clearTimeout(firstTokenTimer);
        firstTokenTimer = null;
      }
    };

    const totalTimer = setTimeout(
      () => fail(new Error('ETIMEDOUT total')),
      STREAM_TOTAL_TIMEOUT_MS
    );

    armIdle();
    armFirstToken();

    res.setEncoding('utf8');
    res.on('data', (chunk) => {
      if (Date.now() - started > STREAM_TOTAL_TIMEOUT_MS) {
        fail(new Error('ETIMEDOUT total'));
        return;
      }
      const text = String(chunk);
      // 任意 socket 数据只续 idle；首包超时仅在看到真正的 data: 行时解除
      armIdle();
      if (!gotFirstToken) {
        if (rawPreview.length < 800) rawPreview += text.slice(0, 800 - rawPreview.length);
        const hit = sseChunkHasDataLine(text, sseLineCarry);
        sseLineCarry = hit.rest;
        if (hit.found) markFirstToken();
      }
      try {
        onChunk(text);
      } catch (e) {
        fail(e);
      }
    });
    res.on('end', () => {
      if (settled) return;
      if (!gotFirstToken) {
        const trimmed = String(rawPreview || '').trim();
        let detail = '';
        if (trimmed.startsWith('{')) {
          try {
            const json = JSON.parse(trimmed);
            const errObj = json && json.error;
            detail =
              (errObj && typeof errObj === 'object' && (errObj.message || errObj.code)) ||
              (typeof errObj === 'string' ? errObj : '') ||
              (typeof json.message === 'string' ? json.message : '');
          } catch {
            // ignore
          }
        }
        fail(
          new Error(
            detail
              ? `LLM 非流式错误响应：${String(detail).slice(0, 300)}（若使用 LM Studio，请确认接口含 /v1）`
              : 'LLM 响应不是 SSE（可能接口地址缺少 /v1，例如应为 http://host:1234/v1）'
          )
        );
        return;
      }
      settled = true;
      unlistenAbort();
      clearTimeout(totalTimer);
      if (idleTimer) clearTimeout(idleTimer);
      if (firstTokenTimer) clearTimeout(firstTokenTimer);
      resolve();
    });
    res.on('error', fail);

    if (signal) {
      unlistenAbort = listenAbort(signal, () =>
        fail(Object.assign(new Error('aborted'), { name: 'AbortError', code: 'ABORT_ERR' }))
      );
    }
  });
}

/**
 * 有界读完响应体（错误页等）。无超时/abort 时上游挂住会无限等。
 * @param {import('stream').Readable} stream
 * @param {{ signal?: object, req?: object, idleMs?: number, totalMs?: number }} [opts]
 */
function readAll(stream, opts = {}) {
  const signal = opts.signal || null;
  const req = opts.req || null;
  const idleMs = Number(opts.idleMs) > 0 ? Number(opts.idleMs) : 60000;
  const totalMs = Number(opts.totalMs) > 0 ? Number(opts.totalMs) : 120000;
  return new Promise((resolve, reject) => {
    let settled = false;
    let idleTimer = null;
    let unlistenAbort = () => {};
    const parts = [];
    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      unlistenAbort();
      if (idleTimer) clearTimeout(idleTimer);
      clearTimeout(totalTimer);
      fn(arg);
    };
    const fail = (err) => {
      try {
        if (req && typeof req.destroy === 'function') req.destroy();
        if (stream && typeof stream.destroy === 'function') stream.destroy();
      } catch {
        // ignore
      }
      finish(reject, err);
    };
    const armIdle = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => fail(new Error('ETIMEDOUT body')), idleMs);
    };
    const totalTimer = setTimeout(() => fail(new Error('ETIMEDOUT total')), totalMs);
    armIdle();
    stream.on('data', (c) => {
      if (settled) return;
      parts.push(c);
      armIdle();
    });
    stream.on('end', () => finish(resolve, Buffer.concat(parts).toString('utf8')));
    stream.on('error', fail);
    if (signal) {
      unlistenAbort = listenAbort(signal, () =>
        fail(Object.assign(new Error('aborted'), { name: 'AbortError', code: 'ABORT_ERR' }))
      );
    }
  });
}

module.exports = {
  CONNECT_TIMEOUT_MS,
  STREAM_FIRST_TOKEN_TIMEOUT_MS,
  STREAM_IDLE_TIMEOUT_MS,
  STREAM_TOTAL_TIMEOUT_MS,
  chatCompletionJson,
  streamChatSse,
  sseChunkHasDataLine,
  isAbortError
};

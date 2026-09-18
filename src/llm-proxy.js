'use strict';

const http = require('http');
const https = require('https');
const { URL } = require('url');
const { sanitizeChatRequestJsonForApi } = require('./agent/guardrails-shared');

/** 建立 TCP / 等到响应 headers（慢模型生成 JSON 可能长时间无输出） */
const CONNECT_TIMEOUT_MS = Number(process.env.LLM_CONNECT_TIMEOUT_MS) || 180000;
/** 流式：headers 已到但迟迟无有效 SSE data（忽略 `: keep-alive` 假心跳） */
const STREAM_FIRST_TOKEN_TIMEOUT_MS =
  Number(process.env.LLM_FIRST_TOKEN_TIMEOUT_MS) || 180000;
/**
 * 流式两包之间的 idle 超时：**只有有效 SSE `data:` 行才续命**（keep-alive 注释 / 空行不算），
 * 静默超时即抛 `ETIMEDOUT idle` 交给重连层重试。
 *
 * 策略数值的唯一来源是 `agent-limits.llmStreamIdleTimeoutMs`（经 opts.idleTimeoutMs 传入），
 * 这里的常量只是调用方未传时的兜底（与首包超时同值 180s，保持两个看门狗同量级）。
 */
const STREAM_IDLE_TIMEOUT_MS = Number(process.env.LLM_STREAM_IDLE_TIMEOUT_MS) || 180000;
/**
 * 非流式响应体读取的 idle 超时。
 * 非流式要等服务端攒完整响应才吐字，必须比流式宽松，故不与 STREAM_IDLE_TIMEOUT_MS 共用。
 */
const BODY_IDLE_TIMEOUT_MS = Number(process.env.LLM_BODY_IDLE_TIMEOUT_MS) || 600000;
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
      // 出站图片最后一道闸（单一来源 guardrails-shared）：历史账本里的非法图片
      // 会让上游以 400 "unsupported image" 打回整轮请求。
      body: sanitizeChatRequestJsonForApi(opts.body || '')
    },
    signal
  );

  const chunks = [];
  await new Promise((resolve, reject) => {
    let settled = false;
    let unlistenAbort = () => {};
    let idleTimer = null;
    let totalTimer = null;
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
      idleTimer = setTimeout(() => fail(new Error('ETIMEDOUT body')), BODY_IDLE_TIMEOUT_MS);
    };
    totalTimer = setTimeout(
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
 * @param {{ headers?: object, body?: string, signal?: object, onChunk?: (text: string) => void,
 *   firstTokenTimeoutMs?: number, idleTimeoutMs?: number }} opts
 *   `idleTimeoutMs` = 两包之间的容忍时长（只认真实 SSE data 行），由 agent-limits 注入。
 */
async function streamChatSse(url, opts = {}) {
  const signal = opts.signal || null;
  const onChunk = typeof opts.onChunk === 'function' ? opts.onChunk : () => {};

  const { res, req } = await requestOnce(
    url,
    {
      method: 'POST',
      headers: opts.headers || {},
      // 出站图片最后一道闸（单一来源 guardrails-shared）：历史账本里的非法图片
      // 会让上游以 400 "unsupported image" 打回整轮请求。
      body: sanitizeChatRequestJsonForApi(opts.body || '')
    },
    signal
  );

  if (res.statusCode && res.statusCode >= 400) {
    const errBody = await readAll(res, {
      signal,
      req,
      idleMs: Math.min(BODY_IDLE_TIMEOUT_MS, 30000),
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
    let totalTimer = null;
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

    const idleMs =
      Number(opts.idleTimeoutMs) > 0 ? Number(opts.idleTimeoutMs) : STREAM_IDLE_TIMEOUT_MS;

    /**
     * 包间隔看门狗：**只在「上游确实还在说话」时续命**。
     * 调用方必须先确认收到真正的 SSE `data:` 行才调它 —— 不能用任意 socket 数据续命，
     * 否则网关的 `: keep-alive` 注释会让看门狗假活，断流永远发现不了
     * （首包看门狗已有同样教训，见 armFirstToken 的告警文案）。
     */
    const armIdle = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        console.warn(
          '[dieyun:agent]',
          'LLM_STREAM_IDLE_TIMEOUT',
          `已 ${idleMs}ms 无有效 SSE data，判定上游断流，转交重连层`
        );
        fail(new Error('ETIMEDOUT idle'));
      }, idleMs);
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
      // 首包前由 firstToken 看门狗负责；首包之后才开始计「包间隔」
      armIdle();
    };

    totalTimer = setTimeout(
      () => fail(new Error('ETIMEDOUT total')),
      STREAM_TOTAL_TIMEOUT_MS
    );

    // 首包前不启 idle：那段由 firstToken 看门狗负责（文案更准，且同样忽略 keep-alive）
    armFirstToken();

    res.setEncoding('utf8');
    res.on('data', (chunk) => {
      if (Date.now() - started > STREAM_TOTAL_TIMEOUT_MS) {
        fail(new Error('ETIMEDOUT total'));
        return;
      }
      const text = String(chunk);
      // 只有真正的 data: 行才算「上游还在说话」：keep-alive 注释 / 空行一律不续命
      const hit = sseChunkHasDataLine(text, sseLineCarry);
      sseLineCarry = hit.rest.length > 1024 * 1024 ? hit.rest.slice(-1024) : hit.rest;
      if (!gotFirstToken && rawPreview.length < 800) {
        rawPreview += text.slice(0, 800 - rawPreview.length);
      }
      if (hit.found) {
        if (gotFirstToken) armIdle();
        else markFirstToken();
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
    let totalTimer = null;
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
    totalTimer = setTimeout(() => fail(new Error('ETIMEDOUT total')), totalMs);
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
  BODY_IDLE_TIMEOUT_MS,
  chatCompletionJson,
  streamChatSse,
  sseChunkHasDataLine,
  isAbortError
};

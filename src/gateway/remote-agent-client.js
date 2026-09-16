'use strict';

const crypto = require('crypto');
const WebSocket = require('ws');

const PING_INTERVAL_MS = 25000;
const CALL_RECONNECT_ATTEMPTS = 3;
const CALL_RECONNECT_BASE_MS = 600;
const MAX_CACHED_CLIENTS = 6;

function sleepMs(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function isDisconnectError(err) {
  const msg = String((err && err.message) || err || '').toLowerCase();
  return (
    msg.includes('连接已关闭') ||
    msg.includes('已断开') ||
    msg.includes('已关闭') ||
    msg.includes('websocket') ||
    msg.includes('未就绪') ||
    msg.includes('隧道未就绪')
  );
}

function remoteAgentClientKey(info) {
  if (!info || !info.url || !info.token) return '';
  return `${info.url}:${info.token}`;
}

class RemoteAgentClient {
  /**
   * @param {{ url: string, token: string }} info
   */
  constructor(info) {
    this.url = info.url;
    this.token = info.token;
    /** @type {WebSocket | null} */
    this.ws = null;
    this.authed = false;
    /** @type {Map<string, { resolve: Function, reject: Function }>} */
    this.pending = new Map();
    /** @type {Promise<void> | null} */
    this.connecting = null;
    /** @type {NodeJS.Timeout | null} */
    this._pingTimer = null;
    this._closing = false;
  }

  _clearPing() {
    if (this._pingTimer) {
      clearInterval(this._pingTimer);
      this._pingTimer = null;
    }
  }

  _teardownSocket() {
    this._clearPing();
    this.authed = false;
    const ws = this.ws;
    this.ws = null;
    if (!ws) return;
    try {
      ws.removeAllListeners();
    } catch {
      // ignore
    }
    // ws 在 CONNECTING 时 close/terminate 会 emit('error')；若无监听则变成
    // Uncaught Exception: "WebSocket was closed before the connection was established"
    try {
      ws.on('error', () => {});
    } catch {
      // ignore
    }
    try {
      const state = ws.readyState;
      if (state === WebSocket.OPEN) {
        ws.close();
      } else if (state === WebSocket.CONNECTING || state === WebSocket.CLOSING) {
        ws.terminate();
      }
    } catch {
      try {
        ws.terminate();
      } catch {
        // ignore
      }
    }
  }

  _rejectPending(message) {
    const err = new Error(message);
    for (const [, box] of this.pending) {
      box.reject(err);
    }
    this.pending.clear();
  }

  _resetForReconnect() {
    this.connecting = null;
    this._teardownSocket();
    this._rejectPending('Remote Agent 已断开');
  }

  _startPing(ws) {
    this._clearPing();
    this._pingTimer = setInterval(() => {
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      try {
        ws.ping();
      } catch {
        // ignore
      }
    }, PING_INTERVAL_MS);
  }

  async connect() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN && this.authed) return;
    if (this.connecting) return this.connecting;

    if (this.ws && this.ws.readyState !== WebSocket.OPEN && !this.connecting) {
      this._teardownSocket();
    }

    this.connecting = new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);
      this.ws = ws;
      let settled = false;

      const fail = (err) => {
        if (settled) return;
        settled = true;
        this.connecting = null;
        this.authed = false;
        this._clearPing();
        reject(err);
      };

      ws.on('open', () => {
        ws.send(JSON.stringify({ v: 1, type: 'auth', token: this.token }));
      });

      ws.on('message', (raw) => {
        let msg;
        try {
          msg = JSON.parse(String(raw));
        } catch {
          return;
        }
        if (msg.type === 'auth_ok') {
          if (settled) return;
          settled = true;
          this.authed = true;
          this.connecting = null;
          this._startPing(ws);
          resolve();
          return;
        }
        if (msg.type !== 'result') return;
        const box = this.pending.get(msg.id);
        if (!box) return;
        this.pending.delete(msg.id);
        if (msg.ok) box.resolve(msg.data);
        else box.reject(new Error((msg.error && msg.error.message) || 'Remote Agent RPC 失败'));
      });

      ws.on('error', () => fail(new Error('Remote Agent WebSocket 错误')));

      ws.on('close', () => {
        this._clearPing();
        // 旧 socket 关闭时勿清掉重连后的新连接
        if (this.ws && this.ws !== ws) return;
        this.authed = false;
        if (this.ws === ws) this.ws = null;
        this._rejectPending('Remote Agent 已断开');
        if (!settled) fail(new Error('Remote Agent 连接已关闭'));
      });
    });

    return this.connecting;
  }

  async _callOnce(method, params = {}, timeoutMs) {
    await this.connect();
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.authed) {
      throw new Error('Remote Agent 未就绪');
    }
    const ms = timeoutMs != null && Number(timeoutMs) > 0 ? Number(timeoutMs) : 120000;
    return new Promise((resolve, reject) => {
      const id = crypto.randomUUID();
      const timer = setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        reject(new Error(`Remote Agent RPC 超时 (${method}, ${ms}ms)`));
      }, ms);
      this.pending.set(id, {
        resolve: (data) => {
          clearTimeout(timer);
          resolve(data);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        }
      });
      try {
        this.ws.send(JSON.stringify({ v: 1, type: 'call', id, method, params }));
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e);
      }
    });
  }

  /**
   * @param {string} method
   * @param {object} [params]
   * @param {number} [timeoutMs]
   */
  async call(method, params = {}, timeoutMs) {
    let lastErr;
    for (let attempt = 1; attempt <= CALL_RECONNECT_ATTEMPTS; attempt += 1) {
      try {
        return await this._callOnce(method, params, timeoutMs);
      } catch (err) {
        lastErr = err;
        if (!isDisconnectError(err) || attempt >= CALL_RECONNECT_ATTEMPTS) {
          throw err;
        }
        this._resetForReconnect();
        await sleepMs(CALL_RECONNECT_BASE_MS * attempt);
      }
    }
    throw lastErr || new Error('Remote Agent RPC 失败');
  }

  close() {
    this._closing = true;
    this.connecting = null;
    this._teardownSocket();
    this._rejectPending('Remote Agent 已关闭');
    this._closing = false;
  }
}

/** @type {Map<string, { client: RemoteAgentClient, lastUsedAt: number }>} */
const clientCache = new Map();
/** @type {(() => void) | null} */
let onInvalidateListener = null;

function setRemoteAgentInvalidateListener(fn) {
  onInvalidateListener = typeof fn === 'function' ? fn : null;
}

function touchCachedClient(key, client) {
  clientCache.set(key, { client, lastUsedAt: Date.now() });
}

function evictOldestCachedClient() {
  let oldestKey = '';
  let oldestAt = Infinity;
  for (const [key, entry] of clientCache.entries()) {
    if (entry.lastUsedAt < oldestAt) {
      oldestAt = entry.lastUsedAt;
      oldestKey = key;
    }
  }
  if (!oldestKey) return;
  const entry = clientCache.get(oldestKey);
  if (entry) entry.client.close();
  clientCache.delete(oldestKey);
}

/**
 * @param {{ url: string, token: string } | null} info
 */
function getRemoteAgentClient(info) {
  if (!info || !info.url || !info.token) {
    throw new Error('Remote Agent 隧道未就绪');
  }
  const key = remoteAgentClientKey(info);
  const cached = clientCache.get(key);
  if (cached) {
    const client = cached.client;
    if (client.ws && client.ws.readyState === WebSocket.OPEN && client.authed) {
      touchCachedClient(key, client);
      return client;
    }
    // Do not tear down an in-flight connect; callers await client.connect().
    if (client.connecting) {
      touchCachedClient(key, client);
      return client;
    }
    client._resetForReconnect();
    touchCachedClient(key, client);
    return client;
  }
  while (clientCache.size >= MAX_CACHED_CLIENTS) {
    evictOldestCachedClient();
  }
  const client = new RemoteAgentClient(info);
  touchCachedClient(key, client);
  return client;
}

/**
 * @param {{ url?: string, token?: string } | null | undefined} [info] 不传则关闭全部缓存连接
 */
function invalidateRemoteAgentClient(info) {
  const key = remoteAgentClientKey(info);
  if (key) {
    const entry = clientCache.get(key);
    if (entry) entry.client.close();
    clientCache.delete(key);
    if (onInvalidateListener) onInvalidateListener();
    return;
  }
  for (const entry of clientCache.values()) {
    entry.client.close();
  }
  clientCache.clear();
  if (onInvalidateListener) onInvalidateListener();
}

module.exports = {
  RemoteAgentClient,
  getRemoteAgentClient,
  invalidateRemoteAgentClient,
  remoteAgentClientKey,
  setRemoteAgentInvalidateListener,
  isDisconnectError
};

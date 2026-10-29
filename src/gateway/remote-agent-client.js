'use strict';

const crypto = require('crypto');
const WebSocket = require('ws');

const { sleepMs } = require('../llm-reconnect-retry');
const { remoteAgentInfoKey } = require('../workspace/workspace-cache-keys');

const PING_INTERVAL_MS = 25000;
/**
 * 握手预算：TCP 连上但对端不说话（撞端口后是别的服务、半开连接、被墙）时，
 * `open` 永远等不到 `auth_ok`/`hello_ok`，也不会有 close —— 没有这个超时，
 * RPC 会永久挂起，上层三次重试全卡在 connect 上。
 */
const CONNECT_TIMEOUT_MS = 15000;
const CALL_RECONNECT_ATTEMPTS = 3;
const CALL_RECONNECT_BASE_MS = 600;
const MAX_CACHED_CLIENTS = 6;

function isDisconnectError(err) {
  const code = String((err && err.code) || '');
  if (code === 'REMOTE_AGENT_CONNECT_TIMEOUT') return true;
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

/**
 * 「这个 info 能不能连上一个远端 Agent」的**唯一判定**：只认 P2 的通道形态（`openChannel`）。
 *
 * 判据不许在调用点各写一份（曾经 6 处写 `info.url`，P2 去掉 url 后全部静默失效，
 * 远端 grep / glob / LSP / 增量索引通知全退化成「看起来成功」的本地路径）。
 */
function isRemoteAgentUsable(info) {
  if (!info) return false;
  return typeof info.openChannel === 'function';
}

function remoteAgentClientKey(info) {
  // 身份 key 的实现在 workspace-cache-keys（同一份 key 也给索引缓存用）
  return remoteAgentInfoKey(info);
}

class RemoteAgentClient {
  /**
   * @param {{ key?: string, socketPath?: string, workspaceRoot?: string, openChannel?: () => Promise<any>, connectTimeoutMs?: number }} info
   */
  constructor(info) {
    // 通道由 SSH 侧提供（direct-streamlocal 到远端 Unix socket）：没有 url / token 这回事
    this.openChannel = typeof info.openChannel === 'function' ? info.openChannel : null;
    this.workspaceRoot = String(info.workspaceRoot || '');
    this.key = remoteAgentClientKey(info);
    this.connectTimeoutMs = Number(info.connectTimeoutMs) > 0 ? Number(info.connectTimeoutMs) : CONNECT_TIMEOUT_MS;
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
    /**
     * 连接尝试的世代号：close() / 掉线重建都 +1。
     * 握手是异步的（先开通道再 WebSocket 握手），期间可能已经 close() 或开始重连；
     * 回来后必须发现自己已经作废，否则会把一个刚被关闭的 client 复活成 live socket。
     */
    this._generation = 0;
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
    // 在途的握手一律作废：它回来时不许把新连接顶掉，也不许把状态改回 authed
    this._generation += 1;
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

    this.connecting = this._openAndHandshake(this._generation);
    return this.connecting;
  }

  /**
   * 通道由 SSH 侧提供（`direct-streamlocal@openssh.com` 到远端 Unix socket）：
   * 先拿到通道，再在通道上做 WebSocket 握手。没有 TCP、没有 token。
   *
   * @param {number} [gen] 发起时的世代号；回来时对不上就说明这次尝试已作废
   */
  async _openAndHandshake(gen = this._generation) {
    const stale = () => gen !== this._generation;
    const aborted = () =>
      Object.assign(new Error('Remote Agent 已关闭，本次连接尝试作废'), {
        code: 'REMOTE_AGENT_CLOSED',
        retryable: true
      });
    let stream = null;
    try {
      stream = await this.openChannel();
    } catch (err) {
      if (!stale()) this.connecting = null;
      throw err;
    }
    if (stale()) {
      // 开通道期间 close() 了：绝不在这里 new WebSocket —— 那等于把一个已关闭的 client 复活
      try {
        stream.destroy();
      } catch {
        // ignore
      }
      throw aborted();
    }
    return new Promise((resolve, reject) => {
      const ws = new WebSocket('ws://dieyun-agent/', { createConnection: () => stream });
      this.ws = ws;
      let settled = false;
      const handshakeTimer = setTimeout(() => {
        fail(
          Object.assign(new Error(`Remote Agent 连接超时（握手 ${this.connectTimeoutMs}ms 未完成）`), {
            code: 'REMOTE_AGENT_CONNECT_TIMEOUT'
          })
        );
        try {
          ws.terminate();
        } catch {
          // ignore
        }
      }, this.connectTimeoutMs);

      const fail = (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(handshakeTimer);
        this.connecting = null;
        this.authed = false;
        this._clearPing();
        reject(err);
      };

      ws.on('open', () => {
        ws.send(JSON.stringify({ v: 1, type: 'hello', workspace: this.workspaceRoot }));
      });

      ws.on('message', (raw) => {
        let msg;
        try {
          msg = JSON.parse(String(raw));
        } catch {
          return;
        }
        if (msg.type === 'hello_ok') {
          if (settled) return;
          settled = true;
          clearTimeout(handshakeTimer);
          if (stale()) {
            // 握手回来的这一刻已经被 close()/重建：把 socket 收掉，别留下一个自以为连上的空壳
            try {
              ws.terminate();
            } catch {
              // ignore
            }
            reject(aborted());
            return;
          }
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
        else {
          // 远端分类过的错误码（REMOTE_INDEX_CORE_MISSING / UNSUPPORTED / AUTH_FAILED …）
          // 不许在这一层滤掉：滤了上层就只能靠中文文案猜。
          const info = (msg && msg.error) || {};
          const err = new Error(info.message || 'Remote Agent RPC 失败');
          if (info.code) err.code = String(info.code);
          // 与本地 RPC 同一份失败契约：retryable / suggestedFix 必须一起过来
          if (typeof info.retryable === 'boolean') err.retryable = info.retryable;
          if (info.suggestedFix) err.suggestedFix = String(info.suggestedFix);
          box.reject(err);
        }
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
        reject(
          Object.assign(new Error(`Remote Agent RPC 超时 (${method}, ${ms}ms)`), {
            code: 'REMOTE_AGENT_RPC_TIMEOUT',
            method
          })
        );
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
    // 作废在途握手，并让它的收尾动作（写 connecting / authed）全部失效
    this._generation += 1;
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
 * @param {{ key?: string, socketPath?: string, workspaceRoot?: string, openChannel?: () => Promise<any> } | null} info
 */
function getRemoteAgentClient(info) {
  if (!isRemoteAgentUsable(info)) {
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
  isRemoteAgentUsable,
  setRemoteAgentInvalidateListener,
  isDisconnectError,
  CONNECT_TIMEOUT_MS
};

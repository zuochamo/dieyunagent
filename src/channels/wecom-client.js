'use strict';

const WebSocket = require('ws');

/**
 * 企业微信「智能机器人」长连接客户端（内置转接器的左侧）。
 *
 * 协议来源：`工具/wecom-agent-bridge/bridge.py`（v1 外挂版，已实测跑通），逐帧照搬：
 *   → aibot_subscribe { bot_id, secret }        订阅（同一 bot 只允许一条长连接，新连接顶掉旧的）
 *   → ping                                       25s 一次应用层心跳（不开 ws 自带的 ping）
 *   ← aibot_msg_callback                         用户消息（headers.req_id 是回复凭据）
 *   ← aibot_event_callback                       事件（enter_chat 等）
 *   → aibot_respond_msg { msgtype:'stream', stream:{ id, finish, content } }   流式回同一 stream.id
 *   → aibot_respond_welcome_msg                  进入会话的欢迎语
 *   → aibot_send_msg                             主动推送（不依赖某条消息的 req_id）
 * 服务端 ack 帧形如 `{ errcode: 0 }`；errcode!=0 一律记日志并通知上层（不静默重试）。
 *
 * 本模块只负责「线」：连接、心跳、重连、帧编解码、把回调分发给上层。
 * 会话映射 / 串行 / 节流 / Agent 执行都在 runtime 层（`src/channels/runtime.js`）。
 */

const WECOM_WS_URL = 'wss://openws.work.weixin.qq.com';
const HEARTBEAT_MS = 25_000;
const RECONNECT_DELAY_MS = 3_000;
const RECONNECT_MAX_DELAY_MS = 60_000;
/**
 * 半开连接的判定门槛：网络静默失效时 TCP 仍是 OPEN、`ws.send` 一直「成功」，
 * 只有「发了心跳却长时间没有任何回帧」才暴露出来。取 4 个心跳周期（100s），
 * 宁可晚一点重连，也不要因为对端不爱回 ack 就来回抖。
 */
const DEAD_CONNECTION_MS = HEARTBEAT_MS * 4;
/** 主动推送等待服务端回执的上限：企微不一定回 ack，超时按「已提交」算，不误报失败 */
const PUSH_ACK_TIMEOUT_MS = 5_000;
/** 同一条回调最多记多少个 req_id（服务端重投去重窗口） */
const SEEN_REQ_LIMIT = 500;
const MAX_FRAME_BYTES = 8 * 1024 * 1024;
const REPLY_STREAM_PREFIX = 's-';

function newReqId() {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

function newStreamId() {
  return `${REPLY_STREAM_PREFIX}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 把一条 `aibot_msg_callback.body` 归一成频道运行时能吃的形状。
 *
 * 消息类型按企微智能机器人文档的字段摆放来读（`body.<msgtype>`），不猜：
 * - text：`text.content`
 * - voice：`voice.content`（企微已经把语音转成文本；没有就是只有媒体，交给上层说明）
 * - image：`image.url` / `image.pic_url`
 * - file：`file.url` / `file.name`
 * - mixed：`mixed.msg_item[]`，每项同样是 `{ msgtype, text|image|... }`
 *
 * @param {object} body
 * @returns {{ msgtype: string, text: string, images: string[], voiceText: string, file: {url:string,name:string}|null }}
 */
function normalizeInboundBody(body) {
  const b = body && typeof body === 'object' ? body : {};
  const out = { msgtype: String(b.msgtype || ''), text: '', images: [], voiceText: '', file: null };
  const takeImage = (node) => {
    if (!node || typeof node !== 'object') return;
    const url = String(node.url || node.pic_url || '').trim();
    if (url) out.images.push(url);
  };
  const takeText = (node) => {
    const t = node && typeof node === 'object' ? String(node.content || '').trim() : '';
    if (t) out.text = out.text ? `${out.text}\n${t}` : t;
  };
  switch (out.msgtype) {
    case 'text':
      takeText(b.text);
      break;
    case 'voice': {
      takeText(b.voice);
      out.voiceText = out.text;
      break;
    }
    case 'image':
      takeImage(b.image);
      break;
    case 'file': {
      const f = b.file && typeof b.file === 'object' ? b.file : {};
      const url = String(f.url || '').trim();
      if (url) out.file = { url, name: String(f.name || f.filename || '').trim() };
      break;
    }
    case 'mixed': {
      const items = b.mixed && Array.isArray(b.mixed.msg_item) ? b.mixed.msg_item : [];
      for (const item of items) {
        if (!item || typeof item !== 'object') continue;
        if (item.msgtype === 'text') takeText(item.text);
        else if (item.msgtype === 'image') takeImage(item.image);
        else if (item.msgtype === 'voice') takeText(item.voice);
      }
      break;
    }
    default:
      break;
  }
  return out;
}

/**
 * 会话键：群聊用 chatid，单聊用 `single:<userid>`（与 v1 同一约定，历史映射不失效）
 *
 * 拿不到发送者时按 req_id 分桶：否则所有「不知道是谁」的消息会挤进同一条会话，
 * 相互污染上下文（宁可开一条新会话，也不要把 A 的对话接给 B）。
 *
 * @param {object} body
 * @param {string} [reqId]
 */
function conversationKeyOf(body, reqId) {
  const b = body && typeof body === 'object' ? body : {};
  const chatid = String(b.chatid || '').trim();
  if (chatid) return chatid;
  const sender = String((b.from && b.from.userid) || '').trim();
  if (sender) {
    const chattype = String(b.chattype || 'single').trim();
    return `${chattype}:${sender}`;
  }
  return `unknown:${String(reqId || '').trim() || 'anon'}`;
}

/**
 * 帧构造的唯一来源（纯函数，便于单测钉住线上协议）。
 * 形如 `{ cmd, headers:{req_id}, body }`；req_id 由这里生成（服务端只要求它存在且唯一）。
 */
const frames = {
  subscribe: (botId, secret) => ({
    cmd: 'aibot_subscribe',
    headers: { req_id: newReqId() },
    body: { bot_id: String(botId || ''), secret: String(secret || '') }
  }),
  ping: () => ({ cmd: 'ping', headers: { req_id: newReqId() }, body: {} }),
  stream: (reqId, streamId, content, finish) => ({
    cmd: 'aibot_respond_msg',
    headers: { req_id: String(reqId || '') },
    body: {
      msgtype: 'stream',
      stream: {
        id: String(streamId || ''),
        finish: !!finish,
        content: String(content == null ? '' : content)
      }
    }
  }),
  welcome: (reqId, text) => ({
    cmd: 'aibot_respond_welcome_msg',
    headers: { req_id: String(reqId || '') },
    body: { msgtype: 'text', text: { content: String(text || '') } }
  }),
  /**
   * 主动推送（不等用户先说话）：日报、巡检告警直推。
   * 目标用会话键表达：群聊 = chatid，单聊 = `single:<userid>`。
   */
  proactiveText: (conversationKey, content) => {
    const key = String(conversationKey || '').trim();
    const body = { msgtype: 'text', text: { content: String(content == null ? '' : content) } };
    if (key.startsWith('single:')) body.userid = key.slice('single:'.length);
    else body.chatid = key;
    return { cmd: 'aibot_send_msg', headers: { req_id: newReqId() }, body };
  }
};

/**
 * @param {{
 *   channelId: string,
 *   botId: string,
 *   secret: string,
 *   log?: (msg: string) => void,
 *   onMessage?: (payload: { reqId: string, body: object, conversationKey: string, normalized: object, reply: object }) => void,
 *   onEvent?: (payload: { reqId: string, body: object, eventtype: string, reply: object }) => void,
 *   onStatus?: (status: { state: string, at: number, detail?: string }) => void
 * }} opts
 */
function createWecomChannelClient(opts) {
  const channelId = String(opts.channelId || '');
  const log = typeof opts.log === 'function' ? opts.log : () => {};
  const onStatus = typeof opts.onStatus === 'function' ? opts.onStatus : () => {};
  // 单测用的唯一接缝：默认真连企微，测试注入假 socket 就能驱动「重投 / 断线 / 心跳」这些时序
  const createSocket =
    typeof opts.createSocket === 'function'
      ? opts.createSocket
      : (url, o) => new WebSocket(url, o);

  let ws = null;
  let heartbeatTimer = null;
  let reconnectTimer = null;
  let reconnectAttempts = 0;
  let stopped = false;
  let state = 'idle';
  let lastError = '';
  let lastFrameAt = 0;
  /** req_id → 已处理（服务端重投同一条回调时不能把 Agent 再跑一遍） */
  const seenReqIds = new Map();
  /** req_id → 等回执的推送（主动推送要知道服务端到底受理没） */
  const pendingAcks = new Map();

  function setState(next, detail) {
    state = next;
    if (detail) lastError = String(detail);
    try {
      onStatus({ state, at: Date.now(), detail: detail || '' });
    } catch (e) {
      log(`[channels] onStatus 回调异常：${e && e.message}`);
    }
  }

  function sendFrame(frame) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    try {
      ws.send(JSON.stringify(frame));
      return true;
    } catch (e) {
      log(`[channels] 发送失败 cmd=${frame && frame.cmd}：${e && e.message}`);
      return false;
    }
  }

  /** 流式回复：同一个 stream.id 反复发，finish=true 收尾（企微侧表现为打字机） */
  function streamReply(reqId, streamId, content, finish) {
    return sendFrame(frames.stream(reqId, streamId || newStreamId(), content, finish));
  }

  /** 进入会话欢迎语（事件回调专用） */
  function welcomeReply(reqId, text) {
    return sendFrame(frames.welcome(reqId, text));
  }

  /** 主动推送（由上层判定是否可用：服务端拒绝会打回 errcode，不做静默重试） */
  function sendProactiveText(conversationKey, content) {
    const key = String(conversationKey || '').trim();
    if (!key) return Promise.resolve({ ok: false, error: 'NO_TARGET' });
    const frame = frames.proactiveText(key, content);
    const reqId = String(frame.headers.req_id || '');
    if (!sendFrame(frame)) return Promise.resolve({ ok: false, error: 'SEND_FAILED' });
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pendingAcks.delete(reqId);
        // 企微不保证回 ack：超时只说「没等到回执」，不当成失败，免得用户以为没发出去
        resolve({ ok: true, ack: 'timeout' });
      }, PUSH_ACK_TIMEOUT_MS);
      if (typeof timer.unref === 'function') timer.unref();
      pendingAcks.set(reqId, {
        resolve: (r) => {
          clearTimeout(timer);
          pendingAcks.delete(reqId);
          resolve(r);
        }
      });
    });
  }

  /** 服务端重投去重：同一个 req_id 只放行一次（窗口内按条数有界淘汰） */
  function firstSeen(reqId) {
    const id = String(reqId || '').trim();
    if (!id) return true; // 没有 req_id 无从去重，照旧处理
    if (seenReqIds.has(id)) return false;
    seenReqIds.set(id, Date.now());
    while (seenReqIds.size > SEEN_REQ_LIMIT) {
      const oldest = seenReqIds.keys().next();
      if (oldest.done) break;
      seenReqIds.delete(oldest.value);
    }
    return true;
  }

  function replyApiFor(reqId, streamId) {
    const sid = streamId || newStreamId();
    return {
      streamId: sid,
      stream: (content, finish) => streamReply(reqId, sid, content, finish),
      final: (content) => streamReply(reqId, sid, content, true)
    };
  }

  function handleFrame(raw) {
    lastFrameAt = Date.now();
    let obj;
    try {
      obj = JSON.parse(raw);
    } catch {
      return;
    }
    if (!obj || typeof obj !== 'object') return;
    const cmd = obj.cmd;
    const headers = obj.headers && typeof obj.headers === 'object' ? obj.headers : {};
    const reqId = String(headers.req_id || '');
    const body = obj.body && typeof obj.body === 'object' ? obj.body : {};

    if (cmd === 'aibot_msg_callback') {
      if (!firstSeen(reqId)) {
        log(`[channels] ${channelId} 忽略重投回调 req_id=${reqId}（同一条消息只跑一轮）`);
        return;
      }
      const normalized = normalizeInboundBody(body);
      const conversationKey = conversationKeyOf(body, reqId);
      try {
        opts.onMessage?.({
          reqId,
          body,
          conversationKey,
          normalized,
          reply: replyApiFor(reqId)
        });
      } catch (e) {
        log(`[channels] onMessage 异常：${e && e.message}`);
      }
      return;
    }
    if (cmd === 'aibot_event_callback') {
      if (!firstSeen(reqId)) return;
      const eventtype = String((body.event && body.event.eventtype) || body.eventtype || '');
      try {
        opts.onEvent?.({ reqId, body, eventtype, reply: replyApiFor(reqId) });
      } catch (e) {
        log(`[channels] onEvent 异常：${e && e.message}`);
      }
      return;
    }
    if (obj.errcode != null && Number(obj.errcode) !== 0) {
      const detail = `errcode=${obj.errcode} errmsg=${obj.errmsg || ''}`;
      log(`[channels] 服务端错误 ${detail} · ${JSON.stringify(obj).slice(0, 300)}`);
      const waiter = reqId ? pendingAcks.get(reqId) : null;
      if (waiter) {
        waiter.resolve({
          ok: false,
          ack: 'rejected',
          errcode: Number(obj.errcode),
          errmsg: String(obj.errmsg || '')
        });
      }
      setState(state === 'online' ? 'online' : 'error', detail);
      return;
    }
    // errcode=0 的回执：推送方在等就把它叫醒（订阅/心跳的回执没有等待者，忽略即可）
    const ackWaiter = reqId ? pendingAcks.get(reqId) : null;
    if (ackWaiter) ackWaiter.resolve({ ok: true, ack: 'ok' });
  }

  function clearHeartbeat() {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  }

  function startHeartbeat() {
    clearHeartbeat();
    heartbeatTimer = setInterval(() => {
      // 半开连接：没有 FIN/RST 时 ws.send 一直「成功」，只能靠「心跳发出去了但没任何回帧」判死。
      // 判死就按断线处理（teardown → scheduleReconnect），否则频道会静默失联到用户手动重启。
      if (lastFrameAt && Date.now() - lastFrameAt > DEAD_CONNECTION_MS) {
        log(`[channels] ${channelId} ${Math.round(DEAD_CONNECTION_MS / 1000)}s 没收到任何回帧，按断线重连`);
        teardownSocket();
        setState('disconnected', '心跳无响应');
        scheduleReconnect();
        return;
      }
      sendFrame({ cmd: 'ping', headers: { req_id: newReqId() }, body: {} });
    }, HEARTBEAT_MS);
    if (typeof heartbeatTimer.unref === 'function') heartbeatTimer.unref();
  }

  function scheduleReconnect() {
    if (stopped || reconnectTimer) return;
    // 指数退避：连接被顶掉/对端不可用时别每 3s 硬撞一次（会把服务端和用户都拖进抖动）
    const delay = Math.min(RECONNECT_MAX_DELAY_MS, RECONNECT_DELAY_MS * 2 ** Math.min(reconnectAttempts, 5));
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (!stopped) connect();
    }, delay);
    if (typeof reconnectTimer.unref === 'function') reconnectTimer.unref();
  }

  function teardownSocket() {
    clearHeartbeat();
    const sock = ws;
    ws = null;
    if (sock) {
      try {
        // 顺序要紧：握手未完成时 `close()` 一定会发 `'error'`
        // （WebSocket was closed before the connection was established）。
        // 先摘掉业务监听（避免旧 socket 的 close 又触发重连），再挂一个兜底 error 监听，
        // 否则那条 error 无人接收 = 进程级未捕获异常（实测：连接中途停用频道会崩 Main）。
        sock.removeAllListeners();
        sock.on('error', () => {});
        sock.close();
      } catch {
        // ignore
      }
    }
  }

  function connect() {
    if (stopped) return;
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
    setState('connecting');
    let sock;
    try {
      sock = createSocket(WECOM_WS_URL, { handshakeTimeout: 15_000, maxPayload: MAX_FRAME_BYTES });
    } catch (e) {
      setState('error', `连接失败：${e && e.message}`);
      scheduleReconnect();
      return;
    }
    ws = sock;
    sock.on('open', () => {
      log(`[channels] ${channelId} 已连接，发送订阅`);
      lastFrameAt = Date.now(); // 心跳判活从这里起算
      sendFrame({
        cmd: 'aibot_subscribe',
        headers: { req_id: newReqId() },
        body: { bot_id: opts.botId, secret: opts.secret }
      });
      startHeartbeat();
      // 订阅是否成功以服务端 ack 判定：先记 connecting，收到正常帧/ack 再转 online
      setState('subscribed');
    });
    sock.on('message', (data) => {
      // 收到任何能解析的帧都说明链路活着：error 是「上一条命令失败」，不是「连接死了」，
      // 不能让它把状态永久钉在 error（设置页会一直红着，实际已经在正常收发）。
      if (state !== 'online') setState('online');
      reconnectAttempts = 0;
      handleFrame(typeof data === 'string' ? data : data.toString('utf8'));
    });
    sock.on('error', (err) => {
      setState('error', (err && err.message) || String(err));
    });
    sock.on('close', (code) => {
      teardownSocket();
      if (stopped) {
        setState('stopped');
        return;
      }
      reconnectAttempts += 1;
      setState('disconnected', `连接关闭 code=${code}`);
      scheduleReconnect();
    });
  }

  function start() {
    stopped = false;
    connect();
  }

  function stop() {
    stopped = true;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    // 别让还在等回执的推送干等到超时：连接已停，直接判失败
    for (const [id, waiter] of Array.from(pendingAcks.entries())) {
      pendingAcks.delete(id);
      waiter.resolve({ ok: false, error: 'STOPPED' });
    }
    teardownSocket();
    setState('stopped');
  }

  function getStatus() {
    return {
      channelId,
      state,
      lastError,
      lastFrameAt,
      connected: !!(ws && ws.readyState === WebSocket.OPEN)
    };
  }

  return {
    start,
    stop,
    getStatus,
    streamReply,
    welcomeReply,
    sendProactiveText,
    newStreamId
  };
}

/**
 * 一次性连通性自检（等价 `bridge.py --check`）：连上、订阅、拿到 ack 就断开，不落任何消息。
 * 设置页「测试连接」用它 —— 凭据错、bot 被别处占用都会在这里给出服务端的原文。
 *
 * @param {{ botId: string, secret: string, timeoutMs?: number }} opts
 * @returns {Promise<{ ok: boolean, errcode?: number, errmsg?: string, error?: string, raw?: string }>}
 */
function probeWecomCredentials(opts) {
  const botId = String((opts && opts.botId) || '').trim();
  const secret = String((opts && opts.secret) || '').trim();
  const timeoutMs = Number(opts && opts.timeoutMs) || 15_000;
  if (!botId || !secret) {
    return Promise.resolve({ ok: false, error: 'Bot ID / Secret 不完整' });
  }
  return new Promise((resolve) => {
    let done = false;
    let sock;
    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        if (sock) {
          // 同 teardownSocket：握手未完成时 close() 会发一条 'error'，
          // 摘掉监听后必须留兜底，否则「测试连接」超时会变成未捕获异常。
          sock.removeAllListeners();
          sock.on('error', () => {});
          sock.close();
        }
      } catch {
        // ignore
      }
      resolve(result);
    };
    const timer = setTimeout(() => finish({ ok: false, error: '连接超时（15s 内没有收到订阅回执）' }), timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
    try {
      sock = new WebSocket(WECOM_WS_URL, { handshakeTimeout: 15_000, maxPayload: MAX_FRAME_BYTES });
    } catch (e) {
      finish({ ok: false, error: (e && e.message) || String(e) });
      return;
    }
    sock.on('open', () => sock.send(JSON.stringify(frames.subscribe(botId, secret))));
    sock.on('message', (data) => {
      const raw = typeof data === 'string' ? data : data.toString('utf8');
      let obj = null;
      try {
        obj = JSON.parse(raw);
      } catch {
        finish({ ok: false, error: '服务端返回了无法解析的帧', raw: raw.slice(0, 300) });
        return;
      }
      const errcode = obj && obj.errcode != null ? Number(obj.errcode) : null;
      if (errcode === 0) finish({ ok: true, errcode: 0 });
      else if (errcode != null) finish({ ok: false, errcode, errmsg: obj.errmsg || '', raw: raw.slice(0, 300) });
      else finish({ ok: false, error: '未收到订阅回执', raw: raw.slice(0, 300) });
    });
    sock.on('error', (err) => finish({ ok: false, error: (err && err.message) || String(err) }));
    sock.on('close', (code) => finish({ ok: false, error: `连接被关闭（code=${code}）` }));
  });
}

module.exports = {
  createWecomChannelClient,
  probeWecomCredentials,
  normalizeInboundBody,
  conversationKeyOf,
  frames,
  newStreamId,
  HEARTBEAT_MS,
  DEAD_CONNECTION_MS,
  REPLY_STREAM_PREFIX
};

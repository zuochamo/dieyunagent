// @ts-check
'use strict';

/**
 * 内网 peer 的**动作语义唯一实现**：桌面 IPC（`src/main/ipc/peer.js`）与
 * headless 浏览器界面（`src/headless/desktop-turn.js` 的 `peer.*` 方法）都调这里。
 *
 * 为什么不各写一份：这二十来个动作全是「参数整形 + 协调器调用 + 结果透传」，
 * 抄第二份的唯一产出就是两侧字段漂移（桌面返回 `{ok,status}`、网页返回 `{ok}` 之类），
 * 而面板代码只有一套 —— 于是「桌面能用、网页空白」这种问题会以最难查的形态出现。
 *
 * **这里也不做业务判定**：能不能发、能不能自动跑一轮、租约给不给，全在
 * `src/peer/coordinator.js`。本文件只把协调器的内部形状翻译成界面/模型都能吃的形状
 * （与工具层 `tool-bridge-main.js` 的 peer 分派同一套语义）。
 *
 * 名字就是 IPC 通道的后缀（`peer:<name>`）与 `/ws` 方法的后缀（`peer.<name>`）。
 */

const PEER_ACTION_NAMES = Object.freeze([
  'status',
  'refresh',
  'set-name',
  'set-role',
  'set-enabled',
  'set-auto-turn',
  'set-auto-trust',
  'trust',
  'untrust',
  'trust-list',
  'set-static-peers',
  'send',
  'send-session',
  'open-session',
  'link-session',
  'unlink-session',
  'claim',
  'rooms',
  'room-create',
  'room-close',
  'room-send',
  'room-timeline'
]);

const DISABLED = Object.freeze({ ok: false, error: '内网互通未启用', errorCode: 'PEER_UNAVAILABLE' });

/**
 * @param {() => any} getCoordinator 每次调用现取（协调器是晚绑定的）
 */
function createPeerActions(getCoordinator) {
  function coordinator() {
    const pc = typeof getCoordinator === 'function' ? getCoordinator() : null;
    return pc || null;
  }

  /**
   * @param {string} action 见 `PEER_ACTION_NAMES`（`peer:` / `peer.` 之后那段）
   * @param {object} [payload]
   * @returns {Promise<object>}
   */
  async function handle(action, payload) {
    const name = String(action || '');
    const handler = HANDLERS[name];
    if (!handler) return { ok: false, error: `未知的互通动作：${name}` };
    const pc = coordinator();
    if (!pc) return { ...DISABLED };
    const args = payload && typeof payload === 'object' ? payload : {};
    try {
      return await handler(pc, args);
    } catch (err) {
      const message = err && err.message ? err.message : String(err);
      return { ok: false, error: message };
    }
  }

  return { handle, names: PEER_ACTION_NAMES };
}

/** @type {Record<string, (pc: any, p: any) => Promise<object>>} */
const HANDLERS = {
  status: async (pc) => ({ ok: true, status: pc.status() }),

  refresh: async (pc) => {
    pc.refresh();
    return { ok: true, status: pc.status() };
  },

  'set-name': async (pc, { name }) => {
    const identity = pc.setName(name);
    return { ok: true, identity, status: pc.status() };
  },

  // 工作身份（自称的角色）：只影响别的机器看到的「自称」，不参与授权
  'set-role': async (pc, { role }) => {
    const identity = pc.setRole(role);
    return { ok: true, identity, status: pc.status() };
  },

  'set-enabled': async (pc, { enabled }) => {
    const settings = pc.setEnabled(!!enabled);
    return { ok: true, settings, status: pc.status() };
  },

  'set-auto-turn': async (pc, { enabled }) => {
    const settings = pc.setAutoTurn(!!enabled);
    return { ok: true, settings };
  },

  // 授权默认值：未表态的对端是否放行。桌面由人确认（false），无人值守机器首启落 true
  // （见 `src/peer/boot.js#seedUnattendedTrust`）。明确 deny 两种模式下都拦。
  'set-auto-trust': async (pc, { enabled }) => {
    const settings = pc.setAutoTrust(!!enabled);
    return { ok: true, settings, status: pc.status() };
  },

  // 授权：首次来信 → 允许 / 拒绝；撤销回到「不认识」。
  trust: async (pc, { peerId, decision }) => {
    const r = await pc.trustPeer(peerId, decision);
    if (!r.ok) {
      const why = r.error === 'BAD_DECISION' ? '未知的授权决定' : '缺少要授权的机器标识（peerId）';
      return { ok: false, error: r.error, message: why };
    }
    return { ok: true, ...r.data, status: pc.status() };
  },

  untrust: async (pc, { peerId }) => {
    const r = pc.untrustPeer(peerId);
    if (!r.ok) return { ok: false, error: r.error, message: '缺少要撤销的机器标识（peerId）' };
    return { ok: true, ...r.data, status: pc.status() };
  },

  'trust-list': async (pc) => ({ ok: true, ...pc.trustList() }),

  'set-static-peers': async (pc, { peers }) => ({ ok: true, peers: pc.setStaticPeers(peers) }),

  send: async (pc, { peer, host, port, text, expectReply, timeoutMs, roomId }) => {
    const r = await pc.sendToPeer({ peer, host, port, text, expectReply, timeoutMs, roomId });
    return r.ok ? { ok: true, ...r } : { ok: false, error: r.error || 'PEER_SEND_FAILED' };
  },

  'send-session': async (pc, { sessionId, text }) => {
    const r = await pc.sendFromSession(sessionId, text);
    return r.ok ? { ok: true, ...r } : { ok: false, error: r.error || 'PEER_SEND_FAILED' };
  },

  'open-session': async (pc, { peer }) => {
    // 会话 = 与某个对端的对话线程；由 Main 建好并绑定，界面只负责切过去。
    const found = pc.findPeer(peer);
    if (!found) return { ok: false, error: 'PEER_NOT_FOUND' };
    const r = await pc.openSessionForPeer(found.peerId, found.name);
    return { ok: true, sessionId: r };
  },

  'link-session': async (pc, { sessionId, peerId }) => ({ ok: true, links: pc.linkSession(sessionId, peerId) }),

  'unlink-session': async (pc, { sessionId }) => ({ ok: true, links: pc.unlinkSession(sessionId) }),

  claim: async (pc, { action, kind, key, note, sessionId }) => {
    const r = await pc.claim({ action, kind, key, note, sessionId });
    return r.ok ? { ok: true, ...r } : { ok: false, error: r.error || 'CLAIM_FAILED', holders: r.holders || [] };
  },

  rooms: async (pc) => ({ ok: true, rooms: pc.rooms() }),

  'room-create': async (pc, { title, members }) => {
    const r = pc.createRoom({ title, members });
    return r.ok
      ? { ok: true, room: r.room, rooms: pc.rooms() }
      : { ok: false, error: r.error || 'ROOM_CREATE_FAILED' };
  },

  'room-close': async (pc, { roomId }) => {
    const r = pc.closeRoom(roomId);
    return r.ok ? { ok: true, room: r.room, rooms: pc.rooms() } : { ok: false, error: r.error || 'ROOM_CLOSE_FAILED' };
  },

  // 「发所有人」：逐台扇出，逐台结果原样回来（部分成功就是部分成功）
  'room-send': async (pc, { roomId, text }) => {
    const r = await pc.sendToRoom({ roomId, text });
    return r.ok
      ? { ok: true, delivered: r.delivered, failed: r.failed, partial: !!r.partial }
      : { ok: false, error: r.error || 'PEER_SEND_FAILED', delivered: r.delivered || [], failed: r.failed || [] };
  },

  'room-timeline': async (pc, { roomId, limit }) => {
    const r = await pc.roomTimeline({ roomId, limit });
    if (!r) return { ok: false, error: 'ROOM_NOT_FOUND' };
    return { ok: true, room: r.room, messages: r.messages };
  }
};

module.exports = { createPeerActions, PEER_ACTION_NAMES };

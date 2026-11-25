'use strict';

/**
 * 出站发送 —— 信封怎么发出去、发失败怎么归一、等答复怎么认领。
 *
 * 语义要点（改这里之前先读）：
 * - **传输层只负责送帧**：`client.send` 失败就把平台错误串原样向上抛，归一化只在这一层做一次
 *   （`PEER_UNREACHABLE` / `NOT_TRUSTED` / `ACK_TIMEOUT` 各有调用方语义，见 `normalizeSendResult`）；
 * - **「等答复」按信封 id 关联**，不是在出站连接上傻等：对端跑完一轮是 `reply` 信封回连到我的
 *   服务端（`handleReply` 拿 `inReplyTo` 来认领），慢轮次只会等到 `peerReplyTimeoutMs`；
 * - **扇出不中继**：给多个对端发就是多条 `sendToPeer`，没有中继、没有房间服务（见 docs/BOT-ROOM-PLAN.md）。
 *
 * 从 `peer/coordinator.js` 的闭包里抽出（2026-11-21 第四刀，**纯搬移不改逻辑**）：
 * `learnedPeers`（握手学到的反向通路）与 `awaitingReplies`（等答复表）跟着搬进来。
 */

const { ENVELOPE_TYPE, newMessageId, normalizeClaims } = require('./wire');

/**
 * @param {{
 *   store: any,
 *   emit: (payload: object) => void,
 *   limitInt: (key: string, fallback: number) => number,
 *   findPeer: (ref: string) => any,
 *   isStarted: () => boolean,
 *   getClient: () => any,
 *   setPeerClaims: (peerId: string, claims: any[]) => void,
 *   nowMs: () => number
 * }} host
 */
function createPeerOutbound(host) {
  const { store, emit, limitInt, findPeer, isStarted, getClient, setPeerClaims, nowMs } = host;

  /** 握手学到的对端（UDP 被挡时的反向通路；key = peerId） */
  /** @type {Map<string, { peerId: string, name: string, host: string, port: number, workspaceKey: string, at: number, role?: string }>} */
  const learnedPeers = new Map();
  /**
   * 正在等答复的出站信封：`信封 id → resolve`。
   * 对端跑完一轮是把 `reply` 信封回连到我的服务端（`handleReply`），手上有 `inReplyTo`
   * 指回这条信封 —— 所以「等答复」在这里按 id 关联，而不是在同一条出站连接上傻等。
   * @type {Map<string, (text: string) => void>}
   */
  const awaitingReplies = new Map();

  function registerPeerFromHandshake(peer) {
    if (!peer || !peer.peerId) return;
    const claims = normalizeClaims(peer.claims, limitInt('peerClaimTtlMs', 900000));
    setPeerClaims(peer.peerId, claims);
    const host = String(peer.host || '').replace(/^::ffff:/, '');
    const port = Number(peer.port) || 0;
    if (host && port) {
      learnedPeers.set(peer.peerId, {
        peerId: peer.peerId,
        name: String(peer.name || ''),
        role: String(peer.role || '').slice(0, 32),
        host,
        port,
        workspaceKey: String((peer.workspace && peer.workspace.key) || ''),
        at: nowMs()
      });
    }
  }

  /**
   * 发消息给对端。
   *
   * 形状收成一处内联对象（而不是 `{object}` + 一串分散的 `input.xxx` 标签）：
   * 字段散在注释各处时，加字段容易漏、也不容易一眼看全。
   *
   * @param {{ peer?: string, host?: string, port?: number, text?: string, sessionId?: string,
   *           expectReply?: boolean, timeoutMs?: number, type?: string, hops?: number,
   *           roomId?: string }} [input]
   *   `peer`：peerId / 名称 / host:port；`sessionId`：本地会话（对端回复落同一会话）；
   *   `roomId`：房间消息（Bot 面板的「房间 = 一次任务」，见 docs/BOT-ROOM-PLAN.md）
   */
  async function sendToPeer(input) {
    const i = input || /** @type {any} */ ({});
    if (!isStarted()) return { ok: false, error: 'PEER_DISABLED' };
    let host = String(i.host || '').trim();
    let port = Number(i.port) || 0;
    let peerName = '';
    let peerId = '';
    if (!host || !port) {
      const found = findPeer(i.peer);
      if (!found || !found.host || !found.port) return { ok: false, error: 'PEER_NOT_FOUND' };
      host = found.host;
      port = found.port;
      peerName = found.name;
      peerId = found.peerId;
    }
    const text = String(i.text || '');
    if (!text.trim()) return { ok: false, error: 'EMPTY_TEXT' };
    const maxChars = limitInt('peerMaxMessageChars', 8000);
    if (text.length > maxChars) {
      return { ok: false, error: 'TEXT_TOO_LONG', maxChars };
    }

    const sessionId = String(i.sessionId || '').trim();
    if (peerId && sessionId) store.linkSession(sessionId, peerId);

    // 房间校验：房间只影响「能不能以这个房间的名义发」，不放大权限。
    // 目标必须是成员（防止「拉进来的名单」和「实际收件人」对不上），已结束的房间不许再发。
    const roomId = String(i.roomId || '').trim();
    if (roomId) {
      const room = store.roomById(roomId);
      if (!room) return { ok: false, error: 'ROOM_NOT_FOUND' };
      if (room.status !== 'open') return { ok: false, error: 'ROOM_CLOSED' };
      if (!peerId || !room.members.includes(peerId)) return { ok: false, error: 'PEER_NOT_IN_ROOM' };
    }

    // 「等答复」的语义在这里（不是在传输层）：先用一个自己生成的信封 id 登记等待，
    // 对端的 `reply` 回来时靠 `inReplyTo` 认领（`handleReply`）。这样慢轮次只会等到
    // `peerReplyTimeoutMs`（默认 120s），不会被连接超时误报成「连不上」。
    const expectReply = !!i.expectReply;
    const replyWaitMs = Math.max(5000, Number(i.timeoutMs) || limitInt('peerReplyTimeoutMs', 120000));
    const envelopeId = expectReply ? newMessageId('pmsg') : undefined;
    /** @type {Promise<string|null> | null} */
    const replyPromise = expectReply
      ? new Promise((resolve) => {
          awaitingReplies.set(envelopeId, resolve);
          // 没人认领就自己收摊，别让这张表随会话历史一起长
          const sweep = setTimeout(() => {
            if (awaitingReplies.delete(envelopeId)) resolve(null);
          }, replyWaitMs + 1000);
          if (sweep && typeof sweep.unref === 'function') sweep.unref();
        })
      : null;

    const result = await getClient().send({
      host,
      port,
      id: envelopeId,
      type: i.type || ENVELOPE_TYPE.MESSAGE,
      text,
      fromSessionId: sessionId,
      toSessionId: '',
      hops: Number.isFinite(Number(i.hops)) ? Number(i.hops) + 1 : 1,
      roomId
    });
    if (result.peer) registerPeerFromHandshake({ ...result.peer, host, port });
    const normalized = normalizeSendResult(result, `${host}:${port}`);
    emit({
      kind: 'sent',
      peer: peerName || peerId || `${host}:${port}`,
      ok: normalized.ok,
      error: normalized.error || null,
      sessionId,
      roomId: roomId || null
    });
    if (!normalized.ok || !replyPromise) {
      if (envelopeId) awaitingReplies.delete(envelopeId);
      return normalized;
    }
    const reply = await Promise.race([
      replyPromise,
      new Promise((resolve) => setTimeout(() => resolve(null), replyWaitMs))
    ]);
    awaitingReplies.delete(envelopeId);
    return reply == null
      ? { ...normalized, reply: null, timeout: true }
      : { ...normalized, reply, timeout: false };
  }

  /**
   * 传输层错误统一成稳定错误码（**唯一口径**）。
   *
   * 为什么必须归一：socket 直接吐 `ECONNREFUSED` / `ETIMEDOUT` 这类平台串，调用方（工具层、
   * IPC、UI）只能靠猜；猜错就会把「对方刚关机」当成「参数写错了」而不重试。
   * 这里把「连不上 / 超时」统一成 `PEER_UNREACHABLE`，其余保持 `PEER_SEND_FAILED`。
   * 例外：`ACK_TIMEOUT` 是「已经连上、也发了，只是没等到回执」，属于投递失败，
   * 不能报成 unreachable —— 否则调用方会去查防火墙并盲目重试。
   */
  function normalizeSendResult(result, address) {
    if (!result || result.ok) return result;
    const raw = String(result.error || '');
    const unreachable = /ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH|ETIMEDOUT|EAI_AGAIN|TIMEOUT|socket hang up/i.test(
      raw
    );
    // NOT_TRUSTED = 对方还没确认我（对方会弹一次确认）；不是网络问题，也不要重试轰炸
    const code =
      raw === 'NOT_TRUSTED' || raw === 'ACK_TIMEOUT'
        ? raw
        : unreachable
          ? 'PEER_UNREACHABLE'
          : raw || 'PEER_SEND_FAILED';
    return {
      ...result,
      ok: false,
      // 保留原始串，便于排查（归一化不是掩盖）
      error: code,
      errorCode: code,
      detail: raw || undefined,
      address: address || undefined,
      retryable: code === 'PEER_UNREACHABLE'
    };
  }

  /** 会话里发消息：只对「已绑定 peer 的会话」生效，未绑定返回 PEER_NOT_LINKED。 */
  async function sendFromSession(sessionId, text) {
    const sid = String(sessionId || '').trim();
    const peerId = store.peerForSession(sid);
    if (!peerId) return { ok: false, error: 'PEER_NOT_LINKED' };
    return sendToPeer({ peer: peerId, text, sessionId: sid });
  }

  /** 握手学到的对端（`peersList` 合并在线列表要用；原来它直接摸 Map） */
  function learnedList() {
    return learnedPeers.values();
  }

  /**
   * 对端的 `reply` 回来时认领「等答复」（`handleReply` 用；会话里那份正文照旧留着）。
   * 没有人在等就什么都不做 —— 这不是错误。
   */
  function resolveReply(inReplyTo, text) {
    const waitingFor = String(inReplyTo || '');
    if (!waitingFor) return false;
    const settle = awaitingReplies.get(waitingFor);
    if (!settle) return false;
    awaitingReplies.delete(waitingFor);
    settle(String(text || ''));
    return true;
  }

  return {
    registerPeerFromHandshake,
    sendToPeer,
    normalizeSendResult,
    sendFromSession,
    learnedList,
    resolveReply
  };
}

module.exports = { createPeerOutbound };

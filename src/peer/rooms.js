'use strict';

/**
 * 房间（agent 聊天室）—— **唯一语义所在**。
 *
 * 房间 = 一次任务的**本机视图**：成员是 peerId，语义（谁能进来、满了没有、关掉之后还能不能往里发）
 * 只在这里。消息落库**不带** roomId：时间线由「成员会话 + 房间存活时间窗」聚合
 * （见 docs/BOT-ROOM-PLAN.md §4）。为什么不在 Renderer 判：房间会是「发不出去 / 只投递不自动跑」
 * 的来源，那和跳数、小时预算是同一类闸，闸只能有一个地方。
 *
 * 从 `peer/coordinator.js` 的闭包里抽出（2026-11-21，**纯搬移不改逻辑**）：房间只依赖下面这 9 个
 * 宿主能力，用显式 host 传进来 —— 不再靠「同一个闭包里什么都够得着」。
 */

const crypto = require('crypto');

/**
 * @param {{
 *   store: any,
 *   rpc: (method: string, params?: object) => Promise<any>,
 *   findPeer: (ref: string) => any,
 *   sendToPeer: (input: object) => Promise<any>,
 *   emit: (payload: object) => void,
 *   nowMs: () => number,
 *   workspaceInfo: () => any,
 *   limitInt: (key: string, fallback: number) => number,
 *   isStarted: () => boolean
 * }} host
 */
function createPeerRooms(host) {
  const { store, rpc, findPeer, sendToPeer, emit, nowMs, workspaceInfo, limitInt, isStarted } = host;

  // 房间（agent 聊天室）
  //
  // 房间 = 一次任务的**本机视图**：成员是 peerId，语义（谁能进来、满了没有、
  // 关掉之后还能不能往里发）只在这里。消息落库**不带** `roomId`：时间线由
  // 「成员会话 + 房间存活时间窗」聚合（见 docs/BOT-ROOM-PLAN.md §4）。
  //
  // 为什么不在 Renderer 判：房间会是「发不出去 / 只投递不自动跑」的来源，
  // 那和跳数、小时预算是同一类闸，闸只能有一个地方。

  function newRoomId() {
    return `r-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
  }

  function roomsList() {
    return store.rooms().map((room) => ({ ...room, active: room.status === 'open' }));
  }

  /** 房间成员：认名字也认 peerId（与 `peer_send` 的对端写法一致）。 */
  function resolveRoomMembers(rawMembers) {
    const members = [];
    for (const item of Array.isArray(rawMembers) ? rawMembers : []) {
      const found = findPeer(item);
      const peerId = found ? found.peerId : String(item || '').trim();
      if (!peerId || members.includes(peerId)) continue;
      // 不认识的名字直接在下面按「未确认」拒掉；这里只区分「找不到」与「没允许」
      if (!found && !/^peer_[0-9a-f]{8,}$/.test(peerId)) return { ok: false, error: 'PEER_NOT_FOUND', peer: String(item || '') };
      if (!store.isTrusted(peerId)) return { ok: false, error: 'PEER_NOT_TRUSTED', peerId };
      members.push(peerId);
    }
    return { ok: true, members };
  }

  /**
   * 建房间。**不改任何机器状态**：只写本机的房间清单。
   * @param {{ title?: string, members?: string[] }} input
   */
  function createRoom(input) {
    const i = input || /** @type {any} */ ({});
    if (!isStarted()) return { ok: false, error: 'PEER_DISABLED' };
    const maxMembers = limitInt('peerRoomMaxMembers', 8);
    const maxActive = limitInt('peerRoomMaxActiveRooms', 4);
    const resolved = resolveRoomMembers(i.members);
    if (!resolved.ok) return resolved;
    const members = resolved.members || [];
    if (!members.length) return { ok: false, error: 'ROOM_NO_MEMBERS' };
    if (members.length > maxMembers) {
      return { ok: false, error: 'ROOM_TOO_MANY_MEMBERS', maxMembers };
    }
    const active = store.rooms().filter((r) => r.status === 'open');
    if (active.length >= maxActive) return { ok: false, error: 'ROOM_LIMIT', maxActiveRooms: maxActive };
    const title = String(i.title || '').replace(/\s+/g, ' ').trim().slice(0, 80);
    const room = store.createRoom({
      roomId: newRoomId(),
      title: title || `与 ${members.length} 台 agent 的任务`,
      projectKey: workspaceInfo().key || '',
      members,
      createdAt: nowMs()
    });
    if (!room) return { ok: false, error: 'ROOM_CREATE_FAILED' };
    store.pruneRooms(limitInt('peerRoomKeepMax', 64));
    emit({ kind: 'room-created', room });
    return { ok: true, room };
  }

  /** 结束房间：只改状态，不删会话、不删消息。幂等。 */
  function closeRoom(roomId) {
    const room = store.closeRoom(roomId);
    if (!room) return { ok: false, error: 'ROOM_NOT_FOUND' };
    emit({ kind: 'room-closed', room });
    return { ok: true, room };
  }

  function peerNameOf(peerId) {
    const found = findPeer(peerId);
    if (found && found.name) return found.name;
    const entry = store.trustEntries().find((t) => t.peerId === peerId);
    return (entry && entry.name) || peerId;
  }

  /** 对方的「自称身份」。拿不到就是空串——**不做兜底猜测**（不知道就不写）。 */
  function peerRoleOf(peerId) {
    const found = findPeer(peerId);
    return String((found && found.role) || '').trim();
  }

  /**
   * 「发所有人」：仍然是**逐条 `peer:send`**，不加中继、不加房间服务。
   *
   * 两条硬规矩：
   * - **并发发**（每台一个独立 WS 连接）：串行会让最后那台等前七台的握手超时叠起来；
   * - **不等对方跑完一轮**（不用 expectReply）：扇出再等回复会互相拖死，答复会自己回到
   *   各自「与 X 的对话」里，房间时间线照样看得见。
   *
   * 部分成功就是部分成功：逐台结果原样返回，失败原因不吞、不重试。
   */
  async function sendToRoom(input) {
    const i = input || /** @type {any} */ ({});
    if (!isStarted()) return { ok: false, error: 'PEER_DISABLED' };
    const roomId = String(i.roomId || '').trim();
    const text = String(i.text || '');
    const room = store.roomById(roomId);
    if (!room) return { ok: false, error: 'ROOM_NOT_FOUND' };
    if (room.status !== 'open') return { ok: false, error: 'ROOM_CLOSED' };
    if (!text.trim()) return { ok: false, error: 'EMPTY_TEXT' };

    const results = await Promise.all(
      room.members.map(async (peerId) => {
        const name = peerNameOf(peerId);
        const sessionId = store.sessionsForPeer(peerId)[0] || '';
        let r = null;
        try {
          r = await sendToPeer({ peer: peerId, text, roomId, sessionId });
        } catch {
          // 单台抛异常不许把整轮广播带崩（client 未就绪 / socket 内部错误）：
          // 一台失败就是一条失败记录，其余照常报告。
          r = { ok: false, error: 'PEER_SEND_FAILED' };
        }
        if (!r || !r.ok) {
          return { peerId, name, ok: false, error: String((r && r.error) || 'PEER_SEND_FAILED') };
        }
        // **只有真送达才记「我说了什么」**：没送到的广播不许在会话/时间线上留痕，
        // 否则事后回看会以为对方收到过。
        if (sessionId) {
          try {
            await rpc('memory.message_append', { sessionId, role: 'user', content: text, reasoning: null });
          } catch {
            // 会话被删 / 库回退：消息已经送达，只是本机这条线看不到这句
          }
        }
        return { peerId, name, ok: true, error: null };
      })
    );

    const delivered = results.filter((r) => r.ok);
    const failed = results.filter((r) => !r.ok);
    emit({
      kind: 'room-sent',
      roomId,
      delivered: delivered.length,
      failed: failed.length,
      peerIds: delivered.map((r) => r.peerId)
    });
    return {
      ok: delivered.length > 0,
      error: delivered.length ? undefined : (failed[0] && failed[0].error) || 'PEER_SEND_FAILED',
      delivered,
      failed,
      partial: delivered.length > 0 && failed.length > 0
    };
  }

  /**
   * 房间时间线：**算出来的，不是存下来的**。
   *
   * 每个成员各有一条「与 X 的对话」会话（`links`），房间存活期间那些会话里的消息
   * 就是这个房间的对话。没有 `meta.roomId`、没有新表 —— 详见 docs/BOT-ROOM-PLAN.md §4。
   * 结束的房间按 `[createdAt, closedAt]` 截断，开着的房间只截左边界。
   */
  async function roomTimeline(input) {
    const i = input || /** @type {any} */ ({});
    const room = store.roomById(String(i.roomId || '').trim());
    if (!room) return null;
    const limit = Math.min(400, Math.max(1, Number(i.limit) || 120));
    const from = Number(room.createdAt) || 0;
    const to = room.status === 'closed' ? Number(room.closedAt) || 0 : Number.MAX_SAFE_INTEGER;
    const perSession = Math.min(200, Math.max(20, limit));
    /** @type {Array<{ peerId: string, peerName: string, sessionId: string, role: string, content: string, at: number, peerRole?: string }>} */
    const rows = [];
    for (const peerId of room.members) {
      const name = peerNameOf(peerId);
      const role = peerRoleOf(peerId);
      for (const sessionId of store.sessionsForPeer(peerId)) {
        let list = [];
        try {
          const res = await rpc('memory.messages_recent', { sessionId, limit: perSession });
          list = Array.isArray(res) ? res : [];
        } catch {
          // 会话被删 / 库被回退：这条线没有消息，不影响别的成员
          list = [];
        }
        for (const m of list) {
          const at = Number(m && m.createdAt) || 0;
          if (at < from || at > to) continue;
          rows.push({
            peerId,
            peerName: name,
            peerRole: role,
            sessionId,
            role: String((m && m.role) || ''),
            content: String((m && m.content) || ''),
            at
          });
        }
      }
    }
    rows.sort((a, b) => a.at - b.at);
    return { room, messages: rows.slice(-limit) };
  }

  async function appendInbound(sessionId, content) {
    await rpc('memory.message_append', {
      sessionId,
      role: 'user',
      content,
      reasoning: null
    });
  }

  /**
   * 投递给本机会话的正文。**结构化抬头**（不是关键词判断）：模型据此知道
   * 「谁在跟我说话、几跳了、怎么回」。正文原样保留，不加工对方的措辞。
   */
  function inboundText(peer, env, sessionId, roomTitle) {
    const hops = Number(env.hops) || 0;
    const role = String(peer.role || '').trim();
    const head = [
      `【内网 Agent 来信 · ${peer.name || peer.peerId}${role ? `（自称：${role}）` : ''}${roomTitle ? ` · 房间「${roomTitle}」` : ''}】`,
      `来源 peerId：${peer.peerId}${sessionId ? `；对端会话：${env.from.sessionId || '-'}` : ''}；跳数：${hops}`
    ].join('\n');
    const tail = '（你的最终回复会原样回传给对方；需要继续追问可直接再发 peer_send。）';
    return `${head}\n\n${env.text || ''}\n\n${tail}`;
  }

  return {
    newRoomId,
    roomsList,
    resolveRoomMembers,
    createRoom,
    closeRoom,
    peerNameOf,
    peerRoleOf,
    sendToRoom,
    roomTimeline,
    appendInbound,
    inboundText
  };
}

module.exports = { createPeerRooms };

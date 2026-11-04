'use strict';

// @ts-check
/**
 * 内网 peer 的 IPC（Renderer ↔ Main）。
 *
 * 形状约定与其它 IPC 一致：`{ ok: true, ... }` / `{ ok: false, error }`。
 * **不在这里做业务判定**：能不能发、能不能自动跑一轮、租约给不给，全部在
 * `src/peer/coordinator.js`。IPC 只做「参数整形 + 协调器调用 + 结果透传」，
 * 让 Renderer 与模型工具看到完全相同的语义（tools: peer_list / peer_send / peer_claim）。
 */

/**
 * @param {object} ctx
 * @param {import('electron').IpcMain} ctx.ipcMain
 * @param {() => any} ctx.getPeerCoordinator
 */
function registerPeerIpc(ctx) {
  const { ipcMain, getPeerCoordinator } = ctx;

  function coordinator() {
    return getPeerCoordinator ? getPeerCoordinator() : null;
  }

  function disabled() {
    return { ok: false, error: '内网互通未启用', errorCode: 'PEER_UNAVAILABLE' };
  }

  function wrap(fn) {
    return async (_evt, payload) => {
      const pc = coordinator();
      if (!pc) return disabled();
      try {
        return await fn(pc, payload && typeof payload === 'object' ? payload : {});
      } catch (err) {
        return { ok: false, error: err && err.message ? err.message : String(err) };
      }
    };
  }

  ipcMain.handle(
    'peer:status',
    wrap(async (pc) => ({ ok: true, status: pc.status() }))
  );

  ipcMain.handle(
    'peer:refresh',
    wrap(async (pc) => {
      pc.refresh();
      return { ok: true, status: pc.status() };
    })
  );

  ipcMain.handle(
    'peer:set-name',
    wrap(async (pc, { name }) => {
      const identity = pc.setName(name);
      return { ok: true, identity, status: pc.status() };
    })
  );

  // 工作身份（自称的角色）：只影响别的机器看到的「自称」，不参与授权
  ipcMain.handle(
    'peer:set-role',
    wrap(async (pc, { role }) => {
      const identity = pc.setRole(role);
      return { ok: true, identity, status: pc.status() };
    })
  );

  ipcMain.handle(
    'peer:set-enabled',
    wrap(async (pc, { enabled }) => {
      const settings = pc.setEnabled(!!enabled);
      return { ok: true, settings, status: pc.status() };
    })
  );

  ipcMain.handle(
    'peer:set-auto-turn',
    wrap(async (pc, { enabled }) => {
      const settings = pc.setAutoTurn(!!enabled);
      return { ok: true, settings };
    })
  );

  // 授权：首次来信 → 允许 / 拒绝；撤销回到「不认识」。取代了 P0 的配对码（copy/rotate/set-token 三个通道已删）。
  ipcMain.handle(
    'peer:trust',
    wrap(async (pc, { peerId, decision }) => {
      const r = await pc.trustPeer(peerId, decision);
      if (!r.ok) {
        const why =
          r.error === 'BAD_DECISION' ? '未知的授权决定' : '缺少要授权的机器标识（peerId）';
        return { ok: false, error: r.error, message: why };
      }
      return { ok: true, ...r.data, status: pc.status() };
    })
  );

  ipcMain.handle(
    'peer:untrust',
    wrap(async (pc, { peerId }) => {
      const r = pc.untrustPeer(peerId);
      if (!r.ok) return { ok: false, error: r.error, message: '缺少要撤销的机器标识（peerId）' };
      return { ok: true, ...r.data, status: pc.status() };
    })
  );

  ipcMain.handle(
    'peer:trust-list',
    wrap(async (pc) => ({ ok: true, ...pc.trustList() }))
  );

  ipcMain.handle(
    'peer:set-static-peers',
    wrap(async (pc, { peers }) => ({ ok: true, peers: pc.setStaticPeers(peers) }))
  );

  ipcMain.handle(
    'peer:send',
    wrap(async (pc, { peer, host, port, text, expectReply, timeoutMs, roomId }) => {
      const r = await pc.sendToPeer({ peer, host, port, text, expectReply, timeoutMs, roomId });
      return r.ok ? { ok: true, ...r } : { ok: false, error: r.error || 'PEER_SEND_FAILED' };
    })
  );

  ipcMain.handle(
    'peer:send-session',
    wrap(async (pc, { sessionId, text }) => {
      const r = await pc.sendFromSession(sessionId, text);
      return r.ok ? { ok: true, ...r } : { ok: false, error: r.error || 'PEER_SEND_FAILED' };
    })
  );

  ipcMain.handle(
    'peer:open-session',
    wrap(async (pc, { peer }) => {
      // 会话 = 与某个对端的对话线程；由 Main 建好并绑定，Renderer 只负责切过去。
      const found = pc.findPeer(peer);
      if (!found) return { ok: false, error: 'PEER_NOT_FOUND' };
      const r = await pc.openSessionForPeer(found.peerId, found.name);
      return { ok: true, sessionId: r };
    })
  );

  ipcMain.handle(
    'peer:link-session',
    wrap(async (pc, { sessionId, peerId }) => ({ ok: true, links: pc.linkSession(sessionId, peerId) }))
  );

  ipcMain.handle(
    'peer:unlink-session',
    wrap(async (pc, { sessionId }) => ({ ok: true, links: pc.unlinkSession(sessionId) }))
  );

  ipcMain.handle(
    'peer:claim',
    wrap(async (pc, { action, kind, key, note, sessionId }) => {
      const r = await pc.claim({ action, kind, key, note, sessionId });
      return r.ok ? { ok: true, ...r } : { ok: false, error: r.error || 'CLAIM_FAILED', holders: r.holders || [] };
    })
  );

  // 房间（agent 聊天室）：一次任务一个。校验（成员是否已确认 / 上限 / 是否已结束）全在协调器。
  ipcMain.handle(
    'peer:rooms',
    wrap(async (pc) => ({ ok: true, rooms: pc.rooms() }))
  );

  ipcMain.handle(
    'peer:room-create',
    wrap(async (pc, { title, members }) => {
      const r = pc.createRoom({ title, members });
      return r.ok ? { ok: true, room: r.room, rooms: pc.rooms() } : { ok: false, error: r.error || 'ROOM_CREATE_FAILED' };
    })
  );

  ipcMain.handle(
    'peer:room-close',
    wrap(async (pc, { roomId }) => {
      const r = pc.closeRoom(roomId);
      return r.ok ? { ok: true, room: r.room, rooms: pc.rooms() } : { ok: false, error: r.error || 'ROOM_CLOSE_FAILED' };
    })
  );

  // 「发所有人」：逐台扇出，逐台结果原样回来（部分成功就是部分成功）
  ipcMain.handle(
    'peer:room-send',
    wrap(async (pc, { roomId, text }) => {
      const r = await pc.sendToRoom({ roomId, text });
      return r.ok
        ? { ok: true, delivered: r.delivered, failed: r.failed, partial: !!r.partial }
        : { ok: false, error: r.error || 'PEER_SEND_FAILED', delivered: r.delivered || [], failed: r.failed || [] };
    })
  );

  ipcMain.handle(
    'peer:room-timeline',
    wrap(async (pc, { roomId, limit }) => {
      const r = await pc.roomTimeline({ roomId, limit });
      if (!r) return { ok: false, error: 'ROOM_NOT_FOUND' };
      return { ok: true, room: r.room, messages: r.messages };
    })
  );
}

module.exports = { registerPeerIpc };

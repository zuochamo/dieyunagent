'use strict';

/**
 * 内网 agent 互通：peer_*。语义全在 src/peer/coordinator.js，这里只做形状转换与文案。
 *
 * 从 `tool-bridge-main.js` 的 1036 行 switch 里拆出（曾零直测）：现在由
 * `scripts/test-tool-bridge-handlers.cjs` 覆盖参数翻译与形状转换。
 * 依赖一律由 `shared` 传入（不 require），所以本文件能被单测直接装进沙箱。
 *
 * @param {object} shared 工具桥闭包里的依赖与取值器（见 main-tools/index.js）
 */
function createPeerHandlers(shared) {
  const {
    peerCoordinator
  } = shared;

  return {
    peer_list: async (a, ctx) => {
        if (!peerCoordinator) return { ok: false, error: '内网互通未启用', errorCode: 'PEER_UNAVAILABLE' };
        let peers = peerCoordinator.peers();
        if (a.refresh && typeof peerCoordinator.refresh === 'function') {
          peerCoordinator.refresh();
          peers = peerCoordinator.peers();
        }
        if (a.sameProjectOnly) peers = peers.filter((p) => p.sameWorkspace);
        const status = typeof peerCoordinator.status === 'function' ? peerCoordinator.status() : {};
        const nameOf = (id) => {
          const hit = peers.find((p) => p.peerId === id);
          if (hit && hit.name) return hit.name;
          const trusted = (status.trusted || []).find((t) => t.peerId === id);
          return (trusted && trusted.name) || id;
        };
        // 房间也在这里列：`peer_send` 的 roomId 就从这儿来（否则模型无从得知房间 id）
        const rooms = (status.rooms || [])
          .filter((r) => r && r.status === 'open')
          .map((r) => ({
            roomId: r.roomId,
            title: r.title,
            members: (r.members || []).map(nameOf),
            memberCount: (r.members || []).length
          }));
        return {
          ok: true,
          me: { peerId: status.peerId || '', name: status.name || '', role: status.role || '' },
          total: peers.length,
          peers: peers.map((p) => ({
            name: p.name,
            peerId: p.peerId,
            // 对方自报的工作身份（界面标「自称」）：只作参考，不决定任何权限
            role: p.role || '',
            address: p.host && p.port ? `${p.host}:${p.port}` : '',
            sameProject: !!p.sameWorkspace,
            lastSeenSec: Math.max(0, Math.round((Date.now() - Number(p.lastSeenAt || 0)) / 1000)),
            claims: (p.claims || []).map((c) => ({
              kind: c.kind,
              key: c.key,
              note: c.note || '',
              expiresInSec: Math.max(0, Math.round((Number(c.expiresAt || 0) - Date.now()) / 1000))
            }))
          })),
          rooms,
          note: peers.length
            ? '同项目（sameProject=true）的对端可以问它正在改什么；它已声明的租约见 claims。' +
              '要一次交代给几个人：peer_send 只给 roomId（不给 peer）就是发给房间里所有人，结果按台返回。'
            : '当前没有发现其他在线 Agent。若确定对方在线，可试 refresh=true 再列一次。'
        };
    },
    peer_claim: async (a, ctx) => {
        if (!peerCoordinator) return { ok: false, error: '内网互通未启用', errorCode: 'PEER_UNAVAILABLE' };
        const action = String(a.action || 'list');
        const r = await peerCoordinator.claim({
          action,
          kind: a.kind,
          key: a.key,
          note: a.note,
          sessionId: ctx.sessionId
        });
        if (r.ok) return r;
        const holders = (r.holders || []).map((c) => ({
          peerName: c.peerName || c.peerId,
          kind: c.kind,
          key: c.key,
          note: c.note || ''
        }));
        return {
          ok: false,
          error: r.error === 'CLAIM_CONFLICT' ? '该文件/任务已被同项目的其他 Agent 声明' : String(r.error || '申领失败'),
          errorCode: String(r.error || 'CLAIM_FAILED'),
          retryable: false,
          // 归一化失败信封会收窄字段，结构化细节一律走 diagnostics（模型能看到、日志也留得住）
          diagnostics: holders.length ? { holders } : undefined,
          suggestedFix:
            r.error === 'CLAIM_CONFLICT'
              ? `先用 peer_send 问 ${holders.map((h) => h.peerName).join('、') || '对方'} 能否让给你，或改做别的文件；不要绕过租约直接改。`
              : undefined
        };
    },
    peer_send: async (a, ctx) => {
        if (!peerCoordinator) return { ok: false, error: '内网互通未启用', errorCode: 'PEER_UNAVAILABLE' };
        const target = String(a.peer || '').trim();
        const host = String(a.host || '').trim();
        const port = Number(a.port) || 0;
        const knownPeers = () => peerCoordinator.peers().map((p) => ({ name: p.name, peerId: p.peerId }));
        // 给了房间、没给具体对端 = 发给房间里所有人（扇出；逐台结果如实返回）
        const roomForAll = String(a.roomId || '').trim();
        if (!target && !(host && port) && roomForAll) {
          const roomRes = await peerCoordinator.sendToRoom({ roomId: roomForAll, text: a.text });
          if (roomRes.ok) {
            return {
              ok: true,
              delivered: (roomRes.delivered || []).map((x) => x.name),
              failed: (roomRes.failed || []).map((x) => ({ name: x.name, error: x.error })),
              partial: !!roomRes.partial,
              note: roomRes.partial
                ? `发给了 ${roomRes.delivered.length} 台，${roomRes.failed.length} 台没送达（见 failed）。房间不会自动重试。`
                : undefined
            };
          }
          const why =
            roomRes.error === 'ROOM_CLOSED'
              ? '这个房间已经结束了，不能再往里发'
              : roomRes.error === 'ROOM_NOT_FOUND'
                ? '没有这个房间（房间清单在 peer_list 的 rooms 里，id 以 r- 开头）'
                : roomRes.error === 'EMPTY_TEXT'
                  ? '要发的内容是空的'
                  : roomRes.error === 'PEER_DISABLED'
                    ? '内网互通没开启（连接 → Agent 互通 → 启用）'
                    : `全都没送达：${(roomRes.failed || []).map((x) => `${x.name}(${x.error})`).join('、') || roomRes.error}`;
          return {
            ok: false,
            error: why,
            errorCode: String(roomRes.error || 'PEER_SEND_FAILED'),
            retryable: false,
            diagnostics: { failed: roomRes.failed || [] }
          };
        }
        if (!target && !(host && port)) {
          const peers = knownPeers();
          return {
            ok: false,
            error: `缺少对端：请给 peer（名称/peerId）或 host+port${peers.length ? `。当前在线：${peers.map((p) => p.name).join('、')}` : '（当前没有其他在线 Agent）'}`,
            errorCode: 'MISSING_ARG',
            retryable: false,
            diagnostics: { peers }
          };
        }
        const r = await peerCoordinator.sendToPeer({
          peer: target,
          host,
          port,
          text: a.text,
          expectReply: !!a.expectReply,
          timeoutMs: a.timeoutMs,
          roomId: a.roomId,
          sessionId: ctx.sessionId
        });
        if (r.ok) {
          return {
            ok: true,
            delivered: true,
            peer: r.peer ? r.peer.name || r.peer.peerId : target,
            reply: r.reply == null ? null : String(r.reply),
            waitedForReply: !!a.expectReply,
            timedOut: r.timeout === true,
            note:
              a.expectReply && r.reply == null && r.timeout
                ? '对方收下了消息，但在超时前没跑完一轮；稍后它的答复会作为你的下一条消息出现。'
                : undefined
          };
        }
        return {
          ok: false,
          error:
            r.error === 'PEER_NOT_FOUND'
              ? '没找到这个对端（可能不在线，或名字不对）'
              : r.error === 'PEER_UNREACHABLE'
                ? '连不上这个对端（不在线 / 防火墙挡住了 peer 端口）'
                : r.error === 'ACK_TIMEOUT'
                  ? '消息发到了，但对端没在规定时间内回执（它可能正忙或刚重启）；这不是网络不通，稍后再试'
                  : r.error === 'ROOM_CLOSED'
                  ? '这个房间已经结束了，不能再往里发；要接着干就新开一个房间'
                  : r.error === 'PEER_NOT_IN_ROOM'
                    ? '这个对端不在该房间的成员里（先在 Bot 面板把它拉进来，或去掉 roomId 单独发）'
                    : r.error === 'ROOM_NOT_FOUND'
                      ? '没有这个房间（房间清单在 Bot 面板，id 以 r- 开头）'
                      : r.error === 'NOT_TRUSTED'
                        ? '对方还没确认这台机器（它那边会弹一次「允许 / 拒绝」，通过后会补投这条消息）'
                        : String(r.error || '发送失败'),
          errorCode: String(r.errorCode || r.error || 'PEER_SEND_FAILED'),
          retryable: r.retryable === true,
          diagnostics: { peers: knownPeers(), address: r.address, detail: r.detail }
        };
    }
  };
}

module.exports = { createPeerHandlers };

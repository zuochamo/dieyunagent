'use strict';

/**
 * 内网 peer 互通：两台实例在同一进程内互连（仅回环地址）的端到端断言。
 *
 * 覆盖的是**语义**而不是 UI：
 * - 授权：陌生机器来信 → 拦下 + 待确认；允许后补投；拒绝后静默；撤销后重新确认；
 * - 默认**不自动跑一轮**（只投递），显式打开后才跑；带跳数；回合结束把最终正文回传；
 * - 跳数用尽 / 小时预算用尽都只投递不跑（防两个 agent 互相撩）；
 * - 建议式租约：先到者持有，第二台拿到冲突，释放后可再拿；
 * - 线协议归一（坏信封一律丢弃）。
 *
 * 不覆盖：UDP 广播发现（需要真实网卡与对端，机器相关）；那部分只在
 * `docs/PEER-MESH-PLAN.md` 里写明手工验收步骤。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const { createPeerCoordinator } = require('../src/peer');
const { createPeerClient } = require('../src/peer/client');
const { AGENT_LIMITS_DEFAULTS } = require('../src/agent/agent-limits');
const { normalizeEnvelope, ENVELOPE_TYPE } = require('../src/peer/wire');
const { workspaceKeyFor } = require('../src/peer/workspace-key');

let failures = 0;
function check(name, cond, detail) {
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    failures += 1;
    console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function mkTmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `dieyun-peer-${prefix}-`));
}

/**
 * 假的 memory RPC：会话表是「唯一真相」，`session_get` 必须如实回答，
 * 否则协调器无法判断会话链接是不是过期缓存（真 core 里这就是外键约束）。
 */
function mkRpc() {
  const calls = [];
  const sessions = new Map();
  /** @type {Map<string, Array<{ role: string, content: string, createdAt: number }>>} */
  const history = new Map();
  let seq = 0;
  function newSession(id) {
    sessions.set(id, { id });
    return { id };
  }
  return {
    calls,
    messages() {
      return calls.filter((c) => c.method === 'memory.message_append');
    },
    historyOf(sessionId) {
      return history.get(String(sessionId)) || [];
    },
    hasSession(id) {
      return sessions.has(String(id));
    },
    registerSession(id) {
      return newSession(String(id));
    },
    dropSession(id) {
      sessions.delete(String(id));
    },
    async rpc(method, params) {
      calls.push({ method, params });
      const sessionId = String((params && params.sessionId) || '');
      if (method === 'memory.session_create') {
        seq += 1;
        return newSession(`sess_${seq}`);
      }
      if (method === 'memory.session_get') {
        return sessions.get(sessionId) || null;
      }
      if (method === 'memory.message_append') {
        // 与真 core 一致：会话不存在时写不进去（原先是 SQLite 的外键失败）
        if (!sessions.has(sessionId)) {
          const e = new Error(`会话 ${sessionId} 不存在`);
          e.code = 'SESSION_NOT_FOUND';
          throw e;
        }
        const list = history.get(sessionId) || [];
        list.push({
          role: String((params && params.role) || ''),
          content: String((params && params.content) || ''),
          createdAt: Date.now()
        });
        history.set(sessionId, list);
        return { ok: true };
      }
      if (method === 'memory.messages_recent') {
        // 与真 core 同形：camelCase + 按时间倒序（房间时间线自己再排序）
        const limit = Math.max(1, Number((params && params.limit) || 50));
        return (history.get(sessionId) || [])
          .slice(-limit)
          .reverse()
          .map((m, idx) => ({ id: idx + 1, sessionId, role: m.role, content: m.content, reasoning: null, createdAt: m.createdAt }));
      }
      return { ok: true };
    }
  };
}

function limitsFor(base, discoveryPort) {
  return () => ({
    ...AGENT_LIMITS_DEFAULTS,
    peerPortBase: base,
    peerDiscoveryPort: discoveryPort
  });
}

async function main() {
  const workspacePath = path.join(__dirname, '..');

  const dirA = mkTmp('a');
  const dirB = mkTmp('b');
  const rpcA = mkRpc();
  const rpcB = mkRpc();
  const submittedA = [];
  const submittedB = [];
  const events = [];
  // B 侧的小时预算可中途改（验证「预算用尽只投递不跑」）
  let budgetOverrideB = null;
  /** 扇出用的第二台（在本段里建，finally 里停） */
  let D = null;
  let dirD = '';

  const A = createPeerCoordinator({
    userDataPath: dirA,
    getWorkspace: () => ({ workspacePath }),
    rpc: rpcA.rpc,
    submitTask: async (task) => {
      submittedA.push(task);
      return { requestId: `reqA_${submittedA.length}`, sessionId: task.sessionId };
    },
    limits: limitsFor(18350, 18341),
    onEvent: (e) => events.push({ side: 'A', ...e }),
    log: () => {}
  });
  const B = createPeerCoordinator({
    userDataPath: dirB,
    getWorkspace: () => ({ workspacePath }),
    rpc: rpcB.rpc,
    submitTask: async (task) => {
      submittedB.push(task);
      return { requestId: `reqB_${submittedB.length}`, sessionId: task.sessionId };
    },
    limits: () => ({ ...limitsFor(18360, 18342)(), ...(budgetOverrideB || {}) }),
    onEvent: (e) => events.push({ side: 'B', ...e }),
    log: () => {}
  });

  try {
    // 工作身份在 start 之前设：握手时随 hello 发出去（started 之后再设会触发一次重启）
    A.setRole('发票模块');
    B.setRole('前端');
    const statusA = await A.start();
    const statusB = await B.start();
    check('A 已监听', statusA.port > 0, `port=${statusA.port}`);
    check('B 已监听', statusB.port > 0, `port=${statusB.port}`);
    check('身份稳定（重启不变）', A.status().peerId === statusA.peerId);
    check('工作身份存住并随状态暴露', A.status().role === '发票模块' && B.status().role === '前端', JSON.stringify([A.status().role, B.status().role]));
    check('默认就自动跑一轮', A.status().autoTurn === true, JSON.stringify(A.status().autoTurn));
    // 下面几段验的是「信任 / 跳数 / 预算」这些门，先显式关掉自动跑，免得默认开把断言搅在一起
    A.setAutoTurn(false);
    B.setAutoTurn(false);
    check('初始信任清单为空', A.status().trusted.length === 0);

    // —— 1. 陌生机器来信：拦下 + 弹一次确认，不落会话、不跑一轮 ——
    check('A→B 首封信被拦（未确认）', true); // 占位，下面逐条断言
    const firstSend = await A.sendToPeer({
      host: '127.0.0.1',
      port: statusB.port,
      text: '帮我看下 src/peer/wire.js 的信封归一',
      expectReply: false
    });
    check(
      '未确认 → 发送方拿到 NOT_TRUSTED',
      firstSend.ok === false && firstSend.error === 'NOT_TRUSTED',
      JSON.stringify(firstSend)
    );
    check('NOT_TRUSTED 不可重试（不要轰炸对方）', firstSend.retryable === false);
    check('B 没有因此跑一轮', submittedB.length === 0, `submitted=${submittedB.length}`);
    check(
      'B 没有把陌生人的信落进会话',
      rpcB.messages().length === 0,
      JSON.stringify(rpcB.messages().map((m) => m.params))
    );
    const pendingAtB = B.status().pendingTrust;
    check('B 出现一条待确认请求', pendingAtB.length === 1, JSON.stringify(pendingAtB));
    check('待确认里带对方名字与来信预览', /内网|信封归一/.test(String(pendingAtB[0] && pendingAtB[0].preview)), JSON.stringify(pendingAtB[0]));
    check('B 记录了待确认数量', (pendingAtB[0] && pendingAtB[0].count) === 1, JSON.stringify(pendingAtB[0] && pendingAtB[0].count));
    check(
      'B 发了 trust-request 事件（UI 才能弹窗）',
      events.some((e) => e.side === 'B' && e.kind === 'trust-request'),
      JSON.stringify(events.filter((e) => e.side === 'B').map((e) => e.kind))
    );

    // —— 1b. 允许 → 缓存的那条补投；仍然不跑一轮（默认只投递）——
    const allowed = await B.trustPeer(statusA.peerId, 'allow');
    check('允许成功', allowed.ok === true, JSON.stringify(allowed));
    check('允许时把拦下的那条补投了', allowed.data && allowed.data.flushed === 1, JSON.stringify(allowed.data));
    check('待确认列表清空', B.status().pendingTrust.length === 0);
    check('信任清单里出现 A', B.status().trusted.some((t) => t.peerId === statusA.peerId && t.status === 'allow'));
    const storedAfterAllow = rpcB.messages().map((m) => String(m.params && m.params.content)).join('\n');
    check('补投后落进会话', /信封归一/.test(storedAfterAllow), storedAfterAllow.slice(0, 120));
    check('补投同样不触发跑一轮', submittedB.length === 0, `submitted=${submittedB.length}`);
    check(
      '投递原因记为 auto_turn_off',
      events.some((e) => e.side === 'B' && e.kind === 'inbound-stored' && e.reason === 'auto_turn_off'),
      JSON.stringify(events.filter((e) => e.kind === 'inbound-stored'))
    );

    // —— 2. 打开「自动跑一轮」后：B 落会话并跑一轮 ——
    B.setAutoTurn(true);
    const sent = await A.sendToPeer({
      host: '127.0.0.1',
      port: statusB.port,
      text: '帮我看看 wire.js 的归一逻辑',
      expectReply: false
    });
    check('A→B 送达（已确认）', sent.ok === true, JSON.stringify(sent));
    check('对端回执标记已信任', !!(sent.peer && sent.peer.trusted === true), JSON.stringify(sent.peer));
    check('B 自动跑了一轮', submittedB.length === 1, `submitted=${submittedB.length}`);
    const inboundTask = submittedB[0] || {};
    check('B 收到的正文带来源抬头', /内网 Agent 来信/.test(String(inboundTask.text || '')), String(inboundTask.text || '').slice(0, 80));
    check('B 收到的跳数为 1', /跳数：1/.test(String(inboundTask.text || '')));
    check('B 侧会话已建立', !!inboundTask.sessionId);

    // —— 3. B 的回合结束要回传给 A（A 还没确认 B，回信会被拦；先让 A 也确认 B）——
    const reqB = `reqB_1`;
    A.trustPeer(statusB.peerId, 'allow');
    B.noteTurnProgress(reqB, { streamContent: '信封归一在 wire.js 的 normalizeEnvelope。' });
    await B.noteTurnCompleted(reqB, { summary: '（被截断的摘要）' });
    await new Promise((r) => setTimeout(r, 300));
    const aMessages = rpcA.messages();
    const replyText = aMessages.map((m) => String(m.params && m.params.content)).join('\n');
    check('A 收到 B 的回复', /信封归一在 wire\.js/.test(replyText), replyText.slice(0, 120));
    check('回传用完整正文而不是 400 字摘要', !/被截断的摘要/.test(replyText));

    // —— 4. 跳数用尽：只投递不跑 ——
    const before = submittedB.length;
    const hopped = await A.sendToPeer({
      host: '127.0.0.1',
      port: statusB.port,
      text: '第五跳的消息',
      hops: 5
    });
    check('跳数用尽仍送达', hopped.ok === true);
    check('跳数用尽不再自动跑', submittedB.length === before, `submitted=${submittedB.length}`);
    const stored = rpcB.messages().map((m) => String(m.params && m.params.content)).join('\n');
    check('跳数用尽改为落会话', /第五跳的消息/.test(stored), stored.slice(0, 120));

    // —— 5. presence：双方互相可见、判定同一项目、信任状态带在列表里 ——
    const aView = A.peers();
    const seenB = aView.find((p) => p.host && p.port === statusB.port);
    check('A 的在线列表里有 B（presence）', !!seenB, JSON.stringify(aView));
    check('同项目被识别（sameWorkspace）', !!seenB && seenB.sameWorkspace === true, JSON.stringify(seenB && seenB.workspaceKey));
    check('在线列表带信任状态', !!seenB && seenB.trust === 'allow', JSON.stringify(seenB && seenB.trust));
    check('对端带回自己的租约快照字段', !!seenB && Array.isArray(seenB.claims));

    // —— 6. 会话即通道：从会话发信 → 对端跑一轮 → 答复落回同一个会话 ——
    const sessLocal = 'sess_peer_channel';
    rpcA.registerSession(sessLocal); // 会话先存在于库里（与「打开对话」建会话的顺序一致）
    const notLinked = await A.sendFromSession(sessLocal, '还没绑定就发');
    check(
      '未绑定会话 → PEER_NOT_LINKED',
      notLinked.ok === false && notLinked.error === 'PEER_NOT_LINKED',
      JSON.stringify(notLinked)
    );
    A.linkSession(sessLocal, seenB.peerId);
    check('会话绑定被记住', A.linkForSession(sessLocal) === seenB.peerId);
    const beforeChannel = submittedB.length;
    const viaSession = await A.sendFromSession(sessLocal, '从会话里发的问题');
    check('会话发信送达', viaSession.ok === true, JSON.stringify(viaSession));
    check('会话发信触发对端跑一轮', submittedB.length === beforeChannel + 1, `submitted=${submittedB.length}`);
    const reqChannel = `reqB_${submittedB.length}`;
    B.noteTurnProgress(reqChannel, { streamContent: '这是对会话消息的答复。' });
    await B.noteTurnCompleted(reqChannel, { summary: '（短摘要）' });
    await new Promise((r) => setTimeout(r, 300));
    const sessReplies = rpcA
      .messages()
      .filter((m) => String(m.params && m.params.sessionId) === sessLocal)
      .map((m) => String(m.params.content))
      .join('\n');
    check('对端答复落回同一个会话', /这是对会话消息的答复/.test(sessReplies), sessReplies.slice(0, 120));

    // —— 6b. 会话链接是缓存：「打开对话」必须先确认会话还在，否则永远返回写不进消息的死 id ——
    rpcA.dropSession(sessLocal); // 模拟库被回退 / 会话被清理（会话行没了）
    check('死链接还在（缓存过期）', A.linkForSession(sessLocal) === seenB.peerId);
    const reopened = await A.openSessionForPeer(seenB.peerId, seenB.name);
    check('打开对话不再返回死 id', !!reopened && reopened !== sessLocal, String(reopened));
    check('给回的会话确实在库里', rpcA.hasSession(reopened), String(reopened));
    check('死链接已解绑', A.linkForSession(sessLocal) === '', A.linkForSession(sessLocal));
    check('新会话已绑定到这台机器', A.linkForSession(reopened) === seenB.peerId);
    const reopenedAgain = await A.openSessionForPeer(seenB.peerId, seenB.name);
    check('再打开复用同一个活会话', reopenedAgain === reopened, `${reopenedAgain} vs ${reopened}`);

    // —— 7. 建议式租约 ——
    const claimA = await A.claim({ action: 'acquire', kind: 'file', key: 'src/peer/wire.js', note: '正在改信封' });
    check('A 拿到租约', claimA.ok === true, JSON.stringify(claimA));
    check('A 的租约进入视图', A.claims().some((c) => c.key === 'src/peer/wire.js'));
    const claimB = await B.claim({ action: 'acquire', kind: 'file', key: 'src/peer/wire.js', note: '也想改' });
    check('B 拿到冲突', claimB.ok === false && claimB.error === 'CLAIM_CONFLICT', JSON.stringify(claimB));
    check('冲突里带持有者', Array.isArray(claimB.holders) && claimB.holders.length > 0);
    check('B 能看到 A 的租约（广播生效）', B.claims().some((c) => c.key === 'src/peer/wire.js' && c.peerId !== B.status().peerId));
    await A.claim({ action: 'release', kind: 'file', key: 'src/peer/wire.js' });
    const claimB2 = await B.claim({ action: 'acquire', kind: 'file', key: 'src/peer/wire.js', note: '接手' });
    check('释放后 B 可拿', claimB2.ok === true, JSON.stringify(claimB2));
    await B.claim({ action: 'release', kind: 'file', key: 'src/peer/wire.js' });

    // —— 8. 小时预算用尽：只投递不跑（防止两个 agent 互相撩烧 token）——
    budgetOverrideB = { peerTurnBudgetPerHour: 0 };
    const beforeBudget = submittedB.length;
    const budgeted = await A.sendToPeer({ host: '127.0.0.1', port: statusB.port, text: '预算用尽后的消息' });
    check('预算用尽仍送达', budgeted.ok === true);
    check('预算用尽不再自动跑', submittedB.length === beforeBudget, `submitted=${submittedB.length}`);
    const budgetStored = rpcB.messages().map((m) => String(m.params && m.params.content)).join('\n');
    check('预算用尽改为落会话', /预算用尽后的消息/.test(budgetStored));
    budgetOverrideB = null;

    // —— 9. 线协议归一 ——
    check('未知类型被丢弃', normalizeEnvelope({ id: 'x', type: 'hack', from: { peerId: 'peer_x' } }) === null);
    check('缺 from.peerId 被丢弃', normalizeEnvelope({ id: 'x', type: 'message', text: 'hi' }) === null);
    const long = 'x'.repeat(200);
    const cut = normalizeEnvelope(
      { id: 'y', type: 'message', text: long, hops: 1, from: { peerId: 'peer_x' } },
      { maxTextChars: 50 }
    );
    check('超长正文被截断', cut && cut.text.length === 50);

    // —— 10. 项目身份 ——
    const key = workspaceKeyFor(workspacePath);
    check('仓库有非空项目 key', !!key && key.length === 12, key);
    check('不同路径 → 不同 key', workspaceKeyFor(path.join(os.tmpdir(), 'other-project')) !== key);
    check('两台实例同项目判定一致', A.status().workspace.key === B.status().workspace.key);

    // —— 11. 陌生机器（独立客户端）走真实发信路径：握手回执里 trusted=false，且拿不到租约快照 ——
    const stranger = createPeerClient({
      getPeerId: () => 'peer_badbadbadbadba',
      getName: () => 'intruder',
      getWorkspace: () => ({ key: '', name: '', path: '' }),
      getClaims: () => [],
      getPort: () => 0,
      connectTimeoutMs: 3000,
      log: () => {}
    });
    const strangerSend = await stranger.send({
      host: '127.0.0.1',
      port: statusB.port,
      type: ENVELOPE_TYPE.MESSAGE,
      text: 'hello from a stranger'
    });
    check(
      '陌生机器 → NOT_TRUSTED',
      strangerSend.ok === false && strangerSend.error === 'NOT_TRUSTED',
      JSON.stringify(strangerSend)
    );
    check('陌生机器握手回执 trusted=false', !!(strangerSend.peer && strangerSend.peer.trusted === false), JSON.stringify(strangerSend.peer));
    check(
      '陌生机器拿不到租约快照',
      !!(strangerSend.peer && Array.isArray(strangerSend.peer.claims) && strangerSend.peer.claims.length === 0),
      JSON.stringify(strangerSend.peer && strangerSend.peer.claims)
    );

    // —— 12. 拒绝 → 静默不再打扰；撤销 → 回到「不认识」——
    const strangerId = 'peer_badbadbadbadba';
    const denied = await B.trustPeer(strangerId, 'deny');
    check('拒绝成功', denied.ok === true, JSON.stringify(denied));
    const pendingBeforeDenyRetry = B.status().pendingTrust.length;
    const again = await stranger.send({
      host: '127.0.0.1',
      port: statusB.port,
      type: ENVELOPE_TYPE.MESSAGE,
      text: 'yet another try'
    });
    check('被拒绝的机器再发仍被拒', again.ok === false && again.error === 'NOT_TRUSTED', JSON.stringify(again));
    check(
      '被拒绝的机器不再产生待确认（不打扰用户）',
      B.status().pendingTrust.length === pendingBeforeDenyRetry,
      JSON.stringify(B.status().pendingTrust)
    );
    check(
      '拒绝状态在信任清单里可见',
      B.status().trusted.some((t) => t.peerId === strangerId && t.status === 'deny'),
      JSON.stringify(B.status().trusted)
    );
    B.untrustPeer(strangerId);
    check(
      '撤销后从清单消失（下次来信会重新确认）',
      !B.status().trusted.some((t) => t.peerId === strangerId),
      JSON.stringify(B.status().trusted)
    );
    const afterClear = await stranger.send({
      host: '127.0.0.1',
      port: statusB.port,
      type: ENVELOPE_TYPE.MESSAGE,
      text: 'after clear'
    });
    check('撤销后再来信重新进入待确认', afterClear.ok === false && afterClear.error === 'NOT_TRUSTED', JSON.stringify(afterClear));
    check('待确认里重新出现这台机器', B.status().pendingTrust.some((p) => p.peerId === strangerId), JSON.stringify(B.status().pendingTrust));

    // —— 13. 房间（一次任务一个）：成员必须已确认 / 结束后不许再发 / 接收侧只投递不跑 ——
    check(
      '房间默认上限：成员 8 / 并行 4',
      AGENT_LIMITS_DEFAULTS.peerRoomMaxMembers === 8 && AGENT_LIMITS_DEFAULTS.peerRoomMaxActiveRooms === 4,
      `${AGENT_LIMITS_DEFAULTS.peerRoomMaxMembers} / ${AGENT_LIMITS_DEFAULTS.peerRoomMaxActiveRooms}`
    );
    check('初始没有房间', A.rooms().length === 0, JSON.stringify(A.rooms()));

    const noMemberRoom = A.createRoom({ title: '空房间', members: [] });
    check('没有成员的房间被拒', noMemberRoom.ok === false && noMemberRoom.error === 'ROOM_NO_MEMBERS', JSON.stringify(noMemberRoom));
    const notFoundRoom = A.createRoom({ title: '不存在的成员', members: ['某台不存在的机器'] });
    check(
      '拉不认识的机器进房间 → PEER_NOT_FOUND',
      notFoundRoom.ok === false && notFoundRoom.error === 'PEER_NOT_FOUND',
      JSON.stringify(notFoundRoom)
    );
    const untrustedRoom = A.createRoom({ title: '没确认的机器', members: [strangerId] });
    check(
      '拉没确认的机器进房间 → PEER_NOT_TRUSTED',
      untrustedRoom.ok === false && untrustedRoom.error === 'PEER_NOT_TRUSTED',
      JSON.stringify(untrustedRoom)
    );

    const createdRoom = A.createRoom({ title: '修发票模块', members: [statusB.peerId] });
    check('建房间成功且是开着的', createdRoom.ok === true && createdRoom.room.status === 'open', JSON.stringify(createdRoom));
    const roomId = createdRoom.ok ? createdRoom.room.roomId : '';
    check('房间成员 = 已确认的那台', createdRoom.ok && createdRoom.room.members.join() === statusB.peerId, JSON.stringify(createdRoom.room && createdRoom.room.members));
    check('房间进 A 的清单', A.rooms().some((r) => r.roomId === roomId), JSON.stringify(A.rooms().map((r) => r.roomId)));
    check('建房间发了 room-created 事件', events.some((e) => e.side === 'A' && e.kind === 'room-created'));

    const roomSent = await A.sendToPeer({ peer: statusB.peerId, text: '房间里的第一句话', roomId });
    check('以房间名义发给成员 → 送达', roomSent.ok === true, JSON.stringify(roomSent));
    const outsiderSend = await A.sendToPeer({ peer: strangerId, text: '想蹭这个房间', roomId });
    check(
      '不认识的机器先被 PEER_NOT_FOUND 挡下（早于房间校验）',
      outsiderSend.ok === false && outsiderSend.error === 'PEER_NOT_FOUND',
      JSON.stringify(outsiderSend)
    );
    // 直连 host+port 时拿不到 peerId ⇒ 无法确认是不是成员，宁可不许借房间发
    const directRoomSend = await A.sendToPeer({ host: '127.0.0.1', port: statusB.port, text: '直连但以房间名义发', roomId });
    check(
      '直连（无法确认成员）不许借房间发 → PEER_NOT_IN_ROOM',
      directRoomSend.ok === false && directRoomSend.error === 'PEER_NOT_IN_ROOM',
      JSON.stringify(directRoomSend)
    );
    const ghostRoomSend = await A.sendToPeer({ peer: statusB.peerId, text: '不存在的房间', roomId: 'r-nope' });
    check(
      '不存在的房间 → ROOM_NOT_FOUND',
      ghostRoomSend.ok === false && ghostRoomSend.error === 'ROOM_NOT_FOUND',
      JSON.stringify(ghostRoomSend)
    );

    // 并行房间上限（房间 = 一次任务，同时进行太多就没意义了）
    const maxActiveRooms = AGENT_LIMITS_DEFAULTS.peerRoomMaxActiveRooms;
    for (let i = 1; i < maxActiveRooms; i += 1) A.createRoom({ title: `并行任务 ${i}`, members: [statusB.peerId] });
    check(
      '并行房间数达到上限',
      A.rooms().filter((r) => r.status === 'open').length === maxActiveRooms,
      JSON.stringify(A.rooms().map((r) => r.status))
    );
    const overLimit = A.createRoom({ title: '再多一个', members: [statusB.peerId] });
    check('超过并行上限 → ROOM_LIMIT', overLimit.ok === false && overLimit.error === 'ROOM_LIMIT', JSON.stringify(overLimit));

    // 结束房间：幂等；结束后不许再以它名义发；单独发不受影响（房间只是标签）
    const closedRoom = A.closeRoom(roomId);
    check('结束房间成功', closedRoom.ok === true && closedRoom.room.status === 'closed', JSON.stringify(closedRoom));
    check('重复结束是幂等的', A.closeRoom(roomId).ok === true);
    const closedSend = await A.sendToPeer({ peer: statusB.peerId, text: '房间结束后还想发', roomId });
    check(
      '已结束的房间不许再发 → ROOM_CLOSED',
      closedSend.ok === false && closedSend.error === 'ROOM_CLOSED',
      JSON.stringify(closedSend)
    );
    const noRoomSend = await A.sendToPeer({ peer: statusB.peerId, text: '不带房间照样能发' });
    check('不带房间仍可单独发', noRoomSend.ok === true, JSON.stringify(noRoomSend));
    check('结束房间发了 room-closed 事件', events.some((e) => e.side === 'A' && e.kind === 'room-closed'));

    // 接收侧：**本机也有这个房间且已结束**时只投递不跑（房间是本机视图，查不到就按普通来信处理）。
    // 用独立客户端注入 roomId：发送方的房间校验不该影响这条断言。
    const dirC = mkTmp('rooms');
    try {
      fs.mkdirSync(path.join(dirC, 'peer'), { recursive: true });
      fs.writeFileSync(
        path.join(dirC, 'peer', 'rooms.json'),
        JSON.stringify({
          rooms: [
            { roomId: 'r-closed-test', title: '已经结束的任务', status: 'closed', members: [statusA.peerId], createdAt: 1, closedAt: 2 },
            // 「别人的房间」：成员里没有 A。A 硬写这个 id 也不该拿到房间标签（成员校验）
            { roomId: 'r-other-room', title: '别人的任务', status: 'open', members: ['peer_0123456789abcdef01'], createdAt: 1, closedAt: 0 }
          ]
        }),
        'utf8'
      );
      const rpcC = mkRpc();
      const submittedC = [];
      const C = createPeerCoordinator({
        userDataPath: dirC,
        getWorkspace: () => ({ workspacePath }),
        rpc: rpcC.rpc,
        submitTask: async (task) => {
          submittedC.push(task);
          return { requestId: `reqC_${submittedC.length}`, sessionId: task.sessionId };
        },
        limits: limitsFor(18370, 18343),
        onEvent: (e) => events.push({ side: 'C', ...e }),
        log: () => {}
      });
      const statusC = await C.start();
      C.setAutoTurn(true);
      await C.trustPeer(statusA.peerId, 'allow');
      const asA = createPeerClient({
        getPeerId: () => statusA.peerId,
        getName: () => 'A',
        getWorkspace: () => A.status().workspace,
        getClaims: () => [],
        getPort: () => statusA.port,
        connectTimeoutMs: 3000,
        log: () => {}
      });
      const toClosedRoom = await asA.send({
        host: '127.0.0.1',
        port: statusC.port,
        type: ENVELOPE_TYPE.MESSAGE,
        text: '这个房间已经结束了',
        roomId: 'r-closed-test'
      });
      check('已结束房间的来信仍然投递（不丢内容）', toClosedRoom.ok === true, JSON.stringify(toClosedRoom));
      check('已结束房间的来信不自动跑一轮', submittedC.length === 0, `submitted=${submittedC.length}`);
      check(
        'skip 原因记为 room_closed',
        events.some((e) => e.side === 'C' && e.kind === 'inbound-stored' && e.reason === 'room_closed'),
        JSON.stringify(events.filter((e) => e.side === 'C' && e.kind === 'inbound-stored'))
      );
      const storedAtC = rpcC.messages().map((m) => String(m.params && m.params.content)).join('\n');
      check('已结束房间的来信仍落会话', /这个房间已经结束了/.test(storedAtC), storedAtC.slice(0, 120));
      check('来信抬头带上房间名', /房间「已经结束的任务」/.test(storedAtC), storedAtC.slice(0, 120));

      // 非成员硬写 roomId：不许借别人的房间名贴标签（房间标签只对成员生效）
      const toOtherRoom = await asA.send({
        host: '127.0.0.1',
        port: statusC.port,
        type: ENVELOPE_TYPE.MESSAGE,
        text: '我不是这个房间的人',
        roomId: 'r-other-room'
      });
      check('非成员带 roomId 仍能投递（不因此拒收）', toOtherRoom.ok === true, JSON.stringify(toOtherRoom));
      // 这条会走自动跑（房间标签对非成员无效 ⇒ 不存在「别人的房间已结束」这种拦法）
      const spoofTask = submittedC.map((t) => String((t && t.text) || '')).join('\n');
      check('非成员拿不到房间标签', /我不是这个房间的人/.test(spoofTask) && !/房间「别人的任务」/.test(spoofTask), spoofTask.slice(0, 200));
      check('非成员不会被误判成「房间已结束」而跳过一轮', submittedC.length === 1, `submitted=${submittedC.length}`);

      // —— 身份防伪：信封里自报的 role 一律不采信，只认握手时说的那一次 ——
      C.setAutoTurn(false);
      const { WebSocket } = require('ws');
      const spoofed = await new Promise((resolve) => {
        const ws = new WebSocket(`ws://127.0.0.1:${statusC.port}/peer`, { handshakeTimeout: 3000 });
        let settled = false;
        const finish = (v) => {
          if (settled) return;
          settled = true;
          try {
            ws.close();
          } catch {
            // ignore
          }
          resolve(v);
        };
        const timer = setTimeout(() => finish({ ok: false, error: 'timeout' }), 5000);
        ws.on('open', () => {
          ws.send(
            JSON.stringify({
              t: 'hello',
              v: 1,
              peerId: statusA.peerId,
              name: '冒充 A',
              role: '握手声明：发票模块',
              workspace: {},
              claims: [],
              port: 0
            })
          );
        });
        ws.on('message', (raw) => {
          let frame = null;
          try {
            frame = JSON.parse(String(raw));
          } catch {
            return;
          }
          if (frame && frame.t === 'hello_ok') {
            ws.send(
              JSON.stringify({
                t: 'msg',
                env: {
                  id: 'env-spoof-1',
                  type: ENVELOPE_TYPE.MESSAGE,
                  text: '带着伪造身份的信',
                  createdAt: Date.now(),
                  // 信封里硬写一个假身份：服务端必须无视它
                  from: { peerId: statusA.peerId, name: '冒充 A', role: '伪造的身份：财务总监' }
                }
              })
            );
          }
          if (frame && frame.t === 'ack') {
            clearTimeout(timer);
            finish({ ok: frame.ok === true, error: frame.error });
          }
        });
        ws.on('error', () => finish({ ok: false, error: 'ws_error' }));
      });
      check('手写帧仍能投递（对照组）', spoofed.ok === true, JSON.stringify(spoofed));
      const storedSpoof = rpcC.messages().map((m) => String(m.params && m.params.content)).join('\n');
      check('自报 role 不采信：抬头用的是握手时的身份', /自称：握手声明：发票模块/.test(storedSpoof), storedSpoof.slice(-160));
      check('伪造的假身份没进正文', !/财务总监/.test(storedSpoof), storedSpoof.slice(-160));
      C.stop();
    } finally {
      fs.rmSync(dirC, { recursive: true, force: true });
    }
    // —— 14. 扇出（发所有人）+ 房间时间线 ——
    // 清场：先把上一步的开着的房间都结束，扇出单独验
    for (const r of A.rooms().filter((x) => x.status === 'open')) A.closeRoom(r.roomId);
    // B 也改成只投递：开着自动跑时正文会交给 Agent 跑一轮（落库在那条链路里），这里要看落库
    B.setAutoTurn(false);

    dirD = mkTmp('d');
    const rpcD = mkRpc();
    const submittedD = [];
    D = createPeerCoordinator({
      userDataPath: dirD,
      getWorkspace: () => ({ workspacePath }),
      rpc: rpcD.rpc,
      submitTask: async (task) => {
        submittedD.push(task);
        return { requestId: `reqD_${submittedD.length}`, sessionId: task.sessionId };
      },
      limits: limitsFor(18380, 18344),
      onEvent: (e) => events.push({ side: 'D', ...e }),
      log: () => {}
    });
    const statusD = await D.start();
    D.setAutoTurn(false);
    // A 先按 host+port 敲一次门：D 会拦下（未确认），但 A 通过握手学到了它，之后才能按 peerId 找
    const intro = await A.sendToPeer({ host: '127.0.0.1', port: statusD.port, text: '打招呼（会被 D 拦下）' });
    check('D 未确认时 A→D 被拦（NOT_TRUSTED）', intro.ok === false && intro.error === 'NOT_TRUSTED', JSON.stringify(intro));
    await A.trustPeer(statusD.peerId, 'allow');
    await D.trustPeer(statusA.peerId, 'allow');

    // 已确认、但从没上线的机器：成员合法性通过，发送时才失败（这就是「部分成功」的现场）
    const offlineId = 'peer_ffffffffffffffffff';
    await A.trustPeer(offlineId, 'allow');

    const fanRoom = A.createRoom({ title: '扇出测试', members: [statusB.peerId, statusD.peerId, offlineId] });
    check('三成员房间建好', fanRoom.ok === true && fanRoom.room.members.length === 3, JSON.stringify(fanRoom));
    const fanRoomId = fanRoom.ok ? fanRoom.room.roomId : '';

    const broadcast = await A.sendToRoom({ roomId: fanRoomId, text: '房间广播：各自改自己那块' });
    check('扇出：两台在线的都送达', broadcast.ok === true && broadcast.delivered.length === 2, JSON.stringify(broadcast.delivered));
    check('扇出：离线那台记为失败且不重试', broadcast.partial === true && broadcast.failed.length === 1, JSON.stringify(broadcast.failed));
    check(
      '扇出：B 收到',
      rpcB.messages().some((m) => /房间广播/.test(String(m.params && m.params.content))),
      'B 没收到'
    );
    check(
      '来信抬头带上对方的自称身份',
      rpcB
        .messages()
        .some((m) => /房间广播/.test(String(m.params && m.params.content)) && /自称：发票模块/.test(String(m.params && m.params.content))),
      String((rpcB.messages().slice(-1)[0] || {}).params?.content || '').slice(0, 200)
    );
    check(
      '扇出：D 收到（只投递，不自动跑）',
      rpcD.messages().some((m) => /房间广播/.test(String(m.params && m.params.content))) && submittedD.length === 0,
      `submitted=${submittedD.length}`
    );
    check('扇出记了 room-sent 事件', events.some((e) => e.side === 'A' && e.kind === 'room-sent' && e.roomId === fanRoomId));

    const timeline = await A.roomTimeline({ roomId: fanRoomId });
    check('房间时间线能取到', !!timeline && Array.isArray(timeline.messages), JSON.stringify(timeline && timeline.messages.length));
    const timelineText = ((timeline && timeline.messages) || []).map((m) => m.content).join('\n');
    check('时间线包含刚广播的内容', /房间广播/.test(timelineText), timelineText.slice(0, 120));
    check('时间线不混进房间建立之前的消息', !/信封归一在 wire\.js/.test(timelineText), timelineText.slice(0, 200));
    check('时间线按时间正序', ((timeline && timeline.messages) || []).every((m, i, arr) => i === 0 || arr[i - 1].at <= m.at));

    A.closeRoom(fanRoomId);
    const afterClose = await A.roomTimeline({ roomId: fanRoomId });
    check('结束后时间线仍可读（历史不删）', !!afterClose && afterClose.messages.length > 0, JSON.stringify(afterClose && afterClose.messages.length));
    const closedBroadcast = await A.sendToRoom({ roomId: fanRoomId, text: '结束后再广播' });
    check(
      '已结束房间不许广播 → ROOM_CLOSED',
      closedBroadcast.ok === false && closedBroadcast.error === 'ROOM_CLOSED',
      JSON.stringify(closedBroadcast)
    );
    const ghostBroadcast = await A.sendToRoom({ roomId: 'r-nope', text: '没有这个房间' });
    check(
      '不存在的房间广播 → ROOM_NOT_FOUND',
      ghostBroadcast.ok === false && ghostBroadcast.error === 'ROOM_NOT_FOUND',
      JSON.stringify(ghostBroadcast)
    );
    check('不存在的房间取时间线 → null', (await A.roomTimeline({ roomId: 'r-nope' })) === null);
  } finally {
    if (D) D.stop();
    A.stop();
    B.stop();
    if (dirD) {
      try {
        fs.rmSync(dirD, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
    try {
      fs.rmSync(dirA, { recursive: true, force: true });
      fs.rmSync(dirB, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }

  if (failures) {
    console.error(`test-peer-mesh.cjs failed: ${failures}`);
    process.exit(1);
  }
  console.log('test-peer-mesh.cjs ok');
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});

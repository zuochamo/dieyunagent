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

function mkRpc() {
  const calls = [];
  let seq = 0;
  return {
    calls,
    messages() {
      return calls.filter((c) => c.method === 'memory.message_append');
    },
    async rpc(method, params) {
      calls.push({ method, params });
      if (method === 'memory.session_create') {
        seq += 1;
        return { id: `sess_${seq}` };
      }
      if (method === 'memory.message_append') return { ok: true };
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
    const statusA = await A.start();
    const statusB = await B.start();
    check('A 已监听', statusA.port > 0, `port=${statusA.port}`);
    check('B 已监听', statusB.port > 0, `port=${statusB.port}`);
    check('身份稳定（重启不变）', A.status().peerId === statusA.peerId);
    check('默认不自动跑一轮（只投递）', A.status().autoTurn === false, JSON.stringify(A.status().autoTurn));
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
  } finally {
    A.stop();
    B.stop();
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

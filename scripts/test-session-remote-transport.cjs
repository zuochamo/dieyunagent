'use strict';

const { createSessionRemoteTransport } = require('../src/session/session-remote-transport');
const { remoteWorktreePath } = require('../src/ssh/remote-worktree');

function testRemoteAgentInfoScopedToSession() {
  const targetA = { kind: 'ssh', host: 'h1', port: 22, username: 'u', remotePath: '/proj-a' };
  const targetB = { kind: 'ssh', host: 'h1', port: 22, username: 'u', remotePath: '/proj-b' };
  const infoA = { url: 'ws://127.0.0.1:1', token: 't', workspaceRoot: '/proj-a' };

  const remoteGatewayPool = {
    getInfoForTarget: (t) =>
      t && t.remotePath === '/proj-a' ? infoA : null
  };

  const transport = createSessionRemoteTransport({
    localGateway: {
      activeSessionId: 'sess-a',
      getSessionWorkspaceTarget: (sid) => (sid === 'sess-a' ? targetA : sid === 'sess-b' ? targetB : null)
    },
    sshPool: null,
    remoteGatewayPool,
    sshFacade: null,
    sshCredentialsStore: null,
    tryAutoReconnectSsh: null,
    buildRemoteGatewayPackContext: async () => ({}),
    invalidateRemoteAgentClient: () => {}
  });

  const forA = transport.getRemoteAgentInfoForSession('sess-a');
  if (!forA || forA.workspaceRoot !== '/proj-a') {
    throw new Error('sess-a should match gateway /proj-a');
  }
  const forB = transport.getRemoteAgentInfoForSession('sess-b');
  if (forB != null) {
    throw new Error('sess-b path mismatch should not reuse gateway');
  }
  const forLocal = transport.getRemoteAgentInfoForSession('sess-local');
  if (forLocal != null) {
    throw new Error('local session should not get remote gateway info');
  }
  console.log('ok session remote agent info scoping');
}

function testRemoteLeaseKeepsTransportOnLocalSwitch() {
  const targetBg = { kind: 'ssh', host: 'h1', port: 22, username: 'u', remotePath: '/bg' };
  const acquired = [];
  const released = [];

  const transport = createSessionRemoteTransport({
    localGateway: {
      activeSessionId: 'sess-local',
      getEffectiveWorkspaceTarget: () => ({ kind: 'local', path: 'C:/tmp' }),
      getSessionWorkspaceTarget: () => null
    },
    sshPool: {
      acquire: (t) => acquired.push(t),
      release: (t) => released.push(t),
      isConnected: () => true,
      getManagerForTarget: () => null,
      getConnectedManager: () => null
    },
    remoteGatewayPool: {
      releaseForTarget: () => {}
    },
    sshFacade: null,
    sshCredentialsStore: null,
    tryAutoReconnectSsh: null,
    buildRemoteGatewayPackContext: async () => ({}),
    invalidateRemoteAgentClient: () => {}
  });
  return transport.setSessionRemoteLease('sess-bg', true, targetBg).then(() => {
    if (!transport.hasLeaseForTarget(targetBg)) {
      throw new Error('expected lease for bg target');
    }
    return transport.applySessionRemoteTransport('sess-local').then((r) => {
      if (!r.keptTransport) throw new Error('expected keptTransport when lease held');
      console.log('ok remote lease keeps transport on local session');
    });
  });
}

async function testKeepSshViewOnLocalSwitchWithoutLease() {
  const targetA = { kind: 'ssh', host: 'h1', port: 22, username: 'u', remotePath: '/proj-a' };
  const infoA = { url: 'ws://127.0.0.1:1', token: 't-a' };
  const stopped = [];
  const disconnected = [];
  const ensured = [];
  let gatewayActive = false;

  const lg = {
    activeSessionId: 'sess-a',
    getEffectiveWorkspaceTarget: () => targetA,
    getSessionWorkspaceTarget: (sid) => (sid === 'sess-a' ? targetA : null)
  };

  const transport = createSessionRemoteTransport({
    localGateway: lg,
    sshPool: {
      acquire: () => {},
      release: () => {},
      isConnected: () => true,
      getManagerForTarget: () => ({ status: () => ({ connected: true }) }),
      getConnectedManager: () => ({ status: () => ({ connected: true }) }),
      disconnectExceptEndpointKeys: async () => {
        disconnected.push('except');
      }
    },
    remoteGatewayPool: {
      getInfoForTarget: () => infoA,
      isActiveForTarget: () => gatewayActive,
      ensureForTarget: async (t) => {
        ensured.push(String((t && t.remotePath) || ''));
        gatewayActive = true;
        return infoA;
      },
      stopForTarget: async (t) => {
        stopped.push(`gw:${t.remotePath}`);
        gatewayActive = false;
      },
      stopExceptGatewayKeys: async () => {
        stopped.push('except');
        gatewayActive = false;
      }
    },
    sshFacade: null,
    sshCredentialsStore: null,
    tryAutoReconnectSsh: null,
    buildRemoteGatewayPackContext: async () => ({}),
    invalidateRemoteAgentClient: () => {}
  });

  await transport.applySessionRemoteTransport('sess-a');
  lg.activeSessionId = 'sess-local';
  lg.getEffectiveWorkspaceTarget = () => ({ kind: 'local', path: 'C:/tmp' });
  const localResult = await transport.applySessionRemoteTransport('sess-local');

  if (stopped.length) {
    throw new Error(`local switch must not stop remote agent, got ${JSON.stringify(stopped)}`);
  }
  if (disconnected.length) {
    throw new Error(`local switch must not drop SSH, got ${JSON.stringify(disconnected)}`);
  }
  if (!localResult.keptTransport) {
    throw new Error('expected keptTransport when leaving ssh view idle');
  }

  lg.activeSessionId = 'sess-a';
  lg.getEffectiveWorkspaceTarget = () => targetA;
  await transport.applySessionRemoteTransport('sess-a');
  // 复用与否只由 manager 的幂等路径（含活体探测）判定；transport 不再自己看
  // isActiveForTarget 抄一份判断。这里能验的是：切回来必须落在**同一个槽位**
  // （同一 effective workspace），而不是又开一个。
  //
  // 切换不再 await 远端（远端活改在后台发起，见 session-remote-transport.js 的注释：
  // 等它会被同连接的串行 exec 链堵住，实测排过 56.4s），且同一目标在飞时只发一次。
  // 所以这两处要等后台落地再断言。
  const waitForEnsures = async (n) => {
    for (let i = 0; i < 200 && ensured.length < n; i += 1) {
      await new Promise((r) => setTimeout(r, 10));
    }
  };
  await waitForEnsures(1);
  await transport.applySessionRemoteTransport('sess-a');
  await waitForEnsures(2);
  if (ensured.length !== 2) {
    throw new Error(`switch back should reuse the same slot, ensure count=${ensured.length}`);
  }
  if (ensured[0] !== ensured[1]) {
    throw new Error(`switch back must target the same slot, got ${JSON.stringify(ensured)}`);
  }
  console.log('ok keep ssh view idle on local switch and reuse agent');
}

async function testSameHostPathChangeDoesNotDropSsh() {
  const targetRoot = { kind: 'ssh', host: 'h1', port: 22, username: 'u', remotePath: '/' };
  const targetProj = { kind: 'ssh', host: 'h1', port: 22, username: 'u', remotePath: '/proj' };
  const disconnected = [];

  const lg = {
    activeSessionId: 'sess-a',
    getEffectiveWorkspaceTarget: () => targetRoot,
    getSessionWorkspaceTarget: () => targetRoot
  };

  const transport = createSessionRemoteTransport({
    localGateway: lg,
    sshPool: {
      acquire: () => {},
      release: () => {},
      isConnected: () => true,
      getManagerForTarget: () => ({ status: () => ({ connected: true }) }),
      getConnectedManager: () => ({ status: () => ({ connected: true }) }),
      disconnectTarget: async (t) => {
        disconnected.push(t.remotePath);
      }
    },
    remoteGatewayPool: {
      getInfoForTarget: () => null,
      isActiveForTarget: () => false,
      ensureForTarget: async () => null,
      stopForTarget: async () => {}
    },
    sshFacade: null,
    sshCredentialsStore: null,
    tryAutoReconnectSsh: null,
    buildRemoteGatewayPackContext: async () => ({}),
    invalidateRemoteAgentClient: () => {}
  });

  await transport.applySessionRemoteTransport('sess-a');
  lg.getEffectiveWorkspaceTarget = () => targetProj;
  lg.getSessionWorkspaceTarget = () => targetProj;
  await transport.applySessionRemoteTransport('sess-a');

  if (disconnected.length) {
    throw new Error(`same-host path change must not disconnect SSH, got ${JSON.stringify(disconnected)}`);
  }
  console.log('ok same-host path change keeps ssh');
}

async function testGetLeasedTargetsCarriesSessionId() {
  const targetA1 = { kind: 'ssh', host: 'h1', port: 22, username: 'u', remotePath: '/a' };
  const targetA2 = { kind: 'ssh', host: 'h1', port: 22, username: 'u', remotePath: '/b' };
  const targetB = { kind: 'ssh', host: 'h2', port: 22, username: 'u', remotePath: '/x' };

  const transport = createSessionRemoteTransport({
    localGateway: { activeSessionId: 's0', getSessionWorkspaceTarget: () => null },
    sshPool: null,
    remoteGatewayPool: null,
    sshFacade: null,
    sshCredentialsStore: null,
    tryAutoReconnectSsh: null,
    buildRemoteGatewayPackContext: async () => ({}),
    invalidateRemoteAgentClient: () => {}
  });

  await transport.setSessionRemoteLease('sess-a', true, targetA1);
  await transport.setSessionRemoteLease('sess-b', true, targetA2);
  await transport.setSessionRemoteLease('sess-c', true, targetB);

  // 重连只要目标不够：端点相同、仓库不同，必须能分辨出是哪条会话
  const leased = transport.getLeasedTargets();
  if (leased.length !== 3) {
    throw new Error(`expected 3 leased entries, got ${leased.length}`);
  }
  const bySession = new Map(leased.map((e) => [e.sessionId, e.target.remotePath]));
  if (bySession.get('sess-a') !== '/a' || bySession.get('sess-b') !== '/b' || bySession.get('sess-c') !== '/x') {
    throw new Error(`leased entries must carry session identity, got ${JSON.stringify(leased)}`);
  }
  console.log('ok getLeasedTargets carries session id');
}

async function testGetLeasedSessionIds() {
  const target = { kind: 'ssh', host: 'h1', port: 22, username: 'u', remotePath: '/bg' };
  const transport = createSessionRemoteTransport({
    localGateway: { activeSessionId: 's0', getSessionWorkspaceTarget: () => null },
    sshPool: {
      acquire: () => {},
      release: () => {},
      isConnected: () => true,
      getManagerForTarget: () => null,
      getConnectedManager: () => null
    },
    remoteGatewayPool: { releaseForTarget: () => {} },
    sshFacade: null,
    sshCredentialsStore: null,
    tryAutoReconnectSsh: null,
    buildRemoteGatewayPackContext: async () => ({}),
    invalidateRemoteAgentClient: () => {}
  });
  await transport.setSessionRemoteLease('sess-bg', true, target);
  const ids = transport.getLeasedSessionIds();
  if (!ids.includes('sess-bg')) throw new Error('expected leased session id');
  await transport.setSessionRemoteLease('sess-bg', false, target);
  if (transport.getLeasedSessionIds().length !== 0) {
    throw new Error('expected leased session ids cleared after release');
  }
  console.log('ok getLeasedSessionIds');
}

async function testParallelSameHostDifferentPathLeases() {
  const targetA = { kind: 'ssh', host: 'h1', port: 22, username: 'u', remotePath: '/proj-a' };
  const targetB = { kind: 'ssh', host: 'h1', port: 22, username: 'u', remotePath: '/proj-b' };
  const gatewaysEnsured = [];

  const transport = createSessionRemoteTransport({
    localGateway: {
      activeSessionId: 'sess-view',
      getSessionWorkspaceTarget: (sid) =>
        sid === 'sess-a' ? targetA : sid === 'sess-b' ? targetB : null
    },
    sshPool: {
      acquire: () => {},
      release: () => {},
      isConnected: () => true,
      getManagerForTarget: () => ({ status: () => ({ connected: true }) }),
      getConnectedManager: () => ({ status: () => ({ connected: true }) })
    },
    remoteGatewayPool: {
      getInfoForTarget: (t) =>
        t && t.remotePath === '/proj-a'
          ? { url: 'ws://127.0.0.1:1', token: 'ta', workspaceRoot: '/proj-a' }
          : t && t.remotePath === '/proj-b'
            ? { url: 'ws://127.0.0.1:2', token: 'tb', workspaceRoot: '/proj-b' }
            : null,
      isActiveForTarget: () => true,
      ensureForTarget: async (t) => {
        gatewaysEnsured.push(t.remotePath);
        return transport.getRemoteAgentInfoForSession(
          t.remotePath === '/proj-a' ? 'sess-a' : 'sess-b'
        );
      },
      releaseForTarget: () => {}
    },
    sshFacade: null,
    sshCredentialsStore: null,
    tryAutoReconnectSsh: null,
    buildRemoteGatewayPackContext: async () => ({}),
    invalidateRemoteAgentClient: () => {}
  });

  await transport.setSessionRemoteLease('sess-a', true, targetA);
  await transport.setSessionRemoteLease('sess-b', true, targetB);

  const infoA = transport.getRemoteAgentInfoForSession('sess-a');
  const infoB = transport.getRemoteAgentInfoForSession('sess-b');
  if (!infoA || infoA.workspaceRoot !== '/proj-a') {
    throw new Error('sess-a should resolve /proj-a gateway');
  }
  if (!infoB || infoB.workspaceRoot !== '/proj-b') {
    throw new Error('sess-b should resolve /proj-b gateway');
  }
  if (infoA.token === infoB.token) {
    throw new Error('parallel same-host sessions must not share gateway token');
  }

  await transport.setSessionRemoteLease('sess-a', false, targetA);
  await transport.setSessionRemoteLease('sess-b', false, targetB);
  console.log('ok parallel same-host different-path leases');
}

async function testLeaseHoldIsIdempotentAndDropForce() {
  const target = { kind: 'ssh', host: 'h1', port: 22, username: 'u', remotePath: '/proj' };
  const acquired = [];
  const released = [];
  const transport = createSessionRemoteTransport({
    localGateway: {
      activeSessionId: 'sess-a',
      getEffectiveWorkspaceTarget: () => target,
      getSessionWorkspaceTarget: () => target
    },
    sshPool: {
      acquire: (t) => acquired.push(t),
      release: (t) => released.push(t),
      isConnected: () => true,
      getManagerForTarget: () => null,
      getConnectedManager: () => null
    },
    remoteGatewayPool: {
      releaseForTarget: () => {}
    },
    sshFacade: null,
    sshCredentialsStore: null,
    tryAutoReconnectSsh: null,
    buildRemoteGatewayPackContext: async () => ({}),
    invalidateRemoteAgentClient: () => {}
  });

  await transport.setSessionRemoteLease('sess-a', true, target);
  await transport.setSessionRemoteLease('sess-a', true, target);
  await transport.setSessionRemoteLease('sess-a', true, target);
  if (acquired.length !== 1) {
    throw new Error(`expected single acquire after triple hold, got ${acquired.length}`);
  }

  await transport.setSessionRemoteLease('sess-a', false, target);
  if (transport.hasLeaseForTarget(target)) {
    throw new Error('lease should be gone after single release');
  }
  if (released.length !== 1) {
    throw new Error(`expected single release, got ${released.length}`);
  }

  await transport.setSessionRemoteLease('sess-a', true, target);
  await transport.setSessionRemoteLease('sess-b', true, target);
  const ids = transport.listLeaseSessionIdsForTarget(target);
  if (ids.length !== 2) throw new Error(`expected 2 lease sessions, got ${ids.length}`);
  const dropped = transport.dropLeasesForTarget(target);
  if (dropped.length !== 2 || transport.hasLeaseForTarget(target)) {
    throw new Error('dropLeasesForTarget should clear all sessions for target');
  }
  console.log('ok lease hold idempotent + drop force');
}

async function testForeignRepoGatewayEnsureDoesNotHijackOtherSession() {
  const HOST = { host: 'h1', port: 22, username: 'u' };
  const repoA = { kind: 'ssh', ...HOST, remotePath: '/proj-a' }; // 会话 sess-a 的仓库
  const repoB = { kind: 'ssh', ...HOST, remotePath: '/proj-b' }; // 同机另一个仓库

  const wsWrites = [];
  const contexts = [];
  const slots = [];

  const manager = {
    status: () => ({ connected: true }),
    execScript: async () => ({ code: 0, stdout: 'WT_REUSED\n', stderr: '' })
  };
  const transport = createSessionRemoteTransport({
    localGateway: {
      activeSessionId: 'sess-a',
      getSessionWorkspaceTarget: () => repoA,
      setSessionWorkspaceContext: (sid, ws) => contexts.push([sid, ws]),
      invokeRpc: async (method, params) => {
        if (method === 'memory.session_workspace_set') wsWrites.push([params.sessionId, params.workspacePath]);
        return {};
      }
    },
    sshPool: {
      acquire: async () => {},
      release: () => {},
      isConnected: () => true,
      getManagerForTarget: () => manager,
      getConnectedManager: () => manager
    },
    remoteGatewayPool: {
      ensureForTarget: async (t) => {
        slots.push(t.remotePath);
        return null;
      },
      releaseForTarget: () => {},
      getInfoForTarget: () => null
    },
    sshFacade: null,
    sshCredentialsStore: null,
    tryAutoReconnectSsh: null,
    buildRemoteGatewayPackContext: async () => ({}),
    invalidateRemoteAgentClient: () => {}
  });

  await transport.setSessionRemoteLease('sess-a', true, repoA);
  const leaseTarget = transport.getLeasedTargets();
  if (leaseTarget.length !== 1 || leaseTarget[0].sessionId !== 'sess-a') {
    throw new Error(`leased targets must carry session id, got ${JSON.stringify(leaseTarget)}`);
  }

  wsWrites.length = 0;
  contexts.length = 0;
  slots.length = 0;

  // 同机另一仓库要重连/起槽位，但没有会话身份：不许替任何会话建 worktree、不许改任何会话工作区
  await transport.ensureRemoteGatewayForTarget(repoB);
  if (wsWrites.length || contexts.length) {
    throw new Error(
      `端点上没有会话身份时不许写会话工作区，got ws=${JSON.stringify(wsWrites)} ctx=${JSON.stringify(contexts)}`
    );
  }
  if (slots.length !== 1 || slots[0] !== '/proj-b') {
    throw new Error(`应只按传入目标起槽位，got ${JSON.stringify(slots)}`);
  }

  wsWrites.length = 0;
  contexts.length = 0;
  slots.length = 0;

  // 带了正确会话身份：worktree 建在**自己的**仓库里，会话工作区指向自己的 worktree
  await transport.ensureRemoteGatewayForTarget(repoB, 'sess-b');
  const wroteA = wsWrites.some(([sid]) => sid === 'sess-a');
  const wroteB = wsWrites.some(([sid]) => sid === 'sess-b' && String(wsWrites[0][1] || '').includes('/proj-b/.dieyun/worktrees/'));
  if (wroteA) throw new Error('sess-a 的工作区被 sess-b 的仓库改写了');
  if (!wroteB) throw new Error(`sess-b 应绑到 /proj-b 的 worktree，got ${JSON.stringify(wsWrites)}`);
  if (!String(slots[0] || '').startsWith('/proj-b/.dieyun/worktrees/')) {
    throw new Error(`槽位应按 worktree 分，got ${JSON.stringify(slots)}`);
  }
  console.log('ok foreign-repo gateway ensure cannot hijack another session');
}

/**
 * 租约必须回**生效后**的会话工作区：SSH 会话会被切进自己的 worktree，渲染端若继续用
 * 租约前的仓库根去查索引，就会撞上 `WORKSPACE_SCOPE_MISMATCH`（两份 index.sqlite）。
 */
async function testLeaseReturnsEffectiveWorktreeWorkspace() {
  const repo = '/srv/proj';
  const target = { kind: 'ssh', host: 'h1', port: 22, username: 'u', remotePath: repo };
  const expected = `ssh://u@h1${remoteWorktreePath(repo, 'sess-a')}`;
  const sshManager = {
    status: () => ({ connected: true }),
    async execScript() {
      return { code: 0, stdout: 'WT_CREATED\n', stderr: '' };
    }
  };
  const writes = [];
  const transport = createSessionRemoteTransport({
    localGateway: {
      activeSessionId: 'sess-a',
      getSessionWorkspaceTarget: () => target,
      setSessionWorkspaceContext: (sid, ws) => writes.push([sid, ws]),
      invokeRpc: async () => ({})
    },
    sshPool: {
      acquire: async () => {},
      release: () => {},
      isConnected: () => true,
      getManagerForTarget: () => sshManager,
      getConnectedManager: () => sshManager
    },
    remoteGatewayPool: { releaseForTarget: () => {} },
    sshFacade: null,
    sshCredentialsStore: null,
    tryAutoReconnectSsh: null,
    buildRemoteGatewayPackContext: async () => ({}),
    invalidateRemoteAgentClient: () => {}
  });

  const leased = await transport.setSessionRemoteLease('sess-a', true, target);
  if (leased !== expected) {
    throw new Error(`租约应回 worktree 工作区，got ${JSON.stringify(leased)} / want ${expected}`);
  }
  const released = await transport.setSessionRemoteLease('sess-a', false, target);
  if (released !== '') {
    throw new Error(`释放后不该再给工作区，got ${JSON.stringify(released)}`);
  }
  console.log('ok lease returns effective worktree workspace');
}

/**
 * 视图侧「后台确保」的去重：连续两次切到同一会话（第一次 ensure 还在飞）时只发一次。
 *
 * 为什么要锁这条：那两件活（worktree 检查 / agent 槽位）都排进每连接串行 exec 链，
 * 快速连点会把同一份检查重复堆上去（实测队列深度涨到 5）。去重本身有 60s 上限
 * （卡死的 ensure 不该永久占住 key），这里验的是「在飞时不重复发」。
 */
async function testViewEnsureIsDedupedWhileInFlight() {
  const target = { kind: 'ssh', host: 'h1', port: 22, username: 'u', remotePath: '/proj' };
  let ensureCalls = 0;
  let releaseEnsure = null;

  const transport = createSessionRemoteTransport({
    localGateway: {
      activeSessionId: 'sess-a',
      getSessionWorkspaceTarget: () => target,
      getEffectiveWorkspaceTarget: () => target
    },
    sshPool: {
      acquire: () => {},
      release: () => {},
      isConnected: () => true,
      getManagerForTarget: () => ({ status: () => ({ connected: true }) }),
      getConnectedManager: () => ({ status: () => ({ connected: true }) })
    },
    remoteGatewayPool: {
      getInfoForTarget: () => null,
      ensureForTarget: async () => {
        ensureCalls += 1;
        await new Promise((resolve) => {
          releaseEnsure = resolve;
        });
        return null;
      },
      releaseForTarget: () => {}
    },
    sshFacade: null,
    sshCredentialsStore: null,
    tryAutoReconnectSsh: null,
    buildRemoteGatewayPackContext: async () => ({}),
    invalidateRemoteAgentClient: () => {}
  });

  await transport.applySessionRemoteTransport('sess-a');
  await new Promise((r) => setTimeout(r, 30));
  await transport.applySessionRemoteTransport('sess-a');
  await new Promise((r) => setTimeout(r, 30));

  if (ensureCalls !== 1) {
    throw new Error(`在飞的 ensure 不该重复发，ensure 调用次数=${ensureCalls}`);
  }
  if (typeof releaseEnsure === 'function') releaseEnsure();
  await new Promise((r) => setTimeout(r, 30));
  // 落地之后再切一次：允许重新发（表里已摘掉）
  await transport.applySessionRemoteTransport('sess-a');
  await new Promise((r) => setTimeout(r, 30));
  if (ensureCalls !== 2) {
    throw new Error(`落地后应允许再发一次，ensure 调用次数=${ensureCalls}`);
  }
  if (typeof releaseEnsure === 'function') releaseEnsure();
  console.log('ok view ensure is deduped while in flight');
}

async function main() {
  testRemoteAgentInfoScopedToSession();
  await testRemoteLeaseKeepsTransportOnLocalSwitch();
  await testKeepSshViewOnLocalSwitchWithoutLease();
  await testSameHostPathChangeDoesNotDropSsh();
  await testGetLeasedTargetsCarriesSessionId();
  await testGetLeasedSessionIds();
  await testParallelSameHostDifferentPathLeases();
  await testLeaseHoldIsIdempotentAndDropForce();
  await testForeignRepoGatewayEnsureDoesNotHijackOtherSession();
  await testLeaseReturnsEffectiveWorktreeWorkspace();
  await testViewEnsureIsDedupedWhileInFlight();
  console.log('\nsession-remote-transport: ALL OK');
}

main().catch((e) => {
  console.error('FAIL:', e.message || e);
  process.exit(1);
});

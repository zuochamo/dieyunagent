'use strict';

const { createSessionRemoteTransport } = require('../src/session/session-remote-transport');

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
      isConnected: () => true
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
      getConnectedManagerForEndpoint: () => ({ status: () => ({ connected: true }) }),
      disconnectTarget: async (t) => {
        disconnected.push(t.remotePath);
      },
      disconnectExceptEndpointKeys: async () => {
        disconnected.push('except');
      }
    },
    remoteGatewayPool: {
      getInfoForTarget: () => infoA,
      isActiveForTarget: () => gatewayActive,
      ensureForTarget: async () => {
        ensured.push('/proj-a');
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
  if (ensured.length !== 1) {
    throw new Error(`switch back should reuse running agent, ensure count=${ensured.length}`);
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
      getConnectedManagerForEndpoint: () => ({ status: () => ({ connected: true }) }),
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

async function testGetLeasedSshTargetsDedupesGatewayPaths() {
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

  const leased = transport.getLeasedSshTargets();
  if (leased.length !== 3) {
    throw new Error(`expected 3 leased ssh gateway paths, got ${leased.length}`);
  }
  console.log('ok getLeasedSshTargets dedupes gateway paths');
}

async function testGetLeasedSessionIds() {
  const target = { kind: 'ssh', host: 'h1', port: 22, username: 'u', remotePath: '/bg' };
  const transport = createSessionRemoteTransport({
    localGateway: { activeSessionId: 's0', getSessionWorkspaceTarget: () => null },
    sshPool: { acquire: () => {}, release: () => {}, isConnected: () => true },
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
      getManagerForTarget: () => ({ status: () => ({ connected: true }) })
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
      isConnected: () => true
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

async function main() {
  testRemoteAgentInfoScopedToSession();
  await testRemoteLeaseKeepsTransportOnLocalSwitch();
  await testKeepSshViewOnLocalSwitchWithoutLease();
  await testSameHostPathChangeDoesNotDropSsh();
  await testGetLeasedSshTargetsDedupesGatewayPaths();
  await testGetLeasedSessionIds();
  await testParallelSameHostDifferentPathLeases();
  await testLeaseHoldIsIdempotentAndDropForce();
  console.log('\nsession-remote-transport: ALL OK');
}

main().catch((e) => {
  console.error('FAIL:', e.message || e);
  process.exit(1);
});

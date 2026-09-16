'use strict';

const fs = require('fs');
const path = require('path');
const { createSshCredentialsStore } = require('../ssh/credentials-store');
const { tryAutoReconnectSsh } = require('../ssh/auto-reconnect');
const { createPortForwardManager } = require('../ssh/port-forward-manager');
const { createSshConnectionPool } = require('../ssh/connection-pool');
const { createRemoteGatewayPool } = require('../ssh/remote-gateway-pool');
const { createSessionRemoteTransport } = require('../session/session-remote-transport');
const { invalidateRemoteAgentClient } = require('../gateway/remote-agent-client');

function endpointKeyFromScope(scopeKey) {
  return String(scopeKey || '').split('|')[0] || scopeKey;
}

function invalidateRemoteAgentsForScope(pool, scopeKey, invalidateFn) {
  const invalidate = invalidateFn || invalidateRemoteAgentClient;
  if (pool && scopeKey) {
    const hostKey = String(scopeKey).split('|')[0];
    for (const row of pool.getStatusSummary()) {
      if (row.targetKey === hostKey && row.info) {
        invalidate(row.info);
      }
    }
    return;
  }
  invalidate();
}

function describeRemoteGatewayPack(packRoot, fsApi = fs) {
  const root = String(packRoot || '');
  const manifestPath = path.join(root, 'manifest.json');
  if (!fsApi.existsSync(manifestPath)) {
    return { ok: false, detail: '(缺失，dev 启动时会自动打包)' };
  }
  let lite = false;
  try {
    const m = JSON.parse(fsApi.readFileSync(manifestPath, 'utf8'));
    lite = !!m.lite;
  } catch {
    return { ok: false, detail: '(manifest 无效)' };
  }
  if (lite) {
    const entry = path.join(root, 'remote', 'run-cli.js');
    if (!fsApi.existsSync(entry)) {
      return { ok: false, detail: '(lite 包不完整)' };
    }
    return { ok: true, detail: '(lite，Node 随远程注入)' };
  }
  const nodeUnix = path.join(root, 'bin', 'node');
  const nodeWin = path.join(root, 'bin', 'node.exe');
  const nodeBin = fsApi.existsSync(nodeUnix)
    ? nodeUnix
    : fsApi.existsSync(nodeWin)
      ? nodeWin
      : '';
  if (!nodeBin) {
    return { ok: false, detail: '(缺失 Node，dev 启动时会自动打包)' };
  }
  const mb = Math.round(fsApi.statSync(nodeBin).size / 1024 / 1024);
  return { ok: true, detail: `(Node ${mb}MB)` };
}

function logRemoteGatewayPack(remoteGatewayRuntime, log) {
  try {
    const packRoot = remoteGatewayRuntime.getRemoteGatewayPackRoot();
    const { detail } = describeRemoteGatewayPack(packRoot);
    log.info(`Remote Agent 本地包: ${packRoot} ${detail}`);
  } catch (e) {
    log.warn('Remote Agent 包检查失败:', e && e.message);
  }
}

/**
 * SSH pools, LocalGateway inject, session remote transport.
 * @param {object} deps
 */
function bootWorkspaceRemoteRuntime(deps) {
  const {
    userDataPath,
    readableDir,
    extraReadRoots,
    gatewayLog,
    appVersion,
    appRoot,
    safeStorage,
    log,
    getTerminalPool,
    remoteGatewayRuntime,
    sshReconnect,
    LocalGateway
  } = deps;

  const remoteGatewayPool = createRemoteGatewayPool({ log: (m) => log.info(m) });
  const portForwardManager = createPortForwardManager({ log: (m) => log.info(m) });
  logRemoteGatewayPack(remoteGatewayRuntime, log);

  const sshConnectionPool = createSshConnectionPool({
    userDataPath,
    maxConnections: 8,
    log: (m) => log.info(m),
    onTargetClose: (scopeKey) => {
      const hostKey = endpointKeyFromScope(scopeKey);
      const terminalPool = getTerminalPool && getTerminalPool();
      if (terminalPool) terminalPool.killForRemoteEndpoint(hostKey, 'ssh');
      invalidateRemoteAgentsForScope(remoteGatewayPool, scopeKey, invalidateRemoteAgentClient);
      sshReconnect.scheduleSshAutoReconnect('connection_closed');
    }
  });

  const sshCredentialsStore = createSshCredentialsStore({ safeStorage, userDataPath });
  const localGateway = new LocalGateway({
    userDataPath,
    readableDir,
    extraReadRoots,
    log: gatewayLog,
    appVersion,
    appRoot,
    ssh: null,
    getRemoteAgentInfo: () => remoteGatewayRuntime.getActiveRemoteGatewayInfo()
  });
  const sshSessionManager = sshConnectionPool.createFacade(() => localGateway.getEffectiveWorkspaceTarget());
  localGateway.setSshManager(sshSessionManager);
  localGateway.setSshConnectionPool(sshConnectionPool);
  localGateway.setRemoteGatewayPool(remoteGatewayPool);
  // 内置浏览器在 SSH 工作空间预览远端 localhost 时，由 Gateway 侧按需建转发
  localGateway.setPortForwardManager(portForwardManager);

  let sessionRemoteTransport = null;
  try {
    localGateway.start();
    sessionRemoteTransport = createSessionRemoteTransport({
      localGateway,
      sshPool: sshConnectionPool,
      remoteGatewayPool,
      sshFacade: sshSessionManager,
      sshCredentialsStore,
      tryAutoReconnectSsh,
      buildRemoteGatewayPackContext: () => remoteGatewayRuntime.buildRemoteGatewayPackContext(),
      invalidateRemoteAgentClient,
      log: (m) => log.info(m)
    });
    localGateway.setRemoteAgentInfoProvider((sessionId) =>
      sessionRemoteTransport
        ? sessionRemoteTransport.getRemoteAgentInfoForSession(sessionId)
        : remoteGatewayRuntime.getActiveRemoteGatewayInfo()
    );
    localGateway.setHealRemoteAgentTransport((healOpts) => sshReconnect.healRemoteAgentTransport(healOpts || {}));
    localGateway.setLeasedSessionIdsProvider(() =>
      sessionRemoteTransport ? sessionRemoteTransport.getLeasedSessionIds() : []
    );
    localGateway.setRemoteDisconnectGuard((kind) =>
      sessionRemoteTransport ? sessionRemoteTransport.anyLeaseHeldForKind(kind) : false
    );
    sshReconnect.scheduleSshAutoReconnect('startup');
  } catch (e) {
    log.error('本地 Gateway 启动失败:', e);
  }

  return {
    remoteGatewayPool,
    portForwardManager,
    sshConnectionPool,
    sshCredentialsStore,
    localGateway,
    sshSessionManager,
    sessionRemoteTransport
  };
}

module.exports = {
  bootWorkspaceRemoteRuntime,
  describeRemoteGatewayPack,
  endpointKeyFromScope,
  invalidateRemoteAgentsForScope
};

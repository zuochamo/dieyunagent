'use strict';

const path = require('path');

function getRemoteGatewayPackRoot(app) {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'remote-gateway-pack');
  }
  return path.join(__dirname, '..', '..', 'build', 'remote-gateway-pack');
}

/**
 * Remote Agent pack + per-workspace gateway inject/status.
 * @param {object} deps
 */
function createRemoteGatewayRuntime(deps) {
  const {
    app,
    log,
    getLocalGateway,
    getSshConnectionPool,
    getRemoteGatewayPool,
    invalidateRemoteAgentClient,
    broadcastToRenderers
  } = deps;

  function packRoot() {
    return getRemoteGatewayPackRoot(app);
  }

  async function buildRemoteGatewayPackContext() {
    const liteRoot = packRoot();
    const { ensureRemoteGatewayDeployPack } = require('../optional-assets/service');
    // 部署包完整性（必需文件 + 内置 Node）由 optional-assets 统一校验并抛出
    // REMOTE_GATEWAY_PACK_INCOMPLETE / REMOTE_GATEWAY_PACK_MISSING，此处不再重复判断。
    const resolved = await ensureRemoteGatewayDeployPack({
      userDataPath: app.getPath('userData'),
      resourcesPath: process.resourcesPath,
      litePackRoot: liteRoot,
      appVersion: app.getVersion(),
      onProgress: (payload) => broadcastToRenderers('ssh:remote-agent-deploy-progress', payload || {})
    });
    return {
      packRoot: resolved,
      appVersion: app.getVersion(),
      onProgress: (payload) => broadcastToRenderers('ssh:remote-agent-deploy-progress', payload || {})
    };
  }

  async function ensureRemoteGatewayForCurrentWorkspace() {
    const localGateway = getLocalGateway();
    const sshConnectionPool = getSshConnectionPool();
    const remoteGatewayPool = getRemoteGatewayPool();
    if (!localGateway) return null;
    const ws = localGateway.getWorkspace();
    if (!ws) return null;

    const { packRoot: resolvedPack, appVersion, onProgress } = await buildRemoteGatewayPackContext();

    if (ws.kind === 'ssh' && ws.sshConnected && sshConnectionPool && remoteGatewayPool) {
      const target = localGateway.getEffectiveWorkspaceTarget();
      if (!target || target.kind !== 'ssh') return null;
      const manager = sshConnectionPool.getManagerForTarget(target);
      if (!manager || !manager.status().connected) return null;
      return remoteGatewayPool.ensureForTarget(target, manager, {
        packRoot: resolvedPack,
        appVersion,
        onProgress
      });
    }

    return null;
  }

  function getActiveRemoteGatewayInfo() {
    const localGateway = getLocalGateway();
    const remoteGatewayPool = getRemoteGatewayPool();
    if (localGateway && remoteGatewayPool) {
      const target = localGateway.getEffectiveWorkspaceTarget();
      if (target && target.kind === 'ssh') {
        const info = remoteGatewayPool.getInfoForTarget(target);
        if (info) return info;
      }
    }
    return null;
  }

  function getActiveRemoteGatewayStatus() {
    const localGateway = getLocalGateway();
    const remoteGatewayPool = getRemoteGatewayPool();
    if (localGateway && remoteGatewayPool) {
      const target = localGateway.getEffectiveWorkspaceTarget();
      if (target && target.kind === 'ssh') {
        const st = remoteGatewayPool.getStatusForTarget(target);
        if (st) return st;
      }
    }
    return null;
  }

  return {
    getRemoteGatewayPackRoot: packRoot,
    buildRemoteGatewayPackContext,
    ensureRemoteGatewayForCurrentWorkspace,
    getActiveRemoteGatewayInfo,
    getActiveRemoteGatewayStatus
  };
}

module.exports = { createRemoteGatewayRuntime, getRemoteGatewayPackRoot };

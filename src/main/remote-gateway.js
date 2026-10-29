'use strict';

const path = require('path');
const { ensureSessionWorktree } = require('../session/session-worktree');

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
    const root = packRoot();
    // 内置 Node 随安装包预装：这里只校验完整性，不再下载/装配。
    // 缺项抛 REMOTE_GATEWAY_PACK_INCOMPLETE / REMOTE_GATEWAY_PACK_MISSING（清单单一来源）。
    const { assertRemotePackReady } = require('../remote/remote-pack-layout');
    assertRemotePackReady(root);
    return {
      packRoot: root,
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
      // 当前会话的 worktree 先就位：agent 的 --workspace 就是它
      const effective = await ensureSessionWorktree({
        localGateway,
        sshManager: manager,
        sessionId: localGateway.activeSessionId,
        target,
        log: (msg) => {
          if (typeof log === 'function') log(msg);
          else if (log && typeof log.info === 'function') log.info(msg);
        }
      });
      return remoteGatewayPool.ensureForTarget(effective || target, manager, {
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

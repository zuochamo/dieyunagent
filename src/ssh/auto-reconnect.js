'use strict';

const { isSameSshTarget } = require('../workspace/target');

/**
 * @param {{
 *   localGateway: import('../gateway/server').LocalGateway,
 *   sshSessionManager: ReturnType<import('./session-manager').createSshSessionManager>,
 *   sshPool?: ReturnType<import('./connection-pool').createSshConnectionPool> | null,
 *   target?: import('../workspace/target').SshWorkspaceTarget | null,
 *   credentialsStore: ReturnType<import('./credentials-store').createSshCredentialsStore>,
 *   log?: (msg: string) => void
 * }} ctx
 */
async function tryAutoReconnectSsh(ctx) {
  const log = ctx.log || (() => {});
  const gw = ctx.localGateway;
  const ssh = ctx.sshSessionManager;
  const creds = ctx.credentialsStore;
  const pool = ctx.sshPool || null;
  if (!gw || !ssh || !creds) return { ok: false, reason: 'missing_services' };

  const target =
    ctx.target && ctx.target.kind === 'ssh'
      ? ctx.target
      : gw.getWorkspaceTarget
        ? gw.getWorkspaceTarget()
        : null;
  if (!target || target.kind !== 'ssh') return { ok: false, reason: 'not_ssh_workspace' };

  if (pool && pool.isConnected(target)) {
    return { ok: true, already: true };
  }

  if (!pool) {
    const st = ssh.status();
    if (st.connected && isSameSshTarget(target, st)) {
      return { ok: true, already: true };
    }
  }

  const secrets = creds.loadConnectSecrets(target.host, target.port, target.username);
  if (!secrets) {
    log('SSH 工作空间已保存但未记住登录信息，需手动重连');
    return { ok: false, reason: 'no_saved_credentials' };
  }

  const payload = {
    host: target.host,
    port: target.port,
    username: target.username,
    authType: secrets.authType
  };
  if (secrets.authType === 'key') {
    payload.privateKeyPath = secrets.privateKeyPath;
    payload.passphrase = secrets.passphrase;
  } else {
    payload.password = secrets.password;
  }

  if (secrets.authType === 'key' && !payload.privateKeyPath) {
    return { ok: false, reason: 'missing_key_path' };
  }
  if (secrets.authType === 'password' && !payload.password) {
    return { ok: false, reason: 'missing_password' };
  }

  if (pool) {
    await pool.connect(target, payload);
  } else {
    await ssh.connect(payload);
  }
  log(`SSH 已自动重连 ${target.username}@${target.host}:${target.remotePath}`);
  return { ok: true, reconnected: true };
}

module.exports = { tryAutoReconnectSsh };

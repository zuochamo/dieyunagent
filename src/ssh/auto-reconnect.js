'use strict';

const { isSameSshTarget } = require('../workspace/target');
const { resolveReconnectPayload } = require('./connect-payload');

/**
 * 自动重连 = 「用户上次手动连接时的那套意图」再走一遍，因此连接参数必须与
 * 手动连接共用同一个装配点（connect-payload）：别名解析、已存凭据、agent
 * 都在那里定。历史上这里自己拼 payload，于是手动连得上、自动重连连不上。
 *
 * @param {{
 *   localGateway: import('../gateway/server').LocalGateway,
 *   sshSessionManager: ReturnType<import('./session-manager').createSshSessionManager>,
 *   sshPool?: ReturnType<import('./connection-pool').createSshConnectionPool> | null,
 *   target?: import('../workspace/target').SshWorkspaceTarget | null,
 *   credentialsStore: ReturnType<import('./credentials-store').createSshCredentialsStore>,
 *   getSshConfigBlocks?: () => any[],
 *   log?: (msg: string) => void
 * }} ctx
 */
async function tryAutoReconnectSsh(ctx) {
  const log = ctx.log || (() => {});
  const gw = ctx.localGateway;
  const ssh = ctx.sshSessionManager;
  const creds = ctx.credentialsStore;
  const pool = ctx.sshPool || null;
  if (!gw || !ssh) return { ok: false, reason: 'missing_services' };

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

  let payload;
  try {
    payload = resolveReconnectPayload(target, {
      credentialsStore: creds,
      sshConfigBlocks: typeof ctx.getSshConfigBlocks === 'function' ? ctx.getSshConfigBlocks() : [],
      log: (m) => log(`[ssh-reconnect] ${m}`)
    });
  } catch (e) {
    // 没有凭据也没有 agent/config 身份：这就是「需要手动重连」，不是故障
    const code = e && e.code;
    log(`SSH 工作空间已保存但无法自动重连（${(e && e.message) || e}），需手动连接`);
    return {
      ok: false,
      reason: code === 'SSH_NO_AUTH_METHOD' ? 'no_auth_method' : 'no_saved_credentials',
      error: (e && e.message) || String(e)
    };
  }

  if (pool) {
    await pool.connect(target, payload);
  } else {
    await ssh.connect(payload);
  }
  log(`SSH 已自动重连 ${payload.username}@${payload.hostname}:${payload.port}`);
  return { ok: true, reconnected: true, authType: payload.authType };
}

module.exports = { tryAutoReconnectSsh };

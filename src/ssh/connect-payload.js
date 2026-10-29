'use strict';

/**
 * 「连接意图」→「有效连接参数」的唯一入口。
 *
 * 改造前，「UI 表单 payload」和「自动重连 payload」各自拼一份（各自读
 * credentials-store、各自决定 authType），两条路一旦分叉就是同一种病：
 * 手动连得上、自动重连连不上（或反之），而且都读不到 `~/.ssh/config`。
 *
 * 现在两份调用方都走这里，单点解决三件事：
 *   1. 别名解析（HostName / User / Port / IdentityFile / ProxyJump）；
 *   2. 凭据优先级：显式输入 > 已存凭据 > config；
 *   3. 认证方式落定（agent / key / password），以及「什么都没给」时的明确报错。
 *
 * 本文件不建立任何连接，也不读私钥内容（只传路径），因此可以纯单测。
 */

const { resolveHostConfig, parseProxyJump } = require('./ssh-config');
const { detectAgentSocket } = require('./auth-methods');

function nonEmpty(v) {
  return String(v == null ? '' : v).trim();
}

/**
 * @param {object} raw 原始 payload（UI 表单 / 自动重连构造）
 * @param {{
 *   credentialsStore?: any,
 *   sshConfigBlocks?: any[],
 *   agentSocket?: string,
 *   log?: (msg: string) => void
 * }} [deps]
 */
function resolveConnectPayload(raw = {}, deps = {}) {
  const log = deps.log || (() => {});
  const warnings = [];
  const alias = nonEmpty(raw.host);
  if (!alias) {
    throw Object.assign(new Error('主机与用户名必填'), { code: 'INVALID_SSH' });
  }

  const blocks = Array.isArray(deps.sshConfigBlocks) ? deps.sshConfigBlocks : [];
  const cfg = blocks.length ? resolveHostConfig(blocks, alias) : null;
  const configMatched = !!(cfg && cfg.matched);

  const hostname = nonEmpty(raw.hostname) || (configMatched ? cfg.hostName : '') || alias;
  // 端口：UI 的 22 是默认值而非用户选择，config 里写了别的就按 config 走
  const rawPort = Number(raw.port) || 0;
  const configPort = configMatched ? Number(cfg.port) || 0 : 0;
  const port = rawPort && rawPort !== 22 ? rawPort : configPort || rawPort || 22;

  let username = nonEmpty(raw.username) || (configMatched ? nonEmpty(cfg.user) : '');
  const identityFiles = configMatched ? cfg.identityFiles.slice() : [];

  if (configMatched && cfg.proxyCommand && !cfg.proxyJump) {
    // 不假装支持：ProxyCommand 需要执行任意本地命令，我们不做
    warnings.push('~/.ssh/config 里的 ProxyCommand 未支持（不会执行本地命令），已忽略；请改用 ProxyJump');
  }

  // ---- 凭据：显式 > 已存 > config ----
  let saved = null;
  if (deps.credentialsStore && (raw.remember || raw.useSaved === true)) {
    const lookup = (h) => {
      try {
        return deps.credentialsStore.loadConnectSecrets(h, port, username);
      } catch {
        return null;
      }
    };
    // 用户名留空时不能按 (host,port,username) 查：那一格永远是空的。
    // 按 host:port 反查已存记录，顺便把用户名取回来（否则「使用已保存凭据」永远找不到自己）。
    const lookupByHost = (h) => {
      if (username) return null;
      try {
        return typeof deps.credentialsStore.findSavedProfileForHost === 'function'
          ? deps.credentialsStore.findSavedProfileForHost(h, port)
          : null;
      } catch {
        return null;
      }
    };
    saved = lookup(alias) || lookupByHost(alias);
    if (!saved && hostname !== alias) saved = lookup(hostname) || lookupByHost(hostname);
    if (saved) {
      if (!username) username = nonEmpty(saved.username) || username;
      if (!identityFiles.length && saved.privateKeyPath) identityFiles.push(saved.privateKeyPath);
    }
  }

  if (!username) {
    throw Object.assign(new Error('用户名必填（也可以在 ~/.ssh/config 里为该主机配置 User）'), {
      code: 'INVALID_SSH'
    });
  }

  const agentSocket = deps.agentSocket === undefined ? detectAgentSocket() : deps.agentSocket;
  const wants = nonEmpty(raw.authType).toLowerCase();
  const explicitPassword = nonEmpty(raw.password) || nonEmpty(saved && saved.password);
  const explicitKeyPath =
    nonEmpty(raw.privateKeyPath) || nonEmpty(saved && saved.privateKeyPath) || identityFiles[0] || '';
  const passphrase = nonEmpty(raw.passphrase) || nonEmpty(saved && saved.passphrase);

  /**
   * 认证方式 = 一条**有序的候选链**，不是一个开关。
   *
   * `auto` 就是 `ssh alias` 的行为：agent → config/显式私钥 → 密码；
   * 显式选择某种方式时只留那一种（用户既然点了「用密码」，就别让 agent 的钥匙
   * 先去消耗服务器的 MaxAuthTries）。同一条链上的方法由 session-manager 交给
   * ssh2 的 authHandler 逐个试。
   */
  const methods = [];
  if (wants === 'agent') {
    methods.push('agent');
    if (explicitPassword) methods.push('password');
  } else if (wants === 'key') {
    if (!explicitKeyPath) {
      if (agentSocket) methods.push('agent');
      else throw Object.assign(new Error('请选择私钥文件（或改用 ssh-agent）'), { code: 'INVALID_SSH' });
    } else {
      methods.push('key');
      if (explicitPassword) methods.push('password');
    }
  } else if (wants === 'password') {
    if (explicitPassword) methods.push('password');
    else if (agentSocket) methods.push('agent');
    else throw Object.assign(new Error('密码必填'), { code: 'INVALID_SSH' });
  } else if (nonEmpty(raw.password)) {
    // 用户这一秒亲手填了密码 = 明确要用它；别让 agent 的钥匙先去吃掉 MaxAuthTries
    methods.push('password');
  } else {
    if (agentSocket) methods.push('agent');
    if (identityFiles.length || explicitKeyPath) methods.push('key');
    // 已存密码只是兜底材料，排在 agent/私钥之后（与 OpenSSH 的 publickey 优先一致）
    if (explicitPassword) methods.push('password');
  }

  if (!methods.length) {
    throw Object.assign(
      new Error(
        '没有可用的认证方式：未检测到 ssh-agent、没有可用的私钥文件、也没有密码。' +
          '请启动 ssh-agent、在 ~/.ssh/config 为该主机配置 IdentityFile，或填写密码。'
      ),
      { code: 'SSH_NO_AUTH_METHOD' }
    );
  }
  // 展示/落库用的「实际会先用哪种」
  const authType = methods[0];
  if (authType === 'key' && !explicitKeyPath) {
    throw Object.assign(new Error('请选择私钥文件'), { code: 'INVALID_SSH' });
  }

  // ---- 跳板：config 的 ProxyJump（或调用方显式给的） ----
  const jumpSpec = nonEmpty(raw.proxyJump) || (configMatched ? cfg.proxyJump : '');
  const jumps = parseProxyJump(jumpSpec).map((hop) => {
    const hopCfg = blocks.length ? resolveHostConfig(blocks, hop.host) : null;
    const hopMatched = !!(hopCfg && hopCfg.matched);
    return {
      host: hop.host,
      hostname: hopMatched ? hopCfg.hostName || hop.host : hop.host,
      port: hop.port !== 22 ? hop.port : (hopMatched && Number(hopCfg.port)) || hop.port,
      username: hop.username || (hopMatched ? nonEmpty(hopCfg.user) : '') || username,
      identityFiles: hopMatched ? hopCfg.identityFiles.slice() : []
    };
  });

  const resolved = {
    host: alias,
    hostname,
    port,
    username,
    authType,
    // 候选认证链（前一个失败后由 ssh2 authHandler 继续下一个）
    methods,
    // 密码同时留给 keyboard-interactive 应答（password-over-kbd 的发行版默认）
    password: methods.includes('password') ? explicitPassword : '',
    privateKeyPath: methods.includes('key') ? explicitKeyPath : '',
    passphrase: methods.includes('key') ? passphrase : '',
    identityFiles,
    agentSocket: methods.includes('agent') ? agentSocket : '',
    jumps,
    remember: raw.remember === true,
    acceptNewHostKey: raw.acceptNewHostKey === true,
    config: {
      matched: configMatched,
      alias,
      hostName: configMatched ? cfg.hostName : '',
      proxyJump: configMatched ? cfg.proxyJump : ''
    },
    warnings
  };

  // 日志只留结构化身份，绝不打密码/口令
  log(
    `SSH 连接参数：${resolved.username}@${resolved.hostname}:${resolved.port} ` +
      `auth=${methods.join('>')}${configMatched ? ' (来自 ssh config)' : ''}` +
      `${jumps.length ? ` via ${jumps.map((h) => h.hostname).join(',')}` : ''}`
  );
  return resolved;
}

/**
 * 自动重连没有「用户输入」，只有工作区 target + 已存凭据：
 * 统一走 resolveConnectPayload，避免与手动连接分叉。
 *
 * @param {{host: string, port?: number, username: string}} target
 * @param {{credentialsStore?: any, sshConfigBlocks?: any[], agentSocket?: string, log?: (m:string)=>void}} deps
 */
function resolveReconnectPayload(target, deps = {}) {
  return resolveConnectPayload(
    {
      host: target.host,
      port: target.port,
      username: target.username,
      authType: 'auto',
      useSaved: true,
      remember: true
    },
    deps
  );
}

module.exports = { resolveConnectPayload, resolveReconnectPayload };

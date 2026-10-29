'use strict';

/**
 * 认证方式装配（agent / 私钥 / keyboard-interactive / 密码）。
 *
 * 为什么单独成文件：`session-manager` 原来把「读私钥 → 决定 authType → 拼 connectOpts」
 * 揉在 connect() 里，导致三件事无法成立：
 *   1. ssh-agent（不落地私钥就能认证；现代桌面/CI 的默认形态）；
 *   2. 服务器要求 keyboard-interactive 时（password 走 kbd 的发行版默认、
 *      以及 password+OTP 的两问形态）无人应答，直接卡死；
 *   3. 默认认证顺序是 ssh2 的 password → publickey，与 OpenSSH 相反：
 *      密码先试会消耗服务器的 MaxAuthTries，2FA 主机上尤其糟。
 *
 * 这里只做纯逻辑（不碰网络、不开连接），便于单测；连接仍在 session-manager。
 */

const fs = require('fs');

/** Windows OpenSSH 的 agent 命名管道（ssh-agent 服务的固定地址）。 */
const WINDOWS_OPENSSH_AGENT_PIPE = '\\\\.\\pipe\\openssh-ssh-agent';

/**
 * 找出可用的 agent socket。
 * 只认「确定存在」的：POSIX 看 SSH_AUTH_SOCK，Windows 还认 OpenSSH 的命名管道。
 * 返回空串表示没有 agent —— 调用方据此不把 agent 放进认证链（否则 ssh2 会为
 * 一个连不上的 agent 白费一次认证机会）。
 *
 * @param {{env?: Record<string,string|undefined>, platform?: string, fsApi?: typeof fs}} [opts]
 * @returns {string}
 */
function detectAgentSocket(opts = {}) {
  const env = opts.env || process.env;
  const platform = opts.platform || process.platform;
  const fsApi = opts.fsApi || fs;
  const fromEnv = String(env.SSH_AUTH_SOCK || '').trim();
  if (fromEnv) return fromEnv;
  if (platform === 'win32') {
    try {
      if (fsApi.existsSync(WINDOWS_OPENSSH_AGENT_PIPE)) return WINDOWS_OPENSSH_AGENT_PIPE;
    } catch {
      // 管道探测失败就当没有 agent
    }
  }
  return '';
}

/** 认证计划里的一项在服务器视角的方法名（agent 走的是 publickey）。 */
function serverMethodOf(type) {
  return type === 'agent' ? 'publickey' : type;
}

/**
 * 构建认证计划（顺序 = OpenSSH：agent/publickey → keyboard-interactive → password）。
 *
 * 每一项自带所需的材料，因此 `IdentityFile` 可以给多个：服务器仍说 publickey 时
 * 就换下一把钥匙重试，这正是 OpenSSH 的行为。
 *
 * @param {{agentSocket?: string, privateKeys?: Array<{key: Buffer|string, passphrase?: string, path?: string}>, password?: string}} input
 * @returns {Array<{type:'agent'|'publickey'|'keyboard-interactive'|'password'}>}
 */
function buildAuthPlan(input = {}) {
  const plan = [];
  if (input.agentSocket) plan.push({ type: 'agent', agentSocket: input.agentSocket });
  for (const item of input.privateKeys || []) {
    if (!item || !item.key) continue;
    plan.push({ type: 'publickey', key: item.key, passphrase: item.passphrase || undefined, path: item.path || '' });
  }
  // 没有密码就没人能应答 kbd 的提问，不要把它挂进链里白跑一次认证
  if (input.password) {
    plan.push({ type: 'keyboard-interactive', password: input.password });
    plan.push({ type: 'password', password: input.password });
  }
  return plan;
}

/**
 * 认证状态：让「服务器问了不该由密码回答的问题」变成一条能落到 UI 的错误，
 * 而不是 ssh2 那句统一的 `All configured authentication methods failed`。
 * @returns {{unanswerablePrompts: string[], rounds: number}}
 */
function createAuthState() {
  return { unanswerablePrompts: [], rounds: 0 };
}

/**
 * keyboard-interactive 应答器。
 *
 * 只应答「单问 + 不回显」这一种：那是 password-over-kbd（RHEL/Debian 默认的
 * `KbdInteractiveAuthentication yes` 场景）。回显的单问（一次性验证码）和
 * 多问（password + OTP）需要人机交互，这里记下提问原文并空答，让认证按其
 * 自然顺序失败，由上层给出可读提示。
 *
 * @param {{password?: string, state?: ReturnType<typeof createAuthState>}} input
 */
function createKeyboardInteractivePrompt(input = {}) {
  const password = input.password;
  const state = input.state || createAuthState();
  return (name, instructions, lang, prompts, finish) => {
    state.rounds += 1;
    const list = Array.isArray(prompts) ? prompts : [];
    const texts = list.map((p) => String((p && p.prompt) || '').trim()).filter(Boolean);
    const answerable = !!password && list.length === 1 && list[0] && list[0].echo === false;
    if (answerable) {
      finish([password]);
      return;
    }
    state.unanswerablePrompts = texts.length ? texts : [String(name || 'keyboard-interactive')];
    // ssh2 只接受 answers 数组；空答等于放弃这一轮
    finish([]);
  };
}

/**
 * 有序 authHandler：让 ssh2 按我们给的顺序逐个方法试，而不是它自己的顺序。
 *
 * 返回值约定（见 ssh2 client.js）：
 *   - 首次调用 `methodsLeft` 为 null → 先发 `none` 探测（OpenSSH 同款）
 *   - 之后 `methodsLeft` 是服务器仍允许的方法 → 取计划里第一个可用的
 *   - `partialSuccess` 为真 → 重复上一个方法（多轮 kbd / 换 key）
 *   - 无可用方法 → `false`（ssh2 会报「All configured authentication methods failed」）
 *
 * @param {{username: string, plan: Array<any>, state: ReturnType<typeof createAuthState>}} input
 */
function createOrderedAuthHandler(input) {
  const username = input.username;
  const plan = Array.isArray(input.plan) ? input.plan : [];
  const state = input.state || createAuthState();
  const tried = new Set();
  let lastEntry = null;
  let attempts = 0;
  const maxAttempts = plan.length + 3;

  const describe = (entry) => {
    switch (entry.type) {
      case 'agent':
        return { type: 'agent', username, agent: entry.agentSocket };
      case 'publickey':
        return { type: 'publickey', username, key: entry.key, passphrase: entry.passphrase };
      case 'keyboard-interactive':
        return {
          type: 'keyboard-interactive',
          username,
          prompt: createKeyboardInteractivePrompt({ password: entry.password, state })
        };
      case 'password':
        return { type: 'password', username, password: entry.password };
      default:
        return null;
    }
  };

  return (methodsLeft, partialSuccess, callback) => {
    attempts += 1;
    if (attempts > maxAttempts) return false;
    // 首次握手：先探测服务器支持哪些方法
    if (!Array.isArray(methodsLeft)) {
      return 'none';
    }
    // 多轮认证（例如 kbd 第二轮）：沿用上一轮的方法 —— 但只在服务器**这一步还接受**它时。
    // 典型场景 `AuthenticationMethods publickey,password`：publickey 成功后服务器回
    // partialSuccess 且 methodsLeft=['password']，此时继续复用 publickey 会被判失败，
    // 整台机器永远连不上。剩下可用的方法才轮到 plan 里的下一个。
    if (partialSuccess === true && lastEntry) {
      if (methodsLeft.indexOf(serverMethodOf(lastEntry.type)) !== -1) {
        const again = describe(lastEntry);
        if (again) return again;
      }
    }
    for (let idx = 0; idx < plan.length; idx++) {
      const entry = plan[idx];
      if (tried.has(idx)) continue;
      if (methodsLeft.indexOf(serverMethodOf(entry.type)) === -1) continue;
      tried.add(idx);
      lastEntry = entry;
      const next = describe(entry);
      if (next) return next;
    }
    return false;
  };
}

module.exports = {
  WINDOWS_OPENSSH_AGENT_PIPE,
  detectAgentSocket,
  buildAuthPlan,
  createAuthState,
  createKeyboardInteractivePrompt,
  createOrderedAuthHandler,
  serverMethodOf
};

'use strict';
/**
 * 认证方式装配：agent 探测、认证顺序（OpenSSH 语义）、keyboard-interactive 应答边界。
 * 这里错了的表现是「连不上但日志里看不出为什么」，所以逐条固定。
 */
const assert = require('node:assert/strict');

const {
  detectAgentSocket,
  buildAuthPlan,
  createAuthState,
  createKeyboardInteractivePrompt,
  createOrderedAuthHandler,
  serverMethodOf,
  WINDOWS_OPENSSH_AGENT_PIPE
} = require('../../src/ssh/auth-methods');

describe('detectAgentSocket', () => {
  const fsApi = { existsSync: (p) => p === WINDOWS_OPENSSH_AGENT_PIPE };

  it('POSIX 取 SSH_AUTH_SOCK', () => {
    assert.equal(detectAgentSocket({ env: { SSH_AUTH_SOCK: '/tmp/agent.x' }, platform: 'linux', fsApi }), '/tmp/agent.x');
  });

  it('Windows 命名管道存在时用它', () => {
    assert.equal(
      detectAgentSocket({ env: {}, platform: 'win32', fsApi }),
      WINDOWS_OPENSSH_AGENT_PIPE
    );
  });

  it('Windows 没有管道时返回空（不许把不可用的 agent 塞进认证链）', () => {
    assert.equal(detectAgentSocket({ env: {}, platform: 'win32', fsApi: { existsSync: () => false } }), '');
    assert.equal(detectAgentSocket({ env: {}, platform: 'linux', fsApi }), '');
  });
});

describe('buildAuthPlan', () => {
  const key1 = { key: Buffer.from('k1'), passphrase: 'p1', path: '/k1' };
  const key2 = { key: Buffer.from('k2'), path: '/k2' };

  it('顺序是 agent → 私钥（可多把）→ keyboard-interactive → password', () => {
    const plan = buildAuthPlan({ agentSocket: '/tmp/a', privateKeys: [key1, key2], password: 'pw' });
    assert.deepEqual(
      plan.map((e) => e.type),
      ['agent', 'publickey', 'publickey', 'keyboard-interactive', 'password']
    );
  });

  it('没有密码就不挂 keyboard-interactive（没人能应答，白费一次认证）', () => {
    const plan = buildAuthPlan({ agentSocket: '/tmp/a', privateKeys: [key1] });
    assert.deepEqual(plan.map((e) => e.type), ['agent', 'publickey']);
  });

  it('空材料得到空计划（上层据此报「没有可用认证方式」）', () => {
    assert.deepEqual(buildAuthPlan({}), []);
    assert.deepEqual(buildAuthPlan({ privateKeys: [{ passphrase: 'x' }] }), []);
  });

  it('agent 在服务器视角是 publickey', () => {
    assert.equal(serverMethodOf('agent'), 'publickey');
    assert.equal(serverMethodOf('password'), 'password');
  });
});

describe('createOrderedAuthHandler', () => {
  const plan = buildAuthPlan({
    agentSocket: '/tmp/agent',
    privateKeys: [{ key: Buffer.from('k'), path: '/k' }],
    password: 'pw'
  });

  it('首次调用先发 none 探测', () => {
    const h = createOrderedAuthHandler({ username: 'u', plan });
    assert.equal(h(null, null, () => {}), 'none');
  });

  it('按计划顺序选服务器允许的方法', () => {
    const h = createOrderedAuthHandler({ username: 'u', plan });
    const agentAuth = h(['publickey', 'keyboard-interactive', 'password'], false, () => {});
    assert.equal(agentAuth.type, 'agent');
    assert.equal(agentAuth.agent, '/tmp/agent');

    // agent 的钥匙全被拒 → 换私钥
    const keyAuth = h(['publickey', 'keyboard-interactive', 'password'], false, () => {});
    assert.equal(keyAuth.type, 'publickey');
    assert.equal(keyAuth.key.toString(), 'k');

    // 私钥也被拒 → kbd 优先于 password
    const kbd = h(['keyboard-interactive', 'password'], false, () => {});
    assert.equal(kbd.type, 'keyboard-interactive');
    assert.equal(typeof kbd.prompt, 'function');

    const pw = h(['password'], false, () => {});
    assert.equal(pw.type, 'password');
    assert.equal(pw.password, 'pw');

    assert.equal(h([], false, () => {}), false);
  });

  it('服务器不允许的方法不会被尝试（例如只允许 publickey 时不会发密码）', () => {
    const h = createOrderedAuthHandler({ username: 'u', plan });
    h(null, null, () => {});
    assert.equal(h(['publickey'], false, () => {}).type, 'agent');
    assert.equal(h(['publickey'], false, () => {}).type, 'publickey');
    assert.equal(h(['publickey'], false, () => {}), false);
  });

  it('partialSuccess 时重复上一个方法（多轮 kbd）', () => {
    const kbdPlan = buildAuthPlan({ password: 'pw' });
    const h = createOrderedAuthHandler({ username: 'u', plan: kbdPlan });
    h(null, null, () => {});
    const first = h(['keyboard-interactive'], false, () => {});
    assert.equal(first.type, 'keyboard-interactive');
    const second = h(['keyboard-interactive'], true, () => {});
    assert.equal(second.type, 'keyboard-interactive');
  });

  /**
   * `AuthenticationMethods publickey,password`：publickey 成功后服务器回 partialSuccess，
   * 且 methodsLeft 只剩 password。以前这里无条件重发上一个方法（publickey），服务器继续
   * 判失败 → 这类主机永远连不上。剩下可用什么就必须发什么。
   */
  it('partialSuccess 且上一个方法不再被允许时，换下一个可用方法', () => {
    const multi = buildAuthPlan({ privateKeys: [{ key: Buffer.from('k'), path: '/k' }], password: 'pw' });
    const h = createOrderedAuthHandler({ username: 'u', plan: multi });
    h(null, null, () => {});
    const keyAuth = h(['publickey', 'password'], false, () => {});
    assert.equal(keyAuth.type, 'publickey');
    // 服务器：公钥已过，接下来要 password
    const second = h(['password'], true, () => {});
    assert.equal(second.type, 'password', '必须切到服务器还允许的 password');
    assert.equal(second.password, 'pw');
  });

  it('partialSuccess 且没有可用方法时返回 false（不要死循环重试同一个）', () => {
    const only = buildAuthPlan({ privateKeys: [{ key: Buffer.from('k'), path: '/k' }] });
    const h = createOrderedAuthHandler({ username: 'u', plan: only });
    h(null, null, () => {});
    assert.equal(h(['publickey'], false, () => {}).type, 'publickey');
    assert.equal(h([], true, () => {}), false);
  });
});

describe('keyboard-interactive 应答边界', () => {
  const finishSpy = () => {
    const calls = [];
    const finish = (answers) => calls.push(answers);
    return { finish, calls };
  };

  it('单问 + 不回显（password-over-kbd）用密码应答', () => {
    const state = createAuthState();
    const prompt = createKeyboardInteractivePrompt({ password: 'pw', state });
    const { finish, calls } = finishSpy();
    prompt('', '', '', [{ prompt: 'Password: ', echo: false }], finish);
    assert.deepEqual(calls, [['pw']]);
    assert.deepEqual(state.unanswerablePrompts, []);
  });

  it('回显的单问（验证码）不拿密码硬答，并记下提问原文', () => {
    const state = createAuthState();
    const prompt = createKeyboardInteractivePrompt({ password: 'pw', state });
    const { finish, calls } = finishSpy();
    prompt('', '', '', [{ prompt: 'Verification code: ', echo: true }], finish);
    assert.deepEqual(calls, [[]]);
    assert.deepEqual(state.unanswerablePrompts, ['Verification code:']);
  });

  it('多问（password + OTP）同样记下原文', () => {
    const state = createAuthState();
    const prompt = createKeyboardInteractivePrompt({ password: 'pw', state });
    const { finish, calls } = finishSpy();
    prompt('', '', '', [{ prompt: 'Password: ', echo: false }, { prompt: 'OTP: ', echo: true }], finish);
    assert.deepEqual(calls, [[]]);
    assert.deepEqual(state.unanswerablePrompts, ['Password:', 'OTP:']);
  });

  it('没有密码时直接放弃这一轮', () => {
    const state = createAuthState();
    const prompt = createKeyboardInteractivePrompt({ state });
    const { finish, calls } = finishSpy();
    prompt('', '', '', [{ prompt: 'Password: ', echo: false }], finish);
    assert.deepEqual(calls, [[]]);
    assert.deepEqual(state.unanswerablePrompts, ['Password:']);
  });
});

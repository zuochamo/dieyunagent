'use strict';

/**
 * 沙箱策略与 ask-once 审批的契约测试（纯函数 + 无 UI 依赖）。
 *
 * 用法: node scripts/test-sandbox-policy.cjs
 */

const {
  SANDBOX_MODES,
  DEFAULT_SANDBOX_MODE,
  normalizeSandboxMode,
  decideShellCommand,
  decideFsWrite,
  extractPathTokens,
  sandboxErrorFor
} = require('../src/gateway/sandbox-policy');
const { createSandboxApprovals } = require('../src/gateway/sandbox-approvals');

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assert failed');
}

const WS = 'C:\\work\\proj';
const INTERNAL = ['C:\\Users\\u\\AppData\\Roaming\\dieyunagent', 'C:\\Users\\u\\.dieyun'];
const base = { workspaceRoots: [WS], internalRoots: INTERNAL };

async function main() {
  // 1) 档位归一
  assert(SANDBOX_MODES.length === 3, 'three modes');
  assert(DEFAULT_SANDBOX_MODE === 'workspace-write', 'default is workspace-write');
  assert(normalizeSandboxMode('READ-ONLY') === 'read-only', 'case-insensitive');
  assert(normalizeSandboxMode('nonsense') === DEFAULT_SANDBOX_MODE, 'unknown falls back to default');

  // 2) 高危命令：任何档位都是 deny，且没有"问一次"的余地
  for (const mode of SANDBOX_MODES) {
    for (const bad of [
      'shutdown /s /t 0',
      'cmd /c shutdown /s',
      'sudo shutdown -h now',
      'format c:',
      'rm -rf /',
      'powershell -enc AAA',
      'bcdedit /set x'
    ]) {
      const d = decideShellCommand(bad, { ...base, mode });
      assert(d.action === 'deny', `${mode} must deny: ${bad} (got ${d.action})`);
    }
    // 反向：只是**提到**关机/重启的只读命令不能被拒（以前 shutdown 是整条命令正则匹配，
    // 于是 `grep -rn shutdown src/` 和 `git commit -m "fix reboot loop"` 都被当成关机杀掉）
    for (const readOnly of ['grep -rn shutdown src/', 'git log --grep=shutdown', 'rg "reboot"', 'echo reboot']) {
      const d = decideShellCommand(readOnly, { ...base, mode });
      assert(d.action !== 'deny', `${mode} must not deny: ${readOnly} (got ${d.action})`);
    }
  }

  // 3) read-only：只读放行、写要问、外部写要问、联网要问
  {
    const ro = (cmd) => decideShellCommand(cmd, { ...base, mode: 'read-only' });
    assert(ro('git status').action === 'allow', 'read-only allows git status');
    // 内联代码/脚本一律按"可能落盘"归类：read-only 的意义就是"跑什么都先问一次"
    // （以前把 `node -e` 当只读放行，实测 `node writer.js` 能无声写进主目录）
    assert(ro('node -e "console.log(1)"').action === 'ask', 'read-only asks before node -e');
    assert(ro('npm install').action === 'ask', 'read-only asks for npm install');
    assert(ro('echo hi > out.txt').action === 'ask', 'read-only asks for redirect write');
    assert(ro('curl https://example.com').action === 'ask', 'read-only asks for network');
    // fd 复制不是落盘：`2>&1` 是最常见的误弹来源
    assert(ro('ls 2>&1').action === 'allow', 'read-only treats 2>&1 as read');

    // 解释器按**程序位 basename** 认，不按字面量认：绝对路径的 node/python 一样要问
    // （以前 `\bnode\s+-e\b` 只认裸命令名，`"C:\Program Files\nodejs\node.exe" -e ...`
    //   在 read-only 下 0 次询问直接跑 —— 档位名存实亡）
    for (const cmd of [
      '"C:\\Program Files\\nodejs\\node.exe" -e "console.log(1)"',
      'node.exe script.js',
      '/usr/bin/python3 -c "print(1)"',
      'sudo node build.js',
      'cmd /c node -e "1"',
      'cmd /c "node -e \\"1\\""',
      'bash -c "node x.js"',
      'timeout 10 node x.js'
    ]) {
      assert(ro(cmd).action === 'ask', `read-only asks for interpreter: ${cmd}`);
    }
    // 反向：只是**提到**解释器名、纯信息开关、或宿主 shell 里跑只读命令，不许弹
    for (const cmd of [
      'grep -rn node src/',
      'echo "node -e 1"',
      'node -v',
      'python --version',
      'cmd /c dir',
      'cmd /?',
      'bash -c "ls"',
      'powershell -NoProfile -Command "Get-Date"'
    ]) {
      assert(ro(cmd).action === 'allow', `read-only must not ask for: ${cmd}`);
    }
  }

  // 4) workspace-write：工作区内写放行，越界写要问，联网放行
  {
    const ww = (cmd) => decideShellCommand(cmd, { ...base, mode: 'workspace-write' });
    assert(ww('git status').action === 'allow', 'ww allows read');
    assert(ww('npm install').action === 'allow', 'ww allows npm install (workspace-relative)');
    assert(ww('echo x > ./dist/a.txt').action === 'allow', 'ww allows workspace redirect');
    assert(ww(`echo x > "${WS}\\src\\a.txt"`).action === 'allow', 'ww allows absolute workspace path');
    const outside = ww('echo x > "C:\\Windows\\Temp\\a.txt"');
    assert(outside.action === 'ask', `ww asks for outside write (got ${outside.action})`);
    assert(/C:\\Windows/i.test(outside.detail || ''), 'outside detail names the path');
    assert(ww('curl https://example.com').action === 'allow', 'ww allows network');
    assert(
      ww('cp a.txt "C:\\Users\\u\\.ssh\\authorized_keys"').action === 'ask',
      'ww asks for copy outside workspace'
    );
    // Windows 开关（/E、/Y）不是 POSIX 绝对路径：以前 `robocopy src dist /E` 会被解析成 `C:\E`
    assert(ww('robocopy src dist /E').action === 'allow', 'ww does not treat /E as a path');
    assert(ww('copy a.txt b.txt /Y').action === 'allow', 'ww does not treat /Y as a path');
  }

  // 5) danger-full-access：放行（高危仍然 deny）
  {
    const d = (cmd) => decideShellCommand(cmd, { ...base, mode: 'danger-full-access' });
    assert(d('echo x > "C:\\Windows\\Temp\\a.txt"').action === 'allow', 'danger allows outside write');
    assert(d('shutdown /s').action === 'deny', 'danger still denies shutdown');
  }

  // 6) 路径抽取：只认绝对/带分隔符的片段
  {
    const toks = extractPathTokens('copy a.txt "C:\\x\\y.txt" ./z/w.txt && ls');
    assert(toks.some((t) => /^C:\\x\\y\.txt$/.test(t)), `finds absolute path, got ${toks.join('|')}`);
    assert(toks.some((t) => t.includes('./z/w.txt')), 'finds relative path with separator');
    assert(!toks.includes('ls'), 'bare words ignored');
  }

  // 7) fs 写决策：内部目录恒放行；工作区内放行；越界要问；read-only 一律问
  {
    const w = (p, mode = 'workspace-write') => decideFsWrite(p, { ...base, mode });
    assert(w(`${WS}\\src\\a.js`).action === 'allow', 'workspace write allowed');
    assert(w(`${INTERNAL[0]}\\db.sqlite`).action === 'allow', 'internal write allowed');
    assert(w('C:\\Users\\u\\Desktop\\a.txt').action === 'ask', 'desktop write asks');
    assert(w(`${WS}\\a.js`, 'read-only').action === 'ask', 'read-only asks even inside workspace');
    assert(w('C:\\Users\\u\\Desktop\\a.txt', 'danger-full-access').action === 'allow', 'danger allows');
    // 边界：前缀相同但不同目录不算在内
    assert(w('C:\\work\\proj2\\a.js').action === 'ask', 'sibling dir with same prefix is outside');
  }

  // 8) 拒绝话术必须阻止模型重试
  {
    const denied = sandboxErrorFor({ mode: 'workspace-write', reason: 'x', detail: 'C:\\Windows\\a.txt' });
    assert(denied.ok === false && denied.errorCode === 'SANDBOX_DENIED', 'denied code');
    assert(/不要重试/.test(denied.error), 'denial tells the model not to retry');
    assert(denied.retryable === false, 'sandbox denial is not retryable');
    const declined = sandboxErrorFor({ mode: 'read-only', reason: 'y' }, { declined: true });
    assert(declined.errorCode === 'SANDBOX_DECLINED', 'declined code');
    assert(/不要重试/.test(declined.error), 'decline tells the model not to retry');
    // 三种「没执行」要能分开：用户拒绝 / 没人可问 / 问了没回
    const noChannel = sandboxErrorFor({ mode: 'read-only' }, { noChannel: true });
    assert(noChannel.errorCode === 'SANDBOX_NO_CHANNEL', 'no-channel has its own code');
    assert(/确认通道/.test(noChannel.error), 'no-channel message says nobody could answer');
    const expired = sandboxErrorFor({ mode: 'read-only' }, { expired: true });
    assert(expired.errorCode === 'SANDBOX_APPROVAL_TIMEOUT', 'timeout has its own code');
  }

  // 9) ask-once：同意一次后同类直接放行；不同类别/不同会话仍要问
  {
    let asked = 0;
    const approvals = createSandboxApprovals({
      request: async () => {
        asked += 1;
        return true;
      },
      log: () => {}
    });
    const decision = { action: 'ask', category: 'write', mode: 'workspace-write', reason: 'r' };
    const first = await approvals.ask(decision, { sessionId: 's1' });
    assert(first.granted === true && first.remembered === false, 'first ask granted');
    const second = await approvals.ask(decision, { sessionId: 's1' });
    assert(second.granted === true && second.remembered === true, 'second ask reused grant');
    assert(asked === 1, `only one prompt, got ${asked}`);
    await approvals.ask({ ...decision, category: 'network' }, { sessionId: 's1' });
    assert(asked === 2, 'different category asks again');
    await approvals.ask(decision, { sessionId: 's2' });
    assert(asked === 3, 'different session asks again');
    assert(approvals.snapshot().length === 3, 'three grants recorded');
    approvals.clearSession('s1');
    assert(approvals.snapshot().length === 1, 'clearSession drops s1 grants');
  }

  // 10) fail-closed：没人可问 / 用户拒绝 / 超时，都不放行
  {
    const noChannel = createSandboxApprovals({ log: () => {} });
    const r1 = await noChannel.ask({ action: 'ask', category: 'write', mode: 'read-only' }, { sessionId: 's' });
    assert(r1.granted === false, 'no channel => declined');

    const denied = createSandboxApprovals({ request: async () => false, log: () => {} });
    const r2 = await denied.ask({ action: 'ask', category: 'write', mode: 'read-only' }, { sessionId: 's' });
    assert(r2.granted === false, 'user decline => not granted');
    assert(denied.grantedFor('s', 'write') === false, 'decline is not remembered as a grant');

    const slow = createSandboxApprovals({
      request: () => new Promise((r) => setTimeout(() => r(true), 500)),
      timeoutMs: 40,
      log: () => {}
    });
    const r3 = await slow.ask({ action: 'ask', category: 'write', mode: 'read-only' }, { sessionId: 's' });
    assert(r3.granted === false, 'timeout => declined (fail-closed)');
  }

  // 11) 批准有过期时间
  {
    let t = 1000;
    const approvals = createSandboxApprovals({ now: () => t, grantTtlMs: 100, log: () => {}, request: async () => true });
    approvals.grant('s', 'write');
    assert(approvals.grantedFor('s', 'write') === true, 'fresh grant valid');
    t += 200;
    assert(approvals.grantedFor('s', 'write') === false, 'expired grant invalid');
  }

  // 12) 批准粒度是「会话 × 类别 × 目录」：批准 /tmp 不等于批准主目录
  {
    let asked = 0;
    const approvals = createSandboxApprovals({
      request: async () => {
        asked += 1;
        return true;
      },
      log: () => {}
    });
    const decision = { action: 'ask', category: 'write', mode: 'read-only', reason: 'r' };
    const tmpFile = 'C:\\Users\\u\\AppData\\Local\\Temp\\out.txt';
    const homeFile = 'C:\\Users\\u\\secret.txt';
    await approvals.ask(decision, { sessionId: 's', path: tmpFile });
    assert(asked === 1, 'first write in temp asked');
    await approvals.ask(decision, { sessionId: 's', path: 'C:\\Users\\u\\AppData\\Local\\Temp\\out2.txt' });
    assert(asked === 1, 'same directory reused, no second prompt');
    await approvals.ask(decision, { sessionId: 's', path: homeFile });
    assert(asked === 2, 'a different directory asks again (approval scope stays explainable)');
    const roots = approvals.grantedPathsFor('s');
    assert(!roots.includes('C:\\'), 'never grants the whole volume');

    // 顶层文件（D:\x.txt）的父目录是卷根：退化成"只批这一个文件"，不能变成批整盘
    const approvals2 = createSandboxApprovals({ request: async () => true, log: () => {} });
    approvals2.rememberPath('s', 'D:\\x.txt');
    assert(
      JSON.stringify(approvals2.grantedPathsFor('s')) === JSON.stringify(['D:\\x.txt']),
      `top-level file grant stays exact, got ${JSON.stringify(approvals2.grantedPathsFor('s'))}`
    );

    // 会话 id 归一：''/空白/undefined 落在同一个桶里，clearSession 才清得掉
    const approvals3 = createSandboxApprovals({ request: async () => true, log: () => {} });
    await approvals3.ask(decision, { sessionId: '', path: tmpFile });
    assert(approvals3.snapshot().every((g) => g.sessionId === '-'), 'missing session id normalizes to -');
    approvals3.clearSession('');
    assert(approvals3.snapshot().length === 0, 'clearSession("") clears the normalized bucket');
    assert(approvals3.grantedPathsFor('').length === 0, 'path grants cleared too');
  }

  console.log('ok sandbox-policy tests');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

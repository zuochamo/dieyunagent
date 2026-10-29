'use strict';
/**
 * 连接参数装配的唯一入口：别名解析 + 凭据优先级 + 认证方式落定。
 * 手动连接与自动重连都走这里，所以优先级错了会同时影响两条路。
 */
const assert = require('node:assert/strict');

const { parseSshConfigText } = require('../../src/ssh/ssh-config');
const { resolveConnectPayload, resolveReconnectPayload } = require('../../src/ssh/connect-payload');

const CFG = [
  'Host prod',
  '  HostName 10.0.0.5',
  '  User deploy',
  '  Port 2200',
  '  IdentityFile ~/.ssh/id_prod',
  '  ProxyJump bastion',
  '',
  'Host bastion',
  '  HostName bastion.example.com',
  '  User jump',
  '  Port 2222',
  '  IdentityFile ~/.ssh/id_jump',
  '',
  'Host legacy',
  '  ProxyCommand nc %h %p'
].join('\n');

const blocks = parseSshConfigText(CFG);

function makeCredStore(rows = {}) {
  return {
    loadConnectSecrets(host) {
      return rows[host] || null;
    }
  };
}

describe('resolveConnectPayload：别名与优先级', () => {
  it('Host 别名解析出地址 / 用户 / 端口 / 私钥', () => {
    const p = resolveConnectPayload(
      { host: 'prod' },
      { sshConfigBlocks: blocks, agentSocket: '' }
    );
    assert.equal(p.host, 'prod', '别名仍是身份（池键、UI 显示都用它）');
    assert.equal(p.hostname, '10.0.0.5');
    assert.equal(p.username, 'deploy');
    assert.equal(p.port, 2200);
    assert.equal(p.authType, 'key');
    assert.ok(p.privateKeyPath.endsWith('id_prod'), p.privateKeyPath);
    assert.equal(p.config.matched, true);
  });

  it('显式端口/用户名压过 config', () => {
    const p = resolveConnectPayload(
      { host: 'prod', port: 2022, username: 'root' },
      { sshConfigBlocks: blocks, agentSocket: '' }
    );
    assert.equal(p.port, 2022);
    assert.equal(p.username, 'root');
  });

  it('UI 默认的 22 不算「显式选择」，config 的 Port 仍然生效', () => {
    const p = resolveConnectPayload({ host: 'prod', port: 22 }, { sshConfigBlocks: blocks, agentSocket: '' });
    assert.equal(p.port, 2200);
  });

  it('非别名主机原样使用（含默认端口 22）', () => {
    const p = resolveConnectPayload(
      { host: '192.168.1.10', port: 22, username: 'me', password: 'pw' },
      { sshConfigBlocks: blocks, agentSocket: '' }
    );
    assert.equal(p.hostname, '192.168.1.10');
    assert.equal(p.port, 22);
    assert.equal(p.username, 'me');
    assert.equal(p.config.matched, false);
    assert.equal(p.authType, 'password');
  });

  it('用户名缺失且 config 也没给 → 明确报错', () => {
    assert.throws(
      () => resolveConnectPayload({ host: '10.0.0.9' }, { sshConfigBlocks: [], agentSocket: '' }),
      (e) => e.code === 'INVALID_SSH' && /用户名/.test(e.message)
    );
  });

  it('ProxyCommand 不假装支持，给出可读警告', () => {
    const p = resolveConnectPayload(
      { host: 'legacy', username: 'me', password: 'pw' },
      { sshConfigBlocks: blocks, agentSocket: '' }
    );
    assert.equal(p.jumps.length, 0);
    assert.ok(p.warnings.some((w) => /ProxyCommand/.test(w)), JSON.stringify(p.warnings));
  });
});

describe('resolveConnectPayload：认证方式', () => {
  it('agent 优先于 config 私钥（`ssh alias` 的行为）', () => {
    const p = resolveConnectPayload({ host: 'prod' }, { sshConfigBlocks: blocks, agentSocket: '/tmp/agent' });
    assert.equal(p.authType, 'agent');
    assert.equal(p.agentSocket, '/tmp/agent');
    assert.deepEqual(p.methods, ['agent', 'key'], 'agent 失败后还能退回 config 私钥');
  });

  it('config 有 IdentityFile 时用私钥', () => {
    const p = resolveConnectPayload({ host: 'prod' }, { sshConfigBlocks: blocks, agentSocket: '' });
    assert.equal(p.authType, 'key');
  });

  it('什么都没有时抛 SSH_NO_AUTH_METHOD，并说清三条出路', () => {
    assert.throws(
      () => resolveConnectPayload({ host: 'h', username: 'u' }, { sshConfigBlocks: [], agentSocket: '' }),
      (e) => {
        assert.equal(e.code, 'SSH_NO_AUTH_METHOD');
        assert.ok(/ssh-agent/.test(e.message));
        assert.ok(/IdentityFile/.test(e.message));
        assert.ok(/密码/.test(e.message));
        return true;
      }
    );
  });

  it('显式 authType=agent 但没有 agent → 交给连接层报 SSH_AGENT_UNAVAILABLE', () => {
    const p = resolveConnectPayload(
      { host: 'h', username: 'u', authType: 'agent' },
      { sshConfigBlocks: [], agentSocket: '' }
    );
    assert.equal(p.authType, 'agent');
    assert.equal(p.agentSocket, '');
  });

  it('显式 authType=key 但没给私钥 → 立刻报错（别等连到远端才失败）', () => {
    assert.throws(
      () => resolveConnectPayload({ host: 'h', username: 'u', authType: 'key' }, { sshConfigBlocks: [], agentSocket: '' }),
      (e) => e.code === 'INVALID_SSH'
    );
  });

  it('agent 认证不携带任何秘密（不写进凭据库）', () => {
    const p = resolveConnectPayload({ host: 'prod', remember: true }, { sshConfigBlocks: blocks, agentSocket: '/tmp/a' });
    assert.equal(p.password, '');
    assert.equal(p.passphrase, '');
    assert.equal(p.methods[0], 'agent');
  });
});

describe('resolveConnectPayload：凭据优先级', () => {
  const store = makeCredStore({ prod: { authType: 'password', password: 'saved' } });

  it('已存密码在没给显式密码时进入候选链（config 私钥优先，密码兜底）', () => {
    const p = resolveConnectPayload({ host: 'prod', remember: true }, { credentialsStore: store, sshConfigBlocks: blocks, agentSocket: '' });
    assert.deepEqual(p.methods, ['key', 'password']);
    assert.equal(p.authType, 'key', 'authType 只是「先用哪种」的标签');
    assert.equal(p.password, 'saved');
  });

  it('没有 SSH_AUTH_SOCK 时 auto 落到密码', () => {
    const p = resolveConnectPayload({ host: 'h', username: 'u', password: 'typed' }, { sshConfigBlocks: [], agentSocket: '' });
    assert.equal(p.authType, 'password');
    assert.equal(p.password, 'typed');
  });

  it('别的表里存的密码不会被拿来用（凭据按主机查）', () => {
    assert.throws(
      () =>
        resolveConnectPayload(
          { host: 'other', username: 'u' },
          { credentialsStore: store, sshConfigBlocks: [], agentSocket: '' }
        ),
      (e) => e.code === 'SSH_NO_AUTH_METHOD'
    );
  });

  it('用户亲手填的密码优先（不让 agent 先消耗 MaxAuthTries）', () => {
    const p = resolveConnectPayload(
      { host: 'prod', password: 'typed' },
      { sshConfigBlocks: blocks, agentSocket: '/tmp/agent' }
    );
    assert.deepEqual(p.methods, ['password']);
    assert.equal(p.password, 'typed');
  });

  it('useSaved=true 时即使没勾「记住」也复用已存秘密（勾选只控制保存）', () => {
    const p = resolveConnectPayload({ host: 'prod', useSaved: true }, { credentialsStore: store, sshConfigBlocks: blocks, agentSocket: '' });
    assert.equal(p.password, 'saved');
  });
});

describe('resolveConnectPayload：跳板', () => {
  it('ProxyJump 解析成跳板链，跳板自己的地址/用户/私钥按 config 解析', () => {
    const p = resolveConnectPayload({ host: 'prod' }, { sshConfigBlocks: blocks, agentSocket: '/tmp/a' });
    assert.equal(p.jumps.length, 1);
    const hop = p.jumps[0];
    assert.equal(hop.host, 'bastion');
    assert.equal(hop.hostname, 'bastion.example.com');
    assert.equal(hop.username, 'jump');
    assert.equal(hop.port, 2222);
    assert.ok(hop.identityFiles[0].endsWith('id_jump'));
  });

  it('调用方显式给的 proxyJump 压过 config', () => {
    const p = resolveConnectPayload(
      { host: 'prod', proxyJump: 'j9' },
      { sshConfigBlocks: blocks, agentSocket: '/tmp/a' }
    );
    assert.equal(p.jumps[0].host, 'j9');
    assert.equal(p.jumps[0].port, 22);
  });
});

describe('resolveReconnectPayload', () => {
  it('自动重连与手动连接同源：同样的别名解析', () => {
    const p = resolveReconnectPayload(
      { host: 'prod', port: 2200, username: 'deploy' },
      { sshConfigBlocks: blocks, agentSocket: '/tmp/a' }
    );
    assert.equal(p.hostname, '10.0.0.5');
    assert.equal(p.username, 'deploy');
    assert.equal(p.authType, 'agent');
    assert.equal(p.jumps.length, 1);
  });

  it('没有任何认证材料时抛错（调用方转成「需手动重连」）', () => {
    assert.throws(
      () => resolveReconnectPayload({ host: 'h', port: 22, username: 'u' }, { sshConfigBlocks: [], agentSocket: '' }),
      (e) => e.code === 'SSH_NO_AUTH_METHOD'
    );
  });
});

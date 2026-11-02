'use strict';
/**
 * `ssh` 工具与设置页共用的动作层（src/ssh/actions.js）。
 *
 * 这里守两件事：
 * 1) 连接走 `connect-payload` 的唯一解析入口，并且「记住登录信息」失败不许把连接判成失败；
 * 2) 工具侧的 `listTargets` 只给别名与连接态 —— 通配符条目（`Host *`）不是可用别名。
 */
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

const { createSshActions } = require('../../src/ssh/actions');
const { loadSshConfig } = require('../../src/ssh/ssh-config');

/** 写一份临时 ssh_config，返回其路径（避免依赖开发机真实的 ~/.ssh/config） */
function writeTempSshConfig(text) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dieyun-ssh-actions-'));
  const file = path.join(dir, 'config');
  fs.writeFileSync(file, text, 'utf8');
  return file;
}

function makeActions({ manager, credentialsStore, blocks } = {}) {
  return createSshActions({
    getSshSessionManager: () => manager || null,
    getSshCredentialsStore: () => credentialsStore || null,
    getSshConfigBlocks: () => blocks || [],
    getLocalGateway: () => null,
    getPortForwardManager: () => null,
    resolveSshConnectSessionStatus: (p, result) => ({ connected: result && result.ok !== false }),
    log: { info() {}, warn() {} }
  });
}

describe('ssh actions', () => {
  it('connect 走 connect-payload 解析，并在 saveProfile 抛错时仍然成功', async () => {
    const seen = [];
    const actions = makeActions({
      manager: {
        connect: async (p) => {
          seen.push(p);
          return { ok: true };
        }
      },
      credentialsStore: {
        saveProfile: () => {
          throw new Error('safeStorage 不可用');
        },
        clearProfile: () => {},
        getProfile: () => null
      }
    });
    const r = await actions.connect({ host: 'example.internal', username: 'root', remember: true, password: 'x' });
    assert.equal(r.ok, true);
    assert.equal(r.connected, true);
    assert.match(r.credentialsWarning, /safeStorage/);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].host, 'example.internal');
    assert.equal(seen[0].username, 'root');
  });

  it('connect 把主机指纹问题原样交给调用方，不自己吞掉', async () => {
    const actions = makeActions({
      manager: {
        connect: async () => {
          const err = new Error('unknown host key');
          err.code = 'SSH_HOST_KEY_UNKNOWN';
          err.fingerprint = 'SHA256:abc';
          throw err;
        }
      }
    });
    const r = await actions.connect({ host: '10.0.0.9', username: 'root', authType: 'password', password: 'x' });
    assert.equal(r.ok, false);
    assert.equal(r.needHostKeyTrust, true);
    assert.equal(r.fingerprint, 'SHA256:abc');
    assert.equal(r.username, 'root');
  });

  it('listTargets 跳过通配符条目，只列真正能连的别名', () => {
    const file = writeTempSshConfig(
      ['Host *', '  ServerAliveInterval 30', 'Host build-box', '  HostName 10.0.0.5', '  User ci', '  Port 2222'].join('\n')
    );
    const blocks = loadSshConfig({ configPath: file, home: os.tmpdir() });
    const actions = makeActions({ blocks });
    const out = actions.listTargets();
    assert.equal(out.configAliases.length, 1);
    assert.equal(out.configAliases[0].alias, 'build-box');
    assert.equal(out.configAliases[0].hostName, '10.0.0.5');
    assert.equal(out.configAliases[0].user, 'ci');
    assert.equal(out.configAliases[0].port, 2222);
    assert.equal(out.connected, false);
  });

  it('没有别名时给出可执行的下一步，而不是空列表', () => {
    const actions = makeActions({ blocks: [] });
    const out = actions.listTargets();
    assert.equal(out.configAliases.length, 0);
    assert.match(out.note, /host\/username/);
  });

  it('disconnect 在没有池对象时退回单条连接断开', async () => {
    let disconnected = 0;
    const actions = makeActions({
      manager: {
        status: () => ({ connected: true, host: '10.0.0.5', username: 'ci' }),
        disconnect: async () => {
          disconnected += 1;
        }
      }
    });
    const r = await actions.disconnect({});
    assert.equal(r.ok, true);
    assert.equal(disconnected, 1);
    assert.equal(actions.status().connected, true);
  });
});

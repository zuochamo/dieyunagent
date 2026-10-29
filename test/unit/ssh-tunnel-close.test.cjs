'use strict';

/**
 * 关隧道必须**真的关掉**，不能挂住。
 *
 * `net.Server.close()` 只停止接受新连接：已建立的连接不销毁就不会回调。
 * 预览页的浏览器保持 keep-alive，`closeSshTunnel()` 的 promise 于是永远不 resolve ——
 * 调用方（`port-forward-manager` → `workspace-remote-runtime`）卡在那里，端口也一直占着。
 */
const assert = require('node:assert/strict');
const net = require('node:net');

const { createSshTunnel, closeSshTunnel } = require('../../src/ssh/tunnel');

function fakeSshClient() {
  const listeners = new Map();
  return {
    on(ev, fn) {
      if (!listeners.has(ev)) listeners.set(ev, new Set());
      listeners.get(ev).add(fn);
      return this;
    },
    removeListener(ev, fn) {
      listeners.get(ev)?.delete(fn);
      return this;
    },
    forwardOut(_h, _p, _remoteHost, _remotePort, cb) {
      // 一个能读能写、能关的假通道
      const { PassThrough } = require('node:stream');
      cb(null, new PassThrough());
    }
  };
}

function connectLocal(port) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1', () => resolve(sock));
    sock.on('error', reject);
  });
}

describe('closeSshTunnel', () => {
  it('有活着的本地连接时也能立刻返回，并把连接掐断', async () => {
    const server = await createSshTunnel(fakeSshClient(), {
      localPort: 0,
      remotePort: 1234,
      remoteHost: '127.0.0.1'
    });
    const port = server.address().port;
    const sock = await connectLocal(port);
    sock.write('ping'); // 让隧道进入「有活连接」状态

    const startedAt = Date.now();
    await closeSshTunnel(server);
    const elapsed = Date.now() - startedAt;

    assert.ok(elapsed < 2000, `close 不许被活连接挂住（实测 ${elapsed}ms）`);
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(sock.destroyed, true, '隧道关了，本地连接必须被销毁');
    sock.destroy();
  });

  it('端口确实被释放（能再绑一次）', async () => {
    const server = await createSshTunnel(fakeSshClient(), {
      localPort: 0,
      remotePort: 1234,
      remoteHost: '127.0.0.1'
    });
    const port = server.address().port;
    await closeSshTunnel(server);
    const probe = net.createServer();
    await new Promise((resolve, reject) => {
      probe.once('error', reject);
      probe.listen(port, '127.0.0.1', resolve);
    });
    await new Promise((r) => probe.close(r));
  });

  it('没有连接时照常关闭；传 null 不报错', async () => {
    const server = await createSshTunnel(fakeSshClient(), {
      localPort: 0,
      remotePort: 1234,
      remoteHost: '127.0.0.1'
    });
    await closeSshTunnel(server);
    await closeSshTunnel(null);
  });

  it('重复关闭是幂等的', async () => {
    const server = await createSshTunnel(fakeSshClient(), {
      localPort: 0,
      remotePort: 1234,
      remoteHost: '127.0.0.1'
    });
    await closeSshTunnel(server);
    await closeSshTunnel(server);
  });
});

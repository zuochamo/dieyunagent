'use strict';
/**
 * 跳板链：第一跳直连，后面每一跳都用上一跳的 forwardOut 通道；
 * 任一跳失败必须把已建立的连接全部拆掉（否则泄漏活着的 SSH）。
 */
const assert = require('node:assert/strict');

const { createJumpChain, forwardSocket } = require('../../src/ssh/proxy-jump');

function makeClient(name, opts = {}) {
  return {
    name,
    ended: false,
    destroyed: false,
    forwarded: [],
    forwardOut(localHost, localPort, host, port, cb) {
      if (opts.failForward) {
        cb(new Error('forward denied'));
        return;
      }
      this.forwarded.push({ host, port });
      cb(null, { tag: `${name}->${host}:${port}`, closed: false, close() { this.closed = true; } });
    },
    on() {},
    removeAllListeners() {},
    end() {
      this.ended = true;
    },
    destroy() {
      this.destroyed = true;
    }
  };
}

describe('forwardSocket', () => {
  it('把 forwardOut 的通道包成 Promise', async () => {
    const c = makeClient('a');
    const sock = await forwardSocket(c, 'nexthop', 22);
    assert.equal(sock.tag, 'a->nexthop:22');
    assert.deepEqual(c.forwarded, [{ host: 'nexthop', port: 22 }]);
  });

  it('通道打不开时给出带跳板信息的错误码', async () => {
    const c = makeClient('a', { failForward: true });
    await assert.rejects(() => forwardSocket(c, 'nexthop', 22), (e) => {
      assert.equal(e.code, 'SSH_JUMP_FORWARD_FAILED');
      assert.equal(e.jumpHost, 'nexthop');
      return true;
    });
  });
});

describe('createJumpChain', () => {
  const hops = [
    { host: 'jump1', hostname: 'jump1', port: 22, username: 'u1' },
    { host: 'jump2', hostname: 'jump2', port: 2222, username: 'u2' }
  ];

  it('逐跳串起来：第一跳 sock=null，其余用上一跳的通道', async () => {
    const clients = [];
    const seen = [];
    const chain = await createJumpChain({
      hops,
      connectHop: async (hop, sock) => {
        seen.push({ hop: hop.host, sockTag: sock && sock.tag });
        const c = makeClient(hop.host);
        clients.push(c);
        return c;
      }
    });
    assert.deepEqual(seen, [
      { hop: 'jump1', sockTag: null },
      { hop: 'jump2', sockTag: 'jump1->jump2:2222' }
    ]);
    assert.equal(chain.lastClient.name, 'jump2');
    assert.deepEqual(chain.hopClients.map((c) => c.name), ['jump1', 'jump2']);
  });

  it('dispose 逆序拆掉所有跳', async () => {
    const order = [];
    const chain = await createJumpChain({
      hops,
      connectHop: async (hop) => {
        const c = makeClient(hop.host);
        c.end = () => order.push(hop.host);
        return c;
      }
    });
    chain.dispose();
    assert.deepEqual(order, ['jump2', 'jump1']);
  });

  it('中途一跳连不上时，已建立的上一跳被拆掉且错误继续上抛', async () => {
    let firstClient = null;
    await assert.rejects(
      () =>
        createJumpChain({
          hops,
          connectHop: async (hop, sock) => {
            if (hop.host === 'jump2') throw new Error('认证失败');
            firstClient = makeClient(hop.host);
            return firstClient;
          }
        }),
      /认证失败/
    );
    assert.equal(firstClient.ended, true, '上一跳必须被 end()');
  });

  it('没有跳板时返回空链（调用方据此走直连）', async () => {
    const chain = await createJumpChain({ hops: [], connectHop: async () => null });
    assert.equal(chain.lastClient, null);
    chain.dispose(); // 不应抛错
  });
});

'use strict';

/**
 * 跳板链的失败清理：**每一条**失败路径都要把这一轮已建立的连接拆掉。
 *
 * 历史洞：`forwardSocket`（给自己的下一跳开通道）原来写在 try 外面，它抛错时
 * `catch` 根本没进，`dispose()` 不被调用 —— 上一跳那条**已认证**的 SSH 连接带着
 * keepalive 一直活着，用户再点一次连接就再多一条。
 */
const assert = require('node:assert/strict');

const { createJumpChain } = require('../../src/ssh/proxy-jump');

function fakeClient(name, { forwardOk = true } = {}) {
  const rec = {
    name,
    ended: false,
    destroyed: false,
    listeners: new Set(),
    on(ev) {
      rec.listeners.add(ev);
      return rec;
    },
    removeAllListeners() {
      rec.listeners.clear();
    },
    end() {
      rec.ended = true;
    },
    destroy() {
      rec.destroyed = true;
    },
    forwardOut(_h, _p, host, port, cb) {
      rec.forwardedTo = `${host}:${port}`;
      if (!forwardOk) {
        cb(new Error('channel open failure: connect failed'));
        return;
      }
      cb(null, { close() {}, on() {}, destroy() {} });
    }
  };
  return rec;
}

const HOP1 = { host: 'bastion1', port: 22, username: 'u1' };
const HOP2 = { host: 'bastion2', port: 22, username: 'u2' };

describe('createJumpChain 的失败清理', () => {
  it('第二跳的 forward 打不开时，第一跳连接必须被拆掉', async () => {
    const first = fakeClient('hop1', { forwardOk: false });
    const chain = createJumpChain({
      hops: [HOP1, HOP2],
      connectHop: async (hop) => {
        if (hop.host === HOP1.host) return first;
        throw new Error('不该走到这里：forward 失败就该中断');
      }
    });
    await assert.rejects(() => chain, (e) => {
      assert.equal(e.code, 'SSH_JUMP_FORWARD_FAILED');
      return true;
    });
    assert.equal(first.ended || first.destroyed, true, '上一跳在 forward 失败时必须被关掉');
  });

  it('某一跳连不上时，前面所有跳都要拆掉', async () => {
    const first = fakeClient('hop1');
    await assert.rejects(
      () =>
        createJumpChain({
          hops: [HOP1, HOP2],
          connectHop: async (hop) => {
            if (hop.host === HOP1.host) return first;
            throw new Error('auth failed');
          }
        }),
      /auth failed/
    );
    assert.equal(first.ended || first.destroyed, true);
  });

  it('第一跳的 forward 失败时没有上一跳可拆，但错误要清楚', async () => {
    // 第一跳没有 prev，不会 forward；这里验的是「没有 hop 时不做多余动作」
    const chain = await createJumpChain({ hops: [], connectHop: async () => null });
    assert.equal(chain.lastClient, null);
    chain.dispose();
  });

  it('dispose 幂等，且按逆序拆', async () => {
    const order = [];
    const mk = (name) => ({
      end() {
        order.push(name);
      },
      on() {},
      removeAllListeners() {},
      forwardOut(_h, _p, _host, _port, cb) {
        cb(null, { close() {}, on() {}, destroy() {} });
      }
    });
    const chain = await createJumpChain({
      hops: [HOP1, HOP2],
      connectHop: async (hop) => mk(hop.host)
    });
    chain.dispose();
    chain.dispose();
    assert.deepEqual(order, [HOP2.host, HOP1.host]);
  });
});

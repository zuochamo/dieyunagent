'use strict';
/**
 * 「远端 Agent 可用性」与「远端 Agent 身份 key」的单一来源。
 *
 * 背景：P2 把传输从「远端 TCP 端口 + 本地隧道 + token」换成「SSH direct-streamlocal 到远端
 * Unix socket」之后，`getInfo()` 不再有 `url` / `token`。而 6 处调用点当时还在用
 * `info.url` 判断「远端 Agent 在不在」→ 判据恒假，远端 grep / glob / LSP / 增量索引通知
 * 全部**静默**退化成本地路径（看起来成功，结果不对）。
 *
 * 这里锁死两件事：
 *  1. 可用性判据只有 `isRemoteAgentUsable()` 一份，**只认 P2 的通道形态**（`openChannel`）；
 *  2. 身份 key 只有 `remoteAgentInfoKey()` 一份，必须带 workspace
 *     （少了它，两个工作区会共用同一个索引缓存条目）。
 *
 * 旧 TCP 形态（`url` + `token`）在 P4 一并删掉了：daemon 不再监听端口、不再发 token，
 * 客户端也不再认这两个字段 —— 留着「两种形态」等于留着一条没人走的路。
 */
const assert = require('node:assert/strict');

const { isRemoteAgentUsable, remoteAgentClientKey } = require('../../src/gateway/remote-agent-client');
const {
  remoteAgentInfoKey,
  remoteIndexCacheKey
} = require('../../src/workspace/workspace-cache-keys');
const { notifyRemoteIndexChange } = require('../../src/gateway/handlers/fs');

const SOCKET_INFO = {
  key: '/home/u/.dieyun/remote-agent/run/agent.sock#/srv/projA',
  socketPath: '/home/u/.dieyun/remote-agent/run/agent.sock',
  openChannel: () => Promise.resolve(null),
  workspaceRoot: '/srv/projA'
};
/** 已删除的旧形态：url + token。留着这两个字段的 info 不能算「可用」。 */
const LEGACY_INFO = { url: 'ws://127.0.0.1:41001', token: 'abc123' };

describe('isRemoteAgentUsable（唯一判据）', () => {
  it('socket 形态（P2）算可用', () => {
    assert.equal(isRemoteAgentUsable(SOCKET_INFO), true);
  });

  it('已删除的 TCP 形态（url + token）不再算可用', () => {
    assert.equal(isRemoteAgentUsable(LEGACY_INFO), false);
  });

  it('半截形态一律不可用', () => {
    assert.equal(isRemoteAgentUsable(null), false);
    assert.equal(isRemoteAgentUsable(undefined), false);
    assert.equal(isRemoteAgentUsable({}), false);
    assert.equal(isRemoteAgentUsable({ socketPath: '/tmp/x.sock' }), false, '只有路径没有通道 = 连不上');
    assert.equal(isRemoteAgentUsable({ openChannel: 'not-a-function' }), false);
  });

  it('P2 形态下 getRemoteAgentClient 不再抛「隧道未就绪」', () => {
    const { getRemoteAgentClient } = require('../../src/gateway/remote-agent-client');
    assert.throws(() => getRemoteAgentClient({ socketPath: '/tmp/x.sock' }), /未就绪/);
  });
});

describe('remoteAgentInfoKey（唯一 key）', () => {
  it('带 workspace，且不同 workspace 不同 key', () => {
    const a = { ...SOCKET_INFO, key: 'sock#/srv/a' };
    const b = { ...SOCKET_INFO, key: 'sock#/srv/b' };
    assert.equal(remoteAgentInfoKey(a), 'sock#/srv/a');
    assert.notEqual(remoteAgentInfoKey(a), remoteAgentInfoKey(b));
  });

  it('不是远端 Agent → 空串（调用方据此跳过缓存）', () => {
    assert.equal(remoteAgentInfoKey(null), '');
    assert.equal(remoteAgentInfoKey({}), '');
    assert.equal(remoteAgentInfoKey({ socketPath: '/tmp/x.sock' }), '');
    assert.equal(remoteAgentInfoKey(LEGACY_INFO), '', 'url/token 形态已删除，不许再产出 key');
  });

  it('client 的缓存 key 与索引缓存 key 同源', () => {
    assert.equal(remoteAgentClientKey(SOCKET_INFO), remoteAgentInfoKey(SOCKET_INFO));
  });

  it('索引缓存 key = 身份 key + 规范化工作区，且能按身份前缀整体失效', () => {
    const keyA = remoteIndexCacheKey(SOCKET_INFO, '/srv/projA/');
    const keyB = remoteIndexCacheKey({ ...SOCKET_INFO, key: 'sock#/srv/projB' }, '/srv/projB');
    assert.notEqual(keyA, '', 'P2 形态下索引缓存 key 不许为空（否则所有远端工作区共用一个条目）');
    assert.notEqual(keyA, keyB);
    // resetRemoteIndexCoreCache 按 `${base}:` 前缀删除，格式必须是 base:path
    assert.equal(keyA.startsWith(`${remoteAgentInfoKey(SOCKET_INFO)}:`), true);
  });
});

describe('notifyRemoteIndexChange（P2 之后必须真的发出去）', () => {
  function spy() {
    const calls = [];
    return {
      calls,
      getRemoteAgentInfo: () => SOCKET_INFO,
      // 用真实现会把 client 连起来；这里只验「有没有被调用、参数对不对」
      getRemoteAgentClient: (info) => ({
        call: async (method, params) => {
          calls.push({ info: info.key, method, params });
          return { ok: true };
        }
      })
    };
  }

  it('socket 形态下会调用 index.notify_change', async () => {
    const d = spy();
    notifyRemoteIndexChange(d, { filePath: '/srv/projA/x.js', op: 'write' });
    await new Promise((r) => setImmediate(r));
    assert.equal(d.calls.length, 1);
    assert.equal(d.calls[0].method, 'index.notify_change');
    assert.equal(d.calls[0].params.filePath, '/srv/projA/x.js');
  });

  it('没有可用 Agent 时静默跳过（不许抛，也不许乱发）', async () => {
    const calls = [];
    const d = {
      getRemoteAgentInfo: () => ({ socketPath: '/tmp/x.sock' }),
      getRemoteAgentClient: () => ({ call: async (m) => calls.push(m) })
    };
    notifyRemoteIndexChange(d, { filePath: '/srv/x.js' });
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(calls, []);
  });
});

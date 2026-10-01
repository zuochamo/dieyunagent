'use strict';

const { createTerminalPool } = require('../../src/terminal/terminal-pool');

function makeHandle() {
  const calls = [];
  return {
    calls,
    handle: {
      write: (data) => calls.push(['write', data]),
      kill: () => calls.push(['kill'])
    }
  };
}

function attachProbe(pool, sessionId, exits, chunks) {
  return pool.attach(sessionId, {
    onData: (text) => chunks.push(text),
    onExit: (code) => exits.push(code)
  });
}

describe('terminal-pool：会话消亡必须让渲染端知道', () => {
  it('kill 已挂载的会话会派发退出事件（否则 UI 显示"已连接"却静默丢输入）', () => {
    const pool = createTerminalPool();
    const { handle, calls } = makeHandle();
    const exits = [];
    pool.register('s1', handle, { kind: 'ssh', endpointKey: 'ssh:host' });
    attachProbe(pool, 's1', exits, []);

    pool.kill('s1');

    expect(exits).toEqual([null]);
    expect(pool.getEntry('s1')).toBeNull();
    expect(pool.getAttachedSessionId()).toBeNull();
    expect(calls).toContainEqual(['kill']);
  });

  it('远端连接关闭时按 endpoint 清理并上报', () => {
    const pool = createTerminalPool();
    const exits = [];
    pool.register('s1', makeHandle().handle, { kind: 'ssh', endpointKey: 'ssh:dieyunx@192.168.31.62' });
    attachProbe(pool, 's1', exits, []);
    pool.register('local', makeHandle().handle, { kind: 'local', endpointKey: 'local' });

    pool.killForRemoteEndpoint('ssh:dieyunx@192.168.31.62', 'ssh');

    expect(exits).toEqual([null]);
    expect(pool.listSessionIds()).toEqual(['local']);
  });

  it('主动摘挂后再杀（重启路径）不再冒充异常断线', () => {
    const pool = createTerminalPool();
    const exits = [];
    pool.register('s1', makeHandle().handle, { kind: 'ssh' });
    attachProbe(pool, 's1', exits, []);

    pool.detach('s1');
    pool.kill('s1');

    expect(exits).toEqual([]);
    expect(pool.getEntry('s1')).toBeNull();
  });

  it('未挂载的会话被 kill 不发退出事件（没人展示它）', () => {
    const pool = createTerminalPool();
    const exits = [];
    pool.register('s1', makeHandle().handle, { kind: 'local' });
    attachProbe(pool, 's1', exits, []);
    pool.detach('s1');

    pool.kill('s1');

    expect(exits).toEqual([]);
  });

  it('写入口只对存在的会话成立（渲染端据此提示"会话已失效"）', () => {
    const pool = createTerminalPool();
    const { handle, calls } = makeHandle();
    pool.register('s1', handle, { kind: 'local' });

    expect(pool.writeForSession('s1', 'echo hi')).toBe(true);
    expect(pool.writeForSession('missing', 'echo hi')).toBe(false);
    expect(calls).toEqual([['write', 'echo hi']]);
  });
});

'use strict';

const path = require('path');

const { createTerminalPool } = require('../../src/terminal/terminal-pool');
const { resolveTerminalLogPath } = require('../../src/agent/terminal-log');

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

  it('本地 target 缺 path 时不编路径：日志不会落到 CWD 下的相对目录', () => {
    const pool = createTerminalPool();
    const pathless = pool.workspaceMetaFromTarget({ kind: 'local' });

    expect(pathless.path).toBeUndefined();
    // 与「没有 target」同形：否则同一会话的 workspaceKey 会跳变，白白多换一次壳
    expect(pathless).toEqual(pool.workspaceMetaFromTarget(null));
    // 落点随之回到 userData，而不是 CWD 下的相对目录 local/.dieyun/terminals/
    expect(resolveTerminalLogPath(pathless.path, 'U:/ud')).toBe(
      path.join('U:/ud', 'terminals', 'integrated.log')
    );
  });

  it('本地 target 有 path 时 meta 保持原样（日志按工作区落盘）', () => {
    const pool = createTerminalPool();
    expect(pool.workspaceMetaFromTarget({ kind: 'local', path: 'C:/ws' })).toMatchObject({
      kind: 'local',
      endpointKey: 'local',
      workspaceKey: 'local:C:/ws',
      path: 'C:/ws'
    });
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

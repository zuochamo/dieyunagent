'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { LocalGateway } = require('../../src/gateway/server');
const { createTerminalPool } = require('../../src/terminal/terminal-pool');
const { registerTerminalIpc } = require('../../src/main/ipc/terminal');

/**
 * 回归点：SSH 工作区里终端开成了本机 shell。
 * 原因是终端按「网关当前活动会话的视图」取工作区，而它自己的会话绑的是 SSH（或绑定只存在
 * 于会话行里、尚未 hydrate 进网关），错位后就落到本机分支；工作区换了还会复用旧 shell。
 */

/** 只用真实 LocalGateway 的会话视图方法，不启动网关（handlers 置空，hydrate 直接返回） */
function makeGateway({ activeSessionId = null, viewTarget = null, sessions = {} } = {}) {
  const gw = Object.create(LocalGateway.prototype);
  gw.sessionWorkspaceTargets = new Map(Object.entries(sessions));
  gw.activeSessionId = activeSessionId;
  gw.workspaceTarget = viewTarget;
  gw.handlers = {};
  gw._sshConnectedForTarget = () => true;
  return gw;
}

function makeHarness(gateway) {
  const handlers = new Map();
  const shells = [];
  const pool = createTerminalPool();
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'dieyun-terminal-'));
  const sshManager = {
    openShell: async (opts) => {
      shells.push(opts);
      return { write() {}, kill() {}, shell: 'bash -l', cwd: opts.cwd, remote: true };
    }
  };
  registerTerminalIpc({
    ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) },
    getLocalGateway: () => gateway,
    getMainWindow: () => null,
    getUserDataPath: () => userData,
    getTerminalPool: () => pool,
    getSshSessionManager: () => sshManager,
    getSshConnectionPool: () => null
  });
  return {
    pool,
    shells,
    start: (payload) => handlers.get('terminal:start')({}, payload),
    write: (payload) => handlers.get('terminal:write')({}, payload)
  };
}

const SSH_A = { kind: 'ssh', host: '192.168.31.62', port: 22, username: 'dieyunx', remotePath: '/srv/a' };
const SSH_B = { kind: 'ssh', host: '192.168.31.62', port: 22, username: 'dieyunx', remotePath: '/srv/b' };
const LOCAL = { kind: 'local', path: process.cwd() };

describe('网关会话作用域的工作区视图', () => {
  it('会话已绑定时按会话取，不跟随活动会话', () => {
    const gw = makeGateway({ activeSessionId: 'other', viewTarget: LOCAL, sessions: { s1: SSH_A } });
    expect(gw.getWorkspaceTarget('s1')).toMatchObject({ kind: 'ssh', remotePath: '/srv/a' });
    expect(gw.getWorkspace('s1')).toMatchObject({ kind: 'ssh', sshConnected: true });
    expect(gw.getWorkspace('s1').ssh).toMatchObject({ host: '192.168.31.62', remotePath: '/srv/a' });
  });

  it('会话未绑定时跟随当前视图（终端不该在 SSH 视图里退回本机）', () => {
    const gw = makeGateway({ activeSessionId: null, viewTarget: SSH_A, sessions: {} });
    expect(gw.getWorkspace('s1')).toMatchObject({ kind: 'ssh' });
    expect(gw.getWorkspace()).toMatchObject({ kind: 'ssh' });
  });

  it('不传 sessionId 时行为与原来一致', () => {
    const gw = makeGateway({ activeSessionId: 's1', viewTarget: LOCAL, sessions: { s1: LOCAL } });
    expect(gw.getWorkspace()).toMatchObject({ kind: 'local', workspacePath: LOCAL.path });
  });
});

describe('terminal:start 按会话工作区决定本机 / 远程', () => {
  it('会话绑 SSH 时开远程 shell，并把远端路径交给 openShell', async () => {
    const h = makeHarness(makeGateway({ activeSessionId: 's1', viewTarget: LOCAL, sessions: { s1: SSH_A } }));
    const r = await h.start({ sessionId: 's1' });

    expect(h.shells).toHaveLength(1);
    expect(h.shells[0].cwd).toBe('/srv/a');
    expect(r).toMatchObject({ ok: true, remote: true, host: '192.168.31.62', username: 'dieyunx' });
    h.pool.killExceptSessionIds([]);
  });

  it('会话尚未绑定工作区时跟随视图：视图是 SSH 就不能开本机 shell', async () => {
    const h = makeHarness(makeGateway({ activeSessionId: null, viewTarget: SSH_A, sessions: {} }));
    const r = await h.start({ sessionId: 's1' });

    expect(r.remote).toBe(true);
    expect(h.shells[0].cwd).toBe('/srv/a');
    h.pool.killExceptSessionIds([]);
  });

  it('同一会话同一工作区重复 start 是复用，不再开新 shell', async () => {
    const h = makeHarness(makeGateway({ activeSessionId: 's1', viewTarget: SSH_A, sessions: { s1: SSH_A } }));
    await h.start({ sessionId: 's1' });
    const again = await h.start({ sessionId: 's1' });

    expect(again.reattached).toBe(true);
    expect(h.shells).toHaveLength(1);
    h.pool.killExceptSessionIds([]);
  });

  it('工作区换了就换壳：不复用旧 shell（本地 ↔ SSH 或远端路径变化）', async () => {
    const gateway = makeGateway({ activeSessionId: 's1', viewTarget: SSH_A, sessions: { s1: SSH_A } });
    const h = makeHarness(gateway);
    await h.start({ sessionId: 's1' });

    gateway.sessionWorkspaceTargets.set('s1', SSH_B);
    const r = await h.start({ sessionId: 's1' });

    expect(r.reattached).toBeUndefined();
    expect(h.shells).toHaveLength(2);
    expect(h.shells[1].cwd).toBe('/srv/b');
    expect(h.pool.listSessionIds()).toEqual(['s1']);
    h.pool.killExceptSessionIds([]);
  });

  it('本地工作区仍开本机 shell', async () => {
    const h = makeHarness(makeGateway({ activeSessionId: 's1', viewTarget: LOCAL, sessions: { s1: LOCAL } }));
    const r = await h.start({ sessionId: 's1' });

    expect(r).toMatchObject({ ok: true, remote: false });
    expect(h.shells).toHaveLength(0);
    h.pool.killExceptSessionIds([]);
  });

  it('会话已不在时写入如实回 ok:false（渲染端据此提示）', async () => {
    const h = makeHarness(makeGateway({ activeSessionId: 's1', viewTarget: SSH_A, sessions: { s1: SSH_A } }));
    await h.start({ sessionId: 's1' });
    h.pool.killExceptSessionIds([]);

    expect(await h.write({ sessionId: 's1', data: 'ls\r' })).toMatchObject({
      ok: false,
      reason: 'no-session'
    });
  });
});

'use strict';
/**
 * 会话 worktree 编排：把「会话工作区」指向它自己那份 worktree，并且能安全退回。
 *
 * 全部用假 gateway / 假 ssh，验证的是决策而不是 git。
 */
const assert = require('node:assert/strict');

const { ensureSessionWorktree } = require('../../src/session/session-worktree.js');
const { remoteWorktreePath } = require('../../src/ssh/remote-worktree.js');

function fakeGateway() {
  const state = { contexts: [], rpc: [] };
  return {
    state,
    setSessionWorkspaceContext(sid, ws) {
      state.contexts.push({ sid, ws });
    },
    async invokeRpc(method, params) {
      state.rpc.push({ method, params });
    }
  };
}

function fakeSsh(stdout, opts = {}) {
  const state = { scripts: [] };
  return {
    state,
    async execScript(script) {
      state.scripts.push(script);
      if (opts.throwError) throw new Error('ssh 断开');
      return { code: 0, stdout: stdout, stderr: opts.stderr || '' };
    }
  };
}

const REPO = '/srv/proj';
const SID = 'sess-abc';
const WT = remoteWorktreePath(REPO, SID);
const sshTarget = (remotePath) => ({ kind: 'ssh', host: 'h', port: 22, username: 'u', remotePath });

describe('会话 worktree 编排', () => {
  it('新建成功：会话工作区改指向 worktree 并落库', async () => {
    const gw = fakeGateway();
    const ssh = fakeSsh('WT_CREATED\n');
    const out = await ensureSessionWorktree({ localGateway: gw, sshManager: ssh, sessionId: SID, target: sshTarget(REPO) });

    assert.equal(out.remotePath, WT);
    assert.equal(out.host, 'h', 'SSH 端点信息不能被改掉');
    assert.deepEqual(gw.state.contexts, [], '本模块不直写进程内上下文（唯一入口是 memory.session_workspace_set）');
    // 落库与进程内上下文只走一个入口（session-workspace-bind → memory.session_workspace_set），
    // 「两处都写」的不变式在 Gateway handler 里，不在这里再直写一次
    // （见 test/unit/memory-session-workspace.test.cjs 的同名用例）。
    // 新建成功还会顺手扫一次过期 worktree（读的是会话表），回收规则本身在
    // session-worktree-prune.test.cjs 里验；这里只锁定「落库」这一条
    assert.deepEqual(
      gw.state.rpc.filter((c) => c.method !== 'memory.sessions_list'),
      [
        { method: 'memory.session_workspace_set', params: { sessionId: SID, workspacePath: `ssh://u@h${WT}` } }
      ]
    );
    // 脚本跑在仓库根上，不是 worktree 里
    assert.ok(ssh.state.scripts[0].includes(`REPO='${REPO}'`));
  });

  it('复用已有 worktree：不重复落库', async () => {
    const gw = fakeGateway();
    const ssh = fakeSsh('WT_REUSED\n');
    const out = await ensureSessionWorktree({ localGateway: gw, sshManager: ssh, sessionId: SID, target: sshTarget(REPO) });
    assert.equal(out.remotePath, WT);
    assert.equal(
      gw.state.rpc.filter((c) => c.method === 'memory.session_workspace_set').length,
      1,
      '复用后仍要把会话绑到这份 worktree（一次）'
    );
  });

  it('会话已指向 worktree：仍会校验存在性，但不再写库', async () => {
    const gw = fakeGateway();
    const ssh = fakeSsh('WT_REUSED\n');
    const out = await ensureSessionWorktree({ localGateway: gw, sshManager: ssh, sessionId: SID, target: sshTarget(WT) });
    assert.equal(out.remotePath, WT);
    // 脚本收到的是仓库根（已从 worktree 路径反推），不会套娃
    assert.ok(ssh.state.scripts[0].includes(`REPO='${REPO}'`));
    assert.equal(gw.state.contexts.length, 0, '本模块不直写进程内上下文（唯一入口是 memory.session_workspace_set）');
    assert.equal(gw.state.rpc.length, 0);
  });

  it('远端不是 git 仓库：沿用原目录，不拦会话、不写库', async () => {
    const gw = fakeGateway();
    const log = [];
    const out = await ensureSessionWorktree({
      localGateway: gw,
      sshManager: fakeSsh('WT_NOT_GIT\n'),
      sessionId: SID,
      target: sshTarget(REPO),
      log: (m) => log.push(m)
    });
    assert.equal(out.remotePath, REPO);
    assert.equal(gw.state.contexts.length, 0);
    assert.ok(log.join('\n').includes('不是 git 仓库'));
  });

  it('ssh 抛错：沿用原目录', async () => {
    const gw = fakeGateway();
    const out = await ensureSessionWorktree({
      localGateway: gw,
      sshManager: fakeSsh('', { throwError: true }),
      sessionId: SID,
      target: sshTarget(REPO)
    });
    assert.equal(out.remotePath, REPO);
    assert.equal(gw.state.contexts.length, 0);
  });

  it('git worktree add 失败：沿用原目录', async () => {
    const gw = fakeGateway();
    const out = await ensureSessionWorktree({
      localGateway: gw,
      sshManager: fakeSsh('WT_ADD_FAILED\n', { stderr: 'fatal: already checked out' }),
      sessionId: SID,
      target: sshTarget(REPO)
    });
    assert.equal(out.remotePath, REPO);
    assert.equal(gw.state.contexts.length, 0);
  });

  it('非 ssh 目标 / 缺 sessionId / 缺 ssh：原样返回，不做任何远端动作', async () => {
    const gw = fakeGateway();
    const ssh = fakeSsh('WT_CREATED\n');
    assert.deepEqual(await ensureSessionWorktree({ localGateway: gw, sshManager: ssh, sessionId: SID, target: null }), null);
    const local = { kind: 'local', path: 'C:\\p' };
    assert.equal(await ensureSessionWorktree({ localGateway: gw, sshManager: ssh, sessionId: SID, target: local }), local);
    const t = sshTarget(REPO);
    assert.equal(await ensureSessionWorktree({ localGateway: gw, sshManager: ssh, sessionId: '', target: t }), t);
    assert.deepEqual(await ensureSessionWorktree({ localGateway: gw, sshManager: null, sessionId: SID, target: t }), t);
    assert.equal(ssh.state.scripts.length, 0);
    assert.equal(gw.state.contexts.length, 0);
  });
});

describe('会话工作区写入口的 worktree 保护', () => {
  // _storeSessionWorkspaceTarget 只依赖 sessionWorkspaceTargets，可直接用最小 this 调
  const { LocalGateway } = require('../../src/gateway/server.js');
  const store = LocalGateway.prototype._storeSessionWorkspaceTarget;
  const make = () => {
    const map = new Map();
    return { map, call: (sid, target) => store.call({ sessionWorkspaceTargets: map }, sid, target) };
  };

  it('已有 worktree 时，写回同一仓库的根路径被忽略（防渲染端缓存抹掉）', () => {
    const g = make();
    g.call(SID, sshTarget(WT));
    g.call(SID, sshTarget(REPO));
    assert.equal(g.map.get(SID).remotePath, WT);
  });

  it('换到另一个仓库时正常生效', () => {
    const g = make();
    g.call(SID, sshTarget(WT));
    g.call(SID, sshTarget('/srv/other'));
    assert.equal(g.map.get(SID).remotePath, '/srv/other');
  });

  it('还没 worktree 时按用户所选落库', () => {
    const g = make();
    g.call(SID, sshTarget(REPO));
    assert.equal(g.map.get(SID).remotePath, REPO);
  });

  it('本地目标不受影响', () => {
    const g = make();
    g.call(SID, { kind: 'local', path: 'C:\\p' });
    assert.equal(g.map.get(SID).path, 'C:\\p');
  });
});

'use strict';

const assert = require('node:assert');
const { createMemoryHandlers } = require('../../src/gateway/handlers/memory');

/**
 * 会话工作区字符串的写入关卡（memory.session_create / session_workspace_set）
 * 与交接的工作区归属（handoff_get / handoff_latest）。
 *
 * 事故背景：`ssh:user@host:/path` 这类串曾被原样写进 sessions.workspace_path，
 * 解析端把它当成本地路径，整条会话的 cwd 都指向不存在的目录；跨项目「继续上次」
 * 又会把新会话挂到用户当前视图的工作区。这两条都在这里锁死。
 */
function handlersWithSpy(rustResult = { ok: true }) {
  const calls = [];
  const handlers = createMemoryHandlers({
    requireRustCore: async (method, params) => {
      calls.push({ method, params });
      return typeof rustResult === 'function' ? rustResult(method, params) : rustResult;
    }
  });
  return { handlers, calls };
}

describe('memory.session_create — 工作区写入归一', () => {
  it('ssh 规范串按 buildSshUri 归一（去尾斜杠 / 保端口）', async () => {
    const { handlers, calls } = handlersWithSpy();
    await handlers['memory.session_create']({
      title: 't',
      workspacePath: 'ssh://dieyunx@192.168.31.62/run/media/dieyunx/proj/'
    });
    assert.equal(calls[0].params.workspacePath, 'ssh://dieyunx@192.168.31.62/run/media/dieyunx/proj');
  });

  it('存量 ssh:user@host/path 落库前补成规范形态', async () => {
    const { handlers, calls } = handlersWithSpy();
    await handlers['memory.session_create']({
      workspacePath: 'ssh:dieyunx@192.168.31.62/run/media/dieyunx/proj'
    });
    assert.equal(calls[0].params.workspacePath, 'ssh://dieyunx@192.168.31.62/run/media/dieyunx/proj');
  });

  it('scp 风格的 ssh:user@host:/path 直接拒绝，不落库', async () => {
    const { handlers, calls } = handlersWithSpy();
    await assert.rejects(
      () =>
        handlers['memory.session_create']({
          workspacePath: 'ssh:dieyunx@192.168.31.62:/run/media/dieyunx/dieyunserver/dieyuntools'
        }),
      (e) => e.code === 'INVALID_PARAMS'
    );
    assert.equal(calls.length, 0);
  });

  it('空值 / 未传 → null（不挂工作区）', async () => {
    const { handlers, calls } = handlersWithSpy();
    await handlers['memory.session_create']({ workspacePath: '' });
    await handlers['memory.session_create']({});
    assert.deepEqual(
      calls.map((c) => c.params.workspacePath),
      [null, null]
    );
  });

  it('本地相对路径解析成绝对路径', async () => {
    const { handlers, calls } = handlersWithSpy();
    await handlers['memory.session_create']({ workspacePath: 'sub/dir' });
    assert.match(String(calls[0].params.workspacePath), /sub[\\/]dir$/);
  });
});

describe('memory.session_workspace_set — 同一道关卡', () => {
  it('坏串拒绝，清空放行', async () => {
    const { handlers, calls } = handlersWithSpy();
    await assert.rejects(
      () => handlers['memory.session_workspace_set']({ sessionId: 's1', workspacePath: 'ssh:h:/p' }),
      (e) => e.code === 'INVALID_PARAMS'
    );
    assert.equal(calls.length, 0);
    await handlers['memory.session_workspace_set']({ sessionId: 's1', workspacePath: null });
    assert.equal(calls[0].params.workspacePath, null);
  });

  /**
   * 绑定不变式：写会话行 = 同时更新进程内上下文。
   * 曾散在各调用方（只写库 / 只写内存各来一遍），结果是「库里有、Gateway 仍按旧路径解析」。
   */
  it('写会话行同时更新进程内上下文（同一入口，别人不再各写一遍）', async () => {
    const contexts = [];
    const handlers = createMemoryHandlers({
      requireRustCore: async () => ({ ok: true }),
      ctx: {
        setSessionWorkspaceContext: (sid, ws) => contexts.push({ sid, ws })
      }
    });
    await handlers['memory.session_workspace_set']({ sessionId: 's1', workspacePath: 'sub/dir' });
    assert.equal(contexts.length, 1, '会话行写完必须同步进程内上下文');
    assert.equal(contexts[0].sid, 's1');
    assert.match(String(contexts[0].ws), /sub[\\/]dir$/, '上下文收到的是归一后的绝对路径');

    await handlers['memory.session_workspace_set']({ sessionId: 's1', workspacePath: null });
    assert.equal(contexts[1].ws, '', '空串 = 解绑（上下文删除该会话的目标）');
  });

  it('Rust 落库失败时不改上下文（不留半份绑定）', async () => {
    const contexts = [];
    const handlers = createMemoryHandlers({
      requireRustCore: async () => {
        throw new Error('core down');
      },
      ctx: { setSessionWorkspaceContext: (sid, ws) => contexts.push({ sid, ws }) }
    });
    await assert.rejects(() => handlers['memory.session_workspace_set']({ sessionId: 's1', workspacePath: 'sub/dir' }));
    assert.equal(contexts.length, 0);
  });
});

describe('memory.handoff_* — 交接只认项目身份（仓库根）', () => {
  const worktreeWs =
    'ssh://dieyunx@192.168.31.62/run/media/dieyunx/dieyunserver/dieyuntools/.dieyun/worktrees/sess-e9066136/main';

  it('handoff_latest 把来源 worktree 剥成仓库根', async () => {
    const { handlers } = handlersWithSpy((method) =>
      method === 'memory.handoff_latest'
        ? { sessionId: 's-old', title: 't', payload: 'p', createdAt: 1, workspacePath: worktreeWs }
        : { ok: true }
    );
    const res = await handlers['memory.handoff_latest']({});
    assert.equal(
      res.workspacePath,
      'ssh://dieyunx@192.168.31.62/run/media/dieyunx/dieyunserver/dieyuntools'
    );
    assert.equal(res.sessionId, 's-old');
  });

  it('handoff_get 同样归一；没有工作区时给 null', async () => {
    const { handlers } = handlersWithSpy((method) =>
      method === 'memory.handoff_get' ? { sessionId: 's-old', title: 't', payload: 'p', workspacePath: '' } : { ok: true }
    );
    const res = await handlers['memory.handoff_get']({ sessionId: 's-old' });
    assert.equal(res.workspacePath, null);
  });
});

'use strict';

/**
 * 计划会话的绑定判据（`ensurePlanSession`）。
 *
 * 这里守的是一条线上踩过的坑：会话被**归档**后计划照常往里写，而侧栏只拉
 * `archived = 0`（`renderer-chat-history`），于是「计划天天弹完成通知、界面里一直
 * 没有会话」。归档与删除必须同一判据处理：另开一条，并把新 id 写回 deliver。
 */

const { ensurePlanSession } = require('../../src/plans/plan-session');

function makeGateway(row, opts = {}) {
  const calls = [];
  return {
    calls,
    async invokeRpc(method, params) {
      calls.push({ method, params });
      if (method === 'memory.session_get') {
        // 契约：查不到 → null（Rust `Value::Null`），瞬时失败 → 抛错。两者不可混为一谈。
        if (opts.throwOnGet) throw new Error(opts.throwOnGet);
        return row;
      }
      if (method === 'memory.session_create') return { id: 's-new' };
      return { ok: true };
    },
    setSessionWorkspaceContext() {}
  };
}

function makeStore() {
  const upserts = [];
  return {
    upserts,
    upsert(plan) {
      upserts.push(plan);
      return plan;
    },
    get: (id) => ({ id })
  };
}

const PLAN = {
  id: 'p1',
  name: '巡检',
  workspace: 'F:\\定时任务\\服务器巡检',
  deliver: { type: 'session', sessionId: 's-old' }
};

describe('ensurePlanSession', () => {
  it('会话存在且未归档：复用（工作空间一致时不写会话行）', async () => {
    const gateway = makeGateway({ id: 's-old', archived: 0, workspacePath: PLAN.workspace });
    const store = makeStore();
    const out = await ensurePlanSession(gateway, store, PLAN);
    expect(out.sessionId).toBe('s-old');
    expect(out.rebuilt).toBe(false);
    expect(store.upserts).toHaveLength(0);
    expect(gateway.calls.map((c) => c.method)).toEqual(['memory.session_get']);
  });

  it('会话未归档但工作空间变了：同步会话行，仍然复用', async () => {
    const gateway = makeGateway({ id: 's-old', archived: 0, workspacePath: 'F:\\旧目录' });
    const store = makeStore();
    const out = await ensurePlanSession(gateway, store, PLAN);
    expect(out.sessionId).toBe('s-old');
    const sync = gateway.calls.find((c) => c.method === 'memory.session_workspace_set');
    expect(sync && sync.params.workspacePath).toBe(PLAN.workspace);
  });

  it('会话被归档：另开一条并写回 deliver（不改用户的归档位）', async () => {
    const gateway = makeGateway({ id: 's-old', archived: 1, workspacePath: PLAN.workspace });
    const store = makeStore();
    const out = await ensurePlanSession(gateway, store, PLAN);
    expect(out.sessionId).toBe('s-new');
    expect(out.rebuilt).toBe(true);
    expect(out.staleArchived).toBe(true);
    expect(out.staleSessionId).toBe('s-old');
    expect(store.upserts[0].deliver.sessionId).toBe('s-new');
    expect(gateway.calls.some((c) => c.method === 'memory.session_archive')).toBe(false);
  });

  it('会话已删除（session_get 返回 null）：另开一条并写回 deliver', async () => {
    const gateway = makeGateway(null);
    const store = makeStore();
    const out = await ensurePlanSession(gateway, store, PLAN);
    expect(out.sessionId).toBe('s-new');
    expect(out.rebuilt).toBe(true);
    expect(out.staleArchived).toBe(false);
    expect(store.upserts[0].deliver.sessionId).toBe('s-new');
  });

  it('读会话失败（瞬时错误）：上抛，绝不新建也不覆盖 deliver', async () => {
    const gateway = makeGateway(null, { throwOnGet: 'SQLite busy' });
    const store = makeStore();
    await expect(ensurePlanSession(gateway, store, PLAN)).rejects.toThrow('SQLite busy');
    expect(store.upserts).toHaveLength(0);
    expect(gateway.calls.some((c) => c.method === 'memory.session_create')).toBe(false);
  });
});

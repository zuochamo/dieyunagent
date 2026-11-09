'use strict';

/**
 * `codebase.index`（同步兼容路径）的两条硬约束：
 *
 * 1. **不得把构建跑在 core 的 RPC 通道里**：core 的 RPC 是单线程的，一次全量构建会把同一
 *    core 上的 `codebase.status`(15s) / `codebase.search`(120s) / `index.configure`(45s)
 *    全堵到超时（2026-11-09 真机：`RPC_TIMEOUT codebase.search id=983 timeoutMs=120000`）。
 *    现在统一「后台起任务 + 客户端等 job 落地」。
 * 2. **remote + 要向量时先推 embedding 配置**：换模型后远端 core 还拿着旧模型名
 *    （`EMBEDDING_API: Model not allowed`）就是因为这条路径以前不推。
 */

const { createCodebaseHandlers } = require('../../src/gateway/handlers/codebase');

function build({ kind = 'remote', vectorsIntent = true, status = { ok: true, indexed: true, indexing: false }, pushThrows = false } = {}) {
  const calls = [];
  const handlers = createCodebaseHandlers({
    resolveCodebaseContext: () => ({ kind, rootKey: '/w/proj', remotePath: '/w/proj', userDataPath: '/tmp/ud' }),
    invokeIndexCore: async (_ctx, method) => {
      calls.push(`core:${method}`);
      if (method === 'codebase.status') return status;
      return { ok: true };
    },
    requireRustCore: (method) => {
      calls.push(`local-core:${method}`);
      return { ok: true };
    },
    startCodebaseIndexForContext: async (_ctx, opts) => {
      calls.push(`start:force=${opts.force}:skipIfReady=${opts.skipIfReady}:vectors=${opts.vectors}`);
      let settled = false;
      return {
        started: true,
        alreadyRunning: false,
        job: {
          promise: Promise.resolve().then(() => {
            settled = true;
            calls.push('job:settled');
            return { indexed: true };
          })
        }
      };
    },
    startGraphIndexForContext: async () => ({ ok: true }),
    codebaseHasSearchableIndex: () => true,
    codebaseIncremental: null,
    resolveIndexVectors: (explicit) => (explicit === undefined ? vectorsIntent : !!explicit),
    syncRemoteIndexCoreConfig: async () => {
      if (pushThrows) throw new Error('远端 agent 没连上');
      calls.push('push-config');
      return { ok: true };
    }
  });
  return { handlers, calls };
}

describe('codebase.index（同步兼容路径）', () => {
  it('remote + 要向量：先推配置 → 后台起任务 → 等落地 → 回状态', async () => {
    const { handlers, calls } = build();
    const r = await handlers['codebase.index']({ force: true, vectors: true });
    expect(calls).toEqual([
      'push-config',
      'start:force=true:skipIfReady=false:vectors=true',
      'job:settled',
      'core:codebase.status'
    ]);
    expect(r.ok).toBe(true);
    expect(r.indexing).toBe(false);
    // 关键：不再同步调用 core 的 codebase.index
    expect(calls).not.toContain('core:codebase.index');
    expect(calls.some((c) => c.startsWith('local-core:'))).toBe(false);
  });

  it('remote + 听持久意图（vectors 缺省）：意图为真也推配置', async () => {
    const { handlers, calls } = build({ vectorsIntent: true });
    await handlers['codebase.index']({ force: true });
    expect(calls[0]).toBe('push-config');
    expect(calls[1]).toBe('start:force=true:skipIfReady=false:vectors=true');
  });

  it('remote + 明确不要向量：不推配置，仍走后台任务', async () => {
    const { handlers, calls } = build();
    await handlers['codebase.index']({ force: true, vectors: false });
    expect(calls).toEqual(['start:force=true:skipIfReady=false:vectors=false', 'job:settled', 'core:codebase.status']);
  });

  it('local 工作区：不推配置（远端才有），同样走后台任务', async () => {
    const { handlers, calls } = build({ kind: 'local' });
    await handlers['codebase.index']({ force: true, vectors: true });
    expect(calls).not.toContain('push-config');
    expect(calls).not.toContain('core:codebase.index');
    expect(calls[0]).toBe('start:force=true:skipIfReady=false:vectors=true');
  });

  it('推配置失败不挡住建库', async () => {
    const { handlers, calls } = build({ pushThrows: true });
    await handlers['codebase.index']({ force: true, vectors: true });
    expect(calls[0]).toBe('start:force=true:skipIfReady=false:vectors=true');
  });

  it('构建出错（status.lastError）时如实回报 ok=false', async () => {
    const { handlers } = build({ status: { ok: true, indexed: false, indexing: false, lastError: 'boom' } });
    const r = await handlers['codebase.index']({ force: true, vectors: true });
    expect(r.ok).toBe(false);
    expect(r.lastError).toBe('boom');
  });

  it('状态读不到时不假装成功', async () => {
    const handlers = createCodebaseHandlers({
      resolveCodebaseContext: () => ({ kind: 'local', rootKey: '/w/proj', userDataPath: '/tmp/ud' }),
      invokeIndexCore: async () => {
        throw new Error('core 挂了');
      },
      requireRustCore: () => ({ ok: true }),
      startCodebaseIndexForContext: async () => ({ started: true, job: null }),
      startGraphIndexForContext: async () => ({ ok: true }),
      codebaseHasSearchableIndex: () => true,
      codebaseIncremental: null,
      resolveIndexVectors: () => true,
      syncRemoteIndexCoreConfig: async () => ({ ok: true })
    });
    const r = await handlers['codebase.index']({ force: true, vectors: true });
    expect(r.ok).toBe(false);
    expect(String(r.error || '')).toContain('状态');
  });
});

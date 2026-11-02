'use strict';
/**
 * `codebase.search` 顺手拉起符号表（`src/gateway/handlers/codebase.js:ensureSymbolIndex`）。
 *
 * 锁的是「找定义」那半条能力的**前提**：core 的定义点通道只在 `graph_symbols` 有行时才生效
 * （`docs/INDEX-VALUE-REVIEW.md` §7.3，实测 MRR 0.63 → 0.95）。而结构索引的建库触发点一直
 * 只在 `graph.*` 工具里，新会话（乙案：每会话一个 worktree、一份 index.sqlite）第一次检索
 * 时符号表必然还是空的 —— 所以检索这边要自己保证一次。
 *
 * 这里只锁三件事：
 *   1. 符号表没建 → 起一次结构索引，且**只建符号不建调用边**（`calls: false`，R5 不变）；
 *   2. 已经建了 / 正在建 → 不再起；
 *   3. 结构索引读不到或建不起来 → 检索结果照旧返回（不能把已拿到的结果变成报错）。
 */
const assert = require('node:assert/strict');

const { createCodebaseHandlers } = require('../../src/gateway/handlers/codebase');

function makeHandlers({ graphStatus, onStartGraph } = {}) {
  const calls = [];
  const handlers = createCodebaseHandlers({
    resolveCodebaseContext: () => ({ kind: 'remote', rootKey: 'ssh://h/p' }),
    codebaseHasSearchableIndex: () => true,
    codebaseIncremental: null,
    requireRustCore: () => {
      throw new Error('不该走本地 core');
    },
    startCodebaseIndexForContext: () => {
      throw new Error('搜索不该建代码索引');
    },
    startGraphIndexForContext: async (ctxInfo, opts) => {
      calls.push({ method: 'graph.index.start', opts });
      if (onStartGraph) return onStartGraph(ctxInfo, opts);
      return { started: true };
    },
    invokeIndexCore: async (_ctxInfo, method) => {
      calls.push({ method });
      if (method === 'codebase.status') {
        return { ok: true, indexed: true, indexing: false, chunkCount: 10, vectorCount: 0 };
      }
      if (method === 'codebase.search') {
        return {
          ok: true,
          vectorSearch: false,
          results: [{ path: 'src/a.js', startLine: 1, endLine: 2, score: 1, snippet: 'x' }]
        };
      }
      if (method === 'graph.status') {
        if (graphStatus === 'throws') throw Object.assign(new Error('boom'), { code: 'X' });
        return graphStatus || { ok: true, indexed: true, indexing: false };
      }
      throw new Error(`未预期的 RPC ${method}`);
    }
  });
  return { handlers, calls };
}

const tick = () => new Promise((r) => setTimeout(r, 20));

describe('codebase.search 拉起符号表', () => {
  it('符号表没建时起一次结构索引，且不建调用边', async () => {
    const { handlers, calls } = makeHandlers({ graphStatus: { ok: true, indexed: false } });
    const res = await handlers['codebase.search']({ query: 'parse_config', limit: 5 });
    assert.equal(res.results.length, 1, '本次检索结果要先返回');
    await tick();
    const started = calls.filter((c) => c.method === 'graph.index.start');
    assert.equal(started.length, 1, '应拉起一次结构索引');
    assert.deepEqual(started[0].opts, { force: false, skipIfReady: false, calls: false });
  });

  it('符号表已建好时不再起结构索引', async () => {
    const { handlers, calls } = makeHandlers({ graphStatus: { ok: true, indexed: true } });
    await handlers['codebase.search']({ query: 'parse_config', limit: 5 });
    await tick();
    assert.equal(calls.filter((c) => c.method === 'graph.index.start').length, 0);
  });

  it('结构索引正在建时不重复起', async () => {
    const { handlers, calls } = makeHandlers({
      graphStatus: { ok: true, indexed: false, indexing: true }
    });
    await handlers['codebase.search']({ query: 'parse_config', limit: 5 });
    await tick();
    assert.equal(calls.filter((c) => c.method === 'graph.index.start').length, 0);
  });

  it('结构索引读不到时检索照旧返回', async () => {
    const { handlers, calls } = makeHandlers({ graphStatus: 'throws' });
    const res = await handlers['codebase.search']({ query: 'parse_config', limit: 5 });
    assert.equal(res.results.length, 1);
    await tick();
    assert.equal(calls.filter((c) => c.method === 'graph.index.start').length, 0);
  });

  it('建结构索引失败不影响检索结果', async () => {
    const { handlers } = makeHandlers({
      graphStatus: { ok: true, indexed: false },
      onStartGraph: () => {
        throw Object.assign(new Error('graph 建不起来'), { code: 'GRAPH_FAILED' });
      }
    });
    const res = await handlers['codebase.search']({ query: 'parse_config', limit: 5 });
    assert.equal(res.results.length, 1);
    await tick();
  });
});

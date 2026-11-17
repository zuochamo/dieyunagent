'use strict';

function createGraphHandlers(d) {
  const {
    resolveCodebaseContext,
    invokeIndexCore,
    startGraphIndexForContext,
    scheduleGraphLspEnrich,
    assertGraphIndexReady,
    runGraphLspEnrich,
    resolveGraphSymbolCallersAndIngest
  } = d;

  /**
   * 调用图按需建（R5）：结构索引（符号 + import + mtime）常建，调用边只在第一次
   * 真正用到调用关系时补建一次。返回 true = 本次刚发起构建，调用方应提示稍后再试。
   */
  async function ensureCallGraph(ctxInfo, st, autoIndex) {
    if (autoIndex === false) return false;
    if (!st || !st.indexed) return false;
    // 「建过调用图没有」只看 core 报的 callsBuilt（建库范围，黏性）；
    // `callCount > 0` 是代理判据：建过但一个边都没解析出来时会被误判成没建，白跑一轮。
    if (st.callsBuilt === true || Number(st.callCount) > 0) return false;
    await startGraphIndexForContext(ctxInfo, { force: false, skipIfReady: false, calls: true });
    return true;
  }

  function callGraphBuildingError() {
    const e = new Error('调用图正在按需构建（第一次查调用关系要建一次），请稍后再试');
    e.code = 'GRAPH_INDEXING_IN_PROGRESS';
    return e;
  }

  return {
    'graph.status': async ({ workspaceRoot }) => {
      const ctxInfo = resolveCodebaseContext(workspaceRoot);
      return invokeIndexCore(ctxInfo, 'graph.status', {}, 45000);
    },

    'graph.index.start': async ({ workspaceRoot, force, skipIfReady, calls }) => {
      const ctxInfo = resolveCodebaseContext(workspaceRoot);
      const r = await startGraphIndexForContext(ctxInfo, {
        force: force === undefined ? true : !!force,
        skipIfReady: skipIfReady === undefined ? true : !!skipIfReady,
        // 调用图按需（R5）
        calls: !!calls
      });
      const { job, ...rest } = r || {};
      void job;
      if (rest && rest.indexed && !rest.indexing) {
        scheduleGraphLspEnrich(ctxInfo, { reason: 'already_ready' });
      }
      return { ok: true, ...rest };
    },

    'graph.index': async ({ workspaceRoot, force, calls }) => {
      const ctxInfo = resolveCodebaseContext(workspaceRoot);
      const st = await invokeIndexCore(
        ctxInfo,
        'graph.index',
        {
          force: force !== false,
          calls: !!calls
        },
        600000
      );
      if (st && st.indexed) {
        scheduleGraphLspEnrich(ctxInfo, { reason: 'sync_index' });
      }
      return st;
    },

    'graph.module_deps': async ({ workspaceRoot, path, depth, autoIndex }) => {
      const ctxInfo = resolveCodebaseContext(workspaceRoot);
      const st = await invokeIndexCore(ctxInfo, 'graph.status', {}, 45000);
      if (autoIndex !== false) {
        assertGraphIndexReady(st, { requireEdges: true });
      }
      return invokeIndexCore(ctxInfo, 'graph.module_deps', {
        path: path != null ? String(path) : undefined,
        depth
      });
    },

    'graph.repo_map': async ({ workspaceRoot, limit }) => {
      const ctxInfo = resolveCodebaseContext(workspaceRoot);
      const st = await invokeIndexCore(ctxInfo, 'graph.status', {}, 45000);
      if (!st || !st.indexed) {
        return {
          ok: true,
          indexed: false,
          hubFiles: [],
          hubSymbols: [],
          edges: [],
          circular: [],
          markdown: ''
        };
      }
      return invokeIndexCore(
        ctxInfo,
        'graph.repo_map',
        { limit: limit != null ? Number(limit) : 32 },
        30000
      );
    },

    'graph.lsp_enrich': async ({ workspaceRoot, limit, timeoutMs, force }) => {
      const ctxInfo = resolveCodebaseContext(workspaceRoot);
      if (force) {
        return runGraphLspEnrich(ctxInfo, {
          limit: limit != null ? Number(limit) : 20,
          timeoutMs: timeoutMs != null ? Number(timeoutMs) : 12000,
          wallMs: 60000
        });
      }
      const job = scheduleGraphLspEnrich(ctxInfo, {
        limit,
        timeoutMs,
        force: false,
        reason: 'rpc'
      });
      if (job && job.promise) {
        return job.promise;
      }
      return { ok: false, error: 'enrich_not_started', enriched: 0, attempted: 0 };
    },

    'graph.symbol_search': async ({ workspaceRoot, query, kind, limit, autoIndex }) => {
      const q = String(query || '').trim();
      if (!q) {
        const e = new Error('query 必填');
        e.code = 'INVALID_QUERY';
        throw e;
      }
      const ctxInfo = resolveCodebaseContext(workspaceRoot);
      const st = await invokeIndexCore(ctxInfo, 'graph.status', {}, 45000);
      if (autoIndex !== false) {
        assertGraphIndexReady(st, {});
      }
      return invokeIndexCore(ctxInfo, 'graph.symbol_search', {
        query: q,
        kind,
        limit
      });
    },

    'graph.callers': async ({ workspaceRoot, path, name, symbolId, autoIndex }) => {
      const ctxInfo = resolveCodebaseContext(workspaceRoot);
      const st = await invokeIndexCore(ctxInfo, 'graph.status', {}, 45000);
      if (await ensureCallGraph(ctxInfo, st, autoIndex)) throw callGraphBuildingError();
      if (autoIndex !== false) {
        assertGraphIndexReady(st, { requireCalls: true });
      }
      return invokeIndexCore(ctxInfo, 'graph.callers', {
        path: path != null ? String(path) : undefined,
        name: name != null ? String(name) : undefined,
        symbolId
      });
    },

    'graph.callees': async ({ workspaceRoot, path, name, symbolId, autoIndex }) => {
      const ctxInfo = resolveCodebaseContext(workspaceRoot);
      const st = await invokeIndexCore(ctxInfo, 'graph.status', {}, 45000);
      if (await ensureCallGraph(ctxInfo, st, autoIndex)) throw callGraphBuildingError();
      if (autoIndex !== false) {
        assertGraphIndexReady(st, { requireCalls: true });
      }
      return invokeIndexCore(ctxInfo, 'graph.callees', {
        path: path != null ? String(path) : undefined,
        name: name != null ? String(name) : undefined,
        symbolId
      });
    },

    'graph.impact': async ({ workspaceRoot, path, depth, autoIndex }) => {
      const p = String(path || '').trim();
      if (!p) {
        const e = new Error('path 必填');
        e.code = 'INVALID_PARAMS';
        throw e;
      }
      const ctxInfo = resolveCodebaseContext(workspaceRoot);
      const st = await invokeIndexCore(ctxInfo, 'graph.status', {}, 45000);
      if (autoIndex !== false) {
        assertGraphIndexReady(st, {});
      }
      return invokeIndexCore(ctxInfo, 'graph.impact', {
        path: p,
        depth
      });
    },

    'graph.lsp_resolve': async ({
      workspaceRoot,
      path: symbolPath,
      name,
      symbolId,
      persist,
      timeoutMs
    }) => {
      const symName = String(name || '').trim();
      if (!symName && symbolId == null) {
        const e = new Error('name 或 symbolId 必填');
        e.code = 'INVALID_PARAMS';
        throw e;
      }
      const ctxInfo = resolveCodebaseContext(workspaceRoot);
      const st = await invokeIndexCore(ctxInfo, 'graph.status', {}, 45000);
      if (await ensureCallGraph(ctxInfo, st, true)) throw callGraphBuildingError();
      assertGraphIndexReady(st, { requireCalls: true });
      const searchQuery = symName || 'symbol';
      const search = await invokeIndexCore(ctxInfo, 'graph.symbol_search', {
        query: searchQuery,
        limit: 50
      });
      const normPath = symbolPath != null ? String(symbolPath).replace(/\\/g, '/') : '';
      let symbol = null;
      if (symbolId != null) {
        symbol = (search.results || []).find((s) => Number(s.id) === Number(symbolId)) || null;
      }
      if (!symbol && symName) {
        symbol =
          (search.results || []).find(
            (s) => s.name === symName && (!normPath || s.path === normPath)
          ) ||
          (search.results || []).find((s) => s.name === symName) ||
          null;
      }
      if (!symbol) {
        return { ok: false, error: 'symbol_not_found', query: symName, sites: [] };
      }
      return resolveGraphSymbolCallersAndIngest(ctxInfo, symbol, {
        persist,
        timeoutMs
      });
    },
  };
}

module.exports = { createGraphHandlers };

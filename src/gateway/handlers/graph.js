'use strict';

function createGraphHandlers(d) {
  const {
    resolveCodebaseContext,
    invokeIndexCore,
    startGraphIndexForContext,
    scheduleGraphLspEnrich,
    getActiveEmbeddingConfig,
    assertGraphIndexReady,
    runGraphLspEnrich,
    resolveGraphSymbolCallersAndIngest
  } = d;
  return {
    'graph.status': async ({ workspaceRoot }) => {
      const ctxInfo = resolveCodebaseContext(workspaceRoot);
      return invokeIndexCore(ctxInfo, 'graph.status', {}, 45000);
    },

    'graph.index.start': async ({ workspaceRoot, force, skipIfReady }) => {
      const ctxInfo = resolveCodebaseContext(workspaceRoot);
      const r = await startGraphIndexForContext(ctxInfo, {
        force: force === undefined ? true : !!force,
        skipIfReady: skipIfReady === undefined ? true : !!skipIfReady
      });
      const { job, ...rest } = r || {};
      void job;
      if (rest && rest.indexed && !rest.indexing) {
        scheduleGraphLspEnrich(ctxInfo, { reason: 'already_ready' });
      }
      return { ok: true, ...rest };
    },

    'graph.index': async ({ workspaceRoot, force, embedSymbols }) => {
      const ctxInfo = resolveCodebaseContext(workspaceRoot);
      const st = await invokeIndexCore(
        ctxInfo,
        'graph.index',
        {
          force: force !== false,
          embedSymbols: embedSymbols !== false
        },
        600000
      );
      if (st && st.indexed) {
        scheduleGraphLspEnrich(ctxInfo, { reason: 'sync_index' });
      }
      return st;
    },

    'graph.embed_symbols': async ({ workspaceRoot, force }) => {
      const ctxInfo = resolveCodebaseContext(workspaceRoot);
      const embedding = getActiveEmbeddingConfig();
      if (!embedding || embedding.disabled || !embedding.model) {
        const e = new Error('未配置 Embedding 模型，无法构建符号向量');
        e.code = 'EMBEDDING_DISABLED';
        throw e;
      }
      if (ctxInfo.kind === 'remote') {
        const st = await invokeIndexCore(ctxInfo, 'graph.status', {}, 20000);
        assertGraphIndexReady(st, {});
      }
      return invokeIndexCore(
        ctxInfo,
        'graph.embed_symbols',
        { force: force === true },
        600000
      );
    },

    'graph.symbol_semantic_search': async ({
      workspaceRoot,
      query,
      kind,
      limit,
      autoIndex,
      autoEmbed
    }) => {
      const q = String(query || '').trim();
      if (!q) {
        const e = new Error('query 必填');
        e.code = 'INVALID_QUERY';
        throw e;
      }
      const ctxInfo = resolveCodebaseContext(workspaceRoot);
      const st = await invokeIndexCore(ctxInfo, 'graph.status', {}, 20000);
      if (autoIndex !== false) {
        assertGraphIndexReady(st, {});
      }
      return invokeIndexCore(ctxInfo, 'graph.symbol_semantic_search', {
        query: q,
        kind,
        limit,
        autoEmbed: autoEmbed !== false
      });
    },

    'graph.module_deps': async ({ workspaceRoot, path, depth, autoIndex }) => {
      const ctxInfo = resolveCodebaseContext(workspaceRoot);
      const st = await invokeIndexCore(ctxInfo, 'graph.status', {}, 20000);
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
      const st = await invokeIndexCore(ctxInfo, 'graph.status', {}, 20000);
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
      const st = await invokeIndexCore(ctxInfo, 'graph.status', {}, 20000);
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
      const st = await invokeIndexCore(ctxInfo, 'graph.status', {}, 20000);
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
      const st = await invokeIndexCore(ctxInfo, 'graph.status', {}, 20000);
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
      const st = await invokeIndexCore(ctxInfo, 'graph.status', {}, 20000);
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
      const st = await invokeIndexCore(ctxInfo, 'graph.status', {}, 20000);
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

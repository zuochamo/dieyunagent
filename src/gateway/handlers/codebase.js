'use strict';

/** 索引构建中时，search 最多等待多久（保存后立刻提问常落在这个窗口内） */
const INDEX_WAIT_MAX_MS = 4000;
const INDEX_WAIT_INTERVAL_MS = 300;

function createCodebaseHandlers(d) {
  const {
    resolveCodebaseContext,
    invokeIndexCore,
    startCodebaseIndexForContext,
    requireRustCore,
    codebaseHasSearchableIndex,
    codebaseIncremental
  } = d;

  /**
   * 索引正在构建时短暂等待其完成，而不是立刻抛 INDEXING_IN_PROGRESS。
   * 保存文件会触发后台增量索引，此时模型往往紧接着就检索，直接失败体验很差。
   */
  async function waitForIndexIdle(ctxInfo, initial) {
    let st = initial;
    const deadline = Date.now() + INDEX_WAIT_MAX_MS;
    while (st && st.indexing && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, INDEX_WAIT_INTERVAL_MS));
      try {
        const next = await invokeIndexCore(ctxInfo, 'codebase.status', {}, 20000);
        if (!next) break;
        st = next;
        if (!st.indexing) break;
      } catch {
        break;
      }
    }
    return st;
  }

  return {
    'codebase.status': async ({ workspaceRoot }) => {
      const ctxInfo = resolveCodebaseContext(workspaceRoot);
      const st = await invokeIndexCore(ctxInfo, 'codebase.status', {}, 45000);
      if (!st || !codebaseIncremental || typeof codebaseIncremental.getRefreshState !== 'function') {
        return st;
      }
      // 附加「刚保存过、增量还没跟上」的信号，供 prep 决定是否等一小会儿
      let refresh = null;
      try {
        refresh = codebaseIncremental.getRefreshState(workspaceRoot);
      } catch {
        refresh = null;
      }
      if (!refresh) return st;
      const savedAgeMs = refresh.lastSavedAt ? Date.now() - refresh.lastSavedAt : 0;
      return {
        ...st,
        refreshPending: !!refresh.pending,
        savedAgeMs: savedAgeMs > 0 ? savedAgeMs : undefined
      };
    },

    'codebase.index.start': async ({ workspaceRoot, force, skipIfReady }) => {
      const ctxInfo = resolveCodebaseContext(workspaceRoot);
      // 显式 false 才跳过；缺省 force 走 true（手动重建）
      const r = await startCodebaseIndexForContext(ctxInfo, {
        force: force === undefined ? true : !!force,
        skipIfReady: skipIfReady === undefined ? true : !!skipIfReady
      });
      const { job, ...rest } = r || {};
      void job;
      return { ok: true, ...rest };
    },

    'codebase.index': async ({ workspaceRoot, force }) => {
      const ctxInfo = resolveCodebaseContext(workspaceRoot);
      if (ctxInfo.kind === 'remote') {
        return invokeIndexCore(ctxInfo, 'codebase.index', { force: force !== false }, 600000);
      }
      return requireRustCore(
        'codebase.index',
        { workspaceRoot: ctxInfo.rootKey, force: force !== false },
        600000
      );
    },

    'codebase.search': async ({ workspaceRoot, query, limit, autoIndex }) => {
      const q = String(query || '').trim();
      if (!q) {
        const e = new Error('query 必填');
        e.code = 'INVALID_QUERY';
        throw e;
      }
      const ctxInfo = resolveCodebaseContext(workspaceRoot);
      let st = await invokeIndexCore(ctxInfo, 'codebase.status', {}, 45000);
      if (st && st.indexing) {
        st = await waitForIndexIdle(ctxInfo, st);
      }
      if (st && st.indexing) {
        const e = new Error('代码库索引创建中，请稍后再试');
        e.code = 'INDEXING_IN_PROGRESS';
        throw e;
      }
      if (!codebaseHasSearchableIndex(st)) {
        // 不做 search 内同步建库 / grep 降级
        if (autoIndex !== false) {
          const e = new Error('代码库尚未索引，请稍后再试或使用 grep/读文件');
          e.code = 'INDEX_REQUIRED';
          throw e;
        }
        const e = new Error('代码库尚未索引');
        e.code = 'INDEX_REQUIRED';
        throw e;
      }
      return invokeIndexCore(ctxInfo, 'codebase.search', {
        query: q,
        limit,
        autoIndex: false
      });
    },
  };
}

module.exports = { createCodebaseHandlers };

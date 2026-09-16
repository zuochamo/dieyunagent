'use strict';

/**
 * @param {{
 *   requireRustCore: (method: string, params?: object, timeoutMs?: number) => Promise<unknown>,
 *   projectMemoryScope: (workspacePath?: string) => string | null
 * }} deps
 */
function createMemoryHandlers({ requireRustCore, projectMemoryScope }) {
  return {
    'memory.touch_session': async ({ sessionId, title }) => {
      const sid = String(sessionId);
      const r = await requireRustCore('memory.touch_session', { sessionId: sid, title });
      return r.ok === false ? r : { ok: true, ...r };
    },

    'memory.sessions_list': async ({ limit, archived }) => {
      const lim = Math.min(100, Math.max(1, Number(limit) || 40));
      return requireRustCore('memory.sessions_list', { limit: lim, archived: !!archived });
    },

    'memory.session_archive': async ({ sessionId, archived }) =>
      requireRustCore('memory.session_archive', {
        sessionId: String(sessionId),
        archived: archived !== false
      }),

    'memory.session_create': async ({ title, workspacePath }) =>
      requireRustCore('memory.session_create', {
        title: title ? String(title) : undefined,
        workspacePath: workspacePath || null
      }),

    'memory.session_get': async ({ sessionId }) =>
      requireRustCore('memory.session_get', { sessionId: String(sessionId || '') }),

    'memory.session_workspace_set': async ({ sessionId, workspacePath }) =>
      requireRustCore('memory.session_workspace_set', {
        sessionId: String(sessionId || ''),
        workspacePath: workspacePath || null
      }),

    'memory.session_delete': async ({ sessionId }) =>
      requireRustCore('memory.session_delete', { sessionId: String(sessionId) }),

    'memory.message_append': async ({ sessionId, role, content }) => {
      const sid = String(sessionId);
      const r = String(role);
      if (!['user', 'assistant', 'system'].includes(r)) {
        const e = new Error('非法 role');
        e.code = 'INVALID_ROLE';
        throw e;
      }
      if (!content || typeof content !== 'string') {
        const e = new Error('content 必填');
        e.code = 'INVALID_CONTENT';
        throw e;
      }
      const rustIns = await requireRustCore('memory.message_append', {
        sessionId: sid,
        role: r,
        content
      });
      return { ok: true, localMsgId: rustIns.localMsgId };
    },

    'memory.messages_recent': async ({ sessionId, limit }) => {
      const lim = Math.min(500, Math.max(1, Number(limit) || 50));
      return requireRustCore('memory.messages_recent', { sessionId: String(sessionId), limit: lim });
    },

    'memory.messages_older': async ({ sessionId, beforeId, limit }) => {
      const lim = Math.min(500, Math.max(1, Number(limit) || 100));
      const before = Number(beforeId);
      if (!Number.isFinite(before)) {
        const e = new Error('beforeId 必填');
        e.code = 'INVALID_PARAMS';
        throw e;
      }
      return requireRustCore('memory.messages_older', {
        sessionId: String(sessionId),
        beforeId: before,
        limit: lim
      });
    },

    'memory.messages_delete_turn': async ({ sessionId, messageId, removeCount }) => {
      const ids = Array.isArray(messageId)
        ? messageId.map((n) => Number(n)).filter((n) => Number.isFinite(n))
        : [];
      return requireRustCore('memory.messages_delete_turn', {
        sessionId: String(sessionId || ''),
        messageId: ids,
        removeCount: ids.length ? undefined : removeCount
      });
    },

    'memory.messages_clear': async ({ sessionId }) =>
      requireRustCore('memory.messages_clear', { sessionId: String(sessionId) }),

    'memory.long_add': async ({ content, source, kind, scope, importance, expiresAt, metadata }) => {
      if (!content || typeof content !== 'string') {
        const e = new Error('content 必填');
        e.code = 'INVALID_CONTENT';
        throw e;
      }
      const rustAdd = await requireRustCore(
        'memory.long_add',
        {
          content,
          source: source ? String(source) : 'user',
          kind,
          scope,
          importance,
          expiresAt,
          metadata
        },
        120000
      );
      return rustAdd;
    },

    'memory.long_recent': async ({ limit, scope }) => {
      const lim = Math.min(100, Math.max(1, Number(limit) || 20));
      return requireRustCore('memory.long_recent', {
        limit: lim,
        scope: scope ? String(scope) : undefined
      });
    },

    'memory.long_recall': async ({ query, limit, scope }) =>
      requireRustCore(
        'memory.long_recall',
        {
          query: String(query || '').trim(),
          limit: Math.min(50, Math.max(1, Number(limit) || 12)),
          scope: scope || undefined
        },
        120000
      ),

    'memory.long_keyword_search': async ({ query, limit }) =>
      requireRustCore('memory.long_keyword_search', {
        query: String(query || ''),
        limit
      }),

    'memory.long_vector_status': async () => requireRustCore('memory.long_vector_status', {}),

    'memory.long_reindex': async ({ limit }) =>
      requireRustCore('memory.long_reindex', { limit }, 600000),

    'memory.long_status_set': async ({ memoryId, status }) =>
      requireRustCore('memory.long_status_set', { memoryId, status }),

    'memory.consolidation_job_create': async ({ scope, reason }) =>
      requireRustCore('memory.consolidation_job_create', { scope, reason }),

    'memory.consolidation_job_finish': async ({ jobId, status, error }) =>
      requireRustCore('memory.consolidation_job_finish', { jobId, status, error }),

    'memory.long_decay': async ({ staleDays, archiveDays }) =>
      requireRustCore('memory.long_decay', { staleDays, archiveDays }),

    'memory.sessions_with_messages': async () => requireRustCore('memory.sessions_with_messages', {}),

    'memory.messages_after': async ({ afterId, limit }) =>
      requireRustCore('memory.messages_after', { afterId, limit }),

    'memory.long_memories_after': async ({ afterId, limit }) =>
      requireRustCore('memory.long_memories_after', { afterId, limit }),

    'memory.project_scope': ({ workspacePath } = {}) => ({
      scope: projectMemoryScope(workspacePath)
    }),

    'memory.project_recall': async ({ workspacePath, query, limit } = {}) => {
      const scope = projectMemoryScope(workspacePath);
      if (!scope) return { ok: true, mode: 'recent', results: [] };
      // 新工作区常无项目记忆；短超时 + 服务端空库快路，避免拖死 dieyun-core 单线程 RPC
      return requireRustCore(
        'memory.long_recall',
        { query: String(query || ''), limit, scope },
        12000
      );
    },

    'memory.project_add': async ({
      workspacePath,
      content,
      source,
      kind,
      importance,
      metadata
    } = {}) => {
      const scope = projectMemoryScope(workspacePath);
      if (!scope) {
        const e = new Error('workspacePath 必填');
        e.code = 'INVALID_WORKSPACE';
        throw e;
      }
      if (!content || typeof content !== 'string') {
        const e = new Error('content 必填');
        e.code = 'INVALID_CONTENT';
        throw e;
      }
      const rustAdd = await requireRustCore(
        'memory.long_add',
        {
          content,
          source: source ? String(source) : 'project',
          kind,
          scope,
          importance,
          metadata
        },
        120000
      );
      return {
        ok: true,
        localMemoryId: rustAdd.localMemoryId,
        scope,
        vector: rustAdd.vector || { indexed: false }
      };
    },

    'memory.compaction_archive': async (payload) =>
      requireRustCore('memory.compaction_archive', payload),

    'memory.compaction_recent': async ({ sessionId, limit }) =>
      requireRustCore('memory.compaction_recent', {
        sessionId: String(sessionId || ''),
        limit
      })
  };
}

module.exports = { createMemoryHandlers };

'use strict';

const { projectWorkspacePath, parseWorkspaceInput, buildSshUri } = require('../../workspace/target');
const { readGitRemoteUrl } = require('../../peer/workspace-key');

/**
 * 会话工作区字符串的**唯一写入口径**（`session_create` / `session_workspace_set`）。
 *
 * 能解析就存规范形态（ssh 存 `ssh://user@host/path`，本地存解析后的绝对路径）；
 * 解析失败直接抛 INVALID_PARAMS，不落库。
 *
 * 不加兜底的理由：历史事故里 `ssh:user@host:/path`（scp 风格）被原样写进表，
 * 解析端把它当成本地路径，整条会话的 cwd 都指向一个不存在的 Windows 目录。
 * 写入端拒绝一次，比在读取端猜永远更便宜。
 */
function normalizeSessionWorkspacePath(workspacePath) {
  const raw = String(workspacePath == null ? '' : workspacePath).trim();
  if (!raw) return null;
  const target = parseWorkspaceInput(raw);
  if (!target) {
    const e = new Error(`工作空间路径无法识别：${raw}（远端须写成 ssh://user@host/path）`);
    e.code = 'INVALID_PARAMS';
    throw e;
  }
  return target.kind === 'ssh' ? buildSshUri(target) : target.path;
}

/**
 * 项目身份（**唯一来源** = Rust `projects` 表，见 `memory/projects.rs`）。
 *
 * 以前 scope 由路径派生（`project:<路径>` / `project:<sha256前16>:<路径尾72>`），于是
 * 「改目录名 = 换项目」、大小写/尾斜杠/worktree 入口各算一个 scope，记忆静默失联。
 * 现在：`projectWorkspacePath()` 归一入口（多 agent worktree 会话不另起 scope）+
 * `projects(id, root_path, git_origin)` 认身份，scope 恒为 `project:<id>`；
 * 仓库搬家时 `git_origin` 相同 → 新路径挂成同一 project 的别名，记忆不丢。
 *
 * git 探测复用 `src/peer/workspace-key.js`（同一份「同一项目」判定，不另写一套）。
 * @param {string | null | undefined} workspacePath
 * @param {(method: string, params?: object, timeoutMs?: number) => Promise<any>} requireRustCore
 */
async function resolveProjectScope(workspacePath, requireRustCore) {
  const raw = String(workspacePath || '').trim();
  if (!raw) return { scope: '', projectId: 0, rootPath: '', aliased: false };
  let root = raw;
  try {
    root = projectWorkspacePath(raw) || raw;
  } catch {
    root = raw;
  }
  let gitOrigin = '';
  try {
    gitOrigin = readGitRemoteUrl(root);
  } catch {
    gitOrigin = '';
  }
  const res = await requireRustCore('memory.project_resolve', {
    path: root,
    gitOrigin: gitOrigin || null
  });
  const out = res && typeof res === 'object' ? res : {};
  return {
    scope: String(out.scope || ''),
    projectId: Number(out.projectId) || 0,
    rootPath: String(out.rootPath || root),
    aliased: !!out.aliased
  };
}

/**
 * 交接的「来自哪个工作区」对外只给项目身份（仓库根），不给来源会话的 worktree：
 * 接手的新会话会自己派生自己的 worktree，继承别人的副本只会让两边写同一棵树。
 */
function handoffWithProjectWorkspace(row) {
  if (!row || typeof row !== 'object') return row;
  const ws = String(row.workspacePath || '').trim();
  return { ...row, workspacePath: ws ? projectWorkspacePath(ws) || ws : null };
}

/**
 * @param {{
 *   requireRustCore: (method: string, params?: object, timeoutMs?: number) => Promise<unknown>
 * }} deps
 */
function createMemoryHandlers({ requireRustCore }) {
  return {
    'memory.touch_session': async ({ sessionId, title }) => {
      const sid = String(sessionId);
      const r = await requireRustCore('memory.touch_session', { sessionId: sid, title });
      return r.ok === false ? r : { ok: true, ...r };
    },

    // 显式标题写入（AI 总结 / 用户改名）：与「必要时补启发式标题」的 touch_session 分列。
    // 来源必须由调用方声明，免得自动标题冒充用户改名。
    'memory.session_set_title': async ({ sessionId, title, source }) => {
      const sid = String(sessionId || '').trim();
      if (!sid) {
        const e = new Error('sessionId 必填');
        e.code = 'INVALID_PARAMS';
        throw e;
      }
      const text = String(title || '').trim();
      if (!text) {
        const e = new Error('title 必填');
        e.code = 'INVALID_CONTENT';
        throw e;
      }
      const src = String(source || '').trim();
      if (!src) {
        const e = new Error('source 必填（ai / user）');
        e.code = 'INVALID_PARAMS';
        throw e;
      }
      return requireRustCore('memory.session_set_title', {
        sessionId: sid,
        title: text,
        source: src
      });
    },

    'memory.sessions_list': async ({ limit, archived }) => {
      const lim = Math.min(100, Math.max(1, Number(limit) || 40));
      const rows = await requireRustCore('memory.sessions_list', { limit: lim, archived: !!archived });
      if (!Array.isArray(rows)) return rows;
      // workspacePath 是会话**实际写入**的位置（远端会话就是它自己那份 worktree）；
      // 对外的项目身份另给一份，渲染端据此分组与显示，否则同一项目的每个会话都会
      // 变成一个独立的、名为 `main` 的文件夹。
      return rows.map((row) => {
        const workspacePath = String((row && row.workspacePath) || '');
        return { ...row, workspaceProjectPath: projectWorkspacePath(workspacePath) };
      });
    },

    'memory.session_archive': async ({ sessionId, archived }) =>
      requireRustCore('memory.session_archive', {
        sessionId: String(sessionId),
        archived: archived !== false
      }),

    'memory.session_create': async ({ title, workspacePath }) =>
      requireRustCore('memory.session_create', {
        title: title ? String(title) : undefined,
        workspacePath: normalizeSessionWorkspacePath(workspacePath)
      }),

    'memory.session_get': async ({ sessionId }) =>
      requireRustCore('memory.session_get', { sessionId: String(sessionId || '') }),

    'memory.session_workspace_set': async ({ sessionId, workspacePath }) =>
      requireRustCore('memory.session_workspace_set', {
        sessionId: String(sessionId || ''),
        workspacePath: normalizeSessionWorkspacePath(workspacePath)
      }),

    'memory.session_delete': async ({ sessionId }) =>
      requireRustCore('memory.session_delete', { sessionId: String(sessionId) }),

    // —— 会话交接：按 session_id 精确读写（不参与语义召回，与 long_memories 分层）——
    'memory.handoff_save': async ({ sessionId, title, payload }) => {
      if (!payload || typeof payload !== 'string' || !payload.trim()) {
        const e = new Error('payload 必填');
        e.code = 'INVALID_CONTENT';
        throw e;
      }
      return requireRustCore('memory.handoff_save', {
        sessionId: String(sessionId || ''),
        title: title ? String(title) : '',
        payload
      });
    },

    'memory.handoff_get': async ({ sessionId }) =>
      handoffWithProjectWorkspace(
        await requireRustCore('memory.handoff_get', { sessionId: String(sessionId || '') })
      ),

    'memory.handoff_latest': async ({ excludeSessionId }) =>
      handoffWithProjectWorkspace(
        await requireRustCore('memory.handoff_latest', {
          excludeSessionId: excludeSessionId ? String(excludeSessionId) : null
        })
      ),

    'memory.message_append': async ({ sessionId, role, content, reasoning }) => {
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
      // 真思考与 content 分列；仅非空字符串才写入，其余交由 Rust 落 NULL。
      const reasoningText = typeof reasoning === 'string' && reasoning.trim() ? reasoning : null;
      const rustIns = await requireRustCore('memory.message_append', {
        sessionId: sid,
        role: r,
        content,
        ...(reasoningText ? { reasoning: reasoningText } : {})
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

    'memory.long_add': async ({
      content,
      source,
      kind,
      scope,
      importance,
      expiresAt,
      metadata,
      sessionId
    }) => {
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
          metadata,
          // 溯源：谁沉淀的（会话）。之后「这个会话写了什么 / 忘掉这个会话写的」靠它。
          sessionId: sessionId ? String(sessionId) : undefined
        },
        120000
      );
      return rustAdd;
    },

    /** 会话维度：这个会话沉淀了哪些记忆（id/kind/importance 都在，供 UI 直接展示） */
    'memory.session_memories': async ({ sessionId, limit }) =>
      requireRustCore('memory.long_by_session', {
        sessionId: String(sessionId || ''),
        limit: Math.min(200, Math.max(1, Number(limit) || 50))
      }),

    /** 会话维度：把这个会话沉淀的记忆整体软归档（可恢复，不物理删除） */
    'memory.session_memories_forget': async ({ sessionId }) =>
      requireRustCore('memory.long_forget_session', { sessionId: String(sessionId || '') }),

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

    'memory.project_scope': async ({ workspacePath } = {}) =>
      resolveProjectScope(workspacePath, requireRustCore),

    // 项目清单（id / 根路径 / git origin / 别名数 / 记忆数）：排查「这条记忆属于谁」用
    'memory.project_list': async ({ limit } = {}) =>
      requireRustCore('memory.project_list', { limit }),

    // 人工挂别名：同一个仓库换了路径、但 git remote 不可用（纯本地仓库）时的兜底动作
    'memory.project_alias_add': async ({ projectId, path } = {}) =>
      requireRustCore('memory.project_alias_add', { projectId, path }),

    'memory.project_recall': async ({ workspacePath, query, limit } = {}) => {
      const { scope } = await resolveProjectScope(workspacePath, requireRustCore);
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
      metadata,
      sessionId
    } = {}) => {
      const { scope } = await resolveProjectScope(workspacePath, requireRustCore);
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
          metadata,
          sessionId: sessionId ? String(sessionId) : undefined
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
      }),

    // —— 请求快照（只读面；写入唯一入口在 Node 循环内部，不经 Gateway）——
    // 用途：事后回答「这一轮模型到底看到了什么」。列表不带大字段，原文要 get。
    'memory.request_snapshot_recent': async ({ sessionId, limit }) =>
      requireRustCore('memory.request_snapshot_recent', {
        sessionId: String(sessionId || ''),
        limit
      }),

    'memory.request_snapshot_get': async ({ id }) =>
      requireRustCore('memory.request_snapshot_get', { id: Number(id) })
  };
}

module.exports = { createMemoryHandlers };

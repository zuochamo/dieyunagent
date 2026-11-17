'use strict';

/**
 * 记忆：轮内召回（session_recall / memory_recall）与纠错（memory_forget）。写入策略只在 memory.long_add 一处，工具不绕过它。
 *
 * 从 `tool-bridge-main.js` 的 1036 行 switch 里拆出（曾零直测）：现在由
 * `scripts/test-tool-bridge-handlers.cjs` 覆盖参数翻译与形状转换。
 * 依赖一律由 `shared` 传入（不 require），所以本文件能被单测直接装进沙箱。
 *
 * @param {object} shared 工具桥闭包里的依赖与取值器（见 main-tools/index.js）
 */
function createMemoryHandlers(shared) {
  const {
    getAgentLimits,
    userDataPath,
    gateway,
    PROJECT_MEMORY_REL_PATH,
    parseProjectMemoryEntries
  } = shared;

  return {
    session_recall: async (a, ctx) => {
        if (!gateway) return { error: 'Gateway 未就绪', errorCode: 'GATEWAY_UNAVAILABLE' };
        const query = String(a.query || '').trim();
        if (!query) return { error: 'query 必填' };
        const sessionLimits = getAgentLimits(userDataPath, ctx.contextTierId);
        const wantScope = String(a.scope || 'workspace') === 'session' ? 'session' : 'workspace';
        const limit = Math.min(20, Math.max(1, Number(a.limit) || sessionLimits.sessionRecallLimit));
        const wsRoot = ctx.workspacePath || ctx.worktreePath || '';
        if (wantScope === 'workspace' && !wsRoot) {
          return {
            ok: true,
            total: 0,
            results: [],
            note: '当前会话没有绑定工作空间，无法跨会话检索；可改用 scope=session 只看本会话'
          };
        }
        // 路径归一与工作空间圈定都在 Rust 侧（`memory::search_messages` 复用
        // `project_path_key`），这里不写第二份比较口径。
        const searchArgs = {
          query,
          workspacePath: wantScope === 'workspace' ? wsRoot : undefined,
          sessionId: wantScope === 'session' ? ctx.sessionId || undefined : undefined,
          limit,
          snippetChars: sessionLimits.sessionRecallSnippetChars
        };
        const messages = await gateway.invokeRpc('memory.messages_search', searchArgs);
        let folded = null;
        if (a.folded) {
          folded = await gateway.invokeRpc('memory.compaction_folded', {
            ...searchArgs,
            limit: Math.min(limit, sessionLimits.sessionRecallFoldedLimit),
            snippetChars: sessionLimits.sessionRecallSnippetChars * 3
          });
        }
        const msgRows = Array.isArray(messages && messages.results) ? messages.results : [];
        const foldedRows = Array.isArray(folded && folded.results) ? folded.results : [];
        if (!msgRows.length && !foldedRows.length) {
          return {
            ok: true,
            total: 0,
            results: [],
            note: '没找到匹配的既往对话（也可能那段对话在别的工作空间里，或关键词太具体）'
          };
        }
        return {
          ok: true,
          mode: (messages && messages.mode) || 'none',
          total: msgRows.length + foldedRows.length,
          results: [
            ...msgRows.map((r) => ({
              kind: 'message',
              sessionId: r.sessionId || null,
              title: r.title || null,
              role: r.role || '',
              createdAt: r.createdAt || 0,
              snippet: String(r.snippet || '')
            })),
            ...foldedRows.map((r) => ({
              kind: 'folded',
              sessionId: r.sessionId || null,
              createdAt: r.createdAt || 0,
              chars: r.chars || 0,
              snippet: String(r.snippet || '')
            }))
          ],
          note:
            'kind=message 是账本里的原话摘录；kind=folded 是被压缩摘要吞掉的原文片段。' +
            '两者都只是摘录，需要完整上下文就带上 sessionId 问用户是否要继续那次会话'
        };
    },
    memory_recall: async (a, ctx) => {
        if (!gateway) return { error: 'Gateway 未就绪', errorCode: 'GATEWAY_UNAVAILABLE' };
        const query = String(a.query || '').trim();
        if (!query) return { error: 'query 必填' };
        const recallLimits = getAgentLimits(userDataPath, ctx.contextTierId);
        const wantScope = String(a.scope || 'all');
        const limit = Math.min(12, Math.max(1, Number(a.limit) || recallLimits.memoryToolRecallLimit));
        const wsRoot = ctx.workspacePath || ctx.worktreePath || '';
        const collected = [];
        const take = (res, tag) => {
          const rows = res && Array.isArray(res.results) ? res.results : [];
          for (const r of rows) collected.push({ ...r, memoryScope: tag });
        };
        if (wantScope !== 'global' && wsRoot) {
          // 项目记忆的真相是文件 `<workspace>/.dieyun/memory.md`：这里按关键词过滤文件条目
          // 就够了（≤200 条、最新在前），不必为此维护一套项目向量索引。
          try {
            const fr = await gateway.invokeRpc('fs.read_file', {
              filePath: PROJECT_MEMORY_REL_PATH,
              maxBytes: 96000,
              runWorkspaceRoot: wsRoot
            });
            const text = fr && fr.encoding === 'base64' ? '' : String((fr && fr.data) || '');
            const tokens = String(query)
              .toLowerCase()
              .split(/[\s,，、;；/\\]+/)
              .filter((t) => t.length >= 2);
            for (const entry of parseProjectMemoryEntries(text)) {
              const hay = entry.toLowerCase();
              if (tokens.length && !tokens.some((t) => hay.includes(t))) continue;
              collected.push({ memoryScope: 'project', source: PROJECT_MEMORY_REL_PATH, content: entry });
            }
          } catch {
            // 没有文件 = 这个项目还没有沉淀，不是错误
          }
        }
        if (wantScope !== 'project') {
          take(await gateway.invokeRpc('memory.long_recall', { query, scope: 'global', limit }), 'global');
        }
        const seen = new Set();
        const rows = collected
          .filter((r) => r && (r.source === PROJECT_MEMORY_REL_PATH || Number.isFinite(Number(r.id))))
          .filter((r) => {
            const key = r.source === PROJECT_MEMORY_REL_PATH ? `md:${String(r.content || '').slice(0, 80)}` : `id:${Number(r.id)}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
          })
          // 文件条目没有相似度分数：项目记忆在前（它就是本项目的「硬约定」），DB 结果按分数排
          .sort((x, y) => {
            const fx = x.source === PROJECT_MEMORY_REL_PATH ? 1 : 0;
            const fy = y.source === PROJECT_MEMORY_REL_PATH ? 1 : 0;
            if (fx !== fy) return fy - fx;
            return (Number(y.score) || 0) - (Number(x.score) || 0);
          })
          .slice(0, limit);
        if (!rows.length) {
          return {
            ok: true,
            total: 0,
            results: [],
            note: '没找到相关记忆（可能确实没记过，或换个更具体的说法再试）'
          };
        }
        return {
          ok: true,
          total: rows.length,
          results: rows.map((r) =>
            r.source === PROJECT_MEMORY_REL_PATH
              ? {
                  scope: 'project',
                  source: PROJECT_MEMORY_REL_PATH,
                  content: String(r.content || '').slice(0, 400)
                }
              : {
                  id: Number(r.id),
                  scope: r.memoryScope,
                  kind: r.kind || 'normal',
                  importance: r.importance,
                  score: Number(r.score) || 0,
                  content: String(r.content || '').slice(0, 400)
                }
          ),
          note:
            'source=.dieyun/memory.md 的条目没有 id：它们就是文件里的一行，改/删请直接编辑文件；' +
            '其余带 id 的条目可在用户说记错时交给 memory_forget 归档'
        };
    },
    memory_forget: async (a, ctx) => {
        if (!gateway) return { error: 'Gateway 未就绪', errorCode: 'GATEWAY_UNAVAILABLE' };
        const forgetLimits = getAgentLimits(userDataPath, ctx.contextTierId);
        const ids = (Array.isArray(a.memoryIds) ? a.memoryIds : [a.memoryId])
          .map((n) => Number(n))
          .filter((n) => Number.isFinite(n) && n > 0)
          .slice(0, forgetLimits.memoryToolForgetMaxIds);
        if (!ids.length) return { error: 'memoryIds 必填（来自 memory_recall 的结果）' };
        const archived = [];
        for (const id of ids) {
          try {
            await gateway.invokeRpc('memory.long_status_set', { memoryId: id, status: 'archived' });
            archived.push(id);
          } catch {
            // 单条失败不影响其余（id 不存在就是 0 影响）
          }
        }
        if (a.reason) {
          console.log(`[dieyun:memory] forget ${archived.join(',')} · ${String(a.reason).slice(0, 200)}`);
        }
        return {
          ok: archived.length > 0,
          archived,
          requested: ids.length,
          note: archived.length
            ? '已软归档（可恢复）：不再参与注入与召回'
            : '没有可归档的条目（id 可能不存在或已归档）'
        };
    }
  };
}

module.exports = { createMemoryHandlers };

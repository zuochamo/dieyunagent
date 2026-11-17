'use strict';

/**
 * 无 Renderer 跑一轮时的压缩回调（唯一实现）。
 *
 * 定时计划与频道都要把「上下文超预算」交给 `compactionAgent`（进程级单例，内部持会话摘要
 * 与冷却状态，**不能每轮新建**），并在压缩发生后把归档 id 回填给请求快照。
 *
 * @param {{
 *   compactionAgent: any,
 *   gateway: any,
 *   userData: string,
 *   sessionId: string,
 *   workspacePath?: string,
 *   tokenBudget: number,
 *   contextTierId: string,
 *   model: string,
 *   archiveTimeoutMs?: number
 * }} opts
 * @returns {((msgs: any[], compactCtx?: object) => Promise<any>) | null} 未配置压缩时返回 null
 */
function buildLoopCompactionHandler(opts) {
  const {
    compactionAgent,
    gateway,
    sessionId,
    workspacePath,
    tokenBudget,
    contextTierId,
    model
  } = opts;
  if (!compactionAgent || typeof compactionAgent.maybeCompactMessages !== 'function') return null;
  const archiveTimeoutMs = Number(opts.archiveTimeoutMs) || 2000;

  /**
   * 折叠已由 core 做完，这里只补「归档行」（Node 才知道 sessionId / workspace）。
   * 返回归档行 id；写不成就 null（快照宁可空着也不编 id）。
   */
  async function archiveFold(fact) {
    if (!fact || !fact.level) return null;
    try {
      const archived = await gateway.invokeRpc(
        'memory.compaction_archive',
        {
          sessionId,
          workspacePath: workspacePath || null,
          tokensBefore: fact.tokensBefore,
          tokensAfter: fact.tokensAfter,
          summary: `折叠：${Number(fact.tokensBefore) || 0} → ${Number(fact.tokensAfter) || 0} token（L${fact.level}）`,
          foldedTranscript: null
        },
        { timeoutMs: archiveTimeoutMs }
      );
      return archived && archived.id != null ? archived.id : null;
    } catch {
      return null;
    }
  }

  return Object.assign(async function compactMessages(msgs, compactCtx) {
    const cr = await compactionAgent.maybeCompactMessages(msgs, {
      tokenBudget,
      contextTierId,
      model,
      sessionId,
      toolsChars: compactCtx && compactCtx.toolsChars,
      // 触发口径：上一轮服务端 usage 优先（没有就由 Rust 回落到字符比估值）
      observedPromptTokens: compactCtx && compactCtx.observedPromptTokens,
      force: !!(compactCtx && compactCtx.force),
      signal: compactCtx && compactCtx.signal
    });
    if (cr && cr.compacted) {
      // 归档 id 回填给请求快照（旁路记录，失败就让快照留 null）。
      // 短超时：它在发请求之前 await，不能按默认上限一直等着。
      try {
        const archived = await gateway.invokeRpc(
          'memory.compaction_archive',
          {
            sessionId,
            workspacePath: workspacePath || null,
            tokensBefore: cr.tokensBefore,
            tokensAfter: cr.tokensAfter,
            // 折叠不再产出摘要文本（旧 LLM 摘要已删除）：归档行只记「何时、省了多少」，
            // 内容本身仍在 messages 里（只是被截短），不需要另一份副本。
            summary:
              cr.level != null
                ? `折叠：${Number(cr.tokensBefore) || 0} → ${Number(cr.tokensAfter) || 0} token（L${cr.level}）`
                : null,
            foldedTranscript: null
          },
          { timeoutMs: archiveTimeoutMs }
        );
        if (archived && archived.id != null) cr.compactionArchiveId = archived.id;
      } catch {
        // 归档失败不改变压缩结论
      }
    }
    return cr;
  }, { archiveFold });
}

module.exports = { buildLoopCompactionHandler };

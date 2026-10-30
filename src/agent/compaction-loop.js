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
 *   apiConfig: object,
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
    apiConfig,
    model
  } = opts;
  if (!compactionAgent || typeof compactionAgent.maybeCompactMessages !== 'function') return null;
  const archiveTimeoutMs = Number(opts.archiveTimeoutMs) || 2000;

  return async function compactMessages(msgs, compactCtx) {
    const cr = await compactionAgent.maybeCompactMessages(msgs, {
      tokenBudget,
      contextTierId,
      apiConfig: { ...apiConfig, model },
      model,
      sessionId,
      toolsChars: compactCtx && compactCtx.toolsChars
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
            summary: cr.summary || null,
            foldedTranscript: cr.foldedTranscript || null
          },
          { timeoutMs: archiveTimeoutMs }
        );
        if (archived && archived.id != null) cr.compactionArchiveId = archived.id;
      } catch {
        // 归档失败不改变压缩结论
      }
    }
    return cr;
  };
}

module.exports = { buildLoopCompactionHandler };

'use strict';

function isRemoteAgentHealableError(err) {
  const code = String((err && err.code) || '');
  if (code === 'REMOTE_INDEX_CORE_MISSING') return false;
  // core 拉不起来时重连 SSH 只会杀掉正在启动的进程
  if (code === 'REMOTE_INDEX_UNAVAILABLE') return false;
  if (code === 'REMOTE_AGENT_UNAVAILABLE' || code === 'REMOTE_GATEWAY_FAILED') {
    return true;
  }
  const msg = String((err && err.message) || err || '');
  return /连接已关闭|已断开|未就绪|隧道未就绪|websocket|无响应|remote agent/i.test(msg);
}

/**
 * @param {{
 *   syncRemoteIndexCoreConfig: () => Promise<unknown>,
 *   waitRemoteIndexCoreReady: (ctxInfo: object, opts?: object) => Promise<unknown>,
 *   resolveCodebaseContext: (workspaceRoot?: string) => object,
 *   healRemoteAgentTransport?: (opts?: object) => Promise<object>,
 *   REMOTE_INDEX_PREP_TIMEOUT_MS?: number
 * }} deps
 */
function createIndexRemoteHandlers({
  syncRemoteIndexCoreConfig,
  waitRemoteIndexCoreReady,
  resolveCodebaseContext,
  healRemoteAgentTransport,
  REMOTE_INDEX_PREP_TIMEOUT_MS = 45000
}) {
  return {
    'index.remote_sync_configure': async () => syncRemoteIndexCoreConfig(),

    /**
     * 发消息前等待远程 dieyun-core：轮询 + 周期性 index.configure 重试拉起。
     * 若链路断开（SSH/隧道/WS），先分层自愈一次再重试，避免闲置断链直接失败。
     */
    'index.remote_wait_ready': async ({ workspaceRoot, timeoutMs, maxConfigureRetries } = {}) => {
      const ctxInfo = resolveCodebaseContext(workspaceRoot);
      if (!ctxInfo || ctxInfo.kind !== 'remote') {
        return { ok: true, skipped: true, reason: 'local_workspace' };
      }
      const waitOpts = {
        timeoutMs:
          timeoutMs != null && Number(timeoutMs) > 0 ? Number(timeoutMs) : REMOTE_INDEX_PREP_TIMEOUT_MS,
        maxConfigureRetries:
          maxConfigureRetries != null && Number(maxConfigureRetries) >= 0
            ? Number(maxConfigureRetries)
            : 3
      };

      const toOk = (ping, extra = {}) => ({
        ok: true,
        hasCore: !!(ping && ping.hasCore),
        workspaceRoot: ctxInfo.remotePath || ctxInfo.rootKey,
        indexDbPath: ping && ping.indexDbPath ? ping.indexDbPath : undefined,
        ...extra
      });

      try {
        const ping = await waitRemoteIndexCoreReady(ctxInfo, waitOpts);
        return toOk(ping);
      } catch (err) {
        const firstError = err && err.message ? err.message : String(err);
        const firstCode = (err && err.code) || 'REMOTE_INDEX_UNAVAILABLE';
        if (
          !isRemoteAgentHealableError(err) ||
          typeof healRemoteAgentTransport !== 'function'
        ) {
          return { ok: false, code: firstCode, error: firstError };
        }

        let heal = null;
        try {
          heal = await healRemoteAgentTransport({ reason: 'prep_wait_ready' });
        } catch (healErr) {
          return {
            ok: false,
            code: firstCode,
            error: firstError,
            healAttempted: true,
            heal: {
              ok: false,
              error: healErr && healErr.message ? healErr.message : String(healErr)
            }
          };
        }

        if (!heal || !heal.ok) {
          return {
            ok: false,
            code: firstCode,
            error: firstError,
            healAttempted: true,
            heal: heal || { ok: false, reason: 'heal_returned_empty' }
          };
        }

        try {
          const ping = await waitRemoteIndexCoreReady(ctxInfo, {
            ...waitOpts,
            // 自愈后只需确认就绪，缩短二次等待
            timeoutMs: Math.min(Number(waitOpts.timeoutMs) || 45000, 25000),
            maxConfigureRetries: Math.min(Number(waitOpts.maxConfigureRetries) || 3, 2)
          });
          return toOk(ping, { healed: true, heal });
        } catch (err2) {
          return {
            ok: false,
            code: (err2 && err2.code) || 'REMOTE_INDEX_UNAVAILABLE',
            error: err2 && err2.message ? err2.message : String(err2),
            healAttempted: true,
            healed: false,
            heal
          };
        }
      }
    }
  };
}

module.exports = { createIndexRemoteHandlers, isRemoteAgentHealableError };

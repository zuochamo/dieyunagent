'use strict';

/**
 * @param {import('../context').MainIpcContext & {
 *   getLocalGateway: () => import('../gateway/server').LocalGateway | null,
 *   getBrowserService: () => object | null,
 *   getMobileBridge: () => object | null,
 *   getCoreBridge: () => object | null,
 *   getActiveRemoteGatewayWireInfo: () => object | null,
 *   resolveDieyunCoreBinary: () => string,
 *   QRCode: { toDataURL: (url: string, opts: object) => Promise<string> },
 *   log: { warn: (msg: string, ...args: unknown[]) => void }
 * }} ctx
 */
function registerGatewayShellIpc(ctx) {
  const {
    ipcMain,
    getLocalGateway,
    getBrowserService,
    getMobileBridge,
    getCoreBridge,
    getActiveRemoteGatewayWireInfo,
    resolveDieyunCoreBinary,
    getMainWindow,
    QRCode,
    log
  } = ctx;

  ipcMain.handle('gateway:get-info', () => {
    attachGatewayEventRelay();
    const localGateway = getLocalGateway();
    const local = localGateway ? localGateway.getInfo() : null;
    // IPC 只能返回 structured-clone 友好的数据：`getInfo()` 带 openChannel（函数），
    // 原样塞进 reply 会让整个 `gateway:get-info` 抛 `An object could not be cloned`。
    const remote =
      typeof getActiveRemoteGatewayWireInfo === 'function' ? getActiveRemoteGatewayWireInfo() : null;
    const coreBridge = getCoreBridge();
    const rust = !!(coreBridge && coreBridge.isReady());
    const rustCore = {
      enabled: rust,
      agentLoop: rust,
      planner: rust,
      binary: resolveDieyunCoreBinary()
    };
    if (!local) {
      return remote ? { ...remote, rustCore } : { rustCore };
    }
    return { ...local, local, remote, rustCore };
  });

  /**
   * 本地 Gateway 的 RPC 通道（Renderer 的唯一入口）。
   *
   * 为什么是 IPC 而不是 WebSocket：本地 Gateway 默认监听私有 socket / 命名管道
   * （`src/gateway/local-endpoint.js`），Chromium 连不了；而 Renderer 与 Gateway 本来
   * 就同进程两个模块，再绕一圈本机端口纯属给「端口冲突 / 防火墙 / token 文件」开门。
   *
   * 返回 `{ ok, data }` / `{ ok:false, error }` 而不是抛异常：IPC 抛出去的 Error 会丢掉
   * code / retryable / suggestedFix，而工具失败契约靠它们分流。
   */
  ipcMain.handle('gateway:rpc', async (_evt, req) => {
    attachGatewayEventRelay();
    const gateway = getLocalGateway();
    const method = req && req.method ? String(req.method) : '';
    if (!gateway || typeof gateway.invokeRpc !== 'function') {
      return { ok: false, error: { code: 'GATEWAY_UNAVAILABLE', message: '本地 Gateway 未启动' } };
    }
    if (!method) {
      return { ok: false, error: { code: 'BAD_METHOD', message: 'method 不能为空' } };
    }
    const params = req.params && typeof req.params === 'object' ? req.params : {};
    const timeoutMs = Number(req.timeoutMs) > 0 ? Number(req.timeoutMs) : undefined;
    try {
      const data = await gateway.invokeRpc(method, params, { timeoutMs });
      return { ok: true, data };
    } catch (err) {
      return {
        ok: false,
        error: {
          code: (err && err.code) || 'EXEC_ERROR',
          message: (err && err.message) || String(err),
          ...(err && typeof err.retryable === 'boolean' ? { retryable: err.retryable } : {}),
          ...(err && err.suggestedFix ? { suggestedFix: String(err.suggestedFix) } : {})
        }
      };
    }
  });

  /**
   * Gateway 事件 → Renderer。事件出口只有一个（`LocalGateway#_publishEvent`），
   * 这里只负责「进这个进程的界面」。窗口关掉/销毁时静默跳过。
   *
   * 懒挂载：IPC 注册时 Gateway 可能还没建好（`getLocalGateway()` 先返回 null），
   * 所以每次取用 Gateway 的地方都调一次，真正挂上后不再重复。
   */
  let eventRelayAttached = false;
  const attachGatewayEventRelay = () => {
    if (eventRelayAttached) return;
    const gateway = getLocalGateway();
    if (!gateway || typeof gateway.onEvent !== 'function') return;
    eventRelayAttached = true;
    gateway.onEvent((payload) => {
      if (typeof getMainWindow !== 'function') return;
      const win = getMainWindow();
      if (!win || win.isDestroyed() || !win.webContents) return;
      win.webContents.send('gateway:event', payload);
    });
  };
  attachGatewayEventRelay();

  ipcMain.handle('mobile:get-info', async () => {
    const mobileBridge = getMobileBridge();
    if (!mobileBridge) return null;
    const info = mobileBridge.getInfo();
    const url = info.urls && info.urls.length ? info.urls[0] : '';
    let qrDataUrl = '';
    if (url) {
      try {
        // 320：面板里按 ~288 显示，生成得比显示大一点才是清晰缩小（240 会被放大发虚）
        qrDataUrl = await QRCode.toDataURL(url, {
          margin: 1,
          width: 320,
          errorCorrectionLevel: 'M',
          color: {
            dark: '#111111',
            light: '#ffffff'
          }
        });
      } catch (e) {
        log.warn('生成手机连接二维码失败:', e && e.message);
      }
    }
    return { ...info, primaryUrl: url, qrDataUrl };
  });

  ipcMain.handle('permissions:get', () => {
    const localGateway = getLocalGateway();
    if (!localGateway) return null;
    return localGateway.getPermissions();
  });

  ipcMain.handle('permissions:set', (_evt, perms) => {
    const localGateway = getLocalGateway();
    if (!localGateway) return null;
    return localGateway.setPermissions(perms || {});
  });

  ipcMain.handle('browser:set-panel-state', (_evt, state) => {
    const browserService = getBrowserService();
    if (!browserService) return { ok: false, error: 'browser_unavailable' };
    return browserService.setPanelState(state || {});
  });

  ipcMain.handle('browser:get-status', () => {
    const browserService = getBrowserService();
    if (!browserService) return null;
    return browserService.status();
  });

  ipcMain.handle('browser:set-active-session', (_evt, { sessionId } = {}) => {
    const browserService = getBrowserService();
    if (!browserService || typeof browserService.setActiveViewSessionId !== 'function') {
      return { ok: false };
    }
    browserService.setActiveViewSessionId(sessionId || null);
    return { ok: true };
  });
}

module.exports = { registerGatewayShellIpc };

'use strict';

/**
 * @param {import('../context').MainIpcContext & {
 *   getLocalGateway: () => import('../gateway/server').LocalGateway | null,
 *   getBrowserService: () => object | null,
 *   getMobileBridge: () => object | null,
 *   getCoreBridge: () => object | null,
 *   getActiveRemoteGatewayInfo: () => object | null,
 *   getDeployUiDefaults: () => object,
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
    getActiveRemoteGatewayInfo,
    getDeployUiDefaults,
    resolveDieyunCoreBinary,
    QRCode,
    log
  } = ctx;

  ipcMain.handle('gateway:get-info', () => {
    const localGateway = getLocalGateway();
    const local = localGateway ? localGateway.getInfo() : null;
    const remote = getActiveRemoteGatewayInfo();
    const coreBridge = getCoreBridge();
    const rust = !!(coreBridge && coreBridge.isReady());
    const rustCore = {
      enabled: rust,
      agentLoop: rust,
      planner: rust,
      binary: resolveDieyunCoreBinary()
    };
    if (!local) {
      return remote
        ? { ...remote, rustCore, deployUiDefaults: getDeployUiDefaults() }
        : { rustCore, deployUiDefaults: getDeployUiDefaults() };
    }
    return { ...local, local, remote, rustCore, deployUiDefaults: getDeployUiDefaults() };
  });

  ipcMain.handle('mobile:get-info', async () => {
    const mobileBridge = getMobileBridge();
    if (!mobileBridge) return null;
    const info = mobileBridge.getInfo();
    const url = info.urls && info.urls.length ? info.urls[0] : '';
    let qrDataUrl = '';
    if (url) {
      try {
        qrDataUrl = await QRCode.toDataURL(url, {
          margin: 1,
          width: 240,
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

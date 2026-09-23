/* global window, DieyunBootstrap, DieyunApp, setGatewayMeta, startRendererFreezeWatch */
'use strict';

function initRendererApp() {
  const boot = window.DieyunBootstrap;
  if (!boot || typeof boot.run !== 'function') {
    throw new Error('[renderer] DieyunBootstrap missing — load core/bootstrap.js and core/domain-bootstrap.js');
  }

  boot.run([
    'DieyunChat',
    'DieyunSettings',
    'DieyunWorkspace',
    'DieyunComposer',
    'DieyunAgent'
  ]);

  // 冻结取证（问题 B / B1）：先于 runStartup 启动，覆盖首屏渲染期的长任务
  if (typeof startRendererFreezeWatch === 'function') startRendererFreezeWatch();

  boot.runStartup().catch((err) => {
    console.warn(err);
    if (typeof setGatewayMeta === 'function') {
      setGatewayMeta(`未连接 (${err.message || err})`);
    }
  });
}

if (window.DieyunApp) {
  window.DieyunApp.initRendererApp = initRendererApp;
}
window.initRendererApp = initRendererApp;

initRendererApp();

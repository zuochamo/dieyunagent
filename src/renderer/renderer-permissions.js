/* global $, initAgentsMdSettingsUI, initDieyunMdSettingsUI, initPlaybookSettingsUI, initAgentKnowledgeSettingsUI, initKnowledgeConsolidationSettingsUI, gatewayCall, gwState, invalidateLspSettingsCache */

'use strict';



const permissionsApi = window.diecloud || {};



function setPermsHint(text) {

  const el = $('perms-hint');

  if (!el) return;

  el.textContent = text || '';

  if (text) {

    el.classList.add('show');

    setTimeout(() => el.classList.remove('show'), 2000);

  }

}



async function syncPermissionsToMain() {

  if (!permissionsApi.setPermissions) return;

  const perms = {

    hostControl: $('perm-host-control')?.checked !== false,

    fsRead: $('perm-fs-read')?.checked !== false,

    fsWrite: $('perm-fs-write')?.checked !== false,

    shellExec: $('perm-shell-exec')?.checked !== false,

    sqlRead: $('perm-sql-read')?.checked !== false,

    webFetch: $('perm-web-fetch')?.checked !== false,

    browserAutomation: $('perm-browser')?.checked !== false

  };

  try {

    await permissionsApi.setPermissions(perms);

    setPermsHint('权限已保存 ✓');

  } catch (err) {

    setPermsHint(`保存失败：${err.message || err}`);

  }

}



async function syncWorkplaceMonitorToMain() {

  if (!permissionsApi.setWorkplaceMonitor) return;

  const enabled = $('perm-workplace-monitor')?.checked !== false;

  try {

    await permissionsApi.setWorkplaceMonitor({ enabled });

    setPermsHint(enabled ? '工位监控已开启 ✓' : '工位监控已关闭 ✓');

  } catch (err) {

    setPermsHint(`保存失败：${err.message || err}`);

  }

}



async function syncLspDiagnosticsToMain() {

  if (!gwState.authed) return;

  const enabled = $('perm-lsp-diagnostics')?.checked !== false;

  try {

    await gatewayCall('lsp.settings_set', { enabled });

    if (typeof invalidateLspSettingsCache === 'function') invalidateLspSettingsCache();

    setPermsHint(enabled ? 'LSP 诊断已开启 ✓' : 'LSP 诊断已关闭 ✓');

  } catch (err) {

    setPermsHint(`保存失败：${err.message || err}`);

  }

}



async function loadPermissionsUI() {

  if (!permissionsApi.getPermissions) return;

  try {

    const p = await permissionsApi.getPermissions();

    if (!p) return;

    if ($('perm-host-control')) $('perm-host-control').checked = !!p.hostControl;

    if ($('perm-fs-read')) $('perm-fs-read').checked = !!p.fsRead;

    if ($('perm-fs-write')) $('perm-fs-write').checked = !!p.fsWrite;

    if ($('perm-shell-exec')) $('perm-shell-exec').checked = !!p.shellExec;

    if ($('perm-sql-read')) $('perm-sql-read').checked = p.sqlRead !== false;

    if ($('perm-web-fetch')) $('perm-web-fetch').checked = p.webFetch !== false;

    if ($('perm-browser')) $('perm-browser').checked = p.browserAutomation !== false;

  } catch {

    // ignore

  }

  if (permissionsApi.getWorkplaceMonitor) {

    try {

      const w = await permissionsApi.getWorkplaceMonitor();

      if ($('perm-workplace-monitor')) {

        $('perm-workplace-monitor').checked = w ? w.enabled !== false : true;

      }

    } catch {

      // ignore

    }

  }

  if (gwState.authed) {

    try {

      const lsp = await gatewayCall('lsp.settings_get', {});

      if ($('perm-lsp-diagnostics') && lsp && lsp.settings) {

        $('perm-lsp-diagnostics').checked = lsp.settings.enabled !== false;

      }

    } catch {

      // ignore

    }

  }

}



function bindPermissionCheckboxes() {

  [

    'perm-host-control',

    'perm-fs-read',

    'perm-fs-write',

    'perm-shell-exec',

    'perm-sql-read',

    'perm-web-fetch',

    'perm-browser'

  ].forEach((id) => {

    const el = $(id);

    if (el) el.addEventListener('change', () => syncPermissionsToMain());

  });

  const workplace = $('perm-workplace-monitor');

  if (workplace) workplace.addEventListener('change', () => syncWorkplaceMonitorToMain());

  const lspDiag = $('perm-lsp-diagnostics');

  if (lspDiag) lspDiag.addEventListener('change', () => syncLspDiagnosticsToMain());

}





function initAgentKnowledgeSettingsUI() {
  initDieyunMdSettingsUI();
  initAgentsMdSettingsUI();
  initPlaybookSettingsUI();
  if (typeof initKnowledgeConsolidationSettingsUI === 'function') {
    initKnowledgeConsolidationSettingsUI();
  }
}



function initPermissionsUI() {

  bindPermissionCheckboxes();

  loadPermissionsUI().catch(() => {});

  initAgentKnowledgeSettingsUI();

}

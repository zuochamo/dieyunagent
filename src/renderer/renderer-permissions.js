/* global window, $, initAgentsMdSettingsUI, initDieyunMdSettingsUI, initAgentKnowledgeSettingsUI, initKnowledgeConsolidationSettingsUI, gatewayCall, gwState, invalidateLspSettingsCache, showAgentToast */

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

    // 读/写文件、Shell、SQL 只读、联网抓取、浏览器自动化为系统内置能力，恒开、UI 不提供开关；
    // 显式回写 true，纠正历史持久化里的关闭值
    fsRead: true,

    fsWrite: true,

    shellExec: true,

    sqlRead: true,

    webFetch: true,

    browserAutomation: true,

    // 默认关闭：这里必须用 === true，不能沿用上面「!== false」的默认开语义
    unrestrictedPaths: $('perm-unrestricted-paths')?.checked === true

  };

  try {

    await permissionsApi.setPermissions(perms);

    renderComposerPathPerm(perms.unrestrictedPaths === true);

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

    if ($('perm-unrestricted-paths')) $('perm-unrestricted-paths').checked = p.unrestrictedPaths === true;

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

    'perm-unrestricted-paths'

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
  if (typeof initKnowledgeConsolidationSettingsUI === 'function') {
    initKnowledgeConsolidationSettingsUI();
  }
}



function initPermissionsUI() {

  bindPermissionCheckboxes();

  loadPermissionsUI().catch(() => {});

  initAgentKnowledgeSettingsUI();

}

// ---------- 输入区「完全放开路径限制」快捷开关 ----------
// 状态唯一落盘点是 permissions.unrestrictedPaths（Gateway），设置页与输入区图标都只是它的视图：
// 这里切换后必须回写设置页 checkbox，SetPermissions 是从 checkbox 读值写盘的。
const COMPOSER_PATH_PERM_TITLES = {

  restricted: '路径权限：受白名单限制（点击完全放开）',

  unrestricted: '路径权限：已完全放开（点击恢复白名单）'

};

function renderComposerPathPerm(unrestricted) {

  const on = unrestricted === true;

  const btn = $('btn-composer-path-perm');

  if (btn) {

    btn.classList.toggle('is-unrestricted', on);

    btn.setAttribute('aria-pressed', on ? 'true' : 'false');

    btn.title = on ? COMPOSER_PATH_PERM_TITLES.unrestricted : COMPOSER_PATH_PERM_TITLES.restricted;

  }

  const box = $('perm-unrestricted-paths');

  if (box) box.checked = on;

}

async function toggleComposerPathPerm() {

  if (!permissionsApi.getPermissions || !permissionsApi.setPermissions) {

    showAgentToast('路径权限', '当前环境不支持修改权限', { variant: 'error' });

    return;

  }

  const btn = $('btn-composer-path-perm');

  if (btn) btn.disabled = true;

  try {

    const current = (await permissionsApi.getPermissions()) || {};

    const next = current.unrestrictedPaths !== true;

    if (

      next &&

      !window.confirm('完全放开路径限制：Agent 将可读写本机所有磁盘（含系统目录）。\n仅在你完全信任当前任务时开启，确定继续？')

    ) {

      return;

    }

    const saved = await permissionsApi.setPermissions({ ...current, unrestrictedPaths: next });

    const on = saved ? saved.unrestrictedPaths === true : next;

    renderComposerPathPerm(on);

    showAgentToast(

      '路径权限',

      on ? '已完全放开：可访问本机所有路径' : '已恢复白名单限制',

      { variant: on ? 'warn' : 'success' }

    );

  } catch (err) {

    showAgentToast('路径权限', `保存失败：${err?.message || err}`, { variant: 'error' });

  } finally {

    if (btn) btn.disabled = false;

  }

}

function initComposerPathPerm() {

  const btn = $('btn-composer-path-perm');

  if (!btn) return;

  renderComposerPathPerm(false);

  btn.addEventListener('click', () => {

    void toggleComposerPathPerm();

  });

  if (!permissionsApi.getPermissions) return;

  permissionsApi.getPermissions()

    .then((p) => renderComposerPathPerm(p?.unrestrictedPaths === true))

    .catch(() => {});

}

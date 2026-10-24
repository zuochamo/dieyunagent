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

    // 读/写文件、Shell、联网抓取、浏览器自动化为系统内置能力，恒开、UI 不提供开关；
    // 显式回写 true，纠正历史持久化里的关闭值
    fsRead: true,

    fsWrite: true,

    shellExec: true,

    webFetch: true,

    browserAutomation: true,

    // 沙箱档位是文件/命令越界的唯一旋钮；「完全放开路径限制」开关是它的派生视图
    // （勾上 = danger-full-access）。两者在 UI 里互相同步，落盘只认 sandboxMode。
    sandboxMode: $('perm-unrestricted-paths')?.checked === true
      ? 'danger-full-access'
      : $('perm-sandbox-mode')?.value || 'workspace-write',

    unrestrictedPaths: $('perm-unrestricted-paths')?.checked === true

  };

  try {

    await permissionsApi.setPermissions(perms);

    renderComposerPathPerm(perms.unrestrictedPaths === true);

    // 落盘后把下拉/复选框/hint 拉回服务端的最终值（normalizePermissions 可能会改判）
    renderSandboxModeUI(perms.sandboxMode, perms.unrestrictedPaths === true);

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

    renderSandboxModeUI(p.sandboxMode, p.unrestrictedPaths === true);

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

    // 关掉时必须同时把档位收回：`unrestrictedPaths: false` 只是派生视图，
    // 单靠它不会改变已存下的 danger-full-access（否则点一下开关像没反应）。
    // 收回的是「上一次的非放开档位」，不是无条件的 workspace-write —— 否则用户的 read-only 会被悄悄放宽。
    const saved = await permissionsApi.setPermissions({
      ...current,
      unrestrictedPaths: next,
      sandboxMode: next ? 'danger-full-access' : rememberNonDangerMode(current.sandboxMode)
    });

    const on = saved ? saved.unrestrictedPaths === true : next;

    renderComposerPathPerm(on);

    renderSandboxModeUI(saved?.sandboxMode, on);

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

    .then((p) => {

      renderComposerPathPerm(p?.unrestrictedPaths === true);

      // 图标与设置页下拉是同一个旋钮的两个视图：启动时对齐一次，别留两份答案
      renderSandboxModeUI(p?.sandboxMode, p?.unrestrictedPaths === true);

    })

    .catch(() => {});

}

const SANDBOX_MODE_HINT = {

  'read-only': '只看不改：写文件、已知会改文件的命令都会先弹一次确认（脚本内部的写盘无法逐条判断）。',

  'workspace-write': '工作区内随便改；写工作区之外、装到系统目录这类动作会先弹一次确认。',

  'danger-full-access': '整盘可写可跑，不再询问。只在你完全信任当前任务时使用。'

};

/**

 * 档位下拉与「完全放开路径限制」开关是同一件事的两种表达：始终互相同步，

 * 落盘只认 sandboxMode（Gateway `permissions-store.normalizePermissions` 负责折算）。

 */

/** 最近一次「非完全放开」档位：从 danger 退回时用它还原，避免把 read-only 悄悄变成 workspace-write。 */
let lastNonDangerMode = 'workspace-write';

function rememberNonDangerMode(mode) {
  const v = String(mode || '').trim();
  if (v === 'read-only' || v === 'workspace-write') lastNonDangerMode = v;
  return lastNonDangerMode;
}

function renderSandboxModeUI(mode, dangerToggle) {

  const select = $('perm-sandbox-mode');

  const checkbox = $('perm-unrestricted-paths');

  const value = dangerToggle === true ? 'danger-full-access' : mode || 'workspace-write';

  if (select) select.value = value;

  if (checkbox) checkbox.checked = value === 'danger-full-access';

  rememberNonDangerMode(value);

  const hint = $('perm-sandbox-hint');

  if (hint) hint.textContent = SANDBOX_MODE_HINT[value] || '';

}

function initSandboxModeControls() {

  const select = $('perm-sandbox-mode');

  const checkbox = $('perm-unrestricted-paths');

  if (select) {

    select.addEventListener('change', () => {

      if (checkbox) checkbox.checked = select.value === 'danger-full-access';

      const hint = $('perm-sandbox-hint');

      if (hint) hint.textContent = SANDBOX_MODE_HINT[select.value] || '';

      // 档位是唯一旋钮：选完必须落盘，否则「只读」只是界面上好看（重开设置就被改回旧值）
      void syncPermissionsToMain();

    });

  }

  if (checkbox) {

    checkbox.addEventListener('change', () => {

      // 勾上 = 完全放开；取消 = 回到上一次的非放开档（不能停在 danger，也不能硬写 workspace-write）
      renderSandboxModeUI(checkbox.checked ? 'danger-full-access' : rememberNonDangerMode(), checkbox.checked);

    });

  }

}

if (typeof document !== 'undefined') {

  if (document.readyState === 'loading') {

    document.addEventListener('DOMContentLoaded', initSandboxModeControls, { once: true });

  } else {

    initSandboxModeControls();

  }

}
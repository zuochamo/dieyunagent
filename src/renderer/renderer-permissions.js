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

    // 电脑控制（computer 工具：截屏 + 鼠标键盘）：默认开（与 gateway `permissions-store` 的默认一致），
    // 关掉即整个 computer 工具不再注入；键鼠动作仍由沙箱档位判 ask-once
    osControl: $('perm-os-control')?.checked !== false,

    // 手机摄像头（camera_look）：默认关（拍的是现实世界），勾了才注入工具；
    // 这里用 `=== true` 而非 `!== false`，缺省复选框时也不会把默认关的东西打开
    camera: $('perm-camera')?.checked === true,

    // 读/写文件、Shell、联网抓取、浏览器自动化为系统内置能力，恒开、UI 不提供开关；
    // 显式回写 true，纠正历史持久化里的关闭值
    fsRead: true,

    fsWrite: true,

    shellExec: true,

    webFetch: true,

    browserAutomation: true,

    // 沙箱档位是文件/命令/电脑控制越界的唯一旋钮；设置页只认分段点选，
    // 「完全放开路径限制」的快捷入口在输入区图标（toggleComposerPathPerm），
    // 它切换后会把点选组一起拉齐 —— 两处是同一旋钮的两个视图，落盘只认 sandboxMode。
    // unrestrictedPaths 不从这里发：Gateway normalizePermissions 会按 sandboxMode 派生。
    sandboxMode: getSelectedSandboxMode() || 'workspace-write'

  };

  try {

    // 落盘后一律以**服务端归一结果**为准：本地 perms 里没有 unrestrictedPaths（派生视图，
    // 见上方注释），拿本地值渲染会让输入区图标在「完全放开」下跳回「受限制」。
    const saved = await permissionsApi.setPermissions(perms);

    const unrestricted = saved ? saved.unrestrictedPaths === true : perms.sandboxMode === 'danger-full-access';

    renderComposerPathPerm(unrestricted);

    renderSandboxModeUI(saved?.sandboxMode, unrestricted);

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

    if ($('perm-os-control')) $('perm-os-control').checked = p.osControl !== false;

    if ($('perm-camera')) $('perm-camera').checked = p.camera === true;

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

    'perm-os-control',

    'perm-camera'

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
// 状态唯一落盘点是 permissions.sandboxMode（Gateway），设置页下拉与输入区图标都只是它的视图：
// 这里切换后必须把设置页下拉一起拉齐（renderSandboxModeUI），否则两处视图会对不上。
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

const SANDBOX_MODE_TABS_ID = 'perm-sandbox-mode';

function getSelectedSandboxMode() {
  const group = $(SANDBOX_MODE_TABS_ID);
  return group?.querySelector('.sandbox-mode-tab.active')?.dataset.mode || null;
}

function setSelectedSandboxMode(value) {
  const group = $(SANDBOX_MODE_TABS_ID);
  if (!group) return;
  group.querySelectorAll('.sandbox-mode-tab').forEach((btn) => {
    const active = btn.dataset.mode === value;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-checked', active ? 'true' : 'false');
  });
}

/**

 * 档位点选组与输入区「完全放开路径限制」图标是同一件事的两种表达：始终互相同步，

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

  const value = dangerToggle === true ? 'danger-full-access' : mode || 'workspace-write';

  setSelectedSandboxMode(value);

  rememberNonDangerMode(value);

}

function initSandboxModeControls() {

  document.querySelectorAll(`#${SANDBOX_MODE_TABS_ID} .sandbox-mode-tab`).forEach((btn) => {

    btn.addEventListener('click', () => {

      if (btn.classList.contains('active')) return;

      setSelectedSandboxMode(btn.dataset.mode);

      // 档位是唯一旋钮：选完必须落盘，否则「只读」只是界面上好看（重开设置就被改回旧值）
      void syncPermissionsToMain();

    });

  });

}

if (typeof document !== 'undefined') {

  if (document.readyState === 'loading') {

    document.addEventListener('DOMContentLoaded', initSandboxModeControls, { once: true });

  } else {

    initSandboxModeControls();

  }

}
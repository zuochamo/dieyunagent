/* global window, document, $, uiText, gwState, closeConnectModal, isConnectModalOpen, openHelpModal, closeHelpModal, openSettingsSkillsPage, isHelpModalOpen, isSettingsModalOpen, isPeerTrustPromptOpen, dismissPeerTrustPrompt, setDialogMaximized, resetDialogMaximize, renderSuppliersList, matchesShortcut, renderShortcutsSettingsPage, syncShortcutLabels */
'use strict';

const panels = document.querySelectorAll('.tab-panel');
const SETTINGS_TITLE_KEYS = {
  settings: ['settings_model', '模型'],
  theme: ['settings_theme', '主题'],
  worktrees: ['settings_worktrees', 'Worktree'],
  perms: ['settings_perms', '权限'],
  sandbox: ['settings_sandbox', '沙箱'],
  'agent-knowledge': ['settings_agent_knowledge', '知识'],
  channels: ['settings_channels', '频道'],
  'shared-memory': ['settings_shared_memory', '共享记忆'],
  alive: ['settings_alive', '生命'],
  'alive-setup': ['settings_alive_setup', '设定'],
  'alive-log': ['settings_alive_log', '日志'],
  'pet-diandian': ['settings_pet_diandian', '点点'],
  shortcuts: ['settings_shortcuts', '快捷键']
};
const MODEL_TAB_TITLE_KEYS = {
  defined: ['model_defined', '定义模型'],
  embedding: ['model_embedding', '向量索引'],
  builtin: ['model_builtin', '供应商']
};
const EXECUTE_TAB_TITLES = { anchor: '锚点设置', tasks: '定时任务', api: 'API设置' };

// 设置面板里这几个页面各自绑了一个全局快捷键；键位本身在 renderer-shortcuts.js 的
// SHORTCUT_DEFS 里（基础设置 → 快捷键可改），这里只声明「按下去要做什么」。
const SETTINGS_SHORTCUT_ACTIONS = [
  ['settings.open', () => openSettingsModal('settings')],
  [
    'skills.open',
    () => {
      if (isSettingsSkillsPageOpen()) closeSettingsSkillsPage();
      else openSettingsSkillsPage();
    }
  ],
  [
    'automation.open',
    () => {
      if (isExecuteModalOpen()) closeExecuteModal();
      else openExecuteModal('anchor');
    }
  ],
  ['help.open', () => openHelpModal('usage')]
];

function titleFromMap(map, key, fallback) {
  const pair = map[key];
  return pair ? uiText(pair[0], pair[1]) : fallback;
}

function closeAllMenus() {
  document.querySelectorAll('.menu-item.open').forEach((item) => {
    item.classList.remove('open');
    const trigger = item.querySelector('.menu-trigger');
    if (trigger) trigger.setAttribute('aria-expanded', 'false');
  });
}

function setSettingsNavActive(match) {
  document.querySelectorAll('#settings-nav-model .settings-nav-item').forEach((el) => {
    el.classList.toggle('active', !!match(el));
  });
}

function isSettingsPageOpen(page) {
  const overlay = $('settings-overlay');
  if (!overlay || overlay.hidden) return false;
  const active = document.querySelector(`.settings-page[data-settings="${page}"].active`);
  return !!active;
}

function ensureSettingsSidebar() {
  const overlay = $('settings-overlay');
  if (!overlay) return;
  overlay.classList.add('settings-mode-model');
}

function openSettingsShell() {
  const overlay = $('settings-overlay');
  if (!overlay) return false;
  closeAllMenus();
  closeConnectModal();
  closeExecuteModal();
  closeHelpModal();
  overlay.hidden = false;
  setDialogMaximized('settings-overlay', 'settings-max');
  ensureSettingsSidebar();
  return true;
}

function switchSettingsPage(page, title, match) {
  if (!page) return;
  ensureSettingsSidebar();
  setSettingsNavActive(match || (() => false));
  document.querySelectorAll('.settings-page').forEach((el) => {
    el.classList.toggle('active', el.dataset.settings === page);
  });
  const titleEl = $('settings-main-title');
  if (titleEl) titleEl.textContent = title || page;
}


function closeSettingsSkillsPage() {
  if (isSettingsPageOpen('skills')) closeSettingsModal();
}

function closeExecuteModal() {
  const overlay = $('execute-overlay');
  if (overlay) overlay.hidden = true;
  resetDialogMaximize('execute-overlay', 'execute-max');
}

function isExecuteModalOpen() {
  const overlay = $('execute-overlay');
  return overlay && !overlay.hidden;
}

function switchExecuteTab(tab) {
  const executeTab = tab || 'anchor';
  document.querySelectorAll('.execute-nav-item[data-execute-tab]').forEach((el) => {
    el.classList.toggle('active', el.dataset.executeTab === executeTab);
  });
  document.querySelectorAll('.execute-page[data-execute-tab]').forEach((el) => {
    el.classList.toggle('active', el.dataset.executeTab === executeTab);
  });
  const titleEl = $('execute-main-title');
  if (titleEl) titleEl.textContent = EXECUTE_TAB_TITLES[executeTab] || executeTab;
}

function openExecuteModal(executeTab = 'anchor') {
  const overlay = $('execute-overlay');
  if (!overlay) return;
  closeAllMenus();
  closeSettingsModal();
  closeSettingsSkillsPage();
  closeHelpModal();
  overlay.hidden = false;
  switchExecuteTab(executeTab);
}

function switchSettingsTab(tab) {
  if (!tab) return;
  ensureSettingsSidebar();
  setSettingsNavActive((el) => el.dataset.settingsTab === tab);
  document.querySelectorAll('.settings-page').forEach((el) => {
    el.classList.toggle('active', el.dataset.settings === tab);
  });
  const titleEl = $('settings-main-title');
  if (titleEl) titleEl.textContent = titleFromMap(SETTINGS_TITLE_KEYS, tab, tab);
  if (tab === 'perms' || tab === 'sandbox') {
    loadPermissionsUI().catch(() => {});
  }
  if (tab === 'perms') {
    if (typeof window.syncThemeAutoLaunchToggle === 'function') {
      window.syncThemeAutoLaunchToggle();
    }
  }
  if (tab === 'worktrees' && typeof onWorktreesSettingsTabShown === 'function') {
    onWorktreesSettingsTabShown();
  }
  if (tab === 'channels' && typeof window.onChannelsSettingsTabShown === 'function') {
    window.onChannelsSettingsTabShown();
  }
  if (tab === 'shared-memory' && typeof window.onSharedMemorySettingsTabShown === 'function') {
    window.onSharedMemorySettingsTabShown();
  }
  if (tab === 'pet-diandian' && typeof window.onPetSettingsTabShown === 'function') {
    window.onPetSettingsTabShown();
  }
  // 「生命」「设定」「日志」是同一份数据的三个面（同一个 IPC、同一套渲染）：三个页签都算"这一页被打开"
  if ((tab === 'alive' || tab === 'alive-setup' || tab === 'alive-log') && typeof window.onAliveSettingsTabShown === 'function') {
    window.onAliveSettingsTabShown();
  }
  if (tab === 'shortcuts') {
    if (typeof renderShortcutsSettingsPage === 'function') renderShortcutsSettingsPage();
    if (typeof syncShortcutLabels === 'function') syncShortcutLabels();
  }
}

function openPermissionsSettingsModal() {
  const overlay = $('settings-overlay');
  if (!overlay) return;
  closeAllMenus();
  closeConnectModal();
  closeSettingsSkillsPage();
  closeExecuteModal();
  closeHelpModal();
  overlay.hidden = false;
  setDialogMaximized('settings-overlay', 'settings-max');
  ensureSettingsSidebar();
  switchSettingsTab('perms');
}

function switchModelSettingsTab(tab) {
  const modelTab = tab || 'defined';
  if (modelTab === 'graph') {
    if (typeof onGraphSettingsTabShown === 'function') onGraphSettingsTabShown();
    return;
  }
  setSettingsNavActive((el) => el.dataset.modelTab === modelTab);
  document.querySelectorAll('.settings-nav-item[data-model-tab]').forEach((el) => {
    el.classList.toggle('active', el.dataset.modelTab === modelTab);
  });
  document.querySelectorAll('.settings-model-panel').forEach((el) => {
    el.classList.toggle('active', el.dataset.modelTab === modelTab);
  });
  document.querySelectorAll('.settings-builtin-toolbar').forEach((el) => {
    el.classList.toggle('show-builtin-actions', false);
  });
  const titleEl = $('settings-main-title');
  if (titleEl) titleEl.textContent = titleFromMap(MODEL_TAB_TITLE_KEYS, modelTab, titleFromMap(MODEL_TAB_TITLE_KEYS, 'defined', '定义模型'));
  if (modelTab === 'builtin') renderSuppliersList();
}

function openModelSettingsModal(modelTab = 'defined') {
  if (modelTab === 'graph') {
    if (typeof onGraphSettingsTabShown === 'function') onGraphSettingsTabShown();
    return;
  }
  const overlay = $('settings-overlay');
  if (!overlay) return;
  closeAllMenus();
  closeConnectModal();
  closeSettingsSkillsPage();
  closeExecuteModal();
  closeHelpModal();
  overlay.hidden = false;
  setDialogMaximized('settings-overlay', 'settings-max');
  ensureSettingsSidebar();
  document.querySelectorAll('.settings-page').forEach((el) => {
    el.classList.toggle('active', el.dataset.settings === 'settings');
  });
  switchModelSettingsTab(modelTab);
}

function openSettingsModal(tab) {
  const overlay = $('settings-overlay');
  if (!overlay) return;
  closeAllMenus();
  closeConnectModal();
  closeSettingsSkillsPage();
  closeExecuteModal();
  closeHelpModal();
  if (tab === 'settings' || !tab) {
    openModelSettingsModal('defined');
    return;
  }
  if (tab === 'perms') {
    openPermissionsSettingsModal();
    return;
  }
  overlay.hidden = false;
  setDialogMaximized('settings-overlay', 'settings-max');
  ensureSettingsSidebar();
  switchSettingsTab(tab);
}

function handleMenuAction(el) {
  const menu = el.dataset.settingsAction;
  if (!menu) return;
  if (menu === 'skills') openSettingsSkillsPage(el.dataset.skillsTab || 'list');
}
function closeSettingsModal() {
  const overlay = $('settings-overlay');
  if (overlay) {
    overlay.hidden = true;
  }
  resetDialogMaximize('settings-overlay', 'settings-max');
}

function isSettingsSkillsPageOpen() {
  return isSettingsPageOpen('skills');
}

function initSettingsShell() {
  const menuAppTrigger =
    document.getElementById('menu-app-trigger') || document.getElementById('menu-settings-trigger');
  if (menuAppTrigger) {
    menuAppTrigger.addEventListener('click', (e) => {
      e.stopPropagation();
      openSettingsModal('settings');
    });
  }

  document.querySelectorAll('.settings-nav-item[data-settings-action]').forEach((el) => {
    el.addEventListener('click', () => handleMenuAction(el));
  });

  document.querySelectorAll('.settings-nav-item[data-settings-tab]').forEach((el) => {
    el.addEventListener('click', () => switchSettingsTab(el.dataset.settingsTab));
  });

  document.querySelectorAll('.settings-nav-item[data-model-tab]').forEach((el) => {
    el.addEventListener('click', () => {
      document.querySelectorAll('.settings-page').forEach((page) => {
        page.classList.toggle('active', page.dataset.settings === 'settings');
      });
      ensureSettingsSidebar();
      switchModelSettingsTab(el.dataset.modelTab);
    });
  });

  document.addEventListener('click', () => closeAllMenus());
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      const autoEd = $('automation-editor-overlay');
      if (autoEd && !autoEd.hidden) closeAutomationEditor();
      // 首次来信确认弹在最上层：Esc = 「先不看」（请求仍在面板待确认里）
      else if (isPeerTrustPromptOpen()) dismissPeerTrustPrompt();
      else if (isConnectModalOpen()) closeConnectModal();
      else if (isHelpModalOpen()) closeHelpModal();
      else if (isSettingsModalOpen()) closeSettingsModal();
      else if (isExecuteModalOpen()) closeExecuteModal();
      else if (isSettingsSkillsPageOpen()) closeSettingsSkillsPage();
      else closeAllMenus();
    }
    // 全局快捷键统一走「基础设置 → 快捷键」的键位表（renderer-shortcuts.js），
    // 这里不再写死 Alt+S / Alt+K / Alt+E / Alt+H —— 用户改了键位就要立刻生效。
    if (typeof matchesShortcut === 'function') {
      for (const [shortcutId, run] of SETTINGS_SHORTCUT_ACTIONS) {
        if (!matchesShortcut(e, shortcutId)) continue;
        e.preventDefault();
        run();
        break;
      }
    }
  });

  window.addEventListener('dieyun:language-change', () => {
    const activeModel = document.querySelector('.settings-nav-item.active[data-model-tab]');
    if (activeModel && !$('settings-overlay')?.hidden) {
      switchModelSettingsTab(activeModel.dataset.modelTab || 'defined');
    } else {
      const activeSettings = document.querySelector('.settings-nav-item.active[data-settings-tab]');
      if (activeSettings && !$('settings-overlay')?.hidden) switchSettingsTab(activeSettings.dataset.settingsTab);
    }
  });

  document.querySelectorAll('.execute-nav-item[data-execute-tab]').forEach((el) => {
    el.addEventListener('click', () => switchExecuteTab(el.dataset.executeTab));
  });
}

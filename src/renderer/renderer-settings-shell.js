/* global window, document, $, uiText, gwState, closeMobileConnectModal, isMobileConnectModalOpen, openHelpModal, closeHelpModal, openSettingsSkillsPage, openSettingsComponentsPage, isSettingsComponentsPageOpen, isHelpModalOpen, isSettingsModalOpen, setDialogMaximized, resetDialogMaximize, renderSuppliersList */
'use strict';

const panels = document.querySelectorAll('.tab-panel');
const SETTINGS_TITLE_KEYS = {
  settings: ['settings_model', '模型'],
  theme: ['settings_theme', '主题'],
  worktrees: ['settings_worktrees', 'Worktree'],
  database: ['settings_database', '数据库'],
  plugins: ['settings_plugins', '插件'],
  perms: ['settings_perms', '权限'],
  'agent-knowledge': ['settings_agent_knowledge', '知识']
};
const MODEL_TAB_TITLE_KEYS = {
  defined: ['model_defined', '定义模型'],
  embedding: ['model_embedding', '向量索引'],
  builtin: ['model_builtin', '供应商']
};
const DATABASE_TAB_TITLES = {
  settings: '数据库设置',
  list: '数据库列表'
};
const EXECUTE_TAB_TITLES = { anchor: '锚点设置', tasks: '定时任务', api: 'API设置' };

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
  overlay.classList.remove('settings-mode-database');
}

function showPluginListView() {
  document.querySelectorAll('.plugin-settings-view').forEach((el) => {
    el.classList.toggle('active', el.dataset.pluginView === 'list');
  });
}

function openSettingsShell() {
  const overlay = $('settings-overlay');
  if (!overlay) return false;
  closeAllMenus();
  closeMobileConnectModal();
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

function switchPanel(tab) {
  if (!tab) return;
  closeSettingsModal();
  closeSettingsSkillsPage();
  closeExecuteModal();
  const appEl = document.querySelector('.app');
  if (appEl) appEl.classList.add('app-view-agent');
  panels.forEach((p) => p.classList.toggle('active', p.dataset.panel === tab));
  if (tab === 'agent') focusChatInput();
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
  if (tab === 'perms') {
    loadPermissionsUI().catch(() => {});
    if (typeof window.syncThemeAutoLaunchToggle === 'function') {
      window.syncThemeAutoLaunchToggle();
    }
    if (typeof window.syncThemeLongHorizonToggle === 'function') {
      window.syncThemeLongHorizonToggle();
    }
  }
  if (tab === 'worktrees' && typeof onWorktreesSettingsTabShown === 'function') {
    onWorktreesSettingsTabShown();
  }
}

function openDatabaseSettingsModal(databaseTab = 'settings') {
  closeAllMenus();
  closeMobileConnectModal();
  closeExecuteModal();
  closeHelpModal();
  if (typeof openDatabasePluginDetail === 'function') {
    openDatabasePluginDetail(databaseTab);
    return;
  }
  openSettingsSkillsPage('plugins');
  if (gwState.authed) loadSqlConfigUI().catch(() => {});
}

function openPermissionsSettingsModal() {
  const overlay = $('settings-overlay');
  if (!overlay) return;
  closeAllMenus();
  closeMobileConnectModal();
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
  closeMobileConnectModal();
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
  closeMobileConnectModal();
  closeSettingsSkillsPage();
  closeExecuteModal();
  closeHelpModal();
  if (tab === 'settings' || !tab) {
    openModelSettingsModal('defined');
    return;
  }
  if (tab === 'database') {
    openDatabaseSettingsModal('settings');
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
  else if (menu === 'components') openSettingsComponentsPage();
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

function isSettingsComponentsPageOpen() {
  return isSettingsPageOpen('components');
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

  const settingsOverlay = $('settings-overlay');
  if (settingsOverlay) {
    settingsOverlay.addEventListener('click', (e) => {
      if (e.target === settingsOverlay) closeSettingsModal();
    });
  }

  document.addEventListener('click', () => closeAllMenus());
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      const autoEd = $('automation-editor-overlay');
      if (autoEd && !autoEd.hidden) closeAutomationEditor();
      else if (isMobileConnectModalOpen()) closeMobileConnectModal();
      else if (isHelpModalOpen()) closeHelpModal();
      else if (isSettingsModalOpen()) closeSettingsModal();
      else if (isExecuteModalOpen()) closeExecuteModal();
      else if (isSettingsSkillsPageOpen()) closeSettingsSkillsPage();
      else if (isSettingsComponentsPageOpen()) closeSettingsModal();
      else closeAllMenus();
    }
    if (e.altKey && !e.ctrlKey && !e.metaKey) {
      const k = e.key.toLowerCase();
      if (k === 's') {
        e.preventDefault();
        openSettingsModal('settings');
      } else if (k === 'k') {
        e.preventDefault();
        if (isSettingsSkillsPageOpen()) closeSettingsSkillsPage();
        else openSettingsSkillsPage();
      } else if (k === 'e') {
        e.preventDefault();
        if (isExecuteModalOpen()) closeExecuteModal();
        else openExecuteModal('anchor');
      } else if (k === 'h') {
        e.preventDefault();
        openHelpModal('usage');
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

  const executeOverlay = $('execute-overlay');
  if (executeOverlay) {
    executeOverlay.addEventListener('click', (e) => {
      if (e.target === executeOverlay) closeExecuteModal();
    });
  }
  document.querySelectorAll('.execute-nav-item[data-execute-tab]').forEach((el) => {
    el.addEventListener('click', () => switchExecuteTab(el.dataset.executeTab));
  });
}

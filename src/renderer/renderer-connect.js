/* global window, document, $, closeAllMenus, closeSettingsModal, closeSettingsSkillsPage, closeExecuteModal, closeHelpModal, refreshMobileConnectInfo, refreshPeerPanel */
'use strict';

/**
 * 「连接」对话框外壳：标题栏只有一个图标，里面两个标签页 —— 手机连接 / Agent 互通。
 *
 * 为什么合并：这两件事对用户是同一个问题（「怎么把别的设备接上我的 agent」），
 * 分成两个图标会让人找两遍；但两侧的设置项、状态与失败原因完全不同，
 * 所以合并的是**外壳**，不是内容：每个标签页仍由各自模块（renderer-mobile / renderer-peer）渲染，
 * 这里只负责开关、切页、按需刷新。不要在此外实现任何手机或 peer 的业务判定。
 */

const CONNECT_TABS = ['mobile', 'peer'];
/** @type {'mobile'|'peer'} */
let activeConnectTab = 'mobile';

function isConnectModalOpen() {
  const overlay = $('connect-overlay');
  return !!(overlay && !overlay.hidden);
}

function activeConnectTabId() {
  return activeConnectTab;
}

/**
 * 切页并**只刷新当前可见的那一块**：打开面板不该同时打两套 IPC，
 * 而手机侧要拍二维码、peer 侧要做在线探测，都各自有代价。
 * @param {'mobile'|'peer'} tab
 */
function applyConnectTab(tab) {
  const next = CONNECT_TABS.includes(tab) ? tab : 'mobile';
  activeConnectTab = next;
  for (const t of CONNECT_TABS) {
    const btn = $(`connect-tab-${t}`);
    const pane = $(`connect-pane-${t}`);
    const on = t === next;
    if (btn) {
      btn.classList.toggle('active', on);
      btn.setAttribute('aria-selected', on ? 'true' : 'false');
    }
    if (pane) pane.hidden = !on;
  }
  if (next === 'mobile' && typeof refreshMobileConnectInfo === 'function') {
    refreshMobileConnectInfo().catch(() => {});
  }
  if (next === 'peer' && typeof refreshPeerPanel === 'function') {
    refreshPeerPanel().catch(() => {});
  }
  return next;
}

/** @param {'mobile'|'peer'} [tab] */
function openConnectModal(tab) {
  const overlay = $('connect-overlay');
  if (!overlay) return;
  if (typeof closeAllMenus === 'function') closeAllMenus();
  if (typeof closeSettingsModal === 'function') closeSettingsModal();
  if (typeof closeSettingsSkillsPage === 'function') closeSettingsSkillsPage();
  if (typeof closeExecuteModal === 'function') closeExecuteModal();
  if (typeof closeHelpModal === 'function') closeHelpModal();
  overlay.hidden = false;
  applyConnectTab(tab || activeConnectTab);
}

function closeConnectModal() {
  const overlay = $('connect-overlay');
  if (overlay) overlay.hidden = true;
}

function bindConnectUi() {
  const trigger = $('menu-connect-trigger');
  if (trigger) {
    trigger.addEventListener('click', (e) => {
      e.stopPropagation();
      openConnectModal(activeConnectTab);
    });
  }
  $('connect-close')?.addEventListener('click', () => closeConnectModal());
  for (const t of CONNECT_TABS) {
    $(`connect-tab-${t}`)?.addEventListener('click', () => applyConnectTab(t));
  }
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bindConnectUi, { once: true });
  else bindConnectUi();
}

if (typeof window !== 'undefined') {
  window.openConnectModal = openConnectModal;
  window.closeConnectModal = closeConnectModal;
  window.applyConnectTab = applyConnectTab;
  window.isConnectModalOpen = isConnectModalOpen;
}

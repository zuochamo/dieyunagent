/* global window, document, renderArtifactsList, isWorkspaceArtifactsCacheReady, renderChangesPane, patchChangesPane, syncBrowserBounds, ensureTerminalSession, clampBrowserPanelWidthToChatMin, migrateLiveWritePreviewOnTabSwitch, maybeReloadSelectedArtifactContent */
'use strict';

const SIDE_PANEL_TAB_KEY = 'diecloud.ui.sidePanelTab.v1';
const PANEL_MOTION_MS = 560;

const sidePanelState = {
  open: false,
  tab: 'files'
};

let panelCloseTimer = null;
/** SSH 页请求被 rail 可用性拦下时（会话切换中工作区类型尚未落地）暂存，等 rail 就绪后落地 */
let pendingSshTabRequest = false;

function getSidePanelEl() {
  return document.getElementById('artifacts-panel');
}

function isSidePanelOpen() {
  const panel = getSidePanelEl();
  return !!(panel && !panel.hidden);
}

function loadSavedSideTab() {
  try {
    const t = window.localStorage.getItem(SIDE_PANEL_TAB_KEY);
    if (
    t === 'changes' ||
    t === 'terminal' ||
    t === 'browser' ||
    t === 'files' ||
    t === 'context' ||
    t === 'codebase' ||
    t === 'graph' ||
    t === 'wiki' ||
    t === 'ssh'
  )
    return t;
  } catch {
    // ignore
  }
  return 'files';
}

function saveSideTab(tab) {
  try {
    window.localStorage.setItem(SIDE_PANEL_TAB_KEY, tab);
  } catch {
    // ignore
  }
}

function updateSidePanelRail(tab) {
  document.querySelectorAll('.side-panel-rail-btn').forEach((btn) => {
    const t = btn.getAttribute('data-side-tab');
    const on = t === tab;
    btn.classList.toggle('active', on);
    btn.setAttribute('aria-selected', on ? 'true' : 'false');
  });
}

function setSidePanelTab(tab, opts) {
  let next = tab || 'files';
  // SSH 面板仅在 SSH 工作区可见；被隐藏时回退到文件面板
  if (next === 'ssh') {
    const sshBtn = document.querySelector('.side-panel-rail-btn[data-side-tab="ssh"]');
    if (sshBtn && sshBtn.hidden) {
      // 会话切换时恢复侧栏页先于工作区类型落地（rail 按钮仍是 hidden）。
      // 记下请求，由 updateSshPanelVisibility 在 rail 打通后经
      // consumePendingSshTabRequest 落地，避免用户记住的 SSH 页被无声降级成文件页。
      pendingSshTabRequest = true;
      next = 'files';
    }
  }
  sidePanelState.tab = next;
  saveSideTab(next);
  updateSidePanelRail(next);

  document.querySelectorAll('.side-panel-pane').forEach((pane) => {
    const p = pane.getAttribute('data-side-pane');
    const show = p === next;
    pane.hidden = !show;
    pane.classList.toggle('active', show);
  });

  const btnArtifacts = document.getElementById('win-artifacts');
  if (btnArtifacts) btnArtifacts.classList.toggle('active', sidePanelState.open);

  if (next === 'files' && !(opts && opts.skipRender)) {
    const cacheReady =
      typeof isWorkspaceArtifactsCacheReady === 'function' && isWorkspaceArtifactsCacheReady();
    // 缓存可用时仍强制刷一次目录 mtime，避免预览停在旧内容
    renderArtifactsList({ skipRefresh: false, forceRefresh: cacheReady });
    if (typeof maybeReloadSelectedArtifactContent === 'function') {
      maybeReloadSelectedArtifactContent();
    }
  }
  if (next === 'changes') {
    if (typeof patchChangesPane === 'function') patchChangesPane();
    else if (typeof renderChangesPane === 'function') renderChangesPane();
  }
  if (next === 'browser') {
    if (typeof clampBrowserPanelWidthToChatMin === 'function') clampBrowserPanelWidthToChatMin();
  }
  if (next === 'terminal' && typeof ensureTerminalSession === 'function') ensureTerminalSession();
  if (next === 'context' && typeof refreshContextProgress === 'function') refreshContextProgress();
  if (next === 'ssh' && typeof refreshWorkspaceMenuItems === 'function') {
    refreshWorkspaceMenuItems().catch(() => {});
  }
  if (next === 'codebase' && typeof onCodebasePanelShown === 'function') onCodebasePanelShown();
  else if (typeof onCodebasePanelHidden === 'function') onCodebasePanelHidden();
  if (next === 'graph' && typeof onGraphPanelShown === 'function') onGraphPanelShown();
  else if (typeof onGraphPanelHidden === 'function') onGraphPanelHidden();
  if (next === 'wiki' && typeof onWikiPanelShown === 'function') onWikiPanelShown();

  if (
    (next === 'files' || next === 'changes') &&
    typeof migrateLiveWritePreviewOnTabSwitch === 'function'
  ) {
    migrateLiveWritePreviewOnTabSwitch(next);
  }

  // 离开浏览器页时必须收起 BrowserView，否则会盖住侧栏按钮导致无法切换
  if (typeof syncBrowserBounds === 'function') {
    requestAnimationFrame(function () {
      syncBrowserBounds();
      setTimeout(syncBrowserBounds, 80);
    });
  }
}

function finishPanelClose(panel, resizer) {
  if (!panel.classList.contains('is-panel-closing')) return;
  if (panelCloseTimer) {
    clearTimeout(panelCloseTimer);
    panelCloseTimer = null;
  }
  const main = document.getElementById('agent-main');
  panel.classList.remove('is-panel-closing', 'is-panel-open');
  panel.hidden = true;
  if (resizer) {
    resizer.classList.remove('is-panel-closing');
    resizer.hidden = true;
  }
  if (main) main.classList.remove('side-panel-open');
  const btnArtifacts = document.getElementById('win-artifacts');
  if (btnArtifacts) btnArtifacts.classList.remove('active');
  if (typeof syncBrowserBounds === 'function') syncBrowserBounds();
  if (typeof onCodebasePanelHidden === 'function') onCodebasePanelHidden();
  if (typeof onGraphPanelHidden === 'function') onGraphPanelHidden();
}

function applySidePanelOpenState(open) {
  const panel = getSidePanelEl();
  const main = document.getElementById('agent-main');
  const resizer = document.getElementById('artifacts-pane-resizer');
  if (!panel) return;
  sidePanelState.open = !!open;

  if (panelCloseTimer) {
    clearTimeout(panelCloseTimer);
    panelCloseTimer = null;
  }

  if (open) {
    if (main) main.classList.add('side-panel-open');
    panel.hidden = false;
    if (resizer) {
      resizer.hidden = false;
      resizer.classList.remove('is-panel-closing');
    }
    panel.classList.remove('is-panel-closing');
    void panel.offsetWidth;
    requestAnimationFrame(function () {
      panel.classList.add('is-panel-open');
    });
    const btnArtifacts = document.getElementById('win-artifacts');
    if (btnArtifacts) btnArtifacts.classList.add('active');
  } else {
    panel.classList.remove('is-panel-open');
    panel.classList.add('is-panel-closing');
    if (resizer) resizer.classList.add('is-panel-closing');

    const onEnd = function (e) {
      if (!panel.classList.contains('is-panel-closing')) return;
      if (e.target !== panel) return;
      if (e.propertyName !== 'flex-basis') return;
      finishPanelClose(panel, resizer);
    };
    panel.addEventListener('transitionend', onEnd, { once: true });
    panelCloseTimer = setTimeout(function () {
      if (panel.classList.contains('is-panel-closing')) finishPanelClose(panel, resizer);
    }, PANEL_MOTION_MS + 100);
  }
}

function openSidePanel(opts) {
  const tab = (opts && opts.tab) || sidePanelState.tab || loadSavedSideTab();
  applySidePanelOpenState(true);
  setSidePanelTab(tab, opts);
}

function closeSidePanelSilently() {
  if (!isSidePanelOpen()) return;
  applySidePanelOpenState(false);
}

function toggleSidePanelTab(tab) {
  if (isSidePanelOpen() && sidePanelState.tab === tab) {
    closeSidePanelSilently();
    return;
  }
  openSidePanel({ tab: tab });
}

function initSidePanel() {
  sidePanelState.tab = loadSavedSideTab();
  // 同步 rail + pane 初始态，避免 rail 高亮 Wiki 但主 pane 仍是 files
  setSidePanelTab(sidePanelState.tab, { silent: true });

  document.querySelectorAll('.side-panel-rail-btn').forEach((btn) => {
    btn.addEventListener('click', function () {
      const tab = btn.getAttribute('data-side-tab') || 'files';
      toggleSidePanelTab(tab);
    });
  });

  const btnArtifacts = document.getElementById('win-artifacts');
  if (btnArtifacts) {
    btnArtifacts.addEventListener('click', function () {
      if (isSidePanelOpen()) closeSidePanelSilently();
      else openSidePanel({ tab: sidePanelState.tab || loadSavedSideTab() });
    });
  }
}

function closeBrowserPanelSilently() {
  closeSidePanelSilently();
}

function getSidePanelTab() {
  return sidePanelState.tab || 'files';
}

/** 取出并清除被拦截的 SSH 页请求（仅由 updateSshPanelVisibility 调用） */
function consumePendingSshTabRequest() {
  if (!pendingSshTabRequest) return false;
  pendingSshTabRequest = false;
  return true;
}

if (typeof window !== 'undefined') {
  window.getSidePanelTab = getSidePanelTab;
  window.consumePendingSshTabRequest = consumePendingSshTabRequest;
}

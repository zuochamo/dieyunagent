/* global window, document, renderArtifactsList, isWorkspaceArtifactsCacheReady, renderChangesPane, patchChangesPane, syncBrowserBounds, ensureTerminalSession, clampBrowserPanelWidthToChatMin, maybeReloadSelectedArtifactContent, onSubagentsPanelShown, onSubagentsPanelHidden, onGoalPanelShown, onGoalPanelHidden, refreshPeerPanel, motionMs, requestAnimationFrame, cancelAnimationFrame */
'use strict';

const SIDE_PANEL_TAB_KEY = 'diecloud.ui.sidePanelTab.v1';

const sidePanelState = {
  open: false,
  tab: 'files'
};

let panelCloseTimer = null;
let panelMotionRaf = null;
/** 面板动画期间逐帧同步原生视图边界的令牌：新一次开/关让上一次收手 */
let panelMotionToken = 0;
/** SSH 页请求被 rail 可用性拦下时（会话切换中工作区类型尚未落地）暂存，等 rail 就绪后落地 */
let pendingSshTabRequest = false;

/**
 * 面板宽度过渡期间逐帧同步原生 BrowserView 边界（唯一来源）。
 * 原生 WebContentsView 不吃 CSS transform/transition：只在结束时同步会让它
 * 整段动画期间停在过渡起点/中途的 rect 上，看上去「画面和面板错位」。
 * 别处不要再写 setTimeout(syncBrowserBounds, 80/120/280) 这类拍脑袋延时 —— 时长从
 * --motion-slow 来（与 CSS 同源），过渡一结束自动停。
 */
function syncPanelMotionBounds() {
  if (typeof syncBrowserBounds !== 'function') return;
  const token = ++panelMotionToken;
  if (panelMotionRaf) {
    cancelAnimationFrame(panelMotionRaf);
    panelMotionRaf = null;
  }
  const deadline = Date.now() + motionMs('--motion-slow') + 120;
  const tick = () => {
    if (token !== panelMotionToken) return;
    syncBrowserBounds();
    if (Date.now() < deadline) {
      panelMotionRaf = requestAnimationFrame(tick);
    } else {
      panelMotionRaf = null;
    }
  };
  panelMotionRaf = requestAnimationFrame(tick);
}

function getSidePanelEl() {
  return document.getElementById('artifacts-panel');
}

function isSidePanelOpen() {
  const panel = getSidePanelEl();
  return !!(panel && !panel.hidden);
}

function loadSavedSideTab() {
  try {
    const raw = window.localStorage.getItem(SIDE_PANEL_TAB_KEY);
    // 旧版本把「代码索引 / 结构索引」存成两个页签；现在合并为「索引」，读回时迁移
    const t = raw === 'codebase' || raw === 'graph' ? 'index' : raw;
    if (
    t === 'changes' ||
    t === 'scm' ||
    t === 'terminal' ||
    t === 'browser' ||
    t === 'files' ||
    t === 'artifacts' ||
    t === 'context' ||
    t === 'goal' ||
    t === 'subagents' ||
    t === 'index' ||
    t === 'bot' ||
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
  if (next === 'artifacts') {
    // 首刷的唯一入口（与 context / codebase / graph 面板同构）
    if (typeof onProductsPanelShown === 'function') onProductsPanelShown();
  } else if (typeof onProductsPanelHidden === 'function') {
    onProductsPanelHidden();
  }
  if (next === 'changes') {
    if (typeof patchChangesPane === 'function') patchChangesPane();
    else if (typeof renderChangesPane === 'function') renderChangesPane();
  }
  if (next === 'scm' && typeof renderScmPane === 'function') renderScmPane();
  if (next === 'browser') {
    if (typeof clampBrowserPanelWidthToChatMin === 'function') clampBrowserPanelWidthToChatMin();
  }
  if (next === 'terminal' && typeof ensureTerminalSession === 'function') ensureTerminalSession();
  if (next === 'context') {
    // 首刷 + 心跳启停的唯一入口（与 codebase / graph 面板同构）
    if (typeof onContextPanelShown === 'function') onContextPanelShown();
  } else if (typeof onContextPanelHidden === 'function') {
    onContextPanelHidden();
  }
  if (next === 'ssh' && typeof refreshWorkspaceMenuItems === 'function') {
    refreshWorkspaceMenuItems().catch(() => {});
  }
  if (next === 'subagents' && typeof onSubagentsPanelShown === 'function') onSubagentsPanelShown();
  else if (typeof onSubagentsPanelHidden === 'function') onSubagentsPanelHidden();
  // 「目标」页：首刷 + 轮询启停的唯一入口（目标由模型在轮内改，见 renderer-goal-panel.js）
  if (next === 'goal' && typeof onGoalPanelShown === 'function') onGoalPanelShown();
  else if (typeof onGoalPanelHidden === 'function') onGoalPanelHidden();
  // 代码片段索引与结构索引合并在同一个「索引」页签里（见 renderer-index-panel.js）
  if (next === 'index' && typeof onIndexPanelShown === 'function') onIndexPanelShown();
  else if (typeof onIndexPanelHidden === 'function') onIndexPanelHidden();
  // 「Bot」页：内网 Agent 列表 + 房间（见 docs/BOT-ROOM-PLAN.md）。
  // 首刷入口在这里；后续靠 peer:event 推送刷新，不轮询（peer 是事件驱动的）。
  if (next === 'bot' && typeof refreshPeerPanel === 'function') refreshPeerPanel().catch(() => {});

  // 离开浏览器页时必须收起 BrowserView，否则会盖住侧栏按钮导致无法切换
  // （页签切换会改变原生视图可用高度，边界交给同一条过渡期同步链）
  if (typeof syncBrowserBounds === 'function') syncPanelMotionBounds();
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
  if (typeof onContextPanelHidden === 'function') onContextPanelHidden();
  if (typeof onSubagentsPanelHidden === 'function') onSubagentsPanelHidden();
  if (typeof onGoalPanelHidden === 'function') onGoalPanelHidden();
  if (typeof onProductsPanelHidden === 'function') onProductsPanelHidden();
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
    syncPanelMotionBounds();
    const btnArtifacts = document.getElementById('win-artifacts');
    if (btnArtifacts) btnArtifacts.classList.add('active');
  } else {
    panel.classList.remove('is-panel-open');
    panel.classList.add('is-panel-closing');
    if (resizer) resizer.classList.add('is-panel-closing');
    syncPanelMotionBounds();

    const onEnd = function (e) {
      if (!panel.classList.contains('is-panel-closing')) return;
      if (e.target !== panel) return;
      if (e.propertyName !== 'flex-basis') return;
      finishPanelClose(panel, resizer);
    };
    panel.addEventListener('transitionend', onEnd, { once: true });
    panelCloseTimer = setTimeout(function () {
      if (panel.classList.contains('is-panel-closing')) finishPanelClose(panel, resizer);
    }, motionMs('--motion-slow') + 120);
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
  // 同步 rail + pane 初始态，避免 rail 高亮某页但主 pane 仍是 files
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

  if (typeof initScmPane === 'function') initScmPane();
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

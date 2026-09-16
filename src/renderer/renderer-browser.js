/* global window, document, gatewayCall, showAgentToast, openSidePanel, isSidePanelOpen, closeBrowserPanelSilently, clampNumber, loadPaneSizeVar, savePaneSizeVar, bindPaneDrag, isSending, syncBrowserBounds, currentSessionId, sessionActiveRuns */
'use strict';

const browserApi = window.diecloud || {};
const CHAT_MIN_WIDTH_PX = 360;
const BROWSER_PANEL_MIN_PX = 320;

/** @type {Map<string, boolean>} */
const browserOpenedByAgentBySession = new Map();
/** @type {Map<string, boolean>} */
const browserPinnedByUserBySession = new Map();

function sessionBrowserKey(sessionId) {
  const sid =
    sessionId != null && String(sessionId).trim()
      ? String(sessionId).trim()
      : typeof currentSessionId !== 'undefined'
        ? String(currentSessionId || '')
        : '';
  return sid || '__view__';
}

function getBrowserOpenedByAgent(sessionId) {
  return !!browserOpenedByAgentBySession.get(sessionBrowserKey(sessionId));
}

function getBrowserPinnedByUser(sessionId) {
  return !!browserPinnedByUserBySession.get(sessionBrowserKey(sessionId));
}

function setBrowserSessionFlags(sessionId, flags) {
  const key = sessionBrowserKey(sessionId);
  if (flags && 'openedByAgent' in flags) {
    browserOpenedByAgentBySession.set(key, !!flags.openedByAgent);
  }
  if (flags && 'pinnedByUser' in flags) {
    browserPinnedByUserBySession.set(key, !!flags.pinnedByUser);
  }
}

function markBrowserOpenedByAgent(sessionId) {
  browserOpenedByAgentBySession.set(sessionBrowserKey(sessionId), true);
}

function resolveAgentBrowserSessionId() {
  const visible =
    typeof currentSessionId !== 'undefined' && currentSessionId
      ? String(currentSessionId)
      : '';
  if (
    visible &&
    typeof sessionActiveRuns !== 'undefined' &&
    sessionActiveRuns &&
    sessionActiveRuns.get(visible) &&
    !sessionActiveRuns.get(visible).finished
  ) {
    return visible;
  }
  if (typeof sessionActiveRuns !== 'undefined' && sessionActiveRuns) {
    for (const [sid, live] of sessionActiveRuns) {
      if (live && !live.finished) return sid;
    }
  }
  return visible;
}

async function autoCloseBrowserAfterAgentRun(sessionId) {
  const key = sessionBrowserKey(sessionId);
  const openedByAgent = browserOpenedByAgentBySession.get(key);
  const pinnedByUser = browserPinnedByUserBySession.get(key);
  const viewingThisSession = key === sessionBrowserKey(currentSessionId);
  if (openedByAgent && !pinnedByUser && viewingThisSession) {
    if (typeof closeBrowserPanelSilently === 'function') closeBrowserPanelSilently();
  }
  browserOpenedByAgentBySession.set(key, false);
}

function clampBrowserPanelWidthToChatMin() {
  var main = document.getElementById('agent-main');
  if (!main) return;
  var rect = main.getBoundingClientRect();
  if (rect.width <= CHAT_MIN_WIDTH_PX + BROWSER_PANEL_MIN_PX + 8) return;
  var maxPanelPct = ((rect.width - CHAT_MIN_WIDTH_PX - 8) / rect.width) * 100;
  var raw = getComputedStyle(document.documentElement).getPropertyValue('--artifacts-panel-width');
  var n = Number(String(raw).replace('%', '').trim());
  if (!Number.isFinite(n)) n = 45;
  if (n > maxPanelPct) {
    document.documentElement.style.setProperty(
      '--artifacts-panel-width',
      `${Math.max(28, Math.floor(maxPanelPct))}%`
    );
  }
}

function isWorktreeStyleOverlayOpen() {
  var nodes = document.querySelectorAll('.worktree-apply-overlay');
  for (var i = 0; i < nodes.length; i++) {
    if (!nodes[i].hidden) return true;
  }
  return false;
}

function syncBrowserBounds() {
  if (!browserApi.browserSetPanelState) return;
  var panel = document.getElementById('artifacts-panel');
  var viewport = document.getElementById('browser-viewport');
  var browserPane = document.querySelector('[data-side-pane="browser"]');
  var open = !!(panel && !panel.hidden && browserPane && !browserPane.hidden);
  // Native BrowserView paints above the page and steals clicks on overlapping modals.
  if (!open || isWorktreeStyleOverlayOpen()) {
    browserApi.browserSetPanelState({ open: false }).catch(function () {});
    return;
  }
  if (!viewport) return;
  var rect = viewport.getBoundingClientRect();
  browserApi.browserSetPanelState({
    open: true,
    bounds: {
      x: Math.round(rect.left),
      y: Math.round(rect.top),
      width: Math.round(rect.width),
      height: Math.round(rect.height)
    }
  }).catch(function () {});
}

/**
 * SSH 工作空间下 browser.navigate 会返回 displayUrl（用户真正输入的远端地址）与 url
 * （端口转发后的本机地址，这才是浏览器实际加载的）。地址栏与「按会话恢复」都该用前者，
 * 否则用户看到的是一个随机本机端口，恢复会话时也会去连一个可能已失效的隧道端口。
 */
var browserPreviewAlias = { tunnel: '', display: '' };

function setBrowserPreviewAlias(tunnelUrl, displayUrl) {
  browserPreviewAlias = {
    tunnel: String(tunnelUrl || ''),
    display: displayUrl ? String(displayUrl) : ''
  };
}

function browserDisplayUrl(rawUrl) {
  var u = String(rawUrl || '');
  if (!u) return u;
  var alias = browserPreviewAlias;
  if (!alias.tunnel || !alias.display) return u;
  if (u !== alias.tunnel && u.indexOf(alias.tunnel) !== 0) return u;
  return alias.display + u.slice(alias.tunnel.length);
}

function updateBrowserChrome(state) {
  if (!state) return;
  var urlInput = document.getElementById('browser-url-input');
  var badge = document.getElementById('browser-status-badge');
  var displayUrl = browserDisplayUrl(state.url);
  if (urlInput && displayUrl && document.activeElement !== urlInput) {
    urlInput.value = displayUrl;
  }
  if (badge) {
    badge.title = '';
    if (state.loading) badge.textContent = '加载中…';
    else if (state.renderHealth && state.renderHealth.likelyBlank) {
      badge.textContent = '画面黑屏';
      badge.title = 'BrowserView 截图接近全黑，已尝试重绘恢复';
    }
    else if (state.loadError && state.loadError.errorDescription) {
      badge.textContent = '加载失败';
      badge.title = state.loadError.errorDescription;
    } else if (state.engine === 'playwright') badge.textContent = 'Playwright';
    else badge.textContent = state.title ? String(state.title).slice(0, 12) : '就绪';
  }
}

function openBrowserPanel(opts) {
  const manual = !!(opts && opts.manual);
  if (manual) browserPinnedByUserBySession.set(sessionBrowserKey(), true);
  openSidePanel({ tab: 'browser' });
  clampBrowserPanelWidthToChatMin();
  requestAnimationFrame(function () {
    syncBrowserBounds();
    setTimeout(syncBrowserBounds, 80);
  });
}

/** Agent 浏览器工具调用前：打开侧栏并等待 BrowserView 布局就绪 */
function ensureBrowserPanelReady() {
  openBrowserPanel();
  return new Promise(function (resolve) {
    requestAnimationFrame(function () {
      syncBrowserBounds();
      setTimeout(function () {
        syncBrowserBounds();
        setTimeout(function () {
          syncBrowserBounds();
          resolve();
        }, 280);
      }, 120);
    });
  });
}

function initBrowserPanel() {
  try {
    var urlInput = document.getElementById('browser-url-input');
    if (urlInput) {
      urlInput.addEventListener('keydown', function (e) {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        var url = String(urlInput.value || '').trim();
        if (!url) return;
        openBrowserPanel({ manual: true });
        gatewayCall('browser.navigate', { url: url })
          .then(function (r) {
            setBrowserPreviewAlias(r.url, r.displayUrl);
            updateBrowserChrome({ url: r.url, title: r.title, loading: false, engine: r.engine });
          })
          .catch(function (err) {
            showAgentToast('打开网页失败', err.message || String(err), { variant: 'error' });
          });
      });
    }

    function browserNavAction(method) {
      openBrowserPanel({ manual: true });
      return gatewayCall(method, {})
        .then(function (r) {
          updateBrowserChrome({
            url: r.url,
            title: r.title,
            loading: false,
            engine: r.engine
          });
          return r;
        })
        .catch(function (err) {
          showAgentToast('浏览器操作失败', err.message || String(err), { variant: 'error' });
        });
    }

    var backBtn = document.getElementById('browser-back-btn');
    var forwardBtn = document.getElementById('browser-forward-btn');
    var reloadBtn = document.getElementById('browser-reload-btn');
    var headedToggle = document.getElementById('browser-headed-toggle');
    if (backBtn) {
      backBtn.addEventListener('click', function () {
        browserNavAction('browser.back');
      });
    }
    if (forwardBtn) {
      forwardBtn.addEventListener('click', function () {
        browserNavAction('browser.forward');
      });
    }
    if (reloadBtn) {
      reloadBtn.addEventListener('click', function () {
        browserNavAction('browser.reload');
      });
    }
    if (headedToggle) {
      headedToggle.addEventListener('click', function () {
        openBrowserPanel({ manual: true });
        var next = headedToggle.getAttribute('aria-pressed') !== 'true';
        gatewayCall('browser.configure', { playwrightHeaded: next })
          .then(function (r) {
            var on = !!(r && r.playwrightHeaded);
            headedToggle.setAttribute('aria-pressed', on ? 'true' : 'false');
            headedToggle.title = on ? 'Playwright 可见窗口已开启' : 'Playwright 可见窗口（后备引擎）';
          })
          .catch(function (err) {
            showAgentToast('Playwright 配置失败', err.message || String(err), { variant: 'error' });
          });
      });
      gatewayCall('browser.status', {})
        .then(function (st) {
          if (st && st.playwrightHeaded) {
            headedToggle.setAttribute('aria-pressed', 'true');
            headedToggle.title = 'Playwright 可见窗口已开启';
          }
        })
        .catch(function () {});
    }

    if (browserApi.onBrowserAutoOpen) {
      browserApi.onBrowserAutoOpen(function () {
        openBrowserPanel();
        if (typeof isSending !== 'undefined' && isSending) {
          markBrowserOpenedByAgent(resolveAgentBrowserSessionId());
        }
      });
    }
    if (browserApi.onBrowserState) {
      browserApi.onBrowserState(function (state) {
        updateBrowserChrome(state);
        if (state && state.url && typeof patchSessionViewState === 'function') {
          patchSessionViewState(currentSessionId, {
            browser: {
              url: browserDisplayUrl(state.url),
              title: state.title || '',
              pinnedByUser: getBrowserPinnedByUser(),
              openedByAgent: getBrowserOpenedByAgent()
            }
          });
        }
      });
    }
    window.addEventListener('resize', function () {
      syncBrowserBounds();
    });
    document.querySelectorAll('.worktree-apply-overlay').forEach(function (el) {
      new MutationObserver(function () {
        syncBrowserBounds();
      }).observe(el, { attributes: true, attributeFilter: ['hidden'] });
    });
  } catch (e) {
    // ignore
  }
}

if (typeof window !== 'undefined') {
  window.getBrowserPinnedByUser = getBrowserPinnedByUser;
  window.getBrowserOpenedByAgent = getBrowserOpenedByAgent;
  window.setBrowserSessionFlags = setBrowserSessionFlags;
  window.ensureBrowserPanelReady = ensureBrowserPanelReady;
  window.openBrowserPanel = openBrowserPanel;
  window.setBrowserActiveSession = (sessionId) => {
    if (browserApi.browserSetActiveSession) {
      browserApi.browserSetActiveSession({ sessionId: sessionId || null }).catch(() => {});
    }
  };
}

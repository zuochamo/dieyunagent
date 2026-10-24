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
      badge.textContent = '未渲染';
      badge.title = '画面全黑且页面无可见内容（确认未渲染），已尝试重绘恢复';
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
  const panelEl = document.getElementById('artifacts-panel');
  const wasHidden = !!(panelEl && panelEl.hidden);
  openSidePanel({ tab: 'browser' });
  clampBrowserPanelWidthToChatMin();
  requestAnimationFrame(function () {
    syncBrowserBounds();
    setTimeout(syncBrowserBounds, 80);
  });
  // 只在面板真正打开时补一次标签列表：导航类调用都会走这里，不做门控等于每次翻页多一次 RPC
  if (wasHidden) refreshBrowserTabs();
}

/* ────────── 标签条 ──────────
 * 唯一数据源是 controller 的 tabEntries：emitState 把 tabs/activeTabId 随 browser:state 下发，
 * 这里只负责画和转发点击。切/关/新建都走 gatewayCall('browser.tabs')，不再另造一套本地标签模型。
 */
var BROWSER_URL_PLACEHOLDER = 'https://… 或 index.html';
var browserTabsActiveId = '';
var browserTabsSignature = '';
var browserNewTabPending = false;

/** 标签显示名：优先标题，其次 URL 的 host+path，最后退回「待打开/空白页」。 */
function browserTabLabel(tab) {
  var title = String((tab && tab.title) || '').trim();
  if (title) return title;
  var raw = String((tab && tab.url) || '');
  if (!raw) return tab && tab.pending ? '待打开' : '空白页';
  try {
    var u = new URL(raw);
    // hostname 为空（about: / file: / blob: / data:）时 raw 已经包含完整地址，
    // 再拼一次 pathname 会得到 `about:blankblank` 这种重复串。
    if (!u.hostname) return raw;
    var path = u.pathname === '/' ? '' : u.pathname;
    return u.hostname + path;
  } catch (e) {
    return raw;
  }
}

function renderBrowserTabs(tabs, activeTabId) {
  var strip = document.getElementById('browser-tabstrip');
  var list = document.getElementById('browser-tabstrip-list');
  if (!strip || !list) return;
  var items = Array.isArray(tabs) ? tabs : [];
  var activeId = activeTabId == null ? '' : String(activeTabId);

  // 状态流每个页面事件都会推一次：内容没变就跳过，避免重建 DOM 抖动/丢失悬停态
  var sig =
    items
      .map(function (t) {
        return (
          t.id + '|' + (t.active ? 1 : 0) + '|' + (t.pending ? 1 : 0) + '|' + (t.title || '') + '|' + (t.url || '')
        );
      })
      .join('~') +
    '#' +
    activeId;
  // 标签条恒显示：`+` 是它的子元素，容器一 hidden 就没有任何「新建标签」入口
  // （setBrowserNewTabMode 再也进不去，只能用地址栏出第一页）。
  var shouldShow = true;
  if (sig === browserTabsSignature && shouldShow === !strip.hidden) return;

  browserTabsSignature = sig;
  // 活动标签变了说明用户离开了「新建标签」流程（点别的标签 / agent 改了标签 / 切会话），
  // 否则那个标志会挂到下一次地址栏回车，把「导航」变成「又开一个标签」。
  if (browserTabsActiveId && activeId && browserTabsActiveId !== activeId) {
    setBrowserNewTabMode(false);
  }
  browserTabsActiveId = activeId;
  strip.hidden = !shouldShow;
  list.textContent = '';

  items.forEach(function (tab) {
    var el = document.createElement('div');
    // 标签外观与文件面板共用同一套 .side-tab* 样式（唯一来源）
    el.className = 'side-tab' + (tab.active ? ' active' : '') + (tab.pending ? ' pending' : '');
    el.setAttribute('data-tab-id', String(tab.id));
    el.setAttribute('role', 'tab');
    el.setAttribute('aria-selected', tab.active ? 'true' : 'false');
    var label = browserTabLabel(tab);
    el.title = tab.pending ? label + '（待打开，点击后加载）' : tab.url || label;

    var titleEl = document.createElement('span');
    titleEl.className = 'side-tab-title';
    titleEl.textContent = label;
    el.appendChild(titleEl);

    var closeEl = document.createElement('button');
    closeEl.type = 'button';
    closeEl.className = 'side-tab-close';
    closeEl.setAttribute('data-tab-close', String(tab.id));
    closeEl.title = '关闭标签';
    closeEl.setAttribute('aria-label', '关闭 ' + label);
    closeEl.textContent = '×';
    el.appendChild(closeEl);

    list.appendChild(el);
    if (tab.active) {
      // 不用 scrollIntoView：它会连带滚动祖先容器；这里只动列表自身的横向滚动
      var left = el.offsetLeft;
      var right = left + el.offsetWidth;
      if (left < list.scrollLeft) list.scrollLeft = left;
      else if (right > list.scrollLeft + list.clientWidth) list.scrollLeft = right - list.clientWidth;
    }
  });

  // 标签条出现/消失会改变 BrowserView 的可用高度，边界必须重算
  requestAnimationFrame(function () {
    syncBrowserBounds();
    setTimeout(syncBrowserBounds, 80);
  });
}

function refreshBrowserTabs() {
  if (typeof gatewayCall !== 'function') return Promise.resolve();
  return gatewayCall('browser.tabs', { action: 'list' })
    .then(function (r) {
      if (r && Array.isArray(r.tabs)) renderBrowserTabs(r.tabs, r.activeTabId);
    })
    .catch(function () {});
}

function browserTabsCall(payload, errLabel) {
  return gatewayCall('browser.tabs', payload || {})
    .then(function (r) {
      if (r && Array.isArray(r.tabs)) renderBrowserTabs(r.tabs, r.activeTabId);
      if (r && r.ok === false && r.error) {
        showAgentToast(errLabel || '标签操作失败', r.error, { variant: 'error' });
      }
      return r;
    })
    .catch(function (err) {
      showAgentToast(errLabel || '标签操作失败', err && err.message ? err.message : String(err), {
        variant: 'error'
      });
      refreshBrowserTabs();
    });
}

/** 新建标签需要地址：点 + 进入「新标签模式」，地址栏回车才真正建标签（不产生空白废标签）。 */
function setBrowserNewTabMode(on) {
  browserNewTabPending = !!on;
  var urlInput = document.getElementById('browser-url-input');
  var newBtn = document.getElementById('browser-tabstrip-new');
  if (urlInput) {
    urlInput.placeholder = on ? '新标签页地址，回车打开' : BROWSER_URL_PLACEHOLDER;
    if (on) {
      urlInput.value = '';
      urlInput.focus();
    }
  }
  if (newBtn) newBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
}

function browserTabStripClick(event) {
  var target = event.target;
  if (!target || !target.closest) return;
  // 一旦操作标签，就不该再停在「新建标签」流程里（否则下一次地址栏回车会意外新开页）
  setBrowserNewTabMode(false);
  var closeEl = target.closest('[data-tab-close]');
  if (closeEl) {
    event.preventDefault();
    event.stopPropagation();
    browserTabsCall({ action: 'close', tabId: closeEl.getAttribute('data-tab-close') }, '关闭标签失败');
    return;
  }
  var tabEl = target.closest('[data-tab-id]');
  if (!tabEl) return;
  var id = tabEl.getAttribute('data-tab-id');
  if (!id || id === browserTabsActiveId) return;
  browserTabsCall({ action: 'switch', tabId: id }, '切换标签失败');
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
      // 进入「新建标签」后又跑去点别处（输入框失焦且没填地址）：退出该模式，
      // 否则 placeholder / aria-pressed 会一直停在「新标签页」，下次回车变成新开标签。
      urlInput.addEventListener('blur', function () {
        if (browserNewTabPending && !String(urlInput.value || '').trim()) {
          setBrowserNewTabMode(false);
        }
      });
      urlInput.addEventListener('keydown', function (e) {
        if (e.key === 'Escape' && browserNewTabPending) {
          e.preventDefault();
          setBrowserNewTabMode(false);
          return;
        }
        if (e.key !== 'Enter') return;
        e.preventDefault();
        var url = String(urlInput.value || '').trim();
        if (!url) return;
        openBrowserPanel({ manual: true });
        // 「新标签模式」下回车 = 新开一个标签，而不是覆盖当前页
        if (browserNewTabPending) {
          setBrowserNewTabMode(false);
          browserTabsCall({ action: 'new', url: url }, '新建标签失败').then(function (r) {
            if (!r || r.ok === false) return;
            var active = (r.tabs || []).filter(function (t) {
              return t.active;
            })[0];
            if (active && active.url) urlInput.value = browserDisplayUrl(active.url);
            urlInput.blur();
          });
          return;
        }
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

    var tabListEl = document.getElementById('browser-tabstrip-list');
    if (tabListEl) {
      tabListEl.addEventListener('click', browserTabStripClick);
      tabListEl.addEventListener('auxclick', function (e) {
        // 中键关标签：和浏览器保持一致
        if (e.button !== 1) return;
        var target = e.target;
        var tabEl = target && target.closest ? target.closest('[data-tab-id]') : null;
        if (!tabEl) return;
        e.preventDefault();
        browserTabsCall({ action: 'close', tabId: tabEl.getAttribute('data-tab-id') }, '关闭标签失败');
      });
    }
    var newTabBtn = document.getElementById('browser-tabstrip-new');
    if (newTabBtn) {
      newTabBtn.addEventListener('click', function () {
        openBrowserPanel({ manual: true });
        setBrowserNewTabMode(true);
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
        // tabs 由主进程 emitState 唯一下发；缺字段（旧状态流）时保持现有标签条不动
        if (state && Array.isArray(state.tabs)) renderBrowserTabs(state.tabs, state.activeTabId);
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

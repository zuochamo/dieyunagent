/* global window, currentSessionId, chatList, isSidePanelOpen, setSidePanelTab, openSidePanel, closeSidePanelSilently, updateBrowserChrome, gatewayCall, syncBrowserBounds, renderAttachmentChips */
'use strict';

const SESSION_VIEW_STORAGE_KEY = 'dieyun.session.viewState.v1';

/** @type {Map<string, object>} */
const sessionViewStates = new Map();

function defaultViewState() {
  return {
    chatAutoFollow: true,
    sidePanelTab: 'files',
    sidePanelOpen: false,
    browser: {
      url: '',
      title: '',
      pinnedByUser: false,
      openedByAgent: false
    },
    terminal: {
      scrollback: '',
      meta: '',
      scrollTop: 0
    }
  };
}

function readStoredViewStates() {
  try {
    const raw = window.localStorage.getItem(SESSION_VIEW_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function persistViewStates() {
  try {
    const obj = {};
    for (const [sid, state] of sessionViewStates.entries()) {
      obj[sid] = state;
    }
    window.localStorage.setItem(SESSION_VIEW_STORAGE_KEY, JSON.stringify(obj));
  } catch {
    // ignore
  }
}

function getSessionViewState(sessionId) {
  const sid = String(
    sessionId || (typeof currentSessionId !== 'undefined' ? currentSessionId : '') || ''
  ).trim();
  if (!sid) return defaultViewState();
  if (!sessionViewStates.has(sid)) {
    const stored = readStoredViewStates();
    sessionViewStates.set(sid, { ...defaultViewState(), ...(stored[sid] || {}) });
  }
  return sessionViewStates.get(sid);
}

function patchSessionViewState(sessionId, patch) {
  const sid = String(sessionId || '').trim();
  if (!sid || !patch) return;
  const cur = getSessionViewState(sid);
  sessionViewStates.set(sid, {
    ...cur,
    ...patch,
    browser: { ...cur.browser, ...(patch.browser || {}) },
    terminal: { ...cur.terminal, ...(patch.terminal || {}) }
  });
  persistViewStates();
}

function getChatAutoFollow(sessionId) {
  return getSessionViewState(sessionId).chatAutoFollow !== false;
}

function setChatAutoFollow(value, sessionId) {
  patchSessionViewState(sessionId || currentSessionId, { chatAutoFollow: !!value });
}

function captureBrowserViewState(sessionId) {
  const sid = String(sessionId || currentSessionId || '').trim();
  if (!sid) return;
  const urlInput = document.getElementById('browser-url-input');
  patchSessionViewState(sid, {
    browser: {
      url: urlInput ? String(urlInput.value || '').trim() : '',
      title: '',
      pinnedByUser:
        typeof window.getBrowserPinnedByUser === 'function'
          ? window.getBrowserPinnedByUser(sid)
          : false,
      openedByAgent:
        typeof window.getBrowserOpenedByAgent === 'function'
          ? window.getBrowserOpenedByAgent(sid)
          : false
    }
  });
}

function captureTerminalViewState(sessionId) {
  const sid = String(sessionId || currentSessionId || '').trim();
  if (!sid) return;
  const out = document.getElementById('terminal-output');
  const meta = document.getElementById('terminal-meta');
  patchSessionViewState(sid, {
    terminal: {
      scrollback: out ? String(out.textContent || '') : '',
      meta: meta ? String(meta.textContent || '') : '',
      scrollTop: out ? out.scrollTop : 0
    }
  });
}

function captureSidePanelViewState(sessionId) {
  const sid = String(sessionId || currentSessionId || '').trim();
  if (!sid) return;
  const tab =
    typeof window.getSidePanelTab === 'function' ? window.getSidePanelTab() : 'files';
  patchSessionViewState(sid, {
    sidePanelTab: tab || 'files',
    sidePanelOpen: typeof isSidePanelOpen === 'function' ? isSidePanelOpen() : false
  });
}

function captureSessionViewState(sessionId) {
  const sid = String(sessionId || currentSessionId || '').trim();
  if (!sid) return;
  if (typeof chatList !== 'undefined' && chatList) {
    patchSessionViewState(sid, {
      chatAutoFollow:
        typeof window.__readChatAutoFollowLive === 'function'
          ? window.__readChatAutoFollowLive()
          : getChatAutoFollow(sid)
    });
  }
  captureBrowserViewState(sid);
  captureTerminalViewState(sid);
  captureSidePanelViewState(sid);
}

async function restoreBrowserViewState(sessionId) {
  const browser = getSessionViewState(sessionId).browser || {};
  if (typeof window.setBrowserSessionFlags === 'function') {
    window.setBrowserSessionFlags(sessionId, {
      pinnedByUser: !!browser.pinnedByUser,
      openedByAgent: !!browser.openedByAgent
    });
  }
  if (browser.url) {
    updateBrowserChrome({
      url: browser.url,
      title: browser.title || '',
      loading: false
    });
  }
  if (browser.pinnedByUser && browser.url) {
    if (typeof openSidePanel === 'function') openSidePanel({ tab: 'browser' });
    try {
      const r = await gatewayCall('browser.navigate', { sessionId, url: browser.url });
      updateBrowserChrome({
        url: r.displayUrl || r.url || browser.url,
        title: r.title || browser.title || '',
        loading: false,
        engine: r.engine
      });
    } catch {
      // keep chrome only
    }
    if (typeof syncBrowserBounds === 'function') syncBrowserBounds();
  } else if (browser.openedByAgent && !browser.pinnedByUser) {
    if (typeof closeBrowserPanelSilently === 'function') closeBrowserPanelSilently();
  }
}

function restoreTerminalViewState(sessionId) {
  const terminal = getSessionViewState(sessionId).terminal || {};
  const out = document.getElementById('terminal-output');
  const meta = document.getElementById('terminal-meta');
  if (out && terminal.scrollback != null) {
    out.textContent = String(terminal.scrollback || '');
    out.scrollTop = Number(terminal.scrollTop) || out.scrollHeight;
  }
  if (meta && terminal.meta != null) meta.textContent = String(terminal.meta || '');
}

function restoreSidePanelViewState(sessionId, opts) {
  const view = getSessionViewState(sessionId);
  const tab = view.sidePanelTab || 'files';
  const openOpts = { tab, ...(opts && typeof opts === 'object' ? opts : {}) };
  if (view.sidePanelOpen) {
    if (typeof openSidePanel === 'function') openSidePanel(openOpts);
    else if (typeof setSidePanelTab === 'function') setSidePanelTab(tab, openOpts);
  } else if (typeof closeSidePanelSilently === 'function') {
    closeSidePanelSilently();
  }
}

function restoreSessionViewState(sessionId, opts) {
  const sid = String(sessionId || currentSessionId || '').trim();
  if (!sid) return;
  restoreSidePanelViewState(sid, opts);
  void restoreBrowserViewState(sid);
  restoreTerminalViewState(sid);
}

function activateSessionViewState(prevSessionId, nextSessionId, opts) {
  if (prevSessionId && String(prevSessionId) !== String(nextSessionId || '')) {
    captureSessionViewState(prevSessionId);
    if (typeof window.detachTerminalForSession === 'function') {
      void window.detachTerminalForSession(prevSessionId);
    }
  }
  const nextId = nextSessionId ? String(nextSessionId) : '';
  if (typeof window.setBrowserActiveSession === 'function') {
    window.setBrowserActiveSession(nextId || null);
  }
  if (nextId) {
    restoreSessionViewState(nextId, opts);
    const terminalTabOpen =
      typeof isSidePanelOpen === 'function' &&
      isSidePanelOpen() &&
      typeof window.getSidePanelTab === 'function' &&
      window.getSidePanelTab() === 'terminal';
    if (terminalTabOpen && typeof window.ensureTerminalSession === 'function') {
      void window.ensureTerminalSession(false, nextId);
    }
  }
}

function cleanupSessionViewState(sessionId) {
  const sid = String(sessionId || '').trim();
  if (!sid) return;
  sessionViewStates.delete(sid);
  persistViewStates();
}

if (typeof window !== 'undefined') {
  window.getSessionViewState = getSessionViewState;
  window.patchSessionViewState = patchSessionViewState;
  window.getChatAutoFollow = getChatAutoFollow;
  window.setChatAutoFollow = setChatAutoFollow;
  window.captureSessionViewState = captureSessionViewState;
  window.activateSessionViewState = activateSessionViewState;
  window.cleanupSessionViewState = cleanupSessionViewState;
  window.captureTerminalViewState = captureTerminalViewState;
}

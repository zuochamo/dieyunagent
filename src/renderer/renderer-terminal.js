/* global window, document, currentSessionId, isSidePanelOpen, getSidePanelTab */
'use strict';

const termApi = window.diecloud || {};
let terminalStarted = false;
let terminalStarting = null;
let terminalFocused = false;
/** 本机 pipe shell 无 PTY 回显，需在 renderer 本地显示按键 */
let terminalLocalEcho = true;
/** @type {string | null} */
let boundTerminalSessionId = null;

function getTerminalSessionId(sessionId) {
  if (sessionId != null && String(sessionId).trim()) return String(sessionId).trim();
  if (typeof currentSessionId !== 'undefined' && currentSessionId) return String(currentSessionId);
  return 'default';
}

function isTerminalTabActive() {
  if (typeof getSidePanelTab === 'function') return getSidePanelTab() === 'terminal';
  const pane = document.querySelector('.side-panel-pane[data-side-pane="terminal"]');
  return !!(pane && !pane.hidden);
}

function appendTerminalOutput(text) {
  const out = document.getElementById('terminal-output');
  if (!out) return;
  out.textContent += text;
  out.scrollTop = out.scrollHeight;
}

function localEchoBackspace() {
  if (!terminalLocalEcho) return;
  const out = document.getElementById('terminal-output');
  if (!out || !out.textContent) return;
  out.textContent = out.textContent.slice(0, -1);
  out.scrollTop = out.scrollHeight;
}

function localEchoInput(text) {
  if (!terminalLocalEcho) return;
  appendTerminalOutput(String(text || ''));
}

function clearTerminalOutput() {
  const out = document.getElementById('terminal-output');
  if (out) out.textContent = '';
}

function setTerminalMeta(text) {
  const meta = document.getElementById('terminal-meta');
  if (meta) meta.textContent = text || '';
}

async function resolveTerminalCwd() {
  try {
    if (termApi.getWorkspace) {
      const ws = await termApi.getWorkspace();
      if (ws && ws.kind === 'local' && ws.workspacePath) return ws.workspacePath;
    }
    if (termApi.getAgentHome) {
      const home = await termApi.getAgentHome();
      if (home && home.dieyunWorkspace) return home.dieyunWorkspace;
    }
  } catch {
    // ignore
  }
  return null;
}

function applyTerminalStartMeta(r, effectiveCwd) {
  terminalLocalEcho = !(r && r.remote) && r?.localEcho !== false;
  if (r && r.remote) {
    setTerminalMeta(`SSH · ${r.username || ''}@${r.host || ''}`);
    if (!r.reattached) appendTerminalOutput(`# 远程 ${effectiveCwd || r.cwd || ''}\r\n\r\n`);
  } else {
    setTerminalMeta('本机 · 已连接');
    if (!r.reattached && effectiveCwd) appendTerminalOutput(`# ${effectiveCwd}\r\n\r\n`);
  }
}

async function detachTerminalForSession(sessionId) {
  const sid = getTerminalSessionId(sessionId);
  if (termApi.terminalDetach) {
    await termApi.terminalDetach({ sessionId: sid }).catch(function () {});
  }
  if (boundTerminalSessionId === sid) {
    boundTerminalSessionId = null;
    terminalStarted = false;
  }
}

async function ensureTerminalSession(force, sessionId) {
  if (!termApi.terminalStart) return;
  const sid = getTerminalSessionId(sessionId);
  if (terminalStarted && !force && boundTerminalSessionId === sid) return;
  if (terminalStarting) return terminalStarting;

  terminalStarting = (async () => {
    setTerminalMeta('启动中…');
    try {
      const cwd = await resolveTerminalCwd();
      if (force && termApi.terminalStop) {
        terminalStarted = false;
        clearTerminalOutput();
        await termApi.terminalStop({ sessionId: sid }).catch(function () {});
        await new Promise(function (resolve) {
          setTimeout(resolve, 80);
        });
      }
      const r = await termApi.terminalStart({ sessionId: sid, cwd, force: !!force });
      const effectiveCwd = (r && r.cwd) || cwd || '';
      if (force || !r?.reattached) {
        if (!r?.reattached) clearTerminalOutput();
      }
      applyTerminalStartMeta(r, effectiveCwd);
      terminalStarted = true;
      boundTerminalSessionId = sid;
    } catch (e) {
      terminalStarted = false;
      boundTerminalSessionId = null;
      terminalLocalEcho = true;
      setTerminalMeta('启动失败');
      clearTerminalOutput();
      appendTerminalOutput('启动失败: ' + (e && e.message ? e.message : String(e)) + '\r\n');
    }
  })();

  try {
    await terminalStarting;
  } finally {
    terminalStarting = null;
  }
}

async function writeTerminalInput(data) {
  if (!termApi.terminalWrite) return false;
  const sid = getTerminalSessionId(boundTerminalSessionId);
  if (!terminalStarted || boundTerminalSessionId !== sid) {
    await ensureTerminalSession(false, sid);
  }
  try {
    const r = await termApi.terminalWrite({ sessionId: sid, data: String(data || '') });
    return !!(r && r.ok !== false);
  } catch {
    return false;
  }
}

function restartTerminalSession() {
  terminalStarted = false;
  if (typeof isSidePanelOpen === 'function' && isSidePanelOpen()) {
    ensureTerminalSession(true).catch(function () {});
  }
}

function handleTerminalKeydown(e) {
  if (!terminalFocused || !isTerminalTabActive()) return;
  if (!termApi.terminalWrite) return;

  if (e.ctrlKey && e.key === 'c') {
    e.preventDefault();
    void writeTerminalInput('\x03');
    return;
  }
  if (e.key === 'Enter') {
    e.preventDefault();
    localEchoInput('\r\n');
    void writeTerminalInput('\r\n');
    return;
  }
  if (e.key === 'Backspace') {
    e.preventDefault();
    localEchoBackspace();
    void writeTerminalInput('\x7f');
    return;
  }
  if (e.key === 'Tab') {
    e.preventDefault();
    localEchoInput('\t');
    void writeTerminalInput('\t');
    return;
  }
  if (e.key.length === 1 && !e.metaKey && !e.altKey && !e.ctrlKey) {
    e.preventDefault();
    localEchoInput(e.key);
    void writeTerminalInput(e.key);
  }
}

function initTerminalPane() {
  const wrap = document.getElementById('terminal-pane');
  const out = document.getElementById('terminal-output');
  const restartBtn = document.getElementById('terminal-restart');
  if (!wrap || !out) return;

  if (termApi.onTerminalData) {
    termApi.onTerminalData(function (payload) {
      if (!payload || payload.data == null) return;
      const sid = payload.sessionId != null ? String(payload.sessionId) : '';
      const bound = getTerminalSessionId(boundTerminalSessionId);
      if (sid && bound && sid !== bound) return;
      appendTerminalOutput(String(payload.data));
    });
  }
  if (termApi.onTerminalExit) {
    termApi.onTerminalExit(function (payload) {
      const sid = payload && payload.sessionId != null ? String(payload.sessionId) : '';
      const bound = getTerminalSessionId(boundTerminalSessionId);
      if (sid && bound && sid !== bound) return;
      terminalStarted = false;
      boundTerminalSessionId = null;
      setTerminalMeta('已断开');
      appendTerminalOutput(
        '\r\n[进程已退出 code=' + (payload && payload.code != null ? payload.code : '?') + ']\r\n'
      );
    });
  }

  wrap.addEventListener('mousedown', function () {
    terminalFocused = true;
    wrap.classList.add('focused');
    wrap.focus();
  });
  document.addEventListener('mousedown', function (e) {
    if (!wrap.contains(e.target)) {
      terminalFocused = false;
      wrap.classList.remove('focused');
    }
  });

  document.addEventListener('keydown', handleTerminalKeydown, true);

  if (restartBtn) {
    restartBtn.addEventListener('click', function () {
      restartTerminalSession();
    });
  }

  wrap.setAttribute('tabindex', '0');
}

if (typeof window !== 'undefined') {
  window.detachTerminalForSession = detachTerminalForSession;
  window.ensureTerminalSession = ensureTerminalSession;
  window.restartTerminalSession = restartTerminalSession;
}

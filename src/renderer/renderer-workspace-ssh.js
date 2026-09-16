/* global window, document, $, escapeHtml, updateWorkspaceLabel, invalidateWorkspaceArtifacts, renderArtifactsList, bindCurrentSessionWorkspace, restartTerminalSession, showAgentToast, connectRemoteGatewayLocked, resetRemoteGatewayClient, refreshRemoteGatewayMeta, refreshHistoryList, showOverlay, parentRemotePath, showTextPrompt, setSidePanelTab, getSidePanelTab, consumePendingSshTabRequest */
'use strict';

const wsApi = window.diecloud || {};

const workspaceMenuState = {
  open: false,
  remoteDirPath: '/',
  skipDirPickerAfterConnect: false,
  pendingSshPayload: null,
  deployProgressUnsub: null,
  deployHideTimer: null
};

const DEPLOY_BAR_WIDTH = 14;

function formatDeployProgressBar(percent, width = DEPLOY_BAR_WIDTH) {
  const p = Math.max(0, Math.min(100, Math.round(Number(percent) || 0)));
  const filled = Math.round((p / 100) * width);
  return `${'█'.repeat(filled)}${'▒'.repeat(Math.max(0, width - filled))} ${p}%`;
}

function clearSshDeployHideTimer() {
  if (workspaceMenuState.deployHideTimer) {
    clearTimeout(workspaceMenuState.deployHideTimer);
    workspaceMenuState.deployHideTimer = null;
  }
}

function waitForSshProgressPaint() {
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  });
}

function setSshDeployProgress(payload) {
  const wraps = document.querySelectorAll('[data-ssh-deploy-progress-wrap]');
  const bars = document.querySelectorAll('[data-ssh-deploy-progress]');
  const statusEl = $('ssh-panel-rg-status');

  if (!payload || payload.hidden) {
    wraps.forEach((w) => {
      w.hidden = true;
    });
    return;
  }

  clearSshDeployHideTimer();
  const bar = formatDeployProgressBar(payload.percent);
  let hint = payload.message || '';
  if (payload.phase === 'upload' && payload.file) {
    hint = hint ? `${hint} · ${payload.file}` : payload.file;
  }
  const line = hint ? `${bar}  ${hint}` : bar;

  bars.forEach((el) => {
    el.textContent = line;
    el.title = hint || bar;
  });
  wraps.forEach((w) => {
    w.hidden = false;
  });

  if (statusEl && !statusEl.hidden) {
    statusEl.textContent = `注入 Agent ${bar}${hint ? ` · ${hint}` : ''}`;
    statusEl.title = '';
    statusEl.className = 'ssh-panel-status is-pending';
  }
}

function beginSshDeployProgressWatch(opts = {}) {
  clearSshDeployHideTimer();
  if (!workspaceMenuState.deployProgressUnsub && wsApi.onSshRemoteAgentDeployProgress) {
    workspaceMenuState.deployProgressUnsub = wsApi.onSshRemoteAgentDeployProgress((p) => {
      setSshDeployProgress(p);
    });
  }
  setSshDeployProgress({
    phase: opts.phase || 'prepare',
    percent: opts.percent != null ? Number(opts.percent) : 0,
    message: opts.message || '准备…'
  });
}

function endSshDeployProgressWatch(delayHideMs = 900) {
  if (workspaceMenuState.deployProgressUnsub) {
    try {
      workspaceMenuState.deployProgressUnsub();
    } catch {
      // ignore
    }
    workspaceMenuState.deployProgressUnsub = null;
  }
  clearSshDeployHideTimer();
  if (delayHideMs < 0) return;
  if (delayHideMs === 0) {
    setSshDeployProgress(null);
    return;
  }
  workspaceMenuState.deployHideTimer = setTimeout(() => {
    workspaceMenuState.deployHideTimer = null;
    setSshDeployProgress(null);
  }, delayHideMs);
}

function setSshConnectLoading(loading) {
  const submit = $('ssh-connect-submit');
  const trust = $('ssh-host-key-trust');
  if (submit) {
    submit.disabled = !!loading;
    submit.textContent = loading ? '连接中…' : '连接';
  }
  if (trust) {
    trust.disabled = !!loading;
    if (!loading) {
      const isMismatch = !!($('ssh-host-key-saved-wrap') && !$('ssh-host-key-saved-wrap').hidden);
      trust.textContent = isMismatch ? '确认并更新指纹' : '信任并连接';
    } else {
      trust.textContent = '连接中…';
    }
  }
}

function formatSshFingerprint(fp) {
  if (!fp) return '(未知)';
  const raw = String(fp).trim().replace(/^SHA256:/i, '').replace(/:/g, '').toLowerCase();
  if (!raw) return '(未知)';
  if (raw.length <= 32) return raw;
  return raw.match(/.{1,2}/g)?.join(':') || raw;
}

function resetSshHostKeyConfirm() {
  workspaceMenuState.pendingSshPayload = null;
  const panel = $('ssh-host-key-confirm');
  const form = $('ssh-connect-form');
  const trust = $('ssh-host-key-trust');
  const savedWrap = $('ssh-host-key-saved-wrap');
  const newLabel = $('ssh-host-key-new-label');
  const hint = $('ssh-host-key-hint');
  if (panel) panel.hidden = true;
  if (form) form.classList.remove('is-awaiting-host-key');
  if (trust) trust.textContent = '信任并连接';
  if (savedWrap) savedWrap.hidden = true;
  if (newLabel) newLabel.textContent = '主机指纹';
  if (hint) {
    hint.textContent =
      '首次连接此主机，请核对指纹后再继续。确认后会保存该指纹；若服务器密钥日后变更，将阻止连接。';
  }
}

function showSshHostKeyConfirm(result, payload) {
  workspaceMenuState.pendingSshPayload = payload;
  const panel = $('ssh-host-key-confirm');
  const target = $('ssh-host-key-target');
  const fp = $('ssh-host-key-fingerprint');
  const savedWrap = $('ssh-host-key-saved-wrap');
  const savedFp = $('ssh-host-key-saved-fingerprint');
  const newLabel = $('ssh-host-key-new-label');
  const hint = $('ssh-host-key-hint');
  const trust = $('ssh-host-key-trust');
  const form = $('ssh-connect-form');
  const isMismatch = !!result.hostKeyMismatch;
  if (target) {
    target.textContent = `${result.username || payload.username || ''}@${result.host || payload.host}:${
      Number(result.port || payload.port) || 22
    }`;
  }
  if (hint) {
    hint.textContent = isMismatch
      ? '警告：该主机密钥与上次保存的不一致。可能是服务器重装了系统，也可能是中间人攻击。仅在确认服务器身份后再继续。'
      : '首次连接此主机，请核对指纹后再继续。确认后会保存该指纹；若服务器密钥日后变更，将阻止连接。';
  }
  if (savedWrap) savedWrap.hidden = !isMismatch;
  if (savedFp) savedFp.textContent = formatSshFingerprint(result.savedFingerprint);
  if (newLabel) newLabel.textContent = isMismatch ? '当前指纹' : '主机指纹';
  if (fp) fp.textContent = formatSshFingerprint(result.fingerprint);
  if (trust) trust.textContent = isMismatch ? '确认并更新指纹' : '信任并连接';
  if (form) form.classList.add('is-awaiting-host-key');
  if (panel) panel.hidden = false;
  setSshError('ssh-connect-error', '');
}

function setWorkspaceMenuOpen(open) {
  workspaceMenuState.open = !!open;
  const menu = $('composer-workspace-menu');
  const btn = $('btn-pick-workspace');
  if (menu) menu.hidden = !workspaceMenuState.open;
  if (btn) btn.setAttribute('aria-expanded', workspaceMenuState.open ? 'true' : 'false');
  if (workspaceMenuState.open) refreshWorkspaceMenuItems();
}

function updateSshPanelVisibility(ws) {
  const isSsh = !!(ws && ws.kind === 'ssh');
  const railBtn = document.querySelector('.side-panel-rail-btn[data-side-tab="ssh"]');
  const pane = document.querySelector('.side-panel-pane[data-side-pane="ssh"]');
  if (!railBtn && !pane) return;
  const wasActive = !!(pane && !pane.hidden);
  if (railBtn) railBtn.hidden = !isSsh;
  if (!isSsh) {
    if (pane) {
      pane.hidden = true;
      pane.classList.remove('active');
    }
    // 非 SSH 工作区丢弃被拦截的 SSH 页请求，避免它漂到之后的会话里
    if (typeof consumePendingSshTabRequest === 'function') consumePendingSshTabRequest();
    if (wasActive && typeof setSidePanelTab === 'function') {
      setSidePanelTab('files');
    }
    return;
  }
  // SSH 页显隐只跟随「当前侧栏页」，统一交给 setSidePanelTab 处理，
  // 保证同一时刻只有一个 pane 可见；否则原生 BrowserView 会与 SSH 面板垂直叠在一起。
  const activeTab =
    typeof getSidePanelTab === 'function' ? String(getSidePanelTab() || '') : '';
  if (pane && !pane.hidden && activeTab === 'ssh') return;
  const wanted =
    typeof consumePendingSshTabRequest === 'function' && consumePendingSshTabRequest();
  if (wanted && typeof setSidePanelTab === 'function') {
    setSidePanelTab('ssh');
    return;
  }
  if (pane) {
    pane.hidden = true;
    pane.classList.remove('active');
  }
}

function updateSshPanelInfo(ws, st) {
  const connEl = $('ssh-panel-conn');
  const hostEl = $('ssh-panel-host');
  const dirEl = $('ssh-panel-dir');
  const metaEl = $('ssh-panel-meta');
  const isSsh = !!(ws && ws.kind === 'ssh');
  const sshConnected = !!(st && st.connected);

  let connText = '未连接';
  let connCls = '';
  let hostText = '—';
  let dirText = '—';
  let metaText = '未连接';

  if (isSsh) {
    connText = sshConnected ? '已连接' : '已断开';
    connCls = sshConnected ? 'ssh-panel-conn-on' : 'ssh-panel-conn-off';
    hostText = ws.ssh
      ? `${ws.ssh.username || ''}@${ws.ssh.host || ''}:${Number(ws.ssh.port) || 22}`
      : '—';
    dirText = (ws.ssh && ws.ssh.remotePath) || '—';
    metaText = sshConnected ? '已连接' : '已断开';
  }

  if (connEl) {
    connEl.textContent = connText;
    if (connCls) connEl.className = connCls;
    else connEl.removeAttribute('class');
  }
  if (hostEl) hostEl.textContent = hostText;
  if (dirEl) dirEl.textContent = dirText || '—';
  if (metaEl) metaEl.textContent = metaText;
}

async function refreshWorkspaceMenuItems() {
  const menu = $('composer-workspace-menu');
  if (!menu) return;
  let ws = null;
  let st = { connected: false };
  try {
    if (wsApi.getWorkspace) ws = await wsApi.getWorkspace();
  } catch {
    // ignore
  }
  try {
    if (wsApi.sshStatus) st = await wsApi.sshStatus();
  } catch {
    // ignore
  }
  const isSsh = ws && ws.kind === 'ssh';
  const sshLinked = !!(st.connected && isSsh);
  const showReconnect = isSsh && !st.connected;
  updateSshPanelVisibility(ws);
  const el = (action) => document.querySelector(`[data-ws-action="${action}"]`);
  if (el('ssh-reconnect')) el('ssh-reconnect').hidden = !showReconnect;
  updateSshPanelInfo(ws, st);
  if (isSsh) {
    await refreshRemoteGatewayMenuStatus(true, sshLinked);
    refreshSshPanelAgentLog(sshLinked).catch(() => {});
  } else {
    await refreshRemoteGatewayMenuStatus(false, false);
    refreshSshPanelAgentLog(false).catch(() => {});
  }
}

async function refreshRemoteGatewayMenuStatus(isRemote, remoteLinked) {
  const statusEl = $('ssh-panel-rg-status');
  const retryBtn = document.querySelector('[data-ws-action="remote-gateway-retry"]');
  const logEl = $('ssh-panel-rg-log');
  if (!statusEl) return;
  if (!isRemote || !remoteLinked || !wsApi.sshRemoteGatewayStatus) {
    statusEl.hidden = false;
    statusEl.textContent = isRemote ? '连接已断开' : '当前工作空间非远程';
    statusEl.title = '';
    statusEl.className = 'ssh-panel-status';
    if (retryBtn) retryBtn.hidden = true;
    if (logEl) logEl.hidden = true;
    return;
  }
  statusEl.hidden = false;
  try {
    const st = await wsApi.sshRemoteGatewayStatus();
    if (st.sshBackend === 'sftp') {
      statusEl.textContent = '未启用 · SFTP 模式可用';
      statusEl.title = '将自动注入内置 Node；失败时走 SFTP';
      statusEl.className = 'ssh-panel-status is-ok';
      if (retryBtn) retryBtn.hidden = false;
      return;
    }
    const rg = st.remoteGateway || {};
    if (rg.deploying) {
      statusEl.textContent = '注入中…';
      statusEl.title = '';
      statusEl.className = 'ssh-panel-status is-pending';
      if (retryBtn) retryBtn.hidden = true;
    } else if (rg.active) {
      statusEl.textContent = `已启动 · 索引隧道 :${rg.localPort}`;
      statusEl.title = `远程索引 Agent ws://127.0.0.1:${rg.localPort}`;
      statusEl.className = 'ssh-panel-status is-ok';
      if (retryBtn) retryBtn.hidden = true;
    } else if (rg.lastError) {
      statusEl.textContent = `${String(rg.lastError).split('\n')[0].slice(0, 48)}`;
      statusEl.title = String(rg.lastError);
      statusEl.className = 'ssh-panel-status is-err';
      if (retryBtn) retryBtn.hidden = false;
    } else if (!st.packExists) {
      statusEl.textContent = '本地未打包';
      statusEl.title = '请运行 npm run pack:remote-gateway';
      statusEl.className = 'ssh-panel-status is-err';
      if (retryBtn) retryBtn.hidden = false;
    } else {
      statusEl.textContent = '未启动';
      statusEl.title = '';
      statusEl.className = 'ssh-panel-status is-pending';
      if (retryBtn) retryBtn.hidden = false;
    }
  } catch {
    statusEl.textContent = '状态未知';
    statusEl.title = '';
    statusEl.className = 'ssh-panel-status';
    if (retryBtn) retryBtn.hidden = false;
  }
}

const SFTP_FALLBACK_CODES = new Set([
  'REMOTE_GATEWAY_PACK_MISSING',
  'REMOTE_GATEWAY_SKIPPED'
]);

function isSftpFallbackResult(r) {
  return !!(r && !r.ok && r.code && SFTP_FALLBACK_CODES.has(r.code));
}

async function tryStartRemoteGateway() {
  const ensureFn = wsApi.sshEnsureRemoteGateway;
  if (!ensureFn) return null;
  beginSshDeployProgressWatch({ phase: 'prepare', percent: 55, message: '准备注入…' });
  if (typeof refreshRemoteGatewayMeta === 'function') {
    void refreshRemoteGatewayMeta({ loading: true });
  }
  let r = null;
  try {
    r = await ensureFn();
  } finally {
    if (r && r.ok) {
      setSshDeployProgress({ phase: 'done', percent: 100, message: '完成' });
    }
    endSshDeployProgressWatch(r && r.ok ? 1200 : 400);
  }
  if (r && r.ok && r.remoteGateway) {
    if (typeof refreshRemoteGatewayMeta === 'function') await refreshRemoteGatewayMeta();
    if (typeof refreshWorkspaceMenuItems === 'function') await refreshWorkspaceMenuItems();
    if (typeof refreshHistoryList === 'function') refreshHistoryList().catch(() => {});
    showAgentToast(
      '远程索引 Agent 已就绪',
      `索引隧道 :${r.remoteGateway.port} · 工具经 Local Gateway`,
      { variant: 'success' }
    );
    return r;
  }
  if (typeof refreshRemoteGatewayMeta === 'function') await refreshRemoteGatewayMeta();
  if (typeof refreshWorkspaceMenuItems === 'function') await refreshWorkspaceMenuItems();
  if (isSftpFallbackResult(r)) {
    const hint =
      r.code === 'REMOTE_GATEWAY_PACK_MISSING'
        ? '请在本机运行 npm run pack:remote-gateway，或使用 npm run dev 启动'
        : '远程 Agent 未部署，已使用 SFTP 模式';
    showAgentToast('SSH 远程模式', hint, { variant: 'info' });
    return r;
  }
  const detail = r?.detail ? `\n${r.detail}` : '';
  let msg = `${r?.error || '启动失败'}${detail}`.trim().slice(0, 500);
  if (/未安装 Node\.js|需要 18\+/i.test(msg)) {
    msg =
      '当前客户端版本过旧（仍在检测系统 Node）。请用最新源码 npm run dev 启动，或重新 build 安装包。\n\n' +
      '新版会自动注入内置 Node 到 ~/.dieyun/remote-agent/，无需服务器安装 Node。';
  }
  showAgentToast(
    '远程 Agent 未启动',
    `${msg}\n\n文件操作仍可通过 SFTP 使用`,
    { variant: 'warn' }
  );
  return r;
}

async function refreshSshPanelAgentLog(sshLinked) {
  const logEl = $('ssh-panel-rg-log');
  if (!logEl) return;
  const pane = document.querySelector('.side-panel-pane[data-side-pane="ssh"]');
  const paneVisible = !!(pane && !pane.hidden);
  if (!sshLinked || !paneVisible || !wsApi.sshRemoteAgentLog) {
    if (!sshLinked) {
      logEl.hidden = true;
      logEl.textContent = '';
    }
    return;
  }
  if (refreshSshPanelAgentLog._busy) return;
  refreshSshPanelAgentLog._busy = true;
  try {
    const r = await wsApi.sshRemoteAgentLog({ lines: 40 });
    if (!r || !r.ok) {
      logEl.hidden = true;
      logEl.textContent = '';
      return;
    }
    const raw = String(r.log || '').trim();
    if (!raw || raw === '(无 agent.log)') {
      logEl.textContent = '(暂无日志)';
      logEl.title = r.path || 'agent.log';
      logEl.hidden = false;
      return;
    }
    const lines = raw.split('\n');
    logEl.textContent = lines.slice(-30).join('\n');
    logEl.title = r.path || 'agent.log';
    logEl.hidden = false;
  } catch {
    logEl.hidden = true;
    logEl.textContent = '';
  } finally {
    refreshSshPanelAgentLog._busy = false;
  }
}

window.tryStartRemoteGateway = tryStartRemoteGateway;

function setSshError(elId, msg) {
  const el = $(elId);
  if (!el) return;
  if (msg) {
    el.textContent = msg;
    el.hidden = false;
  } else {
    el.textContent = '';
    el.hidden = true;
  }
}

async function loadSshProfileIntoForm(ws) {
  const host = $('ssh-connect-host');
  const port = $('ssh-connect-port');
  const user = $('ssh-connect-user');
  if (host && ws && ws.ssh) host.value = ws.ssh.host || '';
  if (port && ws && ws.ssh) port.value = String(ws.ssh.port || 22);
  if (user && ws && ws.ssh) user.value = ws.ssh.username || '';

  const remember = $('ssh-connect-remember');
  const pass = $('ssh-connect-password');
  const keyPath = $('ssh-connect-key-path');
  const keyPass = $('ssh-connect-key-passphrase');
  const hint = $('ssh-connect-encrypt-hint');
  if (pass) pass.value = '';
  if (keyPass) keyPass.value = '';

  let profile = null;
  if (wsApi.sshGetProfile && host && user && host.value && user.value) {
    try {
      profile = await wsApi.sshGetProfile({
        host: host.value,
        port: port ? port.value : 22,
        username: user.value
      });
    } catch {
      // ignore
    }
  }

  if (profile) {
    if (remember) remember.checked = !!profile.remember;
    if (keyPath) keyPath.value = profile.authType === 'key' ? profile.privateKeyPath || '' : '';
    if (hint) {
      if (profile.remember && !profile.canEncrypt) {
        hint.textContent = '当前系统无法加密存储凭据，记住登录可能不可用';
        hint.hidden = false;
      } else if (profile.remember && profile.hasSecret) {
        hint.textContent =
          profile.authType === 'key'
            ? '已保存私钥登录信息，连接时将自动填充'
            : '已保存登录信息，连接时将自动填充密码';
        hint.hidden = false;
      } else {
        hint.hidden = true;
      }
    }
  } else {
    if (remember) remember.checked = false;
    if (keyPath) keyPath.value = '';
    if (hint) hint.hidden = true;
  }
}

async function pickLocalWorkspace() {
  if (!wsApi.pickFolder || !wsApi.setLocalWorkspace) return;
  if (
    typeof window.currentSessionHasActiveRemoteRun === 'function' &&
    window.currentSessionHasActiveRemoteRun()
  ) {
    showAgentToast(
      '无法切换',
      '当前对话有远程任务正在运行，请等待完成、切换到其他对话后再选本地文件夹',
      { variant: 'warn' }
    );
    return;
  }
  const folder = await wsApi.pickFolder();
  if (!folder) return;
  const ws = await wsApi.setLocalWorkspace(folder);
  updateWorkspaceLabel(ws);
  invalidateWorkspaceArtifacts();
  await bindCurrentSessionWorkspace(ws && ws.workspacePath ? ws.workspacePath : folder);
  if (typeof ensureDefaultWorkspaceEditor === 'function') {
    await ensureDefaultWorkspaceEditor({ force: true });
  }
  if (typeof restartTerminalSession === 'function') restartTerminalSession();
  if (!$('artifacts-panel')?.hidden) renderArtifactsList();
}

async function clearWorkspaceToDefault() {
  if (!wsApi.setLocalWorkspace) return;
  const ws = await wsApi.setLocalWorkspace(null);
  updateWorkspaceLabel(ws);
  invalidateWorkspaceArtifacts();
  await bindCurrentSessionWorkspace(null);
  if (typeof restartTerminalSession === 'function') restartTerminalSession();
  if (!$('artifacts-panel')?.hidden) renderArtifactsList();
}

function openSshConnectModal(opts) {
  setSshError('ssh-connect-error', '');
  resetSshHostKeyConfirm();
  workspaceMenuState.skipDirPickerAfterConnect = !!(opts && opts.reconnectOnly);
  setSshConnectLoading(false);
  loadSshProfileIntoForm(opts && opts.workspace).catch(() => {});
  showOverlay('ssh-connect-overlay', true);
  const host = $('ssh-connect-host');
  if (host) host.focus();
}

function closeSshConnectModal(opts = {}) {
  showOverlay('ssh-connect-overlay', false);
  workspaceMenuState.skipDirPickerAfterConnect = false;
  setSshConnectLoading(false);
  resetSshHostKeyConfirm();
  if (opts.clearProgress) endSshDeployProgressWatch(0);
}

async function bindSshRemotePath(remotePath) {
  if (!wsApi.setSshRemotePath) {
    throw new Error('工作空间服务未就绪');
  }
  beginSshDeployProgressWatch({ phase: 'bind', percent: 40, message: '绑定工作目录…' });
  const ws = await wsApi.setSshRemotePath(remotePath || '/');
  let linked = !!(ws && ws.sshConnected);
  if (!linked && wsApi.sshStatus) {
    try {
      const st = await wsApi.sshStatus();
      linked = !!(st && st.connected);
    } catch {
      // ignore
    }
  }
  if (!linked) {
    throw new Error('工作空间绑定失败');
  }
  // setSshRemotePath 可能因池 key（含远程目录）误报 sshConnected:false，标签以实际连通为准
  updateWorkspaceLabel(
    ws && !ws.sshConnected ? { ...ws, sshConnected: true } : ws
  );
  invalidateWorkspaceArtifacts();
  if (ws.workspacePath) await bindCurrentSessionWorkspace(ws.workspacePath);
  await tryStartRemoteGateway();
  if (typeof restartTerminalSession === 'function') restartTerminalSession();
  if (!$('artifacts-panel')?.hidden) renderArtifactsList();
  return ws;
}

function sshPayloadMatchesWorkspace(ws, host, port, username) {
  if (!ws || ws.kind !== 'ssh' || !ws.ssh) return false;
  return (
    String(ws.ssh.host || '').trim() === String(host || '').trim() &&
    String(ws.ssh.username || '').trim() === String(username || '').trim() &&
    (Number(ws.ssh.port) || 22) === (Number(port) || 22)
  );
}

async function resolveSshPickerStartPath(preferred) {
  const pref = String(preferred || '').trim();
  if (pref && pref !== '/') return pref;
  if (wsApi.sshHome) {
    try {
      const r = await wsApi.sshHome();
      if (r && r.home) return r.home;
    } catch {
      // ignore
    }
  }
  return pref || '/';
}

async function finishSshConnectFlow(payload, reconnectOnly) {
  const host = payload.host;
  const port = payload.port;
  const username = payload.username;

  let wsBefore = null;
  try {
    if (wsApi.getWorkspace) wsBefore = await wsApi.getWorkspace();
  } catch {
    // ignore
  }

  const sameHost = sshPayloadMatchesWorkspace(wsBefore, host, port, username);
  const savedRemotePath =
    sameHost && wsBefore.ssh && wsBefore.ssh.remotePath && wsBefore.ssh.remotePath !== '/'
      ? wsBefore.ssh.remotePath
      : null;

  if (reconnectOnly && savedRemotePath) {
    try {
      await bindSshRemotePath(savedRemotePath);
      closeSshConnectModal();
      return;
    } catch (err) {
      if (reconnectOnly) {
        setSshError('ssh-connect-error', (err && err.message) || String(err));
        endSshDeployProgressWatch(400);
        return;
      }
    }
  }

  closeSshConnectModal();
  beginSshDeployProgressWatch({ phase: 'connect', percent: 36, message: '已连通，选择工作目录…' });
  const startPath = await resolveSshPickerStartPath(savedRemotePath || '/');
  await openRemoteDirPicker(startPath);
}

async function submitSshConnect(e, opts = {}) {
  if (e) e.preventDefault();
  if (!wsApi.sshConnect) {
    setSshError('ssh-connect-error', 'SSH 服务未就绪，请重启应用');
    return;
  }
  setSshError('ssh-connect-error', '');

  const host = ($('ssh-connect-host') && $('ssh-connect-host').value) || '';
  const port = ($('ssh-connect-port') && $('ssh-connect-port').value) || '22';
  const username = ($('ssh-connect-user') && $('ssh-connect-user').value) || '';
  const remember = !!($('ssh-connect-remember') && $('ssh-connect-remember').checked);
  const privateKeyPath = ($('ssh-connect-key-path') && $('ssh-connect-key-path').value) || '';
  const useKey = !!privateKeyPath.trim();
  const payload = {
    host,
    port,
    username,
    authType: useKey ? 'key' : 'password',
    remember,
    acceptNewHostKey: opts.acceptNewHostKey === true
  };

  if (useKey) {
    payload.privateKeyPath = privateKeyPath.trim();
    payload.passphrase = ($('ssh-connect-key-passphrase') && $('ssh-connect-key-passphrase').value) || '';
  } else {
    payload.password = ($('ssh-connect-password') && $('ssh-connect-password').value) || '';
    if (!payload.password && !remember) {
      setSshError('ssh-connect-error', '请输入密码或选择私钥文件');
      return;
    }
    if (!payload.password && remember && wsApi.sshGetProfile) {
      const profile = await wsApi.sshGetProfile({ host, port, username });
      if (!profile || !profile.hasSecret || profile.authType === 'key') {
        setSshError('ssh-connect-error', '无已保存密码，请输入密码或选择私钥');
        return;
      }
    }
  }

  resetSshHostKeyConfirm();
  setSshConnectLoading(true);
  beginSshDeployProgressWatch({ phase: 'connect', percent: 6, message: '正在连接…' });
  await waitForSshProgressPaint();
  try {
    const connResult = await wsApi.sshConnect(payload);
    if (connResult && connResult.needHostKeyTrust) {
      endSshDeployProgressWatch(0);
      showSshHostKeyConfirm(connResult, payload);
      return;
    }
    if (connResult && connResult.connected === false && connResult.ok !== true) {
      throw new Error('SSH 连接未就绪，请重试');
    }

    beginSshDeployProgressWatch({ phase: 'connect', percent: 32, message: '已连通…' });
    await finishSshConnectFlow(
      { host: host.trim(), port, username: username.trim() },
      workspaceMenuState.skipDirPickerAfterConnect
    );
  } catch (err) {
    setSshError('ssh-connect-error', (err && err.message) || String(err));
    endSshDeployProgressWatch(400);
  } finally {
    setSshConnectLoading(false);
  }
}

async function trustSshHostKeyAndConnect() {
  const payload = workspaceMenuState.pendingSshPayload;
  if (!payload) return;
  setSshError('ssh-connect-error', '');
  setSshConnectLoading(true);
  beginSshDeployProgressWatch({ phase: 'connect', percent: 6, message: '正在连接…' });
  await waitForSshProgressPaint();
  try {
    const connResult = await wsApi.sshConnect({ ...payload, acceptNewHostKey: true });
    if (connResult && connResult.needHostKeyTrust) {
      throw new Error('主机指纹确认失败，请重试');
    }
    if (connResult && connResult.connected === false && connResult.ok !== true) {
      throw new Error('SSH 连接未就绪，请重试');
    }
    resetSshHostKeyConfirm();
    beginSshDeployProgressWatch({ phase: 'connect', percent: 32, message: '已连通…' });
    await finishSshConnectFlow(
      {
        host: String(payload.host || '').trim(),
        port: payload.port,
        username: String(payload.username || '').trim()
      },
      workspaceMenuState.skipDirPickerAfterConnect
    );
  } catch (err) {
    setSshError('ssh-connect-error', (err && err.message) || String(err));
    endSshDeployProgressWatch(400);
  } finally {
    setSshConnectLoading(false);
  }
}

const SSH_REMOTE_DIR_UP_ICON =
  '<span class="ssh-remote-dir-icon" aria-hidden="true">' +
  '<svg viewBox="0 0 24 24" width="16" height="16">' +
  '<path d="M15 6l-6 6 6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>' +
  '</svg></span><span>..</span>';

const SSH_REMOTE_DIR_FOLDER_ICON =
  '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">' +
  '<path d="M3 7a2 2 0 012-2h5l2 2h9a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V7z" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linejoin="round"/>' +
  '</svg>';

const SSH_REMOTE_DIR_FILE_ICON =
  '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">' +
  '<path d="M8 3h6l5 5v13a1 1 0 01-1 1H8a1 1 0 01-1-1V4a1 1 0 011-1z" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linejoin="round"/>' +
  '<path d="M14 3v5h5" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linejoin="round"/>' +
  '</svg>';

async function renderRemoteDirList(remotePath, opts = {}) {
  const listEl = $('ssh-remote-dir-list');
  const pathEl = $('ssh-remote-dir-path');
  if (!listEl || !wsApi.sshBrowse) return;
  workspaceMenuState.remoteDirPath = remotePath || '/';
  if (pathEl) {
    if ('value' in pathEl) pathEl.value = workspaceMenuState.remoteDirPath;
    else pathEl.textContent = workspaceMenuState.remoteDirPath;
  }
  listEl.innerHTML = '<div class="artifacts-empty">加载中…</div>';
  setSshError('ssh-remote-dir-error', '');
  try {
    const r = await wsApi.sshBrowse(workspaceMenuState.remoteDirPath);
    const entries = (r && r.entries) || [];
    listEl.innerHTML = '';
    if (workspaceMenuState.remoteDirPath !== '/') {
      const up = document.createElement('button');
      up.type = 'button';
      up.className = 'ssh-remote-dir-item ssh-remote-dir-up';
      up.innerHTML = SSH_REMOTE_DIR_UP_ICON;
      up.addEventListener('click', () => {
        renderRemoteDirList(parentRemotePath(workspaceMenuState.remoteDirPath)).catch(() => {});
      });
      listEl.appendChild(up);
    }
    if (!entries.length) {
      const empty = document.createElement('div');
      empty.className = 'artifacts-empty';
      empty.textContent = '空目录';
      listEl.appendChild(empty);
      return;
    }
    for (const ent of entries) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'ssh-remote-dir-item';
      if (ent.isDirectory) row.classList.add('is-dir');
      const icon = ent.isDirectory ? SSH_REMOTE_DIR_FOLDER_ICON : SSH_REMOTE_DIR_FILE_ICON;
      row.innerHTML =
        '<span class="ssh-remote-dir-icon">' +
        icon +
        '</span><span class="ssh-remote-dir-name">' +
        escapeHtml(ent.name) +
        '</span>';
      row.addEventListener('click', () => {
        if (ent.isDirectory) {
          const base = workspaceMenuState.remoteDirPath.replace(/\/+$/, '') || '';
          const next = (base + '/' + ent.name).replace(/\/+/g, '/');
          renderRemoteDirList(next).catch(() => {});
        } else {
          for (const item of listEl.querySelectorAll('.ssh-remote-dir-item')) {
            item.classList.remove('active');
          }
          row.classList.add('active');
        }
      });
      row.addEventListener('dblclick', () => {
        if (ent.isDirectory) {
          const base = workspaceMenuState.remoteDirPath.replace(/\/+$/, '') || '';
          const next = (base + '/' + ent.name).replace(/\/+/g, '/');
          renderRemoteDirList(next).catch(() => {});
        }
      });
      listEl.appendChild(row);
    }
  } catch (err) {
    const atRoot = workspaceMenuState.remoteDirPath === '/';
    if (atRoot && !opts.skipHomeFallback) {
      const home = await resolveSshPickerStartPath('/');
      if (home && home !== '/') {
        await renderRemoteDirList(home, { skipHomeFallback: true });
        return;
      }
    }
    const msg = (err && err.message) || String(err);
    listEl.innerHTML = '';
    const empty = document.createElement('div');
    empty.className = 'artifacts-empty';
    empty.textContent = '加载失败';
    listEl.appendChild(empty);
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.className = 'ssh-remote-dir-item';
    retry.textContent = '重试';
    retry.addEventListener('click', () => {
      renderRemoteDirList(workspaceMenuState.remoteDirPath, { skipHomeFallback: true }).catch(() => {});
    });
    listEl.appendChild(retry);
    setSshError('ssh-remote-dir-error', msg);
  }
}

async function openRemoteDirPicker(startPath) {
  workspaceMenuState.remoteDirPath = startPath || '/';
  showOverlay('ssh-remote-dir-overlay', true);
  await renderRemoteDirList(workspaceMenuState.remoteDirPath);
}

function closeRemoteDirPicker(opts = {}) {
  showOverlay('ssh-remote-dir-overlay', false);
  setSshError('ssh-remote-dir-error', '');
  if (opts.clearProgress) endSshDeployProgressWatch(0);
}

async function confirmRemoteDir() {
  if (!wsApi.setSshRemotePath) return;
  setSshError('ssh-remote-dir-error', '');
  const selectBtn = $('ssh-remote-dir-select');
  if (selectBtn) selectBtn.disabled = true;
  try {
    await bindSshRemotePath(workspaceMenuState.remoteDirPath);
    closeRemoteDirPicker();
  } catch (err) {
    setSshError('ssh-remote-dir-error', (err && err.message) || String(err));
  } finally {
    if (selectBtn) selectBtn.disabled = false;
  }
}

async function disconnectSshIfConnected() {
  let sshWasConnected = false;
  if (wsApi.sshStatus && wsApi.sshDisconnect) {
    try {
      const st = await wsApi.sshStatus();
      sshWasConnected = !!(st && st.connected);
      if (sshWasConnected) await disconnectSsh();
    } catch {
      // ignore
    }
  }
  // SSH 已断但 remoteGwState 仍可能指向失效隧道（切换会话时 artifact 等 RPC 会失败）
  if (!sshWasConnected && typeof resetRemoteGatewayClient === 'function') {
    resetRemoteGatewayClient();
    if (typeof refreshRemoteGatewayMeta === 'function') void refreshRemoteGatewayMeta();
  }
}

async function disconnectSsh(opts = {}) {
  let force = opts.force === true;
  let result = null;
  if (wsApi.sshDisconnect) result = await wsApi.sshDisconnect({ force: false });
  if (result && result.kept && !force) {
    const n = Number(result.leaseCount) || (result.leasedSessions || []).length || 0;
    const ok =
      typeof confirm === 'function'
        ? confirm(
            (n > 0
              ? `仍有 ${n} 个会话占用该 SSH（后台任务 lease）。\n`
              : '仍有后台会话占用该 SSH。\n') +
              '强制断开将释放占用并切断连接；相关远程任务可能失败。\n\n确定强制断开？'
          )
        : true;
    if (!ok) {
      if (typeof showAgentToast === 'function') {
        showAgentToast('已取消断开', '连接仍由后台会话占用', { variant: 'info' });
      }
      return { ...result, cancelled: true };
    }
    force = true;
    result = await wsApi.sshDisconnect({ force: true });
  }
  if (result && result.kept) {
    if (typeof showAgentToast === 'function') {
      showAgentToast('断开失败', '连接仍被后台占用，请稍后重试', { variant: 'warn' });
    }
    return result;
  }
  if (force && typeof cancelActiveAgentBackends === 'function') {
    try {
      cancelActiveAgentBackends('强制断开 SSH');
    } catch {
      // ignore
    }
  }
  closeRemoteDirPicker();
  closeSshConnectModal();
  let ws = null;
  if (wsApi.getWorkspace) {
    try {
      ws = await wsApi.getWorkspace();
    } catch {
      // ignore
    }
  }
  if (ws) updateWorkspaceLabel({ ...ws, sshConnected: false });
  invalidateWorkspaceArtifacts();
  if (typeof restartTerminalSession === 'function') restartTerminalSession();
  if (typeof resetRemoteGatewayClient === 'function') resetRemoteGatewayClient();
  if (typeof refreshRemoteGatewayMeta === 'function') await refreshRemoteGatewayMeta();
  if (typeof refreshWorkspaceMenuItems === 'function') await refreshWorkspaceMenuItems();
  if (typeof showAgentToast === 'function') {
    showAgentToast(force ? '已强制断开 SSH' : '已断开 SSH', '', { variant: 'info' });
  }
  return result;
}

async function handleWorkspaceMenuAction(action) {
  setWorkspaceMenuOpen(false);
  if (action === 'local') {
    await pickLocalWorkspace();
    return;
  }
  if (action === 'clear') {
    await clearWorkspaceToDefault();
    return;
  }
  if (action === 'ssh') {
    openSshConnectModal({});
    return;
  }
  if (action === 'ssh-reconnect') {
    let ws = null;
    try {
      if (wsApi.getWorkspace) ws = await wsApi.getWorkspace();
    } catch {
      // ignore
    }
    openSshConnectModal({ workspace: ws, reconnectOnly: true });
    return;
  }
  if (action === 'remote-gateway-retry') {
    await tryStartRemoteGateway();
    return;
  }
}

function initWorkspacePicker() {
  const wrap = $('composer-workspace-wrap');
  const btn = $('btn-pick-workspace');
  const menu = $('composer-workspace-menu');
  if (!btn || !menu) return;

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    setWorkspaceMenuOpen(!workspaceMenuState.open);
  });

  menu.addEventListener('click', (e) => {
    const item = e.target.closest('[data-ws-action]');
    if (!item) return;
    const action = item.getAttribute('data-ws-action');
    if (action) handleWorkspaceMenuAction(action).catch((err) => console.warn(err));
  });

  const sshPanel = $('ssh-panel-stats');
  if (sshPanel) {
    sshPanel.addEventListener('click', (e) => {
      const item = e.target.closest('[data-ws-action]');
      if (!item || !sshPanel.contains(item)) return;
      const action = item.getAttribute('data-ws-action');
      if (action) handleWorkspaceMenuAction(action).catch((err) => console.warn(err));
    });
  }

  const sshPanelRefresh = $('ssh-panel-refresh');
  if (sshPanelRefresh) {
    sshPanelRefresh.addEventListener('click', () => {
      refreshWorkspaceMenuItems().catch((err) => console.warn(err));
    });
  }

  document.addEventListener('click', (e) => {
    if (!workspaceMenuState.open) return;
    if (wrap && !wrap.contains(e.target)) setWorkspaceMenuOpen(false);
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && workspaceMenuState.open) setWorkspaceMenuOpen(false);
  });

  const pickKeyBtn = $('ssh-connect-pick-key');
  if (pickKeyBtn && wsApi.pickPrivateKey) {
    pickKeyBtn.addEventListener('click', async () => {
      const p = await wsApi.pickPrivateKey();
      const keyPath = $('ssh-connect-key-path');
      if (p && keyPath) keyPath.value = p;
    });
  }

  const hostInput = $('ssh-connect-host');
  const userInput = $('ssh-connect-user');
  const portInput = $('ssh-connect-port');
  const reloadProfile = () => {
    loadSshProfileIntoForm({
      ssh: {
        host: hostInput ? hostInput.value : '',
        port: portInput ? portInput.value : 22,
        username: userInput ? userInput.value : ''
      }
    }).catch(() => {});
  };
  if (hostInput) hostInput.addEventListener('blur', reloadProfile);
  if (userInput) userInput.addEventListener('blur', reloadProfile);

  const connectForm = $('ssh-connect-form');
  if (connectForm) {
    connectForm.addEventListener('submit', (e) => {
      submitSshConnect(e).catch((err) => {
        console.warn('ssh connect failed', err);
        setSshError('ssh-connect-error', (err && err.message) || String(err));
        setSshConnectLoading(false);
      });
    });
  }
  const hostKeyTrust = $('ssh-host-key-trust');
  const hostKeyCancel = $('ssh-host-key-cancel');
  if (hostKeyTrust) {
    hostKeyTrust.addEventListener('click', () => {
      trustSshHostKeyAndConnect().catch((err) => {
        console.warn('ssh host key trust failed', err);
        setSshError('ssh-connect-error', (err && err.message) || String(err));
        setSshConnectLoading(false);
      });
    });
  }
  if (hostKeyCancel) {
    hostKeyCancel.addEventListener('click', () => {
      resetSshHostKeyConfirm();
      setSshError('ssh-connect-error', '');
    });
  }
  const connectClose = $('ssh-connect-close');
  const connectCancel = $('ssh-connect-cancel');
  if (connectClose) connectClose.addEventListener('click', () => closeSshConnectModal({ clearProgress: true }));
  if (connectCancel) connectCancel.addEventListener('click', () => closeSshConnectModal({ clearProgress: true }));

  const dirClose = $('ssh-remote-dir-close');
  const dirCancel = $('ssh-remote-dir-cancel');
  const dirSelect = $('ssh-remote-dir-select');
  if (dirClose) dirClose.addEventListener('click', () => closeRemoteDirPicker({ clearProgress: true }));
  if (dirCancel) dirCancel.addEventListener('click', () => closeRemoteDirPicker({ clearProgress: true }));
  if (dirSelect) {
    dirSelect.addEventListener('click', () => confirmRemoteDir().catch((err) => console.warn(err)));
  }
  const dirPath = $('ssh-remote-dir-path');
  if (dirPath && dirPath.tagName === 'INPUT') {
    dirPath.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const next = String(dirPath.value || '').trim() || '/';
      renderRemoteDirList(next.startsWith('/') ? next : `/${next}`).catch(() => {});
    });
  }

  if (wsApi.getWorkspace) {
    wsApi
      .getWorkspace()
      .then((ws) => updateWorkspaceLabel(ws))
      .catch(() => {});
  }
}

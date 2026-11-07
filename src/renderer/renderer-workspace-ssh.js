/* global window, document, $, escapeHtml, currentSessionId, updateWorkspaceLabel, invalidateWorkspaceArtifacts, renderArtifactsList, refreshProductsPanelIfActive, bindCurrentSessionWorkspace, restartTerminalSession, showAgentToast, connectRemoteGatewayLocked, resetRemoteGatewayClient, refreshRemoteGatewayMeta, refreshHistoryList, showOverlay, parentRemotePath, showTextPrompt, setSidePanelTab, getSidePanelTab, consumePendingSshTabRequest */
'use strict';

const wsApi = window.diecloud || {};

/**
 * 切换本地工作空间要 preload 的 `setLocalWorkspace`（写服务端工作区根 + 会话绑定）。
 *
 * 两个界面形态的差别只在「怎么拿到目录」：
 *  - 桌面窗口：`pickFolder` 弹系统目录框；
 *  - 浏览器版（headless 的 `/app/`）：没有原生目录框，改让用户填服务器上的绝对路径，
 *    服务端 `desktop.set_workspace` 会校验「存在且是目录」。
 *
 * 完全没有 `setLocalWorkspace` 的宿主必须说清「为什么不行」：以前 `pickLocalWorkspace`
 * 直接 `return`，用户点了「本地」什么都不会发生，看起来像界面坏了（2026-11-05 现场）。
 */
function localWorkspaceSwitchHint() {
  return '这个界面不能切换工作空间：没有可用的切换通道（请用桌面客户端，或改服务端 --workspace / DIEYUN_WORKSPACE 后重启）';
}

/** 能否切换工作空间：有写通道即可，拿目录的方式按宿主能力挑 */
function canSwitchLocalWorkspace() {
  return !!wsApi.setLocalWorkspace;
}

const workspaceMenuState = {
  open: false,
  remoteDirPath: '/',
  /** 目录选择浮层的用途：'ssh' = 选远端目录（连上 SSH 后绑）；'local' = 选本机/服务器上的工作区 */
  dirPickerMode: 'ssh',
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

/**
 * SSH 面板的唯一刷新入口（点侧栏页 / 开工作空间菜单 / 连接流程 / 「刷新」按钮都走这里）。
 *
 * 三条口径，对应「点一下卡一下、状态过一会儿才出来」：
 * 1. 本地就能拿到的三行（连接状态 / 主机 / 远程目录）先画，不等任何远端往返；
 * 2. 需要远端的三块（索引 Agent / agent.log / 会话副本）各自发起、谁也不挡谁 ——
 *    以前是一条 await 链，谁慢谁把后面全拖住；
 * 3. 同一时刻只跑一轮：正在跑时被再叫到，只记一个「跑完再来一次」。远端 exec 在一条
 *    连接内是串行的，一次点击排两份 tail + 两份 git status 只会让面板更晚出来。
 */
function refreshWorkspaceMenuItems() {
  if (refreshWorkspaceMenuItems._running) {
    refreshWorkspaceMenuItems._again = true;
    return refreshWorkspaceMenuItems._running;
  }
  const p = refreshWorkspaceMenuItemsOnce().finally(() => {
    refreshWorkspaceMenuItems._running = null;
    if (refreshWorkspaceMenuItems._again) {
      refreshWorkspaceMenuItems._again = false;
      refreshWorkspaceMenuItems().catch(() => {});
    }
  });
  refreshWorkspaceMenuItems._running = p;
  return p;
}

async function refreshWorkspaceMenuItemsOnce() {
  const menu = $('composer-workspace-menu');
  if (!menu) return;
  const [wsRes, stRes] = await Promise.allSettled([
    wsApi.getWorkspace ? wsApi.getWorkspace() : null,
    wsApi.sshStatus ? wsApi.sshStatus() : null
  ]);
  const ws = wsRes.status === 'fulfilled' ? wsRes.value : null;
  const st = (stRes.status === 'fulfilled' && stRes.value) || { connected: false };
  const isSsh = !!(ws && ws.kind === 'ssh');
  const sshLinked = !!(st.connected && isSsh);
  const showReconnect = isSsh && !st.connected;
  updateSshPanelVisibility(ws);
  const el = (action) => document.querySelector(`[data-ws-action="${action}"]`);
  if (el('ssh-reconnect')) el('ssh-reconnect').hidden = !showReconnect;
  updateSshPanelInfo(ws, st);
  // 远端三块互不等待：任何一块慢（甚至超时）都不能让另外两块跟着空白
  await Promise.allSettled([
    refreshRemoteGatewayMenuStatus(isSsh, sshLinked),
    refreshSshPanelAgentLog(sshLinked),
    refreshSessionWorktreePanel(sshLinked)
  ]);
}

/** 「会话副本」区块的上一次结果：同一会话重开面板时先给旧值，别先抹成 '—' 再等远端 */
const sessionWorktreePanelState = { sid: '', busy: false, again: false };

/**
 * 「会话副本」区块：这个会话在远端有自己的 worktree，改动要手动应用回主目录。
 *
 * 预览是一趟**远端 git status**（连接内 exec 串行），所以三个门都要把住：
 * 面板没显示就不发；同一时刻只发一条；只有换会话才把旧值清掉 ——
 * 原来每次刷新都先把「位置 / 未应用」抹成 '—' 再等远端，看起来就是「没刷出来」。
 */
async function refreshSessionWorktreePanel(sshLinked) {
  const applyBtn = document.querySelector('[data-ws-action="worktree-apply"]');
  const pathEl = $('ssh-panel-wt-path');
  const pendingEl = $('ssh-panel-wt-pending');
  const pane = document.querySelector('.side-panel-pane[data-side-pane="ssh"]');
  if (!pane || pane.hidden) return;
  const sid =
    typeof currentSessionId !== 'undefined' && currentSessionId ? String(currentSessionId) : '';
  const clear = () => {
    if (applyBtn) applyBtn.hidden = true;
    if (pathEl) {
      pathEl.textContent = '—';
      pathEl.title = '';
    }
    if (pendingEl) pendingEl.textContent = '—';
  };
  if (sessionWorktreePanelState.sid !== sid) {
    sessionWorktreePanelState.sid = sid;
    clear();
  }
  if (!sshLinked || !wsApi.worktreeRemotePreview) {
    clear();
    return;
  }
  if (sessionWorktreePanelState.busy) {
    // 在途的那趟是别的会话/别的时刻发的：跑完再按当前状态重来一次，别把它的结果写进来
    sessionWorktreePanelState.again = true;
    return;
  }
  sessionWorktreePanelState.busy = true;
  if (pendingEl && (!pendingEl.textContent || pendingEl.textContent === '—')) {
    pendingEl.textContent = '读取中…';
  }
  try {
    let r = null;
    try {
      r = await wsApi.worktreeRemotePreview({});
    } catch {
      if (pendingEl && pendingEl.textContent === '读取中…') pendingEl.textContent = '读取失败';
      return;
    }
    // 期间切了会话：这份结果属于上一条会话，写进去等于把别人的副本显示成当前会话的
    if (sessionWorktreePanelState.sid !== sid) return;
    if (!r || !r.ok) {
      // 读不出来就等于「不知道还有没有未应用的改动」：把动作收起来，别留一个前提无法验证的按钮
      if (applyBtn) applyBtn.hidden = true;
      if (pathEl && r && r.code !== 'not_session_worktree') pathEl.textContent = r.error || '—';
      if (pendingEl && pendingEl.textContent === '读取中…') pendingEl.textContent = '—';
      return;
    }
    if (pathEl) {
      const parts = String(r.wtPath || '').split('/').filter(Boolean);
      pathEl.textContent = parts.slice(-2).join('/') || '—';
      pathEl.title = r.wtPath || '';
    }
    if (pendingEl) pendingEl.textContent = r.files.length ? `${r.files.length} 个文件` : '无';
    if (applyBtn) applyBtn.hidden = r.files.length === 0;
  } finally {
    sessionWorktreePanelState.busy = false;
    if (sessionWorktreePanelState.again) {
      sessionWorktreePanelState.again = false;
      refreshSessionWorktreePanel(sshLinked).catch(() => {});
    }
  }
}

/** 应用会话副本改动到远端主目录（提交到副本分支 → 合并；冲突自动回滚主目录） */
async function applySessionWorktreeChanges() {
  if (!wsApi.worktreeRemotePreview || !wsApi.worktreeRemoteApply) return;
  let preview = null;
  try {
    preview = await wsApi.worktreeRemotePreview({});
  } catch (e) {
    showAgentToast('读取副本改动失败', (e && e.message) || String(e), { variant: 'warn' });
    return;
  }
  if (!preview || !preview.ok) {
    showAgentToast('无法应用', (preview && preview.error) || '未知原因', { variant: 'warn' });
    return;
  }
  if (!preview.files.length) {
    showAgentToast('没有需要应用的改动', '', { variant: 'info' });
    return;
  }
  const list = preview.files
    .slice(0, 8)
    .map((f) => `${f.code}  ${f.path}`)
    .join('\n');
  const more = preview.files.length > 8 ? `\n…还有 ${preview.files.length - 8} 个文件` : '';
  if (!confirm(`把 ${preview.files.length} 个文件的改动应用到主目录？\n\n${list}${more}`)) return;
  let r = null;
  try {
    r = await wsApi.worktreeRemoteApply({});
  } catch (e) {
    showAgentToast('应用失败', (e && e.message) || String(e), { variant: 'warn' });
    return;
  }
  if (r && r.ok) {
    showAgentToast('已应用到主目录', `${preview.files.length} 个文件已合并`, { variant: 'info' });
  } else {
    showAgentToast('应用失败', (r && r.error) || '未知原因', { variant: 'warn' });
  }
  refreshSessionWorktreePanel(true).catch(() => {});
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
      statusEl.textContent = `已启动 · 索引 Agent socket:${rg.socketPath || ''}`;
      statusEl.title = `远程索引 Agent ${rg.socketPath || ''}（经 SSH direct-streamlocal，无本地隧道）`;
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
  // 一趟 SSH 往返（远端 tail）才有内容：先把「在读」写出来，别让这块一直是空的
  if (!logEl.textContent) {
    logEl.textContent = '读取中…';
    logEl.hidden = false;
  }
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
  const credsReset = $('ssh-connect-credentials-reset');
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
      if (profile.storeCorrupt) {
        // 文件坏了：已保存的凭据读不出来。必须明说，否则用户以为「这台机器没记住」，
        // 随手勾上记住再保存 —— 保存已被 store 拦下（SECRET_STORE_CORRUPT），但提示要提前给。
        hint.textContent =
          '已保存的登录信息读不出来（SSH 凭据文件损坏），请重新填写；' +
          '现在保存会被拦下，以免覆盖其余主机';
        hint.hidden = false;
      } else if (profile.remember && !profile.canEncrypt) {
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
    if (credsReset) credsReset.hidden = !profile.storeCorrupt;
  } else {
    if (remember) remember.checked = false;
    if (keyPath) keyPath.value = '';
    if (hint) hint.hidden = true;
    if (credsReset) credsReset.hidden = true;
  }
}

/**
 * 备份坏掉的 `ssh-profiles.json` 并按空态重建，然后重读面板（选择「记住登录」后重新填写即可）。
 *
 * 不直接删文件：里面可能有还能人工救回的密文，改名备份是不可逆损失最小的做法。
 */
async function resetSshCredentialsStore() {
  if (!wsApi.sshCredentialsReset) return;
  if (
    !window.confirm(
      '把无法解析的 SSH 凭据文件改名备份，并按空态重建？重建后需要重新填写各主机的登录信息。'
    )
  ) {
    return;
  }
  try {
    const result = await wsApi.sshCredentialsReset();
    showAgentToast(
      'SSH 凭据文件已重建',
      result && result.moved
        ? `原文件已备份为 ${result.backupPath}，请重新填写登录信息`
        : '凭据文件本来就不存在，已按空态重建',
      { variant: 'info' }
    );
  } catch (err) {
    showAgentToast('重建失败', (err && err.message) || String(err), { variant: 'error' });
  }
  const ws = wsApi.getWorkspace ? await wsApi.getWorkspace().catch(() => null) : null;
  await loadSshProfileIntoForm(ws);
}

/**
 * 把「工作空间视图 + 当前会话绑定」一起切到 dir（null = 回到默认工作空间）。
 *
 * 这是本地工作空间切换的**唯一流程**，两个入口共用：
 * 用户在菜单里点「选择本地文件夹」（`pickLocalWorkspace`），和 Agent 收到「切到 XX 项目」
 * 时调的工具（`session_set_workspace`，见 applySessionWorkspaceFromTool）。
 * 别在这里之外再拼一遍「设视图 / 写会话行 / 重载编辑器 / 重启终端」。
 *
 * @param {string|null} dir
 * @returns {Promise<{ ok: boolean, workspacePath?: string, error?: string }>}
 */
async function applyLocalWorkspacePath(dir) {
  if (!wsApi.setLocalWorkspace) return { ok: false, error: localWorkspaceSwitchHint() };
  if (
    typeof window.currentSessionHasActiveRemoteRun === 'function' &&
    window.currentSessionHasActiveRemoteRun()
  ) {
    return { ok: false, error: '当前对话有远程任务正在运行，等它结束再切本地目录' };
  }
  const target = dir ? String(dir).trim() : '';
  const ws = await wsApi.setLocalWorkspace(target || null);
  if (!ws) return { ok: false, error: '设置工作空间失败' };
  const bound = ws.workspacePath ? String(ws.workspacePath) : target || null;
  updateWorkspaceLabel(ws);
  invalidateWorkspaceArtifacts();
  // 会话行 + 进程内上下文一起改（bindCurrentSessionWorkspace 是渲染器侧的单一入口）
  await bindCurrentSessionWorkspace(bound);
  if (bound && typeof ensureDefaultWorkspaceEditor === 'function') {
    await ensureDefaultWorkspaceEditor({ force: true });
  }
  if (typeof restartTerminalSession === 'function') restartTerminalSession();
  refreshWorkspaceScopedPanes();
  return { ok: true, workspacePath: bound || '' };
}

/**
 * 让用户挑一个目录，然后切过去。三条路按宿主能力选，只有一种目录交互：
 *  - 桌面窗口：`pickFolder` 弹系统目录框；
 *  - 浏览器版（headless `/app/`）：没有原生框，用**服务端目录浏览**（`browseServerDir`）
 *    打开下面那个目录选择浮层，从列表里点进去选；
 *  - 两者都没有：如实说不能切。
 */
async function pickLocalWorkspace() {
  if (!canSwitchLocalWorkspace()) {
    // 静默 return 会让「点本地没反应」变成一条查不出原因的故障报告
    showAgentToast('无法切换工作空间', localWorkspaceSwitchHint(), { variant: 'warn' });
    return;
  }
  if (typeof wsApi.pickFolder === 'function') {
    const folder = await wsApi.pickFolder();
    if (!folder) return;
    const res = await applyLocalWorkspacePath(folder);
    if (!res.ok && res.error) showAgentToast('无法切换', res.error, { variant: 'warn' });
    return;
  }
  if (typeof wsApi.browseServerDir === 'function') {
    let start = '';
    try {
      const ws = wsApi.getWorkspace ? await wsApi.getWorkspace() : null;
      start = (ws && ws.workspacePath) || '';
    } catch {
      start = '';
    }
    await openDirPicker('local', start || '/');
    return;
  }
  showAgentToast('无法切换工作空间', localWorkspaceSwitchHint(), { variant: 'warn' });
}

/**
 * Agent 工具 `session_set_workspace` 的渲染器执行体（桌面这条路的入口）。
 * 频道里同一个工具名由 Main 自己执行（`src/channels/workspace-switch.js`），不走这里。
 *
 * `args.sessionId` 是这一轮真正跑的会话（由工具委派带来）。它不在前台时只改那条会话的绑定，
 * 不动桌面视图 —— 否则后台会话一换项目，用户正在看的目录就被换掉了。
 *
 * @param {{ workspace?: string, sessionId?: string }} args
 * @returns {Promise<{ ok: boolean, workspacePath?: string, note?: string, error?: string }>}
 */
async function applySessionWorkspaceFromTool(args) {
  const raw = String((args && args.workspace) || '').trim();
  // 「回默认」的判据只有 schema 声明的那一个哨兵值（tool-catalog: 传 "default" 回到默认工作空间）。
  // 以前还认「默认」「默认工作空间」两个中文串 —— 那是拿词表去补模型没读 schema 的情况，
  // 同一份词表在频道侧 `channels/workspace-switch.js` 也有一份，两边会各自漂移。
  const isDefault = raw.toLowerCase() === 'default';
  if (!raw) {
    const current =
      (typeof window !== 'undefined' && window.activeViewSessionWorkspacePath) || '默认工作空间';
    return { ok: false, error: `未指定 workspace，当前是 ${current}。要切就给绝对路径，回默认传 "default"。` };
  }
  const target = isDefault ? '' : raw;
  const runSid = String((args && args.sessionId) || '');
  const curSid = typeof currentSessionId !== 'undefined' ? String(currentSessionId || '') : '';
  if (runSid && curSid && runSid !== curSid) {
    await bindCurrentSessionWorkspace(runSid, target || null);
    return {
      ok: true,
      workspacePath: target,
      note: '已切换这条会话的工作空间；它不在前台，桌面正在看的目录没有动。新目录从下一轮生效。'
    };
  }
  const res = await applyLocalWorkspacePath(target || null);
  if (!res.ok) return { ok: false, error: res.error || '切换失败' };
  return {
    ok: true,
    workspacePath: res.workspacePath,
    note:
      '已把当前对话的工作空间切过去。本轮已装配的上下文（系统提示 / AGENTS.md / 索引）仍是原目录的，' +
      '新目录从下一轮生效；不确定目录对不对先用 fs_list_dir 看一眼。'
  };
}

window.applySessionWorkspaceFromTool = applySessionWorkspaceFromTool;

/**
 * 工作区切换后刷新「依赖工作区根」的 pane。
 *
 * 只调 `renderArtifactsList()` 会让「产物」页继续显示旧根下的相对路径与可点判定
 * （同一批产物的 path@ts 没变，光看签名分不出来）—— 产物页必须一起重绘。
 */
function refreshWorkspaceScopedPanes() {
  if ($('artifacts-panel')?.hidden) return;
  renderArtifactsList();
  if (typeof refreshProductsPanelIfActive === 'function') refreshProductsPanelIfActive();
}

async function clearWorkspaceToDefault() {
  const res = await applyLocalWorkspacePath(null);
  if (!res.ok && res.error) showAgentToast('无法切换', res.error, { variant: 'warn' });
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
  refreshWorkspaceScopedPanes();
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

/**
 * 别名/跳板是「用户看不见的真相」：连上后说一句实际连到哪，
 * 否则用户会以为连接走的是他自己输的那个字符串。
 */
function showSshResolvedHint(resolved) {
  if (!resolved || typeof showAgentToast !== 'function') return;
  const bits = [];
  if (resolved.fromSshConfig) bits.push(`${resolved.username}@${resolved.hostname}:${resolved.port}`);
  if (resolved.viaJump && resolved.viaJump.length) bits.push(`经跳板 ${resolved.viaJump.join(' → ')}`);
  if (resolved.authType === 'agent') bits.push('ssh-agent 认证');
  if (resolved.warnings && resolved.warnings.length) bits.push(resolved.warnings[0]);
  if (!bits.length) return;
  showAgentToast('已按 ~/.ssh/config 连接', bits.join(' · '), { variant: 'info' });
}

async function submitSshConnect(e, opts = {}) {
  if (e) e.preventDefault();
  if (!wsApi.sshConnect) {
    // 「请重启应用」会把浏览器版的人引去重启一个根本没有 SSH 通道的进程
    setSshError(
      'ssh-connect-error',
      canSwitchLocalWorkspace()
        ? 'SSH 服务未就绪，请重启应用'
        : '这个界面不能连 SSH：浏览器版没有主进程通道，请用桌面客户端'
    );
    return;
  }
  setSshError('ssh-connect-error', '');

  const host = ($('ssh-connect-host') && $('ssh-connect-host').value) || '';
  const port = ($('ssh-connect-port') && $('ssh-connect-port').value) || '22';
  const username = ($('ssh-connect-user') && $('ssh-connect-user').value) || '';
  const remember = !!($('ssh-connect-remember') && $('ssh-connect-remember').checked);
  const useAgent = !!($('ssh-connect-use-agent') && $('ssh-connect-use-agent').checked);
  const privateKeyPath = ($('ssh-connect-key-path') && $('ssh-connect-key-path').value) || '';
  const password = ($('ssh-connect-password') && $('ssh-connect-password').value) || '';
  const useKey = !!privateKeyPath.trim();
  // 认证方式交给主进程按「显式输入 > 已存凭据 > ~/.ssh/config」落定：
  // 这里只表达用户意图（勾了 agent / 选了私钥 / 填了密码 / 什么都没填=auto）
  const authType = useAgent ? 'agent' : useKey ? 'key' : password ? 'password' : 'auto';
  const payload = {
    host,
    port,
    username,
    authType,
    remember,
    // 已存的密码/私钥路径，即使这次没勾「记住」也应当被复用（勾选只控制是否保存）
    useSaved: true,
    acceptNewHostKey: opts.acceptNewHostKey === true
  };

  if (useKey) {
    payload.privateKeyPath = privateKeyPath.trim();
    payload.passphrase = ($('ssh-connect-key-passphrase') && $('ssh-connect-key-passphrase').value) || '';
  } else if (!useAgent && password) {
    payload.password = password;
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
    showSshResolvedHint(connResult && connResult.resolved);

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
    showSshResolvedHint(connResult && connResult.resolved);
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

/**
 * 目录选择浮层的取数口：远端（SSH）用 `sshBrowse`，浏览器版的本地目录用 `browseServerDir`。
 * 两者形状不同（远端带文件、本地只列子目录），下面统一成 `{name, path, isDirectory}`。
 * @returns {((p: string) => Promise<any>) | null}
 */
function dirPickerLister() {
  if (workspaceMenuState.dirPickerMode === 'local') return wsApi.browseServerDir || null;
  return wsApi.sshBrowse || null;
}

async function renderRemoteDirList(remotePath, opts = {}) {
  const listEl = $('ssh-remote-dir-list');
  const pathEl = $('ssh-remote-dir-path');
  const lister = dirPickerLister();
  if (!listEl || !lister) return;
  const isLocal = workspaceMenuState.dirPickerMode === 'local';
  workspaceMenuState.remoteDirPath = remotePath || '/';
  if (pathEl) {
    if ('value' in pathEl) pathEl.value = workspaceMenuState.remoteDirPath;
    else pathEl.textContent = workspaceMenuState.remoteDirPath;
  }
  const titleEl = $('ssh-remote-dir-title');
  if (titleEl) titleEl.textContent = isLocal ? '选择工作空间目录' : '选择远程工作目录';
  listEl.innerHTML = '<div class="artifacts-empty">加载中…</div>';
  setSshError('ssh-remote-dir-error', '');
  try {
    const r = await lister(workspaceMenuState.remoteDirPath);
    const entries = (r && r.entries) || [];
    const parent = (r && r.parent) || '';
    listEl.innerHTML = '';
    if (isLocal ? !!parent : workspaceMenuState.remoteDirPath !== '/') {
      const up = document.createElement('button');
      up.type = 'button';
      up.className = 'ssh-remote-dir-item ssh-remote-dir-up';
      up.innerHTML = SSH_REMOTE_DIR_UP_ICON;
      up.addEventListener('click', () => {
        const next = isLocal ? parent : parentRemotePath(workspaceMenuState.remoteDirPath);
        renderRemoteDirList(next).catch(() => {});
      });
      listEl.appendChild(up);
    }
    if (!entries.length) {
      const empty = document.createElement('div');
      empty.className = 'artifacts-empty';
      empty.textContent = '没有子目录';
      listEl.appendChild(empty);
      return;
    }
    for (const raw of entries) {
      // 本地列表只给 {name, path}（服务端已滤掉文件），远端给 {name, isDirectory}
      const ent = {
        name: raw.name,
        isDirectory: isLocal ? true : !!raw.isDirectory,
        path: raw.path || ''
      };
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
      const enter = () => {
        const next = ent.path
          ? ent.path
          : ((workspaceMenuState.remoteDirPath.replace(/\/+$/, '') || '') + '/' + ent.name).replace(/\/+/g, '/');
        renderRemoteDirList(next).catch(() => {});
      };
      row.addEventListener('click', () => {
        if (ent.isDirectory) enter();
        else {
          for (const item of listEl.querySelectorAll('.ssh-remote-dir-item')) {
            item.classList.remove('active');
          }
          row.classList.add('active');
        }
      });
      row.addEventListener('dblclick', () => {
        if (ent.isDirectory) enter();
      });
      listEl.appendChild(row);
    }
  } catch (err) {
    const atRoot = workspaceMenuState.remoteDirPath === '/';
    if (!isLocal && atRoot && !opts.skipHomeFallback) {
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

/**
 * 打开目录选择浮层。
 * @param {'ssh'|'local'} mode
 * @param {string} startPath
 */
async function openDirPicker(mode, startPath) {
  workspaceMenuState.dirPickerMode = mode === 'local' ? 'local' : 'ssh';
  workspaceMenuState.remoteDirPath = startPath || '/';
  showOverlay('ssh-remote-dir-overlay', true);
  await renderRemoteDirList(workspaceMenuState.remoteDirPath);
}

async function openRemoteDirPicker(startPath) {
  return openDirPicker('ssh', startPath || '/');
}

function closeRemoteDirPicker(opts = {}) {
  showOverlay('ssh-remote-dir-overlay', false);
  setSshError('ssh-remote-dir-error', '');
  // 浮层关掉就回到默认用途：下次打开远端目录选择时不会带着上一次的 local 模式
  workspaceMenuState.dirPickerMode = 'ssh';
  if (opts.clearProgress) endSshDeployProgressWatch(0);
}

async function confirmRemoteDir() {
  const selectBtn = $('ssh-remote-dir-select');
  if (workspaceMenuState.dirPickerMode === 'local') {
    setSshError('ssh-remote-dir-error', '');
    if (selectBtn) selectBtn.disabled = true;
    try {
      const res = await applyLocalWorkspacePath(workspaceMenuState.remoteDirPath);
      if (!res.ok) {
        setSshError('ssh-remote-dir-error', res.error || '切换失败');
        return;
      }
      closeRemoteDirPicker();
      showAgentToast('工作空间已切换', res.workspacePath || '', { variant: 'info' });
    } finally {
      if (selectBtn) selectBtn.disabled = false;
    }
    return;
  }
  if (!wsApi.setSshRemotePath) return;
  setSshError('ssh-remote-dir-error', '');
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
  if (action === 'worktree-apply') {
    await applySessionWorktreeChanges();
    return;
  }
}

function initWorkspacePicker() {
  const wrap = $('composer-workspace-wrap');
  const btn = $('btn-pick-workspace');
  const menu = $('composer-workspace-menu');
  if (!btn || !menu) return;

  // 没有切换能力（浏览器版）就把两个本地入口置灰并写明原因：能力在启动时就定了，
  // 不必等用户点一下才发现不行。
  if (!wsApi.setLocalWorkspace) {
    for (const action of ['local', 'clear']) {
      const item = menu.querySelector(`[data-ws-action="${action}"]`);
      if (!item) continue;
      item.disabled = true;
      item.title = localWorkspaceSwitchHint();
    }
  }

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
  const connectCredsReset = $('ssh-connect-credentials-reset');
  if (connectCredsReset) {
    connectCredsReset.addEventListener('click', () => {
      resetSshCredentialsStore().catch(() => {});
    });
  }

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
      // 本地模式允许 ~ / 绝对路径原样进去；远端模式沿用「补上前导 /」的旧行为
      const asIs = workspaceMenuState.dirPickerMode === 'local' && (next.startsWith('/') || next.startsWith('~'));
      renderRemoteDirList(asIs ? next : next.startsWith('/') ? next : `/${next}`).catch(() => {});
    });
  }

  if (wsApi.getWorkspace) {
    wsApi
      .getWorkspace()
      .then((ws) => updateWorkspaceLabel(ws))
      .catch(() => {});
  }
}

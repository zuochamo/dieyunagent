/* global WebSocket, crypto, $ */
const gatewayApi = window.diecloud || {};

const gwState = {
  ws: null,
  authed: false,
  pending: new Map(),
  port: null
};

/** 保留供状态清理；Renderer 工具 RPC 一律走 Local Gateway */
const remoteGwState = {
  ws: null,
  authed: false,
  pending: new Map(),
  port: null,
  active: false
};

/** 对话记忆、权限等必须走本地 Gateway，不能经 SSH 远程隧道 */
const LOCAL_RPC_PREFIXES = ['memory.', 'agent.state_', 'permissions.', 'undo.', 'speech.'];

function isLocalOnlyMethod(method) {
  const m = String(method || '');
  return LOCAL_RPC_PREFIXES.some((p) => m.startsWith(p));
}

function isLocalGatewayReady() {
  return !!(gwState.ws && gwState.ws.readyState === WebSocket.OPEN && gwState.authed);
}

function updateHelpStatsGatewayStatus() {
  const dot = $('conn-dot');
  const text = $('conn-text');
  if (!dot || !text) return;
  const ready = isLocalGatewayReady();
  dot.classList.toggle('connected', ready);
  const port = gwState.port ? ` :${gwState.port}` : '';
  // 文本无变化时不写 DOM：状态每秒推送一次，写入会触发重排
  let next;
  if (ready) {
    const label =
      typeof uiText === 'function' ? uiText('gateway_connected', 'Gateway 已连接') : 'Gateway 已连接';
    next = `${label}${port}`;
  } else {
    const metaEl = $('meta-gateway');
    const hint = metaEl && metaEl.textContent ? String(metaEl.textContent).trim() : '';
    if (hint && hint !== '…' && /未|失败|无|Not/i.test(hint)) {
      next = hint;
    } else {
      next =
        typeof uiText === 'function' ? uiText('gateway_disconnected', 'Gateway 未连接') : 'Gateway 未连接';
    }
  }
  if (text.textContent !== next) text.textContent = next;
}

let gatewayConnectLock = Promise.resolve();

function withGatewayConnectLock(fn) {
  const run = gatewayConnectLock.then(() => fn());
  gatewayConnectLock = run.catch(() => {});
  return run;
}

function setGatewayMeta(text) {
  const el = $('meta-gateway');
  if (el) el.textContent = text;
  updateHelpStatsGatewayStatus();
}

async function refreshRemoteGatewayMeta(opts = {}) {
  const el = $('meta-remote-gateway');
  if (!el) return null;
  if (opts.loading) {
    el.textContent = '启动中…';
    el.title = '';
    return null;
  }
  if (!gatewayApi.sshRemoteGatewayStatus) {
    el.textContent = '—';
    return null;
  }
  try {
    const st = await gatewayApi.sshRemoteGatewayStatus();
    const isRemoteWs = st.workspaceKind === 'ssh';
    if (!isRemoteWs) {
      el.textContent = '本地工作空间';
      el.title = '远程工具经 Local Gateway（SSH 适配）';
      return st;
    }
    const rg = st.remoteGateway || {};
    if (rg.deploying) {
      el.textContent = '正在注入远程 Agent（索引）…';
      el.title = 'Main 进程索引加速；文件/命令走 Local Gateway';
    } else if (rg.active) {
      el.textContent = `远程索引 Agent socket:${rg.socketPath || ''}`;
      el.title = `工作目录: ${rg.workspaceRoot || ''}\n工具 RPC 经 Local Gateway + runWorkspaceRoot`;
    } else if (st.sshBackend === 'sftp') {
      el.textContent = 'SFTP 模式';
      el.title = '未注入 Remote Agent；索引与 grep 回退可用';
    } else if (rg.lastError) {
      const short = String(rg.lastError).split('\n')[0].slice(0, 72);
      el.textContent = `索引 Agent: ${short}`;
      el.title = String(rg.lastError);
    } else if (!st.packExists) {
      el.textContent = '本地未打包（npm run pack:remote-gateway）';
      el.title = st.packRoot || '';
    } else {
      el.textContent = '索引 Agent 未启动';
      el.title = '连接远程工作空间后会自动尝试注入（可选加速）';
    }
    return st;
  } catch (e) {
    el.textContent = `状态读取失败: ${e.message || e}`;
    return null;
  }
}

const DEFAULT_GATEWAY_RPC_TIMEOUT_MS = 45000;
const GATEWAY_RPC_TIMEOUT_OVERRIDES = {
  'graph.index': 120000,
  'graph.rebuild': 120000,
  'memory.long_reindex': 120000,
  'memory.long_decay': 90000,
  'fs.grep': 60000,
  'fs.glob': 45000,
  'lsp.query': 60000,
  'codebase.index.start': 60000,
  'codebase.status': 45000,
  'graph.index.start': 60000,
  'graph.status': 45000,
  'graph.repo_map': 30000,
  'graph.lsp_enrich': 90000,
  'graph.lsp_resolve': 60000,
  'host.exec': 120000,
  'undo.turn_begin': 90000,
  'undo.capture_batch': 90000,
  'undo.rollback': 180000,
  'undo.rollback_batch': 180000,
  'memory.session_get': 90000,
  'memory.sessions_list': 120000,
  'memory.messages_recent': 90000,
  'agent.trace_get': 90000,
  'index.remote_wait_ready': 120000,
  // 语音：合成/转写的耗时由文本长度和录音长度决定，实测 400 字中文约 20s、
  // 1200 字接近 1 分钟，默认 45s 会稳定超时（超时后音频直接丢掉，用户只会看到失败）。
  'speech.synthesize': 180000,
  'speech.transcribe': 120000,
  'speech.transcribe_probe': 120000
};

function gatewayCallTimeoutMs(method, overrideMs) {
  if (overrideMs != null && Number.isFinite(Number(overrideMs))) return Number(overrideMs);
  const key = String(method || '');
  if (Object.prototype.hasOwnProperty.call(GATEWAY_RPC_TIMEOUT_OVERRIDES, key)) {
    return GATEWAY_RPC_TIMEOUT_OVERRIDES[key];
  }
  return DEFAULT_GATEWAY_RPC_TIMEOUT_MS;
}

function rawGatewayCall(state, method, params, options = {}) {
  return new Promise((resolve, reject) => {
    if (!state.ws || state.ws.readyState !== WebSocket.OPEN || !state.authed) {
      reject(new Error('Gateway 未就绪'));
      return;
    }
    const id = crypto.randomUUID();
    const timeoutMs = gatewayCallTimeoutMs(method, options.timeoutMs);
    let timer = null;
    const settle = (fn, value) => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      fn(value);
    };
    state.pending.set(id, {
      resolve: (data) => settle(resolve, data),
      reject: (err) => settle(reject, err)
    });
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        const box = state.pending.get(id);
        if (!box) return;
        state.pending.delete(id);
        box.reject(new Error(`Gateway RPC 超时: ${method} (${Math.round(timeoutMs / 1000)}s)`));
      }, timeoutMs);
    }
    try {
      state.ws.send(JSON.stringify({ v: 1, type: 'call', id, method, params }));
    } catch (e) {
      state.pending.delete(id);
      if (timer) clearTimeout(timer);
      reject(e);
    }
  });
}

function handleGatewayMessage(state, ev) {
  let msg;
  try {
    msg = JSON.parse(ev.data);
  } catch {
    return;
  }
  if (msg.type !== 'result') return;
  const id = msg.id;
  const box = state.pending.get(id);
  if (!box) return;
  state.pending.delete(id);
  if (msg.ok) box.resolve(msg.data);
  else {
    // 服务端刻意把 code / retryable / suggestedFix 一起送回来（见 gateway/server.js
    // 「跨 WebSocket 传的时候不许只剩一条 message」），这里不能把它们丢掉：
    // 调用方（发送路径、工具层）靠 code 决定「重开对话 / 重试 / 就此打住」。
    const info = msg.error && typeof msg.error === 'object' ? msg.error : {};
    const err = new Error(info.message || 'RPC 失败');
    if (info.code) err.code = String(info.code);
    if (typeof info.retryable === 'boolean') err.retryable = info.retryable;
    if (info.suggestedFix) err.suggestedFix = String(info.suggestedFix);
    box.reject(err);
  }
}

async function connectOneGateway(state, info, label) {
  state.authed = false;
  if (!info || !info.url || !info.token) return false;

  const maxAttempts = 6;
  let lastErr = null;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0) {
      await new Promise((r) => setTimeout(r, 250 * attempt));
      if (state === gwState && gatewayApi.getGatewayInfo) {
        try {
          const fresh = await gatewayApi.getGatewayInfo();
          const localInfo = (fresh && fresh.local) || fresh;
          if (localInfo && localInfo.url && localInfo.token) info = localInfo;
        } catch {
          // ignore refresh errors between retries
        }
      }
    }
    try {
      await connectOneGatewayOnce(state, info, label);
      return true;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error(`${label} WebSocket 错误`);
}

function connectOneGatewayOnce(state, info, label) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(info.url);
    state.ws = ws;
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };

    ws.onopen = () => {
      ws.send(JSON.stringify({ v: 1, type: 'auth', token: info.token }));
    };

    ws.onmessage = (ev) => {
      let m;
      try {
        m = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (m.type === 'auth_ok') {
        state.authed = true;
        if (state === gwState) updateHelpStatsGatewayStatus();
        finish(resolve);
        return;
      }
      if (m.type === 'event' && m.event === 'diagnostics.store_updated') {
        if (state === gwState && typeof refreshWorkspaceProblemsPanel === 'function') {
          void refreshWorkspaceProblemsPanel({
            workspaceRoot: m.data && m.data.workspaceRoot ? m.data.workspaceRoot : null
          });
        }
        return;
      }
      handleGatewayMessage(state, ev);
    };

    ws.onerror = () => {
      finish(reject, new Error(`${label} WebSocket 错误（端口 ${info.port || '?'} 无响应，请重启应用）`));
    };

    ws.onclose = (ev) => {
      // 旧 socket 关闭时勿清掉重连后的新连接
      if (state.ws && state.ws !== ws) return;
      if (!state.authed && !settled) {
        const hint =
          ev && ev.code === 1006
            ? `${label} 连接被拒绝（Gateway 可能未启动或端口 ${info.port || '?'} 被占用）`
            : `${label} WebSocket 已关闭`;
        finish(reject, new Error(hint));
        return;
      }
      state.authed = false;
      if (state.ws === ws) state.ws = null;
      for (const [, box] of state.pending) {
        box.reject(new Error(`${label} 已断开`));
      }
      state.pending.clear();
      if (state === gwState) {
        setGatewayMeta(typeof uiText === 'function' ? uiText('gateway_disconnected', 'Gateway 未连接') : 'Gateway 未连接');
      }
    };
  });
}

function closeGatewayState(state) {
  const wasLocal = state === gwState;
  state.authed = false;
  if (state.ws) {
    try {
      state.ws.close();
    } catch {
      // ignore
    }
  }
  state.ws = null;
  for (const [, box] of state.pending) {
    box.reject(new Error('Gateway 已断开'));
  }
  state.pending.clear();
  if (wasLocal) updateHelpStatsGatewayStatus();
}

async function ensureLocalGatewayReady() {
  if (isLocalGatewayReady()) return;
  await withGatewayConnectLock(() => connectLocalGatewayOnly());
}

async function connectLocalGatewayLocked() {
  return withGatewayConnectLock(() => connectLocalGatewayOnly());
}

async function connectRemoteGatewayLocked() {
  return refreshRemoteGatewayMeta();
}

function gatewayCall(method, params, options) {
  let opts = {};
  if (options != null && typeof options === 'object') opts = options;
  else if (typeof options === 'number' && Number.isFinite(options) && options > 0) {
    opts = { timeoutMs: options };
  }
  if (isLocalOnlyMethod(method)) {
    return ensureLocalGatewayReady().then(() => rawGatewayCall(gwState, method, params, opts));
  }
  if (!isLocalGatewayReady()) {
    return ensureLocalGatewayReady().then(() => rawGatewayCall(gwState, method, params, opts));
  }
  return rawGatewayCall(gwState, method, params, opts);
}

async function connectLocalGatewayOnly() {
  if (!gatewayApi.getGatewayInfo) {
    setGatewayMeta('无接口');
    throw new Error('无接口');
  }
  const info = await gatewayApi.getGatewayInfo();
  const localInfo = (info && info.local) || info;
  if (!localInfo || !localInfo.url || !localInfo.token) {
    setGatewayMeta('未启动');
    throw new Error('本地 Gateway 未启动');
  }
  if (localInfo.listening === false) {
    setGatewayMeta(`启动中 :${localInfo.port || ''}…`);
    await new Promise((r) => setTimeout(r, 400));
    const retry = await gatewayApi.getGatewayInfo();
    const retryLocal = (retry && retry.local) || retry;
    if (retryLocal && retryLocal.url && retryLocal.token) {
      Object.assign(localInfo, retryLocal);
    }
  }
  if (isLocalGatewayReady() && gwState.port === localInfo.port) {
    setGatewayMeta(`已连接 :${localInfo.port}`);
    return;
  }
  closeGatewayState(gwState);
  await connectOneGateway(gwState, localInfo, '本地 Gateway');
  gwState.port = localInfo.port;
  gwState.rustCore = info.rustCore || null;
  setGatewayMeta(`已连接 :${localInfo.port}`);
  await refreshRemoteGatewayMeta();
}

async function connectRemoteGatewayOnly() {
  remoteGwState.active = false;
  closeGatewayState(remoteGwState);
  await refreshRemoteGatewayMeta();
}

async function connectGateway() {
  // 必须走连接锁：启动期 connectGateway 与其它路径的 ensureLocalGatewayReady 会并发进入，
  // 两边都按 isLocalGatewayReady()（只认 OPEN）判定为「未连接」，后到的那个就会
  // closeGatewayState 掉仍在 CONNECTING 的 socket —— 即
  // 「WebSocket is closed before the connection is established」。
  await connectLocalGatewayLocked();
}

function resetRemoteGatewayClient() {
  remoteGwState.active = false;
  closeGatewayState(remoteGwState);
  if (typeof invalidateRemoteCoreReadyCache === 'function') invalidateRemoteCoreReadyCache();
}

async function reconnectGateway() {
  try {
    await connectGateway();
  } catch (e) {
    setGatewayMeta(`未连接 (${e.message || e})`);
    throw e;
  }
}

if (gatewayApi.onGatewaySshReconnected) {
  gatewayApi.onGatewaySshReconnected(() => {
    refreshRemoteGatewayMeta().catch((err) => console.warn(err));
  });
}

/** Resolve workspace URI for session-scoped tool RPC (Scheme B). */
function resolveSessionWorkspacePathForRpc(sessionId) {
  const sid =
    sessionId != null && String(sessionId).trim()
      ? String(sessionId).trim()
      : typeof currentSessionId !== 'undefined' && currentSessionId
        ? String(currentSessionId)
        : '';
  if (!sid) return null;
  if (typeof sessionActiveRuns !== 'undefined') {
    const live = sessionActiveRuns.get(sid);
    if (live && live.workspacePath) return live.workspacePath;
  }
  if (typeof resolveSessionWorkspacePathSync === 'function') {
    const sync = resolveSessionWorkspacePathSync(sid);
    if (sync) return sync;
  }
  // 这里以前还有一段「sid === currentSessionId 就返回 activeViewSessionWorkspacePath」的
  // 回落：它把视图路径当成该会话的绑定，而切会话时视图路径还是上一个会话的
  // （会话工作空间漂移的根因，见 issues/2026-10-30-agent-channel-and-workspace-binding.md）。
  // 该判定现在只在 resolveSessionWorkspacePathSync 里、且按「视图属于哪个会话」做一次。
  return null;
}

/**
 * Workspace for index/graph panels.
 * Session bind → activeView → Main getWorkspace (opened folder even if session 未绑定).
 */
async function resolveWorkspaceRootForIndexPanels(sessionId) {
  const sid =
    sessionId != null && String(sessionId).trim()
      ? String(sessionId).trim()
      : typeof currentSessionId !== 'undefined' && currentSessionId
        ? String(currentSessionId)
        : '';
  const pick = (v) => {
    const s = v != null ? String(v).trim() : '';
    return s || '';
  };
  let p = pick(resolveSessionWorkspacePathForRpc(sid || null));
  if (p) return p;
  if (typeof resolveSessionWorkspacePathSync === 'function' && sid) {
    p = pick(resolveSessionWorkspacePathSync(sid));
    if (p) return p;
  }
  if (typeof window !== 'undefined' && window.activeViewSessionWorkspacePath) {
    // 视图路径只代表「它正在显示的那个会话」；会话已切换但视图还没跟上时不能拿来顶
    const viewSid = String(window.activeViewSessionWorkspaceSessionId || '');
    if (!sid || viewSid === String(sid)) {
      p = pick(window.activeViewSessionWorkspacePath);
      if (p) return p;
    }
  }
  if (sid && typeof resolveSessionWorkspacePath === 'function') {
    try {
      // resolveSessionWorkspacePath 自带写缓存，下一次 sync 就能命中，不必在这里补窗口变量
      p = pick(await resolveSessionWorkspacePath(sid));
      if (p) return p;
    } catch {
      // ignore
    }
  }
  try {
    const api = typeof window !== 'undefined' ? window.diecloud : null;
    if (api && typeof api.getWorkspace === 'function') {
      const ws = await api.getWorkspace();
      p = pick(ws && ws.workspacePath);
      if (p) return p;
    }
  } catch {
    // ignore
  }
  return '';
}

/** Merge sessionId + runWorkspaceRoot into RPC params for parallel session isolation. */
function withSessionRpcScope(params, sessionId) {
  const base = params && typeof params === 'object' ? { ...params } : {};
  const sid =
    base.sessionId != null && String(base.sessionId).trim()
      ? String(base.sessionId).trim()
      : sessionId != null && String(sessionId).trim()
        ? String(sessionId).trim()
        : typeof currentSessionId !== 'undefined' && currentSessionId
          ? String(currentSessionId)
          : '';
  if (sid && !base.sessionId) base.sessionId = sid;
  if (!base.runWorkspaceRoot) {
    const wp =
      base.workspaceRoot && String(base.workspaceRoot).trim()
        ? String(base.workspaceRoot).trim()
        : resolveSessionWorkspacePathForRpc(sid);
    if (wp) base.runWorkspaceRoot = wp;
  }
  return base;
}

/**
 * 索引 / 结构索引面板的 RPC 参数：与发消息前的 prep（`ensurePrepIndexReady`）同一条作用域。
 *
 * 面板以前只传 `workspaceRoot`，于是 Gateway 解析不到本会话的远端目标，把这个 SSH
 * 工作区的 URI 当本地路径 resolve 成本机 core 里的一个空键 —— 面板恒显示「未建立 / 0 /
 * 从未构建」，而 agent 侧其实在远端正常的库里检索。作用域缺一不可：`sessionId` 让
 * Gateway hydrate 会话目标，`runWorkspaceRoot` 让远端分支带上真正的 remotePath。
 *
 * @param {string} workspaceRoot
 * @param {object} [extra]
 */
function indexPanelRpcParams(workspaceRoot, extra) {
  const params = { workspaceRoot, ...(extra || {}) };
  return withSessionRpcScope(params);
}

if (typeof window !== 'undefined') {
  window.resolveSessionWorkspacePathForRpc = resolveSessionWorkspacePathForRpc;
  window.resolveWorkspaceRootForIndexPanels = resolveWorkspaceRootForIndexPanels;
  window.withSessionRpcScope = withSessionRpcScope;
  window.indexPanelRpcParams = indexPanelRpcParams;
}

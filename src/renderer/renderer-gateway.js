/* global $, uiText */
/**
 * Gateway RPC 客户端（唯一实现）。
 *
 * 传输只有一条：`window.diecloud.gatewayRpc` → Main IPC → `gateway.invokeRpc`。
 * Renderer **不再持有 WebSocket** —— 本地 Gateway 默认监听私有 socket / 命名管道
 * （见 `src/gateway/local-endpoint.js`），Chromium 连不了；IPC 也没有「连接」这个概念，
 * 断了就是这次调用失败，不需要重连状态机。
 *
 * 网页替身（headless `--web` 的 `/app/`）由 `src/headless/desktop-ui.js` 的 shim 提供
 * 同名 `gatewayRpc`（同源 WS → 服务进程内 `invokeRpc`）：渲染层两侧看到的是同一个接口。
 */
const gatewayApi = window.diecloud || {};

const gwState = {
  /** RPC 通道可用（Main 已装配 Gateway）。名字沿用历史：调用点判的是「能不能发 RPC」 */
  authed: false,
  /** 端点形态（tcp / unix / pipe），只用于状态显示 */
  transport: null,
  port: null,
  rustCore: null
};

function isLocalGatewayReady() {
  return !!(gwState.authed && typeof gatewayApi.gatewayRpc === 'function');
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

/**
 * Main 已经把 code / retryable / suggestedFix 一起送回来（工具失败契约的一半），
 * 这里不许退化成「只剩一条 message」：调用方靠 code 决定重开对话 / 重试 / 打住。
 */
function gatewayRpcError(info) {
  const box = info && typeof info === 'object' ? info : {};
  const err = new Error(box.message || 'RPC 失败');
  if (box.code) err.code = String(box.code);
  if (typeof box.retryable === 'boolean') err.retryable = box.retryable;
  if (box.suggestedFix) err.suggestedFix = String(box.suggestedFix);
  return err;
}

/**
 * 唯一 RPC 出口。超时只在 Main 侧 `invokeRpc` 执行一次（同一份 `gatewayCallTimeoutMs` 口径），
 * 这里不再叠定时器：两层超时只会让「到底谁先放弃」变得不可解释。
 */
async function rawGatewayCall(method, params, options = {}) {
  if (typeof gatewayApi.gatewayRpc !== 'function') {
    throw new Error('Gateway RPC 通道缺失（preload 未暴露 gatewayRpc）：请重启客户端或重建 renderer bundle');
  }
  const timeoutMs = gatewayCallTimeoutMs(method, options.timeoutMs);
  let res;
  try {
    res = await gatewayApi.gatewayRpc({
      method,
      params: params && typeof params === 'object' ? params : {},
      timeoutMs
    });
  } catch (e) {
    // IPC 层失败（Main 退出 / 通道被关）：没有「重连」可言，就是这次调用不可用
    throw new Error(`本地 Agent 通道不可用：${(e && e.message) || e}`);
  }
  if (res && res.ok) return res.data;
  throw gatewayRpcError(res && res.error);
}

/** Gateway 事件（原来靠 WebSocket 的 `type:'event'` 帧送来，现在由 Main 转发一次） */
if (typeof gatewayApi.onGatewayEvent === 'function') {
  gatewayApi.onGatewayEvent((payload) => {
    const p = payload || {};
    if (p.event !== 'diagnostics.store_updated') return;
    if (typeof refreshWorkspaceProblemsPanel === 'function') {
      void refreshWorkspaceProblemsPanel({
        workspaceRoot: p.data && p.data.workspaceRoot ? p.data.workspaceRoot : null
      });
    }
  });
}

async function ensureLocalGatewayReady() {
  if (isLocalGatewayReady()) return;
  await withGatewayConnectLock(() => connectLocalGatewayOnly());
}

async function connectLocalGatewayLocked() {
  return withGatewayConnectLock(() => connectLocalGatewayOnly());
}

function gatewayCall(method, params, options) {
  let opts = {};
  if (options != null && typeof options === 'object') opts = options;
  else if (typeof options === 'number' && Number.isFinite(options) && options > 0) {
    opts = { timeoutMs: options };
  }
  if (!isLocalGatewayReady()) {
    return ensureLocalGatewayReady().then(() => rawGatewayCall(method, params, opts));
  }
  return rawGatewayCall(method, params, opts);
}

/** `gateway:get-info` 的形状：网关在时是 `{...local, local, remote, rustCore}`，
 *  网页替身直接给扁平的一份。挑出「本地那一份」，都没有就是 null（还没装配）。 */
function pickLocalGatewayInfo(info) {
  if (!info || typeof info !== 'object') return null;
  if (info.local && typeof info.local === 'object') return info.local;
  if (info.transport || info.url || info.permissions) return info;
  return null;
}

const GATEWAY_INFO_MAX_ATTEMPTS = 5;

async function connectLocalGatewayOnly() {
  if (!gatewayApi.getGatewayInfo) {
    setGatewayMeta('无接口');
    throw new Error('无接口');
  }
  if (typeof gatewayApi.gatewayRpc !== 'function') {
    setGatewayMeta('RPC 通道缺失');
    throw new Error('Gateway RPC 通道缺失（preload 未暴露 gatewayRpc）');
  }
  // Main 在 whenReady 里装配 Gateway，窗口有可能先到：这是启动期的一次短等，
  // 不是重连状态机（IPC 没有连接可重连，下面的每次调用自己就是一次尝试）。
  let info = null;
  let local = null;
  for (let attempt = 0; attempt < GATEWAY_INFO_MAX_ATTEMPTS; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 200 * attempt));
    info = await gatewayApi.getGatewayInfo();
    local = pickLocalGatewayInfo(info);
    if (local) break;
  }
  if (!local) {
    setGatewayMeta('未启动');
    throw new Error('本地 Gateway 未启动');
  }
  gwState.authed = true;
  gwState.transport = local.transport || 'ipc';
  gwState.port = local.port || null;
  gwState.rustCore = info.rustCore || null;
  const label = gwState.port ? `已连接 :${gwState.port}` : '已连接';
  setGatewayMeta(label);
  updateHelpStatsGatewayStatus();
  await refreshRemoteGatewayMeta();
}

async function connectGateway() {
  // 走连接锁：启动期 connectGateway 与 ensureLocalGatewayReady 会并发进入，
  // 两边都按「还没连上」判定，后到的那个会把刚取到的端点信息覆盖成半份（端口被丢）。
  await connectLocalGatewayLocked();
}

/**
 * 远端 Gateway 客户端已不存在（远端工具一律经 Local Gateway + `runWorkspaceRoot`）。
 * 这里保留补位：真正要清的是「远端 core 就绪」的缓存，切换工作空间后要重新问一次。
 */
function resetRemoteGatewayClient() {
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

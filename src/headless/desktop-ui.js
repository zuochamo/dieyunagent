/**
 * 把 Electron 渲染层（`src/renderer`）当**普通网页**提供 —— 无窗口模式下的「桌面界面」。
 *
 * 为什么这不是「另写一个前端」：桌面窗口本来就是浏览器页面
 * （`contextIsolation: true` + `nodeIntegration: false`），渲染层只通过 `window.diecloud`
 * 这层 preload 拿本机能力，RPC 本来就是自己连 Gateway 的 WebSocket
 * （`renderer-gateway.js` 里 `new WebSocket(info.url)`）。所以浏览器里跑它只缺两样：
 *
 *   1. `window.diecloud` 的替身（只给「在这台服务器上能如实回答」的接口；
 *      渲染层只探能力、不认来源，缺的接口它会走自己的降级分支）；
 *   2. 浏览器能连到 Gateway 的 WS —— Gateway 只听 127.0.0.1，所以这里同源代理 `/gateway`。
 *
 * 手机端页面（`src/mobile/public`）按 430px 设计，宽屏下只能拉宽；桌面界面本来就为宽屏写。
 *
 * 安全边界：`/app/*`、`/node_modules/*`、`/gateway` 都要求**手机端同一个 token**
 * （`?token=` 换成 cookie 之后才允许加载静态资源）—— 否则局域网里谁都能开这个页面、
 * 顺手拿到 Gateway token 去指挥 Agent。
 */
const fs = require('fs');
const path = require('path');
const { WebSocketServer, WebSocket } = require('ws');

const COOKIE_NAME = 'dieyun_web';
const SHIM_PATH = '/app/__desktop-shim.js';
// 浏览器标签图标：桌面页与手机端页都不带（Electron 窗口用不到），这里用仓库里那一份图标统一供给
const FAVICON_PATH = '/favicon.ico';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm'
};

/** 只放行这些根：渲染层本体、它 `<script>` 里的 node_modules 资源、以及 LLM 同源转发 */
function mountOf(pathname) {
  if (pathname === '/app' || pathname.startsWith('/app/')) return 'renderer';
  if (pathname.startsWith('/node_modules/')) return 'node_modules';
  // 渲染层还 `<script src="../llm-usage-stats.js">`（在主进程与渲染层之间共用的一份）
  if (pathname === '/llm-usage-stats.js') return 'src-file';
  // 桌面端 LLM 请求由主进程代发；浏览器里没有主进程，用同源转发顶上（顺便避开模型端点的 CORS）
  if (pathname === '/llm') return 'llm';
  // 标签图标：两个界面都在根路径要 /favicon.ico（渲染层与手机端页都不带图标链接）
  if (pathname === FAVICON_PATH) return 'icon';
  return '';
}

function parseCookies(header) {
  const out = {};
  String(header || '')
    .split(';')
    .forEach((part) => {
      const i = part.indexOf('=');
      if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
    });
  return out;
}

/**
 * preload 替身。
 *
 * 两条硬约束（2026-11-04 真机踩到过）：
 * 1. **形状必须和 preload 一致**：preload 里 164 个接口是 `ipcRenderer.invoke` → **Promise**。
 *    给同步值会让调用点 `api.getWorkspace().then(...)` 直接 TypeError（渲染层启动即挂）。
 * 2. **没有的能力必须「不存在」而不是「假的」**：渲染层用 `if (api.llmChatCompletion)` 做能力探测，
 *    Proxy 冒充成函数会让它走 Electron 专用通道并拿到 null；不暴露则它自己退回浏览器直连 LLM 的分支。
 *    所以这里只暴露真正能回答的四个，其它访问返回 undefined（并在控制台点一次名，方便定位）。
 */
function buildShim({ gatewayUrl, gatewayToken, webToken, workspacePath, modelSettings, rustCoreReady, permissions }) {
  // 注意：下面是**模板字符串**。里面的注释/文案不能出现反引号，也不能出现美元加花括号
  // （会提前闭合模板或当成插值），否则生成的脚本语法错误 → `/app/` 直接 404。
  // 这个坑踩过两次（2026-11-05）；`scripts/test-headless-desktop-ui.cjs` 会把生成物丢给
  // new Function 解析，改完务必跑它。
  return `/* 由 dieyun-headless 生成：Electron preload 的浏览器替身。
   桌面窗口的能力来自 preload.js（IPC → Main）；浏览器里换成同源 Gateway WS 代理 + 同源 LLM 转发，
   只给「能如实回答」的接口，其余保持 undefined —— 渲染层会按能力缺失走自己的降级分支。 */
(function () {
  // 同源代理地址由页面自己推导：反代 / HTTPS 下自动变 wss://，不信 Host 头
  const FALLBACK_URL = ${JSON.stringify(gatewayUrl)};
  const GATEWAY_URL =
    typeof location !== 'undefined' && location.host
      ? (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/gateway'
      : FALLBACK_URL;
  const GATEWAY_TOKEN = ${JSON.stringify(gatewayToken)};
  const WORKSPACE_INIT = ${JSON.stringify(String(workspacePath || ''))} || null;
  // 可变：浏览器里点「工作空间 → 本地」会走 desktop.set_workspace 真的换掉服务端工作区根，
  // 换完这一页的默认路径也要跟着变（否则「默认工作空间」标签还是旧目录）。
  let WORKSPACE = WORKSPACE_INIT;
  const MODEL_SETTINGS = ${JSON.stringify(modelSettings || null)};
  const LLM_PROXY = '/llm';
  // 与手机端同一个 token；用它连同源 /ws，请服务器在 Main 侧跑这一轮
  const WS_TOKEN = ${JSON.stringify(String(webToken || ''))};
  const RUST_CORE_READY = ${rustCoreReady === false ? 'false' : 'true'};
  // 权限档位（沙箱）：服务端注入初始值，之后可经 desktop.set_permissions 修改（唯一真源在 Gateway）。
  let PERMISSIONS = ${JSON.stringify(permissions || {})};

  /**
   * 桌面窗口里这一轮是 Main 跑的（preload 的 agentRustLoopRun → IPC）。浏览器里没有 IPC，
   * 就开到同源 /ws（与手机端同一套线协议），由服务器用**同一份** runRustAgentLoop 跑，
   * phase 事件以 event 帧推回来，渲染层看到的事件形状与 Electron 完全一致。
   */
  let agentWs = null;
  let agentWsReady = null;
  const agentPending = new Map();
  const phaseSubs = new Set();
  /** 内网互通面板的订阅（事件帧带 channel='peer'，与聊天轮的 phase 分流） */
  const peerSubs = new Set();
  function connectAgentWs() {
    if (agentWs && agentWs.readyState <= 1) return agentWsReady;
    agentWsReady = new Promise((resolve, reject) => {
      const proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
      const ws = new WebSocket(proto + location.host + '/ws');
      agentWs = ws;
      ws.onopen = () => ws.send(JSON.stringify({ type: 'auth', token: WS_TOKEN, id: 'auth' }));
      ws.onmessage = (ev) => {
        let msg = null;
        try {
          msg = JSON.parse(ev.data);
        } catch {
          return;
        }
        if (!msg) return;
        if (msg.type === 'auth_ok') {
          resolve(ws);
          return;
        }
        if (msg.type === 'error' && (msg.error === 'AUTH_FAILED' || msg.error === 'BAD_JSON')) {
          reject(new Error('后端拒绝了 Web 会话：' + msg.error));
          return;
        }
        if (msg.type === 'result') {
          const box = agentPending.get(String(msg.id || ''));
          if (!box) return;
          agentPending.delete(String(msg.id || ''));
          if (msg.ok) box.resolve(msg.data);
          else box.reject(new Error((msg.error && (msg.error.message || msg.error.code)) || '本轮执行失败'));
          return;
        }
        if (msg.type === 'event' && msg.event) {
          // 一条 event 帧流服务两种订阅：内网互通面板（channel='peer'）与聊天轮 phase。
          // 按 channel 分流，别让 loop 的处理器收到面板事件（反之亦然）。
          const subs = msg.event.channel === 'peer' ? peerSubs : phaseSubs;
          subs.forEach((cb) => {
            try {
              cb(msg.event);
            } catch (e) {
              console.warn('[dieyun-headless] 事件订阅抛错：', e && e.message);
            }
          });
        }
      };
      ws.onclose = () => {
        agentWs = null;
        agentWsReady = null;
        const err = new Error('与后端的连接已断开');
        agentPending.forEach((box) => box.reject(err));
        agentPending.clear();
      };
      ws.onerror = () => reject(new Error('无法连接 /ws'));
    });
    return agentWsReady;
  }
  function agentCall(method, params) {
    return connectAgentWs().then(
      (ws) =>
        new Promise((resolve, reject) => {
          const id = 'c-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
          agentPending.set(id, { resolve, reject });
          ws.send(JSON.stringify({ type: 'call', id, method, params: params || {} }));
        })
    );
  }

  /** 桌面端 LLM 请求由 Main 代发；这里代发到同源 /llm，由服务端转发到上游（顺带绕开模型端点的 CORS） */
  async function postLlm(url, headers, body, onControl) {
    const ctrl = new AbortController();
    if (onControl) onControl({ abort: () => ctrl.abort() });
    const h = Object.assign({}, headers, { 'x-dieyun-upstream': String(url || '') });
    delete h['Host'];
    delete h['host'];
    const resp = await fetch(LLM_PROXY, { method: 'POST', headers: h, body: body, signal: ctrl.signal });
    if (!resp.ok) {
      const text = await resp.text();
      const err = new Error('HTTP ' + resp.status + ' ' + resp.statusText + '\\n' + String(text).slice(0, 400));
      err.statusCode = resp.status;
      throw err;
    }
    return resp;
  }

  /**
   * 工作区根的本地镜像：getWorkspace() 与渲染层的「默认工作空间」都读它。
   * 唯一写入点是服务端 desktop.set_workspace 的返回（服务端是唯一真源）。
   * @param {object|null} ws
   */
  function applyWorkspace(ws) {
    const p = ws && ws.kind === 'local' && ws.workspacePath ? String(ws.workspacePath) : '';
    WORKSPACE = p || null;
    try {
      // 环境事实：会话没绑定工作空间时文件工具实际写哪里（composer 标签要如实显示）
      window.appDefaultWorkspacePath = WORKSPACE || undefined;
    } catch (e) {
      console.warn('[dieyun-headless] 更新默认工作空间失败：', e && e.message);
    }
    return ws;
  }

  /**
   * 「检查更新」的状态与订阅。桌面端由 Main 推 app:update-state；浏览器里由本 shim 推，
   * 渲染层看到的状态形状一样。初值不带 phase —— 没检查过就说「未检查」，别替它编一个「已是最新」。
   */
  const updateSubs = new Set();
  let updateState = { phase: '', message: '' };
  function pushUpdateState(next) {
    updateState = Object.assign({}, next || {}, { at: Date.now() });
    updateSubs.forEach((cb) => {
      try {
        cb(updateState);
      } catch (e) {
        console.warn('[dieyun-headless] 更新状态订阅抛错：', e && e.message);
      }
    });
    return updateState;
  }

  const real = {
    // preload: ipcRenderer.invoke('gateway:get-info') → Promise
    // 「rustCore.enabled」是渲染层判断「循环能不能跑」的依据（isDieyunCoreReady），如实上报
    getGatewayInfo: async () => ({
      url: GATEWAY_URL,
      token: GATEWAY_TOKEN,
      rustCore: RUST_CORE_READY ? { enabled: true } : null,
      permissions: PERMISSIONS,
      workspace: WORKSPACE || undefined
    }),
    // preload: ipcRenderer.invoke('permissions:get') → 与 gateway.getPermissions() 同一份。
    // 读服务端现价（改了档位后别的页/别的入口立刻一致），断线时退回上次已知值。
    getPermissions: async () => {
      try {
        PERMISSIONS = await agentCall('desktop.get_permissions');
      } catch (e) {
        console.warn('[dieyun-headless] 读取权限失败，沿用上次值：', e && e.message);
      }
      return PERMISSIONS;
    },
    // preload: ipcRenderer.invoke('permissions:set', perms) —— 归一/落盘/作废旧批准都在 Gateway 里
    setPermissions: async (perms) => {
      PERMISSIONS = await agentCall('desktop.set_permissions', { permissions: perms || {} });
      return PERMISSIONS;
    },
    // preload: ipcRenderer.invoke('workspace:get') → Promise，返回的是 gateway.getWorkspace() 的形状
    // （{kind, workspacePath, displayPath, sshConnected}），不是裸字符串
    getWorkspace: async () =>
      WORKSPACE ? { kind: 'local', workspacePath: WORKSPACE, displayPath: WORKSPACE, sshConnected: false } : null,
    // preload: ipcRenderer.invoke('workspace:set-local', { path }) —— 浏览器里经同源 /ws 让服务端
    // 改 Gateway 的工作区根（与桌面端同一条流程，路径存在性由服务端校验），返回生效后的形状
    setLocalWorkspace: async (pathValue) => applyWorkspace(await agentCall('desktop.set_workspace', { path: pathValue || '' })),
    // preload: ipcRenderer.invoke('workspace:set', p)。桌面端本地/SSH 都认；浏览器版只有本地通道
    // （从网页连 SSH 需要服务端出站，未实现），非本地输入交服务端归一后按本地处理
    setWorkspace: async (p) => applyWorkspace(await agentCall('desktop.set_workspace', { path: p || '' })),
    // 浏览器版没有系统目录框：给渲染层一个**服务端**目录浏览（只列子目录），
    // 让它把「切换工作空间」做成列表选择而不是手填路径。桌面端走 pickFolder，不需要这个。
    browseServerDir: async (p) => agentCall('desktop.list_dirs', { path: p || '' }),
    // preload: ipcRenderer.invoke('agent:prep-system-prompt', snapshot) —— 系统提示装配
    // （AGENTS.md / 记忆 / 技能 / MCP / 共享记忆召回）只能有一份，在服务端 system-prompt-prep-main。
    // 没有它渲染层会退到本地兜底装配，浏览器里的会话会少一大截上下文。
    agentPrepSystemPrompt: async (snapshot) => agentCall('desktop.prep_system_prompt', { snapshot: snapshot || {} }),
    // 设置 → 扩展 →「共享记忆」：与桌面 IPC 同一份动作实现（src/memory-shared/actions.js）
    sharedMemoryStatus: async () => agentCall('desktop.shm_status', {}),
    sharedMemorySave: async (patch) => agentCall('desktop.shm_save', { patch: patch || {} }),
    sharedMemoryTest: async (patch) => agentCall('desktop.shm_test', { patch: patch || {} }),
    sharedMemoryProbe: async () => agentCall('desktop.shm_probe', {}),
    sharedMemoryConsolidate: async () => agentCall('desktop.shm_consolidate', {}),
    // 帮助 → 关于 →「检查更新」：服务器版不自建更新客户端，升级走 apt（docs/HEADLESS.md §8）。
    // 服务端跑只读的 apt-get -s（不需要 root），把结论按桌面端同一套 phase 推给渲染层，
    // 所以「关于」页那行文字与按钮行为跟桌面一致，只是结论来自 apt 而不是 electron-updater。
    checkForUpdates: async () => {
      pushUpdateState({ phase: 'checking', message: '正在检查更新…' });
      try {
        const r = await agentCall('desktop.check_update', {});
        if (!r || r.ok === false) {
          pushUpdateState({ phase: 'error', message: (r && r.error) || '检查失败' });
          return { pending: false };
        }
        pushUpdateState({ phase: 'idle', message: r.message || '已是最新版本' });
        return { pending: false };
      } catch (e) {
        pushUpdateState({ phase: 'error', message: '检查更新失败：' + ((e && e.message) || e) });
        return { pending: false };
      }
    },
    getUpdateState: async () => updateState,
    onAppUpdateState: (cb) => {
      if (typeof cb !== 'function') return () => {};
      updateSubs.add(cb);
      return () => updateSubs.delete(cb);
    },
    // preload 里这个是**同步**的（webUtils.getPathForFile），浏览器拿不到真实路径
    getPathForFile: () => null,
    // preload: ipcRenderer.send('renderer:freeze-beat') —— 单向，无返回值
    rendererFreezeBeat: () => {},
    // 模型配置（端点 / 模型 / key）由服务端从 model-settings.json 读出来注入；渲染层靠它选模型
    getModelSettingsFromMain: async () => MODEL_SETTINGS,
    // preload: ipcRenderer.invoke('model:sync-settings', settings) —— 网页里保存模型设置
    // 就是改服务器上那份 model-settings.json（收尾与桌面端同一份实现：落盘 + 推语音设置给
    // 手机端 + 让 core 重读配置）。写失败时抛出去，别让界面以为存好了。
    syncModelSettings: async (settings) => {
      const res = await agentCall('desktop.save_model_settings', { settings: settings || {} });
      if (res && res.ok === false) throw new Error('保存模型设置失败：写服务器上的 model-settings.json 出错（详见服务日志）');
      return res;
    },
    // preload: ipcRenderer.invoke('models:fetch-list') —— 供应商「检测可用模型」。
    // 检测要出网（GET /models + 逐个探测 chat/completions），浏览器直连会被模型端点的
    // CORS 拦掉，所以交给同一台服务器跑（desktop.fetch_models），语义与桌面端同一份实现。
    fetchBuiltinModels: async (payload) => agentCall('desktop.fetch_models', { payload: payload || {} }),
    // 流式聊天：等价于主进程的 streamChatViaMain
    streamChatViaMain: async ({ url, headers, body, onRaw, onControl }) => {
      const resp = await postLlm(url, headers, body, onControl);
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (typeof onRaw === 'function') onRaw(decoder.decode(value || new Uint8Array(), { stream: true }));
      }
    },
    // 非流式单次请求：等价于主进程的 llmChatCompletion
    llmChatCompletion: async ({ url, headers, body, onControl }) => {
      const resp = await postLlm(url, headers, body, onControl);
      return resp.json();
    },
    // 主循环（等价于主进程的 agent:rust-loop-run）：服务器用同一份 runRustAgentLoop 跑，
    // 工具在服务器执行，phase 事件按 cancelToken 推给本页
    agentRustLoopRun: async (payload) => agentCall('desktop.loop_run', { payload }),
    agentRustLoopCancel: async ({ cancelToken }) => agentCall('desktop.loop_cancel', { cancelToken }),
    // preload: ipcRenderer.on('agent:rust-loop-phase') → 返回取消订阅函数
    onAgentRustLoopPhase: (cb) => {
      if (typeof cb !== 'function') return () => {};
      // 句柄是每轮局部变量（cancelToken），订阅本身是全局一条流：各订阅自己按 token 过滤
      const wrapped = (ev) => cb(ev);
      phaseSubs.add(wrapped);
      return () => phaseSubs.delete(wrapped);
    },
    // —— 内网 agent 互通（preload 的同名接口）——
    // 动作语义只有一份（src/peer/actions.js，桌面 IPC 也调它）；这里只把调用经同源 /ws
    // 转到服务端 peer.<name>，事件经 channel='peer' 的 event 帧推回。面板代码零改动。
    peerStatus: () => agentCall('peer.status', {}),
    peerRefresh: () => agentCall('peer.refresh', {}),
    peerSetName: (name) => agentCall('peer.set-name', { name }),
    peerSetRole: (role) => agentCall('peer.set-role', { role }),
    peerSetEnabled: (enabled) => agentCall('peer.set-enabled', { enabled: !!enabled }),
    peerSetAutoTurn: (enabled) => agentCall('peer.set-auto-turn', { enabled: !!enabled }),
    // 授权默认值（未表态对端是否放行）：服务器首启就是 true，网页里可改回人工确认
    peerSetAutoTrust: (enabled) => agentCall('peer.set-auto-trust', { enabled: !!enabled }),
    peerTrust: (peerId, decision) => agentCall('peer.trust', { peerId, decision }),
    peerUntrust: (peerId) => agentCall('peer.untrust', { peerId }),
    peerTrustList: () => agentCall('peer.trust-list', {}),
    peerSetStaticPeers: (peers) => agentCall('peer.set-static-peers', { peers: peers || [] }),
    peerSend: (payload) => agentCall('peer.send', payload || {}),
    peerSendSession: (payload) => agentCall('peer.send-session', payload || {}),
    peerOpenSession: (peer) => agentCall('peer.open-session', { peer }),
    peerLinkSession: (sessionId, peerId) => agentCall('peer.link-session', { sessionId, peerId }),
    peerUnlinkSession: (sessionId) => agentCall('peer.unlink-session', { sessionId }),
    peerClaim: (payload) => agentCall('peer.claim', payload || {}),
    peerRooms: () => agentCall('peer.rooms', {}),
    peerRoomCreate: (payload) => agentCall('peer.room-create', payload || {}),
    peerRoomClose: (roomId) => agentCall('peer.room-close', { roomId }),
    peerRoomSend: (payload) => agentCall('peer.room-send', payload || {}),
    peerRoomTimeline: (payload) => agentCall('peer.room-timeline', payload || {}),
    // preload: ipcRenderer.on('peer:event') → 返回取消订阅函数
    onPeerEvent: (cb) => {
      if (typeof cb !== 'function') return () => {};
      const wrapped = (frame) => cb(frame && frame.event ? frame.event : frame);
      peerSubs.add(wrapped);
      return () => peerSubs.delete(wrapped);
    },
    // 用量统计在 Main 侧汇总；浏览器里没有那份账本，本地累加没有意义也不影响展示
    addTokens: () => {}
  };
  // 环境事实：会话没绑定工作空间时文件工具实际写入哪里（渲染层的 composer 标签要如实显示）
  applyWorkspace(WORKSPACE ? { kind: 'local', workspacePath: WORKSPACE } : null);
  const warned = new Set();
  const proxy = new Proxy(real, {
    has: (t, k) => typeof k === 'string' && Object.prototype.hasOwnProperty.call(real, k),
    get: (t, k) => {
      if (typeof k !== 'string' || Object.prototype.hasOwnProperty.call(real, k)) return t[k];
      // 只点名一次，避免刷屏；能力探测（if (api.x)）读到的就是 undefined
      if (k !== 'then' && k !== 'toJSON' && !warned.has(k)) {
        warned.add(k);
        console.warn('[dieyun-headless] 浏览器里没有 window.diecloud.' + k + '（Electron 主进程能力，界面会走降级分支）');
      }
      return undefined;
    }
  });
  Object.defineProperty(window, 'diecloud', { value: proxy, writable: false, configurable: true });

  // 明文 HTTP 的 192.168.x.x 不是「安全上下文」（只有 localhost 才豁免），所以
  // crypto.randomUUID 与 navigator.clipboard 都不存在 —— 渲染层用它们生成请求 id / 复制。
  // 这两个都只是「API 在非安全上下文被藏起来」，用同样语义补回来即可，不需要 HTTPS。
  try {
    const c = window.crypto || (window.crypto = {});
    if (typeof c.randomUUID !== 'function') {
      const buf = new Uint8Array(16);
      const randomUUID = () => {
        if (typeof c.getRandomValues === 'function') c.getRandomValues(buf);
        else for (let i = 0; i < 16; i += 1) buf[i] = Math.floor(Math.random() * 256);
        buf[6] = (buf[6] & 0x0f) | 0x40;
        buf[8] = (buf[8] & 0x3f) | 0x80;
        const h = Array.prototype.map.call(buf, (b) => b.toString(16).padStart(2, '0')).join('');
        return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20);
      };
      Object.defineProperty(c, 'randomUUID', { value: randomUUID, configurable: true, writable: true });
      console.info('[dieyun-headless] 已补 crypto.randomUUID（非安全上下文里浏览器不提供）');
    }
  } catch (e) {
    console.warn('[dieyun-headless] crypto.randomUUID 补丁失败：', e && e.message);
  }

  if (!navigator.clipboard) {
    const writeText = async (text) => {
      const ta = document.createElement('textarea');
      ta.value = String(text == null ? '' : text);
      ta.setAttribute('readonly', 'readonly');
      ta.style.position = 'fixed';
      ta.style.top = '-1000px';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try {
        if (!document.execCommand('copy')) throw new Error('execCommand copy 被拒绝');
      } finally {
        ta.remove();
      }
    };
    try {
      Object.defineProperty(navigator, 'clipboard', {
        value: { writeText: writeText, readText: async () => '' },
        configurable: true
      });
      console.info('[dieyun-headless] 已补 navigator.clipboard（非安全上下文里浏览器不提供）');
    } catch (e) {
      console.warn('[dieyun-headless] navigator.clipboard 补丁失败：', e && e.message);
    }
  }
})();
`;
}

/**
 * @param {{
 *   packageRoot: string,          // 包根（含 src/renderer 与 node_modules）
 *   rendererDir?: string,         // 默认 <packageRoot>/src/renderer
 *   getGatewayInfo: () => {url:string, token:string, port:number},
 *   getWebToken: () => string,    // 与手机端共用的访问 token
 *   getWorkspace?: () => string,  // 注入给 getWorkspace()，桌面端是主进程持有的当前工作空间
 *   getModelSettings?: () => object|null,  // 注入给 getModelSettingsFromMain()（含端点/模型/key）
 *   log?: (msg: string) => void
 * }} opts
 */
function createDesktopUi(opts) {
  const packageRoot = opts.packageRoot;
  const rendererDir = opts.rendererDir || path.join(packageRoot, 'src', 'renderer');
  const log = typeof opts.log === 'function' ? opts.log : () => {};
  const gatewayInfo = opts.getGatewayInfo;
  const webToken = opts.getWebToken;
  /** 收到 /gateway 的 upgrade 才 handleUpgrade；不需要挂到 server 上（路由在 MobileBridge） */
  const upgradeWss = new WebSocketServer({ noServer: true });

  function tokenAccepted(req, url) {
    const want = String(webToken() || '');
    if (!want) return false;
    const fromQuery = url.searchParams.get('token') || '';
    if (fromQuery && fromQuery === want) return true;
    return parseCookies(req.headers.cookie)[COOKIE_NAME] === want;
  }

  /**
   * 标签图标：用仓库里那一份（`assets/icon.png`，打包时 `assets/` 整棵进载荷）。
   * 浏览器按内容嗅探，PNG 放在 `/favicon.ico` 上也能正常显示，所以不需要多备一份 ico。
   */
  function sendFavicon(res) {
    const candidates = [
      { file: path.join(packageRoot, 'assets', 'icon.png'), type: 'image/png' },
      { file: path.join(packageRoot, 'assets', 'icon.ico'), type: 'image/x-icon' }
    ];
    for (const c of candidates) {
      try {
        if (fs.existsSync(c.file) && fs.statSync(c.file).isFile()) {
          send(res, 200, { 'Content-Type': c.type, 'Cache-Control': 'public, max-age=86400' }, fs.readFileSync(c.file));
          return;
        }
      } catch {
        // 换下一个候选
      }
    }
    // 真没有图标就安静回 204（别刷 404）
    send(res, 204, { 'Cache-Control': 'public, max-age=86400' }, '');
  }

  function resolveFile(root, relPath) {
    const decoded = decodeURIComponent(relPath);
    if (decoded.includes('\0')) return null;
    const abs = path.resolve(root, '.' + path.posix.normalize('/' + decoded));
    const rootAbs = path.resolve(root);
    if (abs !== rootAbs && !abs.startsWith(rootAbs + path.sep)) return null;
    return abs;
  }

  function send(res, status, headers, body) {
    res.writeHead(status, headers);
    res.end(body);
  }

  /**
   * 同源 LLM 转发：桌面端这条请求是 Main 代发的（preload 的 streamChatViaMain / llmChatCompletion），
   * 浏览器里没有 Main，就直接转发到上游。作用有两个：
   *  - 模型端点通常不返回 CORS 头（实测本机的 gunicorn 端点没有 `Access-Control-Allow-Origin`），
   *    浏览器跨源 POST 会被直接拦掉；
   *  - 前端不用为「另一台机器上的模型服务」改配置，同源即可。
   * 仍然要求 token（否则就是一个局域网开放代理）；上游地址由请求头 `x-dieyun-upstream` 指定。
   */
  function handleLlmProxy(req, res, url) {
    if (!tokenAccepted(req, url)) {
      send(res, 401, { 'Content-Type': 'text/plain; charset=utf-8' }, '需要 token');
      return;
    }
    if (req.method !== 'POST') {
      send(res, 405, { 'Content-Type': 'text/plain; charset=utf-8', Allow: 'POST' }, '只接受 POST');
      return;
    }
    let target;
    try {
      target = new URL(String(req.headers['x-dieyun-upstream'] || ''));
    } catch {
      send(res, 400, { 'Content-Type': 'text/plain; charset=utf-8' }, '缺少或非法的 x-dieyun-upstream');
      return;
    }
    if (target.protocol !== 'http:' && target.protocol !== 'https:') {
      send(res, 400, { 'Content-Type': 'text/plain; charset=utf-8' }, '只支持 http/https 上游');
      return;
    }
    const headers = Object.assign({}, req.headers);
    // 不把本服务的 cookie / 来源信息带给上游，也不要 hop-by-hop 头
    delete headers['x-dieyun-upstream'];
    delete headers.cookie;
    delete headers.host;
    delete headers.origin;
    delete headers.referer;
    delete headers.connection;
    delete headers['content-length'];
    const mod = target.protocol === 'https:' ? require('https') : require('http');
    const upstream = mod.request(
      target,
      { method: 'POST', headers: Object.assign(headers, { host: target.host }) },
      (upRes) => {
        res.writeHead(upRes.statusCode || 502, upRes.headers);
        upRes.pipe(res);
      }
    );
    upstream.on('error', (e) => {
      log(`LLM 转发失败 ${target.origin}${target.pathname}: ${e && e.message}`);
      if (!res.headersSent) send(res, 502, { 'Content-Type': 'text/plain; charset=utf-8' }, '上游请求失败: ' + (e && e.message));
      else res.end();
    });
    req.pipe(upstream);
  }

  /** 返回 true 表示「这个请求归我处理」 */
  function handleHttp(req, res) {
    let url;
    try {
      url = new URL(req.url || '/', 'http://localhost');
    } catch {
      return false;
    }
    if (!mountOf(url.pathname)) return false;
    if (url.pathname === '/llm') {
      handleLlmProxy(req, res, url);
      return true;
    }
    // 图标不算敏感、也不带任何机器信息：不要求 token（否则首次打开时 cookie 还没到，标签就没图）
    if (url.pathname === FAVICON_PATH) {
      sendFavicon(res);
      return true;
    }
    if (!tokenAccepted(req, url)) {
      send(res, 401, { 'Content-Type': 'text/plain; charset=utf-8' }, '需要 token：<本页地址>?token=<mobile-bridge-token.txt 内容>');
      return true;
    }

    const isIndex = url.pathname === '/app' || url.pathname === '/app/' || url.pathname === '/app/index.html';
    const setCookie = { 'Set-Cookie': `${COOKIE_NAME}=${encodeURIComponent(String(webToken()))}; Path=/; SameSite=Lax; HttpOnly` };

    if (url.pathname === SHIM_PATH) {
      const info = gatewayInfo();
      const body = buildShim({
        // 同源代理：浏览器连 /gateway，由本服务转发到 127.0.0.1 的 Gateway
        gatewayUrl: `ws://${req.headers.host || '127.0.0.1'}/gateway`,
        gatewayToken: info && info.token ? info.token : '',
        webToken: String(webToken() || ''),
        workspacePath: typeof opts.getWorkspace === 'function' ? opts.getWorkspace() : '',
        modelSettings: typeof opts.getModelSettings === 'function' ? opts.getModelSettings() : null,
        rustCoreReady: typeof opts.getRustCoreReady === 'function' ? opts.getRustCoreReady() !== false : true,
        permissions: typeof opts.getPermissions === 'function' ? opts.getPermissions() : {}
      });
      send(res, 200, { 'Content-Type': MIME['.js'], 'Cache-Control': 'no-store', ...setCookie }, body);
      return true;
    }

    const mount = mountOf(url.pathname);
    let sliced = '';
    let roots;
    if (mount === 'node_modules') {
      // 先找包内 node_modules，再找打包时额外带的 web-vendor（渲染层的 <script> 用到的浏览器包
      // 不在 Node 依赖闭包里，会被裁剪掉，见 scripts/pack-headless.cjs 的 vendorWebScripts）
      sliced = url.pathname.slice('/node_modules'.length);
      roots = [path.join(packageRoot, 'node_modules'), path.join(packageRoot, 'web-vendor', 'node_modules')];
    } else if (mount === 'src-file') {
      sliced = url.pathname;
      roots = [path.join(packageRoot, 'src')];
    } else {
      sliced = url.pathname.slice('/app'.length);
      roots = [rendererDir];
    }
    // `/app` 与 `/app/` 都给 index.html；否则照路径取文件
    const relPath = !sliced || sliced === '/' ? '/index.html' : sliced;
    let filePath = null;
    for (const root of roots) {
      const candidate = resolveFile(root, relPath);
      if (candidate && fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        filePath = candidate;
        break;
      }
    }
    if (!filePath) {
      send(res, 404, { 'Content-Type': 'text/plain; charset=utf-8' }, 'not found: ' + relPath);
      return true;
    }
    const ext = path.extname(filePath).toLowerCase();
    const type = MIME[ext] || 'application/octet-stream';
    if (isIndex && ext === '.html') {
      // 第一行就注入替身，保证渲染层的任何脚本都能看到 window.diecloud；
      // 标签图标也在这里补上（渲染层原本没有 <link rel="icon">，那是 Electron 窗口不需要的东西）
      const html = fs
        .readFileSync(filePath, 'utf8')
        .replace(
          /<head([^>]*)>/i,
          `<head$1>\n    <link rel="icon" type="image/png" href="${FAVICON_PATH}" />` +
            `\n    <link rel="apple-touch-icon" href="${FAVICON_PATH}" />` +
            `\n    <script src="${SHIM_PATH}"></script>`
        );
      send(res, 200, { 'Content-Type': type, 'Cache-Control': 'no-store', ...setCookie }, html);
      return true;
    }
    send(res, 200, { 'Content-Type': type, 'Cache-Control': 'no-cache', ...setCookie }, fs.readFileSync(filePath));
    return true;
  }

  /**
   * 同源 WS 代理：`/gateway` → `ws://127.0.0.1:<gateway.port>`（帧原样转发，鉴权仍由 Gateway 自己判）。
   * 由 MobileBridge 的 upgrade 路由调用，返回 true 表示「这个 upgrade 归我」。
   */
  function handleUpgrade(req, socket, head) {
    let url;
    try {
      url = new URL(req.url || '/', 'http://localhost');
    } catch {
      return false;
    }
    if (url.pathname !== '/gateway') return false;
    if (!tokenAccepted(req, url)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return true;
    }
    upgradeWss.handleUpgrade(req, socket, head, (client) => {
      const info = gatewayInfo() || {};
      const upstream = new WebSocket(`ws://127.0.0.1:${Number(info.port) || 0}`);
      const pending = [];
      const shutdown = () => {
        try {
          client.close();
        } catch {
          /* ignore */
        }
        try {
          upstream.close();
        } catch {
          /* ignore */
        }
      };
      client.on('message', (data, isBinary) => {
        if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary: isBinary });
        else pending.push([data, isBinary]);
      });
      upstream.on('open', () => {
        while (pending.length) {
          const [data, isBinary] = pending.shift();
          upstream.send(data, { binary: isBinary });
        }
      });
      upstream.on('message', (data, isBinary) => {
        if (client.readyState === WebSocket.OPEN) client.send(data, { binary: isBinary });
      });
      client.on('close', shutdown);
      upstream.on('close', shutdown);
      client.on('error', shutdown);
      upstream.on('error', (e) => {
        log('desktop-ui gateway proxy error: ' + (e && e.message));
        shutdown();
      });
    });
    return true;
  }

  return { handleHttp, handleUpgrade };
}

module.exports = { createDesktopUi, buildShim, mountOf, COOKIE_NAME, SHIM_PATH, FAVICON_PATH };

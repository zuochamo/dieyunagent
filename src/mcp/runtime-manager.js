'use strict';

const fs = require('fs/promises');
const nodeFs = require('fs');
const path = require('path');
const { Client } = require('@modelcontextprotocol/sdk/client');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const { SSEClientTransport } = require('@modelcontextprotocol/sdk/client/sse.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const { transportKind } = require('./server-config');
const { validateMcpInputArgs } = require('../agent/tool-validate');
// 工具名编码的单一来源（Renderer 的只读白名单要按同一前缀判定，故不能再放在本文件里）
const { encodeMcpToolName, simpleHash } = require('./tool-name');

const CONNECT_TIMEOUT_MS = 60000;
const CALL_TIMEOUT_MS = 120000;
const TOOLS_CACHE_MS = 60000;

/**
 * 自动刷新路径的连接失败退避：30 秒起、逐次翻倍、上限 2 分钟。
 *
 * 目录刷新是「机会式」的（见 listAgentTools），每次都会把未连上的服务试一遍 ——
 * 这对「宿主稍后才启动」的服务（unreal 的 127.0.0.1:8000、blender 的 9876）是必需的，
 * 所以退避上限必须短：宿主起来后 2 分钟内必须能被自动发现。
 * 但失败不能每次都打日志（实测 unreal 每 1~3 分钟刷一条 warn），故另配日志节流。
 *
 * **按需路径不受退避限制**（callTool / 指定 serverIds 的强制刷新）：用户刚把宿主拉起来
 * 就该立刻连上，不该等退避窗口过去。
 */
const RECONNECT_BACKOFF_BASE_MS = 30000;
const RECONNECT_BACKOFF_MAX_MS = 120000;

/** 同一服务「同一错误」的日志节流窗口：期间只记一条，并在下一条里补报被静默的次数 */
const CONNECT_FAILURE_LOG_INTERVAL_MS = 10 * 60 * 1000;

/** @param {number} failures 连续失败次数（从 1 起） */
function reconnectBackoffMs(failures) {
  const n = Math.max(1, Math.floor(Number(failures) || 1));
  return Math.min(RECONNECT_BACKOFF_MAX_MS, RECONNECT_BACKOFF_BASE_MS * 2 ** (n - 1));
}

/**
 * 子进程 stderr 尾部缓冲上限。
 *
 * 子进程的 stderr 是唯一能看见「服务器起来了但用不了 / 为什么退出」的地方，而打包态
 * Electron main 没有控制台 —— 原来的 `inherit` 等于把这段输出丢进黑洞，MCP 链路又
 * 不写任何主日志，于是「已启用但静默变砖」只能靠用户描述现象。这里改成读到尾部缓冲，
 * 在会话断开 / 连接失败时交给日志；只留尾部、不逐行转写（服务的审计行很吵）。
 */
const STDERR_TAIL_LIMIT = 4000;

function extractMcpText(result) {
  if (!result || !Array.isArray(result.content)) return '';
  return result.content
    .map((part) => {
      if (!part || typeof part !== 'object') return '';
      if (part.type === 'text') return String(part.text || '');
      if (part.type === 'image') return '[image]';
      return JSON.stringify(part);
    })
    .filter(Boolean)
    .join('\n');
}

/** 非文本 part（图片等）单独保留，避免为去掉重复文本而丢掉附件内容 */
function extractNonTextParts(result) {
  if (!result || !Array.isArray(result.content)) return null;
  const parts = result.content
    .filter((part) => part && typeof part === 'object' && part.type !== 'text')
    // 图片的 data 交给视觉缓冲（见 extractMcpImages），这里只留类型标记：
    // 否则 base64 会把工具结果 JSON 撑到几百 KB，再被 spill/cap 截成半截乱码。
    .map((part) => (part.type === 'image' ? { type: 'image', mimeType: part.mimeType || null } : part));
  return parts.length ? parts : null;
}

/**
 * 抽出 MCP 结果里的图片本体（blender-mcp 的 look / viewport_capture 等）。
 * 调用方（tool-bridge-main）会把它们送进视觉缓冲，在下一轮 LLM 请求前注入。
 * @returns {Array<{ mime: string, base64: string }> | null}
 */
function extractMcpImages(result) {
  if (!result || !Array.isArray(result.content)) return null;
  const out = [];
  for (const part of result.content) {
    if (!part || typeof part !== 'object' || part.type !== 'image') continue;
    const data = typeof part.data === 'string' ? part.data : '';
    if (!data) continue;
    out.push({ mime: String(part.mimeType || part.mime || 'image/png'), base64: data });
  }
  return out.length ? out : null;
}

function formatMcpCallResult(result) {
  const text = extractMcpText(result);
  if (result && result.isError) {
    return { error: text || 'MCP 工具返回错误' };
  }
  // 不返回完整 result.raw：它内部又装了一份同样的文本，会让结果 JSON 长度翻倍，
  // 进而与 spill(8192) / cap(14000) 的阈值判定错位，出现"该截断的没截断、或从头截断"的缝隙。
  const out = { ok: true, content: text || '(无文本输出)' };
  const nonText = extractNonTextParts(result);
  if (nonText) out.raw = { content: nonText };
  // 图片本体单独传：由 tool-bridge 送进视觉缓冲，模型下一轮真正「看见」
  const images = extractMcpImages(result);
  if (images) out.visionImages = images;
  return out;
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error(`${label} 超时（${ms / 1000}s）`)), ms);
    })
  ]);
}

function buildAuthHeaderValue(headerName, token) {
  const raw = String(token || '').trim();
  if (!raw) return '';
  if (raw.includes(' ')) return raw;
  if (String(headerName || '').toLowerCase() === 'authorization') {
    return raw.startsWith('Bearer ') ? raw : `Bearer ${raw}`;
  }
  return raw;
}

/**
 * 密钥指纹：签名只用来判断「是否需要重建连接」，不能出现明文（可能被日志打印）。
 * 早前 remote 只记 '1'/'0'，导致换 token 后签名不变、连接不重建，用户以为改了没生效。
 */
function secretFingerprint(secret) {
  const text = String(secret || '');
  if (!text) return '0';
  return `h${simpleHash(text)}`;
}

function serverSignature(server, secrets) {
  const kind = transportKind(server);
  if (kind === 'remote') {
    return JSON.stringify({
      kind,
      remoteUrl: server.remoteUrl || '',
      remoteTransport: server.remoteTransport || 'streamable-http',
      authHeaderName: server.authHeaderName || 'Authorization',
      token: secretFingerprint(secrets && secrets.token)
    });
  }
  return JSON.stringify({
    kind,
    command: server.command || '',
    args: server.args || [],
    env: secrets && secrets.env ? secrets.env : {}
  });
}

function createRemoteTransport(server, secrets) {
  const url = new URL(String(server.remoteUrl || '').trim());
  const headers = {};
  const headerName = String(server.authHeaderName || 'Authorization').trim() || 'Authorization';
  const token = secrets && secrets.token ? buildAuthHeaderValue(headerName, secrets.token) : '';
  if (token) headers[headerName] = token;
  const requestInit = Object.keys(headers).length ? { headers } : undefined;
  const remoteTransport = String(server.remoteTransport || 'streamable-http').trim();
  if (remoteTransport === 'sse') {
    return new SSEClientTransport(url, requestInit ? { requestInit } : undefined);
  }
  return new StreamableHTTPClientTransport(url, requestInit ? { requestInit } : undefined);
}

class McpSession {
  /**
   * @param {object} server
   * @param {{ token?: string, env?: Record<string, string> }} [secrets]
   * @param {{ getWorkspacePath?: () => string, ensureLocalPackage?: (server: object) => Promise<{ server?: object }>, log?: (msg: string) => void }} [opts]
   */
  constructor(server, secrets, opts = {}) {
    this.server = server;
    this.secrets = secrets || { token: '', env: {} };
    this.opts = opts || {};
    this.log = typeof this.opts.log === 'function' ? this.opts.log : () => {};
    this.client = null;
    this.transport = null;
    this.tools = [];
    this.connecting = null;
    this.lastError = null;
    this.signature = serverSignature(server, this.secrets);
    /** 会话代次：disconnect / 重建时自增，用于丢弃「超时后才完成」的过期连接 */
    this.generation = 0;
    /** 连续连接失败次数（成功后归零），用于算退避 */
    this.failureCount = 0;
    /** 首次失败时间戳（成功后归零），恢复日志里报「断了多久」 */
    this.failureSince = 0;
    /** 退避截止时间戳：自动刷新在它之前不再重试 */
    this.retryNotBefore = 0;
    /** 日志节流：上次打失败日志的时间 / 文本，以及其间被静默的次数 */
    this.lastFailureLogAt = 0;
    this.lastFailureLogText = '';
    this.suppressedFailures = 0;
  }

  /**
   * @param {{ force?: boolean }} [options] force=true 用于「用户或工具按需触发」的路径
   *   （callTool / 指定 serverIds 的强制刷新）：不受退避限制，宿主刚启动也能立刻连上。
   */
  async connect(options = {}) {
    const force = !!(options && options.force);
    if (this.client) return;
    if (this.connecting) return this.connecting;
    if (!force && Date.now() < this.retryNotBefore) {
      // 退避期内不重试，但把「最后一次真实失败」的原因原样抛出 ——
      // 调用方看到的错误与真连一次完全一致，只是不再产生网络活动。
      const err = new Error(this.lastError || `MCP「${this.server.id}」暂不可用`);
      err.code = 'MCP_BACKOFF';
      err.retryAfterMs = this.retryNotBefore - Date.now();
      throw err;
    }
    const generation = this.generation;
    this.connecting = withTimeout(
      this._connectInner(generation),
      CONNECT_TIMEOUT_MS,
      `MCP「${this.server.id}」连接`
    );
    try {
      await this.connecting;
      this.noteConnectSuccess();
    } catch (err) {
      this.lastError = err.message || String(err);
      this.noteConnectFailure();
      throw err;
    } finally {
      this.connecting = null;
    }
  }

  /** 连上后清退避；若之前失败过，补一条恢复日志（否则只有断开日志、没有恢复日志，日志是残的） */
  noteConnectSuccess() {
    const failures = this.failureCount;
    const since = this.failureSince;
    this.failureCount = 0;
    this.failureSince = 0;
    this.retryNotBefore = 0;
    this.suppressedFailures = 0;
    this.lastFailureLogText = '';
    this.lastFailureLogAt = 0;
    if (failures > 0) {
      const seconds = since ? Math.round((Date.now() - since) / 1000) : 0;
      this.log(`MCP「${this.server.id}」已恢复连接（此前连续失败 ${failures} 次，历时 ${seconds} 秒）`);
    }
  }

  /**
   * 记一次失败：累计退避 + 节流打日志。
   * 连接失败只落在 tool catalog 的 errors 里，而那个文件不是排查入口，所以这里必须打主日志；
   * 但同一个错误不能每 1~3 分钟刷一条（宿主没开的服务会一直失败），所以按窗口节流。
   */
  noteConnectFailure() {
    const now = Date.now();
    this.failureCount += 1;
    if (!this.failureSince) this.failureSince = now;
    this.retryNotBefore = now + reconnectBackoffMs(this.failureCount);

    const sameText = this.lastFailureLogText === this.lastError;
    if (sameText && now - this.lastFailureLogAt < CONNECT_FAILURE_LOG_INTERVAL_MS) {
      this.suppressedFailures += 1;
      return;
    }
    const suppressed = this.suppressedFailures;
    this.lastFailureLogAt = now;
    this.lastFailureLogText = this.lastError;
    this.suppressedFailures = 0;
    const tail = suppressed > 0 ? `；另有 ${suppressed} 次同类失败未重复记录` : '';
    this.log(`MCP「${this.server.id}」连接失败：${this.lastError}${tail}`);
  }

  /** @param {number} generation */
  async _connectInner(generation) {
    const kind = transportKind(this.server);
    const client = new Client({ name: 'dieyunagent', version: '0.0.1' }, { capabilities: {} });
    let transport;
    let stderrTail = '';
    const logStderrTail = (reason) => {
      const tail = stderrTail.trim();
      if (tail) this.log(`MCP「${this.server.id}」${reason}，子进程 stderr 尾部：\n${tail}`);
    };
    try {
      if (kind === 'remote') {
        transport = createRemoteTransport(this.server, this.secrets);
      } else {
        let stdioServer = this.server;
        if (typeof this.opts.ensureLocalPackage === 'function') {
          const prepared = await this.opts.ensureLocalPackage(this.server);
          if (prepared && prepared.server) stdioServer = prepared.server;
        }
        const launchEnv =
          stdioServer.launchEnv && typeof stdioServer.launchEnv === 'object' ? stdioServer.launchEnv : {};
        const env = { ...process.env, ...launchEnv, ...(this.secrets.env || {}) };
        const workspacePath =
          typeof this.opts.getWorkspacePath === 'function' ? String(this.opts.getWorkspacePath() || '') : '';
        const args = (stdioServer.args || []).map((arg) =>
          String(arg)
            .replace(/\{\{workspace\}\}/g, workspacePath || process.cwd())
            .replace(/\$\{workspace\}/g, workspacePath || process.cwd())
            .replace(/\$WORKSPACE/g, workspacePath || process.cwd())
        );
        transport = new StdioClientTransport({
          command: stdioServer.command,
          args,
          env,
          // 'pipe' 而不是 'inherit'：打包态 main 进程没有控制台，继承过去的 stderr 没人接，
          // 子进程的报错等于丢弃。管道有人读（下面读进尾部缓冲）就不会写满阻塞。
          stderr: 'pipe'
        });
        if (transport.stderr && typeof transport.stderr.on === 'function') {
          transport.stderr.on('data', (chunk) => {
            stderrTail = (stderrTail + String(chunk)).slice(-STDERR_TAIL_LIMIT);
          });
        }
      }
      await client.connect(transport);
      // 子进程自己退出（崩溃 / EOF）时，SDK 会清掉自己的 transport 并回调 onclose，
      // 但 this.client 是本对象的字段，不跟着复位就会永久短路在 connect() 开头的
      // `if (this.client) return` —— 之后每次调用都被 SDK 同步拒成 "Not connected"，
      // 该服务静默变砖到重启应用。复位后下一次调用即重新 spawn。
      // 用身份比较：只有「当前在用的这条连接」关闭才复位，过期的连接不许碰新会话。
      client.onclose = () => {
        if (this.client !== client) return;
        this.client = null;
        this.transport = null;
        // 连接已断，工具清单的会话内缓存不再可信（目录缓存另算）：清掉才能让强制刷新真的重建
        this.tools = [];
        this.log(`MCP「${this.server.id}」会话已断开，下次调用将重新连接`);
        logStderrTail('断开时');
      };
      const listed = await client.listTools();
      if (generation !== this.generation) {
        // 会话已被 disconnect / 重建：本次连接作废，必须关掉，
        // 否则 client 会挂在一个已脱离 sessions 的对象上，子进程永不回收
        await closeQuietly(client, transport);
        const stale = new Error('MCP 会话已重建，丢弃过期的连接');
        stale.code = 'MCP_SESSION_STALE';
        throw stale;
      }
      this.client = client;
      this.transport = transport;
      this.tools = listed && Array.isArray(listed.tools) ? listed.tools : [];
      this.lastError = null;
    } catch (err) {
      // 会话已重建的错误是内在信号，不能包上 URL 文案
      if (err && err.code === 'MCP_SESSION_STALE') throw err;
      // 握手失败时 stdio 传输可能已经 spawn 了子进程，不关就会在每次重试后累积成僵尸进程
      logStderrTail('连接失败');
      await closeQuietly(client, transport);
      // 远程失败原文只有 "fetch failed"：看不出连的是哪个地址，也分不清「宿主没开」和「路径写错」
      if (kind === 'remote') throw enrichRemoteConnectError(this.server, err);
      throw err;
    }
  }

  async disconnect() {
    // 代次自增：让「超时后才完成」的在途连接在回填 client 前被识别为过期并回收
    this.generation += 1;
    // 先摘引用再关连接：否则 closeQuietly 触发的 onclose 会走上「非预期断开」分支，
    // 打出「会话已断开，下次调用将重新连接」这种与主动停用相反的日志
    const client = this.client;
    const transport = this.transport;
    this.client = null;
    this.transport = null;
    this.tools = [];
    // 主动停用同样清退避：重新启用（设置页关掉再打开）应当立刻真连一次，而不是被旧退避挡住
    this.failureCount = 0;
    this.failureSince = 0;
    this.retryNotBefore = 0;
    this.suppressedFailures = 0;
    this.lastFailureLogText = '';
    this.lastFailureLogAt = 0;
    await closeQuietly(client, transport);
  }

  async callTool(name, args) {
    // 按需调用绕开退避：宿主刚启动、用户立刻调用时必须立刻真连一次
    await this.connect({ force: true });
    const result = await withTimeout(
      this.client.callTool({ name, arguments: args || {} }),
      CALL_TIMEOUT_MS,
      `MCP 工具「${name}」`
    );
    return formatMcpCallResult(result);
  }
}

/**
 * 远程 MCP 的失败原文只有 "fetch failed"（Node fetch 的通用网络错误），
 * 日志里既看不出连的是哪个地址，也分不清「宿主没开」和「URL/路径写错」。
 * 补上 URL 再抛：主日志与 tool catalog 的 errors 都能直接看到目标地址。
 *
 * @param {object} server
 * @param {any} err
 */
function enrichRemoteConnectError(server, err) {
  const url = String(server.remoteUrl || '').trim();
  const message = err && err.message ? String(err.message) : String(err);
  if (!url || /无法连接/.test(message)) return err;
  const wrapped = new Error(`${url} 无法连接（${message}）`);
  if (err && err.code) wrapped.code = err.code;
  wrapped.cause = err;
  return wrapped;
}

function sessionToolsToAgentTools(serverId, session) {
  const out = [];
  for (const tool of session.tools || []) {
    const agentName = encodeMcpToolName(serverId, tool.name);
    out.push({
      agentName,
      serverId,
      toolName: tool.name,
      description: tool.description || `MCP 工具 ${tool.name}`,
      inputSchema:
        tool.inputSchema && typeof tool.inputSchema === 'object'
          ? tool.inputSchema
          : { type: 'object', properties: {} }
    });
  }
  return out;
}

function isRunnableServer(server) {
  if (!server || server.enabled === false) return false;
  const kind = transportKind(server);
  if (kind === 'remote') return !!String(server.remoteUrl || '').trim();
  if (server.bundledServer) return true;
  return !!String(server.command || '').trim();
}

/**
 * @param {() => Array<object>} getEnabledServers
 * @param {{ catalogPath?: string, log?: (msg: string) => void, getServerSecrets?: (id: string) => { token?: string, env?: Record<string, string> }, getWorkspacePath?: () => string, ensureLocalPackage?: (server: object) => Promise<{ server?: object }> }} [opts]
 */
function createMcpRuntimeManager(getEnabledServers, opts = {}) {
  const catalogPath = opts.catalogPath || '';
  const getServerSecrets = opts.getServerSecrets || (() => ({ token: '', env: {} }));
  /** @type {Map<string, McpSession>} */
  const sessions = new Map();
  /** @type {Map<string, { serverId: string, toolName: string }>} */
  const routes = new Map();
  let toolsCache = null;
  let toolsCacheAt = 0;

  async function readCatalog() {
    if (!catalogPath) return null;
    try {
      const raw = JSON.parse(await fs.readFile(catalogPath, 'utf8'));
      if (raw && Array.isArray(raw.tools)) return raw;
    } catch {
      // ignore
    }
    return null;
  }

  async function saveCatalog(tools, errors) {
    if (!catalogPath) return;
    await fs.mkdir(path.dirname(catalogPath), { recursive: true });
    await fs.writeFile(
      catalogPath,
      JSON.stringify(
        {
          version: 1,
          updatedAt: Date.now(),
          tools: tools || [],
          errors: errors || []
        },
        null,
        2
      ),
      'utf8'
    );
  }

  function invalidateToolsCache() {
    toolsCache = null;
    toolsCacheAt = 0;
    routes.clear();
    if (catalogPath) {
      try {
        nodeFs.rmSync(catalogPath, { force: true });
      } catch {
        // 目录文件不存在或不可删，忽略
      }
    }
  }

  async function syncSessions() {
    const enabled = (getEnabledServers() || []).filter(isRunnableServer);
    const enabledIds = new Set(enabled.map((s) => s.id));
    for (const id of [...sessions.keys()]) {
      if (!enabledIds.has(id)) {
        await sessions.get(id).disconnect();
        sessions.delete(id);
      }
    }
    for (const server of enabled) {
      const secrets = getServerSecrets(server.id) || { token: '', env: {} };
      const existing = sessions.get(server.id);
      const nextSignature = serverSignature(server, secrets);
      if (!existing) {
        sessions.set(
          server.id,
          new McpSession(server, secrets, {
            getWorkspacePath: opts.getWorkspacePath,
            ensureLocalPackage: opts.ensureLocalPackage,
            log: opts.log
          })
        );
        continue;
      }
      if (existing.signature !== nextSignature) {
        await existing.disconnect();
        sessions.set(
          server.id,
          new McpSession(server, secrets, {
            getWorkspacePath: opts.getWorkspacePath,
            ensureLocalPackage: opts.ensureLocalPackage,
            log: opts.log
          })
        );
      }
    }
  }

  async function connectServers(serverIds, { registerRoutes = true, collectTools = true, force = false } = {}) {
    const tools = [];
    const errors = [];
    const idSet = serverIds ? new Set(serverIds.map(String)) : null;
    const sessionEntries = [...sessions.entries()].filter(([serverId]) => !idSet || idSet.has(serverId));

    const connectResults = await Promise.allSettled(
      sessionEntries.map(async ([serverId, session]) => {
        await session.connect({ force });
        return { serverId, session };
      })
    );

    for (let i = 0; i < connectResults.length; i++) {
      const result = connectResults[i];
      const serverId = sessionEntries[i][0];
      if (result.status === 'rejected') {
        errors.push({ serverId, error: result.reason?.message || String(result.reason) });
        continue;
      }
      const { session } = result.value;
      try {
        const agentTools = sessionToolsToAgentTools(serverId, session);
        if (registerRoutes) {
          for (const item of agentTools) {
            routes.set(item.agentName, { serverId, toolName: item.toolName });
          }
        }
        if (collectTools) tools.push(...agentTools);
      } catch (err) {
        errors.push({ serverId, error: err.message || String(err) });
      }
    }
    return { tools, errors };
  }

  /**
   * @param {{ force?: boolean, catalogOnly?: boolean, refreshCatalog?: boolean, serverIds?: string[] }} [options]
   */
  async function listAgentTools(options = {}) {
    const force = !!options.force;
    const catalogOnly = !!options.catalogOnly;
    const refreshCatalog = !!options.refreshCatalog;
    const serverIds = Array.isArray(options.serverIds) ? options.serverIds.filter(Boolean) : null;
    const connectAll = refreshCatalog || !serverIds || !serverIds.length;

    if (catalogOnly) {
      const cat = await readCatalog();
      const catalogFresh =
        cat &&
        cat.tools.length &&
        Date.now() - Number(cat.updatedAt || 0) < TOOLS_CACHE_MS;
      if (catalogFresh) {
        return {
          tools: cat.tools,
          errors: cat.errors || [],
          routes: toolsCache?.routes || new Map(routes),
          catalogOnly: true
        };
      }
    }

    if (!force && !catalogOnly && !serverIds && toolsCache && Date.now() - toolsCacheAt < TOOLS_CACHE_MS) {
      return toolsCache;
    }

    await syncSessions();

    if (connectAll) {
      routes.clear();
      // force 透传：用户点「刷新」/按需路径应当绕开退避，机会式刷新则按退避节流
      const { tools, errors } = await connectServers(null, { registerRoutes: true, collectTools: true, force });
      await saveCatalog(tools, errors);
      toolsCache = { tools, errors, routes: new Map(routes) };
      toolsCacheAt = Date.now();
      return toolsCache;
    }

    const { tools, errors } = await connectServers(serverIds, { registerRoutes: true, collectTools: true, force });
    const prevTools = toolsCache?.tools || (await readCatalog())?.tools || [];
    const mergedTools = [];
    const seen = new Set();
    for (const item of prevTools) {
      if (serverIds.includes(item.serverId)) continue;
      if (seen.has(item.agentName)) continue;
      seen.add(item.agentName);
      mergedTools.push(item);
    }
    for (const item of tools) {
      if (seen.has(item.agentName)) continue;
      seen.add(item.agentName);
      mergedTools.push(item);
    }

    toolsCache = {
      tools: mergedTools,
      errors: [...(toolsCache?.errors || []), ...errors],
      routes: new Map(routes)
    };
    toolsCacheAt = Date.now();
    return toolsCache;
  }

  async function findToolMeta(agentName) {
    const name = String(agentName || '').trim();
    const cached = (toolsCache?.tools || []).find((t) => t.agentName === name);
    if (cached) return cached;
    const cat = await readCatalog();
    return (cat?.tools || []).find((t) => t.agentName === name) || null;
  }

  async function lookupToolSchema(agentName) {
    const name = String(agentName || '').trim();
    if (!name) {
      return { error: 'agentName 必填', errorCode: 'MISSING_ARG', retryable: false };
    }
    let listed = await listAgentTools({ catalogOnly: true });
    let tool = (listed.tools || []).find((t) => t.agentName === name);
    if (!tool) {
      return {
        error: `未找到 MCP 工具「${name}」；当前只查询缓存目录，请先在 MCP 设置页刷新工具目录，或确认工具名正确`,
        errorCode: 'NOT_FOUND',
        retryable: false,
        suggestedFix: '检查 MCP 设置页中缓存的 agentName；真正调用已缓存 MCP 时会按需连接'
      };
    }
    return {
      ok: true,
      agentName: tool.agentName,
      serverId: tool.serverId,
      toolName: tool.toolName,
      description: tool.description,
      inputSchema: tool.inputSchema
    };
  }

  async function callAgentTool(agentName, args) {
    const schemaMeta = await findToolMeta(agentName);
    if (schemaMeta && schemaMeta.inputSchema) {
      const checked = validateMcpInputArgs(agentName, args, schemaMeta.inputSchema);
      if (!checked.ok) return checked;
    }
    let route = routes.get(agentName) || toolsCache?.routes?.get(agentName);
    if (!route) {
      const cat = await readCatalog();
      const meta = (cat?.tools || []).find((t) => t.agentName === agentName);
      if (meta && meta.serverId) {
        await listAgentTools({ force: true, serverIds: [meta.serverId] });
      }
      route = routes.get(agentName) || toolsCache?.routes?.get(agentName);
    }
    if (!route) throw new Error(`未知 MCP 工具：${agentName}`);
    const session = sessions.get(route.serverId);
    if (!session) throw new Error(`MCP 服务未连接：${route.serverId}`);
    return session.callTool(route.toolName, args);
  }

  async function shutdown() {
    for (const session of sessions.values()) {
      await session.disconnect();
    }
    sessions.clear();
    invalidateToolsCache();
  }

  return {
    listAgentTools,
    lookupToolSchema,
    callAgentTool,
    syncSessions,
    invalidateToolsCache,
    shutdown,
    readCatalog
  };
}

/** 静默关闭 client / transport：stdio 传输可能已 spawn 子进程，即使失败也必须尝试回收 */
async function closeQuietly(client, transport) {
  if (client && typeof client.close === 'function') {
    try {
      await client.close();
    } catch {
      // ignore
    }
  }
  if (transport && typeof transport.close === 'function') {
    try {
      await transport.close();
    } catch {
      // ignore
    }
  }
}

module.exports = {
  createMcpRuntimeManager,
  encodeMcpToolName,
  formatMcpCallResult,
  extractMcpImages,
  serverSignature
};

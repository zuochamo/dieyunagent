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

const CONNECT_TIMEOUT_MS = 60000;
const CALL_TIMEOUT_MS = 120000;
const TOOLS_CACHE_MS = 60000;

function encodeMcpToolName(serverId, toolName) {
  const combined = `${serverId}__${toolName}`;
  let name = `mcp_${combined.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
  if (name.length <= 64) return name;
  const hash = simpleHash(combined);
  const sid = String(serverId)
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .slice(0, 24);
  return `mcp_${sid}_${hash}`.slice(0, 64);
}

function simpleHash(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

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
  const parts = result.content.filter(
    (part) => part && typeof part === 'object' && part.type !== 'text'
  );
  return parts.length ? parts : null;
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
   * @param {{ getWorkspacePath?: () => string, ensureLocalPackage?: (server: object) => Promise<{ server?: object }> }} [opts]
   */
  constructor(server, secrets, opts = {}) {
    this.server = server;
    this.secrets = secrets || { token: '', env: {} };
    this.opts = opts || {};
    this.client = null;
    this.transport = null;
    this.tools = [];
    this.connecting = null;
    this.lastError = null;
    this.signature = serverSignature(server, this.secrets);
    /** 会话代次：disconnect / 重建时自增，用于丢弃「超时后才完成」的过期连接 */
    this.generation = 0;
  }

  async connect() {
    if (this.client) return;
    if (this.connecting) return this.connecting;
    const generation = this.generation;
    this.connecting = withTimeout(
      this._connectInner(generation),
      CONNECT_TIMEOUT_MS,
      `MCP「${this.server.id}」连接`
    );
    try {
      await this.connecting;
    } catch (err) {
      this.lastError = err.message || String(err);
      throw err;
    } finally {
      this.connecting = null;
    }
  }

  /** @param {number} generation */
  async _connectInner(generation) {
    const kind = transportKind(this.server);
    const client = new Client({ name: 'dieyunagent', version: '0.0.1' }, { capabilities: {} });
    let transport;
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
          stderr: 'pipe'
        });
      }
      await client.connect(transport);
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
      if (!err || err.code !== 'MCP_SESSION_STALE') {
        // 握手失败时 stdio 传输可能已经 spawn 了子进程，不关就会在每次重试后累积成僵尸进程
        await closeQuietly(client, transport);
      }
      throw err;
    }
  }

  async disconnect() {
    // 代次自增：让「超时后才完成」的在途连接在回填 client 前被识别为过期并回收
    this.generation += 1;
    await closeQuietly(this.client, this.transport);
    this.client = null;
    this.transport = null;
    this.tools = [];
  }

  async callTool(name, args) {
    await this.connect();
    const result = await withTimeout(
      this.client.callTool({ name, arguments: args || {} }),
      CALL_TIMEOUT_MS,
      `MCP 工具「${name}」`
    );
    return formatMcpCallResult(result);
  }
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
 * @param {{ catalogPath?: string, getServerSecrets?: (id: string) => { token?: string, env?: Record<string, string> }, getWorkspacePath?: () => string, ensureLocalPackage?: (server: object) => Promise<{ server?: object }> }} [opts]
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
            ensureLocalPackage: opts.ensureLocalPackage
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
            ensureLocalPackage: opts.ensureLocalPackage
          })
        );
      }
    }
  }

  async function connectServers(serverIds, { registerRoutes = true, collectTools = true } = {}) {
    const tools = [];
    const errors = [];
    const idSet = serverIds ? new Set(serverIds.map(String)) : null;
    const sessionEntries = [...sessions.entries()].filter(([serverId]) => !idSet || idSet.has(serverId));

    const connectResults = await Promise.allSettled(
      sessionEntries.map(async ([serverId, session]) => {
        await session.connect();
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
      const { tools, errors } = await connectServers(null, { registerRoutes: true, collectTools: true });
      await saveCatalog(tools, errors);
      toolsCache = { tools, errors, routes: new Map(routes) };
      toolsCacheAt = Date.now();
      return toolsCache;
    }

    const { tools, errors } = await connectServers(serverIds, { registerRoutes: true, collectTools: true });
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
  serverSignature
};

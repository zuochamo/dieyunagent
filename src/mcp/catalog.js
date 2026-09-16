'use strict';

const fs = require('fs');
const path = require('path');
const { assertSafeUrl } = require('../gateway/web-fetch');
const { compareSemver } = require('../plugins/version');
const { listBuiltinMcpServers } = require('./registry');

const DEFAULT_REGISTRY_URL = 'https://registry.modelcontextprotocol.io/v0.1/servers';
const SOURCES_FILE = 'mcp-catalog-sources.json';
const CACHE_FILE = 'mcp-catalog-cache.json';
const CACHE_TTL_MS = 60 * 60 * 1000;
const CACHE_VERSION = 3;
/** 与 UI 每页条数对齐：首次约 3 页 */
const UI_PAGE_SIZE = 15;
const INITIAL_UI_PAGES = 3;
const INITIAL_LOAD_LIMIT = UI_PAGE_SIZE * INITIAL_UI_PAGES;
const REGISTRY_PAGE_LIMIT = INITIAL_LOAD_LIMIT;
const LOAD_MORE_REGISTRY_PAGES = 1;
const MAX_INSTALL_SEARCH_PAGES = 30;

function readJsonFile(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJsonFile(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

function simpleHash(text) {
  let h = 2166136261;
  const s = String(text || '');
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

function registryNameToMcpId(name) {
  let s = String(name || '')
    .replace(/\//g, '-')
    .replace(/\./g, '-')
    .replace(/[^a-zA-Z0-9_-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  if (!s || !/^[a-zA-Z]/.test(s)) {
    s = `mcp-${simpleHash(name).slice(0, 56)}`;
  }
  return s;
}

function isOfficialRegistryUrl(url) {
  try {
    const u = new URL(String(url || ''));
    return u.hostname === 'registry.modelcontextprotocol.io';
  } catch {
    return false;
  }
}

function officialMeta(item) {
  const meta = item && item._meta;
  if (!meta || typeof meta !== 'object') return null;
  return meta['io.modelcontextprotocol.registry/official'] || null;
}

function resolveTransportCategory(server) {
  const packages = Array.isArray(server.packages) ? server.packages : [];
  const npm = packages.find((p) => p && p.registryType === 'npm');
  if (npm) return 'npm';
  const pypi = packages.find((p) => p && p.registryType === 'pypi');
  if (pypi) return 'pypi';
  const oci = packages.find((p) => p && (p.registryType === 'oci' || p.registryType === 'docker'));
  if (oci) return 'container';
  const remotes = Array.isArray(server.remotes) ? server.remotes : [];
  if (remotes.length) return 'remote';
  return 'unknown';
}

function extractEnvHint(server) {
  const packages = Array.isArray(server.packages) ? server.packages : [];
  for (const pkg of packages) {
    const vars = Array.isArray(pkg.environmentVariables) ? pkg.environmentVariables : [];
    const req = vars.find((v) => v && v.isRequired);
    if (req && req.name) return String(req.name);
    if (vars[0] && vars[0].name) return String(vars[0].name);
  }
  const remotes = Array.isArray(server.remotes) ? server.remotes : [];
  for (const remote of remotes) {
    const headers = Array.isArray(remote.headers) ? remote.headers : [];
    const req = headers.find((h) => h && h.isRequired && h.name);
    if (req) return String(req.name);
  }
  return '';
}

function normalizeRemoteTransportType(raw) {
  const t = String(raw || '')
    .trim()
    .toLowerCase();
  if (t === 'sse') return 'sse';
  if (t.includes('streamable') || t === 'http' || t === 'streamable-http') return 'streamable-http';
  return 'streamable-http';
}

function resolveRemoteSpec(server) {
  const remotes = Array.isArray(server.remotes) ? server.remotes : [];
  const remote = remotes.find((r) => r && r.url) || remotes[0];
  if (!remote || !remote.url) return null;
  const url = String(remote.url).trim();
  let authHeaderName = 'Authorization';
  let authRequired = false;
  const headers = Array.isArray(remote.headers) ? remote.headers : [];
  for (const h of headers) {
    if (h && h.isRequired && h.name) {
      authHeaderName = String(h.name);
      authRequired = true;
      break;
    }
  }
  if (!authRequired) {
    const named = headers.find((h) => h && h.name);
    if (named && named.name) authHeaderName = String(named.name);
  }
  return {
    remoteUrl: url,
    remoteTransport: normalizeRemoteTransportType(remote.type),
    authHeaderName,
    authRequired
  };
}

function resolveCatalogAddability(ent) {
  if (!ent) return { hasPackage: false, hasRemote: false, canAdd: false, remoteUrl: '' };
  const hasPackage = !!(ent.hasPackage || ent.installSpec);
  const remoteUrl = String(ent.remoteUrl || '').trim();
  const hasRemote = !!(
    ent.hasRemote ||
    remoteUrl ||
    ent.transport === 'remote' ||
    ent.category === 'remote'
  );
  const canAdd = ent.canAdd != null ? !!ent.canAdd : hasPackage || hasRemote;
  return { hasPackage, hasRemote, canAdd, remoteUrl };
}

function resolveNpmInstallSpec(server) {
  const packages = Array.isArray(server.packages) ? server.packages : [];
  const npm = packages.find(
    (p) =>
      p &&
      p.registryType === 'npm' &&
      String(p.identifier || '').trim() &&
      (!p.transport || p.transport.type === 'stdio' || !p.transport.type)
  );
  if (!npm) return null;
  const identifier = String(npm.identifier).trim();
  const version = String(npm.version || server.version || '').trim();
  const arg = version ? `${identifier}@${version}` : identifier;
  return {
    command: 'npx',
    args: ['-y', arg],
    envHint: extractEnvHint(server)
  };
}

function npmBasePackage(spec) {
  const s = String(spec || '').trim();
  if (!s) return '';
  if (s.startsWith('@')) {
    const versionAt = s.lastIndexOf('@');
    const slashAt = s.indexOf('/');
    if (versionAt > slashAt && slashAt > 0) return s.slice(0, versionAt);
    return s;
  }
  const versionAt = s.indexOf('@');
  return versionAt > 0 ? s.slice(0, versionAt) : s;
}

function matchBuiltinByNpmSpec(installSpec) {
  if (!installSpec || !installSpec.args || !installSpec.args[1]) return null;
  const pkg = npmBasePackage(installSpec.args[1]);
  for (const builtin of listBuiltinMcpServers()) {
    const bpkg = (builtin.args || []).find((a) => String(a).startsWith('@'));
    if (!bpkg) continue;
    if (npmBasePackage(bpkg) === pkg) return builtin;
  }
  return null;
}

function normalizeRegistryItem(item, sourceLabel) {
  if (!item || typeof item !== 'object') return null;
  const server = item.server;
  if (!server || typeof server !== 'object') return null;
  const official = officialMeta(item);
  if (official && official.status === 'deprecated') return null;
  if (official && official.isLatest === false) return null;

  const registryName = String(server.name || '').trim();
  if (!registryName) return null;

  const installSpec = resolveNpmInstallSpec(server);
  const remoteSpec = resolveRemoteSpec(server);
  const transport = resolveTransportCategory(server);
  const hasPackage = !!installSpec;
  const hasRemote = !!remoteSpec;
  const canAdd = hasPackage || hasRemote;
  const id = registryName;

  return {
    id,
    registryName,
    name: String(server.title || server.name || registryName).trim(),
    description: String(server.description || '').trim(),
    version: String(server.version || '1.0.0').trim(),
    category: transport,
    homepage: String(server.websiteUrl || server.repository?.url || '').trim(),
    source: sourceLabel || DEFAULT_REGISTRY_URL,
    hasPackage,
    hasRemote,
    canAdd,
    transport,
    envHint: extractEnvHint(server),
    remoteUrl: remoteSpec ? remoteSpec.remoteUrl : '',
    remoteTransport: remoteSpec ? remoteSpec.remoteTransport : '',
    authHeaderName: remoteSpec ? remoteSpec.authHeaderName : 'Authorization',
    authRequired: remoteSpec ? remoteSpec.authRequired : false,
    installSpec,
    raw: item
  };
}

function normalizeCustomCatalogEntry(raw, sourceLabel) {
  if (!raw || typeof raw !== 'object') return null;
  const registryName = String(raw.registryName || raw.id || '').trim();
  const id = registryName || String(raw.id || '').trim();
  if (!id) return null;
  const command = String(raw.command || '').trim();
  const args = Array.isArray(raw.args) ? raw.args.map(String) : [];
  const installSpec = command ? { command, args, envHint: String(raw.envHint || '') } : raw.installSpec || null;
  return {
    id,
    registryName: registryName || id,
    name: String(raw.name || id).trim(),
    description: String(raw.description || '').trim(),
    version: String(raw.version || '1.0.0').trim(),
    category: String(raw.category || (installSpec ? 'custom' : 'unknown')).trim(),
    homepage: String(raw.homepage || '').trim(),
    source: sourceLabel || 'custom',
    hasPackage: !!installSpec,
    hasRemote: !!String(raw.remoteUrl || '').trim(),
    canAdd: !!installSpec || !!String(raw.remoteUrl || '').trim(),
    transport: installSpec ? 'custom' : String(raw.remoteUrl || '').trim() ? 'remote' : 'unknown',
    envHint: String(raw.envHint || '').trim(),
    remoteUrl: String(raw.remoteUrl || '').trim(),
    remoteTransport: String(raw.remoteTransport || 'streamable-http').trim(),
    authHeaderName: String(raw.authHeaderName || 'Authorization').trim(),
    authRequired: !!raw.authRequired,
    installSpec,
    raw
  };
}

function mergeCatalogEntries(entries) {
  const byId = new Map();
  for (const ent of entries) {
    if (!ent || !ent.id) continue;
    const prev = byId.get(ent.id);
    if (!prev || compareSemver(ent.version, prev.version) > 0) {
      byId.set(ent.id, ent);
    }
  }
  return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
}

class McpCatalog {
  /**
   * @param {{ userDataPath: string, log?: Function, listInstalled: () => object[], upsertInstalled: (payload: object) => object[] }} opts
   */
  constructor(opts) {
    this.userDataPath = opts.userDataPath || '';
    this.log = opts.log || (() => {});
    this.listInstalled = opts.listInstalled;
    this.upsertInstalled = opts.upsertInstalled;
    this.sourcesPath = this.userDataPath ? path.join(this.userDataPath, SOURCES_FILE) : '';
    this.cachePath = this.userDataPath ? path.join(this.userDataPath, CACHE_FILE) : '';
    /** @type {{ query: string, entries: object[], sourceState: object } | null} */
    this.searchSession = null;
  }

  getSources() {
    if (!this.sourcesPath) {
      return { urls: [DEFAULT_REGISTRY_URL], defaultUrl: DEFAULT_REGISTRY_URL };
    }
    const raw = readJsonFile(this.sourcesPath, { urls: null });
    const urls =
      Array.isArray(raw.urls) && raw.urls.length
        ? raw.urls.map(String).filter(Boolean)
        : [DEFAULT_REGISTRY_URL];
    return { urls, defaultUrl: DEFAULT_REGISTRY_URL };
  }

  setSources(urls) {
    if (!this.sourcesPath) return { urls: [DEFAULT_REGISTRY_URL] };
    const list = Array.isArray(urls) ? urls.map(String).filter(Boolean) : [];
    const finalUrls = list.length ? list : [DEFAULT_REGISTRY_URL];
    writeJsonFile(this.sourcesPath, { urls: finalUrls, updatedAt: new Date().toISOString() });
    return { urls: finalUrls };
  }

  _readCache() {
    if (!this.cachePath || !fs.existsSync(this.cachePath)) {
      return { entries: [], fetchedAt: 0, sourceState: {} };
    }
    const raw = readJsonFile(this.cachePath, { entries: [], fetchedAt: 0, sourceState: {} });
    if (Number(raw.cacheVersion) !== CACHE_VERSION) {
      return { entries: [], fetchedAt: 0, sourceState: {} };
    }
    return {
      entries: Array.isArray(raw.entries) ? raw.entries : [],
      fetchedAt: Number(raw.fetchedAt) || 0,
      sourceState: raw.sourceState && typeof raw.sourceState === 'object' ? raw.sourceState : {}
    };
  }

  _writeCache(entries, sourceState) {
    if (!this.cachePath) return;
    writeJsonFile(this.cachePath, {
      cacheVersion: CACHE_VERSION,
      fetchedAt: Date.now(),
      entries: entries.slice(),
      sourceState: sourceState || {}
    });
  }

  _defaultSourceState(url) {
    return {
      nextCursor: '',
      complete: !isOfficialRegistryUrl(url),
      isOfficial: isOfficialRegistryUrl(url)
    };
  }

  _hasMoreSources(sourceState) {
    const state = sourceState || {};
    return Object.values(state).some((s) => s && s.isOfficial && !s.complete);
  }

  _getSourceState(sourceState, url) {
    const state = sourceState || {};
    return state[url] ? { ...state[url] } : this._defaultSourceState(url);
  }

  async _fetchRegistryPage(baseUrl, cursor, limit = REGISTRY_PAGE_LIMIT, search = '') {
    assertSafeUrl(baseUrl);
    const u = new URL(baseUrl);
    u.searchParams.set('limit', String(limit));
    u.searchParams.set('version', 'latest');
    if (cursor) u.searchParams.set('cursor', cursor);
    const q = String(search || '').trim();
    if (q) u.searchParams.set('search', q);
    const res = await fetch(u.toString(), {
      headers: { Accept: 'application/json', 'User-Agent': 'DieyunAgent/McpCatalog' },
      signal: AbortSignal.timeout(30000)
    });
    if (!res.ok) throw new Error(`目录请求失败 HTTP ${res.status}`);
    const text = await res.text();
    if (text.length > 8 * 1024 * 1024) throw new Error('目录 JSON 过大');
    const data = JSON.parse(text);
    const servers = Array.isArray(data.servers) ? data.servers : [];
    const nextCursor = data.metadata && data.metadata.nextCursor ? String(data.metadata.nextCursor) : '';
    const entries = servers
      .map((item) => normalizeRegistryItem(item, baseUrl))
      .filter(Boolean);
    return { entries, nextCursor };
  }

  async _fetchOfficialSourcePage(baseUrl, sourceState, pages = 1, search = '') {
    const state = this._getSourceState(sourceState, baseUrl);
    if (state.complete) {
      return { entries: [], sourceState: { ...sourceState, [baseUrl]: state } };
    }
    const merged = [];
    let cursor = state.nextCursor || '';
    let complete = false;
    for (let i = 0; i < pages && !complete; i += 1) {
      const { entries, nextCursor } = await this._fetchRegistryPage(baseUrl, cursor, REGISTRY_PAGE_LIMIT, search);
      merged.push(...entries);
      if (!nextCursor || nextCursor === cursor) {
        complete = true;
        cursor = '';
      } else {
        cursor = nextCursor;
      }
    }
    const nextState = {
      ...sourceState,
      [baseUrl]: {
        isOfficial: true,
        nextCursor: cursor,
        complete
      }
    };
    return { entries: merged, sourceState: nextState };
  }

  async _fetchCustomCatalog(url) {
    assertSafeUrl(url);
    const res = await fetch(url, {
      headers: { Accept: 'application/json', 'User-Agent': 'DieyunAgent/McpCatalog' },
      signal: AbortSignal.timeout(30000)
    });
    if (!res.ok) throw new Error(`目录请求失败 HTTP ${res.status}`);
    const text = await res.text();
    if (text.length > 4 * 1024 * 1024) throw new Error('目录 JSON 过大');
    const data = JSON.parse(text);
    if (Array.isArray(data.servers)) {
      const fromRegistry = data.servers
        .map((item) =>
          item && item.server
            ? normalizeRegistryItem(item, url)
            : normalizeCustomCatalogEntry(item, url)
        )
        .filter(Boolean);
      return mergeCatalogEntries(fromRegistry);
    }
    const list = Array.isArray(data.entries)
      ? data.entries
      : Array.isArray(data.mcps)
        ? data.mcps
        : [];
    return mergeCatalogEntries(
      list.map((item) => normalizeCustomCatalogEntry(item, url)).filter(Boolean)
    );
  }

  async _loadRemoteEntries({ force = false, loadMore = false } = {}) {
    const { urls } = this.getSources();
    if (!urls.length) return { entries: [], hasMore: false };

    let cache = this._readCache();

    if (!force && !loadMore && cache.entries.length) {
      return {
        entries: cache.entries,
        hasMore: this._hasMoreSources(cache.sourceState)
      };
    }

    if (force) {
      cache = { entries: [], fetchedAt: 0, sourceState: {} };
    }

    let entries = cache.entries.slice();
    let sourceState = { ...(cache.sourceState || {}) };

    for (const url of urls) {
      try {
        if (isOfficialRegistryUrl(url)) {
          const st = this._getSourceState(sourceState, url);
          const hasSourceEntries = entries.some((e) => e.source === url);
          if (loadMore) {
            if (st.complete) continue;
            const { entries: batch, sourceState: nextState } = await this._fetchOfficialSourcePage(
              url,
              sourceState,
              LOAD_MORE_REGISTRY_PAGES
            );
            entries.push(...batch);
            sourceState = nextState;
          } else if (force || !hasSourceEntries) {
            const resetState = force
              ? { ...sourceState, [url]: this._defaultSourceState(url) }
              : sourceState;
            const { entries: batch, sourceState: nextState } = await this._fetchOfficialSourcePage(
              url,
              resetState,
              1
            );
            if (force) {
              entries = entries.filter((e) => e.source !== url);
            }
            entries.push(...batch);
            sourceState = nextState;
          }
        } else if (force || !entries.some((e) => e.source === url)) {
          const part = await this._fetchCustomCatalog(url);
          if (force) {
            entries = entries.filter((e) => e.source !== url);
          }
          entries.push(...part);
          sourceState[url] = { isOfficial: false, nextCursor: '', complete: true };
        }
      } catch (e) {
        this.log(`MCP 目录拉取失败 ${url}: ${e.message || e}`);
      }
    }

    entries = mergeCatalogEntries(entries);
    this._writeCache(entries, sourceState);
    return { entries, hasMore: this._hasMoreSources(sourceState) };
  }

  _filterEntriesLocal(entries, query) {
    const q = String(query || '').trim().toLowerCase();
    if (!q) return entries.slice();
    return entries.filter((ent) => {
      const hay = [ent.id, ent.registryName, ent.name, ent.description, ent.category, ent.envHint]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return hay.includes(q);
    });
  }

  async _loadSearchEntries(query, { loadMore = false, force = false } = {}) {
    const q = String(query || '').trim();
    if (!q) {
      this.searchSession = null;
      const browse = await this._loadRemoteEntries({ force: force && !loadMore, loadMore });
      return { ...browse, searchMode: false, searchRemote: false };
    }

    const { urls } = this.getSources();
    const officialUrls = urls.filter(isOfficialRegistryUrl);

    if (!officialUrls.length) {
      const browse = await this._loadRemoteEntries({});
      const filtered = this._filterEntriesLocal(browse.entries, q);
      return {
        entries: filtered,
        hasMore: false,
        searchMode: true,
        searchRemote: false
      };
    }

    if (force || !this.searchSession || this.searchSession.query !== q) {
      this.searchSession = { query: q, entries: [], sourceState: {} };
    }

    if (!loadMore && !force && this.searchSession.entries.length) {
      return {
        entries: this.searchSession.entries,
        hasMore: this._hasMoreSources(this.searchSession.sourceState),
        searchMode: true,
        searchRemote: true
      };
    }

    let entries = loadMore ? this.searchSession.entries.slice() : [];
    let sourceState = loadMore ? { ...(this.searchSession.sourceState || {}) } : {};

    if (force) {
      entries = [];
      sourceState = {};
    }

    for (const url of officialUrls) {
      try {
        const st = this._getSourceState(sourceState, url);
        if (loadMore && st.complete) continue;

        const startState = loadMore
          ? sourceState
          : { ...sourceState, [url]: { isOfficial: true, nextCursor: '', complete: false } };

        const { entries: batch, sourceState: nextState } = await this._fetchOfficialSourcePage(
          url,
          startState,
          loadMore ? LOAD_MORE_REGISTRY_PAGES : 1,
          q
        );
        if (!loadMore) {
          entries = entries.filter((e) => e.source !== url);
        }
        entries.push(...batch);
        sourceState = nextState;
      } catch (e) {
        this.log(`MCP 搜索失败 ${url}: ${e.message || e}`);
      }
    }

    entries = mergeCatalogEntries(entries);
    this.searchSession = { query: q, entries, sourceState };
    return {
      entries,
      hasMore: this._hasMoreSources(sourceState),
      searchMode: true,
      searchRemote: true
    };
  }

  async loadMoreEntries() {
    return this._loadRemoteEntries({ loadMore: true });
  }

  _installedIndex(installed) {
    const byCatalogId = new Map();
    const byId = new Map();
    for (const s of installed || []) {
      byId.set(s.id, s);
      if (s.catalogId) byCatalogId.set(String(s.catalogId), s);
    }
    return { byCatalogId, byId };
  }

  _decorateEntries(merged, installed) {
    const { byCatalogId, byId } = this._installedIndex(installed);
    return merged.map((ent) => {
      const hit =
        byCatalogId.get(ent.registryName) ||
        byCatalogId.get(ent.id) ||
        byId.get(registryNameToMcpId(ent.registryName));
      let installedVersion = hit ? String(hit.registryVersion || hit.version || '1.0.0') : null;
      let installState = 'available';
      if (hit) {
        const cmp = compareSemver(ent.version, installedVersion);
        installState = cmp > 0 ? 'upgrade' : 'installed';
      } else if (ent.installSpec) {
        const builtin = matchBuiltinByNpmSpec(ent.installSpec);
        const builtinHit = builtin ? installed.find((s) => s.id === builtin.id) : null;
        if (builtinHit) {
          installedVersion = String(builtinHit.registryVersion || ent.version || '1.0.0');
          installState = 'installed';
        }
      }
      const add = resolveCatalogAddability(ent);
      return {
        id: ent.id,
        registryName: ent.registryName,
        name: ent.name,
        description: ent.description,
        version: ent.version,
        category: ent.category,
        homepage: ent.homepage,
        source: ent.source,
        envHint: ent.envHint,
        transport: ent.transport,
        remoteUrl: add.remoteUrl || ent.remoteUrl,
        remoteTransport: ent.remoteTransport,
        authHeaderName: ent.authHeaderName,
        authRequired: ent.authRequired,
        hasPackage: add.hasPackage,
        hasRemote: add.hasRemote,
        canAdd: add.canAdd,
        installedVersion,
        installState
      };
    });
  }

  async listEntries({ forceRemote = false, loadMore = false, search = '' } = {}) {
    const installed = this.listInstalled();
    const q = String(search || '').trim();
    const result = q
      ? await this._loadSearchEntries(q, { loadMore, force: forceRemote && !loadMore })
      : await this._loadRemoteEntries({ force: forceRemote && !loadMore, loadMore });
    return {
      entries: this._decorateEntries(result.entries, installed),
      hasMore: result.hasMore,
      loadedCount: result.entries.length,
      searchMode: !!result.searchMode,
      searchRemote: !!result.searchRemote
    };
  }

  async install(catalogId) {
    const id = String(catalogId || '').trim();
    if (!id) throw new Error('MCP 目录 id 必填');

    const cache = this._readCache();
    let entry = (cache.entries || []).find((e) => e.id === id || e.registryName === id);
    if (!entry) {
      const searchHit = await this._loadSearchEntries(id, { force: true });
      entry = (searchHit.entries || []).find((e) => e.id === id || e.registryName === id);
    }
    if (!entry) {
      let attempts = 0;
      while (!entry && attempts < MAX_INSTALL_SEARCH_PAGES) {
        const { entries, hasMore } = await this._loadRemoteEntries({ loadMore: true });
        entry = entries.find((e) => e.id === id || e.registryName === id);
        if (entry || !hasMore) break;
        attempts += 1;
      }
    }
    if (!entry) {
      const err = new Error('目录中未找到该 MCP');
      err.code = 'MCP_CATALOG_NOT_FOUND';
      throw err;
    }
    const add = resolveCatalogAddability(entry);
    if (!add.canAdd) {
      const err = new Error('该 MCP 暂不支持添加（需 npm stdio 包或远程 HTTP/SSE 地址）');
      err.code = 'MCP_CATALOG_NO_PACKAGE';
      throw err;
    }

    const mcpId = registryNameToMcpId(entry.registryName);

    if (add.hasRemote && add.remoteUrl) {
      const payload = {
        id: mcpId,
        name: entry.name,
        description: entry.description,
        transportKind: 'remote',
        remoteUrl: entry.remoteUrl || add.remoteUrl,
        remoteTransport: entry.remoteTransport || 'streamable-http',
        authHeaderName: entry.authHeaderName || 'Authorization',
        authRequired: !!entry.authRequired,
        catalogId: entry.registryName,
        registryVersion: entry.version,
        homepage: entry.homepage || '',
        fromCatalog: true
      };
      return this.upsertInstalled(payload);
    }

    const installSpec = entry.installSpec;
    if (!installSpec) {
      const err = new Error('该 MCP 暂不支持一键安装');
      err.code = 'MCP_CATALOG_NO_PACKAGE';
      throw err;
    }

    const builtin = matchBuiltinByNpmSpec(installSpec);
    const resolvedId = builtin ? builtin.id : mcpId;

    const payload = {
      id: resolvedId,
      name: entry.name,
      description: entry.description,
      command: installSpec.command,
      args: installSpec.args,
      catalogId: entry.registryName,
      registryVersion: entry.version,
      envHint: installSpec.envHint || entry.envHint || '',
      homepage: entry.homepage || '',
      fromCatalog: true,
      restoreBuiltinId: builtin ? builtin.id : ''
    };

    return this.upsertInstalled(payload);
  }
}

module.exports = {
  McpCatalog,
  DEFAULT_REGISTRY_URL,
  registryNameToMcpId
};

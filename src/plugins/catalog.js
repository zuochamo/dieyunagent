'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { assertSafeUrl } = require('../gateway/web-fetch');
const { MANIFEST_FILE } = require('./manifest');
const { compareSemver } = require('./version');

const SOURCES_FILE = 'plugin-catalog-sources.json';
const CACHE_FILE = 'plugin-catalog-cache.json';
const CACHE_TTL_MS = 60 * 60 * 1000;
const MAX_ZIP_BYTES = 25 * 1024 * 1024;

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

function normalizeCatalogEntry(raw, sourceLabel) {
  if (!raw || typeof raw !== 'object') return null;
  const id = String(raw.id || '').trim();
  if (!id) return null;
  return {
    id,
    name: String(raw.name || id).trim(),
    description: String(raw.description || '').trim(),
    version: String(raw.version || '1.0.0').trim(),
    category: String(raw.category || 'general').trim(),
    author: String(raw.author || '').trim(),
    homepage: String(raw.homepage || '').trim(),
    bundledDir: String(raw.bundledDir || '').trim(),
    downloadUrl: String(raw.downloadUrl || '').trim(),
    sha256: String(raw.sha256 || '').trim().toLowerCase(),
    signature: String(raw.signature || '').trim(),
    source: sourceLabel || 'builtin'
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

class PluginCatalog {
  /**
   * @param {{ appRoot: string, userDataPath: string, log?: Function, host: import('./host').PluginHost }} opts
   */
  constructor(opts) {
    this.appRoot = path.resolve(String(opts.appRoot || process.cwd()));
    this.userDataPath = opts.userDataPath || '';
    this.log = opts.log || (() => {});
    this.host = opts.host;
    this.builtinPath = path.join(this.appRoot, 'plugins', 'bundled', 'catalog.json');
    this.sourcesPath = this.userDataPath
      ? path.join(this.userDataPath, SOURCES_FILE)
      : '';
    this.cachePath = this.userDataPath ? path.join(this.userDataPath, CACHE_FILE) : '';
  }

  getSources() {
    if (!this.sourcesPath) return { urls: [] };
    const raw = readJsonFile(this.sourcesPath, { urls: [] });
    const urls = Array.isArray(raw.urls) ? raw.urls.map(String).filter(Boolean) : [];
    return { urls };
  }

  setSources(urls) {
    if (!this.sourcesPath) return { urls: [] };
    const list = Array.isArray(urls) ? urls.map(String).filter(Boolean) : [];
    writeJsonFile(this.sourcesPath, { urls: list, updatedAt: new Date().toISOString() });
    return { urls: list };
  }

  _readBuiltinCatalog() {
    if (!fs.existsSync(this.builtinPath)) return [];
    const raw = readJsonFile(this.builtinPath, { plugins: [] });
    const list = Array.isArray(raw.plugins) ? raw.plugins : [];
    return list
      .map((p) => normalizeCatalogEntry(p, 'builtin'))
      .filter(Boolean);
  }

  _readCache() {
    if (!this.cachePath || !fs.existsSync(this.cachePath)) return { entries: [], fetchedAt: 0 };
    return readJsonFile(this.cachePath, { entries: [], fetchedAt: 0 });
  }

  _writeCache(entries) {
    if (!this.cachePath) return;
    writeJsonFile(this.cachePath, {
      fetchedAt: Date.now(),
      entries: entries.slice()
    });
  }

  async _fetchRemoteCatalog(url) {
    assertSafeUrl(url);
    const res = await fetch(url, {
      headers: { Accept: 'application/json', 'User-Agent': 'DieyunAgent/PluginCatalog' },
      signal: AbortSignal.timeout(20000)
    });
    if (!res.ok) {
      throw new Error(`目录请求失败 HTTP ${res.status}`);
    }
    const text = await res.text();
    if (text.length > 512 * 1024) {
      throw new Error('目录 JSON 过大');
    }
    const data = JSON.parse(text);
    const list = Array.isArray(data.plugins) ? data.plugins : [];
    return list
      .map((p) => normalizeCatalogEntry(p, url))
      .filter(Boolean);
  }

  async _loadRemoteEntries(force) {
    const { urls } = this.getSources();
    if (!urls.length) return [];

    const cache = this._readCache();
    if (!force && cache.fetchedAt && Date.now() - cache.fetchedAt < CACHE_TTL_MS && cache.entries.length) {
      return cache.entries;
    }

    const merged = [];
    for (const url of urls) {
      try {
        const part = await this._fetchRemoteCatalog(url);
        merged.push(...part);
      } catch (e) {
        this.log(`插件目录拉取失败 ${url}: ${e.message || e}`);
      }
    }
    this._writeCache(merged);
    return merged;
  }

  async listEntries({ forceRemote = false, installed = [] } = {}) {
    const installedMap = new Map((installed || []).map((p) => [p.id, p.version || '0.0.0']));
    const merged = mergeCatalogEntries([
      ...this._readBuiltinCatalog(),
      ...(await this._loadRemoteEntries(forceRemote))
    ]);
    return merged.map((ent) => {
      const installedVersion = installedMap.get(ent.id) || null;
      let installState = 'available';
      if (installedVersion) {
        const cmp = compareSemver(ent.version, installedVersion);
        installState = cmp > 0 ? 'upgrade' : cmp === 0 ? 'installed' : 'downgrade';
      }
      const bundledDir = this._resolveBundledDir(ent);
      const canInstall = !!(bundledDir || String(ent.downloadUrl || '').trim());
      return {
        ...ent,
        installedVersion,
        installState,
        hasPackage: !!(ent.bundledDir || ent.downloadUrl),
        canInstall
      };
    });
  }

  _resolveBundledDir(entry) {
    const rel = String(entry.bundledDir || '').trim();
    if (!rel || rel.includes('..')) return null;
    const dir = path.join(this.appRoot, rel);
    if (!fs.existsSync(path.join(dir, MANIFEST_FILE))) return null;
    return dir;
  }

  async _downloadZip(url, expectedSha256) {
    assertSafeUrl(url);
    const res = await fetch(url, {
      headers: { Accept: 'application/zip', 'User-Agent': 'DieyunAgent/PluginCatalog' },
      signal: AbortSignal.timeout(120000)
    });
    if (!res.ok) {
      throw new Error(`下载失败 HTTP ${res.status}`);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_ZIP_BYTES) {
      throw new Error('插件包超过大小限制');
    }
    const hash = crypto.createHash('sha256').update(buf).digest('hex');
    if (expectedSha256 && hash !== expectedSha256.toLowerCase()) {
      throw new Error('插件包 sha256 校验失败');
    }
    const zipPath = path.join(os.tmpdir(), `dieyun-plugin-${Date.now()}.zip`);
    fs.writeFileSync(zipPath, buf);
    return zipPath;
  }

  async install(id, opts = {}) {
    const installed = this.host.listPublic();
    const list = await this.listEntries({ installed });
    const entry = list.find((e) => e.id === String(id || ''));
    if (!entry) {
      const err = new Error('目录中未找到该插件');
      err.code = 'PLUGIN_CATALOG_NOT_FOUND';
      throw err;
    }
    if (!entry.hasPackage) {
      const err = new Error('该插件暂无安装包');
      err.code = 'PLUGIN_CATALOG_NO_PACKAGE';
      throw err;
    }

    const bundledDir = this._resolveBundledDir(entry);
    if (bundledDir) {
      return this.host.installFromPath(bundledDir, opts);
    }
    if (entry.downloadUrl) {
      const zipPath = await this._downloadZip(entry.downloadUrl, entry.sha256);
      try {
        return this.host.installFromZip(zipPath, opts);
      } finally {
        try {
          fs.unlinkSync(zipPath);
        } catch {
          // ignore
        }
      }
    }
    const err = new Error('插件包不可用（开发环境请用文件夹安装）');
    err.code = 'PLUGIN_CATALOG_NO_PACKAGE';
    throw err;
  }
}

module.exports = { PluginCatalog };

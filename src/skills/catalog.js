'use strict';

const fs = require('fs');
const path = require('path');
const { assertSafeUrl } = require('../gateway/web-fetch');
const {
  dieyunSkillsDir,
  ensureAgentHomeDirs,
  sanitizeSkillFolderName
} = require('../agent-home');
const { parseFrontmatter } = require('./skill-frontmatter');

const SKILLS_SH_BASE = 'https://skills.sh';
const CACHE_FILE = 'skill-catalog-cache.json';
const CACHE_TTL_MS = 30 * 60 * 1000;
const CACHE_VERSION = 1;
const UI_PAGE_SIZE = 15;
const INITIAL_UI_PAGES = 3;
const INITIAL_LOAD_LIMIT = UI_PAGE_SIZE * INITIAL_UI_PAGES;
const LOAD_MORE_BATCH = INITIAL_LOAD_LIMIT;
const MAX_SEARCH_LIMIT = 200;
const BROWSE_DEFAULT_QUERY = 'skill';
const MARKET_ID_FILE = '.dieyun-market-id';

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

function parseSkillCatalogId(rawId) {
  const id = String(rawId || '').trim();
  const parts = id.split('/');
  if (parts.length < 3) return null;
  const owner = parts[0];
  const repo = parts[1];
  const skillId = parts.slice(2).join('/');
  if (!owner || !repo || !skillId) return null;
  return { id, owner, repo, skillId, source: `${owner}/${repo}` };
}

function buildDownloadUrl(parsed) {
  const base = `${SKILLS_SH_BASE}/api/download/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repo)}/${encodeURIComponent(parsed.skillId)}`;
  assertSafeUrl(base);
  return base;
}

function buildSearchUrl(query, limit) {
  const url = new URL(`${SKILLS_SH_BASE}/api/search`);
  url.searchParams.set('q', query);
  url.searchParams.set('limit', String(Math.min(Math.max(1, limit), MAX_SEARCH_LIMIT)));
  assertSafeUrl(url.href);
  return url.href;
}

function normalizeSearchItem(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = String(raw.id || '').trim();
  if (!id) return null;
  const parsed = parseSkillCatalogId(id);
  if (!parsed) return null;
  const name = String(raw.name || raw.skillId || parsed.skillId).trim();
  return {
    id,
    name,
    skillId: parsed.skillId,
    source: parsed.source,
    owner: parsed.owner,
    repo: parsed.repo,
    description: '',
    installs: Number(raw.installs) || 0,
    url: `${SKILLS_SH_BASE}/${id}`,
    canAdd: true
  };
}

function mergeCatalogEntries(entries) {
  const byId = new Map();
  for (const ent of entries) {
    if (!ent || !ent.id) continue;
    const prev = byId.get(ent.id);
    if (!prev || (ent.installs || 0) > (prev.installs || 0)) {
      byId.set(ent.id, ent);
    }
  }
  return [...byId.values()].sort((a, b) => (b.installs || 0) - (a.installs || 0));
}

function safeRelativePath(relPath) {
  const normalized = String(relPath || '')
    .replace(/\\/g, '/')
    .replace(/^\/+/, '');
  if (!normalized || normalized.includes('..')) {
    throw new Error(`非法技能文件路径: ${relPath}`);
  }
  return normalized;
}

function listInstalledCatalogIds(skillsDir) {
  const ids = new Set();
  if (!skillsDir || !fs.existsSync(skillsDir)) return ids;
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const marker = path.join(dir, MARKET_ID_FILE);
    if (fs.existsSync(marker)) {
      try {
        const id = String(fs.readFileSync(marker, 'utf8')).trim();
        if (id) ids.add(id);
      } catch {
        // ignore
      }
    }
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      if (ent.name.startsWith('.')) continue;
      walk(path.join(dir, ent.name));
    }
  };
  walk(skillsDir);
  return ids;
}

function writeSkillFiles(targetDir, files) {
  fs.mkdirSync(targetDir, { recursive: true });
  for (const file of files || []) {
    if (!file || !file.path) continue;
    const rel = safeRelativePath(file.path);
    const dest = path.join(targetDir, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, String(file.contents ?? ''), 'utf8');
  }
}

function resolveInstallDir(baseDir, parsed, files) {
  let folderName = sanitizeSkillFolderName(parsed.skillId);
  const skillMd = (files || []).find((f) => safeRelativePath(f.path) === 'SKILL.md');
  if (skillMd && skillMd.contents) {
    try {
      const { meta } = parseFrontmatter(String(skillMd.contents));
      if (meta && meta.name) {
        folderName = sanitizeSkillFolderName(String(meta.name));
      }
    } catch {
      // keep skillId folder
    }
  }
  let finalDir = path.join(baseDir, folderName);
  let n = 1;
  while (fs.existsSync(finalDir)) {
    finalDir = path.join(baseDir, `${folderName}-${n++}`);
  }
  return finalDir;
}

class SkillCatalog {
  /**
   * @param {{ userDataPath: string, log?: Function, listInstalled?: () => Set<string> }} opts
   */
  constructor(opts) {
    this.userDataPath = opts.userDataPath || '';
    this.log = opts.log || (() => {});
    this.listInstalled =
      opts.listInstalled ||
      (() => listInstalledCatalogIds(dieyunSkillsDir()));
    this.cachePath = this.userDataPath ? path.join(this.userDataPath, CACHE_FILE) : '';
    this.browseSession = null;
    this.searchSession = null;
  }

  _readCache() {
    if (!this.cachePath) {
      return { version: CACHE_VERSION, fetchedAt: 0, browse: null, searches: {} };
    }
    const raw = readJsonFile(this.cachePath, {
      version: CACHE_VERSION,
      fetchedAt: 0,
      browse: null,
      searches: {}
    });
    if (raw.version !== CACHE_VERSION) {
      return { version: CACHE_VERSION, fetchedAt: 0, browse: null, searches: {} };
    }
    return raw;
  }

  _writeCache(data) {
    if (!this.cachePath) return;
    writeJsonFile(this.cachePath, { ...data, version: CACHE_VERSION, fetchedAt: Date.now() });
  }

  async _fetchSearch(query, limit) {
    const q = String(query || '').trim();
    if (q.length < 2) {
      throw new Error('搜索关键词至少 2 个字符');
    }
    const url = buildSearchUrl(q, limit);
    const res = await fetch(url, {
      headers: { Accept: 'application/json', 'User-Agent': 'DieyunAgent/SkillCatalog' },
      signal: AbortSignal.timeout(30000)
    });
    if (!res.ok) throw new Error(`skills.sh 搜索失败 HTTP ${res.status}`);
    const data = await res.json();
    const skills = Array.isArray(data.skills) ? data.skills : [];
    return mergeCatalogEntries(skills.map(normalizeSearchItem).filter(Boolean));
  }

  async _loadBrowse({ force = false, loadMore = false } = {}) {
    const query = BROWSE_DEFAULT_QUERY;
    if (!force && !loadMore && this.browseSession && this.browseSession.query === query) {
      return {
        entries: this.browseSession.entries,
        hasMore: this.browseSession.hasMore,
        searchRemote: false
      };
    }

    const cache = this._readCache();
    const cachedBrowse = cache.browse;
    if (!force && !loadMore && cachedBrowse && cachedBrowse.query === query && Date.now() - cache.fetchedAt < CACHE_TTL_MS) {
      this.browseSession = cachedBrowse;
      return {
        entries: cachedBrowse.entries,
        hasMore: cachedBrowse.hasMore,
        searchRemote: false
      };
    }

    const prevLimit = loadMore && this.browseSession ? this.browseSession.limit : 0;
    const limit = loadMore ? Math.min(prevLimit + LOAD_MORE_BATCH, MAX_SEARCH_LIMIT) : INITIAL_LOAD_LIMIT;
    const entries = await this._fetchSearch(query, limit);
    const hasMore = entries.length >= limit && limit < MAX_SEARCH_LIMIT;
    this.browseSession = { query, entries, limit, hasMore };
    this._writeCache({ ...cache, browse: this.browseSession });
    return { entries, hasMore, searchRemote: false };
  }

  async _loadSearchEntries(query, { force = false, loadMore = false } = {}) {
    const q = String(query || '').trim();
    if (!q) {
      return this._loadBrowse({ force: force && !loadMore, loadMore });
    }
    if (q.length < 2) {
      return { entries: [], hasMore: false, searchRemote: true };
    }

    if (!force && !loadMore && this.searchSession && this.searchSession.query === q) {
      return {
        entries: this.searchSession.entries,
        hasMore: this.searchSession.hasMore,
        searchRemote: true
      };
    }

    const cache = this._readCache();
    const cached = cache.searches && cache.searches[q];
    if (!force && !loadMore && cached && Date.now() - cache.fetchedAt < CACHE_TTL_MS) {
      this.searchSession = cached;
      return {
        entries: cached.entries,
        hasMore: cached.hasMore,
        searchRemote: true
      };
    }

    const prevLimit = loadMore && this.searchSession && this.searchSession.query === q ? this.searchSession.limit : 0;
    const limit = loadMore ? Math.min(prevLimit + LOAD_MORE_BATCH, MAX_SEARCH_LIMIT) : INITIAL_LOAD_LIMIT;
    const entries = await this._fetchSearch(q, limit);
    const hasMore = entries.length >= limit && limit < MAX_SEARCH_LIMIT;
    this.searchSession = { query: q, entries, limit, hasMore };
    const searches = { ...(cache.searches || {}), [q]: this.searchSession };
    this._writeCache({ ...cache, searches });
    return { entries, hasMore, searchRemote: true };
  }

  _decorateEntries(entries, installedIds) {
    return (entries || []).map((ent) => {
      const installed = installedIds.has(ent.id);
      return {
        ...ent,
        installState: installed ? 'installed' : 'available',
        canAdd: !installed
      };
    });
  }

  async listEntries({ forceRemote = false, loadMore = false, search = '' } = {}) {
    const installedIds = this.listInstalled();
    const q = String(search || '').trim();
    const result = q
      ? await this._loadSearchEntries(q, { force: forceRemote && !loadMore, loadMore })
      : await this._loadBrowse({ force: forceRemote && !loadMore, loadMore });
    return {
      entries: this._decorateEntries(result.entries, installedIds),
      hasMore: result.hasMore,
      loadedCount: result.entries.length,
      searchRemote: !!result.searchRemote
    };
  }

  async _fetchSkillFiles(catalogId) {
    const parsed = parseSkillCatalogId(catalogId);
    if (!parsed) throw new Error('无效的技能市场 id');

    const url = buildDownloadUrl(parsed);
    const res = await fetch(url, {
      headers: { Accept: 'application/json', 'User-Agent': 'DieyunAgent/SkillCatalog' },
      signal: AbortSignal.timeout(60000)
    });
    if (!res.ok) throw new Error(`下载技能失败 HTTP ${res.status}`);
    const text = await res.text();
    if (text.length > 8 * 1024 * 1024) throw new Error('技能包过大');
    const data = JSON.parse(text);
    const files = Array.isArray(data.files) ? data.files : [];
    if (!files.some((f) => safeRelativePath(f.path) === 'SKILL.md')) {
      throw new Error('技能包缺少 SKILL.md');
    }
    return { parsed, files };
  }

  async preview(catalogId) {
    const { parsed, files } = await this._fetchSkillFiles(catalogId);
    const skillMd = files.find((f) => safeRelativePath(f.path) === 'SKILL.md');
    const raw = String(skillMd?.contents ?? '');
    const { meta, body } = parseFrontmatter(raw);
    const extraFiles = files
      .map((f) => safeRelativePath(f.path))
      .filter((p) => p !== 'SKILL.md')
      .sort((a, b) => a.localeCompare(b));
    const name = meta && meta.name ? String(meta.name) : parsed.skillId;
    const description = meta && meta.description != null ? String(meta.description).trim() : '';
    return {
      id: parsed.id,
      name,
      description,
      content: String(body || '').trim(),
      source: parsed.source,
      skillId: parsed.skillId,
      url: `${SKILLS_SH_BASE}/${parsed.id}`,
      files: extraFiles,
      installState: this.listInstalled().has(parsed.id) ? 'installed' : 'available'
    };
  }

  async install(catalogId, userData, workspacePath) {
    const parsed = parseSkillCatalogId(catalogId);
    if (!parsed) throw new Error('无效的技能市场 id');

    ensureAgentHomeDirs(userData, workspacePath);
    const installedIds = this.listInstalled();
    if (installedIds.has(parsed.id)) {
      return { action: 'installed', catalogId: parsed.id };
    }

    const { files } = await this._fetchSkillFiles(catalogId);

    const baseDir = dieyunSkillsDir();
    const finalDir = resolveInstallDir(baseDir, parsed, files);
    writeSkillFiles(finalDir, files);
    fs.writeFileSync(path.join(finalDir, MARKET_ID_FILE), parsed.id, 'utf8');

    const skillPath = path.join(finalDir, 'SKILL.md');
    let name = parsed.skillId;
    try {
      const raw = fs.readFileSync(skillPath, 'utf8');
      const { meta } = parseFrontmatter(raw);
      if (meta && meta.name) name = String(meta.name);
    } catch {
      // ignore
    }

    return {
      action: 'install',
      catalogId: parsed.id,
      dir: finalDir,
      skillPath,
      name
    };
  }
}

module.exports = {
  SkillCatalog,
  SKILLS_SH_BASE,
  parseSkillCatalogId,
  listInstalledCatalogIds,
  MARKET_ID_FILE
};

'use strict';

const fs = require('fs');
const path = require('path');
const { toOpenAiToolDef, validateManifest, readManifestFile, MANIFEST_FILE } = require('./manifest');
const { loadUserPluginFromDir, copyPluginDir, createConfigStore } = require('./loader');
const { extractPluginZip, cleanupExtractDir } = require('./package');
const { compareSemver, satisfiesMinAppVersion } = require('./version');
const { PluginCatalog } = require('./catalog');

const STATE_FILE = 'plugins.json';

class PluginHost {
  constructor({ userDataPath, log, appVersion, appRoot } = {}) {
    this.userDataPath = userDataPath || '';
    this.log = log || (() => {});
    this.appVersion = String(appVersion || '0.0.0');
    this.appRoot = appRoot || process.cwd();
    this.plugins = [];
    this.enabledMap = {};
    this.removedSet = new Set();
    this.installedMeta = {};
    this.services = new Map();
    this.toolRoutes = new Map();
    this.statePath = this.userDataPath ? path.join(this.userDataPath, STATE_FILE) : '';
    this.pluginsDir = this.userDataPath ? path.join(this.userDataPath, 'plugins') : '';
    this._loadState();
    this.catalog = new PluginCatalog({
      appRoot: this.appRoot,
      userDataPath: this.userDataPath,
      log: this.log,
      host: this
    });
  }

  _loadState() {
    if (!this.statePath) return;
    try {
      const raw = JSON.parse(fs.readFileSync(this.statePath, 'utf8'));
      this.enabledMap = raw && typeof raw.enabled === 'object' ? raw.enabled : {};
      const removed = raw && Array.isArray(raw.removed) ? raw.removed : [];
      this.removedSet = new Set(removed.map(String));
      this.installedMeta =
        raw && typeof raw.installed === 'object' && raw.installed ? raw.installed : {};
    } catch {
      this.enabledMap = {};
      this.removedSet = new Set();
      this.installedMeta = {};
    }
  }

  _saveState() {
    if (!this.statePath) return;
    fs.mkdirSync(path.dirname(this.statePath), { recursive: true });
    fs.writeFileSync(
      this.statePath,
      JSON.stringify(
        {
          version: 2,
          enabled: this.enabledMap,
          removed: [...this.removedSet],
          installed: this.installedMeta
        },
        null,
        2
      ),
      'utf8'
    );
  }

  register(plugin) {
    if (!plugin || !plugin.id) throw new Error('插件缺少 id');
    if (this.plugins.some((p) => p.id === plugin.id)) throw new Error(`插件重复: ${plugin.id}`);
    if (!plugin.source) plugin.source = plugin.builtin === false ? 'user' : 'builtin';
    this.plugins.push(plugin);
  }

  loadUserPlugins() {
    if (!this.pluginsDir || !fs.existsSync(this.pluginsDir)) return;
    const entries = fs.readdirSync(this.pluginsDir, { withFileTypes: true });
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      const installPath = path.join(this.pluginsDir, ent.name);
      const manifestPath = path.join(installPath, MANIFEST_FILE);
      if (!fs.existsSync(manifestPath)) continue;
      try {
        const plugin = loadUserPluginFromDir(installPath, this.log);
        if (this.plugins.some((p) => p.id === plugin.id)) {
          this.log(`跳过重复用户插件: ${plugin.id}`);
          continue;
        }
        this.register(plugin);
        if (!this.installedMeta[plugin.id]) {
          this.installedMeta[plugin.id] = {
            installPath,
            installedAt: new Date().toISOString()
          };
        }
      } catch (e) {
        this.log(`加载用户插件失败 ${ent.name}: ${e.message || e}`);
      }
    }
    this._saveState();
  }

  isEnabled(plugin) {
    if (this.enabledMap[plugin.id] != null) return this.enabledMap[plugin.id] !== false;
    return plugin.defaultEnabled !== false;
  }

  _rebuildToolRoutes() {
    this.toolRoutes = new Map();
    for (const plugin of this.plugins) {
      if (this.removedSet.has(plugin.id)) continue;
      if (!this.isEnabled(plugin)) continue;
      const tools =
        typeof plugin.getTools === 'function' ? plugin.getTools() || [] : plugin.tools || [];
      for (const tool of tools) {
        const def = toOpenAiToolDef(tool, plugin.id);
        const publicName = def.function.name;
        this.toolRoutes.set(publicName, {
          pluginId: plugin.id,
          internalName: def.internalName
        });
      }
    }
  }

  initAll() {
    this.disposeAll();
    for (const plugin of this.plugins) {
      if (this.removedSet.has(plugin.id)) continue;
      if (!this.isEnabled(plugin)) continue;
      if (typeof plugin.init !== 'function') continue;
      try {
        const result = plugin.init({
          userDataPath: this.userDataPath,
          log: this.log
        });
        const services = (result && result.services) || {};
        for (const [key, service] of Object.entries(services)) {
          this.services.set(key, service);
        }
      } catch (e) {
        this.log(`插件初始化失败 ${plugin.id}: ${e.message || e}`);
      }
    }
    this._rebuildToolRoutes();
  }

  getService(key) {
    return this.services.get(key) || null;
  }

  listPublic() {
    return this.plugins
      .filter((plugin) => !this.removedSet.has(plugin.id))
      .map((plugin) => ({
        id: plugin.id,
        name: plugin.name || plugin.id,
        description: plugin.description || '',
        version: plugin.version || '1.0.0',
        category: plugin.category || 'general',
        provides: Array.isArray(plugin.provides) ? plugin.provides.slice() : [],
        enabled: this.isEnabled(plugin),
        builtin: plugin.builtin !== false,
        source: plugin.source || (plugin.builtin === false ? 'user' : 'builtin'),
        installPath: plugin.installPath || null,
        permissions: Array.isArray(plugin.permissions) ? plugin.permissions.slice() : [],
        hasSettings: this._pluginHasSettings(plugin),
        settingsSchema: plugin.settings?.schema || null
      }));
  }

  _pluginHasSettings(plugin) {
    if (plugin.id === 'builtin.database') return true;
    return !!(plugin.settings && plugin.settings.schema);
  }

  _readSettingsSchema(plugin) {
    const schemaFile = plugin.settings?.schema;
    if (!schemaFile) return null;
    const base = plugin.installPath || path.join(this.pluginsDir, plugin.id);
    const schemaPath = path.join(base, schemaFile);
    if (!fs.existsSync(schemaPath)) return null;
    try {
      return JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
    } catch (e) {
      this.log(`读取插件 schema 失败 ${plugin.id}: ${e.message || e}`);
      return null;
    }
  }

  getSettingsSchema(pluginId) {
    const plugin = this.plugins.find((p) => p.id === String(pluginId || ''));
    if (!plugin || this.removedSet.has(plugin.id)) {
      const err = new Error('插件不存在');
      err.code = 'PLUGIN_NOT_FOUND';
      throw err;
    }
    return this._readSettingsSchema(plugin);
  }

  getSettings(pluginId) {
    const plugin = this.plugins.find((p) => p.id === String(pluginId || ''));
    if (!plugin || this.removedSet.has(plugin.id)) {
      const err = new Error('插件不存在');
      err.code = 'PLUGIN_NOT_FOUND';
      throw err;
    }
    const installPath = plugin.installPath || path.join(this.pluginsDir, plugin.id);
    return createConfigStore(installPath).read();
  }

  setSettings(pluginId, data) {
    const plugin = this.plugins.find((p) => p.id === String(pluginId || ''));
    if (!plugin || this.removedSet.has(plugin.id)) {
      const err = new Error('插件不存在');
      err.code = 'PLUGIN_NOT_FOUND';
      throw err;
    }
    const perms = new Set(Array.isArray(plugin.permissions) ? plugin.permissions : []);
    if (!perms.has('storage') && plugin.source === 'user') {
      const err = new Error('插件未声明 storage 权限');
      err.code = 'PLUGIN_PERMISSION_DENIED';
      throw err;
    }
    const installPath = plugin.installPath || path.join(this.pluginsDir, plugin.id);
    const store = createConfigStore(installPath);
    store.write(data && typeof data === 'object' ? data : {});
    return store.read();
  }

  _assertInstallable(manifest, { allowDowngrade = false } = {}) {
    if (manifest.minAppVersion && !satisfiesMinAppVersion(this.appVersion, manifest.minAppVersion)) {
      const err = new Error(`需要应用版本 >= ${manifest.minAppVersion}`);
      err.code = 'PLUGIN_APP_VERSION';
      throw err;
    }
    const existing = this.plugins.find((p) => p.id === manifest.id);
    if (existing && existing.builtin !== false && existing.source !== 'user') {
      const err = new Error(`与内置插件 id 冲突: ${manifest.id}`);
      err.code = 'PLUGIN_ID_CONFLICT';
      throw err;
    }
    if (!existing) {
      return { existing: null, action: 'install' };
    }
    const currentVersion = existing.version || '0.0.0';
    const cmp = compareSemver(manifest.version, currentVersion);
    if (cmp < 0 && !allowDowngrade) {
      const err = new Error(`新版本 ${manifest.version} 低于已安装 ${currentVersion}`);
      err.code = 'PLUGIN_DOWNGRADE';
      err.currentVersion = currentVersion;
      err.incomingVersion = manifest.version;
      throw err;
    }
    return { existing, action: cmp > 0 ? 'upgrade' : 'reinstall' };
  }

  _installFromSourceDir(src, { allowDowngrade = false, cleanupSrc = null } = {}) {
    const manifest = validateManifest(readManifestFile(path.join(src, MANIFEST_FILE)));
    const { action } = this._assertInstallable(manifest, { allowDowngrade });

    const destPath = path.join(this.pluginsDir, manifest.id);
    copyPluginDir(src, destPath);
    this.removedSet.delete(manifest.id);
    const prev = this.installedMeta[manifest.id];
    this.installedMeta[manifest.id] = {
      installPath: destPath,
      installedAt: prev?.installedAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      sourcePath: src,
      lastAction: action
    };
    this._saveState();

    const existingIdx = this.plugins.findIndex((p) => p.id === manifest.id);
    if (existingIdx >= 0) {
      const old = this.plugins[existingIdx];
      if (typeof old.dispose === 'function') {
        try {
          old.dispose();
        } catch {
          // ignore
        }
      }
      this.plugins.splice(existingIdx, 1);
    }
    const plugin = loadUserPluginFromDir(destPath, this.log);
    this.register(plugin);
    this.initAll();
    if (cleanupSrc) cleanupSrc(destPath);
    return { list: this.listPublic(), action, pluginId: manifest.id, version: manifest.version };
  }

  listToolDefinitions() {
    const out = [];
    for (const plugin of this.plugins) {
      if (this.removedSet.has(plugin.id)) continue;
      if (!this.isEnabled(plugin)) continue;
      const tools =
        typeof plugin.getTools === 'function' ? plugin.getTools() || [] : plugin.tools || [];
      for (const tool of tools) {
        const def = toOpenAiToolDef(tool, plugin.id);
        out.push({
          type: 'function',
          function: {
            name: def.function.name,
            description: def.function.description,
            parameters: def.function.parameters
          }
        });
      }
    }
    return out;
  }

  async invokeToolByName(publicName, args) {
    const route = this.toolRoutes.get(String(publicName || ''));
    if (!route) {
      const err = new Error(`未知插件工具: ${publicName}`);
      err.code = 'PLUGIN_TOOL_NOT_FOUND';
      throw err;
    }
    const plugin = this.plugins.find((p) => p.id === route.pluginId);
    if (!plugin || this.removedSet.has(plugin.id) || !this.isEnabled(plugin)) {
      const err = new Error('插件未启用');
      err.code = 'PLUGIN_DISABLED';
      throw err;
    }
    if (typeof plugin.handleTool !== 'function') {
      const err = new Error('插件未实现 handleTool');
      err.code = 'PLUGIN_NO_HANDLER';
      throw err;
    }
    const result = plugin.handleTool(route.internalName, args || {});
    return result && typeof result.then === 'function' ? await result : result;
  }

  installFromPath(sourcePath, opts = {}) {
    const src = path.resolve(String(sourcePath || ''));
    if (!src || !fs.existsSync(src)) {
      const err = new Error('插件目录不存在');
      err.code = 'PLUGIN_PATH_NOT_FOUND';
      throw err;
    }
    return this._installFromSourceDir(src, opts);
  }

  installFromZip(zipPath, opts = {}) {
    const extractDir = extractPluginZip(String(zipPath || ''));
    return this._installFromSourceDir(extractDir, {
      ...opts,
      cleanupSrc: (installPath) => cleanupExtractDir(extractDir, installPath)
    });
  }

  uninstall(id) {
    const pluginId = String(id || '');
    const plugin = this.plugins.find((p) => p.id === pluginId);
    if (!plugin) {
      const err = new Error('插件不存在');
      err.code = 'PLUGIN_NOT_FOUND';
      throw err;
    }
    if (plugin.builtin !== false && plugin.source !== 'user') {
      const err = new Error('内置插件不可卸载，请使用停用');
      err.code = 'PLUGIN_BUILTIN';
      throw err;
    }
    if (typeof plugin.dispose === 'function') {
      plugin.dispose();
    }
    this.plugins = this.plugins.filter((p) => p.id !== pluginId);
    delete this.enabledMap[pluginId];
    delete this.installedMeta[pluginId];
    this.removedSet.delete(pluginId);
    const installPath = plugin.installPath || path.join(this.pluginsDir, pluginId);
    if (installPath && fs.existsSync(installPath)) {
      fs.rmSync(installPath, { recursive: true, force: true });
    }
    this._saveState();
    this.initAll();
    return this.listPublic();
  }

  setEnabled(id, enabled) {
    const plugin = this.plugins.find((p) => p.id === id);
    if (!plugin) {
      const err = new Error('插件不存在');
      err.code = 'PLUGIN_NOT_FOUND';
      throw err;
    }
    this.enabledMap[id] = enabled !== false;
    this._saveState();
    this.initAll();
    return this.listPublic();
  }

  remove(id) {
    const pluginId = String(id || '');
    const plugin = this.plugins.find((p) => p.id === pluginId);
    if (!plugin) {
      const err = new Error('插件不存在');
      err.code = 'PLUGIN_NOT_FOUND';
      throw err;
    }
    if (plugin.source === 'user') {
      return this.uninstall(pluginId);
    }
    if (this.removedSet.has(pluginId)) {
      return this.listPublic();
    }
    this.removedSet.add(pluginId);
    this.enabledMap[pluginId] = false;
    this._saveState();
    this.initAll();
    return this.listPublic();
  }

  disposeAll() {
    for (const plugin of this.plugins) {
      if (typeof plugin.dispose === 'function') {
        try {
          plugin.dispose();
        } catch (e) {
          this.log(`插件停止失败 ${plugin.id}: ${e.message || e}`);
        }
      }
    }
    this.services.clear();
    this.toolRoutes.clear();
  }

  async dispatchHook(hookName, payload) {
    const name = String(hookName || '');
    if (!name) return [];
    const jobs = [];
    for (const plugin of this.plugins) {
      if (this.removedSet.has(plugin.id) || !this.isEnabled(plugin)) continue;
      const fn = typeof plugin.getHook === 'function' ? plugin.getHook(name) : null;
      if (!fn) continue;
      jobs.push(
        Promise.resolve()
          .then(() => fn(payload || {}))
          .catch((e) => {
            this.log(`插件 hook ${name} 失败 ${plugin.id}: ${e.message || e}`);
          })
      );
    }
    return Promise.allSettled(jobs);
  }
}

module.exports = { PluginHost };

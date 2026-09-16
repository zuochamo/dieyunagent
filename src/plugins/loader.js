'use strict';

const fs = require('fs');
const path = require('path');
const { MANIFEST_FILE, readManifestFile, validateManifest } = require('./manifest');
const { createGuardedFetch } = require('./permissions');

function createConfigStore(installPath) {
  const configPath = path.join(installPath, 'config.json');
  return {
    read() {
      try {
        return JSON.parse(fs.readFileSync(configPath, 'utf8'));
      } catch {
        return {};
      }
    },
    write(data) {
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      fs.writeFileSync(configPath, JSON.stringify(data || {}, null, 2), 'utf8');
    },
    path: configPath
  };
}

function loadUserPluginFromDir(installPath, log) {
  const manifestPath = path.join(installPath, MANIFEST_FILE);
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`缺少 ${MANIFEST_FILE}`);
  }
  const manifest = validateManifest(readManifestFile(manifestPath));
  const mainPath = path.join(installPath, manifest.main);
  if (!fs.existsSync(mainPath)) {
    throw new Error(`入口文件不存在: ${manifest.main}`);
  }

  const config = createConfigStore(installPath);
  let activated = null;
  let handleToolFn = null;
  /** @type {Record<string, Function|null>} */
  let hookFns = {};

  const plugin = {
    id: manifest.id,
    name: manifest.name,
    description: manifest.description,
    version: manifest.version,
    category: manifest.category,
    provides: manifest.provides,
    permissions: manifest.permissions,
    tools: manifest.tools.slice(),
    defaultEnabled: manifest.defaultEnabled,
    minAppVersion: manifest.minAppVersion,
    settings: manifest.settings,
    hooks: manifest.hooks,
    builtin: false,
    source: 'user',
    installPath,
    manifest,
    init(ctx) {
      delete require.cache[require.resolve(mainPath)];
      const mod = require(mainPath);
      const activate = mod.activate || mod.default;
      if (typeof activate !== 'function') {
        throw new Error('插件入口须导出 activate()');
      }
      activated = activate({
        userDataPath: ctx.userDataPath,
        installPath,
        log: ctx.log || log,
        readConfig: () => config.read(),
        writeConfig: (data) => config.write(data),
        fetch: createGuardedFetch(manifest.permissions)
      });
      if (!activated || typeof activated !== 'object') {
        throw new Error('activate() 须返回对象');
      }
      if (Array.isArray(activated.tools) && activated.tools.length) {
        plugin.tools = activated.tools.slice();
      }
      if (typeof activated.handleTool === 'function') {
        handleToolFn = activated.handleTool.bind(activated);
      }
      hookFns = {
        onAgentTurnEnd:
          typeof activated.onAgentTurnEnd === 'function'
            ? activated.onAgentTurnEnd.bind(activated)
            : null,
        onPlanRan: typeof activated.onPlanRan === 'function' ? activated.onPlanRan.bind(activated) : null
      };
      if (typeof activated.init === 'function') {
        return activated.init(ctx);
      }
      return { services: activated.services || {} };
    },
    getTools() {
      return Array.isArray(plugin.tools) ? plugin.tools.slice() : [];
    },
    getHook(name) {
      const key = String(name || '');
      return hookFns[key] || null;
    },
    handleTool(name, args) {
      if (!handleToolFn) {
        const err = new Error(`插件未提供 handleTool: ${plugin.id}`);
        err.code = 'PLUGIN_NO_HANDLER';
        throw err;
      }
      return handleToolFn(name, args || {});
    },
    dispose() {
      try {
        if (activated && typeof activated.deactivate === 'function') {
          activated.deactivate();
        }
      } catch (e) {
        log(`插件 deactivate 失败 ${plugin.id}: ${e.message || e}`);
      }
      activated = null;
      handleToolFn = null;
      hookFns = {};
      try {
        delete require.cache[require.resolve(mainPath)];
      } catch {
        // ignore
      }
    }
  };

  return plugin;
}

function copyPluginDir(sourcePath, destPath) {
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  if (fs.existsSync(destPath)) {
    fs.rmSync(destPath, { recursive: true, force: true });
  }
  fs.cpSync(sourcePath, destPath, { recursive: true, force: true });
}

module.exports = {
  loadUserPluginFromDir,
  copyPluginDir,
  createConfigStore,
  MANIFEST_FILE
};

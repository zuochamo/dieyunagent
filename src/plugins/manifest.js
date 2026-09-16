'use strict';

const MANIFEST_FILE = 'dieyun-plugin.json';

function readManifestFile(manifestPath) {
  const fs = require('fs');
  const raw = fs.readFileSync(manifestPath, 'utf8');
  const data = JSON.parse(raw);
  if (!data || typeof data !== 'object') throw new Error('manifest 无效');
  return data;
}

function validateManifest(manifest) {
  const id = String(manifest.id || '').trim();
  if (!id) throw new Error('manifest 缺少 id');
  if (!/^[a-zA-Z][a-zA-Z0-9._-]{1,127}$/.test(id)) {
    throw new Error('插件 id 格式无效（字母开头，仅含字母数字 . _ -）');
  }
  const main = String(manifest.main || 'index.js').trim();
  if (!main || main.includes('..')) throw new Error('manifest main 无效');
  const name = String(manifest.name || id).trim();
  const tools = Array.isArray(manifest.tools) ? manifest.tools : [];
  for (const t of tools) {
    const toolName = String(t.name || '').trim();
    if (!toolName || !/^[a-z][a-z0-9_]{0,63}$/.test(toolName)) {
      throw new Error(`工具名无效: ${toolName || '(空)'}`);
    }
    if (!t.description) throw new Error(`工具 ${toolName} 缺少 description`);
  }
  return {
    id,
    name,
    main,
    description: String(manifest.description || '').trim(),
    version: String(manifest.version || '1.0.0').trim(),
    category: String(manifest.category || 'general').trim(),
    provides: Array.isArray(manifest.provides) ? manifest.provides.map(String) : [],
    permissions: Array.isArray(manifest.permissions) ? manifest.permissions.map(String) : [],
    tools,
    defaultEnabled: manifest.defaultEnabled !== false,
    minAppVersion: String(manifest.minAppVersion || '').trim(),
    settings:
      manifest.settings && typeof manifest.settings === 'object'
        ? {
            schema: String(manifest.settings.schema || '').trim()
          }
        : null,
    hooks: Array.isArray(manifest.hooks) ? manifest.hooks.map(String) : []
  };
}

function publicToolName(pluginId, toolName) {
  if (String(pluginId || '').startsWith('builtin.')) return String(toolName || '');
  const slug = String(pluginId || '')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
  return `plugin_${slug}_${toolName}`;
}

function toOpenAiToolDef(manifestTool, pluginId) {
  const internalName = String(manifestTool.name || '').trim();
  const publicName = publicToolName(pluginId, internalName);
  return {
    type: 'function',
    function: {
      name: publicName,
      description: String(manifestTool.description || ''),
      parameters:
        manifestTool.parameters && typeof manifestTool.parameters === 'object'
          ? manifestTool.parameters
          : { type: 'object', properties: {} }
    },
    pluginId,
    internalName
  };
}

module.exports = {
  MANIFEST_FILE,
  readManifestFile,
  validateManifest,
  publicToolName,
  toOpenAiToolDef
};

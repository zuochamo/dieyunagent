'use strict';

function createPluginsHandlers({ plugins, ctx }) {
  return {
    'plugins.list': () => (plugins ? plugins.listPublic() : []),

    'plugins.list_tools': () => (plugins ? plugins.listToolDefinitions() : []),

    'plugins.tool_call': async ({ name, arguments: toolArgs }) => {
      if (!plugins) {
        const e = new Error('插件宿主未就绪');
        e.code = 'PLUGIN_HOST_UNAVAILABLE';
        throw e;
      }
      return plugins.invokeToolByName(String(name || ''), toolArgs || {});
    },

    'plugins.install_from_path': ({ sourcePath, allowDowngrade }) => {
      if (!plugins) return { list: [], action: 'install' };
      const result = plugins.installFromPath(String(sourcePath || ''), {
        allowDowngrade: allowDowngrade === true
      });
      if (typeof ctx.onPluginsChanged === 'function') ctx.onPluginsChanged();
      return result;
    },

    'plugins.install_from_zip': ({ zipPath, allowDowngrade }) => {
      if (!plugins) return { list: [], action: 'install' };
      const result = plugins.installFromZip(String(zipPath || ''), {
        allowDowngrade: allowDowngrade === true
      });
      if (typeof ctx.onPluginsChanged === 'function') ctx.onPluginsChanged();
      return result;
    },

    'plugins.settings.get': ({ id }) => {
      if (!plugins) return {};
      return plugins.getSettings(String(id || ''));
    },

    'plugins.settings.set': ({ id, settings: pluginSettings }) => {
      if (!plugins) return {};
      return plugins.setSettings(String(id || ''), pluginSettings || {});
    },

    'plugins.settings.schema': ({ id }) => {
      if (!plugins) return null;
      return plugins.getSettingsSchema(String(id || ''));
    },

    'plugins.catalog.list': async ({ refresh }) => {
      if (!plugins || !plugins.catalog) return [];
      const installed = plugins.listPublic();
      return plugins.catalog.listEntries({
        forceRemote: refresh === true,
        installed
      });
    },

    'plugins.catalog.install': async ({ id, allowDowngrade }) => {
      if (!plugins || !plugins.catalog) return { list: [], action: 'install' };
      const result = await plugins.catalog.install(String(id || ''), {
        allowDowngrade: allowDowngrade === true
      });
      if (typeof ctx.onPluginsChanged === 'function') ctx.onPluginsChanged();
      return result;
    },

    'plugins.catalog.sources.get': () => {
      if (!plugins || !plugins.catalog) return { urls: [] };
      return plugins.catalog.getSources();
    },

    'plugins.catalog.sources.set': ({ urls }) => {
      if (!plugins || !plugins.catalog) return { urls: [] };
      return plugins.catalog.setSources(Array.isArray(urls) ? urls : []);
    },

    'plugins.hooks.agent_turn_end': async (payload) => {
      if (!plugins) return { ok: true };
      await plugins.dispatchHook('onAgentTurnEnd', payload || {});
      return { ok: true };
    },

    'plugins.uninstall': ({ id }) => {
      if (!plugins) return [];
      const list = plugins.uninstall(String(id || ''));
      if (typeof ctx.onPluginsChanged === 'function') ctx.onPluginsChanged();
      return list;
    },

    'plugins.set_enabled': ({ id, enabled }) => {
      if (!plugins) return [];
      const list = plugins.setEnabled(String(id || ''), enabled !== false);
      if (typeof ctx.onPluginsChanged === 'function') ctx.onPluginsChanged();
      return list;
    },

    'plugins.remove': ({ id }) => {
      if (!plugins) return [];
      const list = plugins.remove(String(id || ''));
      if (typeof ctx.onPluginsChanged === 'function') ctx.onPluginsChanged();
      return list;
    },
  };
}

module.exports = { createPluginsHandlers };

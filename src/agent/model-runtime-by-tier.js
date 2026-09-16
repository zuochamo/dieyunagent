'use strict';

/**
 * 按 context 档位持久化编码参数（温度、窗口、段预算等）。
 * 工厂默认值来自 model-runtime-presets；用户微调按 tier id 分别保存。
 */
(function initModelRuntimeByTier(global) {
  const STORAGE_KEY = 'diecloud.model.runtimeByTier.v1';
  const EDITING_TIER_KEY = 'diecloud.model.runtimeEditingTier.v1';

  /** @type {Record<string, Record<string, number>>} */
  let runtimeByTier = {};

  function listPresetTierIds() {
    if (typeof global !== 'undefined' && global.MODEL_RUNTIME_PRESETS) {
      return global.MODEL_RUNTIME_PRESETS.map((p) => p.id);
    }
    try {
      return require('./model-runtime-presets').MODEL_RUNTIME_PRESETS.map((p) => p.id);
    } catch {
      return [
        'default',
        'ctx-16k',
        'ctx-32k',
        'ctx-64k',
        'ctx-128k',
        'ctx-200k',
        'ctx-512k',
        'ctx-1m',
        'ctx-2m'
      ];
    }
  }

  function remapTierId(id) {
    if (typeof global.remapLegacyContextTierId === 'function') {
      return global.remapLegacyContextTierId(id);
    }
    try {
      return require('./model-runtime-presets').remapLegacyContextTierId(id);
    } catch {
      const key = String(id || '').trim();
      return key === 'ctx-8k' ? 'ctx-16k' : key;
    }
  }

  function foldTierRecord(raw) {
    if (typeof global.foldLegacyContextTierRecord === 'function') {
      return global.foldLegacyContextTierRecord(raw, isValidTierId);
    }
    try {
      return require('./model-runtime-presets').foldLegacyContextTierRecord(raw, isValidTierId);
    } catch {
      const out = {};
      if (!raw || typeof raw !== 'object') return out;
      for (const [tierId, values] of Object.entries(raw)) {
        if (!values || typeof values !== 'object') continue;
        const mapped = remapTierId(tierId);
        if (!isValidTierId(mapped)) continue;
        if (!out[mapped] || mapped === tierId) out[mapped] = { ...values };
      }
      return out;
    }
  }

  function isValidTierId(id) {
    const key = String(id || '').trim();
    return key && listPresetTierIds().includes(key);
  }

  function resolveStoredTierId(tierId) {
    const mapped = remapTierId(tierId);
    return listPresetTierIds().includes(mapped) ? mapped : 'default';
  }

  function getPresetFactoryValues(tierId) {
    const getter =
      typeof global !== 'undefined' && typeof global.getModelRuntimePresetById === 'function'
        ? global.getModelRuntimePresetById
        : null;
    const preset = getter ? getter(tierId) : null;
    if (preset && preset.values) return { ...preset.values };
    const fallback =
      typeof global !== 'undefined' && global.MODEL_RUNTIME_DEFAULTS
        ? { ...global.MODEL_RUNTIME_DEFAULTS }
        : {};
    return fallback;
  }

  function loadRuntimeByTierFromDisk() {
    try {
      const raw = global.localStorage.getItem(STORAGE_KEY);
      if (!raw) return {};
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') return {};
      return foldTierRecord(parsed);
    } catch {
      return {};
    }
  }

  function saveRuntimeByTierToDisk() {
    try {
      global.localStorage.setItem(STORAGE_KEY, JSON.stringify(runtimeByTier));
    } catch {
      // ignore
    }
  }

  function reloadRuntimeByTier() {
    runtimeByTier = loadRuntimeByTierFromDisk();
    return runtimeByTier;
  }

  reloadRuntimeByTier();

  function getRuntimeOverridesForTier(tierId) {
    const key = resolveStoredTierId(tierId);
    return { ...(runtimeByTier[key] || {}) };
  }

  function getRuntimeValuesForTier(tierId) {
    const key = resolveStoredTierId(tierId);
    return { ...getPresetFactoryValues(key), ...getRuntimeOverridesForTier(key) };
  }

  function setRuntimeValuesForTier(tierId, partial) {
    const key = resolveStoredTierId(tierId);
    const next = { ...(runtimeByTier[key] || {}), ...(partial || {}) };
    const factory = getPresetFactoryValues(key);
    const cleaned = {};
    for (const [k, v] of Object.entries(next)) {
      if (factory[k] === v) {
        continue;
      }
      cleaned[k] = v;
    }
    if (Object.keys(cleaned).length) {
      runtimeByTier[key] = cleaned;
    } else {
      delete runtimeByTier[key];
    }
    saveRuntimeByTierToDisk();
    return getRuntimeValuesForTier(key);
  }

  function resetRuntimeValuesForTier(tierId) {
    const key = resolveStoredTierId(tierId);
    delete runtimeByTier[key];
    saveRuntimeByTierToDisk();
    return getRuntimeValuesForTier(key);
  }

  function getEditingContextTierId() {
    try {
      const raw = global.localStorage.getItem(EDITING_TIER_KEY);
      const id = remapTierId(String(raw || '').trim());
      return listPresetTierIds().includes(id) ? id : 'default';
    } catch {
      return 'default';
    }
  }

  function setEditingContextTierId(tierId) {
    const key = resolveStoredTierId(tierId);
    try {
      global.localStorage.setItem(EDITING_TIER_KEY, key);
    } catch {
      // ignore
    }
    return key;
  }

  /** 首次升级：把旧版全局 settings 里的编码参数迁入 default 档 */
  function migrateGlobalSettingsToDefaultTier(globalSettings) {
    if (!globalSettings || typeof globalSettings !== 'object') return false;
    if (Object.keys(runtimeByTier).length) return false;
    const factory = getPresetFactoryValues('default');
    const keys = [
      'temperature',
      'contextWindow',
      'maxOutputTokens',
      'contextReserveTokens',
      'compactionTriggerRatio',
      'agentToolCallLimit',
      'agentMaxRounds'
    ];
    const overrides = {};
    let changed = false;
    for (const k of keys) {
      const v = globalSettings[k];
      if (v == null || !Number.isFinite(Number(v))) continue;
      const num = Number(v);
      if (factory[k] != null && Math.abs(num - Number(factory[k])) < 0.0001) continue;
      overrides[k] = num;
      changed = true;
    }
    if (changed) {
      runtimeByTier.default = overrides;
      saveRuntimeByTierToDisk();
    }
    return changed;
  }

  function inferContextTierFromModelName(modelId) {
    const name = String(modelId || '').toLowerCase();
    if (!name) return 'default';
    if (/\b2[\s_-]?m\b|\b2000k\b/.test(name)) return 'ctx-2m';
    if (/\b1[\s_-]?m\b|\b1000k\b/.test(name)) return 'ctx-1m';
    if (/\b512k\b/.test(name)) return 'ctx-512k';
    if (/\b200k\b/.test(name)) return 'ctx-200k';
    if (/\b128k\b/.test(name)) return 'ctx-128k';
    if (/\b64k\b/.test(name)) return 'ctx-64k';
    if (/\b32k\b/.test(name)) return 'ctx-32k';
    // 8K 档已删除：16k/8k 名字都落到最小档，8k 模型另由窗口线索兜底（见下）
    if (/\b16k\b|\b8k\b/.test(name)) return 'ctx-16k';
    if (/gemini/.test(name)) return 'ctx-1m';
    if (/gpt-4\.1/.test(name)) return 'ctx-1m';
    if (/minimax/.test(name)) return 'ctx-1m';
    if (/qwen-long/.test(name)) return 'ctx-1m';
    if (/claude/.test(name)) return 'ctx-200k';
    if (/mistral-large/.test(name)) return 'ctx-64k';
    if (/qwen2\.5-32b/.test(name)) return 'ctx-64k';
    if (
      /gpt-4o|gpt-4-turbo|gpt-5|o1|o3|o4-mini|deepseek|qwen2\.5-72b|qwen3/.test(name)
    ) {
      return 'ctx-128k';
    }
    if (/gpt-3\.5|gpt-3\b|llama-2|tiny|mini-8k/.test(name)) return 'ctx-16k';
    return 'default';
  }

  /** 上下文窗口下限（与 model-runtime-schema 的 min 对齐） */
  const CONTEXT_WINDOW_FLOOR = 8192;

  /**
   * 模型名里的「小窗口」线索。8K 档已删除，若名字写明 8k 则按 8192 估算，
   * 避免只落进 16K 档后仍按 16384 申请上下文。
   */
  function inferContextWindowFromModelName(modelId) {
    const name = String(modelId || '').toLowerCase();
    if (!name) return null;
    if (/\b8k\b/.test(name)) return 8192;
    return null;
  }

  /**
   * 模型自带上下文窗口（可选）→ token 数；返回 null 表示沿用所属档位。
   * Renderer（localStorage 设置）与 Main（磁盘 model-settings.json）共用，设置对象同构。
   * 优先级：模型显式窗口 > 显式档位 > 模型名 8k 线索。
   */
  function resolveModelContextWindowFromSettings(settings, modelRouteOrId) {
    const s = settings && typeof settings === 'object' ? settings : {};
    const route = String(modelRouteOrId || '').trim();
    if (!route || route === 'auto') return null;

    const findCustom = (key) =>
      (Array.isArray(s.customModels) ? s.customModels : []).find(
        (m) => m && (String(m.id) === key || String(m.name) === key)
      );
    const fromCustomModel = (model) => {
      if (!model) return null;
      const own = Math.floor(Number(model.contextWindow));
      if (Number.isFinite(own) && own > 0) return Math.max(CONTEXT_WINDOW_FLOOR, own);
      if (model.contextTier) return null;
      return inferContextWindowFromModelName(model.name);
    };

    if (route.startsWith('custom:')) {
      return fromCustomModel(findCustom(route.slice('custom:'.length)));
    }

    const rest = route.startsWith('builtin:') ? route.slice('builtin:'.length) : route;
    const idx = rest.indexOf(':');
    // 裸模型名（Main 侧只拿得到模型名）：仍允许命中自定义模型
    if (idx < 0) return fromCustomModel(findCustom(rest));

    const supplierId = rest.slice(0, idx);
    const modelId = rest.slice(idx + 1);
    const suppliers = Array.isArray(s.modelSuppliers) ? s.modelSuppliers : [];
    const supplier = suppliers.find((row) => row && String(row.id) === supplierId) || null;
    if (supplier?.contextTierByModel?.[modelId]) return null;
    return inferContextWindowFromModelName(modelId);
  }

  function normalizeContextTierId(value, fallback = 'default') {
    const mapped = remapTierId(value);
    return listPresetTierIds().includes(mapped) ? mapped : fallback;
  }

  function resolveContextTierIdFromSettings(settings, modelRouteOrId) {
    const route = String(modelRouteOrId || '').trim();
    if (!route || route === 'auto') return 'default';
    const s = settings && typeof settings === 'object' ? settings : {};

    if (route.startsWith('custom:')) {
      const customId = route.slice('custom:'.length);
      const model = (Array.isArray(s.customModels) ? s.customModels : []).find(
        (m) => m && String(m.id) === customId
      );
      if (model?.contextTier) return normalizeContextTierId(model.contextTier);
      if (model?.name) return normalizeContextTierId(inferContextTierFromModelName(model.name));
      return 'default';
    }

    const idx = route.indexOf(':');
    const supplierId = idx >= 0 ? route.slice(0, idx) : '';
    const modelId = idx >= 0 ? route.slice(idx + 1) : route;
    const suppliers = Array.isArray(s.modelSuppliers) ? s.modelSuppliers : [];
    const supplier = supplierId
      ? suppliers.find((row) => row && String(row.id) === supplierId)
      : suppliers[0] || null;
    const perModel = supplier?.contextTierByModel?.[modelId];
    if (perModel) return normalizeContextTierId(perModel);
    if (supplier?.contextTier) return normalizeContextTierId(supplier.contextTier);
    return normalizeContextTierId(inferContextTierFromModelName(modelId));
  }

  const api = {
    STORAGE_KEY,
    reloadRuntimeByTier,
    getRuntimeValuesForTier,
    getRuntimeOverridesForTier,
    setRuntimeValuesForTier,
    resetRuntimeValuesForTier,
    getEditingContextTierId,
    setEditingContextTierId,
    migrateGlobalSettingsToDefaultTier,
    inferContextTierFromModelName,
    inferContextWindowFromModelName,
    resolveModelContextWindowFromSettings,
    normalizeContextTierId,
    resolveContextTierIdFromSettings,
    isValidContextTierId: isValidTierId
  };

  if (typeof global === 'object' && global) {
    Object.assign(global, api);
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(typeof window !== 'undefined' ? window : globalThis);

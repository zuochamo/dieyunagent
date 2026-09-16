'use strict';

/**
 * 按 context 档位持久化 Agent 护栏 / Harness 等 limits。
 * 工厂默认值来自 agent-limits.js；用户微调按 tier id 分别保存。
 */
(function initAgentLimitsByTier(global) {
  const STORAGE_KEY = 'dieyun.agent.limitsByTier.v1';
  const LEGACY_STORAGE_KEY = 'dieyun.agent-limits.v1';

  /** @type {Record<string, Record<string, number|boolean>>} */
  let limitsByTier = {};

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
    const known = (tid) => listPresetTierIds().includes(tid);
    if (typeof global.foldLegacyContextTierRecord === 'function') {
      return global.foldLegacyContextTierRecord(raw, known);
    }
    try {
      return require('./model-runtime-presets').foldLegacyContextTierRecord(raw, known);
    } catch {
      const out = {};
      if (!raw || typeof raw !== 'object') return out;
      for (const [tierId, values] of Object.entries(raw)) {
        if (!values || typeof values !== 'object') continue;
        const mapped = remapTierId(tierId);
        if (!known(mapped)) continue;
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

  function getDefaults() {
    if (typeof global !== 'undefined' && global.AGENT_LIMITS_DEFAULTS) {
      return { ...global.AGENT_LIMITS_DEFAULTS };
    }
    try {
      return { ...require('./agent-limits').AGENT_LIMITS_DEFAULTS };
    } catch {
      return {};
    }
  }

  function normalizeLimits(raw) {
    if (typeof global !== 'undefined' && typeof global.normalizeAgentLimits === 'function') {
      return global.normalizeAgentLimits(raw || {});
    }
    try {
      return require('./agent-limits').normalizeAgentLimits(raw || {});
    } catch {
      return { ...(raw || {}) };
    }
  }

  function extractOverrides(values) {
    const factory = getDefaults();
    const normalized = normalizeLimits(values);
    const overrides = {};
    for (const [key, value] of Object.entries(normalized)) {
      if (factory[key] === value) continue;
      overrides[key] = value;
    }
    return overrides;
  }

  function loadLimitsByTierFromDisk() {
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

  function saveLimitsByTierToDisk() {
    try {
      global.localStorage.setItem(STORAGE_KEY, JSON.stringify(limitsByTier));
    } catch {
      // ignore
    }
  }

  function migrateLegacyBrowserLimits() {
    if (Object.keys(limitsByTier).length) return false;
    try {
      const raw = global.localStorage.getItem(LEGACY_STORAGE_KEY);
      if (!raw) return false;
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') return false;
      const overrides = extractOverrides(parsed);
      if (!Object.keys(overrides).length) return false;
      limitsByTier.default = overrides;
      saveLimitsByTierToDisk();
      return true;
    } catch {
      return false;
    }
  }

  function reloadLimitsByTier() {
    limitsByTier = loadLimitsByTierFromDisk();
    migrateLegacyBrowserLimits();
    return limitsByTier;
  }

  if (typeof global !== 'undefined' && global.localStorage) {
    reloadLimitsByTier();
  }

  function getLimitsOverridesForTier(tierId) {
    const key = resolveStoredTierId(tierId);
    return { ...(limitsByTier[key] || {}) };
  }

  function getLimitsForTier(tierId) {
    const key = resolveStoredTierId(tierId);
    return normalizeLimits({ ...getLimitsOverridesForTier(key) });
  }

  function setLimitsForTier(tierId, partial) {
    const key = resolveStoredTierId(tierId);
    const next = normalizeLimits({ ...getLimitsOverridesForTier(key), ...(partial || {}) });
    const cleaned = extractOverrides(next);
    if (Object.keys(cleaned).length) {
      limitsByTier[key] = cleaned;
    } else {
      delete limitsByTier[key];
    }
    saveLimitsByTierToDisk();
    return getLimitsForTier(key);
  }

  function resetLimitsForTier(tierId) {
    const key = resolveStoredTierId(tierId);
    delete limitsByTier[key];
    saveLimitsByTierToDisk();
    return getLimitsForTier(key);
  }

  function getAllLimitsByTier() {
    const out = {};
    for (const [tierId, values] of Object.entries(limitsByTier)) {
      if (!isValidTierId(tierId) || !values || typeof values !== 'object') continue;
      out[tierId] = { ...values };
    }
    return out;
  }

  function hydrateLimitsByTier(fromDisk) {
    if (!fromDisk || typeof fromDisk !== 'object') return false;
    const looksByTier = Object.keys(fromDisk).some((k) => listPresetTierIds().includes(remapTierId(k)));
    if (looksByTier) {
      limitsByTier = {};
      const folded = foldTierRecord(fromDisk);
      for (const [tierId, values] of Object.entries(folded)) {
        if (!isValidTierId(tierId) || !values || typeof values !== 'object') continue;
        const cleaned = extractOverrides(values);
        if (Object.keys(cleaned).length) limitsByTier[tierId] = cleaned;
      }
      saveLimitsByTierToDisk();
      return true;
    }
    const overrides = extractOverrides(fromDisk);
    if (!Object.keys(overrides).length) return false;
    limitsByTier.default = overrides;
    saveLimitsByTierToDisk();
    return true;
  }

  function isLimitsByTierShape(raw) {
    if (!raw || typeof raw !== 'object') return false;
    const tierIds = listPresetTierIds();
    return Object.keys(raw).some((k) => tierIds.includes(remapTierId(k)));
  }

  const api = {
    STORAGE_KEY,
    LEGACY_STORAGE_KEY,
    reloadLimitsByTier,
    getLimitsForTier,
    getLimitsOverridesForTier,
    setLimitsForTier,
    resetLimitsForTier,
    getAllLimitsByTier,
    hydrateLimitsByTier,
    isLimitsByTierShape,
    extractLimitOverrides: extractOverrides,
    isValidLimitsTierId: isValidTierId
  };

  if (typeof global === 'object' && global) {
    Object.assign(global, api);
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(typeof window !== 'undefined' ? window : globalThis);

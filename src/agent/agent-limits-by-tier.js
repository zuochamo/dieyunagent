'use strict';

/**
 * 按 context 档位持久化 Agent 护栏 / Harness 等 limits。
 * 工厂默认值来自 agent-limits.js；用户微调按 tier id 分别保存。
 */
// 纯 CJS 依赖：顶层 require 真源，替代原先「全局 → 运行期 require → 硬编码副本」三层兜底。
const {
  MODEL_RUNTIME_PRESETS,
  remapLegacyContextTierId,
  foldLegacyContextTierRecord
} = require('./model-runtime-presets');
const { AGENT_LIMITS_DEFAULTS, normalizeAgentLimits } = require('./agent-limits');

const STORAGE_KEY = 'dieyun.agent.limitsByTier.v1';
const LEGACY_STORAGE_KEY = 'dieyun.agent-limits.v1';

/** @type {Record<string, Record<string, number|boolean>>} */
let limitsByTier = {};

function listPresetTierIds() {
  return MODEL_RUNTIME_PRESETS.map((p) => p.id);
}

function remapTierId(id) {
  return remapLegacyContextTierId(id);
}

function foldTierRecord(raw) {
  return foldLegacyContextTierRecord(raw, (tid) => listPresetTierIds().includes(tid));
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
  return { ...AGENT_LIMITS_DEFAULTS };
}

function normalizeLimits(raw) {
  return normalizeAgentLimits(raw || {});
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
    const raw = globalThis.localStorage.getItem(STORAGE_KEY);
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
    globalThis.localStorage.setItem(STORAGE_KEY, JSON.stringify(limitsByTier));
  } catch {
    // ignore
  }
}

function migrateLegacyBrowserLimits() {
  if (Object.keys(limitsByTier).length) return false;
  try {
    const raw = globalThis.localStorage.getItem(LEGACY_STORAGE_KEY);
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

if (typeof globalThis !== 'undefined' && globalThis.localStorage) {
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

module.exports = api;

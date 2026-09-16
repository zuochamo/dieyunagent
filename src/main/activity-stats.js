'use strict';

const fs = require('fs');
const path = require('path');
const { usageToActivityPatch } = require('../llm-usage-stats');

const ACTIVITY_STATS_FILE = 'activity-stats.json';
const UNKNOWN_MODEL_USAGE_KEY = '未知模型';

function emptyStats(today, month) {
  return {
    keystrokesToday: 0,
    mouseClicksToday: 0,
    tokensToday: 0,
    tokensTotal: 0,
    promptTokensToday: 0,
    completionTokensToday: 0,
    cachedTokensToday: 0,
    cachedTokensTotal: 0,
    cacheHitPromptTokensToday: 0,
    cacheHitPromptTokensMonth: 0,
    promptTokensMonth: 0,
    completionTokensMonth: 0,
    cachedTokensMonth: 0,
    modelUsageToday: {},
    modelUsageMonth: {},
    lastResetDate: today,
    lastResetMonth: month
  };
}

function currentStatsMonthKey(now = new Date()) {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

function normalizeModelUsageKey(model) {
  const text = String(model || '').trim();
  return text ? text.slice(0, 120) : UNKNOWN_MODEL_USAGE_KEY;
}

function normalizeModelUsageMap(value) {
  const out = {};
  if (!value || typeof value !== 'object') return out;
  for (const [rawKey, rawVal] of Object.entries(value)) {
    const n = Math.max(0, Math.floor(Number(rawVal) || 0));
    if (n > 0) out[normalizeModelUsageKey(rawKey)] = (out[normalizeModelUsageKey(rawKey)] || 0) + n;
  }
  return out;
}

function addModelUsage(map, model, tokens) {
  const add = Math.max(0, Math.floor(Number(tokens) || 0));
  if (add <= 0) return false;
  const key = normalizeModelUsageKey(model);
  map[key] = (Number(map[key]) || 0) + add;
  return true;
}

/**
 * @param {{
 *   getUserDataPath: () => string,
 *   log: { info: Function, warn: Function },
 *   onChanged?: () => void
 * }} deps
 */
function createActivityStats(deps) {
  const { getUserDataPath, log, onChanged } = deps;
  let stats = emptyStats(new Date().toDateString(), currentStatsMonthKey());
  let statsSaveTimer = null;

  function activityStatsPath() {
    return path.join(getUserDataPath(), ACTIVITY_STATS_FILE);
  }

  function saveActivityStats() {
    try {
      const file = activityStatsPath();
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(stats, null, 2), 'utf8');
    } catch (e) {
      log.warn('保存活动统计失败:', e.message);
    }
  }

  function scheduleSaveActivityStats() {
    if (statsSaveTimer) clearTimeout(statsSaveTimer);
    statsSaveTimer = setTimeout(() => {
      statsSaveTimer = null;
      saveActivityStats();
    }, 1500);
  }

  function resetDailyStats() {
    const today = new Date().toDateString();
    const month = currentStatsMonthKey();
    let changed = false;
    if (stats.lastResetDate !== today) {
      stats.keystrokesToday = 0;
      stats.mouseClicksToday = 0;
      stats.tokensToday = 0;
      stats.promptTokensToday = 0;
      stats.completionTokensToday = 0;
      stats.cachedTokensToday = 0;
      stats.cacheHitPromptTokensToday = 0;
      stats.modelUsageToday = {};
      stats.lastResetDate = today;
      changed = true;
      log.info('每日统计已重置');
    }
    if (stats.lastResetMonth !== month) {
      stats.promptTokensMonth = 0;
      stats.completionTokensMonth = 0;
      stats.cachedTokensMonth = 0;
      stats.cacheHitPromptTokensMonth = 0;
      stats.modelUsageMonth = {};
      stats.lastResetMonth = month;
      changed = true;
      log.info('每月模型用量统计已重置');
    }
    if (changed) saveActivityStats();
  }

  function loadActivityStats() {
    const today = new Date().toDateString();
    const month = currentStatsMonthKey();
    try {
      const raw = JSON.parse(fs.readFileSync(activityStatsPath(), 'utf8'));
      stats = {
        keystrokesToday: Number(raw.keystrokesToday) || 0,
        mouseClicksToday: Number(raw.mouseClicksToday ?? raw.mouseClicks) || 0,
        tokensToday: Number(raw.tokensToday) || 0,
        tokensTotal: Number(raw.tokensTotal) || Number(raw.tokensToday) || 0,
        promptTokensToday: Number(raw.promptTokensToday) || 0,
        completionTokensToday: Number(raw.completionTokensToday) || 0,
        cachedTokensToday: Number(raw.cachedTokensToday) || 0,
        cachedTokensTotal: Number(raw.cachedTokensTotal) || Number(raw.cachedTokensToday) || 0,
        cacheHitPromptTokensToday: Number(raw.cacheHitPromptTokensToday) || 0,
        cacheHitPromptTokensMonth: Number(raw.cacheHitPromptTokensMonth) || 0,
        promptTokensMonth: Number(raw.promptTokensMonth) || 0,
        completionTokensMonth: Number(raw.completionTokensMonth) || 0,
        cachedTokensMonth: Number(raw.cachedTokensMonth) || 0,
        modelUsageToday: normalizeModelUsageMap(raw.modelUsageToday),
        modelUsageMonth: normalizeModelUsageMap(raw.modelUsageMonth),
        lastResetDate: raw.lastResetDate || today,
        lastResetMonth: raw.lastResetMonth || month
      };
    } catch {
      stats = emptyStats(today, month);
    }
    resetDailyStats();
  }

  function bumpActivityStats(patch) {
    let changed = false;
    if (patch.keystrokesToday) {
      stats.keystrokesToday += patch.keystrokesToday;
      changed = true;
    }
    if (patch.mouseClicksToday) {
      stats.mouseClicksToday += patch.mouseClicksToday;
      changed = true;
    }
    if (patch.tokensToday) {
      stats.tokensToday += patch.tokensToday;
      stats.tokensTotal += patch.tokensToday;
      changed = true;
    }
    if (patch.promptTokensToday) {
      stats.promptTokensToday += patch.promptTokensToday;
      stats.promptTokensMonth += patch.promptTokensToday;
      changed = true;
    }
    if (patch.completionTokensToday) {
      stats.completionTokensToday += patch.completionTokensToday;
      stats.completionTokensMonth += patch.completionTokensToday;
      changed = true;
    }
    if (patch.cacheHitPromptTokensToday) {
      stats.cacheHitPromptTokensToday += patch.cacheHitPromptTokensToday;
      stats.cacheHitPromptTokensMonth += patch.cacheHitPromptTokensToday;
      stats.cachedTokensToday += patch.cachedTokensToday || 0;
      stats.cachedTokensTotal += patch.cachedTokensToday || 0;
      stats.cachedTokensMonth += patch.cachedTokensToday || 0;
      changed = true;
    }
    if (patch.modelUsage && typeof patch.modelUsage === 'object') {
      for (const [model, tokens] of Object.entries(patch.modelUsage)) {
        const n = Math.max(0, Math.floor(Number(tokens) || 0));
        if (n <= 0) continue;
        if (addModelUsage(stats.modelUsageToday, model, n)) changed = true;
        if (addModelUsage(stats.modelUsageMonth, model, n)) changed = true;
      }
    }
    if (changed) {
      scheduleSaveActivityStats();
      if (typeof onChanged === 'function') onChanged();
    }
  }

  function recordLlmUsageFromApi(usage, model) {
    const patch = usageToActivityPatch(usage, model);
    if (!patch) return;
    resetDailyStats();
    bumpActivityStats(patch);
  }

  function dispose() {
    if (statsSaveTimer) {
      clearTimeout(statsSaveTimer);
      statsSaveTimer = null;
    }
    saveActivityStats();
  }

  return {
    loadActivityStats,
    saveActivityStats,
    bumpActivityStats,
    resetDailyStats,
    recordLlmUsageFromApi,
    normalizeModelUsageKey,
    getStats: () => stats,
    dispose
  };
}

module.exports = {
  createActivityStats,
  normalizeModelUsageKey,
  normalizeModelUsageMap,
  currentStatsMonthKey,
  UNKNOWN_MODEL_USAGE_KEY
};

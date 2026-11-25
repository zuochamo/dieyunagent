'use strict';

/**
 * 归纳设置：`userData/knowledge-maintenance.json` —— Main 侧唯一真相源。
 *
 * 为什么单独一个文件：原先它和「信号 / 提示词 / 记忆落库 / 定时器」一起住在
 * `agent/knowledge-maintainer.js`（1600+ 行）里，而设置页（`main/ipc/agent-runtime.js`）
 * 只关心这一小块。搬出来之后「改设置字段」不必翻过整个归纳器。
 *
 * 纯搬移（2026-11-21）：逻辑一行没改，`knowledge-maintainer.js` 继续原样再导出这些名字。
 */

const fs = require('fs');
const path = require('path');

/** 归纳设置落盘文件名（userData 下；与 agents-md-prefs.json 同级） */
const KNOWLEDGE_SETTINGS_FILE = 'knowledge-maintenance.json';

/** 定时档位只允许这三档（设置页 tab 与这里同源） */
const KNOWLEDGE_INTERVAL_CHOICES = Object.freeze([6, 12, 24]);

const KNOWLEDGE_MODES = Object.freeze(['off', 'idle', 'on']);

// ---------------------------------------------------------------------------
// 设置（userData/knowledge-maintenance.json —— Main 侧唯一真相源）
// ---------------------------------------------------------------------------

function defaultKnowledgeSettings() {
  return {
    mode: 'on',
    intervalHours: 6,
    scopes: { recentChat: true, longMemory: true, projectMemory: true, agents: true },
    lastRunAt: 0,
    lastRunOk: null,
    lastRunSummary: ''
  };
}

function normalizeKnowledgeSettings(raw) {
  const base = defaultKnowledgeSettings();
  if (!raw || typeof raw !== 'object') return base;
  if (KNOWLEDGE_MODES.includes(raw.mode)) base.mode = raw.mode;
  const hours = Number(raw.intervalHours);
  if (KNOWLEDGE_INTERVAL_CHOICES.includes(hours)) base.intervalHours = hours;
  if (raw.scopes && typeof raw.scopes === 'object') {
    for (const key of Object.keys(base.scopes)) {
      if (typeof raw.scopes[key] === 'boolean') base.scopes[key] = raw.scopes[key];
    }
  }
  if (Number.isFinite(Number(raw.lastRunAt))) base.lastRunAt = Number(raw.lastRunAt);
  if (raw.lastRunOk === true || raw.lastRunOk === false) base.lastRunOk = raw.lastRunOk;
  if (typeof raw.lastRunSummary === 'string') base.lastRunSummary = raw.lastRunSummary.slice(0, 240);
  return base;
}

function knowledgeSettingsPath(userData) {
  const dir = String(userData || '').trim();
  if (!dir) return '';
  return path.join(dir, KNOWLEDGE_SETTINGS_FILE);
}

function readKnowledgeSettings(userData) {
  const fp = knowledgeSettingsPath(userData);
  if (!fp) return defaultKnowledgeSettings();
  try {
    return normalizeKnowledgeSettings(JSON.parse(fs.readFileSync(fp, 'utf8')));
  } catch {
    return defaultKnowledgeSettings();
  }
}

/**
 * 把 patch 合进当前设置。**非法字段一律忽略、不重置既有值** ——
 * 之前的实现用「默认值 + patch 再 normalize」，patch 里一个拼错的 mode 就会把
 * 用户已存的设置整体打回默认，设置页的偶发写错会直接改坏配置。
 */
function applyKnowledgeSettingsPatch(current, patch) {
  const next = normalizeKnowledgeSettings(current);
  const p = patch && typeof patch === 'object' ? patch : {};
  if (KNOWLEDGE_MODES.includes(p.mode)) next.mode = p.mode;
  const hours = Number(p.intervalHours);
  if (KNOWLEDGE_INTERVAL_CHOICES.includes(hours)) next.intervalHours = hours;
  if (p.scopes && typeof p.scopes === 'object') {
    for (const key of Object.keys(next.scopes)) {
      if (typeof p.scopes[key] === 'boolean') next.scopes[key] = p.scopes[key];
    }
  }
  if (Number.isFinite(Number(p.lastRunAt))) next.lastRunAt = Number(p.lastRunAt);
  if (p.lastRunOk === true || p.lastRunOk === false) next.lastRunOk = p.lastRunOk;
  if (typeof p.lastRunSummary === 'string') next.lastRunSummary = p.lastRunSummary.slice(0, 240);
  return next;
}

function writeKnowledgeSettings(userData, patch) {
  const next = applyKnowledgeSettingsPatch(readKnowledgeSettings(userData), patch);
  const fp = knowledgeSettingsPath(userData);
  if (!fp) return next;
  try {
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  } catch (err) {
    console.warn('[dieyun:memory] knowledge settings write failed:', err && (err.message || err));
  }
  return next;
}

module.exports = {
  KNOWLEDGE_SETTINGS_FILE,
  KNOWLEDGE_INTERVAL_CHOICES,
  KNOWLEDGE_MODES,
  defaultKnowledgeSettings,
  normalizeKnowledgeSettings,
  knowledgeSettingsPath,
  readKnowledgeSettings,
  applyKnowledgeSettingsPatch,
  writeKnowledgeSettings
};

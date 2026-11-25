'use strict';

/**
 * 技能启用状态的**唯一权威存储**（Main 侧，`<userData>/skills-enabled.json`）。
 *
 * 为什么从 Renderer 的 localStorage 搬上来：启用状态决定「这一轮给模型看哪些技能」，
 * 而注入发生在 Main —— 频道（企业微信）、定时计划、headless、peer 来信这几档**没有
 * Renderer 参与**。状态留在浏览器里时，那些轮次只能按「默认启用」猜，用户自建技能
 * （`user:*`）、市场安装技能、工作区技能一律不注入，等于开了技能却没生效。
 *
 * 分工（与 MCP 的 `mcp.json` 同一形态）：
 * - 这里只存**用户显式做过的选择**（`{ [id]: boolean }`），默认启用规则不落盘，
 *   唯一来源是 `skills/taxonomy.js#isDefaultEnabledSkillId`，随扫描结果下发 `defaultEnabled`；
 * - Renderer 只经 IPC `skills:enabled-get` / `skills:set-enabled` 读写这一份，不再自己存。
 *
 * 读取失败一律当空（与 json-file 的语义一致）：状态坏了应当退回「默认启用」，
 * 而不是让整轮 Agent 起不来。
 */

const fs = require('fs');
const path = require('path');
const { readJsonFile, writeJsonFile } = require('../json-file');

const FILE = 'skills-enabled.json';
const VERSION = 1;

/** @param {string} userData */
function skillsEnabledPath(userData) {
  const root = String(userData || '');
  return root ? path.join(root, FILE) : '';
}

/**
 * 用户显式设置过的启用状态（不含默认值）。
 * @param {string} userData
 * @returns {Record<string, boolean>}
 */
function readEnabledMap(userData) {
  const file = skillsEnabledPath(userData);
  if (!file) return {};
  const raw = readJsonFile(file, null);
  const source = raw && typeof raw === 'object' && raw.enabled && typeof raw.enabled === 'object' ? raw.enabled : {};
  /** @type {Record<string, boolean>} */
  const out = {};
  for (const [id, on] of Object.entries(source)) {
    const key = String(id || '').trim();
    if (key) out[key] = !!on;
  }
  return out;
}

/**
 * 存储文件是否存在 —— 只在「把旧版 localStorage 里的选择搬过来一次」时用：
 * 文件不存在＝这台机器还没搬过；存在（哪怕空）=用户已经在这里表过态，不再搬。
 * @param {string} userData
 */
function storeExists(userData) {
  const file = skillsEnabledPath(userData);
  if (!file) return false;
  try {
    fs.accessSync(file);
    return true;
  } catch {
    return false;
  }
}

/**
 * 写一条启用状态，返回写后的完整表。
 * @param {string} userData
 * @param {string} id
 * @param {boolean} enabled
 * @returns {Record<string, boolean>}
 */
function setSkillEnabled(userData, id, enabled) {
  const key = String(id || '').trim();
  if (!key) throw new Error('技能 id 必填');
  const file = skillsEnabledPath(userData);
  if (!file) throw new Error('技能启用状态需要 userData 路径');
  const map = readEnabledMap(userData);
  map[key] = !!enabled;
  writeJsonFile(file, { version: VERSION, enabled: map, updatedAt: Date.now() });
  return map;
}

module.exports = {
  skillsEnabledPath,
  readEnabledMap,
  setSkillEnabled,
  storeExists
};

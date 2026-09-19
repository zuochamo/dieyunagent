'use strict';

const path = require('path');
const { getRotatingLog, DEFAULT_MAX_BYTES } = require('../logs/rotating-file-log');

/**
 * 计划运行日志：`plans-logs/<planId>.md`。
 *
 * 原来这段逻辑在 `runner.js` 与 `plan-agent-runner.js` 里各存了一份（逐字相同），
 * 且双方都没有任何上限——每轮流式正文直接 append，计划跑久了能把磁盘写到任意大小。
 * 现在是唯一实现，并走统一落盘闸门（2MB 上限 + 单份轮转）。
 *
 * @param {string} userData
 * @param {{ id?: string, name?: string }} plan
 * @param {string} text
 * @returns {string} 日志文件路径
 */
function appendPlanLog(userData, plan, text) {
  const dir = path.join(String(userData || ''), 'plans-logs');
  const file = path.join(dir, `${(plan && plan.id) || 'plan'}.md`);
  const header = `\n\n---\n## ${new Date().toLocaleString('zh-CN')} · ${(plan && plan.name) || ''}\n\n`;
  const log = getRotatingLog(file, { maxBytes: DEFAULT_MAX_BYTES });
  if (log) log.write(header + String(text == null ? '' : text));
  return file;
}

module.exports = { appendPlanLog };

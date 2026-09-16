'use strict';

const path = require('path');
const { scanSkills, readSkillContent } = require('../skills/scanner');

const MAX_SKILL_CHARS = 8000;

/**
 * @param {string} userData
 * @param {string|null} workspacePath
 * @param {string[]} skillIds
 */
async function buildTaskSkillsSystem(userData, workspacePath, skillIds) {
  const ids = (skillIds || []).filter(Boolean);
  if (!ids.length) return '';

  const catalog = await scanSkills({ userData, workspacePath: workspacePath || null });
  const byId = new Map((catalog.skills || []).map((s) => [s.id, s]));
  const parts = [];

  for (const id of ids.slice(0, 4)) {
    const meta = byId.get(id);
    const skillPath =
      meta?.skillPath ||
      (String(id).endsWith('SKILL.md') ? id : path.join(String(id).replace(/[/\\]$/, ''), 'SKILL.md'));
    try {
      const data = await readSkillContent(skillPath);
      const body = (data.content || '').slice(0, MAX_SKILL_CHARS);
      parts.push(
        `### 技能：${data.name || meta?.name || id}\n${data.description ? `> ${data.description}\n\n` : ''}${body}`
      );
    } catch {
      // skip
    }
  }
  if (!parts.length) return '';
  return `【定时任务关联技能】\n\n${parts.join('\n\n---\n\n')}`;
}

module.exports = { buildTaskSkillsSystem };

'use strict';

const fs = require('fs');
const path = require('path');
const { dieyunHome, dieyunSkillsDir, globalSkillsDir } = require('./agent-home');

const MARKER = '.migrated-agents-skills-v1.json';

function markerPath() {
  return path.join(dieyunHome(), MARKER);
}

function copyTreeSync(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, ent.name);
    const to = path.join(dest, ent.name);
    if (ent.isDirectory()) {
      if (!fs.existsSync(to)) {
        copyTreeSync(from, to);
      } else if (ent.name !== 'node_modules' && ent.name !== '.git') {
        copyTreeSync(from, to);
      }
    } else if (!fs.existsSync(to)) {
      fs.copyFileSync(from, to);
    }
  }
}

/**
 * 将 ~/.agents/skills 下已有技能复制到 ~/.dieyun/skills（仅复制目标不存在的子目录，不删除源目录）。
 * @returns {{ skipped: boolean, copied: number, names: string[] }}
 */
function migrateAgentsSkillsToDieyun() {
  try {
    if (fs.existsSync(markerPath())) {
      return { skipped: true, copied: 0, names: [] };
    }
  } catch {
    // continue
  }

  const srcRoot = globalSkillsDir();
  const destRoot = dieyunSkillsDir();
  const names = [];
  let copied = 0;

  try {
    fs.mkdirSync(destRoot, { recursive: true });
    if (!fs.existsSync(srcRoot)) {
      fs.writeFileSync(
        markerPath(),
        JSON.stringify({ copied: 0, at: new Date().toISOString(), note: 'no agents dir' }, null, 2),
        'utf8'
      );
      return { skipped: false, copied: 0, names: [] };
    }

    for (const ent of fs.readdirSync(srcRoot, { withFileTypes: true })) {
      if (!ent.isDirectory()) continue;
      if (ent.name === 'node_modules' || ent.name === '.git') continue;
      const srcDir = path.join(srcRoot, ent.name);
      if (!fs.existsSync(path.join(srcDir, 'SKILL.md'))) continue;
      const destDir = path.join(destRoot, ent.name);
      if (fs.existsSync(destDir)) continue;
      copyTreeSync(srcDir, destDir);
      names.push(ent.name);
      copied += 1;
    }

    fs.writeFileSync(
      markerPath(),
      JSON.stringify({ copied, names, at: new Date().toISOString() }, null, 2),
      'utf8'
    );
  } catch {
    return { skipped: false, copied, names };
  }

  return { skipped: false, copied, names };
}

module.exports = { migrateAgentsSkillsToDieyun, markerPath };

'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { dieyunHome, dieyunSkillsDir, userDataSkillsDir, workspaceSkillsDir } = require('../agent-home');

const APPDATA_MIGRATED = '.migrated-appdata-skills-v1.json';

async function pathExists(p) {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * 递归复制：目标已存在则跳过（不覆盖用户修改）。
 */
async function copyTreeIfMissing(src, dest) {
  let copied = 0;
  let skipped = 0;
  const st = await fsp.stat(src);
  if (st.isFile()) {
    if (await pathExists(dest)) {
      skipped += 1;
      return { copied, skipped };
    }
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    await fsp.copyFile(src, dest);
    return { copied: 1, skipped };
  }
  if (!st.isDirectory()) return { copied, skipped };

  if (!(await pathExists(dest))) {
    await fsp.mkdir(dest, { recursive: true });
  }
  const entries = await fsp.readdir(src, { withFileTypes: true });
  for (const ent of entries) {
    if (ent.name === 'node_modules' || ent.name === '.git') continue;
    const sub = await copyTreeIfMissing(path.join(src, ent.name), path.join(dest, ent.name));
    copied += sub.copied;
    skipped += sub.skipped;
  }
  return { copied, skipped };
}

async function migrateAppDataSkills(userData) {
  const src = userDataSkillsDir(userData);
  const marker = path.join(dieyunHome(), APPDATA_MIGRATED);
  if (fs.existsSync(marker)) return { migrated: 0, skipped: true };
  if (!(await pathExists(src))) {
    fs.writeFileSync(marker, JSON.stringify({ at: Date.now(), copied: 0 }), 'utf8');
    return { migrated: 0, skipped: true };
  }
  const destRoot = dieyunSkillsDir();
  fs.mkdirSync(destRoot, { recursive: true });
  let copied = 0;
  const entries = await fsp.readdir(src, { withFileTypes: true });
  for (const ent of entries) {
    if (ent.name === 'README.md') continue;
    const r = await copyTreeIfMissing(path.join(src, ent.name), path.join(destRoot, ent.name));
    copied += r.copied;
  }
  fs.writeFileSync(marker, JSON.stringify({ at: Date.now(), copied }), 'utf8');
  return { migrated: copied };
}

function isUnderDieyunHome(targetPath) {
  if (!targetPath) return false;
  const home = path.resolve(dieyunHome());
  const resolved = path.resolve(String(targetPath));
  return resolved === home || resolved.startsWith(home + path.sep);
}

async function migrateWorkspaceSkills(workspacePath) {
  const src = workspaceSkillsDir(workspacePath);
  if (!src) return { migrated: 0, skipped: true };
  const safeKey = String(workspacePath)
    .replace(/[^a-zA-Z0-9_-]+/g, '_')
    .slice(0, 48);
  const marker = path.join(dieyunHome(), `.migrated-workspace-skills-${safeKey}.json`);
  if (fs.existsSync(marker)) return { migrated: 0, skipped: true };
  const destRoot = dieyunSkillsDir();
  fs.mkdirSync(destRoot, { recursive: true });
  let copied = 0;
  const entries = await fsp.readdir(src, { withFileTypes: true });
  for (const ent of entries) {
    if (ent.name === 'README.md') continue;
    const r = await copyTreeIfMissing(path.join(src, ent.name), path.join(destRoot, ent.name));
    copied += r.copied;
  }
  fs.writeFileSync(marker, JSON.stringify({ at: Date.now(), copied, workspacePath }), 'utf8');
  return { migrated: copied };
}

module.exports = {
  migrateAppDataSkills,
  migrateWorkspaceSkills,
  isUnderDieyunHome
};

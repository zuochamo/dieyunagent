'use strict';

const fs = require('fs/promises');
const path = require('path');
const os = require('os');
const { dieyunSkillsDir, getScanRoots, filterAccessibleSkillRoots } = require('../agent-home');
const {
  parseFrontmatter,
  pickDescriptionZh,
  formatBilingualBlurb
} = require('./skill-frontmatter');
const { zhDescriptionForSkillKey } = require('./bundled-i18n-zh');

/** 预装技能种子顶层目录；其下技能解析为 builtin: 前缀 */
const SEEDED_SKILL_CATEGORIES = new Set(['minimax', 'curated', 'dieyun', 'weather']);

function defaultSkillRoots() {
  const home = os.homedir();
  return [path.join(home, '.dieyun', 'skills')];
}

function enrichMetaDescriptions(meta, skillId) {
  const m = { ...meta };
  if (!pickDescriptionZh(m) && m.skillKey) {
    const zh = zhDescriptionForSkillKey(String(m.skillKey));
    if (zh) m.description_zh = zh;
  }
  if (!pickDescriptionZh(m) && skillId) {
    const zh = zhDescriptionForSkillKey(String(skillId).replace(/^builtin:/, ''));
    if (zh) m.description_zh = zh;
  }
  return m;
}

/**
 * @param {string} dir
 * @param {Set<string>} seen
 * @param {import('fs').Dirent[]} out
 */
function resolveBundledSkillId(dir, meta, bundledRoots) {
  if (meta.skillKey) {
    const key = String(meta.skillKey).trim();
    return key.startsWith('builtin:') ? key : `builtin:${key}`;
  }
  const resolvedDir = path.resolve(dir);
  for (const root of bundledRoots) {
    const resolvedRoot = path.resolve(root);
    if (resolvedDir === resolvedRoot || resolvedDir.startsWith(resolvedRoot + path.sep)) {
      const rel = path.relative(resolvedRoot, resolvedDir).replace(/\\/g, '/');
      if (rel && !rel.startsWith('..')) {
        const parts = rel.split('/').filter(Boolean);
        const top = parts[0];
        if (SEEDED_SKILL_CATEGORIES.has(top)) {
          return `builtin:${parts.join(':')}`;
        }
      }
    }
  }
  return resolvedDir;
}

async function tryAddSkill(dir, seen, out, bundledRoots) {
  const skillMd = path.join(dir, 'SKILL.md');
  try {
    await fs.access(skillMd);
  } catch {
    return false;
  }
  const id = path.resolve(dir);
  if (seen.has(id)) return true;
  seen.add(id);
  const raw = await fs.readFile(skillMd, 'utf8');
  const { meta: rawMeta, body } = parseFrontmatter(raw);
  const skillId = resolveBundledSkillId(dir, rawMeta, bundledRoots);
  const meta = enrichMetaDescriptions(rawMeta, skillId);
  const folderName = path.basename(dir);
  const category =
    (meta.category && String(meta.category).trim()) ||
    (meta.tags && String(meta.tags).split(/[,，]/)[0]?.trim()) ||
    folderName ||
    '其他';
  const blurb = formatBilingualBlurb(meta, body, 220);
  out.push({
    id: skillId,
    dir: id,
    skillPath: skillMd,
    name: meta.name || folderName,
    description: blurb,
    descriptionEn: meta.description || '',
    descriptionZh: pickDescriptionZh(meta),
    preview: blurb,
    category,
    builtin: String(skillId).startsWith('builtin:') || !!meta.skillKey
  });
  return true;
}

/**
 * @param {string} root
 * @param {number} depth
 * @param {Set<string>} seen
 * @param {object[]} out
 */
async function walkRoot(root, depth, seen, out, bundledRoots) {
  if (depth > 5) return;
  let entries;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return;
  }

  if (await tryAddSkill(root, seen, out, bundledRoots)) return;

  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    if (ent.name === 'node_modules' || ent.name === '.git') continue;
    const full = path.join(root, ent.name);
    const isSkill = await tryAddSkill(full, seen, out, bundledRoots);
    if (!isSkill) {
      await walkRoot(full, depth + 1, seen, out, bundledRoots);
    }
  }
}

/** 预装技能种子目录（~/.dieyun/skills 下 minimax/curated 等），用于 builtin: 前缀解析 */
function bundledSkillRoots() {
  return [dieyunSkillsDir()];
}

/**
 * @param {{ userData?: string, workspacePath?: string | null }} [opts]
 */
async function scanSkills(opts = {}) {
  const bundled = bundledSkillRoots();
  let roots;
  if (opts && opts.userData) {
    roots = getScanRoots(opts.userData, opts.workspacePath);
  } else {
    roots = defaultSkillRoots();
  }
  const rootSeen = new Set();
  roots = filterAccessibleSkillRoots(
    roots
      .filter(Boolean)
      .map((r) => path.resolve(r))
      .filter((r) => {
        if (rootSeen.has(r)) return false;
        rootSeen.add(r);
        return true;
      })
  );
  const seen = new Set();
  const out = [];
  for (const root of roots) {
    await walkRoot(root, 0, seen, out, bundled);
  }
  out.sort((a, b) => String(a.name).localeCompare(String(b.name), 'zh-CN'));
  return { roots, skills: out };
}

function assertReadableSkillPath(skillPath, allowedRoots) {
  const resolved = path.resolve(String(skillPath));
  const roots = (allowedRoots || []).map((r) => path.resolve(r)).filter(Boolean);
  if (!roots.length) {
    const e = new Error('无可读技能目录');
    e.code = 'SKILL_PATH_DENIED';
    throw e;
  }
  const underRoot = roots.some(
    (root) => resolved === root || resolved.startsWith(root + path.sep)
  );
  if (!underRoot) {
    const e = new Error('技能路径不在允许目录内');
    e.code = 'SKILL_PATH_DENIED';
    throw e;
  }
  if (path.basename(resolved).toLowerCase() !== 'skill.md') {
    const e = new Error('只能读取 SKILL.md');
    e.code = 'SKILL_PATH_DENIED';
    throw e;
  }
}

async function readSkillContent(skillPath) {
  const raw = await fs.readFile(skillPath, 'utf8');
  const { meta: rawMeta, body } = parseFrontmatter(raw);
  const meta = enrichMetaDescriptions(rawMeta, rawMeta.skillKey || '');
  return {
    name: meta.name || path.basename(path.dirname(skillPath)),
    description: formatBilingualBlurb(meta, body, 0),
    descriptionEn: meta.description || '',
    descriptionZh: pickDescriptionZh(meta),
    content: body,
    meta
  };
}

module.exports = { defaultSkillRoots, scanSkills, readSkillContent, assertReadableSkillPath };

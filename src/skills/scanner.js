'use strict';

const fs = require('fs/promises');
const path = require('path');
const os = require('os');
const {
  seededSkillRoots,
  getScanRoots,
  filterAccessibleSkillRoots,
  isSeededSkillDir,
  evaluateSkillDeletable
} = require('../agent-home');
const {
  parseFrontmatter,
  pickDescriptionZh,
  formatBilingualBlurb
} = require('./skill-frontmatter');
const { zhDescriptionForSkillKey } = require('./bundled-i18n-zh');

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
 * 技能 id 生成（仅供启用/隐藏持久化与召回定位，不代表「是否内置」）。
 * 注意：`builtin:` 前缀被 Renderer 的「用户添加」分类与默认启用规则复用，勿改语义。
 * @param {string} dir
 * @param {object} meta
 * @param {string[]} bundledRoots
 */
function resolveBundledSkillId(dir, meta, bundledRoots) {
  if (meta.skillKey) {
    const key = String(meta.skillKey).trim();
    return key.startsWith('builtin:') ? key : `builtin:${key}`;
  }
  for (const root of bundledRoots) {
    if (isSeededSkillDir(dir, root)) {
      const rel = path.relative(path.resolve(root), path.resolve(dir)).replace(/\\/g, '/');
      return `builtin:${rel.split('/').filter(Boolean).join(':')}`;
    }
  }
  return path.resolve(dir);
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
    // 「内置」= 落在预装种子分类目录内（与可删性同源）。skillKey 只用于 id 与召回，不再是内置判据。
    builtin: bundledRoots.some((root) => isSeededSkillDir(dir, root))
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
  return seededSkillRoots();
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
  // 可删性由扫描根集合统一裁决（Renderer 不再自行推断「是否内置 -> 能否删除」）
  for (const item of out) {
    const verdict = evaluateSkillDeletable(item.dir, roots);
    item.deletable = verdict.deletable;
    item.undeletableReason = verdict.reason;
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

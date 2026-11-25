'use strict';

const fs = require('fs/promises');
const path = require('path');
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
const { verifySkillContent } = require('./install-integrity');
const { resolveSkillDomain, SKILL_DOMAINS, isDefaultEnabledSkillId } = require('./taxonomy');

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
  const integrity = await verifySkillContent(dir, raw);
  const skillId = resolveBundledSkillId(dir, rawMeta, bundledRoots);
  const meta = enrichMetaDescriptions(rawMeta, skillId);
  const folderName = path.basename(dir);
  const category =
    (meta.category && String(meta.category).trim()) ||
    (meta.tags && String(meta.tags).split(/[,，]/)[0]?.trim()) ||
    folderName ||
    '其他';
  const blurb = formatBilingualBlurb(meta, body, 220);
  // 分类是数据：frontmatter 的 `domain:`/`category:` → 预装精确表 → 默认页签。
  // 唯一实现在 skills/taxonomy.js，Renderer 只渲染这个字段（不再自己猜）。
  const domain = resolveSkillDomain({
    skillKey: meta.skillKey,
    id: skillId,
    domain: meta.domain,
    category
  });
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
    domain,
    // 「内置」= 落在预装种子分类目录内（与可删性同源）。skillKey 只用于 id 与召回，不再是内置判据。
    builtin: bundledRoots.some((root) => isSeededSkillDir(dir, root)),
    // 默认启用规则随扫描下发（唯一来源 skills/taxonomy.js#isDefaultEnabledSkillId）：
    // Renderer 与 Main 注入都只读这个字段，不再各自维护一份预装前缀表。
    defaultEnabled: isDefaultEnabledSkillId(skillId),
    // 安装基线比对结果：ok = 与安装时一致；changed = 本地被改过；untracked = 非市场安装（手写/预装）。
    // 只做「可比对」，不做「阻止执行」——见 install-integrity.js 的边界说明。
    integrity: integrity.state,
    installSource: integrity.source
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
  // 扫描根只有一处来源（agent-home 的 getScanRoots）：「~/.dieyun/skills + userData/skills/user
  // + 工作区 .dieyun/skills」。以前缺 userData 时会退回本文件里自拼的 ~/.dieyun/skills，
  // 而所有生产调用点都传 userData，那条分支从来没被执行过。
  let roots = getScanRoots(opts && opts.userData, opts && opts.workspacePath);
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
  return { roots, skills: out, domains: SKILL_DOMAINS };
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

module.exports = { scanSkills, readSkillContent, assertReadableSkillPath };

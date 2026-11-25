'use strict';

/**
 * 技能分类（设置 → 技能 页签）的**唯一来源**。
 *
 * 以前分类是 Renderer 里约 150 个中英关键词 + 9 条正则（`/feishu|excel|xlsx|docx|pdf|…/`）
 * 猜出来的：`perm` 会误伤 `performance-*`，新技能要靠人工往词表里塞词，且同一份判断
 * 在别处还会再写一份。现在分类是**数据**：
 *
 * 1. 技能自己的 `SKILL.md` frontmatter 可以显式写 `domain:`（手写 / 市场技能都能写）；
 * 2. 预装技能用下面这张**精确 id 表**（预装集合是封闭的，就是这 14 个）；
 * 3. 都没有 → 默认 `efficiency`（界面永远能把技能显示出来，不会因为分类失败消失）。
 *
 * Renderer 只渲染 `skill.domain` 与 `domains` 里的标签，自己不再做任何分类判断。
 */

/** 页签：顺序即展示顺序。 */
const SKILL_DOMAINS = Object.freeze([
  { id: 'efficiency', label: '效率工具' },
  { id: 'office', label: '办公协同' },
  { id: 'dev', label: '开发工具' },
  { id: 'content', label: '内容创作' },
  { id: 'business', label: '商业运营' },
  { id: 'edu', label: '教育学习' },
  { id: 'life', label: '生活服务' },
  { id: 'user', label: '用户添加' }
]);

const DEFAULT_SKILL_DOMAIN = 'efficiency';

const DOMAIN_IDS = new Set(SKILL_DOMAINS.map((d) => d.id));

/**
 * 预装技能 → domain。键是 `SKILL.md` 的 `skillKey`（= 技能 id 去掉 `builtin:` 前缀）。
 * 新增预装技能时在这里补一行；**不要再写关键词表**。
 */
const BUNDLED_SKILL_DOMAINS = Object.freeze({
  // 预装精选（curated）
  'curated:baidu-search': 'efficiency',
  'curated:multi-search-engine': 'efficiency',
  'curated:skill-creator': 'efficiency',
  'curated:skill-vetter': 'efficiency',
  'curated:weather-china': 'life',
  // MiniMax 套件
  'minimax:minimax-docx': 'office',
  'minimax:minimax-pdf': 'office',
  'minimax:minimax-xlsx': 'office',
  'minimax:pptx-generator': 'office',
  'minimax:minimax-multimodal-toolkit': 'efficiency',
  'minimax:frontend-dev': 'dev',
  'minimax:fullstack-dev': 'dev',
  'minimax:vision-analysis': 'content',
  // 内置
  weather: 'life'
});

/** 中文标签 → domain id（frontmatter 里写「办公协同」和写 office 等价）。 */
const DOMAIN_LABELS = new Map(SKILL_DOMAINS.map((d) => [d.label, d.id]));

/**
 * 预装技能的**默认启用**规则（唯一来源）。
 *
 * 以前这条规则在三个地方各写一份（Renderer 的 `DEFAULT_ENABLED_SKILL_IDS/PREFIXES`、
 * `system-prompt-prep.js#shouldDefaultEnableSkillId`、`agent-home` 的种子分类表），
 * 加一个预装分类就得改三处，漏一处就是「不可删但永不默认启用」。
 * 现在随扫描结果下发每个技能的 `defaultEnabled`，两侧都只读这个字段。
 *
 * 语义：只影响「用户没表过态」的技能；用户显式关掉的仍然关着（见 `skills/enabled-store.js`）。
 */
const DEFAULT_ENABLED_SKILL_IDS = Object.freeze(['builtin:weather']);
const DEFAULT_ENABLED_SKILL_PREFIXES = Object.freeze(['builtin:minimax:', 'builtin:curated:']);

/**
 * @param {string} id 扫描得到的技能 id（`builtin:<skillKey>` / 用户目录绝对路径）
 * @returns {boolean}
 */
function isDefaultEnabledSkillId(id) {
  const s = String(id || '');
  if (!s) return false;
  if (DEFAULT_ENABLED_SKILL_IDS.includes(s)) return true;
  return DEFAULT_ENABLED_SKILL_PREFIXES.some((prefix) => s.startsWith(prefix));
}

function normalizeDomain(value) {
  const v = String(value || '').trim();
  if (!v) return '';
  const lower = v.toLowerCase();
  if (DOMAIN_IDS.has(lower)) return lower;
  return DOMAIN_LABELS.get(v) || '';
}

/**
 * 技能 → 页签 id。
 *
 * @param {{ skillKey?: string, id?: string, domain?: string, category?: string }} skill
 * @returns {string}
 */
function resolveSkillDomain(skill) {
  const s = skill || {};
  // 1. 技能自己声明的（frontmatter `domain:`，或安装器透传的 category）
  const declared = normalizeDomain(s.domain) || normalizeDomain(s.category);
  if (declared) return declared;
  // 2. 预装集合：精确 id 命中（先 skillKey，再去掉 builtin: 前缀的 id）
  const rawKey = String(s.skillKey || '').trim();
  const idKey = String(s.id || '')
    .trim()
    .replace(/^builtin:/, '');
  for (const key of [rawKey, idKey]) {
    if (key && BUNDLED_SKILL_DOMAINS[key]) return BUNDLED_SKILL_DOMAINS[key];
  }
  // 3. 兜底：用户自己加的技能显示在「用户添加」，其余落默认页签
  if (/^builtin:user:|^user:/.test(String(s.id || '')) || s.category === '用户添加') return 'user';
  return DEFAULT_SKILL_DOMAIN;
}

module.exports = {
  SKILL_DOMAINS,
  DEFAULT_SKILL_DOMAIN,
  BUNDLED_SKILL_DOMAINS,
  DEFAULT_ENABLED_SKILL_IDS,
  DEFAULT_ENABLED_SKILL_PREFIXES,
  isDefaultEnabledSkillId,
  resolveSkillDomain
};

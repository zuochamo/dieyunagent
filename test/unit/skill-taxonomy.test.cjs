'use strict';

/**
 * 技能分类（页签）是**数据**：frontmatter `domain:` → 预装精确 id 表 → 默认页签。
 *
 * 这两条断言锁住的是「没有关键词猜测」这件事本身：
 * - 名里带 `perm` / `weather` 这类曾经被词表命中的词，不再影响分类；
 * - 预装技能按 skillKey 精确命中；
 * - 声明优先（手写 / 市场技能可以自己指定 domain）。
 */

const {
  SKILL_DOMAINS,
  DEFAULT_SKILL_DOMAIN,
  isDefaultEnabledSkillId,
  resolveSkillDomain
} = require('../../src/skills/taxonomy');

describe('技能分类单一来源（skills/taxonomy）', () => {
  it('页签 id 唯一且都在 SKILL_DOMAINS 里', () => {
    const ids = SKILL_DOMAINS.map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const d of SKILL_DOMAINS) expect(d.label).toBeTruthy();
    expect(ids).toContain(DEFAULT_SKILL_DOMAIN);
  });

  it('预装技能按 skillKey 精确命中（不做子串猜测）', () => {
    expect(resolveSkillDomain({ skillKey: 'curated:weather-china' })).toBe('life');
    expect(resolveSkillDomain({ skillKey: 'minimax:minimax-docx' })).toBe('office');
    expect(resolveSkillDomain({ skillKey: 'minimax:frontend-dev' })).toBe('dev');
    expect(resolveSkillDomain({ skillKey: 'weather' })).toBe('life');
    // 名字里带 weather 但不在预装表里：不再被词表归类
    expect(resolveSkillDomain({ name: 'weather-helper', id: '/tmp/weather-helper' })).toBe(
      DEFAULT_SKILL_DOMAIN
    );
    // 曾经被 /perm/ 命中的名字同理
    expect(resolveSkillDomain({ name: 'performance-audit', id: '/tmp/performance-audit' })).toBe(
      DEFAULT_SKILL_DOMAIN
    );
  });

  it('技能自己声明的 domain / category 优先（含中文标签与大小写）', () => {
    expect(resolveSkillDomain({ domain: 'office', name: 'weather-x' })).toBe('office');
    expect(resolveSkillDomain({ domain: 'OFFICE' })).toBe('office');
    expect(resolveSkillDomain({ domain: '办公协同' })).toBe('office');
    expect(resolveSkillDomain({ domain: '不存在的分类' })).toBe(DEFAULT_SKILL_DOMAIN);
    // 创建用户技能时 agent-home 写的 category
    expect(resolveSkillDomain({ category: '用户添加', id: '/tmp/x' })).toBe('user');
    // 预装技能 frontmatter 的 category 是来源标签，不是页签：继续按 skillKey 走
    expect(resolveSkillDomain({ skillKey: 'minimax:pptx-generator', category: 'MiniMax' })).toBe(
      'office'
    );
  });
});

/**
 * 默认启用规则也活在这里（同一份「预装/分类」知识的唯一来源）。
 * 以前它在 Renderer、`system-prompt-prep.js`、`agent-home` 各写一份，加一个预装分类要改三处。
 */
describe('预装技能默认启用（skills/taxonomy）', () => {
  it('预装种子默认启用', () => {
    expect(isDefaultEnabledSkillId('builtin:weather')).toBe(true);
    expect(isDefaultEnabledSkillId('builtin:minimax:minimax-docx')).toBe(true);
    expect(isDefaultEnabledSkillId('builtin:curated:skill-creator')).toBe(true);
  });

  it('用户自建 / 市场安装 / 非种子分类默认不启用', () => {
    expect(isDefaultEnabledSkillId('user:my-skill')).toBe(false);
    expect(isDefaultEnabledSkillId('/home/me/.dieyun/skills/my-skill')).toBe(false);
    expect(isDefaultEnabledSkillId('builtin:dieyun:whatever')).toBe(false);
    expect(isDefaultEnabledSkillId('')).toBe(false);
    expect(isDefaultEnabledSkillId(null)).toBe(false);
  });
});

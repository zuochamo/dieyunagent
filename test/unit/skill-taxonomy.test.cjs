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

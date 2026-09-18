'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  dieyunSkillsDir,
  evaluateSkillDeletable,
  isSeededSkillDir,
  SEEDED_SKILL_CATEGORIES
} = require('../../src/agent-home');
const { scanSkills } = require('../../src/skills/scanner');

const SKILLS_ROOT = path.resolve(dieyunSkillsDir());
const USERDATA_ROOT = path.resolve(path.join(os.tmpdir(), 'dieyun-ud', 'skills', 'user'));
const WORKSPACE_ROOT = path.resolve(path.join(os.tmpdir(), 'dieyun-ws', '.dieyun', 'skills'));

describe('技能可删性判定（单一来源）', () => {
  const roots = [SKILLS_ROOT, USERDATA_ROOT, WORKSPACE_ROOT];

  it('~/.dieyun/skills 下的普通技能可删除', () => {
    const verdict = evaluateSkillDeletable(path.join(SKILLS_ROOT, 'my-skill'), roots);
    expect(verdict.deletable).toBe(true);
    expect(verdict.reason).toBe('');
  });

  it('userData / 工作空间扫描根下的技能同样可删除（作用域与扫描范围对齐）', () => {
    expect(evaluateSkillDeletable(path.join(USERDATA_ROOT, 'a-skill'), roots).deletable).toBe(true);
    expect(evaluateSkillDeletable(path.join(WORKSPACE_ROOT, 'b-skill'), roots).deletable).toBe(true);
  });

  it('种子根下的种子分类目录（minimax/curated/dieyun/weather）不可删除', () => {
    for (const category of SEEDED_SKILL_CATEGORIES) {
      const verdict = evaluateSkillDeletable(path.join(SKILLS_ROOT, category, 'pack', 'skill'), roots);
      expect(verdict.deletable).toBe(false);
      expect(verdict.reason).toBe('SEEDED');
    }
  });

  it('非种子根下的同名分类目录属于用户自己的技能，可删除', () => {
    const verdict = evaluateSkillDeletable(path.join(USERDATA_ROOT, 'minimax', 'skill'), roots);
    expect(verdict.deletable).toBe(true);
    expect(verdict.reason).toBe('');
  });

  it('技能根目录本身不可删除', () => {
    expect(evaluateSkillDeletable(SKILLS_ROOT, roots).reason).toBe('ROOT_DIR');
    expect(evaluateSkillDeletable(USERDATA_ROOT, roots).reason).toBe('ROOT_DIR');
  });

  it('扫描根之外的路径不可删除', () => {
    expect(evaluateSkillDeletable(path.resolve(os.tmpdir(), 'outside', 'skill'), roots).reason).toBe(
      'OUTSIDE_ROOTS'
    );
    expect(evaluateSkillDeletable('', roots).reason).toBe('INVALID_DIR');
  });

  it('命中多个根时取最长匹配（嵌套根不误判）', () => {
    const nested = path.join(SKILLS_ROOT, 'nested');
    const verdict = evaluateSkillDeletable(path.join(nested, 'skill'), [SKILLS_ROOT, nested]);
    expect(verdict.root).toBe(nested);
    expect(verdict.deletable).toBe(true);
  });

  it('isSeededSkillDir 只认 root 下的顶层种子分类', () => {
    expect(isSeededSkillDir(path.join(SKILLS_ROOT, 'minimax', 'x'), SKILLS_ROOT)).toBe(true);
    expect(isSeededSkillDir(path.join(SKILLS_ROOT, 'my-skill'), SKILLS_ROOT)).toBe(false);
    expect(isSeededSkillDir(path.join(SKILLS_ROOT, 'my-skill', 'minimax'), SKILLS_ROOT)).toBe(false);
    expect(isSeededSkillDir(SKILLS_ROOT, SKILLS_ROOT)).toBe(false);
  });
});

describe('scanSkills 下发 builtin / deletable', () => {
  let tmpRoot;
  let userData;
  let createdName;
  let sameNameSkill;

  beforeAll(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dieyun-skills-'));
    userData = path.join(tmpRoot, 'userData');
    createdName = `My Created Skill ${path.basename(tmpRoot)}`;
    sameNameSkill = `User Minimax Skill ${path.basename(tmpRoot)}`;

    // 模拟 UI「添加技能」：createUserSkill 会写入 skillKey: user:<folder>
    const createdDir = path.join(userData, 'skills', 'user', 'my-created-skill');
    fs.mkdirSync(createdDir, { recursive: true });
    fs.writeFileSync(
      path.join(createdDir, 'SKILL.md'),
      `---\nname: ${createdName}\ndescription: made by ui\ncategory: 用户添加\nskillKey: user:my-created-skill\n---\n\nbody\n`,
      'utf8'
    );

    // 同名种子分类目录放在非种子根（userData）下：属于用户技能，不应被当作内置
    const sameNameDir = path.join(userData, 'skills', 'user', 'minimax', 'seeded-skill');
    fs.mkdirSync(sameNameDir, { recursive: true });
    fs.writeFileSync(
      path.join(sameNameDir, 'SKILL.md'),
      `---\nname: ${sameNameSkill}\ndescription: user owned\n---\n\nbody\n`,
      'utf8'
    );
  });

  afterAll(() => {
    if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('带 skillKey 的用户技能不再被判为内置，且可删除', async () => {
    const { skills } = await scanSkills({ userData, workspacePath: null });
    const mine = skills.find((s) => s.name === createdName);
    expect(mine).toBeTruthy();
    expect(mine.builtin).toBe(false);
    expect(mine.deletable).toBe(true);
    expect(mine.undeletableReason).toBe('');
  });

  it('非种子根下名为 minimax 的目录不算内置，仍可删除', async () => {
    const { skills } = await scanSkills({ userData, workspacePath: null });
    const sameName = skills.find((s) => s.name === sameNameSkill);
    expect(sameName).toBeTruthy();
    expect(sameName.builtin).toBe(false);
    expect(sameName.deletable).toBe(true);
    expect(sameName.undeletableReason).toBe('');
  });
});

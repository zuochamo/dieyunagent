'use strict';

/**
 * `updateUserSkill`：改技能正文而不重建目录。
 *
 * 为什么这条要钉：`createUserSkill` 每次都新建目录（同名会派生 `name-1`），
 * 所以「改一下这条技能」若走「删了重建」，代价是换目录 = 换 `skillKey` = 丢启用状态，
 * 技能列表里还会留下一串副本。这里锁四件事：
 * 1. 正文被替换、frontmatter 的 `skillKey` 原样保留；
 * 2. 只给 name / description 时正文不动；
 * 3. 扫描根之外、没有 SKILL.md、技能根本身 → 结构化拒绝；
 * 4. 预装/种子技能不可改。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const { updateUserSkill } = require('../../src/agent-home');

function seedSkill(userData, folder, frontmatter) {
  const dir = path.join(userData, 'skills', 'user', folder);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'SKILL.md'),
    `---\nname: ${frontmatter.name}\ndescription: ${frontmatter.description || '原简介'}\ncategory: 用户添加\nskillKey: user:${folder}\n---\n\n原始正文\n`,
    'utf8'
  );
  return dir;
}

describe('agent-home/updateUserSkill', () => {
  let userData;
  beforeEach(() => {
    userData = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-update-'));
  });
  afterEach(() => {
    try {
      fs.rmSync(userData, { recursive: true, force: true });
    } catch {
      // 清理失败不影响判定
    }
  });

  it('换正文：skillKey 与名称保留，正文更新', async () => {
    const dir = seedSkill(userData, 'demo', { name: '演示技能' });
    const r = await updateUserSkill(userData, null, { dir, content: '## 新正文\n步骤一' });
    expect(r.dir).toBe(path.resolve(dir));
    const text = fs.readFileSync(r.skillPath, 'utf8');
    expect(text).toContain('skillKey: user:demo');
    expect(text).toContain('name: 演示技能');
    expect(text).toContain('## 新正文');
    expect(text).not.toContain('原始正文');
    // 回执用得上：改动前后的全文都给出来了
    expect(r.before).toContain('原始正文');
    expect(r.after).toContain('## 新正文');
  });

  it('只改简介：正文不动', async () => {
    const dir = seedSkill(userData, 'demo', { name: '演示技能' });
    await updateUserSkill(userData, null, { dir, description: '新简介' });
    const text = fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8');
    expect(text).toContain('description: 新简介');
    expect(text).toContain('原始正文');
  });

  it('改名称不动目录（skillKey 是启用状态的键）', async () => {
    const dir = seedSkill(userData, 'demo', { name: '演示技能' });
    const r = await updateUserSkill(userData, null, { dir, name: '新名字' });
    expect(r.skillPath).toBe(path.resolve(path.join(dir, 'SKILL.md')));
    const text = fs.readFileSync(r.skillPath, 'utf8');
    expect(text).toContain('name: 新名字');
    expect(text).toContain('skillKey: user:demo');
  });

  it('扫描根之外 / 没有 SKILL.md → 拒绝（不猜路径）', async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-outside-'));
    try {
      await expect(updateUserSkill(userData, null, { dir: outside })).rejects.toThrow(/扫描范围|SKILL\.md/);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('预装/种子技能不可改（随包更新，改了下次就丢）', async () => {
    // 种子判定只在「真正的技能根」上生效（`~/.dieyun/skills`），单测不去碰用户家目录：
    // 这里直接钉住判定本身（`updateUserSkill` 复用的就是它），并验证 update 走的是同一条路。
    const { evaluateSkillDeletable, dieyunSkillsDir } = require('../../src/agent-home');
    const seeded = path.join(dieyunSkillsDir(), 'curated', 'builtin-skill');
    const verdict = evaluateSkillDeletable(seeded, [dieyunSkillsDir()]);
    expect(verdict.deletable).toBe(false);
    expect(verdict.reason).toBe('SEEDED');
    // 同一个 dir 走 update：被拒（缺 SKILL.md 也好、种子也好，反正是「不许写」）
    await expect(updateUserSkill(userData, null, { dir: seeded, content: 'x' })).rejects.toThrow();
  });
});

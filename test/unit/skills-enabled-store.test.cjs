'use strict';

/**
 * 技能启用状态的权威存储（`src/skills/enabled-store.js`）。
 *
 * 为什么它必须在 Main：注入发生在 Main —— 频道 / 定时计划 / headless / peer 来信
 * 这几档没有 Renderer。状态若只存在浏览器 localStorage，那些轮次只能按默认值猜，
 * 用户自建技能等于没启用。这些断言锁住「状态只有这一份、坏文件不当真」两件事。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  skillsEnabledPath,
  readEnabledMap,
  setSkillEnabled,
  storeExists
} = require('../../src/skills/enabled-store');

function tempUserData() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dieyun-skills-enabled-'));
}

describe('skills/enabled-store', () => {
  let userData;

  beforeEach(() => {
    userData = tempUserData();
  });

  afterEach(() => {
    fs.rmSync(userData, { recursive: true, force: true });
  });

  it('没有文件时是空表，且 exists=false（首次迁移的信号）', () => {
    expect(readEnabledMap(userData)).toEqual({});
    expect(storeExists(userData)).toBe(false);
  });

  it('写入后可读回，且 exists 变 true', () => {
    setSkillEnabled(userData, 'user:my-skill', true);
    expect(readEnabledMap(userData)).toEqual({ 'user:my-skill': true });
    expect(storeExists(userData)).toBe(true);
  });

  it('只覆盖被写的那一条，其余保持', () => {
    setSkillEnabled(userData, 'builtin:weather', false);
    setSkillEnabled(userData, 'user:my-skill', true);
    setSkillEnabled(userData, 'builtin:weather', true);
    expect(readEnabledMap(userData)).toEqual({ 'builtin:weather': true, 'user:my-skill': true });
  });

  it('显式关闭会落盘（false 不能被当成「没设置」丢掉）', () => {
    setSkillEnabled(userData, 'builtin:minimax:minimax-pdf', false);
    expect(readEnabledMap(userData)).toEqual({ 'builtin:minimax:minimax-pdf': false });
  });

  it('坏 JSON / 错误形状一律当空表，不抛', () => {
    fs.writeFileSync(skillsEnabledPath(userData), '{not json', 'utf8');
    expect(readEnabledMap(userData)).toEqual({});
    fs.writeFileSync(skillsEnabledPath(userData), JSON.stringify({ enabled: 'nope' }), 'utf8');
    expect(readEnabledMap(userData)).toEqual({});
    fs.writeFileSync(
      skillsEnabledPath(userData),
      JSON.stringify({ enabled: { 'a': 1, '': true, 'b': 0 } }),
      'utf8'
    );
    // 非空 id 保留并强制转布尔；空 id 丢弃
    expect(readEnabledMap(userData)).toEqual({ a: true, b: false });
  });

  it('缺 id 直接报错（不静默写一条脏键）', () => {
    expect(() => setSkillEnabled(userData, '   ', true)).toThrow(/id/);
  });

  it('文件位置固定为 <userData>/skills-enabled.json', () => {
    expect(skillsEnabledPath(userData)).toBe(path.join(userData, 'skills-enabled.json'));
    expect(skillsEnabledPath('')).toBe('');
  });
});

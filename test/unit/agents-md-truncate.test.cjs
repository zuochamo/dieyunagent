'use strict';

/**
 * 项目地图（.dieyun/AGENTS.md）超限行为的不变量。
 *
 * 背景（两次实测踩坑）：
 * 1. 2026-10-18：`applySectionUpdates` 用 `out.slice(0, MAX_FILE_CHARS)` 硬切，切点落在
 *    gotchas 中间，把排在后面的 `changelog` 连 marker 一起切掉；而「腾空间」分支以
 *    `bodies.has('changelog')` 为前提 —— 轮转永久失效，之后每次维护只能再切一刀。
 * 2. 2026-10-19：改成「保 changelog、裁主体尾巴」后又过头了 —— 主体尾巴就是 gotchas，
 *    整段消失后 `bodies.has('gotchas')` 变 false，此后**所有 gotchas 更新被静默 skip**，
 *    且不会自愈。
 *
 * 现在守的是：**任何 section 的 marker 都不许消失**，超限只做段内行裁剪 + 省略提示。
 */

const {
  MAX_FILE_CHARS,
  CHANGELOG_MAX_ROWS,
  parseSections,
  parseChangelogTable,
  applySectionUpdates,
  truncateAgentsMdByLines
} = require('../../src/agents-md');
const { lightAgentsMdContent } = require('../../src/agent/system-prompt-prep');

const CHANGELOG_MARKER = '<!-- dieyun:section:changelog';
const ALL_SECTIONS = ['overview', 'commands', 'gotchas', 'changelog'];

/**
 * @param {{ gotchas?: number, changelogRows?: number, includeChangelog?: boolean }} opts
 */
function buildDoc(opts = {}) {
  const { gotchas = 60, changelogRows = 3, includeChangelog = true } = opts;
  const lines = [
    '# AGENTS.md',
    '',
    '> 本文件供 AI Agent 阅读',
    '',
    '<!-- dieyun:section:overview status=stable -->',
    '## 项目概览',
    '',
    '- 测试项目，用于验证截断行为',
    '',
    '<!-- dieyun:section:commands status=stable -->',
    '## 常用命令',
    ''
  ];
  for (let i = 0; i < 4; i += 1) lines.push(`- npm run cmd-${i}`);
  lines.push('', '<!-- dieyun:section:gotchas status=stable -->', '## 已知坑点', '');
  for (let i = 0; i < gotchas; i += 1) {
    lines.push(`- 坑 ${i}：${'细节'.repeat(200)}`);
  }
  if (includeChangelog) {
    lines.push(
      '',
      '<!-- dieyun:section:changelog status=auto -->',
      '## 维护记录',
      '',
      '| 日期 | 来源 | 摘要 |',
      '|------|------|------|'
    );
    for (let i = 0; i < changelogRows; i += 1) {
      lines.push(`| 2026-10-0${(i % 9) + 1} | agent | 记录 ${i} |`);
    }
  }
  return `${lines.join('\n')}\n`;
}

const APPEND_GOTCHA = [
  { section: 'gotchas', action: 'append', content: '- 新增一条坑：测试写入', confidence: 0.9 }
];

describe('项目地图超限截断', () => {
  it('超限后每个 section marker 都还在（含 gotchas）', () => {
    const doc = buildDoc({ gotchas: 60 });
    expect(doc.length).toBeGreaterThan(MAX_FILE_CHARS);

    const res = applySectionUpdates(doc, APPEND_GOTCHA, { source: 'agent' });
    expect(res.truncated).toBe(true);
    expect(res.content.length).toBeLessThanOrEqual(MAX_FILE_CHARS + 1);

    const ids = parseSections(res.content).map((s) => s.id);
    for (const id of ALL_SECTIONS) {
      expect(ids, `section ${id} 不应消失`).toContain(id);
    }
  });

  it('按行裁剪：不切半句，且被裁的段留省略提示', () => {
    const doc = buildDoc({ gotchas: 60 });
    const res = applySectionUpdates(doc, APPEND_GOTCHA, { source: 'agent' });
    expect(res.content).toMatch(/本段已裁剪：省略 \d+ 行/);
    const last = res.content.trimEnd().split('\n').pop();
    expect(last.length).toBeLessThan(2000);
  });

  it('维护记录轮转到最近若干条，不占满磁盘上限', () => {
    const doc = buildDoc({ gotchas: 20, changelogRows: 40 });
    const res = applySectionUpdates(doc, APPEND_GOTCHA, { source: 'agent' });
    const cl = parseSections(res.content).find((s) => s.id === 'changelog');
    const rows = parseChangelogTable(cl.body).rows;
    expect(rows.length).toBeLessThanOrEqual(CHANGELOG_MAX_ROWS + 1); // +1 = 本次追加
  });

  it('截断后仍可继续维护：gotchas 更新能落盘', () => {
    const doc = buildDoc({ gotchas: 60 });
    const first = applySectionUpdates(doc, APPEND_GOTCHA, { source: 'agent' });
    expect(first.truncated).toBe(true);

    const second = applySectionUpdates(
      first.content,
      [{ section: 'gotchas', action: 'append', content: '- 第二轮新增的坑：不应被丢弃', confidence: 0.9 }],
      { source: 'agent' }
    );
    expect(second.changelogRecreated).toBe(false);
    expect(second.content).toContain(CHANGELOG_MARKER);
    expect(second.content).toContain('第二轮新增的坑');
    expect(second.content.length).toBeLessThanOrEqual(MAX_FILE_CHARS + 1);
  });

  it('changelog 已被切掉时能重建该 section', () => {
    const broken = buildDoc({ gotchas: 60, includeChangelog: false });
    expect(broken).not.toContain(CHANGELOG_MARKER);

    const res = applySectionUpdates(broken, APPEND_GOTCHA, { source: 'agent' });
    expect(res.changelogRecreated).toBe(true);
    const ids = parseSections(res.content).map((s) => s.id);
    expect(ids).toContain('gotchas');
    expect(ids).toContain('changelog');
  });

  it('truncateAgentsMdByLines 只丢整行', () => {
    const src = ['aaaa', 'bbbb', 'cccc', 'dddd'].join('\n');
    const cut = truncateAgentsMdByLines(src, 12);
    expect(cut.truncated).toBe(true);
    expect(cut.text).toBe('aaaa\nbbbb');
    expect(cut.droppedLines).toBe(2);
    expect(truncateAgentsMdByLines(src, 999).truncated).toBe(false);
  });
});

describe('注入按 section 配额', () => {
  it('预算内三段都在（整体 slice 会把 gotchas 整段切掉）', () => {
    const doc = buildDoc({ gotchas: 60 });
    const budget = 6000;
    const light = lightAgentsMdContent(doc, budget);

    expect(light).toContain('dieyun:section:overview');
    expect(light).toContain('dieyun:section:commands');
    expect(light).toContain('dieyun:section:gotchas');
    expect(light.length).toBeLessThanOrEqual(budget);
    expect(light).toMatch(/本段另有 \d+ 行未注入/);
  });

  it('不传 budget 时保持旧行为（整段全给）', () => {
    const doc = buildDoc({ gotchas: 3 });
    const light = lightAgentsMdContent(doc);
    expect(light).toContain('坑 2');
    expect(light).not.toContain('本段另有');
  });

  it('overview 预算够时不做裁剪', () => {
    const doc = buildDoc({ gotchas: 60 });
    const light = lightAgentsMdContent(doc, 6000);
    // 注入顺序是 overview → gotchas → commands，所以按 marker 区间判断，不能假设下一个段是 commands
    const ovStart = light.indexOf('dieyun:section:overview');
    const ovEnd = light.indexOf('dieyun:section:', ovStart + 10);
    expect(ovStart).toBeGreaterThan(-1);
    expect(ovEnd).toBeGreaterThan(ovStart);
    expect(light.slice(ovStart, ovEnd)).not.toContain('本段另有');
  });
});

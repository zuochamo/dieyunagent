'use strict';

/**
 * 维护协议：merge（并入已有条目）＋ 体积反馈 ＋ 注入顺序。
 *
 * 背景：`agents_md_propose` 原先只有 append / replace，agent 想「同主题合并」时无路可走，
 * 只能再 append 一条 —— 实测 CameraCut 一天内被写了两次。同时工具与注入块都不告诉
 * 模型文件有多大，它也不知道自己快写满了。这里守住三件事：
 * 1. merge 按 anchor 命中已有条目并整行替换；找不到要回原因，不能静默失败；
 * 2. 注入块头部带文件体积 / 段数，接近上限时带「先合并别再 append」的提醒；
 * 3. gotchas 注入在 commands 之前（lost in the middle）。
 */

const {
  applySectionUpdates,
  formatAgentsMdSystemBlock,
  MAX_FILE_CHARS,
  NEAR_LIMIT_CHARS
} = require('../../src/agents-md');
const { lightAgentsMdContent } = require('../../src/agent/system-prompt-prep');

const DOC = [
  '# AGENTS.md',
  '',
  '<!-- dieyun:section:overview status=stable -->',
  '## 项目概览',
  '测试项目',
  '',
  '<!-- dieyun:section:commands status=stable -->',
  '## 常用命令',
  '- COMMANDS-BODY',
  '',
  '<!-- dieyun:section:gotchas status=stable -->',
  '## 已知坑点',
  '- **CameraCut：section 绝不能重叠**（旧内容）',
  '- **host_exec 四类失败**（旧内容）',
  ''
].join('\n');

function gotchasLines(content) {
  const start = content.indexOf('dieyun:section:gotchas');
  return content
    .slice(start)
    .split('\n')
    .filter((l) => l.trim().startsWith('- '));
}

describe('merge 并入已有条目', () => {
  it('按 anchor 命中并整行替换，不新增第二条', () => {
    const res = applySectionUpdates(
      DOC,
      [
        {
          section: 'gotchas',
          action: 'merge',
          anchor: '**CameraCut',
          content: '- **CameraCut 两条合一**：重叠会失效 + 无 create_camera_cut。',
          confidence: 0.9
        }
      ],
      { source: 'agent' }
    );
    expect(res.applied).toHaveLength(1);
    const lines = gotchasLines(res.content);
    expect(lines.filter((l) => l.includes('CameraCut'))).toHaveLength(1);
    expect(res.content).toContain('两条合一');
    expect(res.content).not.toContain('旧内容**');
  });

  it('anchor 未命中时返回原因，不改动内容', () => {
    const res = applySectionUpdates(
      DOC,
      [{ section: 'gotchas', action: 'merge', anchor: '**不存在的条目', content: '- x', confidence: 0.9 }],
      { source: 'agent' }
    );
    expect(res.applied).toHaveLength(0);
    expect(res.skipped).toHaveLength(1);
    expect(res.skipped[0].reason).toMatch(/未找到/);
    expect(res.content).not.toContain('- x');
  });

  it('缺 anchor 时明确报错（而不是退化成 append）', () => {
    const res = applySectionUpdates(
      DOC,
      [{ section: 'gotchas', action: 'merge', content: '- x', confidence: 0.9 }],
      { source: 'agent' }
    );
    expect(res.applied).toHaveLength(0);
    expect(res.skipped[0].reason).toMatch(/anchor/);
  });

  it('merge 不写 changelog 之外的重复行', () => {
    const res = applySectionUpdates(
      DOC,
      [
        { section: 'gotchas', action: 'merge', anchor: '**host_exec', content: '- **host_exec 四类失败**：已更新。', confidence: 0.9 }
      ],
      { source: 'agent' }
    );
    const lines = gotchasLines(res.content);
    expect(lines.filter((l) => l.includes('host_exec'))).toHaveLength(1);
  });
});

describe('注入块体积反馈', () => {
  it('头部带文件字数与注入段数', () => {
    const block = formatAgentsMdSystemBlock({
      content: '正文',
      relativePath: '.dieyun/AGENTS.md',
      workspacePath: 'D:/proj',
      maxChars: 13500,
      stats: { fileChars: 12345, fileLimit: 24000, sectionCount: 8, injectedCount: 3 }
    });
    expect(block).toMatch(/12,345 字 \/ 上限 24,000/);
    expect(block).toMatch(/本轮注入 3\/8 段/);
    expect(block).not.toMatch(/⚠/);
  });

  it('接近上限时带「先合并」提醒', () => {
    const block = formatAgentsMdSystemBlock({
      content: '正文',
      relativePath: '.dieyun/AGENTS.md',
      maxChars: 13500,
      stats: { fileChars: 22000, fileLimit: MAX_FILE_CHARS, sectionCount: 8, injectedCount: 3, nearLimit: true }
    });
    expect(block).toMatch(/⚠/);
    expect(block).toContain('action=merge');
  });

  it('fileChars 达到警戒线即触发提醒（不依赖调用方传 nearLimit）', () => {
    const block = formatAgentsMdSystemBlock({
      content: '正文',
      relativePath: '.dieyun/AGENTS.md',
      stats: { fileChars: NEAR_LIMIT_CHARS + 1, fileLimit: MAX_FILE_CHARS }
    });
    expect(block).toMatch(/⚠/);
  });

  it('无 stats 时保持旧格式（不出现括号元信息）', () => {
    const block = formatAgentsMdSystemBlock({ content: '正文', relativePath: '.dieyun/AGENTS.md' });
    expect(block).not.toMatch(/上限 24,000/);
    expect(block).toContain('【项目地图 · AGENTS.md】');
  });
});

describe('注入顺序', () => {
  it('gotchas 排在 commands 之前', () => {
    const light = lightAgentsMdContent(DOC, 13500, { pathHints: [] });
    const g = light.indexOf('dieyun:section:gotchas');
    const c = light.indexOf('dieyun:section:commands');
    expect(g).toBeGreaterThan(-1);
    expect(c).toBeGreaterThan(-1);
    expect(g).toBeLessThan(c);
  });

  it('overview 仍排最前', () => {
    const light = lightAgentsMdContent(DOC, 13500, { pathHints: [] });
    expect(light.indexOf('dieyun:section:overview')).toBeLessThan(light.indexOf('dieyun:section:gotchas'));
  });
});

'use strict';

const {
  inferTaskTierFromStructure,
  skipAutoCodebaseForTaskTier,
  formatTaskTierSystemBlock
} = require('../../src/agent/task-tier');
const { AGENT_LIMITS_DEFAULTS } = require('../../src/agent/agent-limits');

describe('task-tier', () => {
  it('uses path structure for trivial without intent keywords', () => {
    const scoped = inferTaskTierFromStructure({
      userText: '改这一处样式',
      pathHints: ['src/app.css'],
      codebaseMention: false
    });
    expect(scoped.taskTier).toBe('trivial');
    expect(scoped.readyToWrite).toBe(true);
    expect(scoped.source).toBe('structure');

    const unscoped = inferTaskTierFromStructure({
      userText: '帮我看看这个仓库怎么组织的',
      pathHints: [],
      codebaseMention: false
    });
    expect(unscoped.taskTier).toBe('normal');
  });

  it('tier does not depend on message length', () => {
    const longRequest = '把这块状态机的重试与退避全部梳理一遍，'.repeat(40);
    const scopedLong = inferTaskTierFromStructure({
      userText: longRequest,
      pathHints: ['src/agent/task-tier.js'],
      codebaseMention: false
    });
    // 长需求 + 一个具体文件：仍然是「已限定范围」，字数不参与判定
    expect(scopedLong.taskTier).toBe('trivial');
    const emptyText = inferTaskTierFromStructure({
      userText: '',
      pathHints: ['src/agent/task-tier.js']
    });
    expect(emptyText.taskTier).toBe('trivial');
    // 没有路径提示时，再短也是 normal
    expect(inferTaskTierFromStructure({ userText: '改一下', pathHints: [] }).taskTier).toBe('normal');
  });

  it('skips auto codebase only when trivial and ready/files', () => {
    const scoped = inferTaskTierFromStructure({
      userText: 'x',
      pathHints: ['a.js']
    });
    expect(skipAutoCodebaseForTaskTier(scoped, true)).toBe(true);
    expect(
      skipAutoCodebaseForTaskTier(
        {
          taskTier: 'normal',
          readyToWrite: false,
          suggestedFiles: []
        },
        true
      )
    ).toBe(false);
    expect(skipAutoCodebaseForTaskTier(scoped, false)).toBe(false);
  });

  it('does not coerce writes in the system block', () => {
    const scoped = inferTaskTierFromStructure({
      userText: 'x',
      pathHints: ['a.js']
    });
    const block = formatTaskTierSystemBlock(scoped);
    expect(block).toContain('建议文件：a.js');
    expect(block).not.toMatch(/fs_edit|直接改/);
  });
});


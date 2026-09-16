'use strict';

const {
  inferTaskTierFromStructure,
  skipAutoCodebaseForTaskTier,
  formatTaskTierSystemBlock
} = require('../../src/agent/task-tier');
const { mergeMissingReasoning, attachPartialStreamError } = require('../../src/llm-stream-utils');
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

describe('stream partial merge', () => {
  it('restores missing reasoning and attaches partial on errors', () => {
    const recovered = mergeMissingReasoning(
      { content: 'hi', reasoning: '', toolCalls: [] },
      { reasoning: 'think first', content: '' }
    );
    expect(recovered.reasoning).toBe('think first');
    expect(recovered.reasoningRecovered).toBe(true);

    const err = attachPartialStreamError(new Error('reset'), {
      reasoning: 'partial think',
      content: ''
    });
    expect(err.partial && err.partial.reasoning).toBe('partial think');
  });

  it('keeps taskTier limit defaults', () => {
    expect(AGENT_LIMITS_DEFAULTS.taskTierEnabled).toBe(true);
    expect(AGENT_LIMITS_DEFAULTS.taskTierTimeoutMs).toBeUndefined();
  });
});

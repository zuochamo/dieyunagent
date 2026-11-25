'use strict';

/**
 * `src/agent/schema-rules.js` 的单测（条件规则求值器）
 *
 * 它现在承担 `lsp` / `host_proc` / `worktree` 的「某个 action 下才必填」——
 * 手写校验器与生成的校验器都调它，所以它自己必须先被钉住。
 */

const { evaluateRules, matches, present } = require('../../src/agent/schema-rules');
const { getToolByName } = require('../../src/agent/tool-catalog');

const params = (name) => getToolByName(name).function.parameters;

describe('schema-rules · matches（条件判断）', () => {
  test('required 与 const / enum / not', () => {
    expect(matches({ a: 1 }, { required: ['a'] })).toBe(true);
    expect(matches({}, { required: ['a'] })).toBe(false);
    expect(matches({ op: 'x' }, { properties: { op: { const: 'x' } } })).toBe(true);
    expect(matches({ op: 'y' }, { properties: { op: { const: 'x' } } })).toBe(false);
    expect(matches({ op: 'y' }, { properties: { op: { not: { enum: ['x'] } } } })).toBe(true);
    expect(matches({ op: 'x' }, { properties: { op: { not: { enum: ['x'] } } } })).toBe(false);
    // 没给的字段不算违反（必填由 required 管）
    expect(matches({}, { properties: { op: { const: 'x' } } })).toBe(true);
  });

  test('空白字符串算「没给」，但内容类字段例外', () => {
    expect(present({ a: '  ' }, 'a')).toBe(false);
    expect(present({ content: '  ' }, 'content')).toBe(true);
  });

  test('workspace 的空串是「有意义的空值」（plan_update 靠它改回跟随工作空间）', () => {
    expect(present({ workspace: '' }, 'workspace')).toBe(true);
    const ok = evaluateRules('plan_update', params('plan_update'), { id: 'p1', workspace: '' });
    expect(ok.ok).toBe(true);
    // 其它可编辑字段的空串仍然算「没给」：只给 id + 空 name 时应该被判缺参数
    const bad = evaluateRules('plan_update', params('plan_update'), { id: 'p1', name: '   ' });
    expect(bad.ok).toBe(false);
    expect(bad.errorCode).toBe('MISSING_ARG');
  });
});

describe('schema-rules · lsp 的三种 operation', () => {
  test('workspaceSymbol 只缺 query 时拒绝，给了就过', () => {
    const bad = evaluateRules('lsp', params('lsp'), { operation: 'workspaceSymbol' });
    expect(bad.ok).toBe(false);
    expect(bad.errorCode).toBe('MISSING_ARG');
    expect(bad.error).toContain('query');
    expect(bad.error).toContain('operation=workspaceSymbol'); // 条件写进报错，模型知道为什么
    expect(evaluateRules('lsp', params('lsp'), { operation: 'workspaceSymbol', query: 'main' }).ok).toBe(true);
  });

  test('documentSymbol 要 filePath 但不要 line', () => {
    expect(evaluateRules('lsp', params('lsp'), { operation: 'documentSymbol' }).errorCode).toBe('MISSING_PATH');
    expect(
      evaluateRules('lsp', params('lsp'), { operation: 'documentSymbol', filePath: 'a.js' }).ok
    ).toBe(true);
  });

  test('定位类 operation 要 filePath + line', () => {
    expect(
      evaluateRules('lsp', params('lsp'), { operation: 'goToDefinition', filePath: 'a.js' }).errorCode
    ).toBe('MISSING_ARG');
    expect(
      evaluateRules('lsp', params('lsp'), { operation: 'goToDefinition', filePath: 'a.js', line: 3 }).ok
    ).toBe(true);
  });
});

describe('schema-rules · host_proc / worktree', () => {
  test('kill 要 id 或 pid 之一', () => {
    const bad = evaluateRules('host_proc', params('host_proc'), { action: 'kill' });
    expect(bad.ok).toBe(false);
    expect(bad.errorCode).toBe('MISSING_ARG');
    expect(evaluateRules('host_proc', params('host_proc'), { action: 'kill', pid: 42 }).ok).toBe(true);
    expect(evaluateRules('host_proc', params('host_proc'), { action: 'kill', id: 'hostproc-1' }).ok).toBe(true);
    expect(evaluateRules('host_proc', params('host_proc'), { action: 'list' }).ok).toBe(true);
  });

  test('worktree：create 要 runId、remove 要 path，其余不要', () => {
    expect(evaluateRules('worktree', params('worktree'), { action: 'create' }).errorCode).toBe('MISSING_ARG');
    expect(evaluateRules('worktree', params('worktree'), { action: 'create', runId: 'r1' }).ok).toBe(true);
    expect(evaluateRules('worktree', params('worktree'), { action: 'remove' }).errorCode).toBe('MISSING_PATH');
    expect(evaluateRules('worktree', params('worktree'), { action: 'remove', path: 'x' }).ok).toBe(true);
    expect(evaluateRules('worktree', params('worktree'), { action: 'list' }).ok).toBe(true);
    expect(evaluateRules('worktree', params('worktree'), {}).ok).toBe(true); // 缺省 action=list
  });

  test('没有 allOf 的工具直接放行', () => {
    expect(evaluateRules('grep', params('grep'), {}).ok).toBe(true);
  });
});

describe('schema-rules · 跨字段（A2）', () => {
  test('顶层 anyOf：read_symbol 三选一', () => {
    const p = params('read_symbol');
    expect(evaluateRules('read_symbol', p, {}).errorCode).toBe('MISSING_ARG');
    expect(evaluateRules('read_symbol', p, { filePath: 'a.js' }).ok).toBe(false);
    expect(evaluateRules('read_symbol', p, { filePath: 'a.js', name: 'main' }).ok).toBe(true);
    expect(evaluateRules('read_symbol', p, { filePath: 'a.js', line: 3 }).ok).toBe(true);
    expect(evaluateRules('read_symbol', p, { name: 'main' }).ok).toBe(true);
  });

  test('顶层 anyOf：goal_update / goal_check 择一', () => {
    const gu = params('goal_update');
    expect(evaluateRules('goal_update', gu, {}).ok).toBe(false);
    expect(evaluateRules('goal_update', gu, { todos: [] }).ok).toBe(true);
    const gc = params('goal_check');
    expect(evaluateRules('goal_check', gc, {}).ok).toBe(false);
    expect(evaluateRules('goal_check', gc, { command: 'npm test' }).ok).toBe(true);
    expect(evaluateRules('goal_check', gc, { check_id: 'c1' }).ok).toBe(true);
    expect(evaluateRules('goal_check', gc, { checkId: 'c1' }).ok).toBe(true); // 别名同样在 schema 里声明
  });

  test('嵌套 required：plan_create.goal.objective / .checks', () => {
    const p = params('plan_create');
    const miss = evaluateRules('plan_create', p, { goal: { checks: [] }, prompt: 'x' });
    expect(miss.ok).toBe(false);
    expect(miss.error).toContain('goal.objective');
    expect(evaluateRules('plan_create', p, { goal: { objective: 'o' }, prompt: 'x' }).error).toContain(
      'goal.checks'
    );
    expect(evaluateRules('plan_create', p, { goal: { objective: 'o', checks: [] }, prompt: 'x' }).ok).toBe(
      true
    );
  });

  test('互斥：plan_create 的 goal 与 rrule/onceAt', () => {
    const p = params('plan_create');
    const bad = evaluateRules('plan_create', p, {
      goal: { objective: 'o', checks: [] },
      prompt: 'x',
      rrule: 'FREQ=DAILY'
    });
    expect(bad.ok).toBe(false);
    expect(bad.errorCode).toBe('INVALID_ARG');
    expect(
      evaluateRules('plan_create', p, {
        goal: { objective: 'o', checks: [] },
        prompt: 'x',
        onceAt: '2026-12-01T00:00:00Z'
      }).ok
    ).toBe(false);
  });
});

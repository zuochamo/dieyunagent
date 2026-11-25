'use strict';

/**
 * 工具结果 → 思考区一行摘要（`src/agent/tool-result-summary.js`）。
 *
 * 这条用例锁的是**已经漂移过**的四个点 —— 以前 Main（live-loop-trace，planner / 子 Agent 卡片）
 * 与 Renderer（renderer-tool-results，桌面气泡）各写一份，同一件事给出两种说法：
 * 1. 后台化：`timedOut && stillRunning` vs `detached` → 「转后台继续运行（hostproc-7）」vs「已后台启动 PID 123」
 * 2. 非零退出码：一边保留真实值、一边压成 `exit 0`
 * 3. 「看起来不像输出」正则：一边 4 支、一边多一支 `import `
 * 4. 无输出兜底：「完成」vs「命令成功（无输出）」
 * 现在只有一份实现，两侧都调它，所以本用例即等于两侧一致性。
 */

const assert = require('node:assert/strict');
const { summarizeToolResult, summarizeHostExecResult } = require('../../src/agent/tool-result-summary');

test('后台化：两种字段形态给同一种说法（detached 与 timedOut+stillRunning）', () => {
  const byHandle = summarizeHostExecResult({ timedOut: true, stillRunning: true, handle: 'hostproc-7' });
  const byPid = summarizeHostExecResult({ detached: true, pid: 4321 });
  assert.match(byHandle, /已后台启动/);
  assert.match(byPid, /已后台启动/);
  assert.match(byHandle, /hostproc-7/);
  assert.match(byPid, /PID 4321/);
  // 两种形态都不许退化成「完成」
  assert.notEqual(byHandle, '完成');
  assert.notEqual(byPid, '完成');
});

test('非零退出码必须保留真实值（不许压成 exit 0）', () => {
  const out = 'import os\n' + 'x'.repeat(120);
  const summary = summarizeHostExecResult({ code: 2, stdout: out });
  assert.match(summary, /exit 2/);
  assert.doesNotMatch(summary, /exit 0/);
  // 失败分支也保留真实码
  assert.match(summarizeHostExecResult({ code: 127, stderr: 'command not found' }), /exit 127/);
});

test('「看起来不像输出」正则取并集：import / # / 注释块 / HTML 都折叠成 N 字', () => {
  for (const out of ['import x from "y"\n' + 'a'.repeat(120), '# 标题\n' + 'a'.repeat(120), '<!DOCTYPE html><html>' + 'a'.repeat(120)]) {
    const s = summarizeHostExecResult({ code: 0, stdout: out });
    assert.match(s, /输出 \d+ 字/, '长且不像输出时应折叠成「输出 N 字」：' + s);
  }
});

test('无输出兜底是「命令成功（无输出）」，有退出码时给 exit', () => {
  assert.equal(summarizeHostExecResult({ code: 0, stdout: '' }), 'exit 0');
  assert.equal(summarizeHostExecResult({ stdout: '' }), '命令成功（无输出）');
});

test('失败文案：带错误码与建议（两条路径同一句）', () => {
  const fromResult = summarizeToolResult('fs_read_file', {
    error: '文件不存在',
    errorCode: 'MISSING_PATH',
    suggestedFix: '先 fs_list_dir'
  });
  const fromPhaseError = summarizeToolResult('fs_read_file', { errorCode: 'MISSING_PATH', suggestedFix: '先 fs_list_dir' }, '文件不存在');
  assert.equal(fromResult, fromPhaseError, 'result.error 与 phase 的独立 error 必须产出同一句');
  assert.match(fromResult, /^失败：\[MISSING_PATH\]/);
  assert.match(fromResult, /先 fs_list_dir/);
});

test('文件类工具：文件名 + 新建/已替换/已写入 + ±N + N 处', () => {
  assert.equal(
    summarizeToolResult('fs_write_file', { path: 'D:/w/a/b.js', diff: { added: 3, removed: 1, created: true } }),
    'b.js · 新建 · +3 -1'
  );
  assert.equal(
    summarizeToolResult('fs_edit', { path: '/w/b.js', diff: { added: 2, removed: 1 }, replacements: 4 }),
    'b.js · 已替换 · +2 -1 · 4 处'
  );
});

test('host_exec 走同一份实现（summarizeToolResult 不另判一套）', () => {
  const r = { detached: true, pid: 99 };
  assert.equal(summarizeToolResult('host_exec', r), summarizeHostExecResult(r));
});

test('未知工具 / 空结果不抛错', () => {
  assert.equal(summarizeToolResult('some_unknown_tool', null), '完成');
  assert.equal(summarizeToolResult('some_unknown_tool', {}), '完成');
  assert.equal(summarizeToolResult(undefined, undefined), '完成');
});

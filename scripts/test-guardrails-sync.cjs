'use strict';

/**
 * Ensure tool-guardrails (Main) and guardrails-shared stay aligned.
 */

const shared = require('../src/agent/guardrails-shared');
const main = require('../src/agent/tool-guardrails');

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assert failed');
}

function setEqual(a, b, label) {
  const sa = [...a].sort().join(',');
  const sb = [...b].sort().join(',');
  assert(sa === sb, `${label} mismatch`);
}

setEqual(
  Object.keys(main.TOOL_NAME_ALIASES),
  Object.keys(shared.TOOL_NAME_ALIASES),
  'TOOL_NAME_ALIASES keys'
);

assert(
  main.HOST_EXEC_FILE_WRITE_RE.source === shared.HOST_EXEC_FILE_WRITE_RE.source,
  'HOST_EXEC_FILE_WRITE_RE'
);
assert(
  main.HOST_EXEC_VALIDATION_RE.source === shared.HOST_EXEC_VALIDATION_RE.source,
  'HOST_EXEC_VALIDATION_RE'
);

const hist = [];
const api = shared.createGuardrailApi(() => ({
  repeatToolStreakLimit: 5,
  repeatHistoryMax: 20
}));

for (let i = 0; i < 3; i++) {
  api.recordToolCallFingerprint(hist, 'fs_list_dir', { dirPath: 'src' });
}
assert(
  main.shouldBlockRepeatToolCall('fs_list_dir', { dirPath: 'src' }, hist, 5, null) ===
    api.shouldBlockRepeatToolCall('fs_list_dir', { dirPath: 'src' }, hist, 5),
  'repeat block parity'
);

// --- 浏览器验收证据（renderer/agent-guardrails.js，需要 window + GuardrailsShared）---
global.GuardrailsShared = shared;
global.window = {};
require('../src/renderer/agent-guardrails');
const rendererGuardrails = global.window;

const browserTrace = [
  {
    round: 1,
    tools: [
      { name: 'browser_navigate', result: {} },
      { name: 'browser_click', failed: true }
    ]
  }
];

const sig = rendererGuardrails.collectBrowserEvidence(browserTrace, {
  errorCount: 2,
  errors: ['boom']
});
assert(sig.used === true, 'browser evidence detects browser tools');
assert(sig.failedTools.includes('browser_click'), 'browser evidence keeps failed tools');
assert(sig.errorCount === 2, 'browser evidence keeps runtime error count');

const noBrowser = rendererGuardrails.collectBrowserEvidence(
  [{ round: 1, tools: [{ name: 'fs_edit' }] }],
  { errorCount: 5 }
);
assert(noBrowser.used === false && noBrowser.errorCount === 0, 'non-browser trace ignores runtime errors');

// 纯浏览器任务没有写入信号，运行时错误提示不能被「无证据即跳过」吞掉
const gate = rendererGuardrails.verifyAgentCompletionReadiness('已完成页面登录', browserTrace, [], {
  mode: 'agent',
  diagnostics: null,
  browser: { errorCount: 1, errors: ['[pageerror] boom'] }
});
assert(
  gate.ok === false && gate.reason === 'browser_runtime_errors',
  'browser runtime errors produce readiness note'
);
assert(/浏览器/.test(gate.note) && gate.surfaceToUser === true, 'readiness note mentions browser and surfaces');
assert(gate.shouldRetry === false, 'browser readiness note never auto-retries');

// 无运行时错误 → 纯浏览器任务仍然跳过（不误报）
const clean = rendererGuardrails.verifyAgentCompletionReadiness('已完成页面登录', browserTrace, [], {
  mode: 'agent',
  diagnostics: null,
  browser: { errorCount: 0, errors: [] }
});
assert(clean.ok === true && clean.skipped === true, 'clean browser task still skips readiness');

// 断言证据：只看最后一次 browser_expect（先失败后修复重跑通过不应误报）
const fixedExpectTrace = [
  { round: 1, tools: [{ name: 'browser_expect', failed: true, summary: '断言 1/2 通过 · 1 条未通过' }] },
  { round: 2, tools: [{ name: 'browser_expect', failed: false, summary: '断言全部通过（2 条）' }] }
];
const fixedGate = rendererGuardrails.verifyAgentCompletionReadiness('已修复并复验', fixedExpectTrace, [], {
  mode: 'agent',
  diagnostics: null,
  browser: { errorCount: 0, errors: [] }
});
assert(fixedGate.ok === true && fixedGate.skipped === true, 'fixed expectation passes readiness');

const failedExpectTrace = [
  { round: 1, tools: [{ name: 'browser_expect', failed: true, summary: '断言 1/2 通过 · 1 条未通过' }] }
];
const failedGate = rendererGuardrails.verifyAgentCompletionReadiness('已完成', failedExpectTrace, [], {
  mode: 'agent',
  diagnostics: null,
  browser: { errorCount: 0, errors: [] }
});
assert(
  failedGate.ok === false && failedGate.reason === 'browser_expect_failed',
  'failed expectation produces readiness note'
);
assert(/browser_expect/.test(failedGate.note) && failedGate.shouldRetry === false, 'expectation note is advisory only');

const sigExpect = rendererGuardrails.collectExpectationSignals(fixedExpectTrace);
assert(sigExpect.total === 2 && sigExpect.failedCount === 1 && sigExpect.lastFailed === false, 'expectation signals track last call');

console.log('test-guardrails-sync.cjs ok');

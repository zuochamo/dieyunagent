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

// llm-tool-call-fallback 必须复用同一张表（曾因各写一份而漂移，见 HARNESS-INVENTORY §D）
const llmFallback = require('../src/llm-tool-call-fallback');
for (const [alias, canonical] of Object.entries(shared.TOOL_NAME_ALIASES)) {
  assert(
    llmFallback.normalizeToolName(alias) === canonical,
    `llm-tool-call-fallback alias ${alias} -> ${canonical}`
  );
}
assert(
  llmFallback.normalizeToolName('EXEC') === 'host_exec',
  'llm-tool-call-fallback alias lookup is case-insensitive'
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

// --- 完成验收（Main 单一来源 src/agent/completion-readiness.js）---
// 判定与证据采集都在 Main：这里直接测模块，不再经 Renderer 的 window 全局。
const readiness = require('../src/agent/completion-readiness');

const browserTrace = [
  {
    round: 1,
    tools: [
      { name: 'browser_navigate', result: {} },
      { name: 'browser_click', result: { ok: false, error: '找不到元素' } }
    ]
  }
];

const gate = readiness.evaluateReadiness(readiness.collectEvidence(browserTrace), {
  browser: { used: true, errorCount: 1, errors: ['[pageerror] boom'] }
});
assert(
  gate.ok === false && gate.reason === 'browser_runtime_errors',
  'browser runtime errors produce readiness note'
);
assert(/浏览器/.test(gate.note) && gate.surfaceToUser === true, 'readiness note mentions browser and surfaces');
assert(gate.shouldRetry === false, 'browser readiness note never auto-retries');

// 无运行时错误 → 纯浏览器任务仍然跳过（不误报）
const clean = readiness.evaluateReadiness(readiness.collectEvidence(browserTrace), {
  browser: { used: true, errorCount: 0, errors: [] }
});
assert(clean.ok === true && clean.skipped === true, 'clean browser task still skips readiness');

// 断言证据：只看最后一次 browser_expect（先失败后修复重跑通过不应误报）
// 真形状：断言未通过时 ok=false 但**不带 error**（src/browser/expect.js），失败只在 failed 计数里
const expectFail = {
  ok: false,
  total: 2,
  passed: 1,
  failed: 1,
  results: [
    { id: 'login', kind: 'text', pass: false, expected: '登录', actual: '登录中' },
    { kind: 'visible', pass: true }
  ]
};
const expectPass = { ok: true, total: 2, passed: 2, failed: 0, results: [{ kind: 'text', pass: true }, { kind: 'visible', pass: true }] };
const fixedExpectTrace = [
  { round: 1, tools: [{ name: 'browser_expect', result: expectFail }] },
  { round: 2, tools: [{ name: 'browser_expect', result: expectPass }] }
];
const fixedGate = readiness.evaluateReadiness(readiness.collectEvidence(fixedExpectTrace), {
  browser: { used: true, errorCount: 0, errors: [] }
});
assert(fixedGate.ok === true && fixedGate.skipped === true, 'fixed expectation passes readiness');

const failedExpectTrace = [{ round: 1, tools: [{ name: 'browser_expect', result: expectFail }] }];
const failedGate = readiness.evaluateReadiness(readiness.collectEvidence(failedExpectTrace), {
  browser: { used: true, errorCount: 0, errors: [] }
});
assert(
  failedGate.ok === false && failedGate.reason === 'browser_expect_failed',
  'failed expectation produces readiness note'
);
assert(/browser_expect/.test(failedGate.note) && failedGate.shouldRetry === false, 'expectation note is advisory only');

// 退出码只认结构化 result.code（summary 里的文本不算）
const exitTrace = [
  {
    round: 1,
    tools: [
      { name: 'fs_edit', toolArgs: { filePath: 'src/a.js' } },
      { name: 'host_exec', toolArgs: { command: 'npm test' }, summary: 'exit 0', result: { code: 1 } }
    ]
  }
];
const exitGate = readiness.evaluateReadiness(readiness.collectEvidence(exitTrace), {});
assert(
  exitGate.ok === false && exitGate.reason === 'validation_failed' && /exit 1/.test(exitGate.note),
  'validation failure reads structured exit code, not summary text'
);

console.log('test-guardrails-sync.cjs ok');

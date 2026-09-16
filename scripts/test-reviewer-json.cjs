'use strict';

const {
  extractReviewerJson,
  closeTruncatedJson,
  collectReviewerFileDiffs,
  compactReviewerDiffSnippet
} = require('../src/agent/reviewer-json');

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assert failed');
}

const truncated = `{"accepted":false,"acceptancePlan":["明确回答用户疑问：是否存在权限问题导致无法写代码","提供证据说明实际写入情况（如成功写入的文件清单）","给出结论与后续建议"],"reason":"finalReply 仅为'已完成。'，未回应用户关于权限/无法写代码的疑问，且缺少诊断证据支撑结论。","missing":["对用户问题的直接解答（是否为权限）"`;

const parsed = extractReviewerJson(truncated);
assert(parsed && parsed.accepted === false, 'truncated JSON should parse as accepted=false');
assert(String(parsed.reason || '').includes('已完成'), 'reason preserved');
assert(Array.isArray(parsed.missing) && parsed.missing.length >= 1, 'missing recovered');

const closed = closeTruncatedJson('{"a":[1,2');
assert(JSON.parse(closed).a[1] === 2, 'closeTruncatedJson arrays');

const fenced = extractReviewerJson('```json\n{"accepted":true,"reason":"ok","missing":[],"nextAction":"","acceptancePlan":[]}\n```');
assert(fenced && fenced.accepted === true, 'fenced json');

const files = collectReviewerFileDiffs(
  [{ path: 'src/a.js', diff: { added: 2, removed: 1, beforeSnippet: 'old', afterSnippet: 'new' } }],
  [{ tools: [{ toolArgs: { path: 'src/b.js' }, diff: { created: true, afterText: 'hello' } }] }]
);
assert(files.length === 2, 'collects session + trace files');
assert(files[0].path === 'src/a.js' && files[0].added === 2, 'session diff stats');
assert(String(files[0].diff).includes('--- before'), 'session snippet');
assert(files[1].path === 'src/b.js' && files[1].created === true, 'trace created file');
assert(compactReviewerDiffSnippet({ created: true, afterText: 'x' }).includes('new file'), 'created snippet');

console.log('ok reviewer-json truncated + fenced + file diffs');

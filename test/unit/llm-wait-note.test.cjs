'use strict';

/**
 * 「等模型」期间思考区那行备注的唯一文案来源（`llmWaitNoteText`）。
 *
 * 现场：`请求模型` 打勾之后要等上游首字，而那段等待**完全看不见** —— 占位符里虽然拼了
 * 「（已等 Ns）」，但 `visibleThoughtDisplay` 对 placeholder 行一律显示「思考中…」。
 * 2026-11-25 用户要求把这段说出来：「已请求模型，等待首字 Ns」。
 *
 * 两段等待各说各的：
 * - 首字之前，等满阈值 → `<前缀> Ns`（默认前缀就是「已请求模型，等待首字」）
 * - 首字之后静默 ≥ idle 阈值 → `上游 Ns 无数据`（原有行为，不改）
 * - 其余 → 空串（正常出字时不许加噪音）
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SOURCE = fs.readFileSync(
  path.join(__dirname, '..', '..', 'src', 'renderer', 'renderer-agent-rust-loop.js'),
  'utf8'
);

function extractFn(src, name) {
  const start = src.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `没找到 function ${name}`);
  const end = src.indexOf('\n}', start);
  assert.ok(end > start, `function ${name} 没闭合`);
  return src.slice(start, end + 2);
}

const note = new Function(
  `${extractFn(SOURCE, 'llmWaitNoteText')}
   return llmWaitNoteText;`
)();

const FIRST = 3000;
const IDLE = 30000;

test('首字之前：等满阈值才说，说的时候带秒数', () => {
  assert.equal(note({ streaming: false, waitingMs: 0, firstHintMs: FIRST }), '');
  assert.equal(note({ streaming: false, waitingMs: 2999, firstHintMs: FIRST }), '');
  assert.equal(
    note({ streaming: false, waitingMs: 3000, firstHintMs: FIRST }),
    '已请求模型，等待首字 3s'
  );
  assert.equal(
    note({ streaming: false, waitingMs: 33000, firstHintMs: FIRST }),
    '已请求模型，等待首字 33s'
  );
});

test('前缀可换（重连等待用另一句），且不会带出多余空格', () => {
  assert.equal(
    note({ streaming: false, waitingMs: 8000, notePrefix: '等待模型连接恢复，已等', firstHintMs: FIRST }),
    '等待模型连接恢复，已等 8s'
  );
});

test('首字之后：静默够久才说「上游 Ns 无数据」，正常出字时静默', () => {
  assert.equal(note({ streaming: true, idleMs: 1000, idleHintMs: IDLE }), '');
  assert.equal(note({ streaming: true, idleMs: 29999, idleHintMs: IDLE }), '');
  assert.equal(note({ streaming: true, idleMs: 42000, idleHintMs: IDLE }), '上游 42s 无数据');
});

test('首字之后不再冒「等待首字」（两段等待不许串台）', () => {
  const text = note({ streaming: true, idleMs: 500, waitingMs: 60000, firstHintMs: FIRST, idleHintMs: IDLE });
  assert.equal(text, '');
  assert.ok(!text.includes('等待首字'));
});

test('脏输入不炸：缺字段 / 负数 / 非数字一律当 0', () => {
  assert.equal(note(), '');
  assert.equal(note({}), '');
  assert.equal(note({ streaming: false, waitingMs: -5, firstHintMs: FIRST }), '');
  assert.equal(note({ streaming: false, waitingMs: 'abc', firstHintMs: FIRST }), '');
  assert.equal(note({ streaming: true, idleMs: -1, idleHintMs: IDLE }), '');
});

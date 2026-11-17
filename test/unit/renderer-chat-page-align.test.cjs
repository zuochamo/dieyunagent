'use strict';

/**
 * 一页历史不能切在某一轮中间：`alignRowsToTurnStart` 的回归。
 *
 * 判据只有一条 —— 窗口第一条必须是用户消息（界面上那就是一轮的开头，见
 * `renderer-chat-bubbles.js` 的 `.msg-turn`）。往前取到的那一批**只从其中最近的一条用户
 * 消息开始接**：多出来的更早行不要，否则「补几条对齐」会悄悄把一整批也塞进窗口。
 *
 * 浏览器脚本没有 module.exports，用 `new Function` 摘函数来验（手法同
 * `renderer-chat-load-mode.test.cjs`），取更早一页的实现从 `fetch` 注入。
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SOURCE = fs.readFileSync(
  path.join(__dirname, '..', '..', 'src', 'renderer', 'renderer-chat-history.js'),
  'utf8'
);

/** 从浏览器脚本里摘一个顶层函数（整文件 eval 要的桩太多）。`async` 前缀必须一起摘走。 */
function extractFn(src, name) {
  const start = src.indexOf(`async function ${name}(`);
  assert.ok(start >= 0, `没找到 async function ${name}`);
  const end = src.indexOf('\n}', start);
  assert.ok(end > start, `function ${name} 没闭合`);
  return src.slice(start, end + 2);
}

const build = new Function(
  'CHAT_TURN_ALIGN_FETCH',
  'CHAT_TURN_ALIGN_MAX_ROWS',
  'gatewayCallHistoryWithTimeout',
  `${extractFn(SOURCE, 'alignRowsToTurnStart')}
   return alignRowsToTurnStart;`
);

/**
 * @param {Array<object>} rows 这一页（旧 → 新）
 * @param {Array<Array<object>>} batches 每往前取一次返回什么
 */
function align(rows, batches, { fetchSize, exhausted, maxRows = 500 } = {}) {
  const calls = [];
  const fn = build(100, maxRows, () => {
    throw new Error('注入了 fetch，不该走 gateway');
  });
  const run = fn('s1', rows, {
    fetchSize,
    exhausted,
    fetch: async (beforeId, limit) => {
      calls.push({ beforeId, limit });
      const next = batches.shift();
      return next === undefined ? [] : next;
    }
  });
  return { run, calls };
}

const user = (id) => ({ id, role: 'user', content: 'q' });
const assistant = (id) => ({ id, role: 'assistant', content: 'a' });

test('头已经是用户消息 → 一条都不多取', async () => {
  const { run, calls } = align([user(10), assistant(11)], []);
  const { rows, exhausted } = await run;
  assert.deepEqual(rows.map((r) => r.id), [10, 11]);
  assert.equal(exhausted, false);
  assert.equal(calls.length, 0);
});

test('头落在轮中间 → 往前补到用户消息为止，行序仍是旧→新', async () => {
  const { run, calls } = align([assistant(105), assistant(106)], [[user(103), assistant(104)]], {
    fetchSize: 2
  });
  const { rows, exhausted } = await run;
  assert.equal(rows[0].role, 'user');
  assert.deepEqual(rows.map((r) => r.id), [103, 104, 105, 106]);
  assert.equal(exhausted, false);
  assert.deepEqual(calls, [{ beforeId: 105, limit: 2 }]);
});

test('一批里有多条用户消息 → 只从最近那条开始接（更早的不要）', async () => {
  const { run } = align([assistant(105)], [[user(100), assistant(101), user(102), assistant(103), assistant(104)]], {
    fetchSize: 5
  });
  const { rows } = await run;
  assert.deepEqual(rows.map((r) => r.id), [102, 103, 104, 105]);
  assert.equal(rows[0].role, 'user');
});

test('一轮很长、要补好几次才见到用户消息', async () => {
  const { run, calls } = align(
    [assistant(200)],
    [
      [assistant(198), assistant(199)],
      [user(196), assistant(197)]
    ],
    { fetchSize: 2 }
  );
  const { rows } = await run;
  assert.deepEqual(rows.map((r) => r.id), [196, 197, 198, 199, 200]);
  assert.equal(rows[0].role, 'user');
  assert.equal(calls.length, 2);
});

test('往前取到空 → 历史取尽', async () => {
  const { run } = align([assistant(50)], [], { fetchSize: 2 });
  const { rows, exhausted } = await run;
  assert.deepEqual(rows.map((r) => r.id), [50]);
  assert.equal(exhausted, true);
});

test('取到的不足一批 → 历史取尽', async () => {
  const { run } = align([assistant(50)], [[assistant(49)]], { fetchSize: 2 });
  const { exhausted } = await run;
  assert.equal(exhausted, true);
});

test('一轮太长（拉满上限）→ 接受不齐的头，不无限往前拉', async () => {
  const { run, calls } = align(
    [assistant(300)],
    [
      [assistant(298), assistant(299)],
      [assistant(296), assistant(297)],
      [assistant(294), assistant(295)]
    ],
    { fetchSize: 2, maxRows: 5 }
  );
  const { rows } = await run;
  assert.equal(rows[0].role, 'assistant');
  assert.equal(calls.length, 2);
});

test('空页不触发任何取数', async () => {
  const { run, calls } = align([], [[]]);
  const { rows, exhausted } = await run;
  assert.deepEqual(rows, []);
  assert.equal(exhausted, false);
  assert.equal(calls.length, 0);
});

test('已经取到会话开头就不再补', async () => {
  const { run, calls } = align([assistant(3)], [[user(1)]], { fetchSize: 2, exhausted: true });
  const { rows, exhausted } = await run;
  assert.deepEqual(rows.map((r) => r.id), [3]);
  assert.equal(exhausted, true);
  assert.equal(calls.length, 0);
});

test('不改动调用方传进来的数组', async () => {
  const page = [assistant(105)];
  const { run } = align(page, [[user(103), assistant(104)]], { fetchSize: 2 });
  await run;
  assert.deepEqual(page.map((r) => r.id), [105]);
});

'use strict';

/**
 * 切走会话时窗口留不留：`rememberSessionWindowOnLeave` 的回归。
 *
 * 规矩只有一条 —— **还停在首屏那一段才留**。翻过更早历史的会话直接丢（缓存 + 阅读位置），
 * 切回来重新读最近 32 条，回到首屏的样子；没翻过的照旧进缓存，频繁切换不用回源。
 *
 * 浏览器脚本没有 module.exports，用 `new Function` 摘函数来验（手法同
 * `renderer-chat-load-mode.test.cjs`）。
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SOURCE = fs.readFileSync(
  path.join(__dirname, '..', '..', 'src', 'renderer', 'renderer-chat-history.js'),
  'utf8'
);

/** 从浏览器脚本里摘一个顶层函数（整文件 eval 要的桩太多）。 */
function extractFn(src, name) {
  const start = src.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `没找到 function ${name}`);
  const end = src.indexOf('\n}', start);
  assert.ok(end > start, `function ${name} 没闭合`);
  return src.slice(start, end + 2);
}

const build = new Function(
  'messages',
  'messagesBelongToSession',
  'CHAT_INITIAL_LOAD_LIMIT',
  'invalidateSessionMessageCache',
  'clearSessionScrollPosition',
  'saveSessionMessageCache',
  'getSessionCacheHasMore',
  `${extractFn(SOURCE, 'rememberSessionWindowOnLeave')}
   return rememberSessionWindowOnLeave;`
);

function leave({ messageCount, belongs = true, sessionId = 's1', hasMore = true } = {}) {
  const calls = { invalidated: [], cleared: [], saved: [] };
  const fn = build(
    new Array(messageCount),
    () => belongs,
    32,
    (sid) => calls.invalidated.push(sid),
    (sid) => calls.cleared.push(sid),
    (sid, list, opts) => calls.saved.push({ sid, count: list.length, hasMore: opts && opts.hasMore }),
    () => hasMore
  );
  fn(sessionId);
  return calls;
}

test('翻过更早历史的窗口 → 缓存与阅读位置一起丢（切回来就是首屏）', () => {
  const calls = leave({ messageCount: 132 });
  assert.deepEqual(calls.invalidated, ['s1']);
  assert.deepEqual(calls.cleared, ['s1']);
  assert.equal(calls.saved.length, 0);
});

test('还停在首屏那一段 → 照旧进缓存（切换不用回源）', () => {
  const calls = leave({ messageCount: 32, hasMore: true });
  assert.equal(calls.invalidated.length, 0);
  assert.equal(calls.cleared.length, 0);
  assert.deepEqual(calls.saved, [{ sid: 's1', count: 32, hasMore: true }]);
});

test('messages 不属于这个会话 → 什么都不做（别把 A 的窗口存成 B 的）', () => {
  const calls = leave({ messageCount: 132, belongs: false });
  assert.equal(calls.invalidated.length + calls.cleared.length + calls.saved.length, 0);
});

test('空会话 id / 没有消息 → 什么都不做', () => {
  assert.equal(leave({ messageCount: 132, sessionId: '' }).invalidated.length, 0);
  assert.equal(leave({ messageCount: 0 }).saved.length, 0);
});

'use strict';

/**
 * 聊天区顶部「更早历史」那一行的状态回归：加载更早 / 正在加载 / 重新加载 / 已到会话开头。
 *
 * 这条状态决定用户到底看得见什么，所以这几件事必须成立：
 *   1. 还有更早的 → `more`（可点）；
 *   2. 正在取 → `loading`，而且只对**正在取的那个会话**成立（`loadingOlderChatMessages`
 *      是全局单飞，切了会话不能把状态挂在别人头上）；
 *   3. 上次失败 → `error`（只能显式重试，绝不能显示成「已到会话开头」）；
 *   4. 真的取完了 → `start`，需要「确实取到过会话开头」这个事实，不能拿 `hasMore === false`
 *      顶替 —— 那个标记挂在会话消息缓存上，缓存被作废（后台追加 / 一轮跑完）时会一起消失，
 *      而视图里那 100 条仍是个尾部窗口，那时宣布「已到会话开头」就是假话；
 *   5. 本来就几条的短对话，顶上不出现任何东西。
 *
 * 这些是浏览器脚本（没有 module.exports），用 `new Function` 摘函数来验，手法同
 * `renderer-chat-load-mode.test.cjs`。
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
  'gwState',
  'loadingOlderChatMessages',
  'loadingOlderSessionId',
  'chatOlderLoadErrors',
  'chatOlderExhaustedSessions',
  'getSessionCacheHasMore',
  'messages',
  'CHAT_INITIAL_LOAD_LIMIT',
  `${extractFn(SOURCE, 'chatHistoryEdgeMode')}
   return chatHistoryEdgeMode;`
);

function mode({
  authed = true,
  loading = false,
  loadingSession = '',
  errors = [],
  exhausted = [],
  hasMore = false,
  messageCount = 0,
  sessionId = 's1'
} = {}) {
  const fn = build(
    { authed },
    loading,
    loadingSession,
    new Map(errors.map((sid) => [sid, 'boom'])),
    new Set(exhausted),
    () => hasMore,
    new Array(messageCount),
    32
  );
  return fn(sessionId);
}

test('没有会话 / 未连上 Gateway 时不显示这一行', () => {
  assert.equal(mode({ sessionId: '' }), 'none');
  assert.equal(mode({ authed: false }), 'none');
});

test('还有更早的历史 → 可点的「加载更早」', () => {
  assert.equal(mode({ hasMore: true, messageCount: 32 }), 'more');
});

test('正在取历史 → loading（按钮禁用，不重复触发）', () => {
  assert.equal(mode({ loading: true, loadingSession: 's1', hasMore: true }), 'loading');
});

test('别的会话在取历史，当前会话不该显示「正在加载」', () => {
  assert.equal(mode({ loading: true, loadingSession: 'other', hasMore: true }), 'more');
});

test('上次失败 → error，不会被说成「已到会话开头」', () => {
  // 失败后 hasMore 仍是 true；哪怕窗口早已填满首页、哪怕记录过头，也必须显示成失败
  assert.equal(mode({ errors: ['s1'], hasMore: true, messageCount: 200 }), 'error');
  assert.equal(mode({ errors: ['s1'], exhausted: ['s1'], messageCount: 200 }), 'error');
});

test('另一个会话的失败不串到这个会话头上', () => {
  assert.equal(mode({ errors: ['other'], hasMore: true, messageCount: 32, sessionId: 's1' }), 'more');
});

test('取完了且窗口填满过首页 → 已到会话开头', () => {
  assert.equal(mode({ exhausted: ['s1'], messageCount: 32 }), 'start');
  assert.equal(mode({ exhausted: ['s1'], messageCount: 132 }), 'start');
});

test('缓存被作废（hasMore 丢了）但没真取到头 → 什么也不宣布', () => {
  assert.equal(mode({ hasMore: false, messageCount: 132 }), 'none');
});

test('本来就短的对话不宣布「已到会话开头」', () => {
  assert.equal(mode({ exhausted: ['s1'], messageCount: 5 }), 'none');
});

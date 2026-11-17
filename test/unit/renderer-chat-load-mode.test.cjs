'use strict';

/**
 * 「库里有、视图里没有」的回归（2026-11-13 现场：用户自己发的一句话从对话里消失了）。
 *
 * 现场链路：
 *   10:25:40 用户发信 → 视图里先乐观插入一条，落库是后台任务；
 *   10:27:27 对端回复落库，`renderer-peer.js` 要求强制回源；
 *   但这一轮还在跑（`sessionActiveRuns` 未结束），`loadChatFromGateway` 把「回源」
 *   降级成「沿用缓存快照」—— 而那份快照是**用户发信之前**存的（`isolateViewMessagesForSend`
 *   先渲染再 push 新 user 行），于是刚发的那句话连同对端回复一起从视图里消失了。
 *
 * 判据收敛成两件小事（都是纯函数/纯标记，不碰渲染）：
 *   1. `resolveChatLoadMode` —— 这次用「回源」还是「沿用缓存」的唯一判据；
 *   2. `markSessionCacheDiverged` / `isSessionCacheDiverged` —— 降级时记下「欠一次真回源」，
 *      本轮结束（`finalizeSendAgentRun`）补上。
 *
 * 这些是浏览器脚本（没有 module.exports），用 `new Function` + 极简 window 桩来验，
 * 手法同 `renderer-history-peer-rows.test.cjs`。
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const DIR = path.join(__dirname, '..', '..', 'src', 'renderer');
const HISTORY_SOURCE = fs.readFileSync(path.join(DIR, 'renderer-chat-history.js'), 'utf8');
const CACHE_SOURCE = fs.readFileSync(path.join(DIR, 'renderer-session-message-cache.js'), 'utf8');
const SEND_SOURCE = fs.readFileSync(path.join(DIR, 'renderer-agent-send.js'), 'utf8');

/** 从浏览器脚本里摘一个顶层函数（脚本没有导出，整文件 eval 要的桩太多）。 */
function extractFn(src, name) {
  const start = src.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `没找到 function ${name}`);
  const end = src.indexOf('\n}', start);
  assert.ok(end > start, `function ${name} 没闭合`);
  return src.slice(start, end + 2);
}

function loadCacheModule() {
  const factory = new Function(
    'window',
    `${CACHE_SOURCE}
     return {
       saveSessionMessageCache,
       getSessionMessageCache,
       invalidateSessionMessageCache,
       isSessionMessageCacheStale,
       clearSessionMessageCacheStale,
       markSessionCacheDiverged,
       isSessionCacheDiverged,
       clearSessionCacheDiverged
     };`
  );
  return factory({});
}

const cache = loadCacheModule();
const resolveChatLoadMode = new Function(
  `${extractFn(HISTORY_SOURCE, 'resolveChatLoadMode')}
   return resolveChatLoadMode;`
)();

function msg(id, role, content) {
  return { id, role, content, created_at: id };
}

test('没有缓存就去读库；库侧标记过期也必须读库', () => {
  assert.equal(resolveChatLoadMode({}), 'fresh');
  assert.equal(resolveChatLoadMode({ cached: false }), 'fresh');
  assert.equal(resolveChatLoadMode({ cached: true, cacheStale: true }), 'fresh');
});

test('没在跑、也没人要求回源：沿用缓存（切会话不重复打库）', () => {
  assert.equal(resolveChatLoadMode({ cached: true, activeRun: false }), 'cache');
  assert.equal(resolveChatLoadMode({ cached: true, activeRun: false, forceRefresh: true }), 'cache');
});

test('跑动中要求回源：先沿用缓存，但必须记账（cache-diverged）', () => {
  assert.equal(resolveChatLoadMode({ cached: true, activeRun: true, forceRefresh: true }), 'cache-diverged');
  // 没要求回源就不记账：这期间库里没多东西，缓存就是对的
  assert.equal(resolveChatLoadMode({ cached: true, activeRun: true }), 'cache');
});

test('欠过一次回源之后：下一次一定真读库（这是「我发的话消失」的止血点）', () => {
  assert.equal(resolveChatLoadMode({ cached: true, activeRun: true, diverged: true }), 'fresh');
  assert.equal(resolveChatLoadMode({ cached: true, diverged: true }), 'fresh');
});

test('现场时间线复演：跑动中对端回复落库 → 记欠回源 → 本轮结束必须回源', () => {
  const sid = 's-1793704927374-164dcfb8';
  // 10:25:38 缓存快照：只有对端上一轮回复，没有用户刚要发的那句话
  cache.saveSessionMessageCache(sid, [msg(7974, 'assistant', '…--send 等你点头再发。'), msg(7975, 'user', '【DIEYUN15 的回复】…')], {
    hasMore: true
  });
  assert.equal(cache.isSessionCacheDiverged(sid), false);

  // 10:27:27 对端回复（#7977）落库，peer 面板要求强制回源，但本轮还在跑
  const duringRun = resolveChatLoadMode({
    cached: !!cache.getSessionMessageCache(sid),
    activeRun: true,
    forceRefresh: true,
    diverged: cache.isSessionCacheDiverged(sid)
  });
  assert.equal(duringRun, 'cache-diverged');
  cache.markSessionCacheDiverged(sid);
  assert.equal(cache.isSessionCacheDiverged(sid), true, '降级那一刻必须记账，否则这几条永远不显示');

  // 跑动中又存了一次快照（仍缺那两条）：不许把「欠回源」抹掉
  cache.saveSessionMessageCache(sid, [msg(7974, 'assistant', '…'), msg(7975, 'user', '…')], { hasMore: true });
  assert.equal(cache.isSessionCacheDiverged(sid), true, '跑动中存快照不能清账');

  // 本轮结束（finalizeSendAgentRun）：下一次加载必须回源
  assert.equal(
    resolveChatLoadMode({
      cached: !!cache.getSessionMessageCache(sid),
      activeRun: false,
      diverged: cache.isSessionCacheDiverged(sid)
    }),
    'fresh'
  );

  // 真回源成功后清账，回到普通缓存语义
  cache.clearSessionCacheDiverged(sid);
  assert.equal(cache.isSessionCacheDiverged(sid), false);
  assert.equal(
    resolveChatLoadMode({ cached: !!cache.getSessionMessageCache(sid), diverged: cache.isSessionCacheDiverged(sid) }),
    'cache'
  );
});

test('库里没有缓存行时不会被当成「欠回源」（空快照不算权威）', () => {
  const sid = 's-empty';
  assert.equal(cache.getSessionMessageCache(sid), null);
  assert.equal(resolveChatLoadMode({ cached: !!cache.getSessionMessageCache(sid) }), 'fresh');
});

test('跑动结束的收敛点确实挂在 finalizeSendAgentRun 上（不是别处顺手加的）', () => {
  const body = extractFn(SEND_SOURCE, 'finalizeSendAgentRun');
  assert.match(body, /isSessionCacheDiverged/);
  assert.match(body, /loadChatFromGateway\(null, runSessionId, \{ forceRefresh: true \}\)/);
  // 必须在 finishSessionActiveRun 之后：否则 activeRun 还是 true，回源又会被降级
  assert.ok(body.indexOf('finishSessionActiveRun') < body.indexOf('isSessionCacheDiverged'));
});

'use strict';

global.window = global.window || {};
global.unpackUserMessageContent = (raw) => ({ content: String(raw || ''), meta: null });
require('../src/renderer/renderer-session-message-cache');

const saveSessionMessageCache = window.saveSessionMessageCache;
const getSessionMessageCache = window.getSessionMessageCache;
const invalidateSessionMessageCache = window.invalidateSessionMessageCache;
const isSessionMessageCacheStale = window.isSessionMessageCacheStale;
const clearSessionMessageCacheStale = window.clearSessionMessageCacheStale;

function testStaleFlagLifecycle() {
  saveSessionMessageCache('s1', [{ role: 'user', content: 'hi' }], { hasMore: false });
  if (isSessionMessageCacheStale('s1')) throw new Error('fresh cache should not be stale');
  invalidateSessionMessageCache('s1');
  if (getSessionMessageCache('s1')) throw new Error('cache should be cleared');
  if (!isSessionMessageCacheStale('s1')) throw new Error('expected stale after invalidate');
  saveSessionMessageCache('s1', [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'ok' }]);
  if (isSessionMessageCacheStale('s1')) throw new Error('save should clear stale');
  clearSessionMessageCacheStale('s1');
  console.log('ok session message cache stale lifecycle');
}

testStaleFlagLifecycle();
console.log('\nsession-message-cache-stale: ALL OK');

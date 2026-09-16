'use strict';

const { normalizeUpdateFeedUrl, getUpdateFeedCandidates } = require('../src/main/app-updater');

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assert failed');
}

assert(normalizeUpdateFeedUrl('http://a.example/upd') === 'http://a.example/upd/', 'slash appended');
assert(normalizeUpdateFeedUrl('http://a.example/upd/') === 'http://a.example/upd/', 'already slashed');
assert(normalizeUpdateFeedUrl('') === '/', 'empty becomes slash');

const dual = getUpdateFeedCandidates('http://lan/u', 'https://cos/u');
assert(dual.length === 2, 'primary+fallback');
assert(dual[0] === 'http://lan/u/', 'primary first');
assert(dual[1] === 'https://cos/u/', 'fallback second');

const same = getUpdateFeedCandidates('http://x/u/', 'http://x/u');
assert(same.length === 1, 'dedupe same feed');

console.log('test-app-updater-feeds.cjs ok');

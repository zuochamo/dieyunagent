'use strict';

const {
  describeRemoteGatewayPack,
  endpointKeyFromScope,
  invalidateRemoteAgentsForScope
} = require('../src/main/workspace-remote-runtime');

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assert failed');
}

assert(endpointKeyFromScope('host|path') === 'host', 'split first segment');
assert(endpointKeyFromScope('host') === 'host', 'no pipe');
assert(endpointKeyFromScope('') === '', 'empty');

const hits = [];
const pool = {
  getStatusSummary: () => [
    { targetKey: 'h1', info: { url: 'a' } },
    { targetKey: 'h2', info: { url: 'b' } },
    { targetKey: 'h1', info: null }
  ]
};
invalidateRemoteAgentsForScope(pool, 'h1|/proj', (info) => hits.push(info));
assert(hits.length === 1 && hits[0].url === 'a', 'match host key only with info');

const globalHits = [];
invalidateRemoteAgentsForScope(null, 'h1|/proj', () => globalHits.push('g'));
assert(globalHits.length === 1, 'no pool → global invalidate');

const noScope = [];
invalidateRemoteAgentsForScope(pool, '', () => noScope.push('g'));
assert(noScope.length === 1, 'empty scope → global invalidate');

const files = new Map([
  ['P/manifest.json', JSON.stringify({ lite: true, entry: 'remote/run-cli.js' })],
  ['P/remote/run-cli.js', 'ok']
]);
const liteFs = {
  existsSync: (p) => files.has(String(p).replace(/\\/g, '/')),
  readFileSync: (p) => files.get(String(p).replace(/\\/g, '/')),
  statSync: () => ({ size: 1 })
};
const lite = describeRemoteGatewayPack('P', liteFs);
assert(lite.ok && lite.detail.includes('lite'), 'lite pack is ready without bin/node');

const missing = describeRemoteGatewayPack('P', {
  existsSync: () => false,
  readFileSync: () => '',
  statSync: () => ({ size: 0 })
});
assert(!missing.ok, 'missing manifest is not ready');

console.log('test-workspace-remote-runtime.cjs ok');

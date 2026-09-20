'use strict';

const {
  describeRemoteGatewayPack,
  endpointKeyFromScope,
  invalidateRemoteAgentsForScope
} = require('../src/main/workspace-remote-runtime');
const {
  REMOTE_PACK_OK_MARKER,
  REMOTE_PACK_REQUIRED_FILES,
  REMOTE_DEPLOY_REQUIRED_FILES,
  inspectRemotePack,
  parseRemotePackMissing,
  parseRemotePackState,
  evaluateRemotePackPreflight
} = require('../src/remote/remote-pack-layout');

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assert failed');
}

function fakeFs(entries) {
  const key = (p) => String(p).replace(/\\/g, '/');
  const files = new Map(Object.entries(entries).map(([k, v]) => [key(k), v]));
  return {
    existsSync: (p) => files.has(key(p)),
    readFileSync: (p) => files.get(key(p)),
    statSync: (p) => {
      if (!files.has(key(p))) {
        const err = new Error(`ENOENT: ${p}`);
        err.code = 'ENOENT';
        throw err;
      }
      return { size: 1, isFile: () => true };
    }
  };
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

const liteEntries = {};
for (const rel of REMOTE_PACK_REQUIRED_FILES) liteEntries[`P/${rel}`] = 'ok';
liteEntries['P/manifest.json'] = JSON.stringify({ lite: true, entry: 'remote/run-cli.js' });
const lite = describeRemoteGatewayPack('P', fakeFs(liteEntries));
assert(lite.ok && lite.detail.includes('lite'), 'lite pack is ready without bin/node');

// electron-builder 会剔除 pack 根 node_modules，远程注入因此报「安装包不完整」：
// 缺 ws 的 lite 包不能报 ok。
const noWsEntries = { ...liteEntries };
delete noWsEntries['P/node_modules/ws/package.json'];
const noWs = describeRemoteGatewayPack('P', fakeFs(noWsEntries));
assert(!noWs.ok && noWs.detail.includes('node_modules/ws/package.json'), 'lite pack without ws is not ready');

// 部署包（lite 包 + 内置 Node）清单包含 bin/node
const deployEntries = {};
for (const rel of REMOTE_DEPLOY_REQUIRED_FILES) deployEntries[`P/${rel}`] = 'ok';
deployEntries['P/manifest.json'] = JSON.stringify({ lite: false });
assert(inspectRemotePack('P', { deploy: true, fsApi: fakeFs(deployEntries) }).ok, 'deploy pack with bin/node is ready');
const noNodeEntries = { ...deployEntries };
delete noNodeEntries['P/bin/node'];
const noNode = inspectRemotePack('P', { deploy: true, fsApi: fakeFs(noNodeEntries) });
assert(!noNode.ok && noNode.missing.join(',') === 'bin/node', 'deploy pack without bin/node reports bin/node');

const missing = describeRemoteGatewayPack('P', {
  existsSync: () => false,
  readFileSync: () => '',
  statSync: () => ({ size: 0 })
});
assert(!missing.ok, 'missing manifest is not ready');

// 远程 preflight 输出解析：脚本一定会打印 MISSING= 行，成功标记必须单独判定
// （曾经的回归：整段输出与 'OK' 全等比较，把 "MISSING=\nOK" 误判为不完整）
const okOut = `MISSING=\n${REMOTE_PACK_OK_MARKER}\n`;
const okEval = evaluateRemotePackPreflight(okOut, 0);
assert(okEval.ok && okEval.missing.length === 0, 'empty MISSING + PACK_OK is a pass');
const missEval = evaluateRemotePackPreflight(
  'MISSING= node_modules/ws/package.json\nls output\n',
  1
);
assert(!missEval.ok && missEval.missing[0] === 'node_modules/ws/package.json', 'missing entry fails preflight');
assert(!evaluateRemotePackPreflight('DIR_MISSING\n', 1).ok, 'missing dir fails preflight');
assert(!evaluateRemotePackPreflight('', 0).ok, 'empty output is not a pass');

const state = parseRemotePackState('MISSING=\nVERSION=0.1.41\nSIZE=12345\nHASH=abc123\n');
assert(state.version === '0.1.41' && state.size === 12345 && state.hash === 'abc123', 'parse remote pack state');
assert(state.missing.length === 0, 'state without missing entries');
assert(parseRemotePackMissing('no markers here').length === 0, 'no MISSING line → no missing entries');
assert(parseRemotePackState('SIZE=abc\n').size === 0, 'invalid SIZE falls back to 0');

console.log('test-workspace-remote-runtime.cjs ok');

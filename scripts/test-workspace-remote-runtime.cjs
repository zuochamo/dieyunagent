'use strict';

const {
  describeRemoteGatewayPack,
  endpointKeyFromScope,
  invalidateRemoteAgentsForScope
} = require('../src/main/workspace-remote-runtime');
const {
  REMOTE_PACK_OK_MARKER,
  REMOTE_PACK_REQUIRED_FILES,
  inspectRemotePack,
  parseRemotePackMissing,
  parseRemotePackMarker,
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

const fullEntries = {};
for (const rel of REMOTE_PACK_REQUIRED_FILES) fullEntries[`P/${rel}`] = 'ok';
fullEntries['P/manifest.json'] = JSON.stringify({ entry: 'remote/run-cli.js' });
const full = describeRemoteGatewayPack('P', fakeFs(fullEntries));
assert(full.ok, 'complete pack (with bundled node) is ready');

// electron-builder 会剔除 pack 根 node_modules，远程注入因此报「安装包不完整」：
// 缺 ws 的包不能报 ok。
const noWsEntries = { ...fullEntries };
delete noWsEntries['P/node_modules/ws/package.json'];
const noWs = describeRemoteGatewayPack('P', fakeFs(noWsEntries));
assert(!noWs.ok && noWs.detail.includes('node_modules/ws/package.json'), 'pack without ws is not ready');

// 内置 Node 随安装包预装：缺 bin/node 的包既不能显示 ready，也不能通过注入清单。
const noNodeEntries = { ...fullEntries };
delete noNodeEntries['P/bin/node'];
const noNode = describeRemoteGatewayPack('P', fakeFs(noNodeEntries));
assert(!noNode.ok && noNode.detail.includes('内置 Node'), 'pack without bin/node is not ready');
const noNodeCheck = inspectRemotePack('P', { fsApi: fakeFs(noNodeEntries) });
assert(!noNodeCheck.ok && noNodeCheck.missing.join(',') === 'bin/node', 'inspectRemotePack requires bin/node');

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

// 跳过重传的判定只认 .pack-ok 标记：VERSION / CONTENT_HASH 两行，按行锚定
const markerHash = 'a'.repeat(64);
const marker = parseRemotePackMarker(`VERSION=0.1.41\nCONTENT_HASH=${markerHash}\n`);
assert(marker.version === '0.1.41', 'parse marker version');
assert(marker.contentHash === markerHash, 'parse marker content hash (64 hex)');
assert(parseRemotePackMarker('no markers').version === '', 'no marker lines → empty');
assert(
  parseRemotePackMarker('CONTENT_HASH=short\n').contentHash === '',
  '非 64 位 hex 的 hash 行不算数'
);
assert(parseRemotePackMissing('no markers here').length === 0, 'no MISSING line → no missing entries');

console.log('test-workspace-remote-runtime.cjs ok');

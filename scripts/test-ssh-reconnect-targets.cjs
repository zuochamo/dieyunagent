'use strict';

const path = require('path');
const { collectSshReconnectTargets } = require('../src/ssh/reconnect');
const { getRemoteGatewayPackRoot } = require('../src/main/remote-gateway');

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assert failed');
}

const a = { kind: 'ssh', host: 'h1', port: 22, username: 'u', remotePath: '/home/u' };
const aDup = { kind: 'ssh', host: 'h1', port: 22, username: 'u', remotePath: '/home/u/' };
const b = { kind: 'ssh', host: 'h1', port: 22, username: 'u', remotePath: '/opt/app' };
const local = { kind: 'local', path: 'D:\\proj' };

assert(collectSshReconnectTargets(null, null).length === 0, 'empty');
assert(collectSshReconnectTargets(local, [a]).length === 1, 'skip local view, keep leased');

const merged = collectSshReconnectTargets(a, [aDup, b, local]);
assert(merged.length === 2, 'dedupe same host+path, keep other path');
assert(merged[0].remotePath === '/home/u' || merged[0].remotePath === '/home/u/', 'view first');
assert(
  merged.some((t) => String(t.remotePath || '').replace(/\\/g, '/').includes('opt')),
  'second target kept'
);

const unpack = getRemoteGatewayPackRoot({ isPackaged: false }).replace(/\\/g, '/');
assert(unpack.endsWith('build/remote-gateway-pack'), `unpack pack root: ${unpack}`);

const prevRes = process.resourcesPath;
process.resourcesPath = path.join('C:', 'app', 'resources');
try {
  const packed = getRemoteGatewayPackRoot({ isPackaged: true }).replace(/\\/g, '/');
  assert(packed.endsWith('resources/remote-gateway-pack') || packed.includes('remote-gateway-pack'), packed);
} finally {
  process.resourcesPath = prevRes;
}

console.log('test-ssh-reconnect-targets.cjs ok');

'use strict';

const path = require('path');
const { collectSshReconnectEntries } = require('../src/ssh/reconnect');
const { getRemoteGatewayPackRoot } = require('../src/main/remote-gateway');

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assert failed');
}

const a = { kind: 'ssh', host: 'h1', port: 22, username: 'u', remotePath: '/home/u' };
const aDup = { kind: 'ssh', host: 'h1', port: 22, username: 'u', remotePath: '/home/u/' };
const b = { kind: 'ssh', host: 'h1', port: 22, username: 'u', remotePath: '/opt/app' };
const local = { kind: 'local', path: 'D:\\proj' };

assert(collectSshReconnectEntries(null, null).length === 0, 'empty');
assert(collectSshReconnectEntries({ target: local }, [{ target: a }]).length === 1, 'skip local view, keep leased');

const merged = collectSshReconnectEntries({ target: a, sessionId: 'sA' }, [
  { target: aDup, sessionId: 'sA' },
  { target: b, sessionId: 'sB' },
  { target: local, sessionId: '' }
]);
assert(merged.length === 2, 'dedupe same host+path, keep other path');
assert(merged[0].target.remotePath === '/home/u' || merged[0].target.remotePath === '/home/u/', 'view first');
assert(merged[0].sessionId === 'sA', 'view entry keeps its session id');
assert(
  merged.some((e) => String(e.target.remotePath || '').replace(/\\/g, '/').includes('opt') && e.sessionId === 'sB'),
  'second target kept together with its session id'
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

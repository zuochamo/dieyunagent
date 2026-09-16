'use strict';

const { createTerminalPool } = require('../src/terminal/terminal-pool');

function testDetachKeepsSessionAlive() {
  const pool = createTerminalPool({ maxEntries: 4 });
  let killed = false;
  pool.register(
    'sess-a',
    {
      write: () => {},
      kill: () => {
        killed = true;
      }
    },
    { kind: 'local', remote: false }
  );

  const chunks = [];
  pool.attach('sess-a', { onData: (t) => chunks.push(t) });
  pool.routeData('sess-a', 'hello');
  if (chunks.join('') !== 'hello') throw new Error('expected attached output');

  pool.detach('sess-a');
  pool.routeData('sess-a', ' bg');
  if (killed) throw new Error('detach should not kill PTY');
  if (chunks.length !== 1) throw new Error('detached session should buffer output');

  pool.attach('sess-a', { onData: (t) => chunks.push(t) });
  if (!chunks.join('').includes(' bg')) throw new Error('expected buffered output on reattach');
  console.log('ok terminal pool detach keeps session alive');
}

function testKillForRemoteEndpoint() {
  const pool = createTerminalPool({ maxEntries: 4 });
  let killedA = false;
  pool.register(
    'sess-a',
    { write: () => {}, kill: () => { killedA = true; } },
    { kind: 'ssh', endpointKey: 'u@h:22' }
  );
  pool.register(
    'sess-b',
    { write: () => {}, kill: () => {} },
    { kind: 'local', endpointKey: 'local' }
  );
  pool.killForRemoteEndpoint('u@h:22', 'ssh');
  if (!killedA) throw new Error('expected ssh terminal killed for endpoint');
  if (!pool.getEntry('sess-b')) throw new Error('local terminal should remain');
  console.log('ok terminal pool killForRemoteEndpoint');
}

function testEvictOverCap() {
  const pool = createTerminalPool({ maxEntries: 2 });
  pool.register('a', { write: () => {}, kill: () => {} }, {});
  pool.register('b', { write: () => {}, kill: () => {} }, {});
  pool.register('c', { write: () => {}, kill: () => {} }, {});
  const ids = pool.listSessionIds();
  if (ids.length > 2) throw new Error('expected evict over cap');
  console.log('ok terminal pool evict over cap');
}

function main() {
  testDetachKeepsSessionAlive();
  testKillForRemoteEndpoint();
  testEvictOverCap();
  console.log('\nterminal-pool: ALL OK');
}

main();

'use strict';

function mockManager(id) {
  let connected = false;
  let identity = { host: 'h', port: 22, username: 'u' };
  return {
    id,
    status: () => ({
      connected,
      host: identity.host,
      port: identity.port,
      username: identity.username
    }),
    connect: async (payload) => {
      connected = true;
      if (payload) {
        identity = {
          host: payload.host || identity.host,
          port: Number(payload.port) || identity.port,
          username: payload.username || identity.username
        };
      }
    },
    disconnect: async () => {
      connected = false;
    }
  };
}

let mgrSeq = 0;
const sessionManagerMod = require('../src/ssh/session-manager');
const origCreate = sessionManagerMod.createSshSessionManager;
sessionManagerMod.createSshSessionManager = () => mockManager(++mgrSeq);

const { createSshConnectionPool } = require('../src/ssh/connection-pool');

async function testTwoTargetsParallel() {
  const pool = createSshConnectionPool({ maxConnections: 4 });
  const targetA = { kind: 'ssh', host: 'host-a', port: 22, username: 'u1', remotePath: '/a' };
  const targetB = { kind: 'ssh', host: 'host-b', port: 22, username: 'u2', remotePath: '/b' };

  await pool.connect(targetA, { host: 'host-a', port: 22, username: 'u1' });
  await pool.connect(targetB, { host: 'host-b', port: 22, username: 'u2' });

  if (!pool.isConnected(targetA) || !pool.isConnected(targetB)) {
    throw new Error('both targets should be connected');
  }
  const ma = pool.getManagerForTarget(targetA);
  const mb = pool.getManagerForTarget(targetB);
  if (!ma || !mb || ma.id === mb.id) {
    throw new Error('targets should use distinct managers');
  }

  pool.release(targetA);
  pool.release(targetB);
  await pool.disconnectTarget(targetB);
  if (pool.isConnected(targetB)) {
    throw new Error('target B should be disconnected');
  }
  if (!pool.isConnected(targetA)) {
    throw new Error('target A should remain connected');
  }
  pool.acquire(targetA);
  await pool.disconnectTarget(targetA);
  if (!pool.isConnected(targetA)) {
    throw new Error('target A should not disconnect while refCount > 0 without force');
  }
  await pool.disconnectTarget(targetA, { force: true });
  if (pool.isConnected(targetA)) {
    throw new Error('target A should force disconnect');
  }

  console.log('ok ssh connection pool parallel targets');
}

async function testSameHostDifferentPaths() {
  const pool = createSshConnectionPool({ maxConnections: 8 });
  const targetA = { kind: 'ssh', host: 'host-x', port: 22, username: 'u', remotePath: '/proj-a' };
  const targetB = { kind: 'ssh', host: 'host-x', port: 22, username: 'u', remotePath: '/proj-b' };

  await pool.connect(targetA, { host: 'host-x', port: 22, username: 'u' });
  await pool.connect(targetB, { host: 'host-x', port: 22, username: 'u' });

  const ma = pool.getManagerForTarget(targetA);
  const mb = pool.getManagerForTarget(targetB);
  if (!ma || !mb || ma.id === mb.id) {
    throw new Error('same host different paths should use distinct managers');
  }
  if (!pool.isConnected(targetA) || !pool.isConnected(targetB)) {
    throw new Error('both paths should be connected');
  }

  await pool.disconnectTarget(targetA);
  if (!pool.isConnected(targetB)) {
    throw new Error('path B should stay connected when path A disconnects');
  }
  await pool.disconnectTarget(targetB, { force: true });
  console.log('ok ssh same host different paths parallel');
}

async function testConnectDoesNotLeakRef() {
  const pool = createSshConnectionPool({ maxConnections: 4 });
  const target = { kind: 'ssh', host: 'host-a', port: 22, username: 'u1', remotePath: '/' };
  await pool.connect(target, { host: 'host-a', port: 22, username: 'u1' });
  await pool.disconnectTarget(target);
  if (pool.isConnected(target)) {
    throw new Error('UI connect() must not pin refCount; disconnectTarget should drop idle slot');
  }
  console.log('ok ssh connect does not leak refCount');
}

async function testEndpointFallbackAndLastConnected() {
  const pool = createSshConnectionPool({ maxConnections: 8 });
  const pathA = { kind: 'ssh', host: 'host-x', port: 22, username: 'u', remotePath: '/' };
  const pathB = { kind: 'ssh', host: 'host-x', port: 22, username: 'u', remotePath: '/proj' };
  const other = { kind: 'ssh', host: 'host-y', port: 22, username: 'u', remotePath: '/' };

  await pool.connect(pathA, { host: 'host-x', port: 22, username: 'u' });
  const shared = pool.getConnectedManagerForEndpoint(pathB);
  const exact = pool.getManagerForTarget(pathA);
  if (!shared || shared !== exact) {
    throw new Error('same host different path should reuse connected manager');
  }

  await pool.connect(other, { host: 'host-y', port: 22, username: 'u' });
  const last = pool.getLastConnectedManager();
  if (!last || last.status().host !== 'host-y') {
    throw new Error('last connected should prefer newest host');
  }

  let view = { kind: 'local', path: 'C:/tmp' };
  const facade = pool.createFacade(() => (view.kind === 'ssh' ? view : null));
  if (!facade.status().connected) {
    throw new Error('facade should use last connected SSH while workspace is still local');
  }
  view = pathB;
  if (!facade.status().connected) {
    throw new Error('facade should stay connected after workspace path changes on same host');
  }

  await pool.disconnectEndpoint(pathB, { force: true });
  if (pool.isConnected(pathA) || pool.isConnected(pathB)) {
    throw new Error('disconnectEndpoint should drop all slots for that host');
  }
  console.log('ok ssh endpoint fallback + last connected');
}

function testSftpBrowseHelpers() {
  const { sftpEntryIsDirectory, mapSftpDirEntries, formatSftpBrowseError } = require('../src/ssh/session-manager');
  if (!sftpEntryIsDirectory({ attrs: { mode: 0o040755 } })) {
    throw new Error('dir mode should be directory');
  }
  if (sftpEntryIsDirectory({ attrs: { mode: 0o100644 } })) {
    throw new Error('file mode should not be directory');
  }
  if (!sftpEntryIsDirectory({ longname: 'drwxr-xr-x 1 u g 0 Jan 1 dir' })) {
    throw new Error('longname d prefix should be directory');
  }
  const mapped = mapSftpDirEntries([
    { filename: '.', attrs: { mode: 0o040755, size: 0, mtime: 0 } },
    { filename: 'src', attrs: { mode: 0o040755, size: 0, mtime: 1 } },
    { filename: 'a.txt', attrs: { mode: 0o100644, size: 3, mtime: 2 } }
  ]);
  if (mapped.length !== 2 || !mapped[0].isDirectory || mapped[1].name !== 'a.txt') {
    throw new Error('mapSftpDirEntries should skip . and sort dirs first');
  }
  const err = formatSftpBrowseError({ code: 3, message: 'Permission denied' }, '/');
  if (!/没有权限/.test(err.message)) {
    throw new Error('permission denied should map to Chinese hint');
  }
  console.log('ok sftp browse helpers');
}

async function main() {
  try {
    await testTwoTargetsParallel();
    await testSameHostDifferentPaths();
    await testConnectDoesNotLeakRef();
    await testEndpointFallbackAndLastConnected();
    testSftpBrowseHelpers();
    console.log('\nssh-connection-pool: ALL OK');
  } finally {
    sessionManagerMod.createSshSessionManager = origCreate;
  }
}

main().catch((e) => {
  console.error('FAIL:', e.message || e);
  process.exit(1);
});

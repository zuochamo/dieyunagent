'use strict';

const path = require('path');
const {
  remoteIndexCacheKey,
  remoteAgentInfoKey,
  workspaceStoreKey
} = require('../src/workspace/workspace-cache-keys');
const {
  createGraphIncrementalScheduler,
  isUnderWorkspaceRoot
} = require('../src/graph/graph-incremental-scheduler');

function testRemoteIndexCacheKeySeparatesWorkspaces() {
  const info = { url: 'ws://127.0.0.1:19001', token: 'abc' };
  const a = remoteIndexCacheKey(info, '/home/user/proj-a');
  const b = remoteIndexCacheKey(info, '/home/user/proj-b');
  if (a === b) throw new Error('expected different cache keys for different workspace roots');
  if (!a.startsWith(remoteAgentInfoKey(info))) {
    throw new Error('cache key should include agent base key');
  }
  console.log('ok remote index cache key separates workspaces');
}

function testWorkspaceStoreKeyNormalizes() {
  const a = workspaceStoreKey('D:\\repo\\a');
  const b = workspaceStoreKey('D:/repo/a/');
  if (a !== b) throw new Error('expected normalized local workspace store keys to match');
  const unix = workspaceStoreKey('/var/www/app');
  if (unix !== '/var/www/app') throw new Error('expected unix workspace store key');
  console.log('ok workspace store key normalizes');
}

function testGraphIncrementalUsesExplicitWorkspaceRoot() {
  const invoked = [];
  const scheduler = createGraphIncrementalScheduler({
    userDataPath: path.join(__dirname, '..', 'nonexistent-userdata'),
    getWorkspaceRoot: () => 'D:\\wrong-root',
    isRemoteWorkspace: () => true,
    invokeRustCore: async (method, params) => {
      invoked.push({ method, params });
      if (method === 'codebase.status') return { indexing: false };
      if (method === 'graph.status') return { indexed: true, indexing: false };
      return { ok: true };
    },
    debounceMs: 5
  });

  const file = path.join('D:\\agent-root', 'src', 'index.ts');
  scheduler.notifyFileSaved(file, 'D:\\agent-root');

  return new Promise((resolve, reject) => {
    setTimeout(() => {
      try {
        if (!invoked.some((row) => row.method === 'graph.index.start')) {
          throw new Error('expected graph.index.start for explicit workspace root despite remote UI');
        }
        const idx = invoked.find((row) => row.method === 'graph.index.start');
        if (path.resolve(idx.params.workspaceRoot) !== path.resolve('D:\\agent-root')) {
          throw new Error('graph.index.start used wrong workspace root');
        }
        console.log('ok graph incremental uses explicit workspace root');
        resolve();
      } catch (err) {
        reject(err);
      }
    }, 40);
  });
}

function testIsUnderWorkspaceRoot() {
  const root = path.resolve('D:\\repo');
  const inside = path.join(root, 'src', 'a.ts');
  if (!isUnderWorkspaceRoot(inside, root)) throw new Error('expected file under workspace root');
  if (isUnderWorkspaceRoot('D:\\other\\a.ts', root)) throw new Error('expected outside file rejected');
  console.log('ok isUnderWorkspaceRoot');
}

async function main() {
  testRemoteIndexCacheKeySeparatesWorkspaces();
  testWorkspaceStoreKeyNormalizes();
  testIsUnderWorkspaceRoot();
  await testGraphIncrementalUsesExplicitWorkspaceRoot();
  console.log('\nworkspace-cache-isolation: ALL OK');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

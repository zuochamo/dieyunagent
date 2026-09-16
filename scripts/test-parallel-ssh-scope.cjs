'use strict';

const { LocalGateway } = require('../src/gateway/server');
const { createRpcHandlers } = require('../src/gateway/rpc');
const fs = require('fs');
const os = require('os');
const path = require('path');

async function testInvokeRpcScopesBySessionId() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dieyun-scope-'));
  const gw = new LocalGateway({
    userDataPath: tmp,
    readableDir: tmp,
    getRemoteAgentInfo: () => null
  });

  const pathA = 'ssh://u@h1:22/proj-a';
  const pathB = 'ssh://u@h1:22/proj-b';
  gw.setSessionWorkspaceContext('sess-a', pathA);
  gw.setSessionWorkspaceContext('sess-b', pathB);
  gw.setActiveSession('sess-view');
  gw.setSessionWorkspaceContext('sess-view', pathA);

  gw.start();
  const rpcBundle = createRpcHandlers({
    allowedReadRoots: [tmp],
    writableRoots: [tmp],
    permissions: gw.getPermissions(),
    defaultCwd: tmp,
    sql: null,
    plugins: gw.plugins,
    getEmbeddingConfig: () => ({}),
    ssh: null,
    getWorkspaceTarget: () => gw.getWorkspaceTarget(),
    getSessionWorkspaceTarget: (sid) => gw.getSessionWorkspaceTarget(sid),
    getRemoteAgentInfo: () => null,
    userDataPath: tmp,
    turnUndo: gw.turnUndo
  });
  gw.handlers = rpcBundle.handlers;
  gw._runWithCallContext = rpcBundle.runWithCallContext;

  const { AsyncLocalStorage } = require('async_hooks');
  const probeAls = new AsyncLocalStorage();
  gw._runWithCallContext = (ctx, fn) =>
    rpcBundle.runWithCallContext(ctx, () => probeAls.run(ctx, fn));

  gw.handlers['scope.resolve'] = async () => {
    const ctx = probeAls.getStore() || {};
    const runWorkspaceRoot =
      ctx.runWorkspaceRoot != null && String(ctx.runWorkspaceRoot).trim()
        ? String(ctx.runWorkspaceRoot).trim()
        : null;
    const callSessionId =
      ctx.sessionId != null && String(ctx.sessionId).trim() ? String(ctx.sessionId).trim() : null;
    const { parseWorkspaceInput } = require('../src/workspace/target');
    if (runWorkspaceRoot) return parseWorkspaceInput(runWorkspaceRoot);
    if (callSessionId) return gw.getSessionWorkspaceTarget(callSessionId);
    return gw.getWorkspaceTarget();
  };

  const forA = await gw.invokeRpc('scope.resolve', { sessionId: 'sess-a' });
  const forB = await gw.invokeRpc('scope.resolve', { sessionId: 'sess-b' });
  const activeWhileB = gw.getEffectiveWorkspaceTarget();

  gw.stop();

  if (!forA || forA.remotePath !== '/proj-a') {
    throw new Error(`sess-a scope failed: ${JSON.stringify(forA)}`);
  }
  if (!forB || forB.remotePath !== '/proj-b') {
    throw new Error(`sess-b scope failed: ${JSON.stringify(forB)}`);
  }
  if (!activeWhileB || activeWhileB.remotePath !== '/proj-a') {
    throw new Error('active view must stay on sess-view path during background sess-b RPC');
  }
  console.log('ok invokeRpc scopes by sessionId on same host');
}

async function testBindOnlyPreservesActiveSession() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dieyun-bind-'));
  const gw = new LocalGateway({
    userDataPath: tmp,
    readableDir: tmp,
    getRemoteAgentInfo: () => null
  });
  gw.setSessionWorkspaceContext('sess-view', 'ssh://u@h1:22/view-path');
  gw.setActiveSession('sess-view');

  gw.setSessionWorkspaceContext('sess-bg', 'ssh://u@h1:22/bg-path');
  if (gw.activeSessionId !== 'sess-view') {
    throw new Error('setSessionWorkspaceContext should not change active session');
  }
  if (gw.getSessionWorkspaceTarget('sess-bg')?.remotePath !== '/bg-path') {
    throw new Error('background session context not stored');
  }
  if (gw.getEffectiveWorkspaceTarget()?.remotePath !== '/view-path') {
    throw new Error('active view should remain on view-path');
  }
  console.log('ok bindOnly preserves active session');
}

async function main() {
  await testInvokeRpcScopesBySessionId();
  await testBindOnlyPreservesActiveSession();
  console.log('\nparallel-ssh-scope: ALL OK');
}

main().catch((e) => {
  console.error('FAIL:', e.message || e);
  process.exit(1);
});

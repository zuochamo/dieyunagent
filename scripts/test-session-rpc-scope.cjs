'use strict';

/** Mirrors renderer-gateway.js withSessionRpcScope for unit test. */
function withSessionRpcScope(params, sessionId, resolvePath) {
  const base = params && typeof params === 'object' ? { ...params } : {};
  const sid =
    base.sessionId != null && String(base.sessionId).trim()
      ? String(base.sessionId).trim()
      : sessionId != null && String(sessionId).trim()
        ? String(sessionId).trim()
        : '';
  if (sid && !base.sessionId) base.sessionId = sid;
  if (!base.runWorkspaceRoot) {
    const wp =
      base.workspaceRoot && String(base.workspaceRoot).trim()
        ? String(base.workspaceRoot).trim()
        : resolvePath(sid);
    if (wp) base.runWorkspaceRoot = wp;
  }
  return base;
}

function testScopeMergesSessionAndWorkspace() {
  const resolve = (sid) => (sid === 'sess-b' ? 'ssh://u@h:22/proj-b' : null);
  const p = withSessionRpcScope({ query: 'x' }, 'sess-b', resolve);
  if (p.sessionId !== 'sess-b') throw new Error('expected sessionId');
  if (p.runWorkspaceRoot !== 'ssh://u@h:22/proj-b') throw new Error('expected runWorkspaceRoot');
  console.log('ok withSessionRpcScope merges session + workspace');
}

function testScopePrefersExplicitWorkspaceRoot() {
  const p = withSessionRpcScope(
    { workspaceRoot: 'ssh://u@h:22/proj-a', query: 'y' },
    'sess-a',
    () => 'ssh://u@h:22/other'
  );
  if (p.runWorkspaceRoot !== 'ssh://u@h:22/proj-a') {
    throw new Error('expected workspaceRoot to map to runWorkspaceRoot');
  }
  console.log('ok withSessionRpcScope prefers explicit workspaceRoot');
}

function main() {
  testScopeMergesSessionAndWorkspace();
  testScopePrefersExplicitWorkspaceRoot();
  console.log('\nsession-rpc-scope: ALL OK');
}

main();

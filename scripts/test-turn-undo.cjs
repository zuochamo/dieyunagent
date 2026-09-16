'use strict';

const path = require('path');
const {
  createTurnUndoService,
  normalizeUndoWorkspaceRoot,
  normalizeUndoRunWorkspaceRoot
} = require('../src/undo/turn-undo-service');

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assert failed');
}

assert(
  normalizeUndoWorkspaceRoot('ssh', '/home/svc/proj') === '/home/svc/proj',
  'ssh posix root is not path.resolve-d'
);
assert(
  !path.isAbsolute(normalizeUndoWorkspaceRoot('ssh', '/home/svc/proj')) ||
    normalizeUndoWorkspaceRoot('ssh', '/home/svc/proj').startsWith('/'),
  'ssh root stays posix'
);
assert(
  normalizeUndoWorkspaceRoot('ssh', 'ssh://user@host:22/home/svc/proj') === '/home/svc/proj',
  'ssh uri extracts remote path'
);
assert(
  normalizeUndoRunWorkspaceRoot('ssh', 'ssh://user@host/home/svc/proj', '/home/svc/proj') ===
    'ssh://user@host/home/svc/proj',
  'keeps ssh uri for restore context'
);

const winResolved = path.resolve('/home/svc/proj');
if (process.platform === 'win32') {
  assert(winResolved !== '/home/svc/proj', 'sanity: windows resolve mutates posix path');
  assert(
    normalizeUndoWorkspaceRoot('ssh', '/home/svc/proj') !== winResolved,
    'undo must not use windows-resolved ssh root'
  );
}

(async () => {
  const undo = createTurnUndoService();
  const begun = await undo.beginTurn({
    sessionId: 's1',
    turnId: 'turn-1',
    workspaceKind: 'ssh',
    workspaceRoot: '/home/svc/proj',
    runWorkspaceRoot: 'ssh://user@host/home/svc/proj'
  });
  assert(begun.ok, 'beginTurn ssh');
  const rec = undo.getRecord('s1', 'turn-1');
  assert(rec.workspaceKind === 'ssh', 'kind ssh');
  assert(rec.workspaceRoot === '/home/svc/proj', 'stored posix remote root');
  assert(rec.runWorkspaceRoot === 'ssh://user@host/home/svc/proj', 'stored ssh uri');
  assert(rec.strategy === 'snapshot', 'no remote git baseline → snapshot');

  undo.captureWrite({
    sessionId: 's1',
    turnId: 'turn-1',
    filePath: 'src/a.js',
    beforeText: 'old',
    workspaceRoot: rec.workspaceRoot
  });
  assert(rec.files['src/a.js'].remote === true, 'ssh writes marked remote');
  assert(rec.files['src/a.js'].before === 'old', 'captured before');

  undo.finalizeTurn({ sessionId: 's1', turnId: 'turn-1' });
  const plan = undo.planRollback({ sessionId: 's1', turnId: 'turn-1' });
  assert(plan.ok, 'planRollback');
  assert(plan.workspaceKind === 'ssh', 'plan kind');
  assert(plan.runWorkspaceRoot === 'ssh://user@host/home/svc/proj', 'plan uses uri not posix');
  assert(plan.restore.length === 1, 'restore one file');
  assert(plan.restore[0].remote === true, 'restore item remote');
  assert(plan.restore[0].workspaceKind === 'ssh', 'restore item kind');

  console.log('test-turn-undo.cjs ok');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});

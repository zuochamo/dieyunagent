'use strict';

/**
 * Smoke test for diff trace resolution (P0).
 * Run: node scripts/test-diff-resolve.cjs
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const src = fs.readFileSync(path.join(__dirname, '../src/renderer/renderer-tool-results.js'), 'utf8');
const sandbox = {
  window: {},
  lastAgentDisplayedTrace: [],
  pathsMatch: (a, b) => String(a).toLowerCase() === String(b).toLowerCase()
};
vm.createContext(sandbox);
vm.runInContext(src, sandbox);

const {
  isEditToolName,
  resolveToolDiffBody,
  resolveArtifactDiffFromTrace,
  resolveToolDiffStats
} = sandbox.window;

let failed = 0;
function ok(cond, msg) {
  if (!cond) {
    console.error('FAIL:', msg);
    failed += 1;
  }
}

ok(isEditToolName('fs_write_file'), 'fs_write_file is edit tool');
ok(isEditToolName('fs_edit'), 'fs_edit is edit tool');
ok(!isEditToolName('apply_patch'), 'apply_patch is not a registered edit tool');
ok(!isEditToolName('host_exec'), 'host_exec is not edit tool');

const writeTool = {
  name: 'fs_write_file',
  toolArgs: { filePath: '/proj/a.js', content: 'line1\nline2\n' },
  diff: { added: 2, removed: 0, afterText: 'line1\nline2\n' }
};
const body = resolveToolDiffBody(writeTool);
ok(body && body.added === 2, 'resolveToolDiffBody keeps write diff stats');

const pendingTool = {
  name: 'fs_write_file',
  pending: true,
  toolArgs: { filePath: '/proj/b.js', content: 'new\ncontent\n' }
};
const pendingBody = resolveToolDiffBody(pendingTool);
ok(pendingBody && pendingBody.added === 2, 'resolveToolDiffBody from pending content');

sandbox.lastAgentDisplayedTrace = [
  {
    tools: [
      {
        name: 'fs_write_file',
        toolArgs: { filePath: '/proj/c.js', content: 'x\n' },
        diff: { added: 1, removed: 0, afterText: 'x\n', created: true }
      }
    ]
  }
];
const fromTrace = resolveArtifactDiffFromTrace('/proj/c.js', sandbox.lastAgentDisplayedTrace);
ok(fromTrace && fromTrace.added === 1, 'resolveArtifactDiffFromTrace finds latest edit');

const stats = resolveToolDiffStats(pendingTool);
ok(stats && stats.added === 2, 'resolveToolDiffStats for pending write');

if (failed) {
  console.error(`\n${failed} test(s) failed`);
  process.exit(1);
}
console.log('test-diff-resolve: all passed');

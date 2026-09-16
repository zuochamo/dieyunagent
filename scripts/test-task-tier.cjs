'use strict';

/** Delegates to Vitest (`npm run test:task-tier`). Kept so `node scripts/test-task-tier.cjs` still works. */
const { spawnSync } = require('child_process');
const path = require('path');

const root = path.join(__dirname, '..');
const vitestBin = path.join(root, 'node_modules', 'vitest', 'vitest.mjs');
const r = spawnSync(process.execPath, [vitestBin, 'run', 'test/unit/task-tier.test.cjs'], {
  cwd: root,
  stdio: 'inherit',
  env: process.env
});
process.exit(r.status == null ? 1 : r.status);

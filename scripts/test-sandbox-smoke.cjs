'use strict';

const fs = require('fs');
const path = require('path');
const { agentSandboxPath } = require('./lib/agent-sandbox-path.cjs');

const sandbox = agentSandboxPath();

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assert failed');
}

for (const file of ['index.html', 'app.js', 'styles.css', 'README.md']) {
  assert(fs.existsSync(path.join(sandbox, file)), `missing ${file}`);
}

const html = fs.readFileSync(path.join(sandbox, 'index.html'), 'utf8');
assert(html.includes('id="counter"'), 'index.html counter');
assert(html.includes('app.js'), 'index.html script');

const js = fs.readFileSync(path.join(sandbox, 'app.js'), 'utf8');
assert(js.includes('addEventListener'), 'app.js interactive');

console.log('test-sandbox-smoke.cjs ok');

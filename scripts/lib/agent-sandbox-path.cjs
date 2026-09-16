'use strict';

const path = require('path');

function agentSandboxPath(root = path.join(__dirname, '..', '..')) {
  return path.join(root, 'examples', 'agent-sandbox');
}

module.exports = { agentSandboxPath };

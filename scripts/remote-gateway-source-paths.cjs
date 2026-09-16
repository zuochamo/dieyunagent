'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const REMOTE_GATEWAY_SOURCE_PATHS = [
  'src/remote/run-cli.js',
  'src/remote/minimal-gateway-host.js',
  'src/remote/remote-index-core.js',
  'src/remote/linux-elf-compat.js',
  'src/remote/workspace-index-path.js',
  'src/core-bridge.js',
  'src/core-rpc-timeouts.js',
  'src/gateway/path-policy.js',
  'src/gateway/host-control.js',
  'src/gateway/fs-read-limits.js',
  'src/gateway/fs-edit-file.js',
  'src/gateway/str-replace.js',
  'src/gateway/rg-search.js'
];

function computeRemoteGatewaySourceHash(rootDir) {
  const root = path.resolve(rootDir || path.join(__dirname, '..'));
  const hash = crypto.createHash('sha256');
  for (const rel of REMOTE_GATEWAY_SOURCE_PATHS) {
    const abs = path.join(root, rel);
    hash.update(rel);
    hash.update('\0');
    try {
      hash.update(fs.readFileSync(abs));
    } catch {
      hash.update('__missing__');
    }
    hash.update('\0');
  }
  return hash.digest('hex').slice(0, 16);
}

module.exports = {
  REMOTE_GATEWAY_SOURCE_PATHS,
  computeRemoteGatewaySourceHash
};

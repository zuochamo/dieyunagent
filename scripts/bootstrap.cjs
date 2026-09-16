#!/usr/bin/env node
/**
 * Ensure dieyunagent dependencies are installed before start/build.
 */
require('./win-utf8-console.cjs');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const root = path.join(__dirname, '..');
const electronPkg = path.join(root, 'node_modules', 'electron', 'package.json');
const socketIo = path.join(root, 'node_modules', 'socket.io-client', 'package.json');

function needInstall() {
  try {
    if (!fs.existsSync(electronPkg) || !fs.existsSync(socketIo)) return true;
    return false;
  } catch {
    return true;
  }
}

if (needInstall()) {
  console.log('[dieyunagent/bootstrap] dependencies missing, running npm install...');
  execSync('npm install', { stdio: 'inherit', cwd: root, env: process.env });
  console.log('[dieyunagent/bootstrap] dependencies installed.');
} else {
  console.log('[dieyunagent/bootstrap] dependencies found, skipping npm install.');
}

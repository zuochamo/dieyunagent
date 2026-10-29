#!/usr/bin/env node
'use strict';

const path = require('path');
const { MinimalRemoteGatewayHost } = require('./minimal-gateway-host');

function isBenignProcessError(err) {
  const code = err && err.code;
  return code === 'EPIPE' || code === 'ECONNRESET' || code === 'ERR_STREAM_DESTROYED';
}

function installProcessStreamGuards() {
  for (const stream of [process.stdout, process.stderr]) {
    if (!stream || typeof stream.on !== 'function') continue;
    if (stream.__dieyunStreamGuard) continue;
    stream.__dieyunStreamGuard = true;
    stream.on('error', (err) => {
      if (!isBenignProcessError(err)) {
        console.error('[dieyun-remote-agent] stream error:', err && err.stack ? err.stack : err);
      }
    });
  }
}

installProcessStreamGuards();

process.on('uncaughtException', (err) => {
  if (isBenignProcessError(err)) {
    console.error('[dieyun-remote-agent] ignored stream error:', err && err.message ? err.message : err);
    return;
  }
  console.error('[dieyun-remote-agent] uncaught:', err && err.stack ? err.stack : err);
  process.exit(1);
});
process.on('unhandledRejection', (err) => {
  if (isBenignProcessError(err)) {
    console.error('[dieyun-remote-agent] ignored rejection:', err && err.message ? err.message : err);
    return;
  }
  console.error('[dieyun-remote-agent] rejection:', err && err.stack ? err.stack : err);
});

function parseArgs(argv) {
  const out = { workspace: '', socket: '' };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--workspace' && argv[i + 1]) {
      out.workspace = argv[++i];
    } else if (a === '--socket' && argv[i + 1]) {
      out.socket = argv[++i];
    }
  }
  return out;
}

const args = parseArgs(process.argv);
if (!args.socket) {
  console.error(
    'usage: node run-cli.js --socket /home/<user>/.dieyun/remote-agent/run/agent.sock [--workspace /path]'
  );
  process.exit(1);
}

const host = new MinimalRemoteGatewayHost({
  socketPath: args.socket,
  workspaceRoot: args.workspace || undefined,
  packRoot: path.resolve(__dirname, '..'),
  log: (m) => {
    try {
      console.log(`[dieyun-remote-agent] ${m}`);
    } catch (err) {
      if (!isBenignProcessError(err)) throw err;
    }
  }
});

host.start();

process.on('SIGINT', () => {
  host.stop();
  process.exit(0);
});
process.on('SIGTERM', () => {
  host.stop();
  process.exit(0);
});

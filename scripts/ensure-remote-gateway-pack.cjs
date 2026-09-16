'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { computeRemoteGatewaySourceHash } = require('./remote-gateway-source-paths.cjs');

const ROOT = path.join(__dirname, '..');
const PACK = path.join(ROOT, 'build', 'remote-gateway-pack');
const NODE_BIN = path.join(PACK, 'bin', 'node');
const MANIFEST = path.join(PACK, 'manifest.json');
const EXPECTED_SOURCE_HASH = computeRemoteGatewaySourceHash(ROOT);

function readManifest() {
  try {
    return JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  } catch {
    return null;
  }
}

function packLooksComplete() {
  if (!fs.existsSync(MANIFEST)) return false;
  try {
    const manifest = readManifest();
    if (!manifest || !manifest.entry) return false;
    if (manifest.sourceHash !== EXPECTED_SOURCE_HASH) return false;
    if (manifest.lite) {
      return fs.existsSync(path.join(PACK, 'remote', 'run-cli.js'));
    }
    if (!fs.existsSync(NODE_BIN)) return false;
    const st = fs.statSync(NODE_BIN);
    return st.isFile() && st.size > 50 * 1024 * 1024 && !!manifest.injected;
  } catch {
    return false;
  }
}

function runPack() {
  const manifest = readManifest();
  const useLite = !!(manifest && manifest.lite) || process.env.DIEYUN_REMOTE_PACK_LITE === '1';
  const script = useLite ? 'pack:remote-gateway:lite' : 'pack:remote-gateway';
  console.log(`[remote-agent] rebuilding pack (${script}, sourceHash=${EXPECTED_SOURCE_HASH})…`);
  execSync(`npm run ${script}`, { cwd: ROOT, stdio: 'inherit' });
}

if (packLooksComplete()) {
  const manifest = readManifest();
  console.log(
    `[remote-agent] pack OK: ${PACK} (sourceHash=${manifest && manifest.sourceHash ? manifest.sourceHash : '?'})`
  );
  process.exit(0);
}

const manifest = readManifest();
if (manifest && manifest.sourceHash && manifest.sourceHash !== EXPECTED_SOURCE_HASH) {
  console.log(
    `[remote-agent] pack stale (${manifest.sourceHash} -> ${EXPECTED_SOURCE_HASH}), rebuilding…`
  );
} else if (!fs.existsSync(MANIFEST)) {
  console.log('[remote-agent] pack missing, building…');
} else {
  console.log('[remote-agent] pack incomplete, building…');
}

runPack();

if (!packLooksComplete()) {
  console.error('[remote-agent] pack still incomplete after build');
  process.exit(1);
}

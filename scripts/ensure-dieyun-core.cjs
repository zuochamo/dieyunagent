'use strict';

const { execSync } = require('child_process');
const path = require('path');
const { packLooksComplete, OUT, EXE_NAME } = require('./pack-dieyun-core.cjs');

const ROOT = path.join(__dirname, '..');
const RELEASE_BIN = path.join(
  ROOT,
  'target',
  'release',
  process.platform === 'win32' ? 'dieyun-core.exe' : 'dieyun-core'
);

function releaseBinaryLooksComplete() {
  try {
    const fs = require('fs');
    if (!fs.existsSync(RELEASE_BIN)) return false;
    const st = fs.statSync(RELEASE_BIN);
    return st.isFile() && st.size > 500 * 1024;
  } catch {
    return false;
  }
}

function coreLooksReady() {
  return packLooksComplete() || releaseBinaryLooksComplete();
}

function runPack() {
  console.log('[dieyun-core] sidecar missing or stale, building (npm run pack:dieyun-core)…');
  execSync('npm run pack:dieyun-core', { cwd: ROOT, stdio: 'inherit' });
}

if (coreLooksReady()) {
  const dest = path.join(OUT, EXE_NAME);
  console.log(`[dieyun-core] sidecar OK: ${dest}`);
  process.exit(0);
}

console.log('[dieyun-core] sidecar missing, building…');
runPack();

if (!coreLooksReady()) {
  console.error('[dieyun-core] sidecar still missing after build');
  console.error('[dieyun-core] 请确认已安装 Rust (cargo)，或手动运行: npm run pack:dieyun-core');
  process.exit(1);
}

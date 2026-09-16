'use strict';

/**
 * 构建 dieyun-core release 并写入 build/dieyun-core/，供 electron-builder extraResources 打包。
 */
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'build', 'dieyun-core');
const EXE_NAME = process.platform === 'win32' ? 'dieyun-core.exe' : 'dieyun-core';
const RELEASE_BIN = path.join(ROOT, 'target', 'release', EXE_NAME);
const MIN_BYTES = 500 * 1024;

function readCoreVersion() {
  try {
    const wsToml = fs.readFileSync(path.join(ROOT, 'Cargo.toml'), 'utf8');
    const m = wsToml.match(/^\s*version\s*=\s*"([^"]+)"/m);
    if (m) return m[1];
  } catch {
    // ignore
  }
  return '0.1.0';
}

function packLooksComplete() {
  const dest = path.join(OUT, EXE_NAME);
  const manifestPath = path.join(OUT, 'manifest.json');
  if (!fs.existsSync(dest) || !fs.existsSync(manifestPath)) return false;
  try {
    const st = fs.statSync(dest);
    if (!st.isFile() || st.size < MIN_BYTES) return false;
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    return manifest && manifest.binary === EXE_NAME && manifest.version === readCoreVersion();
  } catch {
    return false;
  }
}

async function main() {
  const skipBuild = process.env.DIEYUN_SKIP_CARGO_BUILD === '1';
  const dest = path.join(OUT, EXE_NAME);

  if (!skipBuild) {
    console.log('[dieyun-core] cargo build --release …');
    execSync('cargo build -p dieyun-core --release', { cwd: ROOT, stdio: 'inherit' });
  } else if (!fs.existsSync(RELEASE_BIN)) {
    throw new Error(`DIEYUN_SKIP_CARGO_BUILD=1 但未找到 ${RELEASE_BIN}`);
  }

  if (!fs.existsSync(RELEASE_BIN)) {
    throw new Error('Release binary not found: ' + RELEASE_BIN);
  }

  await fsp.mkdir(OUT, { recursive: true });
  await fsp.copyFile(RELEASE_BIN, dest);

  const st = fs.statSync(dest);
  if (st.size < MIN_BYTES) {
    throw new Error(`dieyun-core 体积异常 (${st.size} bytes): ${dest}`);
  }

  const manifest = {
    version: readCoreVersion(),
    platform: process.platform,
    arch: process.arch,
    binary: EXE_NAME,
    builtAt: new Date().toISOString()
  };
  await fsp.writeFile(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');

  console.log('[dieyun-core] pack OK:', dest, `(${Math.round(st.size / 1024)} KB)`);
}

if (require.main === module) {
  main().catch((e) => {
    console.error('[dieyun-core] pack failed:', e.message || e);
    process.exit(1);
  });
}

module.exports = {
  OUT,
  EXE_NAME,
  packLooksComplete,
  readCoreVersion
};

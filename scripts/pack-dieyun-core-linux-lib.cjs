'use strict';

const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'build', 'dieyun-core-linux');
const OUT_BIN = path.join(OUT_DIR, 'dieyun-core');
const MANIFEST_PATH = path.join(OUT_DIR, 'manifest.json');
const MIN_BYTES = 500 * 1024;

/** 与 pack-dieyun-core-linux-remote 上传的 tar 内容一致 */
function collectFingerprintFiles() {
  const files = [];

  function addFile(filePath) {
    if (fs.existsSync(filePath)) files.push(path.resolve(filePath));
  }

  function walkDir(dir) {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (ent.name === 'target' || ent.name === '.git') continue;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) walkDir(full);
      else if (ent.isFile()) files.push(path.resolve(full));
    }
  }

  addFile(path.join(ROOT, 'Cargo.toml'));
  addFile(path.join(ROOT, 'Cargo.lock'));
  const cratesDir = path.join(ROOT, 'crates');
  if (fs.existsSync(cratesDir)) walkDir(cratesDir);

  files.sort((a, b) => a.localeCompare(b));
  return files;
}

function computeSourceFingerprint() {
  const hash = crypto.createHash('sha256');
  for (const filePath of collectFingerprintFiles()) {
    const rel = path.relative(ROOT, filePath).replace(/\\/g, '/');
    hash.update(rel);
    hash.update('\0');
    hash.update(fs.readFileSync(filePath));
    hash.update('\0');
  }
  return hash.digest('hex');
}

function readLinuxCoreManifest() {
  if (!fs.existsSync(MANIFEST_PATH)) return null;
  try {
    return JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  } catch {
    return null;
  }
}

function isLinuxElf(filePath) {
  try {
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(4);
    fs.readSync(fd, buf, 0, 4, 0);
    fs.closeSync(fd);
    return buf[0] === 0x7f && buf[1] === 0x45 && buf[2] === 0x4c && buf[3] === 0x46;
  } catch {
    return false;
  }
}

async function installLinuxCoreBin(releaseBin) {
  if (!releaseBin || !fs.existsSync(releaseBin)) {
    throw new Error('Linux release binary not found');
  }
  if (!isLinuxElf(releaseBin)) {
    throw new Error('产物不是 Linux ELF（可能误用了 Windows dieyun-core.exe）: ' + releaseBin);
  }
  const sourceFingerprint = computeSourceFingerprint();
  const existingManifest = readLinuxCoreManifest();
  const sameDest = path.resolve(releaseBin) === path.resolve(OUT_BIN);
  const hadUsable =
    sameDest &&
    localCoreUsable() &&
    existingManifest &&
    existingManifest.sourceFingerprint === sourceFingerprint &&
    existingManifest.binaryBytes === fs.statSync(OUT_BIN).size;

  if (hadUsable) {
    console.log('[dieyun-core-linux] 产物与指纹均未变，复用:', OUT_BIN);
    return OUT_BIN;
  }

  await fsp.mkdir(OUT_DIR, { recursive: true });
  if (!sameDest) {
    await fsp.copyFile(releaseBin, OUT_BIN);
  }
  const st = fs.statSync(OUT_BIN);
  if (st.size < MIN_BYTES) {
    throw new Error(`dieyun-core-linux 体积异常 (${st.size} bytes)`);
  }
  if (
    existingManifest &&
    existingManifest.sourceFingerprint === sourceFingerprint &&
    existingManifest.binaryBytes === st.size
  ) {
    console.log(
      '[dieyun-core-linux] pack OK:',
      OUT_BIN,
      `(${Math.round(st.size / 1024)} KB, fingerprint ${sourceFingerprint.slice(0, 12)}…, manifest 未改)`
    );
    return OUT_BIN;
  }

  const manifest = {
    binary: 'dieyun-core',
    platform: 'linux',
    arch: 'x86_64',
    binaryBytes: st.size,
    builtAt: new Date().toISOString(),
    sourceFingerprint,
    fingerprintFiles: collectFingerprintFiles().length
  };
  await fsp.writeFile(MANIFEST_PATH, JSON.stringify(manifest, null, 2), 'utf8');
  let maxGlibc = '';
  try {
    maxGlibc = require('../src/remote/linux-elf-compat').maxGlibcInFile(OUT_BIN);
  } catch {
    // ignore
  }
  if (maxGlibc) {
    console.log('[dieyun-core-linux] 二进制最高 GLIBC 需求:', maxGlibc);
    if (compareNeed(maxGlibc, '2.39') > 0) {
      console.warn(
        `[dieyun-core-linux] 警告: 需要 GLIBC ${maxGlibc}，常见 Ubuntu 22.04/24.04 无法运行。请在目标 SSH 主机编译: npm run pack:dieyun-core:linux:remote`
      );
    }
  }
  console.log(
    '[dieyun-core-linux] pack OK:',
    OUT_BIN,
    `(${Math.round(st.size / 1024)} KB, fingerprint ${sourceFingerprint.slice(0, 12)}…)`
  );
  return OUT_BIN;
}

function compareNeed(a, b) {
  const pa = String(a).split('.').map((n) => Number(n) || 0);
  const pb = String(b).split('.').map((n) => Number(n) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const da = pa[i] || 0;
    const db = pb[i] || 0;
    if (da !== db) return da > db ? 1 : -1;
  }
  return 0;
}

function localCoreUsable() {
  if (!fs.existsSync(OUT_BIN)) return false;
  try {
    const st = fs.statSync(OUT_BIN);
    return st.isFile() && st.size >= MIN_BYTES && isLinuxElf(OUT_BIN);
  } catch {
    return false;
  }
}

function localCoreFingerprintMatches() {
  if (!localCoreUsable()) return false;
  const manifest = readLinuxCoreManifest();
  if (!manifest || typeof manifest.sourceFingerprint !== 'string' || !manifest.sourceFingerprint) {
    return false;
  }
  return manifest.sourceFingerprint === computeSourceFingerprint();
}

module.exports = {
  ROOT,
  OUT_DIR,
  OUT_BIN,
  MANIFEST_PATH,
  MIN_BYTES,
  isLinuxElf,
  collectFingerprintFiles,
  computeSourceFingerprint,
  readLinuxCoreManifest,
  installLinuxCoreBin,
  localCoreUsable,
  localCoreFingerprintMatches
};

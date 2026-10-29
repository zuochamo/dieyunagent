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

/**
 * 远端 core 允许的最高 GLIBC 需求 —— **单一来源**。
 *
 * 2.17 = Rust std 在 x86_64-unknown-linux-gnu 上的下限，也是 manylinux2014 口径；
 * 高于它的二进制在 Ubuntu 20.04(2.31) / Debian 11(2.31) / RHEL 8(2.28) 这些还算常见的
 * 机器上会被动态加载器直接拒掉。构建时用 `cargo zigbuild --target …gnu.2.17`
 * （见 pack-dieyun-core-linux-remote.cjs），pack 时用 assertCoreGlibcTarget() 拦住漂移。
 *
 * 之前这套判断是**运行时**做的（远端先 `ldd --version` 量宿主 glibc、再扫二进制符号），
 * 结果：告警说的是宿主要求，用户拿到的是「远端索引整个不可用」。现在改成产物侧的硬约束，
 * 宿主侧不再有预检（宿主 glibc 低于 2.17 时连随包的 node 都起不来，根本走不到 core）。
 */
const CORE_GLIBC_TARGET = '2.17';

/** 只有 libc 家族自带的版本才代表「宿主 glibc 下限」；libssl 之类自带 GLIBC_ 串会抬高数字 */
const LIBC_LIKE = /^(libc|libm|libpthread|libdl|librt|libutil|libanl|ld-linux)/;

function compareNeed(a, b) {
  const pa = String(a || '')
    .split('.')
    .map((n) => Number(n) || 0);
  const pb = String(b || '')
    .split('.')
    .map((n) => Number(n) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const da = pa[i] || 0;
    const db = pb[i] || 0;
    if (da !== db) return da > db ? 1 : -1;
  }
  return 0;
}

function readCString(buf, off) {
  if (!Number.isFinite(off) || off < 0 || off >= buf.length) return '';
  let end = off;
  while (end < buf.length && buf[end] !== 0) end += 1;
  return buf.toString('latin1', off, end);
}

/** @returns {{ is64: boolean, sections: Array<{name: string, type: number, offset: number, size: number, link: number, entsize: number}> } | null} */
function readElfSections(buf) {
  if (!buf || buf.length < 52) return null;
  if (buf[0] !== 0x7f || buf.toString('latin1', 1, 4) !== 'ELF') return null;
  const is64 = buf[4] === 2;
  const shoff = is64 ? Number(buf.readBigUInt64LE(0x28)) : buf.readUInt32LE(0x20);
  const shentsize = is64 ? buf.readUInt16LE(0x3a) : buf.readUInt16LE(0x2e);
  const shnum = is64 ? buf.readUInt16LE(0x3c) : buf.readUInt16LE(0x30);
  const shstrndx = is64 ? buf.readUInt16LE(0x3e) : buf.readUInt16LE(0x32);
  const want = is64 ? 64 : 40;
  if (!Number.isFinite(shoff) || shoff <= 0 || shentsize < want || shnum <= 0 || shnum > 4096) return null;
  if (shoff + shnum * shentsize > buf.length) return null;

  const raw = [];
  for (let i = 0; i < shnum; i++) {
    const base = shoff + i * shentsize;
    raw.push({
      nameOff: buf.readUInt32LE(base),
      type: buf.readUInt32LE(base + 4),
      offset: is64 ? Number(buf.readBigUInt64LE(base + 24)) : buf.readUInt32LE(base + 16),
      size: is64 ? Number(buf.readBigUInt64LE(base + 32)) : buf.readUInt32LE(base + 20),
      link: buf.readUInt32LE(base + (is64 ? 40 : 24)),
      entsize: is64 ? Number(buf.readBigUInt64LE(base + 56)) : buf.readUInt32LE(base + 36)
    });
  }
  const strTab = raw[shstrndx];
  if (!strTab) return null;
  const sections = raw.map((s) => ({ ...s, name: readCString(buf, strTab.offset + s.nameOff) }));
  return { is64, sections };
}

/**
 * 解析 `.gnu.version_r`（Elf_Verneed），得出这个二进制对 libc 家族要求的最高的 GLIBC 版本。
 *
 * 返回 `{ ok:false }` 表示「读不懂」（不是 ELF / 段落损坏）——调用方此时必须失败，
 * 不能当成「没有要求」。
 * 返回 `maxGlibc: ''` 表示「确实没有版本需求」（静态链接或无需符号版本）。
 */
function parseElfLibcVersions(buf) {
  const parsed = readElfSections(buf);
  if (!parsed) return { ok: false, maxGlibc: '', libs: [] };
  const verneed = parsed.sections.find((s) => s.name === '.gnu.version_r');
  if (!verneed) return { ok: true, maxGlibc: '', libs: [] };
  const dynstr = parsed.sections[verneed.link];
  if (!dynstr) return { ok: false, maxGlibc: '', libs: [] };

  const libs = [];
  let off = verneed.offset;
  const end = Math.min(verneed.offset + verneed.size, buf.length);
  let guard = 0;
  while (off + 16 <= end && guard++ < 512) {
    const file = readCString(buf, dynstr.offset + buf.readUInt32LE(off + 4));
    const aux = off + buf.readUInt32LE(off + 8);
    const next = buf.readUInt32LE(off + 12);
    let versions = [];
    let a = aux;
    let g = 0;
    while (a + 16 <= end && g++ < 512) {
      versions.push(readCString(buf, dynstr.offset + buf.readUInt32LE(a + 8)));
      const anext = buf.readUInt32LE(a + 12);
      if (!anext) break;
      a += anext;
    }
    libs.push({ file, versions });
    if (!next) break;
    off += next;
  }

  let maxGlibc = '';
  for (const lib of libs) {
    if (!LIBC_LIKE.test(lib.file)) continue;
    for (const v of lib.versions) {
      const m = /^GLIBC_(\d+(?:\.\d+)?)$/.exec(String(v || ''));
      if (!m) continue;
      if (!maxGlibc || compareNeed(m[1], maxGlibc) > 0) maxGlibc = m[1];
    }
  }
  return { ok: true, maxGlibc, libs };
}

/**
 * 整文件扫 `GLIBC_x.y` 字面量（保守口径：只可能多报，不可能少报）。
 * 只在正式解析读不懂时用，且调用方**必须**知道这是保守值。
 */
function maxGlibcInBuffer(buf) {
  if (!buf || !buf.length) return '';
  const needle = Buffer.from('GLIBC_');
  let max = '';
  let from = 0;
  while (from < buf.length) {
    const idx = buf.indexOf(needle, from);
    if (idx < 0) break;
    let i = idx + 6;
    let major = '';
    let minor = '';
    while (i < buf.length && buf[i] >= 48 && buf[i] <= 57) major += String.fromCharCode(buf[i++]);
    if (i < buf.length && buf[i] === 46) {
      i += 1;
      while (i < buf.length && buf[i] >= 48 && buf[i] <= 57) minor += String.fromCharCode(buf[i++]);
    }
    if (major) {
      const ver = minor ? `${major}.${minor}` : major;
      if (!max || compareNeed(ver, max) > 0) max = ver;
    }
    from = idx + 6;
  }
  return max;
}

/**
 * @param {string} filePath
 * @returns {{ maxGlibc: string, source: 'verneed' | 'scan' | 'unreadable', libs: Array<{file: string, versions: string[]}> }}
 */
function glibcRequirementOf(filePath) {
  let buf;
  try {
    buf = fs.readFileSync(filePath);
  } catch {
    return { maxGlibc: '', source: 'unreadable', libs: [] };
  }
  const r = parseElfLibcVersions(buf);
  if (r.ok) return { maxGlibc: r.maxGlibc, source: 'verneed', libs: r.libs };
  return { maxGlibc: maxGlibcInBuffer(buf), source: 'scan', libs: [] };
}

/**
 * 产物侧的硬约束：远端 core 不得要求高于 CORE_GLIBC_TARGET 的 glibc。
 * 这是**替代**运行时预检的那道闸：拦在打包这一步，而不是等用户连上一台老机器才发现。
 */
function assertCoreGlibcTarget(binPath) {
  const r = glibcRequirementOf(binPath);
  if (r.source === 'unreadable') {
    throw Object.assign(new Error(`读不出产物的 ELF：${binPath}`), { code: 'CORE_ELF_UNREADABLE' });
  }
  if (r.source === 'scan') {
    throw Object.assign(
      new Error(
        `无法解析 ${path.basename(binPath)} 的 .gnu.version_r（只能整文件扫到 GLIBC ${r.maxGlibc || '未知'}），` +
          '不能确认是否满足 GLIBC ≤ ' +
          CORE_GLIBC_TARGET
      ),
      { code: 'CORE_GLIBC_UNVERIFIED', needed: r.maxGlibc }
    );
  }
  if (r.maxGlibc && compareNeed(r.maxGlibc, CORE_GLIBC_TARGET) > 0) {
    const e = new Error(
      `远端 core 需要 GLIBC ${r.maxGlibc} > ${CORE_GLIBC_TARGET}：老发行版（RHEL 8 / Debian 11 及以上之外）会加载失败。` +
        '请用 cargo zigbuild 重新构建：npm run pack:dieyun-core:linux（远端机 glibc 新时会自动走 zig）'
    );
    e.code = 'CORE_GLIBC_TOO_NEW';
    e.needed = r.maxGlibc;
    e.target = CORE_GLIBC_TARGET;
    throw e;
  }
  return r;
}

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
  // 硬闸：产物侧拦 GLIBC 漂移（连「复用已有产物」的分支也要过这一关）
  const glibc = assertCoreGlibcTarget(releaseBin);
  console.log(
    '[dieyun-core-linux] 二进制 GLIBC 需求:',
    glibc.maxGlibc || '(无符号版本需求)',
    `≤ 目标 ${CORE_GLIBC_TARGET}`
  );
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
  console.log(
    '[dieyun-core-linux] pack OK:',
    OUT_BIN,
    `(${Math.round(st.size / 1024)} KB, GLIBC ≤ ${CORE_GLIBC_TARGET}, fingerprint ${sourceFingerprint.slice(0, 12)}…)`
  );
  return OUT_BIN;
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
  CORE_GLIBC_TARGET,
  compareNeed,
  readElfSections,
  parseElfLibcVersions,
  maxGlibcInBuffer,
  glibcRequirementOf,
  assertCoreGlibcTarget,
  isLinuxElf,
  collectFingerprintFiles,
  computeSourceFingerprint,
  readLinuxCoreManifest,
  installLinuxCoreBin,
  localCoreUsable,
  localCoreFingerprintMatches
};

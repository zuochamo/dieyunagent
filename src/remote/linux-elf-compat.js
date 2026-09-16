'use strict';

const fs = require('fs');
const { spawnSync } = require('child_process');

function compareDotVersion(a, b) {
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

/**
 * ELF 动态符号里的最高 GLIBC 需求（如 2.43）。
 * @param {Buffer} buf
 * @returns {string}
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
    while (i < buf.length && buf[i] >= 48 && buf[i] <= 57) {
      major += String.fromCharCode(buf[i++]);
    }
    if (i < buf.length && buf[i] === 46) {
      i += 1;
      while (i < buf.length && buf[i] >= 48 && buf[i] <= 57) {
        minor += String.fromCharCode(buf[i++]);
      }
    }
    if (major) {
      const ver = minor ? `${major}.${minor}` : major;
      if (!max || compareDotVersion(ver, max) > 0) max = ver;
    }
    from = idx + 6;
  }
  return max;
}

function maxGlibcInFile(filePath) {
  try {
    return maxGlibcInBuffer(fs.readFileSync(filePath));
  } catch {
    return '';
  }
}

function parseLddVersionText(text) {
  const s = String(text || '');
  const named = s.match(/GLIBC\s+(\d+\.\d+)/i);
  if (named) return named[1];
  const first = s.split(/\r?\n/).map((l) => l.trim()).find(Boolean) || '';
  const tail = first.match(/(\d+\.\d+)\s*$/);
  return tail ? tail[1] : '';
}

function hostGlibcVersion() {
  try {
    const r = spawnSync('ldd', ['--version'], { encoding: 'utf8', timeout: 4000 });
    return parseLddVersionText(`${r.stdout || ''}\n${r.stderr || ''}`);
  } catch {
    return '';
  }
}

function glibcMismatchHint(need, have) {
  const needV = String(need || '').trim();
  const haveV = String(have || '').trim();
  if (!needV) return '';
  if (haveV && compareDotVersion(needV, haveV) <= 0) return '';
  if (haveV) {
    return `需要 GLIBC ${needV}，服务器 ${haveV}。请对本机执行 pack:dieyun-core:linux:remote`;
  }
  return `需要 GLIBC ${needV}。请对本机执行 pack:dieyun-core:linux:remote`;
}

function sanitizeCoreErrorText(text) {
  return String(text || '').replace(/`/g, "'");
}

module.exports = {
  compareDotVersion,
  maxGlibcInBuffer,
  maxGlibcInFile,
  parseLddVersionText,
  hostGlibcVersion,
  glibcMismatchHint,
  sanitizeCoreErrorText
};

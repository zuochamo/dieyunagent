'use strict';

/**
 * 极小的 ustar 写入器：只为**打包**用，不读 tar。
 *
 * 为什么不用系统 `tar`：
 * 1. **权限位**：Windows 上的 tar（bsdtar）会把文件写成 0666、目录写成 0777 —— 打进 deb 就是
 *    「/opt 里一堆 world-writable 的可执行文件」，打进 tgz 就是「装完还得 chmod +x」。这两个
 *    毛病都只来自打包机，不来自代码，所以要在打包这一步消除，而不是写进安装文档让用户兜。
 * 2. **可重复构建**：mtime / uid / gid 固定（默认 epoch 1704067200，可用 `SOURCE_DATE_EPOCH`
 *    覆盖），同一份源码在 Windows 与 Linux 上打出来的包逐字节相同。
 * 3. gzip 用 `zlib`，不依赖宿主有没有 xz/zstd。
 *
 * 格式覆盖：普通文件（'0'）与目录（'5'）；长路径先试 ustar 的 prefix(155)+name(100) 拆分，
 * 拆不下时退回 GNU longname（typeflag 'L'，GNU tar / bsdtar / dpkg 都认）。**不做**符号链接
 * （跨平台造不出来，遇到就明确报错，而不是把链接当普通文件打进包）。
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const BLOCK = 512;
const DEFAULT_MTIME = 1704067200; // 2024-01-01T00:00:00Z
const UNAME = 'root';
const GNAME = 'root';
const MAX_NAME = 100;
const MAX_PREFIX = 155;
const MAX_PATH = 4096; // 超过这个长度只可能是有人在拼坏路径，直接报错

function mtimeFromEnv(env = process.env) {
  const raw = Number(env.SOURCE_DATE_EPOCH);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_MTIME;
}

function octal(value, width, what) {
  const s = Math.floor(value).toString(8);
  if (s.length > width - 1) throw new Error(`tar 字段溢出（${what}）：${s}`);
  return `${'0'.repeat(width - 1 - s.length)}${s}\0`;
}

function writeString(buf, str, offset, length) {
  const bytes = Buffer.isBuffer(str) ? str : Buffer.from(str, 'utf8');
  if (bytes.length > length) throw new Error(`tar 字段溢出：${String(str)}`);
  bytes.copy(buf, offset);
}

/** ustar：name ≤ 100；否则拆成 prefix ≤ 155 + name ≤ 100（按 '/' 断）。拆不下返回 null */
function splitPath(entryPath) {
  if (Buffer.byteLength(entryPath) <= MAX_NAME) return { prefix: '', name: entryPath };
  for (let i = entryPath.length - 1; i > 0; i -= 1) {
    if (entryPath[i] !== '/') continue;
    const prefix = entryPath.slice(0, i);
    const name = entryPath.slice(i + 1);
    if (!name) continue;
    if (Buffer.byteLength(name) <= MAX_NAME && Buffer.byteLength(prefix) <= MAX_PREFIX) {
      return { prefix, name };
    }
  }
  return null;
}

function plainHeader({ name, prefix = '', size, mode, type, mtime }) {
  const buf = Buffer.alloc(BLOCK, 0);
  writeString(buf, name, 0, MAX_NAME);
  writeString(buf, octal(mode, 8, 'mode'), 100, 8);
  writeString(buf, octal(0, 8, 'uid'), 108, 8);
  writeString(buf, octal(0, 8, 'gid'), 116, 8);
  writeString(buf, octal(size, 12, 'size'), 124, 12);
  writeString(buf, octal(mtime, 12, 'mtime'), 136, 12);
  buf.write('        ', 148, 8, 'ascii'); // 校验时 chksum 字段当 8 个空格
  writeString(buf, type, 156, 1);
  buf.write('ustar\0', 257, 6, 'ascii');
  buf.write('00', 263, 2, 'ascii');
  writeString(buf, UNAME, 265, 32);
  writeString(buf, GNAME, 297, 32);
  writeString(buf, prefix, 345, MAX_PREFIX);
  let sum = 0;
  for (const b of buf) sum += b;
  buf.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
  return buf;
}

function pad(size) {
  const rem = size % BLOCK;
  return rem === 0 ? Buffer.alloc(0) : Buffer.alloc(BLOCK - rem, 0);
}

/** 一个条目对应的若干 512 块（长路径时先写 GNU longname 记录） */
function blocksFor({ entryPath, size, mode, type, mtime }) {
  const byteLength = Buffer.byteLength(entryPath);
  if (byteLength > MAX_PATH) throw new Error(`tar 路径过长（>${MAX_PATH} 字节）：${entryPath}`);
  const split = splitPath(entryPath);
  if (split) return [plainHeader({ name: split.name, prefix: split.prefix, size, mode, type, mtime })];

  // 单段超过 100 字节（ustar 表达不了）→ GNU longname：'L' 记录里放完整路径
  const payload = Buffer.concat([Buffer.from(entryPath, 'utf8'), Buffer.from([0])]);
  const longHeader = plainHeader({ name: '././@LongLink', size: payload.length, mode: 0o644, type: 'L', mtime });
  const truncated = Buffer.from(entryPath, 'utf8').subarray(0, MAX_NAME);
  const realHeader = plainHeader({ name: truncated, size, mode, type, mtime });
  return [longHeader, payload, pad(payload.length), realHeader];
}

/**
 * 把 `root` 目录打成 tar（未压缩）。
 *
 * @param {string} root 目录
 * @param {{ modeFor?: (relPath: string, isDir: boolean) => number, mtime?: number,
 *           skip?: (relPath: string, isDir: boolean) => boolean }} [opts]
 * @returns {Buffer}
 */
function buildTar(root, opts = {}) {
  const mtime = opts.mtime || mtimeFromEnv();
  const modeFor = opts.modeFor || ((rel, isDir) => (isDir ? 0o755 : 0o644));
  const skip = opts.skip || (() => false);
  const chunks = [];

  const addDir = (rel) => {
    const entryPath = rel === '' ? './' : `./${rel}/`;
    chunks.push(...blocksFor({ entryPath, size: 0, mode: modeFor(rel, true), type: '5', mtime }));
  };
  const addFile = (rel, abs) => {
    const data = fs.readFileSync(abs);
    chunks.push(...blocksFor({ entryPath: `./${rel}`, size: data.length, mode: modeFor(rel, false), type: '0', mtime }));
    chunks.push(data);
    const p = pad(data.length);
    if (p.length) chunks.push(p);
  };
  const walk = (rel, abs) => {
    const ents = fs.readdirSync(abs, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1));
    for (const ent of ents) {
      const childRel = rel ? `${rel}/${ent.name}` : ent.name;
      const childAbs = path.join(abs, ent.name);
      if (ent.isSymbolicLink()) {
        // 跨平台打不出符号链接：宁可显式失败，也不要把链接当普通文件打进包（内容会错）
        throw new Error(`tar: 不支持符号链接：${childRel}`);
      }
      const isDir = ent.isDirectory();
      if (skip(childRel, isDir)) continue;
      if (isDir) {
        addDir(childRel);
        walk(childRel, childAbs);
      } else if (ent.isFile()) {
        addFile(childRel, childAbs);
      }
    }
  };

  addDir('');
  walk('', root);
  chunks.push(Buffer.alloc(BLOCK * 2, 0)); // 归档结束：两个全零块
  return Buffer.concat(chunks);
}

/** 打 gzip 包到 `outFile`，返回压缩后字节数 */
function writeTarGz({ root, outFile, modeFor, mtime, skip }) {
  const tar = buildTar(root, { modeFor, mtime, skip });
  const gz = zlib.gzipSync(tar, { level: 6 });
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, gz);
  return gz.length;
}

module.exports = { buildTar, writeTarGz, splitPath, DEFAULT_MTIME, mtimeFromEnv };

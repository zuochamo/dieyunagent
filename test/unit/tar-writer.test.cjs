/* globals describe, it, expect, beforeEach, afterEach */
'use strict';

/**
 * `scripts/lib/tar-writer.cjs` 的单测。
 *
 * 为什么要为一个「写 tar」的小模块写测试：它是**手写的二进制格式**，写错了不会有异常，
 * 只会在目标机上装出「权限不对 / 长路径丢文件 / 解包截断」这类沉默故障。这里用一个
 * 独立的极简读取器把产物解回来逐字段核对，不依赖系统 tar。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const { buildTar, splitPath, DEFAULT_MTIME } = require('../../scripts/lib/tar-writer.cjs');

const BLOCK = 512;

/** 极简 ustar 读取器（只做本测需要的字段，含 GNU longname） */
function readEntries(buf) {
  const entries = [];
  let off = 0;
  let pendingLongName = null;
  while (off + BLOCK <= buf.length) {
    const header = buf.subarray(off, off + BLOCK);
    if (header.every((b) => b === 0)) break;
    const str = (start, len) => {
      const raw = header.subarray(start, start + len);
      const end = raw.indexOf(0);
      return raw.subarray(0, end === -1 ? raw.length : end).toString('utf8');
    };
    const name = str(0, 100);
    const prefix = str(345, 155);
    const size = parseInt(str(124, 12).trim() || '0', 8);
    const mode = parseInt(str(100, 8).trim() || '0', 8);
    const mtime = parseInt(str(136, 12).trim() || '0', 8);
    const type = str(156, 1) || '0';
    const uid = parseInt(str(108, 8).trim() || '0', 8);
    const gid = parseInt(str(116, 8).trim() || '0', 8);
    const magic = str(257, 6);

    // 校验和必须能在把 chksum 字段当空格后重现
    const declared = parseInt(str(148, 8).trim() || '-1', 8);
    const copy = Buffer.from(header);
    copy.write('        ', 148, 8, 'ascii');
    const sum = copy.reduce((a, b) => a + b, 0);

    const dataStart = off + BLOCK;
    off = dataStart + size + (size % BLOCK === 0 ? 0 : BLOCK - (size % BLOCK));

    if (type === 'L') {
      const raw = buf.subarray(dataStart, dataStart + size);
      const end = raw.indexOf(0);
      pendingLongName = raw.subarray(0, end === -1 ? raw.length : end).toString('utf8');
      continue;
    }

    const entryPath = pendingLongName || (prefix ? `${prefix}/${name}` : name);
    pendingLongName = null;
    entries.push({
      entryPath,
      size,
      mode,
      mtime,
      type,
      uid,
      gid,
      magic,
      checksumOk: declared === sum
    });
  }
  return entries;
}

describe('tar-writer', () => {
  let root;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'dieyun-tar-writer-'));
    fs.mkdirSync(path.join(root, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(root, 'bin', 'node'), 'fake-node');
    fs.writeFileSync(path.join(root, 'package.json'), '{}');
    // 超过 ustar name(100) 上限，必须走 prefix 拆分；注意**单个路径段**仍要 ≤100 字节
    // （ustar 表达不了一个超长文件名，那种情况写入器会明确报错，见下一个用例）
    const deep = path.join(root, 'node_modules', '@scope', 'pkg', 'dist', 'a'.repeat(60));
    fs.mkdirSync(deep, { recursive: true });
    fs.writeFileSync(path.join(deep, `${'b'.repeat(40)}.js`), 'x');
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('splitPath：短路径不拆，长路径按 / 拆成 prefix + name', () => {
    expect(splitPath('./a/b.js')).toEqual({ prefix: '', name: './a/b.js' });

    const long = `./${'x'.repeat(120)}/file.js`;
    const split = splitPath(long);
    expect(Buffer.byteLength(split.name)).toBeLessThanOrEqual(100);
    expect(Buffer.byteLength(split.prefix)).toBeLessThanOrEqual(155);
    expect(`${split.prefix}/${split.name}`).toBe(long);
  });

  it('单段超过 100 字节时 splitPath 返回 null（改用 GNU longname）', () => {
    const unsplittable = `./dir/${'y'.repeat(200)}.js`;
    expect(splitPath(unsplittable)).toBe(null);
  });

  it('单段超长的文件名走 GNU longname，仍能读回完整路径', () => {
    const longName = `${'z'.repeat(180)}.js`;
    fs.writeFileSync(path.join(root, longName), 'payload');
    const entries = readEntries(buildTar(root));
    const hit = entries.find((e) => e.entryPath === `./${longName}`);
    expect(hit).toBeTruthy();
    expect(hit.size).toBe(7);
    expect(Buffer.byteLength(hit.entryPath)).toBeGreaterThan(100);
  });

  it('产出可解析的 ustar：校验和、根目录项、uid/gid 归零、mtime 固定', () => {
    const buf = buildTar(root);
    const entries = readEntries(buf);

    expect(entries.length).toBeGreaterThan(0);
    expect(entries[0].entryPath).toBe('./');
    expect(entries[0].type).toBe('5');
    for (const e of entries) {
      expect(e.checksumOk).toBe(true);
      expect(e.magic).toBe('ustar');
      expect(e.uid).toBe(0);
      expect(e.gid).toBe(0);
      expect(e.mtime).toBe(DEFAULT_MTIME);
    }
    // 结尾必须是两个全零块，否则不少解包器会报「unexpected EOF」
    expect(buf.subarray(buf.length - BLOCK * 2).every((b) => b === 0)).toBe(true);
  });

  it('长路径用 prefix 拆开后仍能拼回原名', () => {
    const entries = readEntries(buildTar(root));
    const long = entries.find((e) => e.entryPath.includes('aaaa') && e.entryPath.endsWith('.js'));
    expect(long).toBeTruthy();
    expect(Buffer.byteLength(long.entryPath)).toBeGreaterThan(100);
  });

  it('modeFor 决定权限位：可执行文件 0755、普通文件 0644、目录 0755', () => {
    const exec = new Set(['bin/node']);
    const modeFor = (rel, isDir) => (isDir ? 0o755 : exec.has(rel) ? 0o755 : 0o644);
    const entries = readEntries(buildTar(root, { modeFor }));

    const byPath = new Map(entries.map((e) => [e.entryPath, e]));
    expect(byPath.get('./bin/node').mode).toBe(0o755);
    expect(byPath.get('./package.json').mode).toBe(0o644);
    expect(byPath.get('./bin/').mode).toBe(0o755);
  });

  it('显式 mtime 覆盖（可重复构建）', () => {
    const entries = readEntries(buildTar(root, { mtime: 1600000000 }));
    expect(entries.every((e) => e.mtime === 1600000000)).toBe(true);
  });

  it('skip 生效（平台相关的 node_modules/.bin 不进包）', () => {
    fs.mkdirSync(path.join(root, 'node_modules', '.bin'), { recursive: true });
    fs.writeFileSync(path.join(root, 'node_modules', '.bin', 'x.cmd'), 'rem');
    const skip = (rel, isDir) => isDir && rel.replace(/\\/g, '/') === 'node_modules/.bin';
    const entries = readEntries(buildTar(root, { skip }));
    expect(entries.some((e) => e.entryPath.includes('.bin'))).toBe(false);
  });
});

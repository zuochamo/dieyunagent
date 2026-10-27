'use strict';

/**
 * 工作区扫描（`src/gateway/artifact-scan.js`）：产物区的「盘上到底改过什么」来源。
 *
 * 这门逻辑过去在 rpc.js（本地）/ remote-fs.js（SFTP）/ minimal-gateway-host.js（远程）
 * 各写一份，排除表已经开始漂移。收敛成一份后，这里守住它的四条口径：
 * 1. `sinceMs` 窗口过滤（本会话产物 = 窗口内 mtime 变过的文件）；
 * 2. 排除目录（依赖 / 构建产物 / VCS）与 Office 锁文件不产生误报；
 * 3. 结果按 mtime 倒序并受 limit 约束；
 * 4. 深度上限与访问数上限（巨型工作区不能把一次面板刷新拖成秒级）。
 */

const assert = require('node:assert/strict');
const { scanRecentArtifactFiles, createLocalScanIo, ARTIFACT_SKIP_DIRS } = require('../../src/gateway/artifact-scan');

const T0 = 1_700_000_000_000;

/**
 * 假工作区：{ '/ws': { 'a.md': ts, 'sub/': {...}, 'node_modules/': {...} } }
 */
function makeIo(tree) {
  return {
    async readdir(dir) {
      const node = lookup(tree, dir);
      if (!node) throw new Error(`ENOENT ${dir}`);
      return Object.entries(node).map(([name, value]) => ({
        name,
        isDirectory: typeof value === 'object',
        isFile: typeof value !== 'object',
        mtimeMs: typeof value === 'object' ? undefined : value
      }));
    },
    join: (dir, name) => `${dir.replace(/\/+$/, '')}/${name}`,
    relative: (base, full) => full.slice(base.length + 1)
  };
}

function lookup(tree, dir) {
  const parts = String(dir)
    .split('/')
    .filter(Boolean);
  let node = tree;
  for (const part of parts) {
    if (!node || typeof node !== 'object') return null;
    node = node[part];
  }
  return typeof node === 'object' ? node : null;
}

describe('工作区扫描：时间窗与排除', () => {
  test('只返回 sinceMs 之后改过的文件', async () => {
    const io = makeIo({
      ws: {
        'old.md': T0 - 60_000,
        'new.md': T0 + 1000,
        'report.docx': T0 + 2000
      }
    });
    const res = await scanRecentArtifactFiles(io, { base: 'ws', sinceMs: T0, limit: 10 });
    assert.deepEqual(
      res.files.map((f) => f.relativePath),
      ['report.docx', 'new.md'],
      '按 mtime 倒序，窗口外的旧文件不出现'
    );
    assert.equal(res.total, 2);
    assert.equal(res.truncated, false);
  });

  test('sinceMs=0 表示不设窗口（老调用方口径）', async () => {
    const io = makeIo({ ws: { 'a.md': T0 - 60_000, 'b.md': T0 } });
    const res = await scanRecentArtifactFiles(io, { base: 'ws' });
    assert.equal(res.files.length, 2);
  });

  test('依赖 / 构建产物 / VCS 目录不进入扫描', async () => {
    for (const dir of ['node_modules', '.git', 'dist', 'build', 'target']) {
      assert.ok(ARTIFACT_SKIP_DIRS.has(dir), `${dir} 应在排除表里`);
    }
    const io = makeIo({
      ws: {
        'real.md': T0,
        node_modules: { 'dep.js': T0 },
        '.git': { HEAD: T0 },
        dist: { 'bundle.js': T0 }
      }
    });
    const res = await scanRecentArtifactFiles(io, { base: 'ws', limit: 20 });
    assert.deepEqual(
      res.files.map((f) => f.relativePath),
      ['real.md']
    );
  });

  test('Office 锁文件（~$xxx.docx）不算产物', async () => {
    const io = makeIo({ ws: { '~$报告.docx': T0, '报告.docx': T0 - 1000 } });
    const res = await scanRecentArtifactFiles(io, { base: 'ws' });
    assert.deepEqual(
      res.files.map((f) => f.relativePath),
      ['报告.docx']
    );
  });
});

describe('工作区扫描：边界与预算', () => {
  test('子目录里的产物按相对路径返回（docx 常在 reports/ 下）', async () => {
    const io = makeIo({ ws: { reports: { q3: { 'report.xlsx': T0 } } } });
    const res = await scanRecentArtifactFiles(io, { base: 'ws' });
    assert.deepEqual(
      res.files.map((f) => f.relativePath),
      ['reports/q3/report.xlsx']
    );
  });

  test('超过 maxDepth 的目录不再下钻', async () => {
    const io = makeIo({ ws: { a: { b: { c: { 'deep.md': T0 } } } } });
    const shallow = await scanRecentArtifactFiles(io, { base: 'ws', maxDepth: 1 });
    assert.equal(shallow.files.length, 0);
    const deep = await scanRecentArtifactFiles(io, { base: 'ws', maxDepth: 3 });
    assert.equal(deep.files.length, 1);
  });

  test('limit 截断取最新的若干条', async () => {
    const io = makeIo({
      ws: { 'a.md': T0, 'b.md': T0 + 1, 'c.md': T0 + 2 }
    });
    const res = await scanRecentArtifactFiles(io, { base: 'ws', limit: 2 });
    assert.deepEqual(
      res.files.map((f) => f.relativePath),
      ['c.md', 'b.md']
    );
    assert.equal(res.total, 3, 'total 是命中总数，便于上层知道被截断')
  });

  test('读不动的目录（无权限 / 已删除）只跳过，不打断整次扫描', async () => {
    const io = makeIo({ ws: { 'ok.md': T0 } });
    const broken = {
      ...io,
      async readdir(dir) {
        if (dir === 'ws/locked') throw new Error('EACCES');
        return io.readdir(dir);
      }
    };
    const res = await scanRecentArtifactFiles(broken, { base: 'ws/locked' });
    assert.deepEqual(res.files, []);
    const ok = await scanRecentArtifactFiles(broken, { base: 'ws' });
    assert.deepEqual(
      ok.files.map((f) => f.relativePath),
      ['ok.md']
    );
  });

  test('基础路径为空 → 返回空结果（不抛）', async () => {
    const res = await scanRecentArtifactFiles(makeIo({}), { base: '' });
    assert.deepEqual(res.files, []);
  });
});

describe('工作区扫描：本地 io 适配器', () => {
  test('真实目录可读，并带出 mtime/size', async () => {
    const os = require('node:os');
    const fs = require('node:fs');
    const path = require('node:path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dieyun-scan-'));
    try {
      fs.writeFileSync(path.join(dir, 'report.docx'), 'x');
      fs.mkdirSync(path.join(dir, 'node_modules'));
      fs.writeFileSync(path.join(dir, 'node_modules', 'dep.js'), 'x');
      const res = await scanRecentArtifactFiles(createLocalScanIo(), { base: dir, sinceMs: Date.now() - 60_000 });
      assert.deepEqual(
        res.files.map((f) => f.relativePath.replace(/\\/g, '/')),
        ['report.docx']
      );
      assert.ok(res.files[0].mtimeMs > 0);
      assert.equal(res.files[0].size, 1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

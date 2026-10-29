'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const {
  isIgnoredRelPath,
  isCodebaseSourcePath,
  isGraphSourcePath,
  isUnderWorkspaceRoot,
  GRAPH_SOURCE_EXT
} = require('../../src/index/source-files.js');

describe('source-files：索引范围的唯一口径', () => {
  it('结构索引只认 tree-sitter 能解析的语言', () => {
    for (const p of ['a.js', 'a.mjs', 'a.cjs', 'a.jsx', 'a.ts', 'a.tsx', 'a.py', 'a.go', 'a.rs']) {
      assert.equal(isGraphSourcePath(p), true, p);
    }
    // Rust 侧 SourceLang 没有这些：不许触发结构索引增量
    for (const p of ['a.java', 'a.cs', 'a.cpp', 'a.vue', 'a.mts', 'a.md']) {
      assert.equal(isGraphSourcePath(p), false, p);
    }
    assert.equal(GRAPH_SOURCE_EXT.size, 9);
  });

  it('代码索引只排除明确二进制，未知扩展名照触发（交给 Rust 嗅探）', () => {
    assert.equal(isCodebaseSourcePath('a.rs'), true);
    assert.equal(isCodebaseSourcePath('a.unknownext'), true);
    assert.equal(isCodebaseSourcePath('Dockerfile'), true);
    assert.equal(isCodebaseSourcePath('.env.local'), true);
    assert.equal(isCodebaseSourcePath('a.png'), false);
    assert.equal(isCodebaseSourcePath('a.sqlite'), false);
  });

  it('内容里带 NUL 的文件按二进制处理', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'source-files-'));
    try {
      const bin = path.join(dir, 'blob.unknownext');
      fs.writeFileSync(bin, Buffer.from([0x41, 0x00, 0x42]));
      assert.equal(isCodebaseSourcePath(bin), false);
      const text = path.join(dir, 'note.unknownext');
      fs.writeFileSync(text, 'hello 世界\n');
      assert.equal(isCodebaseSourcePath(text), true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('watcher 粗过滤：跳过依赖目录与二进制，放行带扩展名的 dotfile', () => {
    assert.equal(isIgnoredRelPath('node_modules/x/index.js'), true);
    assert.equal(isIgnoredRelPath('target/debug/a.rs'), true);
    assert.equal(isIgnoredRelPath('.git/HEAD'), true);
    assert.equal(isIgnoredRelPath('assets/logo.png'), true);
    assert.equal(isIgnoredRelPath('src/app.js'), false);
    assert.equal(isIgnoredRelPath('.eslintrc.js'), false, '源码级 dotfile 必须放行');
    assert.equal(isIgnoredRelPath('.DS_Store'), true, '无扩展名隐藏文件忽略');
  });

  it('工作区边界判定', () => {
    const root = path.resolve('/ws/root');
    assert.equal(isUnderWorkspaceRoot(path.join(root, 'a.js'), root), true);
    assert.equal(isUnderWorkspaceRoot(root, root), true);
    assert.equal(isUnderWorkspaceRoot(path.resolve('/ws/other/a.js'), root), false);
    assert.equal(isUnderWorkspaceRoot('', root), false);
  });
});

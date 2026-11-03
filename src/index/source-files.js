'use strict';

const fs = require('fs');
const path = require('path');

/**
 * 「这个文件要不要进索引」在 Node 侧的唯一来源。
 *
 * 权威口径始终在 Rust：`crates/dieyun-core/src/index/walker.rs`（代码索引，认所有文本）
 * 与 `crates/dieyun-core/src/graph/extract/files.rs` + `treesitter/lang.rs`（结构索引，
 * 只认 tree-sitter 能解析的 6 种语言）。这里只回答「一次保存要不要触发一次增量」，
 * 属粗过滤：**宁可多报，不许漏报**（多报由 Rust 侧跳过，漏报就是索引静默不更新）。
 *
 * 这几个判定原来散在五处（watcher 粗过滤 / codebase 增量 / graph 增量 / 远程宿主 /
 * 网关解析远程 grep 输出），口径一旦不一致，症状是「代码索引更新了、结构索引没更新」
 * 这种极难查的错位。
 */

/**
 * 永不扫描的目录。
 *
 * = Rust `walker.rs:IGNORE_DIRS`（两边共同的那 10 条）**∪ 隐藏目录**。
 * Rust 侧不列 `.git` / `.dieyun` / `.venv` / `.next` / `.nuxt`：`ignore` crate 默认跳过隐藏项，
 * 那边再列一遍只会两份漂移。Node 侧（watcher 的相对路径判定、rg / glob 的自遍历）没有这个
 * 默认行为，所以必须自己列。`test/unit/ignore-rules-parity.test.cjs` 校验
 * 「非隐藏项与 Rust 完全一致，隐藏项只许多不许少」。
 */
const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'out',
  '.dieyun',
  'coverage',
  '__pycache__',
  '.venv',
  'venv',
  '.next',
  '.nuxt',
  'target',
  'vendor',
  'win-unpacked'
]);

/**
 * 明确的二进制扩展名（与 `walker.rs:IGNORE_EXT` 逐条对齐，同样由 parity 测校验）：
 * 连触发都免了。
 */
const BINARY_EXT = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.ico',
  '.bmp',
  '.svg',
  '.psd',
  '.ai',
  '.zip',
  '.7z',
  '.rar',
  '.gz',
  '.tgz',
  '.bz2',
  '.xz',
  '.tar',
  '.exe',
  '.dll',
  '.so',
  '.dylib',
  '.bin',
  '.o',
  '.obj',
  '.a',
  '.lib',
  '.wasm',
  '.pdf',
  '.doc',
  '.docx',
  '.xls',
  '.xlsx',
  '.ppt',
  '.pptx',
  '.woff',
  '.woff2',
  '.ttf',
  '.otf',
  '.eot',
  '.mp4',
  '.mp3',
  '.wav',
  '.avi',
  '.mov',
  '.mkv',
  '.webm',
  '.flac',
  '.sqlite',
  '.db',
  '.mdb',
  '.pyc',
  '.pyo',
  '.class',
  '.jar',
  '.apk',
  '.dmg',
  '.iso'
]);

/** 结构索引能解析的语言（与 `treesitter/lang.rs` 的 `SourceLang` 同一组）。 */
const GRAPH_SOURCE_EXT = new Set(['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.py', '.go', '.rs']);

/**
 * watcher 用的相对路径粗过滤：命中即完全不看这个文件。
 *
 * 带扩展名的 dotfile（`.eslintrc.js` / `.babelrc.js` 这类源码级配置）要放行，
 * 只忽略无扩展名的隐藏文件（`.DS_Store` 等）。
 */
function isIgnoredRelPath(rel) {
  const norm = String(rel || '').replace(/\\/g, '/');
  if (!norm) return true;
  const parts = norm.split('/');
  for (const seg of parts.slice(0, -1)) {
    if (IGNORED_DIRS.has(seg) || seg.startsWith('.')) return true;
  }
  const base = parts[parts.length - 1];
  if (!base) return true;
  const ext = path.extname(base).toLowerCase();
  if (!ext) return base.startsWith('.');
  return BINARY_EXT.has(ext);
}

/**
 * 保存后是否触发代码索引增量：只排除明确二进制，未知扩展名交给 Rust walker 的内容嗅探。
 * 文件可能刚被删（读不到）：仍返回 true，让后端侧忽略。
 */
function isCodebaseSourcePath(filePath) {
  const p = String(filePath || '');
  const ext = path.extname(p).toLowerCase();
  if (ext && BINARY_EXT.has(ext)) return false;
  const base = path.basename(p);
  if (base === 'Dockerfile' || base === 'Makefile' || base.startsWith('.env')) return true;
  if (!ext) return true;
  try {
    const fd = fs.openSync(p, 'r');
    try {
      const buf = Buffer.alloc(512);
      const n = fs.readSync(fd, buf, 0, 512, 0);
      if (n <= 0) return false;
      for (let i = 0; i < n; i++) {
        if (buf[i] === 0) return false;
      }
      return true;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return true;
  }
}

/** 保存后是否触发结构索引增量：只有解析器覆盖的语言才有意义。 */
function isGraphSourcePath(filePath) {
  return GRAPH_SOURCE_EXT.has(path.extname(String(filePath || '')).toLowerCase());
}

/** 路径是否落在工作区内（含工作区根自己）。 */
function isUnderWorkspaceRoot(filePath, workspaceRoot) {
  if (!filePath || !workspaceRoot) return false;
  const rel = path.relative(path.resolve(workspaceRoot), path.resolve(filePath));
  if (rel === '') return true;
  return Boolean(rel) && !rel.startsWith('..') && !path.isAbsolute(rel);
}

module.exports = {
  GRAPH_SOURCE_EXT,
  IGNORED_DIRS,
  BINARY_EXT,
  isIgnoredRelPath,
  isCodebaseSourcePath,
  isGraphSourcePath,
  isUnderWorkspaceRoot
};

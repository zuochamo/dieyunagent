'use strict';

/**
 * 「哪些文件不该被扫」的两份清单必须对得上：Rust `index/walker.rs` 与 Node
 * `index/source-files.js`。
 *
 * 为什么必须有这条机器校验：这两份名单跨语言，没法 `require` 到彼此。历史上它们已经漂过一次
 * —— `gateway/rg-search.js` 自带的那份扩展名表只有 Rust 的一半，于是 grep/glob 会把
 * `.docx` / `.xlsx` / `.tar` 当文本返回，而同一份工作区的代码索引进不去。症状是
 * 「搜得到、索引里没有」，没人会想到是两份表不一致。
 *
 * 规则（不是简单相等，而是**各自该有的关系**）：
 * - `BINARY_EXT` ↔ `IGNORE_EXT`：**完全相等**。两边都是「明确二进制」，没有理由不同。
 * - `IGNORED_DIRS` ⊇ `IGNORE_DIRS`：Rust 侧依赖 `ignore` crate 默认跳过隐藏目录，
 *   所以它的名单里没有 `.git` / `.venv` / `.next`；Node 侧没有这个默认行为，必须自己列。
 * - 因此 Node 多出来的目录必须**全是隐藏目录**（`.` 开头）——多出非隐藏目录就是漂移，
 *   说明有人只改了一边。
 */

const fs = require('fs');
const path = require('path');
const { IGNORED_DIRS, BINARY_EXT } = require('../../src/index/source-files');

const WALKER_RS = path.join(__dirname, '..', '..', 'crates', 'dieyun-core', 'src', 'index', 'walker.rs');

function readWalker() {
  return fs.readFileSync(WALKER_RS, 'utf8');
}

/** 抽出 `const NAME: &[&str] = &[ ... ];` 里的字符串字面量。 */
function parseRustStrArray(src, name) {
  const m = new RegExp(`const\\s+${name}\\s*:\\s*&\\[&str\\]\\s*=\\s*&\\[([\\s\\S]*?)\\];`).exec(src);
  if (!m) throw new Error(`walker.rs 里找不到 ${name}`);
  return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
}

const onlyIn = (a, b) => [...a].filter((x) => !b.has(x)).sort();

describe('忽略规则两份清单一致（Rust walker.rs ↔ Node source-files.js）', () => {
  const src = readWalker();
  const rustExt = new Set(parseRustStrArray(src, 'IGNORE_EXT'));
  const rustDirs = new Set(parseRustStrArray(src, 'IGNORE_DIRS'));

  test('两边都真的读到了清单（防止解析失败被当成"一致"）', () => {
    expect(rustExt.size).toBeGreaterThan(20);
    expect(rustDirs.size).toBeGreaterThan(5);
    expect(BINARY_EXT.size).toBeGreaterThan(20);
  });

  test('二进制扩展名两边完全相等', () => {
    expect(onlyIn(rustExt, BINARY_EXT)).toEqual([]); // Rust 认的，Node 也要认
    expect(onlyIn(BINARY_EXT, rustExt)).toEqual([]); // Node 认的，Rust 也要认
  });

  test('目录名单：Rust 的每一条 Node 都要有', () => {
    expect(onlyIn(rustDirs, IGNORED_DIRS)).toEqual([]);
  });

  test('Node 多出来的目录只能是隐藏目录（ignore crate 缺失的默认行为）', () => {
    const extra = onlyIn(IGNORED_DIRS, rustDirs);
    expect(extra.filter((d) => !d.startsWith('.'))).toEqual([]);
  });
});

'use strict';

/**
 * 远程 Agent 打包闭包校验（2026-10-18 事故）。
 *
 * 事故形态：`src/lsp/spawn-args.js` 从 `lsp-client.js` 里抽出来做「命令行拼装唯一来源」，
 * 但没有同步加进 `REMOTE_GATEWAY_SOURCE_PATHS`。本地一切正常（文件在仓库里），
 * 远程注入时才在 smoke 阶段炸 `Cannot find module './spawn-args'`；
 * 而且 hash 是按同一份清单算的，远程包 hash 与本地相等 → 判定「已存在、跳过上传」，
 * 修一行代码也刷不掉坏包。
 *
 * 因此校验不能靠「人记得往清单里加」：这里对清单内文件做相对 require 的传递闭包，
 * 任何一个被 require 却不在清单里的文件都必须在 CI 阶段就失败。
 */

const fs = require('fs');
const path = require('path');
const { REMOTE_GATEWAY_SOURCE_PATHS } = require('../../src/remote/remote-pack-layout');

const ROOT = path.join(__dirname, '..', '..');
const REQUIRE_RE = /\brequire\(\s*(['"])(\.[^'"]*)\1\s*\)/g;
const RESOLVE_SUFFIXES = ['', '.js', '.json', '.cjs', '/index.js'];

function resolveRelative(fromAbs, spec) {
  const base = path.resolve(path.dirname(fromAbs), spec);
  for (const suffix of RESOLVE_SUFFIXES) {
    const candidate = base + suffix;
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      // 继续尝试下一个后缀
    }
  }
  return '';
}

function relativeRequires(absPath) {
  let text = '';
  try {
    text = fs.readFileSync(absPath, 'utf8');
  } catch {
    return [];
  }
  const specs = [];
  let m;
  REQUIRE_RE.lastIndex = 0;
  while ((m = REQUIRE_RE.exec(text))) specs.push(m[2]);
  return specs;
}

/** @returns {{ missing: string[], unresolved: string[] }} */
function inspectClosure(root, rels) {
  const packed = new Set(rels.map((rel) => path.resolve(root, rel)));
  const missing = new Set();
  const unresolved = new Set();
  const queue = [...packed];
  while (queue.length) {
    const abs = queue.shift();
    for (const spec of relativeRequires(abs)) {
      const target = resolveRelative(abs, spec);
      if (!target) {
        unresolved.add(`${path.relative(root, abs)} -> ${spec}`);
        continue;
      }
      if (packed.has(target)) continue;
      missing.add(path.relative(root, target).replace(/\\/g, '/'));
      packed.add(target);
      queue.push(target);
    }
  }
  return { missing: [...missing].sort(), unresolved: [...unresolved].sort() };
}

describe('远程 Agent 打包闭包', () => {
  it('清单内文件都存在', () => {
    const absent = REMOTE_GATEWAY_SOURCE_PATHS.filter((rel) => {
      try {
        return !fs.statSync(path.join(ROOT, rel)).isFile();
      } catch {
        return true;
      }
    });
    expect(absent).toEqual([]);
  });

  it('清单内文件的相对 require 全部被清单覆盖', () => {
    const { missing, unresolved } = inspectClosure(ROOT, REMOTE_GATEWAY_SOURCE_PATHS);
    expect(unresolved).toEqual([]);
    expect(missing).toEqual([]);
  });
});

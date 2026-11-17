'use strict';

/**
 * 「跨语言常量」闸门：`assets/agent-shared.json` 里的每个键，Node 与 Rust **两侧都必须真的读到**。
 *
 * 为什么需要它：这份文件是为了消灭「同一份知识两份手抄」而存在的。如果某个键只有一侧读，
 * 它就从「单一来源」退化成了「又一份孤儿常量」—— 而孤儿常量永远不会在测试里变红，直到线上
 * 出现「设置里改了不生效」或「两侧算法不一致」。历史上 token 系数、预算地板、溢出词表都
 * 这样漂过一次（见 docs/audit/2026-11-rust-core/runtime.md F9、agent.md F3）。
 *
 * 另外两条也会被挡：
 * 1. 除 `shared-constants.js` 之外，任何 Node 文件直接 require 这份 JSON —— 绕过冻结包装，
 *    改起来没人知道谁在用；
 * 2. headless 包（`scripts/pack-headless.cjs` 的 EXTRA_FILES）没列这份文件 —— Linux 包会在
 *    运行期 require 失败，而 dev 环境完全看不出来。
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SHARED_PATH = path.join(ROOT, 'assets', 'agent-shared.json');
const JS_ROOTS = ['src', 'test'];
const RS_ROOT = path.join('crates', 'dieyun-core', 'src');

/**
 * 允许「只有一侧读」的键，必须写清理由。
 *
 * 判据：这个键本身不是独立数值，而是**另一侧的约束**（关系型），或读点在
 * `shared.rs` 自己提供的换算函数里。除此之外一律要求两侧都有读者。
 */
const ONE_SIDE_OK = {
  'tokenEstimate.imagePartEqChars':
    'Rust 经 shared::image_part_equiv_tokens() 换算成 token 后用，读点在 shared.rs 内部',
  'compaction.contextWindowFloorTokens':
    'Rust 只在关系断言里读它（内核预算守卫必须 ≤ 窗口地板），没有独立用处',
  'snippets.codebaseSnippetMaxChars':
    'Rust 只在关系断言里读它（Rust 摘录预算必须大于 Node 展示预算）'
};

function walkLeaves(node, prefix, out) {
  if (Array.isArray(node)) {
    out.push({ key: prefix.split('.').pop(), dotted: prefix });
    return;
  }
  if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if (k.startsWith('$')) continue;
      walkLeaves(v, prefix ? `${prefix}.${k}` : k, out);
    }
    return;
  }
  out.push({ key: prefix.split('.').pop(), dotted: prefix });
}

function collect(dir) {
  const out = [];
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    for (const entry of fs.readdirSync(cur, { withFileTypes: true })) {
      const abs = path.join(cur, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === 'dist') continue;
        stack.push(abs);
        continue;
      }
      if (!/\.(js|cjs|mjs|rs)$/.test(entry.name)) continue;
      out.push({ rel: path.relative(ROOT, abs).replace(/\\/g, '/'), text: fs.readFileSync(abs, 'utf8') });
    }
  }
  return out;
}

const toSnake = (name) => name.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

function main() {
  const errors = [];
  const data = JSON.parse(fs.readFileSync(SHARED_PATH, 'utf8'));

  const leaves = [];
  walkLeaves(data, '', leaves);

  const jsSources = JS_ROOTS.flatMap((p) => collect(path.join(ROOT, p))).filter(
    (f) => f.rel !== 'src/agent/shared-constants.js'
  );
  const rsSources = collect(path.join(ROOT, RS_ROOT)).filter(
    (f) => f.rel !== 'crates/dieyun-core/src/shared.rs'
  );

  for (const leaf of leaves) {
    const allowed = ONE_SIDE_OK[leaf.dotted];
    const jsHit = jsSources.find((f) => f.text.includes(leaf.key));
    const rsHit = rsSources.find((f) => f.text.includes(toSnake(leaf.key)));
    if (!jsHit && !(allowed && rsHit)) {
      errors.push(`agent-shared.json: ${leaf.dotted} 没有 Node 侧读者（键名 ${leaf.key}）`);
    }
    if (!rsHit && !(allowed && jsHit)) {
      errors.push(`agent-shared.json: ${leaf.dotted} 没有 Rust 侧读者（键名 ${toSnake(leaf.key)}）`);
    }
  }

  // 只有包装层可以直接 require 这份 JSON
  for (const f of collect(path.join(ROOT, 'src'))) {
    if (f.rel === 'src/agent/shared-constants.js') continue;
    if (/require\(\s*['"][^'"]*agent-shared\.json['"]\s*\)/.test(f.text)) {
      errors.push(`${f.rel} 直接 require 了 assets/agent-shared.json（必须经 src/agent/shared-constants.js）`);
    }
  }

  // headless 包要列进 EXTRA_FILES，否则 Linux 包运行期 require 失败
  const packHeadless = fs.readFileSync(path.join(ROOT, 'scripts', 'pack-headless.cjs'), 'utf8');
  if (!packHeadless.includes('assets/agent-shared.json')) {
    errors.push('scripts/pack-headless.cjs 的 EXTRA_FILES 里没有 assets/agent-shared.json（headless 包会 require 失败）');
  }

  // 远端 Agent 的打包清单同理（哈希按清单算，漏了反而判「已存在、跳过上传」）
  const remoteLayout = fs.readFileSync(path.join(ROOT, 'src', 'remote', 'remote-pack-layout.js'), 'utf8');
  if (!remoteLayout.includes('assets/agent-shared.json')) {
    errors.push('src/remote/remote-pack-layout.js 的 REMOTE_GATEWAY_SOURCE_PATHS 里没有 assets/agent-shared.json（远端 daemon 加载即崩）');
  }

  if (errors.length) {
    console.error('[dieyun:shared] 跨语言常量闸门未通过：');
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(1);
  }
  console.log(`[dieyun:shared] OK: ${leaves.length} 个键两侧都有人读`);
}

main();

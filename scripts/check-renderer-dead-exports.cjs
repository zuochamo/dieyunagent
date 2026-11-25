'use strict';

/**
 * 渲染层「零调用点导出」闸门（docs/NODE-THINNING-PLAN.md §N4.1 落地）。
 *
 * 为什么需要它：`check-renderer-globals.py` 只做**单向**校验（每个 `window.X = …` 要能解析到
 * 一个真实存在的声明），从不问反过来的问题 —— **有人用吗**。于是删剩的函数能一直绿着，
 * `renderer-agent-llm.js` / `renderer-agent-loop.js` 的历史遗留就是这么留下的；2026-11-21 的
 * 整洁度审查又从同一口井里捞出 20 处（约 245 行）。
 *
 * 口径（静态、可判定，不猜意图）：
 * 1. 扫描范围 = `src/renderer/index.html` 里 `<script src>` 加载的源码（跳过 `dist/` 生成物与
 *    `node_modules/`）；
 * 2. 候选 = 这些文件的顶层 `function` / `const|let|var` 声明，以及 `window.X = …` 导出；
 * 3. 调用点计数 = 在「这些源码 + index.html（含内联 onclick 等）+ `scripts/` + `test/`」里，
 *    以标识符边界出现的次数；
 * 4. 判死：**除声明/导出那一处外，全仓 0 次**。函数声明要求「自己文件里也只有声明那一次」；
 *    `window.X` 导出要求「X 在任何地方只出现一次」（内部用函数名不算用了这个导出）。
 *
 * 动态引用（`window[name]()`、原生回调、单测注入）走白名单：
 * `scripts/renderer-dead-exports-allow.json`，**每条必须写理由**；白名单里已经不再「死」的条目
 * 会让本闸门报错，避免白名单变成垃圾桶。
 *
 * 用法：
 *   node scripts/check-renderer-dead-exports.cjs            # 严格模式（有发现即 exit 1）
 *   node scripts/check-renderer-dead-exports.cjs --report   # 只报告，exit 0
 *
 * 已知盲区（别把它当全仓死代码证明）：
 * - 只覆盖 `index.html` 直接加载的脚本。`src/renderer/agent/` 那批走 `agent-bundle-entry.js`
 *   打进 `dist/agent-bundle.js`，导出经 `DieyunNamespaces.register({ ... })` 成对象 ——
 *   对象字面量里出现名字就算「被引用」，本闸门在那里判不出死导出。
 * - 名字被拼字符串动态取用时（`window[name]()`、原生回调）必须是白名单，白名单写错方向
 *   （为了过闸门而加）比不建闸门更坏。
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const RENDERER = path.join(ROOT, 'src', 'renderer');
const INDEX = path.join(RENDERER, 'index.html');
const ALLOW_PATH = path.join(__dirname, 'renderer-dead-exports-allow.json');

const reportOnly = process.argv.includes('--report');

/** 与 check-renderer-globals.py 相同的解析规则（`./` → renderer，`../` → src，其余 → 仓库根）。 */
function resolveScripts(html) {
  const out = [];
  for (const m of html.matchAll(/src="([^"]+\.js)"/g)) {
    const src = m[1];
    if (src.includes('node_modules/')) continue;
    if (/^\.\/dist\//.test(src)) continue; // 生成物（agent-bundle.js 等），源码不在此扫
    if (src.startsWith('./')) out.push(path.join(RENDERER, src.slice(2)));
    else if (src.startsWith('../')) out.push(path.join(ROOT, 'src', src.slice(3)));
    else out.push(path.join(ROOT, src));
  }
  return out;
}

/** 收集仓库里的参照语料：渲染层源码 + index.html + scripts/ + test/。 */
function collectCorpus(scriptFiles, html) {
  const parts = [html];
  for (const f of scriptFiles) parts.push(fs.readFileSync(f, 'utf8'));
  const extra = [];
  for (const dir of ['scripts', 'test']) {
    const base = path.join(ROOT, dir);
    const walk = (d) => {
      for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, ent.name);
        if (ent.isDirectory()) {
          if (['node_modules', 'dist', 'fixtures-cache'].includes(ent.name)) continue;
          walk(p);
        } else if (/\.(cjs|mjs|js|html)$/.test(ent.name)) {
          if (p === __filename) continue; // 本闸门自己的正则不算调用点
          if (ent.name === 'renderer-dead-exports-allow.json') continue;
          extra.push(fs.readFileSync(p, 'utf8'));
        }
      }
    };
    walk(base);
  }
  return { own: parts, extra };
}

const html = fs.readFileSync(INDEX, 'utf8');
const scriptFiles = resolveScripts(html);
const corpus = collectCorpus(scriptFiles, html);

/** 标识符边界匹配（`$` 这类名字不能用 `\b`）。 */
function countRefs(name, text) {
  const re = new RegExp('(^|[^\\w$])' + name.replace(/\$/g, '\\$') + '(?![\\w$])', 'g');
  return (text.match(re) || []).length;
}

const allow = fs.existsSync(ALLOW_PATH)
  ? JSON.parse(fs.readFileSync(ALLOW_PATH, 'utf8'))
  : { allow: [] };
const allowByName = new Map((allow.allow || []).map((e) => [`${e.file}::${e.name}`, e]));

const findings = [];
const usedAllow = new Set();

// 「同一文件之外的语料」只算一次：scripts/ + test/ + index.html + 其它脚本源码
const scriptSources = new Map();
for (const f of scriptFiles) {
  if (fs.existsSync(f)) scriptSources.set(f, fs.readFileSync(f, 'utf8'));
}
const sharedOutside = corpus.extra.concat([html]).join('\n');

for (const file of scriptFiles) {
  if (!scriptSources.has(file)) continue;
  const rel = path.relative(ROOT, file).replace(/\\/g, '/');
  const ownText = scriptSources.get(file);
  let outsideText = sharedOutside;
  for (const [other, text] of scriptSources) {
    if (other !== file) outsideText += '\n' + text;
  }

  const decls = new Map(); // name -> { kind: 'function'|'binding' }
  for (const m of ownText.matchAll(/^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/gm)) {
    decls.set(m[1], { kind: 'function' });
  }
  for (const m of ownText.matchAll(/^(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/gm)) {
    if (!decls.has(m[1])) decls.set(m[1], { kind: 'binding' });
  }

  for (const [name, meta] of decls) {
    // 声明本身算 1 次；`own <= 1` = 自己文件里也只有声明那一处
    const own = countRefs(name, ownText);
    const out = countRefs(name, outsideText);
    if (own <= 1 && out === 0) findings.push({ file: rel, name, kind: meta.kind, own, out });
  }

  // window.X 导出：X 在全仓只出现一次 = 只有这次赋值，没人读
  for (const m of ownText.matchAll(/window\.([A-Za-z_$][\w$]*)\s*=/g)) {
    const name = m[1];
    const total = countRefs(name, ownText) + countRefs(name, outsideText);
    if (total <= 1) {
      findings.push({ file: rel, name, kind: 'window-export', own: 1, out: 0 });
    }
  }
}

// 去重（同一 name 可能在函数声明与 window 导出里各命中一次）
const seen = new Set();
const uniq = [];
for (const f of findings) {
  const key = `${f.file}::${f.name}`;
  if (seen.has(key)) continue;
  seen.add(key);
  uniq.push(f);
}

const stale = [];
const real = [];
for (const f of uniq) {
  const key = `${f.file}::${f.name}`;
  if (allowByName.has(key)) {
    usedAllow.add(key);
    continue;
  }
  real.push(f);
}

const invalidAllow = [...allowByName.values()].filter((e) => !String(e.reason || '').trim());

/**
 * 第二类检查：**index.html 的脚本不许声明与 agent-bundle 的 window 导出同名的顶层绑定**。
 *
 * 为什么必须有这条：经典 `<script>` 的顶层 `function f(){}` 会在脚本实例化时**覆盖** window.f。
 * 于是「写一个同名的薄壳去调 window.f」这种写法会自己调自己 —— 直接无限递归。
 * 2026-11-21 合流工具结果摘要时就是这样踩到的：`renderer-tool-results.js` 声明了
 * `function summarizeToolResult(){ return window.summarizeToolResult(...) }`，而 agent-bundle
 * 早已把 `window.summarizeToolResult` 设成共享实现 —— 一旦运行就是栈溢出。
 * 正确写法是**不声明同名壳**：需要时直接读 `window.X`（或在文件内换个名字）。
 */
const bundleEntryPath = path.join(RENDERER, 'agent', 'agent-bundle-entry.js');
const bundleCompat = new Set();
if (fs.existsSync(bundleEntryPath)) {
  const entry = fs.readFileSync(bundleEntryPath, 'utf8');
  for (const m of entry.matchAll(/compat:\s*\[([\s\S]*?)\]/g)) {
    for (const n of m[1].matchAll(/'([A-Za-z_$][\w$]*)'/g)) bundleCompat.add(n[1]);
  }
}
const shadows = [];
for (const file of scriptFiles) {
  if (!scriptSources.has(file)) continue;
  const rel = path.relative(ROOT, file).replace(/\\/g, '/');
  const ownText = scriptSources.get(file);
  const declared = new Set();
  for (const m of ownText.matchAll(/^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/gm)) declared.add(m[1]);
  for (const m of ownText.matchAll(/^(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/gm)) declared.add(m[1]);
  for (const name of declared) {
    if (!bundleCompat.has(name)) continue;
    const key = `${rel}::${name}`;
    if (allowByName.has(key)) {
      usedAllow.add(key);
      continue;
    }
    shadows.push({ file: rel, name });
  }
}
// 允许清单里「影子声明」条目不再成立时同样算 stale
for (const key of allowByName.keys()) {
  if (usedAllow.has(key)) continue;
  stale.push(key);
}

console.log(`[dieyun:renderer-dead-exports] 扫描 ${scriptFiles.length} 个 index.html 脚本，候选 ${uniq.length} 处，bundle 导出 ${bundleCompat.size} 个`);

if (invalidAllow.length) {
  console.error('FAIL: 白名单条目必须写 reason：');
  for (const e of invalidAllow) console.error(`  - ${e.file}::${e.name}`);
}

if (stale.length) {
  console.error('FAIL: 白名单里有条目已经不再「零调用点」，请从 renderer-dead-exports-allow.json 删掉：');
  for (const k of stale) console.error(`  - ${k}`);
}

if (real.length) {
  const label = reportOnly ? 'REPORT' : 'FAIL';
  console.error(`${label}: ${real.length} 处顶层声明全仓零调用点（删掉，或在白名单里写清为什么是动态引用）：`);
  for (const f of real) {
    console.error(`  - ${f.file}  ${f.name}  (${f.kind})`);
  }
} else {
  console.log('[dieyun:renderer-dead-exports] OK（无零调用点声明）');
}

if (shadows.length) {
  const label = reportOnly ? 'REPORT' : 'FAIL';
  console.error(`${label}: ${shadows.length} 处顶层声明与 agent-bundle 的 window 导出同名（会把它覆盖掉 → 同名薄壳会自己调自己）：`);
  for (const s of shadows) {
    console.error(`  - ${s.file}  ${s.name}  （要么删掉这个壳直接读 window.X，要么改名）`);
  }
} else {
  console.log('[dieyun:renderer-dead-exports] OK（没有覆盖 bundle 同名导出）');
}

const failed = real.length > 0 || shadows.length > 0 || stale.length > 0 || invalidAllow.length > 0;
process.exit(failed && !reportOnly ? 1 : 0);

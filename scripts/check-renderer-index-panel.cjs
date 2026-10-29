'use strict';

// 「索引」面板一致性护栏：代码片段索引（codebase.*）与结构索引（graph.*）共用
// 同一个侧栏页签（tab index）与同一块 DOM。合并后最容易回归的三件事：
//   1. 有人把 rail/pane 的 data-side-tab 改回 codebase / graph（页面半残）；
//   2. 面板 JS 引用了已改名的 DOM id（点击按钮无反应，且不报错）；
//   3. rail 与 pane 的页签数量对不上（切过去是空白页）。
// 这些都是纯静态可判定的，放在 check:renderer 里跑。

const fs = require('fs');
const path = require('path');

const RENDERER = path.join(__dirname, '..', 'src', 'renderer');
const html = fs.readFileSync(path.join(RENDERER, 'index.html'), 'utf8');

const PANEL_FILES = [
  'renderer-codebase-panel.js',
  'renderer-graph-panel.js',
  'renderer-index-panel.js'
];

let failed = 0;
function fail(msg) {
  failed += 1;
  console.error(`FAIL: ${msg}`);
}

const ids = new Set();
for (const m of html.matchAll(/\bid="([^"]+)"/g)) ids.add(m[1]);

for (const file of PANEL_FILES) {
  const src = fs.readFileSync(path.join(RENDERER, file), 'utf8');
  const refs = new Set();
  for (const re of [/\$\('([a-z0-9-]+)'\)/g, /getElementById\('([a-z0-9-]+)'\)/g]) {
    for (const m of src.matchAll(re)) refs.add(m[1]);
  }
  for (const m of src.matchAll(/set(?:Codebase|Graph)PanelText\('([a-z0-9-]+)'/g)) refs.add(m[1]);
  for (const m of src.matchAll(/setIndexPanelBox\('([a-z0-9-]+)'/g)) refs.add(m[1]);
  const missing = [...refs].filter((id) => !ids.has(id));
  if (missing.length) fail(`${file} 引用了不存在的 DOM id：${missing.join(', ')}`);
}

const railTabs = [...html.matchAll(/data-side-tab="([^"]+)"/g)].map((m) => m[1]);
const paneTabs = [...html.matchAll(/data-side-pane="([^"]+)"/g)].map((m) => m[1]);

if (!railTabs.includes('index')) fail('index.html 缺少「索引」rail 按钮（data-side-tab="index"）');
if (!paneTabs.includes('index')) fail('index.html 缺少「索引」pane（data-side-pane="index"）');
for (const stale of ['codebase', 'graph']) {
  if (railTabs.includes(stale)) fail(`rail 仍有旧页签 data-side-tab="${stale}"，索引面板应合并为 index`);
  if (paneTabs.includes(stale)) fail(`pane 仍有旧页签 data-side-pane="${stale}"，索引面板应合并为 index`);
}
const dupRail = railTabs.filter((t, i) => railTabs.indexOf(t) !== i);
const dupPane = paneTabs.filter((t, i) => paneTabs.indexOf(t) !== i);
if (dupRail.length) fail(`rail 页签重复：${[...new Set(dupRail)].join(', ')}`);
if (dupPane.length) fail(`pane 页签重复：${[...new Set(dupPane)].join(', ')}`);
if (railTabs.length !== paneTabs.length) {
  fail(`rail(${railTabs.length}) 与 pane(${paneTabs.length}) 页签数量不一致`);
}

if (failed) process.exit(1);
console.log(`OK: 索引面板合并一致（rail/pane ${railTabs.length} 个页签，引用 id 全部存在）`);

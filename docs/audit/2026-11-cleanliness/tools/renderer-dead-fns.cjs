'use strict';
// Approximate "zero call-site top-level declarations" scan for src/renderer (N4.1 gate, ad hoc).
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..', '..', '..', '..');

const files = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (['dist', 'vendor'].includes(e.name)) continue;
      walk(p);
    } else if (e.name.endsWith('.js')) files.push(p);
  }
})(path.join(ROOT, 'src', 'renderer'));
// renderer bundle sources too
for (const extra of ['src/mobile/public', 'src/agent']) {
  (function walk(dir) {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== 'dist') walk(p); }
      else if (e.name.endsWith('.js')) files.push(p);
    }
  })(path.join(ROOT, extra));
}
const corpus = files.map((f) => fs.readFileSync(f, 'utf8')).join('\n') + fs.readFileSync(path.join(ROOT, 'src/renderer/index.html'), 'utf8');

const DECL = /^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/gm;
const rows = [];
for (const f of files) {
  const src = fs.readFileSync(f, 'utf8');
  let m;
  while ((m = DECL.exec(src))) {
    const name = m[1];
    const re = new RegExp('\\b' + name.replace(/\$/g, '\\$') + '\\b', 'g');
    const total = (corpus.match(re) || []).length;
    const own = (src.match(re) || []).length;
    const outside = total - own;
    if (outside <= 0 && own <= 1) rows.push({ file: path.relative(ROOT, f), name, total, own });
  }
}
// also: window.X = fn assignments that are never read anywhere
const ASSIGN = /window\.([A-Za-z_$][\w$]*)\s*=/g;
for (const f of files) {
  const src = fs.readFileSync(f, 'utf8');
  let m;
  while ((m = ASSIGN.exec(src))) {
    const name = m[1];
    const re = new RegExp('\\b' + name.replace(/\$/g, '\\$') + '\\b', 'g');
    const total = (corpus.match(re) || []).length;
    if (total <= 1) rows.push({ file: path.relative(ROOT, f), name: 'window.' + name, total, own: 1 });
  }
}
console.log(`files=${files.length} zero-outside-decl=${rows.length}`);
for (const r of rows) console.log(`${r.file}:${r.name}  (own=${r.own}, outside=0)`);

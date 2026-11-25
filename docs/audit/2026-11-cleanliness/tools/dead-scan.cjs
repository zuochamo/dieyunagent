'use strict';
// Dead-module scan for the cleanliness audit: which src/ files are never referenced.
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..', '..', '..', '..');

const EXT = new Set(['.js', '.cjs', '.mjs']);
const files = [];
function walk(dir) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (['node_modules', 'dist', 'vendor'].includes(ent.name)) continue;
      walk(p);
    } else if (EXT.has(path.extname(ent.name))) files.push(p);
  }
}
walk(path.join(ROOT, 'src'));

// corpus: every js/cjs/html/json file in repo (excluding build artifacts) plus test/ and scripts/
const corpusFiles = [];
const SKIP_DIR = /[\\/](node_modules|dist|release|target|\.git|build)[\\/]/;
function walkAll(dir) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (SKIP_DIR.test(p + path.sep)) continue;
      walkAll(p);
    } else if (/\.(js|cjs|mjs|html|json|ts|cjs)$/.test(ent.name)) corpusFiles.push(p);
  }
}
walkAll(ROOT);

const corpus = corpusFiles.map((f) => fs.readFileSync(f, 'utf8')).join('\n');

const orphans = [];
for (const f of files) {
  const rel = path.relative(ROOT, f).replace(/\\/g, '/');
  const base = path.basename(f);
  const stem = base.replace(/\.c?js$/, '');
  const self = fs.readFileSync(f, 'utf8');
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // referenced if basename OR require/import stem appears outside its own file
  const patterns = [new RegExp(esc(base), 'g')];
  if (stem.length > 2) patterns.push(new RegExp("[/'\\\"]" + esc(stem) + "['\\\"]", 'g'));
  let total = 0;
  for (const re of patterns) {
    total += (corpus.match(re) || []).length - (self.match(re) || []).length;
  }
  if (total <= 0) orphans.push({ rel, stem, total });
}
console.log(`src files=${files.length} orphans=${orphans.length}`);
for (const o of orphans.sort((a, b) => a.rel.localeCompare(b.rel))) console.log(' ', o.rel);

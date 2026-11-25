'use strict';
// Ad-hoc clone detector for the cleanliness audit (not part of the product).
// Finds duplicated 8-line normalized windows across src/ and crates/ .
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const AREAS = ['src', 'crates'];
const EXT = new Set(['.js', '.cjs', '.mjs', '.rs']);
const WINDOW = 8;

function walk(dir, out) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (['node_modules', 'dist', 'vendor', 'target', '.git'].includes(ent.name)) continue;
      walk(p, out);
    } else if (EXT.has(path.extname(ent.name))) {
      out.push(p);
    }
  }
}

function normalize(line) {
  return line
    .replace(/\/\/.*$/, '')
    .replace(/\/\*.*?\*\//g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const files = [];
for (const a of AREAS) walk(path.join(ROOT, a), files);
const SKIP = /(tool-validate\.generated\.js|_tests\.rs|\\tests?\.rs$|\\tests\\|test-.*\.cjs$)/i;
const prod = files.filter((f) => !SKIP.test(f));

const index = new Map(); // window text -> [ [file, startLine] ]
for (const f of prod) {
  const raw = fs.readFileSync(f, 'utf8').split(/\r?\n/);
  const lines = raw.map(normalize);
  for (let i = 0; i + WINDOW <= lines.length; i++) {
    const win = lines.slice(i, i + WINDOW);
    // require substance: at least 5 non-trivial lines
    if (win.filter((l) => l.length > 12).length < 5) continue;
    const key = win.join('\n');
    if (!index.has(key)) index.set(key, []);
    index.get(key).push([path.relative(ROOT, f), i + 1]);
  }
}

const hits = [];
for (const [key, where] of index) {
  if (where.length < 2) continue;
  // only cross-file duplication matters for the audit
  const distinct = new Set(where.map((w) => w[0]));
  if (distinct.size < 2) continue;
  hits.push({ where, key });
}

// collapse overlapping windows inside the same file pair
hits.sort((a, b) => b.where.length - a.where.length);

const seen = new Set();
const report = [];
for (const h of hits) {
  const pairKey = h.where.slice(0, 2).map((w) => w[0]).sort().join('|');
  const sig = pairKey + '#' + Math.floor(h.where[0][1] / 2);
  if (seen.has(sig)) continue;
  seen.add(sig);
  report.push(h);
}

console.log(`files=${files.length} windows=${index.size} dupWindows=${report.length}`);
const top = report.slice(0, 40);
for (const r of top) {
  console.log('---');
  console.log(r.where.map((w) => `${w[0]}:${w[1]}`).join('  '));
  const lines = r.key.split('\n').slice(0, 4);
  console.log('  ' + lines.join('\n  '));
}
fs.writeFileSync(path.join(__dirname, 'clone-report.txt'), report.map((r) => r.where.map((w) => `${w[0]}:${w[1]}`).join('  ') + '\n' + r.key + '\n\n').join(''), 'utf8');

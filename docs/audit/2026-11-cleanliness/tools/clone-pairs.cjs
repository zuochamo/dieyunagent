'use strict';
// Summarize clone-report.txt by file pair with window counts and line spans.
const fs = require('fs');
const path = require('path');
const text = fs.readFileSync(path.join(__dirname, 'clone-report.txt'), 'utf8');
const blocks = text.split('\n\n').filter((b) => b.trim());
const pairs = new Map();
for (const b of blocks) {
  const lines = b.split('\n');
  const where = lines[0].split(/\s{2,}/).filter(Boolean);
  const files = [...new Set(where.map((w) => w.replace(/:\d+$/, '')))];
  if (files.length < 2) continue;
  const key = files.sort().join('  <->  ');
  const spans = {};
  for (const w of where) {
    const [f, n] = w.split(/:(?=\d+$)/);
    (spans[f] ||= []).push(Number(n));
  }
  const rec = pairs.get(key) || { key, windows: 0, files, spans };
  rec.windows++;
  pairs.set(key, rec);
}
const sorted = [...pairs.values()].sort((a, b) => b.windows - a.windows);
for (const p of sorted.slice(0, 40)) {
  const detail = p.files
    .map((f) => `${f}@${Math.min(...p.spans[f])}-${Math.max(...p.spans[f])}`)
    .join('  ');
  console.log(`${String(p.windows).padStart(3)}×  ${detail}`);
}
console.log(`pairs=${sorted.length}`);

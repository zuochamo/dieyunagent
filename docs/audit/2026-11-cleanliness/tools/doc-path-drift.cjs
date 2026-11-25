'use strict';
// Check that file paths referenced in docs actually exist (doc/code drift).
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const docs = ['AGENTS.md', ...fs.readdirSync(path.join(ROOT, 'docs')).filter((f) => f.endsWith('.md')).map((f) => 'docs/' + f)];
const re = /`([A-Za-z0-9_.\-/]+\.(?:js|cjs|mjs|rs|json|md|yml|yaml|ps1|html|css|jsonl|ts))`/g;
const extRe = /\.(js|cjs|mjs|rs|json|md|yml|yaml|ps1|html|css|jsonl|ts)$/;
// build set of all repo-relative paths so short refs like "agent/llm.rs" can be suffix-matched
const all = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (['node_modules', 'dist', 'release', 'target', '.git', 'build', '.dieyun'].includes(e.name)) continue;
      walk(p);
    } else all.push(path.relative(ROOT, p).replace(/\\/g, '/'));
  }
})(ROOT);
function exists(ref) {
  const r = ref.replace(/^src\//, '');
  if (fs.existsSync(path.join(ROOT, ref))) return true;
  return all.some((f) => f === ref || f.endsWith('/' + r) || f.endsWith('/' + ref));
}
const missingByDoc = {};
const allMissing = new Set();
for (const d of docs) {
  const text = fs.readFileSync(path.join(ROOT, d), 'utf8');
  let m;
  const miss = new Set();
  while ((m = re.exec(text))) {
    const p = m[1];
    if (!p.includes('/')) continue;
    if (!extRe.test(p)) continue;
    if (exists(p)) continue;
    miss.add(p);
    allMissing.add(p);
  }
  if (miss.size) missingByDoc[d] = [...miss];
}
for (const [d, list] of Object.entries(missingByDoc)) {
  console.log(`\n## ${d} (${list.length})`);
  for (const p of list) console.log('  ' + p);
}
console.log(`\nTOTAL missing paths: ${allMissing.size}`);

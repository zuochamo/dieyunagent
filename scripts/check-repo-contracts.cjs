'use strict';

/**
 * Fail the build when npm scripts or docs/CODEMAP.json point at missing files.
 * This is the gate for "工程契约" (package.json / CODEMAP vs disk).
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PKG_PATH = path.join(ROOT, 'package.json');
const CODEMAP_PATH = path.join(ROOT, 'docs', 'CODEMAP.json');

function exists(rel) {
  const clean = String(rel).replace(/\\/g, '/').split('#')[0];
  if (!clean) return true;
  return fs.existsSync(path.join(ROOT, clean));
}

function extractScriptFiles(cmd) {
  const files = [];
  const chunks = String(cmd).split(/&&|;/).map((s) => s.trim()).filter(Boolean);
  for (const chunk of chunks) {
    let m = chunk.match(/^(?:node|python3?)\s+(\S+)/i);
    if (m && !m[1].startsWith('-')) files.push({ kind: 'file', value: m[1].replace(/^["']|["']$/g, '') });
    m = chunk.match(/-File\s+(\S+)/i);
    if (m) files.push({ kind: 'file', value: m[1] });
    m = chunk.match(/^(scripts[\\/][^\s]+)/i);
    if (m) files.push({ kind: 'file', value: m[1] });
    m = chunk.match(/^npm run (\S+)/);
    if (m) files.push({ kind: 'npm', value: m[1] });
  }
  return files;
}

function main() {
  const errors = [];
  const pkg = JSON.parse(fs.readFileSync(PKG_PATH, 'utf8'));
  const scripts = pkg.scripts || {};

  for (const [name, cmd] of Object.entries(scripts)) {
    for (const ref of extractScriptFiles(cmd)) {
      if (ref.kind === 'npm') {
        if (!scripts[ref.value]) {
          errors.push(`package.json scripts.${name} -> missing npm run ${ref.value}`);
        }
        continue;
      }
      if (!exists(ref.value)) {
        errors.push(`package.json scripts.${name} -> missing file ${ref.value}`);
      }
    }
  }

  const map = JSON.parse(fs.readFileSync(CODEMAP_PATH, 'utf8'));
  const npmNeeded = new Set();

  for (const mod of map.modules || []) {
    for (const p of mod.paths || []) {
      if (!exists(p)) errors.push(`CODEMAP modules.${mod.id} path missing: ${p}`);
    }
    for (const d of mod.docs || []) {
      if (!exists(d)) errors.push(`CODEMAP modules.${mod.id} docs missing: ${d}`);
    }
    for (const t of mod.tests || []) npmNeeded.add(t);
  }
  for (const rule of map.pathRules || []) {
    if (rule.prefix && !exists(rule.prefix) && !rule.prefix.endsWith('/')) {
      errors.push(`CODEMAP pathRule prefix missing: ${rule.prefix}`);
    }
    if (rule.prefix && rule.prefix.endsWith('/') && !exists(rule.prefix)) {
      errors.push(`CODEMAP pathRule prefix missing: ${rule.prefix}`);
    }
    for (const t of rule.tests || []) npmNeeded.add(t);
  }
  for (const [suite, list] of Object.entries(map.suites || {})) {
    for (const t of list || []) {
      npmNeeded.add(t);
      if (!scripts[t]) errors.push(`CODEMAP suites.${suite} unknown npm script: ${t}`);
    }
  }
  for (const t of npmNeeded) {
    if (!scripts[t]) errors.push(`CODEMAP references unknown npm script: ${t}`);
  }

  if (errors.length) {
    console.error(`[check-repo-contracts] ${errors.length} problem(s):`);
    for (const e of errors) console.error('  -', e);
    process.exit(1);
  }
  console.log('[check-repo-contracts] OK');
  console.log(`  npm scripts: ${Object.keys(scripts).length}`);
  console.log(`  CODEMAP modules: ${(map.modules || []).length}`);
}

main();

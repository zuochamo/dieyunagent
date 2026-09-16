'use strict';

/**
 * Agent-oriented smoke runner.
 *
 * Usage:
 *   node scripts/test-agent-smoke.cjs           # git diff -> mapped tests, or minimal suite
 *   node scripts/test-agent-smoke.cjs --all     # agent suite (skip core tests if no sidecar)
 *   node scripts/test-agent-smoke.cjs --full    # agent-full (+ rust smokes)
 *   node scripts/test-agent-smoke.cjs --suite agent-full
 *   node scripts/test-agent-smoke.cjs --paths src/mobile/public/app.js
 */

const { execSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CODEMAP = path.join(ROOT, 'docs', 'CODEMAP.json');

/** npm scripts that need a built dieyun-core binary */
const REQUIRES_CORE = new Set([
  'test:core-bridge',
  'test:rust-agent-loop',
  'test:rust-agent-loop-smoke',
  'test:rust-planner-pipeline',
  'test:rust-planner-smoke',
  'test:builtin-embedding-rust',
  'test:dieyun-core-pack'
]);

function resolveDieyunCoreBinary() {
  try {
    return require(path.join(ROOT, 'src', 'core-bridge-path')).resolveDieyunCoreBinary();
  } catch {
    return null;
  }
}

function ensureDeps() {
  const ws = path.join(ROOT, 'node_modules', 'ws', 'package.json');
  if (fs.existsSync(ws)) return;
  console.error('[dieyun:test] node_modules missing (e.g. after workspace cleanup).');
  console.error('[dieyun:test] Run: npm ci && npm run bootstrap');
  process.exit(1);
}

function loadCodemap() {
  return JSON.parse(fs.readFileSync(CODEMAP, 'utf8'));
}

function gitChangedPaths() {
  const cmds = [
    'git diff --name-only HEAD',
    'git diff --name-only --cached',
    'git ls-files --others --exclude-standard'
  ];
  const set = new Set();
  for (const cmd of cmds) {
    try {
      const out = execSync(cmd, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      for (const line of out.split(/\r?\n/)) {
        const p = line.trim().replace(/\\/g, '/');
        if (p) set.add(p);
      }
    } catch {
      // not a git repo or git missing
    }
  }
  return [...set];
}

function normalizePaths(argv) {
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--paths') {
      while (argv[i + 1] && !argv[i + 1].startsWith('--')) {
        out.push(String(argv[++i]).replace(/\\/g, '/'));
      }
    }
  }
  return out;
}

function testsForPaths(changed, pathRules) {
  const tests = new Set();
  for (const file of changed) {
    const norm = file.replace(/\\/g, '/');
    for (const rule of pathRules) {
      if (norm === rule.prefix || norm.startsWith(rule.prefix)) {
        for (const t of rule.tests || []) tests.add(t);
      }
    }
  }
  return [...tests];
}

function runNpmScript(scriptName, { allowSkip = false } = {}) {
  const label = `npm run ${scriptName}`;
  if (allowSkip && REQUIRES_CORE.has(scriptName) && !resolveDieyunCoreBinary()) {
    console.log(`\n[dieyun:test] SKIP ${scriptName} (dieyun-core not built; run npm run pack:dieyun-core)`);
    return;
  }
  console.log(`\n[dieyun:test] >> ${label}`);
  const r = spawnSync(label, {
    cwd: ROOT,
    stdio: 'inherit',
    env: process.env,
    shell: true
  });
  if (r.status !== 0) {
    throw new Error(`${label} failed with exit ${r.status}`);
  }
}

function main() {
  ensureDeps();
  const argv = process.argv.slice(2);
  const map = loadCodemap();
  let scripts = [];

  if (argv.includes('--all')) {
    scripts = map.suites.agent || map.suites['agent-full'];
  } else if (argv.includes('--full')) {
    scripts = map.suites['agent-full'] || map.suites.agent;
  } else if (argv.includes('--suite')) {
    const idx = argv.indexOf('--suite');
    const name = argv[idx + 1];
    if (!name || !map.suites[name]) {
      console.error(`Unknown suite: ${name || '(missing)'}. Available: ${Object.keys(map.suites).join(', ')}`);
      process.exit(1);
    }
    scripts = map.suites[name];
  } else {
    const explicit = normalizePaths(argv);
    const changed = explicit.length ? explicit : gitChangedPaths();
    if (changed.length) {
      console.log('[dieyun:test] changed paths:');
      for (const p of changed.slice(0, 40)) console.log('  ', p);
      if (changed.length > 40) console.log(`  ... +${changed.length - 40} more`);
      scripts = testsForPaths(changed, map.pathRules || []);
    }
    if (!scripts.length) {
      console.log('[dieyun:test] no diff / no mapping -> minimal suite');
      scripts = map.suites.minimal || ['test:agent-limits'];
    }
  }

  if (!argv.includes('--skip-contracts')) {
    runNpmScript('check:contracts');
  }

  console.log('[dieyun:test] running:', scripts.join(', '));
  for (const script of scripts) {
    runNpmScript(script, { allowSkip: true });
  }
  console.log('\n[dieyun:test] OK');
}

main();

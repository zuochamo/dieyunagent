'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const asar = require('@electron/asar');

const { getBuildDistRoot } = require('./build-dist-root.cjs');
const root = path.join(__dirname, '..');
const appAsar = path.join(getBuildDistRoot(), 'win-unpacked', 'resources', 'app.asar');
const outDir = path.join(os.tmpdir(), `dieyun-asar-verify-${Date.now()}`);

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(?:js|cjs|mjs)$/i.test(entry.name)) out.push(full);
  }
  return out;
}

function main() {
  if (!fs.existsSync(appAsar)) {
    console.error('[verify-asar] missing:', appAsar);
    process.exit(1);
  }
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  asar.extractAll(appAsar, outDir);

  const srcDir = path.join(outDir, 'src');
  if (!fs.existsSync(srcDir)) {
    console.error('[verify-asar] extracted package has no src/:', appAsar);
    process.exit(1);
  }

  const files = walk(srcDir);
  const bad = [];
  for (const file of files) {
    const res = spawnSync(process.execPath, ['--check', file], {
      encoding: 'utf8',
      windowsHide: true
    });
    if (res.status !== 0) {
      bad.push({
        file: path.relative(outDir, file),
        output: `${res.stdout || ''}${res.stderr || ''}`.trim()
      });
      if (bad.length >= 20) break;
    }
  }

  const bundleJs = path.join(outDir, 'src', 'renderer', 'dist', 'bundle.js');
  const bundledHtml = path.join(outDir, 'src', 'renderer', 'index.bundled.html');
  const bundleOk = fs.existsSync(bundleJs) && fs.existsSync(bundledHtml);

  fs.rmSync(outDir, { recursive: true, force: true });

  if (bad.length) {
    console.error(`[verify-asar] ${bad.length} JS syntax error(s) in packaged app.asar`);
    for (const item of bad) {
      console.error(`\n--- ${item.file}\n${item.output}`);
    }
    process.exit(1);
  }

  if (!bundleOk) {
    console.error('[verify-asar] missing renderer bundle or index.bundled.html in app.asar');
    process.exit(1);
  }

  // Packaged UI uses index.bundled.html + dist/bundle.js; stale bundles ship old UI while npm run dev looks fine.
  const srcIndex = path.join(root, 'src', 'renderer', 'index.html');
  const srcBundle = path.join(root, 'src', 'renderer', 'dist', 'bundle.js');
  if (fs.existsSync(srcIndex) && fs.existsSync(srcBundle)) {
    const indexMtime = fs.statSync(srcIndex).mtimeMs;
    const bundleMtime = fs.statSync(srcBundle).mtimeMs;
    if (bundleMtime + 1000 < indexMtime) {
      console.error(
        '[verify-asar] renderer bundle is older than index.html — run: npm run build:renderer'
      );
      console.error(
        `  bundle: ${new Date(bundleMtime).toISOString()}\n  index:  ${new Date(indexMtime).toISOString()}`
      );
      process.exit(1);
    }
  }

  console.log(`[verify-asar] OK: checked ${files.length} JS files; renderer bundle present`);
}

main();

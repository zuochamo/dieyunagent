'use strict';

const fs = require('fs');
const path = require('path');

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assert failed');
}

const root = path.join(__dirname, '..', 'src', 'mobile', 'public');
const htmlPath = path.join(root, 'index.html');
const appPath = path.join(root, 'app.js');
const manifestPath = path.join(root, 'manifest.json');

assert(fs.existsSync(htmlPath), 'index.html');
assert(fs.existsSync(appPath), 'app.js');
assert(fs.existsSync(manifestPath), 'manifest.json');

const html = fs.readFileSync(htmlPath, 'utf8');
assert(/id=["']composer["']/.test(html), 'composer');
assert(/id=["']send["']/.test(html), 'send button');
assert(/id=["']messages["']/.test(html), 'messages');
assert(/src=["']\.\/app\.js/.test(html), 'loads app.js');
assert(/rel=["']manifest["']/.test(html), 'manifest link');

const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
assert(manifest.name, 'manifest.name');
assert(manifest.start_url, 'manifest.start_url');
assert(Array.isArray(manifest.icons) && manifest.icons.length > 0, 'manifest.icons');
for (const icon of manifest.icons) {
  const rel = String(icon.src || '').replace(/^\.\//, '');
  assert(rel, 'icon src');
  assert(fs.existsSync(path.join(root, rel)), `icon file ${rel}`);
}

const appJs = fs.readFileSync(appPath, 'utf8');
assert(/WebSocket/.test(appJs), 'app.js uses WebSocket');
assert(/composer/.test(appJs), 'app.js wires composer');

console.log('test-mobile-smoke.cjs ok');

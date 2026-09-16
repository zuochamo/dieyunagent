'use strict';

const fs = require('fs');
const path = require('path');

const JS_METHOD_RE = /['"]([a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_.]+)+)['"]\s*:/g;
const RUST_METHOD_RE = /^\s+"([a-z][a-z0-9_.]+)"\s*(=>|\|)/gm;

function extractFromJsSource(source) {
  const out = new Set();
  let m;
  while ((m = JS_METHOD_RE.exec(source))) {
    out.add(m[1]);
  }
  return out;
}

function extractFromRustSource(source) {
  const out = new Set();
  let m;
  while ((m = RUST_METHOD_RE.exec(source))) {
    const name = m[1];
    if (name.includes('.')) out.add(name);
  }
  return out;
}

function readFileSafe(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
}

function collectGatewayMethods(root) {
  const methods = new Map();
  const add = (name, source) => {
    if (!methods.has(name)) methods.set(name, new Set());
    methods.get(name).add(source);
  };

  const rpcJs = path.join(root, 'src', 'gateway', 'rpc.js');
  for (const name of extractFromJsSource(readFileSafe(rpcJs))) {
    add(name, 'gateway/rpc.js');
  }

  const handlersDir = path.join(root, 'src', 'gateway', 'handlers');
  for (const file of fs.readdirSync(handlersDir)) {
    if (!file.endsWith('.js')) continue;
    const rel = `gateway/handlers/${file}`;
    for (const name of extractFromJsSource(readFileSafe(path.join(handlersDir, file)))) {
      add(name, rel);
    }
  }
  return methods;
}

function collectRustMethods(root) {
  const modRs = path.join(root, 'crates', 'dieyun-core', 'src', 'rpc', 'mod.rs');
  const out = new Map();
  for (const name of extractFromRustSource(readFileSafe(modRs))) {
    out.set(name, new Set(['dieyun-core/rpc/mod.rs']));
  }
  return out;
}

function mergeCatalog(gatewayMap, rustMap) {
  const all = new Set([...gatewayMap.keys(), ...rustMap.keys()]);
  const rows = [];
  for (const method of [...all].sort()) {
    const gw = gatewayMap.get(method);
    const rs = rustMap.get(method);
    let layer = 'gateway';
    if (gw && rs) layer = 'both';
    else if (rs) layer = 'rust';
    rows.push({
      method,
      layer,
      gateway: gw ? [...gw].sort() : [],
      rust: rs ? [...rs].sort() : []
    });
  }
  return rows;
}

function groupByNamespace(rows) {
  const groups = new Map();
  for (const row of rows) {
    const ns = row.method.split('.')[0] || 'other';
    if (!groups.has(ns)) groups.set(ns, []);
    groups.get(ns).push(row);
  }
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
}

module.exports = {
  extractFromJsSource,
  extractFromRustSource,
  collectGatewayMethods,
  collectRustMethods,
  mergeCatalog,
  groupByNamespace
};

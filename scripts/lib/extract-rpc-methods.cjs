'use strict';

const fs = require('fs');
const path = require('path');

const JS_METHOD_RE = /['"]([a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_.]+)+)['"]\s*:/g;
/**
 * 一条分派臂 `=>` 之前的全部方法名。
 *
 * 旧正则 `^\s+"(name)"\s*(=>|\|)` 只吃第一个名字：`"memory.session_delete" | "memory.messages_clear" =>`
 * 里的第二个名字永远看不见 —— 于是 catalog 把 `memory.messages_clear` 记成「只有 gateway 实现」，
 * 而 Rust 其实已经把它并进 `session_delete`（同一个臂、语义是**删整个会话**）。
 * 现在按「箭头前的名字串」整段取，并把每个名字都收进来。
 */
const RUST_ARM_RE = /^[ \t]*((?:"[a-z][a-z0-9_.]*"[ \t]*(?:\|[ \t]*)?)+)[ \t]*=>/gm;
const QUOTED_NAME_RE = /"([^"]+)"/g;

/**
 * Node 侧「真的会发出去」的 RPC 方法名：`invoke('x.y')` / `invokeRpc('x.y')`。
 *
 * 这张清单是「调用方 ↔ 实现」的活契约：只出现在 Node 里、catalog 里没有对应实现的方法名，
 * 就是一次运行期 `UNKNOWN_METHOD`（历史事故：宿主停止路径调 `agent.loop.cancel`，Rust 侧
 * 早已删除，`catch {}` 把它吞了 —— 取消信号永远是死的）。
 */
const NODE_INVOKE_RE = /\b(?:invoke|invokeRpc|call_host)\(\s*['"]([a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_.]+)+)['"]/g;

/**
 * 方法表的行：`MethodSpec { name: "x.y", route: Route::… }`。
 *
 * 这是 RPC 方法名的**权威清单**（`crates/dieyun-runtime/src/rpc/registry.rs`）。分派臂将来
 * 会被逐个搬进 handler 文件，那时臂格式不再统一 —— 所以两种来源都收：表 + 臂。
 */
const RUST_REGISTRY_RE = /MethodSpec\s*\{\s*name:\s*"([a-z][a-z0-9_.]+)"/g;

function extractFromRustRegistry(source) {
  const out = new Set();
  let m;
  while ((m = RUST_REGISTRY_RE.exec(source))) {
    out.add(m[1]);
  }
  return out;
}

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
  while ((m = RUST_ARM_RE.exec(source))) {
    const names = m[1].match(QUOTED_NAME_RE) || [];
    for (const quoted of names) {
      const name = quoted.replace(/^"|"$/g, '');
      if (name.includes('.')) out.add(name);
    }
  }
  return out;
}

/** 一条臂里出现过的方法名总数（含交替臂）—— 用于「臂数 == catalog 条目数」自检。 */
function countRustArmNames(source) {
  return extractFromRustSource(source).size;
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
  // 方法表可能分布在 rpc/*.rs（注册表拆分之后）；mod.rs 仍是当前唯一来源。
  const rpcDir = path.join(root, 'crates', 'dieyun-runtime', 'src', 'rpc');
  const out = new Map();
  const files = fs.existsSync(rpcDir)
    ? fs.readdirSync(rpcDir).filter((f) => f.endsWith('.rs')).map((f) => `rpc/${f}`)
    : ['rpc/mod.rs'];
  for (const rel of files) {
    const source = readFileSafe(path.join(root, 'crates', 'dieyun-runtime', 'src', rel));
    for (const name of extractFromRustSource(source)) {
      out.set(name, new Set([`dieyun-runtime/${rel}`]));
    }
    for (const name of extractFromRustRegistry(source)) {
      if (!out.has(name)) out.set(name, new Set());
      out.get(name).add(`dieyun-runtime/${rel}`);
    }
  }
  return out;
}

/** 扫 src/ 下所有 JS，收集 Node **真的会发出去**的 RPC 方法名（文件 → 名字集合）。 */
function collectNodeInvokedMethods(root) {
  const out = new Map();
  const stack = [path.join(root, 'src')];
  while (stack.length) {
    const cur = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const abs = path.join(cur, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === 'dist') continue;
        stack.push(abs);
        continue;
      }
      if (!/\.(js|cjs)$/.test(entry.name)) continue;
      const source = readFileSafe(abs);
      let m;
      const re = new RegExp(NODE_INVOKE_RE.source, 'g');
      while ((m = re.exec(source))) {
        if (!out.has(m[1])) out.set(m[1], new Set());
        out.get(m[1]).add(path.relative(root, abs).replace(/\\/g, '/'));
      }
    }
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
  countRustArmNames,
  collectGatewayMethods,
  collectRustMethods,
  collectNodeInvokedMethods,
  mergeCatalog,
  groupByNamespace
};

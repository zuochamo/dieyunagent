'use strict';

/**
 * dev 启动闸门：确保 build/remote-gateway-pack 存在且完整（含内置 Linux Node）。
 *
 * 打包由 `npm run pack:remote-gateway` 完成；安装包里 pack 已经预装，
 * 所以这里只负责「开发机上是否存在 / 是否过期」，没有按需下载分支。
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { computeRemoteGatewaySourceHash, inspectRemotePack } = require('../src/remote/remote-pack-layout.js');

const ROOT = path.join(__dirname, '..');
const PACK = path.join(ROOT, 'build', 'remote-gateway-pack');
const NODE_BIN = path.join(PACK, 'bin', 'node');
const MANIFEST = path.join(PACK, 'manifest.json');
const EXPECTED_SOURCE_HASH = computeRemoteGatewaySourceHash(ROOT);

function readManifest() {
  try {
    return JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  } catch {
    return null;
  }
}

function packLooksComplete() {
  if (!fs.existsSync(MANIFEST)) return false;
  try {
    const manifest = readManifest();
    if (!manifest || !manifest.entry) return false;
    if (manifest.sourceHash !== EXPECTED_SOURCE_HASH) return false;
    // 必需清单与远程注入校验同源（src/remote/remote-pack-layout.js），含内置 Node：
    // 半成品 pack（例如缺 node_modules/ws 或缺 bin/node）必须触发重新打包。
    if (!inspectRemotePack(PACK).ok) return false;
    const st = fs.statSync(NODE_BIN);
    return st.isFile() && st.size > 50 * 1024 * 1024;
  } catch {
    return false;
  }
}

if (packLooksComplete()) {
  const manifest = readManifest();
  console.log(
    `[remote-agent] pack OK: ${PACK} (sourceHash=${manifest && manifest.sourceHash ? manifest.sourceHash : '?'})`
  );
  process.exit(0);
}

const manifest = readManifest();
if (manifest && manifest.sourceHash && manifest.sourceHash !== EXPECTED_SOURCE_HASH) {
  console.log(`[remote-agent] pack stale (${manifest.sourceHash} -> ${EXPECTED_SOURCE_HASH}), rebuilding…`);
} else if (!fs.existsSync(MANIFEST)) {
  console.log('[remote-agent] pack missing, building…');
} else {
  console.log('[remote-agent] pack incomplete, building…');
}

execSync('npm run pack:remote-gateway', { cwd: ROOT, stdio: 'inherit' });

if (!packLooksComplete()) {
  console.error('[remote-agent] pack still incomplete after build');
  process.exit(1);
}

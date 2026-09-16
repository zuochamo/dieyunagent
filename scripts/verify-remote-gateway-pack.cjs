'use strict';

const fs = require('fs');
const path = require('path');

const { getBuildDistRoot } = require('./build-dist-root.cjs');
const root = path.join(__dirname, '..');
const packRoot = path.join(getBuildDistRoot(), 'win-unpacked', 'resources', 'remote-gateway-pack');
const corePath = path.join(packRoot, 'bin', 'dieyun-core');
const manifestPath = path.join(packRoot, 'manifest.json');
const MIN_BYTES = 500 * 1024;

function main() {
  if (!fs.existsSync(packRoot)) {
    console.error('[verify-remote-pack] missing:', packRoot);
    console.error('  请先完成 electron-builder 打包（dist/win-unpacked）');
    process.exit(1);
  }

  let manifest = null;
  if (fs.existsSync(manifestPath)) {
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    } catch (e) {
      console.warn('[verify-remote-pack] manifest.json 解析失败:', e.message || e);
    }
  }

  if (!fs.existsSync(corePath)) {
    console.error('[verify-remote-pack] 安装包未包含 Linux dieyun-core:', corePath);
    console.error('  远程 SSH 工作区的 codebase/graph 索引将不可用。');
    console.error('  请确认已安装 rustup target x86_64-unknown-linux-gnu，并重新执行 npm run build:nsis');
    process.exit(1);
  }

  const st = fs.statSync(corePath);
  if (!st.isFile() || st.size < MIN_BYTES) {
    console.error(
      `[verify-remote-pack] dieyun-core 体积异常 (${st.size} bytes，需 >= ${MIN_BYTES})`
    );
    process.exit(1);
  }

  const mag = Buffer.alloc(4);
  const fd = fs.openSync(corePath, 'r');
  fs.readSync(fd, mag, 0, 4, 0);
  fs.closeSync(fd);
  const isElf = mag[0] === 0x7f && mag[1] === 0x45 && mag[2] === 0x4c && mag[3] === 0x46;
  if (!isElf) {
    console.error('[verify-remote-pack] remote-gateway-pack/bin/dieyun-core 不是 Linux ELF');
    process.exit(1);
  }

  const bundledNode = path.join(packRoot, 'bin', 'node');
  if (fs.existsSync(bundledNode)) {
    console.warn(
      '[verify-remote-pack] 含 bin/node（lite 安装包应省略，改由 optional-assets 按需下载）'
    );
  }

  if (manifest && manifest.indexCore === false) {
    console.warn('[verify-remote-pack] manifest.indexCore=false，但二进制存在，继续');
  }

  console.log(
    `[verify-remote-pack] OK: dieyun-core ${Math.round(st.size / 1024)} KB` +
      (manifest && manifest.version ? `, remote-agent ${manifest.version}` : '')
  );
}

main();

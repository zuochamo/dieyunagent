'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const MARKER = path.join(ROOT, 'build', '.electron-output-path');
const DEFAULT_REL = 'dist';
const ALT_REL = 'dist-build';

function getBuildDistRoot() {
  if (fs.existsSync(MARKER)) {
    const rel = fs.readFileSync(MARKER, 'utf8').trim();
    if (rel) return path.join(ROOT, rel);
  }
  return path.join(ROOT, DEFAULT_REL);
}

/**
 * electron-builder 解包目录（`<dist>/win-unpacked`、`<dist>/linux-unpacked`）。
 * 打包后校验脚本的唯一来源：校验对象是「本机这一轮刚打出来的包」，
 * 所以按当前进程平台取，不在各处硬编码 win-unpacked。
 */
const PACKAGED_APP_DIRNAME = {
  win32: 'win-unpacked',
  linux: 'linux-unpacked'
};

function getPackagedAppDir() {
  const dirname = PACKAGED_APP_DIRNAME[process.platform];
  if (!dirname) {
    throw new Error(`未支持在该平台上校验打包产物: ${process.platform}（仅 win32 / linux）`);
  }
  return path.join(getBuildDistRoot(), dirname);
}

function getBuildDistRel() {
  if (fs.existsSync(MARKER)) {
    const rel = fs.readFileSync(MARKER, 'utf8').trim();
    if (rel) return rel;
  }
  return DEFAULT_REL;
}

function setBuildDistRel(rel) {
  fs.mkdirSync(path.dirname(MARKER), { recursive: true });
  fs.writeFileSync(MARKER, rel, 'utf8');
}

function clearBuildDistMarker() {
  try {
    fs.unlinkSync(MARKER);
  } catch {
    // ignore
  }
}

module.exports = {
  ROOT,
  MARKER,
  DEFAULT_REL,
  ALT_REL,
  getBuildDistRoot,
  getPackagedAppDir,
  getBuildDistRel,
  setBuildDistRel,
  clearBuildDistMarker
};

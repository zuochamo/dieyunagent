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
  getBuildDistRel,
  setBuildDistRel,
  clearBuildDistMarker
};

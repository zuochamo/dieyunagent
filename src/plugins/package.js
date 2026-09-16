'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { MANIFEST_FILE } = require('./manifest');

function extractZipToDir(zipPath, destDir) {
  const zip = path.resolve(String(zipPath || ''));
  if (!zip || !fs.existsSync(zip)) {
    throw new Error('Zip 文件不存在');
  }
  fs.mkdirSync(destDir, { recursive: true });
  try {
    execFileSync('tar', ['-xf', zip, '-C', destDir], { stdio: 'pipe' });
  } catch (e) {
    const msg = e && e.stderr ? e.stderr.toString() : e.message || String(e);
    throw new Error(`解压失败：${msg}`);
  }
}

function findPluginRoot(searchDir) {
  const root = path.resolve(String(searchDir || ''));
  const direct = path.join(root, MANIFEST_FILE);
  if (fs.existsSync(direct)) return root;

  const entries = fs.readdirSync(root, { withFileTypes: true });
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const nested = path.join(root, ent.name, MANIFEST_FILE);
    if (fs.existsSync(nested)) return path.join(root, ent.name);
  }
  throw new Error(`压缩包内未找到 ${MANIFEST_FILE}`);
}

function extractPluginZip(zipPath) {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dieyun-plugin-'));
  try {
    extractZipToDir(zipPath, tmpRoot);
    return findPluginRoot(tmpRoot);
  } catch (e) {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    throw e;
  }
}

function cleanupExtractDir(extractDir, installPath) {
  const resolved = path.resolve(String(extractDir || ''));
  const installed = path.resolve(String(installPath || ''));
  if (!resolved || resolved === installed) return;
  if (!resolved.includes(os.tmpdir())) return;
  try {
    fs.rmSync(resolved, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

module.exports = {
  extractZipToDir,
  findPluginRoot,
  extractPluginZip,
  cleanupExtractDir
};

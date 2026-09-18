'use strict';

/**
 * 版号（协议版号 = PC + Android 统一发布版号）的单一来源。
 *
 * 发布链上会有三处版号落点：`package.json` / `package-lock.json` /
 * `mobile-app/android/gradle.properties`，另外还有「下一个该发什么版号」的推导
 * （`scripts/resolve-next-version.cjs`，发布入口批处理用）。解析与推导只在本文件实现，
 * CLI 只做输出，避免发布脚本各写一份 semver 解析。
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PACKAGE_JSON = path.join(ROOT, 'package.json');

/** electron-builder 按 semver 写产物名：0.1.00 → dieyunagent-Setup-0.1.0.exe */
function canonicalizeVersion(raw) {
  const input = String(raw || '').trim();
  const m = input.match(/^(\d+)\.(\d+)\.(\d+)((?:[-+][0-9A-Za-z.-]+)?)$/);
  if (!m) return null;
  return {
    input,
    version: `${Number.parseInt(m[1], 10)}.${Number.parseInt(m[2], 10)}.${Number.parseInt(m[3], 10)}${m[4]}`
  };
}

/** 当前开发版版号：读 package.json 的 version（未写入时返回空串） */
function readCurrentVersion(file = PACKAGE_JSON) {
  const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
  return String(pkg.version || '').trim();
}

/** 下一个发布版号：patch + 1，并丢弃预发布 / build 后缀（0.1.35-dev.1 → 0.1.36） */
function nextReleaseVersion(raw) {
  const parsed = canonicalizeVersion(raw);
  if (!parsed) return null;
  const [major, minor, patch] = parsed.version
    .split(/[-+]/, 1)[0]
    .split('.')
    .map((p) => Number.parseInt(p, 10));
  return `${major}.${minor}.${patch + 1}`;
}

function mobileVersionCodeFromVersion(v) {
  const main = String(v || '').split(/[+-]/, 1)[0];
  const parts = main.split('.').map((p) => Number.parseInt(p, 10));
  const [major = 0, minor = 0, patch = 0] = parts.map((n) => (Number.isFinite(n) && n >= 0 ? n : 0));
  const code = major * 1000000 + minor * 1000 + patch;
  return Math.max(1, Math.min(2100000000, code));
}

module.exports = {
  ROOT,
  PACKAGE_JSON,
  canonicalizeVersion,
  readCurrentVersion,
  nextReleaseVersion,
  mobileVersionCodeFromVersion
};

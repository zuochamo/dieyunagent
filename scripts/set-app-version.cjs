'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

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

const parsed = canonicalizeVersion(process.argv[2]);
if (!parsed) {
  console.error('[ERROR] Version must look like 0.0.29');
  process.exit(1);
}
if (parsed.version !== parsed.input) {
  console.log(`[OK] Version normalized ${parsed.input} -> ${parsed.version} (semver / installer filename)`);
}
const version = parsed.version;

const pkgPath = path.join(ROOT, 'package.json');
const lockPath = path.join(ROOT, 'package-lock.json');
const mobilePropsPath = path.join(ROOT, 'mobile-app', 'android', 'gradle.properties');

function replaceVersionFields(file, count) {
  let text = fs.readFileSync(file, 'utf8');
  let replaced = 0;
  text = text.replace(/("version"\s*:\s*")([^"]*)(")/g, (match, before, _old, after) => {
    if (replaced >= count) return match;
    replaced += 1;
    return `${before}${version}${after}`;
  });
  if (replaced !== count) {
    console.error(`[ERROR] Expected ${count} version field(s) in ${path.basename(file)}, found ${replaced}`);
    process.exit(1);
  }
  fs.writeFileSync(file, text, 'utf8');
}

function mobileVersionCodeFromVersion(v) {
  const main = v.split(/[+-]/, 1)[0];
  const parts = main.split('.').map((p) => Number.parseInt(p, 10));
  const [major = 0, minor = 0, patch = 0] = parts.map((n) => (Number.isFinite(n) && n >= 0 ? n : 0));
  const code = major * 1000000 + minor * 1000 + patch;
  return Math.max(1, Math.min(2100000000, code));
}

function setMobileProp(text, key, value) {
  const line = `${key}=${value}`;
  const re = new RegExp(`^${key}=.*$`, 'm');
  if (re.test(text)) return text.replace(re, line);
  return text.replace(/\s*$/, `\n${line}\n`);
}

function updateMobileGradleProperties(file) {
  if (!fs.existsSync(file)) {
    console.warn(`[WARN] Mobile gradle.properties not found: ${file}`);
    return;
  }
  const versionCode = mobileVersionCodeFromVersion(version);
  let text = fs.readFileSync(file, 'utf8');
  text = setMobileProp(text, 'MOBILE_VERSION_CODE', versionCode);
  text = setMobileProp(text, 'MOBILE_VERSION_NAME', version);
  fs.writeFileSync(file, text, 'utf8');
  console.log(`[OK] Mobile version set to ${version} (${versionCode})`);
}

replaceVersionFields(pkgPath, 1);

if (fs.existsSync(lockPath)) {
  replaceVersionFields(lockPath, 2);
}

updateMobileGradleProperties(mobilePropsPath);

console.log(`[OK] App version set to ${version}`);

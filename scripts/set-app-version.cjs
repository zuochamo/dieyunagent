'use strict';

const fs = require('fs');
const path = require('path');

const { ROOT, canonicalizeVersion, mobileVersionCodeFromVersion } = require('./app-version.cjs');

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

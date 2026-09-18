'use strict';

/**
 * 版号单一来源：发布入口（scripts/build-installer-version.bat → resolve-next-version.cjs）
 * 与写入脚本（scripts/set-app-version.cjs）共用 scripts/app-version.cjs，
 * 这里钉住 semver 规范化 / 下一个 patch / Android versionCode 三件事。
 */

const {
  canonicalizeVersion,
  readCurrentVersion,
  nextReleaseVersion,
  mobileVersionCodeFromVersion
} = require('../../scripts/app-version.cjs');

describe('canonicalizeVersion', () => {
  it('normalizes numeric components the way electron-builder does', () => {
    expect(canonicalizeVersion('0.1.00')).toEqual({ input: '0.1.00', version: '0.1.0' });
    expect(canonicalizeVersion(' 0.1.35 ').version).toBe('0.1.35');
  });

  it('keeps prerelease / build suffix', () => {
    expect(canonicalizeVersion('0.2.0-dev.3').version).toBe('0.2.0-dev.3');
  });

  it('rejects malformed versions', () => {
    for (const bad of ['', '0.1', 'v0.1.35', '0.1.35.1', 'latest', null, undefined]) {
      expect(canonicalizeVersion(bad)).toBeNull();
    }
  });
});

describe('nextReleaseVersion', () => {
  it('bumps patch', () => {
    expect(nextReleaseVersion('0.1.35')).toBe('0.1.36');
    expect(nextReleaseVersion('1.9.99')).toBe('1.9.100');
  });

  it('drops prerelease / build suffix before bumping', () => {
    expect(nextReleaseVersion('0.1.35-dev.1')).toBe('0.1.36');
    expect(nextReleaseVersion('0.1.35+build.7')).toBe('0.1.36');
  });

  it('returns null for malformed input', () => {
    expect(nextReleaseVersion('0.1')).toBeNull();
  });
});

describe('readCurrentVersion', () => {
  it('reads the dev version from package.json', () => {
    const current = readCurrentVersion();
    expect(canonicalizeVersion(current)).not.toBeNull();
    expect(nextReleaseVersion(current)).not.toBe(current);
  });
});

describe('mobileVersionCodeFromVersion', () => {
  it('encodes major/minor/patch', () => {
    expect(mobileVersionCodeFromVersion('0.1.35')).toBe(1035);
    expect(mobileVersionCodeFromVersion('1.2.3')).toBe(1002003);
    expect(mobileVersionCodeFromVersion('0.1.35-dev.1')).toBe(1035);
  });

  it('stays inside the Android versionCode range', () => {
    expect(mobileVersionCodeFromVersion('0.0.0')).toBe(1);
    expect(mobileVersionCodeFromVersion('3000.0.0')).toBe(2100000000);
  });
});

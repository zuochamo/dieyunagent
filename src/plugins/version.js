'use strict';

function parseSemver(input) {
  const raw = String(input || '')
    .trim()
    .replace(/^v/i, '');
  const m = raw.match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  if (!m) return [0, 0, 0];
  return [Number(m[1]) || 0, Number(m[2]) || 0, Number(m[3]) || 0];
}

/** @returns {-1|0|1} */
function compareSemver(a, b) {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  for (let i = 0; i < 3; i += 1) {
    const d = pa[i] - pb[i];
    if (d > 0) return 1;
    if (d < 0) return -1;
  }
  return 0;
}

function satisfiesMinAppVersion(appVersion, minAppVersion) {
  const min = String(minAppVersion || '').trim();
  if (!min) return true;
  return compareSemver(appVersion, min) >= 0;
}

module.exports = {
  parseSemver,
  compareSemver,
  satisfiesMinAppVersion
};

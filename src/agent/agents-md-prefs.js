'use strict';

const fs = require('fs');
const path = require('path');

const PREFS_FILE = 'agents-md-prefs.json';

function defaultAgentsMdPrefs() {
  return { mode: 'auto', preview: true };
}

function prefsFilePath(userDataPath) {
  return path.join(String(userDataPath || ''), PREFS_FILE);
}

function readAgentsMdPrefs(userDataPath) {
  const defaults = defaultAgentsMdPrefs();
  const fp = prefsFilePath(userDataPath);
  if (!userDataPath || !fp) return defaults;
  try {
    const raw = fs.readFileSync(fp, 'utf8');
    const json = JSON.parse(raw);
    const mode = json && (json.mode === 'off' || json.mode === 'draft-only') ? json.mode : 'auto';
    const preview = json && (json.preview === false || json.preview === 0 || json.preview === '0')
      ? false
      : true;
    return { mode, preview };
  } catch {
    return defaults;
  }
}

function writeAgentsMdPrefs(userDataPath, prefs) {
  const next = {
    mode:
      prefs && (prefs.mode === 'off' || prefs.mode === 'draft-only') ? prefs.mode : 'auto',
    preview: !(prefs && (prefs.preview === false || prefs.preview === 0 || prefs.preview === '0'))
  };
  const fp = prefsFilePath(userDataPath);
  if (!userDataPath) return next;
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  return next;
}

module.exports = {
  PREFS_FILE,
  defaultAgentsMdPrefs,
  readAgentsMdPrefs,
  writeAgentsMdPrefs
};

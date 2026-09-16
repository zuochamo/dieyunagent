'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  hostControl: true,
  fsRead: true,
  fsWrite: true,
  shellExec: true,
  sqlRead: true,
  webFetch: true,
  browserAutomation: true
};

function loadPermissions(filePath) {
  try {
    if (fs.existsSync(filePath)) {
      const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      return { ...DEFAULTS, ...raw };
    }
  } catch {
    // ignore
  }
  return { ...DEFAULTS };
}

function savePermissions(filePath, perms) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const next = { ...DEFAULTS, ...perms };
  fs.writeFileSync(filePath, JSON.stringify(next, null, 2), 'utf8');
  return next;
}

module.exports = { DEFAULTS, loadPermissions, savePermissions };

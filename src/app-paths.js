'use strict';

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const USER_DATA_DIR = 'dieyunagent';
const LEGACY_USER_DATA_DIR = 'pixel-office-agent';
const MIGRATION_MARKER = '.migrated-from-pixel-office-agent';

function migrateLegacyUserData(targetDir, legacyDir) {
  if (targetDir === legacyDir) return;
  const marker = path.join(targetDir, MIGRATION_MARKER);
  if (fs.existsSync(marker)) return;
  if (!fs.existsSync(legacyDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
    fs.writeFileSync(marker, `fresh:${new Date().toISOString()}`, 'utf8');
    return;
  }
  if (!fs.existsSync(targetDir)) {
    fs.cpSync(legacyDir, targetDir, { recursive: true });
  }
  fs.writeFileSync(marker, `from:${legacyDir}:${new Date().toISOString()}`, 'utf8');
}

/** 须在 app.ready 之前调用，统一 userData 目录名并迁移旧数据 */
function configure() {
  const appData = app.getPath('appData');
  const target = path.join(appData, USER_DATA_DIR);
  const legacy = path.join(appData, LEGACY_USER_DATA_DIR);
  app.setPath('userData', target);
  try {
    migrateLegacyUserData(target, legacy);
  } catch (err) {
    console.warn('[app-paths] userData 迁移失败:', err && err.message);
  }
  if (process.platform === 'win32') {
    process.title = 'dieyunagent';
  }
}

module.exports = {
  configure,
  USER_DATA_DIR,
  LEGACY_USER_DATA_DIR
};

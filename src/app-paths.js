'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const USER_DATA_DIR = 'dieyunagent';
const LEGACY_USER_DATA_DIR = 'pixel-office-agent';
const MIGRATION_MARKER = '.migrated-from-pixel-office-agent';

/**
 * 平台默认的「应用数据根目录」（Electron `app.getPath('appData')` 的等价规则）。
 *
 * 纯 Node 入口（`src/headless`）没有 Electron，只能自己按平台算一次；规则必须与
 * Chromium 一致，否则同一台机器上「桌面写的 userData」与「headless 读的 userData」
 * 会变成两个目录 —— 会话、模型设置、索引全都看不见对方。
 *
 * @param {{ platform?: string, env?: NodeJS.ProcessEnv, homedir?: string }} [opts]
 */
function defaultAppDataDir(opts = {}) {
  const platform = String(opts.platform || process.platform);
  const env = opts.env || process.env;
  const home = String(opts.homedir || os.homedir());
  if (platform === 'win32') {
    return String(env.APPDATA || path.join(home, 'AppData', 'Roaming'));
  }
  if (platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support');
  }
  return String(env.XDG_CONFIG_HOME || path.join(home, '.config'));
}

/**
 * userData 目录的**唯一解析规则**：`DIEYUN_USER_DATA` 覆盖 → `<appData>/dieyunagent`。
 *
 * Electron 主进程与纯 Node 入口共用这一份（`src/main.js` 走 `configure()`，
 * `src/headless/boot.js` 走这里），不要在别处再拼一次目录名。
 *
 * 优先级：`DIEYUN_USER_DATA`（env）→ `opts.overrideDir`（命令行 `--user-data`）→ 平台默认。
 * env 高于命令行是有意的：服务端 unit 用 EnvironmentFile 配数据目录，运维手工跑 CLI 时
 * 若给了别的 `--user-data`，两边就会各开一份账本（会话/模型设置/索引互相看不见）。
 *
 * @param {{ appDataDir?: string, overrideDir?: string, env?: NodeJS.ProcessEnv, platform?: string, homedir?: string }} [opts]
 * @returns {string} 绝对路径
 */
function resolveUserDataDir(opts = {}) {
  const env = opts.env || process.env;
  const override =
    String(env.DIEYUN_USER_DATA || '').trim() || String(opts.overrideDir || '').trim();
  if (override) return path.resolve(override);
  const appDataDir = opts.appDataDir || defaultAppDataDir(opts);
  return path.join(String(appDataDir), USER_DATA_DIR);
}

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

/**
 * 须在 app.ready 之前调用，统一 userData 目录名并迁移旧数据。
 *
 * `electron` 只在**运行时**要求：模块顶部再 require 会让纯 Node 入口
 * （`node src/headless/main.js`）在 import 阶段就拿到 Electron 二进制路径字符串而崩。
 */
function configure() {
  const { app } = require('electron');
  const appData = app.getPath('appData');
  const target = resolveUserDataDir({ appDataDir: appData });
  const legacy = path.join(appData, LEGACY_USER_DATA_DIR);
  // Chromium 的 profile 目录（safeStorage 密钥所在的 `Local State`）只认启动开关。
  // 只调 setPath 时，若 Electron 没把 app 名解析成 dieyunagent（例如以 `electron <script.js>` 启动），
  // 密钥文件会落在默认目录：凭据写在 dieyunagent、密钥却在别处 → 存进去的密文以后永远解不开。
  // 这里让密钥来源与数据目录同源（正常启动下两者一致，此开关无副作用）。
  app.commandLine.appendSwitch('user-data-dir', target);
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
  USER_DATA_DIR,
  LEGACY_USER_DATA_DIR,
  defaultAppDataDir,
  resolveUserDataDir,
  migrateLegacyUserData,
  configure
};

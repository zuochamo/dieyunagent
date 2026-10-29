'use strict';

const fs = require('fs');
const path = require('path');

/**
 * @param {{ safeStorage?: import('electron').SafeStorage, userDataPath: string }} deps
 */
function createSshCredentialsStore(deps) {
  const userDataPath = deps.userDataPath;
  const storePath = path.join(userDataPath, 'ssh-profiles.json');

  function canEncrypt() {
    const ss = deps.safeStorage;
    return !!(ss && typeof ss.isEncryptionAvailable === 'function' && ss.isEncryptionAvailable());
  }

  function profileKey(host, port, username) {
    return `${String(host || '').trim()}:${Number(port) || 22}:${String(username || '').trim()}`;
  }

  function readStore() {
    try {
      return JSON.parse(fs.readFileSync(storePath, 'utf8'));
    } catch {
      return {};
    }
  }

  function writeStore(data) {
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    // 只存密文，但文件仍按 0600 落盘：别人的可读副本 + 本机 safeStorage 一旦换机器/换用户
    // 就解不开，而 0644（umask 默认）会把「谁登录过哪台机器、用哪个密钥」白送给同机其他用户。
    fs.writeFileSync(storePath, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 });
    try {
      // mode 只对新建文件生效：已存在的文件（历史版本建的 0644）要显式收紧
      fs.chmodSync(storePath, 0o600);
    } catch {
      // Windows 上 chmod 语义有限，忽略
    }
  }

  function encryptSecret(text) {
    const s = String(text || '');
    if (!s) return '';
    const ss = deps.safeStorage;
    if (!canEncrypt() || !ss) return '';
    return ss.encryptString(s).toString('base64');
  }

  function decryptSecret(enc) {
    if (!enc) return '';
    const ss = deps.safeStorage;
    if (!canEncrypt() || !ss) return '';
    try {
      return ss.decryptString(Buffer.from(String(enc), 'base64'));
    } catch {
      return '';
    }
  }

  function getProfile(host, port, username) {
    const key = profileKey(host, port, username);
    const store = readStore();
    const row = store[key];
    if (!row || !row.remember) return null;
    return {
      authType: row.authType === 'key' ? 'key' : 'password',
      privateKeyPath: row.privateKeyPath || '',
      remember: true,
      hasSecret: !!(row.secretEnc && canEncrypt())
    };
  }

  function secretRowToSecrets(row) {
    const secret = decryptSecret(row.secretEnc);
    return {
      // 行里带着用户名：调用方传空用户名时也要知道自己存的是谁
      username: String(row.username || ''),
      authType: row.authType === 'key' ? 'key' : 'password',
      password: row.authType === 'password' ? secret : '',
      privateKeyPath: row.privateKeyPath || '',
      passphrase: row.authType === 'key' ? secret : ''
    };
  }

  function loadConnectSecrets(host, port, username) {
    const key = profileKey(host, port, username);
    const store = readStore();
    const row = store[key];
    if (!row || !row.remember) return null;
    return secretRowToSecrets({ ...row, username: row.username || String(username || '').trim() });
  }

  /**
   * 用户名还没填时按 `host:port` 找已保存的凭据。
   *
   * profile 键里**含用户名**，所以「留空用户名 + 使用已保存凭据」原来永远找不到自己的记录
   * （`loadConnectSecrets(host, port, '')` 命中的是空用户名那一格）。同名多用户时取最近保存的那条。
   *
   * @param {string} host
   * @param {number} [port]
   */
  function findSavedProfileForHost(host, port) {
    const h = String(host || '').trim();
    const p = Number(port) || 22;
    if (!h) return null;
    const store = readStore();
    let best = null;
    for (const [key, row] of Object.entries(store)) {
      if (!row || !row.remember) continue;
      const rowHost = row.host != null ? String(row.host).trim() : key.split(':')[0];
      const rowPort = row.port != null ? Number(row.port) || 22 : Number(key.split(':')[1]) || 22;
      if (rowHost !== h || rowPort !== p) continue;
      // 取最近保存的：时间戳相同（同一毫秒内连存两条）时按插入顺序取后者
      if (!best || (row.updatedAt || 0) >= (best.updatedAt || 0)) best = row;
    }
    return best ? secretRowToSecrets(best) : null;
  }

  /**
   * @param {{ host: string, port?: number, username: string, authType?: string, remember?: boolean, password?: string, privateKeyPath?: string, passphrase?: string }} payload
   */
  function saveProfile(payload) {
    if (!payload || !payload.remember) return;
    if (!canEncrypt()) {
      const e = new Error('当前系统无法加密存储凭据，无法保存记住的登录信息');
      e.code = 'CREDENTIALS_ENCRYPT_UNAVAILABLE';
      throw e;
    }
    const key = profileKey(payload.host, payload.port, payload.username);
    const authType = payload.authType === 'key' ? 'key' : 'password';
    const secret = authType === 'key' ? payload.passphrase || '' : payload.password || '';
    if (!secret) {
      const e = new Error('无有效凭据可保存');
      e.code = 'CREDENTIALS_EMPTY';
      throw e;
    }
    const store = readStore();
    store[key] = {
      // host/port/username 单独存一份：用户名留空时要能按 host:port 反查（见 findSavedProfileForHost）
      host: String(payload.host || '').trim(),
      port: Number(payload.port) || 22,
      username: String(payload.username || '').trim(),
      authType,
      remember: true,
      privateKeyPath: authType === 'key' ? String(payload.privateKeyPath || '').trim() : '',
      secretEnc: encryptSecret(secret),
      updatedAt: Date.now()
    };
    writeStore(store);
  }

  function clearProfile(host, port, username) {
    const key = profileKey(host, port, username);
    const store = readStore();
    if (!store[key]) return;
    delete store[key];
    writeStore(store);
  }

  return {
    canEncrypt,
    profileKey,
    getProfile,
    loadConnectSecrets,
    findSavedProfileForHost,
    saveProfile,
    clearProfile
  };
}

module.exports = { createSshCredentialsStore };

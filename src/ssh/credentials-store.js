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
    fs.writeFileSync(storePath, JSON.stringify(data, null, 2), 'utf8');
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

  function loadConnectSecrets(host, port, username) {
    const key = profileKey(host, port, username);
    const store = readStore();
    const row = store[key];
    if (!row || !row.remember) return null;
    const secret = decryptSecret(row.secretEnc);
    return {
      authType: row.authType === 'key' ? 'key' : 'password',
      password: row.authType === 'password' ? secret : '',
      privateKeyPath: row.privateKeyPath || '',
      passphrase: row.authType === 'key' ? secret : ''
    };
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
    saveProfile,
    clearProfile
  };
}

module.exports = { createSshCredentialsStore };

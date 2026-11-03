'use strict';

const { createSecretStore } = require('../secret-store');

/**
 * @param {{ safeStorage?: import('electron').SafeStorage, userDataPath: string }} deps
 */
function createSshCredentialsStore(deps) {
  // 加解密与 0600 落盘唯一实现：`src/secret-store.js`
  const box = createSecretStore({
    userDataPath: deps.userDataPath,
    fileName: 'ssh-profiles.json',
    safeStorage: deps.safeStorage,
    label: 'ssh-profiles.json',
    encryptUnavailableMessage: '当前系统无法加密存储凭据，无法保存记住的登录信息',
    // 坏文件当空：SSH 登录信息可重填，且这里没有「保存即整份覆盖」以外的用途。
    onCorrupt: 'empty'
  });

  const canEncrypt = box.canEncrypt;
  const encryptSecret = box.encryptSecret;
  const decryptSecret = box.decryptSecret;

  function profileKey(host, port, username) {
    return `${String(host || '').trim()}:${Number(port) || 22}:${String(username || '').trim()}`;
  }

  function readStore() {
    return box.readJson() || {};
  }

  function writeStore(data) {
    box.writeJson(data);
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

  /**
   * 凭据文件健康度。`corrupt: true` 时连接面板显示「文件损坏，请重新填写」，
   * 并且 `saveProfile` 会以 `SECRET_STORE_CORRUPT` 拒绝写入 —— 坏文件被当成空再保存一次，
   * 就会把用户其余主机的登录信息静默抹掉。
   *
   * 先读一次再报：损坏态是「读到坏文件」才成立的，光看状态位会漏掉一个从未被读过的坏文件。
   */
  function readStoreHealth() {
    readStore();
    return box.getHealth();
  }

  /** 备份坏文件并重建（连接面板「备份并重建」按钮）。 */
  function resetStore() {
    return box.resetCorruptFile();
  }

  return {
    canEncrypt,
    profileKey,
    getProfile,
    loadConnectSecrets,
    findSavedProfileForHost,
    saveProfile,
    clearProfile,
    readStoreHealth,
    resetStore
  };
}

module.exports = { createSshCredentialsStore };

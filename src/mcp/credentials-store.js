'use strict';

const fs = require('fs');
const path = require('path');

/**
 * @param {{ safeStorage?: import('electron').SafeStorage, userDataPath: string }} deps
 */
function createMcpCredentialsStore(deps) {
  const storePath = path.join(deps.userDataPath || '', 'mcp-secrets.json');

  function canEncrypt() {
    const ss = deps.safeStorage;
    return !!(ss && typeof ss.isEncryptionAvailable === 'function' && ss.isEncryptionAvailable());
  }

  function readStore() {
    try {
      const raw = JSON.parse(fs.readFileSync(storePath, 'utf8'));
      return raw && typeof raw === 'object' ? raw : {};
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

  function getRow(serverId) {
    const id = String(serverId || '').trim();
    if (!id) return null;
    const store = readStore();
    const row = store[id];
    return row && typeof row === 'object' ? row : null;
  }

  function getSecretMeta(serverId) {
    const row = getRow(serverId);
    if (!row) return { hasToken: false, envKeys: [], hasEnv: false };
    const envKeys = row.envEnc && typeof row.envEnc === 'object' ? Object.keys(row.envEnc) : [];
    return {
      hasToken: !!(row.tokenEnc && canEncrypt()),
      envKeys,
      hasEnv: envKeys.length > 0
    };
  }

  function loadSecrets(serverId) {
    const row = getRow(serverId);
    if (!row) return { token: '', env: {} };
    const env = {};
    if (row.envEnc && typeof row.envEnc === 'object') {
      for (const [key, enc] of Object.entries(row.envEnc)) {
        const val = decryptSecret(enc);
        if (val) env[key] = val;
      }
    }
    return {
      token: decryptSecret(row.tokenEnc),
      env
    };
  }

  /**
   * @param {string} serverId
   * @param {{ token?: string|null, env?: Record<string, string>, clearToken?: boolean, clearEnvKeys?: string[] }} payload
   */
  function saveSecrets(serverId, payload) {
    const id = String(serverId || '').trim();
    if (!id) return;
    const needsSecret =
      (payload && payload.token != null && String(payload.token || '').trim()) ||
      (payload &&
        payload.env &&
        typeof payload.env === 'object' &&
        Object.values(payload.env).some((v) => String(v || '').trim()));
    if (needsSecret && !canEncrypt()) {
      const e = new Error('当前系统无法加密存储 MCP 凭据');
      e.code = 'CREDENTIALS_ENCRYPT_UNAVAILABLE';
      throw e;
    }
    const store = readStore();
    const prev = store[id] && typeof store[id] === 'object' ? store[id] : {};
    const next = { ...prev, updatedAt: Date.now() };

    if (payload && payload.clearToken) {
      delete next.tokenEnc;
    } else if (payload && payload.token != null) {
      const token = String(payload.token || '');
      if (token) next.tokenEnc = encryptSecret(token);
      else delete next.tokenEnc;
    }

    if (payload && Array.isArray(payload.clearEnvKeys)) {
      next.envEnc = next.envEnc && typeof next.envEnc === 'object' ? { ...next.envEnc } : {};
      for (const key of payload.clearEnvKeys) {
        delete next.envEnc[key];
      }
      if (!Object.keys(next.envEnc).length) delete next.envEnc;
    }

    if (payload && payload.env && typeof payload.env === 'object') {
      next.envEnc = next.envEnc && typeof next.envEnc === 'object' ? { ...next.envEnc } : {};
      for (const [key, value] of Object.entries(payload.env)) {
        const k = String(key || '').trim();
        if (!k) continue;
        const v = String(value || '');
        if (v) next.envEnc[k] = encryptSecret(v);
        else delete next.envEnc[k];
      }
      if (!Object.keys(next.envEnc).length) delete next.envEnc;
    }

    if (!next.tokenEnc && !next.envEnc) {
      delete store[id];
    } else {
      store[id] = next;
    }
    writeStore(store);
  }

  function clearSecrets(serverId) {
    const id = String(serverId || '').trim();
    if (!id) return;
    const store = readStore();
    if (!store[id]) return;
    delete store[id];
    writeStore(store);
  }

  return {
    canEncrypt,
    getSecretMeta,
    loadSecrets,
    saveSecrets,
    clearSecrets
  };
}

module.exports = { createMcpCredentialsStore };

'use strict';

const { createSecretStore } = require('../secret-store');

/** 解密失败去重：读取凭据是高频路径（列表 / 弹窗 / 建会话都读），同一个坏值只喊一次 */
const warnedUndecryptable = new Set();

/** 密文解不开时唯一的一次告警（含用户要做的动作），不在这里决定怎么继续跑 */
function warnUndecryptable(serverId, keys, encryptionAvailable) {
  const dedupeKey = `${serverId}:${keys.join(',')}`;
  if (warnedUndecryptable.has(dedupeKey)) return;
  warnedUndecryptable.add(dedupeKey);
  if (!encryptionAvailable) {
    console.warn(`[dieyun:mcp] ${serverId} 的 ${keys.join('、')} 无法解密：当前系统不可用 safeStorage`);
    return;
  }
  console.warn(
    `[dieyun:mcp] ${serverId} 的 ${keys.join('、')} 无法解密：` +
      'safeStorage 密钥与写入时不一致（换过 userData / 启动方式），请在 MCP 设置页重新填写保存'
  );
}

/**
 * @param {{ safeStorage?: import('electron').SafeStorage, userDataPath: string }} deps
 */
function createMcpCredentialsStore(deps) {
  // 加解密与 0600 落盘的唯一实现：`src/secret-store.js`
  // （此前本文件自己写了一份，且**漏了 0600** —— 同机其他用户能读 mcp-secrets.json）。
  const box = createSecretStore({
    userDataPath: deps.userDataPath || '',
    fileName: 'mcp-secrets.json',
    safeStorage: deps.safeStorage,
    label: 'mcp-secrets.json',
    encryptUnavailableMessage: '当前系统无法加密存储 MCP 凭据',
    // 读到坏文件当空：MCP 凭据是「可重填」的运行时配置，读取路径在 Agent 轮内高频命中，
    // 抛错会把一次工具调用直接打断。（频道配置相反，见 channels/store.js 的 'throw'。）
    onCorrupt: 'empty'
  });

  const canEncrypt = box.canEncrypt;
  const encryptSecret = box.encryptSecret;
  const decryptSecret = box.decryptSecret;

  function readStore() {
    return box.readJson() || {};
  }

  function writeStore(data) {
    box.writeJson(data);
  }

  function getRow(serverId) {
    const id = String(serverId || '').trim();
    if (!id) return null;
    const store = readStore();
    const row = store[id];
    return row && typeof row === 'object' ? row : null;
  }

  /**
   * 凭据的唯一真相：以「能解出来的值」为准。
   * 只数密文键名会把"解不开"当成"已配置"（UI 显示已保存、子进程却拿到空 env），
   * 于是失败以"没配过"的形态静默传播。解不开就如实报出来，并让调用方决定拦不拦。
   */
  function readUsableSecrets(serverId, row) {
    const env = {};
    const undecryptable = [];
    if (row.envEnc && typeof row.envEnc === 'object') {
      for (const [key, enc] of Object.entries(row.envEnc)) {
        const val = decryptSecret(enc);
        if (val) env[key] = val;
        else undecryptable.push(key);
      }
    }
    let token = '';
    if (row.tokenEnc) {
      token = decryptSecret(row.tokenEnc);
      if (!token) undecryptable.push('token');
    }
    if (undecryptable.length) warnUndecryptable(serverId, undecryptable, canEncrypt());
    return { token, env, undecryptable };
  }

  function getSecretMeta(serverId) {
    const row = getRow(serverId);
    if (!row) return { hasToken: false, envKeys: [], hasEnv: false, undecryptable: [] };
    const { token, env, undecryptable } = readUsableSecrets(serverId, row);
    const envKeys = Object.keys(env);
    return {
      hasToken: !!token,
      envKeys,
      hasEnv: envKeys.length > 0,
      undecryptable
    };
  }

  function loadSecrets(serverId) {
    const row = getRow(serverId);
    if (!row) return { token: '', env: {} };
    const { token, env } = readUsableSecrets(serverId, row);
    return { token, env };
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

  /**
   * 凭据文件健康度。`corrupt: true` 时设置页显示「文件损坏，请重新填写」，
   * 并且 `saveSecrets` 会以 `SECRET_STORE_CORRUPT` 拒绝写入 —— 坏文件被当成空再保存一次，
   * 就会把用户其余服务的 token 静默抹掉。
   *
   * 先读一次再报：损坏态是「读到坏文件」才成立的，光看状态位会漏掉一个从未被读过的坏文件。
   */
  function readStoreHealth() {
    readStore();
    return box.getHealth();
  }

  /** 备份坏文件并重建（设置页「备份并重建」按钮）。 */
  function resetStore() {
    return box.resetCorruptFile();
  }

  return {
    canEncrypt,
    getSecretMeta,
    loadSecrets,
    saveSecrets,
    clearSecrets,
    readStoreHealth,
    resetStore
  };
}

module.exports = { createMcpCredentialsStore };

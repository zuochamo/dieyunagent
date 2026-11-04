'use strict';

const { createSecretStore } = require('../secret-store');

/**
 * 「共享记忆」（扩展页签）的配置与凭据。
 *
 * 只有一份配置：服务器地址/库/账号 + 口令（safeStorage 密文）。
 * 口令落盘的加解密与 0600 权限唯一实现在 `src/secret-store.js`（MCP / SSH / 频道同一份），
 * 这里不重写任何加解密。
 *
 * **默认开启**（`enabled: true`）：这是「装好就能用」的一部分 —— 默认服务器、库名、账号都是
 * 已知的内网约定，只有口令必须由人填（绝不进仓库）。填之前 `configured === false`，
 * 效果与「检查不到数据库」相同：共享记忆不参与本轮任何读写，设置页显示未配置。
 */

const FILE_NAME = 'shared-memory.json';

/** 内网默认值。口令**不在**这里（在用户的 userData 密文里）。 */
const DEFAULTS = Object.freeze({
  enabled: true,
  host: '192.168.31.62',
  port: 5432,
  database: 'dieyun_memory',
  user: 'role_mem',
  // 服务器支持 TLS（实测 PG 18 + 自签证书）；不支持时 pg.js 会**一次性**退回明文连接，
  // 那份「协商」只活在那一个模块里，调用方不需要知道。
  ssl: true
});

function clampPort(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0 || n > 65535) return DEFAULTS.port;
  return Math.trunc(n);
}

function normalizeHost(v) {
  const s = String(v == null ? '' : v).trim();
  // 允许粘贴 `postgresql://user:pass@host:port/db` 这种串：只取主机部分
  const m = /^postgres(?:ql)?:\/\//i.test(s) ? s.replace(/^[a-z]+:\/\//i, '') : s;
  const noAuth = m.includes('@') ? m.slice(m.lastIndexOf('@') + 1) : m;
  const hostOnly = noAuth.split('/')[0].split(':')[0];
  return hostOnly.trim();
}

/**
 * @param {{ userDataPath: string, safeStorage?: import('electron').SafeStorage,
 *           log?: (msg: string) => void }} deps
 */
function createSharedMemoryStore(deps) {
  const userDataPath = String(deps.userDataPath || '');
  const log = typeof deps.log === 'function' ? deps.log : () => {};
  const box = createSecretStore({
    userDataPath,
    fileName: FILE_NAME,
    safeStorage: deps.safeStorage,
    log,
    label: 'shared-memory',
    encryptUnavailableMessage: '当前系统无法加密存储凭据，无法保存共享记忆的数据库口令',
    // 读失败当空：这是每轮都要读的路径，抛错会打断 system prompt 装配。
    // （写成空之后也不会覆盖用户配置 —— secret-store 的损坏态会拒绝写入。）
    onCorrupt: 'empty'
  });

  function readRaw() {
    const raw = box.readJson();
    if (!raw || typeof raw !== 'object') return { version: 1, ...DEFAULTS, passwordEnc: '' };
    return {
      version: 1,
      enabled: raw.enabled !== false,
      host: normalizeHost(raw.host) || DEFAULTS.host,
      port: clampPort(raw.port),
      database: String(raw.database || DEFAULTS.database).trim() || DEFAULTS.database,
      user: String(raw.user || DEFAULTS.user).trim() || DEFAULTS.user,
      ssl: raw.ssl !== false,
      passwordEnc: String(raw.passwordEnc || '')
    };
  }

  /** 设置页视图：**永不带出明文口令**，只说存没存过 */
  function getSettings() {
    const raw = readRaw();
    const password = box.decryptSecret(raw.passwordEnc);
    return {
      enabled: raw.enabled,
      host: raw.host,
      port: raw.port,
      database: raw.database,
      user: raw.user,
      ssl: raw.ssl,
      hasPassword: !!raw.passwordEnc,
      canEncrypt: box.canEncrypt(),
      configured: !!(raw.host && raw.database && raw.user && password),
      filePath: box.filePath
    };
  }

  /** 运行时连接参数（明文口令只在内存里出现一次，不外传） */
  function getConnection() {
    const raw = readRaw();
    return {
      enabled: raw.enabled,
      host: raw.host,
      port: raw.port,
      database: raw.database,
      user: raw.user,
      ssl: raw.ssl,
      password: box.decryptSecret(raw.passwordEnc)
    };
  }

  /**
   * 保存配置。口令与其余字段解耦：`password === undefined` 表示「不改正已存的口令」，
   * 空串表示「清空」（此时 configured 变 false，等于关掉共享记忆）。
   * @param {{ enabled?: boolean, host?: string, port?: number|string, database?: string,
   *           user?: string, ssl?: boolean, password?: string }} patch
   */
  function saveSettings(patch = {}) {
    const raw = readRaw();
    const next = { ...raw };
    if (patch.enabled !== undefined) next.enabled = !!patch.enabled;
    if (patch.host !== undefined) next.host = normalizeHost(patch.host) || DEFAULTS.host;
    if (patch.port !== undefined) next.port = clampPort(patch.port);
    if (patch.database !== undefined) {
      next.database = String(patch.database || '').trim() || DEFAULTS.database;
    }
    if (patch.user !== undefined) next.user = String(patch.user || '').trim() || DEFAULTS.user;
    if (patch.ssl !== undefined) next.ssl = !!patch.ssl;
    if (patch.password !== undefined) {
      const pwd = String(patch.password || '');
      next.passwordEnc = pwd ? box.encryptSecret(pwd) : '';
    }
    box.writeJson(next);
    return getSettings();
  }

  return {
    filePath: box.filePath,
    canEncrypt: box.canEncrypt,
    getSettings,
    getConnection,
    saveSettings
  };
}

module.exports = { createSharedMemoryStore, DEFAULTS, FILE_NAME, normalizeHost, clampPort };

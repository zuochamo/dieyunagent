'use strict';

/**
 * headless 的凭据加解密：Electron `safeStorage` 的**同形替身**。
 *
 * 为什么必须有这一层：MCP / SSH / 频道 Secret 全部经 `secret-store` 落盘，而它
 * 明确写着「不能加密就报错，**绝不回退明文**」。纯 Node 里没有 `safeStorage`，
 * 不补一个实现就只有一条路：所有凭据都存不进去（在服务器上等于 MCP 不可用）。
 *
 * 语义与 Electron 版对齐到「够用且不更弱」：
 * - 密钥来自文件（`DIEYUN_SECRET_KEY_FILE`，32 字节，权限 0600），不做机器绑定；
 * - 没有密钥 = `isEncryptionAvailable() === false`，上层按既有语义报错，**不落明文**；
 * - 密文与 Electron 的密文**互不通用**（密钥不同），所以桌面写过的凭据在服务器上解不开，
 *   需要在服务器侧重填 —— 这是一条要在文档里明说的边界，不是 bug。
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

/** 密文容器版本：`[ver(1)] [iv(12)] [tag(16)] [ciphertext]` */
const VERSION = 1;
const IV_LEN = 12;
const TAG_LEN = 16;
const KEY_LEN = 32;
const ALGO = 'aes-256-gcm';

/**
 * 读密钥文件。只接受 32 字节（raw 或 64 位 hex）：长度不对就当作「不可用」，
 * 而不是凑一段 hash 出来 —— 猜出来的密钥解不开别人的密文，只会换来更难查的错。
 *
 * @param {string} keyFile
 * @param {(msg: string) => void} [log]
 * @returns {Buffer|null}
 */
function loadKey(keyFile, log) {
  const file = String(keyFile || '').trim();
  if (!file) return null;
  let raw;
  try {
    raw = fs.readFileSync(file);
  } catch (err) {
    if (log) log(`凭据密钥文件读不到（${file}）：${(err && err.message) || err}`);
    return null;
  }
  const trimmed = raw.toString('utf8').trim();
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) return Buffer.from(trimmed, 'hex');
  if (raw.length === KEY_LEN) return raw;
  if (log) {
    log(`凭据密钥必须是 32 字节或 64 位 hex（当前 ${raw.length} 字节）：${file}`);
  }
  return null;
}

/** 生成一份新密钥文件（0600）。由 `dieyun-headless gen-key` 调用。 */
function generateKeyFile(keyFile) {
  const file = path.resolve(String(keyFile || '').trim());
  if (!file) throw new Error('gen-key 需要 --out <文件路径>');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, crypto.randomBytes(KEY_LEN), { mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // Windows 上 chmod 语义有限，写成功即可
  }
  return file;
}

/**
 * @param {{ keyFile?: string, log?: (msg: string) => void }} [opts]
 * @returns {{ isEncryptionAvailable: () => boolean, encryptString: (s: string) => Buffer, decryptString: (b: Buffer) => string }}
 */
function createSecretStorage(opts = {}) {
  const log = typeof opts.log === 'function' ? opts.log : () => {};
  const keyFile = String(opts.keyFile || '').trim();
  const key = loadKey(keyFile, log);

  function assertKey() {
    if (!key) {
      const e = new Error(
        '当前系统无法加密存储凭据（headless 缺少 DIEYUN_SECRET_KEY_FILE：请先运行 ' +
          '`dieyun-headless gen-key --out /etc/dieyun/secret.key` 并把它写进服务环境）'
      );
      e.code = 'ENCRYPT_UNAVAILABLE';
      throw e;
    }
    return key;
  }

  return {
    isEncryptionAvailable: () => !!key,
    /** @param {string} text @returns {Buffer} */
    encryptString(text) {
      const k = assertKey();
      const iv = crypto.randomBytes(IV_LEN);
      const cipher = crypto.createCipheriv(ALGO, k, iv);
      const body = Buffer.concat([cipher.update(String(text), 'utf8'), cipher.final()]);
      return Buffer.concat([Buffer.from([VERSION]), iv, cipher.getAuthTag(), body]);
    },
    /** @param {Buffer} buf @returns {string} */
    decryptString(buf) {
      const k = assertKey();
      const raw = Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf || ''), 'base64');
      if (raw.length < 1 + IV_LEN + TAG_LEN) throw new Error('密文长度不合法');
      if (raw[0] !== VERSION) throw new Error(`不支持的密文版本：${raw[0]}`);
      const iv = raw.subarray(1, 1 + IV_LEN);
      const tag = raw.subarray(1 + IV_LEN, 1 + IV_LEN + TAG_LEN);
      const body = raw.subarray(1 + IV_LEN + TAG_LEN);
      const decipher = crypto.createDecipheriv(ALGO, k, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
    }
  };
}

module.exports = { createSecretStorage, generateKeyFile, loadKey, KEY_LEN, VERSION };

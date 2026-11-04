/* globals describe, it, expect, beforeEach, afterEach */
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createSecretStorage, generateKeyFile } = require('../../src/headless/secret-storage');

describe('headless/secret-storage', () => {
  let dir;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dhs-secret-'));
  });

  afterEach(() => {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it('没有密钥就是「不可用」，且拒绝加密（绝不回退明文）', () => {
    const ss = createSecretStorage({ keyFile: path.join(dir, 'missing.key') });
    expect(ss.isEncryptionAvailable()).toBe(false);
    expect(() => ss.encryptString('secret')).toThrow(/无法加密存储凭据/);
  });

  it('生成的密钥可往返：加密后再解密得到原文', () => {
    const keyFile = path.join(dir, 'secret.key');
    generateKeyFile(keyFile);
    const ss = createSecretStorage({ keyFile });
    expect(ss.isEncryptionAvailable()).toBe(true);
    const buf = ss.encryptString('sk-测试-key-123');
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(ss.decryptString(buf)).toBe('sk-测试-key-123');
  });

  it('同一明文两次加密的密文不同（随机 IV），但都能解回', () => {
    const keyFile = path.join(dir, 'secret.key');
    generateKeyFile(keyFile);
    const ss = createSecretStorage({ keyFile });
    const a = ss.encryptString('same');
    const b = ss.encryptString('same');
    expect(a.equals(b)).toBe(false);
    expect(ss.decryptString(a)).toBe('same');
    expect(ss.decryptString(b)).toBe('same');
  });

  it('换一把密钥解不开（与 Electron 密文互不通用，是必须写进文档的边界）', () => {
    const k1 = path.join(dir, 'a.key');
    const k2 = path.join(dir, 'b.key');
    generateKeyFile(k1);
    generateKeyFile(k2);
    const one = createSecretStorage({ keyFile: k1 });
    const other = createSecretStorage({ keyFile: k2 });
    const buf = one.encryptString('x');
    expect(() => other.decryptString(buf)).toThrow();
  });

  it('64 位 hex 形态的密钥文件也认（便于从密钥管理系统注入）', () => {
    const keyFile = path.join(dir, 'hex.key');
    fs.writeFileSync(keyFile, crypto.randomBytes(32).toString('hex'));
    const ss = createSecretStorage({ keyFile });
    expect(ss.isEncryptionAvailable()).toBe(true);
    expect(ss.decryptString(ss.encryptString('hex-key'))).toBe('hex-key');
  });

  it('长度不对的密钥文件当作不可用（不 hash 出密钥去猜）', () => {
    const keyFile = path.join(dir, 'short.key');
    fs.writeFileSync(keyFile, 'too-short');
    const warns = [];
    const ss = createSecretStorage({ keyFile, log: (m) => warns.push(m) });
    expect(ss.isEncryptionAvailable()).toBe(false);
    expect(warns.join('\n')).toMatch(/32 字节/);
  });

  it('被篡改的密文解不开（GCM 认证失败，不是静默返回垃圾）', () => {
    const keyFile = path.join(dir, 'secret.key');
    generateKeyFile(keyFile);
    const ss = createSecretStorage({ keyFile });
    const buf = ss.encryptString('payload');
    buf[buf.length - 1] ^= 0xff;
    expect(() => ss.decryptString(buf)).toThrow();
  });
});

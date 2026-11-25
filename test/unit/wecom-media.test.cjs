'use strict';

/**
 * 企业微信长连接多媒体解密（`src/channels/wecom-media.js`）。
 *
 * 这是整条频道链路上最容易「静默出错」的一段：解错了不会抛，只会存下一堆高熵二进制，
 * 视觉通道看不到画面、文件工具也读不出内容（2026-11-18 的真实故障）。所以这里钉死四件事：
 * ① aeskey 的三种下发形状；② IV = 密钥前 16 字节 + 企微的 **32 字节对齐**填充；
 * ③ 拿不到密钥时原样返回；④ 判型只认魔数（不信 CDN 的 content-type）。
 */

const crypto = require('crypto');
const { decodeMediaKey, decryptMedia, sniffImageMime } = require('../../src/channels/wecom-media');

const RAW_KEY = '0123456789abcdef0123456789abcdef'; // 正好 32 字符
const KEY = Buffer.from(RAW_KEY, 'utf8');

/** 企微把明文补齐到 32 字节倍数，末字节的填充长度可能是 1..32 */
function padTo32(plain) {
  const pad = 32 - (plain.length % 32);
  return Buffer.concat([plain, Buffer.alloc(pad, pad)]);
}

/** 与企微同形状的密文：AES-256-CBC，IV = 密钥前 16 字节，autoPadding 关掉后自己补 */
function encryptLikeWecom(plain, key = KEY) {
  const cipher = crypto.createCipheriv('aes-256-cbc', key, key.subarray(0, 16));
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(padTo32(plain)), cipher.final()]);
}

describe('decodeMediaKey', () => {
  it('32 字符直接当密钥', () => {
    expect(decodeMediaKey(RAW_KEY).equals(KEY)).toBe(true);
  });

  it('43/44 字符 base64（可能缺 =）解出来也是 32 字节', () => {
    const b64 = KEY.toString('base64'); // 44 字符，带一个 =
    expect(decodeMediaKey(b64).equals(KEY)).toBe(true);
    expect(decodeMediaKey(b64.replace(/=+$/, '')).equals(KEY)).toBe(true);
  });

  it('URL 编码过的 aeskey 先解一次再判形状', () => {
    const b64 = KEY.toString('base64');
    const urlEncoded = encodeURIComponent(b64);
    expect(urlEncoded).not.toBe(b64);
    expect(decodeMediaKey(urlEncoded).equals(KEY)).toBe(true);
  });

  it('空值返回 null（表示「这条载荷没有密钥」），不抛', () => {
    expect(decodeMediaKey('')).toBe(null);
    expect(decodeMediaKey(null)).toBe(null);
    expect(decodeMediaKey(undefined)).toBe(null);
  });

  it('形状不认识就抛错，并且说清长度（不猜、不降级）', () => {
    expect(() => decodeMediaKey('short')).toThrow(/aeskey 形状不认识/);
  });
});

describe('decryptMedia', () => {
  it('解出与原文一致的明文（含 32 字节对齐填充）', () => {
    const plain = Buffer.from('{"hello":"世界"}' + 'x'.repeat(40), 'utf8');
    const cipher = encryptLikeWecom(plain);
    expect(cipher.length % 16).toBe(0);
    const out = decryptMedia(cipher, RAW_KEY);
    expect(out.equals(plain)).toBe(true);
  });

  it('没有 aeskey 时原样返回（老字段 / 明文载荷走同一条路）', () => {
    const body = Buffer.from('plain-bytes');
    expect(decryptMedia(body, '').equals(body)).toBe(true);
    expect(decryptMedia(body, null).equals(body)).toBe(true);
  });

  it('密文长度不是 16 的倍数：抛错并带上实际长度', () => {
    const bad = Buffer.concat([encryptLikeWecom(Buffer.from('abc')), Buffer.from([1, 2, 3])]);
    expect(() => decryptMedia(bad, RAW_KEY)).toThrow(/不是 16 的倍数/);
  });

  it('密钥不对：填充校验失败要抛错（不能把垃圾当明文交出去）', () => {
    const cipher = encryptLikeWecom(Buffer.from('hello wecom'), KEY);
    const wrongKey = 'ffffffffffffffffffffffffffffffff';
    expect(() => decryptMedia(cipher, wrongKey)).toThrow(/解密失败/);
  });

  it('空 body 原样返回', () => {
    expect(decryptMedia(Buffer.alloc(0), RAW_KEY).length).toBe(0);
  });
});

describe('sniffImageMime（判型只认魔数）', () => {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]);
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
  const gif = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0, 0, 0, 0, 0, 0]);
  const webp = Buffer.concat([
    Buffer.from('RIFF', 'latin1'),
    Buffer.from([0, 0, 0, 0]),
    Buffer.from('WEBP', 'latin1')
  ]);

  it('四种上游支持的格式', () => {
    expect(sniffImageMime(jpeg)).toBe('image/jpeg');
    expect(sniffImageMime(png)).toBe('image/png');
    expect(sniffImageMime(gif)).toBe('image/gif');
    expect(sniffImageMime(webp)).toBe('image/webp');
  });

  it('认不出、空值、太短一律返回空串（调用方据此报「格式不支持」）', () => {
    expect(sniffImageMime(Buffer.from('not-an-image'))).toBe('');
    expect(sniffImageMime(Buffer.alloc(0))).toBe('');
    expect(sniffImageMime(null)).toBe('');
    expect(sniffImageMime(Buffer.from([0xff, 0xd8]))).toBe('');
  });

  it('与视觉白名单共用同一份判型实现（guardrails-shared）', () => {
    const shared = require('../../src/agent/guardrails-shared');
    expect(typeof shared.sniffImageMimeFromBytes).toBe('function');
    expect(shared.sniffImageMimeFromBytes(png)).toBe(sniffImageMime(png));
    // base64 版走的是同一个内核
    expect(shared.sniffVisionImageMime(png.toString('base64'))).toBe('image/png');
  });
});

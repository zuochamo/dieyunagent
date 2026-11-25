'use strict';

/**
 * 企业微信智能机器人「长连接」模式的多媒体（图片 / 文件 / 视频）解密。
 *
 * 为什么非有这一层：长连接回调里 `image.url` / `file.url` 下载到的**不是文件本身**，
 * 而是 AES-256-CBC 密文 —— 每个 url 一条独立 `aeskey`，url 五分钟有效。不解密就落盘，
 * 存下来的「.jpg」是一段高熵二进制：视觉通道看不到画面、文件工具也读不出内容
 * （2026-11-18 的真实故障：`tool-output/vision/d0/<sha256>.jpg` 371,936 字节，熵 7.9995，
 * 文件头 `ef 73 89 d8 …` —— 长度正好是 32 的倍数，就是企微的密文）。
 *
 * 官方口径（developer.work.weixin.qq.com/document/path/101834「多媒体资源解密」）：
 * 算法 AES-256-CBC；密钥 = 回调里的 `aeskey`；IV = 密钥前 16 字节；PKCS#7 填充。
 * 与老「接收 URL 模式」的区别：那种模式全站共用一个 `Encoding-AESKey`，长连接是每条 url 各一把。
 *
 * 三件事集中在本文件，调用点（`agent-turn.js#prepareAttachments`）只调一次：
 * 1. 密钥形状 —— 下发可能是 32 字符（文档写的「32 字节直接使用」），也可能是 43/44 字符的
 *    base64（缺 `=` 补齐），还可能是 URL 编码过的（`%2F` / `%3D`）；
 * 2. 填充 —— 企微把明文补齐到 **32 字节**的倍数，末字节的填充长度因此可能是 1..32，
 *    超过 Node `autoPadding` 能认的 16 上限；用 `setAutoPadding(false)` + 自己校验，
 *    否则 PC 端发的截图会稳定报 `bad decrypt`（社区已有多例）；
 * 3. 判型 —— 解密后的字节用**魔数**认图片，不信 CDN 的 `content-type`
 *    （企微对象存储常见 `application/octet-stream`）。
 */

const crypto = require('crypto');
const { sniffImageMimeFromBytes } = require('../agent/guardrails-shared');

const KEY_BYTES = 32;
const IV_BYTES = 16;
const BLOCK_BYTES = 16;
/** 企微补齐到 32 字节倍数，末字节的填充长度因此可能大于一个 AES 块（16）。 */
const MAX_PAD_BYTES = 32;

/**
 * 把回调里的 `aeskey` 解成 32 字节密钥；形状不认识就抛错（不猜、不静默降级）。
 *
 * @param {string} aeskey 回调体中 `image.aeskey` / `file.aeskey`
 * @returns {Buffer|null} 空值返回 null（表示「这条载荷没有密钥」，见 decryptMedia）
 */
function decodeMediaKey(aeskey) {
  let text = String(aeskey == null ? '' : aeskey).trim();
  if (!text) return null;
  // 回调字段可能被 URL 编码（`%2F` / `%3D`）：先解一次，否则按长度判形状必然走错分支
  if (/%[0-9a-fA-F]{2}/.test(text)) {
    try {
      text = decodeURIComponent(text);
    } catch {
      // 解不开就按原文继续，长度不对会在下面报出来
    }
  }
  if (text.length === KEY_BYTES) return Buffer.from(text, 'utf8');
  const padded = text + '='.repeat((4 - (text.length % 4)) % 4);
  let key = null;
  try {
    key = Buffer.from(padded, 'base64');
  } catch {
    key = null;
  }
  // base64 解出来必须正好 32 字节：43/44 字符是唯一合法的补位形态
  if (key && key.length === KEY_BYTES) return key;
  throw new Error(`aeskey 形状不认识（长度 ${text.length}，应为 32 字符或 43~44 字符 base64）`);
}

/** 按末字节校验并剥掉 PKCS#7 填充；不合法说明密钥错或不是企微的密文。 */
function stripPkcs7(buf) {
  const total = buf.length;
  if (!total) return buf;
  const pad = buf[total - 1];
  if (pad < 1 || pad > MAX_PAD_BYTES || pad > total) {
    throw new Error('解密失败（填充长度不合法，密钥可能不对）');
  }
  for (let i = total - pad; i < total; i += 1) {
    if (buf[i] !== pad) throw new Error('解密失败（填充字节不一致，密钥可能不对）');
  }
  return buf.subarray(0, total - pad);
}

/**
 * 解密一条多媒体载荷。
 *
 * 没有 `aeskey` 时原样返回：长连接回调的媒体一定带密钥，但 `pic_url` 这类老字段 /
 * 明文载荷也走这条路，多一个分支不如在这里一次说清 —— 这是**协议字段可选**，不是降级层。
 *
 * @param {Buffer} buf 下载到的原始字节（已过 SSRF 校验）
 * @param {string} [aeskey] 回调体里该 url 对应的密钥
 * @returns {Buffer} 明文
 */
function decryptMedia(buf, aeskey) {
  const body = buf && buf.length ? buf : Buffer.alloc(0);
  const key = decodeMediaKey(aeskey);
  if (!key || !body.length) return body;
  if (body.length % BLOCK_BYTES !== 0) {
    throw new Error(`解密失败（密文长度 ${body.length} 不是 16 的倍数）`);
  }
  let plain;
  try {
    const decipher = crypto.createDecipheriv('aes-256-cbc', key, key.subarray(0, IV_BYTES));
    // 企微的填充可能超过 16 字节，Node 的 autoPadding 会在 final() 里直接判错
    decipher.setAutoPadding(false);
    plain = Buffer.concat([decipher.update(body), decipher.final()]);
  } catch (e) {
    throw new Error(`解密失败（${(e && e.message) || e}）`);
  }
  return stripPkcs7(plain);
}

/**
 * 用文件头认图片类型 —— 判型实现**不在本文件**：唯一实现在
 * `agent/guardrails-shared.js#sniffImageMimeFromBytes`（与视觉白名单同一批格式、同一份魔数）。
 * 这里只保留一个同签名包装，供 `agent-turn.js#prepareAttachments` 就近调用。
 *
 * @param {Buffer} buf
 * @returns {string} `image/jpeg` / `image/png` / `image/webp` / `image/gif`；认不出返回 ''
 */
function sniffImageMime(buf) {
  return sniffImageMimeFromBytes(buf);
}

module.exports = {
  decodeMediaKey,
  decryptMedia,
  sniffImageMime
};

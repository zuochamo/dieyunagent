'use strict';

/**
 * SSRF 白名单：全仓唯一的 URL 安全校验。
 * mcp/skills catalog 与 web 抓取链路共用，勿在别处再写一份。
 *
 * 语义约定（改动会影响调用方）：
 * - 解析失败 → code=INVALID_URL
 * - 协议/主机/端口不合规 → code=URL_NOT_ALLOWED
 */

const ALLOWED_PORTS = new Set([80, 443]);

function isPrivateIpv4(host) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const a = m.slice(1).map(Number);
  if (a.some((n) => n > 255)) return true;
  if (a[0] === 10) return true;
  if (a[0] === 127) return true;
  if (a[0] === 0) return true;
  if (a[0] === 169 && a[1] === 254) return true;
  if (a[0] === 172 && a[1] >= 16 && a[1] <= 31) return true;
  if (a[0] === 192 && a[1] === 168) return true;
  return false;
}

function isBlockedHostname(host) {
  return (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    host === '0.0.0.0' ||
    host === '[::1]' ||
    host === '::1' ||
    host === '169.254.169.254' ||
    host === 'metadata.google.internal'
  );
}

/**
 * IPv6 字面量（URL 里带方括号）的内网判定。
 *
 * 为什么必须单独判：`isPrivateIpv4` 只认点分四段，而 `http://[::ffff:127.0.0.1]/`
 * 的 hostname 是 `[::ffff:7f00:1]` —— 既不在 `isBlockedHostname` 名单里，也不是 IPv4，
 * 于是整条 SSRF 白名单被绕过，Chromium 会老老实实连上本机。
 * IPv4-mapped（`::ffff:`）一律还原成 IPv4 再走原规则。
 */
function isBlockedIpv6(host) {
  const raw = String(host || '')
    .replace(/^\[|\]$/g, '')
    .toLowerCase();
  if (!raw.includes(':')) return false;
  if (raw === '::' || raw === '::1') return true;
  const mapped = /^::ffff:(.+)$/.exec(raw);
  if (mapped) {
    const tail = mapped[1];
    if (tail.includes('.')) return isPrivateIpv4(tail) || isBlockedHostname(tail);
    const hex = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(tail);
    if (hex) {
      const hi = parseInt(hex[1], 16);
      const lo = parseInt(hex[2], 16);
      return isPrivateIpv4([hi >> 8, hi & 0xff, lo >> 8, lo & 0xff].join('.'));
    }
    // 认不出的映射形式按内网处理（保守）：宁可拒绝，也不放行一个可能指向本机的地址
    return true;
  }
  // fe80::/10 链路本地；fc00::/7 唯一本地（ULA）
  if (raw.startsWith('fe8') || raw.startsWith('fe9') || raw.startsWith('fea') || raw.startsWith('feb')) {
    return true;
  }
  return raw.startsWith('fc') || raw.startsWith('fd');
}

/**
 * @param {string} rawUrl
 * @returns {string} 规范化后的 href
 */
function assertSafeUrl(rawUrl) {
  let u;
  try {
    u = new URL(String(rawUrl || '').trim());
  } catch {
    const err = new Error('URL 无效');
    err.code = 'INVALID_URL';
    throw err;
  }
  if (!['http:', 'https:'].includes(u.protocol)) {
    const err = new Error('仅允许 http/https');
    err.code = 'URL_NOT_ALLOWED';
    throw err;
  }
  const host = (u.hostname || '').toLowerCase();
  if (!host) {
    const err = new Error('缺少主机名');
    err.code = 'URL_NOT_ALLOWED';
    throw err;
  }
  if (isBlockedHostname(host)) {
    const err = new Error('不允许访问本地地址');
    err.code = 'URL_NOT_ALLOWED';
    throw err;
  }
  if (isPrivateIpv4(host)) {
    const err = new Error('不允许访问内网 IP');
    err.code = 'URL_NOT_ALLOWED';
    throw err;
  }
  if (isBlockedIpv6(host)) {
    const err = new Error('不允许访问内网 IPv6 地址');
    err.code = 'URL_NOT_ALLOWED';
    throw err;
  }
  const port = u.port ? Number(u.port) : u.protocol === 'https:' ? 443 : 80;
  if (!ALLOWED_PORTS.has(port)) {
    const err = new Error('仅允许 80/443 端口');
    err.code = 'URL_NOT_ALLOWED';
    throw err;
  }
  return u.href;
}

/** 不抛错版本：解析/校验失败返回 null。 */
function safeUrlOrNull(rawUrl) {
  try {
    return assertSafeUrl(rawUrl);
  } catch {
    return null;
  }
}

module.exports = { assertSafeUrl, safeUrlOrNull, isPrivateIpv4, isBlockedIpv6, isBlockedHostname };

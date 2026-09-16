'use strict';

const fs = require('fs/promises');
const path = require('path');
const { pathToFileURL, fileURLToPath } = require('url');
const { normalizeFilePathInput } = require('../gateway/host-control');
const { assertAllowedPath } = require('../gateway/path-policy');

/** 常见本地文件扩展名：这类输入按本地文件解析，不做域名协议补全 */
const LOCAL_FILE_EXTENSIONS = new Set([
  'html', 'htm', 'xhtml', 'js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'vue', 'css', 'scss', 'less',
  'json', 'jsonc', 'xml', 'yaml', 'yml', 'toml', 'md', 'markdown', 'txt', 'csv', 'tsv', 'log',
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico', 'bmp', 'avif',
  'pdf', 'mp4', 'webm', 'mp3', 'wav', 'woff', 'woff2', 'ttf', 'otf', 'map',
  'sh', 'bash', 'bat', 'cmd', 'ps1', 'py', 'rb', 'go', 'rs', 'java', 'c', 'h', 'cpp',
  'exe', 'dll', 'so', 'zip', 'tar', 'gz', 'rar', 'lock'
]);

/**
 * 输入是否是「裸主机名」（可自动补协议），如 www.baidu.com、localhost:3000、192.168.1.10:8080。
 * 显式协议、盘符、UNC、以 . / ~ \ 开头的相对/绝对路径，以及带常见文件扩展名的输入都返回 false。
 * @param {string} input
 * @returns {boolean}
 */
function looksLikeBareHost(input) {
  const s = String(input || '').trim();
  if (!s || /\s/.test(s)) return false;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(s)) return false;
  if (/^[a-zA-Z]:[\\/]/.test(s)) return false;
  if (/^[\\/~.]/.test(s)) return false;
  const hostPart = s.split(/[/?#]/)[0];
  if (!hostPart) return false;
  const segments = hostPart.split(':');
  const name = segments[0];
  if (!name) return false;
  if (segments.length > 1 && !/^\d{1,5}$/.test(segments[segments.length - 1])) return false;
  if (/^localhost$/i.test(name)) return true;
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(name)) {
    return name.split('.').every((part) => Number(part) <= 255);
  }
  if (name.indexOf('.') < 0) return false;
  const labels = name.split('.');
  const tld = labels[labels.length - 1].toLowerCase();
  if (!/^[a-z\u4e00-\u9fa5]{2,}$/.test(tld)) return false;
  if (LOCAL_FILE_EXTENSIONS.has(tld)) return false;
  return labels.every((label) => /^[a-zA-Z0-9\u4e00-\u9fa5_-]+$/.test(label));
}

/** 本机/内网地址默认走 http，其余裸域名默认走 https。 */
function isLocalLikeHost(name) {
  return (
    /^localhost$/i.test(name) ||
    /^127\./.test(name) ||
    /^0\.0\.0\.0$/.test(name) ||
    /^10\./.test(name) ||
    /^192\.168\./.test(name) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(name)
  );
}

/**
 * 解析 browser.navigate 目标 URL。
 * - 裸主机名（www.baidu.com）：自动补 https://（本机/内网补 http://）
 * - http/https：原样返回
 * - file:// 或本地路径：须在 allowedRoots 白名单内，且为文件或含 index.html 的目录
 *
 * @param {string} raw
 * @param {{ allowedRoots: string[], defaultCwd?: string | null }} opts
 * @returns {Promise<string>}
 */
async function resolveBrowserNavigateUrl(raw, opts = {}) {
  const input = String(raw || '').trim();
  if (!input) {
    const err = new Error('URL 必填');
    err.code = 'INVALID_URL';
    throw err;
  }

  // 用户手输 www.baidu.com 这类裸域名：补协议，而不是去本地找同名文件
  if (looksLikeBareHost(input)) {
    const name = input.split(/[/?#]/)[0].split(':')[0];
    try {
      return new URL(`${isLocalLikeHost(name) ? 'http' : 'https'}://${input}`).toString();
    } catch {
      const err = new Error('无效的 URL');
      err.code = 'INVALID_URL';
      throw err;
    }
  }

  if (/^https?:\/\//i.test(input)) {
    let u;
    try {
      u = new URL(input);
    } catch {
      const err = new Error('无效的 URL');
      err.code = 'INVALID_URL';
      throw err;
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      const err = new Error('仅支持 http/https 或白名单内本地文件');
      err.code = 'INVALID_URL';
      throw err;
    }
    return u.toString();
  }

  const roots = (opts.allowedRoots || []).map((r) => path.resolve(r));
  if (!roots.length) {
    const err = new Error('本地文件预览需要配置工作目录');
    err.code = 'PATH_NOT_ALLOWED';
    throw err;
  }

  let filePath;
  if (/^file:\/\//i.test(input)) {
    try {
      filePath = fileURLToPath(input);
    } catch {
      const err = new Error('无效的 file:// URL');
      err.code = 'INVALID_URL';
      throw err;
    }
  } else {
    filePath = normalizeFilePathInput(input, opts.defaultCwd || null);
  }

  const safe = assertAllowedPath(filePath, roots);
  const target = await resolveLocalHtmlFile(safe);
  return pathToFileURL(target).href;
}

async function resolveLocalHtmlFile(resolvedPath) {
  let st;
  try {
    st = await fs.stat(resolvedPath);
  } catch {
    const err = new Error(
      '文件不存在；若要打开网址，请输入域名（如 www.example.com）或完整 http(s):// 地址'
    );
    err.code = 'FILE_NOT_FOUND';
    throw err;
  }

  if (st.isDirectory()) {
    const indexPath = path.join(resolvedPath, 'index.html');
    try {
      const indexSt = await fs.stat(indexPath);
      if (indexSt.isFile()) return indexPath;
    } catch {
      // fall through
    }
    const err = new Error('目录内未找到 index.html');
    err.code = 'FILE_NOT_FOUND';
    throw err;
  }

  if (!st.isFile()) {
    const err = new Error('不是有效文件');
    err.code = 'INVALID_URL';
    throw err;
  }

  return resolvedPath;
}

/**
 * 内置浏览器跑在本机，SSH 工作空间下打开 localhost / 127.0.0.1 这类本机地址，
 * 实际想看的是「远端主机上的服务」，必须靠 SSH 端口转发才能访问。
 * 返回需要转发的远端端口；非 http(s) 或非本机地址返回 null。
 *
 * @param {string} rawUrl
 * @returns {{ remoteHost: string, remotePort: number } | null}
 */
function parseRemotePreviewTarget(rawUrl) {
  let u;
  try {
    u = new URL(String(rawUrl || '').trim());
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  const hostname = String(u.hostname || '').replace(/^\[|\]$/g, '').toLowerCase();
  if (!REMOTE_PREVIEW_HOSTS.has(hostname)) return null;
  const remotePort = Number(u.port) || (u.protocol === 'https:' ? 443 : 80);
  if (!remotePort) return null;
  return { remoteHost: '127.0.0.1', remotePort };
}

/** @param {string} url 已通过 resolveBrowserNavigateUrl 校验 */
function assertBrowserLoadUrl(url) {
  const u = String(url || '').trim();
  let parsed;
  try {
    parsed = new URL(u);
  } catch {
    const err = new Error('无效的 URL');
    err.code = 'INVALID_URL';
    throw err;
  }
  if (!['http:', 'https:', 'file:'].includes(parsed.protocol)) {
    const err = new Error('浏览器仅支持 http/https 或 file://');
    err.code = 'INVALID_URL';
    throw err;
  }
  return u;
}

/** 本机地址（含 IPv6 环回）：SSH 工作空间下需要端口转发才能预览。 */
const REMOTE_PREVIEW_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1']);

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 请求改写规则的 URL 匹配：`*` 通配、完整相等、或子串包含。
 * @param {string} pattern
 * @param {string} url
 */
function matchUrlPattern(pattern, url) {
  const p = String(pattern || '*');
  const target = String(url || '');
  if (!p || p === '*') return true;
  if (p === target) return true;
  if (p.indexOf('*') >= 0) {
    const re = new RegExp('^' + p.split('*').map(escapeRegExp).join('.*') + '$');
    return re.test(target);
  }
  return target.indexOf(p) >= 0;
}

module.exports = {
  resolveBrowserNavigateUrl,
  parseRemotePreviewTarget,
  assertBrowserLoadUrl,
  matchUrlPattern
};

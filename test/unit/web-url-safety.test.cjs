'use strict';

/**
 * URL 安全白名单（2026-10-17 修复 IPv6 分支）。
 *
 * 事故形态：`isPrivateIpv4` 只认点分四段，`isBlockedHostname` 只列了 `[::1]`，
 * 于是 `http://[::ffff:127.0.0.1]/`（hostname = `[::ffff:7f00:1]`）整条通过校验，
 * Chromium 会真的连上本机 —— SSRF 白名单被绕过。
 */

const { assertSafeUrl, isBlockedIpv6, isPrivateIpv4 } = require('../../src/gateway/web/url-safety');

function codeOf(url) {
  try {
    assertSafeUrl(url);
    return 'OK';
  } catch (err) {
    return err.code;
  }
}

describe('URL 白名单', () => {
  it('常规公网 https 放行', () => {
    expect(codeOf('https://cn.bing.com/search?q=x')).toBe('OK');
    expect(codeOf('http://example.com/')).toBe('OK');
  });

  it('IPv4 内网与回环照旧拒绝', () => {
    expect(codeOf('http://127.0.0.1/')).toBe('URL_NOT_ALLOWED');
    expect(codeOf('http://192.168.31.62:80/')).toBe('URL_NOT_ALLOWED');
    expect(codeOf('http://10.0.0.5/')).toBe('URL_NOT_ALLOWED');
    expect(codeOf('http://localhost/')).toBe('URL_NOT_ALLOWED');
    expect(codeOf('http://169.254.169.254/latest/meta-data/')).toBe('URL_NOT_ALLOWED');
  });

  it('IPv6 回环 / 映射 / 链路本地 / ULA 全部拒绝', () => {
    expect(codeOf('http://[::1]/')).toBe('URL_NOT_ALLOWED');
    expect(codeOf('http://[::ffff:127.0.0.1]/')).toBe('URL_NOT_ALLOWED');
    expect(codeOf('http://[::ffff:7f00:1]/')).toBe('URL_NOT_ALLOWED');
    expect(codeOf('http://[::ffff:192.168.1.1]/')).toBe('URL_NOT_ALLOWED');
    expect(codeOf('http://[fe80::1]/')).toBe('URL_NOT_ALLOWED');
    expect(codeOf('http://[fd00::1]/')).toBe('URL_NOT_ALLOWED');
  });

  it('公网 IPv6 不误杀', () => {
    expect(codeOf('http://[2001:4860:4860::8888]/')).toBe('OK');
  });

  it('非 80/443 端口与非 http 协议照旧拒绝', () => {
    expect(codeOf('http://example.com:8080/')).toBe('URL_NOT_ALLOWED');
    expect(codeOf('file:///C:/Windows/win.ini')).toBe('URL_NOT_ALLOWED');
  });

  it('判定函数本身不抛错', () => {
    expect(isPrivateIpv4('127.0.0.1')).toBe(true);
    expect(isBlockedIpv6('[::ffff:7f00:1]')).toBe(true);
    expect(isBlockedIpv6('example.com')).toBe(false);
  });
});

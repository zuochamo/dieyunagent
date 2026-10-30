'use strict';

/**
 * CSP 契约：`media-src` 必须放行 `blob:`。
 *
 * 两次踩坑的历史：
 * 1. `img-src` 早就补了 `data: blob:`（图片预览用 Blob URL）；
 * 2. 「朗读」用 `new Audio(URL.createObjectURL(blob))` 播合成的音频，但 `default-src 'self'`
 *    不覆盖 `blob:`，Chromium 直接拒绝：`MEDIA_ELEMENT_ERROR: Media load rejected by URL
 *    safety check` → `NotSupportedError: no supported source found`。
 *    实测同一段 mp3：无 media-src 播放失败，加上即 `loadedmetadata` 成功。
 * 所以这条用测试钉住：以后改 CSP 忘了 media-src，测试先红。
 */
const fs = require('node:fs');
const path = require('node:path');

const INDEX = path.join(__dirname, '..', '..', 'src', 'renderer', 'index.html');

function cspDirectives(html) {
  const match = html.match(
    /<meta[^>]+http-equiv=["']Content-Security-Policy["'][^>]*>/i
  );
  if (!match) return null;
  // 注意：策略值本身含有单引号（'self'），所以按双引号取值，不能 [^"']+ 一把抓
  const contentMatch = match[0].match(/content="([^"]*)"/i) || match[0].match(/content='([^']*)'/i);
  if (!contentMatch) return null;
  const map = {};
  for (const part of contentMatch[1].split(';')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const [name, ...values] = trimmed.split(/\s+/);
    map[name.toLowerCase()] = values;
  }
  return map;
}

describe('index.html 的 CSP 必须允许 Blob 音频', () => {
  const html = fs.readFileSync(INDEX, 'utf8');
  const csp = cspDirectives(html);

  it('有 CSP 且声明了 media-src', () => {
    expect(csp).toBeTruthy();
    expect(csp['media-src']).toBeTruthy();
  });

  it("media-src 同时放行 'self' 与 blob:", () => {
    const media = csp['media-src'] || [];
    expect(media).toContain("'self'");
    expect(media).toContain('blob:');
  });
});

'use strict';

/**
 * HTML 实体解码的边界（2026-10-17 修复）。
 *
 * 事故形态：`String.fromCodePoint` 对 >0x10FFFF 的码点抛 RangeError，而
 * `decodeHtmlEntities` 被 `cleanInline`（每条搜索结果 title/snippet）与
 * `blockTextOf`（web_fetch 正文）调用，且调用点没有 try/catch ——
 * 一个损坏实体就能让整次 web_search / web_fetch 变成「未知错误」。
 */

const { decodeHtmlEntities, htmlToText } = require('../../src/gateway/web/text');

describe('HTML 实体解码边界', () => {
  it('越界码点不抛错，退化成空串', () => {
    expect(() => decodeHtmlEntities('a&#1114112;b')).not.toThrow();
    expect(decodeHtmlEntities('a&#1114112;b')).toBe('ab');
    expect(decodeHtmlEntities('a&#x110000;b')).toBe('ab');
    expect(decodeHtmlEntities('&#99999999999;')).toBe('');
  });

  it('代理区不产出孤立代理项', () => {
    // U+D800 不抛但会产生孤代理，写进 JSON/日志会变替换符，按空串处理
    expect(decodeHtmlEntities('x&#55296;y')).toBe('xy');
    expect(decodeHtmlEntities('x&#xD800;y')).toBe('xy');
  });

  it('正常实体照常解码（十进制 / 十六进制 / 命名）', () => {
    expect(decodeHtmlEntities('&amp;&lt;&gt;&quot;')).toBe('&<>"');
    expect(decodeHtmlEntities('&#65;&#x42;')).toBe('AB');
    expect(decodeHtmlEntities('a&nbsp;b')).toBe('a b');
    expect(decodeHtmlEntities('&#0;')).toBe('');
  });

  it('整页含坏实体时 htmlToText 不炸，且保留其余文本', () => {
    expect(() => htmlToText('<p>x&#1114112;y</p>')).not.toThrow();
    expect(htmlToText('<p>x&#1114112;y</p>')).toBe('xy');
  });
});

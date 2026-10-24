'use strict';

/**
 * 文本清洗与 HTML→纯文本：全仓唯一来源。
 * 只做「字符串层面」的清理；DOM 结构化抽取见 extract.js。
 */

const ENTITY_MAP = {
  nbsp: ' ',
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  ldquo: '“',
  rdquo: '”',
  lsquo: '‘',
  rsquo: '’',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  middot: '·',
  times: '×'
};

/**
 * 码点 → 文本，越界一律返回空串。
 *
 * `String.fromCodePoint` 对 0 / 负值 / >0x10FFFF 抛 RangeError，对代理区（D800-DFFF）
 * 则安静地返回孤立代理项（写进日志/JSON 会变成替换符）。损坏 HTML 里出现
 * `&#1114112;`、`&#x110000;` 这种实体并不罕见，一次抛错就能把整条 web_fetch /
 * web_search 变成「未知错误」（cleanInline 是每条搜索结果 title/snippet 的出口），
 * 所以范围检查必须做在这里，不能靠调用方兜。
 */
function codePointText(code) {
  if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return '';
  if (code >= 0xd800 && code <= 0xdfff) return '';
  return String.fromCodePoint(code);
}

function decodeHtmlEntities(text) {
  let s = String(text || '');
  s = s.replace(/&([a-zA-Z]+);/g, (m, name) => {
    const key = String(name).toLowerCase();
    return Object.prototype.hasOwnProperty.call(ENTITY_MAP, key) ? ENTITY_MAP[key] : m;
  });
  s = s.replace(/&#(\d+);/g, (_m, n) => codePointText(Number(n)));
  s = s.replace(/&#x([0-9a-f]+);/gi, (_m, n) => codePointText(parseInt(n, 16)));
  return s;
}

const DROP_BLOCK_RE = /<(script|style|noscript|template|svg|canvas)[\s\S]*?<\/\1>/gi;

/**
 * 粗粒度 HTML→文本：用于「不需要正文定位」的场景（API 响应、片段、回退）。
 * 会保留行结构，但不区分正文与导航。
 * @param {string} html
 * @returns {string}
 */
function htmlToText(html) {
  let s = String(html || '');
  s = s.replace(DROP_BLOCK_RE, ' ');
  s = s.replace(/<!--[\s\S]*?-->/g, ' ');
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<\/(p|div|h[1-6]|li|tr|section|article|header|footer|blockquote|pre)>/gi, '\n');
  s = s.replace(/<[^>]+>/g, ' ');
  s = decodeHtmlEntities(s);
  return collapseWhitespace(s);
}

/** 压掉行首空白与连续空行，保留换行结构。 */
function collapseWhitespace(text) {
  return String(text || '')
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** 单行字段（标题/摘要）清洗：折叠所有空白。 */
function cleanInline(text) {
  return decodeHtmlEntities(String(text || ''))
    .replace(/\s+/g, ' ')
    .trim();
}

/** 截断，超长补省略号。limit<=0 表示不截断。 */
function clipText(text, limit) {
  const t = String(text || '');
  const n = Number(limit);
  if (!Number.isFinite(n) || n <= 0 || t.length <= n) return t;
  return `${t.slice(0, n)}…`;
}

module.exports = { decodeHtmlEntities, htmlToText, collapseWhitespace, cleanInline, clipText };

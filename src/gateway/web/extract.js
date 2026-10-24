'use strict';

/**
 * 正文抽取：把整页 HTML 收敛成「像正文的那一段」。
 *
 * 旧实现直接去标签，导航/页脚/推荐位全进正文，12k 预算常被噪声吃满。
 * 这里用「候选容器 + 文本密度打分 + 链接密度惩罚」的轻量启发式（Readability 的核心思路，
 * 不做完整实现），失败时回退到全页纯文本，保证永不返回空。
 */

const { parse } = require('node-html-parser');
const { collapseWhitespace, clipText, decodeHtmlEntities } = require('./text');

const NOISE_TAGS =
  'script,style,noscript,template,svg,canvas,iframe,nav,header,footer,aside,form,button,select,option,input,textarea,label,dialog';

const NOISE_SIGNATURE_RE =
  /(?:^|[\s_-])(nav|navbar|menu|sidebar|side|footer|header|comment|comments|share|social|related|recommend|advert|ad|ads|banner|cookie|breadcrumb|pagination|pager|toolbar|popup|modal|subscribe|newsletter|login|signin|tool|widget|promo)(?:$|[\s_-])/i;

const MAIN_SELECTORS = [
  'article',
  'main',
  '[role="main"]',
  '.article',
  '.post',
  '.entry-content',
  '.markdown-body',
  '.rich_media_content',
  '#js_content',
  '.content',
  '#content',
  '.main-content'
];

const BLOCK_TAGS = new Set([
  'p', 'div', 'section', 'article', 'main', 'li', 'ul', 'ol', 'tr', 'td', 'th', 'table', 'tbody',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'pre', 'figcaption', 'figure', 'dd', 'dt',
  'header', 'footer', 'aside', 'nav', 'hr', 'br', 'form'
]);

function parseHtml(html) {
  return parse(String(html || ''), {
    comment: false,
    blockTextElements: { script: true, style: true, noscript: true, pre: true }
  });
}

function tagOf(node) {
  return String((node && node.rawTagName) || '').toLowerCase();
}

function walkText(node, out) {
  if (!node) return;
  if (node.nodeType === 3) {
    out.push(node.text != null ? node.text : node.rawText || '');
    return;
  }
  if (node.nodeType !== 1) return;
  const tag = tagOf(node);
  if (tag === 'script' || tag === 'style' || tag === 'noscript' || tag === 'template') return;
  const isBlock = BLOCK_TAGS.has(tag);
  if (isBlock) out.push('\n');
  for (const child of node.childNodes || []) walkText(child, out);
  if (isBlock) out.push('\n');
}

/** 把节点渲染成带换行的纯文本（不做噪声过滤）。 */
function blockTextOf(node) {
  const out = [];
  walkText(node, out);
  return collapseWhitespace(decodeHtmlEntities(out.join('')));
}

function textLength(node) {
  if (!node) return 0;
  const out = [];
  walkText(node, out);
  return out.join('').replace(/\s+/g, ' ').trim().length;
}

function linkTextRatio(node) {
  const total = textLength(node);
  if (!total) return 1;
  let linkLen = 0;
  for (const a of node.querySelectorAll('a')) linkLen += textLength(a);
  return Math.min(1, linkLen / total);
}

/** 只删「明显不是正文」的节点；在候选容器上调用，成本可控。 */
function stripNoise(node) {
  for (const n of node.querySelectorAll(NOISE_TAGS)) {
    try {
      n.remove();
    } catch {
      /* 已脱离文档 */
    }
  }
  for (const n of node.querySelectorAll('[class],[id]')) {
    const sig = `${n.getAttribute('class') || ''} ${n.getAttribute('id') || ''}`.trim();
    if (!sig) continue;
    if (NOISE_SIGNATURE_RE.test(sig)) {
      try {
        n.remove();
      } catch {
        /* 已脱离文档 */
      }
    }
  }
}

function pickContainer(root) {
  const candidates = [];
  for (const sel of MAIN_SELECTORS) {
    for (const n of root.querySelectorAll(sel)) {
      if (!candidates.includes(n)) candidates.push(n);
    }
    if (candidates.length >= 6) break;
  }

  let best = null;
  let bestScore = 0;
  let bestSemantic = false;
  for (const node of candidates) {
    const len = textLength(node);
    const tag = tagOf(node);
    const isSemantic = tag === 'article' || tag === 'main' || node.getAttribute('role') === 'main';
    // 语义容器（article/main）本身就是正文，短文（公告、词典条目）也要接住；
    // 靠 class 猜的容器才设长度门槛，否则一句话的卡片会把 body 顶掉。
    if (len < (isSemantic ? 1 : 40)) continue;
    const tagBonus = isSemantic ? 1.35 : 1;
    const score = len * (1 - linkTextRatio(node)) * tagBonus;
    if (score > bestScore) {
      bestScore = score;
      best = node;
      bestSemantic = isSemantic;
    }
  }
  if (best) return { node: best, matched: true, semantic: bestSemantic };

  const body = root.querySelector('body') || root;
  return { node: body, matched: false, semantic: false };
}

/**
 * @param {string} html
 * @param {{ maxChars?: number }} [opts]
 * @returns {{ title: string, text: string, truncated: boolean, mode: 'main'|'plain', matched: boolean, length: number }}
 */
function extractMainContent(html, opts = {}) {
  const raw = String(html || '');
  const root = parseHtml(raw);
  const title = collapseWhitespace(
    decodeHtmlEntities((root.querySelector('title') && root.querySelector('title').text) || '')
  );

  const { node, matched, semantic } = pickContainer(root);
  if (matched) stripNoise(node);

  let text = blockTextOf(node);
  let mode = matched ? 'main' : 'plain';

  // 语义容器抽出来就是正文，哪怕只有一句话也不回退（回退会把导航/页脚带回来）；
  // 只有「靠 class 猜的容器」短到不合理时，才退回全页。
  if (!text || (!semantic && text.length < 40)) {
    // 候选容器抽出来太短（可能是模板占位），退回全页纯文本
    const body = root.querySelector('body') || root;
    const fallback = blockTextOf(body);
    if (fallback.length > text.length) {
      text = fallback;
      mode = 'plain';
    }
  }

  const limit = Math.max(500, Math.min(32000, Number(opts.maxChars) || 12000));
  const truncated = text.length > limit;
  const out = truncated ? clipText(text, limit) : text;

  return { title, text: out, truncated, mode, matched, length: out.length };
}

module.exports = { extractMainContent, blockTextOf, parseHtml, stripNoise, pickContainer };

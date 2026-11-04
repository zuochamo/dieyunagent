/* global window, document, escapeHtml, gatewayCall, answerFigurePlaceholderHtml, isRenderableAnswerMediaPath */
'use strict';

/**
 * 回答区 Markdown（无依赖）。
 *
 * 为什么存在：正式回复气泡原本只有两条路径——含 ```mermaid → 渲染 SVG，否则 textContent
 * 纯文本直出；于是 GFM 表格、`**粗体**`、`# 标题`、列表全部以源码显示。
 *
 * 单一来源：本文件是「正文里哪些是 Markdown、怎么渲染」的唯一出处——
 *   - `scanAnswerBlocks()`   顶层围栏扫描（mermaid 拆分与代码块渲染共用同一份解析）
 *   - `hasAnswerMarkdown()`  这条正文值不值得离开纯文本通道
 *   - `renderAnswerMarkdownToHtml()`  Markdown → 受控 HTML
 * `renderer-mermaid.js` 只负责从同一份扫描结果里挑出顶层 mermaid 块。
 *
 * 安全：先把整段文本 HTML 转义，再生成白名单标签；回答里的原始 HTML 一律按文本显示。
 * 链接不写 href（点击交给 `host.open_url`），避免 Electron 里点一下把整个应用导航走。
 *
 * 时机：只在消息结束（`loading === false`）后一次性渲染；流式期间仍是 textContent 增量。
 */

/** ```` ``` ```` / `~~~` 围栏：开围栏可带 info string，闭围栏不能带（CommonMark）。 */
const ANSWER_MD_FENCE_OPEN_RE = /^ {0,3}(`{3,}|~{3,})[ \t]*([^\s`]*)/;
const ANSWER_MD_FENCE_CLOSE_RE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;

const ANSWER_MD_HEADING_RE = /^ {0,3}(#{1,6})[ \t]+(.*)$/;
const ANSWER_MD_HR_RE = /^ {0,3}(?:(?:-[ \t]*){3,}|(?:\*[ \t]*){3,}|(?:_[ \t]*){3,})$/;
const ANSWER_MD_QUOTE_RE = /^ {0,3}>/;
const ANSWER_MD_UL_RE = /^ {0,3}[-*+][ \t]+(.*)$/;
const ANSWER_MD_OL_RE = /^ {0,3}\d+[.)][ \t]+(.*)$/;

/**
 * 顶层围栏扫描：把正文切成 text / fence 块（fence 带上原始片段 `raw`）。
 *
 * 关键点：闭围栏必须是「同字符 + 不短于开围栏 + 后面没有 info string」。这样在
 * ```` ```text ```` 块里讲解语法时写的 ```` ```mermaid ```` 仍是文本内容，不会被当成
 * 顶层图块（旧实现用整篇正则，引用了 mermaid 围栏字样的技术类回答会被误判成坏图）。
 *
 * @param {string} src
 * @returns {{ type: 'text'|'fence', info?: string, lang?: string, value: string, raw: string, closed?: boolean }[]}
 */
function scanAnswerBlocks(src) {
  const lines = String(src == null ? '' : src)
    .replace(/\r\n?/g, '\n')
    .split('\n');
  const blocks = [];
  let buf = [];

  const flushText = () => {
    if (!buf.length) return;
    const value = buf.join('\n');
    buf = [];
    if (value.trim()) blocks.push({ type: 'text', value, raw: value });
  };

  for (let i = 0; i < lines.length; i += 1) {
    const open = ANSWER_MD_FENCE_OPEN_RE.exec(lines[i]);
    if (!open) {
      buf.push(lines[i]);
      continue;
    }
    const marker = open[1];
    const info = String(open[2] || '').trim();
    const raw = [lines[i]];
    const body = [];
    let closed = false;
    let j = i + 1;
    for (; j < lines.length; j += 1) {
      const close = ANSWER_MD_FENCE_CLOSE_RE.exec(lines[j]);
      if (close && close[1][0] === marker[0] && close[1].length >= marker.length) {
        raw.push(lines[j]);
        closed = true;
        break;
      }
      body.push(lines[j]);
      raw.push(lines[j]);
    }
    flushText();
    blocks.push({
      type: 'fence',
      info,
      lang: info ? info.split(/\s+/)[0] : '',
      value: body.join('\n'),
      raw: raw.join('\n'),
      closed
    });
    i = closed ? j : j - 1;
  }

  flushText();
  return blocks;
}

/** GFM 表格行拆列（支持 `\|` 转义） */
function splitAnswerTableRow(line) {
  let s = String(line || '').trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  return s.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
}

function isAnswerTableSeparator(line) {
  const s = String(line || '');
  if (!s.includes('-')) return false;
  const cells = splitAnswerTableRow(s);
  return cells.length > 0 && cells.every((c) => /^:?-+:?$/.test(c));
}

/**
 * 从第 i 行起是否是一张 GFM 表格（表头 + 分隔行）。
 * @returns {{ head: string[], aligns: string[], rows: string[][], next: number } | null}
 */
function matchAnswerTable(lines, i) {
  const line = lines[i];
  if (!line || !line.includes('|')) return null;
  const sep = lines[i + 1];
  if (sep == null || !isAnswerTableSeparator(sep)) return null;
  const head = splitAnswerTableRow(line);
  if (!head.length) return null;
  const aligns = splitAnswerTableRow(sep).map((c) => {
    const l = c.startsWith(':');
    const r = c.endsWith(':');
    return l && r ? 'center' : r ? 'right' : l ? 'left' : '';
  });
  const rows = [];
  let k = i + 2;
  while (k < lines.length && lines[k].includes('|') && lines[k].trim()) {
    rows.push(splitAnswerTableRow(lines[k]));
    k += 1;
  }
  return { head, aligns, rows, next: k };
}

/**
 * 行内语法：先转义，再把 `` `code` `` / Markdown 图片抽成占位符（避免代码或图片说明里的
 * `*` / `|` 被当成语法）。
 * @param {string} raw
 */
function renderAnswerInline(raw) {
  const codes = [];
  const figures = [];
  let t = escapeHtml(String(raw == null ? '' : raw)).replace(/[\u0001\u0002]/g, '');
  t = t.replace(/`([^`\n]+)`/g, (_, code) => {
    codes.push(code);
    return `\u0001${codes.length - 1}\u0001`;
  });
  // Markdown 媒体 `![alt](path)`：必须**先于**链接处理，否则 `![a](https://…)` 会先被当成
  // 链接、只在前面留一个孤零零的「!」。这里只落占位（图 / 音频 / 视频），读盘与填内容归
  // renderer-answer-figures.js 的 `bindAnswerMarkdownMedia()`（与链接绑定同一套 bind 机制）；
  // 不可渲染的引用（外链 / data: / 非媒体扩展名）保留原始字面文本，与旧行为一致。
  if (typeof answerFigurePlaceholderHtml === 'function') {
    t = t.replace(/!\[([^\]\n]*)\]\(([^)\n]+)\)/g, (whole, alt, src) => {
      const fig = answerFigurePlaceholderHtml(alt.trim(), src.trim());
      // 不能渲染时也先收进占位表：否则后面的链接规则会把 `![a](https://…)` 拆成
      // 「孤零零的 ! + 一个链接」，比原样显示更乱。
      figures.push(fig || whole);
      return `\u0002${figures.length - 1}\u0002`;
    });
  }
  t = t
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/~~([^~\n]+)~~/g, '<del>$1</del>')
    .replace(/(^|[^*\w])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>')
    // t 已整体转义：url / label 直接落进属性、正文即可（引号已是 &quot;）
    .replace(
      /\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g,
      (_, label, url) =>
        `<a class="msg-md-link" role="link" tabindex="0" data-url="${url}" title="${url}">${label}</a>`
    );
  t = t.replace(/\u0001(\d+)\u0001/g, (_, idx) => `<code>${codes[Number(idx)]}</code>`);
  return t.replace(/\u0002(\d+)\u0002/g, (_, idx) => figures[Number(idx)] || '');
}

function renderAnswerFenceHtml(block) {
  const lang = String(block.lang || '');
  const attrs = lang ? ` class="msg-md-pre" data-lang="${escapeHtml(lang)}"` : ' class="msg-md-pre"';
  return `<pre${attrs}><code>${escapeHtml(block.value)}</code></pre>`;
}

function renderAnswerTableHtml(table) {
  const cellAttr = (k) => (table.aligns[k] ? ` style="text-align:${table.aligns[k]}"` : '');
  const th = table.head.map((c, k) => `<th${cellAttr(k)}>${renderAnswerInline(c)}</th>`).join('');
  const tb = table.rows
    .map(
      (row) =>
        `<tr>${table.head
          .map((_, k) => `<td${cellAttr(k)}>${renderAnswerInline(row[k] == null ? '' : row[k])}</td>`)
          .join('')}</tr>`
    )
    .join('');
  return (
    '<div class="msg-md-table-wrap"><table class="msg-md-table">' +
    `<thead><tr>${th}</tr></thead><tbody>${tb}</tbody></table></div>`
  );
}

/** 段落会不会被别的块级语法接手（用于判断段落结束） */
function isAnswerBlockStart(lines, i) {
  const line = lines[i];
  if (!line || !line.trim()) return true;
  if (ANSWER_MD_FENCE_OPEN_RE.test(line)) return true;
  if (ANSWER_MD_HEADING_RE.test(line)) return true;
  if (ANSWER_MD_HR_RE.test(line)) return true;
  if (ANSWER_MD_QUOTE_RE.test(line)) return true;
  if (ANSWER_MD_UL_RE.test(line)) return true;
  if (ANSWER_MD_OL_RE.test(line)) return true;
  return !!matchAnswerTable(lines, i);
}

/** @param {string[]} lines */
function renderAnswerTextLines(lines) {
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i += 1;
      continue;
    }

    const table = matchAnswerTable(lines, i);
    if (table) {
      out.push(renderAnswerTableHtml(table));
      i = table.next;
      continue;
    }

    const heading = ANSWER_MD_HEADING_RE.exec(line);
    if (heading) {
      const level = heading[1].length;
      const title = heading[2].replace(/[ \t]+#+[ \t]*$/, '');
      out.push(`<h${level} class="msg-md-h">${renderAnswerInline(title)}</h${level}>`);
      i += 1;
      continue;
    }

    if (ANSWER_MD_HR_RE.test(line)) {
      out.push('<hr class="msg-md-hr">');
      i += 1;
      continue;
    }

    if (ANSWER_MD_QUOTE_RE.test(line)) {
      const buf = [];
      while (i < lines.length && ANSWER_MD_QUOTE_RE.test(lines[i])) {
        buf.push(lines[i].replace(/^ {0,3}>[ \t]?/, ''));
        i += 1;
      }
      out.push(`<blockquote class="msg-md-quote">${renderAnswerInline(buf.join(' '))}</blockquote>`);
      continue;
    }

    const unordered = ANSWER_MD_UL_RE.exec(line);
    if (unordered) {
      const items = [];
      while (i < lines.length) {
        const ul = ANSWER_MD_UL_RE.exec(lines[i]);
        if (ul) {
          items.push(ul[1]);
          i += 1;
          continue;
        }
        // 悬挂缩进（续行）并入上一项
        if (items.length && /^ {2,}\S/.test(lines[i])) {
          items[items.length - 1] = `${items[items.length - 1]} ${lines[i].trim()}`;
          i += 1;
          continue;
        }
        break;
      }
      out.push(`<ul class="msg-md-list">${items.map((x) => `<li>${renderAnswerInline(x)}</li>`).join('')}</ul>`);
      continue;
    }

    const ordered = ANSWER_MD_OL_RE.exec(line);
    if (ordered) {
      const items = [];
      while (i < lines.length) {
        const ol = ANSWER_MD_OL_RE.exec(lines[i]);
        if (ol) {
          items.push(ol[1]);
          i += 1;
          continue;
        }
        if (items.length && /^ {2,}\S/.test(lines[i])) {
          items[items.length - 1] = `${items[items.length - 1]} ${lines[i].trim()}`;
          i += 1;
          continue;
        }
        break;
      }
      out.push(`<ol class="msg-md-list">${items.map((x) => `<li>${renderAnswerInline(x)}</li>`).join('')}</ol>`);
      continue;
    }

    const buf = [];
    while (i < lines.length && !isAnswerBlockStart(lines, i)) {
      buf.push(lines[i]);
      i += 1;
    }
    if (!buf.length) {
      buf.push(lines[i]);
      i += 1;
    }
    out.push(`<p class="msg-md-p">${renderAnswerInline(buf.join('\n')).replace(/\n/g, '<br>')}</p>`);
  }
  return out;
}

/**
 * Markdown → HTML。先整体转义，再生成白名单标签（strong/em/del/code/a/table/…）。
 * @param {string} src
 * @returns {string}
 */
function renderAnswerMarkdownToHtml(src) {
  const blocks = scanAnswerBlocks(src);
  const out = [];
  for (const block of blocks) {
    if (block.type === 'fence') {
      out.push(renderAnswerFenceHtml(block));
      continue;
    }
    out.push(...renderAnswerTextLines(block.value.split('\n')));
  }
  return out.join('\n');
}

/**
 * 这条正文是否含值得离开纯文本通道的 Markdown 语法。
 * 代码围栏（含 mermaid）一律算；其余按块级/行内结构信号判定，不靠关键词表。
 * @param {string} text
 * @returns {boolean}
 */
function hasAnswerMarkdown(text) {
  const src = String(text == null ? '' : text);
  if (!src.trim()) return false;
  const blocks = scanAnswerBlocks(src);
  if (blocks.some((b) => b.type === 'fence')) return true;
  const body = blocks.map((b) => b.value).join('\n');
  const lines = body.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    if (ANSWER_MD_HEADING_RE.test(lines[i])) return true;
    if (ANSWER_MD_QUOTE_RE.test(lines[i])) return true;
    if (ANSWER_MD_UL_RE.test(lines[i])) return true;
    if (ANSWER_MD_OL_RE.test(lines[i])) return true;
    if (matchAnswerTable(lines, i)) return true;
  }
  if (/\*\*[^*\n]+\*\*/.test(body)) return true;
  if (/`[^`\n]+`/.test(body)) return true;
  if (/\[[^\]\n]+\]\((?:https?:\/\/)[^)\s]+\)/.test(body)) return true;
  // 媒体引用也算结构信号：能渲染的图/音视频要走富文本通道才会变成播放器（走纯文本只会露源码）
  if (typeof isRenderableAnswerMediaPath === 'function') {
    for (const m of body.match(/!\[[^\]\n]*\]\(([^)\n]+)\)/g) || []) {
      const src = /\(([^)\n]+)\)$/.exec(m);
      if (src && isRenderableAnswerMediaPath(src[1].trim())) return true;
    }
  }
  return false;
}

function openAnswerMarkdownLink(url) {
  const target = String(url || '');
  if (!/^https?:\/\//i.test(target)) return;
  if (typeof gatewayCall !== 'function') return;
  try {
    const p = gatewayCall('host.open_url', { url: target });
    if (p && typeof p.catch === 'function') p.catch((e) => console.warn('打开链接失败', e));
  } catch (e) {
    console.warn('打开链接失败', e);
  }
}

/**
 * 给渲染出的链接绑定点击（不写 href：点击一律走 host.open_url，避免应用被导航走）。
 * @param {HTMLElement} root
 */
function bindAnswerMarkdownLinks(root) {
  if (!root || typeof root.querySelectorAll !== 'function') return;
  root.querySelectorAll('a.msg-md-link[data-url]').forEach((a) => {
    if (a.dataset.mdLinkBound === '1') return;
    a.dataset.mdLinkBound = '1';
    a.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      openAnswerMarkdownLink(a.dataset.url);
    });
    a.addEventListener('keydown', (ev) => {
      if (ev.key !== 'Enter' && ev.key !== ' ') return;
      ev.preventDefault();
      openAnswerMarkdownLink(a.dataset.url);
    });
  });
}

window.scanAnswerBlocks = scanAnswerBlocks;
window.hasAnswerMarkdown = hasAnswerMarkdown;
window.renderAnswerMarkdownToHtml = renderAnswerMarkdownToHtml;
window.bindAnswerMarkdownLinks = bindAnswerMarkdownLinks;

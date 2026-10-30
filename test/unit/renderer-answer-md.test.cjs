'use strict';
/**
 * 回答区 Markdown（`src/renderer/renderer-answer-md.js`）+ 顶层 mermaid 检测（`renderer-mermaid.js`）。
 *
 * 守的语义：
 * 1. 表格 / 粗体 / 行内代码 / 标题 / 列表 / 引用 / 链接真正渲染成受控 HTML（此前全是源码文本）；
 * 2. 代码围栏里的 `|` `**` `#` 不被误判成表格 / 强调（先切块，再解析行内）；
 * 3. 只有**顶层**围栏的 mermaid 才是图：包在 ```text 里讲解语法时不触发渲染（旧实现全文命中
 *    → 整条回答被送进 Mermaid，顶部冒出 `Lexical error` 红条）；
 * 4. 回答里的原始 HTML 一律按文本显示（先整体转义，只生成白名单标签）；
 * 5. `hasAnswerMarkdown` 不把纯文本当 Markdown —— 否则纯文本回答的空白/换行观感会变。
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const MD_SRC = path.join(__dirname, '..', '..', 'src', 'renderer', 'renderer-answer-md.js');
const MERMAID_SRC = path.join(__dirname, '..', '..', 'src', 'renderer', 'renderer-mermaid.js');

/** 与 renderer-utils.js:escapeHtml 同实现（渲染器里它是全局，单测里注入） */
function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function makeElement(tag) {
  const el = {
    tagName: String(tag || 'div').toUpperCase(),
    className: '',
    textContent: '',
    children: [],
    dataset: {},
    classList: {
      list: [],
      add(cls) {
        if (!el.classList.list.includes(cls)) el.classList.list.push(cls);
      },
      has(cls) {
        return el.classList.list.includes(cls);
      },
      remove(cls) {
        el.classList.list = el.classList.list.filter((c) => c !== cls);
      }
    },
    appendChild(child) {
      el.children.push(child);
      return child;
    },
    replaceChildren(...nodes) {
      el.children = nodes;
    },
    querySelectorAll() {
      return [];
    },
    addEventListener() {},
    remove() {
      el.removed = true;
    }
  };
  let html = '';
  Object.defineProperty(el, 'innerHTML', {
    get() {
      return html;
    },
    set(v) {
      html = String(v);
    }
  });
  return el;
}

function loadMarkdown() {
  const source = fs.readFileSync(MD_SRC, 'utf8');
  const factory = new Function(
    'window',
    'document',
    'escapeHtml',
    'gatewayCall',
    `${source}
     return { scanAnswerBlocks, hasAnswerMarkdown, renderAnswerMarkdownToHtml, renderAnswerInline, bindAnswerMarkdownLinks };`
  );
  return factory({}, { createElement: makeElement }, escapeHtml, () => Promise.resolve());
}

function loadMermaid(md, warnLog) {
  const source = fs.readFileSync(MERMAID_SRC, 'utf8');
  const factory = new Function(
    'window',
    'document',
    'console',
    'scanAnswerBlocks',
    'hasAnswerMarkdown',
    'renderAnswerMarkdownToHtml',
    'bindAnswerMarkdownLinks',
    `${source}
     return { splitAnswerMermaidSegments, renderAssistantAnswerContent, appendMermaidFallback };`
  );
  return factory(
    {},
    { createElement: makeElement },
    { warn: (...args) => warnLog.push(args), log() {} },
    md.scanAnswerBlocks,
    md.hasAnswerMarkdown,
    md.renderAnswerMarkdownToHtml,
    md.bindAnswerMarkdownLinks
  );
}

const md = loadMarkdown();
const warnLog = [];
const mermaid = loadMermaid(md, warnLog);

function segmentsMermaidCount(text) {
  return mermaid.splitAnswerMermaidSegments(text).filter((s) => s.type === 'mermaid').length;
}

test('GFM 表格渲染成 <table>，列对齐遵循 :--- / ---:', () => {
  const html = md.renderAnswerMarkdownToHtml('| 名称 | 数值 |\n| --- | ---: |\n| 测试行 | 123 |');
  assert.match(html, /<div class="msg-md-table-wrap">/);
  assert.match(html, /<table class="msg-md-table">/);
  assert.match(html, /<thead><tr><th>名称<\/th><th style="text-align:right">数值<\/th><\/tr><\/thead>/);
  assert.match(html, /<td>测试行<\/td><td style="text-align:right">123<\/td>/);
});

test('标题 / 粗体 / 行内代码 / 列表 / 引用都渲染', () => {
  const html = md.renderAnswerMarkdownToHtml(
    ['## 小标题', '', '**加粗** 与 `行内代码`', '', '- 一', '- 二', '', '1. 甲', '2. 乙', '', '> 引用一句'].join('\n')
  );
  assert.match(html, /<h2 class="msg-md-h">小标题<\/h2>/);
  assert.match(html, /<strong>加粗<\/strong>/);
  assert.match(html, /<code>行内代码<\/code>/);
  assert.match(html, /<ul class="msg-md-list"><li>一<\/li><li>二<\/li><\/ul>/);
  assert.match(html, /<ol class="msg-md-list"><li>甲<\/li><li>乙<\/li><\/ol>/);
  assert.match(html, /<blockquote class="msg-md-quote">引用一句<\/blockquote>/);
});

test('代码围栏里的 | / ** / # 不被误判', () => {
  const html = md.renderAnswerMarkdownToHtml('```md\n| a | b |\n| --- | --- |\n**不是粗体**\n# 不是标题\n```');
  assert.ok(!html.includes('<table'), '代码块里的表格字样不应生成 table');
  assert.ok(!html.includes('<strong>'), '代码块里的 ** 不应生成 strong');
  assert.ok(!html.includes('<h1'), '代码块里的 # 不应生成标题');
  assert.match(html, /<pre class="msg-md-pre" data-lang="md"><code>\| a \| b \|/);
});

test('回答里的原始 HTML 只按文本显示', () => {
  const html = md.renderAnswerMarkdownToHtml('<img src=x onerror="alert(1)">');
  assert.ok(!/<img/i.test(html), '回答里的原始 HTML 不能进 DOM');
  assert.ok(html.includes('&lt;img'));
});

test('链接只认 http(s)，不写 href（点击走 host.open_url）', () => {
  const html = md.renderAnswerMarkdownToHtml('[文档](https://example.com/a?b=1&c=2)');
  assert.match(html, /<a class="msg-md-link" role="link" tabindex="0"/);
  assert.match(html, /data-url="https:\/\/example\.com\/a\?b=1&amp;c=2"/);
  assert.match(html, />文档<\/a>/);
  assert.ok(!/\shref=/.test(html), '渲染出的链接不能带 href');

  const js = md.renderAnswerMarkdownToHtml('[x](javascript:alert(1))');
  assert.ok(!js.includes('<a '), 'javascript: 不能被渲染成链接');
});

test('hasAnswerMarkdown：纯文本不触发，Markdown 才触发', () => {
  assert.equal(md.hasAnswerMarkdown('就是一段普通回答，没有语法。'), false);
  assert.equal(md.hasAnswerMarkdown('数字 1 | 2 只是竖线，不是表格'), false);
  assert.equal(md.hasAnswerMarkdown(''), false);
  assert.equal(md.hasAnswerMarkdown('| a | b |\n| --- | --- |\n| 1 | 2 |'), true);
  assert.equal(md.hasAnswerMarkdown('```js\nconst a = 1;\n```'), true);
  assert.equal(md.hasAnswerMarkdown('**粗**'), true);
  assert.equal(md.hasAnswerMarkdown('- 列表项'), true);
  assert.equal(md.hasAnswerMarkdown('## 标题'), true);
});

test('只有顶层围栏的 mermaid 才算图（引用字样不触发）', () => {
  const quoted = ['```text', '```mermaid', 'graph TD', '  A-->B', '```', '', '这段说明是正文。'].join('\n');
  assert.equal(segmentsMermaidCount(quoted), 0, '包在 ```text 里引用的 mermaid 围栏字样不应触发渲染');
  const text = mermaid
    .splitAnswerMermaidSegments(quoted)
    .map((s) => s.value)
    .join('\n');
  assert.ok(text.includes('```mermaid'), '引用文字要原样保留');
  assert.ok(text.includes('这段说明是正文。'));
});

test('混合内容：1 个合法图 + 1 段引用文字只渲染合法图', () => {
  const mixed = [
    '说明如下：',
    '```mermaid',
    'flowchart TB',
    '  A-->B',
    '```',
    '',
    '围栏里引用写法：',
    '```text',
    '```mermaid',
    '```',
    '结尾一行。'
  ].join('\n');
  const segs = mermaid.splitAnswerMermaidSegments(mixed);
  const diagrams = segs.filter((s) => s.type === 'mermaid');
  assert.equal(diagrams.length, 1);
  assert.equal(diagrams[0].value, 'flowchart TB\n  A-->B');
  const text = segs
    .filter((s) => s.type === 'text')
    .map((s) => s.value)
    .join('\n');
  assert.ok(text.includes('围栏里引用写法：'));
  assert.ok(text.includes('结尾一行。'));
});

test('正文入口：纯文本返回 false 不动 DOM，Markdown 才接管', () => {
  const plain = makeElement('div');
  assert.equal(mermaid.renderAssistantAnswerContent(plain, '就是一段普通回答。'), false);
  assert.equal(plain.children.length, 0, '不接管时不能动 DOM');

  const source = '| a | b |\n| --- | --- |\n| 1 | 2 |';
  const rich = makeElement('div');
  assert.equal(mermaid.renderAssistantAnswerContent(rich, source), true);
  assert.ok(rich.classList.has('msg-answer-rich'));
  assert.equal(rich.dataset.rawContent, source);
  assert.equal(rich.children.length, 1);
  assert.equal(rich.children[0].className, 'msg-answer-md');
  assert.match(rich.children[0].innerHTML, /<table class="msg-md-table">/);
});

test('Mermaid 失败：友好提示 + 原文，完整错误进控制台', () => {
  const container = makeElement('div');
  const code = 'graph TD\n  A-->';
  mermaid.appendMermaidFallback(container, code, new Error('Lexical error on line 2. Unrecognized text.'));
  const wrap = container.children[0];
  assert.equal(wrap.className, 'msg-mermaid msg-mermaid-error');
  assert.equal(wrap.children[0].textContent, '流程图语法有误，已按原文显示');
  assert.match(wrap.children[1].textContent, /Lexical error/);
  assert.equal(wrap.children[2].textContent, code, '原文必须保留');
  assert.equal(warnLog.length, 1, '完整错误要进控制台');
  assert.ok(warnLog[0].some((a) => a instanceof Error));
});

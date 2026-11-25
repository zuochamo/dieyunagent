'use strict';

/**
 * 思考区 HTML 预览的「先读后插」（2026-11-25 用户实测：编辑 .html 文件时屏幕白闪一下）。
 *
 * 现场：`appendInlineHtmlPreview` 先把 `<iframe>` 插进 DOM，再异步读文件、回填 `srcdoc`。
 * iframe 一旦进 DOM 而 `srcdoc` 还没设，浏览器按 `about:blank` 画一帧；而 iframe 背景是
 * `#fff`（styles.css）—— 深色主题下就是一块白闪。加上工具行在流式期间会被反复重建
 * （`ul.replaceChildren()`），同一个 html 会被读很多次、闪很多次。
 *
 * 现在锁四条：
 * 1. 读回来之前**不往 DOM 里插任何东西**（连占位都不插）；
 * 2. 插入那一刻 `srcdoc` 已经设好（首帧就是真内容）；
 * 3. 读取失败 / 被截断 / 非 html → 什么都不插；
 * 4. 行已经被重建（死节点）→ 也不再插。
 *
 * 浏览器脚本没有 module.exports，用 `new Function` 摘函数 + 最小 DOM 替身来验。
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SOURCE = fs.readFileSync(
  path.join(__dirname, '..', '..', 'src', 'renderer', 'renderer-thinking-trace-dom.js'),
  'utf8'
);

function extractFn(src, name) {
  const start = src.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `没找到 function ${name}`);
  const end = src.indexOf('\n}', start);
  assert.ok(end > start, `function ${name} 没闭合`);
  return src.slice(start, end + 2);
}

function makeElement(tag) {
  const el = {
    tagName: tag,
    className: '',
    textContent: '',
    type: '',
    srcdoc: '',
    attributes: {},
    children: [],
    listeners: {},
    isConnected: true,
    appendChild(child) {
      this.children.push(child);
      child.parent = this;
      return child;
    },
    setAttribute(name, value) {
      this.attributes[name] = value;
    },
    addEventListener(ev, fn) {
      (this.listeners[ev] = this.listeners[ev] || []).push(fn);
    },
    // 预览插入前会查重：默认「没有」
    querySelector() {
      return null;
    },
    get isConnectedFlag() {
      return this.isConnected;
    }
  };
  return el;
}

const documentStub = { createElement: (tag) => makeElement(tag) };

const build = new Function(
  'document',
  'gatewayCall',
  'HTML_PREVIEW_MAX_BYTES',
  'openArtifactTab',
  `${extractFn(SOURCE, 'appendInlineHtmlPreview')}
   return appendInlineHtmlPreview;`
);

function findIframe(node) {
  if (!node) return null;
  if (node.tagName === 'iframe') return node;
  for (const c of node.children || []) {
    const hit = findIframe(c);
    if (hit) return hit;
  }
  return null;
}

function setup(readImpl) {
  const calls = [];
  const li = makeElement('li');
  const fn = build(
    documentStub,
    (method, params) => {
      calls.push({ method, params });
      return readImpl ? readImpl(method, params) : Promise.resolve({ content: '<html>hi</html>' });
    },
    1024 * 1024,
    () => {}
  );
  return { li, fn, calls };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

test('读回来之前不往 DOM 里插任何东西（连占位都不插）', async () => {
  let release = null;
  const pending = new Promise((resolve) => {
    release = () => resolve({ content: '<html>x</html>' });
  });
  const { li, fn } = setup(() => pending);
  fn(li, { toolArgs: { filePath: 'web/static/index.html' } });
  assert.equal(li.children.length, 0, '同步阶段不该出现 iframe（那正是白闪的来源）');
  release();
  await flush();
  assert.equal(li.children.length, 1, '拿到内容后才插一块');
});

test('插入那一刻 srcdoc 已经设好（首帧就是真内容）', async () => {
  const { li, fn } = setup();
  const originalAppend = li.appendChild;
  let srcdocAtInsert = null;
  li.appendChild = function (child) {
    const frame = findIframe(child);
    srcdocAtInsert = frame ? frame.srcdoc : '<no iframe>';
    return originalAppend.call(this, child);
  };
  fn(li, { toolArgs: { filePath: 'web/static/index.html' } });
  await flush();
  assert.equal(srcdocAtInsert, '<html>hi</html>', '先设 srcdoc 再入 DOM，才不会有白帧');
  const wrap = li.children[0];
  const frame = findIframe(wrap);
  assert.ok(frame, '应该插进一块带 iframe 的预览');
  assert.equal(frame.attributes.sandbox, 'allow-scripts');
  assert.ok(
    wrap.children.some((c) => c.className === 'msg-tool-html-preview-bar'),
    '仍然带「HTML 预览 / 在面板打开」那条 bar'
  );
});

test('读取失败 / 被截断 → 什么都不插', async () => {
  const { li: li1, fn: fn1 } = setup(() => Promise.reject(new Error('boom')));
  fn1(li1, { toolArgs: { filePath: 'a.html' } });
  await flush();
  assert.equal(li1.children.length, 0);

  const { li: li2, fn: fn2 } = setup(() => Promise.resolve({ content: 'x', truncated: true }));
  fn2(li2, { toolArgs: { filePath: 'a.html' } });
  await flush();
  assert.equal(li2.children.length, 0);

  const { li: li3, fn: fn3 } = setup(() => Promise.resolve({}));
  fn3(li3, { toolArgs: { filePath: 'a.html' } });
  await flush();
  assert.equal(li3.children.length, 0);
});

test('行已被重建（死节点）→ 不再插', async () => {
  const { li, fn } = setup();
  li.isConnected = false;
  fn(li, { toolArgs: { filePath: 'a.html' } });
  await flush();
  assert.equal(li.children.length, 0);
});

test('不是 html 文件 → 连读都不读', async () => {
  const { li, fn, calls } = setup();
  fn(li, { toolArgs: { filePath: 'src/a.js' } });
  await flush();
  assert.equal(calls.length, 0, '非 .html 不该触发 fs.read_file');
  assert.equal(li.children.length, 0);
});

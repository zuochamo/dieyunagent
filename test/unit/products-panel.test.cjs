'use strict';
/**
 * 产物区（工作区面板「产物」页）分组逻辑。
 *
 * `src/renderer/renderer-artifacts-panel.js` 是纯浏览器脚本（<script> 直接加载，
 * 没有 module.exports），所以这里用 `new Function` 造一个极简 window/document
 * 环境，把真实的渲染函数取出来断言。
 *
 * 守住的四个行为：
 * 1. 扩展名 → 类型分组（文档/表格/图片/代码/其他）与徽章文案；
 * 2. 固定按类型分组：组顺序固定、组内时间倒序；
 * 3. 相对时间文案（行内右侧）；
 * 4. 点击行只走 openArtifactFileAtLine（预览器单实例，不在这里再开一套）。
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = path.join(__dirname, '..', '..', 'src', 'renderer', 'renderer-artifacts-panel.js');

function makeEl(tagName) {
  const el = {
    tagName,
    className: '',
    title: '',
    textContent: '',
    innerHTML: '',
    scrollTop: 0,
    hidden: false,
    childElementCount: 0,
    children: [],
    dataset: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    appendChild(child) {
      el.children.push(child);
      el.childElementCount = el.children.length;
      return child;
    },
    replaceChildren() {
      el.children = [];
      el.childElementCount = 0;
    },
    addEventListener(type, fn) {
      el.listeners[type] = fn;
    },
    listeners: {},
    setAttribute() {},
    querySelector: () => null,
    querySelectorAll: () => []
  };
  return el;
}

function loadPanel(options = {}) {
  const els = new Map();
  const windowSpy = {
    localStorage: {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {}
    },
    activeViewSessionWorkspacePath: options.workspacePath || '',
    openArtifactFileAtLine: options.openSpy || null
  };
  const doc = {
    getElementById(id) {
      if (!els.has(id)) els.set(id, makeEl('div'));
      return els.get(id);
    },
    createElement: makeEl,
    querySelector: () => null,
    querySelectorAll: () => []
  };
  const source = fs.readFileSync(SRC, 'utf8');
  const factory = new Function(
    'window',
    'document',
    'sessionArtifacts',
    'isSshWorkspacePath',
    'artifactsWorkspaceRoot',
    `var escapeHtml = function (s) { return String(s == null ? '' : s); };
     var flatFileIconSvg = function () { return '<svg></svg>'; };
     var formatArtifactDiffHtml = function (d) {
       if (!d || (d.added == null && d.removed == null)) return '';
       return ' <span class="artifacts-file-diff">+' + (Number(d.added) || 0) + ' -' + (Number(d.removed) || 0) + '</span>';
     };
     ${source}
     return {
       extOf: productExtOf,
       groupOf: productGroupOf,
       ageOf: formatProductAge,
       displayPath: productDisplayPath,
       isSsh: productWorkspaceIsSsh,
       items: productsPanelItems,
       summary: paintProductsSummary,
       render: renderProductsPanel,
       open: openProductItem,
       groupLabel: productGroupLabel
     };`
  );
  const api = factory(
    windowSpy,
    doc,
    options.sessionArtifacts || [],
    (p) => /^ssh:/i.test(String(p || '')),
    options.workspaceRoot || ''
  );
  return { api, doc, els, windowSpy };
}

describe('产物区：类型分组', () => {
  test('扩展名与分组映射', () => {
    const { api } = loadPanel();
    assert.equal(api.extOf('a/b/报告.MD'), 'md');
    assert.equal(api.extOf('C:\\ws\\no-ext'), '');
    assert.equal(api.groupOf('md'), 'doc');
    assert.equal(api.groupOf('pdf'), 'doc');
    assert.equal(api.groupOf('xlsx'), 'data');
    assert.equal(api.groupOf('csv'), 'data');
    assert.equal(api.groupOf('png'), 'image');
    assert.equal(api.groupOf('py'), 'code');
    assert.equal(api.groupOf('unknownext'), 'other');
  });

  test('未知扩展名退到「其他」，不丢项', () => {
    const { api } = loadPanel({
      sessionArtifacts: [{ path: '/ws/a.weird', ts: Date.now() }]
    });
    const items = api.items();
    assert.equal(items.length, 1);
    assert.equal(items[0].group, 'other');
    assert.equal(items[0].label, 'WEIR');
  });

  test('分组标题文案', () => {
    const { api } = loadPanel();
    assert.equal(api.groupLabel('doc'), '文档');
    assert.equal(api.groupLabel('data'), '表格');
    assert.equal(api.groupLabel('image'), '图片');
    assert.equal(api.groupLabel('code'), '代码');
    assert.equal(api.groupLabel('other'), '其他');
  });
});

describe('产物区：时间文案', () => {
  const NOW = new Date('2026-10-17T14:00:00+08:00').getTime();

  test('相对时间', () => {
    const { api } = loadPanel();
    assert.equal(api.ageOf(NOW - 10 * 1000, NOW), '刚刚');
    assert.equal(api.ageOf(NOW - 5 * 60 * 1000, NOW), '5 分钟前');
    assert.equal(api.ageOf(NOW - 3 * 60 * 60 * 1000, NOW), '3 小时前');
    assert.equal(api.ageOf(NOW - 50 * 60 * 60 * 1000, NOW), '2 天前');
  });
});

describe('产物区：列表与渲染', () => {
  test('按 ts 倒序，最新在最前', () => {
    const now = Date.now();
    const { api } = loadPanel({
      sessionArtifacts: [
        { path: '/ws/old.md', ts: now - 90000 },
        { path: '/ws/new.md', ts: now - 1000, diff: { added: 5, removed: 1 } },
        { path: '/ws/mid.md', ts: now - 30000 }
      ]
    });
    assert.deepEqual(
      api.items().map((r) => r.name),
      ['new.md', 'mid.md', 'old.md']
    );
  });

  test('摘要只显示总数，类型分布挂 title', () => {
    const now = Date.now();
    const { api, els } = loadPanel({
      sessionArtifacts: [
        { path: '/ws/a.md', ts: now - 1000 },
        { path: '/ws/b.png', ts: now - 2000 },
        { path: '/ws/c.png', ts: now - 3000 }
      ]
    });
    api.summary(api.items());
    const el = els.get('products-panel-summary');
    assert.equal(el.textContent, '3 项');
    assert.match(el.title, /图 2/);
    assert.match(el.title, /文档 1/);
    assert.doesNotMatch(el.title, /代码/);
  });

  test('空列表渲染空态文案', () => {
    const { api, els } = loadPanel({ sessionArtifacts: [] });
    api.render({ force: true });
    const html = els.get('products-list').innerHTML;
    assert.match(html, /本会话还没有产物/);
    assert.match(html, /Agent 生成或修改的文件会自动出现在这里/);
  });

  test('固定按类型分组：组顺序固定、组内时间倒序', () => {
    const now = Date.now();
    const { api, els } = loadPanel({
      sessionArtifacts: [
        { path: '/ws/report.py', ts: now - 1000 },
        { path: '/ws/old.md', ts: now - 90000 },
        { path: '/ws/new.md', ts: now - 5000 },
        { path: '/ws/shot.png', ts: now - 3000 },
        { path: '/ws/data.xlsx', ts: now - 4000 }
      ]
    });
    api.render({ force: true });
    const list = els.get('products-list');
    const heads = list.children.filter((c) => c.className === 'products-group-head');
    assert.deepEqual(
      heads.map((h) => h.textContent),
      ['文档', '表格', '图片', '代码'],
      '组顺序固定，不随时间或插入顺序变化'
    );
    const names = list.children
      .filter((c) => c.className.indexOf('products-item') >= 0)
      .map((c) => (c.innerHTML.match(/artifacts-file-name">([^<]+)/) || [])[1]);
    assert.deepEqual(names, ['new.md', 'old.md', 'data.xlsx', 'shot.png', 'report.py']);
  });

  test('点击行只委派给 openArtifactFileAtLine', () => {
    const now = Date.now();
    const calls = [];
    const { api } = loadPanel({
      sessionArtifacts: [{ path: '/ws/a.md', ts: now }],
      openSpy: (fp) => calls.push(fp)
    });
    api.open('/ws/a.md');
    assert.deepEqual(calls, ['/ws/a.md']);
  });
});

describe('产物区：路径显示与本地/SSH 差异', () => {
  function firstRow(els) {
    return els
      .get('products-list')
      .children.find((c) => c.className.indexOf('products-item') >= 0);
  }

  test('本地工作区：显示相对路径，标记为可点', () => {
    const now = Date.now();
    const { api, els } = loadPanel({
      sessionArtifacts: [{ path: 'E:\\ws\\out\\月度对账报告.md', ts: now }],
      workspacePath: 'E:\\ws'
    });
    api.render({ force: true });
    const row = firstRow(els);
    assert.match(row.innerHTML, />out\/月度对账报告\.md</);
    assert.match(row.innerHTML, /products-item-path is-clickable/);
  });

  test('Windows 盘符大小写不同也能裁成相对路径', () => {
    const { api } = loadPanel({ workspacePath: 'e:\\WS' });
    assert.equal(api.displayPath('E:/ws/sub/a.md'), 'sub/a.md');
  });

  test('工作区外的文件保留原路径', () => {
    const { api } = loadPanel({ workspacePath: 'E:\\ws' });
    assert.equal(api.displayPath('D:\\other\\a.md'), 'D:\\other\\a.md');
  });

  test('SSH 工作区：路径原样显示且不可点', () => {
    const now = Date.now();
    const { api, els } = loadPanel({
      sessionArtifacts: [{ path: '/home/dieyunx/out/a.md', ts: now }],
      workspacePath: 'ssh://root@192.168.31.62/home/dieyunx'
    });
    assert.equal(api.isSsh(), true);
    api.render({ force: true });
    const row = firstRow(els);
    assert.match(row.innerHTML, /\/home\/dieyunx\/out\/a\.md/);
    assert.doesNotMatch(row.innerHTML, /is-clickable/);
  });

  test('未确定工作区时按本地处理，不误判成 SSH', () => {
    const { api } = loadPanel();
    assert.equal(api.isSsh(), false);
  });
});

'use strict';
/**
 * agent_clarify 选项预览对比（`src/renderer/renderer-agent-clarify.js`）。
 *
 * 守的语义：
 * 1. 任一选项带非空 preview → 卡片进入并排布局（.agent-clarify-split + .agent-clarify-preview）；
 * 2. 全部无 preview → 走原表格布局，不出现 split / preview 节点（存量行为零变化）；
 * 3. 预览面板初始显示第一个带 preview 的选项，change / mouseenter 切换预览内容；
 * 4. hasClarifyPreviews 只认非空字符串。
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = path.join(__dirname, '..', '..', 'src', 'renderer', 'renderer-agent-clarify.js');

/** 最小 DOM stub：只实现 buildClarifyCard 用到的面 */
function makeElement(tag) {
  const el = {
    tagName: tag,
    className: '',
    children: [],
    listeners: {},
    dataset: {},
    appendChild(child) {
      el.children.push(child);
      return child;
    },
    addEventListener(type, fn) {
      (el.listeners[type] = el.listeners[type] || []).push(fn);
    },
    remove() {
      el.removed = true;
    },
    querySelector(sel) {
      const cls = sel.replace(/^\./, '');
      return el.children.find((c) => c.className === cls) || null;
    }
  };
  return el;
}

function load() {
  const source = fs.readFileSync(SRC, 'utf8');
  const factory = new Function(
    'document',
    `${source}
     return { hasClarifyPreviews, buildClarifyCard };`
  );
  const document = { createElement: makeElement };
  return factory(document);
}

const OPTS = [
  { id: 'left', label: '左侧栏', description: '侧栏在左', preview: '┌──┬────┐\n│S │ C  │\n└──┴────┘' },
  { id: 'top', label: '顶栏', description: '侧栏在上', preview: '┌──────┐\n│  S   │\n├──────┤\n│  C   │\n└──────┘' }
];

test('hasClarifyPreviews 只认非空字符串', () => {
  const api = load();
  assert.equal(api.hasClarifyPreviews(null), false);
  assert.equal(api.hasClarifyPreviews([]), false);
  assert.equal(
    api.hasClarifyPreviews([{ id: 'a', label: 'A' }, { id: 'b', label: 'B', preview: '   ' }]),
    false
  );
  assert.equal(api.hasClarifyPreviews([{ id: 'b', label: 'B', preview: '<div>x</div>' }]), true);
});

test('带 preview → split 并排布局，初始预览为第一个带 preview 的选项', () => {
  const api = load();
  const card = api.buildClarifyCard({ question: '布局选哪种？', options: OPTS }, () => {});
  const split = card.children.find((c) => c.className === 'agent-clarify-split');
  assert.ok(split, '带 preview 时应有 .agent-clarify-split');
  const preview = split.children.find((c) => c.className === 'agent-clarify-preview');
  assert.ok(preview, 'split 内应有预览面板');
  const pre = preview.children.find((c) => c.tagName === 'pre');
  const title = preview.children.find((c) => c.className === 'agent-clarify-preview-title');
  assert.equal(pre.textContent, OPTS[0].preview, '初始预览 = 第一个带 preview 的选项');
  assert.equal(title.textContent, '左侧栏');
});

test('选项 change / 行 hover 切换预览内容', () => {
  const api = load();
  const card = api.buildClarifyCard({ question: '布局选哪种？', options: OPTS }, () => {});
  const split = card.children.find((c) => c.className === 'agent-clarify-split');
  const preview = split.children.find((c) => c.className === 'agent-clarify-preview');
  const pre = preview.children.find((c) => c.tagName === 'pre');
  const table = split.children.find((c) => c.className === 'agent-clarify-table');
  const tbody = table.children.find((c) => c.tagName === 'tbody');

  const row1 = tbody.children[1];
  const input1 = row1.children[0].children[0];
  assert.equal(input1.tagName, 'input');
  const changeFns = input1.listeners['change'] || [];
  assert.equal(changeFns.length, 1, 'input 上应有 change 监听');
  changeFns[0]();
  assert.equal(pre.textContent, OPTS[1].preview, 'change 后预览切换为该选项');

  (tbody.children[0].listeners['mouseenter'] || [])[0]();
  assert.equal(pre.textContent, OPTS[0].preview, 'hover 第一行回到第一预览');
});

test('无 preview → 原表格布局，零新增节点', () => {
  const api = load();
  const plainCard = api.buildClarifyCard(
    { question: '继续吗？', options: [{ id: 'y', label: '是' }, { id: 'n', label: '否' }] },
    () => {}
  );
  assert.equal(plainCard.children.some((c) => c.className === 'agent-clarify-split'), false);
  assert.ok(plainCard.children.some((c) => c.className === 'agent-clarify-table'));
  assert.equal(plainCard.children.some((c) => c.className === 'agent-clarify-preview'), false);
});

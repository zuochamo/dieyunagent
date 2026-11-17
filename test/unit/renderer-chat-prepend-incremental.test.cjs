'use strict';

/**
 * 「往上翻一页」的 DOM 手术与位置按住：
 *   - `prependOlderMessagesIncrementally`：只画新增那几条，插在原来第一条消息前面；
 *   - `holdChatScrollAfterPrepend`：**只纠偏**——锚点相对滚动区漂了多少就补多少。
 *
 * 这两段是唯一动聊天列表 DOM 顺序 / 阅读位置的新代码，所以拿一个极简的桩钉住：
 *   1. 新行按顺序插在**原来第一条消息前面**（顶部那行提示仍留在最前）；
 *   2. 已有节点一个都不重建；
 *   3. 插入本身不动 scrollTop（位置由 hold 一处负责）；
 *   4. 纠偏是**相对量**：量出来是 0 就一个字节都不写（不会像"设绝对目标"那样把视野钉住）；
 *   5. 只认锚点漂移 —— 底部流式长高不算；用户自己滚滚轮则先认下他的位置，再补后来的漂移。
 *
 * 浏览器脚本没有 module.exports，用 `new Function` 摘函数来验（手法同
 * `renderer-chat-load-mode.test.cjs`）。
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SOURCE = fs.readFileSync(
  path.join(__dirname, '..', '..', 'src', 'renderer', 'renderer-chat-render.js'),
  'utf8'
);
const NAV_SOURCE = fs.readFileSync(
  path.join(__dirname, '..', '..', 'src', 'renderer', 'renderer-chat-nav.js'),
  'utf8'
);

/** 从浏览器脚本里摘一个顶层函数（整文件 eval 要的桩太多）。 */
function extractFn(src, name) {
  const start = src.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `没找到 function ${name}`);
  const end = src.indexOf('\n}', start);
  assert.ok(end > start, `function ${name} 没闭合`);
  return src.slice(start, end + 2);
}

const buildPrepend = new Function(
  'chatList',
  'appendRenderedMessageAtIndex',
  'beginChatHistoryArtifactsBatch',
  'endChatHistoryArtifactsBatch',
  'layoutChatNav',
  `${extractFn(SOURCE, 'prependOlderMessagesIncrementally')}
   return prependOlderMessagesIncrementally;`
);

const chatNavLadder = new Function(
  'CHAT_NAV_TICK_PITCH',
  'CHAT_NAV_TICK_HEIGHT',
  `${extractFn(NAV_SOURCE, 'chatNavLadder')}
   return chatNavLadder;`
)(10, 2);

const buildTurnAnchorCollector = new Function(
  'chatList',
  `${extractFn(NAV_SOURCE, 'collectChatTurnAnchors')}
   return collectChatTurnAnchors;`
);
/** 浏览器脚本读的是全局 `chatList`；单测里把桩当参数喂进去。 */
function collectChatTurnAnchors(list) {
  return buildTurnAnchorCollector(list)();
}

/** 极简 DOM 桩：只实现渲染代码用到的 classList / querySelector。 */
function fakeNode(classes, opts = {}) {
  return {
    classList: { contains: (c) => classes.includes(c) },
    querySelector: (sel) => {
      if (sel === '.msg.user') return opts.user || null;
      if (sel === '.msg-trigger') return opts.trigger || null;
      return null;
    }
  };
}

const buildHold = new Function(
  'chatList',
  'requestAnimationFrame',
  `${extractFn(SOURCE, 'holdChatScrollAfterPrepend')}
   return holdChatScrollAfterPrepend;`
);

/**
 * 脚本里的全局（`chatUserScrollSeq` / `currentSessionId` / `captureSessionScrollPosition`）
 * 用 `globalThis` 提供：`new Function` 的函数体是全局作用域，正好能读到。
 */
function withGlobals({ seq = 0, sessionId = 's1' } = {}) {
  globalThis.chatUserScrollSeq = seq;
  globalThis.currentSessionId = sessionId;
  globalThis.captureSessionScrollPosition = () => {};
}

function clearGlobals() {
  delete globalThis.chatUserScrollSeq;
  delete globalThis.currentSessionId;
  delete globalThis.captureSessionScrollPosition;
}

afterEach(() => {
  clearGlobals();
});

/** 极简顺序列表：够用就好（只测顺序与相对位置，不测样式）。 */
function makeList(initial) {
  const kids = initial.slice();
  const wire = (node) => {
    Object.defineProperty(node, 'nextSibling', {
      configurable: true,
      get() {
        const i = kids.indexOf(node);
        return i >= 0 ? kids[i + 1] || null : null;
      }
    });
    node.isConnected = true;
    return node;
  };
  const list = {
    kids,
    scrollTop: 1000,
    scrollHeight: 5000,
    getBoundingClientRect: () => ({ top: 0 }),
    get firstChild() {
      return kids[0] || null;
    },
    get lastElementChild() {
      return kids[kids.length - 1] || null;
    },
    querySelector() {
      return kids.find((n) => n.isMessage) || null;
    },
    insertBefore(node, anchor) {
      const i = kids.indexOf(node);
      if (i >= 0) kids.splice(i, 1);
      const at = kids.indexOf(anchor);
      kids.splice(at < 0 ? kids.length : at, 0, node);
    }
  };
  kids.forEach(wire);
  list.wire = wire;
  return list;
}

function runPrepend({ existingCount = 3, olderCount = 2, edgeRow = true, anchorTop = 640 } = {}) {
  const kids = [];
  if (edgeRow) kids.push({ kind: 'edge', classList: { contains: () => false } });
  for (let i = 0; i < existingCount; i += 1) {
    const node = { kind: 'existing', isMessage: true, id: `old-${String(i)}` };
    node.getBoundingClientRect = () => ({ top: i === 0 ? anchorTop : anchorTop + i * 80 });
    kids.push(node);
  }
  const list = makeList(kids);
  const created = [];
  const layoutCalls = [];
  const append = (index) => {
    const node = list.wire({ kind: 'new', isNew: true, id: `new-${String(index)}` });
    node.getBoundingClientRect = () => ({ top: 0 });
    created.push(node);
    list.kids.push(node);
  };
  const fn = buildPrepend(list, append, () => {}, () => {}, () => layoutCalls.push(1));
  const result = fn('s1', olderCount);
  return { result, list, created, layoutCalls };
}

/** 一个会随「滚到哪 / 上面长多高」变化的滚动区。 */
function makePort({ layoutTop = 500, scrollTop = 0 } = {}) {
  const state = { layoutTop, scrollTop };
  const list = {
    get scrollTop() {
      return state.scrollTop;
    },
    set scrollTop(v) {
      state.scrollTop = v;
    },
    getBoundingClientRect: () => ({ top: 0 }),
    scrollHeight: 5000
  };
  const anchor = {
    isConnected: true,
    getBoundingClientRect: () => ({ top: state.layoutTop - state.scrollTop })
  };
  return { state, list, anchor };
}

function holdPin(list, frames) {
  return buildHold(list, (cb) => frames.push(cb));
}

test('新行按顺序插在原来第一条消息前面，顶部提示行仍在最前', () => {
  const { result, list, created } = runPrepend({ existingCount: 3, olderCount: 2 });
  assert.ok(result, '应该走增量插入');
  assert.deepEqual(list.kids.map((n) => n.kind), ['edge', 'new', 'new', 'existing', 'existing', 'existing']);
  assert.deepEqual(
    list.kids.filter((n) => n.kind === 'new').map((n) => n.id),
    created.map((n) => n.id)
  );
});

test('交出锚点、它在滚动区里的原始位置、以及刚插入的节点', () => {
  const { result, list, created } = runPrepend({ existingCount: 3, olderCount: 2, anchorTop: 640 });
  assert.equal(result.anchor.id, 'old-0');
  assert.equal(result.anchor, list.kids.find((n) => n.isMessage));
  assert.equal(result.portTopBefore, 640);
  assert.deepEqual(result.inserted, created);
});

test('已有节点一个都不重建（还是原来那些对象）', () => {
  const { list } = runPrepend({ existingCount: 3, olderCount: 2 });
  assert.deepEqual(
    list.kids.filter((n) => n.kind === 'existing').map((n) => n.id),
    ['old-0', 'old-1', 'old-2']
  );
});

test('插入本身不动滚动位置（位置由 holdChatScrollAfterPrepend 一处负责）', () => {
  const { list } = runPrepend({ existingCount: 3, olderCount: 2 });
  assert.equal(list.scrollTop, 1000);
});

test('一行都没新增时不动 DOM、不动位置', () => {
  const { result, list } = runPrepend({ existingCount: 2, olderCount: 0 });
  assert.equal(result, null);
  assert.deepEqual(list.kids.map((n) => n.kind), ['edge', 'existing', 'existing']);
  assert.equal(list.scrollTop, 1000);
});

test('没有可比对的锚点（列表里没有消息）时交给整屏重渲染', () => {
  const { result } = runPrepend({ existingCount: 0, olderCount: 2, edgeRow: true });
  assert.equal(result, null);
});

test('插入后立刻重量一次刻度带位置（刻度本身不重建，所以整列不会跳）', () => {
  const { layoutCalls } = runPrepend({ existingCount: 3, olderCount: 2 });
  assert.equal(layoutCalls.length, 1);
});

test('一格 = 一轮：你一句 + 它一段只算一根刻度，落点是你的那句话', () => {
  const userBubble = { id: 'u1' };
  const list = {
    children: [fakeNode(['msg-turn'], { user: userBubble }), fakeNode(['msg', 'assistant'])]
  };
  const out = collectChatTurnAnchors(list);
  assert.equal(out.length, 1);
  assert.equal(out[0].el, userBubble);
  assert.equal(out[0].role, 'user');
});

test('定时 / 目标续跑那种轮次用触发条当落点', () => {
  const bar = { id: 't1' };
  const list = { children: [fakeNode(['msg-turn', 'msg-turn-trigger'], { trigger: bar })] };
  assert.deepEqual(collectChatTurnAnchors(list), [{ el: bar, role: 'system' }]);
});

test('窗口第一屏就从助手气泡开始时，给它一根（否则最上面那几条点不到）', () => {
  const head = fakeNode(['msg', 'assistant']);
  const userBubble = { id: 'u1' };
  const list = { children: [head, fakeNode(['msg-turn'], { user: userBubble })] };
  const out = collectChatTurnAnchors(list);
  assert.equal(out.length, 2);
  assert.equal(out[0].el, head);
  assert.equal(out[0].role, 'assistant');
  assert.equal(out[1].el, userBubble);
});

test('后面的裸助手气泡不再另算一轮（它们属于上一轮）', () => {
  const userBubble = { id: 'u1' };
  const list = {
    children: [
      fakeNode(['msg-turn'], { user: userBubble }),
      fakeNode(['msg', 'assistant']),
      fakeNode(['msg', 'assistant'])
    ]
  };
  assert.equal(collectChatTurnAnchors(list).length, 1);
});

test('刻度带几何：装得下就整列居中，装不下就贴底', () => {
  const short = chatNavLadder(3, 500);
  assert.deepEqual(short, { pitch: 10, columnHeight: 22, padTop: 239, trackHeight: 500 });
  const tall = chatNavLadder(100, 500);
  assert.deepEqual(tall, { pitch: 10, columnHeight: 992, padTop: 0, trackHeight: 992 });
});

test('装得下时加载更早会整列挪半个间距×新增条数（选定的代价，但没有重排）', () => {
  const before = chatNavLadder(10, 300);
  const after = chatNavLadder(10 + 7, 300);
  for (let i = 0; i < 10; i += 1) {
    const oldTop = before.padTop + i * before.pitch;
    const newTop = after.padTop + (i + 7) * after.pitch;
    assert.equal(newTop - oldTop, (7 * 10) / 2, `第 ${String(i)} 根应整体下移半个间距×7`);
  }
});

test('一旦填满改成贴底：再加刻度，已画的那根一根都不动', () => {
  const before = chatNavLadder(40, 300);
  const after = chatNavLadder(40 + 30, 300);
  assert.equal(before.padTop, 0);
  assert.equal(after.padTop, 0);
  for (let i = 0; i < 40; i += 1) {
    const oldDist = before.trackHeight - (before.padTop + i * before.pitch);
    const newDist = after.trackHeight - (after.padTop + (i + 30) * after.pitch);
    assert.equal(newDist, oldDist, `第 ${String(i)} 根应停在同一个高度`);
  }
});

test('锚点没漂 → 一个字节都不写', () => {
  withGlobals();
  const { state, list, anchor } = makePort({ layoutTop: 500, scrollTop: 0 });
  const frames = [];
  const pin = holdPin(list, frames);
  pin({ anchor, portTopBefore: 500, inserted: [] });
  assert.equal(state.scrollTop, 0);
  frames.shift()();
  assert.equal(state.scrollTop, 0);
});

test('上方长高 200 → 补 200，且反复补不累加', () => {
  withGlobals();
  const { state, list, anchor } = makePort({ layoutTop: 500, scrollTop: 0 });
  const frames = [];
  const pin = holdPin(list, frames);
  pin({ anchor, portTopBefore: 500, inserted: [] });
  state.layoutTop = 700; // 上面插了一页
  frames.shift()();
  assert.equal(state.scrollTop, 200);
  frames.shift()();
  assert.equal(state.scrollTop, 200);
});

test('底部流式长高不算（锚点没漂就不动）', () => {
  withGlobals();
  const { state, list, anchor } = makePort({ layoutTop: 500, scrollTop: 0 });
  const frames = [];
  const pin = holdPin(list, frames);
  pin({ anchor, portTopBefore: 500, inserted: [] });
  list.scrollHeight = 9000; // 底部又长了一截
  frames.shift()();
  assert.equal(state.scrollTop, 0);
});

test('用户自己滚滚轮 → 认下他的位置，只补后来的漂移（不拽回）', () => {
  withGlobals({ seq: 10 });
  const { state, list, anchor } = makePort({ layoutTop: 500, scrollTop: 200 });
  const frames = [];
  const pin = holdPin(list, frames);
  pin({ anchor, portTopBefore: 300, inserted: [] }); // 锚点在滚动区里 300
  // 用户往上滚了 120（用户滚动序号会变）
  globalThis.chatUserScrollSeq = 11;
  state.scrollTop = 80;
  frames.shift()();
  assert.equal(state.scrollTop, 80); // 位置归他
  // 之后上方又长高 100
  state.layoutTop = 600;
  frames.shift()();
  assert.equal(state.scrollTop, 180); // 他的 80 + 漂移 100
});

test('不是用户滚的（别处把位置还原成 0）→ 按漂移纠回原处', () => {
  withGlobals({ seq: 10 });
  const { state, list, anchor } = makePort({ layoutTop: 800, scrollTop: 300 });
  const frames = [];
  const pin = holdPin(list, frames);
  pin({ anchor, portTopBefore: 500, inserted: [] });
  // 别的代码把视野拉回顶部（用户滚动序号没变，所以不是用户干的）
  state.scrollTop = 0;
  frames.shift()();
  assert.equal(state.scrollTop, 300);
});

test('锚点离场（换会话 / 重渲染）后不再写滚动位置', () => {
  withGlobals();
  const { state, list, anchor } = makePort({ layoutTop: 500, scrollTop: 0 });
  const frames = [];
  const pin = holdPin(list, frames);
  pin({ anchor, portTopBefore: 500, inserted: [] });
  anchor.isConnected = false;
  state.layoutTop = 900;
  frames.shift()();
  assert.equal(state.scrollTop, 0);
});

test('钉一会儿就收手（不会一直占着每帧）', () => {
  withGlobals();
  const { list, anchor } = makePort({ layoutTop: 500, scrollTop: 0 });
  const frames = [];
  const pin = holdPin(list, frames);
  pin({ anchor, portTopBefore: 500, inserted: [] });
  let scheduled = frames.length;
  while (frames.length) {
    scheduled += 1;
    frames.shift()();
  }
  // 第一拍立即执行 + 之后最多 72 帧（≈1.2s），之后不再占着每帧
  assert.ok(scheduled <= 73, `连续钉的帧数应该有限，实际 ${String(scheduled)}`);
});

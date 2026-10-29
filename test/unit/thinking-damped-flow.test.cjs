'use strict';
/**
 * 无极阻尼的两条不变量（守的不是动画观感，而是状态别外溢、别逐帧翻转）：
 *
 * 1. `markThinkingFlowEnter`（renderer-thinking-trace-dom.js）：只在阻尼**当前生效**时打
 *    `data-flow-enter`，并在入场动画结束时摘掉。标记若永久留着，用户之后在设置里打开
 *    无极阻尼，当前会话里所有历史思考块会整片重放一次淡入 —— 正是这个开关要避免的。
 * 2. `dampedChatFollowStep` / `pinStreamingChatToBottom`（renderer-chat-render.js）：
 *    追帧是连续的动画中间态，"视口暂时不在底部" 不是用户接管。浮条与按钮的显隐
 *    只读 `chatAutoFollow` 这一个跨帧稳定的意图位 —— 若改用逐帧置位/复位的状态位，
 *    它们会跟着 delta 节奏一闪一闪（无极阻尼模式下"上一问"浮条一直闪的根因）。
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const TRACE_DOM_SRC = path.join(__dirname, '..', '..', 'src', 'renderer', 'renderer-thinking-trace-dom.js');
const CHAT_RENDER_SRC = path.join(__dirname, '..', '..', 'src', 'renderer', 'renderer-chat-render.js');
const CHAT_SCROLL_SRC = path.join(__dirname, '..', '..', 'src', 'renderer', 'renderer-chat-scroll.js');

/** 最小元素 stub：只实现标记函数与追帧用到的面 */
function makeEl(props = {}) {
  const listeners = {};
  const el = {
    dataset: {},
    listeners,
    scrollTop: 0,
    ...props,
    addEventListener(type, fn) {
      (listeners[type] = listeners[type] || []).push(fn);
    },
    removeEventListener(type, fn) {
      listeners[type] = (listeners[type] || []).filter((f) => f !== fn);
    },
    fire(type, event) {
      (listeners[type] || []).slice().forEach((fn) => fn(event));
    }
  };
  return el;
}

function loadTraceDom(isDamped) {
  const source = fs.readFileSync(TRACE_DOM_SRC, 'utf8');
  const factory = new Function(
    'document',
    'isThinkingDampedFlow',
    `${source}
     return { markThinkingFlowEnter };`
  );
  return factory({ createElement: makeEl }, isDamped);
}

/**
 * chat-render.js 末尾会把几条来自 renderer-chat-scroll.js 的全局挂到 window 上；
 * 单独求值时这几个名字必须存在，否则一进入脚本就 ReferenceError（与被测逻辑无关）。
 */
const CHAT_RENDER_DEPS = `
var captureSessionScrollPosition = function () {};
var restoreSessionScrollPosition = function () {};
var withSessionScrollCaptureSuppressed = function (fn) { return fn && fn(); };
var reconcileSessionLiveRunUi = function () {};
`;

function loadChatRender(opts) {
  const source = fs.readFileSync(CHAT_RENDER_SRC, 'utf8');
  const factory = new Function(
    'window',
    'document',
    'Element',
    'requestAnimationFrame',
    'cancelAnimationFrame',
    'chatList',
    'getChatAutoFollow',
    'isThinkingDampedFlow',
    'pinChatToBottom',
    'updateLastTurnFloat',
    'motionMs',
    `${CHAT_RENDER_DEPS}${source}
     return { dampedChatFollowStep, pinStreamingChatToBottom };`
  );
  return factory(
    {},
    { getElementById: () => opts.el },
    function Element() {},
    () => 0,
    () => {},
    opts.el,
    opts.autoFollow,
    opts.isDamped,
    opts.pinChatToBottom,
    opts.updateFloat,
    () => 280
  );
}

test('阻尼关闭时不打入场标记（否则之后打开开关会补放一遍）', () => {
  const api = loadTraceDom(() => false);
  const el = makeEl({ className: 'msg-thinking-step' });
  api.markThinkingFlowEnter(el);
  assert.equal(el.dataset.flowEnter, undefined);
  assert.equal((el.listeners['animationend'] || []).length, 0);
});

test('阻尼生效时打标记，并在入场动画结束后摘掉', () => {
  const api = loadTraceDom(() => true);
  const el = makeEl({ className: 'msg-thinking-step' });
  api.markThinkingFlowEnter(el);
  assert.equal(el.dataset.flowEnter, '1');

  el.fire('animationend', { target: el, animationName: 'other-animation' });
  assert.equal(el.dataset.flowEnter, '1', '别的动画结束不该摘标记');

  el.fire('animationend', { target: el, animationName: 'thinking-damped-in' });
  assert.equal(el.dataset.flowEnter, undefined);
  assert.equal((el.listeners['animationend'] || []).length, 0, '摘标记后不该留着监听');
});

test('追帧：离目标远就续帧，1px 内落位收摊', () => {
  const el = makeEl({ scrollHeight: 1000, clientHeight: 400, scrollTop: 580 });
  let floats = 0;
  const api = loadChatRender({
    el,
    autoFollow: () => true,
    isDamped: () => true,
    pinChatToBottom: () => true,
    updateFloat: () => {
      floats += 1;
    }
  });

  assert.equal(api.dampedChatFollowStep(), true, '离目标 20px：还要续帧');
  assert.ok(el.scrollTop > 580 && el.scrollTop < 600, '阻尼逼近而不是一步钉死');
  assert.equal(floats, 0, '追帧中间帧不该去刷浮条显隐（那正是闪烁的来源）');

  el.scrollTop = 599.5;
  assert.equal(api.dampedChatFollowStep(), false, '1px 内直接落位');
  assert.equal(el.scrollTop, 600);
  assert.equal(floats, 1, '落位这一次才刷新浮条');
});

test('不跟底时不抢视口、也不刷浮条', () => {
  const el = makeEl({ scrollHeight: 1000, clientHeight: 400, scrollTop: 0 });
  let pinned = 0;
  let floats = 0;
  const api = loadChatRender({
    el,
    autoFollow: () => false,
    isDamped: () => true,
    pinChatToBottom: () => {
      pinned += 1;
      return true;
    },
    updateFloat: () => {
      floats += 1;
    }
  });

  assert.equal(api.pinStreamingChatToBottom(), false);
  assert.equal(pinned, 0, '不跟底时不该抢视口');
  assert.equal(floats, 0);
});

/**
 * 判据必须跨帧稳定：浮条/按钮的显隐只能读 chatAutoFollow（用户意图），
 * 不能再引入「追帧中间态」这类逐帧翻转的状态位 —— 否则它会跟着 delta 节奏
 * 把「上一问」浮条一闪一闪地开合（用户看到的就是无极阻尼模式下浮条一直闪）。
 */
test('浮条/按钮显隐只有一个真值：chatAutoFollow，不再有逐帧状态位', () => {
  const scrollSrc = fs.readFileSync(CHAT_SCROLL_SRC, 'utf8');
  const renderSrc = fs.readFileSync(CHAT_RENDER_SRC, 'utf8');
  assert.equal(/chatFollowDampedPending/.test(scrollSrc), false, 'status bit must be gone');
  assert.equal(/setChatFollowDampedPending/.test(renderSrc), false, 'no per-frame writer');
  const btn = scrollSrc.slice(scrollSrc.indexOf('function updateChatScrollBottomBtn'));
  const body = btn.slice(0, btn.indexOf('\n}'));
  assert.ok(/getChatAutoFollow\(\)/.test(body), '按钮显隐读 chatAutoFollow');
});

/**
 * 第三处状态位：`flowEntered`（思考区每个 host 上的 per-run 记账）。
 * 思考区在流式期间会被反复重绘，同一轮的节点可能整棵重建；若每次重建都打入场标记，
 * 入场动画就一帧播一次 —— 用户看到的就是「无极阻尼模式下思考区一直闪」。
 * 所以记账必须是「整轮 run 累积」的，只在 resetThinkingUiState（新一轮 / 重绘收尾）清空。
 */
function loadTraceDomState() {
  const source = fs.readFileSync(TRACE_DOM_SRC, 'utf8');
  const factory = new Function(
    'document',
    'isThinkingDampedFlow',
    `${source}
     return { getThinkingUiState, resetThinkingUiState };`
  );
  return factory({ createElement: makeEl }, () => true);
}

test('flowEntered 按 host 记忆：同一次 run 内反复取到同一个集合', () => {
  const api = loadTraceDomState();
  const host = makeEl();
  const first = api.getThinkingUiState(host);
  first.flowEntered.add('0:思考:');
  const second = api.getThinkingUiState(host);
  assert.equal(second.flowEntered, first.flowEntered, '不能每次重绘都换一个新集合');
  assert.equal(second.flowEntered.has('0:思考:'), true);
});

test('resetThinkingUiState 清空 flowEntered（新一轮才重新入流）', () => {
  const api = loadTraceDomState();
  const host = makeEl();
  api.getThinkingUiState(host).flowEntered.add('0:思考:');
  api.resetThinkingUiState(host);
  assert.equal(api.getThinkingUiState(host).flowEntered.size, 0);
});

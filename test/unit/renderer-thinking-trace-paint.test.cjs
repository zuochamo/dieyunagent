'use strict';

/**
 * 「思考区跟正文同一次渲染落地」的回归（2026-11-25 现场：切会话切太快，正文在、
 * 思考区整块不出现，连「思考过程（加载中…）」占位都没有）。
 *
 * 旧行为：手里已有 trace 的那几条（内存里刚跑完那一轮的 `transientTrace`）**不带思考区**
 * 先画出来，思考塞进一个 `deferredThinkingJobs` 队列，由下一帧的 flush 补画。flush 一旦
 * 被下一次切换（代际变化）打断就整批丢掉：气泡留着正文、没有思考区、也没有占位，
 * 只有再渲染一次才会补回来 —— 正是「有时候刷不出来、切回来一下又有了」。
 *
 * 现在思考区只允许两条落地通路，都不存在「稍后补」的中间态：
 *   1. 手里已有 trace（inline / transient）→ 与正文同一次 `appendBubble`；
 *   2. 只有 `meta.traceRunId` → 立即可见的「加载中」占位 + 回填（失败也只影响这一块）。
 *
 * 浏览器脚本没有 module.exports，用 `new Function` 摘函数来验（手法同
 * `renderer-chat-window-on-leave.test.cjs`）。
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const RENDERER = path.join(__dirname, '..', '..', 'src', 'renderer');
const renderSrc = fs.readFileSync(path.join(RENDERER, 'renderer-chat-render.js'), 'utf8');
const scrollSrc = fs.readFileSync(path.join(RENDERER, 'renderer-chat-scroll.js'), 'utf8');

/** 从浏览器脚本里摘一个顶层函数（整文件 eval 要的桩太多）。 */
function extractFn(src, name) {
  const start = src.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `没找到 function ${name}`);
  const end = src.indexOf('\n}', start);
  assert.ok(end > start, `function ${name} 没闭合`);
  return src.slice(start, end + 2);
}

const build = new Function(
  'messages',
  'currentSessionId',
  'unpackUserMessageContent',
  'resolveUserFooterMeta',
  'canWithdrawUserTurn',
  'resolveUserTurnCopyText',
  'buildMsgTurnFooter',
  'appendTriggerNotice',
  'appendUserTurn',
  'unpackAssistantMeta',
  'splitPersistedAssistantTrace',
  'trackArtifactsFromTrace',
  'resolveCheckpointRestoreForAssistant',
  'appendBubble',
  'attachThinkingHydratePlaceholder',
  'hydrateAssistantTraceFromStore',
  `${extractFn(renderSrc, 'appendRenderedMessageAtIndex')}
   return appendRenderedMessageAtIndex;`
);

/**
 * @param {{ transientTrace?: object[], meta?: object|null, content?: string }} input
 */
function paint(input) {
  const calls = { bubbles: [], placeholders: 0, hydrates: 0, artifacts: 0 };
  const message = {
    role: 'assistant',
    content: 'raw',
    ...(input.transientTrace ? { transientTrace: input.transientTrace } : {})
  };
  const fn = build(
    [message],
    's1',
    (raw) => ({ content: String(raw || ''), meta: null }),
    () => ({}),
    () => false,
    () => '',
    () => null,
    () => {},
    () => {},
    () => ({ content: input.content || '正文', meta: input.meta || null }),
    () => ({ content: input.content || '正文', trace: null, thinkingRaw: null }),
    () => {
      calls.artifacts += 1;
    },
    () => null,
    (_role, content, opts) => {
      calls.bubbles.push({ content, opts });
      return { isConnected: true };
    },
    () => {
      calls.placeholders += 1;
    },
    () => {
      calls.hydrates += 1;
    }
  );
  fn(0, { forceScroll: false, skipScroll: true, sessionAtRender: 's1' });
  assert.equal(calls.bubbles.length, 1, '应该只画一个气泡');
  return calls;
}

const TRANSIENT = [{ round: 1, thought: '想一想', tools: [] }];

test('手里已有 trace（刚跑完那一轮的 transientTrace）→ 与正文同一次画进气泡', () => {
  const calls = paint({ transientTrace: TRANSIENT, meta: { traceRunId: 'trace-1' } });
  const opts = calls.bubbles[0].opts;
  assert.equal(calls.bubbles[0].content, '正文');
  assert.equal(opts.trace.length, 1, '思考区必须和正文同一次落地');
  assert.equal(calls.artifacts, 1, '产物仍按 trace 记账');
  assert.equal(calls.placeholders, 0, '已有 trace 时不该再挂「加载中」占位');
  assert.equal(calls.hydrates, 0, '已有 trace 时不该再去 store 回填');
});

test('只有 meta.traceRunId → 画成结构化气泡并交给回填（占位由回填自己挂）', () => {
  const calls = paint({ meta: { traceRunId: 'trace-1' } });
  const opts = calls.bubbles[0].opts;
  assert.equal(opts.trace.length, 0);
  assert.equal(opts.structured, true, '结构化气泡才知道自己还差一块思考区');
  assert.equal(calls.hydrates, 1);
  // 占位不在绘制这一层挂：回填命中缓存时要「直接有」，不该先闪一下「加载中」
  assert.equal(calls.placeholders, 0);
});

test('既没有 trace 也没有 traceRunId → 不伪造思考区', () => {
  const calls = paint({ meta: null });
  assert.equal(calls.bubbles[0].opts.trace.length, 0);
  assert.equal(calls.bubbles[0].opts.structured, false);
  assert.equal(calls.placeholders + calls.hydrates, 0);
});

test('「稍后补画」的延迟队列已整体删除（思考区不可能再被切换丢掉）', () => {
  for (const [label, src] of [
    ['renderer-chat-render.js', renderSrc],
    ['renderer-chat-scroll.js', scrollSrc]
  ]) {
    assert.doesNotMatch(src, /deferTrace|DeferredThinking|deferredThinking|DEFER_TRACE_YIELD/, label);
  }
  // 聊天区隐藏 token 必须在渲染收尾无条件归还（否则提前 return 会让整块聊天区不可见）
  assert.match(
    renderSrc,
    /endChatHistoryArtifactsBatch\(\);\s*\n\s*endSessionScrollCaptureSuppression\(\);\s*\n\s*endHiddenChatRender\(hiddenToken, \{ transition \}\);/,
    'renderChatFromMessagesYielding 的 finally 必须无条件 reveal'
  );
});

test('回填只走 trace-store 的读缓存，不另发一份 agent.trace_get', () => {
  // 取数唯一入口（缓存 + 在途去重）在 trace-store.js；这里只允许「先 peek、未命中再 read」。
  assert.match(renderSrc, /let row = peekAgentTraceRead\(meta\.traceRunId\);/);
  assert.match(renderSrc, /row = await readAgentTraceRecord\(meta\.traceRunId\);/);
  assert.doesNotMatch(renderSrc, /'agent\.trace_get'/);
  // 占位只挂在「未命中」分支里：命中缓存不许闪「加载中」
  assert.match(
    renderSrc,
    /if \(!row\) \{\s*\n\s*if \(!gwState\.authed\) return;\s*\n\s*attachThinkingHydratePlaceholder\(bubble\);/,
    '占位必须在未命中分支内'
  );
});

/**
 * 自动朗读的**触发点**回归测试。
 *
 * 背景（真实 bug）：最早把触发挂在 `finalizeAssistantBubble` 上，结果一次都不触发 ——
 * 正常完成走的是事件路径（DONE → applyAgentRunEventToLive 置 finished →
 * renderLiveRunFromEvent 收尾），`finalizeAssistantBubble` 只被中断/失败/轮次上限用到。
 * 所以这里直接跑真的 `dispatchAgentRunEvent`，锁住「DONE 且当前会话、且只念一次」。
 */
const fs = require('node:fs');
const path = require('node:path');
const events = require('../../src/agent/run-events.js');

const SRC = path.join(__dirname, '../../src/renderer/renderer-chat-live-run.js');
const DEP_NAMES = [
  'sessionActiveRuns',
  'currentSessionId',
  'chatList',
  'chatRenderApi',
  'checkpointRestoreOptsForLastTurn',
  'renderAssistantBubbleContent',
  'isChatNearBottom',
  'followChatStreamGrowth',
  'scrollChatToBottom',
  'AGENT_RUN_EVENT_TYPES',
  'maybeAutoReadAssistantBubble',
  'attachTtsBarToBubble',
  'applyAgentRunEventToLive',
  'normalizeAgentRunEvent'
];

function makeBubble(text) {
  const answer = { dataset: { rawContent: text }, innerText: text };
  return {
    isConnected: true,
    dataset: {},
    classList: { add() {}, remove() {}, toggle() {} },
    querySelector: (sel) => (sel === '.msg-answer' ? answer : null),
    querySelectorAll: () => [],
    nextElementSibling: null,
    parentNode: null
  };
}

function harness({ sessionId = 's1', currentSessionId = 's1', text = '这是回复正文' } = {}) {
  const autoReads = [];
  const rendered = [];
  const barsAttached = [];
  const bubble = makeBubble(text);
  const live = { finished: false, trace: [], streamContent: '', placeholderEl: bubble };
  const sessionActiveRuns = new Map([[sessionId, live]]);
  const chatList = { querySelector: () => null, querySelectorAll: () => [] };
  const mod = new Function(
    ...DEP_NAMES,
    `${fs.readFileSync(SRC, 'utf8')}
     return { dispatchAgentRunEvent, finalizeAssistantBubble };`
  )(
    sessionActiveRuns,
    currentSessionId,
    chatList,
    // 手机端进度桥：这里不需要，null 让它走不进 Main
    { agentServiceTaskProgress: null, agentServiceTaskCompleted: null },
    () => null,
    (el, opts) => rendered.push(opts),
    () => true,
    () => {},
    () => {},
    events.AGENT_RUN_EVENT_TYPES,
    (el, opts) => {
      autoReads.push({ el, opts });
      return true;
    },
    (el) => {
      barsAttached.push(el);
      return { className: 'msg-tts-bar' };
    },
    events.applyAgentRunEventToLive,
    events.normalizeAgentRunEvent
  );
  return { mod, live, bubble, autoReads, rendered, barsAttached, sessionId };
}

describe('dispatchAgentRunEvent → 自动朗读触发点', () => {
  it('DONE 且是当前会话：补挂朗读条、触发一次，参数是刚渲染完的气泡', () => {
    const h = harness();
    h.mod.dispatchAgentRunEvent(h.sessionId, {
      type: 'done',
      trace: [],
      streamContent: '这是回复正文'
    });
    expect(h.barsAttached).toEqual([h.bubble]);
    expect(h.autoReads).toHaveLength(1);
    expect(h.autoReads[0].el).toBe(h.bubble);
    expect(h.live.finished).toBe(true);
  });

  it('同一轮再收到事件不重复朗读', () => {
    const h = harness();
    h.mod.dispatchAgentRunEvent(h.sessionId, { type: 'done', trace: [], streamContent: 'x' });
    h.mod.dispatchAgentRunEvent(h.sessionId, { type: 'done', trace: [], streamContent: 'x' });
    h.mod.dispatchAgentRunEvent(h.sessionId, { type: 'stream', streamContent: 'x' });
    expect(h.autoReads).toHaveLength(1);
  });

  it('流式中途（stream / trace / tool / prep）不朗读', () => {
    const h = harness();
    for (const type of ['run_start', 'prep', 'trace', 'stream', 'tool']) {
      h.mod.dispatchAgentRunEvent(h.sessionId, { type, trace: [], streamContent: '半截' });
    }
    expect(h.autoReads).toHaveLength(0);
  });

  it('ERROR / STOPPED / 轮次上限不朗读', () => {
    for (const event of [
      { type: 'error', error: 'boom' },
      { type: 'stopped' },
      { type: 'round_limit', hitRoundLimit: true }
    ]) {
      const h = harness();
      h.mod.dispatchAgentRunEvent(h.sessionId, { trace: [], streamContent: 'x', ...event });
      expect(h.autoReads, `event=${event.type}`).toHaveLength(0);
    }
  });

  it('后台会话跑完不出声（当前会话是别人）', () => {
    const h = harness({ sessionId: 'bg', currentSessionId: 'fg' });
    h.mod.dispatchAgentRunEvent('bg', { type: 'done', trace: [], streamContent: 'x' });
    expect(h.autoReads).toHaveLength(0);
  });
});

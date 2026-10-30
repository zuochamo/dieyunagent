'use strict';

/* globals describe, it, expect, beforeEach, afterEach, vi */

/**
 * 频道调度层单测（不碰企微网络、不碰 Rust core）：
 *
 * - 同一会话串行：忙时回「上一条还在处理」，不排队不串台；
 * - 会话映射由频道持有，会话被删（SESSION_NOT_FOUND）时清映射重建一次；
 * - 流式回执按间隔节流（企微 30 条/分钟/会话），收尾帧 finish=true；
 * - 超时中止并回话。
 */

const { createChannelRuntime, createThrottledSink, clip, REPLY } = require('../../src/channels/runtime');

function memoryStore(channel) {
  const conversations = new Map();
  return {
    getChannel: (id) => (id === channel.id ? { ...channel } : null),
    getChannelSecrets: (id) => (id === channel.id ? { id, botId: 'bot', secret: 'sec', workspacePath: channel.workspacePath } : null),
    listChannels: () => [{ ...channel }],
    getConversationSession: (id, key) => conversations.get(`${id}:${key}`) || '',
    setConversationSession: (id, key, sid) => conversations.set(`${id}:${key}`, sid),
    clearConversationSession: (id, key) => conversations.delete(`${id}:${key}`),
    _conversations: conversations
  };
}

function fakeReply() {
  const calls = [];
  return {
    calls,
    stream: (content, finish) => {
      calls.push({ kind: 'stream', content, finish });
      return true;
    },
    final: (content) => {
      calls.push({ kind: 'stream', content, finish: true });
      return true;
    },
    welcome: (text) => {
      calls.push({ kind: 'welcome', content: text });
      return true;
    },
    finalCalls: () => calls.filter((c) => c.kind === 'stream' && c.finish)
  };
}

const CHANNEL = {
  id: 'ch_1',
  name: '企业微信测试',
  enabled: true,
  hasSecret: true,
  workspacePath: 'F:\\微信Agent对话'
};

function inbound(text) {
  return {
    reqId: 'req-1',
    conversationKey: 'single:zhangsan',
    normalized: { msgtype: 'text', text, images: [], voiceText: '', file: null },
    reply: null
  };
}

describe('channel runtime dispatch', () => {
  let store;
  beforeEach(() => {
    store = memoryStore(CHANNEL);
  });

  it('replies with the unsupported hint when there is nothing to run', async () => {
    const runtime = createChannelRuntime({ store, runTurn: async () => ({ sessionId: 's1', text: '' }) });
    const reply = fakeReply();
    await runtime.handleMessage(CHANNEL.id, { ...inbound(''), reply });
    expect(reply.calls).toEqual([{ kind: 'stream', content: REPLY.unsupportedText, finish: true }]);
  });

  it('runs a turn, records the session mapping and finishes the stream', async () => {
    const seen = [];
    const runtime = createChannelRuntime({
      store,
      runTurn: async (ctx) => {
        seen.push({ sessionId: ctx.sessionId, text: ctx.text, attachments: ctx.attachments.length });
        ctx.onSession('sess-new');
        ctx.sink.push('第一段');
        return { sessionId: 'sess-new', text: '完整答复' };
      }
    });
    const reply = fakeReply();
    await runtime.handleMessage(CHANNEL.id, { ...inbound('你好'), reply });
    // 首帧「已收到」，收尾帧是完整答复
    expect(reply.calls[0]).toEqual({ kind: 'stream', content: REPLY.startedText, finish: false });
    expect(reply.finalCalls()).toEqual([{ kind: 'stream', content: '完整答复', finish: true }]);
    expect(seen).toEqual([{ sessionId: '', text: '你好', attachments: 0 }]);
    expect(store.getConversationSession(CHANNEL.id, 'single:zhangsan')).toBe('sess-new');
  });

  it('tells the user to wait instead of queueing a second message', async () => {
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const runtime = createChannelRuntime({
      store,
      runTurn: async () => {
        await gate;
        return { sessionId: 's1', text: 'done' };
      }
    });
    const first = runtime.handleMessage(CHANNEL.id, { ...inbound('第一条'), reply: fakeReply() });
    const busyReply = fakeReply();
    await runtime.handleMessage(CHANNEL.id, { ...inbound('第二条'), reply: busyReply });
    expect(busyReply.calls).toEqual([{ kind: 'stream', content: REPLY.busyText, finish: true }]);
    release();
    await first;
  });

  it('停频道会把在跑的一轮真正中止（不中止 = 断线后继续吃 token 到 900s）', async () => {
    let abortSeen = false;
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const runtime = createChannelRuntime({
      store,
      runTurn: async (ctx) => {
        ctx.signal.addEventListener('abort', () => {
          abortSeen = true;
          release();
        });
        await gate;
        if (ctx.signal.aborted) {
          const err = new Error('aborted');
          err.name = 'AbortError';
          throw err;
        }
        return { sessionId: 's1', text: 'done' };
      }
    });
    const reply = fakeReply();
    const task = runtime.handleMessage(CHANNEL.id, { ...inbound('跑个长任务'), reply });
    runtime.stopChannel(CHANNEL.id);
    expect(abortSeen).toBe(true);
    await task;
    // 收尾帧说清「已中止」，别让微信那头一直停在「已收到，正在处理…」
    expect(reply.calls[reply.calls.length - 1]).toEqual({
      kind: 'stream',
      content: REPLY.timeoutText,
      finish: true
    });
  });

  it('rebuilds the session once when the mapped session was deleted', async () => {
    store.setConversationSession(CHANNEL.id, 'single:zhangsan', 'sess-gone');
    const attempts = [];
    const runtime = createChannelRuntime({
      store,
      runTurn: async (ctx) => {
        attempts.push(ctx.sessionId);
        if (ctx.sessionId === 'sess-gone') {
          const e = new Error('rpc error: SESSION_NOT_FOUND');
          throw e;
        }
        return { sessionId: 'sess-rebuilt', text: '新会话答复' };
      }
    });
    const reply = fakeReply();
    await runtime.handleMessage(CHANNEL.id, { ...inbound('继续'), reply });
    expect(attempts).toEqual(['sess-gone', '']);
    expect(store.getConversationSession(CHANNEL.id, 'single:zhangsan')).toBe('sess-rebuilt');
    expect(reply.finalCalls()[0].content).toBe('新会话答复');
  });

  it('aborts on timeout and says so', async () => {
    const original = REPLY.taskTimeoutMs;
    REPLY.taskTimeoutMs = 5;
    try {
      const runtime = createChannelRuntime({
        store,
        runTurn: (ctx) =>
          new Promise((_resolve, reject) => {
            ctx.signal.addEventListener('abort', () => reject(new Error('aborted')));
          })
      });
      const reply = fakeReply();
      await runtime.handleMessage(CHANNEL.id, { ...inbound('长任务'), reply });
      const last = reply.finalCalls().pop();
      expect(last.finish).toBe(true);
      expect(last.content).toContain(REPLY.timeoutText);
    } finally {
      REPLY.taskTimeoutMs = original;
    }
  });

  it('passes image and file attachments through to the turn', async () => {
    let attachments = null;
    const runtime = createChannelRuntime({
      store,
      runTurn: async (ctx) => {
        attachments = ctx.attachments;
        return { sessionId: 's1', text: 'ok' };
      }
    });
    await runtime.handleMessage(CHANNEL.id, {
      reqId: 'req-2',
      conversationKey: 'single:zhangsan',
      normalized: {
        msgtype: 'mixed',
        text: '看这两张',
        images: ['https://x/1.jpg', 'https://x/2.jpg'],
        voiceText: '',
        file: { url: 'https://x/a.pdf', name: 'a.pdf' }
      },
      reply: fakeReply()
    });
    expect(attachments).toEqual([
      { kind: 'image', url: 'https://x/1.jpg' },
      { kind: 'image', url: 'https://x/2.jpg' },
      { kind: 'file', url: 'https://x/a.pdf', name: 'a.pdf' }
    ]);
  });
});

describe('throttled stream sink', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('flushes once per interval and only when the text changed', () => {
    const reply = fakeReply();
    const sink = createThrottledSink({ reply, log: () => {} });
    sink.start();
    sink.push('一');
    vi.advanceTimersByTime(REPLY.flushIntervalMs);
    sink.push('一');
    vi.advanceTimersByTime(REPLY.flushIntervalMs);
    sink.push('一二');
    vi.advanceTimersByTime(REPLY.flushIntervalMs);
    const frames = reply.calls.filter((c) => !c.finish);
    expect(frames.map((f) => f.content)).toEqual(['一', '一二']);
    sink.final('一二三');
    expect(reply.calls.filter((c) => c.finish)).toEqual([{ kind: 'stream', content: '一二三', finish: true }]);
    // 收尾后不再有新的非收尾帧
    vi.advanceTimersByTime(REPLY.flushIntervalMs * 3);
    expect(reply.calls.filter((c) => !c.finish).length).toBe(2);
  });

  it('clips an over-long reply and points at the desktop session', () => {
    const long = 'x'.repeat(REPLY.maxChars + 10);
    const clipped = clip(long);
    expect(clipped.length).toBeLessThan(long.length + 60);
    expect(clipped).toContain('完整内容在桌面端会话里');
  });
});

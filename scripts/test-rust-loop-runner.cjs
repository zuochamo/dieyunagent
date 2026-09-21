'use strict';

/**
 * Node-side agent loop orchestration (no dieyun-core / live LLM).
 * Run: node scripts/test-rust-loop-runner.cjs
 */

const {
  runRustAgentLoop,
  resolveChatUrl,
  normalizeLlmResponse,
  applyResolvedLoopSpec,
  shouldCompactRound,
  backfillReasoningContent
} = require('../src/agent/rust-loop-runner');
const { REASONING_PLACEHOLDER } = require('../src/agent/reasoning-backfill');
const { isReasoningFallbackText, persistableTurnText, TURN_EMPTY_REPLY_TEXT } = require('../src/agent/agent-round-text');

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assert failed');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createFakeBridge(handlers) {
  const invokes = [];
  const abortPendingCalls = [];
  return {
    invokes,
    abortPendingCalls,
    abortPending(payload) {
      abortPendingCalls.push(payload);
    },
    async invoke(method, params, timeout) {
      invokes.push({ method, params, timeout });
      const handler = handlers[method];
      if (typeof handler !== 'function') {
        throw new Error(`unexpected invoke ${method}`);
      }
      return handler(params, timeout);
    }
  };
}

function loopSpec() {
  return { maxToolCalls: 8, firstTokenTimeoutMs: 1000 };
}

async function expectAbort(promise) {
  try {
    await promise;
    throw new Error('expected AbortError');
  } catch (err) {
    assert(err && err.name === 'AbortError', `expected AbortError, got ${err && err.name}: ${err && err.message}`);
  }
}

function testShouldCompactRound() {
  assert(
    !shouldCompactRound({ force: false, messageCount: 3, chars: 1000, charBudget: 800000 }),
    'short first round stays uncompressed'
  );
  assert(
    shouldCompactRound({ force: false, messageCount: 3, chars: 500000, charBudget: 800000 }),
    'heavy first round compact even at llmRound 0'
  );
  assert(shouldCompactRound({ force: true, messageCount: 2, chars: 10, charBudget: 800000 }), 'force compact');
  // 门槛与 completionRecentTurns(24) 对齐：12 条不再触发，25 条才触发
  assert(
    !shouldCompactRound({ force: false, messageCount: 13, chars: 10, charBudget: 800000 }),
    '13 messages stays uncompressed'
  );
  assert(
    shouldCompactRound({ force: false, messageCount: 25, chars: 10, charBudget: 800000 }),
    'compact after 24 messages'
  );
}

function testApplyResolvedLoopSpec() {
  const filled = applyResolvedLoopSpec({ model: 'm' }, { maxToolCalls: 12 });
  assert(filled.maxToolCalls === 12, 'fill missing maxToolCalls');
  const kept = applyResolvedLoopSpec({ maxToolCalls: 3 }, { maxToolCalls: 12 });
  assert(kept.maxToolCalls === 3, 'keep explicit maxToolCalls');
  const emptySpec = applyResolvedLoopSpec({ model: 'm' }, {});
  assert(!Object.prototype.hasOwnProperty.call(emptySpec, 'maxToolCalls'), 'do not write undefined maxToolCalls');
  const nullSpec = applyResolvedLoopSpec({ model: 'm' }, { maxToolCalls: undefined });
  assert(!Object.prototype.hasOwnProperty.call(nullSpec, 'maxToolCalls'), 'ignore undefined resolved value');
}

function testResolveChatUrl() {
  assert(resolveChatUrl('https://api.example/v1') === 'https://api.example/v1/chat/completions', 'append completions');
  assert(
    resolveChatUrl('http://192.168.31.37:1234') === 'http://192.168.31.37:1234/v1/chat/completions',
    'bare OpenAI-compatible host gets /v1'
  );
  assert(
    resolveChatUrl('https://api.example/v1/chat/completions?api-version=2024') ===
      'https://api.example/v1/chat/completions?api-version=2024',
    'keep azure query'
  );
  let threw = false;
  try {
    resolveChatUrl('');
  } catch {
    threw = true;
  }
  assert(threw, 'empty baseUrl throws');
}

function testNormalizeLlmResponse() {
  const resp = normalizeLlmResponse({
    choices: [
      {
        finish_reason: 'length',
        message: {
          content: 'hi',
          tool_calls: [
            { id: 'a', function: { name: 'fs_read_file', arguments: '{"filePath":"x"}' } },
            { id: 'b', function: { name: '', arguments: '{}' } }
          ]
        }
      }
    ]
  });
  assert(resp.content === 'hi', 'content');
  assert(resp.toolCalls.length === 1, 'drop empty name');
  assert(resp.toolCalls[0].name === 'fs_read_file', 'keep named tool');
  assert(resp.finishReason === 'length', 'finishReason');
}

async function testLlmOnlyRound() {
  const bridge = createFakeBridge({
    'agent.loop.start': async () => ({
      runId: 'run-1',
      phase: 'need_llm',
      llmBody: { model: 'm', messages: [{ role: 'user', content: 'hi' }], tools: [] }
    }),
    'agent.loop.continue': async (params) => {
      assert(params.runId === 'run-1', 'continue runId');
      assert(params.llm && params.llm.content === 'ok', 'continue llm payload');
      assert(params.llm.contentChannel === 'answer', 'continue llm carries contentChannel');
      return { runId: 'run-1', phase: 'done', content: 'ok' };
    }
  });
  const phases = [];
  const result = await runRustAgentLoop({
    coreBridge: bridge,
    llm: { baseUrl: 'https://example/v1', apiKey: 'k' },
    startParams: { model: 'm', messages: [] },
    loopSpec: loopSpec(),
    onPhase: (p) => phases.push(p),
    fetchLlmOnce: async () => ({ content: 'ok', toolCalls: [] })
  });
  assert(result.phase === 'done', 'done');
  assert(phases.includes('start') && phases.includes('llm_request') && phases.includes('llm_response'), 'llm phases');
  assert(
    bridge.invokes.map((i) => i.method).join(',') === 'agent.loop.start,agent.loop.continue',
    'start then continue'
  );
}

/**
 * 单通道模型（mimo）：`content` 键即思考 —— 入口把它盖章为 `reasoning`，
 * Rust 账本据此不再把它当正文（见 docs/REASONING-ISOLATION-PLAN.md §3.3）。
 */
async function testContentChannelReachesLedger() {
  const cases = [
    ['m', 'answer'],
    ['mimo-v2.5-pro', 'reasoning']
  ];
  for (const [model, expected] of cases) {
    let seen = null;
    const bridge = createFakeBridge({
      'agent.loop.start': async () => ({
        runId: 'run-1',
        phase: 'need_llm',
        llmBody: { model, messages: [{ role: 'user', content: 'hi' }], tools: [] }
      }),
      'agent.loop.continue': async (params) => {
        seen = params.llm;
        return { runId: 'run-1', phase: 'done', content: '' };
      }
    });
    await runRustAgentLoop({
      coreBridge: bridge,
      llm: { baseUrl: 'https://example/v1', apiKey: 'k' },
      startParams: { model, messages: [] },
      loopSpec: loopSpec(),
      fetchLlmOnce: async () => ({ content: 'ok', toolCalls: [] })
    });
    assert(seen, `continue called for ${model}`);
    assert(
      seen.contentChannel === expected,
      `contentChannel for ${model}: got ${seen.contentChannel}, want ${expected}`
    );
  }
}

async function testCompactThenContinue() {
  const messages = Array.from({ length: 25 }, (_, i) => ({ role: 'user', content: String(i) }));
  const compactCalls = [];
  const bridge = createFakeBridge({
    'agent.loop.start': async () => ({
      runId: 'run-c',
      phase: 'need_llm',
      llmBody: { model: 'm', messages, tools: [] }
    }),
    'agent.loop.set_messages': async (params) => {
      assert(params.messages.length === 2, 'compacted messages written');
      return { ok: true };
    },
    'agent.loop.continue': async () => ({ runId: 'run-c', phase: 'done', content: 'ok' })
  });
  const phases = [];
  await runRustAgentLoop({
    coreBridge: bridge,
    llm: { baseUrl: 'https://example/v1' },
    startParams: { model: 'm' },
    loopSpec: loopSpec(),
    onPhase: (p) => phases.push(p),
    compactMessages: async (msgs, ctx) => {
      compactCalls.push({ n: msgs.length, round: ctx.round });
      return { compacted: true, messages: msgs.slice(0, 2), tokensBefore: 90, tokensAfter: 10 };
    },
    fetchLlmOnce: async () => ({ content: 'ok', toolCalls: [] })
  });
  assert(compactCalls.length === 1, 'compact once');
  assert(phases.includes('compacted'), 'compacted phase');
  assert(
    bridge.invokes.some((i) => i.method === 'agent.loop.set_messages'),
    'set_messages'
  );
}

async function testCompactTimeoutContinuesLoop() {
  const messages = Array.from({ length: 25 }, (_, i) => ({ role: 'user', content: String(i) }));
  const bridge = createFakeBridge({
    'agent.loop.start': async () => ({
      runId: 'run-to',
      phase: 'need_llm',
      llmBody: { model: 'm', messages, tools: [] }
    }),
    'agent.loop.continue': async () => ({ runId: 'run-to', phase: 'done', content: 'ok' })
  });
  const phases = [];
  const result = await runRustAgentLoop({
    coreBridge: bridge,
    llm: { baseUrl: 'https://example/v1' },
    startParams: { model: 'm' },
    loopSpec: loopSpec(),
    onPhase: (p) => phases.push(p),
    compactMessages: async () => {
      const err = new Error('dieyun-core 超时: compaction.maybe_compact');
      err.code = 'CORE_RPC_TIMEOUT';
      throw err;
    },
    fetchLlmOnce: async () => ({ content: 'ok', toolCalls: [] })
  });
  assert(result.phase === 'done', 'timeout skip still finishes loop');
  assert(phases.includes('compact_skipped'), 'compact_skipped phase');
  assert(!phases.includes('compacted'), 'did not compact');
  assert(
    !bridge.invokes.some((i) => i.method === 'agent.loop.set_messages'),
    'no set_messages after skip'
  );
}

async function testCompactSkippedResultContinuesLoop() {
  const messages = Array.from({ length: 25 }, (_, i) => ({ role: 'user', content: String(i) }));
  const bridge = createFakeBridge({
    'agent.loop.start': async () => ({
      runId: 'run-sk',
      phase: 'need_llm',
      llmBody: { model: 'm', messages, tools: [] }
    }),
    'agent.loop.continue': async () => ({ runId: 'run-sk', phase: 'done', content: 'ok' })
  });
  const phases = [];
  await runRustAgentLoop({
    coreBridge: bridge,
    llm: { baseUrl: 'https://example/v1' },
    startParams: { model: 'm' },
    loopSpec: loopSpec(),
    onPhase: (p) => phases.push(p),
    compactMessages: async () => ({
      compacted: false,
      messages,
      compactionSkipped: 'llm_error',
      llmError: 'dieyun-core 超时: compaction.maybe_compact'
    }),
    fetchLlmOnce: async () => ({ content: 'ok', toolCalls: [] })
  });
  assert(phases.includes('compact_skipped'), 'skipped result emits phase');
}

async function testSkipCompactOnShortFirstRound() {
  let compactCalled = false;
  const bridge = createFakeBridge({
    'agent.loop.start': async () => ({
      runId: 'run-s',
      phase: 'need_llm',
      llmBody: {
        model: 'm',
        messages: [
          { role: 'system', content: 's' },
          { role: 'user', content: 'u' }
        ]
      }
    }),
    'agent.loop.continue': async () => ({ runId: 'run-s', phase: 'done', content: 'ok' })
  });
  await runRustAgentLoop({
    coreBridge: bridge,
    llm: { baseUrl: 'https://example/v1' },
    startParams: { model: 'm' },
    loopSpec: loopSpec(),
    compactMessages: async () => {
      compactCalled = true;
      return { compacted: true, messages: [] };
    },
    fetchLlmOnce: async () => ({ content: 'ok', toolCalls: [] })
  });
  assert(!compactCalled, 'first short round does not compact');
}

async function testDelegateRound() {
  const bridge = createFakeBridge({
    'agent.loop.start': async () => ({
      runId: 'run-d',
      phase: 'need_delegate',
      delegates: [{ id: 'c1', name: 'fs_read_file', arguments: { filePath: 'a.txt' } }]
    }),
    'agent.loop.tool_results': async (params) => {
      assert(params.results.length === 1, 'one result');
      assert(params.results[0].id === 'c1', 'result id');
      assert(params.results[0].result && params.results[0].result.text === 'hello', 'tool body');
      return { runId: 'run-d', phase: 'done', content: 'done' };
    }
  });
  const result = await runRustAgentLoop({
    coreBridge: bridge,
    llm: { baseUrl: 'https://example/v1' },
    startParams: { model: 'm' },
    loopSpec: loopSpec(),
    delegateTool: async (name, args) => {
      assert(name === 'fs_read_file', 'tool name');
      assert(args.filePath === 'a.txt', 'tool args');
      return { text: 'hello' };
    },
    fetchLlmOnce: async () => {
      throw new Error('LLM should not run on need_delegate');
    }
  });
  assert(result.phase === 'done', 'delegate done');
}

async function testBrowserVisionInjection() {
  const bv = require('../src/agent/browser-vision');

  bv.recordBrowserScreenshot('run-bv', 'browser_screenshot', {
    ok: true,
    mime: 'image/png',
    base64: 'AAAA',
    width: 12,
    height: 8
  });
  let seenMessages = null;
  const phases = [];
  const bridge = createFakeBridge({
    'agent.loop.start': async () => ({
      runId: 'run-bv',
      phase: 'need_llm',
      llmBody: { model: 'm', messages: [{ role: 'user', content: 'hi' }], tools: [] }
    }),
    'agent.loop.continue': async () => ({ runId: 'run-bv', phase: 'done', content: 'ok' })
  });
  await runRustAgentLoop({
    coreBridge: bridge,
    llm: { baseUrl: 'https://example/v1' },
    startParams: { model: 'm' },
    loopSpec: loopSpec(),
    browserVision: true,
    onPhase: (p) => phases.push(p),
    fetchLlmOnce: async ({ body }) => {
      seenMessages = body.messages;
      return { content: 'ok', toolCalls: [] };
    }
  });
  assert(Array.isArray(seenMessages) && seenMessages.length === 2, 'vision message appended');
  const visionMsg = seenMessages[seenMessages.length - 1];
  assert(visionMsg.role === 'user', 'vision message uses user role');
  assert(
    Array.isArray(visionMsg.content) && visionMsg.content.some((p) => p.type === 'image_url'),
    'vision message carries image_url part'
  );
  assert(phases.includes('browser_vision_injected'), 'emits browser_vision_injected');
  assert(bv.takePendingBrowserScreenshots('run-bv').length === 0, 'pending cleared after injection');

  bv.recordBrowserScreenshot('run-bv-off', 'browser_screenshot', { ok: true, base64: 'BBBB' });
  let seenOff = null;
  const bridge2 = createFakeBridge({
    'agent.loop.start': async () => ({
      runId: 'run-bv-off',
      phase: 'need_llm',
      llmBody: { model: 'm', messages: [{ role: 'user', content: 'hi' }] }
    }),
    'agent.loop.continue': async () => ({ runId: 'run-bv-off', phase: 'done', content: 'ok' })
  });
  await runRustAgentLoop({
    coreBridge: bridge2,
    llm: { baseUrl: 'https://example/v1' },
    startParams: { model: 'm' },
    loopSpec: loopSpec(),
    fetchLlmOnce: async ({ body }) => {
      seenOff = body.messages;
      return { content: 'ok', toolCalls: [] };
    }
  });
  assert(seenOff.length === 1, 'no injection when browserVision disabled');
  assert(bv.takePendingBrowserScreenshots('run-bv-off').length === 1, 'disabled run leaves buffer untouched');

  bv.recordBrowserScreenshot('run-bv-big', 'browser_screenshot', {
    ok: true,
    base64: 'x'.repeat(bv.MAX_BASE64_CHARS + 1)
  });
  assert(bv.takePendingBrowserScreenshots('run-bv-big').length === 0, 'oversized shot dropped');

  for (let i = 0; i < 4; i += 1) {
    bv.recordBrowserScreenshot('run-bv-cap', 'browser_observe', {
      ok: true,
      screenshot: { base64: `img${i}` }
    });
  }
  const capped = bv.takePendingBrowserScreenshots('run-bv-cap');
  assert(capped.length === 2, 'cap shots per run');
  assert(capped[capped.length - 1].base64 === 'img3', 'keep newest shot');

  // 附件补看：与浏览器截图各自独立配额
  bv.recordBrowserScreenshot('run-bv-mix', 'browser_screenshot', { ok: true, base64: 'B1' });
  assert(
    bv.recordVisionImage('run-bv-mix', {
      source: 'attachment',
      mime: 'image/png',
      base64: 'A1',
      path: '.dieyun/attachments/a.png'
    }),
    'attachment image queued'
  );
  assert(
    bv.recordVisionImage('run-bv-mix', {
      source: 'attachment',
      mime: 'image/jpeg',
      base64: 'A2',
      path: '.dieyun/attachments/b.png'
    }),
    'second attachment image queued'
  );
  assert(
    bv.recordVisionImage('run-bv-mix', {
      source: 'attachment',
      mime: 'image/png',
      base64: 'A3',
      path: '.dieyun/attachments/c.png'
    }) === false,
    'attachment quota enforced independently'
  );
  const mixed = bv.takePendingVisionImages('run-bv-mix');
  assert(mixed.length === 3, 'browser and attachment quotas do not share a cap');
  assert(
    mixed.filter((m) => m.source === 'attachment').map((m) => m.base64).join(',') === 'A1,A2',
    'keeps newest attachment images'
  );
  const mixedMsg = bv.buildVisionMessage(mixed);
  assert(
    mixedMsg.content.filter((p) => p.type === 'image_url').length === 3,
    'mixed message carries every image'
  );
  assert(/历史附件图片/.test(mixedMsg.content[0].text), 'mixed message explains attachment source');
  assert(/浏览器当前画面截图/.test(mixedMsg.content[0].text), 'mixed message explains browser source');

  // 额度可由 agent-limits 显式覆盖（口径是「每轮在途」，故 key 以 PerRound 结尾）
  assert(bv.MAX_SHOTS_PER_RUN === 2, 'legacy cap constant still exported');
  assert(
    bv.recordBrowserScreenshot('run-bv-zero', 'browser_screenshot', { ok: true, base64: 'ZZ' }, { visionShotsPerRound: 0 }) === false,
    'zero quota disables browser injection'
  );
  assert(
    bv.recordVisionImage(
      'run-bv-limit',
      { source: 'attachment', base64: 'y'.repeat(101) },
      { visionMaxBase64Chars: 100 }
    ) === false,
    'oversized attachment image dropped'
  );

  // 同一路径重复入队是幂等的：不重复注入同一份像素，也不消耗额度
  assert(
    bv.recordVisionImage('run-bv-dedupe', { source: 'attachment', base64: 'D1', path: 'a.png' }),
    'first read queued'
  );
  assert(
    bv.recordVisionImage('run-bv-dedupe', { source: 'attachment', base64: 'D2', path: 'a.png' }),
    'duplicate read is idempotent'
  );
  assert(
    bv.recordVisionImage('run-bv-dedupe', { source: 'attachment', base64: 'D3', path: 'b.png' }),
    'second distinct path queued'
  );
  assert(
    bv.recordVisionImage('run-bv-dedupe', { source: 'attachment', base64: 'D4', path: 'c.png' }) === false,
    'duplicates do not consume quota'
  );
  const deduped = bv.takePendingVisionImages('run-bv-dedupe');
  assert(deduped.length === 2, 'duplicate path injected once');
  assert(deduped[0].base64 === 'D1', 'keeps first payload for a path');
}

async function testVisionSurvivesOverflowRetry() {
  const bv = require('../src/agent/browser-vision');
  bv.recordVisionImage('run-vr', {
    source: 'attachment',
    mime: 'image/png',
    base64: 'R0lGODdh',
    path: '.dieyun/attachments/retry.png'
  });

  const seenBodies = [];
  const phases = [];
  let llmCalls = 0;
  const bridge = createFakeBridge({
    'agent.loop.start': async () => ({
      runId: 'run-vr',
      phase: 'need_llm',
      llmBody: { model: 'm', messages: [{ role: 'user', content: '看图' }], tools: [] }
    }),
    'agent.loop.set_messages': async () => ({ ok: true }),
    'agent.loop.continue': async () => ({ runId: 'run-vr', phase: 'done', content: 'ok' })
  });

  await runRustAgentLoop({
    coreBridge: bridge,
    llm: { baseUrl: 'https://example/v1' },
    startParams: { model: 'm' },
    loopSpec: loopSpec(),
    browserVision: true,
    onPhase: (p) => phases.push(p),
    compactMessages: async (msgs) => ({
      compacted: true,
      messages: msgs.slice(0, 1),
      tokensBefore: 90,
      tokensAfter: 10
    }),
    fetchLlmOnce: async ({ body }) => {
      llmCalls += 1;
      seenBodies.push(body.messages);
      if (llmCalls === 1) {
        const err = new Error('HTTP 400 prompt is too long');
        err.statusCode = 400;
        throw err;
      }
      return { content: 'ok', toolCalls: [] };
    }
  });

  const carriesImage = (list) =>
    (list || []).some(
      (m) => Array.isArray(m.content) && m.content.some((p) => p && p.type === 'image_url')
    );
  assert(seenBodies.length === 2, 'overflow triggers exactly one retry');
  assert(carriesImage(seenBodies[0]), 'first attempt carries the image');
  // 关键：重试用的是同一个 llmRound，drain 后不能丢图（否则模型看不到图却被告知「已附在下一轮」）
  assert(carriesImage(seenBodies[1]), 'retry keeps the image instead of losing it');
  assert(
    phases.filter((p) => p === 'attachment_vision_injected').length === 1,
    'vision phase emitted once per round'
  );
}

/** 复刻真实上游文案：HTTP 400 + `.messages[N].image[0]: unsupported image` */
function unsupportedImageError(messageIndex) {
  const err = new Error(
    `HTTP 400 {"error":{"code":"invalid_request_error","message":"Error from provider (Console Go): ` +
      `Upstream request failed: [invalid_request_error] .messages[${messageIndex}].image[0]: You have uploaded ` +
      `an unsupported image. Please make sure your image is valid and has one of the following formats: ` +
      `webp, png, jpeg, and gif.","param":null,"type":"invalid_request_error"}}`
  );
  err.statusCode = 400;
  return err;
}

const PNG_DATA_URL = `data:image/png;base64,${Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0
]).toString('base64')}`;

function snapshotMessages(messages) {
  return JSON.parse(JSON.stringify(messages));
}

function carriesImagePart(list) {
  return (list || []).some(
    (m) => Array.isArray(m.content) && m.content.some((p) => p && p.type === 'image_url')
  );
}

async function testImageRejectedRoundIsRepaired() {
  const messages = [
    { role: 'user', content: '这是什么？' },
    {
      role: 'user',
      content: [{ type: 'text', text: '看图' }, { type: 'image_url', image_url: { url: PNG_DATA_URL } }]
    }
  ];
  const setMessages = [];
  const seen = [];
  const phases = [];
  let llmCalls = 0;
  const bridge = createFakeBridge({
    'agent.loop.start': async () => ({
      runId: 'run-img',
      phase: 'need_llm',
      llmBody: { model: 'm', messages, tools: [] }
    }),
    'agent.loop.set_messages': async (params) => {
      setMessages.push(snapshotMessages(params.messages));
      return { ok: true };
    },
    'agent.loop.continue': async () => ({ runId: 'run-img', phase: 'done', content: 'ok' })
  });

  const result = await runRustAgentLoop({
    coreBridge: bridge,
    llm: { baseUrl: 'https://example/v1' },
    startParams: { model: 'm' },
    loopSpec: loopSpec(),
    onPhase: (p) => phases.push(p),
    fetchLlmOnce: async ({ body }) => {
      llmCalls += 1;
      seen.push(snapshotMessages(body.messages));
      if (llmCalls === 1) throw unsupportedImageError(1);
      return { content: 'ok', toolCalls: [] };
    }
  });

  assert(result.phase === 'done', 'image rejection still finishes the turn');
  assert(llmCalls === 2, 'retried exactly once');
  assert(carriesImagePart(seen[0]), 'first attempt carries the image');
  assert(!carriesImagePart(seen[1]), 'retry drops the rejected image');
  assert(
    seen[1][1].content.some((p) => p.type === 'text' && /图片被模型接口拒绝/.test(p.text)),
    'dropped image becomes an explaining text part'
  );
  assert(setMessages.length === 1, 'ledger written back once');
  assert(!carriesImagePart(setMessages[0]), 'ledger no longer holds the rejected image');
  assert(phases.includes('llm_images_dropped'), 'emits llm_images_dropped');
}

async function testRejectedImageWithoutUsableIndexDropsAll() {
  const messages = [
    {
      role: 'user',
      content: [{ type: 'image_url', image_url: { url: PNG_DATA_URL } }]
    }
  ];
  const seen = [];
  let llmCalls = 0;
  const bridge = createFakeBridge({
    'agent.loop.start': async () => ({
      runId: 'run-img-all',
      phase: 'need_llm',
      llmBody: { model: 'm', messages, tools: [] }
    }),
    'agent.loop.set_messages': async () => ({ ok: true }),
    'agent.loop.continue': async () => ({ runId: 'run-img-all', phase: 'done', content: 'ok' })
  });
  await runRustAgentLoop({
    coreBridge: bridge,
    llm: { baseUrl: 'https://example/v1' },
    startParams: { model: 'm' },
    loopSpec: loopSpec(),
    fetchLlmOnce: async ({ body }) => {
      llmCalls += 1;
      seen.push(snapshotMessages(body.messages));
      // 文案里没有可用的 .messages[N] 定位：不许赌，直接丢光
      if (llmCalls === 1) {
        const err = new Error('HTTP 400 unsupported image');
        err.statusCode = 400;
        throw err;
      }
      return { content: 'ok', toolCalls: [] };
    }
  });
  assert(llmCalls === 2, 'retried once without an index');
  assert(!carriesImagePart(seen[1]), 'all images dropped when the index is unusable');
}

async function testRejectedVisionMessageIsNotReinjected() {
  const bv = require('../src/agent/browser-vision');
  bv.recordBrowserScreenshot('run-vimg', 'browser_screenshot', {
    ok: true,
    mime: 'image/png',
    base64: 'AAAA'
  });

  const seen = [];
  const phases = [];
  let llmCalls = 0;
  const bridge = createFakeBridge({
    'agent.loop.start': async () => ({
      runId: 'run-vimg',
      phase: 'need_llm',
      llmBody: { model: 'm', messages: [{ role: 'user', content: 'hi' }], tools: [] }
    }),
    'agent.loop.continue': async () => ({ runId: 'run-vimg', phase: 'done', content: 'ok' })
  });
  await runRustAgentLoop({
    coreBridge: bridge,
    llm: { baseUrl: 'https://example/v1' },
    startParams: { model: 'm' },
    loopSpec: loopSpec(),
    browserVision: true,
    onPhase: (p) => phases.push(p),
    fetchLlmOnce: async ({ body }) => {
      llmCalls += 1;
      seen.push(snapshotMessages(body.messages));
      // 账本只有 1 条 → 下标 1 就是本轮临时追加的视觉注入消息
      if (llmCalls === 1) throw unsupportedImageError(1);
      return { content: 'ok', toolCalls: [] };
    }
  });

  assert(llmCalls === 2, 'vision rejection retried');
  assert(seen[0].length === 2 && carriesImagePart([seen[0][1]]), 'first attempt injected the screenshot');
  assert(seen[1].length === 1, 'retry no longer injects the rejected screenshot');
  assert(
    !bridge.invokes.some((i) => i.method === 'agent.loop.set_messages'),
    'temp vision message is not written back to the ledger'
  );
  assert(phases.includes('llm_images_dropped'), 'emits llm_images_dropped');
}

async function testNonImage400IsNotRepaired() {
  let llmCalls = 0;
  const bridge = createFakeBridge({
    'agent.loop.start': async () => ({
      runId: 'run-400',
      phase: 'need_llm',
      llmBody: { model: 'm', messages: [{ role: 'user', content: 'hi' }], tools: [] }
    })
  });
  let thrown = '';
  try {
    await runRustAgentLoop({
      coreBridge: bridge,
      llm: { baseUrl: 'https://example/v1' },
      startParams: { model: 'm' },
      loopSpec: loopSpec(),
      fetchLlmOnce: async () => {
        llmCalls += 1;
        const err = new Error('HTTP 400 invalid api key');
        err.statusCode = 400;
        throw err;
      }
    });
  } catch (err) {
    thrown = String(err && err.message);
  }
  assert(/invalid api key/.test(thrown), 'non-image 400 still surfaces to the caller');
  assert(llmCalls === 1, 'no repair retry for a non-image 400');
}

async function testVisionImageReadHelpers() {
  const { sniffImageMime, isVisionImageReadRequest } = require('../src/agent/tool-bridge-main');

  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]);
  const gif = Buffer.from('GIF89a............', 'latin1');
  const webp = Buffer.alloc(16);
  webp.write('RIFF', 0, 'latin1');
  webp.write('WEBP', 8, 'latin1');

  assert(sniffImageMime(png.toString('base64')) === 'image/png', 'sniff png');
  assert(sniffImageMime(jpeg.toString('base64')) === 'image/jpeg', 'sniff jpeg');
  assert(sniffImageMime(gif.toString('base64')) === 'image/gif', 'sniff gif');
  assert(sniffImageMime(webp.toString('base64')) === 'image/webp', 'sniff webp');
  assert(sniffImageMime(Buffer.from('hello, plain text payload').toString('base64')) === '', 'sniff rejects text');
  assert(sniffImageMime('') === '', 'sniff rejects empty');

  assert(
    isVisionImageReadRequest('fs_read_file', { filePath: 'a.png', encoding: 'base64' }),
    'base64 whole-file read is a vision read'
  );
  assert(
    !isVisionImageReadRequest('fs_read_file', { filePath: 'a.png' }),
    'utf8 read is not a vision read'
  );
  assert(
    !isVisionImageReadRequest('fs_read_file', { filePath: 'a.png', encoding: 'base64', offset: 100 }),
    'chunked read is not a vision read'
  );
  assert(!isVisionImageReadRequest('fs_edit', { encoding: 'base64' }), 'other tools are not vision reads');
}

async function testAbortDuringLlmCancelsSidecar() {
  const bridge = createFakeBridge({
    'agent.loop.start': async () => ({
      runId: 'run-a',
      phase: 'need_llm',
      llmBody: { model: 'm', messages: [{ role: 'user', content: 'hi' }] }
    }),
    'agent.loop.cancel': async () => ({ ok: true })
  });
  const ac = new AbortController();
  const p = runRustAgentLoop({
    coreBridge: bridge,
    llm: { baseUrl: 'https://example/v1' },
    startParams: { model: 'm' },
    loopSpec: loopSpec(),
    signal: ac.signal,
    fetchLlmOnce: async ({ signal }) => {
      await new Promise((_, reject) => {
        const fail = () => {
          const err = new Error('已停止');
          err.name = 'AbortError';
          reject(err);
        };
        if (signal?.aborted) fail();
        else signal.addEventListener('abort', fail, { once: true });
      });
    }
  });
  await sleep(20);
  ac.abort();
  await expectAbort(p);
  assert(
    bridge.abortPendingCalls.some((c) => c.runId === 'run-a'),
    'abortPending during LLM'
  );
  assert(
    bridge.invokes.some((i) => i.method === 'agent.loop.cancel'),
    'sidecar cancel during LLM'
  );
}

async function testAbortDuringContinueCancelsSidecar() {
  const bridge = createFakeBridge({
    'agent.loop.start': async () => ({
      runId: 'run-b',
      phase: 'need_llm',
      llmBody: { model: 'm', messages: [{ role: 'user', content: 'hi' }] }
    }),
    'agent.loop.continue': async () => new Promise(() => {}),
    'agent.loop.cancel': async () => ({ ok: true })
  });
  const ac = new AbortController();
  const p = runRustAgentLoop({
    coreBridge: bridge,
    llm: { baseUrl: 'https://example/v1' },
    startParams: { model: 'm' },
    loopSpec: loopSpec(),
    signal: ac.signal,
    fetchLlmOnce: async () => ({ content: 'ok', toolCalls: [] })
  });
  await sleep(30);
  ac.abort();
  await expectAbort(p);
  assert(
    bridge.abortPendingCalls.some((c) => c.runId === 'run-b'),
    'abortPending during continue'
  );
  assert(
    bridge.invokes.some((i) => i.method === 'agent.loop.cancel'),
    'sidecar cancel during continue'
  );
}

async function testAbortDuringCompactCancelsSidecar() {
  const messages = Array.from({ length: 25 }, (_, i) => ({ role: 'user', content: String(i) }));
  const bridge = createFakeBridge({
    'agent.loop.start': async () => ({
      runId: 'run-k',
      phase: 'need_llm',
      llmBody: { model: 'm', messages }
    }),
    'agent.loop.cancel': async () => ({ ok: true })
  });
  const ac = new AbortController();
  const p = runRustAgentLoop({
    coreBridge: bridge,
    llm: { baseUrl: 'https://example/v1' },
    startParams: { model: 'm' },
    loopSpec: loopSpec(),
    signal: ac.signal,
    compactMessages: async (_msgs, ctx) => {
      await new Promise((_, reject) => {
        const fail = () => {
          const err = new Error('已停止');
          err.name = 'AbortError';
          reject(err);
        };
        if (ctx.signal?.aborted) fail();
        else ctx.signal.addEventListener('abort', fail, { once: true });
      });
    },
    fetchLlmOnce: async () => {
      throw new Error('LLM should not run if compact aborted');
    }
  });
  await sleep(20);
  ac.abort();
  await expectAbort(p);
  assert(
    bridge.invokes.some((i) => i.method === 'agent.loop.cancel'),
    'sidecar cancel during compact'
  );
}

async function testOverflowStopsAfterOneCompact() {
  const messages = Array.from({ length: 25 }, (_, i) => ({ role: 'user', content: String(i) }));
  let compactCalls = 0;
  let llmCalls = 0;
  const bridge = createFakeBridge({
    'agent.loop.start': async () => ({
      runId: 'run-ov',
      phase: 'need_llm',
      llmBody: { model: 'm', messages, tools: [] }
    }),
    'agent.loop.set_messages': async () => ({ ok: true }),
    'agent.loop.cancel': async () => ({ ok: true })
  });
  const phases = [];
  const result = await runRustAgentLoop({
    coreBridge: bridge,
    llm: { baseUrl: 'https://example/v1' },
    startParams: { model: 'm' },
    loopSpec: loopSpec(),
    onPhase: (p) => phases.push(p),
    compactMessages: async (msgs) => {
      compactCalls += 1;
      return { compacted: true, messages: msgs.slice(0, 2), tokensBefore: 90, tokensAfter: 10 };
    },
    fetchLlmOnce: async () => {
      llmCalls += 1;
      const err = new Error('HTTP 400 prompt is too long');
      err.statusCode = 400;
      throw err;
    }
  });
  assert(result.overflowStopped === true, 'overflowStops turn');
  assert(result.phase === 'done', 'soft done');
  assert(compactCalls === 1, 'compact once');
  assert(llmCalls === 1, 'no second sample after overflow compact');
  assert(phases.includes('turn_overflow_stopped'), 'overflow phase');
  assert(
    bridge.invokes.some((i) => i.method === 'agent.loop.cancel'),
    'overflow stop cancels sidecar run'
  );
  assert(
    !bridge.invokes.some((i) => i.method === 'agent.loop.continue'),
    'no continue after overflow stop'
  );
}

async function testOverflowDoesNotTreatPartialAsSuccess() {
  const messages = Array.from({ length: 25 }, (_, i) => ({ role: 'user', content: String(i) }));
  const bridge = createFakeBridge({
    'agent.loop.start': async () => ({
      runId: 'run-ovp',
      phase: 'need_llm',
      llmBody: { model: 'm', messages, tools: [] }
    }),
    'agent.loop.set_messages': async () => ({ ok: true }),
    'agent.loop.cancel': async () => ({ ok: true }),
    'agent.loop.continue': async () => {
      throw new Error('overflow must not continue');
    }
  });
  const result = await runRustAgentLoop({
    coreBridge: bridge,
    llm: { baseUrl: 'https://example/v1' },
    startParams: { model: 'm' },
    loopSpec: loopSpec(),
    compactMessages: async (msgs) => ({
      compacted: true,
      messages: msgs.slice(0, 2),
      tokensBefore: 90,
      tokensAfter: 10
    }),
    fetchLlmOnce: async () => {
      const err = new Error('prompt is too long');
      err.partial = { content: 'x', reasoning: 'already thinking' };
      throw err;
    }
  });
  assert(result.overflowStopped === true, 'partial overflow still stops');
}

async function testUnknownPhase() {
  const bridge = createFakeBridge({
    'agent.loop.start': async () => ({ runId: 'run-u', phase: 'need_coffee' })
  });
  let threw = false;
  try {
    await runRustAgentLoop({
      coreBridge: bridge,
      llm: { baseUrl: 'https://example/v1' },
      startParams: { model: 'm' },
      loopSpec: loopSpec()
    });
  } catch (err) {
    threw = /未知阶段/.test(String(err && err.message));
  }
  assert(threw, 'unknown phase throws');
}

async function testTurnEndSynthesisSkippedByDefault() {
  let synthCalls = 0;
  const bridge = createFakeBridge({
    'agent.loop.start': async () => ({
      phase: 'done',
      runId: 'run-nosynth',
      content: '',
      hitRoundLimit: false,
      messages: [{ role: 'user', content: '修 bug' }],
      trace: [{ round: 1, thought: '读了文件', tools: [{ name: 'fs_read_file', args: {}, result: {} }] }]
    })
  });
  const result = await runRustAgentLoop({
    coreBridge: bridge,
    llm: { baseUrl: 'https://example/v1' },
    startParams: { model: 'm' },
    loopSpec: loopSpec(),
    fetchSynthesisOnce: async () => {
      synthCalls += 1;
      return { content: '不应调用' };
    }
  });
  assert(synthCalls === 0, 'planner/default path does not synthesize');
  assert(result.content === '', 'empty content unchanged');
}

async function testTurnEndSynthesisFillsEmptyReply() {
  const phases = [];
  const bridge = createFakeBridge({
    'agent.loop.start': async () => ({
      phase: 'done',
      runId: 'run-synth',
      content: '',
      hitRoundLimit: false,
      messages: [{ role: 'user', content: '修 login' }],
      trace: [{ round: 1, thought: '短', tools: [{ name: 'fs_edit', args: {}, result: {} }] }]
    })
  });
  const result = await runRustAgentLoop({
    coreBridge: bridge,
    llm: { baseUrl: 'https://example/v1' },
    startParams: { model: 'm' },
    loopSpec: loopSpec(),
    turnEndSynthesis: true,
    onPhase: (p) => phases.push(p),
    fetchSynthesisOnce: async () => ({ content: '已改 login 校验，失败时保留快照。' })
  });
  assert(result.content.includes('login'), 'synthesis fills empty reply');
  assert(phases.includes('synthesis_start'), 'synthesis_start phase');
  assert(phases.includes('synthesis_done'), 'synthesis_done phase');
  assert(
    Array.isArray(result.trace) && result.trace.some((r) => r.phase === '汇总'),
    'trace has 汇总 round'
  );
}

// 截断 + 只有思考：带标签交付思考原文，不再花一轮 LLM；该标签只用于展示，不写进 book。
async function testTurnEndTruncatedUsesReasoningFallback() {
  let synthCalls = 0;
  const longThought =
    '已经把 BrowserView 截图失败改成可重试，并在观察失败时保留文本快照，气泡在循环返回后立刻收成已完成。';
  const bridge = createFakeBridge({
    'agent.loop.start': async () => ({
      phase: 'done',
      runId: 'run-thought',
      content: '',
      hitRoundLimit: true,
      messages: [{ role: 'user', content: '修截图' }],
      trace: [{ round: 1, thought: longThought, tools: [{ name: 'fs_edit', args: {}, result: {} }] }]
    })
  });
  const result = await runRustAgentLoop({
    coreBridge: bridge,
    llm: { baseUrl: 'https://example/v1' },
    startParams: { model: 'm' },
    loopSpec: loopSpec(),
    turnEndSynthesis: true,
    fetchSynthesisOnce: async () => {
      synthCalls += 1;
      return { content: '不应调用' };
    }
  });
  assert(synthCalls === 0, 'truncated turn with only reasoning skips synthesis LLM');
  assert(isReasoningFallbackText(result.content), 'truncated turn labels reasoning as delivery');
  assert(result.content.includes(longThought), 'reasoning 原文进入交付文本');
  assert(
    persistableTurnText(result.content) === TURN_EMPTY_REPLY_TEXT,
    'reasoning-fallback 不写进 book（落库换成占位）'
  );
}

// 正常收尾 + 无正文 + 有思考：走汇总链路，不再用思考顶替正文（A3 反转）。
// 同时校验 D3 契约（docs/REASONING-ISOLATION-PLAN.md §3.7）：**汇总 LLM 的输入只允许工具事实**，
// 不得把思考喂进去 —— 否则「写用户可见正文」这一步会把私有推理间接写进答复。
async function testTurnEndThoughtDefersToSynthesis() {
  let synthCalls = 0;
  let synthBody = null;
  const longThought =
    '已经把 BrowserView 截图失败改成可重试，并在观察失败时保留文本快照，气泡在循环返回后立刻收成已完成。';
  const bridge = createFakeBridge({
    'agent.loop.start': async () => ({
      phase: 'done',
      runId: 'run-thought-norm',
      content: '',
      hitRoundLimit: false,
      messages: [{ role: 'user', content: '修截图' }],
      trace: [{ round: 1, thought: longThought, tools: [{ name: 'fs_edit', args: {}, result: {} }] }]
    })
  });
  const result = await runRustAgentLoop({
    coreBridge: bridge,
    llm: { baseUrl: 'https://example/v1' },
    startParams: { model: 'm' },
    loopSpec: loopSpec(),
    turnEndSynthesis: true,
    fetchSynthesisOnce: async ({ body }) => {
      synthCalls += 1;
      synthBody = body;
      return { content: '已改截图重试并保留快照。' };
    }
  });
  assert(synthCalls === 1, 'normal finish with only reasoning defers to synthesis');
  assert(result.content === '已改截图重试并保留快照。', 'synthesis output becomes delivery');
  assert(!isReasoningFallbackText(result.content), '汇总结果不是思考回退标签');

  const synthPrompt = JSON.stringify(synthBody || {});
  assert(synthPrompt.includes('fs_edit'), '汇总输入带工具事实');
  assert(!synthPrompt.includes(longThought), '汇总输入不含思考（D3：写正文的输入只允许事实）');
  assert(!synthPrompt.includes('BrowserView'), '思考正文片段不进入汇总输入');
}

async function testTurnEndKeepsModelProse() {
  let synthCalls = 0;
  const bridge = createFakeBridge({
    'agent.loop.start': async () => ({
      phase: 'done',
      runId: 'run-keep',
      content: '已完成。',
      hitRoundLimit: false,
      messages: [{ role: 'user', content: '修' }],
      trace: [{ round: 1, thought: 'x', tools: [{ name: 'fs_edit', args: {}, result: {} }] }]
    })
  });
  const result = await runRustAgentLoop({
    coreBridge: bridge,
    llm: { baseUrl: 'https://example/v1' },
    startParams: { model: 'm' },
    loopSpec: loopSpec(),
    turnEndSynthesis: true,
    fetchSynthesisOnce: async () => {
      synthCalls += 1;
      return { content: '不应调用' };
    }
  });
  assert(synthCalls === 0, 'non-empty reply skips synthesis');
  assert(result.content === '已完成。', 'keeps short model prose');
}

function testBackfillReasoningContent() {
  const legacy = [
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'tc1', function: { name: 'read', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'tc1', content: 'ok' }
  ];
  const out = backfillReasoningContent(legacy, false);
  assert(out !== legacy, 'backfill returns mapped array when needed');
  assert(
    typeof out[1].reasoning_content === 'string' && out[1].reasoning_content.trim(),
    'legacy tool-call assistant gets placeholder reasoning_content'
  );
  assert(out[0] === legacy[0] && out[2] === legacy[2], 'untouched messages keep identity');
  assert(legacy[1].reasoning_content === undefined, 'original array not mutated');

  const plain = [
    { role: 'user', content: 'task' },
    { role: 'assistant', content: 'previous answer' }
  ];
  assert(backfillReasoningContent(plain, false) === plain, 'plain assistant untouched without tools');
  const withTools = backfillReasoningContent(plain, true);
  assert(withTools !== plain, 'tools request rewrites plain assistant history');
  assert(
    typeof withTools[1].reasoning_content === 'string' && withTools[1].reasoning_content.trim(),
    'plain assistant gets placeholder when request carries tools'
  );
  assert(withTools[0] === plain[0], 'user message untouched');

  const fresh = [
    { role: 'assistant', content: '', reasoning_content: 'real thought', tool_calls: [{ id: 'tc2', function: { name: 'x', arguments: '{}' } }] },
    { role: 'assistant', content: 'answer', reasoning_content: 'kept thought' }
  ];
  assert(backfillReasoningContent(fresh, true) === fresh, 'no rewrite when reasoning present');
  assert(backfillReasoningContent(undefined, true) === undefined, 'undefined passes through');

  // 真值优先：账本 `reasoning`（与 content 分列）直接作为 reasoning_content 回传，不落占位。
  const book = [
    { role: 'user', content: 'hi' },
    {
      role: 'assistant',
      content: '',
      reasoning: '  账本真思考  ',
      tool_calls: [{ id: 'tc3', function: { name: 'read', arguments: '{}' } }]
    }
  ];
  const echoed = backfillReasoningContent(book, false);
  assert(echoed !== book, 'book reasoning triggers rewrite');
  assert(echoed[1].reasoning_content === '账本真思考', 'book reasoning becomes reasoning_content truth');
  assert(echoed[1].reasoning === undefined, 'internal reasoning field stripped before upstream');
  assert(book[1].reasoning === '  账本真思考  ' && book[1].reasoning_content === undefined, 'original not mutated');
  assert(echoed[0] === book[0], 'user message keeps identity');

  // 无 tool_calls 的普通回复轮：脱工具默认不回传，但要剥掉账本内部字段。
  const plainBook = [{ role: 'assistant', content: 'answer', reasoning: '思考' }];
  const plainOut = backfillReasoningContent(plainBook, false);
  assert(plainOut[0].reasoning === undefined, 'book field stripped even when not echoing');
  assert(plainOut[0].reasoning_content === undefined, 'no reasoning_content without tools');

  // echoReasoning（能力表声明）时才脱工具也回传。
  const echoOn = backfillReasoningContent(plainBook, false, true);
  assert(echoOn[0].reasoning_content === '思考', 'echoReasoning forces echo without tools');

  // 真值不可得 + 需要回传 → 占位兜底。
  const noTruth = [
    { role: 'assistant', content: '', tool_calls: [{ id: 'tc4', function: { name: 'x', arguments: '{}' } }] }
  ];
  assert(
    backfillReasoningContent(noTruth, false)[0].reasoning_content === REASONING_PLACEHOLDER,
    'placeholder only when truth unavailable'
  );
}

async function run() {
  testApplyResolvedLoopSpec();
  testShouldCompactRound();
  testResolveChatUrl();
  testNormalizeLlmResponse();
  testBackfillReasoningContent();
  await testLlmOnlyRound();
  await testContentChannelReachesLedger();
  await testCompactThenContinue();
  await testCompactTimeoutContinuesLoop();
  await testCompactSkippedResultContinuesLoop();
  await testSkipCompactOnShortFirstRound();
  await testDelegateRound();
  await testBrowserVisionInjection();
  await testVisionSurvivesOverflowRetry();
  await testImageRejectedRoundIsRepaired();
  await testRejectedImageWithoutUsableIndexDropsAll();
  await testRejectedVisionMessageIsNotReinjected();
  await testNonImage400IsNotRepaired();
  await testVisionImageReadHelpers();
  await testAbortDuringLlmCancelsSidecar();
  await testAbortDuringContinueCancelsSidecar();
  await testAbortDuringCompactCancelsSidecar();
  await testOverflowStopsAfterOneCompact();
  await testOverflowDoesNotTreatPartialAsSuccess();
  await testUnknownPhase();
  await testTurnEndSynthesisSkippedByDefault();
  await testTurnEndSynthesisFillsEmptyReply();
  await testTurnEndTruncatedUsesReasoningFallback();
  await testTurnEndThoughtDefersToSynthesis();
  await testTurnEndKeepsModelProse();
}

run()
  .then(() => {
    console.log('test-rust-loop-runner.cjs ok');
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });

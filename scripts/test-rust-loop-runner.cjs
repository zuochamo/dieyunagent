'use strict';

/**
 * Node 侧 agent loop 编排（**驱动者已换成 core**，无需 dieyun-core / 真 LLM）。
 * Run: node scripts/test-rust-loop-runner.cjs
 *
 * 新契约（docs/AGENT-RUN-MIGRATION.md §2）：
 *   - `agent.run.start` / `agent.run.tools` 是**唯一**的轮次 RPC；
 *   - `runId` 由宿主生成并透传（core 在 start 内部就推 `agent.delta`，订阅必须先于 start）；
 *   - 流式增量经事件通道回来，Node 只做「增量 → 累积值」的搬运；
 *   - 工具仍在 Node 执行，结果经 `agent.run.tools` 回填；
 *   - Node **不许**再调 `agent.llm.chat` / `agent.loop.*`。
 */

// 视觉注入走反向调用 `round.prepare`（core 每轮发请求前问宿主），runId 由宿主生成 ——
// 测试无从预知 runId，故先替换取样口，把「待注入图片」直接喂给 runner
// （browser-vision 自身行为另有用例覆盖）。
const bv = require('../src/agent/browser-vision');
const realTakeVisionImages = bv.takePendingVisionImages;
/** @type {{ images: object[] } | null} */
let visionFeed = null;
let visionTakeCalls = 0;
bv.takePendingVisionImages = (runId) => {
  visionTakeCalls += 1;
  if (visionFeed) return visionFeed.images.splice(0);
  return realTakeVisionImages(runId);
};

const {
  runRustAgentLoop,
  resolveChatUrl,
  applyResolvedLoopSpec,
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

/** 所有用例共用的兜底：取消入口（不进 handlers 时也能被调用）。 */
const BRIDGE_DEFAULTS = {
  'agent.run.cancel': async () => ({ ok: true })
};

function createFakeBridge(handlers = {}) {
  const invokes = [];
  const abortPendingCalls = [];
  const listeners = new Set();
  /** core 反向调用的 handler 表（method → fn），与 `coreBridge.onCoreCall` 同语义。 */
  const coreCallHandlers = new Map();
  /** 出站时序（`onCoreCall:xxx` / `invoke:xxx` 混排）：用来钉「先注册、后发请求」。 */
  const timeline = [];
  let listenerCount = 0;
  const bridge = {
    invokes,
    abortPendingCalls,
    timeline,
    get coreCallMethods() {
      return [...coreCallHandlers.keys()];
    },
    get coreCallHandlerCount() {
      return coreCallHandlers.size;
    },
    /** core → 宿主反向调用：注册（返回退订器），与真 bridge 一致。 */
    onCoreCall(method, handler) {
      timeline.push(`onCoreCall:${method}`);
      coreCallHandlers.set(String(method), handler);
      return () => {
        coreCallHandlers.delete(String(method));
      };
    },
    /** 测试专用：模拟 core 发起一次反向调用，拿到宿主 handler 的答复。 */
    async callCore(method, params) {
      const fn = coreCallHandlers.get(String(method));
      if (typeof fn !== 'function') throw new Error(`宿主没注册 ${method}`);
      return fn(params);
    },
    /** 事件订阅峰值（末轮订阅必须退订：否则长会话会攒下无数监听器）。 */
    get listenerCount() {
      return listeners.size;
    },
    get totalSubscriptions() {
      return listenerCount;
    },
    abortPending(payload) {
      abortPendingCalls.push(payload);
    },
    onCoreEvent(listener) {
      listenerCount += 1;
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    /** 测试专用：模拟 core 推事件（增量，与真 core 一致）。 */
    emitEvent(event) {
      for (const fn of [...listeners]) fn(event);
    },
    async invoke(method, params, timeout) {
      timeline.push(`invoke:${method}`);
      invokes.push({ method, params, timeout });
      const handler = handlers[method] || BRIDGE_DEFAULTS[method];
      if (typeof handler !== 'function') {
        throw new Error(
          `unexpected invoke ${method}（新契约只允许 agent.run.*；旧 ${method} 不该再被调用）`
        );
      }
      return handler(params, timeout, bridge);
    }
  };
  return bridge;
}

function loopSpec() {
  return { maxToolCalls: 8 };
}

/** 旧 RPC 一个都不许出现：两条驱动者同时存在 = 两份轮次语义。 */
function assertNoLegacyRpc(bridge) {
  const bad = bridge.invokes
    .map((i) => i.method)
    .filter((m) => String(m).startsWith('agent.loop.') || m === 'agent.llm.chat');
  assert(bad.length === 0, `不该再调用旧 RPC：${bad.join(', ')}`);
}

function methodsOf(bridge) {
  return bridge.invokes.map((i) => i.method).join(',');
}

async function expectAbort(promise) {
  try {
    await promise;
    throw new Error('expected AbortError');
  } catch (err) {
    assert(err && err.name === 'AbortError', `expected AbortError, got ${err && err.name}: ${err && err.message}`);
  }
}

// ---------------------------------------------------------------- 纯函数

function testApplyResolvedLoopSpec() {
  const filled = applyResolvedLoopSpec({ model: 'm' }, { maxToolCalls: 12 });
  assert(filled.maxToolCalls === 12, 'fill missing maxToolCalls');
  const kept = applyResolvedLoopSpec({ maxToolCalls: 3 }, { maxToolCalls: 12 });
  assert(kept.maxToolCalls === 3, 'keep explicit maxToolCalls');
  const emptySpec = applyResolvedLoopSpec({ model: 'm' }, {});
  assert(!Object.prototype.hasOwnProperty.call(emptySpec, 'maxToolCalls'), 'do not write undefined maxToolCalls');
  const nullSpec = applyResolvedLoopSpec({ model: 'm' }, { maxToolCalls: undefined });
  assert(!Object.prototype.hasOwnProperty.call(nullSpec, 'maxToolCalls'), 'ignore undefined resolved value');
  // 折叠预算仍在唯一填参口注入（数字来自 compaction-main.resolveFoldSpec）
  const folded = applyResolvedLoopSpec({ model: 'm' }, {}, { tokenBudget: 9000, triggerRatio: 0.8 });
  assert(folded.tokenBudget === 9000 && folded.triggerRatio === 0.8, 'fold budget injected once');
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
  assert(echoed[1].reasoning_content === '账本真思考', 'book reasoning becomes reasoning_content truth');
  assert(echoed[1].reasoning === undefined, 'internal reasoning field stripped before upstream');
  assert(book[1].reasoning === '  账本真思考  ' && book[1].reasoning_content === undefined, 'original not mutated');

  const noTruth = [
    { role: 'assistant', content: '', tool_calls: [{ id: 'tc4', function: { name: 'x', arguments: '{}' } }] }
  ];
  assert(
    backfillReasoningContent(noTruth, false)[0].reasoning_content === REASONING_PLACEHOLDER,
    'placeholder only when truth unavailable'
  );
}

// ---------------------------------------------------------------- 新契约

/**
 * start 契约 + 增量转发：这条钉住整个迁移最容易踩的一脚。
 *
 * `runId` 必须是**宿主**生成并透传（core 拿它给事件打归属），事件订阅必须在 start 之前，
 * 增量要累积成 UI 要的累计值，别的 run 的事件不能被吞。
 */
async function testStartContractAndDeltaAccumulation() {
  const phases = [];
  const deltas = [];
  let startParams = null;
  let hostRunIdSeenInEvents = [];
  const bridge = createFakeBridge({
    'agent.run.start': async (params, _timeout, br) => {
      startParams = params;
      // core 在 start **内部**就推增量（真 core 与这里一致：推的是增量，不是累计值）
      br.emitEvent({ type: 'agent.delta', runId: params.runId, round: 0, content: '你', reasoning: null });
      br.emitEvent({ type: 'agent.delta', runId: params.runId, round: 0, content: '好', reasoning: '想' });
      // 别的 run 的噪音：绝不能混进来
      br.emitEvent({ type: 'agent.delta', runId: 'run-someone-else', round: 0, content: '噪音' });
      br.emitEvent({ type: 'other.event', runId: params.runId, content: '无关事件' });
      hostRunIdSeenInEvents.push(params.runId);
      return { phase: 'done', runId: params.runId, content: '你好', trace: [] };
    }
  });

  const result = await runRustAgentLoop({
    coreBridge: bridge,
    llm: { baseUrl: 'https://example/v1', apiKey: 'k', headers: { 'x-session': 's1' }, authMode: 'bearer' },
    startParams: { model: 'm', messages: [{ role: 'user', content: 'hi' }], tools: [] },
    loopSpec: loopSpec(),
    onPhase: (p, data) => {
      phases.push(p);
      if (p === 'llm_delta') deltas.push(data);
    }
  });

  assert(startParams, '必须走 agent.run.start');
  assert(/^run-\d+-[a-z0-9]+$/.test(String(startParams.runId)), `runId 形如 run-<时间戳>-<随机>：${startParams.runId}`);
  assert(startParams.runId === hostRunIdSeenInEvents[0], 'runId 由宿主生成并透传给 core');
  assert(startParams.url === 'https://example/v1/chat/completions', `端点拼接：${startParams.url}`);
  assert(startParams.stream === true, '流式由宿主声明');
  assert(startParams.contentChannel === 'answer', 'contentChannel 由能力表声明');
  assert(
    startParams.llm && startParams.llm.headers && startParams.llm.headers['x-session'] === 's1',
    '请求头由 Node 装配后随 llm 透传（core 不推导）'
  );
  assert(startParams.llm.authMode === 'bearer', 'llm.authMode 透传');
  assert(startParams.model === 'm' && Array.isArray(startParams.messages), 'startParams 业务字段原样透传');
  const startInvoke = bridge.invokes.find((i) => i.method === 'agent.run.start');
  assert(startInvoke.timeout === undefined, 'RPC 超时不由 runner 传（core-rpc-timeouts 是唯一来源）');

  assert(deltas.length >= 2, '每个增量都要推给 UI');
  assert(deltas[0].content === '你', '第一条是增量');
  assert(deltas[deltas.length - 1].content === '你好', 'UI 拿到的是累积值');
  assert(deltas[deltas.length - 1].reasoning === '想', '思考通道同样累积');
  assert(deltas[deltas.length - 1].contentChannel === 'answer', '增量带 contentChannel');
  assert(!deltas.some((d) => String(d.content || '').includes('噪音')), '别的 run 的增量不能混进来');
  assert(!phases.includes('other.event'), '非 agent.delta 事件不转发');

  assert(result.phase === 'done', 'done 结果原样返回');
  assert(phases.includes('start') && phases.includes('llm_request') && phases.includes('llm_response'), '相位齐全');
  assert(phases.includes('done'), 'done 相位');
  assertNoLegacyRpc(bridge);
}

/**
 * core 现在推的增量是 `round: null`（`LoopResponse` 不暴露 round）：
 * 宿主必须用**本地轮次计数**补上，否则 UI 的思考/正文会全落到同一行。
 */
async function testDeltaWithoutRoundUsesLocalCounter() {
  const deltas = [];
  const bridge = createFakeBridge({
    'agent.run.start': async (params, _t, br) => {
      // 第一轮：core 不带 round
      br.emitEvent({ type: 'agent.delta', runId: params.runId, round: null, content: '第一轮' });
      return {
        phase: 'need_tools',
        runId: params.runId,
        delegates: [{ id: 'c1', name: 'fs_read_file', arguments: { filePath: 'a.txt' } }]
      };
    },
    'agent.run.tools': async (params, _t, br) => {
      // 第二轮同一次 run：依旧不带 round
      br.emitEvent({ type: 'agent.delta', runId: params.runId, round: null, content: '第二轮' });
      return { phase: 'done', runId: params.runId, content: '第二轮', trace: [] };
    }
  });
  await runRustAgentLoop({
    coreBridge: bridge,
    llm: { baseUrl: 'https://example/v1' },
    startParams: { model: 'm', messages: [], tools: [] },
    loopSpec: loopSpec(),
    delegateTool: async () => ({ ok: true }),
    onPhase: (p, d) => {
      if (p === 'llm_delta') deltas.push(d);
    }
  });
  assert(deltas.length >= 2, '两轮都要有增量');
  assert(deltas[0].round === 0, `round 缺省时用本地计数 0，实际 ${deltas[0].round}`);
  assert(deltas[deltas.length - 1].round === 1, `第二轮应为 1，实际 ${deltas[deltas.length - 1].round}`);
  assert(
    deltas.filter((d) => d.round === 0).every((d) => !String(d.content).includes('第二轮')),
    '第二轮的累积值不能落回第一轮的行'
  );
}

/**
 * 工具轮也能带折叠事实：`need_tools` 响应上的 `compacted` 同样要走
 * phase / 遥测 / 归档（不能只在 done 上处理，否则工具轮之前的折叠全丢）。
 */
async function testFoldFactOnNeedToolsIsHandled() {
  const phases = [];
  const archived = [];
  const bridge = createFakeBridge({
    'agent.run.start': async (params) => ({
      phase: 'need_tools',
      runId: params.runId,
      delegates: [{ id: 'c1', name: 'fs_read_file', arguments: { filePath: 'a.txt' } }],
      compacted: {
        level: 1,
        tokensBefore: 12_000,
        tokensAfter: 3_000,
        triggerSource: 'usage',
        foldedToolResults: 2,
        foldedTexts: 0,
        foldedImages: 0
      }
    }),
    'agent.run.tools': async (params) => ({ phase: 'done', runId: params.runId, content: 'ok', trace: [] })
  });
  await runRustAgentLoop({
    coreBridge: bridge,
    llm: { baseUrl: 'https://example/v1' },
    startParams: { model: 'm', messages: [], tools: [] },
    loopSpec: loopSpec(),
    delegateTool: async () => ({ ok: true }),
    onPhase: (p, d) => {
      if (p === 'compacted') phases.push(d);
    },
    compactMessages: Object.assign(async () => ({ compacted: false }), {
      archiveFold: async (fact) => {
        archived.push(fact);
        return 1;
      }
    })
  });
  assert(phases.length === 1, `工具轮前的折叠事实也要上报，实际 ${phases.length} 次`);
  assert(phases[0].tokensBefore === 12_000, 'compacted 相位带 core 的事实');
  assert(archived.length === 1 && archived[0].level === 1, '工具轮前的折叠也要归档');
}

/**
 * 工具轮：need_tools → Node 执行 → `agent.run.tools` 回填 → 直到 done。
 */
async function testToolsAreExecutedAndBackfilled() {
  let round = 0;
  let toolsParams = null;
  let startRunId = null;
  const phases = [];
  const bridge = createFakeBridge({
    'agent.run.start': async (params) => {
      round += 1;
      startRunId = params.runId;
      return {
        phase: 'need_tools',
        runId: params.runId,
        delegates: [{ id: 'c1', name: 'fs_read_file', arguments: { filePath: 'a.txt' } }]
      };
    },
    'agent.run.tools': async (params) => {
      round += 1;
      toolsParams = params;
      return { phase: 'done', runId: params.runId, content: 'done', trace: [] };
    }
  });

  const result = await runRustAgentLoop({
    coreBridge: bridge,
    llm: { baseUrl: 'https://example/v1' },
    startParams: { model: 'm', messages: [], tools: [] },
    loopSpec: loopSpec(),
    onPhase: (p) => phases.push(p),
    delegateTool: async (name, args) => {
      assert(name === 'fs_read_file', 'tool name');
      assert(args.filePath === 'a.txt', 'tool args');
      return { text: 'hello' };
    }
  });

  assert(result.phase === 'done', 'delegate done');
  assert(methodsOf(bridge) === 'agent.run.start,agent.run.tools', `只许两条驱动 RPC，实际 ${methodsOf(bridge)}`);
  assert(toolsParams, '必须回填工具结果');
  assert(toolsParams.runId === startRunId, '回填用同一个 runId');
  assert(Array.isArray(toolsParams.results) && toolsParams.results.length === 1, 'one result');
  assert(toolsParams.results[0].id === 'c1', 'result id');
  assert(toolsParams.results[0].result && toolsParams.results[0].result.text === 'hello', 'tool body 被回填');
  assert(toolsParams.url === 'https://example/v1/chat/completions', 'tools 也要带 url');
  assert(toolsParams.contentChannel === 'answer', 'tools 也要带 contentChannel');
  for (const p of ['delegate_start', 'delegate_result', 'llm_response']) {
    assert(phases.includes(p), `缺相位 ${p}`);
  }
  assertNoLegacyRpc(bridge);
}

/** 单通道模型（mimo）：`content` 键即思考 —— 入口盖章为 `reasoning`，core 据此分列。 */
async function testContentChannelStampedFromCapabilityTable() {
  for (const [model, expected] of [
    ['m', 'answer'],
    ['mimo-v2.5-pro', 'reasoning']
  ]) {
    let seen = null;
    const deltas = [];
    const bridge = createFakeBridge({
      'agent.run.start': async (params, _t, br) => {
        seen = params;
        br.emitEvent({ type: 'agent.delta', runId: params.runId, content: '想' });
        return { phase: 'done', runId: params.runId, content: '', trace: [] };
      }
    });
    await runRustAgentLoop({
      coreBridge: bridge,
      llm: { baseUrl: 'https://example/v1' },
      startParams: { model, messages: [], tools: [] },
      loopSpec: loopSpec(),
      onPhase: (p, d) => {
        if (p === 'llm_delta') deltas.push(d);
      }
    });
    assert(seen && seen.contentChannel === expected, `contentChannel for ${model}: got ${seen && seen.contentChannel}`);
    assert(
      deltas.length && deltas[deltas.length - 1].contentChannel === expected,
      `llm_delta 也要带 contentChannel: ${model}`
    );
  }
}

/**
 * 折叠事实：core 折完把事实交上来，Node 只推 UI / 记遥测 / 写归档 —— 不再回写账本。
 */
async function testFoldFactDrivesNodeSideEffects() {
  const archiveCalls = [];
  const phases = [];
  const bridge = createFakeBridge({
    'agent.run.start': async (params) => ({
      phase: 'done',
      runId: params.runId,
      content: 'ok',
      trace: [],
      compacted: {
        level: 2,
        tokensBefore: 90_000,
        tokensAfter: 9_000,
        triggerSource: 'usage',
        foldedToolResults: 3,
        foldedTexts: 1,
        foldedImages: 0
      }
    })
  });
  await runRustAgentLoop({
    coreBridge: bridge,
    llm: { baseUrl: 'https://example/v1' },
    startParams: { model: 'm' },
    loopSpec: loopSpec(),
    onPhase: (p, data) => {
      phases.push(p);
      if (p === 'compacted') archiveCalls.push(data);
    },
    compactMessages: Object.assign(async () => ({ compacted: false }), {
      archiveFold: async (fact) => {
        assert(fact.level === 2, 'archive 拿到的是 core 的事实');
        return 77;
      }
    })
  });
  assert(phases.includes('compacted'), 'compacted phase 由事实驱动');
  assert(archiveCalls.length === 1 && archiveCalls[0].tokensBefore === 90_000, '归档拿到事实');
  assert(
    !bridge.invokes.some((i) => i.method === 'agent.loop.set_messages' || i.method === 'agent.loop.fold'),
    'Node 不再改写账本、也不再自己触发折叠'
  );
  assertNoLegacyRpc(bridge);
}

/**
 * `round.prepare`：core 每轮发请求前问宿主「这一次的 messages 长什么样」。
 *
 * 三件事必须成立：
 * 1. handler 在 `agent.run.start` **之前**注册，跑完（finally）退订；
 * 2. 视觉注入**逐轮**发生（不再是回合开始一次性），交出去的是**请求用副本**；
 * 3. handler 返回的 messages **不会**被 Node 拿去当账本 —— Node 没有账本写入口。
 */
async function testRoundPrepareRegisteredBeforeStart() {
  const bridge = createFakeBridge({
    'agent.run.start': async (params) => {
      assert(
        bridge.coreCallMethods.includes('round.prepare'),
        `start 之前必须已注册 round.prepare：${bridge.timeline.join(',')}`
      );
      return { phase: 'done', runId: params.runId, content: 'ok', trace: [] };
    }
  });
  await runRustAgentLoop({
    coreBridge: bridge,
    llm: { baseUrl: 'https://example/v1' },
    startParams: { model: 'm', messages: [{ role: 'user', content: 'hi' }] },
    loopSpec: loopSpec()
  });

  const regIdx = bridge.timeline.indexOf('onCoreCall:round.prepare');
  const startIdx = bridge.timeline.indexOf('invoke:agent.run.start');
  assert(regIdx >= 0, `round.prepare 必须被注册：${bridge.timeline.join(',')}`);
  assert(startIdx > regIdx, `注册必须早于 agent.run.start：${bridge.timeline.join(',')}`);
  assert(bridge.coreCallHandlerCount === 0, 'run 结束（finally）必须退订 round.prepare');
}

/** 逐轮注入：两轮各有一次反向调用，各自拿到「账本 + 本轮新图」的请求副本。 */
async function testRoundPrepareInjectsPerRoundOnRequestCopy() {
  visionTakeCalls = 0;
  const phases = [];
  /** core 视角的账本（宿主导入不了它，只能拿副本）。 */
  let ledger = [{ role: 'user', content: '看图' }];
  /** 模拟 core 每轮真正发出去的请求 messages。 */
  const sent = [];
  const bridge = createFakeBridge({
    'agent.run.start': async (params) => {
      visionFeed = { images: [{ source: 'browser', mime: 'image/png', base64: 'AAAA' }] };
      const reply = await bridge.callCore('round.prepare', {
        runId: params.runId,
        round: 0,
        messages: ledger
      });
      sent.push(reply.messages);
      assert(reply.visionInjected === 1, `第一轮注入 1 张，实际 ${reply.visionInjected}`);
      assert(ledger.length === 1, '账本不该被宿主改写（只交请求副本）');
      return {
        phase: 'need_tools',
        runId: params.runId,
        delegates: [{ id: 'c1', name: 'browser_screenshot', arguments: {} }]
      };
    },
    'agent.run.tools': async (params) => {
      ledger = [
        ...ledger,
        { role: 'assistant', content: '' },
        { role: 'tool', content: 'shot' }
      ];
      visionFeed = {
        images: [{ source: 'attachment', mime: 'image/png', base64: 'BBBB', path: 'b.png' }]
      };
      const reply = await bridge.callCore('round.prepare', {
        runId: params.runId,
        round: 1,
        messages: ledger
      });
      sent.push(reply.messages);
      assert(reply.visionInjected === 1, '第二轮也要能注入（逐轮，不再是回合开始一次性）');
      return { phase: 'done', runId: params.runId, content: 'ok', trace: [] };
    }
  });
  try {
    await runRustAgentLoop({
      coreBridge: bridge,
      llm: { baseUrl: 'https://example/v1' },
      startParams: { model: 'm', messages: [{ role: 'user', content: '看图' }] },
      loopSpec: loopSpec(),
      browserVision: true,
      onPhase: (p) => phases.push(p),
      delegateTool: async () => ({ ok: true })
    });
  } finally {
    visionFeed = null;
  }

  assert(sent.length === 2, '两轮请求都要走 round.prepare');
  assert(visionTakeCalls === 2, `逐轮各取样一次，实际 ${visionTakeCalls}`);
  assert(sent[0].length === 2, `第一轮副本 = 账本 1 条 + 视觉 1 条，实际 ${sent[0].length}`);
  const visionMsg = sent[0][sent[0].length - 1];
  assert(visionMsg.role === 'user', 'vision message uses user role');
  assert(
    Array.isArray(visionMsg.content) && visionMsg.content.some((p) => p.type === 'image_url'),
    'vision message carries image_url part'
  );
  assert(sent[1].length === 4, `第二轮副本 = 账本 3 条 + 视觉 1 条，实际 ${sent[1].length}`);
  assert(sent[1][0].role === 'user' && sent[1][2].role === 'tool', '账本顺序原样保留');
  assert(phases.includes('browser_vision_injected'), 'emits browser_vision_injected');
  assert(phases.includes('attachment_vision_injected'), 'emits attachment_vision_injected');
  // Node 没有账本写入口：agent.loop.* 一个都不该出现
  assertNoLegacyRpc(bridge);
}

async function testVisionDisabledNoInjection() {
  visionTakeCalls = 0;
  visionFeed = { images: [{ source: 'browser', mime: 'image/png', base64: 'AAAA' }] };
  let startParams = null;
  let prepared = null;
  const bridge = createFakeBridge({
    'agent.run.start': async (params) => {
      startParams = params;
      // 非多模态：core 照样会问，宿主必须原样还回去（不取图、不谎报张数）
      prepared = await bridge.callCore('round.prepare', {
        runId: params.runId,
        round: 0,
        messages: params.messages
      });
      return { phase: 'done', runId: params.runId, content: 'ok', trace: [] };
    }
  });
  try {
    await runRustAgentLoop({
      coreBridge: bridge,
      llm: { baseUrl: 'https://example/v1' },
      startParams: { model: 'm', messages: [{ role: 'user', content: 'hi' }] },
      loopSpec: loopSpec()
    });
  } finally {
    visionFeed = null;
  }
  assert(startParams.messages.length === 1, 'no injection when browserVision disabled');
  assert(visionTakeCalls === 0, '未开启视觉时连取样都不该发生');
  assert(prepared && prepared.messages.length === 1, '拿不到视觉能力时原样返回 messages');
  assert(!('visionInjected' in prepared), '拿不到视觉能力时不该报注入张数');
}

// ---------------------------------------------------------------- 取消 / 溢出 / 异常

async function testAbortDuringRunCancelsViaRunCancel() {
  const bridge = createFakeBridge({
    'agent.run.start': () => new Promise(() => {})
  });
  const ac = new AbortController();
  const p = runRustAgentLoop({
    coreBridge: bridge,
    llm: { baseUrl: 'https://example/v1' },
    startParams: { model: 'm' },
    loopSpec: loopSpec(),
    signal: ac.signal
  });
  await sleep(20);
  ac.abort();
  await expectAbort(p);
  const runId = bridge.invokes[0].params.runId;
  assert(runId, 'start 必须带宿主生成的 runId');
  assert(
    bridge.abortPendingCalls.some((c) => c.runId === runId),
    'abortPending 用 runId 就地 settle 在途 RPC'
  );
  assert(
    bridge.invokes.some((i) => i.method === 'agent.run.cancel' && i.params.runId === runId),
    '取消走 agent.run.cancel'
  );
  assert(
    !bridge.invokes.some((i) => i.method === 'agent.loop.cancel'),
    '不许再调 agent.loop.cancel'
  );
}

async function testAbortDuringToolsCancelsRun() {
  const bridge = createFakeBridge({
    'agent.run.start': async (params) => ({
      phase: 'need_tools',
      runId: params.runId,
      delegates: [{ id: 'c1', name: 'fs_read_file', arguments: { filePath: 'a.txt' } }]
    }),
    'agent.run.tools': () => new Promise(() => {})
  });
  const ac = new AbortController();
  const p = runRustAgentLoop({
    coreBridge: bridge,
    llm: { baseUrl: 'https://example/v1' },
    startParams: { model: 'm' },
    loopSpec: loopSpec(),
    signal: ac.signal,
    delegateTool: async () => ({ ok: true })
  });
  await sleep(30);
  ac.abort();
  await expectAbort(p);
  assert(
    bridge.invokes.some((i) => i.method === 'agent.run.cancel'),
    '工具回填在途时取消也要收掉 core 的 run'
  );
}

async function testCancelledRpcErrorBecomesAbort() {
  const bridge = createFakeBridge({
    'agent.run.start': async () => {
      const err = new Error('run 已取消');
      err.code = 'AGENT_CANCELLED';
      throw err;
    }
  });
  await expectAbort(
    runRustAgentLoop({
      coreBridge: bridge,
      llm: { baseUrl: 'https://example/v1' },
      startParams: { model: 'm' },
      loopSpec: loopSpec()
    })
  );
  assert(
    bridge.invokes.some((i) => i.method === 'agent.run.cancel'),
    'core 报取消时也要把 run 收掉'
  );
}

async function testContextOverflowSoftStops() {
  const phases = [];
  const bridge = createFakeBridge({
    'agent.run.start': async () => {
      const err = new Error('HTTP 400 prompt is too long');
      err.statusCode = 400;
      throw err;
    }
  });
  const result = await runRustAgentLoop({
    coreBridge: bridge,
    llm: { baseUrl: 'https://example/v1' },
    startParams: { model: 'm' },
    loopSpec: loopSpec(),
    onPhase: (p) => phases.push(p)
  });
  assert(result.overflowStopped === true, 'overflow 软停（不假装成功）');
  assert(result.phase === 'done', 'soft done');
  assert(phases.includes('turn_overflow_stopped'), 'overflow phase');
  assert(
    bridge.invokes.some((i) => i.method === 'agent.run.cancel'),
    'overflow stop 收掉 run'
  );
  assert(
    !bridge.invokes.some((i) => i.method === 'agent.loop.fold'),
    '溢出强折归 core 内部（Node 不再调 agent.loop.fold）'
  );
}

async function testUnknownPhaseThrows() {
  const bridge = createFakeBridge({
    'agent.run.start': async (params) => ({ runId: params.runId, phase: 'need_coffee' })
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

async function testNonOverflowErrorSurfaces() {
  const bridge = createFakeBridge({
    'agent.run.start': async () => {
      const err = new Error('HTTP 400 invalid api key');
      err.statusCode = 400;
      throw err;
    }
  });
  let thrown = '';
  try {
    await runRustAgentLoop({
      coreBridge: bridge,
      llm: { baseUrl: 'https://example/v1' },
      startParams: { model: 'm' },
      loopSpec: loopSpec()
    });
  } catch (err) {
    thrown = String(err && err.message);
  }
  assert(/invalid api key/.test(thrown), '非溢出错误原样抛给调用方');
}

// ---------------------------------------------------------------- 交付四态 / 快照

async function testTurnEndSynthesisSkippedByDefault() {
  let synthCalls = 0;
  const bridge = createFakeBridge({
    'agent.run.start': async (params) => ({
      phase: 'done',
      runId: params.runId,
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
    'agent.run.start': async (params) => ({
      phase: 'done',
      runId: params.runId,
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
  assert(Array.isArray(result.trace) && result.trace.some((r) => r.phase === '汇总'), 'trace has 汇总 round');
}

async function testTurnEndTruncatedUsesReasoningFallback() {
  let synthCalls = 0;
  const longThought =
    '已经把 BrowserView 截图失败改成可重试，并在观察失败时保留文本快照，气泡在循环返回后立刻收成已完成。';
  const bridge = createFakeBridge({
    'agent.run.start': async (params) => ({
      phase: 'done',
      runId: params.runId,
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

async function testTurnEndThoughtDefersToSynthesis() {
  let synthCalls = 0;
  let synthBody = null;
  const longThought =
    '已经把 BrowserView 截图失败改成可重试，并在观察失败时保留文本快照，气泡在循环返回后立刻收成已完成。';
  const bridge = createFakeBridge({
    'agent.run.start': async (params) => ({
      phase: 'done',
      runId: params.runId,
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
}

async function testTurnEndKeepsModelProse() {
  let synthCalls = 0;
  const bridge = createFakeBridge({
    'agent.run.start': async (params) => ({
      phase: 'done',
      runId: params.runId,
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

/**
 * 请求快照接线：本轮发请求前必须先留底（docs/REQUEST-SNAPSHOT.md §5）。
 * 快照现在是「回合初始装配」这一份（逐轮快照要等 `round.prepare` 接通）。
 */
/**
 * 请求快照接线：**每轮请求前**留底，且记的是「这一个请求真正发出去的形态」
 * （装配发生在 `round.prepare`，快照就在那里写）。
 */
async function testRequestSnapshotWrittenInsideRoundPrepare() {
  const order = [];
  const bridge = createFakeBridge({
    'agent.run.start': async (params) => {
      order.push('start');
      // 模拟 core：请求前先问 round.prepare（快照就在这条回调里写）
      await bridge.callCore('round.prepare', {
        runId: params.runId,
        round: 0,
        messages: params.messages
      });
      return { phase: 'done', runId: params.runId, content: 'ok', trace: [] };
    },
    'memory.request_snapshot_append': async (params) => {
      order.push('snapshot');
      assert(params.sessionId === 'sess-snap', 'sessionId 透传');
      assert(params.source === 'subagent', 'runSource 透传');
      assert(/^run-\d+-/.test(String(params.runId)), 'runId 是宿主生成的那个');
      assert(params.round === 0, 'round 从 0 起');
      assert(params.reason === 'initial', '首发 reason=initial');
      assert(params.model === 'm', 'model 透传');
      assert(params.systemText === 'SYS', 'system 全文落库');
      assert(params.messageCount === 2, 'messageCount');
      assert(params.messagesHash && params.messagesHash.length === 64, 'messages hash');
      assert(JSON.parse(params.toolsNames)[0] === 'fs_read_file', 'tools 名字');
      assert(params.compacted === false, '未压缩');
      return { ok: true, id: 1, pruned: 0 };
    }
  });
  await runRustAgentLoop({
    coreBridge: bridge,
    llm: { baseUrl: 'https://example/v1', apiKey: 'k' },
    sessionId: 'sess-snap',
    runSource: 'subagent',
    contextAudit: { fold: { foldedCount: 2 } },
    startParams: {
      model: 'm',
      messages: [
        { role: 'system', content: 'SYS' },
        { role: 'user', content: 'hi' }
      ],
      tools: [{ type: 'function', function: { name: 'fs_read_file' } }]
    },
    loopSpec: loopSpec()
  });
  // 快照在 `round.prepare` 里写 → 时序是「start 发起 → 快照落库」（每轮一份，记注入后形态）
  assert(order.join(',') === 'start,snapshot', `每轮请求前留底，实际 ${order.join(',')}`);
  const sent = bridge.invokes.find((i) => i.method === 'memory.request_snapshot_append');
  assert(JSON.parse(sent.params.contextAuditJson).fold.foldedCount === 2, 'contextAudit 落库');
  // 同一个 runId 贯穿快照与 RPC
  const startParams = bridge.invokes.find((i) => i.method === 'agent.run.start').params;
  assert(startParams.runId === sent.params.runId, '快照与 start 用同一个 runId');
}

async function testRequestSnapshotFailureDoesNotBreakLoop() {
  const bridge = createFakeBridge({
    'agent.run.start': async (params) => ({ phase: 'done', runId: params.runId, content: 'ok', trace: [] }),
    'memory.request_snapshot_append': async () => {
      throw new Error('snapshot db locked');
    }
  });
  const result = await runRustAgentLoop({
    coreBridge: bridge,
    llm: { baseUrl: 'https://example/v1', apiKey: 'k' },
    sessionId: 'sess-snap-fail',
    startParams: { model: 'm', messages: [] },
    loopSpec: loopSpec()
  });
  assert(result.phase === 'done', '写快照失败后本轮照常完成');
}

// ---------------------------------------------------------------- 纯 helper（与驱动无关，保留）

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
  assert(!isVisionImageReadRequest('fs_read_file', { filePath: 'a.png' }), 'utf8 read is not a vision read');
  assert(
    !isVisionImageReadRequest('fs_read_file', { filePath: 'a.png', encoding: 'base64', offset: 100 }),
    'chunked read is not a vision read'
  );
  assert(!isVisionImageReadRequest('fs_edit', { encoding: 'base64' }), 'other tools are not vision reads');
}

/** 事件订阅必须退订（否则长会话会攒下无数监听器）。 */
async function testEventSubscriptionReleased() {
  const bridge = createFakeBridge({
    'agent.run.start': async (params) => ({ phase: 'done', runId: params.runId, content: 'ok', trace: [] })
  });
  await runRustAgentLoop({
    coreBridge: bridge,
    llm: { baseUrl: 'https://example/v1' },
    startParams: { model: 'm' },
    loopSpec: loopSpec()
  });
  assert(bridge.totalSubscriptions === 1, '每 run 只订阅一次');
  assert(bridge.listenerCount === 0, 'run 结束必须退订');
}

async function run() {
  testApplyResolvedLoopSpec();
  testResolveChatUrl();
  testBackfillReasoningContent();
  await testVisionImageReadHelpers();

  await testStartContractAndDeltaAccumulation();
  await testDeltaWithoutRoundUsesLocalCounter();
  await testToolsAreExecutedAndBackfilled();
  await testContentChannelStampedFromCapabilityTable();
  await testFoldFactDrivesNodeSideEffects();
  await testFoldFactOnNeedToolsIsHandled();
  await testRoundPrepareRegisteredBeforeStart();
  await testRoundPrepareInjectsPerRoundOnRequestCopy();
  await testVisionDisabledNoInjection();
  await testEventSubscriptionReleased();

  await testAbortDuringRunCancelsViaRunCancel();
  await testAbortDuringToolsCancelsRun();
  await testCancelledRpcErrorBecomesAbort();
  await testContextOverflowSoftStops();
  await testUnknownPhaseThrows();
  await testNonOverflowErrorSurfaces();

  await testTurnEndSynthesisSkippedByDefault();
  await testTurnEndSynthesisFillsEmptyReply();
  await testTurnEndTruncatedUsesReasoningFallback();
  await testTurnEndThoughtDefersToSynthesis();
  await testTurnEndKeepsModelProse();

  await testRequestSnapshotWrittenInsideRoundPrepare();
  await testRequestSnapshotFailureDoesNotBreakLoop();
}

run()
  .then(() => {
    console.log('test-rust-loop-runner.cjs ok');
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });

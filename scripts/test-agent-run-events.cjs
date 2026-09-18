'use strict';

/**
 * AgentRunEvent + Mobile progress 契约 smoke（无需 Electron / LLM）
 */

const {
  AGENT_RUN_EVENT_TYPES,
  createAgentRunEvent,
  applyAgentRunEventToLive,
  agentRunEventFromServicePayload,
  mapLegacyServiceEventType,
  MOBILE_SERVICE_EVENT_MAP
} = require('../src/agent/run-events');
const { createMainCompactionAgent } = require('../src/agent/compaction-main');
const { AgentService } = require('../src/agent/service');

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assert failed');
}

function testCreateAgentRunEvent() {
  const ev = createAgentRunEvent(AGENT_RUN_EVENT_TYPES.STREAM, {
    sessionId: 's1',
    streamContent: 'hello',
    trace: [{ thought: 't1', tools: [] }]
  });
  assert(ev.type === 'stream', 'type');
  assert(ev.sessionId === 's1', 'sessionId');
  assert(ev.streamContent === 'hello', 'streamContent');
  assert(Array.isArray(ev.trace) && ev.trace.length === 1, 'trace clone');
  assert(ev.trace[0].thought === 't1', 'trace content');
}

function testApplyToLiveStreamContent() {
  const live = { trace: [], streamContent: '' };
  applyAgentRunEventToLive(
    live,
    createAgentRunEvent(AGENT_RUN_EVENT_TYPES.STREAM, {
      streamContent: 'partial answer',
      trace: [{ thought: 'thinking', tools: [] }]
    })
  );
  assert(live.streamContent === 'partial answer', 'live streamContent updated');
  assert(live.trace.length === 1, 'live trace updated');
}

function testServicePayloadStreamContent() {
  const ev = agentRunEventFromServicePayload({
    type: 'task.progress',
    sessionId: 's2',
    requestId: 'r1',
    trace: [{ thought: 'x', tools: [] }],
    streamContent: 'streaming reply'
  });
  assert(ev.type === AGENT_RUN_EVENT_TYPES.TRACE, 'progress maps to trace');
  assert(ev.streamContent === 'streaming reply', 'streamContent from payload');
  assert(ev.summary === 'streaming reply', 'summary mirrors stream');
}

function testMobileServiceEventMap() {
  assert(mapLegacyServiceEventType('task.progress') === AGENT_RUN_EVENT_TYPES.TRACE, 'progress');
  assert(mapLegacyServiceEventType('task.completed') === AGENT_RUN_EVENT_TYPES.DONE, 'completed');
  assert(MOBILE_SERVICE_EVENT_MAP['task.progress'] === 'trace', 'map table');
}

function testAgentServiceProgressTask() {
  const gw = {
    invokeRpc: async () => []
  };
  const svc = new AgentService({ gateway: gw });
  const events = [];
  svc.on('event', (e) => events.push(e));

  svc.activeRequests.set('req-1', {
    requestId: 'req-1',
    sessionId: 'sess-a',
    status: 'running',
    trace: [],
    streamContent: ''
  });

  svc.progressTask({
    requestId: 'req-1',
    sessionId: 'sess-a',
    trace: [{ thought: 'step', tools: [] }],
    streamContent: 'live text'
  });

  assert(events.length === 1, 'one event');
  const payload = events[0];
  assert(payload.type === 'task.progress', 'task.progress type');
  assert(payload.streamContent === 'live text', 'mobile streamContent');
  assert(Array.isArray(payload.trace) && payload.trace.length === 1, 'trace forwarded');
  assert(payload.runEvent && payload.runEvent.streamContent === 'live text', 'runEvent stream');
}

function testCompactionSessionScoped() {
  const agent = createMainCompactionAgent(require('os').tmpdir(), null);
  agent.resetCompactionState('session-a');
  agent.resetCompactionState('session-b');
  agent.resetCompactionState();
  console.log('ok compaction session reset API');
}

function testRoundLimitFlagClearsOnResumeTrace() {
  const live = { trace: [], streamContent: '', hitRoundLimit: false };
  applyAgentRunEventToLive(
    live,
    createAgentRunEvent(AGENT_RUN_EVENT_TYPES.ROUND_LIMIT, {
      hitRoundLimit: true,
      streamContent: 'paused'
    })
  );
  assert(live.hitRoundLimit === true, 'round_limit sets hitRoundLimit');
  applyAgentRunEventToLive(
    live,
    createAgentRunEvent(AGENT_RUN_EVENT_TYPES.TRACE, {
      streamContent: 'resumed',
      trace: [{ thought: 'go', tools: [] }]
    })
  );
  assert(live.hitRoundLimit === false, 'trace after resume must clear hitRoundLimit');
}

function testTerminalEventKeepsStreamedContent() {
  // 终态事件经常不带正文（createAgentRunEvent 把缺省 streamContent 规整成 ''），
  // 照抄会把已经流式渲染好的正文抹掉 —— 气泡只剩思考区，重载会话才又出现。
  const live = { trace: [], streamContent: '高阳县今天晴，25℃。' };
  applyAgentRunEventToLive(live, createAgentRunEvent(AGENT_RUN_EVENT_TYPES.DONE, { sessionId: 's1' }));
  assert(live.streamContent === '高阳县今天晴，25℃。', 'done without content must keep streamed body');
  assert(live.finished === true, 'done marks finished');
  for (const type of [AGENT_RUN_EVENT_TYPES.STOPPED, AGENT_RUN_EVENT_TYPES.ERROR]) {
    const partial = { trace: [], streamContent: '半截正文' };
    applyAgentRunEventToLive(partial, createAgentRunEvent(type, { sessionId: 's1' }));
    assert(partial.streamContent === '半截正文', `${type} without content must keep partial body`);
  }
}

function testTerminalEventContentWins() {
  // 计划运行由 Main 收尾：终态事件带的就是落库的同一份正文，必须以它为准
  const live = { trace: [], streamContent: '' };
  applyAgentRunEventToLive(
    live,
    createAgentRunEvent(AGENT_RUN_EVENT_TYPES.DONE, { sessionId: 's1', streamContent: '最终正文' })
  );
  assert(live.streamContent === '最终正文', 'terminal content overrides');
}

function testProgressEventStillClearsContent() {
  // 非终态进度事件仍按事件原样覆盖（新一轮可以清空正文）
  const live = { trace: [], streamContent: '上一轮正文' };
  applyAgentRunEventToLive(
    live,
    createAgentRunEvent(AGENT_RUN_EVENT_TYPES.TRACE, { trace: [{ round: 1 }], streamContent: '' })
  );
  assert(live.streamContent === '', 'progress event may clear content');
}

function testPrepEventDoesNotClobberThinking() {
  const live = {
    inPrepPhase: false,
    trace: [{ round: 1, thought: 'already thinking', fullThought: 'already thinking', tools: [] }],
    streamContent: ''
  };
  applyAgentRunEventToLive(
    live,
    createAgentRunEvent(AGENT_RUN_EVENT_TYPES.PREP, {
      trace: [{ phase: 'prep', prepSteps: [{ id: 'compact', status: 'active' }], tools: [] }]
    })
  );
  assert(live.trace[0].fullThought === 'already thinking', 'prep must not overwrite streamed thought');
}

async function main() {
  testCreateAgentRunEvent();
  testApplyToLiveStreamContent();
  testTerminalEventKeepsStreamedContent();
  testTerminalEventContentWins();
  testProgressEventStillClearsContent();
  testPrepEventDoesNotClobberThinking();
  testRoundLimitFlagClearsOnResumeTrace();
  testServicePayloadStreamContent();
  testMobileServiceEventMap();
  testAgentServiceProgressTask();
  testCompactionSessionScoped();
  console.log('test-agent-run-events.cjs ok');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

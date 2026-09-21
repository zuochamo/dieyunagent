'use strict';

/**
 * Unit checks for agent-round-text sanitizer.
 * Run: node scripts/test-agent-round-text.cjs
 */

const {
  parseAgentStatusEnvelope,
  stripAgentStatusLine,
  stripRepeatedAgentPreamble,
  sanitizeAgentThoughtText
} = require('../src/agent/agent-round-text');

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assert failed');
}

const plan = [
  '可以补全，主人。',
  '',
  '**验收目标**',
  '- 单人/多人三档难度',
  '- 房间创建后锁定难度',
  '- 普通/困难调整非 Boss 参数',
  '- 语法检查、构建、Boss HP 断言与浏览器进程作为证据'
].join('\n');

const round1 = `agent_status: continue\n${plan}`;
const round2 = `agent_status: continue\n${plan}\n\n接下来读取 difficulty.cjs。`;

const parsed = parseAgentStatusEnvelope(round1);
assert(parsed.status === 'continue', 'parse continue status');
assert(parsed.content.startsWith('可以补全'), 'strip status leaves body');

assert(stripAgentStatusLine(round1) === plan, 'stripAgentStatusLine');
assert(parseAgentStatusEnvelope('<agent_status>final</agent_status>\n完成。').status === 'final', 'xml status');
assert(stripAgentStatusLine('agent_status: continue') === '', 'status-only line hides while streaming');

assert(stripRepeatedAgentPreamble(round2, round1) === '接下来读取 difficulty.cjs。', 'drop repeated plan keep delta');
assert(stripRepeatedAgentPreamble(round1, round1) === '', 'verbatim repeat is empty');
assert(stripRepeatedAgentPreamble('agent_status: continue\n' + plan, plan) === '', 'repeat after first-round body');

const shown1 = sanitizeAgentThoughtText(round1, []);
assert(shown1 === plan, 'first round keeps plan, drops status');
assert(!shown1.includes('agent_status'), 'no protocol line in first thought');

const shown2 = sanitizeAgentThoughtText(round2, [shown1]);
assert(shown2 === '接下来读取 difficulty.cjs。', 'later round keeps only new sentence');
assert(!shown2.includes('验收目标'), 'later round does not repeat 验收目标');

const streaming = sanitizeAgentThoughtText(`agent_status: continue\n${plan.slice(0, 40)}`, [shown1]);
assert(streaming === '', 'partial repeat while streaming is hidden');

assert(sanitizeAgentThoughtText('请求 LLM…', [shown1]) === '请求 LLM…', 'passthrough placeholders');
assert(
  sanitizeAgentThoughtText('先读共享难度文件。', []) === '先读共享难度文件。',
  'short unique thought kept'
);

const {
  needsAssistantReplySynthesis,
  synthesizedReplyIsUsable,
  pickNormalizedAssistantReply,
  resolveTurnDelivery,
  reasoningTextFromTrace,
  reasoningFallbackText,
  persistableTurnText,
  isReasoningFallbackText,
  TURN_EMPTY_REPLY_TEXT
} = require('../src/agent/agent-round-text');

const toolTrace = [
  { tools: [{ name: 'fs_read_file' }, { name: 'fs_edit' }, { name: 'host_exec' }] }
];
assert(needsAssistantReplySynthesis('', toolTrace) === true, 'empty after tools needs synthesis');
assert(needsAssistantReplySynthesis('(空响应)', toolTrace) === true, 'empty placeholder needs synthesis');
assert(
  needsAssistantReplySynthesis('<tool_call>fs_read_file</tool_call>', toolTrace) === true,
  'leftover tool markup needs synthesis'
);
assert(
  needsAssistantReplySynthesis('已完成。', toolTrace) === false,
  'short model reply is delivery, no extra LLM'
);
assert(
  synthesizedReplyIsUsable('已改 login 表单：补了 CDP 输入，截图失败不再整轮失败。') === true,
  'short but valid synthesized reply is usable'
);
assert(
  needsAssistantReplySynthesis('已改 login 表单：补了 CDP 输入，截图失败不再整轮失败。', toolTrace) === false,
  'non-empty reply does not trip synthesis'
);
const deepThought = '已经把 BrowserView 截图失败改成可重试，并在观察失败时保留文本快照，气泡在循环返回后立刻收成已完成。';

// 四态交付决策：单一来源（§3.4）
assert(
  resolveTurnDelivery({ answer: '已完成。', reasoning: deepThought, truncated: true }).state === 'answer',
  'answer wins over reasoning'
);
const fallback = resolveTurnDelivery({ answer: '', reasoning: deepThought, truncated: true });
assert(
  fallback.state === 'reasoning-fallback' && fallback.text === reasoningFallbackText(deepThought),
  'truncated + reasoning → labeled reasoning-fallback'
);
assert(isReasoningFallbackText(fallback.text) === true, 'reasoning fallback is explicitly labeled');
assert(
  resolveTurnDelivery({ answer: '', reasoning: deepThought, truncated: false }).state === 'synthesis',
  'normal end + reasoning → synthesis'
);
const emptyDelivery = resolveTurnDelivery({ answer: '   ', reasoning: '', truncated: false });
assert(
  emptyDelivery.state === 'empty' && emptyDelivery.text === TURN_EMPTY_REPLY_TEXT,
  'nothing to deliver → placeholder'
);

// 思考回退只用于展示，绝不写进账本（§3.4）
assert(persistableTurnText(fallback.text) === TURN_EMPTY_REPLY_TEXT, 'reasoning fallback never persisted');
assert(persistableTurnText('真实答复') === '真实答复', 'plain answer persists as-is');
assert(persistableTurnText('') === TURN_EMPTY_REPLY_TEXT, 'empty reply persists as placeholder');

// trace → 真思考（单一来源，跳过汇总轮与占位思考）
assert(
  reasoningTextFromTrace([
    { phase: '思考', fullThought: deepThought },
    { phase: '汇总', fullThought: '已完成' },
    { phase: '思考', fullThought: '请求 LLM…' }
  ]) === deepThought,
  'trace reasoning skips synthesis round + placeholder'
);

const genericTool = '本轮 Agent 已执行 3 次工具，但未能生成最终文字总结。';
const thought = deepThought;
assert(
  pickNormalizedAssistantReply('已完成。', toolTrace, {
    reasoningFallback: thought,
    toolFallback: genericTool
  }) === '已完成。',
  'normalize keeps short model reply'
);
assert(
  pickNormalizedAssistantReply('', toolTrace, {
    reasoningFallback: thought,
    toolFallback: genericTool
  }) === reasoningFallbackText(thought),
  'empty content uses labeled reasoning fallback'
);
assert(
  pickNormalizedAssistantReply('', toolTrace, { reasoningFallback: '', toolFallback: genericTool }) === genericTool,
  'no reasoning → tool fallback'
);
assert(
  pickNormalizedAssistantReply('', toolTrace, { reasoningFallback: '', toolFallback: '' }) === TURN_EMPTY_REPLY_TEXT,
  'nothing available → placeholder'
);

console.log('test-agent-round-text.cjs ok');

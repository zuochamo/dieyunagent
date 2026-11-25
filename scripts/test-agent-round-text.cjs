'use strict';

/**
 * Unit checks for agent-round-text（交付四态 / 真思考提取）。
 * Run: node scripts/test-agent-round-text.cjs
 *
 * 已删除（2026-10-28）：
 * - `agent_status` 协议解析与「重复前言」字符串去重（Rust 账本侧同步删除）；
 * - 中文占位文案词表 —— 占位改由写入处的 `placeholder: true` 结构标记表达。
 */

const { reasoningTextFromTrace } = require('../src/agent/agent-round-text');

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

// 占位行靠结构标记排除：文案写什么都不影响（不再维护中文词表）
assert(
  reasoningTextFromTrace([
    { phase: '思考', fullThought: plan },
    { phase: '思考', placeholder: true, fullThought: '请求 LLM…' },
    { phase: '思考', placeholder: true, fullThought: '生成中…' }
  ]) === plan,
  'placeholder rows are excluded by flag, not by wording'
);
assert(
  reasoningTextFromTrace([{ phase: '思考', placeholder: true, fullThought: '启动…' }]) === '',
  'all-placeholder trace yields no reasoning'
);

const {
  needsAssistantReplySynthesis,
  synthesizedReplyIsUsable,
  pickNormalizedAssistantReply,
  resolveTurnDelivery,
  reasoningFallbackText,
  persistableTurnText,
  isReasoningFallbackText,
  replyHasToolCallMarkup,
  deliverableAnswer,
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
  synthesizedReplyIsUsable('已完成。') === true,
  'very short but complete synthesized reply is usable (no length gate)'
);
assert(
  needsAssistantReplySynthesis('已改 login 表单：补了 CDP 输入，截图失败不再整轮失败。', toolTrace) === false,
  'non-empty reply does not trip synthesis'
);

// 回归（2026-11-19 子 Agent 事故）：上游把工具调用**写成文本**时，content 里留下的是
// `<| |DSML| | invoke …>` 这类特殊 token。旧正则要求 `<` 紧跟关键字，于是整段标记被当成
// 正式正文交付 —— 而那条 host_exec 从未执行，泄漏文本还被回注主上下文当结论。
// 标记形态是**结构信号**（不是中英文词表），因此放宽到「`<` 与关键字之间允许 `|`/空格」。
const dsmlLeak = [
  '<| |DSML| | calls>',
  '<| |DSML| | invoke name="host_exec">',
  '<| |DSML| | parameter name="command" string="true">chcp 65001 >nul & dir</| |DSML| | parameter>',
  '</| |DSML| | invoke>',
  '</| |DSML| | calls>'
].join('\n');
assert(replyHasToolCallMarkup(dsmlLeak) === true, 'DSML special-token tool call is markup');
assert(
  needsAssistantReplySynthesis(dsmlLeak, toolTrace) === true,
  'DSML leak needs synthesis instead of being delivered'
);
assert(deliverableAnswer(dsmlLeak, toolTrace) === '', 'DSML leak is never delivered as an answer');
assert(replyHasToolCallMarkup('<|tool_calls|>') === true, '<|tool_calls|> is markup');
assert(replyHasToolCallMarkup('<antml:invoke name="x">') === true, 'antml invoke is markup');
// 反向：普通比较、标识符不能被误判（误判会把正常回答吞掉）
assert(replyHasToolCallMarkup('a < b 且 c > d 都成立') === false, 'plain comparisons are not markup');
assert(replyHasToolCallMarkup('function_name 与 function()') === false, 'identifiers are not markup');
// 反向：正文里出现 `function=` 也**不是**标记（2026-11-21 回归：裸匹配会把 planner 汇总整段换成空串）
assert(
  replyHasToolCallMarkup('接口是 /api/x?function=getUser，改完测过。') === false,
  'query string containing function= is not markup'
);
assert(
  replyHasToolCallMarkup('把 function= 这一项删掉') === false,
  'prose mentioning function= is not markup'
);
// 正向：历史形态 `<function=…>` 仍算标记（`<` 是它的结构信号）
assert(replyHasToolCallMarkup('<function=fs_read_file>') === true, '<function= tag is markup');
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

// trace → 真思考（单一来源，跳过汇总轮与 placeholder 标记行）
assert(
  reasoningTextFromTrace([
    { phase: '思考', fullThought: deepThought },
    { phase: '汇总', fullThought: '已完成' },
    { phase: '思考', placeholder: true, fullThought: '请求 LLM…' }
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

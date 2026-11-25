'use strict';

const {
  enrichLlmToolCalls,
  hasIncompleteToolCallMarkup,
  extractToolCallsFromContent,
  stripToolCallMarkup,
  filterCompleteFunctionToolCalls,
  normalizeCompleteToolCallArgumentsJson
} = require('../src/llm-tool-call-fallback');

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assert failed');
}

const completeXml = '<function=host_exec><parameter=command>echo hi</parameter></function>';
const extracted = extractToolCallsFromContent(completeXml);
assert(extracted.length === 1 && extracted[0].name === 'host_exec', 'complete xml tool call');

const incomplete = '正在调用工具 <tool_calls><invoke name="fs_read_file">';
assert(hasIncompleteToolCallMarkup(incomplete) === true, 'incomplete markup is fail-closed');
const incompleteEnriched = enrichLlmToolCalls({ content: incomplete, toolCalls: [] });
assert(incompleteEnriched.toolCalls.length === 0, 'incomplete does not invent calls');
assert(incompleteEnriched.incompleteToolMarkup === true, 'flags incompleteToolMarkup');
assert(String(incompleteEnriched.content).includes('<tool_calls>'), 'does not leak-parse into empty strip');

const dsmlIncomplete = '<｜DSML｜tool_calls><invoke name="grep">';
assert(hasIncompleteToolCallMarkup(dsmlIncomplete) === true, 'incomplete DSML fail-closed');

/**
 * 回归（2026-11-19 子 Agent 事故）：DSML 的 **ASCII / 带空格 / `calls` 标签名** 变体
 * —— `<| |DSML| | calls>`、`<| |DSML| | invoke name="…">`。
 *
 * 旧实现只认定长的 `<｜DSML｜`（全角、无空格），于是这种形态一条都匹配不上：既不剥除、
 * 也不识别，整段标记被当成模型正文交付（子 Agent 卡片里肉眼可见），而那条 host_exec 从未执行。
 */
const dsmlAsciiLeak = [
  '<| |DSML| | calls>',
  '<| |DSML| | invoke name="host_exec">',
  '<| |DSML| | parameter name="command" string="true">chcp 65001 >nul & dir C:\\Users\\admin\\Desktop\\报价单*</| |DSML| | parameter>',
  '</| |DSML| | invoke>',
  '</| |DSML| | calls>'
].join('\n');
const asciiCalls = extractToolCallsFromContent(dsmlAsciiLeak);
assert(asciiCalls.length === 1, 'ASCII DSML 变体必须解析出一个工具调用');
assert(asciiCalls[0].name === 'host_exec', 'ASCII DSML 变体的工具名');
assert(
  asciiCalls[0].arguments.command === 'chcp 65001 >nul & dir C:\\Users\\admin\\Desktop\\报价单*',
  'ASCII DSML 变体的参数原文'
);
assert(stripToolCallMarkup(`先看下桌面。\n${dsmlAsciiLeak}`) === '先看下桌面。', 'ASCII DSML 变体必须被剥净');
const asciiEnriched = enrichLlmToolCalls({ content: dsmlAsciiLeak, toolCalls: [] });
assert(asciiEnriched.toolCalls.length === 1, 'enrich 从 ASCII DSML 变体补出工具调用');
assert(String(asciiEnriched.content).trim() === '', 'enrich 后正文不残留标记');
const asciiIncomplete = enrichLlmToolCalls({
  content: '<| |DSML| | calls>\n<| |DSML| | invoke name="host_exec">',
  toolCalls: []
});
// 只有开标签、没有参数也没有闭合 → fail-closed 不编造调用，只打「残缺标记」标
assert(asciiIncomplete.toolCalls.length === 0, '未闭合的 ASCII DSML 不得编造工具调用');
assert(asciiIncomplete.incompleteToolMarkup === true, '未闭合的 ASCII DSML 要标记出残缺');
assert(
  extractToolCallsFromContent('普通回复，没有工具调用。').length === 0,
  'ASCII DSML 变体放宽后不误伤纯文本'
);

const plain = '普通回复，没有工具调用。';
assert(hasIncompleteToolCallMarkup(plain) === false, 'plain text is not incomplete markup');
const plainEnriched = enrichLlmToolCalls({ content: plain, toolCalls: [] });
assert(plainEnriched.incompleteToolMarkup === false, 'plain has no incomplete flag');

assert(normalizeCompleteToolCallArgumentsJson('{"path":"/a"}') === '{"path":"/a"}', 'complete json args');
assert(normalizeCompleteToolCallArgumentsJson('{"path":"/foo') == null, 'truncated json args fail-closed');
assert(normalizeCompleteToolCallArgumentsJson('') === '{}', 'empty args is empty object');
assert(normalizeCompleteToolCallArgumentsJson({ path: '/a' }) === '{"path":"/a"}', 'object args stringify');
const rustShape = filterCompleteFunctionToolCalls([
  { id: 'x', name: 'fs_read_file', arguments: { path: 'a.js' } }
]);
assert(rustShape.length === 1 && rustShape[0].arguments.path === 'a.js', 'already-parsed object args kept');

const mixed = filterCompleteFunctionToolCalls([
  { id: '1', type: 'function', function: { name: 'fs_read_file', arguments: '{"path":"a.js"}' } },
  { id: '2', type: 'function', function: { name: 'fs_read_file', arguments: '{"path":"/foo' } },
  { id: '3', type: 'function', function: { name: '', arguments: '{}' } }
]);
assert(mixed.length === 1 && mixed[0].id === '1', 'drops truncated and nameless tool_calls');
assert(mixed[0].function.arguments === '{"path":"a.js"}', 'keeps complete call');

const onlyTruncated = filterCompleteFunctionToolCalls([
  { function: { name: 'fs_read_file', arguments: '{"a":' } }
]);
assert(onlyTruncated.length === 0, 'truncated-only does not invent {}');

const truncatedEnriched = enrichLlmToolCalls({
  content: '调用工具',
  toolCalls: [{ name: 'fs_read_file', arguments: '{"path":"/foo' }]
});
assert(truncatedEnriched.toolCalls.length === 0, 'enrich drops truncated json calls');
assert(truncatedEnriched.incompleteJsonToolCalls === true, 'enrich flags incomplete json');

/**
 * 参数名判定表必须**跟着工具目录走**。
 *
 * 事故：手抄的 49 项 Set 与 `tool-catalog` 漂移，缺 32 个工具（`subagent` / `plan_*` /
 * `memory_*` / `session_*` / `peer_*` / `ssh` / `worktree` …）。弱模型把这些调用写成
 * content 里的参数块时，参数名被当普通实参吞掉 —— 工具明明存在却调不到。
 */
const { ALL_STATIC_TOOLS } = require('../src/agent/tool-catalog');
// 走真实解析路径（参数块 → 工具调用），不为了测试再导出一个内部判定函数
const missingNames = ALL_STATIC_TOOLS.map((t) => String((t.function && t.function.name) || ''))
  .filter(Boolean)
  .filter((n) => {
    const parsed = extractToolCallsFromContent(
      `<parameter name="${n}"><parameter name="prompt">do it</parameter></parameter>`
    );
    return !(parsed.length === 1 && parsed[0].name === n);
  });
assert(missingNames.length === 0, `目录里的工具名都必须能被识别成工具调用，缺 ${missingNames.join(',')}`);

// 以前漏掉的那几个名字现在能真的解析出来（mimo 的 `<parameter name="X">` 形态）；
// 这些都不在旧手抄白名单里，是「工具存在却调不到」的原样复现
for (const toolName of ['subagent', 'plan_create', 'memory_recall', 'session_set_workspace', 'peer_send', 'ssh', 'worktree']) {
  const parsed = extractToolCallsFromContent(
    `<parameter name="${toolName}"><parameter name="prompt">do it</parameter></parameter>`
  );
  assert(
    parsed.length === 1 && parsed[0].name === toolName,
    `${toolName} 写在参数块里必须被识别成工具调用（旧白名单会漏掉）`
  );
}

/**
 * 裸 `<calls>` 外层标签（没有 `tool` 前缀）：DeepSeek DSML 的另一种写法。
 *
 * 2026-11-21 之前 Renderer 侧有两份「展示层剥标记」的抄件（renderer-agent-continue.js /
 * renderer-thinking-trace.js），它们只认 `<tool_calls>` / `<tool calls>`，**不认裸 `<calls>`**，
 * 于是同一条回复在 Main 侧剥净、气泡与思考区里却漏出工具标记。两份抄件已删，
 * 两侧现在都走本函数；这条断言就是那次漂移的回归。
 */
const bareCalls =
  '先看下桌面。\n<calls>\n<invoke name="host_exec">\n<parameter name="command" string="true">dir</parameter>\n</invoke>\n</calls>';
assert(stripToolCallMarkup(bareCalls) === '先看下桌面。', '裸 <calls> 变体必须被剥净');
assert(
  extractToolCallsFromContent(bareCalls).length === 1,
  '裸 <calls> 变体也要能解析出工具调用（否则那条 host_exec 就静默没执行）'
);
// 纯文本不许被误伤（快路径：没有尖括号就原样返回）
const plainText = '报表已生成，共 3 页；下一句里有 < 号但不成标记。';
assert(stripToolCallMarkup(plainText) === plainText, '纯文本不许被剥变形');

console.log('test-llm-tool-call-fallback.cjs ok');

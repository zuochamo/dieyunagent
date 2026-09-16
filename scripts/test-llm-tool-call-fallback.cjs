'use strict';

const {
  enrichLlmToolCalls,
  hasIncompleteToolCallMarkup,
  extractToolCallsFromContent,
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

console.log('test-llm-tool-call-fallback.cjs ok');

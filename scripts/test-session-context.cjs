'use strict';

const {
  TURN_RIDE_HEADER,
  COMPACTION_ARCHIVE_HEADER,
  packSystemPrompt,
  unwrapSystemPromptPack,
  attachTurnRideToUserContent,
  FOLDED_HISTORY_HEADER,
  foldOlderCompletionMessages,
  trimMessagesToCharBudget,
  buildCompletionMessagesFromHistory,
  selectHistoryMessagesForSession,
  cloneHistoryMessages,
  buildSessionChatHistoryFromMessages,
  buildCurrentTaskText,
  persistableAssistantText,
  assistantTextFromMessage,
  messagesForTranscript,
  formatCompactionArchiveBlock,
  mergeCompactionBlockIntoTurnRide,
  extractInTurnLoopTail,
  reprojectContinueLoopMessages,
  isSyntheticLoopUserContent,
  contentCharLen
} = require('../src/agent/session-context');
const { AGENT_LIMITS_DEFAULTS } = require('../src/agent/agent-limits');

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assert failed');
}

// 图片 part 必须按「等效字符」计入预算，而不是按 base64 长度。
// 否则一张 2MB 的图会被算成约 270 万字符，单张就顶穿 llmRequestMaxChars，
// 并让 shouldCompactRound 每轮误触发压缩 —— 而图片既不可折叠也不可压缩。
const bigImagePart = {
  type: 'image_url',
  image_url: { url: `data:image/png;base64,${'A'.repeat(2 * 1024 * 1024)}` }
};
assert(
  contentCharLen([{ type: 'text', text: '看图' }, bigImagePart]) ===
    '看图'.length + AGENT_LIMITS_DEFAULTS.visionPartEqChars,
  'image part counts as equivalent chars, not base64 length'
);
assert(
  contentCharLen([{ type: 'text', text: 'x' }]) === 1,
  'plain text part still counted by length'
);
assert(
  contentCharLen('abc') === 3 && contentCharLen(null) === 0,
  'string and empty content'
);

const keptWithBigImage = trimMessagesToCharBudget([
  { role: 'user', content: '上一个问题' },
  { role: 'user', content: [{ type: 'text', text: '看这张图' }, bigImagePart] }
]);
assert(keptWithBigImage.length === 2, 'big image no longer blows the request char budget');
assert(
  Array.isArray(keptWithBigImage[1].content) &&
    keptWithBigImage[1].content.some((p) => p && p.type === 'image_url'),
  'image part survives budget trimming'
);

// 历史消息里的图片同样原样保留：不能因为 base64 长度大就被换成「（图片过大已省略）」
const keptImageInHistory = trimMessagesToCharBudget([
  { role: 'user', content: [{ type: 'text', text: '第一轮带图' }, bigImagePart] },
  { role: 'assistant', content: '收到' },
  { role: 'user', content: '第二个问题' }
]);
assert(
  Array.isArray(keptImageInHistory[0].content) &&
    keptImageInHistory[0].content.some((p) => p && p.type === 'image_url'),
  'history image part is not replaced by an oversize placeholder'
);

const packed = packSystemPrompt(
  ['规则A', '工作区 /tmp'],
  ['【代码库】foo.js', '【工作记忆】bar']
);
assert(packed.stable.includes('规则A'), 'stable keeps rules');
assert(!packed.stable.includes('foo.js'), 'stable excludes turn ride');
assert(packed.turnRide.includes('foo.js'), 'turn ride has codebase');
assert(packed.content.includes('规则A') && packed.content.includes('foo.js'), 'joined content');

const fromString = unwrapSystemPromptPack('legacy-system');
assert(fromString.stable === 'legacy-system' && fromString.turnRide === '', 'legacy string unwrap');

const fromObj = unwrapSystemPromptPack(packed);
assert(fromObj.stable === packed.stable && fromObj.turnRide === packed.turnRide, 'object unwrap');

const ridden = attachTurnRideToUserContent('【当前任务】修 bug', packed.turnRide);
assert(String(ridden).includes(TURN_RIDE_HEADER), 'turn ride appends after task');
assert(String(ridden).indexOf('【当前任务】修 bug') < String(ridden).indexOf(TURN_RIDE_HEADER), 'task before ride');
assert(String(ridden).includes('【当前任务】修 bug'), 'keeps current task');

const multi = attachTurnRideToUserContent(
  [{ type: 'text', text: '看图' }, { type: 'image_url', image_url: { url: 'x' } }],
  '【代码库】a.ts'
);
assert(multi[0].type === 'text' && multi[0].text.includes('a.ts'), 'multimodal text part');
assert(multi[1].type === 'image_url', 'image part preserved');

const msgs = buildCompletionMessagesFromHistory(
  [
    { role: 'user', content: '上一问' },
    { role: 'assistant', content: '上一答' },
    { role: 'user', content: '这一问' }
  ],
  packed.stable,
  null,
  false,
  null,
  packed.turnRide
);
assert(msgs[0].role === 'system' && msgs[0].content === packed.stable, 'system is stable prefix');
assert(!String(msgs[0].content).includes('foo.js'), 'system has no turn ride');
const last = msgs[msgs.length - 1];
assert(last.role === 'user', 'last is user');
assert(String(last.content).includes(TURN_RIDE_HEADER), 'last user has turn ride');
assert(String(last.content).includes(buildCurrentTaskText('这一问')), 'last user has current task');
assert(
  String(last.content).indexOf('【当前任务') < String(last.content).indexOf(TURN_RIDE_HEADER),
  'current task precedes turn ride'
);

const liveTrace = [{ marker: 'LIVE_TRACE', tools: [{ name: 'host_exec', summary: 'secret-live' }] }];
const leakHelpers = {
  toolFallback(trace) {
    return trace && trace[0] && trace[0].marker === 'LIVE_TRACE' ? 'LEAKED_LIVE_TRACE' : '';
  },
  thoughtFallback() {
    return '';
  }
};
const emptyWithLive = assistantTextFromMessage(
  { role: 'assistant', content: '', transientTrace: liveTrace },
  leakHelpers
);
assert(emptyWithLive === '', 'model projector ignores live transientTrace');

const bookText = assistantTextFromMessage(
  { role: 'assistant', content: '账本里的总结', transientTrace: liveTrace },
  leakHelpers
);
assert(bookText === '账本里的总结', 'persisted content wins over live trace');

assert(
  persistableAssistantText('', liveTrace, leakHelpers) === 'LEAKED_LIVE_TRACE',
  'write-time fold uses same-turn trace'
);
assert(
  persistableAssistantText('已停止生成。', liveTrace, leakHelpers) === 'LEAKED_LIVE_TRACE',
  'weak stop reply is folded at write time'
);
assert(
  persistableAssistantText('已完成。', liveTrace, leakHelpers) === '已完成。',
  'short model prose is stored as-is'
);
assert(
  persistableAssistantText('正常答复', liveTrace, leakHelpers) === '正常答复',
  'strong reply is stored as-is'
);

const filtered = messagesForTranscript([
  { role: 'user', content: 'u' },
  { role: 'system', content: 'sys-row' },
  { role: 'tool', content: '不该进模型' },
  { role: 'assistant', content: 'a' }
]);
assert(filtered.length === 2, 'transcript keeps user/assistant only');
assert(
  !filtered.some((m) => String(m.content).includes('不该进模型')),
  'tool rows are not transcript'
);

const withToolRow = buildCompletionMessagesFromHistory(
  [
    { role: 'user', content: '上一问' },
    { role: 'assistant', content: '上一答' },
    { role: 'tool', content: '不该进模型' },
    { role: 'user', content: '这一问' }
  ],
  packed.stable,
  null,
  false,
  leakHelpers,
  packed.turnRide
);
assert(!JSON.stringify(withToolRow).includes('不该进模型'), 'completion messages drop tool rows');
assert(!JSON.stringify(withToolRow).includes('LEAKED_LIVE_TRACE'), 'completion messages stay on the book');

const hugeHist = buildCompletionMessagesFromHistory(
  [
    { role: 'user', content: 'x'.repeat(40000) },
    { role: 'assistant', content: 'y'.repeat(40000) },
    { role: 'user', content: '这一问' }
  ],
  'sys',
  null,
  false,
  null,
  '',
  { historyMaxChars: 12000, messageMaxChars: 3000, lastUserMaxChars: 8000, requestMaxChars: 20000 }
);
const hugeJson = JSON.stringify(hugeHist);
assert(!hugeJson.includes('x'.repeat(4000)), 'old user history is truncated');
assert(hugeJson.includes('这一问'), 'keeps current user turn');
assert(hugeJson.length < 30000, 'completion payload stays bounded');

const rideKeepTask = buildCompletionMessagesFromHistory(
  [{ role: 'user', content: '务必保留的任务句' }],
  'sys',
  null,
  false,
  null,
  `${TURN_RIDE_HEADER}\n${'R'.repeat(40000)}`,
  { lastUserMaxChars: 8000, turnRideMaxChars: 5000, historyMaxChars: 1000, messageMaxChars: 1000, requestMaxChars: 80000 }
);
const lastKeep = rideKeepTask[rideKeepTask.length - 1];
assert(String(lastKeep.content).includes('务必保留的任务句'), 'truncating turn-ride keeps current task');
assert(!String(lastKeep.content).includes('R'.repeat(8000)), 'turn-ride is capped');

const longBook = [];
for (let i = 0; i < 10; i++) longBook.push({ role: 'user', content: `旧问-${i}-UNIQUE` }, { role: 'assistant', content: `旧答-${i}` });
longBook.push({ role: 'user', content: '这一问' });
const foldedBook = buildCompletionMessagesFromHistory(longBook, 'sys', null, false, null, '', {
  recentTurns: 4,
  foldedMaxChars: 2500,
  historyMaxChars: 20000,
  messageMaxChars: 8000,
  lastUserMaxChars: 8000,
  requestMaxChars: 80000
});
const foldedJson = JSON.stringify(foldedBook);
assert(foldedJson.includes(FOLDED_HISTORY_HEADER), 'old turns become one folded stub');
assert(foldedJson.includes('这一问'), 'keeps current user turn after fold');
const nonSys = foldedBook.filter((m) => m.role !== 'system');
assert(nonSys.length === 5, 'folded stub + last 4 messages');
assert(nonSys[0].role === 'user' && String(nonSys[0].content).startsWith(FOLDED_HISTORY_HEADER), 'fold is first non-system');
assert(String(nonSys[0].content).includes('用本段恢复目标'), 'fold stub is recoverable context');
assert(!String(nonSys[0].content).includes('禁止根据本段去「继续完成」'), 'fold stub must not forbid resuming');
assert(!nonSys.some((m) => m.content === '旧问-0-UNIQUE'), 'oldest turn is not a verbatim API message');

const toolCut = foldOlderCompletionMessages(
  [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'old' },
    { role: 'assistant', content: 'a1', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'grep', arguments: '{}' } }] },
    { role: 'tool', content: 'hit', tool_call_id: 'c1' },
    { role: 'assistant', content: 'done' },
    { role: 'user', content: 'now' }
  ],
  null,
  { recentTurns: 3, foldedMaxChars: 2000 }
);
const toolRest = toolCut.filter((m) => m.role !== 'system');
assert(toolRest[0].content && String(toolRest[0].content).startsWith(FOLDED_HISTORY_HEADER), 'fold before recent window');
assert(toolRest.some((m) => m.role === 'tool'), 'does not start recent window on a dangling tool result');
assert(
  toolRest.some((m) => m.role === 'assistant' && m.tool_calls),
  'walks back so the tool result stays with its assistant'
);

const longLoop = [
  { role: 'system', content: 'sys' },
  { role: 'user', content: '旧问A' },
  { role: 'assistant', content: '旧答A' },
  { role: 'user', content: '旧问B' },
  { role: 'assistant', content: '旧答B' },
  { role: 'user', content: '当前任务：改 webgl-post' }
];
for (let i = 0; i < 20; i++) {
  longLoop.push({
    role: 'assistant',
    content: '',
    tool_calls: [{ id: `t${i}`, type: 'function', function: { name: 'fs_read_file', arguments: '{}' } }]
  });
  longLoop.push({
    role: 'tool',
    content: `TOOL_BODY_${i}_` + 'x'.repeat(200),
    tool_call_id: `t${i}`
  });
}
const protectedLoop = foldOlderCompletionMessages(longLoop, null, {
  recentTurns: 4,
  foldedMaxChars: 2000
});
const protectedRest = protectedLoop.filter((m) => m.role !== 'system');
assert(protectedRest[0].content && String(protectedRest[0].content).startsWith(FOLDED_HISTORY_HEADER), 'folds older book only');
assert(protectedRest.some((m) => m.role === 'user' && String(m.content).includes('当前任务')), 'keeps current task user');
assert(
  protectedRest.filter((m) => m.role === 'tool').length === 20,
  'never folds in-turn tool results even when loop >> recentTurns'
);
assert(
  protectedRest.some((m) => m.role === 'tool' && String(m.content).includes('TOOL_BODY_19_')),
  'latest tool body stays verbatim'
);
assert(
  !protectedRest.some((m) => m.role === 'user' && m.content === '旧问A'),
  'old book user is folded away'
);

const historyBlock = buildSessionChatHistoryFromMessages(
  [
    { role: 'user', content: '上一问' },
    {
      role: 'assistant',
      content: '',
      transientTrace: liveTrace
    },
    { role: 'user', content: '这一问' }
  ],
  { excludeLastUser: true },
  leakHelpers
);
assert(!historyBlock.includes('LEAKED_LIVE_TRACE'), 'planner history ignores live transientTrace');
assert(historyBlock.includes('上一问'), 'planner history keeps persisted user text');

assert(formatCompactionArchiveBlock(null) === '', 'empty archive rows');
assert(formatCompactionArchiveBlock([{ tokens_before: 1 }]) === '', 'archive without summary');
const archiveBlock = formatCompactionArchiveBlock([
  { summary_text: '已改 renderer-agent-send.js 的 turnRide' },
  { summary_text: '更旧的摘要不应出现' }
]);
assert(archiveBlock.startsWith(COMPACTION_ARCHIVE_HEADER), 'compaction block header');
assert(archiveBlock.includes('已改 renderer-agent-send.js'), 'latest archive summary');
assert(!archiveBlock.includes('更旧的摘要不应出现'), 'only latest archive');
const camelBlock = formatCompactionArchiveBlock([{ summaryText: 'camel-summary' }]);
assert(camelBlock.includes('camel-summary'), 'accepts camelCase summaryText');
const long = 'x'.repeat(3000);
const clipped = formatCompactionArchiveBlock([{ summary_text: long }], 100);
assert(clipped.includes('…') && clipped.length < 400, 'clips archive summary');

const riddenWithArchive = attachTurnRideToUserContent(
  buildCurrentTaskText('继续'),
  archiveBlock
);
assert(String(riddenWithArchive).includes(COMPACTION_ARCHIVE_HEADER), 'archive rides on last user');
assert(!String(riddenWithArchive).startsWith('【系统'), 'archive is not a second system');

const mergedRide = mergeCompactionBlockIntoTurnRide('【代码库】a.ts', archiveBlock);
assert(mergedRide.includes('【代码库】a.ts') && mergedRide.includes(COMPACTION_ARCHIVE_HEADER), 'merge archive into ride');
const replacedRide = mergeCompactionBlockIntoTurnRide(mergedRide, formatCompactionArchiveBlock([{ summary_text: '新摘要' }]));
assert(replacedRide.includes('新摘要') && !replacedRide.includes('已改 renderer-agent-send.js'), 'replace old archive block');

const otherSessionMsgs = [{ role: 'user', content: '配置 MCP' }];
const tankCache = [{ role: 'user', content: '坦克项目' }];
const mixed = selectHistoryMessagesForSession({
  runSessionId: 'tank-new',
  ownerSessionId: 'other-old',
  viewMessages: otherSessionMsgs,
  cachedMessages: []
});
assert(mixed.length === 0, 'stale view messages must not follow a new session');
const fromCache = selectHistoryMessagesForSession({
  runSessionId: 'tank-new',
  ownerSessionId: 'other-old',
  viewMessages: otherSessionMsgs,
  cachedMessages: tankCache
});
assert(fromCache.length === 1 && fromCache[0].content === '坦克项目', 'use cache for the run session');
const owned = selectHistoryMessagesForSession({
  runSessionId: 'tank-new',
  ownerSessionId: 'tank-new',
  viewMessages: tankCache,
  cachedMessages: otherSessionMsgs
});
assert(owned.length === 1 && owned[0].content === '坦克项目', 'owned view wins over other cache');
const srcMeta = [{ role: 'user', content: 'a', meta: { k: 1 } }];
const cloned = cloneHistoryMessages(srcMeta);
cloned[0].meta.k = 2;
assert(srcMeta[0].meta.k === 1, 'clone copies meta object');

assert(isSyntheticLoopUserContent('[系统] 本段工具轮次已达上限，请继续'), 'segment continue is synthetic');
assert(isSyntheticLoopUserContent('【完成验收】还没做完'), 'readiness user is synthetic');
assert(!isSyntheticLoopUserContent('【当前任务 / Current Task】\n修 bug'), 'current task is real');

const bookPrefix = [
  { role: 'system', content: '规则A' },
  { role: 'user', content: '上一问' },
  { role: 'assistant', content: '上一答' },
  { role: 'user', content: buildCurrentTaskText('这一问') }
];
const liveCompacted = [
  { role: 'system', content: '规则A' },
  { role: 'system', content: '【压缩摘要】丢掉的中间历史' },
  { role: 'user', content: '上一问' },
  { role: 'assistant', content: '上一答' },
  { role: 'user', content: buildCurrentTaskText('这一问') },
  { role: 'assistant', content: '', tool_calls: [{ id: '1', function: { name: 'fs_read_file' } }] },
  { role: 'tool', content: 'file body' },
  { role: 'user', content: '[系统] 本段工具轮次已达上限，请在同一会话中继续未完成任务，勿重复已完成的步骤。' }
];
const tail = extractInTurnLoopTail(liveCompacted);
assert(tail.length === 3, 'tail keeps tools and continue user');
assert(tail[0].role === 'assistant' && tail[1].role === 'tool', 'tool rounds stay in tail');
assert(isSyntheticLoopUserContent(tail[2].content), 'continue user stays in tail');

const continued = reprojectContinueLoopMessages({
  prefixMessages: bookPrefix,
  liveLoopMessages: liveCompacted,
  turnRide: archiveBlock
});
assert(continued[0].role === 'system' && continued[0].content === '规则A', 'prefix system from book');
assert(!JSON.stringify(continued).includes('丢掉的中间历史'), 'compacted in-loop history is dropped');
assert(String(continued[continued.length - 4].content).includes(COMPACTION_ARCHIVE_HEADER), 'archive on last real user');
assert(continued[continued.length - 1].role === 'user' && isSyntheticLoopUserContent(continued[continued.length - 1].content), 'continue user after tools');
assert(continued.some((m) => m.role === 'tool'), 'this-turn tool result kept');

const { capToolResultValue, capDelegateResults } = require('../src/agent/tool-result-cap');
const fat = capToolResultValue({ data: 'Z'.repeat(20000) }, 4000);
assert(fat && fat.truncated === true && String(fat.preview).length <= 4000, 'tool json is capped before loop ingest');
const cappedRows = capDelegateResults([{ id: '1', result: { data: 'Y'.repeat(50000) } }], 3000);
assert(cappedRows[0].result.truncated, 'delegate rows are capped');

const loopTail = trimMessagesToCharBudget(
  [
    { role: 'system', content: 's' },
    { role: 'user', content: '这一问' },
    { role: 'assistant', content: 'A'.repeat(20000) },
    { role: 'tool', content: `HEADUNIQUE${'T'.repeat(40000)}TAILUNIQUE` }
  ],
  {
    messageMaxChars: 2000,
    toolResultMaxChars: 3000,
    lastUserMaxChars: 8000,
    historyMaxChars: 1000,
    requestMaxChars: 80000
  }
);
const loopTool = loopTail.find((m) => m.role === 'tool');
const loopAsst = loopTail.find((m) => m.role === 'assistant');
assert(String(loopTool.content).length <= 3200, 'post-user tool tail is clipped');
assert(String(loopTool.content).includes('HEADUNIQUE') && String(loopTool.content).includes('TAILUNIQUE'), 'tool clip keeps head and tail');
assert(String(loopAsst.content).length <= 2100, 'post-user assistant tail is clipped');
assert(JSON.stringify(loopTail).includes('这一问'), 'keeps current user when clipping tail');

assert(
  isSyntheticLoopUserContent('【对话摘要 · 自动压缩 · 历史背景】\n继续完成全屏相关修改'),
  'legacy compact digest is still synthetic'
);
assert(
  isSyntheticLoopUserContent('【对话摘要 · 自动压缩】\n恢复目标与未完成项'),
  'compact digest is still synthetic'
);
assert(
  isSyntheticLoopUserContent(`${FOLDED_HISTORY_HEADER}\n此前 9 条已折叠`),
  'folded history user is synthetic'
);

const afterAssistant = buildCompletionMessagesFromHistory(
  [
    { role: 'user', content: '游戏还是很卡，还有什么解决方案？' },
    { role: 'assistant', content: '先查帧率' }
  ],
  packed.stable,
  null,
  false,
  null,
  '【本会话压缩摘要 / Compaction】\n继续完成全屏相关修改'
);
const taskUser = [...afterAssistant].reverse().find((m) => m.role === 'user');
assert(String(taskUser.content).includes('游戏还是很卡'), 'pins lag question as current task');
assert(!String(taskUser.content).includes('你本轮只需要完成下面这个问题：\n继续完成全屏'), 'digest must not replace task text');
assert(
  String(taskUser.content).indexOf('游戏还是很卡') < String(taskUser.content).indexOf(TURN_RIDE_HEADER),
  'lag question appears before background ride'
);

const nested = buildCurrentTaskText(buildCurrentTaskText('游戏还是很卡'));
assert((nested.match(/游戏还是很卡/g) || []).length === 1, 'current-task wrap is not nested');

console.log('test-session-context.cjs ok');

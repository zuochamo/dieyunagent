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
  contentCharLen,
  packMessageMeta,
  unpackMessageMeta,
  slimAttachmentsForPersist
} = require('../src/agent/session-context');
const { AGENT_LIMITS_DEFAULTS } = require('../src/agent/agent-limits');

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assert failed');
}

// 图片 part 必须按「等效字符」计入预算，而不是按 base64 长度。
// 否则一张 2MB 的图会被算成约 270 万字符，单张就顶穿 llmRequestMaxChars
// 这条长度硬上限、每轮误裁历史 —— 而图片既不可折叠也不可压缩。
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
  // D1 哨兵：正文投影/落库**不得**再咨询思考兜底；一旦被调用，下面断言必失败。
  thoughtFallback() {
    return 'LEAKED_THOUGHT';
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

// §3.4「不写进 book」：思考回退标签（仅展示）与空串在落库口统一换成占位。
assert(
  persistableAssistantText('', [], leakHelpers) === '（模型未生成文字答复。）',
  'empty turn persists the honest placeholder'
);
assert(
  persistableAssistantText('（以下为模型思考，本轮未成文）\n\n某段思考', [], leakHelpers) ===
    '（模型未生成文字答复。）',
  'reasoning-fallback label never lands in the book'
);

// D1 回归哨兵：即使 helpers 明确塞了思考兜底，落库与重建也**不得**再咨询它。
const thoughtOnlyHelpers = {
  toolFallback() {
    return '';
  },
  thoughtFallback: leakHelpers.thoughtFallback,
  splitPersistedAssistantTrace: (raw) => ({
    content: raw,
    trace: [{ round: 1, thought: '落库时被内嵌的思考' }]
  })
};
assert(
  persistableAssistantText('', liveTrace, thoughtOnlyHelpers) !== 'LEAKED_THOUGHT',
  'persist fold never falls back to reasoning'
);
assert(
  assistantTextFromMessage({ role: 'assistant', content: '' }, thoughtOnlyHelpers) !== 'LEAKED_THOUGHT',
  'history projection never falls back to reasoning'
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

// 账本投影是字段白名单（REASONING-ISOLATION D2）：只保留协议字段，
// 不把 UI 字段（meta / transientTrace）或思考通道（reasoning_content）交出去。
const liveAssistantRow = {
  role: 'assistant',
  content: '上一答',
  reasoning_content: '某一轮的真实思考',
  tool_calls: [{ id: 'c1', type: 'function', function: { name: 'grep', arguments: '{}' } }],
  tool_call_id: 'c1',
  name: 'assistant-name',
  meta: { modelId: 'deepseek-flash' },
  transientTrace: liveTrace
};
const projected = messagesForTranscript([
  { role: 'user', content: '上一问', meta: { k: 1 }, transientTrace: liveTrace },
  liveAssistantRow
]);
assert(projected.length === 2, 'projection keeps user/assistant rows');
assert(projected[0] !== undefined && !('meta' in projected[0]), 'projection drops UI meta');
assert(
  !('transientTrace' in projected[0]),
  'projection drops live transientTrace'
);
const projectedAssistant = projected[1];
assert(
  !('reasoning_content' in projectedAssistant),
  'projection never carries the reasoning channel into history'
);
assert(
  projectedAssistant.content === '上一答' &&
    Array.isArray(projectedAssistant.tool_calls) &&
    projectedAssistant.tool_call_id === 'c1' &&
    projectedAssistant.name === 'assistant-name',
  'projection keeps protocol fields (content / tool_calls / tool_call_id / name)'
);
assert(
  projectedAssistant !== liveAssistantRow,
  'projection returns copies, not the live view objects'
);

// 账本自有 `reasoning`（与 content 分列）走投影（上行回传真值来源），但**绝不**并进正文。
const bookRowWithReasoning = {
  role: 'assistant',
  content: '写在正文里的答复',
  reasoning: '这一轮的真实思考'
};
const projectedReasoning = messagesForTranscript([bookRowWithReasoning])[0];
assert(projectedReasoning.reasoning === '这一轮的真实思考', 'projection keeps the book reasoning field');
assert(projectedReasoning.content === '写在正文里的答复', 'reasoning never merges into content');
assert(
  messagesForTranscript([{ role: 'assistant', content: '答', reasoning: '   ' }])[0].reasoning === undefined,
  'blank reasoning is dropped by projection'
);

// D1 反转：重建历史时不把思考当正文 —— 无论它来自 `reasoning` 字段还是落库正文里内嵌的 trace。
const blankBookRow = { role: 'assistant', content: '', reasoning: '只有思考没有正文' };
assert(
  assistantTextFromMessage(blankBookRow, leakHelpers) === '',
  'book reasoning is not read back as assistant content'
);
const persistedThoughtTrace = [{ round: 1, thought: '落库时被内嵌的思考' }];
const traceOnlyHelpers = {
  toolFallback: () => '',
  splitPersistedAssistantTrace: (raw) => ({ content: raw, trace: persistedThoughtTrace })
};
assert(
  assistantTextFromMessage({ role: 'assistant', content: '' }, traceOnlyHelpers) === '',
  'persisted trace thought is no longer resurrected as content'
);
assert(
  assistantTextFromMessage({ role: 'assistant', content: '' }, {
    toolFallback: () => '已执行：fs_edit',
    splitPersistedAssistantTrace: (raw) => ({ content: raw, trace: persistedThoughtTrace })
  }) === '已执行：fs_edit',
  'tool fact fallback is still allowed'
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

// 重建出的 completion 消息带账本真思考作同级传输字段（供上行回传 reasoning_content），
// 但正文仍只是 content —— 该字段不进上下文语义（REASONING-ISOLATION §3.5）。
const withReasoningRow = buildCompletionMessagesFromHistory(
  [
    { role: 'user', content: '上一问' },
    { role: 'assistant', content: '上一答', reasoning: '上一轮的真思考' },
    { role: 'assistant', content: '', reasoning: '弱正文轮的真思考' },
    { role: 'user', content: '这一问' }
  ],
  packed.stable,
  null,
  false,
  leakHelpers,
  packed.turnRide
);
const carried = withReasoningRow.filter((m) => m.role === 'assistant');
assert(carried[0].content === '上一答' && carried[0].reasoning === '上一轮的真思考', 'reasoning rides beside content');
assert(
  carried[1].content === '' && carried[1].reasoning === '弱正文轮的真思考',
  'weak content is not replaced by its own reasoning'
);

// 每轮的 cap 先具名，断言一律挂在具名 cap 上；裸字面量边界改预算就会漂移。
const hugeCaps = {
  historyMaxChars: 12000,
  messageMaxChars: 3000,
  lastUserMaxChars: 8000,
  requestMaxChars: 20000
};
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
  hugeCaps
);
const hugeJson = JSON.stringify(hugeHist);
assert(!hugeJson.includes('x'.repeat(4000)), 'old user history is truncated');
assert(hugeJson.includes('这一问'), 'keeps current user turn');
assert(hugeJson.length <= hugeCaps.requestMaxChars + 10000, 'completion payload stays bounded');

const rideCaps = {
  lastUserMaxChars: 8000,
  turnRideMaxChars: 5000,
  historyMaxChars: 1000,
  messageMaxChars: 1000,
  requestMaxChars: 80000
};
const rideKeepTask = buildCompletionMessagesFromHistory(
  [{ role: 'user', content: '务必保留的任务句' }],
  'sys',
  null,
  false,
  null,
  `${TURN_RIDE_HEADER}\n${'R'.repeat(40000)}`,
  rideCaps
);
const lastKeep = rideKeepTask[rideKeepTask.length - 1];
assert(String(lastKeep.content).includes('务必保留的任务句'), 'truncating turn-ride keeps current task');
assert(
  !String(lastKeep.content).includes('R'.repeat(rideCaps.lastUserMaxChars)),
  'turn-ride is capped'
);

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

// 审计出参（request_snapshots.context_audit_json 的唯一来源）：
// 折叠/裁剪的事实必须由这里产出，Main 不重算。未传 audit 时行为必须完全不变。
{
  const longTurnRide = '骑手位上下文'.repeat(4000);
  const many = [{ role: 'system', content: 'sys' }];
  for (let i = 0; i < 40; i++) {
    many.push({ role: 'user', content: `旧问${i}` });
    many.push({ role: 'assistant', content: `旧答${i}` });
  }
  many.push({ role: 'user', content: attachTurnRideToUserContent('当前任务', longTurnRide) });

  const noAudit = buildCompletionMessagesFromHistory(many, 'sys', null, false, null, '', {
    recentTurns: 4,
    historyMaxChars: 2000,
    requestMaxChars: 3000,
    foldedMaxChars: 500
  });
  const audit = {};
  const withAudit = buildCompletionMessagesFromHistory(many, 'sys', null, false, null, '', {
    recentTurns: 4,
    historyMaxChars: 2000,
    requestMaxChars: 3000,
    foldedMaxChars: 500,
    audit
  });
  assert(JSON.stringify(noAudit) === JSON.stringify(withAudit), 'audit 出参不得改变拼装结果');
  assert(audit.fold && audit.fold.foldedCount > 0, 'audit 记录折叠条数');
  assert(audit.fold.keptRecentTurns === 4, 'audit 记录保留窗口');
  assert(audit.fold.foldMaxChars === 500, 'audit 记录折叠上限');
  assert(typeof audit.fold.cutRole === 'string', 'audit 记录断点角色');

  // 只裁剪不折叠的场景（折叠窗口很大 → 不折，但历史/硬顶预算不够 → 必须丢）
  const long = [{ role: 'system', content: 'sys' }];
  for (let i = 0; i < 40; i++) {
    long.push({ role: 'user', content: `旧问${i}` + 'x'.repeat(200) });
    long.push({ role: 'assistant', content: `旧答${i}` + 'y'.repeat(200) });
  }
  long.push({ role: 'user', content: attachTurnRideToUserContent('当前任务', longTurnRide) });
  const trimAudit = {};
  buildCompletionMessagesFromHistory(long, 'sys', null, false, null, '', {
    recentTurns: 999,
    historyMaxChars: 2000,
    requestMaxChars: 3000,
    lastUserMaxChars: 400,
    turnRideMaxChars: 400,
    messageMaxChars: 100,
    audit: trimAudit
  });
  assert(!trimAudit.fold, '窗口够大时不折叠');
  assert(trimAudit.trim, 'audit 记录裁剪事实');
  assert(trimAudit.trim.messagesIn > trimAudit.trim.messagesOut, 'audit 记录进/出条数差');
  assert(trimAudit.trim.requestMaxChars === 3000, 'audit 记录硬顶');
  assert(
    trimAudit.trim.droppedByHistoryBudget + trimAudit.trim.droppedByRequestCap > 0,
    'audit 记录到底哪一层丢的'
  );
  assert(trimAudit.trim.perMessageTruncated > 0, 'audit 记录被截断的条数（含当前任务那条）');

  // 不需要折叠/裁剪时，不写空账（避免每轮都多一段无意义的 json）
  const smallAudit = {};
  buildCompletionMessagesFromHistory([{ role: 'user', content: 'hi' }], 'sys', null, false, null, '', {
    recentTurns: 24,
    audit: smallAudit
  });
  assert(!smallAudit.fold && !smallAudit.trim, '未发生折叠/裁剪时不写审计块');
}

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
const archiveCap = 100;
const long = 'x'.repeat(3000);
const clipped = formatCompactionArchiveBlock([{ summary_text: long }], archiveCap);
assert(clipped.includes('…'), 'clips archive summary');
assert(!clipped.includes('x'.repeat(archiveCap + 1)), 'archive summary is cut to maxChars');
assert(clipped.length < archiveCap + 200, 'archive block stays near maxChars');

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
const toolCap = 4000;
const fat = capToolResultValue({ data: 'Z'.repeat(20000) }, toolCap);
assert(
  fat && fat.truncated === true && String(fat.preview).length <= toolCap,
  'tool json is capped before loop ingest'
);
const cappedRows = capDelegateResults([{ id: '1', result: { data: 'Y'.repeat(50000) } }], 3000);
assert(cappedRows[0].result.truncated, 'delegate rows are capped');

const tailCaps = {
  messageMaxChars: 2000,
  toolResultMaxChars: 3000,
  lastUserMaxChars: 8000,
  historyMaxChars: 1000,
  requestMaxChars: 80000
};
const loopTail = trimMessagesToCharBudget(
  [
    { role: 'system', content: 's' },
    { role: 'user', content: '这一问' },
    { role: 'assistant', content: 'A'.repeat(20000) },
    { role: 'tool', content: `HEADUNIQUE${'T'.repeat(40000)}TAILUNIQUE` }
  ],
  tailCaps
);
const loopTool = loopTail.find((m) => m.role === 'tool');
const loopAsst = loopTail.find((m) => m.role === 'assistant');
assert(
  String(loopTool.content).length <= tailCaps.toolResultMaxChars + 200,
  'post-user tool tail is clipped'
);
assert(String(loopTool.content).includes('HEADUNIQUE') && String(loopTool.content).includes('TAILUNIQUE'), 'tool clip keeps head and tail');
assert(
  String(loopAsst.content).length <= tailCaps.messageMaxChars + 100,
  'post-user assistant tail is clipped'
);
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

// 落库 meta：附件只存引用，meta 不收字节。
//
// 实库里曾出现 assistant meta 带 attachments[]._pasteBase64 + _base64（单行 2.9MB，
// 123 行共 38.4MB）：根因是 renderer 把内存里的暂存附件整份展开进 assistant meta，
// 而 packAssistantMeta 不过滤。现在打包只有 packMessageMeta 一处，且「字节不得进
// meta」是硬约束，不依赖调用点自觉。
const hugeBase64 = 'A'.repeat(1_453_696);
const persistedUser = packMessageMeta(
  '修一下这个报错',
  {
    inputText: '修一下这个报错',
    modeLabel: 'Agent',
    attachments: [
      {
        path: '/tmp/a.png',
        absolutePath: 'C:/tmp/a.png',
        originalName: 'a.png',
        size: 1090272,
        mime: 'image/png',
        previewUrl: 'blob:http://localhost/9f2c',
        _pasteBase64: hugeBase64,
        _base64: hugeBase64
      }
    ]
  },
  { role: 'user' }
);
assert(persistedUser.length < 1000, 'user meta never carries bytes');
assert(!persistedUser.includes('AAAA'), 'user meta drops base64');
assert(!persistedUser.includes('blob:'), 'user meta drops object URLs');
const userUnpacked = unpackMessageMeta(persistedUser);
assert(userUnpacked.content === '修一下这个报错', 'user body round-trips');
assert(userUnpacked.meta.attachments.length === 1, 'user attachment reference is kept');
assert(userUnpacked.meta.attachments[0].path === '/tmp/a.png', 'attachment path is kept');
assert(userUnpacked.meta.attachments[0].size === 1090272, 'attachment size stays a number');
assert(!('modeLabel' in userUnpacked.meta), 'user meta does not pick up composer turn fields');

const persistedAssistant = packMessageMeta('改完了。', {
  modeLabel: 'Agent',
  modelId: 'deepseek-flash',
  ts: 1789943793526,
  inputText: '修一下这个报错',
  attachments: [{ path: '/tmp/a.png', _pasteBase64: hugeBase64 }],
  previewUrl: `data:image/png;base64,${hugeBase64}`
});
assert(persistedAssistant.length < 500, 'assistant meta never carries bytes');
assert(!persistedAssistant.includes('AAAA'), 'assistant meta drops base64');
assert(!persistedAssistant.includes('data:'), 'assistant meta drops data URLs');
const assistantUnpacked = unpackMessageMeta(persistedAssistant);
assert(assistantUnpacked.content === '改完了。', 'assistant body round-trips');
assert(assistantUnpacked.meta.modelId === 'deepseek-flash', 'turn metadata survives');
assert(!('attachments' in assistantUnpacked.meta), 'assistant does not duplicate the user attachment');
assert(!('previewUrl' in assistantUnpacked.meta), 'ephemeral preview URL is dropped');

const bare = unpackMessageMeta('裸正文');
assert(bare.content === '裸正文' && bare.meta === null, 'plain content has no meta');
assert(
  unpackMessageMeta('【叠云meta】{坏 json\n正文').content.includes('坏 json'),
  'broken meta falls back to raw text'
);
assert(packMessageMeta('正文', null) === '正文', 'no meta means untouched content');
assert(packMessageMeta('正文', {}) === '正文', 'empty meta does not add a prefix');

const slimmedAtts = slimAttachmentsForPersist([
  { absolutePath: 'C:/x.png', _pasteBase64: hugeBase64, previewUrl: 'blob:x' },
  { _pasteBase64: hugeBase64 },
  null
]);
assert(
  slimmedAtts.length === 1 && slimmedAtts[0].absolutePath === 'C:/x.png',
  'slim keeps only reference-shaped attachments'
);

// 回合触发归因：定时计划 / 目标续跑这类「系统自己开的一轮」必须能与用户输入区分开，
// 否则回放、手机端与交接时无法分辨这条到底是不是用户打的字。
const planTurn = require('../src/plans/plan-run-turn');
const plan = { id: 'p1', name: '每日构建', trigger: 'schedule', prompt: '跑一遍测试' };
const scheduleTurn = planTurn.planRunUserTurn(plan);
const scheduleUnpacked = unpackMessageMeta(scheduleTurn.content);
assert(scheduleUnpacked.content === scheduleTurn.userText, '触发轮的正文（= 模型输入）原样保留');
assert(scheduleUnpacked.meta.trigger.kind === 'schedule', 'schedule 触发类型落库');
assert(scheduleUnpacked.meta.trigger.planId === 'p1', '计划 id 落库');
assert(scheduleUnpacked.meta.trigger.planName === '每日构建', '计划名直接用于触发条标题');
assert(
  Number.isFinite(Date.parse(scheduleUnpacked.meta.trigger.at)),
  '触发时间可被 Renderer 解析成时钟'
);
assert(
  planTurn.planRunUserTurn({ ...plan, trigger: 'goal' }).content.includes('"kind":"goal"'),
  '目标续跑用独立 kind，不与定时触发混淆'
);

const strayTrigger = packMessageMeta(
  '正文',
  { trigger: { kind: 'schedule', planName: 'x', sneaky: 'should drop' } },
  { role: 'user' }
);
assert(!strayTrigger.includes('sneaky'), 'trigger 只收登记过的字段');
assert(
  packMessageMeta('正文', { trigger: { planId: 'p1' } }, { role: 'user' }) === '正文',
  '没有 kind 的 trigger 不落库'
);
const strippedAssistant = unpackMessageMeta(
  packMessageMeta('改完了。', { trigger: { kind: 'schedule' } })
);
assert(
  !strippedAssistant.meta || !strippedAssistant.meta.trigger,
  'assistant 行不复制触发归因'
);

console.log('test-session-context.cjs ok');

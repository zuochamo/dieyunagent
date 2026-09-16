'use strict';

const sessionTranscript =
  typeof require === 'function' && typeof module !== 'undefined' && module.exports
    ? require('./session-transcript')
    : null;

const agentLimitsDefaults =
  typeof require === 'function' && typeof module !== 'undefined' && module.exports
    ? require('./agent-limits').AGENT_LIMITS_DEFAULTS
    : null;

/**
 * 单个图片 part 计入上下文预算时的等效字符数。
 *
 * 图片在真实请求里由服务端换算成「图片 token」，与 base64 长度无关。
 * 若按 JSON.stringify(part).length 计（一张 1MB 图 ≈ 140 万字符），单张图就会顶穿
 * llmRequestMaxChars，并让 shouldCompactRound 从第一轮起就误触发压缩；而图片既不可
 * 折叠（当前任务永不折叠）又不可压缩，于是变成「反复花模型调用去压一个压不掉的东西」。
 *
 * 懒读全局，避免 renderer 打包顺序导致取不到 agent-limits 的值。
 */
function visionPartEquivChars() {
  const fromGlobal =
    typeof globalThis !== 'undefined' ? globalThis.AGENT_LIMITS_DEFAULTS : null;
  const n = Number((fromGlobal || agentLimitsDefaults || {}).visionPartEqChars);
  return Number.isFinite(n) && n > 0 ? n : 6000;
}

function isVisionPart(part) {
  return !!(part && typeof part === 'object' && part.type === 'image_url');
}

function messagesForTranscript(messages) {
  const fn =
    (sessionTranscript && sessionTranscript.transcriptFromMessages) ||
    (typeof transcriptFromMessages === 'function' ? transcriptFromMessages : null);
  if (typeof fn === 'function') return fn(messages);
  return (Array.isArray(messages) ? messages : []).filter(
    (m) => m && (m.role === 'user' || m.role === 'assistant')
  );
}

const SESSION_HISTORY_HEADER =
  '【本会话近期对话 — 同一会话内已发生的真实往来，追问「刚才说了什么/继续上文」时以此为准】';

const COMPACTION_ARCHIVE_HEADER = '【本会话压缩摘要 / Compaction】';

const FOLDED_HISTORY_HEADER = '【较早对话 · 已折叠】';

const TURN_RIDE_HEADER = '【本轮上下文 / Turn Context】';

function joinPromptChunks(chunks) {
  return (Array.isArray(chunks) ? chunks : [])
    .map((c) => String(c || '').trim())
    .filter(Boolean)
    .join('\n\n');
}

function packSystemPrompt(stableChunks, turnChunks) {
  const stable = joinPromptChunks(stableChunks);
  const turnRide = joinPromptChunks(turnChunks);
  return {
    stable,
    turnRide,
    content: joinPromptChunks([stable, turnRide])
  };
}

function unwrapSystemPromptPack(pack) {
  if (pack && typeof pack === 'object' && !Array.isArray(pack)) {
    const stable = String(pack.stable || '');
    const turnRide = String(pack.turnRide || '');
    const content = String(pack.content || joinPromptChunks([stable, turnRide]));
    return { stable, turnRide, content };
  }
  const content = String(pack || '');
  return { stable: content, turnRide: '', content };
}

/** Append per-turn ephemeral context after the current-task text (not system). */
function attachTurnRideToUserContent(userContent, turnRide) {
  const ride = String(turnRide || '').trim();
  if (!ride) return userContent;
  const block = `${TURN_RIDE_HEADER}\n${ride}`;
  if (userContent && Array.isArray(userContent)) {
    const parts = userContent.map((p) =>
      p && typeof p === 'object' && p.type === 'text' ? { ...p } : p
    );
    const firstText = parts.find((p) => p && typeof p === 'object' && p.type === 'text');
    if (firstText) {
      firstText.text = `${String(firstText.text || '').trim()}\n\n${block}`;
      return parts;
    }
    return [{ type: 'text', text: block }, ...parts];
  }
  const body = String(userContent || '').trim();
  return body ? `${body}\n\n${block}` : block;
}

/**
 * Project the latest persisted compaction archive into turn-ride.
 * Archives are part of the session book; this does not scrape live loop messages.
 */
function formatCompactionArchiveBlock(rows, maxChars) {
  const list = Array.isArray(rows) ? rows : [];
  const cap = Number(maxChars) > 0 ? Number(maxChars) : 2400;
  let text = '';
  for (const row of list) {
    if (!row || typeof row !== 'object') continue;
    const next = String(row.summary_text || row.summaryText || '').trim();
    if (next) {
      text = next;
      break;
    }
  }
  if (!text) return '';
  if (text.length > cap) text = `${text.slice(0, cap)}…`;
  return [
    COMPACTION_ARCHIVE_HEADER,
    '以下是较早轮次的压缩背景（目标、约束、已改文件、未完成项）。与【当前任务】冲突时以当前任务原文为准。',
    text
  ].join('\n');
}

function mergeCompactionBlockIntoTurnRide(turnRide, archiveBlock) {
  const ride = String(turnRide || '').trim();
  const block = String(archiveBlock || '').trim();
  if (!block) return ride;
  if (!ride) return block;
  const start = ride.indexOf(COMPACTION_ARCHIVE_HEADER);
  if (start < 0) return joinPromptChunks([ride, block]);
  return joinPromptChunks([ride.slice(0, start).trim(), block]);
}

function userContentToText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => (p && typeof p === 'object' && p.type === 'text' ? String(p.text || '') : ''))
      .join('\n');
  }
  return String(content || '');
}

function isHistoryBackgroundUserContent(content) {
  const t = userContentToText(content).trim();
  if (!t) return false;
  if (t.startsWith(FOLDED_HISTORY_HEADER)) return true;
  if (t.startsWith(COMPACTION_ARCHIVE_HEADER)) return true;
  if (t.startsWith('【对话摘要')) return true;
  if (t.includes('【对话摘要】') || t.includes('【对话摘要 ·')) return true;
  return false;
}

function isSyntheticLoopUserContent(content) {
  const t = userContentToText(content).trim();
  if (isHistoryBackgroundUserContent(content)) return true;
  if (t.startsWith('【完成验收】')) return true;
  if (!t.startsWith('[系统] ')) return false;
  return (
    t.startsWith('[系统] 本段工具轮次已达上限') ||
    t.startsWith('[系统] 上一轮回复像中间检查过程') ||
    t.startsWith('[系统] 你声明了 agent_status') ||
    t.startsWith('[系统] 修改/修复类任务禁止反复只输出')
  );
}

function lastRealUserIndex(messages) {
  const list = Array.isArray(messages) ? messages : [];
  let idx = -1;
  for (let i = 0; i < list.length; i++) {
    const m = list[i];
    if (m && m.role === 'user' && !isSyntheticLoopUserContent(m.content)) idx = i;
  }
  return idx;
}

/** Session-book prefix: system + real user/assistant through the current-task user. */
function extractBookPrefixMessages(messages) {
  const list = Array.isArray(messages) ? messages : [];
  const lastReal = lastRealUserIndex(list);
  if (lastReal < 0) return list.slice();
  return list.slice(0, lastReal + 1);
}

/** This-turn loop tail: tool rounds and synthetic continue users after the current-task user. */
function extractInTurnLoopTail(liveMessages) {
  const list = Array.isArray(liveMessages) ? liveMessages : [];
  const lastReal = lastRealUserIndex(list);
  if (lastReal < 0) return [];
  return list.slice(lastReal + 1);
}

function stripTurnRideFromUserContent(userContent) {
  const stripText = (text) => {
    const s = String(text || '');
    if (s.startsWith(TURN_RIDE_HEADER)) {
      const marker = '\n\n【当前任务';
      const idx = s.indexOf(marker);
      if (idx >= 0) return s.slice(idx + 2);
      const split = s.indexOf('\n\n');
      return split >= 0 ? s.slice(split + 2) : s;
    }
    const appended = s.indexOf(`\n\n${TURN_RIDE_HEADER}`);
    if (appended >= 0) return s.slice(0, appended);
    return s;
  };
  if (userContent && Array.isArray(userContent)) {
    let stripped = false;
    return userContent.map((p) => {
      if (stripped || !p || typeof p !== 'object' || p.type !== 'text') return p;
      stripped = true;
      return { ...p, text: stripText(p.text) };
    });
  }
  return stripText(userContent);
}

function applyTurnRideToCompletionMessages(completionMessages, turnRide) {
  const list = Array.isArray(completionMessages) ? completionMessages.map((m) => ({ ...m })) : [];
  for (let i = list.length - 1; i >= 0; i--) {
    if (!list[i] || list[i].role !== 'user') continue;
    if (isSyntheticLoopUserContent(list[i].content)) continue;
    list[i] = {
      ...list[i],
      content: attachTurnRideToUserContent(stripTurnRideFromUserContent(list[i].content), turnRide)
    };
    break;
  }
  return list;
}

/**
 * Continue/retry projector: book prefix + this-turn live tail.
 * Drops compacted in-loop history; compaction belongs in turn-ride via archives.
 */
function reprojectContinueLoopMessages(opts) {
  const live = opts && opts.liveLoopMessages;
  const prefixSource =
    opts && Array.isArray(opts.prefixMessages) && opts.prefixMessages.length
      ? opts.prefixMessages
      : extractBookPrefixMessages(live);
  const prefix = applyTurnRideToCompletionMessages(prefixSource, opts && opts.turnRide);
  if (!prefix.length) return Array.isArray(live) ? live.slice() : [];
  return prefix.concat(extractInTurnLoopTail(live));
}

const WEAK_ASSISTANT_REPLIES = new Set(['', '(空响应)', '已停止生成。']);

function isWeakAssistantReply(text) {
  return WEAK_ASSISTANT_REPLIES.has(String(text || '').trim());
}

function unwrapCurrentTaskPlainText(raw) {
  const stripped = stripTurnRideFromUserContent(raw);
  const t = typeof stripped === 'string' ? stripped : userContentToText(stripped);
  const text = String(t || '').trim();
  const header = '【当前任务 / Current Task】\n你本轮只需要完成下面这个问题：\n';
  if (text.startsWith(header)) {
    const rest = text.slice(header.length);
    const split = rest.indexOf('\n\n【使用上文的方式】');
    return (split >= 0 ? rest.slice(0, split) : rest).trim();
  }
  return text;
}

function buildCurrentTaskText(rawText) {
  const text = unwrapCurrentTaskPlainText(rawText) || '完成用户请求';
  return [
    '【当前任务 / Current Task】',
    '你本轮只需要完成下面这个问题：',
    text,
    '',
    '【使用上文的方式】',
    '压缩摘要与折叠历史用来恢复同一会话的目标与进展。本段是用户最新原文：若提出新需求则只做本段；若是追问或未改目标，接着摘要里的未完成工作做。不要因为历史已折叠就问用户「本轮做什么」。仅当本段与摘要仍对应多种互斥理解时再澄清。'
  ].join('\n');
}

function wrapPreparedCurrentTaskContent(prepared, text) {
  const currentTask = buildCurrentTaskText(text);
  if (prepared && Array.isArray(prepared.content)) {
    const parts = prepared.content.slice();
    const firstText = parts.find((p) => p && typeof p === 'object' && p.type === 'text');
    if (firstText) {
      firstText.text = currentTask;
      return parts;
    }
    return [{ type: 'text', text: currentTask }, ...parts];
  }
  return currentTask;
}

/**
 * Fold a weak live reply into persisted transcript text using the same-turn tool trace.
 * Call this at write time so the next turn can project from content alone.
 */
function persistableAssistantText(reply, trace, helpers) {
  const raw = String(reply == null ? '' : reply);
  if (!isWeakAssistantReply(raw)) return raw;
  const h = helpers || {};
  const toolFallback = typeof h.toolFallback === 'function' ? h.toolFallback : () => '';
  const thoughtFallback = typeof h.thoughtFallback === 'function' ? h.thoughtFallback : () => '';
  const t = Array.isArray(trace) ? trace : [];
  if (!t.length) return raw;
  return toolFallback(t) || thoughtFallback(t) || raw;
}

/** Project assistant text from persisted content only. Live transientTrace is UI-only. */
function assistantTextFromMessage(message, helpers) {
  const h = helpers || {};
  const unpackAssistantMeta =
    typeof h.unpackAssistantMeta === 'function' ? h.unpackAssistantMeta : (raw) => ({ content: raw });
  const splitTrace =
    typeof h.splitPersistedAssistantTrace === 'function'
      ? h.splitPersistedAssistantTrace
      : (raw) => ({ content: raw, trace: null });
  const toolFallback = typeof h.toolFallback === 'function' ? h.toolFallback : () => '';
  const thoughtFallback = typeof h.thoughtFallback === 'function' ? h.thoughtFallback : () => '';

  const { content: raw } = unpackAssistantMeta(message && message.content);
  const split = splitTrace(raw);
  let text = String(split.content || '').trim();
  if (WEAK_ASSISTANT_REPLIES.has(text)) {
    const persistedTrace = split.trace;
    if (persistedTrace && persistedTrace.length) {
      text = toolFallback(persistedTrace) || thoughtFallback(persistedTrace) || text;
    }
  }
  return text;
}

/**
 * 选用本会话历史：视图 messages 必须已归属 runSessionId，否则只用该会话缓存。
 * 禁止把上一会话残留数组带进新对话（串台）。
 */
function selectHistoryMessagesForSession(opts = {}) {
  const runSid = String(opts.runSessionId || '').trim();
  const ownerSid = opts.ownerSessionId != null ? String(opts.ownerSessionId).trim() : '';
  const view = Array.isArray(opts.viewMessages) ? opts.viewMessages : [];
  if (runSid && ownerSid && runSid === ownerSid) return view.slice();
  const cached = Array.isArray(opts.cachedMessages) ? opts.cachedMessages : [];
  return cached.slice();
}

function cloneHistoryMessages(list) {
  return (Array.isArray(list) ? list : []).map((m) => {
    if (!m || typeof m !== 'object') return m;
    return {
      ...m,
      meta: m.meta && typeof m.meta === 'object' ? { ...m.meta } : m.meta
    };
  });
}

function buildSessionChatHistoryFromMessages(messages, opts, helpers) {
  const list = messagesForTranscript(messages);
  const maxTurns = Number(opts && opts.maxTurns) > 0 ? Number(opts.maxTurns) : 8;
  const maxChars = Number(opts && opts.maxChars) > 0 ? Number(opts.maxChars) : 14000;
  const compact =
    typeof (helpers && helpers.compactPlainText) === 'function'
      ? helpers.compactPlainText
      : (s, n) => String(s || '').slice(0, n);
  const unpackUser =
    typeof (helpers && helpers.unpackUserContent) === 'function'
      ? helpers.unpackUserContent
      : (raw) => String(raw || '').trim();

  let end = list.length;
  if (opts && opts.excludeLastUser !== false && end > 0 && list[end - 1].role === 'user') {
    end -= 1;
  }
  const rows = [];
  for (let i = end - 1; i >= 0 && rows.length < maxTurns; i--) {
    const m = list[i];
    if (!m || (m.role !== 'user' && m.role !== 'assistant')) continue;
    const content =
      m.role === 'user' ? unpackUser(m.content) : assistantTextFromMessage(m, helpers);
    if (!content) continue;
    rows.unshift({ role: m.role, content: compact(content, 4500) });
  }
  if (!rows.length) return '';
  let block = rows.map((r) => `[${r.role}]\n${r.content}`).join('\n\n');
  if (block.length > maxChars) {
    block = block.slice(block.length - maxChars);
    const cut = block.indexOf('\n\n[');
    if (cut > 0 && cut < 800) block = block.slice(cut + 2);
  }
  return `${SESSION_HISTORY_HEADER}\n${block}`;
}

function contentCharLen(content) {
  if (content == null) return 0;
  if (typeof content === 'string') return content.length;
  if (Array.isArray(content)) {
    let n = 0;
    for (const p of content) {
      if (typeof p === 'string') n += p.length;
      // 图片按等效字符计，不按 base64 长度计（见 visionPartEquivChars）
      else if (isVisionPart(p)) n += visionPartEquivChars();
      else if (p && typeof p === 'object') {
        if (typeof p.text === 'string') n += p.text.length;
        else n += JSON.stringify(p).length;
      }
    }
    return n;
  }
  if (typeof content === 'object') return JSON.stringify(content).length;
  return String(content).length;
}

function truncateContent(content, maxChars, opts) {
  const cap = Math.max(0, Number(maxChars) || 0);
  if (!cap) return typeof content === 'string' ? '' : content;
  if (typeof content === 'string') {
    if (content.length <= cap) return content;
    const keepTail = opts && opts.keepTail && cap >= 400;
    if (keepTail) {
      const head = Math.floor(cap * 0.7);
      const tail = Math.max(64, cap - head);
      const omitted = content.length - head - tail;
      return `${content.slice(0, head)}\n…（已截断中间 ${omitted} 字符）\n${content.slice(-tail)}`;
    }
    return `${content.slice(0, cap)}\n…（已截断，原文 ${content.length} 字符）`;
  }
  if (Array.isArray(content)) {
    const out = [];
    let used = 0;
    for (const p of content) {
      if (used >= cap) break;
      // 图片原样保留：它的预算已由 contentCharLen 按「等效字符」计（见 visionPartEquivChars），
      // 不按 base64 长度计。这里不能按长度判「图片过大已省略」——那会静默丢掉用户刚发的图。
      if (isVisionPart(p)) {
        out.push(p);
        continue;
      }
      const text = typeof p === 'string' ? p : p && typeof p === 'object' ? String(p.text || '') : '';
      const room = cap - used;
      if (text.length <= room) {
        out.push(p);
        used += text.length;
      } else {
        const cut = `${text.slice(0, Math.max(0, room))}\n…（已截断）`;
        out.push(typeof p === 'string' ? cut : { ...p, text: cut });
        used = cap;
      }
    }
    return out.length ? out : '';
  }
  return truncateContent(String(content || ''), cap, opts);
}

const DEFAULT_COMPLETION_CAPS = {
  historyMaxChars: 96000,
  messageMaxChars: 8000,
  lastUserMaxChars: 24000,
  turnRideMaxChars: 32000,
  requestMaxChars: 800000,
  recentTurns: 24,
  foldedMaxChars: 12000,
  toolResultMaxChars: 14000
};

function resolveCompletionCaps(opts) {
  const o = opts && typeof opts === 'object' ? opts : {};
  const n = (v, d) => {
    const x = Number(v);
    return Number.isFinite(x) && x > 0 ? Math.floor(x) : d;
  };
  return {
    historyMaxChars: n(o.historyMaxChars, DEFAULT_COMPLETION_CAPS.historyMaxChars),
    messageMaxChars: n(o.messageMaxChars, DEFAULT_COMPLETION_CAPS.messageMaxChars),
    lastUserMaxChars: n(o.lastUserMaxChars, DEFAULT_COMPLETION_CAPS.lastUserMaxChars),
    turnRideMaxChars: n(o.turnRideMaxChars, DEFAULT_COMPLETION_CAPS.turnRideMaxChars),
    requestMaxChars: n(o.requestMaxChars, DEFAULT_COMPLETION_CAPS.requestMaxChars),
    recentTurns: n(o.recentTurns, DEFAULT_COMPLETION_CAPS.recentTurns),
    foldedMaxChars: n(o.foldedMaxChars, DEFAULT_COMPLETION_CAPS.foldedMaxChars),
    toolResultMaxChars: n(o.toolResultMaxChars, DEFAULT_COMPLETION_CAPS.toolResultMaxChars)
  };
}

function clipFoldText(s, n) {
  const t = String(s || '');
  if (t.length <= n) return t;
  return `${t.slice(0, Math.max(0, n - 1))}…`;
}

function messageFoldSnippet(m, per) {
  const role = m && m.role ? String(m.role) : '?';
  let body = userContentToText(m && m.content);
  if (m && m.tool_calls) {
    try {
      body = `${body}\n${JSON.stringify(m.tool_calls)}`.trim();
    } catch {
      /* ignore malformed tool_calls */
    }
  }
  const oneLine = body.replace(/\s+/g, ' ').trim();
  return `[${role}] ${clipFoldText(oneLine, per)}`;
}

/**
 * Keep the last N book messages verbatim; fold older chat into one bounded stub.
 * Never fold the in-turn tool chain after the latest real user (current task) —
 * counting raw assistant/tool rows as "recentTurns" was destroying mid-run reads.
 * If the cut would start on a tool result, walk back so the window starts on its assistant.
 */
function foldOlderCompletionMessages(messages, helpers, opts) {
  const caps = resolveCompletionCaps(opts);
  const src = Array.isArray(messages) ? messages : [];
  if (!src.length) return src;
  const systems = [];
  const rest = [];
  for (const m of src) {
    if (m && m.role === 'system') systems.push(m);
    else rest.push(m);
  }
  const lastRealInRest = lastRealUserIndex(rest);
  const book = lastRealInRest >= 0 ? rest.slice(0, lastRealInRest + 1) : rest;
  const loopTail = lastRealInRest >= 0 ? rest.slice(lastRealInRest + 1) : [];
  if (book.length <= caps.recentTurns) return src;
  let cut = book.length - caps.recentTurns;
  while (cut > 0 && book[cut] && book[cut].role === 'tool') cut -= 1;
  if (cut <= 0) return src;
  const older = book.slice(0, cut);
  const recentBook = book.slice(cut);
  const compact =
    helpers && typeof helpers.compactPlainText === 'function'
      ? (t, n) => helpers.compactPlainText(t, n)
      : clipFoldText;
  const per = Math.min(800, Math.max(160, Math.floor(caps.foldedMaxChars / Math.max(older.length, 1))));
  const body = compact(older.map((m) => messageFoldSnippet(m, per)).join('\n'), caps.foldedMaxChars);
  const folded = {
    role: 'user',
    content: [
      FOLDED_HISTORY_HEADER,
      `此前 ${older.length} 条已折叠。用本段恢复目标、约束、已改文件和未完成项；与【当前任务】冲突时以当前任务为准。`,
      '',
      body
    ].join('\n')
  };
  return systems.concat(folded, recentBook, loopTail);
}

function messagesCharLen(list) {
  return (Array.isArray(list) ? list : []).reduce(
    (sum, m) =>
      sum + contentCharLen(m && m.content) + JSON.stringify(m && m.tool_calls ? m.tool_calls : '').length,
    0
  );
}

function splitRideAndTaskText(s) {
  const text = String(s || '');
  if (text.startsWith(TURN_RIDE_HEADER)) {
    const marker = '\n\n【当前任务';
    const idx = text.indexOf(marker);
    if (idx >= 0) return { ride: text.slice(0, idx), task: text.slice(idx + 2) };
    const split = text.indexOf('\n\n');
    if (split >= 0) return { ride: text.slice(0, split), task: text.slice(split + 2) };
    return { ride: text, task: '' };
  }
  const rideAt = text.indexOf(`\n\n${TURN_RIDE_HEADER}`);
  if (rideAt >= 0) {
    return { task: text.slice(0, rideAt), ride: text.slice(rideAt + 2) };
  }
  return { ride: '', task: text };
}

function joinRideAndTaskText(ride, task) {
  const r = String(ride || '').trim();
  const t = String(task || '');
  if (!r) return t;
  if (!t) return r;
  return `${t}\n\n${r}`;
}

function truncateLastUserKeepingTask(content, caps) {
  const rideCap = caps.turnRideMaxChars;
  const taskCap = caps.lastUserMaxChars;
  if (Array.isArray(content)) {
    const parts = content.map((p) => (p && typeof p === 'object' ? { ...p } : p));
    const firstText = parts.find((p) => p && typeof p === 'object' && p.type === 'text');
    if (!firstText) return truncateContent(content, rideCap + taskCap);
    const split = splitRideAndTaskText(firstText.text);
    firstText.text = joinRideAndTaskText(
      truncateContent(split.ride, rideCap),
      truncateContent(split.task, taskCap)
    );
    return parts;
  }
  const split = splitRideAndTaskText(content);
  return joinRideAndTaskText(
    truncateContent(split.ride, rideCap),
    truncateContent(split.task, taskCap)
  );
}

/**
 * Keep last user; drop/truncate older turns so the payload stays under proxy Input length.
 */
function trimMessagesToCharBudget(messages, opts) {
  const caps = resolveCompletionCaps(opts);
  const src = Array.isArray(messages) ? messages.map((m) => (m && typeof m === 'object' ? { ...m } : m)) : [];
  if (!src.length) return src;
  const systems = [];
  const rest = [];
  for (const m of src) {
    if (m && m.role === 'system') systems.push(m);
    else rest.push(m);
  }
  let lastUser = -1;
  for (let i = rest.length - 1; i >= 0; i--) {
    if (rest[i] && rest[i].role === 'user' && !isSyntheticLoopUserContent(rest[i].content)) {
      lastUser = i;
      break;
    }
  }
  if (lastUser < 0) lastUser = rest.length - 1;
  if (lastUser >= 0 && rest[lastUser]) {
    rest[lastUser] = {
      ...rest[lastUser],
      content: truncateLastUserKeepingTask(rest[lastUser].content, caps)
    };
  }
  let historyUsed = 0;
  const kept = [];
  for (let i = lastUser - 1; i >= 0; i--) {
    const m = rest[i];
    if (!m) continue;
    const clipped = {
      ...m,
      content: truncateContent(m.content, caps.messageMaxChars, m.role === 'tool' ? { keepTail: true } : undefined)
    };
    const n = contentCharLen(clipped.content);
    if (historyUsed + n > caps.historyMaxChars) {
      if (!kept.length) {
        kept.push(clipped);
        historyUsed += n;
      }
      break;
    }
    kept.push(clipped);
    historyUsed += n;
  }
  kept.reverse();
  const tail = rest.slice(Math.max(0, lastUser)).map((m, i) => {
    if (!m) return m;
    if (i === 0) return m;
    const cap = m.role === 'tool' ? caps.toolResultMaxChars : caps.messageMaxChars;
    return { ...m, content: truncateContent(m.content, cap, m.role === 'tool' ? { keepTail: true } : undefined) };
  });
  let out = systems.concat(kept, tail);
  while (out.length > systems.length + 1 && messagesCharLen(out) > caps.requestMaxChars) {
    const dropAt = systems.length;
    if (dropAt >= out.length - 1) break;
    out.splice(dropAt, 1);
  }
  if (messagesCharLen(out) > caps.requestMaxChars && out.length) {
    const last = out[out.length - 1];
    const room = Math.max(4000, caps.requestMaxChars - messagesCharLen(out.slice(0, -1)) - 80);
    out[out.length - 1] = {
      ...last,
      content: truncateLastUserKeepingTask(last.content, {
        ...caps,
        turnRideMaxChars: Math.min(caps.turnRideMaxChars, Math.max(2000, Math.floor(room * 0.45))),
        lastUserMaxChars: Math.min(caps.lastUserMaxChars, Math.max(2000, Math.floor(room * 0.55)))
      })
    };
  }
  return out;
}

function buildCompletionMessagesFromHistory(
  messages,
  sysContent,
  prepared,
  includeImages,
  helpers,
  turnRide,
  capOpts
) {
  const list = messagesForTranscript(messages);
  const unpackUser =
    typeof (helpers && helpers.unpackUserContent) === 'function'
      ? helpers.unpackUserContent
      : (raw) => String(raw || '');

  const lastReal = lastRealUserIndex(list);
  const out = [];
  if (sysContent) out.push({ role: 'system', content: sysContent });
  for (let i = 0; i < list.length; i++) {
    const m = list[i];
    const storedContent =
      m.role === 'user' ? unpackUser(m.content) : assistantTextFromMessage(m, helpers);
    const isCurrentTaskUser = i === lastReal;
    if (isCurrentTaskUser) {
      let content;
      if (includeImages && prepared && Array.isArray(prepared.content)) {
        const plain =
          String(prepared.multimodalPlainText || '').trim() ||
          storedContent.split('\n【用户附件】')[0].trim() ||
          storedContent;
        content = wrapPreparedCurrentTaskContent(prepared, plain);
      } else {
        content = buildCurrentTaskText(storedContent);
      }
      content = attachTurnRideToUserContent(content, turnRide);
      out.push({ role: 'user', content });
    } else {
      out.push({ role: m.role, content: storedContent });
    }
  }
  return trimMessagesToCharBudget(foldOlderCompletionMessages(out, helpers, capOpts), capOpts);
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    SESSION_HISTORY_HEADER,
    TURN_RIDE_HEADER,
    joinPromptChunks,
    packSystemPrompt,
    unwrapSystemPromptPack,
    attachTurnRideToUserContent,
    COMPACTION_ARCHIVE_HEADER,
    FOLDED_HISTORY_HEADER,
    foldOlderCompletionMessages,
    formatCompactionArchiveBlock,
    mergeCompactionBlockIntoTurnRide,
    isSyntheticLoopUserContent,
    extractBookPrefixMessages,
    extractInTurnLoopTail,
    applyTurnRideToCompletionMessages,
    reprojectContinueLoopMessages,
    persistableAssistantText,
    messagesForTranscript,
    assistantTextFromMessage,
    buildSessionChatHistoryFromMessages,
    buildCompletionMessagesFromHistory,
    trimMessagesToCharBudget,
    contentCharLen,
    selectHistoryMessagesForSession,
    cloneHistoryMessages,
    buildCurrentTaskText,
    isWeakAssistantReply,
    WEAK_ASSISTANT_REPLIES
  };
}

if (typeof window !== 'undefined') {
  window.persistableAssistantText = persistableAssistantText;
  window.messagesForTranscript = messagesForTranscript;
  window.assistantTextFromMessage = assistantTextFromMessage;
  window.buildSessionChatHistoryFromMessages = buildSessionChatHistoryFromMessages;
  window.buildCompletionMessagesFromHistory = buildCompletionMessagesFromHistory;
  window.trimMessagesToCharBudget = trimMessagesToCharBudget;
  window.selectHistoryMessagesForSession = selectHistoryMessagesForSession;
  window.cloneHistoryMessages = cloneHistoryMessages;
  window.buildCurrentTaskText = buildCurrentTaskText;
  window.SESSION_HISTORY_HEADER = SESSION_HISTORY_HEADER;
  window.TURN_RIDE_HEADER = TURN_RIDE_HEADER;
  window.COMPACTION_ARCHIVE_HEADER = COMPACTION_ARCHIVE_HEADER;
  window.FOLDED_HISTORY_HEADER = FOLDED_HISTORY_HEADER;
  window.foldOlderCompletionMessages = foldOlderCompletionMessages;
  window.formatCompactionArchiveBlock = formatCompactionArchiveBlock;
  window.mergeCompactionBlockIntoTurnRide = mergeCompactionBlockIntoTurnRide;
  window.isSyntheticLoopUserContent = isSyntheticLoopUserContent;
  window.extractBookPrefixMessages = extractBookPrefixMessages;
  window.extractInTurnLoopTail = extractInTurnLoopTail;
  window.applyTurnRideToCompletionMessages = applyTurnRideToCompletionMessages;
  window.reprojectContinueLoopMessages = reprojectContinueLoopMessages;
  window.joinPromptChunks = joinPromptChunks;
  window.packSystemPrompt = packSystemPrompt;
  window.unwrapSystemPromptPack = unwrapSystemPromptPack;
  window.attachTurnRideToUserContent = attachTurnRideToUserContent;
  window.isWeakAssistantReply = isWeakAssistantReply;
}

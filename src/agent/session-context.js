'use strict';

// 纯 CJS 依赖：顶层 require 真源，替代原先「运行期 require 探测 → 全局兜底」。
const sessionTranscript = require('./session-transcript');
const roundText = require('./agent-round-text');
const { AGENT_LIMITS_DEFAULTS } = require('./agent-limits');
// 图片 part 形状判定的单一来源（OpenAI chat `image_url` / Responses `input_image` /
// Anthropic `image`）。原先本文件只认 `image_url`，与出站闸门（guardrails-shared）的
// 三形状判定不一致 —— 同一张图「闸门认得出、账本认不出」，账本就会退回按 base64 长度计。
const { isChatImagePart, stripReadinessNotes } = require('./guardrails-shared');

/**
 * 单个图片 part 计入上下文预算时的等效字符数。
 *
 * 图片在真实请求里由服务端换算成「图片 token」，与 base64 长度无关。
 * 若按 JSON.stringify(part).length 计（一张 1MB 图 ≈ 140 万字符），单张图就会顶穿
 * llmRequestMaxChars 这条长度硬上限，使历史从第一轮起就被反复裁；而图片既不可
 * 折叠（当前任务永不折叠）又不可压缩，于是变成「每轮都在裁一个裁不掉的东西」。
 * token 口径的同值换算见 token-estimate.js 的 IMAGE_PART_EQUIV_TOKENS。
 */
function visionPartEquivChars() {
  const n = Number(AGENT_LIMITS_DEFAULTS.visionPartEqChars);
  return Number.isFinite(n) && n > 0 ? n : 6000;
}

/** 是否图片 part：形状判定委托 guardrails-shared，本文件不再自维护第二份形状表。 */
const isVisionPart = isChatImagePart;

function messagesForTranscript(messages) {
  return sessionTranscript.transcriptFromMessages(messages);
}

const SESSION_HISTORY_HEADER =
  '【本会话近期对话 — 同一会话内已发生的真实往来，追问「刚才说了什么/继续上文」时以此为准】';

const COMPACTION_ARCHIVE_HEADER = '【本会话压缩摘要 / Compaction】';

const FOLDED_HISTORY_HEADER = '【较早对话 · 已折叠】';

const TURN_RIDE_HEADER = '【本轮上下文 / Turn Context】';

/**
 * 落库消息的 meta 前缀：`【叠云meta】{json}\n<正文>`。
 *
 * 这是 Main 与 Renderer 共用的唯一一份打包/剥离实现：Main 直接 require，
 * Renderer 经 agent-bundle 镜像成兼容全局（见 agent-bundle-entry.js）。
 * `renderer-chat-bubbles.js` 与 `plan-run-turn.js` 的 pack/strip 全部委托到这里，
 * 勿再各处自抄一份——三份实现漂移正是「附件 base64 落库」的直接原因。
 */
const MESSAGE_META_PREFIX = '【叠云meta】';
const MESSAGE_META_RE = /^【叠云meta】(\{[\s\S]*?\})\n([\s\S]*)$/;

/**
 * 附件落库只允许「引用」形态：路径 + 展示名 + 尺寸 + mime。
 *
 * base64 / data URL / blob URL 一律不得落库。它们是「出站那一刻」的临时产物
 * （readAttachmentBase64 现场读盘、previewUrl 是会话内 object URL），落库后没有任何读者：
 * 历史渲染与回传都只认路径。留着只会让 messages 表按「单张图 ~1.45M 字符 × 2 份
 * （_pasteBase64 + _base64）」膨胀，并让每次开会话都要经 Gateway RPC 把整行搬进
 * Renderer 再 JSON.parse。
 */
const ATTACHMENT_META_KEYS = ['path', 'workspaceRelative', 'absolutePath', 'originalName', 'size', 'mime'];

/**
 * meta 内单个字符串字段的长度上限。
 *
 * meta 是「元数据」：任何以字节形式混进来的东西（base64 / 长文本快照）都远超此值，
 * 而合法的元数据字段（路径、模型名、输入文本）都远小于此值。超限即丢弃，作为
 * 「字节不得进 meta」这条不变量的兜底，不依赖各调用点自觉。
 */
const META_STRING_MAX = 20000;

function slimAttachmentForPersist(att) {
  if (!att || typeof att !== 'object') return null;
  const out = {};
  for (const key of ATTACHMENT_META_KEYS) {
    if (key === 'size') continue;
    const v = att[key];
    if (v == null || v === '') continue;
    const s = String(v);
    if (s.length > META_STRING_MAX) continue;
    out[key] = s;
  }
  const size = Number(att.size) || 0;
  if (size) out.size = size;
  return out.path || out.absolutePath || out.workspaceRelative ? out : null;
}

function slimAttachmentsForPersist(list) {
  return (Array.isArray(list) ? list : []).map(slimAttachmentForPersist).filter(Boolean);
}

/**
 * 回合触发归因（user meta 的 `trigger` 字段）：这一轮**不是用户打的字**，
 * 而是某个外部事件唤醒的（定时计划 / 目标续跑 / 内网来信 …）。
 *
 * 为什么要落到 meta 而不是只写在正文抬头里：归因若只存在于 `[计划 · x]` 这类
 * 中文字符串里，Renderer 回放、手机端、交接时都无法分辨「这条是不是用户发的」，
 * 模型也只能靠解析前缀猜。meta 是结构信号，正文保持「模型看到的原文」不变。
 *
 * 只存「谁触发的」这一层事实：kind + 指针 + 时间。触发内容的正文本来就在这条
 * 消息的 content 里，再存一份就是同一事实的第二来源。
 */
const TRIGGER_KIND_MAX = 40;
const TRIGGER_FIELD_MAX = 200;

function slimTriggerForPersist(trigger) {
  if (!trigger || typeof trigger !== 'object' || Array.isArray(trigger)) return null;
  const kind = String(trigger.kind || '').trim().slice(0, TRIGGER_KIND_MAX);
  if (!kind) return null;
  const out = { kind };
  for (const key of ['planId', 'planName', 'at']) {
    const v = String(trigger[key] == null ? '' : trigger[key]).trim();
    if (v) out[key] = v.slice(0, TRIGGER_FIELD_MAX);
  }
  return out;
}

/** 递归剔除 meta 里的「字节形态」值：超长字符串与 data:/blob: 临时 URL。 */
function sanitizeMetaValue(value, depth) {
  if (typeof value === 'string') {
    if (value.length > META_STRING_MAX) return undefined;
    if (/^(data|blob):/i.test(value.trim())) return undefined;
    return value;
  }
  if (Array.isArray(value)) {
    if (depth >= 6) return undefined;
    return value.map((v) => sanitizeMetaValue(v, depth + 1)).filter((v) => v !== undefined);
  }
  if (value && typeof value === 'object') {
    if (depth >= 6) return undefined;
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      const kept = sanitizeMetaValue(v, depth + 1);
      if (kept !== undefined) out[k] = kept;
    }
    return out;
  }
  return value;
}

/**
 * 打包落库消息：`【叠云meta】{json}\n<正文>`；没有任何可落库元数据时原样返回正文。
 *
 * - role=user：只留本轮输入文本 + 附件引用（内存里的暂存附件带 base64，必须投影掉）。
 * - role=assistant：轮次元数据经 sanitizeMetaValue 过一遍；不复制附件引用——
 *   附件的唯一来源是那条 user 消息，assistant 再存一份就是同一事实的第二来源。
 */
function packMessageMeta(content, meta, opts) {
  const text = content == null ? '' : String(content);
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return text;
  let payload;
  if ((opts && opts.role) === 'user') {
    payload = {};
    const inputText = meta.inputText != null ? String(meta.inputText).trim() : '';
    if (inputText) payload.inputText = inputText;
    const attachments = slimAttachmentsForPersist(meta.attachments);
    if (attachments.length) payload.attachments = attachments;
    // 非人类触发的一轮：归因与正文一起落库，Renderer 据此渲染成触发条而不是用户气泡。
    const trigger = slimTriggerForPersist(meta.trigger);
    if (trigger) payload.trigger = trigger;
  } else {
    payload = sanitizeMetaValue(meta, 0) || {};
    delete payload.attachments;
    // 触发归因属于「这一轮是谁唤醒的」，唯一来源是那条 user 行；assistant 再存一份就是
    // 同一事实的第二来源（与附件同理）。
    delete payload.trigger;
  }
  if (!Object.keys(payload).length) return text;
  try {
    return `${MESSAGE_META_PREFIX}${JSON.stringify(payload)}\n${text}`;
  } catch {
    return text;
  }
}

/** 剥离落库消息的 meta，得到 `{ content, meta }`；meta 非法时按「无 meta」处理。 */
function unpackMessageMeta(raw) {
  const s = raw == null ? '' : String(raw);
  const m = s.match(MESSAGE_META_RE);
  if (!m) return { content: s, meta: null };
  try {
    return { content: m[2], meta: JSON.parse(m[1]) };
  } catch {
    return { content: s, meta: null };
  }
}

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

/**
 * 只规整 stable/turnRide/content，**其余字段原样保留**（如 `memoryAudit`）——
 * prep 侧附加的注入事实必须能穿过这一层到达 contextAudit / request_snapshots。
 */
function unwrapSystemPromptPack(pack) {
  if (pack && typeof pack === 'object' && !Array.isArray(pack)) {
    const stable = String(pack.stable || '');
    const turnRide = String(pack.turnRide || '');
    const content = String(pack.content || joinPromptChunks([stable, turnRide]));
    return { ...pack, stable, turnRide, content };
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

/**
 * 「目标续跑轮」那条合成消息的开头（正文在 `renderer-agent-send.GOAL_TURN_USER_MSG`，
 * 由 Renderer 拼进当轮请求，不落库、不出用户气泡）。
 *
 * 为什么归口在这里：它是**代码说的话**，不是用户说的话 ——
 *   1. `isSyntheticLoopUserContent` 用它把这类消息排除出「用户任务」；
 *   2. Main 用它区分「自动续跑的一轮」与「人驱动的一轮」（目标轮次预算只该管前者，
 *      否则用户每聊一句就烧掉一轮预算，长任务会被聊天次数烧光）。
 */
const GOAL_CONTINUE_USER_PREFIX = '[系统] 目标尚未收尾';

function isGoalContinueUserContent(content) {
  return userContentToText(content).trim().startsWith(GOAL_CONTINUE_USER_PREFIX);
}

function isSyntheticLoopUserContent(content) {
  const t = userContentToText(content).trim();
  if (isHistoryBackgroundUserContent(content)) return true;
  if (t.startsWith('【完成验收】')) return true;
  if (!t.startsWith('[系统] ')) return false;
  if (isGoalContinueUserContent(content)) return true;
  return (
    t.startsWith('[系统] 本段工具轮次已达上限') ||
    t.startsWith('[系统] 上一轮回复像中间检查过程') ||
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
 *
 * **思考不写进 book**（REASONING-ISOLATION §3.4 / D1）：这里只用工具事实兜底，
 * 思考只走独立 `reasoning` 字段（`messages.reasoning`）；最后再过 `persistableTurnText`
 * 把「思考回退标签」（仅展示）与空串统一落成占位，保证标签永远进不了账本。
 */
function persistableAssistantText(reply, trace, helpers) {
  const raw = String(reply == null ? '' : reply);
  const h = helpers || {};
  const t = Array.isArray(trace) ? trace : [];
  let text = raw;
  if (isWeakAssistantReply(raw) && t.length) {
    const toolFallback = typeof h.toolFallback === 'function' ? h.toolFallback : () => '';
    text = toolFallback(t) || raw;
  }
  return roundText.persistableTurnText(text);
}

/**
 * Project assistant text from persisted content only. Live transientTrace is UI-only.
 *
 * **重建不读思考**（REASONING-ISOLATION D1 反转）：`message.reasoning`（账本真思考）与
 * 落库正文里内嵌的 trace 思考都不参与正文投影 —— 历史正文只认 `content`，
 * 弱正文时最多用工具事实兜底，绝不让某一轮思考在下一轮变成 assistant 正文。
 */
function assistantTextFromMessage(message, helpers) {
  const h = helpers || {};
  const unpackAssistantMeta =
    typeof h.unpackAssistantMeta === 'function' ? h.unpackAssistantMeta : (raw) => ({ content: raw });
  const splitTrace =
    typeof h.splitPersistedAssistantTrace === 'function'
      ? h.splitPersistedAssistantTrace
      : (raw) => ({ content: raw, trace: null });
  const toolFallback = typeof h.toolFallback === 'function' ? h.toolFallback : () => '';

  const { content: raw } = unpackAssistantMeta(message && message.content);
  const split = splitTrace(raw);
  let text = String(split.content || '').trim();
  if (WEAK_ASSISTANT_REPLIES.has(text)) {
    const persistedTrace = split.trace;
    if (persistedTrace && persistedTrace.length) {
      text = toolFallback(persistedTrace) || text;
    }
  }
  // 验收提示只服务当轮 UI，不参与历史投影：否则模型会把它当正文模板复述，
  // 与新一轮追加的提示叠成两段（见 guardrails-shared.stripReadinessNotes 注释）。
  const cleaned = stripReadinessNotes(text);
  if (cleaned) return cleaned;
  // 整条只有提示：不能把提示本身当历史上行，回退到与渲染层一致的占位（单一来源 agent-round-text）。
  return text.includes('完成验收') ? roundText.TURN_EMPTY_REPLY_TEXT : text;
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

/**
 * 兜底上限：来源只有 `agent-limits.js`。这里**不再各写一份字面量**（曾两边漂移成两套预算）。
 * 键名写错时直接抛：静默拿到 `undefined` 会让整条预算失效，而现象只是「上下文忽然变短」。
 */
function completionCapDefault(key) {
  const n = Number(AGENT_LIMITS_DEFAULTS[key]);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`agent-limits 缺少上限键 ${key}（session-context 的默认预算从这里取）`);
  }
  return n;
}

const DEFAULT_COMPLETION_CAPS = {
  historyMaxChars: completionCapDefault('completionHistoryMaxChars'),
  messageMaxChars: completionCapDefault('completionMessageMaxChars'),
  lastUserMaxChars: completionCapDefault('completionLastUserMaxChars'),
  turnRideMaxChars: completionCapDefault('completionTurnRideMaxChars'),
  requestMaxChars: completionCapDefault('llmRequestMaxChars'),
  recentTurns: completionCapDefault('completionRecentTurns'),
  foldedMaxChars: completionCapDefault('completionFoldedMaxChars'),
  toolResultMaxChars: completionCapDefault('toolResultMaxJson')
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
  const audit = auditOf(opts);
  if (audit) {
    // 记「折了几条 / 原本多少字 / 折完多少字 / 断点落在什么角色」——
    // 这四个数就是事后解释「历史为什么只剩 24 条」的全部依据。
    audit.fold = {
      foldedCount: older.length,
      keptRecentTurns: caps.recentTurns,
      foldedChars: messagesCharLen(older),
      foldMaxChars: caps.foldedMaxChars,
      cutRole: book[cut] && book[cut].role ? String(book[cut].role) : null
    };
  }
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

/**
 * 审计出参：折叠/裁剪这些「派生事实」发生在 Renderer 的拼装里，Main 无法重算
 * （重算就是第二份实现）。所以这里只做一件事——把已经算出来的事实写进调用方传进来的
 * 可变对象 `capOpts.audit`（未传则完全不产生任何行为差异）。
 * 该对象最终落到 `request_snapshots.context_audit_json`，见 docs/REQUEST-SNAPSHOT.md。
 */
function auditOf(opts) {
  const audit = opts && opts.audit;
  return audit && typeof audit === 'object' ? audit : null;
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
  // 「当前任务那条」被截断是最常见的裁剪（骑手位/turnRide 很长时每轮都发生），
  // 必须和「历史条被丢」分开记，否则审计里看不出是哪一层把内容切了。
  let taskUserTruncated = 0;
  if (lastUser >= 0 && rest[lastUser]) {
    const beforeTaskChars = contentCharLen(rest[lastUser].content);
    const taskContent = truncateLastUserKeepingTask(rest[lastUser].content, caps);
    rest[lastUser] = {
      ...rest[lastUser],
      content: taskContent
    };
    if (contentCharLen(taskContent) < beforeTaskChars) taskUserTruncated = 1;
  }
  let historyUsed = 0;
  const kept = [];
  let clippedCount = 0;
  for (let i = lastUser - 1; i >= 0; i--) {
    const m = rest[i];
    if (!m) continue;
    const clipped = {
      ...m,
      content: truncateContent(m.content, caps.messageMaxChars, m.role === 'tool' ? { keepTail: true } : undefined)
    };
    if (contentCharLen(clipped.content) < contentCharLen(m.content)) clippedCount += 1;
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
    const clippedContent = truncateContent(m.content, cap, m.role === 'tool' ? { keepTail: true } : undefined);
    if (contentCharLen(clippedContent) < contentCharLen(m.content)) clippedCount += 1;
    return { ...m, content: clippedContent };
  });
  let out = systems.concat(kept, tail);
  // 审计：进函数的条数 → 出去的条数，差出来的就是「按历史预算丢掉的老消息」。
  // （逐条截断发生在上面 `truncateContent`，`clippedCount` 记的是「有多少条被截过」。）
  const audit = auditOf(opts);
  const droppedByHistoryBudget = Math.max(0, rest.length - (kept.length + tail.length));
  let perMessageTruncated = clippedCount + taskUserTruncated;
  // 请求仍超硬顶时按顺序丢最老的非 system 消息，但绝不能丢掉「当前任务」那条用户消息：
  // 否则模型会收到「只有工具结果、没有问题」的请求
  const protectedTaskMsg = (() => {
    for (let i = out.length - 1; i >= systems.length; i--) {
      const m = out[i];
      if (m && m.role === 'user' && !isSyntheticLoopUserContent(m.content)) return m;
    }
    return null;
  })();
  let droppedByRequestCap = 0;
  // 预算核算只做一遍：逐条算一次长度，之后按 running total 递减。
  // （原来每丢一条就 `messagesCharLen(out)` 全量重算一次，且每条都重新 JSON.stringify 工具入参，
  //   丢 n 条就是 O(n²) 次序列化；这里把同样四个数字算成一次。）
  const charLens = out.map(
    (m) => contentCharLen(m && m.content) + JSON.stringify(m && m.tool_calls ? m.tool_calls : '').length
  );
  let outChars = charLens.reduce((sum, n) => sum + n, 0);
  // 每轮丢的都是「最老的可丢消息」，位置只会往后走：用游标替代每轮的 findIndex。
  let dropCursor = systems.length;
  while (out.length > systems.length + 1 && outChars > caps.requestMaxChars) {
    while (dropCursor < out.length && out[dropCursor] === protectedTaskMsg) dropCursor += 1;
    const dropAt = dropCursor;
    if (dropAt >= out.length - 1) break;
    out.splice(dropAt, 1);
    outChars -= charLens.splice(dropAt, 1)[0];
    droppedByRequestCap += 1;
  }
  if (outChars > caps.requestMaxChars && out.length) {
    const last = out[out.length - 1];
    const room = Math.max(4000, caps.requestMaxChars - (outChars - charLens[charLens.length - 1]) - 80);
    out[out.length - 1] = {
      ...last,
      content: truncateLastUserKeepingTask(last.content, {
        ...caps,
        turnRideMaxChars: Math.min(caps.turnRideMaxChars, Math.max(2000, Math.floor(room * 0.45))),
        lastUserMaxChars: Math.min(caps.lastUserMaxChars, Math.max(2000, Math.floor(room * 0.55)))
      })
    };
    perMessageTruncated += 1;
  }
  if (audit && (droppedByHistoryBudget || droppedByRequestCap || perMessageTruncated)) {
    audit.trim = {
      droppedByHistoryBudget,
      droppedByRequestCap,
      perMessageTruncated,
      // 口径一致：两条都**不含 system**（system 单独计），否则 messagesOut 恒比 messagesIn 多一条，
      // 与快照行的 messageCount 也对不上，排查时会被这一条差带偏。
      messagesIn: rest.length,
      messagesOut: out.length - systems.length,
      systemMessages: systems.length,
      requestMaxChars: caps.requestMaxChars
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
      const projected = { role: m.role, content: storedContent };
      // 账本真思考（`reasoning`，与 content 分列）只作上行回传 reasoning_content 的真值来源：
      // 作为**同级传输字段**带上，绝不并进 content，也不参与正文投影（REASONING-ISOLATION D1）。
      if (m.reasoning) projected.reasoning = m.reasoning;
      out.push(projected);
    }
  }
  return trimMessagesToCharBudget(foldOlderCompletionMessages(out, helpers, capOpts), capOpts);
}

module.exports = {
  SESSION_HISTORY_HEADER,
  TURN_RIDE_HEADER,
  MESSAGE_META_PREFIX,
  META_STRING_MAX,
  packMessageMeta,
  unpackMessageMeta,
  slimAttachmentsForPersist,
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
  GOAL_CONTINUE_USER_PREFIX,
  isGoalContinueUserContent,
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
  isWeakAssistantReply
};

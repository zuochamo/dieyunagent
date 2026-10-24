'use strict';

// @ts-check
/**
 * 请求快照装配（Main 侧，唯一装配点）。
 *
 * 职责：把「已经定稿、马上要发出去的请求 body」压成一行 `request_snapshots` 记录。
 * 只做四件事：算 hash、超限时改存信封、按 limits 决定要不要写、把旁路事实（压缩判定）搬进去。
 *
 * 大字段（system / tools）**不做跨行去重**：去重的代价是 NULL 变成双重语义
 * （「与上一行相同」vs「超上限没落库」），并发写时还会读串行。存整份更贵，但读的时候只有一个答案。
 *
 * 三条**不要在这里做**的事（做了就是第二份实现）：
 * 1. 不重新拼 prompt / 不重新算折叠 —— 折叠账由 Renderer 的 `capOpts.audit` 带过来；
 * 2. 不重新判压缩 —— 压缩结论由循环里的 `maybeCompactRound` 给；
 * 3. 不估算"真 token" —— 用 `token-estimate.js`（Rust `compaction/tokens.rs` 同口径）。
 *
 * 写入失败**绝不**影响请求：本模块的所有 I/O 都是 try/catch + 只记一次日志。
 * 表结构与字段语义见 `docs/REQUEST-SNAPSHOT.md`。
 */

const crypto = require('crypto');

const { AGENT_LIMITS_DEFAULTS, getAgentLimits } = require('./agent-limits');
const { estimateFullContextUsage } = require('./token-estimate');

/** 写入 RPC（唯一写入口；读入口走 Gateway）。 */
const SNAPSHOT_APPEND_RPC = 'memory.request_snapshot_append';
const WRITE_TIMEOUT_MS = 4000;
/** 信封模式下头尾各保留的字符数：够认出"这段是什么"，不至于把整段 prompt 塞回库里。 */
const ENVELOPE_PREVIEW_CHARS = 2000;
/** 失败日志节流：同一次运行里每 60s 最多一条，避免每轮都刷。 */
const ERROR_LOG_INTERVAL_MS = 60000;

/** 请求来源。与 `runRustAgentLoop` 的四个入口一一对应。 */
const SNAPSHOT_SOURCES = Object.freeze({
  CHAT: 'chat',
  SUBAGENT: 'subagent',
  PLANNER: 'planner',
  PLAN: 'plan'
});

/** 写入原因：一轮里可能发多次（溢出重发 / 图片被拒重发），必须能区分。 */
const SNAPSHOT_REASONS = Object.freeze({
  INITIAL: 'initial',
  OVERFLOW_RETRY: 'overflow-retry',
  IMAGE_REPAIR: 'image-repair'
});

const SNAPSHOT_LIMIT_KEYS = Object.freeze([
  'requestSnapshotEnabled',
  'requestSnapshotKeepPerSession',
  'requestSnapshotKeepCompacted',
  'requestSnapshotMaxMessagesChars',
  'requestSnapshotSystemMaxChars',
  'requestSnapshotToolsMaxChars'
]);

function sha256(text) {
  return crypto.createHash('sha256').update(String(text == null ? '' : text), 'utf8').digest('hex');
}

/** JSON 序列化失败（循环引用等）时退化为 null，绝不抛。 */
function safeJson(value) {
  try {
    return JSON.stringify(value == null ? null : value);
  } catch {
    return 'null';
  }
}

/** system prompt 只有一条：取第一条 `role === 'system'` 的文本（数组 content 取 text part）。 */
function systemTextOf(messages) {
  if (!Array.isArray(messages)) return '';
  for (const m of messages) {
    if (!m || m.role !== 'system') continue;
    const content = m.content;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      return content
        .filter((p) => p && p.type === 'text' && typeof p.text === 'string')
        .map((p) => p.text)
        .join('\n');
    }
    return '';
  }
  return '';
}

function toolNamesOf(tools) {
  if (!Array.isArray(tools)) return [];
  const out = [];
  for (const t of tools) {
    const name = (t && t.function && t.function.name) || (t && t.name) || '';
    if (name) out.push(String(name));
  }
  return out;
}

/**
 * 单行 messages 超上限时改存「信封」：只留能定位的骨架（条数/字符/hash/头尾预览）。
 * 这是永不撑爆库的最后一道闸 —— 记不全也比把 agent 拖死强，且信封里明写 truncated。
 */
function envelopeMessages(messagesJson, maxChars) {
  const chars = messagesJson.length;
  const cap = Number(maxChars) > 0 ? Number(maxChars) : 0;
  if (!cap || chars <= cap) {
    return { messagesJson, truncated: false, chars };
  }
  const head = messagesJson.slice(0, ENVELOPE_PREVIEW_CHARS);
  const tail = messagesJson.slice(-ENVELOPE_PREVIEW_CHARS);
  return {
    messagesJson: safeJson({
      truncated: true,
      chars,
      maxChars: cap,
      hash: sha256(messagesJson),
      head,
      tail
    }),
    truncated: true,
    chars
  };
}

/**
 * 装配一行快照。返回 `null` 表示「不该写」（未启用 / 缺 sessionId / body 不合法）。
 *
 * @param {object} desc
 * @param {object} desc.body  即将发送的请求体（含 model / messages / tools）
 * @param {string} desc.sessionId
 * @param {string} [desc.runId]
 * @param {number} [desc.round]
 * @param {string} [desc.source]        SNAPSHOT_SOURCES 之一
 * @param {string} [desc.reason]        SNAPSHOT_REASONS 之一
 * @param {object} [desc.compaction]    { compacted, tokensBefore, tokensAfter, archiveId, tokenBudget, triggerRatio, compactionRoundCount }
 * @param {object} [desc.contextAudit]  Renderer 带过来的折叠/裁剪事实（只对当前轮次有效）
 * @param {object} desc.limits          resolveSnapshotLimits(...) 的结果
 */
function buildRequestSnapshotPayload(desc) {
  const d = desc || {};
  const limits = d.limits || AGENT_LIMITS_DEFAULTS;
  const body = d.body || {};
  const sessionId = String(d.sessionId || '').trim();
  if (!sessionId) return null;
  if (limits.requestSnapshotEnabled === false) return null;
  const messages = Array.isArray(body.messages) ? body.messages : null;
  if (!messages || !messages.length) return null;

  const rawMessagesJson = safeJson(messages);
  const env = envelopeMessages(rawMessagesJson, limits.requestSnapshotMaxMessagesChars);

  const systemText = systemTextOf(messages);
  const systemHash = systemText ? sha256(systemText) : '';
  const tools = Array.isArray(body.tools) ? body.tools : [];
  const toolsJson = tools.length ? safeJson(tools) : '';
  const toolsHash = toolsJson ? sha256(toolsJson) : '';

  // 大字段**直接存**，不再「同上一行就写 NULL」：
  // 那个去重让 NULL 同时表示「与上一行相同」和「超上限没落库」两种相反的事，
  // 而且去重游标是每 run 一份、表语义却是会话级 —— 子 Agent 与主循环共用父 sessionId
  // 并发写时，读侧会把别人的 system 当成自己的。现在的规则只有一条：
  //   systemText == null ⇒ 没落库（空 or 超 systemMaxChars，用 systemChars 判断是哪种）。
  const systemCap = Number(limits.requestSnapshotSystemMaxChars) || 0;
  const toolsCap = Number(limits.requestSnapshotToolsMaxChars) || 0;

  const compaction = d.compaction || null;
  const contextAudit = d.contextAudit && typeof d.contextAudit === 'object' ? d.contextAudit : null;

  const payload = {
    sessionId,
    runId: d.runId ? String(d.runId) : null,
    round: Number.isFinite(Number(d.round)) ? Number(d.round) : null,
    source: d.source || SNAPSHOT_SOURCES.CHAT,
    model: body.model ? String(body.model) : null,
    stream: typeof body.stream === 'boolean' ? body.stream : null,
    messagesJson: env.messagesJson,
    messagesChars: env.chars,
    messageCount: messages.length,
    messagesHash: sha256(rawMessagesJson),
    truncated: env.truncated,
    systemHash: systemHash || null,
    systemChars: systemText ? systemText.length : null,
    systemText: systemText && (!systemCap || systemText.length <= systemCap) ? systemText : null,
    toolsHash: toolsHash || null,
    toolsNames: tools.length ? safeJson(toolNamesOf(tools)) : null,
    toolsJson: toolsJson && (!toolsCap || toolsJson.length <= toolsCap) ? toolsJson : null,
    estTokens:
      estimateFullContextUsage({
        systemContent: systemText,
        messages,
        tools
      }) || null,
    compacted: !!(compaction && compaction.compacted),
    tokensBefore: compaction && Number.isFinite(Number(compaction.tokensBefore))
      ? Number(compaction.tokensBefore)
      : null,
    tokensAfter: compaction && Number.isFinite(Number(compaction.tokensAfter))
      ? Number(compaction.tokensAfter)
      : null,
    compactionArchiveId:
      compaction && Number.isFinite(Number(compaction.archiveId))
        ? Number(compaction.archiveId)
        : null,
    // 判定事实：没有它们，「这轮为什么没压缩」只能靠猜（列建了却永远 NULL 等于没建）
    tokenBudget:
      compaction && Number.isFinite(Number(compaction.tokenBudget))
        ? Number(compaction.tokenBudget)
        : null,
    triggerRatio:
      compaction && Number.isFinite(Number(compaction.triggerRatio))
        ? Number(compaction.triggerRatio)
        : null,
    compactionRoundCount:
      compaction && Number.isFinite(Number(compaction.compactionRoundCount))
        ? Number(compaction.compactionRoundCount)
        : null,
    reason: d.reason || SNAPSHOT_REASONS.INITIAL,
    contextAuditJson: contextAudit ? safeJson(contextAudit) : null,
    keepPerSession: positiveIntOrUndefined(limits.requestSnapshotKeepPerSession),
    keepCompacted: positiveIntOrUndefined(limits.requestSnapshotKeepCompacted)
  };
  return payload;
}

/**
 * 保留条数必须是 ≥1 的整数：`0`/`NaN` 不能是"用默认值"，负值更不能原样传下去
 * （Rust 侧 clamp 到 0 会把该会话的行连同刚写的那行一起删光）。
 */
function positiveIntOrUndefined(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return undefined;
  const i = Math.floor(n);
  return i >= 1 ? i : undefined;
}

/**
 * 取快照相关的 limits。数字唯一来源仍是 `agent-limits.js`；
 * 这里只做「读不到就用默认值」的兜底，不新增任何字面量。
 */
function resolveSnapshotLimits(userDataPath, tierId) {
  let resolved = {};
  try {
    resolved = (userDataPath && getAgentLimits(userDataPath, tierId)) || {};
  } catch {
    resolved = {};
  }
  /** @type {Record<string, any>} */
  const out = {};
  for (const key of SNAPSHOT_LIMIT_KEYS) {
    out[key] = resolved[key] != null ? resolved[key] : AGENT_LIMITS_DEFAULTS[key];
  }
  return out;
}

/**
 * 快照写入器。一次 run 建一个。
 *
 * 不再维护「上一份 hash」去重游标：见 `buildRequestSnapshotPayload` 里的说明
 * （run 级游标 + 会话级 NULL 语义会让并发写读出别人的 system）。
 *
 * @param {object} opts
 * @param {(method: string, params: object, timeoutMs?: number) => Promise<any>} opts.invoke
 * @param {string} opts.sessionId
 * @param {string} [opts.source]
 * @param {object} [opts.limits]
 * @param {{ info?: Function, warn?: Function }} [opts.logger]
 */
function createRequestSnapshotWriter(opts) {
  const o = opts || {};
  const invoke = typeof o.invoke === 'function' ? o.invoke : null;
  const sessionId = String(o.sessionId || '').trim();
  const source = o.source || SNAPSHOT_SOURCES.CHAT;
  const limits = o.limits || AGENT_LIMITS_DEFAULTS;
  const logger = o.logger || console;
  let lastErrorAt = 0;
  let wrote = 0;

  function logFailure(err) {
    const now = Date.now();
    if (now - lastErrorAt < ERROR_LOG_INTERVAL_MS) return;
    lastErrorAt = now;
    const msg = String((err && err.message) || err || 'unknown');
    try {
      (logger.warn || logger.info || (() => {}))(
        `[dieyun:agent] REQUEST_SNAPSHOT_SKIPPED session=${sessionId || '-'} err=${msg.slice(0, 200)}`
      );
    } catch {
      /* 日志失败不许影响主链路 */
    }
  }

  return {
    /** 该 writer 是否真的会写（未启用 / 无 sessionId 时用来短路）。 */
    get enabled() {
      return !!invoke && !!sessionId && limits.requestSnapshotEnabled !== false;
    },
    get count() {
      return wrote;
    },
    /**
     * 落一份快照。**永不抛**（失败只记一次日志），调用方可以 await 也可以不 await。
     * @returns {Promise<{id?: number, pruned?: number}|null>}
     */
    async write(desc) {
      if (!this.enabled) return null;
      const payload = buildRequestSnapshotPayload({
        ...(desc || {}),
        sessionId,
        source,
        limits
      });
      if (!payload) return null;
      try {
        const res = await invoke(SNAPSHOT_APPEND_RPC, payload, WRITE_TIMEOUT_MS);
        wrote += 1;
        return res || null;
      } catch (err) {
        logFailure(err);
        return null;
      }
    }
  };
}

module.exports = {
  SNAPSHOT_SOURCES,
  SNAPSHOT_REASONS,
  SNAPSHOT_APPEND_RPC,
  SNAPSHOT_LIMIT_KEYS,
  buildRequestSnapshotPayload,
  createRequestSnapshotWriter,
  resolveSnapshotLimits,
  envelopeMessages,
  systemTextOf,
  toolNamesOf,
  sha256
};

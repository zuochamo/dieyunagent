'use strict';

const { loadModelSettings } = require('../model-settings');
const { resolveModelContextWindowFromSettings } = require('./model-runtime-by-tier');
const { MODEL_RUNTIME_DEFAULTS } = require('./model-runtime-presets');
const { AGENT_LIMITS_DEFAULTS } = require('./agent-limits');
const { COMPACTION } = require('../compaction-prompts');
const { recordLlmUsage } = require('./llm-usage-recorder');
const { buildEstimatedUsageObject, estimatePromptTokensFromMessages } = require('../llm-usage-stats');
const { raceAbortable, createAbortError, isAbortError } = require('../llm-reconnect-retry');
const { COMPACTION_MAYBE_COMPACT_TIMEOUT_MS } = require('../core-rpc-timeouts');

function throwIfAborted(signal) {
  if (signal?.aborted) throw createAbortError();
}

/** 模型自带窗口（settings.customModels[].contextWindow / 名字线索）优先，其次磁盘 settings。 */
function resolveEffectiveContextWindow(settings, modelRouteOrId) {
  const base = Number(settings && settings.contextWindow) || MODEL_RUNTIME_DEFAULTS.contextWindow;
  try {
    const own = resolveModelContextWindowFromSettings(settings, modelRouteOrId);
    if (Number.isFinite(own) && own > 0) return own;
  } catch {
    // 解析失败按 settings 走
  }
  return base;
}

/**
 * 系统 / 工具 schema 预留 tokens。
 * 用 Number.isFinite 而非 `||`：`contextReserveTokens` 的合法取值包含 0，
 * 0 被当成「未设置」会让主进程预算与 Renderer（尊重 0）算出的预算不一致。
 */
function resolveReserveTokens(settings) {
  const n = Number(settings && settings.contextReserveTokens);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : MODEL_RUNTIME_DEFAULTS.contextReserveTokens;
}

function resolveMaxOutputTokens(settings) {
  const n = Number(settings && settings.maxOutputTokens);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : MODEL_RUNTIME_DEFAULTS.maxOutputTokens;
}

function getEffectiveInputBudget(settings, modelRouteOrId) {
  const cw = resolveEffectiveContextWindow(settings, modelRouteOrId);
  return Math.max(8192, cw - resolveReserveTokens(settings) - resolveMaxOutputTokens(settings));
}

/**
 * 工具 schema 超出「系统预留」的部分必须从输入预算里再扣：
 * 预留只覆盖 reserve 那么多 token 的 system + tools，超出后真实请求
 * （messages + tools + system）会顶穿窗口 —— 而工具 schema 既不可折叠也不可压缩。
 *
 * 扣减上限为 base 的 25%：小窗口档本来就放不下完整工具目录，
 * 不能让预算直接塌到地板后变成「每轮误压却压不掉」。
 */
const TOOLS_SCHEMA_DEDUCT_MAX_RATIO = 0.25;
/** 字符→token 折算系数唯一来源：agent-limits.js（与 Rust compaction/tokens.rs 同值） */
const CHARS_PER_TOKEN = AGENT_LIMITS_DEFAULTS.charsPerToken;

function applyToolSchemaDeduction(baseBudget, reserveTokens, toolsChars) {
  const base = Math.max(8192, Number(baseBudget) || 0);
  const chars = Math.max(0, Number(toolsChars) || 0);
  if (!chars) return base;
  const toolsTokens = Math.ceil(chars / CHARS_PER_TOKEN);
  const excess = Math.max(0, toolsTokens - Math.max(0, Number(reserveTokens) || 0));
  const capped = Math.min(excess, Math.floor(base * TOOLS_SCHEMA_DEDUCT_MAX_RATIO));
  return Math.max(8192, base - capped);
}

function getCompactionTriggerRatio(settings) {
  const r = Number(settings.compactionTriggerRatio);
  if (Number.isFinite(r) && r > 0) return Math.min(0.95, Math.max(0.3, r));
  return MODEL_RUNTIME_DEFAULTS.compactionTriggerRatio;
}

/**
 * 冷却轮数：与 Rust `default_cooldown()` 对齐。
 * 压缩成功那一轮会写入 POST_COMPACTION_ROUND_COUNT(1)，使这里真正生效。
 */
const COMPACTION_COOL_DOWN_ROUNDS = 6;

/**
 * Rust `compaction.maybe_compact` 的 prompts 参数（字段名 camelCase）。
 * 文案唯一来源是 `src/compaction-prompts.js`；这里只做字段映射，**不再放一份兜底文案**
 * （旧实现放在 compaction-rust-bridge.js，prefix 与主文案漂移成「历史背景」vs「自动压缩」）。
 * 若某字段缺失，由 Rust 侧 `CompactionPrompts::default()` 兜底。
 */
function buildCompactionPrompts() {
  const C = COMPACTION || {};
  return {
    system: C.SYSTEM || '',
    user: C.USER || '',
    incrementalSystem: C.INCREMENTAL_SYSTEM || C.SYSTEM || '',
    incrementalUser: C.INCREMENTAL_USER || '',
    compactPrefix: C.COMPACT_PREFIX || '',
    compactSuffix: C.COMPACT_SUFFIX || ''
  };
}

function resolveTextModel(settings) {
  return (settings && settings.textModel) || '';
}

/** 压缩优先用当前会话 model（opts.model / apiConfig.model），textModel 仅作兜底 */
function resolveCompactionLlm(settings, opts = {}) {
  const apiConfig = opts.apiConfig || {};
  const baseUrl = String(apiConfig.baseUrl || settings.baseUrl || '').trim();
  const apiKey = String(apiConfig.apiKey || settings.apiKey || '').trim();
  const sessionModel = String(opts.model || apiConfig.model || resolveTextModel(settings) || '').trim();
  return { baseUrl, apiKey, textModel: sessionModel };
}

/** 中转/供应商内容审核拒绝压缩摘要时，跳过 LLM 压缩而非阻断 Agent。 */
function isCompactionPolicyError(err) {
  const msg = String(err && err.message ? err.message : err || '');
  const lower = msg.toLowerCase();
  return (
    lower.includes('content_policy') ||
    lower.includes('content policy') ||
    msg.includes('内容审核') ||
    msg.includes('风险规则')
  );
}

function compactionSkippedResult(messages, reason, llmError) {
  return {
    messages,
    compacted: false,
    tokensBefore: undefined,
    tokensAfter: undefined,
    summary: null,
    foldedTranscript: '',
    pinnedUserCount: 0,
    compactionSkipped: reason || 'policy',
    llmError: llmError ? String(llmError) : undefined
  };
}

function requireCoreBridge(coreBridge) {
  if (!coreBridge || typeof coreBridge.isReady !== 'function' || !coreBridge.isReady()) {
    const e = new Error('dieyun-core 未就绪');
    e.code = 'RUST_CORE_UNAVAILABLE';
    throw e;
  }
  return coreBridge;
}

/**
 * Main / Renderer compaction — 全链路 Rust（含 LLM 摘要）
 * @param {string} userData
 * @param {{ invoke?: Function, isReady?: Function } | null} coreBridge
 */
function createMainCompactionAgent(userData, coreBridge = null) {
  /** @type {Map<string, { cumulativeSummary: string | null, compactionRoundCount: number, hydrated?: boolean }>} */
  const sessionStates = new Map();

  function getSessionState(sessionId) {
    const id = sessionId != null ? String(sessionId).trim() : '';
    if (!id) {
      return { cumulativeSummary: null, compactionRoundCount: 0, hydrated: true };
    }
    if (!sessionStates.has(id)) {
      sessionStates.set(id, { cumulativeSummary: null, compactionRoundCount: 0 });
    }
    return sessionStates.get(id);
  }

  async function estimateMessagesTokens(messages) {
    const bridge = requireCoreBridge(coreBridge);
    const r = await bridge.invoke('compaction.estimate', { messages }, 10000);
    return Number(r && r.tokens) || 0;
  }

  async function hydrateSessionState(bridge, st, sessionId) {
    if (st.hydrated) return;
    st.hydrated = true;
    if (st.cumulativeSummary) return;
    const sid = sessionId != null ? String(sessionId).trim() : '';
    if (!sid) return;
    try {
      const rows = await bridge.invoke(
        'memory.compaction_recent',
        { sessionId: sid, limit: 1 },
        8000
      );
      const row = Array.isArray(rows) && rows[0] ? rows[0] : null;
      const text = row && (row.summary_text || row.summaryText);
      if (text && String(text).trim()) st.cumulativeSummary = String(text).trim();
    } catch (_e) {
      // archive read is best-effort; compaction still runs without cumulative summary
    }
  }

  async function maybeCompactMessages(messages, opts = {}) {
    const bridge = requireCoreBridge(coreBridge);
    const settings = loadModelSettings(userData);
    const llm = resolveCompactionLlm(settings, opts);
    const st = getSessionState(opts.sessionId);
    const signal = opts.signal || null;
    throwIfAborted(signal);
    if (!llm.baseUrl) {
      return {
        messages,
        compacted: false,
        tokensBefore: undefined,
        tokensAfter: undefined,
        summary: null,
        foldedTranscript: '',
        pinnedUserCount: 0
      };
    }
    await hydrateSessionState(bridge, st, opts.sessionId);
    // opts.tokenBudget 是「基础输入预算」；工具 schema 超出预留的部分在这里统一扣，
    // 调用方无需各自感知（IPC / loop / planner 都只传 base 与 toolsChars）。
    const baseBudget =
      Number(opts.tokenBudget) > 0
        ? Number(opts.tokenBudget)
        : getEffectiveInputBudget(settings, opts.model);
    const tokenBudget = applyToolSchemaDeduction(
      baseBudget,
      resolveReserveTokens(settings),
      opts.toolsChars
    );
    const result = await raceAbortable(
      bridge
        .invoke(
          'compaction.maybe_compact',
          {
            messages,
            tokenBudget,
            triggerRatio: getCompactionTriggerRatio(settings),
            coolDownRounds: COMPACTION_COOL_DOWN_ROUNDS,
            force: !!opts.force,
            compactionRoundCount: st.compactionRoundCount,
            cumulativeSummary: st.cumulativeSummary,
            prompts: buildCompactionPrompts(),
            model: llm.textModel,
            llm,
            runId: opts.runId || undefined
          },
          COMPACTION_MAYBE_COMPACT_TIMEOUT_MS
        )
        .catch((err) => {
          if (isAbortError(err)) throw err;
          if (isCompactionPolicyError(err)) {
            return compactionSkippedResult(messages, 'content_policy');
          }
          console.warn('[compaction] skip after RPC error', err && err.message);
          return compactionSkippedResult(
            messages,
            'llm_error',
            err && err.message ? err.message : err
          );
        }),
      signal
    );
    throwIfAborted(signal);
    if (result && result.compactionSkipped) {
      const skippedRounds = Number(result.compactionRoundCount);
      st.compactionRoundCount = Number.isFinite(skippedRounds) && skippedRounds > 0
        ? skippedRounds
        : (Number(st.compactionRoundCount) || 0) + 1;
      return {
        messages,
        compacted: false,
        tokensBefore: result.tokensBefore,
        tokensAfter: result.tokensAfter,
        summary: null,
        foldedTranscript: '',
        pinnedUserCount: 0,
        compactionSkipped: result.compactionSkipped,
        llmError: result.llmError || undefined
      };
    }
    if (!result) {
      st.compactionRoundCount = (Number(st.compactionRoundCount) || 0) + 1;
      return compactionSkippedResult(messages, 'llm_error', 'compaction.maybe_compact 无响应');
    }
    st.compactionRoundCount = Number(result.compactionRoundCount) || 0;
    st.cumulativeSummary = result.cumulativeSummary != null ? result.cumulativeSummary : st.cumulativeSummary;
    const modelForUsage = result.llmModel || llm.textModel || resolveTextModel(settings);
    if (result.llmUsage) {
      recordLlmUsage(result.llmUsage, modelForUsage);
    } else if (result.compacted) {
      const summaryText = String(
        result.summary?.summary || result.foldedTranscript || JSON.stringify(result.summary || '')
      );
      const est = buildEstimatedUsageObject({
        promptTokens: estimatePromptTokensFromMessages(messages) + 512,
        completionTokens: Math.max(128, Math.ceil(summaryText.length / CHARS_PER_TOKEN))
      });
      if (est) recordLlmUsage(est, modelForUsage);
    }
    if (result.compacted && typeof opts.onCompacted === 'function') {
      opts.onCompacted({
        tokensBefore: result.tokensBefore,
        tokensAfter: result.tokensAfter,
        summary: result.summary?.summary || '',
        foldedTranscript: result.foldedTranscript || ''
      });
    }
    return {
      messages: result.messages || messages,
      compacted: !!result.compacted,
      tokensBefore: result.tokensBefore,
      tokensAfter: result.tokensAfter,
      summary: result.summary,
      foldedTranscript: result.foldedTranscript || '',
      pinnedUserCount: result.pinnedUserCount,
      compactionSkipped: result.compactionSkipped || undefined,
      llmError: result.llmError || undefined
    };
  }

  return {
    estimateTokens: estimateMessagesTokens,
    estimateMessagesTokens,
    maybeCompactMessages,
    resetCompactionState(sessionId) {
      if (sessionId != null && String(sessionId).trim()) {
        sessionStates.delete(String(sessionId).trim());
        return;
      }
      sessionStates.clear();
    }
  };
}

module.exports = {
  createMainCompactionAgent,
  getEffectiveInputBudget,
  applyToolSchemaDeduction,
  resolveReserveTokens,
  TOOLS_SCHEMA_DEDUCT_MAX_RATIO
};

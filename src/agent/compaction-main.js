'use strict';

const { loadModelSettings } = require('../model-settings');
const {
  resolveModelContextWindowFromSettings,
  computeEffectiveInputBudget,
  MIN_INPUT_BUDGET_TOKENS,
  applyTierRuntime
} = require('./model-runtime-by-tier');
const { MODEL_RUNTIME_DEFAULTS } = require('./model-runtime-presets');
const { AGENT_LIMITS_DEFAULTS } = require('./agent-limits');
const { recordCompactionTelemetry, compactionTelemetryRow } = require('./compaction-telemetry');
const { COMPACTION_FOLD_TIMEOUT_MS } = require('../core-rpc-timeouts');
const {
  raceAbortable,
  isAbortError,
  throwIfAborted
} = require('../llm-reconnect-retry');

/**
 * 上下文压缩的 Main 侧入口。
 *
 * 判定与折叠**全在 Rust**（`crates/dieyun-core/src/compaction/fold.rs`）：确定性、
 * 幂等、无 LLM。这里只做三件 Node 才能做的事：
 * 1. 把「模型窗口 → 输入预算」算出来（settings / 档位 / 工具 schema 扣减都在 JS 侧）；
 * 2. 把上一轮服务端回报的 `usage.prompt_tokens` 透传下去（真实用量优先于字符比估值）；
 * 3. 记遥测。
 *
 * 已删除的整套旧机制（别再搬回来）：`compaction-prompts.js` 的摘要提示词、
 * `resolveCompactionLlm` 的第二条 LLM 通道、冷却轮数 `COMPACTION_COOL_DOWN_ROUNDS`、
 * `cumulativeSummary` 的跨轮累积与 `memory.compaction_recent` 水合。它们存在的唯一
 * 理由是「让 LLM 摘要尽量不丢信息」——折叠把原始消息留在原位，不需要一层摘要替它保管。
 */

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

/**
 * 有效输入预算：公式是 model-runtime-by-tier.computeEffectiveInputBudget（Renderer 同调），
 * 这里只把磁盘 settings 解析成三个 token 数。勿在本文件再写一份减法。
 */
function getEffectiveInputBudget(settings, modelRouteOrId) {
  return computeEffectiveInputBudget({
    contextWindow: resolveEffectiveContextWindow(settings, modelRouteOrId),
    maxOutputTokens: resolveMaxOutputTokens(settings),
    contextReserveTokens: resolveReserveTokens(settings)
  });
}

/**
 * 工具 schema 超出「系统预留」的部分必须从输入预算里再扣：
 * 预留只覆盖 reserve 那么多 token 的 system + tools，超出后真实请求
 * （messages + tools + system）会顶穿窗口 —— 而工具 schema 既不可折叠也不可压缩。
 *
 * 扣减上限为 base 的 25%：小窗口档本来就放不下完整工具目录，
 * 不能让预算直接塌到地板后变成「每轮误折却折不掉」。
 * 地板取 MIN_INPUT_BUDGET_TOKENS（= computeEffectiveInputBudget 的地板），
 * 两处必须同值，否则扣减后的预算会反超 base。
 */
const TOOLS_SCHEMA_DEDUCT_MAX_RATIO = 0.25;
/** 字符→token 折算系数唯一来源：agent-limits.js（与 Rust compaction/tokens.rs 同值） */
const CHARS_PER_TOKEN = AGENT_LIMITS_DEFAULTS.charsPerToken;

function applyToolSchemaDeduction(baseBudget, reserveTokens, toolsChars) {
  const base = Math.max(MIN_INPUT_BUDGET_TOKENS, Number(baseBudget) || 0);
  const chars = Math.max(0, Number(toolsChars) || 0);
  if (!chars) return base;
  const toolsTokens = Math.ceil(chars / CHARS_PER_TOKEN);
  const excess = Math.max(0, toolsTokens - Math.max(0, Number(reserveTokens) || 0));
  const capped = Math.min(excess, Math.floor(base * TOOLS_SCHEMA_DEDUCT_MAX_RATIO));
  return Math.max(MIN_INPUT_BUDGET_TOKENS, base - capped);
}

function getCompactionTriggerRatio(settings) {
  const r = Number(settings.compactionTriggerRatio);
  // 夹取区间唯一来源 src/agent/agent-shared.json（Rust `compaction/fold.rs` 读同一份并 clamp）。
  if (Number.isFinite(r) && r > 0) {
    const { triggerRatioMin, triggerRatioMax } = require('./shared-constants').compaction;
    return Math.min(triggerRatioMax, Math.max(triggerRatioMin, r));
  }
  return MODEL_RUNTIME_DEFAULTS.compactionTriggerRatio;
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
 * @param {string} userData
 * @param {{ invoke?: Function, isReady?: Function } | null} coreBridge
 */
function createMainCompactionAgent(userData, coreBridge = null) {
  async function estimateMessagesTokens(messages) {
    const bridge = requireCoreBridge(coreBridge);
    const r = await bridge.invoke('compaction.estimate', { messages }, 10000);
    return Number(r && r.tokens) || 0;
  }

  /**
   * @param {any[]} messages
   * @param {{ tokenBudget?: number, contextTierId?: string, model?: string, sessionId?: string,
   *   toolsChars?: number, force?: boolean, observedPromptTokens?: number, signal?: AbortSignal }} [opts]
   */
  async function maybeCompactMessages(messages, opts = {}) {
    const startedAt = Date.now();
    const bridge = requireCoreBridge(coreBridge);
    // 按档位叠加「模型与段预算」：磁盘 settings 只有 default 档，非 default 档的窗口 /
    // 输出 / 预留 / 触发比必须在这一层生效，否则 16K、128K 档仍按 default 档算阈值。
    const settings = applyTierRuntime(loadModelSettings(userData), userData, {
      tierId: opts.contextTierId,
      model: opts.model
    });
    const baseBudget =
      Number(opts.tokenBudget) > 0
        ? Number(opts.tokenBudget)
        : getEffectiveInputBudget(settings, opts.model);
    const tokenBudget = applyToolSchemaDeduction(
      baseBudget,
      resolveReserveTokens(settings),
      opts.toolsChars
    );
    const triggerRatio = getCompactionTriggerRatio(settings);
    const observed = Number(opts.observedPromptTokens);

    throwIfAborted(opts.signal || null);
    const result = await raceAbortable(
      bridge
        .invoke(
          'compaction.fold',
          {
            messages,
            tokenBudget,
            triggerRatio,
            // 服务端 usage 是唯一「真值」：估算法（cjk/1.5 + other/3.2）只用于
            // 拿不到 usage 的轮次（首轮 / 非兼容端点）。
            observedPromptTokens: Number.isFinite(observed) && observed > 0 ? observed : null,
            force: !!opts.force
          },
          COMPACTION_FOLD_TIMEOUT_MS
        )
        .catch((err) => {
          if (isAbortError(err)) throw err;
          console.warn('[compaction] fold 失败', err && err.message);
          return {
            messages,
            compacted: false,
            triggered: true,
            foldSkipped: 'rpc_error',
            foldError: String((err && err.message) || err || '')
          };
        }),
      opts.signal || null
    );
    throwIfAborted(opts.signal || null);

    const payload = {
      messages: (result && result.messages) || messages,
      compacted: !!(result && result.compacted),
      triggered: !!(result && result.triggered),
      tokensBefore: result && result.tokensBefore,
      tokensAfter: result && result.tokensAfter,
      triggerSource: result && result.triggerSource,
      level: result && result.level,
      foldedToolResults: result && result.foldedToolResults,
      foldedTexts: result && result.foldedTexts,
      foldedImages: result && result.foldedImages,
      foldSkipped: result && result.foldSkipped,
      foldError: result && result.foldError,
      tokenBudget,
      triggerRatio
    };
    recordCompactionTelemetry(
      userData,
      compactionTelemetryRow({
        payload,
        force: !!opts.force,
        sessionId: opts.sessionId,
        startedAt
      })
    );
    return payload;
  }

  return {
    estimateTokens: estimateMessagesTokens,
    estimateMessagesTokens,
    maybeCompactMessages
  };
}

/**
 * 循环内折叠的预算口径（与 `maybeCompactMessages` 用的是同一份计算）。
 *
 * 为什么要有它：折叠现在发生在 core 的循环里（`agent.loop.need_llm` 之前），Node 不再
 * 每轮算一遍预算再把 messages 推回去。但「窗口→预算→扣工具 schema」这套口径仍然只有
 * 这里一处实现，core 只是执行者。
 *
 * @param {{ userData?: string, model?: string, contextTierId?: string, toolsChars?: number }} input
 * @returns {{ tokenBudget: number, triggerRatio: number }}
 */
function resolveFoldSpec(input = {}) {
  const settings = applyTierRuntime(loadModelSettings(input.userData), input.userData, {
    tierId: input.contextTierId,
    model: input.model
  });
  const baseBudget = getEffectiveInputBudget(settings, input.model);
  return {
    tokenBudget: applyToolSchemaDeduction(
      baseBudget,
      resolveReserveTokens(settings),
      input.toolsChars
    ),
    triggerRatio: getCompactionTriggerRatio(settings)
  };
}

/**
 * 记一条「循环内折叠」的遥测。
 *
 * 折叠事实由 core 给（`FoldFact`），这里只做映射——判定与折叠都不在 Node。
 * @param {string} userData
 * @param {object} fact core 回的折叠事实
 * @param {{ force?: boolean, sessionId?: string, startedAt?: number }} [opts]
 */
function recordFoldTelemetry(userData, fact, opts = {}) {
  if (!fact || !fact.level) return;
  recordCompactionTelemetry(
    userData,
    compactionTelemetryRow({
      payload: {
        compacted: true,
        triggered: true,
        tokensBefore: fact.tokensBefore,
        tokensAfter: fact.tokensAfter,
        triggerSource: fact.triggerSource,
        level: fact.level,
        foldedToolResults: fact.foldedToolResults,
        foldedTexts: fact.foldedTexts,
        foldedImages: fact.foldedImages
      },
      force: !!opts.force,
      sessionId: opts.sessionId,
      startedAt: opts.startedAt || Date.now()
    })
  );
}

module.exports = {
  createMainCompactionAgent,
  getEffectiveInputBudget,
  applyToolSchemaDeduction,
  resolveFoldSpec,
  recordFoldTelemetry
};

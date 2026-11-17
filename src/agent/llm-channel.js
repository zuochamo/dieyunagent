'use strict';

/**
 * 思考 / 正文「通道身份」的唯一来源（Main 与 Renderer 共用）。
 *
 * 目标设计见 docs/REASONING-ISOLATION-PLAN.md §2 / §3.2：
 *   - 现状：`reasoning_content` 只是一个「可能存在的 JSON 键」，5 处启发式各自猜它算正文还是思考
 *     （Rust 1 处、Node 4 处，其中 3 处逐字重复），阈值还不同。
 *   - 本模块把「这段文本属于哪个通道」变成**数据**：入口 `classifyDelta` 盖章，
 *     下游只搬运 `{ channel, text }`，不再各自用 `a || b` 判断。
 *
 * 能力表（`CHANNEL_POLICY_BY_MODEL`）是**结构性声明**，按**精确模型 id** 匹配：
 *   - 不是厂商关键词表：禁止 `/mimo/`、`/deepseek/` 这类子串匹配 —— 同一厂商强弱模型能力不同，
 *     命中厂商子串会误伤强模型（同类原则见 src/agent/tool-catalog.js 的「工具调用能力弱」判定）；
 *   - 声明来源优先级：调用方传入的 `declared`（与模型配置同源，例如设置里按模型声明的
 *     `channelPolicyByModel` / `customModels[].channelPolicy`）→ 本文件内置表 → DEFAULT。
 *     这样「某模型是什么通道」跟着它的配置走，而不是散落在各调用点。
 *
 * 纯函数、零 IO、零 Electron —— 与 model-api-config.js 一样：既能被 Main 直接 require，
 * 也能被 esbuild 打进 Renderer（src/renderer/agent/agent-bundle-entry.js）。
 */

/** 上游可能承载思考的字段名，优先级顺序与 src/agent/sse-delta-parse.js 的 extractDeltaReasoning 一致。 */
const REASONING_KEY_CANDIDATES = Object.freeze(['reasoning_content', 'reasoning', 'thinking']);

const CHANNEL_REASONING = 'reasoning';
const CHANNEL_ANSWER = 'answer';

/**
 * @typedef {object} ChannelPolicy
 * @property {string}  reasoningField 上游思考字段名；'' = 该模型没有独立思考通道
 * @property {boolean} singleChannel  只有一个字段、且语义是推理（如 mimo）→ content 进思考
 * @property {boolean} echoReasoning  工具轮 assistant 必须回传思考（DeepSeek 思考模式）
 */

/** 未声明模型的默认策略：标准 OpenAI 两通道，思考键为 reasoning_content。 */
const DEFAULT_CHANNEL_POLICY = Object.freeze({
  reasoningField: 'reasoning_content',
  singleChannel: false,
  echoReasoning: false
});

/**
 * 内置能力表：**精确模型 id**（小写）→ 声明。只登记仓库自身写死的首方默认模型；
 * 其余模型一律由调用方经第二参 `declared` 传入，**勿在此添加厂商子串规则**。
 */
const CHANNEL_POLICY_BY_MODEL = Object.freeze({
  // 仓库默认文本模型（src/model-settings.js DEFAULTS.textModel）：单通道，
  // 流式 content 即推理，不应泄漏进正文区（见 renderer-agent-rust-loop.js 同处注释）。
  'mimo-v2.5-pro': Object.freeze({ singleChannel: true })
});

function normalizeModelId(model) {
  return String(model == null ? '' : model).trim().toLowerCase();
}

/**
 * 把任意声明归一成完整策略。缺省字段回落到 DEFAULT_CHANNEL_POLICY。
 * 单通道模型未显式给 reasoningField 时置空 —— 它没有独立思考字段，避免与 content 撞键。
 *
 * @param {Partial<ChannelPolicy>|null|undefined} raw
 * @returns {ChannelPolicy}
 */
function normalizeChannelPolicy(raw) {
  const r = raw && typeof raw === 'object' ? raw : null;
  const singleChannel = !!(r && r.singleChannel === true);
  const explicitField = r && typeof r.reasoningField === 'string' ? r.reasoningField.trim() : null;
  return {
    reasoningField:
      explicitField != null
        ? explicitField
        : singleChannel
          ? ''
          : DEFAULT_CHANNEL_POLICY.reasoningField,
    singleChannel,
    echoReasoning: !!(r && r.echoReasoning === true)
  };
}

/**
 * 取模型通道策略。
 *
 * @param {string} [model]                          模型名（大小写、首尾空白不敏感）
 * @param {Partial<ChannelPolicy>} [declared]       来自模型配置的声明；给了就以它为准（不再查内置表）
 * @returns {ChannelPolicy}
 */
function getChannelPolicy(model, declared) {
  if (declared && typeof declared === 'object') return normalizeChannelPolicy(declared);
  const hit = CHANNEL_POLICY_BY_MODEL[normalizeModelId(model)];
  return normalizeChannelPolicy(hit || null);
}

/**
 * 从设置里按模型取**声明**的通道策略（纯读取，不落盘、不猜测）。
 *
 * 读取位置与「模型配置」同源：顶层按模型映射 `channelPolicyByModel`，其次
 * `customModels[]` 中 name 命中项上的 `channelPolicy`。两处都没有 → 返回 null，
 * 由 getChannelPolicy 回落到内置表 / DEFAULT。
 *
 * @param {object} [settings] model-settings.json 内容
 * @param {string} [model]
 * @returns {Partial<ChannelPolicy>|null}
 */
function channelPolicyFromSettings(settings, model) {
  const s = settings && typeof settings === 'object' ? settings : {};
  const id = normalizeModelId(model);
  if (!id) return null;

  const table = s.channelPolicyByModel;
  if (table && typeof table === 'object' && !Array.isArray(table)) {
    for (const [key, value] of Object.entries(table)) {
      if (normalizeModelId(key) === id && value && typeof value === 'object') return value;
    }
  }

  const customs = Array.isArray(s.customModels) ? s.customModels : [];
  const hit = customs.find(
    (m) => normalizeModelId(m && m.name) === id && m && typeof m.channelPolicy === 'object'
  );
  return hit ? hit.channelPolicy : null;
}

/**
 * 按策略从 delta 里取思考文本（第一个非空的候选键）。默认策略下与
 * src/agent/sse-delta-parse.js 的 extractDeltaReasoning 逐项等价。
 */
function pickReasoningText(delta, policy) {
  const keys = [];
  if (policy && policy.reasoningField) keys.push(policy.reasoningField);
  for (const key of REASONING_KEY_CANDIDATES) if (!keys.includes(key)) keys.push(key);
  for (const key of keys) {
    const text = delta[key];
    if (typeof text === 'string' && text) return text;
  }
  return '';
}

/**
 * 入口盖章：把上游 delta（流式 `choices[].delta`，或非流式 `choices[].message`）翻译成
 * 「带身份」的文本片段。全流程**唯一**判断某段文本是思考还是正文的地方。
 *
 * @param {object} delta                              上游 delta（可能含 content / reasoning_content / reasoning / thinking）
 * @param {ChannelPolicy|string|null} [policy]         getChannelPolicy() 结果；也可直接传模型名（内部再取策略）
 * @returns {{ channel: 'reasoning'|'answer', text: string, source: 'upstream' }[]}
 */
function classifyDelta(delta, policy) {
  const p =
    typeof policy === 'string' || policy == null
      ? getChannelPolicy(policy)
      : normalizeChannelPolicy(policy);
  const d = delta && typeof delta === 'object' ? delta : null;
  if (!d) return [];

  const content = typeof d.content === 'string' ? d.content : '';

  if (p.singleChannel) {
    // 单通道模型：唯一字段就是推理。content 一律进思考，绝不进正文。
    return content ? [{ channel: CHANNEL_REASONING, text: content, source: 'upstream' }] : [];
  }

  const out = [];
  if (content) out.push({ channel: CHANNEL_ANSWER, text: content, source: 'upstream' });
  const reasoning = pickReasoningText(d, p);
  if (reasoning) out.push({ channel: CHANNEL_REASONING, text: reasoning, source: 'upstream' });
  return out;
}

module.exports = {
  REASONING_KEY_CANDIDATES,
  DEFAULT_CHANNEL_POLICY,
  CHANNEL_POLICY_BY_MODEL,
  normalizeChannelPolicy,
  getChannelPolicy,
  channelPolicyFromSettings,
  classifyDelta
};

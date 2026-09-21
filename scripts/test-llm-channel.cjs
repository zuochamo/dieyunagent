'use strict';

/**
 * Unit checks for src/agent/llm-channel.js.
 * Run: node scripts/test-llm-channel.cjs
 *
 * 目标：把「现状」当 golden 钉死 —— 默认策略下 classifyDelta 的通道归属必须与
 * src/llm-stream-utils.js 现有 extractDeltaReasoning（reasoning_content / reasoning /
 * thinking 取第一个非空）+ content 的判定逐项一致。提交 2 改消费方前，先靠这里保底。
 */

const {
  REASONING_KEY_CANDIDATES,
  DEFAULT_CHANNEL_POLICY,
  CHANNEL_POLICY_BY_MODEL,
  normalizeChannelPolicy,
  getChannelPolicy,
  channelPolicyFromSettings,
  classifyDelta
} = require('../src/agent/llm-channel');

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assert failed');
}

/** 把 classifyDelta 结果压成 'channel:text|channel:text' 便于逐项比对。 */
function stamps(chunks) {
  return chunks.map((c) => `${c.channel}:${c.text}`).join('|');
}

// --- 默认策略：与现有 extractDeltaReasoning 判定逐项一致 -----------------------
assert(
  stamps(classifyDelta({ content: '答', reasoning_content: '想' })) === 'answer:答|reasoning:想',
  'two-channel: content→answer, reasoning_content→reasoning'
);
assert(stamps(classifyDelta({ reasoning_content: '想' })) === 'reasoning:想', 'reasoning-only stays reasoning');
assert(stamps(classifyDelta({ content: '答' })) === 'answer:答', 'content-only is answer under default policy');
assert(
  stamps(classifyDelta({ content: '答', reasoning: '想r' })) === 'answer:答|reasoning:想r',
  'reasoning key fallback'
);
assert(
  stamps(classifyDelta({ content: '答', thinking: '想t' })) === 'answer:答|reasoning:想t',
  'thinking key fallback'
);
assert(
  stamps(classifyDelta({ content: '答', reasoning_content: 'a', reasoning: 'b', thinking: 'c' })) ===
    'answer:答|reasoning:a',
  'key priority: reasoning_content first, matches llm-stream-utils order'
);
assert(
  JSON.stringify(REASONING_KEY_CANDIDATES) === JSON.stringify(['reasoning_content', 'reasoning', 'thinking']),
  'candidate order pinned to llm-stream-utils'
);

// --- 容错：空 / 非字符串 / 缺 delta ------------------------------------------
assert(stamps(classifyDelta({})) === '', 'empty delta yields nothing');
assert(stamps(classifyDelta({ content: '' })) === '', 'empty content yields nothing');
assert(stamps(classifyDelta({ content: 123 })) === '', 'non-string content ignored');
assert(stamps(classifyDelta({ content: null, reasoning_content: 'x' })) === 'reasoning:x', 'null content ignored');
assert(stamps(classifyDelta(null)) === '', 'null delta tolerated');
assert(stamps(classifyDelta(undefined)) === '', 'undefined delta tolerated');

// --- source 标记 -------------------------------------------------------------
const stamped = classifyDelta({ content: '答', reasoning_content: '想' });
assert(
  stamped.every((c) => c.source === 'upstream'),
  'all upstream chunks tagged source=upstream'
);

// --- 内置单通道模型（精确 id 声明，非厂商子串） -------------------------------
const mimo = getChannelPolicy('mimo-v2.5-pro');
assert(mimo.singleChannel === true, 'mimo-v2.5-pro declared singleChannel');
assert(mimo.reasoningField === '', 'single-channel has no separate reasoning field');
assert(mimo.echoReasoning === false, 'mimo does not require echoing reasoning');
assert(stamps(classifyDelta({ content: '推理文本' }, 'mimo-v2.5-pro')) === 'reasoning:推理文本', 'mimo content → reasoning');
assert(
  stamps(classifyDelta({ content: '推理文本', reasoning_content: '旁路' }, 'mimo-v2.5-pro')) === 'reasoning:推理文本',
  'single-channel ignores separate reasoning field'
);

// --- 模型 id 归一（大小写 / 首尾空白） ---------------------------------------
assert(getChannelPolicy('MiMo-V2.5-Pro').singleChannel === true, 'model id case-insensitive');
assert(getChannelPolicy('  mimo-v2.5-pro  ').singleChannel === true, 'model id trims whitespace');

// --- 默认策略取值 ------------------------------------------------------------
const unknown = getChannelPolicy('some-unlisted-model');
assert(
  unknown.singleChannel === false &&
    unknown.reasoningField === 'reasoning_content' &&
    unknown.echoReasoning === false,
  'unknown model falls back to DEFAULT_CHANNEL_POLICY'
);
assert(unknown.singleChannel === DEFAULT_CHANNEL_POLICY.singleChannel, 'default singleChannel value');

// --- 调用方声明优先于内置表 --------------------------------------------------
const declaredSingle = getChannelPolicy('mimo-v2.5-pro', { singleChannel: false, reasoningField: 'thoughts' });
assert(
  declaredSingle.singleChannel === false && declaredSingle.reasoningField === 'thoughts',
  'declared policy wins over builtin table'
);
assert(
  getChannelPolicy('x', { echoReasoning: true }).echoReasoning === true,
  'declared echoReasoning honored'
);
assert(
  getChannelPolicy('x', { reasoningField: 'thoughts' }).reasoningField === 'thoughts',
  'declared reasoningField honored'
);

// --- 自定义 reasoningField 参与分流 ------------------------------------------
const thoughtsPolicy = getChannelPolicy('x', { reasoningField: 'thoughts' });
assert(
  stamps(classifyDelta({ content: 'a', thoughts: 'b' }, thoughtsPolicy)) === 'answer:a|reasoning:b',
  'custom reasoningField classified as reasoning'
);

// --- normalizeChannelPolicy --------------------------------------------------
const normalized = normalizeChannelPolicy({ singleChannel: true, echoReasoning: true });
assert(
  normalized.singleChannel === true && normalized.reasoningField === '' && normalized.echoReasoning === true,
  'normalize fills gaps and clears field for single channel'
);
assert(normalizeChannelPolicy(null).reasoningField === 'reasoning_content', 'normalize(null) → default');

// --- 从设置读取声明（与模型配置同源） ----------------------------------------
assert(
  channelPolicyFromSettings(
    { channelPolicyByModel: { 'My Model': { singleChannel: true } } },
    'my model'
  ).singleChannel === true,
  'channelPolicyByModel matched case-insensitively'
);
assert(
  channelPolicyFromSettings({ customModels: [{ name: 'm', channelPolicy: { echoReasoning: true } }] }, 'M')
    .echoReasoning === true,
  'customModels[].channelPolicy read'
);
assert(channelPolicyFromSettings({}, 'x') === null, 'no declaration → null');
assert(channelPolicyFromSettings(null, 'x') === null, 'null settings tolerated');
assert(channelPolicyFromSettings({ channelPolicyByModel: {} }, '') === null, 'blank model id → null');

// --- 内置表守卫：只允许精确 id，禁止厂商子串 --------------------------------
assert(
  JSON.stringify(Object.keys(CHANNEL_POLICY_BY_MODEL)) === JSON.stringify(['mimo-v2.5-pro']),
  'builtin table stays exact-id only (no vendor substrings)'
);

console.log('test-llm-channel.cjs ok');

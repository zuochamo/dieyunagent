'use strict';

/**
 * 编码参数 · 模型与段预算 — 按 Context 档位
 * @typedef {{ id: string, label: string, hint: string, values: Record<string, number> }} ModelRuntimePreset
 */

/** 已删除档位 → 现行 id（磁盘 / 供应商绑定迁移用） */
const LEGACY_CONTEXT_TIER_ALIASES = Object.freeze({
  'ctx-8k': 'ctx-16k'
});

/**
 * 「默认」档与「512K」档共用同一组出厂值 —— 单一来源，避免两处各写一份后漂移。
 * 两个档位各自展开一份（`{ ...TIER_SHARED_512K_VALUES }`），不共享可变对象引用。
 *
 * 关于 `agentToolCallLimit`：**所有档位统一 600**（= model-runtime-schema 的 max 上限）。
 * 小窗口档位不再配更小的工具段预算，额度差异只由窗口 / 轮次体现。
 */
const TIER_SHARED_512K_VALUES = Object.freeze({
  temperature: 0.3,
  contextWindow: 524288,
  maxOutputTokens: 32768,
  contextReserveTokens: 32768,
  compactionTriggerRatio: 0.88,
  agentToolCallLimit: 600,
  agentMaxRounds: 96
});

/** @type {ModelRuntimePreset[]} */
const MODEL_RUNTIME_PRESETS = [
  {
    id: 'default',
    label: '默认',
    hint: '等同 512K 档：512k 长窗口，大项目编程通用',
    values: { ...TIER_SHARED_512K_VALUES }
  },
  {
    id: 'ctx-16k',
    label: '16K',
    hint: '最小档：短对话、轻量问答、旧中转 16k（8K 档已删除）',
    values: {
      temperature: 0.3,
      contextWindow: 16384,
      maxOutputTokens: 4096,
      contextReserveTokens: 4096,
      compactionTriggerRatio: 0.75,
      agentToolCallLimit: 600,
      agentMaxRounds: 32
    }
  },
  {
    id: 'ctx-32k',
    label: '32K',
    hint: '常见中转/开源 32k：留足历史，适合中等规模任务',
    values: {
      temperature: 0.3,
      contextWindow: 32768,
      maxOutputTokens: 8192,
      contextReserveTokens: 8192,
      compactionTriggerRatio: 0.8,
      agentToolCallLimit: 600,
      agentMaxRounds: 64
    }
  },
  {
    id: 'ctx-64k',
    label: '64K',
    hint: '64k 中等窗口：介于 32k 与 128k，适合较大仓库单会话',
    values: {
      temperature: 0.3,
      contextWindow: 65536,
      maxOutputTokens: 12288,
      contextReserveTokens: 12288,
      compactionTriggerRatio: 0.82,
      agentToolCallLimit: 600,
      agentMaxRounds: 80
    }
  },
  {
    id: 'ctx-128k',
    label: '128K',
    hint: '128k 大窗口 + 长输出：多轮改码、大段生成',
    values: {
      temperature: 0.3,
      contextWindow: 128000,
      maxOutputTokens: 24576,
      contextReserveTokens: 24576,
      compactionTriggerRatio: 0.85,
      agentToolCallLimit: 600,
      agentMaxRounds: 96
    }
  },
  {
    id: 'ctx-200k',
    label: '200K',
    hint: 'Claude 200k 等超长上下文模型',
    values: {
      temperature: 0.3,
      contextWindow: 200000,
      maxOutputTokens: 32768,
      contextReserveTokens: 32768,
      compactionTriggerRatio: 0.88,
      agentToolCallLimit: 600,
      agentMaxRounds: 96
    }
  },
  {
    id: 'ctx-512k',
    label: '512K',
    hint: '512k 长窗口：介于 200k 与 1M',
    values: { ...TIER_SHARED_512K_VALUES }
  },
  {
    id: 'ctx-1m',
    label: '1M',
    hint: '百万上下文：Gemini 1.5/2.x、GPT-4.1 等',
    values: {
      temperature: 0.3,
      contextWindow: 1000000,
      maxOutputTokens: 32768,
      contextReserveTokens: 65536,
      compactionTriggerRatio: 0.9,
      agentToolCallLimit: 600,
      agentMaxRounds: 96
    }
  },
  {
    id: 'ctx-2m',
    label: '2M',
    hint: '两百万窗口：部分 Gemini 长上下文接口',
    values: {
      temperature: 0.3,
      contextWindow: 2000000,
      maxOutputTokens: 32768,
      contextReserveTokens: 65536,
      compactionTriggerRatio: 0.9,
      agentToolCallLimit: 600,
      agentMaxRounds: 96
    }
  }
];

const MODEL_RUNTIME_DEFAULTS = {
  ...(MODEL_RUNTIME_PRESETS.find((p) => p.id === 'default') || MODEL_RUNTIME_PRESETS[0]).values
};

function getModelRuntimePresetById(id) {
  const key = remapLegacyContextTierId(id);
  return MODEL_RUNTIME_PRESETS.find((p) => p.id === key) || null;
}

function remapLegacyContextTierId(id) {
  const key = String(id || '').trim();
  return LEGACY_CONTEXT_TIER_ALIASES[key] || key;
}

/**
 * 把按档存储的对象键迁到现行 id；同目标下现行 id 覆盖别名。
 * @param {Record<string, object>} raw
 * @param {(id: string) => boolean} [isKnown]
 */
function foldLegacyContextTierRecord(raw, isKnown) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [tierId, values] of Object.entries(raw)) {
    if (!values || typeof values !== 'object' || Array.isArray(values)) continue;
    const mapped = remapLegacyContextTierId(tierId);
    if (typeof isKnown === 'function' && !isKnown(mapped)) continue;
    if (!out[mapped] || mapped === tierId) {
      out[mapped] = { ...values };
    }
  }
  return out;
}

const api = {
  MODEL_RUNTIME_PRESETS,
  MODEL_RUNTIME_DEFAULTS,
  TIER_SHARED_512K_VALUES,
  LEGACY_CONTEXT_TIER_ALIASES,
  getModelRuntimePresetById,
  remapLegacyContextTierId,
  foldLegacyContextTierRecord
};

module.exports = api;

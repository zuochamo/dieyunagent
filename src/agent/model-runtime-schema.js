'use strict';

/** @typedef {{ key: string, label: string, hint?: string, type: 'number', min: number, max: number, step: number, format?: 'temp'|'tokens'|'ratio'|'int' }} ModelRuntimeSchemaItem */
/** @typedef {{ group: string, groupId: string, items: ModelRuntimeSchemaItem[] }} ModelRuntimeSchemaGroup */

(function initModelRuntimeSchema(global) {
  /** UI / 持久化 clamp 上限；覆盖 2M 档，常见为 32k–128k / 200k / 1M。 */
  const CONTEXT_WINDOW_MAX = 2000000;

  function resolveModelRuntimeDefaults() {
    try {
      if (typeof require === 'function') {
        return require('./model-runtime-presets').MODEL_RUNTIME_DEFAULTS;
      }
    } catch (_) {
      /* browser */
    }
    if (global && global.MODEL_RUNTIME_DEFAULTS) {
      return global.MODEL_RUNTIME_DEFAULTS;
    }
    return {
      temperature: 0.3,
      contextWindow: 128000,
      maxOutputTokens: 16384,
      contextReserveTokens: 16384,
      compactionTriggerRatio: 0.85,
      agentToolCallLimit: 200,
      agentMaxRounds: 96
    };
  }

  /** @type {ModelRuntimeSchemaGroup[]} */
  const MODEL_RUNTIME_SCHEMA = [
    {
      group: '模型与段预算',
      groupId: 'model-runtime',
      items: [
        {
          key: 'temperature',
          label: '温度',
          hint: '越低越稳定，编程推荐 0.3',
          type: 'number',
          min: 0,
          max: 2,
          step: 0.1,
          format: 'temp'
        },
        {
          key: 'contextWindow',
          label: '上下文窗口',
          hint: '按模型文档填写真实值；滑块上限 2M，常见为 32k / 128k / 200k / 1M',
          type: 'number',
          min: 8192,
          max: CONTEXT_WINDOW_MAX,
          step: 1024,
          format: 'tokens'
        },
        {
          key: 'maxOutputTokens',
          label: '最大输出 Tokens',
          type: 'number',
          min: 1024,
          max: 240000,
          step: 1024,
          format: 'tokens'
        },
        {
          key: 'contextReserveTokens',
          label: '系统预留 Tokens',
          hint: '留给系统提示与工具 schema，不可超过窗口 − 输出',
          type: 'number',
          min: 0,
          max: 500000,
          step: 1024,
          format: 'tokens'
        },
        {
          key: 'compactionTriggerRatio',
          label: '压缩触发比例',
          hint: '上下文用量达到该比例时触发压缩',
          type: 'number',
          min: 0.3,
          max: 0.95,
          step: 0.01,
          format: 'ratio'
        },
        {
          key: 'agentToolCallLimit',
          label: '工具调用段上限',
          hint: '每段任务最多调用多少次工具，点「继续」后再给同样额度',
          type: 'number',
          min: 15,
          max: 600,
          step: 1,
          format: 'int'
        },
        {
          key: 'agentMaxRounds',
          label: 'Agent 轮次段上限',
          hint: '每段任务最多多少轮 LLM↔工具循环，点「继续」后再给同样额度',
          type: 'number',
          min: 15,
          max: 600,
          step: 1,
          format: 'int'
        }
      ]
    }
  ];

  const MODEL_RUNTIME_SCHEMA_BY_KEY = new Map();
  for (const group of MODEL_RUNTIME_SCHEMA) {
    for (const item of group.items) {
      MODEL_RUNTIME_SCHEMA_BY_KEY.set(item.key, item);
    }
  }

  function formatModelRuntimeValue(item, value) {
    const n = Number(value);
    if (item.format === 'temp') return Number(n).toFixed(1);
    if (item.format === 'ratio') return Number(n).toFixed(2);
    if (item.format === 'int') return String(Math.round(n));
    return Math.round(n).toLocaleString('zh-CN');
  }

  if (typeof global === 'object' && global) {
    global.CONTEXT_WINDOW_MAX = CONTEXT_WINDOW_MAX;
    global.MODEL_RUNTIME_SCHEMA = MODEL_RUNTIME_SCHEMA;
    global.formatModelRuntimeValue = formatModelRuntimeValue;
    if (!global.MODEL_RUNTIME_DEFAULTS) {
      global.MODEL_RUNTIME_DEFAULTS = resolveModelRuntimeDefaults();
    }
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      CONTEXT_WINDOW_MAX,
      get MODEL_RUNTIME_DEFAULTS() {
        return resolveModelRuntimeDefaults();
      },
      MODEL_RUNTIME_SCHEMA,
      MODEL_RUNTIME_SCHEMA_BY_KEY,
      formatModelRuntimeValue
    };
  }
})(typeof window !== 'undefined' ? window : globalThis);

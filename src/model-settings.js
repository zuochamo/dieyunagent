'use strict';

const fs = require('fs');
const path = require('path');
const {
  BUILTIN_EMBEDDING_DIMENSIONS,
  BUILTIN_EMBEDDING_ID
} = require('./codebase/local-embedding');
const {
  isBuiltinEmbeddingListEntry,
  mergeEmbeddingModelsList,
  resolveActiveEmbeddingModel
} = require('./embedding-model-presets');
const { CONTEXT_WINDOW_MAX } = require('./agent/model-runtime-schema');
const { MODEL_RUNTIME_DEFAULTS: PRESET_DEFAULTS } = require('./agent/model-runtime-presets');

const MAX_OUTPUT_TOKENS_DEFAULT = PRESET_DEFAULTS.maxOutputTokens;
const CONTEXT_WINDOW_DEFAULT = PRESET_DEFAULTS.contextWindow;
const CONTEXT_RESERVE_DEFAULT = PRESET_DEFAULTS.contextReserveTokens;
const COMPACTION_TRIGGER_RATIO_DEFAULT = PRESET_DEFAULTS.compactionTriggerRatio;
const AGENT_TOOL_CALL_LIMIT_DEFAULT = PRESET_DEFAULTS.agentToolCallLimit;
const AGENT_MAX_ROUNDS_DEFAULT = PRESET_DEFAULTS.agentMaxRounds;
const MAX_TOKENS_DEFAULT = MAX_OUTPUT_TOKENS_DEFAULT;
const MAX_TOKENS_LIMIT = 240000;
const EMBEDDING_DIMENSIONS_MIN = 64;
const EMBEDDING_DIMENSIONS_MAX = 8192;

const REMOVED_BUILTIN_BASE_URLS = new Set(['http://192.168.31.127:30001/v1']);

function isRemovedBuiltinBaseUrl(url) {
  return REMOVED_BUILTIN_BASE_URLS.has(String(url || '').trim());
}
const DEFAULT_BUILTIN_BASE_URL = '';
const DEFAULT_BUILTIN_API_KEY = '';
const DEFAULTS = {
  baseUrl: DEFAULT_BUILTIN_BASE_URL,
  apiKey: DEFAULT_BUILTIN_API_KEY,
  textModel: 'mimo-v2.5-pro',
  visionModel: 'qwen3.6-plus',
  visionBaseUrl: '',
  visionApiKey: '',
  builtinBaseUrl: DEFAULT_BUILTIN_BASE_URL,
  builtinApiKey: DEFAULT_BUILTIN_API_KEY,
  system: '',
  temperature: 0.3,
  maxTokens: MAX_OUTPUT_TOKENS_DEFAULT,
  maxOutputTokens: MAX_OUTPUT_TOKENS_DEFAULT,
  contextWindow: CONTEXT_WINDOW_DEFAULT,
  contextReserveTokens: CONTEXT_RESERVE_DEFAULT,
  compactionTriggerRatio: COMPACTION_TRIGGER_RATIO_DEFAULT,
  agentToolCallLimit: AGENT_TOOL_CALL_LIMIT_DEFAULT,
  agentMaxRounds: AGENT_MAX_ROUNDS_DEFAULT,
  embeddingEnabled: true,
  embeddingBaseUrl: '',
  embeddingApiKey: '',
  embeddingModel: '',
  embeddingDimensions: 1024,
  embeddingModels: mergeEmbeddingModelsList([]),
  graphAutoIncremental: true,
  codebaseAutoIncremental: true,
  speechWhisperModel: 'whisper-1',
  speechLanguage: 'zh'
};

function resolveSpeechApiConfig(settings) {
  const s = settings && typeof settings === 'object' ? settings : {};
  const customModels = Array.isArray(s.customModels) ? s.customModels : [];
  const speechCustom = customModels.find((m) => m && m.kind === 'speech' && String(m.name || '').trim());
  if (speechCustom) {
    return {
      baseUrl: String(speechCustom.baseUrl || '').trim(),
      apiKey: String(speechCustom.apiKey || '').trim(),
      model: String(speechCustom.name).trim(),
      language: String(s.speechLanguage || 'zh').trim()
    };
  }
  const suppliers = Array.isArray(s.modelSuppliers) ? s.modelSuppliers : [];
  const supplier = suppliers.find((row) => String(row?.baseUrl || '').trim()) || null;
  const baseUrl = String(s.speechBaseUrl || supplier?.baseUrl || s.builtinBaseUrl || s.baseUrl || '').trim();
  const apiKey = String(s.speechApiKey || supplier?.apiKey || s.builtinApiKey || s.apiKey || '').trim();
  const model = String(s.speechWhisperModel || 'whisper-1').trim() || 'whisper-1';
  const language = String(s.speechLanguage || 'zh').trim();
  return { baseUrl, apiKey, model, language };
}

function clampMaxTokens(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v < 1) return MAX_OUTPUT_TOKENS_DEFAULT;
  return Math.min(MAX_TOKENS_LIMIT, Math.max(1, Math.floor(v)));
}

function clampContextWindow(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v < 8192) return CONTEXT_WINDOW_DEFAULT;
  return Math.min(CONTEXT_WINDOW_MAX, Math.max(8192, Math.floor(v)));
}

function clampContextReserve(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v < 0) return CONTEXT_RESERVE_DEFAULT;
  return Math.min(500000, Math.max(0, Math.floor(v)));
}

function clampTriggerRatio(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return COMPACTION_TRIGGER_RATIO_DEFAULT;
  return Math.min(0.95, Math.max(0.3, v));
}

function clampAgentToolCallLimit(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v < 1) return AGENT_TOOL_CALL_LIMIT_DEFAULT;
  return Math.min(600, Math.max(5, Math.floor(v)));
}

function clampAgentMaxRounds(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v < 1) return AGENT_MAX_ROUNDS_DEFAULT;
  return Math.min(600, Math.max(5, Math.floor(v)));
}

function modelSettingsPath(userData) {
  return path.join(userData, 'model-settings.json');
}

function normalizeEmbeddingEntry(m, index) {
  const builtin = isBuiltinEmbeddingListEntry(m);
  return {
    id: String(m?.id || `embedding-${index + 1}`),
    name: String(m?.name || '').trim(),
    baseUrl: builtin ? '内置' : String(m?.baseUrl || '').trim(),
    apiKey: builtin ? '' : String(m?.apiKey || '').trim(),
    dimensions: Math.min(
      EMBEDDING_DIMENSIONS_MAX,
      Math.max(EMBEDDING_DIMENSIONS_MIN, Number(m?.dimensions) || (builtin ? BUILTIN_EMBEDDING_DIMENSIONS : DEFAULTS.embeddingDimensions))
    ),
    active: m?.active === true,
    builtin
  };
}

function normalize(raw) {
  const s = { ...DEFAULTS, ...(raw && typeof raw === 'object' ? raw : {}) };
  s.system = '';
  if (raw && raw.model && !raw.textModel) s.textModel = raw.model;
  if (raw && raw.maxTokens && !raw.maxOutputTokens) s.maxOutputTokens = raw.maxTokens;
  if (!s.builtinBaseUrl || isRemovedBuiltinBaseUrl(s.builtinBaseUrl)) {
    s.builtinBaseUrl = DEFAULT_BUILTIN_BASE_URL;
  }
  if (!s.builtinApiKey || isRemovedBuiltinBaseUrl(raw?.builtinBaseUrl)) {
    s.builtinApiKey = DEFAULT_BUILTIN_API_KEY;
  }
  s.maxOutputTokens = clampMaxTokens(s.maxOutputTokens);
  s.maxTokens = s.maxOutputTokens;
  s.contextWindow = clampContextWindow(s.contextWindow);
  s.contextReserveTokens = Math.min(
    clampContextReserve(s.contextReserveTokens),
    Math.max(0, s.contextWindow - s.maxOutputTokens)
  );
  s.compactionTriggerRatio = clampTriggerRatio(s.compactionTriggerRatio);
  if (Math.abs(Number(s.temperature) - 0.7) < 0.001) {
    s.temperature = DEFAULTS.temperature;
  }
  if (
    Math.abs(Number(s.compactionTriggerRatio) - 0.75) < 0.001 ||
    Math.abs(Number(s.compactionTriggerRatio) - 0.68) < 0.001
  ) {
    s.compactionTriggerRatio = COMPACTION_TRIGGER_RATIO_DEFAULT;
  }
  s.agentToolCallLimit = clampAgentToolCallLimit(s.agentToolCallLimit);
  s.agentMaxRounds = clampAgentMaxRounds(s.agentMaxRounds);
  s.graphAutoIncremental = s.graphAutoIncremental !== false;
  s.codebaseAutoIncremental = s.codebaseAutoIncremental !== false;

  const hasRawEmbeddingModels =
    raw && Object.prototype.hasOwnProperty.call(raw, 'embeddingModels');
  let sourceEmbeddingModels = hasRawEmbeddingModels && Array.isArray(raw.embeddingModels)
    ? raw.embeddingModels
    : [];
  if (!hasRawEmbeddingModels && (String(s.embeddingModel || '').trim() || String(s.embeddingBaseUrl || '').trim())) {
    sourceEmbeddingModels = [{
      id: 'embedding-legacy',
      name: s.embeddingModel,
      baseUrl: s.embeddingBaseUrl,
      apiKey: s.embeddingApiKey,
      dimensions: s.embeddingDimensions,
      active: s.embeddingEnabled !== false
    }];
  }
  const normalizedEmbeddingSource = sourceEmbeddingModels.map(normalizeEmbeddingEntry);
  const normalizedUserModels = normalizedEmbeddingSource.filter((m) => m.name && !m.builtin);
  const builtinEmbeddingEntry = normalizedEmbeddingSource.find((m) => m.builtin);
  s.embeddingModels = mergeEmbeddingModelsList(
    builtinEmbeddingEntry ? [...normalizedUserModels, builtinEmbeddingEntry] : normalizedUserModels
  );

  let activeSeen = false;
  s.embeddingModels = s.embeddingModels.map((m) => {
    const active = m.active && !activeSeen;
    if (active) activeSeen = true;
    return { ...m, active };
  });
  if (!activeSeen) {
    let pickedBuiltin = false;
    s.embeddingModels = s.embeddingModels.map((m) => {
      if (!pickedBuiltin && m.builtin) {
        pickedBuiltin = true;
        return { ...m, active: true };
      }
      return { ...m, active: false };
    });
  }

  const activeEmbedding = resolveActiveEmbeddingModel(s.embeddingModels);
  s.embeddingEnabled = !!activeEmbedding;
  if (!activeEmbedding) {
    s.embeddingModel = '';
    s.embeddingBaseUrl = '';
    s.embeddingApiKey = '';
    s.embeddingDimensions = DEFAULTS.embeddingDimensions;
    return s;
  }
  s.embeddingModel = activeEmbedding.name;
  s.embeddingBaseUrl = activeEmbedding.builtin ? '' : activeEmbedding.baseUrl;
  s.embeddingApiKey = activeEmbedding.builtin ? '' : activeEmbedding.apiKey;
  s.embeddingDimensions = activeEmbedding.dimensions || DEFAULTS.embeddingDimensions;
  return s;
}

function loadModelSettings(userData) {
  try {
    const raw = JSON.parse(fs.readFileSync(modelSettingsPath(userData), 'utf8'));
    return normalize(raw);
  } catch {
    return normalize({});
  }
}

function saveModelSettings(userData, settings) {
  const file = modelSettingsPath(userData);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(normalize(settings), null, 2), 'utf8');
}

/** @param {object} [settings] */
function getEmbeddingConfig(settings) {
  const s = normalize(settings);
  const active = resolveActiveEmbeddingModel(s.embeddingModels);
  if (!active) {
    return {
      baseUrl: '',
      apiKey: '',
      model: '',
      dimensions: 0,
      disabled: true
    };
  }
  if (active.builtin) {
    return {
      baseUrl: '',
      apiKey: '',
      model: BUILTIN_EMBEDDING_ID,
      dimensions: BUILTIN_EMBEDDING_DIMENSIONS,
      builtin: true
    };
  }
  return {
    baseUrl: active.baseUrl,
    apiKey: active.apiKey,
    model: active.name,
    dimensions: active.dimensions || DEFAULTS.embeddingDimensions
  };
}

function embeddingSignature(settings) {
  const cfg = getEmbeddingConfig(settings);
  if (!cfg || cfg.disabled || !cfg.model) return '';
  return `${cfg.model}@${cfg.dimensions}`;
}

module.exports = {
  loadModelSettings,
  saveModelSettings,
  getEmbeddingConfig,
  embeddingSignature,
  resolveSpeechApiConfig,
  DEFAULTS,
  MAX_TOKENS_DEFAULT,
  MAX_TOKENS_LIMIT,
  clampMaxTokens,
  clampContextWindow,
  CONTEXT_WINDOW_MAX,
  clampContextReserve,
  clampTriggerRatio,
  clampAgentToolCallLimit,
  clampAgentMaxRounds
};

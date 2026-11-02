'use strict';

const fs = require('fs');
const path = require('path');
const { clampModelRuntimeValue } = require('./agent/model-runtime-schema');
const { MODEL_RUNTIME_DEFAULTS: PRESET_DEFAULTS } = require('./agent/model-runtime-presets');
const {
  resolveApiConfigForRoute,
  resolveDefaultApiConfig,
  requestOptionsFrom,
  listSuppliers,
  supplierModelIds,
  isSupplierModelEnabled
} = require('./agent/model-api-config');

const MAX_OUTPUT_TOKENS_DEFAULT = PRESET_DEFAULTS.maxOutputTokens;
const CONTEXT_WINDOW_DEFAULT = PRESET_DEFAULTS.contextWindow;
const CONTEXT_RESERVE_DEFAULT = PRESET_DEFAULTS.contextReserveTokens;
const COMPACTION_TRIGGER_RATIO_DEFAULT = PRESET_DEFAULTS.compactionTriggerRatio;
const AGENT_TOOL_CALL_LIMIT_DEFAULT = PRESET_DEFAULTS.agentToolCallLimit;
const AGENT_MAX_ROUNDS_DEFAULT = PRESET_DEFAULTS.agentMaxRounds;
const MAX_TOKENS_DEFAULT = MAX_OUTPUT_TOKENS_DEFAULT;
const EMBEDDING_DIMENSIONS_MIN = 64;
const EMBEDDING_DIMENSIONS_MAX = 8192;

const DEFAULT_BUILTIN_BASE_URL = '';
const DEFAULT_BUILTIN_API_KEY = '';
const DEFAULTS = {
  baseUrl: DEFAULT_BUILTIN_BASE_URL,
  apiKey: DEFAULT_BUILTIN_API_KEY,
  textModel: 'mimo-v2.5-pro',
  builtinBaseUrl: DEFAULT_BUILTIN_BASE_URL,
  builtinApiKey: DEFAULT_BUILTIN_API_KEY,
  system: '',
  temperature: PRESET_DEFAULTS.temperature,
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
  embeddingModels: [],
  graphAutoIncremental: true,
  // 代码索引增量默认关：它要跑 chunk + FTS + embedding，属重活；且 R2/R3 之后
  // 没有向量的仓没有「新鲜度」要求（见 docs/INDEX-VALUE-REVIEW.md §R4）。
  codebaseAutoIncremental: false,
  // 「这个工作区的代码索引要不要带向量」的**持久意图**。默认关——embedding 是最贵的一环，
  // 不能替用户默认打开。
  //
  // 为什么必须是持久设置而不是一个按钮：唯一的另一处触发点是索引面板的「建向量」，
  // 而 SSH 会话的索引库是每会话一份（`<worktree>/.dieyun/index.sqlite`），
  // 人要每开一个会话就手点一次全仓 embedding —— 实际上等于永远不点，
  // 于是 `vectorCount` 长期为 0、检索只剩子串通道（见 docs/SSH-INDEX-COLD-START-PLAN.md §0.5）。
  indexSemanticSearch: false,
  speechWhisperModel: 'whisper-1',
  speechLanguage: 'zh',
  // 自动朗读每条新回复（Renderer 写入；Main 只做落盘与默认值）
  ttsAutoRead: false
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
  // 一并带出请求修饰字段（转写端点也可能要求自定义头 / User-Agent）
  return { ...requestOptionsFrom(supplier || s), baseUrl, apiKey, model, language };
}

/**
 * 语音**合成**（朗读）的配置解析 —— Main 侧唯一入口。
 *
 * 与 `resolveSpeechApiConfig`（转写）**刻意分开**：一台服务端往往只有其中一种能力
 * （用户那台 5018 有 tts、没有 /v1/audio/transcriptions），混用一个槽位就会出
 * 「设置了却 404」。
 *
 * 判据与 Renderer 的 `ModelCapabilities.pickTtsModel` 一致（两处都只按
 * 「kind/modelModalities === 'tts'」认），区别只在这里要 apiKey 等出站字段：
 *   - 自定义模型：`kind: 'tts'`（含音色 voice、格式 format）；
 *   - 供应商模型：`modelModalities[id] === 'tts'` 且已启用。
 * 都不存在 → null（调用方据此明确报「没有可用的朗读模型」，不猜、不兜底到转写模型）。
 *
 * @param {object} settings loadModelSettings() 结果
 * @returns {{baseUrl: string, apiKey: string, model: string, voice: string, format: string}|null}
 */
function resolveTtsApiConfig(settings) {
  const s = settings && typeof settings === 'object' ? settings : {};
  const customModels = Array.isArray(s.customModels) ? s.customModels : [];
  const custom = customModels.find((m) => m && m.kind === 'tts' && String(m.name || '').trim());
  if (custom) {
    const baseUrl = String(custom.baseUrl || '').trim();
    if (!baseUrl) return null;
    return {
      ...requestOptionsFrom(custom),
      baseUrl,
      apiKey: String(custom.apiKey || '').trim(),
      model: String(custom.name).trim(),
      voice: String(custom.voice || '').trim(),
      format: String(custom.format || '').trim()
    };
  }
  for (const supplier of listSuppliers(s)) {
    if (!String(supplier?.baseUrl || '').trim()) continue;
    const modalities = supplier.modelModalities && typeof supplier.modelModalities === 'object'
      ? supplier.modelModalities
      : {};
    for (const modelId of supplierModelIds(supplier)) {
      if (!modelId || !isSupplierModelEnabled(supplier, modelId)) continue;
      if (String(modalities[modelId] || '').trim() !== 'tts') continue;
      return {
        ...requestOptionsFrom(supplier),
        baseUrl: String(supplier.baseUrl).trim(),
        apiKey: String(supplier.apiKey || '').trim(),
        model: String(modelId).trim(),
        voice: '',
        format: ''
      };
    }
  }
  return null;
}

/**
 * Main 侧取文本模型配置的唯一入口（定时计划、无 Renderer 会话的一切调用方）。
 *
 * - 有 route（`custom:<id>` / `builtin:<sid>:<model>` / `auto-*`）：按路由解析；
 *   strict=true 时路由失效（模型/供应商已被删）直接返回不可用配置，调用方据此明确报错，
 *   避免静默换 key 跑到别的模型上。
 * - 无 route：走「可用供应商 → 文本自定义模型 → 顶层 legacy → builtin」兜底。
 *
 * @param {object} settings loadModelSettings() 结果
 * @param {{ route?: string, model?: string, strict?: boolean }} [opts]
 */
function resolveTextApiConfig(settings, opts = {}) {
  const s = settings && typeof settings === 'object' ? settings : {};
  const route = String(opts.route || '').trim();
  const cfg = route
    ? resolveApiConfigForRoute(s, route, { strict: opts.strict === true })
    : resolveDefaultApiConfig(s);
  // 整体继承解析结果：逐字段重建会丢掉 headers / authMode / userAgent，
  // 于是「供应商配了自定义头，定时计划/后台调用却依然 400」。
  return {
    ...cfg,
    baseUrl: cfg.baseUrl,
    apiKey: cfg.apiKey,
    model: String(opts.model || cfg.model || s.textModel || '').trim()
  };
}

/**
 * 区间数字的唯一来源是 `agent/model-runtime-schema.js`（min / max / step / 默认值）。
 * 本文件此前自己写了一份 240000 / 8192 / 500000 / 0.3–0.95 / min 5，
 * 与 schema 的 min 15 已经漂移：设置页滑杆停在 15、这里却能存 5。
 */
function clampSetting(key, value) {
  return clampModelRuntimeValue(key, value);
}

function clampMaxTokens(n) {
  return clampSetting('maxOutputTokens', n);
}

function clampContextWindow(n) {
  return clampSetting('contextWindow', n);
}

function clampContextReserve(n) {
  return clampSetting('contextReserveTokens', n);
}

function clampTriggerRatio(n) {
  return clampSetting('compactionTriggerRatio', n);
}

function clampAgentToolCallLimit(n) {
  return clampSetting('agentToolCallLimit', n);
}

function clampAgentMaxRounds(n) {
  return clampSetting('agentMaxRounds', n);
}

function modelSettingsPath(userData) {
  return path.join(userData, 'model-settings.json');
}

/**
 * 历史配置里的「内置 BGE」条目：模型已删除，条目本身也没有可用的 /embeddings 端点
 * （baseUrl 存的是占位词「内置」）。归一化阶段丢弃，避免检索时往空地址发请求。
 * @param {any} m
 */
function isLegacyBuiltinEmbeddingEntry(m) {
  if (!m) return false;
  if (m.builtin === true) return true;
  if (String(m.id || '').startsWith('embedding-builtin-')) return true;
  return String(m.baseUrl || '').trim() === '内置';
}

function normalizeEmbeddingEntry(m, index) {
  /** @type {{ id: string, name: string, baseUrl: string, apiKey: string, dimensions: number, active: boolean, headers?: object, authMode?: string, userAgent?: string }} */
  const entry = {
    id: String(m?.id || `embedding-${index + 1}`),
    name: String(m?.name || '').trim(),
    baseUrl: String(m?.baseUrl || '').trim(),
    apiKey: String(m?.apiKey || '').trim(),
    dimensions: Math.min(
      EMBEDDING_DIMENSIONS_MAX,
      Math.max(EMBEDDING_DIMENSIONS_MIN, Number(m?.dimensions) || DEFAULTS.embeddingDimensions)
    ),
    active: m?.active === true
  };
  // 请求修饰字段：与供应商 / 自定义模型同源，由 llm-request.js 统一装配。
  // 无值时不挂键，保持既有结构契约。
  if (m && m.headers) entry.headers = m.headers;
  if (m && m.authMode) entry.authMode = String(m.authMode).trim();
  if (m && m.userAgent) entry.userAgent = String(m.userAgent).trim();
  return entry;
}

function normalize(raw) {
  const s = { ...DEFAULTS, ...(raw && typeof raw === 'object' ? raw : {}) };
  // 不再强制清空 system：清空会让保存进 model-settings.json 的自定义 system「落盘即丢」，
  // 且与 Renderer 的默认值形成同名字段两份定义。身份/人设的唯一来源是
  // ~/.dieyun/dieyun.md（模板 assets/dieyun.md）与 dieyun-instructions.js 的 ASSISTANT_IDENTITY。
  if (raw && raw.model && !raw.textModel) s.textModel = raw.model;
  if (raw && raw.maxTokens && !raw.maxOutputTokens) s.maxOutputTokens = raw.maxTokens;
  if (!s.builtinBaseUrl) s.builtinBaseUrl = DEFAULT_BUILTIN_BASE_URL;
  if (!s.builtinApiKey) s.builtinApiKey = DEFAULT_BUILTIN_API_KEY;
  s.maxOutputTokens = clampMaxTokens(s.maxOutputTokens);
  s.maxTokens = s.maxOutputTokens;
  s.contextWindow = clampContextWindow(s.contextWindow);
  s.contextReserveTokens = Math.min(
    clampContextReserve(s.contextReserveTokens),
    Math.max(0, s.contextWindow - s.maxOutputTokens)
  );
  // 温度 / 压缩比只 clamp，不做「命中旧默认值就重置」：0.7、0.75、0.68 如今都是用户可合法选择的值，
  // 命中即改会让人「设了存不住」（旧默认值是 0.7 / 0.75，早年的迁移逻辑该退场了）。
  s.temperature = clampModelRuntimeValue('temperature', s.temperature);
  s.compactionTriggerRatio = clampTriggerRatio(s.compactionTriggerRatio);
  s.agentToolCallLimit = clampAgentToolCallLimit(s.agentToolCallLimit);
  s.agentMaxRounds = clampAgentMaxRounds(s.agentMaxRounds);
  // 结构索引增量很便宜（只重解析改动文件），且 repo_map 依赖它的新鲜度 → 默认开。
  s.graphAutoIncremental = s.graphAutoIncremental !== false;
  // 代码索引增量相反：只有显式开启才跑（旧的 `!== false` 会把「未设置」也变成 true）。
  s.codebaseAutoIncremental = s.codebaseAutoIncremental === true;
  // 语义检索意图同理：只有显式开启才算（缺省/脏值一律 false，别把「未设置」变成「建向量」）。
  s.indexSemanticSearch = s.indexSemanticSearch === true;

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
  // 内置 BGE 已删除：只保留「有名字 + 有端点」的外部模型条目。
  // 历史配置里的内置条目（baseUrl 是「内置」占位、没有可用的 /embeddings 端点）在这里被丢弃，
  // 用户重新选一个外部模型即恢复语义检索；不选就退化为纯关键词召回。
  s.embeddingModels = sourceEmbeddingModels
    .filter((m) => !isLegacyBuiltinEmbeddingEntry(m))
    .map(normalizeEmbeddingEntry)
    .filter((m) => m.name && m.baseUrl);

  let activeSeen = false;
  s.embeddingModels = s.embeddingModels.map((m) => {
    const active = m.active && !activeSeen;
    if (active) activeSeen = true;
    return { ...m, active };
  });
  if (!activeSeen && s.embeddingModels.length) {
    s.embeddingModels = s.embeddingModels.map((m, index) => ({ ...m, active: index === 0 }));
  }

  const activeEmbedding = s.embeddingModels.find((m) => m.active) || null;
  s.embeddingEnabled = !!activeEmbedding;
  if (!activeEmbedding) {
    s.embeddingModel = '';
    s.embeddingBaseUrl = '';
    s.embeddingApiKey = '';
    s.embeddingDimensions = DEFAULTS.embeddingDimensions;
    return s;
  }
  s.embeddingModel = activeEmbedding.name;
  s.embeddingBaseUrl = activeEmbedding.baseUrl;
  s.embeddingApiKey = activeEmbedding.apiKey;
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
  const active = s.embeddingModels.find((m) => m.active) || null;
  if (!active) {
    return {
      baseUrl: '',
      apiKey: '',
      model: '',
      dimensions: 0,
      disabled: true
    };
  }
  const out = {
    baseUrl: active.baseUrl,
    apiKey: active.apiKey,
    model: active.name,
    dimensions: active.dimensions || DEFAULTS.embeddingDimensions
  };
  // 请求修饰字段透传给 Rust（EmbeddingConfig.headers）与 llm-request 装配
  if (active.headers) out.headers = active.headers;
  if (active.authMode) out.authMode = active.authMode;
  if (active.userAgent) out.userAgent = active.userAgent;
  return out;
}

function embeddingSignature(settings) {
  const cfg = getEmbeddingConfig(settings);
  if (!cfg || cfg.disabled || !cfg.model) return '';
  return `${cfg.model}@${cfg.dimensions}`;
}

/**
 * 「这次建库要不要带向量」的**唯一判定处**。
 *
 * `explicit` 给了布尔就听调用方的（面板「建向量」是一次性动作、增量调度器是「沿用库里已有向量」），
 * 没给才看持久意图 `indexSemanticSearch`。用户只要打开一次，之后每一轮 prep / agent 触发的
 * 建库都会带上向量——这正是 SSH 每会话冷库场景下唯一可行的触发方式。
 *
 * @param {string} userData userData 目录（`loadModelSettings` 的入参）
 * @param {boolean|undefined} explicit
 * @returns {boolean}
 */
function resolveIndexVectorsIntent(userData, explicit) {
  if (explicit === true || explicit === false) return explicit;
  try {
    return loadModelSettings(userData).indexSemanticSearch === true;
  } catch {
    return false;
  }
}

module.exports = {
  loadModelSettings,
  saveModelSettings,
  getEmbeddingConfig,
  embeddingSignature,
  resolveIndexVectorsIntent,
  resolveSpeechApiConfig,
  resolveTtsApiConfig,
  resolveTextApiConfig,
  DEFAULTS,
  MAX_TOKENS_DEFAULT,
  clampMaxTokens,
  clampContextWindow,
  clampContextReserve,
  clampTriggerRatio,
  clampAgentToolCallLimit,
  clampAgentMaxRounds
};

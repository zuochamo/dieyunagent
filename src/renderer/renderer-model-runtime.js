/* global window, document, $, fetch, escapeHtml, openModelSettingsModal, renderComposerModelLists, renderSuppliersList, updateComposerModelTriggerLabel, refreshContextProgress, resetCompactionInstances, refreshComposerBuiltinModels, clearBuiltinModelsCache, migrateLegacyBuiltinEnabledToSuppliers, showAgentToast, resolveModelContextWindowFromSettings */
'use strict';

var modelSettingsApi = window.diecloud || {};

/**
 * 档位默认值的唯一来源：agent-bundle.js 暴露的 window.DieyunModelRuntimePresets
 * （index.html 里 agent-bundle 先于本文件加载）。与 Main 侧 src/model-settings.js 的
 * PRESET_DEFAULTS 同源，本文件不再各写一份数字 —— 否则「默认档位」改一次要改两处，
 * UI 侧预算与触发比会重新和主进程分叉。
 */
var PRESET_DEFAULTS = window.DieyunModelRuntimePresets.MODEL_RUNTIME_DEFAULTS;

var DEFAULT_BUILTIN_BASE_URL = '';
var DEFAULT_BUILTIN_API_KEY = '';

var EMBEDDING_DIMENSIONS_MIN = 64;
var EMBEDDING_DIMENSIONS_MAX = 8192;

var DEFAULTS = {
  baseUrl: DEFAULT_BUILTIN_BASE_URL,
  apiKey: DEFAULT_BUILTIN_API_KEY,
  textModel: 'mimo-v2.5-pro',
  builtinBaseUrl: DEFAULT_BUILTIN_BASE_URL,
  builtinApiKey: DEFAULT_BUILTIN_API_KEY,
  // 身份/人设的唯一来源是 ~/.dieyun/dieyun.md（模板 assets/dieyun.md）与
  // dieyun-instructions.js 的 ASSISTANT_IDENTITY；这里不再放一份内置人设。
  system: '',
  temperature: PRESET_DEFAULTS.temperature,
  maxTokens: PRESET_DEFAULTS.maxOutputTokens,
  maxOutputTokens: PRESET_DEFAULTS.maxOutputTokens,
  contextWindow: PRESET_DEFAULTS.contextWindow,
  contextReserveTokens: PRESET_DEFAULTS.contextReserveTokens,
  compactionTriggerRatio: PRESET_DEFAULTS.compactionTriggerRatio,
  agentToolCallLimit: PRESET_DEFAULTS.agentToolCallLimit,
  agentMaxRounds: PRESET_DEFAULTS.agentMaxRounds,
  embeddingEnabled: true,
  embeddingBaseUrl: '',
  embeddingApiKey: '',
  embeddingModel: '',
  embeddingDimensions: 1024,
  speechWhisperModel: 'whisper-1',
  speechBaseUrl: '',
  speechApiKey: '',
  speechLanguage: 'zh',
  customModels: [],
  modelSuppliers: [],
  embeddingModels: [],
  graphAutoIncremental: true,
  codebaseAutoIncremental: false,
  // 代码索引要不要带向量（语义检索）：默认关，打开后每次建库都带 vectors:true
  indexSemanticSearch: false,
  // 自动朗读每条新回复（手动点气泡下的「朗读」不受此开关影响）
  ttsAutoRead: false,
  // 自定义快捷键（id → 组合键）：只存与默认不同的项，缺省回落 SHORTCUT_DEFS 的默认键位。
  // 键位定义与匹配的唯一来源是 src/renderer/renderer-shortcuts.js。
  shortcuts: {}
};

/**
 * 区间数字的单一来源是 model-runtime-schema（经 agent-bundle 暴露为
 * `window.clampModelRuntimeValue`）：本文件此前自己写了一份 240000 / 8192 / 500000 /
 * 0.3–0.95 / min 5，和 schema 的 min 15 已经漂移，滑杆与实际 clamp 能不一致。
 */
function clampRuntimeValue(key, n) {
  const fn = typeof window !== 'undefined' ? window.clampModelRuntimeValue : null;
  if (typeof fn === 'function') return fn(key, n);
  const v = Number(n);
  return Number.isFinite(v) ? v : DEFAULTS[key];
}

function clampMaxTokensInput(n) {
  return clampRuntimeValue('maxOutputTokens', n);
}

function clampContextWindowInput(n) {
  return clampRuntimeValue('contextWindow', n);
}

function clampContextReserveInput(n) {
  return clampRuntimeValue('contextReserveTokens', n);
}

function clampCompactionTriggerRatioInput(n) {
  return clampRuntimeValue('compactionTriggerRatio', n);
}

function clampAgentToolCallLimitInput(n) {
  return clampRuntimeValue('agentToolCallLimit', n);
}

function getAgentToolCallLimitSetting(s) {
  const src = s != null ? s : getActiveRuntimeSettings();
  return clampAgentToolCallLimitInput(src.agentToolCallLimit ?? DEFAULTS.agentToolCallLimit);
}

function clampAgentMaxRoundsInput(n) {
  return clampRuntimeValue('agentMaxRounds', n);
}

function getAgentMaxRoundsSetting(s) {
  const src = s != null ? s : getActiveRuntimeSettings();
  return clampAgentMaxRoundsInput(src.agentMaxRounds ?? DEFAULTS.agentMaxRounds);
}

function getMaxOutputTokens(s) {
  const src = s != null ? s : getActiveRuntimeSettings();
  return clampMaxTokensInput(src.maxOutputTokens ?? src.maxTokens ?? DEFAULTS.maxOutputTokens);
}

function resolveActiveSessionId(explicitSessionId) {
  if (explicitSessionId != null && String(explicitSessionId).trim()) {
    return String(explicitSessionId).trim();
  }
  if (typeof currentSessionId !== 'undefined' && currentSessionId) {
    return String(currentSessionId);
  }
  return '';
}

/** 共享解析入口（agent-bundle 暴露；route / 档位 / 模型事实的唯一口径）。 */
function modelFactsApi() {
  return (typeof window !== 'undefined' && window.DieyunModelRuntimeByTier) || null;
}

/** 当前设置 + route → 模型事实（kind / 供应商 / 模态 / 自带窗口 / 档位）。 */
function resolveModelFactsForRoute(route) {
  const api = modelFactsApi();
  if (api && typeof api.resolveModelFacts === 'function') {
    return api.resolveModelFacts(settings, route);
  }
  return { route: String(route || ''), kind: 'default', contextTierId: 'default', contextWindow: null };
}

function resolveContextTierIdForRoute(route) {
  return normalizeContextTierId(resolveModelFactsForRoute(route).contextTierId);
}

/**
 * 会话 → Auto 实际选中的 route（由 `resolveComposerModelForSend` 回填）。
 *
 * 为什么需要它：Auto 的选型依赖本条消息的内容与附件，静态解析不出来；而「档位 / 预算」
 * 必须先知道 route 才能算。用「上一次发送真正选中的那条 route」作为当前口径，
 * Renderer 的预算与 Main 压缩（收到同一个 `payload.modelRoute`）才是同一把尺子。
 */
var resolvedModelRouteBySession = new Map();

function noteResolvedModelRoute(sessionId, route) {
  const sid = resolveActiveSessionId(sessionId);
  const text = String(route || '').trim();
  if (!text || text === 'default') {
    resolvedModelRouteBySession.delete(sid);
    return;
  }
  resolvedModelRouteBySession.set(sid, text);
}

function forgetResolvedModelRoute(sessionId) {
  resolvedModelRouteBySession.delete(resolveActiveSessionId(sessionId));
}

function getResolvedModelRoute(sessionId) {
  return resolvedModelRouteBySession.get(resolveActiveSessionId(sessionId)) || '';
}

function activeComposerModelPick(opts = {}) {
  const sessionId = resolveActiveSessionId(opts.sessionId);
  try {
    if (typeof resolveComposerModelPickForSend === 'function') {
      return resolveComposerModelPickForSend(sessionId || undefined) || null;
    }
    return typeof getComposerModelPick === 'function' ? getComposerModelPick() : null;
  } catch {
    // 打包 TDZ / 初始化竞态时回退 default，避免启动崩
    return null;
  }
}

/**
 * 当前会话实际生效的模型路由；解析不出来时返回 ''（= default 档 / 无模型自带窗口覆盖）。
 * - 手动选择：用户选的那条 route；
 * - Auto：上一次发送真正选中的 route（见 `noteResolvedModelRoute`）。
 */
function resolveActiveModelRoute(opts = {}) {
  const pick = activeComposerModelPick(opts);
  if (!pick) return '';
  if (!pick.autoMode && pick.selection && pick.selection !== 'auto') return String(pick.selection);
  return getResolvedModelRoute(opts.sessionId);
}

function resolveContextTierId(opts = {}, knownRoute) {
  if (opts.tierId && typeof isValidContextTierId === 'function' && isValidContextTierId(opts.tierId)) {
    return normalizeContextTierId(opts.tierId);
  }
  if (opts.editing === true && typeof getEditingContextTierId === 'function') {
    return normalizeContextTierId(getEditingContextTierId());
  }
  const route = knownRoute != null ? knownRoute : resolveActiveModelRoute(opts);
  return route ? resolveContextTierIdForRoute(route) : 'default';
}

function getRuntimeValuesForTierId(tierId) {
  return getRuntimeValuesForTier(normalizeContextTierId(tierId));
}

function buildSettingsWithRuntimeTier(s, tierId) {
  const runtime = getRuntimeValuesForTierId(tierId);
  return normalizeSettings({
    ...s,
    temperature: runtime.temperature,
    contextWindow: runtime.contextWindow,
    maxOutputTokens: runtime.maxOutputTokens,
    maxTokens: runtime.maxOutputTokens,
    contextReserveTokens: runtime.contextReserveTokens,
    compactionTriggerRatio: runtime.compactionTriggerRatio,
    agentToolCallLimit: runtime.agentToolCallLimit,
    agentMaxRounds: runtime.agentMaxRounds
  });
}

/** 模型自带上下文窗口（可选）：覆盖所属档位窗口；未填写则返回 null。 */
function resolveModelContextWindowOverride(opts = {}, knownRoute) {
  if (opts.tierId) return null;
  if (typeof resolveModelContextWindowFromSettings !== 'function') return null;
  const route = knownRoute != null ? knownRoute : resolveActiveModelRoute(opts);
  if (!route) return null;
  const n = Number(resolveModelContextWindowFromSettings(settings, route));
  return Number.isFinite(n) && n > 0 ? clampContextWindowInput(n) : null;
}

function getActiveRuntimeSettings(opts = {}) {
  const route = resolveActiveModelRoute(opts);
  const tierId = resolveContextTierId(opts, route);
  const base = buildSettingsWithRuntimeTier(settings, tierId);
  const ownWindow = resolveModelContextWindowOverride(opts, route);
  if (ownWindow == null || ownWindow === base.contextWindow) return base;
  return normalizeSettings({
    ...base,
    contextWindow: ownWindow,
    contextReserveTokens: Math.min(
      clampContextReserveInput(base.contextReserveTokens),
      Math.max(0, ownWindow - clampMaxTokensInput(base.maxOutputTokens))
    )
  });
}

function getContextWindowTokens(s) {
  const src = s != null ? s : getActiveRuntimeSettings();
  return clampContextWindowInput(src.contextWindow ?? DEFAULTS.contextWindow);
}

function getContextReserveTokens(s) {
  const src = s != null ? s : getActiveRuntimeSettings();
  const windowTokens = getContextWindowTokens(src);
  const outputTokens = getMaxOutputTokens(src);
  return Math.min(
    clampContextReserveInput(src.contextReserveTokens ?? DEFAULTS.contextReserveTokens),
    Math.max(0, windowTokens - outputTokens)
  );
}

/**
 * 有效输入预算：公式的唯一来源是 src/agent/model-runtime-by-tier.js 的
 * computeEffectiveInputBudget（Main 的 compaction-main.getEffectiveInputBudget 同调同一函数，
 * 由 agent-bundle.js 暴露为 window.DieyunModelRuntimeByTier，先于本文件加载）。
 * 本文件只负责把当前档位设置解析成三个 token 数，勿在这里再写一份减法 ——
 * 此前本地地板 1024 与主进程 8192 不一致，模型自带 8k 窗口时两侧预算会分叉。
 */
function getEffectiveInputBudget(s) {
  const src = s != null ? s : getActiveRuntimeSettings();
  return window.DieyunModelRuntimeByTier.computeEffectiveInputBudget({
    contextWindow: getContextWindowTokens(src),
    maxOutputTokens: getMaxOutputTokens(src),
    contextReserveTokens: getContextReserveTokens(src)
  });
}

function getCompactionTriggerRatio(s) {
  const src = s != null ? s : getActiveRuntimeSettings();
  return clampCompactionTriggerRatioInput(
    src.compactionTriggerRatio ?? DEFAULTS.compactionTriggerRatio
  );
}
var STORAGE_KEY = 'diecloud.model.settings.v1';

function normalizeSupplierEntry(m, index) {
  const enabledModels =
    m?.enabledModels && typeof m.enabledModels === 'object' ? { ...m.enabledModels } : {};
  const modelModalitiesRaw =
    m?.modelModalities && typeof m.modelModalities === 'object' ? { ...m.modelModalities } : {};
  const modelModalities = {};
  for (const [modelId, value] of Object.entries(modelModalitiesRaw)) {
    modelModalities[modelId] =
      window.ModelCapabilities?.normalizeModalitySetting(value) || 'text';
  }
  const contextTierByModelRaw =
    m?.contextTierByModel && typeof m.contextTierByModel === 'object' ? { ...m.contextTierByModel } : {};
  const contextTierByModel = {};
  for (const [modelId, tierId] of Object.entries(contextTierByModelRaw)) {
    const normalized = normalizeContextTierId(tierId, '');
    if (normalized) contextTierByModel[modelId] = normalized;
  }
  const entry = {
    id: String(m?.id || `supplier-${Date.now()}-${index}`),
    name: String(m?.name || '').trim(),
    baseUrl: String(m?.baseUrl || '').trim(),
    apiKey: String(m?.apiKey || '').trim(),
    contextTier: normalizeContextTierId(m?.contextTier, 'default'),
    enabledModels,
    modelModalities,
    contextTierByModel
  };
  // 请求修饰字段（交给 llm-request 装配进出站请求）必须原样保留。
  // 本函数是「重建对象、只列已知字段」，漏写一个键就会表现为
  // 「设置页填得好好的，一保存就没了」——排查成本极高。
  if (m && m.headers) entry.headers = m.headers;
  if (m && m.authMode) entry.authMode = String(m.authMode).trim();
  if (m && m.userAgent) entry.userAgent = String(m.userAgent).trim();
  return entry;
}

function supplierDisplayName(s) {
  if (!s) return '供应商';
  if (s.name) return s.name;
  const raw = String(s.baseUrl || '').trim();
  if (!raw) return '供应商';
  try {
    const u = new URL(raw);
    return u.hostname || raw;
  } catch {
    return raw.replace(/^https?:\/\//i, '').split('/')[0] || raw;
  }
}

function countSupplierEnabledModels(s) {
  const map = s?.enabledModels || {};
  const keys = Object.keys(map);
  if (!keys.length) return -1;
  return keys.filter((k) => map[k] === true).length;
}

/**
 * 供应商模型是否已启用。判据的单一来源是 src/agent/model-api-config.js
 * （经 dist/agent-bundle.js 提前加载）；此处只做委托，勿再复写规则——
 * 之前三处各写一份，其中两份写成 `=== true`，与「enabledModels 为空即全可用」
 * 冲突，导致同一份设置在主进程和界面里得出相反的模型名。
 */
function isSupplierModelEnabled(supplier, modelId) {
  const shared = typeof window !== 'undefined' && window.DieyunModelApiConfig;
  if (shared && typeof shared.isSupplierModelEnabled === 'function') {
    return shared.isSupplierModelEnabled(supplier, modelId);
  }
  if (!supplier || !modelId) return false;
  const map = supplier.enabledModels || {};
  if (!Object.keys(map).length) return true;
  return map[modelId] !== false;
}

function getSupplierById(supplierId) {
  return (settings.modelSuppliers || []).find((s) => s.id === supplierId) || null;
}

function normalizeSettings(raw) {
  const s = { ...DEFAULTS, ...raw };
  if (raw && raw.model && !raw.textModel) s.textModel = raw.model;
  s.builtinBaseUrl = String(s.builtinBaseUrl || '').trim();
  s.builtinApiKey = String(s.builtinApiKey || '').trim();
  if (!s.builtinBaseUrl) s.builtinBaseUrl = DEFAULT_BUILTIN_BASE_URL;
  if (!s.builtinApiKey) s.builtinApiKey = DEFAULT_BUILTIN_API_KEY;
  const hasSuppliersField = raw && Object.prototype.hasOwnProperty.call(raw, 'modelSuppliers');
  if (hasSuppliersField && Array.isArray(raw.modelSuppliers)) {
    s.modelSuppliers = raw.modelSuppliers.map(normalizeSupplierEntry).filter((m) => m.baseUrl);
  } else if (s.builtinBaseUrl) {
    s.modelSuppliers = [
      normalizeSupplierEntry(
        {
          id: 'supplier-default',
          name: '',
          baseUrl: s.builtinBaseUrl,
          apiKey: s.builtinApiKey,
          enabledModels: {}
        },
        0
      )
    ];
  } else {
    s.modelSuppliers = [];
  }
  const firstSupplier = s.modelSuppliers[0];
  s.builtinBaseUrl = firstSupplier?.baseUrl || '';
  s.builtinApiKey = firstSupplier?.apiKey || '';
  s.temperature = Number.isFinite(Number(s.temperature)) ? Number(s.temperature) : DEFAULTS.temperature;
  if (raw && raw.maxTokens && !raw.maxOutputTokens) s.maxOutputTokens = raw.maxTokens;
  s.maxOutputTokens = clampMaxTokensInput(s.maxOutputTokens);
  s.maxTokens = s.maxOutputTokens;
  s.contextWindow = clampContextWindowInput(s.contextWindow);
  s.contextReserveTokens = getContextReserveTokens(s);
  s.compactionTriggerRatio = getCompactionTriggerRatio(s);
  s.agentToolCallLimit = getAgentToolCallLimitSetting(s);
  s.agentMaxRounds = getAgentMaxRoundsSetting(s);
  s.graphAutoIncremental = s.graphAutoIncremental !== false;
  s.ttsAutoRead = s.ttsAutoRead === true;
  // 快捷键覆盖表只收「id → 非空字符串」，脏值直接丢；键位定义与匹配见 renderer-shortcuts.js
  const rawShortcuts = raw && raw.shortcuts && typeof raw.shortcuts === 'object' ? raw.shortcuts : {};
  s.shortcuts = {};
  for (const [shortcutId, combo] of Object.entries(rawShortcuts)) {
    const text = typeof combo === 'string' ? combo.trim() : '';
    if (shortcutId && text) s.shortcuts[shortcutId] = text;
  }
  s.codebaseAutoIncremental = s.codebaseAutoIncremental === true;
  // 语义检索意图：缺省/脏值一律 false（别把「未设置」变成「每次建库都调 embedding」）
  s.indexSemanticSearch = s.indexSemanticSearch === true;
  const normalizeDefined = (m, index) => {
    const modalitySetting =
      window.ModelCapabilities?.normalizeModalitySetting(m?.modalitySetting, m?.kind) || 'text';
    const entry = {
      id: String(m?.id || `model-${Date.now()}-${index}`),
      name: String(m?.name || '').trim(),
      baseUrl: String(m?.baseUrl || '').trim(),
      apiKey: String(m?.apiKey || '').trim(),
      modalitySetting,
      contextTier: normalizeContextTierId(m?.contextTier, '')
    };
    if (!entry.contextTier) delete entry.contextTier;
    // 低于窗口下限的值直接丢弃，避免被 clamp 成默认 128K
    const ownWindow = Number(m?.contextWindow);
    if (Number.isFinite(ownWindow) && ownWindow >= 8192) {
      entry.contextWindow = clampContextWindowInput(ownWindow);
    }
    entry.kind = window.ModelCapabilities?.effectiveCustomModelKind(entry) || (m?.kind === 'vision' ? 'vision' : 'text');
    // 请求修饰字段必须原样保留（同 normalizeSupplierEntry，勿漏）
    if (m && m.headers) entry.headers = m.headers;
    if (m && m.authMode) entry.authMode = String(m.authMode).trim();
    if (m && m.userAgent) entry.userAgent = String(m.userAgent).trim();
    // 语音合成模型的音色（只有 tts 有意义；留空表示用服务端默认）
    if (m && entry.kind === 'tts' && String(m.voice || '').trim()) entry.voice = String(m.voice).trim();
    return entry;
  };
  s.customModels = Array.isArray(s.customModels)
    ? s.customModels.map(normalizeDefined).filter((m) => m.name)
    : [];
  if (!s.customModels.length && raw && raw.customModels == null && s.textModel && s.baseUrl) {
    s.customModels = [
      {
        id: 'legacy-text',
        name: s.textModel,
        baseUrl: s.baseUrl,
        apiKey: s.apiKey || '',
        kind: 'text'
      }
    ];
  }
  const firstText = s.customModels.find((m) => m.kind === 'text');
  const firstSpeech = s.customModels.find((m) => m.kind === 'speech');
  if (firstText) {
    s.textModel = firstText.name;
    s.baseUrl = firstText.baseUrl || '';
    s.apiKey = firstText.apiKey || '';
  } else {
    // 没有自定义文本模型时不再抹掉「默认文本模型」：textModel 是用户在 model-settings.json
    // 里显式写下的兜底模型（无 route 的调用按它解析，见 agent/model-api-config.js#
    // resolveDefaultApiConfig），Renderer 只是同步缓存 —— 在这里清空等于每次同步都把它冲掉。
    s.textModel = String(s.textModel == null ? '' : s.textModel).trim();
    s.baseUrl = '';
    s.apiKey = '';
  }
  if (firstSpeech) {
    s.speechWhisperModel = firstSpeech.name;
    s.speechBaseUrl = firstSpeech.baseUrl || s.baseUrl || '';
    s.speechApiKey = firstSpeech.apiKey || s.apiKey || '';
  } else if (!String(s.speechWhisperModel || '').trim()) {
    s.speechWhisperModel = DEFAULTS.speechWhisperModel;
  }
  // 历史配置里的「内置 BGE」条目：模型已删除，baseUrl 存的是占位词「内置」，直接丢弃。
  const isLegacyBuiltinEmbedding = (m) => {
    if (!m) return false;
    if (m.builtin === true) return true;
    if (String(m.id || '').startsWith('embedding-builtin-')) return true;
    return String(m.baseUrl || '').trim() === '内置';
  };
  const normalizeEmbedding = (m, index) => ({
    id: String(m?.id || `embedding-${Date.now()}-${index}`),
    name: String(m?.name || '').trim(),
    baseUrl: String(m?.baseUrl || '').trim(),
    apiKey: String(m?.apiKey || '').trim(),
    dimensions: Math.min(
      EMBEDDING_DIMENSIONS_MAX,
      Math.max(EMBEDDING_DIMENSIONS_MIN, Number(m?.dimensions) || DEFAULTS.embeddingDimensions)
    ),
    active: m?.active === true
  });
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
  // 内置 BGE 已删除：只保留「有名字 + 有端点」的外部模型条目（历史内置条目在此被丢弃）。
  s.embeddingModels = sourceEmbeddingModels
    .filter((m) => !isLegacyBuiltinEmbedding(m))
    .map(normalizeEmbedding)
    .filter((m) => m.name && m.baseUrl);
  s.embeddingModels = s.embeddingModels.filter(
    (m) => !(m.id === 'embedding-default' && m.name === 'text-embedding-v4')
  );
  // active 单选，但「全都不启用」合法（只留配置、暂不跑语义检索）：不再自动点亮第一个。
  let activeSeen = false;
  s.embeddingModels = s.embeddingModels.map((m) => {
    const active = m.active && !activeSeen;
    if (active) activeSeen = true;
    return { ...m, active };
  });
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
  s.embeddingBaseUrl = activeEmbedding.baseUrl || DEFAULTS.embeddingBaseUrl;
  s.embeddingApiKey = activeEmbedding.apiKey || '';
  s.embeddingDimensions = activeEmbedding.dimensions || DEFAULTS.embeddingDimensions;
  return s;
}

function loadSettings() {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return normalizeSettings({});
    return normalizeSettings(JSON.parse(raw));
  } catch {
    return normalizeSettings({});
  }
}

function getTextModelId(s) {
  const x = s || settings;
  return String(x.textModel || x.model || '').trim();
}

var COMPOSER_MODEL_PICK_KEY = 'diecloud.composer.model.v1';

function getComposerModelPick() {
  if (typeof loadComposerModelPickForSession === 'function') {
    const sid =
      typeof currentSessionId !== 'undefined' && currentSessionId ? String(currentSessionId) : '';
    return sid ? loadComposerModelPickForSession(sid) : loadComposerModelPickForSession('');
  }
  try {
    const raw = window.localStorage.getItem(COMPOSER_MODEL_PICK_KEY);
    if (!raw) return { autoMode: true, selection: 'auto' };
    const p = JSON.parse(raw);
    return {
      autoMode: p.autoMode !== false,
      selection: String(p.selection || (p.autoMode !== false ? 'auto' : 'builtin:default'))
    };
  } catch {
    return { autoMode: true, selection: 'auto' };
  }
}

function getComposerSelectedModelId() {
  const pick = getComposerModelPick();
  if (pick.autoMode || pick.selection === 'auto') return '';
  const sel = pick.selection;
  if (sel.startsWith('builtin:')) {
    const rest = sel.slice('builtin:'.length);
    const idx = rest.indexOf(':');
    return idx >= 0 ? rest.slice(idx + 1) : rest;
  }
  if (sel.startsWith('custom:')) {
    const id = sel.slice('custom:'.length);
    const model = (settings.customModels || []).find((m) => m.id === id);
    return model?.name || '';
  }
  return '';
}

function getComposerSelectedApiConfig() {
  const pick = getComposerModelPick();
  if (pick.autoMode || pick.selection === 'auto') return null;
  const sel = pick.selection;
  if (sel.startsWith('custom:')) return getCustomModelApiConfig(sel);
  if (sel.startsWith('builtin:')) {
    const rest = sel.slice('builtin:'.length);
    const idx = rest.indexOf(':');
    const supplierId = idx >= 0 ? rest.slice(0, idx) : null;
    return getBuiltinApiConfig(supplierId || undefined);
  }
  return null;
}

function getSpeechApiConfig(s) {
  if (window.ModelCapabilities?.getSpeechApiConfigFromSettings) {
    return window.ModelCapabilities.getSpeechApiConfigFromSettings(s || settings);
  }
  const x = s || settings;
  const customSpeech = (x.customModels || []).find((m) => m && m.kind === 'speech');
  if (customSpeech) {
    return {
      baseUrl: String(customSpeech.baseUrl || '').trim(),
      apiKey: String(customSpeech.apiKey || '').trim(),
      model: String(customSpeech.name || '').trim()
    };
  }
  return {
    baseUrl: String(x.speechBaseUrl || x.baseUrl || '').trim(),
    apiKey: String(x.speechApiKey || x.apiKey || '').trim(),
    model: String(x.speechWhisperModel || 'whisper-1').trim() || 'whisper-1'
  };
}

/** 共享的「路由 → API 配置」单一来源（src/agent/model-api-config.js，经 dist/agent-bundle.js 提供）。 */
function sharedModelApiConfig() {
  return (typeof window !== 'undefined' && window.DieyunModelApiConfig) || null;
}

/**
 * 「baseUrl / apiKey → API 配置」的规范化只此一处，勿再内联。
 *
 * `source` 是配置的来源行（供应商 / 自定义模型 / settings）：带上它会一并透传
 * 请求修饰字段（headers / authMode / userAgent）。
 * **只取 baseUrl + apiKey 两个标量会把用户配的自定义头与 User-Agent 静默丢掉**，
 * 表现为「设置页明明配了 x-opencode-session，请求却依然 400」。
 */
function apiConfigOf(baseUrl, apiKey, source) {
  const shared = sharedModelApiConfig();
  if (shared && typeof shared.asConfig === 'function') {
    const extra = typeof shared.requestOptionsFrom === 'function'
      ? shared.requestOptionsFrom(source)
      : undefined;
    return shared.asConfig(baseUrl, apiKey, undefined, extra);
  }
  return { baseUrl: String(baseUrl || '').trim(), apiKey: String(apiKey || '').trim() };
}

function getBuiltinApiConfig(supplierId) {
  const shared = sharedModelApiConfig();
  if (shared && typeof shared.resolveSupplierApiConfig === 'function') {
    // 完整透传解析结果（含请求修饰字段），不要再手工裁剪字段
    return shared.resolveSupplierApiConfig(settings, supplierId);
  }
  const supplier = supplierId ? getSupplierById(supplierId) : (settings.modelSuppliers || [])[0];
  if (supplier) return apiConfigOf(supplier.baseUrl, supplier.apiKey, supplier);
  return apiConfigOf(settings.builtinBaseUrl, settings.builtinApiKey, settings);
}

function getSelectedCustomModel() {
  const sel = composerModelState?.pick?.selection || '';
  if (!sel.startsWith('custom:')) return null;
  const id = sel.slice('custom:'.length);
  return (settings.customModels || []).find((m) => m.id === id) || null;
}

function getCustomModelApiConfig(route) {
  const routeText = String(route || '');
  const customRoute = routeText.match(/^(?:auto-)?custom:(.+)$/);
  if (customRoute) {
    const model = (settings.customModels || []).find((m) => m.id === customRoute[1]);
    if (model) return apiConfigOf(model.baseUrl, model.apiKey, model);
  }
  if (/^(?:auto-)?builtin(?::|$)/.test(routeText)) {
    return getBuiltinApiConfig();
  }
  const selected = getSelectedCustomModel();
  if (selected) {
    return apiConfigOf(
      selected.baseUrl || settings.baseUrl,
      selected.apiKey || settings.apiKey,
      selected
    );
  }
  return apiConfigOf(settings.baseUrl, settings.apiKey, settings);
}

function refreshBuiltinModelsAfterSettingsChange() {
  if (typeof refreshComposerBuiltinModels === 'function') {
    refreshComposerBuiltinModels();
    return;
  }
  // 启动早期（磁盘配置回填时）renderer-composer.js 可能还没求值到，`composerModelState` 是
  // 那个脚本里的 const —— 这时读它就是 ReferenceError（新装/新浏览器首次打开必踩）。
  // 模型列表本来就由 composer 自己渲染，等它加载完再来一遍即可，这里直接跳过。
  if (typeof composerModelState === 'undefined') return;
  composerModelState.builtinModels = [];
  composerModelState.builtinError = '';
  composerModelState.builtinMeta = null;
  composerModelState.builtinLastDetectAt = 0;
  renderComposerModelLists();
  renderSuppliersList();
}

function countConfiguredSuppliers(s) {
  return (s && Array.isArray(s.modelSuppliers) ? s.modelSuppliers : []).filter((row) =>
    String(row && row.baseUrl ? row.baseUrl : '').trim()
  ).length;
}

function countConfiguredCustomModels(s) {
  return (s && Array.isArray(s.customModels) ? s.customModels : []).filter((row) =>
    String(row && (row.name || row.baseUrl) ? row.name || row.baseUrl : '').trim()
  ).length;
}

/**
 * localStorage 丢失/被清时，从 Main 磁盘回填，避免启动 sync 用空配置覆盖 model-settings.json。
 * @returns {Promise<boolean>} 是否已回填并写回 localStorage
 */
async function hydrateModelSettingsFromMain() {
  if (!modelSettingsApi.getModelSettingsFromMain) return false;
  let disk;
  try {
    disk = await modelSettingsApi.getModelSettingsFromMain();
  } catch {
    return false;
  }
  if (!disk || typeof disk !== 'object') return false;

  let localRaw = null;
  try {
    localRaw = window.localStorage.getItem(STORAGE_KEY);
  } catch {
    localRaw = null;
  }

  if (!localRaw) {
    const diskSuppliers = countConfiguredSuppliers(disk);
    const diskCustom = countConfiguredCustomModels(disk);
    if (diskSuppliers === 0 && diskCustom === 0 && !String(disk.baseUrl || disk.builtinBaseUrl || '').trim()) {
      return false;
    }
    settings = normalizeSettings(disk);
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    } catch {
      // ignore
    }
    return true;
  }

  const local = settings;
  const next = { ...local };
  let changed = false;
  if (countConfiguredSuppliers(local) === 0 && countConfiguredSuppliers(disk) > 0) {
    next.modelSuppliers = disk.modelSuppliers;
    if (disk.builtinBaseUrl) next.builtinBaseUrl = disk.builtinBaseUrl;
    if (disk.builtinApiKey != null) next.builtinApiKey = disk.builtinApiKey;
    changed = true;
  }
  if (countConfiguredCustomModels(local) === 0 && countConfiguredCustomModels(disk) > 0) {
    next.customModels = disk.customModels;
    changed = true;
  }
  // 默认文本模型：本地为空时认磁盘上的显式值（Main 是 model-settings.json 的唯一落盘方，
  // Renderer 这层只是缓存；不合并就永远看不到别人写的默认模型，还会在下次同步时覆盖掉）。
  if (!String(local.textModel || '').trim() && String(disk.textModel || '').trim()) {
    next.textModel = disk.textModel;
    changed = true;
  }
  if (!changed) return false;
  settings = normalizeSettings(next);
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // ignore
  }
  return true;
}

function saveSettings(s) {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  if (modelSettingsApi.syncModelSettings) {
    modelSettingsApi.syncModelSettings(s).catch(() => {});
  }
  refreshBuiltinModelsAfterSettingsChange();
}

async function syncModelSettingsToMain() {
  if (modelSettingsApi.syncModelSettings) {
    try {
      await modelSettingsApi.syncModelSettings(settings);
    } catch {
      // ignore
    }
  }
}

var cfg = {
  baseUrl: $('cfg-base-url'),
  apiKey: $('cfg-api-key'),
  textModel: $('cfg-text-model'),
  system: $('cfg-system')
};

function getModelRuntimeValues(opts = {}) {
  const tierId = opts.tierId
    ? normalizeContextTierId(opts.tierId)
    : opts.editing === true
      ? resolveContextTierId({ editing: true })
      : resolveContextTierId({ sessionId: opts.sessionId, editing: false });
  const values = getRuntimeValuesForTierId(tierId);
  return {
    temperature: Number.isFinite(Number(values.temperature)) ? Number(values.temperature) : DEFAULTS.temperature,
    contextWindow: clampContextWindowInput(values.contextWindow),
    maxOutputTokens: clampMaxTokensInput(values.maxOutputTokens),
    contextReserveTokens: clampContextReserveInput(values.contextReserveTokens),
    compactionTriggerRatio: clampCompactionTriggerRatioInput(values.compactionTriggerRatio),
    agentToolCallLimit: clampAgentToolCallLimitInput(values.agentToolCallLimit),
    agentMaxRounds: clampAgentMaxRoundsInput(values.agentMaxRounds),
    contextTierId: tierId
  };
}

function clampModelRuntimePatch(partial) {
  const patch = { ...(partial || {}) };
  if (patch.maxOutputTokens != null) {
    patch.maxOutputTokens = clampMaxTokensInput(patch.maxOutputTokens);
    patch.maxTokens = patch.maxOutputTokens;
  }
  if (patch.contextWindow != null) {
    patch.contextWindow = clampContextWindowInput(patch.contextWindow);
  }
  if (patch.contextReserveTokens != null) {
    patch.contextReserveTokens = clampContextReserveInput(patch.contextReserveTokens);
  }
  if (patch.compactionTriggerRatio != null) {
    patch.compactionTriggerRatio = clampCompactionTriggerRatioInput(patch.compactionTriggerRatio);
  }
  if (patch.agentToolCallLimit != null) {
    patch.agentToolCallLimit = clampAgentToolCallLimitInput(patch.agentToolCallLimit);
  }
  if (patch.agentMaxRounds != null) {
    patch.agentMaxRounds = clampAgentMaxRoundsInput(patch.agentMaxRounds);
  }
  return patch;
}

function mirrorDefaultTierToGlobalSettings(values) {
  settings = normalizeSettings({
    ...settings,
    temperature: values.temperature,
    contextWindow: values.contextWindow,
    maxOutputTokens: values.maxOutputTokens,
    maxTokens: values.maxOutputTokens,
    contextReserveTokens: values.contextReserveTokens,
    compactionTriggerRatio: values.compactionTriggerRatio,
    agentToolCallLimit: values.agentToolCallLimit,
    agentMaxRounds: values.agentMaxRounds
  });
  saveSettings(settings);
  syncModelSettingsToMain();
}

/**
 * 把内存里的「按档覆盖」同步到 Main：压缩 / planner / 定时计划读的是 Main 磁盘那一份
 * （`userData/model-runtime-by-tier.json`），localStorage 只是 Renderer 的同步缓存。
 */
function syncRuntimeByTierToMain() {
  const api = window.diecloud;
  if (!api || typeof api.syncRuntimeByTier !== 'function') return;
  if (typeof getAllRuntimeByTier !== 'function') return;
  api.syncRuntimeByTier(getAllRuntimeByTier()).catch(() => {});
}

/**
 * 启动时用 Main 存档回填内存表。Main 为空时（老装机只有 localStorage）不动本地，
 * 等下一次编辑/复位时双写过去 —— 否则会把用户已有的按档覆盖清空。
 */
async function hydrateRuntimeByTierFromMain() {
  const api = window.diecloud;
  if (!api || typeof api.getRuntimeByTierFromMain !== 'function') return false;
  if (typeof hydrateRuntimeByTier !== 'function') return false;
  let disk;
  try {
    disk = await api.getRuntimeByTierFromMain();
  } catch {
    return false;
  }
  if (!disk || typeof disk !== 'object' || !Object.keys(disk).length) return false;
  return hydrateRuntimeByTier(disk);
}

function setModelRuntimeValues(partial, opts = {}) {
  const tierId = opts.tierId
    ? normalizeContextTierId(opts.tierId)
    : opts.editing === true
      ? resolveContextTierId({ editing: true })
      : resolveContextTierId({ sessionId: opts.sessionId, editing: false });
  const patch = clampModelRuntimePatch(partial);
  setRuntimeValuesForTier(tierId, patch);
  syncRuntimeByTierToMain();
  const values = getModelRuntimeValues({ tierId });
  if (tierId === 'default') {
    mirrorDefaultTierToGlobalSettings(values);
  }
  resetCompactionInstances();
  if (typeof refreshContextProgress === 'function') refreshContextProgress();
  window.dispatchEvent(
    new CustomEvent('dieyun:model-runtime-change', {
      detail: { ...values, contextTierId: tierId }
    })
  );
  window.dispatchEvent(
    new CustomEvent('dieyun:context-tier-change', {
      detail: { contextTierId: tierId, values }
    })
  );
  return values;
}

function resetModelRuntimeValues(opts = {}) {
  const tierId = opts.tierId
    ? normalizeContextTierId(opts.tierId)
    : opts.editing === true
      ? resolveContextTierId({ editing: true })
      : 'default';
  resetRuntimeValuesForTier(tierId);
  syncRuntimeByTierToMain();
  const values = getModelRuntimeValues({ tierId });
  if (tierId === 'default') {
    mirrorDefaultTierToGlobalSettings(values);
  }
  resetCompactionInstances();
  if (typeof refreshContextProgress === 'function') refreshContextProgress();
  window.dispatchEvent(
    new CustomEvent('dieyun:model-runtime-change', {
      detail: { ...values, contextTierId: tierId }
    })
  );
  return values;
}

/**
 * 可选模型路由（**唯一一份枚举**）：供应商已启用模型 + 文本类自定义模型。
 *
 * 谁在用：定时计划编辑器（计划绑哪个模型跑）与生命感设置页（唤醒轮用哪个模型）。
 * 以后再有「给某个后台任务挑模型」的地方也该用它 —— 抄一份就必然会与 Composer 的
 * 模态判断分叉（语音模型不接受 chat 请求，选进后台任务必然失败）。
 */
function listSelectableModelRoutes() {
  const out = [];
  const seen = new Set();
  // 判据只有一份：`ModelCapabilities.isNonChatModality`（与 Composer 同一处，勿在这里再列一遍模态名）。
  const isNonChat = (kind) => window.ModelCapabilities?.isNonChatModality?.(kind) === true;
  const modalityOf = (supplier, modelId) =>
    typeof window !== 'undefined' && window.ModelCapabilities
      ? window.ModelCapabilities.getSupplierModelModality(supplier, modelId)
      : 'text';
  try {
    const builtins =
      typeof builtinModelsFromSavedSuppliers === 'function' ? builtinModelsFromSavedSuppliers() : [];
    for (const m of builtins) {
      const supplier = typeof getSupplierById === 'function' ? getSupplierById(m.supplierId) : null;
      if (!supplier || !isSupplierModelEnabled(supplier, m.id)) continue;
      if (isNonChat(modalityOf(supplier, m.id))) continue;
      const route = m.routeKey || `builtin:${m.supplierId}:${m.id}`;
      if (seen.has(route)) continue;
      seen.add(route);
      out.push({ key: route, route, model: m.id, label: `${m.supplierName || '供应商'} · ${m.id}` });
    }
  } catch {
    // ignore：模型列表不可用时只留「跟随默认」
  }
  for (const m of (settings && settings.customModels) || []) {
    if (!m || !m.id || !m.name || isNonChat(m.kind)) continue;
    const route = `custom:${m.id}`;
    if (seen.has(route)) continue;
    seen.add(route);
    out.push({ key: route, route, model: m.name, label: `自定义 · ${m.name}` });
  }
  return out;
}

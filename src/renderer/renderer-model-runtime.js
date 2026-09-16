/* global window, document, $, fetch, escapeHtml, openModelSettingsModal, renderComposerModelLists, renderSuppliersList, updateComposerModelTriggerLabel, refreshContextProgress, resetCompactionInstances, refreshComposerBuiltinModels, clearBuiltinModelsCache, migrateLegacyBuiltinEnabledToSuppliers, showAgentToast, resolveModelContextWindowFromSettings */
'use strict';

var modelSettingsApi = window.diecloud || {};

var REMOVED_BUILTIN_BASE_URLS = new Set(['http://192.168.31.127:30001/v1']);
var DEFAULT_BUILTIN_BASE_URL = '';
var DEFAULT_BUILTIN_API_KEY = '';
function isRemovedBuiltinBaseUrl(url) {
  return REMOVED_BUILTIN_BASE_URLS.has(String(url || '').trim());
}

var BUILTIN_EMBEDDING_LIST_ID = 'embedding-builtin-bge-base-zh-v1.5';
var BUILTIN_EMBEDDING_NAME = 'bge-base-zh-v1.5';
var BUILTIN_EMBEDDING_DIMENSIONS = 768;
var EMBEDDING_DIMENSIONS_MIN = 64;
var EMBEDDING_DIMENSIONS_MAX = 8192;

function isBuiltinEmbeddingListEntry(model) {
  if (!model) return false;
  if (model.builtin === true) return true;
  const id = String(model.id || '');
  return id === BUILTIN_EMBEDDING_LIST_ID || id.startsWith('embedding-builtin-');
}

function createBuiltinEmbeddingListEntry(active = false) {
  return {
    id: BUILTIN_EMBEDDING_LIST_ID,
    name: BUILTIN_EMBEDDING_NAME,
    baseUrl: '内置',
    apiKey: '',
    dimensions: BUILTIN_EMBEDDING_DIMENSIONS,
    active: active === true,
    builtin: true
  };
}

function mergeEmbeddingModelsList(models) {
  const list = Array.isArray(models) ? models : [];
  const userModels = list.filter((m) => !isBuiltinEmbeddingListEntry(m));
  const prevBuiltin = list.find((m) => isBuiltinEmbeddingListEntry(m));
  return [...userModels, createBuiltinEmbeddingListEntry(prevBuiltin != null ? prevBuiltin.active !== false : true)];
}

var DEFAULTS = {
  baseUrl: DEFAULT_BUILTIN_BASE_URL,
  apiKey: DEFAULT_BUILTIN_API_KEY,
  textModel: 'mimo-v2.5-pro',
  visionModel: 'qwen3.6-plus',
  visionBaseUrl: '',
  visionApiKey: '',
  builtinBaseUrl: DEFAULT_BUILTIN_BASE_URL,
  builtinApiKey: DEFAULT_BUILTIN_API_KEY,
  system: '你是叠云编程助手，优先给出可运行、可验证的代码与具体修改步骤；不确定时先读文件再动手。',
  temperature: 0.3,
  maxTokens: 16384,
  maxOutputTokens: 16384,
  contextWindow: 128000,
  contextReserveTokens: 16384,
  compactionTriggerRatio: 0.85,
  agentToolCallLimit: 200,
  agentMaxRounds: 96,
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
  embeddingModels: mergeEmbeddingModelsList([]),
  graphAutoIncremental: true,
  codebaseAutoIncremental: true
};

var MAX_TOKENS_LIMIT = 240000;

function clampMaxTokensInput(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v < 1) return DEFAULTS.maxTokens;
  return Math.min(MAX_TOKENS_LIMIT, Math.max(1, Math.floor(v)));
}

function contextWindowMaxTokens() {
  const fromSchema =
    typeof window !== 'undefined' && Number(window.CONTEXT_WINDOW_MAX);
  return Number.isFinite(fromSchema) && fromSchema > 0 ? fromSchema : 2000000;
}

function clampContextWindowInput(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v < 8192) return DEFAULTS.contextWindow;
  return Math.min(contextWindowMaxTokens(), Math.max(8192, Math.floor(v)));
}

function clampContextReserveInput(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v < 0) return DEFAULTS.contextReserveTokens;
  return Math.min(500000, Math.max(0, Math.floor(v)));
}

function clampCompactionTriggerRatioInput(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return DEFAULTS.compactionTriggerRatio;
  return Math.min(0.95, Math.max(0.3, v));
}

function clampAgentToolCallLimitInput(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v < 1) return DEFAULTS.agentToolCallLimit;
  return Math.min(600, Math.max(5, Math.floor(v)));
}

function getAgentToolCallLimitSetting(s) {
  const src = s != null ? s : getActiveRuntimeSettings();
  return clampAgentToolCallLimitInput(src.agentToolCallLimit ?? DEFAULTS.agentToolCallLimit);
}

function clampAgentMaxRoundsInput(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v < 1) return DEFAULTS.agentMaxRounds;
  return Math.min(600, Math.max(5, Math.floor(v)));
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

function parseModelRouteSelection(selection) {
  const sel = String(selection || '');
  if (sel.startsWith('builtin:')) {
    const rest = sel.slice('builtin:'.length);
    const idx = rest.indexOf(':');
    return {
      kind: 'builtin',
      supplierId: idx >= 0 ? rest.slice(0, idx) : null,
      modelId: idx >= 0 ? rest.slice(idx + 1) : rest
    };
  }
  if (sel.startsWith('custom:')) {
    return { kind: 'custom', customId: sel.slice('custom:'.length) };
  }
  return { kind: 'unknown' };
}

function resolveContextTierIdForRoute(route) {
  const parsed = parseModelRouteSelection(route);
  if (parsed.kind === 'builtin') {
    const supplier = parsed.supplierId ? getSupplierById(parsed.supplierId) : (settings.modelSuppliers || [])[0];
    const modelId = String(parsed.modelId || '');
    const perModel = supplier?.contextTierByModel?.[modelId];
    if (perModel) return normalizeContextTierId(perModel);
    if (supplier?.contextTier) return normalizeContextTierId(supplier.contextTier);
    if (typeof inferContextTierFromModelName === 'function') {
      return normalizeContextTierId(inferContextTierFromModelName(modelId));
    }
    return 'default';
  }
  if (parsed.kind === 'custom') {
    const model = (settings.customModels || []).find((m) => m.id === parsed.customId);
    if (model?.contextTier) return normalizeContextTierId(model.contextTier);
    if (model?.name && typeof inferContextTierFromModelName === 'function') {
      return normalizeContextTierId(inferContextTierFromModelName(model.name));
    }
    return 'default';
  }
  return 'default';
}

/** 当前会话选中的模型路由（`custom:xxx` / `supplierId:modelId`）；未确认选择时返回 ''。 */
function resolveActiveModelRoute(opts = {}) {
  const sessionId = resolveActiveSessionId(opts.sessionId);
  try {
    if (typeof resolveComposerModelPickForSend === 'function') {
      const pick = resolveComposerModelPickForSend(sessionId || undefined);
      if (pick && !pick.autoMode && pick.selection && pick.selection !== 'auto') {
        return String(pick.selection);
      }
      return '';
    }
    const pick = getComposerModelPick();
    if (pick && !pick.autoMode && pick.selection && pick.selection !== 'auto') {
      return String(pick.selection);
    }
  } catch {
    // 打包 TDZ / 初始化竞态时回退 default，避免启动崩
  }
  return '';
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
  if (typeof getRuntimeValuesForTier === 'function') {
    return getRuntimeValuesForTier(normalizeContextTierId(tierId));
  }
  return getModelRuntimeValues(settings);
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

function getEffectiveInputBudget(s) {
  const src = s != null ? s : getActiveRuntimeSettings();
  const budget = getContextWindowTokens(src) - getMaxOutputTokens(src) - getContextReserveTokens(src);
  return Math.max(1024, Math.floor(budget));
}

function getCompactionTriggerRatio(s) {
  const src = s != null ? s : getActiveRuntimeSettings();
  return clampCompactionTriggerRatioInput(
    src.compactionTriggerRatio ?? DEFAULTS.compactionTriggerRatio
  );
}
var STORAGE_KEY = 'diecloud.model.settings.v1';
var LEGACY_RUNTIME_PRESETS = {
  temperature: [0.7],
  compactionTriggerRatio: [0.75, 0.68]
};

function migrateLegacyRuntimeDefaults(raw, s) {
  if (!raw || typeof raw !== 'object') return false;
  let changed = false;
  const temp = Number(s.temperature);
  if (LEGACY_RUNTIME_PRESETS.temperature.some((v) => Math.abs(temp - v) < 0.001)) {
    s.temperature = DEFAULTS.temperature;
    changed = true;
  }
  const ratio = Number(s.compactionTriggerRatio);
  if (LEGACY_RUNTIME_PRESETS.compactionTriggerRatio.some((v) => Math.abs(ratio - v) < 0.001)) {
    s.compactionTriggerRatio = DEFAULTS.compactionTriggerRatio;
    changed = true;
  }
  if (
    raw &&
    !Object.prototype.hasOwnProperty.call(raw, 'embeddingModels') &&
    !s.embeddingModels.some((m) => m.active)
  ) {
    s.embeddingModels = s.embeddingModels.map((m) => ({
      ...m,
      active: !!m.builtin
    }));
    const activeEmbedding = s.embeddingModels.find((m) => m.active) || null;
    s.embeddingEnabled = !!activeEmbedding;
    if (activeEmbedding) {
      s.embeddingModel = activeEmbedding.name;
      s.embeddingBaseUrl = activeEmbedding.builtin ? '' : activeEmbedding.baseUrl || '';
      s.embeddingApiKey = activeEmbedding.builtin ? '' : activeEmbedding.apiKey || '';
      s.embeddingDimensions = activeEmbedding.dimensions || DEFAULTS.embeddingDimensions;
    }
    changed = true;
  }
  return changed;
}

function normalizeContextTierId(value, fallback = 'default') {
  const remap =
    typeof remapLegacyContextTierId === 'function'
      ? remapLegacyContextTierId
      : (id) => (String(id || '').trim() === 'ctx-8k' ? 'ctx-16k' : String(id || '').trim());
  const id = remap(String(value || '').trim());
  if (typeof isValidContextTierId === 'function' && isValidContextTierId(id)) return id;
  return fallback;
}

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
  return {
    id: String(m?.id || `supplier-${Date.now()}-${index}`),
    name: String(m?.name || '').trim(),
    baseUrl: String(m?.baseUrl || '').trim(),
    apiKey: String(m?.apiKey || '').trim(),
    contextTier: normalizeContextTierId(m?.contextTier, 'default'),
    enabledModels,
    modelModalities,
    contextTierByModel
  };
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

function isSupplierModelEnabled(supplier, modelId) {
  if (!supplier || !modelId) return false;
  const map = supplier.enabledModels || {};
  if (!Object.keys(map).length) return true;
  if (map[modelId] === false) return false;
  return map[modelId] === true;
}

function getSupplierById(supplierId) {
  return (settings.modelSuppliers || []).find((s) => s.id === supplierId) || null;
}

function normalizeSettings(raw) {
  const s = { ...DEFAULTS, ...raw };
  if (raw && raw.model && !raw.textModel) s.textModel = raw.model;
  s.builtinBaseUrl = String(s.builtinBaseUrl || '').trim();
  s.builtinApiKey = String(s.builtinApiKey || '').trim();
  if (!s.builtinBaseUrl || isRemovedBuiltinBaseUrl(s.builtinBaseUrl)) {
    s.builtinBaseUrl = DEFAULT_BUILTIN_BASE_URL;
  }
  if (!s.builtinApiKey || isRemovedBuiltinBaseUrl(raw?.builtinBaseUrl)) {
    s.builtinApiKey = DEFAULT_BUILTIN_API_KEY;
  }
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
  s.codebaseAutoIncremental = s.codebaseAutoIncremental !== false;
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
  const firstVision = s.customModels.find((m) => m.kind === 'vision');
  const firstSpeech = s.customModels.find((m) => m.kind === 'speech');
  if (firstText) {
    s.textModel = firstText.name;
    s.baseUrl = firstText.baseUrl || '';
    s.apiKey = firstText.apiKey || '';
  } else {
    s.textModel = '';
    s.baseUrl = '';
    s.apiKey = '';
  }
  if (firstVision) {
    s.visionModel = firstVision.name;
    s.visionBaseUrl = firstVision.baseUrl || s.baseUrl || '';
    s.visionApiKey = firstVision.apiKey || s.apiKey || '';
  } else {
    s.visionModel = '';
    s.visionBaseUrl = '';
    s.visionApiKey = '';
  }
  if (firstSpeech) {
    s.speechWhisperModel = firstSpeech.name;
    s.speechBaseUrl = firstSpeech.baseUrl || s.baseUrl || '';
    s.speechApiKey = firstSpeech.apiKey || s.apiKey || '';
  } else if (!String(s.speechWhisperModel || '').trim()) {
    s.speechWhisperModel = DEFAULTS.speechWhisperModel;
  }
  const normalizeEmbedding = (m, index) => {
    const builtin = isBuiltinEmbeddingListEntry(m);
    return {
      id: String(m?.id || `embedding-${Date.now()}-${index}`),
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
  };
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
  const normalizedEmbeddingSource = sourceEmbeddingModels.map(normalizeEmbedding);
  const userEmbeddingModels = normalizedEmbeddingSource.filter((m) => m.name && !m.builtin);
  const builtinEmbeddingEntry = normalizedEmbeddingSource.find((m) => m.builtin);
  s.embeddingModels = mergeEmbeddingModelsList(
    builtinEmbeddingEntry ? [...userEmbeddingModels, builtinEmbeddingEntry] : userEmbeddingModels
  );
  s.embeddingModels = s.embeddingModels.filter(
    (m) => !(m.id === 'embedding-default' && m.name === 'text-embedding-v4')
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
  const activeEmbedding = s.embeddingModels.find((m) => m.active) || null;
  s.embeddingEnabled = !!activeEmbedding;
  if (!activeEmbedding) {
    s.embeddingModel = '';
    s.embeddingBaseUrl = '';
    s.embeddingApiKey = '';
    s.embeddingDimensions = DEFAULTS.embeddingDimensions;
    return s;
  }
  if (activeEmbedding) {
    s.embeddingModel = activeEmbedding.name;
    s.embeddingBaseUrl = activeEmbedding.builtin ? '' : activeEmbedding.baseUrl || DEFAULTS.embeddingBaseUrl;
    s.embeddingApiKey = activeEmbedding.builtin ? '' : activeEmbedding.apiKey || '';
    s.embeddingDimensions = activeEmbedding.dimensions || DEFAULTS.embeddingDimensions;
  }
  return s;
}

function loadSettings() {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return normalizeSettings({});
    const parsed = JSON.parse(raw);
    const normalized = normalizeSettings(parsed);
    if (migrateLegacyRuntimeDefaults(parsed, normalized)) {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(normalized));
    }
    return normalized;
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

function getVisionModelId(s) {
  const x = s || settings;
  return String(x.visionModel || getTextModelId(x) || '').trim();
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

function pickCustomVisionModel(s) {
  return window.ModelCapabilities?.pickVisionModel?.(s || settings) || null;
}

function getVisionApiConfig(s) {
  if (window.ModelCapabilities?.getVisionApiConfigFromSettings) {
    return window.ModelCapabilities.getVisionApiConfigFromSettings(s || settings);
  }
  return { baseUrl: '', apiKey: '', model: '' };
}

function getBuiltinApiConfig(supplierId) {
  const supplier = supplierId ? getSupplierById(supplierId) : (settings.modelSuppliers || [])[0];
  if (supplier) {
    return {
      baseUrl: String(supplier.baseUrl || '').trim(),
      apiKey: String(supplier.apiKey || '').trim()
    };
  }
  return {
    baseUrl: String(settings.builtinBaseUrl || '').trim(),
    apiKey: String(settings.builtinApiKey || '').trim()
  };
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
    if (model) {
      return {
        baseUrl: model.baseUrl || '',
        apiKey: model.apiKey || ''
      };
    }
  }
  if (/^(?:auto-)?builtin(?::|$)/.test(routeText)) {
    return getBuiltinApiConfig();
  }
  const selected = getSelectedCustomModel();
  if (selected) {
    return {
      baseUrl: selected.baseUrl || settings.baseUrl || '',
      apiKey: selected.apiKey || settings.apiKey || ''
    };
  }
  if (route === 'custom-vision') {
    return {
      baseUrl: getVisionApiConfig().baseUrl || settings.baseUrl,
      apiKey: getVisionApiConfig().apiKey || settings.apiKey
    };
  }
  return { baseUrl: settings.baseUrl, apiKey: settings.apiKey };
}

function refreshBuiltinModelsAfterSettingsChange() {
  if (typeof refreshComposerBuiltinModels === 'function') {
    refreshComposerBuiltinModels();
    return;
  }
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
  visionModel: $('cfg-vision-model'),
  visionBaseUrl: $('cfg-vision-base-url'),
  visionApiKey: $('cfg-vision-api-key'),
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

function setModelRuntimeValues(partial, opts = {}) {
  const tierId = opts.tierId
    ? normalizeContextTierId(opts.tierId)
    : opts.editing === true
      ? resolveContextTierId({ editing: true })
      : resolveContextTierId({ sessionId: opts.sessionId, editing: false });
  const patch = clampModelRuntimePatch(partial);
  let values;
  if (typeof setRuntimeValuesForTier === 'function') {
    values = setRuntimeValuesForTier(tierId, patch);
    values = getModelRuntimeValues({ tierId });
  } else {
    settings = normalizeSettings({ ...settings, ...patch });
    saveSettings(settings);
    values = getModelRuntimeValues({ tierId: 'default' });
  }
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
  if (typeof resetRuntimeValuesForTier === 'function') {
    resetRuntimeValuesForTier(tierId);
  }
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

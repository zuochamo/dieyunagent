/* global window, document, $, fetch, escapeHtml, openModelSettingsModal, renderComposerModelLists, renderSuppliersList, updateComposerModelTriggerLabel, refreshContextProgress, resetCompactionInstances, refreshComposerBuiltinModels, clearBuiltinModelsCache, migrateLegacyBuiltinEnabledToSuppliers, showAgentToast, mountSelectMenu, ensureSelectMenu, gatewayCall, currentSessionId, uiText */
'use strict';

function applyModelRuntimePreset(presetId) {
  const getter =
    typeof window !== 'undefined' && typeof window.getModelRuntimePresetById === 'function'
      ? window.getModelRuntimePresetById
      : null;
  const preset = getter ? getter(presetId) : null;
  if (!preset || !preset.values) {
    const e = new Error(`未知编码参数模板：${presetId}`);
    e.code = 'MODEL_RUNTIME_PRESET_UNKNOWN';
    throw e;
  }
  const tierId = normalizeContextTierId(presetId);
  if (typeof resetRuntimeValuesForTier === 'function') {
    resetRuntimeValuesForTier(tierId);
  }
  return setModelRuntimeValues({ ...preset.values }, { tierId, editing: true });
}

function applyFormValues(s) {
  if (cfg.baseUrl) cfg.baseUrl.value = s.baseUrl;
  if (cfg.apiKey) cfg.apiKey.value = s.apiKey;
  if (cfg.textModel) cfg.textModel.value = getTextModelId(s);
  if (cfg.system) cfg.system.value = s.system;
  if (typeof syncTtsAutoReadControl === 'function') syncTtsAutoReadControl(s);
}

var settings = loadSettings();
if (typeof migrateGlobalSettingsToDefaultTier === 'function') {
  migrateGlobalSettingsToDefaultTier(settings);
}
if (typeof getRuntimeValuesForTier === 'function') {
  const defaultRuntime = getRuntimeValuesForTier('default');
  settings = normalizeSettings({
    ...settings,
    temperature: defaultRuntime.temperature,
    contextWindow: defaultRuntime.contextWindow,
    maxOutputTokens: defaultRuntime.maxOutputTokens,
    maxTokens: defaultRuntime.maxOutputTokens,
    contextReserveTokens: defaultRuntime.contextReserveTokens,
    compactionTriggerRatio: defaultRuntime.compactionTriggerRatio,
    agentToolCallLimit: defaultRuntime.agentToolCallLimit,
    agentMaxRounds: defaultRuntime.agentMaxRounds
  });
}
applyFormValues(settings);

async function bootstrapModelSettingsFromDisk() {
  const hydrated = await hydrateModelSettingsFromMain();
  if (hydrated) {
    applyFormValues(settings);
    if (typeof renderDefinedModelsList === 'function') renderDefinedModelsList();
    if (typeof renderEmbeddingModelsList === 'function') renderEmbeddingModelsList();
    if (typeof renderSuppliersList === 'function') renderSuppliersList();
    if (typeof renderComposerModelLists === 'function') renderComposerModelLists();
    if (typeof refreshBuiltinModelsAfterSettingsChange === 'function') {
      refreshBuiltinModelsAfterSettingsChange();
    }
  }
  await syncModelSettingsToMain();
}
void bootstrapModelSettingsFromDisk();

$('settings-form').addEventListener('submit', (e) => {
  e.preventDefault();
  settings = normalizeSettings({
    ...settings,
    system: cfg.system?.value ?? settings.system
  });
  saveSettings(settings);
  resetCompactionInstances();
  applyFormValues(settings);
  renderDefinedModelsList();
  renderEmbeddingModelsList();
  renderSuppliersList();
  renderComposerModelLists();
  updateComposerModelTriggerLabel();
  refreshContextProgress();
  const saveHint = $('save-hint');
  if (saveHint) {
    saveHint.textContent = '已保存 ✓';
    saveHint.classList.add('show');
    setTimeout(() => saveHint.classList.remove('show'), 1600);
  }
});

var editingDefinedModelId = null;
var editingEmbeddingModelId = null;
var editingSupplierId = null;
var supplierEditorModels = [];
var supplierEditorEnabledModels = {};
var supplierEditorModelModalities = {};
var supplierEditorContextTier = 'default';
var supplierEditorContextTierByModel = {};

/** Context 档位下拉的选项：档位集合是运行时配置（window.MODEL_RUNTIME_PRESETS），故由 JS 生成。 */
function populateContextTierMenu(menu, value, { includeInherit = false, includeAutoInfer = false } = {}) {
  if (!menu) return;
  const items = [];
  if (includeAutoInfer) items.push({ key: '', label: '自动推断（按模型名）' });
  if (includeInherit) items.push({ key: '', label: '继承供应商默认' });
  const presets =
    typeof window !== 'undefined' && window.MODEL_RUNTIME_PRESETS ? window.MODEL_RUNTIME_PRESETS : [];
  for (const preset of presets) {
    items.push({ key: preset.id, label: preset.label, title: preset.hint || '' });
  }
  menu.setOptions(items);
  // 与原生 <select> 一致：值不在选项里（档位已下架等）时归零到「自动/继承」项
  const wanted = value || (includeInherit || includeAutoInfer ? '' : 'default');
  const known = items.some((it) => it.key === wanted);
  menu.setValue(known ? wanted : '');
}

let supplierEditorContextTierMenu = null;
let definedModelEditorContextTierMenu = null;

function ensureSupplierEditorContextTierMenu() {
  if (supplierEditorContextTierMenu) return supplierEditorContextTierMenu;
  supplierEditorContextTierMenu = ensureSelectMenu('supplier-editor-context-tier');
  return supplierEditorContextTierMenu;
}

function ensureDefinedModelEditorContextTierMenu() {
  if (definedModelEditorContextTierMenu) return definedModelEditorContextTierMenu;
  definedModelEditorContextTierMenu = ensureSelectMenu('defined-model-editor-context-tier');
  return definedModelEditorContextTierMenu;
}

function formatContextTierLabel(tierId) {
  const id = normalizeContextTierId(tierId, '');
  if (!id) return '自动推断';
  const preset = (window.MODEL_RUNTIME_PRESETS || []).find((p) => p.id === id);
  return preset?.label || id;
}

function getSupplierEditorModelContextTier(modelId) {
  const id = String(modelId || '');
  const tier = supplierEditorContextTierByModel[id];
  return tier ? normalizeContextTierId(tier) : '';
}

function setSupplierEditorModelContextTier(modelId, tierId) {
  const id = String(modelId || '');
  if (!id) return;
  const normalized = String(tierId || '').trim();
  if (!normalized) {
    delete supplierEditorContextTierByModel[id];
  } else {
    supplierEditorContextTierByModel[id] = normalizeContextTierId(normalized);
  }
}

/**
 * 编辑器里某行模型的模态：已声明用声明值，**未声明（刚检测到 / 新加的行）默认「全模态」**。
 *
 * 兜底不能直接用 `normalizeModalitySetting` 的 text：那一处兜底读的是历史设置
 * （与 Main 侧同判据，纯文本模型被当能识图会 400）。这里是「新建」场景，
 * 默认给全模态，用户加完模型不用再逐个点标签。
 */
function editorModelModality(declaredValue) {
  const mc = window.ModelCapabilities;
  if (declaredValue) return mc?.normalizeModalitySetting(declaredValue) || 'text';
  return mc?.DEFAULT_MODALITY || 'vision';
}

function getSupplierEditorModelModality(modelId) {
  const id = String(modelId || '');
  return editorModelModality(supplierEditorModelModalities[id]);
}

function setSupplierEditorModelModality(modelId, modality) {
  const id = String(modelId || '');
  if (!id) return;
  supplierEditorModelModalities[id] =
    window.ModelCapabilities?.normalizeModalitySetting(modality) || 'text';
  renderSupplierEditorModelList();
}

function renderSupplierModelModalityTags(modelId) {
  const wrap = document.createElement('div');
  wrap.className = 'supplier-editor-model-modality';
  wrap.setAttribute('role', 'radiogroup');
  wrap.setAttribute('aria-label', `${modelId} 模型类型`);
  const current = getSupplierEditorModelModality(modelId);
  const mc = window.ModelCapabilities;
  const options = mc?.MODALITY_OPTIONS || ['text', 'vision', 'speech', 'tts'];
  for (const kind of options) {
    // 标签文案唯一来源：ModelCapabilities.MODALITY_LABELS（别在这里再写一份三元表达式）
    const label = mc?.MODALITY_LABELS?.[kind]?.label || kind;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'model-modality-tag supplier-model-modality-tag';
    btn.dataset.modality = kind;
    btn.dataset.modelId = modelId;
    btn.textContent = label;
    const on = current === kind;
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    btn.classList.toggle('is-active', on);
    btn.addEventListener('click', () => setSupplierEditorModelModality(modelId, kind));
    wrap.appendChild(btn);
  }
  return wrap;
}

function maskSecret(value) {
  const s = String(value || '');
  if (!s) return '未填写';
  if (s.length <= 8) return '********';
  return `${s.slice(0, 4)}...${s.slice(-4)}`;
}

function updateSettingsFromModelLists() {
  settings = normalizeSettings(settings);
  applyFormValues(settings);
  saveSettings(settings);
  renderComposerModelLists();
  updateComposerModelTriggerLabel();
}

/**
 * 「自动朗读新回复」开关的显示状态。
 *
 * 没有「语音合成」模型时置灰 —— 打开一个永远不会生效的开关比不显示更糟，
 * 且只有在点不动的时候才需要一行文案解释原因；能正常朗读时不占多余说明。
 * 判据与朗读按钮同源（`ModelCapabilities.pickTtsModel`）。
 */
function syncTtsAutoReadControl(s) {
  const input = $('tts-auto-read');
  if (!input) return;
  const src = s && typeof s === 'object' ? s : settings;
  const hasTts = !!window.ModelCapabilities?.pickTtsModel?.(src);
  input.checked = src.ttsAutoRead === true;
  input.disabled = !hasTts;
  const hint = $('tts-auto-read-hint');
  if (hint) {
    hint.hidden = hasTts;
    hint.textContent = hasTts
      ? ''
      : uiText(
          'tts_auto_read_hint_off',
          '目前没有「语音合成」类型的模型：先在「自定义模型」里把模型类型改成「语音合成」，这里才能启用。'
        );
  }
}

function getDefinedModelEditorModality() {
  const active = document.querySelector('#defined-model-editor-modality-tags .model-modality-tag[aria-pressed="true"]');
  const value = active?.dataset?.modality;
  return window.ModelCapabilities?.normalizeModalitySetting(value) || 'text';
}

function setDefinedModelEditorModality(value) {
  const setting = window.ModelCapabilities?.normalizeModalitySetting(value) || 'text';
  document.querySelectorAll('#defined-model-editor-modality-tags .model-modality-tag').forEach((btn) => {
    const on = btn.dataset.modality === setting;
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    btn.classList.toggle('is-active', on);
  });
  // 音色只对「语音合成」有意义；转写/文本/全模态模型上留着只会被误填
  const voiceField = $('defined-model-editor-voice-field');
  if (voiceField) voiceField.hidden = setting !== 'tts';
}

function renderDefinedModelModalityBadge(model) {
  const mc = window.ModelCapabilities;
  if (!mc) return '<span class="model-modality-badge text">—</span>';
  const info = mc.describeCustomModelModality(model);
  const cls = ['vision', 'speech', 'tts'].includes(info.kind) ? info.kind : 'text';
  return `<span class="model-modality-badge ${cls}" title="${escapeHtml(info.label)}">${escapeHtml(info.short)}</span>`;
}

function renderDefinedModelsList() {
  const list = $('defined-model-list');
  if (!list) return;
  list.innerHTML = '';
  const models = settings.customModels || [];
  if (!models.length) {
    list.innerHTML = '<div class="defined-model-empty">暂无模型，请点击「添加」。</div>';
    return;
  }
  for (const m of models) {
    const row = document.createElement('div');
    row.className = 'defined-model-row';
    row.innerHTML = `
      <span class="defined-model-value defined-model-name">${escapeHtml(m.name)}</span>
      <span class="defined-model-value">${escapeHtml(m.baseUrl || '-')}</span>
      <span class="defined-model-value">${escapeHtml(maskSecret(m.apiKey))}</span>
      <span class="defined-model-value">${renderDefinedModelModalityBadge(m)}</span>
      <span class="defined-model-value">${escapeHtml(formatContextTierLabel(m.contextTier))}</span>
      <span class="defined-model-value"><button type="button" class="ghost-btn" data-edit-defined="${escapeHtml(m.id)}">编辑</button></span>
    `;
    list.appendChild(row);
  }
  list.querySelectorAll('[data-edit-defined]').forEach((btn) => {
    btn.addEventListener('click', () => openDefinedModelEditor(btn.dataset.editDefined));
  });
}

function renderEmbeddingModelsList() {
  const list = $('embedding-model-list');
  if (!list) return;
  list.innerHTML = '';
  const models = settings.embeddingModels || [];
  for (const m of models) {
    const row = document.createElement('div');
    row.className = 'embedding-model-row';
    const status = m.active ? '当前' : '未启用';
    row.innerHTML = `
      <span class="defined-model-value defined-model-name">${escapeHtml(m.name)}</span>
      <span class="defined-model-value">${escapeHtml(m.baseUrl || '-')}</span>
      <span class="defined-model-value">${escapeHtml(maskSecret(m.apiKey))}</span>
      <span class="defined-model-value">${escapeHtml(String(m.dimensions || DEFAULTS.embeddingDimensions))}</span>
      <span class="defined-model-value">${status}</span>
      <span class="defined-model-value"><button type="button" class="ghost-btn" data-edit-embedding="${escapeHtml(m.id)}">编辑</button></span>
    `;
    list.appendChild(row);
  }
  if (!models.some((m) => m.active)) {
    const hint = document.createElement('div');
    hint.className = 'defined-model-empty';
    hint.textContent =
      '未配置向量模型：语义检索关闭，召回只用关键词匹配。添加一个外部向量模型（OpenAI 兼容 /embeddings 端点）即可启用。';
    list.appendChild(hint);
  }
  list.querySelectorAll('[data-edit-embedding]').forEach((btn) => {
    btn.addEventListener('click', () => openEmbeddingModelEditor(btn.dataset.editEmbedding));
  });
}

function renderSuppliersList() {
  const list = $('supplier-list');
  if (!list) return;
  list.innerHTML = '';
  const suppliers = settings.modelSuppliers || [];
  if (!suppliers.length) {
    list.innerHTML = '<div class="defined-model-empty">暂无供应商，请点击「添加」。</div>';
    return;
  }
  for (const s of suppliers) {
    const row = document.createElement('div');
    row.className = 'defined-model-row supplier-model-row';
    const enabledCount = countSupplierEnabledModels(s);
    const modalitySummary = window.ModelCapabilities?.supplierModalitySummary?.(s) || '';
    const countLabel =
      enabledCount < 0
        ? '全部'
        : modalitySummary
          ? `${enabledCount} 个 · ${modalitySummary}`
          : `${enabledCount} 个`;
    row.innerHTML = `
      <span class="defined-model-value defined-model-name">${escapeHtml(supplierDisplayName(s))}</span>
      <span class="defined-model-value">${escapeHtml(s.baseUrl || '-')}</span>
      <span class="defined-model-value">${escapeHtml(maskSecret(s.apiKey))}</span>
      <span class="defined-model-value">${escapeHtml(countLabel)}</span>
      <span class="defined-model-value"><button type="button" class="ghost-btn" data-edit-supplier="${escapeHtml(s.id)}">编辑</button></span>
    `;
    list.appendChild(row);
  }
  list.querySelectorAll('[data-edit-supplier]').forEach((btn) => {
    btn.addEventListener('click', () => openSupplierEditor(btn.dataset.editSupplier));
  });
}

function setSupplierEditorDetectStatus(text, ok) {
  const el = $('supplier-editor-detect-status');
  if (!el) return;
  el.textContent = text || '';
  el.classList.toggle('ok', ok === true);
  el.classList.toggle('warn', ok === false);
}

function setSupplierEditorDetecting(on) {
  const detecting = !!on;
  const btn = $('supplier-editor-detect');
  const status = $('supplier-editor-detect-status');
  const section = document.querySelector('.supplier-editor-models-section');
  const list = $('supplier-editor-models-list');
  if (btn) {
    if (!btn.dataset.idleLabel) btn.dataset.idleLabel = btn.textContent.trim() || '检测模型';
    btn.disabled = detecting;
    btn.classList.toggle('is-detecting', detecting);
    btn.setAttribute('aria-busy', detecting ? 'true' : 'false');
    btn.textContent = detecting ? '检测中…' : btn.dataset.idleLabel;
  }
  if (status) status.classList.toggle('is-detecting', detecting);
  if (section) {
    section.classList.toggle('is-detecting', detecting);
    section.setAttribute('aria-busy', detecting ? 'true' : 'false');
  }
  if (list) list.classList.toggle('is-detecting', detecting);
}

function renderSupplierEditorModelList() {
  const list = $('supplier-editor-models-list');
  if (!list) return;
  list.innerHTML = '';
  if (!supplierEditorModels.length) {
    list.innerHTML = '<div class="supplier-editor-models-empty">尚未检测模型</div>';
    return;
  }
  for (const m of supplierEditorModels) {
    const modelId = String(m.id || '');
    if (!modelId) continue;
    const on = supplierEditorEnabledModels[modelId] !== false;
    const row = document.createElement('div');
    row.className = `supplier-editor-model-row${on ? '' : ' disabled'}`;
    const name = document.createElement('span');
    name.className = 'supplier-editor-model-name';
    name.textContent = modelId;
    const modality = renderSupplierModelModalityTags(modelId);
    // 每行一个档位下拉：wrap 动态创建，实例随行一起被移除后自动回收
    const tierWrap = document.createElement('div');
    tierWrap.className = 'context-tier-select supplier-model-tier-select';
    const tierMenu = mountSelectMenu({
      wrap: tierWrap,
      title: 'Context 档位',
      ariaLabel: `Context 档位：${modelId}`,
      onPick: (tierId) => setSupplierEditorModelContextTier(modelId, tierId)
    });
    populateContextTierMenu(tierMenu, getSupplierEditorModelContextTier(modelId), { includeInherit: true });
    const label = document.createElement('label');
    label.className = 'toggle-switch';
    label.title = on ? '已启用' : '已关闭';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = on;
    input.addEventListener('change', () => {
      supplierEditorEnabledModels[modelId] = input.checked;
      row.classList.toggle('disabled', !input.checked);
      label.title = input.checked ? '已启用' : '已关闭';
    });
    const track = document.createElement('span');
    track.className = 'toggle-switch-track';
    label.appendChild(input);
    label.appendChild(track);
    row.appendChild(name);
    row.appendChild(modality);
    row.appendChild(tierWrap);
    row.appendChild(label);
    list.appendChild(row);
  }
}

/**
 * llm-request 模块（经 dist/agent-bundle.js 注册为 window.LlmRequest）。
 *
 * 取不到时**绝不抛错**：设置页必须始终能打开与保存。
 * 否则一旦 bundle 未随源码更新（例如应用没重启），一个 undefined 就会让
 * 「保存」整条链路中断——表现为点了没反应，且看不出任何原因。
 */
function llmRequestApi() {
  return (typeof window !== 'undefined' && window.LlmRequest) || null;
}

let warnedLlmRequestMissing = false;
/** 只在首次降级时提示一次：bundle 未随源码更新是「看不出任何原因」的典型故障 */
function warnLlmRequestMissingOnce() {
  if (warnedLlmRequestMissing) return;
  warnedLlmRequestMissing = true;
  console.warn('[model-settings] llm-request 不可用（agent-bundle 未加载或过期），请求头/端点已退化为惰性默认值');
}

/** 降级解析（仅 llm-request 不可用时使用；规则与其一致：每行 `名称: 值`） */
function parseHeaderLinesFallback(text) {
  const out = {};
  for (const line of String(text == null ? '' : text).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf(':');
    if (idx <= 0) continue;
    out[trimmed.slice(0, idx).trim()] = trimmed.slice(idx + 1).trim();
  }
  return out;
}

function normalizeHeadersLoose(input) {
  const api = llmRequestApi();
  if (api && typeof api.normalizeConfiguredHeaders === 'function') {
    return api.normalizeConfiguredHeaders(input);
  }
  if (typeof input === 'string') return parseHeaderLinesFallback(input);
  if (input && typeof input === 'object') return { ...input };
  return {};
}

/**
 * 自定义请求头在「存储（对象）」与「编辑（多行文本）」之间转换。
 * 解析 / 归一化统一委托 llm-request，避免设置页与运行时各有一套规则
 * （那正是「测试通过但真实请求 400」的来源）。
 */
function headersToEditorText(headers) {
  const obj = normalizeHeadersLoose(headers);
  return Object.entries(obj)
    .map(([name, value]) => `${name}: ${value}`)
    .join('\n');
}

function readHeadersFromEditor(id) {
  const el = $(id);
  if (!el) return {};
  return normalizeHeadersLoose(el.value);
}

/**
 * 保存前的校验版读取：文本框有内容却解析不出任何头，说明写法有误
 * （最常见是漏了冒号与值，例如只写 `x-opencode-session`）。
 *
 * 这时返回 error 让保存停下并提示，而不是静默丢弃用户输入 ——
 * 静默丢弃的体验就是「我填了、点了保存、再打开就没了」。
 */
function readHeadersFromEditorChecked(id) {
  const el = $(id);
  if (!el) return { headers: {} };
  if (!String(el.value || '').trim()) return { headers: {} };
  const headers = readHeadersFromEditor(id);
  if (!Object.keys(headers).length) {
    return {
      headers: {},
      error: '自定义请求头格式无法识别：每行需形如「名称: 值」，例如 x-opencode-session: {{sessionId}}'
    };
  }
  return { headers };
}

/**
 * 探针请求（拉模型列表 / 探测可用性）没有会话语义，但部分网关必须先看到会话头
 * 才会响应。这里用固定标识把占位符渲染掉，保证「检测」与「真实使用」同一套头。
 */
function renderProbeHeaders(headers, modelName) {
  const api = llmRequestApi();
  const out = {};
  for (const [name, value] of Object.entries(headers || {})) {
    const rendered =
      api && typeof api.renderHeaderTemplate === 'function'
        ? api.renderHeaderTemplate(value, { sessionId: 'probe', model: modelName || '' })
        : String(value == null ? '' : value).trim();
    if (rendered) out[name] = rendered;
  }
  return out;
}

/**
 * 装配请求头。唯一来源是 llm-request（含 authMode / 自定义头 / User-Agent）。
 *
 * llm-request 不可用时只给惰性默认头，**不再自行拼 Authorization**：
 * 自拼的 Bearer 与真实请求的鉴权方式可能不一致（如 authMode=x-api-key 时探针发 Bearer），
 * 那正是「测试通过但真实请求 400」的来源。宁可让探针明确失败并提示，也不给假结果。
 */
function buildHeadersFromConfigLoose(config, vars) {
  const api = llmRequestApi();
  const cfg = config && typeof config === 'object' ? config : {};
  if (api && typeof api.buildLlmHeadersFromConfig === 'function') {
    return api.buildLlmHeadersFromConfig(cfg, vars);
  }
  warnLlmRequestMissingOnce();
  return { 'Content-Type': 'application/json' };
}

function collectSupplierEditorConfig() {
  return {
    name: $('supplier-editor-name').value.trim(),
    baseUrl: $('supplier-editor-base-url').value.trim(),
    apiKey: $('supplier-editor-api-key').value.trim(),
    userAgent: ($('supplier-editor-user-agent')?.value || '').trim(),
    headers: readHeadersFromEditor('supplier-editor-headers')
  };
}

async function detectSupplierModelsForEditor() {
  const cfg = collectSupplierEditorConfig();
  if (!cfg.baseUrl) {
    setSupplierEditorDetectStatus('请先填写接口地址', false);
    return;
  }
  if (!modelSettingsApi.fetchBuiltinModels) {
    setSupplierEditorDetectStatus('当前环境不支持模型检测', false);
    return;
  }
  setSupplierEditorDetecting(true);
  setSupplierEditorDetectStatus('正在检测…');
  try {
    const res = await modelSettingsApi.fetchBuiltinModels({
      baseUrl: cfg.baseUrl,
      apiKey: cfg.apiKey,
      userAgent: cfg.userAgent,
      headers: renderProbeHeaders(cfg.headers, cfg.name),
      validate: true
    });
    if (!res || !res.ok) {
      throw new Error((res && res.error) || '拉取失败');
    }
    supplierEditorModels = res.models || [];
    const prev = { ...supplierEditorEnabledModels };
    const prevModalities = { ...supplierEditorModelModalities };
    const prevTiers = { ...supplierEditorContextTierByModel };
    supplierEditorEnabledModels = {};
    supplierEditorModelModalities = {};
    supplierEditorContextTierByModel = {};
    for (const m of supplierEditorModels) {
      const id = String(m.id || '');
      if (!id) continue;
      supplierEditorEnabledModels[id] = prev[id] !== undefined ? prev[id] !== false : true;
      supplierEditorModelModalities[id] = editorModelModality(prevModalities[id]);
      if (prevTiers[id]) {
        supplierEditorContextTierByModel[id] = normalizeContextTierId(prevTiers[id]);
      }
    }
    const removed = res.removed || 0;
    let msg = `检测到 ${supplierEditorModels.length} 个可用模型`;
    if (removed > 0) msg += `（剔除 ${removed} 个不可用）`;
    setSupplierEditorDetectStatus(msg, true);
    renderSupplierEditorModelList();
  } catch (err) {
    supplierEditorModels = [];
    supplierEditorEnabledModels = {};
    supplierEditorModelModalities = {};
    renderSupplierEditorModelList();
    setSupplierEditorDetectStatus(`检测失败：${err.message || err}`, false);
  } finally {
    setSupplierEditorDetecting(false);
  }
}

function openSupplierEditor(id) {
  setSupplierEditorDetecting(false);
  editingSupplierId = id || null;
  supplierEditorModels = [];
  supplierEditorEnabledModels = {};
  supplierEditorModelModalities = {};
  supplierEditorContextTier = 'default';
  supplierEditorContextTierByModel = {};
  const supplier = (settings.modelSuppliers || []).find((s) => s.id === id) || {
    name: '',
    baseUrl: '',
    apiKey: '',
    contextTier: 'default',
    enabledModels: {},
    modelModalities: {},
    contextTierByModel: {}
  };
  $('supplier-editor-title').textContent = id ? '编辑供应商' : '添加供应商';
  $('supplier-editor-name').value = supplier.name || '';
  $('supplier-editor-base-url').value = supplier.baseUrl || '';
  $('supplier-editor-api-key').value = supplier.apiKey || '';
  $('supplier-editor-user-agent').value = supplier.userAgent || '';
  $('supplier-editor-headers').value = headersToEditorText(supplier.headers);
  $('supplier-editor-delete').hidden = !id;
  supplierEditorEnabledModels = { ...(supplier.enabledModels || {}) };
  supplierEditorModelModalities = { ...(supplier.modelModalities || {}) };
  supplierEditorContextTier = normalizeContextTierId(supplier.contextTier);
  supplierEditorContextTierByModel = { ...(supplier.contextTierByModel || {}) };
  populateContextTierMenu(ensureSupplierEditorContextTierMenu(), supplierEditorContextTier);
  const savedIds = Object.keys(supplierEditorEnabledModels);
  supplierEditorModels = savedIds.map((modelId) => ({ id: modelId }));
  setSupplierEditorDetectStatus(
    savedIds.length
      ? `已载入 ${savedIds.length} 个已保存模型；需要刷新时再点「检测模型」。`
      : '尚未检测。可点「检测模型」拉取列表。'
  );
  renderSupplierEditorModelList();
  $('supplier-editor-overlay').hidden = false;
}

function closeSupplierEditor() {
  setSupplierEditorDetecting(false);
  $('supplier-editor-overlay').hidden = true;
  editingSupplierId = null;
  supplierEditorModels = [];
  supplierEditorEnabledModels = {};
  supplierEditorModelModalities = {};
  supplierEditorContextTier = 'default';
  supplierEditorContextTierByModel = {};
}

function saveSupplierFromEditor() {
  const { name, baseUrl, apiKey, userAgent } = collectSupplierEditorConfig();
  if (!baseUrl) return;
  // 格式写错时停下并提示，而不是静默丢弃用户刚填的内容
  const checkedHeaders = readHeadersFromEditorChecked('supplier-editor-headers');
  if (checkedHeaders.error) {
    setSupplierEditorDetectStatus(checkedHeaders.error, false);
    return;
  }
  const headers = checkedHeaders.headers;
  const contextTier = normalizeContextTierId(
    ensureSupplierEditorContextTierMenu()?.getValue() || supplierEditorContextTier
  );
  const enabledModels = {};
  const modelModalities = {};
  const contextTierByModel = {};
  for (const m of supplierEditorModels) {
    const modelId = String(m.id || '');
    if (!modelId) continue;
    enabledModels[modelId] = supplierEditorEnabledModels[modelId] !== false;
    modelModalities[modelId] = getSupplierEditorModelModality(modelId);
    const perTier = getSupplierEditorModelContextTier(modelId);
    if (perTier) contextTierByModel[modelId] = perTier;
  }
  for (const [modelId, enabled] of Object.entries(supplierEditorEnabledModels)) {
    if (!(modelId in enabledModels)) {
      enabledModels[modelId] = enabled !== false;
      modelModalities[modelId] = getSupplierEditorModelModality(modelId);
      const perTier = getSupplierEditorModelContextTier(modelId);
      if (perTier) contextTierByModel[modelId] = perTier;
    }
  }
  const suppliers = [...(settings.modelSuppliers || [])];
  const idx = suppliers.findIndex((s) => s.id === editingSupplierId);
  const next = {
    id: editingSupplierId || `supplier-${Date.now()}`,
    name,
    baseUrl,
    apiKey,
    contextTier,
    enabledModels,
    modelModalities,
    contextTierByModel
  };
  // 请求修饰字段按需落盘：未配置时保持配置干净，不写空对象
  if (userAgent) next.userAgent = userAgent;
  if (Object.keys(headers || {}).length) next.headers = headers;
  if (idx >= 0) suppliers[idx] = next;
  else suppliers.push(next);
  settings = normalizeSettings({ ...settings, modelSuppliers: suppliers });
  updateSettingsFromModelLists();
  renderSuppliersList();
  closeSupplierEditor();
}

function deleteSupplierFromEditor() {
  if (!editingSupplierId) return;
  const suppliers = (settings.modelSuppliers || []).filter((s) => s.id !== editingSupplierId);
  settings = normalizeSettings({ ...settings, modelSuppliers: suppliers });
  updateSettingsFromModelLists();
  renderSuppliersList();
  closeSupplierEditor();
}

function initSupplierEditor() {
  const addBtn = $('supplier-add');
  if (addBtn) addBtn.addEventListener('click', () => openSupplierEditor());
  const closeBtn = $('supplier-editor-close');
  const cancelBtn = $('supplier-editor-cancel');
  const deleteBtn = $('supplier-editor-delete');
  const detectBtn = $('supplier-editor-detect');
  const form = $('supplier-editor-form');
  if (closeBtn) closeBtn.addEventListener('click', closeSupplierEditor);
  if (cancelBtn) cancelBtn.addEventListener('click', closeSupplierEditor);
  if (deleteBtn) deleteBtn.addEventListener('click', deleteSupplierFromEditor);
  if (detectBtn) {
    detectBtn.addEventListener('click', () => {
      detectSupplierModelsForEditor().catch(() => {});
    });
  }
  if (form) {
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      saveSupplierFromEditor();
    });
  }
  renderSuppliersList();
}

function openDefinedModelEditor(id) {
  editingDefinedModelId = id || null;
  const model = settings.customModels.find((m) => m.id === id) || {
    name: '',
    baseUrl: settings.baseUrl || '',
    apiKey: '',
    // 新加的模型默认「全模态」（ModelCapabilities.DEFAULT_MODALITY），不是文本
    modalitySetting: window.ModelCapabilities?.DEFAULT_MODALITY || 'vision',
    contextTier: ''
  };
  $('defined-model-editor-title').textContent = id ? '编辑模型' : '添加模型';
  $('defined-model-editor-name').value = model.name || '';
  $('defined-model-editor-base-url').value = model.baseUrl || '';
  $('defined-model-editor-api-key').value = model.apiKey || '';
  $('defined-model-editor-user-agent').value = model.userAgent || '';
  $('defined-model-editor-headers').value = headersToEditorText(model.headers);
  const voiceInput = $('defined-model-editor-voice');
  if (voiceInput) voiceInput.value = model.voice || '';
  const windowInput = $('defined-model-editor-context-window');
  if (windowInput) windowInput.value = model.contextWindow ? String(model.contextWindow) : '';
  populateContextTierMenu(ensureDefinedModelEditorContextTierMenu(), model.contextTier || '', {
    includeAutoInfer: true
  });
  const modalitySetting =
    window.ModelCapabilities?.normalizeModalitySetting(model.modalitySetting, model.kind) || 'text';
  setDefinedModelEditorModality(modalitySetting);
  $('defined-model-editor-delete').hidden = !id;
  setDefinedModelTestStatus('');
  $('defined-model-editor-overlay').hidden = false;
}

function closeDefinedModelEditor() {
  $('defined-model-editor-overlay').hidden = true;
  editingDefinedModelId = null;
}

function resolveChatCompletionsEndpointForTest(baseUrl) {
  // 端点拼接单一来源 llm-request（与 Main 侧同一份实现）
  return window.LlmRequest.resolveLlmEndpoint(baseUrl, 'chat');
}

function collectDefinedModelEditorConfig() {
  const contextTier = String(ensureDefinedModelEditorContextTierMenu()?.getValue() || '').trim();
  return {
    name: $('defined-model-editor-name').value.trim(),
    baseUrl: $('defined-model-editor-base-url').value.trim(),
    apiKey: $('defined-model-editor-api-key').value.trim(),
    modalitySetting: getDefinedModelEditorModality(),
    contextTier: contextTier ? normalizeContextTierId(contextTier) : '',
    contextWindow: String($('defined-model-editor-context-window')?.value || '').trim(),
    userAgent: ($('defined-model-editor-user-agent')?.value || '').trim(),
    voice: ($('defined-model-editor-voice')?.value || '').trim(),
    headers: readHeadersFromEditor('defined-model-editor-headers')
  };
}

function setDefinedModelTestStatus(text, ok) {
  const el = $('defined-model-editor-test-status');
  if (!el) return;
  el.textContent = text || '';
  el.classList.toggle('ok', ok === true);
  el.classList.toggle('warn', ok === false);
}

/**
 * 模型编辑器里的「测试」。
 *
 * 按声明模态分流 —— 以前这里对任何模态都发 `chat/completions` + 一条 user 消息，
 * 于是「语音」档位永远失败，且报的还是服务端的话（`Param Incorrect`），
 * 用户根本看不出是自己选错了档位还是端点填错了。实测 TTS 模型的要求是
 * `messages` 里必须有 assistant 角色，所以：
 *   - 文本 / 全模态：探针与原逻辑一致（一条 user 消息，要它回 OK）；
 *   - 语音合成（tts）：**走真实 RPC** `speech.synthesize`（同一份请求体与请求头，
 *     不再手抄第二份），拿回音频即视为通过；
 *   - 语音转写（speech）：转写端点只吃音频，文字探针无法验证 —— 明确说明，
 *     而不是发一个注定 400 的 chat 请求。
 */
async function testDefinedModelFromEditor() {
  const btn = $('defined-model-editor-test');
  const cfg = collectDefinedModelEditorConfig();
  if (!cfg.name || !cfg.baseUrl) {
    setDefinedModelTestStatus('请先填写模型名称和接口地址', false);
    return;
  }
  const modality = cfg.modalitySetting;
  if (modality === 'speech') {
    // 转写档位以前只能提示「请自己去点麦克风」。现在用一段静音样片走真实转写请求：
    // 能测出端点是否存在（404）/ 参数形态（422）/ 鉴权，且不需要麦克风。
    if (btn) btn.disabled = true;
    setDefinedModelTestStatus('测试中…');
    try {
      const res = await gatewayCall('speech.transcribe_probe', {
        model: cfg.name,
        baseUrl: cfg.baseUrl,
        apiKey: cfg.apiKey,
        language: typeof getSpeechLanguage === 'function' ? getSpeechLanguage() : undefined,
        headers: cfg.headers,
        userAgent: cfg.userAgent
      });
      setDefinedModelTestStatus(
        res?.silent
          ? '测试通过：转写端点可用（样片是静音，所以没有文字）'
          : `测试通过：${String(res?.text || '').trim().slice(0, 30)}`,
        true
      );
    } catch (err) {
      setDefinedModelTestStatus(`测试失败：${err.message || err}`, false);
    } finally {
      if (btn) btn.disabled = false;
    }
    return;
  }
  if (btn) btn.disabled = true;
  setDefinedModelTestStatus('测试中…');
  try {
    if (modality === 'tts') {
      const res = await gatewayCall('speech.synthesize', {
        text: '叠云语音合成测试。',
        model: cfg.name,
        baseUrl: cfg.baseUrl,
        apiKey: cfg.apiKey,
        voice: cfg.voice,
        headers: cfg.headers,
        userAgent: cfg.userAgent,
        sessionId: currentSessionId
      });
      const kb = Math.max(1, Math.round(((res?.audioBase64 || '').length * 3) / 4 / 1024));
      setDefinedModelTestStatus(`测试通过：合成 ${res?.format || '音频'}，约 ${kb} KB`, true);
      return;
    }
    const url = resolveChatCompletionsEndpointForTest(cfg.baseUrl);
    // 测试连接必须与真实请求用同一套头，否则会出现「测试通过但聊天 400」
    const headers = buildHeadersFromConfigLoose(cfg, { sessionId: currentSessionId });
    const body = {
      model: cfg.name,
      messages: [{ role: 'user', content: '叠云模型连接测试。请只回复 OK。' }],
      temperature: 0,
      max_tokens: 16
    };
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body)
    });
    const raw = await res.text();
    let json = null;
    try {
      json = raw ? JSON.parse(raw) : null;
    } catch {
      throw new Error(`响应非 JSON：${raw.slice(0, 160)}`);
    }
    if (!res.ok || json?.error) {
      throw new Error(json?.error?.message || json?.message || raw.slice(0, 200) || res.statusText);
    }
    const content =
      json?.choices?.[0]?.message?.content ||
      json?.choices?.[0]?.delta?.content ||
      json?.choices?.[0]?.text ||
      '';
    // 服务端把音频放在 message.audio 里 = 这是个语音模型；填成文本/全模态档位用不了
    if (json?.choices?.[0]?.message?.audio) {
      setDefinedModelTestStatus(
        '测试通过，但它返回的是音频：这是语音合成模型，请把模型类型改成「语音合成」',
        true
      );
      return;
    }
    setDefinedModelTestStatus(content ? `测试通过：${String(content).trim().slice(0, 30)}` : '测试通过', true);
  } catch (err) {
    setDefinedModelTestStatus(`测试失败：${err.message || err}`, false);
  } finally {
    if (btn) btn.disabled = false;
  }
}

function saveDefinedModelFromEditor() {
  const { name, baseUrl, apiKey, modalitySetting, contextTier, contextWindow, userAgent, voice } =
    collectDefinedModelEditorConfig();
  if (!name || !baseUrl) return;
  // 格式写错时停下并提示，而不是静默丢弃用户刚填的内容
  const checkedHeaders = readHeadersFromEditorChecked('defined-model-editor-headers');
  if (checkedHeaders.error) {
    setDefinedModelTestStatus(checkedHeaders.error, false);
    return;
  }
  const headers = checkedHeaders.headers;
  const models = [...(settings.customModels || [])];
  const idx = models.findIndex((m) => m.id === editingDefinedModelId);
  const next = {
    id: editingDefinedModelId || `model-${Date.now()}`,
    name,
    baseUrl,
    apiKey,
    modalitySetting: window.ModelCapabilities?.normalizeModalitySetting(modalitySetting) || 'text'
  };
  if (contextTier) next.contextTier = contextTier;
  const ownWindow = Math.floor(Number(contextWindow));
  if (Number.isFinite(ownWindow) && ownWindow >= 8192) next.contextWindow = ownWindow;
  next.kind = window.ModelCapabilities?.effectiveCustomModelKind(next) || 'text';
  // 请求修饰字段按需落盘：未配置时保持配置干净，不写空对象
  if (userAgent) next.userAgent = userAgent;
  if (Object.keys(headers || {}).length) next.headers = headers;
  // 音色只属于语音合成模型：留空 = 用服务端默认音色（各服务端的音色名互不通用，
  // 硬塞一个 OpenAI 的 alloy 会让只认自家音色名的服务端直接 400）
  if (next.kind === 'tts' && voice) next.voice = voice;
  if (idx >= 0) models[idx] = next;
  else models.push(next);
  settings = normalizeSettings({ ...settings, customModels: models });
  updateSettingsFromModelLists();
  renderDefinedModelsList();
  closeDefinedModelEditor();
}

function deleteDefinedModelFromEditor() {
  if (!editingDefinedModelId) return;
  const models = (settings.customModels || []).filter((m) => m.id !== editingDefinedModelId);
  settings = normalizeSettings({ ...settings, customModels: models });
  updateSettingsFromModelLists();
  renderDefinedModelsList();
  closeDefinedModelEditor();
}

function openEmbeddingModelEditor(id) {
  editingEmbeddingModelId = id || null;
  const model = settings.embeddingModels.find((m) => m.id === id) || {
    name: '',
    baseUrl: '',
    apiKey: '',
    dimensions: settings.embeddingDimensions || DEFAULTS.embeddingDimensions,
    active: false
  };
  $('embedding-model-editor-title').textContent = id ? '编辑向量模型' : '添加向量模型';
  $('embedding-model-editor-name').value = model.name || '';
  $('embedding-model-editor-base-url').value = model.baseUrl || '';
  $('embedding-model-editor-api-key').value = model.apiKey || '';
  $('embedding-model-editor-api-key').placeholder = 'sk-...';
  $('embedding-model-editor-dimensions').value = model.dimensions || DEFAULTS.embeddingDimensions;
  $('embedding-model-editor-active').checked = model.active === true;
  $('embedding-model-editor-delete').hidden = !id;
  setEmbeddingTestStatus('');
  $('embedding-model-editor-overlay').hidden = false;
}

function closeEmbeddingModelEditor() {
  $('embedding-model-editor-overlay').hidden = true;
  editingEmbeddingModelId = null;
  ['embedding-model-editor-name', 'embedding-model-editor-base-url', 'embedding-model-editor-api-key', 'embedding-model-editor-dimensions'].forEach((id) => {
    const el = $(id);
    if (el) el.readOnly = false;
  });
}

function resolveEmbeddingEndpointForTest(baseUrl) {
  // 端点拼接单一来源 llm-request（含 /embed 直连写法）
  return window.LlmRequest.resolveLlmEndpoint(baseUrl, 'embeddings');
}

function isDirectEmbedEndpoint(baseUrl) {
  return /\/embed$/i.test(String(baseUrl || '').trim().replace(/\/+$/, ''));
}

function collectEmbeddingEditorConfig() {
  return {
    name: $('embedding-model-editor-name').value.trim(),
    baseUrl: $('embedding-model-editor-base-url').value.trim(),
    apiKey: $('embedding-model-editor-api-key').value.trim(),
    dimensions: Math.min(
      EMBEDDING_DIMENSIONS_MAX,
      Math.max(EMBEDDING_DIMENSIONS_MIN, Number($('embedding-model-editor-dimensions').value) || DEFAULTS.embeddingDimensions)
    )
  };
}

/** 测试成功后把服务端**实际返回**的向量长度写进维度输入框（口径与保存时一致：同一上下限）。 */
function fillTestedEmbeddingDimensions(length) {
  const n = Math.min(
    EMBEDDING_DIMENSIONS_MAX,
    Math.max(EMBEDDING_DIMENSIONS_MIN, Number(length) || DEFAULTS.embeddingDimensions)
  );
  const el = $('embedding-model-editor-dimensions');
  if (el) el.value = String(n);
  return n;
}

function setEmbeddingTestStatus(text, ok) {
  const el = $('embedding-model-editor-test-status');
  if (!el) return;
  el.textContent = text || '';
  el.classList.toggle('ok', ok === true);
  el.classList.toggle('warn', ok === false);
}

async function testEmbeddingModelFromEditor() {
  const btn = $('embedding-model-editor-test');
  const cfg = collectEmbeddingEditorConfig();
  if (!cfg.name || !cfg.baseUrl) {
    setEmbeddingTestStatus('请先填写模型名称和接口地址', false);
    return;
  }
  const url = resolveEmbeddingEndpointForTest(cfg.baseUrl);
  const headers = buildHeadersFromConfigLoose(cfg);
  const body = isDirectEmbedEndpoint(cfg.baseUrl)
    ? {
        texts: ['叠云向量模型测试'],
        model: cfg.name,
        dimensions: cfg.dimensions
      }
    : {
        model: cfg.name,
        input: '叠云向量模型测试',
        dimensions: cfg.dimensions
      };
  if (btn) btn.disabled = true;
  setEmbeddingTestStatus('测试中…');
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body)
    });
    const raw = await res.text();
    let json = null;
    try {
      json = raw ? JSON.parse(raw) : null;
    } catch {
      throw new Error(`响应非 JSON：${raw.slice(0, 160)}`);
    }
    if (!res.ok || json?.error) {
      throw new Error(json?.error?.message || json?.message || raw.slice(0, 200) || res.statusText);
    }
    const vec =
      json?.data?.[0]?.embedding ||
      json?.embeddings?.[0] ||
      json?.vectors?.[0] ||
      json?.embedding ||
      json?.vector;
    if (!Array.isArray(vec) || !vec.length) throw new Error('响应中没有向量数据');
    // 维度是硬约束（库里的向量必须与设置一致），而手填的默认 1024 常常是多打一位的猜测：
    // 测试即测量 —— 返回长度直接填回输入框，用户不必再凭文档猜数字。
    const filled = fillTestedEmbeddingDimensions(vec.length);
    setEmbeddingTestStatus(
      filled === vec.length
        ? `测试通过，维度 ${vec.length}（已填入）`
        : `测试通过，维度 ${vec.length}（超出 ${EMBEDDING_DIMENSIONS_MIN}-${EMBEDDING_DIMENSIONS_MAX}，已填 ${filled}）`,
      true
    );
  } catch (err) {
    setEmbeddingTestStatus(`测试失败：${err.message || err}`, false);
  } finally {
    if (btn) btn.disabled = false;
  }
}

function saveEmbeddingModelFromEditor() {
  const active = $('embedding-model-editor-active').checked;
  const { name, baseUrl, apiKey, dimensions } = collectEmbeddingEditorConfig();
  if (!name || !baseUrl) return;
  let models = [...(settings.embeddingModels || [])];
  const idx = models.findIndex((m) => m.id === editingEmbeddingModelId);
  if (active) models = models.map((m) => ({ ...m, active: false }));
  const next = {
    id: editingEmbeddingModelId || `embedding-${Date.now()}`,
    name,
    baseUrl,
    apiKey,
    dimensions,
    active
  };
  if (idx >= 0) models[idx] = next;
  else models.push(next);
  settings = normalizeSettings({ ...settings, embeddingModels: models });
  updateSettingsFromModelLists();
  renderEmbeddingModelsList();
  closeEmbeddingModelEditor();
}

function deleteEmbeddingModelFromEditor() {
  if (!editingEmbeddingModelId) return;
  const target = settings.embeddingModels.find((m) => m.id === editingEmbeddingModelId);
  if (!target) return;
  const models = (settings.embeddingModels || []).filter((m) => m.id !== editingEmbeddingModelId);
  settings = normalizeSettings({ ...settings, embeddingModels: models });
  updateSettingsFromModelLists();
  renderEmbeddingModelsList();
  closeEmbeddingModelEditor();
}

function initDefinedModelEditors() {
  $('defined-model-add').addEventListener('click', () => openDefinedModelEditor());
  $('defined-model-editor-close').addEventListener('click', closeDefinedModelEditor);
  $('defined-model-editor-cancel').addEventListener('click', closeDefinedModelEditor);
  $('defined-model-editor-delete').addEventListener('click', deleteDefinedModelFromEditor);
  $('defined-model-editor-test').addEventListener('click', () => {
    testDefinedModelFromEditor().catch(() => {});
  });
  document.querySelectorAll('#defined-model-editor-modality-tags .model-modality-tag').forEach((btn) => {
    btn.addEventListener('click', () => {
      setDefinedModelEditorModality(btn.dataset.modality);
    });
  });
  const autoReadToggle = $('tts-auto-read');
  if (autoReadToggle) {
    autoReadToggle.addEventListener('change', () => {
      settings = normalizeSettings({ ...settings, ttsAutoRead: autoReadToggle.checked === true });
      updateSettingsFromModelLists();
    });
  }
  $('defined-model-editor-form').addEventListener('submit', (e) => {
    e.preventDefault();
    saveDefinedModelFromEditor();
  });
  $('embedding-model-add').addEventListener('click', () => openEmbeddingModelEditor());
  $('embedding-model-editor-close').addEventListener('click', closeEmbeddingModelEditor);
  $('embedding-model-editor-cancel').addEventListener('click', closeEmbeddingModelEditor);
  $('embedding-model-editor-delete').addEventListener('click', deleteEmbeddingModelFromEditor);
  $('embedding-model-editor-test').addEventListener('click', () => {
    testEmbeddingModelFromEditor().catch(() => {});
  });
  $('embedding-model-editor-form').addEventListener('submit', (e) => {
    e.preventDefault();
    saveEmbeddingModelFromEditor();
  });
  renderDefinedModelsList();
  renderEmbeddingModelsList();
  initSupplierEditor();
}

window.getSpeechApiConfig = getSpeechApiConfig;
window.getModelRuntimeValues = getModelRuntimeValues;
window.setModelRuntimeValues = setModelRuntimeValues;
window.resetModelRuntimeValues = resetModelRuntimeValues;
window.applyModelRuntimePreset = applyModelRuntimePreset;
window.resolveContextTierId = resolveContextTierId;
window.getActiveRuntimeSettings = getActiveRuntimeSettings;
window.getEffectiveInputBudget = getEffectiveInputBudget;
window.getContextWindowTokens = getContextWindowTokens;
window.getMaxOutputTokens = getMaxOutputTokens;
window.getContextReserveTokens = getContextReserveTokens;
window.getCompactionTriggerRatio = getCompactionTriggerRatio;
window.getAgentToolCallLimitSetting = getAgentToolCallLimitSetting;
window.getAgentMaxRoundsSetting = getAgentMaxRoundsSetting;

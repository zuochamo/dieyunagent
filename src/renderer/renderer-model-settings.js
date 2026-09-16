/* global window, document, $, fetch, escapeHtml, openModelSettingsModal, renderComposerModelLists, renderSuppliersList, updateComposerModelTriggerLabel, refreshContextProgress, resetCompactionInstances, refreshComposerBuiltinModels, clearBuiltinModelsCache, migrateLegacyBuiltinEnabledToSuppliers, showAgentToast */
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
  if (cfg.visionModel) cfg.visionModel.value = s.visionModel || DEFAULTS.visionModel;
  if (cfg.visionBaseUrl) cfg.visionBaseUrl.value = s.visionBaseUrl || '';
  if (cfg.visionApiKey) cfg.visionApiKey.value = s.visionApiKey || '';
  if (cfg.system) cfg.system.value = s.system;
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

function populateContextTierSelect(selectEl, value, { includeInherit = false, includeAutoInfer = false } = {}) {
  if (!selectEl) return;
  selectEl.innerHTML = '';
  if (includeAutoInfer) {
    const autoOpt = document.createElement('option');
    autoOpt.value = '';
    autoOpt.textContent = '自动推断（按模型名）';
    selectEl.appendChild(autoOpt);
  }
  if (includeInherit) {
    const inheritOpt = document.createElement('option');
    inheritOpt.value = '';
    inheritOpt.textContent = '继承供应商默认';
    selectEl.appendChild(inheritOpt);
  }
  const presets =
    typeof window !== 'undefined' && window.MODEL_RUNTIME_PRESETS ? window.MODEL_RUNTIME_PRESETS : [];
  for (const preset of presets) {
    const opt = document.createElement('option');
    opt.value = preset.id;
    opt.textContent = preset.label;
    if (preset.hint) opt.title = preset.hint;
    selectEl.appendChild(opt);
  }
  selectEl.value = value || (includeInherit || includeAutoInfer ? '' : 'default');
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

function getSupplierEditorModelModality(modelId) {
  const id = String(modelId || '');
  return window.ModelCapabilities?.normalizeModalitySetting(supplierEditorModelModalities[id]) || 'text';
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
  for (const kind of window.ModelCapabilities?.MODALITY_OPTIONS || ['text', 'vision', 'speech']) {
    const label =
      kind === 'vision' ? '全模态' : kind === 'speech' ? '语音' : '文本';
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

var MODALITY_HINTS = {
  text: '用于对话与代码生成。发图时不会直接发送 image_url，需由标记为全模态的模型处理。',
  vision: '支持识图与 image_url 多模态输入，会出现在对话模型列表中。',
  speech: '用于语音转写（调用 /v1/audio/transcriptions），不会出现在对话模型列表。'
};

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
  const hint = $('defined-model-editor-modality-hint');
  if (hint) hint.textContent = MODALITY_HINTS[setting] || MODALITY_HINTS.text;
}

function renderDefinedModelModalityBadge(model) {
  const mc = window.ModelCapabilities;
  if (!mc) return '<span class="model-modality-badge text">—</span>';
  const info = mc.describeCustomModelModality(model);
  const cls = info.kind === 'vision' ? 'vision' : info.kind === 'speech' ? 'speech' : 'text';
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
      <span class="defined-model-value">${m.builtin ? '—' : escapeHtml(maskSecret(m.apiKey))}</span>
      <span class="defined-model-value">${escapeHtml(String(m.dimensions || DEFAULTS.embeddingDimensions))}</span>
      <span class="defined-model-value">${status}</span>
      <span class="defined-model-value"><button type="button" class="ghost-btn" data-edit-embedding="${escapeHtml(m.id)}">编辑</button></span>
    `;
    list.appendChild(row);
  }
  if (!models.some((m) => m.active)) {
    const hint = document.createElement('div');
    hint.className = 'defined-model-empty';
    hint.textContent = '默认使用内置 BGE 向量（需在设置 → 组件下载模型，约 100MB）。若仅需关键词匹配，可关闭全部向量模型。';
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
    const tierSelect = document.createElement('select');
    tierSelect.className = 'context-tier-select supplier-model-tier-select';
    tierSelect.title = 'Context 档位';
    populateContextTierSelect(tierSelect, getSupplierEditorModelContextTier(modelId), {
      includeInherit: true
    });
    tierSelect.addEventListener('change', () => {
      setSupplierEditorModelContextTier(modelId, tierSelect.value);
    });
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
    row.appendChild(tierSelect);
    row.appendChild(label);
    list.appendChild(row);
  }
}

function collectSupplierEditorConfig() {
  return {
    name: $('supplier-editor-name').value.trim(),
    baseUrl: $('supplier-editor-base-url').value.trim(),
    apiKey: $('supplier-editor-api-key').value.trim()
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
      supplierEditorModelModalities[id] =
        window.ModelCapabilities?.normalizeModalitySetting(prevModalities[id]) || 'text';
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
  $('supplier-editor-delete').hidden = !id;
  supplierEditorEnabledModels = { ...(supplier.enabledModels || {}) };
  supplierEditorModelModalities = { ...(supplier.modelModalities || {}) };
  supplierEditorContextTier = normalizeContextTierId(supplier.contextTier);
  supplierEditorContextTierByModel = { ...(supplier.contextTierByModel || {}) };
  populateContextTierSelect($('supplier-editor-context-tier'), supplierEditorContextTier);
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
  const { name, baseUrl, apiKey } = collectSupplierEditorConfig();
  if (!baseUrl) return;
  const tierSelect = $('supplier-editor-context-tier');
  const contextTier = normalizeContextTierId(tierSelect?.value || supplierEditorContextTier);
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
  const overlay = $('supplier-editor-overlay');
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
  if (overlay) {
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) closeSupplierEditor();
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
    modalitySetting: 'text',
    contextTier: ''
  };
  $('defined-model-editor-title').textContent = id ? '编辑模型' : '添加模型';
  $('defined-model-editor-name').value = model.name || '';
  $('defined-model-editor-base-url').value = model.baseUrl || '';
  $('defined-model-editor-api-key').value = model.apiKey || '';
  const windowInput = $('defined-model-editor-context-window');
  if (windowInput) windowInput.value = model.contextWindow ? String(model.contextWindow) : '';
  populateContextTierSelect($('defined-model-editor-context-tier'), model.contextTier || '', {
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
  return (
    window.ModelCapabilities?.resolveChatCompletionsEndpoint(baseUrl) ||
    (() => {
      const raw = String(baseUrl || '').trim().replace(/\/+$/, '');
      if (/\/chat\/completions$/i.test(raw)) return raw;
      if (/\/v1$/i.test(raw)) return `${raw}/chat/completions`;
      return `${raw}/v1/chat/completions`;
    })()
  );
}

function collectDefinedModelEditorConfig() {
  const tierSelect = $('defined-model-editor-context-tier');
  const contextTier = String(tierSelect?.value || '').trim();
  return {
    name: $('defined-model-editor-name').value.trim(),
    baseUrl: $('defined-model-editor-base-url').value.trim(),
    apiKey: $('defined-model-editor-api-key').value.trim(),
    modalitySetting: getDefinedModelEditorModality(),
    contextTier: contextTier ? normalizeContextTierId(contextTier) : '',
    contextWindow: String($('defined-model-editor-context-window')?.value || '').trim()
  };
}

function setDefinedModelTestStatus(text, ok) {
  const el = $('defined-model-editor-test-status');
  if (!el) return;
  el.textContent = text || '';
  el.classList.toggle('ok', ok === true);
  el.classList.toggle('warn', ok === false);
}

async function testDefinedModelFromEditor() {
  const btn = $('defined-model-editor-test');
  const cfg = collectDefinedModelEditorConfig();
  if (!cfg.name || !cfg.baseUrl) {
    setDefinedModelTestStatus('请先填写模型名称和接口地址', false);
    return;
  }
  const url = resolveChatCompletionsEndpointForTest(cfg.baseUrl);
  const headers = { 'Content-Type': 'application/json' };
  if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`;
  const body = {
    model: cfg.name,
    messages: [{ role: 'user', content: '叠云模型连接测试。请只回复 OK。' }],
    temperature: 0,
    max_tokens: 16
  };
  if (btn) btn.disabled = true;
  setDefinedModelTestStatus('测试中…');
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
    const content =
      json?.choices?.[0]?.message?.content ||
      json?.choices?.[0]?.delta?.content ||
      json?.choices?.[0]?.text ||
      '';
    setDefinedModelTestStatus(content ? `测试通过：${String(content).trim().slice(0, 30)}` : '测试通过', true);
  } catch (err) {
    setDefinedModelTestStatus(`测试失败：${err.message || err}`, false);
  } finally {
    if (btn) btn.disabled = false;
  }
}

function saveDefinedModelFromEditor() {
  const { name, baseUrl, apiKey, modalitySetting, contextTier, contextWindow } =
    collectDefinedModelEditorConfig();
  if (!name || !baseUrl) return;
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
    baseUrl: settings.embeddingBaseUrl || '',
    apiKey: '',
    dimensions: settings.embeddingDimensions || DEFAULTS.embeddingDimensions,
    active: false,
    builtin: false
  };
  const isBuiltin = isBuiltinEmbeddingListEntry(model);
  $('embedding-model-editor-title').textContent = id ? '编辑向量模型' : '添加向量模型';
  $('embedding-model-editor-name').value = model.name || '';
  $('embedding-model-editor-base-url').value = isBuiltin ? '内置' : model.baseUrl || '';
  $('embedding-model-editor-api-key').value = isBuiltin ? '' : model.apiKey || '';
  $('embedding-model-editor-api-key').placeholder = isBuiltin ? '—' : 'sk-...';
  $('embedding-model-editor-dimensions').value = model.dimensions || DEFAULTS.embeddingDimensions;
  $('embedding-model-editor-active').checked = model.active === true;
  $('embedding-model-editor-name').readOnly = isBuiltin;
  $('embedding-model-editor-base-url').readOnly = isBuiltin;
  $('embedding-model-editor-api-key').readOnly = isBuiltin;
  $('embedding-model-editor-dimensions').readOnly = isBuiltin;
  $('embedding-model-editor-delete').hidden = !id || isBuiltin;
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
  const raw = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (/\/(embeddings|embed)$/i.test(raw)) return raw;
  if (/\/v1$/i.test(raw)) return `${raw}/embeddings`;
  return `${raw}/v1/embeddings`;
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

function setEmbeddingTestStatus(text, ok) {
  const el = $('embedding-model-editor-test-status');
  if (!el) return;
  el.textContent = text || '';
  el.classList.toggle('ok', ok === true);
  el.classList.toggle('warn', ok === false);
}

async function testEmbeddingModelFromEditor() {
  const btn = $('embedding-model-editor-test');
  const existing = settings.embeddingModels.find((m) => m.id === editingEmbeddingModelId);
  if (isBuiltinEmbeddingListEntry(existing)) {
    const api = window.diecloud || {};
    if (!api.testBuiltinEmbedding) {
      setEmbeddingTestStatus('内置模型测试接口不可用', false);
      return;
    }
    if (btn) btn.disabled = true;
    setEmbeddingTestStatus('测试中…（首次加载模型可能较慢）');
    try {
      const r = await api.testBuiltinEmbedding();
      if (r && r.ok) {
        setEmbeddingTestStatus(`测试通过，维度 ${r.dimensions}`, true);
      } else {
        throw new Error((r && r.error) || '测试失败');
      }
    } catch (err) {
      setEmbeddingTestStatus(`测试失败：${err.message || err}`, false);
    } finally {
      if (btn) btn.disabled = false;
    }
    return;
  }
  const cfg = collectEmbeddingEditorConfig();
  if (!cfg.name || !cfg.baseUrl) {
    setEmbeddingTestStatus('请先填写模型名称和接口地址', false);
    return;
  }
  const url = resolveEmbeddingEndpointForTest(cfg.baseUrl);
  const headers = { 'Content-Type': 'application/json' };
  if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`;
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
    setEmbeddingTestStatus(`测试通过，维度 ${vec.length}`, true);
  } catch (err) {
    setEmbeddingTestStatus(`测试失败：${err.message || err}`, false);
  } finally {
    if (btn) btn.disabled = false;
  }
}

function saveEmbeddingModelFromEditor() {
  const existing = settings.embeddingModels.find((m) => m.id === editingEmbeddingModelId);
  const isBuiltin = isBuiltinEmbeddingListEntry(existing);
  const active = $('embedding-model-editor-active').checked;
  if (isBuiltin) {
    let models = [...(settings.embeddingModels || [])];
    if (active) models = models.map((m) => ({ ...m, active: false }));
    models = models.map((m) =>
      isBuiltinEmbeddingListEntry(m) ? { ...m, active } : m
    );
    settings = normalizeSettings({ ...settings, embeddingModels: models });
    updateSettingsFromModelLists();
    renderEmbeddingModelsList();
    closeEmbeddingModelEditor();
    return;
  }
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
  if (!target || isBuiltinEmbeddingListEntry(target)) return;
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
  $('defined-model-editor-overlay').addEventListener('click', (e) => {
    if (e.target === $('defined-model-editor-overlay')) closeDefinedModelEditor();
  });
  $('embedding-model-editor-overlay').addEventListener('click', (e) => {
    if (e.target === $('embedding-model-editor-overlay')) closeEmbeddingModelEditor();
  });
  renderDefinedModelsList();
  renderEmbeddingModelsList();
  initSupplierEditor();
}

function applyDeployUiDefaults(_deployUiDefaults) {}

window.applyDeployUiDefaults = applyDeployUiDefaults;
window.getSpeechApiConfig = getSpeechApiConfig;
window.getVisionApiConfig = getVisionApiConfig;
window.pickCustomVisionModel = pickCustomVisionModel;
window.pickVisionModel = pickCustomVisionModel;
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

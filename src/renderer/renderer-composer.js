/* global window, document, $, escapeHtml, settings, getBuiltinApiConfig, getCustomModelApiConfig, getTextModelId, openModelSettingsModal, pendingAttachments, isImageAttachment, gwState, currentSessionId, sessionActiveRuns, gatewayCall, refreshHistoryList, updateWorkspaceLabel, invalidateWorkspaceArtifacts, renderArtifactsList, initComposerPasteAndDrop, initComposerMentionMenu, initComposerVoice, addAttachmentsFromPaths, initWorkspacePicker, restartTerminalSession, isSupplierModelEnabled, getSupplierById, supplierDisplayName, renderSuppliersList, normalizeSettings, saveSettings, refreshRemoteGatewayMeta, resetRemoteGatewayClient, resetCodebaseWarmCache, ensureDefaultWorkspaceEditor, refreshWikiPanelIfNeeded, isActiveSessionSwitch */
const composerApi = window.diecloud || {};

// ---------- 输入区模型选择 ----------
const COMPOSER_MODEL_KEY = 'diecloud.composer.model.v1';
const COMPOSER_MODEL_BY_SESSION_KEY = 'dieyun.composer.modelBySession.v1';
const COMPOSER_MODEL_CACHE_KEY = 'diecloud.composer.builtin.cache.v2';
const COMPOSER_BUILTIN_ENABLED_KEY = 'diecloud.composer.builtin.enabled.v1';
const BUILTIN_DETECT_INTERVAL_MS = 12 * 60 * 60 * 1000;
const COMPOSER_MODEL_CACHE_TTL_MS = BUILTIN_DETECT_INTERVAL_MS;
const COMPOSER_MODEL_CACHE_ENDPOINT_KEY = 'diecloud.composer.builtin.cache.endpoint.v1';
const COMPOSER_AGENT_MODE_KEY = 'dieyun.composer.agentMode.v1';
const COMPOSER_AGENT_MODE_BY_SESSION_KEY = 'dieyun.composer.agentModeBySession.v1';

/** @type {Map<string, { autoMode: boolean, selection: string }>} */
const sessionComposerModelPicks = new Map();

/** @type {Map<string, 'agent' | 'plan' | 'explore'>} */
const sessionComposerAgentModes = new Map();
let composerAgentMode = 'agent';
let composerAgentModeMenuOpen = false;

function normalizeComposerAgentMode(mode) {
  return mode === 'plan' || mode === 'explore' ? mode : 'agent';
}

function composerAgentModeLabel(mode) {
  if (mode === 'plan') return 'Plan';
  if (mode === 'explore') return 'Explore';
  return 'Agent';
}

function setComposerAgentModeMenuOpen(open) {
  composerAgentModeMenuOpen = !!open;
  const menu = $('composer-agent-mode-menu');
  const trigger = $('composer-agent-mode-trigger');
  if (menu) menu.hidden = !composerAgentModeMenuOpen;
  if (trigger) trigger.setAttribute('aria-expanded', composerAgentModeMenuOpen ? 'true' : 'false');
}

function readSessionComposerModesFromStorage() {
  try {
    const raw = window.localStorage.getItem(COMPOSER_AGENT_MODE_BY_SESSION_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function persistSessionComposerModes() {
  try {
    const obj = {};
    for (const [sid, mode] of sessionComposerAgentModes.entries()) {
      obj[sid] = normalizeComposerAgentMode(mode);
    }
    window.localStorage.setItem(COMPOSER_AGENT_MODE_BY_SESSION_KEY, JSON.stringify(obj));
  } catch {
    // ignore
  }
}

function loadComposerAgentModeForSession(sessionId) {
  const sid = String(sessionId || currentSessionId || '').trim();
  if (!sid) return 'agent';
  if (sessionComposerAgentModes.has(sid)) {
    return normalizeComposerAgentMode(sessionComposerAgentModes.get(sid));
  }
  const stored = readSessionComposerModesFromStorage();
  const mode = normalizeComposerAgentMode(stored[sid]);
  sessionComposerAgentModes.set(sid, mode);
  return mode;
}

function loadComposerAgentMode() {
  try {
    const raw = window.localStorage.getItem(COMPOSER_AGENT_MODE_KEY);
    return normalizeComposerAgentMode(raw);
  } catch {
    return 'agent';
  }
}

function saveComposerAgentMode(mode, sessionId) {
  const sid = String(sessionId || currentSessionId || '').trim();
  const next = normalizeComposerAgentMode(mode);
  composerAgentMode = next;
  if (sid) {
    sessionComposerAgentModes.set(sid, next);
    persistSessionComposerModes();
  } else {
    try {
      window.localStorage.setItem(COMPOSER_AGENT_MODE_KEY, next);
    } catch {
      // ignore
    }
  }
  syncComposerAgentModeUI();
}

function getComposerAgentMode(sessionId) {
  if (sessionId != null && String(sessionId).trim()) {
    return loadComposerAgentModeForSession(String(sessionId).trim());
  }
  return normalizeComposerAgentMode(composerAgentMode);
}

function activateComposerAgentModeForSession(sessionId) {
  composerAgentMode = loadComposerAgentModeForSession(sessionId);
  syncComposerAgentModeUI();
}

function cleanupSessionComposerAgentMode(sessionId) {
  const sid = String(sessionId || '').trim();
  if (!sid) return;
  sessionComposerAgentModes.delete(sid);
  persistSessionComposerModes();
}

function syncComposerAgentModeUI() {
  const mode = getComposerAgentMode();
  const label = $('composer-agent-mode-label');
  if (label) label.textContent = composerAgentModeLabel(mode);
  const menu = $('composer-agent-mode-menu');
  if (menu) {
    for (const item of menu.querySelectorAll('[data-agent-mode]')) {
      const active = item.getAttribute('data-agent-mode') === mode;
      item.classList.toggle('active', active);
    }
  }
}

function initComposerAgentMode() {
  composerAgentMode = loadComposerAgentMode();
  if (currentSessionId) {
    composerAgentMode = loadComposerAgentModeForSession(currentSessionId);
  }
  syncComposerAgentModeUI();
  const wrap = $('composer-agent-mode-wrap');
  const trigger = $('composer-agent-mode-trigger');
  const menu = $('composer-agent-mode-menu');
  if (!wrap || !trigger || !menu) return;

  trigger.addEventListener('click', (e) => {
    e.stopPropagation();
    setComposerAgentModeMenuOpen(!composerAgentModeMenuOpen);
  });

  menu.addEventListener('click', (e) => {
    const item = e.target.closest('[data-agent-mode]');
    if (!item) return;
    const mode = item.getAttribute('data-agent-mode');
    if (mode !== 'agent' && mode !== 'plan' && mode !== 'explore') return;
    saveComposerAgentMode(mode);
    setComposerAgentModeMenuOpen(false);
  });

  document.addEventListener('click', (e) => {
    if (!composerAgentModeMenuOpen) return;
    if (!wrap.contains(e.target)) setComposerAgentModeMenuOpen(false);
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && composerAgentModeMenuOpen) setComposerAgentModeMenuOpen(false);
  });
}

const composerModelState = {
  menuOpen: false,
  loadingBuiltin: false,
  builtinModels: [],
  builtinError: '',
  builtinMeta: null,
  builtinLastDetectAt: 0,
  pick: {
    autoMode: true,
    selection: 'auto'
  }
};

function normalizeComposerModelPick(pick) {
  return {
    autoMode: pick?.autoMode !== false,
    selection: pick?.selection || (pick?.autoMode !== false ? 'auto' : 'builtin:default')
  };
}

function readSessionComposerModelsFromStorage() {
  try {
    const raw = window.localStorage.getItem(COMPOSER_MODEL_BY_SESSION_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function persistSessionComposerModels() {
  try {
    const obj = {};
    for (const [sid, pick] of sessionComposerModelPicks.entries()) {
      obj[sid] = normalizeComposerModelPick(pick);
    }
    window.localStorage.setItem(COMPOSER_MODEL_BY_SESSION_KEY, JSON.stringify(obj));
  } catch {
    // ignore
  }
}

function loadComposerModelPickLegacy() {
  try {
    const raw = window.localStorage.getItem(COMPOSER_MODEL_KEY);
    if (!raw) return normalizeComposerModelPick(composerModelState.pick);
    return normalizeComposerModelPick(JSON.parse(raw));
  } catch {
    return normalizeComposerModelPick(composerModelState.pick);
  }
}

function loadComposerModelPickForSession(sessionId) {
  const sid = String(sessionId || currentSessionId || '').trim();
  if (!sid) return loadComposerModelPickLegacy();
  if (sessionComposerModelPicks.has(sid)) {
    return { ...sessionComposerModelPicks.get(sid) };
  }
  const stored = readSessionComposerModelsFromStorage();
  if (stored[sid]) {
    const pick = normalizeComposerModelPick(stored[sid]);
    sessionComposerModelPicks.set(sid, pick);
    return { ...pick };
  }
  return loadComposerModelPickLegacy();
}

function loadComposerModelPick() {
  return loadComposerModelPickForSession(currentSessionId);
}

function saveComposerModelPick(pick, sessionId) {
  const sid = String(sessionId || currentSessionId || '').trim();
  const normalized = normalizeComposerModelPick(pick);
  composerModelState.pick = { ...normalized };
  if (sid) {
    sessionComposerModelPicks.set(sid, { ...normalized });
    persistSessionComposerModels();
  } else {
    try {
      window.localStorage.setItem(COMPOSER_MODEL_KEY, JSON.stringify(normalized));
    } catch {
      // ignore
    }
  }
  updateComposerModelTriggerLabel();
  renderComposerModelLists();
  if (typeof resolveContextTierId === 'function') {
    const tierId = resolveContextTierId({ sessionId: sid || undefined });
    window.dispatchEvent(
      new CustomEvent('dieyun:context-tier-change', {
        detail: { contextTierId: tierId, sessionId: sid }
      })
    );
    if (typeof refreshContextProgress === 'function') refreshContextProgress();
  }
}

function activateComposerModelForSession(sessionId) {
  composerModelState.pick = loadComposerModelPickForSession(sessionId);
  updateComposerModelTriggerLabel();
  renderComposerModelLists();
  ensureComposerModelPickValid();
  if (typeof resolveContextTierId === 'function') {
    const tierId = resolveContextTierId({ sessionId });
    window.dispatchEvent(
      new CustomEvent('dieyun:context-tier-change', {
        detail: { contextTierId: tierId, sessionId: String(sessionId || '') }
      })
    );
    if (typeof refreshContextProgress === 'function') refreshContextProgress();
  }
}

function cleanupSessionComposerModelPick(sessionId) {
  const sid = String(sessionId || '').trim();
  if (!sid) return;
  sessionComposerModelPicks.delete(sid);
  persistSessionComposerModels();
}

function resolveComposerModelPickForSend(sessionId) {
  if (sessionId != null && String(sessionId).trim()) {
    return loadComposerModelPickForSession(String(sessionId).trim());
  }
  return composerModelState.pick;
}

function builtinRouteKey(supplierId, modelId) {
  return `builtin:${supplierId}:${modelId}`;
}

function parseBuiltinRoute(route) {
  const sel = String(route || '');
  if (!sel.startsWith('builtin:')) return null;
  const rest = sel.slice('builtin:'.length);
  const idx = rest.indexOf(':');
  if (idx <= 0) return { supplierId: null, modelId: rest };
  return { supplierId: rest.slice(0, idx), modelId: rest.slice(idx + 1) };
}

function suppliersCacheFingerprint() {
  return (settings.modelSuppliers || [])
    .map((s) => `${s.id}:${(s.baseUrl || '').trim()}::${String(s.apiKey || '').slice(0, 8)}`)
    .join('|');
}

function builtinModelsCacheEndpointKey() {
  return suppliersCacheFingerprint();
}

function loadBuiltinModelsCache() {
  try {
    const raw = window.localStorage.getItem(COMPOSER_MODEL_CACHE_KEY);
    if (!raw) return null;
    const c = JSON.parse(raw);
    if (
      !c ||
      !c.suppliers ||
      typeof c.suppliers !== 'object' ||
      Date.now() - (c.at || 0) > COMPOSER_MODEL_CACHE_TTL_MS ||
      (c.fingerprint || '') !== suppliersCacheFingerprint()
    ) {
      return null;
    }
    return c.suppliers;
  } catch {
    return null;
  }
}

function flattenCachedBuiltinModels(bySupplier) {
  const out = [];
  for (const supplier of settings.modelSuppliers || []) {
    const models = bySupplier[supplier.id];
    if (!Array.isArray(models)) continue;
    for (const m of models) {
      if (!m || !m.id) continue;
      out.push({
        id: m.id,
        supplierId: supplier.id,
        supplierName: supplierDisplayName(supplier),
        routeKey: builtinRouteKey(supplier.id, m.id)
      });
    }
  }
  return out;
}

function saveBuiltinModelsCache(bySupplier) {
  try {
    window.localStorage.setItem(
      COMPOSER_MODEL_CACHE_KEY,
      JSON.stringify({
        at: Date.now(),
        fingerprint: suppliersCacheFingerprint(),
        suppliers: bySupplier || {}
      })
    );
  } catch {
    // ignore
  }
}

function clearBuiltinModelsCache() {
  try {
    window.localStorage.removeItem(COMPOSER_MODEL_CACHE_KEY);
    window.localStorage.removeItem('diecloud.composer.builtin.cache.v1');
    window.localStorage.removeItem(COMPOSER_MODEL_CACHE_ENDPOINT_KEY);
  } catch {
    // ignore
  }
}

function migrateLegacyBuiltinEnabledToSuppliers() {
  try {
    const raw = window.localStorage.getItem(COMPOSER_BUILTIN_ENABLED_KEY);
    if (!raw) return;
    const map = JSON.parse(raw);
    if (!map || typeof map !== 'object' || !Object.keys(map).length) {
      window.localStorage.removeItem(COMPOSER_BUILTIN_ENABLED_KEY);
      return;
    }
    const suppliers = settings.modelSuppliers || [];
    if (!suppliers.length) return;
    const first = suppliers[0];
    const existing = first.enabledModels || {};
    if (!Object.keys(existing).length) {
      first.enabledModels = { ...map };
      settings = normalizeSettings({ ...settings, modelSuppliers: suppliers });
      saveSettings(settings);
    }
    window.localStorage.removeItem(COMPOSER_BUILTIN_ENABLED_KEY);
  } catch {
    // ignore
  }
}

function getEnabledBuiltinModels() {
  return (composerModelState.builtinModels || []).filter((m) => {
    const supplier = getSupplierById(m.supplierId);
    return supplier && isSupplierModelEnabled(supplier, m.id);
  });
}

function getModelCandidatesForAuto(context = {}) {
  const builtins = getEnabledBuiltinModels().map((m) => {
    const supplier = getSupplierById(m.supplierId);
    const kind = window.ModelCapabilities?.getSupplierModelModality(supplier, m.id) || 'text';
    return {
      source: 'builtin',
      id: m.id,
      model: m.id,
      kind,
      apiConfig: getBuiltinApiConfig(m.supplierId),
      route: m.routeKey || builtinRouteKey(m.supplierId, m.id)
    };
  });
  const custom = (settings.customModels || []).map((m) => ({
    source: 'custom',
    id: m.id,
    model: m.name,
    kind:
      m.kind === 'vision' ? 'vision' : m.kind === 'speech' ? 'speech' : 'text',
    apiConfig: {
      baseUrl: m.baseUrl || '',
      apiKey: m.apiKey || ''
    },
    route: `custom:${m.id}`
  }));
  const candidates = builtins
    .concat(custom)
    .filter((m) => m.model && m.apiConfig.baseUrl && m.kind !== 'speech');
  if (!context.needsVision) {
    return candidates.filter((m) => m.kind !== 'vision').concat(
      candidates.filter((m) => m.kind === 'vision')
    );
  }
  const visionFirst = candidates.filter((m) => m.kind === 'vision');
  const rest = candidates.filter((m) => m.kind !== 'vision');
  return visionFirst.concat(rest);
}

function pickBuiltinModelForContext(context) {
  const enabled = getEnabledBuiltinModels();
  if (!enabled.length) return '';
  return pickAutoBuiltinModelId(enabled, context);
}

function pickAnyModelForContext(context) {
  const candidates = getModelCandidatesForAuto(context);
  if (!candidates.length) {
    const model = getTextModelId(settings);
    return {
      model,
      route: model ? 'custom-text' : 'default',
      apiConfig: getCustomModelApiConfig('custom-text')
    };
  }
  const pickedName = pickAutoBuiltinModelId(
    candidates.map((m) => ({ id: m.model })),
    context
  );
  return candidates.find((m) => m.model === pickedName) || candidates[0];
}

function builtinModelsFromSavedSuppliers() {
  const out = [];
  for (const supplier of settings.modelSuppliers || []) {
    const map =
      supplier && supplier.enabledModels && typeof supplier.enabledModels === 'object'
        ? supplier.enabledModels
        : {};
    for (const id of Object.keys(map)) {
      if (!id) continue;
      out.push({
        id,
        supplierId: supplier.id,
        supplierName: supplierDisplayName(supplier),
        routeKey: builtinRouteKey(supplier.id, id)
      });
    }
  }
  return out;
}

function formatBuiltinDetectMeta() {
  if (composerModelState.loadingBuiltin) return '正在检测可用模型…';
  if (composerModelState.builtinError) return composerModelState.builtinError;
  const n = getEnabledBuiltinModels().length;
  const total = (composerModelState.builtinModels || []).length;
  const at = composerModelState.builtinLastDetectAt;
  const timeStr = at ? new Date(at).toLocaleString('zh-CN') : '—';
  let s = `共 ${total} 个可用，已启用 ${n} 个 · 上次检测 ${timeStr}`;
  if (composerModelState.builtinMeta && composerModelState.builtinMeta.removed > 0) {
    s += `（剔除 ${composerModelState.builtinMeta.removed} 个不可用）`;
  }
  return s;
}

function builtinModelPickerLabel(m) {
  const dup =
    (composerModelState.builtinModels || []).filter((x) => x.id === m.id).length > 1;
  if (dup && m.supplierName) return `${m.supplierName} / ${m.id}`;
  return m.id;
}

function attachmentNeedsVision() {
  return getPendingAttachments().some((a) => isImageAttachment(a));
}

function modelSupportsMultimodal(model, route) {
  if (window.ModelCapabilities?.modelSupportsMultimodalInSettings) {
    return window.ModelCapabilities.modelSupportsMultimodalInSettings(settings, model, route);
  }
  const id = String(model || '').trim();
  if (!id) return false;
  const routeStr = String(route || '');
  if (/^custom-vision|^auto-vision|custom:vision/.test(routeStr)) return true;
  const custom = (settings.customModels || []).find((m) => m && (m.name === id || m.id === id));
  if (custom) {
    return (
      window.ModelCapabilities?.customModelSupportsMultimodal(custom) === true || custom.kind === 'vision'
    );
  }
  return false;
}

function scoreMessageComplexity(text) {
  const t = String(text || '');
  if (t.length > 2500) return 2;
  if (t.length > 1200) return 1;
  if (/```[\s\S]*```/.test(t)) return 2;
  if (/\b(class |function |import |def |async |SELECT |CREATE TABLE)\b/i.test(t)) return 1;
  return 0;
}

function pickAutoBuiltinModelId(models, context) {
  const ids = (models || []).map((m) => m.id).filter(Boolean);
  if (!ids.length) return getTextModelId(settings) || '';

  const findFirst = (patterns) => {
    for (const re of patterns) {
      const hit = ids.find((id) => re.test(id));
      if (hit) return hit;
    }
    return null;
  };

  if (context.needsVision) {
    return (
      findFirst([/vision/i, /vl/i, /4o/i, /multimodal/i, /glm-4v/i, /qwen.*vl/i]) || ids[0]
    );
  }

  if (context.complex >= 2) {
    return (
      findFirst([
        /deepseek.*v[34]/i,
        /deepseek.*r1/i,
        /glm-5/i,
        /glm-4\.7/i,
        /pro/i,
        /max/i,
        /opus/i,
        /ultra/i
      ]) || ids[0]
    );
  }
  if (context.complex >= 1) {
    return (
      findFirst([/glm-4/i, /deepseek/i, /plus/i, /turbo/i, /sonnet/i]) ||
      findFirst([/flash/i, /lite/i, /mini/i]) ||
      ids[0]
    );
  }
  return (
    findFirst([/^auto$/i, /auto/i, /flash/i, /lite/i, /mini/i, /fast/i, /turbo/i]) ||
    getTextModelId(settings) ||
    ids[0]
  );
}

function classifyModelTier(modelId) {
  const m = String(modelId || '').toLowerCase();
  if (/fast|flash|lite|mini|turbo|instant|haiku|7b|small|nano/.test(m)) return 'fast';
  if (/pro|max|opus|ultra|r1|deepseek-v3|deepseek.*v[34]|glm-5|gpt-4|sonnet|plus|thinking/.test(m)) {
    return 'pro';
  }
  return 'standard';
}

function pickModelWithProTier(context) {
  const candidates = getModelCandidatesForAuto(context).filter((m) => m.kind !== 'vision');
  if (candidates.length <= 1) {
    return candidates[0] || pickAnyModelForContext(context);
  }
  const pro = candidates.filter((m) => classifyModelTier(m.model) === 'pro');
  if (pro.length) return pro[0];
  return pickAnyModelForContext(context);
}

/** 解析本次发送实际使用的模型（Cursor Auto：按附件/长度/代码复杂度路由） */
function resolveComposerModelForSend(text, opts = {}) {
  const pick = resolveComposerModelPickForSend(opts.sessionId);
  const ctx = {
    needsVision: opts.hasImages != null ? !!opts.hasImages : attachmentNeedsVision(),
    complex: scoreMessageComplexity(text)
  };
  const preferPro = ctx.complex >= 1;

  let resolved;
  if (pick.autoMode || pick.selection === 'auto') {
    const picked = preferPro ? pickModelWithProTier(ctx) : pickAnyModelForContext(ctx);
    const autoRoute = picked.route === 'default'
      ? 'default'
      : (picked.source === 'custom' ? `auto-custom:${picked.id}` : `auto-builtin:${picked.id || ''}`);
    resolved = {
      model: picked.model || '',
      route: autoRoute,
      apiConfig: picked.apiConfig || getCustomModelApiConfig(picked.route)
    };
  } else {
    const sel = pick.selection || '';
    if (sel.startsWith('custom:')) {
      const id = sel.slice('custom:'.length);
      const model = (settings.customModels || []).find((m) => m.id === id);
      if (model) {
        resolved = {
          model: model.name,
          route: `custom:${model.id}`,
          apiConfig: {
            baseUrl: model.baseUrl || '',
            apiKey: model.apiKey || ''
          }
        };
      }
    }
    if (!resolved && sel.startsWith('custom:vision')) {
      resolved = {
        model: (settings.visionModel || getTextModelId(settings)).trim(),
        route: 'custom-vision',
        apiConfig: getCustomModelApiConfig('custom-vision')
      };
    }
    if (!resolved && sel.startsWith('custom:text')) {
      resolved = {
        model: getTextModelId(settings),
        route: 'custom-text',
        apiConfig: getCustomModelApiConfig('custom-text')
      };
    }
    if (!resolved && sel.startsWith('builtin:')) {
      const parsed = parseBuiltinRoute(sel);
      const modelId = parsed?.modelId || '';
      const supplierId = parsed?.supplierId || null;
      const match = composerModelState.builtinModels.find(
        (m) =>
          m.id === modelId && (!supplierId || m.supplierId === supplierId)
      );
      const supplier = match ? getSupplierById(match.supplierId) : null;
      if (!match || !supplier || !isSupplierModelEnabled(supplier, modelId)) {
        const fallback = pickAnyModelForContext(ctx);
        const fallbackRoute = fallback.route === 'default'
          ? 'default'
          : (fallback.source === 'custom' ? `auto-custom:${fallback.id}` : `auto-builtin:${fallback.id || ''}`);
        resolved = {
          model: fallback.model || '',
          route: fallbackRoute,
          apiConfig: fallback.apiConfig || getCustomModelApiConfig(fallback.route)
        };
      } else {
        const routeKey = match.routeKey || builtinRouteKey(match.supplierId, modelId);
        resolved = {
          model: modelId,
          route: routeKey,
          apiConfig: getBuiltinApiConfig(match.supplierId)
        };
      }
    }
    if (!resolved) {
      resolved = { model: getTextModelId(settings), route: 'default', apiConfig: getCustomModelApiConfig('default') };
    }
  }

  if (ctx.needsVision && !modelSupportsMultimodal(resolved.model, resolved.route)) {
    const vision =
      typeof pickCustomVisionModel === 'function'
        ? pickCustomVisionModel()
        : window.ModelCapabilities?.pickVisionModel?.(settings) || null;
    if (vision && vision.model) {
      return {
        model: vision.model,
        route: `auto-vision:${vision.route}`,
        apiConfig: vision.apiConfig
      };
    }
  }
  return resolved;
}

function getComposerModelDisplayLabel() {
  const pick = composerModelState.pick;
  if (pick.autoMode || pick.selection === 'auto') return 'Auto';
  const sel = pick.selection || '';
  if (sel.startsWith('custom:')) {
    const id = sel.slice('custom:'.length);
    const model = (settings.customModels || []).find((m) => m.id === id);
    if (model) return model.name;
  }
  if (sel.startsWith('custom:vision')) {
    const m = (settings.visionModel || '').trim();
    return m || '识图模型';
  }
  if (sel.startsWith('custom:text')) {
    const m = getTextModelId(settings);
    return m || '文本模型';
  }
  if (sel.startsWith('builtin:')) {
    const parsed = parseBuiltinRoute(sel);
    if (parsed?.modelId) return parsed.modelId;
  }
  return getTextModelId(settings) || '模型';
}

function updateComposerModelTriggerLabel() {
  const labelEl = $('composer-model-trigger-label');
  const label = getComposerModelDisplayLabel();
  if (labelEl) labelEl.textContent = label;
}

function setComposerModelMenuOpen(open) {
  const menu = $('composer-model-menu');
  const trigger = $('composer-model-trigger');
  composerModelState.menuOpen = !!open;
  if (menu) menu.hidden = !open;
  if (trigger) trigger.setAttribute('aria-expanded', open ? 'true' : 'false');
}

function mkModelItemButton({ key, modelId, label, active, onPick }) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = `composer-model-item${active ? ' active' : ''}`;
  btn.dataset.selection = key;
  btn.setAttribute('role', 'option');
  btn.setAttribute('aria-selected', active ? 'true' : 'false');
  btn.innerHTML = `
    <span class="composer-model-item-name">${escapeHtml(label)}</span>
  `;
  btn.addEventListener('click', () => onPick(key));
  return btn;
}

function renderComposerModelLists() {
  const builtinList = $('composer-builtin-list');
  const customList = $('composer-custom-list');
  const toggle = $('composer-model-auto-toggle');
  const pick = composerModelState.pick;
  if (toggle) toggle.checked = !!pick.autoMode;

  if (builtinList) {
    builtinList.innerHTML = '';
    if (composerModelState.loadingBuiltin) {
      builtinList.innerHTML =
        '<div class="composer-model-loading">正在检测可用模型…</div>';
    } else if (composerModelState.builtinError) {
      builtinList.innerHTML = `<div class="composer-model-error">${escapeHtml(composerModelState.builtinError)}</div>`;
    } else {
      const autoActive = pick.autoMode || pick.selection === 'auto';
      builtinList.appendChild(
        mkModelItemButton({
          key: 'auto',
          modelId: 'auto',
          label: 'Auto',
          active: autoActive,
          onPick: (key) => saveComposerModelPick({ autoMode: true, selection: key })
        })
      );
      const enabledBuiltin = getEnabledBuiltinModels();
      for (const m of enabledBuiltin) {
        const key = m.routeKey || builtinRouteKey(m.supplierId, m.id);
        builtinList.appendChild(
          mkModelItemButton({
            key,
            modelId: m.id,
            label: builtinModelPickerLabel(m),
            active: !pick.autoMode && pick.selection === key,
            onPick: (k) => saveComposerModelPick({ autoMode: false, selection: k })
          })
        );
      }
      if (!enabledBuiltin.length && !composerModelState.builtinError) {
        const empty = document.createElement('div');
        empty.className = 'composer-model-loading';
        empty.textContent =
          '无已启用的供应商模型。';
        builtinList.appendChild(empty);
      }
    }
  }

  if (customList) {
    customList.innerHTML = '';
    const models = (settings.customModels || []).filter((m) => m.kind !== 'speech');
    const customTitle = document.getElementById('composer-custom-title');
    const hasCustom = models.length > 0;
    if (customTitle) customTitle.hidden = !hasCustom;
    customList.hidden = !hasCustom;
    for (const m of models) {
      const key = `custom:${m.id}`;
      customList.appendChild(
        mkModelItemButton({
          key,
          modelId: m.name,
          label: m.name,
          active: !pick.autoMode && pick.selection === key,
          onPick: (k) => saveComposerModelPick({ autoMode: false, selection: k })
        })
      );
    }
    if (!models.length) {
      const empty = document.createElement('div');
      empty.className = 'composer-model-loading';
      empty.textContent = '暂无自定义模型。';
      empty.hidden = true;
      customList.appendChild(empty);
    }
  }
}

async function bindCurrentSessionWorkspace(sessionIdOrPath, workspacePathMaybe, opts = {}) {
  let sessionId = currentSessionId;
  let workspacePath = sessionIdOrPath;
  let bindOnly = opts.bindOnly;
  if (workspacePathMaybe !== undefined) {
    sessionId = sessionIdOrPath;
    workspacePath = workspacePathMaybe;
    if (bindOnly === undefined) {
      bindOnly = String(sessionId) !== String(currentSessionId || '');
    }
  }
  if (!gwState.authed || !sessionId) return;
  try {
    await gatewayCall('memory.session_workspace_set', {
      sessionId,
      workspacePath: workspacePath || null
    });
    if (workspacePath) {
      sessionWorkspacePathCache.set(String(sessionId), String(workspacePath));
    } else {
      sessionWorkspacePathCache.set(String(sessionId), '');
    }
    if (composerApi.setActiveSessionWorkspace) {
      await composerApi.setActiveSessionWorkspace({
        sessionId,
        workspacePath: workspacePath || null,
        bindOnly: !!bindOnly
      });
    }
    refreshHistoryList().catch(() => {});
  } catch (e) {
    console.warn(e);
  }
}

/** @type {Map<string, string>} sessionId → workspacePath（并行后台 prep 同步解析用） */
const sessionWorkspacePathCache = new Map();

async function resolveSessionWorkspacePath(sessionId) {
  if (!sessionId) return null;
  if (gwState.authed) {
    try {
      const row = await gatewayCall('memory.session_get', { sessionId });
      if (row && row.workspacePath) {
        sessionWorkspacePathCache.set(String(sessionId), String(row.workspacePath));
        return row.workspacePath;
      }
      sessionWorkspacePathCache.set(String(sessionId), '');
      return null;
    } catch (e) {
      console.warn(e);
      return null;
    }
  }
  return null;
}

function rememberSessionWorkspacePath(sessionId, workspacePath) {
  const sid = String(sessionId || '').trim();
  if (!sid) return;
  sessionWorkspacePathCache.set(sid, workspacePath ? String(workspacePath) : '');
}

function hasSessionWorkspacePathCache(sessionId) {
  const sid = String(sessionId || '').trim();
  return !!sid && sessionWorkspacePathCache.has(sid);
}

function resolveSessionWorkspacePathSync(sessionId) {
  if (!sessionId) return null;
  const sid = String(sessionId);
  if (typeof sessionActiveRuns !== 'undefined') {
    const live = sessionActiveRuns.get(sid);
    if (live && live.workspacePath) return live.workspacePath;
  }
  if (sessionWorkspacePathCache.has(sid)) {
    const cached = sessionWorkspacePathCache.get(sid);
    return cached || null;
  }
  if (sid === String(currentSessionId) && typeof window !== 'undefined') {
    return window.activeViewSessionWorkspacePath || null;
  }
  return null;
}

async function refreshSessionWorkspaceUi(workspacePath) {
  if (typeof window !== 'undefined') {
    window.activeViewSessionWorkspacePath = workspacePath || null;
    if (!workspacePath) {
      window.activeViewSessionWorkspaceKind = null;
    } else if (/^ssh:/i.test(workspacePath)) {
      window.activeViewSessionWorkspaceKind = 'ssh';
    } else {
      window.activeViewSessionWorkspaceKind = 'local';
    }
  }
  if (!workspacePath) {
    updateWorkspaceLabel({ kind: 'local', workspacePath: null, displayPath: '' });
    return;
  }
  if (/^ssh:/i.test(workspacePath)) {
    let sshConnected = false;
    const sshMatch =
      /^ssh:\/\/([^@/]+)@([^/:]+)(?::(\d+))?(\/.*)?$/i.exec(workspacePath) ||
      /^ssh:([^@/]+)@([^/:]+)(?::(\d+))?(\/.*)?$/i.exec(workspacePath);
    if (sshMatch && composerApi.sshStatus) {
      try {
        const st = await composerApi.sshStatus();
        if (st && st.connected) {
          const username = decodeURIComponent(sshMatch[1]);
          const host = sshMatch[2];
          const port = Number(sshMatch[3]) || 22;
          sshConnected =
            String(st.host || '').trim() === String(host).trim() &&
            String(st.username || '').trim() === String(username).trim() &&
            (Number(st.port) || 22) === port;
        }
      } catch {
        sshConnected = false;
      }
    }
    if (!sshConnected && composerApi.getWorkspace) {
      try {
        const ws = await composerApi.getWorkspace();
        sshConnected = !!(ws && ws.sshConnected);
      } catch {
        sshConnected = false;
      }
    }
    updateWorkspaceLabel({
      kind: 'ssh',
      workspacePath,
      displayPath: workspacePath,
      sshConnected
    });
    return;
  }
  updateWorkspaceLabel({
    kind: 'local',
    workspacePath,
    displayPath: workspacePath,
    sshConnected: false
  });
}

if (typeof window !== 'undefined') {
  window.resolveSessionWorkspacePath = resolveSessionWorkspacePath;
  window.resolveSessionWorkspacePathSync = resolveSessionWorkspacePathSync;
  window.rememberSessionWorkspacePath = rememberSessionWorkspacePath;
  window.hasSessionWorkspacePathCache = hasSessionWorkspacePathCache;
}

async function applySessionWorkspace(sessionId, opts = {}) {
  if (!gwState.authed || !sessionId) return { sameWorkspace: false };
  const switchGen = opts.switchGen;
  const stillActive = () =>
    switchGen == null ||
    typeof isActiveSessionSwitch !== 'function' ||
    isActiveSessionSwitch(switchGen);
  try {
    const sid = String(sessionId);
    const prevPath =
      typeof window !== 'undefined' && window.activeViewSessionWorkspacePath
        ? String(window.activeViewSessionWorkspacePath)
        : '';
    const row = Object.prototype.hasOwnProperty.call(opts, 'knownWorkspacePath')
      ? { workspacePath: opts.knownWorkspacePath || null }
      : sessionWorkspacePathCache.get(sid)
        ? { workspacePath: sessionWorkspacePathCache.get(sid) }
        : await gatewayCall('memory.session_get', { sessionId });
    if (!stillActive()) return { sameWorkspace: false };
    if (!row) return { sameWorkspace: false };
    const workspacePath = row && row.workspacePath ? row.workspacePath : null;
    if (workspacePath) {
      sessionWorkspacePathCache.set(sid, String(workspacePath));
    } else {
      sessionWorkspacePathCache.set(sid, '');
    }
    const nextPath = workspacePath ? String(workspacePath) : '';
    const sameWorkspace = prevPath === nextPath;
    if (composerApi.setActiveSessionWorkspace) {
      await composerApi.setActiveSessionWorkspace({
        sessionId,
        workspacePath,
        bindOnly: !!(opts.bindOnly || opts.viewOnly),
        skipRemoteTransport: sameWorkspace && !(opts.bindOnly || opts.viewOnly)
      });
    }
    if (!stillActive()) return { sameWorkspace };
    if (!sameWorkspace) {
      await refreshSessionWorkspaceUi(workspacePath);
    } else if (typeof window !== 'undefined') {
      window.activeViewSessionWorkspacePath = workspacePath || null;
    }
    if (!stillActive()) return { sameWorkspace };
    if (!sameWorkspace && typeof refreshRemoteGatewayMeta === 'function') {
      const refreshMeta = refreshRemoteGatewayMeta().catch(() => {});
      if (opts.skipDefaultEditor) {
        void refreshMeta;
      } else {
        await refreshMeta;
      }
    }
    if (!stillActive()) return { sameWorkspace };
    if (!workspacePath && typeof resetRemoteGatewayClient === 'function') {
      resetRemoteGatewayClient();
    }
    if (opts.viewOnly) {
      if (!sameWorkspace) invalidateWorkspaceArtifacts();
      if (typeof refreshWikiPanelIfNeeded === 'function') refreshWikiPanelIfNeeded();
      return { sameWorkspace, workspacePath };
    }
    if (!sameWorkspace) {
      const ws = composerApi.getWorkspace ? await composerApi.getWorkspace() : null;
      if (!stillActive()) return { sameWorkspace, workspacePath };
      if (ws) updateWorkspaceLabel(ws);
      invalidateWorkspaceArtifacts();
      if (typeof refreshWikiPanelIfNeeded === 'function') refreshWikiPanelIfNeeded();
      if (typeof resetCodebaseWarmCache === 'function') resetCodebaseWarmCache();
      if (typeof restartTerminalSession === 'function') restartTerminalSession();
      if (workspacePath && !opts.skipDefaultEditor && typeof ensureDefaultWorkspaceEditor === 'function') {
        void ensureDefaultWorkspaceEditor({ force: true });
      }
    }
    return { sameWorkspace, workspacePath };
  } catch (e) {
    console.warn(e);
    return { sameWorkspace: false };
  }
}

function refreshComposerBuiltinModels(opts = {}) {
  const silent = !!(opts && opts.silent);
  composerModelState.loadingBuiltin = false;
  composerModelState.builtinError = '';
  let models = builtinModelsFromSavedSuppliers();
  if (!models.length) {
    const cached = loadBuiltinModelsCache();
    if (cached && Object.keys(cached).length) {
      models = flattenCachedBuiltinModels(cached);
    }
  }
  composerModelState.builtinModels = models;
  if (!silent) {
    renderComposerModelLists();
    renderSuppliersList();
  }
  ensureComposerModelPickValid();
  return Promise.resolve();
}

function ensureComposerModelPickValid() {
  const pick = composerModelState.pick;
  if (!pick || pick.autoMode) return;
  const sel = String(pick.selection || '');
  if (!sel.startsWith('builtin:')) return;
  const parsed = parseBuiltinRoute(sel);
  const modelId = parsed?.modelId || '';
  const supplierId = parsed?.supplierId || null;
  const match = composerModelState.builtinModels.find(
    (m) => m.id === modelId && (!supplierId || m.supplierId === supplierId)
  );
  if (!match) {
    saveComposerModelPick({ autoMode: true, selection: 'auto' });
    return;
  }
  if (!supplierId && match.supplierId) {
    saveComposerModelPick({
      autoMode: false,
      selection: match.routeKey || builtinRouteKey(match.supplierId, modelId)
    });
  }
}

function initComposerModelPicker() {
  migrateLegacyBuiltinEnabledToSuppliers();
  composerModelState.pick = currentSessionId
    ? loadComposerModelPickForSession(currentSessionId)
    : loadComposerModelPickLegacy();
  const cached = loadBuiltinModelsCache();
  if (cached && Object.keys(cached).length) {
    composerModelState.builtinModels = flattenCachedBuiltinModels(cached);
    try {
      const raw = window.localStorage.getItem(COMPOSER_MODEL_CACHE_KEY);
      if (raw) composerModelState.builtinLastDetectAt = JSON.parse(raw).at || 0;
    } catch {
      // ignore
    }
  }

  const wrap = $('composer-model-wrap');
  const trigger = $('composer-model-trigger');
  const menu = $('composer-model-menu');
  const toggle = $('composer-model-auto-toggle');

  updateComposerModelTriggerLabel();
  refreshComposerBuiltinModels({ silent: true });
  renderComposerModelLists();
  renderSuppliersList();

  if (trigger) {
    trigger.addEventListener('click', (e) => {
      e.stopPropagation();
      setComposerModelMenuOpen(!composerModelState.menuOpen);
    });
  }

  if (toggle) {
    toggle.addEventListener('change', () => {
      const on = toggle.checked;
      let selection = composerModelState.pick.selection || 'auto';
      if (on) {
        selection = 'auto';
      } else if (selection === 'auto') {
        const first = getEnabledBuiltinModels()[0];
        selection = first
          ? (first.routeKey || builtinRouteKey(first.supplierId, first.id))
          : 'custom:text';
      }
      saveComposerModelPick({ autoMode: on, selection });
    });
  }

  document.addEventListener('click', (e) => {
    if (!composerModelState.menuOpen) return;
    if (wrap && !wrap.contains(e.target)) setComposerModelMenuOpen(false);
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && composerModelState.menuOpen) setComposerModelMenuOpen(false);
  });
}

function initComposerToolbar() {
  initComposerModelPicker();
  initComposerAgentMode();
  initComposerPasteAndDrop();
  initComposerMentionMenu();
  initWorkspacePicker();
  if (typeof initComposerVoice === 'function') initComposerVoice();
  const btnFile = $('btn-upload-file');
  if (btnFile && composerApi.pickFiles && composerApi.stageFiles) {
    btnFile.addEventListener('click', async () => {
      const paths = await composerApi.pickFiles();
      if (!paths || !paths.length) return;
      await addAttachmentsFromPaths(paths);
    });
  }
}

window.saveComposerAgentMode = saveComposerAgentMode;
window.activateComposerAgentModeForSession = activateComposerAgentModeForSession;
window.cleanupSessionComposerAgentMode = cleanupSessionComposerAgentMode;
window.activateComposerModelForSession = activateComposerModelForSession;
window.cleanupSessionComposerModelPick = cleanupSessionComposerModelPick;
window.loadComposerModelPickForSession = loadComposerModelPickForSession;

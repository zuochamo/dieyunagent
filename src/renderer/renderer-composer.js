/* global window, document, $, escapeHtml, settings, getBuiltinApiConfig, getCustomModelApiConfig, getTextModelId, openModelSettingsModal, pendingAttachments, isImageAttachment, gwState, currentSessionId, sessionActiveRuns, gatewayCall, refreshHistoryList, updateWorkspaceLabel, invalidateWorkspaceArtifacts, renderArtifactsList, initComposerPasteAndDrop, initComposerMentionMenu, initComposerVoice, initComposerPathPerm, addAttachmentsFromPaths, initWorkspacePicker, restartTerminalSession, isSupplierModelEnabled, getSupplierById, supplierDisplayName, renderSuppliersList, normalizeSettings, saveSettings, refreshRemoteGatewayMeta, resetRemoteGatewayClient, ensureDefaultWorkspaceEditor, isActiveSessionSwitch, noteResolvedModelRoute, forgetResolvedModelRoute */
const composerApi = window.diecloud || {};

// ---------- 输入区模型选择 ----------
const COMPOSER_MODEL_KEY = 'diecloud.composer.model.v1';
const COMPOSER_MODEL_BY_SESSION_KEY = 'dieyun.composer.modelBySession.v1';
const COMPOSER_MODEL_CACHE_KEY = 'diecloud.composer.builtin.cache.v2';
const COMPOSER_BUILTIN_ENABLED_KEY = 'diecloud.composer.builtin.enabled.v1';
const BUILTIN_DETECT_INTERVAL_MS = 12 * 60 * 60 * 1000;
const COMPOSER_MODEL_CACHE_TTL_MS = BUILTIN_DETECT_INTERVAL_MS;
const COMPOSER_MODEL_CACHE_ENDPOINT_KEY = 'diecloud.composer.builtin.cache.endpoint.v1';

/** @type {Map<string, { autoMode: boolean, selection: string }>} */
const sessionComposerModelPicks = new Map();

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
  // 会话结束：Auto 上次选中的 route 一并忘掉，避免档位 / 预算按旧模型算
  if (typeof forgetResolvedModelRoute === 'function') forgetResolvedModelRoute(sid);
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
      supplierId: m.supplierId || '',
      model: m.id,
      kind,
      apiConfig: getBuiltinApiConfig(m.supplierId),
      route: m.routeKey || builtinRouteKey(m.supplierId, m.id)
    };
  });
  const custom = (settings.customModels || []).map((m) => ({
    source: 'custom',
    id: m.id,
    supplierId: '',
    model: m.name,
    kind:
      window.ModelCapabilities?.effectiveCustomModelKind?.(m) ||
      (m.kind === 'vision' ? 'vision' : m.kind === 'speech' ? 'speech' : m.kind === 'tts' ? 'tts' : 'text'),
    // 走单一来源解析：手工只取两个标量会丢掉 headers / authMode / userAgent
    apiConfig: getCustomModelApiConfig(`custom:${m.id}`),
    route: `custom:${m.id}`
  }));
  const isNonChat = (kind) => window.ModelCapabilities?.isNonChatModality?.(kind) === true;
  const candidates = builtins
    .concat(custom)
    .filter((m) => m.model && m.apiConfig.baseUrl && !isNonChat(m.kind));
  if (!context.needsVision) {
    return candidates.filter((m) => m.kind !== 'vision').concat(
      candidates.filter((m) => m.kind === 'vision')
    );
  }
  const visionFirst = candidates.filter((m) => m.kind === 'vision');
  const rest = candidates.filter((m) => m.kind !== 'vision');
  return visionFirst.concat(rest);
}

/**
 * Auto 命中的候选 → route 记号。
 *
 * `auto-` 前缀表示「这条是自动选的」（`parseModelRoute` 会 strip，解析行为与手选一致）；
 * 供应商模型一定带 supplierId —— 否则档位 / 端点只能退到「第一个可用供应商」，
 * 而实际发请求用的是候选自己的供应商，两侧又分叉。
 */
function autoRouteOf(candidate) {
  if (!candidate || candidate.route === 'default') return 'default';
  if (candidate.source === 'custom') return `auto-custom:${candidate.id}`;
  return `auto-builtin:${candidate.supplierId || ''}:${candidate.id || ''}`;
}

/**
 * Auto 选型唯一入口：**候选顺序即偏好**。
 *
 * 顺序完全由「设置里的声明」决定，代码不再猜「谁更强」：
 *   1. 有图片附件 → 设置了 `vision` 模态的模型整体前置（`getModelCandidatesForAuto`）；
 *   2. 供应商 `enabledModels` / `modelModalities` 的键顺序 = 用户在该供应商里排的顺序；
 *   3. 再之后是自定义模型的顺序。
 *
 * 为什么删掉了「复杂度打分 + 模型名正则挑 pro/flash」：那套判据里没有任何字段可维护，
 * 只能靠 `glm-5` / `deepseek-v4` 这类名字猜能力等级 —— 模型一换代（`glm-5.3`、`gpt-6`）
 * 就静默失效，且与设置里用户真实标注（模态 / 档位）无关。要调偏好就调启用顺序。
 */
function pickAnyModelForContext(context) {
  const candidates = getModelCandidatesForAuto(context);
  if (!candidates.length) {
    const model = getTextModelId(settings);
    return {
      model,
      route: 'default',
      apiConfig: getCustomModelApiConfig('default')
    };
  }
  return candidates[0];
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
  const custom = (settings.customModels || []).find((m) => m && (m.name === id || m.id === id));
  if (custom) {
    return (
      window.ModelCapabilities?.customModelSupportsMultimodal(custom) === true || custom.kind === 'vision'
    );
  }
  return false;
}

/**
 * 解析本次发送实际使用的模型。
 *
 * Auto 的判据只有一条**结构性事实**：本条消息带不带图片（`needsVision`）。
 * 「消息有多复杂 / 该用哪个更强的模型」不再由 Renderer 猜 —— 没有可维护的数据源，
 * 名字正则一换代就失效；要调偏好就调供应商里启用模型的顺序（见 `pickAnyModelForContext`）。
 * 选出来的 route 会回填给 `noteResolvedModelRoute`，让档位 / 预算与 Main 压缩同口径。
 */
function resolveComposerModelForSend(text, opts = {}) {
  const pick = resolveComposerModelPickForSend(opts.sessionId);
  const ctx = {
    needsVision: opts.hasImages != null ? !!opts.hasImages : attachmentNeedsVision()
  };

  let resolved;
  if (pick.autoMode || pick.selection === 'auto') {
    const picked = pickAnyModelForContext(ctx);
    const autoRoute = autoRouteOf(picked);
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
          // 勿在此手工重建配置：只取两个标量会丢掉自定义头 / User-Agent
          apiConfig: getCustomModelApiConfig(`custom:${model.id}`)
        };
      }
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
        resolved = {
          model: fallback.model || '',
          route: autoRouteOf(fallback),
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

  // 档位 / 预算按「真正发出去的那条 route」算：Auto 下 Renderer 与 Main 压缩才不会分叉
  if (typeof noteResolvedModelRoute === 'function') {
    noteResolvedModelRoute(opts.sessionId, resolved.route);
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
    const models = (settings.customModels || []).filter(
      (m) => window.ModelCapabilities?.isNonChatModality?.(m.kind) !== true
    );
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

/**
 * 「桌面视图正在显示哪个会话的哪个工作空间」的唯一写入口。
 *
 * `activeViewSessionWorkspacePath` 只描述**它正在显示的那个会话**：会话切换时
 * `currentSessionId` 先行指向新会话，而视图路径还是旧会话的。以前只按
 * `sid === currentSessionId` 相等就把视图路径当成该会话的绑定，于是外部频道
 * （手机桥 / 企微转接器）新建/切到的会话会被「猜」成桌面当前工作空间，本轮 Agent
 * 跑错目录，并经 send 流程把这个错路径写回会话行（见
 * issues/2026-10-30-agent-channel-and-workspace-binding.md 问题 2）。
 * 所以这一对必须整体写入，读侧只认 sessionId 对得上的那份。
 *
 * @param {string|null} sessionId 视图正在显示的会话；空 = 视图不代表任何会话
 * @param {string|null} workspacePath
 * @param {string|null} [kind] 省略 = 不改动 kind
 */
function rememberActiveViewSessionWorkspace(sessionId, workspacePath, kind) {
  if (typeof window === 'undefined') return;
  const sid = sessionId ? String(sessionId) : '';
  window.activeViewSessionWorkspacePath = workspacePath ? String(workspacePath) : null;
  window.activeViewSessionWorkspaceSessionId = workspacePath && sid ? sid : null;
  if (kind !== undefined) window.activeViewSessionWorkspaceKind = kind ? String(kind) : null;
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
  // 视图路径只在它确实属于这个会话时才算数（见 rememberActiveViewSessionWorkspace）
  if (
    typeof window !== 'undefined' &&
    window.activeViewSessionWorkspacePath &&
    String(window.activeViewSessionWorkspaceSessionId || '') === sid
  ) {
    return window.activeViewSessionWorkspacePath;
  }
  return null;
}

/**
 * @param {string} sessionId 这个工作空间属于哪个会话（视图路径与会话必须成对落，见
 *   rememberActiveViewSessionWorkspace）
 * @param {string|null} workspacePath
 */
async function refreshSessionWorkspaceUi(sessionId, workspacePath) {
  const sid = sessionId ? String(sessionId) : '';
  if (!workspacePath) {
    updateWorkspaceLabel({ sessionId: sid, kind: 'local', workspacePath: null, displayPath: '' });
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
      sessionId: sid,
      kind: 'ssh',
      workspacePath,
      displayPath: workspacePath,
      sshConnected
    });
    return;
  }
  updateWorkspaceLabel({
    sessionId: sid,
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
  window.rememberActiveViewSessionWorkspace = rememberActiveViewSessionWorkspace;
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
    const unchanged = prevPath === nextPath;
    let bindResult = null;
    if (composerApi.setActiveSessionWorkspace) {
      bindResult = await composerApi.setActiveSessionWorkspace({
        sessionId,
        workspacePath,
        bindOnly: !!(opts.bindOnly || opts.viewOnly),
        skipRemoteTransport: unchanged && !(opts.bindOnly || opts.viewOnly)
      });
    }
    // 主进程校验出本地工作空间目录已不存在并清了绑定：缓存与 UI 都按无工作空间处理，
    // 勿把 DB 里恢复出来的死路径继续显示
    const missingCleared = !!(bindResult && bindResult.clearedMissingWorkspace);
    if (missingCleared) {
      sessionWorkspacePathCache.set(sid, '');
      refreshHistoryList().catch(() => {});
    }
    const effectivePath = missingCleared ? null : workspacePath;
    const sameWorkspace = unchanged && !missingCleared;
    if (!stillActive()) return { sameWorkspace };
    if (!sameWorkspace) {
      await refreshSessionWorkspaceUi(sid, effectivePath);
    } else {
      // 路径没变，仍要把「视图属于哪个会话」对齐：切换会话时 currentSessionId 先动、视图后动
      rememberActiveViewSessionWorkspace(sid, effectivePath);
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
    if (!effectivePath && typeof resetRemoteGatewayClient === 'function') {
      resetRemoteGatewayClient();
    }
    if (opts.viewOnly) {
      if (!sameWorkspace) invalidateWorkspaceArtifacts();
      return { sameWorkspace, workspacePath: effectivePath };
    }
    if (!sameWorkspace) {
      const ws = composerApi.getWorkspace ? await composerApi.getWorkspace() : null;
      if (!stillActive()) return { sameWorkspace, workspacePath: effectivePath };
      if (ws) updateWorkspaceLabel({ ...ws, sessionId: sid });
      invalidateWorkspaceArtifacts();
      if (typeof restartTerminalSession === 'function') restartTerminalSession();
      if (effectivePath && !opts.skipDefaultEditor && typeof ensureDefaultWorkspaceEditor === 'function') {
        void ensureDefaultWorkspaceEditor({ force: true });
      }
    }
    return { sameWorkspace, workspacePath: effectivePath };
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
  initComposerPasteAndDrop();
  initComposerMentionMenu();
  initWorkspacePicker();
  if (typeof initComposerVoice === 'function') initComposerVoice();
  if (typeof initComposerPathPerm === 'function') initComposerPathPerm();
  const btnFile = $('btn-upload-file');
  if (btnFile && composerApi.pickFiles && composerApi.stageFiles) {
    btnFile.addEventListener('click', async () => {
      const paths = await composerApi.pickFiles();
      if (!paths || !paths.length) return;
      await addAttachmentsFromPaths(paths);
    });
  }
}

window.activateComposerModelForSession = activateComposerModelForSession;
window.cleanupSessionComposerModelPick = cleanupSessionComposerModelPick;
window.loadComposerModelPickForSession = loadComposerModelPickForSession;

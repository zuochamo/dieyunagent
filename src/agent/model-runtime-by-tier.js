'use strict';

/**
 * 按 context 档位持久化编码参数（温度、窗口、段预算等）。
 * 工厂默认值来自 model-runtime-presets；用户微调按 tier id 分别保存。
 *
 * 两份存储、一个语义：
 * - Renderer 侧 localStorage：同步读，UI / 预算计算都在热路径上；
 * - Main 侧 `model-runtime-by-tier.json`：压缩、planner、定时计划这些没有 Renderer 的路径要读。
 *   与 `agent-limits-by-tier.json` 同邻同形；启动时由 Renderer 回填、保存时双写。
 */
// 单一来源：model-runtime-presets.js（原先这里 4 处「全局 → require → 硬编码副本」三层兜底）
const {
  MODEL_RUNTIME_PRESETS,
  MODEL_RUNTIME_DEFAULTS,
  getModelRuntimePresetById,
  remapLegacyContextTierId,
  foldLegacyContextTierRecord
} = require('./model-runtime-presets');
// route 解析（含 `auto-` 前缀 strip）唯一来源：本模块不再自己 `indexOf(':')` 拼 supplierId。
const { parseModelRoute } = require('./model-api-config');

/**
 * Node-only 依赖入口：浏览器 / 裸脚本下为抛错桩，避免 esbuild 静态解析 fs / path。
 * 所有调用点都在 Main 专用路径（磁盘 I/O），Renderer 侧不会触达。
 */
const nodeRequire =
  typeof require === 'function'
    ? require
    : function () {
        throw new Error('node-only dependency');
      };

const STORAGE_KEY = 'diecloud.model.runtimeByTier.v1';
const EDITING_TIER_KEY = 'diecloud.model.runtimeEditingTier.v1';
const RUNTIME_BY_TIER_FILE = 'model-runtime-by-tier.json';

/** @type {Record<string, Record<string, number>>} */
let runtimeByTier = {};

/** 档位清单的唯一来源：Main / Renderer / agent-limits* 都从这里取，勿再各抄一份。 */
function listContextTierIds() {
  return MODEL_RUNTIME_PRESETS.map((p) => p.id);
}

function remapTierId(id) {
  return remapLegacyContextTierId(id);
}

function foldTierRecord(raw) {
  return foldLegacyContextTierRecord(raw, isValidTierId);
}

function isValidTierId(id) {
  const key = String(id || '').trim();
  return key && listContextTierIds().includes(key);
}

function resolveStoredTierId(tierId) {
  const mapped = remapTierId(tierId);
  return listContextTierIds().includes(mapped) ? mapped : 'default';
}

function getPresetFactoryValues(tierId) {
  const preset = getModelRuntimePresetById(tierId);
  if (preset && preset.values) return { ...preset.values };
  return { ...MODEL_RUNTIME_DEFAULTS };
}

/** Renderer 侧（localStorage）读取；Main 侧见下方 `loadRuntimeByTierFromMain`。 */
function loadBrowserRuntimeByTier() {
  try {
    const raw = globalThis.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return {};
    return foldTierRecord(parsed);
  } catch {
    return {};
  }
}

function saveBrowserRuntimeByTier() {
  try {
    globalThis.localStorage.setItem(STORAGE_KEY, JSON.stringify(runtimeByTier));
  } catch {
    // ignore
  }
}

function reloadRuntimeByTier() {
  runtimeByTier = loadBrowserRuntimeByTier();
  return runtimeByTier;
}

reloadRuntimeByTier();

function getRuntimeOverridesForTier(tierId) {
  const key = resolveStoredTierId(tierId);
  return { ...(runtimeByTier[key] || {}) };
}

function getRuntimeValuesForTier(tierId) {
  const key = resolveStoredTierId(tierId);
  return { ...getPresetFactoryValues(key), ...getRuntimeOverridesForTier(key) };
}

/** 只有「与工厂值不同」的键才落盘：同值不写，改工厂默认时旧存档不会把新值钉死。 */
function extractRuntimeOverrides(tierId, values) {
  const factory = getPresetFactoryValues(tierId);
  const cleaned = {};
  for (const [k, v] of Object.entries(values || {})) {
    if (factory[k] === v) continue;
    cleaned[k] = v;
  }
  return cleaned;
}

function setRuntimeValuesForTier(tierId, partial) {
  const key = resolveStoredTierId(tierId);
  const next = { ...(runtimeByTier[key] || {}), ...(partial || {}) };
  const cleaned = extractRuntimeOverrides(key, next);
  if (Object.keys(cleaned).length) {
    runtimeByTier[key] = cleaned;
  } else {
    delete runtimeByTier[key];
  }
  saveBrowserRuntimeByTier();
  return getRuntimeValuesForTier(key);
}

function resetRuntimeValuesForTier(tierId) {
  const key = resolveStoredTierId(tierId);
  delete runtimeByTier[key];
  saveBrowserRuntimeByTier();
  return getRuntimeValuesForTier(key);
}

function getEditingContextTierId() {
  try {
    const raw = globalThis.localStorage.getItem(EDITING_TIER_KEY);
    const id = remapTierId(String(raw || '').trim());
    return listContextTierIds().includes(id) ? id : 'default';
  } catch {
    return 'default';
  }
}

function setEditingContextTierId(tierId) {
  const key = resolveStoredTierId(tierId);
  try {
    globalThis.localStorage.setItem(EDITING_TIER_KEY, key);
  } catch {
    // ignore
  }
  return key;
}

// --- Main 侧（无 localStorage）：userData/model-runtime-by-tier.json ---

function runtimeByTierFilePath(userDataPath) {
  return nodeRequire('path').join(userDataPath, RUNTIME_BY_TIER_FILE);
}

/**
 * 从 Main 磁盘读「按档覆盖」。文件缺失 / 损坏一律当空（工厂值仍可用）。
 * @param {string} userDataPath
 * @returns {Record<string, Record<string, number>>}
 */
function loadRuntimeByTierFromMain(userDataPath) {
  if (!userDataPath) return {};
  try {
    const raw = JSON.parse(
      nodeRequire('fs').readFileSync(runtimeByTierFilePath(userDataPath), 'utf8')
    );
    if (!raw || typeof raw !== 'object') return {};
    return foldTierRecord(raw);
  } catch {
    return {};
  }
}

/**
 * 写 Main 磁盘：与 Renderer 同一条「只存覆盖」规则，未知档位与同值键都丢弃。
 * @param {string} userDataPath
 * @param {Record<string, Record<string, number>>} byTier
 */
function saveRuntimeByTierToMain(userDataPath, byTier) {
  if (!userDataPath) return {};
  const fs = nodeRequire('fs');
  const file = runtimeByTierFilePath(userDataPath);
  /** @type {Record<string, Record<string, number>>} */
  const cleaned = {};
  for (const [tierId, values] of Object.entries(foldTierRecord(byTier || {}))) {
    const overrides = extractRuntimeOverrides(tierId, values);
    if (Object.keys(overrides).length) cleaned[tierId] = overrides;
  }
  fs.mkdirSync(nodeRequire('path').dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(cleaned, null, 2), 'utf8');
  return cleaned;
}

/** Renderer 启动时用 Main 存档回填内存表；返回是否读到有效覆盖。 */
function hydrateRuntimeByTier(fromMain) {
  /** @type {Record<string, Record<string, number>>} */
  const cleaned = {};
  for (const [tierId, values] of Object.entries(foldTierRecord(fromMain || {}))) {
    const overrides = extractRuntimeOverrides(tierId, values);
    if (Object.keys(overrides).length) cleaned[tierId] = overrides;
  }
  runtimeByTier = cleaned;
  saveBrowserRuntimeByTier();
  return Object.keys(cleaned).length > 0;
}

function getAllRuntimeByTier() {
  /** @type {Record<string, Record<string, number>>} */
  const out = {};
  for (const [tierId, values] of Object.entries(runtimeByTier)) {
    if (!isValidTierId(tierId) || !values || typeof values !== 'object') continue;
    out[tierId] = { ...values };
  }
  return out;
}

/** 某档位的生效值（工厂值 + 该档覆盖），Main 侧读磁盘。 */
function getRuntimeValuesForTierFromMain(userDataPath, tierId) {
  const key = resolveStoredTierId(tierId);
  const overrides = loadRuntimeByTierFromMain(userDataPath)[key] || {};
  return { ...getPresetFactoryValues(key), ...overrides };
}

/** 首次升级：把旧版全局 settings 里的编码参数迁入 default 档 */
function migrateGlobalSettingsToDefaultTier(globalSettings) {
  if (!globalSettings || typeof globalSettings !== 'object') return false;
  if (Object.keys(runtimeByTier).length) return false;
  const factory = getPresetFactoryValues('default');
  const keys = [
    'temperature',
    'contextWindow',
    'maxOutputTokens',
    'contextReserveTokens',
    'compactionTriggerRatio',
    'agentToolCallLimit',
    'agentMaxRounds'
  ];
  const overrides = {};
  let changed = false;
  for (const k of keys) {
    const v = globalSettings[k];
    if (v == null || !Number.isFinite(Number(v))) continue;
    const num = Number(v);
    if (factory[k] != null && Math.abs(num - Number(factory[k])) < 0.0001) continue;
    overrides[k] = num;
    changed = true;
  }
  if (changed) {
    runtimeByTier.default = overrides;
    saveRuntimeByTierToDisk();
  }
  return changed;
}

function inferContextTierFromModelName(modelId) {
  const name = String(modelId || '').toLowerCase();
  if (!name) return 'default';
  if (/\b2[\s_-]?m\b|\b2000k\b/.test(name)) return 'ctx-2m';
  if (/\b1[\s_-]?m\b|\b1000k\b/.test(name)) return 'ctx-1m';
  if (/\b512k\b/.test(name)) return 'ctx-512k';
  if (/\b200k\b/.test(name)) return 'ctx-200k';
  if (/\b128k\b/.test(name)) return 'ctx-128k';
  if (/\b64k\b/.test(name)) return 'ctx-64k';
  if (/\b32k\b/.test(name)) return 'ctx-32k';
  // 8K 档已删除：16k/8k 名字都落到最小档，8k 模型另由窗口线索兜底（见下）
  if (/\b16k\b|\b8k\b/.test(name)) return 'ctx-16k';
  if (/gemini/.test(name)) return 'ctx-1m';
  if (/gpt-4\.1/.test(name)) return 'ctx-1m';
  if (/minimax/.test(name)) return 'ctx-1m';
  if (/qwen-long/.test(name)) return 'ctx-1m';
  if (/claude/.test(name)) return 'ctx-200k';
  if (/mistral-large/.test(name)) return 'ctx-64k';
  if (/qwen2\.5-32b/.test(name)) return 'ctx-64k';
  if (
    /gpt-4o|gpt-4-turbo|gpt-5|o1|o3|o4-mini|deepseek|qwen2\.5-72b|qwen3/.test(name)
  ) {
    return 'ctx-128k';
  }
  if (/gpt-3\.5|gpt-3\b|llama-2|tiny|mini-8k/.test(name)) return 'ctx-16k';
  return 'default';
}

/** 上下文窗口下限（与 model-runtime-schema 的 min 对齐） */
const CONTEXT_WINDOW_FLOOR = 8192;

/**
 * 输入预算地板。取窗口下限同值：畸形配置（模型自带 8k 窗口 + 档位 16k 输出/预留）
 * 下「窗口 − 输出 − 预留」会算成负数或 0，此时仍给 8192 而不是塌到 0。
 * 必须与 compaction-main.applyToolSchemaDeduction 的地板同值，否则「超出预留的工具 schema」
 * 扣减后预算会反超 base。数字只此一处，两侧共用下面的 computeEffectiveInputBudget。
 */
const MIN_INPUT_BUDGET_TOKENS = CONTEXT_WINDOW_FLOOR;

/**
 * 有效输入预算 = 上下文窗口 − 最大输出 − 系统预留 的**唯一公式来源**。
 * Renderer（renderer-model-runtime.getEffectiveInputBudget）与 Main
 * （compaction-main.getEffectiveInputBudget）都委托到这里，各自只负责把 settings 里的三个
 * token 数解析出来（档位取值 / 模型自带窗口 / 缺省值），不再各写一份减法 ——
 * 此前两侧地板不同（1024 vs 8192），模型自带 8k 窗口时会算成「UI 显示的预算 ≠ 主进程压缩阈值」。
 *
 * 入参由调用方解析为 token 数，本函数不兜默认值；缺省 / 非数值一律按 0 计，靠地板兜住。
 * @param {{ contextWindow?: number, maxOutputTokens?: number, contextReserveTokens?: number }} [usage]
 */
function computeEffectiveInputBudget(usage = {}) {
  const toTokens = (v) => (Number.isFinite(Number(v)) ? Math.floor(Number(v)) : 0);
  const windowTokens = toTokens(usage.contextWindow);
  const outputTokens = Math.max(0, toTokens(usage.maxOutputTokens));
  const reserveTokens = Math.max(0, toTokens(usage.contextReserveTokens));
  return Math.max(MIN_INPUT_BUDGET_TOKENS, windowTokens - outputTokens - reserveTokens);
}

/**
 * 本轮真正生效的「模型与段预算」。
 *
 * 磁盘 `model-settings.json` 只承接 default 档（Renderer 只把 default 档镜像过去），所以
 * **非 default 档**的窗口 / 输出 / 预留 / 触发比 / 段预算必须在 Main 消费端叠加一次；
 * 否则 16K、128K 这类档位在压缩侧仍按 default 档的 512K 算阈值 —— 「按档生效」只在 UI 上成立。
 *
 * 模型自带窗口（`customModels[].contextWindow`）优先级更高，由
 * `compaction-main.resolveEffectiveContextWindow` 继续压过档位值。
 *
 * @param {object} settings 磁盘 settings（loadModelSettings 结果）
 * @param {string} userDataPath
 * @param {{ tierId?: string, model?: string }} [opts]
 */
function applyTierRuntime(settings, userDataPath, opts = {}) {
  const s = settings && typeof settings === 'object' ? settings : {};
  const tierId = resolveStoredTierId(
    opts.tierId || resolveContextTierIdFromSettings(s, opts.model)
  );
  // default 档的生效值就是 model-settings.json 本身（Renderer 的 default 档镜像），
  // 再叠一层工厂值反而会盖掉用户在旧版里存进磁盘的全局设置。
  if (tierId === 'default') return s;
  const next = { ...s, ...getRuntimeValuesForTierFromMain(userDataPath, tierId) };
  // 不变量：预留不能超过「窗口 − 输出」（与 Renderer / model-settings 同一条）
  next.contextReserveTokens = Math.min(
    Number(next.contextReserveTokens) || 0,
    Math.max(0, (Number(next.contextWindow) || 0) - (Number(next.maxOutputTokens) || 0))
  );
  return next;
}

/**
 * 模型名里的「小窗口」线索。8K 档已删除，若名字写明 8k 则按 8192 估算，
 * 避免只落进 16K 档后仍按 16384 申请上下文。
 */
function inferContextWindowFromModelName(modelId) {
  const name = String(modelId || '').toLowerCase();
  if (!name) return null;
  if (/\b8k\b/.test(name)) return 8192;
  return null;
}

/** 设置行声明的模态（text / vision / speech）；未声明按 text —— 与 Renderer `ModelCapabilities` 同判据。 */
function declaredModality(value, kind) {
  if (value === 'vision' || value === 'text' || value === 'speech') return value;
  if (kind === 'vision') return 'vision';
  if (kind === 'speech') return 'speech';
  return 'text';
}

/** 未指定 supplierId 时请求实际会走的供应商：第一个 baseUrl+apiKey 齐备的；都没有才退回第 0 行。 */
function firstUsableSupplier(suppliers) {
  const rows = Array.isArray(suppliers) ? suppliers.filter(Boolean) : [];
  const usable = rows.find(
    (row) => String(row.baseUrl || '').trim() && String(row.apiKey || '').trim()
  );
  return usable || rows[0] || null;
}

/**
 * 「route → 模型事实」的唯一解析点：真实模型名 / 供应商 / 模态 / 自带上下文窗口 / 上下文档位。
 *
 * 为什么必须只有这一处：同一条事实此前在 5 个地方各自推断 —— Renderer 的
 * `parseModelRouteSelection` / `resolveContextTierIdForRoute`、Main 的 `indexOf(':')`、
 * `model-api-config.parseModelRoute`、以及各自的名字正则。于是 `auto-builtin:<modelId>`
 * 在 Renderer 被当成「未知 route → default 档」、在 Main 被按模型名猜档，
 * 同一份设置在两侧预算分叉（UI 进度条 ≠ 压缩阈值）。
 *
 * 输入永远只是「当前 settings + route」：现查、不缓存、**不维护任何模型清单**。
 * 模型换代（改名 / 加减能力 / 换窗口）时本函数不需要改 —— 因为事实来源全部是设置里的
 * 用户声明（`contextTier` / `contextTierByModel` / 模型自带 `contextWindow` /
 * `modelModalities`），代码只负责按优先级取，名字正则仅作最后兜底。
 *
 * 优先级（勿改）：模型自带窗口 / 显式档位 > 供应商行档位 > 模型名线索。
 *
 * @param {object} settings model-settings.json（或 localStorage 同构设置）
 * @param {string} modelRouteOrId  `custom:<id>` / `builtin:<supplierId>:<modelId>` /
 *                                 `auto-custom:*` / `auto-builtin:*`（`auto-` 已由 parseModelRoute strip）/
 *                                 裸模型名 / ''（default）
 */
function resolveModelFacts(settings, modelRouteOrId) {
  const s = settings && typeof settings === 'object' ? settings : {};
  const route = String(modelRouteOrId == null ? '' : modelRouteOrId).trim();
  const parsed = parseModelRoute(route);
  const facts = {
    route,
    kind: parsed.kind,
    supplierId: '',
    modelId: '',
    customId: '',
    modality: 'text',
    contextWindow: null,
    contextTierId: 'default'
  };
  if (parsed.kind === 'default') return facts;

  const customs = Array.isArray(s.customModels) ? s.customModels.filter(Boolean) : [];
  const fillFromCustomModel = (model) => {
    facts.customId = String(model.id || '');
    facts.modelId = String(model.name || '');
    facts.modality = declaredModality(model.modalitySetting, model.kind);
    const own = Math.floor(Number(model.contextWindow));
    if (Number.isFinite(own) && own > 0) {
      facts.contextWindow = Math.max(CONTEXT_WINDOW_FLOOR, own);
    } else if (!model.contextTier) {
      // 显式档位优先于名字线索
      facts.contextWindow = inferContextWindowFromModelName(facts.modelId);
    }
    facts.contextTierId = model.contextTier
      ? normalizeContextTierId(model.contextTier)
      : normalizeContextTierId(inferContextTierFromModelName(facts.modelId || facts.customId));
    return facts;
  };

  if (parsed.kind === 'custom') {
    const customId = String(parsed.customId || '');
    facts.customId = customId;
    // 模型已被删：保持 default 档 / null 窗口，由调用方明确报错（勿静默串到别的模型）
    const model = customs.find((m) => String(m.id || '') === customId) || null;
    return model ? fillFromCustomModel(model) : facts;
  }

  // plain：Main 侧只拿得到裸模型名，先按名字命中自定义模型（原「名字线索」路径）
  if (parsed.kind === 'plain') {
    const byName = customs.find((m) => String(m.name || '') === String(parsed.name || '')) || null;
    if (byName) return fillFromCustomModel(byName);
  }

  // builtin / plain 兜底：事实来自供应商行（plain 的「模型名」就是路由串本身）
  const suppliers = Array.isArray(s.modelSuppliers) ? s.modelSuppliers.filter(Boolean) : [];
  const supplierId = parsed.kind === 'builtin' ? String(parsed.supplierId || '') : '';
  const modelId =
    parsed.kind === 'builtin' ? String(parsed.modelId || '') : String(parsed.name || '');
  facts.supplierId = supplierId;
  facts.modelId = modelId;
  const supplier = supplierId
    ? suppliers.find((row) => String(row.id || '') === supplierId) || null
    : firstUsableSupplier(suppliers);
  if (!supplier) {
    // 供应商行不存在（route 指向已删供应商）：只剩模型名可用
    facts.contextTierId = normalizeContextTierId(inferContextTierFromModelName(modelId));
    facts.contextWindow = inferContextWindowFromModelName(modelId);
    return facts;
  }
  const modalities =
    supplier.modelModalities && typeof supplier.modelModalities === 'object'
      ? supplier.modelModalities
      : {};
  facts.modality = declaredModality(modalities[modelId]);
  const perModelTier =
    supplier.contextTierByModel && typeof supplier.contextTierByModel === 'object'
      ? supplier.contextTierByModel[modelId]
      : '';
  const supplierTier = perModelTier || supplier.contextTier || '';
  facts.contextTierId = supplierTier
    ? normalizeContextTierId(supplierTier)
    : normalizeContextTierId(inferContextTierFromModelName(modelId));
  facts.contextWindow = supplierTier ? null : inferContextWindowFromModelName(modelId);
  return facts;
}

/**
 * 模型自带上下文窗口（可选）→ token 数；返回 null 表示沿用所属档位。
 * Renderer（localStorage 设置）与 Main（磁盘 model-settings.json）共用，设置对象同构。
 * 解析细节全在 {@link resolveModelFacts}，这里只保留「空 route / 'auto' 哨兵 → 无覆盖」的语义。
 */
function resolveModelContextWindowFromSettings(settings, modelRouteOrId) {
  const route = String(modelRouteOrId == null ? '' : modelRouteOrId).trim();
  if (!route || route === 'auto') return null;
  return resolveModelFacts(settings, route).contextWindow;
}

function normalizeContextTierId(value, fallback = 'default') {
  const mapped = remapTierId(value);
  return listContextTierIds().includes(mapped) ? mapped : fallback;
}

/** 档位解析同上：解析细节只在 {@link resolveModelFacts}，`auto-*` 走同一口径。 */
function resolveContextTierIdFromSettings(settings, modelRouteOrId) {
  const route = String(modelRouteOrId == null ? '' : modelRouteOrId).trim();
  if (!route || route === 'auto') return 'default';
  return resolveModelFacts(settings, route).contextTierId;
}

const api = {
  STORAGE_KEY,
  RUNTIME_BY_TIER_FILE,
  CONTEXT_WINDOW_FLOOR,
  MIN_INPUT_BUDGET_TOKENS,
  computeEffectiveInputBudget,
  applyTierRuntime,
  reloadRuntimeByTier,
  listContextTierIds,
  getRuntimeValuesForTier,
  getRuntimeOverridesForTier,
  setRuntimeValuesForTier,
  resetRuntimeValuesForTier,
  getAllRuntimeByTier,
  hydrateRuntimeByTier,
  loadRuntimeByTierFromMain,
  saveRuntimeByTierToMain,
  getRuntimeValuesForTierFromMain,
  getEditingContextTierId,
  setEditingContextTierId,
  migrateGlobalSettingsToDefaultTier,
  inferContextTierFromModelName,
  inferContextWindowFromModelName,
  resolveModelFacts,
  resolveModelContextWindowFromSettings,
  normalizeContextTierId,
  resolveContextTierIdFromSettings,
  isValidContextTierId: isValidTierId
};

module.exports = api;

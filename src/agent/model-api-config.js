'use strict';

/**
 * 模型路由 → API 配置的单一来源。
 *
 * 单一来源先例：src/agent/guardrails-shared.js。
 * 本模块被 Main 直接 require，也被 esbuild 打进 Renderer（
 * src/renderer/agent/agent-bundle-entry.js → dist/agent-bundle.js），
 * 由 index.html 在 renderer-model-capabilities.js / renderer-model-runtime.js 之前加载。
 *
 * 职责边界（勿混）：
 *   - 本模块 = 「给定 settings + route，解析出 { baseUrl, apiKey, model }」——纯函数、零 IO、零 Electron；
 *   - 「挑哪个 route」（auto 模式 / 复杂度打分 / vision·speech 路由）依赖会话 UI 状态，留在 Renderer。
 *
 * 安全约定：本模块只解析，不落盘。严禁把 apiKey 写进 plans.json 等持久化文件。
 */

const { normalizeConfiguredHeaders } = require('./llm-request');

const CUSTOM_ROUTE_RE = /^(?:auto-)?custom:(.+)$/;
const BUILTIN_ROUTE_RE = /^(?:auto-)?builtin(?::|$)/;

function asSettings(settings) {
  return settings && typeof settings === 'object' ? settings : {};
}

/**
 * 行对象（供应商 / 自定义模型 / 顶层 settings）→ 「请求修饰」字段。
 *
 * 这三样是 llm-request.js#buildLlmHeaders 的输入，与 baseUrl/apiKey/model 一样
 * 属于「一次请求所需的全部配置」，所以必须由本模块一并解析出来 —— 否则每个调用点
 * 都要自己去 settings 里再捞一遍 headers，等于把单一来源又拆散。
 *
 * 刻意「有值才挂键」：无自定义配置时返回值仍是 {baseUrl, apiKey, model} 三键，
 * 这是既有单测（toEqual）与调用方依赖的契约。
 */
function requestOptionsFrom(row) {
  const r = row && typeof row === 'object' ? row : {};
  const out = {};
  const headers = normalizeConfiguredHeaders(r.headers);
  if (Object.keys(headers).length) out.headers = headers;
  const authMode = String(r.authMode == null ? '' : r.authMode).trim();
  if (authMode && authMode !== 'bearer') out.authMode = authMode;
  const userAgent = String(r.userAgent == null ? '' : r.userAgent).trim();
  if (userAgent) out.userAgent = userAgent;
  return out;
}

/**
 * 主行缺失时回落到顶层 settings 的请求修饰（对齐 `row.baseUrl || s.baseUrl` 的既有语义）。
 * headers 按键合并（主行优先），authMode / userAgent 主行优先。
 */
function mergedRequestOptions(primary, fallback) {
  const a = requestOptionsFrom(primary);
  const b = requestOptionsFrom(fallback);
  const out = {};
  const headers = { ...(b.headers || {}), ...(a.headers || {}) };
  if (Object.keys(headers).length) out.headers = headers;
  const authMode = a.authMode || b.authMode;
  if (authMode) out.authMode = authMode;
  const userAgent = a.userAgent || b.userAgent;
  if (userAgent) out.userAgent = userAgent;
  return out;
}

function asConfig(baseUrl, apiKey, model, extra) {
  const out = {
    baseUrl: String(baseUrl == null ? '' : baseUrl).trim(),
    apiKey: String(apiKey == null ? '' : apiKey).trim(),
    model: String(model == null ? '' : model).trim()
  };
  const e = extra && typeof extra === 'object' ? extra : null;
  if (!e) return out;
  if (e.headers && Object.keys(e.headers).length) out.headers = e.headers;
  const authMode = String(e.authMode == null ? '' : e.authMode).trim();
  if (authMode) out.authMode = authMode;
  const userAgent = String(e.userAgent == null ? '' : e.userAgent).trim();
  if (userAgent) out.userAgent = userAgent;
  return out;
}

function isUsableApiConfig(cfg) {
  if (!cfg) return false;
  return !!(String(cfg.baseUrl || '').trim() && String(cfg.apiKey || '').trim());
}

function listSuppliers(settings) {
  const rows = asSettings(settings).modelSuppliers;
  return Array.isArray(rows) ? rows.filter(Boolean) : [];
}

function listCustomModels(settings) {
  const rows = asSettings(settings).customModels;
  return Array.isArray(rows) ? rows.filter(Boolean) : [];
}

/**
 * 「不能当对话模型用」的模态：语音转写（speech）/ 语音合成（tts）/ 全模态外的纯语音。
 *
 * 为什么要有这一处判据：原先各处写 `kind !== 'speech'`，加一个 `tts` 模态时
 * 每处都得记得补一个 `&& kind !== 'tts'`，漏一处就会让朗读模型被选进对话/计划。
 */
const NON_CHAT_MODALITIES = new Set(['speech', 'tts']);

function isNonChatModality(kind) {
  return NON_CHAT_MODALITIES.has(String(kind == null ? '' : kind).trim());
}

/** 仅文本类自定义模型参与文本兜底（speech / tts / vision 不参与）。 */
function isTextCustomModel(model) {
  const kind = String((model && model.kind) || 'text');
  return kind !== 'vision' && !isNonChatModality(kind);
}

function findCustomModelById(settings, id) {
  const target = String(id || '');
  if (!target) return null;
  return listCustomModels(settings).find((m) => String(m.id || '') === target) || null;
}

/**
 * 供应商某个模型是否「已启用」——全局单一来源。
 *
 * 语义刻意与 Renderer 的 `isSupplierModelEnabled`（renderer-model-runtime.js /
 * renderer-model-capabilities.js）逐条对齐，三处必须同判据：
 *   1. 无 modelId → 未启用；
 *   2. enabledModels 为空对象 / 缺失 → 视为「未做过启用筛选」，全部可用；
 *   3. 显式 `=== false` → 未启用；
 *   4. 其余（含 `=== true`）→ 已启用。
 * 注意第 4 条：**不能**写成 `=== true`，否则 enabledModels 里只写了 `false` 的
 * 供应商会把 modelModalities 上声明过的模型全部判死，与 Renderer 的勾选状态相反。
 */
function isSupplierModelEnabled(supplier, modelId) {
  const id = String(modelId == null ? '' : modelId);
  if (!supplier || typeof supplier !== 'object' || !id) return false;
  const map =
    supplier.enabledModels && typeof supplier.enabledModels === 'object' ? supplier.enabledModels : {};
  if (!Object.keys(map).length) return true;
  if (map[id] === false) return false;
  return true;
}

function isPlainMap(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * 供应商上「声明过」的全部模型 id（保序去重）。
 *
 * 为什么要合并三个来源：`enabledModels` 只记录用户动过开关的模型，用户没筛过时它是空的，
 * 此时唯一能反映「这个供应商有哪些模型」的就是 `modelModalities` /
 * `contextTierByModel`（设置页探测到的模型会写进这两张表）。
 */
function supplierModelIds(supplier) {
  const row = supplier && typeof supplier === 'object' ? supplier : null;
  if (!row) return [];
  const ids = [];
  for (const map of [row.enabledModels, row.modelModalities, row.contextTierByModel]) {
    if (!isPlainMap(map)) continue;
    for (const id of Object.keys(map)) if (id && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

/**
 * 供应商 → 默认模型名（供应商行自身记录的已启用模型）。
 *
 * 为什么必须有：`builtin:<supplierId>:<modelId>` 路由把模型名放在路由里，而「无 route」
 * 的调用方（定时计划、计划解析）只拿 supplier 的 baseUrl/apiKey 就解析不出模型名；
 * 此时若顶层 textModel 也为空（只用供应商配模型的用户就是这种情况），调用方最终会把
 * 空模型名交给模型服务，报「model 必填」。
 *
 * 候选集 = enabledModels ∪ modelModalities ∪ contextTierByModel 的键，
 * 逐个过 `isSupplierModelEnabled` 这条唯一判据；优先非 speech，全不可用时返回 ''
 * （由调用方报错，不猜）。
 */
function pickSupplierModelId(supplier) {
  const row = supplier && typeof supplier === 'object' ? supplier : null;
  if (!row) return '';
  const ids = supplierModelIds(row).filter((id) => isSupplierModelEnabled(row, id));
  if (!ids.length) return '';
  const modalities = isPlainMap(row.modelModalities) ? row.modelModalities : {};
  const speakable = (id) => isNonChatModality(modalities[id] || 'text');
  return ids.find((id) => !speakable(id)) || ids[0];
}

/**
 * 供应商 → apiConfig。
 * - 指定 supplierId：命中用命中项；**未命中返回不可用配置**（调用方据此明确报错，
 *   而不是静默串到别的供应商的 key 上）。
 * - 未指定：按数组顺序取第一个 baseUrl+apiKey 均非空的供应商。
 * - 供应商全不可用：退回 builtinBaseUrl / builtinApiKey（legacy 内置通道）。
 */
function resolveSupplierApiConfig(settings, supplierId) {
  const s = asSettings(settings);
  const id = String(supplierId || '');
  if (id) {
    const hit = listSuppliers(s).find((row) => String(row.id || '') === id) || null;
    return hit
      ? asConfig(hit.baseUrl, hit.apiKey, pickSupplierModelId(hit), requestOptionsFrom(hit))
      : asConfig('', '');
  }
  const first = listSuppliers(s).find((row) => isUsableApiConfig(asConfig(row.baseUrl, row.apiKey)));
  if (first) {
    return asConfig(first.baseUrl, first.apiKey, pickSupplierModelId(first), requestOptionsFrom(first));
  }
  return asConfig(s.builtinBaseUrl, s.builtinApiKey, s.textModel, requestOptionsFrom(s));
}

/**
 * 顶层 `textModel` 就是「默认文本模型」：用户显式写了就按它解析端点。
 *
 * 为什么需要这一步：兜底顺序里供应商在前，而供应商只按 `enabledModels` 的**数组顺序**
 * 挑第一个（`pickSupplierModelId`），于是用户明确写下的默认模型在有供应商时形同虚设 ——
 * 实际生效的可能是数组第一个、甚至是个 vision 模型。这里让显式选择优先。
 *
 * 命中顺序：供应商已启用模型里有同 id → 该供应商；否则自定义模型里有同 name → 该模型。
 * 自定义模型**刻意不做 kind 过滤**：这是用户点名的模型（`isTextCustomModel` 的
 * vision/speech 排除只用于「没点名时自动挑」的兜底链）。
 * 都找不到能承载它的端点时返回 null，调用方继续走原有兜底顺序（不猜、不静默换 key）。
 */
function resolveExplicitDefaultModel(s) {
  const id = String(s.textModel == null ? '' : s.textModel).trim();
  if (!id) return null;
  for (const supplier of listSuppliers(s)) {
    if (!isUsableApiConfig(asConfig(supplier.baseUrl, supplier.apiKey))) continue;
    if (!supplierModelIds(supplier).includes(id)) continue;
    if (!isSupplierModelEnabled(supplier, id)) continue;
    return asConfig(supplier.baseUrl, supplier.apiKey, id, requestOptionsFrom(supplier));
  }
  const custom = listCustomModels(s).find(
    (m) => String(m.name == null ? '' : m.name).trim() === id && isUsableApiConfig(asConfig(m.baseUrl, m.apiKey))
  );
  if (custom) return asConfig(custom.baseUrl, custom.apiKey, id, requestOptionsFrom(custom));
  return null;
}

/**
 * 无 route 信息时的兜底，顺序刻意对齐 Renderer auto 语义：
 *   显式默认文本模型（`textModel`）→ 可用供应商 → 文本自定义模型
 *   → 顶层 baseUrl/apiKey（legacy 单模型）→ builtin
 */
function resolveDefaultApiConfig(settings) {
  const s = asSettings(settings);

  const explicit = resolveExplicitDefaultModel(s);
  if (explicit) return explicit;

  const supplier = listSuppliers(s).find((row) =>
    isUsableApiConfig(asConfig(row.baseUrl, row.apiKey))
  );
  if (supplier) {
    return asConfig(supplier.baseUrl, supplier.apiKey, pickSupplierModelId(supplier), requestOptionsFrom(supplier));
  }

  const custom = listCustomModels(s).find(
    (m) => isTextCustomModel(m) && isUsableApiConfig(asConfig(m.baseUrl, m.apiKey, m.name))
  );
  if (custom) return asConfig(custom.baseUrl, custom.apiKey, custom.name, requestOptionsFrom(custom));

  const legacy = asConfig(s.baseUrl, s.apiKey, s.textModel, requestOptionsFrom(s));
  if (isUsableApiConfig(legacy)) return legacy;

  return asConfig(s.builtinBaseUrl, s.builtinApiKey, s.textModel, requestOptionsFrom(s));
}

function parseModelRoute(route) {
  const text = String(route == null ? '' : route).trim();
  if (!text) return { kind: 'default' };

  const custom = text.match(CUSTOM_ROUTE_RE);
  if (custom) return { kind: 'custom', customId: custom[1] };

  if (BUILTIN_ROUTE_RE.test(text)) {
    // auto-builtin:<modelId> 不带 supplierId（Renderer 既有写法），此时由 resolveSupplierApiConfig 取第一个可用供应商
    const rest = text.replace(/^auto-/, '').slice('builtin:'.length);
    const idx = rest.indexOf(':');
    if (idx >= 0) {
      return { kind: 'builtin', supplierId: rest.slice(0, idx), modelId: rest.slice(idx + 1) };
    }
    return { kind: 'builtin', supplierId: '', modelId: rest };
  }

  return { kind: 'plain', name: text };
}

/**
 * route → apiConfig。
 *
 * @param {object} settings model-settings.json 内容
 * @param {string} route    custom:<id> / builtin:<supplierId>:<modelId> / auto-custom:* /
 *                          auto-builtin:* / ''（default）/ 裸模型名
 * @param {{ strict?: boolean }} [opts]
 *        strict=true：**指定的** route 失效（模型/供应商已被删）时返回不可用配置而非兜底——
 *        定时计划执行用，避免静默换 key 跑；Renderer 交互路径用默认（false）。
 *
 * 语义约定（勿改）：
 *   - route 为空（default）：无"指定但失效"可言，任何模式都走 resolveDefaultApiConfig；
 *   - 指定了 supplierId 但未命中：**任何模式都返回不可用**，绝不静默换到别的供应商；
 *   - 未指定 supplierId（builtin: / auto-builtin:<modelId>）：取第一个可用供应商。
 */
function resolveApiConfigForRoute(settings, route, opts = {}) {
  const s = asSettings(settings);
  const strict = opts.strict === true;
  const parsed = parseModelRoute(route);

  if (parsed.kind === 'default') return resolveDefaultApiConfig(s);

  if (parsed.kind === 'custom') {
    const model = findCustomModelById(s, parsed.customId);
    if (model) {
      const options = mergedRequestOptions(model, s);
      return asConfig(model.baseUrl || s.baseUrl, model.apiKey || s.apiKey, model.name, options);
    }
    return strict ? asConfig('', '') : resolveDefaultApiConfig(s);
  }

  if (parsed.kind === 'builtin') {
    if (String(parsed.supplierId || '').trim()) {
      const hit =
        listSuppliers(s).find((row) => String(row.id || '') === parsed.supplierId) || null;
      if (!hit) return asConfig('', '');
      // 路由里的 modelId 就是模型名，别丢：调用方未显式传 model 时靠它兜底
      return asConfig(
        hit.baseUrl,
        hit.apiKey,
        String(parsed.modelId || '').trim() || pickSupplierModelId(hit),
        requestOptionsFrom(hit)
      );
    }
    const cfg = resolveSupplierApiConfig(s, '');
    if (isUsableApiConfig(cfg)) return cfg;
    return strict ? cfg : resolveDefaultApiConfig(s);
  }

  // plain：裸模型名（没有 custom: / builtin: 前缀的路由记号）
  const byName = listCustomModels(s).find((m) => String(m.name || '') === parsed.name);
  if (byName) {
    const options = mergedRequestOptions(byName, s);
    return asConfig(byName.baseUrl || s.baseUrl, byName.apiKey || s.apiKey, byName.name, options);
  }
  if (strict) {
    // 记号不是任何模型名，顶层 legacy 才是它的真实配置
    const legacy = asConfig(s.baseUrl, s.apiKey, s.textModel, requestOptionsFrom(s));
    return isUsableApiConfig(legacy) ? legacy : asConfig('', '');
  }
  return resolveDefaultApiConfig(s);
}

module.exports = {
  parseModelRoute,
  resolveApiConfigForRoute,
  resolveDefaultApiConfig,
  resolveSupplierApiConfig,
  pickSupplierModelId,
  isSupplierModelEnabled,
  supplierModelIds,
  isUsableApiConfig,
  asConfig,
  requestOptionsFrom,
  mergedRequestOptions,
  listSuppliers
};

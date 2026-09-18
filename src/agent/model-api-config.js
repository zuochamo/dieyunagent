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

const CUSTOM_ROUTE_RE = /^(?:auto-)?custom:(.+)$/;
const BUILTIN_ROUTE_RE = /^(?:auto-)?builtin(?::|$)/;

function asSettings(settings) {
  return settings && typeof settings === 'object' ? settings : {};
}

function asConfig(baseUrl, apiKey, model) {
  return {
    baseUrl: String(baseUrl == null ? '' : baseUrl).trim(),
    apiKey: String(apiKey == null ? '' : apiKey).trim(),
    model: String(model == null ? '' : model).trim()
  };
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

/** 仅文本类自定义模型参与文本兜底（speech / vision 不参与）。 */
function isTextCustomModel(model) {
  const kind = String((model && model.kind) || 'text');
  return kind !== 'speech' && kind !== 'vision';
}

function findCustomModelById(settings, id) {
  const target = String(id || '');
  if (!target) return null;
  return listCustomModels(settings).find((m) => String(m.id || '') === target) || null;
}

/**
 * 供应商 → 默认模型名（供应商行自身记录的已启用模型）。
 *
 * 为什么必须有：`builtin:<supplierId>:<modelId>` 路由把模型名放在路由里，而「无 route」
 * 的调用方（定时计划、计划解析）只拿 supplier 的 baseUrl/apiKey 就解析不出模型名；
 * 此时若顶层 textModel 也为空（只用供应商配模型的用户就是这种情况），调用方最终会把
 * 空模型名交给模型服务，报「model 必填」。
 *
 * 取舍：以 enabledModels 中第一个 `!== false` 的模型为准（与 Renderer
 * isSupplierModelEnabled 同一判据），优先非 speech；无法判定时返回 ''（由调用方报错）。
 */
function pickSupplierModelId(supplier) {
  const row = supplier && typeof supplier === 'object' ? supplier : null;
  if (!row) return '';
  const enabled = row.enabledModels && typeof row.enabledModels === 'object' ? row.enabledModels : null;
  const declared = [];
  for (const map of [enabled, row.modelModalities, row.contextTierByModel]) {
    if (!map || typeof map !== 'object') continue;
    for (const id of Object.keys(map)) if (id && !declared.includes(id)) declared.push(id);
  }
  const ids = enabled
    ? declared.filter((id) => enabled[id] !== false)
    : declared;
  if (!ids.length) return '';
  const modalities = row.modelModalities && typeof row.modelModalities === 'object' ? row.modelModalities : {};
  const speakable = (id) => String(modalities[id] || 'text') === 'speech';
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
    return hit ? asConfig(hit.baseUrl, hit.apiKey, pickSupplierModelId(hit)) : asConfig('', '');
  }
  const first = listSuppliers(s).find((row) => isUsableApiConfig(asConfig(row.baseUrl, row.apiKey)));
  if (first) return asConfig(first.baseUrl, first.apiKey, pickSupplierModelId(first));
  return asConfig(s.builtinBaseUrl, s.builtinApiKey, s.textModel);
}

/**
 * 无 route 信息时的兜底，顺序刻意对齐 Renderer auto 语义：
 *   可用供应商 → 文本自定义模型 → 顶层 baseUrl/apiKey（legacy 单模型）→ builtin
 */
function resolveDefaultApiConfig(settings) {
  const s = asSettings(settings);

  const supplier = listSuppliers(s).find((row) =>
    isUsableApiConfig(asConfig(row.baseUrl, row.apiKey))
  );
  if (supplier) return asConfig(supplier.baseUrl, supplier.apiKey, pickSupplierModelId(supplier));

  const custom = listCustomModels(s).find(
    (m) => isTextCustomModel(m) && isUsableApiConfig(asConfig(m.baseUrl, m.apiKey, m.name))
  );
  if (custom) return asConfig(custom.baseUrl, custom.apiKey, custom.name);

  const legacy = asConfig(s.baseUrl, s.apiKey, s.textModel);
  if (isUsableApiConfig(legacy)) return legacy;

  return asConfig(s.builtinBaseUrl, s.builtinApiKey, s.textModel);
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
    if (model) return asConfig(model.baseUrl || s.baseUrl, model.apiKey || s.apiKey, model.name);
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
        String(parsed.modelId || '').trim() || pickSupplierModelId(hit)
      );
    }
    const cfg = resolveSupplierApiConfig(s, '');
    if (isUsableApiConfig(cfg)) return cfg;
    return strict ? cfg : resolveDefaultApiConfig(s);
  }

  // plain：裸模型名 / custom-text / custom-vision 之类的路由记号
  const byName = listCustomModels(s).find((m) => String(m.name || '') === parsed.name);
  if (byName) return asConfig(byName.baseUrl || s.baseUrl, byName.apiKey || s.apiKey, byName.name);
  if (strict) {
    // 记号不是模型名（如 custom-text），顶层 legacy 才是它的真实配置
    const legacy = asConfig(s.baseUrl, s.apiKey, s.textModel);
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
  isUsableApiConfig,
  asConfig,
  listSuppliers,
  listCustomModels
};

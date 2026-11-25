'use strict';

/**
 * 模型设置里「向量模型条目」的归一化 —— **唯一实现**。
 *
 * 为什么单独一个文件：这段逻辑此前在 `src/model-settings.js`（Main）与
 * `src/renderer/renderer-model-runtime.js`（Renderer）各写一遍，而且已经给出不同答案：
 * Renderer 那份只重建 `id/name/baseUrl/apiKey/dimensions/active` 六个键，
 * 把请求修饰字段（`headers` / `authMode` / `userAgent`）**静默丢掉**。
 * 而 `src/agent/embedding-config.js` 恰恰要读它们（`headers: buildLlmHeadersFromConfig(...)`），
 * 于是「手写进 model-settings.json 的自定义头，在设置页保存一次后就消失」——
 * 向量端点开始 401/403，界面上不会有任何报错。
 *
 * 口径：纯函数、零依赖（只用入参），Node 侧直接 `require`，Renderer 侧经
 * `agent-bundle-entry.js` 的 `register('DieyunModelSettingsEmbedding', …)` 拿到同名函数
 * （与 `clampModelRuntimeValue` 同一条通道）。两侧都调这里，不再各留一份。
 *
 * 尺寸上下限也在这里：此前 `64 / 8192` 在 Main、Renderer、`codebase/embedding-client.js`
 * 三处各写一遍，改一个就得记得改三个。
 */

const EMBEDDING_DIMENSIONS_MIN = 64;
const EMBEDDING_DIMENSIONS_MAX = 8192;
const DEFAULT_EMBEDDING_DIMENSIONS = 1024;

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

/**
 * 单条向量模型的归一化。
 *
 * `id` 用下标派生（确定性）：Renderer 以前用 `Date.now()`，同一份配置每次归一化都会换 id，
 * 编辑中的条目一旦 id 变了就会「保存两次变成两条」。
 *
 * @param {any} m
 * @param {number} index
 */
function normalizeEmbeddingEntry(m, index) {
  /** @type {{ id: string, name: string, baseUrl: string, apiKey: string, dimensions: number, active: boolean, headers?: object, authMode?: string, userAgent?: string }} */
  const entry = {
    id: String(m?.id || `embedding-${index + 1}`),
    name: String(m?.name || '').trim(),
    baseUrl: String(m?.baseUrl || '').trim(),
    apiKey: String(m?.apiKey || '').trim(),
    dimensions: Math.min(
      EMBEDDING_DIMENSIONS_MAX,
      Math.max(EMBEDDING_DIMENSIONS_MIN, Number(m?.dimensions) || DEFAULT_EMBEDDING_DIMENSIONS)
    ),
    active: m?.active === true
  };
  // 请求修饰字段：与供应商 / 自定义模型同源，由 llm-request.js 统一装配。
  // 无值时不挂键，保持既有结构契约（有值的必须原样保留，否则就是「保存即丢」）。
  if (m && m.headers) entry.headers = m.headers;
  if (m && m.authMode) entry.authMode = String(m.authMode).trim();
  if (m && m.userAgent) entry.userAgent = String(m.userAgent).trim();
  return entry;
}

/**
 * 把「磁盘上的 embeddingModels（可能是老的单条字段）」归一化成列表。
 *
 * 顺序：老单条迁移 → 丢内置 BGE → 逐条归一 → 只留「有名字 + 有端点」→ 丢历史占位条目 →
 * `active` 单选（同一时刻只跑一个向量模型；「全都不启用」是合法状态）。
 *
 * @param {any} raw 磁盘上的原始对象（用于判断 embeddingModels 键是否存在）
 * @param {any} settings 已合并默认值后的设置对象（读 embeddingModel / embeddingBaseUrl / … 做老数据迁移）
 * @returns {Array<any>}
 */
function normalizeEmbeddingModels(raw, settings) {
  const s = settings || {};
  const hasRawEmbeddingModels = raw && Object.prototype.hasOwnProperty.call(raw, 'embeddingModels');
  let source = hasRawEmbeddingModels && Array.isArray(raw.embeddingModels) ? raw.embeddingModels : [];
  // 老配置只有一条：embeddingModel / embeddingBaseUrl / … 顶层字段
  if (!hasRawEmbeddingModels && (String(s.embeddingModel || '').trim() || String(s.embeddingBaseUrl || '').trim())) {
    source = [{
      id: 'embedding-legacy',
      name: s.embeddingModel,
      baseUrl: s.embeddingBaseUrl,
      apiKey: s.embeddingApiKey,
      dimensions: s.embeddingDimensions,
      active: s.embeddingEnabled !== false
    }];
  }
  // 内置 BGE 已删除：只保留「有名字 + 有端点」的外部模型条目。
  // 另外丢掉历史占位条目（id=embedding-default 且 name=text-embedding-v4）——
  // 这条以前只在 Renderer 侧过滤，于是同一份磁盘配置两侧结论不同。
  const models = source
    .filter((m) => !isLegacyBuiltinEmbeddingEntry(m))
    .map(normalizeEmbeddingEntry)
    .filter((m) => m.name && m.baseUrl)
    .filter((m) => !(m.id === 'embedding-default' && m.name === 'text-embedding-v4'));

  // active 单选，但「全都不启用」合法：不再自动点亮第一个（以前每次都把用户关掉的那个点亮）。
  let activeSeen = false;
  return models.map((m) => {
    const active = m.active && !activeSeen;
    if (active) activeSeen = true;
    return { ...m, active };
  });
}

/**
 * 把「当前启用的那条」回填到顶层 `embedding*` 字段；没有启用的就清空。
 * 顶层字段是**派生缓存**，唯一真相是 `embeddingModels` 里的 `active` 条目。
 *
 * @param {any} settings
 * @param {Array<any>} models `normalizeEmbeddingModels` 的返回值
 * @returns {any} 同一个 settings 对象（就地改，便于两侧保持同样的写法）
 */
function applyActiveEmbedding(settings, models) {
  const s = settings || {};
  const list = Array.isArray(models) ? models : [];
  const active = list.find((m) => m.active) || null;
  s.embeddingModels = list;
  s.embeddingEnabled = !!active;
  if (!active) {
    s.embeddingModel = '';
    s.embeddingBaseUrl = '';
    s.embeddingApiKey = '';
    s.embeddingDimensions = DEFAULT_EMBEDDING_DIMENSIONS;
    return s;
  }
  s.embeddingModel = active.name;
  s.embeddingBaseUrl = active.baseUrl;
  s.embeddingApiKey = active.apiKey;
  s.embeddingDimensions = active.dimensions || DEFAULT_EMBEDDING_DIMENSIONS;
  return s;
}

module.exports = {
  EMBEDDING_DIMENSIONS_MIN,
  EMBEDDING_DIMENSIONS_MAX,
  DEFAULT_EMBEDDING_DIMENSIONS,
  isLegacyBuiltinEmbeddingEntry,
  normalizeEmbeddingEntry,
  normalizeEmbeddingModels,
  applyActiveEmbedding
};

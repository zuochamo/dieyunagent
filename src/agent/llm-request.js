'use strict';

/**
 * LLM 出站请求装配的**单一来源**：端点解析 + 请求头构造。
 *
 * 为什么必须收在一处（历史教训）：
 * 改造前「端点拼接」散落 13 份、「Content-Type + Authorization 两行头」散落 11 份，
 * 于是任何横切需求（自定义请求头、User-Agent、会话标识、非 Bearer 鉴权）都要改十几遍，
 * 且必然漏掉 Rust 压缩那处 —— 表现是「主链路正常、压缩一跑就 400」，极难定位。
 *
 * 单一来源先例：src/agent/guardrails-shared.js、src/agent/model-api-config.js。
 *
 * 职责边界（勿混）：
 *   - 本模块 = 「给定端点 + 配置，产出 URL 与 headers」——纯函数、零 IO、零 Electron。
 *   - 「用哪家供应商 / 哪个模型」是 model-api-config.js 的事；
 *   - 「怎么发、怎么重试」是 llm-proxy.js 的事。
 *
 * 被 Main 直接 require，也被 esbuild 打进 Renderer
 * （src/renderer/agent/agent-bundle-entry.js → dist/agent-bundle.js）。
 *
 * 厂商中立原则（与 AGENTS.md「禁用意图关键词硬编码」一致）：
 * 这里**不认识** opencode / openrouter / azure 等任何厂商，也不为它们写 if。
 * 厂商差异一律通过「供应商配置的自定义请求头」表达，例如：
 *   headers: { "x-opencode-session": "{{sessionId}}", "User-Agent": "my-agent/1.0" }
 */

// ---------------------------------------------------------------------------
// 端点解析
// ---------------------------------------------------------------------------

/**
 * 各类端点的相对路径与「已完整给出」的判定。
 *
 * 语义对齐改造前的各份副本（含 Azure `?api-version=` 查询串不再二次拼接）。
 */
const ENDPOINT_SPECS = {
  chat: { path: 'chat/completions', direct: /\/chat\/completions(?:\?|$)/i },
  models: { path: 'models', direct: /\/models$/i },
  embeddings: { path: 'embeddings', direct: /\/(embeddings|embed)$/i },
  transcriptions: { path: 'audio/transcriptions', direct: /\/audio\/transcriptions$/i }
};

/**
 * baseUrl + 端点类型 → 完整 URL。
 *
 * 规则（三类，顺序敏感）：
 *   1. 已经点到具体资源（含 `?query`）→ 原样返回，不再拼接；
 *   2. 以版本段结尾（`/v1` `/v2` …）→ 只补资源路径；
 *   3. 裸 host（LM Studio / 自建网关常见）→ 补 `/v1/<资源路径>`，
 *      否则会打到 `/chat/completions` 换回空 SSE（历史踩过的坑）。
 *
 * 注意：改造前 embeddings 的版本段判定写死 `/v1$`，导致 baseUrl 为 `/v2` 时会拼出
 * `/v2/v1/embeddings`。这里统一为 `/v\d+$`，属修正而非行为回归。
 *
 * baseUrl 为空返回 ''，由调用方决定是否报错（本模块不抛业务异常）。
 *
 * @param {string} baseUrl
 * @param {'chat'|'models'|'embeddings'|'transcriptions'} [kind]
 * @returns {string}
 */
function resolveLlmEndpoint(baseUrl, kind = 'chat') {
  const spec = ENDPOINT_SPECS[kind] || ENDPOINT_SPECS.chat;
  const raw = String(baseUrl == null ? '' : baseUrl)
    .trim()
    .replace(/\/+$/, '');
  if (!raw) return '';
  if (spec.direct.test(raw)) return raw;
  if (/\/v\d+$/i.test(raw)) return `${raw}/${spec.path}`;
  return `${raw}/v1/${spec.path}`;
}

// ---------------------------------------------------------------------------
// 请求头构造
// ---------------------------------------------------------------------------

/**
 * 传输层头：由 HTTP 运行时（node http / fetch / reqwest）负责。
 * 业务配置若改写它们会直接破坏请求（截断 body、错连端口），故一律拒绝。
 */
const RESERVED_HEADERS = new Set([
  'host',
  'content-length',
  'connection',
  'transfer-encoding',
  'expect',
  'upgrade'
]);

/** RFC 7230 token，用作头名合法性校验（坏头名会让上游整请求 400） */
const HEADER_NAME_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/** `{{name}}` 占位符：供应商配置里引用运行时变量（会话 id / run id / 模型名） */
const PLACEHOLDER_RE = /\{\{\s*([a-zA-Z][a-zA-Z0-9_]*)\s*\}\}/g;

/**
 * 把 `Key: Value` 多行文本解析成键值对。
 *
 * 设置页用 textarea 收集自定义头（便于从 curl / 文档直接粘贴），
 * 这里与「对象」形式共用一条归一化路径，避免 UI 与运行时各解析一份。
 * 空行与 `#` 开头注释行忽略；不含冒号的行忽略。
 *
 * @param {string} text
 * @returns {Array<[string, string]>}
 */
function parseHeaderLines(text) {
  const out = [];
  for (const line of String(text == null ? '' : text).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf(':');
    if (idx <= 0) continue;
    out.push([trimmed.slice(0, idx).trim(), trimmed.slice(idx + 1).trim()]);
  }
  return out;
}

/**
 * 归一化供应商/自定义模型上配置的请求头。
 *
 * 接受三种输入（宽进）：
 *   - 对象 `{ "X-Title": "dieyun" }`
 *   - 多行文本 `"X-Title: dieyun\nHTTP-Referer: https://..."`（textarea）
 *   - 数组 `[["X-Title", "dieyun"]]`
 *
 * 过滤（严出）：非法头名、传输层头（RESERVED_HEADERS）。
 * 值保留原始字符串（占位符留到 buildLlmHeaders 渲染，因为那里才拿得到运行时变量）。
 *
 * @param {object|string|Array} input
 * @returns {Record<string, string>}
 */
function normalizeConfiguredHeaders(input) {
  /** @type {Array<[string, unknown]>} */
  let pairs = [];
  if (!input) {
    return {};
  } else if (typeof input === 'string') {
    pairs = parseHeaderLines(input);
  } else if (Array.isArray(input)) {
    pairs = input
      .filter((row) => Array.isArray(row) && row.length >= 2)
      .map((row) => [String(row[0] == null ? '' : row[0]), row[1]]);
  } else if (typeof input === 'object') {
    pairs = Object.entries(input);
  } else {
    return {};
  }

  /** @type {Record<string, string>} */
  const out = {};
  for (const [rawName, rawValue] of pairs) {
    const name = String(rawName == null ? '' : rawName).trim();
    if (!name || !HEADER_NAME_RE.test(name)) continue;
    if (RESERVED_HEADERS.has(name.toLowerCase())) continue;
    out[name] = rawValue == null ? '' : String(rawValue);
  }
  return out;
}

/**
 * 渲染 `{{var}}` 占位符。
 *
 * 关键语义：**任一占位符取不到值 → 整条头返回 ''（调用方据此不发送）**。
 * 为什么不发半截值：`x-opencode-session: ` 这种空值头会让网关判定
 * 「有会话概念但为空」，比完全不带更糟；宁可不发，让上游按「无会话」处理。
 *
 * 不含占位符的值原样返回（trim 后）。
 *
 * @param {unknown} value
 * @param {Record<string, unknown>} [vars]
 * @returns {string}
 */
function renderHeaderTemplate(value, vars) {
  const text = value == null ? '' : String(value);
  if (!text) return '';
  let missing = false;
  const rendered = text.replace(PLACEHOLDER_RE, (_match, key) => {
    const raw = vars ? vars[key] : '';
    const resolved = raw == null ? '' : String(raw).trim();
    if (!resolved) {
      missing = true;
      return '';
    }
    return resolved;
  });
  if (missing) return '';
  return rendered.trim();
}

/**
 * 鉴权头：apiKey 的注入方式。
 *
 * `authMode` 让「非 Bearer 端点」（如自建网关用 `X-API-Key`）无需另存密钥 ——
 * 值仍来自既有 `apiKey` 字段，只是换个落点。这样新增能力不引入新的密钥存储问题。
 *
 * @param {string} apiKey
 * @param {string} [authMode]
 * @returns {Record<string, string>}
 */
function buildAuthHeaders(apiKey, authMode) {
  const key = String(apiKey == null ? '' : apiKey).trim();
  const mode = String(authMode || 'bearer').trim().toLowerCase();
  if (!key || mode === 'none') return {};
  if (mode === 'x-api-key') return { 'x-api-key': key };
  return { Authorization: `Bearer ${key}` };
}

/**
 * 产出一次 LLM 请求的完整 headers。
 *
 * 合并顺序（后者覆盖前者，语义明确）：
 *   1. 业务默认头：Content-Type / Accept
 *   2. User-Agent（单独的字段，便于设置页给专门输入框）
 *   3. 鉴权头（apiKey + authMode）
 *   4. 自定义头（可覆盖 1–3，但传输层头已在归一化时被剔除）
 *
 * @param {object} [spec]
 * @param {string} [spec.apiKey]
 * @param {string} [spec.authMode]      bearer（默认）| x-api-key | none
 * @param {object|string} [spec.headers] 供应商自定义头（支持 {{占位符}}）
 * @param {string} [spec.userAgent]
 * @param {Record<string, unknown>} [spec.vars] 占位符取值表（sessionId / runId / model）
 * @param {string} [spec.accept]        非空则设 Accept
 * @param {boolean} [spec.json]         false 时不设 Content-Type（multipart 上传用）
 * @returns {Record<string, string>}
 */
function buildLlmHeaders(spec) {
  const opts = spec && typeof spec === 'object' ? spec : {};
  /** @type {Record<string, string>} */
  const headers = {};

  if (opts.json !== false) headers['Content-Type'] = 'application/json';
  const accept = String(opts.accept == null ? '' : opts.accept).trim();
  if (accept) headers.Accept = accept;

  const vars = opts.vars && typeof opts.vars === 'object' ? opts.vars : {};

  // User-Agent：Node http 与 reqwest 默认都不发或发库名，很多网关据此判定客户端
  const userAgent = renderHeaderTemplate(opts.userAgent, vars);
  if (userAgent) headers['User-Agent'] = userAgent;

  Object.assign(headers, buildAuthHeaders(opts.apiKey, opts.authMode));

  for (const [name, rawValue] of Object.entries(normalizeConfiguredHeaders(opts.headers))) {
    const rendered = renderHeaderTemplate(rawValue, vars);
    if (!rendered) continue;
    headers[name] = rendered;
  }

  return headers;
}

/**
 * 从「模型配置对象」构造请求头 —— 收敛各调用点重复的样板。
 *
 * 配置对象即 model-api-config.js#resolveApiConfigForRoute 的产物
 * （baseUrl / apiKey / model / headers / authMode / userAgent，可另带 sessionId）。
 *
 * 为什么要有这一层：改造前 `{ 'Content-Type', Authorization: Bearer ${apiKey} }`
 * 被抄在 11 个地方，每加一个横切能力都要改 11 遍。现在所有调用点统一走这里。
 *
 * 变量合并单行规则（勿改成 `{...config, ...vars}` 式无条件覆盖）：
 *   config 上的 `sessionId` / `model` 是**基准**，`vars` 只做两件事 ——
 *     1. 补充 config 没有的键（如每轮变化的 runId）；
 *     2. 用**非空值**覆盖同名键。
 *   空值（null / undefined / ''）永不覆盖 config。
 *
 * 为什么必须这么定：`renderHeaderTemplate` 的语义是「任一占位符缺值 → 整条头不发送」。
 * 若允许空值覆盖，调用点一句 `buildLlmHeadersFromConfig(cfg, { sessionId: opts.sessionId })`
 * 在 opts 为空时就会把 config 上有效的会话 id 抹掉，导致自定义头（如 x-opencode-session）
 * 整条消失 —— 表现正是「主链路正常、压缩一跑就 400」。
 *
 * @param {object} config
 * @param {Record<string, unknown>} [vars] 额外占位符变量（如每轮变化的 runId）
 * @returns {Record<string, string>}
 */
function buildLlmHeadersFromConfig(config, vars) {
  const c = config && typeof config === 'object' ? config : {};
  const extra = vars && typeof vars === 'object' ? vars : null;
  /** @type {Record<string, unknown>} */
  const merged = { sessionId: c.sessionId, model: c.model };
  if (extra) {
    for (const [key, value] of Object.entries(extra)) {
      if (value == null || value === '') continue;
      merged[key] = value;
    }
  }
  return buildLlmHeaders({
    apiKey: c.apiKey,
    authMode: c.authMode,
    headers: c.headers,
    userAgent: c.userAgent,
    vars: merged
  });
}

module.exports = {
  RESERVED_HEADERS,
  resolveLlmEndpoint,
  parseHeaderLines,
  normalizeConfiguredHeaders,
  renderHeaderTemplate,
  buildAuthHeaders,
  buildLlmHeaders,
  buildLlmHeadersFromConfig
};

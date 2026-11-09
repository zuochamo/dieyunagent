'use strict';

const { runInEmbeddingQueue } = require('./embedding-queue');
const { buildLlmHeadersFromConfig, resolveLlmEndpoint } = require('../agent/llm-request');
const { AGENT_LIMITS_DEFAULTS } = require('../agent/agent-limits');
const crypto = require('crypto');

const EMBEDDING_DIMENSIONS_MIN = 64;
const EMBEDDING_DIMENSIONS_MAX = 8192;
const EMBEDDING_DIMENSIONS_DEFAULT = 1024;

/**
 * 查询向量缓存（只缓存「单条文本」= 查询，不缓存批量文档）。
 *
 * 为什么放在这里：同一轮里技能召回（Main 的 system-prompt-prep）与 MCP 工具召回
 * （Renderer → IPC tools:recall）会各自 embed 一次**同一句 userQuery**。嵌入是确定性的
 * （同端点 + 同模型 + 同维度 + 同文本 ⇒ 同向量），第二次请求纯属白付一次网络往返，
 * 而它正好压在「系统提示组装 → 首字输出」的关键路径上。
 *
 * 为什么不做成两个调用点各自的缓存：本文件是 embed 请求的唯一出口，缓存放别处
 * 就会变成第三份「谁在什么时候该请求向量」的实现。
 */
const QUERY_CACHE_MAX = 64;
const QUERY_CACHE_TTL_MS = 120000;
/** @type {Map<string, { at: number, vector: number[] }>} */
const queryEmbedCache = new Map();

/** 后台（批量文档）embedding 请求的墙钟上限，与 Rust 侧 `EMBED_REQUEST_TIMEOUT_MS` 成对。 */
const EMBED_REQUEST_TIMEOUT_MS = 120000;

/** 「一次交互查询最多能等多久 embedding 往返」——数字唯一来源是 agent-limits。 */
function interactiveEmbedBudgetMs() {
  const n = Number(AGENT_LIMITS_DEFAULTS.interactiveEmbedBudgetMs);
  return Number.isFinite(n) && n > 0 ? n : 10000;
}

/**
 * 最近一次往返的 `(端点键, 毫秒, 记录时刻)`：交互闸门据此判断「现在还值得发吗」。
 *
 * 为什么交互侧要有这道闸门（而不是只靠调用方的 withTimeout）：
 * 调用方超时只掐**等待者**，那个 40s 的 HTTP 还在飞、还在端点队列里。
 * 本轮放弃、下轮再排一条 ⇒ 队列永不排空，同一队列里的其他交互查询（`codebase.search`
 * 的查询向量）一起超时。所以「值不值得发」必须在发请求之前判断。
 *
 * 与 Rust 侧 `crates/dieyun-core/src/embedding/mod.rs` 同一套语义（两个进程各自量自己的
 * 端点往返）：换端点/模型（键变了）就重新量；**超时也算量到**（端点慢的证据），
 * 但 401 / 解析失败不算 —— 一次快速失败既不能证明变快也不能证明变慢。
 * 测量有有效期（{@link GATE_TTL_MS}）：过期允许再探一次，否则端点修好了也一直被关着。
 */
const GATE_TTL_MS = 5 * 60 * 1000;
let lastRoundtrip = { key: '', ms: 0, at: 0 };

function recordRoundtrip(key, ms, budgetMs) {
  lastRoundtrip = { key, ms, at: Date.now() };
  if (ms > budgetMs) {
    console.warn(
      `[dieyun:agent] embedding 端点往返 ${ms}ms > 交互预算 ${budgetMs}ms：交互查询跳过语义通道，后台写入照旧`
    );
  }
}

function isGateClosed(endpointKey, budgetMs) {
  if (lastRoundtrip.key !== endpointKey) return 0;
  if (lastRoundtrip.ms <= budgetMs) return 0;
  if (Date.now() - lastRoundtrip.at >= GATE_TTL_MS) return 0;
  return lastRoundtrip.ms;
}

function tooSlowError(ms, budgetMs) {
  const err = new Error(
    `embedding 端点最近一次往返 ${ms}ms，超过交互预算 ${budgetMs}ms：本次跳过语义通道（关键词/子串照常可用）`
  );
  err.code = 'EMBEDDING_TOO_SLOW';
  return err;
}

function queryCacheKey(url, model, dimensions, text) {
  const digest = crypto.createHash('sha1').update(String(text)).digest('hex');
  return `${url}|${model}|${dimensions}|${digest}`;
}

function readQueryCache(key) {
  const hit = queryEmbedCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > QUERY_CACHE_TTL_MS) {
    queryEmbedCache.delete(key);
    return null;
  }
  return hit.vector;
}

function writeQueryCache(key, vector) {
  if (!Array.isArray(vector) || !vector.length) return;
  if (queryEmbedCache.size >= QUERY_CACHE_MAX) {
    // 最旧优先淘汰（Map 保持插入顺序），不引入 LRU 结构：这里没有热点访问模式
    const oldest = queryEmbedCache.keys().next();
    if (!oldest.done) queryEmbedCache.delete(oldest.value);
  }
  queryEmbedCache.set(key, { at: Date.now(), vector });
}

function resolveEmbeddingsUrl(baseUrl) {
  // 端点拼接单一来源 llm-request.js（含 /embed 直连写法；空 baseUrl 返回 ''）
  return resolveLlmEndpoint(baseUrl, 'embeddings');
}

function isDirectEmbedUrl(baseUrl) {
  return /\/embed$/i.test(String(baseUrl || '').trim().replace(/\/+$/, ''));
}

/**
 * 向量客户端：**只有远程 OpenAI 兼容端点**。
 *
 * 进程内 ONNX 推理（内置 bge-base-zh-v1.5）已删除：模型体积、首次加载耗时与
 * 打包体积都不值得，语义检索改为用户在「设置 → 模型 → 向量索引」里配一个
 * 外部 embedding 端点。没配就 `enabled() === false`，召回退化为纯关键词。
 *
 * @param {{ baseUrl?: string, apiKey?: string, model?: string, dimensions?: number, disabled?: boolean,
 *   interactiveBudgetMs?: number }} config
 *   `interactiveBudgetMs` 只给测试 / 特殊调用方覆盖交互预算（默认取 agent-limits 的
 *   `interactiveEmbedBudgetMs`），不是用户开关。
 */
function createEmbeddingClient(config) {
  const model = String(config?.model || '').trim();
  const apiKey = String(config?.apiKey || '').trim();
  const url = resolveEmbeddingsUrl(config?.baseUrl);
  const dimensions = Math.min(
    EMBEDDING_DIMENSIONS_MAX,
    Math.max(EMBEDDING_DIMENSIONS_MIN, Number(config?.dimensions) || EMBEDDING_DIMENSIONS_DEFAULT)
  );
  const overrideBudget = Number(config?.interactiveBudgetMs);
  const budgetMs =
    Number.isFinite(overrideBudget) && overrideBudget > 0 ? overrideBudget : interactiveEmbedBudgetMs();
  const endpointKey = `${url}|${model}|${dimensions}`;

  function enabled() {
    return config?.disabled !== true && !!model && !!url;
  }

  /**
   * @param {string | string[]} input
   * @param {{ interactive?: boolean }} [opts] `interactive`：查询向量（每轮召回 / 代码检索）。
   *   端点已知比交互预算慢时**不发请求**，直接抛 `EMBEDDING_TOO_SLOW`，由调用方走关键词/子串通道。
   *   批量文档（建库、镜像、重建向量）不要传 —— 它们等得起，且算出来的向量是长期资产。
   * @returns {Promise<number[][]>}
   */
  async function embed(input, opts = {}) {
    if (!enabled()) {
      throw new Error('未配置 Embedding 模型');
    }
    // 单条文本 = 查询（召回用）；数组 = 批量文档（索引用，按 textHash 去重即可，不进本缓存）
    const single = !Array.isArray(input);
    const cacheKey = single ? queryCacheKey(url, model, dimensions, String(input ?? '')) : '';
    if (single) {
      const cached = readQueryCache(cacheKey);
      if (cached) return [cached];
    }
    // 命中缓存就不必打端点，所以闸门放在缓存之后：缓存的向量一秒都不用等
    if (opts.interactive) {
      const closedMs = isGateClosed(endpointKey, budgetMs);
      if (closedMs) throw tooSlowError(closedMs, budgetMs);
    }
    const out = await runInEmbeddingQueue(async () => {
      const texts = Array.isArray(input) ? input : [input];
      if (!texts.length) return [];

      const body = isDirectEmbedUrl(config?.baseUrl)
        ? {
            texts,
            model,
            dimensions
          }
        : {
            model,
            input: texts.length === 1 ? texts[0] : texts,
            dimensions
          };

      // 请求头单一来源 llm-request.js（嵌入端点同样可能要求自定义头 / User-Agent）
      const headers = buildLlmHeadersFromConfig({ ...config, apiKey });
      const startedAt = Date.now();
      // 端点可能「TCP 通但永不返回」：客户端的墙钟上限必须存在，否则这条请求会一直挂着，
      // 而闸门只在成功时更新 ⇒ 每轮召回都重新挂一次（Rust 侧同款：remote.rs 的
      // EMBED_REQUEST_TIMEOUT_MS）。交互查询用交互预算当硬上限，后台批量沿用 120s。
      const timeoutMs = opts.interactive ? budgetMs : EMBED_REQUEST_TIMEOUT_MS;
      const timeoutSignal =
        typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
          ? AbortSignal.timeout(timeoutMs)
          : undefined;
      const timeoutError = () => {
        const elapsed = Date.now() - startedAt;
        // 超时也是「量到端点有多慢」的证据：记下来闸门才会关，下一轮直接走关键词通道
        if (single) recordRoundtrip(endpointKey, elapsed, budgetMs);
        const err = new Error(
          `embedding 端点 ${timeoutMs}ms 内没有响应：本次跳过语义通道（关键词/子串照常可用）`
        );
        err.code = 'EMBEDDING_TOO_SLOW';
        return err;
      };
      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        ...(timeoutSignal ? { signal: timeoutSignal } : {})
      }).catch((e) => {
        if (e && (e.name === 'AbortError' || e.name === 'TimeoutError')) throw timeoutError();
        throw e;
      });

      const raw = await res.text().catch((e) => {
        if (e && (e.name === 'AbortError' || e.name === 'TimeoutError')) throw timeoutError();
        throw e;
      });
      let json;
      try {
        json = JSON.parse(raw);
      } catch {
        throw new Error(`Embedding 响应非 JSON：${raw.slice(0, 200)}`);
      }
      if (!res.ok || json.error) {
        const msg = json.error?.message || json.message || raw.slice(0, 240);
        throw new Error(msg);
      }

      const rows =
        json.data ||
        (Array.isArray(json.embeddings)
          ? json.embeddings.map((embedding, index) => ({ embedding, index }))
          : []);
      if (!rows.length && Array.isArray(json.vectors)) {
        rows.push(...json.vectors.map((embedding, index) => ({ embedding, index })));
      }
      if (!rows.length && Array.isArray(json.embedding)) rows.push({ embedding: json.embedding, index: 0 });
      if (!rows.length && Array.isArray(json.vector)) rows.push({ embedding: json.vector, index: 0 });
      rows.sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
      const vectors = rows.map((row) => {
        const vec = row.embedding;
        if (!Array.isArray(vec) || !vec.length) {
          throw new Error('Embedding 向量为空');
        }
        if (vec.length !== dimensions) {
          throw new Error(`Embedding dimensions mismatch: expected ${dimensions}, got ${vec.length}`);
        }
        return vec;
      });
      // 计时口径是这一次 HTTP 往返（不含串行队列排队）：队排多长取决于别的任务，
      // 端点本身快不快才是「交互查询值不值得发」的判据。
      //
      // 只记**单条**请求：批量文档一次塞几十条，耗时天然长几倍，拿它判交互查询会
      // 让一次后台建库把健康端点误判成慢端点。
      if (single) recordRoundtrip(endpointKey, Date.now() - startedAt, budgetMs);
      return vectors;
    });
    if (single && out && out[0]) writeQueryCache(cacheKey, out[0]);
    return out;
  }

  /**
   * 查询向量专用入口（每轮召回 / 代码检索 / 工具召回）：端点已知比交互预算慢时不发请求。
   * 与 `embed(input)` 是**同一份实现**，只多一道闸门 —— 别在调用点复制判断。
   */
  async function embedInteractive(input) {
    return embed(input, { interactive: true });
  }

  return {
    enabled,
    embed,
    embedInteractive,
    model,
    dimensions,
    url
  };
}

function vectorToBlob(values) {
  const arr = new Float32Array(values);
  return Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength);
}

function blobToVector(blob, dims) {
  if (!blob || !dims) return null;
  const buf = Buffer.isBuffer(blob) ? blob : Buffer.from(blob);
  if (buf.byteLength !== dims * 4) return null;
  return new Float32Array(buf.buffer, buf.byteOffset, dims);
}

function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom > 1e-8 ? dot / denom : 0;
}

module.exports = {
  createEmbeddingClient,
  vectorToBlob,
  blobToVector,
  cosineSimilarity
};

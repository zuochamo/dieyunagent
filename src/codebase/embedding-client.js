'use strict';

const { runInEmbeddingQueue } = require('./embedding-queue');
const { buildLlmHeadersFromConfig, resolveLlmEndpoint } = require('../agent/llm-request');
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
 * @param {{ baseUrl?: string, apiKey?: string, model?: string, dimensions?: number, disabled?: boolean }} config
 */
function createEmbeddingClient(config) {
  const model = String(config?.model || '').trim();
  const apiKey = String(config?.apiKey || '').trim();
  const url = resolveEmbeddingsUrl(config?.baseUrl);
  const dimensions = Math.min(
    EMBEDDING_DIMENSIONS_MAX,
    Math.max(EMBEDDING_DIMENSIONS_MIN, Number(config?.dimensions) || EMBEDDING_DIMENSIONS_DEFAULT)
  );

  function enabled() {
    return config?.disabled !== true && !!model && !!url;
  }

  /**
   * @param {string | string[]} input
   * @returns {Promise<number[][]>}
   */
  async function embed(input) {
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
      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body)
      });

      const raw = await res.text();
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
      return rows.map((row) => {
        const vec = row.embedding;
        if (!Array.isArray(vec) || !vec.length) {
          throw new Error('Embedding 向量为空');
        }
        if (vec.length !== dimensions) {
          throw new Error(`Embedding dimensions mismatch: expected ${dimensions}, got ${vec.length}`);
        }
        return vec;
      });
    });
    if (single && out && out[0]) writeQueryCache(cacheKey, out[0]);
    return out;
  }

  return {
    enabled,
    embed,
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

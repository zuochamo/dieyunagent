'use strict';

const {
  BUILTIN_EMBEDDING_DIMENSIONS,
  BUILTIN_EMBEDDING_ID,
  embedWithBuiltin,
  hasBuiltinEmbeddingModel
} = require('./local-embedding');
const { runInEmbeddingQueue } = require('./embedding-queue');

const EMBEDDING_DIMENSIONS_MIN = 64;
const EMBEDDING_DIMENSIONS_MAX = 8192;

function resolveEmbeddingsUrl(baseUrl) {
  const raw = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!raw) return '';
  if (/\/(embeddings|embed)$/i.test(raw)) return raw;
  if (/\/v1$/i.test(raw)) return `${raw}/embeddings`;
  return `${raw}/v1/embeddings`;
}

function isDirectEmbedUrl(baseUrl) {
  return /\/embed$/i.test(String(baseUrl || '').trim().replace(/\/+$/, ''));
}

/**
 * @param {{ baseUrl?: string, apiKey?: string, model?: string, dimensions?: number, builtin?: boolean, localFallback?: boolean }} config
 */
function createEmbeddingClient(config) {
  const requestedModel = String(config?.model || '').trim();
  const apiKey = String(config?.apiKey || '').trim();
  const url = resolveEmbeddingsUrl(config?.baseUrl);
  const useRemote = !!(requestedModel && url && config?.builtin !== true);
  const model = useRemote ? requestedModel : BUILTIN_EMBEDDING_ID;
  const dimensions = useRemote
    ? Math.min(EMBEDDING_DIMENSIONS_MAX, Math.max(EMBEDDING_DIMENSIONS_MIN, Number(config?.dimensions) || 1024))
    : BUILTIN_EMBEDDING_DIMENSIONS;

  function enabled() {
    if (config?.disabled === true) return false;
    if (useRemote) return true;
    if (config?.builtin === true) return config?.localFallback !== false && hasBuiltinEmbeddingModel();
    return config?.localFallback !== false && hasBuiltinEmbeddingModel();
  }

  /**
   * @param {string | string[]} input
   * @returns {Promise<number[][]>}
   */
  async function embed(input) {
    if (!enabled()) {
      throw new Error('未配置 Embedding 模型');
    }
    if (!useRemote) {
      return embedWithBuiltin(input);
    }
    return runInEmbeddingQueue(async () => {
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

      const headers = { 'Content-Type': 'application/json' };
      if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
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
        if (useRemote && vec.length !== dimensions) {
          throw new Error(`Embedding dimensions mismatch: expected ${dimensions}, got ${vec.length}`);
        }
        return vec;
      });
    });
  }

  return {
    enabled,
    embed,
    model,
    dimensions,
    url: useRemote ? url : '',
    builtin: !useRemote
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

const DEFAULT_EMBED_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1';

module.exports = {
  createEmbeddingClient,
  vectorToBlob,
  blobToVector,
  cosineSimilarity,
  DEFAULT_EMBED_URL,
  BUILTIN_EMBEDDING_ID,
  BUILTIN_EMBEDDING_DIMENSIONS
};

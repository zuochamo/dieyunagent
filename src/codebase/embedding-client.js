'use strict';

const {
  LOCAL_MODEL_NAME,
  LOCAL_DIMENSIONS,
  embeddingChannelLikelyAvailable,
  currentEmbeddingCoreConfig
} = require('../agent/embedding-config');

/**
 * 向量客户端：**一次 RPC，后端不在这里判**。
 *
 * 历史：这里曾经是「远程 OpenAI 兼容端点客户端」——自己拼请求头、自己做查询缓存、
 * 自己做「端点太慢就别发」的闸门、还挂一条全局串行队列。本地推理落地后这些全部删除：
 * 走本地还是走远端由 Rust `embedding::plan` 决定，Node 只负责把文本递过去。
 *
 * 为什么必须收敛到一处：文档向量（建库 / 记忆写入）与查询向量（召回 / 代码检索）必须出自
 * **同一个后端同一个池化口径**。两边各打各的端点时，向量空间不同不会报错，只会让相似度
 * 悄悄变差 —— 这类问题在现象上永远查不出来。
 *
 * 桥的注入：`setEmbeddingCoreBridge(coreBridge)`，由 `main-entry` / `headless/boot` 在
 * 装配时各调一次（core 是 Agent 的必需依赖，没有它就不该有向量通道）。
 */

/** @type {{ invoke?: Function, isReady?: Function } | null} */
let coreBridge = null;

function setEmbeddingCoreBridge(bridge) {
  coreBridge = bridge && typeof bridge.invoke === 'function' ? bridge : null;
}

function requireBridge() {
  if (!coreBridge || (typeof coreBridge.isReady === 'function' && !coreBridge.isReady())) {
    const err = new Error('dieyun-core 未就绪：无法计算向量');
    err.code = 'RUST_CORE_UNAVAILABLE';
    throw err;
  }
  return coreBridge;
}

/**
 * @param {{ model?: string, dimensions?: number, localModelDir?: string, baseUrl?: string,
 *   disabled?: boolean, provider?: string }} config 来自 `buildEmbeddingCoreConfig`
 */
function createEmbeddingClient(config) {
  // 参数只作兜底：真正的后端事实是「最后一次推给 Rust 的那份」（同一处装配，逐字一致）。
  // 调用点传进来的可能是 Renderer 的旧式远端配置，拿它判「有没有本地模型」必然漂移。
  const cfg = currentEmbeddingCoreConfig() || config || {};
  const model = String(cfg.model || '').trim() || (cfg.localModelDir ? LOCAL_MODEL_NAME : '');
  const dimensions = Number(cfg.dimensions) || (cfg.localModelDir ? LOCAL_DIMENSIONS : 0);

  /** 值不值得发一次 RPC（权威判定在 Rust；这里只避免明知没通道还每轮白打一次）。 */
  function enabled() {
    return embeddingChannelLikelyAvailable(cfg);
  }

  /**
   * @param {string | string[]} input
   * @returns {Promise<number[][]>}
   */
  async function embed(input) {
    if (!enabled()) {
      const err = new Error('未配置向量通道（本地模型与远端端点都不可用）');
      err.code = 'EMBEDDING_DISABLED';
      throw err;
    }
    const texts = (Array.isArray(input) ? input : [input]).map((t) => String(t ?? ''));
    if (!texts.length) return [];
    const bridge = requireBridge();
    const res = await bridge.invoke('embedding.query', { texts }, 60000);
    const vectors = Array.isArray(res && res.vectors) ? res.vectors : [];
    if (vectors.length !== texts.length) {
      throw new Error(`向量条数不匹配：请求 ${texts.length}，返回 ${vectors.length}`);
    }
    return vectors;
  }

  /**
   * 查询向量入口（召回 / 代码检索 / 技能召回）。
   *
   * 与 `embed` 是同一份实现：旧的「交互闸门」已删除（本地推理毫秒级；远端路径由 Rust
   * 用请求超时兜底，失败就降级到关键词通道，不再有「预判太慢所以不发」这一层）。
   * 保留方法名是为了不改六个调用点。
   */
  async function embedInteractive(input) {
    return embed(input);
  }

  return {
    enabled,
    embed,
    embedInteractive,
    model,
    dimensions
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
  setEmbeddingCoreBridge,
  vectorToBlob,
  blobToVector,
  cosineSimilarity
};

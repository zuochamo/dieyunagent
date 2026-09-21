'use strict';

/**
 * 向量 / 关键词检索公共件（Single Source of Truth）。
 *
 * 谁在用：
 *   - src/tools/tool-vector-index.js   （Agent 工具召回）
 *   - src/skills/vector-index.js       （技能召回）
 *   - src/playbook/playbook-index.js   （Playbook 召回）
 *
 * 这三处此前各自复制了 CJK_RE / ID_RE / tokenize / keywordScore / hashText /
 * embeddingSignature / vectorToBase64 / base64ToVector / 索引 JSON 读写 /
 * 关键词排序 / 语义+关键词混合排序，并且已经产生行为漂移
 * （playbook 版 tokenize 漏了驼峰与下划线切分）。
 *
 * 本文件是上述能力的唯一实现：要改分词、打分、向量编解码或排序，只改这里。
 * 各召回模块只保留「实体特有的」部分：文档拼装、条目字段、新鲜度判定、结果映射。
 */

const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { vectorToBlob, blobToVector, cosineSimilarity } = require('./embedding-client');

/** 中日韩统一表意文字（含扩展 A 与兼容区）。 */
const CJK_RE = /[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/g;
/** 标识符式 token：驼峰 / snake_case / kebab-case 的原料。 */
const ID_RE = /[A-Za-z_][A-Za-z0-9_-]*/g;
/** 混合排序中关键词分的权重（语义分为主，关键词为校正项）。 */
const KEYWORD_WEIGHT = 0.25;

/** 文档/查询指纹，用于判断索引条目是否仍然新鲜。 */
function hashText(text) {
  return crypto.createHash('sha1').update(String(text || '')).digest('hex');
}

/** 嵌入模型签名：模型 + 维度。空串表示当前没有可用的向量后端。 */
function embeddingSignature(client) {
  return client && client.enabled() ? `${client.model}@${client.dimensions}` : '';
}

/** number[] -> base64（Float32 紧凑存储）。 */
function vectorToBase64(values) {
  return vectorToBlob(values).toString('base64');
}

/** base64 -> Float32Array；缺失或维度不符返回 null。 */
function base64ToVector(value, dims) {
  if (!value || !dims) return null;
  return blobToVector(Buffer.from(String(value), 'base64'), dims);
}

/**
 * 统一分词：
 *   - CJK：单字 + 相邻双字
 *   - 标识符：整词 + 下划线/中划线切分后的子词
 *   - 其余：按分隔符切词，保留长度 2..64
 *
 * 注意：文本先整体 toLowerCase 再匹配标识符，因此这里只按 `[-_]` 切分。
 * 旧实现里写的是 `split(/[-_]+|(?=[A-Z])/)`，但小写化之后 `(?=[A-Z])`
 * 永远不会命中，属于死分支；这里按等价行为写成 `[-_]`。
 * 若要真正支持驼峰拆分（例如让 `recallAgentTools` 额外产出 recall/agent/tools），
 * 需要改动召回打分，并使已落盘索引失效重建，属于单独的功能变更。
 */
function tokenize(text) {
  const s = String(text || '').toLowerCase();
  const set = new Set();
  const cjk = s.match(CJK_RE);
  if (cjk) {
    for (const ch of cjk) set.add(ch);
    for (let i = 0; i < cjk.length - 1; i++) set.add(cjk[i] + cjk[i + 1]);
  }
  const ids = s.match(ID_RE);
  if (ids) {
    for (const id of ids) {
      if (id.length >= 2) set.add(id);
      for (const part of id.split(/[-_]+/).filter(Boolean)) {
        if (part.length >= 2) set.add(part);
      }
    }
  }
  for (const w of s.split(/[\s/\\._\-+:,;!?，。；：、()[\]{}"'`<>]+/)) {
    if (w.length >= 2 && w.length <= 64) set.add(w);
  }
  return set;
}

/** 关键词相似度：命中数 / sqrt(|query| * |doc|)，对长文档做长度惩罚。 */
function keywordScore(queryTokens, docTokens) {
  if (!queryTokens.size || !docTokens.size) return 0;
  let hit = 0;
  for (const token of queryTokens) {
    if (docTokens.has(token)) hit += 1;
  }
  return hit / Math.sqrt(queryTokens.size * docTokens.size);
}

/**
 * 读取 JSON 索引。文件不存在、损坏或结构不符时返回 fallback，
 * 由调用方按「空索引」继续重建。
 */
async function readIndexFile(filePath, fallback) {
  try {
    const raw = JSON.parse(await fs.readFile(filePath, 'utf8'));
    if (raw && typeof raw === 'object' && Array.isArray(raw.entries)) return raw;
  } catch {
    // 索引不存在或损坏，按空索引处理
  }
  return fallback;
}

/** 写入 JSON 索引（自动创建父目录）。 */
async function writeIndexFile(filePath, index) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(index, null, 2), 'utf8');
}

/**
 * 纯关键词排序。allowedSet 为 null 时不做 id 过滤。
 * @returns {{ entry: object, score: number, semanticScore: number, keywordScore: number }[]}
 */
function rankByKeyword(entries, query, allowedSet, limit) {
  const qTokens = tokenize(query);
  return entries
    .filter((entry) => !allowedSet || allowedSet.has(entry.id))
    .map((entry) => {
      const score = keywordScore(qTokens, new Set(entry.tokens || []));
      return { entry, score, semanticScore: 0, keywordScore: score };
    })
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

/**
 * 语义 + 关键词混合排序。向量缺失或维度不符的条目按语义 0 处理。
 * 各召回的阈值不同（见调用方常量），故由参数传入。
 *
 * @param {{ entries: object[], keywordRows: object[], queryVec: number[] | Float32Array,
 *           max: number, minSemantic: number, minKeyword: number,
 *           allowedSet?: Set<string> | null }} input
 */
function rankBySemantic({
  entries,
  keywordRows,
  queryVec,
  max,
  minSemantic,
  minKeyword,
  allowedSet = null
}) {
  const qArr = Array.isArray(queryVec) ? queryVec : Array.from(queryVec || []);
  const keywordById = new Map(keywordRows.map((row) => [row.entry.id, row.keywordScore]));
  return entries
    .filter((entry) => (!allowedSet || allowedSet.has(entry.id)) && entry.vector && entry.dims)
    .map((entry) => {
      const vec = base64ToVector(entry.vector, entry.dims);
      const semantic = vec ? cosineSimilarity(qArr, vec) : 0;
      const keyword = keywordById.get(entry.id) || 0;
      return {
        entry,
        semanticScore: semantic,
        keywordScore: keyword,
        score: semantic + keyword * KEYWORD_WEIGHT
      };
    })
    .filter((row) => row.semanticScore > minSemantic || row.keywordScore > minKeyword)
    .sort((a, b) => b.score - a.score)
    .slice(0, max);
}

module.exports = {
  CJK_RE,
  ID_RE,
  KEYWORD_WEIGHT,
  hashText,
  embeddingSignature,
  vectorToBase64,
  base64ToVector,
  tokenize,
  keywordScore,
  readIndexFile,
  writeIndexFile,
  rankByKeyword,
  rankBySemantic
};

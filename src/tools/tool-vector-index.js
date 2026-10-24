'use strict';

const path = require('path');
const { createEmbeddingClient } = require('../codebase/embedding-client');
const {
  hashText,
  embeddingSignature,
  vectorToBase64,
  tokenize,
  keywordScore,
  readIndexFile,
  writeIndexFile,
  rankByKeyword,
  rankBySemantic
} = require('../codebase/vector-index');

const INDEX_FILE = 'tool-vector-index.json';
const TOOL_EMBED_TEXT_MAX = 2000;
const QUERY_EMBED_TEXT_MAX = 1200;
const DEFAULT_LIMIT = 10;
/** 本召回特有的命中阈值，与 skills 不同，故留在调用方。 */
const SEMANTIC_MIN = 0.18;
const KEYWORD_MIN = 0;

function toolIndexPath(userData) {
  return path.join(userData, INDEX_FILE);
}

function buildToolDocument(candidate) {
  const c = candidate || {};
  return [
    c.source === 'mcp' ? `MCP服务: ${c.serverId || ''}` : `来源: ${c.source || 'optional'}`,
    `工具名: ${c.name || c.id || ''}`,
    `说明: ${c.description || ''}`
  ]
    .filter(Boolean)
    .join('\n');
}

function readIndex(userData) {
  return readIndexFile(toolIndexPath(userData), { version: 1, entries: [] });
}

function writeIndex(userData, index) {
  return writeIndexFile(toolIndexPath(userData), index);
}

function entryIsFresh(entry, candidate, signature, textHash) {
  return (
    entry &&
    entry.id === candidate.id &&
    entry.embeddingModel === signature &&
    entry.dims > 0 &&
    entry.vector &&
    entry.textHash === textHash
  );
}

async function ensureToolIndex({ userData, embeddingConfig, candidates }) {
  const client = createEmbeddingClient(embeddingConfig || {});
  const signature = embeddingSignature(client);
  const canVector = client.enabled();
  const stored = await readIndex(userData);
  const previous = new Map((stored.entries || []).map((entry) => [entry.id, entry]));
  const entries = [];
  const toEmbed = [];
  const seen = new Set();

  for (const candidate of candidates || []) {
    const id = String(candidate?.id || '').trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const document = buildToolDocument(candidate).slice(0, TOOL_EMBED_TEXT_MAX);
    const textHash = hashText(document);
    const old = previous.get(id);
    const baseEntry = {
      id,
      name: candidate.name || id,
      description: candidate.description || '',
      serverId: candidate.serverId || '',
      source: candidate.source || 'optional',
      textHash,
      tokens: Array.from(tokenize(document)).slice(0, 2000)
    };
    if (canVector && entryIsFresh(old, candidate, signature, textHash)) {
      entries.push({ ...baseEntry, embeddingModel: old.embeddingModel, dims: old.dims, vector: old.vector });
    } else if (canVector) {
      const entry = { ...baseEntry, embeddingModel: signature, dims: client.dimensions, vector: '' };
      entries.push(entry);
      toEmbed.push({ entry, document });
    } else {
      entries.push({ ...baseEntry, embeddingModel: '', dims: 0, vector: '' });
    }
  }

  if (canVector && toEmbed.length) {
    const batchSize = 16;
    for (let i = 0; i < toEmbed.length; i += batchSize) {
      const batch = toEmbed.slice(i, i + batchSize);
      const vectors = await client.embed(batch.map((item) => item.document));
      for (let j = 0; j < batch.length; j++) {
        const vec = vectors[j];
        if (Array.isArray(vec) && vec.length) {
          batch[j].entry.dims = vec.length;
          batch[j].entry.vector = vectorToBase64(vec);
        }
      }
    }
  }

  const mergedPrevious = (stored.entries || []).filter((entry) => !seen.has(entry.id));
  const next = {
    version: 1,
    embeddingModel: signature,
    indexedAt: Date.now(),
    entries: [...entries, ...mergedPrevious].slice(0, 500)
  };
  await writeIndex(userData, next);
  return { index: next, vector: canVector && !!signature };
}

/**
 * 每服务保底（A3）：语义/关键词召回容易「一个服务整体 0 命中」——该服务下的
 * 全部工具对模型完全不可见（mcp_tool_schema 只能查已召回工具的 schema，不能枚举服务）。
 * 这里在结果集内做「未覆盖服务补 1 条」，名额从「重复服务里最弱的一条」换出来，
 * 保证任何一个服务都不会被整体饿死。
 *
 * 约束：
 * - 保底预算最多 ceil(max/2)，避免把名额全给弱相关服务、挤掉真正命中的工具；
 * - 只从「出现次数 > 1」的服务里换出名额，永不吃掉某服务的唯一一条；
 * - 服务数 > max 时无法全覆盖，按分数（服务内最高）优先。
 *
 * @param {Array<{entry: object, score: number, semanticScore: number, keywordScore: number}>} rows
 * @param {object[]} entries 全部候选条目
 * @param {number} max 名额上限
 * @param {(entry: object) => number} [scoreOf] 弱相关分（缺省 0）
 */
function applyServerFloor(rows, entries, max, scoreOf) {
  const limit = Math.max(1, Number(max) || DEFAULT_LIMIT);
  if (!Array.isArray(rows) || !rows.length) return rows;
  const serverOf = (entry) => String((entry && (entry.serverId || entry.source)) || '');
  const ordered = [];
  const seenServer = new Set();
  for (const entry of entries || []) {
    const sid = serverOf(entry);
    if (!sid || seenServer.has(sid)) continue;
    seenServer.add(sid);
    ordered.push(sid);
  }
  if (ordered.length < 2) return rows;

  const covered = new Set(rows.map((row) => serverOf(row.entry)));
  const missing = ordered.filter((sid) => !covered.has(sid));
  if (!missing.length) return rows;

  const budget = Math.min(missing.length, Math.max(1, Math.ceil(limit / 2)));
  const missingSet = new Set(missing);
  const bestByServer = new Map();
  for (const entry of entries || []) {
    const sid = serverOf(entry);
    if (!missingSet.has(sid)) continue;
    const score = typeof scoreOf === 'function' ? Number(scoreOf(entry)) || 0 : 0;
    const prev = bestByServer.get(sid);
    if (!prev || score > prev.score) {
      bestByServer.set(sid, { entry, score, semanticScore: 0, keywordScore: score });
    }
  }
  const picks = [];
  for (const sid of missing) {
    const row = bestByServer.get(sid);
    if (row) picks.push({ sid, row });
  }
  if (!picks.length) return rows;
  // 分数高的优先；同分保持候选顺序（稳定排序）
  picks.sort((a, b) => b.row.score - a.row.score);
  const chosen = picks.slice(0, budget);

  const out = rows.slice();
  const countByServer = new Map();
  for (const row of out) {
    const sid = serverOf(row.entry);
    countByServer.set(sid, (countByServer.get(sid) || 0) + 1);
  }
  const added = [];
  for (const { sid, row } of chosen) {
    if (out.length < limit) {
      out.push(row);
      countByServer.set(sid, (countByServer.get(sid) || 0) + 1);
      added.push(sid);
      continue;
    }
    let evictAt = -1;
    for (let i = out.length - 1; i >= 0; i--) {
      const cur = serverOf(out[i].entry);
      if ((countByServer.get(cur) || 0) > 1 && cur !== sid) {
        evictAt = i;
        break;
      }
    }
    if (evictAt < 0) continue;
    const gone = serverOf(out[evictAt].entry);
    countByServer.set(gone, (countByServer.get(gone) || 1) - 1);
    out[evictAt] = row;
    countByServer.set(sid, (countByServer.get(sid) || 0) + 1);
    added.push(sid);
  }
  return out;
}

function diversifyByServer(rows, limit) {
  const picked = [];
  const seenServer = new Set();
  for (const row of rows) {
    const sid = row.entry.serverId || row.entry.source || row.entry.id;
    if (seenServer.has(sid)) continue;
    seenServer.add(sid);
    picked.push(row);
    if (picked.length >= limit) break;
  }
  if (picked.length < limit) {
    for (const row of rows) {
      if (picked.includes(row)) continue;
      picked.push(row);
      if (picked.length >= limit) break;
    }
  }
  return picked;
}

/**
 * @param {{ userData: string, embeddingConfig: object, candidates: object[], query: string, limit?: number }} input
 */
async function recallAgentTools(input) {
  const candidates = Array.isArray(input?.candidates) ? input.candidates : [];
  const q = String(input?.query || '').trim();
  const max = Math.min(16, Math.max(1, Number(input?.limit) || DEFAULT_LIMIT));
  const idSet = new Set(candidates.map((c) => String(c.id || '').trim()).filter(Boolean));
  if (!candidates.length) {
    return { mode: 'empty', tools: [], total: 0 };
  }
  if (candidates.length <= max) {
    return {
      mode: 'all',
      tools: candidates.map((c) => ({
        id: c.id,
        name: c.name || c.id,
        serverId: c.serverId || '',
        source: c.source || 'optional',
        score: 1
      })),
      total: candidates.length
    };
  }

  const { index, vector } = await ensureToolIndex({
    userData: input.userData,
    embeddingConfig: input.embeddingConfig,
    candidates
  });
  const entries = (index.entries || []).filter((entry) => idSet.has(entry.id));
  const keywordRows = rankByKeyword(entries, q, idSet, Math.max(max, 12));
  let rows = [];
  const queryTokens = q ? tokenize(q) : null;
  /** 未进 top-N 的候选也要能比较：用自身的 tokens 现算一次弱相关分。 */
  const scoreOf = (entry) => {
    if (!queryTokens || !entry) return 0;
    const tokens = Array.isArray(entry.tokens) ? new Set(entry.tokens) : null;
    return tokens ? keywordScore(queryTokens, tokens) : 0;
  };

  if (!q) {
    rows = diversifyByServer(
      entries.map((entry) => ({ entry, score: 0.01, semanticScore: 0, keywordScore: 0 })),
      max
    );
  } else if (vector) {
    try {
      const client = createEmbeddingClient(input.embeddingConfig || {});
      const [queryVec] = await client.embed(q.slice(0, QUERY_EMBED_TEXT_MAX));
      rows = rankBySemantic({
        entries,
        keywordRows,
        queryVec,
        max,
        minSemantic: SEMANTIC_MIN,
        minKeyword: KEYWORD_MIN,
        allowedSet: idSet
      });
      if (!rows.length) rows = keywordRows.slice(0, max);
    } catch {
      rows = keywordRows.slice(0, max);
    }
  } else {
    rows = keywordRows.slice(0, max);
    if (!rows.length) {
      rows = diversifyByServer(
        entries.map((entry) => ({ entry, score: 0.01, semanticScore: 0, keywordScore: 0 })),
        max
      );
    }
  }

  // 有 query 时按相关性召回，容易出现某 MCP 服务整体 0 命中 → 补一条保底。
  // 无 query 时 diversifyByServer 已按服务轮转，无需重复处理。
  let floored = 0;
  if (q && rows.length) {
    const before = new Set(rows.map((row) => String(row.entry.serverId || row.entry.source || '')));
    rows = applyServerFloor(rows, entries, max, scoreOf);
    for (const row of rows) {
      const sid = String(row.entry.serverId || row.entry.source || '');
      if (!before.has(sid)) floored += 1;
    }
  }

  return {
    mode: !q ? 'fallback' : vector ? 'semantic' : 'keyword',
    embeddingModel: index.embeddingModel || '',
    indexedAt: index.indexedAt || 0,
    total: entries.length,
    serverFloor: floored,
    tools: rows.map((row) => ({
      id: row.entry.id,
      name: row.entry.name,
      serverId: row.entry.serverId,
      source: row.entry.source,
      score: row.score,
      semanticScore: row.semanticScore,
      keywordScore: row.keywordScore
    }))
  };
}

module.exports = {
  recallAgentTools,
  applyServerFloor,
  diversifyByServer,
  toolIndexPath
};

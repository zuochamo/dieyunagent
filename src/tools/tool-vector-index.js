'use strict';

const path = require('path');
const { createEmbeddingClient } = require('../codebase/embedding-client');
const {
  hashText,
  embeddingSignature,
  vectorToBase64,
  tokenize,
  readIndexFile,
  writeIndexFile,
  rankByKeyword,
  rankBySemantic
} = require('../codebase/vector-index');

const INDEX_FILE = 'tool-vector-index.json';
const TOOL_EMBED_TEXT_MAX = 2000;
const QUERY_EMBED_TEXT_MAX = 1200;
const DEFAULT_LIMIT = 10;
/** 本召回特有的命中阈值，与 skills/playbook 不同，故留在调用方。 */
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

  return {
    mode: !q ? 'fallback' : vector ? 'semantic' : 'keyword',
    embeddingModel: index.embeddingModel || '',
    indexedAt: index.indexedAt || 0,
    total: entries.length,
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
  toolIndexPath
};

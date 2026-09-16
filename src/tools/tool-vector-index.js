'use strict';

const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const {
  createEmbeddingClient,
  vectorToBlob,
  blobToVector,
  cosineSimilarity
} = require('../codebase/embedding-client');

const INDEX_FILE = 'tool-vector-index.json';
const TOOL_EMBED_TEXT_MAX = 2000;
const QUERY_EMBED_TEXT_MAX = 1200;
const DEFAULT_LIMIT = 10;
const CJK_RE = /[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/g;
const ID_RE = /[A-Za-z_][A-Za-z0-9_-]*/g;

function toolIndexPath(userData) {
  return path.join(userData, INDEX_FILE);
}

function embeddingSignature(client) {
  return client && client.enabled() ? `${client.model}@${client.dimensions}` : '';
}

function hashText(text) {
  return crypto.createHash('sha1').update(String(text || '')).digest('hex');
}

function vectorToBase64(values) {
  return vectorToBlob(values).toString('base64');
}

function base64ToVector(value, dims) {
  if (!value || !dims) return null;
  return blobToVector(Buffer.from(String(value), 'base64'), dims);
}

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
      for (const part of id.split(/[-_]+|(?=[A-Z])/).filter(Boolean)) {
        if (part.length >= 2) set.add(part.toLowerCase());
      }
    }
  }
  for (const w of s.split(/[\s/\\._\-+:,;!?，。；：、()[\]{}"'`<>]+/)) {
    if (w.length >= 2 && w.length <= 64) set.add(w);
  }
  return set;
}

function keywordScore(queryTokens, docTokens) {
  if (!queryTokens.size || !docTokens.size) return 0;
  let hit = 0;
  for (const token of queryTokens) {
    if (docTokens.has(token)) hit += 1;
  }
  return hit / Math.sqrt(queryTokens.size * docTokens.size);
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

async function readIndex(userData) {
  try {
    const raw = JSON.parse(await fs.readFile(toolIndexPath(userData), 'utf8'));
    if (raw && typeof raw === 'object' && Array.isArray(raw.entries)) return raw;
  } catch {
    // ignore
  }
  return { version: 1, entries: [] };
}

async function writeIndex(userData, index) {
  const file = toolIndexPath(userData);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(index, null, 2), 'utf8');
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

function rankByKeyword(entries, query, idSet, limit) {
  const qTokens = tokenize(query);
  return entries
    .filter((entry) => !idSet || idSet.has(entry.id))
    .map((entry) => {
      const score = keywordScore(qTokens, new Set(entry.tokens || []));
      return { entry, score, semanticScore: 0, keywordScore: score };
    })
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
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
      const qArr = Array.isArray(queryVec) ? queryVec : Array.from(queryVec || []);
      const keywordById = new Map(keywordRows.map((row) => [row.entry.id, row.keywordScore]));
      rows = entries
        .filter((entry) => entry.vector && entry.dims)
        .map((entry) => {
          const vec = base64ToVector(entry.vector, entry.dims);
          const semantic = vec ? cosineSimilarity(qArr, vec) : 0;
          const keyword = keywordById.get(entry.id) || 0;
          return {
            entry,
            semanticScore: semantic,
            keywordScore: keyword,
            score: semantic + keyword * 0.25
          };
        })
        .filter((row) => row.semanticScore > 0.18 || row.keywordScore > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, max);
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

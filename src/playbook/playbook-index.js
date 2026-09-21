'use strict';

const path = require('path');
const crypto = require('crypto');
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
const { extractSummaryFromMarkdown } = require('./playbook-service');

const QUERY_EMBED_TEXT_MAX = 1200;
const DOC_EMBED_TEXT_MAX = 2000;
const DEFAULT_LIMIT = 3;
/** 本召回特有的命中阈值（比技能召回更宽松，召回优先）。 */
const SEMANTIC_MIN = 0.18;
const KEYWORD_MIN = 0;

function workspaceIndexKey(workspacePath) {
  const p = String(workspacePath || '').trim();
  if (!p) return 'default';
  return crypto.createHash('sha256').update(p).digest('hex').slice(0, 16);
}

function vectorIndexPath(userData, workspacePath) {
  return path.join(userData, 'playbook-indices', `${workspaceIndexKey(workspacePath)}.json`);
}

function buildPlaybookDocument(entry) {
  return [
    `Playbook: ${entry.title || entry.id}`,
    `领域: ${entry.domain || 'general'}`,
    `路径: ${entry.path || ''}`,
    `摘要: ${entry.summary || ''}`
  ].join('\n');
}

function readVectorIndex(userData, workspacePath) {
  return readIndexFile(vectorIndexPath(userData, workspacePath), {
    version: 1,
    workspacePath,
    entries: []
  });
}

function writeVectorIndex(userData, workspacePath, index) {
  return writeIndexFile(vectorIndexPath(userData, workspacePath), {
    version: 1,
    workspacePath,
    embeddingModel: index.embeddingModel || '',
    indexedAt: Date.now(),
    entries: index.entries || []
  });
}

async function upsertPlaybookVector(userData, workspacePath, embeddingConfig, entry, markdown) {
  const client = createEmbeddingClient(embeddingConfig || {});
  if (!client.enabled()) return;
  const summary = entry.summary || extractSummaryFromMarkdown(markdown, 800);
  const document = buildPlaybookDocument({ ...entry, summary }).slice(0, DOC_EMBED_TEXT_MAX);
  const signature = embeddingSignature(client);
  const textHash = hashText(document);
  const stored = await readVectorIndex(userData, workspacePath);
  const entries = (stored.entries || []).filter((e) => e.id !== entry.id);
  const [vec] = await client.embed(document);
  entries.unshift({
    id: entry.id,
    title: entry.title || entry.id,
    domain: entry.domain || 'general',
    path: entry.path || '',
    summary,
    textHash,
    embeddingModel: signature,
    dims: Array.isArray(vec) ? vec.length : 0,
    vector: Array.isArray(vec) && vec.length ? vectorToBase64(vec) : '',
    tokens: Array.from(tokenize(document)).slice(0, 1500)
  });
  await writeVectorIndex(userData, workspacePath, {
    embeddingModel: signature,
    entries: entries.slice(0, 200)
  });
}

async function syncVectorIndexFromCatalog(userData, workspacePath, embeddingConfig, catalogEntries) {
  const client = createEmbeddingClient(embeddingConfig || {});
  const canVector = client.enabled();
  const signature = embeddingSignature(client);
  const stored = await readVectorIndex(userData, workspacePath);
  const previous = new Map((stored.entries || []).map((e) => [e.id, e]));
  const entries = [];
  const toEmbed = [];

  for (const item of catalogEntries || []) {
    if (!item || !item.id || item.status === 'archived') continue;
    const base = {
      id: item.id,
      title: item.title || item.id,
      domain: item.domain || 'general',
      path: item.path || '',
      summary: item.summary || ''
    };
    const document = buildPlaybookDocument(base).slice(0, DOC_EMBED_TEXT_MAX);
    const textHash = hashText(document);
    const old = previous.get(item.id);
    if (canVector && old && old.textHash === textHash && old.vector && old.embeddingModel === signature) {
      entries.push(old);
    } else if (canVector) {
      const row = {
        ...base,
        textHash,
        embeddingModel: signature,
        dims: client.dimensions,
        vector: '',
        tokens: Array.from(tokenize(document)).slice(0, 1500)
      };
      entries.push(row);
      toEmbed.push({ row, document });
    } else {
      entries.push({
        ...base,
        textHash,
        embeddingModel: '',
        dims: 0,
        vector: '',
        tokens: Array.from(tokenize(document)).slice(0, 1500)
      });
    }
  }

  if (canVector && toEmbed.length) {
    const batchSize = 8;
    for (let i = 0; i < toEmbed.length; i += batchSize) {
      const batch = toEmbed.slice(i, i + batchSize);
      const vectors = await client.embed(batch.map((b) => b.document));
      for (let j = 0; j < batch.length; j++) {
        const vec = vectors[j];
        if (Array.isArray(vec) && vec.length) {
          batch[j].row.dims = vec.length;
          batch[j].row.vector = vectorToBase64(vec);
        }
      }
    }
  }

  await writeVectorIndex(userData, workspacePath, { embeddingModel: signature, entries });
  return { vector: canVector && !!signature, entries };
}

async function recallPlaybooks({ userData, workspacePath, embeddingConfig, catalogEntries, query, limit }) {
  const max = Math.min(8, Math.max(1, Number(limit) || DEFAULT_LIMIT));
  const active = (catalogEntries || []).filter((e) => e && e.id && e.status !== 'archived');
  if (!active.length) {
    return { mode: 'empty', results: [], total: 0 };
  }

  const { vector, entries } = await syncVectorIndexFromCatalog(
    userData,
    workspacePath,
    embeddingConfig,
    active
  );
  const q = String(query || '').trim();
  const idSet = new Set(active.map((e) => e.id));
  const scoped = entries.filter((e) => idSet.has(e.id));

  if (!q) {
    const recent = active.slice(0, max).map((e) => ({
      id: e.id,
      title: e.title,
      domain: e.domain,
      path: e.path,
      summary: e.summary,
      score: 0.01
    }));
    return { mode: 'recent', results: recent, total: active.length };
  }

  const keywordRows = rankByKeyword(scoped, q, null, scoped.length);

  let rows = [];
  if (vector) {
    try {
      const client = createEmbeddingClient(embeddingConfig || {});
      const [queryVec] = await client.embed(q.slice(0, QUERY_EMBED_TEXT_MAX));
      rows = rankBySemantic({
        entries: scoped,
        keywordRows,
        queryVec,
        max,
        minSemantic: SEMANTIC_MIN,
        minKeyword: KEYWORD_MIN
      });
    } catch {
      rows = keywordRows.slice(0, max);
    }
  } else {
    rows = keywordRows.slice(0, max);
  }

  if (!rows.length) {
    rows = active.slice(0, max).map((entry) => ({
      entry: {
        id: entry.id,
        title: entry.title,
        domain: entry.domain,
        path: entry.path,
        summary: entry.summary
      },
      score: 0.01,
      semanticScore: 0,
      keywordScore: 0
    }));
  }

  return {
    mode: vector ? 'semantic' : rows.length ? 'keyword' : 'recent',
    embeddingModel: embeddingSignature(createEmbeddingClient(embeddingConfig || {})),
    total: active.length,
    results: rows.map((row) => ({
      id: row.entry.id,
      title: row.entry.title,
      domain: row.entry.domain,
      path: row.entry.path,
      summary: row.entry.summary,
      score: row.score,
      semanticScore: row.semanticScore,
      keywordScore: row.keywordScore
    }))
  };
}

module.exports = {
  recallPlaybooks,
  upsertPlaybookVector,
  syncVectorIndexFromCatalog
};

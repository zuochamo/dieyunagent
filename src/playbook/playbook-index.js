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
const { extractSummaryFromMarkdown } = require('./playbook-service');

const QUERY_EMBED_TEXT_MAX = 1200;
const DOC_EMBED_TEXT_MAX = 2000;
const DEFAULT_LIMIT = 3;
const CJK_RE = /[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/g;
const ID_RE = /[A-Za-z_][A-Za-z0-9_-]*/g;

function workspaceIndexKey(workspacePath) {
  const p = String(workspacePath || '').trim();
  if (!p) return 'default';
  return crypto.createHash('sha256').update(p).digest('hex').slice(0, 16);
}

function vectorIndexPath(userData, workspacePath) {
  return path.join(userData, 'playbook-indices', `${workspaceIndexKey(workspacePath)}.json`);
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

function buildPlaybookDocument(entry) {
  return [
    `Playbook: ${entry.title || entry.id}`,
    `领域: ${entry.domain || 'general'}`,
    `路径: ${entry.path || ''}`,
    `摘要: ${entry.summary || ''}`
  ].join('\n');
}

async function readVectorIndex(userData, workspacePath) {
  try {
    const raw = JSON.parse(await fs.readFile(vectorIndexPath(userData, workspacePath), 'utf8'));
    if (raw && Array.isArray(raw.entries)) return raw;
  } catch {
    // ignore
  }
  return { version: 1, workspacePath, entries: [] };
}

async function writeVectorIndex(userData, workspacePath, index) {
  const file = vectorIndexPath(userData, workspacePath);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(
    file,
    JSON.stringify(
      {
        version: 1,
        workspacePath,
        embeddingModel: index.embeddingModel || '',
        indexedAt: Date.now(),
        entries: index.entries || []
      },
      null,
      2
    ),
    'utf8'
  );
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

  const qTokens = tokenize(q);
  const keywordRows = scoped
    .map((entry) => {
      const score = keywordScore(qTokens, new Set(entry.tokens || []));
      return { entry, score, semanticScore: 0, keywordScore: score };
    })
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score);

  let rows = [];
  if (vector) {
    try {
      const client = createEmbeddingClient(embeddingConfig || {});
      const [queryVec] = await client.embed(q.slice(0, QUERY_EMBED_TEXT_MAX));
      const qArr = Array.isArray(queryVec) ? queryVec : Array.from(queryVec || []);
      rows = scoped
        .filter((entry) => entry.vector && entry.dims)
        .map((entry) => {
          const vec = base64ToVector(entry.vector, entry.dims);
          const semantic = vec ? cosineSimilarity(qArr, vec) : 0;
          const keyword = keywordRows.find((r) => r.entry.id === entry.id)?.keywordScore || 0;
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

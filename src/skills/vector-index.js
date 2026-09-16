'use strict';

const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { scanSkills, readSkillContent } = require('./scanner');
const {
  createEmbeddingClient,
  vectorToBlob,
  blobToVector,
  cosineSimilarity
} = require('../codebase/embedding-client');

const INDEX_FILE = 'skill-vector-index.json';
const SKILL_EMBED_TEXT_MAX = 6000;
const QUERY_EMBED_TEXT_MAX = 1200;
const DEFAULT_LIMIT = 8;
const CJK_RE = /[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/g;
const ID_RE = /[A-Za-z_][A-Za-z0-9_-]*/g;

function compactText(text, max = 600) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max).trim()}...` : s;
}

function skillIndexPath(userData) {
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

async function readIndex(userData) {
  try {
    const raw = JSON.parse(await fs.readFile(skillIndexPath(userData), 'utf8'));
    if (raw && typeof raw === 'object' && Array.isArray(raw.entries)) return raw;
  } catch {
    // ignore
  }
  return { version: 1, entries: [] };
}

async function writeIndex(userData, index) {
  const file = skillIndexPath(userData);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(index, null, 2), 'utf8');
}

async function statSkill(skill) {
  try {
    const st = await fs.stat(skill.skillPath);
    return { mtimeMs: Math.floor(st.mtimeMs), size: st.size };
  } catch {
    return { mtimeMs: 0, size: 0 };
  }
}

async function buildSkillDocument(skill) {
  let data = null;
  try {
    data = await readSkillContent(skill.skillPath);
  } catch {
    data = {};
  }
  const body = String(data.content || '').slice(0, SKILL_EMBED_TEXT_MAX);
  const meta = data.meta || {};
  return [
    `技能ID: ${skill.id}`,
    `技能名称: ${data.name || skill.name || ''}`,
    `分类: ${skill.category || meta.category || ''}`,
    `中文简介: ${data.descriptionZh || skill.descriptionZh || ''}`,
    `英文简介: ${data.descriptionEn || skill.descriptionEn || ''}`,
    `简介: ${data.description || skill.description || skill.preview || ''}`,
    meta.triggers ? `触发词: ${meta.triggers}` : '',
    meta.tags ? `标签: ${meta.tags}` : '',
    body ? `说明正文: ${body}` : ''
  ]
    .filter(Boolean)
    .join('\n');
}

function entryIsFresh(entry, skill, stat, signature, textHash) {
  return (
    entry &&
    entry.id === skill.id &&
    entry.skillPath === skill.skillPath &&
    entry.embeddingModel === signature &&
    entry.dims > 0 &&
    entry.vector &&
    entry.mtimeMs === stat.mtimeMs &&
    entry.size === stat.size &&
    entry.textHash === textHash
  );
}

async function ensureSkillIndex({ userData, workspacePath, embeddingConfig }) {
  const catalog = await scanSkills({ userData, workspacePath });
  const client = createEmbeddingClient(embeddingConfig || {});
  const signature = embeddingSignature(client);
  const canVector = client.enabled();
  const stored = await readIndex(userData);
  const previous = new Map((stored.entries || []).map((entry) => [entry.id, entry]));
  const entries = [];
  const toEmbed = [];
  const seenSkillIds = new Set();

  for (const skill of catalog.skills || []) {
    if (!skill.id || !skill.skillPath) continue;
    if (seenSkillIds.has(skill.id)) continue;
    seenSkillIds.add(skill.id);
    const stat = await statSkill(skill);
    const document = await buildSkillDocument(skill);
    const textHash = hashText(document);
    const old = previous.get(skill.id);
    const baseEntry = {
      id: skill.id,
      name: skill.name || '',
      description: skill.description || '',
      descriptionZh: skill.descriptionZh || '',
      descriptionEn: skill.descriptionEn || '',
      category: skill.category || '',
      dir: skill.dir || '',
      skillPath: skill.skillPath,
      builtin: !!skill.builtin,
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      textHash,
      textPreview: compactText(document, 900),
      tokens: Array.from(tokenize(document)).slice(0, 2000)
    };
    if (canVector && entryIsFresh(old, skill, stat, signature, textHash)) {
      entries.push({ ...baseEntry, embeddingModel: old.embeddingModel, dims: old.dims, vector: old.vector });
    } else if (canVector) {
      const entry = { ...baseEntry, embeddingModel: signature, dims: client.dimensions, vector: '' };
      entries.push(entry);
      toEmbed.push({ entry, document: document.slice(0, SKILL_EMBED_TEXT_MAX) });
    } else {
      entries.push({ ...baseEntry, embeddingModel: '', dims: 0, vector: '' });
    }
  }

  if (canVector && toEmbed.length) {
    const batchSize = 8;
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

  const next = {
    version: 1,
    embeddingModel: signature,
    indexedAt: Date.now(),
    entries
  };
  await writeIndex(userData, next);
  return { catalog, index: next, vector: canVector && !!signature };
}

function rankByKeyword(entries, query, enabledSet, limit) {
  const qTokens = tokenize(query);
  return entries
    .filter((entry) => !enabledSet || enabledSet.has(entry.id))
    .map((entry) => {
      const score = keywordScore(qTokens, new Set(entry.tokens || []));
      return { entry, score, semanticScore: 0, keywordScore: score };
    })
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

async function recallSkills({
  userData,
  workspacePath,
  embeddingConfig,
  enabledIds,
  query,
  limit = DEFAULT_LIMIT
}) {
  const q = String(query || '').trim();
  const max = Math.min(12, Math.max(1, Number(limit) || DEFAULT_LIMIT));
  if (!q) return { mode: 'empty', skills: [] };
  const enabledSet = Array.isArray(enabledIds) && enabledIds.length ? new Set(enabledIds.map(String)) : null;
  const { index, vector } = await ensureSkillIndex({ userData, workspacePath, embeddingConfig });
  const entries = index.entries || [];
  const keywordRows = rankByKeyword(entries, q, enabledSet, Math.max(max, 12));
  let rows = [];

  if (vector) {
    try {
      const client = createEmbeddingClient(embeddingConfig || {});
      const [queryVec] = await client.embed(q.slice(0, QUERY_EMBED_TEXT_MAX));
      const qArr = Array.isArray(queryVec) ? queryVec : Array.from(queryVec || []);
      const keywordById = new Map(keywordRows.map((row) => [row.entry.id, row.keywordScore]));
      rows = entries
        .filter((entry) => (!enabledSet || enabledSet.has(entry.id)) && entry.vector && entry.dims)
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
        .filter((row) => row.semanticScore > 0.28 || row.keywordScore > 0.35)
        .sort((a, b) => b.score - a.score)
        .slice(0, max);
    } catch {
      rows = keywordRows.slice(0, max);
    }
  } else {
    rows = keywordRows.slice(0, max);
  }

  return {
    mode: vector ? 'semantic' : 'keyword',
    embeddingModel: index.embeddingModel || '',
    indexedAt: index.indexedAt || 0,
    total: entries.length,
    skills: rows.map((row) => ({
      id: row.entry.id,
      name: row.entry.name,
      description: row.entry.description,
      descriptionZh: row.entry.descriptionZh,
      descriptionEn: row.entry.descriptionEn,
      category: row.entry.category,
      dir: row.entry.dir,
      skillPath: row.entry.skillPath,
      builtin: row.entry.builtin,
      score: row.score,
      semanticScore: row.semanticScore,
      keywordScore: row.keywordScore
    }))
  };
}

module.exports = {
  ensureSkillIndex,
  recallSkills,
  skillIndexPath
};

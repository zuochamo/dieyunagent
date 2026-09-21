'use strict';

const fs = require('fs/promises');
const path = require('path');
const { scanSkills, readSkillContent } = require('./scanner');
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

const INDEX_FILE = 'skill-vector-index.json';
const SKILL_EMBED_TEXT_MAX = 6000;
const QUERY_EMBED_TEXT_MAX = 1200;
const DEFAULT_LIMIT = 8;
/** 本召回特有的命中阈值，比 tool/playbook 更严格以避免技能误召回。 */
const SEMANTIC_MIN = 0.28;
const KEYWORD_MIN = 0.35;

function compactText(text, max = 600) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max).trim()}...` : s;
}

function skillIndexPath(userData) {
  return path.join(userData, INDEX_FILE);
}

function readIndex(userData) {
  return readIndexFile(skillIndexPath(userData), { version: 1, entries: [] });
}

function writeIndex(userData, index) {
  return writeIndexFile(skillIndexPath(userData), index);
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
      rows = rankBySemantic({
        entries,
        keywordRows,
        queryVec,
        max,
        minSemantic: SEMANTIC_MIN,
        minKeyword: KEYWORD_MIN,
        allowedSet: enabledSet
      });
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

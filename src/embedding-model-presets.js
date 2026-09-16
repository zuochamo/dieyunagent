'use strict';

const {
  BUILTIN_EMBEDDING_DIMENSIONS,
  BUILTIN_EMBEDDING_ID,
  BUILTIN_EMBEDDING_NAME
} = require('./codebase/local-embedding');

const BUILTIN_EMBEDDING_LIST_ID = 'embedding-builtin-bge-base-zh-v1.5';

function isBuiltinEmbeddingListEntry(model) {
  if (!model) return false;
  if (model.builtin === true) return true;
  const id = String(model.id || '');
  return id === BUILTIN_EMBEDDING_LIST_ID || id.startsWith('embedding-builtin-');
}

function createBuiltinEmbeddingListEntry(active = false) {
  return {
    id: BUILTIN_EMBEDDING_LIST_ID,
    name: BUILTIN_EMBEDDING_NAME,
    baseUrl: '内置',
    apiKey: '',
    dimensions: BUILTIN_EMBEDDING_DIMENSIONS,
    active: active === true,
    builtin: true
  };
}

/** 用户自定义项 + 末尾固定内置项（不可删） */
function mergeEmbeddingModelsList(models) {
  const list = Array.isArray(models) ? models : [];
  const userModels = list.filter((m) => !isBuiltinEmbeddingListEntry(m));
  const prevBuiltin = list.find((m) => isBuiltinEmbeddingListEntry(m));
  const activeDefault = prevBuiltin != null ? prevBuiltin.active !== false : true;
  return [...userModels, createBuiltinEmbeddingListEntry(activeDefault)];
}

function resolveActiveEmbeddingModel(models) {
  const merged = mergeEmbeddingModelsList(models);
  return merged.find((m) => m.active) || null;
}

module.exports = {
  BUILTIN_EMBEDDING_LIST_ID,
  BUILTIN_EMBEDDING_ID,
  BUILTIN_EMBEDDING_NAME,
  BUILTIN_EMBEDDING_DIMENSIONS,
  isBuiltinEmbeddingListEntry,
  createBuiltinEmbeddingListEntry,
  mergeEmbeddingModelsList,
  resolveActiveEmbeddingModel
};

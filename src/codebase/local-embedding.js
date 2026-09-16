'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { BGE_MODEL_NAME, BGE_ASSET_ID, OPTIONAL_ASSETS } = require('../optional-assets/manifest');

const BUILTIN_EMBEDDING_ID = 'builtin:bge-base-zh-v1.5';
const BUILTIN_EMBEDDING_NAME = BGE_MODEL_NAME;
const BUILTIN_EMBEDDING_DIMENSIONS = 768;

let extractorPromise = null;

function userDataRoots() {
  const dirs = [];
  try {
    const { app } = require('electron');
    if (app && typeof app.getPath === 'function') {
      dirs.push(app.getPath('userData'));
    }
  } catch {
    // CLI / tests: no Electron
  }
  dirs.push(
    path.join(os.homedir(), 'AppData', 'Roaming', 'dieyunagent'),
    path.join(os.homedir(), 'AppData', 'Roaming', 'pixel-office-agent')
  );
  return dirs;
}

function optionalInstallDirName() {
  const def = OPTIONAL_ASSETS[BGE_ASSET_ID];
  return (def && def.installDirName) || BUILTIN_EMBEDDING_NAME;
}

function candidateModelDirs() {
  const dirs = [];
  const installName = optionalInstallDirName();
  for (const ud of userDataRoots()) {
    if (ud) dirs.push(path.join(ud, '.dieyun', 'optional-assets', installName));
  }
  if (process.resourcesPath) {
    dirs.push(path.join(process.resourcesPath, 'models', BUILTIN_EMBEDDING_NAME));
  }
  dirs.push(path.resolve(__dirname, '..', '..', 'models', BUILTIN_EMBEDDING_NAME));
  dirs.push(path.resolve(process.cwd(), 'models', BUILTIN_EMBEDDING_NAME));
  const seen = new Set();
  return dirs.filter((d) => {
    const key = path.resolve(d);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function resolveBuiltinModelDir() {
  const dir = candidateModelDirs().find((p) => fs.existsSync(path.join(p, 'onnx', 'model_quantized.onnx')));
  if (!dir) {
    throw new Error(
      `内置向量模型未安装：请在设置 → 组件下载「${BUILTIN_EMBEDDING_NAME}」，或手动安装 zip`
    );
  }
  return dir;
}

async function ensureBuiltinModelAvailable() {
  return resolveBuiltinModelDir();
}

function resetBuiltinExtractor() {
  extractorPromise = null;
}

async function loadExtractor() {
  if (!extractorPromise) {
    extractorPromise = (async () => {
      const { pipeline, env } = await import('@huggingface/transformers');
      env.allowRemoteModels = false;
      env.allowLocalModels = true;
      return pipeline('feature-extraction', resolveBuiltinModelDir(), {
        dtype: 'q8',
        local_files_only: true
      });
    })();
  }
  return extractorPromise;
}

function normalizeEmbeddingOutput(output, count) {
  const rows = output?.tolist ? output.tolist() : output;
  if (!Array.isArray(rows)) return [];
  if (count === 1 && rows.length === BUILTIN_EMBEDDING_DIMENSIONS && typeof rows[0] === 'number') {
    return [rows];
  }
  return rows.map((row) => (Array.isArray(row) ? row : [])).filter((row) => row.length);
}

async function embedWithBuiltin(input) {
  const { runInEmbeddingQueue } = require('./embedding-queue');
  return runInEmbeddingQueue(async () => {
    const { beginComponentUse, endComponentUse } = require('../optional-assets/usage');
    beginComponentUse(BGE_ASSET_ID);
    try {
      await ensureBuiltinModelAvailable();
      const texts = (Array.isArray(input) ? input : [input])
        .map((text) => String(text || '').trim())
        .filter(Boolean);
      if (!texts.length) return [];
      const extractor = await loadExtractor();
      const output = await extractor(texts, { pooling: 'mean', normalize: true });
      const vectors = normalizeEmbeddingOutput(output, texts.length);
      return vectors.map((vec) => {
        if (vec.length !== BUILTIN_EMBEDDING_DIMENSIONS) {
          throw new Error(`内置向量维度异常：${vec.length}`);
        }
        return vec;
      });
    } finally {
      endComponentUse(BGE_ASSET_ID);
    }
  });
}

function hasBuiltinEmbeddingModel() {
  try {
    resolveBuiltinModelDir();
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  BUILTIN_EMBEDDING_ID,
  BUILTIN_EMBEDDING_NAME,
  BUILTIN_EMBEDDING_DIMENSIONS,
  embedWithBuiltin,
  hasBuiltinEmbeddingModel,
  resolveBuiltinModelDir,
  ensureBuiltinModelAvailable,
  resetBuiltinExtractor,
  candidateModelDirs
};

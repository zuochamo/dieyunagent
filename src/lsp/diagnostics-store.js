'use strict';

const path = require('path');

const ENGINE_KEYS = ['lsp', 'tsc', 'pyright', 'eslint', 'ruff', 'prettier', 'report'];

function normalizeStoreFileKey(file) {
  const raw = String(file || '').trim().replace(/\\/g, '/');
  if (raw.startsWith('/')) return raw.toLowerCase();
  return path.resolve(raw).toLowerCase();
}

function diagSignature(d) {
  return `${d.line}:${d.col}:${d.code || ''}:${d.message || ''}:${d.severity || ''}:${d.source || ''}`;
}

function mergeDiagnosticsLayers(byEngine) {
  const out = [];
  const seen = new Set();
  for (const key of ENGINE_KEYS) {
    const layer = byEngine && byEngine[key];
    if (!layer || !Array.isArray(layer.diagnostics)) continue;
    for (const d of layer.diagnostics) {
      const sig = diagSignature(d);
      if (seen.has(sig)) continue;
      seen.add(sig);
      out.push(d);
    }
  }
  for (const [key, layer] of Object.entries(byEngine || {})) {
    if (ENGINE_KEYS.includes(key)) continue;
    if (!layer || !Array.isArray(layer.diagnostics)) continue;
    for (const d of layer.diagnostics) {
      const sig = diagSignature(d);
      if (seen.has(sig)) continue;
      seen.add(sig);
      out.push(d);
    }
  }
  out.sort((a, b) => {
    const ae = a.severity === 'error' ? 0 : a.severity === 'warning' ? 1 : 2;
    const be = b.severity === 'error' ? 0 : b.severity === 'warning' ? 1 : 2;
    if (ae !== be) return ae - be;
    return (a.line || 0) - (b.line || 0) || (a.col || 0) - (b.col || 0);
  });
  return out;
}

function buildItemView(entry) {
  const diagnostics = mergeDiagnosticsLayers(entry.byEngine);
  const sources = [];
  for (const key of ENGINE_KEYS) {
    const layer = entry.byEngine[key];
    if (layer && Array.isArray(layer.diagnostics) && layer.diagnostics.length) {
      sources.push(layer.source || key);
    }
  }
  const primaryLayer =
    entry.byEngine.lsp ||
    entry.byEngine.tsc ||
    entry.byEngine.pyright ||
    entry.byEngine.eslint ||
    entry.byEngine.ruff ||
    entry.byEngine.prettier ||
    Object.values(entry.byEngine)[0];
  return {
    file: entry.file,
    diagnostics,
    ts: entry.ts,
    language: entry.language || '',
    server: primaryLayer ? primaryLayer.server : 'store',
    source: sources[0] || 'store',
    sources,
    byEngine: entry.byEngine
  };
}

function upsertEngineLayer(bucket, file, engineKey, item) {
  const raw = String(file || '').trim().replace(/\\/g, '/');
  const abs = raw.startsWith('/') ? raw : path.resolve(raw);
  const key = normalizeStoreFileKey(abs);
  let entry = bucket.get(key);
  if (!entry) {
    entry = { file: abs, language: '', byEngine: {}, ts: 0 };
  }

  entry.byEngine[engineKey] = {
    diagnostics: Array.isArray(item.diagnostics) ? item.diagnostics : [],
    ts: Date.now(),
    server: item.server ? String(item.server) : String(engineKey),
    source: item.source ? String(item.source) : String(engineKey)
  };
  if (item.language) entry.language = String(item.language);
  entry.ts = Date.now();

  const merged = mergeDiagnosticsLayers(entry.byEngine);
  if (!merged.length) {
    bucket.delete(key);
    return null;
  }
  bucket.set(key, entry);
  return buildItemView(entry);
}

function clearEngineLayer(bucket, engineKey) {
  for (const [key, entry] of [...bucket.entries()]) {
    if (!entry.byEngine[engineKey]) continue;
    delete entry.byEngine[engineKey];
    if (!mergeDiagnosticsLayers(entry.byEngine).length) {
      bucket.delete(key);
    } else {
      entry.ts = Date.now();
    }
  }
}

function removeFileFromBucket(bucket, file) {
  bucket.delete(normalizeStoreFileKey(file));
}

function snapshotBucket(bucket) {
  return [...bucket.values()].map((entry) => buildItemView(entry));
}

module.exports = {
  ENGINE_KEYS,
  mergeDiagnosticsLayers,
  buildItemView,
  upsertEngineLayer,
  clearEngineLayer,
  removeFileFromBucket,
  snapshotBucket,
  diagSignature,
  normalizeStoreFileKey
};

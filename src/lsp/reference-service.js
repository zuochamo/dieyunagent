'use strict';

const fs = require('fs/promises');
const path = require('path');
const { fileURLToPath } = require('url');
const { getLanguageIdForPath, getServerKeyForLanguage } = require('./language-registry');

const DEFAULT_RESOLVE_TIMEOUT_MS = 20000;

function findNameColumn(lineText, name) {
  const n = String(name || '').trim();
  if (!n) return 0;
  const idx = String(lineText || '').indexOf(n);
  return idx >= 0 ? idx : 0;
}

function relPathFromUri(uri, workspaceRoot) {
  try {
    const abs = path.resolve(fileURLToPath(uri));
    const root = path.resolve(workspaceRoot);
    const rel = path.relative(root, abs);
    if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
    return rel.replace(/\\/g, '/');
  } catch {
    return null;
  }
}

function normalizeIncomingCalls(incoming, workspaceRoot, calleeName) {
  const sites = [];
  const seen = new Set();
  for (const call of incoming || []) {
    const from = call && call.from;
    if (!from || !from.uri) continue;
    const callerPath = relPathFromUri(from.uri, workspaceRoot);
    if (!callerPath) continue;
    const range = from.range || from.selectionRange || {};
    const start = range.start || {};
    const line = Number(start.line || 0) + 1;
    const key = `${callerPath}:${line}:${calleeName}`;
    if (seen.has(key)) continue;
    seen.add(key);
    sites.push({
      callerPath,
      callerSymbol: String(from.name || '').trim(),
      calleeName: String(calleeName || ''),
      line,
      confidence: 1
    });
  }
  return sites;
}

function normalizeReferences(locs, workspaceRoot, calleeName, defAbsPath, defLine) {
  const sites = [];
  const seen = new Set();
  const defKey = defAbsPath ? path.resolve(defAbsPath).toLowerCase() : '';
  for (const loc of locs || []) {
    if (!loc || !loc.uri) continue;
    let abs;
    try {
      abs = path.resolve(fileURLToPath(loc.uri));
    } catch {
      continue;
    }
    const callerPath = relPathFromUri(loc.uri, workspaceRoot);
    if (!callerPath) continue;
    const range = loc.range || {};
    const start = range.start || {};
    const line = Number(start.line || 0) + 1;
    if (defKey && abs.toLowerCase() === defKey && defLine && line === defLine) {
      continue;
    }
    const key = `${callerPath}:${line}`;
    if (seen.has(key)) continue;
    seen.add(key);
    sites.push({
      callerPath,
      callerSymbol: '',
      calleeName: String(calleeName || ''),
      line,
      confidence: 1
    });
  }
  return sites;
}

/**
 * @param {{
 *   getClient: (workspaceRoot: string, serverKey: string) => Promise<import('./lsp-client').LspClient | null>,
 *   workspaceRoot: string,
 *   absPath: string,
 *   line: number,
 *   name: string,
 *   character?: number,
 *   timeoutMs?: number
 * }} opts
 */
async function resolveSymbolCallers(opts) {
  const workspaceRoot = path.resolve(String(opts.workspaceRoot || ''));
  const absPath = path.resolve(String(opts.absPath || ''));
  const line = Math.max(1, Number(opts.line || 1));
  const name = String(opts.name || '').trim();
  const timeoutMs = Number(opts.timeoutMs) || DEFAULT_RESOLVE_TIMEOUT_MS;

  if (!workspaceRoot || !absPath || !name) {
    return { ok: false, error: 'workspaceRoot、absPath、name 必填', sites: [] };
  }

  const languageId = getLanguageIdForPath(absPath);
  const serverKey = languageId ? getServerKeyForLanguage(languageId) : null;
  if (!languageId || !serverKey) {
    return { ok: false, error: 'unsupported_language', sites: [] };
  }

  const client = await opts.getClient(workspaceRoot, serverKey);
  if (!client) {
    return { ok: false, error: 'no_lsp_server', sites: [] };
  }

  let text;
  try {
    text = await fs.readFile(absPath, 'utf8');
  } catch (err) {
    return { ok: false, error: err.message || String(err), sites: [] };
  }

  const lineText = text.split(/\r?\n/)[line - 1] || '';
  const character = opts.character != null ? Number(opts.character) : findNameColumn(lineText, name);

  let mode = 'callHierarchy';
  let sites = [];

  try {
    const incoming = await client.getIncomingCalls({
      absPath,
      line,
      character,
      languageId,
      text,
      timeoutMs
    });
    sites = normalizeIncomingCalls(incoming, workspaceRoot, name);
  } catch {
    sites = [];
  }

  if (!sites.length) {
    mode = 'references';
    try {
      const refs = await client.getReferences({
        absPath,
        line,
        character,
        languageId,
        text,
        timeoutMs
      });
      sites = normalizeReferences(refs, workspaceRoot, name, absPath, line);
    } catch (err) {
      return { ok: false, error: err.message || String(err), sites: [], server: serverKey };
    }
  }

  return {
    ok: true,
    mode,
    server: serverKey,
    language: languageId,
    sites
  };
}

module.exports = {
  resolveSymbolCallers,
  findNameColumn,
  DEFAULT_RESOLVE_TIMEOUT_MS
};

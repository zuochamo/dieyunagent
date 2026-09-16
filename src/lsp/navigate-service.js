'use strict';

const fs = require('fs/promises');
const path = require('path');
const { fileURLToPath, pathToFileURL } = require('url');
const { getLanguageIdForPath, getServerKeyForLanguage } = require('./language-registry');
const { firstIdentifier, identifierAt, CODE_KEYWORDS } = require('../gateway/symbol-text');

const DEFAULT_NAV_TIMEOUT_MS = 20000;
const MAX_LOCATIONS = 80;
const MAX_SYMBOLS = 120;
/** 单次 workspaceSymbol 最多查询的 server 数（每种支持的语言一个，避免漏掉第二语言） */
const MAX_SERVERS_PER_SYMBOL_QUERY = 4;

/** LSP SymbolKind -> 可读名（取常用部分） */
const SYMBOL_KIND_NAMES = {
  1: 'file',
  2: 'module',
  3: 'namespace',
  4: 'package',
  5: 'class',
  6: 'method',
  7: 'property',
  8: 'field',
  9: 'constructor',
  10: 'enum',
  11: 'interface',
  12: 'function',
  13: 'variable',
  14: 'constant',
  15: 'string',
  16: 'number',
  17: 'boolean',
  18: 'array',
  19: 'object',
  20: 'key',
  21: 'null',
  22: 'enumMember',
  23: 'struct',
  24: 'event',
  25: 'operator',
  26: 'typeParameter'
};

function symbolKindName(kind) {
  return SYMBOL_KIND_NAMES[Number(kind)] || 'unknown';
}

/**
 * 归一化 documentSymbol / workspaceSymbol 结果。
 * 兼容 DocumentSymbol（range/selectionRange/children）与 SymbolInformation（location）。
 * @param {any} result
 * @param {string} defaultUri 文件级查询时的文档 uri（DocumentSymbol 不带 uri）
 * @param {string} workspaceRoot
 * @param {number} limit
 */
function normalizeSymbols(result, defaultUri, workspaceRoot, limit) {
  const max = limit || MAX_SYMBOLS;
  const items = Array.isArray(result) ? result : result ? [result] : [];
  const out = [];

  function walk(node, container, depth) {
    if (!node || out.length >= max) return;
    const loc = node.location || null;
    const uri = (loc && loc.uri) || node.uri || defaultUri || '';
    const range = (loc && loc.range) || node.range || {};
    const sel = node.selectionRange || range;
    const start = range.start || sel.start || {};
    const end = range.end || sel.end || {};
    if (uri) {
      out.push({
        name: String(node.name || ''),
        kind: symbolKindName(node.kind),
        path: relPathFromUri(uri, workspaceRoot),
        line: Number(start.line || 0) + 1,
        endLine: Number(end.line || 0) + 1,
        character: Number((sel.start && sel.start.character) || 0) + 1,
        container: container || '',
        depth
      });
    }
    for (const child of node.children || []) {
      if (out.length >= max) return;
      walk(child, node.name, depth + 1);
    }
  }

  for (const item of items) {
    if (out.length >= max) break;
    walk(item, '', 0);
  }
  return out;
}

/** 工作区语言探测：用于未打开任何文件时的 workspaceSymbol */
async function detectWorkspaceServerKeys(workspaceRoot) {
  let entries = [];
  try {
    entries = await fs.readdir(workspaceRoot);
  } catch {
    return ['typescript'];
  }
  const names = new Set(entries.map((e) => String(e).toLowerCase()));
  const keys = [];
  if (names.has('package.json') || names.has('tsconfig.json') || names.has('jsconfig.json')) {
    keys.push('typescript');
  }
  if (
    names.has('pyproject.toml') ||
    names.has('setup.py') ||
    names.has('requirements.txt') ||
    entries.some((e) => String(e).toLowerCase().endsWith('.py'))
  ) {
    keys.push('python');
  }
  if (!keys.length) keys.push('typescript');
  return keys;
}

function withTimeout(promise, ms) {
  const wait = Number(ms);
  if (!Number.isFinite(wait) || wait <= 0) return Promise.resolve(promise).catch(() => null);
  return new Promise((resolve) => {
    let done = false;
    const settle = (v) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(v);
    };
    const timer = setTimeout(() => settle(null), wait);
    Promise.resolve(promise).then(settle, () => settle(null));
  });
}

/** workspace/symbol：跨 server 合并，不因单个 server 失败而整体失败 */
async function queryWorkspaceSymbols(opts) {
  const query = String(opts.query || '').trim();
  if (!query) {
    return {
      ok: false,
      errorCode: 'LSP_MISSING_QUERY',
      error: 'workspaceSymbol 需要 query（要搜的符号名）'
    };
  }
  const workspaceRoot = opts.workspaceRoot;
  const timeoutMs = opts.timeoutMs;
  const servers = [];
  const absHint = opts.absPath ? path.resolve(String(opts.absPath)) : '';
  if (absHint) {
    const languageId = getLanguageIdForPath(absHint);
    const serverKey = languageId ? getServerKeyForLanguage(languageId) : null;
    if (serverKey) servers.push(serverKey);
  } else {
    const active = typeof opts.listClients === 'function' ? opts.listClients(workspaceRoot) : [];
    // 已初始化的 server 优先，避免为一次符号查询付出冷启动代价
    const list = (Array.isArray(active) ? active : [])
      .slice()
      .sort((a, b) => (b && b.initialized ? 1 : 0) - (a && a.initialized ? 1 : 0));
    for (const item of list) {
      if (item && item.serverKey && !servers.includes(item.serverKey)) servers.push(item.serverKey);
    }
    if (!servers.length) {
      for (const key of await detectWorkspaceServerKeys(workspaceRoot)) {
        if (!servers.includes(key)) servers.push(key);
      }
    }
  }

  const symbols = [];
  const usedServers = [];
  const errors = [];
  for (const serverKey of servers.slice(0, MAX_SERVERS_PER_SYMBOL_QUERY)) {
    const client = await withTimeout(
      Promise.resolve(opts.getClient(workspaceRoot, serverKey)),
      timeoutMs
    );
    if (!client) {
      errors.push(`${serverKey}: 未启动`);
      continue;
    }
    const raw = await withTimeout(client.getWorkspaceSymbols({ query, timeoutMs }), timeoutMs);
    if (raw == null) {
      errors.push(`${serverKey}: 超时或无结果`);
      continue;
    }
    usedServers.push(serverKey);
    for (const item of normalizeSymbols(raw, '', workspaceRoot, MAX_SYMBOLS)) {
      symbols.push(item);
      if (symbols.length >= MAX_SYMBOLS) break;
    }
    if (symbols.length >= MAX_SYMBOLS) break;
  }

  if (!usedServers.length && !symbols.length) {
    return {
      ok: false,
      errorCode: 'LSP_UNAVAILABLE',
      error: `没有可用的 Language Server（${errors.join('; ') || '未启动'}）。可先 lsp 任一定位操作或打开源文件启动，或改用 graph find_symbol / grep。`
    };
  }
  return {
    ok: true,
    kind: 'symbols',
    symbols,
    servers: usedServers,
    query
  };
}

function relPathFromUri(uri, workspaceRoot) {
  try {
    const abs = path.resolve(fileURLToPath(uri));
    const root = path.resolve(workspaceRoot);
    const rel = path.relative(root, abs);
    if (rel.startsWith('..') || path.isAbsolute(rel)) return abs.replace(/\\/g, '/');
    return rel.replace(/\\/g, '/');
  } catch {
    return String(uri || '');
  }
}

function locFromLsp(item, workspaceRoot) {
  if (!item) return null;
  const uri = item.targetUri || item.uri;
  const range = item.targetSelectionRange || item.targetRange || item.range || {};
  const start = range.start || {};
  if (!uri) return null;
  return {
    path: relPathFromUri(uri, workspaceRoot),
    line: Number(start.line || 0) + 1,
    character: Number(start.character || 0) + 1
  };
}

function normalizeLocations(result, workspaceRoot) {
  const arr = Array.isArray(result) ? result : result ? [result] : [];
  const out = [];
  const seen = new Set();
  for (const item of arr) {
    const loc = locFromLsp(item, workspaceRoot);
    if (!loc) continue;
    const key = `${loc.path}:${loc.line}:${loc.character}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(loc);
    if (out.length >= MAX_LOCATIONS) break;
  }
  return out;
}

function hoverToText(hover) {
  if (!hover) return null;
  const contents = hover.contents;
  if (contents == null) return null;
  if (typeof contents === 'string') return contents.trim();
  if (Array.isArray(contents)) {
    return contents
      .map((c) => (typeof c === 'string' ? c : c && (c.value || c.language) ? String(c.value || '') : ''))
      .filter(Boolean)
      .join('\n\n')
      .trim();
  }
  if (typeof contents === 'object') return String(contents.value || '').trim();
  return null;
}

/**
 * 位置类操作需要「行 + 列」。模型常省略 character，或按 schema 默认填 1，
 * 落点往往是缩进/标点 → tsserver 返回空结果，表现为「定位不到」。
 * 落点不是标识符时，纠正到行内首个标识符（复用 symbol-text，避免第二份实现）。
 * @param {string} lineText 目标行原文
 * @param {number|null} character1 调用方给的 1-based 列；缺省为 null
 * @returns {number} 0-based 列
 */
function resolveCharacter0(lineText, character1) {
  const text = String(lineText || '');
  const given = Number(character1);
  const fallback = Number.isFinite(given) && given > 0 ? given - 1 : 0;
  // 落点必须落在「非关键字的标识符」上；落在 export/const/return 等关键字上
  // （含模型照抄 schema 默认 1 的情况）同样是无效位置，退回行内首个标识符。
  const word = identifierAt(text, fallback);
  if (word && !CODE_KEYWORDS.has(word)) {
    const idx = text.indexOf(word, Math.max(0, fallback - word.length));
    if (idx >= 0) return idx;
  }
  const first = firstIdentifier(text);
  if (first) {
    const idx = text.indexOf(first);
    if (idx >= 0) return idx;
  }
  return fallback;
}

/**
 * Cursor-style LSP query: 1-based line and character (UTF-16).
 */
async function queryLspPosition(opts) {
  const operation = String(opts.operation || '').trim();
  const allowed = new Set([
    'goToDefinition',
    'findReferences',
    'goToImplementation',
    'hover',
    'typeDefinition',
    'documentSymbol',
    'workspaceSymbol'
  ]);
  if (!allowed.has(operation)) {
    return {
      ok: false,
      errorCode: 'LSP_BAD_OPERATION',
      error:
        'operation 必须是 goToDefinition / findReferences / goToImplementation / hover / typeDefinition / documentSymbol / workspaceSymbol'
    };
  }
  const workspaceRoot = path.resolve(String(opts.workspaceRoot || ''));
  const timeoutMs = Number(opts.timeoutMs) || DEFAULT_NAV_TIMEOUT_MS;

  if (operation === 'workspaceSymbol') {
    if (!workspaceRoot) {
      return { ok: false, errorCode: 'LSP_WORKSPACE_REQUIRED', error: '需要工作区' };
    }
    return queryWorkspaceSymbols({ ...opts, workspaceRoot, timeoutMs });
  }

  const absPath = path.resolve(String(opts.absPath || ''));
  const line = Math.max(1, Number(opts.line) || 1);
  const character1 = opts.character != null ? Math.max(1, Number(opts.character) || 1) : null;

  if (!workspaceRoot || !absPath) {
    return { ok: false, errorCode: 'LSP_WORKSPACE_REQUIRED', error: '需要工作区与文件路径' };
  }

  const languageId = getLanguageIdForPath(absPath);
  const serverKey = languageId ? getServerKeyForLanguage(languageId) : null;
  if (!languageId || !serverKey) {
    return {
      ok: false,
      errorCode: 'LSP_UNSUPPORTED',
      error:
        '该文件类型没有 Language Server（支持 TS/JS/TSX/Python/Rust/Go）。请改用 grep、read_symbol 或 graph。'
    };
  }
  const client = await opts.getClient(workspaceRoot, serverKey);
  if (!client) {
    return { ok: false, errorCode: 'LSP_UNAVAILABLE', error: 'Language Server 未启动' };
  }

  let text;
  try {
    text = await fs.readFile(absPath, 'utf8');
  } catch (err) {
    return { ok: false, errorCode: 'LSP_READ_FAILED', error: err.message || String(err) };
  }

  const lineText = text.split(/\r?\n/)[line - 1] || '';
  const character0 = resolveCharacter0(lineText, character1);
  const req = {
    absPath,
    line,
    character: character0,
    languageId,
    text,
    timeoutMs
  };

  try {
    if (operation === 'documentSymbol') {
      const raw = await client.getDocumentSymbols(req);
      return {
        ok: true,
        kind: 'symbols',
        symbols: normalizeSymbols(raw, pathToFileURL(absPath).href, workspaceRoot, MAX_SYMBOLS),
        server: serverKey,
        language: languageId
      };
    }
    if (operation === 'hover') {
      const hover = await client.getHover(req);
      const contents = hoverToText(hover);
      return {
        ok: true,
        kind: 'hover',
        hover: contents
          ? {
              contents,
              range: hover.range
                ? {
                    startLine: Number(hover.range.start && hover.range.start.line) + 1,
                    startCharacter: Number(hover.range.start && hover.range.start.character) + 1,
                    endLine: Number(hover.range.end && hover.range.end.line) + 1,
                    endCharacter: Number(hover.range.end && hover.range.end.character) + 1
                  }
                : null
            }
          : null,
        server: serverKey,
        language: languageId
      };
    }
    let raw;
    if (operation === 'goToDefinition') raw = await client.getDefinition(req);
    else if (operation === 'goToImplementation') raw = await client.getImplementation(req);
    else if (operation === 'typeDefinition') raw = await client.getTypeDefinition(req);
    else raw = await client.getReferences({ ...req, includeDeclaration: true });
    return {
      ok: true,
      kind: 'locations',
      locations: normalizeLocations(raw, workspaceRoot),
      server: serverKey,
      language: languageId
    };
  } catch (err) {
    return {
      ok: false,
      errorCode: 'LSP_QUERY_FAILED',
      error: err && err.message ? String(err.message) : String(err),
      server: serverKey
    };
  }
}

module.exports = {
  queryLspPosition,
  resolveCharacter0,
  normalizeLocations,
  normalizeSymbols,
  symbolKindName,
  detectWorkspaceServerKeys,
  hoverToText,
  DEFAULT_NAV_TIMEOUT_MS,
  MAX_LOCATIONS,
  MAX_SYMBOLS,
  MAX_SERVERS_PER_SYMBOL_QUERY
};

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DIEYUN_DIR = '.dieyun';
const FILENAME = 'AGENTS.md';
const META_FILENAME = 'agents-meta.json';
const DRAFT_FILENAME = 'agents-draft.md';
const MAX_INJECT_CHARS = 8000;
const MAX_FILE_CHARS = 24000;
const NEAR_LIMIT_CHARS = Math.floor(MAX_FILE_CHARS * 0.9);
const CHANGELOG_MAX_ROWS = 50;
const CHANGELOG_TRIM_FALLBACK_ROWS = 20;
const CHANGELOG_INJECT_ROWS = 5;

const SECTION_RE = /<!--\s*dieyun:section:(\w+)\s+status=(\w+)\s*-->/g;
const CHANGELOG_ROW_RE = /^\|\s*\d{4}-\d{2}-\d{2}/;

function agentsRelativePath() {
  return `${DIEYUN_DIR}/${FILENAME}`.replace(/\\/g, '/');
}

function agentsMetaRelativePath() {
  return `${DIEYUN_DIR}/${META_FILENAME}`.replace(/\\/g, '/');
}

function agentsDraftRelativePath() {
  return `${DIEYUN_DIR}/${DRAFT_FILENAME}`.replace(/\\/g, '/');
}

function bundledTemplatePath() {
  return path.join(__dirname, '..', 'assets', 'AGENTS.md.template');
}

function loadBundledTemplate() {
  try {
    return fs.readFileSync(bundledTemplatePath(), 'utf8');
  } catch {
    return [
      '# AGENTS.md',
      '',
      '<!-- dieyun:section:overview status=empty -->',
      '## 项目概览',
      '',
      '（待补充）',
      '',
      '<!-- dieyun:section:environment status=auto -->',
      '## 运行环境',
      '',
      '（由叠云自动检测）',
      ''
    ].join('\n');
  }
}

function contentHash(text) {
  return crypto.createHash('sha256').update(String(text || '')).digest('hex').slice(0, 16);
}

/**
 * @param {string} content
 * @returns {Array<{ id: string, status: string, marker: string, bodyStart: number, bodyEnd: number, body: string }>}
 */
function parseSections(content) {
  const text = String(content || '');
  const markers = [];
  let m;
  SECTION_RE.lastIndex = 0;
  while ((m = SECTION_RE.exec(text)) !== null) {
    markers.push({
      id: m[1],
      status: m[2],
      index: m.index,
      marker: m[0],
      markerEnd: m.index + m[0].length
    });
  }
  const sections = [];
  for (let i = 0; i < markers.length; i++) {
    const cur = markers[i];
    const next = markers[i + 1];
    const bodyStart = cur.markerEnd;
    const bodyEnd = next ? next.index : text.length;
    const body = text.slice(bodyStart, bodyEnd).trim();
    sections.push({
      id: cur.id,
      status: cur.status,
      marker: cur.marker,
      bodyStart,
      bodyEnd,
      body
    });
  }
  return sections;
}

function sectionHasPlaceholder(body) {
  const t = String(body || '').trim();
  return !t || /（待补充/.test(t);
}

function lineAlreadyPresent(body, line) {
  const needle = String(line || '').trim();
  if (!needle || needle.length < 4) return true;
  return String(body || '').includes(needle);
}

/**
 * @param {string} body
 * @returns {{ preamble: string, rows: string[] }}
 */
function parseChangelogTable(body) {
  const lines = String(body || '').split('\n');
  const preamble = [];
  const rows = [];
  let seenData = false;
  for (const line of lines) {
    if (CHANGELOG_ROW_RE.test(line.trim())) {
      seenData = true;
      rows.push(line);
    } else if (!seenData) {
      preamble.push(line);
    }
  }
  return { preamble: preamble.join('\n').trim(), rows };
}

/**
 * @param {string} body
 * @param {number} maxRows
 */
function trimChangelogRows(body, maxRows) {
  const { preamble, rows } = parseChangelogTable(body);
  if (rows.length <= maxRows) {
    return { body: String(body || '').trim(), trimmed: false, dropped: 0 };
  }
  const dropped = rows.length - maxRows;
  const kept = rows.slice(-maxRows);
  const table = kept.join('\n');
  const rebuilt = preamble ? `${preamble}\n${table}` : table;
  return { body: rebuilt.trim(), trimmed: true, dropped };
}

/** 注入上下文时只保留最近若干条维护记录 */
function trimChangelogForInject(body, maxRows = CHANGELOG_INJECT_ROWS) {
  const { preamble, rows } = parseChangelogTable(body);
  if (rows.length <= maxRows) return String(body || '').trim();
  const dropped = rows.length - maxRows;
  const kept = rows.slice(-maxRows);
  const omitRow = `| … | … | （更早 ${dropped} 条已省略，完整记录见 .dieyun/AGENTS.md） |`;
  const table = [omitRow, ...kept].join('\n');
  return preamble ? `${preamble}\n${table}`.trim() : table;
}

function rebuildAgentsMdDocument(text, sections, bodies, statuses) {
  const firstIdx = text.indexOf(sections[0].marker);
  const header = firstIdx > 0 ? text.slice(0, firstIdx) : '';
  let out = header;
  for (const sec of sections) {
    const marker = sec.marker.replace(/status=\w+/, `status=${statuses.get(sec.id) || sec.status}`);
    out += `${marker}\n${(bodies.get(sec.id) || '').trim()}\n\n`;
  }
  return out.trim();
}

/**
 * @param {string} content
 * @param {Array<{ section: string, action?: string, content?: string, confidence?: number }>} updates
 * @param {{ source?: string }} opts
 */
function applySectionUpdates(content, updates, opts = {}) {
  const text = String(content || '');
  const sections = parseSections(text);
  if (!sections.length) return { content: text, applied: [], skipped: updates || [] };

  const applied = [];
  const skipped = [];
  const bodies = new Map(sections.map((s) => [s.id, s.body]));
  const statuses = new Map(sections.map((s) => [s.id, s.status]));
  const stamp = new Date().toISOString().slice(0, 10);
  const source = opts.source || 'agent';
  const changelogRows = [];

  for (const upd of updates || []) {
    const id = String(upd.section || '').trim();
    const piece = String(upd.content || '').trim();
    const action = String(upd.action || 'append').toLowerCase();
    const confidence = Number(upd.confidence);
    if (!id || !piece || !bodies.has(id)) {
      skipped.push(upd);
      continue;
    }
    if (Number.isFinite(confidence) && confidence < 0.55) {
      skipped.push(upd);
      continue;
    }
    if (action === 'noop') {
      skipped.push(upd);
      continue;
    }

    const prevBody = bodies.get(id) || '';
    let newBody = prevBody;
    if (action === 'replace') {
      newBody = piece;
    } else if (lineAlreadyPresent(prevBody, piece)) {
      skipped.push(upd);
      continue;
    } else if (sectionHasPlaceholder(prevBody)) {
      newBody = piece.startsWith('- ') ? piece : `- ${piece}`;
    } else {
      const bullet = piece.startsWith('- ') ? piece : `- ${piece}`;
      newBody = `${prevBody.trim()}\n${bullet}`.trim();
    }

    bodies.set(id, newBody);
    if (id !== 'changelog') {
      statuses.set(id, sectionHasPlaceholder(prevBody) ? 'draft' : 'stable');
    }
    applied.push({ ...upd, section: id });
    if (id !== 'changelog') {
      changelogRows.push(`| ${stamp} | ${source} | ${piece.replace(/\|/g, '/').slice(0, 120)} |`);
    }
  }

  if (changelogRows.length && bodies.has('changelog')) {
    const existing = (bodies.get('changelog') || '').trim();
    const extra = changelogRows.filter((row) => !existing.includes(row)).join('\n');
    if (extra) {
      bodies.set('changelog', `${existing}\n${extra}`.trim());
    }
  }

  let changelogTrimmed = false;
  if (bodies.has('changelog')) {
    const trim = trimChangelogRows(bodies.get('changelog'), CHANGELOG_MAX_ROWS);
    bodies.set('changelog', trim.body);
    if (trim.trimmed) changelogTrimmed = true;
  }

  let out = rebuildAgentsMdDocument(text, sections, bodies, statuses);
  let nearLimit = out.length >= NEAR_LIMIT_CHARS;
  let truncated = false;

  if (out.length > MAX_FILE_CHARS && bodies.has('changelog')) {
    const trim = trimChangelogRows(bodies.get('changelog'), CHANGELOG_TRIM_FALLBACK_ROWS);
    bodies.set('changelog', trim.body);
    if (trim.trimmed) changelogTrimmed = true;
    out = rebuildAgentsMdDocument(text, sections, bodies, statuses);
  }

  if (out.length > MAX_FILE_CHARS) {
    out = out.slice(0, MAX_FILE_CHARS);
    truncated = true;
    nearLimit = true;
  }

  return {
    content: `${out.trim()}\n`,
    applied,
    skipped,
    nearLimit,
    truncated,
    changelogTrimmed,
    contentLength: out.length
  };
}

function formatAgentsMdSystemBlock({ content, relativePath, workspacePath }) {
  const body = String(content || '').trim();
  if (!body) return '';
  const capped = body.length > MAX_INJECT_CHARS ? `${body.slice(0, MAX_INJECT_CHARS)}\n…（已截断）` : body;
  const loc = relativePath || agentsRelativePath();
  const ws = workspacePath ? `工作空间：${workspacePath}\n` : '';
  return (
    `【项目地图 · AGENTS.md】\n` +
    `${ws}文件：${loc}\n` +
    `与 ~/.dieyun/dieyun.md 全局准则并存；与用户本轮输入冲突时以用户输入为准。\n\n` +
    capped
  );
}

function parseMaintainerJson(text) {
  const raw = String(text || '').trim();
  if (!raw) return { updates: [] };
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1].trim() : raw;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) return { updates: [] };
  try {
    const json = JSON.parse(body.slice(start, end + 1));
    const updates = Array.isArray(json.updates) ? json.updates : [];
    return {
      updates: updates
        .map((u) => ({
          section: String(u.section || '').trim(),
          action: String(u.action || 'append').trim(),
          content: String(u.content || '').trim(),
          confidence: Number(u.confidence)
        }))
        .filter((u) => u.section && u.content)
    };
  } catch {
    return { updates: [] };
  }
}

function defaultMeta() {
  return {
    version: 1,
    updatedAt: 0,
    contentHash: '',
    lastMaintenanceAt: 0,
    coldStartDone: false
  };
}

function normalizeMeta(raw) {
  const base = defaultMeta();
  if (!raw || typeof raw !== 'object') return base;
  return {
    ...base,
    ...raw,
    version: 1
  };
}

module.exports = {
  DIEYUN_DIR,
  FILENAME,
  META_FILENAME,
  DRAFT_FILENAME,
  MAX_INJECT_CHARS,
  MAX_FILE_CHARS,
  NEAR_LIMIT_CHARS,
  CHANGELOG_MAX_ROWS,
  CHANGELOG_INJECT_ROWS,
  agentsRelativePath,
  agentsMetaRelativePath,
  agentsDraftRelativePath,
  bundledTemplatePath,
  loadBundledTemplate,
  contentHash,
  parseSections,
  parseChangelogTable,
  trimChangelogRows,
  trimChangelogForInject,
  applySectionUpdates,
  formatAgentsMdSystemBlock,
  parseMaintainerJson,
  defaultMeta,
  normalizeMeta
};

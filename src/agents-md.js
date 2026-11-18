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
// 维护记录是审计不是知识：注入时只取最近 5 条（CHANGELOG_MAX_ROWS），
// 存 50 行纯属白占磁盘上限 —— 实测某项目 20 行吃 3248 字符，直接把 gotchas 挤没了。
const CHANGELOG_MAX_ROWS = 5;
const CHANGELOG_TRIM_FALLBACK_ROWS = 3;
// 超限裁剪时每个 section 的保底长度：marker + 标题 + 省略提示。
// **低于这个值就不再裁** —— marker 必须活着，否则该段后续更新会被静默 skip。
const SECTION_MIN_KEEP = 260;

// section 白名单的唯一来源（零依赖模块：catalog 会把这份枚举打进 Renderer bundle，
// 而本文件依赖 fs/path/crypto，所以常量不能放这里）。
const { EDITABLE_SECTION_IDS } = require('./agents-md-sections');

// 可选 paths 属性：`<!-- dieyun:section:commands status=stable paths="tools/**, shows/**" -->`
// 语义对齐 Claude Code 的 path-scoped rules / Cursor 的 globs：**命中才注入**。
// 不写 paths 的段＝常驻（每轮都进），写了的是条件段（本轮没碰相关路径就不占注入预算）。
const SECTION_RE = /<!--\s*dieyun:section:(\w+)\s+status=(\w+)(?:\s+paths="([^"]*)")?\s*-->/g;
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
      ''
    ].join('\n');
  }
}

function contentHash(text) {
  return crypto.createHash('sha256').update(String(text || '')).digest('hex').slice(0, 16);
}

/**
 * 把 `paths="a/**, b/*.md"` 拆成 glob 列表。
 * @param {string|undefined} raw
 * @returns {string[]}
 */
function parsePathGlobs(raw) {
  return String(raw || '')
    .split(',')
    .map((s) => s.trim().replace(/\\/g, '/'))
    .filter(Boolean);
}

/** 归一化：统一正斜杠、去掉盘符与起始斜杠，便于跨 Windows/Unix 比较。 */
function normalizeRefPath(p) {
  return String(p || '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^[a-zA-Z]:/, '')
    .replace(/^\/+/, '');
}

/**
 * glob → 正则。`**` 跨目录、`*` 不跨目录；允许任意前缀，使
 * `tools/ue5/**` 也能命中绝对路径 `D:/proj/tools/ue5/x.py`。
 */
function compilePathGlob(glob) {
  const g = normalizeRefPath(glob);
  if (!g) return null;
  let body = '';
  for (let i = 0; i < g.length; i += 1) {
    const c = g.charAt(i);
    if (c === '*' && g.charAt(i + 1) === '*') {
      body += '.*';
      i += 1;
    } else if (c === '*') {
      body += '[^/]*';
    } else if (c === '?') {
      body += '[^/]';
    } else {
      body += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`(^|/)${body}$`, 'i');
}

/**
 * 一组 glob 里是否有任一命中给定路径。
 * @param {string[]} globs
 * @param {string[]} paths
 */
function matchesAnyPathGlob(globs, paths) {
  const list = Array.isArray(globs) ? globs : [];
  if (!list.length) return true; // 无条件段：永远算命中
  const hay = (Array.isArray(paths) ? paths : []).map(normalizeRefPath).filter(Boolean);
  if (!hay.length) return true; // 没有路径信号时不筛（退化为「全注入」）
  const regs = list.map(compilePathGlob).filter(Boolean);
  return regs.some((re) => hay.some((p) => re.test(p)));
}

/**
 * 按本轮路径信号挑出要注入的段。
 *
 * @param {Array<{id:string, paths:string[]}>} sections
 * @param {string[]} pathHints 本轮触达的路径（用户消息 / 打开文件 / 变更文件）
 * @returns {{ picked: any[], skipped: string[] }}
 */
function selectSectionsByPath(sections, pathHints) {
  const picked = [];
  const skipped = [];
  for (const sec of sections || []) {
    const globs = Array.isArray(sec.paths) ? sec.paths : [];
    if (!globs.length || matchesAnyPathGlob(globs, pathHints)) picked.push(sec);
    else skipped.push(sec.id);
  }
  return { picked, skipped };
}

/**
 * @param {string} content
 * @returns {Array<{ id: string, status: string, marker: string, bodyStart: number, bodyEnd: number, body: string, paths: string[] }>}
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
      markerEnd: m.index + m[0].length,
      paths: parsePathGlobs(m[3])
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
      body,
      paths: cur.paths
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

function rebuildAgentsMdDocument(text, sections, bodies, statuses) {
  if (!sections.length) return String(text || '').trim();
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
 * 维护记录段的最小桩（marker + 标题 + 表头）。文案唯一来源是随包模板。
 * @returns {{ marker: string, body: string }}
 */
function changelogStub() {
  const fromTemplate = parseSections(loadBundledTemplate()).find((s) => s.id === 'changelog');
  // 随包模板是 CRLF（Windows 仓库），写进文档前统一成 LF，避免混行尾。
  if (fromTemplate) {
    return { marker: fromTemplate.marker, body: String(fromTemplate.body).replace(/\r\n?/g, '\n') };
  }
  return {
    marker: '<!-- dieyun:section:changelog status=auto -->',
    body: '## 维护记录\n\n| 日期 | 来源 | 摘要 |\n|------|------|------|'
  };
}

/**
 * 保证 `changelog` 段存在。
 *
 * 这个段是「超限时腾空间」两个分支的唯一支点（`trimChangelogRows`），一旦被
 * 尾部硬切连 marker 一起切掉，轮转就永久失效 —— 之后每次维护都只能再切一刀，
 * 新写入的条目写完即丢，且**不会自愈**。实际踩过：某项目地图卡在 24001 字符
 * 长达数小时，gotchas 尾部持续被削。
 */
function ensureChangelogSection(sections, bodies, statuses) {
  if (bodies.has('changelog')) return false;
  const stub = changelogStub();
  sections.push({
    id: 'changelog',
    status: 'auto',
    marker: stub.marker,
    bodyStart: 0,
    bodyEnd: 0,
    body: stub.body
  });
  bodies.set('changelog', stub.body);
  statuses.set('changelog', 'auto');
  return true;
}

/**
 * 按「行」裁剪到 limit 字符以内，尾巴留一行省略提示 —— 绝不切出半句。
 * 超限兜底与注入裁剪共用这一份实现（唯一来源）。
 * @param {string} text
 * @param {number} limit
 * @param {(droppedLines: number) => string} [makeNote] 返回空串表示不加提示
 * @returns {{ text: string, truncated: boolean, droppedLines: number }}
 */
function clipTextByLines(text, limit, makeNote) {
  const src = String(text || '').trim();
  const cap = Number(limit) > 0 ? Number(limit) : 0;
  if (!cap || src.length <= cap) return { text: src, truncated: false, droppedLines: 0 };
  const lines = src.split('\n');
  const kept = [];
  let used = 0;
  for (const line of lines) {
    const cost = line.length + 1;
    if (used + cost > cap) break;
    kept.push(line);
    used += cost;
  }
  const droppedLines = lines.length - kept.length;
  const note = typeof makeNote === 'function' ? makeNote(droppedLines) : `…（已省略 ${droppedLines} 行）`;
  const body = kept.join('\n');
  return {
    text: note ? (body ? `${body}\n${note}` : note) : body,
    truncated: true,
    droppedLines
  };
}

/** @returns {{ text: string, truncated: boolean, droppedLines: number }} */
function truncateAgentsMdByLines(text, maxChars) {
  return clipTextByLines(text, maxChars, () => '');
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
    } else if (action === 'merge') {
      // 并入已有条目：按 anchor（该条目的开头片段）定位，用 content 整行替换它。
      // 这是"同主题只留 1 条"的唯一可执行路径 —— 没有它，agent 只能 append，
      // 同主题必然重复（实测 CameraCut 一天内被写了两条）。
      const anchor = String(upd.anchor || '').trim();
      if (!anchor) {
        skipped.push({ ...upd, reason: 'merge 需要 anchor（已有条目的开头片段）' });
        continue;
      }
      const lines = prevBody.split('\n');
      // 条目以 "- " 开头，而 anchor 通常从正文起始（如 "**CameraCut"）；两种都给匹配，
      // 免掉调用方纠结要不要带列表符。
      const bare = (l) => String(l).trim().replace(/^-\s*/, '');
      const at = lines.findIndex((l) => bare(l).startsWith(bare(anchor)) || l.trim().startsWith(anchor));
      if (at < 0) {
        skipped.push({ ...upd, reason: `未找到以「${anchor}」开头的条目，请先 fs_read_file 确认或改用 append` });
        continue;
      }
      lines[at] = piece.startsWith('- ') ? piece : `- ${piece}`;
      newBody = lines.join('\n');
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

  const changelogRecreated = ensureChangelogSection(sections, bodies, statuses);

  let out = rebuildAgentsMdDocument(text, sections, bodies, statuses);
  let nearLimit = out.length >= NEAR_LIMIT_CHARS;
  let truncated = false;
  let droppedLines = 0;

  if (out.length > MAX_FILE_CHARS && bodies.has('changelog')) {
    const trim = trimChangelogRows(bodies.get('changelog'), CHANGELOG_TRIM_FALLBACK_ROWS);
    bodies.set('changelog', trim.body);
    if (trim.trimmed) changelogTrimmed = true;
    out = rebuildAgentsMdDocument(text, sections, bodies, statuses);
  }

  if (out.length > MAX_FILE_CHARS) {
    // ① 维护记录先轮转到最近几条（审计价值最低，注入也只取最近 5 条）
    if (bodies.has('changelog')) {
      const trim = trimChangelogRows(bodies.get('changelog'), CHANGELOG_TRIM_FALLBACK_ROWS);
      if (trim.trimmed) {
        bodies.set('changelog', trim.body);
        changelogTrimmed = true;
        out = rebuildAgentsMdDocument(text, sections, bodies, statuses);
      }
    }
    // ② 仍超：反复裁「当前最长的那一段」。**绝不整段丢弃** —— 每个 section 的
    //    marker 必须活着，否则该段后续更新会被静默 skip 且不会自愈
    //    （实测踩过：按尾巴硬切把 gotchas 整段切没，之后所有 gotchas 更新都丢失）。
    let guard = 0;
    while (out.length > MAX_FILE_CHARS && guard < 80) {
      guard += 1;
      const target = sections
        .filter((s) => (bodies.get(s.id) || '').length > SECTION_MIN_KEEP)
        .sort((a, b) => (bodies.get(b.id) || '').length - (bodies.get(a.id) || '').length)[0];
      if (!target) break;
      const cur = bodies.get(target.id) || '';
      const keep = Math.max(SECTION_MIN_KEEP, Math.floor(cur.length * 0.72));
      const clipped = clipTextByLines(
        cur,
        keep,
        (d) => `…（本段已裁剪：省略 ${d} 行，完整内容见 .dieyun/backup/ 备份）`
      );
      if (!clipped.truncated) break;
      bodies.set(target.id, clipped.text);
      droppedLines += clipped.droppedLines;
      out = rebuildAgentsMdDocument(text, sections, bodies, statuses);
    }
    // ③ 极端兜底：段数极多、每段都到 SECTION_MIN_KEEP 仍超限时按行硬裁。
    //    宁可丢尾部段，也不写出一个超限文件 —— 超限文件会让下次维护从更差的状态起步。
    if (out.length > MAX_FILE_CHARS) {
      out = clipTextByLines(out, MAX_FILE_CHARS, () => '…（已裁剪到上限）').text;
    }
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
    changelogRecreated,
    droppedLines,
    contentLength: out.length,
    maxChars: MAX_FILE_CHARS
  };
}

/**
 * 注入块的最终兜底裁剪。**调用方应先用 section 配额把内容裁到 maxChars 以内**
 * （`system-prompt-prep.js: lightAgentsMdContent`），这里的 slice 只防未预期的超长。
 *
 * `stats` 让模型知道这份地图有多大、本轮看到几段 —— 没有这个反馈，agent 会一直
 * 往一个已经写满的文件里 append（实测一天内三次触顶）。
 * @param {{ content?: string, relativePath?: string, workspacePath?: string, maxChars?: number, stats?: { fileChars?: number, fileLimit?: number, sectionCount?: number, injectedCount?: number, nearLimit?: boolean } }} p
 */
function formatAgentsMdSystemBlock({ content, relativePath, workspacePath, maxChars, stats }) {
  const body = String(content || '').trim();
  if (!body) return '';
  const cap = Number(maxChars) > 0 ? Number(maxChars) : MAX_INJECT_CHARS;
  const capped = body.length > cap ? `${body.slice(0, cap)}\n…（已截断）` : body;
  const loc = relativePath || agentsRelativePath();
  const ws = workspacePath ? `工作空间：${workspacePath}\n` : '';
  const st = stats || {};
  const fileChars = Number(st.fileChars) || 0;
  const fileLimit = Number(st.fileLimit) || MAX_FILE_CHARS;
  const sectionCount = Number(st.sectionCount) || 0;
  const injectedCount = Number(st.injectedCount) || 0;
  const bits = [];
  if (fileChars > 0) bits.push(`${fileChars.toLocaleString()} 字 / 上限 ${fileLimit.toLocaleString()}`);
  if (sectionCount > 0 && injectedCount > 0) bits.push(`本轮注入 ${injectedCount}/${sectionCount} 段`);
  const meta = bits.length ? `（${bits.join('，')}）` : '';
  // 只在真的快满时提醒 —— 平时不出声，否则每轮都是噪音。
  const pressure =
    st.nearLimit || fileChars >= NEAR_LIMIT_CHARS
      ? `\n⚠ 本文件已 ${fileChars.toLocaleString()} 字（上限 ${fileLimit.toLocaleString()}）。` +
        '新增内容前先并入同主题已有条目（`agents_md_propose` 用 `action=merge` + `anchor`），' +
        '或整段重写（`action=replace`）；不要再 append。'
      : '';
  return (
    `【项目地图 · AGENTS.md】\n` +
    `${ws}文件：${loc}${meta}\n` +
    `与 ~/.dieyun/dieyun.md 全局准则并存；与用户本轮输入冲突时以用户输入为准。${pressure}\n\n` +
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
  FILENAME,
  MAX_INJECT_CHARS,
  MAX_FILE_CHARS,
  NEAR_LIMIT_CHARS,
  CHANGELOG_MAX_ROWS,
  EDITABLE_SECTION_IDS,
  agentsRelativePath,
  agentsMetaRelativePath,
  agentsDraftRelativePath,
  bundledTemplatePath,
  loadBundledTemplate,
  contentHash,
  parseSections,
  parsePathGlobs,
  normalizeRefPath,
  compilePathGlob,
  matchesAnyPathGlob,
  selectSectionsByPath,
  parseChangelogTable,
  changelogStub,
  ensureChangelogSection,
  clipTextByLines,
  truncateAgentsMdByLines,
  applySectionUpdates,
  formatAgentsMdSystemBlock,
  parseMaintainerJson,
  defaultMeta,
  normalizeMeta
};

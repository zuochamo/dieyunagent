'use strict';

const WIKI_ROOT = '.dieyun/wiki';
const README_REL = `${WIKI_ROOT}/README.md`;

const README_TEXT = `# 项目 Wiki

工作区级精选说明（约定、决策、排障）。侧栏「Wiki」可编辑；Agent 发消息时会注入相关页标题摘要，全文用 \`fs_read_file\` 读取本目录下文件。

一页一文件：\`<slug>.md\`（slug 仅 \`a-z0-9-\`）。

可选 frontmatter：

\`\`\`yaml
---
title: 页面标题
tags: [ssh, index]
updated: 2026-07-15
---
\`\`\`
`;

function pad2(n) {
  return String(n).padStart(2, '0');
}

function todayStamp(d = new Date()) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** @param {string} text */
function slugify(text) {
  const s = String(text || '')
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  if (s) return s.slice(0, 64);
  return `page-${Date.now().toString(36)}`;
}

/**
 * @param {string} markdown
 * @returns {{ meta: Record<string, string>, body: string }}
 */
function parseFrontmatter(markdown) {
  const text = String(markdown || '').replace(/^\uFEFF/, '');
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) return { meta: {}, body: text };
  const meta = {};
  for (const line of String(m[1] || '').split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
    if (!kv) continue;
    let val = kv[2].trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    meta[kv[1]] = val;
  }
  return { meta, body: String(m[2] || '') };
}

function titleFromMarkdown(markdown, slug) {
  const { meta, body } = parseFrontmatter(markdown);
  if (meta.title) return String(meta.title).trim();
  const h1 = /^#\s+(.+)$/m.exec(body);
  if (h1) return h1[1].trim();
  return slug || '未命名';
}

function summaryFromMarkdown(markdown, max = 160) {
  const { body } = parseFrontmatter(markdown);
  const plain = String(body || '')
    .replace(/^#+\s+/gm, '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (plain.length <= max) return plain;
  return `${plain.slice(0, max)}…`;
}

function buildPageMarkdown({ title, body, tags, slug }) {
  const t = String(title || slug || '未命名').trim() || '未命名';
  const tagList = Array.isArray(tags)
    ? tags.map((x) => String(x).trim()).filter(Boolean)
    : String(tags || '')
        .split(/[,，]/)
        .map((x) => x.trim())
        .filter(Boolean);
  const tagsYaml = tagList.length
    ? `[${tagList.map((x) => `"${x.replace(/"/g, '\\"')}"`).join(', ')}]`
    : '[]';
  const content = String(body != null ? body : `# ${t}\n\n`).trimEnd();
  return [
    '---',
    `title: ${t}`,
    `tags: ${tagsYaml}`,
    `updated: ${todayStamp()}`,
    '---',
    '',
    content.endsWith('\n') ? content : `${content}\n`
  ].join('\n');
}

/**
 * @param {{ listDir: Function, readText: Function, writeText: Function, mkdir: Function }} storage
 */
async function ensureWikiDir(storage) {
  try {
    await storage.mkdir(WIKI_ROOT);
  } catch {
    // exists
  }
  try {
    await storage.readText(README_REL, 4096);
  } catch {
    await storage.writeText(README_REL, README_TEXT);
  }
  return { ok: true, root: WIKI_ROOT };
}

/**
 * @param {{ listDir: Function, readText: Function }} storage
 */
async function listWikiPages(storage) {
  await ensureWikiDir(storage);
  let entries = [];
  try {
    entries = (await storage.listDir(WIKI_ROOT)) || [];
  } catch {
    return [];
  }
  const pages = [];
  for (const ent of entries) {
    if (!ent || ent.isDirectory) continue;
    const name = String(ent.name || '');
    if (!/\.md$/i.test(name)) continue;
    if (/^readme\.md$/i.test(name)) continue;
    const slug = name.replace(/\.md$/i, '');
    if (!/^[a-z0-9][a-z0-9-]*$/i.test(slug)) continue;
    const rel = `${WIKI_ROOT}/${name}`;
    let markdown = '';
    try {
      markdown = await storage.readText(rel, 256000);
    } catch {
      continue;
    }
    const { meta } = parseFrontmatter(markdown);
    pages.push({
      slug,
      path: rel,
      title: titleFromMarkdown(markdown, slug),
      tags: meta.tags || '',
      summary: summaryFromMarkdown(markdown, 160),
      updated: meta.updated || '',
      mtimeMs: Number(ent.mtimeMs) || 0,
      size: Number(ent.size) || 0
    });
  }
  pages.sort((a, b) => {
    const ta = String(a.title || a.slug).localeCompare(String(b.title || b.slug), 'zh');
    return ta;
  });
  return pages;
}

/**
 * @param {{ readText: Function, mkdir: Function, writeText: Function }} storage
 * @param {string} slug
 */
async function readWikiPage(storage, slug) {
  const safeSlug = slugify(String(slug || '').replace(/\.md$/i, '').replace(/^.*[\\/]/, ''));
  if (!/^[a-z0-9][a-z0-9-]*$/i.test(safeSlug)) {
    const e = new Error('slug 无效');
    e.code = 'INVALID_SLUG';
    throw e;
  }
  const rel = `${WIKI_ROOT}/${safeSlug}.md`;
  await ensureWikiDir(storage);
  const markdown = await storage.readText(rel, 512000);
  const { meta, body } = parseFrontmatter(markdown);
  return {
    ok: true,
    slug: safeSlug,
    path: rel,
    title: titleFromMarkdown(markdown, safeSlug),
    tags: meta.tags || '',
    updated: meta.updated || '',
    markdown,
    body
  };
}

/**
 * @param {{ writeText: Function, mkdir: Function, readText: Function, listDir: Function }} storage
 * @param {{ slug?: string, title?: string, markdown?: string, body?: string, tags?: string|string[] }} payload
 */
async function writeWikiPage(storage, payload = {}) {
  await ensureWikiDir(storage);
  const title = String(payload.title || '').trim();
  let slug = slugify(String(payload.slug || '').replace(/\.md$/i, ''));
  if (!payload.slug) {
    slug = slugify(title || slug);
  }
  if (!/^[a-z0-9][a-z0-9-]*$/i.test(slug)) {
    const e = new Error('slug 仅允许 a-z 0-9 与连字符');
    e.code = 'INVALID_SLUG';
    throw e;
  }
  let markdown = payload.markdown != null ? String(payload.markdown) : '';
  if (!markdown) {
    markdown = buildPageMarkdown({
      title: title || slug,
      body: payload.body != null ? String(payload.body) : `# ${title || slug}\n\n`,
      tags: payload.tags,
      slug
    });
  }
  const rel = `${WIKI_ROOT}/${slug}.md`;
  await storage.writeText(rel, markdown);
  return {
    ok: true,
    slug,
    path: rel,
    title: titleFromMarkdown(markdown, slug)
  };
}

/**
 * 关键词粗召回（无向量）。
 * @param {Array<object>} pages
 * @param {string} query
 * @param {number} limit
 */
function recallWikiPages(pages, query, limit = 8) {
  const q = String(query || '')
    .toLowerCase()
    .trim();
  const max = Math.min(Math.max(Number(limit) || 8, 1), 12);
  if (!pages || !pages.length) return [];
  if (!q) {
    return [];
  }
  const tokens = q
    .split(/[\s,，、/|]+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2);
  const scored = [];
  for (const p of pages) {
    const hay = `${p.title || ''} ${p.slug || ''} ${p.tags || ''} ${p.summary || ''}`.toLowerCase();
    let score = 0;
    if (hay.includes(q)) score += 5;
    for (const t of tokens) {
      if (hay.includes(t)) score += 2;
    }
    if (score > 0) scored.push({ ...p, score });
  }
  if (!scored.length) {
    // 无命中不硬塞：避免无关对话被项目 Wiki 污染
    return [];
  }
  scored.sort((a, b) => b.score - a.score || String(a.title).localeCompare(String(b.title), 'zh'));
  return scored.slice(0, max);
}

module.exports = {
  WIKI_ROOT,
  README_REL,
  README_TEXT,
  slugify,
  parseFrontmatter,
  titleFromMarkdown,
  summaryFromMarkdown,
  buildPageMarkdown,
  ensureWikiDir,
  listWikiPages,
  readWikiPage,
  writeWikiPage,
  recallWikiPages
};

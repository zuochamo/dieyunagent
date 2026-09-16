'use strict';

const PLAYBOOK_ROOT = '.dieyun/playbooks';
const DRAFTS_REL = `${PLAYBOOK_ROOT}/_drafts`;
const DOMAINS_REL = `${PLAYBOOK_ROOT}/by-domain`;
const INDEX_REL = `${PLAYBOOK_ROOT}/_index.json`;
const README_REL = `${PLAYBOOK_ROOT}/README.md`;

const README_TEXT = `# Playbook 工作流库

可复用的已确认任务步骤（SOP）。Agent 会通过语义召回注入相关摘要。

- 草稿：\`_drafts/*.draft.md\`
- 正式：\`by-domain/<领域>/*-workflow.md\`
- 索引：\`_index.json\`
`;

function pad2(n) {
  return String(n).padStart(2, '0');
}

function formatTimestamp(d = new Date()) {
  return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;
}

function slugify(text) {
  const raw = String(text || '')
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9\u4e00-\u9fff-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  if (raw && /[a-z0-9]/.test(raw)) return raw.slice(0, 48);
  const pinyinFallback = String(text || '')
    .trim()
    .slice(0, 24)
    .replace(/\s+/g, '-');
  return pinyinFallback || 'playbook';
}

function normalizeDomain(domain) {
  const d = slugify(domain || 'general');
  return d || 'general';
}

function buildPlaybookId(ts, slug) {
  return `pb-${ts}-${slug}`.slice(0, 80);
}

function buildPlaybookMarkdown(payload) {
  const title = String(payload.title || '未命名 Playbook').trim();
  const domain = normalizeDomain(payload.domain);
  const tags = Array.isArray(payload.tags)
    ? payload.tags.map((t) => String(t).trim()).filter(Boolean)
    : [];
  const ts = payload.timestamp || formatTimestamp();
  const slug = slugify(payload.slug || title);
  const id = buildPlaybookId(ts, slug);
  const goal = String(payload.goal || payload.objective || '').trim();
  const steps = String(payload.steps || '').trim();
  const commands = String(payload.commands || '').trim();
  const acceptance = String(payload.acceptance || '').trim();
  const pitfalls = String(payload.pitfalls || '').trim();
  const related = String(payload.relatedFiles || '').trim();
  const trigger = String(payload.trigger || 'manual').trim();

  const frontmatter = [
    '---',
    `id: ${id}`,
    `title: ${title}`,
    `domain: ${domain}`,
    `tags: [${tags.map((t) => `"${t.replace(/"/g, '\\"')}"`).join(', ')}]`,
    `trigger: ${trigger}`,
    `status: draft`,
    `created_at: ${new Date().toISOString()}`,
    '---',
    ''
  ].join('\n');

  const sections = [`# ${title}`, ''];
  if (goal) sections.push('## 目标', goal, '');
  if (steps) sections.push('## 确认步骤（SOP）', steps, '');
  if (commands) sections.push('## 关键命令', '```bash', commands, '```', '');
  if (acceptance) sections.push('## 验收标准', acceptance, '');
  if (pitfalls) sections.push('## 踩坑', pitfalls, '');
  if (related) sections.push('## 关联文件', related, '');

  return {
    id,
    slug,
    domain,
    ts,
    filename: `${ts}-${slug}-workflow.md`,
    draftFilename: `${ts}-${slug}.draft.md`,
    markdown: frontmatter + sections.join('\n').trim() + '\n'
  };
}

function extractSummaryFromMarkdown(markdown, maxLen = 800) {
  const body = String(markdown || '').replace(/^---[\s\S]*?---\s*/m, '');
  const parts = [];
  for (const sec of ['## 目标', '## 确认步骤（SOP）', '## 验收标准']) {
    const re = new RegExp(`${sec.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\n([\\s\\S]*?)(?=\\n## |$)`);
    const m = body.match(re);
    if (m && m[1]) parts.push(m[1].trim());
  }
  const joined = parts.join('\n').replace(/\s+/g, ' ').trim();
  if (!joined) return body.replace(/\s+/g, ' ').trim().slice(0, maxLen);
  return joined.length > maxLen ? `${joined.slice(0, maxLen).trim()}…` : joined;
}

function parseFrontmatterId(markdown) {
  const m = String(markdown || '').match(/^---[\s\S]*?\nid:\s*(.+)\s*\n/m);
  return m ? String(m[1]).trim() : '';
}

function parseFrontmatterTitle(markdown) {
  const m = String(markdown || '').match(/^---[\s\S]*?\ntitle:\s*(.+)\s*\n/m);
  return m ? String(m[1]).trim() : '';
}

function parseFrontmatterDomain(markdown) {
  const m = String(markdown || '').match(/^---[\s\S]*?\ndomain:\s*(.+)\s*\n/m);
  return m ? normalizeDomain(m[1]) : 'general';
}

async function ensurePlaybookDirs(storage) {
  await storage.mkdir(DRAFTS_REL);
  await storage.mkdir(DOMAINS_REL);
  try {
    const existing = await storage.readText(README_REL, 4096);
    if (!existing || !existing.trim()) {
      await storage.writeText(README_REL, README_TEXT);
    }
  } catch {
    await storage.writeText(README_REL, README_TEXT);
  }
}

async function readIndex(storage) {
  try {
    const raw = await storage.readText(INDEX_REL, 256000);
    const json = JSON.parse(raw || '{}');
    if (json && Array.isArray(json.entries)) return json;
  } catch {
    // ignore
  }
  return { version: 1, entries: [] };
}

async function writeIndex(storage, index) {
  const next = {
    version: 1,
    updatedAt: Date.now(),
    entries: Array.isArray(index.entries) ? index.entries : []
  };
  await storage.writeText(INDEX_REL, JSON.stringify(next, null, 2));
}

async function createDraft(storage, payload) {
  await ensurePlaybookDirs(storage);
  const built = buildPlaybookMarkdown({ ...payload, trigger: payload.trigger || 'manual' });
  const relPath = `${DRAFTS_REL}/${built.draftFilename}`;
  await storage.writeText(relPath, built.markdown);
  return {
    ok: true,
    draftPath: relPath,
    id: built.id,
    title: String(payload.title || '').trim() || built.id,
    domain: built.domain,
    filename: built.draftFilename,
    preview: extractSummaryFromMarkdown(built.markdown, 600)
  };
}

async function listDrafts(storage) {
  await ensurePlaybookDirs(storage);
  try {
    const rows = await storage.listDir(DRAFTS_REL);
    return (rows || [])
      .filter((r) => r.name && r.name.endsWith('.draft.md'))
      .map((r) => ({
        name: r.name,
        path: `${DRAFTS_REL}/${r.name}`,
        isDirectory: false
      }));
  } catch {
    return [];
  }
}

async function confirmDraft(storage, payload, indexPlaybookFn) {
  const draftPath = String(payload.draftPath || '').trim();
  if (!draftPath || !draftPath.includes('_drafts/')) {
    throw new Error('draftPath 无效');
  }
  const markdown = await storage.readText(draftPath, 512000);
  if (!markdown || !markdown.trim()) throw new Error('草稿为空或不存在');

  const domain = normalizeDomain(payload.domain || parseFrontmatterDomain(markdown));
  const id = parseFrontmatterId(markdown) || buildPlaybookId(formatTimestamp(), slugify(parseFrontmatterTitle(markdown)));
  const title = parseFrontmatterTitle(markdown) || id;
  const summary = extractSummaryFromMarkdown(markdown, 800);

  const baseName = draftPath.split('/').pop().replace(/\.draft\.md$/i, '');
  const finalName = `${baseName}-workflow.md`;
  const finalRel = `${DOMAINS_REL}/${domain}/${finalName}`;

  await storage.mkdir(`${DOMAINS_REL}/${domain}`);
  const confirmed = markdown.replace(/status:\s*draft/i, 'status: active').replace(
    /(\ncreated_at:[^\n]+\n)/,
    `$1confirmed_at: ${new Date().toISOString()}\n`
  );
  await storage.writeText(finalRel, confirmed);
  try {
    await storage.deleteFile(draftPath);
  } catch {
    // ignore
  }

  const index = await readIndex(storage);
  const entries = (index.entries || []).filter((e) => e.id !== id);
  entries.unshift({
    id,
    title,
    domain,
    path: finalRel,
    summary,
    status: 'active',
    confirmedAt: Date.now()
  });
  await writeIndex(storage, { entries });

  if (typeof indexPlaybookFn === 'function') {
    await indexPlaybookFn({
      id,
      title,
      domain,
      path: finalRel,
      summary,
      markdown: confirmed
    });
  }

  return { ok: true, id, path: finalRel, title, domain, summary };
}

async function discardDraft(storage, payload) {
  const draftPath = String(payload.draftPath || '').trim();
  if (!draftPath) throw new Error('draftPath 必填');
  await storage.deleteFile(draftPath);
  return { ok: true };
}

module.exports = {
  PLAYBOOK_ROOT,
  DRAFTS_REL,
  DOMAINS_REL,
  INDEX_REL,
  formatTimestamp,
  slugify,
  normalizeDomain,
  buildPlaybookMarkdown,
  extractSummaryFromMarkdown,
  ensurePlaybookDirs,
  readIndex,
  writeIndex,
  createDraft,
  listDrafts,
  confirmDraft,
  discardDraft
};

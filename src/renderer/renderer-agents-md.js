/* global gatewayCall, gwState, settings, fetchChatCompletion, getTextModelId, getCustomModelApiConfig, resolveComposerModelForSend, compactPlainText, getSessionChangeRowsForAgent, showAgentToast, CTX_LIMITS, $, escapeHtml, withSessionRpcScope */
'use strict';

const agentsApi = window.diecloud || {};

const AGENTS_MD_REL = '.dieyun/AGENTS.md';
const AGENTS_META_REL = '.dieyun/agents-meta.json';
const AGENTS_DRAFT_REL = '.dieyun/agents-draft.md';
const AGENTS_PENDING_REL = '.dieyun/agents-pending.json';
const AGENTS_MD_MODE_KEY = 'dieyun.agentsMd.mode';
const AGENTS_MD_PREVIEW_KEY = 'dieyun.agentsMd.preview';

const AGENTS_MD_SECTIONS = [
  'overview',
  'environment',
  'structure',
  'commands',
  'conventions',
  'testing',
  'architecture',
  'gotchas'
];

let lastAgentsMdEnsurePath = '';
const AGENTS_MD_MAX_CHARS = 24000;
const CHANGELOG_INJECT_ROWS = 5;
const CHANGELOG_ROW_RE = /^\|\s*\d{4}-\d{2}-\d{2}/;
/** @type {object | null} */
let pendingAgentsMdProposal = null;

function getAgentsMdMode() {
  try {
    const v = window.localStorage.getItem(AGENTS_MD_MODE_KEY);
    if (v === 'off' || v === 'draft-only') return v;
  } catch {
    // ignore
  }
  return 'auto';
}

function setAgentsMdMode(mode) {
  try {
    window.localStorage.setItem(
      AGENTS_MD_MODE_KEY,
      mode === 'off' || mode === 'draft-only' ? mode : 'auto'
    );
  } catch {
    // ignore
  }
  persistAgentsMdPrefsToMain();
}

function persistAgentsMdPrefsToMain() {
  if (!agentsApi.setAgentsMdPrefs) return;
  try {
    void agentsApi.setAgentsMdPrefs({
      mode: getAgentsMdMode(),
      preview: getAgentsMdPreviewEnabled()
    });
  } catch {
    // ignore
  }
}

function getAgentsMdPreviewEnabled() {
  try {
    const v = window.localStorage.getItem(AGENTS_MD_PREVIEW_KEY);
    if (v === '0' || v === 'false') return false;
  } catch {
    // ignore
  }
  return true;
}

function setAgentsMdPreviewEnabled(enabled) {
  try {
    window.localStorage.setItem(AGENTS_MD_PREVIEW_KEY, enabled ? '1' : '0');
  } catch {
    // ignore
  }
  persistAgentsMdPrefsToMain();
}

async function readWorkspaceTextFile(relPath, maxBytes, workspacePath) {
  if (!gwState.authed) return null;
  try {
    const params = {
      filePath: relPath,
      maxBytes: maxBytes || 96000
    };
    // 只绑 runWorkspaceRoot，勿注入 currentSessionId（并行后台会串）
    if (workspacePath) params.runWorkspaceRoot = String(workspacePath);
    const r = await gatewayCall('fs.read_file', params);
    if (!r || r.encoding === 'base64') return null;
    return String(r.data || '');
  } catch {
    return null;
  }
}

async function writeWorkspaceTextFile(relPath, data, workspacePath) {
  if (!gwState.authed) return { ok: false };
  try {
    const params = {
      filePath: relPath,
      data: String(data || ''),
      encoding: 'utf8'
    };
    if (workspacePath) params.runWorkspaceRoot = String(workspacePath);
    return await gatewayCall('fs.write_file', params);
  } catch (err) {
    console.warn('agents-md write failed', err);
    return { ok: false, error: err.message || String(err) };
  }
}

async function loadAgentsMeta(workspacePath) {
  const raw = await readWorkspaceTextFile(AGENTS_META_REL, 32000, workspacePath);
  if (!raw) return { version: 1, coldStartDone: false, contentHash: '', lastMaintenanceAt: 0 };
  try {
    return { version: 1, coldStartDone: false, contentHash: '', lastMaintenanceAt: 0, ...JSON.parse(raw) };
  } catch {
    return { version: 1, coldStartDone: false, contentHash: '', lastMaintenanceAt: 0 };
  }
}

async function saveAgentsMeta(meta, workspacePath) {
  await writeWorkspaceTextFile(AGENTS_META_REL, JSON.stringify(meta, null, 2), workspacePath);
}

async function persistPendingAgentsMdProposal(workspacePath) {
  const ws =
    workspacePath ||
    (pendingAgentsMdProposal && pendingAgentsMdProposal.workspacePath) ||
    undefined;
  if (!pendingAgentsMdProposal) {
    await writeWorkspaceTextFile(AGENTS_PENDING_REL, '', ws);
    return;
  }
  await writeWorkspaceTextFile(
    AGENTS_PENDING_REL,
    JSON.stringify(pendingAgentsMdProposal, null, 2),
    ws || pendingAgentsMdProposal.workspacePath
  );
}

async function loadPendingAgentsMdProposalFromDisk(workspacePath) {
  const raw = await readWorkspaceTextFile(AGENTS_PENDING_REL, 96000, workspacePath);
  if (!raw || !raw.trim()) {
    pendingAgentsMdProposal = null;
    syncAgentsMdPendingUi();
    return null;
  }
  try {
    pendingAgentsMdProposal = JSON.parse(raw);
    syncAgentsMdPendingUi();
    return pendingAgentsMdProposal;
  } catch {
    pendingAgentsMdProposal = null;
    syncAgentsMdPendingUi();
    return null;
  }
}

async function getAgentsTemplate() {
  if (agentsApi.getAgentsMdTemplate) {
    return agentsApi.getAgentsMdTemplate();
  }
  return '';
}

async function ensureAgentsMd(workspacePath) {
  if (!gwState.authed || !workspacePath || getAgentsMdMode() === 'off') return { ensured: false };
  const key = String(workspacePath);
  if (lastAgentsMdEnsurePath === key) {
    return { ensured: true, existed: true };
  }
  lastAgentsMdEnsurePath = key;
  const existing = await readWorkspaceTextFile(AGENTS_MD_REL, 4096, workspacePath);
  if (existing && existing.trim()) {
    return { ensured: true, existed: true };
  }
  const template = await getAgentsTemplate();
  if (!template) return { ensured: false };
  const wr = await writeWorkspaceTextFile(AGENTS_MD_REL, template, workspacePath);
  if (wr && wr.ok !== false) {
    return { ensured: true, created: true };
  }
  return { ensured: false };
}

async function loadAgentsMdRecord(workspacePath) {
  const content = await readWorkspaceTextFile(AGENTS_MD_REL, 96000, workspacePath || undefined);
  const exists = !!(content && content.trim());
  return { content: content || '', exists, relativePath: AGENTS_MD_REL };
}

async function buildAgentsMdContext(userQuery, workspacePath) {
  if (!workspacePath || getAgentsMdMode() === 'off') return '';
  await ensureAgentsMd(workspacePath);
  await loadPendingAgentsMdProposalFromDisk(workspacePath);
  const rec = await loadAgentsMdRecord(workspacePath);
  if (!rec.exists) {
    return '';
  }
  const sections = parseSectionsLite(rec.content);
  let content = rec.content;
  if (sections.length) {
    // 固定轻量结构段，禁用「查询词 → 章节」关键词映射
    const picked = pickSectionsForInject(sections);
    if (picked.length && picked.length < sections.length) {
      const trimmed = picked.map((sec) =>
        sec.id === 'changelog' ? { ...sec, body: trimChangelogSectionForContext(sec.body) } : sec
      );
      content = rebuildSectionsDocument(rec.content, trimmed);
    } else if (!picked.length) {
      content = rebuildSectionsDocument(rec.content, []);
    }
  }
  const maxOverride = Math.min((CTX_LIMITS && CTX_LIMITS.AGENTS_MD_MAX) || 8000, 2800);
  return formatAgentsMdBlock(content, workspacePath, maxOverride);
}

async function formatAgentsMdBlock(content, workspacePath, maxOverride) {
  if (agentsApi.formatAgentsMdBlock) {
    return agentsApi.formatAgentsMdBlock({ content, relativePath: AGENTS_MD_REL, workspacePath });
  }
  const body = String(content || '').trim();
  if (!body) return '';
  const max =
    maxOverride != null
      ? Number(maxOverride)
      : (CTX_LIMITS && CTX_LIMITS.AGENTS_MD_MAX) || 8000;
  const capped = body.length > max ? `${body.slice(0, max)}\n…（已截断）` : body;
  return (
    `【项目地图 · AGENTS.md】\n` +
    (workspacePath ? `工作空间：${workspacePath}\n` : '') +
    `文件：${AGENTS_MD_REL}\n` +
    `与 ~/.dieyun/dieyun.md 全局准则并存；与用户最新输入冲突时以用户为准。更多章节用 fs_read_file 按需读取。\n\n` +
    capped
  );
}

function parseSectionsLite(content) {
  const re = /<!--\s*dieyun:section:(\w+)\s+status=(\w+)\s*-->/g;
  const markers = [];
  let m;
  while ((m = re.exec(String(content || ''))) !== null) {
    markers.push({ id: m[1], status: m[2], index: m.index, end: m.index + m[0].length });
  }
  const out = [];
  for (let i = 0; i < markers.length; i++) {
    const cur = markers[i];
    const next = markers[i + 1];
    out.push({
      id: cur.id,
      status: cur.status,
      marker: String(content).slice(cur.index, cur.end),
      body: String(content)
        .slice(cur.end, next ? next.index : content.length)
        .trim()
    });
  }
  return out;
}

function pickSectionsForInject(sections) {
  const lightIds = new Set(['overview']);
  return (sections || []).filter((s) => lightIds.has(s.id));
}

function rebuildSectionsDocument(full, pickedSections) {
  const first = full.indexOf('<!-- dieyun:section:');
  const header = first > 0 ? full.slice(0, first) : '';
  let out = header;
  for (const sec of pickedSections) {
    out += `${sec.marker}\n${sec.body}\n\n`;
  }
  return out.trim();
}

function trimChangelogSectionForContext(body) {
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
  if (rows.length <= CHANGELOG_INJECT_ROWS) return String(body || '').trim();
  const dropped = rows.length - CHANGELOG_INJECT_ROWS;
  const kept = rows.slice(-CHANGELOG_INJECT_ROWS);
  const omitRow = `| … | … | （更早 ${dropped} 条已省略，完整记录见 .dieyun/AGENTS.md） |`;
  const table = [omitRow, ...kept].join('\n');
  return preamble.length ? `${preamble.join('\n')}\n${table}`.trim() : table;
}

function maybeWarnAgentsMdSize(meta) {
  if (!meta) return;
  const len = Number(meta.contentLength) || 0;
  if (meta.truncated) {
    showAgentToast(
      '项目地图已截断',
      '内容超过 24k 字符上限，部分正文可能已丢失。建议将稳定说明移到 docs/ 并精简 maintenance 记录。',
      { variant: 'warn' }
    );
  } else if (meta.nearLimit) {
    showAgentToast(
      '项目地图接近上限',
      `当前约 ${len.toLocaleString()} 字符（上限 ${AGENTS_MD_MAX_CHARS.toLocaleString()}）。维护记录会自动轮转，可考虑手动归档旧条目。`,
      { variant: 'warn' }
    );
  }
}

function agentsMdSizeMetaFromMerged(merged) {
  return {
    nearLimit: !!merged?.nearLimit,
    truncated: !!merged?.truncated,
    contentLength: merged?.contentLength || String(merged?.content || '').length
  };
}

async function applyAgentsMdUpdates(content, updates, source) {
  if (agentsApi.applyAgentsMdUpdates) {
    return agentsApi.applyAgentsMdUpdates({ content, updates, source });
  }
  return { content, applied: [], skipped: updates || [] };
}

async function parseMaintainerResponse(text) {
  if (agentsApi.parseAgentsMdMaintainer) {
    return agentsApi.parseAgentsMdMaintainer({ text });
  }
  return { updates: [] };
}

function normalizeAgentsMdUpdates(updates) {
  return (updates || [])
    .map((u) => ({
      section: String(u.section || '').trim(),
      action: String(u.action || 'append').trim() || 'append',
      content: String(u.content || '').trim(),
      confidence: Number(u.confidence)
    }))
    .filter((u) => u.section && u.content && AGENTS_MD_SECTIONS.includes(u.section));
}

async function getCurrentWorkspacePath() {
  if (!agentsApi.getWorkspace) return '';
  try {
    const ws = await agentsApi.getWorkspace();
    return ws && ws.workspacePath ? String(ws.workspacePath) : '';
  } catch {
    return '';
  }
}

async function assertAgentsMdWorkspaceMatch(expectedPath) {
  if (!expectedPath) return;
  const current = await getCurrentWorkspacePath();
  if (current && String(expectedPath) !== current) {
    const err = new Error(
      `工作空间已切换，无法写入原项目的 AGENTS.md。\n当前：${current}\n待采纳：${expectedPath}`
    );
    err.code = 'AGENTS_MD_WORKSPACE_MISMATCH';
    throw err;
  }
}

async function commitAgentsMdContent(content, workspacePath) {
  await assertAgentsMdWorkspaceMatch(workspacePath);
  const wr = await writeWorkspaceTextFile(AGENTS_MD_REL, content, workspacePath);
  if (!wr || wr.ok === false) {
    const err = new Error((wr && wr.error) || '写入 AGENTS.md 失败');
    err.code = 'AGENTS_MD_WRITE_FAILED';
    throw err;
  }
  const meta = await loadAgentsMeta(workspacePath);
  meta.updatedAt = Date.now();
  meta.lastMaintenanceAt = Date.now();
  if (agentsApi.applyAgentsMdUpdates) {
    meta.contentHash = content.slice(0, 16);
  }
  meta.coldStartDone = true;
  await saveAgentsMeta(meta, workspacePath);
  pendingAgentsMdProposal = null;
  await persistPendingAgentsMdProposal(workspacePath);
  syncAgentsMdPendingUi();
}

function syncAgentsMdPendingUi() {
  const btn = $('agents-md-review-pending');
  if (btn) btn.hidden = !pendingAgentsMdProposal;
}

function showAgentsMdPreviewOverlay(proposal) {
  const p = proposal || pendingAgentsMdProposal;
  if (!p) return;
  const overlay = $('agents-md-preview-overlay');
  const beforeEl = $('agents-md-diff-before');
  const afterEl = $('agents-md-diff-after');
  const metaEl = $('agents-md-preview-meta');
  if (!overlay || !beforeEl || !afterEl) return;
  if (typeof window.formatAgentsMdSideBySideDiffHtml === 'function') {
    const diff = window.formatAgentsMdSideBySideDiffHtml(p.before, p.after, { escapeHtml });
    beforeEl.innerHTML = diff.beforeHtml;
    afterEl.innerHTML = diff.afterHtml;
  } else {
    beforeEl.textContent = String(p.before || '').slice(0, 24000);
    afterEl.textContent = String(p.after || '').slice(0, 24000);
  }
  if (metaEl) {
    const src = p.source ? `来源：${p.source}` : '';
    const cnt = Array.isArray(p.updates) ? ` · ${p.updates.length} 条变更` : '';
    let extra = '';
    const warn = p.sizeMeta;
    if (warn?.truncated) extra = ' · ⚠ 将超过 24k 上限并截断';
    else if (warn?.nearLimit) extra = ` · ⚠ 接近 24k 上限（${Number(warn.contentLength || 0).toLocaleString()} 字符）`;
    metaEl.textContent = `${src}${cnt}${extra}`;
  }
  overlay.hidden = false;
}

function hideAgentsMdPreviewOverlay() {
  const overlay = $('agents-md-preview-overlay');
  if (overlay) overlay.hidden = true;
}

async function acceptPendingAgentsMdProposal() {
  if (!pendingAgentsMdProposal) return { ok: false };
  const { after, workspacePath, sizeMeta } = pendingAgentsMdProposal;
  try {
    await commitAgentsMdContent(after, workspacePath);
  } catch (err) {
    showAgentToast('项目地图未更新', err.message || String(err), { variant: 'warn' });
    return { ok: false, error: err.message || String(err) };
  }
  maybeWarnAgentsMdSize(sizeMeta);
  hideAgentsMdPreviewOverlay();
  showAgentToast('项目地图已更新', '已写入 .dieyun/AGENTS.md', { variant: 'info' });
  return { ok: true };
}

async function rejectPendingAgentsMdProposal() {
  pendingAgentsMdProposal = null;
  await persistPendingAgentsMdProposal();
  syncAgentsMdPendingUi();
  hideAgentsMdPreviewOverlay();
  return { ok: true };
}

async function queueAgentsMdProposal({ before, after, updates, source, workspacePath, sizeMeta }) {
  pendingAgentsMdProposal = {
    before,
    after,
    updates: updates || [],
    source: source || 'agent',
    workspacePath,
    sizeMeta: sizeMeta || null,
    at: Date.now()
  };
  await persistPendingAgentsMdProposal(workspacePath);
  syncAgentsMdPendingUi();
  showAgentsMdPreviewOverlay(pendingAgentsMdProposal);
}

async function writeAgentsMdDraft(payload) {
  await writeWorkspaceTextFile(
    AGENTS_DRAFT_REL,
    `# AGENTS.md 维护草稿\n\n\`\`\`json\n${JSON.stringify(payload, null, 2)}\n\`\`\`\n`,
    payload && payload.workspacePath
  );
}

/**
 * 统一入口：提议更新 AGENTS.md（工具 / 自动维护 / 冷启动）
 */
async function proposeAgentsMdUpdates(updates, source, workspacePath) {
  const mode = getAgentsMdMode();
  if (mode === 'off') {
    return { ok: false, error: '项目地图维护已关闭（设置 → 电脑权限）' };
  }
  if (!workspacePath) {
    return { ok: false, error: '未绑定工作空间' };
  }
  const normalized = normalizeAgentsMdUpdates(updates);
  if (!normalized.length) {
    return { ok: true, applied: 0, message: '无有效变更' };
  }

  await ensureAgentsMd(workspacePath);
  const rec = await loadAgentsMdRecord(workspacePath);
  const merged = await applyAgentsMdUpdates(rec.content, normalized, source || 'propose');
  const applied = merged.applied || [];
  if (!applied.length) {
    return { ok: true, applied: 0, message: '变更已存在或置信度过低，已跳过' };
  }
  const sizeMeta = agentsMdSizeMetaFromMerged(merged);

  if (mode === 'draft-only') {
    await writeAgentsMdDraft({
      before: rec.content,
      after: merged.content,
      updates: applied,
      source,
      at: new Date().toISOString()
    });
    showAgentToast('项目地图草稿', '已写入 .dieyun/agents-draft.md', { variant: 'info' });
    return {
      ok: true,
      draft: true,
      applied: applied.length,
      message: '已写入草稿 .dieyun/agents-draft.md，未修改 AGENTS.md'
    };
  }

  if (getAgentsMdPreviewEnabled()) {
    await queueAgentsMdProposal({
      before: rec.content,
      after: merged.content,
      updates: applied,
      source,
      workspacePath,
      sizeMeta
    });
    return {
      ok: true,
      pending: true,
      applied: applied.length,
      message: '已打开 Diff 预览，请采纳或放弃'
    };
  }

  try {
    await commitAgentsMdContent(merged.content, workspacePath);
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
  maybeWarnAgentsMdSize(sizeMeta);
  showAgentToast('项目地图已更新', `AGENTS.md +${applied.length} 条`, { variant: 'info' });
  return { ok: true, applied: applied.length, message: `已更新 AGENTS.md（${applied.length} 条）` };
}

async function executeAgentsMdPropose(args) {
  const section = String(args?.section || '').trim();
  const content = String(args?.content || '').trim();
  const action = String(args?.action || 'append').trim();
  const reason = String(args?.reason || '').trim();
  if (!section || !content) {
    return { error: 'section 与 content 必填' };
  }
  if (!AGENTS_MD_SECTIONS.includes(section)) {
    return { error: `section 无效，可用：${AGENTS_MD_SECTIONS.join(', ')}` };
  }
  let workspacePath = null;
  if (agentsApi.getWorkspace) {
    try {
      const ws = await agentsApi.getWorkspace();
      workspacePath = ws && ws.workspacePath ? ws.workspacePath : null;
    } catch {
      workspacePath = null;
    }
  }
  if (!workspacePath) {
    return { error: '请先选择工作空间' };
  }
  const line = reason ? `- ${content}（${reason}）` : content.startsWith('- ') ? content : `- ${content}`;
  const updates = [
    {
      section,
      action,
      content: line,
      confidence: 0.92
    }
  ];
  const result = await proposeAgentsMdUpdates(updates, 'agents_md_propose', workspacePath);
  if (result.error) return { error: result.error };
  return {
    ok: true,
    pending: !!result.pending,
    draft: !!result.draft,
    applied: result.applied || 0,
    message: result.message || '已处理'
  };
}

async function coldStartAgentsMd(workspacePath) {
  if (!gwState.authed || !workspacePath || getAgentsMdMode() === 'off') return;
  const meta = await loadAgentsMeta(workspacePath);
  if (meta.coldStartDone) return;
  await ensureAgentsMd(workspacePath);

  const hints = [];
  for (const name of ['package.json', 'README.md', 'pyproject.toml', 'Cargo.toml', 'go.mod']) {
    const text = await readWorkspaceTextFile(name, 12000, workspacePath);
    if (text) hints.push(`【${name}】\n${text.slice(0, 4000)}`);
  }
  try {
    const listing = await gatewayCall('fs.list_dir', {
      dirPath: '.',
      runWorkspaceRoot: workspacePath
    });
    const names = (listing || [])
      .filter((e) => e && e.name && !e.name.startsWith('.'))
      .slice(0, 24)
      .map((e) => (e.isDirectory ? `${e.name}/` : e.name));
    if (names.length) hints.push(`【根目录】\n${names.join('\n')}`);
  } catch {
    // ignore
  }
  if (!hints.length) return;

  const model = getTextModelId(settings);
  const apiConfig = getCustomModelApiConfig();
  if (!model || !apiConfig?.baseUrl) return;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 45000);
  try {
    const llmText = await fetchChatCompletion({
      model,
      apiConfig,
      temperature: 0.2,
      max_tokens: 1600,
      signal: controller.signal,
      messages: [
        {
          role: 'system',
          content:
            '初始化 .dieyun/AGENTS.md。只输出 JSON：{"updates":[{"section":"overview","action":"replace","content":"...","confidence":0.85}]}' +
            'section 可用 overview, structure, commands。不要编造 scripts。'
        },
        { role: 'user', content: hints.join('\n\n').slice(0, 14000) }
      ]
    });
    const parsed = await parseMaintainerResponse(llmText);
    const result = await proposeAgentsMdUpdates(parsed.updates || [], 'cold-start', workspacePath);
    if (result.ok && (result.applied || result.pending || result.draft)) {
      meta.coldStartDone = true;
      meta.updatedAt = Date.now();
      await saveAgentsMeta(meta, workspacePath);
    }
  } catch (err) {
    console.warn('agents-md cold start', err);
  } finally {
    clearTimeout(timeout);
  }
}

function touchAgentsMdForWorkspace(workspacePath) {
  if (!workspacePath) return;
  ensureAgentsMd(workspacePath)
    .then(() => loadPendingAgentsMdProposalFromDisk())
    .then(() => coldStartAgentsMd(workspacePath))
    .catch((err) => console.warn('agents-md touch', err));
}

function setAgentsMdSettingsHint(text) {
  const el = $('agents-md-settings-hint');
  if (!el) return;
  el.textContent = text || '';
  if (text) {
    el.classList.add('show');
    setTimeout(() => el.classList.remove('show'), 2200);
  }
}

function syncAgentsMdModeTabs(mode) {
  document.querySelectorAll('#agents-md-mode-tabs .agents-md-mode-tab').forEach((btn) => {
    const active = btn.dataset.mode === mode;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-checked', active ? 'true' : 'false');
  });
}

function initAgentsMdSettingsUI() {
  persistAgentsMdPrefsToMain();
  const modeTabs = document.querySelectorAll('#agents-md-mode-tabs .agents-md-mode-tab');
  const previewEl = $('agents-md-preview');
  const reviewBtn = $('agents-md-review-pending');
  const acceptBtn = $('agents-md-preview-accept');
  const rejectBtn = $('agents-md-preview-reject');

  if (modeTabs.length) {
    syncAgentsMdModeTabs(getAgentsMdMode());
    modeTabs.forEach((btn) => {
      btn.addEventListener('click', () => {
        const mode = btn.dataset.mode;
        if (!mode || mode === getAgentsMdMode()) return;
        setAgentsMdMode(mode);
        syncAgentsMdModeTabs(mode);
        setAgentsMdSettingsHint('项目地图设置已保存');
      });
    });
  }
  if (previewEl) {
    previewEl.checked = getAgentsMdPreviewEnabled();
    previewEl.addEventListener('change', () => {
      setAgentsMdPreviewEnabled(previewEl.checked);
      setAgentsMdSettingsHint('Diff 预览设置已保存');
    });
  }
  if (reviewBtn) {
    reviewBtn.addEventListener('click', () => {
      if (pendingAgentsMdProposal) showAgentsMdPreviewOverlay();
      else loadPendingAgentsMdProposalFromDisk().then((p) => p && showAgentsMdPreviewOverlay(p));
    });
  }
  if (acceptBtn) {
    acceptBtn.addEventListener('click', () => {
      acceptPendingAgentsMdProposal().catch((err) => console.warn(err));
    });
  }
  if (rejectBtn) {
    rejectBtn.addEventListener('click', () => {
      rejectPendingAgentsMdProposal().catch((err) => console.warn(err));
    });
  }

  loadPendingAgentsMdProposalFromDisk().catch(() => {});
}
